'use strict';
// Bringing worlds over from an older MundusMaker (0.11 migration, automated
// on first start in 1.9). Copy-only, always: nothing at the source install is
// ever written, moved or deleted. Each world is staged outside worlds/ and
// renamed in only when complete, and a ledger in the data folder records every
// copy so a second run never duplicates a world.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { createHash, randomUUID } = require('crypto');
const { atomicWrite } = require('./storage');

const LEDGER = '.upgrade.json';
const STAGING = '.upgrade-staging';
const INSTALL_NAME = /loreweave|tomeweaver|mundusmaker/i;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}
const isInside = (child, parent) => {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};
const countEntities = (dir) => {
  const entDir = path.join(dir, 'entities');
  return fs.existsSync(entDir) ? fs.readdirSync(entDir).filter((f) => f.endsWith('.json')).length : 0;
};

/**
 * Where an install keeps its worlds, resolved the way that install itself
 * would (its own config names, else ./data). Strictly read-only.
 */
function detectInstallData(candidatePath, { liveDataDir, configNames }) {
  const p = path.resolve(String(candidatePath || ''));
  if (!p || !fs.existsSync(p) || !fs.statSync(p).isDirectory()) return null;
  let dataDir = null, port = 4870;
  if (fs.existsSync(path.join(p, 'worlds')) || fs.existsSync(path.join(p, 'world.json'))) {
    dataDir = p; // pointed straight at a data folder
  } else {
    let portFound = false;
    for (const name of configNames) {
      const cfg = readJson(path.join(p, name));
      if (!cfg) continue;
      if (!portFound && cfg.port) { port = Number(cfg.port) || 4870; portFound = true; }
      if (cfg.dataDir) { dataDir = path.resolve(p, cfg.dataDir); break; }
    }
    if (!dataDir && fs.existsSync(path.join(p, 'data'))) dataDir = path.join(p, 'data');
  }
  if (!dataDir || !fs.existsSync(dataDir)) return null;
  if (liveDataDir && path.resolve(dataDir) === path.resolve(liveDataDir)) return null; // the live data folder: nothing to migrate
  const readName = (worldJson, fallback) => readJson(worldJson)?.name || fallback;
  const worlds = [];
  const wdir = path.join(dataDir, 'worlds');
  if (fs.existsSync(wdir)) {
    for (const d of fs.readdirSync(wdir, { withFileTypes: true })) {
      if (!d.isDirectory() || !fs.existsSync(path.join(wdir, d.name, 'world.json'))) continue;
      worlds.push({ id: d.name, name: readName(path.join(wdir, d.name, 'world.json'), d.name), entities: countEntities(path.join(wdir, d.name)) });
    }
  }
  // external: the install keeps its worlds outside its own folder, usually a
  // folder a sync tool shares, which is adopted rather than copied
  const external = dataDir !== p && !isInside(dataDir, p);
  if (worlds.length) return { path: p, dataDir, layout: 'v2', worlds, port, external };
  if (fs.existsSync(path.join(dataDir, 'world.json'))) {
    return {
      path: p, dataDir, layout: 'v1', port, external,
      worlds: [{ id: '__v1__', name: readName(path.join(dataDir, 'world.json'), 'My World'), entities: countEntities(dataDir) }],
    };
  }
  return null;
}

function installVersion(installPath) {
  const pkg = readJson(path.join(installPath, 'package.json'));
  return typeof pkg?.version === 'string' ? pkg.version : null;
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

/** Other installs in the same parent folder as this app, with their versions. */
function scanSiblings({ root, liveDataDir, configNames }) {
  const parent = path.dirname(root);
  let siblings = [];
  try { siblings = fs.readdirSync(parent, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return []; }
  const found = [];
  for (const d of siblings) {
    const full = path.join(parent, d.name);
    if (path.resolve(full) === path.resolve(root)) continue;
    const looksLikeInstall = INSTALL_NAME.test(d.name)
      || (fs.existsSync(path.join(full, 'server.js')) && fs.existsSync(path.join(full, 'public')));
    if (!looksLikeInstall) continue;
    try {
      const install = detectInstallData(full, { liveDataDir, configNames });
      if (install) found.push({ ...install, version: installVersion(full) });
    } catch { /* unreadable candidate: skip */ }
  }
  return found;
}

function listFiles(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name).sort(); } catch { return []; }
}

/**
 * Identifies a world's content: world.json plus every entry and asset, by
 * name, size and modification time. A world changed since its last copy gets
 * a new fingerprint.
 */
function fingerprintWorld(worldDir) {
  const hash = createHash('sha256');
  for (const sub of ['', 'entities', 'assets']) {
    for (const name of listFiles(path.join(worldDir, sub))) {
      if (sub === '' && name !== 'world.json') continue;
      try {
        const st = fs.statSync(path.join(worldDir, sub, name));
        hash.update(`${sub}/${name}\0${st.size}\0${Math.round(st.mtimeMs)}\n`);
      } catch { /* vanished while reading */ }
    }
  }
  return hash.digest('hex');
}

function sameFolderContents(a, b) {
  const fa = listFiles(a), fb = listFiles(b);
  if (fa.length !== fb.length || fa.some((name, i) => name !== fb[i])) return false;
  return fa.every((name) => fs.readFileSync(path.join(a, name)).equals(fs.readFileSync(path.join(b, name))));
}

/**
 * A sample world nobody wrote in: every entry and asset identical to the old
 * install's own sample/. world.json is not compared, because loading a world
 * adds new built-in categories to it without the GM doing anything.
 */
function isUntouchedSample(worldDir, installPath) {
  const sample = path.join(installPath, 'sample');
  if (!fs.existsSync(path.join(sample, 'world.json'))) return false;
  try {
    return sameFolderContents(path.join(worldDir, 'entities'), path.join(sample, 'entities'))
      && sameFolderContents(path.join(worldDir, 'assets'), path.join(sample, 'assets'));
  } catch { return false; }
}

function readLedger(dataDir) {
  const ledger = readJson(path.join(dataDir, LEDGER));
  return ledger && Array.isArray(ledger.copies) ? ledger : { copies: [] };
}
function writeLedger(dataDir, ledger) {
  atomicWrite(path.join(dataDir, LEDGER), JSON.stringify(ledger, null, 2));
}
const hasLedger = (dataDir) => fs.existsSync(path.join(dataDir, LEDGER));

/** A copy interrupted by a crash never became a world; remove what it left. */
function cleanStaging(dataDir) {
  fs.rmSync(path.join(dataDir, STAGING), { recursive: true, force: true });
}

function librarySize(dataDir) {
  const lib = path.join(dataDir, '.library');
  let count = 0, bytes = 0;
  for (const id of fs.existsSync(lib) ? fs.readdirSync(lib) : []) {
    const dir = path.join(lib, id);
    if (!fs.statSync(dir).isDirectory()) continue;
    count++;
    for (const name of listFiles(dir)) bytes += fs.statSync(path.join(dir, name)).size;
  }
  return { count, bytes };
}

function stageAndPublish(stagingRoot, destination, fill) {
  fs.mkdirSync(stagingRoot, { recursive: true });
  const stage = path.join(stagingRoot, `${path.basename(destination)}-${randomUUID().slice(0, 8)}`);
  try {
    fill(stage);
    fs.renameSync(stage, destination);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/**
 * Copy worlds (and optionally library packs) from an older install into this
 * data folder. Skips worlds the ledger shows were already copied unchanged; a
 * world changed since its last copy arrives as a separate world, never merged.
 */
function copyWorlds({ install, worldIds, dataDir, uniqueWorldId, copyDirSync, skipSample = true, packs = false, samePath = (a, b) => a === b }) {
  const ledger = readLedger(dataDir);
  const stagingRoot = path.join(dataDir, STAGING);
  const wanted = Array.isArray(worldIds) && worldIds.length ? new Set(worldIds) : null;
  const copied = [], skipped = [];
  for (const w of install.worlds) {
    if (wanted && !wanted.has(w.id)) continue;
    const src = install.layout === 'v1' ? install.dataDir : path.join(install.dataDir, 'worlds', w.id);
    if (skipSample && install.layout !== 'v1' && isUntouchedSample(src, install.path)) {
      skipped.push({ from: w.id, name: w.name, reason: 'untouched sample' });
      continue;
    }
    const fingerprint = fingerprintWorld(src);
    const earlier = ledger.copies.filter((c) => samePath(c.sourceDataDir, install.dataDir) && c.sourceWorld === w.id);
    if (earlier.some((c) => c.fingerprint === fingerprint)) {
      skipped.push({ from: w.id, name: w.name, reason: 'already copied' });
      continue;
    }
    const newId = uniqueWorldId(w.name);
    let name = w.name;
    stageAndPublish(stagingRoot, path.join(dataDir, 'worlds', newId), (stage) => {
      if (install.layout === 'v1') {
        // synthesize a v2 world folder by COPY; the source keeps its v1 shape
        fs.mkdirSync(stage, { recursive: true });
        fs.copyFileSync(path.join(install.dataDir, 'world.json'), path.join(stage, 'world.json'));
        for (const sub of ['entities', 'exports', 'assets']) {
          const from = path.join(install.dataDir, sub);
          if (fs.existsSync(from)) copyDirSync(from, path.join(stage, sub));
        }
      } else {
        copyDirSync(src, stage);
      }
      fs.mkdirSync(path.join(stage, 'entities'), { recursive: true });
      fs.mkdirSync(path.join(stage, 'exports'), { recursive: true });
      if (earlier.length) {
        // changed since the last copy: a separate world, named so it can't be mistaken
        const worldFile = path.join(stage, 'world.json');
        const world = readJson(worldFile);
        if (world) {
          name = `${world.name || w.name} (copied again ${new Date().toISOString().slice(0, 10)})`;
          atomicWrite(worldFile, JSON.stringify({ ...world, name }, null, 2));
        }
      }
    });
    ledger.copies.push({ sourcePath: install.path, sourceDataDir: install.dataDir, sourceWorld: w.id, fingerprint, worldId: newId, at: new Date().toISOString() });
    writeLedger(dataDir, ledger); // after every world, so a crash never forgets a finished copy
    copied.push({ from: w.id, id: newId, name, entities: w.entities });
  }
  const packsCopied = [];
  if (packs) {
    const lib = path.join(install.dataDir, '.library');
    for (const id of fs.existsSync(lib) ? fs.readdirSync(lib) : []) {
      const from = path.join(lib, id), to = path.join(dataDir, '.library', id);
      if (!fs.statSync(from).isDirectory() || fs.existsSync(to)) continue; // never overwrite a pack already here
      fs.mkdirSync(path.dirname(to), { recursive: true });
      stageAndPublish(stagingRoot, to, (stage) => copyDirSync(from, stage));
      packsCopied.push(id);
    }
  }
  try { fs.rmdirSync(stagingRoot); } catch { /* absent, or holding a copy still in progress */ }
  return { copied, skipped, packs: packsCopied };
}

/** Ask a MundusMaker on this port for its status; null when nothing answers. */
function probeInstance(port, timeout = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/status', timeout, headers: { Host: `localhost:${port}` } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; if (body.length > 65536) req.destroy(); });
      res.on('end', () => {
        try { const s = JSON.parse(body); resolve(s && typeof s.dataDir === 'string' ? s : null); } catch { resolve(null); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

/** Ask a 1.9+ MundusMaker on this port to quit gracefully; true when it agreed. */
function requestQuit(port, timeout = 3000) {
  return new Promise((resolve) => {
    const body = '{}';
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/quit', method: 'POST', timeout,
      headers: { Host: `localhost:${port}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end(body);
  });
}

/** Older installs beside this one that still hold worlds worth copying. */
async function candidatesFor(ctx) {
  const ledger = readLedger(ctx.dataDir);
  const same = ctx.samePath || ((a, b) => a === b);
  const older = scanSiblings({ root: ctx.root, liveDataDir: ctx.dataDir, configNames: ctx.configNames })
    .filter((c) => !c.version || compareVersions(c.version, ctx.version) < 0);
  const out = [];
  for (const c of older) {
    const worlds = c.worlds.map((w) => {
      const src = c.layout === 'v1' ? c.dataDir : path.join(c.dataDir, 'worlds', w.id);
      if (c.layout !== 'v1' && isUntouchedSample(src, c.path)) return { ...w, copyable: false, reason: 'untouched sample' };
      const fp = fingerprintWorld(src);
      const copiedBefore = ledger.copies.some((x) => same(x.sourceDataDir, c.dataDir) && x.sourceWorld === w.id && x.fingerprint === fp);
      return copiedBefore ? { ...w, copyable: false, reason: 'already copied' } : { ...w, copyable: true };
    });
    if (!worlds.some((w) => w.copyable)) continue;
    let running = null;
    // a copy on this server's own port can't be running: this server holds it
    if (c.port !== ctx.port) {
      const status = await probeInstance(c.port);
      if (status && same(status.dataDir, c.dataDir)) {
        running = { port: c.port, version: status.version || null, canQuit: !!status.version && compareVersions(status.version, '1.9.0') >= 0 };
      }
    }
    out.push({ path: c.path, dataDir: c.dataDir, layout: c.layout, version: c.version, external: c.external, port: c.port, running, worlds, packs: librarySize(c.dataDir) });
  }
  return out;
}

/**
 * First start of a data folder with no worlds of its own: copy automatically
 * when exactly one older install has worlds, keeps them inside its own folder
 * and is not running; otherwise leave one choice for the app to show.
 */
async function firstStart(ctx) {
  const candidates = await candidatesFor(ctx);
  const at = new Date().toISOString();
  const [only] = candidates;
  if (candidates.length === 1 && !only.external && !only.running) {
    const install = detectInstallData(only.path, { liveDataDir: ctx.dataDir, configNames: ctx.configNames });
    const result = copyWorlds({
      install, worldIds: only.worlds.filter((w) => w.copyable).map((w) => w.id), dataDir: ctx.dataDir,
      uniqueWorldId: ctx.uniqueWorldId, copyDirSync: ctx.copyDirSync, packs: true, samePath: ctx.samePath,
    });
    const ledger = readLedger(ctx.dataDir);
    ledger.firstStart = { at, result: 'copied' };
    ledger.notice = { at, from: { path: only.path, version: only.version }, copied: result.copied, packs: result.packs.length };
    writeLedger(ctx.dataDir, ledger);
    return { result: 'copied', from: only.path, ...result };
  }
  const ledger = readLedger(ctx.dataDir);
  ledger.firstStart = { at, result: candidates.length ? 'choice' : 'none' };
  if (candidates.length) ledger.choice = { pending: true, at };
  writeLedger(ctx.dataDir, ledger);
  return { result: ledger.firstStart.result, candidates: candidates.length };
}

/** What the app should show: a notice of an automatic copy, or a pending choice. */
async function upgradeStatus(ctx) {
  const ledger = readLedger(ctx.dataDir);
  const out = { notice: ledger.notice || null, choice: null };
  if (ledger.choice?.pending) {
    const candidates = await candidatesFor(ctx);
    if (candidates.length) out.choice = { candidates };
    else { ledger.choice = { pending: false, at: new Date().toISOString(), resolved: 'nothing left to copy' }; writeLedger(ctx.dataDir, ledger); }
  }
  return out;
}

function dismiss(ctx, what) {
  const ledger = readLedger(ctx.dataDir);
  if (what === 'notice') delete ledger.notice;
  else if (what === 'choice') ledger.choice = { pending: false, at: new Date().toISOString(), resolved: 'dismissed' };
  else return false;
  writeLedger(ctx.dataDir, ledger);
  return true;
}

function resolveChoice(ctx, summary) {
  const ledger = readLedger(ctx.dataDir);
  ledger.choice = { pending: false, at: new Date().toISOString(), resolved: summary };
  writeLedger(ctx.dataDir, ledger);
}

module.exports = {
  LEDGER, STAGING, detectInstallData, installVersion, compareVersions, scanSiblings, fingerprintWorld,
  isUntouchedSample, readLedger, hasLedger, cleanStaging, librarySize, copyWorlds, probeInstance, requestQuit,
  candidatesFor, firstStart, upgradeStatus, dismiss, resolveChoice,
};
