import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { AlarmLevel, RemoteAlertConfig } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { toBuffer as qrToBuffer } from 'qrcode';

import { MatterService } from './matter.service';
import { PushService } from './push.service';
import {
  isAllowedChannelUrl,
  RemoteAlertConfigService,
  tierFor,
} from './remote-alert-config.service';
import { SignalConnectorService } from './signal-connector.service';

const NTFY_PRIORITY: Record<AlarmLevel, string> = {
  INFO: '2',
  NOTICE: '3',
  ALERT: '4',
  CRITICAL: '5',
};

export type AlertChannel = 'push' | 'ntfy' | 'signal' | 'matrix' | 'matter';

function httpsOrLoopback(raw: string | null): URL | null {
  return raw && isAllowedChannelUrl(raw) ? new URL(raw) : null;
}

@Injectable()
export class AlertChannelsService {
  private readonly logger = new Logger(AlertChannelsService.name);

  constructor(
    private readonly push: PushService,
    private readonly matter: MatterService,
    private readonly config: RemoteAlertConfigService,
    private readonly connector: SignalConnectorService,
  ) {}

  async alert(
    title: string,
    body: string,
    severity: AlarmLevel | null | undefined,
    source: string,
    bodyWithoutCoords: string = body,
  ): Promise<void> {
    const config = await this.config.get();
    const openBody = config.coordsUnencrypted ? body : bodyWithoutCoords;
    const tier = tierFor(config, source);
    if (tier === 'off') {
      return;
    }
    if (tier === 'critical') {
      title = `CRITICAL: ${title}`;
      severity = 'CRITICAL';
    } else if (severity === 'CRITICAL') {
      severity = 'ALERT';
    }
    this.matter.trigger(tier === 'critical' ? 'CRITICAL' : 'ALERT');
    await Promise.all([
      this.run('push', async () => {
        await this.push.notify(title, body);
      }),
      config.ntfyEnabled
        ? this.run('ntfy', () => this.sendNtfy(config, title, openBody, severity))
        : null,
      config.signalEnabled
        ? this.run('signal', () => this.sendSignal(config, `${title}\n${body}`))
        : null,
      config.matrixEnabled
        ? this.run('matrix', () => this.sendMatrix(config, `${title}\n${openBody}`))
        : null,
    ]);
  }

  async coordsUnencrypted(): Promise<boolean> {
    const config = await this.config.get();
    return config.coordsUnencrypted;
  }

  async isSourceMuted(source: string): Promise<boolean> {
    const config = await this.config.get();
    return tierFor(config, source) === 'off';
  }

  async test(channel: AlertChannel): Promise<void> {
    const config = await this.config.get();
    const title = 'AntiHunter test';
    const body = `Test notification from AntiHunter Command Center\nTime: ${new Date().toISOString()}`;
    switch (channel) {
      case 'push':
        await this.push.notify(title, body);
        return;
      case 'ntfy':
        return this.sendNtfy(config, title, body, 'NOTICE', true);
      case 'signal':
        return this.sendSignal(config, `${title}\n${body}`, true);
      case 'matrix':
        return this.sendMatrix(config, `${title}\n${body}`, true);
      case 'matter':
        this.matter.trigger('CRITICAL');
        return;
      default:
        throw new BadRequestException('Unknown channel');
    }
  }

  private async run(channel: string, action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`${channel} delivery failed: ${reason}`);
      if (channel !== 'push') {
        await this.push
          .notify(`${channel} alert delivery failed`, reason.slice(0, 300))
          .catch(() => undefined);
      }
    }
  }

  private missing(strict: boolean, what: string): void {
    if (strict) {
      throw new BadRequestException(`${what} is not configured`);
    }
  }

  private async sendNtfy(
    config: RemoteAlertConfig,
    title: string,
    body: string,
    severity?: AlarmLevel | null,
    strict = false,
  ) {
    const url = httpsOrLoopback(config.ntfyUrl);
    if (!url) {
      return this.missing(strict, 'ntfy topic URL');
    }
    const headers: Record<string, string> = {
      Title: title
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/[^\x20-\x7e\xa0-\xff]/g, '?')
        .slice(0, 200),
      Priority: NTFY_PRIORITY[severity ?? 'NOTICE'],
    };
    if (config.ntfyToken) {
      headers.Authorization = `Bearer ${config.ntfyToken}`;
    }
    await this.post(url, { method: 'POST', headers, body });
  }

  private signalBase(config: RemoteAlertConfig): URL {
    const url = httpsOrLoopback(config.signalApiUrl || 'http://127.0.0.1:8079');
    if (!url) {
      throw new BadRequestException('Signal connector URL is not allowed');
    }
    return url;
  }

  private signalAuth(): Record<string, string> {
    return { Authorization: `Bearer ${this.config.signalProxyToken()}` };
  }

  async signalStatus(): Promise<{
    reachable: boolean;
    linkedNumber: string | null;
    managed: boolean;
    supported: boolean;
  }> {
    const config = await this.config.get();
    if (this.connector.usesNativeCli(config)) {
      const linkedNumber = await this.connector.linkedNumber();
      if (linkedNumber && linkedNumber !== config.signalNumber) {
        await this.config.update({ signalNumber: linkedNumber });
      }
      return { reachable: true, linkedNumber, managed: true, supported: true };
    }
    const managed = false;
    const supported = this.connector.isSupported();
    try {
      const response = await fetch(new URL('/v1/accounts', this.signalBase(config)), {
        headers: this.signalAuth(),
        redirect: 'error',
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        return { reachable: false, linkedNumber: null, managed, supported };
      }
      const accounts = (await response.json()) as unknown;
      const first = Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0] : null;
      if (first && first !== config.signalNumber) {
        await this.config.update({ signalNumber: first });
      }
      return { reachable: true, linkedNumber: first, managed, supported };
    } catch {
      return { reachable: false, linkedNumber: null, managed, supported };
    }
  }

  async signalLinkQr(): Promise<Buffer> {
    const config = await this.config.get();
    if (this.connector.usesNativeCli(config)) {
      const uri = await this.connector.linkUri();
      return qrToBuffer(uri, { margin: 1, width: 256 });
    }
    const response = await fetch(
      new URL('/v1/qrcodelink?device_name=AntiHunter', this.signalBase(config)),
      { headers: this.signalAuth(), redirect: 'error', signal: AbortSignal.timeout(60_000) },
    );
    if (!response.ok || !response.headers.get('content-type')?.startsWith('image/png')) {
      throw new BadRequestException(
        `Signal connector did not return a QR code (${response.status})`,
      );
    }
    return Buffer.from(await response.arrayBuffer());
  }

  private signalGroupCreation: Promise<string> | null = null;

  private async ensureSignalGroup(config: RemoteAlertConfig): Promise<string> {
    const existing = this.connector.usesNativeCli(config)
      ? config.signalRecipients[0]
      : config.signalRecipients.find((value) => value.startsWith('group.'));
    if (existing) {
      return existing;
    }
    this.signalGroupCreation ??= (async () => {
      if (this.connector.usesNativeCli(config)) {
        const id = await this.connector.createGroup();
        await this.config.update({ signalRecipients: [id] });
        return id;
      }
      const response = await fetch(
        new URL(`/v1/groups/${encodeURIComponent(config.signalNumber!)}`, this.signalBase(config)),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...this.signalAuth() },
          body: JSON.stringify({
            name: 'AntiHunter Alerts',
            members: [config.signalNumber],
            permissions: {
              add_members: 'only-admins',
              edit_group: 'only-admins',
              send_messages: 'only-admins',
            },
            group_link: 'disabled',
          }),
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
        },
      );
      const body = (await response.json().catch(() => ({}))) as { id?: unknown };
      if (!response.ok || typeof body.id !== 'string') {
        throw new Error(`Could not create the AntiHunter Alerts group (${response.status})`);
      }
      await this.config.update({ signalRecipients: [body.id] });
      return body.id;
    })().finally(() => {
      this.signalGroupCreation = null;
    });
    return this.signalGroupCreation;
  }

  private async sendSignal(config: RemoteAlertConfig, message: string, strict = false) {
    if (!config.signalNumber) {
      return this.missing(strict, 'Signal (link a device first)');
    }
    const groupId = await this.ensureSignalGroup(config);
    if (this.connector.usesNativeCli(config)) {
      await this.connector.send(groupId, message);
      return;
    }
    await this.post(new URL('/v2/send', this.signalBase(config)), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.signalAuth() },
      body: JSON.stringify({ message, number: config.signalNumber, recipients: [groupId] }),
    });
  }

  private async sendMatrix(config: RemoteAlertConfig, message: string, strict = false) {
    const url = httpsOrLoopback(config.matrixHomeserverUrl);
    if (!url || !config.matrixAccessToken || !config.matrixRoomId) {
      return this.missing(strict, 'Matrix homeserver, access token and room');
    }
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(config.matrixRoomId)}/send/m.room.message/${randomUUID()}`;
    await this.post(new URL(path, url), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.matrixAccessToken}`,
      },
      body: JSON.stringify({ msgtype: 'm.text', body: message }),
    });
  }

  private async post(url: URL, init: RequestInit) {
    const response = await fetch(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  }
}
