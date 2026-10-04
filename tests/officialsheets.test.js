'use strict';
// "Use my own official sheet": the zero-dependency PDF form filler and the
// value maps. Hermetic: every PDF here is built by the test (classic and
// compressed cross-references, object streams, updates); no publisher file is
// needed or shipped. scripts/official-sheet-check.js checks the real sheets.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const load = require('./module-loader');

// ---------- synthetic fillable PDFs ----------

const AP = '<< /Type /XObject /Subtype /Form /BBox [0 0 12 12] /Length 0 >>\nstream\n\nendstream';
// objects 1..13: catalog (AcroForm inline), pages, page, then the fields
function formObjects() {
  return {
    1: '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [4 0 R 5 0 R 6 0 R 8 0 R 11 0 R 12 0 R] /DA (/Helv 0 Tf 0 g) /NeedAppearances true >> >>',
    2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Annots [4 0 R 5 0 R 6 0 R 9 0 R 10 0 R 11 0 R 13 0 R] >>',
    4: '<< /FT /Tx /T (Name) /Rect [50 700 250 720] /Subtype /Widget /Type /Annot /DA (/Helv 12 Tf 0 g) /P 3 0 R >>',
    5: '<< /FT /Tx /Ff 4096 /T (Notes) /Rect [50 500 300 650] /Subtype /Widget /DA (/Helv 0 Tf 0 g) >>',
    6: '<< /FT /Btn /T (Brave) /Rect [50 450 62 462] /Subtype /Widget /AS /Off /V /Off /AP << /N << /Yes 7 0 R /Off 7 0 R >> >> >>',
    7: AP,
    8: '<< /FT /Btn /Ff 49152 /T (Path) /Kids [9 0 R 10 0 R] >>',
    9: '<< /Parent 8 0 R /Subtype /Widget /Rect [50 400 62 412] /AP << /N << /Left 7 0 R /Off 7 0 R >> >> /AS /Off >>',
    10: '<< /Parent 8 0 R /Subtype /Widget /Rect [80 400 92 412] /AP << /N << /Right 7 0 R /Off 7 0 R >> >> /AS /Off >>',
    11: '<< /FT /Btn /Ff 65536 /T (Mark) /Rect [50 350 62 362] /Subtype /Widget >>',
    12: '<< /T (group) /Kids [13 0 R] >>',
    13: '<< /FT /Tx /T (inner) /Parent 12 0 R /Subtype /Widget /Rect [50 300 150 312] /DA (/Helv 9 Tf 0 g) >>',
  };
}

function classicPdf(objects = formObjects(), trailerExtra = '') {
  let out = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n';
  const offsets = {};
  for (const [num, body] of Object.entries(objects)) { offsets[num] = Buffer.byteLength(out, 'latin1'); out += `${num} 0 obj\n${body}\nendobj\n`; }
  const size = Math.max(...Object.keys(objects).map(Number)) + 1;
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${size}\n0000000000 65535 f\r\n`;
  for (let n = 1; n < size; n++) out += offsets[n] != null ? `${String(offsets[n]).padStart(10, '0')} 00000 n\r\n` : '0000000000 00000 f\r\n';
  out += `trailer\n<< /Size ${size} /Root 1 0 R ${trailerExtra}>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// the same form with its fields packed in a compressed object stream and a
// compressed, PNG-predicted cross-reference stream (what publishers ship)
function compressedPdf() {
  const all = formObjects();
  const packed = [4, 5, 6, 8, 9, 10, 11, 12, 13];
  let header = '', bodies = '';
  for (const n of packed) { header += `${n} ${Buffer.byteLength(bodies, 'latin1')} `; bodies += all[n] + '\n'; }
  const objstm = zlib.deflateSync(Buffer.from(header + bodies, 'latin1'));
  let out = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1');
  const offsets = {};
  const add = (num, head, stream) => {
    offsets[num] = out.length;
    const parts = [Buffer.from(`${num} 0 obj\n${head}`, 'latin1')];
    if (stream) parts.push(Buffer.from('\nstream\n', 'latin1'), stream, Buffer.from('\nendstream', 'latin1'));
    parts.push(Buffer.from('\nendobj\n', 'latin1'));
    out = Buffer.concat([out, ...parts]);
  };
  for (const n of [1, 2, 3]) add(n, all[n]);
  add(7, all[7]);
  add(14, `<< /Type /ObjStm /N ${packed.length} /First ${Buffer.byteLength(header, 'latin1')} /Filter /FlateDecode /Length ${objstm.length} >>`, objstm);
  const xrefAt = out.length;
  const rows = [];
  for (let n = 0; n <= 15; n++) {
    let type = 0, f2 = 0, f3 = 0;
    if (n === 15) { type = 1; f2 = xrefAt; }
    else if (offsets[n] != null) { type = 1; f2 = offsets[n]; }
    else if (packed.includes(n)) { type = 2; f2 = 14; f3 = packed.indexOf(n); }
    rows.push([type, (f2 >>> 24) & 255, (f2 >>> 16) & 255, (f2 >>> 8) & 255, f2 & 255, (f3 >> 8) & 255, f3 & 255]);
  }
  const predicted = [];
  rows.forEach((row, r) => { predicted.push(2, ...row.map((b, i) => (b - (r ? rows[r - 1][i] : 0)) & 255)); });
  const xs = zlib.deflateSync(Buffer.from(predicted));
  add(15, `<< /Type /XRef /Size 16 /Root 1 0 R /W [1 4 2] /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 7 >> /Length ${xs.length} >>`, xs);
  return Buffer.concat([out, Buffer.from(`startxref\n${xrefAt}\n%%EOF\n`, 'latin1')]);
}

const byName = (form) => Object.fromEntries(form.fields.map((f) => [f.name, f]));

test('reads fields from classic and compressed cross-references alike', async () => {
  const { readPdf, readForm } = await load('sheets/pdfform.js');
  for (const bytes of [classicPdf(), compressedPdf()]) {
    const doc = await readPdf(new Uint8Array(bytes));
    const form = await readForm(doc);
    const f = byName(form);
    assert.deepEqual(Object.keys(f).sort(), ['Brave', 'Mark', 'Name', 'Notes', 'Path', 'group.inner']);
    assert.equal(f.Name.type, 'text');
    assert.equal(f.Notes.multiline, true);
    assert.equal(f.Brave.type, 'checkbox');
    assert.deepEqual(f.Brave.onStates, ['Yes']);
    assert.equal(f.Path.type, 'radio');
    assert.deepEqual(f.Path.onStates.sort(), ['Left', 'Right']);
    assert.equal(f.Mark.type, 'pushbutton');
    assert.equal(f.Name.widgets[0].page, 0);
    assert.deepEqual(form.pages, [{ width: 612, height: 792 }]);
  }
});

test('filling appends one update and never rewrites the original bytes', async () => {
  const { readPdf, readForm, fillForm } = await load('sheets/pdfform.js');
  for (const [kind, original] of [['classic', classicPdf()], ['compressed', compressedPdf()]]) {
    const doc = await readPdf(new Uint8Array(original));
    const form = await readForm(doc);
    const { bytes, filled } = await fillForm(doc, form, { Name: 'Vesper Ashgrove', Notes: 'Line one\nLine two', Brave: true, Path: 'Right', Mark: true, 'group.inner': 'Café ✓', Missing: 'x' });
    assert.equal(filled, 6, kind);
    assert.deepEqual(Buffer.from(bytes.subarray(0, original.length)), original, `${kind}: the original is a prefix of the result`);
    const update = Buffer.from(bytes.subarray(original.length)).toString('latin1');
    assert.match(update, kind === 'classic' ? /\nxref\n/ : /\/Type \/XRef/, `${kind}: the update uses the original's cross-reference kind`);
    assert.doesNotMatch(update, /NeedAppearances true/, 'filled fields keep their own appearances');
    const again = byName(await readForm(await readPdf(bytes)));
    assert.equal(again.Name.value, 'Vesper Ashgrove');
    assert.equal(again.Notes.value, 'Line one\nLine two');
    assert.equal(again.Brave.value, 'Yes');
    assert.equal(again.Path.value, 'Right');
    assert.equal(again['group.inner'].value, 'Café ✓', 'text outside Latin-1 survives as UTF-16');
    // every widget of a filled text field now carries an appearance stream
    assert.match(update, /\/Tx BMC/);
    assert.match(update, /\(Vesper Ashgrove\) Tj/);
    // filling the filled copy again chains a second update onto the first
    const doc2 = await readPdf(bytes);
    const second = await fillForm(doc2, await readForm(doc2), { Name: 'Second' });
    assert.equal(byName(await readForm(await readPdf(second.bytes))).Name.value, 'Second');
  }
});

test('refuses encrypted files and rebuilds a damaged cross-reference', async () => {
  const { readPdf, readForm } = await load('sheets/pdfform.js');
  await assert.rejects(readPdf(new Uint8Array(classicPdf(formObjects(), '/Encrypt << /Filter /Standard /V 1 >> '))), /encryption/);
  await assert.rejects(readPdf(new TextEncoder().encode('hello')), /not a PDF/);
  const broken = Buffer.from(classicPdf().toString('latin1').replace(/startxref\n\d+/, 'startxref\n12'), 'latin1');
  const form = await readForm(await readPdf(new Uint8Array(broken)));
  assert.equal(form.fields.length, 6);
});

// ---------- value maps ----------

const fakeForm = (names, type = 'text') => ({ fields: names.map((name) => ({ name, type: typeof type === 'function' ? type(name) : type, value: '', widgets: [{ page: 0 }] })) });

test('the official D&D sheet is recognised and filled field by field', async () => {
  const { TEMPLATES, planFill, recognize } = await load('sheets/officialsheets.js');
  const t = TEMPLATES.find((x) => x.id === 'dnd2024-wotc');
  const form = fakeForm(Object.keys(t.fields), (n) => (/^Check Box/.test(n) ? 'checkbox' : 'text'));
  assert.equal(recognize('dnd2024', form), t);
  assert.equal(recognize('dnd2024', fakeForm(['Text1', 'Text6'])), null, 'a couple of shared names is not enough');
  const data = { klass: { name: 'Bard', level: 5, hitDie: 8 }, abilities: { str: 8, dex: 14, con: 13, int: 12, wis: 10, cha: 18 }, saves: ['cha'], skills: [{ key: 'Arcana', prof: 'prof' }],
    hp: { max: 38, current: 31 }, deathSaves: { success: 2 }, attacks: [{ name: 'Rapier', bonus: 5, damage: '1d8+2 piercing' }],
    spellcasting: { ability: 'cha', dc: 15, slots: { 1: { max: 4, used: 3 } }, cantrips: ['Light'], prepared: ['Bless'] }, spellDetails: [{ name: 'Bless', level: 1, castingTime: '1 bonus action', concentration: true }],
    coins: { gp: 147 } };
  const { fill } = planFill('dnd2024', data, 'Vesper', form);
  assert.equal(fill.Text1, 'Vesper');
  assert.equal(fill.Text14, '31');
  assert.equal(fill.Text25, '+4', 'CHA modifier');
  assert.equal(fill['Check Box26'], true, 'CHA save proficiency');
  assert.equal(fill['Check Box37'], false, 'STR save not proficient');
  assert.equal(fill['Check Box16'], true, 'Arcana proficiency');
  assert.equal(fill['Check Box5'], true);
  assert.equal(fill['Check Box6'], true);
  assert.equal(fill['Check Box7'], false, 'two of three death save successes');
  assert.equal(fill.Text30, 'Rapier');
  assert.equal(fill.Text112, '4', 'level 1 slot total');
  assert.deepEqual(['Check Box227', 'Check Box228', 'Check Box229', 'Check Box230'].map((n) => fill[n]), [true, true, true, false]);
  assert.equal(fill['Text106.1'], 'Bless');
  assert.equal(fill['Text107.1'], 'Bonus', 'casting times are written the way the narrow column needs');
  assert.equal(fill['Check Box252.1'], true, 'concentration');
  assert.equal(fill.Text269, '147', 'gold');
});

test('Call of Cthulhu specialisms fill their own rows; untrained extras stay off the sheet', async () => {
  const { TEMPLATES, planFill } = await load('sheets/officialsheets.js');
  for (const id of ['coc7-chaosium-1920s', 'coc7-chaosium-modern']) {
    const t = TEMPLATES.find((x) => x.id === id);
    const names = [...Object.keys(t.fields), ...Object.values(t.slots).flat(2)];
    const form = fakeForm(names, (n) => (/(_check|_Chk)$/.test(n) ? 'checkbox' : 'text'));
    const skills = [{ name: 'Spot Hidden', value: 55, improve: true }, { name: 'Art/Craft (Bookbinding)', value: 45 }, { name: 'Art/Craft', value: 5 },
      { name: 'Language (Other)', value: 1 }, { name: 'Language (Latin)', value: 51 }, { name: 'Science (Chemistry)', value: 21 }, { name: 'Operate Heavy Machinery', value: 1 },
      { name: 'Hypnosis', value: 30 }];
    const data = { characteristics: { STR: 45 }, skills, skillBases: { 'Spot Hidden': 25, 'Art/Craft': 5, 'Language (Other)': 1, 'Operate Heavy Machinery': 1, Science: 1 }, hp: { max: 11, current: 9 } };
    const { fill } = planFill('coc7', data, 'Harriet', form);
    const slots = t.slots;
    const values = Object.values(fill).map(String);
    assert.equal(fill[slots['Art/Craft'][0][0]], 'Bookbinding', id);
    assert.equal(fill[slots['Art/Craft'][0][1]], '45');
    assert.equal(fill[slots.Language[0][0]], 'Latin', `${id}: the untrained generic row gives way`);
    assert.equal(fill[slots.Science[0][0]], 'Chemistry');
    assert.equal(fill[slots.other[0][0]], 'Hypnosis', 'anything else takes a spare row');
    assert.ok(!values.includes('Operate Heavy Machinery'), 'an untrained skill with no row of its own is left off');
    assert.ok(!values.includes('Other'));
  }
});

test('V5 dots, damage and humanity reach their boxes', async () => {
  const { TEMPLATES, planFill } = await load('sheets/officialsheets.js');
  const t = TEMPLATES.find((x) => x.id === 'vtm5-renegade');
  const form = fakeForm(Object.keys(t.fields), (n) => (/^Button7/.test(n) ? 'pushbutton' : /^(health|will)\d|^[A-Z]|^AT\.|^Row|^adflaw\d+$/.test(n) ? 'text' : 'checkbox'));
  const data = { attributes: { strength: 3, stamina: 2 }, skills: { Performance: 4 }, specialties: [{ skill: 'Performance', name: 'Opera' }], health: { superficial: 2, aggravated: 1 },
    humanity: 7, hunger: 2, disciplines: [{ name: 'Presence', rating: 2, powers: [{ name: 'Awe' }] }] };
  const { fill } = planFill('vtm5', data, 'Isolde', form);
  assert.deepEqual([1, 2, 3, 4, 5].map((n) => fill[`strength${n}`]), [true, true, true, false, false]);
  assert.deepEqual([1, 2, 3, 4].map((n) => fill[`health${n}`]), ['X', '/', '/', undefined], 'aggravated first, then superficial');
  assert.equal(fill['AT.1.1.2.7'], 'Opera', 'the Performance specialty line');
  assert.equal(fill.Main1, 'Presence');
  assert.equal(fill.Row1, 'Awe');
  assert.equal(fill['main1-2'], true);
  assert.equal(fill['Button7.6'], true);
  assert.equal(fill['Button7.7'], false, 'humanity 7 marks seven boxes');
});

test('other sheets are matched by field name, and the GM can override any field', async () => {
  const { planFill } = await load('sheets/officialsheets.js');
  const form = fakeForm(['CharacterName', 'ClassLevel', 'STR', 'STRmod', 'ST Strength', 'HPMax', 'Arcana', 'Mystery']);
  const data = { klass: { name: 'Wizard', level: 3 }, abilities: { str: 8 }, hp: { max: 20 } };
  let plan = planFill('dnd2024', data, 'Mira', form);
  assert.equal(plan.template, null);
  assert.equal(plan.fill.CharacterName, 'Mira');
  assert.equal(plan.fill.STR, '8');
  assert.equal(plan.fill.STRmod, '-1');
  assert.equal(plan.fill['ST Strength'], '-1');
  assert.equal(plan.fill.HPMax, '20');
  assert.equal(plan.fill.Mystery, undefined);
  plan = planFill('dnd2024', data, 'Mira', form, { Mystery: 'class', STR: '' });
  assert.equal(plan.fill.Mystery, 'Wizard');
  assert.equal(plan.fill.STR, undefined, 'a field the GM blanked stays untouched');
  assert.equal(plan.rows.find((r) => r.field === 'Mystery').source, 'yours');
});

// ---------- storage ----------

test('sheet PDFs are stored outside worlds and only sent back as downloads', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mundusmaker-sheets-test-'));
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const child = spawn(process.execPath, ['server.js', root, String(port), '--no-open'], { cwd: path.resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let logs = '';
  child.stdout.on('data', (c) => { logs += c; }); child.stderr.on('data', (c) => { logs += c; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'mundusmaker-sheets-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/status')).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 30)); }
  const call = async (url, method = 'GET', body) => {
    const res = await fetch(base + url, { method, headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, headers: res.headers, body: res.headers.get('content-type')?.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
  const pdf = classicPdf();
  assert.equal((await call('/api/sheet-templates', 'POST', { system: 'dnd2024', fileName: 'x.txt', dataBase64: Buffer.from('not a pdf').toString('base64') })).status, 400);
  assert.equal((await call('/api/sheet-templates', 'POST', { system: 'pathfinder', fileName: 'x.pdf', dataBase64: pdf.toString('base64') })).status, 400);
  const added = await call('/api/sheet-templates', 'POST', { system: 'dnd2024', fileName: 'My sheet.pdf', label: 'My sheet', dataBase64: pdf.toString('base64'), choices: { __proto__: 'x', Name: 'name' } });
  assert.equal(added.status, 200, logs);
  const id = added.body.id;
  assert.ok(fs.existsSync(path.join(root, '.sheet-templates', id, 'sheet.pdf')));
  assert.ok(!fs.readdirSync(path.join(root, 'worlds')).some((w) => fs.existsSync(path.join(root, 'worlds', w, 'sheet.pdf'))));
  const file = await call(`/api/sheet-templates/${id}/pdf`);
  assert.deepEqual(file.body, pdf);
  assert.equal(file.headers.get('content-type'), 'application/pdf');
  assert.match(file.headers.get('content-disposition'), /^attachment/);
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(file.headers.get('content-security-policy'), 'sandbox');
  const updated = await call(`/api/sheet-templates/${id}`, 'PUT', { choices: { Notes: 'backstory', constructor: 'x' } });
  assert.deepEqual(updated.body.choices, { Notes: 'backstory' });
  assert.equal((await call('/api/sheet-templates')).body.length, 1);
  assert.equal((await call('/api/sheet-templates/..%2Fworlds/pdf')).status, 400);
  assert.equal((await call(`/api/sheet-templates/${id}`, 'DELETE')).status, 200);
  assert.equal((await call('/api/sheet-templates')).body.length, 0);
  assert.ok(fs.readdirSync(path.join(root, '.trash')).some((n) => n.startsWith(`sheet-${id}`)), 'removed sheets go to the trash');
});

test('an older server still running after an update asks for a restart', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  const reply = (status, body) => async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const { api, RESTART_NEEDED } = await load('api.js');
  // a server from before this release answers its catch-all for the new routes
  globalThis.fetch = reply(404, { error: 'unknown api route' });
  await assert.rejects(api.sheetTemplates(), (err) => err.message === RESTART_NEEDED && err.status === 404);
  await assert.rejects(api.checkForUpdates(), (err) => err.message === RESTART_NEEDED);
  // any other 404 keeps the server's own words
  globalThis.fetch = reply(404, { error: 'sheet not found' });
  await assert.rejects(api.updateSheetTemplate('x', { choices: {} }), { message: 'sheet not found' });
});
