import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {mkdtemp,mkdir,writeFile,readFile,rm,unlink,stat} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Store} from '../src/store.mjs';import {SourceSyncHome,SourceSyncClient} from '../src/source-sync-transport.mjs';
async function fixture(t,{initial=false,detection='metadata',nodes=['a','b']}={}){const dir=await mkdtemp(join(tmpdir(),'xxxxx-s1-')),db=new Store(join(dir,'home.sqlite')),messages=[],errors=[],clients={},busy={};db.put('projects',{id:'p'});const sockets={};const home=new SourceSyncHome({db,data:join(dir,'home'),online:()=>true,socket:id=>sockets[id],change(){},rooms:{postSystemTask(){throw Error('model dispatch forbidden');}}});
const server=createServer(async(req,res)=>{try{if(!await home.workerHttp(req,res,new URL(req.url,'http://localhost').pathname)){res.writeHead(404);res.end();}}catch(e){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({code:e.code||'error',error:e.message}));}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
for(const id of nodes){const root=join(dir,id);await mkdir(root);db.put('workers',{id,platform:id==='a'?'darwin':'linux',capabilities:{sourceSync:1,sourceSyncDirectory:1,sourceSyncMetadataMode:1}});db.put('workspaces',{id:`p:${id}`,projectId:'p',nodeId:id,localRoot:root});const wd=new Store(join(dir,`worker-${id}.sqlite`));if(initial)await writeFile(join(root,'file.txt'),id);clients[id]=new SourceSyncClient({db:wd,data:join(dir,`data-${id}`),home:`http://127.0.0.1:${server.address().port}`,send:m=>messages.push([id,m]),resolveBinding:async c=>({...c,root}),activeRuns:()=>busy[id]?[{projectId:'p',status:'running'}]:[]});sockets[id]={workerReady:true,readyState:1,send:raw=>{const m=JSON.parse(raw);if(m.type==='source_sync_receipt_ack')clients[id].acknowledge(m.commandId,m);}};}
t.after(async()=>{for(const c of Object.values(clients)){c.watch.close();c.db.close();}await new Promise(r=>server.close(r));db.close();await rm(dir,{recursive:true,force:true});});
async function pump(){for(let i=0;i<30;i++){const commands=home.sync.schedule();if(!commands.length)break;for(const c of commands)await clients[c.nodeId].execute({commandId:c.id,secret:c.secret});for(const c of Object.values(clients))c.flush();while(messages.length){const [id,m]=messages.shift();try{await home.message(id,m);}catch(e){errors.push(e);}}if(commands.every(c=>busy[c.nodeId]))break;}if(errors.length)throw errors[0];}
const preview=home.sync.preview('p',{requestId:'preview',repositoryIds:['project-files:p'],nodeIds:nodes,scopeKind:'directory',displayNodeId:'a',...(detection?{detection}:{})});await pump();assert.equal(db.get('sourceSyncBatches',preview.id).status,'preview_ready');home.sync.configure('p',{enabled:true,revision:0,previewBatchId:preview.id});let n=0;
return {db,home,clients,busy,dir,pump,async sync(targets=nodes.slice(1)){const b=home.sync.request('p',{requestId:`sync${++n}`,sourceNodeId:'a',targetNodeIds:targets});await pump();return db.get('sourceSyncBatches',b.id);},async write(id,text,path='file.txt'){await writeFile(join(dir,id,path),text);},read:id=>readFile(join(dir,id,'file.txt'),'utf8')};}

// A conflict whose two files later end up identical (two roles wrote the same document, or one copied it across) settles
// by itself on the next sync; one that still differs keeps waiting for the user.
for(const detection of ['metadata',null]){
  const mode=detection||'content hash';
  test(`${mode}: a conflict settles once both devices hold the same content`,async t=>{
    const f=await fixture(t,{detection});await f.write('a','base');await f.sync();
    await f.write('a','left!');await f.write('b','right');assert.equal((await f.sync()).status,'partial_conflict');
    const open=f.db.list('sourceSyncConflicts')[0];assert.ok(['open','needs_input'].includes(open.status));
    f.db.put('tasks',{id:'repair',projectId:'p',status:'queued',sourceConflictId:open.id});
    await f.write('a','same!');await f.write('b','same!');const settled=await f.sync();
    assert.equal(f.db.get('tasks','repair').status,'cancelled','an unstarted repair task for it is cancelled');
    const c=f.db.get('sourceSyncConflicts',open.id);assert.equal(c.status,'resolved');assert.equal(c.resolution,'converged');
    assert.equal(settled.status,'completed');assert.equal(f.db.listSourceSyncCommands({batchId:settled.id,action:'apply'}).length,0);
    await f.write('a','after');assert.equal((await f.sync()).status,'completed');assert.equal(await f.read('b'),'after','the path syncs normally again');
  });
  test(`${mode}: a conflict whose files still differ keeps waiting`,async t=>{
    const f=await fixture(t,{detection});await f.write('a','base');await f.sync();
    await f.write('a','left!');await f.write('b','right');await f.sync();const open=f.db.list('sourceSyncConflicts')[0];
    await f.write('a','aaaaa');await f.write('b','bbbbb');const again=await f.sync();
    assert.notEqual(f.db.get('sourceSyncConflicts',open.id).status,'resolved');assert.equal(again.status,'partial_conflict');
    assert.equal(await f.read('a'),'aaaaa');assert.equal(await f.read('b'),'bbbbb');
  });
}

test('content hash: a batch over some devices does not settle a conflict another device still disagrees on',async t=>{
  const f=await fixture(t,{detection:null,nodes:['a','b','c']});await f.write('a','base');await f.sync();
  await f.write('a','left!');await f.write('c','right');assert.equal((await f.sync()).status,'partial_conflict');const open=f.db.list('sourceSyncConflicts')[0];
  await f.write('b','left!');await f.sync(['b']);
  assert.notEqual(f.db.get('sourceSyncConflicts',open.id).status,'resolved');
  await f.write('c','left!');await f.sync();const c=f.db.get('sourceSyncConflicts',open.id);assert.equal(c.status,'resolved');assert.equal(c.resolution,'converged');
});

test('metadata: re-reads write no failed audit rows and skip conflicts unchanged since the last re-read',async t=>{
  const f=await fixture(t);await f.write('a','base');await f.sync();
  await f.write('a','left!');await f.write('b','right');await f.sync();const open=f.db.list('sourceSyncConflicts')[0];
  await f.write('a','aaaaa');await f.write('b','bbbbb');const first=await f.sync();
  assert.equal(f.db.listSourceSyncCommands({batchId:first.id,action:'read'}).length,2,'changed same-size files are read again');
  const rows=()=>f.db.list('sourceSyncAudit').filter(r=>r.relativePath==='file.txt');const before=rows().length;
  await f.write('a','x','other.txt');const unrelated=await f.sync();
  assert.equal(f.db.listSourceSyncCommands({batchId:unrelated.id,action:'read'}).some(c=>c.paths.some(p=>p.path==='file.txt')),false,'unchanged conflict is not read again');
  assert.equal(rows().length,before,'no new audit row for the open conflict');
  await f.write('a','same!');await f.write('b','same!');const settled=await f.sync();
  assert.equal(f.db.get('sourceSyncConflicts',open.id).status,'resolved');
  const mine=f.db.list('sourceSyncAudit').filter(r=>r.relativePath==='file.txt'&&r.batchId===settled.id);
  assert.ok(mine.length&&mine.every(r=>r.status==='succeeded'&&r.action==='confirm_equal'),JSON.stringify(mine.map(r=>[r.status,r.action])));
});
