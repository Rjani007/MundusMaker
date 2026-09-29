// Reveal to players (1.9), pure part. A reveal flips ONE existing flag — a
// block's or a relation's `secret`, a map overlay item's `secret`, or an
// entry's `gmOnly` — and may append a record to a Session entry's optional
// `reveals` list so it can be undone. It adds no flag and copies no content:
// a record holds references and times only, never text. `reveals` is GM-only
// data; no export reads it.

export const OVERLAY_LISTS = { markers: 'marker', stamps: 'stamp', paths: 'drawing' };

/**
 * The flag a reveal spec points at: { kind: 'entry' } | { kind: 'block', ref }
 * | { kind: 'relation', ref } | { kind: 'overlay', list, ref }. Returns
 * { hidden(), hide(v), item } or null when the target no longer exists.
 */
export function locate(entity, spec) {
  if (!entity) return null;
  if (spec.kind === 'entry') return { item: entity, hidden: () => !!entity.gmOnly, hide: (v) => { entity.gmOnly = v; } };
  let item = null;
  if (spec.kind === 'block') item = (entity.blocks || []).find((b) => b.id === spec.ref);
  else if (spec.kind === 'relation') item = (entity.relations || []).find((r) => r.id === spec.ref);
  else if (spec.kind === 'overlay' && Object.hasOwn(OVERLAY_LISTS, spec.list)) item = (entity.map?.[spec.list] || []).find((o) => o.id === spec.ref);
  return item ? { item, hidden: () => !!item.secret, hide: (v) => { item.secret = v; } } : null;
}

/**
 * Reveal a hidden target and, when a session is given, log it there.
 * Relations have no ids of their own, so the first reveal gives one an `id`
 * (an additive key older builds ignore) to make the record a stable reference.
 */
export function applyReveal(entity, spec, { session = null, now = new Date(), makeId }) {
  if (spec.kind === 'relation' && spec.relation) {
    spec = { kind: 'relation', ref: (spec.relation.id ??= makeId()) };
  }
  const target = locate(entity, spec);
  if (!target) throw new Error('That item no longer exists.');
  if (!target.hidden()) throw new Error('Players can already see that.');
  target.hide(false);
  const record = { id: makeId(), at: now.toISOString(), entity: entity.id, kind: spec.kind,
    ...(spec.ref ? { ref: spec.ref } : {}), ...(spec.list ? { list: spec.list } : {}) };
  if (session) (session.reveals ??= []).push(record);
  return record;
}

/** Where a logged reveal stands now. */
export function revealStatus(record, byId) {
  if (record.undoneAt) return 'undone';
  const entity = byId.get(record.entity);
  if (!entity) return 'missing';
  const target = locate(entity, record);
  if (!target) return 'missing';
  return target.hidden() ? 'hidden-again' : 'shown';
}

/**
 * Undo a logged reveal. It restores the hidden flag only when nothing has
 * changed it since; otherwise it explains why not and changes nothing.
 * Returns { ok: true, entity } or { ok: false, reason }.
 */
export function undoReveal(session, recordId, byId, now = new Date()) {
  const record = (session.reveals || []).find((r) => r.id === recordId);
  if (!record) return { ok: false, reason: 'That reveal is no longer in this session’s log.' };
  const status = revealStatus(record, byId);
  if (status === 'undone') return { ok: false, reason: 'That reveal was already undone.' };
  if (status === 'missing') return { ok: false, reason: 'What was revealed has since been deleted, so there is nothing to hide again.' };
  if (status === 'hidden-again') return { ok: false, reason: 'It has been hidden again since, so undo would change nothing.' };
  const entity = byId.get(record.entity);
  locate(entity, record).hide(true);
  record.undoneAt = now.toISOString();
  return { ok: true, entity };
}
