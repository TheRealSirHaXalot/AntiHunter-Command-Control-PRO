#!/usr/bin/env node
const { ArgumentParser } = require('argparse');

const parser = new ArgumentParser({ description: 'Serial drone telemetry simulator' });
parser.add_argument('--base-url', {
  default: 'http://localhost:3000/api',
  help: 'Backend base URL',
});
parser.add_argument('--token', { help: 'Bearer token (ADMIN)' });
parser.add_argument('--mesh-prefix', {
  default: '1722',
  help: 'Forwarding prefix (e.g. router id)',
});
parser.add_argument('--node', { default: 'AH99', help: 'Mesh node (without NODE_ prefix)' });
parser.add_argument('--node-lat', { type: 'float', default: 40.7138 });
parser.add_argument('--node-lon', { type: 'float', default: -74.005 });
parser.add_argument('--start-distance', {
  type: 'float',
  default: 1100,
  help: 'Initial drone distance from node in meters',
});
parser.add_argument('--start-spread', {
  type: 'float',
  default: 0.35,
  help: 'Fractional variation applied to start distance (e.g. 0.35 = ±35%)',
});
parser.add_argument('--operator-radius', {
  type: 'float',
  default: 450,
  help: 'Radius (m) around the node where operators are positioned',
});
parser.add_argument('--operator-distance', {
  type: 'float',
  default: 5000,
  help: 'Distance (m) between the operator and the node/target',
});
parser.add_argument('--drone-count', {
  type: 'int',
  default: 1,
  help: 'Number of drones to simulate',
});
parser.add_argument('--iterations', { type: 'int', default: 60 });
parser.add_argument('--interval', '--message-interval', {
  dest: 'legacy_interval',
  type: 'int',
  help: 'Legacy single interval (ms) applied to all drones',
});
parser.add_argument('--interval-min', {
  type: 'int',
  default: 5000,
  help: 'Minimum per-drone interval (ms)',
});
parser.add_argument('--interval-max', {
  type: 'int',
  default: 5000,
  help: 'Maximum per-drone interval (ms)',
});
parser.add_argument('--speed-kmh', {
  type: 'float',
  help: 'Legacy single approach speed (km/h). Overrides min/max when provided.',
});
parser.add_argument('--speed-kmh-min', {
  type: 'float',
  default: 50,
  help: 'Minimum approach speed (km/h)',
});
parser.add_argument('--speed-kmh-max', {
  type: 'float',
  default: 70,
  help: 'Maximum approach speed (km/h)',
});
parser.add_argument('--altitude', { type: 'float', default: 120 });
parser.add_argument('--altitude-step', { type: 'float', default: 0.4 });
parser.add_argument('--speed', { type: 'float', default: 22 });
parser.add_argument('--speed-step', { type: 'float', default: 0.15 });
parser.add_argument('--rssi', { type: 'int', default: -65 });
parser.add_argument('--drone-id', { help: 'Single drone ID override' });
parser.add_argument('--drone-ids', {
  default: '1581F5FJD239C00DW22E,1581F3YTDJ1M0035S6Z0,1581F5FHD238R00D6R4M',
  help: 'Comma-separated drone IDs',
});
parser.add_argument('--mac', { help: 'Single MAC address override' });
parser.add_argument('--macs', {
  default: '60:60:1F:30:2C:3D,60:60:1F:09:CD:F6,60:60:1F:11:B2:8A',
  help: 'Comma-separated MAC addresses (paired with drone IDs)',
});

const args = parser.parse_args();

async function main() {
  const endpoint = `${args.base_url.replace(/\/$/, '')}/serial/simulate`;
  const nodeId = args.node.startsWith('NODE_') ? args.node : `NODE_${args.node}`;
  const scheduleSend = createRateLimiter(2000);
  const droneIds = (args.drone_ids ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const macs = (args.macs ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  const singleDroneId = (args.drone_id ?? droneIds[0] ?? '').trim();
  if (!singleDroneId) {
    throw new Error('Provide a drone id via --drone-id or --drone-ids');
  }
  const singleMac = (args.mac ?? macs[0] ?? generateMac(0)).trim();
  if (!singleMac) {
    throw new Error('Provide a MAC address via --mac or --macs');
  }

  const intervalRange = resolveRange(
    args.legacy_interval,
    args.interval_min,
    args.interval_max,
    5000,
  );
  const speedRange = resolveRange(args.speed_kmh, args.speed_kmh_min, args.speed_kmh_max, 70);

  await scheduleSend(() =>
    sendLines(
      endpoint,
      buildNodeBootstrapLines(args.mesh_prefix, nodeId, args.node_lat, args.node_lon),
      args.token,
    ),
  );
  const droneCount = Math.max(1, args.drone_count ?? 1);
  console.log(
    `Seeded node bootstrap telemetry. Simulating ${droneCount} drone(s) with intervals ${intervalRange.min}-${intervalRange.max}ms and speeds ${speedRange.min}-${speedRange.max} km/h`,
  );

  const drones = [];
  for (let i = 0; i < droneCount; i += 1) {
    const resolvedId = resolveDroneId(i, args, droneIds, singleDroneId);
    const resolvedMac = resolveDroneMac(i, args, macs, singleMac);
    drones.push(
      createDroneState({
        id: resolvedId,
        mac: resolvedMac,
        args,
        speedRange,
        intervalRange,
      }),
    );
  }

  await Promise.all(
    drones.map((drone, index) =>
      (async () => {
        if (index > 0) {
          await delay(index * 250);
        }
        await runDrone(drone, args, endpoint, nodeId, scheduleSend);
      })(),
    ),
  );

  console.log('Simulation complete. All drones finished their approach.');
}

function buildNodeBootstrapLines(prefix, nodeId, lat, lon) {
  const label = nodeId.replace(/^NODE_/, '');
  const status = `${prefix}: ${label}: STATUS: Mode:WiFi+BLE Scan:IDLE Hits:0 Temp:32.0C Up:00:05:00 GPS:${lat.toFixed(6)},${lon.toFixed(6)}`;
  const gps = `${prefix}: ${label}: GPS:LOCK Location ${lat.toFixed(6)},${lon.toFixed(6)} Satellites:12 HDOP:0.9`;
  return [status, gps];
}

function buildDroneLine(params) {
  const prefix = params.prefix ? `${params.prefix}: ` : '';
  const label = params.nodeId.replace(/^NODE_/, '');
  return `${prefix}${label}: DRONE: ${params.mac.toUpperCase()} ID:${params.droneId} R${params.rssi} GPS:${params.lat.toFixed(6)},${params.lon.toFixed(6)} ALT:${params.altitude.toFixed(1)} SPD:${params.speed.toFixed(1)} OP:${params.operatorLat.toFixed(6)},${params.operatorLon.toFixed(6)}`;
}

async function sendLines(endpoint, lines, token) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ lines }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Simulator request failed (${response.status}): ${body}`);
  }
}

function offsetFromNode(lat, lon, distanceMeters, headingDeg) {
  const rad = (headingDeg * Math.PI) / 180;
  const north = Math.cos(rad) * distanceMeters;
  const east = Math.sin(rad) * distanceMeters;
  const deltaLat = north / 111320;
  const deltaLon = east / (111320 * Math.cos((lat * Math.PI) / 180));
  return { lat: lat + deltaLat, lon: lon + deltaLon };
}

function bearingBetween(lat1, lon1, lat2, lon2) {
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const θ = Math.atan2(y, x);
  return normalizeHeading((θ * 180) / Math.PI);
}

function advanceDroneTowardTarget({ drone, targetLat, targetLon, metersPerStep }) {
  const desiredHeading = bearingBetween(drone.lat, drone.lon, targetLat, targetLon);
  const headingDiff = normalizeHeading(desiredHeading - drone.heading);
  const diffMagnitude = headingDiff > 180 ? 360 - headingDiff : headingDiff;
  const turnDirection = headingDiff > 180 ? -1 : 1;
  const baseTurn = Math.min(diffMagnitude, drone.turnAggression) * turnDirection;
  const jitter = randomBetween(-drone.turnJitter, drone.turnJitter);
  drone.heading = normalizeHeading(drone.heading + baseTurn + jitter);
  const headingForStep = drone.heading + randomBetween(-drone.curveRadius, drone.curveRadius);
  const nextPoint = offsetFromNode(drone.lat, drone.lon, metersPerStep, headingForStep);
  const { distance } = distanceMeters(nextPoint.lat, nextPoint.lon, targetLat, targetLon);
  return {
    lat: nextPoint.lat,
    lon: nextPoint.lon,
    reachedTarget: distance <= Math.max(20, metersPerStep * 0.75),
  };
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  const dLat = lat2 - lat1;
  const dLon = lon2 - lon1;
  const metersLat = dLat * 111320;
  const metersLon = dLon * 111320 * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  const dist = Math.sqrt(metersLat ** 2 + metersLon ** 2);
  return { distance: dist, dLat, dLon };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createRateLimiter(minIntervalMs) {
  let lastEmission = 0;
  let queue = Promise.resolve();
  return function enqueue(task) {
    queue = queue.then(async () => {
      const now = Date.now();
      const wait = Math.max(0, minIntervalMs - (now - lastEmission));
      if (wait > 0) {
        await delay(wait);
      }
      const result = await task();
      lastEmission = Date.now();
      return result;
    });
    return queue;
  };
}

function randomBetween(min, max) {
  if (min === max) {
    return min;
  }
  return Math.random() * (max - min) + min;
}

function clamp(value, min, max) {
  if (Number.isNaN(value)) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

function normalizeHeading(degrees) {
  const normalized = degrees % 360;
  return normalized >= 0 ? normalized : normalized + 360;
}

function resolveRange(singleValue, minValue, maxValue, fallback) {
  const sanitizedMin = typeof minValue === 'number' ? minValue : fallback;
  const sanitizedMax = typeof maxValue === 'number' ? maxValue : fallback;
  if (typeof singleValue === 'number' && Number.isFinite(singleValue)) {
    return { min: singleValue, max: singleValue };
  }
  const min = Math.min(sanitizedMin, sanitizedMax);
  const max = Math.max(sanitizedMin, sanitizedMax);
  return { min, max };
}

function generateMac(index) {
  const base = 0x11 + index * 0x11;
  const segments = ['AA', 'BB', 'CC', 'DD', 'EE', base.toString(16).padStart(2, '0')];
  return segments.map((segment) => segment.toUpperCase()).join(':');
}

function resolveDroneId(index, args, list, fallback) {
  if (args.drone_id) {
    return args.drone_count > 1 ? `${args.drone_id}-${index + 1}` : args.drone_id;
  }
  if (list[index]) {
    return list[index];
  }
  if (index === 0 && fallback) {
    return fallback;
  }
  return `SIMDRONE-${String(index + 1).padStart(3, '0')}`;
}

function resolveDroneMac(index, args, list, fallback) {
  if (args.mac) {
    return args.drone_count > 1 ? incrementMac(args.mac, index) : args.mac;
  }
  if (list[index]) {
    return list[index];
  }
  if (index === 0 && fallback) {
    return fallback;
  }
  return generateMac(index);
}

function incrementMac(baseMac, offset) {
  const segments = baseMac.split(':').map((segment) => parseInt(segment, 16));
  if (segments.length !== 6 || segments.some((value) => Number.isNaN(value))) {
    return generateMac(offset);
  }
  let carry = offset;
  for (let i = segments.length - 1; i >= 0 && carry > 0; i -= 1) {
    const value = segments[i] + carry;
    segments[i] = value & 0xff;
    carry = value >> 8;
  }
  return segments.map((value) => value.toString(16).padStart(2, '0')).join(':').toUpperCase();
}

function createDroneState({ id, mac, args, speedRange, intervalRange }) {
  const heading = randomBetween(0, 360);
  const operatorDistanceBase =
    typeof args.operator_distance === 'number' && Number.isFinite(args.operator_distance)
      ? Math.max(50, args.operator_distance)
      : Math.max(args.operator_radius, args.start_distance * 1.35);
  const operatorDistance = operatorDistanceBase * (1 + randomBetween(-args.start_spread, args.start_spread));
  const operatorHeading = normalizeHeading(heading + randomBetween(-18, 18));
  const operatorPoint = offsetFromNode(
    args.node_lat,
    args.node_lon,
    operatorDistance,
    operatorHeading,
  );

  const startPoint = { ...operatorPoint };

  const approachSpeedKmh = randomBetween(speedRange.min, speedRange.max);
  const intervalMs = Math.round(randomBetween(intervalRange.min, intervalRange.max));

  return {
    id,
    mac: mac.toUpperCase(),
    heading,
    approachSpeedKmh,
    intervalMs,
    lat: startPoint.lat,
    lon: startPoint.lon,
    operatorLat: operatorPoint.lat,
    operatorLon: operatorPoint.lon,
    altitude: args.altitude + randomBetween(-8, 8),
    airSpeed: args.speed + randomBetween(-4, 4),
    altitudeStep: args.altitude_step * randomBetween(0.5, 1.25),
    speedStep: args.speed_step * randomBetween(0.5, 1.5),
    turnAggression: randomBetween(8, 22),
    turnJitter: randomBetween(2, 8),
    curveRadius: randomBetween(2, 10),
  };
}

async function runDrone(drone, args, endpoint, nodeId, scheduleSend) {
  console.log(
    `Launching ${drone.id} (${drone.mac}) from heading ${drone.heading.toFixed(
      1,
    )}° at ${drone.approachSpeedKmh.toFixed(1)} km/h (interval ${drone.intervalMs} ms)`,
  );

  for (let i = 0; i < args.iterations; i += 1) {
    const metersPerStep = ((drone.approachSpeedKmh * 1000) / 3600) * (drone.intervalMs / 1000);
    const step = advanceDroneTowardTarget({
      drone,
      targetLat: args.node_lat,
      targetLon: args.node_lon,
      metersPerStep,
    });
    drone.lat = step.lat;
    drone.lon = step.lon;

    const line = buildDroneLine({
      prefix: args.mesh_prefix,
      nodeId,
      mac: drone.mac,
      droneId: drone.id,
      lat: drone.lat,
      lon: drone.lon,
      operatorLat: drone.operatorLat,
      operatorLon: drone.operatorLon,
      altitude: drone.altitude,
      speed: drone.airSpeed,
      rssi: args.rssi,
    });

    await scheduleSend(() => sendLines(endpoint, [line], args.token));
    console.log(`[${drone.id}] ${new Date().toISOString()} ${line}`);

    drone.altitude += drone.altitudeStep;
    drone.airSpeed += drone.speedStep;

    if (step.reachedTarget) {
      console.log(`${drone.id} reached the node after ${i + 1} steps.`);
      break;
    }

    await delay(drone.intervalMs);
  }
}

main().catch((err) => {
  console.error('Simulation failed', err);
  process.exit(1);
});
