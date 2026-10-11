'use strict';

// The phone apps (mobile/) run this repo's server.js on a Node compatibility
// layer inside the WebView (mobile/shared/runtime/node.js). These tests load
// that layer in a vm context (its own Buffer, process, fs, http and timers,
// not Node's), boot the real server.js on it with the reference file host
// (mobile/shared/fsops.js) and drive the API the way the app does. A server
// change that needs a Node feature the layer lacks fails here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const nodeCrypto = require('node:crypto');
const { createFsOps } = require('../mobile/shared/fsops');

const ROOT = path.join(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'mobile', 'shared', 'runtime', 'node.js'), 'utf8');
const APP_ENTRIES = ['server.js', 'package.json', 'public', 'sample', 'scripts'];
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function webContext() {
  const context = vm.createContext({
    TextEncoder, TextDecoder, URL, URLSearchParams, AbortController, atob, btoa, console, structuredClone,
    crypto: nodeCrypto.webcrypto, performance, queueMicrotask,
    setTimeout, clearTimeout, setInterval, clearInterval,
  });
  vm.runInContext(SOURCE, context, { filename: 'mobile/shared/runtime/node.js' });
  return context;
}

const shared = webContext().MundusNode;

test('sha256 matches Node for many lengths', () => {
  for (const n of [0, 1, 3, 55, 56, 63, 64, 65, 119, 120, 1000, 100003]) {
    const bytes = nodeCrypto.randomBytes(n);
    assert.equal(Buffer.from(shared.sha256(bytes)).toString('hex'), nodeCrypto.createHash('sha256').update(bytes).digest('hex'), `length ${n}`);
  }
});

test('Buffer encodings match Node', () => {
  const B = shared.Buffer;
  const text = '﻿Hello, wörld — 🐉 dragons';
  assert.equal(B.from(text).toString(), text, 'utf8 keeps a BOM, as Node does');
  assert.equal(B.from(text).toString('base64'), Buffer.from(text).toString('base64'));
  assert.equal(B.from(text).toString('hex'), Buffer.from(text).toString('hex'));
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.equal(B.from(all).toString('latin1'), Buffer.from(all).toString('latin1'));
  assert.deepEqual([...B.from(Buffer.from(all).toString('latin1'), 'latin1')], [...all]);
  for (const b64 of ['aGVsbG8', 'aGVs bG8=', 'a-_8', PNG_1PX]) assert.deepEqual([...B.from(b64, 'base64')], [...Buffer.from(b64, 'base64')], b64);
  assert.equal(B.from('48656c6c6fzz', 'hex').toString(), 'Hello');
  const joined = B.concat([B.from('ab'), new Uint8Array([99, 100])]);
  assert.equal(joined.toString(), 'abcd');
  assert.equal(B.concat([B.from('abcdef')], 3).toString(), 'abc');
  assert.ok(joined.subarray(1, 3) instanceof B, 'subarray stays a Buffer');
  assert.equal(joined.slice(1, 3).toString('latin1'), 'bc');
  assert.ok(B.from('abc').equals(new Uint8Array([97, 98, 99])));
  assert.equal(B.from('%PDF-1.7').subarray(0, 1024).toString('latin1').includes('%PDF-'), true);
  assert.equal(B.from('xx%PDF').indexOf('%PDF'), 2);
  assert.equal(B.byteLength('🐉'), 4);
});

test('path behaves like path.posix', () => {
  const p = shared.makePath(() => '/cwd');
  const cases = [
    ['join', 'a', 'b', '../c'], ['join', '/a/', 'b/'], ['join', ''], ['normalize', '/a//b/./c/..'], ['normalize', ''],
    ['normalize', 'a/../..'], ['normalize', './'], ['dirname', '/a/b/'], ['dirname', '/a'], ['dirname', 'a'], ['dirname', '/'],
    ['dirname', '//a//b//'], ['basename', '/a/b.txt', '.txt'], ['basename', '/a/b/'], ['basename', 'b.txt', 'b.txt'],
    ['basename', '/a/b.txt', 'b.txt'], ['basename', 'aaa', 'a'], ['basename', '/a/', 'a'], ['basename', 'b.txt/', '.txt'],
    ['extname', 'x.tar.gz'], ['extname', '.bashrc'], ['extname', 'file.'], ['extname', '..'], ['relative', '/a/b/c', '/a/d'],
    ['relative', '/a', '/a'], ['isAbsolute', '/x'], ['isAbsolute', 'x'],
  ];
  for (const [fn, ...args] of cases) assert.deepEqual(p[fn](...args), path.posix[fn](...args), `${fn}(${args.join(', ')})`);
  assert.equal(p.resolve('a', '../b'), path.posix.resolve('/cwd', 'a', '../b'));
  assert.equal(p.resolve('/x', 'y', '/z', 'w'), '/z/w');
  assert.deepEqual({ ...p.parse('/home/u/file.txt') }, path.posix.parse('/home/u/file.txt')); // spread: the vm realm's Object differs
});

// ---------- the real server.js on the runtime ----------

function bootServer({ fetch: hostFetch } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mundusmaker-mobile-'));
  for (const d of ['data', 'config', 'tmp']) fs.mkdirSync(path.join(tmp, d));
  const ops = createFsOps({
    '/app': { dir: ROOT, writable: false, only: APP_ENTRIES },
    '/data': { dir: path.join(tmp, 'data'), writable: true },
    '/config': { dir: path.join(tmp, 'config'), writable: true },
    '/tmp': { dir: path.join(tmp, 'tmp'), writable: true },
  });
  const pending = new Map();
  const exits = [];
  const counts = {};
  const host = {
    fs: (op, args, data) => {
      counts[op] = (counts[op] || 0) + 1;
      return ops.call(op, args, data && Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    },
    fetch: hostFetch || (async () => { throw Object.assign(new Error('offline in tests'), { code: 'ECONNREFUSED' }); }),
    respond(id, meta, body) {
      const resolve = pending.get(id);
      pending.delete(id);
      const headers = new Map(meta.headers.map(([k, v]) => [k.toLowerCase(), v]));
      const bytes = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
      resolve({ status: meta.status, headers, body: bytes, text: () => bytes.toString('utf8'), json: () => JSON.parse(bytes.toString('utf8')) });
    },
    exit: (code) => exits.push(code),
  };
  const context = webContext();
  const runtime = context.MundusNode.create({
    host,
    appRoot: '/app',
    argv: ['/data', '--no-open'],
    env: { MUNDUSMAKER_DEPLOYMENT: 'mobile', MUNDUSMAKER_CONFIG_DIR: '/config' },
    platform: 'android',
    tmpDir: '/tmp',
  });
  runtime.installGlobals(context);
  const listening = new Promise((resolve) => { runtime.onListen = resolve; });
  runtime.runMain('/app/server.js');

  let seq = 0;
  function request(method, url, { headers = {}, body, raw } = {}) {
    const id = String(++seq);
    const pairs = [['host', 'localhost:4870'], ...Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)])];
    let bytes = Buffer.alloc(0);
    if (raw !== undefined) bytes = Buffer.from(raw);
    else if (body !== undefined) {
      bytes = Buffer.from(JSON.stringify(body));
      if (!('content-type' in Object.fromEntries(pairs))) pairs.push(['content-type', 'application/json']);
    } else if (method !== 'GET' && method !== 'HEAD' && !headers['content-type'] && !headers['Content-Type']) {
      pairs.push(['content-type', 'application/json']);
    }
    return new Promise((resolve) => {
      pending.set(id, resolve);
      runtime.dispatch({ id, method, url, headers: pairs }, new Uint8Array(bytes));
    });
  }
  const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
  return { tmp, runtime, request, listening, exits, cleanup, counts, dataDir: path.join(tmp, 'data') };
}

test('server.js boots on the runtime and serves the app the way the phone uses it', async (t) => {
  const s = bootServer();
  t.after(s.cleanup);
  await s.listening;

  const status = (await s.request('GET', '/api/status')).json();
  assert.equal(status.app, 'mundusmaker');
  assert.equal(status.deployment, 'mobile');
  assert.equal(status.platform, 'android');
  assert.equal(status.dataDir, '/data');
  assert.equal(status.restartNeeded, false);

  const worlds = (await s.request('GET', '/api/worlds')).json();
  const wid = 'the-sundered-reach';
  assert.ok(JSON.stringify(worlds).includes(wid), 'the sample world was seeded from the bundle');
  assert.ok(fs.readdirSync(path.join(s.dataDir, '.snapshots', wid)).length >= 1, 'the daily snapshot ran');

  // the static pages work through server.js too (the hosts serve them directly)
  const index = await s.request('GET', '/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  assert.match(index.text(), /<div id="app">/);

  // entries, revisions and the request guard
  const list = await s.request('GET', `/api/w/${wid}/entities?details=1`);
  const { entities, revisions } = list.json();
  assert.ok(entities.length > 5);
  const first = entities[0];
  const url = `/api/w/${wid}/entities/${encodeURIComponent(first.id)}`;
  const one = await s.request('GET', url);
  const etag = one.headers.get('etag');
  assert.equal(etag, revisions[first.id]);

  const edited = { ...one.json(), name: `${first.name} (edited on the phone)` };
  const put = await s.request('PUT', url, { headers: { 'If-Match': etag }, body: edited });
  assert.equal(put.status, 200, put.text());
  const newTag = put.headers.get('etag');
  assert.notEqual(newTag, etag);
  const onDisk = JSON.parse(fs.readFileSync(path.join(s.dataDir, 'worlds', wid, 'entities', `${first.id}.json`), 'utf8'));
  assert.equal(onDisk.name, edited.name);
  assert.deepEqual(fs.readdirSync(path.join(s.dataDir, 'worlds', wid, 'entities')).filter((f) => f.endsWith('.tmp')), [], 'atomic writes leave no temp files');
  assert.equal(`"${nodeCrypto.createHash('sha256').update(fs.readFileSync(path.join(s.dataDir, 'worlds', wid, 'entities', `${first.id}.json`))).digest('hex')}"`, newTag);

  const stale = await s.request('PUT', url, { headers: { 'If-Match': etag }, body: { ...edited, name: 'stale' } });
  assert.equal(stale.status, 409);
  assert.ok(fs.readdirSync(path.join(s.dataDir, '.conflicts')).length >= 1, 'the refused draft was kept');
  assert.equal((await s.request('PUT', url, { body: edited })).status, 428);
  assert.equal((await s.request('POST', '/api/worlds', { raw: '{"name":"x"}', headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await s.request('GET', '/api/status', { headers: { host: 'evil.example' } })).status, 403);
  assert.equal((await s.request('POST', '/api/worlds', { body: { name: 'x' }, headers: { origin: 'http://evil.example' } })).status, 403);

  const history = (await s.request('GET', `${url}/history`)).json();
  assert.ok(Array.isArray(history.versions || history) && (history.versions || history).length >= 1, 'the previous version was archived');

  // create and delete (delete moves to the trash)
  const fresh = { id: 'phone-note', name: 'Phone note', type: 'note', tags: [], gmOnly: false, fields: {}, blocks: [], relations: [], date: null, map: null };
  const created = await s.request('PUT', `/api/w/${wid}/entities/phone-note`, { headers: { 'If-None-Match': '*' }, body: fresh });
  assert.equal(created.status, 200, created.text());
  const del = await s.request('DELETE', `/api/w/${wid}/entities/phone-note`, { headers: { 'If-Match': created.headers.get('etag') } });
  assert.equal(del.status, 200, del.text());
  assert.ok(!fs.existsSync(path.join(s.dataDir, 'worlds', wid, 'entities', 'phone-note.json')));
  assert.ok(fs.readdirSync(path.join(s.dataDir, '.trash')).some((f) => f.includes('phone-note')));

  // assets: raster only, served passive
  const up = await s.request('POST', `/api/w/${wid}/assets`, { body: { name: 'pixel.png', dataBase64: PNG_1PX } });
  assert.equal(up.status, 200, up.text());
  const asset = await s.request('GET', `/assets/${wid}/${up.json().file}`);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('content-type'), 'image/png');
  assert.equal(asset.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual([...asset.body], [...Buffer.from(PNG_1PX, 'base64')]);
  const svg = await s.request('POST', `/api/w/${wid}/assets`, { body: { name: 'x.svg', dataBase64: Buffer.from('<svg/>').toString('base64') } });
  assert.equal(svg.status, 415);

  // backup with images, then restore it (which snapshots first)
  const backup = (await s.request('GET', `/api/w/${wid}/backup?assets=1`)).json();
  assert.ok(backup.assets.some((a) => a.dataBase64 === Buffer.from(PNG_1PX, 'base64').toString('base64')));
  const restored = await s.request('POST', `/api/w/${wid}/restore`, { body: backup });
  assert.equal(restored.status, 200, restored.text());
  assert.ok(fs.readdirSync(path.join(s.dataDir, '.snapshots', wid)).some((d) => d.includes('pre-restore')));

  // exports land in the world's exports folder
  const exported = await s.request('POST', `/api/w/${wid}/export-file`, { body: { name: 'player-book.pdf', dataBase64: Buffer.from('%PDF-1.4 test').toString('base64') } });
  assert.equal(exported.status, 200, exported.text());
  assert.ok(fs.readdirSync(path.join(s.dataDir, 'worlds', wid, 'exports')).includes('player-book.pdf'));

  // the desktop's lifecycle and folder tools say why they are off
  assert.equal((await s.request('POST', '/api/quit')).status, 409);
  assert.equal((await s.request('POST', '/api/config', { body: { dataDir: '/data/elsewhere' } })).status, 409);
  assert.equal((await s.request('POST', '/api/auto-stop', { body: { minutes: 5 } })).status, 409);
  assert.equal((await s.request('GET', '/api/scan-installs')).status, 409);
  const folderBackup = (await s.request('GET', '/api/folder-backup')).json();
  assert.equal(folderBackup.available, false);
  assert.match(folderBackup.reason, /phone or tablet/);
  assert.deepEqual((await s.request('GET', '/api/upgrade')).json(), { notice: null, choice: null });

  // bodies over a route's limit are refused, unknown routes say so
  assert.equal((await s.request('POST', '/api/update-check', { raw: JSON.stringify({ confirm: true, pad: 'x'.repeat(6000) }), headers: { 'content-type': 'application/json' } })).status, 413);
  const unknown = await s.request('GET', '/api/no-such-route');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json().error, 'unknown api route');
  assert.deepEqual(s.exits, []);
});

test('outbound downloads go through the host and keep server.js\'s own checks', async (t) => {
  const requests = [];
  const pdf = Buffer.from('%PDF-1.7\n% a test sheet\n');
  const s = bootServer({
    async fetch(meta) {
      requests.push(meta);
      if (meta.url.includes('moved')) return { meta: { status: 302, headers: [['location', 'https://evil.example/x.pdf']], url: meta.url }, body: new Uint8Array(0) };
      return { meta: { status: 200, headers: [['content-type', 'application/pdf'], ['content-length', String(pdf.length)]], url: meta.url }, body: new Uint8Array(pdf) };
    },
  });
  t.after(s.cleanup);
  await s.listening;

  const sources = (await s.request('GET', '/api/sheet-templates/sources')).json();
  const id = sources[0].id;
  const got = await s.request('POST', '/api/sheet-templates/download', { body: { id, confirm: true } });
  assert.equal(got.status, 200, got.text());
  assert.equal(requests.length, 1);
  assert.equal(requests[0].redirect, 'manual', 'server.js checks redirects itself');
  assert.match(requests[0].url, /^https:\/\//);
  const templates = (await s.request('GET', '/api/sheet-templates')).json();
  assert.ok(JSON.stringify(templates).includes(id));
  const stored = await s.request('GET', `/api/sheet-templates/${encodeURIComponent(got.json().id)}/pdf`);
  assert.equal(stored.status, 200);
  assert.deepEqual([...stored.body], [...pdf]);

  // the fetch shim itself: manual redirects come back as they are
  const res = await s.runtime.fetch('https://example.org/moved', { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('Location'), 'https://evil.example/x.pdf');
  const ok = await s.runtime.fetch('https://example.org/sheet.pdf');
  const chunks = [];
  for await (const chunk of ok.body) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('latin1'), pdf.toString('latin1'));
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(s.runtime.fetch('https://example.org/x', { signal: aborted.signal }), /abort/i);
});

test('the file host keeps the runtime inside the app\'s folders', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mundusmaker-fsops-'));
  try {
    const ops = createFsOps({ '/app': { dir: ROOT, writable: false, only: APP_ENTRIES }, '/data': { dir: tmp, writable: true } });
    assert.throws(() => ops.call('read', { path: '/etc/passwd' }), { code: 'EACCES' });
    assert.throws(() => ops.call('read', { path: '/app/data/worlds' }), { code: 'EACCES' }, 'the repo data folder is not part of the bundle');
    assert.throws(() => ops.call('read', { path: '/data/../app/../../x' }), { code: 'EACCES' });
    assert.throws(() => ops.call('write', { path: '/app/server.js', flag: 'w' }, Buffer.from('x')), { code: 'EROFS' });
    assert.throws(() => ops.call('read', { path: 'relative.txt' }), { code: 'EACCES' });
    ops.call('write', { path: '/data/a.txt', flag: 'wx', fsync: true }, Buffer.from('one'));
    assert.throws(() => ops.call('write', { path: '/data/a.txt', flag: 'wx' }, Buffer.from('two')), { code: 'EEXIST' });
    assert.equal(ops.call('read', { path: '/data/a.txt' }).toString(), 'one');
    assert.equal(ops.call('stat', { path: '/data/missing', follow: true, quiet: true }), null);
    assert.throws(() => ops.call('stat', { path: '/data/missing', follow: true }), { code: 'ENOENT' });
    assert.deepEqual(ops.call('mkdir', { path: '/data/x/y', recursive: true }), { first: '/data/x' });
    assert.deepEqual(ops.call('readdir', { path: '/app' }).entries.map((e) => e.name).sort(), [...APP_ENTRIES].sort());

    // a backslash is a separator to Windows but not to the POSIX check: refused everywhere
    assert.throws(() => ops.call('read', { path: '/app/..\\data\\worlds' }), { code: 'EACCES' });
    assert.throws(() => ops.call('read', { path: '/app/public/..\\..\\data' }), { code: 'EACCES' });
    assert.throws(() => ops.call('write', { path: '/data/..\\..\\escape.txt', flag: 'w' }, Buffer.from('x')), { code: 'EACCES' });
    assert.ok(!fs.existsSync(path.join(path.dirname(tmp), 'escape.txt')), 'nothing was written outside the mount');
    assert.match(ops.call('readmany', { paths: ['/app/..\\package.json'] }).toString(), /^\{"sizes":\[-1\]\}\n$/, 'readmany treats an escaping path as unreadable');

    // the roots themselves cannot be moved or removed
    assert.throws(() => ops.call('rename', { from: '/data', to: '/data/inside' }), { code: 'EACCES' });
    assert.throws(() => ops.call('rm', { path: '/data', recursive: true, force: true }), { code: 'EACCES' });
    assert.ok(fs.existsSync(path.join(tmp, 'a.txt')));

    // mkdtemp: "dir/" makes a folder inside dir, "dir/name-" extends the name, never beside a root
    assert.throws(() => ops.call('mkdtemp', { prefix: '/data' }), { code: 'EACCES' });
    assert.match(ops.call('mkdtemp', { prefix: '/data/' }).path, /^\/data\/[A-Za-z0-9_-]{6}$/);
    assert.match(ops.call('mkdtemp', { prefix: '/data/x/stage-' }).path, /^\/data\/x\/stage-[A-Za-z0-9_-]{6}$/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a folder listing is read in one batch, and a write is never answered with old bytes', async (t) => {
  const s = bootServer();
  t.after(s.cleanup);
  await s.listening;
  for (const k of Object.keys(s.counts)) delete s.counts[k];
  const list = await s.request('GET', '/api/w/the-sundered-reach/entities?details=1');
  const entries = list.json().entities.length;
  assert.ok(entries > 20);
  assert.ok((s.counts.readmany || 0) >= 1, 'the entries came in a batch');
  assert.ok((s.counts.read || 0) <= 2, `${s.counts.read} single reads for ${entries} entries`);

  const fs2 = s.runtime.builtins.fs;
  const dir = '/data/worlds/the-sundered-reach/entities';
  const [a, b] = fs2.readdirSync(dir).filter((f) => f.endsWith('.json'));
  fs2.readFileSync(`${dir}/${a}`); // fetches b along with a
  fs2.writeFileSync(`${dir}/${b}`, '{"changed":true}');
  assert.equal(fs2.readFileSync(`${dir}/${b}`, 'utf8'), '{"changed":true}', 'a write in the same run clears what was fetched ahead');

  fs2.readdirSync(dir);
  fs2.readFileSync(`${dir}/${a}`);
  fs.writeFileSync(path.join(s.dataDir, 'worlds', 'the-sundered-reach', 'entities', b), '{"outside":true}'); // behind the runtime's back
  await null; // the synchronous run ends
  assert.equal(fs2.readFileSync(`${dir}/${b}`, 'utf8'), '{"outside":true}', 'nothing fetched ahead outlives the run that fetched it');
});

test('the phone bundle carries the desktop app files and the runtime, and nothing private', () => {
  const { stage, DESKTOP_ONLY } = require('../mobile/scripts/stage-bundle');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'mundusmaker-bundle-'));
  try {
    const { names, sha256 } = stage(out);
    for (const required of ['server.js', 'package.json', 'LICENSE', 'public/index.html', 'public/js/main.js', 'sample/world.json', 'scripts/storage.js', 'scripts/restore.js', 'runtime/node.js', 'runtime/worker.js', 'runtime/boot.js']) {
      assert.ok(names.includes(required), `missing ${required}`);
    }
    for (const name of names) {
      assert.ok(!DESKTOP_ONLY.has(name), `desktop-only ${name}`);
      assert.doesNotMatch(name, /(^|\/)(docs|\.git|tests|tmp|data|node_modules|mobile)(\/|$)/i, name);
      assert.doesNotMatch(name, /(^|\/)(agents|claude)\.md$/i, name);
    }
    const meta = JSON.parse(fs.readFileSync(path.join(out, 'bundle.json'), 'utf8'));
    assert.equal(meta.sha256, sha256);
    assert.equal(meta.files, names.length);
    assert.equal(stage(out).sha256, sha256, 'staging twice gives the same checksum, so the app re-unpacks only on a real change');
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('every file the app hands out goes through downloadBlob, which the phone app can save', () => {
  // A WebView ignores blob: downloads (an <a download> click, or jsPDF's save()),
  // so on the phone such a button silently did nothing.
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  walk(path.join(ROOT, 'public', 'js'));
  const offenders = [];
  for (const file of files) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    if (rel === 'public/js/util.js') continue; // downloadBlob itself
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (/\.save\(\s*[`'"]/.test(line) || /\.download\s*=|\bdownload:\s*[`'"]/.test(line)) offenders.push(`${rel}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [], 'use downloadBlob (util.js) instead');
});

test('a write that fails at fsync reports its own error and leaves no temporary file', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mundusmaker-flush-'));
  try {
    const ops = createFsOps({ '/app': { dir: ROOT, writable: false, only: APP_ENTRIES }, '/data': { dir: tmp, writable: true } });
    const context = webContext();
    const runtime = context.MundusNode.create({
      host: {
        fs(op, args, data) {
          if (op === 'write' && args.fsync) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
          return ops.call(op, args, data && Buffer.from(data.buffer, data.byteOffset, data.byteLength));
        },
        fetch: async () => { throw new Error('offline'); },
        respond() {},
        exit() {},
      },
      appRoot: '/app',
    });
    const { atomicWrite } = runtime.require('./scripts/storage');
    assert.throws(() => atomicWrite('/data/world.json', '{"name":"x"}'), (err) => err.code === 'ENOSPC', 'the first failure is the one reported');
    assert.deepEqual(fs.readdirSync(tmp), [], 'the temporary file was cleaned up');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('the reference host keeps its key and file channel to the app itself', async (t) => {
  const http = require('node:http');
  const { startHost } = require('../mobile/shared/devhost');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mundusmaker-devhost-'));
  for (const d of ['data', 'tmp', 'downloads']) fs.mkdirSync(path.join(tmp, d));
  const port = await new Promise((resolve) => {
    const server = startHost({
      port: 0,
      noSession: true, // the preview pane's mode: no cookie, so these checks are all that is left
      mounts: { '/app': { dir: ROOT, writable: false, only: APP_ENTRIES }, '/data': { dir: path.join(tmp, 'data'), writable: true }, '/tmp': { dir: path.join(tmp, 'tmp'), writable: true } },
      downloadsDir: path.join(tmp, 'downloads'),
      onReady: ({ port: p }) => resolve(p),
    });
    t.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  });
  const ask = (host, pathAndQuery, headers = {}, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathAndQuery, method: body ? 'POST' : 'GET', headers: { Host: `${host}:${port}`, Connection: 'close', ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
  assert.equal((await ask('localhost', '/__shell/config.js', { 'Sec-Fetch-Site': 'cross-site' })).status, 403, 'another site cannot load the key as a script');
  const config = await ask('localhost', '/__shell/config.js', { 'Sec-Fetch-Site': 'same-origin' });
  assert.equal(config.status, 200);
  const key = /"key":"([0-9a-f]+)"/.exec(config.body)[1];
  const stat = (p, origin) => ask('127.0.0.1', `/__host/fs?k=${key}&op=stat`, origin ? { Origin: origin } : {}, `${JSON.stringify({ path: p, follow: true })}\n`);
  assert.equal((await stat('/app/server.js', 'http://evil.example')).status, 403, 'a page elsewhere cannot use the file channel');
  assert.equal((await stat('/app/server.js', `http://localhost:${port}`)).status, 200);
  assert.equal((await ask('127.0.0.1', '/__host/fs?k=wrong&op=stat', {}, '{"path":"/app/server.js"}\n')).status, 403);
  const escape = await stat('/app/..\\data', `http://localhost:${port}`);
  assert.equal(escape.status, 403);
  assert.equal(JSON.parse(escape.body).code, 'EACCES');
  assert.equal((await ask('evil.example', '/')).status, 403, 'only its own host names');
});
