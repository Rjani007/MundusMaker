// Full-screen map editor: seeded generation + hand editing.
// The per-kind parts (param rows, paint tools, brush vs grid painting, the
// reset-edits button) all come from the kind's declarative entry in MAP_KINDS
// — this file renders them generically and never branches on map.kind.
//   all kinds: draggable markers/stamps/labels/paths with GM-secret flags

import { el, toast, debounce, downloadBlob, clamp, uid } from '../util.js';
import {
  state, getEntity, visibleEntities, scheduleSave, saveEntity, flushSaves, requireSaved, newEntity, types,
} from '../state.js';
import {
  MAP_KINDS, newMap, newMarker, newLabel, MARKER_SHAPES, MARKER_COLORS,
  newStamp, STAMP_KINDS, STAMP_COLORS, FURNITURE_STAMPS, newPath, PATH_STYLES,
  drawOverlay, renderMap, hiddenOverlayLinkIds, baseAnnotations,
} from '../maps/mapcore.js';
import {
  settlementSites, regionSites, settlementLinkId, linkSettlement, customKey, drilledTownEra,
  townSizeForSettlement, townSeedForSettlement, townParamsForSettlement,
  regionSeedForSite, extractCarve, regionParamsForSite, inheritedRegionSites,
  syncLinkedSiteNames,
} from '../maps/crossscale.js';
import { planWikiRenames } from '../render.js';
import { randomName } from '../names.js';
import { supportsUniversalVtt, universalVttText } from '../maps/uvtt.js';
import { api } from '../api.js';
import { mapHistory, replaceMapData } from '../maps/history.js';
import { previewModel } from '../maps/generation.js';
import { finishCartography, drawMapLegend } from '../maps/cartography.js';
import { confirmReveal } from '../reveal.js';
import { keySpace, drawKeyBadges } from '../maps/mapkeys.js';
import { mapKeyPanel } from './mapkeypanel.js';
import { populatePanel } from './populatepanel.js';
import { canPopulate } from '../maps/populate.js';
import { journeyPanel } from './journeypanel.js';

export function render(container, id) {
  const e = getEntity(id);
  if (!e?.map) {
    container.append(el('div', { class: 'page' }, el('div', { class: 'notice warn' }, 'This entry has no map.')));
    return;
  }
  if (!state.gm && e.gmOnly) {
    container.append(el('div', { class: 'page' }, el('div', { class: 'notice warn' }, '🔒 GM-only content is hidden in player preview.')));
    return;
  }
  const map = e.map;
  const kind = MAP_KINDS[map.kind];
  const readOnly = !state.gm;
  const hiddenLinkIds = hiddenOverlayLinkIds(map, state.entities.values());
  const overlayHidden = (item) => readOnly && (item.secret || (item.to && hiddenLinkIds.has(item.to)));

  const history = mapHistory(map);
  var syncHistory = () => {};
  const save = () => { history.record(); syncHistory(); scheduleSave(e); };
  const layers={base:true,markers:true,stamps:true,paths:true,labels:true};
  const originWorld=state.worldId;
  let previewController=null;

  // ---------- editor state ----------
  let tool = 'move';
  let brush = { r: 0.045, strength: 0.09 };
  let markerOpts = { shape: 'dot', color: MARKER_COLORS[0], secret: false };
  // building maps offer furniture; everything else offers structures
  const stampChoices = kind.stampKinds || Object.keys(STAMP_KINDS).filter((k) => !FURNITURE_STAMPS.includes(k));
  let stampOpts = { kind: stampChoices[0], color: '', size: 1, secret: false }; // '' = kind default
  let drawOpts = { style: 'road', color: '', width: 0, secret: false }; // 0/'' = style default
  let labelSize = 24;
  let selected = null;
  let drawingPath = null; // path being drawn right now
  let lastDragPos = null;
  let model = null;
  let base = null;
  let W = 0, H = 0;
  let level = 0; // current floor of a multi-level kind; 0 for everything else
  let pendingAdd = null; // {kind, size?, townSize?}; the next canvas click places a new site
  let siteDrag = null;   // {site, x, y, moved}; a generated/custom site mid-drag
  let siteRenameQueue = Promise.resolve();
  let suppressClick = false; // a drag or placement must not double as an open-click

  const canvas = el('canvas');
  const ctx = canvas.getContext('2d');

  const currentSettlements = () => settlementSites(map, model, [W, H]);
  const currentRegions = () => regionSites(map, model, [W, H]);
  const drillKindOf = (site) => (site.kind === 'region' ? 'region' : 'town');
  const brokenSiteLink = (site) => {
    const id = settlementLinkId(map, site);
    if (!id) return null;
    const target = getEntity(id);
    if (!target) return { id, reason: 'deleted' };
    if (target.map?.kind !== drillKindOf(site)) return { id, target, reason: 'wrong-map' };
    return null;
  };
  const linkedSite = (site) => {
    const target = getEntity(settlementLinkId(map, site));
    if (!target || target.map?.kind !== drillKindOf(site)) return null;
    return state.gm || !target.gmOnly ? target : null;
  };
  // settlement dots first (small targets), then region seats, then the big
  // faint region names — a name is a click target but never a drag handle
  const hitSite = (p) => {
    let best = null, distance = Infinity;
    for (const site of currentSettlements()) {
      const d = Math.hypot(site.x - p.x, site.y - p.y);
      if (d < 17 && d < distance) { best = site; distance = d; }
    }
    if (best) return { site: best, via: 'seat' };
    for (const site of currentRegions()) {
      const d = Math.hypot(site.x - p.x, site.y - p.y);
      if (d < 16 && d < distance) { best = site; distance = d; }
    }
    if (best) return { site: best, via: 'seat' };
    for (const site of currentRegions()) {
      ctx.font = 'bold 26px Georgia, serif';
      const hw = ctx.measureText(String(site.name || '').toUpperCase()).width / 2 + 6;
      if (Math.abs((site.labelX ?? site.x) - p.x) < hw && Math.abs((site.labelY ?? site.y) - p.y) < 18) {
        return { site, via: 'label' };
      }
    }
    return null;
  };

  function personTypeKey() {
    const worldTypes = types();
    return worldTypes.npc ? 'npc' : worldTypes.character ? 'character' : 'note';
  }

  function locationTypeKey() {
    const worldTypes = types();
    return worldTypes.location ? 'location'
      : (Object.entries(worldTypes).find(([, spec]) =>
        String(spec?.label || '').trim().toLowerCase() === 'location')?.[0] || 'note');
  }

  let openingSite = false;
  // An inherited site mirrors a site on the parent world map — link the town
  // there too, so drilling from the world later opens this same entry instead
  // of offering a duplicate.
  async function linkOrigin(site, entityId) {
    if (!site.origin || !map.parentId) return;
    const parent = getEntity(map.parentId);
    if (!parent?.map) return;
    (parent.map.scaleLinks ??= {})[site.origin] = entityId;
    await saveEntity(parent);
  }
  async function openSettlement(site) {
    if (openingSite) return;
    const linked = linkedSite(site);
    if (linked) { location.hash = `#/map/${linked.id}`; return; }
    if (readOnly) return;
    openingSite = true;
    try {
      // Offer to reuse an existing same-name town map before creating another —
      // asked, not silent, because a same-name match can be a different place.
      const existing = [...state.entities.values()].find((candidate) =>
        candidate.name.trim().toLowerCase() === site.name.trim().toLowerCase()
        && candidate.map?.kind === 'town');
      if (existing && confirm(`Link ${site.name} to the existing entry “${existing.name}” and its town map?`)) {
        linkSettlement(map, site, existing.id);
        await saveEntity(e);
        await linkOrigin(site, existing.id);
        location.hash = `#/map/${existing.id}`;
        return;
      }
      if (!confirm(`Create a location entry and town map for ${site.name}?`)) return;
      let town = newEntity(site.name, locationTypeKey());
      town.fields.Kind = site.capital ? 'Capital settlement' : 'Settlement';
      town.map = newMap('town');
      town.map.parentId = e.id; // provenance used when renames climb the chain
      town.map.seed = townSeedForSettlement(map, site);
      // the town's layout, terrain and size follow the parent's geography at
      // this spot — a coastal site gets a harbor, a desert one a desert town
      // (per-kind facts come from the kind's drillContext hook, not a branch)
      const drillCtx = kind.drillContext ? kind.drillContext(map, model) : {};
      Object.assign(town.map.params, townParamsForSettlement(map, model, site, drillCtx));
      // this map's "Towns opened here", else the world default (Maps page); a
      // coastal or riverside site still gets its water in a modern town
      if (drilledTownEra(map, state.world) === 'modern') town.map.params.era = 'modern';
      town = await saveEntity(town);
      linkSettlement(map, site, town.id);
      await saveEntity(e);
      await linkOrigin(site, town.id);
      toast(`Created ${town.name}'s town map`);
      location.hash = `#/map/${town.id}`;
    } catch (err) {
      console.error(err);
      toast('Could not create the town map');
    } finally {
      openingSite = false;
    }
  }

  // Region drill-down: the region map carves its terrain out of THIS map's
  // model (a frozen snapshot), inherits the site's name as its title, and a
  // climate-matched palette. Same link mechanics as settlements → towns.
  async function openRegion(site) {
    if (openingSite) return;
    const linked = linkedSite(site);
    if (linked) { location.hash = `#/map/${linked.id}`; return; }
    if (readOnly) return;
    openingSite = true;
    try {
      const existing = [...state.entities.values()].find((candidate) =>
        candidate.name.trim().toLowerCase() === site.name.trim().toLowerCase()
        && candidate.map?.kind === 'region');
      if (existing && confirm(`Link ${site.name} to the existing entry “${existing.name}” and its region map?`)) {
        linkSettlement(map, site, existing.id);
        await saveEntity(e);
        location.hash = `#/map/${existing.id}`;
        return;
      }
      if (!confirm(`Create a location entry and region map for ${site.name}?`)) return;
      let region = newEntity(site.name, locationTypeKey());
      region.fields.Kind = 'Region';
      region.map = newMap('region');
      region.map.parentId = e.id; // provenance used when renames climb the chain
      region.map.seed = regionSeedForSite(map, site);
      const drillCtx = kind.drillContext ? kind.drillContext(map, model) : {};
      const carve = extractCarve(model, site, drillCtx);
      if (carve) region.map.carve = carve;
      Object.assign(region.map.params, regionParamsForSite(model, site, carve));
      // this world's own towns inside the carve window become sites on the new
      // region map — same names, same relative positions, capital stays seat —
      // and the region generates fewer of its own hamlets to make room
      const inherited = inheritedRegionSites(map, model, site, carve);
      if (inherited.length) {
        region.map.sites = inherited;
        const target = region.map.params.settlements ?? 4;
        region.map.params.settlements = Math.max(1, Math.min(9, target - inherited.length));
        for (const s of inherited) {
          const linkedId = map.scaleLinks?.[s.origin];
          if (linkedId) (region.map.scaleLinks ??= {})[customKey(s)] = linkedId;
        }
      }
      region = await saveEntity(region);
      linkSettlement(map, site, region.id);
      await saveEntity(e);
      toast(`Created ${region.name}'s region map`);
      location.hash = `#/map/${region.id}`;
    } catch (err) {
      console.error(err);
      toast('Could not create the region map');
    } finally {
      openingSite = false;
    }
  }

  async function relinkSite(site, target) {
    if (openingSite || readOnly || target?.map?.kind !== drillKindOf(site)) return;
    openingSite = true;
    try {
      linkSettlement(map, site, target.id);
      await saveEntity(e);
      await linkOrigin(site, target.id);
      toast(`Linked ${site.name} to ${target.name}`);
      location.hash = `#/map/${target.id}`;
    } catch (err) {
      console.error(err);
      toast('Could not repair the map link');
    } finally {
      openingSite = false;
    }
  }

  const openSite = async (site) => {
    const broken = brokenSiteLink(site);
    if (broken && !readOnly) {
      const detail = broken.reason === 'deleted'
        ? `“${site.name}” was linked to an entry that has been deleted.`
        : `The entry linked to “${site.name}” no longer has a ${drillKindOf(site)} map.`;
      if (!confirm(`${detail} Continue to reuse a same-name map or create a replacement? Use the Relink menu to choose a different existing map.`)) return;
    }
    return site.kind === 'region' ? openRegion(site) : openSettlement(site);
  };

  function drawSiteLinkHints() {
    ctx.save();
    for (const site of [...currentSettlements(), ...currentRegions()]) {
      const linked = linkedSite(site);
      const broken = state.gm && brokenSiteLink(site);
      if (!linked && !broken) continue;
      ctx.beginPath();
      ctx.arc(site.x, site.y, 12, 0, Math.PI * 2);
      ctx.strokeStyle = broken ? '#e6a14c' : '#7fd7ff';
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(site.x + 9, site.y - 9, 3, 0, Math.PI * 2);
      ctx.fillStyle = broken ? '#e6a14c' : '#7fd7ff';
      ctx.fill();
    }
    if (siteDrag) {
      // ghost ring under the cursor; the model rebuilds once on drop
      ctx.beginPath();
      ctx.arc(siteDrag.x, siteDrag.y, 14, 0, Math.PI * 2);
      ctx.strokeStyle = '#ffd77f';
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.restore();
  }

  function rebuild() {
    const count = kind.levelCount ? kind.levelCount(map) : 1;
    if (level >= count) level = count - 1;
    model = kind.buildModel(map, level);
    base = kind.renderBase(map, model, 1, baseAnnotations({ gm: state.gm }));
    [W, H] = kind.size(map);
    canvas.width = W;
    canvas.height = H;
    refreshLevelChips?.();
    refreshExtraPanel?.();
    refreshKeys();
    refreshPopulate();
    journeys?.refresh();
    redraw();
  }

  async function refreshMapFromParent() {
    const parent = getEntity(map.parentId);
    const parentKind = MAP_KINDS[parent?.map?.kind];
    if (!parent?.map || !parentKind?.buildModel || !kind.refreshFromParent) {
      toast('The parent world is not available');
      return false;
    }
    try {
      const parentModel = parentKind.buildModel(parent.map);
      const drillContext = parentKind.drillContext ? parentKind.drillContext(parent.map, parentModel) : {};
      const candidate=structuredClone(map);
      const changed = kind.refreshFromParent({ map:candidate, parentMap: parent.map, parentModel, drillContext });
      if (!changed) {
        toast('This region does not have a refreshable terrain crop');
        return false;
      }
      return await showGenerationPreview(candidate,'Refresh terrain from world');
    } catch (err) {
      console.error(err);
      toast('Could not refresh terrain from the parent world');
      return false;
    }
  }

  // a kind may declare its own panel section (town uses it for ward names);
  // it re-renders whenever the model does
  const extraWrap = el('div', {});
  // map keys (1.9): GM notes on generated places, from the kind's keys hooks
  var keyPanel = null;
  var refreshKeys = () => {};
  // populate (1.9): shown while the model has districts
  const populateWrap = el('div', {});
  var refreshPopulate = () => {};
  var journeys = null; // journey planner (1.9), for kinds with `journeys`
  var refreshExtraPanel = () => {
    if (!kind.extraPanel) return;
    extraWrap.innerHTML = '';
    const section = kind.extraPanel({
      map,
      model,
      readOnly,
      save,
      refreshFromParent: kind.refreshFromParent ? refreshMapFromParent : null,
      refreshBase: () => {
        base = kind.renderBase(map, model, 1, baseAnnotations({ gm: state.gm }));
        redraw();
      },
    });
    if (section) extraWrap.append(section);
  };

  let rafPending = false;
  function redraw() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      ctx.fillStyle='#f7f4eb';ctx.fillRect(0,0,W,H);
      if(layers.base){ctx.drawImage(base,0,0);finishCartography(canvas,map.params?.cartography);}
      const shown={...map};for(const key of ['markers','stamps','paths','labels'])if(!layers[key])shown[key]=[];
      drawOverlay(ctx, shown, W, H, { gm: state.gm, selected, level, hiddenLinkIds });
      if (state.gm && keyPanel) drawKeyBadges(ctx, keyPanel.placedOn(level), level);
      const route = state.gm && journeys?.previewPts();
      if (route?.length > 1) {
        ctx.save(); ctx.strokeStyle = 'rgba(214, 170, 60, 0.95)'; ctx.lineWidth = 4; ctx.setLineDash([10, 6]); ctx.lineJoin = 'round';
        ctx.beginPath(); route.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke(); ctx.restore();
      }
      drawMapLegend(ctx,map,W,H,kind.legendFor?.(map)||kind.legend);
      if(layers.base)drawSiteLinkHints();
    });
  }

  // floor chips for multi-level kinds (dungeons); hidden at 1 level
  const levelChips = el('div', { class: 'tool-row', style: 'margin-bottom:6px' });
  var refreshLevelChips = () => {
    const count = kind.levelCount ? kind.levelCount(map) : 1;
    levelChips.style.display = count > 1 ? '' : 'none';
    levelChips.innerHTML = '';
    for (let i = 0; i < count; i++) {
      levelChips.append(el('button', {
        class: i === level ? 'on' : '', title: `Show level ${i + 1}`,
        onclick: () => { level = i; selected = null; rebuild(); refreshLists(); },
      }, `L${i + 1}`));
    }
  };
  rebuild();

  // ---------- pointer interaction ----------
  const pos = (ev) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (ev.clientX - rect.left) * (W / rect.width),
      y: (ev.clientY - rect.top) * (H / rect.height),
    };
  };

  function distToPath(p, path) {
    let best = Infinity;
    const pts = path.pts || [];
    for (let i = 1; i < pts.length; i++) {
      const ax = pts[i - 1][0] * W, ay = pts[i - 1][1] * H;
      const bx = pts[i][0] * W, by = pts[i][1] * H;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / len2));
      const d = Math.hypot(p.x - (ax + dx * t), p.y - (ay + dy * t));
      if (d < best) best = d;
    }
    return best;
  }

  const onLevel = (o) => (o.level || 0) === level;

  function hitOverlay(p) {
    for (let i = (map.markers || []).length - 1; i >= 0; i--) {
      const mk = map.markers[i];
      if (!layers.markers || overlayHidden(mk) || !onLevel(mk)) continue;
      if (Math.hypot(mk.x * W - p.x, mk.y * H - p.y) < 14) return { obj: mk, list: 'markers' };
    }
    for (let i = (map.stamps || []).length - 1; i >= 0; i--) {
      const s = map.stamps[i];
      if (!layers.stamps || overlayHidden(s) || !onLevel(s)) continue;
      if (Math.hypot(s.x * W - p.x, s.y * H - p.y) < 16 * (s.size || 1)) return { obj: s, list: 'stamps' };
    }
    for (let i = (map.labels || []).length - 1; i >= 0; i--) {
      const lb = map.labels[i];
      if (!layers.labels || !onLevel(lb)) continue;
      ctx.font = `italic ${lb.size}px Georgia, serif`;
      const hw = ctx.measureText(lb.text).width / 2 + 8;
      if (Math.abs(lb.x * W - p.x) < hw && Math.abs(lb.y * H - p.y) < lb.size * 0.75) return { obj: lb, list: 'labels' };
    }
    for (let i = (map.paths || []).length - 1; i >= 0; i--) {
      const path = map.paths[i];
      if (!layers.paths || (path.secret && !state.gm) || !onLevel(path)) continue;
      if (distToPath(p, path) < 8) return { obj: path, list: 'paths' };
    }
    return null;
  }

  let dragging = null, painting = false, lastPaint = null;

  // 'brush' kinds append normalized strokes and re-apply them to the model
  function paintBrush(p) {
    const stroke = {
      x: p.x / W, y: p.y / H, r: brush.r,
      d: (tool === 'lower' ? -1 : 1) * brush.strength,
    };
    if (lastPaint && Math.hypot(lastPaint.x - stroke.x, lastPaint.y - stroke.y) < brush.r * 0.35) return;
    lastPaint = stroke;
    (map.strokes ??= []).push(stroke);
    kind.applyStroke(model, stroke);
    base = kind.renderBase(map, model, 1, baseAnnotations({ gm: state.gm }));
    redraw();
    save();
  }

  // 'grid' kinds paint cells; the kind serializes its own map.grid
  function paintGrid(p) {
    const cx = Math.floor(p.x / kind.cellSize), cy = Math.floor(p.y / kind.cellSize);
    if (!kind.paintCell(map, model, cx, cy, tool)) return;
    base = kind.renderBase(map, model, 1, baseAnnotations({ gm: state.gm }));
    redraw();
    save();
  }

  canvas.addEventListener('pointerdown', (ev) => {
    if (readOnly) return;
    history.begin();
    const p = pos(ev);
    try { canvas.setPointerCapture(ev.pointerId); } catch { /* stale/synthetic pointer */ }
    if (pendingAdd) { placePendingSite(p); return; }
    if (tool === 'move') {
      const hitRes = hitOverlay(p);
      selected = hitRes ? hitRes.obj.id : null;
      dragging = hitRes ? hitRes.obj : null;
      lastDragPos = p;
      if (!hitRes && state.gm) {
        // generated/custom sites drag under the Move tool; region names don't
        const sh = hitSite(p);
        if (sh && sh.via === 'seat' && (sh.site.custom || sh.site.kind === 'settlement')) {
          siteDrag = { site: sh.site, x: sh.site.x, y: sh.site.y, moved: false };
        }
      }
      redraw();
      refreshLists();
    } else if (tool === 'stamp') {
      const s = newStamp(p.x / W, p.y / H, {
        kind: stampOpts.kind, size: stampOpts.size, secret: stampOpts.secret,
        color: stampOpts.color || undefined,
      });
      if (level) s.level = level;
      (map.stamps ??= []).push(s);
      selected = s.id;
      save(); redraw(); refreshLists();
    } else if (tool === 'draw') {
      drawingPath = newPath(drawOpts.style, {
        secret: drawOpts.secret,
        color: drawOpts.color || undefined,
        width: drawOpts.width || undefined,
      });
      if (level) drawingPath.level = level;
      drawingPath.pts.push([clamp(p.x / W, 0, 1), clamp(p.y / H, 0, 1)]);
      (map.paths ??= []).push(drawingPath);
    } else if (tool === 'marker') {
      const mk = newMarker(p.x / W, p.y / H, markerOpts);
      if (level) mk.level = level;
      (map.markers ??= []).push(mk);
      selected = mk.id;
      save(); redraw(); refreshLists();
    } else if (tool === 'label') {
      const text = prompt('Label text:');
      if (text?.trim()) {
        const lb = newLabel(p.x / W, p.y / H, text.trim(), labelSize);
        if (level) lb.level = level;
        (map.labels ??= []).push(lb);
        selected = lb.id;
        save(); redraw(); refreshLists();
      }
    } else if (tool === 'key' && keyPanel) {
      const place = kind.keys.at(map, model, level, p.x, p.y, keySpace(kind, map));
      if (place) keyPanel.pick(place);
      else toast('Nothing to key there. Click a room, a settlement, a landmark or, with the hex grid on, a hex.');
    } else if ((kind.tools || []).some((t) => t.name === tool)) {
      painting = true; lastPaint = null;
      if (kind.paint === 'brush') paintBrush(p);
      else if (kind.paint === 'grid') paintGrid(p);
    }
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (readOnly) return;
    const p = pos(ev);
    if (siteDrag) {
      siteDrag.x = clamp(p.x, 0, W);
      siteDrag.y = clamp(p.y, 0, H);
      if (Math.hypot(p.x - lastDragPos.x, p.y - lastDragPos.y) > 3) siteDrag.moved = true;
      redraw();
    } else if (dragging) {
      if (dragging.pts) {
        // paths move as a whole — translate every point by the drag delta
        const dx = (p.x - lastDragPos.x) / W, dy = (p.y - lastDragPos.y) / H;
        for (const pt of dragging.pts) { pt[0] += dx; pt[1] += dy; }
        lastDragPos = p;
      } else {
        dragging.x = clamp(p.x / W, 0, 1);
        dragging.y = clamp(p.y / H, 0, 1);
      }
      redraw(); save();
    } else if (drawingPath) {
      const last = drawingPath.pts[drawingPath.pts.length - 1];
      if (Math.hypot(p.x - last[0] * W, p.y - last[1] * H) > 7) {
        drawingPath.pts.push([clamp(p.x / W, 0, 1), clamp(p.y / H, 0, 1)]);
        redraw();
      }
    } else if (painting) {
      if (kind.paint === 'brush') paintBrush(p);
      else if (kind.paint === 'grid') paintGrid(p);
    }
  });
  canvas.addEventListener('pointerup', () => {
    if (siteDrag) {
      const { site, moved } = siteDrag;
      const nx = clamp(siteDrag.x / W, 0, 1), ny = clamp(siteDrag.y / H, 0, 1);
      siteDrag = null;
      if (moved) {
        suppressClick = true;
        if (site.custom) {
          const s = (map.sites || []).find((o) => customKey(o) === site.key);
          if (s) { s.x = nx; s.y = ny; }
        } else {
          (map.siteEdits ??= {})[site.key] = { ...(map.siteEdits?.[site.key] || {}), x: nx, y: ny };
        }
        rebuild();
        save();
        refreshLists();
      } else {
        redraw();
      }
    }
    if (drawingPath) {
      const pts = drawingPath.pts;
      if (pts.length < 3) {
        map.paths = map.paths.filter((x) => x !== drawingPath); // stray click
      } else {
        // strokes that end near their start close into a loop; borders tint it
        const [sx, sy] = pts[0], [ex, ey] = pts[pts.length - 1];
        if (pts.length > 6 && Math.hypot((ex - sx) * W, (ey - sy) * H) < 18) {
          drawingPath.closed = true;
          if (drawingPath.style === 'border') drawingPath.fill = true;
        }
        selected = drawingPath.id;
        save();
      }
      drawingPath = null;
      redraw(); refreshLists();
    }
    const brushed=painting&&kind.paint==='brush';
    const painted=painting;
    dragging = null; painting = false; lastPaint = null;
    if(brushed&&map.params?.generation==='1.8'){rebuild();refreshLists();}
    else if(painted){refreshKeys();redraw();} // a repainted room can unplace its note
    history.end();syncHistory();
  });
  canvas.addEventListener('pointercancel',()=>{dragging=null;painting=false;drawingPath=null;siteDrag=null;history.end();syncHistory();save();redraw();});

  // double-click a linked marker/stamp to open its entry (works in player view too)
  canvas.addEventListener('dblclick', (ev) => {
    const hitRes = hitOverlay(pos(ev));
    const obj = (hitRes?.list === 'markers' || hitRes?.list === 'stamps') ? hitRes.obj : null;
    if (obj?.to && getEntity(obj.to)) location.hash = `#/e/${obj.to}`;
  });
  // Generated atlas/region sites are real navigation targets too. A linked
  // site opens on one click; the first GM click explicitly offers to create
  // and persist a normal Location with its own town or region map.
  canvas.addEventListener('click', (ev) => {
    if (suppressClick) { suppressClick = false; return; }
    if (tool !== 'move' || pendingAdd) return;
    const p = pos(ev);
    if (hitOverlay(p)) return;
    const sh = hitSite(p);
    if (sh) void openSite(sh.site);
  });
  canvas.addEventListener('mousemove', (ev) => {
    if (painting || dragging || siteDrag || pendingAdd) return;
    if (!readOnly && tool !== 'move') return; // brush/marker tools keep their crosshair
    const p = pos(ev);
    const hitRes = hitOverlay(p);
    const sh = !hitRes ? hitSite(p) : null;
    const siteClickable = sh && (state.gm || linkedSite(sh.site));
    canvas.style.cursor = hitRes?.obj?.to || siteClickable ? 'pointer' : 'default';
  });

  function placePendingSite(p) {
    const add = pendingAdd;
    pendingAdd = null;
    suppressClick = true;
    canvas.style.cursor = 'default';
    const noun = add.kind === 'region' ? 'region'
      : add.townSize === 2 ? 'village'
        : add.townSize === 3 ? 'town' : 'city';
    const name = prompt(`Name the new ${noun}:`, randomName(add.kind === 'region' ? 'region' : 'settlement'));
    if (!name?.trim()) { refreshLists(); return; }
    const site = { id: uid(), kind: add.kind, name: name.trim(), x: clamp(p.x / W, 0, 1), y: clamp(p.y / H, 0, 1) };
    if (add.kind !== 'region') {
      site.size = add.size;
      site.townSize = add.townSize;
    }
    (map.sites ??= []).push(site);
    rebuild();
    save();
    refreshLists();
  }

  const onKey = (ev) => {
    if((ev.ctrlKey||ev.metaKey)&&!readOnly&&!/INPUT|TEXTAREA|SELECT/.test(ev.target.tagName)) {
      if(ev.key.toLowerCase()==='z'){ev.preventDefault();restoreHistory(ev.shiftKey?'redo':'undo');return;}
      if(ev.key.toLowerCase()==='y'){ev.preventDefault();restoreHistory('redo');return;}
    }
    if (ev.key === 'Escape' && pendingAdd) {
      pendingAdd = null;
      canvas.style.cursor = 'default';
      refreshLists();
    }
    if (ev.key === 'Delete' && selected && !readOnly) {
      map.markers = (map.markers || []).filter((m) => m.id !== selected);
      map.labels = (map.labels || []).filter((l) => l.id !== selected);
      map.stamps = (map.stamps || []).filter((s) => s.id !== selected);
      map.paths = (map.paths || []).filter((pa) => pa.id !== selected);
      selected = null;
      save(); redraw(); refreshLists();
    }
  };
  window.addEventListener('keydown', onKey);

  // ---------- panel ----------
  const panel = el('div', { class: 'mapedit-panel' });

  function toolBtn(name, label, title) {
    return el('button', {
      class: tool === name ? 'on' : '', title: title || '',
      onclick: (ev) => {
        tool = name;
        panel.querySelectorAll('.tool-row button').forEach((b) => b.classList.remove('on'));
        ev.target.classList.add('on');
        canvas.style.cursor = name === 'move' ? 'default' : 'crosshair';
        markerOptsRow.style.display = name === 'marker' ? '' : 'none';
        labelOptsRow.style.display = name === 'label' ? '' : 'none';
        brushOptsRow.style.display = (kind.paint === 'brush' && (kind.tools || []).some((t) => t.name === name)) ? '' : 'none';
        stampOptsRow.style.display = name === 'stamp' ? '' : 'none';
        drawOptsRow.style.display = name === 'draw' ? '' : 'none';
      },
    }, label);
  }

  function paramRow(label, input) {
    return el('div', { class: 'param-row' }, el('label', {}, label), input);
  }
  function slider(value, min, max, step, oninput, onchange = null) {
    // min/max/step must be set before value, or the browser snaps value to the default step
    return el('input', {
      type: 'range', min, max, step, value,
      oninput: (ev) => oninput(Number(ev.target.value)),
      onchange: onchange ? (ev) => onchange(Number(ev.target.value)) : null,
    });
  }

  const p = map.params;

  function confirmDiscardGrid() {
    if (kind.gridKind && (map.grid || (map.grids || []).some(Boolean))) {
      if (!confirm('This regenerates the layout and discards your painted edits. Continue?')) return false;
      map.grid = null;
      map.grids = null;
    }
    return true;
  }

  const generatedRecordCount = (records, prefixes = null) => Object.keys(records || {})
    .filter((key) => !key.startsWith('custom:')
      && (!prefixes || prefixes.some((prefix) => key.startsWith(prefix)))).length;
  function confirmGeneratedSiteChange(subject, prefixes = null) {
    if (readOnly) return false;
    const links = generatedRecordCount(map.scaleLinks, prefixes);
    const edits = generatedRecordCount(map.siteEdits, prefixes);
    if (!links && !edits) return true;
    const linkWord = links === 1 ? 'link' : 'links';
    const editWord = edits === 1 ? 'edit' : 'edits';
    return confirm(`${subject} can orphan ${links} ${linkWord} and ${edits} site ${editWord}. Continue?`);
  }

  const seedInput = el('input', { type: 'text', value: map.seed, style: 'width:110px', disabled: readOnly });
  async function commitSeed(next, force = false) {
    if (readOnly) return;
    const value = String(next);
    const changedSeed = value !== String(map.seed);
    if (!changedSeed && !force) return;
    const candidate=structuredClone(map);candidate.seed=value;
    if(kind.gridKind){candidate.grid=null;candidate.grids=null;}
    await showGenerationPreview(candidate,'Regenerate map');seedInput.value=map.seed;
  }

  // generic param rows from the kind's declarative schema (see mapcore.js)
  const paramSection = el('div', {});
  const paramRowEls = [];
  const syncParamRows = () => {
    for (const { spec, row, input } of paramRowEls) {
      row.style.display = !spec.show || spec.show(p) ? '' : 'none';
      if(input.type==='checkbox')input.checked=!!(p[spec.key]??spec.absent);else input.value=String(p[spec.key]??spec.absent);
    }
  };
  for (const spec of kind.params || []) {
    const cur = () => p[spec.key] ?? spec.absent;
    // params can add/remove/rename generated sites — the site rows must not
    // keep serving stale closures after the model changed under them
    const changed = () => { syncParamRows(); rebuild(); save(); refreshLists(); };
    const commit = async (value, restore) => {
      if (readOnly) { restore(); return; }
      if (Object.is(value, cur())) { restore(); return; }
      // settings that draw nothing (spec.noRebuild) save without rebuilding the map
      if (spec.noRebuild) {
        if (Object.is(value, spec.absent)) delete p[spec.key]; else p[spec.key] = value;
        restore(); syncParamRows(); save();
        return;
      }
      if(spec.preview){
        const candidate=structuredClone(map);candidate.params[spec.key]=value;
        if(spec.confirmGrid){candidate.grid=null;candidate.grids=null;}
        restore();await showGenerationPreview(candidate,`Preview ${spec.label.toLowerCase()}`,spec.regeneratesSites);restore();return;
      }
      if (spec.regeneratesSites
          && !confirmGeneratedSiteChange(`Changing ${spec.label.toLowerCase()}`, spec.regeneratesSites)) {
        restore();
        return;
      }
      if (spec.confirmGrid && !confirmDiscardGrid()) {
        restore();
        return;
      }
      p[spec.key] = value;
      restore();
      changed();
    };
    let input;
    if (spec.type === 'slider') {
      if (spec.regeneratesSites || spec.preview) {
        input = slider(cur(), spec.min, spec.max, spec.step, () => {}, (v) => {
          commit(v, () => { input.value = cur(); });
        });
      } else {
        input = slider(cur(), spec.min, spec.max, spec.step, (v) => {
          commit(v, () => { input.value = cur(); });
        });
      }
    } else if (spec.type === 'checkbox') {
      input = el('input', {
        type: 'checkbox', checked: !!cur(),
        onchange: (ev) => {
          commit(ev.target.checked, () => { ev.target.checked = !!cur(); });
        },
      });
    } else if (spec.type === 'number') {
      input = el('input', {
        type: 'number', min: spec.min, max: spec.max, value: cur(), style: 'width:70px',
        onchange: (ev) => {
          const value = clamp(Number(ev.target.value), spec.min, spec.max);
          commit(value, () => { ev.target.value = cur(); });
        },
      });
    } else { // select
      const options = typeof spec.options === 'function' ? spec.options() : spec.options;
      input = el('select', {
        onchange: (ev) => {
          const value = spec.numeric ? Number(ev.target.value) : ev.target.value;
          commit(value, () => { ev.target.value = String(cur()); });
        },
      }, Object.entries(options).map(([v, l]) =>
        el('option', { value: v, selected: String(v) === String(cur()) }, l)));
    }
    if (spec.title) input.title = spec.title;
    input.disabled = readOnly;
    const row = paramRow(spec.label, input);
    paramRowEls.push({ spec, row, input });
    paramSection.append(row);
  }
  syncParamRows();

  function restoreHistory(direction) {
    if(readOnly||state.worldId!==originWorld||previewController)return;
    if(!history[direction]())return;
    selected=null;seedInput.value=map.seed;syncParamRows();rebuild();refreshLists();syncHistory();scheduleSave(e);
  }
  async function showGenerationPreview(candidate,title,prefixes=null) {
    if(readOnly||previewController||state.worldId!==originWorld)return false;
    const original=JSON.stringify(map),controller=new AbortController();previewController=controller;
    const before=el('canvas',{'aria-label':'Current map'}),after=el('canvas',{'aria-label':'Proposed map'});
    renderMap(before,map,{gm:state.gm,model,level,hiddenLinkIds});
    const progress=el('p',{class:'muted',role:'status'},'Generating a local preview…');
    const apply=el('button',{class:'primary',disabled:true},'Apply this map');
    const cancel=el('button',{},'Keep current map');
    const links=generatedRecordCount(map.scaleLinks,prefixes),edits=generatedRecordCount(map.siteEdits,prefixes);
    const painted=!!(map.grid||map.grids?.some(Boolean))&&!candidate.grid&&!candidate.grids?.some(Boolean);
    const dialog=el('dialog',{class:'map-generation-dialog','aria-label':title},
      el('h2',{},title),el('p',{},'Compare the result before applying. Your placed objects, terrain strokes, custom sites and linked entries are retained.'),
      links||edits?el('div',{class:'notice warn'},`${links} generated-site links and ${edits} generated-site edits may no longer match this layout. Their records stay available for repair.`):null,
      painted?el('div',{class:'notice warn'},'Applying replaces the painted floor layout. Undo can restore it.'):null,
      el('div',{class:'map-generation-compare'},el('figure',{},el('figcaption',{},'Current'),before),el('figure',{},el('figcaption',{},'Preview'),after)),
      progress,el('div',{class:'row'},cancel,apply));
    document.body.append(dialog);dialog.showModal();
    return await new Promise(resolve=>{
      let finished=false;
      const close=accepted=>{if(finished)return;finished=true;controller.abort();dialog.close();dialog.remove();previewController=null;resolve(accepted);};
      cancel.onclick=()=>close(false);dialog.addEventListener('cancel',event=>{event.preventDefault();close(false);});
      controller.signal.addEventListener('abort',()=>close(false),{once:true});
      apply.onclick=()=>{
        if(state.worldId!==originWorld||getEntity(id)!==e||JSON.stringify(map)!==original){toast('The map changed while this preview was open. Generate a fresh preview.');close(false);return;}
        replaceMapData(map,candidate);seedInput.value=map.seed;syncParamRows();rebuild();save();refreshLists();close(true);
      };
      const previewLevel=Math.min(level,(kind.levelCount?.(candidate)||1)-1);
      previewModel(candidate,kind,{signal:controller.signal,level:previewLevel,onProgress:p=>{progress.textContent=p<1?'Generating geography…':'Drawing the preview…';}}).then(nextModel=>{
        if(finished)return;renderMap(after,candidate,{gm:state.gm,model:nextModel,level:previewLevel,hiddenLinkIds});progress.textContent='Preview ready. Nothing changes until you apply.';apply.disabled=false;
      }).catch(error=>{if(error.name==='AbortError')return;progress.textContent=`Could not generate the preview: ${error.message}`;});
    });
  }
  const undoButton=el('button',{disabled:true,onclick:()=>restoreHistory('undo'),title:'Undo map edit (Ctrl+Z)'},'↶ Undo');
  const redoButton=el('button',{disabled:true,onclick:()=>restoreHistory('redo'),title:'Redo map edit (Ctrl+Shift+Z)'},'↷ Redo');
  syncHistory=()=>{undoButton.disabled=readOnly||!history.canUndo;redoButton.disabled=readOnly||!history.canRedo;};
  const layerControls=el('details',{class:'map-editor-layers'},el('summary',{},'Visible editing layers'),el('p',{class:'muted small'},'These switches affect this editor only. Exports use your normal GM/player visibility.'),
    Object.entries({base:'Generated map',markers:'Markers',stamps:'Placed objects',paths:'Drawings',labels:'Labels'}).map(([key,label])=>el('label',{},el('input',{type:'checkbox',checked:true,onchange:ev=>{layers[key]=ev.target.checked;selected=null;redraw();}}),label)));

  // tools per kind, from the registry
  const toolRow = el('div', { class: 'tool-row' }, toolBtn('move', '✋ Move', 'Select and drag markers/labels'));
  for (const t of kind.tools || []) toolRow.append(toolBtn(t.name, t.label, t.title));
  toolRow.append(
    toolBtn('stamp', '🏰 Place', 'Place a building or landmark: houses, castles, cities, forests…'),
    toolBtn('draw', '✏️ Draw', 'Draw roads, rivers, borders, travel routes and walls'),
    toolBtn('marker', '📍 Marker'),
    toolBtn('label', '🔤 Label'));
  const keyToolBtn = kind.keys && state.gm ? toolBtn('key', '🗝 Key', 'Click a room, settlement, landmark or hex to add a GM note') : null;
  if (keyToolBtn) toolRow.append(keyToolBtn);
  toolRow.querySelector('button').classList.add('on');
  if (keyToolBtn) {
    keyPanel = mapKeyPanel({
      e, map, kind, model: () => model, level: () => level, save, redraw, locationType: locationTypeKey,
      useKeyTool: () => keyToolBtn.click(),
    });
    refreshKeys = () => keyPanel.refresh();
    refreshKeys();
  }
  if (kind.populate && state.gm) {
    const pop = populatePanel({
      e, map, kind, model: () => model, save, redraw, refreshLists: () => refreshLists(),
      locationType: locationTypeKey, personType: personTypeKey,
    });
    refreshPopulate = () => {
      if (canPopulate(model)) { pop.refresh(); populateWrap.replaceChildren(pop.element); } else populateWrap.replaceChildren();
    };
    refreshPopulate();
  }
  if (kind.journeys && state.gm) journeys = journeyPanel({ e, map, kind, model: () => model, save, redraw });

  const brushOptsRow = el('div', { style: 'display:none' },
    paramRow('Brush size', slider(brush.r, 0.015, 0.12, 0.005, (v) => { brush.r = v; })),
    paramRow('Strength', slider(brush.strength, 0.03, 0.2, 0.01, (v) => { brush.strength = v; })));

  const markerOptsRow = el('div', { style: 'display:none' },
    paramRow('Shape', el('select', { onchange: (ev) => { markerOpts.shape = ev.target.value; } },
      MARKER_SHAPES.map((s) => el('option', { value: s }, s)))),
    paramRow('Color', el('div', { class: 'row', style: 'gap:4px' },
      MARKER_COLORS.map((c) => el('button', {
        class: 'legend-swatch', style: `background:${c};width:20px;height:20px;padding:0;border:2px solid transparent`,
        onclick: (ev) => {
          markerOpts.color = c;
          markerOptsRow.querySelectorAll('.legend-swatch').forEach((b) => b.style.borderColor = 'transparent');
          ev.target.style.borderColor = '#fff';
        },
      })))),
    paramRow('🔒 Secret', el('input', {
      type: 'checkbox', title: 'Secret markers are only visible in GM view and GM exports (traps, hidden doors, ambushes…)',
      onchange: (ev) => { markerOpts.secret = ev.target.checked; },
    })));

  const labelOptsRow = el('div', { style: 'display:none' },
    paramRow('Size', el('select', { onchange: (ev) => { labelSize = Number(ev.target.value); } },
      [[16, 'Small'], [24, 'Medium'], [34, 'Large'], [48, 'Huge (region)']].map(([v, l]) => el('option', { value: v, selected: v === 24 }, l)))));

  function swatchRow(colors, get, set) {
    const wrap = el('div', { class: 'row', style: 'gap:4px' },
      el('button', {
        class: 'ghost small', title: 'Use the default color', style: 'padding:0 6px',
        onclick: (ev) => {
          set('');
          wrap.querySelectorAll('.legend-swatch').forEach((b) => b.style.borderColor = 'transparent');
        },
      }, '↺'),
      colors.map((c) => el('button', {
        class: 'legend-swatch', style: `background:${c};width:20px;height:20px;padding:0;border:2px solid ${get() === c ? '#fff' : 'transparent'}`,
        onclick: (ev) => {
          set(c);
          wrap.querySelectorAll('.legend-swatch').forEach((b) => b.style.borderColor = 'transparent');
          ev.target.style.borderColor = '#fff';
        },
      })));
    return wrap;
  }

  const stampOptsRow = el('div', { style: 'display:none' },
    paramRow('Stamp', el('select', { onchange: (ev) => { stampOpts.kind = ev.target.value; } },
      stampChoices.map((v) => el('option', { value: v, selected: v === stampOpts.kind }, STAMP_KINDS[v])))),
    paramRow('Size', slider(stampOpts.size, 0.6, 2.4, 0.1, (v) => { stampOpts.size = v; })),
    paramRow('Color', swatchRow(STAMP_COLORS, () => stampOpts.color, (c) => { stampOpts.color = c; })),
    paramRow('🔒 Secret', el('input', {
      type: 'checkbox', title: 'Secret stamps are only visible in GM view and GM exports (the hidden fortress…)',
      onchange: (ev) => { stampOpts.secret = ev.target.checked; },
    })));

  const drawOptsRow = el('div', { style: 'display:none' },
    paramRow('Style', el('select', {
      title: 'End a border stroke near its start to close it into a tinted territory',
      onchange: (ev) => { drawOpts.style = ev.target.value; },
    }, Object.entries(PATH_STYLES).map(([v, s]) => el('option', { value: v, selected: v === drawOpts.style }, s.label)))),
    paramRow('Color', swatchRow([...new Set([...Object.values(PATH_STYLES).map((s) => s.color), '#e0a72c', '#4a9e6f'])],
      () => drawOpts.color, (c) => { drawOpts.color = c; })),
    paramRow('Width', slider(6, 2, 14, 1, (v) => { drawOpts.width = v; })),
    paramRow('🔒 Secret', el('input', {
      type: 'checkbox', title: 'Secret drawings never appear to players, such as a true border or smugglers’ route.',
      onchange: (ev) => { drawOpts.secret = ev.target.checked; },
    })));

  // marker & label lists
  const rebuildSoon = debounce(() => rebuild(), 450); // renames re-render calmly
  const listsWrap = el('div', {});
  function refreshLists() {
    listsWrap.innerHTML = '';
    // Player preview must hide secret overlay items here too, not just on the
    // canvas. drawOverlay and hitOverlay apply the same rule, including links
    // to GM-only entries.
    const shown = (list) => (list || []).filter((o) => !overlayHidden(o) && onLevel(o));
    const linkables = visibleEntities()
      .filter((x) => x.id !== e.id)
      .sort((a, b) => a.name.localeCompare(b.name));
    const linkSelect = (obj) => el('select', {
      title: 'Link to an entry. Double-click the item on the map to open it. Linked items appear in that entry’s backlinks and in the PDF map key.',
      disabled: readOnly,
      onchange: (ev) => {
        obj.to = ev.target.value || null;
        const target = obj.to ? getEntity(obj.to) : null;
        if (target && !(obj.label || '').trim()) obj.label = target.name;
        save(); redraw(); refreshLists();
      },
    },
      el('option', { value: '' }, '— link —'),
      linkables.map((x) => el('option', { value: x.id, selected: x.id === obj.to }, x.name)));
    const secretBtn = (obj) => el('button', {
      class: 'ghost', title: obj.secret ? 'Secret (GM only). Click to reveal it to players.' : 'Visible to players. Click to make it secret.',
      disabled: readOnly,
      style: obj.secret ? 'color:var(--accent)' : 'opacity:.45',
      onclick: async () => {
        if (obj.secret) {
          // revealing asks which session to log it on (1.9); hiding doesn't
          const list = ['markers', 'stamps', 'paths'].find((l) => (map[l] || []).includes(obj));
          obj.id ??= uid();
          if (!list || !(await confirmReveal(e, { kind: 'overlay', list, ref: obj.id }))) return;
        } else obj.secret = true;
        save(); redraw(); refreshLists();
      },
    }, '🔒');
    const deleteBtn = (list, obj) => el('button', {
      class: 'ghost', disabled: readOnly, onclick: () => {
        map[list] = map[list].filter((o) => o.id !== obj.id);
        if (selected === obj.id) selected = null;
        save(); redraw(); refreshLists();
      },
    }, '✕');

    // ---- regions & settlements: generated sites + everything the user added ----
    // GM rows rename in place (blank returns to the generated name), open or
    // create the linked map one scale down, and hide/remove sites. Players see
    // only linked, non-secret sites — exactly what the canvas offers them.
    const siteKinds = new Set(kind.siteKinds || []);
    const renameSite = (site, value) => {
      // keep the row's own site object current too — a Create click right
      // after typing must not resurrect the pre-rename name
      site.name = value;
      if (site.custom) {
        const s = (map.sites || []).find((o) => customKey(o) === site.key);
        if (s) s.name = value;
      } else {
        (map.siteEdits ??= {})[site.key] = { ...(map.siteEdits?.[site.key] || {}), name: value };
      }
      save();
      rebuildSoon();
    };
    // Renaming a linked site offers to carry the name across the link — asked
    // once when the edit is finished (change), never per keystroke. Declining
    // keeps the two names deliberately diverged, and we never ask again unless
    // the site is renamed again. A carried rename is a REAL entity rename, so
    // it must offer the [[wiki-link]] rewrite exactly like the entity page.
    const syncSiteRename = async (site, value) => {
      const name = value.trim();
      const linked = site.kind === 'landmark' ? null : linkedSite(site);
      let target = linked?.id === e.id ? e : linked;
      if (!name || !target || target.name.trim() === name) return;
      const promptName = target.name.trim();
      if (!confirm(`Also rename the linked entry “${promptName}” to “${name}”?`)) return;
      // Finish any saves left by a recently closed view, then reacquire the
      // target so a stale debounced object cannot overwrite this rename.
      await flushSaves();
      const currentLinked = linkedSite(site);
      target = currentLinked?.id === e.id ? e : currentLinked;
      if (!target || target.name.trim() === name) return;
      const oldName = target.name.trim();
      target.name = name;
      const entities = [...state.entities.values()].map((src) => src.id === e.id ? e : src);
      const plan = planWikiRenames(oldName, name, entities);
      if (target.map?.kind === 'region' && (target.map.params?.title || '').trim() === oldName.trim()) {
        target.map.params.title = name;
      }
      await saveEntity(target);
      // carry the name to every other map that tracks the same entry (and up
      // to the parent world map when this site was inherited from it)
      const syncedMaps = syncLinkedSiteNames(entities, target.id, name,
        (id) => id === e.id ? e : getEntity(id), oldName);
      for (const src of syncedMaps) {
        if (src.id === e.id) save();
        else await saveEntity(src);
      }
      if (plan && confirm(`Also update ${plan.total} [[link${plan.total === 1 ? '' : 's'}]] to “${oldName}” in ${plan.entries} ${plan.entries === 1 ? 'entry' : 'entries'}?`)) {
        await plan.apply();
      }
      toast(`Renamed ${oldName} → ${name}`);
      refreshLists();
    };
    const queueSiteRename = (site, value) => {
      const capturedValue = String(value || '');
      siteRenameQueue = siteRenameQueue.then(() => syncSiteRename(site, capturedValue)).catch((err) => {
        console.error('linked site rename failed', err);
        toast('The site name was saved, but its linked entry could not be updated.');
      });
      return siteRenameQueue;
    };
    const removeSite = (site) => {
      if (site.custom && !site.inherited) {
        map.sites = (map.sites || []).filter((o) => customKey(o) !== site.key);
        if (map.scaleLinks) delete map.scaleLinks[site.key];
      } else {
        // generated AND inherited sites soft-hide with a restore row —
        // inherited ones carry seat/townSeed/origin provenance that a
        // hard delete could never reconstruct
        (map.siteEdits ??= {})[site.key] = { ...(map.siteEdits?.[site.key] || {}), hidden: true, name: site.name };
      }
      save(); rebuild(); refreshLists();
    };
    const siteRow = (site) => {
      const target = site.kind === 'landmark' ? null : linkedSite(site);
      const broken = site.kind === 'landmark' ? null : brokenSiteLink(site);
      const drill = drillKindOf(site);
      const repairTargets = broken ? [...state.entities.values()]
        .filter((candidate) => candidate.id !== e.id && candidate.map?.kind === drill)
        .sort((a, b) => a.name.localeCompare(b.name)) : [];
      if (!state.gm) {
        return el('div', { class: 'mk-row' },
          el('span', { style: 'flex:1;font-size:12.5px' }, site.name),
          el('button', {
            class: 'ghost small', title: `Open ${target.name}'s ${drill} map`,
            onclick: () => { void openSite(site); },
          }, `Open ${drill}`));
      }
      return el('div', { class: 'mk-row' },
        el('input', {
          type: 'text', value: site.name,
          title: 'Rename this site. Leave it blank to use the generated name.',
          oninput: (ev) => renameSite(site, ev.target.value),
          onchange: (ev) => { void queueSiteRename(site, ev.target.value); },
        }),
        broken ? el('select', {
          title: broken.reason === 'deleted'
            ? `${site.name} was linked to a deleted entry. Choose another ${drill} map.`
            : `Choose another ${drill} map for ${site.name}.`,
          onchange: (ev) => {
            const chosen = getEntity(ev.target.value);
            ev.target.value = '';
            if (chosen) void relinkSite(site, chosen);
          },
        },
          el('option', { value: '' }, repairTargets.length ? 'Relink to…' : 'No maps to relink'),
          repairTargets.map((candidate) => el('option', { value: candidate.id }, candidate.name))) : null,
        site.kind === 'landmark' ? null : el('button', {
          class: 'ghost small',
          title: target
            ? `Open ${target.name}'s ${drill} map`
            : broken
              ? `This link is broken. Relink ${site.name} or create a replacement.`
              : `Create a Location and ${drill} map for ${site.name}`,
          onclick: () => { void openSite(site); },
        }, target ? `Open ${drill}` : broken ? `Recreate ${drill}` : `Create ${drill}`),
        el('button', {
          class: 'ghost',
          title: site.custom && !site.inherited ? 'Remove this added site' : 'Hide this site (restore below)',
          onclick: () => removeSite(site),
        }, '✕'));
    };
    const hiddenRow = ([key, edit]) => el('div', { class: 'mk-row' },
      el('span', { style: 'flex:1;font-size:12.5px;opacity:.55;text-decoration:line-through' }, edit.name || key),
      el('button', {
        class: 'ghost', title: 'Restore this generated site',
        onclick: () => {
          delete map.siteEdits[key].hidden;
          save(); rebuild(); refreshLists();
        },
      }, '↺'));
    const siteSection = (title, sites, hidden, addButtons) => {
      const shown = state.gm ? sites : sites.filter((site) => site.kind !== 'landmark' && linkedSite(site));
      if (!shown.length && !hidden.length && !addButtons?.length) return;
      listsWrap.append(el('h3', {}, title));
      const list = el('div', { class: 'marker-list' });
      for (const site of shown) list.append(siteRow(site));
      if (state.gm) for (const entry of hidden) list.append(hiddenRow(entry));
      listsWrap.append(list);
      if (addButtons?.length) listsWrap.append(el('div', { class: 'tool-row', style: 'margin-top:4px' }, addButtons));
    };
    const addBtn = (label, title, add) => el('button', {
      class: 'ghost small',
      title,
      onclick: () => {
        pendingAdd = add;
        canvas.style.cursor = 'crosshair';
        toast('Click the map to place it (Esc cancels)');
      },
    }, label);
    if (siteKinds.size) {
      const hiddenEntries = state.gm
        ? Object.entries(map.siteEdits || {}).filter(([, edit]) => edit?.hidden)
        : [];
      const canAdd = state.gm && !readOnly;
      if (siteKinds.has('region')) {
        siteSection('Regions', currentRegions(),
          hiddenEntries.filter(([key]) => key.startsWith('nation:')),
          canAdd ? [addBtn('+ Region', 'Click the map to place a region seat. You can then open its region map.', { kind: 'region' })] : []);
      }
      if (siteKinds.has('settlement')) {
        siteSection('Settlements', currentSettlements(),
          hiddenEntries.filter(([key]) => key.startsWith('world:') || key.startsWith('region:') || key.startsWith('custom:inh-')),
          canAdd ? [
            addBtn('+ Village', 'Click the map to place a village.', { kind: 'settlement', size: 2, townSize: 2 }),
            addBtn('+ Town', 'Click the map to place a town.', { kind: 'settlement', size: 2, townSize: 3 }),
            addBtn('+ City', 'Click the map to place a city.', { kind: 'settlement', size: 3, townSize: 4 }),
          ] : []);
      }
      if (siteKinds.has('landmark') && state.gm) {
        siteSection('Landmarks',
          (model?.landmarks || []).map((lm) => ({ key: lm.key, name: lm.name, kind: 'landmark', custom: false })),
          hiddenEntries.filter(([key]) => key.startsWith('landmark:')), []);
      }
    }

    if (shown(map.markers).length) {
      listsWrap.append(el('h3', {}, 'Markers'));
      const ml = el('div', { class: 'marker-list' });
      for (const mk of shown(map.markers)) {
        ml.append(el('div', { class: 'mk-row', style: selected === mk.id ? 'outline:1px dashed #7fd7ff;border-radius:4px' : '' },
          el('span', { class: 'legend-swatch', style: `background:${mk.color}` }),
          el('input', {
            type: 'text', value: mk.label, placeholder: '(no label)',
            disabled: readOnly,
            oninput: (ev) => { mk.label = ev.target.value; save(); redraw(); },
            onfocus: () => { selected = mk.id; redraw(); },
          }),
          linkSelect(mk), secretBtn(mk), deleteBtn('markers', mk)));
      }
      listsWrap.append(ml);
    }
    if (shown(map.stamps).length) {
      listsWrap.append(el('h3', {}, 'Placed things'));
      const sl = el('div', { class: 'marker-list' });
      for (const s of shown(map.stamps)) {
        sl.append(el('div', { class: 'mk-row', style: selected === s.id ? 'outline:1px dashed #7fd7ff;border-radius:4px' : '' },
          el('span', { class: 'legend-swatch', style: `background:${s.color}` }),
          el('input', {
            type: 'text', value: s.label || '', placeholder: `(${STAMP_KINDS[s.kind] || s.kind})`,
            disabled: readOnly,
            oninput: (ev) => { s.label = ev.target.value; save(); redraw(); },
            onfocus: () => { selected = s.id; redraw(); },
          }),
          linkSelect(s), secretBtn(s), deleteBtn('stamps', s)));
      }
      listsWrap.append(sl);
    }
    if ((map.labels || []).filter(onLevel).length) {
      listsWrap.append(el('h3', {}, 'Labels'));
      const ll = el('div', { class: 'marker-list' });
      for (const lb of (map.labels || []).filter(onLevel)) {
        ll.append(el('div', { class: 'mk-row', style: selected === lb.id ? 'outline:1px dashed #7fd7ff;border-radius:4px' : '' },
          el('input', {
            type: 'text', value: lb.text,
            disabled: readOnly,
            oninput: (ev) => { lb.text = ev.target.value; save(); redraw(); },
            onfocus: () => { selected = lb.id; redraw(); },
          }),
          el('select', {
            disabled: readOnly,
            onchange: (ev) => { lb.size = Number(ev.target.value); save(); redraw(); },
          }, [[16, 'S'], [24, 'M'], [34, 'L'], [48, 'XL']].map(([v, l]) => el('option', { value: v, selected: Number(v) === lb.size }, l))),
          deleteBtn('labels', lb)));
      }
      listsWrap.append(ll);
    }
    if (shown(map.paths).length) {
      listsWrap.append(el('h3', {}, 'Drawings'));
      const pl = el('div', { class: 'marker-list' });
      for (const pa of shown(map.paths)) {
        pl.append(el('div', { class: 'mk-row', style: selected === pa.id ? 'outline:1px dashed #7fd7ff;border-radius:4px' : '' },
          el('span', {
            class: 'legend-swatch', style: `background:${pa.color};cursor:pointer`,
            title: 'Select this drawing',
            onclick: () => { selected = pa.id; redraw(); refreshLists(); },
          }),
          el('span', { style: 'flex:1;font-size:12.5px' },
            (PATH_STYLES[pa.style]?.label || pa.style) + (pa.closed ? ' (closed)' : '')),
          pa.closed && pa.style === 'border' ? el('label', {
            class: 'rel-secret', title: 'Tint the enclosed territory with the border color',
          },
            el('input', {
              type: 'checkbox', checked: !!pa.fill, disabled: readOnly,
              onchange: (ev) => { pa.fill = ev.target.checked; save(); redraw(); },
            }), 'fill') : null,
          secretBtn(pa), deleteBtn('paths', pa)));
      }
      listsWrap.append(pl);
    }
  }
  refreshLists();

  let exportScale = 2; // print-friendly default; 1× matches the screen
  let playerRoomNumbers = false; // an export-time choice for player images, never stored
  let imageExport=null;
  const imageProgress=el('div',{class:'muted small',role:'status'}),imageCancel=el('button',{class:'ghost small',hidden:true,onclick:()=>imageExport?.abort()},'Cancel export');

  async function exportPng(gm) {
    if(imageExport||gm&&!state.gm||state.worldId!==originWorld)return;
    const controller=new AbortController();imageExport=controller;imageCancel.hidden=false;
    const valid=()=>!controller.signal.aborted&&state.worldId===originWorld&&canvas.isConnected&&(!gm||state.gm);
    try{
      imageProgress.textContent='Saving current edits…';await requireSaved();if(!valid())return;
      const draft=structuredClone(map),floor=level,scale=exportScale,snapshot=JSON.stringify([...state.entities]);
      imageProgress.textContent='Preparing image…';await new Promise(r=>setTimeout(r,30));if(!valid())return;
      const next=await previewModel(draft,kind,{signal:controller.signal,level:floor});if(!valid())return;
      imageProgress.textContent='Drawing print resolution…';await new Promise(r=>setTimeout(r,0));if(!valid())return;
      const out=el('canvas');renderMap(out,draft,{gm,scale,level:floor,model:next,roomNumbers:playerRoomNumbers,hiddenLinkIds:hiddenOverlayLinkIds(draft,state.entities.values())});
      imageProgress.textContent='Encoding PNG…';const blob=await new Promise(resolve=>out.toBlob(resolve,'image/png'));if(!valid())return;
      if(!blob)throw Error('The browser could not encode this image. Try a lower resolution.');
      if(snapshot!==JSON.stringify([...state.entities]))throw Error('Content changed during export. Export again to use its current visibility.');
      const suffix=(gm?'gm':'player')+(scale>1?`@${scale}x`:''),floorName=(kind.levelCount?.(draft)||1)>1?`-L${floor+1}`:'';
      const name=`${e.name.replace(/\W+/g,'-').toLowerCase()}-map${floorName}-${suffix}.png`;
      downloadBlob(blob,name);imageProgress.textContent='PNG downloaded.';
      const b64=await blobToBase64(blob);if(!valid())return;
      try{const res=await api.exportFile(name,b64,originWorld);if(valid())imageProgress.textContent=`Also saved to ${res.path}`;}catch{if(valid())imageProgress.textContent='PNG downloaded; the server copy could not be saved.';}
    }catch(err){if(canvas.isConnected)imageProgress.textContent=err.name==='AbortError'?'Export cancelled.':err.message;}
    finally{if(controller.signal.aborted&&canvas.isConnected)imageProgress.textContent='Export cancelled.';imageExport=null;imageCancel.hidden=true;}
  }

  async function exportUvtt(gm) {
    const out = el('canvas');
    renderMap(out, map, { gm, scale: exportScale, level, roomNumbers: playerRoomNumbers, hiddenLinkIds });
    const imageBase64 = out.toDataURL('image/png').split(',')[1];
    const text = universalVttText(map, imageBase64, {
      gm, level, scale: exportScale, model,
    });
    const floor = (kind.levelCount ? kind.levelCount(map) : 1) > 1 ? `-L${level + 1}` : '';
    const edition = gm ? 'gm' : 'player';
    const name = `${e.name.replace(/\W+/g, '-').toLowerCase()}-map${floor}-${edition}.uvtt`;
    const blob = new Blob([text], { type: 'application/json' });
    downloadBlob(blob, name);
    try {
      const res = await api.exportFile(name, await blobToBase64(blob));
      toast(`Saved UVTT to ${res.path}`);
    } catch {
      toast('Downloaded UVTT (server copy failed)');
    }
  }

  const vttExportSection = supportsUniversalVtt(map) ? el('div', {},
    el('h3', {}, 'Export to VTT'),
    el('div', { class: 'muted small', style: 'margin-bottom:6px' },
      `Universal VTT for the ${kind.levelCount ? 'current floor' : 'map'}: embedded PNG, grid-aligned walls, doors, and visible drawn wall paths.`),
    el('div', { class: 'tool-row' },
      el('button', { onclick: () => exportUvtt(false) }, 'UVTT · player-safe'),
      state.gm ? el('button', { onclick: () => exportUvtt(true) }, 'UVTT · GM') : el('span'))) : el('span');

  panel.append(
    el('div', { class: 'row', style: 'margin-bottom:6px' },
      el('a', { href: `#/e/${e.id}` }, `← ${e.name}`),
      el('span', { class: 'spacer' }),
      el('span', { class: 'type-badge' }, kind.label)),
    readOnly ? el('div', { class: 'notice', style: 'margin-bottom:10px' }, '👁 Player preview is read-only. Secret markers are hidden.') : el('span'),
    readOnly?null:el('div',{class:'tool-row'},undoButton,redoButton),layerControls,
    el('h3', {}, 'Generator'),
    el('div', { class: 'param-row' },
      el('label', {}, 'Seed'), seedInput,
      el('button', {
        title: 'Random seed', disabled: readOnly, onclick: () => {
          commitSeed(Math.random().toString(36).slice(2, 10));
        },
      }, '🎲'),
      el('button', {
        title: 'Regenerate from the seed in the box', disabled: readOnly, onclick: () => {
          commitSeed(seedInput.value, true);
        },
      }, '↻')),
    paramSection,
    !readOnly && kind.clearEdits?.has(map) ? el('button', {
      class: 'ghost small', onclick: () => {
        if (!confirm(kind.clearEdits.confirm)) return;
        kind.clearEdits.run(map);
        rebuild(); save();
      },
    }, kind.clearEdits.label) : el('span'),
    readOnly ? el('span') : paramRow('Compass', el('input', {
      type: 'checkbox', checked: !!map.compass, title: 'Draw a compass rose in the corner',
      onchange: (ev) => { map.compass = ev.target.checked; save(); redraw(); },
    })),
    levelChips,
    el('h3', {}, 'Tools'),
    readOnly ? el('div', { class: 'muted small' }, 'Editing disabled in player preview.') : toolRow,
    brushOptsRow, markerOptsRow, labelOptsRow, stampOptsRow, drawOptsRow,
    listsWrap,
    extraWrap,
    keyPanel ? keyPanel.element : el('span'),
    populateWrap,
    journeys ? journeys.element : el('span'),
    el('h3', {}, 'Export image'),
    paramRow('Resolution', el('select', {
      title: 'Higher resolutions render the map more sharply. Choose 2× or more for printing.',
      onchange: (ev) => { exportScale = Number(ev.target.value); },
    }, [[1, 'screen'], [2, 'print'], [3, 'large print'], [4, 'poster']].map(([k, use]) =>
      el('option', { value: k, selected: k === exportScale },
        `${k}× — ${W * k} × ${H * k} px (${use})`)))),
    kind.numberedRooms ? paramRow('Player room numbers', el('input', {
      type: 'checkbox', checked: playerRoomNumbers,
      title: 'Show room numbers on player-safe images and VTT files. GM images always show them; players never see IN or GOAL.',
      onchange: (ev) => { playerRoomNumbers = ev.target.checked; },
    })) : el('span'),
    el('div', { class: 'tool-row' },
      el('button', { onclick: () => exportPng(false) }, 'PNG · player-safe'),
      state.gm ? el('button', { onclick: () => exportPng(true) }, 'PNG · GM') : el('span')),
    imageProgress,imageCancel,
    vttExportSection,
    el('div', { class: 'muted small', style: 'margin-top:10px' },
      'Everything autosaves. Anything marked 🔒 stays hidden from players. 🏰 Place adds buildings and landmarks. ✏️ Draw adds roads, rivers, borders, routes and walls; finish a border where it began to enclose an area. Linked items appear in the numbered PDF key and open their entry on double-click. Select an item and press Delete to remove it.'),
    el('div', { class: 'muted small', style: 'margin-top:6px' },
      'On world and region maps, click a settlement or region name to open the next map scale. Use ✋ Move to drag towns and region seats. The lists on the right let you rename, add, hide and repair linked sites.'));

  container.append(el('div', { class: 'mapedit-layout' },
    el('div', { class: 'mapedit-canvas-wrap' }, canvas),
    panel));

  return () => {previewController?.abort();imageExport?.abort();window.removeEventListener('keydown', onKey);};
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}
