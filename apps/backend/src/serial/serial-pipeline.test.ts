/**
 * End-to-end serial pipeline test.
 * Tests every firmware message type through sanitizeLine → parser.parseLine
 * to verify nothing gets silently dropped.
 *
 * Run: npx tsx apps/backend/src/serial/serial-pipeline.test.ts
 */

import { MeshtasticRewriteParser } from './protocols/meshtastic-rewrite.parser';
import type { SerialAlertEvent, SerialParseResult } from './serial.types';

// ── sanitizeLine (exact copy from serial.service.ts) ──

function stripAnsi(value: string): string {
  let result = '';
  let i = 0;
  while (i < value.length) {
    if (value[i] === '\u001b' && value[i + 1] === '[') {
      i += 2;
      while (i < value.length && !/[A-Za-z]/.test(value[i])) {
        i += 1;
      }
      i += 1;
    } else {
      result += value[i];
      i += 1;
    }
  }
  return result;
}

function sanitizeLine(value: string): string {
  let cleaned = stripAnsi(value);
  // eslint-disable-next-line no-control-regex
  cleaned = cleaned.replace(/[\uFEFF\uFFFD\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  cleaned = cleaned.replace(/\/?undefinedf\b/gi, '');
  cleaned = cleaned.trim();
  if (!cleaned) return '';

  const msgIdx = cleaned.lastIndexOf('msg=');
  if (msgIdx >= 0) {
    cleaned = cleaned.slice(msgIdx + 4).trim();
  }

  if (/^\s*(DEBUG|INFO|WARN|ERROR)\s*\|/i.test(cleaned)) {
    return '';
  }

  const bracketMatch = /^\[([A-Z][A-Z0-9_ -]*)\]\s+(.+)$/i.exec(cleaned);
  if (bracketMatch) {
    cleaned = bracketMatch[2].trim();
  }

  const chanMatch = /^\s*(\d)\s*:\s*([\s\S]+)$/.exec(cleaned);
  if (chanMatch && chanMatch[1].length === 1 && Number(chanMatch[1]) <= 7) {
    cleaned = chanMatch[2].trim();
  }

  const HOP_KEYWORD_RE =
    /^(?:STATUS|Target|DEVICE|DRONE|PROBE_HIT|PROBE_ACK|ATTACK|ANOMALY|VIBRATION|VIBRATION_STATUS|VIBRATION_ON_ACK|VIBRATION_OFF_ACK|SETUP_MODE|SETUP_COMPLETE|TAMPER_DETECTED|TAMPER_CANCELLED|ERASE_|AUTOERASE_|BASELINE_STATUS|BASELINE_ACK|BATTERY_SAVER_STATUS|BATTERY_SAVER_START_ACK|BATTERY_SAVER_STOP_ACK|HEARTBEAT|STARTUP|GPS|TRIANGULATE|TARGET_DATA|T_D:|T_C:|T_F:|IDENTITY|RANDOMIZATION|RANDOMIZATION_DONE|SCAN_DONE|DEAUTH_DONE|DRONE_DONE|BASELINE_DONE|LIST_SCAN_DONE|PROBE_DONE|PCAP_|SCAN_ACK|DEVICE_SCAN_ACK|DRONE_ACK|DEAUTH_ACK|CONFIG_ACK|STOP_ACK|REBOOT_ACK|HB_ACK|TRI_START|WIPE_TOKEN|ERASE_TOKEN|RTC_SYNC|TIME_SYNC|CODES:|EVILTWIN|OWE_ABUSE|PMKID_|EAPOL_BAIT|HSHK|KARMA_|PWNAGOTCHI|PROBE_FLOOD|SAE_DOS|DEAUTH_FLOOD|DEAUTH_FORGE|DEAUTH_AP_TARGETED|BEACON_|ASSOC_SLEEP|AUTH_FLOOD|SSID_CONFUSION|FRAG|ATTACKER_HUNT|RECON|JAMMING|SENTINEL|GROUP_ACK|DETECT_CFG|INCIDENTS|DEDUP_CLEAR_ACK|FACTORY_RESET|MESH_SPOOF_SELF|MESH_FLOOD|MESH_CMD_INJECT|DEVICE_DISAPPEARED|RID_|TOF_|BLOOM|IDHASH|CHAN_ASSIGN|CSI_|SUMMARY|CAMPAIGN_|SCHED_|CALIBRATE_|SELF_RADIO_|RADIO_KNOWN_|RADIO_DETECTED|CSA_SPOOF|QUIET_ABUSE|FLEET_|VIBSCAN_|ATTACKER_TRILAT|MESH_TX_CANCEL|DEVICE_DB_CLEAR|PROBE_DB_CLEAR|BASELINE_RESET|BASELINE_WATCH|RANDOMIZATION_RESET|DETECT_CLEAR|DETECT_COUNTS|SD_REPAIR|Time:)/i;
  const hopMatch = /^([A-Za-z0-9_-]{1,6}):\s+([A-Za-z0-9_.:-]+:\s+)(.+)$/i.exec(cleaned);
  if (hopMatch) {
    const secondToken = hopMatch[2].replace(/[:\s]+$/, '');
    const thirdPart = hopMatch[3].trim();
    const secondIsKeyword = HOP_KEYWORD_RE.test(secondToken);
    const thirdIsKeyword = HOP_KEYWORD_RE.test(thirdPart);
    if (!secondIsKeyword && thirdIsKeyword) {
      cleaned = (hopMatch[2] + hopMatch[3]).trim();
    }
  }

  cleaned = cleaned.replace(/^0m\s*/i, '');

  return cleaned;
}

// ── Test cases ──

interface TestCase {
  name: string;
  input: string;
  expectKinds: string[];
  expectCategory?: string;
  expectNodeId?: string;
  expectData?: Record<string, string | number | boolean>;
  skipHop?: boolean;
}

const FIRMWARE_MESSAGES: TestCase[] = [
  // ─── STATUS ───
  {
    name: 'STATUS basic',
    input:
      'AH5: STATUS: Mode:WiFi+BLE Scan:IDLE Hits:0 Temp:59.0C Up:01:30:05 GPS:12.345334,-54.321611 HDOP=0.8',
    expectKinds: ['node-telemetry', 'command-result'],
  },
  {
    name: 'STATUS with targets',
    input:
      'AH5: STATUS: Mode:WiFi Scan:ACTIVE Hits:42 Targets:15 Temp:72.3C/162.1F Up:12:30:05 GPS:12.345,-54.321 HDOP=1.2',
    expectKinds: ['node-telemetry', 'command-result'],
  },
  {
    name: 'STATUS no GPS',
    input: 'AH5: STATUS: Mode:BLE Scan:IDLE Hits:0 Temp:25.0C Up:00:05:00',
    expectKinds: ['node-telemetry', 'command-result'],
  },

  // ─── TARGET ───
  {
    name: 'TARGET type first',
    input: 'AH5: Target: WiFi AA:BB:CC:DD:EE:FF RSSI:-72 Name:MyDevice GPS:12.345,-54.321',
    expectKinds: ['target-detected', 'alert'],
  },
  {
    name: 'TARGET mac first',
    input: 'AH5: Target: AA:BB:CC:DD:EE:FF RSSI:-65 Type:BLE Name:Speaker',
    expectKinds: ['target-detected', 'alert'],
  },
  {
    name: 'TARGET no extras',
    input: 'AH5: Target: WiFi 11:22:33:44:55:66 RSSI:-80',
    expectKinds: ['target-detected', 'alert'],
  },

  // ─── DEVICE ───
  {
    name: 'DEVICE WiFi',
    input: 'AH5: DEVICE:AA:BB:CC:DD:EE:FF W -72 C6 N:HomeRouter',
    expectKinds: ['device-seen'],
  },
  {
    name: 'DEVICE BLE',
    input: 'AH5: DEVICE:11:22:33:44:55:66 B -85',
    expectKinds: ['device-seen'],
  },

  // ─── TARGET_DATA / T_D ───
  {
    name: 'TARGET_DATA full',
    input:
      'AH5: TARGET_DATA: AA:BB:CC:DD:EE:FF RSSI:-55 Hits=12 Type:WiFi GPS=12.345,-54.321 HDOP=0.8 TS=1234567',
    expectKinds: ['alert'],
    expectCategory: 'triangulation',
  },
  {
    name: 'T_D short',
    input: 'AH5: T_D: AA:BB:CC:DD:EE:FF RSSI:-55 Hits=3 Type:BLE',
    expectKinds: ['alert'],
    expectCategory: 'triangulation',
  },

  // ─── DRONE ───
  {
    name: 'DRONE full',
    input:
      'AH5: DRONE: AA:BB:CC:DD:EE:FF ID:DJI-Mini3 R-75 GPS:12.345,-54.321 ALT:120.5 SPD:15.2 OP:12.340,-54.310',
    expectKinds: ['drone-telemetry'],
  },
  {
    name: 'DRONE minimal',
    input: 'AH5: DRONE: 11:22:33:44:55:66 ID:Unknown R-90 GPS:40.0,-105.0',
    expectKinds: ['drone-telemetry'],
  },

  // ─── PROBE_HIT ───
  {
    name: 'PROBE_HIT with SSID',
    input: 'AH5: PROBE_HIT AA:BB:CC:DD:EE:FF Apple RSSI=-65 CH=6 SSID="HomeNetwork"',
    expectKinds: ['probe-hit'],
    expectNodeId: 'AH5',
  },
  {
    name: 'PROBE_HIT no SSID (wildcard)',
    input: 'AH5: PROBE_HIT AA:BB:CC:DD:EE:FF Apple RSSI=-72 CH=1',
    expectKinds: ['probe-hit'],
  },
  {
    name: 'PROBE_HIT randomized MAC',
    input: 'AH5: PROBE_HIT 02:AB:CD:EF:12:34 Randomized RSSI=-80 CH=11',
    expectKinds: ['probe-hit'],
  },
  {
    name: 'PROBE_HIT GHOST flag',
    input: 'AH5: PROBE_HIT AA:BB:CC:DD:EE:FF Samsung RSSI=-55 CH=6 GHOST',
    expectKinds: ['probe-hit'],
  },
  {
    name: 'PROBE_HIT DST flag',
    input: 'AH5: PROBE_HIT AA:BB:CC:DD:EE:FF Unknown RSSI=-68 CH=1 DST',
    expectKinds: ['probe-hit'],
  },
  {
    name: 'PROBE_HIT with GPS',
    input: 'AH5: PROBE_HIT AA:BB:CC:DD:EE:FF Intel RSSI=-60 CH=6 SSID="CorpNet" GPS=12.345,-54.321',
    expectKinds: ['probe-hit'],
  },

  // ─── ANOMALY ───
  {
    name: 'ANOMALY-NEW',
    input: 'AH5: ANOMALY-NEW: WiFi AA:BB:CC:DD:EE:FF RSSI:-60 Name:NewDevice',
    expectKinds: ['alert'],
    expectCategory: 'anomaly',
  },
  {
    name: 'ANOMALY-RSSI',
    input: 'AH5: ANOMALY-RSSI: BLE 11:22:33:44:55:66 RSSI:-40 Old:-70 New:-40 Delta:30',
    expectKinds: ['alert'],
    expectCategory: 'anomaly',
  },
  {
    name: 'ANOMALY-RETURN',
    input: 'AH5: ANOMALY-RETURN: WiFi AA:BB:CC:DD:EE:FF RSSI:-55',
    expectKinds: ['alert'],
    expectCategory: 'anomaly',
  },

  // ─── ATTACK ───
  {
    name: 'ATTACK long',
    input:
      'AH5: ATTACK: DEAUTH [BROADCAST] SRC:AA:BB:CC:DD:EE:FF DST:11:22:33:44:55:66 RSSI:-50dBm CH:6',
    expectKinds: ['alert'],
    expectCategory: 'attack',
  },
  {
    name: 'ATTACK short',
    input: 'AH5: ATTACK: DISASSOC AA:BB:CC:DD:EE:FF->11:22:33:44:55:66 R-55 C11',
    expectKinds: ['alert'],
    expectCategory: 'attack',
  },

  // ─── IDENTITY / RANDOMIZATION ───
  {
    name: 'IDENTITY',
    input: 'AH5: IDENTITY:T-abc123 W MACs:5 Conf:0.95 Sess:3 Anchor:AA:BB:CC:DD:EE:FF',
    expectKinds: ['alert'],
    expectCategory: 'randomization',
  },
  {
    name: 'RANDOMIZATION_DONE',
    input: 'AH5: RANDOMIZATION_DONE: Identities=12 Sessions=8 TX=45 PEND=2',
    expectKinds: ['alert'],
    expectCategory: 'randomization',
  },

  // ─── VIBRATION ───
  {
    name: 'VIBRATION',
    input:
      'AH5: VIBRATION: Movement detected at 2026-10-01 14:02:11 GPS:10.500000,-20.250000 TAMPER_ERASE_IN:30s',
    expectKinds: ['alert'],
    expectCategory: 'vibration',
    expectData: { lat: 10.5, lon: -20.25, eraseIn: 30 },
  },
  {
    name: 'VIBRATION_STATUS',
    input: 'AH5: VIBRATION_STATUS: Armed sensitivity=HIGH threshold=500',
    expectKinds: ['alert'],
    expectCategory: 'vibration',
  },

  // ─── SETUP / TAMPER / ERASE ───
  {
    name: 'SETUP_MODE',
    input: 'AH5: SETUP_MODE: Entering setup',
    expectKinds: ['alert'],
    expectCategory: 'setup',
  },
  {
    name: 'SETUP_COMPLETE',
    input: 'AH5: SETUP_COMPLETE: Configuration saved',
    expectKinds: ['alert'],
    expectCategory: 'setup',
  },
  {
    name: 'TAMPER_DETECTED',
    input: 'AH5: TAMPER_DETECTED: Vibration threshold exceeded',
    expectKinds: ['alert'],
    expectCategory: 'tamper',
  },
  {
    name: 'TAMPER_CANCELLED',
    input: 'AH5: TAMPER_CANCELLED: Reset by operator',
    expectKinds: ['alert'],
    expectCategory: 'tamper',
  },
  {
    name: 'ERASE_EXECUTING',
    input: 'AH5: ERASE_EXECUTING:Wiping flash',
    expectKinds: ['alert'],
    expectCategory: 'erase',
  },
  {
    name: 'ERASE_ACK',
    input: 'AH5: ERASE_ACK:OK',
    expectKinds: ['alert'],
    expectCategory: 'erase',
  },
  {
    name: 'ERASE_COMPLETE',
    input: 'AH5: ERASE_COMPLETE',
    expectKinds: ['alert'],
    expectCategory: 'erase',
  },

  // ─── AUTOERASE ───
  {
    name: 'AUTOERASE_ACK enabled',
    input: 'AH5: AUTOERASE_ACK:ENABLED Setup:10s Erase:30s Vibs:3 Window:60s Cooldown:120s',
    expectKinds: ['command-ack', 'alert'],
  },
  {
    name: 'AUTOERASE_STATUS',
    input:
      'AH5: AUTOERASE_STATUS: Enabled:YES SetupMode:ARMED TamperActive:NO Setup:10s Erase:30s Vibs:3 Window:60s Cooldown:120s',
    expectKinds: ['command-ack', 'alert'],
  },

  // ─── BASELINE ───
  {
    name: 'BASELINE_STATUS',
    input:
      'AH5: BASELINE_STATUS: Scanning:YES Established:NO Devices:42 Anomalies:3 Phase1:LEARNING',
    expectKinds: ['alert'],
    expectCategory: 'baseline',
  },
  {
    name: 'BASELINE_ACK',
    input: 'AH5: BASELINE_ACK:STARTED',
    expectKinds: ['command-ack'],
  },

  // ─── BATTERY SAVER ───
  {
    name: 'BATTERY_SAVER_STATUS',
    input: 'AH5: BATTERY_SAVER_STATUS: Enabled:YES Temp:45.2C GPS:12.345,-54.321',
    expectKinds: ['command-ack', 'alert'],
  },

  // ─── GPS ───
  {
    name: 'GPS LOCKED',
    input: 'AH5: GPS: LOCKED Location=12.345334,-54.321611 Satellites=12 HDOP=0.8',
    expectKinds: ['node-telemetry', 'alert'],
  },
  {
    name: 'GPS LOCKED as the firmware sends it (no location)',
    input: 'AH68: GPS: LOCKED Satellites:9 HDOP:1.60',
    expectKinds: ['alert'],
  },
  {
    name: 'GPS LOST',
    input: 'AH5: GPS: LOST',
    expectKinds: ['alert'],
  },

  // ─── NODE_HB / HEARTBEAT ───
  {
    name: 'NODE_HB bracket',
    input: '[NODE_HB] AH5 Time:12:30:45 Temp:59.0C GPS:12.345,-54.321',
    expectKinds: ['node-telemetry', 'alert'],
    skipHop: true,
  },
  {
    name: 'NODE_HB inline',
    input: 'AH5: Time:12:30:45 Temp:59.0C/138.2F GPS:12.345,-54.321',
    expectKinds: ['node-telemetry', 'alert'],
  },
  {
    name: 'HEARTBEAT',
    input: 'AH5: HEARTBEAT: alive uptime=3600s',
    expectKinds: ['alert'],
  },
  {
    name: 'STARTUP',
    input: 'AH5: STARTUP: AntiHunter v2.1 booting',
    expectKinds: ['alert'],
  },

  // ─── COMMAND ACKs ───
  {
    name: 'SCAN_ACK',
    input: 'AH5: SCAN_ACK:STARTED',
    expectKinds: ['command-ack'],
  },
  {
    name: 'DEVICE_SCAN_ACK',
    input: 'AH5: DEVICE_SCAN_ACK:OK',
    expectKinds: ['command-ack'],
  },
  {
    name: 'DRONE_ACK',
    input: 'AH5: DRONE_ACK:OK',
    expectKinds: ['command-ack'],
  },
  {
    name: 'DEAUTH_ACK',
    input: 'AH5: DEAUTH_ACK:STARTED',
    expectKinds: ['command-ack'],
  },
  {
    name: 'CONFIG_ACK',
    input: 'AH5: CONFIG_ACK:OK',
    expectKinds: ['command-ack'],
  },
  {
    name: 'STOP_ACK',
    input: 'AH5: STOP_ACK:OK',
    expectKinds: ['command-ack'],
  },
  {
    name: 'REBOOT_ACK',
    input: 'AH5: REBOOT_ACK:OK',
    expectKinds: ['command-ack'],
  },
  {
    name: 'HB_ACK',
    input: 'AH5: HB_ACK:ENABLED',
    expectKinds: ['command-ack'],
  },
  {
    name: 'HB_ACK interval',
    input: 'AH5: HB_ACK:INTERVAL 5min',
    expectKinds: ['command-ack'],
  },
  {
    name: 'RANDOMIZATION_ACK',
    input: 'AH5: RANDOMIZATION_ACK:OK',
    expectKinds: ['command-ack'],
  },
  {
    name: 'BATTERY_SAVER_START_ACK',
    input: 'AH5: BATTERY_SAVER_START_ACK:OK',
    expectKinds: ['command-ack'],
  },
  {
    name: 'BATTERY_SAVER_STOP_ACK',
    input: 'AH5: BATTERY_SAVER_STOP_ACK:OK',
    expectKinds: ['command-ack'],
  },
  {
    name: 'PROBE_ACK STARTED',
    input: 'AH5: PROBE_ACK:STARTED',
    expectKinds: ['command-ack'],
  },
  {
    name: 'PROBE_ACK STOPPED',
    input: 'AH5: PROBE_ACK:STOPPED',
    expectKinds: ['command-ack'],
  },
  {
    name: 'PCAP_ACK STARTED',
    input: 'AH5: PCAP_ACK:STARTED',
    expectKinds: ['command-ack'],
  },
  {
    name: 'PCAP_ACK BUSY',
    input: 'AH5: PCAP_ACK:BUSY',
    expectKinds: ['command-ack'],
  },
  {
    name: 'PCAP_ACK NOSD',
    input: 'AH5: PCAP_ACK:NOSD',
    expectKinds: ['command-ack'],
  },
  {
    name: 'PCAP_STOP_ACK',
    input: 'AH5: PCAP_STOP_ACK:OK',
    expectKinds: ['command-ack'],
  },
  {
    name: 'TRIANGULATE_STOP_ACK',
    input: 'AH5: TRIANGULATE_STOP_ACK',
    expectKinds: ['command-ack'],
  },

  // ─── TRIANGULATION ───
  {
    name: 'TRIANGULATE_ACK',
    input: 'AH5: TRIANGULATE_ACK:AA:BB:CC:DD:EE:FF',
    expectKinds: ['command-ack'],
  },
  {
    name: 'TRIANGULATE_RESULTS_START',
    input: 'AH5: TRIANGULATE_RESULTS_START',
    expectKinds: ['alert'],
  },
  {
    name: 'TRIANGULATE_RESULTS_END',
    input: 'AH5: TRIANGULATE_RESULTS_END',
    expectKinds: ['alert'],
  },
  {
    name: 'TRIANGULATE_RESULTS:NO_DATA',
    input: 'AH5: TRIANGULATE_RESULTS:NO_DATA',
    expectKinds: ['alert'],
  },
  {
    name: 'T_F final',
    input: 'AH5: T_F: MAC=AA:BB:CC:DD:EE:FF GPS=12.345,-54.321 CONF=85.5 UNC=15.2',
    expectKinds: ['alert'],
  },
  {
    name: 'T_C complete',
    input: 'AH5: T_C: MAC=AA:BB:CC:DD:EE:FF Nodes=3 https://maps.google.com/?q=12.345,-54.321',
    expectKinds: ['alert'],
  },

  // ─── TOKENS ───
  {
    name: 'WIPE_TOKEN',
    input: 'AH5: WIPE_TOKEN:abc123-def456',
    expectKinds: ['alert'],
  },
  {
    name: 'ERASE_TOKEN',
    input: 'AH5: ERASE_TOKEN:tok123 Time:30s',
    expectKinds: ['alert'],
  },

  // ─── TIME SYNC ───
  {
    name: 'RTC_SYNC',
    input: 'AH5: RTC_SYNC: GPS',
    expectKinds: ['alert'],
  },
  {
    name: 'TIME_SYNC_REQ',
    input: 'AH5: TIME_SYNC_REQ:1700000000:60:1:-5',
    expectKinds: ['alert'],
  },
  {
    name: 'TIME_SYNC_RESP',
    input: 'AH5: TIME_SYNC_RESP:1700000000:60:1:3',
    expectKinds: ['alert'],
  },

  // ─── *_DONE SUMMARIES ───
  {
    name: 'SCAN_DONE',
    input: 'AH5: SCAN_DONE: W=42 B=18 U=60 H=125 TX=60 PEND=0',
    expectKinds: ['command-ack'],
  },
  {
    name: 'DEAUTH_DONE',
    input: 'AH5: DEAUTH_DONE: Total=42 Deauth=30 Disassoc=12 TX=42 PEND=0',
    expectKinds: ['command-ack'],
  },
  {
    name: 'DRONE_DONE',
    input: 'AH5: DRONE_DONE: Detected=3 Unique=3 TX=3 PEND=0',
    expectKinds: ['command-ack'],
  },
  {
    name: 'BASELINE_DONE',
    input: 'AH5: BASELINE_DONE: Devices=39 Anomalies=0 WiFi=23 BLE=16 TX=19 PEND=20',
    expectKinds: ['alert', 'command-ack'],
    expectCategory: 'baseline-done',
  },
  {
    name: 'LIST_SCAN_DONE',
    input: 'AH5: LIST_SCAN_DONE: Hits=250 Unique=15 Targets=15 TX=15 PEND=0',
    expectKinds: ['command-ack'],
  },

  // ─── CODES ───
  {
    name: 'CODES with values',
    input: 'AH5: CODES:150910,999888',
    expectKinds: ['alert', 'command-ack'],
    expectCategory: 'gate-codes',
  },
  {
    name: 'CODES none',
    input: 'AH5: CODES:NONE',
    expectKinds: ['alert', 'command-ack'],
    expectCategory: 'gate-codes',
  },

  // ─── VIBRATION ACKs ───
  {
    name: 'VIBRATION_ON_ACK',
    input: 'AH5: VIBRATION_ON_ACK:OK',
    expectKinds: ['command-ack'],
  },
  {
    name: 'VIBRATION_OFF_ACK',
    input: 'AH5: VIBRATION_OFF_ACK:OK',
    expectKinds: ['command-ack'],
  },

  // ─── SENTINEL DETECTIONS ───
  {
    name: 'EVILTWIN',
    input: 'AH5: EVILTWIN:AA:BB:CC:DD:EE:FF:tsf_anomaly:-45',
    expectKinds: ['alert'],
    expectCategory: 'sentinel',
    expectData: { bssid: 'AA:BB:CC:DD:EE:FF', reason: 'tsf_anomaly', rssi: -45 },
  },
  {
    name: 'EVILTWIN with ssid',
    input: 'AH5: EVILTWIN:AA:BB:CC:DD:EE:FF:SSID_COLLISION:-86:DogeMiles',
    expectKinds: ['alert'],
    expectCategory: 'sentinel',
    expectData: {
      bssid: 'AA:BB:CC:DD:EE:FF',
      reason: 'SSID_COLLISION',
      rssi: -86,
      ssid: 'DogeMiles',
    },
  },
  {
    name: 'EVILTWIN ssid containing colon',
    input: 'AH5: EVILTWIN:AA:BB:CC:DD:EE:FF:SSID_COLLISION:-86:net:work',
    expectKinds: ['alert'],
    expectCategory: 'sentinel',
    expectData: { rssi: -86, ssid: 'net:work' },
  },
  {
    name: 'OWE_ABUSE',
    input: 'AH5: OWE_ABUSE:AA:BB:CC:DD:EE:FF:MyNet:-50',
    expectKinds: ['alert'],
    expectCategory: 'sentinel',
  },
  {
    name: 'PMKID_FORGE',
    input: 'AH5: PMKID_FORGE:AA:BB:CC:DD:EE:FF:FAKE_M1:-58',
    expectKinds: ['alert'],
    expectCategory: 'sentinel',
  },
  {
    name: 'PMKID_HARVEST',
    input: 'AH5: PMKID_HARVEST:AA:BB:CC:DD:EE:FF:11:22:33:44:55:66:-60',
    expectKinds: ['alert'],
    expectCategory: 'sentinel',
  },
  {
    name: 'EAPOL_BAIT',
    input: 'AH5: EAPOL_BAIT:AA:BB:CC:DD:EE:FF:11:22:33:44:55:66:3:-55:80',
    expectKinds: ['alert'],
    expectCategory: 'sentinel',
  },
  {
    name: 'HSHK',
    input: 'AH5: HSHK:AA:BB:CC:DD:EE:FF:11:22:33:44:55:66:2:5:-55',
    expectKinds: ['alert'],
    expectCategory: 'sentinel',
  },
  {
    name: 'KARMA_CAND',
    input: 'AH5: KARMA_CAND:AA:BB:CC:DD:EE:FF:4',
    expectKinds: ['alert'],
    expectCategory: 'sentinel',
  },
  {
    name: 'KARMA_CONFIRMED',
    input: 'AH5: KARMA_CONFIRMED:AA:BB:CC:DD:EE:FF:-50',
    expectKinds: ['alert'],
    expectCategory: 'sentinel',
  },
  {
    name: 'PWNAGOTCHI',
    input: 'AH5: PWNAGOTCHI:AA:BB:CC:DD:EE:FF:-48',
    expectKinds: ['alert'],
    expectCategory: 'sentinel',
  },
  {
    name: 'PROBE_FLOOD',
    input: 'AH5: PROBE_FLOOD:MyNet:120:-40',
    expectKinds: ['alert'],
    expectCategory: 'sentinel',
  },
  {
    name: 'PROBE_FLOOD_BEHAVE',
    input: 'AH5: PROBE_FLOOD_BEHAVE:MyNet:src=7:-42',
    expectKinds: ['alert'],
    expectCategory: 'sentinel',
  },
  {
    name: 'PROBE_FLOOD_AP',
    input: 'AH5: PROBE_FLOOD_AP:15:-38',
    expectKinds: ['alert'],
    expectCategory: 'sentinel',
  },
  {
    name: 'SAE_DOS',
    input: 'AH5: SAE_DOS:AA:BB:CC:DD:EE:FF:12',
    expectKinds: ['alert'],
    expectCategory: 'sentinel',
  },
  {
    name: 'DEAUTH_FLOOD',
    input: 'AH5: DEAUTH_FLOOD:AA:BB:CC:DD:EE:FF:42:-38',
    expectKinds: ['alert'],
    expectCategory: 'sentinel',
  },
  {
    name: 'DEAUTH_FORGE',
    input: 'AH5: DEAUTH_FORGE:AA:BB:CC:DD:EE:FF:tool_x:-40',
    expectKinds: ['alert'],
    expectCategory: 'sentinel',
  },
  {
    name: 'DEAUTH_AP_TARGETED',
    input: 'AH5: DEAUTH_AP_TARGETED:AA:BB:CC:DD:EE:FF:targeted:9',
    expectKinds: ['alert'],
    expectCategory: 'sentinel',
  },
  {
    name: 'BEACON_FLOOD',
    input: 'AH5: BEACON_FLOOD:35',
    expectKinds: ['alert'],
    expectCategory: 'sentinel',
  },
  {
    name: 'BEACON_FORGE',
    input: 'AH5: BEACON_FORGE:AA:BB:CC:DD:EE:FF:reason:-44',
    expectKinds: ['alert'],
    expectCategory: 'sentinel',
  },
  {
    name: 'ASSOC_SLEEP',
    input: 'AH5: ASSOC_SLEEP:AA:BB:CC:DD:EE:FF:8:-46',
    expectKinds: ['alert'],
    expectCategory: 'sentinel',
  },
  {
    name: 'AUTH_FLOOD',
    input: 'AH5: AUTH_FLOOD:AA:BB:CC:DD:EE:FF:30:-41',
    expectKinds: ['alert'],
    expectCategory: 'sentinel',
  },
  {
    name: 'SSID_CONFUSION',
    input: 'AH5: SSID_CONFUSION:AA:BB:CC:DD:EE:FF:3',
    expectKinds: ['alert'],
    expectCategory: 'sentinel',
  },
  {
    name: 'FRAG',
    input: 'AH5: FRAG:AA:BB:CC:DD:EE:FF:overlap',
    expectKinds: ['alert'],
    expectCategory: 'sentinel',
  },
  {
    name: 'JAMMING',
    input: 'AH5: JAMMING:6:88:120',
    expectKinds: ['alert'],
    expectCategory: 'sentinel',
  },
  {
    name: 'ATTACKER_HUNT',
    input: 'AH5: ATTACKER_HUNT:AA:BB:CC:DD:EE:FF:DEAUTH',
    expectKinds: ['alert'],
    expectCategory: 'sentinel',
  },
  {
    name: 'RECON',
    input: 'AH5: RECON:T-abc123:87',
    expectKinds: ['alert'],
    expectCategory: 'sentinel',
  },

  // ─── SENTINEL / CONFIG ACKS ───
  {
    name: 'SENTINEL_ACK ON',
    input: 'AH5: SENTINEL_ACK:ON run=1',
    expectKinds: ['command-ack', 'alert'],
  },
  {
    name: 'SENTINEL_ACK OFF',
    input: 'AH5: SENTINEL_ACK:OFF',
    expectKinds: ['command-ack', 'alert'],
  },
  {
    name: 'SENTINEL_STATUS',
    input: 'AH5: SENTINEL_STATUS: en=1 run=0',
    expectKinds: ['command-result', 'alert'],
  },
  { name: 'SENTINEL_MODE_ACK', input: 'AH5: SENTINEL_MODE_ACK:scan', expectKinds: ['command-ack'] },
  { name: 'SENTINEL_BOOT_ACK', input: 'AH5: SENTINEL_BOOT_ACK:on', expectKinds: ['command-ack'] },
  { name: 'GROUP_ACK', input: 'AH5: GROUP_ACK:OK:dos:on', expectKinds: ['command-ack'] },
  { name: 'DETECT_CFG_ACK', input: 'AH5: DETECT_CFG_ACK:OK', expectKinds: ['command-ack'] },
  {
    name: 'DETECT_CFG_LEN',
    input: 'AH5: DETECT_CFG_LEN:128 (see serial)',
    expectKinds: ['command-result'],
  },
  {
    name: 'INCIDENTS_LEN',
    input: 'AH5: INCIDENTS_LEN:12 (see serial)',
    expectKinds: ['command-result'],
  },
  {
    name: 'INCIDENTS_CLEAR_ACK',
    input: 'AH5: INCIDENTS_CLEAR_ACK:OK',
    expectKinds: ['command-ack'],
  },
  { name: 'DEDUP_CLEAR_ACK', input: 'AH5: DEDUP_CLEAR_ACK:OK', expectKinds: ['command-ack'] },

  // ─── CSI ───
  {
    name: 'CSI_MOTION',
    input: 'AH5: CSI_MOTION: CH=6 N=2 S=0.45',
    expectKinds: ['alert'],
    expectCategory: 'sentinel',
  },
  {
    name: 'CSI_CLEAR',
    input: 'AH5: CSI_CLEAR: CH=6 D=42s',
    expectKinds: ['alert'],
    expectCategory: 'sentinel',
  },
  { name: 'CSI_ACK STARTED', input: 'AH5: CSI_ACK:STARTED', expectKinds: ['command-ack'] },
  { name: 'CSI_ACK BUSY', input: 'AH5: CSI_ACK:BUSY', expectKinds: ['command-ack'] },
  {
    name: 'CSI_CFG_ACK',
    input:
      'AH5: CSI_CFG_ACK:SENSITIVITY=0.077 MIN_MOTION=8s CLEAR_AFTER=8s SPOTS=1 CH=0 BROADCAST=ON REQUIRE_CE=OFF ALLOW_RANDOM=OFF',
    expectKinds: ['command-ack'],
  },
  { name: 'CSI_RECAL_ACK', input: 'AH5: CSI_RECAL_ACK:OK', expectKinds: ['command-ack'] },
  {
    name: 'CSI_EXCLUDE_ACK',
    input: 'AH5: CSI_EXCLUDE_ACK:AA:BB:CC:DD:EE:FF (matches the first five bytes)',
    expectKinds: ['command-ack'],
  },
  { name: 'CSI_STATUS_LEN', input: 'AH5: CSI_STATUS_LEN:512', expectKinds: ['command-result'] },
  { name: 'CSI_JSON_LEN', input: 'AH5: CSI_JSON_LEN:900', expectKinds: ['command-result'] },
  {
    name: 'FACTORY_RESET_ACK',
    input: 'AH5: FACTORY_RESET_ACK:FULL - rebooting',
    expectKinds: ['command-ack'],
  },

  // ─── MESH GUARD / COORDINATION / NODE EVENTS ───
  {
    name: 'MESH_CMD_INJECT',
    input: 'AH5: MESH_CMD_INJECT:BADNODE:@ALL TRIANGULATE',
    expectKinds: ['alert'],
    expectCategory: 'mesh-guard',
  },
  {
    name: 'MESH_FLOOD',
    input: 'AH5: MESH_FLOOD:250',
    expectKinds: ['alert'],
    expectCategory: 'mesh-guard',
  },
  {
    name: 'TOF_PING',
    input: 'AH5: TOF_PING:*:5:123456',
    expectKinds: ['alert'],
    expectCategory: 'mesh-coordination',
  },
  {
    name: 'CHAN_ASSIGN',
    input: 'AH5: CHAN_ASSIGN:AH6:1,6,11',
    expectKinds: ['alert'],
    expectCategory: 'mesh-coordination',
  },
  {
    name: 'DEVICE_DISAPPEARED',
    input: 'AH5: DEVICE_DISAPPEARED: AA:BB:CC:DD:EE:FF absent:300s',
    expectKinds: ['alert'],
    expectCategory: 'baseline',
  },
  {
    name: 'RID_RX',
    input: 'AH5: RID_RX:DRONE1:-70:37.1:-122.2:1',
    expectKinds: ['alert'],
    expectCategory: 'drone',
  },
  {
    name: 'RID_CLAIM',
    input: 'AH5: RID_CLAIM:DRONE1:37.1:-122.2:100.5',
    expectKinds: ['alert'],
    expectCategory: 'drone',
  },

  // ─── v1.0.5 firmware formats (network_mesh.cpp, detect.cpp, drone_detector.cpp, pcap.cpp) ───
  {
    name: 'STATUS with Rst Camp and GPS',
    input:
      'AH5: STATUS: Mode:WiFi+BLE Scan:IDLE Hits:0 Temp:41.5C Up:00:12:03 Rst:POWERON Camp:site-a GPS:12.345334,-54.321611 HDOP=0.8',
    expectKinds: ['node-telemetry', 'command-result'],
  },
  {
    name: 'STATUS with Rst only',
    input: 'AH5: STATUS: Mode:WiFi Scan:ACTIVE Hits:3 Temp:41.5C Up:00:12:03 Rst:TASK_WDT',
    expectKinds: ['node-telemetry', 'command-result'],
  },
  {
    name: 'SUMMARY',
    input:
      'AH5: SUMMARY: Mode:WiFi+BLE Scan:IDLE Dev:120 Tgt:4 Hits:7 Inc:2 Camp:site-a Up:00:12:03',
    expectKinds: ['command-result'],
  },
  {
    name: 'DEVICE with continuation rows',
    input:
      'AH5: DEVICE:AA:BB:CC:DD:EE:FF W -72 C6 N:HomeRouter\n112233445566 B -85 N:Speaker\n665544332211 W -60 C11',
    expectKinds: ['device-seen'],
    skipHop: true,
  },
  {
    name: 'DRONE without GPS',
    input: 'AH5: DRONE: AA:BB:CC:DD:EE:FF ID:DJI-Mini3 R-75',
    expectKinds: ['alert'],
    expectCategory: 'drone',
  },
  {
    name: 'DRONE_LOST',
    input: 'AH5: DRONE_LOST: AA:BB:CC:DD:EE:FF ID:DJI-Mini3 AGE:45',
    expectKinds: ['alert'],
    expectCategory: 'drone',
  },
  {
    name: 'RADIO_DETECTED',
    input: 'AH5: RADIO_DETECTED:Meshtastic:AA:BB:CC:DD:EE:FF:-70:Meshtastic_1a2b',
    expectKinds: ['alert'],
    expectCategory: 'sentinel',
    expectData: {
      detectionType: 'RADIO_DETECTED',
      radio: 'Meshtastic',
      mac: 'AA:BB:CC:DD:EE:FF',
      rssi: -70,
      name: 'Meshtastic_1a2b',
    },
  },
  {
    name: 'RADIO_DETECTED empty name',
    input: 'AH5: RADIO_DETECTED:MeshCore:AA:BB:CC:DD:EE:FF:-70:',
    expectKinds: ['alert'],
    expectCategory: 'sentinel',
    expectData: { radio: 'MeshCore', rssi: -70 },
  },
  {
    name: 'JAMMING_BASELINE',
    input: 'AH5: JAMMING_BASELINE:6:silence:42',
    expectKinds: ['alert'],
    expectCategory: 'sentinel',
    expectData: { detectionType: 'JAMMING_BASELINE', channel: 6, rule: 'silence', value: 42 },
  },
  {
    name: 'CSA_SPOOF',
    input: 'AH5: CSA_SPOOF:AA:BB:CC:DD:EE:FF:60:-55',
    expectKinds: ['alert'],
    expectCategory: 'sentinel',
    expectData: { detectionType: 'CSA_SPOOF', bssid: 'AA:BB:CC:DD:EE:FF', value: 60, rssi: -55 },
  },
  {
    name: 'QUIET_ABUSE',
    input: 'AH5: QUIET_ABUSE:AA:BB:CC:DD:EE:FF:1500:-55',
    expectKinds: ['alert'],
    expectCategory: 'sentinel',
    expectData: {
      detectionType: 'QUIET_ABUSE',
      bssid: 'AA:BB:CC:DD:EE:FF',
      value: 1500,
      rssi: -55,
    },
  },
  {
    name: 'FLEET_AP',
    input: 'AH5: FLEET_AP:AA:BB:CC:DD:EE:FF',
    expectKinds: ['alert'],
    expectCategory: 'mesh-coordination',
  },
  {
    name: 'FLEET_RADIO',
    input: 'AH5: FLEET_RADIO:AH7:ah07',
    expectKinds: ['alert'],
    expectCategory: 'mesh-coordination',
  },
  {
    name: 'PCAP_START line',
    input: 'AH5: PCAP_START: WIFI D=300',
    expectKinds: ['alert'],
    expectCategory: 'pcap',
  },
  {
    name: 'PCAP_DONE',
    input: 'AH5: PCAP_DONE: F=1200 B=345678 D=0 R=SIZECAP',
    expectKinds: ['alert', 'command-ack'],
    expectCategory: 'pcap-done',
    expectData: { F: 1200, B: 345678, D: 0, R: 'SIZECAP' },
  },
  {
    name: 'BASELINE_WATCH',
    input: 'AH5: BASELINE_WATCH: New=3 Gone=1 Moved=2 Both=40',
    expectKinds: ['alert'],
    expectCategory: 'baseline',
    expectData: { added: 3, gone: 1, moved: 2, both: 40 },
  },
  {
    name: 'CAMPAIGN_ACK start',
    input: 'AH5: CAMPAIGN_ACK:START:site-a',
    expectKinds: ['command-ack'],
  },
  {
    name: 'CAMPAIGN_ACK stop',
    input: 'AH5: CAMPAIGN_ACK:STOP:site-a',
    expectKinds: ['command-ack'],
  },
  { name: 'CAMPAIGN_ACK none', input: 'AH5: CAMPAIGN_ACK:NONE', expectKinds: ['command-ack'] },
  {
    name: 'CAMPAIGN_STATUS',
    input: 'AH5: CAMPAIGN_STATUS:site-a',
    expectKinds: ['command-result'],
  },
  { name: 'SCHED_ACK ok', input: 'AH5: SCHED_ACK:OK', expectKinds: ['command-ack'] },
  { name: 'SCHED_ACK err', input: 'AH5: SCHED_ACK:ERR bad time', expectKinds: ['command-ack'] },
  { name: 'SCHED_ACK deleted', input: 'AH5: SCHED_ACK:DELETED', expectKinds: ['command-ack'] },
  { name: 'SCHED_LIST', input: 'AH5: SCHED_LIST:2', expectKinds: ['command-result'] },
  { name: 'CALIBRATE_ACK', input: 'AH5: CALIBRATE_ACK:STARTED', expectKinds: ['command-ack'] },
  { name: 'CALIBRATE_ACK reset', input: 'AH5: CALIBRATE_ACK:RESET', expectKinds: ['command-ack'] },
  {
    name: 'CALIBRATE_DONE',
    input: 'AH5: CALIBRATE_DONE:WIFI=-41.5:BLE=NONE',
    expectKinds: ['alert', 'command-ack'],
    expectCategory: 'calibration',
    expectData: { result: 'OK', wifiRssi0: -41.5 },
  },
  {
    name: 'CALIBRATE_DONE failed',
    input: 'AH5: CALIBRATE_DONE:FAILED',
    expectKinds: ['alert', 'command-ack'],
    expectCategory: 'calibration',
    expectData: { result: 'FAILED' },
  },
  { name: 'SELF_RADIO_ACK ok', input: 'AH5: SELF_RADIO_ACK:OK', expectKinds: ['command-ack'] },
  {
    name: 'SELF_RADIO_ACK prefix',
    input: 'AH5: SELF_RADIO_ACK:Meshtastic',
    expectKinds: ['command-ack'],
  },
  { name: 'RADIO_KNOWN_ACK', input: 'AH5: RADIO_KNOWN_ACK:OK:3', expectKinds: ['command-ack'] },
  {
    name: 'RADIO_KNOWN_ACK full',
    input: 'AH5: RADIO_KNOWN_ACK:FAILED:FULL',
    expectKinds: ['command-ack'],
  },
  {
    name: 'VIBSCAN_ACK',
    input: 'AH5: VIBSCAN_ACK:OK En:1 Mode:2 Dur:60s Cd:300s Pre:0',
    expectKinds: ['command-ack'],
  },
  {
    name: 'VIBSCAN_STATUS',
    input: 'AH5: VIBSCAN_STATUS: En:1 Mode:2 Dur:60s Cd:300s Pre:0',
    expectKinds: ['command-result'],
  },
  {
    name: 'ATTACKER_TRILAT_ACK',
    input: 'AH5: ATTACKER_TRILAT_ACK:ON',
    expectKinds: ['command-ack'],
  },
  {
    name: 'ATTACKER_TRILAT_STATUS',
    input: 'AH5: ATTACKER_TRILAT_STATUS: ON',
    expectKinds: ['command-result'],
  },
  {
    name: 'DETECT_COUNTS',
    input:
      'AH5: DETECT_COUNTS: karmaCand=1 karmaConf=0 pwna=0 meshradio=2 tsf=0 pg=3 tof=1 hunts=0 hshk=0 peers=1 arPending=0',
    expectKinds: ['command-result'],
  },
  { name: 'DETECT_CLEAR_ACK', input: 'AH5: DETECT_CLEAR_ACK:OK', expectKinds: ['command-ack'] },
  {
    name: 'PCAP_AUTO_ACK',
    input: 'AH5: PCAP_AUTO_ACK:BUDGET=512MB FLOOR=256MB',
    expectKinds: ['command-ack'],
  },
  { name: 'SD_REPAIR_ACK', input: 'AH5: SD_REPAIR_ACK:ON', expectKinds: ['command-ack'] },
  {
    name: 'MESH_TX_CANCEL_ACK',
    input: 'AH5: MESH_TX_CANCEL_ACK:EMPTY',
    expectKinds: ['command-ack'],
  },
  {
    name: 'DEVICE_DB_CLEAR_ACK',
    input: 'AH5: DEVICE_DB_CLEAR_ACK:OK',
    expectKinds: ['command-ack'],
  },
  { name: 'PROBE_DB_CLEAR_ACK', input: 'AH5: PROBE_DB_CLEAR_ACK:OK', expectKinds: ['command-ack'] },
  { name: 'BASELINE_RESET_ACK', input: 'AH5: BASELINE_RESET_ACK:OK', expectKinds: ['command-ack'] },
  {
    name: 'RANDOMIZATION_RESET_ACK',
    input: 'AH5: RANDOMIZATION_RESET_ACK:BUSY',
    expectKinds: ['command-ack'],
  },
  {
    name: 'ERASE_TOKEN hex with Expires',
    input: 'AH5: ERASE_TOKEN:AH_0A1B2C3D_4E5F6A7B_0000012C Expires:300s',
    expectKinds: ['alert', 'command-ack'],
    expectCategory: 'erase',
    expectData: { token: 'AH_0A1B2C3D_4E5F6A7B_0000012C', time: 300, expiresSeconds: 300 },
  },
  {
    name: 'ERASE_TOKEN rate limited',
    input: 'AH5: ERASE_TOKEN:RATE_LIMITED',
    expectKinds: ['alert', 'command-ack'],
    expectCategory: 'erase',
    expectData: { rateLimited: true },
  },
  {
    name: 'ERASE_ACK DENIED',
    input: 'AH5: ERASE_ACK:DENIED',
    expectKinds: ['alert', 'command-ack'],
    expectCategory: 'erase',
  },
  {
    name: 'ERASE_ACK CANCELED',
    input: 'AH5: ERASE_ACK:CANCELED',
    expectKinds: ['alert', 'command-ack'],
    expectCategory: 'erase',
  },
  {
    name: 'ERASE_ACK SET_KEY_FIRST',
    input: 'AH5: ERASE_ACK:SET_KEY_FIRST',
    expectKinds: ['alert', 'command-ack'],
    expectCategory: 'erase',
  },
];

// ── Wrapper formats ──

function wrapMeshtastic27(msg: string): string {
  return `INFO  | ??:??:?? 491 [Router] Received text msg from=0x433c6268, id=0x69ab9b8c, msg=${msg}`;
}

function wrapMeshtastic26(msg: string): string {
  return `textmessage msg=${msg}`;
}

function wrapHop(msg: string, relayName = 'ah03'): string {
  return `${relayName}: ${msg}`;
}

function wrapChannel(msg: string, channel = 0): string {
  return `${channel}: ${msg}`;
}

// ── Runner ──

const parser = new MeshtasticRewriteParser();

let passed = 0;
let failed = 0;
const failures: string[] = [];

function runTest(label: string, rawInput: string, tc: TestCase): void {
  const sanitized = sanitizeLine(rawInput);
  if (!sanitized) {
    failed++;
    failures.push(
      `FAIL [${label}]: sanitizeLine returned empty\n  input: "${rawInput.slice(0, 100)}"`,
    );
    return;
  }

  const results = parser.parseLine(sanitized);
  if (results.length === 0) {
    failed++;
    failures.push(`FAIL [${label}]: parser returned []\n  sanitized: "${sanitized.slice(0, 100)}"`);
    return;
  }

  const resultKinds = results.map((r) => r.kind);
  const allFound = tc.expectKinds.every((k) =>
    resultKinds.includes(k as SerialParseResult['kind']),
  );
  if (!allFound) {
    failed++;
    failures.push(`FAIL [${label}]: expected [${tc.expectKinds}] got [${resultKinds}]`);
    return;
  }

  if (tc.expectCategory) {
    const alertResult = results.find((r): r is SerialAlertEvent => r.kind === 'alert');
    if (alertResult && alertResult.category !== tc.expectCategory) {
      failed++;
      failures.push(
        `FAIL [${label}]: category "${alertResult.category}" != "${tc.expectCategory}"`,
      );
      return;
    }
  }

  if (tc.expectData) {
    const alertResult = results.find((r): r is SerialAlertEvent => r.kind === 'alert');
    const data = (alertResult?.data ?? {}) as Record<string, unknown>;
    for (const [key, want] of Object.entries(tc.expectData)) {
      if (data[key] !== want) {
        failed++;
        failures.push(
          `FAIL [${label}]: data.${key} = ${JSON.stringify(data[key])} != ${JSON.stringify(want)}`,
        );
        return;
      }
    }
  }

  passed++;
}

console.log('═══════════════════════════════════════════════════');
console.log('  Serial Pipeline End-to-End Test');
console.log('  sanitizeLine → parser.parseLine');
console.log('═══════════════════════════════════════════════════\n');

for (const tc of FIRMWARE_MESSAGES) {
  // RAW (direct protobuf TEXT_MESSAGE_APP path)
  runTest(`RAW: ${tc.name}`, tc.input, tc);

  // Skip bracket-format messages for wrapped tests
  if (tc.input.startsWith('[NODE_HB]')) continue;

  // Meshtastic 2.7 Router format
  runTest(`M27: ${tc.name}`, wrapMeshtastic27(tc.input), tc);

  // Meshtastic 2.6 textmessage format
  runTest(`M26: ${tc.name}`, wrapMeshtastic26(tc.input), tc);

  // Channel prefix
  runTest(`CHAN: ${tc.name}`, wrapChannel(tc.input), tc);

  // Hop prefix (relay node)
  if (!tc.skipHop) {
    runTest(`HOP: ${tc.name}`, wrapHop(tc.input), tc);
    runTest(`HOP+M27: ${tc.name}`, wrapMeshtastic27(wrapHop(tc.input)), tc);
  }
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);

if (failures.length > 0) {
  console.log('FAILURES:\n');
  failures.forEach((f) => console.log(`  ${f}\n`));
  process.exit(1);
} else {
  console.log('ALL TESTS PASSED\n');
}
