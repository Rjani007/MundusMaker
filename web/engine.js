/*
 * MundusMaker's engine on the website (docs/website.md): the app's own
 * server.js in a Web Worker, on the phone runtime (node.js, copied from
 * mobile/shared/runtime when the site is published). Its files live in
 * memory and in IndexedDB (memfs.js, store.js), and a signed-in GM's worlds
 * also travel through their account (sync.js, cloud.js).
 *
 * The page (boot.js) starts it, hands it the app's requests (the service
 * worker catches them) and answers its questions for a sign-in token.
 * Every answer waits until the files that request changed are in
 * IndexedDB, so "Saved" in the app means saved in this browser.
 */
'use strict';

importScripts('node.js', 'memfs.js', 'store.js', 'sync.js', 'cloud.js');

(function () {
  // installGlobals() below swaps in Node's versions of these; the engine keeps the browser's
  const nativeFetch = self.fetch.bind(self);
  const later = self.setTimeout.bind(self);
  const cancel = self.clearTimeout.bind(self);
  const encoder = new TextEncoder();

  let C = null; // the page's settings, from 'start'
  let fs = null;
  let store = null;
  let sync = null;
  let runtime = null;
  let stopped = false;
  let visible = true;
  const replies = new Map(); // request id -> MessagePort
  let seq = 0;

  const post = (msg) => self.postMessage(msg);
  const readBlob = (blob) => new Uint8Array(new FileReaderSync().readAsArrayBuffer(blob));
  const exact = (u8) => (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength ? u8.buffer : u8.slice().buffer);
  const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  const digest = async (bytes) => hex(await crypto.subtle.digest('SHA-256', bytes));

  // ---------- the app's own files (read-only, from the website) ----------

  function bundle(base, manifest) {
    const files = new Map(Object.entries(manifest.files || {}));
    const built = Number(manifest.built) || 0;
    const dirs = new Map([['', new Map()]]);
    for (const [rel, size] of files) {
      const parts = rel.split('/');
      for (let i = 0; i < parts.length; i++) {
        const dir = parts.slice(0, i).join('/');
        if (!dirs.has(dir)) dirs.set(dir, new Map());
        const isFile = i === parts.length - 1;
        dirs.get(dir).set(parts[i], isFile ? { type: 'file', size } : { type: 'dir', size: 0 });
        if (!isFile && !dirs.has(parts.slice(0, i + 1).join('/'))) dirs.set(parts.slice(0, i + 1).join('/'), new Map());
      }
    }
    const cache = new Map();
    const missing = () => Object.assign(new Error('no such file or directory'), { code: 'ENOENT' });
    return {
      stat(rel) {
        if (files.has(rel)) return { type: 'file', size: files.get(rel), mtimeMs: built };
        return dirs.has(rel) ? { type: 'dir', size: 0, mtimeMs: built } : null;
      },
      list(rel) {
        const dir = dirs.get(rel);
        if (!dir) throw missing();
        return [...dir].map(([name, e]) => ({ name, type: e.type, size: e.size, mtimeMs: built }));
      },
      read(rel) {
        if (!files.has(rel)) throw missing();
        if (cache.has(rel)) return cache.get(rel);
        const xhr = new XMLHttpRequest();
        xhr.open('GET', base + rel.split('/').map(encodeURIComponent).join('/'), false); // workers may wait on the network
        xhr.responseType = 'arraybuffer';
        try { xhr.send(); } catch (err) { throw Object.assign(new Error(`could not load ${rel} (${err.message})`), { code: 'EIO' }); }
        if (xhr.status !== 200) throw Object.assign(new Error(`could not load ${rel} (${xhr.status})`), { code: 'EIO' });
        const bytes = new Uint8Array(xhr.response);
        cache.set(rel, bytes);
        return bytes;
      },
    };
  }

  // ---------- keeping changes ----------

  let flushing = false;
  let waiters = [];
  let failures = 0;
  /** Resolves once everything changed so far is in IndexedDB. */
  function persisted() {
    return new Promise((resolve, reject) => {
      waiters.push({ resolve, reject });
      if (!flushing) flushLoop();
    });
  }
  async function flushLoop() {
    flushing = true;
    try {
      while (waiters.length || fs.hasChanges() || (sync && sync.hasChanges())) {
        const batch = waiters;
        waiters = [];
        const files = fs.takeChanges();
        const syncChanges = sync ? sync.takeChanges() : { bases: [], meta: [] };
        if (!files.length && !syncChanges.bases.length && !syncChanges.meta.length) { batch.forEach((w) => w.resolve()); continue; }
        try {
          const adopt = await store.write(files, syncChanges.bases, syncChanges.meta);
          if (failures) post({ type: 'storage', ok: true });
          failures = 0;
          batch.forEach((w) => w.resolve());
          if (adopt.length) store.blobsFor(adopt).then((list) => list.forEach((x) => fs.adoptBlob(x.path, x.ver, x.blob)), () => {});
        } catch (err) {
          fs.markChanged(files.map((f) => f.path));
          if (sync) sync.requeue(syncChanges);
          failures++;
          batch.forEach((w) => w.reject(err));
          post({ type: 'storage', ok: false, message: storageProblem(err) });
          await new Promise((r) => later(r, Math.min(30000, 1000 * 2 ** failures)));
        }
      }
    } finally {
      flushing = false;
    }
  }
  function storageProblem(err) {
    if (err && err.name === 'QuotaExceededError') return 'This browser has no room left for MundusMaker’s files. Free some disk space, or download a backup now: your latest changes are not saved yet.';
    return `This browser would not save MundusMaker’s files (${err && err.message ? err.message : err}). Download a backup now: your latest changes are not saved yet.`;
  }
  // server.js writes outside requests too (start-up, timers); keep those as well
  setInterval(() => { if (fs && store && !flushing && (fs.hasChanges() || (sync && sync.hasChanges()))) persisted().catch(() => {}); }, 2000);

  // ---------- the sign-in token, from the page ----------

  let token = null;
  let tokenWaiters = [];
  function getToken(refresh) {
    if (!refresh && token && token.expiresAt - 60 > Date.now() / 1000) return Promise.resolve(token);
    return new Promise((resolve, reject) => {
      tokenWaiters.push({ resolve, reject });
      if (tokenWaiters.length === 1) post({ type: 'token-request', refresh: !!refresh });
    });
  }
  function tokenArrived(msg) {
    const list = tokenWaiters;
    tokenWaiters = [];
    if (msg.token) {
      token = { token: msg.token, expiresAt: msg.expiresAt, user: msg.user };
      list.forEach((w) => w.resolve(token));
    } else {
      list.forEach((w) => w.reject(Object.assign(new Error(msg.message || 'not signed in'), { kind: msg.offline ? 'offline' : 'auth' })));
    }
  }

  // ---------- syncing ----------

  let syncTimer = null;
  function syncSoon(ms) {
    if (!sync || stopped) return;
    cancel(syncTimer);
    syncTimer = later(runSync, ms);
  }
  let failedSyncs = 0;
  async function runSync() {
    syncTimer = null;
    try {
      await sync.syncNow();
      failedSyncs = 0;
    } catch (err) {
      failedSyncs++;
      if (err && err.kind !== 'offline') console.warn(`[mundusmaker] sync: ${err.message}`);
    }
    await persisted().catch(() => {});
    // look for other devices' changes now and then, more often while the tab is in front
    syncSoon(failedSyncs ? Math.min(300000, 15000 * 2 ** Math.min(failedSyncs, 4)) : visible ? 30000 : 120000);
  }

  // ---------- server.js ----------

  // outbound requests server.js makes when the GM presses a button; the
  // browser's CORS rules apply, so only sites that allow it can answer
  const SAFE_HEADERS = new Set(['accept', 'accept-language', 'content-language', 'content-type']);
  const followed = new Map(); // a redirect the browser followed, for server.js's next hop
  async function outbound(meta, body) {
    if (!/^https:\/\//i.test(meta.url)) throw Object.assign(new Error('only https downloads are allowed'), { code: 'EINVAL' });
    const kept = followed.get(meta.url);
    if (kept) { followed.delete(meta.url); return kept; }
    const controller = new AbortController();
    const timer = later(() => controller.abort(), meta.timeoutMs || 120000);
    let res;
    try {
      res = await nativeFetch(meta.url, {
        method: meta.method || 'GET',
        headers: (meta.headers || []).filter(([k]) => SAFE_HEADERS.has(String(k).toLowerCase())),
        body: meta.method === 'GET' || meta.method === 'HEAD' || !body || !body.length ? undefined : body,
        redirect: 'follow', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal,
      });
    } catch {
      cancel(timer);
      const host = (() => { try { return new URL(meta.url).host; } catch { return 'that site'; } })();
      throw Object.assign(new Error(`your browser could not reach ${host}. The site may not let web pages download from it; download the file yourself instead`), { code: 'ECONNREFUSED' });
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    cancel(timer);
    const answer = { meta: { status: res.status, statusText: res.statusText, url: res.url || meta.url, headers: [...res.headers] }, body: bytes };
    // server.js checks each redirect itself; the browser already followed them, so hand it one hop to check
    if (meta.redirect === 'manual' && res.redirected && res.url && res.url !== meta.url) {
      followed.set(res.url, answer);
      return { meta: { status: 302, statusText: 'Found', url: meta.url, headers: [['location', res.url]] }, body: new Uint8Array(0) };
    }
    return answer;
  }

  const host = {
    fs: (op, args, data) => fs.call(op, args, data),
    fetch: outbound,
    respond(id, meta, body) {
      const port = replies.get(id);
      replies.delete(id);
      if (!port) return;
      const buffer = exact(body || new Uint8Array(0));
      persisted().then(
        () => port.postMessage({ meta, body: buffer }, [buffer]),
        (err) => {
          const failure = encoder.encode(JSON.stringify({ error: storageProblem(err) }));
          port.postMessage({ meta: { status: 507, headers: [['content-type', 'application/json; charset=utf-8']] }, body: failure.buffer }, [failure.buffer]);
        });
    },
    exit(code) {
      stopped = true;
      persisted().catch(() => {}).then(() => post({ type: 'exit', code }));
    },
  };

  function onRequest(msg, port) {
    if (!runtime || stopped) {
      const busy = encoder.encode(JSON.stringify({ error: 'MundusMaker is still starting. Try again in a moment.' }));
      port.postMessage({ meta: { status: 503, headers: [['content-type', 'application/json; charset=utf-8']] }, body: busy.buffer }, [busy.buffer]);
      return;
    }
    const id = String(++seq);
    replies.set(id, port);
    try {
      runtime.dispatch({ id, method: msg.method, url: msg.url, headers: msg.headers }, new Uint8Array(msg.body || new ArrayBuffer(0)));
    } catch (err) {
      console.error(`[mundusmaker] request ${id} failed: ${err.stack || err}`);
      host.respond(id, { status: 500, headers: [['content-type', 'application/json; charset=utf-8']] }, encoder.encode(JSON.stringify({ error: err.message })));
    }
  }

  async function start(config) {
    C = config;
    post({ type: 'progress', message: 'Opening your worlds…' });
    store = await MundusStore.openStore(C.dbName, { readBlob });
    const saved = await store.loadAll();
    fs = MundusMemFs.createMemFs({ readonly: { '/app': bundle(C.bundleUrl, C.manifest) }, readBlob });
    fs.load(saved.files);
    const firstVisit = !saved.files.some((r) => r.path.startsWith('/data/worlds/'));

    if (C.cloud) {
      const cloud = MundusCloud.createCloud({ url: C.cloud.url, key: C.cloud.key, getToken, fetchImpl: nativeFetch });
      sync = MundusSync.createSync({ fs, cloud, digest, device: C.device, onEvent: (ev) => post({ type: 'sync', event: ev.type, status: ev.status, count: ev.count }) });
      sync.load(saved);
      fs.onChange = (path) => { if (sync.noteChange(path)) syncSoon(2500); };
      sync.scanAll();
      post({ type: 'progress', message: firstVisit ? 'Fetching your worlds from your account…' : 'Checking your account for changes…' });
      try {
        await sync.pull();
      } catch (err) {
        // a browser with nothing of its own yet must not start an empty "My World" beside the real ones
        if (firstVisit) throw Object.assign(new Error(err.kind === 'offline'
          ? 'MundusMaker could not reach your account to fetch your worlds. Check your connection and try again.'
          : `MundusMaker could not fetch your worlds: ${err.message}`), { retry: true });
        console.warn(`[mundusmaker] starting without the account's newest changes: ${err.message}`);
      }
      await persisted();
    }

    post({ type: 'progress', message: 'Starting MundusMaker…' });
    runtime = MundusNode.create({
      host,
      appRoot: '/app',
      argv: ['/data', '--no-open'],
      env: { MUNDUSMAKER_DEPLOYMENT: 'web', MUNDUSMAKER_CONFIG_DIR: '/config', MUNDUSMAKER_PLATFORM_VERSION: C.version || '' },
      platform: 'browser',
      pid: 1,
      tmpDir: '/tmp',
      homeDir: '/config',
    });
    runtime.installGlobals(self);
    self.addEventListener('error', (ev) => console.error(`[mundusmaker] uncaught: ${ev.error ? ev.error.stack || ev.error : ev.message}`));
    self.addEventListener('unhandledrejection', (ev) => console.error(`[mundusmaker] unhandled rejection: ${ev.reason && ev.reason.stack ? ev.reason.stack : ev.reason}`));
    runtime.onListen = () => {
      persisted().catch(() => {}).then(() => post({ type: 'ready', sync: sync ? sync.status() : null }));
      syncSoon(1500);
    };
    runtime.runMain('/app/server.js');
  }

  async function stop() {
    stopped = true;
    cancel(syncTimer);
    try { await persisted(); } catch { /* reported already */ }
    if (store) store.close();
    post({ type: 'stopped' });
  }

  self.onmessage = (ev) => {
    const msg = ev.data || {};
    if (msg.type === 'start') {
      start(msg.config).catch((err) => post({ type: 'fatal', message: err.message || String(err), retry: !!err.retry }));
    } else if (msg.type === 'request') {
      onRequest(msg, ev.ports[0]);
    } else if (msg.type === 'token') {
      tokenArrived(msg);
    } else if (msg.type === 'sync-now') {
      syncSoon(0);
    } else if (msg.type === 'visible') {
      visible = !!msg.visible;
      if (visible) syncSoon(500);
    } else if (msg.type === 'usage') {
      (sync ? MundusCloud.createCloud({ url: C.cloud.url, key: C.cloud.key, getToken, fetchImpl: nativeFetch }).usage() : Promise.resolve(null))
        .then((usage) => post({ type: 'usage', usage }), (err) => post({ type: 'usage', usage: null, message: err.message }));
    } else if (msg.type === 'stop') {
      stop();
    }
  };
}());
