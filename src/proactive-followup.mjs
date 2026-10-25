import {ConversationTasks} from './conversation-tasks.mjs';
import {tr} from './i18n.mjs';
import {createHash} from 'node:crypto';
import {RoleCalls,callTerminal} from './role-calls.mjs';
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
  constructor(db,rooms=null,{clock=()=>new Date()}={}){this.db=db;this.rooms=rooms;this.clock=clock;this.nextTick=0;this.cursors={};}
  /** Reading defaults is side-effect free; first observation snapshots the current tail. */
  get(projectId,conversationId){
    conversationId=resolveConversationId(this.db,projectId,conversationId);
    if(!this.db.get('projects',projectId))throw Error(tr('home.projectNotFound3'));
    const id=conversationId===projectId?projectId:`${projectId}:${conversationId}`;
    return this.db.get('proactiveFollowups',id)||{id,projectId,conversationId,enabled:true,silenceMinutes:10,revision:0,anchorMessageId:null,dueAt:null,requestId:null,waitingReason:null};
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
      const reset=(!this.db.get('proactiveFollowups',old.id)||!old.enabled)&&input.enabled;
      const value={...old,enabled:input.enabled,silenceMinutes:input.silenceMinutes,revision:old.revision+1,updatedAt:this.clock().toISOString(),
        ...(reset?{taskVersion:null,cursor:this.db.messageCursor(projectId,conversationId),anchorMessageId:null,anchorAt:null,dueAt:null,requestId:null,taskId:null,messageIds:[],waitingReason:null}:{} )};
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
    const activity=new ConversationTasks(this.db).activity(state);
    if(activity.total){
      // No message/history reads after every task closes. A reopening starts at the current tail.
      if(!activity.open){
        if(state.taskVersion!==activity.version||state.anchorMessageId){
          this.cancelPending(projectId,null,conversationId);
          return this.db.put('proactiveFollowups',{...state,taskDriven:true,taskVersion:activity.version,anchorMessageId:null,dueAt:null,requestId:null,taskId:null,messageIds:[]});
        }
        return state;
      }
      if(state.taskVersion!==activity.version){
        this.cancelPending(projectId,null,conversationId);
        const at=this.clock().toISOString();
        return this.db.put('proactiveFollowups',{...state,taskDriven:true,taskVersion:activity.version,cursor:this.db.messageCursor(projectId,conversationId),
          anchorMessageId:`tasks:${activity.id}:${activity.version}:${state.revision}`,anchorAt:at,dueAt:new Date(this.clock().getTime()+state.silenceMinutes*60000).toISOString(),
          settledMessageId:null,requestId:null,taskId:null,messageIds:[],waitingReason:null});
      }
    }
    if(!this.db.get('proactiveFollowups',state.id))return this.db.put('proactiveFollowups',{...state,cursor:this.db.messageCursor(projectId,conversationId)});
    const arrivals=this.db.messageArrivals(projectId,state.cursor||0,conversationId);if(!arrivals.length)return state;
    const valid=arrivals.filter(message=>this.eligible(message)),anchor=valid.at(-1);
    state={...state,cursor:arrivals.at(-1).receiptSeq};
    if(anchor){this.cancelPending(projectId,anchor.id,conversationId);state={...state,anchorMessageId:state.taskDriven?`${anchor.id}:tasks:${state.taskVersion}`:anchor.id,anchorAt:anchor.receivedAt,dueAt:new Date(Date.parse(anchor.receivedAt)+state.silenceMinutes*60000).toISOString(),requestId:null,taskId:null,waitingReason:null,
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
    // Reuse one synchronous read, retaining completed child evidence without caching across calls.
    const projectRequests=this.db.listProject('coordinationRequests',state.projectId),supervisorRoleId=this.db.get('projects',state.projectId)?.supervisorRoleId;
    const requests=projectRequests.filter(r=>r.targetRoleId===supervisorRoleId&&['queued','running'].includes(r.status));
    for(const request of requests){
      const task=this.db.get('tasks',request.taskId||''),origin=followupFor(this.db,request);
      // A quoted background message is not evidence that this request undertook that independent goal.
      const refs=new Set([request.sourceMessageId,...(task?.followupMessageIds||[]),...(origin?.messageIds||[])]);
      for(const child of projectRequests.filter(r=>(request.continuationOf&&r.parentRequestId===request.continuationOf)||r.parentRequestId===request.id))if(child.currentRunId)refs.add(`result-${child.currentRunId}`);
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
      task={...task,proactiveFollowup:context,prompt:this.reminder(state)};
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
  /** Work still running or queued in this conversation is not
   * silence: a role can work for longer than the silence window without posting anything. */
  busy(state){
    const here=record=>record.projectId===state.projectId&&conversationIdOf(record)===conversationIdOf(state);
    return this.db.activeRuns().some(here)
      ||this.db.chatTasks(['ready','in_progress']).some(task=>here(task)&&!task.proactiveInitial);
  }
  /** Keyset pages use the existing (kind,id) primary key, not full group/message scans per scheduler tick. */
  page(kind){
    const rows=this.db.db.prepare('SELECT id,data FROM records WHERE kind=? AND id>? ORDER BY id LIMIT 100').all(kind,this.cursors[kind]||'');
    this.cursors[kind]=rows.length===100?rows.at(-1).id:'';
    return rows.map(row=>JSON.parse(row.data));
  }
  requests(state){return this.db.listProject('coordinationRequests',state.projectId).filter(r=>conversationIdOf(r)===conversationIdOf(state));}
  /** Only platform-linked final replies can close an anchor. Notes and prose never prove completion. */
  concluded(state){
    const message=this.db.get('roomMessages',state.anchorMessageId),run=this.db.get('runs',message?.runId||'');
    if(message?.sender!=='agent'||!run||message.id!==`result-${run.id}`||run.projectId!==state.projectId||conversationIdOf(run)!==conversationIdOf(state)||run.status!=='succeeded'||run.handoffWait)return false;
    const task=this.db.get('tasks',run.taskId||''),requests=this.requests(state),byId=new Map(requests.map(r=>[r.id,r]));
    // A resumed owner's earlier calls still belong to this reply, and a child's continuation can still be unfinished.
    const owners=new Set();let id=run.requestId||task?.requestId||`task:${run.taskId}`;
    while(id&&!owners.has(id)){owners.add(id);id=byId.get(id)?.continuationOf;}
    const edges=new Map();for(const r of requests)for(const parent of [r.parentRequestId,r.transferredFrom,r.continuationOf].filter(Boolean)){
      if(!edges.has(parent))edges.set(parent,[]);edges.get(parent).push(r);
    }
    const queue=[...owners],seen=new Set(owners);
    for(let i=0;i<queue.length;i++)for(const child of edges.get(queue[i])||[]){
      if(seen.has(child.id))continue;seen.add(child.id);queue.push(child.id);
      if(!callTerminal.has(child.status))return false;
    }
    return true;
  }
  /** Bounded factual context, refreshed at admission; no inference from model text or cross-chat content. */
  reminder(state){
    const requests=this.requests(state),byId=new Map(requests.map(r=>[r.id,r])),describe=r=>{
      const seen=new Set();while(r.continuationRequestId&&byId.has(r.continuationRequestId)&&!seen.has(r.id)){seen.add(r.id);r=byId.get(r.continuationRequestId);}
      const task=this.db.get('tasks',r.taskId||''),run=this.db.get('runs',r.currentRunId||task?.currentRunId||'');
      return {requestId:r.id,role:String(this.db.get('roles',r.targetRoleId)?.name||r.targetSnapshot?.name||r.targetRoleId||'').slice(0,80),status:r.status,
        waitingReason:String(task?.waitingReason||r.waitingReason||'').slice(0,300),runId:run?.id||null,runStatus:run?.status||null};
    };
    const open=requests.filter(r=>!callTerminal.has(r.status)),transfers=requests.filter(r=>r.transferredFrom);
    const lastFailure=this.db.db.prepare("SELECT id,json_extract(data,'$.roleId') AS roleId,json_extract(data,'$.status') AS status,json_extract(data,'$.finishedAt') AS finishedAt FROM records WHERE kind='runs' AND json_extract(data,'$.projectId')=? AND COALESCE(NULLIF(json_extract(data,'$.conversationId'),''),json_extract(data,'$.projectId'))=? AND json_extract(data,'$.status') IN ('failed','interrupted') ORDER BY COALESCE(json_extract(data,'$.finishedAt'),json_extract(data,'$.createdAt')) DESC,rowid DESC LIMIT 1").get(state.projectId,conversationIdOf(state))||null;
    const activity=new ConversationTasks(this.db).activity(state);
    const facts={openTasks:activity.open,taskCount:activity.total,unfinishedCount:open.length,unfinished:open.slice(-12).map(describe),lastFailure,transferCount:transfers.length,transfers:transfers.slice(-12).map(r=>({...describe(r),transferredFrom:r.transferredFrom}))};
    return tr('followup.event',{minutes:state.silenceMinutes,facts:JSON.stringify(facts)});
  }
  /** Register once per anchor; the normal scheduler still owns the actual CLI execution. */
  tick(){
    const time=this.clock().getTime();if(time<this.nextTick)return false;this.nextTick=time+15000;
    let changed=false;
    // Upgrade/new chats start at their own current tail. Explicit off records are never overwritten.
    for(const kind of ['projects','groupConversations'])for(const row of this.page(kind)){
      const project=kind==='projects'?row:this.db.get('projects',row.projectId);if(!project||project.systemConfig)continue;
      const conversationId=kind==='projects'?project.id:row.id,state=this.get(project.id,conversationId);
      if(!this.db.get('proactiveFollowups',state.id)){this.observe(project.id,conversationId);changed=true;}
    }
    for(const snapshot of this.page('proactiveFollowups'))if(snapshot.enabled&&this.db.get('projects',snapshot.projectId)){

      this.db.transaction(()=>{
        let state=this.observe(snapshot.projectId,conversationIdOf(snapshot));
        if(state.settledMessageId===state.anchorMessageId&&state.anchorMessageId)return;
        // While work goes on the window restarts, so it is counted from when the conversation actually went quiet.
        if(state.anchorMessageId&&Date.parse(state.dueAt)<=this.clock().getTime()&&!state.requestId&&this.busy(state))
          state=this.db.put('proactiveFollowups',{...state,dueAt:new Date(this.clock().getTime()+state.silenceMinutes*60000).toISOString()});
        else if(state.anchorMessageId&&Date.parse(state.dueAt)<=this.clock().getTime()&&!state.requestId){
          if(!state.taskDriven&&this.concluded(state)){this.db.put('proactiveFollowups',{...state,settledMessageId:state.anchorMessageId,waitingReason:null});changed=true;return;}
          const role=this.db.get('roles',this.db.get('projects',state.projectId)?.supervisorRoleId||'');
          if(!role?.enabled||role.archivedAt||!isRoleConfigured(role))state=this.db.put('proactiveFollowups',{...state,waitingReason:tr('followup.noSupervisor')});
          else {
            const covered=this.coveringRequest(state);
            if(covered)state=this.db.put('proactiveFollowups',{...state,requestId:covered.id,taskId:covered.taskId,waitingReason:null});
            else if(this.rooms){
              const id=`followup:${createHash('sha256').update(`${state.projectId}:${state.anchorMessageId}`).digest('hex')}`;
              const context={id,roleId:role.id,anchorMessageId:state.anchorMessageId,messageIds:state.messageIds||[],dueAt:state.dueAt,triggeredAt:this.clock().toISOString(),silenceMinutes:state.silenceMinutes};
              const message=this.rooms.postSystemTask(state.projectId,{id,conversationId:conversationIdOf(state),roleId:role.id,text:this.reminder(state),source:{kind:'proactive_followup',context}});
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
