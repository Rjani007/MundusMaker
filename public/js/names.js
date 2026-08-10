// Seeded fantasy name generator. Map kinds draw their auto-labels from here,
// always on a dedicated rng stream (seed + ':names') so a name never costs a
// draw on a generator's main stream. Pure function of the rng: draws happen in
// a fixed order, so the same rng state always yields the same name.

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// syllable pools — roots are assembled, so the space is combinatorial
const ONSETS = ['', 'b', 'br', 'c', 'cr', 'd', 'dr', 'f', 'fr', 'g', 'gl', 'gr', 'h', 'k', 'kr', 'l', 'm', 'n', 'p', 'r', 's', 'sk', 'st', 'sw', 't', 'th', 'tr', 'v', 'w', 'y'];
const VOWELS = ['a', 'e', 'i', 'o', 'u', 'ae', 'ai', 'ea', 'ie', 'oa', 'ou', 'y'];
const MIDS = ['d', 'l', 'ld', 'm', 'n', 'nd', 'r', 'rd', 'rr', 's', 'st', 'th', 'v'];
const CODAS = ['l', 'ld', 'lm', 'n', 'nd', 'r', 'rn', 'rth', 's', 'sk', 'st', 'th', 'm', 'g', 'k', 'dr', 'lin', 'mar', 'ric', 'wyn'];

function root(rng) {
  // fixed draw order: onset, vowel, second-syllable roll, (mid, vowel), coda
  let s = rng.pick(ONSETS) + rng.pick(VOWELS);
  if (rng.chance(0.42)) s += rng.pick(MIDS) + rng.pick(VOWELS);
  return cap(s + rng.pick(CODAS));
}

/** Join root + suffix, merging a doubled letter at the seam. */
function joined(rng, suffixes) {
  const r = root(rng);
  const suf = rng.pick(suffixes);
  return r.charAt(r.length - 1).toLowerCase() === suf.charAt(0) ? r.slice(0, -1) + suf : r + suf;
}

const SETTLEMENT_SUFFIXES = ['ford', 'haven', 'stead', 'wick', 'mere', 'burgh', 'port', 'vale', 'ton', 'bury', 'holm', 'gate', 'field', 'bridge', 'watch', 'cross'];
const COMPASS = ['North', 'South', 'East', 'West', 'New', 'Old', 'High', 'Low'];

const ADJ = ['Ashen', 'Broken', 'Gilded', 'Sunken', 'Whispering', 'Thorned', 'Frozen', 'Verdant', 'Shattered', 'Silent', 'Amber', 'Iron', 'Misty', 'Shrouded', 'Burning', 'Pale', 'Elder', 'Hollow'];
const TERRAIN_NOUNS = ['Reach', 'Marches', 'Expanse', 'Lowlands', 'Wolds', 'Highlands', 'Moors', 'Fells', 'Barrens', 'Downs', 'Wilds', 'Heath', 'Steppes', 'Hollows'];

const NATION_ENDS = ['ia', 'ea', 'and', 'mark', 'gard', 'heim', 'oria', 'avia', 'enne', 'ath', 'ium', 'ost'];
const NATION_TITLES = ['Kingdom', 'Empire', 'Duchy', 'Grand Duchy', 'Realm', 'Principality', 'Sultanate', 'Republic', 'Confederacy', 'March', 'Palatinate', 'Protectorate'];
const NATION_TRAILERS = ['Dominion', 'Ascendancy', 'Compact', 'Hegemony', 'League', 'Concord', 'Union', 'Covenant', 'Throne', 'Pact', 'Accord', 'Crownlands'];

const TRADES = ['Copper', 'Tanner', 'Fish', 'Silk', 'Salt', 'Iron', 'Wool', 'Spice', 'Silver', 'Candle', 'Rope', 'Mill', 'Glass', 'Cooper'];
const WARD_NOUNS = ['Quarter', 'Ward', 'Row', 'End', 'Yards', 'Court', 'Commons', 'Hill', 'Cross', 'Walk', 'Side', 'Bottom'];
const WARD_FIXED = ['Old Town', 'High Town', 'Low Town', 'New Town', 'The Shambles', 'The Narrows'];

const TAVERN_ADJ = ['Prancing', 'Gilded', 'Drunken', 'Sleeping', 'Laughing', 'Wandering', 'Crooked', 'Salty', 'Rusty', 'Merry', 'Howling', 'Thirsty', 'Golden', 'Weeping', 'Lucky', 'Crimson'];
const BEASTS = ['Pony', 'Griffin', 'Boar', 'Stag', 'Raven', 'Dragon', 'Goose', 'Ox', 'Wyvern', 'Hare', 'Mermaid', 'Lion', 'Eel', 'Badger', 'Rooster', 'Toad'];
const TAVERN_OBJECTS = ['Flagon', 'Kettle', 'Crown', 'Anchor', 'Candle', 'Barrel', 'Lantern', 'Tankard'];

const FEATURES = ['Folly', 'Rest', 'Watch', 'Fall', 'Crossing', 'Barrow', 'Spire', 'Gate', 'Throne', 'Sorrow', 'Leap', 'Cairn', 'Hollow', 'Needle'];

// Person names are explicit pools rather than reusing place-name roots. They
// are intentionally setting-neutral and broad enough for a hurried GM to roll
// several people at the same table without the results feeling related.
const PERSON_GIVEN = [
  'Aderyn', 'Amara', 'Ansel', 'Aric', 'Bela', 'Bran', 'Cassia', 'Corin',
  'Dara', 'Del', 'Eira', 'Elian', 'Esme', 'Fenn', 'Galen', 'Hana', 'Ilya',
  'Iris', 'Jori', 'Kael', 'Kessa', 'Lio', 'Liora', 'Mara', 'Merek', 'Nia',
  'Niko', 'Orla', 'Perrin', 'Ravi', 'Ren', 'Sabine', 'Sable', 'Tamsin',
  'Tarin', 'Una', 'Vesper', 'Wren', 'Yara', 'Zev',
];
const PERSON_FAMILY = [
  'Ashdown', 'Blackreed', 'Brightwater', 'Cask', 'Dawnmere', 'Emberlain',
  'Fairweather', 'Fenwick', 'Grey', 'Hallow', 'Hearth', 'Ironwood', 'Kestrel',
  'Lark', 'Marrow', 'Moss', 'North', 'Oak', 'Pike', 'Quill', 'Reeve', 'Rook',
  'Sable', 'Salt', 'Stone', 'Thorne', 'Vale', 'Vell', 'Ward', 'Wilder',
];

function settlement(rng) {
  const name = joined(rng, SETTLEMENT_SUFFIXES);
  return rng.chance(0.12) ? rng.pick(COMPASS) + ' ' + name : name;
}

function region(rng) {
  const roll = rng();
  if (roll < 0.5) return 'The ' + rng.pick(ADJ) + ' ' + rng.pick(TERRAIN_NOUNS);
  if (roll < 0.8) return root(rng) + ' ' + rng.pick(TERRAIN_NOUNS);
  return 'The ' + rng.pick(TERRAIN_NOUNS) + ' of ' + root(rng);
}

function nation(rng) {
  const roll = rng();
  if (roll < 0.45) {
    const r = root(rng);
    const end = rng.pick(NATION_ENDS);
    return r.charAt(r.length - 1).toLowerCase() === end.charAt(0) ? r.slice(0, -1) + end : r + end;
  }
  if (roll < 0.75) return rng.pick(NATION_TITLES) + ' of ' + root(rng);
  return root(rng) + ' ' + rng.pick(NATION_TRAILERS);
}

function ward(rng) {
  const roll = rng();
  if (roll < 0.4) return rng.pick(TRADES) + ' ' + rng.pick(WARD_NOUNS);
  if (roll < 0.65) return rng.pick(TRADES) + 'gate';
  if (roll < 0.85) return rng.pick(ADJ) + ' Quarter';
  return rng.pick(WARD_FIXED);
}

function tavern(rng) {
  const roll = rng();
  if (roll < 0.7) return 'The ' + rng.pick(TAVERN_ADJ) + ' ' + rng.pick(BEASTS);
  return 'The ' + rng.pick(BEASTS) + ' & ' + rng.pick(TAVERN_OBJECTS);
}

function landmark(rng) {
  const roll = rng();
  if (roll < 0.55) return root(rng) + "'s " + rng.pick(FEATURES);
  if (roll < 0.8) return 'The ' + rng.pick(ADJ) + ' ' + rng.pick(FEATURES);
  return rng.pick(FEATURES) + ' of ' + root(rng);
}

function person(rng) {
  return `${rng.pick(PERSON_GIVEN)} ${rng.pick(PERSON_FAMILY)}`;
}

/** One name in the given style. `rng` is a makeRng instance owned by the caller. */
export function nameFor(rng, style) {
  switch (style) {
    case 'settlement': return settlement(rng);
    case 'region': return region(rng);
    case 'nation': return nation(rng);
    case 'ward': return ward(rng);
    case 'tavern': return tavern(rng);
    case 'landmark': return landmark(rng);
    case 'person': return person(rng);
    default: return root(rng);
  }
}

/** A deliberately non-deterministic suggestion for buttons in editable UI. */
export function randomName(style = 'person') {
  const rng = () => Math.random();
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
  rng.chance = (p) => rng() < p;
  return nameFor(rng, style);
}

/** Best first guess for a name button beside an entity field. */
export function nameStyleForType(type) {
  if (type === 'character' || type === 'npc') return 'person';
  if (type === 'location') return 'settlement';
  if (type === 'faction') return 'nation';
  return 'landmark';
}
