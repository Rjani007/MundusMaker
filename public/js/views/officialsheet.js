// "Use my own official sheet": fill the GM's own copy of a publisher's
// fillable character sheet with a character's values (sheets/pdfform.js does
// the PDF work, sheets/officialsheets.js decides which value goes where).
// The PDFs are the GM's own copies: picked from disk, or downloaded from the
// publisher's own site when the GM presses "Get it from…" (scripts/
// sheetdownload.js; the sheets allow personal use only, so the release never
// carries them). Stored locally under the data folder's .sheet-templates,
// never in a world, a backup or the wiki.

import { el, toast, downloadBlob, slugify } from '../util.js';
import { api } from '../api.js';
import { SHEET_SYSTEMS } from '../sheets/sheetcore.js';
import { withSkillBases } from '../sheets/cocskills.js';
import { readPdf, readForm, fillForm } from '../sheets/pdfform.js';
import { TEMPLATES, planFill, recognize } from '../sheets/officialsheets.js';
import { FAMILIAR_SYSTEMS } from '../sheets/familiar.js';
import { buildCharacterPdf } from '../pdf.js';
import { state } from '../state.js';

const TYPE_LABEL = { text: 'Text', checkbox: 'Tick box', radio: 'Choice', choice: 'List', pushbutton: 'Box' };

function base64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function sheetData(block) {
  if (block.system !== 'coc7') return block.data || {};
  // Call of Cthulhu sheets list every skill with its base, as the app does
  const catalog = await SHEET_SYSTEMS.coc7.loadData();
  return withSkillBases(block.data || {}, catalog);
}

/** Open the dialog for one sheet block of `entity`. */
export function openOfficialSheet({ entity, block }) {
  const system = block.system;
  const known = TEMPLATES.filter((t) => t.system === system);
  const body = el('div', {}, el('p', { class: 'muted small' }, 'Loading…'));
  const dialog = el('div', { class: 'dialog official-sheet' },
    el('h3', {}, 'Fill an official character sheet'),
    el('p', { class: 'small' }, 'MundusMaker writes this character into your own copy of the publisher’s free fillable sheet, here on this computer. It never shares or changes that sheet; the filled copy is a new file.'),
    known.length ? el('p', { class: 'muted small' }, 'Sheets MundusMaker knows field by field: ',
      known.map((t, i) => [i ? '; ' : '', el('strong', {}, t.label), ` (from ${t.where})`]), '. Any other fillable sheet works too: MundusMaker matches its fields by name and lets you check them.') : null,
    body,
    el('div', { class: 'row', style: 'margin-top:12px;justify-content:flex-end' }, el('button', { class: 'ghost', onclick: () => close() }, 'Close')));
  const overlay = el('div', { class: 'overlay' }, dialog);
  const close = () => overlay.remove();
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });
  overlay.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') close(); });
  document.body.append(overlay);

  let templates = [];
  const fileInput = el('input', { type: 'file', accept: 'application/pdf,.pdf', hidden: true, onchange: () => addSheet(fileInput.files?.[0]) });
  dialog.append(fileInput);

  async function showList(selectId) {
    let sources, downloadable;
    try {
      const [all, offered] = await Promise.all([api.sheetTemplates(), api.sheetSources()]);
      templates = all.filter((t) => t.system === system);
      downloadable = offered.some((s) => s.system === system);
      sources = offered.filter((s) => s.system === system && !templates.some((t) => t.source === s.id));
    } catch (err) { body.replaceChildren(el('div', { class: 'notice warn' }, err.message)); return; }
    const rows = templates.map((t) => el('div', { class: 'hist-row' },
      el('div', { style: 'flex:1;min-width:0' }, el('strong', {}, t.label), el('div', { class: 'muted small' }, `${t.fileName} · ${(t.size / 1024).toFixed(0)} KB`)),
      el('button', { class: 'small primary', onclick: () => openSheet(t) }, 'Use'),
      el('button', { class: 'small ghost', title: 'Remove this saved sheet (it moves to the trash)', onclick: async () => {
        if (!confirm(`Remove “${t.label}” from MundusMaker? Your original file is not affected.`)) return;
        try { await api.deleteSheetTemplate(t.id); showList(); } catch (err) { toast(err.message); }
      } }, '✕')));
    // publisher sheets MundusMaker can fetch for the GM, and ones it can only link to
    const getRows = sources.map((s) => {
      const btn = el('button', { class: rows.length ? 'small' : 'small primary', 'aria-label': `Get the ${s.label} from ${s.publisher}`, onclick: () => download(s, btn) }, `⬇ Get it from ${s.publisher}`);
      return el('div', { class: 'hist-row' },
        el('div', { style: 'flex:1;min-width:0' }, el('strong', {}, s.label), el('div', { class: 'muted small' }, `Free from ${s.publisher} (${s.host})`)), btn);
    });
    // A game whose publisher sheet MundusMaker cannot fetch (V5: Renegade hands
    // it out through a store checkout) gets MundusMaker's own sheet laid out
    // like it instead: the Familiar layout, measured from the publisher's sheet.
    const lookalike = !downloadable && FAMILIAR_SYSTEMS.includes(system);
    const lookBtn = el('button', { class: rows.length ? 'small' : 'small primary', onclick: () => downloadLookalike(lookBtn) }, '⬇ Download it filled');
    const pages = lookalike ? [el('div', { class: 'hist-row' },
      el('div', { style: 'flex:1;min-width:0' }, el('strong', {}, `MundusMaker’s ${SHEET_SYSTEMS[system]?.label || ''} sheet, laid out like the official one`),
        el('div', { class: 'muted small' }, 'The same boxes in the same places, drawn by MundusMaker on US Letter, with this character filled in. The publisher’s own sheet comes from their store; if you have it, add the PDF below.')),
      lookBtn)] : [];
    body.replaceChildren(el('div', {},
      rows.length ? el('div', {}, el('h4', { style: 'margin:6px 0' }, 'Your saved sheets'), rows)
        : el('div', { class: 'notice' }, `No ${SHEET_SYSTEMS[system]?.label || ''} sheet saved yet.`),
      getRows.length || pages.length ? el('div', { style: 'margin-top:10px' },
        el('h4', { style: 'margin:6px 0' }, rows.length ? 'Also available' : getRows.length ? 'Get the official sheet' : 'Get a sheet'), getRows, pages,
        getRows.length ? el('p', { class: 'muted small', style: 'margin:6px 0 0' }, 'MundusMaker downloads the publisher’s own free sheet from their website, once, into your data folder. The publisher allows it for personal use, so it stays on this computer: MundusMaker never shares it, and it is not in your world backups.') : null) : null,
      el('div', { class: 'row', style: 'margin-top:10px' }, el('button', { onclick: () => fileInput.click() }, '+ Add a sheet PDF…'),
        el('span', { class: 'muted small' }, 'any other fillable sheet, or one you downloaded yourself'))));
    const chosen = templates.find((t) => t.id === selectId) || (templates.length === 1 ? templates[0] : null);
    if (chosen && selectId) openSheet(chosen);
  }

  async function downloadLookalike(btn) {
    btn.disabled = true;
    try {
      // a player copy unless the sheet itself is hidden from players
      const gm = !!(state.gm && (entity.gmOnly || block.secret));
      const doc = await buildCharacterPdf(entity, { gm, blockId: block.id, format: 'letter', layout: 'familiar' });
      downloadBlob(doc.output('blob'), `${slugify(entity.name || 'character')}-${gm ? 'gm' : 'player'}-sheet.pdf`);
    } catch (err) { toast(`Could not make the sheet: ${err.message}`, 5000); }
    btn.disabled = false;
  }

  async function download(source, btn) {
    btn.disabled = true;
    btn.textContent = `Downloading from ${source.publisher}…`;
    try {
      const meta = await api.downloadSheetTemplate(source.id);
      toast(`Downloaded the ${meta.label} from ${source.publisher}.`);
      showList(meta.id);
    } catch (err) {
      body.replaceChildren(el('div', { class: 'notice warn' }, err.message), el('div', { class: 'row', style: 'margin-top:10px' }, el('button', { onclick: () => showList() }, 'Back')));
    }
  }

  async function addSheet(file) {
    fileInput.value = '';
    if (!file) return;
    body.replaceChildren(el('p', { class: 'muted small' }, `Reading ${file.name}…`));
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const form = await readForm(await readPdf(bytes));
      if (!form.fields.length) throw new Error('This PDF has no form fields to fill. Use the publisher’s fillable version of the sheet.');
      const template = recognize(system, form);
      const meta = await api.addSheetTemplate({ system, fileName: file.name, label: template?.label || file.name.replace(/\.pdf$/i, ''), dataBase64: base64(bytes) });
      toast(template ? `Recognised: ${template.label}.` : 'Saved. MundusMaker will match its fields by name; check them before printing.');
      showList(meta.id);
    } catch (err) {
      body.replaceChildren(el('div', { class: 'notice warn' }, err.message), el('div', { class: 'row', style: 'margin-top:10px' }, el('button', { onclick: () => showList() }, 'Back')));
    }
  }

  async function openSheet(meta) {
    body.replaceChildren(el('p', { class: 'muted small' }, 'Opening the sheet…'));
    let bytes, form, data;
    try {
      bytes = await api.sheetTemplatePdf(meta.id);
      form = await readForm(await readPdf(bytes));
      data = await sheetData(block);
    } catch (err) {
      body.replaceChildren(el('div', { class: 'notice warn' }, err.message), el('button', { onclick: () => showList() }, 'Back'));
      return;
    }
    const choices = { ...(meta.choices || {}) };
    let plan = planFill(system, data, entity.name, form, choices);
    const summary = el('div', {});
    const table = el('div', { class: 'official-fields' });
    let saveTimer;
    const saveChoices = () => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => api.updateSheetTemplate(meta.id, { choices }).catch((err) => toast(err.message)), 600);
    };
    const filter = el('select', { 'aria-label': 'Which fields to list', onchange: () => drawRows() },
      el('option', { value: 'filled' }, 'Fields that will be filled'), el('option', { value: 'empty' }, 'Fields left blank'), el('option', { value: 'all' }, 'All fields'));
    const search = el('input', { type: 'search', placeholder: 'Find a field…', 'aria-label': 'Find a field', oninput: () => drawRows() });
    const keyOptions = (selected) => {
      const groups = new Map();
      for (const [key, v] of plan.values) { if (!groups.has(v.group)) groups.set(v.group, []); groups.get(v.group).push([key, v.label]); }
      return [el('option', { value: '' }, '— leave blank —'), ...[...groups].map(([g, list]) => el('optgroup', { label: g }, list.map(([k, label]) => el('option', { value: k, selected: k === selected }, label))))];
    };
    function drawSummary() {
      const filled = plan.rows.filter((r) => r.value !== undefined && r.value !== '' && r.value !== false).length;
      summary.replaceChildren(
        el('div', { class: 'notice' }, plan.template ? ['Recognised: ', el('strong', {}, plan.template.label), '. '] : ['Not a sheet MundusMaker knows field by field, so its fields were matched by name. Check them below. '],
          `${filled} of ${plan.rows.length} fields get a value from ${entity.name || 'this character'}.`),
        el('div', { class: 'row', style: 'margin:10px 0;gap:8px;flex-wrap:wrap' },
          el('button', { class: 'primary', onclick: () => download() }, '⬇ Download filled sheet'),
          el('button', { class: 'ghost', onclick: () => showList() }, 'Other sheets…')));
    }
    function drawRows() {
      const mode = filter.value, q = search.value.trim().toLowerCase();
      const list = plan.rows.filter((r) => {
        const has = r.value !== undefined && r.value !== '' && r.value !== false;
        if (mode === 'filled' && !has) return false;
        if (mode === 'empty' && has) return false;
        return !q || r.field.toLowerCase().includes(q) || r.label.toLowerCase().includes(q);
      });
      table.replaceChildren(...list.slice(0, 400).map((r) => {
        const select = el('select', { 'aria-label': `Value for field ${r.field}`, onchange: () => {
          choices[r.field] = select.value;
          plan = planFill(system, data, entity.name, form, choices);
          saveChoices(); drawSummary(); drawRows();
        } }, el('option', { value: r.key, selected: true }, r.key ? r.label : '— leave blank —'));
        select.addEventListener('focus', () => { if (select.options.length < 3) select.replaceChildren(...keyOptions(r.key)); }, { once: true });
        const shown = typeof r.value === 'boolean' ? (r.value ? '✓' : '—') : r.value || '';
        return el('div', { class: 'official-row' },
          el('div', { class: 'official-field' }, el('code', {}, r.field), el('span', { class: 'muted small' }, ` ${TYPE_LABEL[r.type] || r.type}${r.page >= 0 ? `, page ${r.page + 1}` : ''}${r.source === 'yours' ? ', your choice' : ''}`)),
          select, el('div', { class: 'official-value small', title: String(shown) }, String(shown)));
      }), list.length > 400 ? el('p', { class: 'muted small' }, `Showing 400 of ${list.length}; use the search box to find the rest.`) : '');
    }
    async function download() {
      try {
        const doc = await readPdf(bytes);
        const fresh = await readForm(doc);
        const { bytes: out } = await fillForm(doc, fresh, planFill(system, data, entity.name, fresh, choices).fill);
        downloadBlob(new Blob([out], { type: 'application/pdf' }), `${slugify(entity.name || 'character')}-${slugify(meta.label).slice(0, 40)}.pdf`);
      } catch (err) { toast(`Could not fill the sheet: ${err.message}`); }
    }
    drawSummary();
    drawRows();
    body.replaceChildren(summary,
      el('details', {}, el('summary', {}, 'Check or change which value goes in each field'),
        el('p', { class: 'muted small' }, 'Your changes are saved with this sheet and used for every character of this game.'),
        el('div', { class: 'row', style: 'gap:8px;margin:6px 0' }, filter, search), table));
  }

  showList();
}
