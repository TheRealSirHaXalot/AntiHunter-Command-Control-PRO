import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { generateVAPIDKeys, sendNotification } from 'web-push';

import { RemoteAlertConfigService } from './remote-alert-config.service';
import { PrismaService } from '../prisma/prisma.service';

const PUSH_HOST_SUFFIXES = [
  'fcm.googleapis.com',
  'push.services.mozilla.com',
  'push.apple.com',
  'notify.windows.com',
];

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushDeliveryResult {
  configured: boolean;
  sent: number;
  failed: number;
  gone: number;
  failures: { service: string; status: number | null; message: string }[];
}

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: RemoteAlertConfigService,
  ) {}

  private creating: Promise<unknown> | null = null;

  private async vapid() {
    let config = await this.config.get();
    if (!config.vapidPublicKey || !config.vapidPrivateKey) {
      this.creating ??= (async () => {
        const keys = generateVAPIDKeys();
        await this.config.setVapidKeys(keys.publicKey, keys.privateKey);
        this.logger.log('Generated push notification keys');
      })().finally(() => {
        this.creating = null;
      });
      await this.creating;
      config = await this.config.get();
    }
    if (!config.vapidPublicKey || !config.vapidPrivateKey) {
      return null;
    }
    return {
      subject: config.vapidSubject || 'https://github.com/lukeswitz/AntiHunter-Command-Control-PRO',
      publicKey: config.vapidPublicKey,
      privateKey: config.vapidPrivateKey,
    };
  }

  async getPublicKey(): Promise<string | null> {
    return (await this.vapid())?.publicKey ?? null;
  }

  async generateKeys(): Promise<string> {
    const keys = generateVAPIDKeys();
    await this.config.setVapidKeys(keys.publicKey, keys.privateKey);
    await this.prisma.pushSubscription.deleteMany({});
    return keys.publicKey;
  }

  async listSubscriptions() {
    const rows = await this.prisma.pushSubscription.findMany({
      include: { user: { select: { email: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => ({
      endpoint: row.endpoint,
      service: new URL(row.endpoint).hostname,
      userEmail: row.user.email,
      createdAt: row.createdAt,
    }));
  }

  async removeSubscription(endpoint: string): Promise<void> {
    await this.prisma.pushSubscription.deleteMany({ where: { endpoint } });
  }

  async subscribe(userId: string, input: PushSubscriptionInput): Promise<void> {
    if (!(await this.vapid())) {
      throw new ServiceUnavailableException('Push notifications are not configured');
    }
    const endpoint = this.validateEndpoint(input?.endpoint);
    const p256dh = input?.keys?.p256dh;
    const auth = input?.keys?.auth;
    if (
      typeof p256dh !== 'string' ||
      typeof auth !== 'string' ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(p256dh) ||
      !/^[A-Za-z0-9_-]{8,64}$/.test(auth)
    ) {
      throw new BadRequestException('Invalid subscription keys');
    }
    const existing = await this.prisma.pushSubscription.findUnique({ where: { endpoint } });
    if (existing && existing.userId !== userId) {
      throw new ConflictException('This device is registered to another user');
    }
    await this.prisma.pushSubscription.upsert({
      where: { endpoint },
      create: { endpoint, p256dh, auth, userId },
      update: { p256dh, auth },
    });
  }

  async unsubscribe(userId: string, endpoint: string): Promise<void> {
    await this.prisma.pushSubscription.deleteMany({ where: { endpoint, userId } });
  }

  async notify(title: string, body: string, onlyUserId?: string): Promise<PushDeliveryResult> {
    const vapidDetails = await this.vapid();
    if (!vapidDetails) {
      return { configured: false, sent: 0, failed: 0, gone: 0, failures: [] };
    }
    const subscriptions = await this.prisma.pushSubscription.findMany({
      where: { user: { isActive: true }, ...(onlyUserId ? { userId: onlyUserId } : {}) },
    });
    if (!subscriptions.length) {
      return { configured: true, sent: 0, failed: 0, gone: 0, failures: [] };
    }
    const payload = JSON.stringify({
      title: title.slice(0, 120),
      body: body.slice(0, 1500),
      url: '/alerts/events',
    });
    const result: PushDeliveryResult = {
      configured: true,
      sent: 0,
      failed: 0,
      gone: 0,
      failures: [],
    };
    await Promise.all(
      subscriptions.map(async (sub) => {
        try {
          await sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload,
            { TTL: 3600, urgency: 'high', vapidDetails },
          );
          result.sent += 1;
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode;
          const message = error instanceof Error ? error.message : String(error);
          if (status === 404 || status === 410) {
            await this.prisma.pushSubscription.deleteMany({ where: { endpoint: sub.endpoint } });
            result.gone += 1;
            return;
          }
          result.failed += 1;
          result.failures.push({
            service: new URL(sub.endpoint).hostname,
            status: status ?? null,
            message,
          });
          this.logger.warn(`Push delivery failed (${status ?? 'network'}): ${message}`);
        }
      }),
    );
    return result;
  }

  private validateEndpoint(raw: unknown): string {
    if (typeof raw !== 'string' || raw.length > 1024) {
      throw new BadRequestException('Invalid subscription endpoint');
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new BadRequestException('Invalid subscription endpoint');
    }
    const host = url.hostname.toLowerCase();
    const allowed = PUSH_HOST_SUFFIXES.some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`),
    );
    if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password || !allowed) {
      throw new BadRequestException('Subscription endpoint is not a known push service');
    }
    return url.toString();
  }
}
