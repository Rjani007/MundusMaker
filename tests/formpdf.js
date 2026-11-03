'use strict';
// A synthetic fillable PDF built from field names alone, so the sheet PDF import tests
// need no publisher's file (dndpdfimport.test.js, vtmpdfimport.test.js).

// PDF text string: literal for plain ASCII, UTF-16BE hex otherwise
const pdfString = (s) => (/^[\x20-\x7e\n]*$/.test(s)
  ? `(${s.replace(/[\\()]/g, (c) => `\\${c}`).replace(/\n/g, '\\n')})`
  : `<FEFF${[...s].map((c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('')}>`);

/**
 * fields: [{ name, type: 'text'|'checkbox'|'pushbutton', value, on, asOnly, widgets, caption, drawn }].
 * Dotted names become a field tree ("Text105.0" is kid "0" of "Text105"), as in real
 * sheets. `asOnly` ticks a box through its widget's /AS and leaves /V unset; `on` names its
 * on-state (default Yes); `widgets: 2` gives a box field two boxes (the official V5 sheet's
 * shared fifth dot). A push button's `caption` is its /MK /CA and `drawn` the operators of
 * its appearance. `listed: false` leaves the widgets on the page with no AcroForm, as D&D
 * Beyond's export does; `acroForm: false` drops both, like a flattened or printed PDF.
 * `imagesOver` names fields to draw a picture over in the page content, the way Progeny's
 * export ticks Humanity.
 */
function formPdf(fields, { acroForm = true, listed = acroForm, imagesOver = [] } = {}) {
  const objs = {
    1: null, 2: '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    3: '<< /Type /XObject /Subtype /Form /BBox [0 0 10 10] /Length 0 >>\nstream\n\nendstream',
  };
  let next = 5;
  const roots = [], annots = [], nodes = new Map(), rects = new Map();
  const node = (path) => {
    if (nodes.has(path)) return nodes.get(path);
    const parts = path.split('.'), parent = parts.length > 1 ? node(parts.slice(0, -1).join('.')) : null;
    const n = { num: next++, partial: parts[parts.length - 1], parent, kids: [], widgetKids: [] };
    if (parent) parent.kids.push(n); else roots.push(n);
    nodes.set(path, n);
    return n;
  };
  const stream = (content) => {
    const num = next++;
    objs[num] = `<< /Type /XObject /Subtype /Form /BBox [0 0 10 10] /Length ${content.length} >>\nstream\n${content}\nendstream`;
    return num;
  };
  fields.forEach((f, i) => {
    const n = node(f.name);
    const rect = [20 + (i % 10) * 50, 20 + Math.floor(i / 10) % 70 * 10, 60 + (i % 10) * 50, 28 + Math.floor(i / 10) % 70 * 10];
    rects.set(f.name, rect);
    const widget = (k) => `/Rect [${rect[0] + k * 5} ${rect[1]} ${rect[2] + k * 5} ${rect[3]}] /Subtype /Widget /Type /Annot /P 4 0 R`;
    if (f.type === 'checkbox') {
      const on = !!f.value, state = f.on || 'Yes';
      const look = `/AS ${on ? `/${state}` : '/Off'} /AP << /N << /${state} 3 0 R /Off 3 0 R >> >>`;
      n.body = `/FT /Btn ${on && !f.asOnly ? `/V /${state}` : f.asOnly ? '' : '/V /Off'}`;
      if ((f.widgets || 1) > 1) {
        for (let k = 0; k < f.widgets; k++) { const w = next++; objs[w] = `<< /Parent ${n.num} 0 R ${look} ${widget(k)} >>`; n.widgetKids.push(w); annots.push(w); }
        return;
      }
      n.body += ` ${look}`;
    } else if (f.type === 'pushbutton') {
      n.body = `/FT /Btn /Ff 65536 /MK << ${f.caption ? `/CA ${pdfString(f.caption)}` : ''} >>${f.drawn ? ` /AP << /N ${stream(f.drawn)} 0 R >>` : ''}`;
    } else n.body = `/FT /Tx ${f.value ? `/V ${pdfString(String(f.value))}` : ''} /DA (/Helv 0 Tf 0 g)`;
    n.body += ` ${widget(0)}`;
    annots.push(n.num);
  });
  for (const n of nodes.values()) {
    const kidNums = [...n.kids.map((k) => k.num), ...n.widgetKids];
    const kids = kidNums.length ? ` /Kids [${kidNums.map((k) => `${k} 0 R`).join(' ')}]` : '';
    objs[n.num] = `<< /T ${pdfString(n.partial)}${n.parent ? ` /Parent ${n.parent.num} 0 R` : ''}${kids} ${n.body || ''} >>`;
  }
  // pictures drawn as pdf-lib draws them: q, translate, scale, Do, Q
  let page = '';
  if (imagesOver.length) {
    const img = next++, content = next++;
    objs[img] = '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\xff\nendstream';
    const ops = imagesOver.map((name) => { const [x0, y0, x1, y1] = rects.get(name); return `q\n1 0 0 1 ${x0 + 2} ${y0 + 1} cm\n${x1 - x0 - 4} 0 0 ${y1 - y0 - 2} 0 0 cm\n/Tick Do\nQ`; }).join('\n');
    objs[content] = `<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`;
    page = ` /Resources << /XObject << /Tick ${img} 0 R >> >> /Contents ${content} 0 R`;
  }
  objs[1] = `<< /Type /Catalog /Pages 2 0 R${listed ? ` /AcroForm << /Fields [${roots.map((r) => `${r.num} 0 R`).join(' ')}] /DA (/Helv 0 Tf 0 g) >>` : ''} >>`;
  objs[4] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]${page}${acroForm ? ` /Annots [${annots.map((a) => `${a} 0 R`).join(' ')}]` : ''} >>`;
  let out = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n';
  const offsets = {};
  const size = Math.max(...Object.keys(objs).map(Number)) + 1;
  for (let num = 1; num < size; num++) { if (objs[num] == null) continue; offsets[num] = Buffer.byteLength(out, 'latin1'); out += `${num} 0 obj\n${objs[num]}\nendobj\n`; }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${size}\n0000000000 65535 f\r\n`;
  for (let num = 1; num < size; num++) out += offsets[num] != null ? `${String(offsets[num]).padStart(10, '0')} 00000 n\r\n` : '0000000000 00000 f\r\n';
  out += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

module.exports = { formPdf };
