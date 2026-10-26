import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {mkdtemp,mkdir,writeFile,readFile,rm,unlink,stat} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Store} from '../src/store.mjs';import {SourceSyncHome,SourceSyncClient} from '../src/source-sync-transport.mjs';
async function fixture(t,{initial=false}={}){const dir=await mkdtemp(join(tmpdir(),'xxxxx-s1-')),db=new Store(join(dir,'home.sqlite')),messages=[],errors=[],clients={},busy={};db.put('projects',{id:'p'});const sockets={};const home=new SourceSyncHome({db,data:join(dir,'home'),online:()=>true,socket:id=>sockets[id],change(){},rooms:{postSystemTask(){throw Error('model dispatch forbidden');}}});
const server=createServer(async(req,res)=>{try{if(!await home.workerHttp(req,res,new URL(req.url,'http://localhost').pathname)){res.writeHead(404);res.end();}}catch(e){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({code:e.code||'error',error:e.message}));}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
for(const id of ['a','b']){const root=join(dir,id);await mkdir(root);db.put('workers',{id,platform:id==='a'?'darwin':'linux',capabilities:{sourceSync:1,sourceSyncDirectory:1,sourceSyncMetadataMode:1}});db.put('workspaces',{id:`p:${id}`,projectId:'p',nodeId:id,localRoot:root});const wd=new Store(join(dir,`worker-${id}.sqlite`));if(initial)await writeFile(join(root,'file.txt'),id);clients[id]=new SourceSyncClient({db:wd,data:join(dir,`data-${id}`),home:`http://127.0.0.1:${server.address().port}`,send:m=>messages.push([id,m]),resolveBinding:async c=>({...c,root}),activeRuns:()=>busy[id]?[{projectId:'p',status:'running'}]:[]});sockets[id]={workerReady:true,readyState:1,send:raw=>{const m=JSON.parse(raw);if(m.type==='source_sync_receipt_ack')clients[id].acknowledge(m.commandId,m);}};}
t.after(async()=>{for(const c of Object.values(clients)){c.watch.close();c.db.close();}await new Promise(r=>server.close(r));db.close();await rm(dir,{recursive:true,force:true});});
async function pump(){for(let i=0;i<30;i++){const commands=home.sync.schedule();if(!commands.length)break;for(const c of commands)await clients[c.nodeId].execute({commandId:c.id,secret:c.secret});for(const c of Object.values(clients))c.flush();while(messages.length){const [id,m]=messages.shift();try{await home.message(id,m);}catch(e){errors.push(e);}}if(commands.every(c=>busy[c.nodeId]))break;}if(errors.length)throw errors[0];}
const preview=home.sync.preview('p',{requestId:'preview',repositoryIds:['project-files:p'],nodeIds:['a','b'],scopeKind:'directory',displayNodeId:'a',detection:'metadata'});await pump();assert.equal(db.get('sourceSyncBatches',preview.id).status,'preview_ready');home.sync.configure('p',{enabled:true,revision:0,previewBatchId:preview.id});let n=0;
return {db,home,clients,busy,dir,pump,async sync(){const b=home.sync.request('p',{requestId:`sync${++n}`,sourceNodeId:'a',targetNodeIds:['b']});await pump();return db.get('sourceSyncBatches',b.id);},async write(id,text,path='file.txt'){await writeFile(join(dir,id,path),text);},read:id=>readFile(join(dir,id,'file.txt'),'utf8')};}
test('S01 S02 S03 S04 S12 new and single-side edits use actual destination baseline',async t=>{const f=await fixture(t);await f.write('a','first');assert.equal((await f.sync()).status,'completed');assert.equal(await f.read('b'),'first');await f.write('b','second');assert.equal((await f.sync()).status,'completed');assert.equal(await f.read('a'),'second');const records=f.db.list('sourceSyncMetadataBaselines');assert.equal(records.length,1);assert.equal(records[0].endpoints.a.mtimeNs,String((await stat(join(f.dir,'a','file.txt'),{bigint:true})).mtimeNs));assert.equal(records[0].endpoints.b.mtimeNs,String((await stat(join(f.dir,'b','file.txt'),{bigint:true})).mtimeNs));});
test('S05 S06 both modified hashes only this path; same content no apply, different keeps copies',async t=>{const f=await fixture(t);await f.write('a','base');await f.sync();await f.write('a','equal');await f.write('b','equal');let uploads=0;for(const client of Object.values(f.clients)){const old=client.request.bind(client);client.request=(m,p,method,v)=>{if(method==='PUT'&&p.startsWith('blobs/'))uploads++;return old(m,p,method,v);};}const same=await f.sync();assert.equal(uploads,0,'equal dual edits must not upload content');assert.equal(same.status,'completed');assert.equal(f.db.listSourceSyncCommands({batchId:same.id,action:'apply'}).length,0);await f.write('a','left');await f.write('b','right');const different=await f.sync();assert.equal(different.status,'partial_conflict');assert.equal(await f.read('a'),'left');assert.equal(await f.read('b'),'right');const c=f.db.list('sourceSyncConflicts')[0];assert.equal(c.detection,'metadata');for(const side of c.sides)assert.equal((await f.home.storage.read('p',side.entry.hash)).toString(),side.nodeId==='a'?'left':'right');});
test('S07 S09 S10 delete propagation, double deletion and delete/edit conflict',async t=>{const f=await fixture(t);await f.write('a','base');await f.sync();await unlink(join(f.dir,'a','file.txt'));await f.sync();await assert.rejects(f.read('b'),{code:'ENOENT'});await f.write('a','again');await f.sync();await unlink(join(f.dir,'a','file.txt'));await f.write('b','keep');assert.equal((await f.sync()).status,'partial_conflict');assert.equal(await f.read('b'),'keep');});
test('S08 waits for managed work; S13 exact receipt replay never overwrites newer bytes',async t=>{const f=await fixture(t);await f.write('a','base');f.busy.b=true;const b=await f.sync();assert.notEqual(b.status,'completed');f.busy.b=false;await f.pump();assert.equal(await f.read('b'),'base');const c=f.db.listSourceSyncCommands({batchId:b.id,action:'apply'})[0];await f.write('b','new edit');await f.clients.b.execute({commandId:c.id,secret:c.secret});assert.equal(await f.read('b'),'new edit');});
test('S01 S03 S04 unchanged and same-byte saves; S02 normal staging and old bytes are cleared',async t=>{const f=await fixture(t);await f.write('a','base');await f.sync();const noop=await f.sync();assert.equal(f.db.listSourceSyncCommands({batchId:noop.id,action:'read'}).length,0);assert.equal(f.db.listSourceSyncCommands({batchId:noop.id,action:'apply'}).length,0);await f.write('a','base');const resave=await f.sync();assert.equal(f.db.listSourceSyncCommands({batchId:resave.id,action:'read'}).length,1);assert.equal(f.db.list('sourceSyncBlobs').filter(b=>b.namespace).length,0);const {readdir}=await import('node:fs/promises');assert.equal((await readdir(join(f.dir,'b'))).filter(n=>n.startsWith('.wb-source-sync-')).length,0);});
test('S07 source changes during upload: no apply and no successful confirmation',async t=>{const f=await fixture(t);await f.write('a','base');await f.sync();await f.write('a','candidate');const c=f.clients.a,request=c.request.bind(c);let changed=false;c.request=async(m,p,method,v)=>{const r=await request(m,p,method,v);if(!changed&&p.startsWith('blobs/')&&method==='PUT'){changed=true;await f.write('a','newer');}return r;};const batch=await f.sync();assert.equal(batch.status,'blocked');assert.equal(batch.reason,'source_busy');assert.equal(await f.read('b'),'base');});
test('S07 destination changes during hydration: preserve it and withhold baseline',async t=>{const f=await fixture(t);await f.write('a','base');await f.sync();await f.write('a','candidate');const c=f.clients.b,request=c.request.bind(c);let changed=false;c.request=async(m,p,method,v)=>{const r=await request(m,p,method,v);if(!changed&&p.startsWith('blobs/')&&(!method||method==='GET')){changed=true;await f.write('b','external');}return r;};const before=f.db.list('sourceSyncMetadataBaselines')[0].revision,b=await f.sync();assert.equal(b.status,'partial_conflict');assert.equal(await f.read('b'),'external');assert.equal(f.db.list('sourceSyncMetadataBaselines')[0].revision,before);});
test('S09 two deletions confirm tombstones without content reads',async t=>{const f=await fixture(t);await f.write('a','base');await f.sync();await unlink(join(f.dir,'a','file.txt'));await unlink(join(f.dir,'b','file.txt'));const b=await f.sync();assert.equal(b.status,'completed');assert.equal(f.db.listSourceSyncCommands({batchId:b.id,action:'read'}).length,0);assert.equal(f.db.list('sourceSyncMetadataBaselines')[0].endpoints.a.exists,false);});
test('S10 offline does not become deletion',async t=>{const f=await fixture(t);await f.write('a','base');await f.sync();f.home.sync.online=n=>n!=='b';await unlink(join(f.dir,'a','file.txt'));const batch=await f.sync();assert.equal(batch.status,'capturing');assert.equal(await f.read('b'),'base');f.home.sync.online=()=>true;const c=f.db.listSourceSyncCommands({batchId:batch.id,action:'capture'}).find(c=>c.nodeId==='b');assert.equal(Boolean(c.result),false);});
test('S10 changed exclusion and replaced root cannot prove deletion',async t=>{const f=await fixture(t);await f.write('a','base');await f.sync();const {symlink,rename}=await import('node:fs/promises');await unlink(join(f.dir,'a','file.txt'));await symlink('missing',join(f.dir,'a','file.txt'));const b=await f.sync();assert.equal(b.status,'partial_conflict');assert.equal(b.pendingMetadata[0].reason,'source_scope_changed');assert.equal(await f.read('b'),'base');await rename(join(f.dir,'a'),join(f.dir,'old-a'));await mkdir(join(f.dir,'a'));assert.equal((await f.sync()).reason,'binding_changed');assert.equal(await f.read('b'),'base');});
test('S06 a conflicted path does not block another path; no model is called',async t=>{const f=await fixture(t);await f.write('a','base');await f.sync();await f.write('a','left');await f.write('b','right');await f.write('a','unrelated','other.txt');const b=await f.sync();assert.equal(b.status,'partial_conflict');assert.equal(await readFile(join(f.dir,'b','other.txt'),'utf8'),'unrelated');f.home.conflicts.tick();assert.equal(f.db.list('sourceSyncConflicts')[0].status,'needs_input');});
test('S13 crash after installation before durable result recovers the original operation',async t=>{const f=await fixture(t);await f.write('a','base');await f.sync();await f.write('a','next');const wd=f.clients.b.db,put=wd.put.bind(wd);let crashed=false;wd.put=(kind,value)=>{if(!crashed&&kind==='sourceSyncJournals'&&value.detection==='metadata'&&value.status==='applied'){crashed=true;throw Error('synthetic interruption after filesystem promotion');}return put(kind,value);};const b=await f.sync();assert.equal(crashed,true);assert.equal(b.status,'completed');assert.equal(await f.read('b'),'next');assert.equal(wd.list('sourceSyncJournals').filter(j=>j.status==='prepared').length,0);});
test('manual conflict resolution retains the existing human acceptance path',async t=>{const f=await fixture(t);await f.write('a','base');await f.sync();await f.write('a','left');await f.write('b','right');await f.sync();const c=f.db.list('sourceSyncConflicts')[0],side=c.sides.find(s=>s.nodeId==='a');const b=f.home.sync.resolve(c,{id:'human-reviewed',entry:side.entry,sourceNodeId:'a',sourceRoot:join(f.dir,'a')});await f.pump();assert.equal(f.db.get('sourceSyncBatches',b.id).status,'completed');assert.equal(await f.read('b'),'left');assert.equal(f.db.get('sourceSyncConflicts',c.id).status,'resolved');await f.write('b','after');await f.sync();assert.equal(await f.read('a'),'after');});
test('missing baseline keeps both originals pending; no automatic full hash',async t=>{const f=await fixture(t,{initial:true});const b=await f.sync();assert.equal(b.status,'partial_conflict');assert.equal(b.pendingMetadata[0].reason,'metadata_baseline_required');assert.equal(await f.read('a'),'a');assert.equal(await f.read('b'),'b');assert.equal(f.db.listSourceSyncCommands({batchId:b.id,action:'read'}).length,0);});
test('S10 failed access observation cannot generate a deletion',async t=>{const f=await fixture(t);await f.write('a','base');await f.sync();f.clients.a.worker.resolveBinding=async()=>{throw Object.assign(Error('synthetic access failure'),{code:'EACCES'});};const b=await f.sync();assert.equal(b.status,'blocked');assert.equal(b.reason,'EACCES');assert.equal(await f.read('b'),'base');assert.equal(f.db.listSourceSyncCommands({batchId:b.id,action:'apply'}).length,0);});
test('S13 replay after reopening the Worker database does not reapply completed bytes',async t=>{const f=await fixture(t);await f.write('a','base');const b=await f.sync(),c=f.db.listSourceSyncCommands({batchId:b.id,action:'apply'})[0];await f.write('b','external after completion');f.clients.b.watch.close();f.clients.b.db.close();const db=new Store(join(f.dir,'worker-b.sqlite'));const old=f.clients.b;f.clients.b=new SourceSyncClient({db,data:join(f.dir,'data-b'),home:old.home,send(){},resolveBinding:async command=>({...command,root:join(f.dir,'b')})});await f.clients.b.execute({commandId:c.id,secret:c.secret});assert.equal(await f.read('b'),'external after completion');});
test('S18 reconfiguration does not forget tombstones or initialize from unrelated bytes',async t=>{const f=await fixture(t);await f.write('a','base');await f.sync();await unlink(join(f.dir,'a','file.txt'));await f.sync();let config=f.home.sync.config('p');f.home.sync.configure('p',{revision:config.revision,enabled:false});await f.write('b','uncertain');const p=f.home.sync.preview('p',{requestId:'newpreview',repositoryIds:['project-files:p'],nodeIds:['a','b'],scopeKind:'directory',displayNodeId:'a',detection:'metadata'});await f.pump();config=f.home.sync.config('p');f.home.sync.configure('p',{revision:config.revision,enabled:true,previewBatchId:p.id});const b=await f.sync();assert.equal(b.pendingMetadata[0].reason,'metadata_baseline_required');await assert.rejects(f.read('a'),{code:'ENOENT'});});
test('metadata status identifies receipt-based confirmation without inventing content hashes',async t=>{const f=await fixture(t);await f.write('a','base');await f.sync();const result=f.home.agent.fileStatus({projectId:'p'},{path:'file.txt'});assert.equal(result.confirmation,'metadata_and_receipts');assert.equal(result.hashComputed,false);assert.equal(result.state,'consistent');assert.equal(result.scopes[0].devices[0].hash,null);f.home.sync.online=()=>false;assert.equal(f.home.agent.fileStatus({projectId:'p'},{path:'file.txt'}).state,'unknown');});
test('cross-device aliases are fenced before writing either endpoint',async t=>{const f=await fixture(t);await f.write('a','left','File.txt');await f.write('b','right','file.txt');const b=await f.sync();assert.equal(b.status,'blocked');assert.equal(b.reason,'path_collision');assert.equal(f.db.listSourceSyncCommands({batchId:b.id,action:'apply'}).length,0);});
test('S01 unchanged tombstones do not advance the confirmed baseline again',async t=>{const f=await fixture(t);await f.write('a','base');await f.sync();await unlink(join(f.dir,'a','file.txt'));await f.sync();const before=f.db.list('sourceSyncMetadataBaselines')[0];await f.sync();assert.deepEqual(f.db.list('sourceSyncMetadataBaselines')[0],before);});
test('S13 prepared journal reconciles a crash between link and unlink',async t=>{const f=await fixture(t);await f.write('a','base');await f.sync();await f.write('a','next');const {renameSync,linkSync}=await import('node:fs');const wd=f.clients.b.db,put=wd.put.bind(wd);let crashed=false;wd.put=(kind,value)=>{const saved=put(kind,value);if(!crashed&&kind==='sourceSyncJournals'&&value.detection==='metadata'&&value.status==='prepared'){crashed=true;renameSync(join(f.dir,'b','file.txt'),value.backupPath);linkSync(value.tempPath,join(f.dir,'b','file.txt'));throw Error('synthetic crash with own hardlink alias');}return saved;};const b=await f.sync();assert.equal(crashed,true);assert.equal(b.status,'completed');assert.equal(await f.read('b'),'next');assert.equal((await stat(join(f.dir,'b','file.txt'))).nlink,1);});
test('S05 equal content with different executable modes still needs no upload',async t=>{const f=await fixture(t);await f.write('a','base');await f.sync();await f.write('a','equal');await f.write('b','equal');const {chmod}=await import('node:fs/promises');await chmod(join(f.dir,'a','file.txt'),0o755);const b=await f.sync();assert.equal(b.status,'completed');assert.equal(f.db.listSourceSyncCommands({batchId:b.id,action:'stage'}).length,0);assert.equal(f.db.listSourceSyncCommands({batchId:b.id,action:'apply'}).length,0);});
test('S13 cancellation can replay a saved read receipt without requiring discarded bytes',async t=>{const f=await fixture(t);await f.write('a','base');await f.sync();await f.write('a','next');const client=f.clients.a,request=client.request.bind(client);client.request=async(m,p,method,v)=>{const result=await request(m,p,method,v);if(p==='receipt'&&method==='PUT'&&client.db.get('sourceSyncCommands',m.commandId)?.command?.action==='read')throw Object.assign(Error('synthetic lost upload response'),{code:'ECONNRESET'});return result;};const b=await f.sync();assert.equal(b.status,'reading');const read=f.db.listSourceSyncCommands({batchId:b.id,action:'read'})[0];client.request=request;f.home.sync.cancel('p',b.id,b.revision);client.cancel(read.id);for(let i=0;i<100&&client.inFlight.size;i++)await new Promise(r=>setTimeout(r,5));await f.pump();assert.equal(f.db.get('sourceSyncBatches',b.id).status,'cancelled');assert.equal(await f.read('b'),'base');});

// Drive the same persisted commands/receipts after a terminal batch, including restart replay.
async function retire(f, home=f.home) {
  const queue=[];
  for(const [id,c] of Object.entries(f.clients))c.send=m=>queue.push([id,m]);
  for(let i=0;i<8;i++) {
    await home.tick();
    for(const c of home.sync.schedule())await f.clients[c.nodeId].execute({commandId:c.id,secret:c.secret});
    while(queue.length){const [id,m]=queue.shift();await home.message(id,m);}
  }
}
async function assertRetired(f,b,before=0,home=f.home) {
  assert.equal(home.db.db.prepare("SELECT count(*) AS n FROM records WHERE kind='sourceSyncBlobs' AND json_extract(data,'$.namespace')=?").get(b.id).n,0);
  assert.equal(home.db.get('sourceSyncBlobUsage','p')?.bytes||0,before);
  for(const c of Object.values(f.clients))await assert.rejects(stat(join(c.blobRoot,'metadata',b.id)),{code:'ENOENT'});
}
async function failAfterUpload(f) {
  await f.write('a','candidate');
  const c=f.clients.a,request=c.request.bind(c);let changed=false;
  c.request=async(m,p,method,v)=>{const r=await request(m,p,method,v);if(!changed&&p.startsWith('blobs/')&&method==='PUT'){changed=true;await f.write('a','newer');}return r;};
  const tick=f.home.tick.bind(f.home);f.home.tick=async()=>{};
  let batch;try{batch=await f.sync();}finally{f.home.tick=tick;c.request=request;}
  assert.equal(batch.reason,'source_busy');return batch;
}
test('terminal metadata: S07 clears both staging stores and quota without deleting shared content',async t=>{
  const f=await fixture(t),{Readable}=await import('node:stream'),{contentHash}=await import('../src/source-sync-manifest.mjs');
  const entry={hash:contentHash('shared'),size:6,executable:false};await f.home.storage.receive('p',entry,Readable.from('shared'));
  const b=await failAfterUpload(f);await retire(f);await assertRetired(f,b,6);
  assert.equal((await f.home.storage.read('p',entry.hash)).toString(),'shared');
  assert.equal(f.db.get('sourceSyncBatches',b.id).status,'blocked');
});
test('terminal metadata: cancel after read upload clears staging and preserves cancellation',async t=>{
  const f=await fixture(t);await f.write('a','candidate');
  const c=f.clients.a,request=c.request.bind(c);let cancelled=false;
  c.request=async(m,p,method,v)=>{const r=await request(m,p,method,v);if(!cancelled&&p.startsWith('blobs/')&&method==='PUT'){cancelled=true;const command=f.db.get('sourceSyncCommands',m.commandId),b=f.db.get('sourceSyncBatches',command.batchId);f.home.sync.cancel('p',b.id,b.revision);}return r;};
  const b=await f.sync();assert.equal(b.status,'cancelled');await retire(f);await assertRetired(f,b);
  assert.equal(f.db.get('sourceSyncBatches',b.id).status,'cancelled');
  await assert.rejects(f.read('b'),{code:'ENOENT'});
});
test('terminal metadata: preparing and prepared journals retain staging until a definite outcome',async t=>{
  const {cleanupMetadataFiles}=await import('../src/source-sync-metadata-files.mjs');
  const f=await fixture(t),batchId='a'.repeat(64),root=join(f.clients.a.blobRoot,'metadata',batchId);
  await mkdir(root,{recursive:true});await writeFile(join(root,'saved'),'recover');
  const db=f.clients.a.db,id='journal',commandId='apply';
  for(const status of ['preparing','prepared']){
    db.put('sourceSyncJournals',{id,commandId,projectId:'p',batchId,detection:'metadata',status});
    const result=await cleanupMetadataFiles({id:'cleanup',projectId:'p',batchId,journalCommands:[]},db,root);
    assert.notEqual(result.status,'completed');assert.equal(await readFile(join(root,'saved'),'utf8'),'recover');
  }
  db.put('sourceSyncJournals',{...db.get('sourceSyncJournals',id),status:'conflict'});
  assert.equal((await cleanupMetadataFiles({id:'cleanup',projectId:'p',batchId,journalCommands:[]},db,root)).status,'completed');
  await assert.rejects(stat(root),{code:'ENOENT'});
});
test('terminal metadata: Home defers reconciling commands then cleans after their definite result',async t=>{
  const f=await fixture(t),b=await failAfterUpload(f),read=f.db.listSourceSyncCommands({batchId:b.id,action:'read'})[0];
  f.db.put('sourceSyncCommands',{...read,status:'reconciling',result:null});
  await f.home.tick();assert.ok(f.db.get('sourceSyncBlobUsage','p').bytes>0);
  assert.equal(f.db.listSourceSyncCommands({batchId:b.id,action:'cleanup'}).length,0);
  f.db.put('sourceSyncCommands',read);await retire(f);await assertRetired(f,b);
});
test('terminal metadata: Worker reconciling command protects local staging',async t=>{
  const {cleanupMetadataFiles}=await import('../src/source-sync-metadata-files.mjs');
  const f=await fixture(t),batchId='b'.repeat(64),root=join(f.clients.a.blobRoot,'metadata',batchId),db=f.clients.a.db;
  await mkdir(root,{recursive:true});await writeFile(join(root,'saved'),'recover');
  db.put('sourceSyncCommands',{id:'apply',projectId:'p',command:{batchId},status:'reconciling'});
  assert.notEqual((await cleanupMetadataFiles({id:'cleanup',projectId:'p',batchId},db,root)).status,'completed');
  assert.equal(await readFile(join(root,'saved'),'utf8'),'recover');
  db.put('sourceSyncCommands',{id:'apply',projectId:'p',command:{batchId},status:'completed',result:{status:'completed'}});
  assert.equal((await cleanupMetadataFiles({id:'cleanup',projectId:'p',batchId},db,root)).status,'completed');
});
test('terminal metadata: fresh Home and Worker database connections resume unfinished cleanup',async t=>{
  const f=await fixture(t),b=await failAfterUpload(f);
  for(const [id,c] of Object.entries(f.clients)){
    c.watch.close();c.db.close();
    f.clients[id]=new SourceSyncClient({db:new Store(join(f.dir,`worker-${id}.sqlite`)),data:join(f.dir,`data-${id}`),home:c.home,send(){},resolveBinding:async command=>({...command,root:join(f.dir,id)})});
  }
  const db=new Store(join(f.dir,'home.sqlite'));t.after(()=>db.close());
  const home=new SourceSyncHome({db,data:join(f.dir,'home'),online:()=>true,socket:f.home.socket,change(){},rooms:{postSystemTask(){throw Error('model dispatch forbidden');}}});
  await retire(f,home);await assertRetired(f,b,0,home);
});
test('terminal metadata: Worker recovery wait keeps Home quota until resolved; recovery siblings stay',async t=>{
  const f=await fixture(t),b=await failAfterUpload(f),db=f.clients.a.db;
  const backupPath=join(f.dir,'a','.xxxxx.old'),tempPath=join(f.dir,'a','.xxxxx.new');
  await writeFile(backupPath,'old');await writeFile(tempPath,'new');
  db.put('sourceSyncJournals',{id:'uncertain',commandId:'interrupted',projectId:'p',batchId:b.id,detection:'metadata',status:'prepared',backupPath,tempPath});
  await retire(f);assert.ok(f.db.get('sourceSyncBlobUsage','p').bytes>0);
  assert.ok((await stat(join(f.clients.a.blobRoot,'metadata',b.id))).isDirectory());
  assert.equal(f.db.get('sourceSyncBatches',b.id).metadataCleanedAt,undefined);
  db.put('sourceSyncJournals',{...db.get('sourceSyncJournals','uncertain'),status:'conflict'});
  await retire(f);await assertRetired(f,b);
  assert.equal(await readFile(backupPath,'utf8'),'old');assert.equal(await readFile(tempPath,'utf8'),'new');
});
test('terminal metadata: in-flight transfer delays cleanup and changed binding does not orphan private cache',async t=>{
  const f=await fixture(t),b=await failAfterUpload(f),c=f.clients.a;
  c.inFlight.add('pending-plan');await retire(f);
  assert.ok(f.db.get('sourceSyncBlobUsage','p').bytes>0);
  c.inFlight.delete('pending-plan');
  c.worker.resolveBinding=async()=>{throw Error('obsolete business binding must not be reopened for cleanup');};
  f.db.put('workspaces',{...f.db.get('workspaces','p:a'),localRoot:'/xxxxx/rebound'});
  await retire(f);await assertRetired(f,b);
});
test('terminal metadata: legacy failed cleanup stays immutable and a retirement command completes it',async t=>{
  const f=await fixture(t),b=await failAfterUpload(f);
  const old=f.home.sync.command(b,b.bindings[0],'cleanup',{journalCommands:[]}),result={status:'blocked',reason:'binding_changed'};
  f.db.put('sourceSyncCommands',{...old,status:'blocked',result});
  const {contentHash}=await import('../src/source-sync-manifest.mjs');
  f.clients[old.nodeId].db.put('sourceSyncCommands',{id:old.id,projectId:'p',command:old,fingerprint:contentHash(JSON.stringify(old)),status:'blocked',result});
  await retire(f);await assertRetired(f,b);
  assert.deepEqual(f.db.get('sourceSyncCommands',old.id).result,result);
  assert.equal(f.db.listSourceSyncCommands({batchId:b.id,action:'cleanup'}).filter(c=>c.result?.status==='completed').length,2);
});
test('terminal metadata: delayed read cannot recreate a retired Worker cache',async t=>{
  const f=await fixture(t),b=await failAfterUpload(f);await retire(f);await assertRetired(f,b);
  // A command cancelled before the Worker saw it can still arrive late on the connection.
  const {readSourceMetadata}=await import('../src/source-sync-files.mjs');
  const original=f.db.listSourceSyncCommands({batchId:b.id,action:'read'})[0];
  const late={...original,id:'f'.repeat(64),status:'cancelled',result:{status:'cancelled',files:[]},paths:[{...original.paths[0],expected:await readSourceMetadata(join(f.dir,'a'),'file.txt',original.scopePolicy)}]};
  f.db.put('sourceSyncCommands',late);
  const cleaned=f.db.get('sourceSyncBatches',b.id);f.db.put('sourceSyncBatches',{...cleaned,metadataCleanedAt:undefined});
  await f.clients.a.execute({commandId:late.id,secret:late.secret});
  await assert.rejects(stat(join(f.clients.a.blobRoot,'metadata',b.id)),{code:'ENOENT'});
  assert.equal(await f.read('a'),'newer');
  f.db.put('sourceSyncBatches',cleaned);
  await assert.rejects(f.clients.a.request({commandId:late.id,secret:late.secret},'plan'),e=>e.code==='batch_inactive');
});
