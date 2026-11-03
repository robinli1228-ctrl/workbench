// A quiet chat wakes the supervisor after 15 minutes by default: first the exceptions, then every unfinished task, so work
// that is actually done gets closed and stuck work gets moved. The reminder lists those tasks without reading histories.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {Rooms} from '../src/rooms.mjs';
import {ConversationTasks} from '../src/conversation-tasks.mjs';
import {ProactiveFollowup} from '../src/proactive-followup.mjs';
import {runWithLanguage} from '../src/i18n.mjs';

function setup(t){
  const db=new Store(':memory:');t.after(()=>db.close());db.put('projects',{id:'p',supervisorRoleId:'sup'});
  for(const [id,name] of [['sup','主管'],['agy','Agy'],['exe','执行']])db.put('roles',{id,projectId:'p',name,nodeId:'node',runtime:'claude',model:'xxxxx',mode:'workspace-write',enabled:true});
  let time=Date.parse('2026-11-03T08:00:00.000Z');const clock=()=>new Date(time);
  const f=new ProactiveFollowup(db,new Rooms(db),{clock}),tasks=new ConversationTasks(db);
  const create=(id,input,scope={projectId:'p'})=>tasks.create(scope,{requestId:id,title:id,description:'xxxxx',...input},{user:true});
  return {db,f,tasks,create,advance:ms=>{time+=ms;}};
}

test('the default silence is 15 minutes; a chat that never saved its own setting moves from 10, a saved 10 stays', t => {
  const e=setup(t);
  assert.equal(e.f.get('p').silenceMinutes,15,'new chat');
  e.db.put('proactiveFollowups',{...e.f.get('p'),silenceMinutes:10,revision:0});
  assert.equal(e.f.get('p').silenceMinutes,15,'stored by the first observation under the old default');
  const saved=e.f.save('p',{revision:0,enabled:true,silenceMinutes:10});
  assert.equal(saved.revision,1);assert.equal(e.f.get('p').silenceMinutes,10,'a duration the user saved is kept');
});

test('the reminder lists unfinished tasks of this chat, oldest first, with owner, step and open calls; then asks to close or move them', t => runWithLanguage('zh',() => {
  const e=setup(t);
  const steps=(done,current)=>({steps:[{description:'a',status:'done'},{description:'b',status:done>1?'done':'in_progress'},{description:'c',status:done>2?'done':'todo'}],currentStep:current});
  const t24=e.create('T24-fix',{ownerRoleId:'agy',plan:steps(2,2)});e.tasks.update({projectId:'p'},t24.id,{revision:t24.revision,status:'in_progress'},{user:true});
  e.advance(60000);const t25=e.create('T25-fix',{ownerRoleId:'exe'});
  e.db.put('coordinationRequests',{id:'call',projectId:'p',conversationId:'p',conversationTaskId:t25.id,status:'running',targetRoleId:'exe'});
  const closed=e.create('closed');e.tasks.update({projectId:'p'},closed.id,{revision:closed.revision,status:'done'},{user:true});
  e.db.put('groupConversations',{id:'other',projectId:'p',title:'xxxxx'});e.create('other-chat',{},{projectId:'p',conversationId:'other'});
  const state=e.f.get('p'),text=e.f.reminder(state);
  const facts=JSON.parse(text.slice(text.indexOf('{"openTasks"'),text.indexOf('}。先处理异常')+1));
  assert.deepEqual(facts.tasks.map(x=>[x.task,x.title,x.owner,x.status,x.step,x.stepsDone,x.openCalls]),
    [['T1','T24-fix','Agy','in_progress','3/3',2,false],['T2','T25-fix','执行','todo',null,null,true]],'done tasks and other chats are left out');
  assert.match(text,/先处理异常/);assert.match(text,/实际已经做完的，核对证据后把剩余步骤和任务标为完成并写结果摘要/);
}));
