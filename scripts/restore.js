'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { atomicWrite } = require('./storage');

const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const invalid = (message) => { throw Object.assign(new Error(message), { status: 400 }); };

function validateEntity(entity, id = entity?.id) {
  if (!object(entity) || typeof entity.id !== 'string' || !SAFE_ID.test(entity.id) || entity.id !== id
      || typeof entity.name !== 'string' || typeof entity.type !== 'string') invalid('Invalid entry: expected an id, name and type.');
  for (const key of ['blocks', 'relations', 'tags']) {
    if (entity[key] != null && !Array.isArray(entity[key])) invalid(`Invalid entry ${id}: ${key} must be a list.`);
  }
  // Preserve unknown fields and legacy dates verbatim.
}

function validateWorld(world) {
  if (!object(world) || typeof world.name !== 'string') invalid('Invalid world: expected a name.');
  for (const key of ['types', 'calendar']) {
    if (world[key] != null && !object(world[key])) invalid(`Invalid world: ${key} must be an object.`);
  }
}

function validateBackup(body) {
  if (!object(body) || ![body.mundusmaker, body.tomeweaver, body.loreweave].includes(1)
      || !Array.isArray(body.entities)) invalid('Not a MundusMaker backup.');
  validateWorld(body.world);
  const ids = new Set();
  for (const entity of body.entities) {
    validateEntity(entity);
    if (ids.has(entity.id)) invalid(`Duplicate entry id in backup: ${entity.id}`);
    ids.add(entity.id);
  }
  if (body.assets !== undefined && !Array.isArray(body.assets)) invalid('Backup assets must be a list.');
  const names = new Set();
  for (const asset of body.assets || []) {
    if (!object(asset) || typeof asset.name !== 'string' || !asset.name || /[/\\]|\.\./.test(asset.name)
        || asset.name === '.' || /[<>:"|?*\x00-\x1f]/.test(asset.name) || /[. ]$/.test(asset.name)
        || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(asset.name)
        || typeof asset.dataBase64 !== 'string'
        || asset.dataBase64.length % 4 !== 0
        || Buffer.from(asset.dataBase64, 'base64').toString('base64') !== asset.dataBase64) {
      invalid('Invalid asset name or base64 data in backup.');
    }
    const key = asset.name.toLowerCase();
    if (names.has(key)) invalid(`Duplicate asset name in backup: ${asset.name}`);
    names.add(key);
  }
}

function copyTree(src, dest) {
  if (fs.lstatSync(src).isSymbolicLink()) throw new Error('Restore cannot copy symbolic links. The original world is unchanged.');
  if (!fs.statSync(src).isDirectory()) {
    atomicWrite(dest, fs.readFileSync(src));
    return;
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) copyTree(path.join(src, name), path.join(dest, name));
}

// Every recursive removal is confined to a transaction directory we created.
function removeStaged(root, target) {
  const resolved = path.resolve(target);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) throw new Error('Invalid staging path');
  fs.rmSync(resolved, { recursive: true, force: true });
}

function finishTransaction(dataDir, transaction, wid) {
  const previous = path.join(transaction, 'previous');
  const live = path.join(dataDir, 'worlds', wid);
  if (fs.existsSync(previous)) {
    if (!fs.existsSync(live)) {
      // A crash between the two renames: bring back the complete original.
      fs.renameSync(previous, live);
    } else {
      const trash = path.join(dataDir, '.trash');
      fs.mkdirSync(trash, { recursive: true });
      let stamp = Date.now();
      while (fs.existsSync(path.join(trash, `${wid}-${stamp}`))) stamp++;
      fs.renameSync(previous, path.join(trash, `${wid}-${stamp}`));
    }
  }
  removeStaged(path.join(dataDir, '.restore-transactions'), transaction);
}

function recoverTransactions(dataDir) {
  const root = path.join(dataDir, '.restore-transactions');
  if (!fs.existsSync(root)) return;
  for (const name of fs.readdirSync(root)) {
    if (!/^[a-f0-9-]{36}$/.test(name)) continue;
    const transaction = path.join(root, name);
    const manifest = path.join(transaction, 'transaction.json');
    if (!fs.existsSync(manifest)) continue; // staging never reached publication
    const { wid } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (!SAFE_ID.test(wid) || fs.lstatSync(transaction).isSymbolicLink()) throw new Error('Invalid restore transaction');
    finishTransaction(dataDir, transaction, wid);
  }
}

function restoreBackup(dataDir, wid, body, snapshot) {
  if (!SAFE_ID.test(wid)) invalid('Invalid world id');
  validateBackup(body); // validate everything before creating or replacing files
  const root = path.join(dataDir, '.restore-transactions');
  const transaction = path.join(root, randomUUID());
  const staged = path.join(transaction, 'next');
  const live = path.join(dataDir, 'worlds', wid);
  let published = false;
  fs.mkdirSync(transaction, { recursive: true });
  try {
    copyTree(live, staged); // retain exports, history, and assets absent in v1 backups
    removeStaged(transaction, path.join(staged, 'entities'));
    fs.mkdirSync(path.join(staged, 'entities'));
    atomicWrite(path.join(staged, 'world.json'), JSON.stringify(body.world, null, 2));
    for (const entity of body.entities) atomicWrite(path.join(staged, 'entities', entity.id + '.json'), JSON.stringify(entity, null, 2));
    fs.mkdirSync(path.join(staged, 'assets'), { recursive: true });
    for (const asset of body.assets || []) atomicWrite(path.join(staged, 'assets', asset.name), Buffer.from(asset.dataBase64, 'base64'));
    snapshot(); // REQUIRED. Any failure leaves the live world untouched.
    atomicWrite(path.join(transaction, 'transaction.json'), JSON.stringify({ wid }));
    fs.renameSync(live, path.join(transaction, 'previous'));
    fs.renameSync(staged, live);
    published = true;
  } finally {
    // If publication failed, rollback before propagating the error. If cleanup
    // fails after success, boot will finish it; never report a committed restore
    // as failed and invite the user to repeat it.
    if (published) {
      try { finishTransaction(dataDir, transaction, wid); }
      catch (err) { console.error('Restore cleanup deferred until restart:', err.message); }
    } else {
      finishTransaction(dataDir, transaction, wid);
    }
  }
  return { ok: true, count: body.entities.length };
}

module.exports = { validateEntity, validateWorld, validateBackup, restoreBackup, recoverTransactions };
