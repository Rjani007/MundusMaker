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
