export type AlertTier = 'off' | 'alert' | 'critical';

export interface AlertSource {
  key: string;
  label: string;
  group: string;
  defaultTier: AlertTier;
}

export const DEVICE_SOURCES: AlertSource[] = [
  { key: 'sentinel', label: 'Wi-Fi attacks', group: 'Attacks', defaultTier: 'alert' },
  { key: 'node:attack', label: 'Deauth / disassoc', group: 'Attacks', defaultTier: 'alert' },
  { key: 'target', label: 'Target detected', group: 'Detections', defaultTier: 'off' },
  { key: 'node:drone', label: 'Drone', group: 'Detections', defaultTier: 'off' },
  { key: 'node:anomaly', label: 'Baseline anomaly', group: 'Detections', defaultTier: 'off' },
  { key: 'node:csi', label: 'CSI motion', group: 'Detections', defaultTier: 'off' },
  { key: 'node:tamper', label: 'Tamper', group: 'Node security', defaultTier: 'alert' },
  { key: 'node:vibration', label: 'Vibration', group: 'Node security', defaultTier: 'alert' },
  { key: 'node:erase', label: 'Erase', group: 'Node security', defaultTier: 'alert' },
  { key: 'node:mesh-guard', label: 'Mesh guard', group: 'Node security', defaultTier: 'alert' },
  { key: 'node:status', label: 'Node status', group: 'Node security', defaultTier: 'off' },
  { key: 'mqtt', label: 'Linked MQTT sites', group: 'Other sites', defaultTier: 'alert' },
  { key: 'event:inventory', label: 'Inventory updated', group: 'Data streams', defaultTier: 'off' },
  {
    key: 'event:node-telemetry',
    label: 'Node telemetry',
    group: 'Data streams',
    defaultTier: 'off',
  },
  {
    key: 'event:drone-telemetry',
    label: 'Drone telemetry',
    group: 'Data streams',
    defaultTier: 'off',
  },
  {
    key: 'event:command-ack',
    label: 'Command acknowledgements',
    group: 'Data streams',
    defaultTier: 'off',
  },
  {
    key: 'event:command-result',
    label: 'Command results',
    group: 'Data streams',
    defaultTier: 'off',
  },
  { key: 'event:serial-raw', label: 'Raw serial lines', group: 'Data streams', defaultTier: 'off' },
];

const DEFAULTS = new Map(DEVICE_SOURCES.map((source) => [source.key, source.defaultTier]));

export const SOURCE_KEY =
  /^(rule:[A-Za-z0-9_-]{1,64}|sentinel|node:[a-z-]{2,32}|target|mqtt|event:[a-z-]{2,32})$/;

export function defaultTier(key: string): AlertTier {
  if (key.startsWith('rule:')) {
    return 'alert';
  }
  return DEFAULTS.get(key) ?? 'off';
}

export function nodeAlertSource(
  category: string | undefined,
  level: string,
  data: unknown,
): string | null {
  const cat = (category ?? '').toLowerCase();
  const detectionType = (data as { detectionType?: unknown } | null)?.detectionType;
  if (cat === 'sentinel' && typeof detectionType === 'string' && detectionType.startsWith('CSI_')) {
    return level === 'ALERT' ? 'node:csi' : null;
  }
  if (cat === 'sentinel') {
    return level === 'ALERT' ? 'sentinel' : null;
  }
  if (cat === 'attack' || cat === 'drone' || cat === 'anomaly') {
    return `node:${cat}`;
  }
  if (['tamper', 'vibration', 'erase', 'mesh-guard'].includes(cat) && level === 'ALERT') {
    return `node:${cat}`;
  }
  if (
    ['heartbeat', 'startup', 'gps', 'time-sync', 'battery-saver', 'setup'].includes(cat) ||
    cat.endsWith('-done')
  ) {
    return 'node:status';
  }
  return null;
}
