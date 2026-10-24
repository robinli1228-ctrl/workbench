import {AsyncLocalStorage} from 'node:async_hooks';
import {realpath,stat,access,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {relative,isAbsolute,dirname,join,parse} from 'node:path';
import {homedir} from 'node:os';

const inside=(root,path)=>{const part=relative(root,path);return !part||part!=='..'&&!part.startsWith('../')&&!part.startsWith('..\\')&&!isAbsolute(part);};
const identity=info=>({dev:info.dev,ino:info.ino,birthtimeMs:info.birthtimeMs});
const sameIdentity=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.birthtimeMs===b.birthtimeMs;
const grantView=({id,nodeId,scope,root,dev,ino,birthtimeMs})=>({id,nodeId,scope,root,dev,ino,birthtimeMs});

/** Browsing never grants execution; extra roots exist only in the matching Home binding's async context. */
export class FolderAccess {
 constructor({db,roots,nodeId,local}){Object.assign(this,{db,roots,nodeId,local});this.context=new AsyncLocalStorage();}
 browseRoots(){return this.local?[parse(homedir()).root]:this.roots;}
 run(envelope,fn){return this.context.run(envelope||null,fn);}
 /** Prepare an idempotent receipt without changing global roots or writing the chosen directory. */
 async prepare({operationId,scope,path,bindings=[]}){
  if(!this.local)throw Error('Local folder selection is not available on this device');
  if(!/^[\w-]{8,100}$/.test(operationId||'')||! /^(project|native):[\w:-]{1,150}$/.test(scope||''))throw Error('Invalid folder binding identity');
  if(typeof path!=='string'||!isAbsolute(path)||path.includes('\0'))throw Error('Select an absolute folder path');
  const root=await realpath(path),info=await stat(root);
  if(!info.isDirectory()||dirname(root)===root)throw Error('Choose a project folder, not a filesystem root');
  await access(root,constants.R_OK|constants.W_OK|constants.X_OK);
  const id=`${this.nodeId}:${operationId}`,prior=this.db.get('folderGrantReceipts',id);
  if(prior&&(prior.cancelledAt||prior.scope!==scope||prior.root!==root||!sameIdentity(prior,info)))throw Error('Folder binding request changed');
  const legacyNative=scope.startsWith('native:')&&this.roots.some(allowed=>inside(allowed,root));
  if(!legacyNative){
   for(const binding of bindings){if(!binding.localRoot||`project:${binding.projectId}`===scope)continue;const other=await realpath(binding.localRoot).catch(e=>{if(e.code==='ENOENT')return binding.localRoot;throw e;});if(inside(other,root)||inside(root,other))throw Error('Folder overlaps another project binding');}
   let marker;
   try{marker=await open(join(root,'.agent-workbench-project.json'),constants.O_RDONLY|constants.O_NOFOLLOW);const info=await marker.stat();if(!info.isFile()||info.size>16384)throw Error('Invalid project folder ownership marker');const buffer=Buffer.alloc(16385),{bytesRead}=await marker.read(buffer,0,buffer.length,0);if(bytesRead>16384)throw Error('Invalid project folder ownership marker');const owner=JSON.parse(buffer.subarray(0,bytesRead).toString('utf8'));if(`project:${owner.projectId}`!==scope)throw Error('Folder belongs to another project');}catch(error){if(error instanceof SyntaxError)throw Error('Invalid project folder ownership marker');if(error.code!=='ENOENT')throw error;}finally{await marker?.close();}
  }
  const receipt={id,nodeId:this.nodeId,scope,root,...identity(info),preparedAt:Date.now()};
  // Reserve concurrent preparations briefly; durable ownership still comes from Home's live bindings. Sessions may share a
  // folder (a new session, an Agent switch, switching back), so only a project binding is held off by another preparation.
  const native=s=>String(s).startsWith('native:');
  return this.db.transaction(()=>{
   if(!legacyNative&&this.db.list('folderGrantReceipts').some(r=>!r.cancelledAt&&r.id!==id&&r.scope!==scope&&!(native(r.scope)&&native(scope))&&Date.now()-r.preparedAt<900000&&(inside(r.root,root)||inside(root,r.root))))throw Error('Folder has another pending binding');
   const concurrent=this.db.get('folderGrantReceipts',id);
   if(concurrent&&(concurrent.cancelledAt||concurrent.scope!==scope||concurrent.root!==root||!sameIdentity(concurrent,info)))throw Error('Folder binding request changed');
   return grantView(this.db.put('folderGrantReceipts',{...(concurrent||receipt),preparedAt:Date.now()}));
  });
 }
 /** Revocation preserves receipts, directories and files. */
 cancel({id,scope}){const receipt=this.db.get('folderGrantReceipts',id);if(receipt&&receipt.scope!==scope)throw Error('Folder binding identity changed');this.db.put('folderGrantReceipts',{...(receipt||{id,nodeId:this.nodeId,scope}),cancelledAt:Date.now()});return {cancelled:true};}
 /** A reconnect must not revive a cached envelope that Home revoked while this Worker was offline. */
 reconcile(activeIds){const active=new Set(activeIds);for(const receipt of this.db.list('folderGrantReceipts'))if(receipt.activatedAt&&!receipt.cancelledAt&&!active.has(receipt.id))this.cancel(receipt);}
 /** Home marks only persisted live bindings active; Worker rechecks its receipt and physical identity. */
 async grantedRoot(){
  const envelope=this.context.getStore(),grant=envelope?.grant;
  if(!this.local||envelope?.active!==true||!grant||grant.nodeId!==this.nodeId||grant.scope!==envelope.scope)return null;
  const receipt=this.db.get('folderGrantReceipts',grant.id);
  if(!receipt||receipt.cancelledAt||receipt.scope!==grant.scope||receipt.root!==grant.root||!sameIdentity(receipt,grant))return null;
  const canonical=await realpath(receipt.root),info=await stat(canonical);
  if(canonical!==receipt.root||!sameIdentity(receipt,info)||!info.isDirectory())throw Error('Selected folder changed; bind it again');
  return this.db.transaction(()=>{
   const current=this.db.get('folderGrantReceipts',grant.id);
   if(!current||current.cancelledAt||current.scope!==grant.scope||current.root!==grant.root||!sameIdentity(current,grant))throw Error('Folder binding changed or was cancelled');
   if(!envelope.previewOnly&&!current.activatedAt)this.db.put('folderGrantReceipts',{...current,activatedAt:Date.now()});
   return canonical;
  });
 }
 async allowedRoots(){const extra=await this.grantedRoot();return extra?[...this.roots,extra]:this.roots;}
 async resolve(path){
  if(typeof path!=='string'||!isAbsolute(path)||path.includes('\0'))throw Error('Select an absolute folder path');
  const root=await realpath(path);
  if(!(await this.allowedRoots()).some(allowed=>inside(allowed,root)))throw Error('Folder is not authorized for this project or session');
  if(!(await stat(root)).isDirectory())throw Error('Select a folder');
  return root;
 }
}

/** Never infer authorization from a path; only a matching current Home binding can issue an envelope. */
export function folderAccessFor(db,nodeId,scope){
 if(!scope)return null;
 const row=db.get('folderGrants',`${nodeId}:${scope}`);
 if(!row||row.status!=='active'||row.scope!==scope||row.nodeId!==nodeId)return null;
 const id=scope.slice(scope.indexOf(':')+1);
 const binding=scope.startsWith('project:')?db.get('projects',id)&&db.get('workspaces',`${id}:${nodeId}`):db.get('nativeCatalogEntries',id);
 if(!binding||binding.nodeId!==nodeId||(binding.localRoot||binding.workspace)!==row.grant.root)return null;
 if(scope.startsWith('native:')&&['draft','missing_history'].includes(binding.status))return null;
 return {scope,active:true,grant:row.grant};
}

/** Native grants use registered IDs, never display titles or coincident working folders. */
export function nativeFolderAccess(db,nodeId,runtime,sessionId,entryId){
 const entry=entryId?db.get('nativeCatalogEntries',entryId):db.list('nativeCatalogEntries').find(e=>e.nodeId===nodeId&&e.runtime===runtime&&e.sessionId===sessionId);
 return entry?.nodeId===nodeId&&entry.runtime===runtime&&(!sessionId||entry.sessionId===sessionId)?folderAccessFor(db,nodeId,`native:${entry.id}`):null;
}

/** Persist preparation cleanup before contacting Worker, so a lost reply or Home restart cannot strand an unused reservation. */
export class FolderPreparations {
 constructor({db,prepare,cancel}){Object.assign(this,{db,prepare,cancel});this.inflight=new Set();}
 async run(input,apply){
  const id=`${input.nodeId}:${input.operationId}`,prior=this.db.get('folderPreparations',id);
  if(this.inflight.has(id)||prior&&prior.status!=='complete')throw Object.assign(Error('Folder request is already preparing or awaiting cleanup; use a new operation'),{folderPreparationReleased:prior?.status==='cancelled'});
  if(prior&&(prior.scope!==input.scope||prior.path!==input.path))throw Error('Folder binding request changed');
  const intent={...input,id,status:'preparing'};let failure;
  this.inflight.add(id);this.db.put('folderPreparations',intent);
  try{const result=await apply(await this.prepare(input));this.db.put('folderPreparations',{...intent,status:'complete'});return result;}
  catch(error){failure=error;this.db.put('folderPreparations',{...intent,status:'pending_cleanup',error:error.message});throw error;}
  finally{this.inflight.delete(id);await this.cleanup(input.nodeId,id);if(failure&&this.db.get('folderPreparations',id)?.status==='cancelled')failure.folderPreparationReleased=true;}
 }
 /** Never revoke a live binding or an uncertain terminal; existing terminal reconciliation supplies the release proof. */
 async cleanup(nodeId,id){
  for(const intent of this.db.list('folderPreparations')){
   if(nodeId&&intent.nodeId!==nodeId||id&&intent.id!==id||this.inflight.has(intent.id)||['complete','cancelled'].includes(intent.status))continue;
   const row=this.db.get('folderGrants',`${intent.nodeId}:${intent.scope}`);
   const entryId=intent.scope.startsWith('native:')?intent.scope.slice(7):null;
   const claims=entryId?this.db.list('terminalSessions').filter(s=>s.nodeId===intent.nodeId&&(s.id===intent.operationId||s.catalogEntryId===entryId)&&!['released','cancelled'].includes(s.status)):[];
   if(claims.some(s=>s.id!==intent.operationId||!['preparing','blocked'].includes(s.status)))continue;
   if(!claims.length&&folderAccessFor(this.db,intent.nodeId,intent.scope)?.grant.id===intent.id){this.db.put('folderPreparations',{...intent,status:'complete'});continue;}
   try{
    const result=await this.cancel({id:intent.id,nodeId:intent.nodeId,scope:intent.scope,operationId:intent.operationId,preparedOnly:true});
    if(result?.cancelled!==true)throw Error('Folder preparation release was not confirmed');
    this.db.transaction(()=>{
     for(const claim of claims){const current=this.db.get('terminalSessions',claim.id);if(current&&['preparing','blocked'].includes(current.status))this.db.put('terminalSessions',{...current,status:'released',processState:'released',releasedAt:new Date().toISOString()});}
     const entry=entryId?this.db.get('nativeCatalogEntries',entryId):null;
     if(claims.length&&entry?.nodeId===intent.nodeId&&!entry.hasHistory&&entry.status==='preparing')this.db.put('nativeCatalogEntries',{...entry,status:'draft',modifiedAt:new Date().toISOString()});
     if(row?.grant?.id===intent.id&&this.db.get('folderGrants',row.id)?.grant?.id===intent.id)this.db.put('folderGrants',{...row,status:'revoked'});
     this.db.put('folderPreparations',{...intent,status:'cancelled'});
    });
   }catch(error){this.db.put('folderPreparations',{...intent,status:'pending_cleanup',cleanupError:error.message});}
  }
 }
}
