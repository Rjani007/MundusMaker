'use strict';
const {test}=require('node:test'), assert=require('node:assert/strict');
const load=require('./module-loader');
test('geography presets repeat exactly and create varied land coverage',async()=>{
  const {buildGeography}=await load('maps/geography.js');
  const cover=[];
  for(const landform of ['continents','archipelago','inlandsea','highlands']) {
    const p={landform,water:.5,ruggedness:.7}, a=buildGeography('silver-coast',p,120,75), b=buildGeography('silver-coast',p,120,75);
    assert.deepEqual(a.height,b.height);assert.deepEqual(a.moisture,b.moisture);
    const land=a.height.filter(h=>h>=a.water).length/a.height.length; assert.ok(land>.04&&land<.95,`${landform}: ${land}`); cover.push(land);
    assert.ok(Math.max(...a.height)>.70,landform+' has highlands');
  }
  assert.ok(Math.max(...cover)-Math.min(...cover)>.25);
});
test('drainage is acyclic, drains to the sea or boundary and accounts for every land cell',async()=>{
  const {buildGeography,drainage}=await load('maps/geography.js');
  for(const landform of ['continents','archipelago','inlandsea']) {
    const m=buildGeography('silver-coast',{landform,water:.5},160,100), flow=drainage(m,12);
    let rain=0,discharged=0;
    for(let i=0;i<m.height.length;i++) {
      if(m.height[i]>=m.water)rain+=.5+m.moisture[i];
      const next=flow.flowTo[i];
      if(next<0){discharged+=flow.accumulation[i];assert.ok(m.height[i]<m.water||i<m.gw||i>=m.height.length-m.gw||i%m.gw===0||i%m.gw===m.gw-1);}
      else assert.ok(flow.flowHeight[next]<flow.flowHeight[i]);
    }
    assert.ok(Math.abs(rain-discharged)<.001);
    assert.ok(flow.rivers.length>0,landform+' has rivers');
    for(const line of flow.rivers) for(let j=1;j<line.length;j++)assert.ok(Math.hypot(line[j][0]-line[j-1][0],line[j][1]-line[j-1][1])<1.5);
  }
});
test('regional roads stay on land; an island connection is explicitly a ferry',async()=>{
  const {terrainRoads}=await load('maps/geography.js');
  const gw=20,gh=12,height=new Float32Array(gw*gh).fill(.6);
  for(let y=0;y<gh;y++)height[y*gw+10]=.2;
  const m={gw,gh,height,water:.5};
  const sites=[{x:2,y:2},{x:6,y:9},{x:17,y:4}];
  const result=terrainRoads(m,sites,gw-1,gh-1);
  assert.equal(result.roads.length,1);assert.equal(result.ferries.length,1);
  for(const road of result.roads)for(const [x,y] of road)assert.ok(height[Math.round(y)*gw+Math.round(x)]>=.5);
});
test('purpose-based interiors have reachable rooms and furniture preserves access',async()=>{
  const {plannedInterior,reachable,BUILDING_ROLES}=await load('maps/floorplans.js');
  for(const building of Object.keys(BUILDING_ROLES))for(const seed of ['silver','amber','coal']) {
    const m=plannedInterior({seed},{building,cols:24,rows:18,furnished:true});
    const start=m.entrance[1]*m.cols+m.entrance[0],all=reachable(m.grid,m.cols,m.rows,start);
    assert.equal(all.cells.length,m.grid.filter(v=>v>0).length,building);
    const clear=m.grid.slice();for(const f of m.furniture){clear[f.y*m.cols+f.x]=0;if(f.kind==='table')clear[f.y*m.cols+f.x+1]=0;}
    const access=reachable(clear,m.cols,m.rows,start);
    for(const r of m.rooms)assert.ok(access.distance[Math.floor(r.cy)*m.cols+Math.floor(r.cx)]>=0,building+' '+r.role);
  }
});
test('new dungeon floors are connected and generated stairs always have a paired landing',async()=>{
  const {dungeonGrid}=await load('maps/dungeon.js'),{reachable}=await load('maps/floorplans.js');
  for(const style of ['rooms','caves','crypt','mine','sewer'])for(const seed of ['deep','silver','coal']){
    const map={kind:'dungeon',seed,params:{generation:'1.8',style,cols:42,rows:27,levels:3,rooms:12,loops:.5}};
    const levels=[0,1,2].map(n=>dungeonGrid(map,n));
    levels.forEach((m,n)=>{
      const first=m.grid.findIndex(v=>v>0),seen=reachable(m.grid,m.cols,m.rows,first);
      assert.equal(seen.cells.length,m.grid.filter(v=>v>0).length,`${style} ${seed} L${n+1}`);
      for(let i=0;i<m.grid.length;i++)if(m.grid[i]===3)assert.equal(levels[n+1]?.grid[i],4);else if(m.grid[i]===4)assert.equal(levels[n-1]?.grid[i],3);
    });
  }
});
test('town parcels are deterministic and carry distinct district uses',async()=>{
  const {buildTownModel}=await load('maps/town.js');
  for(const layout of ['coastal','riverside','organic','grid']){
    const map={kind:'town',seed:'silver-port',params:{generation:'1.8',layout,size:3,density:1,walls:true,wards:true}};
    const a=buildTownModel(map),b=buildTownModel(map);
    assert.ok(a.buildings.length>30,layout+' has a populated street network');
    assert.ok(a.blocks.length>3,layout+' has city blocks');
    assert.ok(a.districts.length>=3,layout+' has distinct districts');
    assert.deepEqual(a.buildings,b.buildings);
  }
});
test('map undo groups gestures and preserves the parameter object used by editor controls',async()=>{
  const {mapHistory}=await load('maps/history.js');
  const map={seed:'one',params:{generation:'1.8'},markers:[]},params=map.params,history=mapHistory(map);
  history.begin();map.markers.push({id:'m',x:.1});history.record();map.markers[0].x=.6;history.record();history.end();
  map.params.generation='legacy';history.record();assert.ok(history.undo());assert.equal(map.params,params);assert.equal(params.generation,'1.8');
  assert.ok(history.undo());assert.deepEqual(map.markers,[]);assert.ok(history.redo());assert.equal(map.markers[0].x,.6);
  map.seed='two';history.record();assert.equal(history.canRedo,false);
});

test('1.8 world crops preserve the selected territory and coastline at region resolution',async()=>{
  const {buildWorldModel}=await load('maps/world.js'),{buildRegionModel}=await load('maps/region.js');
  const {extractCarve,regionSites,inheritedRegionSites,regionParamsForSite}=await load('maps/crossscale.js');
  const world={kind:'world',seed:'silver-coast',params:{generation:'1.8',style:'atlas',nations:4,settlements:true,water:.5}};
  const model=buildWorldModel(world),before=Array.from(model.height);
  for(const site of regionSites(world,model,[960,600]).slice(0,3)){
    const carve=extractCarve(model,site);assert.equal(carve.snapshotVersion,2);assert.ok(carve.territoryb64);
    const region={kind:'region',seed:'province:'+site.key,params:{generation:'1.8',...regionParamsForSite(model,site,carve)},carve,sites:inheritedRegionSites(world,model,site,carve)};
    const rm=buildRegionModel(region),land=Buffer.from(carve.landb64,'base64'),territory=Buffer.from(carve.territoryb64,'base64');
    assert.deepEqual(Buffer.from(rm.territory),territory);
    for(let i=0;i<rm.height.length;i++)if(!rm.carveLakeCells.has(i))assert.equal(rm.height[i]>=rm.water,!!land[i],`shoreline cell ${i}`);
    const seats=rm.settlements.filter(s=>s.seat);assert.equal(seats.length,1);assert.equal(seats[0].name,model.towns.find(t=>t.nationIndex===site.nationIndex)?.name);
    for(const s of rm.settlements.filter(s=>s.inherited)){const x=Math.round(s.x/4),y=Math.round(s.y/4);assert.ok(rm.height[Math.min(149,y)*240+Math.min(239,x)]>=rm.water,s.name);}
  }
  assert.deepEqual(Array.from(model.height),before,'snapshot and region generation never mutate the parent');
});

test('coastal settlement size grows a hamlet into a city without changing the shore',async()=>{
  const {buildTownModel}=await load('maps/town.js');
  const maps=[1,3,5].map(size=>buildTownModel({kind:'town',seed:'silver-port',params:{generation:'1.8',layout:'coastal',size,density:1}}));
  assert.ok(maps[0].buildings.length<maps[1].buildings.length/2);
  assert.ok(maps[1].buildings.length<maps[2].buildings.length);
  assert.deepEqual(maps[0].water.shore,maps[2].water.shore);
});

test('both paths to an inherited capital keep the same town seed and geography',async()=>{
  const {buildWorldModel}=await load('maps/world.js'),{buildRegionModel,resolveRegionTerrainKey,traceRivers}=await load('maps/region.js'),c=await load('maps/crossscale.js');
  for(const seed of ['silver-coast','lantern','old-empire']){
    const world={kind:'world',seed,params:{generation:'1.8',style:'atlas',landform:'archipelago',nations:4,settlements:true,water:.5}},wm=buildWorldModel(world);
    for(const nation of c.regionSites(world,wm,[960,600])){
      const carve=c.extractCarve(wm,nation),region={kind:'region',seed:c.regionSeedForSite(world,nation),params:{generation:'1.8',...c.regionParamsForSite(wm,nation,carve)},carve,sites:c.inheritedRegionSites(world,wm,nation,carve)},rm=buildRegionModel(region);
      const seat=region.sites.find(s=>s.seat),local=c.settlementSites(region,rm,[960,600]).find(s=>s.key===c.customKey(seat)),parent=c.settlementSites(world,wm,[960,600]).find(s=>s.key===seat.origin);
      assert.equal(c.townSeedForSettlement(region,local),c.townSeedForSettlement(world,parent));
      assert.deepEqual(c.townParamsForSettlement(region,rm,local,{regionTerrain:resolveRegionTerrainKey(region),rivers:traceRivers(rm,region.seed)}),c.townParamsForSettlement(world,wm,parent,{rivers:wm.rivers}),seed+' '+nation.name);
    }
  }
});
