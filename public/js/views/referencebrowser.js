import { el, uid } from '../util.js';
import { visibleEntities, newEntity, saveEntity } from '../state.js';
import { mdToHtml } from '../render.js';
import { DM_REFERENCES, REFERENCE_SYSTEMS, referenceMatches, referenceCopy, existingReference } from '../dmreferences.js';

export function referenceBrowser({ current, pin, pins }) {
  let selected = DM_REFERENCES[0], busy = false;
  const pending = new Map();
  const list = el('div', { class: 'dm-reference-list', 'aria-label': 'Ready-written references' });
  const preview = el('div', { class: 'dm-reference-preview' });
  const status = el('p', { class: 'small dm-reference-status', role: 'status' });
  const system = el('select', { 'aria-label': 'Reference game system', onchange: () => { refreshTopics(); refresh(); } },
    REFERENCE_SYSTEMS.map(s => el('option', { value: s.id }, s.label)));
  const topic = el('select', { 'aria-label': 'Reference topic', onchange: () => refresh() });
  const query = el('input', { type: 'search', placeholder: 'Find a rule, skill or condition…', 'aria-label': 'Search ready-written rules', oninput: () => refresh() });
  const note = el('p', { class: 'muted small' });
  function refreshTopics() {
    topic.replaceChildren(el('option', { value: '' }, 'All topics'),
      ...[...new Set(DM_REFERENCES.filter(r => r.system === system.value).map(r => r.topic))].map(t => el('option', { value: t }, t)));
  }
  async function add(reference) {
    if (!current() || busy) return;
    busy = true; status.textContent = 'Saving reference…'; refresh();
    const entry = pending.get(reference.id) || existingReference(visibleEntities(), reference.id, pins()) || referenceCopy(reference, newEntity, uid);
    pending.set(reference.id, entry);
    try {
      // Save even an existing copy: a previous attempt may have failed after
      // registration in state. Never reapply a template over a DM's edits.
      await saveEntity(entry);
      pending.delete(reference.id);
      if (!current()) return;
      pin(entry.id);
      status.textContent = `Pinned ${entry.name}. Your editable copy is saved in this world.`;
    } catch (err) {
      if (current()) status.textContent = `Could not save: ${err.message}. Retry to save the same reference.`;
    } finally {
      busy = false;
      if (current()) refresh();
    }
  }
  function refresh() {
    const matches = DM_REFERENCES.filter(r => referenceMatches(r, { system: system.value, topic: topic.value, query: query.value }));
    if (!matches.includes(selected)) selected = matches[0];
    note.textContent = REFERENCE_SYSTEMS.find(s => s.id === system.value).note;
    const entries = visibleEntities();
    list.replaceChildren(...matches.map(r => {
      const copy = existingReference(entries, r.id, pins());
      return el('button', { type: 'button', class: `dm-reference-choice${r === selected ? ' selected' : ''}`, 'aria-pressed': r === selected,
        onclick: () => { selected = r; refresh(); } },
      el('strong', {}, r.title), el('span', { class: 'muted small' }, `${r.topic}${copy && pins().includes(copy.id) ? ' · Pinned' : copy ? ' · Saved copy' : ''}`));
    }));
    if (!matches.length) list.append(el('p', { class: 'muted' }, 'No matching references. Try another topic or a shorter search.'));
    preview.replaceChildren();
    if (!selected) return;
    const reference = selected, copy = existingReference(entries, reference.id, pins()), pinned = copy && pins().includes(copy.id);
    const body = el('div', { class: 'block-content dm-reference-text', tabindex: 0, 'aria-label': `${reference.title} template preview` });
    body.innerHTML = mdToHtml(reference.text);
    preview.append(el('div', { class: 'dm-reference-heading' },
      el('div', {}, el('span', { class: 'session-eyebrow' }, reference.topic), el('h3', {}, reference.title)),
      el('button', { type: 'button', class: 'primary', disabled: busy || pinned, onclick: () => add(reference) },
        busy ? 'Saving reference…' : pinned ? 'Already pinned' : pending.has(reference.id) ? 'Retry pin' : copy ? 'Pin saved copy' : 'Pin this reference')),
      el('p', { class: 'muted small' }, copy ? 'This previews the original template. Pinning reuses your saved copy and keeps your edits.' : reference.description), body,
      el('details', { class: 'dm-reference-source' }, el('summary', {}, 'Source & attribution'),
        el('a', { href: reference.source, target: '_blank', rel: 'noopener noreferrer' }, reference.sourceTitle), el('p', { class: 'muted small' }, reference.notice)));
  }
  const element = el('details', { class: 'dm-reference-browser', open: pins().length === 0 },
    el('summary', {}, `Browse ready-written rules · ${DM_REFERENCES.length} references`),
    el('div', { class: 'reference-picker' }, system, topic, query), note,
    el('div', { class: 'dm-reference-layout' }, list, preview), status,
    el('p', { class: 'muted small' }, '🔒 Pinning creates a GM-only Note you can edit. Nothing is added until you pin a reference.'));
  refreshTopics(); refresh();
  return { element, refresh };
}
