import assert from 'node:assert/strict';

import {
  buildCommandPayload,
  checkCommandPolicy,
  parseCommandLine,
  redactCommandParams,
} from './command-builder';

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

const TOKEN = 'AH_0A1B2C3D_4E5F6A7B_0000012C';
const KEY = 'ABCD-EFGH-JKLM-NPQR';
const ANSWER = 'd9672479';
const FULL_ANSWER = 'd96724793026a5fd41e8ec202b444e3af6535d9ce4630cf63971a2621a49ddaf';

const line = (target: string, name: string, params: string[] = []) =>
  buildCommandPayload({ target, name, params }).line;
const rejects = (target: string, name: string, params: string[] = []) =>
  assert.throws(() => buildCommandPayload({ target, name, params }));

test('targets: 2-5 alphanumeric IDs, NODE_ prefix stripped, underscore ids rejected', () => {
  assert.equal(line('@ah01', 'STATUS'), '@AH01 STATUS');
  assert.equal(line('@NODE_AH01', 'STATUS'), '@AH01 STATUS');
  assert.equal(line('@NODE_22', 'STATUS'), '@22 STATUS');
  assert.equal(line('@ALL', 'STATUS'), '@ALL STATUS');
  rejects('@ABCDEF', 'STATUS');
  rejects('@A', 'STATUS');
  rejects('@NODE_UNKNOWN', 'STATUS');
  rejects('AH01', 'STATUS');
});

test('lines longer than 230 characters are rejected', () => {
  const many = Array.from(
    { length: 40 },
    (_, i) => `AA:BB:CC:DD:EE:${i.toString(16).padStart(2, '0')}`,
  );
  assert.throws(
    () => buildCommandPayload({ target: '@ALL', name: 'CONFIG_TARGETS', params: [many.join('|')] }),
    /230/,
  );
  const ok = buildCommandPayload({
    target: '@ALL',
    name: 'CONFIG_TARGETS',
    params: [many.slice(0, 5).join('|')],
  });
  assert.ok(ok.line.length <= 230);
});

test('ERASE_FORCE computes the 8 hex HMAC-SHA256 answer from token and key', () => {
  assert.equal(line('@AH01', 'ERASE_FORCE', [TOKEN, KEY]), `@AH01 ERASE_FORCE:${ANSWER}`);
  assert.equal(
    line('@AH01', 'ERASE_FORCE', [TOKEN.toLowerCase(), KEY]),
    `@AH01 ERASE_FORCE:${ANSWER}`,
  );
});

test('ERASE_FORCE passes an existing answer through and rejects a bare token', () => {
  assert.equal(line('@AH01', 'ERASE_FORCE', [ANSWER.toUpperCase()]), `@AH01 ERASE_FORCE:${ANSWER}`);
  assert.equal(line('@AH01', 'ERASE_FORCE', [FULL_ANSWER]), `@AH01 ERASE_FORCE:${FULL_ANSWER}`);
  rejects('@AH01', 'ERASE_FORCE', [TOKEN]);
  rejects('@AH01', 'ERASE_FORCE', []);
  rejects('@AH01', 'ERASE_FORCE', ['AH_ZZZZZZZZ_4E5F6A7B_0000012C', KEY]);
  rejects('@AH01', 'ERASE_FORCE', [TOKEN, 'short']);
});

test('built erase params are stable when rebuilt', () => {
  const first = buildCommandPayload({ target: '@AH01', name: 'ERASE_FORCE', params: [TOKEN, KEY] });
  const second = buildCommandPayload({
    target: '@AH01',
    name: 'ERASE_FORCE',
    params: first.params,
  });
  assert.equal(first.line, second.line);
});

test('ERASE_CANCEL and AUTOERASE_DISABLE carry the answer', () => {
  assert.equal(line('@AH01', 'ERASE_CANCEL', [TOKEN, KEY]), `@AH01 ERASE_CANCEL:${ANSWER}`);
  assert.equal(line('@AH01', 'AUTOERASE_DISABLE', [ANSWER]), `@AH01 AUTOERASE_DISABLE:${ANSWER}`);
  rejects('@AH01', 'ERASE_CANCEL', []);
  rejects('@AH01', 'AUTOERASE_DISABLE', []);
});

test('AUTOERASE_ENABLE puts the answer last, with or without timings', () => {
  assert.equal(line('@AH01', 'AUTOERASE_ENABLE', [ANSWER]), `@AH01 AUTOERASE_ENABLE:${ANSWER}`);
  assert.equal(line('@AH01', 'AUTOERASE_ENABLE', [TOKEN, KEY]), `@AH01 AUTOERASE_ENABLE:${ANSWER}`);
  assert.equal(
    line('@AH01', 'AUTOERASE_ENABLE', ['60', '30', '3', '30', '300', ANSWER]),
    `@AH01 AUTOERASE_ENABLE:60:30:3:30:300:${ANSWER}`,
  );
  assert.equal(
    line('@AH01', 'AUTOERASE_ENABLE', ['60', '30', '3', '30', '300', TOKEN, KEY]),
    `@AH01 AUTOERASE_ENABLE:60:30:3:30:300:${ANSWER}`,
  );
  rejects('@AH01', 'AUTOERASE_ENABLE', ['60', '30', '3', ANSWER]);
  rejects('@AH01', 'AUTOERASE_ENABLE', ['10', '30', '3', '30', '300', ANSWER]);
  rejects('@AH01', 'AUTOERASE_ENABLE', []);
});

test('FACTORY_RESET takes tier plus answer, single node only', () => {
  assert.equal(
    line('@AH01', 'FACTORY_RESET', ['config', ANSWER]),
    `@AH01 FACTORY_RESET:CONFIG:${ANSWER}`,
  );
  assert.equal(
    line('@AH01', 'FACTORY_RESET', ['FULL', TOKEN, KEY]),
    `@AH01 FACTORY_RESET:FULL:${ANSWER}`,
  );
  rejects('@AH01', 'FACTORY_RESET', ['BOGUS', ANSWER]);
  rejects('@AH01', 'FACTORY_RESET', ['FULL', 'not-an-answer']);
  rejects('@ALL', 'FACTORY_RESET', ['FULL', ANSWER]);
});

test('CONFIG_ERASE_PSK sends new:current, or new:answer when a token is given', () => {
  assert.equal(
    line('@AH01', 'CONFIG_ERASE_PSK', ['NEWKEY-12345', KEY]),
    `@AH01 CONFIG_ERASE_PSK:NEWKEY-12345:${KEY}`,
  );
  assert.equal(
    line('@AH01', 'CONFIG_ERASE_PSK', ['NEWKEY-12345', TOKEN, KEY]),
    `@AH01 CONFIG_ERASE_PSK:NEWKEY-12345:${ANSWER}`,
  );
  rejects('@AH01', 'CONFIG_ERASE_PSK', ['NEWKEY-12345']);
  rejects('@AH01', 'CONFIG_ERASE_PSK', ['short', KEY]);
  rejects('@AH01', 'CONFIG_ERASE_PSK', ['has:colon-key', KEY]);
});

test('redactCommandParams masks erase credentials only', () => {
  assert.deepEqual(redactCommandParams('ERASE_FORCE', [ANSWER]), ['***']);
  assert.deepEqual(redactCommandParams('ERASE_CANCEL', [TOKEN, KEY]), ['***', '***']);
  assert.deepEqual(redactCommandParams('AUTOERASE_DISABLE', [ANSWER]), ['***']);
  assert.deepEqual(redactCommandParams('AUTOERASE_ENABLE', [ANSWER]), ['***']);
  assert.deepEqual(
    redactCommandParams('AUTOERASE_ENABLE', ['60', '30', '3', '30', '300', ANSWER]),
    ['60', '30', '3', '30', '300', '***'],
  );
  assert.deepEqual(redactCommandParams('FACTORY_RESET', ['FULL', ANSWER]), ['FULL', '***']);
  assert.deepEqual(redactCommandParams('CONFIG_ERASE_PSK', ['NEWKEY-12345', KEY]), ['***', '***']);
  const plain = ['2', '300'];
  assert.equal(redactCommandParams('SCAN_START', plain), plain);
});

test('policy: destructive commands need ADMIN and a single node', () => {
  const base = { target: '@AH01', params: [], allowForever: true, allowEraseForce: true };
  for (const name of [
    'ERASE_REQUEST',
    'ERASE_FORCE',
    'ERASE_CANCEL',
    'AUTOERASE_ENABLE',
    'AUTOERASE_DISABLE',
    'FACTORY_RESET',
    'CONFIG_ERASE_PSK',
  ]) {
    assert.equal(checkCommandPolicy({ ...base, name, role: 'ADMIN' }), null, name);
    assert.match(checkCommandPolicy({ ...base, name, role: 'OPERATOR' }) ?? '', /ADMIN/, name);
    assert.match(checkCommandPolicy({ ...base, name, role: null }) ?? '', /ADMIN/, name);
    assert.match(checkCommandPolicy({ ...base, name, role: 'REMOTE' }) ?? '', /ADMIN/, name);
    assert.match(
      checkCommandPolicy({ ...base, name, target: '@ALL', role: 'ADMIN' }) ?? '',
      /@ALL/,
      name,
    );
  }
  assert.equal(
    checkCommandPolicy({ ...base, name: 'AUTOERASE_STATUS', target: '@ALL', role: 'OPERATOR' }),
    null,
  );
});

test('policy: ALLOW_ERASE_FORCE gates ERASE_FORCE, FACTORY_RESET and AUTOERASE_ENABLE/DISABLE', () => {
  const base = {
    target: '@AH01',
    params: [],
    allowForever: true,
    allowEraseForce: false,
    role: 'ADMIN',
  };
  for (const name of ['ERASE_FORCE', 'FACTORY_RESET', 'AUTOERASE_ENABLE', 'AUTOERASE_DISABLE']) {
    assert.match(checkCommandPolicy({ ...base, name }) ?? '', /ALLOW_ERASE_FORCE/, name);
  }
  for (const name of ['ERASE_REQUEST', 'ERASE_CANCEL', 'CONFIG_ERASE_PSK', 'AUTOERASE_STATUS']) {
    assert.equal(checkCommandPolicy({ ...base, name }), null, name);
  }
});

test('policy: ALLOW_FOREVER gates FOREVER and zero-duration scans', () => {
  const base = { target: '@ALL', allowForever: false, allowEraseForce: false, role: 'OPERATOR' };
  assert.match(
    checkCommandPolicy({ ...base, name: 'SCAN_START', params: ['2', '300', '1,6', 'FOREVER'] }) ??
      '',
    /ALLOW_FOREVER/,
  );
  assert.match(
    checkCommandPolicy({ ...base, name: 'DRONE_START', params: ['0'] }) ?? '',
    /ALLOW_FOREVER/,
  );
  assert.match(
    checkCommandPolicy({ ...base, name: 'PROBE_START', params: ['2', '0'] }) ?? '',
    /ALLOW_FOREVER/,
  );
  assert.equal(checkCommandPolicy({ ...base, name: 'DRONE_START', params: ['600'] }), null);
  assert.equal(
    checkCommandPolicy({ ...base, name: 'DRONE_START', params: ['0'], allowForever: true }),
    null,
  );
  assert.equal(checkCommandPolicy({ ...base, name: 'STATUS', params: [] }), null);
});

test('parseCommandLine expands gated aliases', () => {
  assert.deepEqual(parseCommandLine('@AH01 EF:abcd1234'), {
    target: '@AH01',
    name: 'ERASE_FORCE',
    params: ['abcd1234'],
  });
  assert.deepEqual(parseCommandLine('@ALL ss:2:0:1,6'), {
    target: '@ALL',
    name: 'SCAN_START',
    params: ['2', '0', '1,6'],
  });
  assert.equal(parseCommandLine('garbage'), null);
});

test('ranges: CONFIG_RSSI, HB_INTERVAL, BATTERY_SAVER_START, CONFIG_NODEID', () => {
  assert.equal(line('@ALL', 'CONFIG_RSSI', ['-128']), '@ALL CONFIG_RSSI:-128');
  assert.equal(line('@ALL', 'CONFIG_RSSI', ['-10']), '@ALL CONFIG_RSSI:-10');
  rejects('@ALL', 'CONFIG_RSSI', ['-9']);
  rejects('@ALL', 'CONFIG_RSSI', ['-129']);
  assert.equal(line('@ALL', 'HB_INTERVAL', ['60']), '@ALL HB_INTERVAL:60');
  rejects('@ALL', 'HB_INTERVAL', ['61']);
  assert.equal(line('@AH01', 'BATTERY_SAVER_START', ['30']), '@AH01 BATTERY_SAVER_START:30');
  rejects('@AH01', 'BATTERY_SAVER_START', ['31']);
  assert.equal(line('@AH01', 'CONFIG_NODEID', ['ab12c']), '@AH01 CONFIG_NODEID:AB12C');
  rejects('@AH01', 'CONFIG_NODEID', ['AB12CD']);
});

test('CONFIG_TARGETS accepts MACs, prefixes, tracer IDs and SSIDs', () => {
  assert.equal(
    line('@ALL', 'CONFIG_TARGETS', ['aa:bb:cc:dd:ee:ff|11:22:33|T-1a2b|MyNetwork']),
    '@ALL CONFIG_TARGETS:AA:BB:CC:DD:EE:FF|11:22:33|T-1A2B|MyNetwork',
  );
  rejects('@ALL', 'CONFIG_TARGETS', ['x'.repeat(33)]);
  rejects('@ALL', 'CONFIG_TARGETS', ['|']);
});

test('channel lists on DEVICE_SCAN_START and PCAP_START', () => {
  assert.equal(
    line('@ALL', 'DEVICE_SCAN_START', ['2', '300', '+PROBE', 'ch1,6,11']),
    '@ALL DEVICE_SCAN_START:2:300:+PROBE:CH1,6,11',
  );
  assert.equal(
    line('@ALL', 'DEVICE_SCAN_START', ['2', '300', 'CH1..11']),
    '@ALL DEVICE_SCAN_START:2:300:CH1..11',
  );
  rejects('@ALL', 'DEVICE_SCAN_START', ['2', '300', 'CH15']);
  assert.equal(
    line('@ALL', 'PCAP_START', ['0', '300', '0', 'CH1,6,11']),
    '@ALL PCAP_START:0:300:0:CH1,6,11',
  );
  assert.equal(
    line('@ALL', 'PCAP_START', ['0', '300', 'CH36,149']),
    '@ALL PCAP_START:0:300:0:CH36,149',
  );
  assert.equal(line('@ALL', 'PCAP_START', ['1', '60']), '@ALL PCAP_START:1:60');
  rejects('@ALL', 'PCAP_START', ['0', '300', 'CH178']);
  rejects('@ALL', 'PCAP_START', ['0', '300', 'FOREVER']);
});

test('GROUP accepts devices', () => {
  assert.equal(line('@ALL', 'GROUP', ['devices', 'on']), '@ALL GROUP:devices:on');
});

test('no-argument v1.0.5 commands', () => {
  for (const name of [
    'SUMMARY',
    'MESH_TX_CANCEL',
    'CAMPAIGN_STOP',
    'CAMPAIGN_STATUS',
    'DEVICE_DB_CLEAR',
    'PROBE_DB_CLEAR',
    'BASELINE_WATCH',
    'BASELINE_RESET',
    'RANDOMIZATION_RESET',
    'SCHED_LIST',
    'CALIBRATE_RESET',
    'VIBSCAN_STATUS',
    'DETECT_CLEAR',
    'DETECT_COUNTS',
    'RADIO_KNOWN_CLEAR',
    'SELF_RADIO_CLEAR',
    'SELF_RADIO_GET',
    'ATTACKER_TRILAT_STATUS',
  ]) {
    assert.equal(line('@AH01', name), `@AH01 ${name}`, name);
    rejects('@AH01', name, ['1']);
  }
});

test('BLE_CLASSIFY and ATTACKER_TRILAT', () => {
  assert.equal(line('@ALL', 'BLE_CLASSIFY', ['0']), '@ALL BLE_CLASSIFY:0');
  assert.equal(line('@ALL', 'BLE_CLASSIFY', ['1']), '@ALL BLE_CLASSIFY:1');
  rejects('@ALL', 'BLE_CLASSIFY', ['2']);
  assert.equal(line('@ALL', 'BLE_LONGRANGE', ['1']), '@ALL BLE_LONGRANGE:1');
  assert.equal(line('@AH01', 'BLE_LONGRANGE', ['0']), '@AH01 BLE_LONGRANGE:0');
  rejects('@ALL', 'BLE_LONGRANGE', ['2']);
  rejects('@ALL', 'BLE_LONGRANGE', []);
  assert.equal(line('@ALL', 'ATTACKER_TRILAT', ['on']), '@ALL ATTACKER_TRILAT:1');
  assert.equal(line('@ALL', 'ATTACKER_TRILAT', ['off']), '@ALL ATTACKER_TRILAT:0');
  rejects('@ALL', 'ATTACKER_TRILAT', ['maybe']);
});

test('CAMPAIGN_START name rules', () => {
  assert.equal(line('@ALL', 'CAMPAIGN_START', ['site-a_1']), '@ALL CAMPAIGN_START:site-a_1');
  rejects('@ALL', 'CAMPAIGN_START', ['has space']);
  rejects('@ALL', 'CAMPAIGN_START', ['a'.repeat(24)]);
  rejects('@ALL', 'CAMPAIGN_START', []);
});

test('SCHED_ADD, SCHED_DEL', () => {
  const block = '2030-11-30T02:00|86400|/scan|mode=2&secs=600';
  assert.equal(line('@ALL', 'SCHED_ADD', [block]), `@ALL SCHED_ADD:${block}`);
  assert.equal(
    line('@ALL', 'SCHED_ADD', ['2030-11-30T02:00|0|/sniffer|mode=2&secs=60']),
    '@ALL SCHED_ADD:2030-11-30T02:00|0|/sniffer|mode=2&secs=60',
  );
  rejects('@ALL', 'SCHED_ADD', ['2030-11-30T02:00|599|/scan|mode=2']);
  rejects('@ALL', 'SCHED_ADD', ['2030-11-30T02:00|0|/other|mode=2']);
  rejects('@ALL', 'SCHED_ADD', ['2030-11-30 02:00|0|/scan|mode=2']);
  rejects('@ALL', 'SCHED_ADD', ['2030-11-30T02:00|0|/scan']);
  rejects('@ALL', 'SCHED_ADD', ['2030-11-30T02:00|0|/scan|a|b']);
  assert.equal(line('@AH01', 'SCHED_DEL', ['1']), '@AH01 SCHED_DEL:1');
  rejects('@AH01', 'SCHED_DEL', ['0']);
});

test('CALIBRATE mac:meters', () => {
  assert.equal(
    line('@AH01', 'CALIBRATE', ['aa:bb:cc:dd:ee:ff', '5']),
    '@AH01 CALIBRATE:AA:BB:CC:DD:EE:FF:5',
  );
  assert.equal(
    line('@AH01', 'CALIBRATE', ['AA:BB:CC:DD:EE:FF:0.5']),
    '@AH01 CALIBRATE:AA:BB:CC:DD:EE:FF:0.5',
  );
  rejects('@AH01', 'CALIBRATE', ['AA:BB:CC:DD:EE:FF', '0.4']);
  rejects('@AH01', 'CALIBRATE', ['AA:BB:CC:DD:EE:FF', '101']);
  rejects('@AH01', 'CALIBRATE', ['AA:BB:CC', '5']);
});

test('VIBSCAN_SET on:scan:secs[:cooldown[:interrupt]]', () => {
  assert.equal(
    line('@AH01', 'VIBSCAN_SET', ['1', '2', '60', '300']),
    '@AH01 VIBSCAN_SET:1:2:60:300',
  );
  assert.equal(line('@AH01', 'VIBSCAN_SET', ['0', '0', '0']), '@AH01 VIBSCAN_SET:0:0:0');
  assert.equal(
    line('@AH01', 'VIBSCAN_SET', ['1', '5', '60', '300', '1']),
    '@AH01 VIBSCAN_SET:1:5:60:300:1',
  );
  rejects('@AH01', 'VIBSCAN_SET', ['1', '9', '60']);
  rejects('@AH01', 'VIBSCAN_SET', ['1', '8', '0']);
  rejects('@AH01', 'VIBSCAN_SET', ['1', '2', '60', '4']);
});

test('RADIO_KNOWN_ADD, RADIO_KNOWN_DEL, SELF_RADIO_SET', () => {
  assert.equal(
    line('@ALL', 'RADIO_KNOWN_ADD', ['aa:bb:cc:dd:ee:ff', 'meshtastic']),
    '@ALL RADIO_KNOWN_ADD:AA:BB:CC:DD:EE:FF:Meshtastic',
  );
  assert.equal(
    line('@ALL', 'RADIO_KNOWN_ADD', ['AA:BB:CC:DD:EE:FF:MeshCore:Node One']),
    '@ALL RADIO_KNOWN_ADD:AA:BB:CC:DD:EE:FF:MeshCore:Node One',
  );
  rejects('@ALL', 'RADIO_KNOWN_ADD', ['AA:BB:CC:DD:EE:FF:Other']);
  rejects('@ALL', 'RADIO_KNOWN_ADD', ['AA:BB:CC:DD:EE:FF:Meshtastic:' + 'n'.repeat(32)]);
  assert.equal(
    line('@ALL', 'RADIO_KNOWN_DEL', ['aa:bb:cc:dd:ee:ff']),
    '@ALL RADIO_KNOWN_DEL:AA:BB:CC:DD:EE:FF',
  );
  assert.equal(line('@AH01', 'SELF_RADIO_SET', ['Meshtastic']), '@AH01 SELF_RADIO_SET:Meshtastic');
  rejects('@AH01', 'SELF_RADIO_SET', ['a'.repeat(13)]);
  rejects('@AH01', 'SELF_RADIO_SET', ['has space']);
});

test('PCAP_AUTO and SD_REPAIR', () => {
  assert.equal(line('@AH01', 'PCAP_AUTO'), '@AH01 PCAP_AUTO');
  assert.equal(line('@AH01', 'PCAP_AUTO', ['512,64']), '@AH01 PCAP_AUTO:512,64');
  assert.equal(line('@AH01', 'PCAP_AUTO', ['512', '64']), '@AH01 PCAP_AUTO:512,64');
  rejects('@AH01', 'PCAP_AUTO', ['15,64']);
  rejects('@AH01', 'PCAP_AUTO', ['512']);
  assert.equal(line('@ALL', 'SD_REPAIR'), '@ALL SD_REPAIR');
  assert.equal(line('@ALL', 'SD_REPAIR', ['now']), '@ALL SD_REPAIR:NOW');
  rejects('@ALL', 'SD_REPAIR', ['MAYBE']);
});

test('CONFIG_BAND is not on the main firmware dispatcher', () => {
  rejects('@AH01', 'CONFIG_BAND', ['2']);
});

test('SCHED_ADD options reject a newline that would inject a second command', () => {
  rejects('@AH01', 'SCHED_ADD', ['2030-01-01T02:00|0|/scan|mode=2\n@AH01 ERASE_FORCE:deadbeef']);
  assert.equal(
    line('@AH01', 'SCHED_ADD', ['2030-01-01T02:00|0|/scan|mode=2&secs=600']),
    '@AH01 SCHED_ADD:2030-01-01T02:00|0|/scan|mode=2&secs=600',
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
