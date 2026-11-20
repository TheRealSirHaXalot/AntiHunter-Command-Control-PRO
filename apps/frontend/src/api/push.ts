import { apiClient } from './client';

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = (value + '='.repeat((4 - (value.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  return navigator.serviceWorker.ready;
}

export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) {
    return null;
  }
  const existing = await navigator.serviceWorker.getRegistration('/');
  return existing ? existing.pushManager.getSubscription() : null;
}

export async function enablePush(): Promise<void> {
  const permission =
    Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission !== 'granted' && Notification.permission !== 'granted') {
    throw new Error(
      `Notifications are ${Notification.permission} for this site. Allow them in the browser's site settings (and for the browser in system settings), then try again.`,
    );
  }
  const { publicKey } = await apiClient.get<{ publicKey: string | null }>('/push/public-key');
  if (!publicKey) {
    throw new Error('Push is not configured on the server.');
  }
  const reg = await registration();
  const serverKey = base64UrlToBytes(publicKey);
  let subscription = await reg.pushManager.getSubscription();
  const boundKey = subscription?.options.applicationServerKey;
  const bound = boundKey ? new Uint8Array(boundKey) : null;
  const sameKey =
    bound !== null &&
    bound.length === serverKey.length &&
    serverKey.every((byte, i) => byte === bound[i]);
  if (subscription && !sameKey) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: serverKey,
  });
  await apiClient.post('/push/subscriptions', subscription.toJSON());
}

export async function disablePush(): Promise<void> {
  const subscription = await currentPushSubscription();
  if (!subscription) {
    return;
  }
  await apiClient.delete('/push/subscriptions', {
    body: { endpoint: subscription.endpoint } as never,
  });
  await subscription.unsubscribe();
}

export interface PushTestResult {
  configured: boolean;
  sent: number;
  failed: number;
  gone: number;
  failures: { service: string; status: number | null; message: string }[];
}

export function sendTestPush(): Promise<PushTestResult> {
  return apiClient.post<PushTestResult>('/push/test');
}
