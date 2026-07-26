// App shell: router, sidebar, world switcher, GM/player toggle.

import { el, toast, rollDice, readSetting, writeSetting } from './util.js';
import {
  init, on, state, setGm, types, typeOf, visibleEntities, createEntity,
  selectWorld, refreshWorlds, saveState, flushSaves,
} from './state.js';
import { api } from './api.js';
import * as dashboard from './views/dashboard.js';
import * as entity from './views/entity.js';
import * as graph from './views/graph.js';
import * as timeline from './views/timeline.js';
import * as mapsView from './views/maps.js';
import * as mapeditor from './views/mapeditor.js';
import * as exportView from './views/export.js';
import * as importView from './views/import.js';
import * as helpView from './views/help.js';
import { wireLinkPreviews } from './preview.js';

const viewEl = document.getElementById('view');
const sidebarEl = document.getElementById('sidebar');
let cleanup = null;

// ---------- router ----------

function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (cleanup) { try { cleanup(); } catch { /* view already gone */ } cleanup = null; }
  viewEl.innerHTML = '';
  viewEl.scrollTop = 0;

  let nav = 'dashboard', ret = null;
  try {
    if (!parts.length) ret = dashboard.render(viewEl);
    else if (parts[0] === 'e') { nav = ''; ret = entity.render(viewEl, parts[1]); }
    else if (parts[0] === 'new') { nav = ''; renderCreate(viewEl, decodeURIComponent(parts[1] || '')); }
    else if (parts[0] === 'graph') { nav = 'graph'; ret = graph.render(viewEl); }
    else if (parts[0] === 'timeline') { nav = 'timeline'; ret = timeline.render(viewEl); }
    else if (parts[0] === 'maps') { nav = 'maps'; ret = mapsView.render(viewEl); }
    else if (parts[0] === 'map') { nav = 'maps'; ret = mapeditor.render(viewEl, parts[1]); }
    else if (parts[0] === 'export') { nav = 'export'; ret = exportView.render(viewEl); }
    else if (parts[0] === 'import') { nav = ''; ret = importView.render(viewEl); }
    else if (parts[0] === 'help') { nav = 'help'; ret = helpView.render(viewEl); }
    else ret = dashboard.render(viewEl);
  } catch (err) {
    console.error(err);
    viewEl.append(el('div', { class: 'page' },
      el('div', { class: 'notice warn' }, 'Something went wrong rendering this view: ', err.message)));
  }
  cleanup = typeof ret === 'function' ? ret : null;

  document.querySelectorAll('#mainnav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === nav));
  renderSidebarList();
}

function renderCreate(container, name) {
  const nameInput = el('input', { value: name, placeholder: 'Name', style: 'flex:1' });
  const typeSel = el('select', {},
    Object.entries(types()).map(([key, t]) => el('option', { value: key }, t.label)));
  const create = async () => {
    if (!nameInput.value.trim()) return;
    const e = await createEntity(nameInput.value, typeSel.value);
    location.hash = `#/e/${e.id}`;
  };
  nameInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') create(); });
  container.append(el('div', { class: 'page' },
    el('h1', {}, 'Create entry'),
    el('div', { class: 'card' },
      el('div', { class: 'row' }, nameInput, typeSel,
        el('button', { class: 'primary', onclick: create }, 'Create'))),
    el('p', { class: 'muted small' }, 'This link was followed from a [[wiki-link]] that doesn’t exist yet.')));
  setTimeout(() => nameInput.focus(), 0);
}

// ---------- sidebar ----------

let search = '';
let searchInput = null;
const collapsed = new Set(JSON.parse(readSetting('collapsed') || '[]'));
let listEl = null;

function buildSidebar() {
  sidebarEl.innerHTML = '';
  searchInput = el('input', {
    class: 'side-search', type: 'search', placeholder: 'Search…  (Ctrl+K)',
    title: 'Searches names, tags and text. Start with # to search tags only.',
    oninput: (ev) => { search = ev.target.value.trim().toLowerCase(); renderSidebarList(); },
  });

  const newName = el('input', { placeholder: 'New entry…' });
  const newType = el('select', {},
    Object.entries(types()).map(([key, t]) => el('option', { value: key }, t.label)));
  const create = async () => {
    if (!newName.value.trim()) return;
    const e = await createEntity(newName.value, newType.value);
    newName.value = '';
    location.hash = `#/e/${e.id}`;
  };
  newName.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') create(); });

  listEl = el('div', {});
  sidebarEl.append(searchInput, el('div', { class: 'side-new' }, newName, newType,
    el('button', { title: 'Create', onclick: create }, '+')), listEl);
  renderSidebarList();
}

function renderSidebarList() {
  if (!listEl || !state.loaded) return;
  listEl.innerHTML = '';
  const currentId = location.hash.startsWith('#/e/') ? location.hash.slice(4)
    : location.hash.startsWith('#/map/') ? location.hash.slice(6) : null;

  const match = (e) => {
    if (!search) return true;
    if (search.startsWith('#')) return (e.tags || []).some((t) => t.toLowerCase().includes(search.slice(1)));
    if (e.name.toLowerCase().includes(search)) return true;
    if ((e.tags || []).some((t) => t.toLowerCase().includes(search))) return true;
    // full-text over blocks (secret blocks only match in GM view)
    return (e.blocks || []).some((b) =>
      (state.gm || !b.secret) && (b.text || '').toLowerCase().includes(search));
  };

  const ents = visibleEntities().filter(match);
  for (const [key, t] of Object.entries(types())) {
    const group = ents.filter((e) => e.type === key).sort((a, b) => a.name.localeCompare(b.name));
    if (!group.length) continue;
    const isCollapsed = collapsed.has(key) && !search;
    const head = el('div', {
      class: 'side-group-head',
      onclick: () => {
        collapsed.has(key) ? collapsed.delete(key) : collapsed.add(key);
        writeSetting('collapsed', JSON.stringify([...collapsed]));
        renderSidebarList();
      },
    },
      el('span', { class: 'dot', style: `background:${t.color}` }),
      t.plural || t.label,
      el('span', { class: 'count' }, `${isCollapsed ? '▸ ' : ''}${group.length}`));
    const groupEl = el('div', { class: 'side-group' }, head);
    if (!isCollapsed) {
      for (const e of group) {
        groupEl.append(el('a', { class: `side-item${e.id === currentId ? ' active' : ''}`, href: `#/e/${e.id}` },
          el('span', { class: 'dot', style: `background:${typeOf(e).color}` }),
          e.name,
          e.map ? el('span', { title: 'has a map', style: 'font-size:11px;opacity:.7' }, '🗺') : null,
          (e.blocks || []).some((b) => b.kind === 'statblock') ? el('span', { title: 'has a statblock', style: 'font-size:11px;opacity:.7' }, '⚔') : null,
          e.gmOnly ? el('span', { class: 'gm-mark', title: 'GM-only — invisible to players' }, '🔒') : null));
      }
    }
    listEl.append(groupEl);
  }
  if (!ents.length) {
    listEl.append(el('div', { class: 'muted small', style: 'padding:8px' },
      search ? 'No matches.' : 'No entries yet.'));
  }
  if (!state.gm) {
    const hidden = [...state.entities.values()].filter((e) => e.gmOnly).length;
    if (hidden) {
      listEl.append(el('div', { class: 'muted small', style: 'padding:10px 8px;border-top:1px solid var(--line);margin-top:8px' },
        `👁 Player preview: ${hidden} GM-only ${hidden === 1 ? 'entry is' : 'entries are'} hidden.`));
    }
  }
}

// ---------- world switcher ----------

const NEW_WORLD = '__new__';

function renderWorldSelect() {
  const sel = document.getElementById('worldSelect');
  sel.innerHTML = '';
  for (const w of state.worlds) {
    sel.append(el('option', { value: w.id }, w.name));
  }
  sel.append(el('option', { value: NEW_WORLD }, '＋ New world…'));
  sel.value = state.worldId; // set the property explicitly — attributes alone are unreliable
}

async function onWorldSelect(ev) {
  const val = ev.target.value;
  try {
    if (val === NEW_WORLD) {
      const name = prompt('Name of the new world:');
      if (!name?.trim()) { renderWorldSelect(); return; }
      const { id } = await api.createWorld(name.trim());
      await refreshWorlds();
      await switchTo(id);
      return;
    }
    if (val !== state.worldId) await switchTo(val);
  } catch (err) {
    console.error(err);
    toast(`Could not switch world: ${err.message}`, 5000);
    await refreshWorlds().catch(() => { /* server unreachable */ });
    renderWorldSelect(); // snap the dropdown back to the world that is actually open
  }
}

export async function switchTo(worldId) {
  await flushSaves(); // pending edits must land in the OLD world before we switch
  await selectWorld(worldId);
  await refreshWorlds().catch(() => { /* list stays stale, not fatal */ });
  renderWorldSelect();
  buildSidebar();
  location.hash = '#/';
  route();
  toast(`Switched to “${state.world.name}”`);
}

// ---------- save indicator ----------

function wireSaveButton() {
  const btn = document.getElementById('saveBtn');
  const LABELS = { saved: '✓ Saved', dirty: '● Save', saving: '⋯ Saving', error: '⚠ Retry save' };
  const sync = () => {
    const s = saveState();
    btn.className = `save-btn ${s}`;
    btn.textContent = LABELS[s];
  };
  btn.addEventListener('click', async () => {
    await flushSaves();
    if (saveState() === 'saved') toast('All changes saved');
  });
  on('savestate', sync);
  sync();

  window.addEventListener('beforeunload', (ev) => {
    if (saveState() === 'saved') return;
    flushSaves(); // best effort — the confirm dialog below buys it time
    ev.preventDefault();
    ev.returnValue = '';
  });
}

// ---------- GM toggle ----------

function wireGmToggle() {
  const label = document.getElementById('gmToggle');
  const input = document.getElementById('gmToggleInput');
  const sync = () => {
    input.checked = state.gm;
    label.classList.toggle('gm-on', state.gm);
  };
  input.addEventListener('change', () => setGm(input.checked));
  on('gm', () => { sync(); route(); });
  sync();
}

// ---------- boot ----------

async function boot() {
  viewEl.innerHTML = '<div class="page"><p class="muted">Loading worlds…</p></div>';
  try {
    const ok = await init();
    if (!ok) {
      // every world was deleted at runtime — offer to create one
      const name = prompt('No worlds found. Name your first world:', 'My World') || 'My World';
      const { id } = await api.createWorld(name);
      await refreshWorlds();
      await selectWorld(id);
    }
  } catch (err) {
    viewEl.innerHTML = '';
    viewEl.append(el('div', { class: 'page' },
      el('div', { class: 'notice warn' },
        'Could not load your worlds from the local server (', err.message, '). ',
        'Make sure you started MundusMaker (double-click Start-MundusMaker, or run node server.js) and are opening it via that server.')));
    return;
  }
  document.title = `${state.world.name || 'MundusMaker'} · MundusMaker`;
  buildSidebar();
  wireGmToggle();
  wireSaveButton();
  renderWorldSelect();
  document.getElementById('worldSelect').addEventListener('change', onWorldSelect);
  on('change', () => {
    renderSidebarList();
    document.title = `${state.world.name || 'MundusMaker'} · MundusMaker`;
  });
  on('worlds', renderWorldSelect);
  wireLinkPreviews();
  // clickable dice anywhere: text blocks, statblocks, encounter notes
  document.addEventListener('click', (ev) => {
    const die = ev.target.closest('a.dice');
    if (!die) return;
    ev.preventDefault();
    ev.stopPropagation();
    const r = rollDice(die.dataset.dice);
    if (!r) return;
    const mod = r.mod ? ` ${r.mod > 0 ? '+' : '−'} ${Math.abs(r.mod)}` : '';
    toast(`🎲 ${die.dataset.dice}  →  [${r.rolls.join(', ')}]${mod}  =  ${r.total}${r.nat === 20 ? '  — natural 20!' : r.nat === 1 ? '  — natural 1!' : ''}`, 4000);
  }, true);

  window.addEventListener('hashchange', route);
  window.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') {
      ev.preventDefault();
      searchInput?.focus();
      searchInput?.select();
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
      ev.preventDefault();
      flushSaves().then(() => { if (saveState() === 'saved') toast('All changes saved'); });
    }
  });
  route();
}

boot();
