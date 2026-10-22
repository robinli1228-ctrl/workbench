/**
 * The latest history page of recently opened native sessions, kept in this browser (IndexedDB) so opening a session
 * shows it at once and asks the device only for rows appended since. Per-browser convenience only: any failure (private
 * window, blocked storage, a full disk) simply means no copy, and the page loads from the device as before.
 */
const DB='agent-workbench-history',STORE='pages',KEEP=30,MAX_BYTES=2*1024*1024;
let opening=null;
function database(){
  if(opening)return opening;
  opening=new Promise((resolve,reject)=>{
    try{
      const request=indexedDB.open(DB,1);
      request.onupgradeneeded=()=>request.result.createObjectStore(STORE,{keyPath:'key'});
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
    }catch(error){reject(error);}
  }).catch(error=>{opening=null;throw error;});
  return opening;
}
const run=async(mode,work)=>{const db=await database();return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,mode),store=tx.objectStore(STORE);let result;Promise.resolve(work(store,value=>{result=value;})).catch(reject);tx.oncomplete=()=>resolve(result);tx.onerror=tx.onabort=()=>reject(tx.error);});};
const request=req=>new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});

/** The saved page for a session key, or null. */
export async function cachedHistory(key){
  try{return await run('readonly',async(store,done)=>done((await request(store.get(key)))?.page||null));}catch{return null;}
}
/** Save a page (a fresh latest page, or the saved one with appended rows); one too large to keep is dropped instead. */
export async function saveHistory(key,page){
  try{
    const entry={key,savedAt:Date.now(),page};
    if(JSON.stringify(page).length>MAX_BYTES)return void await forgetHistory(key);
    await run('readwrite',async store=>{
      store.put(entry);
      const all=await request(store.getAll());
      for(const old of all.sort((a,b)=>b.savedAt-a.savedAt).slice(KEEP))store.delete(old.key);
    });
  }catch{}
}
export async function forgetHistory(key){try{await run('readwrite',store=>{store.delete(key);});}catch{}}
