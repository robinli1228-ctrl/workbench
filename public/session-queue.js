import {t} from './i18n.js';

const labels={queued:'Queued on platform',pending_verification:'Pending verification',processing:'CLI processing',processed:'Batch processed',unresolved:'Needs attention',waiting_reply:'Waiting for reply'};
const reasons={collecting:'collecting',not_idle:'CLI busy',role_busy:'CLI busy',turn_active:'CLI busy',tools_running:'CLI busy',approval_pending:'Waiting for approval',
  worker_upgrade_required:'Worker upgrade required',session_closed:'Session closed',broadcast_paused:'Broadcast paused',manual_takeover:'Manual takeover',lease_expired:'Reservation expired',worker_rejected:'Reservation expired',not_owner:'CLI busy',unknown:'CLI state unknown',review_isolation:'Review opinions are not released',startup_failed:'CLI startup failed'};

/** Read-only strip: shows platform queue vs. CLI execution truthfully; never offers a control that writes to a CLI. */
export function renderSessionQueue(status,{create,roleName,api,refreshState,projectId}) {
  if(!status)return null;
  const counts={};for(const r of status.receipts||[])if(r.state!=='processed')counts[r.state]=(counts[r.state]||0)+1;
  const waiting=(status.collectors||[]).map(c=>`${roleName(c.roleId)}: ${t(reasons[c.waitingReason]||'collecting')}`);
  const sessions=status.sessions||[];
  if(!Object.keys(counts).length&&!waiting.length&&!sessions.length)return null;
  const box=create('div','session-queue-strip');box.setAttribute('role','status');
  box.append(create('strong','',t('Collaboration history · collection disabled')));
  for(const [state,n] of Object.entries(counts))box.append(create('span','pill',`${t(labels[state]||state)} · ${n}`));
  if(waiting.length)box.append(create('span','workspace-note',waiting.join(' · ')));
  for(const session of sessions)box.append(sessionRow(session,status,{create,roleName,api,refreshState,projectId}));
  return box;
}

/** Historical sessions retain only explicit human release/close, never collection or budget controls. */
function sessionRow(session,status,{create,roleName,api,refreshState,projectId}) {
  const row=create('div','session-queue-row');
  const cycle=(status.cycles||[]).find(c=>c.rootSessionId===session.id);
  const label=`${session.goal} · ${session.participants.map(roleName).join(', ')}${cycle?` · ${t('Budget')} ${cycle.used}/${cycle.limit}`:''}`;
  row.append(create('span','',label));
  if(!api)return row;
  const base=`/api/projects/${encodeURIComponent(projectId)}/collaboration-sessions/${encodeURIComponent(session.id)}`;
  const act=(text,run)=>{const b=create('button','secondary compact',t(text));b.type='button';b.onclick=async()=>{b.disabled=true;try{await run();await refreshState({quiet:true});}catch(e){alert(e.message);}finally{b.disabled=false;}};row.append(b);};
  if(session.type==='independent-review'&&!session.reviewReleased)act('Release reviews',()=>api(`${base}/release`,{method:'POST',json:{}}));
  if(session.state!=='closed')act('End discussion',async()=>{if(confirm(t('End this discussion? Accepted tasks are not cancelled.')))await api(`${base}/close`,{method:'POST',json:{}});});
  return row;
}
