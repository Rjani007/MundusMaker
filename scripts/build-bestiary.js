// Builds the bundled starter bestiary: downloads the 5etools Monster Manual
// data and keeps ONLY the SRD 5.1 subset (~300 monsters), which Wizards of the
// Coast releases under Creative Commons CC-BY-4.0 and is therefore legal to
// redistribute with attribution. The full book is NOT — do not remove the
// SRD filter.
//
//   node scripts/build-bestiary.js   → public/bestiary/srd-bestiary.json
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const SOURCE = 'https://raw.githubusercontent.com/5etools-mirror-3/5etools-src/main/data/bestiary/bestiary-mm.json';
const OUT = path.join(__dirname, '..', 'public', 'bestiary', 'srd-bestiary.json');

// fields our importer understands — everything else is dead weight
const KEEP = [
  'name', 'size', 'type', 'alignment', 'ac', 'hp', 'speed',
  'str', 'dex', 'con', 'int', 'wis', 'cha',
  'save', 'skill', 'senses', 'passive', 'languages', 'cr',
  'vulnerable', 'resist', 'immune', 'conditionImmune',
  'trait', 'action', 'bonus', 'reaction', 'legendary', 'spellcasting',
];

function fetchJson(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchJson(new URL(res.headers.location, url).href, redirects + 1));
      }
      if (res.statusCode !== 200) return reject(new Error(`${res.statusCode} for ${url}`));
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
      res.on('error', reject);
    }).on('error', reject);
  });
}

(async () => {
  console.log('downloading', SOURCE);
  const data = await fetchJson(SOURCE);
  const all = data.monster || [];

  const srd = all
    .filter((m) => m.srd && !m._copy) // SRD-licensed, self-contained entries only
    .map((m) => {
      const out = {};
      for (const k of KEEP) if (m[k] !== undefined) out[k] = m[k];
      // some monsters appear in the SRD under a different name
      if (typeof m.srd === 'string') out.name = m.srd;
      out.source = 'SRD 5.1';
      return out;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  if (srd.length < 200) throw new Error(`only ${srd.length} SRD monsters found — source format changed?`);

  const bundle = {
    _meta: {
      note: 'Systems Reference Document 5.1 monsters, converted from 5etools data. Stat blocks only.',
      license: 'This work includes material taken from the System Reference Document 5.1 ("SRD 5.1") by Wizards of the Coast LLC, available at https://dnd.wizards.com/resources/systems-reference-document. The SRD 5.1 is licensed under the Creative Commons Attribution 4.0 International License (https://creativecommons.org/licenses/by/4.0/legalcode).',
      count: srd.length,
    },
    monster: srd,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(bundle));
  const mb = (fs.statSync(OUT).size / 1024 / 1024).toFixed(2);
  console.log(`✓ ${OUT} — ${srd.length} SRD monsters, ${mb} MB (from ${all.length} in the source book)`);
})().catch((err) => {
  console.error('build-bestiary failed:', err.message);
  process.exit(1);
});
