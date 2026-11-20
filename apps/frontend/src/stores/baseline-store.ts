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
  load: (snapshot: BaselineSnapshot) => void;
  clear: () => void;
}

export interface BaselineSnapshot {
  status: BaselineNodeStatus[];
  anomalies: BaselineAnomalyEntry[];
  done: BaselineDoneSummary[];
}

const MAX_ANOMALIES = 300;

const anomalyKey = (a: BaselineAnomalyEntry) =>
  `${a.nodeId}|${a.timestamp}|${a.event}|${a.mac ?? ''}`;

function mergeAnomalies(
  existing: BaselineAnomalyEntry[],
  stored: BaselineAnomalyEntry[],
): BaselineAnomalyEntry[] {
  const byKey = new Map<string, BaselineAnomalyEntry>();
  for (const entry of [...stored, ...existing]) {
    if (!byKey.has(anomalyKey(entry))) {
      byKey.set(anomalyKey(entry), entry);
    }
  }
  return [...byKey.values()]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, MAX_ANOMALIES);
}

export const useBaselineStore = create<BaselineStoreState>()((set) => ({
  status: {},
  anomalies: [],
  done: {},
  setStatus: (status) => set((state) => ({ status: { ...state.status, [status.nodeId]: status } })),
  addAnomaly: (anomaly) =>
    set((state) => ({ anomalies: [anomaly, ...state.anomalies].slice(0, MAX_ANOMALIES) })),
  setDone: (done) => set((state) => ({ done: { ...state.done, [done.nodeId]: done } })),
  load: (snapshot) =>
    set((state) => {
      const status = { ...state.status };
      for (const s of snapshot.status) {
        const current = status[s.nodeId];
        if (!current || current.updatedAt < s.updatedAt) {
          status[s.nodeId] = s;
        }
      }
      const done = { ...state.done };
      for (const d of snapshot.done) {
        const current = done[d.nodeId];
        if (!current || current.timestamp < d.timestamp) {
          done[d.nodeId] = d;
        }
      }
      return { status, done, anomalies: mergeAnomalies(state.anomalies, snapshot.anomalies) };
    }),
  clear: () => set({ status: {}, anomalies: [], done: {} }),
}));
