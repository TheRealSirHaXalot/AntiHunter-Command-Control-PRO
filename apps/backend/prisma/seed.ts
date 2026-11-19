import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Role, SiteAccessLevel } from '@prisma/client';
import * as argon2 from 'argon2';
import { DEFAULT_FEATURES_BY_ROLE } from '../src/users/user-permissions.constants';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

async function main() {
  const adminPassword = process.env.ADMIN_PASSWORD ?? 'admin';
  const adminEmail = process.env.ADMIN_EMAIL ?? 'admin@example.com';

  await prisma.appConfig.upsert({
    where: { id: 1 },
    update: {},
    create: {},
  });

  await prisma.alarmConfig.upsert({
    where: { id: 1 },
    update: {},
    create: {},
  });

  await prisma.visualConfig.upsert({
    where: { id: 1 },
    update: {},
    create: {},
  });

  await prisma.coverageConfig.upsert({
    where: { id: 1 },
    update: {},
    create: {},
  });

  const seedSiteId = process.env.SITE_ID ?? 'default';
  const seedSiteName =
    process.env.SITE_NAME ?? (seedSiteId === 'default' ? 'Default Site' : seedSiteId);

  await prisma.site.upsert({
    where: { id: seedSiteId },
    update: {},
    create: {
      id: seedSiteId,
      name: seedSiteName,
      color: '#2E7D32',
    },
  });

  await prisma.serialConfig.upsert({
    where: { id: 'serial' },
    update: {},
    create: {
      id: 'serial',
    },
  });

  await prisma.mqttConfig.upsert({
    where: { siteId: seedSiteId },
    update: {},
    create: {
      brokerUrl: 'mqtt://localhost:1883',
      clientId: `command-center-${seedSiteId}`,
      siteId: seedSiteId,
    },
  });

  const passwordHash = await argon2.hash(adminPassword);
  await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
      passwordHash,
      role: Role.ADMIN,
      legalAcceptedAt: null,
      firstName: 'Admin',
      lastName: 'User',
      jobTitle: 'System Administrator',
      preferences: {
        create: {
          theme: 'dark',
          density: 'compact',
          language: 'en',
          timeFormat: '24h',
        },
      },
      permissions: {
        create: (DEFAULT_FEATURES_BY_ROLE[Role.ADMIN] ?? []).map((feature) => ({
          feature,
        })),
      },
      siteAccess: {
        create: [
          {
            siteId: seedSiteId,
            level: SiteAccessLevel.MANAGE,
          },
        ],
      },
    },
  });
}

main()
  .catch((error) => {
    // eslint-disable-next-line no-console -- CLI feedback
    console.error('Seed failed', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
