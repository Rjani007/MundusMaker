// Central client state: the list of worlds, the active world's config and
// entities, and the GM/player view flag.

import { api } from './api.js';
import { slugify, uid, readSetting, writeSetting } from './util.js';

export const state = {
  worlds: [],       // [{id, name, description, entities}]
  worldId: null,
  world: null,
  entities: new Map(), // id -> entity
  // defaults to GM view; a remembered 'off' must survive the rename, or a GM who
  // left the app in player preview is silently flipped back to seeing secrets
  gm: readSetting('gm') !== 'off',
  loaded: false,
  loading: false,
  loadIssues: [],
};

export const bus = new EventTarget();
export function emit(type) { bus.dispatchEvent(new Event(type)); }
export function on(type, fn) { bus.addEventListener(type, fn); }
const entityWorlds = new WeakMap();

/** Discover worlds and pick the remembered (or first) one. */
export async function init() {
  state.worlds = await api.listWorlds();
  const remembered = readSetting('world');
  const pick = state.worlds.find((w) => w.id === remembered) || state.worlds[0];
  if (!pick) return false; // no worlds exist (all deleted at runtime)
  await selectWorld(pick.id);
  return true;
}

export async function selectWorld(worldId) {
  await loadAll(worldId);
  writeSetting('world', worldId); // only remember worlds that actually load
}

export async function refreshWorlds() {
  state.worlds = await api.listWorlds();
  emit('worlds');
}

export async function loadAll(worldId = state.worldId) {
  if (state.loading) throw new Error('A world is already loading. Please wait.');
  state.loading = true;
  emit('loading');
  try {
    await requireSaved();
    const result = await api.readWorldSnapshot(worldId);
    const world = result.world;
    // A background operation may have queued work while the snapshot loaded.
    // Keep that work and let the user retry, rather than adopting a stale view.
    if (dirtyEntities.size || dirtyWorlds.size || saveFlight) throw new Error('New edits arrived while loading. Save them, then try again.');
    api.acceptWorldSnapshot(worldId, result);
    // additive migration: make sure newer built-in types exist in older worlds
    world.types ??= {};
    const builtins = {
      npc: { label: 'NPC', plural: 'NPCs', color: '#d9913f', fields: ['Role', 'Species', 'Disposition', 'Found at'] },
      session: { label: 'Session', plural: 'Sessions', color: '#4ab8a8', fields: ['Played on', 'Players'] },
      // 0.14: spells imported from the compendium library file here
      spell: { label: 'Spell', plural: 'Spells', color: '#9b59d0', fields: ['Level', 'School', 'Casting time', 'Range', 'Duration', 'Classes'] },
      handout: { label: 'Handout', plural: 'Handouts', color: '#bbaa78', fields: ['Kind', 'Found at'] },
    };
    let addedTypes = false;
    for (const [key, def] of Object.entries(builtins)) {
      if (!world.types[key]) { world.types[key] = def; addedTypes = true; }
    }
    world.calendar ??= {};
    state.worldId = worldId;
    api.setWorld(worldId);
    state.world = world;
    state.entities = new Map(result.entities.map((e) => [e.id, e]));
    for (const entity of state.entities.values()) entityWorlds.set(entity, worldId);
    state.loadIssues = result.issues;
    state.loaded = true;
    if (addedTypes) scheduleWorldSave();
    emit('world-switched');
    emit('change');
  } finally {
    state.loading = false;
    emit('loading');
  }
}

export function setGm(gm) {
  state.gm = gm;
  writeSetting('gm', gm ? 'on' : 'off');
  emit('gm');
  emit('change');
}

export function types() {
  return state.world?.types || {};
}

export function typeOf(entity) {
  return types()[entity.type] || { label: entity.type, plural: entity.type, color: '#8a8f98', fields: [] };
}

/** Entities visible in the current view mode (player preview hides gmOnly). */
export function visibleEntities() {
  const all = [...state.entities.values()];
  return state.gm ? all : all.filter((e) => !e.gmOnly);
}

export function getEntity(id) {
  return state.entities.get(id) || null;
}

export function findByName(name) {
  const n = String(name).trim().toLowerCase();
  for (const e of state.entities.values()) {
    if (e.name.toLowerCase() === n || e.id === n) return e;
  }
  return null;
}

export async function saveEntity(entity) {
  scheduleSave(entity);
  await requireSaved();
  return entity;
}

/** Swap in an entity the server already persisted (e.g. a restored version). */
export function replaceEntity(entity) {
  entityWorlds.set(entity, state.worldId);
  state.entities.set(entity.id, entity);
  emit('change');
}

export async function saveWorld() {
  scheduleWorldSave();
  await requireSaved();
}

// ---------- save tracking (drives the Save button in the top bar) ----------
// Views call scheduleSave()/scheduleWorldSave() on every edit; writes are
// debounced and batched, and the pending/saving/saved state is observable.

const dirtyEntities = new Map(); // world/id -> { wid, entity }, latest reference
const dirtyWorlds = new Map(); // world id -> world object
const deleting = new Set();
let saveTimer = null;
let saveFlight = null;
let saveError = null;

export function saveState() {
  if (saveFlight) return 'saving';
  if (saveError) return 'error';
  return (dirtyEntities.size || dirtyWorlds.size) ? 'dirty' : 'saved';
}

export function saveFailure() { return saveError; }

export async function requireSaved() {
  if (!await flushSaves()) {
    if (!state.gm) throw new Error('Changes could not be saved. Return to GM view for recovery details.');
    throw saveError || new Error('Your changes could not be saved. Please retry before continuing.');
  }
}

/** GM-only recovery download. It includes secrets and no asset bytes. */
export function unsavedDraft() {
  if (!state.gm) throw new Error('Switch to GM view to download a recovery draft.');
  return {
    mundusmakerDraft: 1, exported: new Date().toISOString(),
    worlds: [...dirtyWorlds].map(([id, world]) => ({ id, world: structuredClone(world) })),
    entries: [...dirtyEntities.values()].map(({ wid, entity }) => ({ worldId: wid, entity: structuredClone(entity) })),
  };
}

function bumpSaveTimer() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { flushSaves(); }, 800);
  emit('savestate');
}

export function scheduleSave(entity) {
  const wid = entityWorlds.get(entity) || state.worldId;
  entityWorlds.set(entity, wid);
  const key = `${wid}/${entity.id}`;
  if (deleting.has(key)) return;
  dirtyEntities.set(key, { wid, entity });
  bumpSaveTimer();
}

export function scheduleWorldSave() {
  dirtyWorlds.set(state.worldId, state.world);
  bumpSaveTimer();
}

export function flushSaves() {
  clearTimeout(saveTimer);
  if (saveFlight) return saveFlight;
  if (!dirtyEntities.size && !dirtyWorlds.size) return Promise.resolve(!saveError);
  saveError = null;
  // Install the promise before the first event or write, including synchronous
  // event handlers that may request another flush.
  saveFlight = Promise.resolve().then(async () => {
    while (dirtyEntities.size || dirtyWorlds.size) {
      const entities = [...dirtyEntities];
      const worlds = [...dirtyWorlds];
      for (const [key, pending] of entities) {
        if (dirtyEntities.get(key) !== pending) continue;
        const draft = structuredClone(pending.entity);
        try {
          const saved = (await api.putEntity(draft, pending.wid)).entity;
          // Keep editor object identity. A slow response must never replace
          // text typed since this request started.
          pending.entity.updated = saved.updated;
          if (state.worldId === pending.wid) state.entities.set(saved.id, dirtyEntities.get(key)?.entity || pending.entity);
          if (dirtyEntities.get(key) === pending) dirtyEntities.delete(key);
          emit('change');
        } catch (err) { saveError = err; break; }
      }
      if (saveError) break;
      for (const [wid, world] of worlds) {
        const draft = structuredClone(world);
        try {
          await api.putWorld(draft, wid);
          // The world is mutated in place, so compare the actual sent snapshot.
          if (JSON.stringify(dirtyWorlds.get(wid)) === JSON.stringify(draft)) dirtyWorlds.delete(wid);
          emit('change');
        } catch (err) { saveError = err; break; }
      }
      if (saveError) break;
    }
    return !saveError;
  }).catch((err) => {
    saveError = err;
    return false;
  }).finally(() => {
    saveFlight = null;
    emit('savestate');
  });
  emit('savestate');
  return saveFlight;
}

export async function deleteEntity(id) {
  const wid = state.worldId;
  const key = `${wid}/${id}`;
  deleting.add(key);
  try {
    await requireSaved(); // pending edits must reach trash, never resurrect it later
    await api.deleteEntity(id, wid);
    if (state.worldId === wid) state.entities.delete(id);
    emit('change');
  } finally { deleting.delete(key); }
}

// Starter blocks for new entries, per built-in type. A world can override
// these by putting a `template` array on the type in world.json (block specs
// {kind, text?, secret?}); `template: []` turns the scaffold off entirely.
const BUILTIN_TEMPLATES = {
  character: [
    { kind: 'text' },
    { kind: 'heading', text: 'Background' }, { kind: 'text' },
    { kind: 'heading', text: 'Goals & bonds' }, { kind: 'text' },
  ],
  npc: [
    { kind: 'text' },
    { kind: 'heading', text: 'Appearance' }, { kind: 'text' },
    { kind: 'heading', text: 'Personality' }, { kind: 'text' },
    { kind: 'heading', text: 'Hooks', secret: true }, { kind: 'text', secret: true },
  ],
  location: [
    { kind: 'text' },
    { kind: 'heading', text: 'What you see' }, { kind: 'text' },
    { kind: 'heading', text: 'Who you meet' }, { kind: 'text' },
    { kind: 'heading', text: 'Secrets', secret: true }, { kind: 'text', secret: true },
  ],
  faction: [
    { kind: 'text' },
    { kind: 'heading', text: 'Goals & methods' }, { kind: 'text' },
    { kind: 'heading', text: 'Notable members' }, { kind: 'text' },
    { kind: 'heading', text: 'Secrets', secret: true }, { kind: 'text', secret: true },
  ],
  item: [
    { kind: 'text' },
    { kind: 'heading', text: 'Powers' }, { kind: 'text' },
    { kind: 'heading', text: 'History' }, { kind: 'text' },
  ],
  creature: [
    { kind: 'text' },
    { kind: 'heading', text: 'Description' }, { kind: 'text' },
    { kind: 'heading', text: 'Behavior' }, { kind: 'text' },
  ],
  session: [
    { kind: 'heading', text: 'Recap' }, { kind: 'text' },
    { kind: 'heading', text: 'Loose threads' }, { kind: 'text' },
    { kind: 'heading', text: 'Next time', secret: true }, { kind: 'text', secret: true },
  ],
};

export function newEntity(name, type) {
  let id = slugify(name);
  while (state.entities.has(id)) id = `${slugify(name)}-${uid().slice(0, 4)}`;
  const typeKey = type in types() ? type : 'note';
  const template = types()[typeKey]?.template ?? BUILTIN_TEMPLATES[typeKey];
  const blocks = Array.isArray(template) && template.length
    ? template.map((b) => ({ id: uid(), kind: b.kind || 'text', text: b.text || '', secret: !!b.secret }))
    : [{ id: uid(), kind: 'text', text: '', secret: false }];
  const entity = {
    id,
    name: String(name).trim() || 'Untitled',
    type: typeKey,
    tags: [],
    gmOnly: false,
    fields: {},
    // { year?, month?, day?, special?, endYear?, recurs? } — puts the entity on
    // the timeline. `month` is a 1-based position in calendar.months; `special`
    // names an intercalary day instead (the two are mutually exclusive);
    // `recurs: 'annual'` repeats every year and therefore carries no year.
    date: null,
    blocks,
    relations: [], // { to, label, secret }
    map: null,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
  };
  entityWorlds.set(entity, state.worldId);
  return entity;
}

export async function createEntity(name, type) {
  const e = newEntity(name, type);
  await saveEntity(e);
  return e;
}

/** Deep-copy an entity under a new id/name (handy for statblock variants). */
export async function duplicateEntity(id) {
  const src = getEntity(id);
  if (!src) return null;
  const copy = structuredClone(src);
  entityWorlds.set(copy, entityWorlds.get(src) || state.worldId);
  copy.name = `${src.name} (copy)`;
  let newId = slugify(copy.name);
  while (state.entities.has(newId)) newId = `${slugify(copy.name)}-${uid().slice(0, 4)}`;
  copy.id = newId;
  copy.created = new Date().toISOString();
  await saveEntity(copy);
  return copy;
}
