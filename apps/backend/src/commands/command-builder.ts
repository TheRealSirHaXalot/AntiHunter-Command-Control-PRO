import { BadRequestException } from '@nestjs/common';

const NODE_PATTERN = /^NODE_[A-Z0-9]+$/;
const MAC_PATTERN = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;
const ERASE_TOKEN_PATTERN = /^AH_[0-9]{8}_[0-9]{8}_[0-9]{8}$/;
const TRIANGULATE_IDENTITY_PATTERN = /^T-[A-Za-z0-9_-]+$/;
const CUSTOM_NODE_ID_PATTERN = /^[A-Z0-9]{2,6}$/;

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
  ['TRIANGULATE_START', handleTriangulateStart],
  ['TRIANGULATE_STOP', expectNoParams],
  ['TRIANGULATE_RESULTS', expectNoParams],
  ['ERASE_REQUEST', expectNoParams],
  ['ERASE_FORCE', handleEraseForce],
  ['ERASE_CANCEL', expectNoParams],
  ['AUTOERASE_ENABLE', handleAutoEraseEnable],
  ['AUTOERASE_DISABLE', expectNoParams],
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
]);

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

  return { target, name, params, line };
}

function normalizeTarget(target: string): string {
  const normalized = target.trim().toUpperCase();
  if (normalized === '@ALL') {
    return normalized;
  }

  if (normalized.startsWith('@')) {
    const withoutAt = normalized.slice(1);
    if (NODE_PATTERN.test(withoutAt)) {
      return normalized;
    }
    if (/^[A-Z0-9]{2,6}$/.test(withoutAt)) {
      return normalized;
    }
  }

  throw new BadRequestException('Invalid target. Use @ALL or @NODE_<ID> (e.g., @NODE_22).');
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
      'CONFIG_TARGETS expects a single pipe-delimited string of MAC addresses.',
    );
  }
  const entries = params[0]
    .split('|')
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
  if (entries.length === 0) {
    throw new BadRequestException('CONFIG_TARGETS requires at least one MAC address.');
  }
  entries.forEach((mac) => {
    if (!MAC_PATTERN.test(mac)) {
      throw new BadRequestException(`Invalid MAC address: ${mac}`);
    }
  });
  return [entries.join('|')];
}

function handleConfigRssi(params: string[]): string[] {
  if (params.length !== 1) {
    throw new BadRequestException('CONFIG_RSSI expects a single RSSI threshold value.');
  }
  const parsed = Number.parseInt(params[0].trim(), 10);
  if (!Number.isFinite(parsed) || parsed > -1 || parsed < -120) {
    throw new BadRequestException('RSSI threshold must be between -120 and -1 dBm.');
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
      'Node identifier must be 2-6 characters long and contain only A-Z or 0-9.',
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
  if (params.length < 2 || params.length > 4) {
    throw new BadRequestException(
      'DEVICE_SCAN_START expects mode, duration (seconds), and optional FOREVER and/or +PROBE tokens.',
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
    } else {
      throw new BadRequestException(
        `Invalid DEVICE_SCAN_START token: ${params[i]}. Expected FOREVER or +PROBE.`,
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
      'PCAP_START expects radio, duration (seconds), optional band, and optional FOREVER token.',
    );
  }
  const radio = params[0].trim();
  if (!['0', '1'].includes(radio)) {
    throw new BadRequestException('Radio must be 0 (WiFi) or 1 (BLE).');
  }
  const duration = normalizeDuration(params[1]);
  const output = [radio, duration];
  for (let i = 2; i < params.length; i += 1) {
    const token = params[i].trim().toUpperCase();
    if (token === 'FOREVER') {
      output.push(token);
      continue;
    }
    if (!['0', '1', '2'].includes(token)) {
      throw new BadRequestException(
        `Invalid PCAP_START token: ${params[i]}. Expected band 0, 1, 2 or FOREVER.`,
      );
    }
    output.push(token);
  }
  return output;
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

function handleEraseForce(params: string[]): string[] {
  if (params.length !== 1) {
    throw new BadRequestException('ERASE_FORCE expects a single confirmation token.');
  }
  const token = params[0].trim().toUpperCase();
  if (!ERASE_TOKEN_PATTERN.test(token)) {
    throw new BadRequestException(
      'Invalid ERASE token. Expected format AH_XXXXXXXX_XXXXXXXX_XXXXXXXX.',
    );
  }
  return [token];
}

function handleAutoEraseEnable(params: string[]): string[] {
  if (params.length === 0) {
    return [];
  }
  if (params.length !== 5) {
    throw new BadRequestException(
      'AUTOERASE_ENABLE expects either no parameters (uses defaults) or all 5 parameters (setupDelay:eraseDelay:vibs:window:cooldown).',
    );
  }

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
  if (!Number.isFinite(interval) || interval < 1 || interval > 1440) {
    throw new BadRequestException('Heartbeat interval must be between 1 and 1440 minutes.');
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
  if (!Number.isFinite(interval) || interval < 1 || interval > 1440) {
    throw new BadRequestException('Heartbeat interval must be between 1 and 1440 minutes.');
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
      `Invalid group name: ${params[0]}. Expected one of dos, rogue, recon, physical, mesh, all.`,
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
  if (params.length !== 1) {
    throw new BadRequestException('CONFIG_ERASE_PSK expects a single pre-shared key.');
  }
  const key = params[0].trim();
  if (key.length < 1 || key.length > 64) {
    throw new BadRequestException('Erase PSK must be between 1 and 64 characters.');
  }
  return [key];
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
  if (params.length !== 2) {
    throw new BadRequestException(
      'FACTORY_RESET expects a tier (FULL, CONFIG, or DATA) and a credential.',
    );
  }
  const tier = params[0].trim().toUpperCase();
  if (!FACTORY_RESET_TIERS.has(tier)) {
    throw new BadRequestException('FACTORY_RESET tier must be FULL, CONFIG, or DATA.');
  }
  const credential = params[1].trim();
  if (credential.length < 1) {
    throw new BadRequestException('FACTORY_RESET requires a credential.');
  }
  return [tier, credential];
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
