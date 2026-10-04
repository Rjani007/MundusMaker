// Keyboard and screen-reader semantics for the clickable parts of a character
// sheet (dot ratings, damage tracks, slot boxes, numbered tracks). Each one is
// a single tab stop announced as a slider with a name and a value; the arrow
// keys change it (sheetlib.js handleSheetKey). Shared by the HTML sheets
// (sheetlib.js) and the familiar SVG layouts (familiar.js). Pure, no imports.

/** "3 of 5", the value text every rating announces. */
export const ofText = (value, max) => `${value} of ${max}`;

/** Attributes for a rating, a boxes track or a numbered track. */
export function sliderAria({ label, value, max, min = 0, text }) {
  return {
    tabindex: '0', role: 'slider', 'aria-label': label || 'Rating',
    'aria-valuemin': min, 'aria-valuemax': max, 'aria-valuenow': value,
    'aria-valuetext': text ?? ofText(value, max),
  };
}

/** Attributes for a damage track: the value is the damage taken, the text says which kind. */
export function damageAria({ label, max, sup = 0, agg = 0 }) {
  const parts = [sup ? `${sup} superficial` : '', agg ? `${agg} aggravated` : ''].filter(Boolean);
  return sliderAria({ label, value: Math.min(max, sup + agg), max, text: `${parts.length ? parts.join(', ') : 'no damage'}, of ${max}` });
}

/** A read-only rating: an image with its value as its name. */
export function ratingAria({ label, value, max }) {
  return { role: 'img', 'aria-label': `${label ? `${label}: ` : ''}${ofText(value, max)}` };
}

const escAttr = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** ` key="value"` pairs for string-built HTML or SVG. */
export function attrsHtml(attrs) {
  return Object.entries(attrs || {}).filter(([, v]) => v != null && v !== false).map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('');
}

/** Hint shown beside sheets and in Help. */
export const KEY_HINT = 'Tab to a rating or track, then use the arrow keys (Home and End for empty and full; Shift with the arrows marks or heals aggravated damage).';
