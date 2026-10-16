import {tr} from './i18n.mjs';
import {createHash} from 'node:crypto';
import {RoleCalls} from './role-calls.mjs';
import {isRoleConfigured} from './default-roles.mjs';
import {executionProgress} from '../public/execution-progress.js';
import {conversationIdOf,resolveConversationId} from './group-conversations.mjs';

/** Resolve provenance from trusted stored links, never from model-supplied sender fields. */
export function followupFor(db,record) {
  const pending=[record],seen=new Set();
  while(pending.length){
    const item=pending.shift();if(!item)continue;
    if(item.proactiveFollowup)return item.proactiveFollowup;
    for(const [kind,id] of [['runs',item.runId||item.sourceRunId],['tasks',item.taskId||item.businessTaskId],['tasks',item.rootTaskId],
      ['coordinationRequests',item.requestId],['coordinationRequests',item.parentRequestId],['coordinationRequests',item.continuationOf],
      ['roomMessages',item.sourceMessageId],['discussionThreads',item.discussionThreadId||item.threadId]]){
      if(!id||seen.has(`${kind}:${id}`))continue;seen.add(`${kind}:${id}`);pending.push(db.get(kind,id));
    }
  }
  return null;
}

/** Peers keep their normal delivery behavior; only the originating supervisor's follow-up turns are private. */
export function privateFollowup(db,record){const context=followupFor(db,record);return Boolean(context&&(record.roleId||record.targetRoleId)===context.roleId);}

/** Settings and a single persistent silence cursor; execution remains owned by the normal Home scheduler. */
export class ProactiveFollowup {
  constructor(db,rooms=null,{clock=()=>new Date()}={}){this.db=db;this.rooms=rooms;this.clock=clock;}
  /** Reading defaults never enables a project or advances its cursor. */
  get(projectId,conversationId){
    conversationId=resolveConversationId(this.db,projectId,conversationId);
    if(!this.db.get('projects',projectId))throw Error(tr('home.projectNotFound3'));
    const id=conversationId===projectId?projectId:`${projectId}:${conversationId}`;
    return this.db.get('proactiveFollowups',id)||{id,projectId,conversationId,enabled:false,silenceMinutes:10,revision:0,anchorMessageId:null,dueAt:null,requestId:null,waitingReason:null};
  }
  /** Presentation follows the original request's latest continuation; no second status machine is persisted. */
  view(projectId,conversationId){
    const state=this.get(projectId,conversationId),seen=new Set();let request=this.db.get('coordinationRequests',state.requestId||'');
    while(request?.continuationRequestId&&!seen.has(request.id)){seen.add(request.id);const next=this.db.get('coordinationRequests',request.continuationRequestId);if(!next)break;request=next;}
    const task=this.db.get('tasks',request?.taskId||state.taskId||''),run=this.db.get('runs',request?.currentRunId||task?.currentRunId||'');
    return {...state,execution:task||request?{taskId:task?.id,requestId:request?.id,runId:run?.id,status:run?.status||request?.status||task?.status,progress:executionProgress({run,task,request}),waitingReason:task?.waitingReason||request?.waitingReason||null,error:run?.error||task?.error||null}:null};
  }
  /** Enabling starts at the current tail; a duration edit retains the original message receipt time. */
  save(projectId,input){
    return this.db.transaction(()=>{
      const old=this.get(projectId,input?.conversationId),conversationId=conversationIdOf(old);
      if(input?.revision!==old.revision)throw Error(tr('followup.configChanged'));
      if(typeof input.enabled!=='boolean'||!Number.isSafeInteger(input.silenceMinutes)||input.silenceMinutes<1||input.silenceMinutes>10080)throw Error(tr('followup.invalidConfig'));
      const reset=!old.enabled&&input.enabled;
      const value={...old,enabled:input.enabled,silenceMinutes:input.silenceMinutes,revision:old.revision+1,updatedAt:this.clock().toISOString(),
        ...(reset?{cursor:this.db.messageCursor(projectId,conversationId),anchorMessageId:null,anchorAt:null,dueAt:null,requestId:null,taskId:null,messageIds:[],waitingReason:null}:{} )};
      if(value.anchorAt)value.dueAt=new Date(Date.parse(value.anchorAt)+value.silenceMinutes*60000).toISOString();
      this.db.put('proactiveFollowups',value);
      if(!value.enabled)this.cancelPending(projectId,null,conversationId);
      return value;
    });
  }
  /** Consume newly persisted messages only, using provenance rather than the meaning of their text. */
  observe(projectId,conversationId){
    let state=this.get(projectId,conversationId);if(!state.enabled)return state;
    conversationId=conversationIdOf(state);
    const arrivals=this.db.messageArrivals(projectId,state.cursor||0,conversationId);if(!arrivals.length)return state;
    const valid=arrivals.filter(message=>this.eligible(message)),anchor=valid.at(-1);
    state={...state,cursor:arrivals.at(-1).receiptSeq};
    if(anchor){this.cancelPending(projectId,anchor.id,conversationId);state={...state,anchorMessageId:anchor.id,anchorAt:anchor.receivedAt,dueAt:new Date(Date.parse(anchor.receivedAt)+state.silenceMinutes*60000).toISOString(),requestId:null,taskId:null,waitingReason:null,
      messageIds:[...(state.messageIds||[]),...valid.map(m=>m.id)].slice(-12)};
    }
    return this.db.put('proactiveFollowups',state);
  }
  /** This is event classification, not a judgment about whether the user needs help. */
  eligible(message){
    return ['human','agent'].includes(message.sender)&&message.visibility!=='internal'&&!['summary','handoff'].includes(message.kind)
      &&Boolean(message.text?.trim()||message.attachments?.length)
      &&!(message.taskIds||[]).some(id=>this.db.get('tasks',id)?.scheduledJobId)
      &&(message.sender==='human'||!followupFor(this.db,message))
      // Queue alert turns are platform reminders, not new conversation: they never restart the silence timer.
      &&!(message.runId&&this.db.get('tasks',this.db.get('runs',message.runId)?.taskId||'')?.sessionQueueAlert);
  }
  /** Only first turns not yet started can be withdrawn; active turns and their dependency continuations remain intact. */
  cancelPending(projectId,keepAnchor=null,conversationId=projectId){
    for(const task of this.db.listProject('tasks',projectId)){
      if(conversationIdOf(task)!==conversationId||!task.proactiveInitial||task.status!=='ready'||task.currentRunId||task.proactiveFollowup?.anchorMessageId===keepAnchor)continue;
      this.db.put('tasks',{...task,status:'cancelled',waitingReason:null});
      const request=this.db.get('coordinationRequests',task.requestId||`task:${task.id}`);
      if(request&&!request.currentRunId)this.db.put('coordinationRequests',{...request,status:'cancelled',updatedAt:this.clock().toISOString()});
    }
  }
  /** Reuse only an explicit delivery/continuation for these messages, not a guess based on similar text or a busy role. */
  coveringRequest(state){
    const messages=(state.messageIds||[]).map(id=>this.db.get('roomMessages',id)).filter(Boolean);
    if(!messages.length)return null;
    const requests=this.db.listProject('coordinationRequests',state.projectId).filter(r=>r.targetRoleId===this.db.get('projects',state.projectId)?.supervisorRoleId&&!['succeeded','failed','cancelled'].includes(r.status));
    for(const request of requests){
      const task=this.db.get('tasks',request.taskId||''),origin=followupFor(this.db,request);
      // A quoted background message is not evidence that this request undertook that independent goal.
      const refs=new Set([request.sourceMessageId,...(task?.followupMessageIds||[]),...(origin?.messageIds||[])]);
      for(const child of this.db.listProject('coordinationRequests',state.projectId).filter(r=>(request.continuationOf&&r.parentRequestId===request.continuationOf)||r.parentRequestId===request.id))if(child.currentRunId)refs.add(`result-${child.currentRunId}`);
      if(messages.every(m=>refs.has(m.id)))return request;
    }
    return null;
  }
  /** Store calls this inside its Run-creation transaction; active tasks' continuations are not fresh timer events. */
  prepareStart(taskId){
    let task=this.db.get('tasks',taskId),context=followupFor(this.db,task);if(!context)return task;
    if(task.proactiveInitial&&!task.currentRunId){
      const state=this.observe(task.projectId,conversationIdOf(task));
      if(!state.enabled||state.anchorMessageId!==context.anchorMessageId){this.cancelPending(task.projectId,state.enabled?state.anchorMessageId:null,conversationIdOf(task));return null;}
      if(Date.parse(state.dueAt)>this.clock().getTime()){this.db.put('tasks',{...task,waitingReason:tr('followup.waitingSilence')});return null;}
      const covered=this.coveringRequest({...state,messageIds:context.messageIds});
      if(covered&&covered.taskId!==task.id){this.cancelPending(task.projectId,null,conversationIdOf(task));this.db.put('proactiveFollowups',{...state,requestId:covered.id,taskId:covered.taskId});return null;}
      context={...context,silenceMinutes:state.silenceMinutes,dueAt:state.dueAt};
      task={...task,proactiveFollowup:context,prompt:tr('followup.event',{minutes:state.silenceMinutes})};
    }
    if((task.roleId||task.roleSnapshot?.id)===context.roleId){
      const role=this.db.get('roles',context.roleId);
      if(role){
        const bound=task.executionBinding?.role;
        if(bound&&['id','projectId','nodeId','runtime'].some(key=>bound[key]!==role[key])){this.db.put('tasks',{...task,waitingReason:tr('followup.bindingChanged')});return null;}
        const executionBinding=bound?{...task.executionBinding,role:{...role}}:task.executionBinding;
        task=this.db.put('tasks',{...task,roleSnapshot:role,model:role.model,...(executionBinding?{executionBinding}:{}),proactiveFollowup:context,backgroundFollowup:true});
        const request=this.db.get('coordinationRequests',task.requestId||'');
        if(request?.status==='queued')this.db.put('coordinationRequests',{...request,targetSnapshot:role,...(executionBinding?{executionBinding}:{})});
      }
    }
    return task;
  }
  /** Register once per anchor; the normal scheduler still owns the actual CLI execution. */
  tick(){
    let changed=false;
    for(const snapshot of this.db.list('proactiveFollowups'))if(snapshot.enabled){
      this.db.transaction(()=>{
        let state=this.observe(snapshot.projectId,conversationIdOf(snapshot));
        if(state.anchorMessageId&&Date.parse(state.dueAt)<=this.clock().getTime()&&!state.requestId){
          const role=this.db.get('roles',this.db.get('projects',state.projectId)?.supervisorRoleId||'');
          if(!role?.enabled||role.archivedAt||!isRoleConfigured(role))state=this.db.put('proactiveFollowups',{...state,waitingReason:tr('followup.noSupervisor')});
          else {
            const covered=this.coveringRequest(state);
            if(covered)state=this.db.put('proactiveFollowups',{...state,requestId:covered.id,taskId:covered.taskId,waitingReason:null});
            else if(this.rooms){
              const id=`followup:${createHash('sha256').update(`${state.projectId}:${state.anchorMessageId}`).digest('hex')}`;
              const context={id,roleId:role.id,anchorMessageId:state.anchorMessageId,messageIds:state.messageIds||[],dueAt:state.dueAt,triggeredAt:this.clock().toISOString(),silenceMinutes:state.silenceMinutes};
              const message=this.rooms.postSystemTask(state.projectId,{id,conversationId:conversationIdOf(state),roleId:role.id,text:tr('followup.event',{minutes:state.silenceMinutes}),source:{kind:'proactive_followup',context}});
              const request=new RoleCalls(this.db).adoptTask(message.taskIds[0]);
              state=this.db.put('proactiveFollowups',{...state,requestId:request.id,taskId:message.taskIds[0],waitingReason:null});
            }
          }
        }
        changed=JSON.stringify(state)!==JSON.stringify(snapshot)||changed;
      });
    }
    return changed;
  }
}
