'use strict';
// Sync-tool conflict copies are reported as copies (not damage), never loaded
// as duplicate entries, never modified, and still block a JSON backup that
// could otherwise miss the edits they hold.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const ROOT = path.resolve(__dirname, '..');

test('sync conflict copies are explained, left untouched and never loaded twice', { timeout: 30000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mundusmaker-sync-copies-'));
  const ents = path.join(tmp, 'data', 'worlds', 'w1', 'entities');
  fs.mkdirSync(ents, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'data', 'worlds', 'w1', 'world.json'), JSON.stringify({ name: 'Copies' }));
  const entry = (id, name, text) => JSON.stringify({ id, name, type: 'npc', tags: [], blocks: [{ id: 'b1', kind: 'text', text }], relations: [] });
  const files = {
    'mara-vell.json': entry('mara-vell', 'Mara Vell', 'desk copy'),
    "mara-vell (Rishi's conflicted copy 2026-09-20).json": entry('mara-vell', 'Mara Vell', 'laptop copy'),
    'mara-vell.sync-conflict-20260920-101010-ABCDEFG.json': entry('mara-vell', 'Mara Vell', 'tablet copy'),
    'ghost (1).json': entry('ghost', 'The Ghost', 'only copy'),
    'broken.json': '{ not json',
  };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(ents, name), text);

  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
  const env = { ...process.env, MUNDUSMAKER_CONFIG_DIR: tmp };
  for (const name of ['MUNDUSMAKER_DATA', 'TOMEWEAVER_DATA', 'LOREWEAVE_DATA', 'PORT']) delete env[name];
  const child = spawn(process.execPath, ['server.js', path.join(tmp, 'data'), String(port), '--no-open'],
    { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', (x) => { log += x; }); child.stderr.on('data', (x) => { log += x; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const base = `http://localhost:${port}`;
  for (let i = 0; ; i++) {
    try { if ((await fetch(base + '/api/status')).ok) break; } catch { /* not yet */ }
    if (child.exitCode !== null || i > 200) throw new Error('Server did not start: ' + log);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }

  const listing = await (await fetch(base + '/api/w/w1/entities?details')).json();
  assert.deepEqual(listing.entities.map((e) => e.id), ['mara-vell'], 'copies are never loaded as duplicate entries');
  assert.equal(listing.entities[0].blocks[0].text, 'desk copy');
  const byFile = Object.fromEntries(listing.issues.map((issue) => [issue.file, issue]));
  const dropbox = byFile["entities/mara-vell (Rishi's conflicted copy 2026-09-20).json"];
  assert.equal(dropbox.kind, 'sync-copy');
  assert.equal(dropbox.entityId, 'mara-vell');
  assert.match(dropbox.message, /A copy of “Mara Vell” that Dropbox or Nextcloud made/);
  assert.match(dropbox.message, /MundusMaker uses entities\/mara-vell\.json/);
  assert.match(byFile['entities/mara-vell.sync-conflict-20260920-101010-ABCDEFG.json'].message, /Syncthing made/);
  const ghost = byFile['entities/ghost (1).json'];
  assert.equal(ghost.kind, 'sync-copy');
  assert.match(ghost.message, /main file, entities\/ghost\.json, is missing/);
  assert.equal(byFile['entities/broken.json'].kind, undefined, 'real damage keeps the unreadable-file report');
  assert.match(byFile['entities/broken.json'].message, /could not be read as an entry/);

  let backup = await fetch(base + '/api/w/w1/backup');
  assert.equal(backup.status, 409);
  assert.match((await backup.json()).error, /could not be read/);
  fs.renameSync(path.join(ents, 'broken.json'), path.join(tmp, 'broken.json'));
  backup = await fetch(base + '/api/w/w1/backup');
  assert.equal(backup.status, 409, 'a backup must not silently miss the edits a copy holds');
  assert.match((await backup.json()).error, /sync conflict copies/);

  for (const [name, text] of Object.entries(files)) {
    if (name === 'broken.json') continue;
    assert.equal(fs.readFileSync(path.join(ents, name), 'utf8'), text, `${name} is left untouched`);
  }
});

test('a conflict copy can be compared, adopted or discarded, and everything stays recoverable', { timeout: 30000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mundusmaker-sync-compare-'));
  const world = path.join(tmp, 'data', 'worlds', 'w1'), ents = path.join(world, 'entities');
  fs.mkdirSync(ents, { recursive: true });
  fs.writeFileSync(path.join(world, 'world.json'), JSON.stringify({ name: 'Copies' }));
  const entry = (id, name, text) => JSON.stringify({ id, name, type: 'npc', tags: [], blocks: [{ id: 'b1', kind: 'text', text }], relations: [] });
  fs.writeFileSync(path.join(ents, 'mara.json'), entry('mara', 'Mara', 'desk version'));
  fs.writeFileSync(path.join(ents, 'mara (conflicted copy).json'), entry('mara', 'Mara', 'laptop version'));
  fs.writeFileSync(path.join(ents, 'hobb.json'), entry('hobb', 'Hobb', 'keep me'));
  fs.writeFileSync(path.join(ents, 'hobb.sync-conflict-20260920.json'), entry('hobb', 'Hobb', 'discard me'));

  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
  const env = { ...process.env, MUNDUSMAKER_CONFIG_DIR: tmp };
  for (const name of ['MUNDUSMAKER_DATA', 'TOMEWEAVER_DATA', 'LOREWEAVE_DATA', 'PORT']) delete env[name];
  const child = spawn(process.execPath, ['server.js', path.join(tmp, 'data'), String(port), '--no-open'], { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', (x) => { log += x; }); child.stderr.on('data', (x) => { log += x; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  const base = `http://localhost:${port}`;
  for (let i = 0; ; i++) {
    try { if ((await fetch(base + '/api/status')).ok) break; } catch { /* not yet */ }
    if (child.exitCode !== null || i > 200) throw new Error('Server did not start: ' + log);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  const call = async (file, body) => {
    const res = await fetch(`${base}/api/w/w1/sync-copies/${encodeURIComponent(file)}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    return { status: res.status, body: await res.json() };
  };

  const shown = await call('mara (conflicted copy).json');
  assert.equal(shown.status, 200);
  assert.equal(shown.body.current.blocks[0].text, 'desk version');
  assert.equal(shown.body.copy.blocks[0].text, 'laptop version');
  assert.equal((await call('mara.json')).status, 404, 'a main entry file is not a copy');
  assert.equal((await call('../world.json')).status, 400);
  assert.equal((await call('mara (conflicted copy).json', { action: 'adopt', revision: 'stale' })).status, 409, 'a stale comparison is refused');

  assert.equal((await call('mara (conflicted copy).json', { action: 'adopt', revision: shown.body.revision })).status, 200);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ents, 'mara.json'), 'utf8')).blocks[0].text, 'laptop version');
  assert.ok(!fs.existsSync(path.join(ents, 'mara (conflicted copy).json')));
  const trash = fs.readdirSync(path.join(tmp, 'data', '.trash'));
  assert.ok(trash.some((f) => f.startsWith('w1--mara--')), 'the copy is in the trash');
  const snapshots = fs.readdirSync(path.join(tmp, 'data', '.snapshots', 'w1'));
  assert.ok(snapshots.some((s) => s.includes('pre-adopt')), 'a snapshot was taken first');
  const snap = snapshots.find((s) => s.includes('pre-adopt'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'data', '.snapshots', 'w1', snap, 'entities', 'mara.json'), 'utf8')).blocks[0].text, 'desk version', 'the original survives in the snapshot');

  const hobb = await call('hobb.sync-conflict-20260920.json');
  assert.equal((await call('hobb.sync-conflict-20260920.json', { action: 'discard', revision: hobb.body.revision })).status, 200);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ents, 'hobb.json'), 'utf8')).blocks[0].text, 'keep me');
  assert.ok(fs.readdirSync(path.join(tmp, 'data', '.trash')).some((f) => f.startsWith('w1--hobb--')));
  const listed = await (await fetch(`${base}/api/w/w1/entities?details`)).json();
  assert.deepEqual(listed.issues, [], 'no copies are left to report');
});
