import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
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
import { buildCommandPayload } from '../commands/command-builder';

const Binding = resolveBinding();
const dynamicImport = new Function('specifier', 'return import(specifier);') as <TModule>(
  specifier: string,
) => Promise<TModule>;

type MeshProtoModule = typeof import('@meshtastic/protobufs');
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
  private manualDisconnect = false;
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
  private frameParser?: MeshtasticFrameParser;
  private readonly meshNodeNames = new Map<number, string>();
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

    await this.autoConnect().catch((error) => {
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
      protocol: (this.configService.get<string>('serial.protocol', 'meshtastic-rewrite') ??
        'meshtastic-rewrite') as ProtocolKey,
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
    await this.connectInternal(options);
    this.broadcastState();
  }

  async disconnect(): Promise<void> {
    if (this.shouldUseRpc()) {
      const state = (await this.requestRpc('disconnect')) as SerialState | undefined;
      this.updateReplicaState(state);
      return;
    }
    await this.performDisconnect();
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
        });
        this.connectionOptions = {
          path: candidatePath,
          baudRate,
          delimiter,
          protocol,
          writeDelimiters,
          autoDetectDelimiter: autoDetect,
          rawDelimiter: delimiterToken,
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

    this.logger.debug(`Queueing command line: ${line}`);

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
      const protocol = this.connectionOptions?.protocol ?? 'meshtastic-rewrite';
      const sendMode =
        this.configService.get<string>('serial.sendMode')?.toLowerCase() ?? 'protobuf';
      const hopLimit = this.configService.get<number>('serial.hopLimit');

      if (protocol === 'meshtastic-rewrite') {
        if (sendMode === 'plain') {
          await this.writeLine(line);
          return;
        }

        const wantAck = sendMode === 'protobuf-ack';
        await this.sendMeshtasticCommand(line, {
          wantAck,
          hopLimit: Number.isFinite(hopLimit) ? (hopLimit as number) : undefined,
        });
      } else {
        await this.writeLine(line);
      }
    }, isStopCommand);
  }

  private cleanup(): void {
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
      this.autoConnect().catch((error) => this.handleAutoConnectFailure(error));
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
    },
  ): Promise<void> {
    this.logger.log(
      `Opening serial port ${path} @ ${options.baudRate} using protocol ${options.protocol}`,
    );

    try {
      this.port = new SerialPortStream({
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
      if (!this.port) {
        reject(new Error('Serial port not initialised'));
        return;
      }

      if (this.port.isOpen) {
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
        this.port?.off('open', handleOpen);
        this.port?.off('error', handleError);
      };

      this.port.once('open', handleOpen);
      this.port.once('error', handleError);
    });

    this.protocolParser = createParser(options.protocol);
    this.protocolParser.reset();

    if (options.protocol === 'meshtastic-rewrite') {
      this.frameParser = new MeshtasticFrameParser();
      this.port.pipe(this.frameParser);

      this.frameParser.on('data', (event: MeshtasticFrameEvent) => {
        if (event.type === 'frame') {
          this.logger.log(`[FRAME] protobuf ${(event.data as Buffer).length}B`);
          void this.handleMeshtasticFrame(event.data);
        } else if (event.type === 'text') {
          const line = (event.data as string).trim();
          if (!line) return;
          this.logger.log(`[TEXT] ${line.slice(0, 200)}`);
          this.processIncomingLine(line, 'serial');
        }
      });

      this.frameParser.on('error', (err: Error) => {
        this.logger.error(`Frame parser error: ${err.message}`, err.stack);
      });

      void this.initMeshtasticApi().catch((err) => {
        this.logger.warn(`Meshtastic API init: ${err instanceof Error ? err.message : err}`);
      });
    } else {
      const readDelimiter = options.autoDetectDelimiter ? '\n' : options.delimiter;
      this.lineParser = this.port.pipe(
        new ReadlineParser({
          delimiter: readDelimiter,
        }),
      );

      this.lineParser.on('data', (data: string | Buffer) => {
        const line = data
          .toString()
          .replace(/[\r\n]+$/, '')
          .trim();
        if (!line) {
          return;
        }
        this.processIncomingLine(line, 'serial');
      });

      this.lineParser.on('error', (err) => {
        this.logger.error(`Serial parser error: ${err.message}`, err.stack);
      });
    }

    this.port.on('error', (err) => {
      this.lastError = err.message;
      this.logger.error(`Serial port error: ${err.message}`, err.stack);
    });

    this.port.on('close', () => {
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

        case 'nodeInfo': {
          const info = variant.value as {
            num?: number;
            user?: { longName?: string; shortName?: string };
            position?: { latitudeI?: number; longitudeI?: number };
          };
          if (info.num && info.user?.longName) {
            this.meshNodeNames.set(info.num, info.user.longName);
            const hex = info.num.toString(16);
            this.logger.debug(`Node mapping: 0x${hex} → ${info.user.longName}`);
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
        };
      };
    },
    Mesh: Awaited<ReturnType<typeof loadMeshModule>>['Mesh'],
    Portnums: Awaited<ReturnType<typeof loadMeshModule>>['Portnums'],
    TelemetryModule?: { TelemetrySchema?: unknown; DeviceMetricsSchema?: unknown },
  ): Promise<void> {
    const decoded = packet.payloadVariant;
    if (!decoded || decoded.case !== 'decoded' || !decoded.value) return;

    const data = decoded.value;
    const fromNode = packet.from ?? 0;
    const nodeName = this.meshNodeNames.get(fromNode) ?? `!${fromNode.toString(16)}`;
    const rssi = packet.rxRssi;

    switch (data.portnum) {
      case Portnums.PortNum.TEXT_MESSAGE_APP: {
        if (!data.payload?.length) return;
        const text = new TextDecoder().decode(data.payload).trim();
        if (!text) return;

        this.logger.debug({ text, from: nodeName, rssi }, 'Meshtastic text message');
        this.incoming$.next(text);

        const parsed = this.protocolParser.parseLine(text);
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

      default:
        break;
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
          await this.connectInternal(payload as Partial<SerialConnectionOptions>);
          this.broadcastState();
          result = this.buildState();
          break;
        case 'disconnect':
          await this.performDisconnect();
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
  const chanMatch = /^\s*(\d)\s*:\s*(.+)$/.exec(cleaned);
  if (chanMatch && chanMatch[1].length === 1 && Number(chanMatch[1]) <= 7) {
    cleaned = chanMatch[2].trim();
  }

  // Strip Meshtastic hop/relay prefix: when a node relays a text message, the
  // relaying node's short name is prepended (e.g. "ah03: AH5: STATUS:..." or
  // "RLAY: AH5: TAMPER_DETECTED:..."). The original format is "nodeId: KEYWORD"
  // and the hop adds "relayName: " in front. We detect by checking if the second
  // token is a plain node ID (not a keyword) and the third token IS a keyword.
  const HOP_KEYWORD_RE =
    /^(?:STATUS|Target|DEVICE|DRONE|ATTACK|ANOMALY|VIBRATION|VIBRATION_STATUS|VIBRATION_ON_ACK|VIBRATION_OFF_ACK|SETUP_MODE|SETUP_COMPLETE|TAMPER_DETECTED|TAMPER_CANCELLED|ERASE_|AUTOERASE_|BASELINE_STATUS|BASELINE_ACK|BATTERY_SAVER_STATUS|BATTERY_SAVER_START_ACK|BATTERY_SAVER_STOP_ACK|HEARTBEAT|STARTUP|GPS|TRIANGULATE|TARGET_DATA|T_D:|T_C:|T_F:|IDENTITY|RANDOMIZATION|RANDOMIZATION_DONE|SCAN_DONE|DEAUTH_DONE|DRONE_DONE|BASELINE_DONE|LIST_SCAN_DONE|PROBE_DONE|PROBE_HIT|PROBE_ACK|SCAN_ACK|DEVICE_SCAN_ACK|DRONE_ACK|DEAUTH_ACK|CONFIG_ACK|STOP_ACK|REBOOT_ACK|HB_ACK|TRI_START|WIPE_TOKEN|ERASE_TOKEN|RTC_SYNC|TIME_SYNC|CODES:|EVILTWIN|OWE_ABUSE|PMKID_|EAPOL_BAIT|HSHK|KARMA_|PWNAGOTCHI|PROBE_FLOOD|SAE_DOS|DEAUTH_FLOOD|DEAUTH_FORGE|DEAUTH_AP_TARGETED|BEACON_|ASSOC_SLEEP|AUTH_FLOOD|SSID_CONFUSION|FRAG|ATTACKER_HUNT|RECON|JAMMING|SENTINEL|GROUP_ACK|DETECT_CFG|INCIDENTS|DEDUP_CLEAR_ACK|FACTORY_RESET|MESH_SPOOF_SELF|MESH_FLOOD|MESH_CMD_INJECT|DEVICE_DISAPPEARED|RID_|TOF_|BLOOM|IDHASH|CHAN_ASSIGN|Time:)/i;
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
