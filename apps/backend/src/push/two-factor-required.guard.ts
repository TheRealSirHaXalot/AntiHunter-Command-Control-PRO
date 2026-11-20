import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';

import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TwoFactorRequiredGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const userId = req.auth?.sub;
    if (!userId) {
      throw new ForbiddenException('Missing authentication context');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { twoFactorEnabled: true, isActive: true },
    });
    if (!user?.isActive || !user.twoFactorEnabled) {
      throw new ForbiddenException('Turn on two-factor authentication first (Account > Security).');
    }
    return true;
  }
}
