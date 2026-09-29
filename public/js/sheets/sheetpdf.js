// Original, ink-friendly system layouts. All user text passes through the
// caller's PDF sanitizer; every continuation repeats its secrecy banner.
import { ABILITIES, ABILITY_NAMES, SKILLS, mod, fmtMod, profBonus, passivePerception, skillBonus } from './dndrules.js';

export function writeSystemSheet(doc, system, data, { name, gm = false, secret = false, safe, firstPage = false, footer = true }) {
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
  const M = 32, CW = W - M * 2, gap = 12, ink = [34, 37, 44], gray = [111, 117, 126];
  const d = data || {}, continuations = [];
  let usedFirst = false;
  const label = ({ dnd2024: 'D&D 2024', vtm5: 'VAMPIRE: THE MASQUERADE V5', coc7: 'CALL OF CTHULHU 7TH EDITION' })[system] || system;
  function text(value, x, y, size = 9, bold = false, color = ink, options = {}) {
    doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(size); doc.setTextColor(...color);
    doc.text(Array.isArray(value) ? value.map(safe) : safe(value), x, y, options);
  }
  function lines(value, width, size = 9, bold = false) {
    doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(size);
    return doc.splitTextToSize(safe(value), width);
  }
  function page(title) {
    if (!(firstPage && !usedFirst)) doc.addPage(); usedFirst = true;
    doc.setDrawColor(55, 60, 69); doc.setLineWidth(0.7);
    text(label, M, 24, 8, true, gray);
    text(secret ? 'GM SECRET' : gm ? 'GM EDITION' : 'PLAYER COPY', W - M, 24, 8, true, secret ? [138, 60, 120] : gray, { align: 'right' });
    let fontSize = 21;
    while (lines(name || 'Unnamed character', CW, fontSize, true).length > 2 && fontSize > 11) fontSize--;
    const printed = lines(name || 'Unnamed character', CW, fontSize, true);
    text(printed.slice(0, 2), M, 51, fontSize, true);
    if (printed.length > 2 && !continuations.some(c => c.title === 'Full character name')) continuations.push({ title: 'Full character name', text: name });
    const titleLines = lines(title, CW, 9);
    text(titleLines.slice(0, 2), M, 87, 9, false, gray);
    if (titleLines.length > 2 && !continuations.some(c => c.title === 'Full identity')) continuations.push({ title: 'Full identity', text: title });
    doc.line(M, 103, W - M, 103);
    if (footer) text('MundusMaker · character sheet', M, H - 18, 7, false, gray);
  }
  function frame(title, x, y, w, h) {
    doc.setDrawColor(110, 117, 128); doc.setLineWidth(0.55); doc.roundedRect(x, y, w, h, 4, 4, 'S');
    doc.setFillColor(244, 245, 247); doc.rect(x + 1, y + 1, w - 2, 20, 'F');
    text(title.toUpperCase(), x + 8, y + 14, 7.5, true, gray);
  }
  function box(title, value, x, y, w, h, size = 10) {
    frame(title, x, y, w, h);
    const split = lines(value || ' ', w - 16, size);
    const capacity = Math.max(1, Math.floor((h - 31) / (size * 1.2)));
    if (split.length > capacity) {
      text(split.slice(0, Math.max(0, capacity - 1)), x + 8, y + 35, size);
      text('See continued details.', x + 8, y + h - 9, 7, false, gray);
      continuations.push({ title, text: String(value) });
    } else text(split, x + 8, y + 35, size);
  }
  function metric(title, value, x, y, w, h = 58) {
    frame(title, x, y, w, h);
    const s = lines(String(value ?? '—'), w - 12, 20, true).length > 1 ? 12 : 20;
    text(String(value ?? '—'), x + w / 2, y + 44, s, true, ink, { align: 'center' });
  }
  function dots(x, y, value, max = 5, squares = false) {
    const n = Math.min(20, Math.max(0, Number(max) || 0));
    for (let i = 0; i < n; i++) {
      doc.setFillColor(...ink); doc.setDrawColor(...gray);
      if (squares) doc.rect(x + i * 10, y - 5, 6, 6, i < value ? 'F' : 'S');
      else doc.circle(x + i * 9, y - 2, 2.5, i < value ? 'F' : 'S');
    }
  }
  function damageTrack(x, y, max, track = {}) {
    for (let i = 0; i < Math.min(15, max); i++) {
      const xx = x + i * 10; doc.setDrawColor(...gray); doc.rect(xx, y, 7, 7, 'S');
      if (i < (track.aggravated || 0) + (track.superficial || 0)) doc.line(xx, y + 7, xx + 7, y);
      if (i < (track.aggravated || 0)) doc.line(xx, y, xx + 7, y + 7);
    }
  }
  function details(title, entries) {
    const rows = entries.filter(e => e.text != null && String(e.text).trim());
    if (!rows.length) return;
    page(title); let y = 125;
    for (const entry of rows) {
      const titleLines = lines(entry.title || '', CW, 10, true);
      if (y + titleLines.length * 13 + 26 > H - 40) { page(`${title} · continued`); y = 125; }
      for (const line of titleLines) {
        if (y > H - 40) { page(`${title} · continued`); y = 125; }
        text(line, M, y, 10, true); y += 13;
      }
      y += 4;
      const bodyLines = lines(String(entry.text), CW, 9);
      for (const line of bodyLines) {
        if (y > H - 40) { page(`${title} · continued`); y = 125; text(lines(`${entry.title} · continued`, CW, 9, true)[0], M, y, 9, true); y += 18; }
        text(line, M, y, 9); y += 12;
      }
      y += 16;
    }
  }

  if (system === 'dnd2024') {
    const abs = d.abilities || {}, pb = profBonus(d.klass?.level), c = d.klass || {}, hp = d.hp || {};
    const identity = [d.species?.name, `${c.name || 'Class'} ${c.level || 1}`, c.subclass, d.background?.name && `${d.background.name} background`, d.alignment].filter(Boolean).join(' · ');
    page(identity);
    const aw = (CW - 5 * 8) / 6;
    ABILITIES.forEach((a, i) => { metric(ABILITY_NAMES[a], fmtMod(mod(abs[a])), M + i * (aw + 8), 116, aw, 69); text(`SCORE ${abs[a] ?? 10}`, M + i * (aw + 8) + aw / 2, 175, 8, false, gray, { align: 'center' }); });
    const leftW = 165, x2 = M + leftW + gap, rightW = CW - leftW - gap;
    frame('Saving throws', M, 197, leftW, 126);
    ABILITIES.forEach((a, i) => { const proficient = d.saves?.includes(a); dots(M + 11, 232 + i * 15, proficient ? 1 : 0, 1); text(ABILITY_NAMES[a], M + 22, 232 + i * 15, 9); text(fmtMod(mod(abs[a]) + (proficient ? pb : 0)), M + leftW - 10, 232 + i * 15, 9, true, ink, { align: 'right' }); });
    frame('Skills', M, 335, leftW, 310);
    SKILLS.forEach(([name, a], i) => {
      const s = d.skills?.find(s => s.key === name), factor = s ? s.prof === 'expert' ? 2 : 1 : 0;
      dots(M + 11, 369 + i * 15, factor ? 1 : 0, 1); if (factor === 2) doc.circle(M + 11, 367 + i * 15, 4, 'S');
      text(name, M + 21, 369 + i * 15, 8.5);
      text(fmtMod(skillBonus(d, name, pb)), M + leftW - 10, 369 + i * 15, 9, true, ink, { align: 'right' });
    });
    metric('Passive perception', passivePerception({ ...d, abilities: abs }, pb), M, 657, leftW, 56);
    const mw = (rightW - 16) / 3;
    [['Armor class', d.ac ?? 10], ['Initiative', fmtMod(mod(abs.dex) + (d.initiativeBonus || 0))], ['Speed', `${d.speed ?? 30} ft.`]].forEach(([k, v], i) => metric(k, v, x2 + i * (mw + 8), 197, mw));
    const half = (rightW - 10) / 2;
    box('Hit points', `Current ${hp.current ?? 0} / Max ${hp.max ?? 0}\nTemporary ${hp.temp || 0}`, x2, 267, half, 92, 12);
    frame('Hit dice & death saves', x2 + half + 10, 267, half, 92);
    text(`${c.level || 1}d${c.hitDie || 8} · ${d.hitDice?.spent || 0} spent`, x2 + half + 18, 302, 10, true);
    text('Successes', x2 + half + 18, 323, 8); dots(x2 + rightW - 35, 323, d.deathSaves?.success || 0, 3);
    text('Failures', x2 + half + 18, 344, 8); dots(x2 + rightW - 35, 344, d.deathSaves?.failure || 0, 3);
    frame('Weapons & attacks', x2, 371, rightW, 150);
    text('ATTACK', x2 + 8, 407, 7, true, gray); text('HIT', x2 + rightW * .48, 407, 7, true, gray); text('DAMAGE / TYPE', x2 + rightW * .62, 407, 7, true, gray);
    const attacks = d.attacks || [];
    for (const [i, a] of attacks.slice(0, 5).entries()) {
      const y = 427 + i * 18;
      const n = lines(a.name, rightW * .43, 8.5); text(n[0] || '', x2 + 8, y, 8.5);
      text(fmtMod(a.bonus || 0), x2 + rightW * .48, y, 9, true);
      const damage = lines(a.damage || '', rightW * .36, 8.5); text(damage[0] || '', x2 + rightW * .62, y, 8.5);
      if (n.length > 1 || damage.length > 1) continuations.push({ title: a.name, text: `${fmtMod(a.bonus || 0)} to hit; ${a.damage || ''}. ${a.notes || ''}` });
    }
    if (attacks.length > 5) continuations.push({ title: 'All attacks', text: attacks.map(a => `${a.name}: ${fmtMod(a.bonus || 0)} to hit, ${a.damage || ''}; ${a.notes || ''}`).join('\n') });
    box('Features & traits · descriptions follow', (d.features || []).map(f => f.name).join('\n') || ' ', x2, 533, rightW, 180, 9);
    const bottomH = H - 38 - 725;
    if (bottomH >= 44) box('Proficiencies & languages', `Proficiency bonus ${fmtMod(pb)} · ${d.languages?.join(', ') || 'Languages not recorded'}\n${[...(d.proficiencies?.armor || []), ...(d.proficiencies?.weapons || []), ...(d.proficiencies?.tools || [])].join(', ')}`, M, 725, CW, bottomH, 8.5);
    else continuations.push({ title: 'Proficiencies & languages', text: [d.languages?.join(', '), JSON.stringify(d.proficiencies || {})].filter(Boolean).join('\n') });
    details('Equipment, personality & features', [
      { title: 'Identity', text: identity },
      { title: 'Equipment & treasure', text: (d.equipment || []).map(e => `${e.qty || 1} × ${e.name}`).join('\n') + `\n\nCoins: ${d.coins?.gp || 0} gp · ${d.coins?.sp || 0} sp · ${d.coins?.cp || 0} cp` },
      { title: 'Weapons & attack notes', text: attacks.map(a => `${a.name}: ${fmtMod(a.bonus || 0)} to hit; ${a.damage || ''}${a.notes ? `\n${a.notes}` : ''}`).join('\n\n') },
      ...Object.entries(d.personality || {}).map(([title, text]) => ({ title: title[0].toUpperCase() + title.slice(1), text })),
      ...(d.features || []).map(f => ({ title: [f.name, f.source].filter(Boolean).join(' · '), text: f.text || 'Recorded on character sheet.' })),
      { title: 'Notes & backstory', text: d.notes },
      { title: 'Rules attribution', text: 'Includes material from the System Reference Document 5.2 by Wizards of the Coast LLC (https://www.dndbeyond.com/srd), licensed under Creative Commons Attribution 4.0 International (https://creativecommons.org/licenses/by/4.0/). Original sheet layout by MundusMaker.' },
    ]);
    if (d.spellcasting || d.innateSpells?.length) {
      const sc = d.spellcasting || {}, allSpells = uniqueSpells(d);
      const spellPage = () => {
        page('Spellcasting');
        const ww = (CW - 3 * 10) / 4;
        [['Ability', (sc.ability || '').toUpperCase() || 'See innate'], ['Save DC', sc.dc ?? '—'], ['Spell attack', sc.attackBonus == null ? '—' : fmtMod(sc.attackBonus)], ['Caster level', c.level || 1]].forEach(([k, v], i) => metric(k, v, M + (ww + 10) * i, 119, ww));
        const slots = Object.entries(sc.slots || {}).filter(([, s]) => s.max > 0);
        box('Spell slots · used / maximum', slots.map(([l, s]) => `Level ${l}: ${s.used || 0} / ${s.max}`).join('     ') || 'No class spell slots', M, 189, CW, 61, 9);
        text('SPELL / SOURCE', M, 272, 8, true, gray); text('LEVEL', M + 246, 272, 8, true, gray); text('CAST / RANGE', M + 304, 272, 8, true, gray);
        doc.line(M, 280, W - M, 280);
      };
      spellPage(); let y = 299;
      for (const s of allSpells) {
        const names = lines(s.name, 232, 9, true), meta = lines([s.castingTime, s.range].filter(Boolean).join(' · '), CW - 306, 8);
        const h = Math.max(names.length * 12, meta.length * 11) + 28;
        if (y + h > H - 40) { spellPage(); y = 299; }
        text(names, M, y, 9, true); text(s.level === 0 ? 'Cantrip' : s.level ?? '—', M + 246, y, 9); text(meta, M + 304, y, 8);
        text(lines(s.sheetSource, CW - 10, 7).slice(0, 2), M, y + Math.max(names.length * 12, meta.length * 11) + 2, 7, false, gray);
        y += h; doc.setDrawColor(220, 222, 225); doc.line(M, y - 10, W - M, y - 10);
      }
      details('Spell reference', allSpells.map(s => ({ title: s.name, text: [s.sheetSource, [s.castingTime, s.range, s.components, s.duration, s.concentration ? 'Concentration' : '', s.ritual ? 'Ritual' : ''].filter(Boolean).join(' · '), s.text, s.higherLevel].filter(Boolean).join('\n\n') })));
    }
  } else if (system === 'vtm5') {
    page([d.clan || 'Clanless', `Generation ${d.generation || 13}`, d.predatorType, d.sire && `Sire: ${d.sire}`].filter(Boolean).join(' · '));
    const attrs = [['Physical', ['strength', 'dexterity', 'stamina']], ['Social', ['charisma', 'manipulation', 'composure']], ['Mental', ['intelligence', 'wits', 'resolve']]];
    const skills = [['Athletics', 'Brawl', 'Craft', 'Drive', 'Firearms', 'Larceny', 'Melee', 'Stealth', 'Survival'], ['Animal Ken', 'Etiquette', 'Insight', 'Intimidation', 'Leadership', 'Performance', 'Persuasion', 'Streetwise', 'Subterfuge'], ['Academics', 'Awareness', 'Finance', 'Investigation', 'Medicine', 'Occult', 'Politics', 'Science', 'Technology']];
    const col = (CW - 2 * gap) / 3;
    attrs.forEach(([group, names], i) => {
      const x = M + i * (col + gap); frame(`${group} attributes`, x, 120, col, 113);
      names.forEach((a, j) => { text(cap(a), x + 8, 156 + j * 26, 9); dots(x + col - 49, 156 + j * 26, d.attributes?.[a] || 1); });
      frame(`${group} skills`, x, 246, col, 231);
      skills[i].forEach((s, j) => { text(s, x + 8, 280 + j * 23, 8.5); dots(x + col - 49, 280 + j * 23, d.skills?.[s] || 0); });
    });
    const health = Number(d.attributes?.stamina ?? 1) + 3, wp = Number(d.attributes?.composure ?? 1) + Number(d.attributes?.resolve ?? 1);
    box('Health', `Maximum ${health}\nSuperficial ${d.health?.superficial || 0} · Aggravated ${d.health?.aggravated || 0}`, M, 490, col, 90, 9);
    box('Willpower', `Maximum ${wp}\nSuperficial ${d.willpower?.superficial || 0} · Aggravated ${d.willpower?.aggravated || 0}`, M + col + gap, 490, col, 90, 9);
    damageTrack(M + 8, 564, health, d.health); damageTrack(M + col + gap + 8, 564, wp, d.willpower);
    frame('Hunger / Humanity', M + (col + gap) * 2, 490, col, 90);
    text('Hunger', M + (col + gap) * 2 + 8, 525, 8); dots(W - M - 49, 525, d.hunger || 0);
    text(`Humanity ${d.humanity ?? 7} · Potency ${d.bloodPotency ?? 1}`, M + (col + gap) * 2 + 8, 552, 8);
    box('Disciplines', (d.disciplines || []).map(x => `${x.name} ${x.rating}`).join('\n'), M, 592, col, 150, 9);
    box('Ambition & desire', [d.ambition, d.desire].filter(Boolean).join('\n\n'), M + col + gap, 592, col * 2 + gap, 150, 10);
    details('Disciplines, advantages & convictions', [
      ...(d.disciplines || []).map(x => ({ title: `${x.name} ${x.rating}`, text: (x.powers || []).map(p => `${p.name} (L${p.level})\n${p.desc || ''}`).join('\n\n') })),
      { title: 'Specialties', text: (d.specialties || []).map(s => `${s.skill}: ${s.name}`).join('\n') },
      { title: 'Advantages & flaws', text: (d.advantages || []).map(a => `${a.flaw ? 'Flaw: ' : ''}${a.name} ${a.dots}${a.desc ? `\n${a.desc}` : ''}`).join('\n') },
      { title: 'Convictions & touchstones', text: (d.convictions || []).map((c, i) => `${c}\n${d.touchstones?.[i]?.name || ''}`).join('\n\n') },
      ...(d.touchstones || []).map(t => ({ title: `Touchstone · ${t.name}`, text: [t.conviction, t.desc].filter(Boolean).join('\n') })),
      { title: 'Experience', text: `${d.xp?.total || 0} earned / ${d.xp?.spent || 0} spent` }, { title: 'Notes', text: d.notes },
    ]);
  } else if (system === 'coc7') {
    page([d.occupation?.name, d.era, `Age ${d.age || 30}`].filter(Boolean).join(' · '));
    const chars = Object.entries(d.characteristics || {}), col = (CW - 3 * gap) / 4;
    chars.forEach(([a, v], i) => { const x = M + i % 4 * (col + gap), y = 119 + Math.floor(i / 4) * 76; metric(a, v, x, y, col, 65); text(`Half ${Math.floor(v / 2)} · Fifth ${Math.floor(v / 5)}`, x + col / 2, y + 57, 7, false, gray, { align: 'center' }); });
    [['Hit points', `${d.hp?.current ?? 0}/${d.hp?.max ?? 0}`], ['Magic points', `${d.mp?.current ?? 0}/${d.mp?.max ?? 0}`], ['Sanity', `${d.san?.current ?? 0}/${d.san?.max ?? 99}`], ['Luck', d.luck ?? 0]].forEach(([k, v], i) => metric(k, v, M + i * (col + gap), 280, col));
    box('Combat', `Damage bonus ${d.damageBonus || '0'} · Build ${d.build || 0} · Move ${d.move || 8} · Dodge ${d.dodge || 0}%`, M, 350, CW, 57, 10);
    const skills = (d.skills || []).slice().sort((a, b) => a.name.localeCompare(b.name));
    const half = (CW - gap) / 2;
    let top = 420, y = top + 36, column = 0;
    const skillFrame = () => frame('Skills · regular / half / fifth · * marked for development', M, top, CW, H - 44 - top);
    skillFrame();
    for (const s of skills) {
      const wrapped = lines(`${s.improve ? '* ' : ''}${s.name}`, half - 100, 8);
      const height = Math.max(17, wrapped.length * 10 + 5);
      if (y + height > H - 52) {
        column++;
        if (column === 2) { page('Investigator skills · continued'); top = 119; column = 0; skillFrame(); }
        y = top + 36;
      }
      const x = M + column * (half + gap);
      text(wrapped, x + 8, y, 8);
      text(`${s.value} / ${Math.floor(s.value / 2)} / ${Math.floor(s.value / 5)}`, x + half - 8, y, 8, true, ink, { align: 'right' });
      y += height;
    }
    details('Skills, weapons & investigator background', [
      { title: 'Weapons', text: (d.weapons || []).map(w => `${w.name} · ${w.skill}% · ${w.damage} · ${w.range || ''}${w.ammo ? ` · Ammo ${w.ammo}` : ''}${w.malf ? ` · Malfunction ${w.malf}` : ''}`).join('\n') },
      { title: 'Gear', text: (d.gear || []).map(g => g.name || g).join('\n') },
      { title: 'Cash & assets', text: [d.cash, d.spendingLevel].filter(Boolean).join('\n') },
      ...Object.entries(d.backstory || {}).map(([title, text]) => ({ title: title.replace(/([A-Z])/g, ' $1'), text })), { title: 'Notes', text: d.notes },
    ]);
  }
  if (continuations.length) details('Continued details', [...continuations]);
}

const cap = s => s[0].toUpperCase() + s.slice(1);
function uniqueSpells(d) {
  const sc = d.spellcasting || {}, found = new Map();
  for (const [list, label] of [[sc.cantrips, 'Class cantrip'], [sc.prepared, 'Prepared'], [sc.alwaysPrepared, 'Always prepared · class / subclass'], [sc.spellbook, 'Spellbook']]) {
    for (const name of list || []) {
      const old = found.get(name), detail = d.spellDetails?.find(s => s.name === name) || {};
      found.set(name, { ...detail, name, sheetSource: [old?.sheetSource, label].filter(Boolean).join(' · ') });
    }
  }
  for (const s of d.innateSpells || []) {
    const old = found.get(s.name), detail = d.spellDetails?.find(x => x.name === s.name) || {};
    const casting = s.ability ? `${s.ability.toUpperCase()} · DC ${8 + profBonus(d.klass?.level) + mod(d.abilities?.[s.ability])} · attack ${fmtMod(profBonus(d.klass?.level) + mod(d.abilities?.[s.ability]))}` : '';
    found.set(s.name, { ...detail, ...s, sheetSource: [old?.sheetSource, `${s.source || 'Innate spell'} · ${casting}${s.uses ? ` · ${s.uses}/Long Rest` : ''}`].filter(Boolean).join(' · ') });
  }
  return [...found.values()].sort((a, b) => (a.level ?? 99) - (b.level ?? 99) || a.name.localeCompare(b.name));
}
