import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {mkdtemp,mkdir,writeFile,readFile,rm,unlink,stat} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Store} from '../src/store.mjs';import {SourceSyncHome,SourceSyncClient} from '../src/source-sync-transport.mjs';
async function fixture(t,{initial=false,detection='metadata'}={}){const dir=await mkdtemp(join(tmpdir(),'xxxxx-s1-')),db=new Store(join(dir,'home.sqlite')),messages=[],errors=[],clients={},busy={};db.put('projects',{id:'p'});const sockets={};const home=new SourceSyncHome({db,data:join(dir,'home'),online:()=>true,socket:id=>sockets[id],change(){},rooms:{postSystemTask(){throw Error('model dispatch forbidden');}}});
const server=createServer(async(req,res)=>{try{if(!await home.workerHttp(req,res,new URL(req.url,'http://localhost').pathname)){res.writeHead(404);res.end();}}catch(e){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({code:e.code||'error',error:e.message}));}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
for(const id of ['a','b']){const root=join(dir,id);await mkdir(root);db.put('workers',{id,platform:id==='a'?'darwin':'linux',capabilities:{sourceSync:1,sourceSyncDirectory:1,sourceSyncMetadataMode:1}});db.put('workspaces',{id:`p:${id}`,projectId:'p',nodeId:id,localRoot:root});const wd=new Store(join(dir,`worker-${id}.sqlite`));if(initial)await writeFile(join(root,'file.txt'),id);clients[id]=new SourceSyncClient({db:wd,data:join(dir,`data-${id}`),home:`http://127.0.0.1:${server.address().port}`,send:m=>messages.push([id,m]),resolveBinding:async c=>({...c,root}),activeRuns:()=>busy[id]?[{projectId:'p',status:'running'}]:[]});sockets[id]={workerReady:true,readyState:1,send:raw=>{const m=JSON.parse(raw);if(m.type==='source_sync_receipt_ack')clients[id].acknowledge(m.commandId,m);}};}
t.after(async()=>{for(const c of Object.values(clients)){c.watch.close();c.db.close();}await new Promise(r=>server.close(r));db.close();await rm(dir,{recursive:true,force:true});});
async function pump(){for(let i=0;i<30;i++){const commands=home.sync.schedule();if(!commands.length)break;for(const c of commands)await clients[c.nodeId].execute({commandId:c.id,secret:c.secret});for(const c of Object.values(clients))c.flush();while(messages.length){const [id,m]=messages.shift();try{await home.message(id,m);}catch(e){errors.push(e);}}if(commands.every(c=>busy[c.nodeId]))break;}if(errors.length)throw errors[0];}
const preview=home.sync.preview('p',{requestId:'preview',repositoryIds:['project-files:p'],nodeIds:['a','b'],scopeKind:'directory',displayNodeId:'a',...(detection?{detection}:{})});await pump();assert.equal(db.get('sourceSyncBatches',preview.id).status,'preview_ready');home.sync.configure('p',{enabled:true,revision:0,previewBatchId:preview.id});let n=0;
return {db,home,clients,busy,dir,pump,async sync(){const b=home.sync.request('p',{requestId:`sync${++n}`,sourceNodeId:'a',targetNodeIds:['b']});await pump();return db.get('sourceSyncBatches',b.id);},async write(id,text,path='file.txt'){await writeFile(join(dir,id,path),text);},read:id=>readFile(join(dir,id,'file.txt'),'utf8')};}

// A sync conflict waits for the user, never for a model; the user's choice overwrites with the chosen device's latest file.
const pick=(f,sourceNodeId)=>f.home.conflicts.choose('p',[{repositoryId:'project-files:p',path:'file.txt',sourceNodeId}]);
for(const detection of ['metadata',null]){
  const mode=detection||'content hash';
  test(`${mode}: a conflict goes to the user, not to a model`,async t=>{
    const f=await fixture(t,{detection});await f.write('a','base');await f.sync();
    f.db.put('roles',{id:'sup',projectId:'p',name:'Supervisor',enabled:true,nodeId:'a',runtime:'claude',model:'m'});f.db.put('projects',{...f.db.get('projects','p'),supervisorRoleId:'sup'});
    await f.write('a','left');await f.write('b','right');assert.equal((await f.sync()).status,'partial_conflict');
    f.home.conflicts.tick();f.home.conflicts.tick();// the fixture throws if a model task is posted
    const c=f.db.list('sourceSyncConflicts')[0];assert.equal(c.status,'needs_input');
    assert.equal(f.db.list('roomMessages').length,0);assert.equal(f.db.list('tasks').length,0);
  });
  test(`${mode}: choosing a device overwrites the others even if files changed after the choice`,async t=>{
    const f=await fixture(t,{detection});await f.write('a','base');await f.sync();
    await f.write('a','left');await f.write('b','right');await f.sync();f.home.conflicts.tick();
    const [chosen]=pick(f,'a');assert.equal(chosen.status,'applying');
    await f.write('a','newest');await f.write('b','edited again');await f.pump();
    assert.equal(await f.read('b'),'newest','the chosen device latest file wins');assert.equal(await f.read('a'),'newest');
    assert.equal(f.db.list('sourceSyncConflicts')[0].status,'resolved');
    assert.equal(f.db.list('roomMessages').length,0);
  });
}

test('metadata: the conflict dialog device button also overwrites with the latest file',async t=>{
  const f=await fixture(t);await f.write('a','base');await f.sync();await f.write('a','left');await f.write('b','right');await f.sync();
  const c=f.db.list('sourceSyncConflicts')[0];
  const result=await f.home.chooseVersions('p',[{repositoryId:c.repositoryId,path:c.path,sourceNodeId:'a'}]);assert.equal(result[0].status,'applying');
  await f.write('a','newest');await f.pump();assert.equal(await f.read('b'),'newest');assert.equal(f.db.get('sourceSyncConflicts',c.id).status,'resolved');
});
test('content hash: conflicts can no longer be assigned to a role',async t=>{
  const f=await fixture(t,{detection:null});await f.write('a','base');await f.sync();await f.write('a','left');await f.write('b','right');await f.sync();
  const c=f.db.list('sourceSyncConflicts')[0];assert.throws(()=>f.home.conflicts.assign(c.id,c.generation,'r',{kind:'human'}),e=>e.code==='assignment_not_allowed');
});
test('content hash: choosing a deleted version deletes the file on the other device even after it changed again',async t=>{
  const {unlink}=await import('node:fs/promises');
  const f=await fixture(t,{detection:null});await f.write('a','base');await f.sync();
  await unlink(join(f.dir,'a','file.txt'));await f.write('b','kept');assert.equal((await f.sync()).status,'partial_conflict');f.home.conflicts.tick();
  assert.equal(pick(f,'a')[0].status,'applying');await f.write('b','edited again');await f.pump();
  await assert.rejects(f.read('b'),{code:'ENOENT'});assert.equal(f.db.list('sourceSyncConflicts')[0].status,'resolved');
});
