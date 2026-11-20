import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AlarmLevel } from '@prisma/client';
import { ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { RemoteAlertConfigService } from './remote-alert-config.service';

const HELPER_ENV_KEYS = [
  'AHCC_MATTER_STORAGE',
  'AHCC_MATTER_PORT',
  'AHCC_MATTER_PASSCODE',
  'AHCC_MATTER_INTERFACE',
  'HOME',
  'PATH',
  'TMPDIR',
];

const STATUS_PREFIX = '@@ahcc-status ';

export interface MatterStatus {
  running: boolean;
  runtime: string;
  commissioned: boolean | null;
  layout: string | null;
  manualPairingCode: string | null;
  qrPairingCode: string | null;
  passcode: number | null;
  lastExit: string | null;
}

@Injectable()
export class MatterService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MatterService.name);
  private helper: ChildProcess | null = null;
  private stopping = false;
  private lastExit: string | null = null;
  private helperInterface: string | null = null;
  private helperStatus: Omit<MatterStatus, 'running' | 'runtime' | 'lastExit'> | null = null;

  constructor(private readonly config: RemoteAlertConfigService) {}

  async onModuleInit(): Promise<void> {
    this.config.onChange(() => void this.sync());
    await this.sync();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  status(): MatterStatus {
    return {
      running: Boolean(this.helper),
      runtime: this.runtime(),
      commissioned: this.helperStatus?.commissioned ?? null,
      layout: this.helperStatus?.layout ?? null,
      manualPairingCode: this.helperStatus?.manualPairingCode ?? null,
      qrPairingCode: this.helperStatus?.qrPairingCode ?? null,
      passcode: this.helperStatus?.passcode ?? null,
      lastExit: this.lastExit,
    };
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.sync();
  }

  async erase(): Promise<void> {
    const helper = this.helper;
    if (!helper?.stdin?.writable) {
      return;
    }
    this.stopping = true;
    const exited = new Promise((resolve) => helper.once('exit', resolve));
    helper.stdin.write(`${JSON.stringify({ type: 'erase' })}\n`);
    await exited;
    this.stopping = false;
    await this.sync();
  }

  trigger(severity: AlarmLevel | null): void {
    if (this.helper?.stdin?.writable) {
      this.helper.stdin.write(`${JSON.stringify({ type: 'trigger', severity })}\n`);
    }
  }

  private runtime(): string {
    return this.binary() || 'matter-helper.js on node';
  }

  private binary(): string | undefined {
    const configured = process.env.AHCC_MATTER_BIN?.trim();
    if (configured) {
      return configured;
    }
    const bundled = join(process.cwd(), 'bin', 'matter', 'ahcc-matter');
    return process.platform === 'darwin' && existsSync(bundled) ? bundled : undefined;
  }

  private async sync(): Promise<void> {
    const config = await this.config.get();
    const layoutChanged = this.helperStatus && this.helperStatus.layout !== config.matterLayout;
    const interfaceChanged =
      this.helper !== null && this.helperInterface !== (config.matterInterface ?? null);
    if (!config.matterEnabled || layoutChanged || interfaceChanged) {
      await this.stop();
    }
    if (config.matterEnabled && !this.helper) {
      this.start(config.matterLayout, config.matterInterface ?? null);
    }
  }

  private start(layout: string, iface: string | null): void {
    const env: NodeJS.ProcessEnv = { AHCC_MATTER_LAYOUT: layout };
    for (const key of HELPER_ENV_KEYS) {
      if (process.env[key] !== undefined) {
        env[key] = process.env[key];
      }
    }
    if (iface) {
      env.AHCC_MATTER_INTERFACE = iface;
    }
    this.helperInterface = iface;
    const binary = this.binary();
    const stdio: ['pipe', 'pipe', 'inherit'] = ['pipe', 'pipe', 'inherit'];
    const jsHelper = join(__dirname, 'matter-helper.js');
    let helper: ChildProcess;
    if (binary) {
      helper = spawn(binary, [], { env, stdio, detached: true });
    } else if (existsSync(jsHelper)) {
      helper = spawn(process.execPath, [jsHelper], { env, stdio, detached: true });
    } else {
      helper = spawn(
        process.execPath,
        ['-r', 'ts-node/register/transpile-only', join(__dirname, 'matter-helper.ts')],
        {
          env: { ...env, PATH: process.env.PATH, TS_NODE_TRANSPILE_ONLY: 'true' },
          stdio,
          cwd: join(__dirname, '..', '..'),
          detached: true,
        },
      );
    }
    this.helper = helper;
    this.helperStatus = null;
    this.stopping = false;
    helper.stdin?.on('error', (error) => this.logger.warn(`Matter helper pipe: ${error.message}`));
    if (helper.stdout) {
      createInterface({ input: helper.stdout }).on('line', (line) => {
        if (line.startsWith(STATUS_PREFIX)) {
          try {
            this.helperStatus = JSON.parse(line.slice(STATUS_PREFIX.length));
          } catch {
            this.logger.warn('Matter helper sent a malformed status line');
          }
          return;
        }
        process.stdout.write(`${line}\n`);
      });
    }
    helper.on('exit', (code, signal) => {
      if (this.helper === helper) {
        this.helper = null;
      }
      this.lastExit = `code ${code}, signal ${signal}, at ${new Date().toISOString()}`;
      if (!this.stopping) {
        this.logger.error(`Matter helper exited (${this.lastExit})`);
      }
    });
    helper.on('error', (error) => this.logger.error(`Matter helper error: ${error.message}`));
    this.logger.log(`Matter helper started: ${this.runtime()} (layout ${layout})`);
  }

  private async stop(): Promise<void> {
    const helper = this.helper;
    if (!helper) {
      return;
    }
    this.stopping = true;
    const exited = new Promise((resolve) => helper.once('exit', resolve));
    helper.stdin?.end();
    const timeout = setTimeout(() => helper.kill('SIGTERM'), 10_000);
    await exited;
    clearTimeout(timeout);
    this.helper = null;
    this.helperStatus = null;
  }
}
