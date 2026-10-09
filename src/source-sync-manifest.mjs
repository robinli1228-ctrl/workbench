import {createHash} from 'node:crypto';
import {tr} from './i18n.mjs';

export const SOURCE_SYNC_LIMITS=Object.freeze({fileBytes:20*1024*1024,batchBytes:100*1024*1024,paths:10000,projectBytes:1024*1024*1024});
// Earlier unshipped captures cannot prove the ignored-path scope used by deletion decisions.
export const SOURCE_SYNC_CAPTURE_POLICY=2;
export const contentHash=bytes=>createHash('sha256').update(bytes).digest('hex');

/** Codes are stable protocol values; localized detail does not participate in identity. */
export function syncError(code,detail='') {
  return Object.assign(new Error(tr('sourceSync.failure',{code,detail})),{code});
}

/** Mandatory exclusions apply even to tracked files and cannot be relaxed by a sender. */
export function excludedSourcePath(path) {
  const parts=String(path).split('/');
  return parts.some(part=>/^(?:\.git|\.workbench|\.worktrees|\.data|\.local|\.attachments|node_modules|vendor|dist|build|target|coverage|\.next|\.cache|__pycache__|\.venv|\.codex|\.claude|\.ssh|\.netrc|_netrc|\.npmrc)$/i.test(part)
    ||part.startsWith('.wb-bridge-')||part.startsWith('.wb-source-sync-')||/^\.env(?:\..*)?$/i.test(part)&&!/^\.env\.(?:example|sample|template)$/i.test(part)
    ||/^(?:credentials?|secrets?|tokens?)(?:\.|$)/i.test(part)||/^(?:id_rsa|id_ed25519|id_ecdsa)(?:\.|$)/i.test(part)
    ||/\.(?:pem|key|p12|pfx|log)$/i.test(part));
}

/** Reject nonportable names before filesystem access; conservative aliases avoid cross-OS overwrites. */
export function validateSourcePath(path) {
  if(typeof path!=='string'||!path||path.length>4096||path.startsWith('/')||/[\\\x00-\x1f\x7f:]/.test(path)
    ||path.split('/').some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p))||excludedSourcePath(path))throw syncError('unsafe_path',String(path));
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

/** Proven absence is null; an unknown baseline must never masquerade as an absent file. */
export function compareEntry(base,local,incoming) {
  validateEntry(base);validateEntry(local);validateEntry(incoming);
  if(entryEqual(local,incoming))return 'equal';
  if(entryEqual(local,base))return 'apply';
  if(entryEqual(incoming,base))return 'retain';
  return 'conflict';
}

/** Sorting is bytewise, not locale dependent; path aliases and file/parent collisions are rejected. */
export function manifestDigest(entries) {
  if(!entries||typeof entries!=='object'||Array.isArray(entries))throw syncError('invalid_manifest');
  const paths=Object.keys(entries).sort();if(paths.length>SOURCE_SYNC_LIMITS.paths)throw syncError('manifest_too_large');
  const aliases=new Set(),live=[];
  for(const path of paths) {
    validateSourcePath(path);validateEntry(entries[path]);
    const alias=path.normalize('NFC').toLowerCase();
    if(aliases.has(alias))throw syncError('path_collision',path);
    aliases.add(alias);if(entries[path]!==null)live.push(alias);
  }
  const files=new Set(live);
  for(const path of live){const parts=path.split('/');parts.pop();while(parts.length){if(files.has(parts.join('/')))throw syncError('path_collision',path);parts.pop();}}
  return contentHash(JSON.stringify(paths.map(path=>{const e=entries[path];return [path,e===null?null:[e.hash,e.size,e.executable]];})));
}
