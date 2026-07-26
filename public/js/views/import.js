// Import view: bring existing work into the current world.
//   1. A folder of Markdown/Obsidian notes ([[links]] are the same syntax)
//   2. Monsters from a locally downloaded 5e.tools bestiary JSON

import { el, uid, toast, slugify } from '../util.js';
import { state, types, newEntity, saveEntity, findByName } from '../state.js';
import { parseFrontmatter, mdToBlocks, monsterToStat, loadBundledBestiary } from '../importers.js';
import { crFromStat } from '../encounter.js';

export function render(container) {
  if (!state.gm) {
    container.append(el('div', { class: 'page' }, el('div', { class: 'notice warn' }, 'Importing is a GM activity — switch to GM view first.')));
    return;
  }

  // ---------- markdown ----------
  const mdStatus = el('div', { class: 'small muted', style: 'margin-top:8px' });
  const mdTypeSel = el('select', {},
    Object.entries(types()).map(([key, t]) => el('option', { value: key, selected: key === 'note' }, t.label)));
  const mdInput = el('input', { type: 'file', webkitdirectory: true, multiple: true, style: 'display:none' });
  let mdFiles = [];

  mdInput.addEventListener('change', () => {
    mdFiles = [...mdInput.files].filter((f) => f.name.toLowerCase().endsWith('.md'));
    mdStatus.textContent = mdFiles.length
      ? `Found ${mdFiles.length} .md file${mdFiles.length === 1 ? '' : 's'}. Choose a default type, then import.`
      : 'No .md files in that folder.';
  });

  const mdImport = async () => {
    if (!mdFiles.length) { mdInput.click(); return; }
    let imported = 0, skipped = 0;
    mdStatus.textContent = 'Importing…';
    for (const f of mdFiles) {
      const name = f.name.replace(/\.md$/i, '').trim();
      if (!name || findByName(name)) { skipped++; continue; }
      const { meta, body } = parseFrontmatter(await f.text());
      const type = meta.type && types()[meta.type] ? meta.type : mdTypeSel.value;
      const e = newEntity(name, type);
      e.blocks = mdToBlocks(body);
      const folder = (f.webkitRelativePath || '').split('/').slice(0, -1).pop();
      const tags = new Set([...(Array.isArray(meta.tags) ? meta.tags : meta.tags ? [meta.tags] : [])]);
      if (folder) tags.add(folder.toLowerCase());
      e.tags = [...tags].slice(0, 6);
      await saveEntity(e);
      imported++;
    }
    mdStatus.textContent = `Done: imported ${imported}, skipped ${skipped} (already existed or unnamed). [[Links]] between notes resolve automatically.`;
    toast(`Imported ${imported} notes`);
    mdFiles = [];
  };

  // ---------- 5e.tools ----------
  const beStatus = el('div', { class: 'small muted', style: 'margin-top:8px' });
  const beList = el('div', { class: 'import-list', style: 'display:none' });
  const beSearch = el('input', { type: 'search', placeholder: 'Filter monsters…', style: 'flex:1', oninput: () => renderMonsterList() });
  const beTypeSel = el('select', {},
    ['creature', 'npc'].filter((k) => types()[k]).map((key) =>
      el('option', { value: key }, types()[key].label)));
  const beInput = el('input', { type: 'file', accept: '.json', style: 'display:none' });
  let monsters = [];
  const selected = new Set();

  function setMonsters(list, label) {
    monsters = (list || []).filter((m) => m?.name && !m._copy); // _copy entries need cross-file resolution
    const skippedCopies = (list || []).length - monsters.length;
    if (!monsters.length) { beStatus.textContent = 'No monsters found — pick a bestiary file like data/bestiary/bestiary-mm.json.'; return; }
    selected.clear();
    beStatus.textContent = `${monsters.length} monsters loaded from ${label}${skippedCopies ? ` (${skippedCopies} variant "_copy" entries skipped)` : ''}. Tick the ones you want.`;
    beList.style.display = '';
    renderMonsterList();
  }

  beInput.addEventListener('change', async () => {
    const f = beInput.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      setMonsters(data.monster, f.name);
    } catch (err) {
      beStatus.textContent = 'Could not parse that file: ' + err.message;
    }
  });

  const loadBuiltin = async () => {
    try {
      const data = await loadBundledBestiary();
      setMonsters(data.monster, 'the built-in SRD bestiary');
    } catch (err) {
      beStatus.textContent = 'Could not load the bundled bestiary: ' + err.message;
    }
  };

  function renderMonsterList() {
    const q = beSearch.value.trim().toLowerCase();
    const shown = monsters.filter((m) => !q || m.name.toLowerCase().includes(q)).slice(0, 400);
    beList.innerHTML = '';
    beList.append(el('div', { class: 'row small', style: 'padding:4px 0;border-bottom:1px solid var(--line)' },
      el('button', {
        class: 'ghost small',
        onclick: () => { shown.forEach((m) => selected.add(m.name)); renderMonsterList(); },
      }, `Select all shown (${shown.length})`),
      el('button', { class: 'ghost small', onclick: () => { selected.clear(); renderMonsterList(); } }, 'Clear'),
      el('span', { class: 'spacer' }),
      el('span', { class: 'muted' }, `${selected.size} selected`)));
    for (const m of shown) {
      const cr = typeof m.cr === 'object' ? m.cr?.cr : m.cr;
      beList.append(el('label', { class: 'import-row' },
        el('input', {
          type: 'checkbox', checked: selected.has(m.name),
          onchange: (ev) => { ev.target.checked ? selected.add(m.name) : selected.delete(m.name); },
        }),
        el('span', {}, m.name),
        el('span', { class: 'muted small' }, `CR ${cr ?? '?'} · ${m.source || ''}`)));
    }
  }

  const beImport = async () => {
    if (!monsters.length) { beInput.click(); return; }
    const chosen = monsters.filter((m) => selected.has(m.name));
    if (!chosen.length) { toast('Tick at least one monster first'); return; }
    let imported = 0, skipped = 0;
    beStatus.textContent = 'Importing…';
    for (const mon of chosen) {
      if (findByName(mon.name)) { skipped++; continue; }
      try {
        const stat = monsterToStat(mon);
        const e = newEntity(mon.name, beTypeSel.value);
        e.tags = [String(typeof mon.type === 'string' ? mon.type : mon.type?.type || '').toLowerCase(), `cr-${crFromStat(stat) || '0'}`].filter(Boolean);
        e.blocks = [{ id: uid(), kind: 'statblock', text: '', secret: false, stat }];
        await saveEntity(e);
        imported++;
      } catch (err) {
        console.error('failed to import', mon.name, err);
        skipped++;
      }
    }
    beStatus.textContent = `Done: imported ${imported}, skipped ${skipped} (already existed or failed).`;
    toast(`Imported ${imported} statblocks`);
  };

  container.append(el('div', { class: 'page' },
    el('h1', {}, 'Import'),

    el('div', { class: 'card' },
      el('h3', {}, 'Markdown / Obsidian folder'),
      el('p', { class: 'muted small' },
        'Pick a folder of .md files (an Obsidian vault works as-is). Each file becomes an entry: ',
        'the filename is the name, # headings become heading blocks, and [[wiki-links]] keep working. ',
        'Frontmatter type: and tags: are respected; the subfolder name becomes a tag so you can re-sort later.'),
      el('div', { class: 'row' },
        el('button', { onclick: () => mdInput.click() }, '📁 Choose folder…'),
        el('span', { class: 'muted small' }, 'imported as'), mdTypeSel,
        el('button', { class: 'primary', onclick: mdImport }, 'Import notes')),
      mdStatus, mdInput),

    el('div', { class: 'card' },
      el('h3', {}, 'Monsters & statblocks'),
      el('p', { class: 'muted small' },
        'MundusMaker ships with the ', el('strong', {}, 'SRD 5.1 bestiary'), ' — 322 classic D&D monsters ',
        '(goblins to ancient dragons), fully offline. You can also pick a bestiary JSON from a local ',
        '5e.tools download (its ', el('code', {}, 'data/bestiary/'), ' folder — only import content you own). ',
        'Ticked monsters become entries with full statblocks, ready for encounter blocks. ',
        'Tip: you can also copy a monster straight into any statblock via its “📖 From bestiary” button.'),
      el('div', { class: 'row' },
        el('button', { class: 'primary', onclick: loadBuiltin }, '📖 Browse SRD bestiary'),
        el('button', { onclick: () => beInput.click() }, '📄 Choose 5e.tools JSON…'),
        beSearch,
        el('span', { class: 'muted small' }, 'as'), beTypeSel,
        el('button', { onclick: beImport }, 'Import selected')),
      beStatus, beList, beInput,
      el('p', { class: 'muted', style: 'font-size:11px;margin-top:10px' },
        'Bundled monsters are from the System Reference Document 5.1 by Wizards of the Coast LLC, ',
        'licensed under Creative Commons Attribution 4.0.')),

    el('p', { class: 'muted small' },
      'Everything imports into the current world (', el('strong', {}, state.world.name), '). Files are read locally in your browser — nothing is uploaded anywhere.')));
}
