'use strict';
/*
 * Headless Edge/Chrome over the DevTools protocol, with Node's built-in
 * WebSocket (Node 22+), so browser checks need no dependencies. Shared by the
 * map render check and the player wiki check. The server always runs on a
 * temporary data folder, never the owner's data/.
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

class EnvironmentError extends Error {}

/** Every installed Edge or Chrome, in order of preference (MUNDUSMAKER_BROWSER alone when set). */
function findBrowsers() {
  if (process.env.MUNDUSMAKER_BROWSER) {
    if (fs.existsSync(process.env.MUNDUSMAKER_BROWSER)) return [process.env.MUNDUSMAKER_BROWSER];
    throw new EnvironmentError(`MUNDUSMAKER_BROWSER points at a missing file: ${process.env.MUNDUSMAKER_BROWSER}`);
  }
  const env = process.env;
  const fixed = process.platform === 'win32' ? [
    path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ] : process.platform === 'darwin' ? [
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ] : [];
  const found = fixed.filter((candidate) => candidate && fs.existsSync(candidate));
  const names = ['microsoft-edge', 'microsoft-edge-stable', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate) && !found.includes(candidate)) found.push(candidate);
    }
  }
  if (!found.length) throw new EnvironmentError('No Edge or Chrome browser was found. Install one, or set MUNDUSMAKER_BROWSER to its executable.');
  return found;
}

function findBrowser() {
  return findBrowsers()[0];
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}

function waitForLine(stream, pattern, what, ms = 30000) {
  return new Promise((resolve, reject) => {
    let seen = '';
    const timer = setTimeout(() => reject(new EnvironmentError(`${what} did not start within ${ms / 1000} s.\n${seen.slice(-800)}`)), ms);
    stream.on('data', (chunk) => {
      seen += chunk;
      const match = seen.match(pattern);
      if (match) { clearTimeout(timer); resolve(match); }
    });
  });
}

/**
 * The browser's DevTools WebSocket URL: from its "DevTools listening on" line,
 * or from the DevToolsActivePort file Chromium writes into the profile. The
 * file matters because Edge's launcher can hand the browser to a new process
 * and exit at once (code 0), taking the stderr line with it; the headless
 * browser keeps running and is closed later through DevTools.
 */
function waitForDevTools(browser, profile, name, ms = 30000) {
  return new Promise((resolve, reject) => {
    let seen = '', exitedAt = null, done = false;
    const finish = (settle, value) => { if (done) return; done = true; clearInterval(poll); clearTimeout(timer); settle(value); };
    browser.stderr.on('data', (chunk) => {
      seen += chunk;
      const match = seen.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) finish(resolve, match[1]);
    });
    browser.once('exit', () => { exitedAt = Date.now(); });
    const poll = setInterval(() => {
      try {
        const [port, route] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/);
        if (Number(port) > 0 && route) { finish(resolve, `ws://127.0.0.1:${port}${route}`); return; }
      } catch { /* not written yet */ }
      if (exitedAt && Date.now() - exitedAt > 8000) finish(reject, new EnvironmentError(`${name} exited without opening its DevTools port.`));
    }, 100);
    const timer = setTimeout(() => finish(reject, new EnvironmentError(`${name} did not start within ${ms / 1000} s.\n${seen.slice(-800)}`)), ms);
  });
}

function connect(url) {
  if (typeof WebSocket !== 'function') throw new EnvironmentError('This check needs Node 22 or newer (built-in WebSocket).');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    const listeners = new Set();
    let next = 0;
    ws.onopen = () => resolve({
      send(method, params = {}, sessionId) {
        const id = ++next;
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        return new Promise((res, rej) => pending.set(id, { res, rej, method }));
      },
      on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      close() { try { ws.close(); } catch { /* already closed */ } },
    });
    ws.onerror = () => reject(new EnvironmentError('Could not connect to the browser over the DevTools protocol.'));
    ws.onmessage = ({ data }) => {
      const msg = JSON.parse(String(data));
      if (msg.id && pending.has(msg.id)) {
        const call = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) call.rej(new Error(`${call.method}: ${msg.error.message}`));
        else call.res(msg.result);
      } else {
        for (const fn of listeners) fn(msg);
      }
    };
    ws.onclose = () => {
      for (const call of pending.values()) call.rej(new Error('The browser connection closed.'));
      pending.clear();
    };
  });
}


/**
 * Start MundusMaker on dataDir and a headless browser whose profile lives in
 * temp, open the app and return a small driver. close() stops both.
 */
async function startSession(temp, dataDir) {
  const browserPaths = findBrowsers();
  const children = [];
  let client;
  const close = async () => {
    if (client) {
      try { await Promise.race([client.send('Browser.close'), new Promise((r) => setTimeout(r, 2000))]); } catch { /* already closing */ }
      client.close();
    }
    for (const child of children) { try { child.kill(); } catch { /* already exited */ } }
    await new Promise((r) => setTimeout(r, 500));
  };
  try {
    const port = await freePort();
    const server = spawn(process.execPath, ['server.js', dataDir, String(port), '--no-open'],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    children.push(server);
    await waitForLine(server.stdout, /serving on/, 'The MundusMaker test server');

    // Installed browsers are tried in order; one that never opens its DevTools
    // port is skipped for the next.
    let wsUrl = null;
    const tried = [];
    for (const [i, browserPath] of browserPaths.entries()) {
      const profile = path.join(temp, `profile-${i}`);
      const browser = spawn(browserPath, [
        '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
        '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--mute-audio', 'about:blank',
      ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      children.push(browser);
      try { wsUrl = await waitForDevTools(browser, profile, path.basename(browserPath)); break; }
      catch (err) { tried.push(err.message.split('\n')[0]); try { browser.kill(); } catch { /* already gone */ } }
    }
    if (!wsUrl) throw new EnvironmentError(`No browser started for the check (${tried.join(' ')}) Set MUNDUSMAKER_BROWSER to a working Edge or Chrome.`);

    client = await connect(wsUrl);
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
    await client.send('Page.enable', {}, sessionId);
    const send = (method, params = {}) => client.send(method, params, sessionId);
    const navigate = async (url) => {
      const loaded = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new EnvironmentError(`${url} did not load.`)), 30000);
        const off = client.on((msg) => {
          if (msg.method === 'Page.loadEventFired' && msg.sessionId === sessionId) { clearTimeout(timer); off(); resolve(); }
        });
      });
      await send('Page.navigate', { url });
      await loaded;
    };
    /** Evaluate an expression in the page; returns its value or throws. */
    const evaluate = async (expression) => {
      const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text);
      return reply.result.value;
    };
    await navigate(`http://localhost:${port}/`);
    return { client, sessionId, port, send, navigate, evaluate, close };
  } catch (err) {
    await close();
    throw err;
  }
}

module.exports = { ROOT, EnvironmentError, findBrowser, findBrowsers, freePort, waitForLine, connect, startSession };
