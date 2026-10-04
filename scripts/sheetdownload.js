'use strict';
// "Get it from the publisher" in the Official sheet dialog: MundusMaker fetches
// a publisher's free fillable sheet from the publisher's own site, once, when
// the GM presses the button, into the GM's own .sheet-templates folder. The
// sheets allow copying for personal use only, so the release never carries
// them and MundusMaker never passes them on.
//
// The table is fixed here, so a page can only name a sheet, never a URL. The
// ids are the built-in maps' template ids (public/js/sheets/officialsheets.js).
// V5 is missing on purpose: Renegade hands it out through a store checkout.

const SOURCES = {
  'dnd2024-wotc': {
    system: 'dnd2024', publisher: 'D&D Beyond', label: 'D&D 2024 character sheet (Wizards of the Coast, free rules)',
    url: 'https://media.dndbeyond.com/compendium-images/free-rules/ph/character-sheet.pdf',
  },
  'coc7-chaosium-1920s': {
    system: 'coc7', publisher: 'Chaosium', label: 'Call of Cthulhu 7e investigator sheet, 1920s (Chaosium)',
    url: 'https://downloads.chaosium.com/call-of-cthulhu/cha2300-investigator-sheets/CoC7_Investigator_Sheet_Standard_autocalc.pdf',
  },
  'coc7-chaosium-modern': {
    system: 'coc7', publisher: 'Chaosium', label: 'Call of Cthulhu 7e investigator sheet, Modern (Chaosium)',
    url: 'https://downloads.chaosium.com/call-of-cthulhu/cha2300-investigator-sheets/CoC7_Investigator_Sheet_Modern_autocalc.pdf',
  },
};
const MAX_BYTES = 25 * 1024 * 1024;

/** What the dialog may offer: no URLs, just which sheets and from whom. */
function listSources() {
  return Object.entries(SOURCES).map(([id, s]) => ({ id, system: s.system, publisher: s.publisher, label: s.label, host: new URL(s.url).host }));
}

/**
 * Download one sheet. Redirects may only stay on the publisher's own host over
 * https; the body is capped and must be a PDF. Resolves to { source, fileName,
 * bytes }; throws an Error whose message the dialog shows as it is.
 */
async function downloadSheet(id, { fetchImpl = fetch, timeoutMs = 30000, maxBytes = MAX_BYTES, version = '' } = {}) {
  const source = Object.prototype.hasOwnProperty.call(SOURCES, id) ? SOURCES[id] : null;
  if (!source) throw Object.assign(new Error('MundusMaker cannot download that sheet.'), { status: 400 });
  const home = new URL(source.url).host;
  const failed = (why) => Object.assign(new Error(`${source.publisher}'s sheet could not be downloaded (${why}). You can still download it from their site yourself and add the PDF.`), { status: 502 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let url = source.url, res;
    for (let hop = 0; ; hop++) {
      try {
        res = await fetchImpl(url, { redirect: 'manual', signal: controller.signal, headers: { Accept: 'application/pdf', 'User-Agent': `MundusMaker/${version || 'app'}` } });
      } catch (err) {
        throw failed(controller.signal.aborted ? 'it took too long' : 'no connection');
      }
      if (![301, 302, 303, 307, 308].includes(res.status)) break;
      const next = res.headers.get('location');
      let target;
      try { target = new URL(next, url); } catch { target = null; }
      if (hop >= 3 || !target || target.protocol !== 'https:' || target.host !== home) throw failed('the file has moved');
      url = target.href;
    }
    if (res.status !== 200) throw failed(`${home} answered ${res.status}`);
    const declared = Number(res.headers.get('content-length'));
    if (declared > maxBytes) throw failed('the file is larger than a character sheet should be');
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > maxBytes) { controller.abort(); throw failed('the file is larger than a character sheet should be'); }
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    if (!bytes.subarray(0, 1024).toString('latin1').includes('%PDF-')) throw failed('what came back is not a PDF');
    return { source: { id, ...source }, fileName: decodeURIComponent(new URL(url).pathname.split('/').pop() || 'sheet.pdf'), bytes };
  } catch (err) {
    if (err.status) throw err;
    throw failed(controller.signal.aborted ? 'it took too long' : 'the download broke off');
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { SOURCES, listSources, downloadSheet };
