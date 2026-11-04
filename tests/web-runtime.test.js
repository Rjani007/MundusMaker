'use strict';

// MundusMaker on the website runs this repo's server.js in a browser tab, on
// the phone runtime (mobile/shared/runtime/node.js) with its files in memory
// (web/memfs.js) and IndexedDB. These tests boot the real server.js that way
// in a vm context, with a plain Map standing in for IndexedDB, drive the API
// the way the app does, and start it again from what was kept. They also
// check what scripts/stage-web.js puts on the website.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const nodeCrypto = require('node:crypto');
const { createMemFs } = require('../web/memfs');
const { keepOnDisk } = require('../web/store');
const { webEntries, CSP } = require('../scripts/stage-web');
const { includeInPackage } = require('../scripts/package');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'mobile', 'shared', 'runtime', 'node.js'), 'utf8');
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** The app's own files as the website serves them: the bundle scripts/stage-web.js lists, read from the repo. */
function repoBundle() {
  const files = new Map();
  for (const e of webEntries({ build: 'test' })) {
    if (e.path.startsWith('web/bundle/') && e.path !== 'web/bundle/manifest.json') files.set(e.path.slice('web/bundle/'.length), e.file);
  }
  const dirs = new Map([['', new Set()]]);
  for (const rel of files.keys()) {
    const parts = rel.split('/');
    for (let i = 0; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (!dirs.has(dir)) dirs.set(dir, new Set());
      dirs.get(dir).add(parts[i]);
    }
  }
  return {
    reads: 0,
    stat(rel) {
      if (files.has(rel)) return { type: 'file', size: fs.statSync(files.get(rel)).size, mtimeMs: 1 };
      return dirs.has(rel) ? { type: 'dir', size: 0, mtimeMs: 1 } : null;
    },
    list(rel) {
      return [...dirs.get(rel)].map((name) => {
        const child = rel ? `${rel}/${name}` : name;
        return files.has(child) ? { name, type: 'file', size: fs.statSync(files.get(child)).size } : { name, type: 'dir', size: 0 };
      });
    },
    read(rel) {
      if (!files.has(rel)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      this.reads++;
      return new Uint8Array(fs.readFileSync(files.get(rel)));
    },
  };
}

/** IndexedDB, as a Map from path to record (store.js keeps the same shapes). */
function mapStore() {
  const records = new Map();
  return {
    records,
    keep(changes, memfs) {
      for (const { path: p, node } of changes) {
        if (!node) { records.delete(p); continue; }
        const rec = { path: p, type: node.type, size: node.size, mtimeMs: node.mtimeMs, ctimeMs: node.ctimeMs, birthtimeMs: node.birthtimeMs, mode: node.mode };
        if (node.type === 'file') {
          const bytes = memfs.bytes(p);
          if (keepOnDisk(p, node.size)) rec.blob = { bytes: new Uint8Array(bytes) }; else rec.bytes = new Uint8Array(bytes).buffer;
        }
        records.set(p, rec);
      }
    },
  };
}

function boot(store = mapStore()) {
  const bundle = repoBundle();
  const memfs = createMemFs({ readonly: { '/app': bundle }, readBlob: (b) => b.bytes });
  memfs.load([...store.records.values()]);
  const pending = new Map();
  const exits = [];
  const host = {
    fs: (op, args, data) => memfs.call(op, args, data),
    fetch: async () => { throw Object.assign(new Error('offline in tests'), { code: 'ECONNREFUSED' }); },
    respond(id, meta, body) {
      // the engine answers only once the request's changes are kept
      store.keep(memfs.takeChanges(), memfs);
      const resolve = pending.get(id);
      pending.delete(id);
      const headers = new Map(meta.headers.map(([k, v]) => [k.toLowerCase(), v]));
      const bytes = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
      resolve({ status: meta.status, headers, body: bytes, text: () => bytes.toString('utf8'), json: () => JSON.parse(bytes.toString('utf8')) });
    },
    exit: (code) => exits.push(code),
  };
  const context = vm.createContext({
    TextEncoder, TextDecoder, URL, URLSearchParams, AbortController, atob, btoa, console, structuredClone,
    crypto: nodeCrypto.webcrypto, performance, queueMicrotask, setTimeout, clearTimeout, setInterval, clearInterval,
  });
  vm.runInContext(SOURCE, context, { filename: 'mobile/shared/runtime/node.js' });
  const runtime = context.MundusNode.create({
    host, appRoot: '/app', argv: ['/data', '--no-open'],
    env: { MUNDUSMAKER_DEPLOYMENT: 'web', MUNDUSMAKER_CONFIG_DIR: '/config' },
    platform: 'browser', tmpDir: '/tmp', homeDir: '/config',
  });
  runtime.installGlobals(context);
  const listening = new Promise((resolve) => { runtime.onListen = resolve; });
  runtime.runMain('/app/server.js');
  let seq = 0;
  // what web/sw.js hands the engine: the app's own host name, no Origin or Sec-Fetch headers
  function request(method, url, { headers = {}, body } = {}) {
    const id = String(++seq);
    const pairs = [['host', 'localhost'], ...Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)])];
    let bytes = Buffer.alloc(0);
    if (body !== undefined) bytes = Buffer.from(JSON.stringify(body));
    if (method !== 'GET' && method !== 'HEAD' && !pairs.some(([k]) => k === 'content-type')) pairs.push(['content-type', 'application/json']);
    return new Promise((resolve) => {
      pending.set(id, resolve);
      runtime.dispatch({ id, method, url, headers: pairs }, new Uint8Array(bytes));
    });
  }
  const settle = () => store.keep(memfs.takeChanges(), memfs);
  return { memfs, store, bundle, request, listening, exits, settle };
}

test('server.js runs on the browser file host the way the website uses it', async () => {
  const s = boot();
  await s.listening;
  s.settle();

  const status = (await s.request('GET', '/api/status')).json();
  assert.equal(status.deployment, 'web');
  assert.equal(status.platform, 'browser');
  assert.equal(status.restartNeeded, false);

  const worlds = (await s.request('GET', '/api/worlds')).json();
  assert.deepEqual(worlds.map((w) => w.name), ['My World'], 'a first start makes one empty world');
  const wid = (await s.request('POST', '/api/worlds/sample', { body: {} })).json().id;
  assert.equal(wid, 'the-sundered-reach', 'the sample world comes from the website bundle');
  assert.ok(s.bundle.reads > 10, 'the app files are read from the bundle');

  const { entities, revisions } = (await s.request('GET', `/api/w/${wid}/entities?details=1`)).json();
  const first = entities[0];
  const url = `/api/w/${wid}/entities/${encodeURIComponent(first.id)}`;
  const one = await s.request('GET', url);
  const put = await s.request('PUT', url, { headers: { 'If-Match': revisions[first.id] }, body: { ...one.json(), name: `${first.name} (edited in a browser)` } });
  assert.equal(put.status, 200, put.text());
  assert.equal((await s.request('PUT', url, { headers: { 'If-Match': revisions[first.id] }, body: { ...one.json(), name: 'stale' } })).status, 409);
  assert.ok(s.memfs.call('readdir', { path: '/data/.conflicts' }).entries.length >= 1, 'the refused draft was kept');

  const up = await s.request('POST', `/api/w/${wid}/assets`, { body: { name: 'pixel.png', dataBase64: PNG_1PX } });
  assert.equal(up.status, 200, up.text());
  const asset = await s.request('GET', `/assets/${wid}/${up.json().file}`);
  assert.equal(asset.headers.get('content-type'), 'image/png');
  assert.deepEqual([...asset.body], [...Buffer.from(PNG_1PX, 'base64')]);

  const backup = (await s.request('GET', `/api/w/${wid}/backup?assets=1`)).json();
  assert.equal((await s.request('POST', `/api/w/${wid}/restore`, { body: backup })).status, 200);

  // desktop-only tools say why they are off, in the website's words
  const quit = await s.request('POST', '/api/quit');
  assert.equal(quit.status, 409);
  assert.match(quit.json().error, /close its tab/);
  assert.equal((await s.request('POST', '/api/auto-stop', { body: { minutes: 5 } })).status, 409);
  assert.match((await s.request('POST', '/api/config', { body: { dataDir: '/data/x' } })).json().error, /this browser and your account/);
  assert.equal((await s.request('GET', '/api/scan-installs')).status, 409);
  assert.deepEqual((await s.request('GET', '/api/upgrade')).json(), { notice: null, choice: null });
  assert.match((await s.request('GET', '/api/folder-backup')).json().reason, /On the website/);
  assert.deepEqual(s.exits, []);

  // the next visit starts from what was kept, and finds everything
  s.settle();
  const again = boot(s.store);
  await again.listening;
  const names = (await again.request('GET', '/api/worlds')).json().map((w) => w.name).sort();
  assert.deepEqual(names, ['My World', 'The Sundered Reach'].sort());
  const reread = (await again.request('GET', url)).json();
  assert.equal(reread.name, `${first.name} (edited in a browser)`);
  assert.equal((await again.request('GET', `/assets/${wid}/${up.json().file}`)).status, 200);
  const history = (await again.request('GET', `${url}/history`)).json();
  assert.ok((history.versions || history).length >= 1, 'history survived the reload');
});

test('the website gets the app, its shell and the server bundle, and nothing private', () => {
  const entries = webEntries({ build: 'test' });
  const paths = entries.map((e) => e.path);
  for (const required of ['index.html', 'sw.js', 'js/main.js', 'css/app.css', 'web/boot.js', 'web/engine.js', 'web/memfs.js',
    'web/store.js', 'web/sync.js', 'web/cloud.js', 'web/node.js', 'web/web.css', 'web/bundle/server.js',
    'web/bundle/package.json', 'web/bundle/scripts/storage.js', 'web/bundle/sample/world.json', 'web/bundle/manifest.json']) {
    assert.ok(paths.includes(required), required);
  }
  for (const p of paths) assert.ok(includeInPackage(p.replace(/^web\/bundle\//, '')), p);
  assert.ok(!paths.some((p) => /(^|\/)(AGENTS|CLAUDE)\.md$|\.claude\/|(^|\/)docs\/|(^|\/)tests?\/|container\.js$|\.sh$|Dockerfile/i.test(p)));

  const index = entries.find((e) => e.path === 'index.html').data.toString('utf8');
  assert.match(index, /<script type="module" src="web\/boot\.js"><\/script>/);
  assert.doesNotMatch(index, /src="js\/main\.js"/, 'boot.js loads the app once its engine is running');
  assert.ok(index.includes(CSP));
  assert.match(CSP, /script-src 'self'(;|$)/);
  assert.match(index, /href="https:\/\/ko-fi\.com\//, 'the Ko-fi link is in the top bar');

  const sw = entries.find((e) => e.path === 'sw.js').data.toString('utf8');
  assert.match(sw, /const BUILD = 'test';/);
  const manifest = JSON.parse(entries.find((e) => e.path === 'manifest.webmanifest').data);
  assert.equal(manifest.id, undefined, 'the website app is identified by its own folder, not the shared origin');
  assert.equal(manifest.start_url, './');

  const bundle = JSON.parse(entries.find((e) => e.path === 'web/bundle/manifest.json').data);
  assert.equal(bundle.version, require('../package.json').version);
  assert.ok(bundle.files['server.js'] > 1000 && bundle.files['sample/world.json'] > 10);
  assert.ok(!Object.keys(bundle.files).some((f) => f.startsWith('public/')), 'the page files are served, not bundled');

  // every script server.js requires is in the bundle (a new one would fail on the website)
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  for (const [, rel] of server.matchAll(/require\('\.\/(scripts\/[\w-]+)'\)/g)) assert.ok(bundle.files[`${rel}.js`], `${rel}.js`);
  // a hash of the files names the cache, so a new release replaces the old one
  assert.match(webEntries().find((e) => e.path === 'sw.js').data.toString('utf8'), /const BUILD = '\d+\.\d+\.\d+-[0-9a-f]{12}';/);
});

test('the app asks for its own files by relative paths, so it works under the website folder', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, d.name);
      if (d.isDirectory()) { walk(file); continue; }
      if (!/\.(js|html|css|webmanifest)$/.test(d.name)) continue;
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        // /api/ and /assets/ go to the engine wherever they point; everything else must be relative
        if (/["'`(]\/(?:js|css|vendor|srd52|systems|bestiary|wiki|icons|favicon\.ico|manifest\.webmanifest)\b/.test(line)) offenders.push(`${path.relative(ROOT, file)}:${i + 1}`);
      });
    }
  };
  walk(path.join(ROOT, 'public'));
  assert.deepEqual(offenders, []);
});
