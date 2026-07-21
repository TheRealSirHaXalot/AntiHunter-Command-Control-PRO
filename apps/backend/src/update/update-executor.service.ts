import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'child_process';
import { join } from 'path';

import { UpdateBackupService } from './update-backup.service';
import { UpdateConfigService } from './update-config.service';
import { UpdateGitService } from './update-git.service';
import {
  DatabaseStatus,
  UpdatePhase,
  UpdateProgressEvent,
  UpdateExecutionResult,
  UpdateLogEvent,
} from './update.types';
import { EventBusService } from '../events/event-bus.service';

@Injectable()
export class UpdateExecutorService {
  private readonly logger = new Logger(UpdateExecutorService.name);
  private readonly repoRoot: string;

  constructor(
    private readonly gitService: UpdateGitService,
    private readonly configService: UpdateConfigService,
    private readonly backupService: UpdateBackupService,
    private readonly eventBus: EventBusService,
  ) {
    this.repoRoot = join(__dirname, '../../../..');
  }

  /**
   * Execute a shell command with output streaming
   */
  private async execCommand(
    command: string,
    args: string[],
    options: { timeout?: number; cwd?: string; phase: UpdatePhase; silent?: boolean } = {
      phase: UpdatePhase.PREFLIGHT,
    },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    this.validateCommand(command);
    this.validateCommandArgs(args);

    const timeout = options.timeout || 600000;
    const cwd = this.validateAndNormalizePath(options.cwd || this.repoRoot);
    const MAX_OUTPUT_SIZE = 50 * 1024 * 1024;

    this.logger.log(`Executing command: ${command} ${args.join(' ')}`);

    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        shell: process.platform === 'win32',
        env: this.getSafeEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let outputSize = 0;

      child.stdout.on('data', (data) => {
        const output = data.toString();
        outputSize += output.length;
        if (outputSize > MAX_OUTPUT_SIZE) {
          child.kill('SIGTERM');
          this.logger.error('Command output exceeded maximum size limit');
          reject(new Error('Command output exceeded maximum size limit'));
          return;
        }
        stdout += output;
        if (!options.silent) {
          this.publishLogEvent('info', output, options.phase);
        }
      });

      child.stderr.on('data', (data) => {
        const output = data.toString();
        outputSize += output.length;
        if (outputSize > MAX_OUTPUT_SIZE) {
          child.kill('SIGTERM');
          this.logger.error('Command output exceeded maximum size limit');
          reject(new Error('Command output exceeded maximum size limit'));
          return;
        }
        stderr += output;
        if (!options.silent) {
          this.publishLogEvent('warn', output, options.phase);
        }
      });

      const timeoutId = setTimeout(() => {
        child.kill('SIGTERM');
        this.logger.warn(`Command timed out after ${timeout}ms: ${command} ${args.join(' ')}`);
        reject(new Error(`Command timed out after ${timeout}ms`));
      }, timeout);

      child.on('close', (code) => {
        clearTimeout(timeoutId);
        if (code !== 0) {
          this.logger.warn(`Command failed with exit code ${code}: ${command} ${args.join(' ')}`);
        }
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code || 0 });
      });

      child.on('error', (err) => {
        clearTimeout(timeoutId);
        this.logger.error(`Command error: ${err.message}`);
        reject(err);
      });
    });
  }

  private validateCommand(command: string): void {
    if (!command || typeof command !== 'string') {
      throw new Error('Invalid command: must be non-empty string');
    }

    const ALLOWED_COMMANDS = ['pnpm', 'node', 'npm'];

    const commandName = command.split('/').pop() || command;

    if (!ALLOWED_COMMANDS.includes(commandName)) {
      throw new Error(`Command not allowed: ${command}`);
    }

    if (command.includes('\n') || command.includes('\r') || command.includes('\0')) {
      throw new Error('Invalid command: contains control characters');
    }

    if (command.includes('..') || command.includes('~')) {
      throw new Error('Invalid command: contains path traversal');
    }
  }

  private validateCommandArgs(args: string[]): void {
    if (!Array.isArray(args)) {
      throw new Error('Invalid arguments: must be array');
    }

    const DANGEROUS_PATTERNS = [';', '&&', '||', '|', '$(', '`', '\n', '\r', '\0', '>', '<', '&'];

    for (const arg of args) {
      if (typeof arg !== 'string') {
        throw new Error('Invalid argument: must be string');
      }

      for (const pattern of DANGEROUS_PATTERNS) {
        if (arg.includes(pattern)) {
          throw new Error(`Dangerous pattern in argument: ${pattern}`);
        }
      }
    }
  }

  private validateAndNormalizePath(path: string): string {
    if (!path || typeof path !== 'string') {
      throw new Error('Invalid path: must be non-empty string');
    }

    if (path.includes('\0') || path.includes('\n') || path.includes('\r')) {
      throw new Error('Invalid path: contains control characters');
    }

    const normalizedPath = join(path);

    if (!normalizedPath.startsWith(this.repoRoot)) {
      throw new Error('Path traversal detected: path must be within repository');
    }

    return normalizedPath;
  }

  private getSafeEnv(): NodeJS.ProcessEnv {
    const safeEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USER: process.env.USER,
      NODE_ENV: process.env.NODE_ENV,
      DATABASE_URL: process.env.DATABASE_URL,
      LANG: process.env.LANG || 'en_US.UTF-8',
      LC_ALL: process.env.LC_ALL || 'en_US.UTF-8',
    };

    if (process.platform === 'win32') {
      for (const key of [
        'SystemRoot',
        'SYSTEMROOT',
        'USERPROFILE',
        'USERNAME',
        'APPDATA',
        'LOCALAPPDATA',
        'TEMP',
        'TMP',
        'PATHEXT',
        'ComSpec',
        'HOMEDRIVE',
        'HOMEPATH',
        'ProgramFiles',
        'ProgramData',
      ]) {
        if (process.env[key] !== undefined) safeEnv[key] = process.env[key];
      }
    }

    return safeEnv;
  }

  /**
   * Publish progress event
   */
  private publishProgressEvent(
    phase: UpdatePhase,
    step: string,
    progress: number,
    message: string,
  ): void {
    const event: UpdateProgressEvent = {
      type: 'update.progress',
      phase,
      step,
      progress,
      message,
      timestamp: new Date().toISOString(),
    };

    this.eventBus.publish({
      type: 'update.progress',
      data: event,
    });
  }

  /**
   * Publish log event
   */
  private publishLogEvent(
    level: 'info' | 'warn' | 'error',
    message: string,
    _phase?: UpdatePhase,
  ): void {
    const event: UpdateLogEvent = {
      type: 'update.log',
      level,
      message: message.trim(),
      timestamp: new Date().toISOString(),
    };

    this.eventBus.publish({
      type: 'update.log',
      data: event,
    });
  }

  /**
   * Phase 1: Pre-flight checks
   */
  async executePreflightChecks(): Promise<UpdateExecutionResult> {
    this.logger.log('Executing pre-flight checks...');
    this.publishProgressEvent(UpdatePhase.PREFLIGHT, 'checks', 10, 'Verifying repository...');

    try {
      // Check if git repository
      const isRepo = await this.gitService.isGitRepository();
      if (!isRepo) {
        throw new Error('Not a git repository');
      }

      this.publishProgressEvent(
        UpdatePhase.PREFLIGHT,
        'checks',
        30,
        'Checking for uncommitted changes...',
      );

      // Auto-stash uncommitted changes
      const hasChanges = await this.gitService.hasUncommittedChanges();
      if (hasChanges) {
        this.logger.warn('Uncommitted changes detected - auto-stashing...');
        await this.gitService.stash('Auto-stash before update');
        this.logger.log('Changes stashed successfully');
      }

      this.publishProgressEvent(
        UpdatePhase.PREFLIGHT,
        'checks',
        40,
        'Checking for diverging branches...',
      );

      // Check if branches have diverged (local commits not on remote)
      const currentBranch = await this.gitService.getCurrentBranch();
      const hasDivergence = await this.gitService.hasDivergingBranches(currentBranch);
      if (hasDivergence) {
        throw new Error(
          'Local branch has diverged from remote. This will require a force reset that discards local commits.',
        );
      }

      this.publishProgressEvent(
        UpdatePhase.PREFLIGHT,
        'checks',
        50,
        'Verifying remote repository...',
      );

      // Verify remote is official
      const isOfficial = await this.gitService.verifyRemote();
      if (!isOfficial) {
        this.logger.warn('Remote repository is not the official AntiHunter repo');
      }

      this.publishProgressEvent(UpdatePhase.PREFLIGHT, 'checks', 70, 'Checking disk space...');

      // Check disk space
      const hasSpace = await this.backupService.hasEnoughDiskSpace(500);
      if (!hasSpace) {
        throw new Error('Insufficient disk space. Need at least 500MB free.');
      }

      this.publishProgressEvent(UpdatePhase.PREFLIGHT, 'checks', 100, 'Pre-flight checks passed');

      return {
        success: true,
        phase: UpdatePhase.PREFLIGHT,
        output: 'All pre-flight checks passed',
      };
    } catch (error: unknown) {
      const err = error as Error;
      this.logger.error(`Pre-flight checks failed: ${err.message}`);
      return {
        success: false,
        phase: UpdatePhase.PREFLIGHT,
        error: err.message,
      };
    }
  }

  /**
   * Phase 2: Git update
   */
  async executeGitUpdate(
    remote: string = 'origin',
    branch: string = 'main',
  ): Promise<UpdateExecutionResult> {
    this.logger.log('Executing git update...');
    this.publishProgressEvent(UpdatePhase.GIT_UPDATE, 'fetch', 20, `Fetching from ${remote}...`);

    try {
      // Fetch latest changes
      await this.gitService.fetch(remote);

      this.publishProgressEvent(UpdatePhase.GIT_UPDATE, 'pull', 60, 'Pulling changes...');

      // Pull with fast-forward only
      await this.gitService.pull(remote, branch);

      this.publishProgressEvent(UpdatePhase.GIT_UPDATE, 'complete', 100, 'Git update completed');

      return {
        success: true,
        phase: UpdatePhase.GIT_UPDATE,
        output: 'Git update successful',
      };
    } catch (error: unknown) {
      const err = error as Error;
      this.logger.error(`Git update failed: ${err.message}`);
      return {
        success: false,
        phase: UpdatePhase.GIT_UPDATE,
        error: err.message,
      };
    }
  }

  /**
   * Phase 3: Install dependencies
   */
  async executeDependencyInstall(): Promise<UpdateExecutionResult> {
    this.logger.log('Installing dependencies...');
    this.publishProgressEvent(UpdatePhase.DEPENDENCIES, 'install', 10, 'Running pnpm install...');

    try {
      const result = await this.execCommand('pnpm', ['install'], {
        timeout: 600000, // 10 minutes
        phase: UpdatePhase.DEPENDENCIES,
      });

      if (result.exitCode !== 0) {
        throw new Error(`pnpm install failed: ${result.stderr}`);
      }

      this.publishProgressEvent(
        UpdatePhase.DEPENDENCIES,
        'complete',
        100,
        'Dependencies installed',
      );

      return {
        success: true,
        phase: UpdatePhase.DEPENDENCIES,
        output: 'Dependencies installed successfully',
      };
    } catch (error: unknown) {
      const err = error as Error;
      this.logger.error(`Dependency installation failed: ${err.message}`);
      return {
        success: false,
        phase: UpdatePhase.DEPENDENCIES,
        error: err.message,
      };
    }
  }

  /**
   * Read-only inspection of the database migration state.
   * Never mutates the database — safe to call outside an update.
   */
  async getDatabaseStatus(): Promise<DatabaseStatus> {
    const manualCommand = 'pnpm --filter @command-center/backend exec prisma migrate deploy';

    let output: string;
    try {
      const result = await this.execCommand(
        'pnpm',
        ['--filter', '@command-center/backend', 'exec', 'prisma', 'migrate', 'status'],
        { timeout: 60000, phase: UpdatePhase.DATABASE, silent: true },
      );
      output = `${result.stdout}\n${result.stderr}`.trim();
    } catch (error: unknown) {
      const err = error as Error;
      this.logger.error(`Failed to read migration status: ${err.message}`);
      return {
        state: 'unknown',
        message: `Could not read migration status: ${err.message}`,
        pendingMigrations: [],
        failedMigrations: [],
        actionRequired: false,
        appliedDuringUpdate: true,
        manualCommand,
      };
    }

    const foundMatch = /(\d+)\s+migrations?\s+found/i.exec(output);
    const migrationsFound = foundMatch ? Number(foundMatch[1]) : undefined;

    if (/P1001|P1000|Can't reach database server|Authentication failed/i.test(output)) {
      return {
        state: 'unreachable',
        message: 'Database is unreachable — check DATABASE_URL and that PostgreSQL is running.',
        migrationsFound,
        pendingMigrations: [],
        failedMigrations: [],
        actionRequired: true,
        appliedDuringUpdate: false,
        manualCommand,
        details: output,
      };
    }

    const failedMigrations = this.extractMigrationNames(output, /migrations?\s+have\s+failed/i);
    if (failedMigrations.length > 0) {
      return {
        state: 'failed',
        message: `${failedMigrations.length} migration(s) failed and must be resolved before deploying.`,
        migrationsFound,
        pendingMigrations: [],
        failedMigrations,
        actionRequired: true,
        appliedDuringUpdate: false,
        manualCommand: `pnpm --filter @command-center/backend exec prisma migrate resolve --rolled-back ${failedMigrations[0]}`,
        details: output,
      };
    }

    const pendingMigrations = this.extractMigrationNames(
      output,
      /migrations?\s+have\s+not\s+yet\s+been\s+applied/i,
    );
    if (pendingMigrations.length > 0) {
      return {
        state: 'pending',
        message: `${pendingMigrations.length} migration(s) pending — these are applied automatically during a deploy.`,
        migrationsFound,
        pendingMigrations,
        failedMigrations: [],
        actionRequired: true,
        appliedDuringUpdate: true,
        manualCommand,
        details: output,
      };
    }

    if (/up to date/i.test(output)) {
      return {
        state: 'up-to-date',
        message: migrationsFound
          ? `Database schema is up to date (${migrationsFound} migrations applied).`
          : 'Database schema is up to date.',
        migrationsFound,
        pendingMigrations: [],
        failedMigrations: [],
        actionRequired: false,
        appliedDuringUpdate: true,
        manualCommand,
      };
    }

    return {
      state: 'unknown',
      message: 'Could not determine database migration state.',
      migrationsFound,
      pendingMigrations: [],
      failedMigrations: [],
      actionRequired: false,
      appliedDuringUpdate: true,
      manualCommand,
      details: output,
    };
  }

  private extractMigrationNames(output: string, header: RegExp): string[] {
    const lines = output.split('\n');
    const headerIndex = lines.findIndex((line) => header.test(line));
    if (headerIndex === -1) return [];

    const names: string[] = [];
    for (const line of lines.slice(headerIndex + 1)) {
      const trimmed = line.trim();
      if (!trimmed) {
        if (names.length > 0) break;
        continue;
      }
      if (!/^\d{6,}_[\w-]+$/.test(trimmed)) break;
      names.push(trimmed);
    }

    return names;
  }

  /**
   * Phase 4: Database migrations
   */
  async executeDatabaseMigrations(): Promise<UpdateExecutionResult> {
    this.logger.log('Running database migrations...');
    this.publishProgressEvent(UpdatePhase.DATABASE, 'generate', 20, 'Generating Prisma client...');

    try {
      // Prisma generate
      const generateResult = await this.execCommand(
        'pnpm',
        ['--filter', '@command-center/backend', 'exec', 'prisma', 'generate'],
        {
          timeout: 180000, // 3 minutes
          phase: UpdatePhase.DATABASE,
        },
      );

      if (generateResult.exitCode !== 0) {
        throw new Error(`Prisma generate failed: ${generateResult.stderr}`);
      }

      this.publishProgressEvent(UpdatePhase.DATABASE, 'migrate', 60, 'Running migrations...');

      // Prisma migrate
      const migrateResult = await this.execCommand(
        'pnpm',
        ['--filter', '@command-center/backend', 'exec', 'prisma', 'migrate', 'deploy'],
        {
          timeout: 300000, // 5 minutes
          phase: UpdatePhase.DATABASE,
        },
      );

      if (migrateResult.exitCode !== 0) {
        throw new Error(`Prisma migrate failed: ${migrateResult.stderr}`);
      }

      this.publishProgressEvent(
        UpdatePhase.DATABASE,
        'complete',
        100,
        'Database migrations completed',
      );

      return {
        success: true,
        phase: UpdatePhase.DATABASE,
        output: 'Database migrations successful',
      };
    } catch (error: unknown) {
      const err = error as Error;
      this.logger.error(`Database migrations failed: ${err.message}`);
      return {
        success: false,
        phase: UpdatePhase.DATABASE,
        error: err.message,
      };
    }
  }

  /**
   * Phase 5: Build
   */
  async executeBuild(): Promise<UpdateExecutionResult> {
    this.logger.log('Building application...');
    this.publishProgressEvent(UpdatePhase.BUILD, 'backend', 20, 'Building backend...');

    try {
      // Build backend
      const backendResult = await this.execCommand(
        'pnpm',
        ['--filter', '@command-center/backend', 'build'],
        {
          timeout: 600000, // 10 minutes
          phase: UpdatePhase.BUILD,
        },
      );

      if (backendResult.exitCode !== 0) {
        throw new Error(`Backend build failed: ${backendResult.stderr}`);
      }

      this.publishProgressEvent(UpdatePhase.BUILD, 'frontend', 60, 'Building frontend...');

      // Build frontend
      const frontendResult = await this.execCommand(
        'pnpm',
        ['--filter', '@command-center/frontend', 'build'],
        {
          timeout: 600000, // 10 minutes
          phase: UpdatePhase.BUILD,
        },
      );

      if (frontendResult.exitCode !== 0) {
        throw new Error(`Frontend build failed: ${frontendResult.stderr}`);
      }

      this.publishProgressEvent(UpdatePhase.BUILD, 'complete', 100, 'Build completed');

      return {
        success: true,
        phase: UpdatePhase.BUILD,
        output: 'Build successful',
      };
    } catch (error: unknown) {
      const err = error as Error;
      this.logger.error(`Build failed: ${err.message}`);
      return {
        success: false,
        phase: UpdatePhase.BUILD,
        error: err.message,
      };
    }
  }

  /**
   * Phase 6: Validation
   */
  async executeValidation(): Promise<UpdateExecutionResult> {
    this.logger.log('Validating update...');
    this.publishProgressEvent(UpdatePhase.VALIDATION, 'configs', 50, 'Validating config files...');

    try {
      // Validate config files are still valid JSON
      const configValidation = await this.configService.validateConfigFiles();
      if (!configValidation.valid) {
        throw new Error(`Config validation failed: ${configValidation.errors.join(', ')}`);
      }

      this.publishProgressEvent(UpdatePhase.VALIDATION, 'complete', 100, 'Validation completed');

      return {
        success: true,
        phase: UpdatePhase.VALIDATION,
        output: 'Validation successful',
      };
    } catch (error: unknown) {
      const err = error as Error;
      this.logger.error(`Validation failed: ${err.message}`);
      return {
        success: false,
        phase: UpdatePhase.VALIDATION,
        error: err.message,
      };
    }
  }
}
