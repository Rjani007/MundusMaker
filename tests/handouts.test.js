'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),load=require('./module-loader');
const fixture=()=>({id:'letter',name:'A letter',type:'handout',handout:{kind:'letter',sourceId:'source',sourceFields:['Reward'],sourceBlocks:['details'],sourceImage:true},blocks:[{id:'body',kind:'text',text:'Visible words and [[source|the source]].'},{id:'hidden',kind:'text',text:'SECRET CANARY ![secret image](/assets/test/private.png)',secret:true}],relations:[]});
test('player handout projection filters before collecting text, images, warnings or pages',async()=>{
  const {projectHandout}=await load('handouts/handoutcore.js');
  const e=fixture(),source={id:'source',name:'HIDDEN CANARY',gmOnly:true,image:'hidden.png',fields:{Reward:'SECRET GOLD'},blocks:[{id:'details',kind:'text',text:'SECRET SOURCE'}]},entities=new Map([[e.id,e],[source.id,source]]);
  let player=projectHandout(e,{entities,worldId:'test'});assert.ok(!JSON.stringify(player).includes('CANARY'));assert.equal(player.image,null);assert.deepEqual(player.warnings,[]);assert.match(player.blocks[0].text,/unavailable reference/);
  const gm=projectHandout(e,{entities,worldId:'test',gm:true});assert.match(JSON.stringify(gm),/SECRET CANARY/);assert.equal(gm.image,'/assets/test/hidden.png');
  source.gmOnly=false;source.blocks[0].secret=true;player=projectHandout(e,{entities,worldId:'test'});assert.ok(!JSON.stringify(player.blocks).includes('SECRET SOURCE'));
  e.relations=[{to:'source',secret:true}];player=projectHandout(e,{entities,worldId:'test'});assert.equal(player.image,null);assert.ok(!player.blocks.some(b=>b.text?.includes('SECRET GOLD')));
  entities.delete('source');assert.equal(projectHandout(e,{entities,worldId:'test'}).image,null);
  e.gmOnly=true;assert.equal(projectHandout(e,{entities,worldId:'test'}),null);
});
test('local image paths reject traversal, foreign worlds and external requests',async()=>{
  const {localAsset}=await load('handouts/handoutcore.js');assert.equal(localAsset('portrait.png','test'),'/assets/test/portrait.png');
  for(const input of ['https://example.test/image.png','//evil.test/p.png','/assets/other/p.png','/assets/test/../p.png','/assets/test/%2e%2e/p.png','/assets/test/p.png?remote=1'])assert.equal(localAsset(input,'test'),null,input);
});
test('template content stays in ordinary blocks and survives JSON round trips',async()=>{
  const {initializeHandout,HANDOUT_KINDS}=await load('handouts/handoutcore.js');
  for(const kind of Object.keys(HANDOUT_KINDS)){let n=0;const e=initializeHandout({id:kind,name:'A title',blocks:[]},kind,()=>String(++n)),round=JSON.parse(JSON.stringify(e));assert.deepEqual(e,round);assert.equal(e.blocks[0].text,'A title');assert.ok(e.blocks.every(b=>e.handout.slots[b.id]));assert.ok(!JSON.stringify(e.handout).includes('A title'));}
});
test('measured pagination handles long names, paragraphs, headings and every secret continuation',async()=>{
  const {layoutHandout,wrapText}=await load('handouts/layout.js'),{projectHandout}=await load('handouts/handoutcore.js');
  const measure=(s,font,style,size)=>[...s].length*size*.55;
  const e=fixture();e.name='The chronicle '.repeat(10);e.handout={kind:'book',cover:true,dropCap:false,fontSize:12};e.blocks=[{id:'one',kind:'text',secret:true,text:('Éowyn Ζωή Добрый Łukasz '+ 'A'.repeat(160)+'\n\n').repeat(80)}];
  const model=projectHandout(e,{gm:true,worldId:'test'}),layout=layoutHandout(model,measure);assert.ok(layout.pages.length>3);
  for(const page of layout.pages){assert.ok(page.ops.some(o=>o.text==='GM EDITION · MAY CONTAIN SECRETS'));for(const op of page.ops.filter(o=>o.kind==='text')){assert.ok(op.y>0&&op.y<page.height);if(op.align==='left')assert.ok(op.x+measure(op.text,op.font,op.style,op.size)<page.width+1);}}
  const lines=wrapText('A'.repeat(500),80,s=>s.length*6);assert.equal(lines.join(''),'A'.repeat(500));assert.ok(lines.every(s=>s.length*6<=80));
});
test('card sheets preserve order, page content, dimensions and GM labels',async()=>{
  const {cardSheets}=await load('handouts/layout.js');const pages=Array.from({length:5},(_,i)=>({width:198.43,height:297.64,gm:true,title:String(i),ops:[{kind:'text',x:12,y:20,text:String(i)}]}));
  const sheets=cardSheets(pages);assert.equal(sheets.length,2);assert.deepEqual(sheets.flatMap(p=>p.ops.filter(o=>o.kind==='text').map(o=>o.text)),['0','1','2','3','4']);assert.ok(sheets.every(p=>p.gm));
  for(const p of sheets)for(const op of p.ops)if(op.kind==='text')assert.ok(op.x<p.width&&op.y<p.height);
});
test('map fragments store a crop, and a hidden map never reaches players', async () => {
  const { projectHandout, initializeHandout } = await load('handouts/handoutcore.js');
  let n = 0;
  const frag = initializeHandout({ id: 'frag', name: 'A torn map', blocks: [] }, 'mapfragment', () => String(++n));
  frag.handout.map = { id: 'crypt', crop: { x: 0.2, y: 0.1, w: 0.5, h: 2 }, level: 1 };
  const crypt = { id: 'crypt', name: 'Crypt', map: { kind: 'dungeon' } }, entities = new Map([[frag.id, frag], [crypt.id, crypt]]);
  const shown = projectHandout(frag, { entities, worldId: 'w' });
  const image = shown.blocks.find((b) => b.kind === 'image');
  assert.equal(image.url, 'mapfrag:crypt:0.2,0.1,0.5,1:1', 'the crop is clamped to the map');
  assert.ok(!JSON.stringify(frag).includes('data:image'), 'no pixels are stored');
  crypt.gmOnly = true;
  const player = projectHandout(frag, { entities, worldId: 'w' });
  assert.ok(!player.blocks.some((b) => b.kind === 'image'));
  assert.match(player.warnings.join(' '), /hidden or missing/);
  assert.ok(projectHandout(frag, { entities, worldId: 'w', gm: true }).blocks.some((b) => b.kind === 'image'));
});
