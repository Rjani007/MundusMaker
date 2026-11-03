'use strict';
// First start beside an older install: worlds come over by copy only, the old
// folder never changes, nothing is duplicated, and anything ambiguous waits
// for the GM's choice. Runs a copy of this app in a temporary parent folder
// with no data-folder argument, exactly as a launcher starts it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net'), http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createHash } = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');

function copyApp(dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const file of ['server.js', 'package.json']) fs.copyFileSync(path.join(ROOT, file), path.join(dest, file));
  for (const dir of ['scripts', 'sample']) fs.cpSync(path.join(ROOT, dir), path.join(dest, dir), { recursive: true });
  fs.mkdirSync(path.join(dest, 'public'), { recursive: true });
}
function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
const entry = (id, name, text) => JSON.stringify({ id, name, type: 'npc', tags: [], blocks: [{ id: 'b1', kind: 'text', text }], relations: [] });

/** A fake older install: its own sample, the untouched sample world, and a real campaign. */
function makeOld(dir, { version = '1.7.0', dataDir = path.join(dir, 'data'), port, pack = true } = {}) {
  write(path.join(dir, 'package.json'), JSON.stringify({ name: 'mundusmaker', version }));
  write(path.join(dir, 'server.js'), '// old server');
  fs.mkdirSync(path.join(dir, 'public'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'sample'), path.join(dir, 'sample'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'sample'), path.join(dataDir, 'worlds', 'the-sundered-reach'), { recursive: true });
  // loading a world adds new built-in categories to world.json; that is not an edit
  const worldJson = path.join(dataDir, 'worlds', 'the-sundered-reach', 'world.json');
  write(worldJson, JSON.stringify({ ...JSON.parse(fs.readFileSync(worldJson, 'utf8')), migratedByApp: true }));
  write(path.join(dataDir, 'worlds', 'blackwater', 'world.json'), JSON.stringify({ name: 'Blackwater' }));
  write(path.join(dataDir, 'worlds', 'blackwater', 'entities', 'mara-vell.json'), entry('mara-vell', 'Mara Vell', 'harbor clerk'));
  write(path.join(dataDir, 'worlds', 'blackwater', 'assets', 'mara.png'), 'not really a png');
  if (pack) {
    write(path.join(dataDir, '.library', 'pack-one', 'meta.json'), JSON.stringify({ id: 'pack-one', name: 'Pack one' }));
    write(path.join(dataDir, '.library', 'pack-one', 'pack.json'), '{}');
  }
  const config = {};
  if (dataDir !== path.join(dir, 'data')) config.dataDir = dataDir;
  if (port) config.port = port;
  if (Object.keys(config).length) write(path.join(dir, 'mundusmaker.config.json'), JSON.stringify(config));
  return { dir, dataDir };
}

function treeHash(dir) {
  const hash = createHash('sha256');
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else hash.update(path.relative(dir, full) + '\0').update(fs.readFileSync(full));
    }
  };
  walk(dir);
  return hash.digest('hex');
}

async function freePort() {
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const { port } = probe.address(); await new Promise((resolve) => probe.close(resolve)); return port;
}

/** A temporary parent folder; servers stop before it is removed (Windows holds their folders). */
function lab(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'mundusmaker-upgrade-'));
  const servers = [], closers = [];
  t.after(async () => {
    for (const server of servers) await server.stop();
    for (const close of closers) await close();
    fs.rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  return { parent, closers, start: async (appDir) => { const server = await start(appDir); servers.push(server); return server; } };
}

async function start(appDir) {
  const port = await freePort();
  const env = { ...process.env };
  for (const name of ['MUNDUSMAKER_DATA', 'TOMEWEAVER_DATA', 'LOREWEAVE_DATA', 'MUNDUSMAKER_CONFIG_DIR', 'PORT']) delete env[name];
  const child = spawn(process.execPath, ['server.js', String(port), '--no-open'], { cwd: appDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
  // a killed process ends with exitCode null and signalCode set, so check both
  const stop = async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); } };
  return { base, api, stop, log: () => log };
}

const worldNames = async (api) => (await api('/api/worlds')).body.map((w) => w.name).sort();

test('the first start copies worlds from the one older install beside it, once', { timeout: 60000 }, async (t) => {
  const { parent, start } = lab(t);
  const old = makeOld(path.join(parent, 'MundusMaker-1.7.0'));
  const app = path.join(parent, 'MundusMaker-new'); copyApp(app);
  // a copy interrupted by a crash leaves a staged world that must never appear
  write(path.join(app, 'data', '.upgrade-staging', 'half-world-1234', 'world.json'), JSON.stringify({ name: 'Half copied' }));
  const before = treeHash(old.dir);

  let server = await start(app);
  assert.deepEqual(await worldNames(server.api), ['Blackwater'], 'the untouched old sample is not copied, and no empty world is added');
  let status = (await server.api('/api/upgrade')).body;
  assert.equal(status.notice.from.version, '1.7.0');
  assert.deepEqual(status.notice.copied.map((w) => w.name), ['Blackwater']);
  assert.equal(status.notice.packs, 1);
  assert.equal(status.choice, null);
  assert.ok(fs.existsSync(path.join(app, 'data', '.library', 'pack-one', 'pack.json')), 'library packs come along');
  assert.ok(!fs.existsSync(path.join(app, 'data', '.upgrade-staging')), 'interrupted staging is cleaned up');
  assert.match(server.log(), /brought over 1 world\(s\)/);
  assert.equal(treeHash(old.dir), before, 'the old install is byte-identical');
  await server.stop();

  // a second start is not a first start: nothing more is copied
  server = await start(app);
  assert.deepEqual(await worldNames(server.api), ['Blackwater']);
  assert.equal((await server.api('/api/upgrade/dismiss', { what: 'notice' })).status, 200);
  assert.equal((await server.api('/api/upgrade')).body.notice, null);

  // copying the same unchanged world again is skipped; a changed one arrives separately
  let copy = (await server.api('/api/upgrade/copy', { path: old.dir })).body;
  assert.deepEqual(copy.copied, []);
  assert.deepEqual(copy.skipped.map((s) => s.reason).sort(), ['already copied', 'untouched sample']);
  write(path.join(old.dataDir, 'worlds', 'blackwater', 'entities', 'mara-vell.json'), entry('mara-vell', 'Mara Vell', 'harbor clerk, now missing'));
  copy = (await server.api('/api/upgrade/copy', { path: old.dir, worldIds: ['blackwater'] })).body;
  assert.equal(copy.copied.length, 1);
  assert.match(copy.copied[0].name, /^Blackwater \(copied again \d{4}-\d{2}-\d{2}\)$/);
  assert.equal((await worldNames(server.api)).length, 2, 'nothing was merged or overwritten');
});

test('ambiguous, synced or still-running older installs wait for the GM', { timeout: 60000 }, async (t) => {
  const { parent, start, closers } = lab(t);
  const fakePort = await freePort();
  const fake = http.createServer();
  closers.push(() => new Promise((resolve) => { fake.closeAllConnections(); fake.close(() => resolve()); if (!fake.listening) resolve(); }));

  // two older installs: nothing is copied without asking
  makeOld(path.join(parent, 'MundusMaker-1.6.0'), { version: '1.6.0' });
  makeOld(path.join(parent, 'MundusMaker-1.7.0'), { version: '1.7.0' });
  const app = path.join(parent, 'MundusMaker-new'); copyApp(app);
  let server = await start(app);
  assert.deepEqual(await worldNames(server.api), ['My World']);
  let choice = (await server.api('/api/upgrade')).body.choice;
  assert.equal(choice.candidates.length, 2);
  const picked = choice.candidates.find((c) => c.version === '1.7.0');
  assert.deepEqual(picked.worlds.map((w) => [w.name, w.copyable]).sort(), [['Blackwater', true], ['The Sundered Reach', false]]);
  const copy = (await server.api('/api/upgrade/copy', { path: picked.path, worldIds: ['blackwater'], packs: true })).body;
  assert.deepEqual(copy.copied.map((w) => w.name), ['Blackwater']);
  assert.equal((await server.api('/api/upgrade')).body.choice, null, 'choosing resolves the question');
  await server.stop();

  // one install that keeps its worlds in a synced folder: offered, never copied
  const parent2 = path.join(parent, 'synced'); fs.mkdirSync(parent2);
  makeOld(path.join(parent2, 'MundusMaker-1.7.0'), { dataDir: path.join(parent, 'Dropbox', 'campaigns') });
  const app2 = path.join(parent2, 'MundusMaker-new'); copyApp(app2);
  server = await start(app2);
  assert.deepEqual(await worldNames(server.api), ['My World']);
  choice = (await server.api('/api/upgrade')).body.choice;
  assert.equal(choice.candidates[0].external, true);
  assert.equal(choice.candidates[0].dataDir, path.join(parent, 'Dropbox', 'campaigns'));
  await server.stop();

  // one install whose server is still running on its own port: asked to quit first
  const parent3 = path.join(parent, 'running'); fs.mkdirSync(parent3);
  const old3 = makeOld(path.join(parent3, 'MundusMaker-1.7.0'), { port: fakePort });
  fake.on('request', (req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ version: '1.7.0', dataDir: old3.dataDir })); });
  fake.listen(fakePort, '127.0.0.1'); await once(fake, 'listening');
  const app3 = path.join(parent3, 'MundusMaker-new'); copyApp(app3);
  server = await start(app3);
  assert.deepEqual(await worldNames(server.api), ['My World']);
  const candidate = (await server.api('/api/upgrade')).body.choice.candidates[0];
  assert.deepEqual(candidate.running, { port: fakePort, version: '1.7.0', canQuit: false });
  assert.equal((await server.api('/api/upgrade/quit-old', { path: candidate.path })).status, 409, 'a pre-1.9 copy is quit by the GM');
});
