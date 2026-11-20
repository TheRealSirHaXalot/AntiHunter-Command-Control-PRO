import assert from 'node:assert/strict';

import { MeshtasticRewriteParser } from './protocols/meshtastic-rewrite.parser';
import type {
  SerialAlertEvent,
  SerialCommandAck,
  SerialCommandResult,
  SerialDeviceSeen,
  SerialDroneTelemetry,
  SerialNodeTelemetry,
  SerialParseResult,
} from './serial.types';

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

function only<K extends SerialParseResult['kind']>(
  results: SerialParseResult[],
  kind: K,
): Extract<SerialParseResult, { kind: K }> {
  const found = results.filter((r) => r.kind === kind);
  assert.equal(found.length, 1, `expected one ${kind}, got ${results.map((r) => r.kind)}`);
  return found[0] as Extract<SerialParseResult, { kind: K }>;
}

test('STATUS with Rst, Camp and GPS keeps the node position', () => {
  const parser = new MeshtasticRewriteParser();
  const results = parser.parseLine(
    'AH01: STATUS: Mode:WiFi+BLE Scan:IDLE Hits:0 Temp:41.5C Up:00:12:03 Rst:POWERON Camp:site-a GPS:12.345334,-54.321611 HDOP=0.8',
  );
  const telemetry = only(results, 'node-telemetry') as SerialNodeTelemetry;
  assert.equal(telemetry.nodeId, 'AH01');
  assert.equal(telemetry.lat, 12.345334);
  assert.equal(telemetry.lon, -54.321611);
  assert.equal(telemetry.temperatureC, 41.5);
  const result = only(results, 'command-result') as SerialCommandResult;
  assert.equal(result.command, 'STATUS');
  assert.match(result.payload, /Rst:POWERON Camp:site-a/);
});

test('STATUS with Rst and GPS but no Camp', () => {
  const parser = new MeshtasticRewriteParser();
  const telemetry = only(
    parser.parseLine(
      'AH01: STATUS: Mode:WiFi Scan:ACTIVE Hits:3 Temp:41.5C Up:00:12:03 Rst:TASK_WDT GPS:12.5,-54.5 HDOP=99.9',
    ),
    'node-telemetry',
  ) as SerialNodeTelemetry;
  assert.equal(telemetry.lat, 12.5);
  assert.equal(telemetry.lon, -54.5);
});

test('STATUS with Rst only has no position, old format with GPS still parses', () => {
  const parser = new MeshtasticRewriteParser();
  const noGps = only(
    parser.parseLine('AH01: STATUS: Mode:BLE Scan:IDLE Hits:0 Temp:25.0C Up:00:05:00 Rst:SW'),
    'node-telemetry',
  ) as SerialNodeTelemetry;
  assert.equal(noGps.lat, undefined);
  const old = only(
    parser.parseLine(
      'AH01: STATUS: Mode:WiFi Scan:IDLE Hits:0 Temp:25.0C Up:00:05:00 GPS:12.5,-54.5 HDOP=1.0',
    ),
    'node-telemetry',
  ) as SerialNodeTelemetry;
  assert.equal(old.lat, 12.5);
});

test('SUMMARY becomes a command result', () => {
  const parser = new MeshtasticRewriteParser();
  const result = only(
    parser.parseLine(
      'AH01: SUMMARY: Mode:WiFi+BLE Scan:IDLE Dev:120 Tgt:4 Hits:7 Inc:2 Camp:site-a Up:00:12:03',
    ),
    'command-result',
  ) as SerialCommandResult;
  assert.equal(result.command, 'SUMMARY');
  assert.equal(result.nodeId, 'AH01');
  const minimal = only(
    parser.parseLine('AH01: SUMMARY: Mode:BLE Scan:IDLE Dev:0 Tgt:0 Hits:0 Up:00:00:05'),
    'command-result',
  ) as SerialCommandResult;
  assert.equal(minimal.command, 'SUMMARY');
});

test('DEVICE rows packed in one message are all parsed', () => {
  const parser = new MeshtasticRewriteParser();
  const rows = parser
    .parseLine(
      'AH01: DEVICE:AA:BB:CC:DD:EE:FF W -72 C6 N:Home Router\n112233445566 B -85 N:Speaker\n665544332211 W -60 C11',
    )
    .filter((r): r is SerialDeviceSeen => r.kind === 'device-seen');
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => [r.nodeId, r.mac, r.type, r.rssi, r.channel, r.name]),
    [
      ['AH01', 'AA:BB:CC:DD:EE:FF', 'WiFi', -72, 6, 'Home Router'],
      ['AH01', '11:22:33:44:55:66', 'BLE', -85, undefined, 'Speaker'],
      ['AH01', '66:55:44:33:22:11', 'WiFi', -60, 11, undefined],
    ],
  );
});

test('DEVICE continuation rows arriving as separate lines inherit the sender', () => {
  const parser = new MeshtasticRewriteParser();
  parser.parseLine('AH01: DEVICE:AA:BB:CC:DD:EE:FF W -72 C6');
  const cont = only(
    parser.parseLine('112233445566 B -85 N:Speaker'),
    'device-seen',
  ) as SerialDeviceSeen;
  assert.equal(cont.nodeId, 'AH01');
  assert.equal(cont.mac, '11:22:33:44:55:66');
  assert.equal(cont.type, 'BLE');
  assert.equal(cont.name, 'Speaker');
});

test('a bare continuation row without a preceding DEVICE row is not parsed as a device', () => {
  const parser = new MeshtasticRewriteParser();
  const results = parser.parseLine('112233445566 B -85 N:Speaker');
  assert.equal(results.filter((r) => r.kind === 'device-seen').length, 0);
  parser.parseLine('AH01: DEVICE:AA:BB:CC:DD:EE:FF W -72');
  parser.reset();
  assert.equal(
    parser.parseLine('112233445566 B -85').filter((r) => r.kind === 'device-seen').length,
    0,
  );
});

test('DRONE with GPS is telemetry, without GPS is a drone alert', () => {
  const parser = new MeshtasticRewriteParser();
  const withGps = only(
    parser.parseLine(
      'AH01: DRONE: AA:BB:CC:DD:EE:FF ID:DJI-Mini3 R-75 GPS:12.345,-54.321 ALT:120.5',
    ),
    'drone-telemetry',
  ) as SerialDroneTelemetry;
  assert.equal(withGps.lat, 12.345);
  assert.equal(withGps.altitude, 120.5);
  const noGps = only(
    parser.parseLine('AH01: DRONE: AA:BB:CC:DD:EE:FF ID:DJI-Mini3 R-75'),
    'alert',
  ) as SerialAlertEvent;
  assert.equal(noGps.category, 'drone');
  assert.equal(noGps.data?.event, 'drone-seen');
  assert.equal(noGps.data?.rssi, -75);
  assert.equal(noGps.nodeId, 'AH01');
});

test('DRONE_LOST', () => {
  const parser = new MeshtasticRewriteParser();
  const alert = only(
    parser.parseLine('AH01: DRONE_LOST: AA:BB:CC:DD:EE:FF ID:DJI-Mini3 AGE:45'),
    'alert',
  ) as SerialAlertEvent;
  assert.equal(alert.data?.event, 'drone-lost');
  assert.equal(alert.data?.ageSeconds, 45);
  assert.equal(alert.data?.droneId, 'DJI-Mini3');
  const noId = only(
    parser.parseLine('AH01: DRONE_LOST: AA:BB:CC:DD:EE:FF AGE:9'),
    'alert',
  ) as SerialAlertEvent;
  assert.equal(noId.data?.ageSeconds, 9);
});

test('ERASE_TOKEN with hex token and Expires', () => {
  const parser = new MeshtasticRewriteParser();
  const results = parser.parseLine('AH01: ERASE_TOKEN:AH_0A1B2C3D_4E5F6A7B_0000012C Expires:300s');
  const alert = only(results, 'alert') as SerialAlertEvent;
  assert.equal(alert.data?.token, 'AH_0A1B2C3D_4E5F6A7B_0000012C');
  assert.equal(alert.data?.expiresSeconds, 300);
  const ack = only(results, 'command-ack') as SerialCommandAck;
  assert.equal(ack.ackType, 'ERASE_TOKEN');
  assert.equal(ack.status, 'OK');
});

test('ERASE_TOKEN rate limited', () => {
  const parser = new MeshtasticRewriteParser();
  const results = parser.parseLine('AH01: ERASE_TOKEN:RATE_LIMITED');
  const alert = only(results, 'alert') as SerialAlertEvent;
  assert.equal(alert.data?.rateLimited, true);
  assert.equal(alert.data?.token, undefined);
  assert.equal((only(results, 'command-ack') as SerialCommandAck).status, 'RATE_LIMITED');
});

test('ERASE_ACK statuses are surfaced as command acks', () => {
  const parser = new MeshtasticRewriteParser();
  for (const status of ['COMPLETE', 'FAILED', 'BUSY', 'DENIED', 'SET_KEY_FIRST']) {
    const ack = only(
      parser.parseLine(`AH01: ERASE_ACK:${status}`),
      'command-ack',
    ) as SerialCommandAck;
    assert.equal(ack.ackType, 'ERASE_ACK', status);
    assert.equal(ack.status, status);
  }
  const cancel = only(
    parser.parseLine('AH01: ERASE_ACK:CANCELED'),
    'command-ack',
  ) as SerialCommandAck;
  assert.equal(cancel.ackType, 'ERASE_CANCEL_ACK');
  assert.equal(cancel.status, 'CANCELED');
});

test('old ERASE_TOKEN format still parses', () => {
  const parser = new MeshtasticRewriteParser();
  const alert = only(
    parser.parseLine('AH01: ERASE_TOKEN:tok123 Time:30s'),
    'alert',
  ) as SerialAlertEvent;
  assert.equal(alert.data?.token, 'tok123');
  assert.equal(alert.data?.time, 30);
});

test('radio, jamming baseline, CSA and quiet alerts carry their fields', () => {
  const parser = new MeshtasticRewriteParser();
  const data = (line: string) =>
    (only(parser.parseLine(line), 'alert') as SerialAlertEvent).data as Record<string, unknown>;
  assert.deepEqual(data('AH01: RADIO_DETECTED:Meshtastic:AA:BB:CC:DD:EE:FF:-70:Meshtastic_1a2b'), {
    detectionType: 'RADIO_DETECTED',
    radio: 'Meshtastic',
    mac: 'AA:BB:CC:DD:EE:FF',
    rssi: -70,
    name: 'Meshtastic_1a2b',
  });
  assert.deepEqual(data('AH01: JAMMING_BASELINE:6:silence:42'), {
    detectionType: 'JAMMING_BASELINE',
    channel: 6,
    rule: 'silence',
    value: 42,
  });
  assert.deepEqual(data('AH01: CSA_SPOOF:AA:BB:CC:DD:EE:FF:60:-55'), {
    detectionType: 'CSA_SPOOF',
    bssid: 'AA:BB:CC:DD:EE:FF',
    value: 60,
    rssi: -55,
  });
  assert.deepEqual(data('AH01: QUIET_ABUSE:AA:BB:CC:DD:EE:FF:1500:-55'), {
    detectionType: 'QUIET_ABUSE',
    bssid: 'AA:BB:CC:DD:EE:FF',
    value: 1500,
    rssi: -55,
  });
  assert.equal(data('AH01: JAMMING:6:noise_rise:12').detectionType, 'JAMMING');
});

test('FLEET_AP and FLEET_RADIO are coordination alerts', () => {
  const parser = new MeshtasticRewriteParser();
  for (const line of ['AH01: FLEET_AP:AA:BB:CC:DD:EE:FF', 'AH01: FLEET_RADIO:AH07:ah07']) {
    const alert = only(parser.parseLine(line), 'alert') as SerialAlertEvent;
    assert.equal(alert.category, 'mesh-coordination', line);
    assert.equal(alert.level, 'INFO');
  }
});

test('PCAP_START and PCAP_DONE', () => {
  const parser = new MeshtasticRewriteParser();
  const start = only(parser.parseLine('AH01: PCAP_START: BLE D=120'), 'alert') as SerialAlertEvent;
  assert.deepEqual(start.data, { event: 'pcap-start', radio: 'BLE', durationSeconds: 120 });
  const done = parser.parseLine('AH01: PCAP_DONE: F=1200 B=345678 D=0 R=WRITEFAIL');
  assert.deepEqual((only(done, 'alert') as SerialAlertEvent).data, {
    F: 1200,
    B: 345678,
    D: 0,
    R: 'WRITEFAIL',
  });
  assert.equal((only(done, 'command-ack') as SerialCommandAck).ackType, 'PCAP_DONE_ACK');
  const plain = parser.parseLine('AH01: PCAP_DONE: F=5 B=100 D=1');
  assert.equal(
    ((only(plain, 'alert') as SerialAlertEvent).data as Record<string, unknown>).R,
    undefined,
  );
});

test('new reply kinds map to ack types and statuses', () => {
  const parser = new MeshtasticRewriteParser();
  const ack = (line: string) => only(parser.parseLine(line), 'command-ack') as SerialCommandAck;
  const cases: Array<[string, string, string]> = [
    ['AH01: CAMPAIGN_ACK:START:site-a', 'CAMPAIGN_ACK', 'START'],
    ['AH01: CAMPAIGN_ACK:STOP:site-a', 'CAMPAIGN_ACK', 'STOP'],
    ['AH01: CAMPAIGN_ACK:NONE', 'CAMPAIGN_ACK', 'NONE'],
    ['AH01: CAMPAIGN_ACK:INVALID', 'CAMPAIGN_ACK', 'INVALID'],
    ['AH01: SCHED_ACK:OK', 'SCHED_ACK', 'OK'],
    ['AH01: SCHED_ACK:ERR Invalid start time', 'SCHED_ACK', 'ERR'],
    ['AH01: SCHED_ACK:DELETED', 'SCHED_ACK', 'DELETED'],
    ['AH01: SCHED_ACK:NOT_FOUND', 'SCHED_ACK', 'NOT_FOUND'],
    ['AH01: CALIBRATE_ACK:STARTED', 'CALIBRATE_ACK', 'STARTED'],
    ['AH01: CALIBRATE_ACK:BUSY', 'CALIBRATE_ACK', 'BUSY'],
    ['AH01: CALIBRATE_ACK:RESET', 'CALIBRATE_ACK', 'RESET'],
    ['AH01: SELF_RADIO_ACK:CLEARED', 'SELF_RADIO_ACK', 'CLEARED'],
    ['AH01: RADIO_KNOWN_ACK:OK:3', 'RADIO_KNOWN_ACK', 'OK'],
    ['AH01: RADIO_KNOWN_ACK:FAILED:FULL', 'RADIO_KNOWN_ACK', 'FAILED'],
    ['AH01: VIBSCAN_ACK:OK En:1 Mode:2 Dur:60s Cd:300s Pre:0', 'VIBSCAN_ACK', 'OK'],
    ['AH01: PCAP_AUTO_ACK:BUDGET=512MB FLOOR=256MB', 'PCAP_AUTO_ACK', 'BUDGET=512MB'],
    ['AH01: SD_REPAIR_ACK:REPAIRED', 'SD_REPAIR_ACK', 'REPAIRED'],
    ['AH01: ATTACKER_TRILAT_ACK:OFF', 'ATTACKER_TRILAT_ACK', 'OFF'],
    ['AH01: MESH_TX_CANCEL_ACK:EMPTY', 'MESH_TX_CANCEL_ACK', 'EMPTY'],
    ['AH01: BASELINE_RESET_ACK:BUSY', 'BASELINE_RESET_ACK', 'BUSY'],
    ['AH01: RANDOMIZATION_RESET_ACK:OK', 'RANDOMIZATION_RESET_ACK', 'OK'],
    ['AH01: DEVICE_DB_CLEAR_ACK:OK', 'DEVICE_DB_CLEAR_ACK', 'OK'],
    ['AH01: PROBE_DB_CLEAR_ACK:OK', 'PROBE_DB_CLEAR_ACK', 'OK'],
    ['AH01: DETECT_CLEAR_ACK:OK', 'DETECT_CLEAR_ACK', 'OK'],
  ];
  for (const [line, ackType, status] of cases) {
    const parsed = ack(line);
    assert.equal(parsed.ackType, ackType, line);
    assert.equal(parsed.status, status, line);
    assert.equal(parsed.nodeId, 'AH01', line);
  }
});

test('self radio prefix reply and status-style replies', () => {
  const parser = new MeshtasticRewriteParser();
  assert.equal(
    (only(parser.parseLine('AH01: SELF_RADIO_ACK:Meshtastic'), 'command-ack') as SerialCommandAck)
      .ackType,
    'SELF_RADIO_ACK',
  );
  const result = (line: string) =>
    only(parser.parseLine(line), 'command-result') as SerialCommandResult;
  assert.deepEqual(
    [
      result('AH01: CAMPAIGN_STATUS:site-a').command,
      result('AH01: CAMPAIGN_STATUS:site-a').payload,
    ],
    ['CAMPAIGN_STATUS', 'site-a'],
  );
  assert.equal(result('AH01: SCHED_LIST:2').command, 'SCHED_LIST');
  assert.equal(
    result('AH01: VIBSCAN_STATUS: En:1 Mode:2 Dur:60s Cd:300s Pre:0').command,
    'VIBSCAN_STATUS',
  );
  assert.equal(result('AH01: ATTACKER_TRILAT_STATUS: ON').payload, 'ON');
  assert.equal(
    result(
      'AH01: DETECT_COUNTS: karmaCand=1 karmaConf=0 pwna=0 meshradio=2 tsf=0 pg=3 tof=1 hunts=0 hshk=0 peers=1 arPending=0',
    ).command,
    'DETECT_COUNTS',
  );
});

test('CALIBRATE_DONE results', () => {
  const parser = new MeshtasticRewriteParser();
  const ok = parser.parseLine('AH01: CALIBRATE_DONE:WIFI=-41.5:BLE=NONE');
  assert.deepEqual((only(ok, 'alert') as SerialAlertEvent).data, {
    result: 'OK',
    wifiRssi0: -41.5,
    bleRssi0: undefined,
  });
  assert.equal((only(ok, 'command-ack') as SerialCommandAck).status, 'OK');
  for (const word of ['FAILED', 'STOPPED']) {
    const done = parser.parseLine(`AH01: CALIBRATE_DONE:${word}`);
    assert.equal(
      ((only(done, 'alert') as SerialAlertEvent).data as Record<string, unknown>).result,
      word,
    );
    assert.equal((only(done, 'command-ack') as SerialCommandAck).status, 'ERROR');
  }
});

test('CONFIG_ACK with a setting name maps to that setting ack', () => {
  const parser = new MeshtasticRewriteParser();
  const cases: Array<[string, string, string]> = [
    ['AH01: CONFIG_ACK:BLE_LONGRANGE:1', 'BLE_LONGRANGE_ACK', 'OK'],
    ['AH01: CONFIG_ACK:BLE_CLASSIFY:0', 'BLE_CLASSIFY_ACK', 'OK'],
    ['AH01: CONFIG_ACK:SESSION_DEDUP:1', 'SESSION_DEDUP_ACK', 'OK'],
    ['AH01: CONFIG_ACK:DEDUP_TTL:300', 'DEDUP_TTL_ACK', 'OK'],
    ['AH01: CONFIG_ACK:DEDUP_TTL:INVALID', 'DEDUP_TTL_ACK', 'ERROR'],
    ['AH01: CONFIG_ACK:NODE_ID:OK', 'NODE_ID_ACK', 'OK'],
    ['AH01: CONFIG_ACK:NODE_ID:INVALID_LENGTH', 'NODE_ID_ACK', 'ERROR'],
    ['AH01: CONFIG_ACK:RSSI:INVALID_RANGE', 'RSSI_ACK', 'ERROR'],
    ['AH01: CONFIG_ACK:CHANNELS:1..11', 'CHANNELS_ACK', 'OK'],
    ['AH01: CONFIG_ACK:TARGETS:FAILED', 'TARGETS_ACK', 'ERROR'],
    ['AH01: CONFIG_ACK:ERASE_PSK:DENIED', 'ERASE_PSK_ACK', 'ERROR'],
    ['AH01: CONFIG_ACK:BAND:2', 'BAND_ACK', 'OK'],
    ['AH01: CONFIG_ACK:OK', 'CONFIG_ACK', 'OK'],
  ];
  for (const [line, ackType, status] of cases) {
    const parsed = only(parser.parseLine(line), 'command-ack') as SerialCommandAck;
    assert.equal(parsed.ackType, ackType, line);
    assert.equal(parsed.status, status, line);
    assert.equal(parsed.nodeId, 'AH01', line);
  }
});

test('BASELINE_WATCH summary', () => {
  const parser = new MeshtasticRewriteParser();
  const alert = only(
    parser.parseLine('AH01: BASELINE_WATCH: New=3 Gone=1 Moved=2 Both=40'),
    'alert',
  ) as SerialAlertEvent;
  assert.deepEqual(alert.data, { event: 'baseline-watch', added: 3, gone: 1, moved: 2, both: 40 });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
