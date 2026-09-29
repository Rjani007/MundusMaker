'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { once } = require('node:events');
const { credentials, createGateway, startContainer, healthcheck } = require('../scripts/container');
const username = 'dm', password = 'regression-only-fixture-passphrase';
const Authorization = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; }
async function close(server) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
async function freePort() { const server = http.createServer(); const port = await listen(server); await close(server); return port; }
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mundusmaker-container-test-'));
  t.after(() => { assert.ok(path.basename(dir).startsWith('mundusmaker-container-test-')); fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

test('container refuses missing, unreadable, weak or multiline credentials', async t => {
  const dir = temporary(t), file = path.join(dir, 'password');
  assert.throws(() => credentials({}), /MUNDUSMAKER_PASSWORD_FILE/);
  assert.throws(() => credentials({ MUNDUSMAKER_PASSWORD_FILE: file }), /Cannot read/);
  for (const value of ['short', password + '\nextra', ' '.repeat(30)]) {
    fs.writeFileSync(file, value);
    assert.throws(() => credentials({ MUNDUSMAKER_PASSWORD_FILE: file }), /single-line/);
  }
  fs.writeFileSync(file, password + '\r\n');
  assert.deepEqual(credentials({ MUNDUSMAKER_PASSWORD_FILE: file }), { username, password });
  assert.throws(() => credentials({ MUNDUSMAKER_USER: 'bad:name', MUNDUSMAKER_PASSWORD_FILE: file }), /MUNDUSMAKER_USER/);
  await assert.rejects(startContainer({ env: {} }), /MUNDUSMAKER_PASSWORD_FILE/);
});

test('gateway authenticates all paths, rejects foreign origins, and forwards bodies and revisions intact', async t => {
  let received = 0;
  const backend = http.createServer(async (req, res) => {
    received++; const chunks = []; for await (const chunk of req) chunks.push(chunk);
    res.writeHead(200, { 'Content-Type': 'application/json', ETag: '"saved-revision"', 'Cache-Control': 'public, max-age=300' });
    res.end(JSON.stringify({ headers: req.headers, method: req.method, url: req.url, body: Buffer.concat(chunks).toString() }));
  });
  const backendPort = await listen(backend); t.after(() => close(backend));
  const gateway = createGateway({ username, password, backendPort });
  const port = await listen(gateway); t.after(() => close(gateway));
  const base = `http://localhost:${port}`;
  for (const url of ['/', '/api/worlds', '/assets/world/portrait.png', '/exports/secret.pdf', '/js/main.js', '/api/library']) {
    for (const auth of ['', 'Basic nonsense', 'Basic ' + Buffer.from('dm:wrong').toString('base64')]) {
      const response = await fetch(base + url, { headers: { Authorization: auth } });
      assert.equal(response.status, 401); assert.match(response.headers.get('www-authenticate'), /Basic/);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
  }
  assert.equal(received, 0);
  for (const headers of [{ Origin: 'https://attacker.invalid' }, { Origin: 'null' }, { Origin: base + '/forged/path' }, { 'Sec-Fetch-Site': 'cross-site' }, { Origin: 'https://attacker.invalid', 'X-Forwarded-Host': 'attacker.invalid' }]) {
    assert.equal((await fetch(base + '/api/worlds', { method: 'POST', headers: { Authorization, ...headers }, body: '{}' })).status, 403);
  }
  assert.equal(received, 0);
  const body = JSON.stringify({ blocks: [{ secret: true, text: 'GM content' }], confirmUse: false });
  const response = await fetch(base + '/api/library/download-5etools', { method: 'POST', headers: {
    Authorization, Origin: base, 'Content-Type': 'application/json', 'If-Match': '"older-revision"',
    Forwarded: 'host=attacker.invalid', 'X-Forwarded-For': 'attacker.invalid',
  }, body });
  assert.equal(response.headers.get('etag'), '"saved-revision"'); assert.equal(response.headers.get('cache-control'), 'no-store');
  const forwarded = await response.json();
  assert.equal(forwarded.body, body); assert.equal(forwarded.headers['if-match'], '"older-revision"');
  assert.equal(forwarded.headers.authorization, undefined); assert.equal(forwarded.headers.forwarded, undefined); assert.equal(forwarded.headers['x-forwarded-for'], undefined);
  assert.equal(forwarded.headers.host, `localhost:${backendPort}`); assert.equal(forwarded.headers.origin, `http://localhost:${backendPort}`);
  const proxy = createGateway({ username, password, backendPort, origin: 'https://campaign.example' });
  const proxyPort = await listen(proxy); t.after(() => close(proxy));
  assert.equal((await fetch(`http://localhost:${proxyPort}/api/worlds`, { headers: { Authorization, Origin: 'https://campaign.example' } })).status, 200);
  assert.equal((await fetch(`http://localhost:${proxyPort}/api/worlds`, { headers: { Authorization, Origin: base } })).status, 403);
});

test('container persists real worlds, assets, library and conflicts across restart without relaxing download consent', async t => {
  const dir = temporary(t), data = path.join(dir, 'volume'), file = path.join(dir, 'password');
  fs.writeFileSync(file, password);
  const env = { ...process.env, PORT: String(await freePort()), MUNDUSMAKER_BACKEND_PORT: String(await freePort()), MUNDUSMAKER_DATA: data, MUNDUSMAKER_PASSWORD_FILE: file };
  let app;
  t.after(async () => { if (app) await app.stop(); });
  const start = async () => { app = await startContainer({ env, host: '127.0.0.1' }); };
  await start();
  const base = `http://localhost:${app.port}`;
  const request = async (url, method = 'GET', body, headers = {}) => {
    const response = await fetch(base + url, { method, headers: { Authorization, Origin: base, ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    let result; try { result = JSON.parse(text); } catch { result = { error: text }; }
    return { status: response.status, etag: response.headers.get('etag'), body: result };
  };
  await healthcheck(env);
  const status = await request('/api/status'); assert.equal(status.body.deployment, 'container'); assert.equal(status.body.dataDir, data);
  assert.equal((await request('/api/config', 'POST', { dataDir: path.join(dir, 'outside-volume'), copyData: true })).status, 409);
  assert.equal(fs.existsSync(path.join(dir, 'outside-volume')), false);
  const world = await request('/api/worlds', 'POST', { name: 'NAS campaign fixture' });
  const prefix = '/api/w/' + world.body.id;
  let entry = { id: 'captain', name: 'Captain', type: 'note', blocks: [{ id: 'secret', kind: 'text', text: 'Fixture secret', secret: true }], relations: [], tags: [], gmOnly: true };
  const first = await request(prefix + '/entities/captain', 'PUT', entry, { 'If-None-Match': '*' }); assert.equal(first.status, 200);
  entry = { ...entry, name: 'Captain updated' };
  assert.equal((await request(prefix + '/entities/captain', 'PUT', entry, { 'If-Match': first.etag })).status, 200);
  assert.equal((await request(prefix + '/entities/captain', 'PUT', { ...entry, name: 'Stale draft' }, { 'If-Match': first.etag })).status, 409);
  const asset = await request(prefix + '/assets', 'POST', { name: 'seal.png', dataBase64: Buffer.from('persistent asset fixture').toString('base64') });
  assert.equal(asset.status, 200, JSON.stringify(asset.body));
  const library = await request('/api/library', 'POST', { name: 'NAS pack', data: { spell: [{ name: 'Fixture Spell', source: 'TEST', level: 0, school: 'V', entries: ['Fixture'] }] } });
  assert.equal(library.status, 200, JSON.stringify(library.body));
  const download = await request('/api/library/download-5etools', 'POST', { confirmUse: false });
  assert.equal(download.status, 400); assert.match(download.body.error, /confirmUse/);
  const downloadCrossSite = await request('/api/library/download-5etools', 'POST', { confirmUse: true }, { Origin: 'https://attacker.invalid' });
  assert.equal(downloadCrossSite.status, 403);
  const before = (await request(prefix + '/backup?assets=1')).body;
  assert.equal(before.assets.length, 1);
  await app.stop(); await start();
  const restored = (await request(prefix + '/entities/captain')).body;
  assert.equal(restored.name, entry.name); assert.equal(restored.gmOnly, true); assert.equal(restored.blocks[0].secret, true);
  assert.deepEqual((await request(prefix + '/backup?assets=1')).body.assets, before.assets);
  assert.ok((await request('/api/library')).body.some(pack => pack.name === 'NAS pack'));
  assert.ok(fs.readdirSync(path.join(data, '.conflicts')).length >= 1);
  await healthcheck(env);
  // An unexpected backend death closes the public gateway and fails the run.
  app.child.kill('SIGKILL'); assert.equal(await app.closed, 1);
  await assert.rejects(fetch(base + '/api/status', { headers: { Authorization } }));
});

test('container does not adopt another backend or leave its own backend running after a port conflict', { timeout: 15000 }, async t => {
  const dir = temporary(t), file = path.join(dir, 'password'); fs.writeFileSync(file, password);
  const busy = http.createServer((req, res) => res.end('unrelated server'));
  const occupied = await listen(busy); t.after(() => close(busy));
  const port = await freePort(), backend = await freePort();
  const env = { ...process.env, MUNDUSMAKER_DATA: path.join(dir, 'volume'), MUNDUSMAKER_PASSWORD_FILE: file };
  await assert.rejects(startContainer({ host: '127.0.0.1', env: { ...env, PORT: String(port), MUNDUSMAKER_BACKEND_PORT: String(occupied) } }), /stopped during container startup/);
  await assert.rejects(fetch(`http://localhost:${port}/api/status`, { headers: { Authorization } }));
  await assert.rejects(startContainer({ host: '127.0.0.1', env: { ...env, PORT: String(occupied), MUNDUSMAKER_BACKEND_PORT: String(backend) } }), /EADDRINUSE/);
  await assert.rejects(fetch(`http://localhost:${backend}/api/status`));
  assert.equal(await (await fetch(`http://localhost:${occupied}`)).text(), 'unrelated server');
});
