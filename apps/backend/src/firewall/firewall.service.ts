import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  FirewallConfig,
  FirewallGeoMode,
  FirewallLogOutcome,
  FirewallPolicy,
  FirewallRule,
  FirewallRuleType,
  Prisma,
} from '@prisma/client';
import { Request } from 'express';
import * as geoip from 'geoip-lite';
import * as ipaddr from 'ipaddr.js';

import { BlockFirewallLogDto } from './dto/block-firewall-log.dto';
import { CreateFirewallRuleDto } from './dto/create-firewall-rule.dto';
import { ListFirewallLogsDto } from './dto/list-firewall-logs.dto';
import { UpdateFirewallConfigDto } from './dto/update-firewall-config.dto';
import {
  FirewallConfigResponse,
  FirewallLogResponse,
  FirewallOverview,
  FirewallRuleResponse,
} from './firewall.types';
import { PrismaService } from '../prisma/prisma.service';

interface AuthFailureState {
  count: number;
  first: number;
  last: number;
}

@Injectable()
export class FirewallService {
  private readonly logger = new Logger(FirewallService.name);
  private readonly authFailures = new Map<string, AuthFailureState>();
  private readonly localSiteId: string;
  private lastRuleCleanup = 0;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
  ) {
    this.localSiteId = configService.get<string>('site.id', 'default');
  }

  async handleRequest(req: Request): Promise<void> {
    await this.enforce({
      ip: this.getClientIp(req),
      path: req.path,
      method: req.method,
      userAgent: req.headers['user-agent'],
    });
  }

  async enforce(context: {
    ip: string | null | undefined;
    path: string;
    method: string;
    userAgent?: string;
  }): Promise<void> {
    const { ip, path, method, userAgent } = context;
    if (!ip) {
      return;
    }

    const config = await this.ensureConfig();
    if (!config.enabled) {
      return;
    }

    const normalizedIp = this.normalizeIp(ip);
    if (!normalizedIp) {
      return;
    }

    await this.cleanupExpiredRules();

    const allowList = config.ipAllowList ?? [];
    const isAllowedByList = allowList.length > 0 && this.isIpInList(normalizedIp, allowList);

    if (allowList.length > 0 && !isAllowedByList) {
      await this.logBlock({
        ip: normalizedIp,
        reason: 'IP not in allow list',
        path,
        method,
        userAgent,
      });
      throw new FirewallBlockedException('Access denied by firewall (allow list)');
    }

    if (this.isIpInList(normalizedIp, config.ipBlockList ?? [])) {
      await this.logBlock({
        ip: normalizedIp,
        reason: 'IP blocked by list',
        path,
        method,
        userAgent,
      });
      throw new FirewallBlockedException('Access denied by firewall (IP block list)');
    }

    if (isAllowedByList) {
      return;
    }

    const rule = await this.evaluateRules(normalizedIp);
    if (rule?.type === FirewallRuleType.ALLOW) {
      return;
    }
    if (rule) {
      await this.logBlock({
        ip: normalizedIp,
        reason: rule.reason ?? 'IP blocked by rule',
        path,
        method,
        ruleId: rule.id,
        userAgent,
      });
      throw new FirewallBlockedException('Access denied by firewall (rule)');
    }

    const country = this.lookupCountry(normalizedIp);
    if (this.shouldBlockByGeo(config, country)) {
      await this.logBlock({
        ip: normalizedIp,
        reason: 'Blocked by geo policy',
        path,
        method,
        country,
        outcome: FirewallLogOutcome.GEO_BLOCK,
        userAgent,
      });
      throw new FirewallBlockedException('Access denied by firewall (geo policy)');
    }

    if (config.defaultPolicy === FirewallPolicy.DENY) {
      await this.logBlock({
        ip: normalizedIp,
        reason: 'Default deny policy',
        path,
        method,
        country,
        outcome: FirewallLogOutcome.DEFAULT_DENY,
        userAgent,
      });
      throw new FirewallBlockedException('Access denied by firewall (default policy)');
    }
  }

  async getOverview(): Promise<FirewallOverview> {
    const [config, rules, totalLogs, blockedLast24h, authFailures24h] = await Promise.all([
      this.ensureConfig(),
      this.prisma.firewallRule.findMany({ orderBy: { createdAt: 'desc' } }),
      this.prisma.firewallLog.count(),
      this.prisma.firewallLog.count({
        where: {
          blocked: true,
          lastSeen: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      }),
      this.prisma.firewallLog.count({
        where: {
          outcome: FirewallLogOutcome.AUTH_FAILURE,
          lastSeen: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      }),
    ]);

    const responses = rules.map((rule) => this.mapRule(rule));
    return {
      config: this.mapConfig(config),
      rules: responses,
      stats: {
        totalRules: rules.length,
        totalBlockedRules: rules.filter((rule) => rule.type !== FirewallRuleType.ALLOW).length,
        totalLogs,
        blockedLast24h,
        authFailuresLast24h: authFailures24h,
      },
    };
  }

  async updateConfig(
    dto: UpdateFirewallConfigDto,
    actorId?: string,
  ): Promise<FirewallConfigResponse> {
    const existing = await this.prisma.firewallConfig.findUnique({ where: { id: 1 } });
    const updateData: Prisma.FirewallConfigUpdateInput = {};
    if (dto.enabled !== undefined) {
      updateData.enabled = dto.enabled;
    }
    if (dto.defaultPolicy !== undefined) {
      updateData.defaultPolicy = dto.defaultPolicy;
    }
    if (dto.geoMode !== undefined) {
      updateData.geoMode = dto.geoMode;
    }
    if (dto.allowedCountries !== undefined) {
      updateData.allowedCountries = this.normalizeCountryList(dto.allowedCountries);
    }
    if (dto.blockedCountries !== undefined) {
      updateData.blockedCountries = this.normalizeCountryList(dto.blockedCountries);
    }
    if (dto.ipAllowList !== undefined) {
      updateData.ipAllowList = this.normalizeIpList(dto.ipAllowList);
    }
    if (dto.ipBlockList !== undefined) {
      updateData.ipBlockList = this.normalizeIpList(dto.ipBlockList);
    }
    if (dto.failThreshold !== undefined) {
      updateData.failThreshold = dto.failThreshold;
    }
    if (dto.failWindowSeconds !== undefined) {
      updateData.failWindowSeconds = dto.failWindowSeconds;
    }
    if (dto.banDurationSeconds !== undefined) {
      updateData.banDurationSeconds = dto.banDurationSeconds;
    }

    const config = await this.prisma.firewallConfig.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        enabled: dto.enabled ?? true,
        defaultPolicy: dto.defaultPolicy ?? FirewallPolicy.ALLOW,
        geoMode: dto.geoMode ?? FirewallGeoMode.DISABLED,
        allowedCountries: this.normalizeCountryList(dto.allowedCountries),
        blockedCountries: this.normalizeCountryList(dto.blockedCountries),
        ipAllowList: this.normalizeIpList(dto.ipAllowList),
        ipBlockList: this.normalizeIpList(dto.ipBlockList),
        failThreshold: dto.failThreshold ?? 5,
        failWindowSeconds: dto.failWindowSeconds ?? 900,
        banDurationSeconds: dto.banDurationSeconds ?? 3600,
      },
      update: updateData,
    });

    await this.prisma.auditLog.create({
      data: {
        userId: actorId ?? null,
        action: 'FIREWALL_CONFIG_UPDATE',
        entity: 'FirewallConfig',
        entityId: '1',
        before: existing ? this.toFirewallAuditSnapshot(existing) : Prisma.JsonNull,
        after: this.toFirewallAuditSnapshot(config),
      },
    });

    return this.mapConfig(config);
  }

  async listRules(): Promise<FirewallRuleResponse[]> {
    await this.cleanupExpiredRules();
    const rules = await this.prisma.firewallRule.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return rules.map((rule) => this.mapRule(rule));
  }

  async createRule(dto: CreateFirewallRuleDto, createdBy?: string): Promise<FirewallRuleResponse> {
    const ip = this.normalizeIp(dto.ip);
    if (!ip) {
      throw new ForbiddenException('Invalid IP address');
    }

    if (dto.type === FirewallRuleType.ALLOW) {
      // Remove existing block rules for this IP to avoid conflicts.
      await this.prisma.firewallRule.deleteMany({
        where: { ip, type: { in: [FirewallRuleType.BLOCK, FirewallRuleType.TEMP_BLOCK] } },
      });
    }

    const expiresAt =
      dto.type !== FirewallRuleType.ALLOW && dto.durationSeconds
        ? new Date(Date.now() + dto.durationSeconds * 1000)
        : null;

    const rule = await this.prisma.firewallRule.create({
      data: {
        ip,
        type: dto.type,
        reason: dto.reason ?? null,
        expiresAt,
        createdBy: createdBy ?? null,
      },
    });

    return this.mapRule(rule);
  }

  async deleteRule(id: string): Promise<void> {
    await this.prisma.firewallRule.delete({
      where: { id },
    });
  }

  async listJailedRules(): Promise<FirewallRuleResponse[]> {
    await this.cleanupExpiredRules();
    const jailedRules = await this.prisma.firewallRule.findMany({
      where: { type: FirewallRuleType.TEMP_BLOCK },
      orderBy: { createdAt: 'desc' },
    });
    return jailedRules.map((rule) => this.mapRule(rule));
  }

  async unblockJailedRule(id: string, actorId?: string): Promise<void> {
    const rule = await this.prisma.firewallRule.findUnique({ where: { id } });
    if (!rule || rule.type !== FirewallRuleType.TEMP_BLOCK) {
      throw new NotFoundException('Jailed IP not found');
    }

    await this.prisma.firewallRule.delete({ where: { id } });

    await this.prisma.auditLog.create({
      data: {
        userId: actorId ?? null,
        action: 'FIREWALL_JAIL_RELEASE',
        entity: 'FirewallRule',
        entityId: id,
        before: {
          id: rule.id,
          ip: rule.ip,
          type: rule.type,
          reason: rule.reason ?? null,
          expiresAt: rule.expiresAt?.toISOString() ?? null,
        },
        after: Prisma.JsonNull,
      },
    });
  }

  async listLogs(dto: ListFirewallLogsDto): Promise<FirewallLogResponse[]> {
    const limit = dto.limit ?? 50;
    const where: Prisma.FirewallLogWhereInput = {};
    if (dto.outcome) {
      where.outcome = dto.outcome;
    }
    if (dto.onlyBlocked) {
      where.blocked = true;
    }
    if (dto.search) {
      where.OR = [
        { ip: { contains: dto.search, mode: 'insensitive' } },
        { reason: { contains: dto.search, mode: 'insensitive' } },
      ];
    }

    const logs = await this.prisma.firewallLog.findMany({
      where,
      orderBy: { lastSeen: 'desc' },
      take: limit,
    });
    return logs.map((log) => this.mapLog(log));
  }

  async blockFromLog(id: string, dto: BlockFirewallLogDto, createdBy?: string) {
    const log = await this.prisma.firewallLog.findUnique({ where: { id } });
    if (!log) {
      throw new ForbiddenException('Log entry not found');
    }
    return this.blockIp(log.ip, {
      type: dto.type ?? FirewallRuleType.BLOCK,
      reason: dto.reason ?? `Manual block from log ${id}`,
      durationSeconds: dto.durationSeconds,
      createdBy,
    });
  }

  async blockIp(
    ip: string,
    options: {
      type?: FirewallRuleType;
      reason?: string;
      durationSeconds?: number;
      createdBy?: string;
    } = {},
  ): Promise<FirewallRuleResponse> {
    const ruleDto: CreateFirewallRuleDto = {
      ip,
      type: options.type ?? FirewallRuleType.BLOCK,
      reason: options.reason,
      durationSeconds: options.durationSeconds,
    };
    return this.createRule(ruleDto, options.createdBy);
  }

  async registerAuthFailure(
    ip: string,
    context: { reason?: string; path?: string; userAgent?: string },
  ): Promise<void> {
    const normalizedIp = this.normalizeIp(ip);
    if (!normalizedIp) {
      return;
    }

    const config = await this.ensureConfig();
    const now = Date.now();
    const current = this.authFailures.get(normalizedIp);

    if (!current || now - current.first > config.failWindowSeconds * 1000) {
      this.authFailures.set(normalizedIp, { count: 1, first: now, last: now });
    } else {
      current.count += 1;
      current.last = now;
      this.authFailures.set(normalizedIp, current);
    }

    await this.logEvent({
      ip: normalizedIp,
      outcome: FirewallLogOutcome.AUTH_FAILURE,
      path: context.path,
      method: 'POST',
      reason: context.reason ?? 'Authentication failure',
      userAgent: context.userAgent,
      blocked: false,
    });

    const state = this.authFailures.get(normalizedIp);
    if (state && state.count >= config.failThreshold) {
      this.logger.warn(`Blocking IP ${normalizedIp} due to repeated authentication failures.`);
      const rule = await this.blockIp(normalizedIp, {
        type: FirewallRuleType.TEMP_BLOCK,
        reason: 'Too many failed login attempts',
        durationSeconds: config.banDurationSeconds,
        createdBy: 'system',
      });
      this.authFailures.delete(normalizedIp);
      await this.logBlock({
        ip: normalizedIp,
        reason: 'Too many failed login attempts',
        path: context.path ?? '/auth/login',
        method: 'POST',
        ruleId: rule.id,
        country: this.lookupCountry(normalizedIp),
        userAgent: context.userAgent,
      });
    }
  }

  async registerAuthSuccess(
    ip: string,
    context: { path?: string; userAgent?: string; country?: string } = {},
  ): Promise<void> {
    const normalizedIp = this.normalizeIp(ip);
    if (!normalizedIp) {
      return;
    }
    this.authFailures.delete(normalizedIp);
    await this.logEvent({
      ip: normalizedIp,
      outcome: FirewallLogOutcome.AUTH_SUCCESS,
      path: context.path,
      method: 'POST',
      blocked: false,
      reason: 'Authentication success',
      userAgent: context.userAgent,
      country: context.country,
    });
  }

  getClientIp(req?: Request | null): string | null {
    if (!req) {
      return null;
    }
    const candidate =
      req.ip ||
      (req.connection && 'remoteAddress' in req.connection
        ? req.connection.remoteAddress
        : undefined) ||
      (req.socket && 'remoteAddress' in req.socket ? req.socket.remoteAddress : undefined) ||
      undefined;
    return this.normalizeIp(candidate ?? null);
  }

  private async ensureConfig(): Promise<FirewallConfig> {
    return this.prisma.firewallConfig.upsert({
      where: { id: 1 },
      create: {
        id: 1,
      },
      update: {},
    });
  }

  private async evaluateRules(ip: string): Promise<FirewallRule | null> {
    const rules = await this.prisma.firewallRule.findMany({
      where: { ip },
      orderBy: { createdAt: 'desc' },
    });
    const now = new Date();
    for (const rule of rules) {
      if (rule.expiresAt && rule.expiresAt < now) {
        await this.prisma.firewallRule.delete({ where: { id: rule.id } });
        continue;
      }
      if (rule.type === FirewallRuleType.ALLOW) {
        return rule;
      }
      if (rule.type === FirewallRuleType.BLOCK || rule.type === FirewallRuleType.TEMP_BLOCK) {
        return rule;
      }
    }
    return null;
  }

  private shouldBlockByGeo(config: FirewallConfig, country?: string | null): boolean {
    if (config.geoMode === FirewallGeoMode.DISABLED) {
      return false;
    }
    const normalizedCountry = country?.toUpperCase();
    if (config.geoMode === FirewallGeoMode.ALLOW_LIST) {
      if (!config.allowedCountries || config.allowedCountries.length === 0) {
        return false;
      }
      if (!normalizedCountry) {
        return false;
      }
      return !config.allowedCountries.includes(normalizedCountry);
    }
    if (config.geoMode === FirewallGeoMode.BLOCK_LIST) {
      if (!normalizedCountry) {
        return false;
      }
      return config.blockedCountries.includes(normalizedCountry);
    }
    return false;
  }

  lookupCountry(ip: string): string | undefined {
    try {
      const lookup = geoip.lookup(ip);
      return lookup?.country?.toUpperCase();
    } catch (error) {
      this.logger.warn(`Unable to resolve geo IP for ${ip}: ${error}`);
      return undefined;
    }
  }

  private normalizeCountryList(values?: string[] | null): string[] {
    if (!values) {
      return [];
    }
    const seen = new Set<string>();
    const normalized: string[] = [];
    values.forEach((value) => {
      const code = value.trim().toUpperCase();
      if (/^[A-Z]{2}$/.test(code) && !seen.has(code)) {
        seen.add(code);
        normalized.push(code);
      }
    });
    return normalized;
  }

  private normalizeIpList(values?: string[] | null): string[] {
    if (!values) {
      return [];
    }
    const seen = new Set<string>();
    const normalized: string[] = [];
    values.forEach((value) => {
      const trimmed = value.trim();
      if (!trimmed) {
        return;
      }
      try {
        let canonical: string;
        if (trimmed.includes('/')) {
          const [addr, prefix] = ipaddr.parseCIDR(trimmed);
          const normalizedAddr = this.normalizeParsedAddress(addr);
          canonical = `${this.addressToString(normalizedAddr)}/${prefix}`;
        } else {
          const addr = this.normalizeParsedAddress(ipaddr.parse(trimmed));
          canonical = this.addressToString(addr);
        }
        if (!seen.has(canonical)) {
          seen.add(canonical);
          normalized.push(canonical);
        }
      } catch (error) {
        this.logger.warn(`Ignoring invalid IP entry "${trimmed}": ${error}`);
      }
    });
    return normalized;
  }

  private addressToString(addr: ipaddr.IPv4 | ipaddr.IPv6): string {
    return addr.toString();
  }

  private normalizeParsedAddress(addr: ipaddr.IPv4 | ipaddr.IPv6): ipaddr.IPv4 | ipaddr.IPv6 {
    if (addr.kind() === 'ipv6' && (addr as ipaddr.IPv6).isIPv4MappedAddress()) {
      return (addr as ipaddr.IPv6).toIPv4Address();
    }
    return addr;
  }

  private isIpInList(ip: string, list: string[]): boolean {
    if (!list || list.length === 0) {
      return false;
    }
    try {
      const parsedIp = this.normalizeParsedAddress(ipaddr.parse(ip));
      const ipString = this.addressToString(parsedIp);
      for (const raw of list) {
        const entry = raw.trim();
        if (!entry) {
          continue;
        }
        if (entry.includes('/')) {
          const [network, prefix] = ipaddr.parseCIDR(entry);
          const normalizedNetwork = this.normalizeParsedAddress(network);
          if (normalizedNetwork.kind() !== parsedIp.kind()) {
            continue;
          }
          if (parsedIp.match([normalizedNetwork, prefix])) {
            return true;
          }
        } else if (entry === ipString) {
          return true;
        }
      }
    } catch (error) {
      this.logger.warn(`Unable to evaluate IP list for ${ip}: ${error}`);
    }
    return false;
  }

  private normalizeIp(ip: string | null | undefined): string | null {
    if (!ip) {
      return null;
    }
    const trimmed = ip.trim();
    try {
      const parsed = this.normalizeParsedAddress(ipaddr.parse(trimmed));
      return this.addressToString(parsed);
    } catch (error) {
      this.logger.warn(`Failed to normalize IP "${ip}": ${error}`);
      return null;
    }
  }

  private async logBlock(details: {
    ip: string;
    reason: string;
    path: string;
    method: string;
    outcome?: FirewallLogOutcome;
    country?: string;
    ruleId?: string;
    userAgent?: string;
  }): Promise<void> {
    await this.logEvent({
      ip: details.ip,
      outcome: details.outcome ?? FirewallLogOutcome.BLOCKED,
      path: details.path,
      method: details.method,
      reason: details.reason,
      country: details.country,
      ruleId: details.ruleId,
      blocked: true,
      userAgent: details.userAgent,
    });
  }

  private async logEvent(event: {
    ip: string;
    outcome: FirewallLogOutcome;
    path?: string;
    method?: string;
    ruleId?: string | null;
    reason?: string;
    country?: string;
    blocked?: boolean;
    userAgent?: string;
  }): Promise<void> {
    const path = event.path ? event.path.substring(0, 128) : '*';
    const method = event.method ? event.method.toUpperCase().substring(0, 16) : 'UNKNOWN';

    await this.prisma.firewallLog.upsert({
      where: {
        ip_outcome_path: {
          ip: event.ip,
          outcome: event.outcome,
          path,
        },
      },
      create: {
        ip: event.ip,
        outcome: event.outcome,
        path,
        method,
        ruleId: event.ruleId ?? null,
        reason: event.reason ?? null,
        country: event.country ?? null,
        blocked: event.blocked ?? false,
        siteId: this.localSiteId,
        userAgent: event.userAgent ?? null,
      },
      update: {
        attempts: { increment: 1 },
        lastSeen: new Date(),
        method,
        ruleId: event.ruleId ?? null,
        reason: event.reason ?? null,
        country: event.country ?? null,
        blocked: event.blocked ?? false,
        userAgent: event.userAgent ?? null,
        siteId: this.localSiteId,
      },
    });
  }

  private mapConfig(config: FirewallConfig): FirewallConfigResponse {
    return {
      enabled: config.enabled,
      defaultPolicy: config.defaultPolicy,
      geoMode: config.geoMode,
      allowedCountries: config.allowedCountries ?? [],
      blockedCountries: config.blockedCountries ?? [],
      ipAllowList: config.ipAllowList ?? [],
      ipBlockList: config.ipBlockList ?? [],
      failThreshold: config.failThreshold,
      failWindowSeconds: config.failWindowSeconds,
      banDurationSeconds: config.banDurationSeconds,
      updatedAt: config.updatedAt.toISOString(),
    };
  }

  private mapRule(rule: FirewallRule): FirewallRuleResponse {
    return {
      id: rule.id,
      ip: rule.ip,
      type: rule.type,
      reason: rule.reason ?? null,
      expiresAt: rule.expiresAt ? rule.expiresAt.toISOString() : null,
      createdBy: rule.createdBy ?? null,
      createdAt: rule.createdAt.toISOString(),
      updatedAt: rule.updatedAt.toISOString(),
    };
  }

  private mapLog(log: Prisma.FirewallLogGetPayload<Record<string, never>>): FirewallLogResponse {
    return {
      id: log.id,
      ip: log.ip,
      country: log.country ?? null,
      path: log.path,
      method: log.method,
      outcome: log.outcome,
      ruleId: log.ruleId ?? null,
      attempts: log.attempts,
      firstSeen: log.firstSeen.toISOString(),
      lastSeen: log.lastSeen.toISOString(),
      blocked: log.blocked,
      reason: log.reason ?? null,
      userAgent: log.userAgent ?? null,
    };
  }

  private toFirewallAuditSnapshot(config: FirewallConfig) {
    return {
      enabled: config.enabled,
      defaultPolicy: config.defaultPolicy,
      geoMode: config.geoMode,
      allowedCountries: config.allowedCountries ?? [],
      blockedCountries: config.blockedCountries ?? [],
      ipAllowList: config.ipAllowList ?? [],
      ipBlockList: config.ipBlockList ?? [],
      failThreshold: config.failThreshold,
      failWindowSeconds: config.failWindowSeconds,
      banDurationSeconds: config.banDurationSeconds,
    };
  }

  private async cleanupExpiredRules(): Promise<void> {
    const now = Date.now();
    if (now - this.lastRuleCleanup < 60_000) {
      return;
    }
    this.lastRuleCleanup = now;
    await this.prisma.firewallRule.deleteMany({
      where: {
        expiresAt: { lt: new Date() },
      },
    });
  }
}
export class FirewallBlockedException extends ForbiddenException {
  constructor(message: string) {
    super(message);
  }
}
