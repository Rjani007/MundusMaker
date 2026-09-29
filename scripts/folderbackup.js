'use strict';
/*
 * Second-folder backups (1.9, desktop only). On a schedule, copy every world
 * into a folder the GM chose (a USB drive, a NAS share, another disk), as
 * "MundusMaker backup <date>" folders. Each carries a marker file naming the
 * install that made it. Rotation removes only folders whose marker names THIS
 * install, so nothing else in the folder, and nothing another install wrote
 * there, is ever touched. Copies are staged under a partial name and renamed
 * when complete. Restores go through the server's copy-only restoreWorldCopy.
 */
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const MARKER = 'mundusmaker-backup.json';
const PREFIX = 'MundusMaker backup ';
const PARTIAL = '.mundusmaker-partial-';
const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,80}$/i;
const EVERY = [6, 12, 24, 168];

const inside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** Why a folder can't hold backups, or null when it can. */
function checkTarget(dir, dataDir) {
  const target = String(dir || '').trim();
  if (!target || !path.isAbsolute(target)) return 'Enter the full path of a folder, such as D:\\Backups or /Volumes/Drive/Backups.';
  const resolved = path.resolve(target);
  if (inside(resolved, dataDir) || inside(dataDir, resolved)) return 'Choose a folder outside your data folder, ideally on another drive.';
  try { fs.mkdirSync(resolved, { recursive: true }); } catch { return 'That folder could not be created.'; }
  const probe = path.join(resolved, `${PARTIAL}probe-${randomUUID()}`);
  try { fs.writeFileSync(probe, 'ok'); fs.rmSync(probe, { force: true }); } catch { return 'MundusMaker cannot write to that folder.'; }
  return null;
}

function readMarker(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8'));
    return m && m.app === 'mundusmaker' && m.kind === 'folder-backup' ? m : null;
  } catch { return null; }
}

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const item of fs.readdirSync(src, { withFileTypes: true })) {
    if (item.isSymbolicLink()) continue;
    const s = path.join(src, item.name), d = path.join(dest, item.name);
    if (item.isDirectory()) copyTree(s, d);
    else if (item.isFile()) fs.copyFileSync(s, d);
  }
}

/** Every MundusMaker backup in the folder, newest first; `ours` marks this install's. */
function listBackups(target, installId) {
  let items = [];
  try { items = fs.readdirSync(target, { withFileTypes: true }); } catch { return []; }
  return items.filter((d) => d.isDirectory() && d.name.startsWith(PREFIX))
    .map((d) => ({ name: d.name, marker: readMarker(path.join(target, d.name)) }))
    .filter((b) => b.marker)
    .map(({ name, marker }) => ({ name, created: marker.created, version: marker.version, worlds: marker.worlds || [], ours: marker.installId === installId }))
    .sort((a, b) => String(b.created).localeCompare(String(a.created)));
}

/** Copy every world (world.json, entries, assets) into a new backup folder, then rotate. */
function runBackup({ dataDir, target, installId, version, keep = 7, now = new Date() }) {
  const worldsDir = path.join(dataDir, 'worlds');
  const worlds = (fs.existsSync(worldsDir) ? fs.readdirSync(worldsDir, { withFileTypes: true }) : [])
    .filter((d) => d.isDirectory() && SAFE_ID.test(d.name) && fs.existsSync(path.join(worldsDir, d.name, 'world.json')))
    .map((d) => d.name).sort();
  const stamp = now.toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '-');
  let name = PREFIX + stamp;
  for (let n = 2; fs.existsSync(path.join(target, name)); n++) name = `${PREFIX}${stamp} (${n})`;
  const partial = path.join(target, PARTIAL + randomUUID());
  fs.mkdirSync(partial, { recursive: true });
  // an owner file first, so a crash leaves a partial this install can recognize
  fs.writeFileSync(path.join(partial, '.owner'), String(installId));
  try {
    const summary = [];
    for (const wid of worlds) {
      const src = path.join(worldsDir, wid), dest = path.join(partial, 'worlds', wid);
      fs.mkdirSync(dest, { recursive: true });
      fs.copyFileSync(path.join(src, 'world.json'), path.join(dest, 'world.json'));
      for (const sub of ['entities', 'assets']) if (fs.existsSync(path.join(src, sub))) copyTree(path.join(src, sub), path.join(dest, sub));
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(src, 'world.json'), 'utf8')); } catch { /* keep the id */ }
      const entries = fs.existsSync(path.join(src, 'entities')) ? fs.readdirSync(path.join(src, 'entities')).filter((f) => f.endsWith('.json')).length : 0;
      summary.push({ id: wid, name: String(meta.name || wid), entries });
    }
    fs.writeFileSync(path.join(partial, MARKER), JSON.stringify({ app: 'mundusmaker', kind: 'folder-backup', version, installId, created: now.toISOString(), worlds: summary }, null, 2));
    fs.rmSync(path.join(partial, '.owner'), { force: true });
    fs.renameSync(partial, path.join(target, name));
  } catch (err) {
    fs.rmSync(partial, { recursive: true, force: true });
    throw err;
  }
  const removed = rotate(target, installId, keep);
  return { name, worlds: worlds.length, removed };
}

/** Keep this install's newest `keep` backups. Anything else is never touched. */
function rotate(target, installId, keep) {
  const ours = listBackups(target, installId).filter((b) => b.ours);
  const removed = [];
  for (const b of ours.slice(Math.max(1, keep))) {
    const dir = path.join(target, b.name);
    if (readMarker(dir)?.installId !== installId) continue; // re-check right before removing
    fs.rmSync(dir, { recursive: true, force: true });
    removed.push(b.name);
  }
  // abandoned partial copies of this install
  let items = [];
  try { items = fs.readdirSync(target, { withFileTypes: true }); } catch { /* folder gone */ }
  for (const d of items) {
    if (!d.isDirectory() || !d.name.startsWith(PARTIAL)) continue;
    let owner = '';
    try { owner = fs.readFileSync(path.join(target, d.name, '.owner'), 'utf8'); } catch { continue; }
    if (owner === String(installId)) fs.rmSync(path.join(target, d.name), { recursive: true, force: true });
  }
  return removed;
}

/** Whether a scheduled backup is due. */
function isDue(settings, now = Date.now()) {
  if (!settings?.dir) return false;
  const hours = EVERY.includes(Number(settings.everyHours)) ? Number(settings.everyHours) : 24;
  const last = Date.parse(settings.last || '') || 0;
  return now - last >= hours * 3600 * 1000;
}

/** The world folder inside a backup, validated; null when it isn't one. */
function backupWorldDir(target, name, wid) {
  if (!String(name).startsWith(PREFIX) || /[\\/]/.test(name) || name.includes('..') || !SAFE_ID.test(String(wid))) return null;
  const dir = path.join(target, name);
  if (!readMarker(dir)) return null;
  const world = path.join(dir, 'worlds', wid);
  try { if (!fs.lstatSync(world).isDirectory() || !fs.existsSync(path.join(world, 'world.json'))) return null; } catch { return null; }
  return world;
}

module.exports = { MARKER, PREFIX, EVERY, checkTarget, listBackups, runBackup, rotate, isDue, backupWorldDir };
