// Weighted random-table blocks. The result is intentionally ephemeral: rolling
// is table play, while the rows themselves are the world data that gets saved.

import { esc } from './util.js';

export function defaultRandomTable() {
  return {
    title: 'Random table',
    rows: [
      { weight: 1, text: '' },
      { weight: 1, text: '' },
    ],
  };
}

export function tableRows(table) {
  return (Array.isArray(table?.rows) ? table.rows : [])
    .map((row) => ({
      text: String(row?.text ?? ''),
      weight: Number.isFinite(Number(row?.weight)) ? Math.max(0, Number(row.weight)) : 1,
    }));
}

export function rollRandomTable(table, rng = Math.random) {
  const rows = tableRows(table).filter((row) => row.text.trim() && row.weight > 0);
  const total = rows.reduce((sum, row) => sum + row.weight, 0);
  if (!total) return null;
  let pick = Math.max(0, Math.min(0.999999999999, Number(rng()) || 0)) * total;
  for (const row of rows) {
    pick -= row.weight;
    if (pick < 0) return row;
  }
  return rows[rows.length - 1];
}

export function randomTableSearchText(table) {
  return [table?.title || '', ...tableRows(table).map((row) => row.text)].join(' ');
}

export function randomTableHtml(table) {
  const rows = tableRows(table);
  const usable = rows.filter((row) => row.text.trim() && row.weight > 0);
  const total = usable.reduce((sum, row) => sum + row.weight, 0);
  const title = String(table?.title || 'Random table');
  const body = rows.map((row) => {
    const chance = total && row.text.trim() && row.weight > 0
      ? `${Math.round((row.weight / total) * 1000) / 10}%`
      : '—';
    return `<tr><td class="rt-weight" title="Weight ${row.weight}">${esc(String(row.weight))}</td><td>${row.text.trim() ? esc(row.text) : '<span class="ph">Empty row…</span>'}</td><td class="muted small">${chance}</td></tr>`;
  }).join('');
  return `<div class="random-table">
    <div class="rt-head"><strong>${esc(title)}</strong><button type="button" class="small" data-table-roll ${total ? '' : 'disabled'}>🎲 Roll</button></div>
    ${rows.length ? `<table><tbody>${body}</tbody></table>` : '<div class="muted small">No rows yet.</div>'}
    <div class="rt-result muted" data-table-result aria-live="polite">${total ? 'Click Roll to draw a result.' : 'Add a weighted row to roll.'}</div>
  </div>`;
}
