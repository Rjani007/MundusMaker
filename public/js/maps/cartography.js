import { clamp } from '../util.js';

// Labels are measured at native map coordinates, so the same decisions are
// used at screen resolution and at 4x print resolution.
export function drawMapLabels(ctx,features,W,H,reserved=[]) {
  const boxes=[...reserved];ctx.save();ctx.textBaseline='middle';ctx.textAlign='center';
  for(const f of [...features].sort((a,b)=>(b.priority||0)-(a.priority||0))) {
    let size=f.size||13;const text=String(f.text||'');if(!text)continue;
    ctx.font=`${f.italic?'italic ':''}${f.bold?'bold ':''}${size}px Georgia, serif`;
    while(ctx.measureText(text).width>W*.45&&size>10){size--;ctx.font=`${f.bold?'bold ':''}${size}px Georgia, serif`;}
    const width=ctx.measureText(text).width+8,height=size+7;
    const candidates=f.center?[[f.x,f.y],[f.x,f.y-24],[f.x,f.y+24]]:[[f.x,f.y+15],[f.x,f.y-17],[f.x+width/2+12,f.y],[f.x-width/2-12,f.y],[f.x,f.y+30]];
    for(let [x,y] of candidates) {
      x=clamp(x,width/2+12,W-width/2-12);y=clamp(y,height/2+12,H-height/2-12);
      const box={x:x-width/2,y:y-height/2,w:width,h:height};
      if(boxes.some(b=>box.x<b.x+b.w+3&&box.x+box.w+3>b.x&&box.y<b.y+b.h+3&&box.y+box.h+3>b.y))continue;
      ctx.strokeStyle=f.center?'rgba(243,235,213,.55)':'rgba(251,244,222,.92)';ctx.lineWidth=3;ctx.strokeText(text,x,y);
      ctx.fillStyle=f.center?'rgba(65,47,35,.65)':'#322b26';ctx.fillText(text,x,y);boxes.push(box);break;
    }
  }
  ctx.restore();return boxes;
}

export function finishCartography(canvas,theme) {
  if(!theme||theme==='original')return;
  const ctx=canvas.getContext('2d'),image=ctx.getImageData(0,0,canvas.width,canvas.height),d=image.data;
  for(let i=0;i<d.length;i+=4){
    const r=d[i],g=d[i+1],b=d[i+2],grey=r*.30+g*.59+b*.11,sea=b-r>20&&g-r>15&&b>50;
    if(theme==='ink'){
      const v=sea?248:grey<80?grey*.8:Math.min(255,225+(grey-80)*.17);d[i]=d[i+1]=d[i+2]=v;
    }else if(theme==='parchment'){
      d[i]=r*.72+242*.28;d[i+1]=g*.72+225*.28;d[i+2]=b*.66+192*.34;
    }else if(theme==='atlas'){
      d[i]=r*.70+245*.30;d[i+1]=g*.76+250*.24;d[i+2]=b*.78+250*.22;
    }
  }
  ctx.putImageData(image,0,0);
}

export function drawMapLegend(ctx,map,W,H,legend=[]) {
  const p=map.params||{};if(!p.legend&&!p.distance)return;
  ctx.save();ctx.font='11px Georgia';ctx.textAlign='left';ctx.textBaseline='middle';
  const width=245,rows=(p.legend?legend.length:0)+(p.distance?2:0),height=20+rows*17,x=18,y=H-height-18;
  ctx.fillStyle='rgba(252,249,239,.94)';ctx.fillRect(x,y,width,height);ctx.strokeStyle='#86755a';ctx.lineWidth=1;ctx.strokeRect(x,y,width,height);
  ctx.fillStyle='#43382b';let cy=y+14;
  if(p.distance){const distance=Number(p.distance)*180/W;ctx.fillText(`${Number(distance.toPrecision(3)).toLocaleString()} ${p.units||'km'}`,x+12,cy);cy+=16;ctx.fillRect(x+12,cy-2,180,2);for(const dx of [12,102,192])ctx.fillRect(x+dx,cy-5,1,8);cy+=20;}
  if(p.legend)for(const text of legend){ctx.fillText(text,x+12,cy);cy+=17;}
  ctx.restore();
}
