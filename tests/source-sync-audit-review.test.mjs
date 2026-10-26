import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {Store} from '../src/store.mjs';
import {SourceSyncAudit} from '../src/source-sync-audit.mjs';
const DAY=86400000;
function setup(t){const db=new Store(':memory:');t.after(()=>db.close());let now=Date.parse('2026-01-01');return {db,audit:new SourceSyncAudit({db,now:()=>now}),advance:n=>now+=n};}
const batch=id=>({id,projectId:'p',detection:'metadata',generation:1,nodeIds:['a','b'],status:'completed'});
const op=path=>({repositoryId:'scope',path,source:'a',observed:{a:{exists:true,mtimeNs:'1',size:1},b:{exists:false}}});
const done={status:'succeeded',phase:'confirmed'};
test('all precached assets and served script relative imports have Home static routes',async()=>{
 const home=await readFile(new URL('../src/home.mjs',import.meta.url),'utf8');
 const start=home.indexOf('const files = {'),end=home.indexOf('const file = files[pathname]',start);
 assert.ok(start>0&&end>start);
 const files=runInNewContext(home.slice(start,end)+';files');
 const sw=await readFile(new URL('../public/sw.js',import.meta.url),'utf8');
 const paths=runInNewContext(sw.slice(0,sw.indexOf('const staticPaths'))+';STATIC');
 const missing=[];
 for(const path of paths)if(!files[path])missing.push('precache '+path);
 for(const [route,file] of Object.entries(files))if(file.endsWith('.js')){
  const script=await readFile(new URL('../public/'+file,import.meta.url),'utf8');
  for(const match of script.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.[^'"]+)['"]/g)){
   const path=new URL(match[1],'https://xxxxx.invalid'+route).pathname;
   if(!files[path])missing.push(route+' -> '+path);
  }
 }
 assert.deepEqual(missing,[]);
});
test('terminal identities and heads expire in bounded restartable batches; active identity survives',t=>{
 const f=setup(t);for(let i=0;i<205;i++)f.audit.record(batch('xxxxx'+i),op('file'+i),done);
 const active=f.audit.record(batch('active'),op('active'),{status:'syncing',phase:'apply'});
 f.advance(30*DAY-1);f.audit.cleanup();assert.equal(f.db.list('sourceSyncAuditStates').length,206);
 f.advance(DAY+1);
 const fresh=new SourceSyncAudit({db:f.db,now:f.audit.now});
 for(let i=0;i<5;i++){const before=f.db.list('sourceSyncAuditStates').length;fresh.cleanup();const after=f.db.list('sourceSyncAuditStates').length;assert.ok(before-after<=100);}
 assert.equal(f.db.list('sourceSyncAuditStates').length,1);assert.equal(f.db.list('sourceSyncAuditHeads').length,1);
 const next=f.audit.record(batch('active'),op('active'),{status:'syncing',phase:'stage'});assert.equal(next.operationId,active.operationId);
});
test('retention preserves newer head and unfinished batch recovery despite a terminal file outcome',t=>{
 const f=setup(t);f.audit.record(batch('old'),op('file'),done);f.audit.record(batch('new'),op('file'),{status:'syncing',phase:'read'});
 f.db.put('sourceSyncBatches',{...batch('uncertain'),status:'cancelling'});
 f.audit.record(batch('uncertain'),op('uncertain'),{status:'failed',phase:'cancelled'});
 f.advance(31*DAY);for(let i=0;i<4;i++)f.audit.cleanup();
 assert.equal(f.db.list('sourceSyncAuditStates').length,2);assert.equal(f.db.list('sourceSyncAuditHeads').length,2);
 f.db.put('sourceSyncBatches',batch('uncertain'));f.advance(DAY);f.audit.cleanup();
 assert.equal(f.db.list('sourceSyncAuditStates').length,1);
});
test('project deletion removes all audit and initialization kinds only in that project',t=>{
 const f=setup(t);f.db.createProject({id:'p',name:'xxxxx'});
 const kinds=['sourceSyncAudit','sourceSyncAuditStates','sourceSyncAuditHeads','sourceSyncInitializations','sourceSyncInitializationResumes'];
 for(const kind of kinds)for(const projectId of ['p','other'])f.db.put(kind,{id:projectId,projectId});
 f.db.deleteProject('p');for(const kind of kinds){assert.equal(f.db.get(kind,'p'),null,kind);assert.ok(f.db.get(kind,'other'));}
});
test('10000-path observe indexes command paths/results linearly and unchanged receipts open no per-file transactions',t=>{
 const f=setup(t),count=10000;let reads=0,transactions=0;
 const counted=i=>({get path(){reads++;return 'file'+i;},status:'applied',observed:{exists:true,mtimeNs:'2',size:1}});
 const b={...batch('xxxxx'),metadataOperations:Array.from({length:count},(_,i)=>op('file'+i))};
 const paths=Array.from({length:count},(_,i)=>counted(i));
 f.db.listSourceSyncCommands=()=>[{repositoryId:'scope',nodeId:'b',action:'apply',paths,result:{status:'completed',files:paths}}];
 const transaction=f.db.transaction.bind(f.db);f.db.transaction=fn=>{transactions++;return transaction(fn);};
 f.audit.observe(b);assert.ok(reads<=count*10,`path reads ${reads}`);assert.ok(transactions<=1,`transactions ${transactions}`);
 assert.equal(f.audit.list('p').items[0].status,'succeeded');assert.equal(f.db.list('sourceSyncAudit').length,count);
 reads=0;transactions=0;let writes=0;const put=f.db.put.bind(f.db);f.db.put=(...args)=>{writes++;return put(...args);};f.audit.observe(b);assert.equal(writes,0);assert.ok(reads<=count*10,`repeat path reads ${reads}`);assert.ok(transactions<=1,`repeat transactions ${transactions}`);
});
test('uncertain commands preserve expired terminal identity until a later daily sweep',t=>{
 const f=setup(t);f.db.put('sourceSyncBatches',batch('xxxxx'));
 f.audit.record(batch('xxxxx'),op('file'),done);
 f.db.put('sourceSyncCommands',{id:'xxxxx',projectId:'p',batchId:'xxxxx',status:'reconciling'});
 f.advance(31*DAY);f.audit.cleanup();assert.equal(f.db.list('sourceSyncAuditStates').length,1);
 f.db.put('sourceSyncCommands',{id:'xxxxx',projectId:'p',batchId:'xxxxx',status:'completed',result:{status:'completed'}});
 f.advance(DAY);f.audit.cleanup();assert.equal(f.db.list('sourceSyncAuditStates').length,0);assert.equal(f.db.list('sourceSyncAuditHeads').length,0);
});
test('isolated Home serves the audit ES module as JavaScript',async t=>{
 const {spawn}=await import('node:child_process'),{mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{fileURLToPath}=await import('node:url'),{createServer}=await import('node:net');
 const data=await mkdtemp(join(tmpdir(),'xxxxx-static-')),listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const address=listener.address();await new Promise(r=>listener.close(r));
 const child=spawn(process.execPath,['src/home.mjs'],{cwd:fileURLToPath(new URL('../',import.meta.url)),env:{PATH:process.env.PATH,HOST:address.address,PORT:String(address.port),DATA_DIR:data,API_TOKEN:'xxxxx',WORKER_TOKEN:'xxxxx',LANG:'en'},stdio:'ignore'});
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const stopped=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await stopped;}await rm(data,{recursive:true,force:true});});
 const base=`http://${address.address}:${address.port}`;let ready=false;
 for(let i=0;i<150;i++){try{if((await fetch(base+'/healthz')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}
 assert.ok(ready,'isolated Home started');const response=await fetch(base+'/source-sync-audit.js');assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/javascript/);assert.match(await response.text(),/export function/);
});
