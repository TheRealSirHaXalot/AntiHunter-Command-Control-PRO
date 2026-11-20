import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { buildCommandPayload } from './command-builder';

const TOKEN = 'AH_76EEC121_5893F142_00000039';
const KEY = 'AhTestKey1';
const ANSWER = createHmac('sha256', KEY).update(TOKEN).digest('hex').slice(0, 8);

let failed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  PASS ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}: ${(err as Error).message}`);
  }
}

check('answer fixture matches the firmware-accepted value', () => {
  assert.equal(ANSWER, 'd27f2e8c');
});

check('ERASE_FORCE sends the answer', () => {
  assert.equal(
    buildCommandPayload({ target: '@AHC5', name: 'ERASE_FORCE', params: [ANSWER.toUpperCase()] })
      .line,
    `@AHC5 ERASE_FORCE:${ANSWER}`,
  );
});

check('ERASE_FORCE accepts the full 64-hex answer', () => {
  const full = createHmac('sha256', KEY).update(TOKEN).digest('hex');
  assert.equal(
    buildCommandPayload({ target: '@AHC5', name: 'ERASE_FORCE', params: [full] }).line,
    `@AHC5 ERASE_FORCE:${full}`,
  );
});

for (const bad of [TOKEN, KEY, '', 'xyz12345', '1234567']) {
  check(`ERASE_FORCE rejects ${JSON.stringify(bad)}`, () => {
    assert.throws(() =>
      buildCommandPayload({ target: '@AHC5', name: 'ERASE_FORCE', params: [bad] }),
    );
  });
}

for (const name of ['ERASE_FORCE', 'ERASE_CANCEL', 'AUTOERASE_DISABLE', 'AUTOERASE_ENABLE']) {
  check(`${name} refuses @ALL`, () => {
    assert.throws(() => buildCommandPayload({ target: '@ALL', name, params: [ANSWER] }));
  });
}

check('ERASE_CANCEL sends the answer', () => {
  assert.equal(
    buildCommandPayload({ target: '@AHC5', name: 'ERASE_CANCEL', params: [ANSWER] }).line,
    `@AHC5 ERASE_CANCEL:${ANSWER}`,
  );
});

check('ERASE_CANCEL without an answer is rejected', () => {
  assert.throws(() => buildCommandPayload({ target: '@AHC5', name: 'ERASE_CANCEL', params: [] }));
});

check('AUTOERASE_DISABLE sends the answer', () => {
  assert.equal(
    buildCommandPayload({ target: '@AHC5', name: 'AUTOERASE_DISABLE', params: [ANSWER] }).line,
    `@AHC5 AUTOERASE_DISABLE:${ANSWER}`,
  );
});

check('AUTOERASE_ENABLE with defaults sends only the answer', () => {
  assert.equal(
    buildCommandPayload({ target: '@AHC5', name: 'AUTOERASE_ENABLE', params: [ANSWER] }).line,
    `@AHC5 AUTOERASE_ENABLE:${ANSWER}`,
  );
});

check('AUTOERASE_ENABLE with parameters puts the answer last', () => {
  assert.equal(
    buildCommandPayload({
      target: '@AHC5',
      name: 'AUTOERASE_ENABLE',
      params: ['60', '30', '3', '20', '300', ANSWER],
    }).line,
    `@AHC5 AUTOERASE_ENABLE:60:30:3:20:300:${ANSWER}`,
  );
});

check('AUTOERASE_ENABLE with parameters and no answer is rejected', () => {
  assert.throws(() =>
    buildCommandPayload({
      target: '@AHC5',
      name: 'AUTOERASE_ENABLE',
      params: ['60', '30', '3', '20', '300'],
    }),
  );
});

check('FACTORY_RESET sends tier and answer', () => {
  assert.equal(
    buildCommandPayload({ target: '@AHC5', name: 'FACTORY_RESET', params: ['config', ANSWER] })
      .line,
    `@AHC5 FACTORY_RESET:CONFIG:${ANSWER}`,
  );
});

check('FACTORY_RESET rejects the raw key', () => {
  assert.throws(() =>
    buildCommandPayload({ target: '@AHC5', name: 'FACTORY_RESET', params: ['FULL', KEY] }),
  );
});

check('SUMMARY sends no parameters', () => {
  assert.equal(
    buildCommandPayload({ target: '@ALL', name: 'SUMMARY', params: [] }).line,
    '@ALL SUMMARY',
  );
});

check('DEVICE_DB_CLEAR sends no parameters', () => {
  assert.equal(
    buildCommandPayload({ target: '@AHC5', name: 'DEVICE_DB_CLEAR', params: [] }).line,
    '@AHC5 DEVICE_DB_CLEAR',
  );
});

check('CALIBRATE sends the MAC and distance', () => {
  assert.equal(
    buildCommandPayload({
      target: '@AHC5',
      name: 'CALIBRATE',
      params: ['aa:bb:cc:dd:ee:ff', '2.5'],
    }).line,
    '@AHC5 CALIBRATE:AA:BB:CC:DD:EE:FF:2.5',
  );
});

check('CALIBRATE rejects a tracer id and an out-of-range distance', () => {
  assert.throws(() =>
    buildCommandPayload({ target: '@AHC5', name: 'CALIBRATE', params: ['T-00A3', '5'] }),
  );
  assert.throws(() =>
    buildCommandPayload({ target: '@ALL', name: 'CALIBRATE', params: ['AA:BB:CC:DD:EE:FF', '5'] }),
  );
  assert.throws(() =>
    buildCommandPayload({
      target: '@AHC5',
      name: 'CALIBRATE',
      params: ['AA:BB:CC:DD:EE:FF', '0.4'],
    }),
  );
});

check('reset and clear commands send no parameters', () => {
  for (const name of [
    'CALIBRATE_RESET',
    'PROBE_DB_CLEAR',
    'BASELINE_RESET',
    'RANDOMIZATION_RESET',
    'DETECT_CLEAR',
    'RADIO_KNOWN_CLEAR',
  ]) {
    assert.equal(buildCommandPayload({ target: '@AHC5', name, params: [] }).line, `@AHC5 ${name}`);
  }
});

check('RADIO_KNOWN_ADD normalizes MAC and radio type, keeps the name', () => {
  assert.equal(
    buildCommandPayload({
      target: '@ALL',
      name: 'RADIO_KNOWN_ADD',
      params: ['aa:bb:cc:dd:ee:ff', 'meshtastic', 'Base 1'],
    }).line,
    '@ALL RADIO_KNOWN_ADD:AA:BB:CC:DD:EE:FF:Meshtastic:Base 1',
  );
  assert.equal(
    buildCommandPayload({
      target: '@ALL',
      name: 'RADIO_KNOWN_ADD',
      params: ['AA:BB:CC:DD:EE:FF', 'MeshCore'],
    }).line,
    '@ALL RADIO_KNOWN_ADD:AA:BB:CC:DD:EE:FF:MeshCore',
  );
});

check('RADIO_KNOWN_ADD rejects an unknown radio type and a bad MAC', () => {
  assert.throws(() =>
    buildCommandPayload({
      target: '@ALL',
      name: 'RADIO_KNOWN_ADD',
      params: ['AA:BB:CC:DD:EE:FF', 'LoRaWAN'],
    }),
  );
  assert.throws(() =>
    buildCommandPayload({
      target: '@ALL',
      name: 'RADIO_KNOWN_ADD',
      params: ['T-00A3', 'MeshCore'],
    }),
  );
});

check('RADIO_KNOWN_DEL sends the MAC', () => {
  assert.equal(
    buildCommandPayload({ target: '@ALL', name: 'RADIO_KNOWN_DEL', params: ['aa:bb:cc:dd:ee:ff'] })
      .line,
    '@ALL RADIO_KNOWN_DEL:AA:BB:CC:DD:EE:FF',
  );
});

check('CONFIG_BAND sends the band mode', () => {
  assert.equal(
    buildCommandPayload({ target: '@AHC5', name: 'CONFIG_BAND', params: ['2'] }).line,
    '@AHC5 CONFIG_BAND:2',
  );
});

check('CONFIG_BAND rejects an out-of-range mode', () => {
  assert.throws(() => buildCommandPayload({ target: '@AHC5', name: 'CONFIG_BAND', params: ['3'] }));
});

check('CONFIG_BAND rejects a missing mode', () => {
  assert.throws(() => buildCommandPayload({ target: '@AHC5', name: 'CONFIG_BAND', params: [] }));
});

check('BLE_LONGRANGE sends 0 or 1 and rejects anything else', () => {
  assert.equal(
    buildCommandPayload({ target: '@ALL', name: 'BLE_LONGRANGE', params: ['1'] }).line,
    '@ALL BLE_LONGRANGE:1',
  );
  assert.equal(
    buildCommandPayload({ target: '@AH01', name: 'BLE_LONGRANGE', params: ['0'] }).line,
    '@AH01 BLE_LONGRANGE:0',
  );
  assert.throws(() =>
    buildCommandPayload({ target: '@ALL', name: 'BLE_LONGRANGE', params: ['2'] }),
  );
  assert.throws(() => buildCommandPayload({ target: '@ALL', name: 'BLE_LONGRANGE', params: [] }));
});

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log('ALL_PASS');
