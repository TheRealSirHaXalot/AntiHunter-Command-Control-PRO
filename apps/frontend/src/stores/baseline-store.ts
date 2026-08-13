import { create } from 'zustand';

export interface BaselineNodeStatus {
  nodeId: string;
  scanning: boolean;
  established: boolean;
  devices: number;
  anomalies: number;
  phase?: string;
  updatedAt: string;
}

export interface BaselineAnomalyEntry {
  id: string;
  nodeId: string;
  timestamp: string;
  event: 'anomaly' | 'disappeared';
  kind?: string;
  type?: string;
  mac?: string;
  rssi?: number;
  reason?: string;
  name?: string;
  absentSeconds?: number;
}

export interface BaselineDoneSummary {
  nodeId: string;
  devices?: number;
  anomalies?: number;
  wifi?: number;
  ble?: number;
  tx?: number;
  pend?: number;
  timestamp: string;
}

interface BaselineStoreState {
  status: Record<string, BaselineNodeStatus>;
  anomalies: BaselineAnomalyEntry[];
  done: Record<string, BaselineDoneSummary>;
  setStatus: (status: BaselineNodeStatus) => void;
  addAnomaly: (anomaly: BaselineAnomalyEntry) => void;
  setDone: (done: BaselineDoneSummary) => void;
  clear: () => void;
}

const MAX_ANOMALIES = 300;

export const useBaselineStore = create<BaselineStoreState>()((set) => ({
  status: {},
  anomalies: [],
  done: {},
  setStatus: (status) => set((state) => ({ status: { ...state.status, [status.nodeId]: status } })),
  addAnomaly: (anomaly) =>
    set((state) => ({ anomalies: [anomaly, ...state.anomalies].slice(0, MAX_ANOMALIES) })),
  setDone: (done) => set((state) => ({ done: { ...state.done, [done.nodeId]: done } })),
  clear: () => set({ status: {}, anomalies: [], done: {} }),
}));
