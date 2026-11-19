export type CommandGroup =
  | 'Configuration'
  | 'Scanning'
  | 'Detection'
  | 'Sentinel'
  | 'Triangulation'
  | 'Campaign'
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
  secret?: boolean;
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
    description: 'Report node status.',
    defaultTarget: '@ALL',
    parameters: [],
    examples: [
      { target: '@ALL', params: [], label: 'All nodes' },
      { target: '@AH01', params: [], label: 'Specific node' },
    ],
  },
  {
    name: 'CONFIG_CHANNELS',
    group: 'Configuration',
    description: 'Configure WiFi channels using CSV list or range (1..14).',
    defaultTarget: '@AH01',
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
      { target: '@AH01', params: ['1,6,11'] },
      { target: '@ALL', params: ['1..14'] },
    ],
  },
  {
    name: 'CONFIG_TARGETS',
    group: 'Configuration',
    description:
      'Update target watchlist using pipe-delimited MACs, MAC prefixes, SSIDs or T- IDs.',
    defaultTarget: '@ALL',
    parameters: [
      {
        key: 'macs',
        label: 'Targets',
        type: 'text',
        placeholder: 'AA:BB:CC:DD:EE:FF|11:22:33|MyNetwork|T-1A2B',
        helper:
          'Pipe-separated: full MAC, 3-byte prefix (AA:BB:CC), SSID (up to 32 characters) or tracer ID. The whole command line must stay within 230 characters.',
        required: true,
      },
    ],
    examples: [
      {
        target: '@AH01',
        params: ['AA:BB:CC:DD:EE:FF|11:22:33:44:55:66'],
      },
    ],
  },
  {
    name: 'CONFIG_RSSI',
    group: 'Configuration',
    description: 'Set detection RSSI threshold (negative dBm).',
    defaultTarget: '@AH01',
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
    examples: [{ target: '@AH01', params: ['-65'] }],
  },
  {
    name: 'CONFIG_NODEID',
    group: 'Configuration',
    description: 'Assign a new short identifier to a node.',
    defaultTarget: '@AH01',
    parameters: [
      {
        key: 'nodeId',
        label: 'Node Identifier',
        type: 'text',
        placeholder: 'AH03',
        helper: 'Letters and numbers, 2-5 characters.',
        required: true,
      },
    ],
    examples: [{ target: '@AH01', params: ['AH03'] }],
  },
  {
    name: 'SCAN_START',
    group: 'Scanning',
    description: 'Start scanning.',
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
      { target: '@AH01', params: ['2', '300', '1..14', 'FOREVER'] },
    ],
  },
  {
    name: 'DEVICE_SCAN_START',
    group: 'Scanning',
    description: 'Start device scan for WiFi/BLE devices.',
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
      {
        key: 'channels',
        label: 'Channels (optional)',
        type: 'text',
        placeholder: 'CH1,6,11',
        helper: 'CH followed by a list or range, 1-14. Empty uses the node channel list.',
      },
    ],
    allowForever: true,
    allowProbe: true,
    examples: [
      { target: '@ALL', params: ['2', '300'] },
      { target: '@ALL', params: ['2', '300', '+PROBE'] },
      { target: '@AH01', params: ['2', '300', 'FOREVER'] },
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
      { target: '@AH01', params: ['600', 'FOREVER'] },
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
      { target: '@AH01', params: ['600', 'FOREVER'] },
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
      { target: '@AH01', params: ['300', 'FOREVER'] },
    ],
  },
  {
    name: 'RANDOMIZATION_START',
    group: 'Detection',
    description: 'Start MAC randomization detection.',
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
      { target: '@AH01', params: ['0', '600', 'FOREVER'] },
    ],
  },
  {
    name: 'PROBE_START',
    group: 'Scanning',
    description: 'Start the probe request scanner.',
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
      { target: '@AH01', params: ['0', '300', 'FOREVER'] },
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
    name: 'PCAP_START',
    group: 'Scanning',
    description: 'Record a pcap to the node SD card.',
    defaultTarget: '@ALL',
    parameters: [
      {
        key: 'radio',
        label: 'Radio',
        type: 'select',
        options: [
          { label: '0 - WiFi', value: '0' },
          { label: '1 - BLE', value: '1' },
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
      {
        key: 'band',
        label: 'Band (C5 only)',
        type: 'select',
        options: [
          { label: '0 - 2.4 GHz', value: '0' },
          { label: '1 - 5 GHz', value: '1' },
          { label: '2 - Both', value: '2' },
        ],
      },
      {
        key: 'channels',
        label: 'Channels (optional)',
        type: 'text',
        placeholder: 'CH1,6,11',
        helper: 'CH followed by a list or range, 1-177.',
      },
    ],
    examples: [
      { target: '@ALL', params: ['0', '300', '0'] },
      { target: '@AH01', params: ['1', '600'] },
    ],
  },
  {
    name: 'PCAP_STOP',
    group: 'Scanning',
    description: 'Stop the running packet capture and close the file.',
    defaultTarget: '@ALL',
    parameters: [],
    examples: [{ target: '@ALL', params: [] }],
  },
  {
    name: 'PCAP_LIMITS',
    group: 'Scanning',
    description: 'Set or query the pcap max file size (8-300 MB). Omit value to query.',
    defaultTarget: '@ALL',
    parameters: [
      {
        key: 'maxFileMB',
        label: 'Max file size (MB)',
        type: 'number',
        placeholder: '100',
        min: 8,
        max: 300,
        suffix: 'MB',
      },
    ],
    examples: [
      { target: '@ALL', params: [] },
      { target: '@AH01', params: ['100'] },
    ],
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
      { target: '@AH01', params: ['T-sensor001', '60', '3'] },
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
    defaultTarget: '@AH01',
    parameters: [],
  },
  {
    name: 'VIBRATION_STATUS',
    group: 'Security',
    description: 'Query tamper/vibration sensor status.',
    defaultTarget: '@AH01',
    parameters: [],
  },
  {
    name: 'VIBRATION_ON',
    group: 'Security',
    description: 'Enable tamper/vibration detection.',
    defaultTarget: '@AH01',
    parameters: [],
  },
  {
    name: 'VIBRATION_OFF',
    group: 'Security',
    description: 'Disable tamper/vibration detection.',
    defaultTarget: '@AH01',
    parameters: [],
  },
  {
    name: 'ERASE_REQUEST',
    group: 'Security',
    description:
      'Request a one-time erase token (valid 5 minutes, one request every 20 seconds). Admin only.',
    defaultTarget: '@AH01',
    parameters: [],
    examples: [{ target: '@AH01', params: [], label: 'Request token' }],
  },
  {
    name: 'ERASE_FORCE',
    group: 'Security',
    description:
      'Force emergency erase. Needs a fresh ERASE_REQUEST token and the node erase key. Admin only.',
    defaultTarget: '@AH01',
    parameters: [
      {
        key: 'token',
        label: 'Erase Token or Answer',
        type: 'text',
        placeholder: 'AH_0A1B2C3D_4E5F6A7B_0000012C',
        helper:
          'Token from ERASE_REQUEST (AH_ plus three hex groups), or a ready-made 8 or 64 character hex answer.',
        required: true,
      },
      {
        key: 'key',
        label: 'Erase Key',
        type: 'text',
        secret: true,
        helper:
          'Used locally to compute the answer. Not stored. Leave empty if you pasted an answer.',
      },
    ],
  },
  {
    name: 'ERASE_CANCEL',
    group: 'Security',
    description:
      'Cancel a tamper erase countdown. Needs a fresh ERASE_REQUEST token and the node erase key. Admin only.',
    defaultTarget: '@AH01',
    parameters: [
      {
        key: 'token',
        label: 'Erase Token or Answer',
        type: 'text',
        placeholder: 'AH_0A1B2C3D_4E5F6A7B_0000012C',
        helper: 'Token from ERASE_REQUEST, or a ready-made 8 or 64 character hex answer.',
        required: true,
      },
      {
        key: 'key',
        label: 'Erase Key',
        type: 'text',
        secret: true,
        helper:
          'Used locally to compute the answer. Not stored. Leave empty if you pasted an answer.',
      },
    ],
  },
  {
    name: 'AUTOERASE_ENABLE',
    group: 'Security',
    description: 'Enable auto-erase with optional custom parameters',
    defaultTarget: '@AH01',
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
      {
        key: 'token',
        label: 'Erase Token or Answer',
        type: 'text',
        placeholder: 'AH_0A1B2C3D_4E5F6A7B_0000012C',
        helper:
          'Token from ERASE_REQUEST, or a ready-made 8 or 64 character hex answer. Fill all five timings or none.',
        required: true,
      },
      {
        key: 'key',
        label: 'Erase Key',
        type: 'text',
        secret: true,
        helper:
          'Used locally to compute the answer. Not stored. Leave empty if you pasted an answer.',
      },
    ],
    examples: [
      {
        target: '@AH01',
        params: [],
        label:
          'Keep stored timings (default 120s setup, 30s erase, 3 vibs, 20s window, 300s cooldown)',
      },
    ],
  },
  {
    name: 'AUTOERASE_DISABLE',
    group: 'Security',
    description:
      'Disable auto-erase. Needs a fresh ERASE_REQUEST token and the erase key. Admin only.',
    defaultTarget: '@AH01',
    parameters: [
      {
        key: 'token',
        label: 'Erase Token or Answer',
        type: 'text',
        placeholder: 'AH_0A1B2C3D_4E5F6A7B_0000012C',
        helper: 'Token from ERASE_REQUEST, or a ready-made 8 or 64 character hex answer.',
        required: true,
      },
      {
        key: 'key',
        label: 'Erase Key',
        type: 'text',
        secret: true,
        helper:
          'Used locally to compute the answer. Not stored. Leave empty if you pasted an answer.',
      },
    ],
    examples: [{ target: '@AH01', params: [], label: 'Disable auto-erase' }],
  },
  {
    name: 'AUTOERASE_STATUS',
    group: 'Security',
    description: 'Check current auto-erase configuration and state.',
    defaultTarget: '@AH01',
    parameters: [],
    examples: [
      { target: '@AH01', params: [], label: 'Check node status' },
      { target: '@ALL', params: [], label: 'Check all nodes' },
    ],
  },
  {
    name: 'HB_ON',
    group: 'Status',
    description: 'Enable periodic heartbeat broadcast over mesh.',
    defaultTarget: '@AH01',
    parameters: [],
  },
  {
    name: 'HB_OFF',
    group: 'Status',
    description: 'Disable heartbeat broadcast.',
    defaultTarget: '@AH01',
    parameters: [],
  },
  {
    name: 'HB_INTERVAL',
    group: 'Status',
    description: 'Set heartbeat interval (1-60 minutes).',
    defaultTarget: '@AH01',
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
      { target: '@AH01', params: ['5'] },
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
          { label: 'Mesh Radios', value: 'devices' },
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
    defaultTarget: '@AH01',
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
    examples: [{ target: '@AH01', params: ['{"eviltwin":true}'] }],
  },
  {
    name: 'DETECT_CFG_GET',
    group: 'Sentinel',
    description: 'Request the current detector configuration.',
    defaultTarget: '@AH01',
    parameters: [],
    examples: [{ target: '@AH01', params: [] }],
  },
  {
    name: 'INCIDENTS',
    group: 'Sentinel',
    description: 'Request the sentinel incident log (optional count).',
    defaultTarget: '@AH01',
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
      { target: '@AH01', params: [] },
      { target: '@AH01', params: ['50'] },
    ],
  },
  {
    name: 'INCIDENTS_CLEAR',
    group: 'Sentinel',
    description: 'Clear the sentinel incident log.',
    defaultTarget: '@AH01',
    parameters: [],
    examples: [{ target: '@AH01', params: [] }],
  },
  {
    name: 'CSI_MOTION_START',
    group: 'Sentinel',
    description: 'Start CSI motion detection.',
    defaultTarget: '@AH01',
    parameters: [
      {
        key: 'secs',
        label: 'Duration (seconds)',
        type: 'number',
        placeholder: '300',
        helper: '0-86400. Use 0 with FOREVER.',
        required: true,
        min: 0,
        max: 86400,
        step: 1,
        suffix: 'sec',
      },
      {
        key: 'forever',
        label: 'Forever',
        type: 'select',
        required: false,
        options: [
          { label: 'No', value: '' },
          { label: 'Yes', value: 'FOREVER' },
        ],
      },
      {
        key: 'channel',
        label: 'Channel',
        type: 'text',
        placeholder: 'CH6',
        helper: 'Optional. CH0 = auto survey, CH1-CH14 pins the channel.',
        required: false,
      },
    ],
    examples: [
      { target: '@AH01', params: ['300'] },
      { target: '@ALL', params: ['0', 'FOREVER'] },
    ],
  },
  {
    name: 'CSI_STATUS',
    group: 'Sentinel',
    description: 'Print the CSI report on the node.',
    defaultTarget: '@AH01',
    parameters: [],
    examples: [{ target: '@AH01', params: [] }],
  },
  {
    name: 'CSI_JSON',
    group: 'Sentinel',
    description: 'Print the CSI JSON state on the node.',
    defaultTarget: '@AH01',
    parameters: [],
    examples: [{ target: '@AH01', params: [] }],
  },
  {
    name: 'CSI_RECAL',
    group: 'Sentinel',
    description: 'Reset the CSI threshold override to the firmware default.',
    defaultTarget: '@AH01',
    parameters: [],
    examples: [{ target: '@AH01', params: [] }],
  },
  {
    name: 'CSI_EXCLUDE',
    group: 'Sentinel',
    description: 'Exclude a transmitter MAC from CSI.',
    defaultTarget: '@AH01',
    parameters: [
      {
        key: 'mac',
        label: 'MAC or NONE',
        type: 'text',
        placeholder: 'AA:BB:CC:DD:EE:FF',
        required: true,
      },
    ],
    examples: [
      { target: '@AH01', params: ['AA:BB:CC:DD:EE:FF'] },
      { target: '@AH01', params: ['NONE'] },
    ],
  },
  {
    name: 'CSI_CFG',
    group: 'Sentinel',
    description: 'Set a CSI motion setting.',
    defaultTarget: '@ALL',
    parameters: [
      {
        key: 'setting',
        label: 'Setting',
        type: 'text',
        placeholder: 'SENSITIVITY=MEDIUM',
        required: true,
      },
    ],
    examples: [
      { target: '@ALL', params: ['SENSITIVITY=LOW'] },
      { target: '@AH01', params: ['CLEAR_AFTER=10'] },
    ],
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
    name: 'CONFIG_BAND',
    group: 'Configuration',
    description: 'Set the radio band on an ESP32-C5 node (Experimental build only).',
    defaultTarget: '@ALL',
    parameters: [
      {
        key: 'band',
        label: 'Band',
        type: 'select',
        required: true,
        options: [
          { label: '0 - 2.4 GHz', value: '0' },
          { label: '1 - 5 GHz', value: '1' },
          { label: '2 - Both', value: '2' },
        ],
      },
    ],
    examples: [{ target: '@NODE_22', params: ['2'] }],
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
    description:
      'Change the erase key. Admin only. The new key travels in clear text over the mesh.',
    defaultTarget: '@AH01',
    parameters: [
      {
        key: 'newKey',
        label: 'New Erase Key',
        type: 'text',
        secret: true,
        helper: '8 to 64 characters, no colon.',
        required: true,
      },
      {
        key: 'token',
        label: 'Erase Token (optional)',
        type: 'text',
        placeholder: 'AH_0A1B2C3D_4E5F6A7B_0000012C',
        helper:
          'Token from ERASE_REQUEST. With a token the current key is turned into an answer locally instead of being sent in clear text.',
      },
      {
        key: 'currentKey',
        label: 'Current Erase Key',
        type: 'text',
        secret: true,
        helper: 'Not stored.',
        required: true,
      },
    ],
  },
  {
    name: 'FACTORY_RESET',
    group: 'Security',
    description:
      'Factory reset a node. Needs a fresh ERASE_REQUEST token and the node erase key. Admin only.',
    defaultTarget: '@AH01',
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
        key: 'token',
        label: 'Erase Token or Answer',
        type: 'text',
        placeholder: 'AH_0A1B2C3D_4E5F6A7B_0000012C',
        helper: 'Token from ERASE_REQUEST, or a ready-made 8 or 64 character hex answer.',
        required: true,
      },
      {
        key: 'key',
        label: 'Erase Key',
        type: 'text',
        secret: true,
        helper:
          'Used locally to compute the answer. Not stored. Leave empty if you pasted an answer.',
      },
    ],
  },
  {
    name: 'SUMMARY',
    group: 'Status',
    description: 'Report device count, target count, hits, incidents, campaign and uptime.',
    defaultTarget: '@ALL',
    parameters: [],
    examples: [{ target: '@ALL', params: [] }],
  },
  {
    name: 'MESH_TX_CANCEL',
    group: 'Status',
    description: 'Drop queued mesh messages except triangulation. A running scan continues.',
    defaultTarget: '@ALL',
    parameters: [],
  },
  {
    name: 'BLE_CLASSIFY',
    group: 'Configuration',
    description: 'Turn BLE device classification on or off.',
    defaultTarget: '@ALL',
    parameters: [
      {
        key: 'enabled',
        label: 'BLE Classification',
        type: 'select',
        required: true,
        options: [
          { label: 'On', value: '1' },
          { label: 'Off', value: '0' },
        ],
      },
    ],
    examples: [{ target: '@ALL', params: ['1'] }],
  },
  {
    name: 'BLE_LONGRANGE',
    group: 'Configuration',
    description:
      'Also listen for Bluetooth 5 long range. Ordinary BLE gets less listening time. Off by default.',
    defaultTarget: '@ALL',
    parameters: [
      {
        key: 'enabled',
        label: 'BLE Long Range',
        type: 'select',
        required: true,
        options: [
          { label: 'On', value: '1' },
          { label: 'Off', value: '0' },
        ],
      },
    ],
    examples: [{ target: '@ALL', params: ['0'] }],
  },
  {
    name: 'CAMPAIGN_START',
    group: 'Configuration',
    description: 'Start a named campaign. Logged events carry the name. Ends a running campaign.',
    defaultTarget: '@ALL',
    parameters: [
      {
        key: 'name',
        label: 'Campaign Name',
        type: 'text',
        placeholder: 'site-a',
        helper: 'Letters, digits, "-" and "_", 1-23 characters.',
        required: true,
      },
    ],
    examples: [{ target: '@ALL', params: ['site-a'] }],
  },
  {
    name: 'CAMPAIGN_STOP',
    group: 'Configuration',
    description: 'End the running campaign.',
    defaultTarget: '@ALL',
    parameters: [],
  },
  {
    name: 'CAMPAIGN_STATUS',
    group: 'Configuration',
    description: 'Report the running campaign.',
    defaultTarget: '@ALL',
    parameters: [],
  },
  {
    name: 'DEVICE_DB_CLEAR',
    group: 'Configuration',
    description: 'Delete the node device database.',
    defaultTarget: '@AH01',
    parameters: [],
  },
  {
    name: 'PROBE_DB_CLEAR',
    group: 'Configuration',
    description: 'Delete the node probe database.',
    defaultTarget: '@AH01',
    parameters: [],
  },
  {
    name: 'BASELINE_WATCH',
    group: 'Detection',
    description:
      'Mark the current moment in a running baseline. The node reports New/Gone/Moved/Both when it ends.',
    defaultTarget: '@ALL',
    parameters: [],
  },
  {
    name: 'BASELINE_RESET',
    group: 'Detection',
    description: 'Delete the learned baseline from memory and SD. Refused while a scan runs.',
    defaultTarget: '@AH01',
    parameters: [],
  },
  {
    name: 'RANDOMIZATION_RESET',
    group: 'Detection',
    description: 'Delete saved randomized-MAC identities. Refused while a scan runs.',
    defaultTarget: '@AH01',
    parameters: [],
  },
  {
    name: 'PCAP_AUTO',
    group: 'Scanning',
    description:
      'Set or query the SD space for captures Sentinel starts after an attack. Omit the value to query.',
    defaultTarget: '@AH01',
    parameters: [
      {
        key: 'limits',
        label: 'Budget,Floor (MB)',
        type: 'text',
        placeholder: '512,256',
        helper: 'budgetMB 16-262144, floorMB 0-262144.',
      },
    ],
    examples: [{ target: '@AH01', params: ['512,256'] }],
  },
  {
    name: 'SD_REPAIR',
    group: 'Configuration',
    description: 'Control SD card auto-repair. A repair erases the card. Omit the value to query.',
    defaultTarget: '@AH01',
    parameters: [
      {
        key: 'mode',
        label: 'Mode',
        type: 'select',
        options: [
          { label: 'Query', value: '' },
          { label: 'ON - rebuild an unmountable card', value: 'ON' },
          { label: 'OFF - never rebuild', value: 'OFF' },
          { label: 'NOW - remount, rebuild only if mounting fails', value: 'NOW' },
        ],
      },
    ],
  },
  {
    name: 'SCHED_ADD',
    group: 'Scanning',
    description: 'Add a scheduled scan. The node needs a known time (GPS, RTC or web UI visit).',
    defaultTarget: '@AH01',
    parameters: [
      {
        key: 'block',
        label: 'Schedule Block',
        type: 'text',
        placeholder: '2030-01-01T02:00|86400|/scan|mode=2&secs=600',
        helper:
          'start (node local time YYYY-MM-DDTHH:MM) | repeat seconds (0 or 600-2678400) | route (/scan, /sniffer or /drone) | options joined with &.',
        required: true,
      },
    ],
    examples: [{ target: '@AH01', params: ['2030-01-01T02:00|86400|/scan|mode=2&secs=600'] }],
  },
  {
    name: 'SCHED_LIST',
    group: 'Scanning',
    description: 'Count scheduled scans. The node prints the list on its USB serial port.',
    defaultTarget: '@AH01',
    parameters: [],
  },
  {
    name: 'SCHED_DEL',
    group: 'Scanning',
    description: 'Delete one scheduled scan by its position in SCHED_LIST.',
    defaultTarget: '@AH01',
    parameters: [
      {
        key: 'position',
        label: 'Position',
        type: 'number',
        placeholder: '1',
        required: true,
        min: 1,
        step: 1,
      },
    ],
    examples: [{ target: '@AH01', params: ['1'] }],
  },
  {
    name: 'CALIBRATE',
    group: 'Triangulation',
    description:
      'Calibrate distance estimates against a reference device placed at a measured distance (30 second listen).',
    defaultTarget: '@AH01',
    parameters: [
      {
        key: 'mac',
        label: 'Reference MAC',
        type: 'text',
        placeholder: 'AA:BB:CC:DD:EE:FF',
        required: true,
      },
      {
        key: 'meters',
        label: 'Distance (meters)',
        type: 'text',
        placeholder: '5',
        helper: '0.5 to 100.',
        required: true,
      },
    ],
    examples: [{ target: '@AH01', params: ['AA:BB:CC:DD:EE:FF', '5'] }],
  },
  {
    name: 'CALIBRATE_RESET',
    group: 'Triangulation',
    description: 'Clear the calibration. Distances go back to the RF environment values.',
    defaultTarget: '@AH01',
    parameters: [],
  },
  {
    name: 'VIBSCAN_SET',
    group: 'Detection',
    description: 'Start a scan automatically when the node is moved.',
    defaultTarget: '@AH01',
    parameters: [
      {
        key: 'on',
        label: 'Movement Scan',
        type: 'select',
        required: true,
        options: [
          { label: 'On', value: '1' },
          { label: 'Off', value: '0' },
        ],
      },
      {
        key: 'scan',
        label: 'Scan',
        type: 'select',
        required: true,
        options: [
          { label: '0 - None', value: '0' },
          { label: '1 - Device discovery', value: '1' },
          { label: '2 - Probe', value: '2' },
          { label: '3 - Randomized MAC tracer', value: '3' },
          { label: '4 - Target scan (channels 1-11)', value: '4' },
          { label: '5 - Drone', value: '5' },
          { label: '6 - Deauth', value: '6' },
          { label: '7 - Baseline', value: '7' },
          { label: '8 - Packet capture (needs a length)', value: '8' },
        ],
      },
      {
        key: 'secs',
        label: 'Scan Length (seconds)',
        type: 'number',
        placeholder: '60',
        required: true,
        min: 0,
        max: 65535,
        step: 1,
        suffix: 'sec',
      },
      {
        key: 'cooldown',
        label: 'Cooldown (seconds)',
        type: 'number',
        placeholder: '300',
        helper: '5-86400. Empty keeps the current value.',
        min: 5,
        max: 86400,
        step: 1,
        suffix: 'sec',
      },
      {
        key: 'interrupt',
        label: 'Interrupt Scheduled Scan',
        type: 'select',
        options: [
          { label: 'Keep current', value: '' },
          { label: 'No', value: '0' },
          { label: 'Yes', value: '1' },
        ],
        helper: 'Needs a cooldown value.',
      },
    ],
    examples: [{ target: '@AH01', params: ['1', '2', '60', '300'] }],
  },
  {
    name: 'VIBSCAN_STATUS',
    group: 'Detection',
    description: 'Report the movement-scan settings.',
    defaultTarget: '@AH01',
    parameters: [],
  },
  {
    name: 'DETECT_CLEAR',
    group: 'Sentinel',
    description: 'Clear all detector state and delete the detector logs on SD.',
    defaultTarget: '@AH01',
    parameters: [],
  },
  {
    name: 'DETECT_COUNTS',
    group: 'Sentinel',
    description: 'Report internal detector counters.',
    defaultTarget: '@AH01',
    parameters: [],
  },
  {
    name: 'RADIO_KNOWN_ADD',
    group: 'Sentinel',
    description: 'Mark a Meshtastic or MeshCore radio as known. The node stops alerting on it.',
    defaultTarget: '@ALL',
    parameters: [
      {
        key: 'mac',
        label: 'Radio MAC',
        type: 'text',
        placeholder: 'AA:BB:CC:DD:EE:FF',
        required: true,
      },
      {
        key: 'type',
        label: 'Radio Type',
        type: 'select',
        required: true,
        options: [
          { label: 'Meshtastic', value: 'Meshtastic' },
          { label: 'MeshCore', value: 'MeshCore' },
        ],
      },
      {
        key: 'name',
        label: 'Bluetooth Name (optional)',
        type: 'text',
        helper: 'Up to 31 characters. Empty uses the name the node last saw.',
      },
    ],
    examples: [{ target: '@ALL', params: ['AA:BB:CC:DD:EE:FF', 'Meshtastic'] }],
  },
  {
    name: 'RADIO_KNOWN_DEL',
    group: 'Sentinel',
    description: 'Remove a radio from the known list.',
    defaultTarget: '@ALL',
    parameters: [
      {
        key: 'mac',
        label: 'Radio MAC',
        type: 'text',
        placeholder: 'AA:BB:CC:DD:EE:FF',
        required: true,
      },
    ],
    examples: [{ target: '@ALL', params: ['AA:BB:CC:DD:EE:FF'] }],
  },
  {
    name: 'RADIO_KNOWN_CLEAR',
    group: 'Sentinel',
    description: 'Empty the known radio list.',
    defaultTarget: '@AH01',
    parameters: [],
  },
  {
    name: 'SELF_RADIO_SET',
    group: 'Sentinel',
    description: 'Set the Bluetooth name prefix of the node own radio so it stops alerting on it.',
    defaultTarget: '@AH01',
    parameters: [
      {
        key: 'prefix',
        label: 'Name Prefix',
        type: 'text',
        placeholder: 'Meshtastic',
        helper: '1 to 12 characters, no spaces.',
        required: true,
      },
    ],
    examples: [{ target: '@AH01', params: ['Meshtastic'] }],
  },
  {
    name: 'SELF_RADIO_CLEAR',
    group: 'Sentinel',
    description: 'Forget the own-radio prefix.',
    defaultTarget: '@AH01',
    parameters: [],
  },
  {
    name: 'SELF_RADIO_GET',
    group: 'Sentinel',
    description: 'Report the own-radio prefix.',
    defaultTarget: '@AH01',
    parameters: [],
  },
  {
    name: 'ATTACKER_TRILAT',
    group: 'Sentinel',
    description: 'Turn on locating the source of a confirmed attack by triangulation.',
    defaultTarget: '@ALL',
    parameters: [
      {
        key: 'enabled',
        label: 'Attacker Triangulation',
        type: 'select',
        required: true,
        options: [
          { label: 'On', value: '1' },
          { label: 'Off', value: '0' },
        ],
      },
    ],
    examples: [{ target: '@ALL', params: ['1'] }],
  },
  {
    name: 'ATTACKER_TRILAT_STATUS',
    group: 'Sentinel',
    description: 'Report the attacker triangulation setting.',
    defaultTarget: '@AH01',
    parameters: [],
  },
  {
    name: 'BATTERY_SAVER_START',
    group: 'Status',
    description: 'Start battery saver with heartbeat interval (minutes).',
    defaultTarget: '@NODE_22',
    parameters: [
      {
        key: 'minutes',
        label: 'Interval (minutes)',
        type: 'number',
        placeholder: '10',
        required: true,
        min: 1,
        max: 30,
        suffix: 'min',
      },
    ],
    examples: [{ target: '@NODE_22', params: ['10'] }],
  },
  {
    name: 'BATTERY_SAVER_STOP',
    group: 'Status',
    description: 'Stop battery saver.',
    defaultTarget: '@NODE_22',
    parameters: [],
  },
  {
    name: 'BATTERY_SAVER_STATUS',
    group: 'Status',
    description: 'Report battery saver state.',
    defaultTarget: '@NODE_22',
    parameters: [],
  },
];

export const COMMAND_GROUP_ORDER: CommandGroup[] = [
  'Configuration',
  'Scanning',
  'Detection',
  'Sentinel',
  'Triangulation',
  'Campaign',
  'Status',
  'Security',
];
