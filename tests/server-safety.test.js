'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { once } = require('events');

test('local API preserves stale drafts, reports unreadable files, and restores safely', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mundusmaker-api-test-'));
  const serverRoot = path.resolve(__dirname, '..');
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const child = spawn(process.execPath, ['server.js', root, String(port), '--no-open'], { cwd: serverRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'mundusmaker-api-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://localhost:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/status')).ok) { ready = true; break; } } catch {}
    if (child.exitCode !== null) throw new Error(logs);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.ok(ready, logs);
  const request = async (url, method = 'GET', body, headers = {}) => {
    const response = await fetch(base + url, { method, headers: { ...headers, ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, revision: response.headers.get('etag'), body: await response.json() };
  };
  const created = await request('/api/worlds', 'POST', { name: 'Safety fixture' });
  const wid = created.body.id;
  const scoped = '/api/w/' + wid;
  const live = path.join(root, 'worlds', wid);
  const entity = { id: 'entry', name: 'First', type: 'note', blocks: [], tags: [], relations: [] };
  let result = await request(scoped + '/entities/entry', 'PUT', entity, { 'If-None-Match': '*' });
  assert.equal(result.status, 200);
  const stale = result.revision;
  const details = await request(scoped + '/entities?details=1');
  assert.equal(details.body.revisions.entry, stale);
  entity.name = 'Other tab';
  result = await request(scoped + '/entities/entry', 'PUT', entity, { 'If-Match': stale });
  assert.equal(result.status, 200);
  const fresh = result.revision;
  entity.name = 'Conflicting draft';
  result = await request(scoped + '/entities/entry', 'PUT', entity, { 'If-Match': stale });
  assert.equal(result.status, 409);
  assert.equal((await request(scoped + '/entities/entry')).body.name, 'Other tab');
  const conflictFiles = fs.readdirSync(path.join(root, '.conflicts'));
  assert.equal(conflictFiles.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.conflicts', conflictFiles[0]))).draft.name, 'Conflicting draft');
  assert.equal((await request(scoped + '/entities/entry', 'DELETE', null, { 'If-Match': stale })).status, 409);
  assert.equal((await request(scoped + '/entities/entry', 'PUT', entity)).status, 428);
  // An external edit changes the revision even if it preserves updated timestamps.
  fs.writeFileSync(path.join(live, 'entities', 'entry.json'), JSON.stringify({ ...entity, name: 'Synced edit' }));
  assert.equal((await request(scoped + '/entities/entry', 'PUT', entity, { 'If-Match': fresh })).status, 409);
  // Retrying a write whose response was lost is allowed only for identical content.
  entity.name = 'Synced edit';
  assert.equal((await request(scoped + '/entities/entry', 'PUT', entity, { 'If-Match': fresh })).status, 200);
  const world = await request(scoped + '/world');
  fs.writeFileSync(path.join(live, 'world.json'), JSON.stringify({ ...world.body, name: 'External world edit' }));
  assert.equal((await request(scoped + '/world', 'PUT', { ...world.body, name: 'My draft' }, { 'If-Match': world.revision })).status, 409);
  fs.writeFileSync(path.join(live, 'entities', 'broken.json'), '\ufeff{broken');
  result = await request(scoped + '/entities?details=1');
  assert.equal(result.body.entities.length, 1);
  assert.equal(result.body.issues[0].file, 'entities/broken.json');
  assert.equal((await request(scoped + '/backup')).status, 409);
  const before = fs.readFileSync(path.join(live, 'world.json'));
  const backup = { mundusmaker: 1, world: { name: 'Replacement' }, entities: [{ ...entity, id: 'replacement' }], assets: [{ name: 'portrait.png', dataBase64: Buffer.from('image-bytes').toString('base64') }] };
  assert.equal((await request(scoped + '/restore', 'POST', { ...backup, entities: [entity, entity] })).status, 400);
  assert.deepEqual(fs.readFileSync(path.join(live, 'world.json')), before);
  result = await request(scoped + '/restore', 'POST', backup);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(fs.readdirSync(path.join(live, 'entities')), ['replacement.json']);
  assert.equal(fs.readFileSync(path.join(live, 'assets', 'portrait.png'), 'utf8'), 'image-bytes');
  const recovery = (await request('/api/recovery')).body;
  assert.ok(recovery.snapshots.some((item) => item.worldId === wid));
  assert.ok(fs.readdirSync(path.join(root, '.trash')).some((name) => name.startsWith(wid + '-')));
  // Consecutive restores in the same minute must create separate checkpoints.
  assert.equal((await request(scoped + '/restore', 'POST', backup)).status, 200);
  assert.equal(fs.readdirSync(path.join(root, '.snapshots', wid)).filter((name) => name.includes('pre-restore')).length, 2);
  const handout={id:'letter',name:'A letter',type:'handout',handout:{kind:'letter',slots:{body:'body'}},image:'portrait.png',blocks:[{id:'body',kind:'text',text:`![seal](/assets/${wid}/portrait.png)`,secret:true}],relations:[{to:'replacement',secret:false}],tags:[]};
  assert.equal((await request(scoped+'/entities/letter','PUT',handout,{'If-None-Match':'*'})).status,200);
  const savedBackup=(await request(scoped+'/backup?assets=1')).body;assert.equal(savedBackup.worldId,wid);
  const other=(await request('/api/worlds','POST',{name:'Restored handouts'})).body.id;
  assert.equal((await request(`/api/w/${other}/restore`,'POST',savedBackup)).status,200);
  const restored=(await request(`/api/w/${other}/entities/letter`)).body;
  assert.deepEqual(restored.handout,handout.handout);assert.equal(restored.blocks[0].secret,true);assert.equal(restored.blocks[0].text,`![seal](/assets/${other}/portrait.png)`);
  assert.equal((await request(scoped+'/entities/letter')).body.blocks[0].text,handout.blocks[0].text,'source remains unchanged');
});
