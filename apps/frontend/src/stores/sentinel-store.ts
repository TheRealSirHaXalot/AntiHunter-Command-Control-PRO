import { create } from 'zustand';

import { canonicalNodeId } from './node-store';

const MAX_DETECTIONS = 500;

export interface SentinelDetection {
  id: string;
  nodeId: string;
  siteId?: string;
  category: string;
  level: string;
  detectionType: string;
  label: string;
  mac?: string;
  rssi?: number;
  message: string;
  data: Record<string, unknown>;
  timestamp: string;
}

export interface SentinelStatus {
  nodeId: string;
  siteId?: string;
  enabled?: boolean;
  running?: boolean;
  mode?: string;
  updatedAt: string;
}

interface AddDetectionInput {
  id: string;
  nodeId: string;
  siteId?: string;
  category: string;
  level: string;
  detectionType: string;
  label: string;
  mac?: string;
  rssi?: number;
  message: string;
  data: Record<string, unknown>;
  timestamp: string;
}

interface SetStatusInput {
  nodeId: string;
  siteId?: string;
  enabled?: boolean;
  running?: boolean;
  mode?: string;
  timestamp?: string;
}

interface SentinelStoreState {
  detections: SentinelDetection[];
  status: Record<string, SentinelStatus>;
  addDetection: (input: AddDetectionInput) => void;
  setStatus: (input: SetStatusInput) => void;
  clearDetections: () => void;
}

export const useSentinelStore = create<SentinelStoreState>()((set) => ({
  detections: [],
  status: {},

  addDetection: (input) =>
    set((state) => {
      const detection: SentinelDetection = {
        ...input,
        nodeId: canonicalNodeId(input.nodeId),
        mac: input.mac ? input.mac.toUpperCase() : undefined,
      };
      const next = [detection, ...state.detections];
      if (next.length > MAX_DETECTIONS) {
        next.length = MAX_DETECTIONS;
      }
      return { detections: next };
    }),

  setStatus: (input) =>
    set((state) => {
      const nodeId = canonicalNodeId(input.nodeId);
      const key = `${input.siteId ?? 'default'}::${nodeId}`;
      const existing = state.status[key];
      return {
        status: {
          ...state.status,
          [key]: {
            nodeId,
            siteId: input.siteId ?? existing?.siteId,
            enabled: input.enabled ?? existing?.enabled,
            running: input.running ?? existing?.running,
            mode: input.mode ?? existing?.mode,
            updatedAt: input.timestamp ?? new Date().toISOString(),
          },
        },
      };
    }),

  clearDetections: () => set({ detections: [] }),
}));
