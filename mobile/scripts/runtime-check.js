#!/usr/bin/env node
'use strict';
/*
 * The phone runtime in real Chromium: starts mobile/shared/devhost.js on a
 * temporary data folder, opens the app in headless Edge or Chrome (the same
 * engine as Android's WebView) and checks that server.js runs in the worker:
 * the sample world loads, a save round-trips with its revision, an uploaded
 * image displays, Save hands a file to the host, and everything survives a
 * reload.
 *
 *   node mobile/scripts/runtime-check.js [--png out.png]
 *
 * Exit codes: 0 pass, 1 a check failed, 2 no browser could start.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EnvironmentError, startSession } = require('../../scripts/browser-harness');

const ROOT = path.join(__dirname, '..', '..');
const argv = process.argv.slice(2);
const pngOut = argv.includes('--png') ? argv[argv.indexOf('--png') + 1] : null;
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mundusmaker-runtime-check-'));
  const dataDir = path.join(temp, 'data');
  const failures = [];
  const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };
  const started = Date.now();
  let session;
  try {
    session = await startSession(temp, dataDir, {
      script: path.join(ROOT, 'mobile', 'shared', 'devhost.js'),
      args: (port) => [dataDir, '--port', String(port)],
      ready: /\[devhost\] ready: (http:\/\/localhost:\d+\/__shell\/open\?t=[0-9a-f]+)/,
      url: (port, match) => match[1],
    });
    const { evaluate, navigate } = session;
    const waitFor = async (expression, what, ms = 30000) => {
      const until = Date.now() + ms;
      for (;;) {
        try { if (await evaluate(expression)) return true; } catch { /* page still loading */ }
        if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 150));
      }
    };

    await waitFor("document.querySelectorAll('#worldSelect option').length > 0", 'the world list');
    console.log(`     app ready ${Date.now() - started} ms after launch (devhost + browser + runtime boot)`);
    check(await evaluate('typeof window.mundusShell?.save === "function"'), 'the shell announced itself (window.mundusShell)');
    const status = await evaluate("fetch('/api/status').then((r) => r.json())");
    check(status.deployment === 'mobile' && status.platform === 'devhost', `server.js runs in the worker (deployment ${status.deployment}, platform ${status.platform})`);
    check(await evaluate("document.querySelector('#worldSelect').textContent.includes('Sundered Reach')"), 'the sample world was seeded and listed');
    check(await evaluate("document.querySelectorAll('#sidebar a').length > 5"), 'the sidebar lists entries');

    // a save the way api.js makes it: read, then PUT with If-Match
    const saved = await evaluate(`(async () => {
      const list = await (await fetch('/api/w/the-sundered-reach/entities?details=1')).json();
      const id = list.entities[0].id;
      const url = '/api/w/the-sundered-reach/entities/' + encodeURIComponent(id);
      const res = await fetch(url, { cache: 'no-store' });
      const entity = await res.json();
      entity.name = entity.name + ' (runtime check)';
      const put = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': res.headers.get('ETag') }, body: JSON.stringify(entity) });
      // a different draft on the old revision (an identical retry is accepted on purpose)
      const stale = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': res.headers.get('ETag') }, body: JSON.stringify({ ...entity, name: 'stale draft' }) });
      return { id, name: entity.name, put: put.status, stale: stale.status };
    })()`);
    check(saved.put === 200, `a save with its revision is accepted (${saved.put})`);
    check(saved.stale === 409, `a save with a stale revision is refused (${saved.stale})`);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'worlds', 'the-sundered-reach', 'entities', `${saved.id}.json`), 'utf8'));
    check(onDisk.name === saved.name, 'the save reached the data folder');

    const image = await evaluate(`(async () => {
      const up = await fetch('/api/w/the-sundered-reach/assets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'pixel.png', dataBase64: '${PNG_1PX}' }) });
      const { file } = await up.json();
      const img = new Image();
      img.src = '/assets/the-sundered-reach/' + encodeURIComponent(file);
      await img.decode();
      return { status: up.status, width: img.naturalWidth };
    })()`);
    check(image.status === 200 && image.width === 1, 'an uploaded image is served back and displays');

    await evaluate("window.mundusShell.save(new Blob(['{\"backup\":true}'], { type: 'application/json' }), 'world-backup.json')");
    const downloads = path.join(os.tmpdir(), `mundusmaker-devhost-${session.server.pid}`, 'downloads');
    await new Promise((r) => setTimeout(r, 300));
    check(fs.existsSync(path.join(downloads, 'world-backup.json')), 'Save hands the file to the host');

    // reload: a new worker takes over, the edit is still there
    const before = Date.now();
    await navigate('http://localhost:' + session.port + '/');
    await waitFor("document.querySelectorAll('#worldSelect option').length > 0", 'the world list after a reload');
    console.log(`     reloaded in ${Date.now() - before} ms`);
    const name = await evaluate(`fetch('/api/w/the-sundered-reach/entities/${encodeURIComponent(saved.id)}').then((r) => r.json()).then((e) => e.name)`);
    check(name === saved.name, 'the edit survives a reload (and a fresh runtime)');
    const timing = await evaluate(`(async () => { const t = performance.now(); await (await fetch('/api/w/the-sundered-reach/entities?details=1')).json(); return Math.round(performance.now() - t); })()`);
    console.log(`     listing every sample entry took ${timing} ms`);

    if (pngOut) {
      const shot = await session.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(pngOut, Buffer.from(shot.data, 'base64'));
      console.log(`     screenshot: ${pngOut}`);
    }
    const errors = await evaluate("document.querySelector('[role=alert]')?.textContent || ''");
    check(!errors, `no startup problem was shown${errors ? `: ${errors}` : ''}`);
  } finally {
    if (session) await session.close();
    try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* a browser file may still be locked */ }
  }
  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nThe phone runtime works in Chromium.');
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(err instanceof EnvironmentError ? 2 : 1);
});
