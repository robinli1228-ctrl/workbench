import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {Rooms} from '../src/rooms.mjs';
import {ConversationTasks} from '../src/conversation-tasks.mjs';
import {ProactiveFollowup} from '../src/proactive-followup.mjs';
function setup(t){
 const db=new Store(':memory:');t.after(()=>db.close());db.put('projects',{id:'p',supervisorRoleId:'owner'});
 db.put('roles',{id:'owner',projectId:'p',name:'xxxxx',nodeId:'node',runtime:'claude',model:'xxxxx',mode:'workspace-write',enabled:true});
 let time=Date.now();const f=new ProactiveFollowup(db,new Rooms(db),{clock:()=>new Date(time)}),tasks=new ConversationTasks(db);
 f.save('p',{revision:0,enabled:true,silenceMinutes:1});
 const create=(id='a',scope={projectId:'p'})=>tasks.create(scope,{requestId:id,title:'xxxxx',description:'xxxxx'},{user:true});
 const change=(task,status)=>tasks.update(task,task.id,{revision:task.revision,status},{user:true});
 const tick=(ms=65000)=>{time+=ms;f.tick();};const alerts=()=>db.list('tasks').filter(x=>x.proactiveInitial);
 return{db,f,tasks,create,change,tick,alerts,clock:()=>new Date(time)};
}
test('open task without new chat messages reminds once, including after restart',t=>{
 const e=setup(t);e.create();e.f.tick();assert.equal(e.alerts().length,0);e.tick();assert.equal(e.alerts().length,1);e.tick();
 new ProactiveFollowup(e.db,new Rooms(e.db),{clock:e.clock}).tick();assert.equal(e.alerts().length,1);
});
test('successful final reply cannot hide an unfinished task',t=>{
 const e=setup(t);e.create();e.f.tick();e.db.put('runs',{id:'r',projectId:'p',roleId:'owner',status:'succeeded'});
 e.db.put('roomMessages',{id:'result-r',projectId:'p',sender:'agent',text:'xxxxx',runId:'r'});e.tick();e.tick();assert.equal(e.alerts().length,1);
});
test('all closed tasks suppress user messages and cancel an unstarted reminder at admission',t=>{
 const e=setup(t),a=e.create();e.f.tick();e.tick();assert.equal(e.alerts().length,1);const pending=e.alerts()[0];
 e.change(a,'done');assert.equal(e.f.prepareStart(pending.id),null);assert.equal(e.db.get('tasks',pending.id).status,'cancelled');
 e.db.put('roomMessages',{id:'new',projectId:'p',sender:'human',text:'xxxxx'});e.tick();e.tick();assert.equal(e.alerts().length,1);
});
test('reopening starts a fresh window and a new reminder, without reusing the previous anchor',t=>{
 const e=setup(t);let a=e.create();e.f.tick();e.tick();const first=e.alerts()[0];assert.ok(first);
 a=e.change(a,'cancelled');e.tick();a=e.change(a,'todo');e.tick(15000);assert.equal(e.alerts().length,1);e.tick();assert.equal(e.alerts().length,2);assert.notEqual(e.alerts()[1].id,first.id);
});
test('running work and explicit off prevent task reminders',t=>{
 const e=setup(t);e.create();e.f.tick();e.db.put('runs',{id:'r',projectId:'p',status:'running'});e.tick();assert.equal(e.alerts().length,0);
 e.db.put('runs',{id:'r',projectId:'p',status:'failed'});e.tick();assert.equal(e.alerts().length,1);
 const off=setup(t);off.f.save('p',{revision:1,enabled:false,silenceMinutes:1});off.create();off.tick();off.tick();assert.equal(off.alerts().length,0);
});
test('task state stays scoped and closed chats do not read message arrivals',t=>{
 const e=setup(t);e.db.put('groupConversations',{id:'other',projectId:'p',title:'xxxxx'});e.create('other',{projectId:'p',conversationId:'other'});
 const a=e.create();e.change(a,'done');e.f.tick();let closedReads=0;const read=e.db.messageArrivals.bind(e.db);e.db.messageArrivals=(p,c,g)=>{if(g==='p')closedReads++;return read(p,c,g);};
 e.tick();assert.equal(closedReads,0);assert.equal(e.alerts().filter(a=>a.conversationId==='p').length,0);
});
test('task heartbeat summary follows mutations once and does not parse full task histories on tick',t=>{
 const e=setup(t),a=e.create();e.create();e.f.tick();const read=e.db.listProject.bind(e.db);e.db.listProject=(kind,...args)=>{assert.notEqual(kind,'conversationTasks');return read(kind,...args);};e.tick();assert.equal(e.alerts().length,1);
 e.change(a,'done');e.tick();assert.equal(e.alerts().filter(x=>x.status!=='cancelled').length,0);
});
test('explicit re-enable starts a fresh task window even without any task edits',t=>{
 const e=setup(t);e.create();e.f.tick();e.tick();assert.equal(e.alerts().length,1);
 e.f.save('p',{revision:1,enabled:false,silenceMinutes:1});e.f.save('p',{revision:2,enabled:true,silenceMinutes:1});
 e.tick(15000);e.tick();assert.equal(e.alerts().length,2);
});
test('aggregate records cannot cross the conversation read lens',async t=>{
 const {conversationView}=await import('../src/group-conversations.mjs');const e=setup(t);
 e.db.put('groupConversations',{id:'other',projectId:'p',title:'xxxxx'});
 e.db.put('conversationTaskActivity',{id:'other',projectId:'p',conversationId:'other',total:1,open:1,version:1});
 assert.equal(conversationView(e.db,{projectId:'p',conversationId:'p'}).get('conversationTaskActivity','other'),null);
});
