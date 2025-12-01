import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSocket, type Socket } from 'node:dgram';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { clearInterval as clearIntervalSafe, setInterval as setIntervalSafe } from 'node:timers';

import type {
  AcarsdecMessage,
  AcarsdecResponse,
  AcarsConfig,
  AcarsMessage,
  AcarsStatus,
} from './acars.types';
import { AdsbService } from '../adsb/adsb.service';
import { CommandCenterGateway } from '../ws/command-center.gateway';

@Injectable()
export class AcarsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AcarsService.name);
  private enabled: boolean;
  private udpHost: string;
  private udpPort: number;
  private socket: Socket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastMessageAt: string | null = null;
  private lastError: string | null = null;
  private messages: Map<string, AcarsMessage> = new Map();
  private readonly localSiteId: string;
  private readonly dataDir: string;
  private readonly configPath: string;
  private messageExpiryMs: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly gateway: CommandCenterGateway,
    private readonly adsbService: AdsbService,
  ) {
    this.enabled = this.configService.get<boolean>('acars.enabled', false) ?? false;
    this.udpHost = this.configService.get<string>('acars.udpHost', '127.0.0.1') ?? '127.0.0.1';
    this.udpPort = this.configService.get<number>('acars.udpPort', 15550) ?? 15550;
    this.messageExpiryMs =
      this.configService.get<number>('acars.messageExpiryMs', 3600000) ?? 3600000;
    this.localSiteId = this.configService.get<string>('site.id', 'default');
    const baseDir = join(__dirname, '..', '..');
    this.dataDir = join(baseDir, 'data', 'acars');
    this.configPath = join(this.dataDir, 'config.json');
  }

  async onModuleInit(): Promise<void> {
    await this.loadConfigFromDisk();
    if (this.enabled) {
      this.startUdpListener();
    }
  }

  onModuleDestroy(): void {
    this.stopUdpListener();
  }

  getStatus(): AcarsStatus {
    return {
      enabled: this.enabled,
      udpHost: this.udpHost,
      udpPort: this.udpPort,
      lastMessageAt: this.lastMessageAt,
      lastError: this.lastError,
      messageCount: this.messages.size,
    };
  }

  getMessages(): AcarsMessage[] {
    return Array.from(this.messages.values());
  }

  updateConfig(config: { enabled?: boolean; udpHost?: string; udpPort?: number }): AcarsStatus {
    if (config.enabled !== undefined) {
      this.enabled = Boolean(config.enabled);
    }
    if (config.udpHost) {
      this.udpHost = config.udpHost.trim();
    }
    if (config.udpPort && Number.isFinite(config.udpPort)) {
      this.udpPort = Math.max(1024, Number(config.udpPort));
    }

    this.stopUdpListener();
    if (this.enabled) {
      this.startUdpListener();
    }
    void this.persistConfig();
    return this.getStatus();
  }

  private async loadConfigFromDisk(): Promise<void> {
    try {
      if (!existsSync(this.configPath)) {
        return;
      }
      const raw = await readFile(this.configPath, 'utf-8');
      const saved = JSON.parse(raw) as AcarsConfig;
      if (saved.enabled !== undefined) {
        this.enabled = Boolean(saved.enabled);
      }
      if (saved.udpHost) {
        this.udpHost = saved.udpHost;
      }
      if (saved.udpPort) {
        this.udpPort = saved.udpPort;
      }
      this.logger.log('Loaded ACARS config from disk');
    } catch (error) {
      this.logger.warn(
        `Failed to load ACARS config from disk: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private async persistConfig(): Promise<void> {
    try {
      await mkdir(this.dataDir, { recursive: true });
      const payload: AcarsConfig = {
        enabled: this.enabled,
        udpHost: this.udpHost,
        udpPort: this.udpPort,
      };
      await writeFile(this.configPath, JSON.stringify(payload, null, 2), 'utf-8');
      this.logger.log('Persisted ACARS config to disk');
    } catch (error) {
      this.logger.error(
        `Failed to persist ACARS config: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private startUdpListener(): void {
    if (this.socket) {
      return;
    }

    this.logger.log(`Starting ACARS UDP listener on ${this.udpHost}:${this.udpPort}`);

    try {
      this.socket = createSocket('udp4');

      this.socket.on('error', (error) => {
        this.lastError = error.message;
        this.logger.error(`ACARS UDP socket error: ${error.message}`);
      });

      this.socket.on('message', (msg) => {
        try {
          const data = JSON.parse(msg.toString()) as AcarsdecResponse | AcarsdecMessage;
          this.lastMessageAt = new Date().toISOString();
          this.lastError = null;

          let messages: AcarsdecMessage[] = [];
          if (Array.isArray(data)) {
            messages = data;
          } else if ('messages' in data && Array.isArray(data.messages)) {
            messages = data.messages;
          } else {
            // Single message
            messages = [data as AcarsdecMessage];
          }

          this.processMessages(messages);
          this.emitMessages();
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          this.lastError = errorMessage;
          this.logger.error(`Failed to parse ACARS message: ${errorMessage}`);
        }
      });

      this.socket.on('listening', () => {
        const address = this.socket?.address();
        this.logger.log(`ACARS UDP listener bound to ${address?.address}:${address?.port}`);
      });

      this.socket.bind(this.udpPort, this.udpHost);

      // Start cleanup timer for expired messages
      this.timer = setIntervalSafe(() => {
        this.cleanupExpiredMessages();
      }, 60000); // Run cleanup every minute
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.lastError = errorMessage;
      this.logger.error(`Failed to start ACARS UDP listener: ${errorMessage}`);
    }
  }

  private stopUdpListener(): void {
    if (this.timer) {
      clearIntervalSafe(this.timer);
      this.timer = null;
    }

    if (this.socket) {
      this.socket.close(() => {
        this.logger.log('ACARS UDP listener stopped');
      });
      this.socket = null;
    }
  }

  private processMessages(messages: AcarsdecMessage[]): void {
    const now = Date.now();
    const adsbTracks = this.adsbService.getTracks();

    if (adsbTracks.length > 0) {
      this.logger.debug(
        `Processing ${messages.length} ACARS messages with ${adsbTracks.length} ADSB tracks available`,
      );
    }

    for (const msg of messages) {
      if (!msg.tail || !msg.timestamp) {
        continue;
      }

      const id = this.generateMessageId(msg);
      const timestamp = new Date(msg.timestamp * 1000).toISOString();

      // Correlate with ADSB by matching tail number to registration
      let lat: number | null = null;
      let lon: number | null = null;
      let correlatedIcao: string | null = null;

      // Try to find matching ADSB track
      const normalizedTail = this.normalizeTailNumber(msg.tail);
      const normalizedFlight = msg.flight ? this.normalizeTailNumber(msg.flight) : null;

      for (const track of adsbTracks) {
        const normalizedReg = track.reg ? this.normalizeTailNumber(track.reg) : null;
        const normalizedCallsign = track.callsign ? this.normalizeTailNumber(track.callsign) : null;

        // Match by registration or callsign
        if (
          (normalizedReg && normalizedReg === normalizedTail) ||
          (normalizedCallsign && normalizedCallsign === normalizedTail) ||
          (normalizedFlight && normalizedReg && normalizedReg === normalizedFlight) ||
          (normalizedFlight && normalizedCallsign && normalizedCallsign === normalizedFlight)
        ) {
          lat = track.lat;
          lon = track.lon;
          correlatedIcao = track.icao;
          this.logger.log(
            `Correlated ACARS ${msg.tail}/${msg.flight ?? 'N/A'} with ADSB ${track.icao} (${track.reg ?? track.callsign}) at ${lat},${lon}`,
          );
          break;
        }
      }

      if (!correlatedIcao && adsbTracks.length > 0) {
        this.logger.debug(
          `No correlation found for ACARS ${msg.tail}/${msg.flight ?? 'N/A'}. Checked ${adsbTracks.length} ADSB tracks.`,
        );
      }

      const acarsMessage: AcarsMessage = {
        id,
        tail: msg.tail,
        flight: msg.flight || null,
        label: msg.label || null,
        text: msg.text || null,
        timestamp,
        frequency: msg.freq || null,
        signalLevel: msg.level || null,
        noiseLevel: msg.noise || null,
        mode: msg.mode || null,
        messageNumber: msg.msgno || null,
        sublabel: msg.sublabel || null,
        channel: msg.channel || null,
        stationId: msg.station_id || null,
        lastSeen: new Date(now).toISOString(),
        lat,
        lon,
        correlatedIcao,
      };

      this.messages.set(id, acarsMessage);
    }
  }

  private normalizeTailNumber(tail: string): string {
    // Remove spaces, hyphens, and convert to uppercase for comparison
    return tail.replace(/[\s-]/g, '').toUpperCase().trim();
  }

  private generateMessageId(msg: AcarsdecMessage): string {
    const parts = [msg.tail, msg.timestamp?.toString(), msg.label, msg.msgno, msg.flight].filter(
      Boolean,
    );
    return parts.join('-');
  }

  private cleanupExpiredMessages(): void {
    const now = Date.now();
    const expiredIds: string[] = [];

    for (const [id, msg] of this.messages.entries()) {
      const lastSeenTime = new Date(msg.lastSeen).getTime();
      if (now - lastSeenTime > this.messageExpiryMs) {
        expiredIds.push(id);
      }
    }

    for (const id of expiredIds) {
      this.messages.delete(id);
    }

    if (expiredIds.length > 0) {
      this.logger.debug(`Cleaned up ${expiredIds.length} expired ACARS messages`);
    }
  }

  private emitMessages(): void {
    const messages = this.getMessages();
    this.gateway.emitEvent(
      {
        type: 'acars.messages',
        messages,
      },
      { skipBus: true },
    );
  }
}
