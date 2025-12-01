#!/usr/bin/env node
/**
 * ACARS message simulator for local testing.
 *
 * Sends acarsdec-formatted JSON messages via UDP to test ACARS ingestion.
 * Messages are correlated with ADS-B aircraft via tail numbers for positioning.
 *
 * Options (env or CLI flags):
 *   --host / HOST           UDP host (default 127.0.0.1)
 *   --port / PORT           UDP port (default 15550)
 *   --interval / INTERVAL   Send interval in ms (default 10000)
 *   --count / COUNT         Number of different aircraft (default 3)
 */

const dgram = require('dgram');

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
    host: get('host', 'HOST', '127.0.0.1'),
    port: get('port', 'PORT', 15550),
    interval: get('interval', 'INTERVAL', 10000),
    count: get('count', 'COUNT', 3),
  };
}

const options = parseArgs();

// Sample aircraft with tail numbers matching common ADSB registrations
const aircraft = [
  { tail: 'N12345', flight: 'UAL123', callsign: 'UNITED123' },
  { tail: 'N789AB', flight: 'AAL456', callsign: 'AMERICAN456' },
  { tail: 'N456XY', flight: 'DAL789', callsign: 'DELTA789' },
  { tail: 'G-ABCD', flight: 'BAW101', callsign: 'SPEEDBIRD101' },
  { tail: 'N999ZZ', flight: 'SWA202', callsign: 'SOUTHWEST202' },
];

// Sample ACARS message texts
const messageTexts = [
  'REQUESTING CLEARANCE FOR DESCENT',
  'ENGINE PARAMETERS NORMAL',
  'FUEL REMAINING 12000 LBS',
  'ETA 1430Z',
  'ALTITUDE 35000 FT',
  'TURBULENCE LIGHT',
  'WEATHER CLEAR',
  'REQUESTING DIRECT TO WAYPOINT',
  'SPEED 450 KNOTS',
  'CABIN PRESSURE NORMAL',
];

// ACARS labels (message types)
const labels = ['H1', 'Q0', '_d', '5Z', '80', 'H2', '5U', '44'];

function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function createAcarsMessage(index) {
  const ac = aircraft[index % aircraft.length];
  const timestamp = Math.floor(Date.now() / 1000);
  const freq = 131.45 + Math.random() * 0.5; // VHF ACARS frequency
  const level = -15 + Math.random() * 10; // Signal level
  const noise = -35 + Math.random() * 5; // Noise level

  return {
    timestamp,
    station_id: 'TEST-STN',
    channel: 0,
    freq: Number(freq.toFixed(3)),
    level: Number(level.toFixed(1)),
    noise: Number(noise.toFixed(1)),
    error: 0,
    mode: '2',
    label: randomItem(labels),
    block_id: String.fromCharCode(65 + Math.floor(Math.random() * 26)),
    ack: false,
    tail: ac.tail,
    flight: ac.flight,
    msgno: String(Math.floor(Math.random() * 100)).padStart(3, '0'),
    text: randomItem(messageTexts),
    app: {
      name: 'acars-simulator',
      ver: '1.0',
    },
  };
}

const client = dgram.createSocket('udp4');

function sendMessages() {
  const messages = [];

  // Send 1-3 messages per batch
  const numMessages = Math.floor(Math.random() * 3) + 1;
  for (let i = 0; i < numMessages; i++) {
    messages.push(createAcarsMessage(Math.floor(Math.random() * options.count)));
  }

  const payload = JSON.stringify({ messages }, null, 2);
  const buffer = Buffer.from(payload);

  client.send(buffer, 0, buffer.length, options.port, options.host, (err) => {
    if (err) {
      console.error(`[acars-simulator] Error sending message: ${err.message}`);
    } else {
      console.log(
        `[acars-simulator] Sent ${messages.length} message(s) to ${options.host}:${options.port}`,
      );
      messages.forEach((msg) => {
        console.log(`  → ${msg.tail} [${msg.label}] ${msg.text?.substring(0, 40)}...`);
      });
    }
  });
}

// Send immediately on startup
sendMessages();

// Then send at regular intervals
setInterval(sendMessages, options.interval);

console.log(`[acars-simulator] Started`);
console.log(`  UDP target: ${options.host}:${options.port}`);
console.log(`  Interval: ${options.interval}ms`);
console.log(`  Aircraft count: ${options.count}`);
console.log(`  Sample tail numbers: ${aircraft.slice(0, options.count).map((a) => a.tail).join(', ')}`);
console.log('');
console.log('Messages will correlate with ADS-B if matching tail numbers are present.');
console.log('Press Ctrl+C to stop.');
