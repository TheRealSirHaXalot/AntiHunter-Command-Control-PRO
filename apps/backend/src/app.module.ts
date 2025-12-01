import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';

import { AcarsModule } from './acars/acars.module';
import { AdsbModule } from './adsb/adsb.module';
import { AlarmsModule } from './alarms/alarms.module';
import { AlertRulesModule } from './alert-rules/alert-rules.module';
import { AppConfigModule } from './app-config/app-config.module';
import { AuthModule } from './auth/auth.module';
import { ChatModule } from './chat/chat.module';
import { CommandsModule } from './commands/commands.module';
import configuration from './config/configuration';
import { validateEnvironment } from './config/environment.validation';
import { DronesModule } from './drones/drones.module';
import { EventsModule } from './events/events.module';
import { ExportsModule } from './exports/exports.module';
import { FaaModule } from './faa/faa.module';
import { FirewallMiddleware } from './firewall/firewall.middleware';
import { FirewallModule } from './firewall/firewall.module';
import { GeofencesModule } from './geofences/geofences.module';
import { HealthModule } from './health/health.module';
import { IngestModule } from './ingest/ingest.module';
import { InventoryModule } from './inventory/inventory.module';
import { MailModule } from './mail/mail.module';
import { MqttModule } from './mqtt/mqtt.module';
import { NodesModule } from './nodes/nodes.module';
import { OuiModule } from './oui/oui.module';
import { PrismaModule } from './prisma/prisma.module';
import { SerialModule } from './serial/serial.module';
import { SitesModule } from './sites/sites.module';
import { TakModule } from './tak/tak.module';
import { TargetsModule } from './targets/targets.module';
import { UsersModule } from './users/users.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { WsModule } from './ws/ws.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [configuration],
      validate: validateEnvironment,
      expandVariables: true,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const env = configService.get<string>('env', 'development');
        const level = configService.get<string>('logging.level', 'info');
        const structured = configService.get<boolean>('logging.structured', true);
        const pretty = env !== 'production' || !structured;

        return {
          pinoHttp: {
            level,
            transport: pretty
              ? {
                  target: 'pino-pretty',
                  options: {
                    colorize: true,
                    singleLine: false,
                    translateTime: 'SYS:standard',
                  },
                }
              : undefined,
            base: undefined,
          },
        };
      },
    }),
    PrismaModule,
    AuthModule,
    AppConfigModule,
    HealthModule,
    SerialModule,
    NodesModule,
    DronesModule,
    InventoryModule,
    AcarsModule,
    AdsbModule,
    CommandsModule,
    EventsModule,
    ChatModule,
    WsModule,
    IngestModule,
    AlarmsModule,
    SitesModule,
    TakModule,
    TargetsModule,
    GeofencesModule,
    AlertRulesModule,
    FirewallModule,
    FaaModule,
    OuiModule,
    MqttModule,
    MailModule,
    UsersModule,
    ExportsModule,
    WebhooksModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(FirewallMiddleware).forRoutes('*');
  }
}
