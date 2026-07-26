// Encounter budgeting (D&D 5e DMG rules): CR → XP, party thresholds by level,
// and the monster-count multiplier. Stored on a block as
//   { kind: 'encounter', enc: { partySize, partyLevel, rows: [{to?, name?, cr?, count}] } }

export const CR_XP = {
  '0': 10, '1/8': 25, '1/4': 50, '1/2': 100,
  '1': 200, '2': 450, '3': 700, '4': 1100, '5': 1800, '6': 2300, '7': 2900,
  '8': 3900, '9': 5000, '10': 5900, '11': 7200, '12': 8400, '13': 10000,
  '14': 11500, '15': 13000, '16': 15000, '17': 18000, '18': 20000, '19': 22000,
  '20': 25000, '21': 33000, '22': 41000, '23': 50000, '24': 62000, '25': 75000,
  '26': 90000, '27': 105000, '28': 120000, '29': 135000, '30': 155000,
};

// per-character XP thresholds by level: [easy, medium, hard, deadly]
const THRESHOLDS = [
  [25, 50, 75, 100], [50, 100, 150, 200], [75, 150, 225, 400], [125, 250, 375, 500],
  [250, 500, 750, 1100], [300, 600, 900, 1400], [350, 750, 1100, 1700], [450, 900, 1400, 2100],
  [550, 1100, 1600, 2400], [600, 1200, 1900, 2800], [800, 1600, 2400, 3600], [1000, 2000, 3000, 4500],
  [1100, 2200, 3400, 5100], [1250, 2500, 3800, 5700], [1400, 2800, 4300, 6400], [1600, 3200, 4800, 7200],
  [2000, 3900, 5900, 8800], [2100, 4200, 6300, 9500], [2400, 4900, 7300, 10900], [2800, 5700, 8500, 12700],
];

export function defaultEncounter() {
  return { partySize: 4, partyLevel: 3, rows: [] };
}

function countMultiplier(n) {
  if (n <= 1) return 1;
  if (n === 2) return 1.5;
  if (n <= 6) return 2;
  if (n <= 10) return 2.5;
  if (n <= 14) return 3;
  return 4;
}

/** Pull a CR string ("1/4", "3") out of a statblock's Challenge line. */
export function crFromStat(stat) {
  const line = (stat?.vitals || []).find((v) => /challenge|^cr$/i.test(v.k || ''));
  if (!line?.v) return null;
  const m = String(line.v).trim().match(/^(\d+\/\d+|\d+)/);
  return m ? m[1] : null;
}

export function xpForCr(cr) {
  return CR_XP[String(cr ?? '').trim()] ?? 0;
}

/**
 * Compute totals + difficulty. `resolveEntity(id)` returns an entity or null,
 * so imported monsters, hand-built NPCs, and manual rows all work.
 */
export function computeEncounter(enc, resolveEntity) {
  const rows = (enc.rows || []).map((row) => {
    const ent = row.to ? resolveEntity(row.to) : null;
    const stat = ent?.blocks?.find((b) => b.kind === 'statblock')?.stat;
    const cr = row.cr || crFromStat(stat) || '0';
    const count = Math.max(1, Number(row.count) || 1);
    return {
      ...row,
      count,
      entity: ent,
      displayName: ent?.name || row.name || '—',
      cr,
      xpEach: xpForCr(cr),
    };
  });
  const totalCount = rows.reduce((s, r) => s + r.count, 0);
  const totalXp = rows.reduce((s, r) => s + r.xpEach * r.count, 0);
  const multiplier = countMultiplier(totalCount);
  const adjustedXp = Math.round(totalXp * multiplier);

  const size = Math.max(1, Number(enc.partySize) || 4);
  const level = Math.min(20, Math.max(1, Number(enc.partyLevel) || 1));
  const t = THRESHOLDS[level - 1];
  const party = { easy: t[0] * size, medium: t[1] * size, hard: t[2] * size, deadly: t[3] * size };

  let difficulty = 'Trivial';
  if (adjustedXp >= party.deadly * 1.5) difficulty = 'Beyond deadly';
  else if (adjustedXp >= party.deadly) difficulty = 'Deadly';
  else if (adjustedXp >= party.hard) difficulty = 'Hard';
  else if (adjustedXp >= party.medium) difficulty = 'Medium';
  else if (adjustedXp >= party.easy) difficulty = 'Easy';

  return { rows, totalCount, totalXp, multiplier, adjustedXp, party, difficulty };
}

export const DIFFICULTY_COLORS = {
  'Trivial': '#8a8f98', 'Easy': '#5db87e', 'Medium': '#d4a72c',
  'Hard': '#e0724a', 'Deadly': '#d4626a', 'Beyond deadly': '#b048c8',
};
