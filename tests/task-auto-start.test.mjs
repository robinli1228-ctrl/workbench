// A todo task nobody works on starts by itself once the whole chat is quiet: its owner gets one internal turn to begin it,
// at most once per task revision. A question waiting for the user (an active run) keeps the chat busy, so nothing starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {Rooms} from '../src/rooms.mjs';
import {ConversationTasks} from '../src/conversation-tasks.mjs';
import {ProactiveFollowup} from '../src/proactive-followup.mjs';
import {wakeTaskReturns} from '../src/task-return.mjs';

function setup(t){
  const db=new Store(':memory:');t.after(()=>db.close());
  db.put('projects',{id:'p',supervisorRoleId:'sup'});
  for(const id of ['sup','claude'])db.put('roles',{id,projectId:'p',name:id,nodeId:'node',runtime:'claude',model:'xxxxx',mode:'workspace-write',enabled:true});
  let time=Date.now();const f=new ProactiveFollowup(db,new Rooms(db),{clock:()=>new Date(time)}),tasks=new ConversationTasks(db);
  f.save('p',{revision:0,enabled:true,silenceMinutes:1});
  const create=(id,extra={})=>tasks.create({projectId:'p'},{requestId:id,title:`task ${id}`,description:'xxxxx',ownerRoleId:'claude',...extra},{user:true});
  const tick=(ms=65000)=>{time+=ms;f.tick();};
  const starts=()=>db.list('roomMessages').filter(m=>m.kind==='task_start');
  const reminders=()=>db.list('tasks').filter(x=>x.proactiveInitial);
  return {db,f,tasks,create,tick,starts,reminders};
}

test('a quiet chat starts its oldest todo task with the owner, linked to the task, once per revision', t=>{
  const e=setup(t);const first=e.create('a');e.create('b');e.f.tick();
  e.tick();
  assert.equal(e.starts().length,1);assert.equal(e.reminders().length,0,'the task starts instead of reminding the supervisor');
  const message=e.starts()[0],task=e.db.get('tasks',message.taskIds[0]),request=e.db.get('coordinationRequests',task.requestId||`task:${task.id}`);
  assert.equal(task.roleId,'claude');assert.equal(message.visibility,'internal');assert.match(message.text,/T1/);
  assert.equal(request.conversationTaskId,first.id);assert.equal(request.taskStart,true);
  // The started turn is still queued: the chat is busy, nothing else starts.
  e.tick();e.tick();assert.equal(e.starts().length,1);
  // The owner's turn ended without moving the task: its reply restarts the window, and the same revision is not started again.
  e.db.put('tasks',{...task,status:'completed'});e.db.put('coordinationRequests',{...request,status:'succeeded'});
  e.db.put('roomMessages',{id:'result-r1',projectId:'p',sender:'agent',text:'Waiting for priority.',runId:'r1'});
  e.tick();e.tick();
  assert.deepEqual(e.starts().map(m=>m.source.conversationTaskId).sort(),[first.id,e.tasks.list({projectId:'p'}).find(x=>x.number===2).id].sort(),'then the next todo task');
});

test('a question waiting for the user, work in progress, a running call on the task or no owner start nothing', t=>{
  const e=setup(t);e.create('a');e.f.tick();
  e.db.put('runs',{id:'r',projectId:'p',status:'waiting_user'});e.tick();e.tick();
  assert.equal(e.starts().length,0,'an unanswered question keeps the chat busy');
  e.db.put('runs',{id:'r',projectId:'p',status:'succeeded'});
  const busy=setup(t),task=busy.create('a');busy.f.tick();
  busy.db.put('coordinationRequests',{id:'c1',projectId:'p',conversationId:'p',targetRoleId:'sup',conversationTaskId:task.id,status:'waiting_call'});
  busy.tick();assert.equal(busy.starts().length,0,'a task with an open call is being worked on');
  const progress=setup(t);progress.create('a',{status:'in_progress'});progress.f.tick();progress.tick();
  assert.equal(progress.starts().length,0);assert.equal(progress.reminders().length,1,'only todo tasks start; the supervisor is reminded of the rest');
});

test('closing the task before its start turn runs withdraws the turn', t=>{
  const e=setup(t);const a=e.create('a');e.f.tick();e.tick();
  const task=e.db.get('tasks',e.starts()[0].taskIds[0]);
  e.tasks.update({projectId:'p'},a.id,{revision:a.revision,status:'cancelled'},{user:true});
  wakeTaskReturns(e.db,()=>{throw new Error('no return expected');});
  assert.equal(e.db.get('tasks',task.id).status,'cancelled');
});
