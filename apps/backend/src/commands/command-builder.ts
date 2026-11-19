import { BadRequestException } from '@nestjs/common';
import { createHmac } from 'node:crypto';

const NODE_PATTERN = /^NODE_[A-Z0-9]+$/;
const MAC_PATTERN = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;
const MAC_PREFIX_PATTERN = /^([0-9A-F]{2}:){2}[0-9A-F]{2}$/;
const TRACER_TARGET_PATTERN = /^T-[0-9A-F]{4,7}$/;
const ERASE_TOKEN_PATTERN = /^AH_[0-9A-F]{8}_[0-9A-F]{8}_[0-9A-F]{8}$/;
const ERASE_ANSWER_PATTERN = /^(?:[0-9a-f]{8}|[0-9a-f]{64})$/i;
const TRIANGULATE_IDENTITY_PATTERN = /^T-[A-Za-z0-9_-]+$/;
const CUSTOM_NODE_ID_PATTERN = /^[A-Z0-9]{2,5}$/;
const CAMPAIGN_NAME_PATTERN = /^[A-Za-z0-9_-]{1,23}$/;
const SCHED_START_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const SCHED_ROUTES = new Set(['/scan', '/sniffer', '/drone']);
const RADIO_KNOWN_ADD_PATTERN =
  /^((?:[0-9A-F]{2}:){5}[0-9A-F]{2}):(Meshtastic|MeshCore)(?::(.*))?$/i;

const MAX_MESH_LINE = 230;
const ERASE_KEY_MIN = 8;
const ERASE_KEY_MAX = 64;

const SENTINEL_MODES = new Set(['scan', 'defend']);
const SENTINEL_BOOT_STATES = new Set(['on', 'off', '1', '0', 'true', 'false']);
const GROUP_NAMES = new Set([
  'dos',
  'rogue',
  'rogue_ap',
  'recon',
  'physical',
  'phys',
  'mesh',
  'devices',
  'all',
]);
const GROUP_STATES = new Set(['on', 'off', '1', '0', 'true', 'false']);
const FACTORY_RESET_TIERS = new Set(['FULL', 'CONFIG', 'DATA']);

export type CommandBuildInput = {
  target: string;
  name: string;
  params?: string[];
};

export type CommandBuildOutput = {
  target: string;
  name: string;
  params: string[];
  line: string;
};

type CommandHandler = (params: string[]) => string[];

const COMMAND_HANDLERS = new Map<string, CommandHandler>([
  ['STATUS', expectNoParams],
  ['CONFIG_CHANNELS', handleConfigChannels],
  ['CONFIG_TARGETS', handleConfigTargets],
  ['CONFIG_RSSI', handleConfigRssi],
  ['CONFIG_BAND', handleConfigBand],
  ['CONFIG_NODEID', handleConfigNodeId],
  ['SCAN_START', handleScanStart],
  ['DEVICE_SCAN_START', handleDeviceScanStart],
  ['DRONE_START', handleTimedCommand],
  ['DEAUTH_START', handleTimedCommand],
  ['RANDOMIZATION_START', handleRandomizationStart],
  ['BASELINE_START', handleBaselineStart],
  ['BASELINE_STATUS', expectNoParams],
  ['STOP', expectNoParams],
  ['VIBRATION_STATUS', expectNoParams],
  ['VIBRATION_ON', expectNoParams],
  ['VIBRATION_OFF', expectNoParams],
  ['HB_ON', expectNoParams],
  ['HB_OFF', expectNoParams],
  ['HB_INTERVAL', handleHbInterval],
  ['PROBE_START', handleProbeStart],
  ['PROBE_STOP', expectNoParams],
  ['PCAP_START', handlePcapStart],
  ['PCAP_STOP', expectNoParams],
  ['PCAP_LIMITS', handlePcapLimits],
  ['TRIANGULATE_START', handleTriangulateStart],
  ['TRIANGULATE_STOP', expectNoParams],
  ['TRIANGULATE_RESULTS', expectNoParams],
  ['ERASE_REQUEST', expectNoParams],
  ['ERASE_FORCE', handleEraseForce],
  ['ERASE_CANCEL', handleEraseCancel],
  ['AUTOERASE_ENABLE', handleAutoEraseEnable],
  ['AUTOERASE_DISABLE', handleAutoEraseDisable],
  ['AUTOERASE_STATUS', expectNoParams],
  ['BATTERY_SAVER_START', handleBatterySaverStart],
  ['BATTERY_SAVER_STOP', expectNoParams],
  ['BATTERY_SAVER_STATUS', expectNoParams],
  ['SENTINEL_ON', expectNoParams],
  ['SENTINEL_OFF', expectNoParams],
  ['SENTINEL_STATUS', expectNoParams],
  ['SENTINEL_MODE', handleSentinelMode],
  ['SENTINEL_BOOT', handleSentinelBoot],
  ['GROUP', handleGroup],
  ['DETECT_CFG', handleDetectCfg],
  ['DETECT_CFG_GET', expectNoParams],
  ['INCIDENTS', handleIncidents],
  ['INCIDENTS_CLEAR', expectNoParams],
  ['CONFIG_ERASE_PSK', handleConfigErasePsk],
  ['CONFIG_DEDUP_TTL', handleConfigDedupTtl],
  ['CONFIG_SESSION_DEDUP', handleConfigSessionDedup],
  ['MESH_DEDUP_CLEAR', expectNoParams],
  ['FACTORY_RESET', handleFactoryReset],
  ['CSI_MOTION_START', handleCsiMotionStart],
  ['CSI_STATUS', expectNoParams],
  ['CSI_JSON', expectNoParams],
  ['CSI_RECAL', expectNoParams],
  ['CSI_EXCLUDE', handleCsiExclude],
  ['CSI_CFG', handleCsiCfg],
  ['SUMMARY', expectNoParams],
  ['MESH_TX_CANCEL', expectNoParams],
  ['BLE_CLASSIFY', handleBleClassify],
  ['BLE_LONGRANGE', handleBleLongRange],
  ['CAMPAIGN_START', handleCampaignStart],
  ['CAMPAIGN_STOP', expectNoParams],
  ['CAMPAIGN_STATUS', expectNoParams],
  ['DEVICE_DB_CLEAR', expectNoParams],
  ['PROBE_DB_CLEAR', expectNoParams],
  ['BASELINE_WATCH', expectNoParams],
  ['BASELINE_RESET', expectNoParams],
  ['RANDOMIZATION_RESET', expectNoParams],
  ['PCAP_AUTO', handlePcapAuto],
  ['SD_REPAIR', handleSdRepair],
  ['SCHED_ADD', handleSchedAdd],
  ['SCHED_LIST', expectNoParams],
  ['SCHED_DEL', handleSchedDel],
  ['CALIBRATE', handleCalibrate],
  ['CALIBRATE_RESET', expectNoParams],
  ['VIBSCAN_SET', handleVibscanSet],
  ['VIBSCAN_STATUS', expectNoParams],
  ['DETECT_CLEAR', expectNoParams],
  ['DETECT_COUNTS', expectNoParams],
  ['RADIO_KNOWN_ADD', handleRadioKnownAdd],
  ['RADIO_KNOWN_DEL', handleRadioKnownDel],
  ['RADIO_KNOWN_CLEAR', expectNoParams],
  ['SELF_RADIO_SET', handleSelfRadioSet],
  ['SELF_RADIO_CLEAR', expectNoParams],
  ['SELF_RADIO_GET', expectNoParams],
  ['ATTACKER_TRILAT', handleAttackerTrilat],
  ['ATTACKER_TRILAT_STATUS', expectNoParams],
]);

const DESTRUCTIVE_COMMANDS = new Set<string>([
  'ERASE_REQUEST',
  'ERASE_FORCE',
  'ERASE_CANCEL',
  'AUTOERASE_ENABLE',
  'AUTOERASE_DISABLE',
  'FACTORY_RESET',
  'CONFIG_ERASE_PSK',
]);
const ERASE_FLAG_COMMANDS = new Set<string>([
  'ERASE_FORCE',
  'FACTORY_RESET',
  'AUTOERASE_ENABLE',
  'AUTOERASE_DISABLE',
]);
const DURATION_PARAM_INDEX = new Map<string, number>([
  ['SCAN_START', 1],
  ['DEVICE_SCAN_START', 1],
  ['RANDOMIZATION_START', 1],
  ['PROBE_START', 1],
  ['DRONE_START', 0],
  ['DEAUTH_START', 0],
  ['BASELINE_START', 0],
  ['CSI_MOTION_START', 0],
]);

export type CommandPolicyInput = {
  name: string;
  target: string;
  params: string[];
  role?: string | null;
  allowForever: boolean;
  allowEraseForce: boolean;
};

export function checkCommandPolicy(input: CommandPolicyInput): string | null {
  const name = normalizeName(input.name);
  const target = input.target.trim().toUpperCase();
  if (DESTRUCTIVE_COMMANDS.has(name)) {
    if (input.role !== undefined && input.role !== 'ADMIN') {
      return `${name} requires the ADMIN role.`;
    }
    if (target === '@ALL') {
      return `${name} must target a single node, not @ALL.`;
    }
  }
  if (ERASE_FLAG_COMMANDS.has(name) && !input.allowEraseForce) {
    return `${name} is disabled on this server (ALLOW_ERASE_FORCE is not true).`;
  }
  if (!input.allowForever && isForeverCommand(name, input.params)) {
    return `${name} with FOREVER or a zero duration is disabled on this server (ALLOW_FOREVER is not true).`;
  }
  return null;
}

const GATED_ALIASES = new Map<string, string>([
  ['EF', 'ERASE_FORCE'],
  ['EC', 'ERASE_CANCEL'],
  ['ER', 'ERASE_REQUEST'],
  ['FR', 'FACTORY_RESET'],
  ['AE1', 'AUTOERASE_ENABLE'],
  ['AE0', 'AUTOERASE_DISABLE'],
  ['CEP', 'CONFIG_ERASE_PSK'],
  ['SS', 'SCAN_START'],
  ['DS', 'DEVICE_SCAN_START'],
  ['DR', 'DRONE_START'],
  ['DA', 'DEAUTH_START'],
  ['RS', 'RANDOMIZATION_START'],
  ['PS', 'PROBE_START'],
  ['BLS', 'BASELINE_START'],
  ['CIM', 'CSI_MOTION_START'],
]);

export function parseCommandLine(
  line: string,
): { name: string; target: string; params: string[] } | null {
  const match = /^(@\S+)\s+([A-Za-z0-9_]+)(?::(.*))?$/.exec(line.trim());
  if (!match) {
    return null;
  }
  const verb = match[2].toUpperCase();
  return {
    target: match[1].toUpperCase(),
    name: GATED_ALIASES.get(verb) ?? verb,
    params: match[3] === undefined ? [] : match[3].split(':'),
  };
}

function isForeverCommand(name: string, params: string[]): boolean {
  if (!DURATION_PARAM_INDEX.has(name)) {
    return false;
  }
  if (params.some((value) => value.trim().toUpperCase() === 'FOREVER')) {
    return true;
  }
  const duration = params[DURATION_PARAM_INDEX.get(name) as number];
  return duration !== undefined && /^0+$/.test(duration.trim());
}

export function redactCommandParams(name: string, params: string[]): string[] {
  const upper = name.trim().toUpperCase();
  let from: number;
  switch (upper) {
    case 'ERASE_FORCE':
    case 'ERASE_CANCEL':
    case 'AUTOERASE_DISABLE':
    case 'CONFIG_ERASE_PSK':
      from = 0;
      break;
    case 'AUTOERASE_ENABLE':
      from = params.length >= 5 ? 5 : 0;
      break;
    case 'FACTORY_RESET':
      from = 1;
      break;
    default:
      return params;
  }
  return params.map((value, index) => (index >= from ? '***' : value));
}

const CSI_START_FLAGS = new Set([
  'FOREVER',
  'TELEM',
  'RAW',
  'MGMTONLY',
  'MGMTDATA',
  'LISTEN_ONLY',
  'ALLOW_TRANSMIT',
]);
const CSI_ONOFF = new Set(['ON', 'OFF']);

const SINGLE_NODE_COMMANDS = new Set<string>(['CONFIG_NODEID', 'FACTORY_RESET']);

export function buildCommandPayload(input: CommandBuildInput): CommandBuildOutput {
  const target = normalizeTarget(input.target);
  const name = normalizeName(input.name);
  if (SINGLE_NODE_COMMANDS.has(name) && target === '@ALL') {
    throw new BadRequestException(`${name} must target a single node, not @ALL.`);
  }
  if (!COMMAND_HANDLERS.has(name)) {
    throw new BadRequestException(`Unsupported command ${name}`);
  }
  const handler = COMMAND_HANDLERS.get(name);
  if (!handler || typeof handler !== 'function') {
    throw new BadRequestException(`Invalid command handler for ${name}`);
  }

  const rawParams = (input.params ?? []).map((value) => value.trim()).filter(Boolean);
  const params = handler(rawParams);
  const line = params.length ? `${target} ${name}:${params.join(':')}` : `${target} ${name}`;
  if ([...line].some((ch) => ch.charCodeAt(0) < 0x20)) {
    throw new BadRequestException('Command line may not contain control characters.');
  }
  if (line.length > MAX_MESH_LINE) {
    throw new BadRequestException(
      `Command line is ${line.length} characters; the node accepts at most ${MAX_MESH_LINE}. Shorten the parameters.`,
    );
  }

  return { target, name, params, line };
}

function normalizeTarget(target: string): string {
  const normalized = target.trim().toUpperCase();
  if (normalized === '@ALL') {
    return normalized;
  }

  if (normalized.startsWith('@')) {
    const withoutAt = normalized.slice(1);
    const id = NODE_PATTERN.test(withoutAt) ? withoutAt.slice('NODE_'.length) : withoutAt;
    if (CUSTOM_NODE_ID_PATTERN.test(id)) {
      return `@${id}`;
    }
  }

  throw new BadRequestException(
    'Invalid target. Use @ALL or @<ID> with a 2-5 character node ID of letters and digits (e.g., @AH01).',
  );
}

function normalizeName(name: string): string {
  return name.trim().toUpperCase();
}

function expectNoParams(params: string[]): string[] {
  if (params.length > 0) {
    throw new BadRequestException('This command does not accept any parameters.');
  }
  return [];
}

function handleConfigChannels(params: string[]): string[] {
  if (params.length !== 1) {
    throw new BadRequestException('CONFIG_CHANNELS expects a single channels parameter.');
  }
  const channels = normalizeChannels(params[0]);
  return [channels];
}

function handleConfigTargets(params: string[]): string[] {
  if (params.length !== 1) {
    throw new BadRequestException(
      'CONFIG_TARGETS expects a single pipe-delimited string of MACs, MAC prefixes, SSIDs, or T- tracer IDs.',
    );
  }
  const entries = params[0]
    .split('|')
    .map((value) => value.trim())
    .filter(Boolean)
    .map(normalizeTargetEntry);
  if (entries.length === 0) {
    throw new BadRequestException('CONFIG_TARGETS requires at least one target entry.');
  }
  return [entries.join('|')];
}

function normalizeTargetEntry(entry: string): string {
  const upper = entry.toUpperCase();
  if (
    MAC_PATTERN.test(upper) ||
    MAC_PREFIX_PATTERN.test(upper) ||
    TRACER_TARGET_PATTERN.test(upper)
  ) {
    return upper;
  }
  if (/^[0-9A-F]{12}$/.test(upper) || /^[0-9A-F]{6}$/.test(upper)) {
    return upper;
  }
  if (entry.length > 32 || /[^\x20-\x7e]/.test(entry)) {
    throw new BadRequestException(
      `Invalid target entry "${entry}". Use a MAC, a 3-byte prefix (AA:BB:CC), a T- tracer ID, or an SSID of at most 32 printable characters.`,
    );
  }
  return entry;
}

function handleConfigRssi(params: string[]): string[] {
  if (params.length !== 1) {
    throw new BadRequestException('CONFIG_RSSI expects a single RSSI threshold value.');
  }
  const parsed = Number.parseInt(params[0].trim(), 10);
  if (!Number.isFinite(parsed) || parsed > -10 || parsed < -128) {
    throw new BadRequestException('RSSI threshold must be between -128 and -10 dBm.');
  }
  return [parsed.toString()];
}

function handleConfigNodeId(params: string[]): string[] {
  if (params.length !== 1) {
    throw new BadRequestException('CONFIG_NODEID expects a single node identifier value.');
  }
  const desiredId = params[0].trim().toUpperCase();
  if (!CUSTOM_NODE_ID_PATTERN.test(desiredId)) {
    throw new BadRequestException(
      'Node identifier must be 2-5 characters long and contain only A-Z or 0-9.',
    );
  }
  return [desiredId];
}

function handleScanStart(params: string[]): string[] {
  if (params.length < 3 || params.length > 4) {
    throw new BadRequestException(
      'SCAN_START expects mode, duration (seconds), channels, and optional FOREVER token.',
    );
  }
  const mode = normalizeMode(params[0]);
  const duration = normalizeDuration(params[1]);
  const channels = normalizeChannels(params[2]);
  const output = [mode, duration, channels];
  if (params.length === 4) {
    output.push(normalizeForever(params[3]));
  }
  return output;
}

function handleDeviceScanStart(params: string[]): string[] {
  if (params.length < 2 || params.length > 5) {
    throw new BadRequestException(
      'DEVICE_SCAN_START expects mode, duration (seconds), and optional FOREVER, +PROBE and/or CH<list> tokens.',
    );
  }
  const mode = normalizeMode(params[0]);
  const duration = normalizeDuration(params[1]);
  const output = [mode, duration];
  for (let i = 2; i < params.length; i++) {
    const token = params[i].trim().toUpperCase();
    if (token === 'FOREVER') {
      output.push('FOREVER');
    } else if (token === '+PROBE') {
      output.push('+PROBE');
    } else if (token.startsWith('CH') && token.length > 2) {
      output.push(`CH${normalizeChannelSpec(token.slice(2), 14)}`);
    } else {
      throw new BadRequestException(
        `Invalid DEVICE_SCAN_START token: ${params[i]}. Expected FOREVER, +PROBE or CH<list> (e.g., CH1,6,11).`,
      );
    }
  }
  return output;
}

function handleTimedCommand(params: string[]): string[] {
  if (params.length < 1 || params.length > 2) {
    throw new BadRequestException(
      'This command expects a duration (seconds) and optional FOREVER token.',
    );
  }
  const duration = normalizeDuration(params[0]);
  const output = [duration];
  if (params.length === 2) {
    output.push(normalizeForever(params[1]));
  }
  return output;
}

function handlePcapStart(params: string[]): string[] {
  if (params.length < 2 || params.length > 4) {
    throw new BadRequestException(
      'PCAP_START expects radio, duration (seconds), optional band, and optional CH<list>.',
    );
  }
  const radio = params[0].trim();
  if (!['0', '1'].includes(radio)) {
    throw new BadRequestException('Radio must be 0 (WiFi) or 1 (BLE).');
  }
  const duration = normalizeDuration(params[1]);
  let band: string | undefined;
  let channels: string | undefined;
  for (const raw of params.slice(2)) {
    const token = raw.trim().toUpperCase();
    if (token === 'FOREVER') {
      throw new BadRequestException(
        'PCAP_START does not support FOREVER; it requires a bounded duration.',
      );
    }
    if (token.startsWith('CH') && token.length > 2 && channels === undefined) {
      channels = `CH${normalizeChannelSpec(token.slice(2), 177)}`;
    } else if (['0', '1', '2'].includes(token) && band === undefined) {
      band = token;
    } else {
      throw new BadRequestException(
        `Invalid PCAP_START token: ${raw}. Expected a band (0, 1, or 2) or CH<list>.`,
      );
    }
  }
  const output = [radio, duration];
  if (band !== undefined || channels !== undefined) {
    output.push(band ?? '0');
  }
  if (channels !== undefined) {
    output.push(channels);
  }
  return output;
}

function handlePcapLimits(params: string[]): string[] {
  if (params.length === 0) {
    return [];
  }
  if (params.length > 1) {
    throw new BadRequestException('PCAP_LIMITS expects an optional max file size in MB (8-300).');
  }
  const mb = Number.parseInt(params[0].trim(), 10);
  if (!Number.isFinite(mb) || mb < 8 || mb > 300) {
    throw new BadRequestException('PCAP_LIMITS max file size must be between 8 and 300 MB.');
  }
  return [mb.toString()];
}

function handleRandomizationStart(params: string[]): string[] {
  if (params.length < 2 || params.length > 3) {
    throw new BadRequestException(
      'RANDOMIZATION_START expects mode, duration (seconds), and optional FOREVER token.',
    );
  }
  const mode = normalizeMode(params[0]);
  const duration = normalizeDuration(params[1]);
  const output = [mode, duration];
  if (params.length === 3) {
    output.push(normalizeForever(params[2]));
  }
  return output;
}

function handleBaselineStart(params: string[]): string[] {
  if (params.length < 1 || params.length > 2) {
    throw new BadRequestException(
      'BASELINE_START expects a duration (seconds) and optional FOREVER token.',
    );
  }
  const duration = normalizeDuration(params[0]);
  const output = [duration];
  if (params.length === 2) {
    output.push(normalizeForever(params[1]));
  }
  return output;
}

function handleTriangulateStart(params: string[]): string[] {
  if (params.length < 2 || params.length > 5) {
    throw new BadRequestException(
      'TRIANGULATE_START expects a target reference (MAC or T-identity), duration in seconds, and optional RF environment (0-4), wifiPwr multiplier (0.1-5.0), and blePwr multiplier (0.1-5.0).',
    );
  }
  const referenceRaw = params[0].trim();
  const normalizedRef = normalizeTargetReference(referenceRaw);
  const duration = normalizeDuration(params[1]);
  // Default to Indoor (2) if not specified
  const rfEnvironment = params.length >= 3 ? normalizeRFEnvironment(params[2]) : '2';
  const output = [normalizedRef, duration, rfEnvironment];

  // Optional wifiPwr multiplier (default 1.0)
  if (params.length >= 4) {
    const wifiPwr = normalizePowerMultiplier(params[3], 'WiFi');
    output.push(wifiPwr);
  }

  // Optional blePwr multiplier (default 1.0)
  if (params.length === 5) {
    const blePwr = normalizePowerMultiplier(params[4], 'BLE');
    output.push(blePwr);
  }

  return output;
}

function normalizeRFEnvironment(value: string): string {
  const trimmed = value.trim();
  if (!['0', '1', '2', '3', '4'].includes(trimmed)) {
    throw new BadRequestException(
      'RF Environment must be 0 (Open Sky), 1 (Suburban), 2 (Indoor), 3 (Indoor Dense), or 4 (Industrial).',
    );
  }
  return trimmed;
}

function normalizePowerMultiplier(value: string, band: 'WiFi' | 'BLE'): string {
  const parsed = Number.parseFloat(value.trim());
  if (!Number.isFinite(parsed) || parsed < 0.1 || parsed > 5.0) {
    throw new BadRequestException(`${band} power multiplier must be between 0.1 and 5.0.`);
  }
  return parsed.toFixed(1);
}

function isValidEraseKey(key: string): boolean {
  return key.length >= ERASE_KEY_MIN && key.length <= ERASE_KEY_MAX && !key.includes(':');
}

function resolveEraseAnswer(credential: string[], command: string): string {
  if (credential.length === 1) {
    if (!ERASE_ANSWER_PATTERN.test(credential[0])) {
      throw new BadRequestException(
        `${command} needs the erase answer (8 or 64 hex characters), or the ERASE_REQUEST token followed by the erase key.`,
      );
    }
    return credential[0].toLowerCase();
  }
  if (credential.length === 2) {
    const token = credential[0].toUpperCase();
    if (!ERASE_TOKEN_PATTERN.test(token)) {
      throw new BadRequestException(
        'Invalid erase token. Expected format AH_XXXXXXXX_XXXXXXXX_XXXXXXXX with hex digits.',
      );
    }
    if (!isValidEraseKey(credential[1])) {
      throw new BadRequestException(
        `The erase key must be ${ERASE_KEY_MIN}-${ERASE_KEY_MAX} characters with no ':'.`,
      );
    }
    return createHmac('sha256', credential[1]).update(token).digest('hex').slice(0, 8);
  }
  throw new BadRequestException(
    `${command} expects the erase answer, or the ERASE_REQUEST token followed by the erase key.`,
  );
}

function handleEraseForce(params: string[]): string[] {
  return [resolveEraseAnswer(params, 'ERASE_FORCE')];
}

function handleEraseCancel(params: string[]): string[] {
  return [resolveEraseAnswer(params, 'ERASE_CANCEL')];
}

function handleAutoEraseDisable(params: string[]): string[] {
  return [resolveEraseAnswer(params, 'AUTOERASE_DISABLE')];
}

function handleAutoEraseEnable(params: string[]): string[] {
  if (params.length <= 2) {
    return [resolveEraseAnswer(params, 'AUTOERASE_ENABLE')];
  }
  if (params.length !== 6 && params.length !== 7) {
    throw new BadRequestException(
      'AUTOERASE_ENABLE expects the erase answer alone, or all 5 timings (setupDelay:eraseDelay:vibs:window:cooldown) followed by the erase answer.',
    );
  }
  const answer = resolveEraseAnswer(params.slice(5), 'AUTOERASE_ENABLE');
  return [...validateAutoEraseTimings(params.slice(0, 5)), answer];
}

function validateAutoEraseTimings(params: string[]): string[] {
  const setupDelay = Number.parseInt(params[0].trim(), 10);
  if (!Number.isFinite(setupDelay) || setupDelay < 30 || setupDelay > 600) {
    throw new BadRequestException('Setup delay must be between 30 and 600 seconds.');
  }

  const eraseDelay = Number.parseInt(params[1].trim(), 10);
  if (!Number.isFinite(eraseDelay) || eraseDelay < 10 || eraseDelay > 300) {
    throw new BadRequestException('Erase delay must be between 10 and 300 seconds.');
  }

  const vibrationsRequired = Number.parseInt(params[2].trim(), 10);
  if (!Number.isFinite(vibrationsRequired) || vibrationsRequired < 2 || vibrationsRequired > 5) {
    throw new BadRequestException('Vibrations required must be between 2 and 5.');
  }

  const detectionWindow = Number.parseInt(params[3].trim(), 10);
  if (!Number.isFinite(detectionWindow) || detectionWindow < 10 || detectionWindow > 60) {
    throw new BadRequestException('Detection window must be between 10 and 60 seconds.');
  }

  const autoEraseCooldown = Number.parseInt(params[4].trim(), 10);
  if (!Number.isFinite(autoEraseCooldown) || autoEraseCooldown < 300 || autoEraseCooldown > 3600) {
    throw new BadRequestException('Auto-erase cooldown must be between 300 and 3600 seconds.');
  }

  return [
    setupDelay.toString(),
    eraseDelay.toString(),
    vibrationsRequired.toString(),
    detectionWindow.toString(),
    autoEraseCooldown.toString(),
  ];
}

function normalizeMode(value: string): string {
  const trimmed = value.trim();
  if (!['0', '1', '2'].includes(trimmed)) {
    throw new BadRequestException('Mode must be 0 (WiFi), 1 (BLE), or 2 (Both).');
  }
  return trimmed;
}

function normalizeDuration(value: string, min = 1, max = 86_400): string {
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new BadRequestException(`Duration must be between ${min} and ${max} seconds.`);
  }
  return parsed.toString();
}

function normalizeForever(value: string): string {
  const token = value.trim().toUpperCase();
  if (token !== 'FOREVER') {
    throw new BadRequestException('If provided, the final parameter must be FOREVER.');
  }
  return token;
}

function normalizeChannels(value: string): string {
  const tokens = value
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    throw new BadRequestException('Channels specification cannot be empty.');
  }

  const channels = new Set<number>();
  tokens.forEach((token) => {
    if (token.includes('..')) {
      const [startRaw, endRaw] = token.split('..').map((part) => part.trim());
      const start = Number.parseInt(startRaw, 10);
      const end = Number.parseInt(endRaw, 10);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
        throw new BadRequestException(`Invalid channel range: ${token}`);
      }
      for (let current = start; current <= end; current += 1) {
        validateChannel(current);
        channels.add(current);
      }
    } else {
      const channel = Number.parseInt(token, 10);
      if (!Number.isFinite(channel)) {
        throw new BadRequestException(`Invalid channel value: ${token}`);
      }
      validateChannel(channel);
      channels.add(channel);
    }
  });

  if (channels.size === 0) {
    throw new BadRequestException('Channel specification produced no usable values.');
  }

  return Array.from(channels)
    .sort((a, b) => a - b)
    .join(',');
}

function validateChannel(channel: number): void {
  if (channel < 1 || channel > 14) {
    throw new BadRequestException('Channel values must be between 1 and 14.');
  }
}

function handleHbInterval(params: string[]): string[] {
  if (params.length !== 1) {
    throw new BadRequestException('HB_INTERVAL expects a single interval parameter (minutes).');
  }
  const interval = Number.parseInt(params[0].trim(), 10);
  if (!Number.isFinite(interval) || interval < 1 || interval > 60) {
    throw new BadRequestException('Heartbeat interval must be between 1 and 60 minutes.');
  }
  return [interval.toString()];
}

function handleProbeStart(params: string[]): string[] {
  if (params.length < 1) {
    throw new BadRequestException(
      'PROBE_START expects mode:secs[:FOREVER][:+ALL]. Mode: 0=WiFi, 1=BLE, 2=Both.',
    );
  }
  const joined = params.join(':');
  const segments = joined.split(':').map((s) => s.trim());
  const result: string[] = [];
  for (const seg of segments) {
    const upper = seg.toUpperCase();
    if (upper === 'FOREVER' || upper === '+ALL') {
      result.push(upper);
    } else {
      const num = Number.parseInt(seg, 10);
      if (!Number.isFinite(num) || num < 0) {
        throw new BadRequestException(`Invalid PROBE_START parameter: ${seg}`);
      }
      result.push(num.toString());
    }
  }
  return result;
}

function handleBatterySaverStart(params: string[]): string[] {
  if (params.length !== 1) {
    throw new BadRequestException(
      'BATTERY_SAVER_START expects a single interval parameter (minutes).',
    );
  }
  const interval = Number.parseInt(params[0].trim(), 10);
  if (!Number.isFinite(interval) || interval < 1 || interval > 30) {
    throw new BadRequestException('Battery saver interval must be between 1 and 30 minutes.');
  }
  return [interval.toString()];
}

function handleSentinelMode(params: string[]): string[] {
  if (params.length !== 1) {
    throw new BadRequestException('SENTINEL_MODE expects a single mode value (scan or defend).');
  }
  const mode = params[0].trim().toLowerCase();
  if (!SENTINEL_MODES.has(mode)) {
    throw new BadRequestException('SENTINEL_MODE must be scan or defend.');
  }
  return [mode];
}

function handleSentinelBoot(params: string[]): string[] {
  if (params.length !== 1) {
    throw new BadRequestException('SENTINEL_BOOT expects a single value (on or off).');
  }
  const value = params[0].trim().toLowerCase();
  if (!SENTINEL_BOOT_STATES.has(value)) {
    throw new BadRequestException('SENTINEL_BOOT must be on or off.');
  }
  return [
    value === '1' || value === 'true' ? 'on' : value === '0' || value === 'false' ? 'off' : value,
  ];
}

function handleGroup(params: string[]): string[] {
  if (params.length !== 2) {
    throw new BadRequestException('GROUP expects a group name and a state (on or off).');
  }
  const name = params[0].trim().toLowerCase();
  if (!GROUP_NAMES.has(name)) {
    throw new BadRequestException(
      `Invalid group name: ${params[0]}. Expected one of dos, rogue, recon, physical, mesh, devices, all.`,
    );
  }
  const state = params[1].trim().toLowerCase();
  if (!GROUP_STATES.has(state)) {
    throw new BadRequestException('GROUP state must be on or off.');
  }
  return [name, state];
}

function handleDetectCfg(params: string[]): string[] {
  if (params.length !== 1) {
    throw new BadRequestException('DETECT_CFG expects a single JSON configuration string.');
  }
  const json = params[0].trim();
  if (json.length > 180) {
    throw new BadRequestException('DETECT_CFG payload must be 180 characters or fewer.');
  }
  try {
    JSON.parse(json);
  } catch {
    throw new BadRequestException('DETECT_CFG payload must be valid JSON.');
  }
  return [json];
}

function handleIncidents(params: string[]): string[] {
  if (params.length === 0) {
    return [];
  }
  if (params.length !== 1) {
    throw new BadRequestException('INCIDENTS expects an optional count (1-200).');
  }
  const count = Number.parseInt(params[0].trim(), 10);
  if (!Number.isFinite(count) || count < 1 || count > 200) {
    throw new BadRequestException('INCIDENTS count must be between 1 and 200.');
  }
  return [count.toString()];
}

function handleConfigErasePsk(params: string[]): string[] {
  if (params.length !== 2 && params.length !== 3) {
    throw new BadRequestException(
      'CONFIG_ERASE_PSK expects the new key and the current key, or the new key plus an ERASE_REQUEST token and the current key.',
    );
  }
  const key = params[0].trim();
  if (!isValidEraseKey(key)) {
    throw new BadRequestException(
      `Erase PSK must be ${ERASE_KEY_MIN}-${ERASE_KEY_MAX} characters with no ':'.`,
    );
  }
  if (params.length === 3) {
    return [key, resolveEraseAnswer(params.slice(1), 'CONFIG_ERASE_PSK')];
  }
  const current = params[1].trim();
  if (!isValidEraseKey(current)) {
    throw new BadRequestException(
      `The current erase key or answer must be ${ERASE_KEY_MIN}-${ERASE_KEY_MAX} characters with no ':'.`,
    );
  }
  return [key, current];
}

function handleConfigDedupTtl(params: string[]): string[] {
  if (params.length !== 1) {
    throw new BadRequestException('CONFIG_DEDUP_TTL expects a single TTL value in seconds.');
  }
  const ttl = Number.parseInt(params[0].trim(), 10);
  if (!Number.isFinite(ttl) || ttl < 0 || ttl > 3600) {
    throw new BadRequestException('Dedup TTL must be between 0 and 3600 seconds.');
  }
  return [ttl.toString()];
}

function handleConfigSessionDedup(params: string[]): string[] {
  if (params.length !== 1) {
    throw new BadRequestException('CONFIG_SESSION_DEDUP expects 0 or 1.');
  }
  const value = params[0].trim();
  if (value !== '0' && value !== '1') {
    throw new BadRequestException('CONFIG_SESSION_DEDUP must be 0 or 1.');
  }
  return [value];
}

function handleFactoryReset(params: string[]): string[] {
  if (params.length < 2 || params.length > 3) {
    throw new BadRequestException(
      'FACTORY_RESET expects a tier (FULL, CONFIG, or DATA) and the erase answer, or the ERASE_REQUEST token and the erase key.',
    );
  }
  const tier = params[0].trim().toUpperCase();
  if (!FACTORY_RESET_TIERS.has(tier)) {
    throw new BadRequestException('FACTORY_RESET tier must be FULL, CONFIG, or DATA.');
  }
  return [tier, resolveEraseAnswer(params.slice(1), 'FACTORY_RESET')];
}

function handleCsiMotionStart(params: string[]): string[] {
  if (params.length < 1) {
    throw new BadRequestException(
      'CSI_MOTION_START expects secs[:FOREVER][:CH<n>][:SOLICIT<ms>][:TELEM][:RAW][:MGMTONLY|MGMTDATA][:LISTEN_ONLY|ALLOW_TRANSMIT].',
    );
  }
  const output = [normalizeDuration(params[0], 0)];
  for (const raw of params.slice(1)) {
    const token = raw.trim().toUpperCase();
    if (CSI_START_FLAGS.has(token)) {
      output.push(token);
      continue;
    }
    const ch = /^CH(\d{1,2})$/.exec(token);
    if (ch) {
      const value = Number(ch[1]);
      if (value > 14) throw new BadRequestException('CSI channel must be 0 (auto) to 14.');
      output.push(`CH${value}`);
      continue;
    }
    const solicit = /^SOLICIT(\d{1,4})$/.exec(token);
    if (solicit) {
      const value = Number(solicit[1]);
      if (value < 10 || value > 1000) {
        throw new BadRequestException('CSI SOLICIT interval must be 10 to 1000 ms.');
      }
      output.push(`SOLICIT${value}`);
      continue;
    }
    throw new BadRequestException(`Invalid CSI_MOTION_START token: ${raw}`);
  }
  return output;
}

function handleCsiExclude(params: string[]): string[] {
  if (params.length !== 1) {
    throw new BadRequestException('CSI_EXCLUDE expects a MAC address or NONE.');
  }
  const value = params[0].trim().toUpperCase();
  if (value !== 'NONE' && !MAC_PATTERN.test(value)) {
    throw new BadRequestException('CSI_EXCLUDE expects a MAC address (AA:BB:CC:DD:EE:FF) or NONE.');
  }
  return [value];
}

function handleCsiCfg(params: string[]): string[] {
  if (params.length < 1) {
    throw new BadRequestException(
      'CSI_CFG expects KEY=VALUE tokens: SENSITIVITY, MIN_MOTION, CLEAR_AFTER, SPOTS, CH, BROADCAST, REQUIRE_CE, ALLOW_RANDOM.',
    );
  }
  return params.map((raw) => {
    const token = raw.trim().toUpperCase();
    const eq = token.indexOf('=');
    if (eq <= 0) throw new BadRequestException(`Invalid CSI_CFG token: ${raw}`);
    const key = token.slice(0, eq);
    const value = token.slice(eq + 1);
    const intIn = (min: number, max: number) => {
      const n = Number(value);
      if (!/^\d+$/.test(value) || n < min || n > max) {
        throw new BadRequestException(`CSI_CFG ${key} must be ${min}-${max}.`);
      }
    };
    switch (key) {
      case 'SENSITIVITY':
        if (!['LOW', 'MEDIUM', 'MED', 'HIGH'].includes(value)) {
          const n = Number(value);
          if (!Number.isFinite(n) || (n !== 0 && (n < 0.005 || n > 20))) {
            throw new BadRequestException(
              'CSI_CFG SENSITIVITY must be LOW, MEDIUM, HIGH, 0 or 0.005-20.',
            );
          }
        }
        break;
      case 'MIN_MOTION':
        intIn(2, 60);
        break;
      case 'CLEAR_AFTER':
        intIn(1, 120);
        break;
      case 'SPOTS':
        intIn(1, 12);
        break;
      case 'CH':
        intIn(0, 14);
        break;
      case 'BROADCAST':
      case 'REQUIRE_CE':
      case 'ALLOW_RANDOM':
        if (!CSI_ONOFF.has(value))
          throw new BadRequestException(`CSI_CFG ${key} must be ON or OFF.`);
        break;
      default:
        throw new BadRequestException(`Unsupported CSI_CFG key: ${key}`);
    }
    return `${key}=${value}`;
  });
}

function normalizeChannelSpec(value: string, max: number): string {
  const tokens = value
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    throw new BadRequestException('Channel list cannot be empty.');
  }
  return tokens
    .map((token) => {
      const range = /^(\d{1,3})\.\.(\d{1,3})$/.exec(token);
      const single = /^(\d{1,3})$/.exec(token);
      const start = range ? Number(range[1]) : single ? Number(single[1]) : NaN;
      const end = range ? Number(range[2]) : start;
      if (!Number.isFinite(start) || start < 1 || end > max || start > end) {
        throw new BadRequestException(`Invalid channel "${token}". Channels must be 1-${max}.`);
      }
      return token;
    })
    .join(',');
}

function expectSingleParam(params: string[], command: string, what: string): string {
  if (params.length !== 1) {
    throw new BadRequestException(`${command} expects ${what}.`);
  }
  return params[0].trim();
}

function parseBinaryFlag(value: string, command: string): '0' | '1' {
  const normalized = value.trim().toLowerCase();
  if (['1', 'on', 'true'].includes(normalized)) return '1';
  if (['0', 'off', 'false'].includes(normalized)) return '0';
  throw new BadRequestException(`${command} must be 0 or 1.`);
}

function handleConfigBand(params: string[]): string[] {
  const band = expectSingleParam(params, 'CONFIG_BAND', 'a band of 0, 1 or 2');
  if (!['0', '1', '2'].includes(band)) {
    throw new BadRequestException('CONFIG_BAND must be 0 (2.4 GHz), 1 (5 GHz) or 2 (both).');
  }
  return [band];
}

function handleBleClassify(params: string[]): string[] {
  return [parseBinaryFlag(expectSingleParam(params, 'BLE_CLASSIFY', '0 or 1'), 'BLE_CLASSIFY')];
}

function handleBleLongRange(params: string[]): string[] {
  return [parseBinaryFlag(expectSingleParam(params, 'BLE_LONGRANGE', '0 or 1'), 'BLE_LONGRANGE')];
}

function handleAttackerTrilat(params: string[]): string[] {
  return [
    parseBinaryFlag(
      expectSingleParam(params, 'ATTACKER_TRILAT', '0, 1, on or off'),
      'ATTACKER_TRILAT',
    ),
  ];
}

function handleCampaignStart(params: string[]): string[] {
  const name = expectSingleParam(params, 'CAMPAIGN_START', 'a campaign name');
  if (!CAMPAIGN_NAME_PATTERN.test(name)) {
    throw new BadRequestException(
      'Campaign name must be 1-23 characters of letters, digits, "-" or "_".',
    );
  }
  return [name];
}

function handlePcapAuto(params: string[]): string[] {
  if (params.length === 0) {
    return [];
  }
  const parts = params
    .join(',')
    .split(',')
    .map((value) => value.trim());
  if (parts.length !== 2 || parts.some((value) => !/^\d+$/.test(value))) {
    throw new BadRequestException('PCAP_AUTO expects budgetMB,floorMB (e.g., 512,64) or nothing.');
  }
  const budget = Number(parts[0]);
  const floor = Number(parts[1]);
  if (budget < 16 || budget > 262_144 || floor > 262_144) {
    throw new BadRequestException(
      'PCAP_AUTO budget must be 16-262144 MB and floor must be 0-262144 MB.',
    );
  }
  return [`${budget},${floor}`];
}

function handleSdRepair(params: string[]): string[] {
  if (params.length === 0) {
    return [];
  }
  const value = expectSingleParam(params, 'SD_REPAIR', 'ON, OFF, NOW or nothing').toUpperCase();
  if (!['ON', 'OFF', 'NOW'].includes(value)) {
    throw new BadRequestException('SD_REPAIR must be ON, OFF or NOW.');
  }
  return [value];
}

function handleSchedAdd(params: string[]): string[] {
  const block = expectSingleParam(
    params,
    'SCHED_ADD',
    'one value of the form YYYY-MM-DDTHH:MM|repeat|route|options',
  );
  const parts = block.split('|');
  if (parts.length !== 4) {
    throw new BadRequestException(
      'SCHED_ADD expects start|repeat|route|options, for example 2030-01-01T02:00|0|/scan|mode=2&secs=600.',
    );
  }
  const [start, repeat, route, options] = parts.map((part) => part.trim());
  const match = SCHED_START_PATTERN.exec(start);
  if (!match) {
    throw new BadRequestException('SCHED_ADD start must look like YYYY-MM-DDTHH:MM.');
  }
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  if (year < 2021 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    throw new BadRequestException('SCHED_ADD start is not a valid local time after 2021-01-01.');
  }
  if (!/^\d+$/.test(repeat)) {
    throw new BadRequestException('SCHED_ADD repeat must be 0 or 600-2678400 seconds.');
  }
  const repeatSeconds = Number(repeat);
  if (repeatSeconds !== 0 && (repeatSeconds < 600 || repeatSeconds > 2_678_400)) {
    throw new BadRequestException('SCHED_ADD repeat must be 0 or 600-2678400 seconds.');
  }
  if (!SCHED_ROUTES.has(route)) {
    throw new BadRequestException('SCHED_ADD route must be /scan, /sniffer or /drone.');
  }
  if (options.length < 1 || options.length > 1024) {
    throw new BadRequestException('SCHED_ADD options must be 1-1024 characters.');
  }
  if (!/^[A-Za-z0-9_=&.,%/:+-]+$/.test(options)) {
    throw new BadRequestException(
      'SCHED_ADD options may only contain letters, digits and = & . , % / : + - _',
    );
  }
  return [`${start}|${repeatSeconds}|${route}|${options}`];
}

function handleSchedDel(params: string[]): string[] {
  const value = expectSingleParam(params, 'SCHED_DEL', 'the position from SCHED_LIST');
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new BadRequestException('SCHED_DEL position must be 1 or higher.');
  }
  return [String(Number(value))];
}

function handleCalibrate(params: string[]): string[] {
  const joined = params.join(':');
  const split = joined.lastIndexOf(':');
  const mac = split > 0 ? joined.slice(0, split).trim().toUpperCase() : '';
  const meters = split > 0 ? joined.slice(split + 1).trim() : '';
  const distance = Number(meters);
  if (!MAC_PATTERN.test(mac) || meters === '' || !Number.isFinite(distance)) {
    throw new BadRequestException('CALIBRATE expects a reference MAC and a distance in meters.');
  }
  if (distance < 0.5 || distance > 100) {
    throw new BadRequestException('CALIBRATE distance must be 0.5-100 meters.');
  }
  return [mac, String(distance)];
}

function handleVibscanSet(params: string[]): string[] {
  if (params.length < 3 || params.length > 5) {
    throw new BadRequestException(
      'VIBSCAN_SET expects on:scan:secs with optional cooldown and interrupt.',
    );
  }
  const intIn = (value: string, label: string, min: number, max: number): number => {
    if (!/^\d+$/.test(value.trim()) || Number(value) < min || Number(value) > max) {
      throw new BadRequestException(`VIBSCAN_SET ${label} must be ${min}-${max}.`);
    }
    return Number(value);
  };
  const on = intIn(params[0], 'on', 0, 1);
  const scan = intIn(params[1], 'scan', 0, 8);
  const secs = intIn(params[2], 'secs', 0, 65_535);
  if (scan === 8 && secs === 0) {
    throw new BadRequestException('VIBSCAN_SET scan 8 (packet capture) needs secs above 0.');
  }
  const output = [on, scan, secs];
  if (params.length >= 4) {
    output.push(intIn(params[3], 'cooldown', 5, 86_400));
  }
  if (params.length === 5) {
    output.push(intIn(params[4], 'interrupt', 0, 1));
  }
  return output.map(String);
}

function handleRadioKnownAdd(params: string[]): string[] {
  const match = RADIO_KNOWN_ADD_PATTERN.exec(params.join(':'));
  if (!match) {
    throw new BadRequestException(
      'RADIO_KNOWN_ADD expects mac:type[:name] with type Meshtastic or MeshCore.',
    );
  }
  const name = (match[3] ?? '').trim();
  if (name.length > 31 || /[^\x20-\x7e]/.test(name)) {
    throw new BadRequestException('RADIO_KNOWN_ADD name must be at most 31 printable characters.');
  }
  const type = match[2].toLowerCase() === 'meshcore' ? 'MeshCore' : 'Meshtastic';
  const output = [match[1].toUpperCase(), type];
  if (name) {
    output.push(name);
  }
  return output;
}

function handleRadioKnownDel(params: string[]): string[] {
  const mac = params.join(':').toUpperCase();
  if (!MAC_PATTERN.test(mac)) {
    throw new BadRequestException('RADIO_KNOWN_DEL expects a MAC address (AA:BB:CC:DD:EE:FF).');
  }
  return [mac];
}

function handleSelfRadioSet(params: string[]): string[] {
  const prefix = expectSingleParam(params, 'SELF_RADIO_SET', 'a name prefix');
  if (prefix.length < 1 || prefix.length > 12 || /[^\x21-\x7e]/.test(prefix)) {
    throw new BadRequestException(
      'SELF_RADIO_SET prefix must be 1-12 printable characters with no spaces.',
    );
  }
  return [prefix];
}

function normalizeTargetReference(value: string): string {
  const trimmed = value.trim();
  const upper = trimmed.toUpperCase();
  if (MAC_PATTERN.test(upper)) {
    return upper;
  }
  if (TRIANGULATE_IDENTITY_PATTERN.test(trimmed)) {
    return trimmed;
  }
  throw new BadRequestException(
    'Target reference must be a MAC address (AA:BB:CC:DD:EE:FF) or T-identity (e.g., T-sensor01).',
  );
}

export function normalizeNodeId(nodeId: string): string {
  const upper = nodeId.trim().toUpperCase();
  if (!NODE_PATTERN.test(upper)) {
    throw new BadRequestException(`Invalid node identifier ${nodeId}`);
  }
  return upper;
}
