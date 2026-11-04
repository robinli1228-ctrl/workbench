/**
 * What a role or a Sessions-page CLI may read and write on each device with wb device: one level per device for reading
 * and one for writing, set in the project's settings (for its roles) or in a session's settings. Levels: none; project
 * (the project's folders on that device); platform (every project folder bound on that device); all (the whole device;
 * credentials and keys stay refused by the Worker). Unset devices read everything and write the project folder.
 */
export const DEVICE_ACCESS_LEVELS=Object.freeze(['none','project','platform','all']);
export const DEFAULT_DEVICE_ACCESS=Object.freeze({read:'all',write:'project'});

/** A stored map `{[nodeId]:{read,write}}`, kept only for valid levels; anything else is dropped. */
export function normalizeDeviceAccess(value){
  const result={};
  if(!value||typeof value!=='object'||Array.isArray(value))return result;
  for(const [nodeId,entry] of Object.entries(value)){
    if(typeof nodeId!=='string'||!nodeId||nodeId.length>200||!entry||typeof entry!=='object')continue;
    const clean={};for(const key of ['read','write'])if(DEVICE_ACCESS_LEVELS.includes(entry[key]))clean[key]=entry[key];
    if(Object.keys(clean).length)result[nodeId]=clean;
  }
  return result;
}

/** The levels that apply on one device for a project's roles or for a session. */
export function deviceAccessFor(owner,nodeId){
  const stored=normalizeDeviceAccess(owner?.deviceAccess)[nodeId]||{};
  return {read:stored.read||DEFAULT_DEVICE_ACCESS.read,write:stored.write||DEFAULT_DEVICE_ACCESS.write};
}

const projectFolders=(db,projectId,nodeId)=>[...new Set([
  db.get('workspaces',`${projectId}:${nodeId}`)?.localRoot,
  ...db.list('repositoryWorkspaces').filter(w=>w.projectId===projectId&&w.nodeId===nodeId).map(w=>w.localRoot),
].filter(root=>typeof root==='string'&&root))];

/**
 * The scope Home sends to the device's Worker for one level, or null when nothing may be touched. `projectId` names the
 * project of a role (its folders come first, so relative paths start there); `folder` is a session's own folder when it
 * sits on that device.
 */
export function deviceScope(db,level,{projectId=null,nodeId,folder=null}={}){
  if(!DEVICE_ACCESS_LEVELS.includes(level)||level==='none')return null;
  const own=[...(projectId?projectFolders(db,projectId,nodeId):[]),...(folder?[folder]:[])];
  if(level==='all')return {all:true,roots:[],base:own[0]||null};
  if(level==='project')return own.length?{all:false,roots:own,base:own[0]}:null;
  const every=[...new Set([...db.list('workspaces'),...db.list('repositoryWorkspaces')].filter(w=>w.nodeId===nodeId&&typeof w.localRoot==='string'&&w.localRoot).map(w=>w.localRoot))];
  const roots=[...new Set([...own,...every])];
  return roots.length?{all:false,roots,base:own[0]||null}:null;
}
