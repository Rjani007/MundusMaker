// Import view: bring existing work into the current world.
//
// Most formats are IMPORTERS registry entries — stage(files) parses and
// previews (no writes), commit() creates entities — so new formats are one
// entry + converters in importers.js. Cards with bespoke interaction (the
// bestiary browser, old-install migration, backup restore) render themselves.

import { el, uid, toast } from '../util.js';
import { state, types, newEntity, saveEntity, findByName, refreshWorlds, requireSaved } from '../state.js';
import {
  parseFrontmatter, mdToBlocks, parseCsv, monsterToStat, loadBundledBestiary,
  parseWorldAnvil, htmlToBlocks, parseFoundryText, foundryJournalToBlocks, foundryActorToStat,
} from '../importers.js';
import { crFromStat } from '../encounter.js';
import { api } from '../api.js';

const IMG_EXT = /\.(png|jpe?g|webp|gif|svg)$/i;

async function fileToBase64(f) {
  const buf = new Uint8Array(await f.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

// The server stores raster images only (an SVG opened on its own can run
// script), so an SVG embed is drawn to a PNG first. Loaded as an <img>, an SVG
// runs no script and fetches nothing, so drawing it here is safe and local.
async function svgToPng(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    let w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) { // no width/height attributes: fall back to the viewBox
      const box = new DOMParser().parseFromString(await file.text(), 'image/svg+xml')
        .documentElement.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
      if (box?.length === 4 && box[2] > 0 && box[3] > 0) [w, h] = [box[2], box[3]];
    }
    if (!w || !h) throw new Error('the SVG has no size');
    const scale = Math.min(2048, Math.max(512, w, h)) / Math.max(w, h); // vector: small icons stay crisp
    const canvas = el('canvas', { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) });
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('the SVG could not be converted'))), 'image/png'));
    return new File([blob], file.name.replace(/\.svg$/i, '.png'), { type: 'image/png' });
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------- markdown / Obsidian (with images) ----------

function markdownImporter() {
  let staged = null; // { md: File[], imgs: File[] }
  return {
    id: 'markdown',
    title: 'Markdown / Obsidian folder',
    desc: () => el('p', { class: 'muted small' },
      'Pick a folder of .md files (an Obsidian vault works as-is). Each file becomes an entry: ',
      'the filename is the name, # headings become heading blocks, and [[wiki-links]] keep working. ',
      'Images come too: embedded pictures are uploaded into the world, and an image named like a note ',
      'becomes its portrait. Frontmatter type: and tags: are respected; folder names become tags.'),
    pick: { kind: 'folder' },
    typeDefault: 'note',
    stage(files) {
      const md = files.filter((f) => f.name.toLowerCase().endsWith('.md'));
      const imgs = files.filter((f) => IMG_EXT.test(f.name));
      staged = { md, imgs };
      if (!md.length) return { summary: 'No .md files in that folder.', ready: false };
      return {
        summary: `Found ${md.length} note${md.length === 1 ? '' : 's'} and ${imgs.length} image${imgs.length === 1 ? '' : 's'}. Choose a default type, then import.`,
        ready: true,
      };
    },
    async commit({ typeKey, setStatus }) {
      const { md, imgs } = staged;
      const uploaded = new Map(); // File -> asset file name, or null if refused (upload once, reuse)
      const ensureUploaded = async (file) => {
        if (!uploaded.has(file)) {
          let asset = null;
          try {
            const image = /\.svg$/i.test(file.name) ? await svgToPng(file) : file;
            asset = (await api.uploadAsset(image.name, await fileToBase64(image))).file;
          } catch (err) {
            console.warn(`[import] could not bring in ${file.name}: ${err.message}`);
          }
          uploaded.set(file, asset);
        }
        return uploaded.get(file);
      };
      // Obsidian refs are usually bare basenames; fall back to path-suffix match.
      const findImg = (ref) => {
        const norm = ref.trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
        const base = norm.split('/').pop();
        return imgs.find((f) => (f.webkitRelativePath || f.name).toLowerCase().endsWith('/' + norm))
          || imgs.find((f) => f.name.toLowerCase() === base);
      };
      const IMG_REF = /!\[\[([^\]]+?\.(?:png|jpe?g|webp|gif|svg))(?:\|[^\]]*)?\]\]|!\[([^\]]*)\]\(([^)\s]+?\.(?:png|jpe?g|webp|gif|svg))\)/gi;

      let imported = 0, skipped = 0;
      for (const f of md) {
        const name = f.name.replace(/\.md$/i, '').trim();
        if (!name || findByName(name)) { skipped++; continue; }
        const { meta, body } = parseFrontmatter(await f.text());

        // rewrite image embeds to /assets/ BEFORE mdToBlocks (which would turn ![[x]] into a wiki-link)
        let text = '';
        let last = 0;
        for (const m of body.matchAll(IMG_REF)) {
          const ref = m[1] || m[3];
          const alt = m[2] || '';
          const file = findImg(ref);
          const asset = file ? await ensureUploaded(file) : null;
          text += body.slice(last, m.index);
          if (asset) text += `![${alt}](/assets/${encodeURIComponent(state.worldId)}/${encodeURIComponent(asset)})`;
          else text += m[0]; // image not in the folder, or refused — leave the reference as written
          last = m.index + m[0].length;
        }
        text += body.slice(last);

        const type = meta.type && types()[meta.type] ? meta.type : typeKey;
        const e = newEntity(name, type);
        e.blocks = mdToBlocks(text);
        const segs = (f.webkitRelativePath || '').split('/').slice(0, -1).map((s) => s.toLowerCase());
        const tags = new Set([...(Array.isArray(meta.tags) ? meta.tags : meta.tags ? [meta.tags] : []), ...segs]);
        e.tags = [...tags].filter(Boolean).slice(0, 6);
        const portrait = imgs.find((im) => im.name.replace(IMG_EXT, '').toLowerCase() === name.toLowerCase());
        const image = portrait ? await ensureUploaded(portrait) : null;
        if (image) e.image = image;
        await saveEntity(e);
        imported++;
        if (imported % 20 === 0) setStatus(`Importing… ${imported}/${md.length}`);
      }
      staged = null;
      const images = [...uploaded.values()].filter(Boolean).length;
      const refused = uploaded.size - images;
      return { done: `Done: imported ${imported}, skipped ${skipped} (already existed or unnamed), uploaded ${images} image${images === 1 ? '' : 's'}${refused ? `; ${refused} image${refused === 1 ? '' : 's'} could not be brought in, so ${refused === 1 ? 'its reference was' : 'their references were'} left as written` : ''}. [[Links]] between notes resolve automatically.` };
    },
  };
}

// ---------- CSV ----------

function csvImporter() {
  let headers = [], data = [], selects = [];
  return {
    id: 'csv',
    title: 'CSV / spreadsheet',
    desc: () => el('p', { class: 'muted small' },
      'A table of anything — NPCs, shops, holidays. The first row must be column names. ',
      'Map each column to what it means (the entry name, its type, tags, or a quick fact) and import. ',
      'Export any spreadsheet as .csv; commas, semicolons and tabs all work.'),
    pick: { kind: 'file', accept: '.csv,.tsv,.txt' },
    typeDefault: 'note',
    async stage(files) {
      const rows = parseCsv(await files[0].text());
      if (rows.length < 2) return { summary: 'Need a header row plus at least one data row.', ready: false };
      headers = rows[0].map((h) => String(h).trim() || '(unnamed)');
      data = rows.slice(1);
      selects = headers.map((h, i) => {
        const sel = el('select', { class: 'small' },
          el('option', { value: 'name' }, 'Entry name'),
          el('option', { value: 'type' }, 'Type'),
          el('option', { value: 'tags' }, 'Tags (split on ;)'),
          el('option', { value: 'field' }, `Fact: “${h}”`),
          el('option', { value: 'ignore' }, 'Ignore'));
        sel.value = /^name$/i.test(h) ? 'name'
          : /^type$/i.test(h) ? 'type'
          : /^tags?$/i.test(h) ? 'tags' : 'field';
        if (sel.value !== 'name' && i === 0 && !headers.some((x) => /^name$/i.test(x))) sel.value = 'name';
        return sel;
      });
      const table = el('table', { class: 'csv-map' },
        el('tr', {}, headers.map((h) => el('th', {}, h))),
        el('tr', {}, selects.map((s) => el('td', {}, s))),
        data.slice(0, 5).map((r) => el('tr', {}, headers.map((_, i) => el('td', { class: 'muted small' }, String(r[i] ?? ''))))));
      return {
        summary: `${data.length} row${data.length === 1 ? '' : 's'}. Tell me what each column is:`,
        preview: el('div', { class: 'csv-map-wrap' }, table),
        ready: true,
      };
    },
    async commit({ typeKey }) {
      const roles = selects.map((s) => s.value);
      const nameIdx = roles.indexOf('name');
      if (nameIdx < 0) return { done: 'One column must be mapped to “Entry name”.' };
      const typeByLabel = {};
      for (const [key, t] of Object.entries(types())) {
        typeByLabel[key.toLowerCase()] = key;
        typeByLabel[String(t.label).toLowerCase()] = key;
      }
      let imported = 0, skipped = 0;
      for (const row of data) {
        const name = String(row[nameIdx] ?? '').trim();
        if (!name || findByName(name)) { skipped++; continue; }
        const typeIdx = roles.indexOf('type');
        const rowType = typeIdx >= 0 ? typeByLabel[String(row[typeIdx] ?? '').trim().toLowerCase()] : null;
        const e = newEntity(name, rowType || typeKey);
        const tags = new Set();
        roles.forEach((role, i) => {
          const cell = String(row[i] ?? '').trim();
          if (!cell) return;
          if (role === 'field') e.fields[headers[i]] = cell;
          if (role === 'tags') cell.split(';').map((t) => t.trim().toLowerCase()).filter(Boolean).forEach((t) => tags.add(t));
        });
        e.tags = [...tags].slice(0, 6);
        await saveEntity(e);
        imported++;
      }
      headers = []; data = []; selects = [];
      return { done: `Done: imported ${imported}, skipped ${skipped} (blank or already existed).` };
    },
  };
}

// ---------- World Anvil ----------

function worldAnvilImporter() {
  let staged = [];
  return {
    id: 'worldanvil',
    title: 'World Anvil export',
    desc: () => el('p', { class: 'muted small' },
      'Escaping a subscription? Pick your exported article JSON (one file or several). ',
      'Articles become entries: people → NPCs, settlements → locations, organizations → factions, and so on. ',
      'Formatting is converted best-effort; images stay behind (World Anvil hosts them).'),
    pick: { kind: 'file', accept: '.json', multiple: true },
    typeDefault: 'note',
    async stage(files) {
      staged = [];
      for (const f of files) {
        try { staged.push(...parseWorldAnvil(JSON.parse(await f.text()))); }
        catch { /* count the file as unreadable below */ }
      }
      if (!staged.length) return { summary: 'No articles found — export articles as JSON from World Anvil and pick those files.', ready: false };
      const byType = {};
      for (const a of staged) byType[a.type] = (byType[a.type] || 0) + 1;
      return {
        summary: `${staged.length} article${staged.length === 1 ? '' : 's'}: ` +
          Object.entries(byType).map(([t, n]) => `${n} ${t}`).join(', ') + '.',
        ready: true,
      };
    },
    async commit({ typeKey }) {
      let imported = 0, skipped = 0;
      for (const a of staged) {
        if (!a.name || findByName(a.name)) { skipped++; continue; }
        const e = newEntity(a.name, types()[a.type] ? a.type : typeKey);
        e.blocks = htmlToBlocks(a.html);
        e.tags = a.tags.slice(0, 6);
        await saveEntity(e);
        imported++;
      }
      staged = [];
      return { done: `Done: imported ${imported}, skipped ${skipped} (already existed or unnamed).` };
    },
  };
}

// ---------- Foundry VTT ----------

function foundryImporter() {
  let journals = [], actors = [], other = 0;
  return {
    id: 'foundry',
    title: 'Foundry VTT journals & actors',
    desc: () => el('p', { class: 'muted small' },
      'Pick exported journal or actor JSON (right-click → Export Data in Foundry), or a compendium .db file. ',
      'Journals become entries with their pages as sections; D&D 5e actors bring a full statblock, other systems come as notes.'),
    pick: { kind: 'file', accept: '.json,.db', multiple: true },
    typeDefault: 'note',
    async stage(files) {
      journals = []; actors = []; other = 0;
      for (const f of files) {
        for (const doc of parseFoundryText(await f.text())) {
          if (!doc?.name) { other++; continue; }
          if (Array.isArray(doc.pages) || typeof doc.content === 'string') journals.push(doc);
          else if (doc.system?.abilities || doc.data?.abilities || doc.type === 'npc' || doc.type === 'character') actors.push(doc);
          else other++;
        }
      }
      if (!journals.length && !actors.length) {
        return { summary: 'Nothing usable found — export journals or actors from Foundry as JSON.', ready: false };
      }
      return {
        summary: `${journals.length} journal${journals.length === 1 ? '' : 's'}, ${actors.length} actor${actors.length === 1 ? '' : 's'}${other ? `, ${other} other document${other === 1 ? '' : 's'} skipped` : ''}.`,
        ready: true,
      };
    },
    async commit({ typeKey }) {
      let imported = 0, skipped = 0;
      for (const doc of journals) {
        if (findByName(doc.name)) { skipped++; continue; }
        const e = newEntity(doc.name, typeKey);
        e.blocks = foundryJournalToBlocks(doc);
        await saveEntity(e);
        imported++;
      }
      for (const doc of actors) {
        if (findByName(doc.name)) { skipped++; continue; }
        const stat = foundryActorToStat(doc);
        const e = newEntity(doc.name, types().npc ? 'npc' : typeKey);
        if (stat) {
          e.blocks = [{ id: uid(), kind: 'statblock', text: '', secret: false, stat }];
        } else {
          const bio = doc.system?.details?.biography?.value || '';
          e.blocks = bio ? htmlToBlocks(bio) : [{ id: uid(), kind: 'text', text: '', secret: false }];
        }
        await saveEntity(e);
        imported++;
      }
      journals = []; actors = [];
      return { done: `Done: imported ${imported}, skipped ${skipped} (already existed). Non-D&D actors arrive without statblocks.` };
    },
  };
}

// Registry — stage() parses and previews, commit() writes entities.
const IMPORTERS = [markdownImporter, csvImporter, worldAnvilImporter, foundryImporter];

// ---------- generic card over a registry entry ----------

function importerCard(spec) {
  const status = el('div', { class: 'small muted', style: 'margin-top:8px' });
  const previewWrap = el('div', {});
  const typeSel = el('select', {},
    Object.entries(types()).map(([key, t]) =>
      el('option', { value: key, selected: key === spec.typeDefault }, t.label)));
  const input = el('input', {
    type: 'file', style: 'display:none',
    ...(spec.pick.kind === 'folder'
      ? { webkitdirectory: true, multiple: true }
      : { accept: spec.pick.accept || '', ...(spec.pick.multiple ? { multiple: true } : {}) }),
  });
  let ready = false;

  input.addEventListener('change', async () => {
    previewWrap.innerHTML = '';
    ready = false;
    const files = [...input.files];
    if (!files.length) return;
    status.textContent = 'Reading…';
    try {
      const res = await spec.stage(files);
      status.textContent = res.summary;
      if (res.preview) previewWrap.append(res.preview);
      ready = !!res.ready;
    } catch (err) {
      status.textContent = 'Could not read that: ' + err.message;
    }
  });

  const run = async () => {
    if (!ready) { input.click(); return; }
    status.textContent = 'Importing…';
    try {
      const res = await spec.commit({ typeKey: typeSel.value, setStatus: (s) => { status.textContent = s; } });
      status.textContent = res.done;
      previewWrap.innerHTML = '';
      ready = false;
      input.value = '';
      toast('Import finished');
    } catch (err) {
      status.textContent = 'Import failed: ' + err.message;
    }
  };

  return el('div', { class: 'card' },
    el('h3', {}, spec.title),
    spec.desc(),
    el('div', { class: 'row' },
      el('button', { onclick: () => input.click() }, spec.pick.kind === 'folder' ? '📁 Choose folder…' : '📄 Choose file…'),
      el('span', { class: 'muted small' }, 'imported as'), typeSel,
      el('button', { class: 'primary', onclick: run }, 'Import')),
    status, previewWrap, input);
}

// ---------- bestiary browser (bespoke) ----------

function bestiaryCard() {
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

  return el('div', { class: 'card' },
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
      'licensed under Creative Commons Attribution 4.0.'));
}

// ---------- old-install migration (bespoke) ----------

function migrateCard() {
  const status = el('div', { class: 'small muted', style: 'margin-top:8px' });
  const results = el('div', {});
  const pathInput = el('input', { placeholder: 'or paste a path to an old MundusMaker/Loreweave folder…', style: 'flex:1;min-width:0' });

  function renderResults(found) {
    results.innerHTML = '';
    if (!found.length) {
      status.textContent = 'Nothing found. If your old copy lives elsewhere, paste its folder path above — the app folder and its data folder both work.';
      return;
    }
    status.textContent = `Found ${found.length} older install${found.length === 1 ? '' : 's'}. Nothing is copied until you say so; the old install is never modified.`;
    for (const inst of found) {
      const checks = new Map();
      const rows = inst.worlds.map((w) => {
        const cb = el('input', { type: 'checkbox', checked: true });
        checks.set(w.id, cb);
        return el('label', { class: 'import-row' }, cb,
          el('span', {}, w.name),
          el('span', { class: 'muted small' }, `${w.entities} ${w.entities === 1 ? 'entry' : 'entries'}`));
      });
      const copyBtn = el('button', {
        class: 'primary',
        onclick: async () => {
          const ids = [...checks.entries()].filter(([, cb]) => cb.checked).map(([id]) => id);
          if (!ids.length) { toast('Tick at least one world'); return; }
          copyBtn.disabled = true;
          try {
            const res = await api.migrateInstall(inst.dataDir, ids);
            await refreshWorlds();
            const names = res.migrated.map((m) => `“${m.name}”`).join(', ');
            // copying is recorded, so a world already brought over unchanged is not duplicated
            const already = (res.skipped || []).filter((s) => s.reason === 'already copied');
            if (already.length) toast(`Already copied earlier, so not duplicated: ${already.map((s) => `“${s.name}”`).join(', ')}`, 6000);
            status.textContent = `✓ Copied ${res.migrated.length} world${res.migrated.length === 1 ? '' : 's'} in: ${names}. Open them from the world menu in the top bar. The old install still has its own copy.`;
            toast(`Copied ${res.migrated.length} world(s) in`);
          } catch (err) {
            toast('Migration failed: ' + err.message, 5000);
            copyBtn.disabled = false;
          }
        },
      }, '⬇ Copy selected in');
      results.append(el('div', { class: 'notice', style: 'margin-top:10px' },
        el('div', { class: 'small' }, el('strong', {}, inst.path),
          el('span', { class: 'muted' }, inst.layout === 'v1' ? ' (single-world, old format)' : '')),
        el('div', { class: 'muted small', style: 'margin-bottom:6px' }, 'data: ', el('code', {}, inst.dataDir)),
        rows, el('div', { class: 'row', style: 'margin-top:8px' }, copyBtn)));
    }
  }

  const scan = async (fn) => {
    status.textContent = 'Looking…';
    results.innerHTML = '';
    try { renderResults(await fn()); }
    catch (err) { status.textContent = 'Scan failed: ' + err.message; }
  };

  return el('div', { class: 'card' },
    el('h3', {}, 'Move in from an older install'),
    el('p', { class: 'muted small' },
      'Upgraded from Loreweave, or unzipped a new MundusMaker next to an old one? This finds the old ',
      'copy and brings its worlds in — as copies, with the original left untouched.'),
    el('div', { class: 'row' },
      el('button', { class: 'primary', onclick: () => scan(api.scanInstalls) }, '🔍 Scan for old installs'),
      pathInput,
      el('button', { onclick: () => { if (pathInput.value.trim()) scan(() => api.scanPath(pathInput.value.trim())); else pathInput.focus(); } }, 'Check this path')),
    status, results);
}

// ---------- backup restore (bespoke; typed confirm) ----------

function restoreCard() {
  const status = el('div', { class: 'small muted', style: 'margin-top:8px' });
  const input = el('input', { type: 'file', accept: '.json', style: 'display:none' });
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    const typed = prompt(
      `Restoring replaces ALL entries in the current world with the backup's.\n` +
      `A safety snapshot is taken first (data/.snapshots).\n\n` +
      `Type the world's name (${state.world.name}) to continue:`);
    if (typed === null) return;
    if (typed.trim() !== state.world.name) { toast('Name didn’t match — nothing was changed.', 5000); return; }
    try {
      status.textContent = 'Restoring…';
      const payload = JSON.parse(await file.text());
      await requireSaved();
      await api.restore(payload);
      location.reload();
    } catch (err) {
      status.textContent = 'Restore failed: ' + err.message;
    }
  });
  return el('div', { class: 'card' },
    el('h3', {}, 'Restore a backup'),
    el('p', { class: 'muted small' },
      'Load a backup .json (from the Settings page) into the current world — for moving between machines ',
      'or undoing disasters. Everything currently in this world is replaced; a snapshot of it is kept in ',
      el('code', {}, 'data/.snapshots'), ' just in case.'),
    el('div', { class: 'row' },
      el('button', { onclick: () => input.click() }, '↩ Restore from backup…')),
    status, input);
}

// ---------- page ----------

export function render(container) {
  if (!state.gm) {
    container.append(el('div', { class: 'page' }, el('div', { class: 'notice warn' }, 'Importing is a GM activity — switch to GM view first.')));
    return;
  }

  container.append(el('div', { class: 'page' },
    el('h1', {}, 'Import'),
    // the phone app has no older installs beside it to scan (mobile/)
    window.mundusShell ? null : migrateCard(),
    ...IMPORTERS.map((make) => importerCard(make())),
    bestiaryCard(),
    restoreCard(),
    el('p', { class: 'muted small' },
      'Everything imports into the current world (', el('strong', {}, state.world.name), '). Files are read locally in your browser — nothing is uploaded anywhere.')));
}
