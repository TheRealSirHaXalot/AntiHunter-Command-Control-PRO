export type CommandGroup =
  | 'Configuration'
  | 'Scanning'
  | 'Detection'
  | 'Sentinel'
  | 'Triangulation'
  | 'Status'
  | 'Security';

// RF Environment Presets for triangulation path loss calculation
// Based on RF propagation research for RSSI-based distance estimation
export const RF_ENVIRONMENTS = {
  OPEN_SKY: {
    value: '0',
    label: 'Open Sky',
    wifiN: 2.0,
    bleN: 2.0,
    description: 'Line-of-sight, minimal obstructions',
  },
  SUBURBAN: {
    value: '1',
    label: 'Suburban',
    wifiN: 2.7,
    bleN: 2.4,
    description: 'Urban outdoor with some obstructions',
  },
  INDOOR: {
    value: '2',
    label: 'Indoor',
    wifiN: 3.0,
    bleN: 2.5,
    description: 'Standard indoor office (default)',
  },
  INDOOR_DENSE: {
    value: '3',
    label: 'Indoor Dense',
    wifiN: 4.0,
    bleN: 3.5,
    description: 'Heavy walls, partitions',
  },
  INDUSTRIAL: {
    value: '4',
    label: 'Industrial',
    wifiN: 5.0,
    bleN: 4.5,
    description: 'Concrete, metal, heavy obstructions',
  },
} as const;

export type RFEnvironmentKey = keyof typeof RF_ENVIRONMENTS;
export type RFEnvironmentValue = (typeof RF_ENVIRONMENTS)[RFEnvironmentKey]['value'];

export const RF_ENVIRONMENT_OPTIONS = Object.values(RF_ENVIRONMENTS).map((env) => ({
  label: env.label,
  value: env.value,
  description: env.description,
}));

export const DEFAULT_RF_ENVIRONMENT = RF_ENVIRONMENTS.INDOOR.value;

export type CommandParamType = 'text' | 'number' | 'select' | 'duration' | 'channels' | 'pipeList';

export interface CommandParameter {
  key: string;
  label: string;
  type: CommandParamType;
  helper?: string;
  placeholder?: string;
  required?: boolean;
  options?: Array<{ label: string; value: string }>;
  allowForever?: boolean;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
}

export interface CommandDefinition {
  name: string;
  group: CommandGroup;
  description: string;
  defaultTarget?: string;
  parameters: CommandParameter[];
  allowForever?: boolean;
  allowProbe?: boolean;
  allowBroadcastAll?: boolean;
  examples?: Array<{ target: string; params: string[]; label?: string }>;
}

export const MESH_COMMANDS: CommandDefinition[] = [
  {
    name: 'STATUS',
    group: 'Status',
    description:
      'Reports system status (mode, scan state, hits, targets, unique MACs, temperature, uptime, GPS).',
    defaultTarget: '@ALL',
    parameters: [],
    examples: [
      { target: '@ALL', params: [], label: 'All nodes' },
      { target: '@NODE_22', params: [], label: 'Specific node' },
    ],
  },
  {
    name: 'CONFIG_CHANNELS',
    group: 'Configuration',
    description: 'Configure WiFi channels using CSV list or range (1..14).',
    defaultTarget: '@NODE_22',
    parameters: [
      {
        key: 'channels',
        label: 'Channels',
        type: 'channels',
        placeholder: '1,6,11 or 1..14',
        helper: 'Comma list/range (1..14).',
        required: true,
      },
    ],
    examples: [
      { target: '@NODE_22', params: ['1,6,11'] },
      { target: '@ALL', params: ['1..14'] },
    ],
  },
  {
    name: 'CONFIG_TARGETS',
    group: 'Configuration',
    description: 'Update target watchlist using pipe-delimited MACs.',
    defaultTarget: '@ALL',
    parameters: [
      {
        key: 'macs',
        label: 'Target MACs',
        type: 'pipeList',
        placeholder: 'AA:BB:CC:DD:EE:FF|11:22:33:44:55:66',
        helper: 'Pipe-separated MAC list.',
        required: true,
      },
    ],
    examples: [
      {
        target: '@NODE_22',
        params: ['AA:BB:CC:DD:EE:FF|11:22:33:44:55:66'],
      },
    ],
  },
  {
    name: 'CONFIG_RSSI',
    group: 'Configuration',
    description: 'Set detection RSSI threshold (negative dBm).',
    defaultTarget: '@NODE_22',
    parameters: [
      {
        key: 'threshold',
        label: 'RSSI Threshold (dBm)',
        type: 'number',
        placeholder: '-65',
        helper: 'Value between -128 and -10 dBm.',
        required: true,
        min: -128,
        max: -10,
        step: 1,
      },
    ],
    examples: [{ target: '@NODE_22', params: ['-65'] }],
  },
  {
    name: 'CONFIG_NODEID',
    group: 'Configuration',
    description: 'Assign a new short identifier to a node.',
    defaultTarget: '@NODE_22',
    parameters: [
      {
        key: 'nodeId',
        label: 'Node Identifier',
        type: 'text',
        placeholder: 'AH03',
        helper: 'Uppercase letters/numbers, 2-6 characters.',
        required: true,
      },
    ],
    examples: [{ target: '@NODE_22', params: ['AH03'] }],
  },
  {
    name: 'SCAN_START',
    group: 'Scanning',
    description: 'Start scanning. mode: 0=WiFi, 1=BLE, 2=Both.',
    defaultTarget: '@ALL',
    parameters: [
      {
        key: 'mode',
        label: 'Mode',
        type: 'select',
        options: [
          { label: '0 - WiFi', value: '0' },
          { label: '1 - BLE', value: '1' },
          { label: '2 - Both', value: '2' },
        ],
        required: true,
      },
      {
        key: 'duration',
        label: 'Duration (seconds)',
        type: 'duration',
        placeholder: '60',
        required: true,
        min: 1,
        max: 86400,
        suffix: 'sec',
      },
      {
        key: 'channels',
        label: 'Channels',
        type: 'channels',
        placeholder: '1,6,11 or 1..14',
        required: true,
      },
    ],
    allowForever: true,
    examples: [
      { target: '@ALL', params: ['0', '60', '1,6,11'] },
      { target: '@NODE_22', params: ['2', '300', '1..14', 'FOREVER'] },
    ],
  },
  {
    name: 'DEVICE_SCAN_START',
    group: 'Scanning',
    description:
      'Start device scan for WiFi/BLE devices. +PROBE enables probe request capture during the scan.',
    defaultTarget: '@ALL',
    parameters: [
      {
        key: 'mode',
        label: 'Mode',
        type: 'select',
        options: [
          { label: '0 - WiFi', value: '0' },
          { label: '1 - BLE', value: '1' },
          { label: '2 - Both', value: '2' },
        ],
        required: true,
      },
      {
        key: 'duration',
        label: 'Duration (seconds)',
        type: 'duration',
        placeholder: '300',
        required: true,
        min: 1,
        max: 86400,
        suffix: 'sec',
      },
    ],
    allowForever: true,
    allowProbe: true,
    examples: [
      { target: '@ALL', params: ['2', '300'] },
      { target: '@ALL', params: ['2', '300', '+PROBE'] },
      { target: '@NODE_22', params: ['2', '300', 'FOREVER'] },
    ],
  },
  {
    name: 'STOP',
    group: 'Scanning',
    description: 'Stop all operations currently running.',
    defaultTarget: '@ALL',
    parameters: [],
    examples: [{ target: '@ALL', params: [] }],
  },
  {
    name: 'BASELINE_START',
    group: 'Detection',
    description: 'Begin baseline recording for environment detection.',
    defaultTarget: '@ALL',
    parameters: [
      {
        key: 'duration',
        label: 'Duration (seconds)',
        type: 'duration',
        placeholder: '300',
        required: true,
        min: 1,
        max: 86400,
        suffix: 'sec',
      },
    ],
    allowForever: true,
    examples: [
      { target: '@ALL', params: ['300'] },
      { target: '@NODE_22', params: ['600', 'FOREVER'] },
    ],
  },
  {
    name: 'BASELINE_STATUS',
    group: 'Detection',
    description: 'Report baseline status across nodes.',
    defaultTarget: '@ALL',
    parameters: [],
  },
  {
    name: 'DRONE_START',
    group: 'Detection',
    description: 'Begin drone RID detection (WiFi only).',
    defaultTarget: '@ALL',
    parameters: [
      {
        key: 'duration',
        label: 'Duration (seconds)',
        type: 'duration',
        placeholder: '600',
        required: true,
        min: 1,
        max: 86400,
        suffix: 'sec',
      },
    ],
    allowForever: true,
    examples: [
      { target: '@ALL', params: ['600'] },
      { target: '@NODE_22', params: ['600', 'FOREVER'] },
    ],
  },
  {
    name: 'DEAUTH_START',
    group: 'Detection',
    description: 'Start deauthentication detection.',
    defaultTarget: '@ALL',
    parameters: [
      {
        key: 'duration',
        label: 'Duration (seconds)',
        type: 'duration',
        placeholder: '300',
        required: true,
        min: 1,
        max: 86400,
        suffix: 'sec',
      },
    ],
    allowForever: true,
    examples: [
      { target: '@ALL', params: ['300'] },
      { target: '@NODE_22', params: ['300', 'FOREVER'] },
    ],
  },
  {
    name: 'RANDOMIZATION_START',
    group: 'Detection',
    description: 'Start MAC randomization detection (mode 0=WiFi,1=BLE,2=Both).',
    defaultTarget: '@ALL',
    parameters: [
      {
        key: 'mode',
        label: 'Mode',
        type: 'select',
        options: [
          { label: '0 - WiFi', value: '0' },
          { label: '1 - BLE', value: '1' },
          { label: '2 - Both', value: '2' },
        ],
        required: true,
      },
      {
        key: 'duration',
        label: 'Duration (seconds)',
        type: 'duration',
        placeholder: '600',
        required: true,
        min: 1,
        max: 86400,
        suffix: 'sec',
      },
    ],
    allowForever: true,
    examples: [
      { target: '@ALL', params: ['2', '600'] },
      { target: '@NODE_22', params: ['0', '600', 'FOREVER'] },
    ],
  },
  {
    name: 'PROBE_START',
    group: 'Scanning',
    description:
      'Start probe request scanner (mode 0=WiFi,1=BLE,2=Both). +ALL broadcasts every probe over mesh.',
    defaultTarget: '@ALL',
    parameters: [
      {
        key: 'mode',
        label: 'Mode',
        type: 'select',
        options: [
          { label: '0 - WiFi', value: '0' },
          { label: '1 - BLE', value: '1' },
          { label: '2 - Both', value: '2' },
        ],
        required: true,
      },
      {
        key: 'duration',
        label: 'Duration (seconds)',
        type: 'duration',
        placeholder: '300',
        required: true,
        min: 1,
        max: 86400,
        suffix: 'sec',
      },
    ],
    allowForever: true,
    allowBroadcastAll: true,
    examples: [
      { target: '@ALL', params: ['2', '300'] },
      { target: '@ALL', params: ['2', '300', '+ALL'] },
      { target: '@NODE_22', params: ['0', '300', 'FOREVER'] },
    ],
  },
  {
    name: 'PROBE_STOP',
    group: 'Scanning',
    description: 'Stop probe request scanner.',
    defaultTarget: '@ALL',
    parameters: [],
  },
  {
    name: 'TRIANGULATE_START',
    group: 'Triangulation',
    description: 'Initiate triangulation for MAC or identity (T-xxx).',
    defaultTarget: '@ALL',
    parameters: [
      {
        key: 'target',
        label: 'Target MAC/Identity',
        type: 'text',
        placeholder: 'AA:BB:CC:DD:EE:FF or T-sensor001',
        required: true,
      },
      {
        key: 'duration',
        label: 'Duration (seconds)',
        type: 'duration',
        placeholder: '45',
        required: true,
        min: 20,
        max: 300,
        suffix: 'sec',
      },
      {
        key: 'rfEnvironment',
        label: 'RF Environment',
        type: 'select',
        options: [
          { label: 'Open Sky', value: '0' },
          { label: 'Suburban', value: '1' },
          { label: 'Indoor (Default)', value: '2' },
          { label: 'Indoor Dense', value: '3' },
          { label: 'Industrial', value: '4' },
        ],
        required: true,
        helper: 'Adjusts path loss exponent (n) for RSSI-based distance calculation.',
      },
      {
        key: 'wifiPwr',
        label: 'WiFi Power Multiplier',
        type: 'number',
        placeholder: '1.0',
        required: false,
        min: 0.1,
        max: 5.0,
        step: 0.1,
        helper: 'Distance multiplier for WiFi signals (0.1-5.0, default 1.0).',
      },
      {
        key: 'blePwr',
        label: 'BLE Power Multiplier',
        type: 'number',
        placeholder: '1.0',
        required: false,
        min: 0.1,
        max: 5.0,
        step: 0.1,
        helper: 'Distance multiplier for BLE signals (0.1-5.0, default 1.0).',
      },
    ],
    examples: [
      { target: '@ALL', params: ['AA:BB:CC:DD:EE:FF', '30', '2'] },
      { target: '@NODE_22', params: ['T-sensor001', '60', '3'] },
      { target: '@ALL', params: ['AA:BB:CC:DD:EE:FF', '60', '2', '1.5', '0.8'] },
    ],
  },
  {
    name: 'TRIANGULATE_STOP',
    group: 'Triangulation',
    description: 'Stop active triangulation.',
    defaultTarget: '@ALL',
    parameters: [],
  },
  {
    name: 'TRIANGULATE_RESULTS',
    group: 'Triangulation',
    description: 'Fetch the latest triangulation results from a node.',
    defaultTarget: '@NODE_22',
    parameters: [],
  },
  {
    name: 'VIBRATION_STATUS',
    group: 'Security',
    description: 'Query tamper/vibration sensor status.',
    defaultTarget: '@NODE_22',
    parameters: [],
  },
  {
    name: 'VIBRATION_ON',
    group: 'Security',
    description: 'Enable tamper/vibration detection.',
    defaultTarget: '@NODE_22',
    parameters: [],
  },
  {
    name: 'VIBRATION_OFF',
    group: 'Security',
    description: 'Disable tamper/vibration detection.',
    defaultTarget: '@NODE_22',
    parameters: [],
  },
  {
    name: 'ERASE_REQUEST',
    group: 'Security',
    description: 'Request erase token to perform a force erase',
    defaultTarget: '@NODE_22',
    parameters: [],
    examples: [
      { target: '@NODE_22', params: [], label: 'Request token' },
      { target: '@ALL', params: [], label: 'Broadcast request' },
    ],
  },
  {
    name: 'ERASE_FORCE',
    group: 'Security',
    description: 'Force emergency erase (requires admin token).',
    defaultTarget: '@NODE_22',
    parameters: [
      {
        key: 'token',
        label: 'Authorization Token',
        type: 'text',
        placeholder: 'AH_12345678_87654321_00001234',
        helper: 'Format AH_########_########_########',
        required: true,
      },
    ],
  },
  {
    name: 'ERASE_CANCEL',
    group: 'Security',
    description: 'Cancel an ongoing erase operation.',
    defaultTarget: '@ALL',
    parameters: [],
  },
  {
    name: 'AUTOERASE_ENABLE',
    group: 'Security',
    description: 'Enable auto-erase with optional custom parameters',
    defaultTarget: '@NODE_22',
    parameters: [
      {
        key: 'setupDelay',
        label: 'Setup Delay (seconds)',
        type: 'number',
        placeholder: '120',
        helper: 'Grace period before auto-erase activates (30-600s).',
        required: false,
        min: 30,
        max: 600,
        step: 1,
      },
      {
        key: 'eraseDelay',
        label: 'Erase Delay (seconds)',
        type: 'number',
        placeholder: '30',
        helper: 'Countdown before data destruction (10-300s).',
        required: false,
        min: 10,
        max: 300,
        step: 1,
      },
      {
        key: 'vibrationsRequired',
        label: 'Vibrations Required',
        type: 'number',
        placeholder: '3',
        helper: 'Number of vibrations to trigger (2-5).',
        required: false,
        min: 2,
        max: 5,
        step: 1,
      },
      {
        key: 'detectionWindow',
        label: 'Detection Window (seconds)',
        type: 'number',
        placeholder: '20',
        helper: 'Time window for vibration detection (10-60s).',
        required: false,
        min: 10,
        max: 60,
        step: 1,
      },
      {
        key: 'autoEraseCooldown',
        label: 'Auto-Erase Cooldown (seconds)',
        type: 'number',
        placeholder: '300',
        helper: 'Cooldown between tamper attempts (300-3600s).',
        required: false,
        min: 300,
        max: 3600,
        step: 1,
      },
    ],
    examples: [
      {
        target: '@NODE_22',
        params: [],
        label: 'Use defaults (120s setup, 30s erase, 3 vibs, 20s window, 300s cooldown)',
      },
      { target: '@NODE_22', params: ['60', '30', '3', '20', '300'], label: 'Custom parameters' },
    ],
  },
  {
    name: 'AUTOERASE_DISABLE',
    group: 'Security',
    description: 'Disable auto-erase functionality.',
    defaultTarget: '@NODE_22',
    parameters: [],
    examples: [
      { target: '@NODE_22', params: [], label: 'Disable auto-erase' },
      { target: '@ALL', params: [], label: 'Disable all nodes' },
    ],
  },
  {
    name: 'AUTOERASE_STATUS',
    group: 'Security',
    description: 'Check current auto-erase configuration and state.',
    defaultTarget: '@NODE_22',
    parameters: [],
    examples: [
      { target: '@NODE_22', params: [], label: 'Check node status' },
      { target: '@ALL', params: [], label: 'Check all nodes' },
    ],
  },
  {
    name: 'HB_ON',
    group: 'Status',
    description: 'Enable periodic heartbeat broadcast over mesh.',
    defaultTarget: '@NODE_22',
    parameters: [],
  },
  {
    name: 'HB_OFF',
    group: 'Status',
    description: 'Disable heartbeat broadcast.',
    defaultTarget: '@NODE_22',
    parameters: [],
  },
  {
    name: 'HB_INTERVAL',
    group: 'Status',
    description: 'Set heartbeat interval (1-60 minutes).',
    defaultTarget: '@NODE_22',
    parameters: [
      {
        key: 'minutes',
        label: 'Interval (minutes)',
        type: 'number',
        placeholder: '5',
        required: true,
        min: 1,
        max: 60,
        suffix: 'min',
      },
    ],
    examples: [
      { target: '@NODE_22', params: ['5'] },
      { target: '@ALL', params: ['10'] },
    ],
  },
  {
    name: 'SENTINEL_ON',
    group: 'Sentinel',
    description: 'Enable the sentinel WiFi attack detector.',
    defaultTarget: '@ALL',
    parameters: [],
    examples: [{ target: '@ALL', params: [] }],
  },
  {
    name: 'SENTINEL_OFF',
    group: 'Sentinel',
    description: 'Disable the sentinel WiFi attack detector.',
    defaultTarget: '@ALL',
    parameters: [],
    examples: [{ target: '@ALL', params: [] }],
  },
  {
    name: 'SENTINEL_STATUS',
    group: 'Sentinel',
    description: 'Report sentinel enabled/running state.',
    defaultTarget: '@ALL',
    parameters: [],
    examples: [{ target: '@ALL', params: [] }],
  },
  {
    name: 'SENTINEL_MODE',
    group: 'Sentinel',
    description: 'Set sentinel mode (scan or defend).',
    defaultTarget: '@ALL',
    parameters: [
      {
        key: 'mode',
        label: 'Mode',
        type: 'select',
        required: true,
        options: [
          { label: 'Scan', value: 'scan' },
          { label: 'Defend', value: 'defend' },
        ],
      },
    ],
    examples: [{ target: '@ALL', params: ['scan'] }],
  },
  {
    name: 'SENTINEL_BOOT',
    group: 'Sentinel',
    description: 'Set whether sentinel starts automatically on boot.',
    defaultTarget: '@ALL',
    parameters: [
      {
        key: 'state',
        label: 'Boot Enable',
        type: 'select',
        required: true,
        options: [
          { label: 'On', value: 'on' },
          { label: 'Off', value: 'off' },
        ],
      },
    ],
    examples: [{ target: '@ALL', params: ['on'] }],
  },
  {
    name: 'GROUP',
    group: 'Sentinel',
    description: 'Enable or disable a sentinel detector group.',
    defaultTarget: '@ALL',
    parameters: [
      {
        key: 'name',
        label: 'Group',
        type: 'select',
        required: true,
        options: [
          { label: 'DoS', value: 'dos' },
          { label: 'Rogue AP', value: 'rogue' },
          { label: 'Recon', value: 'recon' },
          { label: 'Physical', value: 'physical' },
          { label: 'Mesh', value: 'mesh' },
          { label: 'All', value: 'all' },
        ],
      },
      {
        key: 'state',
        label: 'State',
        type: 'select',
        required: true,
        options: [
          { label: 'On', value: 'on' },
          { label: 'Off', value: 'off' },
        ],
      },
    ],
    examples: [{ target: '@ALL', params: ['dos', 'on'] }],
  },
  {
    name: 'DETECT_CFG',
    group: 'Sentinel',
    description: 'Apply detector tunables as a JSON payload.',
    defaultTarget: '@NODE_22',
    parameters: [
      {
        key: 'json',
        label: 'Config JSON',
        type: 'text',
        placeholder: '{"eviltwin":true,"pmkid":false}',
        helper: 'Valid JSON, 180 characters or fewer.',
        required: true,
      },
    ],
    examples: [{ target: '@NODE_22', params: ['{"eviltwin":true}'] }],
  },
  {
    name: 'DETECT_CFG_GET',
    group: 'Sentinel',
    description: 'Request the current detector configuration.',
    defaultTarget: '@NODE_22',
    parameters: [],
    examples: [{ target: '@NODE_22', params: [] }],
  },
  {
    name: 'INCIDENTS',
    group: 'Sentinel',
    description: 'Request the sentinel incident log (optional count).',
    defaultTarget: '@NODE_22',
    parameters: [
      {
        key: 'count',
        label: 'Count',
        type: 'number',
        placeholder: '50',
        helper: 'Optional. Between 1 and 200.',
        required: false,
        min: 1,
        max: 200,
        step: 1,
      },
    ],
    examples: [
      { target: '@NODE_22', params: [] },
      { target: '@NODE_22', params: ['50'] },
    ],
  },
  {
    name: 'INCIDENTS_CLEAR',
    group: 'Sentinel',
    description: 'Clear the sentinel incident log.',
    defaultTarget: '@NODE_22',
    parameters: [],
    examples: [{ target: '@NODE_22', params: [] }],
  },
  {
    name: 'CONFIG_DEDUP_TTL',
    group: 'Configuration',
    description: 'Set the mesh de-duplication TTL (seconds).',
    defaultTarget: '@ALL',
    parameters: [
      {
        key: 'ttl',
        label: 'TTL (seconds)',
        type: 'number',
        placeholder: '300',
        helper: 'Between 0 and 3600 seconds.',
        required: true,
        min: 0,
        max: 3600,
        step: 1,
        suffix: 'sec',
      },
    ],
    examples: [{ target: '@ALL', params: ['300'] }],
  },
  {
    name: 'CONFIG_SESSION_DEDUP',
    group: 'Configuration',
    description: 'Toggle per-session de-duplication.',
    defaultTarget: '@ALL',
    parameters: [
      {
        key: 'enabled',
        label: 'Session Dedup',
        type: 'select',
        required: true,
        options: [
          { label: 'Enabled', value: '1' },
          { label: 'Disabled', value: '0' },
        ],
      },
    ],
    examples: [{ target: '@ALL', params: ['1'] }],
  },
  {
    name: 'MESH_DEDUP_CLEAR',
    group: 'Configuration',
    description: 'Clear the mesh de-duplication cache.',
    defaultTarget: '@ALL',
    parameters: [],
    examples: [{ target: '@ALL', params: [] }],
  },
  {
    name: 'CONFIG_ERASE_PSK',
    group: 'Security',
    description: 'Set the pre-shared key used to authorize erase and factory reset.',
    defaultTarget: '@NODE_22',
    parameters: [
      {
        key: 'key',
        label: 'Pre-Shared Key',
        type: 'text',
        placeholder: 'shared-secret',
        helper: '1 to 64 characters.',
        required: true,
      },
    ],
    examples: [{ target: '@NODE_22', params: ['shared-secret'] }],
  },
  {
    name: 'FACTORY_RESET',
    group: 'Security',
    description: 'Factory reset a node (requires erase PSK credential).',
    defaultTarget: '@NODE_22',
    parameters: [
      {
        key: 'tier',
        label: 'Reset Tier',
        type: 'select',
        required: true,
        options: [
          { label: 'Full', value: 'FULL' },
          { label: 'Config', value: 'CONFIG' },
          { label: 'Data', value: 'DATA' },
        ],
      },
      {
        key: 'credential',
        label: 'Credential',
        type: 'text',
        placeholder: 'HMAC credential',
        helper: 'Authorization derived from the erase PSK.',
        required: true,
      },
    ],
  },
];

export const COMMAND_GROUP_ORDER: CommandGroup[] = [
  'Configuration',
  'Scanning',
  'Detection',
  'Sentinel',
  'Triangulation',
  'Status',
  'Security',
];
