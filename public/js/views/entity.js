// Entity page: title/type/tags, custom fields, block editor with per-block GM
// secrets and editable statblocks, timeline date, typed relations, backlinks,
// and an attached map. QoL: [[link]] autocomplete, rename updates mentions.

import { el, uid, esc, toast, debounce, helpTip } from '../util.js';
import {
  state, types, typeOf, getEntity, visibleEntities,
  saveEntity, scheduleSave, deleteEntity, duplicateEntity,
  replaceEntity, flushSaves,
} from '../state.js';
import { mdToHtml, backlinksFor } from '../render.js';
import { slotsOf, formatDate, formatYear, isHistoric, isRecurring } from '../calendar.js';
import { newMap, MAP_KINDS, renderThumbnail } from '../maps/mapcore.js';
import { defaultStat, statblockHtml, ABILITIES } from '../statblock.js';
import { defaultEncounter, computeEncounter, DIFFICULTY_COLORS } from '../encounter.js';
import { monsterToStat, loadBundledBestiary } from '../importers.js';
import { SHEET_SYSTEMS, handleSheetClick } from '../sheets/sheetcore.js';
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

// What to call a block in the "deleted" toast, so the Undo button says what it
// would bring back.
const BLOCK_NOUN = {
  text: 'Block', heading: 'Heading', quote: 'Quote',
  statblock: '⚔ Statblock', encounter: '💀 Encounter', sheet: '🎭 Character sheet',
};

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

  // ---------- single-step undo ----------
  // Deleting a block, a relation or a quick fact is instant and unconfirmed;
  // the safety net is the Undo button on the toast. Only one undo can be
  // pending: the toast helper shows one message at a time, so a newer deletion
  // takes the older button away with it.
  // The two guards matter because that button outlives this render. It must not
  // fire against a page that has been navigated away from or re-rendered (`e`
  // would then be a stale twin of the cached entity and saving it would clobber
  // newer edits), nor after a world switch (it would write this entry into the
  // wrong world).
  let pendingUndo = null;
  function offerUndo(msg, restore) {
    const token = { worldId: state.worldId };
    pendingUndo = token;
    toast(msg, 9000, {
      label: 'Undo',
      onAction: () => {
        if (pendingUndo !== token) return;
        pendingUndo = null;
        if (!blocksWrap.isConnected || state.worldId !== token.worldId) {
          toast('That undo has expired — check ⏳ History on the entry instead.', 4000);
          return;
        }
        restore();
        save();
      },
    });
  }

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
      ? [el('a', {
            class: 'type-badge', href: `#/t/${encodeURIComponent(e.type || '')}`,
            title: `Open the ${t().plural || t().label} page`,
          },
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
            // Restore exactly this one field at its original position — never a
            // whole-object snapshot. The undo window is long enough to edit
            // another field in, and swapping the snapshot back would silently
            // discard that edit and then persist the loss.
            const wasSuggested = suggested.includes(key);
            const prevValue = e.fields?.[key];
            const prevIndex = Object.keys(e.fields || {}).indexOf(key);
            const addedHidden = wasSuggested && !hidden.has(key);
            if (e.fields) delete e.fields[key];
            if (addedHidden) (e.hiddenFields ??= []).push(key);
            save(); refreshFields();
            offerUndo(wasSuggested ? `“${key}” hidden.` : `“${key}” removed.`, () => {
              // rebuild so the key lands back at its old display index while
              // every other field keeps whatever it holds right now
              const rest = Object.entries(e.fields || {}).filter(([k]) => k !== key);
              const at = prevIndex < 0 ? rest.length : Math.min(prevIndex, rest.length);
              rest.splice(at, 0, [key, prevValue]);
              e.fields = Object.fromEntries(rest);
              if (addedHidden && Array.isArray(e.hiddenFields)) {
                e.hiddenFields = e.hiddenFields.filter((k) => k !== key);
              }
              refreshFields();
            });
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
  // Dates are shaped { year?, month?, day?, special?, endYear?, recurs? } and
  // every field is optional. `month` is a POSITION in world.calendar.months (its
  // meaning is unchanged from 0.8); `special` names an intercalary day instead
  // and the two are mutually exclusive; `recurs: 'annual'` means the event comes
  // round every year and therefore has NO year at all.
  const dateWrap = el('div', {});
  const calOf = () => state.world?.calendar;
  const eraOf = () => state.world?.era || '';
  // Remembered across a recurring toggle so unticking the box restores the year
  // the entry had rather than inventing one.
  let lastYear = Number.isFinite(e.date?.year) ? e.date.year : null;

  /**
   * A believable in-world year for a brand new date. NEVER the real-world year:
   * seeding 2026 into a homebrew setting was the old behaviour and it is
   * nonsense in every world this app is for.
   */
  function defaultYear() {
    const cal = calOf();
    if (Number.isFinite(cal?.todayDate?.year)) return cal.todayDate.year;
    const ages = (cal?.ages || []).filter((a) => Number.isFinite(a.startYear));
    if (ages.length) return Math.max(...ages.map((a) => a.startYear));
    const years = [...state.entities.values()].filter((x) => isHistoric(x.date)).map((x) => x.date.year);
    if (years.length) return Math.max(...years);
    return 1;
  }

  function refreshDate() {
    dateWrap.innerHTML = '';
    const cal = calOf(), era = eraOf();
    if (readOnly) {
      // Was `e.date?.year != null`, which silently hid recurring dates (they have
      // no year by design). The formatted string is the honest test.
      const shown = formatDate(e.date, cal, era);
      if (shown) dateWrap.append(el('div', { class: 'small muted' }, `📅 ${shown}`));
      return;
    }
    if (!e.date) {
      dateWrap.append(el('button', {
        class: 'ghost small',
        title: 'Put this entry on the timeline with an in-world date',
        onclick: () => { e.date = { year: defaultYear() }; lastYear = e.date.year; save(); refreshDate(); },
      }, '+ Add to timeline'));
      return;
    }

    const d = e.date;
    const recurs = isRecurring(d);
    const slots = slotsOf(cal);
    const slotOf = () => (d.special
      ? slots.find((s) => s.kind === 'special' && s.id === d.special)
      : (d.month ? slots.find((s) => s.kind === 'month' && s.month === d.month) : null));

    const readout = el('span', { class: 'cal-preview' });
    const hint = el('div', { class: 'small muted date-hint' });

    function refreshReadout() {
      const main = formatDate(d, cal, era);
      const tail = !isRecurring(d) && d.endYear ? ` – ${formatYear(d.endYear, cal, era)}` : '';
      readout.textContent = main ? main + tail : '—';
    }

    /**
     * Soft warnings only. NO CLAMP: a day past the end of its month is kept and
     * shown exactly as written — month lengths are declared long after dates are.
     */
    function refreshHint() {
      hint.textContent = '';
      if (!recurs && !Number.isFinite(d.year)) {
        hint.textContent = 'Give it a year, or tick “Repeats every year” — until then it stays off the timeline.';
        return;
      }
      const slot = slotOf();
      if (slot && Number.isFinite(d.day) && d.day > slot.days) {
        hint.textContent = `${slot.name || 'This month'} is ${slot.days} day${slot.days === 1 ? '' : 's'} long. The date is kept exactly as written.`;
      }
    }

    // min/step/max are set BEFORE value — a number input snaps to the default
    // step otherwise (same gotcha as the range inputs in the map editor).
    const yearInput = el('input', {
      type: 'number', step: 1, value: Number.isFinite(d.year) ? d.year : '',
      placeholder: 'year', style: 'width:84px',
      title: 'The year, counted from the start of the world. Ages only change how it prints — they never restart the numbering.',
      oninput: (ev) => {
        const raw = ev.target.value.trim();
        const v = Math.round(Number(raw));
        if (raw === '' || !Number.isFinite(v)) delete d.year;
        else { d.year = v; lastYear = v; }
        save(); refreshReadout(); refreshHint();
      },
    });

    function slotSelect() {
      const sel = el('select', {
        style: 'max-width:190px',
        title: 'Which month — or which day that belongs to no month',
        // rebuilds the whole row: the day bound depends on the slot
        onchange: (ev) => {
          const v = ev.target.value;
          if (!v) { delete d.month; delete d.special; }
          else if (v.startsWith('m:')) { d.month = Number(v.slice(2)); delete d.special; }
          else { d.special = v.slice(2); delete d.month; }
          save(); refreshDate();
        },
      }, el('option', { value: '' }, '— no month —'),
        slots.map((s) => (s.kind === 'month'
          ? el('option', { value: `m:${s.month}` }, s.name || `Month ${s.month}`)
          : el('option', { value: `s:${s.id}` }, `${s.name || s.id} (special day)`))));
      const want = d.special ? `s:${d.special}` : (d.month ? `m:${d.month}` : '');
      // A month or special day the calendar no longer declares keeps its own
      // option instead of being silently reset to "none" — no clamp, ever.
      if (want && ![...sel.options].some((o) => o.value === want)) {
        sel.append(el('option', { value: want },
          d.special ? `${d.special} (not in the calendar)` : `Month ${d.month}`));
      }
      sel.value = want;
      return sel;
    }

    /**
     * The 0.8 control, kept for a world that has not named its months yet.
     * Without it the select would offer nothing but "— no month —" and those
     * GMs would silently lose the ability to date anything by month at all.
     */
    function monthNumber() {
      return el('input', {
        type: 'number', min: 1, step: 1, value: d.month ?? '', placeholder: 'month', style: 'width:70px',
        title: 'Month number. Name your months on the Calendar page and this becomes a list.',
        oninput: (ev) => {
          const raw = ev.target.value.trim();
          const v = Math.round(Number(raw));
          if (raw === '' || !Number.isFinite(v) || v < 1) delete d.month; else d.month = v;
          delete d.special;
          save(); refreshReadout(); refreshHint();
        },
      });
    }
    const monthCtl = slots.length ? slotSelect() : monthNumber();

    const slotNow = slotOf();
    const dayInput = el('input', {
      type: 'number', min: 1, ...(slotNow ? { max: slotNow.days } : {}), step: 1,
      value: Number.isFinite(d.day) ? d.day : '', placeholder: 'day', style: 'width:64px',
      title: slotNow ? `Day of ${slotNow.name || 'the month'} (${slotNow.days} long)` : 'Day of the month',
      oninput: (ev) => {
        const raw = ev.target.value.trim();
        const v = Math.round(Number(raw));
        if (raw === '' || !Number.isFinite(v) || v < 1) delete d.day; else d.day = v;
        save(); refreshReadout(); refreshHint();
      },
    });

    const endInput = el('input', {
      type: 'number', step: 1, value: Number.isFinite(d.endYear) ? d.endYear : '',
      placeholder: '–', style: 'width:84px',
      title: 'For something that lasted — a war, a reign. Leave empty for a single date.',
      oninput: (ev) => {
        const raw = ev.target.value.trim();
        const v = Math.round(Number(raw));
        if (raw === '' || !Number.isFinite(v)) delete d.endYear; else d.endYear = v;
        save(); refreshReadout();
      },
    });

    const recurBox = el('input', {
      type: 'checkbox', checked: recurs,
      onchange: (ev) => {
        if (ev.target.checked) {
          if (Number.isFinite(d.year)) lastYear = d.year;
          d.recurs = 'annual';
          delete d.year;      // a recurring date has no year, by definition
          delete d.endYear;   // ...so it cannot span years either
        } else {
          delete d.recurs;
          d.year = Number.isFinite(lastYear) ? lastYear : defaultYear();
        }
        save(); refreshDate();
      },
    });

    refreshReadout();
    refreshHint();

    dateWrap.append(el('div', { class: 'row small date-edit' },
      el('span', { class: 'muted' }, recurs ? '📅' : '📅 Year'),
      recurs ? null : yearInput,
      monthCtl,
      dayInput,
      recurs ? null : el('span', { class: 'muted' }, 'until year'),
      recurs ? null : endInput,
      el('label', { class: 'row small', style: 'gap:5px;cursor:pointer;white-space:nowrap' },
        recurBox, 'Repeats every year'),
      helpTip('For holidays, festivals and anniversaries. A repeating date has no year — it just says “14 Harvestmoon, every year” — so it gets its own section on the Timeline instead of a spot in history.'),
      readout,
      el('button', {
        class: 'ghost small',
        onclick: () => { e.date = null; save(); refreshDate(); },
      }, 'Remove from timeline')),
      hint);
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
  // `editable` gates every "this is clickable" style: in player preview nothing
  // here responds to a click, so it must not hover like it does.
  const blocksWrap = el('div', { class: readOnly ? 'blocks' : 'blocks editable' });

  // An empty block used to say "Click to write…" and nothing more, which is
  // useless in a fresh scaffold where five of them are stacked up. Naming the
  // section the block sits under turns each blank into an actual instruction.
  function emptyPrompt(idx) {
    for (let j = idx - 1; j >= 0; j--) {
      if (e.blocks[j].kind !== 'heading') continue;
      const h = e.blocks[j].text?.trim();
      return h ? `Write the ${h} section…` : 'Write here…';
    }
    return `Write about ${e.name?.trim() || 'this entry'}…`;
  }

  function blockContentHtml(b, idx) {
    if (b.kind === 'statblock') return statblockHtml(b.stat, e.name);
    if (b.kind === 'encounter') return encounterHtml(b);
    if (b.kind === 'sheet') {
      const sys = SHEET_SYSTEMS[b.system];
      return sys ? sys.html(b.data, { gm: state.gm })
        : `<div class="notice warn">Unknown sheet system “${esc(b.system || '?')}” — from a newer MundusMaker?</div>`;
    }
    // Placeholders are editor furniture. Empty text blocks never reach player
    // preview (refreshBlocks filters them out), but an *empty heading* over a
    // written section does — it must stay invisible there, exactly as before.
    const ph = (text) => (readOnly ? '' : `<span class="ph">${esc(text)}</span>`);
    const body = b.text?.trim() ? mdToHtml(b.text) : '';
    const inline = body.replace(/^<p>|<\/p>$/g, '');
    if (b.kind === 'heading') return `<h3>${body ? inline : ph('Section heading…')}</h3>`;
    if (b.kind === 'quote') return `<blockquote>${body ? inline : ph('Something said, sung or carved…')}</blockquote>`;
    return body || `<p>${ph(emptyPrompt(idx))}</p>`;
  }

  function encounterHtml(b) {
    const enc = b.enc || defaultEncounter();
    // Same visibility rule as the export: a revealed encounter must not surface
    // a GM-only creature's name (or its secret statblock's CR) in player preview.
    const c = computeEncounter(enc, (id) => {
      const m = getEntity(id);
      return m && (state.gm || !m.gmOnly) ? m : null;
    });
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

  // `editing` is what makes the mode change visible (accent ring + the toolbar
  // stops hiding). It is never removed by hand: every way out of an editor goes
  // through refreshBlocks(), which rebuilds the node without the class.
  function openEditor(b, blockNode) {
    if (blockNode.classList.contains('editing')) {
      blockNode.querySelector('textarea, input, select')?.focus();
      return; // already open — re-opening would throw away the caret position
    }
    blockNode.classList.add('editing');
    if (b.kind === 'statblock') editStatblock(b, blockNode);
    else if (b.kind === 'encounter') editEncounter(b, blockNode);
    else if (b.kind === 'sheet') editSheet(b, blockNode);
    else editBlock(b, blockNode);
  }

  // --- character-sheet editor (form comes from the system module) ---
  function editSheet(b, blockNode) {
    const sys = SHEET_SYSTEMS[b.system];
    const form = el('div', { class: 'sb-form' });
    if (!sys) {
      form.append(el('div', { class: 'notice warn' }, `No “${b.system || '?'}” system in this build — the data is intact, not editable here.`));
    } else {
      form.append(sys.editor(b, save));
    }
    form.append(el('div', { class: 'row', style: 'margin-top:10px' },
      el('button', { class: 'primary', onclick: () => { save(); refreshBlocks(); } }, 'Done'),
      el('span', { class: 'muted small' }, 'Changes save automatically. Dots and boxes are edited on the sheet itself.')));
    // the CoC "recompute derived" button rebuilds its numbers and asks to reopen
    form.addEventListener('sheet-reopen', () => { refreshBlocks(); });
    const content = blockNode.querySelector('.block-content');
    content.replaceWith(el('div', { class: 'block-content' }, form));
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

    // One way out, shared by blur, Esc, Done and the Help link. Guarded: Done
    // closes on pointerdown (see below) and some browsers also fire blur when
    // the focused textarea is torn out of the DOM, so commit can be reached
    // twice for a single close.
    let closed = false;
    const commit = () => {
      if (closed) return;
      closed = true;
      b.text = ta.value;
      save();
      refreshBlocks();
      refreshBacklinksSoon();
    };

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
      if (!ac) { ac = el('div', { class: 'wl-autocomplete' }); holder.insertBefore(ac, hint); }
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

    // ---- markup helpers behind the hint row ----
    const applyEdit = (fn) => {
      fn(ta.selectionStart, ta.selectionEnd);
      b.text = ta.value; // same save-on-input contract as typing
      save();
      grow();
      closeAc(); // the query under the caret has moved; a stale list would lie
      ta.focus();
    };
    const wrapSel = (before, after) => applyEdit((start, end) => {
      const sel = ta.value.slice(start, end);
      ta.value = ta.value.slice(0, start) + before + sel + after + ta.value.slice(end);
      ta.setSelectionRange(start + before.length, start + before.length + sel.length);
    });
    const insertText = (s) => applyEdit((start, end) => {
      ta.value = ta.value.slice(0, start) + s + ta.value.slice(end);
      ta.setSelectionRange(start + s.length, start + s.length);
    });
    const prefixLines = (mark) => applyEdit((start, end) => {
      const from = ta.value.lastIndexOf('\n', start - 1) + 1; // -1 → 0, i.e. first line
      const nl = ta.value.indexOf('\n', end);
      const to = nl === -1 ? ta.value.length : nl;
      const body = ta.value.slice(from, to).split('\n').map((l) => mark + l).join('\n');
      ta.value = ta.value.slice(0, from) + body + ta.value.slice(to);
      ta.setSelectionRange(from, from + body.length);
    });

    // ---- formatting help at the point of editing ----
    // Every chip inserts exactly the markup it shows, so the row is the
    // cheatsheet and the toolbar at once. The full guide stays in Help; resist
    // growing this row.
    // All of these fire on pointerdown with preventDefault: on a plain click
    // the textarea would blur first, commit() would rebuild the block, and the
    // button would be gone before the click ever landed.
    const chip = (label, tip, run) => {
      const btn = el('button', { class: 'fmt-chip', title: tip }, label);
      btn.addEventListener('pointerdown', (ev) => { ev.preventDefault(); run(); });
      return btn;
    };
    const done = el('button', { class: 'fmt-done', title: 'Finish editing (Esc does the same)' }, 'Done');
    done.addEventListener('pointerdown', (ev) => { ev.preventDefault(); commit(); });
    const more = el('a', { class: 'fmt-more', href: '#/help', title: 'The full guide to links, dice and secrets' }, 'More…');
    more.addEventListener('pointerdown', (ev) => { ev.preventDefault(); commit(); location.hash = '#/help'; });

    const hint = el('div', { class: 'edit-hint' },
      chip('[[link]]', 'Link to another entry — an autocomplete opens', () => {
        wrapSel('[[', ']]');
        const p = ta.selectionEnd; // caret just inside ]] so the list can filter
        ta.setSelectionRange(p, p);
        updateAc();
      }),
      chip('**bold**', 'Bold', () => wrapSel('**', '**')),
      chip('*italic*', 'Italic', () => wrapSel('*', '*')),
      chip('- list', 'Bullet list', () => prefixLines('- ')),
      chip('> quote', 'Quoted line', () => prefixLines('> ')),
      chip('2d6+3', 'Dice written like this become clickable rolls', () => insertText('2d6+3')),
      more,
      el('span', { class: 'spacer' }),
      done);
    holder.append(hint);

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
    ta.addEventListener('blur', commit);
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

  // A block-toolbar button. The pointerdown guard is what lets the toolbar be
  // used while a text editor is open in the same block: on a plain click the
  // mousedown would blur the textarea, commit() would rebuild the block, and
  // the button would be gone before the click ever landed. (The old icon-only
  // toolbar had the same defect — it was simply never visible enough to notice.)
  function ctrlBtn(attrs, ...kids) {
    const btn = el('button', attrs, ...kids);
    btn.addEventListener('pointerdown', (ev) => ev.preventDefault());
    return btn;
  }

  function refreshBlocks() {
    blocksWrap.innerHTML = '';
    // players never see secrets; empty scaffold blocks — and headings whose
    // whole section is empty — are edit-mode only
    const hasContent = (b) => b.kind === 'statblock' || b.kind === 'encounter' || b.kind === 'sheet' || b.text?.trim();
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
      const node = el('div', { class: `block${b.secret ? ' secret' : ''}${hasContent(b) ? '' : ' empty'}` });
      if (!readOnly) {
        node.append(el('div', { class: 'bctrl' },
          ctrlBtn({
            class: 'bc-edit', title: 'Edit this block — clicking its text does the same',
            onclick: () => openEditor(b, node),
          }, '✏️ Edit'),
          // A named picker, not the old ¶ cycle button: all three styles are
          // visible, the current one is marked, and there is no "click it three
          // more times to get back to text".
          b.kind === 'statblock' || b.kind === 'encounter' || b.kind === 'sheet' ? null : el('span', { class: 'bc-style' },
            [['text', 'Text'], ['heading', 'Heading'], ['quote', 'Quote']].map(([k, label]) => ctrlBtn({
              class: k === b.kind ? 'sel' : '',
              title: k === b.kind ? `Already a ${label.toLowerCase()} block` : `Turn this into a ${label.toLowerCase()} block`,
              onclick: () => { if (b.kind === k) return; b.kind = k; save(); refreshBlocks(); },
            }, label))),
          ctrlBtn({
            class: b.secret ? 'on' : '',
            title: b.secret
              ? 'Secret: visible only to you (GM). Click to reveal it to players.'
              : 'Lock this block: only you (GM) see it — players and player exports never do.',
            onclick: () => { b.secret = !b.secret; save(); refreshBlocks(); },
          }, b.secret ? '🔓 Reveal' : '🔒 Make secret'),
          ctrlBtn({ class: 'bc-icon', title: 'Move up', 'aria-label': 'Move block up', onclick: () => { moveBlock(idx, -1); } }, '↑'),
          ctrlBtn({ class: 'bc-icon', title: 'Move down', 'aria-label': 'Move block down', onclick: () => { moveBlock(idx, +1); } }, '↓'),
          ctrlBtn({
            class: 'bc-del',
            title: 'Delete this block (you can undo)', onclick: () => {
              const removed = e.blocks[idx];
              // A statblock or encounter represents real work and the undo toast
              // is transient (9s, and gone on navigation), so those keep an
              // explicit confirm. Text/heading/quote rely on undo alone.
              const costly = b.kind === 'statblock' || b.kind === 'encounter' || b.kind === 'sheet';
              if (costly && !confirm(`Delete this ${BLOCK_NOUN[b.kind] || 'block'}? You can undo for a few seconds afterwards.`)) return;
              e.blocks.splice(idx, 1);
              save(); refreshBlocks();
              offerUndo(`${BLOCK_NOUN[b.kind] || 'Block'} deleted.`, () => {
                e.blocks.splice(Math.min(idx, e.blocks.length), 0, removed);
                refreshBlocks();
              });
            },
          }, '✕ Delete')));
      }
      const content = el('div', { class: 'block-content' });
      content.innerHTML = blockContentHtml(b, idx);
      if (!readOnly) {
        content.addEventListener('click', (ev) => {
          if (ev.target.closest('a')) return; // let links navigate
          if (b.kind === 'sheet') {
            // dots and damage boxes edit in place; the roll bar is left alone
            if (ev.target.closest('select, .sheet-rollbar')) return;
            if (handleSheetClick(b, ev.target)) {
              save();
              if (!node.classList.contains('editing')) content.innerHTML = blockContentHtml(b, idx);
              return;
            }
          }
          openEditor(b, node);
        });
      }
      node.append(content);
      blocksWrap.append(node);
    }
    if (!readOnly) {
      blocksWrap.append(el('div', { class: 'add-block-row' },
        el('button', { class: 'ghost', title: 'A paragraph of prose', onclick: () => addBlock({ kind: 'text' }) }, '+ Text'),
        el('button', { class: 'ghost', title: 'A section title, e.g. “Appearance”', onclick: () => addBlock({ kind: 'heading' }) }, '+ Heading'),
        el('button', { class: 'ghost', title: 'Something said, sung or carved — shown indented', onclick: () => addBlock({ kind: 'quote' }) }, '+ Quote'),
        el('button', { class: 'ghost', title: 'A classic monster/NPC statblock — editable, exports to PDF', onclick: () => addBlock({ kind: 'statblock' }) }, '+ ⚔ Statblock'),
        el('button', {
          class: 'ghost', title: 'Encounter with XP budget and difficulty math — starts as a GM secret',
          onclick: () => addBlock({ kind: 'encounter', secret: true }),
        }, '+ 💀 Encounter'),
        el('button', {
          class: 'ghost', title: 'An interactive character sheet (D&D 5.5e, Vampire V5 or Call of Cthulhu). For a guided build, use Create a character instead.',
          onclick: pickSheetSystem,
        }, '+ 🎭 Sheet'),
        // Kept as its own button rather than folded into "+ Text then lock it":
        // a GM-only paragraph is the single most-used thing in the app, and
        // folding it would hide it behind a control you must first discover.
        // "Secret text" (not "Secret block") because it is a text block that
        // starts locked, not a sixth kind of block.
        el('button', {
          style: 'border-color:var(--secret-border);color:#cbb3ef',
          title: 'A text block that starts locked: only you (GM) see it. Players, player preview and player exports never get it.',
          onclick: () => addBlock({ kind: 'text', secret: true }),
        }, '+ 🔒 Secret text')));
    }
  }

  function addBlock({ kind, secret = false, system = null }) {
    const b = { id: uid(), kind, text: '', secret };
    if (kind === 'statblock') b.stat = defaultStat(e.name);
    if (kind === 'encounter') b.enc = defaultEncounter();
    if (kind === 'sheet') { b.system = system; b.data = SHEET_SYSTEMS[system].defaults(); }
    e.blocks.push(b);
    save();
    refreshBlocks();
    openEditor(b, blocksWrap.children[e.blocks.length - 1]);
  }

  // tiny system picker for "+ Sheet" — the wizard at #/create is the guided path
  function pickSheetSystem() {
    const dialog = el('div', { class: 'dialog' },
      el('h3', {}, 'Which game system?'),
      el('div', { class: 'edition-cards', style: 'grid-template-columns:1fr' },
        Object.entries(SHEET_SYSTEMS).map(([key, sys]) => el('div', {
          class: 'edition-card',
          onclick: () => { overlay.remove(); addBlock({ kind: 'sheet', system: key }); },
        },
          el('div', { style: 'font-weight:600' }, sys.label),
          el('div', { class: 'muted small' }, sys.tagline)))),
      el('p', { class: 'muted small', style: 'margin:10px 0 0' },
        'Blank sheet — for a guided, rules-checked build use ',
        el('a', { href: '#/create', onclick: () => overlay.remove() }, 'Create a character'), '.'));
    const overlay = el('div', { class: 'overlay' }, dialog);
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) overlay.remove(); });
    document.body.append(overlay);
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
        el('button', {
          class: 'ghost', title: 'Remove this relation (you can undo)',
          onclick: () => {
            const removed = e.relations[i];
            e.relations.splice(i, 1);
            save(); refreshRelations();
            offerUndo('Relation removed.', () => {
              e.relations.splice(Math.min(i, e.relations.length), 0, removed);
              refreshRelations();
            });
          },
        }, '✕')));
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
