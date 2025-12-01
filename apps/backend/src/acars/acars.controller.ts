import { Body, Controller, Get, Post } from '@nestjs/common';

import { AcarsService } from './acars.service';
import type { AcarsMessage, AcarsStatus } from './acars.types';

@Controller('acars')
export class AcarsController {
  constructor(private readonly acarsService: AcarsService) {}

  @Get('status')
  getStatus(): AcarsStatus {
    return this.acarsService.getStatus();
  }

  @Get('messages')
  getMessages(): AcarsMessage[] {
    return this.acarsService.getMessages();
  }

  @Post('config')
  updateConfig(
    @Body() body: { enabled?: boolean; udpHost?: string; udpPort?: number },
  ): AcarsStatus {
    return this.acarsService.updateConfig(body);
  }
}
