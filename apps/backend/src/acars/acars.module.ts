import { Module } from '@nestjs/common';

import { AcarsController } from './acars.controller';
import { AcarsService } from './acars.service';
import { AdsbModule } from '../adsb/adsb.module';
import { WsModule } from '../ws/ws.module';

@Module({
  imports: [WsModule, AdsbModule],
  controllers: [AcarsController],
  providers: [AcarsService],
  exports: [AcarsService],
})
export class AcarsModule {}
