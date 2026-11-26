// A project made from a folder picked on the Mac: the other server gets a folder of the project's name, sync turns on, and
// the first sync copies the picked folder's files there.
import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {mkdtemp,mkdir,writeFile,readFile,rm,readdir} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Store} from '../src/store.mjs';import {SourceSyncHome,SourceSyncClient} from '../src/source-sync-transport.mjs';import {ProjectSyncSetup} from '../src/project-sync-setup.mjs';

async function fixture(t,{serverCaps={}}={}){
  const dir=await mkdtemp(join(tmpdir(),'xxxxx-pss-')),db=new Store(join(dir,'home.sqlite')),messages=[],errors=[],clients={},sockets={};
  db.put('projects',{id:'p',name:'P',folderName:'proj'});
  const home=new SourceSyncHome({db,data:join(dir,'home'),online:()=>true,socket:id=>sockets[id],change(){},rooms:{postSystemTask(){throw Error('model dispatch forbidden');}}});
  const server=createServer(async(req,res)=>{try{if(!await home.workerHttp(req,res,new URL(req.url,'http://localhost').pathname)){res.writeHead(404);res.end();}}catch(e){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({code:e.code||'error',error:e.message}));}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const picked=join(dir,'picked'),serverRoot=join(dir,'server-root');await mkdir(picked);await mkdir(serverRoot);
  await writeFile(join(picked,'README.md'),'hello');await mkdir(join(picked,'docs'));await writeFile(join(picked,'docs','plan.md'),'plan');
  const caps={sourceSync:1,sourceSyncDirectory:1,projectSpace:1};
  db.put('workers',{id:'a',name:'Macbook',platform:'darwin',nodeKind:'local',capabilities:{...caps,localFolderSelection:1}});
  db.put('workers',{id:'b',name:'Debian',platform:'linux',nodeKind:'server',workspaceRoot:serverRoot,capabilities:{...caps,directoryCreate:1,workspaceBindings:1,...serverCaps}});
  db.bindWorkspace('p','a',{localRoot:picked,git:null});
  const rootOf=id=>db.get('workspaces',`p:${id}`)?.localRoot;
  for(const id of ['a','b']){const wd=new Store(join(dir,`worker-${id}.sqlite`));
    clients[id]=new SourceSyncClient({db:wd,data:join(dir,`data-${id}`),home:`http://127.0.0.1:${server.address().port}`,send:m=>messages.push([id,m]),resolveBinding:async c=>({...c,root:rootOf(id)}),activeRuns:()=>[]});
    sockets[id]={workerReady:true,readyState:1,send:raw=>{const m=JSON.parse(raw);if(m.type==='source_sync_receipt_ack')clients[id].acknowledge(m.commandId,m);}};}
  t.after(async()=>{for(const c of Object.values(clients)){c.watch.close();c.db.close();}await new Promise(r=>server.close(r));db.close();await rm(dir,{recursive:true,force:true});});
  async function pump(){for(let i=0;i<30;i++){const commands=home.sync.schedule();if(!commands.length)break;for(const c of commands)await clients[c.nodeId].execute({commandId:c.id,secret:c.secret});for(const c of Object.values(clients))c.flush();while(messages.length){const [id,m]=messages.shift();try{await home.message(id,m);}catch(e){errors.push(e);}}}if(errors.length)throw errors[0];}
  const query=async({nodeId},action,input)=>{
    if(action==='directory_create'){const path=join(input.path,input.name);await mkdir(path);return {path,parent:input.path,name:input.name};}
    if(action==='workspace_check')return {localRoot:input,git:null};
    throw Error(`unexpected ${action} on ${nodeId}`);
  };
  const setup=new ProjectSyncSetup({db,query,sourceSync:home,online:()=>true,sleepFor:pump});
  return {db,home,dir,pump,setup,serverRoot,picked};
}

test('the other server gets the project folder, sync turns on, and the first sync copies the picked files', async t => {
  const f=await fixture(t);
  const result=await f.setup.run('p','a');
  assert.equal(result.enabled,true,JSON.stringify(result));assert.deepEqual(result.joined.map(j=>j.nodeId),['b']);
  assert.equal(f.db.get('workspaces','p:b').localRoot,join(f.serverRoot,'proj'));
  const config=f.home.sync.config('p');assert.equal(config.enabled,true);assert.equal(config.mode,'continuous');assert.deepEqual(config.nodeIds.sort(),['a','b']);
  const batch=f.home.sync.request('p',{requestId:'first',sourceNodeId:'a',targetNodeIds:['b']});await f.pump();
  assert.equal(f.db.get('sourceSyncBatches',batch.id).status,'completed');
  assert.equal(await readFile(join(f.serverRoot,'proj','README.md'),'utf8'),'hello');assert.equal(await readFile(join(f.serverRoot,'proj','docs','plan.md'),'utf8'),'plan');
  assert.deepEqual((await readdir(f.picked)).sort(),['README.md','docs'],'nothing is added to the picked folder');
  const notice=f.db.get('roomMessages','project-sync-setup-p');assert.equal(notice.sender,'system');assert.match(notice.text,/Debian/);
  assert.equal(f.db.get('projects','p').syncSetup.status,'enabled');
});

test('a server that needs an update is left out and named; with no device left sync stays off', async t => {
  const f=await fixture(t,{serverCaps:{directoryCreate:0}});
  const result=await f.setup.run('p','a');
  assert.equal(result.enabled,false);assert.equal(result.error,'no_device');assert.deepEqual(result.skipped,[{nodeId:'b',reason:'upgrade'}]);
  assert.equal(f.home.sync.config('p').enabled,false);assert.equal(f.db.get('projects','p').syncSetup.status,'failed');
});

test('a repository bound inside the folder during the preview makes the setup preview again instead of failing', async t => {
  const f=await fixture(t);let added=false;
  const pump=f.setup.sleepFor;f.setup.sleepFor=async()=>{if(!added){added=true;await mkdir(join(f.picked,'code'));f.db.put('repositoryWorkspaces',{id:'repo1:a',projectId:'p',nodeId:'a',repositoryId:'repo1',localRoot:join(f.picked,'code')});}await pump();};
  const result=await f.setup.run('p','a');
  assert.equal(added,true);assert.equal(result.enabled,true,JSON.stringify(result));
  assert.deepEqual(f.home.sync.config('p').bindings.find(b=>b.nodeId==='a').scopePolicy.excludeRoots,['code']);
});

test('a setup cut short by a Home restart is reported as unfinished', async t => {
  const f=await fixture(t);
  f.db.put('projects',{...f.db.get('projects','p'),syncSetup:{status:'running',sourceNodeId:'a'}});
  f.setup.recover();
  assert.equal(f.db.get('projects','p').syncSetup.status,'failed');assert.equal(f.db.get('projects','p').syncSetup.error,'interrupted');
  assert.match(f.db.get('roomMessages','project-sync-setup-p').text,/restart/);
});
