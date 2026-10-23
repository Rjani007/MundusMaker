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
test('image exports keep a card at card size and name one file per page', async () => {
  const { layoutHandout, pageImageNames, cardSheets } = await load('handouts/layout.js');
  const { projectHandout, initializeHandout, PAGE_SIZES } = await load('handouts/handoutcore.js');
  const measure = (s, font, style, size) => [...s].length * size * .55;
  let n = 0;
  const card = initializeHandout({ id: 'key', name: 'Brass key', blocks: [] }, 'card', () => String(++n));
  const pages = layoutHandout(projectHandout(card, { worldId: 'w' }), measure).pages;
  assert.equal(pages.length, 1);
  assert.deepEqual([pages[0].width, pages[0].height], PAGE_SIZES.card, 'the image is the card, not a sheet');
  assert.deepEqual([cardSheets(pages)[0].width, cardSheets(pages)[0].height], PAGE_SIZES.a4, 'sheets are the PDF layout');
  assert.deepEqual(pageImageNames(pages), ['brass-key-players.png']);

  const book = { id: 'book', name: 'Chronicle', type: 'handout', handout: { kind: 'book', cover: true }, blocks: [{ id: 't', kind: 'text', text: 'Words '.repeat(900) }] };
  const bookPages = layoutHandout(projectHandout(book, { worldId: 'w', gm: true }), measure).pages;
  assert.ok(bookPages.length > 1 && bookPages.every((p) => p.id === 'book'));
  const twin = { ...pages[0], id: 'other-key' }, untitled = { ...pages[0], id: 'blank', title: '  ' };
  const names = pageImageNames([...pages, ...bookPages, twin, untitled]);
  assert.equal(names.length, bookPages.length + 3);
  assert.equal(new Set(names).size, names.length, 'every file name is unique');
  assert.equal(names[0], 'brass-key-players.png');
  assert.equal(names[1], `chronicle-GM-p${'1'.padStart(String(bookPages.length).length, '0')}.png`);
  assert.ok(names.slice(1, -2).every((name) => /^chronicle-GM-p\d+\.png$/.test(name)));
  assert.deepEqual(names.slice(-2), ['brass-key-players-2.png', 'handout-players.png']);
});
test('library cards keep their text in blocks, credit the SRD and hide monster numbers from players', async () => {
  const { libraryCard, isCardFor } = await load('handouts/librarycards.js');
  const { projectHandout } = await load('handouts/handoutcore.js');
  const { normalizeItem, normalizeSpell } = await load('importers.js');
  let n = 0;
  const make = (kind, row) => libraryCard(kind, row, { id: `${kind}-card`, name: `${row.name} card`, type: 'handout', blocks: [], relations: [] }, () => `b${++n}`);
  const text = (e, gm = false) => projectHandout(e, { worldId: 'w', gm }).blocks.map((b) => b.text).join('\n');
  const equipment = require('../public/srd52/equipment.json').equipment, spells = require('../public/srd52/spells.json').spells;

  const sword = { ...normalizeItem(equipment.find((i) => i.name === 'Longsword')), _pack: 'SRD 5.2' };
  const swordCard = make('item', sword);
  assert.equal(swordCard.handout.kind, 'card');
  assert.equal(swordCard.blocks[0].text, 'Longsword');
  assert.equal(swordCard.handout.slots[swordCard.blocks[0].id], 'title');
  assert.match(text(swordCard), /Martial weapon/);
  assert.match(text(swordCard), /Damage: 1d8 slashing/);
  assert.match(text(swordCard), /Properties: Versatile/);
  assert.match(text(swordCard), /SRD 5\.2 · CC-BY-4\.0/);
  assert.ok(!JSON.stringify(swordCard.handout).includes('slashing'), 'no text is copied into entity.handout');
  assert.deepEqual(JSON.parse(JSON.stringify(swordCard)), swordCard);
  assert.ok(isCardFor(swordCard, 'item', sword));
  assert.ok(!isCardFor(swordCard, 'item', { ...sword, _pack: 'My pack' }), 'the same name in another pack is another card');
  assert.ok(!isCardFor(swordCard, 'spell', sword));

  const shield = { ...normalizeItem(equipment.find((i) => i.name === 'Shield')), _pack: 'SRD 5.2' };
  assert.match(text(make('item', shield)), /Armor Class: \+2/);

  const cloak = { ...normalizeItem({ name: 'Cloak of Elvenkind', wondrous: true, rarity: 'uncommon', reqAttune: true, entries: ['While you wear this cloak, you have advantage on Dexterity (Stealth) checks.'], source: 'DMG' }), _pack: 'My pack' };
  const cloakText = text(make('item', cloak));
  assert.match(cloakText, /Wondrous item · uncommon · requires attunement/);
  assert.match(cloakText, /advantage on Dexterity/);
  assert.ok(!/CC-BY/.test(cloakText), 'imported packs get no SRD credit');

  const fireball = { ...normalizeSpell(spells.find((s) => s.name === 'Fireball')), _pack: 'SRD 5.2' };
  const fireText = text(make('spell', fireball));
  assert.match(fireText, /Level 3 Evocation/);
  assert.match(fireText, /Range: 150 feet/);
  assert.match(fireText, /Classes: Sorcerer, Wizard/);

  const dragon = { ...require('../public/bestiary/srd-bestiary.json').monster.find((m) => m.name === 'Adult Bronze Dragon'), _pack: 'SRD' };
  const dragonCard = make('monster', dragon);
  assert.match(text(dragonCard), /Huge dragon, lawful good/);
  assert.match(text(dragonCard), /SRD 5\.1/);
  assert.ok(!/Armor Class|Hit Points|212/.test(text(dragonCard)), 'players never see the numbers');
  assert.match(text(dragonCard, true), /Hit Points: 212/);
});

test('fitCard picks the smallest change that keeps a card on one slot', async () => {
  const { fitCard, layoutHandout } = await load('handouts/layout.js');
  const { libraryCard } = await load('handouts/librarycards.js');
  const { projectHandout } = await load('handouts/handoutcore.js');
  const measure = (s, font, style, size) => [...s].length * size * .5;
  let n = 0;
  const card = (body) => libraryCard('spell', { name: 'Test spell', level: 1, school: 'Evocation', castingTime: '1 action', range: '60 feet', components: 'V, S', duration: 'Instantaneous', classes: [], text: body, _pack: 'Pack' }, { id: 'c', name: 'Test spell card', type: 'handout', blocks: [], relations: [] }, () => `b${++n}`);
  const pages = (e) => layoutHandout(projectHandout(e, { worldId: 'w' }), measure).pages.length;

  const short = card('A short spell.');
  assert.equal(fitCard(short, measure, 'w'), true);
  assert.deepEqual([short.handout.size, short.handout.fontSize], ['card', 10]);

  const long = card('Words that run on and on. '.repeat(40));
  assert.ok(pages(card('Words that run on and on. '.repeat(40))) > 1, 'too long for the standard card as made');
  assert.equal(fitCard(long, measure, 'w'), true);
  assert.notDeepEqual([long.handout.size, long.handout.fontSize], ['card', 10]);
  assert.equal(pages(long), 1);

  const endless = card('Words that run on and on. '.repeat(400));
  assert.equal(fitCard(endless, measure, 'w'), false);
  assert.deepEqual([endless.handout.size, endless.handout.fontSize], ['largecard', 8], 'left at the roomiest size');
});
