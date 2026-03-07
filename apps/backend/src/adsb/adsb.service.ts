import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AlarmLevel, Prisma, WebhookEventType } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import readline from 'node:readline';
import { clearInterval as clearIntervalSafe, setInterval as setIntervalSafe } from 'node:timers';
import { Subscription } from 'rxjs';

import type { AdsbAlertRule, AdsbStatus, AdsbTrack } from './adsb.types';
import type { AcarsMessage } from '../acars/acars.types';
import {
  GeofenceEvent,
  GeofenceResponse,
  GeofencesService,
  GeofenceVertex,
} from '../geofences/geofences.service';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';
import { CommandCenterGateway } from '../ws/command-center.gateway';

function validateFeedUrl(urlString: string): string {
  const parsed = new URL(urlString);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only HTTP and HTTPS protocols are allowed');
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === '169.254.169.254' ||
    host === 'metadata.google.internal' ||
    host === 'metadata.aws.internal'
  ) {
    throw new Error('Access to cloud metadata endpoints is not allowed');
  }
  return urlString;
}

type AircraftDbEntry = {
  typeCode?: string | null;
  model?: string | null;
  manufacturer?: string | null;
  aircraftType?: string | null;
  categoryDescription?: string | null;
  registration?: string | null;
};

type AirportInfo = {
  icao?: string | null;
  iata?: string | null;
  name?: string | null;
  city?: string | null;
  country?: string | null;
};

interface Dump1090Aircraft {
  hex?: string;
  flight?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number;
  alt_geom?: number;
  gs?: number;
  track?: number;
  seen?: number;
  seen_pos?: number;
  rssi?: number;
  nav_heading?: number;
  baro_rate?: number;
  geom_rate?: number;
  category?: string;
  squawk?: string;
  nav_modes?: string;
  reg?: string;
  reg_num?: string;
  r?: string;
  dep?: string;
  dest?: string;
  cntry?: string;
  country?: string;
  messages?: number;
}

@Injectable()
export class AdsbService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AdsbService.name);
  private readonly hardDisabled: boolean;
  private enabled: boolean;
  private feedUrl: string;
  private intervalMs: number;
  private geofencesEnabled = true;
  private timer: NodeJS.Timeout | null = null;
  private lastPollAt: string | null = null;
  private lastError: string | null = null;
  private geofenceSubscription?: Subscription;
  private geofences: GeofenceResponse[] = [];
  private geofenceStates: Map<string, Map<string, boolean>> = new Map();
  private tracks: Map<string, AdsbTrack> = new Map();
  private sessionLog: Map<string, AdsbTrack> = new Map();
  private readonly localSiteId: string;
  private readonly dataDir: string;
  private readonly aircraftDbPath: string;
  private readonly airportsPath: string;
  private readonly configPath: string;
  private readonly alertRulesPath: string;
  private openskyEnabled: boolean;
  private openskyClientId?: string;
  private openskyClientSecret?: string;
  private openskyTokenUrl: string;
  private planespottersEnabled: boolean;
  private openskyAccessToken?: string;
  private openskyTokenExpiryMs = 0;
  private lastOpenskyError: string | null = null;
  private lastOpenskyRouteFetchAt: string | null = null;
  private lastOpenskyRouteSuccessAt: string | null = null;
  private openskyFailureCount = 0;
  private openskyCooldownUntil = 0;
  private openskyBackoffMs = 0;
  private openskyNextAvailableMs = 0;
  private openskyRatePromise: Promise<void> = Promise.resolve();
  private openskyDailyBudget = 4000;
  private openskyDailyUsed = 0;
  private openskyBudgetResetMs = 0;
  private openskyMinIntervalMs = 25_000;
  private readonly routeCache: Map<
    string,
    { dep: string | null; dest: string | null; ts: number; empty: boolean; retryAt: number }
  > = new Map();
  private static readonly ROUTE_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
  private static readonly ROUTE_MIN_RETRY_MS = 60 * 60 * 1000; // 1 hour
  private static readonly OPEN_SKY_BASE_BACKOFF_MS = 5 * 60 * 1000;
  private static readonly OPEN_SKY_MAX_BACKOFF_MS = 60 * 60 * 1000;
  private readonly photoCache: Map<
    string,
    {
      url: string | null;
      thumb: string | null;
      author: string | null;
      sourceUrl: string | null;
      ts: number;
    }
  > = new Map();
  private static readonly PHOTO_CACHE_TTL_MS = 60 * 60 * 1000;
  private readonly openskyCredentialsFile: string;
  private aircraftDb: Map<string, AircraftDbEntry> = new Map();
  private aircraftDbCount = 0;
  private airportsByIcao: Map<string, AirportInfo> = new Map();
  private airportsByIata: Map<string, AirportInfo> = new Map();
  private alertRules: AdsbAlertRule[] = [];

  constructor(
    private readonly configService: ConfigService,
    private readonly geofencesService: GeofencesService,
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
    private readonly webhookDispatcher: WebhookDispatcherService,
    private readonly gateway: CommandCenterGateway,
  ) {
    const envEnabled = process.env.ADSB_ENABLED;
    this.hardDisabled = envEnabled === 'false';
    const cfgToggle = this.configService.get<boolean>('adsb.enabled');
    const resolved = envEnabled !== undefined ? envEnabled === 'true' : cfgToggle;
    this.enabled = this.hardDisabled ? false : (resolved ?? false);
    this.feedUrl =
      this.configService.get<string>('adsb.feedUrl', 'http://127.0.0.1:8080/data/aircraft.json') ??
      'http://127.0.0.1:8080/data/aircraft.json';
    this.intervalMs = this.configService.get<number>('adsb.pollIntervalMs', 15000) ?? 15000;
    // Geofences are always enabled; user toggle removed.
    this.openskyEnabled = this.configService.get<boolean>('adsb.openskyEnabled', false) ?? false;
    this.openskyClientId = this.configService.get<string>('adsb.openskyClientId');
    this.openskyClientSecret = this.configService.get<string>('adsb.openskyClientSecret');
    this.openskyTokenUrl =
      this.configService.get<string>('adsb.openskyTokenUrl') ??
      'https://opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
    this.planespottersEnabled =
      this.configService.get<boolean>('adsb.planespottersEnabled', true) ?? true;
    const dailyBudget = this.configService.get<number>('adsb.openskyDailyBudget', 4000) ?? 4000;
    this.openskyDailyBudget = Math.max(1, dailyBudget);
    const intervalFromBudget = Math.floor((24 * 60 * 60 * 1000) / this.openskyDailyBudget);
    this.openskyMinIntervalMs = Math.max(1000, intervalFromBudget);
    this.resetOpenskyBudgetIfNeeded(true);
    this.localSiteId = this.configService.get<string>('site.id', 'default');
    const baseDir = join(__dirname, '..', '..');
    this.dataDir = join(baseDir, 'data', 'adsb');
    this.aircraftDbPath = join(this.dataDir, 'aircraft-database.csv');
    this.airportsPath = join(this.dataDir, 'airports.dat');
    this.configPath = join(this.dataDir, 'config.json');
    this.alertRulesPath = join(this.dataDir, 'adsb-alert-rules.json');
    this.openskyCredentialsFile =
      this.configService.get<string>('adsb.openskyCredentialsPath') ??
      join(this.dataDir, 'opensky-credentials.json');
    this.loadOpenskyCredentialsFromFile().catch((error) => {
      this.logger.debug(
        `OpenSky credential file load skipped: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  async onModuleInit(): Promise<void> {
    await this.refreshGeofences();
    await this.loadConfigFromDisk();
    this.geofenceSubscription = this.geofencesService
      .getChangesStream()
      .subscribe((event) => this.handleGeofenceChange(event));
    if (!this.hardDisabled) {
      void this.loadAircraftDatabaseFromDisk().catch((error) => {
        this.logger.warn(
          `ADS-B aircraft database not loaded: ${error instanceof Error ? error.message : error}`,
        );
      });
      void this.loadAirportsDatabaseFromDisk().catch((error) => {
        this.logger.warn(
          `ADS-B airports database not loaded: ${error instanceof Error ? error.message : error}`,
        );
      });
      void this.loadAlertRulesFromDisk().catch((error) => {
        this.logger.warn(
          `ADS-B alert rules not loaded: ${error instanceof Error ? error.message : error}`,
        );
      });
      void this.syncAllAlertRulesToDb().catch((error) => {
        this.logger.warn(
          `ADS-B alert rule DB sync skipped: ${error instanceof Error ? error.message : error}`,
        );
      });
    }
    if (this.enabled) {
      this.startPolling();
    }
  }

  onModuleDestroy(): void {
    this.stopPolling();
    this.geofenceSubscription?.unsubscribe();
  }

  getStatus(): AdsbStatus {
    const now = Date.now();
    const nextRouteRetry = Array.from(this.routeCache.values())
      .map((entry) => entry.retryAt)
      .filter((ts) => ts && ts > now)
      .sort((a, b) => a - b)[0];
    return {
      enabled: this.enabled,
      feedUrl: this.feedUrl,
      intervalMs: this.intervalMs,
      geofencesEnabled: true,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      trackCount: this.tracks.size,
      aircraftDbCount: this.aircraftDbCount,
      openskyEnabled: this.openskyEnabled,
      openskyClientId: this.openskyClientId ?? null,
      openskyStatus: {
        enabled: this.openskyEnabled,
        clientIdPresent: Boolean(this.openskyClientId && this.openskyClientSecret),
        lastFetchAt: this.lastOpenskyRouteFetchAt,
        lastSuccessAt: this.lastOpenskyRouteSuccessAt,
        lastError: this.lastOpenskyError,
        failureCount: this.openskyFailureCount,
        cooldownUntil: this.openskyCooldownUntil
          ? new Date(this.openskyCooldownUntil).toISOString()
          : null,
        nextRouteRetryAt: nextRouteRetry ? new Date(nextRouteRetry).toISOString() : null,
        dailyBudget: this.openskyDailyBudget,
        dailyUsed: this.openskyDailyUsed,
        budgetResetsAt: this.openskyBudgetResetMs
          ? new Date(this.openskyBudgetResetMs).toISOString()
          : null,
      },
      // Note: planespottersEnabled is intentionally not exposed to clients to avoid toggling in UI yet
    };
  }

  getFeedUrl(): string {
    return this.feedUrl;
  }

  getTracks(): AdsbTrack[] {
    return Array.from(this.tracks.values());
  }

  getSessionLog(): AdsbTrack[] {
    return Array.from(this.sessionLog.values());
  }

  clearSessionLog(): void {
    this.sessionLog.clear();
    this.tracks.clear();
    this.logger.log('Cleared ADS-B session log and live tracks');
  }

  // Alert rules CRUD
  async listAlertRules(): Promise<AdsbAlertRule[]> {
    return this.alertRules;
  }

  async createAlertRule(
    payload: Omit<AdsbAlertRule, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<AdsbAlertRule> {
    const now = new Date().toISOString();
    const rule: AdsbAlertRule = {
      ...payload,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      notifyVisual: payload.notifyVisual ?? true,
      notifyAudible: payload.notifyAudible ?? false,
      notifyEmail: payload.notifyEmail ?? false,
      emailRecipients: payload.emailRecipients ?? [],
      showOnMap: payload.showOnMap ?? true,
      mapColor: payload.mapColor ?? null,
      mapLabel: payload.mapLabel ?? null,
      blink: payload.blink ?? false,
      webhookIds: payload.webhookIds ?? [],
      messageTemplate: payload.messageTemplate ?? null,
    };
    rule.alertRuleId = await this.syncAlertRuleToDb(rule).catch((error) => {
      this.logger.warn(
        `Failed to sync ADS-B alert rule to DB: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    });
    this.alertRules.push(rule);
    await this.saveAlertRulesToDisk();
    return rule;
  }

  async updateAlertRule(id: string, patch: Partial<AdsbAlertRule>): Promise<AdsbAlertRule> {
    const idx = this.alertRules.findIndex((rule) => rule.id === id);
    if (idx === -1) {
      throw new Error('Alert rule not found');
    }
    const updated: AdsbAlertRule = {
      ...this.alertRules[idx],
      ...patch,
      notifyVisual: patch.notifyVisual ?? this.alertRules[idx].notifyVisual ?? true,
      notifyAudible: patch.notifyAudible ?? this.alertRules[idx].notifyAudible ?? false,
      notifyEmail: patch.notifyEmail ?? this.alertRules[idx].notifyEmail ?? false,
      emailRecipients: patch.emailRecipients ?? this.alertRules[idx].emailRecipients ?? [],
      showOnMap: patch.showOnMap ?? this.alertRules[idx].showOnMap ?? true,
      mapColor: patch.mapColor ?? this.alertRules[idx].mapColor ?? null,
      mapLabel: patch.mapLabel ?? this.alertRules[idx].mapLabel ?? null,
      blink: patch.blink ?? this.alertRules[idx].blink ?? false,
      webhookIds: patch.webhookIds ?? this.alertRules[idx].webhookIds ?? [],
      messageTemplate: patch.messageTemplate ?? this.alertRules[idx].messageTemplate ?? null,
      id,
      updatedAt: new Date().toISOString(),
    };
    updated.alertRuleId = await this.syncAlertRuleToDb(updated).catch((error) => {
      this.logger.warn(
        `Failed to sync ADS-B alert rule to DB: ${error instanceof Error ? error.message : String(error)}`,
      );
      return this.alertRules[idx].alertRuleId ?? null;
    });
    this.alertRules[idx] = updated;
    await this.saveAlertRulesToDisk();
    return updated;
  }

  async deleteAlertRule(id: string): Promise<{ deleted: boolean }> {
    const target = this.alertRules.find((rule) => rule.id === id);
    const before = this.alertRules.length;
    this.alertRules = this.alertRules.filter((rule) => rule.id !== id);
    const deleted = this.alertRules.length !== before;
    if (deleted) {
      if (target?.alertRuleId) {
        await this.prisma.alertRule
          .delete({
            where: { id: target.alertRuleId },
          })
          .catch((error) => {
            this.logger.warn(
              `Failed to delete DB alert rule ${target.alertRuleId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          });
      }
      await this.saveAlertRulesToDisk();
    }
    return { deleted };
  }

  updateConfig(config: {
    enabled?: boolean;
    feedUrl?: string;
    intervalMs?: number;
    openskyEnabled?: boolean;
    openskyClientId?: string | null;
    openskyClientSecret?: string | null;
    planespottersEnabled?: boolean;
  }): AdsbStatus {
    if (config.enabled !== undefined) {
      this.enabled = Boolean(config.enabled);
    }
    if (config.feedUrl !== undefined) {
      const trimmed = String(config.feedUrl).trim();
      validateFeedUrl(trimmed);
      this.feedUrl = trimmed;
    }
    if (config.intervalMs && Number.isFinite(config.intervalMs)) {
      this.intervalMs = Math.max(2000, Number(config.intervalMs));
    }
    if (config.openskyEnabled !== undefined) {
      this.openskyEnabled = Boolean(config.openskyEnabled);
    }
    if (config.planespottersEnabled !== undefined) {
      this.planespottersEnabled = Boolean(config.planespottersEnabled);
    }
    if (config.openskyClientId !== undefined) {
      const trimmed = config.openskyClientId?.trim() || null;
      this.openskyClientId = trimmed || undefined;
    }
    if (config.openskyClientSecret !== undefined) {
      const trimmed = config.openskyClientSecret?.trim() || null;
      this.openskyClientSecret = trimmed || undefined;
    }

    this.stopPolling();
    if (this.enabled) {
      if (this.aircraftDbCount === 0) {
        void this.loadAircraftDatabaseFromDisk().catch((error) => {
          this.logger.warn(
            `ADS-B aircraft database not loaded: ${error instanceof Error ? error.message : error}`,
          );
        });
        void this.loadAirportsDatabaseFromDisk().catch((error) => {
          this.logger.warn(
            `ADS-B airports database not loaded: ${error instanceof Error ? error.message : error}`,
          );
        });
        void this.loadAlertRulesFromDisk().catch((error) => {
          this.logger.warn(
            `ADS-B alert rules not loaded: ${error instanceof Error ? error.message : error}`,
          );
        });
        void this.syncAllAlertRulesToDb().catch((error) => {
          this.logger.warn(
            `ADS-B alert rule DB sync skipped: ${error instanceof Error ? error.message : error}`,
          );
        });
      }
      this.startPolling();
    }
    void this.persistConfig();
    return this.getStatus();
  }

  async saveAircraftDatabase(fileName: string, content: Buffer): Promise<{ saved: boolean }> {
    try {
      await mkdir(this.dataDir, { recursive: true });
      const basename = (fileName || 'aircraft-database.csv')
        .replace(/^.*[/\\]/, '')
        .replace(/\.\./g, '');
      if (!basename || basename.length === 0) {
        throw new Error('Invalid filename');
      }
      const targetPath = join(this.dataDir, basename);
      if (!targetPath.startsWith(this.dataDir)) {
        throw new Error('Invalid file path');
      }
      await writeFile(targetPath, content);
      this.logger.log(`Saved aircraft database to ${targetPath}`);
      await this.loadAircraftDatabaseFromDisk(targetPath);
      return { saved: true };
    } catch (error) {
      this.logger.error(
        `Failed to save aircraft database: ${error instanceof Error ? error.message : error}`,
      );
      throw error;
    }
  }

  async saveOpenskyCredentials(fileName: string, content: Buffer): Promise<{ saved: boolean }> {
    await mkdir(this.dataDir, { recursive: true });
    const targetPath = this.openskyCredentialsFile;
    const parsed = JSON.parse(content.toString('utf8')) as {
      clientId?: string;
      clientSecret?: string;
      tokenUrl?: string;
    };
    if (!parsed.clientId || !parsed.clientSecret) {
      throw new Error('Credentials JSON must include clientId and clientSecret');
    }
    await writeFile(targetPath, JSON.stringify(parsed, null, 2), 'utf8');
    this.openskyClientId = parsed.clientId.trim();
    this.openskyClientSecret = parsed.clientSecret.trim();
    if (parsed.tokenUrl && parsed.tokenUrl.trim()) {
      this.openskyTokenUrl = parsed.tokenUrl.trim();
    }
    this.openskyAccessToken = undefined;
    this.openskyTokenExpiryMs = 0;
    await this.persistConfig();
    this.logger.log(`Saved OpenSky credentials to ${targetPath}`);
    return { saved: true };
  }

  private async loadAircraftDatabaseFromDisk(path = this.aircraftDbPath): Promise<void> {
    if (!path.startsWith(this.dataDir)) {
      throw new Error('Invalid database path');
    }
    if (!existsSync(path)) {
      return;
    }
    const stream = createReadStream(path, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let header: string[] | null = null;
    const next = new Map<string, AircraftDbEntry>();
    for await (const line of rl) {
      if (!header) {
        header = this.parseCsvLine(line);
        continue;
      }
      if (!line.trim()) {
        continue;
      }
      const cols = this.parseCsvLine(line);
      if (cols.length === 0) {
        continue;
      }
      const icao24 = this.getColumn(cols, header, 'icao24')?.toUpperCase();
      if (!icao24) {
        continue;
      }
      next.set(icao24, {
        manufacturer: this.getColumn(cols, header, 'manufacturername'),
        model: this.getColumn(cols, header, 'model'),
        typeCode: this.getColumn(cols, header, 'typecode'),
        aircraftType: this.getColumn(cols, header, 'icaoaircrafttype'),
        categoryDescription: this.getColumn(cols, header, 'categoryDescription'),
        registration: this.getColumn(cols, header, 'registration'),
      });
    }
    this.aircraftDb = next;
    this.aircraftDbCount = next.size;
    this.logger.log(`Loaded ADS-B aircraft database (${this.aircraftDbCount} entries)`);
  }

  private async loadAirportsDatabaseFromDisk(path = this.airportsPath): Promise<void> {
    if (!path.startsWith(this.dataDir)) {
      throw new Error('Invalid airport database path');
    }
    if (!existsSync(path)) {
      return;
    }
    const stream = createReadStream(path, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const byIcao = new Map<string, AirportInfo>();
    const byIata = new Map<string, AirportInfo>();
    for await (const line of rl) {
      if (!line.trim()) continue;
      const cols = this.parseCsvLine(line);
      if (cols.length < 7) continue;
      const name = cols[1]?.replace(/^"+|"+$/g, '') ?? null;
      const city = cols[2]?.replace(/^"+|"+$/g, '') ?? null;
      const country = cols[3]?.replace(/^"+|"+$/g, '') ?? null;
      const iata = cols[4]?.trim().toUpperCase() || null;
      const icao = cols[5]?.trim().toUpperCase() || null;
      if (!icao && !iata) {
        continue;
      }
      const info: AirportInfo = { icao, iata, name, city, country };
      if (icao) byIcao.set(icao, info);
      if (iata) byIata.set(iata, info);
    }
    this.airportsByIcao = byIcao;
    this.airportsByIata = byIata;
    this.logger.log(`Loaded ADS-B airport database (${byIcao.size} ICAO entries)`);
  }

  private async loadConfigFromDisk(): Promise<void> {
    try {
      if (!existsSync(this.configPath)) {
        return;
      }
      const raw = await readFile(this.configPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<{
        enabled: boolean;
        feedUrl: string;
        intervalMs: number;
        openskyEnabled: boolean;
        openskyClientId?: string | null;
        openskyClientSecret?: string | null;
      }>;
      if (typeof parsed.enabled === 'boolean') {
        this.enabled = this.hardDisabled ? false : parsed.enabled;
      }
      if (typeof parsed.feedUrl === 'string' && parsed.feedUrl.trim()) {
        this.feedUrl = parsed.feedUrl.trim();
      }
      if (typeof parsed.intervalMs === 'number' && Number.isFinite(parsed.intervalMs)) {
        this.intervalMs = Math.max(2000, parsed.intervalMs);
      }
      if (typeof parsed.openskyEnabled === 'boolean') {
        this.openskyEnabled = this.hardDisabled ? false : parsed.openskyEnabled;
      }
      if (typeof parsed.openskyClientId === 'string') {
        this.openskyClientId = parsed.openskyClientId.trim() || undefined;
      }
      if (typeof parsed.openskyClientSecret === 'string') {
        this.openskyClientSecret = parsed.openskyClientSecret.trim() || undefined;
      }
    } catch (error) {
      this.logger.warn(
        `Failed to load ADS-B config: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async persistConfig(): Promise<void> {
    try {
      await mkdir(this.dataDir, { recursive: true });
      const payload = {
        enabled: this.enabled,
        feedUrl: this.feedUrl,
        intervalMs: this.intervalMs,
        geofencesEnabled: true,
        openskyEnabled: this.openskyEnabled,
        openskyClientId: this.openskyClientId ?? null,
        openskyClientSecret: this.openskyClientSecret ?? null,
      };
      await writeFile(this.configPath, JSON.stringify(payload, null, 2), 'utf8');
    } catch (error) {
      this.logger.warn(
        `Failed to persist ADS-B config: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private parseCsvLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"' && inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
        continue;
      }
      if (char === '"') {
        inQuotes = !inQuotes;
        continue;
      }
      if (char === ',' && !inQuotes) {
        result.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current);
    return result;
  }

  private getColumn(cols: string[], header: string[], name: string): string | null {
    const idx = header.findIndex((col) => col.toLowerCase() === name.toLowerCase());
    if (idx === -1) {
      return null;
    }
    const value = cols[idx]?.trim();
    return value && value.length > 0 ? value : null;
  }

  private startPolling(): void {
    this.timer = setIntervalSafe(() => {
      void this.poll().catch((error) => {
        this.lastError = this.normalizeError(error);
        this.logger.warn(`ADSB poll failed: ${this.lastError}`);
      });
    }, this.intervalMs);
    void this.poll().catch((error) => {
      this.lastError = this.normalizeError(error);
      this.logger.warn(`ADSB initial poll failed: ${this.lastError}`);
    });
  }

  private stopPolling(): void {
    if (this.timer) {
      clearIntervalSafe(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    if (!this.enabled) {
      return; // ignore scheduled polls when ADS-B is disabled
    }
    if (!this.feedUrl) {
      throw new Error('No ADSB feed URL configured');
    }
    const feedUrl = validateFeedUrl(this.feedUrl);
    // codeql[js/request-forgery] Admin-configured URL with protocol validation
    const response = await fetch(feedUrl, { redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location) {
        validateFeedUrl(new URL(location, feedUrl).toString());
      }
      throw new Error('Redirect not followed - update feed URL directly');
    }
    if (!response.ok) {
      throw new Error(`ADSB feed error: ${response.status} ${response.statusText}`);
    }
    const payload = (await response.json()) as { aircraft?: Dump1090Aircraft[] };
    const aircraft = Array.isArray(payload.aircraft) ? payload.aircraft : [];
    const nextTracks: Map<string, AdsbTrack> = new Map();
    const enrichTasks: Promise<void>[] = [];

    aircraft.forEach((entry) => {
      if (typeof entry.lat !== 'number' || typeof entry.lon !== 'number') {
        return;
      }
      const hex = (entry.hex ?? '').trim().toUpperCase();
      if (!hex) {
        return;
      }
      const id = hex;
      const existing = this.tracks.get(id);
      const callsign = (entry.flight ?? '').trim() || null;
      const alt = this.toNumber(entry.alt_geom ?? entry.alt_baro);
      const speed = this.toNumber(
        entry.gs ??
          (entry as Record<string, unknown>).g_speed ??
          (entry as Record<string, unknown>).spd ??
          (entry as Record<string, unknown>).speed,
      );
      const heading = this.toNumber(entry.track);
      const now = new Date(Date.now() - (entry.seen ?? 0) * 1000).toISOString();
      const { dep, dest } = this.extractRoute(entry, existing);
      const track: AdsbTrack = {
        id,
        icao: hex,
        callsign,
        reg:
          typeof entry.reg === 'string' && entry.reg.trim()
            ? entry.reg.trim()
            : typeof entry.r === 'string' && entry.r.trim()
              ? entry.r.trim()
              : typeof entry.reg_num === 'string' && entry.reg_num.trim()
                ? entry.reg_num.trim()
                : (existing?.reg ?? null),
        lat: entry.lat,
        lon: entry.lon,
        alt: alt ?? existing?.alt ?? null,
        speed: speed ?? existing?.speed ?? null,
        heading: heading ?? existing?.heading ?? null,
        onGround: null,
        firstSeen: existing?.firstSeen ?? now,
        lastSeen: now,
        siteId: this.localSiteId,
        category:
          typeof entry.category === 'string'
            ? entry.category.trim() || null
            : (existing?.category ?? null),
        dep,
        dest,
        depTime: existing?.depTime ?? null,
        destTime: existing?.destTime ?? null,
        depDistanceM: existing?.depDistanceM ?? null,
        destDistanceM: existing?.destDistanceM ?? null,
        depCandidates: existing?.depCandidates ?? null,
        destCandidates: existing?.destCandidates ?? null,
        routeSource: dep || dest ? 'feed' : (existing?.routeSource ?? null),
        country:
          typeof entry.cntry === 'string' && entry.cntry.trim()
            ? entry.cntry.trim()
            : typeof entry.country === 'string' && entry.country.trim()
              ? entry.country.trim()
              : (existing?.country ?? null),
        messages:
          typeof entry.messages === 'number' ? entry.messages : (existing?.messages ?? null),
      };
      this.enrichAirportMetadata(track);
      this.enrichTrack(track);
      nextTracks.set(id, track);
      this.evaluateAlertRules(track);

      if (this.openskyEnabled && (!track.dep || !track.dest)) {
        enrichTasks.push(this.enrichRoute(track));
      }
      if (this.planespottersEnabled) {
        enrichTasks.push(this.enrichPhoto(track));
      }
    });

    // Update current active tracks (for map)
    this.tracks = nextTracks;

    // Merge into session log (for ADS-B log page)
    nextTracks.forEach((track, id) => {
      this.sessionLog.set(id, track);
    });

    if (enrichTasks.length > 0) {
      await Promise.allSettled(enrichTasks);
    }

    this.lastPollAt = new Date().toISOString();
    this.lastError = null;
    this.evaluateGeofences(this.tracks);
    this.gateway.emitEvent(
      { type: 'adsb.tracks', tracks: Array.from(nextTracks.values()) },
      { skipBus: true },
    );
  }

  private async refreshGeofences(): Promise<void> {
    try {
      this.geofences = await this.geofencesService.list({ includeRemote: true });
      this.geofenceStates.clear();
    } catch (error) {
      this.logger.warn(
        `Failed to refresh geofences for ADS-B: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private handleGeofenceChange(event: GeofenceEvent): void {
    if (event.type === 'upsert') {
      this.upsertGeofenceLocal(event.geofence);
    } else if (event.type === 'delete' || event.type === 'delete-request') {
      this.removeGeofenceLocal(event.geofence.id);
    }
  }

  private upsertGeofenceLocal(geofence: GeofenceResponse): void {
    const existingIndex = this.geofences.findIndex((item) => item.id === geofence.id);
    if (existingIndex >= 0) {
      this.geofences[existingIndex] = geofence;
    } else {
      this.geofences.push(geofence);
    }
    this.geofenceStates.delete(geofence.id);
  }

  private removeGeofenceLocal(id: string): void {
    this.geofences = this.geofences.filter((geofence) => geofence.id !== id);
    this.geofenceStates.delete(id);
  }

  private evaluateGeofences(tracks: Map<string, AdsbTrack>): void {
    if (this.geofences.length === 0) {
      this.geofenceStates.clear();
      return;
    }

    const activeEntities = new Set<string>();
    tracks.forEach((track) => {
      const entityKey = this.buildEntityKey(track);
      activeEntities.add(entityKey);
      this.geofences.forEach((geofence) => {
        if (!geofence.alarm.enabled || geofence.polygon.length < 3 || !geofence.appliesToAdsb) {
          return;
        }
        const inside = this.pointInPolygon(track.lat, track.lon, geofence.polygon);
        const geofenceState = this.geofenceStates.get(geofence.id) ?? new Map<string, boolean>();
        const prevInside = geofenceState.get(entityKey) ?? false;
        geofenceState.set(entityKey, inside);
        this.geofenceStates.set(geofence.id, geofenceState);

        if (inside && !prevInside) {
          this.emitGeofenceAlert(geofence, track, 'enter');
        } else if (!inside && prevInside && geofence.alarm.triggerOnExit) {
          this.emitGeofenceAlert(geofence, track, 'exit');
        }
      });
    });

    this.geofenceStates.forEach((stateMap, geofenceId) => {
      Array.from(stateMap.keys()).forEach((key) => {
        if (!activeEntities.has(key)) {
          stateMap.delete(key);
        }
      });
      if (stateMap.size === 0) {
        this.geofenceStates.delete(geofenceId);
      }
    });
  }

  private emitGeofenceAlert(
    geofence: GeofenceResponse,
    track: AdsbTrack,
    transition: 'enter' | 'exit',
  ): void {
    const siteId = geofence.siteId ?? track.siteId ?? this.localSiteId;
    const label = track.callsign ?? track.icao;
    const message = this.formatGeofenceMessage(geofence.alarm.message, {
      geofence: geofence.name,
      entity: label,
      type: 'adsb',
      event: transition,
    });

    this.gateway.emitEvent({
      type: 'event.alert',
      category: 'geofence',
      level: (geofence.alarm.level as AlarmLevel) ?? 'NOTICE',
      geofenceId: geofence.id,
      geofenceName: geofence.name,
      nodeId: label,
      siteId,
      message,
      lat: track.lat,
      lon: track.lon,
      timestamp: new Date().toISOString(),
      data: {
        geofenceId: geofence.id,
        geofenceName: geofence.name,
        entityId: track.id,
        entityType: 'adsb',
        transition,
      },
    });
  }

  private buildEntityKey(track: AdsbTrack): string {
    const siteId = track.siteId ?? this.localSiteId;
    return `${siteId}::${track.id}`;
  }

  private enrichTrack(track: AdsbTrack): void {
    const entry = this.aircraftDb.get(track.icao.toUpperCase());
    if (!entry) {
      return;
    }
    // Prioritize feed data over CSV database to avoid bad CSV data corrupting good live data
    track.manufacturer = track.manufacturer ?? entry.manufacturer ?? null;
    track.model = track.model ?? entry.model ?? null;
    track.typeCode = track.typeCode ?? entry.typeCode ?? null;
    track.aircraftType = track.aircraftType ?? entry.aircraftType ?? null;
    track.categoryDescription = track.categoryDescription ?? entry.categoryDescription ?? null;
    track.reg = track.reg ?? entry.registration ?? null;
    // Only use CSV category if feed doesn't have one
    if (!track.category && entry.categoryDescription) {
      track.category = entry.categoryDescription;
    }
  }

  private pointInPolygon(lat: number, lon: number, polygon: GeofenceVertex[]): boolean {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i].lat;
      const yi = polygon[i].lon;
      const xj = polygon[j].lat;
      const yj = polygon[j].lon;
      const intersect =
        yi > lon !== yj > lon && lat < ((xj - xi) * (lon - yi)) / (yj - yi + Number.EPSILON) + xi;
      if (intersect) {
        inside = !inside;
      }
    }
    return inside;
  }

  private formatGeofenceMessage(
    template: string | undefined,
    context: { geofence: string; entity: string; type: string; event: 'enter' | 'exit' },
  ): string {
    const message =
      template && template.trim().length > 0
        ? template
        : `{entity} ${context.event}s geofence {geofence}`;
    return message
      .replace(/\{geofence\}/gi, context.geofence)
      .replace(/\{entity\}/gi, context.entity)
      .replace(/\{node\}/gi, context.entity)
      .replace(/\{type\}/gi, context.type)
      .replace(/\{event\}/gi, context.event);
  }

  private normalizeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (/fetch failed/i.test(message)) {
      return 'Failed to fetch feed';
    }
    return message;
  }

  private async loadOpenskyCredentialsFromFile(): Promise<void> {
    if (this.openskyClientId && this.openskyClientSecret) {
      this.logger.debug('OpenSky credentials already provided via config.');
      return;
    }
    const candidates = [this.openskyCredentialsFile, join(process.cwd(), 'credentials.json')];
    try {
      for (const path of candidates) {
        if (!path || !existsSync(path)) {
          continue;
        }
        const raw = await readFile(path, 'utf8');
        const parsed = JSON.parse(raw) as {
          clientId?: string;
          clientSecret?: string;
          tokenUrl?: string;
        };
        if (!this.openskyClientId && parsed.clientId) {
          this.openskyClientId = parsed.clientId.trim();
        }
        if (!this.openskyClientSecret && parsed.clientSecret) {
          this.openskyClientSecret = parsed.clientSecret.trim();
        }
        if (parsed.tokenUrl && parsed.tokenUrl.trim()) {
          this.openskyTokenUrl = parsed.tokenUrl.trim();
        }
        if (this.openskyClientId || this.openskyClientSecret) {
          this.logger.log(`Loaded OpenSky credentials from ${path}`);
          return;
        }
      }
      this.logger.debug('No OpenSky credential file found among candidates.');
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  private async enrichRoute(track: AdsbTrack): Promise<void> {
    try {
      if (!this.openskyEnabled || !this.openskyClientId || !this.openskyClientSecret) {
        return;
      }
      const now = Date.now();
      this.resetOpenskyBudgetIfNeeded();
      if (now < this.openskyCooldownUntil) {
        if (now >= this.openskyCooldownUntil && this.lastOpenskyError?.includes('429')) {
          this.lastOpenskyError = null;
        }
        return;
      }

      const cached = this.routeCache.get(track.icao);
      if (cached) {
        if (cached.empty && now < cached.retryAt) {
          return;
        }
        if (!cached.empty && now < cached.retryAt) {
          if (cached.dep && !track.dep) track.dep = cached.dep;
          if (cached.dest && !track.dest) track.dest = cached.dest;
          this.syncTrackRoute(track);
          return;
        }
      }

      this.lastOpenskyRouteFetchAt = new Date().toISOString();
      const route = await this.fetchOpenSkyRoute(track.icao);
      if (!route) {
        this.routeCache.set(track.icao, {
          dep: null,
          dest: null,
          ts: now,
          empty: true,
          retryAt: now + AdsbService.ROUTE_MIN_RETRY_MS,
        });
        this.lastOpenskyError = 'OpenSky returned no route';
        this.openskyFailureCount += 1;
        return;
      }

      this.routeCache.set(track.icao, {
        dep: route.dep,
        dest: route.dest,
        ts: now,
        empty: false,
        retryAt: now + Math.max(AdsbService.ROUTE_CACHE_TTL_MS, AdsbService.ROUTE_MIN_RETRY_MS),
      });
      this.lastOpenskyRouteSuccessAt = new Date().toISOString();
      this.lastOpenskyError = null;
      this.openskyFailureCount = 0;
      track.routeSource = 'opensky';
      if (route.dep && !track.dep) track.dep = route.dep;
      if (route.dest && !track.dest) track.dest = route.dest;
      if (route.depTime) track.depTime = route.depTime;
      if (route.destTime) track.destTime = route.destTime;
      if (route.depDistanceM !== undefined) track.depDistanceM = route.depDistanceM;
      if (route.destDistanceM !== undefined) track.destDistanceM = route.destDistanceM;
      if (route.depCandidates !== undefined) track.depCandidates = route.depCandidates;
      if (route.destCandidates !== undefined) track.destCandidates = route.destCandidates;
      this.enrichAirportMetadata(track);
      this.syncTrackRoute(track);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 429) {
        const base = AdsbService.OPEN_SKY_BASE_BACKOFF_MS;
        const nextBackoff = this.openskyBackoffMs
          ? Math.min(AdsbService.OPEN_SKY_MAX_BACKOFF_MS, this.openskyBackoffMs * 2)
          : base;
        this.openskyBackoffMs = nextBackoff;
        this.openskyCooldownUntil = Date.now() + nextBackoff;
        this.lastOpenskyError = `OpenSky 429; backing off ${Math.round(nextBackoff / 60000)}m`;
        return;
      }
      this.lastOpenskyError = error instanceof Error ? error.message : String(error);
      this.openskyFailureCount += 1;
      this.logger.debug(
        `OpenSky enrichment failed for ${track.icao}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private async enrichPhoto(track: AdsbTrack): Promise<void> {
    const hex = track.icao?.toLowerCase();
    if (!hex) return;
    const now = Date.now();
    const cached = this.photoCache.get(hex);
    const cachedFresh = cached && now - cached.ts < AdsbService.PHOTO_CACHE_TTL_MS;
    const cachedHasImage = cached?.thumb || cached?.url;
    if (cachedFresh && cachedHasImage) {
      this.applyPhoto(track, cached);
      return;
    }

    try {
      const photo = await this.fetchPlanespottersPhoto(hex, track.reg ?? undefined);
      const record = {
        url: photo?.url ?? null,
        thumb: photo?.thumb ?? null,
        author: photo?.author ?? null,
        sourceUrl: photo?.sourceUrl ?? null,
        ts: now,
      };
      this.photoCache.set(hex, record);
      this.applyPhoto(track, record);
    } catch (error) {
      // Cache only the failure timestamp; allow retries so images can recover if API was temporarily unavailable.
      this.photoCache.set(hex, {
        url: null,
        thumb: null,
        author: null,
        sourceUrl: null,
        ts: now,
      });
      this.logger.debug(
        `Planespotters lookup failed for ${hex}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private syncTrackRoute(track: AdsbTrack): void {
    const current = this.tracks.get(track.id);
    if (current) {
      current.dep = track.dep ?? current.dep ?? null;
      current.dest = track.dest ?? current.dest ?? null;
      current.routeSource = track.routeSource ?? current.routeSource ?? null;
      current.depTime = track.depTime ?? current.depTime ?? null;
      current.destTime = track.destTime ?? current.destTime ?? null;
      current.depDistanceM = track.depDistanceM ?? current.depDistanceM ?? null;
      current.destDistanceM = track.destDistanceM ?? current.destDistanceM ?? null;
      current.depCandidates = track.depCandidates ?? current.depCandidates ?? null;
      current.destCandidates = track.destCandidates ?? current.destCandidates ?? null;
      current.depIata = track.depIata ?? current.depIata ?? null;
      current.destIata = track.destIata ?? current.destIata ?? null;
      current.depIcao = track.depIcao ?? current.depIcao ?? null;
      current.destIcao = track.destIcao ?? current.destIcao ?? null;
      current.depAirport = track.depAirport ?? current.depAirport ?? null;
      current.destAirport = track.destAirport ?? current.destAirport ?? null;
    }
    const log = this.sessionLog.get(track.id);
    if (log) {
      log.dep = track.dep ?? log.dep ?? null;
      log.dest = track.dest ?? log.dest ?? null;
      log.routeSource = track.routeSource ?? log.routeSource ?? null;
      log.depTime = track.depTime ?? log.depTime ?? null;
      log.destTime = track.destTime ?? log.destTime ?? null;
      log.depDistanceM = track.depDistanceM ?? log.depDistanceM ?? null;
      log.destDistanceM = track.destDistanceM ?? log.destDistanceM ?? null;
      log.depCandidates = track.depCandidates ?? log.depCandidates ?? null;
      log.destCandidates = track.destCandidates ?? log.destCandidates ?? null;
      log.depIata = track.depIata ?? log.depIata ?? null;
      log.destIata = track.destIata ?? log.destIata ?? null;
      log.depIcao = track.depIcao ?? log.depIcao ?? null;
      log.destIcao = track.destIcao ?? log.destIcao ?? null;
      log.depAirport = track.depAirport ?? log.depAirport ?? null;
      log.destAirport = track.destAirport ?? log.destAirport ?? null;
      this.sessionLog.set(track.id, log);
    }
  }

  private async fetchOpenSkyRoute(icao: string): Promise<{
    dep: string | null;
    dest: string | null;
    depTime?: string | null;
    destTime?: string | null;
    depDistanceM?: number | null;
    destDistanceM?: number | null;
    depCandidates?: number | null;
    destCandidates?: number | null;
  } | null> {
    await this.enforceOpenSkyRateLimit();
    const end = Math.floor(Date.now() / 1000);
    const begin = end - 12 * 3600;
    const url = `https://opensky-network.org/api/flights/aircraft?icao24=${icao.toLowerCase()}&begin=${begin}&end=${end}`;

    const response = await this.fetchWithOpenskyAuth(url);

    if (!response.ok) {
      const err = new Error(`OpenSky ${response.status} ${response.statusText}`) as Error & {
        status?: number;
      };
      err.status = response.status;
      throw err;
    }

    const flights = (await response.json()) as Array<{
      estDepartureAirport?: string | null;
      estArrivalAirport?: string | null;
      firstSeen?: number;
      lastSeen?: number;
      estDepartureAirportHorizDistance?: number;
      estArrivalAirportHorizDistance?: number;
      estDepartureAirportCandidatesCount?: number;
      estArrivalAirportCandidatesCount?: number;
    }>;
    if (!Array.isArray(flights) || flights.length === 0) {
      return null;
    }

    const latest = flights[flights.length - 1];
    const dep = typeof latest.estDepartureAirport === 'string' ? latest.estDepartureAirport : null;
    const dest = typeof latest.estArrivalAirport === 'string' ? latest.estArrivalAirport : null;
    if (!dep && !dest) {
      return null;
    }
    return {
      dep: dep ?? null,
      dest: dest ?? null,
      depTime: latest.firstSeen ? new Date(latest.firstSeen * 1000).toISOString() : null,
      destTime: latest.lastSeen ? new Date(latest.lastSeen * 1000).toISOString() : null,
      depDistanceM:
        typeof latest.estDepartureAirportHorizDistance === 'number'
          ? latest.estDepartureAirportHorizDistance
          : null,
      destDistanceM:
        typeof latest.estArrivalAirportHorizDistance === 'number'
          ? latest.estArrivalAirportHorizDistance
          : null,
      depCandidates:
        typeof latest.estDepartureAirportCandidatesCount === 'number'
          ? latest.estDepartureAirportCandidatesCount
          : null,
      destCandidates:
        typeof latest.estArrivalAirportCandidatesCount === 'number'
          ? latest.estArrivalAirportCandidatesCount
          : null,
    };
  }

  private async fetchWithOpenskyAuth(url: string, attempt = 0): Promise<Response> {
    const token = await this.getOpenskyAccessToken(attempt > 0);
    if (!token) {
      throw new Error('OpenSky credentials not configured');
    }

    const response = await this.fetchWithTimeout(
      url,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
      5000,
    );

    if ((response.status === 401 || response.status === 403) && attempt < 1) {
      this.openskyAccessToken = undefined;
      this.openskyTokenExpiryMs = 0;
      return this.fetchWithOpenskyAuth(url, attempt + 1);
    }

    return response;
  }

  private async getOpenskyAccessToken(forceRefresh = false): Promise<string | null> {
    if (!this.openskyClientId || !this.openskyClientSecret) {
      return null;
    }
    const now = Date.now();
    if (!forceRefresh && this.openskyAccessToken && now < this.openskyTokenExpiryMs) {
      return this.openskyAccessToken;
    }

    const body = new URLSearchParams();
    body.set('grant_type', 'client_credentials');
    body.set('client_id', this.openskyClientId);
    body.set('client_secret', this.openskyClientSecret);

    const response = await fetch(this.openskyTokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    if (!response.ok) {
      throw new Error(`OpenSky auth failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!payload.access_token) {
      throw new Error('OpenSky auth response missing access_token');
    }

    const ttlMs = typeof payload.expires_in === 'number' ? payload.expires_in * 1000 : 300_000;
    this.openskyAccessToken = payload.access_token;
    this.openskyTokenExpiryMs = Date.now() + Math.max(30_000, ttlMs - 30_000);
    return this.openskyAccessToken;
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs = 5000,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  private enforceOpenSkyRateLimit(): Promise<void> {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const now = Date.now();
    const wait = Math.max(0, this.openskyNextAvailableMs - now);
    this.openskyRatePromise = this.openskyRatePromise.then(async () => {
      if (wait > 0) {
        await sleep(wait);
      }
      this.openskyNextAvailableMs = Date.now() + this.openskyMinIntervalMs;
      this.openskyDailyUsed += 1;
      if (this.openskyDailyUsed >= this.openskyDailyBudget) {
        this.lastOpenskyError = `OpenSky daily budget exhausted (${this.openskyDailyUsed}/${this.openskyDailyBudget}).`;
      }
    });
    return this.openskyRatePromise;
  }

  private toNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }

  private resetOpenskyBudgetIfNeeded(force = false): void {
    const now = Date.now();
    if (force || now >= this.openskyBudgetResetMs) {
      const tomorrow = new Date();
      tomorrow.setHours(24, 0, 0, 0);
      this.openskyBudgetResetMs = tomorrow.getTime();
      this.openskyDailyUsed = 0;
      this.lastOpenskyError = null;
      this.openskyBackoffMs = 0;
    }
  }

  private extractRoute(
    entry: Dump1090Aircraft,
    existing?: AdsbTrack,
  ): { dep: string | null; dest: string | null } {
    const candidates = [
      typeof entry.dep === 'string' ? entry.dep.trim() : null,
      typeof entry.dest === 'string' ? entry.dest.trim() : null,
    ];

    const departure =
      candidates[0] && candidates[0].length > 0 ? candidates[0] : (existing?.dep ?? null);
    const destination =
      candidates[1] && candidates[1].length > 0 ? candidates[1] : (existing?.dest ?? null);

    if (departure && destination) {
      return { dep: departure, dest: destination };
    }

    const estDep =
      typeof (entry as Record<string, unknown>).estDepartureAirport === 'string'
        ? ((entry as Record<string, unknown>).estDepartureAirport as string).trim()
        : null;
    const estArr =
      typeof (entry as Record<string, unknown>).estArrivalAirport === 'string'
        ? ((entry as Record<string, unknown>).estArrivalAirport as string).trim()
        : null;

    const fromField =
      typeof (entry as Record<string, unknown>).from === 'string'
        ? ((entry as Record<string, unknown>).from as string).trim()
        : null;
    const toField =
      typeof (entry as Record<string, unknown>).to === 'string'
        ? ((entry as Record<string, unknown>).to as string).trim()
        : null;

    const route = typeof entry.r === 'string' ? entry.r.trim() : null;
    let routeDep: string | null = null;
    let routeDest: string | null = null;
    if (route && route.length >= 6) {
      if (route.includes(' ') || route.includes('-') || route.includes('/')) {
        const parts = route.split(/[\s/-]+/).filter((p) => p.length > 0);
        if (parts.length >= 2) {
          routeDep = parts[0];
          routeDest = parts[1];
        }
      } else if (route.length === 6) {
        routeDep = route.slice(0, 3);
        routeDest = route.slice(3, 6);
      }
    }

    return {
      dep: departure ?? fromField ?? estDep ?? routeDep ?? existing?.dep ?? null,
      dest: destination ?? toField ?? estArr ?? routeDest ?? existing?.dest ?? null,
    };
  }

  private enrichAirportMetadata(track: AdsbTrack): void {
    const depInfo = this.resolveAirport(track.dep);
    const destInfo = this.resolveAirport(track.dest);

    if (depInfo) {
      track.depIcao =
        depInfo.icao ?? track.depIcao ?? (track.dep && track.dep.length === 4 ? track.dep : null);
      track.depIata =
        depInfo.iata ?? track.depIata ?? (track.dep && track.dep.length === 3 ? track.dep : null);
      track.depAirport = depInfo.name ?? track.depAirport ?? depInfo.city ?? null;
      if (depInfo.icao && track.dep && track.dep.length === 3) {
        track.dep = depInfo.icao;
      }
    }

    if (destInfo) {
      track.destIcao =
        destInfo.icao ??
        track.destIcao ??
        (track.dest && track.dest.length === 4 ? track.dest : null);
      track.destIata =
        destInfo.iata ??
        track.destIata ??
        (track.dest && track.dest.length === 3 ? track.dest : null);
      track.destAirport = destInfo.name ?? track.destAirport ?? destInfo.city ?? null;
      if (destInfo.icao && track.dest && track.dest.length === 3) {
        track.dest = destInfo.icao;
      }
    }
  }

  private resolveAirport(code?: string | null): AirportInfo | null {
    if (!code) return null;
    const trimmed = code.trim().toUpperCase();
    if (!trimmed) return null;
    const fromIcao = this.airportsByIcao.get(trimmed);
    if (fromIcao) return fromIcao;
    const fromIata = this.airportsByIata.get(trimmed);
    if (fromIata) return fromIata;
    return null;
  }

  private applyPhoto(
    track: AdsbTrack,
    photo: {
      url: string | null;
      thumb: string | null;
      author: string | null;
      sourceUrl: string | null;
    },
  ): void {
    track.photoUrl = photo.url ?? track.photoUrl ?? null;
    track.photoThumbUrl = photo.thumb ?? track.photoThumbUrl ?? null;
    track.photoAuthor = photo.author ?? track.photoAuthor ?? null;
    track.photoSourceUrl = photo.sourceUrl ?? track.photoSourceUrl ?? null;
    this.syncTrackRoute(track);
  }

  private async fetchPlanespottersPhoto(
    hex: string,
    _registration?: string | null,
  ): Promise<{
    url: string | null;
    thumb: string | null;
    author: string | null;
    sourceUrl: string | null;
  } | null> {
    const targetHex = hex.toLowerCase();
    const url = `https://api.planespotters.net/pub/photos/hex/${encodeURIComponent(targetHex)}`;

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Planespotters ${response.status} ${response.statusText}`);
    }
    const payload = (await response.json()) as {
      photos?: Array<{
        thumbnail?: { src?: string };
        thumbnail_large?: { src?: string };
        large?: { src?: string };
        link?: string;
        photographer?: string;
      }>;
    };
    const photo =
      Array.isArray(payload.photos) && payload.photos.length > 0 ? payload.photos[0] : null;
    if (!photo) {
      return null;
    }
    return {
      url: photo.large?.src ?? photo.thumbnail_large?.src ?? photo.thumbnail?.src ?? null,
      thumb:
        photo.thumbnail?.src ??
        photo.thumbnail_large?.src ??
        photo.large?.src ??
        photo.link ??
        null,
      author: photo.photographer ?? null,
      sourceUrl: photo.link ?? null,
    };
  }

  // ----- Alert rules helpers -----
  private evaluateAlertRules(track: AdsbTrack): void {
    const activeRules = this.alertRules.filter((rule) => rule.enabled && rule.target === 'adsb');
    if (activeRules.length === 0) return;
    for (const rule of activeRules) {
      if (this.ruleMatchesTrack(rule, track)) {
        void this.dispatchAlert(rule, track, 'adsb').catch((error) => {
          this.logger.warn(
            `Failed to dispatch ADS-B alert: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
    }
  }

  evaluateAlertRulesForAcars(message: AcarsMessage): void {
    const activeRules = this.alertRules.filter((rule) => rule.enabled && rule.target === 'acars');
    if (activeRules.length === 0) return;
    for (const rule of activeRules) {
      if (this.ruleMatchesAcars(rule, message)) {
        void this.dispatchAlert(rule, message, 'acars').catch((error) => {
          this.logger.warn(
            `Failed to dispatch ACARS alert: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
    }
  }

  private ruleMatchesTrack(rule: AdsbAlertRule, track: AdsbTrack): boolean {
    if (rule.target !== 'adsb') return false;
    const c = rule.conditions;
    if (c.callsignContains) {
      const val = track.callsign?.toLowerCase() ?? '';
      if (!val.includes(c.callsignContains.toLowerCase())) return false;
    }
    if (c.icaoEquals) {
      if (track.icao.toLowerCase() !== c.icaoEquals.toLowerCase()) return false;
    }
    if (c.registrationContains) {
      const val = track.reg?.toLowerCase() ?? '';
      if (!val.includes(c.registrationContains.toLowerCase())) return false;
    }
    if (c.countryEquals) {
      if ((track.country ?? '').toLowerCase() !== c.countryEquals.toLowerCase()) return false;
    }
    if (c.categoryEquals) {
      if ((track.category ?? '').toLowerCase() !== c.categoryEquals.toLowerCase()) return false;
    }
    if (c.depEquals) {
      const dep = (track.depIcao ?? track.dep ?? '').toLowerCase();
      if (dep !== c.depEquals.toLowerCase()) return false;
    }
    if (c.destEquals) {
      const dest = (track.destIcao ?? track.dest ?? '').toLowerCase();
      if (dest !== c.destEquals.toLowerCase()) return false;
    }
    if (typeof c.minAlt === 'number' && track.alt != null && track.alt < c.minAlt) return false;
    if (typeof c.maxAlt === 'number' && track.alt != null && track.alt > c.maxAlt) return false;
    if (typeof c.minSpeed === 'number' && track.speed != null && track.speed < c.minSpeed)
      return false;
    if (typeof c.maxSpeed === 'number' && track.speed != null && track.speed > c.maxSpeed)
      return false;
    return true;
  }

  private ruleMatchesAcars(rule: AdsbAlertRule, message: AcarsMessage): boolean {
    if (rule.target !== 'acars') return false;
    const c = rule.conditions;
    if (c.tailContains) {
      const tail = message.tail?.toLowerCase() ?? '';
      if (!tail.includes(c.tailContains.toLowerCase())) return false;
    }
    if (c.flightContains) {
      const flight = message.flight?.toLowerCase() ?? '';
      if (!flight.includes(c.flightContains.toLowerCase())) return false;
    }
    if (c.labelEquals) {
      if ((message.label ?? '').toLowerCase() !== c.labelEquals.toLowerCase()) return false;
    }
    if (c.textContains) {
      const text = message.text?.toLowerCase() ?? '';
      if (!text.includes(c.textContains.toLowerCase())) return false;
    }
    if (typeof c.minSignal === 'number' && message.signalLevel != null) {
      if (message.signalLevel < c.minSignal) return false;
    }
    if (typeof c.maxNoise === 'number' && message.noiseLevel != null) {
      if (message.noiseLevel > c.maxNoise) return false;
    }
    if (typeof c.freqEquals === 'number' && message.frequency != null) {
      if (Math.abs(message.frequency - c.freqEquals) > 0.5) return false;
    }
    return true;
  }

  private async dispatchAlert(
    rule: AdsbAlertRule,
    source: AdsbTrack | AcarsMessage,
    kind: 'adsb' | 'acars',
  ): Promise<void> {
    const isTrack = kind === 'adsb';
    const track = isTrack ? (source as AdsbTrack) : null;
    const acars = !isTrack ? (source as AcarsMessage) : null;
    const lat = track?.lat ?? acars?.lat ?? undefined;
    const lon = track?.lon ?? acars?.lon ?? undefined;
    const callsign = track?.callsign ?? acars?.flight ?? null;
    const icao = track?.icao ?? acars?.correlatedIcao ?? null;
    const reg = track?.reg ?? acars?.tail ?? null;
    const dep = track?.dep ?? null;
    const dest = track?.dest ?? null;
    const speed = track?.speed ?? null;
    const alt = track?.alt ?? null;
    const label = acars?.label ?? null;
    const freq = acars?.frequency ?? null;
    const signal = acars?.signalLevel ?? null;
    const noise = acars?.noiseLevel ?? null;

    const message = this.renderAlertMessage(rule, {
      callsign,
      icao,
      reg,
      dep,
      dest,
      speed,
      alt,
      label,
    });

    const mapStyle = {
      showOnMap: rule.showOnMap ?? true,
      color: rule.mapColor ?? null,
      label: rule.mapLabel ?? null,
      blink: rule.blink ?? false,
    };

    const alertId = randomUUID();
    this.gateway.emitEvent(
      {
        type: 'event.alert',
        category: `${kind}-alert`,
        level: rule.severity,
        id: alertId,
        message,
        siteId: this.localSiteId,
        lat,
        lon,
        data: {
          ruleId: rule.id,
          ruleName: rule.name,
          siteId: this.localSiteId,
          icao,
          callsign,
          reg,
          dep,
          dest,
          speed,
          alt,
          label,
          freq,
          signal,
          noise,
          mapStyle,
        },
        mapStyle,
      },
      { skipBus: false },
    );

    if (rule.webhookIds && rule.webhookIds.length > 0) {
      await this.webhookDispatcher.dispatchAlert(
        rule.webhookIds.map((webhookId) => ({ webhookId }) as never),
        {
          eventType: WebhookEventType.ALERT_TRIGGERED,
          event: 'alert.triggered',
          ruleId: rule.id,
          ruleName: rule.name,
          severity: rule.severity,
          message,
          lat: lat ?? null,
          lon: lon ?? null,
          payload: {
            callsign,
            icao,
            reg,
            dep,
            dest,
            speed,
            alt,
            label,
            freq,
            signal,
            noise,
            kind,
          },
          timestamp: new Date(),
        },
      );
    }

    if (rule.notifyEmail && rule.emailRecipients && rule.emailRecipients.length > 0) {
      const bodyLines = [
        message,
        `ICAO: ${icao ?? 'N/A'}`,
        `Callsign: ${callsign ?? 'N/A'}`,
        `Reg/Tail: ${reg ?? 'N/A'}`,
        dep ? `Departure: ${dep}` : null,
        dest ? `Destination: ${dest}` : null,
        speed != null ? `Speed: ${speed} kt` : null,
        alt != null ? `Altitude: ${alt} ft` : null,
        label ? `Label: ${label}` : null,
        freq != null ? `Freq: ${freq}` : null,
        signal != null ? `Signal: ${signal}` : null,
        noise != null ? `Noise: ${noise}` : null,
      ].filter(Boolean);
      const body = bodyLines.join('\n');
      await Promise.all(
        rule.emailRecipients.map((recipient) =>
          this.mailService
            .sendMail({
              to: recipient,
              subject: `[AHCC] ${kind.toUpperCase()} alert: ${rule.name}`,
              text: body,
            })
            .catch((error) => {
              this.logger.warn(
                `Failed sending alert email to ${recipient}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }),
        ),
      );
    }

    await this.logAlertEvent(rule, {
      message,
      lat,
      lon,
      payload: {
        callsign,
        icao,
        reg,
        dep,
        dest,
        speed,
        alt,
        label,
        freq,
        signal,
        noise,
        kind,
        mapStyle,
      },
    });
  }

  private renderAlertMessage(
    rule: AdsbAlertRule,
    ctx: {
      callsign?: string | null;
      icao?: string | null;
      reg?: string | null;
      dep?: string | null;
      dest?: string | null;
      speed?: number | null;
      alt?: number | null;
      label?: string | null;
    },
  ): string {
    const template =
      rule.messageTemplate?.trim() ||
      `Alert "${rule.name}" matched ${ctx.callsign ?? ctx.icao ?? ctx.reg ?? 'target'}`;
    const replacements: Record<string, string> = {
      callsign: ctx.callsign ?? '',
      icao: ctx.icao ?? '',
      reg: ctx.reg ?? '',
      dep: ctx.dep ?? '',
      dest: ctx.dest ?? '',
      speed: ctx.speed != null ? ctx.speed.toString() : '',
      alt: ctx.alt != null ? ctx.alt.toString() : '',
      label: ctx.label ?? '',
      rule: rule.name,
    };
    return template.replace(/\{(callsign|icao|reg|dep|dest|speed|alt|label|rule)\}/g, (_, key) => {
      return replacements[key as keyof typeof replacements] ?? '';
    });
  }

  private async logAlertEvent(
    rule: AdsbAlertRule,
    params: {
      message: string;
      lat?: number | null;
      lon?: number | null;
      payload: Record<string, unknown>;
    },
  ): Promise<void> {
    if (!rule.alertRuleId) return;
    try {
      await this.prisma.alertEvent.create({
        data: {
          ruleId: rule.alertRuleId,
          message: params.message,
          payload: params.payload as Prisma.InputJsonValue,
          triggeredAt: new Date(),
        },
      });
    } catch (error) {
      this.logger.warn(
        `Failed to log ADS-B/ACARS alert event: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async syncAlertRuleToDb(rule: AdsbAlertRule): Promise<string | null> {
    try {
      const mapStyle =
        rule.showOnMap !== undefined || rule.mapColor || rule.mapLabel || rule.blink
          ? {
              showOnMap: rule.showOnMap ?? true,
              color: rule.mapColor ?? null,
              icon: null,
              blink: rule.blink ?? false,
              label: rule.mapLabel ?? null,
            }
          : null;

      const result = await this.prisma.alertRule.upsert({
        where: { id: rule.alertRuleId ?? rule.id },
        create: {
          id: rule.alertRuleId ?? rule.id,
          name: rule.name,
          description: rule.description ?? null,
          scope: 'GLOBAL',
          severity: rule.severity,
          matchMode: 'ANY',
          isActive: rule.enabled,
          ouiPrefixes: [],
          ssids: [],
          channels: [],
          macAddresses: [],
          inventoryMacs: [],
          minRssi: null,
          maxRssi: null,
          notifyAudible: rule.notifyAudible ?? false,
          notifyVisual: rule.notifyVisual ?? true,
          notifyEmail: rule.notifyEmail ?? false,
          emailRecipients: rule.emailRecipients ?? [],
          messageTemplate: rule.messageTemplate ?? null,
          mapStyle: mapStyle ? (mapStyle as Prisma.InputJsonValue) : Prisma.JsonNull,
          webhooks: rule.webhookIds?.length
            ? {
                create: rule.webhookIds.map((webhookId) => ({
                  webhook: { connect: { id: webhookId } },
                })),
              }
            : undefined,
        },
        update: {
          name: rule.name,
          description: rule.description ?? null,
          severity: rule.severity,
          isActive: rule.enabled,
          notifyAudible: rule.notifyAudible ?? false,
          notifyVisual: rule.notifyVisual ?? true,
          notifyEmail: rule.notifyEmail ?? false,
          emailRecipients: rule.emailRecipients ?? [],
          messageTemplate: rule.messageTemplate ?? null,
          mapStyle: mapStyle ? (mapStyle as Prisma.InputJsonValue) : Prisma.JsonNull,
          webhooks: {
            deleteMany: {},
            ...(rule.webhookIds?.length
              ? {
                  create: rule.webhookIds.map((webhookId) => ({
                    webhook: { connect: { id: webhookId } },
                  })),
                }
              : {}),
          },
        },
      });
      return result.id;
    } catch (error) {
      this.logger.warn(
        `Failed to upsert ADS-B alert rule into DB: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  private async loadAlertRulesFromDisk(): Promise<void> {
    try {
      if (!existsSync(this.alertRulesPath)) {
        this.alertRules = [];
        return;
      }
      const raw = await readFile(this.alertRulesPath, 'utf8');
      const parsed = JSON.parse(raw) as AdsbAlertRule[];
      this.alertRules = Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      this.alertRules = [];
      this.logger.warn(
        `Failed to load ADS-B alert rules: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private async saveAlertRulesToDisk(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(this.alertRulesPath, JSON.stringify(this.alertRules, null, 2), 'utf8');
  }

  private async syncAllAlertRulesToDb(): Promise<void> {
    const updatedRules: AdsbAlertRule[] = [];
    for (const rule of this.alertRules) {
      const alertRuleId = await this.syncAlertRuleToDb(rule);
      updatedRules.push({ ...rule, alertRuleId });
    }
    this.alertRules = updatedRules;
    await this.saveAlertRulesToDisk();
  }
}
