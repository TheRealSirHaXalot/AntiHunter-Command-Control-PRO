#!/usr/bin/env node
/**
 * Database Reset Script
 *
 * This script performs a complete database reset:
 * 1. Drops the existing database
 * 2. Creates a fresh database
 * 3. Sets up proper permissions
 * 4. Generates Prisma client
 * 5. Pushes schema directly from schema.prisma (bypasses migrations)
 * 6. Seeds the database
 *
 * This is a nuclear option that gives you a clean slate based on your schema.
 */

import { spawn } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import readline from 'readline';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const backendDir = path.join(repoRoot, 'apps', 'backend');

// Parse DATABASE_URL from .env file
function parseDatabaseUrl() {
  // Check root .env first, then apps/backend/.env
  const envPaths = [
    { path: path.join(repoRoot, '.env'), label: 'root' },
    { path: path.join(backendDir, '.env'), label: 'apps/backend' },
  ];

  for (const { path: envPath, label } of envPaths) {
    try {
      const envContent = readFileSync(envPath, 'utf-8');
      const match = envContent.match(/DATABASE_URL="?([^"\n]+)"?/);
      if (!match) {
        continue; // Try next location
      }

      const url = match[1];
      // Parse postgresql://user:password@host:port/database
      const urlMatch = url.match(/postgresql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)/);
      if (!urlMatch) {
        continue; // Try next location
      }

      return {
        user: urlMatch[1],
        password: urlMatch[2],
        host: urlMatch[3],
        port: urlMatch[4],
        database: urlMatch[5],
        source: envPath, // Remember where we found it
        sourceLabel: label,
      };
    } catch (error) {
      // File doesn't exist or can't be read, try next location
      continue;
    }
  }

  return null;
}

// Interactive prompts
function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function promptForCredentials(defaults = null) {
  console.log('\nDatabase Configuration');
  console.log('==================================================\n');

  const user = await prompt(`Database user [${defaults?.user || 'postgres'}]: `) || defaults?.user || 'postgres';
  const password = await prompt(`Database password [${defaults?.password || ''}]: `) || defaults?.password || '';
  const host = await prompt(`Database host [${defaults?.host || 'localhost'}]: `) || defaults?.host || 'localhost';
  const port = await prompt(`Database port [${defaults?.port || '5432'}]: `) || defaults?.port || '5432';
  const database = await prompt(`Database name [${defaults?.database || 'command_center'}]: `) || defaults?.database || 'command_center';

  return { user, password, host, port, database };
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    console.log(`\n→ ${command} ${args.join(' ')}`);

    const child = spawn(command, args, {
      stdio: options.silent ? 'pipe' : 'inherit',
      shell: true,
      ...options,
    });

    let stdout = '';
    let stderr = '';

    if (options.silent) {
      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });
      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });
    }

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve({ code, stdout, stderr });
      } else {
        const error = new Error(`Command failed with exit code ${code}`);
        error.code = code;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

async function runPsqlAsAdmin(command) {
  // Try to run as postgres user (typical for Linux)
  // On macOS, the current user usually has superuser privileges
  const isMac = process.platform === 'darwin';

  if (isMac) {
    // On macOS, just run psql directly as current user
    return runCommand('psql', ['-c', command, 'postgres']);
  } else {
    // On Linux, use sudo to switch to postgres user
    return runCommand('sudo', ['-u', 'postgres', 'psql', '-c', command]);
  }
}

async function runPsqlAsAdminOnDb(db, command) {
  const isMac = process.platform === 'darwin';

  if (isMac) {
    return runCommand('psql', ['-d', db.database, '-c', command]);
  } else {
    return runCommand('sudo', ['-u', 'postgres', 'psql', '-d', db.database, '-c', command]);
  }
}

async function runPrisma(args, db) {
  // Construct the DATABASE_URL for this connection
  const databaseUrl = `postgresql://${db.user}:${db.password}@${db.host}:${db.port}/${db.database}`;

  return runCommand('pnpm', [
    '--filter',
    '@command-center/backend',
    'exec',
    '--',
    'prisma',
    ...args,
  ], {
    cwd: backendDir,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
    },
  });
}

function updateEnvFile(db, targetEnvPath) {
  // Use the provided path, or default to root .env
  const envPath = targetEnvPath || path.join(repoRoot, '.env');

  try {
    let envContent = '';
    try {
      envContent = readFileSync(envPath, 'utf-8');
    } catch (readError) {
      // File doesn't exist, will create it
    }

    const databaseUrl = `postgresql://${db.user}:${db.password}@${db.host}:${db.port}/${db.database}`;

    // Update or add DATABASE_URL
    if (envContent.match(/DATABASE_URL=/)) {
      envContent = envContent.replace(
        /DATABASE_URL="?[^"\n]+"?/,
        `DATABASE_URL="${databaseUrl}"`
      );
    } else {
      envContent = `DATABASE_URL="${databaseUrl}"\n${envContent}`;
    }

    writeFileSync(envPath, envContent, 'utf-8');
    console.log(`[OK] Updated ${envPath.replace(repoRoot + '/', '')} with new DATABASE_URL`);
  } catch (error) {
    console.warn('[WARNING] Could not update .env file:', error.message);
  }
}

async function main() {
  console.log('============================================================');
  console.log('   AntiHunter Command Center :: Database Reset');
  console.log('   WARNING: This will DELETE all database data');
  console.log('============================================================');

  // Check for command line flag to skip .env
  const useInteractive = process.argv.includes('--interactive') || process.argv.includes('-i');

  let db = null;
  if (!useInteractive) {
    db = parseDatabaseUrl();
  }

  if (!db) {
    if (!useInteractive) {
      console.log('\nWARNING: Could not parse DATABASE_URL from .env files');
      console.log('  Checked: .env and apps/backend/.env');
    }
    db = await promptForCredentials();
  } else {
    console.log(`\nLoaded database configuration from ${db.sourceLabel}/.env`);
    const override = await prompt('\nUse different credentials? [y/N]: ');
    if (override.toLowerCase() === 'y' || override.toLowerCase() === 'yes') {
      db = await promptForCredentials(db);
    }
  }

  console.log('\nDatabase Configuration:');
  console.log(`   Database: ${db.database}`);
  console.log(`   User: ${db.user}`);
  console.log(`   Host: ${db.host}:${db.port}`);

  const confirm = await prompt('\nWARNING: Proceed with database reset? This will DELETE ALL DATA! [y/N]: ');
  if (confirm.toLowerCase() !== 'y' && confirm.toLowerCase() !== 'yes') {
    console.log('\nDatabase reset cancelled');
    process.exit(0);
  }

  // Update .env if credentials were changed
  const originalDb = parseDatabaseUrl();
  const credentialsChanged = !originalDb ||
    originalDb.user !== db.user ||
    originalDb.password !== db.password ||
    originalDb.host !== db.host ||
    originalDb.port !== db.port ||
    originalDb.database !== db.database;

  if (credentialsChanged) {
    const targetFile = db.source || originalDb?.source || path.join(repoRoot, '.env');
    const updateEnv = await prompt('\nUpdate .env file with these credentials? [Y/n]: ');
    if (updateEnv.toLowerCase() !== 'n' && updateEnv.toLowerCase() !== 'no') {
      updateEnvFile(db, targetFile);
    }
  }

  try {
    // Step 1: Drop existing database
    console.log('\n[1/6] Dropping existing database...');
    try {
      await runPsqlAsAdmin(`DROP DATABASE IF EXISTS ${db.database};`);
      console.log('[OK] Database dropped');
    } catch (error) {
      if (error.stderr?.includes('does not exist')) {
        console.log('[OK] Database does not exist (skipping)');
      } else {
        throw error;
      }
    }

    // Step 2: Create fresh database
    console.log('\n[2/6] Creating fresh database...');
    await runPsqlAsAdmin(`CREATE DATABASE ${db.database};`);
    console.log('[OK] Database created');

    // Step 3: Set up permissions
    console.log('\n[3/6] Setting up permissions...');
    await runPsqlAsAdminOnDb(db, `GRANT ALL PRIVILEGES ON DATABASE ${db.database} TO ${db.user};`);
    await runPsqlAsAdminOnDb(db, `GRANT ALL PRIVILEGES ON SCHEMA public TO ${db.user};`);
    await runPsqlAsAdminOnDb(db, `GRANT CREATE ON SCHEMA public TO ${db.user};`);
    await runPsqlAsAdminOnDb(db, `ALTER SCHEMA public OWNER TO ${db.user};`);
    console.log('[OK] Permissions configured');

    // Step 4: Generate Prisma client
    console.log('\n[4/6] Generating Prisma client...');
    await runPrisma(['generate'], db);
    console.log('[OK] Prisma client generated');

    // Step 5: Push schema (creates tables directly from schema.prisma)
    console.log('\n[5/6] Pushing schema to database...');
    await runPrisma(['db', 'push', '--accept-data-loss'], db);
    console.log('[OK] Schema pushed to database');

    // Step 6: Seed database
    console.log('\n[6/6] Seeding database...');
    await runPrisma(['db', 'seed'], db);
    console.log('[OK] Database seeded');

    // Verify tables were created
    console.log('\n[VERIFY] Checking tables...');
    const result = await runCommand('psql', [
      `postgresql://${db.user}:${db.password}@${db.host}:${db.port}/${db.database}`,
      '-c',
      '\\dt',
    ], { silent: true });

    const tableCount = (result.stdout.match(/public \|/g) || []).length;
    console.log(`[OK] Found ${tableCount} tables in database`);

    console.log('\n============================================================');
    console.log('   Database reset complete!');
    console.log('============================================================\n');

  } catch (error) {
    console.error('\n============================================================');
    console.error('   Database reset failed');
    console.error('============================================================\n');
    console.error('Error:', error.message);

    if (error.stdout) {
      console.error('\nStdout:', error.stdout);
    }
    if (error.stderr) {
      console.error('\nStderr:', error.stderr);
    }

    console.log('\nTroubleshooting tips:');
    console.log('  • Ensure PostgreSQL is running');
    console.log('  • Check that the database user has sufficient privileges');
    console.log('  • Verify DATABASE_URL in .env is correct');
    console.log('  • Make sure no other processes are connected to the database');

    process.exitCode = 1;
  }
}

main();
