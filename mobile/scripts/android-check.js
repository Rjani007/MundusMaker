#!/usr/bin/env node
'use strict';
/*
 * The Android app on a device or emulator, driven over the WebView's DevTools
 * protocol (debug builds only; adb must see exactly one device):
 *
 *   node mobile/scripts/android-check.js [--install <apk>] [--fresh] [--png <file>]
 *
 * --install installs the APK first; --fresh also clears the app's data, so the
 * first-run path (unpacking, seeding the sample world) runs. It checks that
 * server.js runs in the app, saves round-trip with their revisions and land on
 * the device, images display, many requests leave the renderer's memory where
 * it was, typing into a long text block keeps it in view and the top bar
 * shrinks to one row, a tap on a word opens the editor there, Save reaches the
 * native Save/Share dialog, Back closes the drawer, and everything (browser
 * storage included) survives a reload and a full restart of the app. It also
 * checks that another app on the device cannot use the local server. Exit
 * codes: 0 pass, 1 a check failed, 2 no device or no debuggable app.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { connect, EnvironmentError } = require('../../scripts/browser-harness');

const PKG = 'app.mundusmaker';
const argv = process.argv.slice(2);
const option = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const ADB = process.env.ADB || (process.env.ANDROID_HOME ? path.join(process.env.ANDROID_HOME, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb') : 'adb');
const FORWARD_PORT = 9334;
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const adb = (...args) => execFileSync(ADB, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, what, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) {
    try { const value = await fn(); if (value) return value; } catch { /* not yet */ }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(300);
  }
}

/** Launch the app and attach to its page over the WebView's DevTools socket. */
async function attach() {
  adb('shell', 'am', 'start', '-n', `${PKG}/.MainActivity`);
  const pid = await until(() => adb('shell', 'pidof', PKG).trim(), 'the app process');
  const socket = await until(() => (adb('shell', 'cat', '/proc/net/unix').match(new RegExp(`webview_devtools_remote_${pid}\\b`)) || [])[0], 'the WebView DevTools socket (is this a debug build?)');
  adb('forward', `tcp:${FORWARD_PORT}`, `localabstract:${socket}`);
  const page = await until(async () => {
    const list = await (await fetch(`http://127.0.0.1:${FORWARD_PORT}/json`)).json();
    return list.find((t) => t.type === 'page' && /^http:\/\/localhost:\d+\//.test(t.url));
  }, 'the MundusMaker page');
  const client = await connect(page.webSocketDebuggerUrl);
  const evaluate = async (expression) => {
    const reply = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text);
    return reply.result.value;
  };
  const ready = () => until(() => evaluate("document.querySelectorAll('#worldSelect option').length > 0"), 'the world list', 90000);
  return { client, evaluate, ready, pid, origin: new URL(page.url).origin };
}

async function main() {
  try { adb('get-state'); } catch { throw new EnvironmentError('adb sees no device. Start the emulator or plug in a phone with USB debugging on.'); }
  if (option('--install')) {
    if (argv.includes('--fresh')) { try { adb('uninstall', PKG); } catch { /* not installed */ } }
    adb('install', '-r', path.resolve(option('--install')));
  } else if (argv.includes('--fresh')) {
    adb('shell', 'pm', 'clear', PKG);
  }
  adb('shell', 'am', 'force-stop', PKG);

  const failures = [];
  const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures.push(what); };
  const started = Date.now();
  let app = await attach();
  await app.ready();
  console.log(`     app ready ${Date.now() - started} ms after launch`);
  const { evaluate } = app;
  // a first start shows the welcome tour; it is an overlay, so close it
  await evaluate("document.querySelector('.onboard-dialog')?.closest('.overlay')?.dispatchEvent(new MouseEvent('click', { bubbles: true })); true");

  const status = await evaluate("fetch('/api/status').then((r) => r.json())");
  check(status.deployment === 'mobile' && status.platform === 'android', `server.js runs in the app (deployment ${status.deployment}, platform ${status.platform}, ${status.version})`);
  check(await evaluate("document.querySelector('#worldSelect').textContent.includes('Sundered Reach')"), 'the sample world is listed');
  check(await evaluate("typeof window.mundusShell?.save === 'function' && !document.querySelector('#quitBtn:not([hidden])')"), 'the shell is present and the desktop Quit button is hidden');
  check(await evaluate('document.documentElement.scrollWidth <= innerWidth'), 'nothing scrolls sideways at phone width');

  const saved = await evaluate(`(async () => {
    const list = await (await fetch('/api/w/the-sundered-reach/entities?details=1')).json();
    const id = list.entities.find((e) => e.type === 'npc')?.id || list.entities[0].id;
    const url = '/api/w/the-sundered-reach/entities/' + encodeURIComponent(id);
    const res = await fetch(url, { cache: 'no-store' });
    const entity = await res.json();
    entity.name = entity.name.replace(/ \\(android check \\d+\\)$/, '') + ' (android check ' + Date.now() + ')';
    const put = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': res.headers.get('ETag') }, body: JSON.stringify(entity) });
    const stale = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': res.headers.get('ETag') }, body: JSON.stringify({ ...entity, name: 'stale draft' }) });
    return { id, name: entity.name, put: put.status, stale: stale.status };
  })()`);
  check(saved.put === 200, `a save with its revision is accepted (${saved.put})`);
  check(saved.stale === 409, `a save with a stale revision is refused (${saved.stale})`);
  const onDevice = adb('shell', 'run-as', PKG, 'cat', `files/data/worlds/the-sundered-reach/entities/${saved.id}.json`);
  check(onDevice.includes(saved.name), 'the save landed in the data folder on the device');

  const image = await evaluate(`(async () => {
    const up = await fetch('/api/w/the-sundered-reach/assets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'pixel.png', dataBase64: '${PNG_1PX}' }) });
    const { file } = await up.json();
    const img = new Image();
    img.src = '/assets/the-sundered-reach/' + encodeURIComponent(file);
    await img.decode();
    return { status: up.status, width: img.naturalWidth };
  })()`);
  check(image.status === 200 && image.width === 1, 'an uploaded image is served back and displays');

  const timing = await evaluate("(async () => { const t = performance.now(); await (await fetch('/api/w/the-sundered-reach/entities?details=1')).json(); return Math.round(performance.now() - t); })()");
  console.log(`     listing every sample entry took ${timing} ms`);

  // The runtime worker once left each answer's response body unread, and the
  // WebView kept every one (about 20 KB per request), so typing grew the app
  // without end. Garbage collection does not free it, which is what this tells apart.
  // Calibrated on the emulator: at most +4.4 MB over 800 requests after the
  // warm-up, against +20 to +24 MB every time with the leak.
  const renderer = rendererPid();
  if (renderer) {
    const requests = (n) => evaluate(`(async () => { for (let i = 0; i < ${n}; i++) await (await fetch('/api/status', { cache: 'no-store' })).json(); return true; })()`);
    await requests(200);
    await app.client.send('HeapProfiler.collectGarbage');
    const before = pssKb(renderer);
    await requests(800);
    await app.client.send('HeapProfiler.collectGarbage');
    const grown = pssKb(renderer) - before;
    check(grown < 10 * 1024, `800 requests leave the renderer's memory where it was (${(grown / 1024).toFixed(1)} MB more)`);
  } else {
    console.log('     (no WebView renderer process found; memory check skipped)');
  }

  // Typing at the end of a long text block, with the page as short as an
  // on-screen keyboard leaves it. The box's auto-grow once let the page jump
  // away from the text at every new line.
  await app.client.send('Emulation.setDeviceMetricsOverride', { width: await evaluate('innerWidth'), height: 520, deviceScaleFactor: 0, mobile: true });
  const typingId = await evaluate(`(async () => {
    const { newEntity, saveEntity } = await import('/js/state.js');
    const para = 'The old lighthouse keeper remembers every ship that ever ran aground on the Teeth, and tells of each for a drink. ';
    const e = newEntity('Android check typing', 'note');
    e.gmOnly = true;
    e.blocks = [{ id: 'android-check', kind: 'text', text: Array.from({ length: 10 }, () => para).join('\\n\\n'), secret: false }];
    await saveEntity(e);
    location.hash = '#/e/' + encodeURIComponent(e.id);
    for (let i = 0; i < 50 && document.querySelector('.ent-title')?.value !== e.name; i++) await new Promise((r) => setTimeout(r, 100));
    const view = document.getElementById('view');
    const block = document.querySelector('.block');
    view.scrollTop += block.getBoundingClientRect().bottom - view.getBoundingClientRect().bottom + 40;
    block.querySelector('.block-content').click();
    return e.id;
  })()`);
  for (const ch of ' and nobody knows where he keeps the key to the lamp room at the top of the tower') {
    await app.client.send('Input.insertText', { text: ch });
    await sleep(30);
  }
  await sleep(500);
  const typed = await evaluate(`(() => {
    const view = document.getElementById('view').getBoundingClientRect();
    const box = document.activeElement.getBoundingClientRect();
    return { editing: document.activeElement.tagName === 'TEXTAREA', top: view.top, bottom: view.bottom, end: box.bottom };
  })()`);
  check(typed.editing && typed.end > typed.top + 30 && typed.end < typed.bottom + 80, `typing at the end of a long block keeps it in view (its end at ${Math.round(typed.end)}, page ${Math.round(typed.top)}-${Math.round(typed.bottom)})`);
  const bar = await evaluate("document.body.classList.contains('keyboard-up') ? document.getElementById('topbar').getBoundingClientRect().height : 0");
  check(bar > 0 && bar < 80, `with the keyboard up the top bar keeps only its first row (${Math.round(bar)} px)`);

  // A tap on a word opens the editor at that word, not at the end of the block.
  const word = await evaluate(`(async () => {
    document.activeElement.blur();
    // the full top bar comes back a moment after the editor closes
    for (let i = 0; i < 50 && (document.body.classList.contains('keyboard-up') || !document.querySelector('.block .block-content p')); i++) await new Promise((r) => setTimeout(r, 100));
    const text = document.querySelectorAll('.block .block-content p')[4].firstChild;
    const range = document.createRange();
    range.setStart(text, text.data.indexOf('aground') + 3);
    range.setEnd(text, text.data.indexOf('aground') + 4);
    text.parentElement.scrollIntoView({ block: 'center' });
    const r = range.getBoundingClientRect();
    return { x: r.left + 1, y: r.top + r.height / 2 };
  })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await app.client.send('Input.dispatchMouseEvent', { type, x: word.x, y: word.y, button: 'left', clickCount: 1 });
  await sleep(500);
  const caret = await evaluate(`(() => {
    const ta = document.activeElement;
    if (ta.tagName !== 'TEXTAREA') return null;
    let at = -1;
    for (let i = 0; i < 5; i++) at = ta.value.indexOf('aground', at + 1);
    return ta.selectionStart - (at + 3);
  })()`);
  check(caret === 0, `a tap on a word opens the editor at that word (${caret === null ? 'no editor' : `${caret} characters off`})`);
  await evaluate(`(async () => {
    document.activeElement.blur();
    const { deleteEntity } = await import('/js/state.js');
    await deleteEntity(${JSON.stringify(typingId)});
    location.hash = '#/';
    return true;
  })()`);
  await app.client.send('Emulation.clearDeviceMetricsOverride');

  // Back closes the drawer before it navigates anywhere
  await evaluate("document.getElementById('sidebarToggle').click(); true");
  const opened = await evaluate("document.getElementById('sidebarToggle').getAttribute('aria-expanded')");
  adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  await sleep(800);
  const closed = await evaluate("document.getElementById('sidebarToggle').getAttribute('aria-expanded')");
  check(opened === 'true' && closed === 'false', `Back closes the entries drawer (${opened} -> ${closed})`);

  // Save hands the file to the native Save / Share dialog
  await evaluate("window.mundusShell.save(new Blob(['{\"backup\":true}'], { type: 'application/json' }), 'android-check-backup.json'); true");
  const dialog = await until(() => { const ui = dumpUi(); return /save to device/i.test(ui) ? ui : null; }, 'the Save / Share dialog', 15000).catch(() => '');
  check(dialog.includes('android-check-backup.json') && /share/i.test(dialog), 'Save opens the Save / Share dialog with the file name');
  adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  await sleep(500);

  // another app on the device: no session cookie, no host key
  const probe = (host, pathAndQuery) => adb('shell', `printf 'GET ${pathAndQuery} HTTP/1.1\\r\\nHost: ${host}\\r\\nConnection: close\\r\\n\\r\\n' | nc -w 3 127.0.0.1 ${new URL(app.origin).port}`).split('\r\n')[0];
  const port = new URL(app.origin).port;
  check(/ 403 /.test(probe(`localhost:${port}`, '/api/worlds')), 'another app gets 403 from the API without the session cookie');
  check(/ 403 /.test(probe(`127.0.0.1:${port}`, '/__host/fs?op=read')), 'another app gets 403 from the file channel without the host key');
  check(/ 403 /.test(probe(`localhost:${port}`, '/')), 'another app cannot even read the page');

  // a reload restarts the runtime worker; a restart restarts everything
  await evaluate('localStorage.setItem("mundusmaker.androidCheck", "kept"); location.reload(); true').catch(() => {});
  await sleep(1500);
  await app.ready();
  check(await evaluate(`fetch('/api/w/the-sundered-reach/entities/${encodeURIComponent(saved.id)}').then((r) => r.json()).then((e) => e.name)`) === saved.name, 'the edit survives a reload (a fresh runtime worker)');
  app.client.close();

  adb('shell', 'am', 'force-stop', PKG);
  const restart = Date.now();
  app = await attach();
  await app.ready();
  console.log(`     restarted in ${Date.now() - restart} ms (a warm start of the whole app)`);
  check(await app.evaluate(`fetch('/api/w/the-sundered-reach/entities/${encodeURIComponent(saved.id)}').then((r) => r.json()).then((e) => e.name)`) === saved.name, 'the edit survives a full restart of the app');
  check(await app.evaluate('localStorage.getItem("mundusmaker.androidCheck")') === 'kept', `browser storage survives a restart (same origin ${app.origin})`);
  check(await app.evaluate("!document.querySelector('.onboard-dialog')"), 'the welcome tour does not come back after a restart');
  await app.evaluate('localStorage.removeItem("mundusmaker.androidCheck"); true');

  if (option('--png')) {
    fs.writeFileSync(option('--png'), execFileSync(ADB, ['exec-out', 'screencap', '-p']));
    console.log(`     screenshot: ${option('--png')}`);
  }
  check(await app.evaluate("!document.querySelector('[role=alert]')"), 'no startup problem was shown');
  app.client.close();
  try { adb('forward', '--remove', `tcp:${FORWARD_PORT}`); } catch { /* already gone */ }
  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nMundusMaker works on this Android device.');
}

/** The WebView renderer process the app's page runs in (an isolated service, so not a child of the app). */
function rendererPid() {
  const m = /app=ProcessRecord\{\S+ (\d+):[^}\s]*sandboxed_process/.exec(adb('shell', 'dumpsys', 'activity', 'services', PKG));
  return m ? m[1] : null;
}

function pssKb(pid) {
  return Number(/TOTAL PSS:\s+(\d+)/.exec(adb('shell', 'dumpsys', 'meminfo', pid))[1]);
}

function dumpUi() {
  adb('shell', 'uiautomator', 'dump', '/sdcard/mundus-ui.xml');
  return adb('shell', 'cat', '/sdcard/mundus-ui.xml');
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(err instanceof EnvironmentError ? 2 : 1);
});
