import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { scrubCoords, stripCoords, WebhookDispatcherService } from './webhook-dispatcher.service';
import { PrismaService } from '../prisma/prisma.service';
import { AlertChannelsService } from '../push/alert-channels.service';
import { defaultTier } from '../push/alert-sources';
import { SerialAlertEvent } from '../serial/serial.types';

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}: ${error instanceof Error ? error.message : error}`);
  }
}

function harness(tiers: Record<string, 'off' | 'alert' | 'critical'> = {}) {
  const prisma = {
    webhook: { findMany: async () => [{ id: 'w1', enabled: true }] },
  } as unknown as PrismaService;
  const channels = {
    isSourceMuted: async (source: string) => (tiers[source] ?? defaultTier(source)) === 'off',
    alert: async () => undefined,
    coordsUnencrypted: async () => false,
  } as unknown as AlertChannelsService;
  const dispatcher = new WebhookDispatcherService(prisma, channels);
  const delivered: string[] = [];
  (
    dispatcher as unknown as { deliver: (w: unknown, c: { event: string }) => Promise<void> }
  ).deliver = async (_w, c) => {
    delivered.push(c.event);
  };
  return { dispatcher, delivered };
}

function nodeEvent(category: string, level: SerialAlertEvent['level']): SerialAlertEvent {
  return { kind: 'alert', level, category, nodeId: 'AH61', message: `AH61: ${category}`, raw: 'x' };
}

async function captureDelivery(coords: boolean): Promise<{
  body: Record<string, unknown>;
  pushed: string[];
}> {
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      bodies.push(data);
      res.end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const prisma = {
    webhook: {
      findMany: async () => [
        { id: 'w1', enabled: true, url: `http://127.0.0.1:${port}/hook`, verifyTls: true },
      ],
      update: async () => undefined,
    },
    webhookDelivery: {
      create: async () => ({ id: 'd1' }),
      update: async () => undefined,
    },
  } as unknown as PrismaService;
  const pushed: string[] = [];
  const channels = {
    isSourceMuted: async () => false,
    alert: async (_t: string, withCoords: string, _s: unknown, _src: string, without: string) => {
      pushed.push(withCoords, without);
    },
    coordsUnencrypted: async () => coords,
  } as unknown as AlertChannelsService;
  const dispatcher = new WebhookDispatcherService(prisma, channels);
  try {
    await dispatcher.dispatchNodeAlert(
      {
        kind: 'alert',
        level: 'ALERT',
        category: 'vibration',
        nodeId: 'AH61',
        message: 'AH61: VIBRATION: Movement GPS:12.345678,-98.765432',
        data: { lat: 12.345678, lon: -98.765432, magnitude: 3 },
        raw: 'AH61: VIBRATION: Movement GPS:12.345678,-98.765432',
      },
      {
        lat: 12.345678,
        lon: -98.765432,
        message: 'AH61: VIBRATION: Movement GPS:12.345678,-98.765432',
      },
    );
  } finally {
    server.close();
  }
  assert.equal(bodies.length, 1);
  return { body: JSON.parse(bodies[0]) as Record<string, unknown>, pushed };
}

async function main() {
  console.log('node alert webhook sources');
  await test('unmapped node events obey Alert sources (default off)', async () => {
    const { dispatcher, delivered } = harness();
    await dispatcher.dispatchNodeAlert(nodeEvent('sentinel', 'NOTICE'));
    await dispatcher.dispatchNodeAlert(nodeEvent('triangulation', 'INFO'));
    assert.equal(delivered.length, 0);
  });
  await test('unmapped node events sent when Node status is ticked', async () => {
    const { dispatcher, delivered } = harness({ 'node:status': 'alert' });
    await dispatcher.dispatchNodeAlert(nodeEvent('sentinel', 'NOTICE'));
    assert.equal(delivered.length, 1);
  });
  await test('mapped ALERT events still delivered by default', async () => {
    const { dispatcher, delivered } = harness();
    await dispatcher.dispatchNodeAlert(nodeEvent('tamper', 'ALERT'));
    assert.equal(delivered.length, 1);
  });

  console.log('coordinates');
  await test('stripCoords removes every parser coordinate format', () => {
    assert.equal(
      stripCoords('AH61: VIBRATION: x GPS:1.5,-2.25 TAMPER'),
      'AH61: VIBRATION: x TAMPER',
    );
    assert.equal(
      stripCoords('AH61: GPS: LOCKED Location=1.5,2.5 Satellites:9'),
      'AH61: GPS: LOCKED Satellites:9',
    );
    assert.equal(stripCoords('AH61: T_F: MAC=aa GPS=1.5,2.5 CONF=1'), 'AH61: T_F: MAC=aa CONF=1');
    assert.equal(stripCoords('AH61: DRONE: x GPS:1,2 ALT:3 OP:4.5,6.5'), 'AH61: DRONE: x ALT:3');
    assert.equal(stripCoords('AH61: RID_RX:UAV1:-70:1.5:2.5:1'), 'AH61: RID_RX:UAV1:-70:1');
    assert.equal(stripCoords('AH61: RID_CLAIM:UAV1:1.5:2.5:120'), 'AH61: RID_CLAIM:UAV1:120');
  });
  await test('scrubCoords drops coordinate keys at any depth', () => {
    assert.deepEqual(
      scrubCoords({
        lat: 1,
        lastLon: 2,
        operatorLat: 3,
        data: { lon: 4, ok: 'GPS:1,2 x' },
        k: [1],
      }),
      { data: { ok: 'x' }, k: [1] },
    );
  });
  await test('unencrypted webhook: node name kept, no coordinates anywhere', async () => {
    const { body } = await captureDelivery(false);
    const json = JSON.stringify(body);
    assert.ok(!json.includes('12.345678') && !json.includes('98.765432'), json);
    assert.equal((body.data as Record<string, unknown>).message, 'AH61: VIBRATION: Movement');
    assert.ok(String(body.summary).startsWith('[ALERT] AH61: VIBRATION: Movement'));
    assert.ok(!String(body.summary).includes('node AH61'));
    const fields = (body.embeds as Array<{ fields: Array<{ name: string }> }>)[0].fields;
    assert.ok(!fields.some((f) => f.name === 'Node' || f.name === 'Location'));
  });
  await test('opted-in webhook keeps coordinates once, in the message', async () => {
    const { body } = await captureDelivery(true);
    const data = body.data as Record<string, unknown>;
    assert.equal(data.message, 'AH61: VIBRATION: Movement GPS:12.345678,-98.765432');
    assert.equal(data.lat, 12.345678);
    const fields = (body.embeds as Array<{ fields: Array<{ name: string }> }>)[0].fields;
    assert.ok(!fields.some((f) => f.name === 'Node' || f.name === 'Location'));
  });
  await test('encrypted channels get coordinates, unencrypted body does not', async () => {
    const { pushed } = await captureDelivery(false);
    assert.ok(pushed[0].includes('GPS:12.345678,-98.765432'));
    assert.ok(!pushed[1].includes('12.345678'));
    assert.ok(pushed[1].startsWith('AH61: VIBRATION: Movement'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

void main();
