import { tr } from './i18n.mjs';
import {conversationIdOf,assertConversationRecord} from './group-conversations.mjs';
/** A working role may keep this many active reminders of its own; the supervisor has no such limit. */
const MAX_OWN_REMINDERS = 10;
const ACTIONS = new Set(['list', 'create', 'update', 'pause', 'resume', 'delete']);
const SCHEDULE_FIELDS = ['type', 'onceAt', 'intervalMinutes', 'time', 'timezone', 'weekday', 'anchorAt'];
const WRITE_FIELDS = ['requestId', 'id', 'revision', 'name', 'description', 'roleId', 'jobType', 'enabled', 'schedule', ...SCHEDULE_FIELDS];

function normalize(action, input) {
  const allowed = action === 'list' ? [] : ['pause', 'resume', 'delete'].includes(action)
    ? ['requestId', 'id', 'revision'] : WRITE_FIELDS;
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error(tr('timerAgent.invalidScheduledJobParametersProject'));
  if (action === 'list') return {};
  if (typeof input.requestId !== 'string' || !/^[\w:.-]{1,120}$/.test(input.requestId)) throw new Error(tr('timerAgent.stableRequestidRequired'));
  const result = { requestId: input.requestId };
  if (action !== 'create') {
    if (typeof input.id !== 'string' || !input.id || !Number.isSafeInteger(input.revision) || input.revision < 1) throw new Error(tr('timerAgent.scheduledJobIdRevisionRequired'));
    result.id = input.id;
    result.revision = input.revision;
  }
  if (['pause', 'resume', 'delete'].includes(action)) return result;
  for (const key of ['name', 'description', 'roleId', 'jobType', 'enabled']) if (input[key] !== undefined) result[key] = input[key];
  const source = input.schedule === undefined ? input : input.schedule;
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error(tr('timerAgent.scheduleMustBeObject'));
  if (input.schedule !== undefined && (Object.keys(input).some(key => SCHEDULE_FIELDS.includes(key)) || Object.keys(source).some(key => !SCHEDULE_FIELDS.includes(key)))) throw new Error(tr('timerAgent.invalidScheduleParameters'));
  result.schedule = Object.fromEntries(SCHEDULE_FIELDS.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
  return result;
}

/** The only write boundary for role CLIs; project ownership is determined by the active Run, and a stable request ID makes retries safe.
 *  Any role may keep reminders for itself; only the supervisor may set or change them for other roles. */
export class TimerAgentActions {
  constructor(db, jobs) { this.db = db; this.jobs = jobs; }

  execute(run, action, input = {}) {
    if (!ACTIONS.has(action) || !input || typeof input !== 'object' || Array.isArray(input)) throw new Error(tr('timerAgent.invalidScheduledJobAction'));
    const project = this.db.get('projects', run?.projectId);
    if (!project || !run.roleId || this.db.get('roles', run.roleId)?.projectId !== project.id) throw new Error(tr('timerAgent.onlyCurrentProjectSFixed'));
    const supervisor = project.supervisorRoleId === run.roleId && Boolean(run.roleSnapshot?.systemSupervisor);
    const values = normalize(action, input);
    if (action === 'list') {
      const listed = this.jobs.list(run.projectId,conversationIdOf(run));
      if (supervisor) return listed;
      const own = new Set(listed.jobs.filter(job => job.roleId === run.roleId).map(job => job.id));
      return { jobs: listed.jobs.filter(job => own.has(job.id)), occurrences: listed.occurrences.filter(item => own.has(item.jobId)) };
    }
    const existing = values.id ? this.db.get('scheduledJobs',values.id) : null;
    if(values.id)assertConversationRecord(run,existing);
    if (action === 'create' && values.roleId === undefined) values.roleId = run.roleId;
    if (action === 'update' && values.roleId === undefined && existing) values.roleId = existing.roleId;
    if (!supervisor && (existing && existing.roleId !== run.roleId || values.roleId !== undefined && values.roleId !== run.roleId)) throw new Error(tr('timerAgent.ownRemindersOnly'));
    if (!supervisor && action === 'create' && this.db.list('scheduledJobs').filter(job => job.projectId === run.projectId && job.roleId === run.roleId && job.enabled !== false).length >= MAX_OWN_REMINDERS) throw new Error(tr('timerAgent.tooManyReminders', { count: MAX_OWN_REMINDERS }));
    if (['create', 'update'].includes(action) && values.roleId && this.db.get('roles', values.roleId)?.projectId !== run.projectId) throw new Error(tr('timerAgent.onlyRolesFromCurrentProject'));
    if (this.db.get('settings', 'main')?.paused) throw new Error(tr('timerAgent.remoteExecutionPaused'));
    return this.db.transaction(() => {
      // The supervisor keeps its original keys; other roles get their own namespace so two roles may both use "remind-1".
      const id = `${run.projectId}:${conversationIdOf(run)===run.projectId?'':`${conversationIdOf(run)}:`}${supervisor?'':`${run.roleId}:`}${values.requestId}`;
      const fingerprint = JSON.stringify({ action, values });
      const prior = this.db.get('timerActions', id);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error(tr('timerAgent.requestidParameterConflict'));
        return prior.result;
      }
      let result;
      if (action === 'create' || action === 'update') result = this.jobs.save(run.projectId, {...values,conversationId:conversationIdOf(run)});
      else if (action === 'pause' || action === 'resume') result = this.jobs.pause(run.projectId, values.id, action === 'resume', values.revision);
      else result = this.jobs.remove(run.projectId, values.id, values.revision);
      this.db.put('timerActions', { id, projectId: run.projectId, runId: run.id, action, fingerprint,
        result, createdAt: new Date().toISOString() });
      return result;
    });
  }
}
