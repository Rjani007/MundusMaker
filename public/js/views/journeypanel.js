// The map editor's Journey planner (1.9), for kinds with `journeys` (region
// maps). Routes over the model's roads and ferries (maps/journey.js). Apply
// can add a secret travel route to the map (undoable like any map edit),
// advance the campaign clock through calendar.js, and log a secret note on a
// Session. Daily table rolls are shown here and never stored. GM view only.

import { el, uid, toast } from '../util.js';
import { state, scheduleSave, scheduleWorldSave } from '../state.js';
import { settlementSites } from '../maps/crossscale.js';
import { travelGraph, planJourney, journeyTime, DEFAULT_PACES } from '../maps/journey.js';
import { advanceDate, formatDate } from '../calendar.js';
import { sessionEntries, defaultSessionId } from '../reveal.js';
import { rollRandomTable, tableRows } from '../randomtable.js';

const fmt = (n) => Number(n.toPrecision(3)).toLocaleString();

/** ctx: { e, map, kind, model(), save(), redraw() } */
export function journeyPanel(ctx) {
  const { e, map, kind } = ctx;
  const wrap = el('div', { class: 'journey-panel' });
  let from = '', to = '', paceKey = 'foot', route = null, rolls = null, tableRef = '';

  const paces = () => DEFAULT_PACES.map((p) => ({ ...p, km: Number(state.world.travelPaces?.[p.key]) > 0 ? Number(state.world.travelPaces[p.key]) : p.km }));
  const paceOf = (key) => paces().find((p) => p.key === key) || paces()[0];
  const sites = () => settlementSites(map, ctx.model(), kind.size(map)).slice().sort((a, b) => a.name.localeCompare(b.name));
  const scale = () => ({ distance: map.params?.distance, units: map.params?.units || 'km', width: kind.size(map)[0] });
  const tables = () => [...state.entities.values()].flatMap((x) => (x.blocks || [])
    .filter((b) => b.kind === 'table' && tableRows(b.table).some((r) => r.text.trim() && r.weight > 0))
    .map((b) => ({ ref: `${x.id}/${b.id}`, label: `${x.name}: ${b.table?.title || 'Random table'}`, table: b.table })));

  function plan() {
    const model = ctx.model();
    route = null; rolls = null;
    if (from && to && from !== to) {
      const roads = map.params?.roads === false ? [] : model.roads || [];
      route = planJourney(travelGraph(sites(), roads, model.ferries || []), from, to) || { none: true };
    }
    refresh();
    ctx.redraw();
  }

  function timing() {
    return route?.legs ? journeyTime(route, scale(), paceOf(paceKey).km, paceOf('ship').km) : null;
  }

  function rollDays(days) {
    const pick = tables().find((t) => t.ref === tableRef);
    rolls = pick ? Array.from({ length: Math.min(days, 60) }, (_, i) => ({ day: i + 1, text: rollRandomTable(pick.table)?.text || '—' })) : null;
    refresh();
  }

  function apply(time, { addRoute, advance, note, sessionId }) {
    const names = [route.legs[0].from.name, ...route.legs.map((l) => l.to.name)];
    const ferries = route.legs.filter((l) => l.mode === 'ferry').map((l) => `ferry from ${l.from.name} to ${l.to.name}`);
    const cal = state.world.calendar || {};
    const start = cal.todayDate;
    const end = advance && time ? advanceDate(start, cal, time.days) : null;
    if (addRoute) {
      const [W, H] = kind.size(map);
      const pts = route.legs.flatMap((l, i) => (i ? l.pts.slice(1) : l.pts)).map(([x, y]) => [x / W, y / H]);
      (map.paths ??= []).push({ id: uid(), style: 'route', pts, color: '', width: 0, closed: false, secret: true });
      ctx.save();
    }
    if (advance && end) {
      cal.todayDate = end;
      cal.today = formatDate(end, cal, state.world.era);
      scheduleWorldSave();
    }
    if (note) {
      const session = state.entities.get(sessionId);
      if (session) {
        const when = end ? ` ${formatDate(start, cal, state.world.era)} to ${formatDate(end, cal, state.world.era)}.` : '';
        const size = time ? `, ${fmt(time.length)} ${time.units} in ${time.days} ${time.days === 1 ? 'day' : 'days'} (${paceOf(paceKey).label.toLowerCase()})` : '';
        (session.blocks ??= []).push({ id: uid(), kind: 'text', secret: true,
          text: `**Journey:** ${names.map((n) => `[[${n}]]`).join(' → ')}${size}${ferries.length ? `, with a ${ferries.join(' and a ')}` : ''}.${when}` });
        scheduleSave(session);
      }
    }
    route = null; rolls = null;
    refresh();
    ctx.redraw();
    toast('Journey applied.' + (advance && !end ? ' The clock was not advanced: set a valid campaign date on the Calendar page first.' : ''), 5000);
  }

  function refresh() {
    wrap.replaceChildren();
    wrap.append(el('h3', {}, '🧭 Journey planner'));
    const all = sites();
    const model = ctx.model();
    if (all.length < 2 || (!(model.roads || []).length && !(model.ferries || []).length)) {
      wrap.append(el('p', { class: 'muted small' }, 'Journeys follow this map’s roads and ferries between its settlements, and this map has none to follow.'));
      return;
    }
    const select = (value, onchange, label) => el('select', { 'aria-label': label, onchange: (ev) => { onchange(ev.target.value); } },
      el('option', { value: '' }, '— choose —'), all.map((s) => el('option', { value: s.key, selected: s.key === value }, s.name)));
    wrap.append(
      el('div', { class: 'param-row' }, el('label', {}, 'From'), select(from, (v) => { from = v; plan(); }, 'Journey start')),
      el('div', { class: 'param-row' }, el('label', {}, 'To'), select(to, (v) => { to = v; plan(); }, 'Journey destination')),
      el('div', { class: 'param-row' }, el('label', {}, 'Pace'), el('select', { 'aria-label': 'Travel pace', onchange: (ev) => { paceKey = ev.target.value; refresh(); } },
        paces().map((p) => el('option', { value: p.key, selected: p.key === paceKey }, `${p.label} · ${p.km} km/day`)))),
      el('details', { class: 'journey-paces' }, el('summary', { class: 'small' }, 'Edit paces'),
        el('p', { class: 'muted small' }, 'Kilometers per day. Generic defaults; set them to your game’s rules. Saved with this world.'),
        paces().map((p) => el('div', { class: 'param-row' }, el('label', {}, p.label), el('input', {
          type: 'number', min: 1, max: 100000, value: p.km, 'aria-label': `${p.label} kilometers per day`,
          onchange: (ev) => {
            const v = Number(ev.target.value);
            if (!(v > 0)) return;
            (state.world.travelPaces ??= {})[p.key] = v;
            scheduleWorldSave();
            refresh();
          },
        })))));
    if (!route) return;
    if (route.none) {
      wrap.append(el('p', { class: 'notice' }, 'No road or ferry connects these two places.'));
      return;
    }
    const time = timing();
    wrap.append(el('ol', { class: 'journey-legs' }, (time?.legs || route.legs).map((leg) => el('li', {},
      `${leg.from.name} → ${leg.to.name}`, leg.mode === 'ferry' ? el('span', { class: 'journey-ferry' }, ' ⛴ ferry') : null,
      time ? el('span', { class: 'muted small' }, ` · ${fmt(leg.length)} ${time.units}`) : null))));
    wrap.append(time
      ? el('p', {}, el('strong', {}, `${fmt(time.length)} ${time.units}, ${time.days} ${time.days === 1 ? 'day' : 'days'}`), ` ${paceOf(paceKey).label.toLowerCase()}${route.legs.some((l) => l.mode === 'ferry') ? `, ferries at ${paceOf('ship').km} km/day` : ''}.`)
      : el('p', { class: 'notice' }, 'Set “Map width” in the Generator panel to measure distance and travel days.'));

    // daily rolls: shown, never stored
    const tableOptions = tables();
    if (time && tableOptions.length) {
      wrap.append(el('div', { class: 'param-row' }, el('label', {}, 'Daily roll'),
        el('select', { 'aria-label': 'Random table to roll each day', onchange: (ev) => { tableRef = ev.target.value; rolls = null; refresh(); } },
          el('option', { value: '' }, '— none —'), tableOptions.map((t) => el('option', { value: t.ref, selected: t.ref === tableRef }, t.label))),
        tableRef ? el('button', { class: 'small', onclick: () => rollDays(time.days) }, rolls ? 'Reroll' : 'Roll') : null));
      if (rolls) wrap.append(el('ol', { class: 'journey-rolls' }, rolls.map((r) => el('li', {}, `Day ${r.day}: ${r.text}`))),
        el('p', { class: 'muted small' }, 'Rolls are not saved. Copy any you keep into a note.'));
    }

    const cal = state.world.calendar || {};
    const next = time ? advanceDate(cal.todayDate, cal, time.days) : null;
    const sessions = sessionEntries();
    const addRoute = el('input', { type: 'checkbox', checked: true });
    const advance = el('input', { type: 'checkbox', checked: !!next, disabled: !next });
    const note = el('input', { type: 'checkbox', checked: !!sessions.length, disabled: !sessions.length });
    const sessionPick = el('select', { 'aria-label': 'Session for the journey note', disabled: !sessions.length },
      sessions.map((s) => el('option', { value: s.id, selected: s.id === defaultSessionId() }, s.name)));
    wrap.append(el('div', { class: 'journey-apply' },
      el('label', { class: 'opt' }, addRoute, el('div', {}, 'Draw the route on this map', el('div', { class: 'desc' }, 'A 🔒 secret travel route. Undo removes it.'))),
      time ? el('label', { class: 'opt' }, advance, el('div', {}, `Advance the campaign clock ${time.days} ${time.days === 1 ? 'day' : 'days'}`,
        el('div', { class: 'desc' }, next ? `${formatDate(cal.todayDate, cal, state.world.era)} → ${formatDate(next, cal, state.world.era)}` : 'Set a valid structured campaign date on the Calendar page first.'))) : null,
      el('label', { class: 'opt' }, note, el('div', {}, 'Add a secret note to a session', el('div', { class: 'desc' }, sessions.length ? sessionPick : 'There are no Session entries yet.'))),
      el('button', { class: 'primary', onclick: () => apply(time, { addRoute: addRoute.checked, advance: advance.checked && !!next, note: note.checked, sessionId: sessionPick.value }) }, 'Apply journey')));
  }

  refresh();
  return {
    element: wrap,
    refresh,
    /** the planned route in native pixels, for the editor's preview line */
    previewPts: () => (route?.legs ? route.legs.flatMap((l, i) => (i ? l.pts.slice(1) : l.pts)) : null),
  };
}
