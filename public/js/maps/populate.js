// Populate a settlement (1.9): drafts of people and places for a town's
// districts, previewed before anything is created. Suggestions come from the
// original, system-neutral tables below and names.js, each role on its own
// ':populate' stream, so a role's suggestion never depends on which others
// were taken. Populate never reads or advances a generator stream and never
// writes the map model. Filled roles are remembered in `map.populated`
// (role key -> entity id), so running it again offers only the rest.

import { makeRng } from '../util.js';
import { nameFor } from '../names.js';

const family = (rng) => nameFor(rng, 'person').split(' ').slice(1).join(' ');
const possessive = (name) => (name.endsWith('s') ? `${name}'` : `${name}'s`);
const person = (rng) => nameFor(rng, 'person');

/** Per era, per district use: [role, title, entry kind, name(rng), one-line draft]. */
const ROLE_TABLES = {
  fantasy: {
    market: [
      ['merchant', 'Merchant', 'npc', person, 'Sells goods from far up the road and knows what everything is worth.'],
      ['tavern', 'Tavern', 'place', (r) => nameFor(r, 'tavern'), 'A loud common room where news arrives before the couriers do.'],
      ['moneylender', 'Moneylender', 'npc', person, 'Lends coin to anyone, and remembers every debt.'],
    ],
    craft: [
      ['smith', 'Smith', 'npc', person, 'Works the forge from dawn and takes commissions with a long wait.'],
      ['workshop', 'Workshop', 'place', (r) => `${possessive(family(r))} Workshop`, 'Benches, tools and apprentices. Something is always being built here.'],
      ['guildmaster', 'Guild master', 'npc', person, 'Speaks for the craft guilds, and bargains hard for them.'],
    ],
    residential: [
      ['innkeeper', 'Innkeeper', 'npc', person, 'Runs a clean house and asks few questions of paying guests.'],
      ['inn', 'Inn', 'place', (r) => `${nameFor(r, 'tavern')} Inn`, 'Rooms by the night or the week, and a stable out back.'],
      ['healer', 'Healer', 'npc', person, 'Tends the sick of the ward, paid in coin or in favors.'],
    ],
    garden: [
      ['priest', 'Priest', 'npc', person, 'Keeps the shrine and hears more confessions than anyone knows.'],
      ['shrine', 'Shrine', 'place', (r) => `Shrine of ${nameFor(r, 'root')}`, 'A quiet walled garden around an old altar.'],
      ['herbalist', 'Herbalist', 'npc', person, 'Grows remedies, and poisons, in neat labeled rows.'],
    ],
    harbor: [
      ['harbormaster', 'Harbormaster', 'npc', person, 'Logs every ship in and out, and every bribe offered.'],
      ['fishmarket', 'Fish market', 'place', (r) => `${possessive(family(r))} Fish Market`, 'The catch is sold at dawn. By noon only the gulls remain.'],
      ['smuggler', 'Smuggler', 'npc', person, 'Moves cargo that never reaches the harbormaster’s log.'],
    ],
    citadel: [
      ['captain', 'Captain of the watch', 'npc', person, 'Commands the town watch, stretched thin and short of pay.'],
      ['magistrate', 'Magistrate', 'npc', person, 'Hears disputes and sets fines, and can be persuaded.'],
      ['barracks', 'Barracks', 'place', (r) => `${nameFor(r, 'root')} Barracks`, 'Bunks, a drill yard and a small, damp lockup.'],
    ],
  },
};

const MODERN_GIVEN = ['Alex', 'Beth', 'Carlos', 'Dana', 'Eddie', 'Fran', 'Grace', 'Hector', 'Irene', 'Jamal', 'Kim', 'Luis', 'Maggie', 'Nate', 'Olivia', 'Priya', 'Ray', 'Sam', 'Tessa', 'Vic', 'Wendy', 'Yusuf'];
const MODERN_FAMILY = ['Alvarez', 'Brennan', 'Castillo', 'Doyle', 'Ekwueme', 'Fischer', 'Garza', 'Hollis', 'Iverson', 'Jansen', 'Kowalski', 'Lindqvist', 'Mercer', 'Novak', 'Okafor', 'Pruitt', 'Quinlan', 'Reyes', 'Sato', 'Thorne', 'Vance', 'Whitaker'];
const modernPerson = (r) => `${r.pick(MODERN_GIVEN)} ${r.pick(MODERN_FAMILY)}`;
const modernFamily = (r) => r.pick(MODERN_FAMILY);

ROLE_TABLES.modern = {
  downtown: [
    ['cafe', 'Café owner', 'npc', modernPerson, 'Opens at six, knows every regular’s order and most of their business.'],
    ['bar', 'Bar', 'place', (r) => `${possessive(modernFamily(r))} Tap Room`, 'Dim, loud on weekends, and quiet enough on a Tuesday to talk.'],
    ['lawyer', 'Lawyer', 'npc', modernPerson, 'Handles wills, leases and the occasional client who pays in cash.'],
  ],
  residential: [
    ['landlord', 'Landlord', 'npc', modernPerson, 'Owns half the block and fixes nothing until the tenants organize.'],
    ['store', 'Corner store', 'place', (r) => `${modernFamily(r)} Market`, 'Open late. The owner sees who comes and goes at every hour.'],
    ['neighbor', 'Nosy neighbor', 'npc', modernPerson, 'Watches the street from the porch and keeps notes.'],
  ],
  suburban: [
    ['coach', 'Youth sports coach', 'npc', modernPerson, 'Knows every family in the subdivision through their kids.'],
    ['hoa', 'Homeowners’ association president', 'npc', modernPerson, 'Enforces lawn heights and holds a grudge for years.'],
    ['realtor', 'Realtor', 'npc', modernPerson, 'Knows which houses sold too cheap, and why.'],
  ],
  industrial: [
    ['foreman', 'Shift foreman', 'npc', modernPerson, 'Runs the floor and looks the other way when told to.'],
    ['guard', 'Night security guard', 'npc', modernPerson, 'Walks the yard at two a.m. and has seen things nobody would believe.'],
    ['scrapyard', 'Scrapyard', 'place', (r) => `${possessive(modernFamily(r))} Salvage`, 'Stacks of rusting cars and a dog that never stops barking.'],
  ],
  civic: [
    ['clerk', 'City clerk', 'npc', modernPerson, 'Files every permit and remembers the ones that went missing.'],
    ['officer', 'Police officer', 'npc', modernPerson, 'Works nights, keeps a notebook, trusts nobody at city hall.'],
    ['librarian', 'Librarian', 'npc', modernPerson, 'Guards the local history room and its unindexed boxes.'],
  ],
  waterfront: [
    ['dockhand', 'Dock worker', 'npc', modernPerson, 'Unloads whatever comes in and never asks what is in the crates.'],
    ['bait', 'Bait and tackle shop', 'place', (r) => `${possessive(modernFamily(r))} Bait & Tackle`, 'Sells coffee, rumors and tide tables at the end of the pier.'],
    ['captain', 'Charter boat captain', 'npc', modernPerson, 'Takes tourists out by day and other cargo by night.'],
  ],
};

/** Register another era's table. */
export function defineRoleTable(era, table) { ROLE_TABLES[era] = table; }

/** Towns whose model carries district uses can be populated. */
export function canPopulate(model) {
  return !!model && Array.isArray(model.districts) && model.districts.length > 0 && !!ROLE_TABLES[model.era || 'fantasy'];
}

/**
 * The roles still open on this town, as suggestions:
 * [{ key, use, district, title, kind: 'npc'|'place', name, blurb, x, y }],
 * x/y normalized (0..1) at a building of the matching district.
 * `isFilled(key)` says whether a role already has a live entry.
 */
export function populateSuggestions(map, model, size, isFilled = () => false) {
  if (!canPopulate(model)) return [];
  const table = ROLE_TABLES[model.era || 'fantasy'];
  const [W, H] = size;
  const out = [];
  for (const district of model.districts) {
    // buildings in a fixed order, so a pick depends only on the seed
    const buildings = (model.buildings || []).filter((b) => b.use === district.use && !b.landmark)
      .sort((a, b) => a.y - b.y || a.x - b.x);
    for (const [role, title, kind, makeName, blurb] of table[district.use] || []) {
      const key = `${district.use}:${role}`;
      if (isFilled(key)) continue;
      const rng = makeRng(`${map.seed}:populate:${key}`);
      const name = makeName(rng);
      const b = buildings.length ? buildings[rng.int(0, buildings.length - 1)] : { x: district.cx, y: district.cy };
      out.push({ key, use: district.use, district: district.name, title, kind, name, blurb, x: b.x / W, y: b.y / H });
    }
  }
  return out;
}
