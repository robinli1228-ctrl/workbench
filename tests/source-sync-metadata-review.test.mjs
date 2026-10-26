import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {fixture} from './metadata-fixture.mjs';
function pause(f,j){f.db.put('sourceSyncBatches',{id:'xxxxx-cleaned',projectId:'p',status:'cancelled',metadataCleanedAt:new Date().toISOString()});f.db.put('sourceSyncInitializations',{...j,status:'paused',batchId:'xxxxx-cleaned'});}
const scope='project-files:p';
const start=f=>f.home.baselines.start('p',{requestId:'xxxxx',repositoryId:scope,revision:1,confirmed:true,all:true,mode:'verify'});
const auth=(f,extra={})=>({confirmed:true,revision:f.home.sync.config('p').revision,requestId:'xxxxx-resume',...extra});
async function drain(f){for(let n=0;n<20;n++){await f.home.tick();await f.pump();}}
async function conflict(f){start(f);await drain(f);return f.db.list('sourceSyncConflicts')[0];}
async function resolve(f,c){const s=c.sides[0];f.home.sync.resolve(c,{id:'xxxxx-human',entry:s.entry,sourceNodeId:s.nodeId,sourceRoot:s.root});await drain(f);}
function expire(f,id){const c=f.db.get('sourceSyncConflicts',id);f.db.put('sourceSyncConflicts',{...c,copiesNextCheckAt:'2000-01-01T00:00:00.000Z'});}
test('service worker cache is removed by the next static-cache activation',async()=>{
 const source=await readFile(new URL('../public/sw.js',import.meta.url),'utf8');const handlers={};let cache;
 runInNewContext(source,{self:{addEventListener:(name,fn)=>handlers[name]=fn,skipWaiting:async()=>{}},caches:{open:name=>{cache=name;return Promise.resolve({addAll:async()=>{}});}}});
 let wait;handlers.install({waitUntil:p=>wait=p});await wait;
 const deleted=[];const next={};runInNewContext(source.replace(/const CACHE = '[^']+'/,"const CACHE = 'agent-workbench-static-xxxxx-next'"),{self:{addEventListener:(name,fn)=>next[name]=fn,clients:{claim:async()=>{}}},caches:{keys:async()=>[cache,'xxxxx-unrelated'],delete:async k=>deleted.push(k)}});
 next.activate({waitUntil:p=>wait=p});await wait;assert.deepEqual(deleted,[cache]);
});
test('retained conflict scans back off across ticks and Home reconstruction, then retry when due',async t=>{
 const f=await fixture(t,{initial:true}),c=await conflict(f),entry=c.sides[0].entry;
 f.db.put('sourceSyncVersions',{id:'xxxxx-pin',projectId:'p',entry});let calls=0;const release=f.home.storage.releaseConflictCopies.bind(f.home.storage);f.home.storage.releaseConflictCopies=c=>{calls++;return release(c);};
 await resolve(f,c);assert.equal(calls,1);const saved=f.db.get('sourceSyncConflicts',c.id);assert.ok(saved.copiesCheckedAt);assert.ok(Date.parse(saved.copiesNextCheckAt)-Date.parse(saved.copiesCheckedAt)>=3600000);
 const restarted=new f.home.constructor({db:f.db,data:f.dir+'/home',online:()=>true,change(){}});restarted.storage.releaseConflictCopies=f.home.storage.releaseConflictCopies;for(let i=0;i<6;i++)await restarted.cleanupMetadataConflicts();await drain(f);assert.equal(calls,1);f.db.remove('sourceSyncVersions','xxxxx-pin');expire(f,c.id);await drain(f);assert.equal(calls,2);assert.equal(await f.home.storage.has('p',entry),false);
});
test('metadata audit history does not pin resolved copies',async t=>{
 const f=await fixture(t,{initial:true}),c=await conflict(f),entry=c.sides[0].entry;
 f.db.put('sourceSyncConflictHistory',{...c,id:'xxxxx-audit'});await resolve(f,c);assert.equal(await f.home.storage.has('p',entry),false);assert.ok(f.db.get('sourceSyncConflictHistory','xxxxx-audit'));
});
test('legacy conflict history still pins copies',async t=>{
 const f=await fixture(t,{initial:true}),c=await conflict(f),entry=c.sides[0].entry;
 f.db.put('sourceSyncConflictHistory',{...c,id:'xxxxx-legacy',detection:undefined});await resolve(f,c);assert.equal(await f.home.storage.has('p',entry),true);
});
test('replaced metadata conflict keeps ownership of unreleased prior versions',async t=>{
 const f=await fixture(t,{initial:true}),c=await conflict(f),entry=c.sides[0].entry;
 f.db.put('sourceSyncVersions',{id:'xxxxx-pin',projectId:'p',entry});await resolve(f,c);await f.write('a','new-a');await f.write('b','new-b');await f.sync();const next=f.db.get('sourceSyncConflicts',c.id);assert.ok(next.generation>c.generation);assert.ok((next.pendingCopyEntries||[]).some(e=>e.hash===entry.hash));f.db.remove('sourceSyncVersions','xxxxx-pin');await resolve(f,next);assert.equal(await f.home.storage.has('p',entry),false);
});
test('GC and initialization queries use their partial indexes',async t=>{
 const f=await fixture(t,{initial:true});const prepare=f.db.db.prepare.bind(f.db.db),plans=[];
 f.db.db.prepare=sql=>{if(sql.startsWith('SELECT data FROM records')&&(sql.includes('LIMIT 16')||sql.includes('LIMIT 8'))){plans.push(...prepare('EXPLAIN QUERY PLAN '+sql).all('').map(r=>r.detail));}return prepare(sql);};
 f.home.baselines.tick();await f.home.cleanupMetadataConflicts();assert.ok(plans.some(p=>p.includes('records_metadata_init')));assert.ok(plans.some(p=>p.includes('records_metadata_conflict_gc')));
});
test('resume requires confirmed current revision and request identity',async t=>{
 const f=await fixture(t,{initial:true}),j=start(f);pause(f,j);
 for(const input of [{},auth(f,{confirmed:false}),auth(f,{revision:-1}),auth(f,{requestId:''})])assert.throws(()=>f.home.baselines.resume('p',j.id,input),e=>e.code==='confirmation_required');
 assert.equal(f.db.get('sourceSyncInitializations',j.id).attempt,0);
});
test('resume retries are idempotent even after the job pauses again',async t=>{
 const f=await fixture(t,{initial:true}),j=start(f);pause(f,j);
 const first=f.home.baselines.resume('p',j.id,auth(f));assert.equal(first.attempt,1);f.db.put('sourceSyncInitializations',{...first,status:'paused'});
 assert.equal(f.home.baselines.resume('p',j.id,auth(f)).attempt,1);assert.equal(f.db.get('sourceSyncInitializations',j.id).status,'paused');
 assert.equal(f.home.baselines.resume('p',j.id,auth(f,{requestId:'xxxxx-second'})).attempt,2);
});
test('browser resume validates body and accepts explicitly authorized retry',async t=>{
 const f=await fixture(t,{initial:true}),j=start(f);pause(f,j);const url=f.clients.a.home+'/api/projects/p/source-sync/initializations/'+j.id+'/resume';
 const post=input=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
 assert.equal((await post({})).status,400);const r=await post(auth(f));assert.equal(r.status,200);assert.equal((await r.json()).attempt,1);
});
