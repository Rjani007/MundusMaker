// Shared toolkit for character-sheet system modules: HTML fragments (dot
// tracks, damage boxes, stat rows), the three table rollers, and the click
// plumbing that makes rendered sheets interactive. System modules import this;
// sheetcore.js imports the modules — no cycles.

import { el, esc, toast } from '../util.js';
import { sliderAria, damageAria, ratingAria, attrsHtml } from './sheetaria.js';

// ---------- HTML fragments (string-based, like statblockHtml) ----------

/** Dot rating ●●●○○ as spans. `edit` makes each dot a click target and the
 *  whole rating one keyboard stop (arrow keys, sheetaria.js). */
export function dotsHtml(value, max = 5, { edit = false, path = '', label = '' } = {}) {
  const aria = edit ? sliderAria({ label, value: value || 0, max }) : ratingAria({ label, value: value || 0, max });
  let out = `<span class="dots"${edit ? ` data-dots="${esc(path)}"` : ''}${attrsHtml(aria)}>`;
  for (let i = 1; i <= max; i++) {
    out += `<span class="dot-p${i <= value ? ' on' : ''}"${edit ? ` data-dot="${i}"` : ''}></span>`;
  }
  return out + '</span>';
}

/** Damage track: boxes cycling none → / (superficial) → X (aggravated). */
export function trackHtml(max, superficial, aggravated, path, label = '') {
  let out = `<span class="track" data-track="${esc(path)}"${attrsHtml(damageAria({ label, max, sup: superficial || 0, agg: aggravated || 0 }))}>`;
  for (let i = 0; i < max; i++) {
    const state = i < aggravated ? 'agg' : i < aggravated + superficial ? 'sup' : '';
    out += `<span class="track-box ${state}" data-box="${i}">${state === 'agg' ? '✕' : state === 'sup' ? '╱' : ''}</span>`;
  }
  return out + '</span>';
}

/** Simple boxes track (spell slots, luck spent…): filled up to `used`. */
export function boxesHtml(max, used, path, label = '') {
  let out = `<span class="track" data-track="${esc(path)}" data-mode="fill"${attrsHtml(sliderAria({ label, value: used || 0, max, text: `${used || 0} of ${max} used` }))}>`;
  for (let i = 0; i < max; i++) {
    out += `<span class="track-box ${i < used ? 'sup' : ''}" data-box="${i}">${i < used ? '●' : ''}</span>`;
  }
  return out + '</span>';
}

/** `label` and `title` are plain text: sheet values reach them unchecked. */
export function rollBtn(payload, label, title) {
  return `<a href="#" class="sheet-roll" data-sheetroll='${esc(JSON.stringify(payload))}' title="${esc(title || 'Click to roll')}">${esc(label)}</a>`;
}

export function kvHtml(k, v) {
  return `<div class="sheet-kv"><span class="sk">${esc(k)}</span><span class="sv">${v}</span></div>`;
}

export function sectionHtml(title, inner) {
  return `<div class="sheet-section"><div class="sheet-sec-title">${esc(title)}</div>${inner}</div>`;
}

/** Uniform random choice for wizard card grids, routed through their normal picker. */
export function surprisePickButton(items, onPick) {
  const choices = Array.isArray(items) ? items : [];
  return el('button', {
    type: 'button', class: 'ghost small', disabled: choices.length === 0,
    title: 'Pick one of these options at random',
    onclick: () => {
      if (!choices.length) return;
      onPick(choices[Math.floor(Math.random() * choices.length)]);
    },
  }, '🎲 Surprise me');
}

// ---------- rollers ----------

const d10 = () => 1 + Math.floor(Math.random() * 10);
const d20 = () => 1 + Math.floor(Math.random() * 20);

/** V5 pool: d10s, some replaced by hunger dice. 6+ succeeds, paired 10s crit. */
export function rollPool(pool, hunger, label) {
  pool = Math.max(1, pool | 0);
  const hungerDice = Math.min(Math.max(0, hunger | 0), pool);
  const normal = [], red = [];
  for (let i = 0; i < pool - hungerDice; i++) normal.push(d10());
  for (let i = 0; i < hungerDice; i++) red.push(d10());
  const all = [...normal, ...red];
  const tens = all.filter((r) => r === 10).length;
  const base = all.filter((r) => r >= 6).length;
  const successes = base + Math.floor(tens / 2) * 2; // each PAIR of 10s adds 2 more
  const crit = tens >= 2;
  const messy = crit && red.includes(10);
  const bestialRisk = red.includes(1);
  const flags = [
    crit ? (messy ? 'MESSY CRITICAL' : 'critical') : '',
    bestialRisk ? 'hunger 1 — bestial failure if this roll fails' : '',
  ].filter(Boolean).join(' · ');
  toast(`🩸 ${label}: ${pool} dice${hungerDice ? ` (${hungerDice} hunger)` : ''} → [${normal.join(', ')}${hungerDice ? ` | 🩸 ${red.join(', ')}` : ''}] = ${successes} success${successes === 1 ? '' : 'es'}${flags ? ` — ${flags}` : ''}`, 6000);
}

/** CoC percentile vs a target, with bonus/penalty tens dice. */
export function rollPercentile(target, label, { bonus = 0, penalty = 0 } = {}) {
  const net = (bonus | 0) - (penalty | 0);
  const units = Math.floor(Math.random() * 10); // 0-9
  const tensCount = 1 + Math.abs(net);
  const tensRolls = [];
  for (let i = 0; i < tensCount; i++) tensRolls.push(Math.floor(Math.random() * 10)); // 0-9 tens
  const values = tensRolls.map((t) => {
    const v = t * 10 + units;
    return v === 0 ? 100 : v;
  });
  const value = net >= 0 ? Math.min(...values) : Math.max(...values);
  let band = '';
  if (Number.isFinite(target) && target > 0) {
    const fumble = value === 100 || (target < 50 && value >= 96);
    band = fumble ? 'FUMBLE'
      : value <= Math.floor(target / 5) ? 'EXTREME success'
      : value <= Math.floor(target / 2) ? 'Hard success'
      : value <= target ? 'Success' : 'Failure';
  }
  const diceNote = net ? ` (${Math.abs(net)} ${net > 0 ? 'bonus' : 'penalty'} ${Math.abs(net) === 1 ? 'die' : 'dice'}: tens ${tensRolls.map((t) => t * 10).join('/')})` : '';
  toast(`🎲 ${label}: ${value}${Number.isFinite(target) && target > 0 ? ` vs ${target}` : ''}${diceNote}${band ? ` — ${band}` : ''}`, 6000);
}

/** d20 check with modifier; mode 'adv' | 'dis' | undefined. */
export function rollCheck(mod, label, mode) {
  const a = d20(), b = d20();
  const rolls = mode ? [a, b] : [a];
  const pick = mode === 'adv' ? Math.max(a, b) : mode === 'dis' ? Math.min(a, b) : a;
  const total = pick + (mod | 0);
  const nat = pick === 20 ? ' — natural 20!' : pick === 1 ? ' — natural 1!' : '';
  const modStr = mod ? ` ${mod > 0 ? '+' : '−'} ${Math.abs(mod)}` : '';
  const shown = mode ? `[${rolls.join(', ')}] ${mode === 'adv' ? 'adv' : 'dis'} → ${pick}` : `[${pick}]`;
  toast(`🎲 ${label}${mode ? ` (${mode === 'adv' ? 'advantage' : 'disadvantage'})` : ''}: ${shown}${modStr} = ${total}${nat}`, 5000);
}

/** One document-level listener for [data-sheetroll]. Shift = advantage/bonus die, Ctrl/Alt = disadvantage/penalty die. */
let wired = false;
export function wireSheetRolls() {
  if (wired) return;
  wired = true;
  document.addEventListener('click', (ev) => {
    const a = ev.target.closest('a.sheet-roll');
    if (!a) return;
    ev.preventDefault();
    ev.stopPropagation();
    let p;
    try { p = JSON.parse(a.dataset.sheetroll); } catch { return; }
    if (p.kind === 'pool') {
      // dynamic pools read the two selects sitting in the same roll bar
      let pool = p.pool, label = p.label;
      const bar = a.closest('.sheet-rollbar');
      if (bar) {
        const [attrSel, skillSel] = bar.querySelectorAll('select');
        const attr = attrSel?.selectedOptions[0], skill = skillSel?.selectedOptions[0];
        pool = Number(attr?.dataset.v || 0) + Number(skill?.dataset.v || 0);
        label = `${attr?.textContent ?? ''} + ${skill?.textContent ?? ''}`.trim();
      }
      rollPool(pool, p.hunger || 0, label || 'Pool');
    } else if (p.kind === 'pct') {
      rollPercentile(p.target, p.label || 'Roll', { bonus: ev.shiftKey ? 1 : 0, penalty: ev.ctrlKey || ev.altKey ? 1 : 0 });
    } else if (p.kind === 'check') {
      rollCheck(p.mod || 0, p.label || 'Check', ev.shiftKey ? 'adv' : ev.ctrlKey || ev.altKey ? 'dis' : undefined);
    }
  }, true);
}

/**
 * In-place sheet interaction (damage boxes, dot edits) on a RENDERED sheet.
 * entity.js calls this from its click handling with the sheet block; returns
 * true when data changed (caller saves + re-renders). Path syntax "a.b.c".
 */
function pathGet(data, path) { return path.split('.').reduce((o, k) => o?.[k], data); }
function pathSet(data, path, value) {
  const keys = path.split('.');
  let obj = data;
  for (const k of keys.slice(0, -1)) obj = obj?.[k];
  if (!obj) return false;
  obj[keys[keys.length - 1]] = value;
  return true;
}

export function handleSheetClick(block, target) {
  const setPath = (path, value) => pathSet(block.data, path, value);
  const getPath = (path) => pathGet(block.data, path);

  const box = target.closest('.track-box');
  const track = target.closest('.track');
  if (box && track?.dataset.track) {
    const path = track.dataset.track;
    const idx = Number(box.dataset.box);
    // numbered tracks (CoC hit points, sanity, luck): click a number to make it current
    if (track.dataset.mode === 'set') return setPath(path, Number(box.dataset.value));
    if (track.dataset.mode === 'fill') {
      // boxes count a single number (slots used, etc.): click box N → used = N+1, click last used → N
      const used = Number(getPath(path) || 0);
      return setPath(path, idx + 1 === used ? idx : idx + 1);
    }
    // damage track cycles none → superficial → aggravated → none across the pair
    const supPath = path + '.superficial', aggPath = path + '.aggravated';
    let sup = Number(getPath(supPath) || 0), agg = Number(getPath(aggPath) || 0);
    const state = idx < agg ? 'agg' : idx < agg + sup ? 'sup' : '';
    if (state === '') sup += 1;
    else if (state === 'sup') { sup -= 1; agg += 1; }
    else agg -= 1;
    return setPath(supPath, Math.max(0, sup)) && setPath(aggPath, Math.max(0, agg));
  }

  const dot = target.closest('.dot-p');
  const dotsEl = target.closest('.dots');
  if (dot && dotsEl?.dataset.dots) {
    const val = Number(dot.dataset.dot);
    const cur = Number(getPath(dotsEl.dataset.dots) || 0);
    return setPath(dotsEl.dataset.dots, val === cur ? val - 1 : val); // click current rating to step down
  }
  return false;
}

/**
 * The keyboard twin of handleSheetClick, for the focused rating or track
 * (sheetaria.js gives each one role="slider" and its bounds). Returns null
 * when the key is not a sheet key, false when it was handled but nothing
 * changed (at a bound), and true when data changed (caller saves, re-renders
 * and focuses the same widget again).
 */
export function handleSheetKey(block, target, { key, shiftKey = false }) {
  const widget = target?.closest?.('[data-dots], [data-track]');
  if (!widget || widget.getAttribute('role') !== 'slider') return null;
  const step = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 5, PageDown: -5 }[key];
  if (step === undefined && key !== 'Home' && key !== 'End') return null;
  const min = Number(widget.getAttribute('aria-valuemin') || 0), max = Number(widget.getAttribute('aria-valuemax') || 0);
  const path = widget.dataset.dots ?? widget.dataset.track;
  if (widget.dataset.dots != null || widget.dataset.mode === 'fill' || widget.dataset.mode === 'set') {
    const cur = Number(pathGet(block.data, path) || 0);
    const next = key === 'Home' ? min : key === 'End' ? max : Math.max(min, Math.min(max, cur + step));
    return next === cur ? false : pathSet(block.data, path, next);
  }
  // damage track: right marks one more superficial (on a full track it turns
  // one superficial into aggravated, as the rules do), left heals one; Shift
  // works on aggravated damage instead
  let sup = Number(pathGet(block.data, path + '.superficial') || 0), agg = Number(pathGet(block.data, path + '.aggravated') || 0);
  const before = `${sup}/${agg}`;
  if (key === 'Home') { sup = 0; agg = 0; }
  else if (key === 'End') sup = Math.max(0, max - agg);
  else if (step > 0) {
    for (let i = 0; i < step; i++) {
      if (sup + agg < max) { if (shiftKey) agg++; else sup++; }
      else if (sup > 0) { sup--; agg++; }
    }
  } else {
    for (let i = 0; i < -step; i++) {
      if (shiftKey ? agg > 0 : sup === 0 && agg > 0) agg--;
      else if (sup > 0) sup--;
    }
  }
  if (`${sup}/${agg}` === before) return false;
  return pathSet(block.data, path + '.superficial', sup) && pathSet(block.data, path + '.aggravated', agg);
}

// ---------- small form helpers for sheet editors ----------

export function frow(label, input) {
  return el('div', { class: 'fr' }, el('label', {}, label), input);
}

export function textInput(value, oninput, attrs = {}) {
  return el('input', { value: value ?? '', oninput: (ev) => oninput(ev.target.value), ...attrs });
}

export function numInput(value, oninput, attrs = {}) {
  return el('input', {
    type: 'number', value: value ?? 0, style: 'width:70px',
    oninput: (ev) => oninput(Number(ev.target.value) || 0), ...attrs,
  });
}

export function areaInput(value, oninput, attrs = {}) {
  const t = el('textarea', { oninput: (ev) => oninput(ev.target.value), rows: 3, ...attrs });
  t.value = value ?? '';
  return t;
}

/** Generic add/remove list editor over an array of objects. */
export function listEdit(list, renderRow, makeNew, onChange) {
  const wrap = el('div', {});
  const redraw = () => {
    wrap.innerHTML = '';
    list.forEach((item, i) => {
      wrap.append(el('div', { class: 'entry-row' },
        renderRow(item, () => onChange()),
        el('button', {
          class: 'ghost danger small', title: 'Remove',
          onclick: () => { list.splice(i, 1); onChange(); redraw(); },
        }, '✕')));
    });
    wrap.append(el('button', {
      class: 'ghost small',
      onclick: () => { list.push(makeNew()); onChange(); redraw(); },
    }, '+ Add'));
  };
  redraw();
  return wrap;
}
