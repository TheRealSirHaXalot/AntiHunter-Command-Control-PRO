import { Injectable, Logger } from '@nestjs/common';
import { AlarmLevel, InventoryDevice, Prisma, Webhook } from '@prisma/client';
import { createHmac } from 'node:crypto';
import type { ConnectionOptions as TlsConnectionOptions } from 'node:tls';
import { Agent, request } from 'undici';

import { WebhookEventType } from './webhook-event-type';
import { PrismaService } from '../prisma/prisma.service';
import { AlertChannelsService } from '../push/alert-channels.service';
import { nodeAlertSource } from '../push/alert-sources';
import {
  SerialAlertEvent,
  SerialCommandAck,
  SerialCommandResult,
  SerialDroneTelemetry,
  SerialNodeTelemetry,
  SerialRawFrame,
  SerialTargetDetected,
} from '../serial/serial.types';

interface WebhookDispatchContext {
  event: string;
  eventType: WebhookEventType;
  timestamp: Date;
  ruleId?: string;
  source?: string;
  ruleName?: string;
  severity?: AlarmLevel;
  message?: string;
  matchedCriteria?: string[];
  mac?: string;
  nodeId?: string | null;
  nodeName?: string | null;
  ssid?: string | null;
  channel?: number | null;
  rssi?: number | null;
  lat?: number | null;
  lon?: number | null;
  siteId?: string | null;
  payload?: Record<string, unknown>;
}

const NUM = '-?\\d+(?:\\.\\d+)?';
const COORD_TEXT: Array<[RegExp, string]> = [
  [new RegExp(`\\s*\\b(?:GPS|Location|OP)[:=]\\s*${NUM},\\s*${NUM}`, 'gi'), ''],
  [new RegExp(`(RID_RX:[^:\\s]+:-?\\d+):${NUM}:${NUM}`, 'gi'), '$1'],
  [new RegExp(`(RID_CLAIM:[^:\\s]+):${NUM}:${NUM}`, 'gi'), '$1'],
];
const COORD_KEY = /^(lat|lon|latitude|longitude)$|(Lat|Lon|Latitude|Longitude)$/;

export function stripCoords(text: string): string {
  return COORD_TEXT.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text)
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function scrubCoords(value: unknown): unknown {
  if (typeof value === 'string') {
    return stripCoords(value);
  }
  if (Array.isArray(value)) {
    return value.map(scrubCoords);
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !COORD_KEY.test(key))
        .map(([key, entry]) => [key, scrubCoords(entry)]),
    );
  }
  return value;
}

function messageText(context: WebhookDispatchContext, coords: boolean): string {
  const text = (context.message ?? context.event).trim();
  return (coords ? text : stripCoords(text)) || context.event;
}

function nodeInText(context: WebhookDispatchContext, text: string): boolean {
  const node = context.nodeName ?? context.nodeId;
  return Boolean(node && text.startsWith(`${node}:`));
}

function summarize(context: WebhookDispatchContext, coords: boolean): string {
  const text = messageText(context, coords);
  const node = context.nodeName ?? context.nodeId;
  return [
    context.severity ? `[${context.severity}]` : null,
    context.ruleName ?? null,
    text,
    context.mac ? `MAC ${context.mac}` : null,
    node && !nodeInText(context, text) ? `node ${node}` : null,
  ]
    .filter(Boolean)
    .join(' ')
    .slice(0, 2000);
}

function alertFields(context: WebhookDispatchContext, coords: boolean): Array<[string, string]> {
  const text = messageText(context, coords);
  const coordsInText = stripCoords(text) !== text;
  const fields: Array<[string, string | null]> = [
    ['Device', context.mac ?? null],
    ['SSID', context.ssid ?? null],
    ['RSSI', context.rssi != null ? `${context.rssi} dBm` : null],
    ['Channel', context.channel != null ? String(context.channel) : null],
    ['Node', nodeInText(context, text) ? null : (context.nodeName ?? context.nodeId ?? null)],
    [
      'Location',
      coords && !coordsInText && context.lat != null && context.lon != null
        ? `${context.lat.toFixed(5)}, ${context.lon.toFixed(5)}`
        : null,
    ],
    ['Matched', context.matchedCriteria?.length ? context.matchedCriteria.join(', ') : null],
    ['Time', context.timestamp.toISOString().replace('T', ' ').slice(0, 19) + ' UTC'],
  ];
  return fields.filter((field): field is [string, string] => Boolean(field[1]));
}

function alertTitle(context: WebhookDispatchContext): string {
  const nodeLabel = context.eventType === WebhookEventType.NODE_ALERT ? 'Node alert' : null;
  const parts = [context.severity ?? null, context.ruleName ?? nodeLabel].filter(Boolean);
  return parts.join(' - ') || 'AntiHunter alert';
}

function alertBody(context: WebhookDispatchContext, coords: boolean): string {
  return [
    messageText(context, coords),
    ...alertFields(context, coords).map(([name, value]) => `${name}: ${value}`),
  ].join('\n');
}

function discordEscape(value: string): string {
  return value.replace(/[\\*_~`|>[\]()<@]/g, '\\$&');
}

function slackEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const DISCORD_COLORS: Record<AlarmLevel, number> = {
  INFO: 0x5865f2,
  NOTICE: 0x3ba55d,
  ALERT: 0xfaa61a,
  CRITICAL: 0xed4245,
};

@Injectable()
export class WebhookDispatcherService {
  private readonly logger = new Logger(WebhookDispatcherService.name);
  private subscriberCache: { expiresAt: number; webhooks: Webhook[] } | null = null;
  private readonly subscriberCacheTtlMs = 5_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly channels: AlertChannelsService,
  ) {}

  private pushAlert(context: WebhookDispatchContext, source: string): void {
    void this.channels
      .alert(
        alertTitle(context),
        alertBody(context, true),
        context.severity,
        source,
        alertBody(context, false),
      )
      .catch((error) => {
        this.logger.warn(`Push notify failed: ${error instanceof Error ? error.message : error}`);
      });
  }

  async dispatchAlert(context: WebhookDispatchContext): Promise<void> {
    const source = context.ruleId ? `rule:${context.ruleId}` : 'rule:unknown';
    context.source = source;
    this.pushAlert(context, source);
    await this.dispatchToSubscribers(WebhookEventType.ALERT_TRIGGERED, context);
  }

  async dispatchExternalAlert(context: WebhookDispatchContext): Promise<void> {
    context.source = 'mqtt';
    this.pushAlert(context, 'mqtt');
    await this.dispatchToSubscribers(WebhookEventType.ALERT_TRIGGERED, context);
  }

  async dispatchInventoryUpdate(device: InventoryDevice): Promise<void> {
    const payload = {
      mac: device.mac,
      vendor: device.vendor,
      type: device.type,
      ssid: device.ssid,
      hits: device.hits,
      lastSeen: device.lastSeen,
      maxRSSI: device.maxRSSI,
      minRSSI: device.minRSSI,
      avgRSSI: device.avgRSSI,
      locallyAdministered: device.locallyAdministered,
      multicast: device.multicast,
      lastNodeId: device.lastNodeId,
      lastLat: device.lastLat,
      lastLon: device.lastLon,
      siteId: device.siteId,
      channel: device.channel,
      updatedAt: device.updatedAt,
    } as Record<string, unknown>;

    const context: WebhookDispatchContext = {
      event: 'inventory.updated',
      eventType: WebhookEventType.INVENTORY_UPDATED,
      source: 'event:inventory',
      timestamp: new Date(),
      message: `Inventory updated for ${device.mac}`,
      mac: device.mac,
      nodeId: device.lastNodeId ?? null,
      channel: device.channel ?? null,
      rssi: device.avgRSSI ?? null,
      lat: device.lastLat ?? null,
      lon: device.lastLon ?? null,
      siteId: device.siteId ?? null,
      payload,
    };

    await this.dispatchToSubscribers(WebhookEventType.INVENTORY_UPDATED, context);
  }

  async dispatchNodeTelemetry(event: SerialNodeTelemetry, siteId?: string | null): Promise<void> {
    const timestamp = event.timestamp ?? new Date();
    await this.dispatchToSubscribers(WebhookEventType.NODE_TELEMETRY, {
      event: 'node.telemetry',
      eventType: WebhookEventType.NODE_TELEMETRY,
      source: 'event:node-telemetry',
      timestamp,
      nodeId: event.nodeId,
      nodeName: event.nodeId,
      lat: event.lat ?? null,
      lon: event.lon ?? null,
      siteId: siteId ?? null,
      payload: {
        raw: event.raw,
        lastMessage: event.lastMessage ?? null,
        temperatureC: event.temperatureC ?? null,
        temperatureF: event.temperatureF ?? null,
      },
    });
  }

  async dispatchTargetDetection(
    event: SerialTargetDetected,
    options: {
      siteId?: string | null;
      timestamp?: Date;
      tracking?: Record<string, unknown>;
    } = {},
  ): Promise<void> {
    const timestamp = options.timestamp ?? new Date();
    this.pushAlert(
      {
        event: 'event.target',
        eventType: WebhookEventType.TARGET_DETECTED,
        timestamp,
        nodeId: event.nodeId ?? null,
        message: `Target detected${event.name ? `: ${event.name}` : ''}`,
        mac: event.mac,
        rssi: event.rssi ?? null,
        channel: event.channel ?? null,
        lat: event.lat ?? null,
        lon: event.lon ?? null,
      },
      'target',
    );
    await this.dispatchToSubscribers(WebhookEventType.TARGET_DETECTED, {
      event: 'event.target',
      eventType: WebhookEventType.TARGET_DETECTED,
      source: 'target',
      timestamp,
      nodeId: event.nodeId ?? null,
      mac: event.mac,
      rssi: event.rssi ?? null,
      channel: event.channel ?? null,
      lat: event.lat ?? null,
      lon: event.lon ?? null,
      siteId: options.siteId ?? null,
      payload: {
        type: event.type ?? null,
        name: event.name ?? null,
        raw: event.raw,
        tracking: options.tracking ?? null,
      },
    });
  }

  async dispatchNodeAlert(
    event: SerialAlertEvent,
    options: {
      siteId?: string | null;
      lat?: number | null;
      lon?: number | null;
      message?: string | null;
    } = {},
  ): Promise<void> {
    const timestamp = new Date();
    const data = (event.data ?? {}) as Record<string, unknown>;
    const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
    const num = (value: unknown) =>
      typeof value === 'number' && Number.isFinite(value) ? value : null;
    const source = nodeAlertSource(event.category, event.level, event.data);
    if (source) {
      this.pushAlert(
        {
          event: 'node.alert',
          eventType: WebhookEventType.NODE_ALERT,
          timestamp,
          nodeId: event.nodeId ?? null,
          severity: event.level as AlarmLevel,
          message: options.message ?? event.message,
          mac: text(data.mac) ?? text(data.src) ?? text(data.bssid),
          ssid: text(data.ssid) ?? text(data.name) ?? null,
          rssi: num(data.rssi) ?? (Number.isFinite(Number(data.rssi)) ? Number(data.rssi) : null),
          channel: num(data.channel),
          lat: options.lat ?? null,
          lon: options.lon ?? null,
        },
        source,
      );
    }
    await this.dispatchToSubscribers(WebhookEventType.NODE_ALERT, {
      event: 'node.alert',
      eventType: WebhookEventType.NODE_ALERT,
      source: source ?? 'node:status',
      timestamp,
      nodeId: event.nodeId ?? null,
      nodeName: event.nodeId ?? null,
      severity: event.level as AlarmLevel,
      message: options.message ?? event.message,
      lat: options.lat ?? null,
      lon: options.lon ?? null,
      siteId: options.siteId ?? null,
      payload: {
        raw: event.raw,
        data: event.data ?? null,
        category: event.category,
      },
    });
  }

  async dispatchDroneTelemetry(
    event: SerialDroneTelemetry,
    options: {
      siteId?: string | null;
      nodeId?: string | null;
      timestamp?: Date;
    } = {},
  ): Promise<void> {
    const timestamp = options.timestamp ?? new Date();
    await this.dispatchToSubscribers(WebhookEventType.DRONE_TELEMETRY, {
      event: 'drone.telemetry',
      eventType: WebhookEventType.DRONE_TELEMETRY,
      source: 'event:drone-telemetry',
      timestamp,
      nodeId: options.nodeId ?? event.nodeId ?? null,
      siteId: options.siteId ?? null,
      lat: event.lat ?? null,
      lon: event.lon ?? null,
      message: `Drone ${event.droneId} telemetry`,
      payload: {
        droneId: event.droneId,
        mac: event.mac ?? null,
        altitude: event.altitude ?? null,
        speed: event.speed ?? null,
        operatorLat: event.operatorLat ?? null,
        operatorLon: event.operatorLon ?? null,
        rssi: event.rssi ?? null,
        raw: event.raw,
      },
    });
  }

  async dispatchCommandAck(
    event: SerialCommandAck,
    siteId?: string | null,
    timestamp: Date = new Date(),
  ): Promise<void> {
    await this.dispatchToSubscribers(WebhookEventType.COMMAND_ACK, {
      event: 'command.ack',
      eventType: WebhookEventType.COMMAND_ACK,
      source: 'event:command-ack',
      timestamp,
      nodeId: event.nodeId,
      siteId: siteId ?? null,
      message: `Command ${event.ackType} acknowledged with status ${event.status}`,
      payload: {
        ackType: event.ackType,
        status: event.status,
        raw: event.raw,
      },
    });
  }

  async dispatchCommandResult(
    event: SerialCommandResult,
    siteId?: string | null,
    timestamp: Date = new Date(),
  ): Promise<void> {
    await this.dispatchToSubscribers(WebhookEventType.COMMAND_RESULT, {
      event: 'command.result',
      eventType: WebhookEventType.COMMAND_RESULT,
      source: 'event:command-result',
      timestamp,
      nodeId: event.nodeId,
      siteId: siteId ?? null,
      message: `Command ${event.command} completed`,
      payload: {
        command: event.command,
        payload: event.payload,
        raw: event.raw,
      },
    });
  }

  async dispatchRawFrame(event: SerialRawFrame, siteId?: string | null): Promise<void> {
    await this.dispatchToSubscribers(WebhookEventType.SERIAL_RAW, {
      event: 'serial.raw',
      eventType: WebhookEventType.SERIAL_RAW,
      source: 'event:serial-raw',
      timestamp: new Date(),
      siteId: siteId ?? null,
      message: 'Raw serial line received',
      payload: {
        raw: event.raw,
      },
    });
  }

  async sendTest(webhook: Webhook): Promise<void> {
    await this.deliver(webhook, {
      event: 'webhook.test',
      eventType: WebhookEventType.ALERT_TRIGGERED,
      timestamp: new Date(),
      severity: AlarmLevel.INFO,
      message: 'Test payload from Command Center',
      matchedCriteria: [],
      mac: '00:00:00:00:00:00',
      payload: {},
    });
  }

  private async deliver(webhook: Webhook, context: WebhookDispatchContext): Promise<void> {
    if (!webhook?.enabled) {
      return;
    }

    const coords = await this.channels.coordsUnencrypted();
    const summary = summarize(context, coords);

    const payload = {
      summary,
      value1: summary,
      value2: context.severity ?? '',
      value3: context.mac ?? '',
      content: discordEscape(summary).slice(0, 2000),
      allowed_mentions: { parse: [] },
      text: `*${slackEscape(alertTitle(context))}*\n${slackEscape(alertBody(context, coords))}`.slice(
        0,
        3000,
      ),
      embeds: [
        {
          title: discordEscape(alertTitle(context)).slice(0, 256),
          description: discordEscape(messageText(context, coords)).slice(0, 4000),
          color: DISCORD_COLORS[context.severity ?? 'NOTICE'],
          fields: alertFields(context, coords).map(([name, value]) => ({
            name,
            value: discordEscape(value).slice(0, 1024),
            inline: name !== 'Matched',
          })),
          timestamp: context.timestamp.toISOString(),
        },
      ],
      event: context.event,
      eventType: context.eventType,
      rule: context.ruleId
        ? {
            id: context.ruleId,
            name: context.ruleName ?? null,
            severity: context.severity ?? null,
          }
        : null,
      data: {
        message: context.message ? messageText(context, coords) : null,
        matchedCriteria: context.matchedCriteria ?? [],
        mac: context.mac ?? null,
        nodeId: context.nodeId ?? null,
        nodeName: context.nodeName ?? null,
        ssid: context.ssid ?? null,
        channel: context.channel ?? null,
        rssi: context.rssi ?? null,
        lat: coords ? (context.lat ?? null) : null,
        lon: coords ? (context.lon ?? null) : null,
        siteId: context.siteId ?? null,
        timestamp: context.timestamp.toISOString(),
      },
      payload: coords ? (context.payload ?? {}) : scrubCoords(context.payload ?? {}),
    };

    const serialized = JSON.stringify(payload);
    const delivery = await this.prisma.webhookDelivery.create({
      data: {
        webhookId: webhook.id,
        ruleId: context.ruleId ?? null,
        requestPayload: payload as Prisma.InputJsonValue,
      },
    });

    const dispatcher = this.buildTlsDispatcher(webhook);

    try {
      const headers = this.buildHeaders(webhook, serialized, context.event);
      const response = await request(webhook.url, {
        method: 'POST',
        headers,
        body: serialized,
        bodyTimeout: 10_000,
        headersTimeout: 10_000,
        dispatcher: dispatcher ?? undefined,
      });
      const responseBody = await response.body.text();
      const success = response.statusCode >= 200 && response.statusCode < 300;
      await this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          statusCode: response.statusCode,
          success,
          responseBody: responseBody.slice(0, 2000),
          completedAt: new Date(),
        },
      });
      await this.prisma.webhook.update({
        where: { id: webhook.id },
        data: success ? { lastSuccessAt: new Date() } : { lastFailureAt: new Date() },
      });
      if (!success) {
        this.logger.warn(`Webhook ${webhook.id} responded with status ${response.statusCode}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          success: false,
          errorMessage: message.slice(0, 2000),
          completedAt: new Date(),
        },
      });
      await this.prisma.webhook.update({
        where: { id: webhook.id },
        data: { lastFailureAt: new Date() },
      });
      this.logger.error(`Webhook ${webhook.id} delivery failed: ${message}`);
    } finally {
      if (dispatcher) {
        try {
          await dispatcher.close();
        } catch (error) {
          this.logger.debug(
            `Failed to close webhook dispatcher for ${webhook.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
  }

  private buildHeaders(webhook: Webhook, body: string, event: string): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-webhook-id': webhook.id,
      'x-webhook-event': event,
    };
    if (webhook.secret?.length) {
      headers['x-webhook-signature'] = createHmac('sha256', webhook.secret)
        .update(body)
        .digest('hex');
    }
    return headers;
  }

  private buildTlsDispatcher(webhook: Webhook): Agent | null {
    if (!webhook.url.toLowerCase().startsWith('https://')) {
      return null;
    }

    let connectOptions: TlsConnectionOptions | null = null;
    const ensureConnect = () => {
      if (!connectOptions) {
        connectOptions = {};
      }
      return connectOptions;
    };

    let hasCustomizations = false;

    if (webhook.verifyTls === false) {
      ensureConnect().rejectUnauthorized = false;
      hasCustomizations = true;
    }

    const ca = webhook.caBundle?.trim();
    if (ca) {
      ensureConnect().ca = ca;
      hasCustomizations = true;
    }

    const cert = webhook.clientCert?.trim();
    const key = webhook.clientKey?.trim();
    if (cert && key) {
      const connect = ensureConnect();
      connect.cert = cert;
      connect.key = key;
      hasCustomizations = true;
    }

    if (!hasCustomizations || !connectOptions) {
      return null;
    }

    const options: ConstructorParameters<typeof Agent>[0] = {
      connect: connectOptions as NonNullable<ConstructorParameters<typeof Agent>[0]>['connect'],
    };

    return new Agent(options);
  }

  invalidateSubscriberCache(): void {
    this.subscriberCache = null;
  }

  private async dispatchToSubscribers(
    eventType: WebhookEventType,
    context: WebhookDispatchContext,
  ): Promise<void> {
    if (context.source && (await this.channels.isSourceMuted(context.source))) {
      return;
    }
    const subscribers = await this.getSubscribers();
    if (subscribers.length === 0) {
      return;
    }
    const enriched: WebhookDispatchContext = { ...context, eventType };
    await Promise.all(subscribers.map((webhook) => this.deliver(webhook, enriched)));
  }

  private async getSubscribers(): Promise<Webhook[]> {
    const now = Date.now();
    if (this.subscriberCache && this.subscriberCache.expiresAt > now) {
      return this.subscriberCache.webhooks;
    }
    const webhooks = await this.prisma.webhook.findMany({ where: { enabled: true } });
    this.subscriberCache = { webhooks, expiresAt: now + this.subscriberCacheTtlMs };
    return webhooks;
  }
}
