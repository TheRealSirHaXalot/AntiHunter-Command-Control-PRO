import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CommandLog, CommandStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Observable, Subject } from 'rxjs';

import { buildCommandPayload } from './command-builder';
import { PrismaService } from '../prisma/prisma.service';
import { SerialService } from '../serial/serial.service';
import { SerialCommandAck, SerialCommandResult } from '../serial/serial.types';
import { TriangulationSessionService } from '../triangulation/triangulation-session.service';
import { SendCommandDto } from './dto/send-command.dto';

const ACK_TO_COMMAND: Record<string, string> = {
  SCAN_ACK: 'SCAN_START',
  DEVICE_SCAN_ACK: 'DEVICE_SCAN_START',
  DRONE_ACK: 'DRONE_START',
  DEAUTH_ACK: 'DEAUTH_START',
  RANDOMIZATION_ACK: 'RANDOMIZATION_START',
  PCAP_ACK: 'PCAP_START',
  PCAP_STOP_ACK: 'PCAP_STOP',
  BASELINE_ACK: 'BASELINE_START',
  TRIANGULATE_ACK: 'TRIANGULATE_START',
  TRIANGULATE_STOP_ACK: 'TRIANGULATE_STOP',
  ERASE_ACK: 'ERASE_FORCE',
  CHANNELS_ACK: 'CONFIG_CHANNELS',
  TARGETS_ACK: 'CONFIG_TARGETS',
  AUTOERASE_ACK: 'AUTOERASE_ENABLE',
  AUTOERASE_STATUS_ACK: 'AUTOERASE_STATUS',
  SENTINEL_ON_ACK: 'SENTINEL_ON',
  SENTINEL_OFF_ACK: 'SENTINEL_OFF',
  SENTINEL_MODE_ACK: 'SENTINEL_MODE',
  SENTINEL_BOOT_ACK: 'SENTINEL_BOOT',
  GROUP_ACK: 'GROUP',
  DETECT_CFG_ACK: 'DETECT_CFG',
  INCIDENTS_CLEAR_ACK: 'INCIDENTS_CLEAR',
  DEDUP_CLEAR_ACK: 'MESH_DEDUP_CLEAR',
  FACTORY_RESET_ACK: 'FACTORY_RESET',
};

export interface CommandState {
  id: string;
  siteId?: string | null;
  originSiteId?: string | null;
  target: string;
  name: string;
  params: string[];
  status: CommandStatus;
  userId?: string | null;
  createdAt: Date;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  ackKind?: string | null;
  ackStatus?: string | null;
  ackNode?: string | null;
  resultText?: string | null;
  errorText?: string | null;
  requestIp?: string | null;
  userAgent?: string | null;
  clientFingerprint?: string | null;
}

export interface RemoteCommandRequest {
  id: string;
  siteId: string;
  originSiteId: string;
  target: string;
  name: string;
  params: string[];
  line: string;
  userId?: string | null;
}

export interface ExternalCommandEventInput {
  id: string;
  siteId: string;
  originSiteId?: string | null;
  target: string;
  name: string;
  params: string[];
  status: string;
  userId?: string | null;
  ackKind?: string | null;
  ackStatus?: string | null;
  ackNode?: string | null;
  resultText?: string | null;
  errorText?: string | null;
  createdAt?: string | Date;
  startedAt?: string | Date | null;
  finishedAt?: string | Date | null;
}

export interface CommandInvocationMeta {
  ip?: string | null;
  userAgent?: string | null;
  fingerprint?: string | null;
}

@Injectable()
export class CommandsService {
  private readonly logger = new Logger(CommandsService.name);
  private readonly updates$ = new Subject<CommandState>();
  private readonly remoteRequests$ = new Subject<RemoteCommandRequest>();
  private readonly localSiteId: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly serialService: SerialService,
    private readonly triangulationSessionService: TriangulationSessionService,
    configService: ConfigService,
  ) {
    this.localSiteId = configService.get<string>('site.id', 'default');
  }

  getUpdatesStream(): Observable<CommandState> {
    return this.updates$.asObservable();
  }

  getRemoteRequestsStream(): Observable<RemoteCommandRequest> {
    return this.remoteRequests$.asObservable();
  }

  async sendCommand(
    dto: SendCommandDto,
    userId?: string,
    meta?: CommandInvocationMeta,
  ): Promise<CommandState> {
    const commandId = randomUUID();
    const targetSiteId =
      dto.siteId && dto.siteId.trim().length > 0 ? dto.siteId.trim() : this.localSiteId;
    const built = buildCommandPayload({
      target: dto.target,
      name: dto.name,
      params: dto.params,
    });

    await this.ensureSiteRecord(this.localSiteId);
    await this.ensureSiteRecord(targetSiteId);

    const command = await this.prisma.commandLog.create({
      data: {
        id: commandId,
        siteId: targetSiteId,
        originSiteId: this.localSiteId,
        userId,
        target: built.target,
        name: built.name,
        params: built.params,
        status: 'PENDING',
        requestIp: meta?.ip ?? null,
        userAgent: meta?.userAgent ?? null,
        clientFingerprint: meta?.fingerprint ?? null,
      },
    });

    this.emitUpdate(command);

    if (targetSiteId !== this.localSiteId) {
      this.remoteRequests$.next({
        id: commandId,
        siteId: targetSiteId,
        originSiteId: this.localSiteId,
        target: built.target,
        name: built.name,
        params: built.params,
        line: built.line,
        userId,
      });
      return this.mapCommand(command);
    }

    try {
      await this.serialService.queueCommand({
        id: commandId,
        target: built.target,
        name: built.name,
        params: built.params,
        line: built.line,
        userId,
      });

      const updated = await this.prisma.commandLog.update({
        where: { id: commandId },
        data: {
          status: 'SENT',
          startedAt: new Date(),
        },
      });

      this.emitUpdate(updated);
      return this.mapCommand(updated);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = await this.prisma.commandLog.update({
        where: { id: commandId },
        data: {
          status: 'ERROR',
          errorText: message,
          finishedAt: new Date(),
        },
      });
      this.emitUpdate(failed);
      throw error;
    }
  }

  async findById(id: string): Promise<CommandState> {
    const command = await this.prisma.commandLog.findUnique({ where: { id } });
    if (!command) {
      throw new NotFoundException(`Command ${id} not found`);
    }
    return this.mapCommand(command);
  }

  async handleAck(ack: SerialCommandAck): Promise<void> {
    const commandName = this.mapAckTypeToCommand(ack.ackType);
    if (!commandName) {
      return;
    }

    const command = await this.findLatestMatchingCommand(commandName, ack.nodeId);
    if (!command) {
      return;
    }

    const status = this.deriveStatusFromAck(ack.status, command.status);
    const finishedAt =
      status === 'OK' || status === 'ERROR' ? new Date() : (command.finishedAt ?? undefined);

    const updated = await this.prisma.commandLog.update({
      where: { id: command.id },
      data: {
        ackKind: ack.ackType,
        ackStatus: ack.status,
        ackNode: ack.nodeId,
        status,
        finishedAt,
        errorText: status === 'ERROR' ? ack.raw : command.errorText,
      },
    });

    this.emitUpdate(updated);

    if (ack.ackType === 'TRIANGULATE_ACK' && status === 'OK') {
      const params = Array.isArray(command.params) ? (command.params as string[]) : [];
      const mac = params[0];
      const durationStr = params[1];
      const duration = parseInt(durationStr, 10);

      if (mac && !isNaN(duration) && command.siteId) {
        this.triangulationSessionService.startSession(mac, duration, command.siteId, command.id);
      }
    }

    if (ack.ackType === 'TRIANGULATE_STOP_ACK') {
      const params = Array.isArray(command.params) ? (command.params as string[]) : [];
      const mac = params[0];

      if (mac && command.siteId) {
        this.triangulationSessionService.stopSession(mac, command.siteId);
      }
    }
  }

  async handleResult(result: SerialCommandResult): Promise<void> {
    const command = await this.findLatestMatchingCommand(result.command, result.nodeId);
    if (!command) {
      return;
    }

    const updated = await this.prisma.commandLog.update({
      where: { id: command.id },
      data: {
        resultText: result.payload,
        status: 'OK',
        finishedAt: new Date(),
      },
    });

    this.emitUpdate(updated);
  }

  private emitUpdate(command: CommandLog): void {
    this.updates$.next(this.mapCommand(command));
  }

  async syncExternalCommand(event: ExternalCommandEventInput): Promise<CommandState> {
    const siteId =
      event.siteId && event.siteId.trim().length > 0 ? event.siteId.trim() : this.localSiteId;
    const status = this.normalizeStatus(event.status);

    const createdAt = event.createdAt ? new Date(event.createdAt) : new Date();
    const startedAt = event.startedAt ? new Date(event.startedAt) : null;
    const finishedAt = event.finishedAt ? new Date(event.finishedAt) : null;
    const originSiteId =
      event.originSiteId && event.originSiteId.trim().length > 0
        ? event.originSiteId.trim()
        : siteId;

    await this.ensureSiteRecord(originSiteId);
    if (siteId !== originSiteId) {
      await this.ensureSiteRecord(siteId);
    }

    const resolvedUserId = await this.resolveUserId(event.userId);

    const updateData: Prisma.CommandLogUncheckedUpdateInput = {
      siteId,
      originSiteId,
      target: event.target,
      name: event.name,
      params: event.params,
      status,
      createdAt,
    };

    if (typeof resolvedUserId !== 'undefined') {
      updateData.userId = resolvedUserId;
    }
    if (typeof event.ackKind !== 'undefined') {
      updateData.ackKind = event.ackKind;
    }
    if (typeof event.ackStatus !== 'undefined') {
      updateData.ackStatus = event.ackStatus;
    }
    if (typeof event.ackNode !== 'undefined') {
      updateData.ackNode = event.ackNode;
    }
    if (typeof event.resultText !== 'undefined') {
      updateData.resultText = event.resultText;
    }
    if (typeof event.errorText !== 'undefined') {
      updateData.errorText = event.errorText;
    }
    if (startedAt) {
      updateData.startedAt = startedAt;
    }
    if (finishedAt) {
      updateData.finishedAt = finishedAt;
    }

    let record: CommandLog;
    const existing = await this.prisma.commandLog.findUnique({ where: { id: event.id } });

    if (existing) {
      record = await this.prisma.commandLog.update({
        where: { id: event.id },
        data: updateData,
      });
    } else {
      const createData = this.buildCreateDataFromEvent(
        event,
        siteId,
        originSiteId,
        status,
        createdAt,
        startedAt,
        finishedAt,
        resolvedUserId,
      );
      record = await this.prisma.commandLog.create({
        data: createData,
      });
    }

    this.emitUpdate(record);
    return this.mapCommand(record);
  }

  async executeRemoteRequest(request: RemoteCommandRequest): Promise<CommandState> {
    await this.ensureSiteRecord(request.originSiteId);

    const resolvedUserId = await this.resolveUserId(request.userId);

    const existing = await this.prisma.commandLog.findUnique({ where: { id: request.id } });
    let command = existing;

    if (!command) {
      command = await this.prisma.commandLog.create({
        data: {
          id: request.id,
          siteId: this.localSiteId,
          originSiteId: request.originSiteId,
          target: request.target,
          name: request.name,
          params: request.params,
          status: 'PENDING',
          ...(typeof resolvedUserId !== 'undefined' ? { userId: resolvedUserId } : {}),
        },
      });
    }

    if (command.status !== 'PENDING') {
      return this.mapCommand(command);
    }

    try {
      await this.serialService.queueCommand({
        id: request.id,
        target: request.target,
        name: request.name,
        params: request.params,
        line: request.line,
        userId: resolvedUserId ?? undefined,
      });

      const updated = await this.prisma.commandLog.update({
        where: { id: request.id },
        data: {
          status: 'SENT',
          startedAt: new Date(),
        },
      });

      this.emitUpdate(updated);
      return this.mapCommand(updated);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = await this.prisma.commandLog.update({
        where: { id: request.id },
        data: {
          status: 'ERROR',
          errorText: message,
          finishedAt: new Date(),
        },
      });
      this.emitUpdate(failed);
      throw error;
    }
  }

  private buildCreateDataFromEvent(
    event: ExternalCommandEventInput,
    siteId: string,
    originSiteId: string,
    status: CommandStatus,
    createdAt: Date,
    startedAt: Date | null,
    finishedAt: Date | null,
    userId?: string,
  ): Prisma.CommandLogUncheckedCreateInput {
    const data: Prisma.CommandLogUncheckedCreateInput = {
      id: event.id,
      siteId,
      originSiteId,
      target: event.target,
      name: event.name,
      params: event.params,
      status,
      createdAt,
    };

    if (typeof userId !== 'undefined') {
      data.userId = userId;
    }
    if (typeof event.ackKind !== 'undefined') {
      data.ackKind = event.ackKind;
    }
    if (typeof event.ackStatus !== 'undefined') {
      data.ackStatus = event.ackStatus;
    }
    if (typeof event.ackNode !== 'undefined') {
      data.ackNode = event.ackNode;
    }
    if (typeof event.resultText !== 'undefined') {
      data.resultText = event.resultText;
    }
    if (typeof event.errorText !== 'undefined') {
      data.errorText = event.errorText;
    }
    if (startedAt) {
      data.startedAt = startedAt;
    }
    if (finishedAt) {
      data.finishedAt = finishedAt;
    }

    return data;
  }

  private mapCommand(command: CommandLog): CommandState {
    return {
      id: command.id,
      siteId: command.siteId ?? undefined,
      originSiteId: command.originSiteId ?? undefined,
      target: command.target,
      name: command.name,
      params: Array.isArray(command.params) ? (command.params as string[]) : [],
      status: command.status,
      userId: command.userId,
      createdAt: command.createdAt,
      startedAt: command.startedAt ?? undefined,
      finishedAt: command.finishedAt ?? undefined,
      ackKind: command.ackKind ?? undefined,
      ackStatus: command.ackStatus ?? undefined,
      ackNode: command.ackNode ?? undefined,
      resultText: command.resultText ?? undefined,
      errorText: command.errorText ?? undefined,
      requestIp: command.requestIp ?? undefined,
      userAgent: command.userAgent ?? undefined,
      clientFingerprint: command.clientFingerprint ?? undefined,
    };
  }

  private mapAckTypeToCommand(ackType: string): string | undefined {
    return ACK_TO_COMMAND[ackType];
  }

  private async findLatestMatchingCommand(
    name: string,
    nodeId?: string,
  ): Promise<CommandLog | null> {
    const targets: string[] = [];
    if (nodeId) {
      targets.push(`@${nodeId}`);
      if (nodeId.startsWith('NODE_')) {
        targets.push(`@${nodeId.replace(/^NODE_/, '')}`);
      }
    }

    return this.prisma.commandLog.findFirst({
      where: {
        name,
        status: { in: ['PENDING', 'SENT'] },
        OR:
          nodeId && targets.length > 0
            ? [...targets.map((target) => ({ target })), { target: '@ALL' }]
            : undefined,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  private deriveStatusFromAck(ackStatus: string, current: CommandStatus): CommandStatus {
    const normalized = ackStatus.toUpperCase();
    if (['COMPLETE', 'STOPPED', 'OK', 'FINISHED'].includes(normalized)) {
      return 'OK';
    }
    if (['ERROR', 'FAILED', 'TIMEOUT'].includes(normalized)) {
      return 'ERROR';
    }
    return current === 'PENDING' ? 'SENT' : current;
  }

  private normalizeStatus(status: string): CommandStatus {
    const normalized = status?.toUpperCase();
    if (
      normalized === 'PENDING' ||
      normalized === 'SENT' ||
      normalized === 'OK' ||
      normalized === 'ERROR'
    ) {
      return normalized as CommandStatus;
    }
    return 'PENDING';
  }

  private async resolveUserId(userId?: string | null): Promise<string | undefined> {
    if (!userId) {
      return undefined;
    }

    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true },
      });
      return user?.id;
    } catch (error) {
      this.logger.warn(
        `Failed to resolve remote user ${userId}: ${error instanceof Error ? error.message : error}`,
      );
      return undefined;
    }
  }

  private async ensureSiteRecord(siteId: string) {
    if (!siteId) {
      return;
    }

    await this.prisma.site.upsert({
      where: { id: siteId },
      update: {},
      create: {
        id: siteId,
        name: siteId,
        color: '#2563EB',
      },
    });
  }
}
