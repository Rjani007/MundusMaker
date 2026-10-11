/*
 * The phone app's server: a Web Worker that runs MundusMaker's own server.js
 * on the Node compatibility layer (node.js), talking to the native host over
 * the protocol in ../PROTOCOL.md.
 *
 * File calls are synchronous XHRs, which only a worker may make, so the
 * app's page never waits on the disk. Page requests arrive by long-poll and
 * their answers go back by POST. Everything here uses 127.0.0.1, never the
 * page's localhost name, so the page's connections can't starve these.
 */
'use strict';

importScripts('/__shell/config.js', 'node.js');

(function () {
  const C = self.MUNDUS_HOST;
  const nativeFetch = self.fetch.bind(self);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const url = (route, query = '') => `${C.channel}/__host/${route}?k=${encodeURIComponent(C.key)}${query}`;
  // Every response must be read or cancelled: the Android WebView keeps an
  // unread body (about 20 KB) even after garbage collection, and the server
  // answers each page request with one, so typing grew the app without end.
  const discard = (res) => { try { if (res.body) res.body.cancel().catch(() => {}); } catch { /* already read */ } };

  function frame(meta, body) {
    const head = encoder.encode(`${JSON.stringify(meta)}\n`);
    const out = new Uint8Array(head.length + (body ? body.length : 0));
    out.set(head);
    if (body && body.length) out.set(body, head.length);
    return out;
  }

  function unframe(bytes) {
    const nl = bytes.indexOf(10);
    if (nl === -1) throw new Error('malformed frame from the host');
    return { meta: JSON.parse(decoder.decode(bytes.subarray(0, nl))), body: bytes.subarray(nl + 1) };
  }

  // ----- logs: batched to the host's platform log, and kept in the worker console -----
  let pendingLog = [];
  let logTimer = null;
  function sendLog() {
    logTimer = null;
    if (!pendingLog.length) return;
    const body = encoder.encode(pendingLog.join('\n'));
    pendingLog = [];
    nativeFetch(url('log'), { method: 'POST', body }).then(discard).catch(() => { /* the host is gone; nothing to tell */ });
  }
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level].bind(console);
    console[level] = (...parts) => {
      original(...parts);
      pendingLog.push(`${level} ${MundusNode.format(...parts)}`);
      if (!logTimer) logTimer = setTimeout(sendLog, 150);
    };
  }

  // ----- the host, as node.js expects it -----
  const host = {
    fs(op, args, data) {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url('fs', `&op=${op}`), false);
      xhr.responseType = 'arraybuffer';
      try {
        xhr.send(frame(args, data));
      } catch (err) {
        throw Object.assign(new Error(`the app's file host did not answer (${err.message})`), { code: 'EIO' });
      }
      const bytes = new Uint8Array(xhr.response || new ArrayBuffer(0));
      if (xhr.status === 200) return op === 'read' || op === 'readmany' ? bytes : JSON.parse(decoder.decode(bytes) || 'null');
      let failure;
      try { failure = JSON.parse(decoder.decode(bytes)); } catch { failure = null; }
      throw Object.assign(new Error((failure && failure.message) || `the app's file host answered ${xhr.status}`), { code: (failure && failure.code) || 'EIO' });
    },
    async fetch(meta, body) {
      const res = await nativeFetch(url('fetch'), { method: 'POST', body: frame(meta, body) });
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (res.status !== 200) {
        let failure;
        try { failure = JSON.parse(decoder.decode(bytes)); } catch { failure = null; }
        throw Object.assign(new Error((failure && failure.message) || `request failed (${res.status})`), { code: (failure && failure.code) || 'ECONNREFUSED' });
      }
      return unframe(bytes);
    },
    respond(id, meta, body) {
      nativeFetch(url('respond', `&id=${encodeURIComponent(id)}`), { method: 'POST', body: frame(meta, body) })
        .then(discard)
        .catch((err) => console.error(`[mundusmaker] could not answer request ${id}: ${err.message}`));
    },
    exit(code) {
      sendLog();
      nativeFetch(url('exit', `&code=${Number(code) || 0}`), { method: 'POST' }).then(discard).catch(() => {});
    },
  };

  const runtime = MundusNode.create({
    host,
    appRoot: C.appRoot,
    argv: [C.dataDir, '--no-open'],
    env: { MUNDUSMAKER_DEPLOYMENT: 'mobile', MUNDUSMAKER_CONFIG_DIR: C.configDir, MUNDUSMAKER_PLATFORM_VERSION: C.version || '' },
    platform: C.platform || 'android',
    pid: C.pid || 1,
    tmpDir: C.tmpDir,
    homeDir: C.configDir,
  });
  runtime.installGlobals(self);

  // An error nothing caught is logged, as a browser would; it does not stop
  // the server (server.js answers every request inside its own try/catch).
  self.addEventListener('error', (ev) => console.error(`[mundusmaker] uncaught: ${ev.error ? ev.error.stack || ev.error : ev.message}`));
  self.addEventListener('unhandledrejection', (ev) => console.error(`[mundusmaker] unhandled rejection: ${ev.reason && ev.reason.stack ? ev.reason.stack : ev.reason}`));

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function pump() {
    for (let attempt = 0; ; attempt++) {
      try { discard(await nativeFetch(url('hello'), { method: 'POST' })); break; } catch { await sleep(Math.min(2000, 100 * (attempt + 1))); }
    }
    while (!runtime.exited) {
      let res;
      try {
        res = await nativeFetch(url('next'), { cache: 'no-store' });
      } catch {
        await sleep(500);
        continue;
      }
      if (res.status !== 200) {
        discard(res);
        if (res.status !== 204) await sleep(500);
        continue;
      }
      let request;
      try {
        request = unframe(new Uint8Array(await res.arrayBuffer()));
      } catch (err) {
        console.error(`[mundusmaker] dropped a malformed request: ${err.message}`);
        continue;
      }
      try {
        runtime.dispatch(request.meta, request.body);
      } catch (err) {
        console.error(`[mundusmaker] request ${request.meta.id} failed: ${err.stack || err}`);
        host.respond(request.meta.id, { status: 500, headers: [['content-type', 'application/json; charset=utf-8']] },
          encoder.encode(JSON.stringify({ error: err.message })));
      }
    }
  }

  runtime.onListen = () => { pump(); };
  try {
    runtime.runMain(`${C.appRoot}/server.js`);
  } catch (err) {
    console.error(`[mundusmaker] the server did not start: ${err.stack || err}`);
    self.postMessage({ type: 'fatal', message: String(err && err.message ? err.message : err) });
  }
}());
