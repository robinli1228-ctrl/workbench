import {share} from './share-mode.js';

/**
 * What the page showed last, kept in this browser (IndexedDB) so opening it draws that at once and then asks Home only for
 * what changed: the state of the chat last viewed, the latest messages of recent chats, and the Sessions list. A copy of the
 * native-session history is kept separately (history-cache.js). Per-browser convenience only: any failure (private window,
 * blocked storage, a full disk) simply means no copy, and the page loads from Home as before. A share link's guest keeps
 * nothing and reads nothing.
 */
const DB='agent-workbench-boot',STORE='views',KEEP=12,MAX_BYTES=4*1024*1024,MAX_AGE=14*24*3600*1000,OWNER='agent-workbench-owner',UNTIL='agent-workbench.copies-until';
/** Copies are for the login they were saved under: once it has expired they are not shown, even offline. */
const expired=()=>{try{const until=Number(localStorage.getItem(UNTIL)||0);return until>0&&Date.now()>until;}catch{return false;}};
let opening=null;
function database(){
  if(opening)return opening;
  opening=new Promise((resolve,reject)=>{
    try{
      const request=indexedDB.open(DB,1);
      request.onupgradeneeded=()=>{const store=request.result.createObjectStore(STORE,{keyPath:'key'});store.createIndex('savedAt','savedAt');};
      // Another tab upgrading or the browser clearing storage closes this connection; the next call opens a new one.
      request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();opening=null;};db.onclose=()=>{opening=null;};resolve(db);};request.onerror=()=>reject(request.error);
    }catch(error){reject(error);}
  }).catch(error=>{opening=null;throw error;});
  return opening;
}
/** One transaction, driven by request callbacks only (no awaits inside it, which some browsers end the transaction on). */
async function transaction(mode,work){
  const db=await database();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE,mode);let result=null;
    work(tx.objectStore(STORE),value=>{result=value;});
    tx.oncomplete=()=>resolve(result);tx.onerror=tx.onabort=()=>reject(tx.error);
  });
}

/** The saved view for a key, or null. Never waits longer than `patience` ms: a slow disk must not hold the page open blank. */
export async function bootRead(key,patience=400){
  if(share)return null;
  if(expired()){void bootClear();return null;}
  try{return await Promise.race([transaction('readonly',(store,done)=>{const get=store.get(key);get.onsuccess=()=>done(get.result&&Date.now()-get.result.savedAt<MAX_AGE?get.result.value??null:null);}),new Promise(resolve=>setTimeout(()=>resolve(null),patience))]);}catch{return null;}
}
/** Save a view; one too large to keep is dropped rather than cut. Only the newest views stay. */
export async function bootWrite(key,value){
  if(share||expired())return;
  try{
    if(JSON.stringify(value).length>MAX_BYTES){await bootForget(key);return;}
    await transaction('readwrite',store=>{
      store.put({key,savedAt:Date.now(),value});
      const count=store.count();
      count.onsuccess=()=>{let extra=count.result-KEEP;if(extra<=0)return;
        const cursor=store.index('savedAt').openKeyCursor();
        cursor.onsuccess=()=>{const c=cursor.result;if(!c||extra<=0)return;store.delete(c.primaryKey);extra--;c.continue();};};
    });
  }catch{}
}
export async function bootForget(key){try{await transaction('readwrite',store=>{store.delete(key);});}catch{}}
/** Access ended (a refused read, an expired login, a guest's session): nothing saved by earlier visits stays in this browser, the native-session history copies included. */
export async function bootClear(){
  clearOwnerPage();try{localStorage.removeItem(UNTIL);}catch{}
  try{await transaction('readwrite',store=>{store.clear();});}catch{}
  try{indexedDB.deleteDatabase('agent-workbench-history');}catch{}
}

/**
 * Lets the service worker answer "open the page" from its cached copy at once on this browser. Set only after the owner's
 * own page has read its state from Home; a share link's guest clears it, so a guest never gets the owner's page from cache.
 */
export function markOwnerPage(until=null){
  if(share)return;
  try{if(until)localStorage.setItem(UNTIL,String(until));else localStorage.removeItem(UNTIL);}catch{}
  globalThis.caches?.open(OWNER).then(cache=>cache.put('/owner',new Response(JSON.stringify({until})))).catch(()=>{});
}
/**
 * Who this browser is to the remote-access gateway: the owner (with the time the login ends), a share link's guest, or
 * unknown (null). Home reached directly has no gateway and answers 404: the owner, with no end.
 */
export async function accessSession(){
  try{
    const response=await fetch('/_access/session',{cache:'no-store'});
    if(response.status===404)return {owner:true,until:null};
    if(!response.ok)return null;
    const session=await response.json();
    return session?.loggedIn&&!session.share?{owner:true,until:Number(session.expiresAt)||null}:{owner:false};
  }catch{return null;}
}
export function clearOwnerPage(){globalThis.caches?.delete(OWNER).catch(()=>{});}
if(share)clearOwnerPage();

/** Run `save` at most once per `wait` ms, and at once when the page is hidden or closed (a phone may never come back). */
export function savedLater(save,wait=15000){
  let timer=null,dirty=false;
  const flush=()=>{clearTimeout(timer);timer=null;if(!dirty)return;dirty=false;try{save();}catch{}};
  if(!share&&globalThis.document){document.addEventListener('visibilitychange',()=>{if(document.hidden)flush();});globalThis.addEventListener?.('pagehide',flush);}
  return ()=>{if(share)return;dirty=true;if(!timer)timer=setTimeout(flush,wait);};
}
