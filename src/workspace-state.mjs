import { createHash, randomUUID } from 'node:crypto';

const omit=(value,keys)=>Object.fromEntries(Object.entries(value||{}).filter(([key])=>!keys.includes(key)));
const short=value=>typeof value==='string'&&value.length>400?`${value.slice(0,400)}…`:value;
const role=value=>value?omit(value,['prompt','instructions','systemPrompt']):value;
const binding=value=>value?{...value,role:role(value.role)}:value;

/** Projects only the metadata the UI needs; task requirements, context, and result bodies always stay in the original records and the detail endpoints. */
export function workspaceState(snapshot,requestedProjectId) {
  const projectId=snapshot.projects.find(p=>p.id===requestedProjectId)?.id||snapshot.projects[0]?.id||null;
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
    owners.get(key).add(session.projectId);
  }
  state.sidebarExecutions=[
    ...snapshot.runs.filter(executing).map(r=>({id:`run:${r.id}`,projectIds:[r.projectId],nodeId:r.nodeId,
      runtime:r.nativeSession?.runtime||r.roleSnapshot?.runtime||byId.get(r.roleSessionId)?.runtime||null,
      sessionId:r.nativeSession?.id||r.resumeNativeSessionId||byId.get(r.roleSessionId)?.nativeSessionId||null})),
    ...(snapshot.nativeTurnExecutions||[]).filter(executing).map(turn=>({id:`native:${turn.id}`,
      projectIds:[...(owners.get(identity(turn.nodeId,turn.runtime,turn.sessionId))||[])],nodeId:turn.nodeId,runtime:turn.runtime,sessionId:turn.sessionId}))
  ];
  delete state.nativeTurnExecutions;
  const runs=snapshot.runs.filter(r=>r.projectId===projectId),runIds=new Set(runs.map(r=>r.id));
  state.runs=runs.map(r=>({...omit(r,['result','contextPacket','inputTask','teamContext','resumeNativeSession','runtimeInstructions','executionConfiguration']),
    roleSnapshot:role(r.roleSnapshot),originalRoleSnapshot:role(r.originalRoleSnapshot),executionBinding:binding(r.executionBinding),error:short(r.error),report:r.report?omit(r.report,['summary']):r.report,summaryOnly:true}));
  state.tasks=snapshot.tasks.filter(t=>t.projectId===projectId).map(t=>({...omit(t,['prompt','inputTask','contextPacket','teamContext']),roleSnapshot:role(t.roleSnapshot),executionBinding:binding(t.executionBinding),error:short(t.error),summaryOnly:true}));
  state.requests=(snapshot.requests||[]).filter(r=>r.projectId===projectId).map(r=>({...omit(r,['summary','result','resumeSummary','reportSummary','execution']),executionBinding:binding(r.executionBinding),error:short(r.error)}));
  for(const key of ['discussionThreads','discussionDeliveries','roleSessions','roleSwitches','runAlerts','cliRecoveries'])state[key]=(snapshot[key]||[]).filter(r=>r.projectId===projectId);
  state.runReports=(snapshot.runReports||[]).filter(r=>runIds.has(r.id)).map(r=>omit(r,['summary']));
  state.approvals=(snapshot.approvals||[]).filter(r=>runIds.has(r.runId));
  state.executionPlans=(snapshot.executionPlans||[]).filter(p=>p.projectId===projectId).map(p=>({...p,stages:(p.stages||[]).map(s=>({...s,members:(s.members||[]).map(m=>omit(m,['prompt','summary','execution']))}))}));
  return {projectId,state};
}

const keyed=value=>Array.isArray(value)&&value.every(v=>v&&typeof v.id==='string')&&new Set(value.map(v=>v.id)).size===value.length;
const encode=value=>JSON.stringify(value);

/** The cursor only caches a rebuildable UI projection; on restart, eviction, or project switch the snapshot is restored, and message persistence is unaffected. */
export class WorkspaceStateFeed {
  constructor({maxScopes=16,history=4}={}) {this.epoch=randomUUID();this.scopes=new Map();this.maxScopes=maxScopes;this.history=history;}
  read(snapshot,projectId,cursor) {
    const projection=workspaceState(snapshot,projectId),key=projection.projectId||'';
    const serialized=encode(projection.state),state=JSON.parse(serialized);
    const nextCursor=`${this.epoch}:${createHash('sha256').update(key).update(serialized).digest('hex')}`;
    let history=this.scopes.get(key)||[];
    const previous=history.find(entry=>entry.cursor===cursor);
    if(!history.some(entry=>entry.cursor===nextCursor))history=[...history,{cursor:nextCursor,state}].slice(-this.history);
    this.scopes.delete(key);this.scopes.set(key,history);
    while(this.scopes.size>this.maxScopes)this.scopes.delete(this.scopes.keys().next().value);
    const envelope={schema:1,projectId:projection.projectId,cursor:nextCursor};
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
