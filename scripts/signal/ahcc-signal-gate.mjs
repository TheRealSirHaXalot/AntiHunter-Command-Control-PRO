import { createConnection } from 'node:net';
import { userInfo } from 'node:os';

const SOCKET = '/run/ahcc-signal/socket';
const SERVICE_USER = 'ahcc-signal';
const GROUP_ID = /^[A-Za-z0-9+/]{20,100}={0,2}$/;
const MAX_MESSAGE = 4000;
const MAX_REQUEST = 32 * 1024;

function reply(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function finish(value, code = 0) {
  reply(value);
  process.exitCode = code;
  setImmediate(() => process.exit(code));
}

function fail(message, code = 1) {
  finish({ ok: false, error: message }, code);
}

function rpc(method, params, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(SOCKET);
    const id = 1;
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', method, params, id })}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id !== id) {
          continue;
        }
        clearTimeout(timer);
        socket.end();
        if (message.error) {
          reject(new Error(message.error.message || 'signal-cli error'));
        } else {
          resolve(message.result);
        }
        return;
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function account() {
  const accounts = await rpc('listAccounts');
  const first = Array.isArray(accounts) ? accounts.find((a) => typeof a?.number === 'string') : null;
  if (!first) {
    throw new Error('no linked account');
  }
  return first.number;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
      if (data.length > MAX_REQUEST) {
        reject(new Error('request too large'));
        return;
      }
      const newline = data.indexOf('\n');
      if (newline >= 0) {
        process.stdin.pause();
        resolve(data.slice(0, newline));
      }
    });
    process.stdin.on('end', () => resolve(data));
  });
}

async function handle(request) {
  const keys = Object.keys(request).sort().join(',');
  switch (request.op) {
    case 'status': {
      if (keys !== 'op') throw new Error('unexpected fields');
      const accounts = await rpc('listAccounts');
      const numbers = Array.isArray(accounts)
        ? accounts.map((a) => a?.number).filter((n) => typeof n === 'string')
        : [];
      return finish({ ok: true, accounts: numbers });
    }
    case 'link': {
      if (keys !== 'op') throw new Error('unexpected fields');
      const started = await rpc('startLink');
      const uri = started?.deviceLinkUri;
      if (typeof uri !== 'string' || !uri.startsWith('sgnl://linkdevice?')) {
        throw new Error('signal-cli returned no link URI');
      }
      reply({ ok: true, uri });
      const finished = await rpc('finishLink', { deviceLinkUri: uri, deviceName: 'AntiHunter' }, 300_000);
      return finish({ ok: true, linked: finished?.number ?? true });
    }
    case 'create-group': {
      if (keys !== 'op') throw new Error('unexpected fields');
      const result = await rpc('updateGroup', {
        account: await account(),
        name: 'AntiHunter Alerts',
        setPermissionAddMember: 'only-admins',
        setPermissionEditDetails: 'only-admins',
        link: 'disabled',
      });
      if (typeof result?.groupId !== 'string' || !GROUP_ID.test(result.groupId)) {
        throw new Error('signal-cli returned no group id');
      }
      return finish({ ok: true, groupId: result.groupId });
    }
    case 'send': {
      if (keys !== 'groupId,message,op') throw new Error('unexpected fields');
      if (typeof request.groupId !== 'string' || !GROUP_ID.test(request.groupId)) {
        throw new Error('invalid group id');
      }
      if (typeof request.message !== 'string' || !request.message.trim()) {
        throw new Error('empty message');
      }
      await rpc('send', {
        account: await account(),
        groupId: request.groupId,
        message: request.message.slice(0, MAX_MESSAGE),
      });
      return finish({ ok: true });
    }
    default:
      throw new Error('unknown op');
  }
}

async function main() {
  if (userInfo().username !== SERVICE_USER) {
    throw new Error(`must run as ${SERVICE_USER}`);
  }
  const line = await readStdin();
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    throw new Error('request is not JSON');
  }
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('request must be an object');
  }
  await handle(request);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
