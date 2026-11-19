#!/usr/bin/env node
import { spawn, spawnSync } from 'child_process';
import {
  readdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
  openSync,
  closeSync,
} from 'fs';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import path from 'path';
import { createInterface } from 'readline/promises';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const backendDir = path.join(repoRoot, 'apps', 'backend');
const prismaSchemaPath = 'prisma/schema.prisma';
const migrationDir = path.join(backendDir, 'prisma', 'migrations');

let migrations = [];
try {
  migrations = readdirSync(migrationDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
} catch (error) {
  console.warn('Unable to read migrations directory:', error.message);
}

const pnpmPrefix = ['--filter', '@command-center/backend', 'exec', '--', 'prisma'];
const isWindows = process.platform === 'win32';

function prismaCommand(args) {
  const override = process.env.AHCC_PRISMA_CMD?.trim();
  if (override) {
    const [command, ...prefix] = override.split(/\s+/);
    return [command, [...prefix, ...args]];
  }
  return ['pnpm', [...pnpmPrefix, ...args]];
}

async function runPrisma(args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const [command, commandArgs] = prismaCommand(args);
    const child = spawn(command, commandArgs, {
      cwd: backendDir,
      shell: isWindows,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });

    if (!capture) {
      child.on('exit', (code) => {
        code === 0 ? resolve({ code }) : reject(new Error(`Command failed with code ${code}`));
      });
      child.on('error', reject);
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      const error = new Error(stderr || stdout || `Command failed with code ${code}`);
      error.stdout = stdout;
      error.stderr = stderr;
      code === 0 ? resolve({ stdout, stderr, code }) : reject(error);
    });
  });
}

function analyzeStatus(output) {
  const text = output.toLowerCase();
  if (text.includes('database schema is up to date')) {
    return 'upToDate';
  }
  if (
    text.includes('have not yet been applied') ||
    text.includes('pending') ||
    text.includes('need to be applied')
  ) {
    return 'pending';
  }
  if (text.includes('database schema is not empty') && text.includes('baseline')) {
    return 'needsBaseline';
  }
  if (text.includes('drift detected')) {
    return 'drift';
  }
  return 'unknown';
}

async function getStatus() {
  try {
    const result = await runPrisma(['migrate', 'status', '--schema', prismaSchemaPath], {
      capture: true,
    });
    const output = (result.stdout ?? '') + (result.stderr ?? '');
    return { raw: output, state: analyzeStatus(output) };
  } catch (error) {
    const output = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n');
    const state = analyzeStatus(output);
    if (state === 'pending' || state === 'needsBaseline') {
      return { raw: output, state };
    }
    throw error;
  }
}

function extractFailedMigrations(output) {
  const migrations = new Set();
  const regex = /The `([^`]+)` migration.*failed/gi;
  let match;
  while ((match = regex.exec(output)) !== null) {
    migrations.add(match[1]);
  }
  const p3018 = output.match(/Migration name: ([^\n]+)/i);
  if (p3018) migrations.add(p3018[1].trim());
  return Array.from(migrations);
}

function findDuplicateTableCreates() {
  const tableMap = new Map();

  for (const migration of migrations) {
    const sqlPath = path.join(migrationDir, migration, 'migration.sql');
    if (!existsSync(sqlPath)) continue;

    const content = readFileSync(sqlPath, 'utf8');
    const regex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([A-Za-z0-9_]+)["`]?/gi;
    let match;

    while ((match = regex.exec(content)) !== null) {
      const table = match[1].toLowerCase();
      if (!tableMap.has(table)) {
        tableMap.set(table, []);
      }
      tableMap.get(table).push(migration);
    }
  }

  return Array.from(tableMap.entries())
    .map(([table, list]) => ({ table, migrations: list.sort() }))
    .filter((entry) => entry.migrations.length > 1);
}

async function resolveDuplicates() {
  const duplicates = findDuplicateTableCreates();
  if (duplicates.length === 0) return false;

  let actuallyResolved = 0;

  const existingTables = new Set(
    (
      await withPrisma((prisma) =>
        prisma.$queryRawUnsafe(
          "SELECT lower(table_name) AS name FROM information_schema.tables WHERE table_schema = current_schema()",
        ),
      )
    ).map((row) => row.name),
  );

  for (const entry of duplicates) {
    if (!existingTables.has(entry.table)) {
      continue;
    }
    const [primary, ...redundant] = entry.migrations;

    for (const migration of redundant) {
      try {
        await runPrisma(
          ['migrate', 'resolve', '--applied', migration, '--schema', prismaSchemaPath],
          { capture: true },
        );
        if (actuallyResolved === 0) {
          console.log('Resolving duplicate CREATE TABLE statements:\n');
        }
        console.log(`  Table ${entry.table}: marked ${migration} as applied`);
        actuallyResolved++;
      } catch (error) {
        const output = [error.stderr, error.stdout].filter(Boolean).join('\n');
        if (
          !output.includes('already been recorded') &&
          !output.includes('already recorded as applied')
        ) {
          throw error;
        }
      }
    }
  }

  if (actuallyResolved > 0) {
    console.log();
  }

  return actuallyResolved > 0;
}

async function baselineAllMigrations() {
  if (migrations.length === 0) {
    console.log('No migrations found to baseline');
    return;
  }

  console.log('Existing schema detected without migration history\n');
  console.log('Marking migrations as applied:\n');

  for (const name of migrations) {
    try {
      await runPrisma(['migrate', 'resolve', '--applied', name, '--schema', prismaSchemaPath], {
        capture: true,
      });
      console.log(`  ${name}`);
    } catch (error) {
      const output = [error.stderr, error.stdout].filter(Boolean).join('\n');
      if (output.includes('already applied') || output.includes('already been recorded')) {
        continue;
      }
      throw error;
    }
  }
  console.log();
}

async function markAsApplied(migrationName) {
  try {
    await runPrisma(
      ['migrate', 'resolve', '--applied', migrationName, '--schema', prismaSchemaPath],
      { capture: true },
    );
    return true;
  } catch (err) {
    const output = [err.stderr, err.stdout].filter(Boolean).join('\n');
    return output.includes('already been recorded');
  }
}

async function attemptDeploy() {
  try {
    await runPrisma(['migrate', 'deploy', '--schema', prismaSchemaPath], { capture: true });
    return { success: true };
  } catch (error) {
    const fullOutput = [error.stderr, error.stdout, error.message].filter(Boolean).join('\n');
    const failed = extractFailedMigrations(fullOutput);
    return failed.length > 0 ? { success: false, failedMigrations: failed } : Promise.reject(error);
  }
}

function handleDrift(statusOutput) {
  console.error('\nDrift detected: database schema differs from prisma/schema.prisma\n');
  console.error('Review the output and reconcile manually:\n');
  console.error(statusOutput);
  console.log('\nSuggested commands:');
  console.log('  pnpm --filter @command-center/backend exec -- prisma migrate diff \\');
  console.log('    --from-config-datasource --to-schema prisma/schema.prisma --script');
  console.log(
    '  pnpm --filter @command-center/backend exec -- prisma migrate resolve --applied <migration>',
  );
  console.log('\nAfter reconciling, rerun pnpm update-db');
}

const MISMATCH_ACTIONS = ['repair', 'backup-repair', 'ignore', 'abort'];

async function withPrisma(fn) {
  const previousCwd = process.cwd();
  process.chdir(backendDir);
  const backendRequire = createRequire(path.join(backendDir, 'package.json'));
  backendRequire('dotenv').config({ path: path.join(backendDir, '.env'), quiet: true });
  const { PrismaClient } = backendRequire('@prisma/client');
  const { PrismaPg } = backendRequire('@prisma/adapter-pg');
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  try {
    return await fn(prisma);
  } finally {
    await prisma.$disconnect();
    process.chdir(previousCwd);
  }
}

async function unknownAppliedMigrations() {
  const rows = await withPrisma((prisma) =>
    prisma.$queryRawUnsafe(
      'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
    ),
  );
  const local = new Set(migrations);
  return rows.map((row) => row.migration_name).filter((name) => !local.has(name));
}

async function schemaDiffSql() {
  const args = [
    'migrate',
    'diff',
    '--from-config-datasource',
    '--to-schema',
    prismaSchemaPath,
    '--script',
  ];
  const { stdout } = await runPrisma(args, { capture: true });
  const statements = stdout
    .split('\n')
    .filter((line) => line.trim() && !line.trim().startsWith('--'));
  return statements.length ? stdout : '';
}

function summarizeDiff(sql) {
  const removes = [];
  const adds = [];
  for (const line of sql.split('\n')) {
    const text = line.trim();
    const dropTable = text.match(/^DROP TABLE "([^"]+)"/i);
    const dropColumn = text.match(/^ALTER TABLE "([^"]+)" DROP COLUMN "([^"]+)"/i);
    const createTable = text.match(/^CREATE TABLE "([^"]+)"/i);
    const addColumn = text.match(/^ALTER TABLE "([^"]+)" ADD COLUMN\s+"([^"]+)"/i);
    if (dropTable) removes.push(`table ${dropTable[1]}`);
    if (dropColumn) removes.push(`column ${dropColumn[1]}.${dropColumn[2]}`);
    if (createTable) adds.push(`table ${createTable[1]}`);
    if (addColumn) adds.push(`column ${addColumn[1]}.${addColumn[2]}`);
  }
  return { removes, adds };
}

function databaseUrl() {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }
  const envPath = path.join(backendDir, '.env');
  if (!existsSync(envPath)) {
    return null;
  }
  const line = readFileSync(envPath, 'utf8')
    .split('\n')
    .find((entry) => entry.trim().startsWith('DATABASE_URL='));
  return line ? line.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '') : null;
}

function backupDatabase() {
  const url = databaseUrl();
  if (!url) {
    console.error('Backup failed: DATABASE_URL not found in the environment or apps/backend/.env');
    return false;
  }
  if (spawnSync('pg_dump', ['--version'], { stdio: 'ignore' }).status !== 0) {
    console.error('Backup failed: pg_dump is not installed or not on PATH');
    return false;
  }
  const dir = path.join(backendDir, 'backups');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `db-before-repair-${new Date().toISOString().replace(/[:.]/g, '-')}.sql`);
  const target = new URL(url);
  const password = decodeURIComponent(target.password);
  target.password = '';
  const fd = openSync(file, 'w', 0o600);
  const result = spawnSync('pg_dump', [target.toString()], {
    stdio: ['ignore', fd, 'inherit'],
    env: { ...process.env, ...(password ? { PGPASSWORD: password } : {}) },
  });
  closeSync(fd);
  if (result.status !== 0) {
    console.error(`Backup failed: pg_dump exited with ${result.status}`);
    return false;
  }
  console.log(`Backup written to ${file}`);
  return true;
}

async function chooseMismatchAction() {
  const fromEnv = process.env.AHCC_DB_MISMATCH?.trim().toLowerCase();
  if (fromEnv) {
    if (MISMATCH_ACTIONS.includes(fromEnv)) {
      return fromEnv;
    }
    console.error(`AHCC_DB_MISMATCH must be one of: ${MISMATCH_ACTIONS.join(', ')}`);
    return 'abort';
  }
  if (!process.stdin.isTTY) {
    return 'abort';
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('\nChoose how to continue:');
    console.log('  1) Repair: change the database to match this version');
    console.log('  2) Back up with pg_dump, then repair');
    console.log('  3) Leave it as is (features that need the missing parts will fail)');
    console.log('  4) Stop');
    const answer = (await rl.question('Choice [2]: ')).trim() || '2';
    return { 1: 'repair', 2: 'backup-repair', 3: 'ignore', 4: 'abort' }[answer] ?? 'abort';
  } finally {
    rl.close();
  }
}

async function applyRepair(sql, unknown) {
  const file = path.join(tmpdir(), `ahcc-db-repair-${process.pid}.sql`);
  writeFileSync(file, sql, { mode: 0o600 });
  try {
    await runPrisma(['db', 'execute', '--file', file], {
      capture: true,
    });
  } finally {
    unlinkSync(file);
  }
  if (unknown.length) {
    await withPrisma((prisma) =>
      prisma.$executeRawUnsafe(
        `DELETE FROM "_prisma_migrations" WHERE migration_name IN (${unknown
          .map((_, index) => `$${index + 1}`)
          .join(', ')})`,
        ...unknown,
      ),
    );
  }
}

async function verifySchemaMatches() {
  const unknown = await unknownAppliedMigrations();
  const sql = await schemaDiffSql();
  if (!unknown.length && !sql) {
    return true;
  }

  console.error('\nThe database does not match this version of AHCC.');
  if (unknown.length) {
    console.error('\nMigrations applied to this database that this version does not have:');
    unknown.forEach((name) => console.error(`  ${name}`));
    console.error('This usually means the database was used with another branch or a newer release.');
  }
  if (sql) {
    const { removes, adds } = summarizeDiff(sql);
    if (adds.length) {
      console.error('\nMissing from the database (repair adds these):');
      adds.forEach((item) => console.error(`  ${item}`));
    }
    if (removes.length) {
      console.error('\nNot used by this version (repair deletes these and the data in them):');
      removes.forEach((item) => console.error(`  ${item}`));
    }
    console.error('\nFull SQL the repair runs:\n');
    console.error(sql);
  }

  const action = await chooseMismatchAction();
  if (action === 'abort') {
    console.error('\nStopped without changing the database.');
    console.error('To choose without a prompt, set AHCC_DB_MISMATCH to one of:');
    console.error(`  ${MISMATCH_ACTIONS.join(', ')}`);
    return false;
  }
  if (action === 'ignore') {
    console.warn('\nLeaving the database as is.');
    return true;
  }
  if (action === 'backup-repair' && !backupDatabase()) {
    console.error('Repair not run because the backup failed.');
    return false;
  }
  await applyRepair(sql, unknown);
  const remaining = await schemaDiffSql();
  if (remaining) {
    console.error('\nRepair ran but the schema still differs:\n');
    console.error(remaining);
    return false;
  }
  console.log('\nDatabase repaired to match this version');
  return true;
}

async function main() {
  console.log('=== AntiHunter Command Center :: Database Updater ===\n');

  try {
    await runPrisma(['generate'], { capture: true });

    let hadDuplicates = false;
    if (migrations.length > 0) {
      hadDuplicates = await resolveDuplicates();
    }

    const status = await getStatus();

    if (status.state === 'upToDate') {
      if (!(await verifySchemaMatches())) {
        process.exitCode = 1;
        return;
      }
      console.log('Database is up to date');
      return;
    }

    if (status.state === 'drift') {
      handleDrift(status.raw);
      process.exitCode = 1;
      return;
    }

    if (status.state === 'needsBaseline') {
      await baselineAllMigrations();
    }

    let result = await attemptDeploy();
    const processed = new Set();

    while (!result.success && result.failedMigrations) {
      for (const migration of result.failedMigrations) {
        if (processed.has(migration)) continue;

        console.log(`Marking as applied: ${migration}`);
        if (await markAsApplied(migration)) {
          processed.add(migration);
        }
      }

      if (result.failedMigrations.every((m) => processed.has(m))) {
        result = await attemptDeploy();
      } else {
        break;
      }
    }

    if (!result.success) {
      console.error('\nFailed to resolve all migrations');
      console.log('\nManual fix:');
      console.log(`  cd ${backendDir}`);
      console.log('  pnpm prisma migrate status');
      console.log('  pnpm prisma migrate resolve --applied <migration>');
      console.log('  pnpm prisma migrate deploy');
      process.exitCode = 1;
    } else {
      if (!hadDuplicates && processed.size === 0 && status.state !== 'needsBaseline') {
        console.log('Database migrations applied successfully');
      } else {
        console.log('Database migrations applied successfully');
      }
      if (!(await verifySchemaMatches())) {
        process.exitCode = 1;
      }
    }
  } catch (error) {
    console.error('\nDatabase update failed:', error.message);

    if (error.stdout || error.stderr) {
      console.error('\nOutput:');
      console.error(error.stderr || error.stdout);
    }

    console.log('\nIf this happens repeatedly, try:');
    console.log('  pnpm --filter @command-center/backend exec -- prisma migrate deploy');
    console.log('  pnpm --filter @command-center/backend exec -- prisma migrate resolve --help');

    process.exitCode = 1;
  }
}

main();
