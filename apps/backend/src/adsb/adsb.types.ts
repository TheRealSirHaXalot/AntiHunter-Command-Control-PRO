import type { AlarmLevel } from '@prisma/client';

export interface AdsbTrack {
  id: string;
  icao: string;
  callsign?: string | null;
  lat: number;
  lon: number;
  alt?: number | null;
  speed?: number | null;
  heading?: number | null;
  onGround?: boolean | null;
  firstSeen: string;
  lastSeen: string;
  siteId?: string | null;
  category?: string | null;
  reg?: string | null;
  dep?: string | null;
  dest?: string | null;
  depTime?: string | null;
  destTime?: string | null;
  depDistanceM?: number | null;
  destDistanceM?: number | null;
  depCandidates?: number | null;
  destCandidates?: number | null;
  routeSource?: 'feed' | 'opensky' | null;
  typeCode?: string | null;
  model?: string | null;
  manufacturer?: string | null;
  aircraftType?: string | null;
  categoryDescription?: string | null;
  country?: string | null;
  messages?: number | null;
  depIata?: string | null;
  destIata?: string | null;
  depIcao?: string | null;
  destIcao?: string | null;
  depAirport?: string | null;
  destAirport?: string | null;
  photoUrl?: string | null;
  photoThumbUrl?: string | null;
  photoAuthor?: string | null;
  photoSourceUrl?: string | null;
}

export type AdsbAlertTarget = 'adsb' | 'acars';

export interface AdsbAlertConditions {
  callsignContains?: string | null;
  icaoEquals?: string | null;
  registrationContains?: string | null;
  countryEquals?: string | null;
  categoryEquals?: string | null;
  depEquals?: string | null;
  destEquals?: string | null;
  minAlt?: number | null;
  maxAlt?: number | null;
  minSpeed?: number | null;
  maxSpeed?: number | null;
  // ACARS
  tailContains?: string | null;
  flightContains?: string | null;
  labelEquals?: string | null;
  textContains?: string | null;
  minSignal?: number | null;
  maxNoise?: number | null;
  freqEquals?: number | null;
}

export interface AdsbAlertRule {
  id: string;
  name: string;
  description?: string | null;
  enabled: boolean;
  severity: AlarmLevel;
  target: AdsbAlertTarget;
  conditions: AdsbAlertConditions;
  alertRuleId?: string | null;
  notifyVisual?: boolean;
  notifyAudible?: boolean;
  notifyEmail?: boolean;
  emailRecipients?: string[] | null;
  showOnMap?: boolean;
  mapColor?: string | null;
  mapLabel?: string | null;
  blink?: boolean;
  messageTemplate?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdsbStatus {
  enabled: boolean;
  feedUrl: string;
  intervalMs: number;
  geofencesEnabled: boolean;
  lastPollAt?: string | null;
  lastError?: string | null;
  trackCount: number;
  aircraftDbCount?: number;
  openskyEnabled?: boolean;
  openskyClientId?: string | null;
  openskyStatus?: {
    enabled: boolean;
    clientIdPresent: boolean;
    lastFetchAt?: string | null;
    lastSuccessAt?: string | null;
    lastError?: string | null;
    failureCount?: number;
    cooldownUntil?: string | null;
    nextRouteRetryAt?: string | null;
    dailyBudget?: number;
    dailyUsed?: number;
    budgetResetsAt?: string | null;
  };
}
