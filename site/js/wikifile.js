// What a MundusMaker player wiki ZIP holds, and how each file is stored.
// Pure, so tests/site.test.js runs it in Node. The storage policy in
// supabase/migrations accepts the same file names (wiki_file_name_ok) and the
// same limits (wiki_limits); change them together.

export const LIMITS = { wikis: 3, bytes: 20 * 1024 * 1024, fileBytes: 3 * 1024 * 1024, files: 5000 };

export const PAGE = /^(?:index|timeline|maps|handouts|entry-\d{1,6}|category-\d{2,4})\.html$/;
export const IMAGE = /^images\/[0-9a-f]{24}\.(?:png|jpg|webp)$/;
const ASSET = /^assets\/(?:wiki\.css|search-index\.js)$/;
// The website brings its own copy of the search script, and the README only
// explains how to open the wiki offline.
const LEFT_OUT = /^(?:assets\/wiki\.js|README\.txt)$/;

export const isWikiId = (id) => /^[a-z0-9]{12}$/.test(String(id ?? ''));
export const isPage = (name) => PAGE.test(String(name ?? ''));
export const isImage = (name) => IMAGE.test(String(name ?? ''));

export function mb(bytes) {
  const n = bytes / 1048576;
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} MB`;
}

/**
 * Sorts a ZIP's entries ({ name, size, dir }) into the files to publish.
 * Returns { files: [{ path, entry }], problems: [text] }; publish only when
 * problems is empty.
 */
export function planWiki(entries) {
  const names = entries.filter((e) => !e.dir).map((e) => e.name);
  // the export puts everything in one "<world>-player-wiki/" folder
  const tops = new Set(names.map((n) => (n.includes('/') ? n.slice(0, n.indexOf('/') + 1) : '')));
  const root = tops.size === 1 && !tops.has('') ? [...tops][0] : '';
  const files = [], strangers = [], problems = [];
  for (const entry of entries) {
    if (entry.dir) continue;
    const path = entry.name.slice(root.length);
    if (isPage(path) || ASSET.test(path) || isImage(path)) files.push({ path, entry });
    else if (!LEFT_OUT.test(path)) strangers.push(path);
  }
  if (!files.some((f) => f.path === 'index.html') || !files.some((f) => f.path === 'assets/search-index.js')) {
    problems.push('This ZIP is not a MundusMaker player wiki. In MundusMaker, open Export, press Export player wiki, then pick that ZIP.');
  } else if (strangers.length) {
    problems.push(`This ZIP holds files a player wiki doesn't, such as ${strangers[0]}. Pick the ZIP exactly as MundusMaker saved it.`);
  }
  if (files.length > LIMITS.files) problems.push(`A wiki can have up to ${LIMITS.files} files; this one has ${files.length}.`);
  for (const f of files) {
    // pictures are shrunk before upload, so only their final size counts
    if (!isImage(f.path) && f.entry.size > LIMITS.fileBytes) problems.push(`${f.path} is larger than ${mb(LIMITS.fileBytes)}.`);
  }
  return { files, problems };
}

/** How a file is stored: content type (pictures keep their own) and cache time. */
export function storedAs(path) {
  // a picture's name is a hash of its bytes, so it never changes
  if (isImage(path)) return { cacheSeconds: 31536000 };
  if (path.endsWith('.css')) return { contentType: 'text/css', cacheSeconds: 60 };
  return { contentType: 'text/plain', cacheSeconds: 60 };
}

/** The entries of assets/search-index.js, read as data, never run. */
export function parseSearchIndex(text) {
  const m = /^\s*window\.MUNDUS_WIKI_INDEX\s*=\s*([\s\S]*?);?\s*$/.exec(String(text ?? ''));
  if (!m) return [];
  let list;
  try { list = JSON.parse(m[1]); } catch { return []; }
  if (!Array.isArray(list)) return [];
  const str = (v) => (typeof v === 'string' ? v : '');
  return list
    .filter((e) => e && typeof e === 'object' && isPage(str(e.u)))
    .map((e) => ({ u: e.u, t: str(e.t), c: str(e.c), s: str(e.s), x: str(e.x) }));
}

/** A page's <title>, as plain text. */
export function pageTitle(html) {
  const m = /<title>([^<]*)<\/title>/i.exec(String(html ?? ''));
  if (!m) return '';
  return m[1].replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]).trim();
}

/** "#entry-0003.html#people" → { page, anchor }; anything else is the contents page. */
export function pageFromHash(hash) {
  const [page, anchor = ''] = String(hash ?? '').replace(/^#/, '').split('#');
  if (!isPage(page)) return { page: 'index.html', anchor: '' };
  return { page, anchor: /^[\w-]{1,80}$/.test(anchor) ? anchor : '' };
}

/**
 * A link or picture address inside a wiki page: only relative ones. The wiki
 * never links anywhere else, so a scheme, "//" or "\\" means a page was edited.
 */
export function safeUrl(value) {
  const v = String(value ?? '');
  return !/^\s*(?:[a-z][a-z0-9+.-]*:|[\\/]{2})/i.test(v) && !/[\u0000-\u001f\u007f]/.test(v);
}

export function newWikiId() {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  while (id.length < 12) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      // 252 is the largest multiple of 36 that fits in a byte; skipping the
      // bytes above it keeps every character equally likely
      if (b < 252 && id.length < 12) id += abc[b % 36];
    }
  }
  return id;
}
