// The player wiki viewer: wiki/?w=<id>#<page>.
//
// A wiki's pages are fetched as text and shown in a sandboxed frame without
// an origin of its own, so nothing uploaded can reach this site's storage or
// sign-ins (rjani007.github.io also serves Elysium). Uploaded scripts are
// dropped: the frame runs only what this page adds, which is the offline
// wiki's own search (wiki/search.js, copied from public/wiki/wiki.js when the
// site is published) and the link handling below.

import { config } from '../config.js';
import { IMAGE, PAGE, isImage, isPage, isWikiId, pageFromHash, parseSearchIndex, safeUrl } from './wikifile.js';

const id = new URLSearchParams(location.search).get('w') || '';
const storage = new URL(config.url).origin;
const base = `${config.url}/storage/v1/object/public/wikis/${id}/`;
const status = document.getElementById('status');
let frame = document.getElementById('wiki');
let indexCode = '', searchCode = '', showing = 0;

const GONE = 'This wiki isn\'t online. Your GM may have taken it down or sent a new link.';

function say(text) {
  status.textContent = text;
  status.hidden = false;
  frame.hidden = true;
}

// Storage answers a missing file with 400 or 404, depending on the version.
const missing = (res) => res.status === 400 || res.status === 404;

const inline = (code) => code.replace(/<\/(script)/gi, '<\\/$1');

function frameMain(parentOrigin, anchor, pageSource, imageSource) {
  const page = new RegExp(pageSource), image = new RegExp(imageSource);
  const send = (message) => parent.postMessage(Object.assign({ mundusWiki: 1 }, message), parentOrigin);
  const jump = (name) => {
    const target = name && document.getElementById(name);
    if (target) target.scrollIntoView();
  };
  // capture: runs before the search script's own handlers, which call click()
  document.addEventListener('click', (ev) => {
    const a = ev.target instanceof Element ? ev.target.closest('a[href]') : null;
    if (!a) return;
    ev.preventDefault();
    const [path, frag = ''] = a.getAttribute('href').split('#');
    if (!path) jump(decodeURIComponent(frag));
    else if (page.test(path)) send({ page: path, anchor: frag });
    else if (image.test(path)) send({ image: path });
  }, true);
  jump(anchor);
}

/** The uploaded page made safe to show: no scripts, no outside addresses, a strict policy. */
function frameDocument(html, anchor) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const node of doc.querySelectorAll('script, noscript, template, iframe, frame, frameset, object, embed, applet, form, base, meta, link, portal')) {
    const sheet = node.tagName === 'LINK' && node.getAttribute('rel') === 'stylesheet' && node.getAttribute('href') === 'assets/wiki.css';
    if (!sheet) node.remove();
  }
  for (const node of doc.querySelectorAll('*')) {
    for (const { name, value } of [...node.attributes]) {
      const n = name.toLowerCase();
      const url = ['href', 'src', 'xlink:href', 'poster', 'background', 'cite', 'data', 'action', 'formaction'].includes(n);
      if (n.startsWith('on') || n === 'srcset' || n === 'srcdoc' || n === 'ping'
        || (url && !safeUrl(value)) || (n === 'style' && /url\s*\(|expression|@import/i.test(value))) node.removeAttribute(name);
    }
  }
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  const policy = doc.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content = `default-src 'none'; base-uri ${storage}; img-src ${storage}; style-src ${storage} 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action 'none'`;
  const baseUrl = doc.createElement('base');
  baseUrl.href = base;
  doc.head.prepend(policy, baseUrl);
  const glue = `(${frameMain})(${JSON.stringify(location.origin)}, ${JSON.stringify(anchor)}, ${JSON.stringify(PAGE.source)}, ${JSON.stringify(IMAGE.source)});`;
  for (const code of [indexCode, searchCode, glue]) {
    if (!code) continue;
    const script = doc.createElement('script');
    // the attribute, not the .nonce property, which never reaches the markup
    script.setAttribute('nonce', nonce);
    script.textContent = inline(code);
    doc.body.append(script);
  }
  return { title: doc.title, html: `<!doctype html>\n${doc.documentElement.outerHTML}` };
}

async function show() {
  const { page, anchor } = pageFromHash(location.hash);
  const ticket = ++showing;
  let res;
  try { res = await fetch(base + page); } catch { return say('Couldn\'t reach the wiki. Check your connection, then reload the page.'); }
  if (ticket !== showing) return;
  if (!res.ok) {
    if (page !== 'index.html' && missing(res)) { location.replace('#index.html'); return; }
    return say(missing(res) ? GONE : 'The wiki couldn\'t be loaded. Try again in a minute.');
  }
  const { title, html } = frameDocument(await res.text(), anchor);
  if (ticket !== showing) return;
  document.title = title || 'Player wiki';
  // A fresh frame for every page: giving a frame a new document adds a step
  // to the browser's history, and Back would then undo the frame, not the page.
  const next = frame.cloneNode(false);
  next.srcdoc = html;
  next.hidden = false;
  const first = frame.hidden;
  frame.replaceWith(next);
  frame = next;
  status.hidden = true;
  if (!first) frame.focus(); // keep the keyboard in the wiki after following a link
}

addEventListener('message', (ev) => {
  if (ev.source !== frame.contentWindow || ev.data?.mundusWiki !== 1) return;
  const { page, anchor, image } = ev.data;
  if (isPage(page)) location.hash = page + (typeof anchor === 'string' && /^[\w-]{1,80}$/.test(anchor) ? `#${anchor}` : '');
  else if (isImage(image)) window.open(base + image, '_blank', 'noopener');
});

async function boot() {
  if (!isWikiId(id)) return say('This isn\'t a MundusMaker wiki link. Ask your GM to send it again.');
  try {
    const [search, index] = await Promise.all([fetch('./search.js'), fetch(base + 'assets/search-index.js')]);
    if (!index.ok) return say(missing(index) ? GONE : 'The wiki couldn\'t be loaded. Try again in a minute.');
    // the index is read as data and written back out, so it can't carry a script
    indexCode = `window.MUNDUS_WIKI_INDEX = ${JSON.stringify(parseSearchIndex(await index.text())).replace(/</g, '\\u003c')};`;
    searchCode = search.ok ? await search.text() : '';
  } catch {
    return say('Couldn\'t reach the wiki. Check your connection, then reload the page.');
  }
  addEventListener('hashchange', show);
  show();
}

boot();
