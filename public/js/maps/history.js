// Editor transactions contain map data only. They never undo entry creation,
// edit a linked entity, or introduce another persistence/secrecy mechanism.
export function replaceMapData(map,next) {
  const params=map.params||{};
  for(const key of Object.keys(map))delete map[key];Object.assign(map,structuredClone(next));
  for(const key of Object.keys(params))delete params[key];Object.assign(params,map.params||{});map.params=params;
}
export function mapHistory(map,limit=80) {
  let states=[JSON.stringify(map)],cursor=0,group=0;
  const record=()=>{
    if(group)return false;const next=JSON.stringify(map);if(next===states[cursor])return false;
    states=states.slice(0,cursor+1);states.push(next);if(states.length>limit)states.shift();cursor=states.length-1;return true;
  };
  return {record,begin(){group++;},end(){group=Math.max(0,group-1);record();},
    get canUndo(){return cursor>0;},get canRedo(){return cursor<states.length-1;},
    undo(){if(cursor<=0)return false;replaceMapData(map,JSON.parse(states[--cursor]));return true;},
    redo(){if(cursor>=states.length-1)return false;replaceMapData(map,JSON.parse(states[++cursor]));return true;},
  };
}
