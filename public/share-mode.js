import {t} from './i18n.js';

/**
 * Share links (remote access). The gateway sends a guest to /?share=group|native&mode=ro|rw&… for one group chat or one
 * session. This module is imported first by app.js, so before the page reads its saved selection it points that
 * selection at the shared scope and marks the page: the stylesheet then hides the project list, the mode switch and the
 * settings entries, and read-only also hides the message box (the gateway refuses every write on a read-only link).
 * The owner accepted that this is a view restriction, not an access boundary.
 */
const params=new URLSearchParams(globalThis.location?.search||'');
const kind=['group','native'].includes(params.get('share'))?params.get('share'):null;
const text=key=>String(params.get(key)||'').slice(0,200);

export const share=kind?Object.freeze({kind,mode:params.get('mode')==='rw'?'rw':'ro',projectId:text('projectId'),conversationId:text('conversationId'),
  nodeId:text('nodeId'),runtime:text('runtime'),sessionId:text('sessionId'),entryId:text('entryId'),title:text('title')}):null;

if(share){
  const root=document.documentElement;root.dataset.share=share.kind;root.dataset.shareMode=share.mode;
  try{
    sessionStorage.setItem('agent-workbench.navigation-mode',share.kind==='group'?'groups':'sessions');
    if(share.kind==='group'){
      sessionStorage.setItem('agent-workbench.project',share.projectId);
      sessionStorage.setItem('agent-workbench.conversation',share.conversationId||share.projectId);
    }else sessionStorage.setItem('agent-workbench.native-session',`${share.nodeId}/${share.runtime}/${share.entryId||share.sessionId}`);
  }catch{ /* Without session storage the page opens its default view; the hidden entries still apply. */ }
}

const NAME_KEY='agent-workbench.share-guest-name';
const savedName=()=>{try{return String(localStorage.getItem(NAME_KEY)||'').trim().slice(0,32);}catch{return '';}};

/**
 * The name a guest signs group-chat messages with, or null when this page is not a group chat open to messages. Asked
 * once when the page opens and remembered in this browser; a guest who gives none signs as "Guest", never as the owner.
 */
export function shareGuestName(){
  if(share?.kind!=='group'||share.mode!=='rw')return null;
  return savedName()||t('Guest');
}

if(share?.kind==='group'&&share.mode==='rw'&&!savedName()){
  globalThis.addEventListener?.('load',()=>setTimeout(()=>{
    const name=String(globalThis.prompt?.(t('Your name (shown with your messages)'))||'').trim().slice(0,32);
    if(name)try{localStorage.setItem(NAME_KEY,name);}catch{}
  },300),{once:true});
}
