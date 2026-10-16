import {createHash} from 'node:crypto';
import {tr} from './i18n.mjs';

/** Historical records belong to the original project chat without rewriting history. */
export const conversationIdOf = record => record?.conversationId || record?.projectId;

/** Native source partitions are not group IDs; old sessions belong to the default group. */
export const groupConversationIdOfSession = session => session?.groupConversationId || session?.projectId;

/** Only omission selects the default; explicit invalid IDs must never silently fall back. */
export function resolveConversationId(db,projectId,value) {
  if(!db.get('projects',projectId))throw new Error(tr('store.projectNotFound'));
  if(value===undefined||value===projectId)return projectId;
  if(typeof value!=='string'||!value||db.get('groupConversations',value)?.projectId!==projectId)throw new Error(tr('conversations.invalid'));
  return value;
}

/** Check trusted ownership before exposing a directly addressed conversation record. */
export function assertConversationRecord(context,record) {
  if(!record||record.projectId!==context.projectId||conversationIdOf(record)!==conversationIdOf(context))throw new Error(tr('conversations.recordMismatch'));
  return record;
}

/** Agent scope comes from the authenticated Run, never a caller override. */
export function agentConversationInput(run,input={}) {
  if(input.conversationId!==undefined&&input.conversationId!==conversationIdOf(run))throw new Error(tr('conversations.recordMismatch'));
  return {...input,conversationId:conversationIdOf(run)};
}

/** A read-only conversation lens composes with (and never replaces) independent-review redaction. */
export function conversationView(db,context) {
  const scoped=new Set(['roomMessages','tasks','runs','coordinationRequests','conversationContexts','summaryQueues','summaryJobs','discussionThreads','discussionMessages','discussionDeliveries','discussionIntents','executionPlans','plans','planSteps','planVersions','collaborationSessions','sessionBatches','scheduledJobs','scheduledOccurrences','deliveries']);
  const visible=(kind,record)=>{
    if(!record)return null;
    let owner=record;
    if(kind==='runReports'||kind==='reportSubmissions'||kind==='runAlerts')owner=db.get('runs',record.runId||record.id);
    else if(kind==='roleSessions')return record.projectId===context.projectId&&groupConversationIdOfSession(record)===conversationIdOf(context)?record:null;
    else if(!scoped.has(kind))return record;
    return owner?.projectId===context.projectId&&conversationIdOf(owner)===conversationIdOf(context)?record:null;
  };
  return new Proxy(db,{get(target,key){
    if(key==='get')return (kind,id)=>visible(kind,target.get(kind,id));
    if(key==='list')return kind=>target.list(kind).map(r=>visible(kind,r)).filter(Boolean);
    if(key==='listProject')return (kind,pid)=>target.listProject(kind,pid).map(r=>visible(kind,r)).filter(Boolean);
    if(['put','remove','transaction'].includes(key))return ()=>{throw new Error(tr('collabSessions.readOnlyView'));};
    const value=target[key];return typeof value==='function'?value.bind(target):value;
  }});
}

/** Lightweight group metadata; creation neither copies context nor starts any execution. */
export class GroupConversations {
  constructor(db){this.db=db;}
  list(projectId){
    resolveConversationId(this.db,projectId);
    const project=this.db.get('projects',projectId);
    return [{id:projectId,projectId,title:project.name,createdAt:project.createdAt,isDefault:true},...this.db.listProject('groupConversations',projectId)];
  }
  create(projectId,{requestId,sourceConversationId,title}={}){
    return this.db.transaction(()=>{
      const source=resolveConversationId(this.db,projectId,sourceConversationId);
      if(this.db.get('projects',projectId).systemConfig)throw new Error(tr('conversations.systemProject'));
      if(typeof requestId!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)||requestId===projectId||this.db.get('projects',requestId))throw new Error(tr('conversations.invalidRequest'));
      if(typeof title!=='string'||!title.trim()||title.trim().length>80)throw new Error(tr('conversations.invalidTitle'));
      title=title.trim();
      const fingerprint=createHash('sha256').update(JSON.stringify([projectId,source,title])).digest('hex');
      const previous=this.db.get('groupConversations',requestId);
      if(previous){
        if(previous.fingerprint!==fingerprint)throw new Error(tr('conversations.retryConflict'));
        return previous;
      }
      return this.db.put('groupConversations',{id:requestId,projectId,title,parentConversationId:source,requestId,fingerprint,createdAt:new Date().toISOString()});
    });
  }
}
