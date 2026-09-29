'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
test('installed configuration survives restart and respects custom and legacy data folders', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mundusmaker-installed-'));
  const support = path.join(tmp, 'Application Support/MundusMaker'), moved = path.join(tmp, 'My campaigns');
  fs.mkdirSync(support, { recursive: true });
  let child;
  const stop = async () => { if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); } };
  t.after(async () => { await stop(); assert.ok(path.basename(tmp).startsWith('mundusmaker-installed-')); fs.rmSync(tmp, { recursive: true, force: true }); });
  async function start() {
    const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
    const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
    const env = { ...process.env, MUNDUSMAKER_CONFIG_DIR: support };
    for (const name of ['MUNDUSMAKER_DATA', 'TOMEWEAVER_DATA', 'LOREWEAVE_DATA']) delete env[name];
    child = spawn(process.execPath, ['server.js', String(port), '--no-open'], { cwd: path.resolve(__dirname, '..'), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', x => { log += x; }); child.stderr.on('data', x => { log += x; });
    const base = `http://localhost:${port}`;
    for (let i = 0; i < 120; i++) {
      try { const response = await fetch(base + '/api/status'); if (response.ok) return { base, status: await response.json() }; } catch {}
      if (child.exitCode !== null) throw new Error(log);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error('Startup timeout: ' + log);
  }
  let running = await start();
  assert.equal(running.status.dataDir, path.join(support, 'data'));
  assert.equal(running.status.configPath, path.join(support, 'mundusmaker.config.json'));
  const oldWorld = path.join(support, 'data/worlds/the-sundered-reach/world.json');
  const original = fs.readFileSync(oldWorld);
  const response = await fetch(running.base + '/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataDir: moved, copyData: true }) });
  assert.equal(response.status, 200);
  assert.deepEqual(fs.readFileSync(oldWorld), original);
  assert.deepEqual(fs.readFileSync(path.join(moved, 'worlds/the-sundered-reach/world.json')), original);
  await stop(); running = await start();
  assert.equal(running.status.dataDir, moved); assert.equal(running.status.configuredVia, 'mundusmaker.config.json');
  await stop();
  fs.renameSync(path.join(support, 'mundusmaker.config.json'), path.join(support, 'loreweave.config.json'));
  running = await start();
  assert.equal(running.status.dataDir, moved); assert.equal(running.status.configuredVia, 'loreweave.config.json');
  assert.deepEqual(fs.readFileSync(oldWorld), original);
});
