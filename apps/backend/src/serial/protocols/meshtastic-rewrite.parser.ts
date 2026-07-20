import { SerialParseResult, SerialProtocolParser, SerialProbeHit } from '../serial.types';

// Parser rewritten from catalog in meshmessages.xlsx/README.
// Triangulation multi-line results are left as raw.

// eslint-disable-next-line no-control-regex -- used to strip ANSI escape codes
const ANSI_REGEX = /\u001b\[[0-9;]*[A-Za-z]/g;

const STATUS_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+)?:?\s*STATUS:\s*Mode:(?<mode>\S+)\s+Scan:(?<scan>\S+)\s+Hits:(?<hits>\d+)\s+(?:Targets:(?<targets>\d+)\s+)?Temp:(?<tempC>-?\d+(?:\.\d+)?)[cC](?:\/(?<tempF>-?\d+(?:\.\d+)?)[Ff])?\s+Up:(?<up>[0-9:]+)(?:\s+GPS[:=](?<lat>-?\d+(?:\.\d+)?),(?<lon>-?\d+(?:\.\d+)?))?(?:\s+HDOP[:=](?<hdop>-?\d+(?:\.\d+)?))?/i;
const STARTUP_REGEX = /^(?<id>[A-Za-z0-9_.:-]+)?:?\s*STARTUP:\s*(?<msg>.+)$/i;
const GPS_LOCK_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+)?:?\s*GPS:\s*LOCKED\s+Location[=:](?<lat>-?\d+(?:\.\d+)?),(?<lon>-?\d+(?:\.\d+)?)(?:\s+Satellites[=:](?<sats>\d+))?(?:\s+HDOP[=:](?<hdop>-?\d+(?:\.\d+)?))?/i;
const GPS_LOST_REGEX = /^(?<id>[A-Za-z0-9_.:-]+)?:?\s*GPS:\s*LOST/i;
const NODE_HB_REGEX =
  /^\[NODE_HB\]\s*(?<id>[A-Za-z0-9_.:-]+)\s+Time:(?<time>[^ ]+)\s+Temp:(?<tempC>-?\d+(?:\.\d+)?)(?:[cCfF])?(?:\/(?<tempF>-?\d+(?:\.\d+)?)[fF])?(?:\s+GPS:(?<lat>-?\d+(?:\.\d+)?),(?<lon>-?\d+(?:\.\d+)?))?/i;
const NODE_HB_INLINE_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):?\s*Time:(?<time>[^ ]+)\s+Temp:(?<tempC>-?\d+(?:\.\d+)?)(?:[cCfF])?(?:\/(?<tempF>-?\d+(?:\.\d+)?)[fF])?(?:\s+GPS:(?<lat>-?\d+(?:\.\d+)?),(?<lon>-?\d+(?:\.\d+)?))?/i;

const TARGET_REGEX_TYPE_FIRST =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*Target:\s*(?<type>\w+)\s+(?<mac>(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})\s+RSSI:(?<rssi>-?\d+)(?:\s+Name:(?<name>[^ ]+))?(?:\s+GPS[:=](?<lat>-?\d+(?:\.\d+)?),(?<lon>-?\d+(?:\.\d+)?))?/i;
const TARGET_REGEX_MAC_FIRST =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*Target:\s*(?<mac>(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})\s+RSSI:(?<rssi>-?\d+)\s+Type:(?<type>\w+)(?:\s+Name:(?<name>[^ ]+))?(?:\s+GPS[:=](?<lat>-?\d+(?:\.\d+)?),(?<lon>-?\d+(?:\.\d+)?))?/i;
const TRI_TARGET_DATA_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*(?:TARGET_DATA|T_D):\s*(?<mac>(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})\s+RSSI:(?<rssi>-?\d+)\s+Hits=(?<hits>\d+)\s+Type:(?<type>WiFi|BLE)(?:\s+GPS=(?<lat>-?\d+(?:\.\d+)?),(?<lon>-?\d+(?:\.\d+)?))?(?:\s+HDOP=(?<hdop>-?\d+(?:\.\d+)?))?(?:\s+TS=(?<ts>-?\d+(?:\.\d+)?))?/i;
const DEVICE_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*DEVICE:(?<mac>(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})\s+(?<band>[A-Za-z])\s+(?<rssi>-?\d+)(?:\s+C(?<channel>\d+))?(?:\s+N:(?<name>.+))?/i;
const DRONE_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*DRONE:\s+(?<mac>(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})\s+ID:(?<droneId>[A-Za-z0-9_-]+)\s+R(?<rssi>-?\d+)\s+GPS:(?<lat>-?\d+(?:\.\d+)?),(?<lon>-?\d+(?:\.\d+)?)(?:\s+ALT:(?<alt>-?\d+(?:\.\d+)?))?(?:\s+SPD:(?<spd>-?\d+(?:\.\d+)?))?(?:\s+OP:(?<opLat>-?\d+(?:\.\d+)?),(?<opLon>-?\d+(?:\.\d+)?))?/i;

const ANOMALY_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*ANOMALY-(?<kind>NEW|RETURN|RSSI):\s*(?<type>\w+)\s+(?<mac>(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})(?:\s+RSSI:(?<rssi>-?\d+))?(?:\s+Old:(?<old>-?\d+)\s+New:(?<new>-?\d+)\s+Delta:(?<delta>-?\d+))?(?:\s+Name:(?<name>[^ ]+))?/i;

const ATTACK_LONG_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*ATTACK:\s*(?<kind>DEAUTH|DISASSOC)(?:\s+\[(?<mode>BROADCAST|TARGETED)\])?\s+SRC:(?<src>(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})\s+DST:(?<dst>(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})\s+RSSI:(?<rssi>-?\d+)d?Bm?\s+CH:(?<chan>\d+)/i;
const ATTACK_SHORT_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*ATTACK:\s*(?<kind>DEAUTH|DISASSOC)\s+(?<src>(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})->(?<dst>(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})\s+R(?<rssi>-?\d+)\s+C(?<chan>\d+)/i;

const RANDOM_IDENTITY_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*IDENTITY:(?<tag>T-[A-Za-z0-9]+)\s+(?<band>[WB])\s+MACs:(?<macs>\d+)\s+Conf:(?<conf>\d+(?:\.\d+)?)\s+Sess:(?<sess>\d+)\s+Anchor:(?<anchor>(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})/i;
const RANDOM_DONE_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*RANDOMIZATION_DONE:\s*Identities=(?<ids>\d+)\s+Sessions=(?<sess>\d+)\s+TX=(?<tx>\d+)\s+PEND=(?<pend>\d+)/i;

const VIBRATION_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*VIBRATION:\s*(?<msg>.+?)(?:\s+GPS:(?<lat>-?\d+(?:\.\d+)?),(?<lon>-?\d+(?:\.\d+)?))?(?:\s+TAMPER_ERASE_IN:(?<erase>\d+)s)?/i;
const VIBRATION_STATUS_REGEX = /^(?<id>[A-Za-z0-9_.:-]+):\s*VIBRATION_STATUS:\s*(?<msg>.+)$/i;
const SETUP_REGEX = /^(?<id>[A-Za-z0-9_.:-]+):\s*SETUP_(?<kind>MODE|COMPLETE):\s*(?<msg>.+)$/i;
const TAMPER_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*TAMPER_(?<kind>DETECTED|CANCELLED):?(?:\s*(?<msg>.+))?/i;
const ERASE_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*ERASE_(?<kind>EXECUTING|ACK|CANCELLED|COMPLETE):(?<msg>.+)?/i;
const AUTOERASE_ACK_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*AUTOERASE_ACK:(?<status>ENABLED|DISABLED)(?:\s+Setup:(?<setup>\d+)s)?(?:\s+Erase:(?<erase>\d+)s)?(?:\s+Vibs:(?<vibs>\d+))?(?:\s+Window:(?<window>\d+)s)?(?:\s+Cooldown:(?<cooldown>\d+)s)?/i;
const AUTOERASE_STATUS_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*AUTOERASE_STATUS:\s*Enabled:(?<enabled>YES|NO)(?:\s+SetupMode:(?<setupMode>\S+))?(?:\s+TamperActive:(?<tamperActive>YES|NO))?(?:\s+Setup:(?<setup>\d+)s)?(?:\s+Erase:(?<erase>\d+)s)?(?:\s+Vibs:(?<vibs>\d+))?(?:\s+Window:(?<window>\d+)s)?(?:\s+Cooldown:(?<cooldown>\d+)s)?/i;
const BASELINE_STATUS_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*BASELINE_STATUS:\s*Scanning:(?<scanning>YES|NO)\s+Established:(?<est>YES|NO)\s+Devices:(?<dev>\d+)\s+Anomalies:(?<anom>\d+)\s+Phase1:(?<phase>[A-Z]+)/i;
const BATTERY_SAVER_STATUS_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*BATTERY_SAVER_STATUS:\s*Enabled:(?<enabled>YES|NO)(?:\s+Temp:(?<tempC>-?\d+(?:\.\d+)?)[cC])?(?:\s+GPS:(?<lat>-?\d+(?:\.\d+)?),(?<lon>-?\d+(?:\.\d+)?))?/i;

const HEARTBEAT_REGEX = /^(?<id>[A-Za-z0-9_.:-]+):\s*HEARTBEAT:\s*(?<msg>.+)$/i;
const ACK_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*(?<kind>(?:SCAN|DEVICE_SCAN|DRONE|DEAUTH|RANDOMIZATION|BASELINE|CONFIG|TRIANGULATE(?:_STOP)?|TRI_START|STOP|REBOOT|BATTERY_SAVER(?:_START|_STOP)?|VIBRATION_(?:ON|OFF)|PROBE|HB)_ACK):?(?<status>[A-Z_]*)/i;

const PROBE_HIT_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*PROBE_HIT:?\s+(?<mac>(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})\s+(?<vendor>\S+)\s+RSSI[=:](?<rssi>-?\d+)(?:\s+CH[=:](?<channel>\d+))?(?:\s+SSID[=:"]*(?<ssid>[^"\s]+)"?)?(?:\s+(?<ghost>GHOST))?(?:\s+(?<dst>DST))?(?:\s+GPS[=:](?<lat>-?\d+(?:\.\d+)?),(?<lon>-?\d+(?:\.\d+)?))?/i;
const HB_ACK_INTERVAL_REGEX = /^(?<id>[A-Za-z0-9_.:-]+):\s*HB_ACK:INTERVAL\s+(?<minutes>\d+)min/i;
const WIPE_TOKEN_REGEX = /^(?<id>[A-Za-z0-9_.:-]+):\s*WIPE_TOKEN:(?<token>[A-Za-z0-9_:-]+)/i;
const ERASE_TOKEN_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*ERASE_TOKEN:(?<token>[A-Za-z0-9_:-]+|\w+)(?:\s+Time:(?<time>\d+)s)?/i;
const TRI_ACK_REGEX = /^(?<id>[A-Za-z0-9_.:-]+):\s*TRIANGULATE_ACK:(?<target>.+)$/i;
const TRI_STOP_ACK_REGEX = /^(?<id>[A-Za-z0-9_.:-]+):\s*TRIANGULATE_STOP_ACK/i;
const BASELINE_ACK_REGEX = /^(?<id>[A-Za-z0-9_.:-]+):\s*BASELINE_ACK:(?<status>[A-Z_]+)/i;
const TRI_RESULTS_START_REGEX = /^(?<id>[A-Za-z0-9_.:-]+):\s*TRIANGULATE_RESULTS_START/i;
const TRI_RESULTS_END_REGEX = /^(?<id>[A-Za-z0-9_.:-]+):\s*TRIANGULATE_RESULTS_END/i;
const TRI_RESULTS_NO_DATA_REGEX = /^(?<id>[A-Za-z0-9_.:-]+):\s*TRIANGULATE_RESULTS:NO_DATA/i;
// Matches echoed @ALL TRIANGULATE_START commands to ignore them
const TRI_START_ECHO_REGEX = /^@ALL\s+TRIANGULATE_START:/i;
// Matches broadcast TRIANGULATE_START messages (without @ prefix): ALL TRIANGULATE_START:MAC:duration:nodeId:rfEnv
const TRI_START_BROADCAST_REGEX =
  /^ALL\s+TRIANGULATE_START:(?<mac>(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}):(?<duration>\d+):(?<originNode>[A-Za-z0-9_-]+):(?<rfEnv>[0-4])$/i;
const TRI_FINAL_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*T_F:\s*MAC=(?<mac>(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})\s+GPS=(?<lat>-?\d+(?:\.\d+)?),(?<lon>-?\d+(?:\.\d+)?)\s+CONF=(?<conf>-?\d+(?:\.\d+)?)\s+UNC=(?<unc>-?\d+(?:\.\d+)?)/i;
const TRI_COMPLETE_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*T_C:\s*(?:MAC=(?<mac>(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})\s+)?Nodes=(?<nodes>\d+)\s*(?<rest>.+)?$/i;
const RTC_SYNC_REGEX = /^(?<id>[A-Za-z0-9_.:-]+):\s*RTC_SYNC:\s*(?<source>\S+)/i;
const TIME_SYNC_REQ_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*TIME_SYNC_REQ:(?<time>\d+):(?<window>\d+):(?<seq>\d+)(?::(?<offset>-?\d+))?/i;
const TIME_SYNC_RESP_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*TIME_SYNC_RESP:(?<time>\d+):(?<window>\d+):(?<seq>\d+)(?::(?<offset>-?\d+))?/i;

const DONE_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*(?<op>SCAN|DEAUTH|DRONE|BASELINE|LIST_SCAN|PROBE)_DONE:\s*(?<body>.+)$/i;

const CODES_REGEX = /^(?<id>[A-Za-z0-9_.:-]+):\s*CODES:(?<codes>.*)$/i;

const SENTINEL_DETECTION_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*(?<type>DEAUTH_AP_TARGETED|DEAUTH_FLOOD|DEAUTH_FORGE|PROBE_FLOOD_BEHAVE|PROBE_FLOOD_AP|PROBE_FLOOD|PMKID_FORGE|PMKID_HARVEST|BEACON_FORGE|BEACON_FLOOD|KARMA_CONFIRMED|KARMA_CAND|EVILTWIN|OWE_ABUSE|ASSOC_SLEEP|SSID_CONFUSION|AUTH_FLOOD|SAE_DOS|EAPOL_BAIT|ATTACKER_HUNT|PWNAGOTCHI|KRACK|HSHK|JAMMING|FRAG|RECON):(?<rest>.*)$/i;

const SENTINEL_FIELD_SCHEMAS: Record<string, string[]> = {
  EAPOL_BAIT: ['src', 'dst', 'count', 'rssi', 'confidence'],
  PMKID_FORGE: ['src', 'tag', 'rssi'],
  PMKID_HARVEST: ['bssid', 'sta', 'rssi'],
  HSHK: ['bssid', 'sta', 'msgNum', 'replayCtr', 'rssi'],
  EVILTWIN: ['bssid', 'reason', 'rssi'],
  OWE_ABUSE: ['bssid', 'ssid', 'rssi'],
  BEACON_FLOOD: ['count'],
  BEACON_FORGE: ['bssid', 'reason', 'rssi'],
  DEAUTH_FLOOD: ['src', 'count', 'rssi'],
  DEAUTH_FORGE: ['src', 'reason', 'rssi'],
  DEAUTH_AP_TARGETED: ['mac', 'reason', 'count'],
  ASSOC_SLEEP: ['bssid', 'count', 'rssi'],
  PROBE_FLOOD: ['name', 'count', 'rssi'],
  PROBE_FLOOD_BEHAVE: ['ssid', 'srcCount', 'rssi'],
  PROBE_FLOOD_AP: ['distinct', 'rssi'],
  SSID_CONFUSION: ['bssid', 'count'],
  AUTH_FLOOD: ['bssid', 'count', 'rssi'],
  SAE_DOS: ['bssid', 'count'],
  FRAG: ['src', 'info'],
  JAMMING: ['channel', 'pdr', 'errors'],
  KARMA_CAND: ['bssid', 'ssids'],
  KARMA_CONFIRMED: ['bssid', 'rssi'],
  PWNAGOTCHI: ['bssid', 'rssi'],
  ATTACKER_HUNT: ['mac', 'attackType'],
  KRACK: ['bssid', 'sta', 'replayCtr'],
  RECON: ['identityId', 'score'],
};

const SENTINEL_MAC_FIELDS = new Set(['mac', 'bssid', 'src', 'dst', 'sta', 'anchor']);
const SENTINEL_STRING_FIELDS = new Set([
  'mac',
  'bssid',
  'src',
  'dst',
  'sta',
  'anchor',
  'reason',
  'info',
  'ssid',
  'name',
  'tag',
  'attackType',
  'identityId',
]);
const SENTINEL_NOTICE_TYPES = new Set([
  'RECON',
  'KARMA_CAND',
  'BEACON_FLOOD',
  'PROBE_FLOOD_BEHAVE',
]);
const SENTINEL_MAC_HEAD_REGEX = /^(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}/;
const NUMERIC_VALUE_REGEX = /^-?\d+(?:\.\d+)?$/;

const MESH_GUARD_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*(?<type>MESH_SPOOF_SELF|MESH_FLOOD|MESH_CMD_INJECT):(?<rest>.*)$/i;
const MESH_COORD_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*(?<type>TOF_PING|TOF_PONG|BLOOM|IDHASH|CHAN_ASSIGN):(?<rest>.*)$/i;
const DEVICE_DISAPPEARED_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*DEVICE_DISAPPEARED:\s*(?<mac>(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})\s+absent:(?<absent>\d+)s/i;
const RID_RX_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*RID_RX:(?<uavId>[^:]+):(?<rssi>-?\d+):(?<lat>-?\d+(?:\.\d+)?):(?<lon>-?\d+(?:\.\d+)?):(?<gpsValid>\d+)/i;
const RID_CLAIM_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*RID_CLAIM:(?<uavId>[^:]+):(?<lat>-?\d+(?:\.\d+)?):(?<lon>-?\d+(?:\.\d+)?):(?<alt>-?\d+(?:\.\d+)?)/i;

const SENTINEL_ACK_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*SENTINEL_ACK:(?<state>ON|OFF)(?:\s+run=(?<run>\d))?/i;
const SENTINEL_STATUS_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*SENTINEL_STATUS:\s*en=(?<enabled>\d)\s+run=(?<running>\d)/i;
const SENTINEL_MODE_ACK_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*SENTINEL_MODE_ACK:(?<mode>scan|defend|FAIL)/i;
const SENTINEL_BOOT_ACK_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*SENTINEL_BOOT_ACK:(?<state>on|off)/i;
const GROUP_ACK_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*GROUP_ACK:(?<status>OK|FAIL):(?<rest>.+)$/i;
const DETECT_CFG_ACK_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*DETECT_CFG_ACK:(?<status>OK|FAIL)/i;
const DETECT_CFG_LEN_REGEX = /^(?<id>[A-Za-z0-9_.:-]+):\s*DETECT_CFG_LEN:(?<len>\d+)/i;
const INCIDENTS_LEN_REGEX = /^(?<id>[A-Za-z0-9_.:-]+):\s*INCIDENTS_LEN:(?<len>\d+)/i;
const INCIDENTS_CLEAR_ACK_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*INCIDENTS_CLEAR_ACK:(?<status>[A-Z_]+)/i;
const DEDUP_CLEAR_ACK_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*DEDUP_CLEAR_ACK:(?<status>[A-Z_]+)/i;
const FACTORY_RESET_ACK_REGEX =
  /^(?<id>[A-Za-z0-9_.:-]+):\s*FACTORY_RESET_ACK:(?<status>.+)$/i;

const NODE_ID_FALLBACK = /^([A-Za-z0-9_.:-]+)/;

export class MeshtasticRewriteParser implements SerialProtocolParser {
  parseLine(rawLine: string): SerialParseResult[] {
    const sanitized = this.normalize(rawLine);
    if (!sanitized) return [];

    // Drop tiny ANSI fragments like "0m" to avoid contaminating the next line.
    if (sanitized.length <= 3 && /^[0m\s]*$/i.test(sanitized)) {
      return [];
    }

    // Check if this is a Meshtastic 2.6+/2.7+ Router/SerialConsole echo with msg= format
    const msgIndex = sanitized.lastIndexOf('msg=');
    const hasMsgSegment = msgIndex >= 0;
    // Meshtastic 2.6 uses "textmessage msg=...", 2.7+ uses "[Router] Received text msg ... msg=..."
    const isMeshtasticEcho =
      hasMsgSegment &&
      (/\[(Router|SerialConsole)\]/i.test(sanitized) ||
        /^textmessage\s+msg=/i.test(sanitized) ||
        /\btextmessage\s+msg=/i.test(sanitized)) &&
      (/Received text msg/i.test(sanitized) || /textmessage/i.test(sanitized));

    // Extract payload: for Mesh echoes, get text after msg=; otherwise use msg= content or full line
    let payloadRaw: string;
    if (isMeshtasticEcho) {
      // Extract everything after "msg=" for Meshtastic 2.6+/2.7 format
      payloadRaw = sanitized.slice(msgIndex + 4).trim();
    } else if (hasMsgSegment) {
      // Standard msg= format from other sources
      payloadRaw = sanitized.slice(msgIndex + 4).trim();
    } else {
      payloadRaw = sanitized;
    }
    const normalizedPayloadRaw = payloadRaw
      .replace(/\r?\n\s*Type:/g, ' Type:')
      .replace(/\r?\n\s*RSSI:/g, ' RSSI:')
      .replace(/\r?\n\s*GPS=/g, ' GPS=');
    const payload = this.stripTrailingHash(normalizedPayloadRaw.replace(/^0m\s*/i, ''));
    const sourceId = this.extractSourceId(sanitized);

    // Ignore echoed TRIANGULATE_START commands (sent by app, echoed back by mesh)
    if (TRI_START_ECHO_REGEX.test(payload) || TRI_START_ECHO_REGEX.test(sanitized)) {
      return [];
    }

    const parsed =
      this.parseTarget(payload, sourceId, sanitized) ||
      this.parseTriangulationTarget(payload, sourceId, sanitized) ||
      this.parseDevice(payload, sourceId, sanitized) ||
      this.parseDrone(payload, sourceId, sanitized) ||
      this.parseProbeHit(payload, sourceId, sanitized) ||
      this.parseAnomaly(payload, sourceId, sanitized) ||
      this.parseAttack(payload, sourceId, sanitized) ||
      this.parseSentinelDetection(payload, sourceId, sanitized) ||
      this.parseMeshGuard(payload, sourceId, sanitized) ||
      this.parseNodeEvents(payload, sourceId, sanitized) ||
      this.parseMeshCoordination(payload, sourceId, sanitized) ||
      this.parseRandomization(payload, sourceId, sanitized) ||
      this.parseDoneSummary(payload, sourceId, sanitized) ||
      this.parseVibration(payload, sourceId, sanitized) ||
      this.parseTamper(payload, sourceId, sanitized) ||
      this.parseCodes(payload, sourceId, sanitized) ||
      this.parseTriangulationMeta(payload, sourceId, sanitized) ||
      this.parseSentinelAck(payload, sourceId, sanitized) ||
      this.parseStatus(payload, sourceId, sanitized) ||
      this.parseTimeSync(payload, sourceId, sanitized) ||
      this.parseStartupGpsHeartbeat(payload, sourceId, sanitized) ||
      this.parseAck(payload, sourceId, sanitized);

    if (parsed) return parsed;

    // For unparsed lines, only emit as raw if not a Meshtastic echo
    // (Mesh echoes that don't parse are typically commands/noise, not data)
    return isMeshtasticEcho ? [] : [{ kind: 'raw', raw: sanitized }];
  }

  reset(): void {
    // stateless parser
  }

  private parseTarget(
    payload: string,
    nodeId: string | undefined,
    raw: string,
  ): SerialParseResult[] | null {
    const m = TARGET_REGEX_TYPE_FIRST.exec(payload) ?? TARGET_REGEX_MAC_FIRST.exec(payload);
    if (!m?.groups) return null;
    const sourceNode = nodeId ?? m.groups.id;
    const lat = m.groups.lat ? Number(m.groups.lat) : undefined;
    const lon = m.groups.lon ? Number(m.groups.lon) : undefined;
    const detected: SerialParseResult = {
      kind: 'target-detected',
      nodeId: sourceNode,
      mac: m.groups.mac.toUpperCase(),
      rssi: Number(m.groups.rssi),
      type: m.groups.type,
      name: m.groups.name,
      lat,
      lon,
      raw,
    };
    const alert: SerialParseResult = {
      kind: 'alert',
      level: 'NOTICE',
      category: 'inventory',
      nodeId: sourceNode,
      message: payload,
      raw,
      data: {
        mac: detected.mac,
        rssi: detected.rssi,
        type: detected.type,
        name: detected.name,
        lat,
        lon,
      },
    };
    return [detected, alert];
  }

  private parseDevice(
    payload: string,
    nodeId: string | undefined,
    raw: string,
  ): SerialParseResult[] | null {
    const m = DEVICE_REGEX.exec(payload);
    if (!m?.groups) return null;
    return [
      {
        kind: 'target-detected',
        nodeId: nodeId ?? m.groups.id,
        mac: m.groups.mac.toUpperCase(),
        rssi: Number(m.groups.rssi),
        type: this.normalizeBand(m.groups.band),
        channel: m.groups.channel ? Number(m.groups.channel) : undefined,
        name: m.groups.name,
        raw,
      },
    ];
  }

  private parseTriangulationTarget(
    payload: string,
    nodeId: string | undefined,
    raw: string,
  ): SerialParseResult[] | null {
    const match = TRI_TARGET_DATA_REGEX.exec(payload);
    if (!match?.groups) {
      return null;
    }
    const mac = match.groups.mac.toUpperCase();
    const hits = match.groups.hits ? Number(match.groups.hits) : undefined;
    const rssi = Number(match.groups.rssi);
    const type = match.groups.type;
    const lat = match.groups.lat ? Number(match.groups.lat) : undefined;
    const lon = match.groups.lon ? Number(match.groups.lon) : undefined;
    const hdop = match.groups.hdop ? Number(match.groups.hdop) : undefined;

    // TS provides centisecond precision timestamp from firmware
    const detectionTimestamp = match.groups.ts ? Number(match.groups.ts) * 1_000_000 : undefined;
    const resolvedNodeId = nodeId ?? match.groups.id;
    return [
      {
        kind: 'alert',
        level: 'NOTICE',
        category: 'triangulation',
        nodeId: resolvedNodeId,
        message: payload,
        raw,
        data: {
          mac,
          hits,
          rssi,
          type,
          lat,
          lon,
          hdop,
          detectionTimestamp,
        },
      },
    ];
  }

  private parseDrone(
    payload: string,
    nodeId: string | undefined,
    raw: string,
  ): SerialParseResult[] | null {
    const m = DRONE_REGEX.exec(payload);
    if (!m?.groups) return null;
    return [
      {
        kind: 'drone-telemetry',
        nodeId: nodeId ?? m.groups.id,
        droneId: m.groups.droneId,
        mac: m.groups.mac.toUpperCase(),
        rssi: Number(m.groups.rssi),
        lat: Number(m.groups.lat),
        lon: Number(m.groups.lon),
        altitude: m.groups.alt ? Number(m.groups.alt) : undefined,
        speed: m.groups.spd ? Number(m.groups.spd) : undefined,
        operatorLat: m.groups.opLat ? Number(m.groups.opLat) : undefined,
        operatorLon: m.groups.opLon ? Number(m.groups.opLon) : undefined,
        raw,
      },
    ];
  }

  private parseProbeHit(
    payload: string,
    nodeId: string | undefined,
    raw: string,
  ): SerialParseResult[] | null {
    const m = PROBE_HIT_REGEX.exec(payload);
    if (!m?.groups) return null;
    const vendor = m.groups.vendor?.trim();
    const vendorLower = vendor?.toLowerCase();
    const macOctet = parseInt(m.groups.mac.split(':')[0] ?? '0', 16);
    const laaFlagSet = (macOctet & 0x02) !== 0 && (macOctet & 0x01) === 0;
    const fwSaysRandomized = vendorLower === 'randomized';
    const fwSaysUnknown = vendorLower === 'unknown';
    const hasKnownVendor = vendor != null && !fwSaysRandomized && !fwSaysUnknown;
    const isRandomized = fwSaysRandomized || (!hasKnownVendor && laaFlagSet);
    const resolvedVendor = hasKnownVendor ? vendor : undefined;
    const result: SerialProbeHit = {
      kind: 'probe-hit',
      nodeId: nodeId ?? m.groups.id,
      mac: m.groups.mac.toUpperCase(),
      vendor: resolvedVendor,
      isRandomized,
      rssi: Number(m.groups.rssi),
      channel: m.groups.channel ? Number(m.groups.channel) : undefined,
      ssid: m.groups.ssid ?? undefined,
      isGhost: Boolean(m.groups.ghost),
      isDst: Boolean(m.groups.dst),
      lat: m.groups.lat ? Number(m.groups.lat) : undefined,
      lon: m.groups.lon ? Number(m.groups.lon) : undefined,
      raw,
    };
    return [result];
  }

  private parseAnomaly(
    payload: string,
    nodeId: string | undefined,
    raw: string,
  ): SerialParseResult[] | null {
    const m = ANOMALY_REGEX.exec(payload);
    if (!m?.groups) return null;
    return [
      {
        kind: 'alert',
        level: 'NOTICE',
        category: 'anomaly',
        nodeId: nodeId ?? m.groups.id,
        message: payload,
        data: {
          kind: m.groups.kind,
          type: m.groups.type,
          mac: m.groups.mac.toUpperCase(),
          rssi: m.groups.rssi ? Number(m.groups.rssi) : undefined,
          old: m.groups.old ? Number(m.groups.old) : undefined,
          new: m.groups.new ? Number(m.groups.new) : undefined,
          delta: m.groups.delta ? Number(m.groups.delta) : undefined,
          name: m.groups.name,
        },
        raw,
      },
    ];
  }

  private parseAttack(
    payload: string,
    nodeId: string | undefined,
    raw: string,
  ): SerialParseResult[] | null {
    const long = ATTACK_LONG_REGEX.exec(payload);
    if (long?.groups) {
      return [
        {
          kind: 'alert',
          level: 'ALERT',
          category: 'attack',
          nodeId: nodeId ?? long.groups.id,
          message: payload,
          data: {
            kind: long.groups.kind,
            mode: long.groups.mode,
            src: long.groups.src.toUpperCase(),
            dst: long.groups.dst.toUpperCase(),
            rssi: Number(long.groups.rssi),
            channel: Number(long.groups.chan),
          },
          raw,
        },
      ];
    }
    const short = ATTACK_SHORT_REGEX.exec(payload);
    if (short?.groups) {
      return [
        {
          kind: 'alert',
          level: 'ALERT',
          category: 'attack',
          nodeId: nodeId ?? short.groups.id,
          message: payload,
          data: {
            kind: short.groups.kind,
            src: short.groups.src.toUpperCase(),
            dst: short.groups.dst.toUpperCase(),
            rssi: Number(short.groups.rssi),
            channel: Number(short.groups.chan),
          },
          raw,
        },
      ];
    }
    return null;
  }

  private parseSentinelDetection(
    payload: string,
    nodeId: string | undefined,
    raw: string,
  ): SerialParseResult[] | null {
    const m = SENTINEL_DETECTION_REGEX.exec(payload);
    if (!m?.groups) return null;
    const type = m.groups.type.toUpperCase();
    const schema = SENTINEL_FIELD_SCHEMAS[type] ?? [];
    const data: Record<string, string | number> = { detectionType: type };
    let remaining = m.groups.rest ?? '';
    for (let i = 0; i < schema.length && remaining.length > 0; i += 1) {
      const field = schema[i];
      const isLast = i === schema.length - 1;
      let token: string;
      if (isLast) {
        token = remaining;
        remaining = '';
      } else if (SENTINEL_MAC_FIELDS.has(field)) {
        const macHead = SENTINEL_MAC_HEAD_REGEX.exec(remaining);
        token = macHead ? macHead[0] : this.headToken(remaining);
        remaining = remaining.slice(token.length).replace(/^:/, '');
      } else {
        token = this.headToken(remaining);
        remaining = remaining.slice(token.length).replace(/^:/, '');
      }
      const eq = /^[A-Za-z_]+=(.*)$/.exec(token);
      const value = eq ? eq[1] : token;
      if (SENTINEL_MAC_FIELDS.has(field)) {
        data[field] = value.toUpperCase();
      } else if (!SENTINEL_STRING_FIELDS.has(field) && NUMERIC_VALUE_REGEX.test(value)) {
        data[field] = Number(value);
      } else {
        data[field] = value;
      }
    }
    return [
      {
        kind: 'alert',
        level: SENTINEL_NOTICE_TYPES.has(type) ? 'NOTICE' : 'ALERT',
        category: 'sentinel',
        nodeId: nodeId ?? m.groups.id,
        message: payload,
        data,
        raw,
      },
    ];
  }

  private headToken(value: string): string {
    const idx = value.indexOf(':');
    return idx >= 0 ? value.slice(0, idx) : value;
  }

  private parseMeshGuard(
    payload: string,
    nodeId: string | undefined,
    raw: string,
  ): SerialParseResult[] | null {
    const m = MESH_GUARD_REGEX.exec(payload);
    if (!m?.groups) return null;
    return [
      {
        kind: 'alert',
        level: 'ALERT',
        category: 'mesh-guard',
        nodeId: nodeId ?? m.groups.id,
        message: payload,
        data: { intrusionType: m.groups.type.toUpperCase(), detail: m.groups.rest },
        raw,
      },
    ];
  }

  private parseMeshCoordination(
    payload: string,
    nodeId: string | undefined,
    raw: string,
  ): SerialParseResult[] | null {
    const m = MESH_COORD_REGEX.exec(payload);
    if (!m?.groups) return null;
    return [
      {
        kind: 'alert',
        level: 'INFO',
        category: 'mesh-coordination',
        nodeId: nodeId ?? m.groups.id,
        message: payload,
        data: { coordinationType: m.groups.type.toUpperCase(), detail: m.groups.rest },
        raw,
      },
    ];
  }

  private parseNodeEvents(
    payload: string,
    nodeId: string | undefined,
    raw: string,
  ): SerialParseResult[] | null {
    const disappeared = DEVICE_DISAPPEARED_REGEX.exec(payload);
    if (disappeared?.groups) {
      return [
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'baseline',
          nodeId: nodeId ?? disappeared.groups.id,
          message: payload,
          data: {
            event: 'device-disappeared',
            mac: disappeared.groups.mac.toUpperCase(),
            absentSeconds: Number(disappeared.groups.absent),
          },
          raw,
        },
      ];
    }
    const ridRx = RID_RX_REGEX.exec(payload);
    if (ridRx?.groups) {
      return [
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'drone',
          nodeId: nodeId ?? ridRx.groups.id,
          message: payload,
          data: {
            event: 'remote-id-rx',
            uavId: ridRx.groups.uavId,
            rssi: Number(ridRx.groups.rssi),
            lat: Number(ridRx.groups.lat),
            lon: Number(ridRx.groups.lon),
            gpsValid: ridRx.groups.gpsValid === '1',
          },
          raw,
        },
      ];
    }
    const ridClaim = RID_CLAIM_REGEX.exec(payload);
    if (ridClaim?.groups) {
      return [
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'drone',
          nodeId: nodeId ?? ridClaim.groups.id,
          message: payload,
          data: {
            event: 'remote-id-claim',
            uavId: ridClaim.groups.uavId,
            lat: Number(ridClaim.groups.lat),
            lon: Number(ridClaim.groups.lon),
            alt: Number(ridClaim.groups.alt),
          },
          raw,
        },
      ];
    }
    return null;
  }

  private parseSentinelAck(
    payload: string,
    nodeId: string | undefined,
    raw: string,
  ): SerialParseResult[] | null {
    const sentinel = SENTINEL_ACK_REGEX.exec(payload);
    if (sentinel?.groups) {
      const id = nodeId ?? sentinel.groups.id;
      const on = sentinel.groups.state.toUpperCase() === 'ON';
      return [
        {
          kind: 'command-ack',
          nodeId: id,
          ackType: on ? 'SENTINEL_ON_ACK' : 'SENTINEL_OFF_ACK',
          status: on ? `ON${sentinel.groups.run ? ` run=${sentinel.groups.run}` : ''}` : 'OFF',
          raw,
        },
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'sentinel',
          nodeId: id,
          message: payload,
          data: { state: on ? 'on' : 'off', running: sentinel.groups.run === '1' },
          raw,
        },
      ];
    }
    const status = SENTINEL_STATUS_REGEX.exec(payload);
    if (status?.groups) {
      const id = nodeId ?? status.groups.id;
      return [
        {
          kind: 'command-result',
          nodeId: id,
          command: 'SENTINEL_STATUS',
          payload,
          raw,
        },
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'sentinel',
          nodeId: id,
          message: payload,
          data: {
            enabled: status.groups.enabled === '1',
            running: status.groups.running === '1',
          },
          raw,
        },
      ];
    }
    const mode = SENTINEL_MODE_ACK_REGEX.exec(payload);
    if (mode?.groups) {
      return [
        {
          kind: 'command-ack',
          nodeId: nodeId ?? mode.groups.id,
          ackType: 'SENTINEL_MODE_ACK',
          status: mode.groups.mode,
          raw,
        },
      ];
    }
    const boot = SENTINEL_BOOT_ACK_REGEX.exec(payload);
    if (boot?.groups) {
      return [
        {
          kind: 'command-ack',
          nodeId: nodeId ?? boot.groups.id,
          ackType: 'SENTINEL_BOOT_ACK',
          status: boot.groups.state,
          raw,
        },
      ];
    }
    const group = GROUP_ACK_REGEX.exec(payload);
    if (group?.groups) {
      return [
        {
          kind: 'command-ack',
          nodeId: nodeId ?? group.groups.id,
          ackType: 'GROUP_ACK',
          status: `${group.groups.status}:${group.groups.rest}`,
          raw,
        },
      ];
    }
    const detectCfg = DETECT_CFG_ACK_REGEX.exec(payload);
    if (detectCfg?.groups) {
      return [
        {
          kind: 'command-ack',
          nodeId: nodeId ?? detectCfg.groups.id,
          ackType: 'DETECT_CFG_ACK',
          status: detectCfg.groups.status,
          raw,
        },
      ];
    }
    const detectCfgLen = DETECT_CFG_LEN_REGEX.exec(payload);
    if (detectCfgLen?.groups) {
      return [
        {
          kind: 'command-result',
          nodeId: nodeId ?? detectCfgLen.groups.id,
          command: 'DETECT_CFG_GET',
          payload,
          raw,
        },
      ];
    }
    const incidentsLen = INCIDENTS_LEN_REGEX.exec(payload);
    if (incidentsLen?.groups) {
      return [
        {
          kind: 'command-result',
          nodeId: nodeId ?? incidentsLen.groups.id,
          command: 'INCIDENTS',
          payload,
          raw,
        },
      ];
    }
    const incidentsClear = INCIDENTS_CLEAR_ACK_REGEX.exec(payload);
    if (incidentsClear?.groups) {
      return [
        {
          kind: 'command-ack',
          nodeId: nodeId ?? incidentsClear.groups.id,
          ackType: 'INCIDENTS_CLEAR_ACK',
          status: incidentsClear.groups.status,
          raw,
        },
      ];
    }
    const dedupClear = DEDUP_CLEAR_ACK_REGEX.exec(payload);
    if (dedupClear?.groups) {
      return [
        {
          kind: 'command-ack',
          nodeId: nodeId ?? dedupClear.groups.id,
          ackType: 'DEDUP_CLEAR_ACK',
          status: dedupClear.groups.status,
          raw,
        },
      ];
    }
    const factoryReset = FACTORY_RESET_ACK_REGEX.exec(payload);
    if (factoryReset?.groups) {
      return [
        {
          kind: 'command-ack',
          nodeId: nodeId ?? factoryReset.groups.id,
          ackType: 'FACTORY_RESET_ACK',
          status: factoryReset.groups.status.trim(),
          raw,
        },
      ];
    }
    return null;
  }

  private parseRandomization(
    payload: string,
    nodeId: string | undefined,
    raw: string,
  ): SerialParseResult[] | null {
    const id = RANDOM_IDENTITY_REGEX.exec(payload);
    if (id?.groups) {
      return [
        {
          kind: 'alert',
          level: 'INFO',
          category: 'randomization',
          nodeId: nodeId ?? id.groups.id,
          message: payload,
          data: {
            tag: id.groups.tag,
            band: id.groups.band,
            macs: Number(id.groups.macs),
            confidence: Number(id.groups.conf),
            sessions: Number(id.groups.sess),
            anchor: id.groups.anchor.toUpperCase(),
          },
          raw,
        },
      ];
    }
    const done = RANDOM_DONE_REGEX.exec(payload);
    if (done?.groups) {
      return [
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'randomization',
          nodeId: nodeId ?? done.groups.id,
          message: payload,
          data: {
            identities: Number(done.groups.ids),
            sessions: Number(done.groups.sess),
            tx: Number(done.groups.tx),
            pending: Number(done.groups.pend),
          },
          raw,
        },
      ];
    }
    return null;
  }

  private parseDoneSummary(
    payload: string,
    nodeId: string | undefined,
    raw: string,
  ): SerialParseResult[] | null {
    const m = DONE_REGEX.exec(payload);
    if (!m?.groups) return null;
    const id = nodeId ?? m.groups.id;
    const op = m.groups.op.toUpperCase();
    const data = this.parseKVBody(m.groups.body);
    const ackType = `${op}_DONE_ACK`;
    const categoryMap: Record<string, string> = {
      SCAN: 'scan-done',
      DEAUTH: 'deauth-done',
      DRONE: 'drone-done',
      BASELINE: 'baseline-done',
      LIST_SCAN: 'list-scan-done',
      PROBE: 'probe-done',
    };
    return [
      {
        kind: 'alert',
        nodeId: id,
        category: categoryMap[op] ?? `${op.toLowerCase()}-done`,
        level: 'INFO',
        message: `${op}_DONE`,
        data,
        raw,
      },
      {
        kind: 'command-ack',
        nodeId: id,
        ackType,
        status: 'DONE',
        raw,
      },
    ];
  }

  private parseCodes(
    payload: string,
    nodeId: string | undefined,
    raw: string,
  ): SerialParseResult[] | null {
    const m = CODES_REGEX.exec(payload);
    if (!m?.groups) return null;
    const id = nodeId ?? m.groups.id;
    const body = m.groups.codes.trim();
    const codes =
      body.toUpperCase() === 'NONE' || !body
        ? []
        : body
            .split(',')
            .map((c) => c.trim())
            .filter(Boolean);
    return [
      {
        kind: 'alert',
        nodeId: id,
        category: 'gate-codes',
        level: 'INFO',
        message: `CODES:${body || 'NONE'}`,
        data: { codes },
        raw,
      },
      {
        kind: 'command-ack',
        nodeId: id,
        ackType: 'CODE_LIST_ACK',
        status: 'OK',
        raw,
      },
    ];
  }

  private parseKVBody(body: string): Record<string, number | string> {
    const result: Record<string, number | string> = {};
    const pairs = body.match(/[A-Za-z_]+=\S+/g);
    if (!pairs) return result;
    for (const pair of pairs) {
      const eqIdx = pair.indexOf('=');
      const key = pair.slice(0, eqIdx);
      const val = pair.slice(eqIdx + 1);
      const num = Number(val);
      result[key] = Number.isFinite(num) ? num : val;
    }
    return result;
  }

  private parseVibration(
    payload: string,
    nodeId: string | undefined,
    raw: string,
  ): SerialParseResult[] | null {
    const vib = VIBRATION_REGEX.exec(payload);
    if (vib?.groups) {
      return [
        {
          kind: 'alert',
          level: 'ALERT',
          category: 'vibration',
          nodeId: nodeId ?? vib.groups.id,
          message: payload,
          data: {
            lat: vib.groups.lat ? Number(vib.groups.lat) : undefined,
            lon: vib.groups.lon ? Number(vib.groups.lon) : undefined,
            eraseIn: vib.groups.erase ? Number(vib.groups.erase) : undefined,
          },
          raw,
        },
      ];
    }
    const vibStatus = VIBRATION_STATUS_REGEX.exec(payload);
    if (vibStatus?.groups) {
      return [
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'vibration',
          nodeId: nodeId ?? vibStatus.groups.id,
          message: payload,
          data: {
            status: vibStatus.groups.msg?.trim(),
          },
          raw,
        },
      ];
    }
    return null;
  }

  private parseTamper(
    payload: string,
    nodeId: string | undefined,
    raw: string,
  ): SerialParseResult[] | null {
    const setup = SETUP_REGEX.exec(payload);
    if (setup?.groups) {
      return [
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'setup',
          nodeId: nodeId ?? setup.groups.id,
          message: payload,
          raw,
        },
      ];
    }
    const tamper = TAMPER_REGEX.exec(payload);
    if (tamper?.groups) {
      return [
        {
          kind: 'alert',
          level: 'ALERT',
          category: 'tamper',
          nodeId: nodeId ?? tamper.groups.id,
          message: payload,
          raw,
        },
      ];
    }
    const erase = ERASE_REGEX.exec(payload);
    if (erase?.groups) {
      return [
        {
          kind: 'alert',
          level: 'ALERT',
          category: 'erase',
          nodeId: nodeId ?? erase.groups.id,
          message: payload,
          raw,
        },
      ];
    }
    const baseline = BASELINE_STATUS_REGEX.exec(payload);
    if (baseline?.groups) {
      return [
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'baseline',
          nodeId: nodeId ?? baseline.groups.id,
          message: payload,
          data: {
            scanning: baseline.groups.scanning,
            established: baseline.groups.est,
            devices: Number(baseline.groups.dev),
            anomalies: Number(baseline.groups.anom),
            phase: baseline.groups.phase,
          },
          raw,
        },
      ];
    }
    return null;
  }

  private parseStatus(
    payload: string,
    nodeId: string | undefined,
    raw: string,
  ): SerialParseResult[] | null {
    const m = STATUS_REGEX.exec(payload);
    if (!m?.groups) return null;
    const resolvedNodeId = nodeId ?? m.groups.id;
    const lat = m.groups.lat ? Number(m.groups.lat) : undefined;
    const lon = m.groups.lon ? Number(m.groups.lon) : undefined;
    const temperatureC = m.groups.tempC ? Number(m.groups.tempC) : undefined;
    const temperatureF = m.groups.tempF ? Number(m.groups.tempF) : undefined;
    const msg = this.stripTrailingHash(payload);
    const results: SerialParseResult[] = [];
    results.push({
      kind: 'node-telemetry',
      nodeId: resolvedNodeId ?? 'unknown',
      lat,
      lon,
      raw,
      lastMessage: msg,
      temperatureC,
      temperatureF,
    });
    results.push({
      kind: 'command-result',
      nodeId: resolvedNodeId ?? 'unknown',
      command: 'STATUS',
      payload: msg,
      raw,
    });
    return results;
  }

  private parseStartupGpsHeartbeat(
    payload: string,
    nodeId: string | undefined,
    raw: string,
  ): SerialParseResult[] | null {
    const hb = NODE_HB_REGEX.exec(payload) ?? NODE_HB_INLINE_REGEX.exec(payload);
    if (hb?.groups) {
      const temperatureC = hb.groups.tempC ? Number(hb.groups.tempC) : undefined;
      const temperatureF = hb.groups.tempF ? Number(hb.groups.tempF) : undefined;
      const lat = hb.groups.lat ? Number(hb.groups.lat) : undefined;
      const lon = hb.groups.lon ? Number(hb.groups.lon) : undefined;
      const telemetry: SerialParseResult = {
        kind: 'node-telemetry',
        nodeId: nodeId ?? hb.groups.id,
        lat,
        lon,
        raw,
        lastMessage: payload,
        temperatureC,
        temperatureF,
      };
      return [
        telemetry,
        {
          kind: 'alert',
          level: 'INFO',
          category: 'heartbeat',
          nodeId: nodeId ?? hb.groups.id,
          message: payload,
          raw,
          data: {
            temperatureC,
            temperatureF,
            lat,
            lon,
          },
        },
      ];
    }
    const gpsLock = GPS_LOCK_REGEX.exec(payload);
    if (gpsLock?.groups) {
      const results: SerialParseResult[] = [
        {
          kind: 'node-telemetry',
          nodeId: nodeId ?? gpsLock.groups.id,
          lat: Number(gpsLock.groups.lat),
          lon: Number(gpsLock.groups.lon),
          raw,
          lastMessage: payload,
        },
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'gps',
          nodeId: nodeId ?? gpsLock.groups.id,
          message: payload,
          raw,
          data: {
            lat: Number(gpsLock.groups.lat),
            lon: Number(gpsLock.groups.lon),
            hdop: gpsLock.groups.hdop ? Number(gpsLock.groups.hdop) : undefined,
            sats: gpsLock.groups.sats ? Number(gpsLock.groups.sats) : undefined,
          },
        },
      ];
      return results;
    }
    if (GPS_LOST_REGEX.test(payload)) {
      const id = this.extractNodeId(payload, nodeId);
      return [
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'gps',
          nodeId: id,
          message: payload,
          raw,
        },
      ];
    }
    const heartbeat = HEARTBEAT_REGEX.exec(payload);
    if (heartbeat?.groups) {
      return [
        {
          kind: 'alert',
          level: 'INFO',
          category: 'heartbeat',
          nodeId: nodeId ?? heartbeat.groups.id,
          message: payload,
          raw,
        },
      ];
    }
    const startup = STARTUP_REGEX.exec(payload);
    if (startup?.groups) {
      return [
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'startup',
          nodeId: nodeId ?? startup.groups.id,
          message: payload,
          raw,
        },
      ];
    }
    return null;
  }

  private parseAck(
    payload: string,
    nodeId: string | undefined,
    raw: string,
  ): SerialParseResult[] | null {
    const hbInterval = HB_ACK_INTERVAL_REGEX.exec(payload);
    if (hbInterval?.groups) {
      return [
        {
          kind: 'command-ack',
          nodeId: nodeId ?? hbInterval.groups.id,
          ackType: 'HB_ACK',
          status: `INTERVAL ${hbInterval.groups.minutes}min`,
          raw,
        },
      ];
    }
    const ack = ACK_REGEX.exec(payload);
    if (ack?.groups) {
      return [
        {
          kind: 'command-ack',
          nodeId: nodeId ?? ack.groups.id,
          ackType: ack.groups.kind,
          status: ack.groups.status || 'OK',
          raw,
        },
      ];
    }
    const triAck = TRI_ACK_REGEX.exec(payload);
    if (triAck?.groups) {
      return [
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'triangulation',
          nodeId: nodeId ?? triAck.groups.id,
          message: payload,
          raw,
        },
      ];
    }
    if (TRI_STOP_ACK_REGEX.test(payload)) {
      return [
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'triangulation',
          nodeId: nodeId ?? this.extractNodeId(payload, undefined),
          message: payload,
          raw,
        },
      ];
    }
    if (BASELINE_ACK_REGEX.test(payload)) {
      return [
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'baseline',
          nodeId: nodeId ?? this.extractNodeId(payload, undefined),
          message: payload,
          raw,
        },
      ];
    }
    const wipe = WIPE_TOKEN_REGEX.exec(payload);
    if (wipe?.groups) {
      return [
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'erase',
          nodeId: nodeId ?? wipe.groups.id,
          message: payload,
          raw,
          data: { token: wipe.groups.token },
        },
      ];
    }
    const eraseToken = ERASE_TOKEN_REGEX.exec(payload);
    if (eraseToken?.groups) {
      return [
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'erase',
          nodeId: nodeId ?? eraseToken.groups.id,
          message: payload,
          raw,
          data: {
            token: eraseToken.groups.token,
            time: eraseToken.groups.time ? Number(eraseToken.groups.time) : undefined,
          },
        },
      ];
    }
    const autoEraseAck = AUTOERASE_ACK_REGEX.exec(payload);
    if (autoEraseAck?.groups) {
      return [
        {
          kind: 'command-ack',
          nodeId: nodeId ?? autoEraseAck.groups.id,
          ackType: 'AUTOERASE_ACK',
          status: autoEraseAck.groups.status,
          raw,
        },
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'erase',
          nodeId: nodeId ?? autoEraseAck.groups.id,
          message: payload,
          raw,
          data: {
            status: autoEraseAck.groups.status,
            setupDelay: autoEraseAck.groups.setup ? Number(autoEraseAck.groups.setup) : undefined,
            eraseDelay: autoEraseAck.groups.erase ? Number(autoEraseAck.groups.erase) : undefined,
            vibrationsRequired: autoEraseAck.groups.vibs
              ? Number(autoEraseAck.groups.vibs)
              : undefined,
            detectionWindow: autoEraseAck.groups.window
              ? Number(autoEraseAck.groups.window)
              : undefined,
            autoEraseCooldown: autoEraseAck.groups.cooldown
              ? Number(autoEraseAck.groups.cooldown)
              : undefined,
          },
        },
      ];
    }
    const autoEraseStatus = AUTOERASE_STATUS_REGEX.exec(payload);
    if (autoEraseStatus?.groups) {
      return [
        {
          kind: 'command-ack',
          nodeId: nodeId ?? autoEraseStatus.groups.id,
          ackType: 'AUTOERASE_STATUS_ACK',
          status: 'OK',
          raw,
        },
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'erase',
          nodeId: nodeId ?? autoEraseStatus.groups.id,
          message: payload,
          raw,
          data: {
            enabled: autoEraseStatus.groups.enabled === 'YES',
            setupMode: autoEraseStatus.groups.setupMode,
            tamperActive: autoEraseStatus.groups.tamperActive === 'YES',
            setupDelay: autoEraseStatus.groups.setup
              ? Number(autoEraseStatus.groups.setup)
              : undefined,
            eraseDelay: autoEraseStatus.groups.erase
              ? Number(autoEraseStatus.groups.erase)
              : undefined,
            vibrationsRequired: autoEraseStatus.groups.vibs
              ? Number(autoEraseStatus.groups.vibs)
              : undefined,
            detectionWindow: autoEraseStatus.groups.window
              ? Number(autoEraseStatus.groups.window)
              : undefined,
            autoEraseCooldown: autoEraseStatus.groups.cooldown
              ? Number(autoEraseStatus.groups.cooldown)
              : undefined,
          },
        },
      ];
    }
    const batterySaverStatus = BATTERY_SAVER_STATUS_REGEX.exec(payload);
    if (batterySaverStatus?.groups) {
      return [
        {
          kind: 'command-ack',
          nodeId: nodeId ?? batterySaverStatus.groups.id,
          ackType: 'BATTERY_SAVER_STATUS_ACK',
          status: 'OK',
          raw,
        },
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'battery-saver',
          nodeId: nodeId ?? batterySaverStatus.groups.id,
          message: payload,
          raw,
          data: {
            enabled: batterySaverStatus.groups.enabled === 'YES',
            temperatureC: batterySaverStatus.groups.tempC
              ? Number(batterySaverStatus.groups.tempC)
              : undefined,
            lat: batterySaverStatus.groups.lat ? Number(batterySaverStatus.groups.lat) : undefined,
            lon: batterySaverStatus.groups.lon ? Number(batterySaverStatus.groups.lon) : undefined,
          },
        },
      ];
    }
    return null;
  }

  private parseTriangulationMeta(
    payload: string,
    nodeId: string | undefined,
    raw: string,
  ): SerialParseResult[] | null {
    const id = nodeId ?? this.extractNodeId(payload, undefined);
    // Handle broadcast TRIANGULATE_START messages
    const broadcast = TRI_START_BROADCAST_REGEX.exec(payload);
    if (broadcast?.groups) {
      const rfEnvLabels: Record<string, string> = {
        '0': 'Open Sky',
        '1': 'Suburban',
        '2': 'Indoor',
        '3': 'Indoor Dense',
        '4': 'Industrial',
      };
      return [
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'triangulation',
          nodeId: broadcast.groups.originNode,
          message: payload,
          raw,
          data: {
            stage: 'broadcast-start',
            mac: broadcast.groups.mac?.toUpperCase(),
            duration: Number(broadcast.groups.duration),
            originNode: broadcast.groups.originNode,
            rfEnvironment: broadcast.groups.rfEnv,
            rfEnvironmentLabel: rfEnvLabels[broadcast.groups.rfEnv],
          },
        },
      ];
    }
    if (TRI_RESULTS_START_REGEX.test(payload)) {
      return [
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'triangulation',
          nodeId: id,
          message: payload,
          raw,
          data: { stage: 'results-start' },
        },
      ];
    }
    if (TRI_RESULTS_END_REGEX.test(payload)) {
      return [
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'triangulation',
          nodeId: id,
          message: payload,
          raw,
          data: { stage: 'results-end' },
        },
      ];
    }
    if (TRI_RESULTS_NO_DATA_REGEX.test(payload)) {
      return [
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'triangulation',
          nodeId: id,
          message: payload,
          raw,
          data: { stage: 'no-data' },
        },
      ];
    }
    const final = TRI_FINAL_REGEX.exec(payload);
    if (final?.groups) {
      return [
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'triangulation',
          nodeId: id,
          message: payload,
          raw,
          data: {
            stage: 'final',
            mac: final.groups.mac.toUpperCase(),
            lat: Number(final.groups.lat),
            lon: Number(final.groups.lon),
            confidence: Number(final.groups.conf),
            uncertainty: Number(final.groups.unc),
          },
        },
      ];
    }
    const complete = TRI_COMPLETE_REGEX.exec(payload);
    if (complete?.groups) {
      const nodes = complete.groups.nodes ? Number(complete.groups.nodes) : undefined;
      const { lat, lon } = this.extractLatLonFromText(complete.groups.rest);
      return [
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'triangulation',
          nodeId: id,
          message: payload,
          raw,
          data: {
            stage: 'complete',
            nodes,
            mac: complete.groups.mac?.toUpperCase(),
            lat,
            lon,
            link: complete.groups.rest?.trim(),
          },
        },
      ];
    }
    return null;
  }

  private parseTimeSync(
    payload: string,
    nodeId: string | undefined,
    raw: string,
  ): SerialParseResult[] | null {
    const rtc = RTC_SYNC_REGEX.exec(payload);
    if (rtc?.groups) {
      return [
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'time-sync',
          nodeId: nodeId ?? rtc.groups.id,
          message: payload,
          raw,
          data: {
            mode: 'rtc',
            source: rtc.groups.source,
          },
        },
      ];
    }
    const req = TIME_SYNC_REQ_REGEX.exec(payload);
    if (req?.groups) {
      return [
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'time-sync',
          nodeId: nodeId ?? req.groups.id,
          message: payload,
          raw,
          data: {
            mode: 'request',
            time: Number(req.groups.time),
            window: Number(req.groups.window),
            sequence: Number(req.groups.seq),
            offset: req.groups.offset ? Number(req.groups.offset) : undefined,
          },
        },
      ];
    }
    const resp = TIME_SYNC_RESP_REGEX.exec(payload);
    if (resp?.groups) {
      return [
        {
          kind: 'alert',
          level: 'NOTICE',
          category: 'time-sync',
          nodeId: nodeId ?? resp.groups.id,
          message: payload,
          raw,
          data: {
            mode: 'response',
            time: Number(resp.groups.time),
            window: Number(resp.groups.window),
            sequence: Number(resp.groups.seq),
            offset: resp.groups.offset ? Number(resp.groups.offset) : undefined,
          },
        },
      ];
    }
    return null;
  }

  private normalize(value: string): string {
    if (!value) return '';
    let cleaned = value.replace(ANSI_REGEX, '');
    cleaned = Array.from(cleaned)
      .filter((ch) => {
        const code = ch.codePointAt(0) ?? 0;
        return code === 0x09 || code === 0x0a || code === 0x0d || code >= 0x20;
      })
      .join('');
    return cleaned.trim();
  }

  private extractSourceId(text: string): string | undefined {
    const m = /node[=:](?<n>[A-Za-z0-9_.:-]+)/i.exec(text) ?? NODE_ID_FALLBACK.exec(text);
    return m?.groups ? (m.groups['n'] ?? m[1]) : undefined;
  }

  private extractNodeId(payload: string, fallback?: string): string | undefined {
    const m = NODE_ID_FALLBACK.exec(payload);
    return m?.[1] ?? fallback;
  }

  private stripTrailingHash(value: string): string {
    return value.replace(/#+$/, '').trim();
  }

  private extractLatLonFromText(text?: string | null): { lat?: number; lon?: number } {
    if (!text) {
      return {};
    }
    const match =
      /q=([-0-9.]+),([-0-9.]+)/i.exec(text) ?? /GPS[:=]([-0-9.]+),([-0-9.]+)/i.exec(text);
    if (!match) {
      return {};
    }
    const lat = Number(match[1]);
    const lon = Number(match[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return {};
    }
    return { lat, lon };
  }

  private normalizeBand(band?: string): string | undefined {
    if (!band) return undefined;
    const b = band.toUpperCase();
    if (b === 'W') return 'WiFi';
    if (b === 'B') return 'BLE';
    return b;
  }
}
