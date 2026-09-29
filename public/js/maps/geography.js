// 1.8 geography uses its own streams. Legacy generators never call this file.
// Drainage is an original implementation of the Priority-Flood approach:
// Barnes, Lehman & Mulla, https://arxiv.org/abs/1511.04463.
import { makeFbm, makeRng, clamp } from '../util.js';

export const LANDFORMS = { continents: 'Continents & mountain chains', archipelago: 'Island archipelago', inlandsea: 'Inland sea', highlands: 'Highlands & valleys' };

// A binary heap with deterministic tie breaks; shared by drainage and routes.
function heap() {
  const a = [];
  const before = (x, y) => x.cost < y.cost || (x.cost === y.cost && x.id < y.id);
  return {
    get length() { return a.length; },
    push(id, cost) {
      const item = { id, cost }; let i = a.length; a.push(item);
      while (i) { const p = (i - 1) >> 1; if (!before(item, a[p])) break; a[i] = a[p]; i = p; }
      a[i] = item;
    },
    pop() {
      const first = a[0], last = a.pop(); if (!a.length) return first;
      let i = 0;
      while (i * 2 + 1 < a.length) {
        let c = i * 2 + 1; if (c + 1 < a.length && before(a[c + 1], a[c])) c++;
        if (!before(a[c], last)) break; a[i] = a[c]; i = c;
      }
      a[i] = last; return first;
    },
  };
}

export function buildGeography(seed, params, gw = 480, gh = 300) {
  const rng = makeRng(seed + ':v18:plates'), noise = makeFbm(seed + ':v18:relief', 6);
  const warp = makeFbm(seed + ':v18:coasts', 4), wet = makeFbm(seed + ':v18:moisture', 4);
  const crags = makeFbm(seed + ':v18:crags', 5), continent = makeFbm(seed + ':v18:continent', 4);
  const landform = LANDFORMS[params.landform] ? params.landform : 'continents';
  const plates = [], chains = [], island = landform === 'archipelago';
  const n = island ? 22 : 4;
  for (let i = 0; i < n; i++) {
    // Separate continental cores provide composition; strong multi-scale warps
    // cut bays, straits and peninsulas into them instead of outlining ellipses.
    const x = island ? .12 + i / (n - 1) * .76 + rng.range(-.10,.10) : [.25,.70,.42,.82][i] + rng.range(-.05,.05);
    const y = island ? .5 + Math.sin(i * .42) * .23 + rng.range(-.12,.12) : [.40,.55,.76,.22][i] + rng.range(-.08,.08);
    const rx = rng.range(island ? .045 : i < 2 ? .23 : .10, island ? .10 : i < 2 ? .29 : .16) * Math.sqrt(3 / Number(params.scale || 3)), ry = rx * rng.range(.8, 1.5);
    const angle = rng.range(0, Math.PI), ca = Math.cos(angle), sa = Math.sin(angle);
    plates.push({x,y,rx,ry,ca,sa});
    const points = [];
    for (let k = 0; k < 5; k++) {
      const t = (k / 4 - .5) * ry * 1.8, bend = Math.sin(k * 1.3 + i) * rx * .55;
      points.push([x + ca * bend - sa * t, y + sa * bend + ca * t]);
    }
    chains.push(points);
  }
  const height = new Float32Array(gw * gh), moisture = new Float32Array(gw * gh);
  const water = clamp(Number(params.water ?? .5), .05, .8), ruggedness = clamp(Number(params.ruggedness ?? .7), .1, 1);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const u = x / (gw - 1), v = y / (gh - 1), wx = u + (warp(u * 5.6, v * 4) - .5) * .42, wy = v + (warp(u * 5.6 + 12, v * 4 + 12) - .5) * .42;
    let mass = -1, ridge = 0;
    for (let k = 0; k < plates.length; k++) {
      const p = plates[k], dx = wx - p.x, dy = wy - p.y;
      const d = Math.hypot((dx * p.ca + dy * p.sa) / p.rx, (-dx * p.sa + dy * p.ca) / p.ry);
      mass = Math.max(mass, 1 - d);
      if (d > 1.1) continue;
      const line = chains[k];
      for (let j = 1; j < line.length; j++) {
        const [ax,ay] = line[j-1], [bx,by] = line[j], vx = bx-ax, vy = by-ay;
        const t = clamp(((wx-ax)*vx + (wy-ay)*vy) / (vx*vx + vy*vy), 0, 1);
        const dist = Math.hypot(wx-ax-t*vx, wy-ay-t*vy);
        ridge = Math.max(ridge, Math.exp(-dist * dist / .00055) * clamp((1-d)*1.7,0,1));
      }
    }
    const detail = noise(wx * 22, wy * 15) - .5, broad = continent(wx*7,wy*5)-.5;
    const ridgeDetail = .35 + Math.abs(crags(wx*32,wy*23)-.5)*3;
    let h = .44 + mass * .28 + broad * .28 + detail * .16 + ridge * ridgeDetail * .38 * ruggedness;
    if (landform === 'inlandsea') {
      const sea = Math.exp(-((wx-.48)**2/.035 + (wy-.52)**2/.025));
      h = .61 + broad*.27 + detail*.19 + ridge*ridgeDetail*.22*ruggedness - sea*.31;
    }
    if (landform === 'highlands') h = .57 + broad*.30 + detail*.22 + ridge*ridgeDetail*.30*ruggedness;
    const edge = params.regional ? 0 : Math.max(0, .15 - Math.min(u,v,1-u,1-v)) / .15;
    height[y*gw+x] = clamp(h - edge * edge * .40, .02, .98);
    moisture[y*gw+x] = wet(u * 4 + 20, v * 4 + 20);
  }
  const east = params.wind === 'east';
  for (let y = 0; y < gh; y++) {
    let air = .8, prev = water;
    for (let k = 0; k < gw; k++) {
      const x = east ? gw-1-k : k, i = y*gw+x, h = height[i];
      if (h < water) air = .92;
      const rise = Math.max(0, h-prev);
      air = clamp(air - rise * 2.7 + .002, .08, .98);
      moisture[i] = clamp(moisture[i] * .35 + air * .65 - Math.max(0,h-water-.25)*.6,0,1); prev = h;
    }
  }
  return {height, moisture, water, gw, gh, chains, generation:'1.8'};
}

export function drainage(model, count = 10) {
  const {height, water, gw, gh} = model, n = height.length;
  const filled = new Float64Array(n), parent = new Int32Array(n).fill(-1), seen = new Uint8Array(n), order = [], queue = heap();
  const start = i => { if (seen[i]) return; seen[i]=1; filled[i]=height[i]; queue.push(i,filled[i]); };
  for (let i=0;i<n;i++) if (height[i] < water || i < gw || i >= n-gw || i%gw===0 || i%gw===gw-1) start(i);
  while(queue.length) {
    const {id:i} = queue.pop(); order.push(i); const x=i%gw, y=(i/gw)|0;
    for (let dy=-1;dy<=1;dy++) for (let dx=-1;dx<=1;dx++) {
      const xx=x+dx, yy=y+dy; if ((!dx&&!dy)||xx<0||yy<0||xx>=gw||yy>=gh) continue;
      const j=yy*gw+xx; if(seen[j]) continue;
      seen[j]=1; parent[j]=i; filled[j]=Math.max(height[j],filled[i]+.000001); queue.push(j,filled[j]);
    }
  }
  const accumulation = Float64Array.from(height, (h,i)=>h>=water ? .5+(model.moisture?.[i]??.5) : 0);
  for(let k=order.length-1;k>=0;k--) { const i=order[k]; if(parent[i]>=0) accumulation[parent[i]]+=accumulation[i]; }
  const lakeMask = new Uint8Array(n), lakes=[];
  for(let i=0;i<n;i++) if(height[i]>=water && filled[i]-height[i]>.012) lakeMask[i]=1;
  const lakeSeen = new Uint8Array(n);
  for(let i=0;i<n;i++) {
    if(!lakeMask[i]||lakeSeen[i]) continue;
    const group=[i]; lakeSeen[i]=1;
    for(let k=0;k<group.length;k++) {
      const q=group[k], x=q%gw, y=(q/gw)|0;
      for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const xx=x+dx, yy=y+dy, j=yy*gw+xx;
        if(xx<0||yy<0||xx>=gw||yy>=gh||!lakeMask[j]||lakeSeen[j]) continue;
        lakeSeen[j]=1;group.push(j);
      }
    }
    // A filled depression is a routing surface, not automatically a vast lake.
    // Keep discrete basins; broad flood fills remain traversable river valleys.
    if(group.length>=4 && group.length<n*.004) lakes.push(group); else for(const q of group) lakeMask[q]=0;
  }
  const candidates=[];
  for(let i=0;i<n;i++) if(height[i]>water+.10 && accumulation[i]>12 && !lakeMask[i]) candidates.push(i);
  candidates.sort((a,b)=>(accumulation[b]*(height[b]-water))-(accumulation[a]*(height[a]-water))||a-b);
  const rivers=[], riverCells=new Set(), heads=[];
  for(const source of candidates) {
    if(rivers.length>=Math.max(0,Math.min(40,count))) break;
    if(riverCells.has(source)||heads.some(i=>Math.hypot(i%gw-source%gw,Math.floor(i/gw)-Math.floor(source/gw))<14)) continue;
    const points=[], cells=[]; let i=source;
    while(i>=0 && points.length<n) {
      points.push([i%gw,Math.floor(i/gw)]); cells.push(i);
      if(height[i]<water || (i!==source&&riverCells.has(i))) break;
      i=parent[i];
    }
    if(points.length<9) continue;
    rivers.push(points); heads.push(source); for(const q of cells) riverCells.add(q);
  }
  return { rivers, lakes, lakeMask, flowHeight:filled, flowTo:parent, accumulation, riverCells };
}

/** Terrain-weighted, eight-neighbour expansion. Ridges and valleys shape
 * borders; saved edits reuse the same height/jitter arrays without new draws. */
export function naturalTerritories(model) {
  const {height,water,gw,gh,nations,natJitter}=model,n=height.length,owner=new Int8Array(n).fill(-1),costs=new Float64Array(n).fill(Infinity),queue=heap();
  nations.forEach((nat,k)=>{if(nat.hidden)return;const x=clamp(Math.round(nat.capital[0]),0,gw-1),y=clamp(Math.round(nat.capital[1]),0,gh-1),i=y*gw+x;owner[i]=k;costs[i]=0;queue.push(i,0);});
  while(queue.length){const {id:i,cost}=queue.pop();if(cost!==costs[i])continue;const x=i%gw,y=Math.floor(i/gw);
    for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]){
      const xx=x+dx,yy=y+dy,j=yy*gw+xx;if(xx<0||yy<0||xx>=gw||yy>=gh||height[j]<water||model.lakeMask?.[j])continue;
      const step=Math.hypot(dx,dy)*(1+Math.max(0,height[j]-water-.12)*16+Math.abs(height[j]-height[i])*38+(natJitter?.[j]||0)*.55)+(model.riverCells?.has(j)?1.5:0);
      if(cost+step>=costs[j])continue;costs[j]=cost+step;owner[j]=owner[i];queue.push(j,costs[j]);
    }
  }
  model.owner=owner;nations.forEach((nat,k)=>{let x=0,y=0,n=0;owner.forEach((v,i)=>{if(v===k){x+=i%gw;y+=Math.floor(i/gw);n++;}});nat.cx=n?x/n:nat.capital[0];nat.cy=n?y/n:nat.capital[1];nat.cells=n;});
}

// Dijkstra routes stay on land and follow gentle terrain. Disconnected islands
// get an explicit ferry connection, never a road painted across open water.
export function terrainRoads(model, sites, width = 960, heightPx = 600) {
  const {gw,gh,height,water}=model, roads=[], ferries=[], bridges=[];
  if(sites.length<2) return {roads,ferries,bridges};
  const dry=i=>height[i]>=water && !model.lakeMask?.[i];
  const index=s=>clamp(Math.round(s.y/heightPx*(gh-1)),0,gh-1)*gw+clamp(Math.round(s.x/width*(gw-1)),0,gw-1);
  function find(a,b) {
    const from=index(a), to=index(b); if(!dry(from)||!dry(to)) return null;
    const costs=new Float64Array(gw*gh).fill(Infinity), previous=new Int32Array(gw*gh).fill(-1), open=heap();
    costs[from]=0;open.push(from,0);
    while(open.length) {
      const {id:i,cost}=open.pop(); if(cost!==costs[i]) continue; if(i===to) break;
      const x=i%gw,y=(i/gw)|0;
      for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]) {
        const xx=x+dx,yy=y+dy,j=yy*gw+xx;
        if(xx<0||yy<0||xx>=gw||yy>=gh||!dry(j)) continue;
        if(dx&&dy&&(!dry(y*gw+xx)||!dry(yy*gw+x))) continue;
        const step=Math.hypot(dx,dy)*(1+Math.abs(height[j]-height[i])*65+Math.max(0,height[j]-water-.20)*4)+(model.riverCells?.has(j)?2:0);
        if(cost+step>=costs[j]) continue;costs[j]=cost+step;previous[j]=i;open.push(j,costs[j]);
      }
    }
    if(!Number.isFinite(costs[to])) return null;
    const cells=[];for(let i=to;i>=0;i=previous[i]){cells.push(i);if(i===from)break;} cells.reverse();
    const pts=cells.map(i=>[(i%gw)/(gw-1)*width,Math.floor(i/gw)/(gh-1)*heightPx]);
    let lastBridge=-100;
    cells.forEach((i,k)=>{if(model.riverCells?.has(i)&&k-lastBridge>5){bridges.push({x:pts[k][0],y:pts[k][1]});lastBridge=k;}});
    return pts;
  }
  const connected=new Set([0]);
  while(connected.size<sites.length) {
    let pair=null,best=Infinity;
    for(const a of connected) for(let b=0;b<sites.length;b++) if(!connected.has(b)) {
      const d=Math.hypot(sites[a].x-sites[b].x,sites[a].y-sites[b].y);if(d<best){best=d;pair=[a,b];}
    }
    const [a,b]=pair,route=find(sites[a],sites[b]);
    if(route) roads.push(route);else ferries.push([[sites[a].x,sites[a].y],[sites[b].x,sites[b].y]]);
    connected.add(b);
  }
  return {roads,ferries,bridges};
}
