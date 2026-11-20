import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { RemoteAlertConfigService } from './remote-alert-config.service';

const STATUS_PREFIX = '@@ahcc-ts ';

interface HelperStatus {
  type: 'connecting' | 'running' | 'error';
  dnsName?: string;
  tailnet?: string;
  message?: string;
  https?: boolean;
  ip?: string;
}

@Injectable()
export class TailscaleService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TailscaleService.name);
  private helper: ChildProcess | null = null;
  private stopping = false;
  private helperStatus: HelperStatus | null = null;
  private lastExit: string | null = null;

  constructor(private readonly config: RemoteAlertConfigService) {}

  async onModuleInit(): Promise<void> {
    this.config.onChange(() => void this.sync());
    await this.sync();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  status(): {
    available: boolean;
    running: boolean;
    connecting: boolean;
    dnsName: string | null;
    tailnet: string | null;
    https: boolean;
    ip: string | null;
    lastError: string | null;
    lastExit: string | null;
    enrolled: boolean;
  } {
    return {
      available: existsSync(this.binary()),
      enrolled: this.enrolled(),
      https: this.helperStatus?.https ?? false,
      ip: this.helperStatus?.ip ?? null,
      running: Boolean(this.helper) && this.helperStatus?.type === 'running',
      connecting: Boolean(this.helper) && this.helperStatus?.type !== 'running',
      dnsName: this.helperStatus?.dnsName ?? null,
      tailnet: this.helperStatus?.tailnet ?? null,
      lastError: this.helperStatus?.type === 'error' ? (this.helperStatus.message ?? null) : null,
      lastExit: this.lastExit,
    };
  }

  private binary(): string {
    if (process.env.AHCC_TAILSCALE_BIN?.trim()) return process.env.AHCC_TAILSCALE_BIN.trim();
    const base = join(process.cwd(), 'bin', 'tailscale');
    const plat =
      process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const ext = process.platform === 'win32' ? '.exe' : '';
    const specific = join(base, `ahcc-tailscale-${plat}-${arch}${ext}`);
    if (existsSync(specific)) return specific;
    return join(base, 'ahcc-tailscale');
  }

  private stateDir(): string {
    return join(process.cwd(), '.tailscale');
  }

  private enrolled(): boolean {
    return existsSync(join(this.stateDir(), 'tailscaled.state'));
  }

  private async sync(): Promise<void> {
    const config = await this.config.get();
    const wanted = config.tailscaleEnabled && (Boolean(config.tsAuthKey) || this.enrolled());
    if (!wanted && this.helper) {
      await this.stop();
      return;
    }
    if (wanted && !this.helper) {
      this.start(config.tsAuthKey, config.tsHostname, config.tsAllowedLogins);
    }
  }

  private async dropAuthKey(): Promise<void> {
    const config = await this.config.get();
    if (config.tsAuthKey && this.enrolled()) {
      await this.config.clearSecret('tsAuthKey');
      this.logger.log('Tailscale joined; deleted the saved auth key');
    }
  }

  private start(authKey: string | null, hostname: string | null, allowed: string[]): void {
    const binary = this.binary();
    if (!existsSync(binary)) {
      this.logger.error(`Tailscale helper not found at ${binary}`);
      this.helperStatus = { type: 'error', message: `helper binary missing at ${binary}` };
      return;
    }
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      AHCC_TS_AUTHKEY: authKey ?? '',
      AHCC_TS_HOSTNAME: hostname?.trim() || process.env.TS_HOSTNAME?.trim() || 'ahcc',
      AHCC_TS_UPSTREAM:
        process.env.AHCC_TS_UPSTREAM?.trim() ||
        (process.env.NODE_ENV === 'production' ? 'http://127.0.0.1:8080' : 'http://127.0.0.1:5173'),
      AHCC_TS_STATE: this.stateDir(),
      AHCC_TS_ALLOWED: allowed.join(','),
    };
    const child = spawn(binary, [], { env, stdio: ['pipe', 'pipe', 'inherit'], detached: true });
    this.helper = child;
    this.helperStatus = { type: 'connecting' };
    this.stopping = false;
    if (child.stdout) {
      createInterface({ input: child.stdout }).on('line', (line) => {
        if (line.startsWith(STATUS_PREFIX)) {
          try {
            this.helperStatus = JSON.parse(line.slice(STATUS_PREFIX.length));
            if (this.helperStatus?.type === 'running') {
              void this.dropAuthKey().catch((error: unknown) =>
                this.logger.error(
                  `Could not delete the Tailscale auth key: ${error instanceof Error ? error.message : error}`,
                ),
              );
            }
          } catch {
            this.logger.warn('Tailscale helper sent a malformed status line');
          }
          return;
        }
        process.stdout.write(`${line}\n`);
      });
    }
    child.on('exit', (code, signal) => {
      if (this.helper === child) {
        this.helper = null;
      }
      this.lastExit = `code ${code}, signal ${signal}, at ${new Date().toISOString()}`;
      if (!this.stopping) {
        this.logger.error(`Tailscale helper exited (${this.lastExit})`);
      }
    });
    child.on('error', (error) => this.logger.error(`Tailscale helper error: ${error.message}`));
    this.logger.log(`Tailscale helper started: ${binary}`);
  }

  private async stop(): Promise<void> {
    const child = this.helper;
    if (!child) {
      return;
    }
    this.stopping = true;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 8_000);
    await exited;
    clearTimeout(timeout);
    this.helper = null;
    this.helperStatus = null;
  }
}
