import test from 'node:test';import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';import {RoleDiscussions} from '../src/role-discussions.mjs';
import {Rooms} from '../src/rooms.mjs';import {WechatChannel} from '../src/wechat-channel.mjs';
import {tr,setLanguage} from '../src/i18n.mjs';
function env(t){const db=new Store(':memory:');t.after(()=>db.close());db.put('projects',{id:'p',name:'xxxxx'});return {db,discussions:new RoleDiscussions(db)};}
test('retired discussion recovery cancels valid queued and blocked resume intents without replay',t=>{
 const {db,discussions}=env(t);db.put('roleSessions',{id:'session',status:'idle'});
 for(const status of ['queued','blocked']){
  db.put('tasks',{id:status,projectId:'p',status:'blocked',directionRevision:1,requestId:'request-'+status,discussionResumeBlocked:{threadId:status}});
  db.put('coordinationRequests',{id:'request-'+status,projectId:'p',taskId:status,status:'waiting_call'});
  db.put('discussionThreads',{id:status,projectId:'p',taskId:status,status:'resolved',ownerSessionId:'session'});
  db.put('runs',{id:'after-'+status,projectId:'p',status:'succeeded'});
  db.put('discussionIntents',{id:status,projectId:'p',taskId:status,threadId:status,afterRunId:'after-'+status,directionRevision:1,status});
 }
 assert.equal(discussions.recover().changed,true);
 for(const id of ['queued','blocked']){assert.equal(db.get('discussionIntents',id).status,'cancelled');assert.equal(db.get('tasks',id).status,'cancelled');assert.equal(db.get('tasks',id).discussionResumeBlocked,null);assert.equal(db.get('coordinationRequests','request-'+id).status,'cancelled');}
 assert.equal(db.list('runs').length,2);assert.equal(db.list('commands').length,0);assert.equal(discussions.recover().changed,false);
});
test('open threads and orphan waits close without stopping an active process or releasing its session',t=>{
 const {db,discussions}=env(t);
 db.put('tasks',{id:'wait',projectId:'p',status:'waiting_discussion',currentRunId:'r',discussionWait:{threadId:'thread',questionId:'q'}});
 db.put('tasks',{id:'orphan',projectId:'p',status:'waiting_discussion',discussionWait:{threadId:'missing'}});
 db.put('tasks',{id:'normal',projectId:'p',status:'ready'});
 db.put('discussionThreads',{id:'thread',projectId:'p',taskId:'wait',status:'open',revision:2});
 db.put('discussionThreads',{id:'done',projectId:'p',taskId:'normal',status:'resolved',revision:4});
 db.put('discussionDeliveries',{id:'queued',projectId:'p',taskId:'wait',threadId:'thread',messageId:'missing',recipientSessionId:'missing',status:'queued'});
 db.put('discussionDeliveries',{id:'consumed',projectId:'p',taskId:'normal',threadId:'done',messageId:'missing',recipientSessionId:'missing',status:'consumed'});
 db.put('runs',{id:'r',projectId:'p',taskId:'wait',nodeId:'node',roleSessionId:'session',discussionWaiting:true,status:'running'});
 db.put('roleSessions',{id:'session',activeRunId:'r',status:'busy'});
 assert.equal(discussions.recover().changed,true);
 assert.equal(db.get('tasks','orphan').status,'cancelled');assert.equal(db.get('tasks','orphan').discussionWait,null);assert.equal(db.get('tasks','wait').status,'waiting_discussion');assert.equal(db.get('tasks','wait').discussionWait.threadId,'thread');
 assert.equal(db.get('discussionThreads','thread').status,'cancelled');assert.equal(db.get('discussionThreads','done').status,'resolved');assert.equal(db.get('discussionDeliveries','queued').status,'cancelled');assert.equal(db.get('discussionDeliveries','consumed').status,'consumed');assert.equal(db.get('tasks','normal').status,'ready');
 assert.equal(db.get('runs','r').status,'running');assert.equal(db.get('roleSessions','session').activeRunId,'r');assert.equal(db.list('commands').length,0);assert.equal(discussions.recover().changed,false);assert.equal(db.list('commands').length,0);
});
test('saved needs_input reports remain data but cannot manufacture a question or override a final reply',t=>{
 const {db}=env(t);const run={id:'r',projectId:'p',roleId:'a',roleSnapshot:{name:'xxxxx'},status:'succeeded',result:'Actual final reply'};
 db.put('runReports',{id:'r',projectId:'p',verdict:'needs_input',summary:'Old question',revision:1});
 new Rooms(db).complete(run);assert.equal(db.get('roomMessages','result-r').text,'Actual final reply');assert.equal(db.get('runReports','r').summary,'Old question');
 const quiet={...run,id:'private',explicitPublish:true};db.put('runReports',{id:'private',projectId:'p',verdict:'needs_input',summary:'Must stay private'});new Rooms(db).complete(quiet);assert.equal(db.get('roomMessages','result-private'),null);
});
test('old report-based WeChat questions close without delivery or answer consumption',t=>{
 const {db}=env(t);db.put('runs',{id:'r',projectId:'p',status:'succeeded'});db.put('runReports',{id:'r',projectId:'p',verdict:'needs_input',revision:1});
 db.put('wechatLinks',{id:'link',projectId:'p',runId:'r',kind:'question',reportRevision:1,state:'pending',hubId:'remote'});
 const channel=new WechatChannel({db,change(){}});assert.equal(channel.current('link'),null);assert.equal(db.get('wechatLinks','link').state,'closed');assert.equal(db.get('wechatLinks','link').cancelRequested,true);assert.equal(db.get('runReports','r').revision,1);
});
test('English and Chinese call/note help instruct reviewers to use their final reply once',()=>{
 for(const language of ['en','zh']){setLanguage(language);const help=tr('wbTools.builtInCollaborationToolsWorkbench');assert.match(help,language==='en'?/When consulted or reviewing, put your conclusion in the final reply; do not repeat it with wb note\./:/被请教或审核时，结论写在最终回复里，不要再用 wb note 重复。/);}
 setLanguage('en');
});

test('queued and blocked intents never cancel their running business turn or an unrelated ready task',t=>{
 const {db,discussions}=env(t);
 for(const status of ['queued','blocked']){
  db.put('tasks',{id:status,projectId:'p',status:'in_progress',currentRunId:'run-'+status,requestId:'request-'+status});
  db.put('coordinationRequests',{id:'request-'+status,projectId:'p',status:'running'});
  db.put('runs',{id:'run-'+status,projectId:'p',taskId:status,status:'running'});
  db.put('discussionIntents',{id:status,projectId:'p',taskId:status,status,afterRunId:'run-'+status});
 }
 db.put('tasks',{id:'ready',projectId:'p',status:'ready'});
 db.put('discussionIntents',{id:'ready',projectId:'p',taskId:'ready',status:'queued',afterRunId:'finished'});
 const tasks=db.list('tasks'),runs=db.list('runs'),requests=db.list('coordinationRequests');
 discussions.recover();assert.ok(db.list('discussionIntents').every(i=>i.status==='cancelled'));
 assert.deepEqual(db.list('tasks'),tasks);assert.deepEqual(db.list('runs'),runs);assert.deepEqual(db.list('coordinationRequests'),requests);assert.deepEqual(db.list('commands'),[]);assert.equal(discussions.recover().changed,false);
});
test('discussion wait cleanup protects every nonterminal run association but releases settled waits',t=>{
 const {db,discussions}=env(t);
 const cases=[['pointer','running'],['taskId','reconciling'],['businessTaskId','stopping']];
 for(const [link,status] of cases){
  db.put('tasks',{id:link,projectId:'p',status:'blocked',discussionResumeBlocked:{threadId:'old'},...(link==='pointer'?{currentRunId:link}:{})});
  db.put('runs',{id:link,projectId:'p',status,...(link==='pointer'?{}:{[link]:link})});
 }
 db.put('tasks',{id:'settled',projectId:'p',status:'waiting_discussion',currentRunId:'done',discussionWait:{threadId:'old'}});db.put('runs',{id:'done',projectId:'p',status:'succeeded'});
 const before=cases.map(([id])=>db.get('tasks',id)),runs=db.list('runs');discussions.recover();
 assert.deepEqual(cases.map(([id])=>db.get('tasks',id)),before);assert.deepEqual(db.list('runs'),runs);assert.equal(db.get('tasks','settled').status,'cancelled');assert.equal(db.get('tasks','settled').discussionWait,null);assert.deepEqual(db.list('commands'),[]);assert.equal(discussions.recover().changed,false);
});
test('legacy supervisor wrapper retains the configured prompt without retired scheduling instructions',async()=>{
 const plans=await import('../src/execution-plans.mjs');assert.equal('schedulingRules' in plans,false);
 for(const language of ['en','zh']){setLanguage(language);const wrapper=tr('home.supervisorWorkingConventions',{supervisorPrompt:'xxxxx supervisor'});assert.match(wrapper,/xxxxx supervisor/);assert.doesNotMatch(wrapper,/schedulingRules|failurePolicy|collect_reviews/);}
 setLanguage('en');
});
