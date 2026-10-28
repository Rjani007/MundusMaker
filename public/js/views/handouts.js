import { el, uid, toast, slugify, downloadBlob, readSetting, writeSetting, compareNames } from '../util.js';
import { state, bus, visibleEntities, newEntity, saveEntity, scheduleSave, getEntity, requireSaved } from '../state.js';
import { api } from '../api.js';
import { HANDOUT_KINDS, PAGE_SIZES, ROLES, initializeHandout, presentation } from '../handouts/handoutcore.js';
import { prepareHandouts, drawHandoutPage, handoutPdf, handoutImages, zipImages } from '../handouts/output.js';
import { openCardPicker } from './cardpicker.js';

const field = (label, input) => { input.setAttribute('aria-label', label); return el('label', { class: 'handout-field' }, el('span', {}, label), input); };
function select(options, value, onchange, label) {
  const input=el('select', { onchange: () => onchange(input.value) }, Object.entries(options).map(([key,label])=>el('option',{value:key},label)));input.value=value;if(label)input.setAttribute('aria-label',label);return input;
}
const pageSizes = {a4:'A4',letter:'US Letter',card:'70 × 105 mm card',largecard:'100 × 150 mm card'};

export function render(container,id) {
  const page=el('div',{class:'page wide handout-page'}),wid=state.worldId;
  container.append(page);let closed=false,exportController=null,previewController=null,timer=null;
  const current=()=>!closed&&state.worldId===wid&&page.isConnected;
  const currentGm=()=>current()&&state.gm;
  const context=gm=>({worldId:wid,gm,entities:new Map([...state.entities].map(([id,e])=>[id,structuredClone(e)]))});
  const status=el('p',{class:'small muted',role:'status'}),cancel=el('button',{type:'button',hidden:true,onclick:()=>exportController?.abort()},'Cancel export');
  const edition=select({player:'Player edition',gm:'GM edition — includes secrets'},'player',()=>{});
  const sheets=el('input',{type:'checkbox',checked:true,'aria-label':'Arrange cards on printable sheets in the PDF'});
  const sheetSize=select({a4:'A4 sheets',letter:'US Letter sheets'},'a4',()=>{});
  const dpi=select({150:'150 DPI images',300:'300 DPI images'},'150',()=>{});
  const ink=el('input',{type:'checkbox','aria-label':'Ink-saving paper'});
  // Several images download one after another. The phone app offers one file
  // at a time, so there they always arrive as one ZIP.
  const bundle=el('input',{type:'checkbox','aria-label':'Put several images in one ZIP'});
  function exportOptions(){return el('div',{class:'handout-export-options'},state.gm?field('Edition',edition):null,field('Print sheet',sheetSize),field('Image resolution',dpi),
    el('label',{},sheets,' Arrange cards on sheets (PDF)'),el('label',{},ink,' Ink-saving paper'),window.mundusShell?null:el('label',{},bundle,' Several images in one ZIP'));}
  async function exportEntries(ids,format) {
    if(!current()||exportController)return;
    const gm=state.gm&&edition.value==='gm',entries=ids.map(getEntity).filter(e=>e&&(gm||!e.gmOnly));
    if(!entries.length){toast('There are no visible handouts in this selection.');return;}
    const controller=new AbortController();exportController=controller;cancel.hidden=false;
    try {
      await requireSaved();if(!current())return;
      const frozen=entries.map(e=>structuredClone(e)),ctx=context(gm),snapshot=JSON.stringify([...state.entities]);
      status.textContent='Preparing handouts…';const pdf=format==='pdf';
      // Card sheets are a print layout. Images keep every page at its own size,
      // so an item card exports as the card alone, not a mostly blank sheet.
      const prepared=await prepareHandouts(frozen,ctx,{signal:controller.signal,sheets:pdf&&sheets.checked,sheetSize:sheetSize.value,inkSaving:ink.checked,onProgress:p=>{status.textContent=`Preparing ${Math.round(p*100)}%`;}});
      if(!current()||gm&&!state.gm||controller.signal.aborted)return;
      const options={signal:controller.signal,dpi:Number(dpi.value),onProgress:p=>{status.textContent=`Exporting ${Math.round(p*100)}%`;}};
      const base=`${ids.length===1?slugify(entries[0].name):'handout-packet'}-${gm?'GM':'players'}`;
      let files=pdf?[{name:`${base}.pdf`,blob:new Blob([await handoutPdf(prepared,options)],{type:'application/pdf'})}]:await handoutImages(prepared,options);
      const zipped=!pdf&&files.length>1&&(bundle.checked||!!window.mundusShell);
      if(zipped)files=[{name:`${base}.zip`,blob:await zipImages(files)}];
      if(!current()||controller.signal.aborted||gm&&!state.gm)return;
      if(snapshot!==JSON.stringify([...state.entities]))throw Error('Content changed during export. Export again to use its current visibility and text.');
      let sent=0;
      for(const file of files){if(sent)await new Promise(resolve=>setTimeout(resolve,350));if(controller.signal.aborted||gm&&!state.gm)break;downloadBlob(file.blob,file.name);sent++;}
      if(sent<files.length){if(current())status.textContent=`Stopped after ${sent} of ${files.length} images.`;return;}
      const n=prepared.pages.length,count=`${n} ${pdf?(n===1?'page':'pages'):(n===1?'image':'images')}`;
      status.textContent=`Downloaded ${zipped?`a ZIP of ${count}`:count}.${!pdf&&!zipped&&n>1?' If your browser asks, allow this page to download several files.':''} ${prepared.warnings.join(' ')}`;
    } catch(err){if(current())status.textContent=err.name==='AbortError'?'Export cancelled.':`Could not export: ${err.message}`;}
    finally{if(exportController===controller)exportController=null;cancel.hidden=true;}
  }
  const cleanup=()=>{closed=true;clearTimeout(timer);previewController?.abort();exportController?.abort();bus.removeEventListener('change',changed);};
  let changed=()=>{};
  if(!id){
    page.append(el('div',{class:'handout-heading'},el('div',{},el('div',{class:'session-eyebrow'},'FROM YOUR WORLD TO THEIR HANDS'),el('h1',{},'Handouts'),el('p',{class:'muted'},'Letters, journals, discoveries and notices, ready for the table.'))));
    const selected=[],packet=el('div',{}),cards=el('div',{class:'handout-library-grid'}),search=el('input',{type:'search',placeholder:'Find a handout…','aria-label':'Find a handout',oninput:()=>refresh()});
    if(state.gm){
      const title=el('input',{placeholder:'e.g. A letter from Mara','aria-label':'New handout name',maxlength:160}),templates=el('div',{class:'handout-template-grid'});
      let making=false;
      for(const [kind,def] of Object.entries(HANDOUT_KINDS))templates.append(el('button',{type:'button',class:`handout-template handout-template-${kind}`,onclick:async()=>{
        if(!currentGm()||making)return;making=true;
        const draft=initializeHandout(newEntity(title.value.trim()||`Untitled ${def.label.toLowerCase()}`,'handout'),kind,uid);
        try{await saveEntity(draft);if(currentGm())location.hash=`#/handouts/${encodeURIComponent(draft.id)}`;}catch(err){toast(`Could not save: ${err.message}`);}finally{making=false;}
      }},el('span',{class:'handout-template-mark','aria-hidden':'true'},def.icon),el('strong',{},def.label),el('span',{class:'muted small'},def.description)));
      // One card opens in the designer; several join the packet, ready to export together.
      const cardsMade=({cards,made})=>{
        if(!currentGm()||!cards.length)return;
        if(cards.length===1){location.hash=`#/handouts/${encodeURIComponent(cards[0].id)}`;return;}
        for(const card of cards)if(!selected.includes(card.id))selected.push(card.id);
        persistPacket();refresh();refreshPacket();
        toast(`${made===1?'Made 1 card':`Made ${made} cards`}${cards.length>made?` and reused ${cards.length-made}`:''}. They are in your packet.`,4000);
      };
      page.append(el('div',{class:'handout-create'},el('h2',{},'Start with a template'),title,templates,
        el('div',{class:'row handout-from-library'},el('button',{type:'button',onclick:()=>{if(currentGm())openCardPicker(cardsMade);}},'◇ Cards from the library…'),el('span',{class:'muted small'},'Items, spells and monsters from the SRD and your imported 5etools packs.'))));
    }
    // A packet can belong to a Session entry (1.9): an ordered list of handout
    // IDs in session.handoutPacket, so it survives navigation and reloads.
    // Editing a handout never touches it. Without a session it lasts this visit.
    const sessionsList=()=>visibleEntities().filter(e=>e.type==='session').sort((a,b)=>(b.updated||'').localeCompare(a.updated||'')||compareNames(a.name, b.name));
    let packetSession='';try{packetSession=readSetting(`packet.${wid}`)||'';}catch{}
    if(!getEntity(packetSession))packetSession='';
    const loadPacket=()=>{selected.splice(0,selected.length,...(getEntity(packetSession)?.handoutPacket||[]).filter(pid=>getEntity(pid)));};
    const persistPacket=()=>{const s=getEntity(packetSession);if(!s||!state.gm||!current())return;s.handoutPacket=[...selected];scheduleSave(s);};
    loadPacket();
    function refreshPacket(){
      const sessionPick=select({'':'This visit only',...Object.fromEntries(sessionsList().map(s=>[s.id,s.name]))},packetSession,v=>{packetSession=v;try{writeSetting(`packet.${wid}`,v);}catch{}loadPacket();refresh();refreshPacket();},'Session this packet belongs to');
      packet.replaceChildren(el('h3',{},'Your handout packet'),state.gm?field('Packet for',sessionPick):'',el('p',{class:'muted small'},packetSession?'Saved with the session. Select entries below; this order is used for both PDF pages and page images.':'Select entries below. This order is used for both PDF pages and page images. Choose a session to keep the packet.'));
      selected.forEach((id,i)=>{const e=getEntity(id);if(!e||(!state.gm&&e.gmOnly))return;const move=delta=>{const j=i+delta;if(j<0||j>=selected.length)return;[selected[i],selected[j]]=[selected[j],selected[i]];persistPacket();refreshPacket();};
        packet.append(el('div',{class:'handout-packet-row'},el('span',{},`${i+1}. ${e.name}`),el('button',{type:'button',class:'ghost small',disabled:i===0,'aria-label':`Move ${e.name} earlier`,onclick:()=>move(-1)},'↑'),el('button',{type:'button',class:'ghost small',disabled:i===selected.length-1,'aria-label':`Move ${e.name} later`,onclick:()=>move(1)},'↓')));
      });
      packet.append(exportOptions(),el('div',{class:'row'},el('button',{class:'primary',disabled:!selected.length,onclick:()=>exportEntries([...selected],'pdf')},'Export packet PDF'),el('button',{disabled:!selected.length,onclick:()=>exportEntries([...selected],'png')},'Export packet images'),cancel),status);
    }
    function refresh(){
      if(!current())return;const entries=visibleEntities().filter(e=>(e.handout||e.type==='handout')&&e.name.toLowerCase().includes(search.value.toLowerCase())).sort((a,b)=>compareNames(a.name, b.name));cards.replaceChildren();
      if(!entries.length)cards.append(el('p',{class:'muted'},'Your handouts will appear here.'));
      for(const e of entries){const p=presentation(e),def=HANDOUT_KINDS[p.kind];cards.append(el('article',{class:'handout-library-card'},el('span',{class:'handout-card-mark','aria-hidden':'true'},def.icon),el('h3',{},el('a',{href:`#/handouts/${encodeURIComponent(e.id)}`},e.name)),el('p',{class:'muted small'},`${e.gmOnly?'GM-only · ':''}${def.label}`),el('label',{},el('input',{type:'checkbox',checked:selected.includes(e.id),onchange:ev=>{if(ev.target.checked){if(!selected.includes(e.id))selected.push(e.id);}else{const i=selected.indexOf(e.id);if(i>=0)selected.splice(i,1);}persistPacket();refreshPacket();}}),' Include in packet')));}
    }
    page.append(el('div',{class:'handout-section-heading'},el('h2',{},'In this world'),search),cards,el('div',{class:'card handout-packet'},packet));refresh();refreshPacket();changed=()=>refresh();bus.addEventListener('change',changed);return cleanup;
  }
  const entity=getEntity(id);
  if(!entity||(!state.gm&&entity.gmOnly)){page.append(el('div',{class:'notice'},'This handout is unavailable in this view.'));return cleanup;}
  const editable=state.gm,editCurrent=()=>currentGm()&&getEntity(id)===entity;
  const editor=el('div',{class:'handout-controls'}),preview=el('div',{class:'handout-preview'}),warnings=el('div',{class:'handout-warnings',role:'status'}),pageView=el('div',{class:'handout-paper'}),pagination=el('div',{class:'row handout-pagination'});
  let prepared=null,pageIndex=0,previewEdition='player',previewGeneration=0;
  function save(){if(!editCurrent())return;scheduleSave(entity);queuePreview();}
  const setStyle=(key,value)=>{if(!editCurrent())return;entity.handout??={kind:'letter',slots:{}};entity.handout[key]=value;save();};
  function showPage(){
    pageView.replaceChildren();pagination.replaceChildren();if(!prepared?.pages.length){pageView.append(el('p',{class:'notice'},'This entry is GM-only. It has no player pages.'));return;}
    pageIndex=Math.min(pageIndex,prepared.pages.length-1);const p=prepared.pages[pageIndex],canvas=drawHandoutPage(p,prepared.images,1.5);canvas.setAttribute('aria-label',`Handout preview, page ${pageIndex+1} of ${prepared.pages.length}`);canvas.setAttribute('role','img');pageView.append(canvas);
    pagination.append(el('button',{class:'ghost small',disabled:pageIndex===0,onclick:()=>{pageIndex--;showPage();}},'← Previous'),el('span',{},`${pageIndex+1} / ${prepared.pages.length}`),el('button',{class:'ghost small',disabled:pageIndex===prepared.pages.length-1,onclick:()=>{pageIndex++;showPage();}},'Next →'));
  }
  async function updatePreview(){
    if(!current())return;previewController?.abort();const controller=new AbortController();previewController=controller;const generation=++previewGeneration;
    warnings.textContent='Laying out pages…';
    try{const result=await prepareHandouts([structuredClone(entity)],context(state.gm&&previewEdition==='gm'),{signal:controller.signal});if(!current()||generation!==previewGeneration||controller.signal.aborted)return;prepared=result;warnings.replaceChildren(...result.warnings.map(w=>el('p',{class:'notice warn'},w)));showPage();}
    catch(err){if(current()&&generation===previewGeneration&&err.name!=='AbortError')warnings.textContent=err.message;}
  }
  function queuePreview(){clearTimeout(timer);previewController?.abort();timer=setTimeout(updatePreview,240);}
  page.append(el('div',{class:'handout-heading'},el('div',{},el('a',{href:'#/handouts',class:'small'},'← All handouts'),el('h1',{},entity.name)),el('a',{href:`#/e/${encodeURIComponent(id)}`},'Entry, name & links →')));
  if(editable){
    const p=presentation(entity);
    editor.append(el('h2',{},'Design'),field('Template',select(Object.fromEntries(Object.entries(HANDOUT_KINDS).map(([k,v])=>[k,v.label])),p.kind,value=>{if(!editCurrent())return;entity.handout={...entity.handout,...presentation({handout:{kind:value}})};save();window.dispatchEvent(new HashChangeEvent('hashchange'));})),
      el('div',{class:'handout-style-grid'},field('Page size',select(pageSizes,p.size,v=>setStyle('size',v))),field('Typeface',select({serif:'Book serif',sans:'Clear sans'},p.font,v=>setStyle('font',v))),field('Paper',select({white:'White',ivory:'Ivory',aged:'Worn parchment'},p.paper,v=>setStyle('paper',v))),field('Border',select({none:'None',rule:'Fine rule',double:'Double rule',ornament:'Corner ornaments'},p.border,v=>setStyle('border',v)))),
      el('div',{class:'handout-style-grid'},field('Type size',el('input',{type:'number',min:8,max:24,value:p.fontSize,onchange:ev=>setStyle('fontSize',Number(ev.target.value))})),field('Margins (mm)',el('input',{type:'number',min:6,max:35,value:p.margin,onchange:ev=>setStyle('margin',Number(ev.target.value))})),field('Line spacing',select({'1.2':'Compact','1.35':'Card spacing','1.55':'Comfortable','1.8':'Spacious'},String(p.lineHeight),v=>setStyle('lineHeight',Number(v)))),field('Ink',el('input',{type:'color',value:p.ink,oninput:ev=>setStyle('ink',ev.target.value)}))),
      el('div',{class:'handout-checks'},[['cover','Book cover'],['dropCap','Decorative initial'],['pageNumbers','Page numbers']].map(([key,label])=>el('label',{},el('input',{type:'checkbox',checked:!!p[key],onchange:ev=>setStyle(key,ev.target.checked)}),label))));
    const privateCheck=el('input',{type:'checkbox',checked:!!entity.gmOnly,onchange:ev=>{if(!editCurrent())return;entity.gmOnly=ev.target.checked;save();}});
    editor.append(el('label',{class:'handout-private'},privateCheck,' Entire entry is GM-only'));
    const imageStatus=el('span',{class:'muted small'},entity.image?'Local image attached':'No illustration or seal'),imageInput=el('input',{type:'file',accept:'image/png,image/jpeg,image/webp,image/gif',hidden:true,onchange:async()=>{
      const file=imageInput.files[0];if(!file||!editCurrent())return;if(file.size>8*1024*1024){toast('Choose an image smaller than 8 MB.');return;}
      try{const buffer=await file.arrayBuffer();let binary='';const bytes=new Uint8Array(buffer);for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));if(!editCurrent())return;const result=await api.uploadAsset(`${id}-${file.name}`,btoa(binary));if(!editCurrent())return;entity.image=result.file;imageStatus.textContent='Local image attached';save();}catch(err){if(current())toast(`Could not attach image: ${err.message}`);}
    }});
    editor.append(el('details',{class:'handout-section'},el('summary',{},'Illustration / letter seal'),el('p',{class:'muted small'},'Use a local image. Its proportions are preserved. Letters place it below the signature.'),imageInput,el('div',{class:'row'},el('button',{class:'small',onclick:()=>imageInput.click()},'Choose image'),el('button',{class:'ghost small',onclick:()=>{if(!editCurrent())return;entity.image=null;imageStatus.textContent='No illustration or seal';save();}},'Clear image'),imageStatus)));
    const sourcePanel=el('details',{class:'handout-section'},el('summary',{},'Linked campaign material'));
    function sourceControls(){
      while(sourcePanel.children.length>1)sourcePanel.lastChild.remove();const h=entity.handout||{},sources=visibleEntities().filter(e=>e.id!==id).sort((a,b)=>compareNames(a.name, b.name));
      sourcePanel.append(el('p',{class:'muted small'},'Choose the properties and text to include. A hidden, secret or deleted source is omitted from player output.'),field('Source entry',select({'':'No source',...Object.fromEntries(sources.map(e=>[e.id,`${e.gmOnly?'GM-only · ':''}${e.name}`]))},h.sourceId||'',v=>{
        if(!editCurrent())return;entity.handout??={kind:'letter',slots:{}};entity.handout.sourceId=v;entity.handout.sourceFields=[];entity.handout.sourceBlocks=[];
        if(v&&!entity.relations.some(r=>r.to===v))entity.relations.push({to:v,label:'Source',secret:false});save();sourceControls();
      })));
      const source=getEntity(h.sourceId);if(!source)return;
      sourcePanel.append(el('label',{},el('input',{type:'checkbox',checked:!!h.sourceImage,onchange:ev=>setStyle('sourceImage',ev.target.checked)}),' Use source illustration when no own image is attached'));
      for(const key of Object.keys(source.fields||{}))sourcePanel.append(el('label',{},el('input',{type:'checkbox',checked:h.sourceFields?.includes(key),onchange:ev=>{if(!editCurrent())return;const list=new Set(h.sourceFields||[]);ev.target.checked?list.add(key):list.delete(key);setStyle('sourceFields',[...list]);}}),` ${key}`));
      for(const b of source.blocks||[])if(['text','heading','quote'].includes(b.kind)&&b.text?.trim())sourcePanel.append(el('label',{},el('input',{type:'checkbox',checked:h.sourceBlocks?.includes(b.id),onchange:ev=>{if(!editCurrent())return;const list=new Set(h.sourceBlocks||[]);ev.target.checked?list.add(b.id):list.delete(b.id);setStyle('sourceBlocks',[...list]);}}),` ${b.secret?'Secret · ':''}${b.text.slice(0,85)}`));
    }sourceControls();editor.append(sourcePanel);
    if(p.kind==='mapfragment'){
      // only the map's ID and a crop are stored; the preview and every export
      // draw the player map fresh, so later map edits show up here
      const maps=visibleEntities().filter(e=>e.map).sort((a,b)=>compareNames(a.name, b.name));
      const frag=()=>entity.handout.map||{},crop=()=>({x:0,y:0,w:1,h:1,...(frag().crop||{})});
      const setMap=patch=>{if(!editCurrent())return;entity.handout.map={...frag(),...patch};save();};
      const slider=(label,key)=>field(label,el('input',{type:'range',min:0,max:100,step:1,value:Math.round(crop()[key]*100),oninput:ev=>setMap({crop:{...crop(),[key]:Number(ev.target.value)/100}})}));
      editor.append(el('details',{class:'handout-section',open:true},el('summary',{},'Map fragment'),
        el('p',{class:'muted small'},'Drawn from the player version of the map: secret markers and links to hidden entries never appear.'),
        field('Map',select({'':'Choose a map',...Object.fromEntries(maps.map(e=>[e.id,`${e.gmOnly?'GM-only · ':''}${e.name}`]))},frag().id||'',v=>setMap({id:v||null}))),
        el('div',{class:'handout-style-grid'},slider('Left %','x'),slider('Top %','y'),slider('Width %','w'),slider('Height %','h')),
        field('Level',el('input',{type:'number',min:1,max:5,value:(frag().level||0)+1,onchange:ev=>setMap({level:Math.max(0,Number(ev.target.value)-1)})}))));
    }
    const writing=el('div',{class:'handout-writing'});
    function refreshWriting(){
      writing.replaceChildren(el('h2',{},'Write'));
      entity.blocks.forEach((block,index)=>{
        if(!['text','heading','quote'].includes(block.kind)){writing.append(el('p',{class:'muted small'},'This entry also contains a non-text block. Open the entry to edit it.'));return;}
        const role=entity.handout?.slots?.[block.id]||(block.kind==='heading'?'heading':'body');
        const input=el('textarea',{rows:role==='body'?7:2,'aria-label':`${ROLES[role]||'Text'} text`,oninput:()=>{if(!editCurrent())return;block.text=input.value;save();}});input.value=block.text||'';
        const move=delta=>{if(!editCurrent())return;const j=index+delta;if(j<0||j>=entity.blocks.length)return;[entity.blocks[index],entity.blocks[j]]=[entity.blocks[j],entity.blocks[index]];save();refreshWriting();};
        writing.append(el('section',{class:`handout-block${block.secret?' secret':''}`},el('div',{class:'handout-block-tools'},select(ROLES,role,v=>{if(!editCurrent())return;entity.handout??={kind:'letter',slots:{}};(entity.handout.slots??={})[block.id]=v;block.kind=v==='heading'||v==='title'?'heading':v==='signature'?'quote':'text';save();},'Block placement'),
          el('label',{},el('input',{type:'checkbox',checked:!!block.secret,onchange:ev=>{if(!editCurrent())return;block.secret=ev.target.checked;save();refreshWriting();}}),' Secret'),el('button',{class:'ghost small',disabled:index===0,'aria-label':'Move block earlier',onclick:()=>move(-1)},'↑'),el('button',{class:'ghost small',disabled:index===entity.blocks.length-1,'aria-label':'Move block later',onclick:()=>move(1)},'↓')),input));
      });
      writing.append(el('div',{class:'row'},el('button',{class:'small',onclick:()=>addBlock(false)},'+ Text block'),el('button',{class:'small ghost',onclick:()=>addBlock(true)},'+ GM annotation')),el('p',{class:'muted small'},'Text is saved in the entry’s normal blocks. Empty blocks do not print. Use the entry page to remove blocks or rename the entry.'));
    }
    function addBlock(secret){if(!editCurrent())return;entity.blocks.push({id:uid(),kind:'text',text:'',secret});save();refreshWriting();writing.querySelector('section:last-of-type textarea')?.focus();}
    refreshWriting();editor.append(writing);
  }
  preview.append(el('div',{class:'handout-preview-head'},el('h2',{},'Print preview'),editable?select({player:'As players see it',gm:'GM edition'},'player',v=>{previewEdition=v;queuePreview();}):el('span',{class:'muted small'},'Player edition')),warnings,pageView,pagination,
    el('details',{class:'card handout-export',open:true},el('summary',{},'Share this handout'),exportOptions(),el('div',{class:'row'},el('button',{class:'primary',onclick:()=>exportEntries([id],'pdf')},'Export PDF'),el('button',{onclick:()=>exportEntries([id],'png')},'Export image'),cancel),status),
    el('p',{class:'muted small'},'Preview, PDF and images use the same page layout. PDF text stays selectable.'));
  page.append(el('div',{class:`handout-designer${editable?'':' preview-only'}`},editable?editor:null,preview));
  let sourceSnapshot='';changed=()=>{const h=entity.handout||{},snapshot=JSON.stringify(getEntity(h.sourceId));if(sourceSnapshot!==snapshot){sourceSnapshot=snapshot;queuePreview();}};bus.addEventListener('change',changed);
  updatePreview();return cleanup;
}
