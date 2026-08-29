import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChangeEvent, FormEvent, ReactNode, useEffect, useMemo, useRef, useState } from 'react';

import { WebhooksSection } from './WebhooksSection';
import { apiClient } from '../api/client';
import type {
  AlarmConfig,
  AlarmLevel,
  AlarmSoundKey,
  AppSettings,
  AuthUser,
  UserAlertColors,
  SerialConfig,
  SerialPortInfo,
  SerialState,
  SiteSummary,
  MqttSiteConfig,
  MqttStatusState,
  MqttSiteStatus,
  MqttTestResponse,
  TakConfig,
  TakProtocol,
  RuntimeConfig,
  FirewallOverview,
  FirewallPolicy,
  FirewallGeoMode,
  FirewallLog,
  FirewallRule,
  FaaRegistryStatusResponse,
  StartFaaSyncResponse,
} from '../api/types';
import { applyAlertOverrides, extractAlertColors } from '../constants/alert-colors';
import {
  THEME_PRESETS,
  resolveThemePalette,
  type ThemePresetId,
  type ThemePalette,
} from '../constants/theme';
import { useAlarm } from '../providers/alarm-provider';
import { useSocket } from '../providers/socket-provider';
import { useAuthStore } from '../stores/auth-store';
import { useChatKeyStore } from '../stores/chat-key-store';
import { useChatStore } from '../stores/chat-store';
import { useNodeStore } from '../stores/node-store';

type AppSettingsUpdate = Partial<AppSettings> & { mailPassword?: string };
type MqttNotice = { type: 'success' | 'error' | 'info'; text: string } | null;

interface UpdateInfo {
  available: boolean;
  currentCommit: string;
  currentBranch?: string;
  remote?: string;
  remoteBranch?: string;
  latestCommit?: string;
  commitsBehind?: number;
  commitsAhead?: number;
  lastCommitMessage?: string;
  lastCommitDate?: string;
  lastCommitAuthor?: string;
  localCommitMessage?: string;
  localCommitDate?: string;
  localCommitAuthor?: string;
  remoteCommitMessage?: string;
  remoteCommitDate?: string;
  remoteCommitAuthor?: string;
  lastCheckAt: string;
  canUpdate: boolean;
  blockers?: string[];
  warning?: string;
}

interface GitRemote {
  name: string;
  url: string;
  isDefault: boolean;
}

interface DatabaseStatus {
  state: 'up-to-date' | 'pending' | 'failed' | 'unreachable' | 'unknown';
  message: string;
  migrationsFound?: number;
  pendingMigrations: string[];
  failedMigrations: string[];
  actionRequired: boolean;
  appliedDuringUpdate: boolean;
  manualCommand?: string;
  details?: string;
}

interface UpdateLog {
  id: string;
  fromCommit: string;
  toCommit: string | null;
  status: string;
  phase: string | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  durationSeconds: number | null;
  triggeredBy: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
  };
}

const LEVEL_METADATA: Record<AlarmLevel, { label: string; description: string }> = {
  INFO: { label: 'Info', description: 'Low priority notifications (status updates).' },
  NOTICE: { label: 'Notice', description: 'Important events, like new targets.' },
  ALERT: { label: 'Alert', description: 'Actionable events requiring attention.' },
  CRITICAL: { label: 'Critical', description: 'Safety or erase events that must be acknowledged.' },
};

const DRONE_GEOFENCE_SOUND_KEY: AlarmSoundKey = 'DRONE_GEOFENCE';
const DRONE_TELEMETRY_SOUND_KEY: AlarmSoundKey = 'DRONE_TELEMETRY';

const GAPS: Array<{ key: keyof AlarmConfig; label: string }> = [
  { key: 'gapInfoMs', label: 'Info gap (ms)' },
  { key: 'gapNoticeMs', label: 'Notice gap (ms)' },
  { key: 'gapAlertMs', label: 'Alert gap (ms)' },
  { key: 'gapCriticalMs', label: 'Critical gap (ms)' },
];

const DETECTION_MODE_OPTIONS = [
  { value: 2, label: 'WiFi + BLE' },
  { value: 0, label: 'WiFi Only' },
  { value: 1, label: 'BLE Only' },
];

const TAK_PROTOCOL_OPTIONS: TakProtocol[] = ['UDP', 'TCP', 'HTTPS'];

const DEFAULT_RADIUS_LIMITS = {
  min: 50,
  max: 2000,
};

const FAA_DATASET_URL = 'https://registry.faa.gov/database/ReleasableAircraft.zip';

type SerialConnectPayload = {
  path?: string;
  baudRate?: number;
  delimiter?: string;
  protocol?: string;
};

const PROTOCOL_OPTIONS = [
  { value: 'meshtastic-rewrite', label: 'Meshtastic Ingest' },
  { value: 'raw-lines', label: 'Raw Lines' },
  { value: 'nmea-like', label: 'NMEA-like' },
];

const ALERT_COLOR_FIELDS = [
  {
    key: 'alertColorIdle',
    previewKey: 'idle',
    label: 'Idle',
    description: 'Default marker and radius color when no alarms are active.',
  },
  {
    key: 'alertColorInfo',
    previewKey: 'info',
    label: 'Info',
    description: 'Low priority status updates and heartbeat events.',
  },
  {
    key: 'alertColorNotice',
    previewKey: 'notice',
    label: 'Notice',
    description: 'Important events such as new targets or triangulation results.',
  },
  {
    key: 'alertColorAlert',
    previewKey: 'alert',
    label: 'Alert',
    description: 'Actionable events that should prompt operator attention.',
  },
  {
    key: 'alertColorCritical',
    previewKey: 'critical',
    label: 'Critical',
    description: 'Safety-sensitive events such as erase operations or tamper alerts.',
  },
] as const;

type AlertColorFieldKey = (typeof ALERT_COLOR_FIELDS)[number]['key'];
type AlertColorUpdate = Partial<Record<AlertColorFieldKey, string | null>>;

const alertOverrideValueForKey = (
  overrides: UserAlertColors | null,
  key: AlertColorFieldKey,
): string | null => {
  if (!overrides) {
    return null;
  }
  switch (key) {
    case 'alertColorIdle':
      return overrides.idle ?? null;
    case 'alertColorInfo':
      return overrides.info ?? null;
    case 'alertColorNotice':
      return overrides.notice ?? null;
    case 'alertColorAlert':
      return overrides.alert ?? null;
    case 'alertColorCritical':
      return overrides.critical ?? null;
    default:
      return null;
  }
};

const PARITY_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'even', label: 'Even' },
  { value: 'odd', label: 'Odd' },
];

const STOP_BITS_OPTIONS = [
  { value: 1, label: '1' },
  { value: 2, label: '2' },
];

const DEFAULT_ALARM_CONFIG: AlarmConfig = {
  audioPack: 'default',
  volumeInfo: 60,
  volumeNotice: 70,
  volumeAlert: 80,
  volumeCritical: 90,
  volumeDroneGeofence: 80,
  volumeDroneTelemetry: 80,
  gapInfoMs: 1000,
  gapNoticeMs: 1500,
  gapAlertMs: 2000,
  gapCriticalMs: 0,
  dndStart: null,
  dndEnd: null,
  backgroundAllowed: false,
};

interface FirewallFormState {
  enabled: boolean;
  defaultPolicy: FirewallPolicy;
  geoMode: FirewallGeoMode;
  allowedCountries: string;
  blockedCountries: string;
  ipAllowList: string;
  ipBlockList: string;
  failThreshold: string;
  failWindowSeconds: string;
  banDurationSeconds: string;
}

type FirewallUpdatePayload = Partial<{
  enabled: boolean;
  defaultPolicy: FirewallPolicy;
  geoMode: FirewallGeoMode;
  allowedCountries: string[];
  blockedCountries: string[];
  ipAllowList: string[];
  ipBlockList: string[];
  failThreshold: number;
  failWindowSeconds: number;
  banDurationSeconds: number;
}>;

type ConfigSectionId =
  | 'alarms'
  | 'mail'
  | 'security'
  | 'appearance'
  | 'sites'
  | 'serial'
  | 'tak'
  | 'mqtt'
  | 'chat'
  | 'detection'
  | 'map'
  | 'oui'
  | 'firewall'
  | 'webhooks'
  | 'faa'
  | 'system-updates';

const CONFIG_SECTIONS: Array<{ id: ConfigSectionId; label: string; description: string }> = [
  { id: 'alarms', label: 'Alarms', description: 'Audio profiles & cooldowns' },
  { id: 'mail', label: 'Mail Server', description: 'Outbound email delivery' },
  { id: 'security', label: 'Security Defaults', description: 'Authentication requirements' },
  {
    id: 'appearance',
    label: 'Theme & Colors',
    description: 'Interface palette and marker styling',
  },
  { id: 'firewall', label: 'Firewall', description: 'Geo/IP policies & lockouts' },
  { id: 'sites', label: 'Sites', description: 'Site names, regions, and colors' },
  { id: 'serial', label: 'Serial Connection', description: 'Device path and protocol' },
  { id: 'tak', label: 'TAK Bridge', description: 'Cursor-on-Target relay' },
  { id: 'mqtt', label: 'MQTT Federation', description: 'Remote site replication' },
  { id: 'chat', label: 'Chat', description: 'Encrypted operator chat keys' },
  { id: 'detection', label: 'Detection Defaults', description: 'Scan and alert presets' },
  { id: 'webhooks', label: 'Webhooks', description: 'External alert destinations' },
  { id: 'map', label: 'Map & Coverage', description: 'Map viewport and coverage rings' },
  { id: 'oui', label: 'OUI Resolver', description: 'Vendor cache imports & exports' },
  { id: 'faa', label: 'FAA Registry', description: 'Aircraft registry enrichment' },
  { id: 'system-updates', label: 'System Updates', description: 'Monitor and deploy updates' },
];

export function ConfigPage() {
  const queryClient = useQueryClient();
  const socket = useSocket();

  const updateNodeSiteMeta = useNodeStore((state) => state.updateSiteMeta);
  const {
    settings: alarmSettings,
    isLoading: alarmLoading,
    updateConfig: updateAlarmConfig,
    uploadSound,
    removeSound,
    play,
    playDroneGeofence,
    playDroneTelemetry,
  } = useAlarm();

  const authUser = useAuthStore((state) => state.user);
  const setAuthUser = useAuthStore((state) => state.setUser);
  const themePreset: ThemePresetId = authUser?.preferences?.themePreset ?? 'classic';

  const appSettingsQuery = useQuery({
    queryKey: ['appSettings'],
    queryFn: () => apiClient.get<AppSettings>('/config/app'),
  });

  const serialConfigQuery = useQuery({
    queryKey: ['serialConfig'],
    queryFn: () => apiClient.get<SerialConfig>('/serial/config'),
  });
  const serialStateQuery = useQuery({
    queryKey: ['serialState'],
    queryFn: () => apiClient.get<SerialState>('/serial/state'),
    refetchInterval: 5000,
  });

  const serialPortsQuery = useQuery({
    queryKey: ['serialPorts'],
    queryFn: () => apiClient.get<SerialPortInfo[]>('/serial/ports'),
    staleTime: 30_000,
  });

  const sitesQuery = useQuery({
    queryKey: ['sites'],
    queryFn: () => apiClient.get<SiteSummary[]>('/sites'),
  });
  const mqttSitesQuery = useQuery({
    queryKey: ['mqttSites'],
    queryFn: () => apiClient.get<MqttSiteConfig[]>('/mqtt/sites'),
  });
  const chatAddonEnabled =
    useAuthStore((state) => state.user?.preferences?.notifications?.addons?.chat ?? false) ?? false;
  const [activeSection, setActiveSection] = useState<ConfigSectionId>('alarms');
  const visibleSections = useMemo(
    () => (chatAddonEnabled ? CONFIG_SECTIONS : CONFIG_SECTIONS.filter((s) => s.id !== 'chat')),
    [chatAddonEnabled],
  );

  useEffect(() => {
    if (!chatAddonEnabled && activeSection === 'chat') {
      setActiveSection('alarms');
    }
  }, [chatAddonEnabled, activeSection]);

  const mqttStatusQuery = useQuery({
    queryKey: ['mqttStatus'],
    queryFn: () => apiClient.get<MqttSiteStatus[]>('/mqtt/sites-status'),
    refetchInterval: 15_000,
  });

  const takConfigQuery = useQuery({
    queryKey: ['takConfig'],
    queryFn: () => apiClient.get<TakConfig>('/tak/config'),
  });

  const runtimeConfigQuery = useQuery({
    queryKey: ['runtimeConfig'],
    queryFn: () => apiClient.get<RuntimeConfig>('/config/runtime'),
    staleTime: 60_000,
  });

  const firewallOverviewQuery = useQuery({
    queryKey: ['firewall', 'overview'],
    queryFn: () => apiClient.get<FirewallOverview>('/config/firewall'),
    staleTime: 60_000,
  });

  const faaStatusQuery = useQuery<FaaRegistryStatusResponse>({
    queryKey: ['faaStatus'],
    queryFn: () => apiClient.get<FaaRegistryStatusResponse>('/config/faa/status'),
    refetchInterval: (query) => (query.state.data?.inProgress ? 5000 : false),
  });
  const { refetch: refetchFaaStatus } = faaStatusQuery;

  const ouiStatsQuery = useQuery({
    queryKey: ['ouiStats'],
    queryFn: () => apiClient.get<{ total: number; lastUpdated?: string | null }>('/oui/stats'),
  });

  const isAdmin = authUser?.role === 'ADMIN';

  const [selectedRemote, setSelectedRemote] = useState('');
  const [selectedBranch, setSelectedBranch] = useState('');

  const { data: gitRemotes } = useQuery({
    queryKey: ['updates', 'remotes'],
    queryFn: async () => {
      return await apiClient.get<GitRemote[]>('/updates/remotes');
    },
    enabled: isAdmin,
  });

  const { data: gitBranches } = useQuery({
    queryKey: ['updates', 'branches', selectedRemote],
    queryFn: async () => {
      const query = selectedRemote ? `?remote=${encodeURIComponent(selectedRemote)}` : '';
      return await apiClient.get<string[]>(`/updates/branches${query}`);
    },
    enabled: isAdmin,
  });

  const {
    data: updateInfo,
    isLoading: isCheckingUpdates,
    refetch: checkForUpdates,
  } = useQuery({
    queryKey: ['updates', 'check', selectedRemote, selectedBranch],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (selectedRemote) params.set('remote', selectedRemote);
      if (selectedBranch) params.set('branch', selectedBranch);
      const query = params.toString();
      return await apiClient.get<UpdateInfo>(`/updates/check${query ? `?${query}` : ''}`);
    },
    enabled: isAdmin,
    refetchInterval: false,
  });

  const { data: databaseStatus, refetch: refetchDatabaseStatus } = useQuery({
    queryKey: ['updates', 'database'],
    queryFn: async () => {
      return await apiClient.get<DatabaseStatus>('/updates/database');
    },
    enabled: isAdmin,
    refetchInterval: false,
  });

  const { data: updateHistory } = useQuery({
    queryKey: ['updates', 'history'],
    queryFn: async () => {
      return await apiClient.get<UpdateLog[]>('/updates/history');
    },
    enabled: isAdmin,
  });

  useEffect(() => {
    if (!socket || !isAdmin) return;

    const handleUpdateProgress = (event: {
      data: { phase: string; message: string; progress: number };
    }) => {
      setUpdateProgress({
        phase: event.data.phase,
        message: event.data.message,
        progress: event.data.progress,
      });
    };

    const handleUpdateComplete = (event: { data: { success: boolean; error?: string } }) => {
      setUpdateProgress(null);
      if (event.data.success) {
        setConfigNotice({
          type: 'success',
          text: 'Update completed successfully! Reloading page in 3 seconds...',
        });
        setTimeout(() => {
          window.location.reload();
        }, 3000);
      } else {
        setConfigNotice({
          type: 'error',
          text: `Update failed: ${event.data.error || 'Unknown error'}`,
        });
        queryClient.invalidateQueries({ queryKey: ['updates', 'check'] });
        queryClient.invalidateQueries({ queryKey: ['updates', 'history'] });
      }
    };

    const handleConfigEvent = (event: { type: string; data: unknown }) => {
      if (event.type === 'update.progress') {
        handleUpdateProgress(
          event as { data: { phase: string; message: string; progress: number } },
        );
      } else if (event.type === 'update.complete') {
        handleUpdateComplete(event as { data: { success: boolean; error?: string } });
      }
    };
    socket.on('event', handleConfigEvent);

    return () => {
      socket.off('event', handleConfigEvent);
    };
  }, [socket, isAdmin, queryClient]);

  const [ouiMode, setOuiMode] = useState<'replace' | 'merge'>('replace');
  const [ouiError, setOuiError] = useState<string | null>(null);

  const [localAlarm, setLocalAlarm] = useState<AlarmConfig>(DEFAULT_ALARM_CONFIG);
  const [appSettingsState, setAppSettings] = useState<AppSettings | null>(null);
  const [serialConfigState, setSerialConfig] = useState<SerialConfig | null>(null);
  const [siteSettings, setSiteSettings] = useState<SiteSummary[]>([]);
  const [mqttConfigs, setMqttConfigs] = useState<MqttSiteConfig[]>([]);
  const [mqttPasswords, setMqttPasswords] = useState<Record<string, string>>({});
  const [mqttNotices, setMqttNotices] = useState<Record<string, MqttNotice>>({});
  const [mqttAction, setMqttAction] = useState<{ siteId: string; mode: 'test' | 'connect' } | null>(
    null,
  );
  const [takConfig, setTakConfig] = useState<TakConfig | null>(null);
  const [faaUrl, setFaaUrl] = useState(FAA_DATASET_URL);
  const [mailPasswordInput, setMailPasswordInput] = useState('');
  const [mailPasswordMessage, setMailPasswordMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);
  const [takPasswordInput, setTakPasswordInput] = useState('');
  const [serialTestStatus, setSerialTestStatus] = useState<{
    status: 'idle' | 'running' | 'success' | 'error';
    message?: string;
  }>({ status: 'idle' });
  const [configNotice, setConfigNotice] = useState<{
    type: 'success' | 'error' | 'info';
    text: string;
  } | null>(null);
  const [takNotice, setTakNotice] = useState<{
    type: 'success' | 'error' | 'info';
    text: string;
  } | null>(null);
  const { getKey: getChatKey, setKey: setChatKey, clearKey: clearChatKey } = useChatKeyStore();
  const chatPopupEnabled = useChatStore((state) => state.popupEnabled);
  const setChatPopupEnabled = useChatStore((state) => state.setPopupEnabled);
  const [chatKeyNotice, setChatKeyNotice] = useState<string | null>(null);
  const [chatKeyError, setChatKeyError] = useState<string | null>(null);
  const [chatKeyHidden, setChatKeyHidden] = useState<boolean>(true);
  const [takSendPayload, setTakSendPayload] = useState('');
  const [firewallForm, setFirewallForm] = useState<FirewallFormState | null>(null);
  const [firewallMessage, setFirewallMessage] = useState<string | null>(null);
  const [firewallError, setFirewallError] = useState<string | null>(null);
  const [firewallDirty, setFirewallDirty] = useState(false);
  const [showUpdateConfirmation, setShowUpdateConfirmation] = useState(false);
  const [showClearLogsConfirmation, setShowClearLogsConfirmation] = useState(false);
  const [updateConfirmationError, setUpdateConfirmationError] = useState<string | null>(null);
  const [updateResolutionError, setUpdateResolutionError] = useState<{
    message: string;
    options: Array<{ action: string; description: string; command?: string }>;
  } | null>(null);
  const [updateProgress, setUpdateProgress] = useState<{
    phase: string;
    message: string;
    progress: number;
  } | null>(null);
  const volumeKeys: Array<keyof AlarmConfig> = [
    'volumeInfo',
    'volumeNotice',
    'volumeAlert',
    'volumeCritical',
    'volumeDroneGeofence',
    'volumeDroneTelemetry',
  ];
  const [muteAllAlarms, setMuteAllAlarms] = useState(false);
  const savedVolumesRef = useRef<Partial<AlarmConfig>>({});

  const appSettings = appSettingsState ?? appSettingsQuery.data ?? null;
  const serialConfig = serialConfigState ?? serialConfigQuery.data ?? null;

  const cardClass = (...sections: ConfigSectionId[]) =>
    sections.includes(activeSection) ? 'config-card' : 'config-card config-card--hidden';

  const runtimeSiteId = runtimeConfigQuery.data?.siteId ?? null;
  const runtimeSiteLabel = runtimeSiteId ?? null;
  const serialPorts = serialPortsQuery.data ?? [];
  const serialPortsError =
    serialPortsQuery.error instanceof Error ? serialPortsQuery.error.message : null;
  const serialPortSelectValue =
    serialConfig &&
    serialConfig.devicePath &&
    serialPorts.some((port) => port.path === serialConfig.devicePath)
      ? serialConfig.devicePath
      : '';
  const firewallStats = firewallOverviewQuery.data?.stats ?? null;
  const firewallConfig = firewallOverviewQuery.data?.config ?? null;
  const faaOnline = faaStatusQuery.data?.online ?? { enabled: false, cacheEntries: 0 };
  const faaRegistry = faaStatusQuery.data?.registry ?? null;
  const faaInProgress = faaStatusQuery.data?.inProgress ?? false;
  const faaProgressCount = faaStatusQuery.data?.progress?.processed ?? 0;
  const faaLastError = faaStatusQuery.data?.lastError ?? null;
  const previousFaaInProgress = useRef(false);
  const [firewallSaving, setFirewallSaving] = useState(false);
  const [firewallLogsOpen, setFirewallLogsOpen] = useState(false);
  const [firewallJailOpen, setFirewallJailOpen] = useState(false);
  const firewallLogsQuery = useQuery({
    queryKey: ['firewall', 'logs', { limit: 100 }],
    queryFn: () => apiClient.get<FirewallLog[]>('/config/firewall/logs?limit=100'),
    enabled: firewallLogsOpen,
    staleTime: 30_000,
  });
  const firewallJailedQuery = useQuery({
    queryKey: ['firewall', 'jailed'],
    queryFn: () => apiClient.get<FirewallRule[]>('/config/firewall/jailed'),
    enabled: firewallJailOpen,
    staleTime: 10_000,
  });
  const firewallLogs = firewallLogsQuery.data ?? [];
  const firewallLogsError =
    firewallLogsQuery.error instanceof Error
      ? firewallLogsQuery.error.message
      : 'Unable to load firewall logs.';
  const jailedRules = firewallJailedQuery.data ?? [];
  const jailedError =
    firewallJailedQuery.error instanceof Error
      ? firewallJailedQuery.error.message
      : 'Unable to load jailed IPs.';

  const handleFirewallLogsExport = () => {
    if (firewallLogs.length === 0) {
      return;
    }

    const escape = (value: unknown) => {
      const str = value == null ? '' : String(value);
      if (str.includes('"') || str.includes(',') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const headers = [
      'timestamp',
      'ip',
      'outcome',
      'blocked',
      'method',
      'path',
      'reason',
      'country',
      'userAgent',
      'attempts',
      'ruleId',
    ];

    const rows = firewallLogs.map((log) => [
      formatDateTime(log.lastSeen),
      log.ip,
      log.outcome,
      log.blocked ? 'yes' : 'no',
      log.method.toUpperCase(),
      log.path,
      log.reason ?? '',
      log.country ?? '',
      log.userAgent ?? '',
      String(log.attempts),
      log.ruleId ?? '',
    ]);

    const csv = [headers, ...rows].map((row) => row.map(escape).join(',')).join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `firewall-logs-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    window.URL.revokeObjectURL(url);
  };

  const handleUnblockJailed = (id: string) => {
    if (!id) {
      return;
    }
    unblockJailedMutation.mutate(id);
  };

  const alarmDebounceTimerRef = useRef<number | null>(null);
  const isAlarmInitializedRef = useRef(false);

  // Initialize localAlarm from server data
  useEffect(() => {
    if (alarmSettings?.config) {
      setLocalAlarm(alarmSettings.config);
      isAlarmInitializedRef.current = true;
    }
  }, [alarmSettings?.config]);

  const setVolumes = (nextVolumes: Partial<AlarmConfig>) => {
    setLocalAlarm((prev) => {
      if (!prev) return prev;
      return { ...prev, ...nextVolumes };
    });
  };

  const handleToggleMuteAll = () => {
    if (!localAlarm) return;
    if (!muteAllAlarms) {
      const snapshot: Partial<AlarmConfig> = { ...localAlarm };
      savedVolumesRef.current = snapshot;
      const muted = volumeKeys.reduce(
        (acc, key) => ({ ...acc, [key]: 0 }),
        {} as Partial<AlarmConfig>,
      );
      setVolumes(muted);
      setMuteAllAlarms(true);
    } else {
      const restored = volumeKeys.reduce((acc, key) => {
        const value = savedVolumesRef.current[key] ?? DEFAULT_ALARM_CONFIG[key];
        return { ...acc, [key]: value };
      }, {} as Partial<AlarmConfig>);
      setVolumes(restored);
      setMuteAllAlarms(false);
    }
  };

  // Debounce alarm config updates to prevent race conditions when sliding
  useEffect(() => {
    // Skip if not initialized yet
    if (!isAlarmInitializedRef.current || !alarmSettings?.config) {
      return;
    }

    // Clear any pending timer
    if (alarmDebounceTimerRef.current !== null) {
      window.clearTimeout(alarmDebounceTimerRef.current);
    }

    // Don't send updates if nothing changed
    if (JSON.stringify(localAlarm) === JSON.stringify(alarmSettings.config)) {
      return;
    }

    console.log('Alarm config changed, scheduling update in 500ms...');

    // Set a new timer to update after 500ms of no changes
    alarmDebounceTimerRef.current = window.setTimeout(() => {
      console.log('Sending alarm config update:', localAlarm);
      updateAlarmConfig(localAlarm);
      alarmDebounceTimerRef.current = null;
    }, 500);

    // Cleanup on unmount
    return () => {
      if (alarmDebounceTimerRef.current !== null) {
        window.clearTimeout(alarmDebounceTimerRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localAlarm]);

  useEffect(() => {
    if (appSettingsQuery.data) {
      setAppSettings(appSettingsQuery.data);
    }
  }, [appSettingsQuery.data]);
  useEffect(() => {
    if (serialConfigQuery.data) {
      setSerialConfig(serialConfigQuery.data);
    }
  }, [serialConfigQuery.data]);

  useEffect(() => {
    if (sitesQuery.data) {
      setSiteSettings(sitesQuery.data);
    }
  }, [sitesQuery.data]);

  useEffect(() => {
    if (mqttSitesQuery.data) {
      setMqttConfigs(mqttSitesQuery.data);
    }
  }, [mqttSitesQuery.data]);

  const mqttStatusMap = useMemo<Record<string, MqttSiteStatus>>(
    () =>
      (mqttStatusQuery.data ?? []).reduce(
        (acc, entry) => {
          acc[entry.siteId] = entry;
          return acc;
        },
        {} as Record<string, MqttSiteStatus>,
      ),
    [mqttStatusQuery.data],
  );

  useEffect(() => {
    const entries = Object.entries(mqttNotices).filter(
      (entry): entry is [string, NonNullable<MqttNotice>] => entry[1] !== null,
    );
    if (entries.length === 0) {
      return;
    }
    const timers = entries.map(([siteId, notice]) =>
      setTimeout(() => {
        if (notice?.type === 'error') {
          return;
        }
        setMqttNotices((prev) => {
          if (!prev[siteId] || prev[siteId]?.type === 'error') {
            return prev;
          }
          const next = { ...prev };
          next[siteId] = null;
          return next;
        });
      }, 5000),
    );
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
    };
  }, [mqttNotices, setMqttNotices]);

  useEffect(() => {
    if (takConfigQuery.data) {
      setTakConfig(takConfigQuery.data);
    }
  }, [takConfigQuery.data]);

  useEffect(() => {
    const config = firewallOverviewQuery.data?.config;
    if (!config) {
      if (!firewallOverviewQuery.isLoading) {
        setFirewallForm(null);
      }
      return;
    }
    if (firewallDirty) {
      return;
    }
    setFirewallForm(mapFirewallConfigToForm(config));
    setFirewallMessage(null);
    setFirewallError(null);
    setFirewallDirty(false);
  }, [firewallOverviewQuery.data?.config, firewallOverviewQuery.isLoading, firewallDirty]);

  useEffect(() => {
    if (!configNotice || updateProgress) {
      return;
    }
    const timer = setTimeout(() => setConfigNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [configNotice, updateProgress]);

  useEffect(() => {
    const wasInProgress = previousFaaInProgress.current;
    if (wasInProgress && !faaInProgress) {
      void refetchFaaStatus();
      if (faaRegistry) {
        setConfigNotice({
          type: 'success',
          text: `FAA registry sync completed. ${faaRegistry.totalRecords.toLocaleString()} records loaded.`,
        });
      }
    }
    previousFaaInProgress.current = faaInProgress;
  }, [faaInProgress, faaRegistry, refetchFaaStatus]);

  useEffect(() => {
    if (serialTestStatus.status === 'success' || serialTestStatus.status === 'error') {
      const timer = setTimeout(() => setSerialTestStatus({ status: 'idle' }), 5000);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [serialTestStatus]);

  useEffect(() => {
    if (!takNotice) {
      return;
    }
    const timer = setTimeout(() => setTakNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [takNotice]);

  const sounds = useMemo<Record<AlarmSoundKey, string | null>>(
    () =>
      alarmSettings?.sounds ?? {
        INFO: null,
        NOTICE: null,
        ALERT: null,
        CRITICAL: null,
        DRONE_GEOFENCE: null,
        DRONE_TELEMETRY: null,
      },
    [alarmSettings?.sounds],
  );

  const updateAppSettingsMutation = useMutation({
    mutationFn: (body: AppSettingsUpdate) => apiClient.put<AppSettings>('/config/app', body),
    onSuccess: (data) => {
      queryClient.setQueryData(['appSettings'], data);
      setAppSettings(data);
      setConfigNotice({ type: 'success', text: 'Application settings saved.' });
    },
    onError: (error) => {
      const message =
        error instanceof Error ? error.message : 'Unable to update application settings.';
      setConfigNotice({ type: 'error', text: message });
    },
  });

  const updateAlertColorsMutation = useMutation<
    AuthUser,
    Error,
    AlertColorUpdate,
    { previousUser: AuthUser | null }
  >({
    mutationFn: (body: AlertColorUpdate) => apiClient.put<AuthUser>('/users/me', body),
    onMutate: async (patch) => {
      const current = useAuthStore.getState().user;
      if (!current) {
        return { previousUser: null };
      }
      const optimistic = applyAlertPreferencePatch(current, patch);
      setAuthUser(optimistic);
      queryClient.setQueryData(['users', 'me'], optimistic);
      return { previousUser: current };
    },
    onSuccess: (data) => {
      setAuthUser(data);
      queryClient.setQueryData(['users', 'me'], data);
      setConfigNotice({ type: 'success', text: 'Appearance preferences updated.' });
    },
    onError: (error, _patch, context) => {
      if (context?.previousUser) {
        setAuthUser(context.previousUser);
        queryClient.setQueryData(['users', 'me'], context.previousUser);
      }
      setConfigNotice({
        type: 'error',
        text: error instanceof Error ? error.message : 'Unable to save appearance preferences.',
      });
    },
  });

  const updateAlertColors = (patch: AlertColorUpdate) => {
    const current = useAuthStore.getState().user;
    if (!current) {
      setConfigNotice({ type: 'error', text: 'User profile not loaded yet.' });
      return;
    }
    updateAlertColorsMutation.mutate(patch);
  };

  const updateThemePresetMutation = useMutation<
    AuthUser,
    Error,
    ThemePresetId,
    { previousUser: AuthUser | null }
  >({
    mutationFn: (presetId) => apiClient.put<AuthUser>('/users/me', { themePreset: presetId }),
    onMutate: async (presetId) => {
      const current = useAuthStore.getState().user;
      if (!current) {
        return { previousUser: null };
      }
      const optimistic = applyThemePresetOptimistic(current, presetId);
      setAuthUser(optimistic);
      queryClient.setQueryData(['users', 'me'], optimistic);
      return { previousUser: current };
    },
    onSuccess: (data) => {
      setAuthUser(data);
      queryClient.setQueryData(['users', 'me'], data);
      setConfigNotice({ type: 'success', text: 'Theme preset updated.' });
    },
    onError: (error, _presetId, context) => {
      if (context?.previousUser) {
        setAuthUser(context.previousUser);
        queryClient.setQueryData(['users', 'me'], context.previousUser);
      }
      setConfigNotice({
        type: 'error',
        text: error instanceof Error ? error.message : 'Unable to update theme preset.',
      });
    },
  });

  const faaSyncMutation = useMutation({
    mutationFn: () =>
      apiClient.post<StartFaaSyncResponse>('/config/faa/sync', {
        url: faaUrl && faaUrl !== FAA_DATASET_URL ? faaUrl : undefined,
      }),
    onSuccess: () => {
      setConfigNotice({
        type: 'info',
        text: 'FAA registry sync started. This may take several minutes.',
      });
      void faaStatusQuery.refetch();
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : 'Unable to start FAA sync.';
      setConfigNotice({ type: 'error', text: message });
    },
  });

  const faaUploadMutation = useMutation({
    mutationFn: (file: File) => {
      const formData = new FormData();
      formData.append('file', file);
      return apiClient.upload<StartFaaSyncResponse>('/config/faa/upload', formData);
    },
    onSuccess: () => {
      setConfigNotice({
        type: 'info',
        text: 'FAA registry upload started. This may take several minutes.',
      });
      void faaStatusQuery.refetch();
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : 'Unable to upload FAA file.';
      setConfigNotice({ type: 'error', text: message });
    },
  });

  const triggerUpdateMutation = useMutation({
    mutationFn: async () => {
      return await apiClient.post('/updates/trigger', {
        confirmation: 'UPDATE',
        ...(selectedRemote ? { remote: selectedRemote } : {}),
        ...(selectedBranch ? { branch: selectedBranch } : {}),
      });
    },
    onSuccess: () => {
      setShowUpdateConfirmation(false);
      setUpdateProgress({
        phase: 'STARTING',
        message: 'Initiating update...',
        progress: 0,
      });

      const pollInterval = setInterval(async () => {
        const status = await apiClient.get<{ status: string }>('/updates/status');
        if (status.status !== 'RUNNING') {
          clearInterval(pollInterval);
          window.location.reload();
        }
      }, 2000);

      setTimeout(() => clearInterval(pollInterval), 300000);
    },
    onError: (error: unknown) => {
      setUpdateProgress(null);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const axiosError = error as {
        response?: {
          data?: {
            message?: string;
            resolutionOptions?: Array<{ action: string; description: string; command?: string }>;
          };
        };
      };

      const resolutionOptions = axiosError.response?.data?.resolutionOptions;
      const message = axiosError.response?.data?.message || errorMessage;

      if (resolutionOptions && resolutionOptions.length > 0) {
        setShowUpdateConfirmation(false);
        setUpdateResolutionError({
          message,
          options: resolutionOptions,
        });
      } else {
        setUpdateConfirmationError(message);
      }
    },
  });

  const clearUpdateLogsMutation = useMutation({
    mutationFn: async () => {
      return await apiClient.delete('/updates/history');
    },
    onSuccess: () => {
      setShowClearLogsConfirmation(false);
      queryClient.invalidateQueries({ queryKey: ['updates', 'history'] });
      setConfigNotice({
        type: 'success',
        text: 'Update logs cleared successfully.',
      });
    },
    onError: (error: unknown) => {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      setConfigNotice({
        type: 'error',
        text: `Failed to clear logs: ${errorMessage}`,
      });
    },
  });

  const updateSerialConfigMutation = useMutation({
    mutationFn: (body: Partial<SerialConfig>) =>
      apiClient.put<SerialConfig>('/serial/config', body),
    onSuccess: (data) => {
      queryClient.setQueryData(['serialConfig'], data);
      setSerialConfig(data);
      setConfigNotice({ type: 'success', text: 'Serial configuration updated.' });
    },
    onError: (error) => {
      const message =
        error instanceof Error ? error.message : 'Unable to update serial configuration.';
      setConfigNotice({ type: 'error', text: message });
    },
  });

  const resetSerialConfigMutation = useMutation({
    mutationFn: () => apiClient.post<SerialConfig>('/serial/config/reset', {}),
    onSuccess: (data) => {
      queryClient.setQueryData(['serialConfig'], data);
      setSerialConfig(data);
      setConfigNotice({ type: 'success', text: 'Serial configuration reset to defaults.' });
    },
    onError: (error) => {
      const message =
        error instanceof Error ? error.message : 'Unable to reset serial configuration.';
      setConfigNotice({ type: 'error', text: message });
    },
  });

  const updateSerialSetting = (patch: Partial<SerialConfig>) => {
    setSerialConfig((previous) => {
      if (!previous) {
        return previous;
      }
      const optimistic = { ...previous, ...patch };
      updateSerialConfigMutation.mutate(patch, {
        onError: () => {
          setSerialConfig(previous);
        },
      });
      return optimistic;
    });
  };

  const updateTakConfigMutation = useMutation({
    mutationFn: (body: Partial<TakConfig>) => apiClient.put<TakConfig>('/tak/config', body),
    onSuccess: (data) => {
      queryClient.setQueryData(['takConfig'], data);
      setTakConfig(data);
      setTakNotice({ type: 'success', text: 'TAK configuration updated.' });
    },
    onError: (error) => {
      const message =
        error instanceof Error ? error.message : 'Unable to update TAK configuration.';
      setTakNotice({ type: 'error', text: message });
    },
  });

  const updateFirewallMutation = useMutation<
    FirewallOverview['config'],
    unknown,
    FirewallUpdatePayload
  >({
    mutationFn: (payload) => apiClient.put<FirewallOverview['config']>('/config/firewall', payload),
    onMutate: () => {
      setFirewallError(null);
      setFirewallMessage(null);
      setFirewallSaving(true);
    },
    onSuccess: (config) => {
      queryClient.setQueryData<FirewallOverview>(['firewall', 'overview'], (previous) =>
        previous ? { ...previous, config } : previous,
      );
      setFirewallForm(mapFirewallConfigToForm(config));
      setFirewallDirty(false);
      setFirewallMessage('Firewall settings updated.');
      setFirewallSaving(false);
    },
    onError: (error) => {
      setFirewallError(
        error instanceof Error ? error.message : 'Unable to update firewall settings.',
      );
      setFirewallSaving(false);
    },
  });

  const unblockJailedMutation = useMutation({
    mutationFn: (id: string) => apiClient.delete(`/config/firewall/jailed/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['firewall', 'jailed'] });
      setFirewallMessage('IP removed from jail.');
    },
    onError: (error: Error) => {
      setFirewallError(error.message);
    },
  });

  const updateSiteMutation = useMutation({
    mutationFn: ({ siteId, body }: { siteId: string; body: Partial<SiteSummary> }) =>
      apiClient.put<SiteSummary>(`/sites/${siteId}`, body),
    onSuccess: (data) => {
      queryClient.setQueryData(['sites'], (existing: SiteSummary[] | undefined) =>
        existing ? existing.map((site) => (site.id === data.id ? data : site)) : [data],
      );
      setSiteSettings((prev) => prev.map((site) => (site.id === data.id ? data : site)));
      updateNodeSiteMeta(data.id, { name: data.name, color: data.color });
    },
  });
  const updateMqttConfigMutation = useMutation<
    MqttSiteConfig,
    Error,
    { siteId: string; body: Partial<MqttSiteConfig> & { password?: string | null } }
  >({
    mutationFn: ({ siteId, body }) => apiClient.put<MqttSiteConfig>(`/mqtt/sites/${siteId}`, body),
    onSuccess: (data) => {
      queryClient.setQueryData(['mqttSites'], (existing: MqttSiteConfig[] | undefined) =>
        existing
          ? existing.map((cfg) => (cfg.siteId === data.siteId ? { ...cfg, ...data } : cfg))
          : [data],
      );
      setMqttConfigs((prev) =>
        prev.map((cfg) => (cfg.siteId === data.siteId ? { ...cfg, ...data } : cfg)),
      );
      setMqttNotices((prev) => ({
        ...prev,
        [data.siteId]: { type: 'success', text: 'Settings saved.' },
      }));
      queryClient.invalidateQueries({ queryKey: ['mqttStatus'] });
    },
    onError: (error, variables) => {
      const message =
        error instanceof Error ? error.message : 'Unable to update MQTT configuration.';
      setMqttNotices((prev) => ({
        ...prev,
        [variables.siteId]: { type: 'error', text: message },
      }));
    },
  });

  const testMqttMutation = useMutation<MqttTestResponse, Error, string>({
    mutationFn: (siteId) => apiClient.post<MqttTestResponse>(`/mqtt/sites/${siteId}/test`, {}),
    onMutate: (siteId) => {
      setMqttAction({ siteId, mode: 'test' });
      setMqttNotices((prev) => ({ ...prev, [siteId]: null }));
    },
    onSuccess: (data, siteId) => {
      setMqttNotices((prev) => ({
        ...prev,
        [siteId]: { type: data.ok ? 'success' : 'error', text: data.message },
      }));
      queryClient.invalidateQueries({ queryKey: ['mqttStatus'] });
    },
    onError: (error, siteId) => {
      const message = error instanceof Error ? error.message : 'Unable to test MQTT connection.';
      setMqttNotices((prev) => ({ ...prev, [siteId]: { type: 'error', text: message } }));
    },
    onSettled: () => {
      setMqttAction(null);
    },
  });

  const reconnectMqttMutation = useMutation<MqttSiteStatus, Error, string>({
    mutationFn: (siteId) => apiClient.post<MqttSiteStatus>(`/mqtt/sites/${siteId}/restart`, {}),
    onMutate: (siteId) => {
      setMqttAction({ siteId, mode: 'connect' });
      setMqttNotices((prev) => ({ ...prev, [siteId]: null }));
    },
    onSuccess: (status, siteId) => {
      const message =
        status.message ??
        (status.state === 'connected' ? 'Connected to broker.' : 'Reconnect attempt finished.');
      const type: 'success' | 'error' | 'info' =
        status.state === 'connected' ? 'success' : status.state === 'error' ? 'error' : 'info';
      setMqttNotices((prev) => ({ ...prev, [siteId]: { type, text: message } }));
      queryClient.invalidateQueries({ queryKey: ['mqttStatus'] });
    },
    onError: (error, siteId) => {
      const message = error instanceof Error ? error.message : 'Unable to reconnect MQTT client.';
      setMqttNotices((prev) => ({ ...prev, [siteId]: { type: 'error', text: message } }));
    },
    onSettled: () => {
      setMqttAction(null);
    },
  });
  const setLocalMqttConfig = (siteId: string, patch: Partial<MqttSiteConfig>) => {
    setMqttConfigs((prev) =>
      prev.map((cfg) => (cfg.siteId === siteId ? { ...cfg, ...patch } : cfg)),
    );
  };

  const commitMqttConfig = (
    siteId: string,
    patch: Partial<MqttSiteConfig> & { password?: string | null },
  ) => {
    updateMqttConfigMutation.mutate({ siteId, body: patch });
  };

  const handleMqttTest = (siteId: string) => {
    testMqttMutation.mutate(siteId);
  };

  const handleMqttReconnect = (siteId: string) => {
    reconnectMqttMutation.mutate(siteId);
  };

  const reloadTakMutation = useMutation({
    mutationFn: () => apiClient.post<{ status: string }>('/tak/reload', {}),
    onSuccess: () => {
      setTakNotice({ type: 'info', text: 'TAK bridge restarted.' });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : 'Unable to restart TAK bridge.';
      setTakNotice({ type: 'error', text: message });
    },
  });
  const takSendMutation = useMutation({
    mutationFn: (payload: string) => apiClient.post<{ status: string }>('/tak/send', { payload }),
    onSuccess: () => {
      setTakNotice({ type: 'success', text: 'TAK payload transmitted.' });
      setTakSendPayload('');
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : 'Unable to send CoT payload.';
      setTakNotice({ type: 'error', text: message });
    },
  });

  const handleMqttPasswordSubmit = (siteId: string) => {
    const value = mqttPasswords[siteId];
    commitMqttConfig(siteId, { password: value ? value : null });
    setMqttPasswords((prev) => ({ ...prev, [siteId]: '' }));
  };

  const handleMailPasswordSave = async () => {
    if (!appSettings) {
      return;
    }
    try {
      setMailPasswordMessage(null);
      const trimmed = mailPasswordInput.trim();
      const result = await updateAppSettingsMutation.mutateAsync({
        mailPassword: trimmed,
      });
      setMailPasswordInput('');
      setMailPasswordMessage({
        type: 'success',
        text: trimmed.length > 0 ? 'Mail password updated.' : 'Mail password cleared.',
      });
      setAppSettings(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to update mail password.';
      setMailPasswordMessage({ type: 'error', text: message });
    }
  };

  const serialTestMutation = useMutation({
    mutationFn: (payload: SerialConnectPayload) =>
      apiClient.post<SerialState>('/serial/connect', payload),
    onMutate: () => {
      setSerialTestStatus({ status: 'running', message: 'Attempting to connect...' });
    },
    onSuccess: (state) => {
      if (state.connected) {
        setSerialTestStatus({
          status: 'success',
          message:
            `Connected to ${state.path ?? 'device'} ${state.baudRate ? `@ ${state.baudRate} baud` : ''}`.trim(),
        });
        void serialConfigQuery.refetch();
        void serialStateQuery.refetch();
      } else {
        setSerialTestStatus({
          status: 'error',
          message: state.lastError ?? 'Connection attempt completed without link.',
        });
      }
    },
    onError: (error) => {
      setSerialTestStatus({
        status: 'error',
        message: error instanceof Error ? error.message : 'Failed to connect to serial device.',
      });
    },
  });

  const serialConnectMutation = useMutation({
    mutationFn: (payload: SerialConnectPayload) =>
      apiClient.post<SerialState>('/serial/connect', payload),
    onSuccess: (state) => {
      queryClient.setQueryData(['serialState'], state);
      if (state.connected) {
        const pathLabel = state.path ?? 'device';
        const baudLabel = state.baudRate ? ` @ ${state.baudRate} baud` : '';
        setConfigNotice({
          type: 'success',
          text: `Serial connection established. (${pathLabel}${baudLabel})`,
        });
      } else {
        setConfigNotice({
          type: 'error',
          text: state.lastError ?? 'Unable to connect to serial device.',
        });
      }
      void serialConfigQuery.refetch();
      void serialStateQuery.refetch();
    },
    onError: (error) => {
      const currentState = serialStateQuery.data;
      if (currentState?.connected) {
        const pathLabel = currentState.path ?? 'device';
        const baudLabel = currentState.baudRate ? ` @ ${currentState.baudRate} baud` : '';
        setConfigNotice({
          type: 'info',
          text: `Serial already connected (${pathLabel}${baudLabel}). Disconnect first if you need to switch devices.`,
        });
        return;
      }
      const message =
        error instanceof Error ? error.message : 'Unable to connect to serial device.';
      setConfigNotice({ type: 'error', text: message });
    },
  });

  const serialDisconnectMutation = useMutation({
    mutationFn: () => apiClient.post<SerialState>('/serial/disconnect', {}),
    onSuccess: (state) => {
      queryClient.setQueryData(['serialState'], state);
      setConfigNotice({ type: 'info', text: 'Serial connection closed.' });
      void serialStateQuery.refetch();
    },
    onError: (error) => {
      const message =
        error instanceof Error ? error.message : 'Unable to disconnect from serial device.';
      setConfigNotice({ type: 'error', text: message });
    },
  });

  const serialState = serialStateQuery.data ?? null;
  const serialToggleBusy = serialConnectMutation.isPending || serialDisconnectMutation.isPending;
  const serialToggleDisabled = serialToggleBusy || !serialConfig || serialStateQuery.isLoading;
  const serialToggleLabel = serialToggleBusy
    ? serialState?.connected
      ? 'Disconnecting...'
      : 'Connecting...'
    : serialState?.connected
      ? 'Disconnect Serial'
      : 'Connect Serial';

  const ouiImportMutation = useMutation({
    mutationFn: ({ file, mode }: { file: File; mode: 'replace' | 'merge' }) => {
      const formData = new FormData();
      formData.append('file', file);
      return apiClient.upload<{ imported: number; total: number; mode: string }>(
        `/oui/import?mode=${mode}`,
        formData,
      );
    },
    onSuccess: () => {
      setOuiError(null);
      queryClient.invalidateQueries({ queryKey: ['ouiStats'] });
    },
    onError: (error) => {
      setOuiError(error instanceof Error ? error.message : 'Failed to import OUI data');
    },
  });

  const updateAppSetting = (patch: Partial<AppSettings>) => {
    if (!appSettings) return;
    const next = { ...appSettings, ...patch };
    setAppSettings(next);
    updateAppSettingsMutation.mutate(patch);
  };

  const generateChatKey = () => {
    const buf = crypto.getRandomValues(new Uint8Array(32));
    return btoa(String.fromCharCode(...buf));
  };

  const handleDefaultRadiusChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = Number(event.target.value);
    if (!Number.isFinite(value)) {
      return;
    }
    const clamped = Math.max(DEFAULT_RADIUS_LIMITS.min, Math.min(DEFAULT_RADIUS_LIMITS.max, value));
    updateAppSetting({ defaultRadiusM: clamped });
  };

  const handleAlertColorChange =
    (key: AlertColorFieldKey) => (event: ChangeEvent<HTMLInputElement>) => {
      updateAlertColors({ [key]: event.target.value });
    };

  const handleAlertColorReset = (key: AlertColorFieldKey) => {
    updateAlertColors({ [key]: null });
  };

  const handleThemePresetSelect = (presetId: ThemePresetId) => {
    const current = useAuthStore.getState().user;
    if (!current) {
      setConfigNotice({ type: 'error', text: 'User profile not loaded yet.' });
      return;
    }
    updateThemePresetMutation.mutate(presetId);
  };

  const renderAlertColorRow = (field: (typeof ALERT_COLOR_FIELDS)[number]) => {
    const previewColor = effectiveAlertColors[field.previewKey];
    const overrideValue = alertOverrideValueForKey(userAlertOverrides, field.key);
    const isOverride = overrideValue !== null;
    return (
      <div key={field.key} className="color-row alert-color-row">
        <div className="color-row-details">
          <span className="config-label">{field.label}</span>
          <p className="field-hint">{field.description}</p>
        </div>
        <div className="color-row-controls">
          <input
            type="color"
            value={previewColor}
            onChange={handleAlertColorChange(field.key)}
            aria-label={`${field.label} Color`}
          />
          <div className="alert-color-code">{previewColor}</div>
          <button
            type="button"
            className="control-chip"
            onClick={() => handleAlertColorReset(field.key)}
            disabled={!isOverride}
          >
            Reset
          </button>
        </div>
      </div>
    );
  };

  const handleSerialPortSelect = (event: ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value;
    if (!value) {
      return;
    }
    updateSerialSetting({ devicePath: value });
  };

  const handleSerialReset = () => {
    resetSerialConfigMutation.mutate();
  };

  const updateTakSetting = (patch: Partial<TakConfig>) => {
    setTakConfig((prev) => (prev ? { ...prev, ...patch } : prev));
  };

  const commitTakConfig = (patch: Partial<TakConfig>) => {
    if (!takConfig) {
      return;
    }
    const previous = takConfig;
    const optimistic = { ...takConfig, ...patch };
    setTakConfig(optimistic);
    updateTakConfigMutation.mutate(patch, {
      onError: () => setTakConfig(previous),
    });
  };

  const handleTakToggle = (key: keyof TakConfig) => (event: ChangeEvent<HTMLInputElement>) => {
    const checked = event.target.checked;
    updateTakSetting({ [key]: checked } as Partial<TakConfig>);
    commitTakConfig({ [key]: checked } as Partial<TakConfig>);
  };

  const handleTakPasswordSave = () => {
    const value = takPasswordInput.trim();
    if (value.length === 0) {
      return;
    }
    updateTakConfigMutation.mutate(
      { password: value },
      {
        onSuccess: () => {
          setTakPasswordInput('');
          setTakNotice({ type: 'success', text: 'TAK password updated.' });
        },
        onError: (error) => {
          const message = error instanceof Error ? error.message : 'Unable to update TAK password.';
          setTakNotice({ type: 'error', text: message });
        },
      },
    );
  };

  const handleTakPasswordClear = () => {
    updateTakConfigMutation.mutate(
      { password: '' },
      {
        onSuccess: () => {
          setTakNotice({ type: 'success', text: 'TAK password cleared.' });
        },
        onError: (error) => {
          const message = error instanceof Error ? error.message : 'Unable to clear TAK password.';
          setTakNotice({ type: 'error', text: message });
        },
      },
    );
  };

  const handleFirewallFieldChange = <K extends keyof FirewallFormState>(
    key: K,
    value: FirewallFormState[K],
  ) => {
    setFirewallForm((prev) => (prev ? { ...prev, [key]: value } : prev));
    setFirewallDirty(true);
    setFirewallMessage(null);
    setFirewallError(null);
  };

  const handleFirewallSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!firewallForm) {
      return;
    }
    const allowed = parseCountryList(firewallForm.allowedCountries);
    const blocked = parseCountryList(firewallForm.blockedCountries);
    const ipAllow = parseLineList(firewallForm.ipAllowList);
    const ipBlock = parseLineList(firewallForm.ipBlockList);
    const failThreshold = Number(firewallForm.failThreshold);
    const failWindowSeconds = Number(firewallForm.failWindowSeconds);
    const banDurationSeconds = Number(firewallForm.banDurationSeconds);

    if (!Number.isFinite(failThreshold) || failThreshold < 1 || failThreshold > 100) {
      setFirewallError('Fail threshold must be between 1 and 100 attempts.');
      return;
    }
    if (
      !Number.isFinite(failWindowSeconds) ||
      failWindowSeconds < 30 ||
      failWindowSeconds > 86_400
    ) {
      setFirewallError('Failure window must be between 30 and 86,400 seconds.');
      return;
    }
    if (
      !Number.isFinite(banDurationSeconds) ||
      banDurationSeconds < 60 ||
      banDurationSeconds > 604_800
    ) {
      setFirewallError('Ban duration must be between 60 and 604,800 seconds.');
      return;
    }

    updateFirewallMutation.mutate({
      enabled: firewallForm.enabled,
      defaultPolicy: firewallForm.defaultPolicy,
      geoMode: firewallForm.geoMode,
      allowedCountries: allowed,
      blockedCountries: blocked,
      ipAllowList: ipAllow,
      ipBlockList: ipBlock,
      failThreshold: Math.round(failThreshold),
      failWindowSeconds: Math.round(failWindowSeconds),
      banDurationSeconds: Math.round(banDurationSeconds),
    });
  };

  const updateSiteSetting = (siteId: string, patch: Partial<SiteSummary>) => {
    setSiteSettings((prev) =>
      prev.map((site) => (site.id === siteId ? { ...site, ...patch } : site)),
    );
  };

  const commitSiteSetting = (siteId: string, patch: Partial<SiteSummary>) => {
    const body: Partial<SiteSummary> = {};
    if ('name' in patch) {
      const value = patch.name?.trim();
      if (typeof value === 'string') {
        body.name = value;
      }
    }
    if ('color' in patch) {
      const value = patch.color?.trim();
      if (value) {
        body.color = value.startsWith('#') ? value : `#${value}`;
      }
    }
    if ('region' in patch) {
      const value = patch.region?.trim();
      body.region = value && value.length > 0 ? value : null;
    }
    if ('country' in patch) {
      const value = patch.country?.trim();
      body.country = value && value.length > 0 ? value : null;
    }
    if ('city' in patch) {
      const value = patch.city?.trim();
      body.city = value && value.length > 0 ? value : null;
    }
    if (Object.keys(body).length === 0) {
      return;
    }
    updateSiteMutation.mutate({ siteId, body });
  };

  const handleOuiUpload = (file: File) => {
    if (!file) return;
    setOuiError(null);
    ouiImportMutation.mutate({ file, mode: ouiMode });
  };

  const handleJsonFeatureNotice = () => {
    setConfigNotice({
      type: 'info',
      text: 'JSON import/export is not available yet.',
    });
  };

  const isValidSerialProtocol = (value: string | null | undefined): value is string =>
    !!value && PROTOCOL_OPTIONS.some((option) => option.value === value);

  const buildSerialConnectPayload = (): SerialConnectPayload | null => {
    if (!appSettings || !serialConfig) {
      return null;
    }
    const payload: SerialConnectPayload = {};
    if (serialConfig.devicePath) {
      payload.path = serialConfig.devicePath;
    }
    if (serialConfig.baud != null) {
      payload.baudRate = serialConfig.baud;
    }
    if (serialConfig.delimiter ?? '') {
      payload.delimiter = serialConfig.delimiter ?? undefined;
    }
    payload.protocol = isValidSerialProtocol(appSettings.protocol)
      ? appSettings.protocol
      : 'meshtastic-rewrite';
    return payload;
  };

  const handleTestSerial = () => {
    const payload = buildSerialConnectPayload();
    if (!payload) {
      setSerialTestStatus({
        status: 'error',
        message: 'Serial settings are not loaded yet.',
      });
      return;
    }
    serialTestMutation.mutate(payload);
  };

  const handleSerialToggle = () => {
    if (serialConnectMutation.isPending || serialDisconnectMutation.isPending) {
      return;
    }
    if (serialState?.connected) {
      serialDisconnectMutation.mutate();
      return;
    }
    const payload = buildSerialConnectPayload();
    if (!payload) {
      setConfigNotice({ type: 'error', text: 'Serial settings are not loaded yet.' });
      return;
    }
    serialConnectMutation.mutate(payload);
  };

  const handleOuiExport = (format: 'csv' | 'json') => {
    window.open(`/api/oui/export?format=${format}`, '_blank', 'noopener');
  };

  const handleFaaSyncClick = () => {
    faaSyncMutation.mutate();
  };

  const handleFaaUpload = (file: File) => {
    if (!file) return;
    faaUploadMutation.mutate(file);
  };

  const formatDateTime = (value?: string | null) =>
    value ? new Date(value).toLocaleString() : 'N/A';

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const formatDuration = (seconds: number | null) => {
    if (!seconds) return '—';
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (minutes === 0) return `${remainingSeconds}s`;
    return `${minutes}m ${remainingSeconds}s`;
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'SUCCESS':
        return <span className="status-badge status-badge--success">SUCCESS</span>;
      case 'FAILED':
        return <span className="status-badge status-badge--error">FAILED</span>;
      case 'RUNNING':
        return <span className="status-badge status-badge--info">RUNNING</span>;
      case 'ROLLED_BACK':
        return <span className="status-badge status-badge--warning">ROLLED BACK</span>;
      default:
        return <span className="status-badge">{status}</span>;
    }
  };

  const ouiStats = ouiStatsQuery.data;
  const takConfigError = takConfigQuery.error instanceof Error ? takConfigQuery.error : null;
  const takLastConnected = takConfig?.lastConnected
    ? new Date(takConfig.lastConnected).toLocaleString()
    : 'Never';
  const takToggleDisabled = updateTakConfigMutation.isPending;

  const handleVolumeChange =
    (level: AlarmLevel, key: keyof AlarmConfig) => (event: ChangeEvent<HTMLInputElement>) => {
      if (!localAlarm) return;
      const value = Number(event.target.value);
      const next = { ...localAlarm, [key]: value } as AlarmConfig;
      setLocalAlarm(next);
    };

  const handleDroneVolumeChange =
    (key: 'volumeDroneGeofence' | 'volumeDroneTelemetry') =>
    (event: ChangeEvent<HTMLInputElement>) => {
      if (!localAlarm) return;
      const value = Number(event.target.value);
      const next = { ...localAlarm, [key]: value } as AlarmConfig;
      setLocalAlarm(next);
    };

  const handleGapChange = (key: keyof AlarmConfig) => (event: ChangeEvent<HTMLInputElement>) => {
    if (!localAlarm) return;
    const value = Number(event.target.value);
    const next = { ...localAlarm, [key]: value } as AlarmConfig;
    setLocalAlarm(next);
  };

  const handleAudioPackChange = (event: ChangeEvent<HTMLSelectElement>) => {
    if (!localAlarm) return;
    const next = { ...localAlarm, audioPack: event.target.value };
    setLocalAlarm(next);
  };

  const handleDndChange =
    (key: 'dndStart' | 'dndEnd') => (event: ChangeEvent<HTMLInputElement>) => {
      if (!localAlarm) return;
      const value = event.target.value || null;
      const next = { ...localAlarm, [key]: value };
      setLocalAlarm(next);
    };

  const handleBackgroundToggle = (event: ChangeEvent<HTMLInputElement>) => {
    if (!localAlarm) return;
    const next = { ...localAlarm, backgroundAllowed: event.target.checked };
    setLocalAlarm(next);
  };

  const userAlertOverrides = authUser?.preferences?.alertColors ?? null;

  const baseAlertColors = useMemo(
    () => extractAlertColors(appSettings ?? undefined),
    [appSettings],
  );

  const effectiveAlertColors = useMemo(
    () => applyAlertOverrides(baseAlertColors, userAlertOverrides),
    [baseAlertColors, userAlertOverrides],
  );
  const themePresetOptions = useMemo<
    Array<(typeof THEME_PRESETS)[number] & { palette: ThemePalette }>
  >(
    () =>
      THEME_PRESETS.map((preset) => ({
        ...preset,
        palette: resolveThemePalette(preset.id, appSettings ?? undefined),
      })),
    [appSettings],
  );

  const isLoading = alarmLoading || appSettingsQuery.isLoading || serialConfigQuery.isLoading;

  const renderScaffold = (panelContent: ReactNode) => (
    <div className="config-shell">
      <aside className="config-rail">
        <div className="config-rail__title">
          <h1 className="config-rail__heading">Configuration</h1>
          <p className="config-rail__copy">
            Manage appearance, alarms, serial transport, detection defaults, federation, and
            retention.
          </p>
        </div>
        <nav className="config-menu" aria-label="Configuration sections">
          {visibleSections.map((section) => {
            const isActive = section.id === activeSection;
            return (
              <button
                key={section.id}
                type="button"
                className={`config-menu__item${isActive ? ' config-menu__item--active' : ''}`}
                onClick={() => setActiveSection(section.id)}
                aria-pressed={isActive}
              >
                <span className="config-menu__label">{section.label}</span>
                <span className="config-menu__description">{section.description}</span>
              </button>
            );
          })}
        </nav>
      </aside>
      <section className="panel config-page">{panelContent}</section>
    </div>
  );

  if (isLoading) {
    return renderScaffold(
      <>
        <header className="panel__header">
          <div>
            <h2 className="panel__title">Loading configuration</h2>
            <p className="panel__subtitle">Please wait while we fetch the latest settings.</p>
          </div>
        </header>
        <div className="empty-state">
          <div>Loading configuration.</div>
        </div>
      </>,
    );
  }

  if (!authUser) {
    return renderScaffold(
      <>
        <header className="panel__header">
          <div>
            <h2 className="panel__title">Configuration</h2>
            <p className="panel__subtitle">User profile not loaded.</p>
          </div>
        </header>
        <div className="empty-state">
          <div>We could not load your profile. Please refresh and try again.</div>
        </div>
      </>,
    );
  }

  if (!appSettings || !serialConfig) {
    const appSettingsError =
      appSettingsQuery.error instanceof Error ? appSettingsQuery.error.message : null;
    const serialConfigError =
      serialConfigQuery.error instanceof Error ? serialConfigQuery.error.message : null;
    return renderScaffold(
      <>
        <header className="panel__header">
          <div>
            <h2 className="panel__title">Configuration</h2>
            <p className="panel__subtitle">Unable to load configuration data.</p>
          </div>
          <div className="controls-row">
            <button
              type="button"
              className="control-chip"
              onClick={() => {
                void appSettingsQuery.refetch();
                void serialConfigQuery.refetch();
              }}
            >
              Retry
            </button>
          </div>
        </header>
        <div className="empty-state">
          {appSettingsError || serialConfigError ? (
            <div>
              {appSettingsError ? <p>App settings: {appSettingsError}</p> : null}
              {serialConfigError ? <p>Serial config: {serialConfigError}</p> : null}
            </div>
          ) : (
            <div>No configuration data returned from the server.</div>
          )}
        </div>
      </>,
    );
  }
  const mailInputsDisabled = !appSettings.mailEnabled;
  const trimmedMailPassword = mailPasswordInput.trim();
  const mailPasswordReady =
    trimmedMailPassword.length > 0 ||
    (appSettings.mailPasswordSet && mailPasswordInput.length === 0);

  return renderScaffold(
    <>
      <header className="panel__header panel__header--stacked">
        {configNotice ? (
          <div
            className={
              configNotice.type === 'error'
                ? 'form-error'
                : configNotice.type === 'success'
                  ? 'form-success'
                  : 'form-hint'
            }
            role={configNotice.type === 'error' ? 'alert' : 'status'}
          >
            {configNotice.text}
          </div>
        ) : null}
        {serialTestStatus.status !== 'idle' ? (
          <div
            className={
              serialTestStatus.status === 'error'
                ? 'form-error'
                : serialTestStatus.status === 'success'
                  ? 'form-success'
                  : 'form-hint'
            }
          >
            {serialTestStatus.message}
          </div>
        ) : null}
      </header>

      <div className="config-content">
        <div className="config-grid">
          <section className={cardClass('alarms')}>
            <header>
              <h2>Alarm Profiles</h2>
              <p>Adjust volume, rate limit, and audio tone for each alarm level.</p>
              <div className="controls-row">
                <label className="checkbox-label">
                  <input type="checkbox" checked={muteAllAlarms} onChange={handleToggleMuteAll} />
                  Mute all alarms
                </label>
                <span className="config-hint" style={{ marginLeft: 8 }}>
                  Temporarily set all alarm volumes to 0; unmute restores previous levels.
                </span>
              </div>
            </header>
            <div className="config-card__body">
              <div className="config-row">
                <span className="config-label">Sound Pack</span>
                <select value={localAlarm.audioPack} onChange={handleAudioPackChange}>
                  <option value="default">Default</option>
                  <option value="quiet">Quiet</option>
                  <option value="ops">Operations</option>
                </select>
              </div>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={localAlarm.backgroundAllowed}
                  onChange={handleBackgroundToggle}
                />
                Allow audio playback when the console tab is in the background
              </label>
            </div>
            <div className="config-card__body alarm-grid">
              {Object.entries(LEVEL_METADATA).map(([level, meta]) => {
                const alarmLevel = level as AlarmLevel;
                const volumeKey = volumeKeyForLevel(alarmLevel);
                const volumeValue = (localAlarm[volumeKey] ?? 0) as number;
                return (
                  <div key={alarmLevel} className="alarm-level-card">
                    <div className="alarm-header">
                      <h3>{meta.label}</h3>
                      <span>{meta.description}</span>
                    </div>
                    <div className="alarm-controls">
                      <label>
                        Volume: {volumeValue}%
                        <input
                          type="range"
                          min={0}
                          max={100}
                          value={volumeValue}
                          onChange={handleVolumeChange(alarmLevel, volumeKey)}
                        />
                      </label>
                      <div className="alarm-sound-row">
                        <div className="sound-file">
                          {sounds[alarmLevel] ? 'Custom sound uploaded' : 'Using default tone'}
                        </div>
                        <div className="sound-actions">
                          <button
                            type="button"
                            className="control-chip"
                            onClick={() => play(alarmLevel)}
                          >
                            Preview
                          </button>
                          <label className="control-chip">
                            Upload
                            <input
                              type="file"
                              accept="audio/*"
                              onChange={(event) => {
                                const file = event.target.files?.[0];
                                if (file) {
                                  uploadSound(alarmLevel, file);
                                  event.target.value = '';
                                }
                              }}
                              hidden
                            />
                          </label>
                          <button
                            type="button"
                            className="control-chip"
                            disabled={!sounds[alarmLevel]}
                            onClick={() => removeSound(alarmLevel)}
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
              <div className="alarm-level-card">
                <div className="alarm-header">
                  <h3>Drone Geofence</h3>
                  <span>Sound used when a drone breaches any perimeter.</span>
                </div>
                <div className="alarm-controls">
                  <label>
                    Volume: {localAlarm.volumeDroneGeofence}%
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={localAlarm.volumeDroneGeofence}
                      onChange={handleDroneVolumeChange('volumeDroneGeofence')}
                    />
                  </label>
                  <div className="alarm-sound-row">
                    <div className="sound-file">
                      {sounds[DRONE_GEOFENCE_SOUND_KEY]
                        ? 'Custom sound uploaded'
                        : 'Using default alert tone'}
                    </div>
                    <div className="sound-actions">
                      <button
                        type="button"
                        className="control-chip"
                        onClick={() => playDroneGeofence()}
                      >
                        Preview
                      </button>
                      <label className="control-chip">
                        Upload
                        <input
                          type="file"
                          accept="audio/*"
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file) {
                              uploadSound(DRONE_GEOFENCE_SOUND_KEY, file);
                              event.target.value = '';
                            }
                          }}
                          hidden
                        />
                      </label>
                      <button
                        type="button"
                        className="control-chip"
                        disabled={!sounds[DRONE_GEOFENCE_SOUND_KEY]}
                        onClick={() => removeSound(DRONE_GEOFENCE_SOUND_KEY)}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                </div>
              </div>
              <div className="alarm-level-card">
                <div className="alarm-header">
                  <h3>Drone Telemetry</h3>
                  <span>Audible cue for new drone telemetry events.</span>
                </div>
                <div className="alarm-controls">
                  <label>
                    Volume: {localAlarm.volumeDroneTelemetry}%
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={localAlarm.volumeDroneTelemetry}
                      onChange={handleDroneVolumeChange('volumeDroneTelemetry')}
                    />
                  </label>
                  <div className="alarm-sound-row">
                    <div className="sound-file">
                      {sounds[DRONE_TELEMETRY_SOUND_KEY]
                        ? 'Custom sound uploaded'
                        : 'Using default notice tone'}
                    </div>
                    <div className="sound-actions">
                      <button
                        type="button"
                        className="control-chip"
                        onClick={() => playDroneTelemetry()}
                      >
                        Preview
                      </button>
                      <label className="control-chip">
                        Upload
                        <input
                          type="file"
                          accept="audio/*"
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file) {
                              uploadSound(DRONE_TELEMETRY_SOUND_KEY, file);
                              event.target.value = '';
                            }
                          }}
                          hidden
                        />
                      </label>
                      <button
                        type="button"
                        className="control-chip"
                        disabled={!sounds[DRONE_TELEMETRY_SOUND_KEY]}
                        onClick={() => removeSound(DRONE_TELEMETRY_SOUND_KEY)}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className={cardClass('alarms')}>
            <header>
              <h2>Alarm Cooldowns</h2>
              <p>Define the minimum interval between repeated alarms of the same level.</p>
            </header>
            <div className="config-card__body">
              {GAPS.map(({ key, label }) => {
                const gapValue = (localAlarm[key] ?? 0) as number;
                return (
                  <div className="config-row" key={key}>
                    <span className="config-label">{label}</span>
                    <input
                      type="number"
                      min={0}
                      step={100}
                      value={gapValue}
                      onChange={handleGapChange(key)}
                    />
                  </div>
                );
              })}
              <div className="config-row">
                <span className="config-label">Do-not-disturb start</span>
                <input
                  type="time"
                  value={localAlarm.dndStart ?? ''}
                  onChange={handleDndChange('dndStart')}
                />
              </div>
              <div className="config-row">
                <span className="config-label">Do-not-disturb end</span>
                <input
                  type="time"
                  value={localAlarm.dndEnd ?? ''}
                  onChange={handleDndChange('dndEnd')}
                />
              </div>
            </div>
          </section>

          <section className={cardClass('mail')}>
            <header>
              <h2>Mail Server</h2>
              <p>Configure SMTP delivery for invitations and alert notifications.</p>
            </header>
            <div className="config-card__body">
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={appSettings.mailEnabled}
                  onChange={(event) => updateAppSetting({ mailEnabled: event.target.checked })}
                />
                Enable outbound email
              </label>
              <div className="config-row">
                <span className="config-label">SMTP Host</span>
                <input
                  placeholder="smtp.example.com"
                  value={appSettings.mailHost ?? ''}
                  onChange={(event) => {
                    const value = event.target.value;
                    updateAppSetting({ mailHost: value.trim().length > 0 ? value.trim() : null });
                  }}
                  disabled={mailInputsDisabled}
                />
                <span className="config-hint">
                  Fully qualified domain or IP that the backend can reach, e.g. smtp.yourdomain.com.
                </span>
              </div>
              <div className="config-row">
                <span className="config-label">SMTP Port</span>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={appSettings.mailPort ?? ''}
                  onChange={(event) => {
                    const raw = event.target.value;
                    if (raw.trim().length === 0) {
                      updateAppSetting({ mailPort: null });
                      return;
                    }
                    const value = Number(raw);
                    if (!Number.isFinite(value)) {
                      return;
                    }
                    updateAppSetting({ mailPort: value });
                  }}
                  disabled={mailInputsDisabled}
                />
                <span className="config-hint">
                  Common ports: 587 for STARTTLS, 465 for SMTPS, 25 for unencrypted relays.
                </span>
              </div>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={appSettings.mailSecure}
                  onChange={(event) => updateAppSetting({ mailSecure: event.target.checked })}
                  disabled={mailInputsDisabled}
                />
                Use TLS (secure connection)
              </label>
              <span className="config-hint">
                Enable for STARTTLS/SMTPS. Disable only if your relay explicitly requires plain-text
                connections.
              </span>
              <div className="config-row">
                <span className="config-label">Username</span>
                <input
                  value={appSettings.mailUser ?? ''}
                  onChange={(event) => {
                    const value = event.target.value;
                    updateAppSetting({ mailUser: value.trim().length > 0 ? value.trim() : null });
                  }}
                  disabled={mailInputsDisabled}
                />
                <span className="config-hint">
                  Optional login for authenticated SMTP. Leave blank for IP/hostname based relays.
                </span>
              </div>
              <div className="config-row">
                <span className="config-label">From Address</span>
                <input
                  value={appSettings.mailFrom}
                  onChange={(event) => updateAppSetting({ mailFrom: event.target.value })}
                  disabled={mailInputsDisabled}
                />
                <span className="field-hint">Shown as the sender on outbound messages.</span>
              </div>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={appSettings.mailPreview}
                  onChange={(event) => updateAppSetting({ mailPreview: event.target.checked })}
                  disabled={mailInputsDisabled}
                />
                Capture mail in local preview instead of sending
              </label>
              <span className="config-hint">
                When enabled, emails are written to disk for inspection and never delivered to
                external servers.
              </span>
              <div className="config-row">
                <span className="config-label">Password</span>
                <div className="mail-password-row">
                  <input
                    type="password"
                    value={mailPasswordInput}
                    placeholder={appSettings.mailPasswordSet ? '********' : 'Enter SMTP password'}
                    onChange={(event) => setMailPasswordInput(event.target.value)}
                    disabled={mailInputsDisabled}
                  />
                  <button
                    type="button"
                    className="control-chip"
                    onClick={handleMailPasswordSave}
                    disabled={
                      mailInputsDisabled ||
                      !mailPasswordReady ||
                      updateAppSettingsMutation.isPending
                    }
                  >
                    Save Password
                  </button>
                </div>
                <span className="field-hint">
                  {appSettings.mailPasswordSet
                    ? 'A password is stored securely on the server.'
                    : 'No password stored yet.'}
                </span>
                {mailPasswordMessage ? (
                  <div
                    className={mailPasswordMessage.type === 'error' ? 'form-error' : 'form-success'}
                    role={mailPasswordMessage.type === 'error' ? 'alert' : 'status'}
                  >
                    {mailPasswordMessage.text}
                  </div>
                ) : null}
              </div>
            </div>
          </section>

          <section className={cardClass('security')}>
            <header>
              <h2>Security Defaults</h2>
              <p>Set application URLs and token expiry policies.</p>
            </header>
            <div className="config-card__body">
              <div className="config-row">
                <span className="config-label">Application URL</span>
                <input
                  type="url"
                  placeholder="https://command-center.example.com"
                  value={appSettings.securityAppUrl}
                  onChange={(event) => updateAppSetting({ securityAppUrl: event.target.value })}
                />
                <span className="field-hint">Used in email templates and deep links.</span>
              </div>
              <div className="config-row">
                <span className="config-label">Invitation expiry (hours)</span>
                <input
                  type="number"
                  min={1}
                  value={appSettings.invitationExpiryHours}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (!Number.isFinite(value)) return;
                    updateAppSetting({ invitationExpiryHours: value });
                  }}
                />
              </div>
              <div className="config-row">
                <span className="config-label">Password reset expiry (hours)</span>
                <input
                  type="number"
                  min={1}
                  value={appSettings.passwordResetExpiryHours}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (!Number.isFinite(value)) return;
                    updateAppSetting({ passwordResetExpiryHours: value });
                  }}
                />
              </div>
            </div>
          </section>

          <section className={cardClass('appearance')}>
            <header>
              <h2>Theme & Alerts</h2>
              <p>Choose a preset for the entire interface and fine-tune alert markers.</p>
            </header>
            <div className="config-card__body">
              <div className="theme-preset-section">
                <h3>Theme Presets</h3>
                <p className="field-hint">
                  Pick from curated palettes for both light and dark modes. Presets apply to the
                  entire application shell.
                </p>
                <div className="theme-preset-grid">
                  {themePresetOptions.map((preset) => {
                    const isSelected = preset.id === themePreset;
                    const isPending =
                      updateThemePresetMutation.isPending &&
                      updateThemePresetMutation.variables === preset.id;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        className={`theme-preset-card${isSelected ? ' is-selected' : ''}`}
                        onClick={() => handleThemePresetSelect(preset.id)}
                        disabled={isSelected || isPending}
                      >
                        <div className="theme-preset-card__header">
                          <div>
                            <h4>{preset.label}</h4>
                            <p>{preset.description}</p>
                          </div>
                          {isSelected ? <span className="theme-preset-badge">Active</span> : null}
                        </div>
                        <div className="theme-preset-card__swatches">
                          <div style={{ background: preset.palette.accent.dark.background }} />
                          <div style={{ background: preset.palette.light.background }} />
                          <div style={{ background: preset.palette.dark.background }} />
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="alert-color-section">
                <h3>Alert Colors</h3>
                <p className="field-hint">
                  Adjust the live map marker and radius palette for each alarm level.
                </p>
                <div className="alert-color-list">
                  {ALERT_COLOR_FIELDS.map((field) => renderAlertColorRow(field))}
                </div>
              </div>
            </div>
          </section>

          <section className={cardClass('firewall')}>
            <header>
              <h2>Firewall</h2>
              <p>Control geo filtering, login lockouts, and manual block rules.</p>
            </header>
            <div className="config-card__body">
              {firewallOverviewQuery.isLoading && !firewallForm ? (
                <p className="form-hint">Loading firewall configuration...</p>
              ) : firewallForm ? (
                <>
                  <form className="config-form" onSubmit={handleFirewallSubmit}>
                    <div className="config-row">
                      <span className="config-label">Status</span>
                      <label className="switch">
                        <input
                          type="checkbox"
                          checked={firewallForm.enabled}
                          onChange={(event) =>
                            handleFirewallFieldChange('enabled', event.target.checked)
                          }
                        />
                        <span>{firewallForm.enabled ? 'Enabled' : 'Disabled'}</span>
                      </label>
                      <span className="field-hint">
                        When disabled, all firewall rules and geo checks are bypassed.
                      </span>
                    </div>
                    <div className="config-row">
                      <span className="config-label">Default policy</span>
                      <select
                        value={firewallForm.defaultPolicy}
                        onChange={(event) =>
                          handleFirewallFieldChange(
                            'defaultPolicy',
                            event.target.value as FirewallPolicy,
                          )
                        }
                      >
                        <option value="ALLOW">Allow</option>
                        <option value="DENY">Deny</option>
                      </select>
                      <span className="field-hint">
                        Deny blocks any request that does not match an allow rule.
                      </span>
                    </div>
                    <div className="config-row">
                      <span className="config-label">Geo policy</span>
                      <select
                        value={firewallForm.geoMode}
                        onChange={(event) =>
                          handleFirewallFieldChange(
                            'geoMode',
                            event.target.value as FirewallGeoMode,
                          )
                        }
                      >
                        <option value="DISABLED">Disabled</option>
                        <option value="ALLOW_LIST">Allow list</option>
                        <option value="BLOCK_LIST">Block list</option>
                      </select>
                      <span className="field-hint">
                        Allow list admits only the specified countries. Block list denies matches.
                      </span>
                    </div>
                    <div className="config-row">
                      <span className="config-label">Allowed countries</span>
                      <textarea
                        rows={4}
                        placeholder="US&#10;NO&#10;GB"
                        value={firewallForm.allowedCountries}
                        onChange={(event) =>
                          handleFirewallFieldChange('allowedCountries', event.target.value)
                        }
                      />
                      <span className="field-hint">
                        ISO country codes separated by commas or new lines. Leave empty to allow
                        all.
                      </span>
                    </div>
                    <div className="config-row">
                      <span className="config-label">Blocked countries</span>
                      <textarea
                        rows={4}
                        placeholder="CN&#10;RU"
                        value={firewallForm.blockedCountries}
                        onChange={(event) =>
                          handleFirewallFieldChange('blockedCountries', event.target.value)
                        }
                      />
                      <span className="field-hint">
                        ISO country codes to block when the geo policy is in block-list mode.
                      </span>
                    </div>
                    <div className="config-row">
                      <span className="config-label">IP allow list</span>
                      <textarea
                        rows={4}
                        placeholder="192.0.2.10&#10;10.0.0.0/16"
                        value={firewallForm.ipAllowList}
                        onChange={(event) =>
                          handleFirewallFieldChange('ipAllowList', event.target.value)
                        }
                      />
                      <span className="field-hint">
                        Optional. If populated, only addresses or CIDR ranges listed here may reach
                        the backend.
                      </span>
                    </div>
                    <div className="config-row">
                      <span className="config-label">IP block list</span>
                      <textarea
                        rows={4}
                        placeholder="203.0.113.5&#10;fd00::/8"
                        value={firewallForm.ipBlockList}
                        onChange={(event) =>
                          handleFirewallFieldChange('ipBlockList', event.target.value)
                        }
                      />
                      <span className="field-hint">
                        Addresses or CIDR ranges that are always blocked, regardless of other rules.
                      </span>
                    </div>
                    <div className="config-row">
                      <span className="config-label">Failed attempts (count)</span>
                      <input
                        type="number"
                        min={1}
                        max={100}
                        value={firewallForm.failThreshold}
                        onChange={(event) =>
                          handleFirewallFieldChange('failThreshold', event.target.value)
                        }
                      />
                      <span className="field-hint">
                        Consecutive authentication failures before an IP is rate limited.
                      </span>
                    </div>
                    <div className="config-row">
                      <span className="config-label">Failure window (seconds)</span>
                      <input
                        type="number"
                        min={30}
                        max={86400}
                        value={firewallForm.failWindowSeconds}
                        onChange={(event) =>
                          handleFirewallFieldChange('failWindowSeconds', event.target.value)
                        }
                      />
                      <span className="field-hint">
                        Rolling time window for counting failed authentication attempts.
                      </span>
                    </div>
                    <div className="config-row">
                      <span className="config-label">Ban duration (seconds)</span>
                      <input
                        type="number"
                        min={60}
                        max={604800}
                        value={firewallForm.banDurationSeconds}
                        onChange={(event) =>
                          handleFirewallFieldChange('banDurationSeconds', event.target.value)
                        }
                      />
                      <span className="field-hint">
                        How long an offending IP remains blocked after exceeding the threshold.
                      </span>
                    </div>
                    {firewallError ? <div className="form-error">{firewallError}</div> : null}
                    {firewallMessage ? (
                      <div className="form-feedback">{firewallMessage}</div>
                    ) : null}
                    <div className="controls-row">
                      <button
                        type="submit"
                        className="submit-button"
                        disabled={!firewallDirty || firewallSaving}
                      >
                        {firewallSaving
                          ? 'Saving...'
                          : firewallDirty
                            ? 'Save firewall settings'
                            : 'Firewall up to date'}
                      </button>
                    </div>
                  </form>
                  {firewallStats ? (
                    <div className="firewall-stats">
                      <div>
                        <span className="muted">Rules</span>
                        <strong>{firewallStats.totalRules}</strong>
                      </div>
                      <div>
                        <span className="muted">Blocked rules</span>
                        <strong>{firewallStats.totalBlockedRules}</strong>
                      </div>
                      <div>
                        <span className="muted">Auth failures (24h)</span>
                        <strong>{firewallStats.authFailuresLast24h}</strong>
                      </div>
                      <div>
                        <span className="muted">Blocks (24h)</span>
                        <strong>{firewallStats.blockedLast24h}</strong>
                      </div>
                    </div>
                  ) : null}
                  {firewallConfig ? (
                    <p className="field-hint">
                      Last updated {formatDateTime(firewallConfig.updatedAt)}
                    </p>
                  ) : null}
                  <details
                    className="firewall-log-viewer"
                    open={firewallLogsOpen}
                    onToggle={(event) => setFirewallLogsOpen(event.currentTarget.open)}
                  >
                    <summary>
                      Recent firewall activity
                      <span className="firewall-log-viewer__summary-meta">
                        {firewallLogsQuery.isFetching
                          ? 'Refreshing...'
                          : `${firewallStats?.totalLogs ?? 0} entries`}
                      </span>
                    </summary>
                    <div className="firewall-log-viewer__body">
                      <div className="firewall-log-viewer__toolbar">
                        <button
                          type="button"
                          className="control-chip control-chip--ghost"
                          onClick={() => firewallLogsQuery.refetch()}
                          disabled={firewallLogsQuery.isFetching}
                        >
                          {firewallLogsQuery.isFetching ? 'Loading...' : 'Refresh'}
                        </button>
                        <button
                          type="button"
                          className="control-chip"
                          onClick={handleFirewallLogsExport}
                          disabled={firewallLogs.length === 0}
                        >
                          Export CSV
                        </button>
                      </div>
                      {firewallLogsQuery.isLoading ? (
                        <p className="form-hint">Loading firewall logs...</p>
                      ) : firewallLogsQuery.isError ? (
                        <p className="form-error">{firewallLogsError}</p>
                      ) : firewallLogs.length === 0 ? (
                        <p className="form-hint">No firewall events recorded yet.</p>
                      ) : (
                        <ul className="firewall-log-list">
                          {firewallLogs.map((log) => (
                            <li
                              key={log.id}
                              className={`firewall-log-entry${log.blocked ? ' firewall-log-entry--blocked' : ''}`}
                            >
                              <div className="firewall-log-entry__header">
                                <span className="firewall-log-entry__ip">{log.ip}</span>
                                <span
                                  className={`firewall-log-entry__badge firewall-log-entry__badge--${log.outcome.toLowerCase()}`}
                                >
                                  {log.outcome.replace(/_/g, ' ')}
                                </span>
                              </div>
                              <div className="firewall-log-entry__meta">
                                <span>{formatDateTime(log.lastSeen)}</span>
                                <span>
                                  {log.method.toUpperCase()} - {log.path}
                                </span>
                                {log.reason ? <span>{log.reason}</span> : null}
                              </div>
                              <dl className="firewall-log-entry__grid">
                                <div>
                                  <dt>Attempts</dt>
                                  <dd>{log.attempts}</dd>
                                </div>
                                <div>
                                  <dt>Blocked</dt>
                                  <dd>{log.blocked ? 'Yes' : 'No'}</dd>
                                </div>
                                {log.country ? (
                                  <div>
                                    <dt>Country</dt>
                                    <dd>{log.country}</dd>
                                  </div>
                                ) : null}
                                {log.userAgent ? (
                                  <div className="firewall-log-entry__ua">
                                    <dt>User Agent</dt>
                                    <dd>{log.userAgent}</dd>
                                  </div>
                                ) : null}
                                {log.ruleId ? (
                                  <div>
                                    <dt>Rule</dt>
                                    <dd>{log.ruleId}</dd>
                                  </div>
                                ) : null}
                              </dl>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </details>
                  <details
                    className="firewall-log-viewer"
                    open={firewallJailOpen}
                    onToggle={(event) => setFirewallJailOpen(event.currentTarget.open)}
                  >
                    <summary>
                      Jailed IPs
                      <span className="firewall-log-viewer__summary-meta">
                        {firewallJailedQuery.isFetching
                          ? 'Refreshing...'
                          : `${jailedRules.length} entries`}
                      </span>
                    </summary>
                    <div className="firewall-log-viewer__body">
                      {firewallJailedQuery.isLoading ? (
                        <p className="form-hint">Loading jailed IPsÃ¢â‚¬Â¦</p>
                      ) : firewallJailedQuery.isError ? (
                        <p className="form-error">{jailedError}</p>
                      ) : jailedRules.length === 0 ? (
                        <p className="form-hint">No IPs are currently jailed.</p>
                      ) : (
                        <table className="firewall-jail-table">
                          <thead>
                            <tr>
                              <th>IP</th>
                              <th>Reason</th>
                              <th>Expires</th>
                              <th>Actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {jailedRules.map((rule) => (
                              <tr key={rule.id}>
                                <td>{rule.ip}</td>
                                <td>{rule.reason ?? 'Automatic block'}</td>
                                <td>{rule.expiresAt ? formatDateTime(rule.expiresAt) : 'Auto'}</td>
                                <td>
                                  <button
                                    type="button"
                                    className="control-chip control-chip--ghost"
                                    onClick={() => handleUnblockJailed(rule.id)}
                                    disabled={unblockJailedMutation.isPending}
                                  >
                                    Unblock
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  </details>
                </>
              ) : (
                <p className="form-error">
                  Unable to load firewall configuration. Check API connectivity.
                </p>
              )}
            </div>
          </section>

          <section className={cardClass('sites')}>
            <header>
              <h2>Site Settings</h2>
              <p>Update site names and colors for multi-site deployments.</p>
              {runtimeSiteId ? (
                <p className="config-hint">
                  This backend instance reports as site <strong>{runtimeSiteId}</strong>.
                </p>
              ) : null}
            </header>
            <div className="config-card__body">
              {sitesQuery.isLoading ? (
                <div>Loading site metadata...</div>
              ) : sitesQuery.isError ? (
                <div className="form-error">Unable to load site list.</div>
              ) : siteSettings.length === 0 ? (
                <div className="empty-state">
                  <div>No sites found. Create a site in the database to manage settings here.</div>
                </div>
              ) : (
                siteSettings.map((site) => {
                  const cardClassName = `config-subcard${
                    site.id === runtimeSiteId ? ' config-subcard--active-runtime' : ''
                  }`;
                  return (
                    <div key={site.id} className={cardClassName}>
                      <div className="config-row">
                        <span className="config-label">Site ID</span>
                        <span className="muted">
                          {site.id}
                          {site.id === runtimeSiteId ? (
                            <>
                              {' '}
                              <span
                                className="status-pill status-active"
                                title="Current backend runtime site"
                              >
                                Active runtime
                              </span>
                            </>
                          ) : null}
                        </span>
                      </div>
                      <div className="config-row">
                        <span className="config-label">Name</span>
                        <input
                          value={site.name}
                          onChange={(event) =>
                            updateSiteSetting(site.id, { name: event.target.value })
                          }
                          onBlur={(event) => {
                            const trimmed = event.target.value.trim();
                            updateSiteSetting(site.id, { name: trimmed });
                            commitSiteSetting(site.id, { name: trimmed });
                          }}
                        />
                      </div>
                      <div className="config-row">
                        <span className="config-label">Display Color</span>
                        <div className="site-color-row">
                          <input
                            type="color"
                            value={site.color || '#0f62fe'}
                            onChange={(event) => {
                              const color = event.target.value;
                              updateSiteSetting(site.id, { color });
                              commitSiteSetting(site.id, { color });
                            }}
                            aria-label={`${site.name || site.id} color`}
                          />
                          <input
                            value={site.color ?? ''}
                            placeholder="#0f62fe"
                            onChange={(event) =>
                              updateSiteSetting(site.id, { color: event.target.value })
                            }
                            onBlur={(event) => {
                              const raw = event.target.value.trim();
                              if (!raw) {
                                return;
                              }
                              const sanitized = raw.startsWith('#') ? raw : `#${raw}`;
                              updateSiteSetting(site.id, { color: sanitized });
                              commitSiteSetting(site.id, { color: sanitized });
                            }}
                          />
                        </div>
                      </div>
                      <div className="config-row">
                        <span className="config-label">Region</span>
                        <input
                          value={site.region ?? ''}
                          placeholder="Optional"
                          onChange={(event) =>
                            updateSiteSetting(site.id, {
                              region: event.target.value === '' ? null : event.target.value,
                            })
                          }
                          onBlur={(event) =>
                            commitSiteSetting(site.id, {
                              region: event.target.value === '' ? null : event.target.value.trim(),
                            })
                          }
                        />
                      </div>
                      <div className="config-row">
                        <span className="config-label">Country</span>
                        <input
                          value={site.country ?? ''}
                          placeholder="Optional"
                          onChange={(event) =>
                            updateSiteSetting(site.id, {
                              country: event.target.value === '' ? null : event.target.value,
                            })
                          }
                          onBlur={(event) =>
                            commitSiteSetting(site.id, {
                              country: event.target.value === '' ? null : event.target.value.trim(),
                            })
                          }
                        />
                      </div>
                      <div className="config-row">
                        <span className="config-label">City</span>
                        <input
                          value={site.city ?? ''}
                          placeholder="Optional"
                          onChange={(event) =>
                            updateSiteSetting(site.id, {
                              city: event.target.value === '' ? null : event.target.value,
                            })
                          }
                          onBlur={(event) =>
                            commitSiteSetting(site.id, {
                              city: event.target.value === '' ? null : event.target.value.trim(),
                            })
                          }
                        />
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </section>

          <section className={cardClass('serial')}>
            <header>
              <h2>Serial Connection</h2>
              <p>Review connection defaults and rate limits.</p>
              {runtimeSiteLabel ? (
                <p className="config-hint">
                  Settings in this section apply to runtime site <strong>{runtimeSiteLabel}</strong>
                  .
                </p>
              ) : null}
            </header>
            <div className="config-card__body">
              <div className="controls-row config-header-controls serial-card-controls">
                <button
                  type="button"
                  className="control-chip"
                  onClick={handleSerialToggle}
                  disabled={serialToggleDisabled}
                >
                  {serialToggleLabel}
                </button>
                <div className="config-header-controls__pair">
                  <button
                    type="button"
                    className="control-chip"
                    onClick={handleTestSerial}
                    disabled={serialTestMutation.isPending}
                  >
                    {serialTestMutation.isPending ? 'Testing...' : 'Test Serial'}
                  </button>
                  <button type="button" className="control-chip" onClick={handleJsonFeatureNotice}>
                    Import JSON
                  </button>
                </div>
                <button type="button" className="control-chip" onClick={handleJsonFeatureNotice}>
                  Export JSON
                </button>
              </div>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={serialConfig.enabled}
                  onChange={(event) => updateSerialSetting({ enabled: event.target.checked })}
                />
                Enable serial auto-connect
              </label>
              <span className="config-hint">
                When enabled, the ingest service reconnects automatically using the settings below.
              </span>
              <div className="serial-actions">
                <button
                  type="button"
                  className="control-chip"
                  onClick={() => serialPortsQuery.refetch()}
                  disabled={serialPortsQuery.isFetching}
                >
                  {serialPortsQuery.isFetching ? 'Refreshing ports...' : 'Refresh Ports'}
                </button>
                <button
                  type="button"
                  className="control-chip control-chip--danger"
                  onClick={handleSerialReset}
                  disabled={resetSerialConfigMutation.isPending}
                >
                  {resetSerialConfigMutation.isPending ? 'Resetting...' : 'Reset to Defaults'}
                </button>
              </div>
              <div className="config-row">
                <span className="config-label">Device Path</span>
                <div className="serial-device-picker">
                  <select
                    value={serialPortSelectValue}
                    onChange={handleSerialPortSelect}
                    disabled={serialPortsQuery.isLoading}
                  >
                    <option value="">Select detected port</option>
                    {serialPorts.map((port) => (
                      <option key={port.path} value={port.path}>
                        {port.path}
                        {port.manufacturer ? ` (${port.manufacturer})` : ''}
                      </option>
                    ))}
                  </select>
                  <input
                    placeholder="/dev/ttyUSB0"
                    value={serialConfig.devicePath ?? ''}
                    onChange={(event) =>
                      updateSerialSetting({ devicePath: event.target.value || null })
                    }
                  />
                </div>
                {serialPortsError ? (
                  <span className="form-error">{serialPortsError}</span>
                ) : (
                  <span className="config-hint">
                    Path to the radio / serial bridge. On Windows use COM ports, on Linux use
                    /dev/tty*.
                  </span>
                )}
              </div>
              <div className="config-row">
                <span className="config-label">Baud Rate</span>
                <input
                  type="number"
                  placeholder="115200"
                  value={serialConfig.baud ?? ''}
                  onChange={(event) => {
                    const raw = event.target.value;
                    if (raw === '') {
                      updateSerialSetting({ baud: null });
                      return;
                    }
                    const value = Number(raw);
                    if (!Number.isFinite(value)) return;
                    updateSerialSetting({ baud: value });
                  }}
                />
                <span className="config-hint">
                  Must match the firmware setting on the connected device (115200 for Meshtastic).
                </span>
              </div>
              <div className="config-row">
                <span className="config-label">Protocol</span>
                <select
                  value={appSettings.protocol}
                  onChange={(event) => updateAppSetting({ protocol: event.target.value })}
                >
                  {PROTOCOL_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <span className="config-hint">
                  Select the parser that matches the incoming frame format on the wire.
                </span>
              </div>
              <div className="config-row">
                <span className="config-label">Data Bits</span>
                <input
                  type="number"
                  min={5}
                  max={9}
                  value={serialConfig.dataBits ?? ''}
                  onChange={(event) => {
                    const raw = event.target.value;
                    if (raw === '') {
                      updateSerialSetting({ dataBits: null });
                      return;
                    }
                    const value = Number(raw);
                    if (!Number.isFinite(value)) return;
                    updateSerialSetting({ dataBits: value });
                  }}
                />
                <span className="config-hint">
                  Most serial radios use 8 data bits. Adjust only for specialized hardware.
                </span>
              </div>
              <div className="config-row">
                <span className="config-label">Parity</span>
                <select
                  value={serialConfig.parity ?? 'none'}
                  onChange={(event) => updateSerialSetting({ parity: event.target.value })}
                >
                  {PARITY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <span className="config-hint">
                  Leave as None unless the device requires parity bits for error checking.
                </span>
              </div>
              <div className="config-row">
                <span className="config-label">Stop Bits</span>
                <select
                  value={serialConfig.stopBits ?? 1}
                  onChange={(event) =>
                    updateSerialSetting({ stopBits: Number(event.target.value) })
                  }
                >
                  {STOP_BITS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <span className="config-hint">
                  Typically 1; some equipment expects 2 stop bits on slower links.
                </span>
              </div>
              <div className="config-row">
                <span className="config-label">Delimiter</span>
                <input
                  placeholder="auto (default)"
                  value={serialConfig.delimiter ?? ''}
                  onChange={(event) =>
                    updateSerialSetting({ delimiter: event.target.value || null })
                  }
                  title="Use 'auto' to try CRLF and LF automatically. Common values: \n, \r\n."
                />
                <span className="config-hint">
                  Line ending used to split incoming frames. Leave blank for automatic detection.
                </span>
              </div>
              <div className="config-row">
                <span className="config-label">Reconnect Base (ms)</span>
                <input
                  type="number"
                  value={serialConfig.reconnectBaseMs ?? ''}
                  onChange={(event) => {
                    const raw = event.target.value;
                    if (raw === '') {
                      updateSerialSetting({ reconnectBaseMs: null });
                      return;
                    }
                    const value = Number(raw);
                    if (!Number.isFinite(value)) return;
                    updateSerialSetting({ reconnectBaseMs: value });
                  }}
                />
                <span className="config-hint">
                  Initial backoff delay before retrying a disconnected serial link.
                </span>
              </div>
              <div className="config-row">
                <span className="config-label">Reconnect Max (ms)</span>
                <input
                  type="number"
                  value={serialConfig.reconnectMaxMs ?? ''}
                  onChange={(event) => {
                    const raw = event.target.value;
                    if (raw === '') {
                      updateSerialSetting({ reconnectMaxMs: null });
                      return;
                    }
                    const value = Number(raw);
                    if (!Number.isFinite(value)) return;
                    updateSerialSetting({ reconnectMaxMs: value });
                  }}
                />
                <span className="config-hint">
                  Upper bound for exponential backoff between reconnection attempts.
                </span>
              </div>
              <div className="config-row">
                <span className="config-label">Reconnect Jitter</span>
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={serialConfig.reconnectJitter ?? ''}
                  onChange={(event) => {
                    const raw = event.target.value;
                    if (raw === '') {
                      updateSerialSetting({ reconnectJitter: null });
                      return;
                    }
                    const value = Number(raw);
                    if (!Number.isFinite(value)) return;
                    updateSerialSetting({ reconnectJitter: value });
                  }}
                />
              </div>
              <div className="config-row">
                <span className="config-label">Reconnect Attempts</span>
                <input
                  type="number"
                  min={0}
                  value={serialConfig.reconnectMaxAttempts ?? ''}
                  onChange={(event) => {
                    const raw = event.target.value;
                    if (raw === '') {
                      updateSerialSetting({ reconnectMaxAttempts: null });
                      return;
                    }
                    const value = Number(raw);
                    if (!Number.isFinite(value)) return;
                    updateSerialSetting({ reconnectMaxAttempts: value });
                  }}
                />
              </div>
            </div>
          </section>

          <section className={cardClass('tak')}>
            <header>
              <h2>TAK Bridge</h2>
              <p>Stream nodes, alerts, and command acknowledgements into your TAK ecosystem.</p>
            </header>
            <div className="config-card__body">
              {takConfigQuery.isLoading ? (
                <div>Loading TAK configuration...</div>
              ) : takConfigError ? (
                <div className="form-error" role="alert">
                  {takConfigError.message}
                </div>
              ) : !takConfig ? (
                <div className="form-hint">
                  TAK configuration is unavailable. Ensure database migrations have run.
                </div>
              ) : (
                <>
                  {takNotice ? (
                    <div
                      className={
                        takNotice.type === 'error'
                          ? 'form-error'
                          : takNotice.type === 'success'
                            ? 'form-success'
                            : 'form-hint'
                      }
                      role={takNotice.type === 'error' ? 'alert' : 'status'}
                    >
                      {takNotice.text}
                    </div>
                  ) : null}
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={takConfig.enabled}
                      onChange={(event) => {
                        const enabled = event.target.checked;
                        updateTakSetting({ enabled });
                        commitTakConfig({ enabled });
                      }}
                    />
                    Enable TAK bridge
                  </label>
                  <span className="config-hint">
                    When enabled, the backend emits Cursor-on-Target feeds for connected TAK
                    clients.
                  </span>
                  <div className="config-subcard">
                    <h3>Streams</h3>
                    <p className="config-hint">
                      Choose which Command Center events syndicate into TAK. Disable feeds you do
                      not need on the common operational picture.
                    </p>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={takConfig.streamNodes}
                        onChange={handleTakToggle('streamNodes')}
                        disabled={takToggleDisabled}
                      />
                      Node telemetry (positions)
                    </label>
                    <span className="config-hint">
                      Broadcast live node latitude/longitude updates as friendly unit markers.
                    </span>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={takConfig.streamTargets}
                        onChange={handleTakToggle('streamTargets')}
                        disabled={takToggleDisabled}
                      />
                      Target detections & triangulation
                    </label>
                    <span className="config-hint">
                      Publishes MAC detections, triangulation estimates, and confidence metadata.
                    </span>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={takConfig.streamCommandAcks}
                        onChange={handleTakToggle('streamCommandAcks')}
                        disabled={takToggleDisabled}
                      />
                      Command acknowledgements
                    </label>
                    <span className="config-hint">
                      Emits `ack` Cursor-on-Target events when nodes confirm command execution.
                    </span>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={takConfig.streamCommandResults}
                        onChange={handleTakToggle('streamCommandResults')}
                        disabled={takToggleDisabled}
                      />
                      Command results / telemetry blocks
                    </label>
                    <span className="config-hint">
                      Forwards command result payloads (STATUS, BASELINE, TRIANGULATE, etc.) to TAK.
                    </span>
                  </div>
                  <div className="config-subcard">
                    <h4>Alert severities</h4>
                    <p className="config-hint">
                      Filter which alert severities ring out on TAK. Higher severity still respects
                      the per-level toggles below.
                    </p>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={takConfig.streamAlertInfo}
                        onChange={handleTakToggle('streamAlertInfo')}
                        disabled={takToggleDisabled}
                      />
                      Info
                    </label>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={takConfig.streamAlertNotice}
                        onChange={handleTakToggle('streamAlertNotice')}
                        disabled={takToggleDisabled}
                      />
                      Notice
                    </label>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={takConfig.streamAlertAlert}
                        onChange={handleTakToggle('streamAlertAlert')}
                        disabled={takToggleDisabled}
                      />
                      Alert
                    </label>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={takConfig.streamAlertCritical}
                        onChange={handleTakToggle('streamAlertCritical')}
                        disabled={takToggleDisabled}
                      />
                      Critical
                    </label>
                  </div>
                  <div className="config-row">
                    <span className="config-label">Protocol</span>
                    <select
                      value={takConfig.protocol}
                      onChange={(event) => {
                        const protocol = event.target.value as TakProtocol;
                        updateTakSetting({ protocol });
                        commitTakConfig({ protocol });
                      }}
                    >
                      {TAK_PROTOCOL_OPTIONS.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                    <span className="config-hint">
                      UDP for LAN multicast, TCP/HTTPS for TAK servers or gateways.
                    </span>
                  </div>
                  <div className="config-row">
                    <span className="config-label">Host</span>
                    <input
                      placeholder="tak.example.local"
                      value={takConfig.host ?? ''}
                      onChange={(event) => updateTakSetting({ host: event.target.value })}
                      onBlur={(event) => {
                        const raw = event.target.value.trim();
                        commitTakConfig({ host: raw.length > 0 ? raw : null });
                      }}
                    />
                    <span className="config-hint">
                      Hostname or IP of the TAK server (omit scheme).
                    </span>
                  </div>
                  <div className="config-row">
                    <span className="config-label">Port</span>
                    <input
                      type="number"
                      min={1}
                      max={65535}
                      value={takConfig.port ?? ''}
                      onChange={(event) => {
                        const raw = event.target.value;
                        updateTakSetting({ port: raw === '' ? null : Number(raw) });
                      }}
                      onBlur={(event) => {
                        const raw = event.target.value;
                        if (raw === '') {
                          commitTakConfig({ port: null });
                          return;
                        }
                        const value = Number(raw);
                        if (Number.isFinite(value)) {
                          commitTakConfig({ port: value });
                        }
                      }}
                    />
                    <span className="config-hint">
                      Defaults: UDP 6969, TCP 8088, HTTPS 8443 (change to match your TAK core).
                    </span>
                  </div>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={takConfig.tlsEnabled}
                      onChange={(event) => {
                        const tlsEnabled = event.target.checked;
                        updateTakSetting({ tlsEnabled });
                        commitTakConfig({ tlsEnabled });
                      }}
                    />
                    Require TLS certificates
                  </label>
                  <span className="config-hint">
                    Provide CA, client certificate, and key paths when connecting over TLS or HTTPS.
                  </span>
                  <div className="config-row">
                    <span className="config-label">CA File</span>
                    <input
                      placeholder="/etc/tak/ca.pem"
                      value={takConfig.cafile ?? ''}
                      onChange={(event) => updateTakSetting({ cafile: event.target.value })}
                      onBlur={(event) => {
                        const raw = event.target.value.trim();
                        commitTakConfig({ cafile: raw.length > 0 ? raw : null });
                      }}
                    />
                  </div>
                  <div className="config-row">
                    <span className="config-label">Client Certificate</span>
                    <input
                      placeholder="/etc/tak/client.pem"
                      value={takConfig.certfile ?? ''}
                      onChange={(event) => updateTakSetting({ certfile: event.target.value })}
                      onBlur={(event) => {
                        const raw = event.target.value.trim();
                        commitTakConfig({ certfile: raw.length > 0 ? raw : null });
                      }}
                    />
                  </div>
                  <div className="config-row">
                    <span className="config-label">Client Key</span>
                    <input
                      placeholder="/etc/tak/client.key"
                      value={takConfig.keyfile ?? ''}
                      onChange={(event) => updateTakSetting({ keyfile: event.target.value })}
                      onBlur={(event) => {
                        const raw = event.target.value.trim();
                        commitTakConfig({ keyfile: raw.length > 0 ? raw : null });
                      }}
                    />
                  </div>
                  <div className="config-row">
                    <span className="config-label">Username</span>
                    <input
                      placeholder="tak-agent"
                      value={takConfig.username ?? ''}
                      onChange={(event) => updateTakSetting({ username: event.target.value })}
                      onBlur={(event) => {
                        const raw = event.target.value.trim();
                        commitTakConfig({ username: raw.length > 0 ? raw : null });
                      }}
                    />
                    <span className="config-hint">
                      Optional basic auth username when relaying through TAK Enterprise.
                    </span>
                  </div>
                  <div className="config-row">
                    <span className="config-label">Password</span>
                    <div className="mqtt-password-row">
                      <input
                        type="password"
                        value={takPasswordInput}
                        onChange={(event) => setTakPasswordInput(event.target.value)}
                        placeholder="Enter new password"
                      />
                      <button
                        type="button"
                        className="control-chip"
                        onClick={handleTakPasswordSave}
                        disabled={
                          takPasswordInput.trim().length === 0 || updateTakConfigMutation.isPending
                        }
                      >
                        Save Password
                      </button>
                      <button
                        type="button"
                        className="control-chip"
                        onClick={handleTakPasswordClear}
                        disabled={updateTakConfigMutation.isPending}
                      >
                        Clear Password
                      </button>
                    </div>
                    <span className="config-hint">
                      Password is write-only. Use Clear to remove credentials from the backend.
                    </span>
                  </div>
                  <div className="config-row">
                    <span className="config-label">API Key</span>
                    <input
                      placeholder="Optional TAK API key"
                      value={takConfig.apiKey ?? ''}
                      onChange={(event) => updateTakSetting({ apiKey: event.target.value })}
                      onBlur={(event) => {
                        const raw = event.target.value.trim();
                        commitTakConfig({ apiKey: raw.length > 0 ? raw : null });
                      }}
                    />
                  </div>
                  <div className="config-row">
                    <span className="config-label">Send CoT Test</span>
                    <div className="config-value">
                      <textarea
                        rows={5}
                        value={takSendPayload}
                        onChange={(event) => setTakSendPayload(event.target.value)}
                        placeholder="<event ...>Paste raw Cursor-on-Target XML here</event>"
                      />
                      <div className="controls-row">
                        <button
                          type="button"
                          className="control-chip"
                          onClick={() => {
                            const trimmed = takSendPayload.trim();
                            if (trimmed.length === 0 || takSendMutation.isPending) {
                              return;
                            }
                            takSendMutation.mutate(trimmed);
                          }}
                          disabled={takSendPayload.trim().length === 0 || takSendMutation.isPending}
                        >
                          {takSendMutation.isPending ? 'Sending...' : 'Send Payload'}
                        </button>
                        <button
                          type="button"
                          className="control-chip"
                          onClick={() => setTakSendPayload('')}
                          disabled={takSendMutation.isPending || takSendPayload.length === 0}
                        >
                          Clear
                        </button>
                      </div>
                      <span className="config-hint">
                        Useful for validating the TAK bridge end-to-end. The payload is forwarded
                        exactly as entered.
                      </span>
                    </div>
                  </div>
                  <div className="config-row">
                    <span className="config-label">Status</span>
                    <div className="config-value">
                      <div>Last connected: {takLastConnected}</div>
                      <div className="controls-row">
                        <button
                          type="button"
                          className="control-chip"
                          onClick={() => reloadTakMutation.mutate()}
                          disabled={reloadTakMutation.isPending}
                        >
                          {reloadTakMutation.isPending ? 'Restarting...' : 'Restart Bridge'}
                        </button>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          </section>
          <section className={cardClass('mqtt')}>
            <header>
              <h2>MQTT Federation</h2>
              <p>Configure broker connectivity for remote sites and command replication.</p>
            </header>
            <div className="config-card__body">
              {mqttSitesQuery.isLoading ? (
                <div>Loading MQTT configuration...</div>
              ) : mqttSitesQuery.isError ? (
                <div className="form-error">
                  Unable to load MQTT configuration. Check backend logs.
                </div>
              ) : mqttConfigs.length === 0 ? (
                <div className="empty-state">
                  <div>No MQTT sites configured yet. Add a site to enable federation.</div>
                </div>
              ) : (
                mqttConfigs.map((cfg) => {
                  const status = mqttStatusMap[cfg.siteId];
                  const state = status?.state ?? 'not_configured';
                  const statusClassName = `status-pill status-${state}`;
                  const statusLabel = formatMqttStatusState(state);
                  const isLocalSite = cfg.siteId === runtimeSiteId;
                  const notice = mqttNotices[cfg.siteId];
                  const isTesting =
                    mqttAction?.mode === 'test' &&
                    mqttAction.siteId === cfg.siteId &&
                    testMqttMutation.isPending;
                  const isConnecting =
                    mqttAction?.mode === 'connect' &&
                    mqttAction.siteId === cfg.siteId &&
                    reconnectMqttMutation.isPending;
                  const statusUpdatedAt = status?.updatedAt
                    ? formatDateTime(status.updatedAt)
                    : null;

                  return (
                    <div key={cfg.siteId} className="config-subcard">
                      <div className="config-row">
                        <span className="config-label">Site</span>
                        <div className="config-value">
                          <strong>{cfg.site?.name ?? cfg.siteId}</strong>
                          <span className="muted">
                            {cfg.siteId}
                            {isLocalSite ? (
                              <>
                                {' '}
                                <span
                                  className="status-pill status-active"
                                  title="Current backend runtime site"
                                >
                                  Active runtime
                                </span>
                              </>
                            ) : null}
                          </span>
                        </div>
                      </div>
                      <div className="config-row">
                        <span className="config-label">Connection</span>
                        <div className="config-value">
                          <span className={statusClassName}>{statusLabel}</span>
                          {statusUpdatedAt ? (
                            <span className="config-hint">Updated {statusUpdatedAt}</span>
                          ) : null}
                          {status?.message ? (
                            <div className="config-hint">{status.message}</div>
                          ) : null}
                          {notice ? (
                            <div
                              className={
                                notice.type === 'error'
                                  ? 'form-error'
                                  : notice.type === 'success'
                                    ? 'form-success'
                                    : 'form-hint'
                              }
                            >
                              {notice.text}
                            </div>
                          ) : null}
                        </div>
                      </div>
                      <div className="controls-row">
                        <button
                          type="button"
                          className="control-chip"
                          onClick={() => handleMqttReconnect(cfg.siteId)}
                          disabled={isConnecting}
                        >
                          {isConnecting ? 'Connecting...' : 'Reconnect'}
                        </button>
                        <button
                          type="button"
                          className="control-chip"
                          onClick={() => handleMqttTest(cfg.siteId)}
                          disabled={isTesting}
                        >
                          {isTesting ? 'Testing...' : 'Test connection'}
                        </button>
                      </div>
                      <label className="checkbox-label">
                        <input
                          type="checkbox"
                          checked={cfg.enabled}
                          onChange={(event) => {
                            const enabled = event.target.checked;
                            setLocalMqttConfig(cfg.siteId, { enabled });
                            commitMqttConfig(cfg.siteId, { enabled });
                          }}
                        />
                        Enable site replication
                      </label>
                      <div className="config-row">
                        <span className="config-label">Broker URL</span>
                        <input
                          value={cfg.brokerUrl}
                          onChange={(event) =>
                            setLocalMqttConfig(cfg.siteId, { brokerUrl: event.target.value })
                          }
                          onBlur={(event) => {
                            const value = event.target.value.trim();
                            setLocalMqttConfig(cfg.siteId, { brokerUrl: value });
                            if (value.length > 0) {
                              commitMqttConfig(cfg.siteId, { brokerUrl: value });
                            }
                          }}
                        />
                      </div>
                      <div className="config-row">
                        <span className="config-label">Client ID</span>
                        <input
                          value={cfg.clientId}
                          onChange={(event) =>
                            setLocalMqttConfig(cfg.siteId, { clientId: event.target.value })
                          }
                          onBlur={(event) => {
                            const value = event.target.value.trim();
                            if (value.length === 0) {
                              return;
                            }
                            setLocalMqttConfig(cfg.siteId, { clientId: value });
                            commitMqttConfig(cfg.siteId, { clientId: value });
                          }}
                        />
                      </div>
                      <div className="config-row">
                        <span className="config-label">Username</span>
                        <input
                          value={cfg.username ?? ''}
                          onChange={(event) =>
                            setLocalMqttConfig(cfg.siteId, {
                              username: event.target.value || null,
                            })
                          }
                          onBlur={(event) => {
                            const value = event.target.value.trim();
                            const normalized = value.length > 0 ? value : null;
                            setLocalMqttConfig(cfg.siteId, { username: normalized });
                            commitMqttConfig(cfg.siteId, {
                              username: normalized,
                            });
                          }}
                        />
                      </div>
                      <div className="config-row">
                        <span className="config-label">Password</span>
                        <div className="mqtt-password-row">
                          <input
                            type="password"
                            value={mqttPasswords[cfg.siteId] ?? ''}
                            placeholder={cfg.username ? 'Enter new password' : 'Optional'}
                            onChange={(event) =>
                              setMqttPasswords((prev) => ({
                                ...prev,
                                [cfg.siteId]: event.target.value,
                              }))
                            }
                          />
                          <button
                            type="button"
                            className="control-chip"
                            onClick={() => handleMqttPasswordSubmit(cfg.siteId)}
                            disabled={!mqttPasswords[cfg.siteId]}
                          >
                            Update
                          </button>
                        </div>
                      </div>
                      <label className="checkbox-label">
                        <input
                          type="checkbox"
                          checked={cfg.tlsEnabled}
                          onChange={(event) => {
                            const tlsEnabled = event.target.checked;
                            setLocalMqttConfig(cfg.siteId, { tlsEnabled });
                            commitMqttConfig(cfg.siteId, { tlsEnabled });
                          }}
                        />
                        TLS enabled
                      </label>
                      <div className="config-row">
                        <span className="config-label">QoS (events)</span>
                        <select
                          value={cfg.qosEvents}
                          onChange={(event) => {
                            const value = Number(event.target.value);
                            setLocalMqttConfig(cfg.siteId, { qosEvents: value });
                            commitMqttConfig(cfg.siteId, { qosEvents: value });
                          }}
                        >
                          {[0, 1, 2].map((level) => (
                            <option key={level} value={level}>
                              {level}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="config-row">
                        <span className="config-label">QoS (commands)</span>
                        <select
                          value={cfg.qosCommands}
                          onChange={(event) => {
                            const value = Number(event.target.value);
                            setLocalMqttConfig(cfg.siteId, { qosCommands: value });
                            commitMqttConfig(cfg.siteId, { qosCommands: value });
                          }}
                        >
                          {[0, 1, 2].map((level) => (
                            <option key={level} value={level}>
                              {level}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="config-row">
                        <span className="config-label">CA PEM</span>
                        <textarea
                          rows={3}
                          value={cfg.caPem ?? ''}
                          onChange={(event) =>
                            setLocalMqttConfig(cfg.siteId, { caPem: event.target.value || null })
                          }
                          onBlur={(event) =>
                            commitMqttConfig(cfg.siteId, { caPem: event.target.value || null })
                          }
                        />
                      </div>
                      <div className="config-row">
                        <span className="config-label">Client Cert PEM</span>
                        <textarea
                          rows={3}
                          value={cfg.certPem ?? ''}
                          onChange={(event) =>
                            setLocalMqttConfig(cfg.siteId, {
                              certPem: event.target.value || null,
                            })
                          }
                          onBlur={(event) =>
                            commitMqttConfig(cfg.siteId, { certPem: event.target.value || null })
                          }
                        />
                      </div>
                      <div className="config-row">
                        <span className="config-label">Client Key PEM</span>
                        <textarea
                          rows={3}
                          value={cfg.keyPem ?? ''}
                          onChange={(event) =>
                            setLocalMqttConfig(cfg.siteId, { keyPem: event.target.value || null })
                          }
                          onBlur={(event) =>
                            commitMqttConfig(cfg.siteId, { keyPem: event.target.value || null })
                          }
                        />
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </section>
          {chatAddonEnabled ? (
            <section className={cardClass('chat')}>
              <header>
                <h2>Chat</h2>
                <p>Manage the single encrypted operator chat key used for all sites.</p>
              </header>
              <div className="config-card__body">
                <div className="config-row">
                  <span className="config-label">Chat key (broadcast)</span>
                  <div className="config-value chat-key-controls">
                    <input
                      className="control-input"
                      type={chatKeyHidden ? 'password' : 'text'}
                      value={getChatKey() ?? ''}
                      placeholder="No key set"
                      onChange={(event) => {
                        const value = event.target.value.trim();
                        if (value.length === 0) {
                          clearChatKey();
                          setChatKeyNotice('Chat key cleared.');
                          setChatKeyError(null);
                          return;
                        }
                        setChatKey(value);
                        setChatKeyNotice('Chat key updated.');
                        setChatKeyError(null);
                      }}
                    />
                    <div className="controls-row">
                      <button
                        type="button"
                        className="control-chip"
                        onClick={() => setChatKeyHidden((prev) => !prev)}
                      >
                        {chatKeyHidden ? 'Show' : 'Hide'}
                      </button>
                      <button
                        type="button"
                        className="control-chip"
                        onClick={() => {
                          const key = generateChatKey();
                          setChatKey(key);
                          setChatKeyNotice('New chat key generated.');
                          setChatKeyError(null);
                        }}
                      >
                        Generate
                      </button>
                      <button
                        type="button"
                        className="control-chip"
                        onClick={() => {
                          const key = getChatKey();
                          if (!key) {
                            setChatKeyError('No key to copy.');
                            return;
                          }
                          void navigator.clipboard.writeText(key);
                          setChatKeyNotice('Chat key copied to clipboard.');
                          setChatKeyError(null);
                        }}
                      >
                        Copy
                      </button>
                      <button
                        type="button"
                        className="control-chip"
                        onClick={() => {
                          const key = getChatKey();
                          if (!key) {
                            setChatKeyError('No key to download.');
                            return;
                          }
                          const blob = new Blob([key], { type: 'text/plain' });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement('a');
                          a.href = url;
                          a.download = 'chat-key.txt';
                          a.click();
                          URL.revokeObjectURL(url);
                          setChatKeyNotice('Chat key downloaded.');
                          setChatKeyError(null);
                        }}
                      >
                        Download
                      </button>
                      <button
                        type="button"
                        className="control-chip control-chip--danger"
                        onClick={() => {
                          clearChatKey();
                          setChatKeyNotice('Chat key cleared.');
                          setChatKeyError(null);
                        }}
                      >
                        Clear
                      </button>
                    </div>
                    <div className="controls-row">
                      <button
                        type="button"
                        className="control-chip"
                        onClick={() => {
                          setChatPopupEnabled(!chatPopupEnabled);
                          setChatKeyNotice(
                            `Pop-ups ${!chatPopupEnabled ? 'enabled' : 'disabled'} by default.`,
                          );
                        }}
                      >
                        {chatPopupEnabled ? 'Disable pop-ups' : 'Enable pop-ups'}
                      </button>
                    </div>
                    {chatKeyError ? <div className="form-error">{chatKeyError}</div> : null}
                    {chatKeyNotice ? <div className="config-hint">{chatKeyNotice}</div> : null}
                    <div className="config-hint">
                      Single 32-byte random key for all sites. Distribute securely outside MQTT.
                    </div>
                  </div>
                </div>
              </div>
            </section>
          ) : null}

          <section className={cardClass('detection')}>
            <header>
              <h2>Detection Defaults</h2>
              <p>Preset channels and durations for scan/baseline workflows.</p>
            </header>
            <div className="config-card__body">
              <div className="config-row">
                <span className="config-label">Mode</span>
                <select
                  value={appSettings.detectMode}
                  onChange={(event) => updateAppSetting({ detectMode: Number(event.target.value) })}
                >
                  {DETECTION_MODE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <span className="config-hint">
                  Default interface mix used when operators start a new scan (WiFi, BLE, or both).
                </span>
              </div>
              <div className="config-row">
                <span className="config-label">Channels</span>
                <input
                  placeholder="1..14"
                  value={appSettings.detectChannels}
                  onChange={(event) => updateAppSetting({ detectChannels: event.target.value })}
                />
                <span className="config-hint">
                  Accepts comma-separated channels or ranges (e.g. 1,6,11 or 1..14). Applied to
                  quick-start presets.
                </span>
              </div>
              <div className="config-row">
                <span className="config-label">Scan Duration (s)</span>
                <input
                  type="number"
                  value={appSettings.detectScanSecs}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (!Number.isFinite(value)) return;
                    updateAppSetting({ detectScanSecs: value });
                  }}
                />
                <span className="config-hint">
                  Baseline length for general scans before results are returned.
                </span>
              </div>
              <div className="config-row">
                <span className="config-label">Device Scan Duration (s)</span>
                <input
                  type="number"
                  value={appSettings.deviceScanSecs}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (!Number.isFinite(value)) return;
                    updateAppSetting({ deviceScanSecs: value });
                  }}
                />
                <span className="config-hint">
                  Used when operators launch inventory-focused sweeps.
                </span>
              </div>
              <div className="config-row">
                <span className="config-label">Baseline Duration (s)</span>
                <input
                  type="number"
                  value={appSettings.baselineSecs}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (!Number.isFinite(value)) return;
                    updateAppSetting({ baselineSecs: value });
                  }}
                />
                <span className="config-hint">
                  Time allowed for sites to capture a quiet profile before anomaly detection starts.
                </span>
              </div>
              <div className="config-row">
                <span className="config-label">Randomization Duration (s)</span>
                <input
                  type="number"
                  value={appSettings.randomizeSecs}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (!Number.isFinite(value)) return;
                    updateAppSetting({ randomizeSecs: value });
                  }}
                />
                <span className="config-hint">
                  Duration for MAC randomization sweeps triggered from the console.
                </span>
              </div>
              <div className="config-row">
                <span className="config-label">Drone Duration (s)</span>
                <input
                  type="number"
                  value={appSettings.droneSecs}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (!Number.isFinite(value)) return;
                    updateAppSetting({ droneSecs: value });
                  }}
                />
                <span className="config-hint">
                  How long RID monitoring runs before automatically stopping.
                </span>
              </div>
              <div className="config-row">
                <span className="config-label">Deauth Duration (s)</span>
                <input
                  type="number"
                  value={appSettings.deauthSecs}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (!Number.isFinite(value)) return;
                    updateAppSetting({ deauthSecs: value });
                  }}
                />
                <span className="config-hint">
                  Time limit for deauthentication campaigns to avoid accidental long runs.
                </span>
              </div>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={appSettings.allowForever}
                  onChange={(event) => updateAppSetting({ allowForever: event.target.checked })}
                />
                Allow FOREVER commands
              </label>
              <span className="config-hint">
                Permit operators to schedule indefinite tasks (requires explicit STOP to end).
              </span>
            </div>
          </section>

          <section className={cardClass('webhooks')}>
            <header>
              <h2>Webhooks</h2>
              <p>Manage outbound alert endpoints and review recent deliveries.</p>
            </header>
            <WebhooksSection />
          </section>

          <section className={cardClass('map')}>
            <header>
              <h2>Map & Coverage</h2>
              <p>Tiles, attribution, and coverage radius defaults.</p>
            </header>
            <div className="config-card__body">
              <div className="config-row">
                <span className="config-label">Map Tile URL</span>
                <input
                  placeholder="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                  value={appSettings.mapTileUrl}
                  onChange={(event) => updateAppSetting({ mapTileUrl: event.target.value })}
                />
              </div>
              <div className="config-row">
                <span className="config-label">Attribution</span>
                <input
                  value={appSettings.mapAttribution}
                  onChange={(event) => updateAppSetting({ mapAttribution: event.target.value })}
                />
              </div>
              <div className="config-row">
                <span className="config-label">Default Radius (m)</span>
                <input
                  type="number"
                  min={DEFAULT_RADIUS_LIMITS.min}
                  max={DEFAULT_RADIUS_LIMITS.max}
                  value={appSettings.defaultRadiusM}
                  onChange={handleDefaultRadiusChange}
                />
              </div>
              <div className="config-row">
                <span className="config-label">Min Zoom</span>
                <input
                  type="number"
                  value={appSettings.minZoom}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (!Number.isFinite(value)) return;
                    updateAppSetting({ minZoom: value });
                  }}
                />
              </div>
              <div className="config-row">
                <span className="config-label">Max Zoom</span>
                <input
                  type="number"
                  value={appSettings.maxZoom}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (!Number.isFinite(value)) return;
                    updateAppSetting({ maxZoom: value });
                  }}
                />
              </div>
            </div>
          </section>

          <section className={cardClass('faa')}>
            <header>
              <h2>FAA Registry</h2>
              <p>Choose between online lookups or an offline dataset to enrich drone cards.</p>
            </header>
            <div className="config-card__body">
              <div className="config-subcard">
                <h3>Online Lookup</h3>
                <p className="config-hint">
                  Resolve aircraft details via the FAA online API when internet is available.
                </p>
                <div className="config-row">
                  <span className="config-label">Status</span>
                  <span>{faaOnline.enabled ? 'Enabled' : 'Disabled'}</span>
                </div>
                <div className="config-row">
                  <span className="config-label">Cache entries</span>
                  <span>{(faaOnline.cacheEntries ?? 0).toLocaleString()}</span>
                </div>
              </div>

              <div className="config-subcard">
                <h3>Offline Dataset</h3>
                <p className="config-hint">
                  Download and parse the FAA aircraft registry ZIP for offline enrichment, or upload
                  a MASTER.txt file directly.
                </p>
                <div className="config-row">
                  <span className="config-label">Last sync</span>
                  <span>{formatDateTime(faaRegistry?.lastSyncedAt ?? null)}</span>
                </div>
                <div className="config-row">
                  <span className="config-label">Records</span>
                  <span>{(faaRegistry?.totalRecords ?? 0).toLocaleString()}</span>
                </div>
                <div className="config-row">
                  <span className="config-label">Dataset version</span>
                  <span>{faaRegistry?.datasetVersion ?? 'Unknown'}</span>
                </div>
                <div className="config-row">
                  <span className="config-label">Status</span>
                  <span>
                    {faaInProgress
                      ? `Syncing (${faaProgressCount.toLocaleString()} rows processed)`
                      : 'Idle'}
                  </span>
                </div>
                {faaLastError ? <div className="form-error">Last error: {faaLastError}</div> : null}
                <div className="config-row">
                  <span className="config-label">Dataset URL</span>
                  <input
                    type="url"
                    value={faaUrl}
                    onChange={(event) => setFaaUrl(event.target.value)}
                    placeholder={FAA_DATASET_URL}
                    disabled={faaInProgress || faaSyncMutation.isPending}
                  />
                </div>
                <div className="controls-row">
                  <button
                    type="button"
                    className="submit-button"
                    disabled={faaInProgress || faaSyncMutation.isPending}
                    onClick={handleFaaSyncClick}
                  >
                    {faaInProgress ? 'Sync in progress...' : 'Download & Parse'}
                  </button>
                  <label className="control-chip">
                    {faaUploadMutation.isPending ? 'Uploading...' : 'Upload MASTER.txt'}
                    <input
                      type="file"
                      accept=".txt,text/plain"
                      hidden
                      disabled={faaInProgress || faaUploadMutation.isPending}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) {
                          handleFaaUpload(file);
                          event.target.value = '';
                        }
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    className="control-chip"
                    onClick={() => faaStatusQuery.refetch()}
                    disabled={faaStatusQuery.isFetching}
                  >
                    Refresh Status
                  </button>
                </div>
                <p className="config-hint">
                  The FAA releases updates daily. Parsing the dataset may take several minutes.
                </p>
              </div>
            </div>
          </section>

          <section className={cardClass('oui')}>
            <header>
              <h2>OUI Resolver</h2>
              <p>Manage vendor lookup cache for MAC address resolution.</p>
            </header>
            <div className="config-card__body">
              <div className="config-row">
                <span className="config-label">Total entries</span>
                <span>{ouiStats ? ouiStats.total.toLocaleString() : 'N/A'}</span>
              </div>
              <div className="config-row">
                <span className="config-label">Last updated</span>
                <span>{formatDateTime(ouiStats?.lastUpdated ?? null)}</span>
              </div>
              {ouiError ? <div className="form-error">{ouiError}</div> : null}
              <div className="config-row">
                <span className="config-label">Import mode</span>
                <select
                  value={ouiMode}
                  onChange={(event) => setOuiMode(event.target.value as 'replace' | 'merge')}
                >
                  <option value="replace">Replace existing</option>
                  <option value="merge">Merge</option>
                </select>
              </div>
              <label className="control-chip">
                {ouiImportMutation.isPending ? 'Uploading...' : 'Upload CSV/JSON'}
                <input
                  type="file"
                  accept=".csv,.json,text/csv,application/json"
                  hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) {
                      handleOuiUpload(file);
                      event.target.value = '';
                    }
                  }}
                />
              </label>
              <div className="controls-row">
                <button
                  type="button"
                  className="control-chip"
                  onClick={() => handleOuiExport('csv')}
                >
                  Export CSV
                </button>
                <button
                  type="button"
                  className="control-chip"
                  onClick={() => handleOuiExport('json')}
                >
                  Export JSON
                </button>
              </div>
            </div>
          </section>

          <section className={cardClass('system-updates')}>
            <header>
              <h2>System Updates</h2>
              <p>Monitor and deploy system updates for the Command Center infrastructure.</p>
            </header>
            {!isAdmin ? (
              <div className="config-card__body">
                <div className="form-error">
                  Administrator privileges required to access system update management.
                </div>
              </div>
            ) : (
              <>
                <div className="config-card__body">
                  <div className="config-subcard">
                    <h3>Version Status</h3>
                    <div className="config-row">
                      <span className="config-label">Branch</span>
                      <span className="mono-text">{updateInfo?.currentBranch || 'unknown'}</span>
                    </div>
                    <div className="config-row">
                      <span className="config-label">Remote</span>
                      <select
                        value={selectedRemote || updateInfo?.remote || ''}
                        onChange={(event) => {
                          setSelectedRemote(event.target.value);
                          setSelectedBranch('');
                        }}
                        disabled={isCheckingUpdates || !gitRemotes || gitRemotes.length === 0}
                      >
                        {gitRemotes && gitRemotes.length > 0 ? (
                          gitRemotes.map((remote) => (
                            <option key={remote.name} value={remote.name} title={remote.url}>
                              {remote.name}
                              {remote.isDefault ? ' (tracking)' : ''}
                            </option>
                          ))
                        ) : (
                          <option value={updateInfo?.remote || ''}>
                            {updateInfo?.remote || 'unknown'}
                          </option>
                        )}
                      </select>
                    </div>
                    <div className="config-row">
                      <span className="config-label">Compare Branch</span>
                      <select
                        value={selectedBranch || updateInfo?.remoteBranch || ''}
                        onChange={(event) => setSelectedBranch(event.target.value)}
                        disabled={isCheckingUpdates || !gitBranches || gitBranches.length === 0}
                      >
                        {gitBranches && gitBranches.length > 0 ? (
                          <>
                            {!gitBranches.includes(updateInfo?.remoteBranch || '') &&
                              updateInfo?.remoteBranch && (
                                <option value={updateInfo.remoteBranch}>
                                  {updateInfo.remoteBranch} (missing)
                                </option>
                              )}
                            {gitBranches.map((branch) => (
                              <option key={branch} value={branch}>
                                {branch}
                              </option>
                            ))}
                          </>
                        ) : (
                          <option value={updateInfo?.remoteBranch || ''}>
                            {updateInfo?.remoteBranch || 'unknown'}
                          </option>
                        )}
                      </select>
                    </div>
                    <div className="config-row">
                      <span className="config-label">Comparing Against</span>
                      <span className="mono-text">
                        {`${selectedRemote || updateInfo?.remote || '?'}/${
                          selectedBranch || updateInfo?.remoteBranch || '?'
                        }`}
                      </span>
                    </div>
                    {(() => {
                      const localHash =
                        updateInfo?.currentCommit?.substring(0, 8).toUpperCase() || '--------';
                      const remoteRaw = updateInfo?.latestCommit || '';
                      const hasRemoteHash = /^[0-9a-f]{40}$/i.test(remoteRaw);
                      const remoteHash = hasRemoteHash
                        ? remoteRaw.substring(0, 8).toUpperCase()
                        : null;
                      const hashesDiffer = hasRemoteHash && remoteHash !== localHash;

                      return (
                        <div
                          style={{
                            display: 'grid',
                            gridTemplateColumns: hasRemoteHash ? '1fr 1fr' : '1fr',
                            gap: '0.75rem',
                            margin: '0.75rem 0',
                            padding: '0.75rem',
                            backgroundColor: 'rgba(255, 255, 255, 0.03)',
                            borderRadius: '4px',
                            border: '1px solid rgba(255, 255, 255, 0.08)',
                          }}
                        >
                          <div>
                            <div
                              style={{
                                fontSize: '0.75rem',
                                opacity: 0.6,
                                marginBottom: '0.25rem',
                              }}
                            >
                              {hasRemoteHash ? 'LOCAL' : 'COMMIT'}
                            </div>
                            <span className="mono-text" style={{ fontSize: '0.95rem' }}>
                              {localHash}
                            </span>
                            {updateInfo?.localCommitDate && (
                              <div
                                style={{ fontSize: '0.75rem', opacity: 0.6, marginTop: '0.2rem' }}
                              >
                                {formatDate(updateInfo.localCommitDate)}
                              </div>
                            )}
                          </div>
                          {hasRemoteHash && (
                            <div>
                              <div
                                style={{
                                  fontSize: '0.75rem',
                                  opacity: 0.6,
                                  marginBottom: '0.25rem',
                                }}
                              >
                                REMOTE
                              </div>
                              <span
                                className="mono-text"
                                style={{
                                  fontSize: '0.95rem',
                                  color: hashesDiffer ? '#f59e0b' : undefined,
                                }}
                              >
                                {remoteHash}
                              </span>
                              {updateInfo?.remoteCommitDate && (
                                <div
                                  style={{ fontSize: '0.75rem', opacity: 0.6, marginTop: '0.2rem' }}
                                >
                                  {formatDate(updateInfo.remoteCommitDate)}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })()}
                    {typeof updateInfo?.commitsAhead === 'number' &&
                      updateInfo.commitsAhead > 0 && (
                        <div
                          style={{ fontSize: '0.8rem', color: '#f59e0b', marginBottom: '0.5rem' }}
                        >
                          {updateInfo.commitsAhead} local commit
                          {updateInfo.commitsAhead !== 1 ? 's are' : ' is'} not on{' '}
                          {`${updateInfo.remote}/${updateInfo.remoteBranch}`}
                        </div>
                      )}
                    {(() => {
                      const remoteRaw = updateInfo?.latestCommit || '';
                      const hasRemoteHash = /^[0-9a-f]{40}$/i.test(remoteRaw);
                      if (
                        hasRemoteHash &&
                        updateInfo?.currentCommit &&
                        updateInfo.currentCommit === remoteRaw
                      ) {
                        return (
                          <div
                            style={{
                              fontSize: '0.8rem',
                              color: '#22c55e',
                              marginBottom: '0.5rem',
                            }}
                          >
                            Hashes match — confirmed up to date
                          </div>
                        );
                      }
                      return null;
                    })()}
                    {updateInfo?.warning && (
                      <div
                        className="form-error"
                        style={{ marginBottom: '0.75rem', fontSize: '0.85rem' }}
                      >
                        {updateInfo.warning}
                      </div>
                    )}
                    <div className="config-row">
                      <span className="config-label">Database</span>
                      <span
                        style={{
                          color: databaseStatus
                            ? databaseStatus.state === 'up-to-date'
                              ? '#22c55e'
                              : databaseStatus.state === 'pending'
                                ? '#f59e0b'
                                : databaseStatus.state === 'unknown'
                                  ? undefined
                                  : '#ef4444'
                            : undefined,
                        }}
                      >
                        {databaseStatus ? databaseStatus.message : 'Checking schema...'}
                      </span>
                    </div>
                    {databaseStatus?.actionRequired && (
                      <div
                        className={
                          databaseStatus.state === 'pending' ? 'config-hint' : 'form-error'
                        }
                        style={{ marginBottom: '0.75rem', fontSize: '0.85rem' }}
                      >
                        {databaseStatus.pendingMigrations.length > 0 && (
                          <div style={{ marginBottom: '0.4rem' }}>
                            Pending: {databaseStatus.pendingMigrations.join(', ')}
                          </div>
                        )}
                        {databaseStatus.failedMigrations.length > 0 && (
                          <div style={{ marginBottom: '0.4rem' }}>
                            Failed: {databaseStatus.failedMigrations.join(', ')}
                          </div>
                        )}
                        <div style={{ marginBottom: '0.4rem' }}>
                          {databaseStatus.appliedDuringUpdate
                            ? 'Deploy Update applies these automatically. To apply them manually instead, run:'
                            : 'This must be resolved manually before an update can run:'}
                        </div>
                        {databaseStatus.manualCommand && (
                          <code
                            className="mono-text"
                            style={{ display: 'block', wordBreak: 'break-all' }}
                          >
                            {databaseStatus.manualCommand}
                          </code>
                        )}
                      </div>
                    )}
                    <div className="config-row">
                      <span className="config-label">Last Check</span>
                      <span>{updateInfo ? formatDate(updateInfo.lastCheckAt) : 'Never'}</span>
                    </div>
                    <button
                      type="button"
                      className="submit-button"
                      onClick={() => {
                        checkForUpdates();
                        refetchDatabaseStatus();
                      }}
                      disabled={isCheckingUpdates}
                    >
                      {isCheckingUpdates ? 'Checking...' : 'Check for Updates'}
                    </button>
                  </div>

                  <div className="config-subcard">
                    <h3>Status</h3>
                    {!updateInfo ? (
                      <div className="config-hint">Loading update information...</div>
                    ) : !/^[0-9a-f]{40}$/i.test(updateInfo.latestCommit || '') ? (
                      <div className="form-error">
                        Cannot compare — {`${updateInfo.remote}/${updateInfo.remoteBranch}`} could
                        not be resolved. Pick a branch that exists on this remote.
                      </div>
                    ) : updateInfo.available ? (
                      <>
                        <div className="form-success" style={{ marginBottom: '1rem' }}>
                          <strong>Update Available</strong> — {updateInfo.commitsBehind} commit
                          {updateInfo.commitsBehind !== 1 ? 's' : ''} behind
                        </div>
                        {updateInfo.lastCommitMessage && (
                          <div className="config-row">
                            <span className="config-label">Latest Changes</span>
                            <span>{updateInfo.lastCommitMessage}</span>
                          </div>
                        )}
                        {updateInfo.lastCommitAuthor && (
                          <div className="config-row">
                            <span className="config-label">Author</span>
                            <span>{updateInfo.lastCommitAuthor}</span>
                          </div>
                        )}
                        {updateInfo.lastCommitDate && (
                          <div className="config-row">
                            <span className="config-label">Committed</span>
                            <span>{formatDate(updateInfo.lastCommitDate)}</span>
                          </div>
                        )}
                        {updateInfo.latestCommit && (
                          <div className="config-row">
                            <span className="config-label">Target Commit</span>
                            <span className="mono-text">
                              {updateInfo.latestCommit.substring(0, 8).toUpperCase()}
                            </span>
                          </div>
                        )}
                        {updateInfo.blockers && updateInfo.blockers.length > 0 && (
                          <div className="form-error" style={{ marginTop: '1rem' }}>
                            <strong>Status:</strong>
                            <ul style={{ marginTop: '0.5rem', paddingLeft: '1.5rem' }}>
                              {updateInfo.blockers.map((blocker: string, idx: number) => (
                                <li key={idx}>{blocker}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {updateProgress && (
                          <div
                            style={{
                              marginTop: '1rem',
                              padding: '1rem',
                              backgroundColor: 'rgba(59, 130, 246, 0.1)',
                              border: '1px solid rgba(59, 130, 246, 0.3)',
                              borderRadius: '4px',
                            }}
                          >
                            <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>
                              Update in Progress
                            </div>
                            <div style={{ fontSize: '0.875rem', marginBottom: '0.75rem' }}>
                              {updateProgress.message}
                            </div>
                            <div
                              style={{
                                height: '8px',
                                backgroundColor: 'rgba(255, 255, 255, 0.2)',
                                borderRadius: '4px',
                                overflow: 'hidden',
                              }}
                            >
                              <div
                                style={{
                                  height: '100%',
                                  width: `${updateProgress.progress}%`,
                                  backgroundColor: '#3b82f6',
                                  transition: 'width 0.3s ease',
                                }}
                              />
                            </div>
                          </div>
                        )}
                        <button
                          type="button"
                          className="submit-button"
                          style={{ marginTop: '1rem' }}
                          onClick={() => {
                            setUpdateConfirmationError(null);
                            setShowUpdateConfirmation(true);
                          }}
                          disabled={
                            !updateInfo.canUpdate ||
                            triggerUpdateMutation.isPending ||
                            updateProgress !== null
                          }
                        >
                          {triggerUpdateMutation.isPending ? 'Initiating...' : 'Deploy Update'}
                        </button>
                      </>
                    ) : (
                      <>
                        <div className="form-success">
                          System is running the latest version. No updates available.
                        </div>
                        {updateProgress && (
                          <div
                            style={{
                              marginTop: '1rem',
                              padding: '1rem',
                              backgroundColor: 'rgba(59, 130, 246, 0.1)',
                              border: '1px solid rgba(59, 130, 246, 0.3)',
                              borderRadius: '4px',
                            }}
                          >
                            <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>
                              Update in Progress
                            </div>
                            <div style={{ fontSize: '0.875rem', marginBottom: '0.75rem' }}>
                              {updateProgress.message}
                            </div>
                            <div
                              style={{
                                height: '8px',
                                backgroundColor: 'rgba(255, 255, 255, 0.2)',
                                borderRadius: '4px',
                                overflow: 'hidden',
                              }}
                            >
                              <div
                                style={{
                                  height: '100%',
                                  width: `${updateProgress.progress}%`,
                                  backgroundColor: '#3b82f6',
                                  transition: 'width 0.3s ease',
                                }}
                              />
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>

                <div className="config-card__body">
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      marginBottom: '1rem',
                    }}
                  >
                    <h3 style={{ margin: 0 }}>Update History</h3>
                    {updateHistory && updateHistory.length > 0 && (
                      <button
                        type="button"
                        className="control-chip"
                        onClick={() => setShowClearLogsConfirmation(true)}
                        disabled={clearUpdateLogsMutation.isPending}
                      >
                        {clearUpdateLogsMutation.isPending ? 'Clearing...' : 'Clear Logs'}
                      </button>
                    )}
                  </div>
                  {updateHistory && updateHistory.length > 0 ? (
                    <div style={{ overflowX: 'auto' }}>
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>Timestamp</th>
                            <th>Status</th>
                            <th>Commit Range</th>
                            <th>Duration</th>
                            <th>Operator</th>
                          </tr>
                        </thead>
                        <tbody>
                          {updateHistory.map((log: UpdateLog) => (
                            <tr key={log.id}>
                              <td>{formatDate(log.startedAt)}</td>
                              <td>{getStatusBadge(log.status)}</td>
                              <td className="mono-text">
                                {log.fromCommit.substring(0, 7)} →{' '}
                                {log.toCommit?.substring(0, 7) || '—'}
                              </td>
                              <td>{formatDuration(log.durationSeconds)}</td>
                              <td>{log.triggeredBy.email}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="config-hint">
                      No history available. Update logs will appear here after deployments.
                    </p>
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      </div>

      {showUpdateConfirmation && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h3>Confirm System Update</h3>
            <div className="form-hint" style={{ marginBottom: '1rem' }}>
              This operation will update the system from commit{' '}
              <span className="mono-text">
                {updateInfo?.currentCommit?.substring(0, 8).toUpperCase()}
              </span>{' '}
              to the latest version.
            </div>
            <div className="form-error" style={{ marginBottom: '1rem' }}>
              <strong>System Downtime Expected:</strong> The Command Center will be unavailable for
              approximately 20-60s during deployment The backend will restart upon completion.
            </div>
            {updateConfirmationError && (
              <div className="form-error" style={{ marginBottom: '1rem' }}>
                <strong>Update Failed:</strong> {updateConfirmationError}
              </div>
            )}
            <div className="controls-row" style={{ marginTop: '1rem' }}>
              <button
                type="button"
                className="control-chip"
                onClick={() => {
                  setShowUpdateConfirmation(false);
                  setUpdateConfirmationError(null);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="submit-button"
                onClick={() => triggerUpdateMutation.mutate()}
                disabled={triggerUpdateMutation.isPending}
              >
                {triggerUpdateMutation.isPending ? 'Deploying...' : 'Deploy Update'}
              </button>
            </div>
          </div>
        </div>
      )}

      {updateResolutionError && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h3>Update Blocked</h3>
            <div className="form-error" style={{ marginBottom: '1rem' }}>
              {updateResolutionError.message}
            </div>
            <div className="form-hint" style={{ marginBottom: '1rem' }}>
              Please choose how to resolve this issue:
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {updateResolutionError.options.map((option) => (
                <button
                  key={option.action}
                  type="button"
                  style={{
                    padding: '1rem',
                    border: '1px solid var(--border-color)',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    transition: 'background-color 0.2s',
                    backgroundColor: 'transparent',
                    textAlign: 'left',
                    width: '100%',
                  }}
                  onClick={() => {
                    if (option.command) {
                      setConfigNotice({
                        type: 'info',
                        text: `To ${option.action}, run: ${option.command}`,
                      });
                    } else {
                      setConfigNotice({
                        type: 'info',
                        text: option.description,
                      });
                    }
                    setUpdateResolutionError(null);
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = 'var(--hover-bg, rgba(0, 0, 0, 0.05))';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'transparent';
                  }}
                >
                  <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>
                    {option.action.charAt(0).toUpperCase() + option.action.slice(1)}
                  </div>
                  <div style={{ fontSize: '0.9rem', opacity: 0.8 }}>{option.description}</div>
                  {option.command && (
                    <div
                      className="mono-text"
                      style={{
                        marginTop: '0.5rem',
                        padding: '0.5rem',
                        backgroundColor: 'var(--code-bg, rgba(0, 0, 0, 0.1))',
                        borderRadius: '3px',
                        fontSize: '0.85rem',
                      }}
                    >
                      {option.command}
                    </div>
                  )}
                </button>
              ))}
            </div>
            <div className="controls-row" style={{ marginTop: '1rem' }}>
              <button
                type="button"
                className="control-chip"
                onClick={() => setUpdateResolutionError(null)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {showClearLogsConfirmation && (
        <div className="modal-overlay">
          <div className="modal-content">
            <h3>Clear Update Logs</h3>
            <div className="form-hint" style={{ marginBottom: '1rem' }}>
              Are you sure you want to delete all update logs? This action cannot be undone.
            </div>
            <div className="controls-row" style={{ marginTop: '1rem' }}>
              <button
                type="button"
                className="control-chip"
                onClick={() => setShowClearLogsConfirmation(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="submit-button"
                onClick={() => clearUpdateLogsMutation.mutate()}
              >
                Clear Logs
              </button>
            </div>
          </div>
        </div>
      )}
    </>,
  );
}

function mapFirewallConfigToForm(config: FirewallOverview['config']): FirewallFormState {
  return {
    enabled: config.enabled,
    defaultPolicy: config.defaultPolicy,
    geoMode: config.geoMode,
    allowedCountries: config.allowedCountries.join('\n'),
    blockedCountries: config.blockedCountries.join('\n'),
    ipAllowList: config.ipAllowList.join('\n'),
    ipBlockList: config.ipBlockList.join('\n'),
    failThreshold: String(config.failThreshold),
    failWindowSeconds: String(config.failWindowSeconds),
    banDurationSeconds: String(config.banDurationSeconds),
  };
}

function parseCountryList(value: string): string[] {
  const tokens = value
    .split(/[\s,]+/)
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
  return Array.from(new Set(tokens));
}

function applyAlertPreferencePatch(user: AuthUser, patch: AlertColorUpdate): AuthUser {
  const currentAlert = user.preferences.alertColors ?? {
    idle: null,
    info: null,
    notice: null,
    alert: null,
    critical: null,
  };

  const nextAlert: UserAlertColors = {
    idle: currentAlert.idle ?? null,
    info: currentAlert.info ?? null,
    notice: currentAlert.notice ?? null,
    alert: currentAlert.alert ?? null,
    critical: currentAlert.critical ?? null,
  };

  for (const [rawKey, rawValue] of Object.entries(patch)) {
    const key = rawKey as AlertColorFieldKey;
    const value = (rawValue ?? null) as string | null;
    switch (key) {
      case 'alertColorIdle':
        nextAlert.idle = value;
        break;
      case 'alertColorInfo':
        nextAlert.info = value;
        break;
      case 'alertColorNotice':
        nextAlert.notice = value;
        break;
      case 'alertColorAlert':
        nextAlert.alert = value;
        break;
      case 'alertColorCritical':
        nextAlert.critical = value;
        break;
      default:
        break;
    }
  }

  return {
    ...user,
    preferences: {
      ...user.preferences,
      alertColors: nextAlert,
    },
  };
}

function applyThemePresetOptimistic(user: AuthUser, preset: ThemePresetId): AuthUser {
  return {
    ...user,
    preferences: {
      ...user.preferences,
      themePreset: preset,
    },
  };
}

function parseLineList(value: string): string[] {
  const entries = value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  return Array.from(new Set(entries));
}

function formatMqttStatusState(state: MqttStatusState): string {
  switch (state) {
    case 'connected':
      return 'Connected';
    case 'connecting':
      return 'Connecting';
    case 'disabled':
      return 'Disabled';
    case 'error':
      return 'Error';
    case 'not_configured':
    default:
      return 'Not configured';
  }
}

function volumeKeyForLevel(level: AlarmLevel): keyof AlarmConfig {
  switch (level) {
    case 'INFO':
      return 'volumeInfo';
    case 'NOTICE':
      return 'volumeNotice';
    case 'ALERT':
      return 'volumeAlert';
    case 'CRITICAL':
      return 'volumeCritical';
  }
}
