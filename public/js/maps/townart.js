import { makeRng } from '../util.js';
import { smoothPath } from './atlasart.js';
import { drawMapLabels } from './cartography.js';

const W=900,H=640,TAU=Math.PI*2;
function path(ctx,pts,close=false){if(!pts?.length)return;ctx.beginPath();ctx.moveTo(...pts[0]);for(const p of pts.slice(1))ctx.lineTo(...p);if(close)ctx.closePath();}
function roof(ctx,b) {
  ctx.save();ctx.translate(b.x,b.y);ctx.rotate(b.rot);
  const colors={harbor:['#819296','#9faaa4','#a4a999'],market:['#b98662','#bd9471','#a5795d'],residential:['#ab8466','#b39979','#c4a27d'],craft:['#a47b62','#ad8e77','#8d7261'],garden:['#8c9c85','#a1a98b','#a1a098'],citadel:['#8e9390','#91988c','#a7a594']};
  ctx.fillStyle='rgba(57,45,34,.19)';ctx.fillRect(-b.w/2+2,-b.h/2+3,b.w+1,b.h+1);
  ctx.fillStyle=colors[b.use]?.[(b.roof||0)%3]||'#b39a78';ctx.fillRect(-b.w/2,-b.h/2,b.w,b.h);
  ctx.fillStyle='rgba(255,249,209,.22)';ctx.fillRect(-b.w/2,-b.h/2,b.w,b.h/2);
  ctx.strokeStyle='#665947';ctx.lineWidth=.75;ctx.strokeRect(-b.w/2,-b.h/2,b.w,b.h);
  ctx.beginPath();ctx.moveTo(-b.w/2+2,0);ctx.lineTo(b.w/2-2,0);ctx.moveTo(-b.w/2,-b.h/2);ctx.lineTo(-b.w/2+2,0);ctx.lineTo(-b.w/2,b.h/2);ctx.moveTo(b.w/2,-b.h/2);ctx.lineTo(b.w/2-2,0);ctx.lineTo(b.w/2,b.h/2);ctx.stroke();
  if(b.chimney){ctx.fillStyle='#77695a';ctx.fillRect(b.w*.18,-b.h*.28,2,3);ctx.fillStyle='#d4c8ad';ctx.fillRect(b.w*.18,-b.h*.28,2,1);}
  if(b.landmark){ctx.fillStyle='#ece2c2';ctx.fillRect(-3,-4,6,8);ctx.strokeRect(-3,-4,6,8);ctx.fillStyle='#7f8377';ctx.beginPath();ctx.moveTo(-4,-4);ctx.lineTo(0,-9);ctx.lineTo(4,-4);ctx.closePath();ctx.fill();ctx.stroke();}
  ctx.restore();
}
function foliage(ctx,x,y,r,seed) {
  ctx.fillStyle='rgba(74,81,49,.11)';ctx.beginPath();ctx.ellipse(x+2,y+3,r*1.15,r*.8,0,0,TAU);ctx.fill();
  for(let i=0;i<4;i++){const a=i*TAU/4+seed;ctx.fillStyle=['#aeb88f','#bac399','#a1b28b','#c0c89e'][i];ctx.strokeStyle='rgba(104,122,80,.38)';ctx.lineWidth=.5;ctx.beginPath();ctx.arc(x+Math.cos(a)*r*.32,y+Math.sin(a)*r*.3,r*.75,0,TAU);ctx.fill();ctx.stroke();}
}
export function renderPlannedTown(map,m,scale=1,wards=[],theme={terrain:'parchment',paving:'dirt'}) {
  const p={...m.p,...map.params};
  const palette={parchment:['#eee8d2','#a1bcc0'],grassland:['#dfe3cb','#a1bcc0'],desert:['#ebdcbc','#a4c0bd'],snow:['#e9ebe3','#9db2bd'],marsh:['#d8decd','#97b1aa']}[theme.terrain]||['#eee8d2','#a1bcc0'];
  const canvas=document.createElement('canvas');canvas.width=W*scale;canvas.height=H*scale;const ctx=canvas.getContext('2d');ctx.scale(scale,scale);
  const rng=makeRng(map.seed+':v18:town-ink');ctx.fillStyle=palette[0];ctx.fillRect(0,0,W,H);
  for(let i=0;i<1400;i++){ctx.fillStyle=i%3?'rgba(131,119,83,.028)':'rgba(255,254,232,.18)';ctx.fillRect(rng.range(0,W),rng.range(0,H),rng.range(1,5),.6);}
  // The harbor is a shaped inlet; water and docks follow the same geometry.
  if(m.water?.kind==='sea'){
    const shore=m.water.shore,side=m.water.seaSide||'south',corners=side==='north'?[[W+20,-20],[-20,-20]]:side==='east'?[[W+20,-20],[W+20,H+20]]:side==='west'?[[-20,H+20],[-20,-20]]:[[W+20,H+20],[-20,H+20]];
    path(ctx,[...shore,...corners],true);ctx.fillStyle=palette[1];ctx.fill();
    ctx.save();ctx.clip();
    for(let i=0;i<22;i++){const d=i*16,dir=side==='north'?[0,-1]:side==='east'?[1,0]:side==='west'?[-1,0]:[0,1];ctx.strokeStyle=i<3?'rgba(242,240,214,.60)':'rgba(219,234,222,.30)';ctx.lineWidth=.7;smoothPath(ctx,shore.map(([x,y])=>[x+dir[0]*d,y+dir[1]*d]));}
    ctx.restore();ctx.strokeStyle='#d9cea9';ctx.lineWidth=7;smoothPath(ctx,shore);ctx.strokeStyle='#737e6a';ctx.lineWidth=1.2;smoothPath(ctx,shore);
  }
  if(m.water?.kind==='river'){
    ctx.strokeStyle='#cec8a4';ctx.lineWidth=m.water.width+7;smoothPath(ctx,m.water.pts);ctx.strokeStyle=palette[1];ctx.lineWidth=m.water.width;smoothPath(ctx,m.water.pts);ctx.strokeStyle='rgba(232,239,222,.6)';ctx.lineWidth=1;smoothPath(ctx,m.water.pts);
  }
  for(const f of m.fields){ctx.save();ctx.translate(f.x,f.y);ctx.rotate(f.rot);ctx.fillStyle=f.kind==='orchard'?'#c4c9a1':'#d7cda1';ctx.fillRect(-f.w/2,-f.h/2,f.w,f.h);ctx.strokeStyle='#aeb58b';ctx.lineWidth=.6;ctx.strokeRect(-f.w/2,-f.h/2,f.w,f.h);
    for(let y=-f.h/2+4;y<f.h/2;y+=5){ctx.beginPath();ctx.moveTo(-f.w/2+2,y);ctx.lineTo(f.w/2-2,y);ctx.stroke();}ctx.restore();}
  // Paving inside the city reads as irregular blocks, with gardens and yards.
  for(const lot of m.parcels){ctx.save();ctx.translate(lot.x,lot.y);ctx.rotate(lot.rot);ctx.fillStyle=lot.use==='garden'?'#ced4ad':'#ddd4b8';ctx.fillRect(-lot.w/2-1.5,-lot.h/2-1.5,lot.w+3,lot.h+3);ctx.restore();}
  ctx.lineCap='round';ctx.lineJoin='round';
  for(const road of m.roads){ctx.strokeStyle='#c7bfa2';ctx.lineWidth=road.main?8:4.8;smoothPath(ctx,road.pts);}
  for(const road of m.roads){ctx.strokeStyle=theme.paving==='flagstone'?'#dedcd2':theme.paving==='cobbled'?'#d1ccb9':'#f1ebd6';ctx.lineWidth=road.main?6:3.1;smoothPath(ctx,road.pts);}
  if(theme.paving!=='dirt'){ctx.strokeStyle='rgba(110,108,94,.28)';ctx.lineWidth=theme.paving==='flagstone'?2:1.3;ctx.setLineDash(theme.paving==='flagstone'?[.6,7]:[1,3]);for(const road of m.roads)smoothPath(ctx,road.pts);ctx.setLineDash([]);}
  if(p.character==='hill'){
    ctx.strokeStyle='rgba(145,138,104,.28)';ctx.lineWidth=.65;for(let i=0;i<5;i++){ctx.beginPath();ctx.ellipse(m.plaza.x,m.plaza.y-90,40+i*15,25+i*10,-.2,0,TAU);ctx.stroke();}
  }
  for(const pier of m.piers){ctx.strokeStyle='#6c6d5b';ctx.lineWidth=9;path(ctx,[[pier.x0,pier.y0],[pier.x1,pier.y1]]);ctx.stroke();ctx.strokeStyle='#c2b18b';ctx.lineWidth=6;ctx.stroke();
    const a=Math.atan2(pier.y1-pier.y0,pier.x1-pier.x0),len=Math.hypot(pier.x1-pier.x0,pier.y1-pier.y0);ctx.save();ctx.translate(pier.x0,pier.y0);ctx.rotate(a);ctx.strokeStyle='#8c8065';ctx.lineWidth=.7;for(let i=0;i<len;i+=5){ctx.beginPath();ctx.moveTo(i,-3);ctx.lineTo(i,3);ctx.stroke();}ctx.restore();}
  for(const bridge of m.bridges){ctx.save();ctx.translate(bridge.x,bridge.y);ctx.rotate(bridge.rot);ctx.fillStyle='#dbd2b5';ctx.fillRect(-m.water.width/2-6,-5,m.water.width+12,10);ctx.strokeStyle='#797661';ctx.lineWidth=1.5;ctx.strokeRect(-m.water.width/2-6,-5,m.water.width+12,10);ctx.restore();}
  m.trees.forEach(([x,y,r],i)=>foliage(ctx,x,y,r*(theme.terrain==='desert'?.65:1),i*.7));
  // A paved gathering place, market awnings, wells and working quays give the
  // plan recognisable uses even with all labels switched off.
  ctx.fillStyle='#e4dcc1';ctx.beginPath();ctx.arc(m.plaza.x,m.plaza.y,m.plaza.r+2,0,TAU);ctx.fill();ctx.strokeStyle='#c0b597';ctx.lineWidth=.7;ctx.stroke();
  for(const b of m.buildings)roof(ctx,b);
  if(theme.terrain==='snow')for(const b of m.buildings){ctx.save();ctx.translate(b.x,b.y);ctx.rotate(b.rot);ctx.fillStyle='rgba(244,246,237,.68)';ctx.fillRect(-b.w/2+1,-b.h/2+1,b.w-2,b.h*.35);ctx.restore();}
  for(const detail of m.details||[]){ctx.save();ctx.translate(detail.x,detail.y);ctx.rotate(detail.rot||0);
    if(detail.kind==='well'){ctx.fillStyle='#b8b398';ctx.strokeStyle='#7d7c65';ctx.lineWidth=1;ctx.beginPath();ctx.arc(0,0,4,0,TAU);ctx.fill();ctx.stroke();ctx.fillStyle='#7c9b9a';ctx.beginPath();ctx.arc(0,0,2,0,TAU);ctx.fill();}
    else if(detail.kind==='barrels'){ctx.fillStyle='#ab9370';ctx.strokeStyle='#847655';for(let i=0;i<3;i++){ctx.beginPath();ctx.arc(i*3,0,1.5,0,TAU);ctx.fill();ctx.stroke();}}
    else{ctx.fillStyle='rgba(71,57,41,.2)';ctx.fillRect(-4,-2,10,7);ctx.fillStyle=['#a76850','#879d92','#d1ad65'][detail.color||0];ctx.fillRect(-5,-3,10,6);ctx.strokeStyle='#eee2bb';ctx.lineWidth=1;for(let i=-3;i<5;i+=3){ctx.beginPath();ctx.moveTo(i,-3);ctx.lineTo(i,3);ctx.stroke();}}
    ctx.restore();}
  for(const boat of m.boats){ctx.save();ctx.translate(boat.x,boat.y);ctx.rotate(boat.rot);const length=boat.ship?22:11;ctx.fillStyle='#7d7862';ctx.beginPath();ctx.ellipse(0,0,length,boat.ship?5:3,0,0,TAU);ctx.fill();ctx.fillStyle='#c3b293';ctx.beginPath();ctx.ellipse(0,-.5,length-2,boat.ship?3.5:1.8,0,0,TAU);ctx.fill();ctx.strokeStyle='#716e5c';ctx.lineWidth=.8;ctx.beginPath();ctx.moveTo(0,-8);ctx.lineTo(0,8);ctx.stroke();if(boat.ship){ctx.fillStyle='#f1ecd9';ctx.beginPath();ctx.moveTo(0,-8);ctx.lineTo(13,3);ctx.lineTo(0,6);ctx.closePath();ctx.fill();}ctx.restore();}
  if(m.wall){const {poly,gate}=m.wall;for(let i=0;i<poly.length;i++){const j=(i+1)%poly.length;if(gate[i]||gate[j])continue;const a=poly[i],b=poly[j];ctx.strokeStyle='rgba(72,66,48,.2)';ctx.lineWidth=8;path(ctx,[a.map(v=>v+2),b.map(v=>v+2)]);ctx.stroke();ctx.strokeStyle='#7f7f69';ctx.lineWidth=6;path(ctx,[a,b]);ctx.stroke();ctx.strokeStyle='#d1cdb1';ctx.lineWidth=3;ctx.stroke();}
    for(let i=0;i<poly.length;i+=5){if(gate[i])continue;ctx.fillStyle='#c6c2a6';ctx.strokeStyle='#7f7f69';ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(...poly[i],4,0,TAU);ctx.fill();ctx.stroke();}}
  if(p.labels!==false)drawMapLabels(ctx,[
    ...m.buildings.filter(b=>b.landmark).map(b=>({text:b.landmark,x:b.x,y:b.y,size:10,priority:8})),
    {text:m.plazaLabel||'Market Square',x:m.plaza.x,y:m.plaza.y,size:11,italic:true,priority:9},
    ...(map.params?.wards?wards.map((ward,i)=>({text:(map.wardNames?.[i]||ward.name).toUpperCase(),x:ward.cx,y:ward.cy,size:12,center:true,italic:true,priority:4})):[]),
  ],W,H,[{x:18,y:14,w:235,h:43}]);
  if(p.labels!==false){ctx.fillStyle='rgba(240,235,215,.93)';ctx.fillRect(18,14,235,43);ctx.strokeStyle='#aaa58c';ctx.lineWidth=.65;ctx.strokeRect(18,14,235,43);ctx.fillStyle='#595e49';ctx.font='small-caps 19px Georgia';ctx.textAlign='left';ctx.fillText(p.title||({coastal:'The Harbor & Its Wards',riverside:'A Town on the River',grid:'The Chartered Borough'}[m.layout]||'Streets of the Old Town'),29,40,213);}
  ctx.strokeStyle='#8c9076';ctx.lineWidth=1;ctx.strokeRect(6,6,W-12,H-12);ctx.lineWidth=.35;ctx.strokeRect(10,10,W-20,H-20);
  return canvas;
}
