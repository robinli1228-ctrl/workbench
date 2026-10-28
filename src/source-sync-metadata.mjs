import {contentHash,syncError,validateSourcePath,SOURCE_SYNC_LIMITS,DIRECTORY_SYNC_CAPTURE_POLICY,OUTPUT_SYNC_CAPTURE_POLICY} from './source-sync-manifest.mjs';

export const contentEqual=(a,b)=>a===null||b===null?a===b:a.hash===b.hash&&a.size===b.size;
export const absent=()=>({exists:false});
export const metadataEqual=(a,b)=>Boolean(a?.exists)===Boolean(b?.exists)&&(!a?.exists||a.mtimeNs===b.mtimeNs&&a.size===b.size);
export const identityEqual=(a,b)=>metadataEqual(a,b)&&(!a?.exists||['dev','ino','ctimeNs','mode'].every(k=>a[k]===b[k]));
export function statMetadata(s){return {exists:true,mtimeNs:String(s.mtimeNs),size:Number(s.size),dev:String(s.dev),ino:String(s.ino),ctimeNs:String(s.ctimeNs),mode:String(s.mode)};}
export function validateMetadata(m){
  if(!m||typeof m.exists!=='boolean'||m.hash!==undefined)throw syncError('invalid_metadata');
  if(m.exists&&(!/^-?\d+$/.test(m.mtimeNs)||!Number.isSafeInteger(m.size)||m.size<0||m.size>SOURCE_SYNC_LIMITS.fileBytes||['dev','ino','ctimeNs','mode'].some(k=>typeof m[k]!=='string'||! /^-?\d+$/.test(m[k]))))throw syncError('invalid_metadata');
  return m;
}
export function metadataDigest(entries,policy={}){
  if(!entries||typeof entries!=='object'||Array.isArray(entries))throw syncError('invalid_manifest');
  const paths=Object.keys(entries).sort(),aliases=new Set(),live=[];
  for(const path of paths){validateSourcePath(path,policy);validateMetadata(entries[path]);const alias=path.normalize('NFC').toLowerCase();if(aliases.has(alias))throw syncError('path_collision',path);aliases.add(alias);if(entries[path].exists)live.push(alias);}
  const files=new Set(live);for(const path of live){const parts=path.split('/');parts.pop();while(parts.length){if(files.has(parts.join('/')))throw syncError('path_collision',path);parts.pop();}}
  return contentHash(JSON.stringify(paths.map(path=>[path,entries[path]])));
}
export function validateMetadataCapture(s,c){if(s?.detection!=='metadata'||s.metadataOnly!==true||s.baseCommit!==null||s.capturePolicy!==(c.scopePolicy?.contentMode==='source-and-outputs'?OUTPUT_SYNC_CAPTURE_POLICY:DIRECTORY_SYNC_CAPTURE_POLICY)||!/^\d+:\d+$/.test(s.rootIdentity||'')||s.repositoryId!==c.repositoryId||s.generation!==c.generation||s.scopeKind!=='directory'||JSON.stringify(s.scopePolicy)!==JSON.stringify(c.scopePolicy)||!Array.isArray(s.excluded)||!c.boundedTransfers&&(s.excluded.length>SOURCE_SYNC_LIMITS.paths*2||Object.keys(s.entries||{}).length>SOURCE_SYNC_LIMITS.paths)||s.excluded.some(e=>typeof e?.path!=='string'||e.path.length>4096)||s.digest!==metadataDigest(s.entries,c.scopePolicy))throw syncError('invalid_manifest');}
/** Compare each clock to its own confirmed baseline. Identity only guards writes, not change detection. */
export function decideMetadata(base,current){
  const {a,b}=current;if(!a.exists&&!b.exists)return base&&!base.a.exists&&!base.b.exists?'unchanged':'absent';
  if(!base)return a.exists&&b.exists?'baseline_required':a.exists?'a':'b';
  const ca=!metadataEqual(base.a,a),cb=!metadataEqual(base.b,b);
  if(!ca&&!cb)return 'unchanged';if(ca&&!cb)return 'a';if(!ca&&cb)return 'b';
  return a.exists&&b.exists?'compare':'conflict';
}
