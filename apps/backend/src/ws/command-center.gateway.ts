import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  UnauthorizedException,
  UsePipes,
  ValidationPipe,
  forwardRef,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import { Role } from '@prisma/client';
import proxyaddr from 'proxy-addr';
import { Subscription } from 'rxjs';
import { Server, Socket } from 'socket.io';

import { AuthService } from '../auth/auth.service';
import { CommandState, CommandsService } from '../commands/commands.service';
import { SendCommandDto } from '../commands/dto/send-command.dto';
import { DronesService } from '../drones/drones.service';
import { EventBusService, CommandCenterEvent } from '../events/event-bus.service';
import { FirewallBlockedException, FirewallService } from '../firewall/firewall.service';
import { GeofenceEvent, GeofenceResponse, GeofencesService } from '../geofences/geofences.service';
import { NodesService } from '../nodes/nodes.service';

@WebSocketGateway({
  namespace: '/ws',
  cors: { origin: true, credentials: true },
})
@Injectable()
export class CommandCenterGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private static readonly EVENT_DEDUPE_WINDOW_MS = 750;
  private static readonly EVENT_DEDUPE_MAX = 512;
  private static readonly EVENT_KEY_IGNORED_FIELDS = new Set(['timestamp', 'ts']);

  private readonly logger = new Logger(CommandCenterGateway.name);
  @WebSocketServer()
  server!: Server;

  private readonly clientDiffSubscriptions = new Map<string, Subscription>();
  private commandSubscription?: Subscription;
  private geofenceSubscription?: Subscription;
  private eventBusSubscription?: Subscription;
  private readonly recentEventHashes = new Map<string, number>();
  private static readonly REPLAY_MAX = 200;
  private readonly bootId = Date.now().toString(36);
  private eventSeq = 0;
  private readonly replayBuffer: Array<CommandCenterEvent & { seq: number; bootId: string }> = [];

  constructor(
    private readonly nodesService: NodesService,
    private readonly commandsService: CommandsService,
    private readonly authService: AuthService,
    private readonly eventBus: EventBusService,
    private readonly geofencesService: GeofencesService,
    @Inject(forwardRef(() => DronesService))
    private readonly dronesService: DronesService,
    private readonly firewallService: FirewallService,
    private readonly httpAdapterHost: HttpAdapterHost,
  ) {}

  afterInit(server: Server): void {
    this.commandSubscription = this.commandsService.getUpdatesStream().subscribe((command) => {
      server.emit('command.update', command);
    });

    this.geofenceSubscription = this.geofencesService
      .getChangesStream()
      .subscribe((event) => this.emitGeofenceEvent(event));

    this.eventBusSubscription = this.eventBus.getStream().subscribe((event) => {
      if (event.type === 'update.progress' || event.type === 'update.complete') {
        server.emit('event', event);
      }
    });
  }

  async handleConnection(@ConnectedSocket() client: Socket): Promise<void> {
    try {
      const trust = this.httpAdapterHost.httpAdapter.getInstance().get('trust proxy fn');
      await this.firewallService.enforce({
        ip: proxyaddr(client.request, trust),
        path: client.nsp.name,
        method: 'WS',
        userAgent: client.handshake.headers['user-agent'],
      });
    } catch (error) {
      if (error instanceof FirewallBlockedException) {
        client.emit('error', 'forbidden');
        client.disconnect(true);
        return;
      }
      throw error;
    }

    try {
      const token =
        (client.handshake.auth?.token as string | undefined) ||
        (client.handshake.headers?.authorization as string | undefined);
      if (!token) {
        throw new UnauthorizedException('Missing token');
      }
      const normalizedToken = token.startsWith('Bearer ') ? token.slice(7) : token;
      const payload = await this.authService.verifyToken(normalizedToken);
      if (!payload.legalAccepted) {
        throw new UnauthorizedException('Legal acknowledgement required');
      }
      if (payload.twoFactorPending) {
        throw new UnauthorizedException('Two-factor authentication required');
      }
      client.data.userId = payload.sub;
      client.data.role = payload.role;
    } catch (error) {
      client.emit('error', 'unauthorized');
      client.disconnect(true);
      return;
    }

    const nodes = this.nodesService.getSnapshot();
    let geofences: GeofenceResponse[] = [];
    try {
      geofences = await this.geofencesService.list({ includeRemote: true });
    } catch (error) {
      this.logger.warn(
        `Failed to load geofences for client init: ${error instanceof Error ? error.message : error}`,
      );
    }

    const drones = this.dronesService.getSnapshot();

    client.emit('init', {
      nodes,
      geofences,
      drones,
      bootId: this.bootId,
    });
    const subscription = this.nodesService.getDiffStream().subscribe((diff) => {
      client.emit('nodes', diff);
    });

    this.clientDiffSubscriptions.set(client.id, subscription);
  }

  handleDisconnect(@ConnectedSocket() client: Socket): void {
    const subscription = this.clientDiffSubscriptions.get(client.id);
    subscription?.unsubscribe();
    this.clientDiffSubscriptions.delete(client.id);
  }

  onModuleDestroy(): void {
    this.commandSubscription?.unsubscribe();
    this.geofenceSubscription?.unsubscribe();
    this.eventBusSubscription?.unsubscribe();
    this.clientDiffSubscriptions.forEach((subscription) => subscription.unsubscribe());
    this.clientDiffSubscriptions.clear();
  }

  emitEvent(payload: CommandCenterEvent, options?: { skipBus?: boolean }): void {
    if (!this.server) {
      return;
    }
    if (!this.shouldEmitEvent(payload)) {
      return;
    }
    if (!options?.skipBus) {
      this.eventBus.publish(payload);
    }
    this.eventSeq += 1;
    const stamped = { ...payload, seq: this.eventSeq, bootId: this.bootId };
    this.replayBuffer.push(stamped);
    if (this.replayBuffer.length > CommandCenterGateway.REPLAY_MAX) {
      this.replayBuffer.shift();
    }
    this.server.emit('event', stamped);
  }

  @SubscribeMessage('replay')
  handleReplay(@ConnectedSocket() client: Socket, @MessageBody() body: { since?: unknown }) {
    const since = typeof body?.since === 'number' && Number.isFinite(body.since) ? body.since : 0;
    for (const event of this.replayBuffer) {
      if (event.seq > since) {
        client.emit('event', event);
      }
    }
  }

  emitCommandUpdate(command: CommandState): void {
    if (!this.server) {
      return;
    }
    this.server.emit('command.update', command);
  }

  private emitGeofenceEvent(event: GeofenceEvent): void {
    if (!this.server) {
      return;
    }
    if (event.type === 'upsert') {
      this.server.emit('geofences.upsert', event.geofence);
    } else if (event.type === 'delete') {
      this.server.emit('geofences.delete', event.geofence);
    }
  }

  @SubscribeMessage('sendCommand')
  @UsePipes(new ValidationPipe({ transform: true }))
  async handleSendCommand(@ConnectedSocket() client: Socket, @MessageBody() dto: SendCommandDto) {
    if (client.data?.role !== Role.ADMIN && client.data?.role !== Role.OPERATOR) {
      throw new WsException('INSUFFICIENT_ROLE');
    }
    try {
      const meta = {
        ip: (client.handshake.address as string | undefined) ?? null,
        userAgent: (client.handshake.headers['user-agent'] as string | undefined) ?? null,
        fingerprint: client.id,
      };
      const state = await this.commandsService.sendCommand(dto, client.data?.userId, meta);
      return { event: 'command.queued', data: state };
    } catch (error) {
      throw new WsException(error instanceof Error ? error.message : 'Unknown error');
    }
  }

  private shouldEmitEvent(payload: CommandCenterEvent): boolean {
    const key = this.buildEventDedupKey(payload);
    if (!key) {
      return true;
    }
    const now = Date.now();
    const lastSeen = this.recentEventHashes.get(key);
    if (lastSeen && now - lastSeen < CommandCenterGateway.EVENT_DEDUPE_WINDOW_MS) {
      return false;
    }
    this.recentEventHashes.set(key, now);
    if (this.recentEventHashes.size > CommandCenterGateway.EVENT_DEDUPE_MAX) {
      const cutoff = now - CommandCenterGateway.EVENT_DEDUPE_WINDOW_MS;
      for (const [candidate, ts] of this.recentEventHashes.entries()) {
        if (ts < cutoff || this.recentEventHashes.size > CommandCenterGateway.EVENT_DEDUPE_MAX) {
          this.recentEventHashes.delete(candidate);
        }
        if (this.recentEventHashes.size <= CommandCenterGateway.EVENT_DEDUPE_MAX) {
          break;
        }
      }
    }
    return true;
  }

  private buildEventDedupKey(payload: CommandCenterEvent): string | null {
    try {
      const sanitized = this.sanitizeEventForKey(payload);
      return JSON.stringify(sanitized);
    } catch (error) {
      this.logger.warn(
        `Failed to build event dedupe key: ${error instanceof Error ? error.message : error}`,
      );
      return null;
    }
  }

  private sanitizeEventForKey(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.sanitizeEventForKey(item));
    }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).filter(
        (key) => !CommandCenterGateway.EVENT_KEY_IGNORED_FIELDS.has(key),
      );
      keys.sort();
      return keys.reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = this.sanitizeEventForKey(record[key]);
        return acc;
      }, {});
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      return String(value);
    }
    if (typeof value === 'string') {
      return value.trim();
    }
    return value;
  }
}
