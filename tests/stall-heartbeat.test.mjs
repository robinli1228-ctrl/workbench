import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';
import {Rooms} from '../src/rooms.mjs';
import {ProactiveFollowup} from '../src/proactive-followup.mjs';
import {runWithLanguage} from '../src/i18n.mjs';

function fixture(t,{saved=true}={}) {
  const db=new Store(':memory:');t.after(()=>db.close());
  db.put('projects',{id:'p',name:'xxxxx',supervisorRoleId:'supervisor'});
  for(const id of ['supervisor','owner'])db.put('roles',{id,projectId:'p',name:id,nodeId:'node',runtime:'claude',model:'xxxxx',mode:'workspace-write',enabled:true});
  let time=Date.now();const followup=new ProactiveFollowup(db,new Rooms(db),{clock:()=>new Date(time)});
  if(saved)followup.save('p',{revision:0,enabled:true,silenceMinutes:10});
  const message=(id,extra={})=>db.put('roomMessages',{id,projectId:'p',sender:'human',text:'xxxxx',...extra});
  const final=(status='succeeded',patch={})=>{
    db.put('coordinationRequests',{id:'request',projectId:'p',targetRoleId:'owner',status:status==='succeeded'?'succeeded':'failed'});
    db.put('runs',{id:'run',projectId:'p',roleId:'owner',requestId:'request',status,...patch});
    message('result-run',{sender:'agent',roleId:'owner',runId:'run'});
  };
  const advance=(ms=11*60000)=>{time+=ms;followup.tick();};
  const alerts=()=>db.list('tasks').filter(t=>t.proactiveInitial);
  return {db,followup,message,final,advance,alerts};
}

test('default-on discovery initializes both old and new chats at the tail without replay',t=>{
 const e=fixture(t,{saved:false});e.message('old');
 assert.equal(e.followup.get('p').enabled,true);
 e.followup.tick();assert.equal(e.followup.get('p').cursor,e.db.messageCursor('p'));
 e.advance();assert.equal(e.alerts().length,0);
 e.message('new');e.advance();assert.equal(e.alerts().length,1);
 e.db.put('groupConversations',{id:'group',projectId:'p',title:'xxxxx'});e.message('group-old',{conversationId:'group'});
 e.advance();assert.equal(e.followup.get('p','group').cursor,e.db.messageCursor('p','group'));
 e.message('group-new',{conversationId:'group'});e.advance();assert.equal(e.alerts().filter(t=>t.conversationId==='group').length,1);
});
test('first settings save snapshots old messages even though the default is enabled',t=>{
 const e=fixture(t,{saved:false});e.message('old');e.followup.save('p',{revision:0,enabled:true,silenceMinutes:1});e.advance();assert.equal(e.alerts().length,0);
});
test('a successful final answer suppresses reminders, including after restart, until a new message',t=>{
 const e=fixture(t);e.final();e.advance();assert.equal(e.alerts().length,0);
 new ProactiveFollowup(e.db,new Rooms(e.db),{clock:()=>new Date(Date.now()+86400000)}).tick();assert.equal(e.alerts().length,0);
 e.message('new');e.advance();assert.equal(e.alerts().length,1);
});
for(const status of ['failed','interrupted'])test(`${status} owner triggers once and cannot repeat after restart`,t=>{
 const e=fixture(t);e.final(status);e.advance();assert.equal(e.alerts().length,1);
 e.advance();new ProactiveFollowup(e.db,new Rooms(e.db),{clock:()=>new Date(Date.now()+86400000)}).tick();assert.equal(e.alerts().length,1);
});
for(const dependency of ['handoffWait','child','transfer','childContinuation'])test(`successful reply with unfinished ${dependency} still needs attention`,t=>{
 const e=fixture(t);e.final('succeeded',dependency==='handoffWait'?{handoffWait:{requestIds:['child']}}:{});
 if(dependency!=='handoffWait')e.db.put('coordinationRequests',{id:'child',projectId:'p',targetRoleId:'owner',status:dependency==='childContinuation'?'succeeded':'blocked',...(dependency==='transfer'?{transferredFrom:'request'}:{parentRequestId:'request'}),...(dependency==='childContinuation'?{continuationRequestId:'continued'}:{})});
 if(dependency==='childContinuation')e.db.put('coordinationRequests',{id:'continued',projectId:'p',targetRoleId:'owner',continuationOf:'child',status:'blocked'});
 e.advance();assert.equal(e.alerts().length,1);
});
test('completed transfer is quiet; an unfinished request in another chat does not contaminate it',t=>{
 const e=fixture(t);e.final();e.db.put('coordinationRequests',{id:'done',projectId:'p',transferredFrom:'request',targetRoleId:'owner',status:'succeeded'});
 e.db.put('coordinationRequests',{id:'other',projectId:'p',conversationId:'other-chat',parentRequestId:'request',status:'blocked'});
 e.advance();assert.equal(e.alerts().length,0);
});
test('running work postpones the silence window; explicit off remains off',t=>{
 const e=fixture(t);e.message('new');e.db.put('runs',{id:'busy',projectId:'p',status:'running'});e.advance();assert.equal(e.alerts().length,0);
 e.db.put('runs',{id:'busy',projectId:'p',status:'failed'});e.advance();assert.equal(e.alerts().length,1);
 const off=fixture(t,{saved:false});off.followup.save('p',{revision:0,enabled:false,silenceMinutes:1});off.message('ignored');off.advance();assert.equal(off.alerts().length,0);assert.equal(off.followup.get('p').enabled,false);
});
test('an ordinary agent note is not a final result',t=>{
 const e=fixture(t);e.final();e.message('note',{sender:'agent',runId:'run'});e.advance();assert.equal(e.alerts().length,1);
});
test('reminders include scoped request, failure and transfer facts in both languages',t=>{
 for(const language of ['en','zh'])runWithLanguage(language,()=>{
 const e=fixture(t);e.final('interrupted');
 e.db.put('coordinationRequests',{id:'transfer',projectId:'p',transferredFrom:'request',targetRoleId:'owner',status:'blocked',waitingReason:'xxxxx-offline',currentRunId:'run'});
 e.db.put('coordinationRequests',{id:'hidden',projectId:'another-project',status:'blocked',waitingReason:'SECRET'});
 e.advance();const task=e.alerts()[0];assert.ok(task);assert.match(task.prompt,/transfer/);assert.match(task.prompt,/xxxxx-offline/);assert.match(task.prompt,/interrupted/);assert.match(task.prompt,/owner/);assert.match(task.prompt,/wb history/);assert.doesNotMatch(task.prompt,/SECRET/);
 assert.match(task.prompt,language==='en'?/Stall reminder/i:/\u505c\u6ede\u63d0\u9192/);
 // Admission refresh must preserve facts, not revert to the generic reminder.
 assert.match(e.followup.prepareStart(task.id).prompt,/xxxxx-offline/);
 });
});
test('frequent ticks do no repeated discovery or message work; large discovery proceeds in bounded pages',t=>{
 const e=fixture(t,{saved:false});for(let i=0;i<220;i++)e.db.put('projects',{id:`q${String(i).padStart(3,'0')}`,name:'xxxxx'});
 e.followup.tick();const first=e.db.list('proactiveFollowups').length;assert.ok(first>0&&first<=100);
 const arrivals=e.db.messageArrivals.bind(e.db);let reads=0;e.db.messageArrivals=(...args)=>{reads++;return arrivals(...args);};
 for(let i=0;i<100;i++)e.followup.tick();assert.equal(reads,0);
 e.advance(15000);e.advance(15000);assert.equal(e.db.list('proactiveFollowups').length,221);
});

// A stale discussion wait is not executing or queued work.
test('a handoff whose peers have stopped is not suppressed by a waiting discussion record',t=>{
 const e=fixture(t);e.final('succeeded',{handoffWait:{requestIds:['peer']}});
 e.db.put('tasks',{id:'wait',projectId:'p',origin:'chat',status:'waiting_discussion'});
 e.db.put('coordinationRequests',{id:'peer',projectId:'p',parentRequestId:'request',status:'cancelled'});
 e.advance();assert.equal(e.alerts().length,1);
});
test('editing the default duration retains messages observed since automatic initialization',t=>{
 const e=fixture(t,{saved:false});e.followup.tick();e.message('new');e.advance(15000);
 const before=e.followup.get('p');e.followup.save('p',{revision:before.revision,enabled:true,silenceMinutes:1});
 e.advance(60000);assert.equal(e.alerts().length,1);
});
test('a stale supervisor wait covering the source is not a delivered stall reminder',t=>{
 const e=fixture(t);e.message('new');e.db.put('coordinationRequests',{id:'stale',projectId:'p',targetRoleId:'supervisor',sourceMessageId:'new',status:'waiting_call'});
 e.advance();assert.equal(e.alerts().length,1);assert.notEqual(e.followup.get('p').requestId,'stale');
});
test('latest failed run is selected by completion time rather than start time',t=>{
 const e=fixture(t);e.message('new');
 e.db.put('runs',{id:'recently-finished',projectId:'p',roleId:'owner',status:'failed',createdAt:'2025-01-01T00:00:00Z',finishedAt:'2025-01-01T03:00:00Z'});
 e.db.put('runs',{id:'recently-started',projectId:'p',roleId:'owner',status:'interrupted',createdAt:'2025-01-01T01:00:00Z',finishedAt:'2025-01-01T02:00:00Z'});
 e.advance();const prompt=e.alerts()[0].prompt;assert.match(prompt,/recently-finished/);assert.match(prompt,/2025-01-01T03:00:00Z/);assert.doesNotMatch(prompt,/recently-started/);
});
