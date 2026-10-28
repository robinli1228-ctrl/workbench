import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {readFileSync} from 'node:fs';
import {normalizePlatformSettings,defaultPlatformPrompt,defaultSupervisorPrompt,executionRules} from '../src/platform-prompts.mjs';
import {runWithLanguage} from '../src/i18n.mjs';import {helpText} from '../src/wb-tools.mjs';import {agentRequest} from '../src/agent-bridge.mjs';
import {Store} from '../src/store.mjs';import {SessionQueue} from '../src/session-queue.mjs';
const old=JSON.parse(readFileSync(new URL('./fixtures/pre-task-prompts.json',import.meta.url)));
for(const lang of ['en','zh'])test(`${lang} defaults migrate exactly, custom and empty remain intact`,()=>runWithLanguage(lang,()=>{
 const current=normalizePlatformSettings({platformPrompt:old[lang].platform,supervisorPrompt:old[lang].supervisor});
 assert.match(current.platformPrompt,/wb task create/);assert.match(current.supervisorPrompt,/wb task list/);
 assert.equal(current.platformPrompt,defaultPlatformPrompt());assert.equal(current.supervisorPrompt,defaultSupervisorPrompt());
 for(const value of ['',old[lang].platform+' xxxxx'])assert.equal(normalizePlatformSettings({platformPrompt:value}).platformPrompt,value);
 for(const value of ['',old[lang].supervisor+' xxxxx'])assert.equal(normalizePlatformSettings({supervisorPrompt:value}).supervisorPrompt,value);
}));
for(const cmd of ['schedule','collaboration','pass'])test(`${cmd} explains retirement before loading retained turn identity`,()=>{
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('WB_')));
 const r=spawnSync(process.execPath,['src/wb-cli.mjs',cmd],{env:{...env,LANG:'en',WB_SYSTEM_SUPERVISOR:'1',WB_QUEUE_BATCH:'1'},encoding:'utf8'});
 assert.equal(r.status,1);assert.match(r.stdout+r.stderr,/is retired|已停用/);
});
test('help, execution rules and the bridge expose none of the removed tools',async()=>{
 const prior={...process.env};process.env.WB_SYSTEM_SUPERVISOR='1';process.env.WB_QUEUE_BATCH='1';
 try{assert.doesNotMatch(helpText(),/wb (schedule|collaboration|pass)\b/);assert.doesNotMatch(executionRules({collaborationBatchId:'old'},{minimal:true}),/wb pass/);
 for(const tool of ['schedule','collaboration-sessions','pass']){await assert.rejects(agentRequest(`/api/agent/${tool}`,{}));}}
 finally{for(const k of ['WB_SYSTEM_SUPERVISOR','WB_QUEUE_BATCH'])if(prior[k]===undefined)delete process.env[k];else process.env[k]=prior[k];}
});
test('retirement disables collection, cancels only definitely unstarted batches and keeps uncertain delivery',t=>{
 const db=new Store(':memory:');t.after(()=>db.close());db.put('projects',{id:'p',features:{collaborationSessions:true,xxxxx:true}});
 const q=new SessionQueue(db);
 for(const [id,attempted,status]of[['queued',false,'reserved'],['unknown',undefined,'reserved'],['sent',true,'reserved'],['active',true,'processing']]){
 db.put('sessionBatches',{id,projectId:'p',sessionId:'s',roleId:'r',status,deliveryAttempted:attempted,messageIds:[],budget:null});
 db.put('tasks',{id,projectId:'p',collaborationBatchId:id,status:'ready',...(attempted?{currentRunId:id}:{})});}
 q.retire();assert.equal(db.get('projects','p').features.collaborationSessions,false);assert.equal(db.get('projects','p').features.xxxxx,true);
 assert.equal(db.get('sessionBatches','queued').status,'released');assert.equal(db.get('tasks','queued').status,'cancelled');
 assert.equal(db.get('sessionBatches','unknown').status,'reserved');assert.equal(db.get('tasks','unknown').status,'ready');
 assert.equal(db.get('sessionBatches','sent').status,'reserved');assert.equal(db.get('sessionBatches','active').status,'processing');
 q.retire();assert.equal(db.get('sessionBatches','queued').status,'released');
});
test('old plans can finish or be cancelled after command retirement',async t=>{
 const {ExecutionPlans}=await import('../src/execution-plans.mjs');const db=new Store(':memory:');t.after(()=>db.close());
 const plans=new ExecutionPlans(db,{},async()=>null);db.put('runs',{id:'source',status:'succeeded'});
 db.put('coordinationRequests',{id:'parent',status:'succeeded'});
 db.put('executionPlans',{id:'finished',projectId:'p',sourceRunId:'source',parentRequestId:'parent',status:'running',stages:[{status:'succeeded'}]});
 db.put('coordinationRequests',{id:'cancelled',status:'cancelled'});
 db.put('executionPlans',{id:'cancelled',projectId:'p',sourceRunId:'source',parentRequestId:'cancelled',status:'running',stages:[{status:'pending'}]});
 await plans.advance();assert.equal(db.get('executionPlans','finished').status,'succeeded');assert.equal(db.get('executionPlans','cancelled').status,'cancelled');
 assert.equal(db.list('executionPlans').length,2);
});
test('retired batch still settles through a saved reply or original Worker verification',t=>{
 const db=new Store(':memory:');t.after(()=>db.close());db.put('projects',{id:'p',features:{collaborationSessions:true}});const q=new SessionQueue(db);
 db.put('sessionBatches',{id:'b',projectId:'p',sessionId:'s',roleId:'r',status:'processing',messageIds:[],repliedMessageIds:['reply'],runId:'r'});
 db.put('sessionBatches',{id:'v',projectId:'p',sessionId:'s',roleId:'r',status:'pending_verification',messageIds:[],reservation:{id:'v'}});
 q.retire();q.finish({id:'r',collaborationBatchId:'b',status:'succeeded'});assert.equal(db.get('sessionBatches','b').status,'processed');
 assert.equal(q.verify('v',{}).status,'pending_verification');assert.equal(q.verify('v',{started:false,processSettled:true}).status,'released');
});
test('retirement status and history labels are translated',async()=>{
 const {default:zh}=await import('../public/locales/zh.js');for(const text of ['Legacy plan history · read only','Collaboration sessions are retired. Existing records are read-only.'])assert.ok(zh[text]&&zh[text]!==text);
});
