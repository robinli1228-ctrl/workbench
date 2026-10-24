import {isHistoryPrompt} from './history-prompt.js';

/**
 * The latest history page of recently opened native sessions, kept in this browser (IndexedDB) so opening a session
 * shows it at once and asks the device only for rows appended since. Per-browser convenience only: any failure (private
 * window, blocked storage, a full disk) simply means no copy, and the page loads from the device as before.
 */
const DB='agent-workbench-history',STORE='pages',KEEP=30,MAX_BYTES=2*1024*1024;
let opening=null;
const decodeCursor=value=>{try{const normalized=String(value||'').replace(/-/g,'+').replace(/_/g,'/'),padding='='.repeat((4-normalized.length%4)%4),bytes=Uint8Array.from(atob(normalized+padding),c=>c.charCodeAt(0));return JSON.parse(new TextDecoder().decode(bytes));}catch{return null;}};
const encodeCursor=value=>{const bytes=new TextEncoder().encode(JSON.stringify(value));let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');};

/** Keep a reachable recent cache page: cropped rows point back into the exact snapshot they came from. */
export function compactHistoryPage(page,maxBytes=MAX_BYTES){
  if(!page||!Array.isArray(page.messages)||JSON.stringify(page).length<=maxBytes)return page;
  const snapshot=decodeCursor(page.historySnapshot);
  if(!snapshot||snapshot.v!==1||!Number.isFinite(snapshot.end)||!Number.isFinite(snapshot.size)||typeof snapshot.key!=='string'||typeof snapshot.tail!=='string')return null;
  const prompts=page.messages.flatMap((row,index)=>row.role==='user'&&isHistoryPrompt(row.text)?[index]:[]),start=prompts.length>15?prompts[prompts.length-15]:0;
  let messages=page.messages.slice(start);
  while(messages.length&&JSON.stringify({...page,messages}).length>maxBytes){const next=messages.findIndex((row,index)=>index>0&&row.role==='user'&&isHistoryPrompt(row.text));if(next<0)return null;messages=messages.slice(next);}
  if(!messages.length||!Number.isFinite(messages[0].offset))return null;
  const firstPrompt=messages.find(row=>row.role==='user'&&isHistoryPrompt(row.text));
  const cursor=encodeCursor({...snapshot,end:messages[0].offset});
  const compact={...page,messages,nextCursor:cursor,hasMore:true,partial:true};
  if(firstPrompt?.timestamp)compact.turnStartedAt=firstPrompt.timestamp;
  return JSON.stringify(compact).length<=maxBytes?compact:null;
}
function database(){
  if(opening)return opening;
  opening=new Promise((resolve,reject)=>{
    try{
      const request=indexedDB.open(DB,2);
      // Saved time is indexed, so trimming to the newest copies reads keys only, never the pages themselves.
      request.onupgradeneeded=()=>{const db=request.result,store=db.objectStoreNames.contains(STORE)?request.transaction.objectStore(STORE):db.createObjectStore(STORE,{keyPath:'key'});if(!store.indexNames.contains('savedAt'))store.createIndex('savedAt','savedAt');};
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

/** The saved page for a session key, or null. */
export async function cachedHistory(key){
  try{return await transaction('readonly',(store,done)=>{const get=store.get(key);get.onsuccess=()=>done(get.result?.page||null);});}catch{return null;}
}
/** Save a page (a fresh latest page, or the saved one with appended rows); oversize pages retain a reachable recent window. */
export async function saveHistory(key,page){
  try{
    const bounded=compactHistoryPage(page);
    if(!bounded)return;
    await transaction('readwrite',store=>{
      store.put({key,savedAt:Date.now(),page:bounded});
      // Keep the newest copies: walk the oldest keys beyond the limit and delete them.
      const count=store.count();
      count.onsuccess=()=>{let extra=count.result-KEEP;if(extra<=0)return;
        const cursor=store.index('savedAt').openKeyCursor();
        cursor.onsuccess=()=>{const c=cursor.result;if(!c||extra<=0)return;store.delete(c.primaryKey);extra--;c.continue();};};
    });
  }catch{}
}
export async function forgetHistory(key){try{await transaction('readwrite',store=>{store.delete(key);});}catch{}}
