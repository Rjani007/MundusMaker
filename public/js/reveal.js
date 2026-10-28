// Reveal to players (1.9): the dialog that confirms a reveal and picks the
// session it is logged on, and the log with Undo shown on Session entries.
// The rules themselves live in revealcore.js. GM-only throughout: callers
// only offer these controls in GM view, and nothing here reaches an export.

import { el, uid, readSetting, toast, compareNames } from './util.js';
import { state, getEntity, scheduleSave } from './state.js';
import { mdToPlain } from './markdown.js';
import { applyReveal, locate, revealStatus, undoReveal, OVERLAY_LISTS } from './revealcore.js';

const BLOCK_NOUNS = { text: 'text block', heading: 'heading', quote: 'quote', statblock: 'statblock', encounter: 'encounter', sheet: 'character sheet', table: 'random table' };

/** Session entries, most recently updated first. */
export function sessionEntries() {
  return [...state.entities.values()].filter((e) => e.type === 'session')
    .sort((a, b) => (b.updated || '').localeCompare(a.updated || '') || compareNames(a.name, b.name));
}

/** The session last chosen in the Encounter view, else the latest one. */
export function defaultSessionId() {
  const sessions = sessionEntries();
  let remembered = '';
  try { remembered = readSetting(`encounter.${state.worldId}`) || ''; } catch { /* storage unavailable */ }
  return sessions.some((s) => s.id === remembered) ? remembered : sessions[0]?.id || '';
}

const clip = (s, n = 70) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };

/** Plain words for what a reveal points at, computed from the live world
 *  (records store references only). */
export function describeTarget(entity, spec) {
  if (!entity) return 'an entry that has been deleted';
  const target = locate(entity, spec.kind === 'relation' && spec.relation ? { kind: 'relation', ref: spec.relation.id } : spec);
  const item = spec.relation || target?.item;
  if (spec.kind === 'entry') return `the entry “${entity.name}”`;
  if (!item) return `something in “${entity.name}” that has been deleted`;
  if (spec.kind === 'block') {
    const text = item.text ? mdToPlain(item.text) : item.stat?.name || item.table?.title || '';
    return `a ${BLOCK_NOUNS[item.kind] || 'block'} in “${entity.name}”${text ? `: “${clip(text)}”` : ''}`;
  }
  if (spec.kind === 'relation') {
    const to = getEntity(item.to);
    return `the relation “${item.label || 'related to'}” from “${entity.name}”${to ? ` to “${to.name}”` : ''}`;
  }
  return `a map ${OVERLAY_LISTS[spec.list] || 'item'}${item.label ? ` “${clip(item.label, 40)}”` : ''} on “${entity.name}”`;
}

/**
 * Ask before revealing, and log the reveal on the chosen session. Resolves
 * true when the flag was flipped (the caller re-renders), false otherwise.
 * spec: { kind: 'entry' } | { kind: 'block', ref } | { kind: 'relation', relation }
 *       | { kind: 'overlay', list, ref }
 */
export function confirmReveal(entity, spec) {
  if (!state.gm) return Promise.resolve(false);
  return new Promise((resolve) => {
    const sessions = sessionEntries();
    const chosen = defaultSessionId();
    const select = el('select', { 'aria-label': 'Session to log this reveal on' },
      sessions.map((s) => el('option', { value: s.id, selected: s.id === chosen }, s.name)),
      el('option', { value: '', selected: !chosen }, 'Don’t log this reveal'));
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); finish(false); } };
    const reveal = () => {
      const session = select.value ? getEntity(select.value) : null;
      try {
        applyReveal(entity, spec, { session, makeId: uid });
      } catch (err) {
        toast(err.message);
        finish(false);
        return;
      }
      scheduleSave(entity);
      if (session && session !== entity) scheduleSave(session);
      toast(session ? `Revealed. Logged on ${session.name}, where you can undo it.` : 'Revealed to players.', 4000);
      finish(true);
    };
    const revealBtn = el('button', { class: 'primary', onclick: reveal }, '👁 Reveal to players');
    const overlay = el('div', { class: 'overlay', onclick: (ev) => { if (ev.target === overlay) finish(false); } },
      el('div', { class: 'dialog reveal-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'reveal-title' },
        el('h3', { id: 'reveal-title' }, 'Reveal to players'),
        el('p', {}, 'Reveal ', el('strong', {}, describeTarget(entity, spec)), '?'),
        el('p', { class: 'muted small' }, 'Players will see it in player preview, the player PDF and the player wiki.'),
        el('label', { class: 'reveal-session' }, el('span', {}, 'Log it on'), select),
        el('p', { class: 'muted small' }, sessions.length
          ? 'The session keeps a list of what you revealed, with Undo.'
          : 'There are no Session entries yet, so this reveal won’t be logged. Create one on the Encounter page to keep a list with Undo.'),
        el('div', { class: 'row', style: 'justify-content:flex-end;margin-top:12px' },
          el('button', { class: 'ghost', onclick: () => finish(false) }, 'Cancel'), revealBtn)));
    document.addEventListener('keydown', onKey, true);
    document.body.append(overlay);
    revealBtn.focus();
  });
}

/** A Session entry's reveal log, newest first, with Undo. */
export function revealLog(session, { onChange = () => {} } = {}) {
  const wrap = el('div', { class: 'reveal-log' });
  const when = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  };
  const STATUS = { undone: 'undone', 'hidden-again': 'hidden again', missing: 'deleted since' };
  function draw() {
    wrap.replaceChildren();
    const records = session.reveals || [];
    if (!records.length) {
      wrap.append(el('div', { class: 'muted small' }, 'Nothing revealed yet. When you reveal a secret block, relation, map item or GM-only entry and log it here, it is listed with Undo.'));
      return;
    }
    for (const record of [...records].reverse()) {
      const status = revealStatus(record, state.entities);
      const entity = getEntity(record.entity);
      wrap.append(el('div', { class: `reveal-row${status === 'shown' ? '' : ' done'}` },
        el('span', { class: 'reveal-when' }, when(record.at)),
        el('span', { class: 'reveal-what' }, entity
          ? el('a', { href: `#/${record.kind === 'overlay' ? 'map' : 'e'}/${encodeURIComponent(entity.id)}` }, describeTarget(entity, record))
          : describeTarget(null, record)),
        status === 'shown'
          ? el('button', { class: 'ghost small', title: 'Hide it from players again', onclick: () => undo(record) }, 'Undo')
          : el('span', { class: 'muted small' }, STATUS[status])));
    }
  }
  function undo(record) {
    const result = undoReveal(session, record.id, state.entities);
    if (!result.ok) { toast(result.reason, 5000); draw(); return; }
    scheduleSave(result.entity);
    if (result.entity !== session) scheduleSave(session);
    toast('Hidden from players again.');
    draw();
    onChange(result.entity);
  }
  draw();
  return wrap;
}
