import { INestApplication, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly configService: ConfigService) {
    super({
      adapter: new PrismaPg({
        connectionString: configService.get<string>('database.url', ''),
        connectionTimeoutMillis: 5000,
      }),
      log: [
        { emit: 'event', level: 'query' },
        { emit: 'stdout', level: 'error' },
        { emit: 'stdout', level: 'warn' },
      ],
    });

    const logLevel = this.configService.get<string>('logging.level', 'info');
    if (logLevel === 'debug') {
      this.$on('query' as Parameters<PrismaClient['$on']>[0], (event: Prisma.QueryEvent) => {
        // eslint-disable-next-line no-console -- Prisma query log for diagnostics
        console.debug('Prisma query:', event);
      });
    }
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async enableShutdownHooks(app: INestApplication): Promise<void> {
    this.$on('beforeExit' as Parameters<PrismaClient['$on']>[0], async () => {
      await app.close();
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
