import {share} from './share-mode.js';

/**
 * Where the page was left: Sessions or group chat, which session, which project and conversation. Each tab keeps its own
 * place in sessionStorage, which dies with the tab; on a phone the system closes a backgrounded app after a while, so the
 * app opened again at the default view. A copy of the place is kept in localStorage and a tab with no place of its own
 * (a fresh start, a new tab) starts from it. A place that no longer exists falls back to the default view as before.
 * Share links carry their own place and never read or write this copy.
 */
export const PLACE_KEYS=['agent-workbench.navigation-mode','agent-workbench.project','agent-workbench.conversation','agent-workbench.native-session'];
const STORE='agent-workbench.last-place';

/** Start a tab with no place of its own from the copy; a tab that already has one keeps it. */
export function restorePlace(session,local) {
  if(PLACE_KEYS.some(key=>session.getItem(key)!==null))return false;
  let saved=null;try{saved=JSON.parse(local.getItem(STORE)||'null');}catch{return false;}
  if(!saved||typeof saved!=='object')return false;
  let restored=false;
  for(const key of PLACE_KEYS)if(typeof saved[key]==='string'&&saved[key]&&saved[key].length<=500){session.setItem(key,saved[key]);restored=true;}
  return restored;
}

/** Copy this tab's place; written only when it changed. A tab with no place at all never wipes the copy. */
export function savePlace(session,local) {
  const place={};for(const key of PLACE_KEYS){const value=session.getItem(key);if(value)place[key]=value;}
  if(!Object.keys(place).length)return;
  const text=JSON.stringify(place);if(local.getItem(STORE)!==text)local.setItem(STORE,text);
}

export function rememberPlace(){if(!share)try{savePlace(sessionStorage,localStorage);}catch{ /* storage unavailable: the place lasts for this tab only */ }}

if(!share&&globalThis.document){
  try{restorePlace(sessionStorage,localStorage);}catch{}
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')rememberPlace();});
  addEventListener('pagehide',rememberPlace);
}
