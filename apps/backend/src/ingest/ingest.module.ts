import { Module } from '@nestjs/common';

import { AlertRulesModule } from '../alert-rules/alert-rules.module';
import { BaselineEventsModule } from '../baseline-events/baseline-events.module';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { CommandsModule } from '../commands/commands.module';
import { DronesModule } from '../drones/drones.module';
import { InventoryModule } from '../inventory/inventory.module';
import { KnownRadiosModule } from '../known-radios/known-radios.module';
import { NodesModule } from '../nodes/nodes.module';
import { ProbeInventoryModule } from '../probe-inventory/probe-inventory.module';
import { SerialIngestService } from '../serial/serial-ingest.service';
import { SerialModule } from '../serial/serial.module';
import { TakModule } from '../tak/tak.module';
import { TargetsModule } from '../targets/targets.module';
import { TargetTrackingService } from '../tracking/target-tracking.service';
import { TriangulationModule } from '../triangulation/triangulation.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { WsModule } from '../ws/ws.module';

@Module({
  imports: [
    SerialModule,
    NodesModule,
    InventoryModule,
    CommandsModule,
    WsModule,
    TargetsModule,
    TakModule,
    DronesModule,
    AlertRulesModule,
    WebhooksModule,
    TriangulationModule,
    ProbeInventoryModule,
    CampaignsModule,
    KnownRadiosModule,
    BaselineEventsModule,
  ],
  providers: [SerialIngestService, TargetTrackingService],
})
export class IngestModule {}
