export interface InventoryDevice {
  mac: string;
  vendor?: string | null;
  type?: string | null;
  ssid?: string | null;
  channel?: number | null;
  hits: number;
  lastSeen?: string | null;
  maxRSSI?: number | null;
  minRSSI?: number | null;
  avgRSSI?: number | null;
  locallyAdministered: boolean;
  multicast: boolean;
  lastNodeId?: string | null;
  lastLat?: number | null;
  lastLon?: number | null;
  siteId?: string | null;
}

export interface CommandRequest {
  target: string;
  name: string;
  params: string[];
  siteId?: string;
}

export interface CommandResponse {
  id: string;
  status: string;
}

export type ChatMessage = {
  type: 'chat.message';
  id: string;
  siteId: string;
  originSiteId: string;
  fromUserId?: string;
  fromEmail?: string;
  fromRole?: string;
  fromDisplayName?: string | null;
  encrypted: boolean;
  text?: string;
  cipherText?: string;
  ts: string;
};

export type ChatClearEvent = {
  type: 'chat.clear';
  originSiteId: string;
  target: 'all' | string;
  ts: string;
};

export type AlarmLevel = 'INFO' | 'NOTICE' | 'ALERT' | 'CRITICAL';

export interface AlarmConfig {
  audioPack: string;
  volumeInfo: number;
  volumeNotice: number;
  volumeAlert: number;
  volumeCritical: number;
  volumeDroneGeofence: number;
  volumeDroneTelemetry: number;
  gapInfoMs: number;
  gapNoticeMs: number;
  gapAlertMs: number;
  gapCriticalMs: number;
  dndStart?: string | null;
  dndEnd?: string | null;
  backgroundAllowed: boolean;
}

export type AlarmSoundKey = AlarmLevel | 'DRONE_GEOFENCE' | 'DRONE_TELEMETRY';

export interface AlarmSettingsResponse {
  config: AlarmConfig;
  sounds: Record<AlarmSoundKey, string | null>;
}

export type AlertRuleScope = 'PERSONAL' | 'GLOBAL';
export type AlertRuleMatchMode = 'ANY' | 'ALL';

export interface AlertRuleMapStyle {
  showOnMap?: boolean;
  color?: string | null;
  icon?: string | null;
  blink?: boolean;
  label?: string | null;
}

export interface AlertRuleOwnerSummary {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
}

export interface AlertRule {
  id: string;
  name: string;
  description?: string | null;
  scope: AlertRuleScope;
  severity: AlarmLevel;
  matchMode: AlertRuleMatchMode;
  isActive: boolean;
  ouiPrefixes: string[];
  ssids: string[];
  channels: number[];
  macAddresses: string[];
  inventoryMacs: string[];
  minRssi?: number | null;
  maxRssi?: number | null;
  notifyVisual: boolean;
  notifyAudible: boolean;
  notifyEmail: boolean;
  emailRecipients: string[];
  messageTemplate?: string | null;
  mapStyle?: AlertRuleMapStyle | null;
  webhookIds: string[];
  createdAt: string;
  updatedAt: string;
  lastTriggeredAt?: string | null;
  owner?: AlertRuleOwnerSummary | null;
}

export interface AlertRulePayload {
  name: string;
  description?: string;
  scope?: AlertRuleScope;
  severity?: AlarmLevel;
  matchMode?: AlertRuleMatchMode;
  isActive?: boolean;
  ouiPrefixes?: string[];
  ssids?: string[];
  channels?: number[];
  macAddresses?: string[];
  inventoryMacs?: string[];
  minRssi?: number | null;
  maxRssi?: number | null;
  notifyVisual?: boolean;
  notifyAudible?: boolean;
  notifyEmail?: boolean;
  emailRecipients?: string[];
  messageTemplate?: string | null;
  mapStyle?: AlertRuleMapStyle | null;
  webhookIds?: string[];
}

export interface AlertRuleEvent {
  id: string;
  ruleId: string;
  ruleName: string;
  severity: AlarmLevel;
  message?: string | null;
  nodeId?: string | null;
  mac?: string | null;
  ssid?: string | null;
  channel?: number | null;
  rssi?: number | null;
  matchedCriteria?: string[];
  payload?: Record<string, unknown> | null;
  triggeredAt: string;
}

export interface WebhookDelivery {
  id: string;
  statusCode?: number | null;
  success: boolean;
  errorMessage?: string | null;
  triggeredAt: string;
  completedAt?: string | null;
}

export interface Webhook {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  verifyTls: boolean;
  subscribedEvents: string[];
  shared: boolean;
  clientCertificate?: string | null;
  clientKey?: string | null;
  caBundle?: string | null;
  lastSuccessAt?: string | null;
  lastFailureAt?: string | null;
  owner?: AlertRuleOwnerSummary | null;
  linkedRuleIds: string[];
  recentDeliveries: WebhookDelivery[];
}

export type TargetStatus = 'ACTIVE' | 'TRIANGULATING' | 'RESOLVED';

export interface Target {
  id: string;
  name?: string | null;
  mac?: string | null;
  lat: number;
  lon: number;
  url?: string | null;
  notes?: string | null;
  tags: string[];
  siteId?: string | null;
  createdBy?: string | null;
  deviceType?: string | null;
  trackingConfidence?: number | null;
  firstNodeId?: string | null;
  status: TargetStatus;
  createdAt: string;
  updatedAt: string;
}

export type FirewallPolicy = 'ALLOW' | 'DENY';
export type FirewallGeoMode = 'DISABLED' | 'ALLOW_LIST' | 'BLOCK_LIST';
export type FirewallRuleType = 'ALLOW' | 'BLOCK' | 'TEMP_BLOCK';
export type FirewallLogOutcome =
  | 'ALLOWED'
  | 'BLOCKED'
  | 'GEO_BLOCK'
  | 'DEFAULT_DENY'
  | 'AUTH_FAILURE'
  | 'AUTH_SUCCESS';

export interface FirewallConfig {
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
  updatedAt: string;
}

export interface FirewallRule {
  id: string;
  ip: string;
  type: FirewallRuleType;
  reason?: string | null;
  expiresAt?: string | null;
  createdBy?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FirewallLog {
  id: string;
  ip: string;
  country?: string | null;
  path: string;
  method: string;
  outcome: FirewallLogOutcome;
  ruleId?: string | null;
  attempts: number;
  firstSeen: string;
  lastSeen: string;
  blocked: boolean;
  reason?: string | null;
  userAgent?: string | null;
}

export interface FirewallOverview {
  config: FirewallConfig;
  rules: FirewallRule[];
  stats: {
    totalRules: number;
    totalBlockedRules: number;
    totalLogs: number;
    blockedLast24h: number;
    authFailuresLast24h: number;
  };
}

export interface AdsbTrack {
  id: string;
  icao: string;
  callsign?: string | null;
  lat: number;
  lon: number;
  alt?: number | null;
  speed?: number | null;
  heading?: number | null;
  onGround?: boolean | null;
  lastSeen: string;
  category?: string | null;
  reg?: string | null;
  dep?: string | null;
  dest?: string | null;
  typeCode?: string | null;
  model?: string | null;
  manufacturer?: string | null;
  aircraftType?: string | null;
  categoryDescription?: string | null;
  country?: string | null;
  messages?: number | null;
}

export interface AdsbStatus {
  enabled: boolean;
  feedUrl: string;
  intervalMs: number;
  geofencesEnabled: boolean;
  lastPollAt?: string | null;
  lastError?: string | null;
  trackCount: number;
}

export interface AcarsMessage {
  id: string;
  tail: string;
  flight?: string | null;
  label?: string | null;
  text?: string | null;
  timestamp: string;
  frequency?: number | null;
  signalLevel?: number | null;
  noiseLevel?: number | null;
  mode?: string | null;
  messageNumber?: string | null;
  sublabel?: string | null;
  channel?: number | null;
  stationId?: string | null;
  lastSeen: string;
  lat?: number | null;
  lon?: number | null;
  correlatedIcao?: string | null;
}

export interface AcarsStatus {
  enabled: boolean;
  udpHost: string;
  udpPort: number;
  intervalMs?: number;
  lastMessageAt?: string | null;
  messageCount?: number;
  lastError?: string | null;
}

export interface GeofenceVertex {
  lat: number;
  lon: number;
}

export interface GeofenceAlarmConfig {
  enabled: boolean;
  level: AlarmLevel;
  message: string;
  triggerOnExit?: boolean;
}

export interface GeofenceSiteInfo {
  id: string;
  name?: string | null;
  color?: string | null;
  country?: string | null;
  city?: string | null;
}

export interface Geofence {
  id: string;
  siteId?: string | null;
  originSiteId?: string | null;
  name: string;
  description?: string | null;
  color: string;
  polygon: GeofenceVertex[];
  alarm: GeofenceAlarmConfig;
  createdBy?: string | null;
  createdAt: string;
  updatedAt: string;
  site?: GeofenceSiteInfo | null;
}

export interface CreateGeofenceRequest {
  name: string;
  description?: string | null;
  color?: string;
  siteId?: string | null;
  polygon: GeofenceVertex[];
  alarm: GeofenceAlarmConfig;
}

export interface UpdateGeofenceRequest {
  name?: string;
  description?: string | null;
  color?: string;
  siteId?: string | null;
  polygon?: GeofenceVertex[];
  alarm?: Partial<GeofenceAlarmConfig>;
}

export interface FaaAircraftSummary {
  nNumber: string;
  serialNumber?: string | null;
  documentNumber?: string | null;
  documentUrl?: string | null;
  trackingNumber?: string | null;
  makeName?: string | null;
  modelName?: string | null;
  series?: string | null;
  fccIdentifier?: string | null;
  registrantName?: string | null;
  street1?: string | null;
  street2?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  aircraftType?: string | null;
  engineType?: string | null;
  statusCode?: string | null;
  modeSCodeHex?: string | null;
  yearManufactured?: number | null;
  lastActionDate?: string | null;
  expirationDate?: string | null;
}

export type DroneStatus = 'UNKNOWN' | 'FRIENDLY' | 'NEUTRAL' | 'HOSTILE';

export interface Drone {
  id: string;
  droneId?: string | null;
  mac?: string | null;
  nodeId?: string | null;
  siteId?: string | null;
  originSiteId?: string | null;
  siteName?: string | null;
  siteColor?: string | null;
  siteCountry?: string | null;
  siteCity?: string | null;
  lat: number;
  lon: number;
  altitude?: number | null;
  speed?: number | null;
  operatorLat?: number | null;
  operatorLon?: number | null;
  rssi?: number | null;
  status: DroneStatus;
  lastSeen: string;
  faa?: FaaAircraftSummary | null;
}

export interface FaaRegistryStatusResponse {
  registry: {
    id: number;
    datasetUrl?: string | null;
    datasetVersion?: string | null;
    lastSyncedAt?: string | null;
    totalRecords: number;
    createdAt?: string;
    updatedAt?: string;
  };
  inProgress: boolean;
  progress?: {
    processed: number;
    startedAt: string;
  } | null;
  lastError?: string | null;
  online: {
    enabled: boolean;
    cacheEntries: number;
  };
}

export interface StartFaaSyncResponse {
  started: boolean;
}

export interface AppSettings {
  id: number;
  appName: string;
  protocol: string;
  timezone?: string | null;
  env: string;
  detectChannels: string;
  detectMode: number;
  detectScanSecs: number;
  allowForever: boolean;
  baselineSecs: number;
  deviceScanSecs: number;
  droneSecs: number;
  deauthSecs: number;
  randomizeSecs: number;
  defaultRadiusM: number;
  mapTileUrl: string;
  mapAttribution: string;
  minZoom: number;
  maxZoom: number;
  themeLightBackground: string;
  themeLightSurface: string;
  themeLightText: string;
  themeDarkBackground: string;
  themeDarkSurface: string;
  themeDarkText: string;
  themeAccentPrimary: string;
  alertColorIdle: string;
  alertColorInfo: string;
  alertColorNotice: string;
  alertColorAlert: string;
  alertColorCritical: string;
  mailEnabled: boolean;
  mailHost?: string | null;
  mailPort?: number | null;
  mailSecure: boolean;
  mailUser?: string | null;
  mailFrom: string;
  mailPreview: boolean;
  securityAppUrl: string;
  invitationExpiryHours: number;
  passwordResetExpiryHours: number;
  mailPasswordSet: boolean;
  updatedAt: string;
}

export interface SerialConfig {
  devicePath?: string | null;
  baud?: number | null;
  dataBits?: number | null;
  parity?: string | null;
  stopBits?: number | null;
  delimiter?: string | null;
  reconnectBaseMs?: number | null;
  reconnectMaxMs?: number | null;
  reconnectJitter?: number | null;
  reconnectMaxAttempts?: number | null;
  enabled: boolean;
  updatedAt: string;
}

export interface SerialPortInfo {
  path: string;
  manufacturer?: string | null;
  serialNumber?: string | null;
  vendorId?: string | null;
  productId?: string | null;
}

export interface RuntimeConfig {
  env: string;
  siteId: string;
  mqtt: {
    enabled: boolean;
    commandsEnabled: boolean;
    namespace: string;
  };
  http: {
    port: number;
    redirectPort?: number;
  };
  https: {
    enabled: boolean;
    active: boolean;
  };
  websocket: {
    secure: boolean;
  };
}

export interface SiteSummary {
  id: string;
  name: string;
  color: string;
  region?: string | null;
  country?: string | null;
  city?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SerialState {
  connected: boolean;
  path?: string | null;
  baudRate?: number | null;
  lastError?: string | null;
  protocol?: string | null;
}

export type TakProtocol = 'UDP' | 'TCP' | 'HTTPS';

export interface TakConfig {
  id: number;
  enabled: boolean;
  protocol: TakProtocol;
  host?: string | null;
  port?: number | null;
  tlsEnabled: boolean;
  cafile?: string | null;
  certfile?: string | null;
  keyfile?: string | null;
  username?: string | null;
  password?: string | null;
  apiKey?: string | null;
  streamNodes: boolean;
  streamTargets: boolean;
  streamCommandAcks: boolean;
  streamCommandResults: boolean;
  streamAlertInfo: boolean;
  streamAlertNotice: boolean;
  streamAlertAlert: boolean;
  streamAlertCritical: boolean;
  lastConnected?: string | null;
  updatedAt: string;
}

export interface MqttSiteConfig {
  siteId: string;
  brokerUrl: string;
  clientId: string;
  username?: string | null;
  tlsEnabled: boolean;
  qosEvents: number;
  qosCommands: number;
  enabled: boolean;
  caPem?: string | null;
  certPem?: string | null;
  keyPem?: string | null;
  updatedAt: string;
  site?: {
    id: string;
    name: string;
    color: string;
  };
}

export type MqttStatusState = 'not_configured' | 'disabled' | 'connecting' | 'connected' | 'error';

export interface MqttSiteStatus {
  siteId: string;
  state: MqttStatusState;
  message?: string;
  updatedAt?: string;
}

export interface MqttTestResponse {
  ok: boolean;
  state: MqttStatusState;
  message: string;
}

export type SiteAccessLevel = 'VIEW' | 'MANAGE';

export interface FeatureFlagDefinition {
  key: string;
  label: string;
  description: string;
  defaultForRoles: UserRole[];
}

export interface UserSiteAccessGrant {
  siteId: string;
  level: SiteAccessLevel;
  siteName?: string | null;
}

export interface UserInvitationSummary {
  id: string;
  email: string;
  token: string;
  expiresAt: string;
  createdAt: string;
  acceptedAt?: string | null;
}

export interface AuditEntry {
  id: string;
  action: string;
  entity: string;
  entityId: string;
  createdAt: string;
  userId?: string | null;
  before?: unknown;
  after?: unknown;
}

export type UserRole = 'ADMIN' | 'OPERATOR' | 'ANALYST' | 'VIEWER';

export interface SavedMapViewPreference {
  id: string;
  name: string;
  lat: number;
  lon: number;
  zoom: number;
  createdAt?: number;
}

export interface MapViewSnapshotPreference {
  id?: string;
  name?: string;
  lat: number;
  lon: number;
  zoom: number;
  updatedAt?: number;
}

export interface MapStatePreference {
  views?: SavedMapViewPreference[];
  lastView?: MapViewSnapshotPreference | null;
}

export interface UserPreferences {
  theme: string;
  density: string;
  themePreset?: 'classic' | 'tactical_ops';
  language: string;
  timeFormat: '12h' | '24h';
  notifications?: {
    addons?: Record<string, boolean>;
    [key: string]: unknown;
  } | null;
  alertColors?: UserAlertColors | null;
  mapState?: MapStatePreference | null;
}

export interface UserAlertColors {
  idle?: string | null;
  info?: string | null;
  notice?: string | null;
  alert?: string | null;
  critical?: string | null;
}

export interface AuthUser {
  id: string;
  email: string;
  role: UserRole;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  jobTitle?: string | null;
  isActive: boolean;
  legalAccepted: boolean;
  legalAcceptedAt?: string | null;
  twoFactorEnabled: boolean;
  twoFactorEnabledAt?: string | null;
  failedLoginAttempts: number;
  lastFailedLoginAt?: string | null;
  lockedAt?: string | null;
  lockedUntil?: string | null;
  lockedReason?: string | null;
  lastLoginAt?: string | null;
  lastLoginIp?: string | null;
  lastLoginCountry?: string | null;
  lastLoginUserAgent?: string | null;
  anomalyFlag: boolean;
  createdAt: string;
  updatedAt: string;
  preferences: UserPreferences;
  permissions: string[];
  siteAccess: UserSiteAccessGrant[];
}

export interface LoginResponse {
  token: string;
  user: AuthUser;
  legalAccepted: boolean;
  disclaimer?: string;
  twoFactorRequired?: boolean;
  postLoginNotice?: string | null;
}

export interface MeResponse {
  user: AuthUser;
  legalAccepted: boolean;
  disclaimer?: string;
}

export interface TwoFactorSetupResponse {
  secret: string;
  otpauthUrl: string;
}

export interface TwoFactorConfirmResponse {
  user: AuthUser;
  recoveryCodes: string[];
}

export interface TwoFactorVerifyResponse {
  token: string;
  user: AuthUser;
  legalAccepted: boolean;
  recoveryUsed?: boolean;
}

export interface TwoFactorRegenerateResponse {
  recoveryCodes: string[];
}

export interface UserSummary extends AuthUser {}

export interface UserDetail extends AuthUser {
  pendingInvitations: UserInvitationSummary[];
}
