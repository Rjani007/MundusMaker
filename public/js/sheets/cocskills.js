// Export-only defaults: never write untrained skills back into investigator data.
export function completeSkills(data, catalog) {
  const saved = data.skills || [];
  const names = new Set(saved.map(s => s.name.trim().toLowerCase()));
  const missing = catalog.filter(s => !names.has(s.name.toLowerCase())).map(s => ({
    name: s.name,
    value: s.name === 'Dodge' ? (data.dodge ?? Math.floor((data.characteristics?.DEX ?? 50) / 2))
      : s.base === 'EDU' ? (data.characteristics?.EDU ?? 50) : s.base,
  }));
  return [...saved.map(s => ({ ...s })), ...missing].sort((a, b) => a.name.localeCompare(b.name));
}

/** Export and display copy with every skill and its base value (1.9 familiar
 *  layout prints "Accounting (05%)"). Never written back into data. */
export function withSkillBases(data, catalog) {
  return { ...data, skills: completeSkills(data, catalog.skills), skillBases: Object.fromEntries(catalog.skills.map((s) => [s.name, s.base])) };
}
