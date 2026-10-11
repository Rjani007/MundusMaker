// The markdown-lite grammar, shared by the app (render.js) and the player wiki
// export. Pure: no DOM and no state, so Node tests can import it. Callers decide
// what a [[link]], an embedded image and dice notation become through hooks,
// so the grammar itself can never drift between the two surfaces.
//
//   [[Entity Name]] / [[Entity Name|shown text]]   links
//   ![alt](/assets/…)                             images (world assets only)
//   **bold**  *italic*  `code`
//   - list item        > quoted line
//   blank line         paragraph break

export const WIKILINK = /\[\[([^\][|]+)(?:\|([^\][]+))?\]\]/g;

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Undo esc(), for hooks that need the text the user typed. */
export function unesc(s) {
  return String(s ?? '').replace(/&(amp|lt|gt|quot|#39);/g, (_, k) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[k]));
}

/**
 * One line of inline markup. Hooks receive ESCAPED strings (the grammar runs
 * over escaped text) and return HTML:
 *   link(target, display)  display is undefined without a "|"
 *   image(alt, url)        url always starts with /assets/
 *   dice(html)             optional post-pass over the whole line
 */
export function renderInline(text, hooks) {
  let html = esc(text);
  html = html.replace(/\[\[([^\][|]+)(?:\|([^\][]+))?\]\]/g, (_, target, display) => hooks.link(target, display));
  // images, but ONLY from the world's own /assets/ — remote URLs stay plain
  // text, so a note can never make anything fetch off this machine
  html = html.replace(/!\[([^\]]*)\]\((\/assets\/[^\s)]+)\)/g, (_, alt, url) => hooks.image(alt, url));
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  if (hooks.dice) html = hooks.dice(html);
  return html;
}

export function renderMarkdown(text, hooks) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  let list = null, quote = null, para = [];
  const inline = (s) => renderInline(s, hooks);

  const flushPara = () => {
    if (para.length) { out.push(`<p>${para.join('<br>')}</p>`); para = []; }
  };
  const flushList = () => {
    if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
  };
  const flushQuote = () => {
    if (quote) { out.push(`<blockquote>${quote.join('<br>')}</blockquote>`); quote = null; }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^- /.test(line)) {
      flushPara(); flushQuote();
      (list ??= []).push(`<li>${inline(line.slice(2))}</li>`);
    } else if (/^> ?/.test(line)) {
      flushPara(); flushList();
      (quote ??= []).push(inline(line.replace(/^> ?/, '')));
    } else if (line === '') {
      flushPara(); flushList(); flushQuote();
    } else {
      flushList(); flushQuote();
      para.push(inline(line));
    }
  }
  flushPara(); flushList(); flushQuote();
  return out.join('');
}

/**
 * What renderMarkdown() makes of each character of `text`: 1 shown, 2 shown
 * blank, 0 not shown (markup, a link's target, an image, a line break). It
 * repeats the grammar above pass by pass on the raw text, which works because
 * escaping changes no character the patterns test; tests hold the two together.
 */
export function shownChars(text) {
  const src = String(text || '');
  const kind = new Array(src.length).fill(0);
  // each pass keeps parts of every match and drops the rest, like the replace it mirrors
  const pass = (items, rx, keep) => {
    const str = items.map((x) => src[x]).join('');
    const out = [];
    let last = 0;
    for (const m of str.matchAll(rx)) {
      out.push(...items.slice(last, m.index));
      for (const [from, to] of keep(m)) out.push(...items.slice(m.index + from, m.index + to));
      last = m.index + m[0].length;
    }
    return out.concat(items.slice(last));
  };
  const trimmed = (s, at) => [[at + s.length - s.trimStart().length, at + s.trimEnd().length]];
  let start = 0;
  for (const raw of src.split('\n')) {
    const line = raw.trimEnd();
    const lead = /^- /.test(line) ? 2 : (/^> ?/.exec(line)?.[0].length ?? 0);
    let items = [];
    for (let i = start + lead; i < start + line.length; i++) items.push(i);
    items = pass(items, /\[\[([^\][|]+)(?:\|([^\][]+))?\]\]/g, (m) => (m[2] === undefined ? trimmed(m[1], 2) : trimmed(m[2], 3 + m[1].length)));
    items = pass(items, /!\[([^\]]*)\]\((\/assets\/[^\s)]+)\)/g, () => []);
    items = pass(items, /\*\*([^*]+)\*\*/g, (m) => [[2, 2 + m[1].length]]);
    items = pass(items, /(^|[^*])\*([^*\n]+)\*/g, (m) => [[0, m[1].length], [m[1].length + 1, m[1].length + 1 + m[2].length]]);
    items = pass(items, /`([^`]+)`/g, (m) => [[1, 1 + m[1].length]]);
    for (const i of items) kind[i] = /\s/.test(src[i]) ? 2 : 1;
    start += raw.length + 1;
  }
  return kind;
}

/**
 * Where in `text` a caret goes that sits after the first `count` shown, non-blank
 * characters of its rendering: for a tap on a block, so the editor opens at
 * the word that was tapped. `startOfNext` (the caret follows a blank or starts
 * a line) puts it before the next word's opening markup, otherwise it goes
 * after the previous word's closing markup, so typing lands outside a link or
 * a bold run unless the tap was inside one.
 */
export function sourceCaret(text, count, startOfNext = false) {
  const src = String(text || '');
  const kind = shownChars(src);
  const shown = [];
  kind.forEach((k, i) => { if (k === 1) shown.push(i); });
  if (!shown.length) return src.length;
  const prev = count > 0 ? shown[Math.min(count, shown.length) - 1] : -1;
  const next = count < shown.length ? shown[count] : src.length;
  let at;
  if (startOfNext || prev < 0) {
    at = next;
    while (at > prev + 1 && kind[at - 1] === 0 && src[at - 1] !== '\n') at--;
    if (at === 0 || src[at - 1] === '\n') at += /^- /.test(src.slice(at)) ? 2 : (/^> ?/.exec(src.slice(at))?.[0].length ?? 0);
  } else {
    at = prev + 1;
    while (at < next && kind[at] === 0 && src[at] !== '\n' && src[at] !== '\r') at++;
  }
  return at;
}

/**
 * Plain-text mentions of a name (1.9 unlinked mentions): the whole name,
 * ignoring case, with an optional plural ("s"/"es") or possessive ("'s").
 * Text inside a [[link]] or an image is never touched. link() keeps the
 * words readers see: "port vellen's" → "[[Port Vellen|port vellen]]'s".
 * Returns null for names shorter than three characters.
 */
export function mentionMatcher(rawName) {
  const name = String(rawName || '').trim();
  if (name.length < 3) return null;
  const escRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const find = () => new RegExp(`(?<![\\p{L}\\p{N}])(${escRx(name)})(es|s|'s|’s)?(?![\\p{L}\\p{N}])`, 'giu');
  const pieces = (text) => String(text || '').split(/(\[\[[^\]]*\]\]|!\[[^\]]*\]\([^)]*\))/);
  const wrap = (core, suffix = '') => {
    if (suffix === 's' || suffix === 'es') return `[[${name}|${core}${suffix}]]`;
    return (core === name ? `[[${name}]]` : `[[${name}|${core}]]`) + suffix;
  };
  return {
    find(text) {
      let count = 0, snippet = '';
      pieces(text).forEach((part, i) => {
        if (i % 2) return;
        for (const m of part.matchAll(find())) {
          count++;
          if (!snippet) snippet = part.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40).replace(/\s+/g, ' ').trim();
        }
      });
      return { count, snippet };
    },
    link(text) {
      return pieces(text).map((part, i) => (i % 2 ? part : part.replace(find(), (_, core, suffix) => wrap(core, suffix || '')))).join('');
    },
  };
}

/** Plain text with markup stripped — for snippets, search and PDF export. */
export function mdToPlain(text) {
  return String(text || '')
    .replace(/!\[([^\]]*)\]\(\/assets\/[^\s)]+\)/g, '$1')
    .replace(WIKILINK, (_, target, display) => (display || target).trim())
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^> ?/gm, '')
    .replace(/^- /gm, '• ');
}
