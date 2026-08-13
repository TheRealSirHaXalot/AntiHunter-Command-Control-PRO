/**
 * Unit test for the pure device classifier.
 * Run: npx tsx apps/backend/src/device-classification/device-classification.test.ts
 */

import {
  classifyDevice,
  smartName,
  ClassificationParams,
  DeviceStats,
} from './device-classification.types';

const MIN = 60_000;
const HOUR = 60 * MIN;

let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL: ${name} — expected ${String(expected)}, got ${String(actual)}`);
  }
}

const now = 1_000 * HOUR;
const baselineStart = now - 24 * HOUR;

const base: ClassificationParams = {
  now,
  baselineStart,
  windowMs: 24 * HOUR,
  gapMs: 30 * MIN,
  frequentFlierVisits: 3,
  visitorAbsenceMs: 2 * HOUR,
  stationaryPresencePct: 70,
};

const stat = (s: Partial<DeviceStats>): DeviceStats => ({
  firstSeen: now - 12 * HOUR,
  lastSeen: now,
  visitsInWindow: 1,
  presenceMsInWindow: 0,
  ...s,
});

// Stationary: present ~all window, one visit, seen before baseline
check(
  'stationary — high presence',
  classifyDevice(
    stat({
      firstSeen: now - 48 * HOUR,
      lastSeen: now,
      visitsInWindow: 1,
      presenceMsInWindow: 23 * HOUR,
    }),
    base,
  ),
  'stationary',
);

// Frequent flier: many gap-separated visits wins even over presence
check(
  'frequent-flier — visit count',
  classifyDevice(stat({ visitsInWindow: 5, presenceMsInWindow: 20 * HOUR }), base),
  'frequent-flier',
);

// Visitor: appeared after baseline, left, absent past threshold, no return
check(
  'visitor — post-baseline, departed',
  classifyDevice(
    stat({
      firstSeen: baselineStart + HOUR,
      lastSeen: now - 5 * HOUR,
      visitsInWindow: 1,
      presenceMsInWindow: 90 * MIN,
    }),
    base,
  ),
  'visitor',
);

// New: appeared after baseline and still present
check(
  'new — post-baseline, present',
  classifyDevice(
    stat({
      firstSeen: baselineStart + HOUR,
      lastSeen: now - 5 * MIN,
      visitsInWindow: 1,
      presenceMsInWindow: 40 * MIN,
    }),
    base,
  ),
  'new',
);

// Transient: pre-baseline, low presence, gone but not long enough / no baseline anomaly bucket
check(
  'transient — pre-baseline low presence, briefly gone',
  classifyDevice(
    stat({
      firstSeen: now - 20 * HOUR,
      lastSeen: now - 40 * MIN,
      visitsInWindow: 1,
      presenceMsInWindow: 20 * MIN,
    }),
    base,
  ),
  'transient',
);

// No baseline set: never classifies as visitor/new (both require baselineStart)
check(
  'no baseline — departed device is transient not visitor',
  classifyDevice(
    {
      firstSeen: now - 10 * HOUR,
      lastSeen: now - 5 * HOUR,
      visitsInWindow: 1,
      presenceMsInWindow: 30 * MIN,
    },
    { ...base, baselineStart: null },
  ),
  'transient',
);

// Window clamps to baselineStart: presence over the shorter (baseline→now) window
check(
  'stationary — presence measured against baseline-clamped window',
  classifyDevice(
    stat({
      firstSeen: baselineStart - HOUR,
      lastSeen: now,
      visitsInWindow: 1,
      presenceMsInWindow: 23 * HOUR,
    }),
    base,
  ),
  'stationary',
);

check('smartName format', smartName('visitor', 'AA:BB:CC:DD:E1:B2'), 'Visitor-E1B2');
check(
  'smartName frequent-flier',
  smartName('frequent-flier', 'aa:bb:cc:dd:ee:ff'),
  'Frequent-Flier-EEFF',
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
