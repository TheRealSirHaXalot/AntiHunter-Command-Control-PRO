export interface BaselineEventRecord {
  id: string;
  kind: 'status' | 'done' | 'anomaly';
  createdAt: string;
  payload: unknown;
}
