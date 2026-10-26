import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture} from './metadata-fixture.mjs';
const resumeInput=f=>({confirmed:true,revision:f.home.sync.config('p').revision,requestId:'xxxxx-resume'});
function expireCopies(f,id){const c=f.db.get('sourceSyncConflicts',id);f.db.put('sourceSyncConflicts',{...c,copiesNextCheckAt:'2000-01-01T00:00:00.000Z'});}
const scope='project-files:p';
const start=(f,mode='verify',extra={})=>f.home.baselines.start('p',{requestId:'xxxxx',repositoryId:scope,revision:f.home.sync.config('p').revision,confirmed:true,all:true,mode,...extra});
async function drain(f){for(let n=0;n<20;n++){await f.home.tick();await f.pump();}}
test('S11 pending preview is scoped, paginated and does not read content',async t=>{
 const f=await fixture(t,{initial:true});const page=f.home.baselines.pending('p',scope,{limit:1});assert.equal(page.items.length,1);assert.equal(page.items[0].endpoints.a.exists,true);assert.equal(page.items[0].endpoints.b.size,1);assert.equal(f.db.listSourceSyncCommands({action:'read'}).length,0);assert.throws(()=>f.home.baselines.pending('p','other',{}));
});
test('S11 explicit verification establishes equal baseline without file transfer',async t=>{
 const f=await fixture(t,{initial:true});await f.write('b','a');const j=start(f);await drain(f);assert.equal(f.db.get('sourceSyncInitializations',j.id).status,'completed');assert.equal(f.db.listSourceSyncCommands({action:'apply'}).length,0);assert.equal(f.db.listSourceSyncCommands({action:'stage'}).length,0);assert.equal(f.home.baselines.pending('p',scope).items.length,0);
});
test('S11 verification preserves different originals and saves unresolved conflict',async t=>{
 const f=await fixture(t,{initial:true});start(f);await drain(f);assert.equal(await f.read('a'),'a');assert.equal(await f.read('b'),'b');const c=f.db.list('sourceSyncConflicts')[0];assert.equal(c.status,'needs_input');for(const s of c.sides)assert.equal(await f.home.storage.has('p',s.entry),true);assert.equal(f.home.baselines.pending('p',scope).items.length,0);
});
test('S11 overwrite saves both sides before apply and retires unreferenced copies after ACK',async t=>{
 const f=await fixture(t,{initial:true});let checked=false;const execute=f.clients.b.execute.bind(f.clients.b);f.clients.b.execute=async m=>{const c=f.db.get('sourceSyncCommands',m.commandId);if(c.action==='apply'){const proof=f.db.list('sourceSyncConflicts')[0];assert.equal(proof.status,'initializing');for(const s of proof.sides)assert.ok(await f.home.storage.has('p',s.entry));checked=true;}return execute(m);};start(f,'overwrite',{sourceNodeId:'a'});await drain(f);assert.ok(checked);assert.equal(await f.read('b'),'a');const c=f.db.list('sourceSyncConflicts')[0];assert.equal(c.status,'resolved');assert.ok(c.copiesReleasedAt);assert.equal(f.db.get('sourceSyncBatches',c.resolutionBatchId).status,'completed');assert.equal(f.db.get('sourceSyncBlobUsage','p').bytes,0);
});
test('S11 failed preservation never overwrites and resume keeps stable job identity',async t=>{
 const f=await fixture(t,{initial:true});const receive=f.home.storage.receive.bind(f.home.storage);f.home.storage.receive=async()=>{throw Object.assign(Error('xxxxx'),{code:'storage_full'});};const j=start(f,'overwrite',{sourceNodeId:'a'});await assert.rejects(drain(f));assert.equal(await f.read('b'),'b');f.home.storage.receive=receive;await new Promise(r=>setTimeout(r,5100));await drain(f);assert.equal(await f.read('b'),'a');assert.equal(start(f,'overwrite',{sourceNodeId:'a'}).id,j.id);
});
test('S11 user confirmation and revision are mandatory; selections are bounded',async t=>{
 const f=await fixture(t,{initial:true});assert.throws(()=>start(f,'verify',{confirmed:false}),e=>e.code==='confirmation_required');assert.throws(()=>start(f,'verify',{revision:-1}),e=>e.code==='confirmation_required');assert.throws(()=>start(f,'overwrite',{sourceNodeId:'other'}),e=>e.code==='invalid_scope');assert.throws(()=>start(f,'verify',{all:false,paths:['../secret']}),e=>e.code==='unsafe_path');
});
test('S11 selected paths leave other pending paths untouched',async t=>{
 const f=await fixture(t,{initial:true});await f.write('a','left','other.txt');await f.write('b','right','other.txt');await f.sync();start(f,'overwrite',{sourceNodeId:'a',all:false,paths:['file.txt']});await drain(f);assert.equal(await readFile(join(f.dir,'b','other.txt'),'utf8'),'right');assert.equal(f.home.baselines.pending('p',scope).items.length,1);
});
test('S15 shared versions and unresolved conflicts protect content',async t=>{
 const f=await fixture(t,{initial:true});start(f);await drain(f);let c=f.db.list('sourceSyncConflicts')[0];const entry=c.sides[1].entry;f.db.put('sourceSyncVersions',{id:'xxxxx-version',projectId:'p',entries:{'saved.txt':entry}});const b=f.home.sync.resolve(c,{id:'human',entry:c.sides[0].entry,sourceNodeId:'a',sourceRoot:join(f.dir,'a')});await drain(f);assert.equal(f.db.get('sourceSyncBatches',b.id).status,'completed');assert.equal(await f.home.storage.has('p',entry),true);f.db.remove('sourceSyncVersions','xxxxx-version');expireCopies(f,c.id);await drain(f);assert.equal(await f.home.storage.has('p',entry),false);
});
test('S11 initialization resumes persisted job without repeating an applied write',async t=>{
 const f=await fixture(t,{initial:true});f.busy.b=true;const j=start(f,'overwrite',{sourceNodeId:'a'});await drain(f);assert.notEqual(f.db.get('sourceSyncInitializations',j.id).status,'completed');f.busy.b=false;const C=f.home.baselines.constructor;f.home.baselines=new C(f.home);await drain(f);const before=await stat(join(f.dir,'b','file.txt'),{bigint:true});await drain(f);assert.equal((await stat(join(f.dir,'b','file.txt'),{bigint:true})).mtimeNs,before.mtimeNs);assert.equal(f.db.get('sourceSyncInitializations',j.id).status,'completed');
});

test('S11 multiple bounded pages resume and leave new pending paths outside the confirmed selection',async t=>{
 const f=await fixture(t);for(let i=0;i<102;i++){const p=`xxxxx-${String(i).padStart(3,'0')}.txt`;await f.write('a','same',p);await f.write('b','same',p);}await f.sync();
 const page=f.home.baselines.pending('p',scope,{limit:50});assert.equal(page.items.length,50);assert.ok(page.next);assert.equal(f.home.baselines.pending('p',scope,{after:page.next,limit:50}).items.length,50);
 const j=start(f);await f.write('a','later-a','xxxxx-later.txt');await f.write('b','later-b','xxxxx-later.txt');await f.sync();await drain(f);assert.ok(f.home.baselines.pending('p',scope).items.some(r=>r.path==='xxxxx-later.txt'));const batches=f.db.listProject('sourceSyncBatches','p').filter(b=>b.kind==='initialize');assert.equal(batches.length,2);assert.ok(batches.every(b=>b.initialization.paths.length<=100));assert.equal(f.db.get('sourceSyncInitializations',j.id).processed,102);
});
test('migration fences hash mode before enabling metadata and does not reuse unproven evidence',async t=>{
 const f=await fixture(t,{initial:true,detection:null});let c=f.home.sync.config('p');assert.notEqual(c.detection,'metadata');f.home.sync.configure('p',{revision:c.revision,enabled:false});
 const preview=f.home.sync.preview('p',{requestId:'migration',repositoryIds:[scope],nodeIds:['a','b'],scopeKind:'directory',displayNodeId:'a',detection:'metadata'});await f.pump();c=f.home.sync.config('p');f.home.sync.configure('p',{enabled:true,revision:c.revision,previewBatchId:preview.id});
 const b=await f.sync();assert.equal(b.detection,'metadata');assert.ok(f.db.listSourceSyncCommands({batchId:b.id}).every(c=>c.detection==='metadata'));assert.equal(f.db.listSourceSyncCommands({pending:true}).filter(c=>c.detection!=='metadata').length,0);assert.equal(f.home.baselines.pending('p',scope).items.length,1);assert.equal(f.db.listSourceSyncCommands({batchId:b.id,action:'read'}).length,0);
});
test('S15 another unresolved conflict and in-progress read retain shared copies',async t=>{
 const f=await fixture(t,{initial:true});start(f);await drain(f);const c=f.db.list('sourceSyncConflicts')[0],side=c.sides[0],other={...c,id:'xxxxx-unresolved',path:'other.txt'};f.db.put('sourceSyncConflicts',other);
 f.home.sync.resolve(c,{id:'human',entry:side.entry,sourceNodeId:side.nodeId,sourceRoot:side.root});await drain(f);assert.ok(await f.home.storage.has('p',side.entry));
 f.db.remove('sourceSyncConflicts',other.id);f.db.put('sourceSyncBatches',{id:'xxxxx-active',projectId:'p',detection:'metadata',status:'reading'});f.db.put('sourceSyncCommands',{id:'xxxxx-read',projectId:'p',batchId:'xxxxx-active',detection:'metadata',status:'completed',result:{files:[{entry:side.entry}]}});
 expireCopies(f,c.id);await f.home.cleanupMetadataConflicts();await f.home.cleanupMetadataConflicts();assert.ok(await f.home.storage.has('p',side.entry));
 f.db.remove('sourceSyncCommands','xxxxx-read');f.db.remove('sourceSyncBatches','xxxxx-active');expireCopies(f,c.id);await drain(f);assert.equal(await f.home.storage.has('p',side.entry),false);
});

test('S11 browser routes enforce confirmation and return bounded metadata pages',async t=>{
 const f=await fixture(t,{initial:true}),url=f.clients.a.home+'/api/projects/p/source-sync';
 const page=await fetch(url+'/pending?'+new URLSearchParams({repositoryId:scope,limit:'1'}));assert.equal(page.status,200);assert.equal((await page.json()).items.length,1);
 let r=await fetch(url+'/initializations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:'http',mode:'verify',all:true,repositoryId:scope,revision:1})});assert.equal(r.status,400);
 r=await fetch(url+'/initializations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:'http',mode:'verify',confirmed:true,all:true,repositoryId:scope,revision:1})});assert.equal(r.status,200);await drain(f);assert.equal((await (await fetch(url+'/initializations')).json()).items[0].status,'completed');
});
test('S11 explicit retry after cancellation resumes the pending initialization',async t=>{
 const f=await fixture(t,{initial:true});f.busy.b=true;const j=start(f,'overwrite',{sourceNodeId:'a'});await drain(f);const batch=f.db.get('sourceSyncBatches',f.db.get('sourceSyncInitializations',j.id).batchId);f.home.sync.cancel('p',batch.id,batch.revision);for(const c of f.db.listSourceSyncCommands({batchId:batch.id,pending:true}))f.clients[c.nodeId].cancel(c.id);f.busy.b=false;for(let i=0;i<100&&Object.values(f.clients).some(c=>c.inFlight.size);i++)await new Promise(r=>setTimeout(r,5));await drain(f);assert.equal(f.db.get('sourceSyncInitializations',j.id).status,'paused');
 // A later explicit initialization is separate from replaying the cancelled operation.
 f.home.baselines.resume('p',j.id,resumeInput(f));await drain(f);assert.equal(await f.read('b'),'a');assert.equal(f.db.get('sourceSyncInitializations',j.id).status,'completed');
});
test('S11 cancelling after preservation resumes without losing protected initial versions',async t=>{
 const f=await fixture(t,{initial:true}),execute=f.clients.b.execute.bind(f.clients.b);let cancelled=false;
 f.clients.b.execute=async m=>{const c=f.db.get('sourceSyncCommands',m.commandId);if(!cancelled&&c.action==='apply'){cancelled=true;const b=f.db.get('sourceSyncBatches',c.batchId);f.home.sync.cancel('p',b.id,b.revision);f.clients.b.cancel(c.id);return;}return execute(m);};
 const j=start(f,'overwrite',{sourceNodeId:'a'});await drain(f);assert.equal(await f.read('b'),'b');assert.equal(f.db.get('sourceSyncInitializations',j.id).status,'paused');f.home.baselines.resume('p',j.id,resumeInput(f));await drain(f);assert.equal(await f.read('b'),'a');assert.equal(f.db.get('sourceSyncInitializations',j.id).status,'completed');
});
test('S11 uncertain recovery pauses initialization and rejects premature resume',async t=>{
 const f=await fixture(t,{initial:true});const j=start(f);f.home.baselines.tick();const job=f.db.get('sourceSyncInitializations',j.id),b=f.db.get('sourceSyncBatches',job.batchId);f.db.put('sourceSyncBatches',{...b,status:'blocked'});f.home.baselines.tick();f.home.baselines.tick();assert.equal(f.db.get('sourceSyncInitializations',j.id).status,'paused');assert.throws(()=>f.home.baselines.resume('p',j.id,resumeInput(f)),e=>e.code==='sync_busy');assert.equal(await f.read('b'),'b');
});
test('S11 batch planning respects combined byte limit before reading either device',async t=>{
 const f=await fixture(t,{initial:true});const row=f.home.baselines.pending('p',scope).items[0];for(let i=0;i<3;i++)f.db.put('sourceSyncMetadataBaselines',{...row,id:`xxxxx-${i}`,path:`xxxxx-${i}.txt`,endpoints:{a:{...row.endpoints.a,size:19*1024*1024},b:{...row.endpoints.b,size:19*1024*1024}}});const j=start(f);f.home.baselines.tick();const b=f.db.get('sourceSyncBatches',f.db.get('sourceSyncInitializations',j.id).batchId);assert.equal(b.initialization.paths.length,3);assert.ok(!b.initialization.paths.includes('xxxxx-2.txt'));assert.equal(f.db.listSourceSyncCommands({batchId:b.id,action:'read'}).length,0);
});
test('S15 cleanup retries after reference removal and keeps legacy conflict history references',async t=>{
 const f=await fixture(t,{initial:true});start(f);await drain(f);const c=f.db.list('sourceSyncConflicts')[0],side=c.sides[0];f.db.put('sourceSyncConflictHistory',{...c,id:'xxxxx-history',detection:undefined});f.home.sync.resolve(c,{id:'human',entry:side.entry,sourceNodeId:side.nodeId,sourceRoot:side.root});await drain(f);assert.ok(await f.home.storage.has('p',side.entry));f.db.remove('sourceSyncConflictHistory','xxxxx-history');expireCopies(f,c.id);f.home.conflictCleanupCursor=undefined;await f.home.cleanupMetadataConflicts();assert.equal(await f.home.storage.has('p',side.entry),false);
});
test('S11 initialization batch and job pointer commit atomically',async t=>{
 const f=await fixture(t,{initial:true});start(f);const put=f.db.put.bind(f.db);f.db.put=(kind,value)=>{if(kind==='sourceSyncInitializations'&&value.batchId)throw Error('xxxxx commit interrupted');return put(kind,value);};assert.throws(()=>f.home.baselines.tick());f.db.put=put;assert.equal(f.db.listProject('sourceSyncBatches','p').filter(b=>b.kind==='initialize').length,0);await drain(f);
});
test('S15 interrupted shared-blob retirement can rehydrate without double-counting quota',async t=>{
 const f=await fixture(t),{Readable}=await import('node:stream'),{contentHash}=await import('../src/source-sync-manifest.mjs'),{unlink}=await import('node:fs/promises');const e={hash:contentHash('xxxxx'),size:5,executable:false};await f.home.storage.receive('p',e,Readable.from('xxxxx'));await unlink(join(f.home.storage.directory('p'),e.hash));await f.home.storage.receive('p',e,Readable.from('xxxxx'));assert.equal(f.db.get('sourceSyncBlobUsage','p').bytes,5);
});
test('S15 a legacy capture upload not yet accepted still pins its shared bytes',async t=>{
 const f=await fixture(t,{initial:true});start(f);await drain(f);const c=f.db.list('sourceSyncConflicts')[0],side=c.sides[0];f.db.put('sourceSyncUploads',{id:'xxxxx-capture',projectId:'p',bundle:{manifest:{entries:{'file.txt':side.entry}}}});f.home.sync.resolve(c,{id:'human',entry:side.entry,sourceNodeId:side.nodeId,sourceRoot:side.root});await drain(f);assert.ok(await f.home.storage.has('p',side.entry));
});
