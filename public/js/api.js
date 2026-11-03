// Thin wrapper over the local JSON API. All world data lives under
// /api/w/<worldId>/... — call setWorld() before using the scoped functions.

let worldId = null;
const revisions = new Map(); // URL -> hash of the bytes this page actually read
const writes = new Map();
export const RESTART_NEEDED = 'MundusMaker needs a restart for this: the copy that is running started before it was updated. Quit it (Settings → Running MundusMaker), then start MundusMaker again.';

async function req(method, url, body, revisionUrl = null, record = true) {
  const payload = body ? JSON.stringify(body) : undefined;
  // The server refuses any write not declared as JSON, even one with no body
  // (server.js guardRequest), so other web pages cannot post to it.
  const headers = method === 'GET' ? {} : { 'Content-Type': 'application/json' };
  if (revisionUrl) {
    const known = revisions.get(revisionUrl);
    if (known) headers['If-Match'] = known;
    else headers['If-None-Match'] = '*';
  }
  const res = await fetch(url, {
    method,
    headers,
    body: payload,
    cache: 'no-store',
    // keepalive lets small saves finish even while the tab is closing
    keepalive: !!payload && new TextEncoder().encode(payload).length < 60000,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch { /* keep statusText */ }
    // The pages are read from disk on every load but the server only at start,
    // so an update made while MundusMaker keeps running (in the tray) gives new
    // pages an old server that has never heard of their routes.
    if (res.status === 404 && msg === 'unknown api route') msg = RESTART_NEEDED;
    throw Object.assign(new Error(msg), { status: res.status });
  }
  const value = await res.json();
  if (!record) return { value, revision: res.headers.get('ETag') };
  if (res.headers.get('ETag')) revisions.set(revisionUrl || url, res.headers.get('ETag'));
  if (method === 'DELETE' && revisionUrl) revisions.delete(revisionUrl);
  return value;
}

const w = (p, wid = worldId) => {
  if (!wid) throw new Error('no world selected');
  return `/api/w/${encodeURIComponent(wid)}${p}`;
};

function write(method, url, body, revisionUrl = url) {
  // Capture data now, but read the revision after the preceding write finishes.
  const draft = body ? structuredClone(body) : undefined;
  const previous = writes.get(revisionUrl) || Promise.resolve();
  const pending = previous.catch(() => {}).then(() => req(method, url, draft, revisionUrl));
  writes.set(revisionUrl, pending);
  const clear = () => { if (writes.get(revisionUrl) === pending) writes.delete(revisionUrl); };
  pending.then(clear, clear);
  return pending;
}

export const api = {
  setWorld: (id) => { worldId = id; },

  // server status & data-folder config
  status: () => req('GET', '/api/status'),
  // asks the release feed only on the user's click (scripts/updates.js)
  checkForUpdates: () => req('POST', '/api/update-check', { confirm: true }),
  // publisher sheets the server can fetch on request (scripts/sheetdownload.js)
  sheetSources: () => req('GET', '/api/sheet-templates/sources'),
  downloadSheetTemplate: (id) => req('POST', '/api/sheet-templates/download', { id, confirm: true }),
  setDataDir: (dataDir, copyData) => req('POST', '/api/config', { dataDir, copyData }),

  // world management
  listWorlds: () => req('GET', '/api/worlds'),
  createWorld: (name) => req('POST', '/api/worlds', { name }),
  addSampleWorld: () => req('POST', '/api/worlds/sample', {}),
  deleteWorld: (id) => req('DELETE', `/api/worlds/${encodeURIComponent(id)}`),
  linkIntegrity: () => req('GET', '/api/integrity/links'),

  // current world
  readWorldSnapshot: async (wid) => {
    const [world, entries] = await Promise.all([
      req('GET', w('/world', wid), null, null, false),
      req('GET', w('/entities?details=1', wid), null, null, false),
    ]);
    return { world: world.value, revision: world.revision, ...entries.value };
  },
  acceptWorldSnapshot: (wid, snapshot) => {
    const prefix = w('/entities/', wid);
    for (const key of revisions.keys()) if (key.startsWith(prefix)) revisions.delete(key);
    revisions.set(w('/world', wid), snapshot.revision);
    for (const [id, value] of Object.entries(snapshot.revisions)) revisions.set(prefix + encodeURIComponent(id), value);
  },
  getWorld: (wid) => req('GET', w('/world', wid)),
  putWorld: (world, wid) => write('PUT', w('/world', wid), world),
  getEntities: async (wid = worldId) => {
    const result = await req('GET', w('/entities?details=1', wid));
    const prefix = w('/entities/', wid);
    for (const key of revisions.keys()) if (key.startsWith(prefix)) revisions.delete(key);
    for (const [id, value] of Object.entries(result.revisions)) revisions.set(prefix + encodeURIComponent(id), value);
    return result.entities;
  },
  putEntity: (entity, wid) => write('PUT', w(`/entities/${encodeURIComponent(entity.id)}`, wid), entity),
  deleteEntity: (id, wid) => write('DELETE', w(`/entities/${encodeURIComponent(id)}`, wid)),
  entityHistory: (id) => req('GET', w(`/entities/${encodeURIComponent(id)}/history`)),
  restoreEntityVersion: (id, stamp) => write('POST', w(`/entities/${encodeURIComponent(id)}/history/${encodeURIComponent(stamp)}`), null, w(`/entities/${encodeURIComponent(id)}`)),
  exportFile: (name, dataBase64, wid) => req('POST', w('/export-file', wid), { name, dataBase64 }),
  syncCopy: (file) => req('GET', w('/sync-copies/' + encodeURIComponent(file))),
  resolveSyncCopy: (file, action, revision) => req('POST', w('/sync-copies/' + encodeURIComponent(file)), { action, revision }),
  uploadAsset: (name, dataBase64) => req('POST', w('/assets'), { name, dataBase64 }),
  assetUrl: (worldId, file) => `/assets/${encodeURIComponent(worldId)}/${encodeURIComponent(file)}`,
  backup: (withAssets) => req('GET', w('/backup') + (withAssets ? '?assets=1' : '')),
  restore: (payload) => req('POST', w('/restore'), payload),

  // the GM's own fillable sheet PDFs ("Use my own official sheet")
  sheetTemplates: () => req('GET', '/api/sheet-templates'),
  addSheetTemplate: (body) => req('POST', '/api/sheet-templates', body),
  updateSheetTemplate: (id, body) => req('PUT', `/api/sheet-templates/${encodeURIComponent(id)}`, body),
  deleteSheetTemplate: (id) => req('DELETE', `/api/sheet-templates/${encodeURIComponent(id)}`),
  sheetTemplatePdf: async (id) => {
    const res = await fetch(`/api/sheet-templates/${encodeURIComponent(id)}/pdf`, { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status === 404 ? 'That sheet is no longer saved.' : res.statusText);
    return new Uint8Array(await res.arrayBuffer());
  },

  // compendium library (cross-world packs)
  library: () => req('GET', '/api/library'),
  libraryPack: (id) => req('GET', `/api/library/${encodeURIComponent(id)}`),
  importLibraryPack: (name, data) => req('POST', '/api/library', { name, data }),
  download5etoolsPack: (options) => req('POST', '/api/library/download-5etools', options),
  deleteLibraryPack: (id) => req('DELETE', `/api/library/${encodeURIComponent(id)}`),

  // migration from older installs (Loreweave/TomeWeaver era)
  scanInstalls: () => req('GET', '/api/scan-installs'),
  scanPath: (p) => req('POST', '/api/scan-path', { path: p }),
  migrateInstall: (dataDir, worldIds) => req('POST', '/api/migrate-install', { dataDir, worldIds }),

  // first start beside an older install (scripts/upgrade.js)
  upgradeStatus: () => req('GET', '/api/upgrade'),
  upgradeCopy: (installPath, worldIds, packs) => req('POST', '/api/upgrade/copy', { path: installPath, worldIds, packs }),
  upgradeDismiss: (what) => req('POST', '/api/upgrade/dismiss', { what }),
  upgradeQuitOld: (installPath) => req('POST', '/api/upgrade/quit-old', { path: installPath }),

  // stop the local server; saves already in progress finish first
  quit: () => req('POST', '/api/quit', {}),
  // each open tab checks in once a minute; Settings can stop the server once none has
  presence: () => req('POST', '/api/presence', {}),
  setAutoStop: (minutes) => req('POST', '/api/auto-stop', { minutes }),
  folderBackup: () => req('GET', '/api/folder-backup'),
  setFolderBackup: (settings) => req('POST', '/api/folder-backup', settings),
  runFolderBackup: () => req('POST', '/api/folder-backup/run', {}),
  restoreFolderBackup: (name, worldId) => req('POST', '/api/folder-backup/restore', { name, worldId }),
};
