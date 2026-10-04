// Export view: one-click player-safe (or GM) PDF of the whole world, and the
// offline player wiki (player edition only).

import { el, toast, slugify, downloadBlob, helpTip } from '../util.js';
import { state } from '../state.js';
import { buildPdf, typeGroups } from '../pdf.js';
import { buildPlayerWiki } from '../wiki/export.js';
import { safetyCheck } from '../safety.js';

const KIND_LABELS = { text: 'Text', label: 'Map label', image: 'Image', handout: 'Handout' };

function findingsList(findings, onNavigate = () => {}) {
  return el('ul', { class: 'safety-list' }, findings.map((f) => el('li', {},
    el('span', { class: 'safety-kind' }, KIND_LABELS[f.kind] || f.kind),
    el('a', { href: f.href, onclick: onNavigate }, f.message))));
}
import { api } from '../api.js';

export function render(container) {
  const all = [...state.entities.values()];
  if (!all.length) {
    container.append(el('div', { class: 'page' },
      el('h1', {}, 'Export'),
      el('div', { class: 'notice' },
        'Export turns this world into a PDF — a player-safe edition with every secret stripped, or a GM edition with them highlighted. There is nothing in it yet.'),
      el('p', { style: 'margin-top:14px' }, el('a', { href: '#/' }, 'Create your first entry →'))));
    return;
  }
  // same grouping the PDF uses, so entries with an unknown type still get a
  // checkbox here instead of disappearing from the export unannounced
  const groups = typeGroups(all);

  const opts = {
    gm: false,
    includeMaps: true,
    mapScale: 2, // print-quality by default; 1 keeps the file small
    includeTimeline: true,
    includeRelations: true,
    sheetLayout: 'screen',
    roomNumbers: false, // player dungeon maps; GM maps always show them
    typeKeys: new Set(groups.map(([key]) => key)),
  };

  // What a player export actually drops, so the GM can trust the redaction.
  // GM-only entries go wholesale — counting the secrets inside them again would
  // inflate every other number — and maps hide secret stamps and paths as well
  // as markers.
  const kept = all.filter((e) => !e.gmOnly);
  const nGmOnly = all.length - kept.length;
  const nSecretBlocks = kept.reduce((n, e) => n + (e.blocks || []).filter(
    (b) => b.secret && (b.kind === 'statblock' || b.kind === 'encounter' || b.kind === 'sheet' || b.kind === 'table' || b.text?.trim())).length, 0);
  const nSecretRels = kept.reduce((n, e) => n + (e.relations || []).filter((r) => r.secret).length, 0);
  const nSecretMap = kept.reduce((n, e) => n + [
    ...(e.map?.markers || []), ...(e.map?.stamps || []), ...(e.map?.paths || []),
  ].filter((o) => o.secret).length, 0);

  const playerCard = el('div', { class: 'edition-card sel' },
    el('h4', {}, '🛡 Player-safe edition'),
    el('p', {}, 'Strips everything marked secret. Safe to hand to your table.'));
  const gmCard = el('div', { class: 'edition-card' },
    el('h4', {}, '🔒 GM edition'),
    el('p', {}, 'Everything, with secrets highlighted. For your eyes only.'));
  playerCard.addEventListener('click', () => { opts.gm = false; playerCard.classList.add('sel'); gmCard.classList.remove('sel'); updateName(); });
  gmCard.addEventListener('click', () => { opts.gm = true; gmCard.classList.add('sel'); playerCard.classList.remove('sel'); updateName(); });

  const nameEl = el('code', {});
  const filename = () => `${slugify(state.world.name || 'world')}-${opts.gm ? 'gm' : 'player'}-edition.pdf`;
  const updateName = () => { nameEl.textContent = filename(); };
  updateName();

  const check = (label, desc, key) => el('label', { class: 'opt' },
    el('input', { type: 'checkbox', checked: opts[key], onchange: (ev) => { opts[key] = ev.target.checked; } }),
    el('div', {}, el('div', {}, label), el('div', { class: 'desc' }, desc)));

  const typeChecks = el('div', { class: 'row' },
    groups.map(([key, t]) =>
      el('label', { class: 'row small', style: 'gap:5px;cursor:pointer' },
        el('input', {
          type: 'checkbox', checked: true,
          onchange: (ev) => { ev.target.checked ? opts.typeKeys.add(key) : opts.typeKeys.delete(key); },
        }),
        el('span', { class: 'dot', style: `background:${t.color}` }),
        t.plural || t.label)));

  const genBtn = el('button', { class: 'primary', style: 'font-size:16px;padding:10px 26px' }, '📄 Generate PDF');
  const status = el('span', { class: 'muted small' });

  // The safety check lists hidden names, so it is GM view only. It runs before
  // every player export and never blocks one.
  const runCheck = () => safetyCheck({ worldId: state.worldId, entities: state.entities.values(), typeKeys: opts.typeKeys });
  const reviewFirst = () => new Promise((resolve) => {
    if (!state.gm) { resolve(true); return; }
    const findings = runCheck();
    if (!findings.length) { resolve(true); return; }
    const close = (value) => { overlay.remove(); resolve(value); };
    const exportBtn = el('button', { class: 'primary', onclick: () => close(true) }, 'Export anyway');
    const overlay = el('div', { class: 'overlay' }, el('div', { class: 'dialog safety-dialog', role: 'dialog', 'aria-modal': 'true' },
      el('h3', {}, '🛡 Before you share this'),
      el('p', {}, `The safety check found ${findings.length} ${findings.length === 1 ? 'place' : 'places'} where something hidden may still reach players. Each link opens the place to fix it.`),
      findingsList(findings, () => close(false)),
      el('div', { class: 'row', style: 'justify-content:flex-end;margin-top:14px' },
        el('button', { class: 'ghost', onclick: () => close(false) }, 'Cancel'), exportBtn)));
    document.body.append(overlay);
    exportBtn.focus();
  });

  const safetyOut = el('div', { 'aria-live': 'polite' });
  const safetyBtn = el('button', { onclick: () => {
    const findings = runCheck();
    safetyOut.replaceChildren(findings.length
      ? el('div', {}, el('p', { class: 'small' }, `${findings.length} possible ${findings.length === 1 ? 'leak' : 'leaks'}. Fix what you need, then run the check again.`), findingsList(findings))
      : el('p', { class: 'muted small' }, 'Nothing found: no public text, map label, image or handout points at hidden content.'));
  } }, '🛡 Run safety check');

  genBtn.addEventListener('click', async () => {
    if (!opts.gm && !(await reviewFirst())) return;
    genBtn.disabled = true;
    status.textContent = 'Rendering maps and laying out pages…';
    try {
      // yield a frame so the button state paints before the heavy work
      await new Promise((r) => setTimeout(r, 30));
      const doc = await buildPdf(opts);
      const ab = doc.output('arraybuffer');
      const name = filename();
      downloadBlob(new Blob([ab], { type: 'application/pdf' }), name);
      try {
        const res = await api.exportFile(name, arrayBufferToBase64(ab));
        status.textContent = '';
        toast(`PDF saved to ${res.path}`, 5000);
      } catch {
        status.textContent = '';
        toast('PDF downloaded (saving a server copy failed)');
      }
    } catch (err) {
      console.error(err);
      status.textContent = '';
      toast('Export failed: ' + err.message, 5000);
    } finally {
      genBtn.disabled = false;
    }
  });

  const wikiBtn = el('button', { class: 'primary' }, '🌐 Export player wiki');
  const wikiStatus = el('span', { class: 'muted small' });
  wikiBtn.addEventListener('click', async () => {
    if (!(await reviewFirst())) return;
    wikiBtn.disabled = true;
    wikiStatus.textContent = 'Preparing pages…';
    try {
      await new Promise((r) => setTimeout(r, 30));
      const result = await buildPlayerWiki({
        typeKeys: opts.typeKeys,
        include: { maps: opts.includeMaps, timeline: opts.includeTimeline, relations: opts.includeRelations },
        roomNumbers: opts.roomNumbers,
        onProgress: (p) => { wikiStatus.textContent = `Rendering maps and images… ${Math.round(p * 100)}%`; },
      });
      downloadBlob(result.blob, result.name);
      wikiStatus.textContent = '';
      const summary = `${result.stats.entries} ${result.stats.entries === 1 ? 'entry' : 'entries'}, ${result.stats.images} ${result.stats.images === 1 ? 'image' : 'images'}`;
      try {
        // the server's upload limit is 100 MB of base64; a bigger wiki is still downloaded
        if (result.blob.size > 70 * 1024 * 1024) throw new Error('too large to copy');
        const res = await api.exportFile(result.name, arrayBufferToBase64(await result.blob.arrayBuffer()));
        toast(`Player wiki (${summary}) saved to ${res.path}`, 6000);
      } catch {
        toast(`Player wiki downloaded (${summary})`, 5000);
      }
    } catch (err) {
      console.error(err);
      wikiStatus.textContent = '';
      toast('Wiki export failed: ' + err.message, 5000);
    } finally {
      wikiBtn.disabled = false;
    }
  });

  container.append(el('div', { class: 'page' },
    el('h1', {}, 'Export'),
    el('div', { class: 'card' },
      el('h3', {}, 'Edition'),
      el('div', { class: 'edition-cards' }, playerCard, gmCard),
      el('div', { class: 'notice', style: 'margin-top:8px' },
        `A player-safe export drops ${nGmOnly} GM-only ${nGmOnly === 1 ? 'entry' : 'entries'} whole. `
        + `From the entries players do see, it also strips ${nSecretBlocks} secret ${nSecretBlocks === 1 ? 'block' : 'blocks'}, `
        + `${nSecretRels} secret ${nSecretRels === 1 ? 'relation' : 'relations'} and `
        + `${nSecretMap} secret map ${nSecretMap === 1 ? 'item' : 'items'} (pins, stamps and drawings).`,
        helpTip('GM-only: an entry marked 🔒 GM-only never reaches players at all — not in lists, the graph, the timeline, search, or this PDF.'))),
    el('div', { class: 'card export-opts' },
      el('h3', {}, 'Contents'),
      check('Maps', 'Embed each entry’s map, rendered in the chosen edition (secret markers stripped from player maps).', 'includeMaps'),
      el('label', { class: 'opt' },
        el('input', {
          type: 'checkbox', checked: opts.mapScale > 1,
          onchange: (ev) => { opts.mapScale = ev.target.checked ? 2 : 1; },
        }),
        el('div', {}, el('div', {}, 'Print-quality maps'),
          el('div', { class: 'desc' }, 'Render maps at double resolution — crisper on paper, larger file.'))),
      check('Room numbers for players', 'Show room numbers on dungeon maps in the player edition. The GM edition always shows them, and players never see the generator’s IN and GOAL marks.', 'roomNumbers'),
      check('Timeline', 'A chronological section of every dated entry.', 'includeTimeline'),
      check('Relations', 'List each entry’s typed relationships.', 'includeRelations'),
      el('label', { class: 'opt' }, el('select', { 'aria-label': 'Character sheet layout', onchange: ev => { opts.sheetLayout = ev.target.value; } },
        el('option', { value: 'screen' }, 'Same as on screen (V5 arranged like its own sheet)'), el('option', { value: 'standard' }, 'Standard system sheets'), el('option', { value: 'familiar' }, 'Familiar layouts for every game'), el('option', { value: 'compact' }, 'Compact text summaries')),
        el('div', {}, 'Character sheets', el('div', { class: 'desc' }, 'Dedicated D&D, Vampire and Call of Cthulhu pages, with full feature and spell descriptions on continuation pages.'))),
      el('h3', { style: 'margin-top:14px' }, 'Entry types'),
      typeChecks),
    el('div', { class: 'row', style: 'margin-top:20px' },
      genBtn, status,
      el('span', { class: 'spacer' }),
      el('span', { class: 'muted small' }, 'File: ', nameEl)),
    el('p', { class: 'muted small', style: 'margin-top:16px' },
      'The PDF downloads in your browser and a copy is written to the exports folder inside your data directory.'),
    state.gm ? el('div', { class: 'card', style: 'margin-top:22px' },
      el('h3', {}, 'Safety check'),
      el('p', {}, 'Looks for hidden content that could still reach players: public text that names a GM-only entry, map labels that do, images of hidden entries reused in visible ones, and handouts whose source is hidden. It runs by itself before every player export, and only reports: it never changes anything or stops an export.'),
      el('div', { class: 'row' }, safetyBtn), safetyOut) : null,
    el('div', { class: 'card', style: 'margin-top:22px' },
      el('h3', {}, 'Player wiki'),
      el('p', {}, 'A small offline website of everything the player-safe edition shows: entries, relations, the timeline, player maps with their keys, handouts and search. It downloads as a ZIP. Unzip it anywhere, even on a USB stick, and open index.html. It needs no internet connection and no MundusMaker.'),
      el('p', { class: 'muted small' }, 'It always uses the player-safe edition and the contents chosen above. There is no GM version: you already have the app for that.'),
      el('div', { class: 'row', style: 'margin-top:10px' }, wikiBtn, wikiStatus))));
}

function arrayBufferToBase64(ab) {
  const bytes = new Uint8Array(ab);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
