// Pure operations shared by the session entry and the Encounter page.
// Existing tracker rows and their extra fields are retained as written.
export function trackerFor(session) {
  return session.sessionTracker || { round: 1, active: 0, rows: [] };
}

export function activeIndex(tracker) {
  const length = tracker.rows?.length || 0;
  const index = Number(tracker.active);
  return length && Number.isInteger(index) && index >= 0 && index < length ? index : 0;
}

export function trackerRound(tracker) {
  const round = Number(tracker.round);
  return Number.isSafeInteger(round) && round >= 1 ? round : 1;
}

export function stepTurn(tracker, direction = 1) {
  const length = tracker.rows?.length || 0;
  if (!length) return false;
  const round = trackerRound(tracker);
  const next = activeIndex(tracker) + direction;
  if (next < 0 && round === 1) return false;
  tracker.active = (next + length) % length;
  tracker.round = round + (next >= length ? 1 : next < 0 ? -1 : 0);
  return true;
}

export function sortInitiative(tracker) {
  if (!tracker.rows?.length) return false;
  const active = tracker.rows[activeIndex(tracker)];
  const score = (row) => row.initiative !== '' && row.initiative != null && Number.isFinite(Number(row.initiative))
    ? Number(row.initiative) : -Infinity;
  // Array.sort is stable; ties retain their previous order, including blank rolls.
  tracker.rows.sort((a, b) => score(a) === score(b) ? 0 : score(b) - score(a));
  tracker.active = tracker.rows.indexOf(active);
  return true;
}

export function removeCombatant(tracker, index) {
  if (!tracker.rows?.[index]) return false;
  const active = activeIndex(tracker);
  tracker.rows.splice(index, 1);
  tracker.active = tracker.rows.length ? (active > index ? active - 1 : active) % tracker.rows.length : 0;
  return true;
}

export function adjustHp(row, amount) {
  // An unknown HP value stays unknown until the GM enters it. Negative HP is
  // allowed, as in the original tracker; this list does not impose a ruleset.
  if (row.hp === '' || row.hp == null || !Number.isSafeInteger(Number(row.hp))
      || !Number.isSafeInteger(amount) || !Number.isSafeInteger(Number(row.hp) + amount)) return false;
  row.hp = Number(row.hp) + amount;
  return true;
}

export function combatantFromEntity(entity, id) {
  const stat = entity?.blocks?.find((block) => block.kind === 'statblock')?.stat;
  const sheet = entity?.blocks?.find((block) => block.kind === 'sheet' && block.system === 'dnd2024')?.data;
  const statHp = /^\s*(\d+)(?:\s|$)/.exec(String(stat?.hp ?? ''));
  const max = sheet?.hp?.max ?? (statHp ? Number(statHp[1]) : '');
  const current = sheet?.hp?.current ?? max;
  const hp = (value) => value !== '' && value != null && Number.isSafeInteger(Number(value)) ? Number(value) : '';
  return { id, name: entity?.name || '', to: entity?.id || null, initiative: '', hp: hp(current), maxHp: hp(max), conditions: '' };
}
