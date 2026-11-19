import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

export type IdentityRole = 'primary' | 'rescue' | 'operator' | 'revoked';
export type IdentitySource = 'auto-generated' | 'imported' | 'rotated';
export type DriftStatus = 'unknown' | 'in-policy' | 'drift' | 'unreachable';
export type VerifyMethod = 'local-usb' | 'remote-pkc';

const toBytes = (buf: Buffer): Uint8Array<ArrayBuffer> => new Uint8Array(buf);

export interface IdentityRow {
  id: string;
  label: string;
  publicKey: Buffer;
  fingerprint: string;
  role: IdentityRole;
  source: IdentitySource;
  createdAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
  notes: string | null;
}

export interface NodeTrustRow {
  nodeNum: number;
  adminKeyFps: string[];
  isManaged: boolean;
  lastVerifiedAt: Date | null;
  lastVerifyMethod: VerifyMethod | null;
  lastDriftCheckAt: Date | null;
  driftStatus: DriftStatus;
  currentPskFp: string | null;
  previousPskFp: string | null;
  strandedSince: Date | null;
  recoveryAttempts: number;
  lastRecoveryAt: Date | null;
  lastRecoveryError: string | null;
  notes: string | null;
}

export interface ChannelRow {
  channelIndex: number;
  name: string;
  role: string;
  pskFingerprint: string | null;
  pskLength: number | null;
  lastRotatedAt: Date | null;
  lastRotatedBy: string | null;
  lastRotationId: string | null;
}

export type RotationPhase =
  | 'pending'
  | 'phase_b_pushing'
  | 'has_new_psk'
  | 'phase_c_promoting'
  | 'on_new_psk'
  | 'retired'
  | 'failed_b'
  | 'failed_c';

export interface RotationTarget {
  nodeNum: number;
  phase: RotationPhase;
  attempts: number;
  lastError?: string;
}

export interface RotationRow {
  id: string;
  kind: string;
  channelIndex: number | null;
  stagingChannelIndex: number | null;
  piLocalPhase: string;
  startedBy: string | null;
  startedAt: Date;
  completedAt: Date | null;
  retiredAt: Date | null;
  targets: RotationTarget[];
  newPskFp: string | null;
  notes: string | null;
}

export interface FleetPolicyRow {
  expectedAdminKeyFps: string[];
  expectedIsManaged: boolean;
  expectedChannels: Array<{ index: number; name: string; role: string }>;
  updatedAt: Date;
  updatedBy: string | null;
}

export interface JobRow {
  id: string;
  kind: string;
  rotationId: string | null;
  targetNodeNum: number | null;
  state: string;
  attempts: number;
  lastError: string | null;
  payload: Record<string, unknown>;
}

const num = (value: bigint | number): number => Number(value);

@Injectable()
export class FleetStore {
  constructor(private readonly prisma: PrismaService) {}

  // --- identities ---
  async insertIdentity(row: {
    label: string;
    publicKey: Buffer;
    fingerprint: string;
    role: IdentityRole;
    source: IdentitySource;
  }): Promise<IdentityRow> {
    const created = await this.prisma.fleetIdentity.create({
      data: { ...row, publicKey: toBytes(row.publicKey) },
    });
    return this.mapIdentity(created);
  }

  async getIdentityByFingerprint(fingerprint: string): Promise<IdentityRow | null> {
    const row = await this.prisma.fleetIdentity.findUnique({ where: { fingerprint } });
    return row ? this.mapIdentity(row) : null;
  }

  async listIdentities(): Promise<IdentityRow[]> {
    const rows = await this.prisma.fleetIdentity.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map((r) => this.mapIdentity(r));
  }

  async revokeIdentity(fingerprint: string, reason: string): Promise<void> {
    await this.prisma.fleetIdentity.update({
      where: { fingerprint },
      data: { role: 'revoked', revokedAt: new Date(), revokedReason: reason },
    });
  }

  private mapIdentity(row: {
    id: string;
    label: string;
    publicKey: Buffer | Uint8Array;
    fingerprint: string;
    role: string;
    source: string;
    createdAt: Date;
    revokedAt: Date | null;
    revokedReason: string | null;
    notes: string | null;
  }): IdentityRow {
    return {
      id: row.id,
      label: row.label,
      publicKey: Buffer.from(row.publicKey),
      fingerprint: row.fingerprint,
      role: row.role as IdentityRole,
      source: row.source as IdentitySource,
      createdAt: row.createdAt,
      revokedAt: row.revokedAt,
      revokedReason: row.revokedReason,
      notes: row.notes,
    };
  }

  // --- node trust ---
  async listNodeTrust(): Promise<NodeTrustRow[]> {
    const rows = await this.prisma.fleetNodeTrust.findMany();
    return rows.map((r) => this.mapTrust(r));
  }

  async getNodeTrust(nodeNum: number): Promise<NodeTrustRow | null> {
    const row = await this.prisma.fleetNodeTrust.findUnique({
      where: { nodeNum: BigInt(nodeNum) },
    });
    return row ? this.mapTrust(row) : null;
  }

  async upsertNodeTrust(row: {
    nodeNum: number;
    adminKeyFps: string[];
    isManaged: boolean;
    lastVerifiedAt: Date;
    lastVerifyMethod: VerifyMethod;
    lastDriftCheckAt: Date;
    driftStatus: DriftStatus;
  }): Promise<void> {
    const data = {
      adminKeyFps: row.adminKeyFps,
      isManaged: row.isManaged,
      lastVerifiedAt: row.lastVerifiedAt,
      lastVerifyMethod: row.lastVerifyMethod,
      lastDriftCheckAt: row.lastDriftCheckAt,
      driftStatus: row.driftStatus,
    };
    await this.prisma.fleetNodeTrust.upsert({
      where: { nodeNum: BigInt(row.nodeNum) },
      create: { nodeNum: BigInt(row.nodeNum), ...data },
      update: data,
    });
  }

  async markNodeUnreachable(nodeNum: number, at: Date): Promise<void> {
    await this.prisma.fleetNodeTrust.upsert({
      where: { nodeNum: BigInt(nodeNum) },
      create: { nodeNum: BigInt(nodeNum), driftStatus: 'unreachable', lastDriftCheckAt: at },
      update: { driftStatus: 'unreachable', lastDriftCheckAt: at },
    });
  }

  async setNodeCurrentPskFp(nodeNum: number, fp: string): Promise<void> {
    await this.prisma.fleetNodeTrust.update({
      where: { nodeNum: BigInt(nodeNum) },
      data: { currentPskFp: fp },
    });
  }

  async allManagedNodesOnPsk(fp: string): Promise<{ ok: boolean; laggards: number[] }> {
    const managed = await this.prisma.fleetNodeTrust.findMany({ where: { isManaged: true } });
    const laggards = managed.filter((r) => r.currentPskFp !== fp).map((r) => num(r.nodeNum));
    return { ok: laggards.length === 0, laggards };
  }

  private mapTrust(row: {
    nodeNum: bigint;
    adminKeyFps: unknown;
    isManaged: boolean;
    lastVerifiedAt: Date | null;
    lastVerifyMethod: string | null;
    lastDriftCheckAt: Date | null;
    driftStatus: string;
    currentPskFp: string | null;
    previousPskFp: string | null;
    strandedSince: Date | null;
    recoveryAttempts: number;
    lastRecoveryAt: Date | null;
    lastRecoveryError: string | null;
    notes: string | null;
  }): NodeTrustRow {
    return {
      nodeNum: num(row.nodeNum),
      adminKeyFps: Array.isArray(row.adminKeyFps) ? (row.adminKeyFps as string[]) : [],
      isManaged: row.isManaged,
      lastVerifiedAt: row.lastVerifiedAt,
      lastVerifyMethod: row.lastVerifyMethod as VerifyMethod | null,
      lastDriftCheckAt: row.lastDriftCheckAt,
      driftStatus: row.driftStatus as DriftStatus,
      currentPskFp: row.currentPskFp,
      previousPskFp: row.previousPskFp,
      strandedSince: row.strandedSince,
      recoveryAttempts: row.recoveryAttempts,
      lastRecoveryAt: row.lastRecoveryAt,
      lastRecoveryError: row.lastRecoveryError,
      notes: row.notes,
    };
  }

  // --- channels ---
  async listChannels(): Promise<ChannelRow[]> {
    const rows = await this.prisma.fleetChannel.findMany({ orderBy: { channelIndex: 'asc' } });
    return rows.map((r) => ({
      channelIndex: r.channelIndex,
      name: r.name,
      role: r.role,
      pskFingerprint: r.pskFingerprint,
      pskLength: r.pskLength,
      lastRotatedAt: r.lastRotatedAt,
      lastRotatedBy: r.lastRotatedBy,
      lastRotationId: r.lastRotationId,
    }));
  }

  async upsertChannel(row: {
    channelIndex: number;
    name: string;
    role: string;
    pskFingerprint: string | null;
    pskLength: number | null;
    lastRotatedAt?: Date;
    lastRotatedBy?: string;
    lastRotationId?: string;
  }): Promise<void> {
    const data = {
      name: row.name,
      role: row.role,
      pskFingerprint: row.pskFingerprint,
      pskLength: row.pskLength,
      lastRotatedAt: row.lastRotatedAt,
      lastRotatedBy: row.lastRotatedBy,
      lastRotationId: row.lastRotationId,
    };
    await this.prisma.fleetChannel.upsert({
      where: { channelIndex: row.channelIndex },
      create: { channelIndex: row.channelIndex, ...data },
      update: data,
    });
  }

  // --- policy ---
  async getPolicy(): Promise<FleetPolicyRow> {
    const row = await this.prisma.fleetPolicy.upsert({
      where: { id: 1 },
      create: { id: 1 },
      update: {},
    });
    return {
      expectedAdminKeyFps: Array.isArray(row.expectedAdminKeyFps)
        ? (row.expectedAdminKeyFps as string[])
        : [],
      expectedIsManaged: row.expectedIsManaged,
      expectedChannels: Array.isArray(row.expectedChannels)
        ? (row.expectedChannels as Array<{ index: number; name: string; role: string }>)
        : [],
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
    };
  }

  async setPolicy(
    patch: Partial<Pick<FleetPolicyRow, 'expectedAdminKeyFps' | 'expectedIsManaged'>>,
    updatedBy: string,
  ): Promise<void> {
    await this.prisma.fleetPolicy.update({
      where: { id: 1 },
      data: {
        ...(patch.expectedAdminKeyFps ? { expectedAdminKeyFps: patch.expectedAdminKeyFps } : {}),
        ...(patch.expectedIsManaged !== undefined
          ? { expectedIsManaged: patch.expectedIsManaged }
          : {}),
        updatedAt: new Date(),
        updatedBy,
      },
    });
  }

  // --- rotations ---
  async insertRotation(
    row: {
      kind: string;
      channelIndex: number | null;
      startedBy: string;
      targets: RotationTarget[];
      newPskFp: string;
      notes: string;
    },
    newPsk: Buffer,
  ): Promise<string> {
    const created = await this.prisma.fleetRotation.create({
      data: {
        kind: row.kind,
        channelIndex: row.channelIndex,
        startedBy: row.startedBy,
        targets: row.targets as unknown as object,
        newPskFp: row.newPskFp,
        newPsk: toBytes(newPsk),
        notes: row.notes,
      },
    });
    return created.id;
  }

  async getRotation(id: string): Promise<RotationRow | null> {
    const row = await this.prisma.fleetRotation.findUnique({ where: { id } });
    if (!row) return null;
    return {
      id: row.id,
      kind: row.kind,
      channelIndex: row.channelIndex,
      stagingChannelIndex: row.stagingChannelIndex,
      piLocalPhase: row.piLocalPhase,
      startedBy: row.startedBy,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      retiredAt: row.retiredAt,
      targets: Array.isArray(row.targets) ? (row.targets as unknown as RotationTarget[]) : [],
      newPskFp: row.newPskFp,
      notes: row.notes,
    };
  }

  async getRotationPsk(id: string): Promise<Buffer | null> {
    const row = await this.prisma.fleetRotation.findUnique({
      where: { id },
      select: { newPsk: true },
    });
    return row?.newPsk ? Buffer.from(row.newPsk) : null;
  }

  async updateRotationTargets(
    id: string,
    targets: RotationTarget[],
    completedAt: Date | null,
  ): Promise<void> {
    await this.prisma.fleetRotation.update({
      where: { id },
      data: { targets: targets as unknown as object, completedAt: completedAt ?? undefined },
    });
  }

  async setRotationStaging(
    id: string,
    stagingChannelIndex: number,
    piLocalPhase: string,
  ): Promise<void> {
    await this.prisma.fleetRotation.update({
      where: { id },
      data: { stagingChannelIndex, piLocalPhase },
    });
  }

  async markRotationRetired(id: string): Promise<void> {
    await this.prisma.fleetRotation.update({
      where: { id },
      data: { piLocalPhase: 'retired', retiredAt: new Date() },
    });
  }

  async clearRotationPsk(id: string): Promise<void> {
    await this.prisma.fleetRotation.update({ where: { id }, data: { newPsk: null } });
  }

  // --- jobs ---
  async enqueueJob(
    kind: string,
    rotationId: string | null,
    payload: Record<string, unknown>,
  ): Promise<string> {
    const created = await this.prisma.fleetJob.create({
      data: { kind, rotationId, payload: payload as unknown as object },
    });
    return created.id;
  }

  async listJobsByRotation(rotationId: string): Promise<JobRow[]> {
    const rows = await this.prisma.fleetJob.findMany({
      where: { rotationId },
      orderBy: { enqueuedAt: 'desc' },
    });
    return rows.map((r) => this.mapJob(r));
  }

  async claimNextJob(workerId: string): Promise<JobRow | null> {
    return this.prisma.$transaction(async (tx) => {
      const next = await tx.fleetJob.findFirst({
        where: { state: 'queued' },
        orderBy: { enqueuedAt: 'asc' },
      });
      if (!next) return null;
      const claimed = await tx.fleetJob.updateMany({
        where: { id: next.id, state: 'queued' },
        data: { state: 'in_progress', startedAt: new Date(), workerId, attempts: { increment: 1 } },
      });
      if (claimed.count !== 1) return null;
      const row = await tx.fleetJob.findUnique({ where: { id: next.id } });
      return row ? this.mapJob(row) : null;
    });
  }

  async finishJob(id: string, state: 'done' | 'failed', lastError?: string): Promise<void> {
    await this.prisma.fleetJob.update({
      where: { id },
      data: { state, lastError: lastError ?? null, finishedAt: new Date() },
    });
  }

  private mapJob(row: {
    id: string;
    kind: string;
    rotationId: string | null;
    targetNodeNum: bigint | null;
    state: string;
    attempts: number;
    lastError: string | null;
    payload: unknown;
  }): JobRow {
    return {
      id: row.id,
      kind: row.kind,
      rotationId: row.rotationId,
      targetNodeNum: row.targetNodeNum === null ? null : num(row.targetNodeNum),
      state: row.state,
      attempts: row.attempts,
      lastError: row.lastError,
      payload: (row.payload as Record<string, unknown>) ?? {},
    };
  }

  // --- recovery psks ---
  async listRecoveryPsks(): Promise<
    Array<{ slot: number; fp: string; rawPsk: Buffer; pskHash: number }>
  > {
    const rows = await this.prisma.fleetRecoveryPsk.findMany({ orderBy: { slot: 'asc' } });
    return rows.map((r) => ({
      slot: r.slot,
      fp: r.fp,
      rawPsk: Buffer.from(r.rawPsk),
      pskHash: r.pskHash,
    }));
  }

  async upsertRecoveryPsk(row: {
    slot: number;
    fp: string;
    rawPsk: Buffer;
    pskHash: number;
    rotationId: string | null;
  }): Promise<void> {
    const data = {
      fp: row.fp,
      rawPsk: toBytes(row.rawPsk),
      pskHash: row.pskHash,
      rotationId: row.rotationId,
    };
    await this.prisma.fleetRecoveryPsk.upsert({
      where: { slot: row.slot },
      create: { slot: row.slot, ...data },
      update: data,
    });
  }
}
