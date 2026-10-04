import { randomUUID } from 'node:crypto';
import { progressFindings } from './timer-monitor.mjs';
import { tr } from './i18n.mjs';

const SYSTEM_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const TASK_ACTIVE = new Set(['ready', 'in_progress', 'awaiting_acceptance']);
const CALL_TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const TYPES = new Set(['once', 'interval', 'daily', 'weekly']);
const iso = date => date.toISOString();

function validZone(timeZone) {
  try { new Intl.DateTimeFormat('en', { timeZone }).format(); return true; }
  catch { return false; }
}

function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  return Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
}

/** Returns real instants for a local wall-clock minute. No result means a DST gap. */
function wallClockInstants(year, month, day, hour, minute, timeZone) {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const offsets = new Set();
  for (const hours of [-36, -24, -12, 0, 12, 24, 36]) {
    const sample = new Date(wall + hours * 3600000);
    const p = zonedParts(sample, timeZone);
    offsets.add(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - sample.getTime());
  }
  return [...offsets].map(offset => new Date(wall - offset)).filter(candidate => {
    const p = zonedParts(candidate, timeZone);
    return p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute;
  }).sort((a, b) => a - b);
}

function nextWallClock(after, schedule) {
  const local = zonedParts(after, schedule.timezone);
  const [hour, minute] = schedule.time.split(':').map(Number);
  const start = new Date(Date.UTC(local.year, local.month - 1, local.day));
  for (let offset = 0; offset < 3700; offset += 1) {
    const day = new Date(start.getTime() + offset * 86400000);
    if (schedule.type === 'weekly' && day.getUTCDay() !== schedule.weekday) continue;
    const candidates = wallClockInstants(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hour, minute, schedule.timezone);
    const next = candidates.find(candidate => candidate > after);
    if (next) return next;
  }
  throw new Error(tr('scheduledJobs.unableCalculateNextRunTime'));
}

function nextRun(schedule, after) {
  if (schedule.type === 'once') return new Date(schedule.onceAt) > after ? new Date(schedule.onceAt) : null;
  if (schedule.type === 'interval') {
    const anchor = new Date(schedule.anchorAt).getTime(), step = schedule.intervalMinutes * 60000;
    return new Date(anchor + (Math.floor((after.getTime() - anchor) / step) + 1) * step);
  }
  return nextWallClock(after, schedule);
}

function normalizeSchedule(input, now, previous, jobType = 'dispatch') {
  const raw = input.schedule ? { ...input.schedule } : { ...input };
  const type = raw.type;
  if (!TYPES.has(type)) throw new Error(tr('scheduledJobs.scheduleTypeMustBeOnce'));
  if (jobType === 'monitor' && type !== 'interval') throw new Error(tr('scheduledJobs.progressInspectionCanOnlyUse'));
  if (type === 'once') {
    const match = typeof raw.onceAt === 'string' && raw.onceAt.match(/^(\d{4})-(\d\d)-(\d\d)T\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/);
    const calendar = match && new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    const validCalendar = calendar && calendar.getUTCFullYear() === Number(match[1]) && calendar.getUTCMonth() + 1 === Number(match[2]) && calendar.getUTCDate() === Number(match[3]);
    if (!match || !validCalendar || Number.isNaN(Date.parse(raw.onceAt))) throw new Error(tr('scheduledJobs.oneTimeScheduleMustBe'));
    return { type, onceAt: iso(new Date(raw.onceAt)) };
  }
  if (type === 'interval') {
    const intervalMinutes = Number(raw.intervalMinutes);
    const minimum = jobType === 'monitor' ? 10 : 15;
    if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < minimum || intervalMinutes > 525600) throw new Error(tr('scheduledJobs.intervalMustBeAtLeast', { minimum }));
    const same = previous?.type === type && previous.intervalMinutes === intervalMinutes;
    return { type, intervalMinutes, anchorAt: same ? previous.anchorAt : iso(now) };
  }
  const time = typeof raw.time === 'string' ? raw.time : '';
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error(tr('scheduledJobs.localTimeMustBeHh'));
  const timezone = typeof raw.timezone === 'string' && raw.timezone.trim() ? raw.timezone.trim() : SYSTEM_TIME_ZONE;
  if (!validZone(timezone)) throw new Error(tr('scheduledJobs.invalidIanaTimeZone'));
  if (type === 'daily') return { type, time, timezone };
  const weekday = Number(raw.weekday);
  if (!Number.isSafeInteger(weekday) || weekday < 0 || weekday > 6) throw new Error(tr('scheduledJobs.weekdayMustBe06'));
  return { type, weekday, time, timezone };
}

/** Lightweight project-level scheduling; database records determine idempotency, catch-up, and behavior after a restart. */
export class ScheduledJobs {
  constructor(db, rooms, { clock = () => new Date() } = {}) {
    this.db = db;
    this.rooms = rooms;
    this.clock = clock;
  }

  list(projectId) {
    this.#project(projectId);
    const jobs = this.db.list('scheduledJobs').filter(job => job.projectId === projectId).map(job => ({ ...job, jobType: job.jobType || 'dispatch' }));
    const occurrences = this.db.list('scheduledOccurrences').filter(item => item.projectId === projectId)
      .map(item => this.#withStatus(item)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { jobs, occurrences };
  }

  save(projectId, input) {
    this.#project(projectId);
    if (!input || typeof input !== 'object') throw new Error(tr('scheduledJobs.scheduleConfigurationRequired'));
    const old = input.id ? this.db.get('scheduledJobs', input.id) : null;
    if (input.id && old?.projectId !== projectId) throw new Error(tr('scheduledJobs.scheduledJobDoesNotBelong'));
    if (old && input.revision !== old.revision) throw new Error(tr('scheduledJobs.scheduledJobConfigurationHasChanged'));
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const description = typeof input.description === 'string' ? input.description.trim() : '';
    if (!name || name.length > 80) throw new Error(tr('scheduledJobs.nameMustBe180'));
    if (!description || description.length > 12000) throw new Error(tr('scheduledJobs.descriptionMustBe112000'));
    const jobType = input.jobType || old?.jobType || 'dispatch';
    if (!['dispatch', 'monitor'].includes(jobType)) throw new Error(tr('scheduledJobs.invalidScheduledJobType'));
    const role = this.#role(projectId, input.roleId);
    if (jobType === 'monitor' && role.id !== this.#project(projectId).supervisorRoleId) throw new Error(tr('scheduledJobs.progressInspectionCanOnlyBe'));
    const now = this.#now();
    const schedule = normalizeSchedule(input, now, old?.schedule, jobType);
    const scheduleChanged = !old || JSON.stringify(schedule) !== JSON.stringify(old.schedule);
    const enabled = input.enabled === undefined ? old?.enabled ?? true : input.enabled;
    if (typeof enabled !== 'boolean') throw new Error(tr('scheduledJobs.enabledMustBeBoolean'));
    const job = {
      id: old?.id || randomUUID(), projectId, name, description, roleId: role.id, jobType, schedule, enabled,
      revision: (old?.revision || 0) + 1, manualSequence: old?.manualSequence || 0,
      activeFindingKeys: old?.activeFindingKeys || [], lastCheckAt: old?.lastCheckAt || null, lastCheckResult: old?.lastCheckResult || null,
      createdAt: old?.createdAt || iso(now), updatedAt: iso(now),
      nextRunAt: scheduleChanged ? nextRun(schedule, now)?.toISOString() || null : old.nextRunAt
    };
    this.db.put('scheduledJobs', job);
    if (!enabled) this.#cancelPending(job.id);
    return job;
  }

  /** enabled=false pauses and enabled=true resumes; resuming does not generate multiple backlogged runs from the offline period. */
  pause(projectId, id, enabled, revision) {
    const job = this.#job(projectId, id);
    if (revision !== undefined && revision !== job.revision) throw new Error(tr('scheduledJobs.scheduledJobConfigurationHasChanged2'));
    if (typeof enabled !== 'boolean') throw new Error(tr('scheduledJobs.enabledMustBeBoolean2'));
    const updated = this.db.put('scheduledJobs', { ...job, enabled, revision: job.revision + 1, updatedAt: iso(this.#now()) });
    if (!enabled) this.#cancelPending(id);
    return updated;
  }

  remove(projectId, id, revision) {
    const job = this.#job(projectId, id);
    if (revision !== undefined && revision !== job.revision) throw new Error(tr('scheduledJobs.scheduledJobConfigurationHasChanged3'));
    this.#cancelPending(id);
    this.db.remove('scheduledJobs', id);
    return { id: job.id, deleted: true };
  }

  runNow(projectId, id) {
    const job = this.#job(projectId, id);
    if (this.db.get('settings', 'main')?.paused || (job.jobType === 'monitor' && !job.enabled)) throw new Error(tr('scheduledJobs.scheduledJobsRemoteExecutionPaused'));
    if (job.jobType !== 'monitor' && this.#hasActive(job.id)) throw new Error(tr('scheduledJobs.previousScheduledRunItsCollaboration'));
    return this.db.transaction(() => {
      const current = this.#job(projectId, id);
      const manualNumber = (current.manualSequence || 0) + 1;
      const updated = this.db.put('scheduledJobs', { ...current, manualSequence: manualNumber, updatedAt: iso(this.#now()) });
      if (current.jobType === 'monitor') return this.#checkMonitor(updated, `manual-${manualNumber}`, this.#now(), false, { manualNumber });
      return this.#dispatch(current, `manual-${manualNumber}`, { manualNumber });
    });
  }

  tick() {
    if (this.db.get('settings', 'main')?.paused) return false;
    const now = this.#now(); let changed = false;
    for (const snapshot of this.db.list('scheduledJobs')) {
      if (!snapshot.enabled || !snapshot.nextRunAt || new Date(snapshot.nextRunAt) > now || (snapshot.jobType !== 'monitor' && this.#hasActive(snapshot.id))) continue;
      const role = this.db.get('roles', snapshot.roleId);
      if (!role || role.projectId !== snapshot.projectId || role.archivedAt || !role.enabled || role.configured === false) continue;
      try {
        const result = this.db.transaction(() => {
          const job = this.db.get('scheduledJobs', snapshot.id);
          if (!job?.enabled || !job.nextRunAt || new Date(job.nextRunAt) > now || (job.jobType !== 'monitor' && this.#hasActive(job.id))) return null;
          const dueAt = job.nextRunAt;
          const occurrenceId = `${job.id}:${dueAt}`;
          if (this.db.get('scheduledOccurrences', occurrenceId)) return null;
          if (job.jobType === 'monitor') return this.#checkMonitor(job, dueAt, now, true, { id: occurrenceId, dueAt });
          const next = nextRun(job.schedule, now);
          this.db.put('scheduledJobs', { ...job, nextRunAt: next?.toISOString() || null, lastRunAt: iso(now), updatedAt: iso(now) });
          return this.#dispatch(job, dueAt, { id: occurrenceId, dueAt });
        });
        if (result) changed = true;
      } catch (error) {
        this.db.transaction(() => {
          const job = this.db.get('scheduledJobs', snapshot.id);
          if (!job?.nextRunAt) return;
          const dueAt = job.nextRunAt, occurrenceId = `${job.id}:${dueAt}`;
          if (this.db.get('scheduledOccurrences', occurrenceId)) return;
          let next = null, message = error instanceof Error ? error.message : String(error);
          try { next = nextRun(job.schedule, now); }
          catch (scheduleError) { message = tr('scheduledJobs.subsequentScheduleInvalid', { message, p2: scheduleError instanceof Error ? scheduleError.message : String(scheduleError) }); }
          const role = this.db.get('roles', job.roleId);
          this.db.put('scheduledJobs', { ...job, nextRunAt: next?.toISOString() || null, lastRunAt: iso(now), updatedAt: iso(now) });
          this.db.put('scheduledOccurrences', {
            id: occurrenceId, projectId: job.projectId, jobId: job.id, jobRevision: job.revision, jobName: job.name,
            dueAt, kind: job.jobType === 'monitor' ? 'monitor' : 'scheduled', roleId: job.roleId, roleSnapshot: role || null,
            messageId: `timer-${job.id}-${Date.parse(dueAt)}`, status: 'failed', error: message.slice(0, 2000), createdAt: iso(now)
          });
          changed = true;
        });
      }
    }
    return changed;
  }

  /** Health inspection only saves a checkpoint; new anomalies are merged into a single Supervisor dispatch. */
  #checkMonitor(job, key, now, advance, extra = {}) {
    const findings = progressFindings(this.db, job.projectId, now);
    const previous = new Set(job.activeFindingKeys || []);
    const fresh = findings.filter(item => !previous.has(item.key));
    const deferred = fresh.length && this.#hasActive(job.id);
    const updated = this.db.put('scheduledJobs', {
      ...job, activeFindingKeys: findings.filter(item => !deferred || previous.has(item.key)).map(item => item.key), lastCheckAt: iso(now),
      lastCheckResult: deferred ? 'deferred' : fresh.length ? 'alerted' : 'healthy', lastRunAt: iso(now), updatedAt: iso(now),
      nextRunAt: advance ? nextRun(job.schedule, now)?.toISOString() || null : job.nextRunAt
    });
    if (!fresh.length || deferred) return updated;
    const text = tr('scheduledJobs.inspectionFoundNewAnomaliesVerify', { description: job.description, p2: fresh.map(item => `- ${item.text}`).join('\n') }).slice(0, 12000);
    return this.#dispatch(updated, key, { ...extra, kind: 'monitor', text });
  }

  #dispatch(job, key, extra) {
    const now = this.#now();
    const role = this.#role(job.projectId, job.roleId);
    const { text, ...occurrenceExtra } = extra;
    const id = extra.id || `${job.id}:${key}`;
    const numericKey = key.startsWith('manual-') ? key.replace('manual-', 'm') : String(Date.parse(key));
    const messageId = `timer-${job.id}-${numericKey}`;
    const occurrence = this.db.put('scheduledOccurrences', {
      id, projectId: job.projectId, jobId: job.id, jobRevision: job.revision, jobName: job.name,
      dueAt: extra.dueAt || iso(now), kind: extra.kind || (extra.manualNumber ? 'manual' : 'scheduled'), ...occurrenceExtra,
      roleId: role.id, roleSnapshot: role, messageId, status: 'dispatching', createdAt: iso(now)
    });
    const message = this.rooms.post(job.projectId, {
      clientMessageId: messageId, text: text || job.description, targetRoleId: role.id, scheduledJobId: job.id
    });
    return this.db.put('scheduledOccurrences', { ...occurrence, taskIds: message.taskIds || [], status: 'queued' });
  }

  #withStatus(item) {
    if (item.status === 'cancelled') return item;
    const tasks = (item.taskIds || []).map(id => this.db.get('tasks', id)).filter(Boolean);
    const calls = this.db.list('coordinationRequests').filter(call => call.sourceMessageId === item.messageId);
    if(tasks.length && tasks.every(task=>task.status==='ready'&&!task.currentRunId) && calls.every(call=>['queued','waiting_delivery'].includes(call.status))) return {...item,status:'queued'};
    if (tasks.some(task => TASK_ACTIVE.has(task.status)) || calls.some(call => !CALL_TERMINAL.has(call.status))) return { ...item, status: 'running' };
    if (tasks.some(task => task.status === 'blocked') || calls.some(call => call.status === 'failed')) return { ...item, status: 'failed' };
    if (tasks.length && tasks.every(task => ['completed', 'done', 'succeeded', 'cancelled'].includes(task.status))) {
      if (tasks.every(task => task.status === 'cancelled')) return { ...item, status: 'cancelled' };
      return { ...item, status: calls.length && calls.every(call => call.status === 'succeeded' && call.outcome === 'passed') ? 'succeeded' : 'unverified' };
    }
    return item;
  }

  #hasActive(jobId) {
    return this.db.list('scheduledOccurrences').filter(item => item.jobId === jobId).some(item => ['dispatching', 'queued', 'running'].includes(this.#withStatus(item).status));
  }

  #cancelPending(jobId) {
    for (const item of this.db.list('scheduledOccurrences').filter(item => item.jobId === jobId)) {
      let cancelled = false;
      for (const taskId of item.taskIds || []) {
        const task = this.db.get('tasks', taskId);
        if (task?.status === 'ready' && !task.currentRunId) {
          this.rooms.cancel(taskId); cancelled = true;
          for (const request of this.db.list('coordinationRequests').filter(request => request.taskId === taskId || request.sourceMessageId === item.messageId)) {
            if (!request.currentRunId && ['queued', 'waiting_delivery'].includes(request.status)) {
              this.db.put('coordinationRequests', { ...request, status: 'cancelled', updatedAt: iso(this.#now()) });
            }
          }
        }
      }
      if (cancelled) this.db.put('scheduledOccurrences', { ...item, status: 'cancelled', cancelledAt: iso(this.#now()) });
    }
  }

  #project(projectId) {
    const project = this.db.get('projects', projectId);
    if (!project) throw new Error(tr('scheduledJobs.projectNotFound'));
    return project;
  }

  #job(projectId, id) {
    const job = this.db.get('scheduledJobs', id);
    if (!job || job.projectId !== projectId) throw new Error(tr('scheduledJobs.scheduledJobNotFound'));
    return job;
  }

  #role(projectId, roleId) {
    const role = this.db.get('roles', roleId);
    if (!role || role.projectId !== projectId || role.archivedAt) throw new Error(tr('scheduledJobs.scheduledJobRoleNotFound'));
    if (!role.enabled || role.configured === false) throw new Error(tr('scheduledJobs.scheduledJobRoleNotEnabled'));
    return role;
  }

  #now() {
    const value = this.clock();
    const date = value instanceof Date ? new Date(value) : new Date(value);
    if (Number.isNaN(date.getTime())) throw new Error(tr('scheduledJobs.clockReturnedInvalidTime'));
    return date;
  }
}
