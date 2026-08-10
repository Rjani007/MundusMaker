// Chronology kernel: month/intercalary geometry, sort keys, and date formatting.
//
// ZERO imports on purpose. Every function takes the calendar object explicitly
// (world.calendar) so this module stays importable and testable in plain Node.
//
// ---------------------------------------------------------------------------
// WHY SLOT ORDINALS AND NOT dayOfYear
// ---------------------------------------------------------------------------
// A "day of the year" sort key needs month lengths, and month lengths are user
// data that arrives AFTER the dates do. Declare month 1 as 30 days and the
// legacy date {month:1, day:31} collapses onto {month:2, day:1} — both become
// dayOfYear 31 — a tie the CURRENT comparator resolves correctly. (This is not
// hypothetical: the owner's world already holds {year:2026, month:1, day:41}.)
// So we never add days up. A date sorts by the POSITION of its month (or its
// intercalary day) in the interleaved month/intercalary sequence — the slot
// ordinal — then by day number. Declaring a 28-day month can never reorder
// anything because no length is ever consulted.
//
// NO-CLAMP RULE: nothing here rewrites, clamps or rejects a date that falls
// outside a declared month length. Out-of-range days sort and print as written.
//
// ---------------------------------------------------------------------------
// BACK-COMPAT PROOF
// ---------------------------------------------------------------------------
// For a world with no calendar.intercalary[], slotsOf() is exactly
// [month 1 .. month N] in order, so slotOrdinal({month:m}) === m for every m in
// range, slotOrdinal({month:m}) === m for m past the end (the fallback keeps
// the raw number), and slotOrdinal({}) === 0 — which is what (date.month ?? 0)
// yields today. Therefore histSortKey reduces EXACTLY to the current
// comparator's (year, month ?? 0, day ?? 0) and no existing timeline reorders.
// Likewise, with no monthDays[] every month is the default 30 (a value nothing
// in the sort path reads) and with no ages[] formatDate/formatYear fall back to
// world.era, so every existing world prints byte-for-byte as it does in 0.8.

/** Month names + lengths, normalised. Missing/invalid lengths default to 30. */
export function calMonths(cal) {
  const names = Array.isArray(cal?.months) ? cal.months : [];
  const days  = Array.isArray(cal?.monthDays) ? cal.monthDays : [];
  return names.map((n, i) => ({
    name: typeof n === 'string' ? n : (n?.name ?? `Month ${i + 1}`),
    days: Number.isFinite(days[i]) && days[i] > 0 ? days[i] : (Number.isFinite(n?.days) ? n.days : 30),
  }));
}

/**
 * The year as an ordered sequence of slots: months with intercalary days
 * spliced in after the month they follow (`after: 0` means before month 1).
 */
export function slotsOf(cal) {
  const months = calMonths(cal);
  const inter  = [...(cal?.intercalary || [])].sort((a, b) => (a.after ?? 0) - (b.after ?? 0));
  const out = [];
  for (const ic of inter) if ((ic.after ?? 0) === 0)
    out.push({ kind: 'special', id: ic.id, name: ic.name, days: ic.days ?? 1 });
  for (let m = 1; m <= months.length; m++) {
    out.push({ kind: 'month', month: m, name: months[m - 1].name, days: months[m - 1].days });
    for (const ic of inter) if ((ic.after ?? 0) === m)
      out.push({ kind: 'special', id: ic.id, name: ic.name, days: ic.days ?? 1 });
  }
  return out;
}

/** 1-based position in slotsOf(). 0 means "no slot given" and sorts first — exactly what (date.month ?? 0) does today. */
export function slotOrdinal(date, cal) {
  if (!date) return 0;
  const slots = slotsOf(cal);
  if (date.special) {
    const i = slots.findIndex((s) => s.kind === 'special' && s.id === date.special);
    return i >= 0 ? i + 1 : (date.month ?? 0);   // unknown id: degrade, never throw
  }
  if (!date.month) return 0;
  const i = slots.findIndex((s) => s.kind === 'month' && s.month === date.month);
  return i >= 0 ? i + 1 : date.month;            // month past the declared list keeps its number
}

/** A dated point in history: has a real year and does not repeat. */
export const isHistoric  = (d) => !!d && d.recurs !== 'annual' && Number.isFinite(d.year);
/** Repeats every year, so it has no year at all. */
export const isRecurring = (d) => !!d && d.recurs === 'annual';

// TWO KEYS, DELIBERATELY. A recurring date has no year, so a single key would
// produce [undefined, slot, day] and undefined - undefined is NaN — an unstable,
// silently wrong sort. Filter with isHistoric() BEFORE any chronological sort
// and order recurring entries with slotSortKey where they are shown.
export const histSortKey = (d, cal) => [d.year, slotOrdinal(d, cal), d.day ?? 0];
export const slotSortKey = (d, cal) => [slotOrdinal(d, cal), d.day ?? 0];
export const cmpKey = (a, b) => { for (let i = 0; i < a.length; i++) { const v = a[i] - b[i]; if (v) return v; } return 0; };

/** The age a year falls in: the latest age starting on or before it, else null. */
export function ageFor(year, cal) {
  if (!Number.isFinite(year)) return null;
  const ages = (Array.isArray(cal?.ages) ? cal.ages : [])
    .filter((a) => a && Number.isFinite(a.startYear))
    .sort((a, b) => a.startYear - b.startYear);   // never assume input order
  let found = null;
  for (const a of ages) { if (a.startYear <= year) found = a; else break; }
  return found;
}

/** The earliest declared age, or null. Used to name the band before all ages. */
function firstAge(cal) {
  return (Array.isArray(cal?.ages) ? cal.ages : [])
    .filter((a) => a && Number.isFinite(a.startYear))
    .sort((a, b) => a.startYear - b.startYear)[0] || null;
}

/** Does this world declare a usable age at all? Worlds that don't keep a flat timeline. */
export function hasAges(cal) {
  return !!firstAge(cal);
}

/** Heading for an age band. `null` is everything earlier than the first age. */
export function ageBandLabel(age, cal) {
  if (age) return age.name || 'Unnamed age';
  const first = firstAge(cal);
  return first?.name ? `Before the ${first.name}` : 'Earlier years';
}

/**
 * Split an ALREADY YEAR-ORDERED list into consecutive age bands, so the timeline
 * and the PDF can never disagree about where a band starts or what it is called.
 *
 * Consecutive grouping is safe because ageFor() is monotonic in the year and the
 * input is sorted by year: an age can therefore appear at most once. Bands are
 * built from the list the CALLER already filtered, so a band header only ever
 * exists when at least one entry the reader may see falls inside it — a player
 * export cannot reveal an age whose only entries are GM-only.
 *
 * With no ages declared every entry lands in a single `age: null` band; callers
 * gate on hasAges() and render the flat 0.8 list in that case, so a world that
 * has never touched `ages` gets no headers at all.
 */
export function ageBands(items, cal, dateOf) {
  const bands = [];
  for (const it of items) {
    const age = ageFor(dateOf(it)?.year, cal);
    const last = bands[bands.length - 1];
    if (last && last.age === age) last.items.push(it);
    else bands.push({ age, label: ageBandLabel(age, cal), items: [it] });
  }
  return bands;
}

// The age name REPLACES the world's era suffix. We use the full name rather
// than `abbr` because this suffix is read as prose ("1026 Age of Ash") in
// timelines, entity headers and PDFs; `abbr` stays in the data for compact
// surfaces that may want it later.
function yearSuffix(year, cal, era) {
  const age = ageFor(year, cal);
  if (age?.name) return ` ${age.name}`;
  return era ? ` ${era}` : '';
}

/** "1026 Age of Ash" / "1026 AR" / "1026". Years are ALWAYS absolute — ages never restart numbering. */
export function formatYear(year, cal, era) {
  if (!Number.isFinite(year)) return '';
  return String(year) + yearSuffix(year, cal, era);
}

function specialSlot(id, cal) {
  if (!id) return null;
  return slotsOf(cal).find((s) => s.kind === 'special' && s.id === id) || null;
}

/** Month name for display; falls back to a plain "Month 9" when unnamed. */
function monthLabel(month, cal) {
  const months = calMonths(cal);
  const name = months[month - 1]?.name;
  return name || `Month ${month}`;
}

/** "14 Harvestmoon" / "Harvestmoon" / "Mid-year's Day" — the year-less part of a date. */
function slotLabel(date, cal) {
  const day = date.day ? `${date.day} ` : '';
  const sp = specialSlot(date.special, cal);
  if (sp) return `${day}${sp.name || sp.id}`;
  if (date.month) return `${day}${monthLabel(date.month, cal)}`;
  return '';
}

/**
 * The full human date. Reproduces render.js formatWorldDate byte-for-byte for
 * every shape that exists today (year / year+month / year+month+day, named or
 * numeric fallback, era suffix), and additionally handles intercalary days and
 * annually recurring dates.
 */
export function formatDate(date, cal, era) {
  if (!date) return '';

  if (isRecurring(date)) {
    const label = slotLabel(date, cal);
    if (!label) return 'Every year';
    return `Every year ${date.day || date.special ? 'on' : 'in'} ${label}`;
  }

  if (!Number.isFinite(date.year)) return '';
  const suffix = yearSuffix(date.year, cal, era);

  const sp = specialSlot(date.special, cal);
  if (sp) return `${date.day ? date.day + ' ' : ''}${sp.name || sp.id} ${date.year}${suffix}`;

  // Named-month branch. The gate is formatWorldDate's exact test — the RAW
  // months entry must be truthy — so a blank or missing name still falls
  // through to the numeric form the way it does today.
  const raw = Array.isArray(cal?.months) ? cal.months[date.month - 1] : null;
  if (date.month && raw) {
    const name = calMonths(cal)[date.month - 1].name;
    return `${date.day ? date.day + ' ' : ''}${name} ${date.year}${suffix}`;
  }

  // Numeric fallback: "1021.09.14".
  let s = String(date.year);
  if (date.month) s += `.${String(date.month).padStart(2, '0')}`;
  if (date.day) s += `.${String(date.day).padStart(2, '0')}`;
  return s + suffix;
}

/**
 * Resolve a concrete date to its zero-based day within the year. This is for
 * date arithmetic only; chronology sorting deliberately continues to use slot
 * ordinals so changing month lengths can never reorder historical entries.
 */
function concreteDay(date, cal) {
  if (!date || !Number.isFinite(date.year)) return null;
  const slots = slotsOf(cal);
  const index = date.special
    ? slots.findIndex((s) => s.kind === 'special' && s.id === date.special)
    : slots.findIndex((s) => s.kind === 'month' && s.month === date.month);
  if (index < 0) return null;
  const day = Number.isFinite(date.day) ? Math.trunc(date.day) : 1;
  if (day < 1 || day > slots[index].days) return null; // NO-CLAMP: decline invalid dates
  const before = slots.slice(0, index).reduce((sum, slot) => sum + slot.days, 0);
  return { slots, index, day, ordinal: before + day - 1 };
}

/** Advance a valid structured date without ever normalising an invalid one. */
export function advanceDate(date, cal, amount = 1) {
  const pos = concreteDay(date, cal);
  const steps = Math.trunc(Number(amount));
  if (!pos || !Number.isFinite(steps) || steps < 0) return null;
  let year = date.year;
  let index = pos.index;
  let day = pos.day;
  for (let left = steps; left > 0; left--) {
    day++;
    if (day <= pos.slots[index].days) continue;
    day = 1;
    index++;
    if (index >= pos.slots.length) { index = 0; year++; }
  }
  const slot = pos.slots[index];
  return slot.kind === 'special'
    ? { year, special: slot.id, day }
    : { year, month: slot.month, day };
}

/** Days from a structured current date to the next occurrence of an annual date. */
export function daysUntilAnnual(today, annual, cal) {
  if (!isRecurring(annual)) return null;
  const now = concreteDay(today, cal);
  if (!now) return null;
  const target = concreteDay({ ...annual, year: today.year }, cal);
  if (!target) return null;
  const yearDays = now.slots.reduce((sum, slot) => sum + slot.days, 0);
  const delta = target.ordinal - now.ordinal;
  return delta >= 0 ? delta : delta + yearDays;
}
