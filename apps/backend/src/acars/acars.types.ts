export interface AcarsdecMessage {
  timestamp: number;
  station_id?: string;
  channel?: number;
  freq?: number;
  level?: number;
  noise?: number;
  error?: number;
  mode?: string;
  label?: string;
  block_id?: string;
  ack?: boolean;
  tail?: string;
  flight?: string;
  msgno?: string;
  text?: string;
  sublabel?: string;
  assstat?: string;
  app?: {
    name: string;
    ver: string;
  };
}

export interface AcarsdecResponse {
  messages?: AcarsdecMessage[];
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

export interface AcarsConfig {
  enabled: boolean;
  udpHost: string;
  udpPort: number;
}
