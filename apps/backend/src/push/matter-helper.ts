import { Endpoint, Environment, Logger, LogLevel, ServerNode, VendorId } from '@matter/main';
import { BridgedDeviceBasicInformationServer } from '@matter/main/behaviors/bridged-device-basic-information';
import { OccupancySensingServer } from '@matter/main/behaviors/occupancy-sensing';
import { OccupancySensorDevice } from '@matter/main/devices/occupancy-sensor';
import { AggregatorEndpoint } from '@matter/main/endpoints/aggregator';
import { execFileSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

Logger.level = LogLevel.WARN;

const IFF_POINTOPOINT = 0x10;

function pointToPointInterfaces(): Set<string> {
  const names = Object.keys(networkInterfaces());
  if (process.platform === 'linux') {
    return new Set(
      names.filter((name) => {
        try {
          return (
            (parseInt(readFileSync(`/sys/class/net/${name}/flags`, 'utf8'), 16) &
              IFF_POINTOPOINT) !==
            0
          );
        } catch {
          return false;
        }
      }),
    );
  }
  if (process.platform === 'darwin' || process.platform === 'freebsd') {
    try {
      const output = execFileSync('/sbin/ifconfig', ['-a'], { encoding: 'utf8' });
      return new Set(
        [...output.matchAll(/^([^\s:]+): flags=[0-9a-f]+<([^>]*)>/gim)]
          .filter((match) => match[2].split(',').includes('POINTOPOINT'))
          .map((match) => match[1]),
      );
    } catch {
      return new Set();
    }
  }
  return new Set();
}

function skipPointToPointMulticast() {
  const tunnels = pointToPointInterfaces();
  if (!tunnels.size) {
    return;
  }
  const { NodeJsNetwork } = createRequire(require.resolve('@matter/main'))('@matter/nodejs') as {
    NodeJsNetwork: {
      getMembershipMulticastInterfaces: (
        netInterfaceOrZone: string | undefined,
        ipv4: boolean,
      ) => (string | undefined)[];
    };
  };
  const original = NodeJsNetwork.getMembershipMulticastInterfaces.bind(NodeJsNetwork);
  NodeJsNetwork.getMembershipMulticastInterfaces = (netInterfaceOrZone, ipv4) =>
    original(netInterfaceOrZone, ipv4).filter(
      (entry) => entry === undefined || !tunnels.has(entry.replace(/^::%/, '')),
    );
}

const SENSORS = [
  { id: 'any-alert', name: 'AntiHunter Alert', levels: ['ALERT'] },
  { id: 'critical', name: 'AntiHunter Critical', levels: ['CRITICAL'] },
] as const;

const BRIDGE = process.env.AHCC_MATTER_LAYOUT !== 'flat';

const HOLD_MS = 60_000;

const INVALID_PASSCODES = new Set([
  0, 11111111, 22222222, 33333333, 44444444, 55555555, 66666666, 77777777, 88888888, 99999999,
  12345678, 87654321,
]);

const AlertSensor = OccupancySensorDevice.with(
  OccupancySensingServer.with('PassiveInfrared', 'OccupancyEvent'),
);

const BridgedAlertSensor = AlertSensor.with(BridgedDeviceBasicInformationServer);

const endpoints = new Map<string, Endpoint<typeof AlertSensor>>();
const timers = new Map<string, NodeJS.Timeout>();

function log(message: string) {
  process.stdout.write(`[matter-helper] ${message}\n`);
}

function passcode(): number {
  const fromEnv = Number(process.env.AHCC_MATTER_PASSCODE);
  if (
    Number.isInteger(fromEnv) &&
    fromEnv > 0 &&
    fromEnv < 99999999 &&
    !INVALID_PASSCODES.has(fromEnv)
  ) {
    return fromEnv;
  }
  let value = 0;
  while (INVALID_PASSCODES.has(value)) {
    value = randomInt(1, 99999999);
  }
  return value;
}

async function setOccupied(endpoint: Endpoint<typeof AlertSensor>, occupied: boolean) {
  try {
    await endpoint.set({ occupancySensing: { occupancy: { occupied } } });
  } catch (error) {
    log(`state update failed: ${error instanceof Error ? error.message : error}`);
  }
}

function trigger(severity: unknown) {
  for (const sensor of SENSORS) {
    if (sensor.levels && !(sensor.levels as readonly unknown[]).includes(severity)) {
      continue;
    }
    const endpoint = endpoints.get(sensor.id);
    if (!endpoint) {
      continue;
    }
    void setOccupied(endpoint, true);
    clearTimeout(timers.get(sensor.id));
    timers.set(
      sensor.id,
      setTimeout(() => void setOccupied(endpoint, false), HOLD_MS),
    );
  }
}

function restrictTree(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      restrictTree(child);
    } else if (entry.isFile()) {
      chmodSync(child, 0o600);
    }
  }
  chmodSync(path, 0o700);
}

async function main() {
  process.umask(0o077);
  const storage = process.env.AHCC_MATTER_STORAGE?.trim() || join(process.cwd(), '.matter');
  restrictTree(storage);
  Environment.default.vars.set('storage.path', storage);

  const network: { port: number; listeningAddressIpv4?: string; listeningAddressIpv6?: string } = {
    port: Number(process.env.AHCC_MATTER_PORT) || 5540,
  };
  const iface = process.env.AHCC_MATTER_INTERFACE?.trim();
  if (!iface) {
    skipPointToPointMulticast();
  }
  if (iface) {
    const addresses = networkInterfaces()[iface];
    if (!addresses?.length) {
      throw new Error(`AHCC_MATTER_INTERFACE ${iface} not found`);
    }
    Environment.default.vars.set('mdns.networkInterface', iface);
    const v4 = addresses.find((entry) => entry.family === 'IPv4');
    const v6 =
      addresses.find((entry) => entry.family === 'IPv6' && !entry.address.startsWith('fe80')) ??
      addresses.find((entry) => entry.family === 'IPv6');
    if (v4) {
      network.listeningAddressIpv4 = v4.address;
    }
    if (v6) {
      network.listeningAddressIpv6 = v6.address.startsWith('fe80')
        ? `${v6.address}%${iface}`
        : v6.address;
    }
    log(`bound to ${iface} (${[v4?.address, v6?.address].filter(Boolean).join(', ')})`);
  }

  const server = await ServerNode.create({
    id: 'ahcc',
    network,
    commissioning: { passcode: passcode(), discriminator: randomInt(4096) },
    productDescription: {
      name: 'AntiHunter',
      deviceType: BRIDGE ? AggregatorEndpoint.deviceType : AlertSensor.deviceType,
    },
    basicInformation: {
      vendorName: 'AntiHunter',
      vendorId: VendorId(0xfff1),
      productName: 'AntiHunter Command Center',
      productLabel: 'Command Center',
      productId: 0x8000,
      hardwareVersion: 1,
      hardwareVersionString: '1',
      softwareVersion: 1,
      softwareVersionString: '0.1.0',
      serialNumber: 'ahcc-0001',
      uniqueId: 'ahcc',
    },
  });

  if (BRIDGE) {
    const aggregator = new Endpoint(AggregatorEndpoint, { id: 'bridge' });
    await server.add(aggregator);
    for (const sensor of SENSORS) {
      const endpoint = new Endpoint(BridgedAlertSensor, {
        id: sensor.id,
        occupancySensing: { occupancy: { occupied: false } },
        bridgedDeviceBasicInformation: {
          nodeLabel: sensor.name,
          productName: sensor.name,
          vendorName: 'AntiHunter',
          uniqueId: `ahcc-${sensor.id}`,
          reachable: true,
        },
      });
      await aggregator.add(endpoint);
      endpoints.set(sensor.id, endpoint as unknown as Endpoint<typeof AlertSensor>);
    }
  } else {
    for (const sensor of SENSORS) {
      const endpoint = new Endpoint(AlertSensor, {
        id: sensor.id,
        occupancySensing: { occupancy: { occupied: false } },
      });
      await server.add(endpoint);
      endpoints.set(sensor.id, endpoint);
    }
  }

  const reportStatus = () => {
    const commissioned = server.lifecycle.isCommissioned;
    const codes = commissioned ? null : server.state.commissioning.pairingCodes;
    process.stdout.write(
      `@@ahcc-status ${JSON.stringify({
        commissioned,
        layout: BRIDGE ? 'bridge' : 'flat',
        manualPairingCode: codes?.manualPairingCode ?? null,
        qrPairingCode: codes?.qrPairingCode ?? null,
        passcode: commissioned ? null : server.state.commissioning.passcode,
      })}\n`,
    );
  };

  createInterface({ input: process.stdin }).on('line', (line) => {
    try {
      const message = JSON.parse(line) as { type?: string; severity?: unknown };
      if (message?.type === 'trigger') {
        trigger(message.severity);
      } else if (message?.type === 'erase') {
        log('erasing pairings and state');
        timers.forEach((timer) => clearTimeout(timer));
        void server.erase().finally(() => process.exit(0));
      }
    } catch {
      log('ignored malformed message');
    }
  });
  process.stdin.on('end', () => {
    timers.forEach((timer) => clearTimeout(timer));
    void server.close().finally(() => process.exit(0));
  });

  server.lifecycle.commissioned.on(reportStatus);
  server.lifecycle.decommissioned.on(reportStatus);

  await server.start();

  if (!server.lifecycle.isCommissioned) {
    log('ready to pair — open the Matter card in AHCC and click Show pairing code');
  } else {
    log('online (already paired)');
  }
  reportStatus();
}

main().catch((error) => {
  log(`not started: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
