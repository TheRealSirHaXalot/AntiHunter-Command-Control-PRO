import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { RemoteAlertConfig, Role } from '@prisma/client';
import type { Request, Response } from 'express';
import { networkInterfaces } from 'node:os';

import { AlertChannel, AlertChannelsService } from './alert-channels.service';
import { DEVICE_SOURCES } from './alert-sources';
import { UpdateRemoteAlertConfigDto } from './dto/update-remote-alert-config.dto';
import { MatterService } from './matter.service';
import { PushService } from './push.service';
import { RemoteAlertConfigService, tierFor } from './remote-alert-config.service';
import { SignalConnectorService } from './signal-connector.service';
import { TailscaleService } from './tailscale.service';
import { TwoFactorRequiredGuard } from './two-factor-required.guard';
import { Roles } from '../auth/auth.decorators';
import { PrismaService } from '../prisma/prisma.service';

const CHANNELS: AlertChannel[] = ['push', 'ntfy', 'signal', 'matrix', 'matter'];

function view(config: RemoteAlertConfig) {
  const { vapidPrivateKey, ntfyToken, matrixAccessToken, tsAuthKey, ...rest } = config;
  return {
    ...rest,
    hasVapidPrivateKey: Boolean(vapidPrivateKey),
    hasNtfyToken: Boolean(ntfyToken),
    hasMatrixAccessToken: Boolean(matrixAccessToken),
    hasTsAuthKey: Boolean(tsAuthKey),
  };
}

@Controller('remote-alerts')
@Roles(Role.ADMIN)
export class RemoteAlertsController {
  constructor(
    private readonly config: RemoteAlertConfigService,
    private readonly channels: AlertChannelsService,
    private readonly matter: MatterService,
    private readonly push: PushService,
    private readonly prisma: PrismaService,
    private readonly signal: SignalConnectorService,
    private readonly tailscale: TailscaleService,
  ) {}

  @Get('config')
  async getConfig() {
    return view(await this.config.get());
  }

  @Put('config')
  @UseGuards(TwoFactorRequiredGuard)
  async updateConfig(@Body() dto: UpdateRemoteAlertConfigDto) {
    return view(await this.config.update(dto));
  }

  @Delete('config/secret/:field')
  @UseGuards(TwoFactorRequiredGuard)
  async clearSecret(@Param('field') field: string) {
    if (field !== 'ntfyToken' && field !== 'matrixAccessToken') {
      throw new BadRequestException('Unknown secret');
    }
    return view(await this.config.clearSecret(field));
  }

  @Post('vapid/generate')
  @UseGuards(TwoFactorRequiredGuard)
  async generateVapid() {
    return { publicKey: await this.push.generateKeys() };
  }

  @Get('push/subscriptions')
  listSubscriptions() {
    return this.push.listSubscriptions();
  }

  @Delete('push/subscriptions')
  @UseGuards(TwoFactorRequiredGuard)
  async removeSubscription(@Body() body: { endpoint?: string }) {
    if (typeof body?.endpoint !== 'string') {
      throw new BadRequestException('endpoint is required');
    }
    await this.push.removeSubscription(body.endpoint);
    return { ok: true };
  }

  @Post('test/:channel')
  @UseGuards(TwoFactorRequiredGuard)
  async test(@Param('channel') channel: string) {
    if (!CHANNELS.includes(channel as AlertChannel)) {
      throw new BadRequestException('Unknown channel');
    }
    try {
      await this.channels.test(channel as AlertChannel);
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException(
        `Delivery failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { ok: true };
  }

  @Get('signal/status')
  signalStatus() {
    return this.channels.signalStatus();
  }

  @Get('signal/update')
  signalUpdate() {
    return this.signal.checkUpdate();
  }

  @Get('signal/setup')
  signalSetup() {
    return this.signal.setupHint();
  }

  @Get('tailscale/status')
  tailscaleStatus() {
    return this.tailscale.status();
  }

  @Get('signal/link-qr')
  @UseGuards(TwoFactorRequiredGuard)
  async signalLinkQr(@Res() res: Response) {
    const png = await this.channels.signalLinkQr();
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.send(png);
  }

  @Get('sources')
  async sources() {
    const config = await this.config.get();
    const rules = await this.prisma.alertRule.findMany({
      select: { id: true, name: true, isActive: true },
      orderBy: { name: 'asc' },
    });
    const all = [
      ...rules.map((rule) => ({
        key: `rule:${rule.id}`,
        label: `${rule.name}${rule.isActive ? '' : ' (inactive)'}`,
        group: 'Alert rules',
        defaultTier: 'alert' as const,
      })),
      ...DEVICE_SOURCES,
    ];
    return all.map((source) => ({ ...source, tier: tierFor(config, source.key) }));
  }

  @Get('matter/status')
  async matterStatus(@Req() req: Request) {
    const status = this.matter.status();
    const userId = req.auth?.sub;
    const user = userId
      ? await this.prisma.user.findUnique({
          where: { id: userId },
          select: { twoFactorEnabled: true },
        })
      : null;
    if (user?.twoFactorEnabled) {
      return status;
    }
    return { ...status, manualPairingCode: null, qrPairingCode: null, passcode: null };
  }

  @Get('matter/interfaces')
  matterInterfaces() {
    return Object.entries(networkInterfaces()).flatMap(([name, addresses]) => {
      const external = (addresses ?? []).filter((entry) => !entry.internal);
      return external.length ? [{ name, addresses: external.map((entry) => entry.address) }] : [];
    });
  }

  @Post('matter/restart')
  @UseGuards(TwoFactorRequiredGuard)
  async matterRestart() {
    await this.matter.restart();
    return this.matter.status();
  }

  @Post('matter/erase')
  @UseGuards(TwoFactorRequiredGuard)
  async matterErase() {
    await this.matter.erase();
    return this.matter.status();
  }
}
