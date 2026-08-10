// Pure helpers for linking generated atlas/region settlements to town maps.
// Generated models are ephemeral; map.scaleLinks is the small persisted bridge
// from a deterministic site key to the linked location entity.

function siteKey(kind, index, name) {
  return `${kind}:${index}:${encodeURIComponent(String(name || '').trim().toLowerCase())}`;
}

/** Return generated settlements in native canvas coordinates. */
export function settlementSites(map, model, size) {
  const [width, height] = size;
  if (map?.kind === 'world' && model?.atlas && Array.isArray(model.towns)) {
    const sx = width / model.gw, sy = height / model.gh;
    return model.towns.map((town, index) => ({
      key: siteKey('world', index, town.name),
      name: String(town.name || `Settlement ${index + 1}`),
      x: town.x * sx,
      y: town.y * sy,
      size: Number(town.size) || 1,
      capital: !!town.capital,
    }));
  }
  if (map?.kind === 'region' && Array.isArray(model?.settlements)) {
    return model.settlements.map((town, index) => ({
      key: siteKey('region', index, town.name),
      name: String(town.name || `Settlement ${index + 1}`),
      x: town.x,
      y: town.y,
      size: Number(town.size) || 1,
      capital: !!town.seat,
    }));
  }
  return [];
}

export function settlementLinkId(map, site) {
  const id = map?.scaleLinks?.[site?.key];
  return typeof id === 'string' && id ? id : null;
}

export function linkSettlement(map, site, entityId) {
  if (!map || !site?.key || !entityId) return;
  (map.scaleLinks ??= {})[site.key] = entityId;
}

/** Generated glyph sizes 1/2/3 become hamlet/town/city-scale town maps. */
export function townSizeForSettlement(site) {
  const size = Math.max(1, Math.min(3, Math.round(Number(site?.size) || 1)));
  return [1, 3, 4][size - 1];
}

export function townSeedForSettlement(map, site) {
  return `${String(map?.seed || 'map')}:town:${site?.key || 'settlement'}`;
}
