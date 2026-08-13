import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

import { GitStatus } from './update.types';

@Injectable()
export class UpdateGitService {
  private readonly logger = new Logger(UpdateGitService.name);
  private readonly repoRoot: string;

  constructor() {
    // Determine repository root (assumes backend is in apps/backend)
    this.repoRoot = join(__dirname, '../../../..');
  }

  /**
   * Check if we're in a git repository
   */
  async isGitRepository(): Promise<boolean> {
    const gitDir = join(this.repoRoot, '.git');
    return existsSync(gitDir);
  }

  /**
   * Execute a git command and return the output
   */
  private async execGit(
    args: string[],
    options: { timeout?: number; cwd?: string } = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    this.validateGitArgs(args);

    const timeout = options.timeout || 30000;
    const cwd = this.validateAndNormalizePath(options.cwd || this.repoRoot);
    const MAX_OUTPUT_SIZE = 10 * 1024 * 1024;

    this.logger.log(`Executing git command: git ${args.join(' ')}`);

    return new Promise((resolve, reject) => {
      const child = spawn('git', args, {
        cwd,
        shell: false,
        env: this.getSafeEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let outputSize = 0;

      child.stdout.on('data', (data) => {
        const chunk = data.toString();
        outputSize += chunk.length;
        if (outputSize > MAX_OUTPUT_SIZE) {
          child.kill('SIGTERM');
          reject(new Error('Command output exceeded maximum size limit'));
          return;
        }
        stdout += chunk;
      });

      child.stderr.on('data', (data) => {
        const chunk = data.toString();
        outputSize += chunk.length;
        if (outputSize > MAX_OUTPUT_SIZE) {
          child.kill('SIGTERM');
          reject(new Error('Command output exceeded maximum size limit'));
          return;
        }
        stderr += chunk;
      });

      const timeoutId = setTimeout(() => {
        child.kill('SIGTERM');
        this.logger.warn(`Git command timed out after ${timeout}ms: git ${args.join(' ')}`);
        reject(new Error(`Git command timed out after ${timeout}ms`));
      }, timeout);

      child.on('close', (code) => {
        clearTimeout(timeoutId);
        if (code !== 0) {
          this.logger.warn(`Git command failed with exit code ${code}: git ${args.join(' ')}`);
        }
        resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code || 0 });
      });

      child.on('error', (err) => {
        clearTimeout(timeoutId);
        this.logger.error(`Git command error: ${err.message}`);
        reject(err);
      });
    });
  }

  private validateGitArgs(args: string[]): void {
    if (!Array.isArray(args) || args.length === 0) {
      throw new Error('Invalid git arguments: must be non-empty array');
    }

    const DANGEROUS_ARGS = [
      '-c',
      '--config',
      'upload-pack',
      'upload-archive',
      '--upload-pack',
      '--exec',
    ];

    for (const arg of args) {
      if (typeof arg !== 'string') {
        throw new Error('Invalid git argument: must be string');
      }

      if (arg.includes('\n') || arg.includes('\r') || arg.includes('\0')) {
        throw new Error('Invalid git argument: contains control characters');
      }

      const lowerArg = arg.toLowerCase();
      for (const dangerous of DANGEROUS_ARGS) {
        if (lowerArg.startsWith(dangerous)) {
          throw new Error(`Dangerous git argument not allowed: ${dangerous}`);
        }
      }

      if (arg.startsWith('-') && !this.isAllowedGitOption(arg)) {
        this.logger.warn(`Potentially unsafe git option: ${arg}`);
      }
    }
  }

  private isAllowedGitOption(option: string): boolean {
    const ALLOWED_OPTIONS = [
      '--abbrev-ref',
      '--get',
      '--format',
      '--porcelain',
      '--left-right',
      '--count',
      '--verify',
      '--ff-only',
      '--hard',
      '--soft',
      '-s',
      '-u',
      '-m',
      '-n',
      '-1',
    ];

    return ALLOWED_OPTIONS.some((allowed) => option.startsWith(allowed));
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
      LANG: process.env.LANG || 'en_US.UTF-8',
      LC_ALL: process.env.LC_ALL || 'en_US.UTF-8',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      GCM_INTERACTIVE: 'never',
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
   * Get current branch name
   */
  async getCurrentBranch(): Promise<string> {
    try {
      const result = await this.execGit(['rev-parse', '--abbrev-ref', 'HEAD']);
      return result.stdout;
    } catch (error: unknown) {
      const err = error as Error;
      this.logger.error(`Failed to get current branch: ${err.message}`);
      throw error;
    }
  }

  /**
   * Get tracking remote for a branch
   */
  async getTrackingRemote(branch: string): Promise<string | null> {
    try {
      const result = await this.execGit(['config', '--get', `branch.${branch}.remote`]);
      return result.stdout || null;
    } catch (error: unknown) {
      return null;
    }
  }

  /**
   * Get current commit hash
   */
  async getCurrentCommit(): Promise<string> {
    try {
      const result = await this.execGit(['rev-parse', 'HEAD']);
      if (result.exitCode !== 0 || !result.stdout.match(/^[0-9a-f]{40}$/)) {
        throw new Error(`Could not resolve HEAD: ${result.stderr || 'not a valid commit hash'}`);
      }
      return result.stdout;
    } catch (error: unknown) {
      const err = error as Error;
      this.logger.error(`Failed to get current commit: ${err.message}`);
      throw error;
    }
  }

  /**
   * Get commit information
   */
  async getCommitInfo(commitHash: string): Promise<{
    hash: string;
    message: string;
    date: string;
    author: string;
  }> {
    try {
      const result = await this.execGit(['show', '-s', '--format=%H%n%s%n%cI%n%an', commitHash]);

      const lines = result.stdout.split('\n');
      return {
        hash: lines[0] || commitHash,
        message: lines[1] || 'Unknown',
        date: lines[2] || new Date().toISOString(),
        author: lines[3] || 'Unknown',
      };
    } catch (error: unknown) {
      const err = error as Error;
      this.logger.error(`Failed to get commit info: ${err.message}`);
      return {
        hash: commitHash,
        message: 'Unknown',
        date: new Date().toISOString(),
        author: 'Unknown',
      };
    }
  }

  /**
   * Check if there are uncommitted changes
   */
  async hasUncommittedChanges(): Promise<boolean> {
    try {
      const result = await this.execGit(['status', '--porcelain']);
      return result.stdout.length > 0;
    } catch (error: unknown) {
      const err = error as Error;
      this.logger.error(`Failed to check for uncommitted changes: ${err.message}`);
      throw error;
    }
  }

  /**
   * Stash uncommitted changes
   */
  async stash(message: string = 'Auto-stash'): Promise<void> {
    try {
      const result = await this.execGit(['stash', 'push', '-u', '-m', message]);

      if (result.exitCode !== 0) {
        throw new Error(`Git stash failed: ${result.stderr}`);
      }

      this.logger.log(`Changes stashed: ${message}`);
    } catch (error: unknown) {
      const err = error as Error;
      this.logger.error(`Failed to stash changes: ${err.message}`);
      throw error;
    }
  }

  /**
   * Check if local branch has diverged from remote (has commits not on remote)
   */
  async hasDivergingBranches(branch: string, remote: string = 'origin'): Promise<boolean> {
    try {
      // Get commits in local branch not in remote
      const result = await this.execGit(['rev-list', `${remote}/${branch}..HEAD`]);

      // If there's output, local has commits not on remote (diverged)
      return result.stdout.trim().length > 0;
    } catch (error: unknown) {
      const err = error as Error;
      this.logger.error(`Failed to check for diverging branches: ${err.message}`);
      return false;
    }
  }

  /**
   * Fetch from remote
   */
  async fetch(remote: string = 'origin', timeout: number = 300000): Promise<void> {
    try {
      this.logger.log(`Fetching from ${remote}...`);
      const result = await this.execGit(['fetch', remote], { timeout });

      if (result.exitCode !== 0) {
        throw new Error(`Git fetch failed: ${result.stderr}`);
      }

      this.logger.log('Fetch completed successfully');
    } catch (error: unknown) {
      const err = error as Error;
      this.logger.error(`Failed to fetch: ${err.message}`);
      throw error;
    }
  }

  /**
   * Count commits behind/ahead of remote branch
   */
  async getCommitsDiff(
    remote: string = 'origin',
    branch: string = 'main',
  ): Promise<{ behind: number; ahead: number }> {
    try {
      const ref = `${remote}/${branch}`;
      const verifyResult = await this.execGit(['rev-parse', '--verify', ref]);
      if (verifyResult.exitCode !== 0) {
        this.logger.warn(`Remote ref ${ref} does not exist — cannot compare`);
        return { ahead: 0, behind: 0 };
      }

      const result = await this.execGit(['rev-list', '--left-right', '--count', `HEAD...${ref}`]);

      if (result.exitCode !== 0) {
        throw new Error(`rev-list failed: ${result.stderr}`);
      }

      const parts = result.stdout.split(/\s+/);
      return {
        ahead: parseInt(parts[0]) || 0,
        behind: parseInt(parts[1]) || 0,
      };
    } catch (error: unknown) {
      const err = error as Error;
      this.logger.error(`Failed to get commits diff: ${err.message}`);
      return { ahead: 0, behind: 0 };
    }
  }

  /**
   * Get the latest commit on remote branch
   */
  async getRemoteCommit(remote: string = 'origin', branch: string = 'main'): Promise<string> {
    try {
      const result = await this.execGit(['rev-parse', `${remote}/${branch}`]);
      if (result.exitCode !== 0 || !result.stdout.match(/^[0-9a-f]{40}$/)) {
        throw new Error(
          `Could not resolve ${remote}/${branch}: ${result.stderr || 'not a valid commit hash'}`,
        );
      }
      return result.stdout;
    } catch (error: unknown) {
      const err = error as Error;
      this.logger.error(`Failed to get remote commit: ${err.message}`);
      throw error;
    }
  }

  /**
   * Get remote commit details (message and date)
   */
  async getRemoteCommitDetails(
    remote: string = 'origin',
    branch: string = 'main',
  ): Promise<{ message: string; date: string; author: string } | null> {
    try {
      const hash = await this.getRemoteCommit(remote, branch);
      const result = await this.execGit(['log', '-1', '--format=%s%n%aI%n%an', hash]);
      const lines = result.stdout.split('\n');

      return {
        message: lines[0] || '',
        date: lines[1] || '',
        author: lines[2] || '',
      };
    } catch (error: unknown) {
      const err = error as Error;
      this.logger.error(`Failed to get remote commit details: ${err.message}`);
      return null;
    }
  }

  /**
   * Pull changes with fast-forward only
   */
  async pull(
    remote: string = 'origin',
    branch: string = 'main',
    timeout: number = 300000,
  ): Promise<void> {
    this.logger.log(`Updating to ${remote}/${branch}...`);

    // Try fast-forward merge first
    try {
      const mergeResult = await this.execGit(['merge', '--ff-only', `${remote}/${branch}`], {
        timeout,
      });

      if (mergeResult.exitCode === 0) {
        this.logger.log('Fast-forward merge completed successfully');
        return;
      }
    } catch (mergeError) {
      this.logger.warn('Fast-forward merge failed - will try force reset');
    }

    // If fast-forward fails, force reset to remote
    this.logger.warn('Forcing reset to remote');
    try {
      const resetResult = await this.execGit(['reset', '--hard', `${remote}/${branch}`], {
        timeout,
      });

      if (resetResult.exitCode !== 0) {
        throw new Error(`Git reset failed: ${resetResult.stderr || resetResult.stdout}`);
      }

      this.logger.log('Force reset completed successfully');
    } catch (error: unknown) {
      const err = error as Error;
      this.logger.error(`Failed to reset: ${err.message}`);
      throw error;
    }
  }

  /**
   * Get comprehensive git status
   */
  async getStatus(remote: string = 'origin', branch: string = 'main'): Promise<GitStatus> {
    try {
      const isRepo = await this.isGitRepository();
      if (!isRepo) {
        return {
          isRepository: false,
          hasUncommittedChanges: false,
          commitsBehind: 0,
          commitsAhead: 0,
          upToDate: false,
        };
      }

      const [currentBranch, currentCommit, hasChanges] = await Promise.all([
        this.getCurrentBranch(),
        this.getCurrentCommit(),
        this.hasUncommittedChanges(),
      ]);

      let networkError: string | undefined;
      try {
        await this.fetch(remote, 10000);
      } catch (fetchError: unknown) {
        const err = fetchError as Error;
        networkError = `Unable to connect to remote repository: ${err.message}`;
        this.logger.warn(`Failed to fetch from remote: ${err.message}. Using cached remote refs.`);
      }

      const lastCommit = await this.getCommitInfo(currentCommit);

      let commitsDiff = { behind: 0, ahead: 0 };
      try {
        commitsDiff = await this.getCommitsDiff(remote, branch);
      } catch (diffError: unknown) {
        const err = diffError as Error;
        if (!networkError) {
          networkError = `Unable to compare with remote: ${err.message}`;
        }
        this.logger.warn(`Failed to get commits diff: ${err.message}. Assuming up to date.`);
      }

      return {
        isRepository: true,
        currentBranch,
        hasUncommittedChanges: hasChanges,
        commitsBehind: commitsDiff.behind,
        commitsAhead: commitsDiff.ahead,
        upToDate: commitsDiff.behind === 0 && commitsDiff.ahead === 0,
        lastCommit,
        networkError,
      };
    } catch (error: unknown) {
      const err = error as Error;
      this.logger.error(`Failed to get git status: ${err.message}`);
      throw error;
    }
  }

  /**
   * Get list of commits between two refs
   */
  async getCommitLog(
    fromRef: string,
    toRef: string,
    limit: number = 10,
  ): Promise<
    Array<{
      hash: string;
      message: string;
      date: string;
      author: string;
    }>
  > {
    try {
      const result = await this.execGit([
        'log',
        `${fromRef}..${toRef}`,
        '--format=%H%n%s%n%cI%n%an%n---',
        `-n${limit}`,
      ]);

      const commits = result.stdout.split('---\n').filter((s) => s.trim());
      return commits.map((commit) => {
        const lines = commit.trim().split('\n');
        return {
          hash: lines[0] || '',
          message: lines[1] || 'Unknown',
          date: lines[2] || new Date().toISOString(),
          author: lines[3] || 'Unknown',
        };
      });
    } catch (error: unknown) {
      const err = error as Error;
      this.logger.error(`Failed to get commit log: ${err.message}`);
      return [];
    }
  }

  /**
   * Reset to a specific commit (for rollback)
   */
  async reset(commitHash: string, hard: boolean = true): Promise<void> {
    try {
      const args = ['reset', hard ? '--hard' : '--soft', commitHash];
      this.logger.warn(`Resetting to ${commitHash} (hard: ${hard})...`);

      const result = await this.execGit(args);
      if (result.exitCode !== 0) {
        throw new Error(`Git reset failed: ${result.stderr}`);
      }

      this.logger.log('Reset completed successfully');
    } catch (error: unknown) {
      const err = error as Error;
      this.logger.error(`Failed to reset: ${err.message}`);
      throw error;
    }
  }

  /**
   * Get remote URL
   */
  async getRemoteUrl(remote: string = 'origin'): Promise<string> {
    try {
      const result = await this.execGit(['remote', 'get-url', remote]);
      return result.stdout;
    } catch (error: unknown) {
      const err = error as Error;
      this.logger.error(`Failed to get remote URL: ${err.message}`);
      throw error;
    }
  }

  /**
   * List configured remotes with their URLs
   */
  async listRemotes(): Promise<Array<{ name: string; url: string }>> {
    try {
      const result = await this.execGit(['remote']);
      if (result.exitCode !== 0) {
        throw new Error(`Git remote failed: ${result.stderr}`);
      }

      const names = result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /^[A-Za-z0-9._-]+$/.test(line));

      const remotes: Array<{ name: string; url: string }> = [];
      for (const name of names) {
        const url = await this.getRemoteUrl(name).catch(() => '');
        remotes.push({ name, url });
      }

      return remotes;
    } catch (error: unknown) {
      const err = error as Error;
      this.logger.error(`Failed to list remotes: ${err.message}`);
      return [];
    }
  }

  /**
   * List remote-tracking branches for a remote (as fetched locally)
   */
  async listRemoteBranches(remote: string): Promise<string[]> {
    try {
      const result = await this.execGit([
        'for-each-ref',
        '--format=%(refname:short)',
        `refs/remotes/${remote}`,
      ]);

      if (result.exitCode !== 0) {
        throw new Error(`Git for-each-ref failed: ${result.stderr}`);
      }

      const prefix = `${remote}/`;
      return result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith(prefix))
        .map((line) => line.slice(prefix.length))
        .filter((branch) => branch && branch !== 'HEAD')
        .sort();
    } catch (error: unknown) {
      const err = error as Error;
      this.logger.error(`Failed to list remote branches: ${err.message}`);
      return [];
    }
  }

  /**
   * Check whether a remote-tracking ref exists locally
   */
  async remoteBranchExists(remote: string, branch: string): Promise<boolean> {
    try {
      const result = await this.execGit(['rev-parse', '--verify', `${remote}/${branch}`]);
      return result.exitCode === 0;
    } catch (error: unknown) {
      return false;
    }
  }

  /**
   * Verify remote is the official repository
   */
  async verifyRemote(remote: string = 'origin'): Promise<boolean> {
    try {
      const url = await this.getRemoteUrl(remote);
      const officialRepos = [
        'github.com/TheRealSirHaXalot/AntiHunter-Command-Control-PRO',
        'github.com:TheRealSirHaXalot/AntiHunter-Command-Control-PRO',
      ];

      return officialRepos.some((repo) => url.includes(repo));
    } catch (error: unknown) {
      const err = error as Error;
      this.logger.error(`Failed to verify remote: ${err.message}`);
      return false;
    }
  }
}
