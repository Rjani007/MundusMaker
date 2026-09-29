'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { atomicWrite } = require('../scripts/storage');
const { restoreBackup, recoverTransactions, validateBackup } = require('../scripts/restore');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mundusmaker-storage-test-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'mundusmaker-storage-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const live = path.join(root, 'worlds', 'test');
  fs.mkdirSync(path.join(live, 'entities'), { recursive: true });
  fs.mkdirSync(path.join(live, 'assets'));
  fs.writeFileSync(path.join(live, 'world.json'), '{"name":"Original"}');
  fs.writeFileSync(path.join(live, 'entities', 'old.json'), '{"id":"old","name":"Old","type":"note"}');
  fs.writeFileSync(path.join(live, 'assets', 'portrait.png'), 'old-image');
  return { root, live };
}

const backup = () => ({ loreweave: 1, world: { name: 'Restored' }, entities: [{ id: 'new', name: 'New', type: 'note', date: { month: 1, day: 41 }, customFutureField: 7 }] });

test('failed atomic replacement leaves the exact original bytes and no temporary file', (t) => {
  const { live } = fixture(t);
  const file = path.join(live, 'world.json');
  const original = fs.readFileSync(file);
  const rename = fs.renameSync;
  try {
    fs.renameSync = () => { throw new Error('simulated disk failure'); };
    assert.throws(() => atomicWrite(file, '{"name":"Changed"}'), /disk failure/);
  } finally { fs.renameSync = rename; }
  assert.deepEqual(fs.readFileSync(file), original);
  assert.deepEqual(fs.readdirSync(live).sort(), ['assets', 'entities', 'world.json']);
  atomicWrite(file, '{"name":"Changed"}');
  assert.equal(JSON.parse(fs.readFileSync(file)).name, 'Changed');
});

test('failed snapshot aborts restore without touching world or assets', (t) => {
  const { root, live } = fixture(t);
  const data = backup();
  data.assets = [{ name: 'portrait.png', dataBase64: Buffer.from('new-image').toString('base64') }];
  assert.throws(() => restoreBackup(root, 'test', data, () => { throw new Error('snapshot failed'); }), /snapshot failed/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(live, 'world.json'))).name, 'Original');
  assert.equal(fs.readFileSync(path.join(live, 'assets', 'portrait.png'), 'utf8'), 'old-image');
  assert.deepEqual(fs.readdirSync(path.join(live, 'entities')), ['old.json']);
});

test('invalid backups are rejected in full, including duplicate IDs and unsafe assets', () => {
  for (const change of [
    (b) => b.entities.push({ id: '../escape', name: 'Invalid', type: 'note' }),
    (b) => b.entities.push(b.entities[0]),
    (b) => b.entities.push(null),
    (b) => { b.world = []; },
    (b) => { b.assets = [{ name: '..', dataBase64: '' }]; },
    (b) => { b.assets = [{ name: 'photo.png', dataBase64: 'invalid!' }]; },
    (b) => { b.assets = [{ name: 'CON', dataBase64: '' }]; },
  ]) {
    const b = backup(); change(b);
    assert.throws(() => validateBackup(b));
  }
});

test('legacy null options and large valid image backups remain accepted', () => {
  const b = backup();
  b.world.calendar = null;
  b.world.types = null;
  b.assets = [{ name: 'large.png', dataBase64: Buffer.alloc(2 * 1024 * 1024, 42).toString('base64') }];
  assert.doesNotThrow(() => validateBackup(b));
});

test('publication failure rolls back the complete original world', (t) => {
  const { root, live } = fixture(t);
  const rename = fs.renameSync;
  try {
    fs.renameSync = (src, dest) => {
      if (path.basename(src) === 'next') throw new Error('publication failed');
      return rename(src, dest);
    };
    assert.throws(() => restoreBackup(root, 'test', backup(), () => {}), /publication failed/);
  } finally { fs.renameSync = rename; }
  assert.equal(JSON.parse(fs.readFileSync(path.join(live, 'world.json'))).name, 'Original');
  assert.deepEqual(fs.readdirSync(path.join(live, 'entities')), ['old.json']);
});

test('successful restore preserves old world in trash, legacy assets, dates and unknown fields', (t) => {
  const { root, live } = fixture(t);
  let snapshots = 0;
  assert.deepEqual(restoreBackup(root, 'test', backup(), () => snapshots++), { ok: true, count: 1 });
  assert.equal(snapshots, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(live, 'world.json'))).name, 'Restored');
  assert.deepEqual(fs.readdirSync(path.join(live, 'entities')), ['new.json']);
  assert.equal(fs.readFileSync(path.join(live, 'assets', 'portrait.png'), 'utf8'), 'old-image');
  const saved = JSON.parse(fs.readFileSync(path.join(live, 'entities', 'new.json')));
  assert.equal(saved.date.day, 41);
  assert.equal(saved.customFutureField, 7);
  const previous = path.join(root, '.trash', fs.readdirSync(path.join(root, '.trash'))[0]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(previous, 'world.json'))).name, 'Original');
  assert.equal(fs.readFileSync(path.join(previous, 'assets', 'portrait.png'), 'utf8'), 'old-image');
});

test('startup rolls back a crash between renames, and finalizes a committed restore', (t) => {
  const { root, live } = fixture(t);
  for (const committed of [false, true]) {
    const tx = path.join(root, '.restore-transactions', randomUUID());
    fs.mkdirSync(tx, { recursive: true });
    fs.writeFileSync(path.join(tx, 'transaction.json'), JSON.stringify({ wid: 'test' }));
    fs.renameSync(live, path.join(tx, 'previous'));
    if (committed) {
      fs.mkdirSync(live);
      fs.writeFileSync(path.join(live, 'world.json'), '{"name":"Committed"}');
    }
    recoverTransactions(root);
    assert.equal(JSON.parse(fs.readFileSync(path.join(live, 'world.json'))).name, committed ? 'Committed' : 'Original');
    assert.equal(fs.existsSync(tx), false);
  }
});
