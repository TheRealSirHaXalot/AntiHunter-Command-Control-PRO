import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { TakProtocol } from '@prisma/client';
import { randomUUID } from 'crypto';
import * as dgram from 'dgram';
import { readFileSync } from 'fs';
import * as net from 'net';
import * as tls from 'tls';

import { TakConfigService, TakConfig } from './tak-config.service';
import { buildCotEvent } from './utils/cot-builder';
import { parseCotEvent } from './utils/cot-parser';
import { NodesService } from '../nodes/nodes.service';
import type { NodeSnapshot } from '../nodes/nodes.types';
import { CommandCenterGateway } from '../ws/command-center.gateway';

const COT_TYPE_NODE = 'a-f-G-U-C';
const COT_TYPE_TARGET = 'b-m-p-s-m';
const COT_TYPE_ALERT = 'b-m-p-s-p-i';
const COT_TYPE_COMMAND = 'b-m-p-s-o';

@Injectable()
export class TakService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TakService.name);
  private udpSocket?: dgram.Socket;
  private tcpSocket?: net.Socket;
  private connectTimer?: NodeJS.Timeout;
  private currentConfig?: TakConfig;
  private shuttingDown = false;

  constructor(
    private readonly takConfigService: TakConfigService,
    private readonly nodesService: NodesService,
    private readonly gateway: CommandCenterGateway,
  ) {}

  async onModuleInit(): Promise<void> {
    const config = await this.takConfigService.getConfig();
    await this.applyConfig(config);
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    this.clearSockets();
  }

  async reload(): Promise<void> {
    const config = await this.takConfigService.getConfig();
    await this.applyConfig(config, true);
  }

  async sendCot(payload: string): Promise<void> {
    const config = this.currentConfig;
    if (!config || !config.enabled) {
      throw new Error('TAK integration is disabled');
    }

    await this.writeCot(payload, config);
  }

  private async writeCot(payload: string, config: TakConfig): Promise<void> {
    if (config.protocol === TakProtocol.UDP) {
      if (!this.udpSocket) {
        throw new Error('TAK UDP socket is not established');
      }
      await new Promise<void>((resolve, reject) => {
        this.udpSocket!.send(Buffer.from(payload), (err) => (err ? reject(err) : resolve()));
      });
      return;
    }

    if (config.protocol === TakProtocol.TCP) {
      if (!this.tcpSocket) {
        throw new Error('TAK TCP socket is not established');
      }
      this.tcpSocket.write(payload);
      return;
    }

    throw new Error(`TAK protocol ${config.protocol} not implemented yet`);
  }

  async streamNodeTelemetry(params: {
    nodeId: string;
    name?: string | null;
    lat?: number | null;
    lon?: number | null;
    message?: string | null;
    siteId?: string | null;
    timestamp?: Date;
  }): Promise<void> {
    const config = this.currentConfig;
    if (!config?.enabled || !config.streamNodes) {
      return;
    }

    const lat = this.safeNumber(params.lat);
    const lon = this.safeNumber(params.lon);
    if (lat === undefined || lon === undefined) {
      return;
    }

    const time = params.timestamp ?? new Date();
    const payload = buildCotEvent({
      uid: this.buildUid('NODE', params.nodeId),
      type: COT_TYPE_NODE,
      lat,
      lon,
      time,
      callsign: params.name ?? params.nodeId,
      remarks: params.message ?? 'Node telemetry update',
      detailFragments: [
        {
          tag: 'ahccNode',
          attributes: {
            id: params.nodeId,
            site: params.siteId ?? undefined,
          },
        },
      ],
    });

    await this.dispatchCot(payload, `node:${params.nodeId}`);
  }

  async streamTargetDetection(params: {
    mac: string;
    nodeId?: string | null;
    lat?: number | null;
    lon?: number | null;
    rssi?: number | null;
    confidence?: number | null;
    deviceType?: string | null;
    message?: string | null;
    siteId?: string | null;
  }): Promise<void> {
    const config = this.currentConfig;
    if (!config?.enabled || !config.streamTargets) {
      return;
    }

    let lat = this.safeNumber(params.lat);
    let lon = this.safeNumber(params.lon);
    let callsign: string | undefined;
    if ((lat === undefined || lon === undefined) && params.nodeId) {
      const context = this.resolveNodeContext(params.nodeId);
      lat ??= context.lat;
      lon ??= context.lon;
      callsign = context.name ?? params.nodeId ?? undefined;
    }

    if (lat === undefined || lon === undefined) {
      return;
    }

    const remarks =
      params.message ??
      `Target ${params.mac} detected${params.rssi != null ? ` (RSSI ${params.rssi})` : ''}`;
    const confidenceValue = this.safeNumber(params.confidence);
    const rssiValue = this.safeNumber(params.rssi);

    const payload = buildCotEvent({
      uid: this.buildUid('TARGET', params.mac),
      type: COT_TYPE_TARGET,
      lat,
      lon,
      callsign: callsign ?? params.mac,
      remarks,
      detailFragments: [
        {
          tag: 'ahccTarget',
          attributes: {
            mac: params.mac,
            node: params.nodeId ?? undefined,
            site: params.siteId ?? undefined,
            rssi: rssiValue ?? undefined,
            confidence: confidenceValue != null ? confidenceValue.toFixed(3) : undefined,
            type: params.deviceType ?? undefined,
          },
        },
      ],
    });

    await this.dispatchCot(payload, `target:${params.mac}`);
  }

  async streamAlert(params: {
    level?: string | null;
    nodeId?: string | null;
    lat?: number | null;
    lon?: number | null;
    message: string;
    category?: string | null;
    siteId?: string | null;
    timestamp?: Date;
  }): Promise<void> {
    const config = this.currentConfig;
    const level = params.level?.toUpperCase() ?? 'INFO';
    if (!config?.enabled || !this.shouldStreamAlert(level)) {
      return;
    }

    let lat = this.safeNumber(params.lat);
    let lon = this.safeNumber(params.lon);
    let callsign: string | undefined;

    if ((lat === undefined || lon === undefined) && params.nodeId) {
      const context = this.resolveNodeContext(params.nodeId);
      lat ??= context.lat;
      lon ??= context.lon;
      callsign = context.name ?? params.nodeId ?? undefined;
    }

    if (lat === undefined || lon === undefined) {
      return;
    }

    const time = params.timestamp ?? new Date();
    const payload = buildCotEvent({
      uid: this.buildUid('ALERT', randomUUID()),
      type: COT_TYPE_ALERT,
      lat,
      lon,
      time,
      callsign: callsign ?? level,
      remarks: params.message,
      detailFragments: [
        {
          tag: 'ahccAlert',
          attributes: {
            level,
            node: params.nodeId ?? undefined,
            category: params.category ?? undefined,
            site: params.siteId ?? undefined,
          },
        },
      ],
    });

    await this.dispatchCot(payload, `alert:${level}`);
  }

  async streamCommandAck(params: {
    nodeId?: string | null;
    ackType?: string | null;
    status: string;
    siteId?: string | null;
    timestamp?: Date;
  }): Promise<void> {
    const config = this.currentConfig;
    if (!config?.enabled || !config.streamCommandAcks) {
      return;
    }

    const context = this.resolveNodeContext(params.nodeId);
    if (context.lat === undefined || context.lon === undefined) {
      return;
    }

    const time = params.timestamp ?? new Date();
    const payload = buildCotEvent({
      uid: this.buildUid('CMDACK', randomUUID()),
      type: COT_TYPE_COMMAND,
      lat: context.lat,
      lon: context.lon,
      time,
      callsign: context.name ?? params.nodeId ?? 'Command Ack',
      remarks: `Command ${params.ackType ?? 'ACK'} => ${params.status}`,
      detailFragments: [
        {
          tag: 'ahccCommand',
          attributes: {
            node: params.nodeId ?? undefined,
            site: params.siteId ?? undefined,
            status: params.status,
            kind: params.ackType ?? undefined,
            category: 'ack',
          },
        },
      ],
    });

    await this.dispatchCot(payload, 'command-ack');
  }

  async streamCommandResult(params: {
    nodeId?: string | null;
    command?: string | null;
    siteId?: string | null;
    result?: unknown;
    timestamp?: Date;
  }): Promise<void> {
    const config = this.currentConfig;
    if (!config?.enabled || !config.streamCommandResults) {
      return;
    }

    const context = this.resolveNodeContext(params.nodeId);
    if (context.lat === undefined || context.lon === undefined) {
      return;
    }

    const time = params.timestamp ?? new Date();
    const summary =
      typeof params.result === 'string'
        ? params.result
        : params.result
          ? JSON.stringify(params.result).slice(0, 240)
          : 'Command result received';

    const payload = buildCotEvent({
      uid: this.buildUid('CMDRES', randomUUID()),
      type: COT_TYPE_COMMAND,
      lat: context.lat,
      lon: context.lon,
      time,
      callsign: context.name ?? params.nodeId ?? 'Command Result',
      remarks: summary,
      detailFragments: [
        {
          tag: 'ahccCommand',
          attributes: {
            node: params.nodeId ?? undefined,
            site: params.siteId ?? undefined,
            command: params.command ?? undefined,
            category: 'result',
          },
          content: summary,
        },
      ],
    });

    await this.dispatchCot(payload, 'command-result');
  }

  private async dispatchCot(payload: string, context: string): Promise<void> {
    const config = this.currentConfig;
    if (!config || !config.enabled) {
      return;
    }

    try {
      await this.writeCot(payload, config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.debug(`TAK bridge drop (${context}): ${message}`);
    }
  }

  private buildUid(kind: string, id: string): string {
    return `AHCC-${kind}-${this.normalizeNodeId(id)}`;
  }

  private shouldStreamAlert(level: string): boolean {
    const config = this.currentConfig;
    if (!config?.enabled) {
      return false;
    }

    switch (level) {
      case 'CRITICAL':
        return config.streamAlertCritical;
      case 'ALERT':
        return config.streamAlertAlert;
      case 'NOTICE':
        return config.streamAlertNotice;
      case 'INFO':
      default:
        return config.streamAlertInfo;
    }
  }

  private resolveNodeContext(nodeId?: string | null): {
    lat?: number;
    lon?: number;
    name?: string;
  } {
    if (!nodeId) {
      return {};
    }

    const snapshot = this.nodesService.getSnapshotById(nodeId);
    if (!snapshot) {
      return {};
    }

    return {
      lat: this.safeNumber(snapshot.lat),
      lon: this.safeNumber(snapshot.lon),
      name: snapshot.name ?? undefined,
    };
  }

  private safeNumber(value: number | null | undefined): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  private async applyConfig(config: TakConfig, force = false): Promise<void> {
    this.currentConfig = config;

    if (!config.enabled) {
      this.logger.log('TAK integration disabled');
      this.clearSockets();
      return;
    }

    if (!config.host || !config.port) {
      this.logger.warn('TAK configuration missing host/port, skipping connection');
      this.clearSockets();
      return;
    }

    if (!force && this.tcpSocket && config.protocol === 'TCP') {
      return;
    }

    if (!force && this.udpSocket && config.protocol === 'UDP') {
      return;
    }

    this.clearSockets();
    await this.establishConnection(config).catch((error) => {
      this.logger.error(`TAK connection failed: ${error instanceof Error ? error.message : error}`);
      if (!this.shuttingDown) {
        this.scheduleReconnect();
      }
    });
  }

  private async establishConnection(config: TakConfig): Promise<void> {
    if (config.protocol === TakProtocol.UDP) {
      await this.openUdp(config);
      return;
    }

    if (config.protocol === TakProtocol.TCP) {
      await this.openTcp(config);
      return;
    }

    this.logger.warn(`Protocol ${config.protocol} not implemented yet`);
  }

  private async openUdp(config: TakConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      this.udpSocket = socket;
      let settled = false;

      socket.on('error', (err) => {
        this.logger.error(`TAK UDP error: ${err.message}`);
        if (!settled) {
          settled = true;
          reject(err);
          return;
        }
        socket.close();
        if (!this.shuttingDown) {
          this.scheduleReconnect();
        }
      });

      socket.on('message', (msg) => {
        this.handleCotMessage(msg.toString('utf8'));
      });

      const udpPort = config.port ?? 0;
      const udpHost = config.host ?? '127.0.0.1';
      socket.connect(udpPort, udpHost, async () => {
        this.logger.log(`Connected to TAK UDP ${config.host}:${config.port}`);
        await this.takConfigService.updateLastConnected(new Date());
        settled = true;
        resolve(undefined);
      });
    });
  }

  private async openTcp(config: TakConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const tcpHost = config.host ?? '127.0.0.1';
      const tcpPort = config.port ?? 0;
      const onConnect = async () => {
        this.logger.log(
          `Connected to TAK ${config.tlsEnabled ? 'TLS' : 'TCP'} ${config.host}:${config.port}`,
        );
        await this.takConfigService.updateLastConnected(new Date());
        settled = true;
        resolve(undefined);
      };
      const socket = config.tlsEnabled
        ? tls.connect(
            { host: tcpHost, port: tcpPort, ...this.buildTakTlsOptions(config) },
            onConnect,
          )
        : net.connect({ host: tcpHost, port: tcpPort }, onConnect);

      this.tcpSocket = socket;

      socket.on('data', (buffer) => {
        this.handleCotMessage(buffer.toString('utf8'));
      });

      socket.on('error', (err) => {
        this.logger.error(`TAK TCP error: ${err.message}`);
        if (!settled) {
          settled = true;
          reject(err);
          return;
        }
        if (!this.shuttingDown) {
          this.scheduleReconnect();
        }
      });

      socket.on('close', () => {
        this.logger.warn('TAK TCP connection closed');
        if (!this.shuttingDown) {
          this.scheduleReconnect();
        }
      });
    });
  }

  private buildTakTlsOptions(config: TakConfig): tls.ConnectionOptions {
    const insecure = process.env.TAK_TLS_INSECURE === 'true';
    if (insecure) {
      this.logger.warn(
        'TAK_TLS_INSECURE=true: TAK server certificate verification disabled (insecure, MITM possible).',
      );
    }
    const options: tls.ConnectionOptions = { rejectUnauthorized: !insecure };
    const ca = this.loadTakPem(config.cafile);
    const cert = this.loadTakPem(config.certfile);
    const key = this.loadTakPem(config.keyfile);
    if (ca) {
      options.ca = ca;
    }
    if (cert) {
      options.cert = cert;
    }
    if (key) {
      options.key = key;
    }
    return options;
  }

  private loadTakPem(value?: string | null): string | undefined {
    if (!value) {
      return undefined;
    }
    if (value.includes('-----BEGIN')) {
      return value;
    }
    try {
      return readFileSync(value, 'utf8');
    } catch (error) {
      this.logger.error(
        `TAK certificate not readable at ${value}: ${error instanceof Error ? error.message : error}`,
      );
      return undefined;
    }
  }

  private handleCotMessage(message: string): void {
    const trimmed = message.trim();
    if (!trimmed) {
      return;
    }

    const events = splitCotPayload(trimmed);
    events.forEach((event) => {
      const cot = parseCotEvent(event);
      if (!cot) {
        return;
      }
      void this.upsertNodeFromCot(cot, event);
    });
  }

  private async upsertNodeFromCot(
    cot: ReturnType<typeof parseCotEvent>,
    raw: string,
  ): Promise<void> {
    if (!cot) {
      return;
    }

    const nodeId = this.normalizeNodeId(cot.uid);
    const timestamp = cot.time ? new Date(cot.time) : new Date();
    const snapshot: NodeSnapshot = {
      id: nodeId,
      name: cot.callsign ?? cot.uid,
      lat: cot.lat,
      lon: cot.lon,
      ts: timestamp,
      lastMessage: cot.remarks ?? cot.type ?? null,
      lastSeen: new Date(),
    };

    try {
      await this.nodesService.upsert(snapshot);
    } catch (error) {
      this.logger.error(
        `Failed to persist TAK node ${nodeId}: ${error instanceof Error ? error.message : error}`,
      );
      return;
    }

    this.gateway.emitEvent({
      type: 'event.alert',
      timestamp: new Date().toISOString(),
      level: 'NOTICE',
      nodeId,
      message: cot.remarks ?? `${snapshot.name ?? nodeId} update`,
      data: {
        source: 'tak',
        uid: cot.uid,
        type: cot.type,
        how: cot.how,
      },
      raw,
    });
  }

  private scheduleReconnect(): void {
    if (this.connectTimer) {
      return;
    }
    this.connectTimer = setTimeout(() => {
      this.connectTimer = undefined;
      if (this.currentConfig) {
        void this.applyConfig(this.currentConfig, true);
      }
    }, 5000);
  }

  private clearSockets(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
    }
    if (this.udpSocket) {
      this.udpSocket.removeAllListeners();
      this.udpSocket.close();
      this.udpSocket = undefined;
    }
    if (this.tcpSocket) {
      this.tcpSocket.removeAllListeners();
      this.tcpSocket.destroy();
      this.tcpSocket = undefined;
    }
  }

  private normalizeNodeId(uid: string): string {
    const trimmed = uid.trim();
    if (!trimmed) {
      return 'TAK_UNKNOWN';
    }
    return trimmed.replace(/[^A-Za-z0-9_-]/g, '_').toUpperCase();
  }
}

function splitCotPayload(payload: string): string[] {
  if (!payload.includes('</event>')) {
    return [payload];
  }
  const events: string[] = [];
  let buffer = '';
  for (const line of payload.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    buffer += line;
    if (line.includes('</event>')) {
      events.push(buffer);
      buffer = '';
    }
  }
  if (buffer) {
    events.push(buffer);
  }
  return events;
}
