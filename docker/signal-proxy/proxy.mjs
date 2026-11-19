import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';

const TOKEN = process.env.SIGNAL_PROXY_TOKEN?.trim() || '';
const TOKEN_DIGEST = TOKEN ? createHash('sha256').update(TOKEN).digest() : null;
const SEND_LIMIT = Number(process.env.SIGNAL_SEND_PER_MINUTE) || 20;
let sendWindowStart = 0;
let sendsInWindow = 0;

function authorized(req) {
  if (!TOKEN_DIGEST) {
    return true;
  }
  const header = req.headers.authorization || '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  return timingSafeEqual(createHash('sha256').update(presented).digest(), TOKEN_DIGEST);
}

function sendAllowed() {
  const now = Date.now();
  if (now - sendWindowStart >= 60_000) {
    sendWindowStart = now;
    sendsInWindow = 0;
  }
  sendsInWindow += 1;
  return sendsInWindow <= SEND_LIMIT;
}

const UPSTREAM = new URL(process.env.SIGNAL_UPSTREAM || 'http://signal-api:8080');
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.BIND || '0.0.0.0';
const MAX_BODY = 64 * 1024;
const NUMBER = /^\+[1-9]\d{5,14}$/;
const GROUP_ID = /^group\.[A-Za-z0-9+/=_-]{1,256}$/;

function parse(body) {
  try {
    const value = JSON.parse(body || '');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function pathNumber(path, prefix) {
  if (!path.startsWith(prefix)) {
    return null;
  }
  let number;
  try {
    number = decodeURIComponent(path.slice(prefix.length));
  } catch {
    return null;
  }
  return NUMBER.test(number) ? number : null;
}

function rewrite(method, rawPath, body) {
  const [path, query = ''] = rawPath.split('?');
  if (method === 'GET') {
    if ((path === '/v1/about' || path === '/v1/accounts') && !query) {
      return { path };
    }
    if (path === '/v1/qrcodelink' && /^device_name=[A-Za-z0-9_-]{1,32}$/.test(query)) {
      return { path: rawPath };
    }
    return null;
  }
  if (method !== 'POST') {
    return null;
  }
  const number = pathNumber(path, '/v1/groups/');
  if (number) {
    const parsed = parse(body);
    if (
      !parsed ||
      typeof parsed.name !== 'string' ||
      !/^[\w .-]{1,64}$/.test(parsed.name) ||
      !Array.isArray(parsed.members) ||
      parsed.members.length !== 1 ||
      parsed.members[0] !== number
    ) {
      return null;
    }
    return {
      path,
      body: JSON.stringify({
        name: parsed.name,
        members: [number],
        permissions: {
          add_members: 'only-admins',
          edit_group: 'only-admins',
          send_messages: 'only-admins',
        },
        group_link: 'disabled',
      }),
    };
  }
  if (path === '/v2/send' && !query) {
    const parsed = parse(body);
    if (
      !parsed ||
      typeof parsed.message !== 'string' ||
      typeof parsed.number !== 'string' ||
      !NUMBER.test(parsed.number) ||
      !Array.isArray(parsed.recipients) ||
      parsed.recipients.length !== 1 ||
      typeof parsed.recipients[0] !== 'string' ||
      !GROUP_ID.test(parsed.recipients[0])
    ) {
      return null;
    }
    return {
      path,
      body: JSON.stringify({
        message: parsed.message.slice(0, 4000),
        number: parsed.number,
        recipients: [parsed.recipients[0]],
      }),
    };
  }
  return null;
}

function deny(res, status, error) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error }));
}

createServer((req, res) => {
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  req.on('data', (c) => {
    if (tooLarge) {
      return;
    }
    size += c.length;
    if (size > MAX_BODY) {
      tooLarge = true;
      chunks.length = 0;
      res.writeHead(413, { 'content-type': 'application/json', connection: 'close' });
      res.end('{"error":"request too large"}', () => req.destroy());
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (tooLarge) {
      return;
    }
    const allowed = rewrite(req.method, req.url || '/', Buffer.concat(chunks).toString('utf8'));
    if (!authorized(req)) {
      deny(res, 401, 'signal-proxy token required');
      return;
    }
    if (!allowed) {
      deny(res, 403, 'blocked by AntiHunter signal-proxy');
      return;
    }
    if (allowed.path === '/v2/send' && !sendAllowed()) {
      deny(res, 429, 'signal-proxy send rate limit');
      return;
    }
    const headers = { host: UPSTREAM.host };
    if (allowed.body !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(allowed.body);
    }
    const upstream = httpRequest(
      {
        hostname: UPSTREAM.hostname,
        port: UPSTREAM.port,
        path: allowed.path,
        method: req.method,
        headers,
        timeout: 90_000,
      },
      (up) => {
        res.writeHead(up.statusCode || 502, {
          'content-type': up.headers['content-type'] || 'application/octet-stream',
        });
        up.pipe(res);
      },
    );
    upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
    upstream.on('error', () => {
      if (!res.headersSent) {
        deny(res, 502, 'signal upstream unreachable');
      } else {
        res.destroy();
      }
    });
    upstream.end(allowed.body);
  });
}).listen(PORT, HOST, () => {
  process.stdout.write(`signal-proxy on ${HOST}:${PORT} -> ${UPSTREAM.origin}\n`);
});
