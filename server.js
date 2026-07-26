#!/usr/bin/env node
/*
 * MundusMaker server — zero-dependency local wiki backend with multiple worlds.
 *
 * Usage:  node server.js [dataDir] [port] [--no-open]
 *   dataDir    defaults to ./data
 *   port       defaults to 4870 (or PORT env var)
 *   --no-open  don't open the browser automatically
 *
 * Data layout (v2):
 *   dataDir/worlds/<worldId>/world.json          settings, entity types, calendar
 *   dataDir/worlds/<worldId>/entities/<id>.json  one file per entity
 *   dataDir/worlds/<worldId>/exports/            PDFs / PNGs from the export feature
 *   dataDir/.trash/                              deleted worlds are moved here, never erased
 *
 * A v1 layout (dataDir/world.json) is migrated into worlds/<slug>/ automatically.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const SAMPLE_DIR = path.join(ROOT, 'sample');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flags = process.argv.slice(2).filter((a) => a.startsWith('--'));
const dataDirArg = args.find((a) => !/^\d+$/.test(a));
const portArg = args.find((a) => /^\d+$/.test(a));

// data dir priority: CLI arg > env var > mundusmaker.config.json > ./data
//
// The app has been renamed (Loreweave → TomeWeaver → MundusMaker), so older
// config filenames and env var names stay honoured. This is not cosmetic: if
// the config read silently yields {}, DATA_DIR falls back to ./data, the app
// finds no worlds, seeds a fresh sample world, and an upgrading user cannot
// tell that apart from having lost their entire campaign. It hits folder-sync
// users hardest — they are the ones who have a config file at all.
//
// On the NEXT rename, put the outgoing name at the FRONT of these lists rather
// than nesting more fallbacks. Only Loreweave was ever distributed; the
// TomeWeaver entries cost one array slot and cover anyone who ran an in-between
// build from source.
const CONFIG_NAMES = ['mundusmaker.config.json', 'tomeweaver.config.json', 'loreweave.config.json'];
const CONFIG_PATH = path.join(ROOT, CONFIG_NAMES[0]);
let config = {};
let configPathUsed = CONFIG_PATH;
for (const name of CONFIG_NAMES) {
  const candidate = path.join(ROOT, name);
  try {
    config = JSON.parse(fs.readFileSync(candidate, 'utf8'));
    configPathUsed = candidate;
    break;
  } catch { /* try the next name */ }
}
// Env vars can't be migrated — nothing can rewrite a user's desktop shortcut or
// shell profile — so every old name is honoured indefinitely.
const envAny = (...names) => names.map((n) => process.env[n]).find(Boolean);
const DATA_DIR_ENV = envAny('MUNDUSMAKER_DATA', 'TOMEWEAVER_DATA', 'LOREWEAVE_DATA');
const DATA_DIR = path.resolve(dataDirArg || DATA_DIR_ENV || config.dataDir || path.join(ROOT, 'data'));
const WORLDS_DIR = path.join(DATA_DIR, 'worlds');
const PORT = Number(portArg || process.env.PORT || config.port || 4870);
const NO_OPEN = flags.includes('--no-open')
  || !!envAny('MUNDUSMAKER_NO_OPEN', 'TOMEWEAVER_NO_OPEN', 'LOREWEAVE_NO_OPEN');
const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return '?'; }
})();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;

function slugify(name) {
  const s = String(name).toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return s || 'world';
}

function defaultTypes() {
  return {
    character: { label: 'Character', plural: 'Characters', color: '#e0724a', fields: ['Role', 'Species', 'Status'] },
    npc: { label: 'NPC', plural: 'NPCs', color: '#d9913f', fields: ['Role', 'Species', 'Disposition', 'Found at'] },
    location: { label: 'Location', plural: 'Locations', color: '#4a9e6f', fields: ['Kind', 'Region', 'Population'] },
    faction: { label: 'Faction', plural: 'Factions', color: '#7b6fe0', fields: ['Goal', 'Leader', 'Reach'] },
    item: { label: 'Item', plural: 'Items', color: '#d4a72c', fields: ['Kind', 'Owner', 'Rarity'] },
    event: { label: 'Event', plural: 'Events', color: '#c95d8f', fields: ['Outcome'] },
    creature: { label: 'Creature', plural: 'Creatures', color: '#5aa7c9', fields: ['Habitat', 'Threat'] },
    session: { label: 'Session', plural: 'Sessions', color: '#4ab8a8', fields: ['Played on', 'Players'] },
    note: { label: 'Note', plural: 'Notes', color: '#8a8f98', fields: [] },
  };
}

// ---------- bootstrap & worlds ----------

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const item of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, item.name);
    const d = path.join(dest, item.name);
    if (item.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

function worldDir(wid) {
  if (!SAFE_ID.test(wid)) throw Object.assign(new Error('invalid world id'), { status: 400 });
  const dir = path.join(WORLDS_DIR, wid);
  if (!fs.existsSync(path.join(dir, 'world.json'))) {
    throw Object.assign(new Error('world not found'), { status: 404 });
  }
  return dir;
}

function listWorldIds() {
  if (!fs.existsSync(WORLDS_DIR)) return [];
  return fs.readdirSync(WORLDS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(WORLDS_DIR, d.name, 'world.json')))
    .map((d) => d.name);
}

function uniqueWorldId(name) {
  let base = slugify(name), wid = base, i = 2;
  while (fs.existsSync(path.join(WORLDS_DIR, wid))) wid = `${base}-${i++}`;
  return wid;
}

function createWorld(name) {
  const wid = uniqueWorldId(name);
  const dir = path.join(WORLDS_DIR, wid);
  fs.mkdirSync(path.join(dir, 'entities'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'exports'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'world.json'),
    JSON.stringify({ name: String(name).trim() || 'New World', description: '', era: '', types: defaultTypes() }, null, 2));
  return wid;
}

function bootstrap() {
  fs.mkdirSync(WORLDS_DIR, { recursive: true });

  // migrate v1 single-world layout
  const legacyWorld = path.join(DATA_DIR, 'world.json');
  if (fs.existsSync(legacyWorld)) {
    let name = 'My World';
    try { name = JSON.parse(fs.readFileSync(legacyWorld, 'utf8')).name || name; } catch { /* keep default */ }
    const wid = uniqueWorldId(name);
    const dir = path.join(WORLDS_DIR, wid);
    fs.mkdirSync(dir, { recursive: true });
    fs.renameSync(legacyWorld, path.join(dir, 'world.json'));
    for (const sub of ['entities', 'exports']) {
      const from = path.join(DATA_DIR, sub);
      if (fs.existsSync(from)) fs.renameSync(from, path.join(dir, sub));
    }
    console.log(`[mundusmaker] migrated existing world into worlds/${wid}/`);
  }

  // first run: seed the sample world
  if (!listWorldIds().length) {
    if (fs.existsSync(SAMPLE_DIR)) {
      console.log('[mundusmaker] first run — seeding the sample world "The Sundered Reach"');
      copyDirSync(SAMPLE_DIR, path.join(WORLDS_DIR, 'the-sundered-reach'));
    } else {
      createWorld('My World');
    }
  }

  for (const wid of listWorldIds()) {
    fs.mkdirSync(path.join(WORLDS_DIR, wid, 'entities'), { recursive: true });
    fs.mkdirSync(path.join(WORLDS_DIR, wid, 'exports'), { recursive: true });
  }

  try { snapshotWorlds(); } catch (err) { console.error('[mundusmaker] snapshot failed:', err.message); }
}

/** Daily safety copies of every world (world.json, entities, assets — not exports). Keeps the last 7. */
function snapshotWorlds() {
  const snapRoot = path.join(DATA_DIR, '.snapshots');
  for (const wid of listWorldIds()) {
    const snapDir = path.join(snapRoot, wid);
    fs.mkdirSync(snapDir, { recursive: true });
    const existing = fs.readdirSync(snapDir).sort();
    if (existing.length) {
      const age = Date.now() - fs.statSync(path.join(snapDir, existing[existing.length - 1])).mtimeMs;
      if (age < 20 * 3600 * 1000) continue; // one per day is plenty
    }
    const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
    const dest = path.join(snapDir, stamp);
    const src = path.join(WORLDS_DIR, wid);
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(path.join(src, 'world.json'), path.join(dest, 'world.json'));
    for (const sub of ['entities', 'assets']) {
      if (fs.existsSync(path.join(src, sub))) copyDirSync(path.join(src, sub), path.join(dest, sub));
    }
    const all = fs.readdirSync(snapDir).sort();
    while (all.length > 7) fs.rmSync(path.join(snapDir, all.shift()), { recursive: true, force: true });
    console.log(`[mundusmaker] daily snapshot: ${wid} → .snapshots/${wid}/${stamp}`);
  }
}

// ---------- helpers ----------

function readBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// ---------- per-entity version history ----------
// Kept in <worldDir>/.history/<entityId>/<stamp>.json — deliberately outside
// entities/ so listings, snapshots and backups never pick versions up.

const HISTORY_KEEP = 10;
const HISTORY_MIN_GAP_MS = 5 * 60 * 1000; // one version per editing burst

function historyDir(dir, id) {
  return path.join(dir, '.history', id);
}

/** Archive the entity's current file before it is overwritten. */
function writeHistory(dir, id, force = false) {
  const file = path.join(dir, 'entities', id + '.json');
  if (!fs.existsSync(file)) return;
  const hd = historyDir(dir, id);
  fs.mkdirSync(hd, { recursive: true });
  const existing = fs.readdirSync(hd).filter((f) => f.endsWith('.json')).sort();
  if (existing.length) {
    const newest = path.join(hd, existing[existing.length - 1]);
    if (fs.readFileSync(newest, 'utf8') === fs.readFileSync(file, 'utf8')) return; // unchanged
    if (!force && Date.now() - fs.statSync(newest).mtimeMs < HISTORY_MIN_GAP_MS) return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(file, path.join(hd, stamp + '.json'));
  const all = fs.readdirSync(hd).filter((f) => f.endsWith('.json')).sort();
  while (all.length > HISTORY_KEEP) fs.unlinkSync(path.join(hd, all.shift()));
}

function listEntities(dir) {
  const entDir = path.join(dir, 'entities');
  if (!fs.existsSync(entDir)) return [];
  const out = [];
  for (const f of fs.readdirSync(entDir)) {
    if (!f.endsWith('.json')) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(entDir, f), 'utf8')));
    } catch (e) {
      console.error(`[mundusmaker] skipping unreadable entity file ${f}: ${e.message}`);
    }
  }
  return out;
}

// ---------- API ----------

async function handleApi(req, res, pathname) {
  const method = req.method;

  // --- status & data-folder config (for the Sync card) ---
  if (pathname === '/api/status' && method === 'GET') {
    return sendJson(res, 200, {
      version: VERSION,
      platform: process.platform,
      dataDir: DATA_DIR,
      configPath: CONFIG_PATH,
      // report the file that actually won, not the one we'd prefer — otherwise
      // the Sync card claims 'default' while a legacy config is in force
      configuredVia: dataDirArg ? 'command line' : DATA_DIR_ENV ? 'environment variable'
        : config.dataDir ? path.basename(configPathUsed) : 'default',
    });
  }
  if (pathname === '/api/config' && method === 'POST') {
    const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8'));
    const target = path.resolve(String(body.dataDir || '').trim());
    if (!target || target === ROOT) return sendJson(res, 400, { error: 'invalid folder path' });
    fs.mkdirSync(path.join(target, 'worlds'), { recursive: true });
    let copied = 0;
    if (body.copyData && target !== DATA_DIR) {
      const existing = fs.readdirSync(path.join(target, 'worlds'));
      for (const wid of listWorldIds()) {
        if (existing.includes(wid)) continue; // never overwrite data already at the target
        copyDirSync(path.join(WORLDS_DIR, wid), path.join(target, 'worlds', wid));
        copied++;
      }
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...config, dataDir: target }, null, 2));
    return sendJson(res, 200, { ok: true, copied, restartRequired: true, dataDir: target });
  }

  // --- world management ---
  if (pathname === '/api/worlds') {
    if (method === 'GET') {
      const worlds = listWorldIds().map((wid) => {
        const dir = path.join(WORLDS_DIR, wid);
        let meta = { name: wid, description: '' };
        try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'world.json'), 'utf8')); } catch { /* show id */ }
        const entities = fs.existsSync(path.join(dir, 'entities'))
          ? fs.readdirSync(path.join(dir, 'entities')).filter((f) => f.endsWith('.json')).length : 0;
        return { id: wid, name: meta.name || wid, description: meta.description || '', entities };
      });
      return sendJson(res, 200, worlds);
    }
    if (method === 'POST') {
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8'));
      const wid = createWorld(String(body.name || 'New World'));
      return sendJson(res, 200, { ok: true, id: wid });
    }
  }

  const worldsMatch = pathname.match(/^\/api\/worlds\/([^/]+)$/);
  if (worldsMatch && method === 'DELETE') {
    const wid = decodeURIComponent(worldsMatch[1]);
    const dir = worldDir(wid);
    if (listWorldIds().length <= 1) return sendJson(res, 400, { error: 'cannot delete the only world' });
    const trash = path.join(DATA_DIR, '.trash');
    fs.mkdirSync(trash, { recursive: true });
    fs.renameSync(dir, path.join(trash, `${wid}-${Date.now()}`));
    return sendJson(res, 200, { ok: true, note: 'moved to data/.trash, not erased' });
  }

  // --- world-scoped routes: /api/w/<wid>/... ---
  const scoped = pathname.match(/^\/api\/w\/([^/]+)(\/.*)$/);
  if (!scoped) return sendJson(res, 404, { error: 'unknown api route' });
  const wid = decodeURIComponent(scoped[1]);
  const route = scoped[2];
  const dir = worldDir(wid);

  if (route === '/world') {
    const worldPath = path.join(dir, 'world.json');
    if (method === 'GET') return sendJson(res, 200, JSON.parse(fs.readFileSync(worldPath, 'utf8')));
    if (method === 'PUT') {
      const body = JSON.parse((await readBody(req, 2 * 1024 * 1024)).toString('utf8'));
      fs.writeFileSync(worldPath, JSON.stringify(body, null, 2));
      return sendJson(res, 200, { ok: true });
    }
  }

  if (route === '/entities' && method === 'GET') {
    return sendJson(res, 200, listEntities(dir));
  }

  const entityMatch = route.match(/^\/entities\/([^/]+)$/);
  if (entityMatch) {
    const id = decodeURIComponent(entityMatch[1]);
    if (!SAFE_ID.test(id)) return sendJson(res, 400, { error: 'invalid id' });
    const file = path.join(dir, 'entities', id + '.json');
    if (method === 'GET') {
      if (!fs.existsSync(file)) return sendJson(res, 404, { error: 'not found' });
      return sendJson(res, 200, JSON.parse(fs.readFileSync(file, 'utf8')));
    }
    if (method === 'PUT') {
      const body = JSON.parse((await readBody(req, 8 * 1024 * 1024)).toString('utf8'));
      if (body.id !== id) return sendJson(res, 400, { error: 'id mismatch' });
      body.updated = new Date().toISOString();
      try { writeHistory(dir, id); } catch (err) { console.error('[mundusmaker] history write failed:', err.message); }
      fs.writeFileSync(file, JSON.stringify(body, null, 2));
      return sendJson(res, 200, { ok: true, entity: body });
    }
    if (method === 'DELETE') {
      if (fs.existsSync(file)) {
        // never actually erase — deleted entries are recoverable from data/.trash
        const trash = path.join(DATA_DIR, '.trash');
        fs.mkdirSync(trash, { recursive: true });
        fs.renameSync(file, path.join(trash, `${wid}--${id}--${Date.now()}.json`));
      }
      return sendJson(res, 200, { ok: true, note: 'moved to data/.trash' });
    }
  }

  // entity version history: list versions, restore one
  const histMatch = route.match(/^\/entities\/([^/]+)\/history(?:\/([^/]+))?$/);
  if (histMatch) {
    const id = decodeURIComponent(histMatch[1]);
    if (!SAFE_ID.test(id)) return sendJson(res, 400, { error: 'invalid id' });
    const hd = historyDir(dir, id);
    if (!histMatch[2] && method === 'GET') {
      if (!fs.existsSync(hd)) return sendJson(res, 200, []);
      const items = fs.readdirSync(hd).filter((f) => f.endsWith('.json')).sort().reverse()
        .map((f) => {
          const item = { stamp: f.replace(/\.json$/, '') };
          try {
            const j = JSON.parse(fs.readFileSync(path.join(hd, f), 'utf8'));
            item.name = j.name;
            item.updated = j.updated;
            item.blocks = (j.blocks || []).length;
          } catch { /* listed by stamp only */ }
          return item;
        });
      return sendJson(res, 200, items);
    }
    if (histMatch[2] && method === 'POST') {
      const stamp = decodeURIComponent(histMatch[2]);
      if (!/^[\w-]+$/.test(stamp)) return sendJson(res, 400, { error: 'invalid stamp' });
      const src = path.join(hd, stamp + '.json');
      if (!fs.existsSync(src)) return sendJson(res, 404, { error: 'version not found' });
      const body = JSON.parse(fs.readFileSync(src, 'utf8'));
      writeHistory(dir, id, true); // the state being replaced must survive, always
      body.updated = new Date().toISOString();
      fs.writeFileSync(path.join(dir, 'entities', id + '.json'), JSON.stringify(body, null, 2));
      return sendJson(res, 200, { ok: true, entity: body });
    }
  }

  // image assets (portraits etc.) live inside the world folder → sync/backup just work
  if (route === '/assets' && method === 'POST') {
    const body = JSON.parse((await readBody(req, 20 * 1024 * 1024)).toString('utf8'));
    const safe = String(body.name || 'image.png').replace(/[^\w.\-]+/g, '_').slice(-80);
    const assetsDir = path.join(dir, 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    let name = safe;
    if (fs.existsSync(path.join(assetsDir, name))) name = `${Date.now().toString(36)}-${safe}`;
    fs.writeFileSync(path.join(assetsDir, name), Buffer.from(String(body.dataBase64 || ''), 'base64'));
    return sendJson(res, 200, { ok: true, file: name });
  }

  if (route === '/export-file' && method === 'POST') {
    const body = JSON.parse((await readBody(req, 100 * 1024 * 1024)).toString('utf8'));
    const name = String(body.name || 'export.pdf').replace(/[^\w.\- ]+/g, '_');
    const target = path.join(dir, 'exports', name);
    fs.writeFileSync(target, Buffer.from(String(body.dataBase64 || ''), 'base64'));
    return sendJson(res, 200, { ok: true, path: target });
  }

  if (route === '/backup' && method === 'GET') {
    const world = JSON.parse(fs.readFileSync(path.join(dir, 'world.json'), 'utf8'));
    // Both format markers are emitted: `mundusmaker` keeps new backups restorable
    // into the older builds already in other GMs' hands, `mundusmaker` is what we
    // read going forward. Restore accepts either.
    return sendJson(res, 200, { mundusmaker: 1, loreweave: 1, exported: new Date().toISOString(), world, entities: listEntities(dir) });
  }

  if (route === '/restore' && method === 'POST') {
    const body = JSON.parse((await readBody(req, 100 * 1024 * 1024)).toString('utf8'));
    const isBackup = body && [body.mundusmaker, body.tomeweaver, body.loreweave].includes(1);
    if (!isBackup || !body.world || !Array.isArray(body.entities)) {
      return sendJson(res, 400, { error: 'not a MundusMaker backup' });
    }
    const entDir = path.join(dir, 'entities');
    for (const f of fs.readdirSync(entDir)) {
      if (f.endsWith('.json')) fs.unlinkSync(path.join(entDir, f));
    }
    fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify(body.world, null, 2));
    for (const ent of body.entities) {
      if (!ent || !SAFE_ID.test(String(ent.id))) continue;
      fs.writeFileSync(path.join(entDir, ent.id + '.json'), JSON.stringify(ent, null, 2));
    }
    return sendJson(res, 200, { ok: true, count: body.entities.length });
  }

  sendJson(res, 404, { error: 'unknown api route' });
}

// ---------- static ----------

/** /assets/<worldId>/<file> → <worldDir>/assets/<file> */
function serveAsset(req, res, pathname) {
  const m = pathname.match(/^\/assets\/([^/]+)\/([^/]+)$/);
  const fail = (code, msg) => { res.writeHead(code, { 'Content-Type': 'text/plain' }); res.end(msg); };
  if (!m) return fail(404, 'not found');
  const wid = decodeURIComponent(m[1]);
  const name = decodeURIComponent(m[2]);
  if (!SAFE_ID.test(wid) || /[/\\]|\.\./.test(name)) return fail(400, 'bad request');
  const file = path.join(WORLDS_DIR, wid, 'assets', name);
  fs.readFile(file, (err, buf) => {
    if (err) return fail(404, 'not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}

// ---------- server ----------

bootstrap();

const server = http.createServer(async (req, res) => {
  const pathname = decodeURI((req.url || '/').split('?')[0]);
  try {
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname);
    } else if (req.method === 'GET' && pathname.startsWith('/assets/')) {
      serveAsset(req, res, pathname);
    } else if (req.method === 'GET') {
      serveStatic(req, res, pathname);
    } else {
      res.writeHead(405);
      res.end();
    }
  } catch (err) {
    console.error(`[mundusmaker] ${req.method} ${pathname} failed:`, err.message);
    sendJson(res, err.status || (err instanceof SyntaxError ? 400 : 500), { error: err.message });
  }
});

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, () => { /* best effort */ });
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`[mundusmaker] port ${PORT} is already in use — MundusMaker is probably already running.`);
    console.log(`[mundusmaker] opening http://localhost:${PORT} in your browser.`);
    if (!NO_OPEN) openBrowser(`http://localhost:${PORT}`);
    process.exit(0);
  }
  throw err;
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`[mundusmaker] serving on ${url}`);
  console.log(`[mundusmaker] worlds stored in ${WORLDS_DIR}`);
  console.log('[mundusmaker] keep this window open while you use MundusMaker. Press Ctrl+C to stop.');
  if (!NO_OPEN) openBrowser(url);
});
