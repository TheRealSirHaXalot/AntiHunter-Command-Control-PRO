import { Module } from '@nestjs/common';

import { DeviceClassificationController } from './device-classification.controller';
import { DeviceClassificationService } from './device-classification.service';
import { InventoryModule } from '../inventory/inventory.module';

@Module({
  imports: [InventoryModule],
  controllers: [DeviceClassificationController],
  providers: [DeviceClassificationService],
  exports: [DeviceClassificationService],
})
export class DeviceClassificationModule {}
