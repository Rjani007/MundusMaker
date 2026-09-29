// Categories use the world's existing types. Relationships are derived from
// visible entities on every render; no cached names or extra secrecy flags.
export function categoryKey(label, known) {
  const base = String(label).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'category';
  let key = base, n = 2;
  while (Object.hasOwn(known, key) || ['__proto__', 'constructor', 'prototype'].includes(key)) key = `${base}-${n++}`;
  return key;
}

export function categoryGroups(known, entities) {
  const extra = new Map();
  for (const e of entities) {
    const key = e.type || '';
    if (!Object.hasOwn(known, key) && !extra.has(key)) extra.set(key, {
      label: key || 'Untyped', plural: key || 'Untyped', color: '#8a8f98', fields: [],
    });
  }
  return [...Object.entries(known), ...[...extra].sort(([a], [b]) => a.localeCompare(b))];
}

export function relatedEntries(entities, id, gm) {
  const visible = entities.filter(e => gm || !e.gmOnly);
  const byId = new Map(visible.map(e => [e.id, e]));
  if (!byId.has(id)) return [];
  const found = new Map();
  for (const e of visible) for (const r of e.relations || []) {
    if ((!gm && r.secret) || !byId.has(r.to)) continue;
    const other = e.id === id ? byId.get(r.to) : r.to === id ? e : null;
    if (other && other.id !== id) found.set(other.id, { entry: other, label: r.label || 'Related' });
  }
  return [...found.values()].sort((a, b) => a.entry.name.localeCompare(b.entry.name));
}

export function connectedGroups(entities, members, gm) {
  const visible = entities.filter(e => gm || !e.gmOnly);
  const byId = new Map(visible.map(e => [e.id, e]));
  const edges = new Map(visible.map(e => [e.id, new Set()]));
  for (const e of visible) for (const r of e.relations || []) {
    if ((!gm && r.secret) || !byId.has(r.to)) continue;
    edges.get(e.id).add(r.to); edges.get(r.to).add(e.id);
  }
  const wanted = new Set(members.filter(e => byId.has(e.id)).map(e => e.id));
  const visited = new Set(), groups = [], alone = [];
  for (const id of wanted) {
    if (visited.has(id)) continue;
    const queue = [id], component = []; visited.add(id);
    for (let i = 0; i < queue.length; i++) {
      const next = queue[i]; component.push(byId.get(next));
      for (const neighbor of edges.get(next)) if (!visited.has(neighbor)) { visited.add(neighbor); queue.push(neighbor); }
    }
    const items = component.filter(e => wanted.has(e.id)).sort((a, b) => a.name.localeCompare(b.name));
    if (items.length === 1 && component.length === 1) { alone.push(...items); continue; }
    const hub = component.filter(e => !wanted.has(e.id)).sort((a, b) => edges.get(b.id).size - edges.get(a.id).size || a.name.localeCompare(b.name))[0];
    groups.push({ label: hub?.name || items.slice(0, 2).map(e => e.name).join(' & '), items });
  }
  groups.sort((a, b) => a.label.localeCompare(b.label));
  if (alone.length) groups.push({ label: 'No connections yet', items: alone.sort((a, b) => a.name.localeCompare(b.name)) });
  return groups;
}
