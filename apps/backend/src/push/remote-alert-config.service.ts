import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma, RemoteAlertConfig } from '@prisma/client';
import { networkInterfaces } from 'node:os';

import { AlertTier, defaultTier, SOURCE_KEY } from './alert-sources';
import { SecretBox } from './secret-box';
import { PrismaService } from '../prisma/prisma.service';

const SEALED_FIELDS = ['vapidPrivateKey', 'ntfyToken', 'matrixAccessToken', 'tsAuthKey'] as const;
const PLAIN_HTTP_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', 'signal-api', 'signal-proxy']);

export type RemoteAlertConfigUpdate = Partial<
  Omit<RemoteAlertConfig, 'id' | 'updatedAt' | 'vapidPublicKey' | 'vapidPrivateKey'>
>;

const SECRET_FIELDS = ['ntfyToken', 'matrixAccessToken', 'tsAuthKey'] as const;
const URL_FIELDS = ['ntfyUrl', 'signalApiUrl', 'matrixHomeserverUrl'] as const;

function env(name: string): string | null {
  return process.env[name]?.trim() || null;
}

function validateTiers(raw: unknown): Record<string, AlertTier> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BadRequestException('alertTiers must be an object');
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 500) {
    throw new BadRequestException('alertTiers has too many entries');
  }
  const out: Record<string, AlertTier> = {};
  for (const [key, value] of entries) {
    if (!SOURCE_KEY.test(key) || (value !== 'off' && value !== 'alert' && value !== 'critical')) {
      throw new BadRequestException(`Invalid alert tier ${key}`);
    }
    if (value !== defaultTier(key)) {
      out[key] = value;
    }
  }
  return out;
}

export function tierFor(config: RemoteAlertConfig, source: string): AlertTier {
  const tiers = (config.alertTiers ?? {}) as Record<string, AlertTier>;
  return tiers[source] ?? defaultTier(source);
}

function envUrl(name: string): string | null {
  const value = env(name);
  if (value && !isAllowedChannelUrl(value)) {
    new Logger('RemoteAlertConfigService').warn(
      `${name} ignored: must be https, or http to localhost or signal-api`,
    );
    return null;
  }
  return value;
}

function list(value: string | null): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function isAllowedChannelUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      return false;
    }
    return (
      url.protocol === 'https:' || (url.protocol === 'http:' && PLAIN_HTTP_HOSTS.has(url.hostname))
    );
  } catch {
    return false;
  }
}

@Injectable()
export class RemoteAlertConfigService {
  private readonly logger = new Logger(RemoteAlertConfigService.name);
  private readonly box = new SecretBox();
  private cached: RemoteAlertConfig | null = null;
  private readonly listeners = new Set<(config: RemoteAlertConfig) => void>();

  constructor(private readonly prisma: PrismaService) {}

  private seal<T extends Partial<RemoteAlertConfig>>(data: T): T {
    const out = { ...data };
    for (const field of SEALED_FIELDS) {
      const value = out[field];
      if (typeof value === 'string' && value && !this.box.isSealed(value)) {
        (out as Record<string, unknown>)[field] = this.box.seal(value);
      }
    }
    return out;
  }

  private open(row: RemoteAlertConfig): { config: RemoteAlertConfig; legacy: boolean } {
    const config = { ...row };
    let legacy = false;
    for (const field of SEALED_FIELDS) {
      const value = config[field];
      if (!value) {
        continue;
      }
      if (!this.box.isSealed(value)) {
        legacy = true;
        continue;
      }
      try {
        config[field] = this.box.open(value);
      } catch (error) {
        this.logger.error(
          `Cannot decrypt ${field} (wrong or missing key): ${error instanceof Error ? error.message : error}`,
        );
        config[field] = null;
      }
    }
    return { config, legacy };
  }

  signalProxyToken(): string {
    return env('SIGNAL_PROXY_TOKEN') ?? this.box.derive('signal-proxy');
  }

  onChange(listener: (config: RemoteAlertConfig) => void): void {
    this.listeners.add(listener);
  }

  private loading: Promise<RemoteAlertConfig> | null = null;

  async get(): Promise<RemoteAlertConfig> {
    if (this.cached) {
      return this.cached;
    }
    this.loading ??= this.load().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async load(): Promise<RemoteAlertConfig> {
    const existing = await this.prisma.remoteAlertConfig.findUnique({ where: { id: 1 } });
    const row =
      existing ??
      (await this.prisma.remoteAlertConfig.create({
        data: this.seal({
          id: 1,
          tailscaleEnabled: Boolean(env('TS_AUTHKEY')),
          tsAuthKey: env('TS_AUTHKEY'),
          tsHostname: env('TS_HOSTNAME'),
          tsAllowedLogins: list(env('TS_ALLOWED_LOGINS')).map((login) => login.toLowerCase()),
          vapidPublicKey: env('VAPID_PUBLIC_KEY'),
          vapidPrivateKey: env('VAPID_PRIVATE_KEY'),
          vapidSubject: env('VAPID_SUBJECT'),
          ntfyEnabled: Boolean(envUrl('NTFY_URL')),
          ntfyUrl: envUrl('NTFY_URL'),
          ntfyToken: env('NTFY_TOKEN'),
          signalEnabled: Boolean(env('SIGNAL_NUMBER')),
          signalApiUrl: envUrl('SIGNAL_API_URL'),
          signalNumber: env('SIGNAL_NUMBER'),
          signalRecipients: list(env('SIGNAL_RECIPIENTS')),
          matrixEnabled: Boolean(env('MATRIX_ACCESS_TOKEN')),
          matrixHomeserverUrl: envUrl('MATRIX_HOMESERVER_URL'),
          matrixAccessToken: env('MATRIX_ACCESS_TOKEN'),
          matrixRoomId: env('MATRIX_ROOM_ID'),
          matterEnabled: env('AHCC_MATTER_ENABLED') === 'true',
          matterLayout: env('AHCC_MATTER_LAYOUT') === 'flat' ? 'flat' : 'bridge',
          matterInterface: env('AHCC_MATTER_INTERFACE'),
        }),
      }));
    const { config, legacy } = this.open(row);
    this.cached = config;
    if (legacy) {
      const resealed = this.seal(
        Object.fromEntries(SEALED_FIELDS.map((field) => [field, row[field]])),
      );
      await this.prisma.remoteAlertConfig.update({ where: { id: 1 }, data: resealed });
      this.logger.log('Encrypted remote alert secrets that were stored in plain text');
    }
    return this.cached;
  }

  async update(input: RemoteAlertConfigUpdate): Promise<RemoteAlertConfig> {
    const data: RemoteAlertConfigUpdate = { ...input };
    for (const field of SECRET_FIELDS) {
      if (data[field] === '') {
        delete data[field];
      }
    }
    for (const field of URL_FIELDS) {
      const value = data[field];
      if (typeof value === 'string' && value.trim() && !isAllowedChannelUrl(value.trim())) {
        throw new BadRequestException(
          `${field} must be https, or http to localhost or signal-api, without a username or password`,
        );
      }
    }
    if (data.tsAllowedLogins) {
      data.tsAllowedLogins = data.tsAllowedLogins
        .map((login) => login.trim().toLowerCase())
        .filter(Boolean);
    }
    if (data.signalRecipients) {
      data.signalRecipients = data.signalRecipients.map((value) => value.trim()).filter(Boolean);
    }
    if (data.matterLayout && !['bridge', 'flat'].includes(data.matterLayout)) {
      throw new BadRequestException('matterLayout must be bridge or flat');
    }
    if (data.matterInterface !== undefined) {
      const name = data.matterInterface?.trim() || null;
      if (name && !networkInterfaces()[name]) {
        throw new BadRequestException(`Network interface ${name} not found on this host`);
      }
      data.matterInterface = name;
    }
    if (data.alertTiers !== undefined) {
      data.alertTiers = validateTiers(data.alertTiers);
    }
    await this.get();
    return this.save(data);
  }

  async clearSecret(
    field: 'ntfyToken' | 'matrixAccessToken' | 'tsAuthKey',
  ): Promise<RemoteAlertConfig> {
    await this.get();
    return this.save({ [field]: null });
  }

  async setVapidKeys(publicKey: string, privateKey: string): Promise<RemoteAlertConfig> {
    await this.get();
    return this.save({ vapidPublicKey: publicKey, vapidPrivateKey: privateKey } as never);
  }

  private async save(data: Partial<RemoteAlertConfig>): Promise<RemoteAlertConfig> {
    const row = await this.prisma.remoteAlertConfig.update({
      where: { id: 1 },
      data: this.seal(data) as Prisma.RemoteAlertConfigUncheckedUpdateInput,
    });
    this.cached = this.open(row).config;
    for (const listener of this.listeners) {
      listener(this.cached);
    }
    return this.cached;
  }
}
