import { makeRng } from '../util.js';

export function reachable(grid,cols,rows,start,walkable=v=>v>0) {
  const previous=new Int32Array(grid.length).fill(-1),distance=new Int32Array(grid.length).fill(-1),queue=[];
  if(start<0||!walkable(grid[start]))return {previous,distance,cells:queue};
  queue.push(start);distance[start]=0;
  for(let k=0;k<queue.length;k++){
    const i=queue[k],x=i%cols,y=Math.floor(i/cols);
    for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){const xx=x+dx,yy=y+dy,j=yy*cols+xx;if(xx<0||yy<0||xx>=cols||yy>=rows||distance[j]>=0||!walkable(grid[j]))continue;previous[j]=i;distance[j]=distance[i]+1;queue.push(j);}
  }
  return {previous,distance,cells:queue};
}

// Connect freshly GENERATED components only. A stored grid is never repaired
// implicitly: walls and disconnected rooms drawn by the GM are intentional.
export function connectRooms(grid,cols,rows) {
  const first=grid.findIndex(v=>v>0);if(first<0){grid[Math.floor(rows/2)*cols+Math.floor(cols/2)]=1;return grid;}
  let seen=reachable(grid,cols,rows,first);
  for(let i=0;i<grid.length;i++){
    if(!grid[i]||seen.distance[i]>=0)continue;
    let nearest=first,dist=Infinity;const x=i%cols,y=Math.floor(i/cols);
    for(const j of seen.cells){const d=Math.abs(j%cols-x)+Math.abs(Math.floor(j/cols)-y);if(d<dist){dist=d;nearest=j;}}
    let xx=x,yy=y;while(xx!==nearest%cols){xx+=Math.sign(nearest%cols-xx);if(!grid[yy*cols+xx])grid[yy*cols+xx]=1;}
    while(yy!==Math.floor(nearest/cols)){yy+=Math.sign(Math.floor(nearest/cols)-yy);if(!grid[yy*cols+xx])grid[yy*cols+xx]=1;}
    seen=reachable(grid,cols,rows,first);
  }
  return grid;
}

export function dungeonPurpose(grid,cols,rows) {
  const open=[];for(let i=0;i<grid.length;i++)if(grid[i]>0)open.push(i);
  if(!open.length)return {rooms:[],entrance:null,goal:null};
  const entry=open.reduce((a,b)=>Math.min(a%cols,Math.floor(a/cols),cols-1-a%cols,rows-1-Math.floor(a/cols))<=Math.min(b%cols,Math.floor(b/cols),cols-1-b%cols,rows-1-Math.floor(b/cols))?a:b);
  const distances=reachable(grid,cols,rows,entry),goal=distances.cells.reduce((a,b)=>distances.distance[b]>distances.distance[a]?b:a,entry);
  const seen=new Uint8Array(grid.length),rooms=[];
  for(const i of open){if(grid[i]===2||seen[i])continue;const area=reachable(grid,cols,rows,i,v=>v>0&&v!==2).cells;area.forEach(c=>seen[c]=1);if(area.length<5)continue;const center=area.reduce((best,c)=>Math.abs(c%cols-cols/2)+Math.abs(Math.floor(c/cols)-rows/2)<Math.abs(best%cols-cols/2)+Math.abs(Math.floor(best/cols)-rows/2)?c:best,area[0]);rooms.push({id:rooms.length+1,x:center%cols,y:Math.floor(center/cols),role:area.includes(entry)?'Entrance':area.includes(goal)?'Goal':['Guard post','Store room','Shrine','Workshop','Rest area'][rooms.length%5],cells:area.length});}
  return {rooms,entrance:[entry%cols,Math.floor(entry/cols)],goal:[goal%cols,Math.floor(goal/cols)]};
}

export const BUILDING_ROLES={
  tavern:[['Taproom','Kitchen'],['Pantry','Office','Guest room']], inn:[['Dining hall','Kitchen'],['Guest room','Guest room','Guest room']],
  temple:[['Sanctuary'],['Vestry','Library','Offering room']], manor:[['Dining hall','Drawing room','Library'],['Bedchamber','Kitchen','Servants']],
  workshop:[['Workshop','Store room'],['Office','Tool room']], keep:[['Great hall','Armory'],['Barracks','Kitchen','Store room']],
  shop:[['Shop','Store room'],['Office','Bedchamber']], house:[['Living room','Kitchen'],['Bedchamber','Store room']],
};
export function plannedInterior(map,p) {
  const {cols,rows}=p,grid=new Uint8Array(cols*rows),rooms=[],rng=makeRng(map.seed+':v18:rooms');
  const mid=Math.floor(rows/2), roles=BUILDING_ROLES[p.building]||BUILDING_ROLES.tavern;
  for(let y=mid;y<=mid+1;y++)for(let x=2;x<cols-2;x++)grid[y*cols+x]=1;
  grid[mid*cols+1]=2;
  roles.forEach((names,side)=>{
    let left=2;
    names.forEach((role,k)=>{
      const remaining=names.length-k,width=k===names.length-1?cols-2-left:Math.max(3,Math.floor((cols-2-left-(remaining-1))/remaining)+rng.int(-1,1));
      const x0=left,x1=left+width-1,y0=side?mid+3:2,y1=side?rows-3:mid-2;
      for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++)grid[y*cols+x]=1;
      const dx=Math.floor((x0+x1)/2),dy=side?mid+2:mid-1;grid[dy*cols+dx]=2;
      rooms.push({id:rooms.length+1,role,x0,y0,x1,y1,door:[dx,dy],cx:(x0+x1)/2,cy:(y0+y1)/2});
      if(x1-x0>2)grid[(side?y1:y0)*cols+dx]=3;left=x1+2;
    });
  });
  const route=reachable(grid,cols,rows,mid*cols+1),protectedCells=new Set();
  for(const r of rooms){let i=Math.floor(r.cy)*cols+Math.floor(r.cx);while(i>=0&&!protectedCells.has(i)){protectedCells.add(i);i=route.previous[i];}}
  const furniture=[],occupied=new Set();
  const sets={Taproom:['table','table','counter','hearth'],Kitchen:['hearth','shelf','barrel'],Sanctuary:['altar','chair','chair'],Workshop:['table','shelf','barrel'],Library:['shelf','shelf','table']};
  for(const r of rooms){
    const items=sets[r.role]||(/bed|guest|barrack|servant/i.test(r.role)?['bed','bed','chest']:/store|pantry|armory|tool|offering/i.test(r.role)?['chest','barrel','shelf']:['table','chair','hearth']);
    for(const kind of items)for(let tries=0;tries<30;tries++){
      const x=rng.int(r.x0,r.x1),y=rng.int(r.y0,r.y1),i=y*cols+x,rot=0,cells=kind==='table'?[i,i+1]:[i];
      if(kind==='table'&&x+1>r.x1)continue;
      if(cells.some(c=>!grid[c]||grid[c]===2||protectedCells.has(c)||occupied.has(c)))continue;
      if(Math.abs(x-r.door[0])+Math.abs(y-r.door[1])<2)continue;
      cells.forEach(c=>occupied.add(c));furniture.push({x,y,kind,rot});break;
    }
  }
  return {grid,cols,rows,rooms,furniture:p.furnished?furniture:[],generation:'1.8',entrance:[1,mid]};
}
