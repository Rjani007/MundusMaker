const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { jsPDF } = require('../public/vendor/jspdf.umd.min.js');
function moduleUrl(file) {
  const source = fs.readFileSync(file, 'utf8').replace(/from '(\.\.?\/[^']+)'/g,
    (_, relative) => `from '${moduleUrl(path.resolve(path.dirname(file), relative))}'`);
  return 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
}
const catalog = require('../public/systems/coc7.json').skills;
const load = file => import(moduleUrl(path.resolve(__dirname, '../public/js/sheets', file)));

test('CoC exports include every base skill and preserve saved values, specialties and flags without mutation', async () => {
  const { completeSkills } = await load('cocskills.js');
  const data = { characteristics: { DEX: 65, EDU: 71 }, dodge: 42, skills: [
    { name: 'Accounting', value: 0, improve: true, occupational: true },
    { name: 'Science (Astronomy)', value: 63 },
  ] };
  const before = JSON.stringify(data), skills = completeSkills(data, catalog);
  for (const s of catalog) assert.ok(skills.some(row => row.name === s.name), s.name);
  assert.deepEqual(skills.find(s => s.name === 'Accounting'), data.skills[0]);
  assert.equal(skills.find(s => s.name === 'Dodge').value, 42);
  assert.equal(skills.find(s => s.name === 'Language (Own)').value, 71);
  assert.equal(skills.find(s => s.name === 'Science (Astronomy)').value, 63);
  assert.equal(completeSkills({ characteristics: { DEX: 65 } }, catalog).find(s => s.name === 'Dodge').value, 32);
  assert.equal(JSON.stringify(data), before);
});

test('CoC skill tables continue on A4 and Letter, retaining every skill and secrecy banner', async () => {
  const { completeSkills } = await load('cocskills.js');
  const { writeSystemSheet } = await load('sheetpdf.js');
  for (const format of ['a4', 'letter']) {
    const skills = completeSkills({ skills: Array.from({ length: 80 }, (_, i) => ({ name: `Custom specialty ${String(i).padStart(3, '0')}`, value: 63 })) }, catalog);
    const doc = new jsPDF({ unit: 'pt', format });
    const calls = [], original = doc.text.bind(doc);
    doc.text = (value, x, y, ...rest) => { calls.push({ value: [].concat(value).join(' '), y }); return original(value, x, y, ...rest); };
    writeSystemSheet(doc, 'coc7', { skills }, { name: 'Export test investigator', safe: String, firstPage: true, gm: true, secret: true });
    for (const skill of skills) assert.ok(calls.some(c => c.value === skill.name), `${format}: ${skill.name}`);
    assert.ok(doc.getNumberOfPages() >= 3);
    assert.equal(calls.filter(c => c.value === 'GM SECRET').length, doc.getNumberOfPages());
    assert.ok(calls.every(c => c.y <= doc.internal.pageSize.getHeight() - 18));
    if (process.env.COC_PDF_FIXTURES) {
      fs.mkdirSync(path.resolve(__dirname, '../tmp/pdfs'), { recursive: true });
      fs.writeFileSync(path.resolve(__dirname, `../tmp/pdfs/coc-${format}.pdf`), Buffer.from(doc.output('arraybuffer')));
    }
  }
});
