import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { connect, IClientOptions, IClientPublishOptions, MqttClient } from 'mqtt';

import { PrismaService } from '../prisma/prisma.service';
import { UpdateMqttConfigDto } from './dto/update-mqtt-config.dto';

export interface SiteMqttContext {
  siteId: string;
  client: MqttClient;
  qosEvents: 0 | 1 | 2;
  qosCommands: 0 | 1 | 2;
}

type MqttStatusState = 'not_configured' | 'disabled' | 'connecting' | 'connected' | 'error';

interface SiteStatusEntry {
  state: MqttStatusState;
  message?: string;
  updatedAt: Date;
}

@Injectable()
export class MqttService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MqttService.name);
  private readonly clients = new Map<string, SiteMqttContext>();
  private readonly statuses = new Map<string, SiteStatusEntry>();
  private readonly connectionListeners: Array<(context: SiteMqttContext) => void> = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.configService.get<boolean>('mqtt.enabled', true)) {
      this.logger.log('MQTT integration is disabled by configuration');
      return;
    }

    const configs = await this.prisma.mqttConfig.findMany();

    configs.forEach((config) => {
      if (!config.enabled) {
        this.updateStatus(config.siteId, 'disabled', 'MQTT disabled');
      } else {
        this.updateStatus(config.siteId, 'connecting', 'Connecting to broker…');
      }
    });

    // Broker connections are established in the background: an unreachable
    // broker must not hold up application bootstrap (Nest only starts the HTTP
    // listener once every onModuleInit resolves). Listeners registered later
    // are replayed by onClientConnected, so nothing depends on this finishing.
    void Promise.all(
      configs
        .filter((config) => config.enabled)
        .map(async (config) => {
          try {
            const client = await this.createClient(config);
            this.registerClient({
              siteId: config.siteId,
              client,
              qosEvents: this.normalizeQos(config.qosEvents),
              qosCommands: this.normalizeQos(config.qosCommands),
            });
            this.logger.log(`Connected MQTT client for site ${config.siteId}`);
            this.updateStatus(config.siteId, 'connected', 'Connected');
          } catch (error) {
            this.logger.error(
              `Failed to connect MQTT for site ${config.siteId}: ${
                error instanceof Error ? error.message : error
              }`,
            );
            const message = error instanceof Error ? error.message : String(error);
            this.updateStatus(config.siteId, 'error', message);
          }
        }),
    );
  }

  onModuleDestroy(): void {
    this.clients.forEach((context, siteId) => {
      this.logger.log(`Disconnecting MQTT client for site ${siteId}`);
      context.client.end(true);
    });
    this.clients.clear();
  }

  async listSiteConfigs() {
    return this.prisma.mqttConfig.findMany({
      include: {
        site: { select: { id: true, name: true, color: true } },
      },
    });
  }

  async getSiteConfig(siteId: string) {
    return this.prisma.mqttConfig.findUnique({
      where: { siteId },
      include: {
        site: { select: { id: true, name: true, color: true } },
      },
    });
  }

  async updateSiteConfig(siteId: string, dto: UpdateMqttConfigDto) {
    const brokerUrl = dto.brokerUrl?.trim();
    const clientId = dto.clientId?.trim();
    const username = dto.username?.trim();

    const normalizedBrokerUrl = brokerUrl && brokerUrl.length > 0 ? brokerUrl : undefined;
    const normalizedClientId = clientId && clientId.length > 0 ? clientId : undefined;
    const normalizedUsername =
      username && username.length > 0 ? username : dto.username === null ? null : undefined;

    const config = await this.prisma.mqttConfig.upsert({
      where: { siteId },
      create: {
        siteId,
        brokerUrl: normalizedBrokerUrl ?? 'mqtt://localhost:1883',
        clientId: normalizedClientId ?? `command-center-${siteId}`,
        username: dto.username === null ? null : (normalizedUsername ?? null),
        password: dto.password ?? null,
        tlsEnabled: dto.tlsEnabled ?? false,
        caPem: dto.caPem ?? null,
        certPem: dto.certPem ?? null,
        keyPem: dto.keyPem ?? null,
        qosEvents: dto.qosEvents ?? 1,
        qosCommands: dto.qosCommands ?? 1,
        enabled: dto.enabled ?? false,
      },
      update: {
        brokerUrl: normalizedBrokerUrl ?? undefined,
        clientId: normalizedClientId ?? undefined,
        username: dto.username === null ? null : (normalizedUsername ?? undefined),
        password: dto.password ?? undefined,
        tlsEnabled: dto.tlsEnabled ?? undefined,
        caPem: dto.caPem ?? undefined,
        certPem: dto.certPem ?? undefined,
        keyPem: dto.keyPem ?? undefined,
        qosEvents: dto.qosEvents ?? undefined,
        qosCommands: dto.qosCommands ?? undefined,
        enabled: dto.enabled ?? undefined,
      },
      include: {
        site: { select: { id: true, name: true, color: true } },
      },
    });

    await this.restartClient(siteId);
    return config;
  }

  async listStatuses() {
    return Array.from(this.statuses.entries()).map(([siteId, entry]) => ({
      siteId,
      state: entry.state,
      message: entry.message,
      updatedAt: entry.updatedAt.toISOString(),
    }));
  }

  async getSiteStatus(siteId: string) {
    const entry = this.statuses.get(siteId);
    if (!entry) {
      return {
        siteId,
        state: 'not_configured' as const,
        message: 'No MQTT configuration saved.',
        updatedAt: new Date().toISOString(),
      };
    }
    return {
      siteId,
      state: entry.state,
      message: entry.message,
      updatedAt: entry.updatedAt.toISOString(),
    };
  }

  async reconnectSite(siteId: string) {
    await this.restartClient(siteId);
    return this.getSiteStatus(siteId);
  }

  async testSiteConnection(siteId: string) {
    const config = await this.prisma.mqttConfig.findUnique({ where: { siteId } });
    if (!config) {
      throw new NotFoundException(`No MQTT configuration found for site ${siteId}`);
    }

    try {
      const client = await this.createClient(config);
      client.end(true);
      const message = config.enabled
        ? 'Connection successful.'
        : 'Connection successful (configuration is currently disabled).';
      this.updateStatus(siteId, 'connected', message);
      return {
        ok: true,
        state: 'connected' as const,
        message,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.updateStatus(siteId, 'error', message);
      return {
        ok: false,
        state: 'error' as const,
        message,
      };
    }
  }

  private async restartClient(siteId: string): Promise<void> {
    const existing = this.clients.get(siteId);
    if (existing) {
      this.logger.log(`Restarting MQTT client for site ${siteId}`);
      existing.client.end(true);
      this.clients.delete(siteId);
    }

    const config = await this.prisma.mqttConfig.findUnique({ where: { siteId } });
    if (!config || !config.enabled) {
      this.updateStatus(
        siteId,
        config ? 'disabled' : 'not_configured',
        config ? 'MQTT disabled' : 'No MQTT configuration saved.',
      );
      return;
    }

    this.updateStatus(siteId, 'connecting', 'Connecting to broker…');

    try {
      const client = await this.createClient(config);
      this.registerClient({
        siteId,
        client,
        qosEvents: this.normalizeQos(config.qosEvents),
        qosCommands: this.normalizeQos(config.qosCommands),
      });
      this.logger.log(`Reconnected MQTT client for site ${siteId}`);
      this.updateStatus(siteId, 'connected', 'Connected');
    } catch (error) {
      this.logger.error(
        `Failed to reconnect MQTT client for site ${siteId}: ${
          error instanceof Error ? error.message : error
        }`,
      );
      const message = error instanceof Error ? error.message : String(error);
      this.updateStatus(siteId, 'error', message);
    }
  }

  onClientConnected(listener: (context: SiteMqttContext) => void): void {
    this.connectionListeners.push(listener);
    this.clients.forEach((context) => {
      try {
        listener(context);
      } catch (error) {
        this.logger.error(
          `MQTT connection listener error for site ${context.siteId}: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    });
  }

  getConnectedContexts(): SiteMqttContext[] {
    return Array.from(this.clients.values());
  }

  async publishToAll(
    topic: string,
    message: string | Buffer,
    options?: IClientPublishOptions,
    kind: 'events' | 'commands' = 'events',
  ): Promise<void> {
    const payload = typeof message === 'string' || Buffer.isBuffer(message) ? message : message;
    await Promise.all(
      Array.from(this.clients.values()).map(
        (context) =>
          new Promise<void>((resolve, reject) => {
            const publishOptions: IClientPublishOptions = {
              ...(options ?? {}),
            };
            if (publishOptions.qos === undefined) {
              publishOptions.qos = kind === 'commands' ? context.qosCommands : context.qosEvents;
            }
            context.client.publish(topic, payload, publishOptions, (err) => {
              if (err) {
                this.logger.warn(
                  `Failed to publish MQTT message for site ${context.siteId} on topic ${topic}: ${
                    err instanceof Error ? err.message : err
                  }`,
                );
                reject(err);
              } else {
                resolve();
              }
            });
          }),
      ),
    );
  }

  private registerClient(context: SiteMqttContext): void {
    this.clients.set(context.siteId, context);
    this.connectionListeners.forEach((listener) => {
      try {
        listener(context);
      } catch (error) {
        this.logger.error(
          `MQTT connection listener error for site ${context.siteId}: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    });
  }

  private async createClient(config: {
    brokerUrl: string;
    clientId: string;
    username: string | null;
    password: string | null;
    tlsEnabled: boolean;
    caPem: string | null;
    certPem: string | null;
    keyPem: string | null;
  }): Promise<MqttClient> {
    const connectTimeoutMs = Number(process.env.MQTT_CONNECT_TIMEOUT_MS ?? 10_000);

    const options: IClientOptions = {
      clientId: config.clientId,
      clean: true,
      reconnectPeriod: 5_000,
      connectTimeout: connectTimeoutMs,
    };

    if (config.username) {
      options.username = config.username;
    }
    if (config.password) {
      options.password = config.password;
    }

    if (config.tlsEnabled) {
      const insecure = process.env.MQTT_TLS_INSECURE === 'true';
      options.rejectUnauthorized = !insecure;
      if (insecure) {
        this.logger.warn(
          'MQTT_TLS_INSECURE=true: broker certificate verification disabled (insecure, MITM possible).',
        );
      }
      if (config.caPem) {
        options.ca = config.caPem;
      }
      if (config.certPem) {
        options.cert = config.certPem;
      }
      if (config.keyPem) {
        options.key = config.keyPem;
      }
    }

    return new Promise((resolve, reject) => {
      const client = connect(config.brokerUrl, options);
      let settled = false;
      const timer = setTimeout(() => finish(new Error('MQTT connect timeout')), connectTimeoutMs);

      const finish = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        client.removeListener('connect', handleConnect);
        client.removeListener('error', handleError);

        if (error) {
          client.end(true);
          reject(error);
        } else {
          resolve(client);
        }
      };

      const handleConnect = () => finish();
      const handleError = (error: Error) => finish(error);

      client.once('connect', handleConnect);
      client.once('error', handleError);
    });
  }

  private updateStatus(siteId: string, state: MqttStatusState, message?: string) {
    this.statuses.set(siteId, {
      state,
      message,
      updatedAt: new Date(),
    });
  }

  private normalizeQos(value?: number | null): 0 | 1 | 2 {
    return value === 0 || value === 1 || value === 2 ? value : 1;
  }
}
