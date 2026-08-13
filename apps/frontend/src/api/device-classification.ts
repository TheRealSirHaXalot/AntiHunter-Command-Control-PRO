export type DeviceCategory = 'stationary' | 'frequent-flier' | 'visitor' | 'new' | 'transient';

export interface PresenceDevice {
  mac: string;
  siteId: string | null;
  vendor: string | null;
  firstSeen: string;
  lastSeen: string;
  hits: number;
  minRssi: number | null;
  maxRssi: number | null;
  nodeIds: string[];
  category: DeviceCategory | null;
  smartName: string | null;
  classifiedAt: string | null;
}

export interface BaselineConfig {
  id: string;
  baselineStart: string | null;
  rollingWindowMinutes: number;
  gapThresholdMinutes: number;
  frequentFlierVisits: number;
  visitorAbsenceMinutes: number;
  stationaryPresencePct: number;
  autoClassifyMinutes: number;
}

export interface ClassificationSummary {
  classified: number;
  counts: Record<string, number>;
  at: string;
}

export type BaselineConfigInput = Partial<
  Pick<
    BaselineConfig,
    | 'rollingWindowMinutes'
    | 'gapThresholdMinutes'
    | 'frequentFlierVisits'
    | 'visitorAbsenceMinutes'
    | 'stationaryPresencePct'
    | 'autoClassifyMinutes'
  >
>;
