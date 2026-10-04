'use strict';
/*
 * Check the built-in official-sheet maps against the publishers' real PDFs.
 * The PDFs are never part of the repository or a release: put your own copies
 * in tmp/official-sheets/ (git-ignored) or pass a folder. For each PDF this
 * reports which built-in map recognises it, how many of the map's fields the
 * file still has, and fills it with a sample character, re-reads the result
 * and confirms every value landed in its field.
 *
 *   node scripts/official-sheet-check.js [folder] [--out dir]
 *
 * Exit code 1 when a recognised sheet lost mapped fields (a publisher revised
 * its PDF: update TEMPLATES in public/js/sheets/officialsheets.js).
 */
const fs = require('fs');
const path = require('path');
const load = require('../tests/module-loader');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const outDir = argv.includes('--out') ? path.resolve(argv.splice(argv.indexOf('--out'), 2)[1]) : null;
const folder = path.resolve(argv[0] || path.join(ROOT, 'tmp', 'official-sheets'));

const SAMPLES = {
  dnd2024: { name: 'Check Character', data: { klass: { name: 'Bard', level: 5, hitDie: 8, subclass: 'Lore' }, species: { name: 'Tiefling', size: 'Medium' }, background: { name: 'Charlatan' },
    abilities: { str: 8, dex: 14, con: 13, int: 12, wis: 10, cha: 18 }, saves: ['dex', 'cha'], skills: [{ key: 'Deception', prof: 'expert' }], hp: { max: 38, current: 31, temp: 5 },
    deathSaves: { success: 1 }, inspiration: true, attacks: [{ name: 'Rapier', bonus: 5, damage: '1d8+2 piercing', notes: 'Finesse' }], coins: { gp: 147 },
    spellcasting: { ability: 'cha', dc: 15, attackBonus: 7, slots: { 1: { max: 4, used: 1 } }, cantrips: ['Vicious Mockery'], prepared: ['Healing Word'] },
    proficiencies: { armor: ['light'], weapons: ['simple'], tools: ['Lute'] }, languages: ['Common'], appearance: 'Grey skin', alignment: 'Chaotic Good' } },
  vtm5: { name: 'Check Character', data: { clan: 'Toreador', generation: 12, concept: 'Singer', attributes: { strength: 2, stamina: 2, composure: 3, resolve: 2 }, skills: { Performance: 4 },
    specialties: [{ skill: 'Performance', name: 'Opera' }], disciplines: [{ name: 'Presence', rating: 2, powers: [{ name: 'Awe' }] }], hunger: 2, humanity: 7,
    health: { superficial: 1 }, advantages: [{ name: 'Fame', dots: 2 }], bloodPotency: 1, xp: { total: 12, spent: 5 } } },
  coc7: { name: 'Check Character', data: { era: '1920s', age: 42, sex: 'F', occupation: { name: 'Antiquarian' }, characteristics: { STR: 45, CON: 60, SIZ: 55, DEX: 50, APP: 65, INT: 80, POW: 60, EDU: 85 },
    hp: { max: 11, current: 9 }, mp: { max: 12, current: 10 }, luck: 55, san: { start: 60, current: 57, max: 99 }, move: 7, build: 0, damageBonus: '0', dodge: 25,
    skills: [{ name: 'Spot Hidden', value: 55, improve: true }, { name: 'Art/Craft (Bookbinding)', value: 45 }, { name: 'Language (Latin)', value: 51 }, { name: 'Science (Chemistry)', value: 21 }],
    weapons: [{ name: '.32 Revolver', skill: 30, damage: '1D8', range: '15 yd', attacks: '1 (3)', ammo: '6', malf: '100' }], cash: '$42', backstory: { description: 'Tall' } } },
};

(async () => {
  if (!fs.existsSync(folder)) { console.log(`No folder ${folder}. Put your own copies of the official sheets there.`); return; }
  const { readPdf, readForm, fillForm } = await load('sheets/pdfform.js');
  const { TEMPLATES, recognize, planFill } = await load('sheets/officialsheets.js');
  const { withSkillBases } = await load('sheets/cocskills.js');
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/systems/coc7.json'), 'utf8'));
  const files = fs.readdirSync(folder).filter((f) => /\.pdf$/i.test(f));
  if (!files.length) { console.log(`No PDFs in ${folder}.`); return; }
  let failed = false;
  for (const file of files) {
    const bytes = new Uint8Array(fs.readFileSync(path.join(folder, file)));
    let form;
    try { form = await readForm(await readPdf(bytes)); } catch (err) { console.log(`✖ ${file}: ${err.message}`); failed = true; continue; }
    const names = new Set(form.fields.map((f) => f.name));
    const hit = ['dnd2024', 'vtm5', 'coc7'].map((system) => [system, recognize(system, form)]).find(([, t]) => t);
    if (!hit) {
      const best = TEMPLATES.map((t) => [t, Object.keys(t.fields).filter((n) => names.has(n)).length / Object.keys(t.fields).length]).sort((a, b) => b[1] - a[1])[0];
      console.log(`· ${file}: ${form.fields.length} fields, not a built-in sheet (closest: ${best[0].label}, ${(best[1] * 100).toFixed(0)}% of its fields). Name matching and the review screen apply.`);
      continue;
    }
    const [system, template] = hit;
    const missing = Object.keys(template.fields).filter((n) => !names.has(n));
    const sample = SAMPLES[system];
    const data = system === 'coc7' ? withSkillBases(sample.data, catalog) : sample.data;
    const plan = planFill(system, data, sample.name, form);
    const doc = await readPdf(bytes);
    const { bytes: filled } = await fillForm(doc, await readForm(doc), plan.fill);
    const after = Object.fromEntries((await readForm(await readPdf(filled))).fields.map((f) => [f.name, f]));
    const lost = Object.entries(plan.fill).filter(([name, v]) => {
      const f = after[name];
      if (!f) return true;
      if (typeof v === 'boolean') return f.type === 'pushbutton' ? false : (f.value !== 'Off' && f.value !== '') !== v;
      return f.value !== v;
    });
    const ok = !missing.length && !lost.length;
    if (!ok) failed = true;
    console.log(`${ok ? '✔' : '✖'} ${file}: ${template.label}; ${Object.keys(template.fields).length - missing.length} of ${Object.keys(template.fields).length} mapped fields present; ${Object.keys(plan.fill).length} values written, ${lost.length} not read back.`);
    if (missing.length) console.log(`   missing: ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ' …' : ''}`);
    if (lost.length) console.log(`   not read back: ${lost.slice(0, 20).map(([n]) => n).join(', ')}`);
    if (outDir) { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, file.replace(/\.pdf$/i, '.filled.pdf')), filled); }
  }
  process.exitCode = failed ? 1 : 0;
})().catch((err) => { console.error(err); process.exit(2); });
