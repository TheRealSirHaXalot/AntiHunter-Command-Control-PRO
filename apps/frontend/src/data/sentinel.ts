export interface SentinelGroup {
  key: string;
  label: string;
  description: string;
}

export const SENTINEL_GROUPS: SentinelGroup[] = [
  { key: 'dos', label: 'DoS', description: 'Evil-twin, SAE flood, assoc-sleep' },
  { key: 'rogue', label: 'Rogue AP', description: 'Evil-twin, OWE abuse, Karma' },
  { key: 'recon', label: 'Recon', description: 'PMKID, probe flood, handshake capture' },
  { key: 'physical', label: 'Physical', description: 'FragAttack, TSF anomaly, jamming' },
  { key: 'mesh', label: 'Mesh Guard', description: 'Mesh spoof / flood / command injection' },
];

export const SENTINEL_MODES = [
  { value: 'scan', label: 'Scan all channels' },
  { value: 'defend', label: 'Defend this AP' },
];

export const SENTINEL_DEFAULT_MODE = 'defend';

export interface SentinelDetector {
  key: string;
  label: string;
}

export const SENTINEL_DETECTORS: SentinelDetector[] = [
  { key: 'pmkid', label: 'PMKID Harvest' },
  { key: 'eviltwin', label: 'Evil-Twin / Beacon Forge' },
  { key: 'ssid_confusion', label: 'SSID Confusion' },
  { key: 'sae', label: 'SAE DoS' },
  { key: 'owe', label: 'OWE Abuse' },
  { key: 'karma', label: 'KARMA Bait' },
  { key: 'probe_flood', label: 'Probe Flood' },
  { key: 'assoc_sleep', label: 'Assoc-Sleep DoS' },
  { key: 'hshk', label: 'Handshake Capture' },
  { key: 'frag', label: 'FragAttack' },
  { key: 'tsf', label: 'TSF Anomaly' },
  { key: 'jam', label: 'WiFi Jamming' },
  { key: 'mesh_guard', label: 'Mesh Guard' },
];

const DETECTION_LABELS: Record<string, string> = {
  EVILTWIN: 'Evil Twin',
  OWE_ABUSE: 'OWE Abuse',
  PMKID_FORGE: 'PMKID Forge',
  PMKID_HARVEST: 'PMKID Harvest',
  EAPOL_BAIT: 'EAPOL Bait',
  HSHK: 'Handshake Capture',
  KARMA_CAND: 'Karma (candidate)',
  KARMA_CONFIRMED: 'Karma (confirmed)',
  PWNAGOTCHI: 'Pwnagotchi',
  PROBE_FLOOD: 'Probe Flood',
  PROBE_FLOOD_BEHAVE: 'Probe Flood (behavioral)',
  PROBE_FLOOD_AP: 'Probe Flood (AP)',
  SAE_DOS: 'SAE DoS',
  DEAUTH_FLOOD: 'Deauth Flood',
  DEAUTH_FORGE: 'Deauth Forge',
  DEAUTH_AP_TARGETED: 'Deauth (AP targeted)',
  BEACON_FLOOD: 'Beacon Flood',
  BEACON_FORGE: 'Beacon Forge',
  ASSOC_SLEEP: 'Assoc-Sleep DoS',
  AUTH_FLOOD: 'Auth Flood',
  SSID_CONFUSION: 'SSID Confusion',
  FRAG: 'FragAttack',
  ATTACKER_HUNT: 'Attacker Hunt',
  RECON: 'Recon Score',
  JAMMING: 'RF Jamming',
  MESH_SPOOF_SELF: 'Mesh Spoof',
  MESH_FLOOD: 'Mesh Flood',
  MESH_CMD_INJECT: 'Mesh Command Injection',
};

export function sentinelDetectionLabel(detectionType: string): string {
  const upper = detectionType.toUpperCase();
  return DETECTION_LABELS[upper] ?? upper;
}
