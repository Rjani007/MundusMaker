#!/usr/bin/env node
'use strict';
/*
 * The reference host for the phone apps' runtime, in Node: everything
 * PROTOCOL.md asks of a native host, so the whole mobile stack (the runtime
 * worker running server.js, relayed requests, synchronous file calls, Save)
 * runs in any desktop browser with DevTools. The Android host must behave the
 * same; when the two disagree, PROTOCOL.md decides.
 *
 *   node mobile/shared/devhost.js [dataDir] [--port N] [--no-session]
 *
 * dataDir defaults to tmp/mobile-data (seeded from sample/ on first start).
 * Open the printed URL: it sets the session cookie and loads the app.
 * --no-session skips the cookie, for the Claude preview pane only, which can
 * open nothing but the bare origin.
 */
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createFsOps } = require('./fsops');

const ROOT = path.join(__dirname, '..', '..');
const RUNTIME_DIR = path.join(__dirname, 'runtime');
const PUBLIC_DIR = path.join(ROOT, 'public');
const APP_ENTRIES = ['server.js', 'package.json', 'public', 'sample', 'scripts'];
const MAX_BODY = 256 * 1024 * 1024;
const MAX_FETCH = 64 * 1024 * 1024;
const POLL_WAIT_MS = 25000;
const NO_WORKER_MS = 20000;
const ANSWER_MS = 15 * 60 * 1000;
// server.js's table, plus .txt so a linked licence file shows instead of downloading
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => argv.includes(name);
  const option = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
  const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--port');
  const dataDir = path.resolve(positional[0] || path.join(ROOT, 'tmp', 'mobile-data'));
  if (path.resolve(dataDir) === path.join(ROOT, 'data')) {
    console.error('[devhost] refusing to serve the repo\'s data/ folder: that is the owner\'s real campaign. Pass a scratch folder.');
    process.exit(2);
  }
  const configDir = `${dataDir}-config`;
  const tmpDir = path.join(os.tmpdir(), `mundusmaker-devhost-${process.pid}`);
  const downloadsDir = path.join(tmpDir, 'downloads');
  for (const d of [dataDir, configDir, tmpDir, downloadsDir]) fs.mkdirSync(d, { recursive: true });
  startHost({
    port: Number(option('--port') || process.env.PORT || 0),
    noSession: flag('--no-session'),
    mounts: {
      '/app': { dir: ROOT, writable: false, only: APP_ENTRIES },
      '/data': { dir: dataDir, writable: true },
      '/config': { dir: configDir, writable: true },
      '/tmp': { dir: tmpDir, writable: true },
    },
    downloadsDir,
  });
}

function startHost({ port, noSession, mounts, downloadsDir, onReady }) {
  const sessionToken = crypto.randomBytes(24).toString('hex');
  const hostKey = crypto.randomBytes(24).toString('hex');
  const ops = createFsOps(mounts);
  const same = (a, b) => typeof a === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  let actualPort = port;

  // ----- the relay -----
  let nextId = 0;
  const queue = []; // requests waiting for a worker
  const polls = []; // worker polls waiting for a request
  const handed = new Map(); // id -> request handed to the current worker
  // the runtime is alive while it calls the host at all (a long bootstrap or a
  // big restore makes file calls without polling), and counts as alive at start
  let lastPoll = Date.now();

  function fail(entry, status, message) {
    clearTimeout(entry.timer);
    handed.delete(entry.id);
    const i = queue.indexOf(entry);
    if (i !== -1) queue.splice(i, 1);
    if (entry.res.writableEnded || entry.res.destroyed) return;
    const body = Buffer.from(JSON.stringify({ error: message }));
    entry.res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
    entry.res.end(body);
  }

  function deliver(entry) {
    while (polls.length) {
      const poll = polls.shift();
      clearTimeout(poll.timer);
      if (poll.res.destroyed || poll.res.writableEnded) continue; // that worker went away
      handed.set(entry.id, entry);
      entry.timer = setTimeout(() => fail(entry, 504, 'MundusMaker took too long to answer.'), ANSWER_MS);
      sendFrame(poll.res, 200, entry.meta, entry.body, corsHeaders());
      return true;
    }
    return false;
  }

  function relay(req, res, body) {
    const id = String(++nextId);
    const headers = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) headers.push([req.rawHeaders[i].toLowerCase(), req.rawHeaders[i + 1]]);
    const entry = { id, res, body, meta: { id, method: req.method, url: req.url, headers }, queuedAt: Date.now() };
    res.on('close', () => { if (!res.writableEnded) { const i = queue.indexOf(entry); if (i !== -1) queue.splice(i, 1); } });
    if (!deliver(entry)) queue.push(entry);
  }

  // a request that waits while no worker polls means the runtime is gone
  setInterval(() => {
    const now = Date.now();
    for (const entry of [...queue]) {
      if (now - entry.queuedAt > NO_WORKER_MS && now - lastPoll > NO_WORKER_MS) fail(entry, 503, 'MundusMaker\'s engine is not running. Reload the app.');
    }
  }, 2000).unref();

  // ----- framing -----
  const frame = (meta, body) => Buffer.concat([Buffer.from(`${JSON.stringify(meta)}\n`), body || Buffer.alloc(0)]);
  const unframe = (buf) => {
    const nl = buf.indexOf(10);
    if (nl === -1) throw Object.assign(new Error('malformed frame'), { status: 400 });
    return { meta: JSON.parse(buf.subarray(0, nl).toString('utf8')), body: buf.subarray(nl + 1) };
  };
  function sendFrame(res, status, meta, body, extra = {}) {
    const bytes = frame(meta, body);
    res.writeHead(status, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length, 'Cache-Control': 'no-store', ...extra });
    res.end(bytes);
  }
  function sendJson(res, status, value, extra = {}) {
    const bytes = Buffer.from(JSON.stringify(value));
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length, 'Cache-Control': 'no-store', ...extra });
    res.end(bytes);
  }
  const corsHeaders = () => ({ 'Access-Control-Allow-Origin': `http://localhost:${actualPort}`, Vary: 'Origin' });

  // ----- the worker's channel (127.0.0.1) -----
  async function hostRoute(req, res, url, body) {
    const cors = corsHeaders();
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Max-Age': '600' });
      return res.end();
    }
    if (!same(url.searchParams.get('k'), hostKey)) return sendJson(res, 403, { error: 'forbidden' }, cors);
    // only the app's own worker: a page elsewhere names its own origin
    if (req.headers.origin !== undefined && req.headers.origin !== `http://localhost:${actualPort}`) return sendJson(res, 403, { error: 'forbidden' }, cors);
    lastPoll = Date.now();
    const route = url.pathname.slice('/__host/'.length);
    if (route === 'next' && req.method === 'GET') {
      lastPoll = Date.now();
      if (queue.length) {
        polls.unshift({ res, timer: null });
        deliver(queue.shift());
        return undefined;
      }
      const poll = { res, timer: null };
      poll.timer = setTimeout(() => {
        const i = polls.indexOf(poll);
        if (i !== -1) polls.splice(i, 1);
        if (!res.writableEnded) { res.writeHead(204, { ...cors, 'Cache-Control': 'no-store' }); res.end(); }
      }, POLL_WAIT_MS);
      res.on('close', () => { const i = polls.indexOf(poll); if (i !== -1) { polls.splice(i, 1); clearTimeout(poll.timer); } });
      polls.push(poll);
      return undefined;
    }
    if (route === 'hello' && req.method === 'POST') {
      // the old worker will answer nothing it held: reads are safe to repeat on
      // the new one, a write may have half-happened, so it fails
      for (const entry of [...handed.values()]) {
        if (entry.meta.method === 'GET' || entry.meta.method === 'HEAD') {
          clearTimeout(entry.timer);
          handed.delete(entry.id);
          queue.unshift(entry);
        } else {
          fail(entry, 503, 'MundusMaker restarted its engine. Try again.');
        }
      }
      lastPoll = Date.now();
      sendJson(res, 200, {}, cors);
      while (queue.length && deliver(queue[0])) queue.shift();
      return undefined;
    }
    if (route === 'respond' && req.method === 'POST') {
      const entry = handed.get(url.searchParams.get('id') || '');
      sendJson(res, 200, {}, cors);
      if (!entry) return undefined; // already timed out, or its worker was replaced
      handed.delete(entry.id);
      clearTimeout(entry.timer);
      if (entry.res.writableEnded || entry.res.destroyed) return undefined;
      const { meta, body: answer } = unframe(body);
      const flat = [];
      for (const [k, v] of meta.headers || []) {
        if (/^(content-length|connection|transfer-encoding|keep-alive)$/i.test(k)) continue;
        flat.push(k, v);
      }
      flat.push('Content-Length', String(entry.meta.method === 'HEAD' ? 0 : answer.length));
      entry.res.writeHead(meta.status || 200, flat);
      entry.res.end(entry.meta.method === 'HEAD' ? undefined : answer);
      return undefined;
    }
    if (route === 'fs' && req.method === 'POST') {
      const op = url.searchParams.get('op') || '';
      let args, data;
      try { ({ meta: args, body: data } = unframe(body)); } catch { return sendJson(res, 400, { code: 'EINVAL', message: 'malformed frame' }, cors); }
      try {
        const result = ops.call(op, args, data);
        if (op === 'read' || op === 'readmany') {
          res.writeHead(200, { ...cors, 'Content-Type': 'application/octet-stream', 'Content-Length': result.length, 'Cache-Control': 'no-store' });
          return res.end(result);
        }
        return sendJson(res, 200, result === undefined ? null : result, cors);
      } catch (err) {
        return sendJson(res, err.code === 'ENOENT' ? 404 : err.code === 'EACCES' || err.code === 'EROFS' ? 403 : 409, { code: err.code || 'EIO', message: err.message }, cors);
      }
    }
    if (route === 'fetch' && req.method === 'POST') {
      try {
        const { meta, body: payload } = unframe(body);
        const answer = await outbound(meta, payload);
        return sendFrame(res, 200, answer.meta, answer.body, cors);
      } catch (err) {
        return sendJson(res, 502, { code: err.code || 'ECONNREFUSED', message: err.message }, cors);
      }
    }
    if (route === 'log' && req.method === 'POST') {
      for (const line of body.toString('utf8').split('\n')) if (line) console.log(`[runtime] ${line}`);
      return sendJson(res, 200, {}, cors);
    }
    if (route === 'exit' && req.method === 'POST') {
      console.log(`[devhost] server.js called process.exit(${url.searchParams.get('code')}); a native host reloads the page here.`);
      return sendJson(res, 200, {}, cors);
    }
    return sendJson(res, 404, { error: 'unknown host route' }, cors);
  }

  async function outbound(meta, payload) {
    let target;
    try { target = new URL(meta.url); } catch { throw Object.assign(new Error('not a URL'), { code: 'EINVAL' }); }
    if (target.protocol !== 'https:') throw Object.assign(new Error('only https requests are allowed'), { code: 'EACCES' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(Number(meta.timeoutMs) || 120000, 300000));
    try {
      const res = await fetch(target.href, {
        method: meta.method || 'GET',
        headers: meta.headers || [],
        body: payload && payload.length && !/^(GET|HEAD)$/i.test(meta.method || 'GET') ? payload : undefined,
        redirect: meta.redirect === 'follow' ? 'follow' : 'manual',
        signal: controller.signal,
      });
      const chunks = [];
      let size = 0;
      if (res.body) {
        for await (const chunk of res.body) {
          size += chunk.length;
          if (size > MAX_FETCH) { controller.abort(); throw Object.assign(new Error('the answer is larger than 64 MB'), { code: 'EFBIG' }); }
          chunks.push(Buffer.from(chunk));
        }
      }
      return { meta: { status: res.status, statusText: res.statusText, url: res.url || target.href, headers: [...res.headers] }, body: Buffer.concat(chunks) };
    } finally {
      clearTimeout(timer);
    }
  }

  // ----- the page (localhost) -----
  function staticFile(req, res, pathname) {
    const rel = pathname === '/' ? '/index.html' : pathname;
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
      let bytes = buf;
      if (file === path.join(PUBLIC_DIR, 'index.html')) bytes = Buffer.from(injectBoot(buf.toString('utf8')));
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': bytes.length, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    });
  }

  function shellRoute(req, res, pathname, url, body) {
    if (pathname === '/__shell/config.js') {
      // it holds the host key: never to another site's <script> tag (with
      // --no-session there is no cookie to stop one)
      const site = String(req.headers['sec-fetch-site'] || 'same-origin');
      if (site !== 'same-origin') { res.writeHead(403); return res.end('forbidden'); }
      const config = { channel: `http://127.0.0.1:${actualPort}`, key: hostKey, appRoot: '/app', dataDir: '/data', configDir: '/config', tmpDir: '/tmp', platform: 'devhost', version: 'dev', pid: process.pid };
      const js = Buffer.from(`self.MUNDUS_HOST = ${JSON.stringify(config)};\n`);
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Length': js.length, 'Cache-Control': 'no-store' });
      return res.end(js);
    }
    if (pathname === '/__shell/boot.js' || pathname.startsWith('/__shell/runtime/')) {
      const name = pathname === '/__shell/boot.js' ? 'boot.js' : pathname.slice('/__shell/runtime/'.length);
      if (!/^[a-z0-9-]+\.js$/.test(name)) { res.writeHead(404); return res.end(); }
      return fs.readFile(path.join(RUNTIME_DIR, name), (err, buf) => {
        if (err) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-cache' });
        res.end(buf);
      });
    }
    if (pathname === '/__shell/save' && req.method === 'POST') {
      const name = (url.searchParams.get('name') || 'download').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/^\.+/, '').slice(-120) || 'download';
      const file = path.join(downloadsDir, name);
      fs.writeFileSync(file, body);
      console.log(`[devhost] saved ${body.length} bytes as ${file} (${req.headers['content-type'] || 'no type'}); the phone offers Save and Share here.`);
      return sendJson(res, 200, { ok: true });
    }
    res.writeHead(404);
    return res.end();
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { res.writeHead(413); res.end(); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      handle(req, res, Buffer.concat(chunks)).catch((err) => {
        console.error(`[devhost] ${req.method} ${req.url} failed: ${err.stack || err}`);
        if (!res.headersSent) sendJson(res, err.status || 500, { error: err.message });
      });
    });
  });

  async function handle(req, res, body) {
    const hostHeader = String(req.headers.host || '').toLowerCase();
    const url = new URL(req.url, `http://${hostHeader || 'localhost'}`);
    if (hostHeader === `127.0.0.1:${actualPort}` && url.pathname.startsWith('/__host/')) return hostRoute(req, res, url, body);
    if (hostHeader !== `localhost:${actualPort}`) { res.writeHead(403); return res.end('MundusMaker answers only at its own address.'); }
    if (url.pathname === '/__shell/open') {
      if (!same(url.searchParams.get('t'), sessionToken)) { res.writeHead(403); return res.end('forbidden'); }
      res.writeHead(302, { 'Set-Cookie': `mm_session=${sessionToken}; Path=/; HttpOnly; SameSite=Strict`, Location: '/' });
      return res.end();
    }
    const cookie = /(?:^|;\s*)mm_session=([^;]+)/.exec(req.headers.cookie || '');
    if (!noSession && !same(cookie && cookie[1], sessionToken)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Open MundusMaker from the address the devhost printed.');
    }
    let pathname;
    try { pathname = decodeURI(url.pathname); } catch { res.writeHead(400); return res.end(); }
    if (pathname.startsWith('/__shell/')) return shellRoute(req, res, pathname, url, body);
    if (pathname.startsWith('/api/') || pathname.startsWith('/assets/') || (req.method !== 'GET' && req.method !== 'HEAD')) return relay(req, res, body);
    return staticFile(req, res, pathname);
  }

  server.listen(port, '127.0.0.1', () => {
    actualPort = server.address().port;
    const openUrl = `http://localhost:${actualPort}/__shell/open?t=${sessionToken}`;
    console.log(`[devhost] ready: ${noSession ? `http://localhost:${actualPort}/ (no session cookie: preview only)` : openUrl}`);
    if (onReady) onReady({ port: actualPort, openUrl });
  });
  return server;
}

function injectBoot(html) {
  const tag = '<script src="/__shell/boot.js"></script>';
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}\n${tag}`) : tag + html;
}

if (require.main === module) main();

module.exports = { startHost, injectBoot };
