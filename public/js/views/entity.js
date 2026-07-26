// Entity page: title/type/tags, custom fields, block editor with per-block GM
// secrets and editable statblocks, timeline date, typed relations, backlinks,
// and an attached map. QoL: [[link]] autocomplete, rename updates mentions.

import { el, uid, esc, toast, debounce, helpTip } from '../util.js';
import {
  state, types, typeOf, getEntity, visibleEntities,
  saveEntity, scheduleSave, deleteEntity, duplicateEntity,
  replaceEntity, flushSaves,
} from '../state.js';
import { mdToHtml, backlinksFor, formatWorldDate } from '../render.js';
import { newMap, MAP_KINDS, renderThumbnail } from '../maps/mapcore.js';
import { defaultStat, statblockHtml, ABILITIES } from '../statblock.js';
import { defaultEncounter, computeEncounter, DIFFICULTY_COLORS } from '../encounter.js';
import { monsterToStat, loadBundledBestiary } from '../importers.js';
import { api } from '../api.js';

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// What each suggested field is for — a hover bubble plus an example
// placeholder, so first-time GMs aren't staring at a bare "Kind" input.
// Looked up as "type:Field" first, then "Field"; custom fields get neither.
const FIELD_HINTS = {
  'Role': { tip: 'What do they do?', ph: 'e.g. harbormaster, quest-giver' },
  'Species': { tip: 'What are they?', ph: 'e.g. human, elf, dragonborn' },
  'Status': { tip: 'Alive, dead, missing?', ph: 'e.g. alive, missing, imprisoned' },
  'Disposition': { tip: 'How do they feel about the party?', ph: 'e.g. friendly, wary, hostile' },
  'Found at': { tip: 'Where can they usually be found?', ph: 'e.g. the Salt & Rope tavern' },
  'location:Kind': { tip: 'What sort of place is it?', ph: 'e.g. port city, ruin, tavern' },
  'item:Kind': { tip: 'What sort of item is it?', ph: 'e.g. longsword, wondrous item' },
  'Region': { tip: 'What larger area is it part of?', ph: 'e.g. the northern coast' },
  'Population': { tip: 'How many people live here?', ph: 'e.g. ~2,400' },
  'Goal': { tip: 'What does it want?', ph: 'e.g. control the harbor trade' },
  'Leader': { tip: 'Who runs it?', ph: 'e.g. Guildmaster Vex' },
  'Reach': { tip: 'How far does its influence go?', ph: 'e.g. one city, the whole coast' },
  'Owner': { tip: 'Who has it now?', ph: 'e.g. the party, a rival' },
  'Rarity': { tip: 'How hard is it to find?', ph: 'e.g. rare, one of a kind' },
  'Outcome': { tip: 'What changed because of it?', ph: 'e.g. the old king fell' },
  'Habitat': { tip: 'Where does it live?', ph: 'e.g. coastal caves' },
  'Threat': { tip: 'How dangerous is it?', ph: 'e.g. CR 3, deadly in packs' },
  'Played on': { tip: 'When did you play this session?', ph: 'e.g. 2026-07-12' },
  'Players': { tip: 'Who was at the table?', ph: 'e.g. Ana, Raj, Theo' },
};
const fieldHint = (type, key) => FIELD_HINTS[`${type}:${key}`] || FIELD_HINTS[key] || null;

export function render(container, id) {
  const e = getEntity(id);
  if (!e) {
    container.append(el('div', { class: 'page' }, el('div', { class: 'notice warn' }, 'No entry with this id exists.')));
    return;
  }
  const readOnly = !state.gm;
  if (readOnly && e.gmOnly) {
    container.append(el('div', { class: 'page' },
      el('div', { class: 'notice warn' }, '🔒 This entire entry is GM-only. In player preview it does not exist — it is hidden from lists, graph, timeline, search and exports.'),
      el('p', {}, el('a', { href: '#/' }, '← Back'))));
    return;
  }

  const save = () => scheduleSave(e); // batched + visible in the topbar Save indicator
  const t = () => typeOf(e);

  // ---------- rename propagation ----------
  let nameAtLoad = e.name;
  async function propagateRename() {
    const oldName = nameAtLoad, newName = e.name.trim();
    if (!oldName || !newName || oldName === newName) return;
    nameAtLoad = newName;
    const testRx = new RegExp(`\\[\\[\\s*${escapeRegExp(oldName)}\\s*(\\||\\]\\])`, 'i');
    const affected = [...state.entities.values()].filter((other) =>
      (other.blocks || []).some((b) => testRx.test(b.text || '')));
    if (!affected.length) return;
    const total = affected.reduce((n, other) =>
      n + (other.blocks || []).reduce((m, b) =>
        m + ((b.text || '').match(new RegExp(`\\[\\[\\s*${escapeRegExp(oldName)}\\s*(?=\\||\\]\\])`, 'gi')) || []).length, 0), 0);
    if (!confirm(`“${oldName}” was renamed to “${newName}”.\n\nAlso update ${total} [[link${total === 1 ? '' : 's'}]] in ${affected.length} other ${affected.length === 1 ? 'entry' : 'entries'}?`)) return;
    const replaceRx = new RegExp(`\\[\\[\\s*${escapeRegExp(oldName)}\\s*(\\||\\]\\])`, 'gi');
    for (const other of affected) {
      for (const b of other.blocks || []) {
        if (b.text) b.text = b.text.replace(replaceRx, `[[${newName}$1`);
      }
      await saveEntity(other);
    }
    toast(`Updated ${total} link${total === 1 ? '' : 's'} in ${affected.length} ${affected.length === 1 ? 'entry' : 'entries'}.`);
  }

  // ---------- header ----------
  const title = readOnly
    ? el('h1', { class: 'ent-title', style: 'border:none' }, e.name)
    : el('input', {
        class: 'ent-title', value: e.name,
        oninput: (ev) => { e.name = ev.target.value; save(); },
        onchange: () => propagateRename(),
      });

  const typeSel = el('select', { onchange: (ev) => { e.type = ev.target.value; save(); refreshFields(); } },
    Object.entries(types()).map(([key, ty]) => el('option', { value: key, selected: key === e.type }, ty.label)));

  const tagsInput = el('input', {
    value: (e.tags || []).join(', '), placeholder: 'tags, comma separated', style: 'width:200px',
    oninput: (ev) => { e.tags = ev.target.value.split(',').map((s) => s.trim()).filter(Boolean); save(); },
  });

  const gmOnlyBtn = el('button', {
    class: e.gmOnly ? 'gm-only-badge' : 'ghost small',
    title: 'GM-only entries are invisible to players everywhere: lists, graph, timeline, and player exports',
    onclick: () => { e.gmOnly = !e.gmOnly; save(); rerender(); },
  }, e.gmOnly ? '🔒 GM-only entry' : 'Make GM-only');

  const meta = el('div', { class: 'ent-meta' },
    readOnly
      ? [el('span', { class: 'type-badge' },
          el('span', { class: 'dot', style: `background:${t().color}` }), t().label),
         (e.tags || []).map((tag) => el('span', { class: 'tag' }, tag))]
      : [el('span', { class: 'dot', style: `background:${t().color}` }), typeSel, tagsInput, gmOnlyBtn,
         el('span', { class: 'spacer' }),
         el('button', {
           class: 'ghost small', title: 'Create a copy of this entry (great for NPC variants)',
           onclick: async () => {
             const copy = await duplicateEntity(e.id);
             if (copy) location.hash = `#/e/${copy.id}`;
           },
         }, 'Duplicate'),
         el('button', {
           class: 'ghost small', title: 'Previous versions of this entry, kept automatically as you edit',
           onclick: showHistory,
         }, '⏳ History'),
         el('button', {
           class: 'ghost danger', onclick: async () => {
             if (!confirm(`Delete “${e.name}”? Links pointing here will show as missing.`)) return;
             await deleteEntity(e.id);
             location.hash = '#/';
           },
         }, 'Delete')]);

  // ---------- fields ----------
  // Suggested fields come from the entry's type; the entity only stores
  // values. Hiding a suggested field is per-entry state (e.hiddenFields),
  // otherwise the type would just re-suggest it on the next render.
  const fieldsWrap = el('div', {});
  function refreshFields() {
    fieldsWrap.innerHTML = '';
    const suggested = t().fields || [];
    const hidden = new Set(e.hiddenFields || []);
    const keys = [...new Set([...suggested, ...Object.keys(e.fields || {})])]
      .filter((key) => !hidden.has(key) || (e.fields?.[key] ?? '') !== '');
    if (!keys.length && readOnly) return;
    const grid = el('div', { class: 'fields-grid' });
    for (const key of keys) {
      const val = e.fields?.[key] ?? '';
      if (readOnly && !val) continue;
      const hint = fieldHint(e.type, key);
      grid.append(
        el('div', { class: 'fkey' }, key, hint && !readOnly ? helpTip(hint.tip) : null),
        readOnly
          ? el('div', {}, val)
          : el('input', {
              class: 'fval', value: val, placeholder: hint?.ph || '—',
              oninput: (ev) => { (e.fields ??= {})[key] = ev.target.value; save(); },
            }),
        readOnly ? el('span') : el('button', {
          class: 'ghost small',
          title: suggested.includes(key) ? 'Hide this field on this entry (restore below)' : 'Remove field',
          onclick: () => {
            if ((e.fields?.[key] ?? '').trim() && !confirm(`Remove “${key}” and its value?`)) return;
            if (e.fields) delete e.fields[key];
            if (suggested.includes(key) && !hidden.has(key)) (e.hiddenFields ??= []).push(key);
            save(); refreshFields();
          },
        }, '✕'));
    }
    fieldsWrap.append(grid);
    if (!readOnly) {
      const shown = new Set(keys);
      const hiddenSuggested = suggested.filter((k) => hidden.has(k) && !shown.has(k));
      if (hiddenSuggested.length) {
        fieldsWrap.append(el('div', { class: 'hidden-fields' },
          el('span', {}, 'Hidden:'),
          hiddenSuggested.map((k) => el('button', {
            class: 'ghost', title: `Show “${k}” on this entry again`,
            onclick: () => {
              e.hiddenFields = (e.hiddenFields || []).filter((h) => h !== k);
              save(); refreshFields();
            },
          }, `${k} ↺`))));
      }
      fieldsWrap.append(el('div', { style: 'margin-top:8px' },
        el('button', {
          class: 'ghost small',
          onclick: () => {
            const key = prompt('Field name (e.g. “Motto”, “Population”)');
            if (!key?.trim()) return;
            const k = key.trim();
            if (e.hiddenFields?.includes(k)) e.hiddenFields = e.hiddenFields.filter((h) => h !== k);
            (e.fields ??= {})[k] = '';
            save(); refreshFields();
          },
        }, '+ Add field')));
    }
  }
  refreshFields();

  // ---------- version history ----------
  async function showHistory() {
    await flushSaves(); // pending edits must be on disk before we list/restore
    let items;
    try { items = await api.entityHistory(e.id); } catch (err) { toast('Could not load history: ' + err.message); return; }
    const overlay = el('div', { class: 'overlay', onclick: (ev) => { if (ev.target === overlay) overlay.remove(); } });
    const list = el('div', {});
    if (!items.length) {
      list.append(el('div', { class: 'muted small' },
        'No previous versions yet. MundusMaker keeps one automatically when you come back and edit an entry (at most one every few minutes), up to the last 10.'));
    }
    for (const it of items) {
      const when = it.updated ? new Date(it.updated).toLocaleString() : it.stamp;
      list.append(el('div', { class: 'hist-row' },
        el('span', {}, when),
        el('span', { class: 'muted small' },
          `${it.name ?? '?'} · ${it.blocks ?? 0} block${it.blocks === 1 ? '' : 's'}`),
        el('span', { class: 'spacer' }),
        el('button', {
          class: 'ghost small',
          onclick: async () => {
            if (!confirm(`Restore the version from ${when}?\n\nThe current version is saved to history first, so nothing is lost.`)) return;
            try {
              await flushSaves();
              const res = await api.restoreEntityVersion(e.id, it.stamp);
              replaceEntity(res.entity);
              overlay.remove();
              rerender();
              toast('Version restored — the previous state is in history');
            } catch (err) { toast('Restore failed: ' + err.message); }
          },
        }, 'Restore')));
    }
    overlay.append(el('div', { class: 'dialog' },
      el('h3', {}, `⏳ History — ${e.name}`),
      list,
      el('div', { class: 'row', style: 'margin-top:12px' },
        el('span', { class: 'muted small' }, 'Daily whole-world snapshots also live in data/.snapshots.'),
        el('span', { class: 'spacer' }),
        el('button', { onclick: () => overlay.remove() }, 'Close'))));
    document.body.append(overlay);
  }

  // ---------- timeline date ----------
  const dateWrap = el('div', {});
  function refreshDate() {
    dateWrap.innerHTML = '';
    if (readOnly) {
      if (e.date?.year != null) {
        dateWrap.append(el('div', { class: 'small muted' }, `📅 ${formatWorldDate(e.date)}`));
      }
      return;
    }
    if (!e.date) {
      dateWrap.append(el('button', {
        class: 'ghost small',
        onclick: () => { e.date = { year: new Date().getFullYear() }; save(); refreshDate(); },
      }, '+ Add to timeline'));
      return;
    }
    const num = (key, ph, width = 70) => el('input', {
      type: 'number', value: e.date[key] ?? '', placeholder: ph, style: `width:${width}px`,
      oninput: (ev) => {
        const v = ev.target.value;
        e.date[key] = v === '' ? null : Number(v);
        save();
      },
    });
    dateWrap.append(el('div', { class: 'row small' },
      el('span', { class: 'muted' }, '📅 Year'), num('year', 'year', 84),
      el('span', { class: 'muted' }, 'Month'), num('month', '–', 56),
      el('span', { class: 'muted' }, 'Day'), num('day', '–', 56),
      el('span', { class: 'muted' }, 'until year'), num('endYear', '–', 84),
      el('span', { class: 'muted' }, formatWorldDate(e.date)),
      el('button', { class: 'ghost small', onclick: () => { e.date = null; save(); refreshDate(); } }, 'Remove from timeline')));
  }
  refreshDate();

  // ---------- portrait ----------
  const portrait = el('div', { class: 'portrait-box' });
  function refreshPortrait() {
    portrait.innerHTML = '';
    if (e.image) {
      portrait.append(el('img', { src: api.assetUrl(state.worldId, e.image), alt: e.name }));
      if (!readOnly) {
        portrait.append(el('div', { class: 'portrait-actions' },
          el('button', { class: 'ghost small', onclick: pickImage }, 'Change'),
          el('button', { class: 'ghost small danger', onclick: () => { e.image = null; save(); refreshPortrait(); } }, 'Remove')));
      }
    } else if (!readOnly) {
      portrait.append(el('button', { class: 'ghost small', title: 'Attach a portrait or illustration — shown here and in PDF exports', onclick: pickImage }, '+ 🖼 Image'));
    }
  }
  function pickImage() {
    const input = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif' });
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      if (file.size > 8 * 1024 * 1024) { toast('Image too large (max 8 MB)'); return; }
      try {
        const b64 = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result).split(',')[1]);
          r.onerror = reject;
          r.readAsDataURL(file);
        });
        const res = await api.uploadAsset(`${e.id}-${file.name}`, b64);
        e.image = res.file;
        save();
        refreshPortrait();
        toast('Image attached');
      } catch (err) {
        toast('Upload failed: ' + err.message);
      }
    });
    input.click();
  }
  refreshPortrait();

  // ---------- blocks ----------
  const blocksWrap = el('div', { class: 'blocks' });

  function blockContentHtml(b) {
    if (b.kind === 'statblock') return statblockHtml(b.stat, e.name);
    if (b.kind === 'encounter') return encounterHtml(b);
    if (b.kind === 'heading') return `<h3>${mdToHtml(b.text).replace(/^<p>|<\/p>$/g, '')}</h3>`;
    if (b.kind === 'quote') return `<blockquote>${mdToHtml(b.text).replace(/^<p>|<\/p>$/g, '')}</blockquote>`;
    return mdToHtml(b.text) || '<p class="muted">Click to write… ([[links]], **bold**, - lists)</p>';
  }

  function encounterHtml(b) {
    const enc = b.enc || defaultEncounter();
    const c = computeEncounter(enc, getEntity);
    const rows = c.rows.map((r) => `<tr>
      <td style="width:44px">${r.count}×</td>
      <td>${r.entity ? `<a href="#/e/${esc(r.entity.id)}">${esc(r.displayName)}</a>` : esc(r.displayName)}</td>
      <td style="width:70px" class="muted">CR ${esc(r.cr)}</td>
      <td style="width:90px;text-align:right">${(r.xpEach * r.count).toLocaleString()} XP</td>
    </tr>`).join('');
    return `<div class="encounter">
      <div class="enc-title">💀 Encounter <span class="enc-chip" style="background:${DIFFICULTY_COLORS[c.difficulty]}">${c.difficulty}</span></div>
      ${c.rows.length ? `<table>${rows}</table>` : '<div class="muted small">Click to add monsters.</div>'}
      <div class="enc-summary">
        <span><b>${c.totalXp.toLocaleString()}</b> XP (×${c.multiplier} = <b>${c.adjustedXp.toLocaleString()}</b> adjusted)</span>
        <span>party of ${enc.partySize} · level ${enc.partyLevel}</span>
        <span>easy ${c.party.easy.toLocaleString()} · medium ${c.party.medium.toLocaleString()} · hard ${c.party.hard.toLocaleString()} · deadly ${c.party.deadly.toLocaleString()}</span>
      </div>
    </div>`;
  }

  function openEditor(b, blockNode) {
    if (b.kind === 'statblock') editStatblock(b, blockNode);
    else if (b.kind === 'encounter') editEncounter(b, blockNode);
    else editBlock(b, blockNode);
  }

  // --- encounter editor ---
  function editEncounter(b, blockNode) {
    const enc = (b.enc ??= defaultEncounter());
    const form = el('div', { class: 'enc-form sb-form' });

    const candidates = () => visibleEntities()
      .filter((x) => x.blocks?.some((bl) => bl.kind === 'statblock') || ['creature', 'npc'].includes(x.type))
      .sort((a, b2) => a.name.localeCompare(b2.name));

    const rowsWrap = el('div', {});
    function refreshRows() {
      rowsWrap.innerHTML = '';
      (enc.rows ??= []).forEach((row, i) => {
        const manual = !row.to;
        rowsWrap.append(el('div', { class: 'enc-row' },
          el('input', {
            class: 'cnt', type: 'number', min: 1, value: row.count || 1,
            oninput: (ev) => { row.count = Number(ev.target.value) || 1; save(); },
          }),
          el('select', {
            onchange: (ev) => { row.to = ev.target.value || null; save(); refreshRows(); },
          },
            el('option', { value: '' }, '— manual entry —'),
            candidates().map((x) => el('option', { value: x.id, selected: x.id === row.to }, x.name))),
          manual ? el('input', {
            class: 'manual', placeholder: 'Name', value: row.name || '',
            oninput: (ev) => { row.name = ev.target.value; save(); },
          }) : null,
          manual ? el('input', {
            class: 'cnt', placeholder: 'CR', value: row.cr || '', title: 'Challenge rating, e.g. 1/4 or 5',
            oninput: (ev) => { row.cr = ev.target.value; save(); },
          }) : null,
          el('button', { class: 'ghost', onclick: () => { enc.rows.splice(i, 1); save(); refreshRows(); } }, '✕')));
      });
      rowsWrap.append(el('button', {
        class: 'ghost small',
        onclick: () => { enc.rows.push({ to: null, name: '', cr: '', count: 1 }); save(); refreshRows(); },
      }, '+ Add monster'));
    }
    refreshRows();

    form.append(
      el('div', { class: 'fr' },
        el('label', {}, 'Party'),
        el('input', { type: 'number', min: 1, max: 10, value: enc.partySize, oninput: (ev) => { enc.partySize = Number(ev.target.value) || 4; save(); } }),
        el('span', { class: 'muted small' }, 'characters of level'),
        el('input', { type: 'number', min: 1, max: 20, value: enc.partyLevel, oninput: (ev) => { enc.partyLevel = Number(ev.target.value) || 1; save(); } })),
      rowsWrap,
      el('div', { class: 'row', style: 'margin-top:10px' },
        el('button', { class: 'primary', onclick: () => { save(); refreshBlocks(); } }, 'Done'),
        el('span', { class: 'muted small' }, 'CR is read from each entry’s statblock; manual rows take any CR.')));

    const content = blockNode.querySelector('.block-content');
    content.replaceWith(el('div', { class: 'block-content' }, form));
  }

  // --- plain text editor with [[ autocomplete ---
  function editBlock(b, blockNode) {
    const ta = el('textarea', { spellcheck: 'false' });
    ta.value = b.text || '';
    const content = blockNode.querySelector('.block-content');
    const holder = el('div', { class: 'block-content' }, ta);
    content.replaceWith(holder);
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.max(60, ta.scrollHeight + 4) + 'px'; };
    grow();
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    // [[wiki-link]] autocomplete
    let ac = null, acItems = [], acIndex = 0, acRange = null;
    const closeAc = () => { ac?.remove(); ac = null; acItems = []; };
    const renderAc = () => {
      ac.innerHTML = '';
      acItems.forEach((c, i) => {
        const item = el('div', { class: `ac-item${i === acIndex ? ' sel' : ''}` },
          el('span', { class: 'dot', style: `background:${typeOf(c).color}` }), c.name);
        item.addEventListener('pointerdown', (ev) => { ev.preventDefault(); pickAc(i); });
        ac.append(item);
      });
      ac.append(el('div', { class: 'ac-hint' }, '↑↓ choose · Enter or Tab to insert · Esc to dismiss'));
    };
    const updateAc = () => {
      const pos = ta.selectionStart;
      const m = ta.value.slice(0, pos).match(/\[\[([^\][\n|]*)$/);
      if (!m) return closeAc();
      const q = m[1].toLowerCase();
      const starts = (x) => x.name.toLowerCase().startsWith(q) ? 0 : 1;
      const cands = visibleEntities()
        .filter((x) => x.id !== e.id && x.name.toLowerCase().includes(q))
        .sort((a, b) => starts(a) - starts(b) || a.name.localeCompare(b.name))
        .slice(0, 8);
      if (!cands.length) return closeAc();
      acItems = cands;
      acIndex = Math.min(acIndex, cands.length - 1);
      acRange = { start: pos - m[1].length, end: pos };
      if (!ac) { ac = el('div', { class: 'wl-autocomplete' }); holder.append(ac); }
      renderAc();
    };
    const pickAc = (i) => {
      const c = acItems[i];
      if (!c) return;
      const after = ta.value.slice(acRange.end);
      const alreadyClosed = after.startsWith(']]');
      ta.value = ta.value.slice(0, acRange.start) + c.name + (alreadyClosed ? '' : ']]') + after;
      const newPos = acRange.start + c.name.length + 2;
      ta.setSelectionRange(newPos, newPos);
      b.text = ta.value;
      save();
      closeAc();
      grow();
      ta.focus();
    };

    ta.addEventListener('input', () => {
      grow();
      b.text = ta.value; // save as you type (debounced) so nothing is ever lost
      save();
      updateAc();
    });
    ta.addEventListener('keydown', (ev) => {
      if (ac) {
        if (ev.key === 'ArrowDown') { ev.preventDefault(); acIndex = (acIndex + 1) % acItems.length; renderAc(); return; }
        if (ev.key === 'ArrowUp') { ev.preventDefault(); acIndex = (acIndex - 1 + acItems.length) % acItems.length; renderAc(); return; }
        if (ev.key === 'Enter' || ev.key === 'Tab') { ev.preventDefault(); pickAc(acIndex); return; }
        if (ev.key === 'Escape') { ev.preventDefault(); closeAc(); return; }
      }
      if (ev.key === 'Escape') ta.blur();
    });
    ta.addEventListener('blur', () => {
      b.text = ta.value;
      save();
      refreshBlocks();
      refreshBacklinksSoon();
    });
  }

  // --- statblock editor ---
  function editStatblock(b, blockNode) {
    const s = (b.stat ??= defaultStat(e.name));
    const form = el('div', { class: 'sb-form' });

    // start from a bundled SRD monster (e.g. base a guard captain on "Veteran")
    const bestiaryWrap = el('div', { style: 'margin-bottom:8px' });
    bestiaryWrap.append(el('button', {
      class: 'ghost small', title: 'Copy stats from one of the 322 bundled SRD monsters — your custom name is kept',
      onclick: async (ev) => {
        ev.preventDefault();
        let data;
        try { data = await loadBundledBestiary(); } catch { toast('Bundled bestiary not available'); return; }
        bestiaryWrap.innerHTML = '';
        const results = el('div', { class: 'wl-autocomplete', style: 'max-width:100%' });
        const search = el('input', {
          placeholder: 'Search 322 SRD monsters…', style: 'width:100%',
          oninput: () => {
            const q = search.value.trim().toLowerCase();
            results.innerHTML = '';
            if (!q) return;
            for (const mon of data.monster.filter((m) => m.name.toLowerCase().includes(q)).slice(0, 9)) {
              const cr = typeof mon.cr === 'object' ? mon.cr?.cr : mon.cr;
              const item = el('div', { class: 'ac-item' },
                el('span', {}, mon.name),
                el('span', { class: 'muted small', style: 'margin-left:auto' }, `CR ${cr ?? '?'}`));
              item.addEventListener('pointerdown', (pev) => {
                pev.preventDefault();
                const keepName = s.name?.trim();
                b.stat = monsterToStat(mon);
                if (keepName) b.stat.name = keepName; // it's your NPC, wearing the monster's stats
                save();
                editStatblock(b, blockNode);
                toast(`Loaded ${mon.name} stats`);
              });
              results.append(item);
            }
          },
        });
        bestiaryWrap.append(search, results);
        search.focus();
      },
    }, '📖 From bestiary…'));

    const fr = (label, key, placeholder = '') => el('div', { class: 'fr' },
      el('label', {}, label),
      el('input', {
        value: s[key] ?? '', placeholder,
        oninput: (ev) => { s[key] = ev.target.value; save(); },
      }));

    const abilityRow = el('div', { class: 'sb-abrow' },
      ABILITIES.map((a) => el('div', { class: 'cell' },
        el('label', {}, a),
        el('input', {
          type: 'number', value: s[a] ?? 10,
          oninput: (ev) => { s[a] = Number(ev.target.value) || 0; save(); },
        }))));

    function listEditor(listRef, key, opts) {
      const wrap = el('div', {});
      const rebuild = () => {
        wrap.innerHTML = '';
        wrap.append(el('h4', {}, opts.heading));
        (s[key] ??= []).forEach((row, i) => {
          const nameInput = el('input', {
            value: row[opts.nameKey] ?? '', placeholder: opts.namePh,
            oninput: (ev) => { row[opts.nameKey] = ev.target.value; save(); },
          });
          const textInput = opts.textarea
            ? el('textarea', { oninput: (ev) => { row[opts.textKey] = ev.target.value; save(); } })
            : el('input', {
                value: row[opts.textKey] ?? '', placeholder: opts.textPh, style: 'flex:1;width:auto',
                oninput: (ev) => { row[opts.textKey] = ev.target.value; save(); },
              });
          if (opts.textarea) textInput.value = row[opts.textKey] ?? '';
          wrap.append(el('div', { class: 'entry-row' },
            nameInput, textInput,
            el('button', { class: 'ghost', onclick: () => { s[key].splice(i, 1); save(); rebuild(); } }, '✕')));
        });
        wrap.append(el('button', {
          class: 'ghost small',
          onclick: () => { s[key].push({ [opts.nameKey]: '', [opts.textKey]: '' }); save(); rebuild(); },
        }, opts.addLabel));
      };
      rebuild();
      return wrap;
    }

    form.append(
      bestiaryWrap,
      fr('Name', 'name', e.name),
      fr('Type line', 'meta', 'Medium humanoid, any alignment'),
      fr('Armor Class', 'ac'),
      fr('Hit Points', 'hp'),
      fr('Speed', 'speed'),
      abilityRow,
      listEditor(s, 'vitals', { heading: 'Detail lines (skills, senses, languages, CR…)', nameKey: 'k', textKey: 'v', namePh: 'Label', textPh: 'Value', textarea: false, addLabel: '+ Add line' }),
      listEditor(s, 'traits', { heading: 'Traits', nameKey: 'name', textKey: 'text', namePh: 'Trait name', textarea: true, addLabel: '+ Add trait' }),
      listEditor(s, 'actions', { heading: 'Actions', nameKey: 'name', textKey: 'text', namePh: 'Action name', textarea: true, addLabel: '+ Add action' }),
      el('div', { class: 'row', style: 'margin-top:10px' },
        el('button', { class: 'primary', onclick: () => { save(); refreshBlocks(); } }, 'Done'),
        el('span', { class: 'muted small' }, 'Changes save automatically.')));

    const content = blockNode.querySelector('.block-content');
    content.replaceWith(el('div', { class: 'block-content' }, form));
  }

  function refreshBlocks() {
    blocksWrap.innerHTML = '';
    // players never see secrets; empty scaffold blocks — and headings whose
    // whole section is empty — are edit-mode only
    const hasContent = (b) => b.kind === 'statblock' || b.kind === 'encounter' || b.text?.trim();
    let list = e.blocks;
    if (readOnly) {
      const shown = e.blocks.filter((b) => !b.secret);
      list = shown.filter((b, i) => {
        if (b.kind !== 'heading') return hasContent(b);
        for (let j = i + 1; j < shown.length && shown[j].kind !== 'heading'; j++) {
          if (hasContent(shown[j])) return true;
        }
        return false;
      });
    }
    for (const b of list) {
      const idx = e.blocks.indexOf(b);
      const node = el('div', { class: `block${b.secret ? ' secret' : ''}` });
      if (!readOnly) {
        node.append(el('div', { class: 'bctrl' },
          el('button', {
            class: b.secret ? 'on' : '', title: b.secret ? 'Secret: visible only to you (GM). Click to reveal to players.' : 'Make this block a GM secret',
            onclick: () => { b.secret = !b.secret; save(); refreshBlocks(); },
          }, '🔒'),
          b.kind === 'statblock' || b.kind === 'encounter' ? null : el('button', {
            title: 'Cycle style: text → heading → quote',
            onclick: () => {
              b.kind = b.kind === 'text' ? 'heading' : b.kind === 'heading' ? 'quote' : 'text';
              save(); refreshBlocks();
            },
          }, '¶'),
          el('button', { title: 'Move up', onclick: () => { moveBlock(idx, -1); } }, '↑'),
          el('button', { title: 'Move down', onclick: () => { moveBlock(idx, +1); } }, '↓'),
          el('button', {
            title: 'Delete block', onclick: () => {
              const hasContent = b.kind === 'statblock' || b.kind === 'encounter' || b.text?.trim();
              if (hasContent && !confirm('Delete this block?')) return;
              e.blocks.splice(idx, 1);
              save(); refreshBlocks();
            },
          }, '✕')));
      }
      const content = el('div', { class: 'block-content' });
      content.innerHTML = blockContentHtml(b);
      if (!readOnly) {
        content.addEventListener('click', (ev) => {
          if (ev.target.closest('a')) return; // let links navigate
          openEditor(b, node);
        });
      }
      node.append(content);
      blocksWrap.append(node);
    }
    if (!readOnly) {
      blocksWrap.append(el('div', { class: 'add-block-row' },
        el('button', { class: 'ghost', onclick: () => addBlock({ kind: 'text' }) }, '+ Text'),
        el('button', { class: 'ghost', onclick: () => addBlock({ kind: 'heading' }) }, '+ Heading'),
        el('button', { class: 'ghost', onclick: () => addBlock({ kind: 'quote' }) }, '+ Quote'),
        el('button', { class: 'ghost', title: 'A classic monster/NPC statblock — editable, exports to PDF', onclick: () => addBlock({ kind: 'statblock' }) }, '+ ⚔ Statblock'),
        el('button', {
          class: 'ghost', title: 'Encounter with XP budget and difficulty math — starts as a GM secret',
          onclick: () => addBlock({ kind: 'encounter', secret: true }),
        }, '+ 💀 Encounter'),
        el('button', {
          style: 'border-color:var(--secret-border);color:#cbb3ef',
          onclick: () => addBlock({ kind: 'text', secret: true }),
        }, '+ 🔒 Secret block')));
    }
  }

  function addBlock({ kind, secret = false }) {
    const b = { id: uid(), kind, text: '', secret };
    if (kind === 'statblock') b.stat = defaultStat(e.name);
    if (kind === 'encounter') b.enc = defaultEncounter();
    e.blocks.push(b);
    save();
    refreshBlocks();
    openEditor(b, blocksWrap.children[e.blocks.length - 1]);
  }

  function moveBlock(idx, dir) {
    const j = idx + dir;
    if (j < 0 || j >= e.blocks.length) return;
    [e.blocks[idx], e.blocks[j]] = [e.blocks[j], e.blocks[idx]];
    save(); refreshBlocks();
  }
  refreshBlocks();

  // ---------- relations ----------
  const relWrap = el('div', {});
  function refreshRelations() {
    relWrap.innerHTML = '';
    const rels = readOnly ? (e.relations || []).filter((r) => !r.secret) : (e.relations || []);
    if (readOnly) {
      for (const r of rels) {
        const target = getEntity(r.to);
        if (!target || target.gmOnly) continue;
        relWrap.append(el('div', { class: 'rel-view' },
          el('span', { class: 'muted' }, `${r.label} → `),
          el('a', { href: `#/e/${target.id}` }, target.name)));
      }
      if (!relWrap.children.length) relWrap.append(el('div', { class: 'muted small' }, 'No relations.'));
      return;
    }
    const options = () => visibleEntities()
      .filter((x) => x.id !== e.id)
      .sort((a, b) => a.name.localeCompare(b.name));
    (e.relations ??= []).forEach((r, i) => {
      relWrap.append(el('div', { class: 'rel-row' },
        el('input', {
          class: 'rel-label', value: r.label || '', placeholder: 'relationship (e.g. rules, ally of)',
          oninput: (ev) => { r.label = ev.target.value; save(); },
        }),
        el('select', { onchange: (ev) => { r.to = ev.target.value; save(); refreshBacklinksSoon(); } },
          el('option', { value: '' }, '— choose target —'),
          options().map((x) => el('option', { value: x.id, selected: x.id === r.to }, `${x.name} (${typeOf(x).label})`))),
        el('label', { class: 'rel-secret', title: 'Secret relations are hidden from players and player exports' },
          el('input', {
            type: 'checkbox', checked: !!r.secret,
            onchange: (ev) => { r.secret = ev.target.checked; save(); },
          }), '🔒 secret'),
        el('button', { class: 'ghost', onclick: () => { e.relations.splice(i, 1); save(); refreshRelations(); } }, '✕')));
    });
    relWrap.append(el('button', {
      class: 'ghost small',
      onclick: () => { e.relations.push({ to: '', label: '', secret: false }); refreshRelations(); },
    }, '+ Add relation'));
  }
  refreshRelations();

  // ---------- backlinks ----------
  const backWrap = el('div', {});
  function refreshBacklinks() {
    backWrap.innerHTML = '';
    const links = backlinksFor(e.id);
    // maps whose markers or placed stamps point at this entry
    const mapRefs = [];
    for (const src of visibleEntities()) {
      if (src.id === e.id) continue;
      for (const mk of [...(src.map?.markers || []), ...(src.map?.stamps || [])]) {
        if (mk.to !== e.id || (mk.secret && !state.gm)) continue;
        mapRefs.push({ src, secret: !!mk.secret });
        break; // one line per map even with several references
      }
    }
    if (!links.length && !mapRefs.length) {
      backWrap.append(el('div', { class: 'muted small' }, 'Nothing links here yet. Mention this entry as [[', e.name, ']] elsewhere and it will show up.'));
      return;
    }
    for (const bl of links) {
      backWrap.append(el('div', { class: 'backlink-item' },
        el('span', { class: 'dot', style: `background:${typeOf(bl.entity).color};margin-right:8px` }),
        el('a', { href: `#/e/${bl.entity.id}` }, bl.entity.name),
        el('span', { class: 'muted' }, bl.via === 'mention' ? ' — mentions this entry' : ` — ${bl.label || 'related'}`),
        bl.secret ? el('span', { class: 'rel-secret-mark' }, '🔒') : null));
    }
    for (const { src, secret } of mapRefs) {
      backWrap.append(el('div', { class: 'backlink-item' },
        el('span', { style: 'margin-right:6px' }, '📍'),
        el('a', { href: `#/map/${src.id}` }, `Marked on the map of ${src.name}`),
        secret ? el('span', { class: 'rel-secret-mark' }, '🔒') : null));
    }
  }
  const refreshBacklinksSoon = debounce(refreshBacklinks, 900);
  refreshBacklinks();

  // ---------- map ----------
  const mapWrap = el('div', {});
  function refreshMap() {
    mapWrap.innerHTML = '';
    if (e.map) {
      const thumb = el('canvas', { style: 'width:100%;border-radius:6px;cursor:pointer', title: 'Open map editor' });
      setTimeout(() => renderThumbnail(thumb, e.map, 760, { gm: state.gm }), 0);
      thumb.addEventListener('click', () => { location.hash = `#/map/${e.id}`; });
      mapWrap.append(thumb,
        el('div', { class: 'row', style: 'margin-top:8px' },
          el('a', { href: `#/map/${e.id}` }, readOnly ? 'View map' : '✏️ Open map editor'),
          el('span', { class: 'spacer' }),
          readOnly ? null : el('button', {
            class: 'ghost danger small',
            onclick: () => {
              if (!confirm('Remove this map from the entry? The generated terrain can be recreated from its seed, but markers and edits will be lost.')) return;
              e.map = null; save(); refreshMap();
            },
          }, 'Remove map')));
    } else if (!readOnly) {
      mapWrap.append(el('div', { class: 'row' },
        Object.entries(MAP_KINDS).map(([kind, def]) =>
          el('button', {
            onclick: () => {
              e.map = newMap(kind);
              save();
              location.hash = `#/map/${e.id}`;
            },
          }, `+ ${def.label}`))));
    }
  }
  refreshMap();

  // ---------- assemble ----------
  function card(titleText, node, extra) {
    return el('div', { class: 'card' }, el('h3', {}, titleText, extra || ''), node);
  }

  container.append(el('div', { class: 'page' },
    readOnly ? el('div', { class: 'notice', style: 'margin-bottom:14px' },
      '👁 Player preview — secrets and GM-only content are hidden. Toggle GM view in the top bar to edit.') : null,
    el('div', { class: 'ent-head ent-head-row' },
      el('div', { class: 'ent-head-main' }, title, meta, dateWrap),
      (e.image || !readOnly) ? portrait : null),
    el('hr', { class: 'soft' }),
    blocksWrap,
    el('hr', { class: 'soft' }),
    card('Details', fieldsWrap, readOnly ? null
      : helpTip('Quick facts, shown here and in exports. Blank fields stay hidden; ✕ hides a field you don’t need.')),
    card('Relations', relWrap),
    (e.map || !readOnly) ? card('Map', mapWrap) : null,
    card('Backlinks', backWrap)));

  function rerender() {
    container.innerHTML = '';
    render(container, id);
  }
}
