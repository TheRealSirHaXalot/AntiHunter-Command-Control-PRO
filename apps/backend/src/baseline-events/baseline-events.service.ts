import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

export type BaselineEventKind = 'status' | 'done' | 'anomaly';

export interface BaselineAlertPayload {
  type: 'event.alert';
  timestamp: string;
  category?: string;
  nodeId?: string;
  data?: unknown;
  siteId?: string | null;
  [key: string]: unknown;
}

export interface BaselineEventRecord {
  id: string;
  kind: BaselineEventKind;
  createdAt: string;
  payload: BaselineAlertPayload;
}

export const MAX_ANOMALIES = 300;
const MAX_STORED_ANOMALIES = 1000;
const PRUNE_EVERY = 100;

export function classifyBaselineAlert(
  category: string | undefined,
  data: unknown,
): BaselineEventKind | null {
  const normalized = category?.toLowerCase() ?? '';
  const fields = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  if (normalized === 'baseline-done') {
    return 'done';
  }
  if (normalized === 'anomaly') {
    return 'anomaly';
  }
  if (normalized === 'baseline') {
    if (fields.event === 'device-disappeared') {
      return 'anomaly';
    }
    if ('scanning' in fields || 'established' in fields) {
      return 'status';
    }
  }
  return null;
}

@Injectable()
export class BaselineEventsService {
  private readonly logger = new Logger(BaselineEventsService.name);
  private anomalyInserts = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly prisma: PrismaService) {}

  record(payload: BaselineAlertPayload): Promise<void> {
    const kind = classifyBaselineAlert(payload.category, payload.data);
    if (!kind || !payload.nodeId) {
      return Promise.resolve();
    }
    const nodeId = payload.nodeId;
    const task = this.queue.then(() => this.store(kind, nodeId, payload));
    this.queue = task.catch((error) =>
      this.logger.warn(
        `Failed to store baseline event: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    return this.queue;
  }

  async list(): Promise<BaselineEventRecord[]> {
    const [latest, anomalies] = await Promise.all([
      this.prisma.baselineEvent.findMany({
        where: { kind: { in: ['status', 'done'] } },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.baselineEvent.findMany({
        where: { kind: 'anomaly' },
        orderBy: { createdAt: 'desc' },
        take: MAX_ANOMALIES,
      }),
    ]);
    return [...latest, ...anomalies.reverse()].map((row) => ({
      id: row.id,
      kind: row.kind as BaselineEventKind,
      createdAt: row.createdAt.toISOString(),
      payload: row.payload as unknown as BaselineAlertPayload,
    }));
  }

  async clear(): Promise<{ deleted: number }> {
    await this.queue;
    const { count } = await this.prisma.baselineEvent.deleteMany({});
    return { deleted: count };
  }

  private async store(
    kind: BaselineEventKind,
    nodeId: string,
    payload: BaselineAlertPayload,
  ): Promise<void> {
    const data = {
      nodeId,
      siteId: payload.siteId ?? null,
      kind,
      payload: payload as unknown as Prisma.InputJsonValue,
      createdAt: new Date(payload.timestamp),
    };
    if (kind !== 'anomaly') {
      await this.prisma.$transaction([
        this.prisma.baselineEvent.deleteMany({ where: { nodeId, kind } }),
        this.prisma.baselineEvent.create({ data }),
      ]);
      return;
    }
    await this.prisma.baselineEvent.create({ data });
    this.anomalyInserts += 1;
    if (this.anomalyInserts % PRUNE_EVERY === 0) {
      await this.pruneAnomalies();
    }
  }

  private async pruneAnomalies(): Promise<void> {
    const cutoff = await this.prisma.baselineEvent.findFirst({
      where: { kind: 'anomaly' },
      orderBy: { createdAt: 'desc' },
      skip: MAX_STORED_ANOMALIES - 1,
      select: { createdAt: true },
    });
    if (!cutoff) {
      return;
    }
    await this.prisma.baselineEvent.deleteMany({
      where: { kind: 'anomaly', createdAt: { lt: cutoff.createdAt } },
    });
  }
}
