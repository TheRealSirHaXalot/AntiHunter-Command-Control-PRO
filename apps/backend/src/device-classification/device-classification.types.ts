export type DeviceCategory = 'stationary' | 'frequent-flier' | 'visitor' | 'new' | 'transient';

export interface ClassificationParams {
  now: number;
  baselineStart: number | null;
  windowMs: number;
  gapMs: number;
  frequentFlierVisits: number;
  visitorAbsenceMs: number;
  stationaryPresencePct: number;
}

export interface DeviceStats {
  firstSeen: number;
  lastSeen: number;
  visitsInWindow: number;
  presenceMsInWindow: number;
}

const CATEGORY_LABEL: Record<DeviceCategory, string> = {
  stationary: 'Stationary',
  'frequent-flier': 'Frequent-Flier',
  visitor: 'Visitor',
  new: 'New',
  transient: 'Transient',
};

export function classifyDevice(stats: DeviceStats, params: ClassificationParams): DeviceCategory {
  const rollingStart = params.now - params.windowMs;
  const windowStart =
    params.baselineStart != null ? Math.max(params.baselineStart, rollingStart) : rollingStart;
  const windowLen = Math.max(0, params.now - windowStart);

  const presencePct =
    windowLen > 0
      ? (stats.presenceMsInWindow / windowLen) * 100
      : stats.presenceMsInWindow > 0
        ? 100
        : 0;
  const currentlyPresent = params.now - stats.lastSeen <= params.gapMs;
  const isPostBaseline = params.baselineStart != null && stats.firstSeen >= params.baselineStart;
  const absence = params.now - stats.lastSeen;

  if (stats.visitsInWindow >= params.frequentFlierVisits) {
    return 'frequent-flier';
  }
  if (presencePct >= params.stationaryPresencePct) {
    return 'stationary';
  }
  if (isPostBaseline && !currentlyPresent && absence >= params.visitorAbsenceMs) {
    return 'visitor';
  }
  if (isPostBaseline && currentlyPresent) {
    return 'new';
  }
  return 'transient';
}

export function smartName(category: DeviceCategory, mac: string): string {
  const hex = mac.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  const suffix = hex.slice(-4) || hex || 'XXXX';
  return `${CATEGORY_LABEL[category]}-${suffix}`;
}
