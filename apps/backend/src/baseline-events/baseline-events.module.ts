import { Module } from '@nestjs/common';

import { BaselineEventsController } from './baseline-events.controller';
import { BaselineEventsService } from './baseline-events.service';

@Module({
  controllers: [BaselineEventsController],
  providers: [BaselineEventsService],
  exports: [BaselineEventsService],
})
export class BaselineEventsModule {}
