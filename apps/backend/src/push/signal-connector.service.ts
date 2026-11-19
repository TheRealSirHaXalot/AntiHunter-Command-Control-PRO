import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { RemoteAlertConfig } from '@prisma/client';
import { ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { chmod, mkdir, rm, stat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { PushService } from './push.service';
import { RemoteAlertConfigService } from './remote-alert-config.service';

const RECEIVE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const RECEIVE_SCHEDULE = '0 */6 * * *';

const VERSION = '0.14.8';
const ASSET = `signal-cli-${VERSION}-Linux-native.tar.gz`;
const DOWNLOAD_URL = `https://github.com/AsamK/signal-cli/releases/download/v${VERSION}/${ASSET}`;
const SHA256 = '36569af20c709e0c5e6e677b74f50f147b21f3740620b8a7affde70f6027f82a';
const SIZE = 113821552;
const LATEST_URL = 'https://api.github.com/repos/AsamK/signal-cli/releases/latest';
const SIGNAL_CONTAINER = 'cc_signal';
const SIGNAL_API_CONTAINER = 'cc_signal_api';
const SIGNAL_PROXY_CONTAINER = 'cc_signal_proxy';
const SIGNAL_NET = 'ahcc-signal';
const SIGNAL_NET_INTERNAL = 'ahcc-signal-internal';
const SIGNAL_IMAGE =
  'bbernhard/signal-cli-rest-api:0.100@sha256:2399d449123cdad56c4d859277e3b9127e1a00c4d2ab4601c239882609286cf8';
const PROXY_IMAGE = 'node:24.22.3-bookworm-slim';

function findProxyScript(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, 'docker', 'signal-proxy', 'proxy.mjs');
    if (existsSync(candidate)) {
      return /^[\w./ -]+$/.test(candidate) ? candidate : null;
    }
    dir = dirname(dir);
  }
  return null;
}

@Injectable()
export class SignalConnectorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SignalConnectorService.name);
  private readonly home =
    process.env.AHCC_SIGNAL_HOME?.trim() || join(process.cwd(), '.signal-cli');
  private readonly binPath = join(this.home, `signal-cli-${VERSION}`, 'signal-cli');
  private readonly configDir = join(this.home, 'account');
  private acquisition: Promise<void> | null = null;
  private linkChild: ChildProcess | null = null;
  private lastLinkUri: string | null = null;

  private receiveTimer: NodeJS.Timeout | null = null;
  private readonly gate = process.env.AHCC_SIGNAL_GATE?.trim() || null;
  private gateLinking = false;

  constructor(
    private readonly config: RemoteAlertConfigService,
    private readonly push: PushService,
  ) {}

  onModuleInit(): void {
    this.receiveTimer = setInterval(() => void this.receivePending(), RECEIVE_INTERVAL_MS);
    this.receiveTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.receiveTimer) {
      clearInterval(this.receiveTimer);
    }
    this.linkChild?.kill('SIGTERM');
  }

  private async receivePending(): Promise<void> {
    const config = await this.config.get();
    if (!config.signalEnabled || !this.usesNativeCli(config) || !(await this.binaryReady())) {
      return;
    }
    try {
      if (this.gate) {
        if (!(await this.linkedNumber())) {
          throw new Error('the ahcc-signal service reports no linked account');
        }
      } else {
        await this.run(['receive', '-t', '5', '--ignore-attachments', '--ignore-stories'], 120_000);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Signal receive failed: ${reason}`);
      await this.push
        .notify('Signal alerts may be broken', `signal-cli receive failed: ${reason.slice(0, 300)}`)
        .catch(() => undefined);
    }
  }

  usesNative(config: RemoteAlertConfig): boolean {
    return !config.signalApiUrl?.trim();
  }

  isSupported(): boolean {
    return Boolean(this.gate) || (process.platform === 'linux' && process.arch === 'x64');
  }

  usesNativeCli(config: RemoteAlertConfig): boolean {
    return this.usesNative(config) && this.isSupported();
  }

  async binaryReady(): Promise<boolean> {
    try {
      await stat(this.gate ?? this.binPath);
      return true;
    } catch {
      return false;
    }
  }

  async checkUpdate(): Promise<{
    current: string;
    latest: string | null;
    updateAvailable: boolean;
  }> {
    try {
      const response = await fetch(LATEST_URL, {
        headers: { Accept: 'application/vnd.github+json' },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        return { current: VERSION, latest: null, updateAvailable: false };
      }
      const body = (await response.json()) as { tag_name?: unknown };
      const latest = typeof body.tag_name === 'string' ? body.tag_name.replace(/^v/, '') : null;
      return { current: VERSION, latest, updateAvailable: Boolean(latest && latest !== VERSION) };
    } catch {
      return { current: VERSION, latest: null, updateAvailable: false };
    }
  }

  private which(cmd: string): Promise<boolean> {
    const win = process.platform === 'win32';
    const shell = win ? 'cmd' : '/bin/sh';
    const args = win ? ['/c', `where ${cmd}`] : ['-c', `command -v ${cmd}`];
    return new Promise((resolve) => {
      const child = spawn(shell, args, { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
    });
  }

  async setupHint(): Promise<{
    platform: string;
    arch: string;
    supported: boolean;
    steps: Array<{ text: string; cmd?: string; url?: string }>;
    controls: { start: string; stop: string; restart: string } | null;
  }> {
    const platform = process.platform;
    const arch = process.arch;
    const supported = this.isSupported();
    if (supported) {
      return {
        platform,
        arch,
        supported,
        steps: [
          {
            text: this.gate
              ? 'signal-cli runs as the isolated ahcc-signal service. Click Link Signal.'
              : 'AHCC installs and runs signal-cli itself. Click Link Signal.',
          },
        ],
        controls: null,
      };
    }
    const [dockerFound, colimaFound] = await Promise.all([
      this.which('docker'),
      this.which('colima'),
    ]);
    const steps: Array<{ text: string; cmd?: string; url?: string }> = [];
    if (!dockerFound) {
      if (platform === 'win32') {
        steps.push({
          text: 'Install Docker Desktop, then enable virtualization (WSL2 or Hyper-V). Note: a Windows VM on an Apple Silicon Mac cannot run Docker — use a physical PC or the Docker connector on another host.',
          url: 'https://www.docker.com/products/docker-desktop/',
          cmd: 'winget install -e --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements',
        });
      } else {
        steps.push({ text: 'Install Docker', url: 'https://docs.docker.com/get-docker/' });
      }
    } else if (colimaFound) {
      steps.push({ text: 'Start the Docker VM', cmd: 'colima start' });
    }
    const proxyScript = findProxyScript();
    if (!proxyScript) {
      steps.push({
        text: 'docker/signal-proxy/proxy.mjs was not found above the backend directory. Run AHCC from the repository checkout.',
      });
      return { platform, arch, supported, steps, controls: null };
    }
    const legacy = `docker port ${SIGNAL_CONTAINER} 8080 2>/dev/null | grep -q ':8079' && docker rm -f ${SIGNAL_CONTAINER}`;
    const networks = `(docker network inspect ${SIGNAL_NET_INTERNAL} >/dev/null 2>&1 || docker network create ${SIGNAL_NET_INTERNAL}) && (docker network inspect ${SIGNAL_NET} >/dev/null 2>&1 || docker network create ${SIGNAL_NET})`;
    const createApi = `docker run -d --name ${SIGNAL_API_CONTAINER} --restart unless-stopped --network ${SIGNAL_NET_INTERNAL} --network-alias signal-api -e MODE=native -e 'AUTO_RECEIVE_SCHEDULE=${RECEIVE_SCHEDULE}' -v ${SIGNAL_CONTAINER}:/home/.local/share/signal-cli ${SIGNAL_IMAGE}`;
    const createProxy = `docker run -d --name ${SIGNAL_PROXY_CONTAINER} --restart unless-stopped --network ${SIGNAL_NET} -p 127.0.0.1:8079:8080 -e SIGNAL_UPSTREAM=http://signal-api:8080 -e SIGNAL_PROXY_TOKEN=${this.config.signalProxyToken()} -v '${proxyScript}:/app/proxy.mjs:ro' ${PROXY_IMAGE} node /app/proxy.mjs && docker network connect ${SIGNAL_NET_INTERNAL} ${SIGNAL_PROXY_CONTAINER}`;
    const startCmd = `{ ${legacy}; true; } && ${networks} && (docker start ${SIGNAL_API_CONTAINER} 2>/dev/null || (docker rm -f ${SIGNAL_API_CONTAINER} >/dev/null 2>&1; ${createApi})) && { docker rm -f ${SIGNAL_PROXY_CONTAINER} >/dev/null 2>&1; true; } && ${createProxy}`;
    steps.push({
      text: 'Start the Signal connector on loopback (creates it the first time, starts it after)',
      cmd: startCmd,
    });
    steps.push({
      text: 'That is all — AHCC detects it on 127.0.0.1:8079 and shows Link Signal automatically.',
    });
    return {
      platform,
      arch,
      supported,
      steps,
      controls: {
        start: startCmd,
        stop: `docker stop ${SIGNAL_PROXY_CONTAINER} ${SIGNAL_API_CONTAINER}`,
        restart: `docker restart ${SIGNAL_API_CONTAINER} ${SIGNAL_PROXY_CONTAINER}`,
      },
    };
  }

  private async ensureReady(): Promise<void> {
    if (await this.binaryReady()) {
      return;
    }
    if (this.gate) {
      throw new BadRequestException(
        `AHCC_SIGNAL_GATE ${this.gate} not found. Run scripts/signal/install-signal-host.sh.`,
      );
    }
    if (!this.isSupported()) {
      throw new BadRequestException(
        `AHCC can only auto-run signal-cli on x86_64 Linux (this host is ${process.platform}/${process.arch}). Use the Docker signal profile instead.`,
      );
    }
    this.acquisition ??= this.acquire().finally(() => {
      this.acquisition = null;
    });
    return this.acquisition;
  }

  private async acquire(): Promise<void> {
    await mkdir(join(this.home, `signal-cli-${VERSION}`), { recursive: true, mode: 0o700 });
    const tmp = join(this.home, `download-${process.pid}.tar.gz`);
    this.logger.log(`Downloading signal-cli ${VERSION} (${SIZE} bytes)`);
    const response = await fetch(DOWNLOAD_URL, {
      redirect: 'follow',
      signal: AbortSignal.timeout(300_000),
    });
    if (!response.ok || !response.body) {
      throw new BadRequestException(`signal-cli download failed (${response.status})`);
    }
    const hash = createHash('sha256');
    let size = 0;
    const source = Readable.fromWeb(response.body as never);
    source.on('data', (chunk: Buffer) => {
      size += chunk.length;
      hash.update(chunk);
    });
    try {
      await pipeline(source, createWriteStream(tmp, { mode: 0o600 }));
      if (size !== SIZE) {
        throw new BadRequestException(`signal-cli download size mismatch (${size} != ${SIZE})`);
      }
      if (hash.digest('hex') !== SHA256) {
        throw new BadRequestException('signal-cli download failed integrity check');
      }
      await this.extract(tmp);
      await chmod(this.binPath, 0o700);
      this.logger.log('signal-cli verified and installed');
    } finally {
      await rm(tmp, { force: true });
    }
  }

  private extract(archive: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        'tar',
        ['-xzf', archive, '-C', join(this.home, `signal-cli-${VERSION}`)],
        {
          stdio: ['ignore', 'ignore', 'pipe'],
        },
      );
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('error', reject);
      child.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`tar exited ${code}: ${stderr.trim()}`)),
      );
    });
  }

  private gateRequest(
    request: Record<string, string>,
    timeoutMs: number,
    onLine?: (line: Record<string, unknown>) => void,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.gate!);
      let buffer = '';
      let last: Record<string, unknown> | null = null;
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Signal gate ${request.op} timed out`));
      }, timeoutMs);
      socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            last = JSON.parse(line) as Record<string, unknown>;
          } catch {
            this.logger.warn(`Signal gate sent a malformed line for ${request.op}`);
            continue;
          }
          onLine?.(last);
        }
      });
      socket.on('error', (error) => {
        clearTimeout(timer);
        reject(new Error(`Signal gate ${request.op}: ${error.message}`));
      });
      socket.on('close', () => {
        clearTimeout(timer);
        if (last?.ok === true) {
          resolve(last);
        } else {
          reject(new Error(`Signal gate ${request.op}: ${String(last?.error ?? 'no response')}`));
        }
      });
    });
  }

  private async runGate(args: string[], timeoutMs: number, input?: string): Promise<string> {
    const request: Record<string, string> = { op: args[0] };
    if (args[0] === 'send') {
      request.groupId = args[1];
      request.message = input ?? '';
    }
    const { ok: _ok, ...result } = await this.gateRequest(request, timeoutMs);
    return JSON.stringify(result);
  }

  private run(args: string[], timeoutMs = 30_000, input?: string): Promise<string> {
    if (this.gate) {
      return this.runGate(args, timeoutMs, input);
    }
    return new Promise((resolve, reject) => {
      const child = spawn(this.binPath, ['--config', this.configDir, ...args], {
        env: { PATH: process.env.PATH, HOME: this.home, TMPDIR: process.env.TMPDIR },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(
            new Error(`signal-cli ${args[0]} exited ${code}: ${stderr.trim() || stdout.trim()}`),
          );
        }
      });
    });
  }

  async linkUri(): Promise<string> {
    await this.ensureReady();
    if ((this.linkChild || this.gateLinking) && this.lastLinkUri) {
      return this.lastLinkUri;
    }
    if (this.gate) {
      return new Promise((resolve, reject) => {
        let settled = false;
        this.gateLinking = true;
        this.gateRequest({ op: 'link' }, 330_000, (line) => {
          if (
            !settled &&
            typeof line.uri === 'string' &&
            line.uri.startsWith('sgnl://linkdevice?')
          ) {
            settled = true;
            this.lastLinkUri = line.uri;
            resolve(line.uri);
          }
        })
          .then(() => this.onLinked())
          .catch((error: unknown) => {
            if (!settled) {
              settled = true;
              reject(error instanceof Error ? error : new Error(String(error)));
            } else {
              this.logger.warn(`Signal link did not finish: ${String(error)}`);
            }
          })
          .finally(() => {
            this.gateLinking = false;
            this.lastLinkUri = null;
          });
      });
    }
    return new Promise((resolve, reject) => {
      const child = spawn(this.binPath, ['--config', this.configDir, 'link', '-n', 'AntiHunter'], {
        env: { PATH: process.env.PATH, HOME: this.home, TMPDIR: process.env.TMPDIR },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.linkChild = child;
      let buffer = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          child.kill('SIGKILL');
          reject(new BadRequestException('signal-cli did not return a link code in time'));
        }
      }, 45_000);
      child.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const match = buffer.match(/sgnl:\/\/linkdevice\?\S+/);
        if (match && !settled) {
          settled = true;
          clearTimeout(timer);
          this.lastLinkUri = match[0];
          resolve(match[0]);
        }
      });
      child.on('error', (error) => {
        if (!settled) {
          clearTimeout(timer);
          reject(error);
        }
      });
      child.on('exit', (code) => {
        this.linkChild = null;
        this.lastLinkUri = null;
        if (code === 0) {
          void this.onLinked();
        } else if (!settled) {
          clearTimeout(timer);
          reject(new Error(`signal-cli link exited ${code}`));
        }
      });
    });
  }

  private async onLinked(): Promise<void> {
    if (!this.gate) {
      await chmod(this.configDir, 0o700).catch((error: unknown) =>
        this.logger.warn(`Could not restrict ${this.configDir}: ${String(error)}`),
      );
    }
    const number = await this.linkedNumber();
    if (number) {
      await this.config.update({ signalNumber: number, signalEnabled: true });
      this.logger.log('Signal device linked');
    }
  }

  async linkedNumber(): Promise<string | null> {
    if (!(await this.binaryReady())) {
      return null;
    }
    try {
      if (this.gate) {
        const status = JSON.parse(await this.run(['status'], 10_000)) as { accounts?: unknown };
        const first = Array.isArray(status.accounts) ? status.accounts[0] : null;
        return typeof first === 'string' ? first : null;
      }
      const out = await this.run(['--output', 'json', 'listAccounts'], 10_000);
      const accounts = JSON.parse(out) as Array<{ number?: unknown }>;
      const first = accounts.find((account) => typeof account.number === 'string');
      return first ? (first.number as string) : null;
    } catch {
      return null;
    }
  }

  async createGroup(): Promise<string> {
    await this.ensureReady();
    const out = this.gate
      ? await this.run(['create-group'])
      : await this.run([
          '--output',
          'json',
          'updateGroup',
          '-n',
          'AntiHunter Alerts',
          '--set-permission-add-member',
          'only-admins',
          '--set-permission-edit-details',
          'only-admins',
          '--link',
          'disabled',
        ]);
    const body = JSON.parse(out) as { groupId?: unknown };
    if (typeof body.groupId !== 'string') {
      throw new Error('signal-cli did not return a group id');
    }
    return body.groupId;
  }

  async send(groupId: string, message: string): Promise<void> {
    await this.ensureReady();
    if (this.gate) {
      await this.run(['send', groupId], 30_000, message);
      return;
    }
    await this.run(['send', `--group-id=${groupId}`, `--message=${message}`]);
  }
}
