import { Logger } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DeviceSignature {
  id: string;
  name: string;
  kind: string;
}

type Radio = 'WIFI' | 'BLE';

interface CatalogRule {
  kind: string;
  text: string;
  radio: Radio | null;
  enabled: boolean;
}

interface CatalogFleet {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  matchAny: boolean;
  rules: CatalogRule[];
}

interface Catalog {
  catalogVersion: number;
  fleets: CatalogFleet[];
}

interface NameRule {
  fleet: number;
  radio: Radio | null;
  test: (name: string) => boolean;
}

interface LongPrefix {
  fleet: number;
  radio: Radio | null;
  hex: string;
}

export interface CompiledSignatures {
  version: number;
  fleets: DeviceSignature[];
  oui: Record<Radio, Map<string, number[]>>;
  long: LongPrefix[];
  names: NameRule[];
}

const hexOnly = (value: string): string => value.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();

function glob(pattern: string): RegExp {
  const body = [...pattern]
    .map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${body}$`, 'i');
}

function add(map: Map<string, number[]>, key: string, fleet: number): void {
  const list = map.get(key);
  if (!list) {
    map.set(key, [fleet]);
  } else if (!list.includes(fleet)) {
    list.push(fleet);
  }
}

export function compileSignatures(catalog: Catalog): CompiledSignatures {
  const compiled: CompiledSignatures = {
    version: catalog.catalogVersion,
    fleets: [],
    oui: { WIFI: new Map(), BLE: new Map() },
    long: [],
    names: [],
  };
  for (const fleet of catalog.fleets) {
    if (!fleet.enabled || !fleet.matchAny) {
      continue;
    }
    const idx = compiled.fleets.length;
    compiled.fleets.push({ id: fleet.id, name: fleet.name, kind: fleet.kind });
    for (const rule of fleet.rules) {
      if (!rule.enabled || !rule.text?.trim()) {
        continue;
      }
      if (rule.kind === 'OUI' || rule.kind === 'MAC_PREFIX') {
        const hex = hexOnly(rule.text);
        if (hex.length === 6) {
          if (rule.radio !== 'BLE') add(compiled.oui.WIFI, hex, idx);
          if (rule.radio !== 'WIFI') add(compiled.oui.BLE, hex, idx);
        } else if (hex) {
          compiled.long.push({ fleet: idx, radio: rule.radio, hex });
        }
      } else if (rule.kind === 'NAME_CONTAINS') {
        const needle = rule.text.toLowerCase();
        compiled.names.push({
          fleet: idx,
          radio: rule.radio,
          test: (name) => name.toLowerCase().includes(needle),
        });
      } else if (rule.kind === 'NAME_GLOB') {
        const regex = glob(rule.text);
        compiled.names.push({ fleet: idx, radio: rule.radio, test: (name) => regex.test(name) });
      }
    }
  }
  return compiled;
}

function universalOui(macHex: string): string | null {
  const first = parseInt(macHex.slice(0, 2), 16);
  if (Number.isNaN(first) || (first & 0x02) === 0 || (first & 0x01) !== 0) {
    return null;
  }
  return (first & 0xfd).toString(16).toUpperCase().padStart(2, '0') + macHex.slice(2, 6);
}

export function matchSignatures(
  compiled: CompiledSignatures,
  device: { mac: string; type?: string | null; name?: string | null },
): DeviceSignature[] {
  const radio: Radio = (device.type ?? '').toUpperCase() === 'BLE' ? 'BLE' : 'WIFI';
  const macHex = hexOnly(device.mac);
  const hits = new Set<number>();
  for (const idx of compiled.oui[radio].get(macHex.slice(0, 6)) ?? []) hits.add(idx);
  if (radio === 'WIFI') {
    const univ = universalOui(macHex);
    if (univ) {
      for (const idx of compiled.oui.WIFI.get(univ) ?? []) hits.add(idx);
    }
  }
  for (const rule of compiled.long) {
    if ((rule.radio === null || rule.radio === radio) && macHex.startsWith(rule.hex)) {
      hits.add(rule.fleet);
    }
  }
  const name = device.name?.trim();
  if (name) {
    for (const rule of compiled.names) {
      if ((rule.radio === null || rule.radio === radio) && rule.test(name)) {
        hits.add(rule.fleet);
      }
    }
  }
  const ids = new Set([...hits].map((idx) => compiled.fleets[idx].id));
  if (ids.has('fleet-osmo')) ids.delete('fleet-dji');
  if (ids.has('fleet-meraki')) ids.delete('fleet-cisco');
  return compiled.fleets.filter((fleet) => ids.has(fleet.id));
}

let cached: CompiledSignatures | null | undefined;

export function loadSignatures(
  path = join(process.cwd(), 'data', 'fieldwatch', 'fieldwatch-signatures.json'),
): CompiledSignatures | null {
  if (cached === undefined) {
    try {
      cached = compileSignatures(JSON.parse(readFileSync(path, 'utf8')) as Catalog);
    } catch (error) {
      new Logger('DeviceSignatures').error(
        `Signature catalog not loaded from ${path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      cached = null;
    }
  }
  return cached;
}
