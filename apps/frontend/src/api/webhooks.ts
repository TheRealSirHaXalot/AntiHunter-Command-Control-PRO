import { apiClient } from './client';
import type { Webhook } from './types';

export function listWebhooks() {
  return apiClient.get<Webhook[]>('/webhooks');
}

export function createWebhook(payload: {
  name: string;
  url: string;
  secret?: string;
  enabled?: boolean;
  shareWithEveryone?: boolean;
  verifyTls?: boolean;
  clientCertificate?: string;
  clientKey?: string;
  caBundle?: string;
}) {
  return apiClient.post<Webhook, typeof payload>('/webhooks', payload);
}

export function updateWebhook(
  id: string,
  payload: Partial<{
    name: string;
    url: string;
    secret?: string;
    enabled?: boolean;
    shareWithEveryone?: boolean;
    verifyTls?: boolean;
    clientCertificate?: string;
    clientKey?: string;
    caBundle?: string;
  }>,
) {
  return apiClient.patch<Webhook, typeof payload>(`/webhooks/${id}`, payload);
}

export function deleteWebhook(id: string) {
  return apiClient.delete<void>(`/webhooks/${id}`);
}

export function testWebhook(id: string) {
  return apiClient.post<Webhook, Record<string, never>>(`/webhooks/${id}/test`, {});
}
