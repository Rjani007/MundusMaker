// Maps index: every entity that has a map attached, plus quick map creation.

import { el } from '../util.js';
import { state, types, typeOf, visibleEntities, createEntity, saveEntity } from '../state.js';
import { MAP_KINDS, newMap, renderThumbnail } from '../maps/mapcore.js';

export function render(container) {
  const withMaps = visibleEntities().filter((e) => e.map);

  const cards = el('div', { class: 'map-cards' },
    withMaps.map((e) => {
      const canvas = el('canvas');
      setTimeout(() => renderThumbnail(canvas, e.map, 480, { gm: state.gm }), 0);
      return el('a', { class: 'map-card', href: `#/map/${e.id}`, style: 'text-decoration:none;color:inherit' },
        canvas,
        el('div', { class: 'map-card-body' },
          el('div', {},
            el('span', { class: 'dot', style: `background:${typeOf(e).color};margin-right:8px` }),
            el('strong', {}, e.name),
            e.gmOnly && state.gm ? ' 🔒' : ''),
          el('div', { class: 'muted small' }, MAP_KINDS[e.map.kind]?.label || e.map.kind)));
    }));

  const nameInput = el('input', { placeholder: 'Name (e.g. “Port Vellen”)', style: 'flex:1' });
  const kindSel = el('select', {},
    Object.entries(MAP_KINDS).map(([kind, def]) => el('option', { value: kind }, def.label)));
  const typeSel = el('select', {},
    Object.entries(types()).map(([key, t]) => el('option', { value: key, selected: key === 'location' }, t.label)));

  const createMap = async () => {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    const e = await createEntity(name, typeSel.value);
    e.map = newMap(kindSel.value);
    await saveEntity(e);
    location.hash = `#/map/${e.id}`;
  };

  container.append(el('div', { class: 'page wide', style: 'max-width:1200px;margin:0 auto' },
    el('h1', {}, 'Maps'),
    state.gm ? el('div', { class: 'card' },
      el('h3', {}, 'Generate a new map'),
      el('div', { class: 'row' },
        nameInput, kindSel,
        el('span', { class: 'muted small' }, 'as a new'), typeSel,
        el('button', { class: 'primary', onclick: createMap }, 'Generate')),
      el('div', { class: 'muted small', style: 'margin-top:6px' },
        'Maps are seeded — every map can be re-rolled, then edited by hand: paint terrain, carve dungeon rooms, drop markers and labels. You can also attach a map to an existing entry from its page.')) : null,
    withMaps.length ? cards : el('div', { class: 'notice' },
      state.gm
        ? ['No maps yet — world, region, town, building or dungeon, each one generated from a seed. ',
           el('button', { class: 'small', onclick: () => nameInput.focus() }, 'Generate your first')]
        : ['No maps yet. Maps you make in GM view show up here.'])));
}
