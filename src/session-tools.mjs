import { createHash } from 'node:crypto';
import { buildRunContext } from './run-context.mjs';

const graphemes = text => [...new Intl.Segmenter('zh',{granularity:'grapheme'}).segment(text)].map(item=>item.segment);

/** Lets every CLI query sessions visible within the same project; sources and original text remain those of the records stored by Home. */
export class SessionTools {
  constructor(db) { this.db=db; }

  session(run,id) {
    const value=this.db.get('roleSessions',id);
    if(!value || value.projectId!==run.projectId || value.conversationId!==(run.conversationId||run.projectId))throw new Error('Session does not exist or does not belong to the current project');
    return value;
  }

  current(run) {
    const session=run.roleSessionId?this.session(run,run.roleSessionId):null;
    return {roleSessionId:session?.id||null,conversationId:run.conversationId||run.projectId,
      roleId:run.roleId||null,runId:run.id,status:session?.status||'unavailable',nativeSessionId:session?.nativeSessionId||null};
  }

  list(run,{limit=20,cursor=null}={}) {
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('limit must be 1-100');
    const rows=this.db.list('roleSessions').filter(s=>s.projectId===run.projectId && s.conversationId===(run.conversationId||run.projectId)).reverse();
    const start=cursor?rows.findIndex(s=>s.id===cursor)+1:0;
    if(cursor && start===0)throw new Error('cursor does not belong to the current conversation');
    const page=rows.slice(start,start+limit);
    return {items:page.map(s=>({roleSessionId:s.id,roleId:s.roleId,roleName:this.db.get('roles',s.roleId)?.name||s.roleId,
      nodeId:s.nodeId,runtime:s.runtime,generation:s.generation,status:s.status,lastRunId:s.lastRunId,
      updatedAt:s.updatedAt,summary:this.summary(run,s.id).text})),nextCursor:rows.length>start+page.length?page.at(-1).id:null};
  }

  summary(run,id) {
    const session=this.session(run,id);
    const context=this.db.get('conversationContexts',`${run.projectId}:${session.conversationId}`);
    const item=context?.roleSummaries?.find(s=>s.roleSessionId===id);
    return {roleSessionId:id,status:item?'ready':'unavailable',text:item?.text||'',sourceMessageIds:item?.sourceMessageIds||[],
      coveredThroughMessageId:context?.coveredThroughMessageId||null,version:context?.version||null};
  }

  chatSummary(run,{offset=0,limit=100,version=null}={}) {
    if(!Number.isSafeInteger(offset)||offset<0 || !Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('Invalid summary directory pagination parameters');
    if(offset && !version)throw new Error('directoryVersion is required to continue reading the summary directory');
    const conversationId=run.conversationId||run.projectId;
    const value=this.db.get('conversationContexts',`${run.projectId}:${conversationId}`);
    const messages=this.db.list('roomMessages').filter(m=>m.projectId===run.projectId && (m.conversationId||m.projectId)===conversationId && m.kind!=='summary');
    const {uncovered,...context}=buildRunContext({run,task:{},conversation:value,messages,organizer:this.db.get('summaryQueues',`${run.projectId}:${conversationId}`)}).context;
    const index=context.coveredThroughMessageId?messages.findIndex(m=>m.id===context.coveredThroughMessageId):-1;
    const pending=messages.slice(index+1).filter(m=>m.id!==run.sourceMessageId);
    const directoryVersion=createHash('sha256').update(JSON.stringify([context.version,pending.map(m=>[m.id,m.text])])).digest('hex');
    if(version && version!==directoryVersion)throw new Error('The summary directory has changed; read again from the beginning');
    const end=Math.min(pending.length,offset+limit);
    return {conversationId,...context,uncoveredMessageIds:pending.slice(offset,end).map(m=>m.id),directoryVersion,
      nextOffset:end<pending.length?end:null,complete:end>=pending.length};
  }

  /** Return in segments the task text and role results visible to the platform; tool process output stays in the Run log. */
  read(run,id,{offset=0,limit=4000,version=null}={}) {
    this.session(run,id);
    if(!Number.isSafeInteger(offset)||offset<0)throw new Error('offset must be a non-negative integer');
    if(!Number.isSafeInteger(limit)||limit<1||limit>20000)throw new Error('limit must be 1-20000');
    if(offset && !version)throw new Error('version is required to continue reading');
    const runs=this.db.list('runs').filter(r=>r.roleSessionId===id && r.projectId===run.projectId);
    const content=runs.map(r=>{
      const source=r.sourceMessageId?this.db.get('roomMessages',r.sourceMessageId):null;
      return `[Instruction ${source?.id||r.taskId||r.id}]\n${source?.text||this.db.get('tasks',r.taskId)?.prompt||''}\n[Reply ${r.id}]\n${r.result||r.error||'No reply yet'}`;
    }).join('\n\n');
    const currentVersion=createHash('sha256').update(id).update('\0').update(content).digest('hex');
    if(version && version!==currentVersion)throw new Error('The source text version has changed; read again from the beginning');
    const parts=graphemes(content),end=Math.min(parts.length,offset+limit);
    return {roleSessionId:id,content:parts.slice(offset,end).join(''),totalLength:parts.length,nextOffset:end<parts.length?end:null,
      complete:end>=parts.length,version:currentVersion};
  }
}
