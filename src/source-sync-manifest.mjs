import {createHash} from 'node:crypto';
import {tr} from './i18n.mjs';

export const SOURCE_SYNC_LIMITS=Object.freeze({fileBytes:20*1024*1024,batchBytes:100*1024*1024,paths:10000,projectBytes:1024*1024*1024});
// Earlier unshipped captures cannot prove the ignored-path scope used by deletion decisions.
export const SOURCE_SYNC_CAPTURE_POLICY=2;
export const DIRECTORY_SYNC_CAPTURE_POLICY=3;
export const OUTPUT_SYNC_CAPTURE_POLICY=4;
export const includesSyncOutputs=policy=>policy?.contentMode==='source-and-outputs';
export const contentHash=bytes=>createHash('sha256').update(bytes).digest('hex');

/** Codes are stable protocol values; localized detail does not participate in identity. */
export function syncError(code,detail='') {
  const metadataMessages={metadata_two_devices:'sourceSync.metadataTwoDevices',metadata_baseline_required:'sourceSync.metadataBaseline',invalid_metadata:'sourceSync.invalidMetadata'};
  return Object.assign(new Error(tr('sourceSync.failure',{code,detail:detail||(metadataMessages[code]?tr(metadataMessages[code]):'')})),{code});
}

/** Keep bounded limit evidence separate from localized messages and file contents. */
export function syncLimitError(code,kind,maximum,actual,path='') {
  return Object.assign(syncError(code,path),{limit:{kind,path:String(path).slice(0,4096),maximum,actual}});
}

/** Mandatory exclusions apply even to tracked files and cannot be relaxed by a sender. */
export function excludedSourcePath(path,policy={}) {
  const parts=String(path).split('/');
  const shared=policy.sharedDocs===true&&parts[0]==='.workbench'&&parts[1]==='docs'&&parts.length>2;
  if(!shared&&policy.onlySharedDocs||(policy.excludeRoots||[]).some(root=>root?(path===root||path.startsWith(root+'/')):!shared))return true;
  if(includesSyncOutputs(policy))return parts.some(part=>/^(?:\.git|\.worktrees|\.data|node_modules|vendor|\.venv|venv|__pycache__|\.codex|\.claude|\.ssh|\.netrc|_netrc|\.npmrc|\.pypirc|\.agent-workbench-project\.json|worker-config\.json|auth(?:-profiles)?\.json|build|dist)$/i.test(part)
    ||/^\.wb-(?:bridge|source-sync)-/i.test(part)||/^\.env(?:\..*)?$/i.test(part)
    ||/^(?:credentials?|secrets?|tokens?)(?:.*)$/i.test(part)||/^(?:api|worker|access|refresh)[-_]token(?:\.|$)/i.test(part)
    ||/^(?:home|worker)(?:[-_.].*)?\.(?:sqlite|db)(?:[-.].*)?$/i.test(part)||/^(?:id_rsa|id_ed25519|id_ecdsa)(?:\.|$)/i.test(part)
    ||/\.(?:pem|key|p12|pfx)$/i.test(part));
  return parts.some((part,i)=>!(shared&&i===0)&&(/^(?:\.git|\.workbench|\.worktrees|\.data|\.local|\.migration|\.DS_Store|\.attachments|node_modules|vendor|dist|build|target|coverage|\.next|\.cache|__pycache__|\.venv|\.codex|\.claude|\.ssh|\.netrc|_netrc|\.npmrc)$/i.test(part)
    ||part.startsWith('.wb-bridge-')||part.startsWith('.wb-source-sync-')||/^\.env(?:\..*)?$/i.test(part)&&!/^\.env\.(?:example|sample|template)$/i.test(part)
    ||/^(?:credentials?|secrets?|tokens?)(?:\.|$)/i.test(part)||/^(?:id_rsa|id_ed25519|id_ecdsa)(?:\.|$)/i.test(part)
    ||/\.(?:pem|key|p12|pfx|log)$/i.test(part)));
}

/** Reject nonportable names before filesystem access; conservative aliases avoid cross-OS overwrites. */
export function validateSourcePath(path,policy={}) {
  if(typeof path!=='string'||!path||path.length>4096||path.startsWith('/')||/[\\\x00-\x1f\x7f:]/.test(path)
    ||path.split('/').some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p))||excludedSourcePath(path,policy))throw syncError('unsafe_path',String(path));
  return path;
}

export function validateEntry(entry) {
  if(entry===null)return null;
  if(!entry||typeof entry!=='object'||!/^[a-f0-9]{64}$/.test(entry.hash)||!Number.isSafeInteger(entry.size)||entry.size<0
    ||entry.size>SOURCE_SYNC_LIMITS.fileBytes||typeof entry.executable!=='boolean')throw syncError('invalid_entry');
  return entry;
}

export function entryEqual(a,b) {
  validateEntry(a);validateEntry(b);
  return a===null||b===null?a===b:a.hash===b.hash&&a.size===b.size&&a.executable===b.executable;
}

/** Link unique same-content add/delete pairs while retaining per-file, non-atomic receipts. */
export function linkSourceMoves(changes){
  for(const removed of changes.filter(c=>c.before&&c.after===null)){
    const matches=changes.filter(c=>c.before===null&&c.after&&entryEqual(removed.before,c.after));
    if(matches.length!==1||changes.filter(c=>c.after===null&&c.before&&entryEqual(c.before,removed.before)).length!==1)continue;
    const added=matches[0],move={id:contentHash(JSON.stringify([removed.path,added.path,added.after.hash])),from:removed.path,to:added.path};removed.move=move;added.move=move;
  }
  return changes;
}

/** Proven absence is null; an unknown baseline must never masquerade as an absent file. */
export function compareEntry(base,local,incoming) {
  validateEntry(base);validateEntry(local);validateEntry(incoming);
  if(entryEqual(local,incoming))return 'equal';
  if(entryEqual(local,base))return 'apply';
  if(entryEqual(incoming,base))return 'retain';
  return 'conflict';
}

/** Sorting is bytewise, not locale dependent; path aliases and file/parent collisions are rejected. */
export function manifestDigest(entries,policy={}) {
  if(!entries||typeof entries!=='object'||Array.isArray(entries))throw syncError('invalid_manifest');
  const paths=Object.keys(entries).sort();if(paths.length>SOURCE_SYNC_LIMITS.paths)throw syncError('manifest_too_large');
  const aliases=new Set(),live=[];
  for(const path of paths) {
    validateSourcePath(path,policy);validateEntry(entries[path]);
    const alias=path.normalize('NFC').toLowerCase();
    if(aliases.has(alias))throw syncError('path_collision',path);
    aliases.add(alias);if(entries[path]!==null)live.push(alias);
  }
  const files=new Set(live);
  for(const path of live){const parts=path.split('/');parts.pop();while(parts.length){if(files.has(parts.join('/')))throw syncError('path_collision',path);parts.pop();}}
  return contentHash(JSON.stringify(paths.map(path=>{const e=entries[path];return [path,e===null?null:[e.hash,e.size,e.executable]];})));
}

/** Protocol versions distinguish filesystem baselines from real Git commits; never invent a SHA for a directory. */
export function validateSourceCapture(snapshot,command={}) {
  const directory=command.scopeKind==='directory',policy=directory?command.scopePolicy||{}:{};
  const outputs=directory&&includesSyncOutputs(policy);
  if(snapshot?.capturePolicy!==(outputs?OUTPUT_SYNC_CAPTURE_POLICY:directory?DIRECTORY_SYNC_CAPTURE_POLICY:SOURCE_SYNC_CAPTURE_POLICY)
    ||Boolean(snapshot.metadataOnly)!==Boolean(outputs&&command.preview))throw syncError('snapshot_policy_unsupported');
  if(directory?(snapshot.scopeKind!=='directory'||snapshot.baseCommit!==null||JSON.stringify(snapshot.scopePolicy)!==JSON.stringify(policy)):!/^[a-f0-9]{40,64}$/.test(snapshot.baseCommit||''))throw syncError('invalid_manifest');
  if(manifestDigest(snapshot.entries,policy)!==snapshot.digest)throw syncError('invalid_manifest');
  return snapshot;
}
