import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import net from 'node:net';
import {Store} from '../src/store.mjs';
import {RoleCalls} from '../src/role-calls.mjs';
import {reviewView} from '../src/collaboration-sessions.mjs';

async function until(fn){const deadline=Date.now()+15000;while(Date.now()<deadline){if(await fn())return;await new Promise(r=>setTimeout(r,50));}throw Error('isolated Home condition timeout');}
test('retired review browser controls unblock saved requests without reopening collection',async t=>{
 const root=fileURLToPath(new URL('../',import.meta.url)),data=await mkdtemp(join(tmpdir(),'xxxxx-review-'));
 const db=new Store(join(data,'home.sqlite')),token=randomUUID(),workerToken=randomUUID();let home,log='';
 t.after(async()=>{if(home&&home.exitCode===null&&home.signalCode===null){home.kill('SIGTERM');await until(()=>home.exitCode!==null||home.signalCode!==null);}db.close();await rm(data,{recursive:true,force:true});});
 db.put('settings',{id:'main',paused:false});db.put('projects',{id:'p',name:'xxxxx',folderName:'xxxxx',features:{collaborationSessions:true}});
 for(const id of ['a','b'])db.put('roles',{id,projectId:'p',name:'xxxxx',enabled:true,nodeId:'offline',runtime:'claude',model:'xxxxx',mode:'workspace-write'});
 for(const id of ['s','closed']){
  db.put('collaborationSessions',{id,projectId:'p',conversationId:'p',type:'independent-review',state:'open',goal:'xxxxx',participants:[{roleId:'a',reviewer:true},{roleId:'b',reviewer:true}]});
  db.put('runs',{id:'source-'+id,projectId:'p',roleId:'a',roleSnapshot:db.get('roles','a'),collaborationSessionId:id,status:'succeeded'});
  db.put('coordinationRequests',{id:'request-'+id,projectId:'p',conversationId:'p',targetRoleId:'b',targetSnapshot:db.get('roles','b'),sourceRunId:'source-'+id,status:'queued',kind:'consult',summary:'xxxxx',createdAt:new Date().toISOString()});
 }
 const calls=new RoleCalls(db);for(const id of ['s','closed']){calls.reconcile('request-'+id);assert.equal(db.get('coordinationRequests','request-'+id).waitingReason,'review_isolation');}
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const address=socket.address();await new Promise(r=>socket.close(r));const url=`http://${address.address}:${address.port}`;
 home=spawn(process.execPath,['src/home.mjs'],{cwd:root,env:{PATH:process.env.PATH,HOST:address.address,PORT:String(address.port),DATA_DIR:data,API_TOKEN:token,WORKER_TOKEN:workerToken,LANG:'en'},stdio:['ignore','pipe','pipe']});home.stdout.on('data',b=>log+=b);home.stderr.on('data',b=>log+=b);
 const request=async(path,method='POST',body={})=>{const r=await fetch(url+path,{method,headers:{Authorization:'Bearer '+(path.startsWith('/api/agent/')?workerToken:token),'Content-Type':'application/json'},...(method==='GET'?{}:{body:JSON.stringify(body)})});return{status:r.status,body:await r.json()};};
 try{await until(async()=>{try{return(await request('/healthz','GET')).status===200;}catch{return false;}});}catch(e){throw Error(e.message+' '+log);}
 const base='/api/projects/p/collaboration-sessions';
 await t.test('human release removes review isolation and the scheduler admits the saved request',async()=>{
  assert.equal(db.get('coordinationRequests','request-s').taskId,undefined);
  const r=await request(base+'/s/release');assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.body.reviewReleasedBy.kind,'human');
  await until(()=>db.get('coordinationRequests','request-s').taskId);
  const saved=db.get('coordinationRequests','request-s');assert.equal(db.get('tasks',saved.taskId).roleId,'b');assert.equal(reviewView(db,{projectId:'p',roleId:'b'}).get('coordinationRequests',saved.id).reviewRedacted,undefined);
  const timestamp=r.body.reviewReleasedAt;assert.equal((await request(base+'/s/release')).body.reviewReleasedAt,timestamp);
 });
 await t.test('close preserves protection; the human can explicitly release a closed review',async()=>{
  const r=await request(base+'/closed/close');assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.body.state,'closed');assert.equal(r.body.closedBy.kind,'human');assert.ok(!r.body.reviewReleasedAt);
  assert.equal(reviewView(db,{projectId:'p',roleId:'b'}).get('coordinationRequests','request-closed').reviewRedacted,true);
  assert.equal((await request(base+'/closed/release')).status,200);await until(()=>db.get('coordinationRequests','request-closed').taskId);
 });
 await t.test('all collection and configuration writes remain gone; reads remain available',async()=>{
  for(const suffix of ['','/feature','/queue-config','/test-project','/s/members','/s/link','/s/budget','/s/broadcast'])for(const method of ['POST','PUT','DELETE'])assert.equal((await request(base+suffix,method,{enabled:true})).status,410,suffix+' '+method);
  assert.equal((await request(base,'GET')).status,200);assert.equal(db.get('projects','p').features.collaborationSessions,false);assert.equal(db.list('collaborationSessions').length,2);
 });
 await t.test('release is existing-session and project scoped; no agent entry is restored',async()=>{
  assert.equal((await request(base+'/missing/release')).status,400);
  assert.equal((await request('/api/projects/other/collaboration-sessions/s/release')).status,400);
  db.put('runs',{id:'agent',projectId:'p',roleId:'a',roleSnapshot:db.get('roles','a'),status:'running'});
  const rejected=await request('/api/agent/collaboration-sessions','POST',{runId:'agent',action:'release',sessionId:'s'});assert.equal(rejected.status,400);assert.match(rejected.body.error,/Unknown collaboration endpoint/i);
  db.put('runs',{...db.get('runs','agent'),status:'succeeded'});
 });
});

test('queue exposes only human release and close; closed unreleased reviews keep release',async t=>{
 const {renderSessionQueue}=await import('../public/session-queue.js');
 const create=(tag,cls,text)=>({tag,text,children:[],append(...items){this.children.push(...items);},setAttribute(){}});
 const requests=[];let refreshes=0;const original=globalThis.confirm;globalThis.confirm=()=>true;t.after(()=>{if(original===undefined)delete globalThis.confirm;else globalThis.confirm=original;});
 const options={create,roleName:x=>x,projectId:'p',api:async(...args)=>requests.push(args),refreshState:async()=>refreshes++};
 const session={id:'s',goal:'xxxxx',type:'independent-review',state:'open',participants:['a','b'],reviewReleased:false};
 const buttons=s=>renderSessionQueue({sessions:[s],cycles:[{rootSessionId:'s',paused:true,ended:false}]},options).children.at(-1).children.filter(n=>n.tag==='button');
 const open=buttons(session);assert.deepEqual(open.map(b=>b.text),['Release reviews','End discussion']);await open[0].onclick();await open[1].onclick();
 assert.deepEqual(requests.map(([url])=>url),['/api/projects/p/collaboration-sessions/s/release','/api/projects/p/collaboration-sessions/s/close']);assert.equal(refreshes,2);
 assert.deepEqual(buttons({...session,state:'closed'}).map(b=>b.text),['Release reviews']);assert.equal(buttons({...session,state:'closed',reviewReleased:true}).length,0);
});
