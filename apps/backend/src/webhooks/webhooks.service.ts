import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';

import { CreateWebhookDto } from './dto/create-webhook.dto';
import { UpdateWebhookDto } from './dto/update-webhook.dto';
import { WebhookDispatcherService } from './webhook-dispatcher.service';
import { WebhookDto } from './webhook.dto';
import { PrismaService } from '../prisma/prisma.service';

const webhookInclude = {
  owner: {
    select: { id: true, email: true, firstName: true, lastName: true },
  },
  deliveries: {
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      id: true,
      statusCode: true,
      success: true,
      errorMessage: true,
      triggeredAt: true,
      completedAt: true,
    },
  },
} as const;

type WebhookEntity = Prisma.WebhookGetPayload<{ include: typeof webhookInclude }>;

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatcher: WebhookDispatcherService,
  ) {}

  async list(userId: string, role: Role): Promise<WebhookDto[]> {
    const where = this.buildAccessFilter(userId, role);
    const hooks = await this.prisma.webhook.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }],
      include: webhookInclude,
    });
    return hooks.map((hook) => this.toDto(hook));
  }

  async create(userId: string, role: Role, dto: CreateWebhookDto): Promise<WebhookDto> {
    if (dto.shareWithEveryone && role !== Role.ADMIN) {
      throw new ForbiddenException('ONLY_ADMIN_CAN_SHARE_WEBHOOKS');
    }
    const hook = await this.prisma.webhook.create({
      data: {
        name: dto.name.trim(),
        url: this.ensureHttpsUrl(dto.url),
        secret: dto.secret?.trim() || null,
        verifyTls: dto.verifyTls ?? true,
        clientCert: this.normalizePem(dto.clientCertificate),
        clientKey: this.normalizePem(dto.clientKey),
        caBundle: this.normalizePem(dto.caBundle),
        enabled: dto.enabled ?? true,
        ownerId: dto.shareWithEveryone ? null : userId,
      },
      include: webhookInclude,
    });
    this.logger.log(`Webhook ${hook.id} created by ${userId}`);
    this.dispatcher.invalidateSubscriberCache();
    return this.toDto(hook);
  }

  async update(id: string, userId: string, role: Role, dto: UpdateWebhookDto): Promise<WebhookDto> {
    const existing = await this.requireWebhook(id, userId, role);
    if (dto.shareWithEveryone && role !== Role.ADMIN) {
      throw new ForbiddenException('ONLY_ADMIN_CAN_SHARE_WEBHOOKS');
    }
    const updated = await this.prisma.webhook.update({
      where: { id },
      data: {
        name: dto.name?.trim() ?? existing.name,
        url: dto.url ? this.ensureHttpsUrl(dto.url) : existing.url,
        secret: dto.secret !== undefined ? dto.secret?.trim() || null : existing.secret,
        verifyTls: dto.verifyTls ?? existing.verifyTls,
        clientCert:
          dto.clientCertificate !== undefined
            ? this.normalizePem(dto.clientCertificate)
            : existing.clientCert,
        clientKey:
          dto.clientKey !== undefined ? this.normalizePem(dto.clientKey) : existing.clientKey,
        caBundle: dto.caBundle !== undefined ? this.normalizePem(dto.caBundle) : existing.caBundle,
        enabled: dto.enabled ?? existing.enabled,
        ownerId:
          dto.shareWithEveryone !== undefined
            ? dto.shareWithEveryone
              ? null
              : (existing.ownerId ?? userId)
            : existing.ownerId,
      },
      include: webhookInclude,
    });
    this.logger.log(`Webhook ${id} updated by ${userId}`);
    this.dispatcher.invalidateSubscriberCache();
    return this.toDto(updated);
  }

  async remove(id: string, userId: string, role: Role): Promise<void> {
    await this.requireWebhook(id, userId, role);
    await this.prisma.webhook.delete({ where: { id } });
    this.logger.log(`Webhook ${id} removed by ${userId}`);
    this.dispatcher.invalidateSubscriberCache();
  }

  async triggerTest(id: string, userId: string, role: Role) {
    const webhook = await this.requireWebhook(id, userId, role);
    await this.dispatcher.sendTest(webhook);
    const refreshed = await this.requireWebhook(id, userId, role);
    return this.toDto(refreshed);
  }

  private async requireWebhook(id: string, userId: string, role: Role): Promise<WebhookEntity> {
    const hook = await this.prisma.webhook.findUnique({
      where: { id },
      include: webhookInclude,
    });
    if (!hook) {
      throw new NotFoundException(`Webhook ${id} not found`);
    }
    if (role !== Role.ADMIN && hook.ownerId !== userId && hook.ownerId !== null) {
      throw new ForbiddenException('INSUFFICIENT_WEBHOOK_ACCESS');
    }
    return hook;
  }

  private buildAccessFilter(userId: string, role: Role): Prisma.WebhookWhereInput {
    if (role === Role.ADMIN) {
      return {};
    }
    return {
      OR: [{ ownerId: userId }, { ownerId: null }],
    };
  }

  private ensureHttpsUrl(value: string): string {
    const trimmed = value.trim();
    if (!trimmed.toLowerCase().startsWith('https://')) {
      throw new BadRequestException('Webhook URL must use HTTPS');
    }
    try {
      // eslint-disable-next-line no-new
      new URL(trimmed);
    } catch {
      throw new BadRequestException('Invalid webhook URL');
    }
    return trimmed;
  }

  private toDto(entity: WebhookEntity): WebhookDto {
    return {
      id: entity.id,
      name: entity.name,
      url: entity.url,
      enabled: entity.enabled,
      verifyTls: entity.verifyTls,
      shared: entity.ownerId == null,
      clientCertificate: entity.clientCert ?? undefined,
      clientKey: entity.clientKey ?? undefined,
      caBundle: entity.caBundle ?? undefined,
      lastSuccessAt: entity.lastSuccessAt ?? undefined,
      lastFailureAt: entity.lastFailureAt ?? undefined,
      owner: entity.owner
        ? {
            id: entity.owner.id,
            email: entity.owner.email,
            firstName: entity.owner.firstName,
            lastName: entity.owner.lastName,
          }
        : null,
      recentDeliveries:
        entity.deliveries?.map((delivery) => ({
          id: delivery.id,
          statusCode: delivery.statusCode ?? undefined,
          success: delivery.success,
          errorMessage: delivery.errorMessage ?? undefined,
          triggeredAt: delivery.triggeredAt,
          completedAt: delivery.completedAt ?? undefined,
        })) ?? [],
    };
  }

  private normalizePem(value?: string | null): string | null {
    if (!value) {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
}
