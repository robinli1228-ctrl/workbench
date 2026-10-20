import { createHash, randomUUID } from 'node:crypto';
import {conversationIdOf,groupConversationIdOfSession} from './group-conversations.mjs';

const omit=(value,keys)=>Object.fromEntries(Object.entries(value||{}).filter(([key])=>!keys.includes(key)));
const short=value=>typeof value==='string'&&value.length>400?`${value.slice(0,400)}…`:value;
const ROLE_BODY=['prompt','instructions','systemPrompt'];
/** Bodies the page never shows. The SQL page summaries remove the same paths, so a summary projects exactly like a full record. */
export const PAGE_BODY_FIELDS=Object.freeze({
  runs:['result','contextPacket','inputTask','teamContext','resumeNativeSession','runtimeInstructions','executionConfiguration'],
  tasks:['prompt','inputTask','contextPacket','teamContext'],
  requests:['summary','result','resumeSummary','reportSummary','execution'],
  runReports:['summary']});
const nested=prefix=>ROLE_BODY.map(field=>`${prefix}.${field}`);
export const PAGE_SUMMARY_PATHS=Object.freeze({
  runs:[...PAGE_BODY_FIELDS.runs,...nested('roleSnapshot'),...nested('originalRoleSnapshot'),...nested('executionBinding.role'),'report.summary'],
  tasks:[...PAGE_BODY_FIELDS.tasks,...nested('roleSnapshot'),...nested('executionBinding.role')],
  requests:[...PAGE_BODY_FIELDS.requests,'fingerprint',...nested('executionBinding.role')],
  runReports:[...PAGE_BODY_FIELDS.runReports]});
const role=value=>value?omit(value,ROLE_BODY):value;
const binding=value=>value?{...value,role:role(value.role)}:value;

/** The project a workspace read resolves to, with the same fallback the projection applies, so a scoped read and its projection agree. */
export function workspaceScope(db,requestedProjectId) {
  const projects=db.list('projects').filter(p=>!p.systemConfig),selected=projects.find(p=>p.id===requestedProjectId);
  return {projectId:selected?.id||projects[0]?.id||null};
}

/** Projects only the metadata the UI needs; task requirements, context, and result bodies always stay in the original records and the detail endpoints. */
export function workspaceState(snapshot,requestedProjectId,requestedConversationId) {
  const selected=snapshot.projects.find(p=>p.id===requestedProjectId);
  const projectId=selected?.id||snapshot.projects[0]?.id||null;
  // A deleted project invalidates its persisted chat selection as one unit.
  const conversationId=selected?(requestedConversationId||projectId):projectId;
  if(conversationId!==projectId&&!(snapshot.conversations||[]).some(c=>c.id===conversationId&&c.projectId===projectId))throw new Error('Group conversation not found.');
  const belongs=record=>record.projectId===projectId&&conversationIdOf(record)===conversationId;
  const state={...snapshot};
  // Share execution identities across projects, never history bodies or idle CLI occupancy.
  const online=new Set((snapshot.workers||[]).filter(w=>w.online).map(w=>w.id));
  const executing=value=>online.has(value.nodeId)&&['preparing','starting','running','stopping'].includes(value.status);
  const sessions=snapshot.roleSessions||[],byId=new Map(sessions.map(s=>[s.id,s]));
  const identity=(nodeId,runtime,sessionId)=>JSON.stringify([nodeId,runtime,sessionId]);
  const owners=new Map();
  for(const session of sessions){
    if(!session.nativeSessionId||session.historyClearedAt)continue;
    const key=identity(session.nodeId,session.runtime,session.nativeSessionId);
    if(!owners.has(key))owners.set(key,new Set());
    owners.get(key).add(groupConversationIdOfSession(session));
  }
  state.sidebarExecutions=[
    ...snapshot.runs.filter(executing).map(r=>({id:`run:${r.id}`,projectIds:[r.projectId],conversationIds:[conversationIdOf(r)],nodeId:r.nodeId,
      runtime:r.nativeSession?.runtime||r.roleSnapshot?.runtime||byId.get(r.roleSessionId)?.runtime||null,
      sessionId:r.nativeSession?.id||r.resumeNativeSessionId||byId.get(r.roleSessionId)?.nativeSessionId||null})),
    ...(snapshot.nativeTurnExecutions||[]).filter(executing).map(turn=>({id:`native:${turn.id}`,
      projectIds:[...new Set(sessions.filter(s=>s.nodeId===turn.nodeId&&s.runtime===turn.runtime&&s.nativeSessionId===turn.sessionId).map(s=>s.projectId))],conversationIds:[...(owners.get(identity(turn.nodeId,turn.runtime,turn.sessionId))||[])],nodeId:turn.nodeId,runtime:turn.runtime,sessionId:turn.sessionId}))
  ].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0); // marks are a set; a fixed order keeps scoped and full reads byte-identical
  delete state.nativeTurnExecutions;
  const runs=snapshot.runs.filter(belongs),runIds=new Set(runs.map(r=>r.id));
  // hasReply is Home's own progress evidence from a SQL summary; the page gets the computed stage instead.
  state.runs=runs.map(r=>({...omit(r,[...PAGE_BODY_FIELDS.runs,'hasReply']),
    roleSnapshot:role(r.roleSnapshot),originalRoleSnapshot:role(r.originalRoleSnapshot),executionBinding:binding(r.executionBinding),error:short(r.error),report:r.report?omit(r.report,['summary']):r.report,summaryOnly:true}));
  state.tasks=snapshot.tasks.filter(belongs).map(t=>({...omit(t,PAGE_BODY_FIELDS.tasks),roleSnapshot:role(t.roleSnapshot),executionBinding:binding(t.executionBinding),error:short(t.error),summaryOnly:true}));
  state.requests=(snapshot.requests||[]).filter(belongs).map(r=>({...omit(r,[...PAGE_BODY_FIELDS.requests,'hasReply']),executionBinding:binding(r.executionBinding),error:short(r.error)}));
  for(const key of ['discussionThreads','discussionDeliveries','roleSessions','roleSwitches','runAlerts','cliRecoveries'])state[key]=(snapshot[key]||[]).filter(r=>r.projectId===projectId);
  state.runReports=(snapshot.runReports||[]).filter(r=>runIds.has(r.id)).map(r=>omit(r,['summary']));
  state.approvals=(snapshot.approvals||[]).filter(r=>runIds.has(r.runId));
  state.executionPlans=(snapshot.executionPlans||[]).filter(belongs).map(p=>({...p,stages:(p.stages||[]).map(s=>({...s,members:(s.members||[]).map(m=>omit(m,['prompt','summary','execution']))}))}));
  state.roleSessions=sessions.filter(s=>s.projectId===projectId&&groupConversationIdOfSession(s)===conversationId);
  for(const key of ['discussionThreads','discussionDeliveries'])state[key]=state[key].filter(belongs);
  state.runAlerts=state.runAlerts.filter(r=>runIds.has(r.id));
  const taskIds=new Set(state.tasks.map(t=>t.id));state.cliRecoveries=state.cliRecoveries.filter(r=>taskIds.has(r.taskId||r.id));
  return {projectId,conversationId,state};
}

const keyed=value=>Array.isArray(value)&&value.every(v=>v&&typeof v.id==='string')&&new Set(value.map(v=>v.id)).size===value.length;
const encode=value=>JSON.stringify(value);

/** The cursor only caches a rebuildable UI projection; on restart, eviction, or project switch the snapshot is restored, and message persistence is unaffected. */
export class WorkspaceStateFeed {
  constructor({maxScopes=16,history=4}={}) {this.epoch=randomUUID();this.scopes=new Map();this.maxScopes=maxScopes;this.history=history;}
  read(snapshot,projectId,cursor,conversationId) {
    const projection=workspaceState(snapshot,projectId,conversationId),key=JSON.stringify([projection.projectId,projection.conversationId]);
    const serialized=encode(projection.state),state=JSON.parse(serialized);
    const nextCursor=`${this.epoch}:${createHash('sha256').update(key).update(serialized).digest('hex')}`;
    let history=this.scopes.get(key)||[];
    const previous=history.find(entry=>entry.cursor===cursor);
    if(!history.some(entry=>entry.cursor===nextCursor))history=[...history,{cursor:nextCursor,state}].slice(-this.history);
    this.scopes.delete(key);this.scopes.set(key,history);
    while(this.scopes.size>this.maxScopes)this.scopes.delete(this.scopes.keys().next().value);
    const envelope={schema:1,projectId:projection.projectId,conversationId:projection.conversationId,cursor:nextCursor};
    if(!previous)return {...envelope,reset:true,state};
    const changes={},replace={};
    for(const [name,value] of Object.entries(state)) {
      const before=previous.state[name];
      if(encode(before)===encode(value))continue;
      if(!keyed(before)||!keyed(value)){replace[name]=value;continue;}
      const old=new Map(before.map(v=>[v.id,encode(v)])),ids=new Set(value.map(v=>v.id));
      changes[name]={upsert:value.filter(v=>old.get(v.id)!==encode(v)),remove:before.filter(v=>!ids.has(v.id)).map(v=>v.id),order:value.map(v=>v.id)};
    }
    return {...envelope,reset:false,baseCursor:cursor,changes,replace};
  }
}
