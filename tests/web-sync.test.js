'use strict';

// MundusMaker on the website keeps a GM's worlds the same in every browser
// they sign in to (web/sync.js). These tests run two "browsers" against a
// fake account that follows sync_commit's rules from the migration
// (supabase/migrations/20261104120000_world_sync.sql); tests/site-db/ runs
// the real database. Every edit, deletion and conflict must end with both
// browsers holding the same files, and nothing lost.

const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
const { createMemFs } = require('../web/memfs');
const { createSync, inScope, LIMITS } = require('../web/sync');

const text = (s) => new TextEncoder().encode(s);
const digest = async (bytes) => nodeCrypto.createHash('sha256').update(bytes).digest('hex');

/** The account: rows, a head per GM, content-addressed objects, sync_commit's rules. */
function fakeAccount({ maxBytes = Infinity } = {}) {
  const rows = new Map(); // path -> { path, sha256, size, deleted, rev }
  const objects = new Map(); // sha -> bytes
  let head = 0;
  const calls = { upload: 0, download: 0, commit: 0 };
  const account = {
    rows, objects, calls,
    offline: false,
    // what any API call sees first
    check() { if (account.offline) throw Object.assign(new Error('could not reach your account'), { kind: 'offline' }); },
    async changes(after, limit) {
      account.check();
      return [...rows.values()].filter((r) => r.rev > after).sort((a, b) => a.rev - b.rev).slice(0, limit).map((r) => ({ ...r }));
    },
    async upload(sha, bytes) {
      account.check();
      calls.upload++;
      if (objects.has(sha)) return;
      const used = [...objects.values()].reduce((n, b) => n + b.length, 0);
      if (used >= maxBytes) throw Object.assign(new Error('new row violates row-level security policy'), { kind: 'full' });
      objects.set(sha, new Uint8Array(bytes));
    },
    async download(sha) {
      account.check();
      calls.download++;
      if (!objects.has(sha)) throw Object.assign(new Error('Object not found'), { kind: 'missing' });
      return new Uint8Array(objects.get(sha));
    },
    async commit(changes, device) {
      account.check();
      calls.commit++;
      const results = [];
      for (const c of changes) {
        if (!inScope(c.path)) { results.push({ path: c.path, refused: 'path' }); continue; }
        const cur = rows.get(c.path);
        if ((cur ? cur.rev : 0) !== (c.base || 0)) { results.push({ path: c.path, conflict: true, rev: cur ? cur.rev : 0 }); continue; }
        if (c.sha256 === null) {
          if (cur && !cur.deleted) { head++; rows.set(c.path, { path: c.path, sha256: null, size: 0, deleted: true, rev: head, device }); results.push({ path: c.path, rev: head }); } else results.push({ path: c.path, rev: cur ? cur.rev : 0 });
          continue;
        }
        if (!objects.has(c.sha256)) { results.push({ path: c.path, missing: true }); continue; }
        head++;
        rows.set(c.path, { path: c.path, sha256: c.sha256, size: c.size, deleted: false, rev: head, device });
        results.push({ path: c.path, rev: head });
      }
      return { rev: head, results };
    },
    async usage() { return { bytes: 0, files: rows.size, limits: LIMITS }; },
    async orphans() { return []; },
    async remove() {},
  };
  return account;
}

let clock = 1_800_000_000_000;
function browser(account, device) {
  const fs = createMemFs({ writable: ['/data', '/tmp'], persisted: ['/data'], now: () => ++clock });
  const events = [];
  let hashes = 0;
  const sync = createSync({ fs, cloud: account, digest: async (b) => { hashes++; return digest(b); }, device, now: () => clock, onEvent: (e) => events.push(e) });
  fs.onChange = (p) => sync.noteChange(p);
  const write = (rel, content) => {
    fs.call('mkdir', { path: `/data/${rel.slice(0, rel.lastIndexOf('/'))}`, recursive: true });
    fs.call('write', { path: `/data/${rel}`, flag: 'w' }, text(content));
  };
  const read = (rel) => Buffer.from(fs.call('read', { path: `/data/${rel}` })).toString('utf8');
  const exists = (rel) => fs.call('stat', { path: `/data/${rel}`, quiet: true }) !== null;
  const list = (dir) => fs.call('readdir', { path: `/data/${dir}` }).entries.map((e) => e.name);
  /** Every file that travels, as { rel: content }. */
  const snapshot = () => Object.fromEntries(fs.files('/data/worlds').map(([p]) => p.slice(6)).filter(inScope).sort().map((rel) => [rel, read(rel)]));
  return { fs, sync, events, write, read, exists, list, snapshot, hashes: () => hashes };
}

function world(b, wid = 'vale') {
  b.write(`worlds/${wid}/world.json`, `{"name":"${wid}"}`);
  b.write(`worlds/${wid}/entities/inn.json`, '{"id":"inn","name":"The Inn"}');
  b.write(`worlds/${wid}/entities/king.json`, '{"id":"king","name":"The King"}');
  b.write(`worlds/${wid}/assets/map.png`, 'PNG bytes');
  // these stay in the browser that made them
  b.write(`worlds/${wid}/.history/inn/1.json`, '{"old":true}');
  b.write(`worlds/${wid}/exports/book.pdf`, '%PDF');
  b.write(`worlds/${wid}/entities/.inn.json-1234.tmp`, 'half');
}

test('what one browser makes, another receives; history, exports and temporary files stay put', async () => {
  const account = fakeAccount();
  const a = browser(account, 'Chrome on Windows'), b = browser(account, 'Safari on iOS');
  world(a);
  await a.sync.syncNow();
  assert.deepEqual([...account.rows.keys()].sort(), ['worlds/vale/assets/map.png', 'worlds/vale/entities/inn.json', 'worlds/vale/entities/king.json', 'worlds/vale/world.json']);
  await b.sync.syncNow();
  assert.deepEqual(b.snapshot(), a.snapshot());
  assert.ok(!b.exists('worlds/vale/.history') && !b.exists('worlds/vale/exports'));
  assert.equal(a.sync.status().state, 'idle');
  assert.ok(b.events.some((e) => e.type === 'changed' && e.count === 4));

  // an edit travels; nothing else is sent again
  const uploads = account.calls.upload;
  b.write('worlds/vale/entities/inn.json', '{"id":"inn","name":"The Prancing Pony"}');
  await b.sync.syncNow();
  assert.equal(account.calls.upload, uploads + 1);
  await a.sync.syncNow();
  assert.equal(a.read('worlds/vale/entities/inn.json'), '{"id":"inn","name":"The Prancing Pony"}');

  // a browser that comes back later sees only what changed, and hashes only what changed
  const before = a.hashes();
  a.sync.scanAll();
  await a.sync.syncNow();
  assert.equal(a.hashes(), before, 'unchanged files are not hashed again');
});

test('an entry changed in two browsers keeps both versions, and both browsers end up the same', async () => {
  const account = fakeAccount();
  const a = browser(account, 'Chrome on Windows'), b = browser(account, 'Firefox on Linux');
  world(a);
  await a.sync.syncNow();
  await b.sync.syncNow();

  a.write('worlds/vale/entities/king.json', '{"id":"king","name":"King Aldric"}');
  b.write('worlds/vale/entities/king.json', '{"id":"king","name":"King Bors"}');
  await a.sync.syncNow();
  await b.sync.syncNow(); // refused, pulls, keeps A's version beside its own, sends its own
  await a.sync.syncNow();

  assert.deepEqual(a.snapshot(), b.snapshot());
  assert.equal(a.read('worlds/vale/entities/king.json'), '{"id":"king","name":"King Bors"}');
  const copies = b.list('worlds/vale/entities').filter((n) => n.startsWith('king (MundusMaker sync copy from Chrome on Windows '));
  assert.equal(copies.length, 1, b.list('worlds/vale/entities').join(', '));
  assert.equal(b.read(`worlds/vale/entities/${copies[0]}`), '{"id":"king","name":"King Aldric"}');
  // the app recognises the copy like a folder-sync conflict (server.js syncCopyOf)
  assert.match(copies[0], /^king [(]/);

  // the same change made twice is no conflict at all
  a.write('worlds/vale/world.json', '{"name":"Vale of Mist"}');
  b.write('worlds/vale/world.json', '{"name":"Vale of Mist"}');
  await a.sync.syncNow();
  await b.sync.syncNow();
  assert.deepEqual(b.list('worlds/vale/entities').filter((n) => n.includes('sync copy')).length, 1);
  assert.ok(!b.exists('.conflicts'));

  // a world.json changed differently in both keeps the other version in .conflicts
  a.write('worlds/vale/world.json', '{"name":"Mistvale"}');
  b.write('worlds/vale/world.json', '{"name":"Vale"}');
  await a.sync.syncNow();
  await b.sync.syncNow();
  await a.sync.syncNow();
  assert.equal(a.read('worlds/vale/world.json'), '{"name":"Vale"}');
  assert.equal(b.list('.conflicts').length, 1);
  assert.equal(b.read(`.conflicts/${b.list('.conflicts')[0]}`), '{"name":"Mistvale"}');
});

test('deletions go to the other browser’s trash, where Recover finds them, and an edit outlives a deletion', async () => {
  const account = fakeAccount();
  const a = browser(account, 'Chrome on Windows'), b = browser(account, 'Edge on Windows');
  world(a);
  world(a, 'peaks');
  await a.sync.syncNow();
  await b.sync.syncNow();

  // server.js deletes an entry by moving it to the trash
  a.fs.call('mkdir', { path: '/data/.trash', recursive: true });
  a.fs.call('rename', { from: '/data/worlds/vale/entities/inn.json', to: '/data/.trash/vale--inn--1800000000001.json' });
  await a.sync.syncNow();
  await b.sync.syncNow();
  assert.ok(!b.exists('worlds/vale/entities/inn.json'));
  assert.ok(b.list('.trash').some((n) => /^vale--inn--\d{10,17}\.json$/.test(n)), b.list('.trash').join(', '));

  // a whole world: B trashes it in one piece, in the format a deleted world has
  a.fs.call('rename', { from: '/data/worlds/peaks', to: '/data/.trash/peaks-1800000000002' });
  await a.sync.syncNow();
  await b.sync.syncNow();
  assert.ok(!b.exists('worlds/peaks'));
  const trashed = b.list('.trash').find((n) => /^peaks-\d{10,17}$/.test(n));
  assert.ok(trashed, b.list('.trash').join(', '));
  assert.ok(b.exists(`.trash/${trashed}/entities/king.json`));

  // deleted in A while B edited it: B's edit wins and comes back to A
  a.fs.call('rename', { from: '/data/worlds/vale/entities/king.json', to: '/data/.trash/vale--king--1800000000003.json' });
  b.write('worlds/vale/entities/king.json', '{"id":"king","name":"Edited while deleted"}');
  await a.sync.syncNow();
  await b.sync.syncNow();
  await a.sync.syncNow();
  assert.equal(a.read('worlds/vale/entities/king.json'), '{"id":"king","name":"Edited while deleted"}');
  assert.deepEqual(a.snapshot(), b.snapshot());

  // a world deleted in A while B has unsent changes in it is kept, and sent back
  b.write('worlds/vale/entities/queen.json', '{"id":"queen","name":"The Queen"}');
  account.offline = true;
  await assert.rejects(b.sync.syncNow());
  assert.equal(b.sync.status().state, 'offline');
  account.offline = false;
  a.fs.call('rename', { from: '/data/worlds/vale', to: '/data/.trash/vale-1800000000004' });
  await a.sync.syncNow();
  await b.sync.syncNow();
  assert.ok(b.exists('worlds/vale/entities/queen.json') && b.exists('worlds/vale/world.json'));
  await a.sync.syncNow();
  assert.ok(a.exists('worlds/vale/entities/queen.json'), 'the world came back to A');
  assert.deepEqual(a.snapshot(), b.snapshot());
});

test('rows the app would never write are skipped, and a full account keeps changes waiting', async () => {
  const account = fakeAccount();
  // rows a damaged or hostile account could hold: none may land outside a world's files
  const evil = text('pwned');
  account.objects.set(await digest(evil), evil);
  for (const [i, p] of ['../config/mundusmaker.config.json', 'worlds/x/../../config/a.json', 'worlds/x/.history/a.json', 'config/x.json', 'worlds/X/world.json', 'worlds/x/entities/a/b.json'].entries()) {
    account.rows.set(p, { path: p, sha256: await digest(evil), size: 5, deleted: false, rev: i + 1 });
  }
  const b = browser(account, 'Chrome on Android');
  await b.sync.syncNow();
  assert.deepEqual(b.list(''), [], 'nothing was written');
  assert.equal(b.sync.head, 6, 'the skipped rows still count as seen');

  const full = fakeAccount({ maxBytes: 0 });
  const c = browser(full, 'Chrome on Windows');
  world(c);
  await assert.rejects(c.sync.syncNow(), (err) => err.kind === 'full');
  assert.equal(c.sync.status().state, 'full');
  assert.match(c.sync.status().message, /storage is full/);
  assert.ok(c.sync.pending > 0, 'the changes wait for room');
});

test('a row whose bytes the account lost is healed from a browser that has them', async () => {
  const account = fakeAccount();
  const a = browser(account, 'Chrome on Windows'), b = browser(account, 'Edge on Windows');
  world(a);
  await a.sync.syncNow();
  await b.sync.syncNow();
  a.write('worlds/vale/entities/inn.json', '{"id":"inn","name":"Lost and found"}');
  await a.sync.syncNow();
  account.objects.delete(account.rows.get('worlds/vale/entities/inn.json').sha256);
  await b.sync.syncNow(); // can't fetch it, keeps its own copy and sends that
  assert.match(b.sync.status().message || '', /could not be fetched/);
  assert.equal(b.read('worlds/vale/entities/inn.json'), '{"id":"inn","name":"The Inn"}');
  await a.sync.syncNow();
  assert.deepEqual(a.snapshot(), b.snapshot(), 'both browsers agree again');
  assert.ok(account.objects.has(account.rows.get('worlds/vale/entities/inn.json').sha256));
});

test('sync state survives a reload: bases and head come back from the store', async () => {
  const account = fakeAccount();
  const a = browser(account, 'Chrome on Windows');
  world(a);
  await a.sync.syncNow();
  const kept = a.sync.takeChanges();
  const records = kept.bases.map(([p, base]) => ({ path: p, ...base }));
  const meta = Object.fromEntries(kept.meta);
  // the same browser, next visit: its files, plus what sync kept
  const again = createSync({ fs: a.fs, cloud: account, digest, device: 'Chrome on Windows' });
  again.load({ sync: records, meta });
  assert.equal(again.scanAll(), 0, 'nothing to send: every file matches what was synced');
  assert.equal(again.head, a.sync.head);
});
