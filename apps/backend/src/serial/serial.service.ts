import { clone, create, fromBinary, MessageShape, toBinary } from '@bufbuild/protobuf';
import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AutoDetectTypes } from '@serialport/bindings-cpp';
import * as SerialPortBindings from '@serialport/bindings-cpp';
import { ReadlineParser } from '@serialport/parser-readline';
import { SerialPortStream } from '@serialport/stream';
import { randomUUID } from 'crypto';
import { Observable, Subject } from 'rxjs';

import {
  ChannelRoleName,
  ChannelView,
  RadioReKeyRefused,
  SecurityConfigView,
  SecurityUpdate,
} from './fleet-admin.types';
import { MeshtasticFrameEvent, MeshtasticFrameParser } from './meshtastic-frame-parser';
import { createParser, ProtocolKey } from './protocol-registry';
import {
  deserializeSerialParseResult,
  serializeSerialParseResult,
  SerialClusterMessage,
  SerialClusterRole,
  SerialRpcAction,
} from './serial-cluster.types';
import { SerialConfigService } from './serial-config.service';
import { SERIAL_DELIMITER_CANDIDATES } from './serial.config.defaults';
import { SerialConnectionOptions, SerialState } from './serial.interfaces';
import { SerialParseResult, SerialProtocolParser } from './serial.types';
import { buildCommandPayload, redactCommandParams } from '../commands/command-builder';

const Binding = resolveBinding();
const dynamicImport = new Function('specifier', 'return import(specifier);') as <TModule>(
  specifier: string,
) => Promise<TModule>;

type MeshProtoModule = typeof import('@meshtastic/protobufs', {
  with: { 'resolution-mode': 'import' },
});
let meshProtoModulePromise: Promise<MeshProtoModule> | null = null;

function resolveBinding(): AutoDetectTypes {
  const withNamedExport = (SerialPortBindings as { autoDetect?: () => AutoDetectTypes }).autoDetect;
  if (typeof withNamedExport === 'function') {
    return withNamedExport();
  }

  const withDefaultExport = (SerialPortBindings as { default?: () => AutoDetectTypes }).default;
  if (typeof withDefaultExport === 'function') {
    return withDefaultExport();
  }

  throw new Error('No serialport binding available for the current platform');
}

class AsyncQueue {
  private pending: Array<() => Promise<void>> = [];
  private active = false;

  add<T>(task: () => Promise<T>, priority = false): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const wrapped = async () => {
        try {
          const result = await task();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      };
      if (priority) {
        this.pending.unshift(wrapped);
      } else {
        this.pending.push(wrapped);
      }
      void this.process();
    });
  }

  clear(): void {
    this.pending = [];
  }

  private async process(): Promise<void> {
    if (this.active) {
      return;
    }
    this.active = true;
    while (this.pending.length > 0) {
      const next = this.pending.shift();
      if (!next) {
        continue;
      }
      try {
        await next();
      } catch {
        // Individual task already rejected; continue processing the queue.
      }
    }
    this.active = false;
    if (this.pending.length > 0) {
      void this.process();
    }
  }
}

async function loadMeshModule(): Promise<MeshProtoModule> {
  if (!meshProtoModulePromise) {
    meshProtoModulePromise = dynamicImport<MeshProtoModule>('@meshtastic/protobufs');
  }
  return meshProtoModulePromise;
}

type SerialPortInfo = {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
};

function isUdevadmMissing(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const err = error as { code?: unknown; path?: unknown; spawnargs?: unknown[] };
  return err.code === 'ENOENT' && (err.path === 'udevadm' || err.spawnargs?.[0] === 'udevadm');
}

async function withGracefulUdevFallback(
  listFn: () => Promise<SerialPortInfo[]>,
): Promise<SerialPortInfo[] | null> {
  try {
    return await listFn();
  } catch (error) {
    if (isUdevadmMissing(error)) {
      console.warn(
        '[serial] udevadm not available in this environment; skipping hardware enumeration',
      );
      return [];
    }
    throw error;
  }
}

async function getAvailablePorts(): Promise<SerialPortInfo[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires,@typescript-eslint/no-unsafe-assignment
    const moduleRef: unknown = require('@serialport/list');
    const candidate =
      typeof moduleRef === 'function'
        ? moduleRef
        : moduleRef && typeof (moduleRef as { default?: unknown }).default === 'function'
          ? (moduleRef as { default: () => Promise<SerialPortInfo[]> }).default
          : moduleRef && typeof (moduleRef as { list?: unknown }).list === 'function'
            ? (moduleRef as { list: () => Promise<SerialPortInfo[]> }).list
            : null;
    if (candidate) {
      const ports = await withGracefulUdevFallback(() => candidate());
      if (ports) {
        return ports;
      }
    }
  } catch (error) {
    // ignore and fall back to binding-based listing
  }

  if ('list' in SerialPortStream) {
    const listFn = (SerialPortStream as unknown as { list: () => Promise<SerialPortInfo[]> }).list;
    const ports = await withGracefulUdevFallback(() => listFn());
    if (ports) {
      return ports;
    }
  }
  const bindingWithList = Binding as unknown as { list?: () => Promise<SerialPortInfo[]> };
  if (typeof bindingWithList.list === 'function') {
    const listFn = bindingWithList.list;
    const ports = await withGracefulUdevFallback(() => listFn());
    if (ports) {
      return ports;
    }
  }
  throw new Error('Serial port listing is not available on this platform.');
}

function normalizeDelimiter(value?: string | null): string {
  if (!value) {
    return '\n';
  }

  let normalized = value;

  if (normalized.includes('\\')) {
    normalized = normalized
      .replace(/\\r\\n/gi, '\r\n')
      .replace(/\\n/gi, '\n')
      .replace(/\\r/gi, '\r')
      .replace(/\\t/gi, '\t')
      .replace(/\\0/gi, '\0');
  }

  if (normalized.length === 0) {
    return '\n';
  }

  return normalized;
}

interface RateCounter {
  count: number;
  resetAt: number;
}

export interface LocalRadioInfo {
  num?: number;
  shortName?: string;
  longName?: string;
  lat?: number;
  lon?: number;
  positionAt?: number;
  batteryLevel?: number;
  deviceTime?: number;
  deviceTimeAt?: number;
}

export type RadioAction =
  | { action: 'reboot'; seconds: number }
  | { action: 'shutdown'; seconds: number }
  | { action: 'nodedbReset' }
  | { action: 'requestTelemetry'; nodeNum?: number }
  | { action: 'requestNodeInfo'; nodeNum?: number }
  | { action: 'setDisplay'; screenOnSecs: number }
  | { action: 'setBluetooth'; enabled: boolean; mode?: number; fixedPin?: number }
  | { action: 'setGpsMode'; gpsMode: number }
  | { action: 'setFixedPosition'; lat: number; lon: number; alt?: number }
  | { action: 'removeFixedPosition' }
  | { action: 'syncTime' }
  | { action: 'refresh' }
  | { action: 'wake' };

export interface RadioInfo {
  ownsPort: boolean;
  connected: boolean;
  radio: LocalRadioInfo;
  meshNodeCount: number;
  config: {
    display?: { screenOnSecs: number };
    bluetooth?: { enabled: boolean; mode: number };
    position?: { gpsMode: number; fixedPosition: boolean; positionBroadcastSecs: number };
    lora?: { region: number; modemPreset: number; hopLimit: number; txEnabled: boolean };
  };
}

export interface QueueCommandRequest {
  id: string;
  target: string;
  name: string;
  params: string[];
  userId?: string;
  line?: string;
}

@Injectable()
export class SerialService implements OnModuleInit, OnModuleDestroy {
  private port?: SerialPortStream;
  private lineParser?: ReadlineParser;
  private protocolParser: SerialProtocolParser = createParser('meshtastic-rewrite');
  private readonly incoming$ = new Subject<string>();
  private readonly parsed$ = new Subject<SerialParseResult>();
  private readonly logger = new Logger(SerialService.name);
  private lastError?: string;
  private connectionOptions?: SerialConnectionOptions;
  private readonly commandQueue = new AsyncQueue();
  private readonly globalRate: RateCounter = { count: 0, resetAt: 0 };
  private readonly targetRates = new Map<string, RateCounter>();
  private readonly globalRateLimit: number;
  private readonly perTargetRateLimit: number;
  private readonly rateWindowMs = 60_000;
  private siteId: string;
  private packetIdCounter = Math.floor(Math.random() * 0xffff);
  private readonly broadcastNum = 0xffffffff;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly reconnectJitter: number;
  private readonly reconnectMaxAttempts: number;
  private reconnectAttempts = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private radioHeartbeatTimer?: NodeJS.Timeout;
  private manualDisconnect = false;
  private lifecycle: Promise<void> = Promise.resolve();
  private heldTextLines?: string[];
  private readonly clusterRole: SerialClusterRole;
  private readonly clusterMessagingEnabled: boolean;
  private readonly rpcTimeoutMs: number;
  private readonly pendingRpc = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (reason?: unknown) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  private clusterMessageListener?: (message: unknown) => void;
  private replicaState: SerialState = { connected: false };
  private readonly recentMessageCache = new Map<
    string,
    { timestamp: number; content: string; rawLine: string }
  >(); // dedupe key -> {timestamp, content, rawLine}
  private readonly MESSAGE_CACHE_TTL_MS = 3000;
  private readonly seenPacketIds = new Map<number, number>();
  private readonly PACKET_ID_TTL_MS = 30000;
  private frameParser?: MeshtasticFrameParser;
  private readonly meshNodeNames = new Map<number, string>();
  private localRadio: LocalRadioInfo = {};
  private radioConfig: Record<string, unknown> = {};
  private readonly fleetTx = new Map<
    number,
    {
      expectedFrom: number;
      expectsReply: boolean;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private readonly sessionPasskeys = new Map<number, Uint8Array>();
  private configNonce = 0;

  constructor(
    private readonly configService: ConfigService,
    private readonly serialConfigService: SerialConfigService,
  ) {
    this.siteId = this.configService.get<string>('site.id', 'default');
    this.globalRateLimit = this.configService.get<number>('serial.globalRate', 30);
    this.perTargetRateLimit = this.configService.get<number>('serial.perTargetRate', 8);
    this.reconnectBaseMs = this.configService.get<number>('serial.reconnectBaseMs', 500);
    this.reconnectMaxMs = this.configService.get<number>('serial.reconnectMaxMs', 15_000);
    this.reconnectJitter = this.configService.get<number>('serial.reconnectJitter', 0.2);
    this.reconnectMaxAttempts =
      this.configService.get<number>('serial.reconnectMaxAttempts', 0) ?? 0;
    const configuredRole =
      (this.configService.get<string>('serial.clusterRole') as SerialClusterRole | undefined) ??
      'standalone';
    this.clusterRole =
      configuredRole === 'leader' || configuredRole === 'replica' ? configuredRole : 'standalone';
    this.clusterMessagingEnabled =
      this.clusterRole !== 'standalone' && typeof process.send === 'function';
    this.rpcTimeoutMs = this.configService.get<number>('serial.rpcTimeoutMs', 8000) ?? 8000;
  }

  async onModuleInit(): Promise<void> {
    this.setupClusterMessaging();
    if (this.clusterRole === 'replica') {
      this.logger.log(
        'Serial runtime running in replica mode; awaiting leader stream for parsed events.',
      );
      if (this.clusterMessagingEnabled) {
        await this.syncReplicaStateFromLeader().catch((error) => {
          this.logger.warn(
            `Initial serial state sync failed: ${error instanceof Error ? error.message : error}`,
          );
        });
      } else {
        this.logger.warn(
          'Replica role configured but cluster messaging unavailable; serial control endpoints will reject requests.',
        );
      }
      return;
    }

    await this.serializeLifecycle(() => this.autoConnect()).catch((error) => {
      this.handleAutoConnectFailure(error);
    });
    this.broadcastState();
  }

  onModuleDestroy(): void {
    if (this.clusterRole !== 'replica') {
      void this.disconnect();
    }
    this.teardownClusterMessaging();
  }

  private async autoConnect(): Promise<void> {
    const storedConfig = await this.serialConfigService.getConfig();
    if (storedConfig.enabled === false) {
      this.logger.log('Serial auto-connect disabled via configuration');
      return;
    }
    await this.connectInternal({
      path: storedConfig.devicePath ?? this.configService.get<string>('serial.device'),
      baudRate: storedConfig.baud ?? this.configService.get<number>('serial.baudRate', 115200),
      delimiter: storedConfig.delimiter ?? this.configService.get<string>('serial.delimiter', '\n'),
      protocol: (storedConfig.protocol ??
        this.configService.get<string>('serial.protocol', 'meshtastic-rewrite') ??
        'meshtastic-rewrite') as ProtocolKey,
      sendMode: storedConfig.sendMode,
      hopLimit: storedConfig.hopLimit ?? undefined,
      sendChannel: storedConfig.sendChannel ?? undefined,
    });
  }

  private handleAutoConnectFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error ?? 'Unknown error');
    if (error instanceof BadRequestException) {
      this.logger.log(`Serial auto-connect skipped: ${message}`);
    } else {
      this.logger.error(`Serial auto-connect failed: ${message}`);
    }
    this.lastError = message;
    this.broadcastState();
    this.scheduleReconnect(message);
  }

  getIncomingStream(): Observable<string> {
    return this.incoming$.asObservable();
  }

  getLocalRadio(): LocalRadioInfo {
    return { ...this.localRadio };
  }

  getMeshNodeCount(): number {
    return this.meshNodeNames.size;
  }

  getMeshNodeNames(): Map<number, string> {
    return new Map(this.meshNodeNames);
  }

  ownsPort(): boolean {
    return !this.shouldUseRpc();
  }

  async getRadioInfo(): Promise<RadioInfo> {
    if (this.shouldUseRpc()) {
      return { ...(await this.requestRpc<RadioInfo>('radioInfo')), ownsPort: false };
    }
    return this.buildRadioInfo();
  }

  async radioAction(request: RadioAction): Promise<void> {
    if (this.shouldUseRpc()) {
      await this.requestRpc('radioAction', request);
      return;
    }
    await this.radioActionInternal(request);
  }

  private buildRadioInfo(): RadioInfo {
    const display = this.radioConfig.display as { screenOnSecs?: number } | undefined;
    const bluetooth = this.radioConfig.bluetooth as
      | { enabled?: boolean; mode?: number }
      | undefined;
    const position = this.radioConfig.position as
      | { gpsMode?: number; fixedPosition?: boolean; positionBroadcastSecs?: number }
      | undefined;
    const lora = this.radioConfig.lora as
      | { region?: number; modemPreset?: number; hopLimit?: number; txEnabled?: boolean }
      | undefined;
    return {
      ownsPort: true,
      connected: Boolean(this.port),
      radio: { ...this.localRadio },
      meshNodeCount: this.meshNodeNames.size,
      config: {
        display: display ? { screenOnSecs: display.screenOnSecs ?? 0 } : undefined,
        bluetooth: bluetooth
          ? { enabled: bluetooth.enabled ?? false, mode: bluetooth.mode ?? 0 }
          : undefined,
        position: position
          ? {
              gpsMode: position.gpsMode ?? 0,
              fixedPosition: position.fixedPosition ?? false,
              positionBroadcastSecs: position.positionBroadcastSecs ?? 0,
            }
          : undefined,
        lora: lora
          ? {
              region: lora.region ?? 0,
              modemPreset: lora.modemPreset ?? 0,
              hopLimit: lora.hopLimit ?? 0,
              txEnabled: lora.txEnabled ?? false,
            }
          : undefined,
      },
    };
  }

  private async radioActionInternal(request: RadioAction): Promise<void> {
    const { Admin, Config, Mesh, Portnums } = await loadMeshModule();
    switch (request.action) {
      case 'refresh':
        this.ensureConnected();
        await this.initMeshtasticApi();
        return;
      case 'wake':
        await this.pulseReset();
        return;
      case 'requestTelemetry':
        await this.sendMeshData(
          request.nodeNum || this.requireLocalNum(),
          Portnums.PortNum.TELEMETRY_APP,
          new Uint8Array(),
          true,
        );
        return;
      case 'requestNodeInfo':
        await this.sendMeshData(
          request.nodeNum || this.broadcastNum,
          Portnums.PortNum.NODEINFO_APP,
          new Uint8Array(),
          true,
        );
        return;
      default:
        break;
    }

    const localNum = this.requireLocalNum();
    let configUpdate: { section: string; value: unknown } | undefined;
    let payloadVariant: Parameters<typeof create<typeof Admin.AdminMessageSchema>>[1] extends
      | infer Init
      | undefined
      ? Init extends { payloadVariant?: infer Variant }
        ? Variant
        : never
      : never;

    switch (request.action) {
      case 'reboot':
        payloadVariant = { case: 'rebootSeconds', value: Math.max(0, Math.floor(request.seconds)) };
        break;
      case 'shutdown':
        payloadVariant = {
          case: 'shutdownSeconds',
          value: Math.max(0, Math.floor(request.seconds)),
        };
        break;
      case 'nodedbReset':
        payloadVariant = { case: 'nodedbReset', value: 1 };
        break;
      case 'syncTime':
        payloadVariant = { case: 'setTimeOnly', value: Math.floor(Date.now() / 1000) };
        break;
      case 'removeFixedPosition':
        payloadVariant = { case: 'removeFixedPosition', value: true };
        break;
      case 'setFixedPosition':
        payloadVariant = {
          case: 'setFixedPosition',
          value: create(Mesh.PositionSchema, {
            latitudeI: Math.round(request.lat * 1e7),
            longitudeI: Math.round(request.lon * 1e7),
            altitude: Math.round(request.alt ?? 0),
            time: Math.floor(Date.now() / 1000),
          }),
        };
        break;
      case 'setDisplay': {
        const value = this.mergeRadioConfig(Config.Config_DisplayConfigSchema, 'display', {
          screenOnSecs: Math.max(0, Math.floor(request.screenOnSecs)),
        });
        configUpdate = { section: 'display', value };
        payloadVariant = {
          case: 'setConfig',
          value: create(Config.ConfigSchema, { payloadVariant: { case: 'display', value } }),
        };
        break;
      }
      case 'setBluetooth': {
        const value = this.mergeRadioConfig(Config.Config_BluetoothConfigSchema, 'bluetooth', {
          enabled: request.enabled,
          ...(request.mode !== undefined ? { mode: request.mode } : {}),
          ...(request.fixedPin !== undefined ? { fixedPin: request.fixedPin } : {}),
        });
        configUpdate = { section: 'bluetooth', value };
        payloadVariant = {
          case: 'setConfig',
          value: create(Config.ConfigSchema, { payloadVariant: { case: 'bluetooth', value } }),
        };
        break;
      }
      case 'setGpsMode': {
        const value = this.mergeRadioConfig(Config.Config_PositionConfigSchema, 'position', {
          gpsMode: request.gpsMode,
        });
        configUpdate = { section: 'position', value };
        payloadVariant = {
          case: 'setConfig',
          value: create(Config.ConfigSchema, { payloadVariant: { case: 'position', value } }),
        };
        break;
      }
      default:
        throw new BadRequestException('Unknown radio action');
    }

    const admin = create(Admin.AdminMessageSchema, { payloadVariant });
    await this.sendMeshData(
      localNum,
      Portnums.PortNum.ADMIN_APP,
      toBinary(Admin.AdminMessageSchema, admin),
      false,
    );

    if (configUpdate) {
      this.radioConfig[configUpdate.section] = configUpdate.value;
    }
    if (request.action === 'nodedbReset') {
      const ownName = this.meshNodeNames.get(localNum);
      this.meshNodeNames.clear();
      if (ownName) {
        this.meshNodeNames.set(localNum, ownName);
      }
    }
  }

  private mergeRadioConfig<Desc extends Parameters<typeof clone>[0]>(
    schema: Desc,
    section: string,
    patch: Record<string, unknown>,
  ): MessageShape<Desc> {
    const current = this.radioConfig[section];
    if (!current) {
      throw new BadRequestException('Radio settings not loaded yet. Press Refresh and try again.');
    }
    const next = clone(schema, current as MessageShape<Desc>);
    Object.assign(next, patch);
    return next;
  }

  private requireLocalNum(): number {
    if (!this.localRadio.num) {
      throw new BadRequestException('Radio not identified yet. Press Refresh and try again.');
    }
    return this.localRadio.num;
  }

  private async sendMeshData(
    to: number,
    portnum: number,
    payload: Uint8Array,
    wantResponse: boolean,
  ): Promise<void> {
    const { Mesh } = await loadMeshModule();
    const packet = create(Mesh.MeshPacketSchema, {
      id: this.nextPacketId(),
      to,
      channel: 0,
      wantAck: to !== this.broadcastNum,
      hopLimit: 3,
      payloadVariant: {
        case: 'decoded',
        value: create(Mesh.DataSchema, { portnum, payload, wantResponse }),
      },
    });
    const binary = toBinary(
      Mesh.ToRadioSchema,
      create(Mesh.ToRadioSchema, { payloadVariant: { case: 'packet', value: packet } }),
    );
    const frame = Buffer.alloc(4 + binary.length);
    frame[0] = 0x94;
    frame[1] = 0xc3;
    frame[2] = (binary.length >> 8) & 0xff;
    frame[3] = binary.length & 0xff;
    Buffer.from(binary).copy(frame, 4);
    await this.commandQueue.add(async () => {
      this.ensureConnected();
      await this.writeBuffer(frame);
    });
  }

  private async pulseReset(): Promise<void> {
    const port = this.port;
    if (!port) {
      throw new BadRequestException('Serial port is not connected');
    }
    const setLines = (lines: { dtr: boolean; rts: boolean }) =>
      new Promise<void>((resolve, reject) =>
        port.set(lines, (error) => (error ? reject(error) : resolve())),
      );
    await setLines({ dtr: false, rts: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await setLines({ dtr: false, rts: false });
  }

  // --- Fleet security admin transport (Meshtastic AdminMessage over serial) ---

  private readonly SECURITY_CONFIG_TYPE = 7;
  private readonly ROLE_TO_NUM: Record<ChannelRoleName, number> = {
    DISABLED: 0,
    PRIMARY: 1,
    SECONDARY: 2,
  };
  private readonly NUM_TO_ROLE: ChannelRoleName[] = ['DISABLED', 'PRIMARY', 'SECONDARY'];

  private fleetLocalNum(): number {
    if (!this.localRadio.num) {
      throw new BadRequestException('Radio not identified yet. Press Refresh and try again.');
    }
    return this.localRadio.num;
  }

  private isLocalTarget(nodeNum: number): boolean {
    return this.localRadio.num !== undefined && nodeNum === this.localRadio.num;
  }

  private async buildAdminInit(
    descriptor:
      | { t: 'getConfig'; configType: number }
      | { t: 'setSecurity'; security: SecurityUpdate }
      | { t: 'getChannel'; index: number }
      | {
          t: 'setChannel';
          channel: { index: number; name: string; role: ChannelRoleName; psk: Buffer };
        }
      | { t: 'beginEdit' }
      | { t: 'commitEdit' },
    remote: boolean,
    to: number,
  ): Promise<Record<string, unknown>> {
    const { Config, Channel } = await loadMeshModule();
    const init: Record<string, unknown> = {};
    if (remote) {
      const passkey = this.sessionPasskeys.get(to);
      if (passkey && passkey.length) {
        init.sessionPasskey = passkey;
      }
    }
    switch (descriptor.t) {
      case 'getConfig':
        init.payloadVariant = { case: 'getConfigRequest', value: descriptor.configType };
        break;
      case 'getChannel':
        init.payloadVariant = { case: 'getChannelRequest', value: descriptor.index + 1 };
        break;
      case 'beginEdit':
        init.payloadVariant = { case: 'beginEditSettings', value: true };
        break;
      case 'commitEdit':
        init.payloadVariant = { case: 'commitEditSettings', value: true };
        break;
      case 'setSecurity': {
        const sec: Record<string, unknown> = {};
        const u = descriptor.security;
        if (u.publicKey) sec.publicKey = u.publicKey;
        if (u.privateKey) sec.privateKey = u.privateKey;
        if (u.adminKeys) sec.adminKey = u.adminKeys;
        if (u.isManaged !== undefined) sec.isManaged = u.isManaged;
        if (u.adminChannelEnabled !== undefined) sec.adminChannelEnabled = u.adminChannelEnabled;
        init.payloadVariant = {
          case: 'setConfig',
          value: create(Config.ConfigSchema, {
            payloadVariant: { case: 'security', value: sec },
          }),
        };
        break;
      }
      case 'setChannel':
        init.payloadVariant = {
          case: 'setChannel',
          value: create(Channel.ChannelSchema, {
            index: descriptor.channel.index,
            role: this.ROLE_TO_NUM[descriptor.channel.role],
            settings: { name: descriptor.channel.name, psk: descriptor.channel.psk },
          }),
        };
        break;
    }
    return init;
  }

  private expectsAdminReply(descriptor: { t: string }): boolean {
    return descriptor.t === 'getConfig' || descriptor.t === 'getChannel';
  }

  private async sendAdmin(
    nodeNum: number,
    descriptor: Parameters<SerialService['buildAdminInit']>[0],
    options: { remote: boolean; timeoutMs: number; fireForget?: boolean },
  ): Promise<{ payloadVariant?: { case?: string; value?: unknown } } | null> {
    if (!this.ownsPort()) {
      throw new BadRequestException('Fleet security requires the node with the serial port');
    }
    const { Admin, Mesh, Portnums } = await loadMeshModule();
    const init = await this.buildAdminInit(descriptor, options.remote, nodeNum);
    const admin = create(Admin.AdminMessageSchema, init as never);
    const payload = toBinary(Admin.AdminMessageSchema, admin);
    const packetId = this.nextPacketId();
    const packet = create(Mesh.MeshPacketSchema, {
      id: packetId,
      to: nodeNum,
      channel: 0,
      wantAck: true,
      pkiEncrypted: options.remote,
      hopLimit: 3,
      payloadVariant: {
        case: 'decoded',
        value: create(Mesh.DataSchema, {
          portnum: Portnums.PortNum.ADMIN_APP,
          payload,
          wantResponse: this.expectsAdminReply(descriptor),
        }),
      },
    });
    const binary = toBinary(
      Mesh.ToRadioSchema,
      create(Mesh.ToRadioSchema, { payloadVariant: { case: 'packet', value: packet } }),
    );
    const frame = Buffer.alloc(4 + binary.length);
    frame[0] = 0x94;
    frame[1] = 0xc3;
    frame[2] = (binary.length >> 8) & 0xff;
    frame[3] = binary.length & 0xff;
    Buffer.from(binary).copy(frame, 4);

    if (options.fireForget) {
      await this.commandQueue.add(async () => {
        this.ensureConnected();
        await this.writeBuffer(frame);
      });
      return null;
    }

    const expectsReply = this.expectsAdminReply(descriptor);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fleetTx.delete(packetId);
        reject(new Error(`radio admin timed out (${descriptor.t})`));
      }, options.timeoutMs);
      this.fleetTx.set(packetId, {
        expectedFrom: nodeNum,
        expectsReply,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.commandQueue
        .add(async () => {
          this.ensureConnected();
          await this.writeBuffer(frame);
        })
        .catch((error) => {
          const pending = this.fleetTx.get(packetId);
          if (pending) {
            this.fleetTx.delete(packetId);
            clearTimeout(pending.timer);
          }
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  private decodeSecurityView(admin: {
    payloadVariant?: { case?: string; value?: unknown };
  }): SecurityConfigView {
    const cfg = admin.payloadVariant;
    if (cfg?.case !== 'getConfigResponse') {
      throw new Error('admin reply missing get_config_response');
    }
    const config = cfg.value as { payloadVariant?: { case?: string; value?: unknown } };
    if (config.payloadVariant?.case !== 'security') {
      throw new Error('config reply missing security section');
    }
    const sec = config.payloadVariant.value as {
      publicKey?: Uint8Array;
      privateKey?: Uint8Array;
      adminKey?: Uint8Array[];
      isManaged?: boolean;
      adminChannelEnabled?: boolean;
    };
    return {
      publicKey: Buffer.from(sec.publicKey ?? new Uint8Array()),
      adminKeys: (sec.adminKey ?? []).map((k) => Buffer.from(k)),
      isManaged: sec.isManaged ?? false,
      adminChannelEnabled: sec.adminChannelEnabled ?? false,
      hasPrivateKey: (sec.privateKey?.length ?? 0) === 32,
    };
  }

  private decodeChannelView(admin: {
    payloadVariant?: { case?: string; value?: unknown };
  }): ChannelView {
    const cfg = admin.payloadVariant;
    if (cfg?.case !== 'getChannelResponse') {
      throw new Error('admin reply missing get_channel_response');
    }
    const ch = cfg.value as {
      index?: number;
      role?: number;
      settings?: { name?: string; psk?: Uint8Array };
    };
    return {
      index: ch.index ?? 0,
      role: this.NUM_TO_ROLE[ch.role ?? 0] ?? 'DISABLED',
      name: ch.settings?.name ?? '',
      psk: Buffer.from(ch.settings?.psk ?? new Uint8Array()),
    };
  }

  private securityFromRadioConfig(): SecurityConfigView | null {
    const sec = this.radioConfig['security'] as
      | {
          publicKey?: Uint8Array;
          privateKey?: Uint8Array;
          adminKey?: Uint8Array[];
          isManaged?: boolean;
          adminChannelEnabled?: boolean;
        }
      | undefined;
    if (!sec || !(sec.publicKey?.length ?? 0)) {
      return null;
    }
    return {
      publicKey: Buffer.from(sec.publicKey ?? new Uint8Array()),
      adminKeys: (sec.adminKey ?? []).map((k) => Buffer.from(k)),
      isManaged: sec.isManaged ?? false,
      adminChannelEnabled: sec.adminChannelEnabled ?? false,
      hasPrivateKey: (sec.privateKey?.length ?? 0) === 32,
    };
  }

  async fleetGetSecurity(nodeNum: number): Promise<SecurityConfigView> {
    if (this.isLocalTarget(nodeNum)) {
      const local = this.securityFromRadioConfig();
      if (local) {
        return local;
      }
    }
    const remote = !this.isLocalTarget(nodeNum);
    const reply = await this.sendAdmin(
      nodeNum,
      { t: 'getConfig', configType: this.SECURITY_CONFIG_TYPE },
      { remote, timeoutMs: remote ? 30_000 : 10_000 },
    );
    if (!reply) throw new Error('empty security reply');
    return this.decodeSecurityView(reply);
  }

  async fleetSetSecurity(nodeNum: number, update: SecurityUpdate): Promise<void> {
    const remote = !this.isLocalTarget(nodeNum);
    // Re-key guard (finding #17): OTA set-security without a 32-byte private key regenerates the node keypair.
    if (update.privateKey === undefined) {
      throw new RadioReKeyRefused(
        'Refusing over-the-air security change: Meshtastic would regenerate the node keypair and cut off admin. Provision admin keys locally over USB instead.',
      );
    }
    await this.sendAdmin(
      nodeNum,
      { t: 'setSecurity', security: update },
      {
        remote,
        timeoutMs: remote ? 30_000 : 10_000,
      },
    );
  }

  async fleetGetChannel(nodeNum: number, index: number): Promise<ChannelView> {
    const remote = !this.isLocalTarget(nodeNum);
    const reply = await this.sendAdmin(
      nodeNum,
      { t: 'getChannel', index },
      { remote, timeoutMs: remote ? 30_000 : 10_000 },
    );
    if (!reply) throw new Error('empty channel reply');
    return this.decodeChannelView(reply);
  }

  async fleetSetChannelLocal(channel: {
    index: number;
    name: string;
    role: ChannelRoleName;
    psk: Buffer;
  }): Promise<void> {
    await this.sendAdmin(
      this.fleetLocalNum(),
      { t: 'setChannel', channel },
      {
        remote: false,
        timeoutMs: 10_000,
      },
    );
  }

  async fleetEstablishSession(nodeNum: number): Promise<void> {
    await this.fleetGetChannel(nodeNum, 0);
  }

  async fleetFireForget(
    nodeNum: number,
    descriptor: Parameters<SerialService['buildAdminInit']>[0],
  ): Promise<void> {
    await this.sendAdmin(nodeNum, descriptor, { remote: true, timeoutMs: 0, fireForget: true });
  }

  async fleetLocalAdmin(
    descriptor: Parameters<SerialService['buildAdminInit']>[0],
    timeoutMs = 10_000,
  ): Promise<{ payloadVariant?: { case?: string; value?: unknown } } | null> {
    return this.sendAdmin(this.fleetLocalNum(), descriptor, { remote: false, timeoutMs });
  }

  async fleetRemoteAdmin(
    nodeNum: number,
    descriptor: Parameters<SerialService['buildAdminInit']>[0],
    timeoutMs = 30_000,
  ): Promise<{ payloadVariant?: { case?: string; value?: unknown } } | null> {
    return this.sendAdmin(nodeNum, descriptor, { remote: true, timeoutMs });
  }

  getParsedStream(): Observable<SerialParseResult> {
    return this.parsed$.asObservable();
  }

  getState(): SerialState {
    if (this.clusterRole === 'replica') {
      return { ...this.replicaState };
    }
    return this.buildState();
  }

  private buildState(): SerialState {
    return {
      connected: Boolean(this.port),
      path: this.connectionOptions?.path ?? this.port?.path,
      baudRate: this.connectionOptions?.baudRate,
      lastError: this.lastError,
      protocol: this.connectionOptions?.protocol,
    };
  }

  getSiteId(): string {
    return this.siteId;
  }

  async listPorts(): Promise<SerialPortInfo[]> {
    if (this.shouldUseRpc()) {
      const ports = await this.requestRpc('listPorts');
      return (ports as SerialPortInfo[]) ?? [];
    }
    return getAvailablePorts();
  }

  async connect(options?: Partial<SerialConnectionOptions>): Promise<void> {
    if (this.shouldUseRpc()) {
      const state = (await this.requestRpc('connect', options)) as SerialState | undefined;
      this.updateReplicaState(state);
      return;
    }
    await this.serializeLifecycle(() => this.connectInternal(options));
    this.broadcastState();
  }

  async reconnectFromStoredConfig(): Promise<void> {
    if (this.clusterRole === 'replica') {
      return;
    }
    await this.serializeLifecycle(async () => {
      await this.performDisconnect();
      this.manualDisconnect = false;
      try {
        await this.autoConnect();
      } catch (error) {
        this.handleAutoConnectFailure(error);
      }
    });
    this.broadcastState();
  }

  private serializeLifecycle<T>(task: () => Promise<T>): Promise<T> {
    const run = this.lifecycle.then(task);
    this.lifecycle = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async disconnect(): Promise<void> {
    if (this.shouldUseRpc()) {
      const state = (await this.requestRpc('disconnect')) as SerialState | undefined;
      this.updateReplicaState(state);
      return;
    }
    await this.serializeLifecycle(() => this.performDisconnect());
    this.broadcastState();
  }

  async simulateLines(lines: string[]): Promise<void> {
    if (this.shouldUseRpc()) {
      await this.requestRpc('simulate', lines);
      return;
    }
    await this.simulateLinesInternal(lines);
  }

  private async connectInternal(options?: Partial<SerialConnectionOptions>): Promise<void> {
    if (this.port) {
      // Already connected in this process. If caller requests the same path (or no path), return silently.
      const requestedPath = options?.path?.trim();
      const currentPath = this.port.path ?? this.connectionOptions?.path;
      if (!requestedPath || requestedPath === currentPath) {
        this.logger.debug('Serial port already connected; returning existing connection state');
        return;
      }
      // Auto-disconnect from current port before connecting to a different one
      this.logger.log(`Switching serial port from ${currentPath ?? 'unknown'} to ${requestedPath}`);
      await this.performDisconnect();
    }

    this.clearReconnectTimer();
    const baudRate = options?.baudRate ?? this.configService.get<number>('serial.baudRate', 115200);
    const requestedDelimiterRaw =
      options?.delimiter ?? this.configService.get<string>('serial.delimiter', '\n') ?? '\n';
    const delimiterToken = requestedDelimiterRaw.trim();
    const autoDetect = delimiterToken.toLowerCase() === 'auto';
    const delimiter = autoDetect ? '\n' : normalizeDelimiter(delimiterToken);
    const writeDelimiters = (
      autoDetect
        ? SERIAL_DELIMITER_CANDIDATES.map((candidate) => normalizeDelimiter(candidate))
        : [delimiter]
    ).filter((value, index, array) => array.indexOf(value) === index);
    const protocol = (options?.protocol ??
      this.configService.get<string>('serial.protocol', 'meshtastic-rewrite') ??
      'meshtastic-rewrite') as ProtocolKey;

    const candidatePaths = await this.buildCandidatePaths(options?.path);
    if (candidatePaths.length === 0) {
      throw new BadRequestException('No serial devices available to connect.');
    }

    this.packetIdCounter = Math.floor(Math.random() * 0xffff);

    let lastError: unknown;
    for (const candidatePath of candidatePaths) {
      try {
        await this.openPort(candidatePath, {
          baudRate,
          delimiter,
          protocol,
          writeDelimiters,
          autoDetectDelimiter: autoDetect,
          rawDelimiter: delimiterToken,
          sendMode: options?.sendMode,
        });
        this.connectionOptions = {
          path: candidatePath,
          baudRate,
          delimiter,
          protocol,
          writeDelimiters,
          autoDetectDelimiter: autoDetect,
          rawDelimiter: delimiterToken,
          sendMode: options?.sendMode,
          hopLimit: options?.hopLimit,
          sendChannel: options?.sendChannel,
        };
        await this.serialConfigService.updateConfig({
          devicePath: candidatePath,
          baud: baudRate,
          delimiter: delimiterToken,
          enabled: true,
        });
        this.logger.log(`Connected to serial port ${candidatePath}`);
        this.lastError = undefined;
        this.reconnectAttempts = 0;
        return;
      } catch (error) {
        lastError = error;
        this.logger.warn(
          `Failed to connect to serial port ${candidatePath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (lastError instanceof Error) {
      throw new BadRequestException(lastError.message);
    }
    throw new BadRequestException('Unable to open any serial ports');
  }

  private async performDisconnect(): Promise<void> {
    const port = this.port;
    if (!port) {
      return;
    }

    this.manualDisconnect = true;
    this.clearReconnectTimer();
    const isOpen =
      typeof (port as SerialPortStream & { isOpen?: boolean }).isOpen === 'boolean'
        ? (port as SerialPortStream & { isOpen?: boolean }).isOpen
        : true;
    if (!isOpen) {
      this.cleanup();
      this.manualDisconnect = false;
      return;
    }

    try {
      await new Promise<void>((resolve, reject) => {
        port.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    } finally {
      this.cleanup();
      this.manualDisconnect = false;
    }
  }

  async queueCommand(request: QueueCommandRequest): Promise<void> {
    if (this.shouldUseRpc()) {
      await this.requestRpc('queueCommand', request);
      return;
    }
    await this.queueCommandInternal(request);
  }

  private async queueCommandInternal(request: QueueCommandRequest): Promise<void> {
    const built = buildCommandPayload({
      target: request.target,
      name: request.name,
      params: request.params,
    });
    const line = request.line ?? built.line;

    const sensitive = redactCommandParams(built.name, built.params) !== built.params;
    this.logger.debug(
      `Queueing command line: ${sensitive ? `${built.target} ${built.name}:***` : line}`,
    );

    const isStopCommand = built.name === 'STOP';
    if (isStopCommand) {
      this.logger.warn('STOP command requested; clearing pending command queue');
      this.commandQueue.clear();
    }

    await this.commandQueue.add(async () => {
      this.ensureConnected();
      this.logger.debug({
        writeProtocol: this.connectionOptions?.protocol,
        writePort: this.connectionOptions?.path,
        writeBaud: this.connectionOptions?.baudRate,
        writeOpen: this.port?.isOpen ?? false,
      });
      if (!isStopCommand) {
        this.consumeRate(this.globalRate, this.globalRateLimit);
        this.consumeRate(this.getTargetCounter(built.target), this.perTargetRateLimit);
      }
      const sendMode = (
        this.connectionOptions?.sendMode ??
        this.configService.get<string>('serial.sendMode') ??
        'protobuf'
      ).toLowerCase();
      const hopLimit =
        this.connectionOptions?.hopLimit ?? this.configService.get<number>('serial.hopLimit');

      const isMeshtasticRadio = this.localRadio.num !== undefined;
      if (isMeshtasticRadio && sendMode !== 'plain') {
        await this.sendMeshtasticCommand(line, {
          wantAck: false,
          hopLimit: Number.isFinite(hopLimit) ? (hopLimit as number) : undefined,
        });
      } else {
        await this.writeLine(line);
      }
    }, isStopCommand);
  }

  private cleanup(): void {
    this.heldTextLines = undefined;
    if (this.radioHeartbeatTimer) {
      clearInterval(this.radioHeartbeatTimer);
      this.radioHeartbeatTimer = undefined;
    }
    if (this.lineParser) {
      this.lineParser.removeAllListeners();
      this.lineParser = undefined;
    }
    if (this.frameParser) {
      this.frameParser.removeAllListeners();
      this.frameParser = undefined;
    }
    if (this.port) {
      this.port.removeAllListeners();
    }
    this.port = undefined;
    this.protocolParser.reset();
    this.connectionOptions = undefined;
    this.commandQueue.clear();
    this.globalRate.count = 0;
    this.globalRate.resetAt = 0;
    this.targetRates.clear();
    this.recentMessageCache.clear();
    this.meshNodeNames.clear();
    this.localRadio = {};
    this.radioConfig = {};
    this.packetIdCounter = Math.floor(Math.random() * 0xffff);
    this.broadcastState();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.manualDisconnect) {
      return;
    }
    if (this.reconnectMaxAttempts > 0 && this.reconnectAttempts >= this.reconnectMaxAttempts) {
      this.logger.warn(
        `Serial reconnect skipped: maximum attempts (${this.reconnectMaxAttempts}) reached`,
      );
      return;
    }
    if (this.reconnectTimer) {
      return;
    }
    if (this.reconnectBaseMs <= 0) {
      return;
    }
    const nextAttempt = this.reconnectAttempts + 1;
    const exponentialDelay = this.reconnectBaseMs * Math.pow(2, nextAttempt - 1);
    const cappedDelay =
      this.reconnectMaxMs > 0 ? Math.min(exponentialDelay, this.reconnectMaxMs) : exponentialDelay;
    const jitterRange = cappedDelay * this.reconnectJitter;
    const jitter = jitterRange ? (Math.random() * 2 - 1) * jitterRange : 0;
    const delay = Math.max(250, Math.round(cappedDelay + jitter));
    this.logger.warn(
      `Serial reconnect scheduled in ${delay}ms (attempt ${nextAttempt}${
        reason ? `, reason: ${reason}` : ''
      })`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.reconnectAttempts = nextAttempt;
      this.serializeLifecycle(() => this.autoConnect()).catch((error) =>
        this.handleAutoConnectFailure(error),
      );
    }, delay);
  }

  private async writeBuffer(buffer: Buffer): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const port = this.port;
      if (!port) {
        reject(new BadRequestException('Serial port is not connected'));
        return;
      }
      port.write(buffer, (err) => {
        if (err) {
          this.lastError = err.message;
          reject(err);
          return;
        }
        let settled = false;
        const cleanup = () => {
          settled = true;
        };
        const timeout = setTimeout(() => {
          if (settled) {
            return;
          }
          cleanup();
          this.logger.warn('Serial drain timed out; assuming write completed');
          resolve();
        }, 1000);
        port.drain((drainErr) => {
          if (settled) {
            return;
          }
          clearTimeout(timeout);
          cleanup();
          if (drainErr) {
            this.lastError = drainErr.message;
            reject(drainErr);
            return;
          }
          this.logger.debug(`Serial write completed (${buffer.length} bytes)`);
          resolve();
        });
      });
    });
  }

  private async writeLine(line: string): Promise<void> {
    this.ensureConnected();

    const writeDelimiters = this.connectionOptions?.writeDelimiters ?? [
      this.connectionOptions?.delimiter ?? '\n',
    ];
    const delimiter = writeDelimiters[0] ?? '\n';
    const payload = `${line}${delimiter}`;
    const buffer = Buffer.from(payload, 'utf8');

    this.logger.debug(
      {
        payload,
        hex: buffer.toString('hex'),
        delimiter: delimiter.replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t'),
      },
      'Serial command payload',
    );

    await this.writeBuffer(buffer);
  }

  private async sendMeshtasticCommand(
    line: string,
    options?: { wantAck?: boolean; hopLimit?: number },
  ): Promise<void> {
    this.ensureConnected();
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    const { Mesh, Portnums } = await loadMeshModule();

    const channelConfig =
      this.connectionOptions?.sendChannel ??
      this.configService.get<number>('serial.commandChannel') ??
      this.configService.get<number>('serial.sendChannel') ??
      0;
    const channelIndex = Number.isFinite(channelConfig) ? Number(channelConfig) : 0;

    const payload = Buffer.from(trimmed, 'utf8');
    const decoded = create(Mesh.DataSchema, {
      payload,
      portnum: Portnums.PortNum.TEXT_MESSAGE_APP,
      wantResponse: false,
      dest: 0,
      source: 0,
      requestId: 0,
      replyId: 0,
    });

    const packet = create(Mesh.MeshPacketSchema, {
      id: this.nextPacketId(),
      to: this.broadcastNum,
      channel: channelIndex,
      wantAck: options?.wantAck ?? false,
      priority: Mesh.MeshPacket_Priority.RELIABLE,
      payloadVariant: {
        case: 'decoded',
        value: decoded,
      },
      hopLimit:
        Number.isFinite(options?.hopLimit) && (options?.hopLimit as number) > 0
          ? (options?.hopLimit as number)
          : 3,
    });

    const toRadio = create(Mesh.ToRadioSchema, {
      payloadVariant: {
        case: 'packet',
        value: packet,
      },
    });

    const binary = toBinary(Mesh.ToRadioSchema, toRadio);
    const payloadBytes = Buffer.from(binary);
    const frame = Buffer.alloc(4 + payloadBytes.length);
    frame[0] = 0x94;
    frame[1] = 0xc3;
    frame[2] = (payloadBytes.length >> 8) & 0xff;
    frame[3] = payloadBytes.length & 0xff;
    payloadBytes.copy(frame, 4);

    this.logger.debug(
      { payload: trimmed, channelIndex, frameHex: frame.toString('hex') },
      'Meshtastic frame payload',
    );

    await this.writeBuffer(frame);
  }

  private updateLocalPosition(latitudeI?: number, longitudeI?: number, time?: number): void {
    if (time && time > 0) {
      this.localRadio = { ...this.localRadio, deviceTime: time, deviceTimeAt: Date.now() };
    }
    if (!latitudeI && !longitudeI) {
      return;
    }
    this.localRadio = {
      ...this.localRadio,
      lat: (latitudeI ?? 0) / 1e7,
      lon: (longitudeI ?? 0) / 1e7,
      positionAt: Date.now(),
    };
  }

  private updateLocalBattery(level?: number): void {
    if (level && level > 0) {
      this.localRadio = { ...this.localRadio, batteryLevel: Math.min(100, level) };
    }
  }

  private nextPacketId(): number {
    this.packetIdCounter = (this.packetIdCounter + 1) >>> 0;
    if (this.packetIdCounter === 0) {
      this.packetIdCounter = 1;
    }
    return this.packetIdCounter;
  }

  private ensureConnected(): void {
    if (!this.port) {
      throw new BadRequestException('Serial port is not connected');
    }
  }

  private consumeRate(counter: RateCounter, limit: number): void {
    const now = Date.now();
    if (now > counter.resetAt) {
      counter.count = 0;
      counter.resetAt = now + this.rateWindowMs;
    }

    if (counter.count >= limit) {
      throw new BadRequestException('Command rate limit exceeded');
    }

    counter.count += 1;
  }

  private getTargetCounter(target: string): RateCounter {
    const key = target || '@ALL';
    let counter = this.targetRates.get(key);
    if (!counter) {
      counter = { count: 0, resetAt: 0 };
      this.targetRates.set(key, counter);
    }
    return counter;
  }

  private async buildCandidatePaths(preferred?: string): Promise<string[]> {
    const ports = await getAvailablePorts();
    const candidates: string[] = [];

    // If a specific device path is configured, ONLY try that path
    // Don't fall back to other ports - respect the user's explicit configuration
    if (preferred) {
      candidates.push(preferred);
      return candidates;
    }

    // Only use autoselect when no specific path is configured
    const hints = ['meshtastic', 'cp210', 'ch34', 'silicon', 'usb serial', 'ttyusb', 'ttyacm'];
    const prioritized = ports
      .filter((port) => {
        const haystack = `${port.manufacturer ?? ''} ${port.productId ?? ''} ${
          port.vendorId ?? ''
        } ${port.path}`.toLowerCase();
        return hints.some((hint) => haystack.includes(hint));
      })
      .map((port) => port.path)
      .filter((path) => !candidates.includes(path));

    const others = ports
      .map((port) => port.path)
      .filter((path) => !candidates.includes(path) && !prioritized.includes(path));

    return [...candidates, ...prioritized, ...others];
  }

  private async openPort(
    path: string,
    options: {
      baudRate: number;
      delimiter: string;
      protocol: ProtocolKey;
      writeDelimiters: string[];
      autoDetectDelimiter: boolean;
      rawDelimiter?: string;
      sendMode?: string;
    },
  ): Promise<void> {
    this.logger.log(
      `Opening serial port ${path} @ ${options.baudRate} using protocol ${options.protocol}`,
    );

    let port: SerialPortStream;
    try {
      port = new SerialPortStream({
        binding: Binding,
        path,
        baudRate: options.baudRate,
        autoOpen: true,
      });
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to create serial port ${path}`, error as Error);
      throw error;
    }

    await new Promise<void>((resolve, reject) => {
      if (port.isOpen) {
        resolve();
        return;
      }

      const handleOpen = () => {
        cleanup();
        resolve();
      };
      const handleError = (err: Error) => {
        cleanup();
        this.lastError = err.message;
        reject(err);
      };
      const cleanup = () => {
        port.off('open', handleOpen);
        port.off('error', handleError);
      };

      port.once('open', handleOpen);
      port.once('error', handleError);
    });

    this.port = port;
    this.protocolParser = createParser(options.protocol);
    this.protocolParser.reset();

    // Always frame + handshake so a Meshtastic radio is detected regardless of protocol; text falls through to the protocol parser.
    this.frameParser = new MeshtasticFrameParser();
    this.port.pipe(this.frameParser);

    this.frameParser.on('data', (event: MeshtasticFrameEvent) => {
      if (event.type === 'frame') {
        this.logger.log(`[FRAME] protobuf ${(event.data as Buffer).length}B`);
        void this.handleMeshtasticFrame(event.data);
      } else if (event.type === 'text') {
        if (this.localRadio.num !== undefined) return;
        const line = (event.data as string).trim();
        if (!line) return;
        if (this.heldTextLines) {
          this.heldTextLines.push(line);
          return;
        }
        this.logger.log(`[TEXT] ${line.slice(0, 200)}`);
        this.processIncomingLine(line, 'serial');
      }
    });

    this.frameParser.on('error', (err: Error) => {
      this.logger.error(`Frame parser error: ${err.message}`, err.stack);
    });

    const plainMode =
      (
        options.sendMode ??
        this.configService.get<string>('serial.sendMode') ??
        'protobuf'
      ).toLowerCase() === 'plain';
    if (!plainMode) {
      void this.identifyRadioWithRetry();
    }

    this.radioHeartbeatTimer = setInterval(() => {
      void this.sendRadioHeartbeat().catch((err) =>
        this.logger.warn(`Meshtastic keepalive: ${err instanceof Error ? err.message : err}`),
      );
    }, 15 * 1000);

    this.port.on('error', (err) => {
      this.lastError = err.message;
      this.logger.error(`Serial port error: ${err.message}`, err.stack);
    });

    this.port.on('close', () => {
      if (this.port !== port) {
        return;
      }
      this.logger.warn('Serial port connection closed');
      this.cleanup();
      if (!this.manualDisconnect) {
        this.scheduleReconnect('port closed');
      }
    });
  }

  private async initMeshtasticApi(): Promise<void> {
    const { Mesh } = await loadMeshModule();

    const nonce = (Math.random() * 0xffffffff) >>> 0;
    this.configNonce = nonce;

    const toRadio = create(Mesh.ToRadioSchema, {
      payloadVariant: {
        case: 'wantConfigId',
        value: nonce,
      },
    });

    const binary = toBinary(Mesh.ToRadioSchema, toRadio);
    const payloadBuf = Buffer.from(binary);
    const frame = Buffer.alloc(4 + payloadBuf.length);
    frame[0] = 0x94;
    frame[1] = 0xc3;
    frame[2] = (payloadBuf.length >> 8) & 0xff;
    frame[3] = payloadBuf.length & 0xff;
    payloadBuf.copy(frame, 4);

    await this.writeBuffer(frame);
    this.logger.log(`Meshtastic API handshake sent (nonce=${nonce})`);
  }

  private async sendRadioHeartbeat(): Promise<void> {
    if (!this.port?.isOpen || this.localRadio.num === undefined) {
      return;
    }
    const { Mesh } = await loadMeshModule();
    const toRadio = create(Mesh.ToRadioSchema, {
      payloadVariant: {
        case: 'heartbeat',
        value: create(Mesh.HeartbeatSchema, {}),
      },
    });
    const payloadBuf = Buffer.from(toBinary(Mesh.ToRadioSchema, toRadio));
    const frame = Buffer.alloc(4 + payloadBuf.length);
    frame[0] = 0x94;
    frame[1] = 0xc3;
    frame[2] = (payloadBuf.length >> 8) & 0xff;
    frame[3] = payloadBuf.length & 0xff;
    payloadBuf.copy(frame, 4);
    await this.writeBuffer(frame);
  }

  private async identifyRadioWithRetry(): Promise<void> {
    const port = this.port;
    this.heldTextLines = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (!this.port || this.port !== port) {
        return;
      }
      try {
        await this.initMeshtasticApi();
      } catch (err) {
        this.logger.warn(`Meshtastic API init: ${err instanceof Error ? err.message : err}`);
      }
      await delay(3000);
      if (this.port !== port) {
        return;
      }
      if (this.localRadio.num) {
        this.heldTextLines = undefined;
        return;
      }
    }
    const held = this.heldTextLines ?? [];
    this.heldTextLines = undefined;
    for (const line of held) {
      this.logger.log(`[TEXT] ${line.slice(0, 200)}`);
      this.processIncomingLine(line, 'serial');
    }
  }

  private async handleMeshtasticFrame(frame: Buffer): Promise<void> {
    try {
      const meshModule = await loadMeshModule();
      const { Mesh, Portnums } = meshModule;
      const TelemetryModule = meshModule.Telemetry as
        | { TelemetrySchema?: unknown; DeviceMetricsSchema?: unknown }
        | undefined;

      const fromRadio = fromBinary(Mesh.FromRadioSchema, frame);
      const variant = fromRadio.payloadVariant;
      if (!variant) {
        this.logger.warn(`FromRadio with no payload variant (${frame.length}B)`);
        return;
      }

      this.logger.log(`FromRadio: case=${variant.case} (${frame.length}B)`);

      switch (variant.case) {
        case 'configCompleteId':
          this.logger.log(
            `Meshtastic config complete (id=${variant.value}), ` +
              `${this.meshNodeNames.size} nodes known`,
          );
          break;

        case 'config': {
          const section = (variant.value as { payloadVariant?: { case?: string; value?: unknown } })
            .payloadVariant;
          if (section?.case && section.value) {
            this.radioConfig[section.case] = section.value;
          }
          break;
        }

        case 'myInfo': {
          const myInfo = variant.value as { myNodeNum?: number };
          if (myInfo.myNodeNum) {
            this.localRadio = { ...this.localRadio, num: myInfo.myNodeNum };
          }
          break;
        }

        case 'nodeInfo': {
          const info = variant.value as {
            num?: number;
            user?: { longName?: string; shortName?: string };
            position?: { latitudeI?: number; longitudeI?: number; time?: number };
            deviceMetrics?: { batteryLevel?: number };
          };
          if (info.num && info.user?.longName) {
            this.meshNodeNames.set(info.num, info.user.longName);
            const hex = info.num.toString(16);
            this.logger.debug(`Node mapping: 0x${hex} → ${info.user.longName}`);
          }
          if (info.num && info.num === this.localRadio.num) {
            this.localRadio = {
              ...this.localRadio,
              shortName: info.user?.shortName || this.localRadio.shortName,
              longName: info.user?.longName || this.localRadio.longName,
            };
            this.updateLocalPosition(
              info.position?.latitudeI,
              info.position?.longitudeI,
              info.position?.time,
            );
            this.updateLocalBattery(info.deviceMetrics?.batteryLevel);
          }
          break;
        }

        case 'packet': {
          const packet = variant.value as {
            from?: number;
            to?: number;
            id?: number;
            channel?: number;
            rxRssi?: number;
            rxSnr?: number;
            payloadVariant?: {
              case: string;
              value?: {
                portnum?: number;
                payload?: Uint8Array;
                wantResponse?: boolean;
              };
            };
          };
          await this.handleMeshtasticPacket(packet, Mesh, Portnums, TelemetryModule);
          break;
        }

        case 'logRecord':
          break;

        default:
          break;
      }
    } catch (err) {
      this.logger.warn(
        `Failed to decode Meshtastic frame (${frame.length}B): ` +
          `${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private async handleMeshtasticPacket(
    packet: {
      from?: number;
      to?: number;
      id?: number;
      channel?: number;
      rxRssi?: number;
      rxSnr?: number;
      payloadVariant?: {
        case: string;
        value?: {
          portnum?: number;
          payload?: Uint8Array;
          wantResponse?: boolean;
          requestId?: number;
        };
      };
    },
    Mesh: Awaited<ReturnType<typeof loadMeshModule>>['Mesh'],
    Portnums: Awaited<ReturnType<typeof loadMeshModule>>['Portnums'],
    TelemetryModule?: { TelemetrySchema?: unknown; DeviceMetricsSchema?: unknown },
  ): Promise<void> {
    const decoded = packet.payloadVariant;
    if (!decoded || decoded.case !== 'decoded' || !decoded.value) return;

    if (packet.id) {
      const now = Date.now();
      const last = this.seenPacketIds.get(packet.id);
      if (last !== undefined && now - last < this.PACKET_ID_TTL_MS) {
        return;
      }
      this.seenPacketIds.set(packet.id, now);
      if (this.seenPacketIds.size > 512) {
        for (const [id, ts] of this.seenPacketIds) {
          if (now - ts > this.PACKET_ID_TTL_MS) this.seenPacketIds.delete(id);
        }
      }
    }

    const data = decoded.value;
    const fromNode = packet.from ?? 0;
    if (
      this.localRadio.num === undefined &&
      (data.portnum === Portnums.PortNum.POSITION_APP ||
        data.portnum === Portnums.PortNum.TELEMETRY_APP)
    ) {
      return;
    }
    const nodeName = this.meshNodeNames.get(fromNode) ?? `!${fromNode.toString(16)}`;
    const rssi = packet.rxRssi;

    switch (data.portnum) {
      case Portnums.PortNum.TEXT_MESSAGE_APP: {
        if (!data.payload?.length) return;
        const text = new TextDecoder().decode(data.payload).trim();
        if (!text) return;

        this.logger.debug({ text, from: nodeName, rssi }, 'Meshtastic text message');
        this.incoming$.next(text);

        const parsed = text
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .flatMap((line) => this.protocolParser.parseLine(line));
        if (parsed.length > 0) {
          this.logger.debug({ parsed }, 'Parsed protobuf text events');
          parsed.forEach((event) => this.parsed$.next(event));
          this.broadcastParsedEvents(parsed);
        } else {
          const rawEvent: SerialParseResult = { kind: 'raw', raw: text };
          this.parsed$.next(rawEvent);
          this.broadcastParsedEvents([rawEvent]);
        }
        break;
      }

      case Portnums.PortNum.POSITION_APP: {
        if (!data.payload?.length) return;
        try {
          const position = fromBinary(Mesh.PositionSchema, data.payload) as {
            latitudeI?: number;
            longitudeI?: number;
            altitude?: number;
            satsInView?: number;
            time?: number;
          };
          const lat = (position.latitudeI ?? 0) / 1e7;
          const lon = (position.longitudeI ?? 0) / 1e7;
          if (lat === 0 && lon === 0) return;
          if (fromNode && fromNode === this.localRadio.num) {
            this.updateLocalPosition(position.latitudeI, position.longitudeI, position.time);
            return;
          }

          const raw = `${nodeName} GPS:${lat.toFixed(6)},${lon.toFixed(6)}`;
          this.incoming$.next(raw);
          const event: SerialParseResult = {
            kind: 'node-telemetry',
            nodeId: nodeName,
            lat,
            lon,
            raw,
            lastMessage: raw,
          };
          this.parsed$.next(event);
          this.broadcastParsedEvents([event]);
        } catch {
          this.logger.debug(`Failed to decode position from ${nodeName}`);
        }
        break;
      }

      case Portnums.PortNum.NODEINFO_APP: {
        if (!data.payload?.length) return;
        try {
          const user = fromBinary(Mesh.UserSchema, data.payload) as {
            longName?: string;
            shortName?: string;
            id?: string;
          };
          if (user.longName && fromNode) {
            this.meshNodeNames.set(fromNode, user.longName);
            this.logger.debug(`Updated node name: 0x${fromNode.toString(16)} → ${user.longName}`);
          }
        } catch {
          this.logger.debug(`Failed to decode nodeinfo from 0x${fromNode.toString(16)}`);
        }
        break;
      }

      case Portnums.PortNum.TELEMETRY_APP: {
        if (!data.payload?.length || !TelemetryModule?.TelemetrySchema) return;
        try {
          const telemetry = fromBinary(
            TelemetryModule.TelemetrySchema as Parameters<typeof fromBinary>[0],
            data.payload,
          ) as {
            variant?: {
              case: string;
              value?: {
                temperature?: number;
                relativeHumidity?: number;
                barometricPressure?: number;
                batteryLevel?: number;
                voltage?: number;
                channelUtilization?: number;
                airUtilTx?: number;
                uptimeSeconds?: number;
              };
            };
          };

          const variant = telemetry.variant;
          if (!variant) return;

          if (variant.case === 'deviceMetrics' && variant.value) {
            const dm = variant.value;
            if (fromNode && fromNode === this.localRadio.num) {
              this.updateLocalBattery(dm.batteryLevel);
              return;
            }
            const raw = `${nodeName} battery:${dm.batteryLevel ?? '?'}% voltage:${dm.voltage?.toFixed(2) ?? '?'}V uptime:${dm.uptimeSeconds ?? 0}s`;
            this.incoming$.next(raw);
            const event: SerialParseResult = {
              kind: 'node-telemetry',
              nodeId: nodeName,
              raw,
              lastMessage: raw,
            };
            this.parsed$.next(event);
            this.broadcastParsedEvents([event]);
          }

          if (variant.case === 'environmentMetrics' && variant.value) {
            if (fromNode && fromNode === this.localRadio.num) return;
            const em = variant.value;
            const tempC = em.temperature;
            const raw = `${nodeName} temp:${tempC?.toFixed(1) ?? '?'}°C humidity:${em.relativeHumidity?.toFixed(0) ?? '?'}%`;
            this.incoming$.next(raw);
            const event: SerialParseResult = {
              kind: 'node-telemetry',
              nodeId: nodeName,
              raw,
              lastMessage: raw,
              temperatureC: tempC,
            };
            this.parsed$.next(event);
            this.broadcastParsedEvents([event]);
          }
        } catch {
          this.logger.debug(`Failed to decode telemetry from ${nodeName}`);
        }
        break;
      }

      case Portnums.PortNum.ADMIN_APP: {
        if (!data.payload?.length) return;
        await this.handleAdminReply(fromNode, data.requestId ?? 0, data.payload);
        break;
      }

      case Portnums.PortNum.ROUTING_APP: {
        await this.handleRoutingReply(
          fromNode,
          data.requestId ?? 0,
          data.payload ?? new Uint8Array(),
        );
        break;
      }

      default:
        break;
    }
  }

  private async handleAdminReply(
    fromNode: number,
    requestId: number,
    payload: Uint8Array,
  ): Promise<void> {
    const { Admin } = await loadMeshModule();
    let admin: { sessionPasskey?: Uint8Array; payloadVariant?: { case?: string; value?: unknown } };
    try {
      admin = fromBinary(Admin.AdminMessageSchema, payload) as never;
    } catch {
      return;
    }
    if (admin.sessionPasskey && admin.sessionPasskey.length > 0 && fromNode) {
      this.sessionPasskeys.set(fromNode, admin.sessionPasskey);
    }
    if (!requestId) return;
    const pending = this.fleetTx.get(requestId);
    if (!pending || (pending.expectedFrom !== 0 && pending.expectedFrom !== fromNode)) {
      return;
    }
    this.fleetTx.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(admin);
  }

  private async handleRoutingReply(
    fromNode: number,
    requestId: number,
    payload: Uint8Array,
  ): Promise<void> {
    if (!requestId) return;
    const { Mesh } = await loadMeshModule();
    let errorReason = 0;
    try {
      const routing = fromBinary(Mesh.RoutingSchema, payload) as {
        variant?: { case?: string; value?: number };
      };
      if (routing.variant?.case === 'errorReason') {
        errorReason = Number(routing.variant.value ?? 0);
      }
    } catch {
      errorReason = -1;
    }
    const pending = this.fleetTx.get(requestId);
    if (!pending || (pending.expectedFrom !== 0 && pending.expectedFrom !== fromNode)) {
      return;
    }
    const failed = errorReason !== 0;
    if (pending.expectsReply && !failed) {
      return;
    }
    this.fleetTx.delete(requestId);
    clearTimeout(pending.timer);
    if (failed) {
      if (errorReason === 32 && fromNode) {
        this.sessionPasskeys.delete(fromNode);
      }
      pending.reject(new Error(`radio admin failed: routing error ${errorReason}`));
    } else {
      pending.resolve(null);
    }
  }

  private async simulateLinesInternal(lines: string[]): Promise<void> {
    for (const rawLine of lines) {
      let line = rawLine;
      while (
        line.length > 0 &&
        (line[line.length - 1] === '\r' || line[line.length - 1] === '\n')
      ) {
        line = line.slice(0, -1);
      }
      line = line.trim();
      if (line) {
        this.processIncomingLine(line, 'simulation');
      }
      await delay(50);
    }
  }

  private shouldUseRpc(): boolean {
    return this.clusterRole === 'replica' && this.clusterMessagingEnabled;
  }

  private setupClusterMessaging(): void {
    if (!this.clusterMessagingEnabled || this.clusterMessageListener) {
      return;
    }
    const listener = (raw: unknown) => {
      if (!raw || typeof raw !== 'object') {
        return;
      }
      const envelope = raw as SerialClusterMessage;
      if (envelope.channel !== 'serial') {
        return;
      }
      this.handleClusterMessage(envelope);
    };

    process.on('message', listener as (message: unknown) => void);
    this.clusterMessageListener = listener as (message: unknown) => void;
    if (this.clusterRole === 'leader') {
      this.broadcastState();
    }
  }

  private teardownClusterMessaging(): void {
    if (this.clusterMessageListener) {
      const remover = (process.off ?? process.removeListener).bind(process);
      remover('message', this.clusterMessageListener);
      this.clusterMessageListener = undefined;
    }
    for (const [requestId, pending] of this.pendingRpc.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Serial service shutting down'));
      this.pendingRpc.delete(requestId);
    }
  }

  private async syncReplicaStateFromLeader(): Promise<void> {
    if (!this.shouldUseRpc()) {
      this.replicaState = { connected: false };
      return;
    }
    const state = (await this.requestRpc('getState')) as SerialState | undefined;
    this.updateReplicaState(state);
  }

  private updateReplicaState(state?: SerialState): void {
    if (!state) {
      return;
    }
    this.replicaState = { ...state };
    this.lastError = state.lastError;
  }

  private handleClusterMessage(message: SerialClusterMessage): void {
    switch (message.type) {
      case 'event':
        if (this.clusterRole !== 'replica' || !Array.isArray(message.events)) {
          return;
        }
        message.events.forEach((payload) => {
          const event = deserializeSerialParseResult(payload);
          this.parsed$.next(event);
        });
        break;
      case 'state':
        if (this.clusterRole !== 'replica' || !message.state) {
          return;
        }
        this.updateReplicaState(message.state);
        break;
      case 'rpc-response': {
        const requestId = message.requestId;
        if (!requestId) {
          return;
        }
        const pending = this.pendingRpc.get(requestId);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        this.pendingRpc.delete(requestId);
        if (message.success === false) {
          pending.reject(new Error(message.error ?? 'Serial RPC failed'));
        } else {
          pending.resolve(message.payload);
        }
        break;
      }
      case 'rpc-request':
        if (
          this.clusterRole !== 'leader' ||
          !message.requestId ||
          !message.action ||
          typeof message.sourceId !== 'number'
        ) {
          return;
        }
        void this.handleRpcRequest(
          message.requestId,
          message.action,
          message.payload,
          message.sourceId,
        );
        break;
      default:
        break;
    }
  }

  private async requestRpc<T = unknown>(action: SerialRpcAction, payload?: unknown): Promise<T> {
    if (!this.clusterMessagingEnabled || typeof process.send !== 'function') {
      throw new Error('Serial RPC is not available in this process');
    }
    const requestId = randomUUID();
    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRpc.delete(requestId);
        reject(new Error(`Serial RPC "${action}" timed out`));
      }, this.rpcTimeoutMs);
      const wrappedResolve = (value: unknown) => resolve(value as T);
      const wrappedReject = (reason?: unknown) => reject(reason);
      this.pendingRpc.set(requestId, {
        resolve: wrappedResolve,
        reject: wrappedReject,
        timeout,
      });
      const envelope: SerialClusterMessage = {
        channel: 'serial',
        type: 'rpc-request',
        requestId,
        action,
        payload,
      };
      try {
        process.send?.(envelope);
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRpc.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async handleRpcRequest(
    requestId: string,
    action: SerialRpcAction,
    payload: unknown,
    sourceId: number,
  ): Promise<void> {
    try {
      let result: unknown;
      switch (action) {
        case 'connect':
          await this.serializeLifecycle(() =>
            this.connectInternal(payload as Partial<SerialConnectionOptions>),
          );
          this.broadcastState();
          result = this.buildState();
          break;
        case 'disconnect':
          await this.serializeLifecycle(() => this.performDisconnect());
          this.broadcastState();
          result = this.buildState();
          break;
        case 'listPorts':
          result = await getAvailablePorts();
          break;
        case 'simulate':
          await this.simulateLinesInternal((payload as string[]) ?? []);
          result = true;
          break;
        case 'getState':
          result = this.buildState();
          break;
        case 'queueCommand':
          await this.queueCommandInternal(payload as QueueCommandRequest);
          result = true;
          break;
        case 'radioInfo':
          result = this.buildRadioInfo();
          break;
        case 'radioAction':
          await this.radioActionInternal(payload as RadioAction);
          result = true;
          break;
        default:
          throw new Error(`Unsupported serial RPC action: ${action}`);
      }
      this.sendRpcResponse(requestId, sourceId, true, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.sendRpcResponse(requestId, sourceId, false, undefined, message);
    }
  }

  private sendRpcResponse(
    requestId: string,
    targetId: number,
    success: boolean,
    payload?: unknown,
    error?: string,
  ): void {
    if (!this.clusterMessagingEnabled || typeof process.send !== 'function') {
      return;
    }
    const envelope: SerialClusterMessage = {
      channel: 'serial',
      type: 'rpc-response',
      requestId,
      success,
      payload,
      error,
      targetId,
    };
    try {
      process.send?.(envelope);
    } catch (err) {
      this.logger.warn(
        `Failed to send serial RPC response: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private broadcastParsedEvents(events: SerialParseResult[]): void {
    if (
      !events.length ||
      this.clusterRole !== 'leader' ||
      !this.clusterMessagingEnabled ||
      typeof process.send !== 'function'
    ) {
      return;
    }
    const envelope: SerialClusterMessage = {
      channel: 'serial',
      type: 'event',
      events: events.map((event) => serializeSerialParseResult(event)),
    };
    try {
      process.send?.(envelope);
    } catch (error) {
      this.logger.debug(
        `Failed to broadcast serial events: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private broadcastState(): void {
    if (
      this.clusterRole !== 'leader' ||
      !this.clusterMessagingEnabled ||
      typeof process.send !== 'function'
    ) {
      return;
    }
    const envelope: SerialClusterMessage = {
      channel: 'serial',
      type: 'state',
      state: this.buildState(),
    };
    try {
      process.send?.(envelope);
    } catch (error) {
      this.logger.debug(
        `Failed to broadcast serial state: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private extractDedupeKey(content: string): string | null {
    // Extract a stable key from the message that ignores variable fields (RSSI, GPS, HDOP, temps, etc.)
    // This catches duplicates from Meshtastic 2.6 double-sends (SerialConsole + Router rebroadcast)

    // Extract node ID (first token before colon)
    const nodeMatch = /^([A-Za-z0-9_.:-]+):/.exec(content);
    const nodeId = nodeMatch ? nodeMatch[1] : '';

    // Extract message type (STATUS, TARGET, ATTACK, etc.)
    const typeMatch = /:\s*([A-Z_]+)[:|\s]/.exec(content);
    const msgType = typeMatch ? typeMatch[1] : '';

    if (!nodeId || !msgType) {
      return null;
    }

    // Extract stable fields based on message type
    switch (msgType) {
      case 'STATUS': {
        const mode = /Mode:([^\s]+)/.exec(content)?.[1] || '';
        const scan = /Scan:([^\s]+)/.exec(content)?.[1] || '';
        const hits = /Hits:(\d+)/.exec(content)?.[1] || '';
        const unique = /Unique:(\d+)/.exec(content)?.[1] || '';
        return `${nodeId}:STATUS:${mode}:${scan}:${hits}:${unique}`;
      }

      case 'TARGET': {
        const mac =
          /(?:Target:\s*)?(?:[A-Z]+\s+)?((?:[0-9A-F]{2}:){5}[0-9A-F]{2})/i.exec(content)?.[1] || '';
        const type = /Type:([^\s]+)/i.exec(content)?.[1] || '';
        return `${nodeId}:TARGET:${mac.toUpperCase()}:${type}`;
      }

      case 'TARGET_DATA':
      case 'T_D': {
        const mac = /((?:[0-9A-F]{2}:){5}[0-9A-F]{2})/i.exec(content)?.[1] || '';
        const type = /Type:([^\s]+)/i.exec(content)?.[1] || '';
        return `${nodeId}:TARGET_DATA:${mac.toUpperCase()}:${type}`;
      }

      case 'DEVICE': {
        const mac = /((?:[0-9A-F]{2}:){5}[0-9A-F]{2})/i.exec(content)?.[1] || '';
        const band = /\s([WB])\s/.exec(content)?.[1] || '';
        return `${nodeId}:DEVICE:${mac.toUpperCase()}:${band}`;
      }

      case 'DRONE': {
        const mac = /((?:[0-9A-F]{2}:){5}[0-9A-F]{2})/i.exec(content)?.[1] || '';
        const droneId = /ID:([^\s]+)/.exec(content)?.[1] || '';
        return `${nodeId}:DRONE:${mac.toUpperCase()}:${droneId}`;
      }

      case 'ATTACK': {
        const kind = /ATTACK:\s*(DEAUTH|DISASSOC)/i.exec(content)?.[1] || '';
        const src =
          /SRC:((?:[0-9A-F]{2}:){5}[0-9A-F]{2})/i.exec(content)?.[1] ||
          /([0-9A-F]{2}:[0-9A-F]{2}:[0-9A-F]{2}:[0-9A-F]{2}:[0-9A-F]{2}:[0-9A-F]{2})->/i.exec(
            content,
          )?.[1] ||
          '';
        const dst =
          /DST:((?:[0-9A-F]{2}:){5}[0-9A-F]{2})/i.exec(content)?.[1] ||
          /->((?:[0-9A-F]{2}:){5}[0-9A-F]{2})/i.exec(content)?.[1] ||
          '';
        const chan = /C(?:H:|hannel:)?(\d+)/i.exec(content)?.[1] || '';
        return `${nodeId}:ATTACK:${kind}:${src.toUpperCase()}:${dst.toUpperCase()}:${chan}`;
      }

      case 'ANOMALY': {
        const kind = /ANOMALY-([A-Z]+)/i.exec(content)?.[1] || '';
        const type = /ANOMALY-[A-Z]+:\s*([^\s]+)/i.exec(content)?.[1] || '';
        const mac = /((?:[0-9A-F]{2}:){5}[0-9A-F]{2})/i.exec(content)?.[1] || '';
        return `${nodeId}:ANOMALY:${kind}:${type}:${mac.toUpperCase()}`;
      }

      case 'PROBE_HIT': {
        const mac = /((?:[0-9A-F]{2}:){5}[0-9A-F]{2})/i.exec(content)?.[1] || '';
        const ssid = /SSID[=:"]*([^"\s]+)/i.exec(content)?.[1] || '';
        return `${nodeId}:PROBE_HIT:${mac.toUpperCase()}:${ssid}`;
      }

      case 'IDENTITY': {
        const tag = /IDENTITY:([^\s]+)/.exec(content)?.[1] || '';
        const band = /\s([WB])\s/.exec(content)?.[1] || '';
        const anchor = /Anchor:((?:[0-9A-F]{2}:){5}[0-9A-F]{2})/i.exec(content)?.[1] || '';
        return `${nodeId}:IDENTITY:${tag}:${band}:${anchor.toUpperCase()}`;
      }

      case 'GPS': {
        // GPS messages are tricky - coords can drift slightly. Use rough location.
        const latMatch = /Location[:=]([-\d.]+)/i.exec(content);
        const lat = latMatch ? Math.round(Number(latMatch[1]) * 1000) : '';
        const lonMatch = /,([-\d.]+)/i.exec(content);
        const lon = lonMatch ? Math.round(Number(lonMatch[1]) * 1000) : '';
        return `${nodeId}:GPS:${lat}:${lon}`;
      }

      case 'TRIANGULATE_COMPLETE':
      case 'T_C':
      case 'TRIANGULATION_FINAL':
      case 'T_F': {
        const mac = /((?:[0-9A-F]{2}:){5}[0-9A-F]{2})/i.exec(content)?.[1] || '';
        return `${nodeId}:${msgType}:${mac.toUpperCase()}`;
      }

      default: {
        // For unknown types, normalize by removing variable fields
        const normalized = content
          .replace(/RSSI[:=]?-?\d+/gi, '')
          .replace(/HDOP[:=][\d.]+/gi, '')
          .replace(/Temp:[\d.]+[CF]/gi, '')
          .replace(/Up:[\d:]+/gi, '')
          .replace(/GPS[:=][-\d.,]+/gi, '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 60);
        return `${nodeId}:${msgType}:${normalized}`;
      }
    }
  }

  private processIncomingLine(line: string, source: 'serial' | 'simulation'): void {
    const sanitized = sanitizeLine(line);
    if (!sanitized) {
      this.logger.warn(`[SANITIZE_EMPTY] input=${line.slice(0, 200)}`);
      return;
    }
    if (sanitized !== line.trim()) {
      this.logger.log(`[SANITIZE] "${line.slice(0, 100)}" => "${sanitized.slice(0, 100)}"`);
    }
    // Some devices bundle multiple payloads in one line separated by CR/LF.
    const parts = sanitized
      .split(/\r?\n/)
      .map((p) => p.trim())
      .filter(Boolean);

    const now = Date.now();

    // Clean up expired entries from the message cache periodically
    if (this.recentMessageCache.size > 0) {
      for (const [key, entry] of this.recentMessageCache.entries()) {
        if (now - entry.timestamp > this.MESSAGE_CACHE_TTL_MS) {
          this.recentMessageCache.delete(key);
        }
      }
    }

    for (const part of parts) {
      this.logger.debug(
        { line: part },
        source === 'serial' ? 'Serial line received' : 'Simulated serial line',
      );

      // Extract the core message content for deduplication
      const msgIndex = part.lastIndexOf('msg=');
      const coreContent = msgIndex >= 0 ? part.slice(msgIndex + 4).trim() : part;

      // Universal deduplication: check if we've seen this message recently
      // This catches Meshtastic 2.6 duplicates (SerialConsole + Router rebroadcast)
      const dedupeKey = this.extractDedupeKey(coreContent);

      if (dedupeKey) {
        const cached = this.recentMessageCache.get(dedupeKey);
        if (cached !== undefined) {
          const timeDiff = now - cached.timestamp;
          this.logger.debug(
            { line: part, dedupeKey, timeDiff },
            'Skipping duplicate message (Meshtastic 2.6 compat)',
          );
          continue;
        }
      }

      this.incoming$.next(part);
      try {
        const parsed = this.protocolParser.parseLine(part);
        if (!parsed.length) {
          this.logger.warn(`[PARSE_MISS] no match: "${part.slice(0, 150)}"`);
          this.incoming$.next(part);
          this.parsed$.next({ kind: 'raw', raw: part });
          continue;
        }

        // Store this message in the cache to prevent duplicates
        if (dedupeKey) {
          this.recentMessageCache.set(dedupeKey, {
            timestamp: now,
            content: coreContent,
            rawLine: part,
          });
        }

        // Log STATUS messages with full details for debugging
        if (coreContent.includes('STATUS:')) {
          this.logger.log(
            {
              rawLine: part,
              coreContent,
              hasHdop: /HDOP[:=]/.test(coreContent),
              parsed: parsed.map((p) => ({ kind: p.kind, data: 'data' in p ? p.data : null })),
            },
            'STATUS message parsed',
          );
        }

        this.logger.debug({ parsed }, 'Parsed serial events');
        parsed.forEach((event) => this.parsed$.next(event));
        this.broadcastParsedEvents(parsed);
      } catch (err) {
        this.logger.error(`Failed to parse ${source} line: ${part}`, err as Error);
        this.parsed$.next({ kind: 'raw', raw: part });
      }
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeLine(value: string): string {
  let cleaned = stripAnsi(value);
  // eslint-disable-next-line no-control-regex
  cleaned = cleaned.replace(/[\uFEFF\uFFFD\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  cleaned = cleaned.replace(/\/?undefinedf\b/gi, '');
  cleaned = cleaned.trim();
  if (!cleaned) return '';

  // Meshtastic 2.6+/2.7 text forwarding: extract payload after msg=
  const msgIdx = cleaned.lastIndexOf('msg=');
  if (msgIdx >= 0) {
    cleaned = cleaned.slice(msgIdx + 4).trim();
  }

  // Strip Meshtastic log prefixes: DEBUG|INFO|WARN|ERROR | ...
  if (/^\s*(DEBUG|INFO|WARN|ERROR)\s*\|/i.test(cleaned)) {
    return '';
  }

  // Strip firmware debug console bracket prefixes: [MESH TX], [VIBRATION], etc.
  const bracketMatch = /^\[([A-Z][A-Z0-9_ -]*)\]\s+(.+)$/i.exec(cleaned);
  if (bracketMatch) {
    cleaned = bracketMatch[2].trim();
  }

  // Strip Meshtastic TEXTMSG channel prefix: "0:" or "1 :" (channel 0-7)
  const chanMatch = /^\s*(\d)\s*:\s*([\s\S]+)$/.exec(cleaned);
  if (chanMatch && chanMatch[1].length === 1 && Number(chanMatch[1]) <= 7) {
    cleaned = chanMatch[2].trim();
  }

  // Strip Meshtastic hop/relay prefix: when a node relays a text message, the
  // relaying node's short name is prepended (e.g. "ah03: AH5: STATUS:..." or
  // "RLAY: AH5: TAMPER_DETECTED:..."). The original format is "nodeId: KEYWORD"
  // and the hop adds "relayName: " in front. We detect by checking if the second
  // token is a plain node ID (not a keyword) and the third token IS a keyword.
  const HOP_KEYWORD_RE =
    /^(?:STATUS|Target|DEVICE|DRONE|ATTACK|ANOMALY|VIBRATION|VIBRATION_STATUS|VIBRATION_ON_ACK|VIBRATION_OFF_ACK|SETUP_MODE|SETUP_COMPLETE|TAMPER_DETECTED|TAMPER_CANCELLED|ERASE_|AUTOERASE_|BASELINE_STATUS|BASELINE_ACK|BATTERY_SAVER_STATUS|BATTERY_SAVER_START_ACK|BATTERY_SAVER_STOP_ACK|HEARTBEAT|STARTUP|GPS|TRIANGULATE|TARGET_DATA|T_D:|T_C:|T_F:|IDENTITY|RANDOMIZATION|RANDOMIZATION_DONE|SCAN_DONE|DEAUTH_DONE|DRONE_DONE|BASELINE_DONE|LIST_SCAN_DONE|PROBE_DONE|PROBE_HIT|PROBE_ACK|PCAP_|SCAN_ACK|DEVICE_SCAN_ACK|DRONE_ACK|DEAUTH_ACK|CONFIG_ACK|STOP_ACK|REBOOT_ACK|HB_ACK|TRI_START|WIPE_TOKEN|ERASE_TOKEN|RTC_SYNC|TIME_SYNC|CODES:|EVILTWIN|OWE_ABUSE|PMKID_|EAPOL_BAIT|HSHK|KARMA_|PWNAGOTCHI|PROBE_FLOOD|SAE_DOS|DEAUTH_FLOOD|DEAUTH_FORGE|DEAUTH_AP_TARGETED|BEACON_|ASSOC_SLEEP|AUTH_FLOOD|SSID_CONFUSION|FRAG|ATTACKER_HUNT|RECON|JAMMING|SENTINEL|GROUP_ACK|DETECT_CFG|INCIDENTS|DEDUP_CLEAR_ACK|FACTORY_RESET|MESH_SPOOF_SELF|MESH_FLOOD|MESH_CMD_INJECT|DEVICE_DISAPPEARED|RID_|TOF_|BLOOM|IDHASH|CHAN_ASSIGN|CSI_|SUMMARY|CAMPAIGN_|SCHED_|CALIBRATE_|SELF_RADIO_|RADIO_KNOWN_|RADIO_DETECTED|CSA_SPOOF|QUIET_ABUSE|FLEET_|VIBSCAN_|ATTACKER_TRILAT|MESH_TX_CANCEL|DEVICE_DB_CLEAR|PROBE_DB_CLEAR|BASELINE_RESET|BASELINE_WATCH|RANDOMIZATION_RESET|DETECT_CLEAR|DETECT_COUNTS|SD_REPAIR|BATTERY_SAVER|DETECT_|QUORUM_|HUNT_COOLDOWN|TRI_ACK|Time:)/i;
  const hopMatch = /^([A-Za-z0-9_-]{1,6}):\s+([A-Za-z0-9_.:-]+:\s+)(.+)$/i.exec(cleaned);
  if (hopMatch) {
    const secondToken = hopMatch[2].replace(/[:\s]+$/, '');
    const thirdPart = hopMatch[3].trim();
    const secondIsKeyword = HOP_KEYWORD_RE.test(secondToken);
    const thirdIsKeyword = HOP_KEYWORD_RE.test(thirdPart);
    if (!secondIsKeyword && thirdIsKeyword) {
      cleaned = (hopMatch[2] + hopMatch[3]).trim();
    }
  }

  // Strip leading ANSI fragment residue like "0m"
  cleaned = cleaned.replace(/^0m\s*/i, '');

  return cleaned;
}

function stripAnsi(value: string): string {
  // Remove ANSI escape sequences (color codes, etc.).
  let result = '';
  let i = 0;
  while (i < value.length) {
    if (value[i] === '\u001b' && value[i + 1] === '[') {
      // Skip until we hit a letter (ANSI terminator)
      i += 2;
      while (i < value.length && !/[A-Za-z]/.test(value[i])) {
        i += 1;
      }
      i += 1; // consume the terminator
    } else {
      result += value[i];
      i += 1;
    }
  }
  return result;
}
