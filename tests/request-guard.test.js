'use strict';

// Any web page the GM visits can send requests to the loopback server. These
// tests drive every state-changing route the way a hostile page (or a DNS
// rebinding page) would, and check that nothing on disk changes, that the
// app's own same-origin JSON requests still work, and that uploaded files are
// never served as active content.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { once } = require('events');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const WID = 'the-sundered-reach'; // the sample world's predictable id
const ATTACKER = 'https://attacker.example';

async function freePort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

/** Raw HTTP, so Host, Origin and Sec-Fetch-* can be set the way a browser would. */
function send(port, { method = 'GET', url, headers = {}, body }) {
  const payload = body === undefined ? undefined : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method,
      headers: { Host: `localhost:${port}`, ...headers, ...(payload ? { 'Content-Length': payload.length } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/** Every file and folder under dir, with a hash of each file's bytes. */
function tree(dir) {
  const out = {};
  const walk = (at) => {
    for (const item of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, item.name);
      const rel = path.relative(dir, full);
      if (item.isDirectory()) { out[rel] = 'dir'; walk(full); } else out[rel] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

test('state-changing routes refuse cross-site, rebinding and non-JSON requests; the app itself still writes', { timeout: 60000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mundusmaker-guard-'));
  const data = path.join(tmp, 'data'), config = path.join(tmp, 'config'), moved = path.join(tmp, 'moved-data');
  fs.mkdirSync(config);
  const port = await freePort();
  const env = { ...process.env, MUNDUSMAKER_CONFIG_DIR: config };
  for (const name of ['MUNDUSMAKER_DATA', 'TOMEWEAVER_DATA', 'LOREWEAVE_DATA', 'PORT']) delete env[name];
  const child = spawn(process.execPath, ['server.js', data, String(port), '--no-open'], { cwd: path.resolve(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    assert.ok(path.basename(tmp).startsWith('mundusmaker-guard-'));
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  for (let i = 0; i < 200; i++) {
    try { if ((await send(port, { url: '/api/status' })).status === 200) break; } catch { /* not listening yet */ }
    if (child.exitCode !== null) throw new Error(logs);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }

  // What this app's own page sends: same origin, JSON.
  const own = { Origin: `http://localhost:${port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' };
  const app = (method, url, body, headers = {}) => send(port, { method, url, body, headers: { ...own, ...headers } });
  const scoped = `/api/w/${WID}`;
  const entry = { id: 'entry', name: 'Captain', type: 'note', tags: [], relations: [], blocks: [{ id: 'b', kind: 'text', text: 'Fixture GM secret', secret: true }] };
  let result = await app('PUT', `${scoped}/entities/entry`, entry, { 'If-None-Match': '*' });
  assert.equal(result.status, 200, result.text);
  result = await app('PUT', `${scoped}/entities/entry`, { ...entry, name: 'Captain Vey' }, { 'If-Match': result.headers.etag });
  assert.equal(result.status, 200, result.text);
  const entryRevision = result.headers.etag;
  const stamp = JSON.parse((await app('GET', `${scoped}/entities/entry/history`)).text)[0].stamp;
  const pack = JSON.parse((await app('POST', '/api/library', { name: 'Fixture pack', data: { spell: [{ name: 'Fixture Spell', level: 0 }] } })).text);
  assert.ok(pack.id);
  const snapshot = JSON.parse((await app('GET', '/api/recovery')).text).snapshots.find((item) => item.worldId === WID);
  assert.ok(snapshot, 'the boot snapshot exists');
  const backup = JSON.parse((await app('GET', `${scoped}/backup`)).text);
  const copyName = 'entry (conflicted copy).json';
  fs.writeFileSync(path.join(data, 'worlds', WID, 'entities', copyName), JSON.stringify({ ...entry, name: 'Copy' }));
  const older = path.join(tmp, 'older-install');
  fs.mkdirSync(path.join(older, 'data', 'worlds', 'old-campaign', 'entities'), { recursive: true });
  fs.writeFileSync(path.join(older, 'data', 'worlds', 'old-campaign', 'world.json'), JSON.stringify({ name: 'Old campaign', types: {} }));
  const assetBody = (name, bytes = PNG) => ({ name, dataBase64: bytes.toString('base64') });

  const routes = [
    ['POST', '/api/config', { dataDir: moved, copyData: true }],
    ['POST', '/api/quit', {}],
    ['POST', '/api/folder-backup', { dir: path.join(tmp, 'second') }],
    ['POST', '/api/folder-backup/run', {}],
    ['POST', '/api/folder-backup/restore', { name: 'x', worldId: WID }],
    ['POST', '/api/recovery/restore', { confirm: true, kind: 'snapshot', worldId: WID, stamp: snapshot.stamp }],
    ['POST', '/api/worlds', { name: 'Planted world' }],
    ['DELETE', `/api/worlds/${WID}`, {}],
    ['POST', '/api/library', { name: 'Planted pack', data: { spell: [{ name: 'Planted', level: 0 }] } }],
    ['POST', '/api/library/download-5etools', { confirmUse: false }],
    ['POST', '/api/update-check', { confirm: true }],
    ['POST', '/api/auto-stop', { minutes: 5 }],
    ['POST', '/api/presence', {}],
    // an unknown sheet, so even a guard failure could not reach the network
    ['POST', '/api/sheet-templates/download', { id: 'planted', confirm: true }],
    ['POST', '/api/sheet-templates', { system: 'dnd2024', fileName: 'planted.pdf', dataBase64: Buffer.from('%PDF-1.7 planted').toString('base64') }],
    ['PUT', '/api/sheet-templates/planted', { choices: {} }],
    ['DELETE', '/api/sheet-templates/planted', {}],
    ['DELETE', `/api/library/${pack.id}`, {}],
    ['POST', '/api/scan-path', { path: older }],
    ['POST', '/api/migrate-install', { dataDir: older, worldIds: ['old-campaign'] }],
    ['POST', '/api/upgrade/copy', { path: older, worldIds: ['old-campaign'] }],
    ['POST', '/api/upgrade/dismiss', { what: 'notice' }],
    ['POST', '/api/upgrade/quit-old', { path: path.join(tmp, 'nowhere') }],
    ['PUT', `${scoped}/world`, { ...backup.world, name: 'Defaced' }],
    ['PUT', `${scoped}/entities/entry`, { ...entry, name: 'Defaced' }],
    ['DELETE', `${scoped}/entities/entry`, {}],
    ['POST', `${scoped}/entities/entry/history/${stamp}`, {}],
    ['POST', `${scoped}/assets`, assetBody('probe.html', Buffer.from('<p>probe</p>'))],
    ['POST', `${scoped}/assets`, assetBody('probe.png')],
    ['POST', `${scoped}/sync-copies/${encodeURIComponent(copyName)}`, { action: 'discard', revision: entryRevision }],
    ['POST', `${scoped}/export-file`, assetBody('planted.pdf')],
    ['POST', `${scoped}/restore`, { ...backup, entities: [] }],
    ['POST', '/api/not-a-route', {}], // the guard runs before routing
  ];
  const attacks = [
    ['the reported cross-site simple POST', 403, { 'Content-Type': 'text/plain;charset=UTF-8', Origin: ATTACKER, 'Sec-Fetch-Site': 'cross-site' }],
    ['text/plain with no browser headers', 415, { 'Content-Type': 'text/plain;charset=UTF-8' }],
    ['an HTML form post', 415, { 'Content-Type': 'application/x-www-form-urlencoded' }],
    ['a multipart form post', 415, { 'Content-Type': 'multipart/form-data; boundary=x' }],
    ['no Content-Type', 415, {}],
    ['JSON from a foreign Origin', 403, { 'Content-Type': 'application/json', Origin: ATTACKER }],
    ['JSON marked cross-site', 403, { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' }],
    ['JSON from an opaque origin', 403, { 'Content-Type': 'application/json', Origin: 'null' }],
    ['JSON from another localhost port', 403, { 'Content-Type': 'application/json', Origin: `http://localhost:${port + 1}`, 'Sec-Fetch-Site': 'same-site' }],
    ['JSON from 127.0.0.1 to localhost', 403, { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` }],
    ['JSON through DNS rebinding', 403, { 'Content-Type': 'application/json', Host: `attacker.example:${port}`, Origin: `http://attacker.example:${port}`, 'Sec-Fetch-Site': 'same-origin' }],
  ];

  const before = { data: tree(data), config: tree(config) };
  for (const [method, url, body] of routes) {
    for (const [why, status, headers] of attacks) {
      const response = await send(port, { method, url, headers, body: JSON.stringify(body) });
      assert.equal(response.status, status, `${method} ${url} with ${why}: ${response.status} ${response.text}`);
    }
  }
  assert.equal(child.exitCode, null, 'Quit was refused every time');
  assert.deepEqual(tree(data), before.data, 'no refused request changed the data folder');
  assert.deepEqual(tree(config), before.config, 'no refused request changed the config folder');
  assert.equal(fs.existsSync(moved), false);
  assert.equal((await send(port, { url: `/assets/${WID}/probe.html` })).status, 404);

  // Reads: a rebinding page names its own host, and other sites may not embed API or asset responses.
  const secretRead = await send(port, { url: `${scoped}/entities`, headers: { Host: `attacker.example:${port}` } });
  assert.equal(secretRead.status, 403);
  assert.doesNotMatch(secretRead.text, /Fixture GM secret/);
  fs.writeFileSync(path.join(data, 'worlds', WID, 'assets', 'portrait.png'), PNG);
  for (const url of ['/api/worlds', `${scoped}/entities`, `/assets/${WID}/portrait.png`]) {
    assert.equal((await send(port, { url, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403, url);
    assert.equal((await send(port, { url, headers: { 'Sec-Fetch-Site': 'same-site' } })).status, 403, url);
    assert.equal((await send(port, { url, headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 200, url);
    assert.equal((await send(port, { url })).status, 200, `${url} from a native client`);
  }
  assert.equal((await send(port, { url: '/', headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 200, 'a link from elsewhere still opens the app');
  assert.equal((await send(port, { url: '/', headers: { Host: `attacker.example:${port}` } })).status, 403);

  // A malformed path is answered, not fatal (any page could send one as an <img>).
  assert.equal((await send(port, { url: '/%E0%A4%A' })).status, 400);
  assert.equal((await send(port, { url: '/api/%E0%A4%A' })).status, 400);
  assert.equal((await send(port, { url: '/api/status' })).status, 200, 'the server is still running');

  // The app's own requests, and native clients that send no Origin or Sec-Fetch headers, still work.
  result = await app('POST', '/api/worlds', { name: 'Same-origin world' });
  assert.equal(result.status, 200, result.text);
  result = await send(port, { method: 'POST', url: '/api/worlds', headers: { 'Content-Type': 'application/json' }, body: { name: 'Native world' } });
  assert.equal(result.status, 200, result.text);
  result = await send(port, { method: 'POST', url: '/api/worlds', body: { name: 'Loopback world' },
    headers: { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json; charset=utf-8' } });
  assert.equal(result.status, 200, result.text);
  result = await app('POST', '/api/library/download-5etools', { confirmUse: false });
  assert.equal(result.status, 400, 'the downloader still asks for consent before any network use');
  assert.match(result.text, /confirmUse/);
  // with no repository in package.json the update check answers without any request
  result = await app('POST', '/api/update-check', { confirm: true });
  assert.equal(result.status, 200, result.text);
  assert.equal(JSON.parse(result.text).configured, false);
  result = await app('POST', '/api/update-check', {});
  assert.equal(result.status, 400, 'the update check runs only when asked');
  // publisher sheet downloads: only on request, only sheets from the fixed table
  result = await app('POST', '/api/sheet-templates/download', { id: 'dnd2024-wotc' });
  assert.equal(result.status, 400, 'a sheet downloads only when asked');
  result = await app('POST', '/api/sheet-templates/download', { id: 'https://example.com/x.pdf', confirm: true });
  assert.equal(result.status, 400, 'a page names a sheet, never a URL');
  result = await app('GET', '/api/sheet-templates/sources');
  assert.deepEqual(JSON.parse(result.text).map((s) => s.id), ['dnd2024-wotc', 'coc7-chaosium-1920s', 'coc7-chaosium-modern']);
  result = await app('POST', `${scoped}/entities/entry/history/${stamp}`, undefined, { 'If-Match': entryRevision });
  assert.equal(result.status, 200, result.text);
  result = await app('DELETE', `${scoped}/entities/entry`, undefined, { 'If-Match': result.headers.etag });
  assert.equal(result.status, 200, result.text);
  result = await app('POST', '/api/recovery/restore', { confirm: true, kind: 'snapshot', worldId: WID, stamp: snapshot.stamp });
  assert.equal(result.status, 200, result.text);
  result = await app('POST', `${scoped}/restore`, backup);
  assert.equal(result.status, 200, result.text);
  result = await app('POST', `${scoped}/export-file`, assetBody('map.png'));
  assert.equal(result.status, 200, result.text);
  result = await app('POST', '/api/migrate-install', { dataDir: older, worldIds: ['old-campaign'] });
  assert.equal(result.status, 200, result.text);
  assert.equal(JSON.parse(result.text).migrated.length, 1);
});

test('uploads accept raster images only, assets are never served as active content, and no other site may frame the app', { timeout: 30000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mundusmaker-guard-'));
  const data = path.join(tmp, 'data');
  const port = await freePort();
  const env = { ...process.env, MUNDUSMAKER_CONFIG_DIR: tmp };
  for (const name of ['MUNDUSMAKER_DATA', 'TOMEWEAVER_DATA', 'LOREWEAVE_DATA', 'PORT']) delete env[name];
  const child = spawn(process.execPath, ['server.js', data, String(port), '--no-open'], { cwd: path.resolve(__dirname, '..'), env, stdio: 'ignore', windowsHide: true });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    assert.ok(path.basename(tmp).startsWith('mundusmaker-guard-'));
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  for (let i = 0; i < 200; i++) {
    try { if ((await send(port, { url: '/api/status' })).status === 200) break; } catch { /* not listening yet */ }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  const own = { Origin: `http://localhost:${port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' };
  const upload = (name, bytes) => send(port, { method: 'POST', url: `/api/w/${WID}/assets`, headers: own, body: { name, dataBase64: bytes.toString('base64') } });
  const assets = path.join(data, 'worlds', WID, 'assets');
  const listAssets = () => (fs.existsSync(assets) ? fs.readdirSync(assets).sort() : []);
  const beforeAssets = listAssets();

  const html = Buffer.from('<script>fetch("/api/worlds")</script>');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  for (const [name, bytes] of [['probe.html', html], ['probe.htm', html], ['probe.svg', svg], ['probe.js', html], ['probe.png.html', PNG],
    ['probe', PNG], ['probe.png', html], ['probe.jpg', svg], ['probe.gif', Buffer.alloc(0)], ['.png', PNG]]) {
    const response = await upload(name, bytes);
    assert.ok([400, 415].includes(response.status), `${name}: ${response.status} ${response.text}`);
  }
  assert.deepEqual(listAssets(), beforeAssets, 'refused uploads write nothing');

  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
  const gif = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');
  const stored = {};
  for (const [name, bytes, type] of [['Portrait.PNG', PNG, 'image/png'], ['seal.jpeg', jpeg, 'image/jpeg'], ['map.jpg', jpeg, 'image/jpeg'],
    ['banner.webp', webp, 'image/webp'], ['sigil.gif', gif, 'image/gif'], ['../../escape.png', PNG, 'image/png']]) {
    const response = await upload(name, bytes);
    assert.equal(response.status, 200, `${name}: ${response.text}`);
    const file = JSON.parse(response.text).file;
    assert.ok(!/[\\/]/.test(file) && !file.startsWith('.'), file);
    stored[name] = file;
    const served = await send(port, { url: `/assets/${WID}/${encodeURIComponent(file)}` });
    assert.equal(served.status, 200);
    assert.equal(served.headers['content-type'], type);
    assert.equal(served.headers['x-content-type-options'], 'nosniff');
    assert.match(served.headers['content-security-policy'], /\bsandbox\b/);
    assert.equal(served.headers['content-disposition'], undefined, 'images still display inline');
  }
  assert.equal(fs.existsSync(path.join(data, 'escape.png')), false);

  // Files that reached assets/ some other way (older versions, backups, sync) are neutralised when served.
  fs.writeFileSync(path.join(assets, 'legacy.html'), html);
  fs.writeFileSync(path.join(assets, 'legacy.svg'), svg);
  fs.writeFileSync(path.join(assets, 'legacy.xhtml'), html);
  for (const name of ['legacy.html', 'legacy.xhtml']) {
    const served = await send(port, { url: `/assets/${WID}/${name}` });
    assert.equal(served.status, 200);
    assert.equal(served.headers['content-type'], 'application/octet-stream');
    assert.match(served.headers['content-disposition'], /^attachment/);
    assert.equal(served.headers['x-content-type-options'], 'nosniff');
    assert.match(served.headers['content-security-policy'], /\bsandbox\b/);
  }
  const legacySvg = await send(port, { url: `/assets/${WID}/legacy.svg` });
  assert.equal(legacySvg.headers['content-type'], 'image/svg+xml', 'old SVG portraits keep displaying in <img>');
  assert.match(legacySvg.headers['content-security-policy'], /\bsandbox\b/);
  assert.match(legacySvg.headers['content-security-policy'], /script-src 'none'|default-src 'none'/);
  assert.equal(legacySvg.headers['x-content-type-options'], 'nosniff');

  // Exports are written only as the kinds of file the app makes.
  const exportFile = (name) => send(port, { method: 'POST', url: `/api/w/${WID}/export-file`, headers: own, body: { name, dataBase64: PNG.toString('base64') } });
  for (const name of ['evil.html', 'run.bat', 'setup.exe', 'notes.lnk', '..', '.', ' ', '...pdf.cmd']) {
    const response = await exportFile(name);
    assert.ok([400, 415].includes(response.status), `${name}: ${response.status} ${response.text}`);
  }
  for (const name of ['campaign.pdf', 'harbor-map-gm.png', 'crypt-map-player.uvtt', 'world-player-wiki.zip']) {
    assert.equal((await exportFile(name)).status, 200, name);
  }
  assert.deepEqual(fs.readdirSync(path.join(data, 'worlds', WID, 'exports')).sort(),
    ['campaign.pdf', 'crypt-map-player.uvtt', 'harbor-map-gm.png', 'world-player-wiki.zip']);

  // A framed copy of the app makes same-origin requests, which the guard lets
  // through, so another page could overlay it and borrow the GM's clicks.
  const framed = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Mode': 'navigate' };
  for (const url of ['/', '/index.html']) {
    const served = await send(port, { url, headers: framed });
    assert.equal(served.status, 200, url);
    assert.equal(served.headers['x-frame-options'], 'DENY', url);
    assert.match(served.headers['content-security-policy'] || '', /frame-ancestors 'none'/, url);
  }
});
