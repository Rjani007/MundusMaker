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
const util = require('util');
const { exec } = require('child_process');
const upgrade = require('./scripts/upgrade');
const folderBackup = require('./scripts/folderbackup');
const { download5etools } = require('./scripts/fetch-5etools');
const updates = require('./scripts/updates');
const sheetDownload = require('./scripts/sheetdownload');
const { atomicWrite, revision, readVersion } = require('./scripts/storage');
const { validateEntity, validateWorld, restoreBackup, recoverTransactions } = require('./scripts/restore');
const { randomUUID, createHash } = require('crypto');

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
// finds no worlds, creates a fresh empty one, and an upgrading user cannot
// tell that apart from having lost their entire campaign. It hits folder-sync
// users hardest — they are the ones who have a config file at all.
//
// On the NEXT rename, put the outgoing name at the FRONT of these lists rather
// than nesting more fallbacks. Only Loreweave was ever distributed; the
// TomeWeaver entries cost one array slot and cover anyone who ran an in-between
// build from source.
const CONFIG_NAMES = ['mundusmaker.config.json', 'tomeweaver.config.json', 'loreweave.config.json'];
// Installed macOS bundles can be replaced or translocated by Finder. Keep
// their writable configuration and default data in Application Support.
// Portable/source installs retain their existing paths and precedence.
const CONFIG_DIR = process.env.MUNDUSMAKER_CONFIG_DIR ? path.resolve(process.env.MUNDUSMAKER_CONFIG_DIR) : ROOT;
const CONFIG_PATH = path.join(CONFIG_DIR, CONFIG_NAMES[0]);
let config = {};
let configPathUsed = CONFIG_PATH;
for (const name of CONFIG_NAMES) {
  const candidate = path.join(CONFIG_DIR, name);
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
const DATA_DIR = path.resolve(dataDirArg || DATA_DIR_ENV || config.dataDir || path.join(CONFIG_DIR, 'data'));
const WORLDS_DIR = path.join(DATA_DIR, 'worlds');
const PORT = Number(portArg || process.env.PORT || config.port || 4870);
const NO_OPEN = flags.includes('--no-open')
  || !!envAny('MUNDUSMAKER_NO_OPEN', 'TOMEWEAVER_NO_OPEN', 'LOREWEAVE_NO_OPEN');
// An empty data folder normally starts with a blank world; tests and demos
// ask for the sample world instead.
const SEED_SAMPLE = flags.includes('--sample');
const CONTAINER = process.env.MUNDUSMAKER_CONTAINER === '1';
// The phone app (mobile/) runs this same server inside the app on the device.
// Its runtime names the deployment; the app opens and closes it, and the data
// folder lives inside the app, so the desktop's lifecycle and folder tools are off.
const MOBILE = !CONTAINER && process.env.MUNDUSMAKER_DEPLOYMENT === 'mobile';
const PKG = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')); } catch { return {}; }
})();
const VERSION = PKG.version || '?';

// Pages are read from disk on every request but this code only at start, so an
// update made while MundusMaker keeps running (windowless, in the tray) leaves
// new pages talking to an old server. /api/status reports it and the app asks
// for a restart. Only the files this process actually loaded count, and a new
// timestamp on the same bytes (a checkout, a copy) is not a change.
const loadedCode = new Map(); // file -> { mtimeMs, size, hash }
const fileHash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function rememberLoadedCode() {
  for (const file of [...Object.keys(require.cache), path.join(ROOT, 'package.json')]) {
    if (!file.startsWith(ROOT + path.sep) || loadedCode.has(file)) continue;
    try { const st = fs.statSync(file); loadedCode.set(file, { mtimeMs: st.mtimeMs, size: st.size, hash: fileHash(file) }); } catch { /* not a file */ }
  }
}
function codeChangedSinceStart() {
  for (const [file, seen] of loadedCode) {
    try {
      const st = fs.statSync(file);
      if (st.mtimeMs === seen.mtimeMs && st.size === seen.size) continue;
      if (fileHash(file) !== seen.hash) return true;
      seen.mtimeMs = st.mtimeMs; // same bytes: skip the hash next time
    } catch { return true; } // removed by the update
  }
  return false;
}
rememberLoadedCode(); // every require is above this line
let libraryDownloadActive = false;
let updateCheckActive = false;
let sheetDownloadActive = false;

// Launchers that run the server without a visible window pass --log: console
// output also goes to logs/mundusmaker.log in the config folder (never the
// data folder, which sync tools carry). Writes are synchronous so the lines
// before an exit are not lost; the file rolls over at 1 MB.
const LOG_FILE = flags.includes('--log') ? path.join(CONFIG_DIR, 'logs', 'mundusmaker.log') : null;
if (LOG_FILE) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    try { if (fs.statSync(LOG_FILE).size > 1024 * 1024) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`); } catch { /* no log yet */ }
    for (const level of ['log', 'warn', 'error']) {
      const original = console[level].bind(console);
      console[level] = (...parts) => {
        original(...parts);
        try { fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${util.format(...parts)}\n`); } catch { /* a full disk must not stop the app */ }
      };
    }
    process.on('uncaughtException', (err) => {
      console.error(`[mundusmaker] stopped by an unexpected error: ${err.stack || err}`);
      process.exit(1);
    });
    console.log(`[mundusmaker] MundusMaker ${VERSION} starting (log: ${LOG_FILE})`);
  } catch (err) {
    console.error(`[mundusmaker] could not open the log file ${LOG_FILE}: ${err.message}`);
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
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
    spell: { label: 'Spell', plural: 'Spells', color: '#9b59d0', fields: ['Level', 'School', 'Casting time', 'Range', 'Duration', 'Classes'] },
    handout: { label: 'Handout', plural: 'Handouts', color: '#bbaa78', fields: ['Kind', 'Found at'] },
    session: { label: 'Session', plural: 'Sessions', color: '#4ab8a8', fields: ['Played on', 'Players'] },
    note: { label: 'Note', plural: 'Notes', color: '#8a8f98', fields: [] },
  };
}

// ---------- second-folder backups (1.9) ----------

let folderBackupError = null;
/** Why folder backups are off here: Docker hosts back up their volume, and a
 *  data folder named on the command line or in the environment (tests,
 *  previews) must never write into the owner's backup folder. */
function folderBackupUnavailable() {
  if (CONTAINER) return 'Docker hosts back up their /data volume instead.';
  if (MOBILE) return 'On a phone or tablet, use Download backup on this page and keep the file somewhere safe; the app cannot write to a second folder yet.';
  if (dataDirArg || DATA_DIR_ENV) return 'Second-folder backups run only for the data folder MundusMaker chose itself, not one given on the command line.';
  return null;
}
function saveBackupSettings(settings) {
  const next = { ...config };
  if (settings) next.secondBackup = settings; else delete next.secondBackup;
  atomicWrite(CONFIG_PATH, JSON.stringify(next, null, 2));
  config = next;
}
function runFolderBackup() {
  const settings = config.secondBackup;
  try {
    const result = folderBackup.runBackup({ dataDir: DATA_DIR, target: settings.dir, installId: settings.installId, version: VERSION, keep: settings.keep || 7 });
    saveBackupSettings({ ...settings, last: new Date().toISOString() });
    folderBackupError = null;
    return result;
  } catch (err) {
    folderBackupError = { at: new Date().toISOString(), message: err.message };
    throw err;
  }
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
  atomicWrite(path.join(dir, 'world.json'),
    JSON.stringify({ name: String(name).trim() || 'New World', description: '', era: '', types: defaultTypes() }, null, 2));
  return wid;
}

/** The sample world, copied in as a new world. Returns its id. */
function addSampleWorld() {
  const wid = uniqueWorldId('The Sundered Reach');
  copyDirSync(SAMPLE_DIR, path.join(WORLDS_DIR, wid));
  fs.mkdirSync(path.join(WORLDS_DIR, wid, 'exports'), { recursive: true });
  return wid;
}

/** A data folder without worlds gets one: a blank world the GM renames, or the sample with --sample. */
function addFirstWorld() {
  if (listWorldIds().length) return;
  if (SEED_SAMPLE && fs.existsSync(path.join(SAMPLE_DIR, 'world.json'))) {
    console.log('[mundusmaker] first run: seeding the sample world "The Sundered Reach"');
    addSampleWorld();
  } else {
    console.log('[mundusmaker] first run: created an empty world, "My World"');
    createWorld('My World');
  }
}

function bootstrap({ scanFirst = false } = {}) {
  fs.mkdirSync(WORLDS_DIR, { recursive: true });
  recoverTransactions(DATA_DIR); // rollback interrupted restores BEFORE seeding or snapshots

  // migrate v1 single-world layout
  const legacyWorld = path.join(DATA_DIR, 'world.json');
  if (fs.existsSync(legacyWorld)) {
    let name = 'My World';
    try { name = JSON.parse(fs.readFileSync(legacyWorld, 'utf8')).name || name; } catch { /* keep default */ }
    const wid = uniqueWorldId(name);
    const dir = path.join(WORLDS_DIR, wid);
    fs.mkdirSync(dir, { recursive: true });
    fs.renameSync(legacyWorld, path.join(dir, 'world.json'));
    for (const sub of ['entities', 'exports', 'assets']) {
      const from = path.join(DATA_DIR, sub);
      if (fs.existsSync(from)) fs.renameSync(from, path.join(dir, sub));
    }
    console.log(`[mundusmaker] migrated existing world into worlds/${wid}/`);
  }

  // a copy from an older install interrupted by a crash never became a world
  upgrade.cleanStaging(DATA_DIR);
  // no worlds and no upgrade record: the first start of this data folder,
  // when worlds from an older install beside this one are brought over
  const fresh = !listWorldIds().length && !upgrade.hasLedger(DATA_DIR);

  // A first start that looks for older installs makes its first world only
  // if none came over (server.listen), so an upgrade adds no empty world.
  if (!(fresh && scanFirst)) addFirstWorld();

  for (const wid of listWorldIds()) {
    fs.mkdirSync(path.join(WORLDS_DIR, wid, 'entities'), { recursive: true });
    fs.mkdirSync(path.join(WORLDS_DIR, wid, 'exports'), { recursive: true });
  }

  try { snapshotWorlds(); } catch (err) { console.error('[mundusmaker] snapshot failed:', err.message); }
  return { fresh };
}

/**
 * Copy one world (world.json, entities, assets — not exports) into .snapshots.
 * The stamp starts with the date so lexical order stays chronological even when
 * a label ("pre-restore") is appended — retention shifts oldest-first off that
 * same lexical sort.
 */
function snapshotWorld(wid, label) {
  const snapDir = path.join(DATA_DIR, '.snapshots', wid);
  fs.mkdirSync(snapDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 23).replace(/[T:.]/g, '-') + (label ? `-${label}` : '') + '-' + randomUUID();
  const dest = path.join(snapDir, stamp);
  const pending = path.join(snapDir, '.pending-' + randomUUID());
  const src = path.join(WORLDS_DIR, wid);
  fs.mkdirSync(pending);
  atomicWrite(path.join(pending, 'world.json'), fs.readFileSync(path.join(src, 'world.json')));
  for (const sub of ['entities', 'assets']) {
    if (fs.existsSync(path.join(src, sub))) copyDirSync(path.join(src, sub), path.join(pending, sub));
  }
  fs.renameSync(pending, dest); // incomplete snapshots are never listed as recoverable
  const all = fs.readdirSync(snapDir).filter((name) => !name.startsWith('.')).sort();
  while (all.length > 7) fs.rmSync(path.join(snapDir, all.shift()), { recursive: true, force: true });
  return stamp;
}

/** Daily safety copies of every world. Keeps the last 7 per world. */
function snapshotWorlds() {
  const snapRoot = path.join(DATA_DIR, '.snapshots');
  for (const wid of listWorldIds()) {
    const snapDir = path.join(snapRoot, wid);
    fs.mkdirSync(snapDir, { recursive: true });
    const existing = fs.readdirSync(snapDir).filter((name) => !name.startsWith('.')).sort();
    if (existing.length) {
      const age = Date.now() - fs.statSync(path.join(snapDir, existing[existing.length - 1])).mtimeMs;
      if (age < 20 * 3600 * 1000) continue; // one per day is plenty
    }
    const stamp = snapshotWorld(wid);
    console.log(`[mundusmaker] daily snapshot: ${wid} → .snapshots/${wid}/${stamp}`);
  }
}

// ---------- trash & snapshot recovery ----------

const TRASH_ENTITY_KEY = /^([a-z0-9-]{4,258})--(\d{10,17})$/;
const TRASH_WORLD_KEY = /^([a-z0-9][a-z0-9-]{0,127})-(\d{10,17})$/;
const SNAPSHOT_STAMP = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}(?:-[a-z0-9][a-z0-9-]{0,80})?$/;

function recoveryError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function readRecoveryJson(file, maxBytes) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) return null;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

// The on-disk `<world>--<entity>--<millis>.json` format predates this browser.
// `--` is legal inside an id, so split from the known entity.id suffix instead
// of guessing which double-hyphen belongs to which id.
function parseTrashEntityKey(key, entity) {
  const match = key.match(TRASH_ENTITY_KEY);
  const id = String(entity?.id || '');
  if (!match || !SAFE_ID.test(id)) return null;
  const suffix = `--${id}`;
  if (!match[1].endsWith(suffix)) return null;
  const wid = match[1].slice(0, -suffix.length);
  return SAFE_ID.test(wid) ? { wid, id, millis: match[2] } : null;
}

function jsonFileCount(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((item) => item.isFile() && !item.isSymbolicLink() && item.name.endsWith('.json')).length;
  } catch { return 0; }
}

function epochIso(value, fallbackPath) {
  const millis = Number(value);
  if (Number.isFinite(millis)) {
    const date = new Date(millis);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  try { return fs.statSync(fallbackPath).mtime.toISOString(); } catch { return null; }
}

function snapshotIso(stamp, dir) {
  const match = stamp.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/);
  if (match) {
    const date = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00.000Z`);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  try { return fs.statSync(dir).mtime.toISOString(); } catch { return null; }
}

function liveWorldName(wid) {
  const meta = readRecoveryJson(path.join(WORLDS_DIR, wid, 'world.json'), 2 * 1024 * 1024);
  return meta?.name || wid;
}

function hasTrashedWorld(wid) {
  if (!SAFE_ID.test(wid)) return false;
  const trashDir = path.join(DATA_DIR, '.trash');
  let items = [];
  try { items = fs.readdirSync(trashDir, { withFileTypes: true }); } catch { return false; }
  return items.some((item) => {
    if (!item.isDirectory() || item.isSymbolicLink()) return false;
    const match = item.name.match(TRASH_WORLD_KEY);
    if (!match || match[1] !== wid) return false;
    return !!readRecoveryJson(path.join(trashDir, item.name, 'world.json'), 2 * 1024 * 1024);
  });
}

/**
 * Return display metadata only. Keys are validated again on restore and never
 * treated as paths supplied by the client.
 */
function listRecovery() {
  const worlds = [];
  const entities = [];
  const snapshots = [];
  const deletedWorldNames = new Map();
  const trashDir = path.join(DATA_DIR, '.trash');
  let trashItems = [];
  try { trashItems = fs.readdirSync(trashDir, { withFileTypes: true }); } catch { /* no trash yet */ }

  for (const item of trashItems) {
    if (!item.isDirectory() || item.isSymbolicLink()) continue;
    const match = item.name.match(TRASH_WORLD_KEY);
    if (!match) continue;
    const src = path.join(trashDir, item.name);
    const meta = readRecoveryJson(path.join(src, 'world.json'), 2 * 1024 * 1024);
    if (!meta) continue; // excludes trashed compendium packs and incomplete folders
    const row = {
      key: item.name,
      originalId: match[1],
      name: String(meta.name || match[1]),
      description: String(meta.description || ''),
      entities: jsonFileCount(path.join(src, 'entities')),
      deletedAt: epochIso(match[2], src),
      idCollision: fs.existsSync(path.join(WORLDS_DIR, match[1])),
    };
    worlds.push(row);
    if (!deletedWorldNames.has(row.originalId)) deletedWorldNames.set(row.originalId, row.name);
  }

  for (const item of trashItems) {
    if (!item.isFile() || item.isSymbolicLink() || !item.name.endsWith('.json')) continue;
    const key = item.name.slice(0, -5);
    if (!TRASH_ENTITY_KEY.test(key)) continue;
    const file = path.join(trashDir, item.name);
    const entity = readRecoveryJson(file, 8 * 1024 * 1024);
    const parsed = parseTrashEntityKey(key, entity);
    if (!parsed) continue;
    const liveDir = path.join(WORLDS_DIR, parsed.wid);
    const worldAvailable = fs.existsSync(path.join(liveDir, 'world.json'));
    const trashedWorldExists = deletedWorldNames.has(parsed.wid);
    const originalWorldName = deletedWorldNames.get(parsed.wid)
      || (worldAvailable ? liveWorldName(parsed.wid) : parsed.wid);
    entities.push({
      key,
      worldId: parsed.wid,
      worldName: originalWorldName,
      originalWorldName,
      id: parsed.id,
      name: String(entity.name || parsed.id),
      type: String(entity.type || 'note'),
      deletedAt: epochIso(parsed.millis, file),
      worldAvailable,
      trashedWorldExists,
      destinationAmbiguous: trashedWorldExists,
      destinationRequired: !worldAvailable || trashedWorldExists,
      idCollision: worldAvailable && fs.existsSync(path.join(liveDir, 'entities', parsed.id + '.json')),
    });
  }

  const snapshotRoot = path.join(DATA_DIR, '.snapshots');
  let worldDirs = [];
  try { worldDirs = fs.readdirSync(snapshotRoot, { withFileTypes: true }); } catch { /* no snapshots yet */ }
  for (const worldItem of worldDirs) {
    if (!worldItem.isDirectory() || worldItem.isSymbolicLink() || !SAFE_ID.test(worldItem.name)) continue;
    const worldSnapshotDir = path.join(snapshotRoot, worldItem.name);
    let stampItems = [];
    try {
      stampItems = fs.readdirSync(worldSnapshotDir, { withFileTypes: true })
        .filter((item) => item.isDirectory() && !item.isSymbolicLink() && SNAPSHOT_STAMP.test(item.name))
        .sort((a, b) => a.name.localeCompare(b.name)).slice(-7).reverse();
    } catch { continue; }
    for (const stampItem of stampItems) {
      const src = path.join(worldSnapshotDir, stampItem.name);
      const meta = readRecoveryJson(path.join(src, 'world.json'), 2 * 1024 * 1024);
      if (!meta) continue;
      snapshots.push({
        worldId: worldItem.name,
        stamp: stampItem.name,
        name: String(meta.name || worldItem.name),
        entities: jsonFileCount(path.join(src, 'entities')),
        createdAt: snapshotIso(stampItem.name, src),
        worldAvailable: fs.existsSync(path.join(WORLDS_DIR, worldItem.name, 'world.json')),
      });
    }
  }

  const newestFirst = (a, b) => String(b.deletedAt || b.createdAt || '').localeCompare(String(a.deletedAt || a.createdAt || ''));
  worlds.sort(newestFirst);
  entities.sort(newestFirst);
  snapshots.sort(newestFirst);
  return {
    generatedAt: new Date().toISOString(),
    trash: { entities, worlds },
    snapshots,
    policy: { trashSourceRetained: true, snapshotSourceRetained: true, snapshotsPerWorld: 7 },
  };
}

function uniqueRestoredId(preferred, exists) {
  if (SAFE_ID.test(preferred) && !exists(preferred)) return preferred;
  const source = SAFE_ID.test(preferred) ? preferred : slugify(preferred);
  let suffix = '-restored';
  let candidate = source.slice(0, 128 - suffix.length) + suffix;
  let number = 2;
  while (exists(candidate)) {
    suffix = `-restored-${number++}`;
    candidate = source.slice(0, 128 - suffix.length) + suffix;
  }
  return candidate;
}

function copyRecoveryDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const item of fs.readdirSync(src, { withFileTypes: true })) {
    if (item.isSymbolicLink()) continue;
    const from = path.join(src, item.name);
    const to = path.join(dest, item.name);
    if (item.isDirectory()) copyRecoveryDirSync(from, to);
    else if (item.isFile()) fs.copyFileSync(from, to);
  }
}

function rewriteAssetRefs(value, fromWid, toWid) {
  const from = `/assets/${fromWid}/`;
  const to = `/assets/${toWid}/`;
  let changed = false;
  const visit = (item) => {
    if (typeof item === 'string') {
      if (!item.includes(from)) return item;
      changed = true;
      return item.split(from).join(to);
    }
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i++) item[i] = visit(item[i]);
      return item;
    }
    if (item && typeof item === 'object') {
      for (const key of Object.keys(item)) item[key] = visit(item[key]);
    }
    return item;
  };
  const result = visit(value);
  return { result, changed };
}

function rewriteJsonAssetRefs(file, fromWid, toWid) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { return; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) return;
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
  const rewritten = rewriteAssetRefs(value, fromWid, toWid);
  if (rewritten.changed) fs.writeFileSync(file, JSON.stringify(rewritten.result, null, 2));
}

function rewriteJsonTree(dir, fromWid, toWid) {
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const item of items) {
    if (item.isSymbolicLink()) continue;
    const file = path.join(dir, item.name);
    if (item.isDirectory()) rewriteJsonTree(file, fromWid, toWid);
    else if (item.isFile() && item.name.endsWith('.json')) rewriteJsonAssetRefs(file, fromWid, toWid);
  }
}

/** Rebase only JSON that can hold world content; assets/ and exports/ stay byte-identical. */
function rewriteStagedWorldAssetRefs(staged, fromWid, toWid) {
  if (fromWid === toWid) return;
  if (!SAFE_ID.test(fromWid) || !SAFE_ID.test(toWid)) throw recoveryError('invalid restored world id');
  rewriteJsonAssetRefs(path.join(staged, 'world.json'), fromWid, toWid); // type templates
  rewriteJsonTree(path.join(staged, 'entities'), fromWid, toWid);
  rewriteJsonTree(path.join(staged, '.history'), fromWid, toWid);
}

/** Copy a recovery source through staging, then atomically publish a new world. */
function restoreWorldCopy(src, sourceWid, preferredId = sourceWid) {
  if (!SAFE_ID.test(sourceWid)) throw recoveryError('invalid recovery source world id');
  const meta = readRecoveryJson(path.join(src, 'world.json'), 2 * 1024 * 1024);
  if (!meta) throw recoveryError('recovery source is not a readable world', 409);
  const stagingRoot = path.join(DATA_DIR, '.restore-staging');
  fs.mkdirSync(stagingRoot, { recursive: true });
  const staged = fs.mkdtempSync(path.join(stagingRoot, 'world-'));
  try {
    copyRecoveryDirSync(src, staged);
    fs.mkdirSync(path.join(staged, 'entities'), { recursive: true });
    fs.mkdirSync(path.join(staged, 'exports'), { recursive: true });
    let wid = uniqueRestoredId(preferredId, (id) => fs.existsSync(path.join(WORLDS_DIR, id)));
    let stagedWid = sourceWid;
    // The existence check and rename are deliberately both present: two rapid
    // restore requests still cannot overwrite one another.
    while (true) {
      try {
        rewriteStagedWorldAssetRefs(staged, stagedWid, wid);
        stagedWid = wid;
        fs.renameSync(staged, path.join(WORLDS_DIR, wid));
        return { worldId: wid, name: String(meta.name || wid), renamed: wid !== preferredId };
      } catch (err) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(err.code)) throw err;
        wid = uniqueRestoredId(preferredId, (id) => fs.existsSync(path.join(WORLDS_DIR, id)));
      }
    }
  } finally {
    // Only a failed temporary copy can remain here; recovery sources and live
    // worlds are never cleanup targets.
    if (fs.existsSync(staged)) fs.rmSync(staged, { recursive: true, force: true });
  }
}

function restoreRecovery(body) {
  if (!body || body.confirm !== true) throw recoveryError('restore confirmation required');
  const trashDir = path.join(DATA_DIR, '.trash');

  if (body.kind === 'entity') {
    const key = String(body.key || '');
    if (!TRASH_ENTITY_KEY.test(key)) throw recoveryError('invalid deleted entry key');
    const src = path.join(trashDir, key + '.json');
    const entity = readRecoveryJson(src, 8 * 1024 * 1024);
    const parsed = parseTrashEntityKey(key, entity);
    if (!parsed) throw recoveryError('deleted entry not found', 404);
    const destinationWasProvided = Object.prototype.hasOwnProperty.call(body, 'destinationWorldId');
    let destinationWid;
    if (destinationWasProvided) {
      if (typeof body.destinationWorldId !== 'string' || !SAFE_ID.test(body.destinationWorldId)) {
        throw recoveryError('invalid destination world id');
      }
      destinationWid = body.destinationWorldId;
    } else {
      const originalExists = fs.existsSync(path.join(WORLDS_DIR, parsed.wid, 'world.json'));
      if (!originalExists || hasTrashedWorld(parsed.wid)) {
        throw recoveryError('destinationWorldId is required because the original world is missing or ambiguous', 409);
      }
      destinationWid = parsed.wid; // legacy request, safe only while lineage is unambiguous
    }
    const dir = worldDir(destinationWid);
    const entDir = path.join(dir, 'entities');
    fs.mkdirSync(entDir, { recursive: true });
    let id = uniqueRestoredId(parsed.id, (candidate) => fs.existsSync(path.join(entDir, candidate + '.json')));
    const restoredSource = destinationWid === parsed.wid
      ? entity : rewriteAssetRefs(entity, parsed.wid, destinationWid).result;
    while (true) {
      const restored = { ...restoredSource, id, updated: new Date().toISOString() };
      try {
        fs.writeFileSync(path.join(entDir, id + '.json'), JSON.stringify(restored, null, 2), { flag: 'wx' });
        return {
          ok: true, kind: 'entity', sourceRetained: true,
          restored: {
            sourceWorldId: parsed.wid, worldId: destinationWid,
            entityId: id, name: String(restored.name || id), renamed: id !== parsed.id,
          },
        };
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        id = uniqueRestoredId(parsed.id, (candidate) => fs.existsSync(path.join(entDir, candidate + '.json')));
      }
    }
  }

  if (body.kind === 'world') {
    const key = String(body.key || '');
    const match = key.match(TRASH_WORLD_KEY);
    if (!match) throw recoveryError('invalid deleted world key');
    const src = path.join(trashDir, key);
    let stat;
    try { stat = fs.lstatSync(src); } catch { throw recoveryError('deleted world not found', 404); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw recoveryError('deleted world not found', 404);
    return { ok: true, kind: 'world', sourceRetained: true, restored: restoreWorldCopy(src, match[1], match[1]) };
  }

  if (body.kind === 'snapshot') {
    const wid = String(body.worldId || '');
    const stamp = String(body.stamp || '');
    if (!SAFE_ID.test(wid) || !SNAPSHOT_STAMP.test(stamp)) throw recoveryError('invalid snapshot key');
    const src = path.join(DATA_DIR, '.snapshots', wid, stamp);
    let stat;
    try { stat = fs.lstatSync(src); } catch { throw recoveryError('snapshot not found', 404); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw recoveryError('snapshot not found', 404);
    return { ok: true, kind: 'snapshot', sourceRetained: true, restored: restoreWorldCopy(src, wid, wid) };
  }

  throw recoveryError('unknown recovery kind');
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

// ---------- request guard ----------
// The server listens on 127.0.0.1 only, yet any web page the GM has open can
// send it requests. A cross-site "simple" POST (text/plain, a form) needs no
// CORS preflight, and a DNS-rebinding page can even read the replies because
// the browser thinks they are its own. So before any route runs:
//  - every request must be addressed to localhost, 127.0.0.1 or [::1] (a
//    rebinding page names its own domain in Host);
//  - API and asset requests marked cross-site or same-site are refused, reads
//    included, so no other page (another localhost port too) can embed them;
//  - anything but GET and HEAD must come from this app's own page (an Origin,
//    when sent, is exactly this host) and be declared application/json, which
//    another page cannot send here without a preflight this server never grants.
// Native clients (the tray, installer, launchers and tests) send no Origin or
// Sec-Fetch headers and pass. The Docker gateway checks the public origin
// itself, then forwards an Origin rewritten to this host (scripts/container.js).
const LOOPBACK_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/;

function guardRequest(req, pathname) {
  const refuse = (status, message) => Object.assign(new Error(message), { status });
  const host = String(req.headers.host || '').trim().toLowerCase();
  if (!LOOPBACK_HOST.test(host)) throw refuse(403, `MundusMaker answers only at http://localhost:${PORT}.`);
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  const write = req.method !== 'GET' && req.method !== 'HEAD';
  if ((site === 'cross-site' || site === 'same-site') && (write || pathname.startsWith('/api/') || pathname.startsWith('/assets/'))) {
    throw refuse(403, 'Only MundusMaker’s own pages can use its data. Open MundusMaker directly instead.');
  }
  if (!write) return;
  if (req.headers.origin !== undefined && String(req.headers.origin).trim().toLowerCase() !== `http://${host}`) {
    throw refuse(403, 'Only MundusMaker’s own pages can make changes. Open MundusMaker directly instead.');
  }
  const type = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (type !== 'application/json') throw refuse(415, 'MundusMaker accepts changes only as JSON sent by its own pages.');
}

// Uploads are raster images only (portraits, handout art, pictures brought in
// by the Markdown import), and the bytes must really be one of these formats.
// SVG is refused: opened on its own it is a page that can run script.
const RASTER_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
function isRasterImage(buf) {
  const ascii = (from, to) => buf.subarray(from, to).toString('latin1');
  return ascii(0, 8) === '\x89PNG\r\n\x1a\n'
    || (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
    || /^GIF8[79]a$/.test(ascii(0, 6))
    || (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP');
}

// Exports are the files the Export page and the map editor make. They are
// never served, but the GM opens them from the folder, so nothing else lands there.
const EXPORT_TYPES = new Set(['.pdf', '.png', '.zip', '.uvtt']);

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
  atomicWrite(path.join(hd, stamp + '-' + randomUUID() + '.json'), fs.readFileSync(file));
  const all = fs.readdirSync(hd).filter((f) => f.endsWith('.json')).sort();
  while (all.length > HISTORY_KEEP) fs.unlinkSync(path.join(hd, all.shift()));
}

// Folder-sync tools keep both versions of a file changed on two devices at
// once: "<id> (conflicted copy …)" (Dropbox, Nextcloud), "<id>.sync-conflict-…"
// (Syncthing), "<id> (1)", "<id>-<DEVICE>" and the like. Such a copy is a
// whole, valid entry whose file name no longer matches its id. It is reported
// as a copy, never loaded (it would duplicate the entry) and never modified.
function syncCopyOf(file, entity) {
  const stem = file.slice(0, -5);
  if (!entity || typeof entity.id !== 'string' || stem === entity.id || !stem.startsWith(entity.id)) return null;
  const rest = stem.slice(entity.id.length);
  if (!/^[\s._(-]/.test(rest)) return null;
  try { validateEntity(entity); } catch { return null; }
  const tool = /conflicted copy/i.test(rest) ? 'Dropbox or Nextcloud' : /^\.sync-conflict-/i.test(rest) ? 'Syncthing' : null;
  return { id: entity.id, name: entity.name, tool };
}

function readEntities(dir) {
  const entDir = path.join(dir, 'entities');
  const result = { entities: [], revisions: {}, issues: [] };
  if (!fs.existsSync(entDir)) return result;
  for (const f of fs.readdirSync(entDir)) {
    if (!f.endsWith('.json')) continue;
    let entity = null;
    try {
      const stored = readVersion(path.join(entDir, f));
      entity = JSON.parse(stored.bytes.toString('utf8'));
      validateEntity(entity, f.slice(0, -5));
      result.entities.push(entity);
      result.revisions[entity.id] = stored.revision;
    } catch (e) {
      const copy = syncCopyOf(f, entity);
      if (copy) {
        const main = `entities/${copy.id}.json`;
        const made = copy.tool ? `${copy.tool} made when the entry was changed on two devices at once` : 'a sync tool or file manager made';
        result.issues.push({
          file: `entities/${f}`, kind: 'sync-copy', entityId: copy.id,
          message: fs.existsSync(path.join(entDir, `${copy.id}.json`))
            ? `A copy of “${copy.name}” that ${made}. MundusMaker uses ${main}; this copy is left untouched so its edits are not lost.`
            : `A copy of “${copy.name}” that ${made}. The entry's main file, ${main}, is missing, so this copy may hold the only version. Rename the copy to ${copy.id}.json to use it.`,
        });
        console.warn(`[mundusmaker] found a sync copy of ${copy.id}: ${f}`);
        continue;
      }
      result.issues.push({ file: `entities/${f}`, message: 'This file could not be read as an entry. The original file has not been changed.' });
      console.error(`[mundusmaker] skipping unreadable entity file ${f}: ${e.message}`);
    }
  }
  return result;
}

function listEntities(dir) { return readEntities(dir).entities; }

// Revisions are hashes of actual file bytes, so edits by another tab or a
// folder-sync tool invalidate them without adding metadata to the user's JSON.
function checkRevision(req, file, draft) {
  const current = readVersion(file);
  const expected = req.headers['if-match'];
  const creating = req.headers['if-none-match'] === '*';
  if (!expected && !creating) throw Object.assign(new Error('Reload MundusMaker before saving; this page does not support safe saves.'), { status: 428 });
  if ((creating && !current.bytes) || (expected && expected === current.revision)) return current;
  // A response can be lost after a successful write. Retrying the identical
  // content is harmless, and must not strand an already-saved draft.
  if (draft && current.bytes) {
    try {
      const stored = JSON.parse(current.bytes.toString('utf8'));
      const incoming = { ...draft };
      if (draft.id) { delete stored.updated; delete incoming.updated; }
      if (JSON.stringify(stored) === JSON.stringify(incoming)) return { ...current, identical: true };
    } catch { /* unreadable files must never be overwritten */ }
  }
  let copy = '';
  if (draft) {
    const conflictDir = path.join(DATA_DIR, '.conflicts');
    fs.mkdirSync(conflictDir, { recursive: true });
    const name = revision(path.relative(DATA_DIR, file) + '\n' + JSON.stringify(draft)).replace(/"/g, '') + '.json';
    atomicWrite(path.join(conflictDir, name), JSON.stringify({ file: path.relative(DATA_DIR, file), draft }, null, 2));
    copy = ` Your draft is preserved in .conflicts/${name} inside your data folder.`;
  }
  throw Object.assign(new Error('This file changed or was deleted since you opened it. The disk version was kept.' + copy + ' Download your edits before reloading to compare both versions.'), { status: 409 });
}

function sendVersion(res, file, value) {
  res.setHeader('ETag', readVersion(file).revision);
  return sendJson(res, 200, value);
}

function storedSiteName(map, siteKey) {
  const renamed = map.siteEdits?.[siteKey]?.name;
  if (typeof renamed === 'string' && renamed.trim()) return renamed.trim();
  if (!siteKey.startsWith('custom:') || !Array.isArray(map.sites)) return '';
  const site = map.sites.find((item) => item && `custom:${item.id}` === siteKey);
  return typeof site?.name === 'string' ? site.name.trim() : '';
}

/** Read every live world and report map links whose target entry is missing. */
function listLinkIntegrity() {
  const worlds = [];
  for (const wid of listWorldIds()) {
    const dir = path.join(WORLDS_DIR, wid);
    const entities = listEntities(dir);
    const entityIds = new Set(entities.map((entity) => entity?.id).filter((id) => typeof id === 'string'));
    const world = readRecoveryJson(path.join(dir, 'world.json'), 2 * 1024 * 1024);
    const danglingLinks = [];
    let links = 0;

    for (const entity of entities) {
      const map = entity?.map;
      if (!map?.scaleLinks || typeof map.scaleLinks !== 'object' || Array.isArray(map.scaleLinks)) continue;
      for (const [siteKey, rawTargetId] of Object.entries(map.scaleLinks)) {
        if (rawTargetId === null || rawTargetId === undefined || rawTargetId === '') continue;
        links++;
        const targetId = String(rawTargetId);
        if (entityIds.has(targetId)) continue;
        danglingLinks.push({
          mapId: String(entity.id || ''),
          mapName: String(entity.name || entity.id || 'Unnamed map'),
          mapKind: String(map.kind || 'map'),
          siteKey,
          siteName: storedSiteName(map, siteKey),
          targetId,
        });
      }
    }

    danglingLinks.sort((a, b) => a.mapName.localeCompare(b.mapName) || a.siteKey.localeCompare(b.siteKey));
    worlds.push({
      id: wid,
      name: String(world?.name || wid),
      links,
      danglingLinks,
    });
  }
  worlds.sort((a, b) => a.name.localeCompare(b.name));
  return { worlds };
}

// ---------- compendium library (shared across worlds) ----------
// Imported 5etools packs live in DATA_DIR/.library/<packId>/{meta.json,pack.json}
// — outside worlds/ so world backups and snapshots stay lean; packs are
// re-importable from the user's own files, so they are not treasure.

const LIBRARY_DIR = () => path.join(DATA_DIR, '.library');

// whitelists mirror scripts/build-bestiary.js — payloads stay lean and legal
const PACK_KEEP = {
  monster: ['name', 'size', 'type', 'alignment', 'ac', 'hp', 'speed',
    'str', 'dex', 'con', 'int', 'wis', 'cha',
    'save', 'skill', 'senses', 'passive', 'languages', 'cr',
    'vulnerable', 'resist', 'immune', 'conditionImmune',
    'trait', 'action', 'bonus', 'reaction', 'legendary', 'spellcasting', 'source'],
  spell: ['name', 'level', 'school', 'time', 'range', 'components', 'duration',
    'entries', 'entriesHigherLevel', 'meta', 'classes', 'source'],
  item: ['name', 'type', 'rarity', 'value', 'weight', 'reqAttune', 'wondrous',
    'entries', 'dmg1', 'dmg2', 'dmgType', 'property', 'ac', 'source', 'mastery', 'weaponCategory'],
  // proficiency/startingProficiencies/startingEquipment/casterProgression feed
  // the character creator (1.2) — packs downloaded before then lack them and
  // simply need re-downloading to become creator-usable
  class: ['name', 'source', 'hd', 'classFeatures', 'subclasses', 'spellcastingAbility',
    'proficiency', 'startingProficiencies', 'startingEquipment', 'casterProgression',
    'cantripProgression', 'primaryAbility', 'preparedSpellsProgression', 'spellsKnownProgression', 'classTableGroups'],
  classFeature: ['name', 'source', 'className', 'classSource', 'level', 'entries'],
  subclass: ['name', 'shortName', 'source', 'className', 'classSource', 'subclassFeatures', 'additionalSpells'],
  subclassFeature: ['name', 'source', 'className', 'classSource', 'subclassShortName', 'subclassSource', 'level', 'entries'],
  race: ['name', 'source', 'size', 'speed', 'darkvision', 'entries', 'ability'],
  background: ['name', 'source', 'ability', 'skillProficiencies', 'toolProficiencies', 'feats', 'entries'],
  feat: ['name', 'source', 'category', 'prerequisite', 'entries', 'ability', 'repeatable'],
};

function listLibrary() {
  const dir = LIBRARY_DIR();
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, d.name, 'meta.json'), 'utf8')));
    } catch { /* unreadable pack — skip */ }
  }
  return out;
}

// ---------- official sheet PDFs ("Use my own official sheet") ----------
// The GM's own copies of publishers' fillable character sheets, kept beside
// library packs and outside worlds/ (backups and snapshots never carry them;
// the GM can download them again). The PDF is stored as uploaded and only ever
// sent back to this app as a download, never rendered by the server.
const SHEET_TEMPLATES_DIR = () => path.join(DATA_DIR, '.sheet-templates');
const SHEET_SYSTEM_IDS = new Set(['dnd2024', 'vtm5', 'coc7']);
const MAX_SHEET_TEMPLATE_BYTES = 25 * 1024 * 1024;

function listSheetTemplates() {
  const dir = SHEET_TEMPLATES_DIR();
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory() || !SAFE_ID.test(d.name)) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(dir, d.name, 'meta.json'), 'utf8'))); } catch { /* unreadable: skip */ }
  }
  return out.sort((a, b) => String(a.added).localeCompare(String(b.added)));
}

function sheetTemplateChoices(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [field, key] of Object.entries(value).slice(0, 5000)) {
    if (typeof field !== 'string' || field.length > 300 || typeof key !== 'string' || key.length > 200) continue;
    if (field === '__proto__' || field === 'constructor' || field === 'prototype') continue;
    out[field] = key;
  }
  return out;
}

/** `downloaded` ({ bytes, source }) is set only by the publisher download route. */
function storeSheetTemplate(body, downloaded = null) {
  const fail = (message) => Object.assign(new Error(message), { status: 400 });
  if (!SHEET_SYSTEM_IDS.has(body?.system)) throw fail('unknown game system');
  const bytes = downloaded ? downloaded.bytes : Buffer.from(String(body.dataBase64 || ''), 'base64');
  if (!bytes.length || bytes.length > MAX_SHEET_TEMPLATE_BYTES) throw fail('the sheet must be a PDF of at most 25 MB');
  if (!bytes.subarray(0, 1024).toString('latin1').includes('%PDF-')) throw fail('that file is not a PDF');
  const label = String(body.label || body.fileName || 'Character sheet').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 120) || 'Character sheet';
  const fileName = String(body.fileName || 'sheet.pdf').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120);
  const base = `${body.system}-${slugify(label)}`.slice(0, 100);
  let id = base;
  for (let i = 2; fs.existsSync(path.join(SHEET_TEMPLATES_DIR(), id)); i++) id = `${base}-${i}`;
  const dir = path.join(SHEET_TEMPLATES_DIR(), id);
  fs.mkdirSync(dir, { recursive: true });
  const meta = { mundusmakerSheetTemplate: 1, id, system: body.system, label, fileName, size: bytes.length, added: new Date().toISOString(), choices: sheetTemplateChoices(body.choices) };
  if (downloaded) meta.source = downloaded.source; // which publisher sheet, so the dialog stops offering it
  atomicWrite(path.join(dir, 'sheet.pdf'), bytes);
  atomicWrite(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  return meta;
}

function storeLibraryPack(name, data) {
  const trimmed = {};
  const counts = {};
  for (const [kind, keep] of Object.entries(PACK_KEEP)) {
    const arr = Array.isArray(data?.[kind]) ? data[kind] : [];
    const rows = arr.filter((x) => x?.name && !x._copy).map((x) => {
      const out = {};
      for (const k of keep) if (x[k] !== undefined) out[k] = x[k];
      return out;
    });
    if (rows.length) { trimmed[kind] = rows; counts[kind] = rows.length; }
  }
  if (!Object.keys(trimmed).length) {
    const err = new Error('no monsters, spells, items, classes, or class features found');
    err.status = 400;
    throw err;
  }
  const wanted = String(name || 'pack');
  const base = slugify(wanted);
  let id = base;
  let i = 2;
  while (fs.existsSync(path.join(LIBRARY_DIR(), id))) id = `${base}-${i++}`;
  const download = data?._download?.provider === '5etools' ? {
    provider: '5etools', repo: String(data._download.repo || ''), ref: String(data._download.ref || ''),
    categories: Array.isArray(data._download.categories) ? data._download.categories.map(String) : [],
    sources: Array.isArray(data._download.sources) ? data._download.sources.map(String) : [],
    fetched: String(data._download.fetched || ''), files: Number(data._download.files) || undefined,
    bytes: Number(data._download.bytes) || undefined,
  } : undefined;
  const meta = {
    mundusmakerPack: 1, id, name: wanted.slice(0, 80),
    kinds: Object.keys(trimmed), counts, imported: new Date().toISOString(),
    ...(download ? { download } : {}),
  };
  const dir = path.join(LIBRARY_DIR(), id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({ ...meta, ...trimmed }));
  return meta;
}

// ---------- migration from older installs ----------
// Strictly read-only detection. The migrate route COPIES worlds in and never
// writes to, moves, or deletes anything at the source.

/**
 * Given an install root OR a data dir, find that install's data the way it
 * would itself: its own config file (any rename-era name), else its ./data.
 * Returns { path, dataDir, layout: 'v1'|'v2', worlds: [{id,name,entities}] } or null.
 */
function detectInstallData(candidatePath) {
  // shared with the first-start upgrade (scripts/upgrade.js); strictly read-only
  return upgrade.detectInstallData(candidatePath, { liveDataDir: DATA_DIR, configNames: CONFIG_NAMES });
}

/** What scripts/upgrade.js needs to know about this server. */
function upgradeCtx() {
  return { root: ROOT, dataDir: DATA_DIR, configNames: CONFIG_NAMES, version: VERSION, port: PORT, samePath, uniqueWorldId, copyDirSync };
}

// ---------- API ----------

async function handleApi(req, res, pathname) {
  const method = req.method;

  // --- status & data-folder config (for the Sync card) ---
  if (pathname === '/api/status' && method === 'GET') {
    return sendJson(res, 200, {
      app: 'mundusmaker',
      version: VERSION,
      platform: process.platform,
      deployment: CONTAINER ? 'container' : MOBILE ? 'mobile' : 'desktop',
      dataDir: DATA_DIR,
      configPath: CONFIG_PATH,
      // report the file that actually won, not the one we'd prefer — otherwise
      // the Sync card claims 'default' while a legacy config is in force
      configuredVia: dataDirArg ? 'command line' : DATA_DIR_ENV ? 'environment variable'
        : config.dataDir ? path.basename(configPathUsed) : 'default',
      // whether Check for updates has a release feed to ask (scripts/updates.js)
      updates: { configured: !!updates.feedFor(PKG) },
      // the app's files changed since this process started (see loadedCode);
      // on a phone they change only with an app update, which restarts the app
      restartNeeded: !MOBILE && codeChangedSinceStart(),
      // lets the tray tell its own server from another copy holding the port
      pid: process.pid,
      // minutes after the last tab closes before stopping; 0 = keep running
      autoStop: autoStopMinutes(),
    });
  }
  // Check for updates: only when the user presses the button, one GET to the
  // release feed named in package.json, nothing downloaded or installed.
  if (pathname === '/api/update-check' && method === 'POST') {
    const body = JSON.parse((await readBody(req, 4 * 1024)).toString('utf8') || '{}');
    if (body.confirm !== true) return sendJson(res, 400, { error: 'confirm must be true before MundusMaker asks the release feed' });
    if (updateCheckActive) return sendJson(res, 409, { error: 'an update check is already running' });
    updateCheckActive = true;
    try {
      return sendJson(res, 200, await updates.checkForUpdates({ pkg: PKG, current: VERSION }));
    } catch (err) {
      return sendJson(res, 502, { error: err.message });
    } finally {
      updateCheckActive = false;
    }
  }
  // Quit: Settings, the tray and the upgrade screen stop the server here, and
  // guardRequest keeps every other page out. In-flight saves finish first
  // (gracefulQuit). Docker owns a container.
  if (pathname === '/api/quit' && method === 'POST') {
    if (CONTAINER) return sendJson(res, 409, { error: 'Docker manages this server. Stop it with Docker instead.' });
    if (MOBILE) return sendJson(res, 409, { error: 'On this device MundusMaker closes like any other app.' });
    sendJson(res, 200, { ok: true, stopping: true });
    setImmediate(() => gracefulQuit('Quit was chosen'));
    return;
  }

  // The app's tabs check in here (see scheduleAutoStop); only they count.
  if (pathname === '/api/presence' && method === 'POST') {
    lastTabSeen = Date.now();
    return sendJson(res, 200, { ok: true, autoStop: autoStopMinutes() });
  }
  if (pathname === '/api/auto-stop' && method === 'POST') {
    if (CONTAINER) return sendJson(res, 409, { error: 'Docker manages this server. Stop it with Docker instead.' });
    if (MOBILE) return sendJson(res, 409, { error: 'On this device MundusMaker closes like any other app.' });
    const body = JSON.parse((await readBody(req, 4 * 1024)).toString('utf8') || '{}');
    const minutes = Number(body.minutes);
    if (!AUTO_STOP_CHOICES.includes(minutes)) return sendJson(res, 400, { error: `minutes must be one of ${AUTO_STOP_CHOICES.join(', ')}` });
    const next = { ...config };
    if (minutes) next.autoStop = { minutes }; else delete next.autoStop;
    atomicWrite(CONFIG_PATH, JSON.stringify(next, null, 2));
    config = next;
    lastTabSeen = Date.now();
    return sendJson(res, 200, { ok: true, autoStop: autoStopMinutes() });
  }

  if (pathname === '/api/config' && method === 'POST') {
    if (CONTAINER) return sendJson(res, 409, { error: 'Container storage is managed by the /data volume. Change its mount in Docker, not a browser folder path.' });
    if (MOBILE) return sendJson(res, 409, { error: 'The app keeps its worlds inside itself on this device. Move a world with a backup instead.' });
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
    atomicWrite(CONFIG_PATH, JSON.stringify({ ...config, dataDir: target }, null, 2));
    return sendJson(res, 200, { ok: true, copied, restartRequired: true, dataDir: target });
  }

  // --- second-folder backups (1.9, desktop only) ---
  if (pathname.startsWith('/api/folder-backup')) {
    const why = folderBackupUnavailable();
    const settings = config.secondBackup || {};
    if (pathname === '/api/folder-backup' && method === 'GET') {
      return sendJson(res, 200, { available: !why, reason: why, settings: { dir: settings.dir || '', everyHours: settings.everyHours || 24, keep: settings.keep || 7, last: settings.last || null },
        lastError: folderBackupError, backups: settings.dir ? folderBackup.listBackups(settings.dir, settings.installId) : [] });
    }
    if (why) return sendJson(res, 409, { error: why });
    if (pathname === '/api/folder-backup' && method === 'POST') {
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8'));
      const dir = String(body.dir || '').trim();
      if (!dir) { saveBackupSettings(null); return sendJson(res, 200, { ok: true, enabled: false }); }
      const problem = folderBackup.checkTarget(dir, DATA_DIR);
      if (problem) return sendJson(res, 400, { error: problem });
      saveBackupSettings({ ...settings, dir: path.resolve(dir), everyHours: folderBackup.EVERY.includes(Number(body.everyHours)) ? Number(body.everyHours) : 24,
        keep: Math.max(1, Math.min(60, Math.trunc(Number(body.keep) || 7))), installId: settings.installId || randomUUID() });
      return sendJson(res, 200, { ok: true, enabled: true });
    }
    if (pathname === '/api/folder-backup/run' && method === 'POST') {
      if (!settings.dir) return sendJson(res, 400, { error: 'Choose a backup folder first.' });
      return sendJson(res, 200, { ok: true, ...runFolderBackup() });
    }
    if (pathname === '/api/folder-backup/restore' && method === 'POST') {
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8'));
      const src = settings.dir ? folderBackup.backupWorldDir(settings.dir, String(body.name || ''), String(body.worldId || '')) : null;
      if (!src) return sendJson(res, 404, { error: 'That backup is not available.' });
      // copy-only, like every restore: the backup folder is never changed
      return sendJson(res, 200, { ok: true, restored: restoreWorldCopy(src, String(body.worldId), String(body.worldId)) });
    }
  }

  // --- recovery browser (trash + the last seven snapshots per world) ---
  if (pathname === '/api/recovery' && method === 'GET') {
    return sendJson(res, 200, listRecovery());
  }
  if (pathname === '/api/recovery/restore' && method === 'POST') {
    const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8'));
    return sendJson(res, 200, restoreRecovery(body));
  }

  // --- read-only map link check across all live worlds ---
  if (pathname === '/api/integrity/links' && method === 'GET') {
    return sendJson(res, 200, listLinkIntegrity());
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
  if (pathname === '/api/worlds/sample' && method === 'POST') {
    if (!fs.existsSync(path.join(SAMPLE_DIR, 'world.json'))) return sendJson(res, 404, { error: 'this copy of MundusMaker has no sample world' });
    return sendJson(res, 200, { ok: true, id: addSampleWorld() });
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

  // --- compendium library ---
  if (pathname === '/api/library' && method === 'GET') {
    return sendJson(res, 200, listLibrary());
  }
  if (pathname === '/api/library' && method === 'POST') {
    const body = JSON.parse((await readBody(req, 50 * 1024 * 1024)).toString('utf8'));
    return sendJson(res, 200, storeLibraryPack(body.name, body.data || {}));
  }
  if (pathname === '/api/library/download-5etools' && method === 'POST') {
    const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8'));
    if (body.confirmUse !== true) {
      return sendJson(res, 400, { error: 'confirmUse must be true before MundusMaker downloads third-party material' });
    }
    if (libraryDownloadActive) {
      return sendJson(res, 409, { error: 'a 5etools download is already running' });
    }
    libraryDownloadActive = true;
    try {
      const data = await download5etools({
        categories: body.categories,
        sources: body.sources,
        ref: body.ref || 'main',
      });
      return sendJson(res, 200, storeLibraryPack(body.name || '5etools library', data));
    } finally {
      libraryDownloadActive = false;
    }
  }
  const libMatch = pathname.match(/^\/api\/library\/([^/]+)$/);
  if (libMatch) {
    const id = decodeURIComponent(libMatch[1]);
    if (!SAFE_ID.test(id)) return sendJson(res, 400, { error: 'invalid pack id' });
    const dir = path.join(LIBRARY_DIR(), id);
    if (!fs.existsSync(path.join(dir, 'pack.json'))) return sendJson(res, 404, { error: 'pack not found' });
    if (method === 'GET') {
      return sendJson(res, 200, JSON.parse(fs.readFileSync(path.join(dir, 'pack.json'), 'utf8')));
    }
    if (method === 'DELETE') {
      const trash = path.join(DATA_DIR, '.trash');
      fs.mkdirSync(trash, { recursive: true });
      fs.renameSync(dir, path.join(trash, `pack-${id}-${Date.now()}`));
      return sendJson(res, 200, { ok: true, note: 'moved to data/.trash' });
    }
  }

  // --- official sheet PDFs ---
  if (pathname === '/api/sheet-templates' && method === 'GET') return sendJson(res, 200, listSheetTemplates());
  if (pathname === '/api/sheet-templates' && method === 'POST') {
    const body = JSON.parse((await readBody(req, Math.ceil(MAX_SHEET_TEMPLATE_BYTES * 1.4) + 64 * 1024)).toString('utf8'));
    return sendJson(res, 200, storeSheetTemplate(body));
  }
  // The third button-started outbound request: one publisher's free sheet,
  // from scripts/sheetdownload.js's fixed table, into .sheet-templates.
  if (pathname === '/api/sheet-templates/sources' && method === 'GET') return sendJson(res, 200, sheetDownload.listSources());
  if (pathname === '/api/sheet-templates/download' && method === 'POST') {
    const body = JSON.parse((await readBody(req, 4 * 1024)).toString('utf8') || '{}');
    if (body.confirm !== true) return sendJson(res, 400, { error: 'confirm must be true before MundusMaker contacts the publisher' });
    if (sheetDownloadActive) return sendJson(res, 409, { error: 'a sheet is already downloading' });
    sheetDownloadActive = true;
    try {
      const got = await sheetDownload.downloadSheet(String(body.id || ''), { version: VERSION });
      const meta = storeSheetTemplate({ system: got.source.system, fileName: got.fileName, label: got.source.label }, { bytes: got.bytes, source: got.source.id });
      console.log(`[mundusmaker] downloaded ${got.source.label} from ${new URL(got.source.url).host}`);
      return sendJson(res, 200, meta);
    } catch (err) {
      return sendJson(res, err.status || 500, { error: err.message });
    } finally {
      sheetDownloadActive = false;
    }
  }
  const tplMatch = pathname.match(/^\/api\/sheet-templates\/([^/]+)(\/pdf)?$/);
  if (tplMatch) {
    const id = decodeURIComponent(tplMatch[1]);
    if (!SAFE_ID.test(id)) return sendJson(res, 400, { error: 'invalid sheet id' });
    const dir = path.join(SHEET_TEMPLATES_DIR(), id);
    if (!fs.existsSync(path.join(dir, 'meta.json'))) return sendJson(res, 404, { error: 'sheet not found' });
    if (tplMatch[2] && method === 'GET') {
      const bytes = fs.readFileSync(path.join(dir, 'sheet.pdf'));
      res.writeHead(200, {
        'Content-Type': 'application/pdf', 'Content-Length': bytes.length, 'Cache-Control': 'no-store',
        'Content-Disposition': 'attachment; filename="sheet.pdf"', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox',
      });
      return res.end(bytes);
    }
    if (!tplMatch[2] && method === 'PUT') {
      const body = JSON.parse((await readBody(req, 2 * 1024 * 1024)).toString('utf8'));
      const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
      if (typeof body.label === 'string' && body.label.trim()) meta.label = body.label.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 120);
      if (body.choices !== undefined) meta.choices = sheetTemplateChoices(body.choices);
      meta.updated = new Date().toISOString();
      atomicWrite(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
      return sendJson(res, 200, meta);
    }
    if (!tplMatch[2] && method === 'DELETE') {
      const trash = path.join(DATA_DIR, '.trash');
      fs.mkdirSync(trash, { recursive: true });
      fs.renameSync(dir, path.join(trash, `sheet-${id}-${Date.now()}`));
      return sendJson(res, 200, { ok: true, note: 'moved to data/.trash' });
    }
  }

  // --- migration from older installs (Loreweave / TomeWeaver / MundusMaker) ---
  if (MOBILE && ['/api/scan-installs', '/api/scan-path', '/api/migrate-install'].includes(pathname)) {
    return sendJson(res, 409, { error: 'There are no older installs beside the app on this device. Bring worlds over with a backup instead.' });
  }
  if (pathname === '/api/scan-installs' && method === 'GET') {
    return sendJson(res, 200, upgrade.scanSiblings({ root: ROOT, liveDataDir: DATA_DIR, configNames: CONFIG_NAMES }));
  }
  if (pathname === '/api/scan-path' && method === 'POST') {
    const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8'));
    const found = detectInstallData(body.path);
    return sendJson(res, 200, found ? [found] : []);
  }
  if (pathname === '/api/migrate-install' && method === 'POST') {
    const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8'));
    // re-verify on the server — never trust a listing the client assembled
    const found = detectInstallData(body.dataDir);
    if (!found) return sendJson(res, 400, { error: 'no MundusMaker/Loreweave data found at that path' });
    // the GM picked these worlds by hand, so even an untouched sample is copied;
    // the ledger still skips a world already copied unchanged
    const result = upgrade.copyWorlds({ ...upgradeCtx(), install: found, worldIds: body.worldIds, skipSample: false });
    return sendJson(res, 200, { migrated: result.copied, skipped: result.skipped });
  }

  // --- first-start upgrade from an older install beside this one ---
  if (pathname === '/api/upgrade' && method === 'GET') {
    if (CONTAINER || MOBILE) return sendJson(res, 200, { notice: null, choice: null });
    return sendJson(res, 200, await upgrade.upgradeStatus(upgradeCtx()));
  }
  if (pathname === '/api/upgrade/copy' && method === 'POST') {
    if (CONTAINER) return sendJson(res, 409, { error: 'Docker manages this server’s data volume.' });
    if (MOBILE) return sendJson(res, 409, { error: 'There are no older installs beside the app on this device.' });
    const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8'));
    const install = detectInstallData(body.path);
    if (!install) return sendJson(res, 400, { error: 'That MundusMaker folder no longer has worlds to copy.' });
    const result = upgrade.copyWorlds({ ...upgradeCtx(), install, worldIds: body.worldIds, packs: !!body.packs });
    upgrade.resolveChoice(upgradeCtx(), `copied ${result.copied.length} world(s) from ${install.path}`);
    return sendJson(res, 200, result);
  }
  if (pathname === '/api/upgrade/dismiss' && method === 'POST') {
    const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8'));
    if (!upgrade.dismiss(upgradeCtx(), body.what)) return sendJson(res, 400, { error: 'unknown notice' });
    return sendJson(res, 200, { ok: true });
  }
  if (pathname === '/api/upgrade/quit-old' && method === 'POST') {
    if (MOBILE) return sendJson(res, 409, { error: 'There are no older installs beside the app on this device.' });
    // only a 1.9+ copy has a Quit route; older ones are quit by the GM
    const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8'));
    const candidate = (await upgrade.candidatesFor(upgradeCtx())).find((c) => samePath(c.path, String(body.path || '')));
    if (!candidate?.running?.canQuit) return sendJson(res, 409, { error: 'Quit that copy yourself: close its window, or use Quit in its tray or menu-bar icon.' });
    const ok = await upgrade.requestQuit(candidate.running.port);
    return sendJson(res, ok ? 200 : 502, ok ? { ok: true } : { error: 'That copy did not answer. Quit it yourself, then check again.' });
  }

  // --- world-scoped routes: /api/w/<wid>/... ---
  const scoped = pathname.match(/^\/api\/w\/([^/]+)(\/.*)$/);
  if (!scoped) return sendJson(res, 404, { error: 'unknown api route' });
  const wid = decodeURIComponent(scoped[1]);
  const route = scoped[2];
  const dir = worldDir(wid);

  if (route === '/world') {
    const worldPath = path.join(dir, 'world.json');
    if (method === 'GET') {
      const stored = readVersion(worldPath);
      const world = JSON.parse(stored.bytes.toString('utf8'));
      validateWorld(world);
      res.setHeader('ETag', stored.revision);
      return sendJson(res, 200, world);
    }
    if (method === 'PUT') {
      const body = JSON.parse((await readBody(req, 2 * 1024 * 1024)).toString('utf8'));
      validateWorld(body);
      if (!checkRevision(req, worldPath, body).identical) atomicWrite(worldPath, JSON.stringify(body, null, 2));
      return sendVersion(res, worldPath, { ok: true });
    }
  }

  if (route === '/entities' && method === 'GET') {
    const result = readEntities(dir);
    return sendJson(res, 200, new URL(req.url, 'http://localhost').searchParams.has('details') ? result : result.entities);
  }

  const entityMatch = route.match(/^\/entities\/([^/]+)$/);
  if (entityMatch) {
    const id = decodeURIComponent(entityMatch[1]);
    if (!SAFE_ID.test(id)) return sendJson(res, 400, { error: 'invalid id' });
    const file = path.join(dir, 'entities', id + '.json');
    if (method === 'GET') {
      if (!fs.existsSync(file)) return sendJson(res, 404, { error: 'not found' });
      const stored = readVersion(file);
      res.setHeader('ETag', stored.revision);
      return sendJson(res, 200, JSON.parse(stored.bytes.toString('utf8')));
    }
    if (method === 'PUT') {
      const body = JSON.parse((await readBody(req, 8 * 1024 * 1024)).toString('utf8'));
      validateEntity(body, id);
      const current = checkRevision(req, file, body);
      if (current.identical) return sendVersion(res, file, { ok: true, entity: JSON.parse(current.bytes.toString('utf8')) });
      body.updated = new Date().toISOString();
      writeHistory(dir, id); // if the safety copy fails, keep the current file
      atomicWrite(file, JSON.stringify(body, null, 2));
      return sendVersion(res, file, { ok: true, entity: body });
    }
    if (method === 'DELETE') {
      checkRevision(req, file);
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
      validateEntity(body, id);
      checkRevision(req, path.join(dir, 'entities', id + '.json'));
      writeHistory(dir, id, true); // the state being replaced must survive, always
      body.updated = new Date().toISOString();
      atomicWrite(path.join(dir, 'entities', id + '.json'), JSON.stringify(body, null, 2));
      return sendVersion(res, path.join(dir, 'entities', id + '.json'), { ok: true, entity: body });
    }
  }

  // image assets (portraits etc.) live inside the world folder → sync/backup just work
  if (route === '/assets' && method === 'POST') {
    const body = JSON.parse((await readBody(req, 20 * 1024 * 1024)).toString('utf8'));
    const safe = String(body.name || 'image.png').replace(/[^\w.\-]+/g, '_').slice(-80)
      .replace(/\.{2,}/g, '.').replace(/^\.+/, ''); // serveAsset refuses '..' names
    if (!RASTER_TYPES[path.extname(safe).toLowerCase()]) {
      return sendJson(res, 415, { error: 'Only PNG, JPEG, WebP and GIF images can be uploaded.' });
    }
    const bytes = Buffer.from(String(body.dataBase64 || ''), 'base64');
    if (!isRasterImage(bytes)) return sendJson(res, 415, { error: 'That file is not a PNG, JPEG, WebP or GIF image.' });
    const assetsDir = path.join(dir, 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    let name = safe;
    if (fs.existsSync(path.join(assetsDir, name))) name = `${Date.now().toString(36)}-${safe}`;
    fs.writeFileSync(path.join(assetsDir, name), bytes);
    return sendJson(res, 200, { ok: true, file: name });
  }

  // sync-conflict compare (1.9): show a recognized copy beside the current
  // entry; adopting it snapshots the world first, refuses if the entry
  // changed since it was compared, and moves the copy to the trash. Keeping
  // the current entry moves the copy to the trash too. Everything stays
  // recoverable: the snapshot, the entry's history and the trash.
  const copyMatch = route.match(/^\/sync-copies\/([^/]+)$/);
  if (copyMatch) {
    let name;
    try { name = decodeURIComponent(copyMatch[1]); } catch { return sendJson(res, 400, { error: 'invalid file name' }); }
    if (!name.endsWith('.json') || /[\\/]/.test(name) || name.includes('..')) return sendJson(res, 400, { error: 'invalid file name' });
    const copyFile = path.join(dir, 'entities', name);
    let copyEntity = null;
    try { copyEntity = JSON.parse(fs.readFileSync(copyFile, 'utf8')); } catch { return sendJson(res, 404, { error: 'That copy is no longer there.' }); }
    const copy = syncCopyOf(name, copyEntity);
    if (!copy) return sendJson(res, 404, { error: 'That file is not a sync conflict copy.' });
    const mainFile = path.join(dir, 'entities', `${copy.id}.json`);
    const current = fs.existsSync(mainFile) ? readVersion(mainFile) : null;
    if (method === 'GET') {
      return sendJson(res, 200, { copy: copyEntity, current: current ? JSON.parse(current.bytes.toString('utf8')) : null, revision: current?.revision || null });
    }
    if (method === 'POST') {
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8'));
      if ((current?.revision || null) !== (body.revision || null)) return sendJson(res, 409, { error: 'The entry changed after you compared it. Compare again.' });
      const trash = path.join(DATA_DIR, '.trash');
      fs.mkdirSync(trash, { recursive: true });
      if (body.action === 'adopt') {
        const adopted = { ...copyEntity, id: copy.id, updated: new Date().toISOString() };
        validateEntity(adopted, copy.id);
        snapshotWorld(wid, 'pre-adopt');
        if (current) writeHistory(dir, copy.id);
        atomicWrite(mainFile, JSON.stringify(adopted, null, 2));
      } else if (body.action !== 'discard') return sendJson(res, 400, { error: 'unknown action' });
      fs.renameSync(copyFile, path.join(trash, `${wid}--${copy.id}--${Date.now()}.json`));
      return sendJson(res, 200, { ok: true, action: body.action });
    }
  }

  if (route === '/export-file' && method === 'POST') {
    const body = JSON.parse((await readBody(req, 100 * 1024 * 1024)).toString('utf8'));
    const name = String(body.name || 'export.pdf').replace(/[^\w.\- ]+/g, '_').replace(/^[. ]+|[. ]+$/g, '');
    if (!EXPORT_TYPES.has(path.extname(name).toLowerCase())) {
      return sendJson(res, 415, { error: 'Exports are saved only as PDF, PNG, ZIP or Universal VTT files.' });
    }
    const target = path.join(dir, 'exports', name);
    fs.writeFileSync(target, Buffer.from(String(body.dataBase64 || ''), 'base64'));
    return sendJson(res, 200, { ok: true, path: target });
  }

  if (route === '/backup' && method === 'GET') {
    const world = JSON.parse(fs.readFileSync(path.join(dir, 'world.json'), 'utf8'));
    const entries = readEntities(dir);
    if (entries.issues.length) {
      // a backup must never silently miss edits, and a sync copy may hold some
      const copiesOnly = entries.issues.every((issue) => issue.kind === 'sync-copy');
      return sendJson(res, 409, { error: copiesOnly
        ? 'This world has sync conflict copies (listed in the warning at the top of the page). A backup could miss the edits they hold, so resolve them first: keep what you need from each copy, then move the copy out of the entities folder.'
        : 'Some entry files could not be read. Copy the whole data folder to preserve them; resolve the file warnings before exporting a JSON backup.' });
    }
    // Both format markers are emitted: `loreweave` keeps new backups restorable
    // into the older builds already in other GMs' hands, `mundusmaker` is what we
    // read going forward. Restore accepts either.
    const payload = { mundusmaker: 1, loreweave: 1, worldId: wid, exported: new Date().toISOString(), world, entities: entries.entities };
    // ?assets=1 embeds portraits/uploads (base64) — off by default, backups stay small
    if (new URL(req.url, 'http://localhost').searchParams.get('assets') === '1') {
      payload.assets = [];
      const assetsDir = path.join(dir, 'assets');
      if (fs.existsSync(assetsDir)) {
        for (const f of fs.readdirSync(assetsDir)) {
          const fp = path.join(assetsDir, f);
          if (fs.statSync(fp).isFile()) payload.assets.push({ name: f, dataBase64: fs.readFileSync(fp).toString('base64') });
        }
      }
    }
    return sendJson(res, 200, payload);
  }

  if (route === '/restore' && method === 'POST') {
    const body = JSON.parse((await readBody(req, 200 * 1024 * 1024)).toString('utf8'));
    if (body.worldId && SAFE_ID.test(body.worldId) && body.worldId !== wid) rewriteAssetRefs(body, body.worldId, wid);
    return sendJson(res, 200, restoreBackup(DATA_DIR, wid, body, () => snapshotWorld(wid, 'pre-restore')));
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
    // Files reach assets/ by other paths than the upload route (older versions,
    // backups, sync, a hand copy), so no asset may ever run as a page on this
    // origin: the sandbox gives one opened directly no script and no access.
    // Raster images display as usual, an older SVG still shows in <img> but
    // loads nothing when opened, and anything else is only offered as a download.
    const ext = path.extname(file).toLowerCase();
    const headers = { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox' };
    if (RASTER_TYPES[ext]) headers['Content-Type'] = RASTER_TYPES[ext];
    else if (ext === '.svg') {
      headers['Content-Type'] = 'image/svg+xml';
      headers['Content-Security-Policy'] = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:";
    } else {
      headers['Content-Type'] = 'application/octet-stream';
      headers['Content-Disposition'] = 'attachment';
    }
    res.writeHead(200, headers);
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
    // No other page may frame the app: its own requests from inside a frame are
    // same-origin, so the request guard alone can't stop a page from overlaying
    // it and borrowing the GM's clicks. Nothing in the app frames itself.
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'",
    });
    res.end(buf);
  });
}

// ---------- server ----------

// bootstrap() runs once the port is ours (see server.listen below): a copy that
// finds another server on its port must not seed, snapshot or recover
// transactions in a data folder that server may be using.
//
// Requests wait for that startup work (bootstrap and a first-start upgrade
// copy) to finish, so the first page never sees a half-prepared data folder.
let markReady;
const ready = new Promise((resolve) => { markReady = resolve; });
let quitting = false;
let inFlight = 0; // requests still being handled; Quit waits for them

const server = http.createServer(async (req, res) => {
  inFlight++;
  res.on('close', () => { inFlight--; });
  await ready;
  let pathname = (req.url || '/').split('?')[0];
  try {
    // any page can send a malformed %-escape (an <img> will do): answer it, never crash
    try { pathname = decodeURI(pathname); } catch { throw Object.assign(new Error('That address is not valid.'), { status: 400 }); }
    guardRequest(req, pathname);
    if (quitting && pathname.startsWith('/api/')) {
      return sendJson(res, 503, { error: 'MundusMaker is stopping. Start it again to keep working.' });
    }
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

// ---------- stop after the last tab closes (opt-in) ----------
// Every app tab says it is open once a minute (POST /api/presence). With
// config.autoStop.minutes set, the server stops once no tab has called for that
// long. Closed tabs and ones the browser froze or discarded both fall silent,
// which is why this is an option and not the default. The clock starts at
// launch, so a browser that never opened stops it too.
const AUTO_STOP_CHOICES = [0, 5, 15, 60];
let lastTabSeen = Date.now();
function autoStopMinutes() {
  const minutes = Number(config.autoStop?.minutes);
  return !CONTAINER && Number.isFinite(minutes) && minutes > 0 && minutes <= 1440 ? minutes : 0;
}
function scheduleAutoStop(delay = 30000) {
  const due = Date.now() + delay;
  setTimeout(() => {
    const now = Date.now(), minutes = autoStopMinutes();
    // fired far too late: the computer slept, tabs included, so give them a fresh start
    if (now - due > 60000) lastTabSeen = now;
    const left = minutes * 60000 - (now - lastTabSeen);
    if (minutes && left <= 0) return gracefulQuit(`no MundusMaker tab was open for ${minutes} minute${minutes === 1 ? '' : 's'}; change this in Settings, Running MundusMaker`);
    scheduleAutoStop(minutes ? Math.max(250, Math.min(30000, left)) : 30000);
  }, delay).unref();
}

/**
 * Stop cleanly: accept no new work, let requests already running (saves)
 * finish, then exit. Used by Quit, the tray, and termination signals.
 */
function gracefulQuit(reason) {
  if (quitting) return;
  quitting = true;
  console.log(`[mundusmaker] stopping (${reason}); saves in progress finish first.`);
  server.close(() => { console.log('[mundusmaker] stopped.'); process.exit(0); });
  // browsers keep idle connections open; close them once no request is running
  const drain = setInterval(() => {
    if (inFlight > 0) return;
    clearInterval(drain);
    server.closeAllConnections?.();
  }, 50);
  setTimeout(() => { console.log('[mundusmaker] stopped (a request was still running).'); process.exit(0); }, 8000).unref();
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, () => { /* best effort */ });
}

// Exit codes when the port is taken, for launchers that start this server
// without a visible console: 0 = this same MundusMaker (same data folder and
// version) is already running and was opened; 3 = a different or older
// MundusMaker holds the port; 4 = another program holds it.
const EXIT_OTHER_MUNDUSMAKER = 3;
const EXIT_PORT_TAKEN = 4;

/** Ask whatever holds the port whether it is MundusMaker, and which one. */
function identifyPortHolder(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/status', timeout: 2000, headers: { Host: `localhost:${port}` } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; if (body.length > 65536) req.destroy(); });
      res.on('end', () => {
        try {
          const status = JSON.parse(body);
          // every MundusMaker since the Sync card reports its data folder
          if (status && typeof status.dataDir === 'string') return resolve({ app: true, version: status.version || null, dataDir: status.dataDir });
        } catch { /* not JSON: some other program */ }
        resolve({ app: false });
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ app: false }));
  });
}

const samePath = (a, b) => {
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'linux' ? norm(a) === norm(b) : norm(a).toLowerCase() === norm(b).toLowerCase();
};

server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') throw err;
  if (CONTAINER) {
    console.error(`[mundusmaker] port ${PORT} is already in use.`);
    process.exit(EXIT_PORT_TAKEN);
  }
  identifyPortHolder(PORT).then((holder) => {
    const url = `http://localhost:${PORT}`;
    if (holder.app && holder.version === VERSION && samePath(holder.dataDir, DATA_DIR)) {
      console.log(`[mundusmaker] MundusMaker is already running on port ${PORT} with this data folder.`);
      console.log(`[mundusmaker] opening ${url} in your browser.`);
      if (!NO_OPEN) openBrowser(url);
      process.exit(0);
    }
    if (holder.app) {
      const other = holder.version ? `MundusMaker ${holder.version}` : 'an older MundusMaker';
      console.error(`[mundusmaker] Port ${PORT} is being used by ${other}, with the data folder ${holder.dataDir}.`);
      console.error(`[mundusmaker] This copy (MundusMaker ${VERSION}, data folder ${DATA_DIR}) did not start.`);
      console.error('[mundusmaker] Quit the other copy first (close its window, or use Quit in its tray or menu-bar icon), then start this one again.');
      process.exit(EXIT_OTHER_MUNDUSMAKER);
    }
    console.error(`[mundusmaker] Port ${PORT} is being used by another program, so MundusMaker could not start.`);
    console.error('[mundusmaker] Close that program, or give MundusMaker a different port (for example: node server.js 4871).');
    process.exit(EXIT_PORT_TAKEN);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  // Only a data folder the app chose itself (default or config file) is filled
  // from an older install. One named on the command line or in the environment
  // is a deliberate choice, and is how tests and scratch previews run.
  const scanOlder = !dataDirArg && !DATA_DIR_ENV && !CONTAINER;
  const { fresh } = bootstrap({ scanFirst: scanOlder });
  if (!folderBackupUnavailable()) {
    // scheduled second-folder backups: checked shortly after start, then every 15 minutes
    const tick = () => { if (folderBackup.isDue(config.secondBackup)) { try { const r = runFolderBackup(); console.log(`[mundusmaker] backed up ${r.worlds} world(s) to ${config.secondBackup.dir}`); } catch (err) { console.error(`[mundusmaker] second-folder backup failed: ${err.message}`); } } };
    setTimeout(tick, 60 * 1000).unref();
    setInterval(tick, 15 * 60 * 1000).unref();
  }
  const firstStart = fresh && scanOlder
    ? upgrade.firstStart(upgradeCtx()).then((result) => {
      if (result.result === 'copied') console.log(`[mundusmaker] brought over ${result.copied.length} world(s) from ${result.from}; that folder was not changed.`);
      else if (result.result === 'choice') console.log('[mundusmaker] older MundusMaker folders found; the app will ask what to bring over.');
    }).catch((err) => console.error(`[mundusmaker] could not check for older installs: ${err.message}`))
    : Promise.resolve();
  firstStart.then(() => {
    addFirstWorld();
    markReady();
    if (!CONTAINER) { lastTabSeen = Date.now(); scheduleAutoStop(autoStopMinutes() ? 250 : 30000); }
    const url = `http://localhost:${PORT}`;
    console.log(`[mundusmaker] serving on ${url}`);
    console.log(`[mundusmaker] worlds stored in ${WORLDS_DIR}`);
    console.log(CONTAINER ? '[mundusmaker] internal server ready; use Docker to stop this instance.'
      : MOBILE ? '[mundusmaker] running inside the app.'
      : LOG_FILE ? '[mundusmaker] running in the background. Quit it with Quit at the top right of the app, or from the MundusMaker tray or menu-bar icon.'
        : '[mundusmaker] keep this window open while you use MundusMaker. Press Ctrl+C to stop.');
    if (!NO_OPEN) openBrowser(url);
    if (process.send) process.send({ type: 'mundusmaker-ready', port: PORT });
  });
});

if (CONTAINER) {
  const stop = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 9000).unref();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  // Do not leave an unauthenticated backend orphan if its gateway dies.
  process.once('disconnect', stop);
} else {
  // Ctrl+C, a terminate request (the Mac menu's Quit) and, on Windows, closing
  // the console window all stop gracefully; a second signal stops at once.
  const onSignal = (signal) => { if (quitting) process.exit(0); gracefulQuit(`received ${signal}`); };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  if (process.platform === 'win32') process.on('SIGHUP', onSignal);
}
