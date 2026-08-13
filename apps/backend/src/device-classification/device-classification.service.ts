import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DeviceBaselineConfig, DevicePresence, InventoryDevice } from '@prisma/client';
import { Subscription, concatMap, from } from 'rxjs';

import { classifyDevice, smartName, ClassificationParams } from './device-classification.types';
import { UpdateBaselineConfigDto } from './dto/update-baseline-config.dto';
import { InventoryService } from '../inventory/inventory.service';
import { PrismaService } from '../prisma/prisma.service';

export interface ClassificationSummary {
  classified: number;
  counts: Record<string, number>;
  at: string;
}

@Injectable()
export class DeviceClassificationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DeviceClassificationService.name);
  private subscription?: Subscription;
  private autoTimer?: ReturnType<typeof setInterval>;
  private config!: DeviceBaselineConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventoryService: InventoryService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.config = await this.loadConfig();
    this.subscription = this.inventoryService
      .getUpdatesStream()
      .pipe(concatMap((device) => from(this.record(device))))
      .subscribe();
    this.scheduleAutoClassify();
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
    if (this.autoTimer) {
      clearInterval(this.autoTimer);
    }
  }

  private async loadConfig(): Promise<DeviceBaselineConfig> {
    const existing = await this.prisma.deviceBaselineConfig.findFirst();
    if (existing) {
      return existing;
    }
    return this.prisma.deviceBaselineConfig.create({ data: {} });
  }

  private scheduleAutoClassify(): void {
    if (this.autoTimer) {
      clearInterval(this.autoTimer);
    }
    const minutes = Math.max(1, this.config.autoClassifyMinutes);
    this.autoTimer = setInterval(() => {
      void this.classifyAll().catch((error) =>
        this.logger.warn(
          `Auto-classify failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }, minutes * 60_000);
  }

  private async record(device: InventoryDevice): Promise<void> {
    try {
      const mac = device.mac;
      const ts = device.lastSeen ? device.lastSeen.getTime() : Date.now();
      const tsDate = new Date(ts);
      const nodeId = device.lastNodeId ?? null;
      const existing = await this.prisma.devicePresence.findUnique({ where: { mac } });

      if (!existing) {
        const visit = await this.prisma.deviceVisit.create({
          data: { mac, siteId: device.siteId, start: tsDate, end: tsDate, hits: 1, nodeId },
        });
        await this.prisma.devicePresence.create({
          data: {
            mac,
            siteId: device.siteId,
            vendor: device.vendor,
            firstSeen: tsDate,
            lastSeen: tsDate,
            hits: 1,
            minRssi: device.minRSSI,
            maxRssi: device.maxRSSI,
            nodeIds: nodeId ? [nodeId] : [],
            currentVisitId: visit.id,
          },
        });
        return;
      }

      const gapMs = this.config.gapThresholdMinutes * 60_000;
      const newVisit = !existing.currentVisitId || ts - existing.lastSeen.getTime() > gapMs;
      let currentVisitId = existing.currentVisitId;

      if (newVisit) {
        const visit = await this.prisma.deviceVisit.create({
          data: { mac, siteId: device.siteId, start: tsDate, end: tsDate, hits: 1, nodeId },
        });
        currentVisitId = visit.id;
      } else {
        try {
          await this.prisma.deviceVisit.update({
            where: { id: existing.currentVisitId! },
            data: { end: tsDate, hits: { increment: 1 }, ...(nodeId ? { nodeId } : {}) },
          });
        } catch {
          const visit = await this.prisma.deviceVisit.create({
            data: { mac, siteId: device.siteId, start: tsDate, end: tsDate, hits: 1, nodeId },
          });
          currentVisitId = visit.id;
        }
      }

      const nodeIds =
        nodeId && !existing.nodeIds.includes(nodeId)
          ? [...existing.nodeIds, nodeId]
          : existing.nodeIds;

      await this.prisma.devicePresence.update({
        where: { mac },
        data: {
          siteId: device.siteId ?? existing.siteId,
          vendor: device.vendor ?? existing.vendor,
          lastSeen: tsDate,
          hits: { increment: 1 },
          minRssi: device.minRSSI ?? existing.minRssi,
          maxRssi: device.maxRSSI ?? existing.maxRssi,
          nodeIds,
          currentVisitId,
        },
      });
    } catch (error) {
      this.logger.warn(
        `Failed to record presence for ${device.mac}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async classifyAll(): Promise<ClassificationSummary> {
    const cfg = this.config;
    const now = Date.now();
    const windowMs = cfg.rollingWindowMinutes * 60_000;
    const baselineStart = cfg.baselineStart ? cfg.baselineStart.getTime() : null;
    const params: ClassificationParams = {
      now,
      baselineStart,
      windowMs,
      gapMs: cfg.gapThresholdMinutes * 60_000,
      frequentFlierVisits: cfg.frequentFlierVisits,
      visitorAbsenceMs: cfg.visitorAbsenceMinutes * 60_000,
      stationaryPresencePct: cfg.stationaryPresencePct,
    };
    const rollingStart = now - windowMs;
    const windowStart =
      baselineStart != null ? Math.max(baselineStart, rollingStart) : rollingStart;
    const windowStartDate = new Date(windowStart);

    const devices = await this.prisma.devicePresence.findMany();
    const visits = await this.prisma.deviceVisit.findMany({
      where: { end: { gte: windowStartDate } },
      select: { mac: true, start: true, end: true },
    });

    const byMac = new Map<string, Array<{ start: number; end: number }>>();
    for (const v of visits) {
      const list = byMac.get(v.mac) ?? [];
      list.push({ start: v.start.getTime(), end: v.end.getTime() });
      byMac.set(v.mac, list);
    }

    const counts: Record<string, number> = {
      stationary: 0,
      'frequent-flier': 0,
      visitor: 0,
      new: 0,
      transient: 0,
    };
    const updates = [];
    for (const device of devices) {
      const vs = byMac.get(device.mac) ?? [];
      let visitsInWindow = 0;
      let presenceMs = 0;
      for (const v of vs) {
        if (v.end < windowStart) continue;
        const s = Math.max(v.start, windowStart);
        const e = Math.max(s, v.end);
        visitsInWindow += 1;
        presenceMs += e - s;
      }
      const category = classifyDevice(
        {
          firstSeen: device.firstSeen.getTime(),
          lastSeen: device.lastSeen.getTime(),
          visitsInWindow,
          presenceMsInWindow: presenceMs,
        },
        params,
      );
      counts[category] += 1;
      updates.push(
        this.prisma.devicePresence.update({
          where: { mac: device.mac },
          data: {
            category,
            smartName: smartName(category, device.mac),
            classifiedAt: new Date(now),
          },
        }),
      );
    }

    if (updates.length > 0) {
      await this.prisma.$transaction(updates);
    }

    return { classified: devices.length, counts, at: new Date(now).toISOString() };
  }

  getConfig(): DeviceBaselineConfig {
    return this.config;
  }

  async updateConfig(dto: UpdateBaselineConfigDto): Promise<DeviceBaselineConfig> {
    this.config = await this.prisma.deviceBaselineConfig.update({
      where: { id: this.config.id },
      data: { ...dto },
    });
    this.scheduleAutoClassify();
    return this.config;
  }

  async establishBaseline(): Promise<ClassificationSummary> {
    this.config = await this.prisma.deviceBaselineConfig.update({
      where: { id: this.config.id },
      data: { baselineStart: new Date() },
    });
    return this.classifyAll();
  }

  async resetBaseline(): Promise<DeviceBaselineConfig> {
    this.config = await this.prisma.deviceBaselineConfig.update({
      where: { id: this.config.id },
      data: { baselineStart: null },
    });
    return this.config;
  }

  listDevices(search?: string): Promise<DevicePresence[]> {
    const term = search?.trim();
    return this.prisma.devicePresence.findMany({
      where: term
        ? {
            OR: [
              { mac: { contains: term, mode: 'insensitive' } },
              { vendor: { contains: term, mode: 'insensitive' } },
              { smartName: { contains: term, mode: 'insensitive' } },
              { category: { contains: term, mode: 'insensitive' } },
            ],
          }
        : undefined,
      orderBy: [{ lastSeen: 'desc' }],
      take: 500,
    });
  }

  async clear(): Promise<void> {
    await this.prisma.deviceVisit.deleteMany();
    await this.prisma.devicePresence.deleteMany();
  }
}
