import assert from 'node:assert/strict';

import { SitesService } from './sites.service';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.error(err);
  }
}

function service(siteId: string, upsert: (args: unknown) => Promise<unknown>) {
  const prisma = { site: { upsert } };
  const config = { get: (_key: string, fallback?: string) => siteId ?? fallback };
  return new SitesService(prisma as never, config as never);
}

async function main() {
  console.log('sites');

  await test('startup creates the local site row for SITE_ID', async () => {
    delete process.env.SITE_NAME;
    const calls: Array<{ where: { id: string }; create: { id: string; name: string } }> = [];
    await service('bravo', async (args) => {
      calls.push(args as (typeof calls)[number]);
      return {};
    }).onModuleInit();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].where.id, 'bravo');
    assert.equal(calls[0].create.id, 'bravo');
    assert.equal(calls[0].create.name, 'bravo');
  });

  await test('the default site keeps its seed name, and SITE_NAME wins when set', async () => {
    let name = '';
    const capture = async (args: unknown) => {
      name = (args as { create: { name: string } }).create.name;
      return {};
    };
    delete process.env.SITE_NAME;
    await service('default', capture).onModuleInit();
    assert.equal(name, 'Default Site');
    process.env.SITE_NAME = 'North gate';
    await service('bravo', capture).onModuleInit();
    assert.equal(name, 'North gate');
    delete process.env.SITE_NAME;
  });

  await test('a row created by another worker first is not an error', async () => {
    await service('bravo', async () => {
      throw Object.assign(new Error('unique'), { code: 'P2002' });
    }).onModuleInit();
  });

  await test('any other database error stops startup', async () => {
    await assert.rejects(
      service('bravo', async () => {
        throw Object.assign(new Error('down'), { code: 'P1001' });
      }).onModuleInit(),
      /down/,
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

void main();
