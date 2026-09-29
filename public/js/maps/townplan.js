// Parcel-based town infill. Layout functions supply only the geographical
// envelope and main streets; all new draws belong to the 1.8 streams.
import { makeRng, makeFbm } from '../util.js';

const W=900,H=640,C=2,GW=W/C,GH=H/C;
export const DISTRICT_USES={market:'Market',craft:'Crafts',residential:'Homes',garden:'Gardens',harbor:'Harbor',citadel:'Citadel'};
export function coastalTownLayout(map,p) {
  const rng=makeRng(map.seed+':v18:harbor'),noise=makeFbm(map.seed+':v18:shoreline',4),cx=rng.range(370,540),depth=Number(p.harborDepth??.6)*120+35;
  const shoreAt=x=>H*.76-Math.exp(-(((x-cx)/170)**2))*depth+Math.sin(x/140+1)*19+(noise(x/120,4)-.5)*24;
  const shore=[];for(let x=-20;x<=W+20;x+=6)shore.push([x,shoreAt(x)]);
  const size=Math.max(1,Math.min(5,Number(p.size)||2)),extent=[0,.36,.68,1,1.12,1.2][size];
  const centerX=W/2*Math.min(1,extent)+cx*Math.max(0,1-extent),centerY=H*.40*Math.min(1,extent)+(shoreAt(cx)-35)*Math.max(0,1-extent);
  const plaza={x:cx-110*Math.min(1,extent),y:shoreAt(cx-110*Math.min(1,extent))-76*Math.min(1,extent),r:14+size*5};
  const boundary={contains:(x,y)=>((x-centerX)/(370*extent))**2+((y-centerY)/(285*extent))**2<1&&y<shoreAt(x)-6,
    polygon:()=>[]};
  const roads=[];
  for(let k=0;k<6;k++){
    const pts=[],offset=23+k*53;for(let x=100;x<=810;x+=12){const y=shoreAt(x)-offset+(k?Math.sin(x/110+k)*9:0);if(y>30&&boundary.contains(x,y))pts.push([x,y]);}
    if(pts.length>2)roads.push({pts,main:k===0||k===2});
  }
  for(let k=0;k<8;k++){
    const x0=140+k*82,pts=[];for(let y=35;y<shoreAt(x0)-15;y+=10){const x=x0+Math.sin(y/120+k)*14+(y-250)*.05*(k-3.5);if(boundary.contains(x,y))pts.push([x,y]);}
    if(pts.length>2)roads.push({pts,main:k===2||k===5});
  }
  const piers=[],boats=[];const count=Math.round(Number(p.docks??5));
  for(let k=0;k<count;k++){const x=cx-95+k*190/Math.max(1,count-1),y=shoreAt(x),len=rng.range(32,64);piers.push({x0:x,y0:y-5,x1:x+7,y1:y+len});boats.push({x:x+20,y:y+len-5,rot:Math.PI/2+rng.range(-.3,.3)});}
  boats.push({x:cx+15,y:shoreAt(cx)+115,rot:.2,ship:true});
  return {roads,plaza,boundary,water:{kind:'sea',shore,shoreAt},piers,boats,plazaLabel:'Quayside Market',wallScale:.98};
}
export function planTown(map,L,p,layout) {
  const rng=makeRng(map.seed+':v18:parcels'), slope=makeFbm(map.seed+':v18:hill',3);
  const riverAt=x=>{
    const pts=L.water?.pts||[];for(let i=1;i<pts.length;i++)if(pts[i][0]>=x){const a=pts[i-1],b=pts[i];return a[1]+(b[1]-a[1])*(x-a[0])/(b[0]-a[0]);}
    return pts.at(-1)?.[1]??-1000;
  };
  const waterAt=(x,y,pad=0)=>L.water?.kind==='sea'?y>L.water.shoreAt(x)-pad:L.water?.kind==='river'?Math.abs(y-riverAt(x))<L.water.width/2+pad:false;
  const inside=(x,y)=>x>14&&y>14&&x<W-14&&y<H-14&&L.boundary.contains(x,y)&&!waterAt(x,y,8);
  const roads=L.roads.map(r=>({...r,pts:r.pts.map(pt=>pt.slice())})), parcels=[],buildings=[];
  let occupied=new Uint8Array(GW*GH);
  const mark=(x,y,r=1)=>{for(let yy=Math.max(0,Math.floor((y-r)/C));yy<=Math.min(GH-1,Math.floor((y+r)/C));yy++)for(let xx=Math.max(0,Math.floor((x-r)/C));xx<=Math.min(GW-1,Math.floor((x+r)/C));xx++)occupied[yy*GW+xx]=1;};
  function rasterRoads() {
    occupied.fill(0);
    for(let y=0;y<GH;y++)for(let x=0;x<GW;x++)if(!inside(x*C,y*C)||Math.hypot(x*C-L.plaza.x,y*C-L.plaza.y)<L.plaza.r+6)occupied[y*GW+x]=1;
    for(const r of roads)for(let j=1;j<r.pts.length;j++){
      const a=r.pts[j-1],b=r.pts[j],n=Math.ceil(Math.hypot(b[0]-a[0],b[1]-a[1])/3);
      for(let k=0;k<=n;k++)mark(a[0]+(b[0]-a[0])*k/n,a[1]+(b[1]-a[1])*k/n,r.main?3:2);
    }
  }
  function blocks() {
    const seen=new Uint8Array(occupied.length),out=[];
    for(let i=0;i<occupied.length;i++) {
      if(occupied[i]||seen[i])continue; const cells=[i];seen[i]=1;
      let x0=GW,y0=GH,x1=0,y1=0,sx=0,sy=0;
      for(let k=0;k<cells.length;k++){
        const q=cells[k],x=q%GW,y=Math.floor(q/GW);x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);sx+=x*C;sy+=y*C;
        for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){const xx=x+dx,yy=y+dy,j=yy*GW+xx;if(xx<0||yy<0||xx>=GW||yy>=GH||seen[j]||occupied[j])continue;seen[j]=1;cells.push(j);}
      }
      if(cells.length>5)out.push({cells,x0:x0*C,y0:y0*C,x1:x1*C,y1:y1*C,cx:sx/cells.length,cy:sy/cells.length});
    }
    return out;
  }
  rasterRoads();
  // Several generations of narrow lanes divide deep blocks. They are slightly
  // crooked except in a deliberately planned grid; houses follow their frontage.
  for(let pass=0;pass<3;pass++){
    for(const b of blocks()) {
      if(b.cells.length*C*C<(200+pass*45)*16)continue;
      const vertical=b.x1-b.x0>b.y1-b.y0, points=[],phase=rng.range(0,6);
      if(vertical){for(let y=b.y0-8;y<=b.y1+8;y+=4){const x=b.cx+(layout==='grid'?0:Math.sin(y/65+phase)*5);if(inside(x,y))points.push([x,y]);}}
      else {for(let x=b.x0-8;x<=b.x1+8;x+=4){const y=b.cy+(layout==='grid'?0:Math.sin(x/65+phase)*5);if(inside(x,y))points.push([x,y]);}}
      if(points.length>5)roads.push({pts:points,main:false});
    }
    rasterRoads();
  }
  rasterRoads();
  const cityBlocks=blocks(), blockOf=new Int16Array(GW*GH).fill(-1);
  cityBlocks.forEach((b,i)=>b.cells.forEach(c=>blockOf[c]=i));
  const uses=['market','craft','residential','garden','harbor','citadel'];
  const districtAt=(x,y)=>{
    const nearWater=L.water?.kind==='sea'?Math.abs(y-L.water.shoreAt(x)):L.water?.kind==='river'?Math.abs(y-riverAt(x)):Infinity;
    if(nearWater<95)return 'harbor';
    if(Math.hypot(x-L.plaza.x,y-L.plaza.y)<110)return 'market';
    if(p.character==='hill'&&slope(x/W*4,y/H*4)>.56)return 'citadel';
    if(p.character==='fortified'&&x<W*.45&&y<H*.45)return 'citadel';
    return x<L.plaza.x-80?'craft':y<L.plaza.y-120?'garden':'residential';
  };
  const cellsFor=(x,y,w,h,rot)=>{
    const out=new Set(),cos=Math.cos(rot),sin=Math.sin(rot);
    const stepsX=Math.ceil(w/(C/2)),stepsY=Math.ceil(h/(C/2));
    for(let iy=0;iy<=stepsY;iy++)for(let ix=0;ix<=stepsX;ix++){
      const u=-w/2+w*ix/stepsX,v=-h/2+h*iy/stepsY;
      const xx=x+u*cos-v*sin,yy=y+u*sin+v*cos;if(!inside(xx,yy))return null;
      const i=Math.floor(yy/C)*GW+Math.floor(xx/C);if(occupied[i])return null;out.add(i);
    }
    return [...out];
  };
  const landmarks={market:'Weigh House',craft:'Copper Foundry',residential:'The Lantern Inn',garden:'Abbey of the Bell',harbor:'Customs House',citadel:'High Keep'};
  const civicSizes={market:[27,21],craft:[30,19],residential:[27,21],garden:[21,39],harbor:[36,20],citadel:[38,32]};
  for(const use of uses){
    let found=false;const [w,h]=civicSizes[use];
    for(const road of roads){if(found)break;for(let j=1;j<road.pts.length;j+=3){if(found)break;const [x0,y0]=road.pts[j-1],[x1,y1]=road.pts[j],angle=Math.atan2(y1-y0,x1-x0);
      for(const side of [-1,1]){const offset=h/2+10,x=x1-Math.sin(angle)*offset*side,y=y1+Math.cos(angle)*offset*side;
        if(districtAt(x,y)!==use)continue;const cells=cellsFor(x,y,w+4,h+4,angle);if(!cells)continue;
        cells.forEach(c=>occupied[c]=1);const id=parcels.length;parcels.push({id,x,y,w:w+4,h:h+4,rot:angle,use});buildings.push({x,y,w,h,rot:angle,use,parcel:id,landmark:landmarks[use],civic:true,roof:rng.int(0,2)});found=true;break;
      }
    }}
  }
  for(const road of roads)for(let j=1;j<road.pts.length;j++) {
    const [ax,ay]=road.pts[j-1],[bx,by]=road.pts[j],len=Math.hypot(bx-ax,by-ay);if(!len)continue;
    const angle=Math.atan2(by-ay,bx-ax);
    for(let d=0;d<len;d+=8)for(const side of [-1,1]) {
      const px=ax+(bx-ax)*d/len,py=ay+(by-ay)*d/len;
      const depth=rng.range(10,17),offset=(road.main?9:7)+depth/2;
      const x=px-Math.sin(angle)*offset*side,y=py+Math.cos(angle)*offset*side,use=districtAt(x,y);
      const density=use==='garden'?.65:use==='citadel'?.72:.98;
      if(!rng.chance(Math.min(1,density*(p.density||1))))continue;
      const width=rng.range(use==='harbor'?14:8,use==='harbor'?25:17),lotW=width+1.5,lotH=depth+(use==='garden'?7:1.5);
      const cells=cellsFor(x,y,lotW,lotH,angle);if(!cells)continue;cells.forEach(c=>occupied[c]=1);
      const id=parcels.length,block=blockOf[Math.floor(y/C)*GW+Math.floor(x/C)];
      parcels.push({id,block,x,y,w:lotW,h:lotH,rot:angle,use});
      buildings.push({x,y,w:width,h:depth,rot:angle,landmark:null,use,parcel:id,roof:rng.int(0,5),chimney:rng.chance(.34)});
    }
  }
  for(const use of uses){if(buildings.some(b=>b.use===use&&b.landmark))continue;const b=buildings.filter(b=>b.use===use).sort((a,b)=>b.w*b.h-a.w*a.h)[0];if(b)b.landmark=landmarks[use];}
  const districts=[];
  const districtNames={market:'Old Market',craft:'Coppergate',residential:'Lantern Ward',garden:'Abbey Gardens',harbor:'Salt Quay',citadel:'High Ward'};
  for(const use of uses){const all=buildings.filter(b=>b.use===use);if(all.length<3)continue;districts.push({use,name:districtNames[use],cx:all.reduce((s,b)=>s+b.x,0)/all.length,cy:all.reduce((s,b)=>s+b.y,0)/all.length,count:all.length});}
  const bridges=[];
  if(L.water?.kind==='river')for(const r of roads)for(let i=1;i<r.pts.length;i++){
    const a=r.pts[i-1],b=r.pts[i];if((a[1]-riverAt(a[0]))*(b[1]-riverAt(b[0]))>0)continue;
    const x=(a[0]+b[0])/2;if(bridges.some(p=>Math.abs(p.x-x)<20))continue;bridges.push({x,y:riverAt(x),rot:Math.atan2(b[1]-a[1],b[0]-a[0])});
  }
  const trees=[],fields=[],details=[];
  for(let i=0;i<650;i++){const x=rng.range(14,W-14),y=rng.range(14,H-14);if(waterAt(x,y,10))continue;
    const cell=Math.floor(y/C)*GW+Math.floor(x/C);
    const nearRoad=roads.some(r=>r.pts.some(([px,py])=>Math.hypot(px-x,py-y)<10));
    if(!nearRoad&&(!L.boundary.contains(x,y)||(!occupied[cell]&&districtAt(x,y)==='garden')))trees.push([x,y,rng.range(3,7)]);
  }
  for(let i=0;i<12;i++){const x=rng.range(50,W-50),y=rng.range(55,H-55);if(L.boundary.contains(x,y)||waterAt(x,y,35)||waterAt(x+35,y+25,8))continue;fields.push({x,y,w:rng.range(24,50),h:rng.range(20,35),rot:rng.range(-.3,.3),kind:i%4?'field':'orchard'});}
  for(let i=0;i<12;i++){const a=i*Math.PI*2/12,r=L.plaza.r*.72;details.push({kind:i===0?'well':'stall',x:L.plaza.x+Math.cos(a)*r,y:L.plaza.y+Math.sin(a)*r,rot:a+Math.PI/2,color:i%3});}
  for(const b of buildings)if(b.use==='harbor'&&rng.chance(.15))details.push({kind:'barrels',x:b.x+b.w*.65,y:b.y,rot:b.rot});
  return {p,size:p.size,layout,roads,buildings,parcels,blocks:cityBlocks.map(({cells,...b})=>({...b,area:cells.length*C*C})),districts,
    plaza:L.plaza,plazaLabel:L.plazaLabel,water:L.water||null,piers:L.piers||[],boats:L.boats||[],bridges,trees,fields,details,wall:null,generation:'1.8'};
}
