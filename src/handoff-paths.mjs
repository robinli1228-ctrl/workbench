import {createHash} from 'node:crypto';

/** Device names can change; stable identifiers partition latest pointers without trusting path fragments. */
export function handoffDirectory(nodeId,reviewPrivate='',sessionId='') {
  const segment=value=>/^[a-zA-Z0-9_-]{1,100}$/.test(value)?value:createHash('sha256').update(String(value)).digest('hex');
  const base=reviewPrivate?`handoffs/private/${segment(reviewPrivate)}`:'handoffs';
  const scoped=sessionId?`${base}/sessions/${segment(sessionId)}`:base;
  return nodeId?`${scoped}/${segment(nodeId)}`:scoped;
}

/** Legacy latest pointers are read-only fallback, never moved or rewritten during migration. */
export function handoffReadPaths(nodeId,reviewPrivate='',sessionId='') {
  if(sessionId)return [`${handoffDirectory(nodeId,reviewPrivate,sessionId)}/LATEST.md`];
  return [...new Set([handoffDirectory(nodeId,reviewPrivate),handoffDirectory('',reviewPrivate)])].map(dir=>`${dir}/LATEST.md`);
}
