// The 1.8 drawing language is shared by world and region maps. Geometry stays
// in the model; cartographic decoration has an isolated render-only stream.
import { makeRng, makeFbm, clamp } from '../util.js';
import { drawMapLabels } from './cartography.js';

const W = 960, H = 600, TAU = Math.PI * 2;
const mix = (a,b,t) => a.map((v,i)=>v+(b[i]-v)*clamp(t,0,1));
const CASES = [[],[[3,2]],[[2,1]],[[3,1]],[[0,1]],[[0,3],[2,1]],[[0,2]],[[0,3]],[[0,3]],[[0,2]],[[0,1],[3,2]],[[0,1]],[[3,1]],[[2,1]],[[3,2]],[]];
export function contour(ctx, field, gw, gh, level, sx=W/gw, sy=H/gh, accept=null) {
  ctx.beginPath();
  for(let y=0;y<gh-1;y++)for(let x=0;x<gw-1;x++){
    if(accept&&!accept(x,y))continue;
    const a=field[y*gw+x],b=field[y*gw+x+1],c=field[(y+1)*gw+x+1],d=field[(y+1)*gw+x];
    const pairs=CASES[(a>level?8:0)|(b>level?4:0)|(c>level?2:0)|(d>level?1:0)];if(!pairs.length)continue;
    const t=(v,w)=>(level-v)/(w-v||1e-9);
    const points=[[x+t(a,b),y],[x+1,y+t(b,c)],[x+t(d,c),y+1],[x,y+t(a,d)]];
    for(const [i,j] of pairs){ctx.moveTo((points[i][0]+.5)*sx,(points[i][1]+.5)*sy);ctx.lineTo((points[j][0]+.5)*sx,(points[j][1]+.5)*sy);}
  }
  ctx.stroke();
}
export function smoothPath(ctx, points) {
  if(points.length<2)return;ctx.beginPath();ctx.moveTo(...points[0]);
  for(let i=1;i<points.length-1;i++)ctx.quadraticCurveTo(...points[i],(points[i][0]+points[i+1][0])/2,(points[i][1]+points[i+1][1])/2);
  ctx.lineTo(...points.at(-1));ctx.stroke();
}
function mountain(ctx,x,y,s,variation) {
  ctx.fillStyle='#ded9be';ctx.strokeStyle='#777765';ctx.lineWidth=.65;
  ctx.beginPath();ctx.moveTo(x-s,y+s*.35);ctx.lineTo(x-s*.12,y-s);ctx.lineTo(x+s,y+s*.35);ctx.closePath();ctx.fill();ctx.stroke();
  ctx.fillStyle='#a3a792';ctx.beginPath();ctx.moveTo(x-s*.12,y-s);ctx.lineTo(x+s*.24,y+s*.23);ctx.lineTo(x+s,y+s*.35);ctx.closePath();ctx.fill();
  ctx.strokeStyle='rgba(87,92,78,.45)';ctx.lineWidth=.45;
  for(let k=1;k<4;k++){ctx.beginPath();ctx.moveTo(x-s*.12+s*k*.08,y-s+s*k*.26);ctx.lineTo(x-s*.2-s*k*.18,y+s*.24);ctx.stroke();}
  if(variation>.55){ctx.fillStyle='#f5f0de';ctx.beginPath();ctx.moveTo(x-s*.12,y-s);ctx.lineTo(x-s*.43,y-s*.45);ctx.lineTo(x-s*.1,y-s*.56);ctx.lineTo(x+s*.22,y-s*.37);ctx.closePath();ctx.fill();}
}
function tree(ctx,x,y,r,pine) {
  ctx.fillStyle='rgba(57,86,63,.10)';ctx.beginPath();ctx.ellipse(x+1,y+2,r*1.2,r*.55,0,0,TAU);ctx.fill();
  ctx.fillStyle=pine?'#839a78':'#9cad83';ctx.strokeStyle='rgba(66,91,61,.62)';ctx.lineWidth=.5;
  ctx.beginPath();if(pine){ctx.moveTo(x,y-r*1.4);ctx.lineTo(x+r*.75,y+r*.55);ctx.lineTo(x-r*.75,y+r*.55);ctx.closePath();}else ctx.arc(x,y-r*.35,r,0,TAU);
  ctx.fill();ctx.stroke();ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x,y+r);ctx.stroke();
}
function settlement(ctx,x,y,size,capital,regional) {
  ctx.save();ctx.translate(x,y);ctx.strokeStyle='#4f4434';ctx.lineWidth=.8;
  if(!regional){ctx.fillStyle='#f6edd5';ctx.beginPath();ctx.arc(0,0,capital?4.5:2.6,0,TAU);ctx.fill();ctx.stroke();if(capital){ctx.fillStyle='#714e37';ctx.beginPath();ctx.arc(0,0,2,0,TAU);ctx.fill();}}
  else {
    const points=[[-5,1],[2,3],[5,-3],[-2,-5],[-10,-4],[10,3],[-1,8]];
    points.slice(0,Math.min(7,2+size*2)).forEach(([x,y],i)=>{ctx.fillStyle='#e9d8b1';ctx.fillRect(x-2,y-1,5,5);ctx.strokeRect(x-2,y-1,5,5);ctx.fillStyle=i%2?'#a87657':'#8f6b55';ctx.beginPath();ctx.moveTo(x-3,y);ctx.lineTo(x+.5,y-3);ctx.lineTo(x+4,y);ctx.closePath();ctx.fill();ctx.stroke();});
    if(capital){ctx.fillStyle='#e8ddc1';ctx.fillRect(-3,-16,6,11);ctx.strokeRect(-3,-16,6,11);ctx.fillStyle='#847466';ctx.fillRect(-4,-18,8,3);ctx.beginPath();ctx.moveTo(2,-18);ctx.lineTo(2,-27);ctx.stroke();ctx.fillStyle='#ae7053';ctx.fillRect(2,-27,7,4);}
  }ctx.restore();
}
export function renderGeographicMap(map,m,scale=1,regional=false) {
  const {moisture,water,gw,gh}=m,p={...m.params,...map.params},sx=W/gw,sy=H/gh;
  let height=m.height, lakeField=null;
  // A world lake cell covers several province cells. Round the drawn banks
  // without changing the saved crop, coast mask, sites or route geometry.
  if(m.lakeMask?.some(Boolean)||m.carveLakeCells?.size){
    lakeField=Float32Array.from(height,(_,i)=>m.lakeMask?.[i]||m.carveLakeCells?.has(i)?1:0);
    for(let pass=0;pass<(regional?4:1);pass++){
      const next=new Float32Array(lakeField.length);
      for(let y=0;y<gh;y++)for(let x=0;x<gw;x++){
        let sum=0;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)sum+=lakeField[clamp(y+dy,0,gh-1)*gw+clamp(x+dx,0,gw-1)]*(dx?1:2)*(dy?1:2);
        next[y*gw+x]=sum/16;
      }lakeField=next;
    }
    height=height.slice();
    for(let i=0;i<height.length;i++)if(lakeField[i]>.01&&(height[i]>=water||m.lakeMask?.[i]||m.carveLakeCells?.has(i))){
      const bank=water+(.44-lakeField[i])*.075,t=Math.min(1,lakeField[i]/.44);
      height[i]=Math.max(water+.02,height[i])*(1-t)+bank*t;
    }
  }
  const canvas=document.createElement('canvas');canvas.width=W*scale;canvas.height=H*scale;const ctx=canvas.getContext('2d');ctx.scale(scale,scale);
  const rng=makeRng(map.seed+':v18:engraving'), forest=makeFbm(map.seed+':v18:woodlands',4);
  const lake=i=>lakeField?.[i]>.44;
  const dry=(x,y)=>{const i=clamp(Math.round(y/sy),0,gh-1)*gw+clamp(Math.round(x/sx),0,gw-1);return height[i]>=water&&!lake(i);};
  const off=document.createElement('canvas');off.width=gw;off.height=gh;const oc=off.getContext('2d'),im=oc.createImageData(gw,gh);
  for(let y=0;y<gh;y++)for(let x=0;x<gw;x++){
    const i=y*gw+x,h=height[i],e=Math.max(0,h-water),lat=1-Math.abs(y/gh-.5)*2;
    let color;
    if(h<water||lake(i)) color=mix([117,157,166],[195,213,203],1-clamp((water-h)*5,0,1));
    else {
      const wet=moisture[i],cold=!regional&&lat<.25;
      color=mix([226,214,171],[167,187,145],(wet-.3)*1.5);
      color=mix(color,[201,196,168],clamp(e/.34,0,1));
      if(cold||p.terrain==='cold')color=mix(color,[226,231,214],.55);
      if(p.terrain==='arid')color=mix(color,[223,192,144],.55);
      if(p.terrain==='harsh')color=mix(color,[172,176,154],.5);
      if(e>.29)color=mix(color,[229,225,201],(e-.29)*3);
      if(m.territory && !m.territory[i])color=mix(color,[238,232,212],.42);
      const a=height[Math.max(0,y-1)*gw+Math.max(0,x-1)],b=height[Math.min(gh-1,y+1)*gw+Math.min(gw-1,x+1)];
      const shade=clamp(1+(a-b)*(regional?3.3:4.5),.76,1.11);color=color.map(v=>v*shade);
    }
    const j=i*4;im.data[j]=color[0];im.data[j+1]=color[1];im.data[j+2]=color[2];im.data[j+3]=255;
  }
  oc.putImageData(im,0,0);ctx.imageSmoothingEnabled=true;ctx.drawImage(off,0,0,W,H);
  ctx.lineCap='round';ctx.lineJoin='round';
  // Gentle offshore contours and a narrow shore wash replace pixelated shelves.
  ctx.strokeStyle='rgba(245,242,218,.52)';ctx.lineWidth=1;for(const d of [.015,.035,.065])contour(ctx,height,gw,gh,water-d);
  ctx.strokeStyle='rgba(249,239,205,.7)';ctx.lineWidth=3.2;contour(ctx,height,gw,gh,water);
  ctx.strokeStyle='#74765c';ctx.lineWidth=1;contour(ctx,height,gw,gh,water);
  if(lakeField){ctx.strokeStyle='rgba(87,116,112,.65)';ctx.lineWidth=.65;contour(ctx,lakeField,gw,gh,.44);}
  // Sparse contours and hachures provide topography without a heat-map wash.
  ctx.strokeStyle='rgba(125,119,88,.14)';ctx.lineWidth=.55;
  if(regional)for(let elevation=water+.06;elevation<water+.35;elevation+=.055)contour(ctx,height,gw,gh,elevation);
  const towns=regional?m.settlements||[]:m.towns||[];
  const closeToSite=(x,y)=>towns.some(t=>Math.hypot(x-(regional?t.x:t.x*sx),y-(regional?t.y:t.y*sy))<15);
  const featureLabels=[];
  for(let y=12;y<H-12;y+=regional?7:5)for(let x=12;x<W-12;x+=regional?8:6){
    const px=x+rng.range(-3,3),py=y+rng.range(-3,3),gx=clamp(Math.floor(px/sx),0,gw-1),gy=clamp(Math.floor(py/sy),0,gh-1),i=gy*gw+gx;
    const e=height[i]-water;if(e<.012||lake(i)||closeToSite(px,py))continue;
    if(e>.20&&rng.chance(clamp((e-.18)*3.1,.05,.75))){mountain(ctx,px,py,regional?rng.range(6,12):rng.range(3.5,7),e*2.5);}
    else if(e<.22&&moisture[i]>.46&&forest(gx/gw*13,gy/gh*9)>.51&&rng.chance(.57))tree(ctx,px,py,regional?rng.range(2.3,4.2):rng.range(1.3,2.2),e>.11);
    else if(regional&&e>.08&&rng.chance(.08)){ctx.strokeStyle='rgba(130,129,93,.23)';ctx.lineWidth=.5;ctx.beginPath();ctx.moveTo(px-3,py+2);ctx.quadraticCurveTo(px,py-2,px+4,py+1);ctx.stroke();}
  }
  // Fine farmland mosaics make settlement hinterlands readable at region scale.
  if(regional)for(const town of towns){
    for(let k=0;k<17;k++){const a=rng.range(0,TAU),r=rng.range(16,40),x=town.x+Math.cos(a)*r,y=town.y+Math.sin(a)*r,w=rng.range(5,13),h=rng.range(4,9);
      if(!dry(x-w,y-h)||!dry(x+w,y+h))continue;
      ctx.save();ctx.translate(x,y);ctx.rotate(a*.15);ctx.fillStyle=['#c9c397','#d4c999','#bbc194'][k%3];ctx.globalAlpha=.65;ctx.fillRect(-w/2,-h/2,w,h);ctx.strokeStyle='#9e9c73';ctx.lineWidth=.4;ctx.strokeRect(-w/2,-h/2,w,h);ctx.restore();
    }
  }
  for(const line of m.rivers||[]){
    const points=line.filter((_,i)=>i%2===0||i===line.length-1).map(([x,y])=>[(x+.5)*sx,(y+.5)*sy]);
    ctx.strokeStyle='rgba(223,231,205,.8)';ctx.lineWidth=regional?3.7:2.3;smoothPath(ctx,points);
    ctx.strokeStyle='#6d999e';ctx.lineWidth=regional?1.65:1.1;smoothPath(ctx,points);
  }
  if(regional&&p.roads!==false){
    ctx.setLineDash([4,3]);for(const road of m.roads||[]){ctx.strokeStyle='#ede6c9';ctx.lineWidth=3.5;smoothPath(ctx,road);ctx.strokeStyle='#897a5a';ctx.lineWidth=1.1;smoothPath(ctx,road);}ctx.setLineDash([]);
    for(const route of m.ferries||[]){ctx.strokeStyle='#6a9399';ctx.setLineDash([2,5]);ctx.lineWidth=1;smoothPath(ctx,route);ctx.setLineDash([]);const [a,b]=route;featureLabels.push({text:'Ferry passage',x:(a[0]+b[0])/2,y:(a[1]+b[1])/2,size:10,italic:true,priority:2});}
    ctx.strokeStyle='#6b6450';ctx.lineWidth=1.5;for(const b of m.bridges||[]){ctx.beginPath();ctx.moveTo(b.x-3,b.y-3);ctx.lineTo(b.x+3,b.y-3);ctx.moveTo(b.x-3,b.y+3);ctx.lineTo(b.x+3,b.y+3);ctx.stroke();}
  }
  if(m.owner&&!regional){
    ctx.strokeStyle='rgba(144,87,70,.55)';ctx.lineWidth=.75;ctx.setLineDash([3,3]);ctx.beginPath();
    for(let y=1;y<gh-1;y++)for(let x=1;x<gw-1;x++){const i=y*gw+x,a=m.owner[i];if(a<0)continue;if(m.owner[i+1]>=0&&m.owner[i+1]!==a){ctx.moveTo((x+1)*sx,y*sy);ctx.lineTo((x+1)*sx,(y+1)*sy);}if(m.owner[i+gw]>=0&&m.owner[i+gw]!==a){ctx.moveTo(x*sx,(y+1)*sy);ctx.lineTo((x+1)*sx,(y+1)*sy);}}
    ctx.stroke();ctx.setLineDash([]);
  }
  if(m.territory){ctx.strokeStyle='rgba(153,94,70,.85)';ctx.lineWidth=1.5;ctx.setLineDash([5,4]);contour(ctx,m.territory,gw,gh,.5,sx,sy,(x,y)=>[y*gw+x,y*gw+x+1,(y+1)*gw+x,(y+1)*gw+x+1].every(i=>height[i]>=water&&!lake(i)));ctx.setLineDash([]);}
  if(regional&&p.hexes){ctx.strokeStyle='rgba(85,82,62,.17)';ctx.lineWidth=.5;const r=24;ctx.beginPath();for(let row=0;row<H/(r*1.5)+1;row++)for(let col=0;col<W/(r*Math.sqrt(3))+1;col++){const cx=col*r*Math.sqrt(3)+(row%2?r*Math.sqrt(3)/2:0),cy=row*r*1.5;for(let k=0;k<6;k++){const a=Math.PI/3*k-Math.PI/2,x=cx+Math.cos(a)*r,y=cy+Math.sin(a)*r;k?ctx.lineTo(x,y):ctx.moveTo(x,y);}ctx.closePath();}ctx.stroke();}
  for(const t of towns)settlement(ctx,regional?t.x:t.x*sx,regional?t.y:t.y*sy,t.size||1,regional?t.seat:t.capital,regional);
  if(!regional)for(const n of m.nations||[])if(n.custom&&!n.hidden)settlement(ctx,n.capital[0]*sx,n.capital[1]*sy,1,true,false);
  if(regional)for(const lm of m.landmarks||[]){
    ctx.save();ctx.translate(lm.x,lm.y);ctx.strokeStyle='#666750';ctx.fillStyle='#ded4b4';ctx.lineWidth=1;
    if(lm.kind==='ruins'){ctx.strokeRect(-5,-4,4,8);ctx.strokeRect(1,-2,4,6);}else{ctx.fillRect(-3,-8,6,10);ctx.strokeRect(-3,-8,6,10);ctx.beginPath();ctx.moveTo(-4,-8);ctx.lineTo(0,-13);ctx.lineTo(4,-8);ctx.closePath();ctx.fill();ctx.stroke();}ctx.restore();
    featureLabels.push({text:lm.name,x:lm.x,y:lm.y,size:11,italic:true,priority:4});
  }
  if(p.labels!==false){
    const letters=['Ashen','Silver','Elder','Ivory','Verdant','Sable','Mist','Crown','Amber','Storm'];
    const peaks=[];for(let y=10;y<gh-10;y+=10)for(let x=10;x<gw-10;x+=10){const i=y*gw+x;if(height[i]>water+.24&&!lake(i))peaks.push({x:x*sx,y:y*sy,e:height[i]});}
    peaks.sort((a,b)=>b.e-a.e);const placed=[];
    for(const peak of peaks){if(placed.length>=(regional?3:5))break;if(placed.some(q=>Math.hypot(q.x-peak.x,q.y-peak.y)<180))continue;placed.push(peak);featureLabels.push({text:`${rng.pick(letters)} ${regional?'Heights':'Range'}`,x:peak.x,y:peak.y,size:regional?13:12,italic:true,center:true,priority:1});}
    drawMapLabels(ctx,[...towns.map(t=>({text:t.name,x:regional?t.x:t.x*sx,y:regional?t.y:t.y*sy,size:regional?(t.seat?15:12):(t.capital?13:10),bold:!!(t.seat||t.capital),priority:t.seat||t.capital?12:9})),
      ...(!regional?(m.nations||[]).filter(n=>!n.hidden&&(n.cells>200||n.custom)).map(n=>({text:n.name.toUpperCase(),x:n.cx*sx,y:n.cy*sy,size:18,center:true,priority:n.custom?10:5})):[]),...featureLabels],W,H,[{x:W/2-185,y:13,w:370,h:40},{x:W-100,y:5,w:95,h:100}]);
  }
  // Restrained frame and cartouche leave the geography in charge of the page.
  ctx.strokeStyle='#7d8168';ctx.lineWidth=1.2;ctx.strokeRect(7,7,W-14,H-14);ctx.lineWidth=.4;ctx.strokeRect(11,11,W-22,H-22);
  if(p.labels!==false){const title=String(p.title||(regional?m.title:'Chart of the Known World'));ctx.font='small-caps 20px Georgia';ctx.textAlign='center';const tw=Math.min(370,ctx.measureText(title).width+38);ctx.fillStyle='rgba(239,234,211,.92)';ctx.fillRect((W-tw)/2,13,tw,34);ctx.strokeStyle='#9b9b7e';ctx.lineWidth=.65;ctx.strokeRect((W-tw)/2,13,tw,34);ctx.fillStyle='#505943';ctx.fillText(title,W/2,36,tw-16);}
  return canvas;
}
