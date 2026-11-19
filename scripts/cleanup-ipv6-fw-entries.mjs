#!/usr/bin/env node
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const backendDir = path.join(__dirname, '..', 'apps', 'backend');
const backendRequire = createRequire(path.join(backendDir, 'package.json'));
backendRequire('dotenv').config({ path: path.join(backendDir, '.env'), quiet: true });
const { PrismaClient } = backendRequire('@prisma/client');
const { PrismaPg } = backendRequire('@prisma/adapter-pg');

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

function isValidIPv6(ip) {
  if (ip.includes('.')) return true;
  
  const ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
  
  if (!ipv6Regex.test(ip)) return false;
  
  const doubleColonCount = (ip.match(/::/g) || []).length;
  if (doubleColonCount > 1) return false;
  
  return true;
}

async function removeMalformedIPv6() {
  const allLogs = await prisma.firewallLog.findMany({
    select: { id: true, ip: true }
  });

  const malformed = allLogs.filter(log => !isValidIPv6(log.ip));

  if (malformed.length === 0) {
    console.log('No malformed IPv6 addresses found');
    return;
  }

  const ids = malformed.map(log => log.id);
  const result = await prisma.firewallLog.deleteMany({
    where: { id: { in: ids } }
  });

  console.log(`Deleted ${result.count} malformed IPv6 entries`);
  malformed.forEach(log => console.log(`  - ${log.ip}`));
}

removeMalformedIPv6()
  .catch(console.error)
  .finally(() => prisma.$disconnect());