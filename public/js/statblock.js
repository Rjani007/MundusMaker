// Statblock helpers: system-agnostic monster/NPC block in the classic style.
// Stored on a block as  { kind: 'statblock', stat: {...}, secret }.

import { esc } from './util.js';
import { linkDice } from './render.js';

/** Escape + make dice and "+N to hit" clickable. */
function rollable(s) {
  let html = linkDice(esc(s));
  html = html.replace(/([+-]\d{1,2}) to hit/g, (m, bonus) =>
    `<a class="dice" href="#" data-dice="1d20${bonus}" title="Roll attack">${m}</a>`);
  return html;
}

export const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

export function defaultStat(name = '') {
  return {
    name,                                  // empty → falls back to the entry name
    meta: 'Medium humanoid, any alignment',
    ac: '12 (leather armor)',
    hp: '11 (2d8 + 2)',
    speed: '30 ft.',
    str: 10, dex: 12, con: 12, int: 10, wis: 11, cha: 10,
    vitals: [                              // free-form label/value lines
      { k: 'Skills', v: 'Perception +2' },
      { k: 'Senses', v: 'passive Perception 12' },
      { k: 'Languages', v: 'Common' },
      { k: 'Challenge', v: '1/4 (50 XP)' },
    ],
    traits: [],                            // { name, text }
    actions: [
      { name: 'Club', text: 'Melee Weapon Attack: +2 to hit, reach 5 ft., one target. Hit: 3 (1d6) bludgeoning damage.' },
    ],
  };
}

export function abilityMod(score) {
  const m = Math.floor((Number(score) || 10) / 2) - 5;
  return (m >= 0 ? '+' : '') + m;
}

export function statblockHtml(stat, fallbackName) {
  const s = stat || defaultStat();
  const rows = (list, italicName) => (list || [])
    .filter((t) => t.name || t.text)
    .map((t) => `<p class="sb-entry"><span class="${italicName ? 'sb-tname' : 'sb-aname'}">${esc(t.name)}${t.name ? '.' : ''}</span> ${rollable(t.text)}</p>`)
    .join('');
  const vitals = (s.vitals || [])
    .filter((v) => v.k || v.v)
    .map((v) => `<div class="sb-line"><b>${esc(v.k)}</b> ${esc(v.v)}</div>`)
    .join('');
  return `
  <div class="statblock">
    <div class="sb-name">${esc(s.name || fallbackName || 'Unnamed')}</div>
    <div class="sb-meta">${esc(s.meta)}</div>
    <div class="sb-rule"></div>
    <div class="sb-line"><b>Armor Class</b> ${esc(s.ac)}</div>
    <div class="sb-line"><b>Hit Points</b> ${rollable(s.hp)}</div>
    <div class="sb-line"><b>Speed</b> ${esc(s.speed)}</div>
    <div class="sb-rule"></div>
    <div class="sb-abilities">
      ${ABILITIES.map((a) => `<div class="sb-ab"><div class="sb-ab-k">${a.toUpperCase()}</div><div>${esc(s[a])} (${abilityMod(s[a])})</div></div>`).join('')}
    </div>
    <div class="sb-rule"></div>
    ${vitals}
    ${(s.traits || []).length ? `<div class="sb-rule"></div>${rows(s.traits, true)}` : ''}
    ${(s.actions || []).length ? `<div class="sb-section">Actions</div>${rows(s.actions, false)}` : ''}
  </div>`;
}
