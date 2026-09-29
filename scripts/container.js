'use strict';
// Optional self-hosted entry point. The ordinary app still binds to loopback;
// only this authenticated gateway accepts connections from a container network.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { createHash, timingSafeEqual } = require('node:crypto');

const digest = value => createHash('sha256').update(value).digest();
const HOP_HEADERS = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
function cleanHeaders(original) {
  const headers = { ...original };
  for (const key of [...HOP_HEADERS, ...String(headers.connection || '').toLowerCase().split(',').map(x => x.trim())]) delete headers[key];
  return headers;
}
function credentials(env) {
  const username = env.MUNDUSMAKER_USER || 'dm';
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(username)) throw new Error('MUNDUSMAKER_USER must contain 1–64 letters, numbers, dots, underscores or hyphens.');
  if (!env.MUNDUSMAKER_PASSWORD_FILE) throw new Error('Set MUNDUSMAKER_PASSWORD_FILE to a readable secret file before starting the container.');
  let password;
  try {
    if (fs.statSync(env.MUNDUSMAKER_PASSWORD_FILE).size > 4096) throw new Error('size');
    password = fs.readFileSync(env.MUNDUSMAKER_PASSWORD_FILE, 'utf8').replace(/\r?\n$/, '');
  } catch { throw new Error('Cannot read the container password file. Check its mount and permissions for the container user.'); }
  if (password.trim().length < 16 || /[\r\n\0]/.test(password)) throw new Error('Use a single-line container password of at least 16 characters.');
  return { username, password };
}
function portNumber(value, fallback) {
  const port = Number(value || fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Container ports must be integers from 1 to 65535.');
  return port;
}
function canonicalOrigin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Use an http:// or https:// origin without a path for MUNDUSMAKER_ORIGIN.');
  return url.origin;
}
function createGateway({ username, password, backendPort, origin = '' }) {
  const expected = digest(username + ':' + password);
  const allowedOrigin = origin ? canonicalOrigin(origin) : '';
  return http.createServer((req, res) => {
    function fail(status, message, challenge = false) {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
        ...(challenge ? { 'WWW-Authenticate': 'Basic realm="MundusMaker DM", charset="UTF-8"' } : {}) });
      res.end(message + '\n');
    }
    const auth = String(req.headers.authorization || '');
    const token = /^Basic ([A-Za-z0-9+/]+=*)$/i.exec(auth);
    if (!token || !timingSafeEqual(digest(Buffer.from(token[1], 'base64')), expected)) return fail(401, 'Sign in with your MundusMaker DM credentials.', true);
    if (!req.url.startsWith('/') || req.url.startsWith('//')) return fail(400, 'Invalid request path.');
    // Browser credentials must not authorize a different site's fetch or form.
    // Non-browser clients may omit Origin, but still need the same password.
    if (req.headers['sec-fetch-site'] === 'cross-site') return fail(403, 'Open MundusMaker directly before making this request.');
    if (req.headers.origin) {
      try {
        const incoming = canonicalOrigin(req.headers.origin);
        const host = String(req.headers.host || '').toLowerCase();
        if (allowedOrigin ? incoming !== allowedOrigin : new URL(incoming).host !== host) throw new Error('origin');
      } catch { return fail(403, 'This request must come from your MundusMaker page.'); }
    }
    const headers = cleanHeaders(req.headers);
    for (const key of Object.keys(headers)) if (key === 'authorization' || key === 'forwarded' || key.startsWith('x-forwarded-')) delete headers[key];
    headers.host = `localhost:${backendPort}`;
    // Only after the public origin check: the backend's request guard (server.js
    // guardRequest) sees this trusted local hop as its own page, while its
    // Sec-Fetch-Site and JSON-only checks still run on the forwarded headers.
    if (headers.origin) headers.origin = `http://localhost:${backendPort}`;
    const upstream = http.request({ hostname: '127.0.0.1', port: backendPort, path: req.url, method: req.method, headers }, response => {
      const responseHeaders = cleanHeaders(response.headers);
      res.writeHead(response.statusCode, { ...responseHeaders, 'cache-control': 'no-store',
        'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin' });
      response.on('error', () => res.destroy());
      response.pipe(res);
    });
    upstream.setTimeout(15 * 60 * 1000, () => upstream.destroy(new Error('timeout')));
    upstream.on('error', () => { if (!res.headersSent) fail(502, 'MundusMaker is unavailable. Check the container startup log.'); else res.destroy(); });
    req.on('aborted', () => upstream.destroy());
    req.on('error', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
}

async function startContainer({ env = process.env, host = '0.0.0.0' } = {}) {
  const auth = credentials(env); // Fail before spawning or exposing anything.
  const port = portNumber(env.PORT, 4870);
  const backendPort = portNumber(env.MUNDUSMAKER_BACKEND_PORT, 4871);
  if (port === backendPort) throw new Error('The public and internal container ports must differ.');
  if (!env.MUNDUSMAKER_DATA || !path.isAbsolute(env.MUNDUSMAKER_DATA)) throw new Error('MUNDUSMAKER_DATA must name the absolute path of a persistent volume (normally /data).');
  const data = path.resolve(env.MUNDUSMAKER_DATA);
  const gateway = createGateway({ ...auth, backendPort, origin: env.MUNDUSMAKER_ORIGIN });
  const child = fork(path.join(__dirname, '../server.js'), [data, String(backendPort), '--no-open'], {
    env: { ...env, MUNDUSMAKER_CONTAINER: '1', MUNDUSMAKER_CONFIG_DIR: path.join(data, '.config') },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true,
  });
  let stopping = false, killTimer;
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const stop = () => {
    if (!stopping) {
      stopping = true;
      gateway.close();
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 10000);
      killTimer.unref();
    }
    return closed;
  };
  child.once('exit', () => {
    clearTimeout(killTimer);
    gateway.close(); gateway.closeAllConnections();
    resolveClosed(stopping ? 0 : 1);
  });
  child.once('error', () => { gateway.close(); resolveClosed(1); });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The local server did not become ready within 30 seconds.')), 30000);
      const onExit = () => { clearTimeout(timer); reject(new Error('The local server stopped during container startup. Check the log above.')); };
      child.once('exit', onExit);
      child.once('error', err => { clearTimeout(timer); reject(err); });
      child.once('message', message => {
        clearTimeout(timer);
        if (message?.type !== 'mundusmaker-ready' || message.port !== backendPort) return reject(new Error('Unexpected local server startup response.'));
        child.removeListener('exit', onExit); resolve();
      });
    });
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('The local server stopped during container startup.');
    await new Promise((resolve, reject) => { gateway.once('error', reject); gateway.listen(port, host, resolve); });
  } catch (err) {
    await stop();
    throw err;
  }
  return { gateway, child, stop, closed, port };
}

async function healthcheck(env = process.env) {
  const { username, password } = credentials(env);
  await new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: portNumber(env.PORT, 4870), path: '/api/status',
      headers: { Authorization: 'Basic ' + Buffer.from(username + ':' + password).toString('base64') } }, res => {
      res.resume(); res.on('end', () => res.statusCode === 200 ? resolve() : reject(new Error('Container health check failed.')));
      res.on('error', reject);
    });
    req.setTimeout(3000, () => req.destroy(new Error('Container health check timed out.'))); req.on('error', reject);
  });
}
if (require.main === module) (async () => {
  if (process.argv.includes('--healthcheck')) return healthcheck();
  const app = await startContainer();
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, app.stop);
  console.log(`[mundusmaker] authenticated container gateway ready on port ${app.port}; data is stored in the mounted volume.`);
  const code = await app.closed;
  if (code) console.error('[mundusmaker] local server stopped unexpectedly; closing the container gateway.');
  process.exitCode = code;
})().catch(err => { console.error('[mundusmaker] ' + err.message); process.exitCode = 1; });
module.exports = { credentials, createGateway, startContainer, healthcheck };
