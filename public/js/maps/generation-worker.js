import { buildWorldModel } from './world.js';
import { buildRegionModel } from './region.js';
const builders={world:buildWorldModel,region:buildRegionModel};
self.onmessage=({data})=>{
  try{self.postMessage({progress:.15});const model=builders[data.kind](data);self.postMessage({progress:1,model});}
  catch(error){self.postMessage({error:error.message||String(error)});}
};
