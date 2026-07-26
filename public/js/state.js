// Central client state: the list of worlds, the active world's config and
// entities, and the GM/player view flag.

import { api } from './api.js';
import { slugify, uid } from './util.js';

export const state = {
  worlds: [],       // [{id, name, description, entities}]
  worldId: null,
  world: null,
  entities: new Map(), // id -> entity
  gm: localStorage.getItem('loreweave.gm') !== 'off',
  loaded: false,
};

export const bus = new EventTarget();
export function emit(type) { bus.dispatchEvent(new Event(type)); }
export function on(type, fn) { bus.addEventListener(type, fn); }

/** Discover worlds and pick the remembered (or first) one. */
export async function init() {
  state.worlds = await api.listWorlds();
  const remembered = localStorage.getItem('loreweave.world');
  const pick = state.worlds.find((w) => w.id === remembered) || state.worlds[0];
  if (!pick) return false; // no worlds exist (all deleted at runtime)
  await selectWorld(pick.id);
  return true;
}

export async function selectWorld(worldId) {
  const prevId = state.worldId;
  state.worldId = worldId;
  api.setWorld(worldId);
  try {
    await loadAll();
  } catch (err) {
    // roll back so a broken/deleted world can't wedge the app
    state.worldId = prevId;
    api.setWorld(prevId);
    throw err;
  }
  localStorage.setItem('loreweave.world', worldId); // only remember worlds that actually load
}

export async function refreshWorlds() {
  state.worlds = await api.listWorlds();
  emit('worlds');
}

export async function loadAll() {
  const [world, entities] = await Promise.all([api.getWorld(), api.getEntities()]);
  // additive migration: make sure newer built-in types exist in older worlds
  world.types ??= {};
  const builtins = {
    npc: { label: 'NPC', plural: 'NPCs', color: '#d9913f', fields: ['Role', 'Species', 'Disposition', 'Found at'] },
    session: { label: 'Session', plural: 'Sessions', color: '#4ab8a8', fields: ['Played on', 'Players'] },
  };
  let addedTypes = false;
  for (const [key, def] of Object.entries(builtins)) {
    if (!world.types[key]) { world.types[key] = def; addedTypes = true; }
  }
  if (addedTypes) api.putWorld(world).catch(() => { /* non-fatal */ });
  world.calendar ??= {};
  state.world = world;
  state.entities = new Map(entities.map((e) => [e.id, e]));
  state.loaded = true;
  emit('world-switched');
  emit('change');
}

export function setGm(gm) {
  state.gm = gm;
  localStorage.setItem('loreweave.gm', gm ? 'on' : 'off');
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
  const saved = (await api.putEntity(entity)).entity;
  state.entities.set(saved.id, saved);
  emit('change');
  return saved;
}

/** Swap in an entity the server already persisted (e.g. a restored version). */
export function replaceEntity(entity) {
  state.entities.set(entity.id, entity);
  emit('change');
}

export async function saveWorld() {
  await api.putWorld(state.world);
  emit('change');
}

// ---------- save tracking (drives the Save button in the top bar) ----------
// Views call scheduleSave()/scheduleWorldSave() on every edit; writes are
// debounced and batched, and the pending/saving/saved state is observable.

const dirtyEntities = new Map(); // id -> entity object (latest reference)
let worldDirty = false;
let saveTimer = null;
let savingCount = 0;
let saveError = null;

export function saveState() {
  if (savingCount > 0) return 'saving';
  if (saveError) return 'error';
  return (dirtyEntities.size || worldDirty) ? 'dirty' : 'saved';
}

function bumpSaveTimer() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { flushSaves(); }, 800);
  emit('savestate');
}

export function scheduleSave(entity) {
  dirtyEntities.set(entity.id, entity);
  bumpSaveTimer();
}

export function scheduleWorldSave() {
  worldDirty = true;
  bumpSaveTimer();
}

export async function flushSaves() {
  clearTimeout(saveTimer);
  if (!dirtyEntities.size && !worldDirty) return;
  const ents = [...dirtyEntities.values()];
  dirtyEntities.clear();
  const wd = worldDirty;
  worldDirty = false;
  savingCount++;
  saveError = null;
  emit('savestate');
  try {
    await Promise.all([
      ...ents.map((e) => saveEntity(e)),
      ...(wd ? [saveWorld()] : []),
    ]);
  } catch (err) {
    // keep the work marked dirty so it retries on the next edit or Save click
    for (const e of ents) if (!dirtyEntities.has(e.id)) dirtyEntities.set(e.id, e);
    if (wd) worldDirty = true;
    saveError = err;
    console.error('save failed:', err);
  } finally {
    savingCount--;
    emit('savestate');
  }
}

export async function deleteEntity(id) {
  await api.deleteEntity(id);
  state.entities.delete(id);
  emit('change');
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
  return {
    id,
    name: String(name).trim() || 'Untitled',
    type: typeKey,
    tags: [],
    gmOnly: false,
    fields: {},
    date: null, // { year, month?, day?, endYear? } — puts the entity on the timeline
    blocks,
    relations: [], // { to, label, secret }
    map: null,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
  };
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
  copy.name = `${src.name} (copy)`;
  let newId = slugify(copy.name);
  while (state.entities.has(newId)) newId = `${slugify(copy.name)}-${uid().slice(0, 4)}`;
  copy.id = newId;
  copy.created = new Date().toISOString();
  await saveEntity(copy);
  return copy;
}
