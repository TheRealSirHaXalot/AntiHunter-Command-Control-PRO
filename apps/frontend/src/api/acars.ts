import { apiClient } from './client';
import type { AcarsMessage, AcarsStatus } from './types';

export function getAcarsStatus() {
  return apiClient.get<AcarsStatus>('/acars/status');
}

export function getAcarsMessages() {
  return apiClient.get<AcarsMessage[]>('/acars/messages');
}

export function updateAcarsConfig(body: { enabled?: boolean; udpHost?: string; udpPort?: number }) {
  return apiClient.post<AcarsStatus>('/acars/config', body);
}
