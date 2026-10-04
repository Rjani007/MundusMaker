'use strict';
// Startup when the port is already taken: hand off only to this same
// MundusMaker; otherwise say who holds the port and exit with a code a
// windowless launcher can act on (3 = other MundusMaker, 4 = other program).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net'), http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const ROOT = path.resolve(__dirname, '..');
const VERSION = require('../package.json').version;

async function freePort() {
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const { port } = probe.address(); await new Promise((resolve) => probe.close(resolve)); return port;
}
function serverEnv(configDir) {
  const env = { ...process.env, MUNDUSMAKER_CONFIG_DIR: configDir };
  for (const name of ['MUNDUSMAKER_DATA', 'TOMEWEAVER_DATA', 'LOREWEAVE_DATA', 'PORT']) delete env[name];
  return env;
}
function launch(dataDir, port, configDir, extra = []) {
  const child = spawn(process.execPath, ['server.js', dataDir, String(port), '--no-open', ...extra],
    { cwd: ROOT, env: serverEnv(configDir), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.log = ''; child.stdout.on('data', (x) => { child.log += x; }); child.stderr.on('data', (x) => { child.log += x; });
  return child;
}
async function started(child, port) {
  for (let i = 0; i < 200; i++) {
    try { const res = await fetch(`http://localhost:${port}/api/status`); if (res.ok) return res.json(); } catch { /* not yet */ }
    if (child.exitCode !== null) throw new Error(child.log);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('Startup timeout: ' + child.log);
}
async function exitOf(child) {
  const [code] = child.exitCode !== null ? [child.exitCode] : await once(child, 'exit');
  return { code, log: child.log };
}

test('a second launch hands off to the same MundusMaker and refuses a different one', { timeout: 30000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mundusmaker-startup-'));
  const running = [];
  t.after(async () => {
    for (const child of running) if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const port = await freePort();
  const first = launch(path.join(tmp, 'data-a'), port, tmp); running.push(first);
  const status = await started(first, port);
  assert.equal(status.app, 'mundusmaker');
  assert.equal(status.version, VERSION);

  const same = await exitOf(launch(path.join(tmp, 'data-a'), port, tmp));
  assert.equal(same.code, 0, same.log);
  assert.match(same.log, /already running on port \d+ with this data folder/);

  const other = await exitOf(launch(path.join(tmp, 'data-b'), port, tmp));
  assert.equal(other.code, 3, other.log);
  assert.match(other.log, new RegExp(`being used by MundusMaker ${VERSION.replace(/\./g, '\\.')}`));
  assert.ok(other.log.includes(path.join(tmp, 'data-a')), 'names the data folder of the running copy');
  assert.match(other.log, /did not start/);
  assert.ok(!fs.existsSync(path.join(tmp, 'data-b', 'worlds')), 'the refused copy never seeded its data folder');
});

test('a port held by another program is reported instead of opened', { timeout: 30000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mundusmaker-startup-'));
  const web = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<h1>not MundusMaker</h1>'); });
  const silent = net.createServer(() => { /* accepts connections and never answers */ });
  t.after(() => { web.close(); silent.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  web.listen(0, '127.0.0.1'); await once(web, 'listening');
  silent.listen(0, '127.0.0.1'); await once(silent, 'listening');

  for (const holder of [web, silent]) {
    const result = await exitOf(launch(path.join(tmp, 'data'), holder.address().port, tmp));
    assert.equal(result.code, 4, result.log);
    assert.match(result.log, /being used by another program/);
  }
});

test('Quit stops the server gracefully, only from its own pages, and --log keeps a log', { timeout: 30000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mundusmaker-startup-'));
  const running = [];
  t.after(async () => {
    for (const child of running) if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const port = await freePort();
  const server = launch(path.join(tmp, 'data'), port, tmp, ['--log']); running.push(server);
  await started(server, port);
  const quit = (headers = {}) => fetch(`http://localhost:${port}/api/quit`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' });

  assert.equal((await quit({ Origin: 'https://example.com' })).status, 403, 'a foreign page cannot stop MundusMaker');
  assert.equal((await quit({ Origin: `http://localhost:${port}`, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal(server.exitCode, null, 'still running');
  const response = await quit({ Origin: `http://localhost:${port}` });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, stopping: true });
  const { code } = await exitOf(server);
  assert.equal(code, 0);

  const log = fs.readFileSync(path.join(tmp, 'logs', 'mundusmaker.log'), 'utf8');
  assert.match(log, /MundusMaker \S+ starting/);
  assert.match(log, /serving on http:\/\/localhost:\d+/);
  assert.match(log, /running in the background/);
  assert.match(log, /stopping \(Quit was chosen\)/);
  assert.match(log, /\[mundusmaker\] stopped/);

  // a copy refused at startup leaves its reason in the log for a windowless launcher
  const holder = http.createServer((req, res) => res.end('not MundusMaker'));
  holder.listen(0, '127.0.0.1'); await once(holder, 'listening');
  t.after(() => holder.close());
  const refused = await exitOf(launch(path.join(tmp, 'data'), holder.address().port, tmp, ['--log']));
  assert.equal(refused.code, 4);
  assert.match(fs.readFileSync(path.join(tmp, 'logs', 'mundusmaker.log'), 'utf8'), /being used by another program/);
});

test('status says when the app was updated while it kept running', { timeout: 30000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mundusmaker-stale-'));
  const app = path.join(tmp, 'app');
  fs.mkdirSync(path.join(app, 'public'), { recursive: true });
  for (const file of ['server.js', 'package.json']) fs.copyFileSync(path.join(ROOT, file), path.join(app, file));
  for (const dir of ['scripts', 'sample']) fs.cpSync(path.join(ROOT, dir), path.join(app, dir), { recursive: true });
  fs.writeFileSync(path.join(app, 'public', 'index.html'), '<!doctype html>');
  const port = await freePort();
  const server = spawn(process.execPath, ['server.js', path.join(tmp, 'data'), String(port), '--no-open'],
    { cwd: app, env: serverEnv(tmp), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  server.log = ''; server.stdout.on('data', (x) => { server.log += x; }); server.stderr.on('data', (x) => { server.log += x; });
  t.after(async () => {
    if (server.exitCode === null) { server.kill(); await once(server, 'exit'); }
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const status = async () => (await fetch(`http://localhost:${port}/api/status`)).json();
  const first = await started(server, port);
  assert.equal(first.restartNeeded, false);
  assert.equal(first.pid, server.pid, 'the tray tells its own server by pid');

  // a new timestamp on the same bytes (a checkout, a copy) is not an update
  const updates = path.join(app, 'scripts', 'updates.js');
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(updates, later, later);
  assert.equal((await status()).restartNeeded, false);
  // pages are read from disk on every request, so changing them needs no restart
  fs.writeFileSync(path.join(app, 'public', 'index.html'), '<!doctype html><title>new</title>');
  assert.equal((await status()).restartNeeded, false);
  // code the running server loaded does
  fs.appendFileSync(updates, '\n// changed by an update\n');
  assert.equal((await status()).restartNeeded, true);
});

test('with the option on, MundusMaker stops once no tab has checked in for a while', { timeout: 30000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mundusmaker-autostop-'));
  const running = [];
  t.after(async () => {
    for (const child of running) if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const post = (port, route, body) => fetch(`http://localhost:${port}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const configFile = path.join(tmp, 'mundusmaker.config.json');

  // off by default; the setting saves to the config file and accepts only the offered choices
  let port = await freePort();
  const plain = launch(path.join(tmp, 'data'), port, tmp); running.push(plain);
  assert.equal((await started(plain, port)).autoStop, 0);
  assert.equal((await post(port, '/api/auto-stop', { minutes: 7 })).status, 400);
  assert.equal((await post(port, '/api/auto-stop', { minutes: 15 })).status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')).autoStop, { minutes: 15 });
  assert.equal((await (await fetch(`http://localhost:${port}/api/status`)).json()).autoStop, 15);
  assert.equal((await post(port, '/api/auto-stop', { minutes: 0 })).status, 200);
  assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).autoStop, undefined);
  plain.kill(); await once(plain, 'exit');

  // a 0.6 s grace (only reachable by editing the config file) keeps the test short
  fs.writeFileSync(configFile, JSON.stringify({ autoStop: { minutes: 0.01 } }));
  port = await freePort();
  const server = launch(path.join(tmp, 'data'), port, tmp, ['--log']); running.push(server);
  await started(server, port);
  const until = Date.now() + 2000;
  while (Date.now() < until) { assert.equal((await post(port, '/api/presence', {})).status, 200); await new Promise((r) => setTimeout(r, 150)); }
  assert.equal(server.exitCode, null, 'a tab that keeps checking in keeps it running');
  const { code } = await exitOf(server); // the tab went quiet
  assert.equal(code, 0, 'a clean stop, so the tray closes quietly');
  assert.match(fs.readFileSync(path.join(tmp, 'logs', 'mundusmaker.log'), 'utf8'), /stopping \(no MundusMaker tab was open for 0\.01 minutes/);
});
