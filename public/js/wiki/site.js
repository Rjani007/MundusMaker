// The player wiki's text layer: turns a projectPlayerWorld() result into the
// HTML pages and the search index of an offline site. Pure (no DOM), so the
// canary tests run it in Node.
//
// Rules this file keeps (docs/1.9.0-plan.md, Player projection contract):
// - Page and image names are generated. Entity ids, world ids and asset file
//   names never reach output: an id can embed a name the GM has since hidden.
// - Everything loads from relative paths through <link> and <script src>, so
//   the site works from file:// with networking off. No web fonts, no CDNs.
// - Links to entries the wiki leaves out render as plain text, like the app.

import { renderMarkdown, renderInline, esc, unesc } from '../markdown.js';

const pad = (n, w) => String(n).padStart(w, '0');
const mod = (n) => { const m = Math.floor((Number(n) || 10) / 2) - 5; return (m >= 0 ? '+' : '') + m; };

/**
 * images: Map(needKey → [{ file, width, height }]) produced by the exporter.
 * Returns [{ name, text }] — every text file of the site.
 */
export function buildWikiSite(proj, { images = new Map(), exportedAt = new Date() } = {}) {
  const date = exportedAt.toISOString().slice(0, 10);
  const pageOf = new Map();
  const width = Math.max(4, String(proj.order.length).length);
  proj.order.forEach((ref, i) => pageOf.set(ref, `entry-${pad(i + 1, width)}.html`));
  const catPage = new Map(proj.categories.map((c, i) => [c.key, `category-${pad(i + 1, 2)}.html`]));
  const entry = (ref) => proj.entries.get(ref);
  const firstImage = (key) => (key && images.get(key)?.[0]) || null;

  const hooks = {
    link(target, display) {
      const ref = proj.linkRef(unesc(target));
      const label = esc(unesc((display || target).trim()));
      return ref ? `<a class="wl" href="${pageOf.get(ref)}">${label}</a>` : label;
    },
    image(alt, url) {
      const img = firstImage(proj.imageFor(unesc(url)));
      return img ? `<img class="md-img" src="${img.file}" alt="${alt}" loading="lazy">` : alt;
    },
  };
  const md = (text) => renderMarkdown(text, hooks);
  const inline = (text) => renderInline(text, hooks);
  const entryLink = (ref) => `<a href="${pageOf.get(ref)}">${esc(entry(ref).name)}</a>`;
  const hasMaps = proj.order.some((ref) => entry(ref).map);
  const hasHandouts = proj.order.some((ref) => entry(ref).handout);

  const nav = [
    ['index.html', 'Contents'],
    proj.timeline ? ['timeline.html', 'Timeline'] : null,
    hasMaps ? ['maps.html', 'Maps'] : null,
    hasHandouts ? ['handouts.html', 'Handouts'] : null,
  ].filter(Boolean);

  function page(title, body, { current = '' } = {}) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title === proj.world.name ? title : `${title} · ${proj.world.name}`)}</title>
<link rel="stylesheet" href="assets/wiki.css">
</head>
<body>
<header class="top">
<a class="brand" href="index.html">${esc(proj.world.name)}</a>
<nav>${nav.map(([href, label]) => `<a href="${href}"${href === current ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>
<div class="search"><input type="search" id="wiki-search" placeholder="Search" aria-label="Search this wiki" autocomplete="off" spellcheck="false"><div id="wiki-results" class="results" role="listbox" hidden></div></div>
</header>
<main>
${body}
</main>
<footer>Player edition · exported ${date} · made with MundusMaker</footer>
<script src="assets/search-index.js"></script>
<script src="assets/wiki.js"></script>
</body>
</html>
`;
  }

  const files = [];

  // ---------- contents ----------
  const cats = proj.categories.map((c) => `<a class="cat" href="${catPage.get(c.key)}"><span class="dot" style="background:${esc(c.color)}"></span>${esc(c.plural)}<span class="count">${c.entries.length}</span></a>`).join('\n');
  files.push({ name: 'index.html', text: page(proj.world.name, `<h1>${esc(proj.world.name)}</h1>
${proj.world.description ? `<p class="lede">${esc(proj.world.description)}</p>` : ''}
<p class="edition">Player edition, exported ${date}. It holds what your GM has shared with the party.</p>
${proj.world.today ? `<p class="muted">Current date: ${esc(proj.world.today)}</p>` : ''}
<h2>Contents</h2>
<div class="cats">
${cats || '<p class="muted">Nothing has been shared yet.</p>'}
</div>`, { current: 'index.html' }) });

  // ---------- categories ----------
  for (const c of proj.categories) {
    const rows = c.entries.map((ref) => {
      const e = entry(ref);
      return `<li><a href="${pageOf.get(ref)}">${esc(e.name)}</a>${e.snippet ? `<div class="snippet">${esc(e.snippet)}</div>` : ''}</li>`;
    }).join('\n');
    files.push({ name: catPage.get(c.key), text: page(c.plural, `<h1><span class="dot" style="background:${esc(c.color)}"></span>${esc(c.plural)}</h1>
<ul class="list">
${rows}
</ul>`) });
  }

  // ---------- entries ----------
  for (const ref of proj.order) {
    const e = entry(ref);
    const parts = [];
    const portrait = firstImage(e.portrait);
    const meta = [`<a class="badge" href="${catPage.get(e.typeKey)}" style="border-color:${esc(e.color)}">${esc(e.typeLabel)}</a>`,
      ...e.tags.map((t) => `<span class="tag">${esc(t)}</span>`)];
    if (e.date?.text) meta.push(`<span class="date">${esc(e.date.text)}${e.date.until ? ` <span class="until">until ${esc(e.date.until)}</span>` : ''}</span>`);
    parts.push(`<article class="entry">`);
    if (portrait) parts.push(`<img class="portrait" src="${portrait.file}" alt="" width="${portrait.width}" height="${portrait.height}">`);
    parts.push(`<h1>${esc(e.name)}</h1>`, `<div class="meta">${meta.join(' ')}</div>`);
    if (e.facts.length) parts.push(`<dl class="facts">${e.facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${inline(v)}</dd>`).join('')}</dl>`);
    for (const b of e.blocks) parts.push(blockHtml(b, md));
    if (e.relations.length) {
      parts.push(`<h2>Relations</h2><ul class="rels">${e.relations.map((r) => `<li><span class="rel">${esc(r.label)}</span> ${entryLink(r.ref)}</li>`).join('')}</ul>`);
    }
    if (e.map) parts.push(mapHtml(e, images, entryLink));
    if (e.handout) {
      const pages = images.get(e.handout) || [];
      if (pages.length) parts.push(`<h2>Handout</h2><div class="handout">${pages.map((p, i) => `<a href="${p.file}"><img src="${p.file}" alt="${esc(e.name)}, page ${i + 1}" width="${p.width}" height="${p.height}" loading="lazy"></a>`).join('')}</div>`);
    }
    if (e.backlinks.length) {
      const seen = new Set();
      const items = e.backlinks.filter((b) => !seen.has(b.ref) && seen.add(b.ref))
        .map((b) => `<li>${entryLink(b.ref)}${b.via === 'relation' ? ` <span class="muted">(${esc(b.label)})</span>` : ''}</li>`);
      parts.push(`<h2>Linked from</h2><ul class="backlinks">${items.join('')}</ul>`);
    }
    parts.push(`</article>`);
    files.push({ name: pageOf.get(ref), text: page(e.name, parts.join('\n')) });
  }

  // ---------- timeline ----------
  if (proj.timeline) {
    const tl = proj.timeline;
    const row = (ref) => {
      const e = entry(ref);
      return `<div class="tl-item"><div class="tl-date">${esc(e.date?.text || '')}${e.date?.until ? `<span class="until">until ${esc(e.date.until)}</span>` : ''}</div>
<div class="tl-body"><span class="dot" style="background:${esc(e.color)}"></span>${entryLink(ref)} <span class="badge small">${esc(e.typeLabel)}</span>${e.snippet ? `<div class="snippet">${esc(e.snippet)}</div>` : ''}</div></div>`;
    };
    const body = [`<h1>Timeline</h1>`];
    if (tl.today) body.push(`<p class="muted">Current date: ${esc(tl.today)}</p>`);
    if (tl.bands) {
      for (const band of tl.bands) {
        body.push(`<h2 class="band">${esc(band.label)}${band.from != null ? ` <span class="from">from ${esc(band.from)}</span>` : ''}</h2>`);
        body.push(...band.items.map(row));
      }
    } else body.push(...tl.dated.map(row));
    if (tl.annual.length) {
      body.push(`<h2 class="band">Every year</h2>`, ...tl.annual.map(row));
    }
    files.push({ name: 'timeline.html', text: page('Timeline', body.join('\n'), { current: 'timeline.html' }) });
  }

  // ---------- maps and handouts ----------
  if (hasMaps) {
    const cards = proj.order.filter((ref) => entry(ref).map).map((ref) => {
      const img = firstImage(entry(ref).map.levels[0]);
      return `<a class="card" href="${pageOf.get(ref)}">${img ? `<img src="${img.file}" alt="" loading="lazy">` : ''}<span>${esc(entry(ref).name)}</span></a>`;
    });
    files.push({ name: 'maps.html', text: page('Maps', `<h1>Maps</h1>\n<div class="cards">\n${cards.join('\n')}\n</div>`, { current: 'maps.html' }) });
  }
  if (hasHandouts) {
    const cards = proj.order.filter((ref) => entry(ref).handout).map((ref) => {
      const img = firstImage(entry(ref).handout);
      return `<a class="card" href="${pageOf.get(ref)}">${img ? `<img src="${img.file}" alt="" loading="lazy">` : ''}<span>${esc(entry(ref).name)}</span></a>`;
    });
    files.push({ name: 'handouts.html', text: page('Handouts', `<h1>Handouts</h1>\n<div class="cards">\n${cards.join('\n')}\n</div>`, { current: 'handouts.html' }) });
  }

  // ---------- search index ----------
  // Loaded through <script src>, because browsers refuse fetch() on file://.
  const index = proj.order.map((ref) => {
    const e = entry(ref);
    return { u: pageOf.get(ref), t: e.name, c: e.typeLabel, s: e.snippet, x: e.search };
  });
  files.push({ name: 'assets/search-index.js', text: `window.MUNDUS_WIKI_INDEX = ${JSON.stringify(index).replace(/</g, '\\u003c')};\n` });
  files.push({ name: 'README.txt', text: `${proj.world.name} (player wiki)\r\n\r\nOpen index.html in any web browser. Everything is in this folder, so it works offline.\r\n\r\nPlayer edition, exported ${date} with MundusMaker.\r\n` });
  return files;
}

function blockHtml(b, md) {
  if (b.kind === 'heading') return `<h2>${md(b.text).replace(/^<p>|<\/p>$/g, '')}</h2>`;
  if (b.kind === 'quote') return `<blockquote class="quote">${md(b.text)}</blockquote>`;
  if (b.kind === 'text') return `<div class="text">${md(b.text)}</div>`;
  if (b.kind === 'statblock') {
    const s = b.stat;
    const rows = (list) => list.map((t) => `<p><b>${esc(t.name)}${t.name ? '.' : ''}</b> ${esc(t.text)}</p>`).join('');
    return `<div class="statblock"><div class="sb-name">${esc(s.name)}</div>${s.meta ? `<div class="sb-meta">${esc(s.meta)}</div>` : ''}
<div class="sb-line"><b>Armor Class</b> ${esc(s.ac)}</div><div class="sb-line"><b>Hit Points</b> ${esc(s.hp)}</div><div class="sb-line"><b>Speed</b> ${esc(s.speed)}</div>
<div class="sb-abilities">${s.abilities.map(([k, v]) => `<div><b>${k.toUpperCase()}</b><br>${esc(v)} (${mod(v)})</div>`).join('')}</div>
${s.vitals.map(([k, v]) => `<div class="sb-line"><b>${esc(k)}</b> ${esc(v)}</div>`).join('')}
${rows(s.traits)}${s.actions.length ? `<div class="sb-section">Actions</div>${rows(s.actions)}` : ''}</div>`;
  }
  if (b.kind === 'encounter') {
    return `<div class="encounter"><div class="enc-head">Encounter · ${esc(b.difficulty)}</div><ul>${b.rows.map((r) => `<li>${esc(r.count)} × ${esc(r.name)} · CR ${esc(r.cr)} · ${esc(r.xp.toLocaleString('en'))} XP</li>`).join('')}</ul>
<div class="muted small">${esc(b.totalXp.toLocaleString('en'))} XP raw · ×${esc(b.multiplier)} = ${esc(b.adjustedXp.toLocaleString('en'))} adjusted · party of ${esc(b.partySize)}, level ${esc(b.partyLevel)}</div></div>`;
  }
  if (b.kind === 'table') {
    return `<table class="rtable"><caption>${esc(b.title)}</caption><thead><tr><th>Weight</th><th>Result</th></tr></thead><tbody>${b.rows.map((r) => `<tr><td>${esc(r.weight)}</td><td>${esc(r.text)}</td></tr>`).join('')}</tbody></table>`;
  }
  if (b.kind === 'sheet') {
    if (!b.lines.length) return '';
    return `<div class="sheet">${b.lines.map((l) => l.bold ? `<div class="sh-head">${esc(l.text)}</div>` : `<div class="sh-line">${esc(l.text)}</div>`).join('')}</div>`;
  }
  return '';
}

function mapHtml(e, images, entryLink) {
  const levels = e.map.levels.map((key) => images.get(key)?.[0]).filter(Boolean);
  if (!levels.length) return '';
  const imgs = levels.map((img, i) => `<figure><a href="${img.file}"><img src="${img.file}" alt="Map of ${esc(e.name)}${levels.length > 1 ? `, level ${i + 1}` : ''}" width="${img.width}" height="${img.height}" loading="lazy"></a>${levels.length > 1 ? `<figcaption>Level ${i + 1}</figcaption>` : ''}</figure>`).join('');
  const keyRow = (k) => {
    if (k.ref && k.linkedName === k.label) return entryLink(k.ref);
    const linked = k.ref ? entryLink(k.ref) : esc(k.linkedName);
    return esc(k.label) + (k.linkedName && k.linkedName !== k.label ? ` — ${linked}` : '');
  };
  const key = e.map.key.length ? `<ol class="mapkey">${e.map.key.map((k) => `<li value="${k.n}">${keyRow(k)}</li>`).join('')}</ol>` : '';
  return `<h2>Map</h2><div class="map">${imgs}</div>${key}`;
}
