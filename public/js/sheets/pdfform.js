// Fill a fillable PDF (the GM's own copy of a publisher's character sheet).
// A small zero-dependency PDF reader and writer: it reads cross-reference
// tables and streams, object streams and incremental updates, lists the
// AcroForm fields, and appends ONE incremental update that sets field values
// and draws their appearances. The original bytes are never rewritten, so the
// publisher's sheet is untouched underneath what MundusMaker adds.
//
// Pure module (no DOM): Uint8Array in, Uint8Array out. Compressed streams use
// the platform's DecompressionStream, which browsers and Node 18+ provide.
// Encrypted PDFs are refused with a plain explanation.

// ---------- object model ----------

export class Name { constructor(name) { this.name = name; } }
export class Ref { constructor(num, gen) { this.num = num; this.gen = gen; } }
export class Str { constructor(bytes, hex = false) { this.bytes = bytes; this.hex = hex; } }
export class Stream { constructor(dict, data) { this.dict = dict; this.data = data; } }
class Keyword { constructor(word) { this.word = word; } }

const nameOf = (v) => (v instanceof Name ? v.name : null);
const isDict = (v) => v instanceof Map;

// PDFDocEncoding differs from Latin-1 only in 0x18-0x1F and 0x80-0xA0
const PDFDOC_HIGH = { 0x80: 0x2022, 0x81: 0x2020, 0x82: 0x2021, 0x83: 0x2026, 0x84: 0x2014, 0x85: 0x2013, 0x86: 0x0192, 0x87: 0x2044, 0x88: 0x2039, 0x89: 0x203A, 0x8A: 0x2212, 0x8B: 0x2030, 0x8C: 0x201E, 0x8D: 0x201C, 0x8E: 0x201D, 0x8F: 0x2018, 0x90: 0x2019, 0x91: 0x201A, 0x92: 0x2122, 0x93: 0xFB01, 0x94: 0xFB02, 0x95: 0x0141, 0x96: 0x0152, 0x97: 0x0160, 0x98: 0x0178, 0x99: 0x017D, 0x9A: 0x0131, 0x9B: 0x0142, 0x9C: 0x0153, 0x9D: 0x0161, 0x9E: 0x017E, 0xA0: 0x20AC };

/** A PDF text string as JS text (UTF-16BE with BOM, UTF-8 with BOM, or PDFDocEncoding). */
export function strText(v) {
  if (!(v instanceof Str)) return v == null ? '' : String(v instanceof Name ? v.name : v);
  const b = v.bytes;
  if (b.length >= 2 && b[0] === 0xFE && b[1] === 0xFF) {
    let s = '';
    for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
    return s;
  }
  if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) return new TextDecoder('utf-8').decode(b.subarray(3));
  let s = '';
  for (const c of b) s += String.fromCharCode(PDFDOC_HIGH[c] ?? c);
  return s;
}

/** JS text as a PDF text string: Latin-1 when it fits, UTF-16BE otherwise. */
export function textStr(text) {
  const s = String(text ?? '');
  if ([...s].every((c) => { const k = c.codePointAt(0); return (k >= 0x20 && k < 0x7F) || (k >= 0xA1 && k <= 0xFF) || k === 0x0A || k === 0x0D; })) {
    return new Str(Uint8Array.from(s, (c) => c.charCodeAt(0)));
  }
  const out = [0xFE, 0xFF];
  for (let i = 0; i < s.length; i++) { const k = s.charCodeAt(i); out.push(k >> 8, k & 0xFF); }
  return new Str(Uint8Array.from(out));
}

// ---------- lexer ----------

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);
const isRegular = (c) => c !== undefined && !WS.has(c) && !DELIM.has(c);

class Lexer {
  constructor(buf, pos = 0) { this.buf = buf; this.pos = pos; }
  skip() {
    const b = this.buf;
    for (;;) {
      while (this.pos < b.length && WS.has(b[this.pos])) this.pos++;
      if (b[this.pos] !== 37) return;
      while (this.pos < b.length && b[this.pos] !== 10 && b[this.pos] !== 13) this.pos++;
    }
  }
  word() {
    const start = this.pos;
    while (this.pos < this.buf.length && isRegular(this.buf[this.pos])) this.pos++;
    return latin1(this.buf, start, this.pos);
  }
  peekWord() { const at = this.pos; this.skip(); const w = this.word(); this.pos = at; return w; }
  object() {
    this.skip();
    const b = this.buf, c = b[this.pos];
    if (c === undefined) throw new Error('unexpected end of PDF data');
    if (c === 47) return this.name();
    if (c === 40) return this.literal();
    if (c === 60) {
      if (b[this.pos + 1] === 60) return this.dict();
      return this.hexString();
    }
    if (c === 91) {
      this.pos++;
      const arr = [];
      for (;;) {
        this.skip();
        if (b[this.pos] === 93) { this.pos++; return arr; }
        if (this.pos >= b.length) throw new Error('unterminated array');
        arr.push(this.object());
      }
    }
    if ((c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) {
      const n = this.number();
      // "num gen R" is a reference
      if (Number.isInteger(n) && n >= 0) {
        const at = this.pos;
        this.skip();
        const c2 = b[this.pos];
        if (c2 >= 48 && c2 <= 57) {
          const gen = this.number();
          this.skip();
          if (b[this.pos] === 82 && !isRegular(b[this.pos + 1])) { this.pos++; return new Ref(n, gen); }
        }
        this.pos = at;
      }
      return n;
    }
    const w = this.word();
    if (!w) { this.pos++; return new Keyword(String.fromCharCode(c)); }
    if (w === 'true') return true;
    if (w === 'false') return false;
    if (w === 'null') return null;
    return new Keyword(w);
  }
  number() {
    const start = this.pos;
    while (this.pos < this.buf.length && /[0-9+\-.]/.test(String.fromCharCode(this.buf[this.pos]))) this.pos++;
    const v = Number(latin1(this.buf, start, this.pos));
    return Number.isFinite(v) ? v : 0;
  }
  name() {
    this.pos++;
    let s = '';
    while (this.pos < this.buf.length && isRegular(this.buf[this.pos])) {
      const c = this.buf[this.pos];
      if (c === 35 && /^[0-9A-Fa-f]{2}$/.test(latin1(this.buf, this.pos + 1, this.pos + 3))) {
        s += String.fromCharCode(parseInt(latin1(this.buf, this.pos + 1, this.pos + 3), 16));
        this.pos += 3;
      } else { s += String.fromCharCode(c); this.pos++; }
    }
    return new Name(s);
  }
  literal() {
    const b = this.buf, out = [];
    let depth = 1;
    this.pos++;
    while (this.pos < b.length) {
      const c = b[this.pos++];
      if (c === 92) {
        const e = b[this.pos++];
        const map = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12, 40: 40, 41: 41, 92: 92 };
        if (map[e] !== undefined) out.push(map[e]);
        else if (e >= 48 && e <= 55) {
          let v = e - 48;
          for (let k = 0; k < 2 && b[this.pos] >= 48 && b[this.pos] <= 55; k++) v = v * 8 + (b[this.pos++] - 48);
          out.push(v & 0xFF);
        } else if (e === 13) { if (b[this.pos] === 10) this.pos++; } else if (e !== 10) out.push(e);
        continue;
      }
      if (c === 40) depth++;
      if (c === 41 && --depth === 0) break;
      if (c === 13) { out.push(10); if (b[this.pos] === 10) this.pos++; continue; }
      out.push(c);
    }
    return new Str(Uint8Array.from(out));
  }
  hexString() {
    const b = this.buf;
    this.pos++;
    let hex = '';
    while (this.pos < b.length && b[this.pos] !== 62) { const ch = String.fromCharCode(b[this.pos++]); if (/[0-9A-Fa-f]/.test(ch)) hex += ch; }
    this.pos++;
    if (hex.length % 2) hex += '0';
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return new Str(out, true);
  }
  dict() {
    this.pos += 2;
    const d = new Map();
    for (;;) {
      this.skip();
      if (this.buf[this.pos] === 62 && this.buf[this.pos + 1] === 62) { this.pos += 2; return d; }
      if (this.pos >= this.buf.length) throw new Error('unterminated dictionary');
      const key = this.object();
      if (!(key instanceof Name)) { if (key instanceof Keyword) continue; throw new Error('dictionary key is not a name'); }
      d.set(key.name, this.object());
    }
  }
}

function latin1(buf, start = 0, end = buf.length) {
  let s = '';
  for (let i = start; i < end; i += 8192) s += String.fromCharCode.apply(null, buf.subarray(i, Math.min(end, i + 8192)));
  return s;
}
function indexOf(buf, text, from = 0, to = buf.length) {
  const t = Uint8Array.from(text, (c) => c.charCodeAt(0));
  outer: for (let i = from; i <= to - t.length; i++) {
    for (let k = 0; k < t.length; k++) if (buf[i + k] !== t[k]) continue outer;
    return i;
  }
  return -1;
}
function lastIndexOf(buf, text, from = buf.length - text.length) {
  const t = Uint8Array.from(text, (c) => c.charCodeAt(0));
  outer: for (let i = Math.min(from, buf.length - t.length); i >= 0; i--) {
    for (let k = 0; k < t.length; k++) if (buf[i + k] !== t[k]) continue outer;
    return i;
  }
  return -1;
}
function concat(chunks, total = chunks.reduce((n, c) => n + c.length, 0)) {
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

// ---------- filters ----------

async function inflate(bytes) {
  if (typeof DecompressionStream !== 'function') throw new Error('This browser cannot read compressed PDF data.');
  const ds = new DecompressionStream('deflate');
  const writer = ds.writable.getWriter();
  writer.write(bytes).catch(() => {});
  writer.close().catch(() => {});
  const reader = ds.readable.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); total += value.length; }
  } catch {
    // some producers leave junk after the compressed data; keep what decoded
    if (!total) throw new Error('A compressed part of this PDF could not be read.');
  }
  return concat(chunks, total);
}

function unpredict(data, parms) {
  const predictor = Number(parms?.get('Predictor') ?? 1);
  if (predictor < 10) return data;
  const colors = Number(parms.get('Colors') ?? 1), bpc = Number(parms.get('BitsPerComponent') ?? 8), columns = Number(parms.get('Columns') ?? 1);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8)), rowLen = Math.ceil((columns * colors * bpc) / 8);
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  let prev = new Uint8Array(rowLen);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)], row = data.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1)), cur = out.subarray(r * rowLen, (r + 1) * rowLen);
    for (let i = 0; i < rowLen; i++) {
      const left = i >= bpp ? cur[i - bpp] : 0, up = prev[i], ul = i >= bpp ? prev[i - bpp] : 0;
      let v = row[i];
      if (type === 1) v += left;
      else if (type === 2) v += up;
      else if (type === 3) v += (left + up) >> 1;
      else if (type === 4) { const p = left + up - ul, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - ul); v += pa <= pb && pa <= pc ? left : pb <= pc ? up : ul; }
      cur[i] = v & 0xFF;
    }
    prev = cur;
  }
  return out;
}

async function decodeStream(stream) {
  const f = stream.dict.get('Filter'), p = stream.dict.get('DecodeParms');
  const filters = Array.isArray(f) ? f.map(nameOf) : f ? [nameOf(f)] : [];
  const parms = Array.isArray(p) ? p : [p];
  let data = stream.data;
  for (const [i, name] of filters.entries()) {
    if (name === 'FlateDecode' || name === 'Fl') data = unpredict(await inflate(data), isDict(parms[i]) ? parms[i] : null);
    else if (name === 'ASCIIHexDecode' || name === 'AHx') data = new Lexer(Uint8Array.from(`<${latin1(data)}`, (c) => c.charCodeAt(0))).hexString().bytes;
    else throw new Error(`This PDF uses a compression (${name}) MundusMaker cannot read.`);
  }
  return data;
}

// ---------- document ----------

export class PdfDoc {
  constructor(bytes) {
    this.bytes = bytes;
    this.xref = new Map(); // num -> { type: 1, offset, gen } | { type: 2, stm, index }
    this.cache = new Map();
    this.objStms = new Map();
    this.trailer = new Map();
    this.startxref = 0;
    this.xrefStream = false;
  }
  async resolve(v) { return v instanceof Ref ? this.object(v.num) : v; }
  async object(num) {
    if (this.cache.has(num)) return this.cache.get(num);
    const entry = this.xref.get(num);
    let value = null;
    if (entry?.type === 1) value = await this.objectAt(entry.offset, num);
    else if (entry?.type === 2) value = await this.fromObjStm(entry.stm, entry.index, num);
    this.cache.set(num, value);
    return value;
  }
  genOf(num) { const e = this.xref.get(num); return e?.type === 1 ? e.gen : 0; }
  async objectAt(offset, expect) {
    const lx = new Lexer(this.bytes, offset);
    let num, gen;
    try {
      num = lx.object(); gen = lx.object();
      const kw = lx.object();
      if (!(kw instanceof Keyword) || kw.word !== 'obj' || (expect != null && num !== expect)) throw new Error('bad object header');
    } catch {
      // a stale offset: rebuild the table from the file itself once, then retry
      if (!this.rebuilt && expect != null) { this.rebuild(); const e = this.xref.get(expect); if (e?.type === 1 && e.offset !== offset) return this.objectAt(e.offset, expect); }
      return null;
    }
    const value = lx.object();
    lx.skip();
    if (isDict(value) && lx.peekWord() === 'stream') {
      lx.skip(); lx.word();
      if (this.bytes[lx.pos] === 13) lx.pos++;
      if (this.bytes[lx.pos] === 10) lx.pos++;
      const start = lx.pos;
      let length = value.get('Length');
      if (length instanceof Ref) length = await this.object(length.num);
      let end = Number.isInteger(length) ? start + length : -1;
      const tail = end >= 0 ? indexOf(this.bytes, 'endstream', end, Math.min(this.bytes.length, end + 64)) : -1;
      if (tail < 0) {
        end = indexOf(this.bytes, 'endstream', start);
        if (end < 0) throw new Error('A stream in this PDF has no end.');
        while (end > start && (this.bytes[end - 1] === 10 || this.bytes[end - 1] === 13)) end--;
      }
      return new Stream(value, this.bytes.subarray(start, end));
    }
    return value;
  }
  async fromObjStm(stmNum, index, num) {
    let stm = this.objStms.get(stmNum);
    if (!stm) {
      const s = await this.object(stmNum);
      if (!(s instanceof Stream)) return null;
      const data = await decodeStream(s);
      const n = Number(s.dict.get('N')), first = Number(s.dict.get('First'));
      const lx = new Lexer(data, 0), offsets = new Map();
      for (let i = 0; i < n; i++) { const on = lx.object(), off = lx.object(); offsets.set(on, first + off); }
      stm = { data, offsets };
      this.objStms.set(stmNum, stm);
    }
    const at = stm.offsets.get(num);
    return at == null ? null : new Lexer(stm.data, at).object();
  }
  rebuild() {
    this.rebuilt = true;
    const text = latin1(this.bytes);
    for (const m of text.matchAll(/(?:^|[\r\n\s])(\d+)\s+(\d+)\s+obj\b/g)) {
      const offset = m.index + m[0].length - m[0].trimStart().length;
      const num = Number(m[1]);
      const prev = this.xref.get(num);
      // the last definition in the file wins, as it would after updates
      if (!prev || prev.type !== 1 || prev.offset < offset) this.xref.set(num, { type: 1, offset, gen: Number(m[2]) });
    }
    this.cache.clear();
  }
}

async function readXrefSection(doc, offset, seen) {
  if (seen.has(offset)) return;
  seen.add(offset);
  const lx = new Lexer(doc.bytes, offset);
  lx.skip();
  let trailer;
  if (lx.peekWord() === 'xref') {
    lx.word();
    for (;;) {
      lx.skip();
      if (lx.peekWord() === 'trailer') { lx.word(); trailer = lx.object(); break; }
      const start = lx.object(), count = lx.object();
      if (!Number.isInteger(start) || !Number.isInteger(count)) throw new Error('bad xref table');
      for (let i = 0; i < count; i++) {
        const off = lx.object(), gen = lx.object(), kind = lx.object();
        if (!doc.xref.has(start + i) && kind instanceof Keyword && kind.word === 'n') doc.xref.set(start + i, { type: 1, offset: off, gen });
        else if (!doc.xref.has(start + i)) doc.xref.set(start + i, { type: 0 });
      }
    }
    if (doc.startxref === offset) doc.xrefStream = false;
  } else {
    const s = await doc.objectAt(offset);
    if (!(s instanceof Stream) || nameOf(s.dict.get('Type')) !== 'XRef') throw new Error('bad xref stream');
    const data = await decodeStream(s);
    const w = s.dict.get('W').map(Number), index = s.dict.get('Index') || [0, Number(s.dict.get('Size'))];
    const rowLen = w[0] + w[1] + w[2];
    let at = 0;
    const field = (len, dflt) => { if (!len) return dflt; let v = 0; for (let k = 0; k < len; k++) v = v * 256 + data[at++]; return v; };
    for (let i = 0; i + 1 < index.length; i += 2) {
      for (let k = 0; k < index[i + 1] && at + rowLen <= data.length; k++) {
        const num = index[i] + k, type = field(w[0], 1), f2 = field(w[1], 0), f3 = field(w[2], 0);
        if (doc.xref.has(num)) continue;
        if (type === 1) doc.xref.set(num, { type: 1, offset: f2, gen: f3 });
        else if (type === 2) doc.xref.set(num, { type: 2, stm: f2, index: f3 });
        else doc.xref.set(num, { type: 0 });
      }
    }
    trailer = s.dict;
    if (doc.startxref === offset) doc.xrefStream = true;
  }
  for (const [k, v] of trailer) if (!doc.trailer.has(k) && k !== 'Prev' && k !== 'XRefStm' && k !== 'Length' && k !== 'Filter' && k !== 'DecodeParms' && k !== 'W' && k !== 'Index' && k !== 'Type') doc.trailer.set(k, v);
  if (Number.isInteger(trailer.get('XRefStm'))) await readXrefSection(doc, trailer.get('XRefStm'), seen).catch(() => {});
  if (Number.isInteger(trailer.get('Prev'))) await readXrefSection(doc, trailer.get('Prev'), seen);
}

/** Parse a PDF's structure. Throws a readable Error for files it cannot fill. */
export async function readPdf(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (latin1(bytes, 0, 1024).indexOf('%PDF-') < 0) throw new Error('This file is not a PDF.');
  const doc = new PdfDoc(bytes);
  const at = lastIndexOf(bytes, 'startxref');
  try {
    if (at < 0) throw new Error('no startxref');
    const lx = new Lexer(bytes, at + 9);
    doc.startxref = lx.object();
    await readXrefSection(doc, doc.startxref, new Set());
    if (!doc.trailer.get('Root')) throw new Error('no root');
  } catch {
    // damaged cross-reference data: rebuild it from the objects themselves
    doc.xref.clear(); doc.trailer.clear(); doc.rebuild();
    const adopt = (d) => { for (const k of ['Root', 'Info', 'ID', 'Encrypt']) if (d.has(k)) doc.trailer.set(k, d.get(k)); };
    const tr = lastIndexOf(bytes, 'trailer');
    if (tr >= 0) { try { const d = new Lexer(bytes, tr + 7).object(); if (isDict(d)) adopt(d); } catch { /* keep looking */ } }
    for (const num of [...doc.xref.keys()].sort((a, b) => b - a)) {
      if (doc.trailer.get('Root')) break;
      const o = await doc.object(num);
      const d = o instanceof Stream ? o.dict : o;
      if (isDict(d) && d.get('Root')) { adopt(d); doc.xrefStream = nameOf(d.get('Type')) === 'XRef'; }
      else if (isDict(d) && nameOf(d.get('Type')) === 'Catalog') doc.trailer.set('Root', new Ref(num, doc.genOf(num)));
    }
    if (!doc.trailer.get('Root')) throw new Error('This PDF is damaged: MundusMaker could not find its pages.');
    doc.startxref = 0;
  }
  if (doc.trailer.get('Encrypt')) throw new Error('This PDF is protected with encryption, so MundusMaker cannot fill it. Use an unprotected copy of the sheet.');
  doc.size = Math.max(Number(doc.trailer.get('Size')) || 0, ...[...doc.xref.keys()].map((n) => n + 1));
  return doc;
}

// ---------- form fields ----------

const FLAG = { readOnly: 1, multiline: 1 << 12, password: 1 << 13, radio: 1 << 15, pushbutton: 1 << 16, combo: 1 << 17, comb: 1 << 24 };

async function pageList(doc) {
  const root = await doc.resolve(doc.trailer.get('Root'));
  const pages = [];
  const walk = async (ref, inherited, depth) => {
    if (depth > 64) return;
    const node = await doc.resolve(ref);
    if (!isDict(node)) return;
    const box = node.get('MediaBox') ?? inherited;
    if (nameOf(node.get('Type')) === 'Pages' || node.has('Kids')) {
      for (const kid of (await doc.resolve(node.get('Kids'))) || []) await walk(kid, box, depth + 1);
    } else pages.push({ ref, node, box: (await doc.resolve(box)) || [0, 0, 612, 792] });
  };
  await walk(root.get('Pages'), null, 0);
  return pages;
}

/**
 * The form: every terminal field with its widgets, pages and on-states.
 * Field `name` is the fully qualified name ("parent.child").
 */
export async function readForm(doc) {
  const root = await doc.resolve(doc.trailer.get('Root'));
  const acro = await doc.resolve(root?.get('AcroForm'));
  const pages = await pageList(doc);
  const annotPage = new Map();
  for (const [i, p] of pages.entries()) for (const a of (await doc.resolve(p.node.get('Annots'))) || []) if (a instanceof Ref) annotPage.set(a.num, i);
  const fields = [];
  const seen = new Set();
  const walk = async (ref, parentName, inh, depth) => {
    if (!(ref instanceof Ref) || seen.has(ref.num) || depth > 32) return;
    seen.add(ref.num);
    const node = await doc.resolve(ref);
    if (!isDict(node)) return;
    const partial = node.has('T') ? strText(await doc.resolve(node.get('T'))) : null;
    const name = partial == null ? parentName : parentName ? `${parentName}.${partial}` : partial;
    const own = {};
    for (const k of ['FT', 'Ff', 'V', 'DA', 'Q', 'Opt', 'MaxLen']) own[k] = node.has(k) ? await doc.resolve(node.get(k)) : inh[k];
    const kids = (await doc.resolve(node.get('Kids'))) || [];
    const fieldKids = [], widgetKids = [];
    for (const k of kids) { const kd = await doc.resolve(k); (isDict(kd) && kd.has('T') ? fieldKids : widgetKids).push(k); }
    for (const k of fieldKids) await walk(k, name, own, depth + 1);
    if (fieldKids.length && !widgetKids.length) return;
    const widgetRefs = widgetKids.length ? widgetKids.filter((k) => k instanceof Ref) : node.has('Rect') ? [ref] : [];
    const widgets = [];
    for (const wref of widgetRefs) {
      const w = await doc.resolve(wref);
      if (!isDict(w)) continue;
      const rect = ((await doc.resolve(w.get('Rect'))) || [0, 0, 0, 0]).map(Number);
      const ap = await doc.resolve(w.get('AP'));
      const normal = isDict(ap) ? await doc.resolve(ap.get('N')) : null;
      const onStates = isDict(normal) ? [...normal.keys()].filter((k) => k !== 'Off') : [];
      let page = annotPage.get(wref.num);
      if (page == null && w.get('P') instanceof Ref) page = pages.findIndex((p) => p.ref instanceof Ref && p.ref.num === w.get('P').num);
      const mk = await doc.resolve(w.get('MK'));
      // `state` is the widget's own /AS: some producers tick a box there and leave the field's /V unset
      widgets.push({ ref: wref, rect: [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])], page: page ?? -1, onStates, rotate: isDict(mk) ? Number(mk.get('R') || 0) : 0, state: nameOf(await doc.resolve(w.get('AS'))) });
    }
    const ft = nameOf(own.FT), ff = Number(own.Ff || 0);
    const type = ft === 'Tx' ? 'text' : ft === 'Ch' ? 'choice' : ft === 'Sig' ? 'signature'
      : ft === 'Btn' ? (ff & FLAG.pushbutton ? 'pushbutton' : ff & FLAG.radio ? 'radio' : 'checkbox') : 'unknown';
    fields.push({
      ref, name: name || `(unnamed ${ref.num})`, type, flags: ff,
      readOnly: !!(ff & FLAG.readOnly), multiline: !!(ff & FLAG.multiline), comb: !!(ff & FLAG.comb),
      maxLen: Number.isInteger(own.MaxLen) ? own.MaxLen : null, da: strText(own.DA ?? acro?.get('DA')), q: Number(own.Q ?? acro?.get('Q') ?? 0),
      value: own.V instanceof Name ? own.V.name : strText(own.V),
      options: Array.isArray(own.Opt) ? own.Opt.map((o) => strText(Array.isArray(o) ? o[1] : o)) : [],
      onStates: [...new Set(widgets.flatMap((w) => w.onStates))],
      widgets,
    });
  };
  for (const f of (await doc.resolve(acro?.get('Fields'))) || []) await walk(f, '', {}, 0);
  // Some producers (D&D Beyond's PDFsharp export) put complete fields on the
  // pages as widget annotations and never list them in an AcroForm, which
  // viewers still show. Read those from the top of each one's /Parent chain.
  const listed = fields.length;
  for (const p of pages) {
    for (const a of (await doc.resolve(p.node.get('Annots'))) || []) {
      if (!(a instanceof Ref) || seen.has(a.num)) continue;
      const w = await doc.resolve(a);
      if (!isDict(w) || nameOf(w.get('Subtype')) !== 'Widget') continue;
      let top = a;
      for (let depth = 0, node = w; node.get('Parent') instanceof Ref && depth < 32; depth++) { top = node.get('Parent'); node = await doc.resolve(top); if (!isDict(node)) break; }
      await walk(top, '', {}, 0);
    }
  }
  return {
    fields,
    pages: pages.map((p) => { const b = p.box.map(Number); return { width: b[2] - b[0], height: b[3] - b[1] }; }),
    hasForm: !!acro || fields.length > listed,
    unlisted: fields.length - listed,
    xfa: !!acro?.get('XFA'),
  };
}

// ---------- appearances ----------

// Helvetica advance widths (1/1000 em) for WinAnsi 32..255, from the standard
// font metrics; 0x7F..0x9F are filled from CP1252_WIDTHS below.
const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, 0,
  556, 0, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 0, 611, 0, 0, 222, 222, 333, 333, 350, 556, 1000, 333, 1000, 500, 333, 944, 0, 500, 667,
  278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333, 400, 584, 333, 333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611,
  667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, 722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
  556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278, 556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500];
// Unicode -> WinAnsi byte for the 0x80..0x9F block
const CP1252 = { 0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A, 0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E,
  0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C, 0x017E: 0x9E, 0x0178: 0x9F };

/** Text as WinAnsi bytes; characters Helvetica cannot show become "?". */
function winAnsi(text) {
  const out = [];
  for (const ch of String(text)) {
    const k = ch.codePointAt(0);
    if ((k >= 0x20 && k < 0x7F) || (k >= 0xA0 && k <= 0xFF)) out.push(k);
    else if (CP1252[k]) out.push(CP1252[k]);
    else if (k === 9) out.push(0x20);
    else out.push(0x3F);
  }
  return out;
}
const helvWidth = (bytes, size) => bytes.reduce((n, b) => n + (HELV[b - 32] || 556), 0) * size / 1000;

function wrapBytes(text, width, size) {
  const lines = [];
  for (const para of String(text).split(/\r\n|\r|\n/)) {
    const words = para.split(' ');
    let line = [];
    for (const word of words) {
      const wb = winAnsi(word), next = line.length ? [...line, 0x20, ...wb] : wb;
      if (helvWidth(next, size) <= width || !line.length) { line = next; continue; }
      lines.push(line); line = wb;
    }
    lines.push(line);
  }
  return lines;
}

function pdfLiteral(bytes) {
  let s = '(';
  for (const b of bytes) {
    if (b === 40 || b === 41 || b === 92) s += '\\' + String.fromCharCode(b);
    else if (b < 32 || b > 126) s += '\\' + b.toString(8).padStart(3, '0');
    else s += String.fromCharCode(b);
  }
  return s + ')';
}

const fmt = (n) => { const v = Math.round(n * 1000) / 1000; return Object.is(v, -0) ? '0' : String(v); };

/** The DA string's font size and colour operator ("/Helv 0 Tf 0 g"). */
function parseDA(da) {
  const size = Number((String(da).match(/([\d.]+)\s+Tf/) || [])[1] || 0);
  const color = (String(da).match(/((?:[\d.]+\s+){1,4})(g|rg|k)\b/) || [])[0] || '0 g';
  return { size, color };
}

/** A text widget's normal appearance: Helvetica, sized and aligned as the field asks. */
function textAppearance(field, widget, text) {
  const w = widget.rect[2] - widget.rect[0], h = widget.rect[3] - widget.rect[1];
  const { size: daSize, color } = parseDA(field.da);
  const pad = 2, avail = Math.max(1, w - pad * 2);
  let ops = '';
  if (field.multiline) {
    let size = daSize || 10, lines = wrapBytes(text, avail, size);
    while (!daSize && size > 4 && lines.length * size * 1.15 > h - pad * 2) { size -= 0.5; lines = wrapBytes(text, avail, size); }
    const lead = size * 1.15;
    let y = h - pad - size * 0.88;
    for (const line of lines) {
      if (y < -size) break;
      const tw = helvWidth(line, size), x = field.q === 1 ? (w - tw) / 2 : field.q === 2 ? w - pad - tw : pad;
      ops += `BT /MMHelv ${fmt(size)} Tf ${color} ${fmt(x)} ${fmt(y)} Td ${pdfLiteral(line)} Tj ET\n`;
      y -= lead;
    }
  } else if (field.comb && field.maxLen) {
    const bytes = winAnsi(String(text).slice(0, field.maxLen)), cell = w / field.maxLen;
    const size = daSize || Math.min(12, h * 0.7);
    const y = (h - size * 0.72) / 2;
    bytes.forEach((b, i) => { ops += `BT /MMHelv ${fmt(size)} Tf ${color} ${fmt(i * cell + (cell - helvWidth([b], size)) / 2)} ${fmt(y)} Td ${pdfLiteral([b])} Tj ET\n`; });
  } else {
    const bytes = winAnsi(String(text).replace(/\s*[\r\n]+\s*/g, ' '));
    // the publisher's size when it fits the box; otherwise shrink, but keep it legible
    const tallest = Math.max(4, (h - 1.5) * 0.92);
    let size = daSize ? Math.min(daSize, tallest) : Math.max(4, Math.min(12, (h - 2) * 0.72));
    const floor = daSize ? Math.max(4, Math.min(size, daSize * 0.6)) : 4;
    while (size > floor && helvWidth(bytes, size) > avail) size -= 0.25;
    const tw = helvWidth(bytes, size), y = (h - size * 0.72) / 2;
    const x = field.q === 1 ? (w - tw) / 2 : field.q === 2 ? w - pad - tw : pad;
    ops = `BT /MMHelv ${fmt(size)} Tf ${color} ${fmt(x)} ${fmt(y)} Td ${pdfLiteral(bytes)} Tj ET\n`;
  }
  const content = `/Tx BMC\nq\n1 1 ${fmt(Math.max(0, w - 2))} ${fmt(Math.max(0, h - 2))} re W n\n${ops}Q\nEMC\n`;
  const font = new Map([['Type', new Name('Font')], ['Subtype', new Name('Type1')], ['BaseFont', new Name('Helvetica')], ['Encoding', new Name('WinAnsiEncoding')]]);
  const dict = new Map([['Type', new Name('XObject')], ['Subtype', new Name('Form')], ['BBox', [0, 0, w, h]],
    ['Resources', new Map([['Font', new Map([['MMHelv', font]])]])]]);
  return new Stream(dict, Uint8Array.from(content, (c) => c.charCodeAt(0)));
}

/** A push button drawn as a marked box (V5's humanity boxes are push buttons). */
function markAppearance(widget) {
  const w = widget.rect[2] - widget.rect[0], h = widget.rect[3] - widget.rect[1], s = Math.min(w, h), x = (w - s) / 2, y = (h - s) / 2, inset = s * 0.2;
  const content = `q 0 G 0.6 w ${fmt(x + 0.5)} ${fmt(y + 0.5)} ${fmt(s - 1)} ${fmt(s - 1)} re S 0 g ${fmt(x + inset)} ${fmt(y + inset)} ${fmt(s - inset * 2)} ${fmt(s - inset * 2)} re f Q\n`;
  return new Stream(new Map([['Type', new Name('XObject')], ['Subtype', new Name('Form')], ['BBox', [0, 0, w, h]]]), Uint8Array.from(content, (c) => c.charCodeAt(0)));
}

// ---------- writing ----------

function serialize(v) {
  if (v === null || v === undefined) return 'null';
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (typeof v === 'number') return fmt(v);
  if (v instanceof Name) return '/' + [...v.name].map((c) => { const k = c.charCodeAt(0); return k < 0x21 || k > 0x7E || '()<>[]{}/%#'.includes(c) ? '#' + k.toString(16).padStart(2, '0') : c; }).join('');
  if (v instanceof Ref) return `${v.num} ${v.gen} R`;
  if (v instanceof Str) return v.hex ? `<${[...v.bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}>` : pdfLiteral(v.bytes);
  if (Array.isArray(v)) return `[${v.map(serialize).join(' ')}]`;
  if (isDict(v)) return `<<${[...v].map(([k, x]) => `${serialize(new Name(k))} ${serialize(x)}`).join(' ')}>>`;
  if (v instanceof Keyword) return v.word;
  throw new Error('cannot write this PDF value');
}

const bytesOf = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xFF);

function buildUpdate(doc, changed, added) {
  const base = doc.bytes, parts = [base];
  let offset = base.length;
  const push = (chunk) => { const b = typeof chunk === 'string' ? bytesOf(chunk) : chunk; parts.push(b); offset += b.length; };
  if (base[base.length - 1] !== 10 && base[base.length - 1] !== 13) push('\n');
  const entries = new Map();
  const writeObject = (num, gen, value) => {
    entries.set(num, { offset, gen });
    if (value instanceof Stream) {
      const dict = new Map(value.dict);
      dict.set('Length', value.data.length);
      push(`${num} ${gen} obj\n${serialize(dict)}\nstream\n`); push(value.data); push('\nendstream\nendobj\n');
    } else push(`${num} ${gen} obj\n${serialize(value)}\nendobj\n`);
  };
  for (const [num, value] of changed) writeObject(num, doc.genOf(num), value);
  for (const [num, value] of added) writeObject(num, 0, value);
  let size = Math.max(doc.size, ...[...entries.keys()].map((n) => n + 1));
  const trailer = new Map();
  for (const k of ['Root', 'Info', 'ID']) if (doc.trailer.has(k)) trailer.set(k, doc.trailer.get(k));
  if (doc.startxref) trailer.set('Prev', doc.startxref);
  const runs = (nums) => { const out = []; for (const n of nums.sort((a, b) => a - b)) { const last = out[out.length - 1]; if (last && last[0] + last[1] === n) last[1]++; else out.push([n, 1]); } return out; };
  if (doc.xrefStream) {
    const num = size++;
    entries.set(num, { offset, gen: 0 });
    const order = runs([...entries.keys()]);
    const rows = [];
    for (const [start, count] of order) for (let n = start; n < start + count; n++) { const e = entries.get(n); rows.push(1, (e.offset >>> 24) & 255, (e.offset >>> 16) & 255, (e.offset >>> 8) & 255, e.offset & 255, (e.gen >> 8) & 255, e.gen & 255); }
    const dict = new Map([['Type', new Name('XRef')], ['Size', size], ['W', [1, 4, 2]], ['Index', order.flat()], ...trailer]);
    const start = offset;
    writeObject(num, 0, new Stream(dict, Uint8Array.from(rows)));
    push(`startxref\n${start}\n%%EOF\n`);
  } else {
    const start = offset;
    let table = 'xref\n';
    for (const [first, count] of runs([...entries.keys()])) {
      table += `${first} ${count}\n`;
      for (let n = first; n < first + count; n++) { const e = entries.get(n); table += `${String(e.offset).padStart(10, '0')} ${String(e.gen).padStart(5, '0')} n\r\n`; }
    }
    trailer.set('Size', size);
    push(`${table}trailer\n${serialize(trailer)}\nstartxref\n${start}\n%%EOF\n`);
  }
  return concat(parts, offset);
}

/**
 * Fill fields and return the new PDF bytes (the original plus one update).
 * `values` maps field name -> string (text and choice fields), or for
 * checkboxes true/false (or an on-state name); radio groups take the on-state
 * name of the button to select. Fields not in `values` are left as they are.
 */
export async function fillForm(doc, form, values) {
  const changed = new Map(), added = new Map();
  let next = doc.size;
  const touch = async (ref) => { const o = await doc.resolve(ref); if (ref instanceof Ref && isDict(o)) changed.set(ref.num, o); return o; };
  let filled = 0;
  for (const field of form.fields) {
    if (!Object.prototype.hasOwnProperty.call(values, field.name)) continue;
    const value = values[field.name];
    if (value == null || field.type === 'signature' || field.type === 'unknown') continue;
    if (field.type === 'pushbutton') {
      // buttons hold no value; a true value draws them marked, anything else leaves them alone
      if (value !== true) continue;
      for (const w of field.widgets) {
        const wd = await touch(w.ref);
        if (!wd) continue;
        const num = next++;
        added.set(num, markAppearance(w));
        wd.set('AP', new Map([['N', new Ref(num, 0)]]));
      }
      filled++;
      continue;
    }
    const dict = await touch(field.ref);
    if (!dict) continue;
    if (field.type === 'checkbox' || field.type === 'radio') {
      const wanted = typeof value === 'string' && value && value !== 'Off' ? value : null;
      const on = value === true || !!wanted;
      let chosen = null;
      for (const w of field.widgets) {
        const wd = await touch(w.ref);
        const state = !on ? 'Off' : wanted ? (w.onStates.includes(wanted) ? wanted : 'Off') : field.type === 'radio' ? (chosen ? 'Off' : w.onStates[0] || 'Off') : w.onStates[0] || 'Off';
        if (state !== 'Off') chosen = state;
        wd.set('AS', new Name(state));
      }
      dict.set('V', new Name(chosen || 'Off'));
      filled++;
      continue;
    }
    const text = String(value);
    dict.set('V', textStr(text));
    for (const w of field.widgets) {
      const wd = await touch(w.ref);
      if (!wd || w.rotate) { wd?.delete('AP'); continue; } // rotated widgets: the viewer draws them
      const num = next++;
      added.set(num, textAppearance(field, w, text));
      wd.set('AP', new Map([['N', new Ref(num, 0)]]));
    }
    filled++;
  }
  // Every filled field carries its own appearance (shrunk to fit), so viewers
  // must not redraw them at the publisher's fixed sizes, which clips longer
  // values. An XFA form would be shown instead of these fields; drop it.
  const rootRef = doc.trailer.get('Root');
  const root = await doc.resolve(rootRef);
  const acroRef = root.get('AcroForm');
  const acro = acroRef instanceof Ref ? await doc.resolve(acroRef) : acroRef;
  if (isDict(acro) && (acro.has('NeedAppearances') || acro.has('XFA'))) {
    acro.delete('NeedAppearances');
    acro.delete('XFA');
    if (acroRef instanceof Ref) changed.set(acroRef.num, acro);
    else if (rootRef instanceof Ref) changed.set(rootRef.num, root);
  }
  doc.size = next;
  return { bytes: buildUpdate(doc, changed, added), filled };
}
