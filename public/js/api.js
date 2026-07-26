// Thin wrapper over the local JSON API. All world data lives under
// /api/w/<worldId>/... — call setWorld() before using the scoped functions.

let worldId = null;

async function req(method, url, body) {
  const payload = body ? JSON.stringify(body) : undefined;
  const res = await fetch(url, {
    method,
    headers: payload ? { 'Content-Type': 'application/json' } : undefined,
    body: payload,
    // keepalive lets small saves finish even while the tab is closing
    keepalive: !!payload && payload.length < 60000,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch { /* keep statusText */ }
    throw new Error(`${method} ${url}: ${msg}`);
  }
  return res.json();
}

const w = (p) => {
  if (!worldId) throw new Error('no world selected');
  return `/api/w/${encodeURIComponent(worldId)}${p}`;
};

export const api = {
  setWorld: (id) => { worldId = id; },

  // server status & data-folder config
  status: () => req('GET', '/api/status'),
  setDataDir: (dataDir, copyData) => req('POST', '/api/config', { dataDir, copyData }),

  // world management
  listWorlds: () => req('GET', '/api/worlds'),
  createWorld: (name) => req('POST', '/api/worlds', { name }),
  deleteWorld: (id) => req('DELETE', `/api/worlds/${encodeURIComponent(id)}`),

  // current world
  getWorld: () => req('GET', w('/world')),
  putWorld: (world) => req('PUT', w('/world'), world),
  getEntities: () => req('GET', w('/entities')),
  putEntity: (entity) => req('PUT', w(`/entities/${encodeURIComponent(entity.id)}`), entity),
  deleteEntity: (id) => req('DELETE', w(`/entities/${encodeURIComponent(id)}`)),
  entityHistory: (id) => req('GET', w(`/entities/${encodeURIComponent(id)}/history`)),
  restoreEntityVersion: (id, stamp) => req('POST', w(`/entities/${encodeURIComponent(id)}/history/${encodeURIComponent(stamp)}`)),
  exportFile: (name, dataBase64) => req('POST', w('/export-file'), { name, dataBase64 }),
  uploadAsset: (name, dataBase64) => req('POST', w('/assets'), { name, dataBase64 }),
  assetUrl: (worldId, file) => `/assets/${encodeURIComponent(worldId)}/${encodeURIComponent(file)}`,
  backup: () => req('GET', w('/backup')),
  restore: (payload) => req('POST', w('/restore'), payload),
};
