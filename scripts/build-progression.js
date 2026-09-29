// Development-time only. Keep only SRD 5.2 classes and their advancement math.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const names = ['barbarian', 'bard', 'cleric', 'druid', 'fighter', 'monk', 'paladin', 'ranger', 'rogue', 'sorcerer', 'warlock', 'wizard'];
function get(url) {
  return new Promise((resolve, reject) => https.get(url, res => {
    if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
    let text = ''; res.on('data', c => { text += c; });
    res.on('end', () => { try { resolve(JSON.parse(text)); } catch (e) { reject(e); } });
    res.on('error', reject);
  }).on('error', reject));
}
const keep = ['name', 'source', 'cantripProgression', 'preparedSpellsProgression', 'spellsKnownProgression',
  'casterProgression', 'classTableGroups', 'startingProficiencies', 'primaryAbility'];
async function main() {
  const classes = await Promise.all(names.map(async name => {
    const json = await get(`https://raw.githubusercontent.com/5etools-mirror-3/5etools-src/main/data/class/class-${name}.json`);
    const cls = json.class.find(c => c.srd52 && c.name.toLowerCase() === name);
    if (!cls) throw new Error(`Missing SRD 5.2 class: ${name}`);
    return { ...Object.fromEntries(keep.filter(k => cls[k] !== undefined).map(k => [k, cls[k]])),
      subclassRules: (json.subclass || []).filter(s => s.srd52).map(s => ({ name: typeof s.srd52 === 'string' ? s.srd52 : s.name, additionalSpells: s.additionalSpells })) };
  }));
  if (classes.length !== 12 || new Set(classes.map(c => c.name)).size !== 12) throw new Error('SRD class count changed');
  const _meta = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/srd52/classes.json'), 'utf8'))._meta;
  const rawFeats = await get('https://raw.githubusercontent.com/5etools-mirror-3/5etools-src/main/data/feats.json');
  const feats = rawFeats.feat.filter(f => f.srd52 && !f._copy).map(f => ({ name: typeof f.srd52 === 'string' ? f.srd52 : f.name,
    ability: f.ability, prerequisite: f.prerequisite, repeatable: f.repeatable }));
  const bundledFeats = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/srd52/feats.json'), 'utf8')).feats;
  if (feats.length !== bundledFeats.length || bundledFeats.some(f => !feats.some(p => p.name === f.name))) throw new Error('SRD feat metadata does not match the bundled feats');
  fs.writeFileSync(path.join(__dirname, '../public/srd52/progression.json'), JSON.stringify({ _meta, classes, feats }, null, 2) + '\n');
  console.log(`Wrote advancement math for ${classes.length} SRD 5.2 classes.`);
}
main().catch(err => { console.error(err); process.exitCode = 1; });
