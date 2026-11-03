'use strict';
// Second-folder backups (1.9): complete copies, rotation limited to this
// install's own backups, copy-only restores, and never for a data folder
// given on the command line (tests, previews).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const fb = require('../scripts/folderbackup');

const ROOT = path.resolve(__dirname, '..');
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
function treeHash(dir) {
  const hash = createHash('sha256');
  const walk = (d) => { for (const name of fs.readdirSync(d).sort()) { const full = path.join(d, name); if (fs.statSync(full).isDirectory()) walk(full); else hash.update(path.relative(dir, full) + '\0').update(fs.readFileSync(full)); } };
  walk(dir);
  return hash.digest('hex');
}
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mundusmaker-fb-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  return dir;
}
function dataWith(dir) {
  write(path.join(dir, 'worlds', 'blackwater', 'world.json'), JSON.stringify({ name: 'Blackwater' }));
  write(path.join(dir, 'worlds', 'blackwater', 'entities', 'mara.json'), JSON.stringify({ id: 'mara', name: 'Mara', type: 'npc', blocks: [] }));
  write(path.join(dir, 'worlds', 'blackwater', 'assets', 'map.png'), 'png bytes');
  write(path.join(dir, 'worlds', 'blackwater', 'exports', 'big.pdf'), 'not copied');
  return dir;
}

test('a backup is a complete, marked copy and the data folder is untouched', (t) => {
  const root = temp(t), data = dataWith(path.join(root, 'data')), target = path.join(root, 'backups');
  const before = treeHash(data);
  assert.equal(fb.checkTarget(target, data), null);
  const r = fb.runBackup({ dataDir: data, target, installId: 'me', version: '1.9.0', now: new Date('2026-09-28T10:00:00Z') });
  assert.equal(r.worlds, 1);
  const dir = path.join(target, r.name);
  assert.ok(fs.existsSync(path.join(dir, 'worlds', 'blackwater', 'entities', 'mara.json')));
  assert.ok(fs.existsSync(path.join(dir, 'worlds', 'blackwater', 'assets', 'map.png')));
  assert.ok(!fs.existsSync(path.join(dir, 'worlds', 'blackwater', 'exports')), 'exports are not backed up');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, fb.MARKER), 'utf8')).installId, 'me');
  assert.equal(treeHash(data), before);
  assert.ok(!fs.readdirSync(target).some((n) => n.startsWith('.mundusmaker-partial')), 'no partial copy is left');
});

test('rotation removes only this install’s oldest backups', (t) => {
  const root = temp(t), data = dataWith(path.join(root, 'data')), target = path.join(root, 'backups');
  write(path.join(target, 'holiday photos', 'beach.jpg'), 'mine, not MundusMaker’s');
  write(path.join(target, 'notes.txt'), 'hands off');
  fb.runBackup({ dataDir: data, target, installId: 'other', version: '1.9.0', now: new Date('2026-09-01T00:00:00Z') });
  write(path.join(target, `${fb.PREFIX}1999-01-01 00-00-00`, 'readme.txt'), 'looks like ours but has no marker');
  for (let day = 10; day < 15; day++) fb.runBackup({ dataDir: data, target, installId: 'me', version: '1.9.0', keep: 3, now: new Date(`2026-09-${day}T00:00:00Z`) });
  const list = fb.listBackups(target, 'me');
  assert.deepEqual(list.filter((b) => b.ours).map((b) => b.created.slice(0, 10)), ['2026-09-14', '2026-09-13', '2026-09-12']);
  assert.ok(list.some((b) => !b.ours), 'another install’s backup stays');
  assert.ok(fs.existsSync(path.join(target, 'holiday photos', 'beach.jpg')));
  assert.ok(fs.existsSync(path.join(target, 'notes.txt')));
  assert.ok(fs.existsSync(path.join(target, `${fb.PREFIX}1999-01-01 00-00-00`, 'readme.txt')), 'an unmarked folder is not ours to remove');
});

test('targets, schedules and restore paths are checked', (t) => {
  const root = temp(t), data = dataWith(path.join(root, 'data')), target = path.join(root, 'backups');
  assert.match(fb.checkTarget(path.join(data, 'inside'), data), /outside your data folder/);
  assert.match(fb.checkTarget('relative/folder', data), /full path/);
  assert.equal(fb.isDue({ dir: target, everyHours: 24, last: new Date(Date.now() - 3600e3).toISOString() }), false);
  assert.equal(fb.isDue({ dir: target, everyHours: 24, last: new Date(Date.now() - 25 * 3600e3).toISOString() }), true);
  assert.equal(fb.isDue({ dir: '' }), false);
  const r = fb.runBackup({ dataDir: data, target, installId: 'me', version: '1.9.0' });
  assert.ok(fb.backupWorldDir(target, r.name, 'blackwater'));
  for (const [name, wid] of [[r.name, '../data'], ['../data', 'blackwater'], [r.name, 'missing'], ['notes', 'blackwater']]) assert.equal(fb.backupWorldDir(target, name, wid), null, `${name} / ${wid}`);
});

async function freePort() {
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const { port } = probe.address(); await new Promise((resolve) => probe.close(resolve)); return port;
}
async function startServer(appDir, args = []) {
  const port = await freePort();
  const env = { ...process.env };
  for (const name of ['MUNDUSMAKER_DATA', 'TOMEWEAVER_DATA', 'LOREWEAVE_DATA', 'MUNDUSMAKER_CONFIG_DIR', 'PORT']) delete env[name];
  const child = spawn(process.execPath, ['server.js', ...args, String(port), '--no-open'], { cwd: appDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', (x) => { log += x; }); child.stderr.on('data', (x) => { log += x; });
  const base = `http://localhost:${port}`;
  for (let i = 0; ; i++) {
    try { if ((await fetch(base + '/api/status')).ok) break; } catch { /* not yet */ }
    if (child.exitCode !== null || i > 300) throw new Error('Server did not start: ' + log);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  const api = async (url, body) => {
    const res = await fetch(base + url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    return { status: res.status, body: await res.json() };
  };
  const stop = async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); } };
  return { api, stop };
}

test('the server backs up on request and restores a world as a copy', { timeout: 60000 }, async (t) => {
  // one cleanup: servers stop before their folder is removed (Windows holds it)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mundusmaker-fb-'));
  const servers = [];
  t.after(async () => {
    for (const s of servers) await s.stop();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const app = path.join(root, 'app');
  fs.mkdirSync(app, { recursive: true });
  for (const file of ['server.js', 'package.json']) fs.copyFileSync(path.join(ROOT, file), path.join(app, file));
  for (const dir of ['scripts', 'sample']) fs.cpSync(path.join(ROOT, dir), path.join(app, dir), { recursive: true });
  fs.mkdirSync(path.join(app, 'public'), { recursive: true });
  const target = path.join(root, 'usb');
  let server = await startServer(app, ['--sample']);
  servers.push(server);
  assert.equal((await server.api('/api/folder-backup')).body.available, true);
  assert.equal((await server.api('/api/folder-backup', { dir: path.join(app, 'data', 'inside') })).status, 400);
  assert.equal((await server.api('/api/folder-backup', { dir: target, everyHours: 24, keep: 3 })).status, 200);
  const run = (await server.api('/api/folder-backup/run', {})).body;
  assert.equal(run.ok, true);
  const listed = (await server.api('/api/folder-backup')).body;
  assert.equal(listed.backups.length, 1);
  assert.ok(listed.settings.last);
  const backupHash = treeHash(target);
  const restored = await server.api('/api/folder-backup/restore', { name: listed.backups[0].name, worldId: 'the-sundered-reach' });
  assert.equal(restored.status, 200);
  assert.notEqual(restored.body.restored.worldId, 'the-sundered-reach', 'a restore never replaces the live world');
  assert.equal((await server.api('/api/worlds')).body.length, 2);
  assert.equal(treeHash(target), backupHash, 'the backup folder is unchanged by a restore');
  assert.equal((await server.api('/api/folder-backup/restore', { name: '../data', worldId: 'the-sundered-reach' })).status, 404);
  await server.stop();

  // a data folder named on the command line never touches the backup folder
  server = await startServer(app, [path.join(root, 'scratch')]);
  servers.push(server);
  const info = (await server.api('/api/folder-backup')).body;
  assert.equal(info.available, false);
  assert.equal((await server.api('/api/folder-backup/run', {})).status, 409);
});
