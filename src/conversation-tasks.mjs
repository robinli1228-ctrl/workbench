import {createHash} from 'node:crypto';
import {conversationIdOf,resolveConversationId,assertConversationRecord,agentConversationInput} from './group-conversations.mjs';
import {reviewView} from './collaboration-sessions.mjs';
import {tr} from './i18n.mjs';

const statuses=['todo','in_progress','done','cancelled'];
const fields=['title','description','plan','ownerRoleId','status','resultSummary','messageIds'];
const fail=(key,status=400)=>{throw Object.assign(new Error(tr(`conversationTasks.${key}`)),{status});};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const text=(value,limit,empty=false)=>{if(typeof value!=='string'||value.length>limit||(!empty&&!value.trim()))fail('invalid');return value;};
const keys=(value,allowed)=>{if(!object(value)||Object.keys(value).some(k=>!allowed.includes(k)))fail('invalid');};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Home-only planning records, distinct from executable tasks. Every entry point has an explicit conversation lens. */
export class ConversationTasks {
  constructor(db){this.db=db;}
  /** One small Home-only aggregate per chat. Upgrade initializes it once; mutations update it in their transaction. */
  activity(context){
    const scope=this.scope(context),id=JSON.stringify([scope.projectId,scope.conversationId]);
    const previous=this.db.get('conversationTaskActivity',id);if(previous)return previous;
    const counts=this.db.db.prepare("SELECT COUNT(*) AS total,COALESCE(SUM(json_extract(data,'$.status') IN ('todo','in_progress')),0) AS open FROM records WHERE kind='conversationTasks' AND json_extract(data,'$.projectId')=? AND json_extract(data,'$.conversationId')=?").get(scope.projectId,scope.conversationId);
    return this.db.put('conversationTaskActivity',{id,...scope,...counts,version:0});
  }
  persist(record,previous=null){
    const activity=this.activity(record),open=t=>Number(Boolean(t&&['todo','in_progress'].includes(t.status)));
    this.db.put('conversationTaskActivity',{...activity,total:activity.total+Number(!previous),open:activity.open+open(record)-open(previous),version:activity.version+1});
    return this.db.put('conversationTasks',record);
  }
  scope(context){return {projectId:context.projectId,conversationId:resolveConversationId(this.db,context.projectId,context.conversationId)};}
  actor(scope,actor){
    if(actor?.user===true)return {type:'user'};
    if(!actor?.runId||this.db.get('roles',actor.roleId)?.projectId!==scope.projectId)fail('actor',403);
    return {type:'role',roleId:actor.roleId,runId:actor.runId};
  }
  // Keep archived roles only in unchanged historical references; new assignments still require an active project role.
  role(scope,id,retained=false){if(id!==null&&(typeof id!=='string'||this.db.get('roles',id)?.projectId!==scope.projectId||(!retained&&this.db.get('roles',id)?.archivedAt)))fail('owner');return id;}
  plan(scope,value,previous=null){
    if(value===null)return null;
    keys(value,['steps','currentStep']);
    if(!Array.isArray(value.steps)||value.steps.length>50||!Number.isInteger(value.currentStep)||value.currentStep<0||value.currentStep>=Math.max(1,value.steps.length))fail('plan');
    const steps=value.steps.map((step,index)=>{
      const before=previous?.steps?.[index];
      keys(step,['title','description','roleId','collaborators','review','handoffRoleId','status']);
      const result={...step,title:text(step.title,200),status:step.status||'todo'};
      if(!['todo','in_progress','done'].includes(result.status))fail('plan');
      if(step.description!==undefined)text(step.description,2000,true);
      for(const key of ['roleId','handoffRoleId'])if(step[key]!==undefined)this.role(scope,step[key],before?.[key]===step[key]);
      if(step.collaborators!==undefined){if(!Array.isArray(step.collaborators)||step.collaborators.length>20)fail('plan');step.collaborators.forEach(id=>this.role(scope,id,before?.collaborators?.includes(id)));}
      if(step.review!==undefined){keys(step.review,['roleIds','count','sequential']);if(!Array.isArray(step.review.roleIds)||step.review.roleIds.length>20||!Number.isInteger(step.review.count)||step.review.count<0||step.review.count>20||typeof step.review.sequential!=='boolean')fail('plan');step.review.roleIds.forEach(id=>this.role(scope,id,before?.review?.roleIds?.includes(id)));}
      return result;
    });
    if(JSON.stringify(value).length>16000)fail('plan');
    return {steps,currentStep:value.currentStep};
  }
  validate(scope,input,current={}){
    const value={...current};
    for(const key of fields)if(Object.hasOwn(input,key))value[key]=structuredClone(input[key]);
    text(value.title,200);text(value.description,12000);
    if(!statuses.includes(value.status))fail('status');
    this.role(scope,value.ownerRoleId,current.ownerRoleId===value.ownerRoleId);
    value.plan=this.plan(scope,value.plan,current.plan);
    if(!Array.isArray(value.messageIds)||value.messageIds.length>100||new Set(value.messageIds).size!==value.messageIds.length)fail('invalid');
    for(const id of value.messageIds)assertConversationRecord(scope,this.db.get('roomMessages',id));
    if(Object.hasOwn(input,'resultSummary')){if(value.status!=='done')fail('summary');text(input.resultSummary,8000,true);}
    if(value.status==='done'&&value.plan?.steps.length&&(value.plan.currentStep!==value.plan.steps.length-1||value.plan.steps.some(s=>s.status!=='done')))fail('unfinished');
    if(value.status!=='done')value.resultSummary=null;
    return value;
  }
  list(context,{status}={}){
    const scope=this.scope(context);
    if(status!==undefined&&status!=='all'&&!statuses.includes(status))fail('status');
    return this.db.listProject('conversationTasks',scope.projectId).filter(t=>t.conversationId===scope.conversationId&&(status==='all'||(status?t.status===status:!['done','cancelled'].includes(t.status)))).sort((a,b)=>a.number-b.number);
  }
  show(context,id){
    const scope=this.scope(context);
    const value=typeof id==='string'&&/^T[1-9][0-9]*$/i.test(id)?this.list(scope,{status:'all'}).find(t=>t.number===Number(id.slice(1))):this.db.get('conversationTasks',id||'');
    if(!value||value.projectId!==scope.projectId||value.conversationId!==scope.conversationId)fail('notFound',404);
    return value;
  }
  create(context,input,actor){return this.db.transaction(()=>{
    const scope=this.scope(context),who=this.actor(scope,actor);keys(input,[...fields,'requestId','reason']);
    if(typeof input.requestId!=='string'||!/^[a-zA-Z0-9:_-]{1,200}$/.test(input.requestId))fail('requestId');
    const id=`ct:${digest([scope,input.requestId])}`,fingerprint=digest([who,input]);
    const previous=this.db.get('conversationTasks',id);
    if(previous){if(previous.createFingerprint!==fingerprint)fail('retry',409);return previous;}
    const value=this.validate(scope,input,{ownerRoleId:who.roleId||null,status:'todo',plan:null,resultSummary:null,messageIds:[]});
    const number=this.list(scope,{status:'all'}).reduce((n,t)=>Math.max(n,t.number),0)+1,time=new Date().toISOString();
    const record={...value,...scope,id,number,revision:1,descriptionRevision:1,requestId:input.requestId,createFingerprint:fingerprint,createdAt:time,updatedAt:time,
      history:[{revision:1,at:time,actor:who,reason:input.reason===undefined?'':text(input.reason,1000,true),changes:Object.fromEntries(fields.map(k=>[k,{from:null,to:value[k]}]))}]};
    return this.persist(record);
  });}
  update(context,id,input,actor){return this.db.transaction(()=>{
    const scope=this.scope(context),who=this.actor(scope,actor),current=this.show(scope,id);keys(input,[...fields,'revision','reason']);
    if(!Number.isInteger(input.revision)||input.revision!==current.revision)fail('revision',409);
    const value=this.validate(scope,input,current);
    if(value.ownerRoleId!==current.ownerRoleId){
      if(who.type!=='user'&&who.roleId!==current.ownerRoleId&&who.roleId!==this.db.get('projects',scope.projectId)?.supervisorRoleId)fail('permission',403);
      if(!Object.hasOwn(input,'description')||value.description===current.description)fail('handover');
    }
    const changes=Object.fromEntries(fields.filter(k=>JSON.stringify(current[k])!==JSON.stringify(value[k])).map(k=>[k,{from:current[k],to:value[k]}]));
    if(!Object.keys(changes).length)fail('noChange');
    const revision=current.revision+1,time=new Date().toISOString();
    return this.persist({...value,revision,descriptionRevision:changes.description?revision:current.descriptionRevision,updatedAt:time,
      history:[...current.history,{revision,at:time,actor:who,reason:input.reason===undefined?'':text(input.reason,1000,true),changes}]},current);
  });}
  /** Shared planning data cannot serve as a side channel for unreleased reviewer content. */
  visible(record,run){const view=reviewView(this.db,{projectId:run.projectId,roleId:run.roleId});return !record.history.some(h=>h.actor.runId&&view.get('runs',h.actor.runId)?.reviewRedacted);}
  agent(run,action,input={}){
    agentConversationInput(run,input);const scope=this.scope(run),actor={roleId:run.roleId,runId:run.id};
    if(action==='list'){keys(input,['status']);return this.list(scope,input).filter(t=>this.visible(t,run));}
    if(action==='show'){keys(input,['id']);const value=this.show(scope,input.id);if(!this.visible(value,run))fail('notFound',404);return value;}
    if(action==='create')return this.create(scope,input,actor);
    if(action==='update'){const {id,...patch}=input,value=this.show(scope,id);if(!this.visible(value,run))fail('notFound',404);return this.update(scope,id,patch,actor);}
    fail('usage');
  }
  /** Called inside createAgentCalls' transaction, after admission succeeds. No partial ownership on a rejected call. */
  transfer(run,id,targetRoleId){
    const task=this.show(run,id);if(!this.visible(task,run))fail('notFound',404);
    if(task.ownerRoleId!==run.roleId)fail('permission',403);
    if(['done','cancelled'].includes(task.status))fail('closed');
    // Only the most recent description rewrite counts; a later user/peer edit invalidates the old handover. A task this
    // run created itself already carries a description written now, so it can be handed over at once.
    const edit=task.history.findLast(h=>h.changes.description);
    if(!edit||edit.actor.runId!==run.id||edit.actor.roleId!==run.roleId)fail('editFirst');
    const revision=task.revision+1,time=new Date().toISOString();
    return this.persist({...task,ownerRoleId:targetRoleId,status:'in_progress',revision,updatedAt:time,
      history:[...task.history,{revision,at:time,actor:{type:'role',roleId:run.roleId,runId:run.id},reason:tr('conversationTasks.transferReason'),
        changes:{ownerRoleId:{from:task.ownerRoleId,to:targetRoleId},status:{from:task.status,to:'in_progress'}}}]},task);
  }
  /** Explicit --task calls and their continuations only; unrelated turns of the same owner inherit nothing. */
  forRun(run){
    const request=this.db.get('coordinationRequests',run.requestId||'');
    if(!request?.conversationTaskId)return null;
    assertConversationRecord(run,request);
    const task=this.show(run,request.conversationTaskId);if(!this.visible(task,run))return null;
    const id=digest([task.id,run.roleId]),previous=this.db.get('conversationTaskReads',id);
    const value={id:task.id,number:task.number,title:task.title,description:task.description,plan:task.plan,status:task.status,ownerRoleId:task.ownerRoleId,revision:task.revision,
      updated:Boolean(previous&&previous.descriptionRevision!==task.descriptionRevision)};
    this.db.put('conversationTaskReads',{id,projectId:run.projectId,conversationId:conversationIdOf(run),roleId:run.roleId,conversationTaskId:task.id,descriptionRevision:task.descriptionRevision,runId:run.id});
    return value;
  }
}
