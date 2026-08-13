import { Body, Controller, Delete, Get, HttpCode, Post, Put, Query } from '@nestjs/common';
import { Role } from '@prisma/client';

import { DeviceClassificationService } from './device-classification.service';
import { UpdateBaselineConfigDto } from './dto/update-baseline-config.dto';
import { Roles } from '../auth/auth.decorators';

@Controller('device-classification')
export class DeviceClassificationController {
  constructor(private readonly service: DeviceClassificationService) {}

  @Get()
  list(@Query('search') search?: string) {
    return this.service.listDevices(search);
  }

  @Get('config')
  getConfig() {
    return this.service.getConfig();
  }

  @Put('config')
  @Roles(Role.ADMIN)
  updateConfig(@Body() dto: UpdateBaselineConfigDto) {
    return this.service.updateConfig(dto);
  }

  @Post('classify')
  classify() {
    return this.service.classifyAll();
  }

  @Post('baseline')
  @Roles(Role.ADMIN)
  establishBaseline() {
    return this.service.establishBaseline();
  }

  @Delete('baseline')
  @Roles(Role.ADMIN)
  resetBaseline() {
    return this.service.resetBaseline();
  }

  @Delete()
  @HttpCode(204)
  @Roles(Role.ADMIN)
  async clear(): Promise<void> {
    await this.service.clear();
  }
}
