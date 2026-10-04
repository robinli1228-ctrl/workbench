import { createHash, randomUUID } from 'node:crypto';
import { organizerInput } from './conversation-organizer.mjs';
import { tr, isMessage } from './i18n.mjs';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const now=()=>new Date().toISOString();
const idFor=(projectId,conversationId)=>`${projectId}:${conversationId}`;

/** Input and version boundaries of the independent organizer; summaries never become group-chat messages. */
export class ConversationContext {
  constructor(db) { this.db=db; }

  read(projectId,conversationId) { return this.db.get('conversationContexts',idFor(projectId,conversationId)); }

  /** Batch in source order; a long message keeps a character cursor, and the full-message coverage position does not advance until it is fully read. */
  snapshot(projectId,conversationId,sourceMessageId=null) {
    const all=this.db.list('roomMessages').filter(m=>m.projectId===projectId && (m.conversationId||m.projectId)===conversationId && m.kind!=='summary');
    const cutoff=sourceMessageId?all.findIndex(m=>m.id===sourceMessageId):all.length;
    if(cutoff<0)throw new Error(tr('conversationContext.sourceMessageForRoundDoes'));
    const messages=all.slice(0,cutoff);
    let prior=this.read(projectId,conversationId);
    if(prior?.coveredThroughMessageId && !messages.some(m=>m.id===prior.coveredThroughMessageId))prior=null;
    const index=prior?.coveredThroughMessageId?messages.findIndex(m=>m.id===prior.coveredThroughMessageId):-1;
    const snapshot={projectId,conversationId,prior,delta:[],recent:[],
      roleSessions:this.db.list('roleSessions').filter(session=>session.projectId===projectId&&session.conversationId===conversationId).map(session=>({id:session.id,roleId:session.roleId,name:this.db.get('roles',session.roleId)?.name||session.roleId})),
      lastMessageId:prior?.coveredThroughMessageId||null,partialThrough:null};
    let budget=10000;
    for(const message of messages.slice(index+1)) {
      const text=String(message.text||''),version=digest(text);
      const saved=prior?.partialThrough;
      const start=saved?.messageId===message.id && saved.version===version?saved.offset:0;
      let end=Math.min(text.length,start+budget);
      if(end<text.length && /[\uD800-\uDBFF]/.test(text[end-1]))end--;
      const item={id:message.id,sender:message.sender,senderName:message.senderName,roleId:message.roleId,createdAt:message.createdAt,
        text:text.slice(start,end),range:{start,end,totalLength:text.length},attachments:(message.attachments||[]).map(a=>({id:a.id,name:a.name}))};
      snapshot.delta.push(item);
      let fits=false;
      while(!fits) {
        if(end<=start && start<text.length) {
          snapshot.delta.pop();
          if(!snapshot.delta.length)throw new Error(tr('conversationContext.fixedSummaryBackgroundHasUsed'));
          break;
        }
        try {organizerInput(snapshot);fits=true;}
        catch(error) {
          if(end-start<=1){snapshot.delta.pop();if(!snapshot.delta.length)throw error;break;}
          end=start+Math.floor((end-start)/2);
          if(end<text.length && /[\uD800-\uDBFF]/.test(text[end-1]))end--;
          item.text=text.slice(start,end);item.range.end=end;
        }
      }
      if(!fits)break;
      budget-=end-start;
      if(end<text.length){snapshot.partialThrough={messageId:message.id,offset:end,totalLength:text.length,version};break;}
      snapshot.lastMessageId=message.id;
      if(budget<=0 || snapshot.delta.length>=20)break;
    }
    // The recent window contains only sources actually read in this batch; later unread messages are not disguised as summarized material.
    const lastIndex=messages.findIndex(m=>m.id===snapshot.lastMessageId);
    snapshot.recent=messages.slice(Math.max(0,lastIndex-9),lastIndex+1).map(m=>({id:m.id,text:'',sender:m.sender}));
    while(snapshot.recent.length) {try {organizerInput(snapshot);break;}catch {snapshot.recent.shift();}}
    snapshot.fingerprint=digest([prior?.version||null,snapshot.delta,snapshot.lastMessageId,snapshot.partialThrough]);
    return snapshot;
  }

  /** A conversation may have only one batch in flight; failures back off, and later dispatches do not wait for the model here. */
  start(snapshot,config={}) {
    const id=idFor(snapshot.projectId,snapshot.conversationId);
    const key=digest([snapshot.fingerprint,snapshot.prior?.version||null,config]);
    if(!snapshot.delta.length)return {id,status:'ready',result:snapshot.prior};
    const pending=this.db.list('summaryJobs').find(j=>j.projectId===snapshot.projectId && j.conversationId===snapshot.conversationId && j.status==='running');
    if(pending)return pending;
    return this.db.put('summaryJobs',{id:randomUUID(),projectId:snapshot.projectId,conversationId:snapshot.conversationId,
      inputFingerprint:key,status:'running',snapshot,config,createdAt:now(),updatedAt:now()});
  }

  /** Accept only the real sources of this batch; an old organizing result cannot overwrite the newer saved coverage range. */
  accept(jobId,output) {
    return this.db.transaction(()=>{
      const job=this.db.get('summaryJobs',jobId);
      if(!job || job.status!=='running')throw new Error(tr('conversationContext.organizingJobDoesNotExist'));
      const {snapshot}=job,current=this.read(job.projectId,job.conversationId);
      if((current?.version||null)!==(snapshot.prior?.version||null))throw new Error(tr('conversationContext.organizingResultStale'));
      if(!output || !Array.isArray(output.constraints) || !Array.isArray(output.openItems) || !Array.isArray(output.roleSummaries) || typeof output.recentSummary!=='string')throw new Error(tr('conversationContext.invalidOrganizingResultStructure'));
      if(output.constraints.length>12 || output.openItems.length>12 || output.roleSummaries.length>30 || output.recentSummary.length>1500)throw new Error(tr('conversationContext.organizingResultExceedsFieldLimits'));
      if(JSON.stringify(output).length>12000)throw new Error(tr('conversationContext.organizingResultTooLongCompress'));
      if(output.coveredThroughMessageId!==snapshot.lastMessageId)throw new Error(tr('conversationContext.organizingCoverageDoesNotMatch'));
      const known=new Set([...snapshot.delta,...snapshot.recent].map(m=>m.id));
      for(const value of [output.goal,...output.constraints,...output.openItems,...output.roleSummaries]) {
        if(value==null)continue;
        if(typeof value.text!=='string' || value.text.length>1200 || !Array.isArray(value.sourceMessageIds) || value.sourceMessageIds.length>20 || value.sourceMessageIds.some(source=>!known.has(source) && !snapshot.prior?.sourceMessageIds?.includes(source)))throw new Error(tr('conversationContext.invalidOrganizingSourceId'));
      }
      const validRoleSummaries=output.roleSummaries.filter(item=>{
        const session=this.db.get('roleSessions',item.roleSessionId);
        return session?.projectId===job.projectId && session.conversationId===job.conversationId;
      });
      const recentSummary=output.recentSummary;
      const roleSummaries=[...(snapshot.prior?.roleSummaries||[]).filter(item=>!validRoleSummaries.some(update=>update.roleSessionId===item.roleSessionId)),...validRoleSummaries];
      const sourceMessageIds=[...new Set([output.goal,...output.constraints,...output.openItems,...roleSummaries].flatMap(item=>item?.sourceMessageIds||[]))];
      const value={id:idFor(job.projectId,job.conversationId),projectId:job.projectId,conversationId:job.conversationId,
        inputFingerprint:job.inputFingerprint,sourceFingerprint:snapshot.fingerprint,configFingerprint:digest(job.config),
        version:digest([job.inputFingerprint,output]),status:'ready',goal:output.goal||null,
        constraints:output.constraints.slice(0,12),openItems:output.openItems.slice(0,12),recentSummary,roleSummaries,
        warnings:validRoleSummaries.length===output.roleSummaries.length?[]:[tr('conversationContext.modelReferencedUnknownRoleSession')],
        sourceMessageIds,coveredThroughMessageId:snapshot.lastMessageId,partialThrough:snapshot.partialThrough||null,updatedAt:now()};
      this.db.put('conversationContexts',value);
      this.db.put('summaryJobs',{...job,status:'succeeded',updatedAt:now()});
      return value;
    });
  }

  fail(jobId,error) {
    const job=this.db.get('summaryJobs',jobId);
    if(job?.status==='running')this.db.put('summaryJobs',{...job,status:'failed',error:String(error||tr('conversationContext.organizingFailed')).slice(0,300),updatedAt:now()});
  }

  /** Register the background queue only for conversations actually in use; do not organize all historical projects automatically on upgrade. */
  enqueue(projectId,conversationId=projectId) {
    const id=idFor(projectId,conversationId);
    return this.db.get('summaryQueues',id)||this.db.put('summaryQueues',{id,projectId,conversationId,status:'queued',failures:0,updatedAt:now()});
  }

  /** A Home restart interrupts the organizing process, not the messages; accepted batches and unfinished cursors are kept. */
  recover() {
    for(const job of this.db.list('summaryJobs').filter(j=>j.status==='running')) {
      this.db.put('summaryJobs',{...job,status:'interrupted',error:tr('conversationContext.homeRestartedUnconfirmedBatchWill'),updatedAt:now()});
      this.enqueue(job.projectId,job.conversationId);
    }
    for(const queue of this.db.list('summaryQueues').filter(q=>q.status==='running'))this.db.put('summaryQueues',{...queue,status:'queued'});
  }

  /** The background handles one batch at a time; capacity goes to working roles first, and a failure is retried at most twice on the same input. */
  async drainOne({config,canRun,query,change=()=>{}}) {
    if(this.processing || !config?.nodeId || !canRun(config.nodeId))return;
    this.processing=true;
    try {
      for(const queue of this.db.list('summaryQueues').sort((a,b)=>String(a.updatedAt).localeCompare(String(b.updatedAt)))) {
        if(!this.db.get('projects',queue.projectId))continue;
        const latest=this.db.list('roomMessages').filter(m=>m.projectId===queue.projectId && (m.conversationId||m.projectId)===queue.conversationId && m.kind!=='summary').at(-1)?.id||null;
        const configKey=digest(config),changed=queue.targetMessageId!==latest || queue.configKey!==configKey;
        if(!changed && (queue.status==='idle' || queue.failures>=3 || Date.parse(queue.retryAt)>Date.now()))continue;
        let job;
        try {
          const snapshot=this.snapshot(queue.projectId,queue.conversationId);
          if(!snapshot.delta.length){this.db.put('summaryQueues',{...queue,status:'idle',targetMessageId:latest,configKey,failures:0,error:null,updatedAt:now()});continue;}
          job=this.start(snapshot,config);
          const working={...queue,status:'running',targetMessageId:latest,configKey,failures:changed?0:queue.failures,error:null,retryAt:null,updatedAt:now()};
          this.db.put('summaryQueues',working);change();
          const output=await query(job.snapshot,config);
          // The project may be deleted during the query; a late result must not revive it.
          if(!this.db.get('projects',queue.projectId))return;
          this.accept(job.id,output);
          this.db.put('summaryQueues',{...working,status:'queued',failures:0,updatedAt:now()});
        } catch(error) {
          if(!this.db.get('projects',queue.projectId))return;
          if(job && isMessage(error.message,'conversationOrganizer.conversationOrganizingYieldedWorkTask')) {
            this.db.put('summaryJobs',{...job,status:'interrupted',error:error.message,updatedAt:now()});
            this.db.put('summaryQueues',{...queue,status:'queued',targetMessageId:latest,configKey,error:null,retryAt:new Date(Date.now()+5000).toISOString(),updatedAt:now()});
            change();return;
          }
          if(job)this.fail(job.id,error.message);
          const failures=(changed?0:queue.failures||0)+1;
          this.db.put('summaryQueues',{...queue,status:'failed',targetMessageId:latest,configKey,failures,error:String(error.message).slice(0,300),
            retryAt:new Date(Date.now()+(failures===1?60000:300000)).toISOString(),updatedAt:now()});
        }
        change();return;
      }
    } finally {this.processing=false;}
  }
}
