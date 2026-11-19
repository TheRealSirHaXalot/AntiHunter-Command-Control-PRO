import assert from 'node:assert/strict';
import { join } from 'node:path';

import { compileSignatures, loadSignatures, matchSignatures } from './device-signatures';

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}: ${error instanceof Error ? error.message : error}`);
  }
}

const ids = (list: { id: string }[]) => list.map((s) => s.id);

const small = compileSignatures({
  catalogVersion: 1,
  fleets: [
    {
      id: 'f-oui',
      name: 'Oui Co',
      kind: 'HOME',
      enabled: true,
      matchAny: true,
      rules: [{ kind: 'OUI', text: '00:0F:B3', radio: 'WIFI', enabled: true }],
    },
    {
      id: 'f-glob',
      name: 'Glob Co',
      kind: 'DRONE',
      enabled: true,
      matchAny: true,
      rules: [{ kind: 'NAME_GLOB', text: 'Mavic*', radio: null, enabled: true }],
    },
    {
      id: 'f-contains',
      name: 'Contains Co',
      kind: 'HACKING',
      enabled: true,
      matchAny: true,
      rules: [{ kind: 'NAME_CONTAINS', text: 'flipper', radio: 'BLE', enabled: true }],
    },
    {
      id: 'f-prefix',
      name: 'Prefix Co',
      kind: 'SURVEILLANCE',
      enabled: true,
      matchAny: true,
      rules: [{ kind: 'MAC_PREFIX', text: 'DE:AD:BE:EF:DE:AD', radio: null, enabled: true }],
    },
    {
      id: 'f-off',
      name: 'Disabled',
      kind: 'HOME',
      enabled: false,
      matchAny: true,
      rules: [{ kind: 'OUI', text: '11:22:33', radio: null, enabled: true }],
    },
  ],
});

console.log('signature matching');
test('OUI matches only on its radio', () => {
  assert.deepEqual(ids(matchSignatures(small, { mac: '00:0f:b3:01:02:03', type: 'WiFi' })), [
    'f-oui',
  ]);
  assert.deepEqual(ids(matchSignatures(small, { mac: '00:0F:B3:01:02:03', type: 'BLE' })), []);
});
test('Wi-Fi local-bit MAC matches its universal OUI', () => {
  assert.deepEqual(ids(matchSignatures(small, { mac: '02:0F:B3:01:02:03', type: 'WiFi' })), [
    'f-oui',
  ]);
});
test('name glob and contains are case-insensitive and radio scoped', () => {
  assert.deepEqual(ids(matchSignatures(small, { mac: 'AA:00:00:00:00:01', name: 'MAVIC 3' })), [
    'f-glob',
  ]);
  assert.deepEqual(
    ids(matchSignatures(small, { mac: 'AA:00:00:00:00:01', type: 'BLE', name: 'My Flipper' })),
    ['f-contains'],
  );
  assert.deepEqual(
    ids(matchSignatures(small, { mac: 'AA:00:00:00:00:01', type: 'WiFi', name: 'My Flipper' })),
    [],
  );
});
test('full MAC prefix and disabled fleets', () => {
  assert.deepEqual(ids(matchSignatures(small, { mac: 'de:ad:be:ef:de:ad', type: 'BLE' })), [
    'f-prefix',
  ]);
  assert.deepEqual(ids(matchSignatures(small, { mac: '11:22:33:44:55:66', type: 'WiFi' })), []);
});
test('shipped catalog loads and classifies a known vendor', () => {
  const catalog = loadSignatures(
    join(__dirname, '..', '..', 'data', 'fieldwatch', 'fieldwatch-signatures.json'),
  );
  assert.ok(catalog && catalog.fleets.length > 200, 'catalog loaded');
  const hit = matchSignatures(catalog!, { mac: '00:0F:B3:AA:BB:CC', type: 'WiFi' });
  assert.ok(
    hit.some((s) => s.id === 'fleet-actiontec'),
    JSON.stringify(hit),
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
