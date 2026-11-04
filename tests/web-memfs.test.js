'use strict';

// MundusMaker on the website keeps server.js's files in memory and IndexedDB
// (web/memfs.js, web/store.js). Its file host must answer exactly like the
// reference host the phone apps are built against (mobile/shared/fsops.js),
// so these tests run the same operations through both and compare.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFsOps } = require('../mobile/shared/fsops');
const { createMemFs } = require('../web/memfs');
const { keepOnDisk } = require('../web/store');

const text = (s) => new TextEncoder().encode(s);

/** A bundle over a real folder, the way the engine's manifest describes the app's files. */
function folderBundle(dir) {
  const real = (rel) => path.join(dir, ...rel.split('/').filter(Boolean));
  return {
    stat(rel) {
      try {
        const s = fs.statSync(real(rel));
        return { type: s.isDirectory() ? 'dir' : 'file', size: s.isDirectory() ? 0 : s.size, mtimeMs: s.mtimeMs };
      } catch { return null; }
    },
    list(rel) { return fs.readdirSync(real(rel), { withFileTypes: true }).map((d) => ({ name: d.name, type: d.isDirectory() ? 'dir' : 'file', size: d.isDirectory() ? 0 : fs.statSync(path.join(real(rel), d.name)).size })); },
    read(rel) { return new Uint8Array(fs.readFileSync(real(rel))); },
  };
}

function both() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mundusmaker-memfs-'));
  for (const d of ['app/sample', 'data', 'tmp']) fs.mkdirSync(path.join(tmp, d), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'app', 'server.js'), 'console.log("hi")');
  fs.writeFileSync(path.join(tmp, 'app', 'sample', 'world.json'), '{"name":"Sample"}');
  const ref = createFsOps({
    '/app': { dir: path.join(tmp, 'app'), writable: false },
    '/data': { dir: path.join(tmp, 'data'), writable: true },
    '/tmp': { dir: path.join(tmp, 'tmp'), writable: true },
  });
  const mem = createMemFs({ writable: ['/data', '/tmp'], persisted: ['/data'], readonly: { '/app': folderBundle(path.join(tmp, 'app')) } });
  const run = (host) => (op, args, data) => {
    try {
      const out = host(op, args, data && Buffer.from(data));
      if (op === 'read') return { bytes: Buffer.from(out).toString('utf8') };
      if (op === 'readmany') {
        const buf = Buffer.from(out);
        const nl = buf.indexOf(10);
        return { head: JSON.parse(buf.subarray(0, nl).toString('utf8')), rest: buf.subarray(nl + 1).toString('utf8') };
      }
      if (op === 'stat') return out && { type: out.type, size: out.size };
      if (op === 'readdir') return out.entries.map((e) => [e.name, e.type, e.type === 'file' ? e.size : 0]);
      return out;
    } catch (err) {
      return { code: err.code };
    }
  };
  return { tmp, ref: run((...a) => ref.call(...a)), mem: run((...a) => mem.call(...a)), memfs: mem, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

test('the browser file host answers like the reference host', (t) => {
  const s = both();
  t.after(s.cleanup);
  const steps = [
    ['mkdir', { path: '/data/a' }],
    ['mkdir', { path: '/data/a' }],
    ['mkdir', { path: '/data/b/c/d', recursive: true }],
    ['mkdir', { path: '/data/b/c', recursive: true }],
    ['mkdir', { path: '/data/q/r' }],
    ['write', { path: '/data/a/x.txt', flag: 'w' }, text('hello')],
    ['write', { path: '/data/a/x.txt', flag: 'a' }, text(' more')],
    ['write', { path: '/data/a/x.txt', flag: 'wx' }, text('again')],
    ['write', { path: '/data/missing/y.txt', flag: 'w' }, text('y')],
    ['write', { path: '/data/a/x.txt/z', flag: 'w' }, text('z'), { code: 'ENOTDIR' }],
    ['write', { path: '/data/a', flag: 'w' }, text('z')],
    ['read', { path: '/data/a/x.txt' }],
    ['read', { path: '/data/a' }],
    ['read', { path: '/data/nope' }],
    ['stat', { path: '/data/a/x.txt', follow: true }],
    ['stat', { path: '/data/a/x.txt/q', follow: true, quiet: true }],
    ['stat', { path: '/data/a/x.txt/q', follow: true }, undefined, { code: 'ENOTDIR' }],
    ['stat', { path: '/data/zzz', follow: false, quiet: true }],
    ['stat', { path: '/data/zzz', follow: true }],
    ['readdir', { path: '/data' }],
    ['readdir', { path: '/data/a/x.txt' }],
    ['readdir', { path: '/data/none' }],
    ['rename', { from: '/data/a/x.txt', to: '/data/b/x.txt' }],
    ['rename', { from: '/data/a/nope', to: '/data/b/nope' }],
    ['rename', { from: '/data/b', to: '/data/b/c/e' }, undefined, { code: 'EINVAL' }],
    ['rename', { from: '/data/b/x.txt', to: '/data/none/x.txt' }],
    ['write', { path: '/data/b/y.txt', flag: 'w' }, text('old y')],
    ['rename', { from: '/data/b/x.txt', to: '/data/b/y.txt' }],
    ['read', { path: '/data/b/y.txt' }],
    ['readdir', { path: '/data/b' }],
    ['copy', { from: '/data/b/y.txt', to: '/data/a/copy.txt' }],
    ['copy', { from: '/data/b/y.txt', to: '/data/a/copy.txt', excl: true }],
    ['copy', { from: '/app/sample/world.json', to: '/data/a/world.json' }],
    ['read', { path: '/data/a/world.json' }],
    ['unlink', { path: '/data/a/copy.txt' }],
    ['unlink', { path: '/data/a/copy.txt' }],
    ['rmdir', { path: '/data/b' }],
    ['rmdir', { path: '/data/b/c/d' }],
    ['rmdir', { path: '/data/b/c/d' }],
    ['readmany', { paths: ['/data/b/y.txt', '/data/gone.txt', '/data/a/world.json'] }],
    ['realpath', { path: '/data/./a/../a' }],
    ['realpath', { path: '/data/nowhere' }],
    ['rm', { path: '/data/nowhere', force: true }],
    ['rm', { path: '/data/nowhere' }],
    ['rm', { path: '/data/b', recursive: true }],
    ['stat', { path: '/data/b', quiet: true }],
    ['readdir', { path: '/data' }],
    ['write', { path: '/app/new.txt', flag: 'w' }, text('no')],
    ['read', { path: '/app/server.js' }],
    ['stat', { path: '/app/sample', follow: true }],
    ['readdir', { path: '/app' }],
    ['readdir', { path: '/app/sample' }],
    ['read', { path: '/app/missing.js' }],
    ['stat', { path: '/etc/passwd', follow: true }],
    ['read', { path: '/data/../etc/passwd' }],
    ['read', { path: 'relative/path' }],
    ['read', { path: '/data/a\\..\\..\\x' }],
    ['rename', { from: '/data', to: '/tmp/data' }],
    ['rm', { path: '/data', recursive: true }],
    ['rmdir', { path: '/tmp' }],
    ['mkdir', { path: '/app/x' }],
  ];
  // a few answers are POSIX's (the phone hosts' and macOS's), which Windows words differently
  for (const [op, args, data, posix] of steps) {
    const got = s.mem(op, args, data);
    const want = s.ref(op, args, data);
    if (posix) {
      assert.deepEqual(got, posix, `${op} ${JSON.stringify(args)}`);
      if (process.platform !== 'win32') assert.deepEqual(want, posix, `reference: ${op} ${JSON.stringify(args)}`);
    } else {
      assert.deepEqual(got, want, `${op} ${JSON.stringify(args)}`);
    }
  }
});

test('mkdtemp, folder moves and the rules the reference host can only show on Linux', (t) => {
  const s = both();
  t.after(s.cleanup);
  const made = s.mem('mkdtemp', { prefix: '/tmp/restore-' });
  assert.match(made.path, /^\/tmp\/restore-[A-Za-z0-9]{6}$/);
  assert.match(s.mem('mkdtemp', { prefix: '/tmp/' }).path, /^\/tmp\/[A-Za-z0-9]{6}$/);
  assert.deepEqual(s.mem('mkdtemp', { prefix: '/tmp' }), { code: 'EACCES' }, 'never beside a root');

  // a whole folder moves with everything in it, as a world goes to the trash
  s.mem('mkdir', { path: '/data/worlds/w/entities', recursive: true });
  s.mem('write', { path: '/data/worlds/w/world.json', flag: 'w' }, text('{}'));
  s.mem('write', { path: '/data/worlds/w/entities/e.json', flag: 'w' }, text('{"id":"e"}'));
  s.mem('mkdir', { path: '/data/.trash' });
  assert.deepEqual(s.mem('rename', { from: '/data/worlds/w', to: '/data/.trash/w-1' }), {});
  assert.deepEqual(s.mem('read', { path: '/data/.trash/w-1/entities/e.json' }), { bytes: '{"id":"e"}' });
  assert.deepEqual(s.mem('stat', { path: '/data/worlds/w', quiet: true }), null);
  assert.deepEqual(s.mem('readdir', { path: '/data/worlds' }), []);

  // POSIX rename(2): a folder replaces only an empty folder, never a file
  s.mem('mkdir', { path: '/data/x/inner', recursive: true });
  s.mem('mkdir', { path: '/data/y' });
  s.mem('write', { path: '/data/f.txt', flag: 'w' }, text('f'));
  assert.deepEqual(s.mem('rename', { from: '/data/x', to: '/data/.trash/w-1' }), { code: 'ENOTEMPTY' });
  assert.deepEqual(s.mem('rename', { from: '/data/x', to: '/data/f.txt' }), { code: 'ENOTDIR' });
  assert.deepEqual(s.mem('rename', { from: '/data/f.txt', to: '/data/y' }), { code: 'EISDIR' });
  assert.deepEqual(s.mem('rename', { from: '/data/x', to: '/data/y' }), {});
  assert.deepEqual(s.mem('readdir', { path: '/data/y' }), [['inner', 'dir', 0]]);
  assert.deepEqual(s.mem('unlink', { path: '/data/y' }), { code: 'EISDIR' });
  assert.deepEqual(s.mem('rm', { path: '/data/y' }), { code: 'ERR_FS_EISDIR' });

  // the runtime may hand over a view of a bigger buffer, and may change it afterwards
  const big = text('0123456789');
  s.mem('write', { path: '/data/view.txt', flag: 'w' }, big.subarray(2, 5));
  big.fill(65);
  assert.deepEqual(s.mem('read', { path: '/data/view.txt' }), { bytes: '234' });
  const out = s.memfs.call('read', { path: '/data/view.txt' });
  out.fill(66);
  assert.deepEqual(s.mem('read', { path: '/data/view.txt' }), { bytes: '234' }, 'what a read hands out is a copy');
});

test('changes are reported for keeping, and a reload from them rebuilds the same folders', () => {
  const blobs = new Map();
  const readBlob = (b) => blobs.get(b);
  const a = createMemFs({ writable: ['/data', '/tmp'], persisted: ['/data'], readBlob });
  a.call('mkdir', { path: '/data/worlds/w/entities', recursive: true });
  a.call('write', { path: '/data/worlds/w/world.json', flag: 'w' }, text('{"name":"W"}'));
  a.call('write', { path: '/data/worlds/w/entities/e.json', flag: 'w' }, text('{"id":"e"}'));
  a.call('write', { path: '/tmp/scratch.txt', flag: 'w' }, text('not kept'));
  a.call('write', { path: '/data/worlds/w/entities/gone.json', flag: 'w' }, text('{}'));
  a.call('unlink', { path: '/data/worlds/w/entities/gone.json' });

  const records = new Map();
  const keep = () => {
    for (const { path: p, node } of a.takeChanges()) {
      if (!node) { records.delete(p); continue; }
      const rec = { path: p, type: node.type, size: node.size, mtimeMs: node.mtimeMs, ctimeMs: node.ctimeMs, birthtimeMs: node.birthtimeMs, mode: node.mode };
      if (node.type === 'file') {
        if (keepOnDisk(p, node.size)) { const blob = {}; blobs.set(blob, a.bytes(p)); rec.blob = blob; } else rec.bytes = a.bytes(p).slice().buffer;
      }
      records.set(p, rec);
    }
  };
  keep();
  assert.ok(!a.hasChanges());
  assert.ok(![...records.keys()].some((p) => p.startsWith('/tmp')), 'the temporary folder is never kept');
  assert.ok(!records.has('/data/worlds/w/entities/gone.json'), 'a removed file is removed from the store too');

  // big and rarely read files are kept as Blobs and read when asked for
  const picture = new Uint8Array(200 * 1024).map((_, i) => i % 251);
  a.call('mkdir', { path: '/data/worlds/w/assets' });
  a.call('write', { path: '/data/worlds/w/assets/map.png', flag: 'w' }, picture);
  a.call('mkdir', { path: '/data/.trash' });
  a.call('write', { path: '/data/.trash/w--old--1700000000000.json', flag: 'w' }, text('{"id":"old"}'));
  keep();
  assert.ok(records.get('/data/worlds/w/assets/map.png').blob, 'a big file is a Blob');
  assert.ok(records.get('/data/.trash/w--old--1700000000000.json').blob, 'the trash is kept on disk however small');
  assert.ok(records.get('/data/worlds/w/world.json').bytes, 'small files are loaded at start');

  const b = createMemFs({ writable: ['/data', '/tmp'], persisted: ['/data'], readBlob });
  b.load([...records.values()]);
  assert.ok(!b.hasChanges(), 'loading reports nothing to keep');
  const list = (m, p) => m.call('readdir', { path: p }).entries.map((e) => [e.name, e.type, e.size]);
  for (const dir of ['/data', '/data/worlds', '/data/worlds/w', '/data/worlds/w/entities', '/data/worlds/w/assets', '/data/.trash']) {
    assert.deepEqual(list(b, dir), list(a, dir), dir);
  }
  assert.deepEqual(Buffer.from(b.call('read', { path: '/data/worlds/w/assets/map.png' })), Buffer.from(picture));
  assert.equal(Buffer.from(b.call('read', { path: '/data/worlds/w/world.json' })).toString(), '{"name":"W"}');
  assert.deepEqual(b.call('stat', { path: '/tmp/scratch.txt', quiet: true }), null);

  // a copy shares the Blob instead of reading it (snapshots of pictures cost nothing)
  b.call('mkdir', { path: '/data/.snapshots/w/s1/assets', recursive: true });
  b.call('copy', { from: '/data/worlds/w/assets/map.png', to: '/data/.snapshots/w/s1/assets/map.png' });
  assert.equal(b.node('/data/.snapshots/w/s1/assets/map.png').blob, b.node('/data/worlds/w/assets/map.png').blob);

  // the store hands back a file's on-disk Blob; a file changed since keeps its bytes
  const fresh = createMemFs({ writable: ['/data'], persisted: ['/data'], readBlob });
  fresh.call('write', { path: '/data/p.png', flag: 'w' }, picture);
  const ver = fresh.node('/data/p.png').ver;
  const disk = {};
  blobs.set(disk, picture);
  fresh.adoptBlob('/data/p.png', ver, disk);
  assert.equal(fresh.node('/data/p.png').data, null, 'the bytes left memory');
  assert.equal(Buffer.from(fresh.call('read', { path: '/data/p.png' })).length, picture.length);
  fresh.call('write', { path: '/data/p.png', flag: 'w' }, text('new'));
  fresh.adoptBlob('/data/p.png', ver, disk);
  assert.equal(Buffer.from(fresh.call('read', { path: '/data/p.png' })).toString(), 'new', 'an old Blob never replaces newer bytes');
});

test('a damaged store still loads: missing folders are made, files under a file are skipped', () => {
  const m = createMemFs({ writable: ['/data'], persisted: ['/data'] });
  m.load([
    { path: '/data/worlds/w/entities/e.json', type: 'file', size: 2, mtimeMs: 1, bytes: text('{}').buffer },
    { path: '/data/f', type: 'file', size: 1, mtimeMs: 1, bytes: text('x').buffer },
    { path: '/data/f/under.json', type: 'file', size: 2, mtimeMs: 1, bytes: text('{}').buffer },
    { path: '/elsewhere/x', type: 'file', size: 1, mtimeMs: 1, bytes: text('x').buffer },
    null,
  ]);
  assert.equal(m.call('stat', { path: '/data/worlds/w/entities', follow: true }).type, 'dir');
  assert.equal(Buffer.from(m.call('read', { path: '/data/worlds/w/entities/e.json' })).toString(), '{}');
  assert.equal(m.call('stat', { path: '/data/f/under.json', quiet: true }), null);
  assert.ok(m.takeChanges().some((c) => c.path === '/data/worlds/w'), 'the folders it had to make are kept');
});
