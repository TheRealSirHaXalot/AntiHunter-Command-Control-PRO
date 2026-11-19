import { forwardRef, Module } from '@nestjs/common';

import { CommandCenterGateway } from './command-center.gateway';
import { AuthModule } from '../auth/auth.module';
import { CommandsModule } from '../commands/commands.module';
import { DronesModule } from '../drones/drones.module';
import { FirewallModule } from '../firewall/firewall.module';
import { GeofencesModule } from '../geofences/geofences.module';
import { NodesModule } from '../nodes/nodes.module';

@Module({
  imports: [
    NodesModule,
    CommandsModule,
    AuthModule,
    GeofencesModule,
    FirewallModule,
    forwardRef(() => DronesModule),
  ],
  providers: [CommandCenterGateway],
  exports: [CommandCenterGateway],
})
export class WsModule {}
