#!/usr/bin/env node
/**
 * Lightweight ADS-B feed simulator for local testing.
 *
 * Serves a dump1090/readsb-style aircraft.json at /data/aircraft.json.
 *
 * Options (env or CLI flags):
 *   --port / PORT           HTTP port (default 8090)
 *   --count / COUNT         Number of aircraft to simulate (default 8)
 *   --interval / INTERVAL   Update interval in ms (default 1500)
 *   --lat / LAT             Center latitude (default 63.43)
 *   --lon / LON             Center longitude (default 10.39)
 *   --radius / RADIUS       Max offset from center in km (default 30)
 */

const http = require('http');

function parseArgs() {
  const args = process.argv.slice(2);
  const lookup = new Map();
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    const next = args[i + 1];
    if (key?.startsWith('--')) {
      lookup.set(key.replace(/^--/, ''), next ?? 'true');
    }
  }
  const get = (key, envKey, fallback) => {
    const val = lookup.get(key) ?? process.env[envKey];
    if (val === undefined) return fallback;
    const asNum = Number(val);
    return Number.isFinite(asNum) ? asNum : val;
  };
  return {
    port: get('port', 'PORT', 8090),
    count: get('count', 'COUNT', 8),
    interval: get('interval', 'INTERVAL', 1500),
    lat: get('lat', 'LAT', 63.43),
    lon: get('lon', 'LON', 10.39),
    radiusKm: get('radius', 'RADIUS', 30),
  };
}

const options = parseArgs();

function randomHex(length = 6) {
  const chars = '0123456789ABCDEF';
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

const AIRCRAFT_TYPES = [
  // Regular planes (A1-A4)
  { category: 'A1', callsign: 'N172CP', type: 'C172', description: 'Light aircraft', altRange: [2000, 8000], speedRange: [90, 130] },
  { category: 'A2', callsign: 'SKW789', type: 'CRJ7', description: 'Small commercial', altRange: [25000, 30000], speedRange: [350, 400] },
  { category: 'A3', callsign: 'UAL123', type: 'B738', description: 'Large commercial', altRange: [30000, 38000], speedRange: [420, 480] },
  { category: 'A4', callsign: 'DAL456', type: 'A321', description: 'Large commercial', altRange: [30000, 38000], speedRange: [420, 480] },
  // Heavy aircraft (A5)
  { category: 'A5', callsign: 'QFA12', type: 'A380', description: 'Heavy aircraft (>300,000 lbs)', altRange: [35000, 41000], speedRange: [460, 510] },
  { category: 'A5', callsign: 'BAW101', type: 'B77W', description: 'Heavy aircraft (>300,000 lbs)', altRange: [35000, 41000], speedRange: [460, 510] },
  // High performance / Fighter (A6)
  { category: 'A6', callsign: 'VIPER01', type: 'F16', description: 'High performance military', altRange: [15000, 25000], speedRange: [400, 600] },
  { category: 'A6', callsign: 'RAPTOR', type: 'F22', description: 'High performance military', altRange: [15000, 30000], speedRange: [400, 700] },
  // Helicopters (A7)
  { category: 'A7', callsign: 'LIFE1', type: 'H60', description: 'Rotorcraft', altRange: [500, 2000], speedRange: [100, 160] },
  { category: 'A7', callsign: 'ARMY23', type: 'AH64', description: 'Military rotorcraft', altRange: [300, 1500], speedRange: [100, 180] },
  // Gliders (B1)
  { category: 'B1', callsign: 'GLIDE3', type: 'ASW20', description: 'Glider/Sailplane', altRange: [3000, 12000], speedRange: [50, 90] },
  // Balloons (B2)
  { category: 'B2', callsign: 'BALLN1', type: 'BALL', description: 'Balloon/Airship', altRange: [2000, 8000], speedRange: [5, 25] },
  // UAVs/Drones (B6) 
  { category: 'B6', callsign: 'DRONE1', type: 'MQ9', description: 'Unmanned aerial system', altRange: [8000, 15000], speedRange: [120, 200] },
  { category: 'B6', callsign: 'PRED01', type: 'MQ1', description: 'Unmanned aerial system', altRange: [8000, 15000], speedRange: [100, 180] },
  // Ground vehicles (C1)
  { category: 'C1', callsign: 'TRUCK5', type: 'GRND', description: 'Ground vehicle - emergency', altRange: [0, 0], speedRange: [10, 40] },
];

function randomCallsign() {
  const prefixes = ['SAS', 'KLM', 'DLH', 'BAW', 'NAX', 'RYR', 'UAL', 'AAL', 'QTR', 'UAE'];
  const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
  const number = String(Math.floor(Math.random() * 900) + 100);
  return `${prefix}${number}`;
}

function randomDepDest() {
  const airports = ['OSL', 'TRD', 'SVG', 'BGO', 'CPH', 'ARN', 'LGW', 'AMS', 'FRA', 'CDG'];
  const dep = airports[Math.floor(Math.random() * airports.length)];
  let dest = airports[Math.floor(Math.random() * airports.length)];
  if (dest === dep) {
    dest = airports[(airports.indexOf(dep) + 3) % airports.length];
  }
  return { dep, dest };
}

function randomOffset(base, radiusKm) {
  // crude equirectangular offset for short distances
  const angle = Math.random() * Math.PI * 2;
  const distKm = Math.random() * radiusKm;
  const dLat = (distKm / 110.574) * Math.cos(angle);
  const dLon = (distKm / (111.320 * Math.cos((base.lat * Math.PI) / 180))) * Math.sin(angle);
  return { lat: base.lat + dLat, lon: base.lon + dLon };
}

function createAircraft(index) {
  const { dep, dest } = randomDepDest();
  const baseTrack = Math.random() * 360;

  // Use predefined aircraft types, cycling through them
  const aircraftType = AIRCRAFT_TYPES[index % AIRCRAFT_TYPES.length];

  // Generate altitude and speed within type's range
  const [minAlt, maxAlt] = aircraftType.altRange;
  const [minSpeed, maxSpeed] = aircraftType.speedRange;
  const alt = Math.floor(minAlt + Math.random() * (maxAlt - minAlt));
  const speed = Math.floor(minSpeed + Math.random() * (maxSpeed - minSpeed));

  return {
    hex: randomHex(),
    flight: aircraftType.callsign,
    lat: null,
    lon: null,
    alt_geom: alt,
    gs: speed,
    track: baseTrack,
    seen: 0,
    category: aircraftType.category,
    categoryDescription: aircraftType.description,
    aircraftType: aircraftType.type,
    typeCode: aircraftType.type,
    dep: aircraftType.category.startsWith('A') && !['A6', 'A7'].includes(aircraftType.category) ? dep : null,
    dest: aircraftType.category.startsWith('A') && !['A6', 'A7'].includes(aircraftType.category) ? dest : null,
    _drift: (Math.random() - 0.5) * 1.5,
    _altRange: aircraftType.altRange,
  };
}

const state = {
  aircraft: Array.from({ length: options.count }, (_, idx) => {
    const a = createAircraft(idx);
    const { lat, lon } = randomOffset({ lat: options.lat, lon: options.lon }, options.radiusKm);
    a.lat = lat;
    a.lon = lon;
    return a;
  }),
  messages: 0,
  now: Math.floor(Date.now() / 1000),
};

function step() {
  state.now = Math.floor(Date.now() / 1000);
  state.aircraft.forEach((a) => {
    a.seen = Math.min((a.seen ?? 0) + options.interval / 1000, 5);
    a.track = (a.track + a._drift + (Math.random() - 0.5) * 0.8 + 360) % 360;
    const moveKm = (a.gs / 3600) * (options.interval / 1000); // distance traveled this tick
    const headingRad = (a.track * Math.PI) / 180;
    const dLat = (moveKm / 110.574) * Math.cos(headingRad);
    const dLon = (moveKm / (111.320 * Math.cos((a.lat * Math.PI) / 180))) * Math.sin(headingRad);
    a.lat += dLat;
    a.lon += dLon;
    // slight altitude wiggle within type's range
    const [minAlt, maxAlt] = a._altRange || [500, 40000];
    const altChange = Math.floor((Math.random() - 0.5) * 200);
    a.alt_geom = Math.max(minAlt, Math.min(maxAlt, a.alt_geom + altChange));
    state.messages += 1;
  });
}

setInterval(step, options.interval);

const server = http.createServer((req, res) => {
  if (req.url && req.url.includes('/data/aircraft.json')) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');
    const payload = {
      now: state.now,
      messages: state.messages,
      aircraft: state.aircraft.map((a) => ({
        hex: a.hex,
        flight: a.flight,
        lat: a.lat,
        lon: a.lon,
        alt_geom: a.alt_geom,
        gs: a.gs,
        track: a.track,
        seen: a.seen,
        category: a.category,
        categoryDescription: a.categoryDescription,
        aircraftType: a.aircraftType,
        typeCode: a.typeCode,
        dep: a.dep,
        dest: a.dest,
      })),
    };
    res.write(JSON.stringify(payload, null, 2));
    res.end();
    return;
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  const categoryCounts = state.aircraft.reduce((acc, a) => {
    acc[a.category] = (acc[a.category] || 0) + 1;
    return acc;
  }, {});
  const categoryLabels = {
    A1: 'Light aircraft', A2: 'Small commercial', A3: 'Large commercial', A4: 'Large commercial',
    A5: 'Heavy aircraft', A6: 'High performance/Fighter', A7: 'Helicopter',
    B1: 'Glider', B2: 'Balloon', B6: 'UAV/Drone', C1: 'Ground vehicle'
  };
  const breakdown = Object.entries(categoryCounts)
    .map(([cat, count]) => `  ${cat} (${categoryLabels[cat]}): ${count}`)
    .join('\n');
  res.end(
    [
      'ADS-B simulator running with ALL aircraft types!',
      '',
      `Serving dump1090-style JSON at http://localhost:${options.port}/data/aircraft.json`,
      `Total aircraft: ${state.aircraft.length}, interval: ${options.interval}ms`,
      '',
      'Aircraft breakdown (ADS-B DO-260B categories):',
      breakdown,
      '',
      'Categories showcase:',
      '  ✈️  A1-A4: Commercial aircraft (light to large)',
      '  ✈️  A5: Heavy aircraft (A380, 747, 777)',
      '  ⚡ A6: High performance / Military fighters',
      '  🚁 A7: Helicopters / Rotorcraft',
      '  🪂 B1: Gliders / Sailplanes',
      '  🎈 B2: Balloons / Airships',
      '  🛸 B6: UAVs / Drones (anti-drone system)',
      '  🚗 C1: Ground vehicles',
    ].join('\n'),
  );
});

server.listen(options.port, () => {
  // eslint-disable-next-line no-console
  console.log(
    `[adsb-simulator] Listening on http://localhost:${options.port} (count=${state.aircraft.length}, interval=${options.interval}ms)`,
  );
});
