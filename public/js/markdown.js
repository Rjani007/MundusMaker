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
