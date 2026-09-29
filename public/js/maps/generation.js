export function previewModel(map,kind,{signal,onProgress=()=>{},level=0}={}) {
  if(signal?.aborted)return Promise.reject(new DOMException('Cancelled','AbortError'));
  if(!kind.worker||typeof Worker==='undefined')return new Promise((resolve,reject)=>{
    requestAnimationFrame(()=>{if(signal?.aborted)return reject(new DOMException('Cancelled','AbortError'));try{resolve(kind.buildModel(map,level));}catch(e){reject(e);}});
  });
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./generation-worker.js',import.meta.url),{type:'module'});
    const cancel=()=>{worker.terminate();reject(new DOMException('Cancelled','AbortError'));};
    const done=()=>{worker.terminate();signal?.removeEventListener('abort',cancel);};
    signal?.addEventListener('abort',cancel,{once:true});
    worker.onmessage=({data})=>{onProgress(data.progress||0);if(data.error){done();reject(Error(data.error));}else if(data.model){done();resolve(data.model);}};
    worker.onerror=e=>{done();reject(Error(e.message||'Could not generate this preview'));};
    worker.postMessage(map);
  });
}
