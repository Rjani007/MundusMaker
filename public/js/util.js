// Shared utilities: DOM helpers, seeded RNG, value noise, slugs.

// ---------- remembered settings ----------
// Keys are brand-namespaced, so the Loreweave → MundusMaker rename would have
// orphaned every existing user's active world, GM toggle and sidebar state.
// Reads fall back through LEGACY_PREFIXES and adopt the value under the current
// name; the old key is never deleted, so downgrading to an older build still
// works. If the app is ever renamed again, prepend the outgoing prefix here —
// do not add another bespoke fallback at each call site.
const PREFIX = 'mundusmaker.';
const LEGACY_PREFIXES = ['tomeweaver.', 'loreweave.']; // newest legacy first

/** Read a remembered setting, migrating it forward from a previous app name. */
export function readSetting(key) {
  const current = localStorage.getItem(PREFIX + key);
  if (current !== null) return current;
  for (const old of LEGACY_PREFIXES) {
    const legacy = localStorage.getItem(old + key);
    if (legacy !== null) {
      localStorage.setItem(PREFIX + key, legacy); // adopt once, leave the old key alone
      return legacy;
    }
  }
  return null; // null, never the string 'null' — callers rely on `|| default`
}

export function writeSetting(key, value) {
  localStorage.setItem(PREFIX + key, value);
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function slugify(name) {
  const s = String(name).toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return s || 'entity';
}

export function uid() {
  return Math.random().toString(36).slice(2, 8);
}

/** Small "?" bubble that reveals an explanation on hover (CSS .help-tip). */
export function helpTip(text) {
  return el('span', { class: 'help-tip', 'data-tip': text, 'aria-label': text }, '?');
}

let toastTimer = null;

/** Hide the toast now (used by its own ✕ and after an action fires). */
export function hideToast() {
  clearTimeout(toastTimer);
  document.getElementById('toast')?.classList.remove('show');
}

/**
 * Transient message at the bottom of the screen.
 * `action` ({ label, onAction }) adds one button — that's how Undo is offered.
 * There is only ever ONE toast node, so a newer message replaces the older one
 * and takes its button with it; that is what keeps undo single-step, and why
 * callers must not treat a pending action as something they can rely on later.
 */
export function toast(msg, ms = 2600, action = null) {
  let t = document.getElementById('toast');
  if (!t) {
    t = el('div', { id: 'toast' });
    document.body.append(t);
  }
  t.innerHTML = '';
  t.append(el('span', {}, msg));
  if (action?.label && typeof action.onAction === 'function') {
    t.append(
      el('button', {
        class: 'toast-action',
        onclick: () => { hideToast(); action.onAction(); },
      }, action.label),
      el('button', {
        class: 'toast-close', title: 'Dismiss', 'aria-label': 'Dismiss', onclick: hideToast,
      }, '✕'));
  }
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ---------- seeded randomness ----------

export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// mulberry32 — small fast deterministic PRNG
export function makeRng(seed) {
  let a = typeof seed === 'number' ? seed >>> 0 : hashSeed(seed);
  const rng = function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.range = (min, max) => min + rng() * (max - min);
  rng.int = (min, max) => Math.floor(rng.range(min, max + 1));
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
  rng.chance = (p) => rng() < p;
  return rng;
}

// ---------- value noise (for map generation) ----------

function latticeHash(seed, xi, yi) {
  let h = seed ^ Math.imul(xi, 374761393) ^ Math.imul(yi, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t) => t * t * (3 - 2 * t);

export function makeNoise2D(seed) {
  const s = typeof seed === 'number' ? seed >>> 0 : hashSeed(seed);
  return function noise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const v00 = latticeHash(s, xi, yi);
    const v10 = latticeHash(s, xi + 1, yi);
    const v01 = latticeHash(s, xi, yi + 1);
    const v11 = latticeHash(s, xi + 1, yi + 1);
    const u = smooth(xf), v = smooth(yf);
    return v00 * (1 - u) * (1 - v) + v10 * u * (1 - v) + v01 * (1 - u) * v + v11 * u * v;
  };
}

export function makeFbm(seed, octaves = 5, lacunarity = 2, gain = 0.5) {
  const noise = makeNoise2D(seed);
  return function fbm(x, y) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * noise(x * freq + i * 17.13, y * freq + i * 9.71);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  };
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Roll dice notation like "2d6+3". Returns { rolls, mod, total, nat } or null. */
export function rollDice(notation) {
  const m = String(notation).replace(/\s+/g, '').match(/^(\d{1,3})d(\d{1,4})([+-]\d{1,3})?$/i);
  if (!m) return null;
  const n = Number(m[1]), sides = Number(m[2]), mod = Number(m[3] || 0);
  if (n < 1 || sides < 2) return null;
  const rolls = [];
  for (let i = 0; i < n; i++) rolls.push(1 + Math.floor(Math.random() * sides));
  const total = rolls.reduce((s, r) => s + r, 0) + mod;
  const nat = n === 1 && sides === 20 && (rolls[0] === 20 || rolls[0] === 1) ? rolls[0] : null;
  return { rolls, mod, total, nat };
}

export function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
