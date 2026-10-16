import { randomUUID } from 'node:crypto';
import { tr } from './i18n.mjs';
import {posix} from 'node:path';
import {conversationIdOf,resolveConversationId,assertConversationRecord,agentConversationInput} from './group-conversations.mjs';

const now = () => new Date().toISOString();
const TYPES = new Set(['open', 'independent-review']);
const KIND = 'collaborationSessions';

/** Per-project switch, default OFF. Isolation filtering does not depend on it: an unreleased review stays protected even if the switch is turned off later. */
export function collaborationSessionsEnabled(db, projectId) {
  return db.get('projects', projectId)?.features?.collaborationSessions === true;
}

export function setCollaborationSessionsEnabled(db, projectId, enabled) {
  if (typeof enabled !== 'boolean') throw new Error(tr('collabSessions.enabledMustBeBoolean'));
  const project = db.get('projects', projectId);
  if (!project) throw new Error(tr('collabSessions.projectNotFound'));
  return db.put('projects', { ...project, features: { ...(project.features || {}), collaborationSessions: enabled } });
}

function text(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(tr('collabSessions.invalidText', { label, max }));
  return value.trim();
}

/**
 * Session ownership is derived from relations that already exist in the data (reply, request, run, task),
 * so late replies inherit the original session without any time or keyword heuristics. An explicit
 * collaborationSessionId stamped on a record always wins.
 */
export function sessionOf(db, kind, record, depth = 0, roots = null, seen = new Set()) {
  if (!record || seen.has(`${kind}:${record.id}`)) return null;
  seen.add(`${kind}:${record.id}`);
  if (record.collaborationSessionId) return record.collaborationSessionId;
  roots ||= sessionRoots(db, record.projectId);
  const hop = (k, id) => id ? sessionOf(db, k, db.get(k, id), depth + 1, roots, seen) : null;
  if (kind === 'roomMessages') return roots.messages.get(record.id) || hop('roomMessages', record.replyToId)
    || hop('coordinationRequests', record.requestId) || hop('runs', record.runId);
  if (kind === 'coordinationRequests') return roots.requests.get(record.id) || hop('coordinationRequests', record.parentRequestId)
    || hop('roomMessages', record.sourceMessageId);
  if (kind === 'runs') return hop('coordinationRequests', record.requestId) || hop('tasks', record.businessTaskId || record.taskId)
    || hop('roomMessages', record.sourceMessageId);
  if (kind === 'tasks') return roots.tasks.get(record.id) || hop('coordinationRequests', record.requestId)
    || hop('roomMessages', record.sourceMessageId);
  if (kind === 'discussionMessages') return hop('runs', record.sourceRunId);
  if (kind === 'runReports') return hop('runs', record.id);
  return null;
}

function sessionRoots(db, projectId) {
  const roots = { messages: new Map(), requests: new Map(), tasks: new Map() };
  for (const s of projectId ? db.listProject(KIND, projectId) : []) {
    if (s.sourceMessageId) roots.messages.set(s.sourceMessageId, s.id);
    for (const id of s.linkedTaskIds || []) roots.tasks.set(id, s.id);
    for (const id of s.linkedRequestIds || []) roots.requests.set(id, s.id);
  }
  return roots;
}

/** Collaboration session records: goal, participants, type, linked work and open state. Groundwork only, no broadcast or queue. */
export class CollaborationSessions {
  constructor(db) { this.db = db; }

  get(projectId, id) {
    const s = this.db.get(KIND, id);
    if (!s || s.projectId !== projectId) throw new Error(tr('collabSessions.sessionNotFound'));
    return s;
  }

  list(projectId) { return this.db.listProject(KIND, projectId); }

  /** The tool obtains project and actor from the current Run, never from model-supplied sender fields. */
  agent(run, action, input = {}, documentBaselines = []) {
    const project = this.db.get('projects', run?.projectId || '');
    if (!run?.roleId || project?.supervisorRoleId !== run.roleId || run.roleSnapshot?.platformAssistant) throw new Error(tr('collabSessions.supervisorOnly'));
    const actor = { kind: 'agent', roleId: run.roleId, runId: run.id };
    input=agentConversationInput(run,input);
    if (action === 'list') return this.list(run.projectId).filter(s=>conversationIdOf(s)===conversationIdOf(run));
    if(action!=='create')assertConversationRecord(run,this.db.get(KIND,input.sessionId));
    if (action === 'create') return this.create(run.projectId, { ...input, sourceMessageId: input.sourceMessageId || run.sourceMessageId }, actor, documentBaselines);
    if (action === 'link') return this.link(run.projectId, input.sessionId, input);
    if (action === 'add-member') return this.addMember(run.projectId, input.sessionId, input, actor);
    if (action === 'remove-member') return this.removeMember(run.projectId, input.sessionId, input, actor);
    if (action === 'release') return this.release(run.projectId, input.sessionId, actor);
    if (action === 'close') return this.close(run.projectId, input.sessionId, actor);
    throw new Error(tr('collabSessions.invalidAction'));
  }

  #role(projectId, roleId) {
    const role = this.db.get('roles', roleId);
    if (!role || role.projectId !== projectId) throw new Error(tr('collabSessions.participantNotInProject'));
    return role;
  }

  create(projectId, input = {}, actor = { kind: 'human' }, documentBaselines = []) {
    const conversationId=resolveConversationId(this.db,projectId,input.conversationId);
    return this.db.transaction(() => {
      if (!collaborationSessionsEnabled(this.db, projectId)) throw new Error(tr('collabSessions.featureDisabled'));
      if (input.id) { const prior = this.db.get(KIND, input.id); if (prior) { assertConversationRecord({projectId,conversationId},prior); return prior; } }
      const type = input.type || 'open';
      if (!TYPES.has(type)) throw new Error(tr('collabSessions.invalidType'));
      if (!Array.isArray(input.participants) || !input.participants.length || input.participants.length > 50) throw new Error(tr('collabSessions.participantsRequired'));
      const at = now(), participants = [];
      for (const item of input.participants) {
        const roleId = typeof item === 'string' ? item : item?.roleId;
        this.#role(projectId, roleId);
        if (participants.some(p => p.roleId === roleId)) continue;
        participants.push({ roleId, reviewer: type === 'independent-review' ? item?.reviewer !== false : false, joinedAt: at });
      }
      const parent = input.parentSessionId ? this.db.get(KIND, input.parentSessionId) : null;
      if (input.parentSessionId && parent?.projectId !== projectId) throw new Error(tr('collabSessions.sessionNotFound'));
      const source = input.sourceMessageId ? this.db.get('roomMessages', input.sourceMessageId) : null;
      if(parent)assertConversationRecord({projectId,conversationId},parent);
      if(source)assertConversationRecord({projectId,conversationId},source);
      if (input.sourceMessageId && source?.projectId !== projectId) throw new Error(tr('collabSessions.linkNotInProject'));
      const s = { id: input.id || randomUUID(), projectId, conversationId, goal: text(input.goal, 'goal', 4000),
        background: input.background ? text(input.background, 'background', 16000) : '',
        documentBaselines: type === 'independent-review' ? documentBaselines : [],
        delivery: input.delivery ? text(input.delivery, 'delivery', 4000) : '', type, participants,
        linkedTaskIds: [], linkedRequestIds: [], sourceMessageId: source?.id || null, parentSessionId: parent?.id || null, state: 'open', reviewReleasedAt: null,
        membershipLog: participants.map(p => ({ action: 'add', roleId: p.roleId, reviewer: p.reviewer, actor, at })),
        createdBy: actor, createdAt: at, updatedAt: at };
      this.db.put(KIND, s);
      for (const taskId of input.linkedTaskIds || []) this.link(projectId, s.id, { taskId });
      for (const requestId of input.linkedRequestIds || []) this.link(projectId, s.id, { requestId });
      return this.db.get(KIND, s.id);
    });
  }

  link(projectId, id, { taskId, requestId } = {}) {
    return this.db.transaction(() => {
      const s = this.get(projectId, id);
      const [kind, key, field] = taskId ? ['tasks', taskId, 'linkedTaskIds'] : ['coordinationRequests', requestId, 'linkedRequestIds'];
      const record = key ? this.db.get(kind, key) : null;
      if (!record || record.projectId !== projectId) throw new Error(tr('collabSessions.linkNotInProject'));
      assertConversationRecord(s,record);
      const owner = sessionOf(this.db, kind, record);
      if (owner && owner !== id) throw new Error(tr('collabSessions.alreadyLinked'));
      if (s[field].includes(key)) return s;
      return this.db.put(KIND, { ...s, [field]: [...s[field], key], updatedAt: now() });
    });
  }

  /** Membership changes are recorded explicitly; they never delete existing requests. */
  addMember(projectId, id, { roleId, reviewer } = {}, actor = { kind: 'human' }) {
    return this.db.transaction(() => {
      const s = this.get(projectId, id);
      if (s.state !== 'open') throw new Error(tr('collabSessions.sessionClosed'));
      this.#role(projectId, roleId);
      if (s.participants.some(p => p.roleId === roleId)) return s;
      const entry = { roleId, reviewer: s.type === 'independent-review' && !s.reviewReleasedAt ? reviewer !== false : false, joinedAt: now() };
      return this.db.put(KIND, { ...s, participants: [...s.participants, entry],
        membershipLog: [...s.membershipLog, { action: 'add', roleId, reviewer: entry.reviewer, actor, at: entry.joinedAt }], updatedAt: now() });
    });
  }

  removeMember(projectId, id, { roleId } = {}, actor = { kind: 'human' }) {
    return this.db.transaction(() => {
      const s = this.get(projectId, id);
      if (!s.participants.some(p => p.roleId === roleId)) return s;
      // A removed reviewer's protected opinions stay protected until release; removal does not grant access either.
      return this.db.put(KIND, { ...s, participants: s.participants.filter(p => p.roleId !== roleId),
        formerReviewerIds: [...new Set([...(s.formerReviewerIds || []), ...s.participants.filter(p => p.roleId === roleId && p.reviewer).map(p => p.roleId)])],
        membershipLog: [...s.membershipLog, { action: 'remove', roleId, actor, at: now() }], updatedAt: now() });
    });
  }

  /** Transition from independent review to shared discussion releases every protected opinion at once. */
  release(projectId, id, actor = { kind: 'human' }) {
    return this.db.transaction(() => {
      const s = this.get(projectId, id);
      if (s.type !== 'independent-review') throw new Error(tr('collabSessions.notIndependentReview'));
      if (s.reviewReleasedAt) return s;
      return this.db.put(KIND, { ...s, reviewReleasedAt: now(), reviewReleasedBy: actor, updatedAt: now() });
    });
  }

  /** Closing stops future automatic discussion only; it never cancels accepted tasks. */
  close(projectId, id, actor = { kind: 'human' }) {
    return this.db.transaction(() => {
      const s = this.get(projectId, id);
      if (s.state === 'closed') return s;
      // Closing a root session ends its propagation cycle; the cycle record is kept for audit.
      const cycle = !s.parentSessionId ? this.db.get('sessionCycles', s.cycleId || `cycle:${s.id}`) : null;
      if (cycle && !cycle.ended) this.db.put('sessionCycles', { ...cycle, ended: true, endedAt: now(), paused: true, pauseReason: 'session_closed' });
      return this.db.put(KIND, { ...s, state: 'closed', closedAt: now(), closedBy: actor, updatedAt: now() });
    });
  }
}

/** Active independent reviews where the viewer is a reviewer: id -> set of other reviewer role ids. */
function guardedSessions(db, projectId, viewerRoleId) {
  const map = new Map();
  if (!projectId || !viewerRoleId) return map;
  const sessions=db.listProject(KIND,projectId),byId=new Map(sessions.map(s=>[s.id,s]));
  const descendant=(session,parentId)=>{const seen=new Set();for(let current=session;current&&!seen.has(current.id);current=byId.get(current.parentSessionId)){if(current.id===parentId)return true;seen.add(current.id);}return false;};
  for (const s of sessions) {
    if (s.type !== 'independent-review' || s.reviewReleasedAt) continue;
    // Splitting a protected review into an open child topic is not a release of its opinions.
    const family=sessions.filter(child=>descendant(child,s.id));
    const others = new Set(family.flatMap(child=>[...child.participants.filter(p => p.reviewer).map(p => p.roleId), ...(child.formerReviewerIds || [])]));
    if(!others.has(viewerRoleId))continue;
    others.delete(viewerRoleId);
    if(others.size)for(const child of family)map.set(child.id,new Set([...(map.get(child.id)||[]),...others]));
  }
  return map;
}

const authorOf = {
  roomMessages: (db, m) => m.sender === 'agent' ? m.roleId || db.get('runs', m.runId || '')?.roleId || null : null,
  runs: (db, r) => r.roleId || null,
  coordinationRequests: (db, q) => q.result ? q.targetRoleId || db.get('runs', q.currentRunId || '')?.roleId || null : null,
  discussionMessages: (db, m) => db.get('runs', m.sourceRunId || '')?.roleId || m.fromRoleId || null,
  runReports: (db, r) => r.roleId || null
};

/**
 * A read-only view of the store for one reader. Protected records are removed or redacted at the data-access
 * layer, so every read path (history list/read/search, quote expansion, session/run records, reports, peers,
 * summaries, attachments carried by messages, run context packets) is filtered before pagination or summarising.
 * Returns the store itself when no guard applies.
 */
export function reviewView(db, { projectId, roleId }) {
  const guarded = guardedSessions(db, projectId, roleId);
  if (!guarded.size) return db;
  const roots = sessionRoots(db, projectId), memo = new Map();
  const isProtected = (kind, record, depth = 0) => {
    if (!record || record.projectId && record.projectId !== projectId) return false;
    const key = `${kind}:${record.id}`;
    if (memo.has(key)) return memo.get(key);
    memo.set(key, false);
    let result = false;
    const owner = sessionOf(db, kind, record, 0, roots);
    const author = authorOf[kind]?.(db, record);
    if (owner && guarded.get(owner)?.has(author)) result = true;
    // Derived content: an agent message replying to a protected opinion carries it forward.
    else if(kind==='coordinationRequests')
      result = (record.sourceRunId && isProtected('runs', db.get('runs', record.sourceRunId), depth + 1))
        || (record.continuationOf && isProtected('coordinationRequests', db.get('coordinationRequests', record.continuationOf), depth + 1))
        || (record.parentRequestId && isProtected('coordinationRequests', db.get('coordinationRequests', record.parentRequestId), depth + 1)) || false;
    else if(kind==='runs'||kind==='tasks')
      result = (record.requestId && isProtected('coordinationRequests',db.get('coordinationRequests',record.requestId),depth+1))
        || (record.sourceRunId && isProtected('runs',db.get('runs',record.sourceRunId),depth+1))
        || (kind==='runs'&&record.taskId&&isProtected('tasks',db.get('tasks',record.taskId),depth+1)) || false;
    else if(kind==='runReports')result=isProtected('runs',db.get('runs',record.id),depth+1);
    else if(kind==='discussionMessages')result=isProtected('runs',db.get('runs',record.sourceRunId||''),depth+1);
    else if(kind==='roomMessages' && record.sender==='agent' && record.runId && isProtected('runs',db.get('runs',record.runId),depth+1))result=true;
    else if (kind === 'roomMessages' && record.sender === 'agent' && record.replyToId)
      result = isProtected('roomMessages', db.get('roomMessages', record.replyToId), depth + 1);
    memo.set(key, result);
    return result;
  };
  const protectedMessageIds = () => new Set(db.listProject('roomMessages', projectId).filter(m => isProtected('roomMessages', m)).map(m => m.id));
  const filter = (kind, record) => {
    if (!record) return record;
    switch (kind) {
      case 'roomMessages': case 'discussionMessages': case 'runReports': return isProtected(kind, record) ? null : record;
      case 'runs': return isProtected(kind, record) ? { ...record, result: null, error: record.error ? '' : record.error, report: null,
        contextPacket: null, inputTask: null, discussionContext: null, reviewRedacted: true } : record;
      case 'tasks': return isProtected(kind,record)?{...record,prompt:null,error:null,title:null,attachments:[],teamContext:null,contextPacket:null,reviewRedacted:true}:record;
      case 'coordinationRequests': return isProtected(kind, record) ? { ...record, summary: null, result: null, reportSummary: null, error: null, resumeSummary: null, attachments: [], reviewRedacted: true } : record;
      case 'conversationContexts': {
        // Organizer summaries may be derived from protected opinions; withhold them while any exist.
        const hidden = protectedMessageIds();
        return hidden.size ? null : record;
      }
      default: return record;
    }
  };
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'get') return (kind, id) => filter(kind, target.get(kind, id));
      if (prop === 'list') return kind => target.list(kind).map(r => filter(kind, r)).filter(Boolean);
      if (prop === 'listProject') return (kind, pid) => target.listProject(kind, pid).map(r => filter(kind, r)).filter(Boolean);
      if (prop === 'reviewGuarded') return true;
      if (['put', 'remove', 'transaction'].includes(prop)) return () => { throw new Error(tr('collabSessions.readOnlyView')); };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

/** Shared documents must still match the pre-review content on this device; own private handoffs stay readable. */
export function reviewDocumentAllowed(db, run, file) {
  return reviewSourceFileAllowed(db,run,{sourceNodeId:run.nodeId,reviewPath:file?.path,hash:file?.hash});
}

/** Alternate-source reads keep the caller's identity; hash existence never releases a peer opinion. */
export function reviewSourceFileAllowed(db,run,{sourceNodeId,reviewPath,hash,scopeId,sourceRunId,preflight=false}){
  if(typeof reviewPath!=='string'||reviewPath.includes('\\')||reviewPath!==posix.normalize(reviewPath)||posix.isAbsolute(reviewPath))return false;
  if(sourceRunId&&reviewView(db,{projectId:run.projectId,roleId:run.roleId}).get('runs',sourceRunId)?.reviewRedacted)return false;
  const guarded=guardedSessions(db,run.projectId,run.roleId);
  if(!guarded.size)return true;
  if(reviewPath.startsWith('handoffs/private/'))return sourceNodeId===run.nodeId&&reviewPath.startsWith(`handoffs/private/${run.roleId}/`);
  return [...guarded.keys()].map(id=>db.get(KIND,id)).filter(s=>s?.type==='independent-review'&&!s.reviewReleasedAt)
    .every(s=>s.documentBaselines?.some(b=>b.nodeId===sourceNodeId&&b.path===reviewPath&&(!scopeId||!b.scopeId||b.scopeId===scopeId)&&(preflight||b.hash===hash)));
}
