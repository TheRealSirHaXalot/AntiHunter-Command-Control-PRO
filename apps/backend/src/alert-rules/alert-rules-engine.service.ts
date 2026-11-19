import { Injectable, Logger } from '@nestjs/common';
import { AlertRuleMatchMode, Prisma } from '@prisma/client';
import type { AlertRule } from '@prisma/client';

import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import type { SerialTargetDetected } from '../serial/serial.types';
import { extractOui, normalizeMac } from '../utils/mac';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';
import { WebhookEventType } from '../webhooks/webhook-event-type';
import { CommandCenterGateway } from '../ws/command-center.gateway';

type AlertRuleWithHooks = Prisma.AlertRuleGetPayload<Record<string, never>>;

interface TargetDetectionContext {
  event: SerialTargetDetected;
  siteId?: string | null;
  nodeName?: string | null;
  nodeLat?: number;
  nodeLon?: number;
  lat?: number;
  lon?: number;
  timestamp: Date;
}

interface MatchedRuleResult {
  rule: AlertRuleWithHooks;
  matchedCriteria: string[];
  normalizedMac: string;
  oui: string;
  ssid?: string;
}

interface AlertRuleMapStyle {
  showOnMap?: boolean;
  color?: string | null;
  icon?: string | null;
  blink?: boolean;
  label?: string | null;
}

@Injectable()
export class AlertRulesEngineService {
  private readonly logger = new Logger(AlertRulesEngineService.name);
  private readonly cacheTtlMs = 5_000;
  private cachedRules: AlertRuleWithHooks[] = [];
  private cacheExpiresAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: CommandCenterGateway,
    private readonly mailService: MailService,
    private readonly webhookDispatcher: WebhookDispatcherService,
  ) {}

  async evaluateTargetDetection(context: TargetDetectionContext): Promise<void> {
    if (!context?.event?.mac) {
      return;
    }

    const normalizedMac = this.safeNormalizeMac(context.event.mac);
    if (!normalizedMac) {
      return;
    }

    const ssid = context.event.name?.trim() || undefined;
    const oui = extractOui(normalizedMac);
    const rules = await this.getActiveRules();
    if (rules.length === 0) {
      return;
    }

    const matches: MatchedRuleResult[] = [];
    for (const rule of rules) {
      const match = this.matchRule(rule, {
        normalizedMac,
        oui,
        ssid,
        channel: context.event.channel,
        rssi: context.event.rssi,
      });
      if (match.matched) {
        matches.push({
          rule,
          matchedCriteria: match.criteria,
          normalizedMac,
          oui,
          ssid,
        });
      }
    }

    if (matches.length === 0) {
      return;
    }

    await Promise.all(matches.map((match) => this.handleMatch(match, context)));
  }

  private async handleMatch(match: MatchedRuleResult, context: TargetDetectionContext) {
    const { rule, matchedCriteria, normalizedMac, ssid } = match;
    const timestamp = context.timestamp ?? new Date();
    const channel = typeof context.event.channel === 'number' ? context.event.channel : null;
    const rssi = typeof context.event.rssi === 'number' ? context.event.rssi : null;
    const payload = {
      matchedCriteria,
      type: context.event.type ?? null,
      deviceName: context.event.name ?? null,
      channel,
      rssi,
      lat: context.lat ?? null,
      lon: context.lon ?? null,
      nodeLat: context.nodeLat ?? null,
      nodeLon: context.nodeLon ?? null,
      raw: context.event.raw,
    };

    const message = this.renderMessage(rule, {
      mac: normalizedMac,
      nodeId: context.event.nodeId,
      nodeName: context.nodeName ?? context.event.nodeId,
      ssid,
      channel,
      rssi,
    });

    await this.prisma.$transaction([
      this.prisma.alertEvent.create({
        data: {
          ruleId: rule.id,
          nodeId: context.event.nodeId ?? null,
          mac: normalizedMac,
          ssid: ssid ?? null,
          channel,
          rssi,
          message,
          payload,
          triggeredAt: timestamp,
        },
      }),
      this.prisma.alertRule.update({
        where: { id: rule.id },
        data: { lastTriggeredAt: timestamp },
      }),
    ]);

    this.gateway.emitEvent({
      type: 'alert.rule',
      ruleId: rule.id,
      ruleName: rule.name,
      severity: rule.severity,
      scope: rule.scope,
      message,
      nodeId: context.event.nodeId,
      nodeName: context.nodeName ?? context.event.nodeId,
      mac: normalizedMac,
      ssid,
      channel,
      rssi,
      lat: context.lat ?? context.nodeLat ?? null,
      lon: context.lon ?? context.nodeLon ?? null,
      timestamp: timestamp.toISOString(),
      siteId: context.siteId ?? null,
      matchedCriteria,
      mapStyle: this.parseMapStyle(rule.mapStyle),
    });

    await this.webhookDispatcher.dispatchAlert({
      eventType: WebhookEventType.ALERT_TRIGGERED,
      event: 'alert.triggered',
      ruleId: rule.id,
      ruleName: rule.name,
      severity: rule.severity,
      message,
      matchedCriteria,
      mac: normalizedMac,
      nodeId: context.event.nodeId ?? null,
      nodeName: context.nodeName ?? context.event.nodeId ?? null,
      ssid: ssid ?? null,
      channel,
      rssi,
      lat: context.lat ?? null,
      lon: context.lon ?? null,
      siteId: context.siteId ?? null,
      timestamp,
      payload,
    });

    if (rule.notifyEmail && rule.emailRecipients.length > 0) {
      const subject = `[AHCC] Alert triggered: ${rule.name}`;
      const nodeSegment = context.event.nodeId ? `Node: ${context.event.nodeId}\n` : '';
      const body =
        `${message}\n` +
        `${nodeSegment}` +
        `MAC: ${normalizedMac}\n` +
        (rssi != null ? `RSSI: ${rssi} dBm\n` : '') +
        (channel != null ? `Channel: ${channel}\n` : '') +
        (ssid ? `SSID: ${ssid}\n` : '') +
        `Criteria: ${matchedCriteria.join(', ') || 'N/A'}\n` +
        `Time: ${timestamp.toISOString()}`;
      await Promise.all(
        rule.emailRecipients.map((recipient) =>
          this.mailService
            .sendMail({
              to: recipient,
              subject,
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
  }

  private renderMessage(
    rule: AlertRuleWithHooks,
    context: {
      mac: string;
      nodeId?: string;
      nodeName?: string | null;
      ssid?: string;
      channel?: number | null;
      rssi?: number | null;
    },
  ): string {
    const template =
      rule.messageTemplate?.trim() ||
      `Alert "${rule.name}" triggered for ${context.mac}${context.nodeId ? ` via ${context.nodeId}` : ''}`;

    const replacements: Record<string, string | number | undefined | null> = {
      mac: context.mac,
      nodeId: context.nodeId ?? null,
      nodeName: context.nodeName ?? null,
      ssid: context.ssid ?? null,
      channel: context.channel ?? null,
      rssi: context.rssi ?? null,
      rule: rule.name,
      severity: rule.severity,
    };

    return template.replace(
      /\{(mac|nodeId|nodeName|ssid|channel|rssi|rule|severity)\}/gi,
      (match, key) => {
        const normalizedKey = key.toLowerCase();
        const value = replacements[normalizedKey];
        return value != null ? String(value) : '';
      },
    );
  }

  private matchRule(
    rule: AlertRule,
    context: {
      normalizedMac: string;
      oui: string;
      ssid?: string;
      channel?: number | null;
      rssi?: number | null;
    },
  ): { matched: boolean; criteria: string[] } {
    if (!rule.isActive) {
      return { matched: false, criteria: [] };
    }
    if (rule.minRssi != null && (context.rssi == null || context.rssi < rule.minRssi)) {
      return { matched: false, criteria: [] };
    }
    if (rule.maxRssi != null && (context.rssi == null || context.rssi > rule.maxRssi)) {
      return { matched: false, criteria: [] };
    }

    const criteria: { enabled: boolean; matched: boolean; label: string }[] = [
      {
        enabled: rule.macAddresses.length > 0,
        matched: rule.macAddresses.includes(context.normalizedMac),
        label: 'mac',
      },
      {
        enabled: rule.ouiPrefixes.length > 0,
        matched: this.matchesOui(rule.ouiPrefixes, context.oui),
        label: 'oui',
      },
      {
        enabled: rule.ssids.length > 0,
        matched: this.matchesStringList(rule.ssids, context.ssid),
        label: 'ssid',
      },
      {
        enabled: rule.channels.length > 0,
        matched:
          typeof context.channel === 'number' &&
          rule.channels.includes(Math.round(context.channel)),
        label: 'channel',
      },
    ];

    const activeCriteria = criteria.filter((criterion) => criterion.enabled);
    if (activeCriteria.length === 0) {
      return { matched: false, criteria: [] };
    }

    const requirement =
      rule.matchMode === AlertRuleMatchMode.ALL
        ? activeCriteria.every((criterion) => criterion.matched)
        : activeCriteria.some((criterion) => criterion.matched);

    if (!requirement) {
      return { matched: false, criteria: [] };
    }

    const matchedLabels = activeCriteria
      .filter((criterion) => criterion.matched)
      .map((c) => c.label);
    return { matched: true, criteria: matchedLabels };
  }

  private matchesOui(ouiList: string[], detectedOui: string): boolean {
    if (!detectedOui) {
      return false;
    }
    const normalizedOui = detectedOui
      .replace(/[^A-F0-9]/g, '')
      .toUpperCase()
      .slice(0, 6);
    return ouiList.some((prefix) =>
      normalizedOui.startsWith(prefix.replace(/[^A-F0-9]/g, '').toUpperCase()),
    );
  }

  private matchesStringList(list: string[], value?: string): boolean {
    if (!value) {
      return false;
    }
    const normalizedValue = value.trim().toLowerCase();
    return list.some((entry) => entry.trim().toLowerCase() === normalizedValue);
  }

  private safeNormalizeMac(mac: string): string | null {
    try {
      return normalizeMac(mac);
    } catch {
      this.logger.warn(`Unable to normalize MAC for alert matching: ${mac}`);
      return null;
    }
  }

  private async getActiveRules(): Promise<AlertRuleWithHooks[]> {
    const now = Date.now();
    if (now < this.cacheExpiresAt) {
      return this.cachedRules;
    }
    const rules = await this.prisma.alertRule.findMany({
      where: { isActive: true },
    });
    this.cachedRules = rules;
    this.cacheExpiresAt = now + this.cacheTtlMs;
    return rules;
  }

  private parseMapStyle(value: Prisma.JsonValue | null): AlertRuleMapStyle | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    const style: AlertRuleMapStyle = {};
    if (typeof record.showOnMap === 'boolean') style.showOnMap = record.showOnMap;
    if (typeof record.color === 'string') style.color = record.color;
    if (typeof record.icon === 'string') style.icon = record.icon;
    if (typeof record.blink === 'boolean') style.blink = record.blink;
    if (typeof record.label === 'string') style.label = record.label;
    return Object.keys(style).length ? style : null;
  }
}
