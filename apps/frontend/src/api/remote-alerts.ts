import { apiClient } from './client';
import { getAuthToken } from '../auth/session';

export interface RemoteAlertConfig {
  tailscaleEnabled: boolean;
  hasTsAuthKey: boolean;
  tsHostname: string | null;
  tsAllowedLogins: string[];
  vapidPublicKey: string | null;
  vapidSubject: string | null;
  hasVapidPrivateKey: boolean;
  ntfyEnabled: boolean;
  ntfyUrl: string | null;
  hasNtfyToken: boolean;
  signalEnabled: boolean;
  signalApiUrl: string | null;
  signalNumber: string | null;
  signalRecipients: string[];
  matrixEnabled: boolean;
  matrixHomeserverUrl: string | null;
  hasMatrixAccessToken: boolean;
  matrixRoomId: string | null;
  matterEnabled: boolean;
  matterLayout: 'bridge' | 'flat';
  matterInterface: string | null;
  alertTiers: Record<string, AlertTier>;
  coordsUnencrypted: boolean;
  updatedAt: string;
}

export type AlertTier = 'off' | 'alert' | 'critical';

export type RemoteAlertConfigUpdate = Partial<{
  tailscaleEnabled: boolean;
  tsAuthKey: string;
  tsHostname: string;
  tsAllowedLogins: string[];
  vapidSubject: string;
  ntfyEnabled: boolean;
  ntfyUrl: string;
  ntfyToken: string;
  signalEnabled: boolean;
  signalApiUrl: string;
  signalNumber: string;
  signalRecipients: string[];
  matrixEnabled: boolean;
  matrixHomeserverUrl: string;
  matrixAccessToken: string;
  matrixRoomId: string;
  matterEnabled: boolean;
  matterLayout: 'bridge' | 'flat';
  matterInterface: string;
  alertTiers: Record<string, AlertTier>;
  coordsUnencrypted: boolean;
}>;

export interface MatterStatus {
  running: boolean;
  runtime: string;
  commissioned: boolean | null;
  layout: string | null;
  manualPairingCode: string | null;
  qrPairingCode: string | null;
  passcode: number | null;
  lastExit: string | null;
}

export interface PushSubscriptionRow {
  endpoint: string;
  service: string;
  userEmail: string;
  createdAt: string;
}

export type AlertChannel = 'push' | 'ntfy' | 'signal' | 'matrix' | 'matter';

export const getRemoteAlertConfig = () => apiClient.get<RemoteAlertConfig>('/remote-alerts/config');

export const updateRemoteAlertConfig = (body: RemoteAlertConfigUpdate) =>
  apiClient.put<RemoteAlertConfig>('/remote-alerts/config', body);

export const clearRemoteAlertSecret = (field: 'ntfyToken' | 'matrixAccessToken') =>
  apiClient.delete<RemoteAlertConfig>(`/remote-alerts/config/secret/${field}`);

export const generateVapidKeys = () =>
  apiClient.post<{ publicKey: string }>('/remote-alerts/vapid/generate');

export const listPushSubscriptions = () =>
  apiClient.get<PushSubscriptionRow[]>('/remote-alerts/push/subscriptions');

export const removePushSubscription = (endpoint: string) =>
  apiClient.delete('/remote-alerts/push/subscriptions', { body: { endpoint } as never });

export const testAlertChannel = (channel: AlertChannel) =>
  apiClient.post(`/remote-alerts/test/${channel}`);

export interface AlertSourceRow {
  key: string;
  label: string;
  group: string;
  defaultTier: AlertTier;
  tier: AlertTier;
}

export const getTailscaleStatus = () =>
  apiClient.get<{
    available: boolean;
    running: boolean;
    connecting: boolean;
    dnsName: string | null;
    https: boolean;
    ip: string | null;
    tailnet: string | null;
    lastError: string | null;
    lastExit: string | null;
    enrolled: boolean;
  }>('/remote-alerts/tailscale/status');

export const getSignalStatus = () =>
  apiClient.get<{
    reachable: boolean;
    linkedNumber: string | null;
    managed: boolean;
    supported: boolean;
  }>('/remote-alerts/signal/status');

export const getSignalUpdate = () =>
  apiClient.get<{ current: string; latest: string | null; updateAvailable: boolean }>(
    '/remote-alerts/signal/update',
  );

export const getSignalSetup = () =>
  apiClient.get<{
    platform: string;
    arch: string;
    supported: boolean;
    steps: { text: string; cmd?: string; url?: string }[];
    controls: { start: string; stop: string; restart: string } | null;
  }>('/remote-alerts/signal/setup');

export async function fetchSignalLinkQr(): Promise<Blob> {
  const token = getAuthToken();
  const response = await fetch('/api/remote-alerts/signal/link-qr', {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    let message = `Could not get a Signal QR code (${response.status})`;
    try {
      const body = (await response.json()) as { message?: string };
      if (body.message) {
        message = body.message;
      }
    } catch {
      message = `Could not get a Signal QR code (${response.status})`;
    }
    throw new Error(message);
  }
  return response.blob();
}

export const listAlertSources = () => apiClient.get<AlertSourceRow[]>('/remote-alerts/sources');

export const getMatterStatus = () => apiClient.get<MatterStatus>('/remote-alerts/matter/status');

export const getMatterInterfaces = () =>
  apiClient.get<{ name: string; addresses: string[] }[]>('/remote-alerts/matter/interfaces');

export const restartMatter = () => apiClient.post<MatterStatus>('/remote-alerts/matter/restart');

export const eraseMatter = () => apiClient.post<MatterStatus>('/remote-alerts/matter/erase');
