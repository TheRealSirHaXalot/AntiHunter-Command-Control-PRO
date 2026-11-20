import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AlarmLevel, AlertRuleMatchMode, AlertRuleScope, Prisma, Role } from '@prisma/client';

import { AlertRuleDto, AlertRuleEventDto, AlertRuleMapStyle } from './alert-rule.dto';
import { AlertRuleMapStyleDto, CreateAlertRuleDto } from './dto/create-alert-rule.dto';
import { ListAlertEventsDto } from './dto/list-alert-events.dto';
import { ListAlertRulesDto } from './dto/list-alert-rules.dto';
import { UpdateAlertRuleDto } from './dto/update-alert-rule.dto';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeMac } from '../utils/mac';

type AlertRuleEntity = Prisma.AlertRuleGetPayload<{
  include: typeof AlertRulesService.ruleInclude;
}>;

@Injectable()
export class AlertRulesService {
  private readonly logger = new Logger(AlertRulesService.name);
  static readonly ruleInclude = {
    owner: {
      select: { id: true, email: true, firstName: true, lastName: true },
    },
  } as const;

  constructor(private readonly prisma: PrismaService) {}

  async listRules(userId: string, role: Role, query: ListAlertRulesDto): Promise<AlertRuleDto[]> {
    const filters: Prisma.AlertRuleWhereInput[] = [];
    const visibilityFilter = this.buildVisibilityFilter(
      userId,
      role,
      query.scope,
      query.includeAll,
    );
    if (visibilityFilter) {
      filters.push(visibilityFilter);
    }

    if (query.scope && role === Role.ADMIN && query.includeAll) {
      filters.push({ scope: query.scope });
    }

    if (!query.includeInactive) {
      filters.push({ isActive: true });
    }

    if (query.ownerId && role === Role.ADMIN) {
      filters.push({ ownerId: query.ownerId });
    }

    if (query.search?.trim()) {
      const term = query.search.trim();
      filters.push({
        OR: [
          { name: { contains: term, mode: Prisma.QueryMode.insensitive } },
          { description: { contains: term, mode: Prisma.QueryMode.insensitive } },
        ],
      });
    }

    const where =
      filters.length > 0
        ? {
            AND: filters,
          }
        : undefined;

    const rules = await this.prisma.alertRule.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { name: 'asc' }],
      include: AlertRulesService.ruleInclude,
    });

    return rules.map((rule) => this.toDto(rule));
  }

  async getRule(id: string, userId: string, role: Role): Promise<AlertRuleDto> {
    const entity = await this.findRuleOrThrow(id);
    this.ensureAccess(entity, userId, role, false);
    return this.toDto(entity);
  }

  async createRule(userId: string, role: Role, dto: CreateAlertRuleDto): Promise<AlertRuleDto> {
    const scope = dto.scope ?? AlertRuleScope.PERSONAL;
    if (scope === AlertRuleScope.GLOBAL && role !== Role.ADMIN) {
      throw new ForbiddenException('GLOBAL_RULE_REQUIRES_ADMIN');
    }

    const {
      ouiPrefixes,
      ssids,
      channels,
      macAddresses,
      inventoryMacs,
      minRssi,
      maxRssi,
      notifyAudible,
      notifyVisual,
      notifyEmail,
      emailRecipients,
      mapStyle,
      messageTemplate,
    } = await this.sanitizeRuleCollections(dto, null);

    const ownerId = scope === AlertRuleScope.PERSONAL ? userId : null;

    const created = await this.prisma.alertRule.create({
      data: {
        name: dto.name.trim(),
        description: this.cleanDescription(dto.description),
        scope,
        severity: dto.severity ?? AlarmLevel.ALERT,
        matchMode: dto.matchMode ?? AlertRuleMatchMode.ANY,
        isActive: dto.isActive ?? true,
        ownerId,
        ouiPrefixes,
        ssids,
        channels,
        macAddresses,
        inventoryMacs,
        minRssi,
        maxRssi,
        notifyAudible,
        notifyVisual,
        notifyEmail,
        emailRecipients,
        messageTemplate,
        mapStyle: mapStyle ? (mapStyle as Prisma.InputJsonValue) : Prisma.JsonNull,
      },
      include: AlertRulesService.ruleInclude,
    });

    this.logger.log(`Alert rule ${created.id} created by ${userId}`);
    return this.toDto(created);
  }

  async updateRule(
    id: string,
    userId: string,
    role: Role,
    dto: UpdateAlertRuleDto,
  ): Promise<AlertRuleDto> {
    const existing = await this.findRuleOrThrow(id);
    this.ensureAccess(existing, userId, role, true);

    const updatedScope = dto.scope ?? existing.scope;
    if (updatedScope === AlertRuleScope.GLOBAL && role !== Role.ADMIN) {
      throw new ForbiddenException('GLOBAL_RULE_REQUIRES_ADMIN');
    }

    const ownerId =
      updatedScope === AlertRuleScope.PERSONAL
        ? (existing.ownerId ?? userId)
        : dto.scope !== undefined
          ? null
          : existing.ownerId;

    const {
      ouiPrefixes,
      ssids,
      channels,
      macAddresses,
      inventoryMacs,
      minRssi,
      maxRssi,
      notifyAudible,
      notifyVisual,
      notifyEmail,
      emailRecipients,
      mapStyle,
      messageTemplate,
    } = await this.sanitizeRuleCollections(dto, existing);

    const updated = await this.prisma.alertRule.update({
      where: { id },
      data: {
        name: dto.name?.trim() ?? existing.name,
        description:
          dto.description !== undefined
            ? this.cleanDescription(dto.description)
            : existing.description,
        scope: updatedScope,
        severity: dto.severity ?? existing.severity,
        matchMode: dto.matchMode ?? existing.matchMode,
        isActive: dto.isActive ?? existing.isActive,
        ownerId,
        ouiPrefixes,
        ssids,
        channels,
        macAddresses,
        inventoryMacs,
        minRssi,
        maxRssi,
        notifyAudible,
        notifyVisual,
        notifyEmail,
        emailRecipients,
        messageTemplate,
        mapStyle:
          mapStyle !== undefined
            ? mapStyle
              ? (mapStyle as Prisma.InputJsonValue)
              : Prisma.JsonNull
            : (existing.mapStyle ?? Prisma.JsonNull),
      },
      include: AlertRulesService.ruleInclude,
    });

    this.logger.log(`Alert rule ${id} updated by ${userId}`);
    return this.toDto(updated);
  }

  async deleteRule(id: string, userId: string, role: Role): Promise<{ deleted: boolean }> {
    const existing = await this.findRuleOrThrow(id);
    this.ensureAccess(existing, userId, role, true);
    await this.prisma.alertRule.delete({ where: { id } });
    this.logger.log(`Alert rule ${id} deleted by ${userId}`);
    return { deleted: true };
  }

  async listEvents(
    userId: string,
    role: Role,
    query: ListAlertEventsDto,
  ): Promise<AlertRuleEventDto[]> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
    const where: Prisma.AlertEventWhereInput = {};

    if (query.ruleId) {
      const rule = await this.findRuleOrThrow(query.ruleId);
      this.ensureAccess(rule, userId, role, false);
      where.ruleId = query.ruleId;
    } else {
      const visibility = this.buildVisibilityFilter(userId, role, undefined, false);
      if (visibility) {
        where.rule = visibility;
      }
    }

    const events = await this.prisma.alertEvent.findMany({
      where,
      orderBy: { triggeredAt: 'desc' },
      take: limit,
      include: {
        rule: {
          select: {
            id: true,
            name: true,
            severity: true,
          },
        },
      },
    });

    return events.map((event) => ({
      id: event.id,
      ruleId: event.ruleId,
      ruleName: event.rule.name,
      severity: event.rule.severity,
      message: event.message,
      nodeId: event.nodeId,
      mac: event.mac,
      ssid: event.ssid,
      channel: event.channel,
      rssi: event.rssi,
      matchedCriteria: this.extractMatchedCriteria(event.payload),
      payload: this.toPlainPayload(event.payload),
      triggeredAt: event.triggeredAt,
    }));
  }

  async clearEvents(userId: string, role: Role, ruleId?: string): Promise<{ deleted: number }> {
    const where: Prisma.AlertEventWhereInput = {};
    if (ruleId) {
      const rule = await this.findRuleOrThrow(ruleId);
      this.ensureAccess(rule, userId, role, true);
      where.ruleId = ruleId;
    } else if (role !== Role.ADMIN) {
      where.rule = { ownerId: userId, scope: AlertRuleScope.PERSONAL };
    }
    const result = await this.prisma.alertEvent.deleteMany({ where });
    return { deleted: result.count };
  }

  private async findRuleOrThrow(id: string): Promise<AlertRuleEntity> {
    const rule = await this.prisma.alertRule.findUnique({
      where: { id },
      include: AlertRulesService.ruleInclude,
    });
    if (!rule) {
      throw new NotFoundException(`Alert rule ${id} not found`);
    }
    return rule;
  }

  private ensureAccess(
    rule: AlertRuleEntity,
    userId: string,
    role: Role,
    requireWrite: boolean,
  ): void {
    if (role === Role.ADMIN) {
      return;
    }
    if (rule.scope === AlertRuleScope.GLOBAL) {
      if (requireWrite) {
        throw new ForbiddenException('GLOBAL_RULE_MODIFICATION_REQUIRES_ADMIN');
      }
      return;
    }
    if (rule.ownerId !== userId) {
      throw new ForbiddenException('INSUFFICIENT_RULE_ACCESS');
    }
  }

  private buildVisibilityFilter(
    userId: string,
    role: Role,
    scope?: AlertRuleScope,
    includeAll?: boolean,
  ): Prisma.AlertRuleWhereInput | undefined {
    if (role === Role.ADMIN && includeAll) {
      return undefined;
    }
    if (role === Role.ADMIN) {
      return scope ? { scope } : undefined;
    }

    if (scope === AlertRuleScope.PERSONAL) {
      return { ownerId: userId };
    }
    if (scope === AlertRuleScope.GLOBAL) {
      return { scope: AlertRuleScope.GLOBAL };
    }
    return {
      OR: [{ scope: AlertRuleScope.GLOBAL }, { ownerId: userId }],
    };
  }

  private async sanitizeRuleCollections(
    dto: CreateAlertRuleDto | UpdateAlertRuleDto,
    existing: AlertRuleEntity | null,
  ) {
    const nextOui =
      dto.ouiPrefixes !== undefined
        ? this.normalizeOuiList(dto.ouiPrefixes)
        : (existing?.ouiPrefixes ?? []);
    const nextSsids =
      dto.ssids !== undefined ? this.normalizeStringArray(dto.ssids) : (existing?.ssids ?? []);
    const nextChannels =
      dto.channels !== undefined
        ? this.normalizeChannelArray(dto.channels)
        : (existing?.channels ?? []);

    const incomingManualMacs =
      dto.macAddresses !== undefined
        ? this.normalizeMacArray(dto.macAddresses)
        : (existing?.macAddresses ?? []);
    const incomingInventoryMacs =
      dto.inventoryMacs !== undefined
        ? this.normalizeMacArray(dto.inventoryMacs)
        : (existing?.inventoryMacs ?? []);

    if (dto.inventoryMacs !== undefined && incomingInventoryMacs.length > 0) {
      await this.ensureInventoryDevicesExist(incomingInventoryMacs);
    }

    const combinedMacs = this.mergeUnique(incomingManualMacs, incomingInventoryMacs);

    const nextMinRssi =
      dto.minRssi !== undefined ? this.normalizeRssi(dto.minRssi) : (existing?.minRssi ?? null);
    const nextMaxRssi =
      dto.maxRssi !== undefined ? this.normalizeRssi(dto.maxRssi) : (existing?.maxRssi ?? null);
    this.validateRssiRange(nextMinRssi, nextMaxRssi);

    const notifyAudible = dto.notifyAudible ?? existing?.notifyAudible ?? true;
    const notifyVisual = dto.notifyVisual ?? existing?.notifyVisual ?? true;
    const notifyEmail = dto.notifyEmail ?? existing?.notifyEmail ?? false;
    const nextEmails =
      dto.emailRecipients !== undefined
        ? notifyEmail
          ? this.normalizeEmailArray(dto.emailRecipients)
          : []
        : notifyEmail
          ? (existing?.emailRecipients ?? [])
          : [];

    const mapStyle =
      dto.mapStyle !== undefined
        ? this.sanitizeMapStyle(dto.mapStyle)
        : existing
          ? this.parseMapStyle(existing.mapStyle)
          : undefined;

    const messageTemplate =
      dto.messageTemplate !== undefined
        ? this.cleanMessage(dto.messageTemplate)
        : (existing?.messageTemplate ?? null);

    return {
      ouiPrefixes: nextOui,
      ssids: nextSsids,
      channels: nextChannels,
      macAddresses: combinedMacs,
      inventoryMacs: incomingInventoryMacs,
      minRssi: nextMinRssi,
      maxRssi: nextMaxRssi,
      notifyAudible,
      notifyVisual,
      notifyEmail,
      emailRecipients: nextEmails,
      mapStyle,
      messageTemplate,
    };
  }

  private normalizeOuiList(values?: string[]): string[] {
    if (!values?.length) {
      return [];
    }
    const normalized = new Set<string>();
    for (const value of values) {
      if (!value) continue;
      const cleaned = value.replace(/[^a-fA-F0-9]/g, '').toUpperCase();
      if (cleaned.length < 6) continue;
      const prefix = cleaned.slice(0, 6);
      const formatted = prefix.match(/.{2}/g)?.join(':');
      if (formatted) {
        normalized.add(formatted);
      }
    }
    return Array.from(normalized.values());
  }

  private normalizeStringArray(values?: string[]): string[] {
    if (!values?.length) {
      return [];
    }
    const normalized = new Set<string>();
    for (const value of values) {
      const trimmed = value?.trim();
      if (trimmed) {
        normalized.add(trimmed);
      }
    }
    return Array.from(normalized.values());
  }

  private normalizeChannelArray(values?: number[]): number[] {
    if (!values?.length) {
      return [];
    }
    const normalized = new Set<number>();
    for (const value of values) {
      if (typeof value !== 'number') continue;
      const parsed = Math.round(value);
      if (Number.isFinite(parsed) && parsed >= 0) {
        normalized.add(parsed);
      }
    }
    return Array.from(normalized.values()).sort((a, b) => a - b);
  }

  private normalizeMacArray(values?: string[]): string[] {
    if (!values?.length) {
      return [];
    }
    const normalized = new Set<string>();
    for (const value of values) {
      if (!value) continue;
      try {
        normalized.add(normalizeMac(value));
      } catch {
        throw new BadRequestException(`Invalid MAC address: ${value}`);
      }
    }
    return Array.from(normalized.values());
  }

  private async ensureInventoryDevicesExist(macs: string[]): Promise<void> {
    if (!macs.length) {
      return;
    }
    const found = await this.prisma.inventoryDevice.findMany({
      where: { mac: { in: macs } },
      select: { mac: true },
    });
    const foundSet = new Set(found.map((entry) => entry.mac));
    const missing = macs.filter((mac) => !foundSet.has(mac));
    if (missing.length > 0) {
      throw new BadRequestException(`Inventory devices not found: ${missing.join(', ')}`);
    }
  }

  private normalizeRssi(value?: number | null): number | null {
    if (value === undefined || value === null) {
      return null;
    }
    if (!Number.isFinite(value)) {
      throw new BadRequestException('RSSI must be a finite number');
    }
    const clamped = Math.max(-150, Math.min(50, Math.round(value)));
    return clamped;
  }

  private validateRssiRange(min?: number | null, max?: number | null): void {
    if (min != null && max != null && min > max) {
      throw new BadRequestException('minRssi cannot be greater than maxRssi');
    }
  }

  private normalizeEmailArray(values?: string[]): string[] {
    if (!values?.length) {
      return [];
    }
    const normalized = new Set<string>();
    for (const value of values) {
      const trimmed = value?.trim();
      if (!trimmed) continue;
      const atIndex = trimmed.indexOf('@');
      const lastDotIndex = trimmed.lastIndexOf('.');
      if (
        atIndex <= 0 ||
        lastDotIndex <= atIndex + 1 ||
        lastDotIndex >= trimmed.length - 1 ||
        trimmed.includes(' ')
      ) {
        throw new BadRequestException(`Invalid email recipient: ${trimmed}`);
      }
      normalized.add(trimmed.toLowerCase());
    }
    return Array.from(normalized.values());
  }

  private sanitizeMapStyle(
    value?: AlertRuleMapStyleDto | null,
  ): AlertRuleMapStyle | null | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (!value) {
      return null;
    }
    const result: AlertRuleMapStyle = {};
    if (typeof value.showOnMap === 'boolean') {
      result.showOnMap = value.showOnMap;
    }
    if (typeof value.color === 'string' && value.color.trim()) {
      result.color = value.color.trim();
    }
    if (typeof value.icon === 'string' && value.icon.trim()) {
      result.icon = value.icon.trim();
    }
    if (typeof value.blink === 'boolean') {
      result.blink = value.blink;
    }
    if (typeof value.label === 'string' && value.label.trim()) {
      result.label = value.label.trim();
    }
    return Object.keys(result).length > 0 ? result : null;
  }

  private parseMapStyle(value: Prisma.JsonValue | null): AlertRuleMapStyle | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    const mapStyle: AlertRuleMapStyle = {};
    if (typeof record.showOnMap === 'boolean') {
      mapStyle.showOnMap = record.showOnMap;
    }
    if (typeof record.color === 'string') {
      mapStyle.color = record.color;
    }
    if (typeof record.icon === 'string') {
      mapStyle.icon = record.icon;
    }
    if (typeof record.blink === 'boolean') {
      mapStyle.blink = record.blink;
    }
    if (typeof record.label === 'string') {
      mapStyle.label = record.label;
    }
    return Object.keys(mapStyle).length > 0 ? mapStyle : null;
  }

  private mergeUnique(manual: string[], inventory: string[]): string[] {
    const merged = new Set<string>(manual);
    inventory.forEach((mac) => merged.add(mac));
    return Array.from(merged.values());
  }

  private toPlainPayload(value: Prisma.JsonValue | null): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  }

  private extractMatchedCriteria(value: Prisma.JsonValue | null): string[] | undefined {
    const payload = this.toPlainPayload(value);
    if (!payload) {
      return undefined;
    }
    const criteria = payload.matchedCriteria;
    if (Array.isArray(criteria)) {
      return criteria
        .map((entry) => (typeof entry === 'string' ? entry : null))
        .filter((entry): entry is string => Boolean(entry));
    }
    return undefined;
  }

  private cleanDescription(value?: string | null): string | null {
    if (!value) {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  }

  private cleanMessage(value?: string | null): string | null {
    if (!value) {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length ? trimmed.slice(0, 512) : null;
  }

  private toDto(rule: AlertRuleEntity): AlertRuleDto {
    return {
      id: rule.id,
      name: rule.name,
      description: rule.description,
      scope: rule.scope,
      severity: rule.severity,
      matchMode: rule.matchMode,
      isActive: rule.isActive,
      ouiPrefixes: [...rule.ouiPrefixes],
      ssids: [...rule.ssids],
      channels: [...rule.channels],
      macAddresses: [...rule.macAddresses],
      inventoryMacs: [...rule.inventoryMacs],
      minRssi: rule.minRssi,
      maxRssi: rule.maxRssi,
      notifyAudible: rule.notifyAudible,
      notifyVisual: rule.notifyVisual,
      notifyEmail: rule.notifyEmail,
      emailRecipients: [...rule.emailRecipients],
      messageTemplate: rule.messageTemplate,
      mapStyle: this.parseMapStyle(rule.mapStyle),
      createdAt: rule.createdAt,
      updatedAt: rule.updatedAt,
      lastTriggeredAt: rule.lastTriggeredAt,
      owner: rule.owner
        ? {
            id: rule.owner.id,
            email: rule.owner.email,
            firstName: rule.owner.firstName,
            lastName: rule.owner.lastName,
          }
        : null,
    };
  }
}
