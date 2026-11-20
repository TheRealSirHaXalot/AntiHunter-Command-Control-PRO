import { Controller, Delete, Get } from '@nestjs/common';
import { Role } from '@prisma/client';

import { BaselineEventsService } from './baseline-events.service';
import { Roles } from '../auth/auth.decorators';

@Controller('baseline/events')
export class BaselineEventsController {
  constructor(private readonly baselineEvents: BaselineEventsService) {}

  @Get()
  list() {
    return this.baselineEvents.list();
  }

  @Delete()
  @Roles(Role.ADMIN, Role.OPERATOR)
  clear() {
    return this.baselineEvents.clear();
  }
}
