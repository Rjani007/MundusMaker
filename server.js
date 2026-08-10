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
const { download5etools } = require('./scripts/fetch-5etools');

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
let libraryDownloadActive = false;

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
    for (const sub of ['entities', 'exports', 'assets']) {
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

/**
 * Copy one world (world.json, entities, assets — not exports) into .snapshots.
 * The stamp starts with the date so lexical order stays chronological even when
 * a label ("pre-restore") is appended — retention shifts oldest-first off that
 * same lexical sort.
 */
function snapshotWorld(wid, label) {
  const snapDir = path.join(DATA_DIR, '.snapshots', wid);
  fs.mkdirSync(snapDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-') + (label ? `-${label}` : '');
  const dest = path.join(snapDir, stamp);
  const src = path.join(WORLDS_DIR, wid);
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(src, 'world.json'), path.join(dest, 'world.json'));
  for (const sub of ['entities', 'assets']) {
    if (fs.existsSync(path.join(src, sub))) copyDirSync(path.join(src, sub), path.join(dest, sub));
  }
  const all = fs.readdirSync(snapDir).sort();
  while (all.length > 7) fs.rmSync(path.join(snapDir, all.shift()), { recursive: true, force: true });
  return stamp;
}

/** Daily safety copies of every world. Keeps the last 7 per world. */
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

/**
 * The 5etools route is the app's only API mutation that initiates outbound
 * network traffic. Keep it callable by this localhost UI and scripts, but not
 * by an arbitrary web page posting a simple request to the user's loopback.
 */
function requireLocalJsonDownload(req) {
  const host = String(req.headers.host || '').trim().toLowerCase();
  if (!/^(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(host)
      && !/^\[::1\](?::\d+)?$/.test(host)) {
    throw Object.assign(new Error('5etools downloads are available only from the local MundusMaker app'), { status: 403 });
  }
  const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw Object.assign(new Error('5etools downloads require an application/json request'), { status: 415 });
  }
  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite === 'cross-site') {
    throw Object.assign(new Error('cross-site 5etools download requests are not allowed'), { status: 403 });
  }
  const origin = String(req.headers.origin || '').trim();
  if (origin) {
    let normalized;
    try {
      const parsed = new URL(origin);
      normalized = `${parsed.protocol}//${parsed.host}`.toLowerCase();
    } catch { /* rejected below */ }
    if (normalized !== `http://${host}`) {
      throw Object.assign(new Error('5etools downloads must be started from this MundusMaker page'), { status: 403 });
    }
  }
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
    'entries', 'dmg1', 'dmg2', 'dmgType', 'property', 'ac', 'source'],
  class: ['name', 'source', 'hd', 'classFeatures', 'subclasses', 'spellcastingAbility'],
  classFeature: ['name', 'source', 'className', 'classSource', 'level', 'entries'],
  subclass: ['name', 'shortName', 'source', 'className', 'classSource', 'subclassFeatures'],
  subclassFeature: ['name', 'source', 'className', 'classSource', 'subclassShortName', 'subclassSource', 'level', 'entries'],
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
  const p = path.resolve(String(candidatePath || ''));
  if (!p || !fs.existsSync(p) || !fs.statSync(p).isDirectory()) return null;
  let dataDir = null;
  if (fs.existsSync(path.join(p, 'worlds')) || fs.existsSync(path.join(p, 'world.json'))) {
    dataDir = p; // pointed straight at a data folder
  } else {
    for (const name of CONFIG_NAMES) {
      try {
        const cfg = JSON.parse(fs.readFileSync(path.join(p, name), 'utf8'));
        if (cfg.dataDir) { dataDir = path.resolve(p, cfg.dataDir); break; }
      } catch { /* try the next name */ }
    }
    if (!dataDir && fs.existsSync(path.join(p, 'data'))) dataDir = path.join(p, 'data');
  }
  if (!dataDir || !fs.existsSync(dataDir)) return null;
  if (path.resolve(dataDir) === DATA_DIR) return null; // that's the live data dir — nothing to migrate
  const countEntities = (d) => {
    const entDir = path.join(d, 'entities');
    return fs.existsSync(entDir) ? fs.readdirSync(entDir).filter((f) => f.endsWith('.json')).length : 0;
  };
  const readName = (worldJson, fallback) => {
    try { return JSON.parse(fs.readFileSync(worldJson, 'utf8')).name || fallback; } catch { return fallback; }
  };
  const worlds = [];
  const wdir = path.join(dataDir, 'worlds');
  if (fs.existsSync(wdir)) {
    for (const d of fs.readdirSync(wdir, { withFileTypes: true })) {
      if (!d.isDirectory() || !fs.existsSync(path.join(wdir, d.name, 'world.json'))) continue;
      worlds.push({
        id: d.name,
        name: readName(path.join(wdir, d.name, 'world.json'), d.name),
        entities: countEntities(path.join(wdir, d.name)),
      });
    }
  }
  if (worlds.length) return { path: p, dataDir, layout: 'v2', worlds };
  if (fs.existsSync(path.join(dataDir, 'world.json'))) {
    return {
      path: p, dataDir, layout: 'v1',
      worlds: [{ id: '__v1__', name: readName(path.join(dataDir, 'world.json'), 'My World'), entities: countEntities(dataDir) }],
    };
  }
  return null;
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

  // --- recovery browser (trash + the last seven snapshots per world) ---
  if (pathname === '/api/recovery' && method === 'GET') {
    return sendJson(res, 200, listRecovery());
  }
  if (pathname === '/api/recovery/restore' && method === 'POST') {
    const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8'));
    return sendJson(res, 200, restoreRecovery(body));
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

  // --- compendium library ---
  if (pathname === '/api/library' && method === 'GET') {
    return sendJson(res, 200, listLibrary());
  }
  if (pathname === '/api/library' && method === 'POST') {
    const body = JSON.parse((await readBody(req, 50 * 1024 * 1024)).toString('utf8'));
    return sendJson(res, 200, storeLibraryPack(body.name, body.data || {}));
  }
  if (pathname === '/api/library/download-5etools' && method === 'POST') {
    requireLocalJsonDownload(req);
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

  // --- migration from older installs (Loreweave / TomeWeaver / MundusMaker) ---
  if (pathname === '/api/scan-installs' && method === 'GET') {
    const results = [];
    const parent = path.dirname(ROOT);
    let siblings = [];
    try { siblings = fs.readdirSync(parent, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { /* parent unreadable */ }
    for (const d of siblings) {
      const full = path.join(parent, d.name);
      if (full === ROOT) continue;
      const looksLikeInstall = /loreweave|tomeweaver|mundusmaker/i.test(d.name)
        || (fs.existsSync(path.join(full, 'server.js')) && fs.existsSync(path.join(full, 'public')));
      if (!looksLikeInstall) continue;
      try {
        const found = detectInstallData(full);
        if (found) results.push(found);
      } catch { /* unreadable candidate — skip */ }
    }
    return sendJson(res, 200, results);
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
    const wanted = Array.isArray(body.worldIds) && body.worldIds.length
      ? body.worldIds : found.worlds.map((w) => w.id);
    const migrated = [];
    for (const w of found.worlds) {
      if (!wanted.includes(w.id)) continue;
      const newId = uniqueWorldId(w.name);
      const destDir = path.join(WORLDS_DIR, newId);
      if (found.layout === 'v1') {
        // synthesize a v2 world folder by COPY — the source keeps its v1 shape
        fs.mkdirSync(destDir, { recursive: true });
        fs.copyFileSync(path.join(found.dataDir, 'world.json'), path.join(destDir, 'world.json'));
        for (const sub of ['entities', 'exports', 'assets']) {
          const from = path.join(found.dataDir, sub);
          if (fs.existsSync(from)) copyDirSync(from, path.join(destDir, sub));
        }
      } else {
        copyDirSync(path.join(found.dataDir, 'worlds', w.id), destDir);
      }
      fs.mkdirSync(path.join(destDir, 'entities'), { recursive: true });
      fs.mkdirSync(path.join(destDir, 'exports'), { recursive: true });
      migrated.push({ from: w.id, id: newId, name: w.name, entities: w.entities });
    }
    return sendJson(res, 200, { migrated });
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
    // Both format markers are emitted: `loreweave` keeps new backups restorable
    // into the older builds already in other GMs' hands, `mundusmaker` is what we
    // read going forward. Restore accepts either.
    const payload = { mundusmaker: 1, loreweave: 1, exported: new Date().toISOString(), world, entities: listEntities(dir) };
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
    const isBackup = body && [body.mundusmaker, body.tomeweaver, body.loreweave].includes(1);
    if (!isBackup || !body.world || !Array.isArray(body.entities)) {
      return sendJson(res, 400, { error: 'not a MundusMaker backup' });
    }
    // the state being replaced must survive — same rule as entity-history restore
    try { snapshotWorld(wid, 'pre-restore'); } catch (err) { console.error('[mundusmaker] pre-restore snapshot failed:', err.message); }
    const entDir = path.join(dir, 'entities');
    for (const f of fs.readdirSync(entDir)) {
      if (f.endsWith('.json')) fs.unlinkSync(path.join(entDir, f));
    }
    fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify(body.world, null, 2));
    for (const ent of body.entities) {
      if (!ent || !SAFE_ID.test(String(ent.id))) continue;
      fs.writeFileSync(path.join(entDir, ent.id + '.json'), JSON.stringify(ent, null, 2));
    }
    // backup-v2 embedded assets: restored by (sanitized) name, overwriting like-named files
    if (Array.isArray(body.assets)) {
      const assetsDir = path.join(dir, 'assets');
      fs.mkdirSync(assetsDir, { recursive: true });
      for (const a of body.assets) {
        if (!a || typeof a.name !== 'string') continue;
        const safe = a.name.replace(/[^\w.\-]+/g, '_').slice(-80);
        if (!safe) continue;
        fs.writeFileSync(path.join(assetsDir, safe), Buffer.from(String(a.dataBase64 || ''), 'base64'));
      }
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
