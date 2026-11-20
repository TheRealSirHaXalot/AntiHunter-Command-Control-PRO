import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Request } from 'express';

import { CommandsService } from './commands.service';
import { SendCommandDto } from './dto/send-command.dto';
import { Roles } from '../auth/auth.decorators';

@Controller('commands')
export class CommandsController {
  constructor(private readonly commandsService: CommandsService) {}

  @Post('send')
  @Roles(Role.ADMIN, Role.OPERATOR)
  async send(@Req() req: Request, @Body() dto: SendCommandDto) {
    const meta = {
      role: req.auth?.role ?? null,
      ip: req.ip ?? req.socket.remoteAddress ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      fingerprint:
        (req.headers['x-client-fingerprint'] as string | undefined) ??
        (req.headers['x-request-id'] as string | undefined) ??
        null,
    };
    return this.commandsService.sendCommand(dto, req.auth?.sub, meta);
  }

  @Get(':id')
  async getById(@Param('id') id: string) {
    return this.commandsService.findById(id);
  }
}
