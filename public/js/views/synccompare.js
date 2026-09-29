// Sync-conflict compare (1.9). A folder-sync tool keeps both versions when an
// entry changes on two devices at once; this shows the copy beside the entry
// MundusMaker uses. "Use this version" snapshots the world, saves the copy
// through the server's revision check and moves the copy to the trash.
// "Keep current" moves the copy to the trash. Both stay recoverable in
// Settings → Trash & snapshots. GM view only (the banner is GM-only).

import { el, toast } from '../util.js';
import { state, loadAll } from '../state.js';
import { api } from '../api.js';
import { mdToPlain } from '../markdown.js';

const when = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? 'unknown' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); };

function summary(e) {
  if (!e) return { head: 'Missing', parts: [] };
  const parts = [
    ['Name', e.name],
    ['Last changed', when(e.updated)],
    ['Tags', (e.tags || []).join(', ')],
    ['Quick facts', Object.entries(e.fields || {}).filter(([, v]) => String(v).trim()).map(([k, v]) => `${k}: ${v}`).join('\n')],
    ...(e.blocks || []).map((b, i) => [`Block ${i + 1}${b.secret ? ' · secret' : ''}${b.kind !== 'text' ? ` · ${b.kind}` : ''}`,
      b.text != null ? mdToPlain(b.text) : JSON.stringify(b.stat || b.table || b.enc || b.data || {}).slice(0, 400)]),
    ['Relations', (e.relations || []).map((r) => `${r.label || 'related to'} → ${r.to}`).join('\n')],
  ];
  return { head: e.name, parts };
}

export async function compareSyncCopy(issue) {
  if (!state.gm) return;
  const file = String(issue.file || '').replace(/^entities\//, '');
  let data;
  try { data = await api.syncCopy(file); } catch (err) { toast(err.message, 5000); return; }
  const a = summary(data.current), b = summary(data.copy);
  const labels = [...new Set([...a.parts.map(([k]) => k), ...b.parts.map(([k]) => k)])];
  const valueOf = (s, k) => s.parts.find(([x]) => x === k)?.[1] || '';
  const rows = labels.map((k) => {
    const left = valueOf(a, k), right = valueOf(b, k), differs = left !== right;
    return el('div', { class: `sc-row${differs ? ' differs' : ''}` }, el('div', { class: 'sc-key' }, k),
      el('div', { class: 'sc-cell' }, left || '—'), el('div', { class: 'sc-cell' }, right || '—'));
  });
  const close = () => overlay.remove();
  const act = async (action) => {
    const question = action === 'adopt'
      ? 'Use the copy as the entry? A snapshot of the world is taken first, the current version stays in the entry’s history, and the copy moves to the trash.'
      : 'Keep the current entry and move the copy to the trash? You can restore it from Settings → Trash & snapshots.';
    if (!confirm(question)) return;
    try {
      await api.resolveSyncCopy(file, action, data.revision);
      close();
      await loadAll(state.worldId);
      toast(action === 'adopt' ? 'The copy is now the entry. The old version is in its history.' : 'The copy moved to the trash.', 5000);
    } catch (err) { toast(err.message, 6000); }
  };
  const overlay = el('div', { class: 'overlay' }, el('div', { class: 'dialog sc-dialog', role: 'dialog', 'aria-modal': 'true' },
    el('h3', {}, `Compare “${b.head}”`),
    el('p', { class: 'muted small' }, `${issue.file}: ${issue.message}`),
    el('div', { class: 'sc-row sc-head' }, el('div', {}), el('div', {}, 'Current entry'), el('div', {}, 'Sync copy')),
    rows,
    el('div', { class: 'row', style: 'justify-content:flex-end;margin-top:12px;flex-wrap:wrap' },
      el('button', { class: 'ghost', onclick: close }, 'Close'),
      data.current ? el('button', { onclick: () => act('discard') }, 'Keep current, move copy to trash') : null,
      el('button', { class: 'primary', onclick: () => act('adopt') }, 'Use this version'))));
  document.body.append(overlay);
}
