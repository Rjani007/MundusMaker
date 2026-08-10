// Export view: one-click player-safe (or GM) PDF of the whole world.

import { el, toast, slugify, downloadBlob, helpTip } from '../util.js';
import { state } from '../state.js';
import { buildPdf, typeGroups } from '../pdf.js';
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

  genBtn.addEventListener('click', async () => {
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
      check('Timeline', 'A chronological section of every dated entry.', 'includeTimeline'),
      check('Relations', 'List each entry’s typed relationships.', 'includeRelations'),
      el('h3', { style: 'margin-top:14px' }, 'Entry types'),
      typeChecks),
    el('div', { class: 'row', style: 'margin-top:20px' },
      genBtn, status,
      el('span', { class: 'spacer' }),
      el('span', { class: 'muted small' }, 'File: ', nameEl)),
    el('p', { class: 'muted small', style: 'margin-top:16px' },
      'The PDF downloads in your browser and a copy is written to the exports folder inside your data directory.')));
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
