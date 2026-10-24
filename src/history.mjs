import { createHash } from 'node:crypto';
import { tr } from './i18n.mjs';
import {conversationIdOf,resolveConversationId,assertConversationRecord} from './group-conversations.mjs';
import { isSupervisorName } from './default-roles.mjs';

const MAX_SEARCH_LIMIT = 100;
const MAX_READ_LIMIT = 20000;
const DEFAULT_SEARCH_LIMIT = 30;
const DEFAULT_READ_LIMIT = 4000;

function positiveLimit(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(tr('history.limitMustBeIntegerFrom', { maximum }));
  return value;
}

function offsetValue(value) {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(tr('history.offsetMustBeNonNegative'));
  return value;
}

function graphemes(text) {
  return [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(String(text || ''))].map(item => item.segment);
}

function clipped(text, maximum = 180) {
  const parts = graphemes(String(text || '').replace(/\s+/g, ' ').trim());
  return parts.length <= maximum ? parts.join('') : `${parts.slice(0, maximum).join('')}…`;
}

function versionOf(identity, content) {
  return createHash('sha256').update(identity).update('\0').update(content).digest('hex');
}

function encodeCursor(item) {
  return Buffer.from(JSON.stringify([item.createdAt, item.source, item.id]), 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(value) || value.length !== 3 || value.some(part => typeof part !== 'string')) throw new Error();
    return value;
  } catch {
    throw new Error(tr('history.invalidCursor'));
  }
}

function compareKey(a, b) {
  return b.createdAt.localeCompare(a.createdAt) || b.source.localeCompare(a.source) || b.id.localeCompare(a.id);
}

function isAfterCursor(item, cursor) {
  if (!cursor) return true;
  return compareKey(item, { createdAt: cursor[0], source: cursor[1], id: cursor[2] }) > 0;
}

const HUMAN_NAMES = new Set(['user', 'human', 'me', '\u6211', '\u7528\u6237', '\u7528\u6236']);
const lower = value => String(value || '').trim().toLocaleLowerCase('zh');

/** Optional search scopes, checked before paging: who said or did it (role names or ids, the supervisor by either default name,
 *  "me"/"user" for the human), a file it names, and a time window (ISO times; the wb CLI turns 2h / 3d / today / a date into these).
 *  An unknown role is an error, never an empty result. */
function searchScope(db, projectId, { role, file, since, until } = {}) {
  const names = role === undefined || role === null || role === '' ? [] : [].concat(role);
  if (names.length > 8 || names.some(name => typeof name !== 'string' || !name.trim() || name.length > 64)) throw new Error(tr('history.invalidRoleScope'));
  const project = db.get('projects', projectId), roles = db.list('roles').filter(r => r.projectId === projectId);
  const ids = new Set(), labels = [];
  let human = false;
  for (const raw of names) {
    const name = raw.trim();
    if (HUMAN_NAMES.has(lower(name))) { human = true; labels.push(name); continue; }
    const match = roles.find(r => r.id === name) || roles.find(r => lower(r.name) === lower(name))
      || (isSupervisorName(name) && project?.supervisorRoleId ? roles.find(r => r.id === project.supervisorRoleId) : null);
    if (!match) throw new Error(tr('history.roleNotFound', { name }));
    ids.add(match.id); labels.push(match.name);
  }
  if (file !== undefined && file !== null && file !== '' && (typeof file !== 'string' || file.length > 500)) throw new Error(tr('history.invalidFileScope'));
  const path = typeof file === 'string' ? file.trim().replace(/^\.\//, '') : '';
  const time = (value, label) => {
    if (value === undefined || value === null || value === '') return null;
    const ms = typeof value === 'string' ? Date.parse(value) : NaN;
    if (!Number.isFinite(ms)) throw new Error(tr('history.invalidTimeScope', { label }));
    return ms;
  };
  const from = time(since, 'since'), to = time(until, 'until');
  if (from !== null && to !== null && from > to) throw new Error(tr('history.timeScopeReversed'));
  const roleOf = id => roles.find(r => r.id === id) || null;
  return {
    names: names.length ? { ids, human, labels } : null, path, from, to, roleOf,
    applied: { ...(labels.length ? { roles: labels } : {}), ...(path ? { file: path } : {}), ...(from !== null ? { since: new Date(from).toISOString() } : {}), ...(to !== null ? { until: new Date(to).toISOString() } : {}) },
    when: value => { const ms = Date.parse(value || ''); return (from === null || ms >= from) && (to === null || ms <= to); },
    mentions: text => !path || String(text || '').includes(path)
  };
}

/** Read-only view of Home history; it reads only records, not events that contain tool process output. */
export class History {
  constructor(db) { this.db = db; }

  search(projectId, { query = '', cursor = null, limit, conversationId, role, file, since, until } = {}) {
    conversationId=resolveConversationId(this.db,projectId,conversationId);
    if (!this.db.get('projects', projectId)) throw new Error(tr('history.projectNotFound'));
    if (typeof query !== 'string') throw new Error(tr('history.queryMustBeString'));
    if (query.length > 1000) throw new Error(tr('history.queryMustBeAtMost'));
    const pageLimit = positiveLimit(limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
    const after = decodeCursor(cursor);
    if(after){
      const kind={message:'roomMessages',run:'runs',request:'coordinationRequests'}[after[1]];
      assertConversationRecord({projectId,conversationId},kind?this.db.get(kind,after[2]):null);
    }
    const needle = query.trim().toLocaleLowerCase('zh');
    const includes = value => !needle || String(value || '').toLocaleLowerCase('zh').includes(needle);
    const scope = searchScope(this.db, projectId, { role, file, since, until });
    const byRole = (...roleIds) => !scope.names || roleIds.some(id => id && scope.names.ids.has(id));
    const named = id => scope.roleOf(id)?.name || null;
    const items = [];

    for (const message of this.db.list('roomMessages')) {
      if (message.projectId !== projectId || conversationIdOf(message)!==conversationId || !includes(message.text) || !scope.mentions(message.text)) continue;
      const agentRole = message.roleId || (message.sender === 'agent' ? scope.names && [...scope.names.ids].find(id => named(id) === message.senderName) : null);
      if (scope.names && !(message.sender === 'human' && scope.names.human) && !byRole(agentRole)) continue;
      items.push({ id: message.id, projectId, kind: 'message', messageId: message.id, runId: message.runId || null,
        ...(message.roleId ? { roleId: message.roleId } : {}), author: message.senderName || message.sender || null,
        summary: clipped(message.text), source: 'message', createdAt: message.createdAt || '' });
    }
    for (const run of this.db.list('runs')) {
      const content = run.result || run.error || '';
      if (run.projectId !== projectId || conversationIdOf(run)!==conversationId || !content || !includes(content) || !byRole(run.roleId)) continue;
      // A file counts when the result names it or the role's report attached it.
      if (scope.path && !scope.mentions(content) && !(this.db.get('runReports', run.id)?.files || []).some(f => String(f.path || '').includes(scope.path))) continue;
      items.push({ id: run.id, projectId, kind: 'result', messageId: null, runId: run.id, requestId: run.requestId || null,
        ...(run.roleId ? { roleId: run.roleId, author: run.roleSnapshot?.name || named(run.roleId) } : {}),
        summary: clipped(content), source: 'run', createdAt: run.updatedAt || run.createdAt || '' });
    }
    for (const request of this.db.list('coordinationRequests')) {
      const searchable = [request.summary, request.result].filter(Boolean).join('\n');
      if (request.projectId !== projectId || conversationIdOf(request)!==conversationId || !searchable || !includes(searchable) || !scope.mentions(searchable)) continue;
      // A call involves two roles: the one it was sent to and the one whose run sent it.
      const sourceRole = request.sourceRunId ? this.db.get('runs', request.sourceRunId)?.roleId : null;
      if (!byRole(request.targetRoleId, sourceRole)) continue;
      items.push({ id: request.id, projectId, kind: 'result', messageId: request.sourceMessageId || null,
        runId: request.currentRunId || null, requestId: request.id,
        ...(request.targetRoleId ? { roleId: request.targetRoleId, author: named(request.targetRoleId) } : {}),
        summary: clipped(searchable), source: 'request', createdAt: request.updatedAt || request.createdAt || '' });
    }

    const remaining = items.filter(item => scope.when(item.createdAt)).sort(compareKey).filter(item => isAfterCursor(item, after));
    const page = remaining.slice(0, pageLimit);
    return { ...(Object.keys(scope.applied).length ? { scope: scope.applied } : {}), items: page, nextCursor: remaining.length > page.length && page.length ? encodeCursor(page.at(-1)) : null };
  }

  read(projectId, { kind, id, offset, limit, version, conversationId } = {}) {
    conversationId=resolveConversationId(this.db,projectId,conversationId);
    if (!this.db.get('projects', projectId)) throw new Error(tr('history.projectNotFound2'));
    if (!['message', 'result', 'auto'].includes(kind)) throw new Error(tr('history.kindMustBeMessageResult'));
    if (typeof id !== 'string' || !id) throw new Error(tr('history.idRequired'));
    // One read command for both: a stored message ID reads the message, anything else a run or call result.
    if (kind === 'auto') kind = this.db.get('roomMessages', id)?.projectId === projectId ? 'message' : 'result';
    const start = offsetValue(offset);
    const pageLimit = positiveLimit(limit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
    if (start && !version) throw new Error(tr('history.versionRequiredWhenOffsetGreater'));
    const resolved = kind === 'message' ? this.#message(projectId, id, conversationId) : this.#result(projectId, id, conversationId);
    const content = String(resolved.content || '');
    const currentVersion = versionOf(`${kind}:${resolved.identity}`, content);
    if (version && version !== currentVersion) throw new Error(tr('history.sourceTextVersionHasChanged'));
    const parts = graphemes(content);
    const end = Math.min(parts.length, start + pageLimit);
    return { kind, id, messageId: resolved.messageId || null, runId: resolved.runId || null,
      requestId: resolved.requestId || null, content: parts.slice(start, end).join(''), totalLength: parts.length,
      nextOffset: end < parts.length ? end : null, complete: end >= parts.length, version: currentVersion };
  }

  #message(projectId, id, conversationId) {
    const message = this.db.get('roomMessages', id);
    assertConversationRecord({projectId,conversationId},message);
    if (!message || message.projectId !== projectId) throw new Error(tr('history.contentDoesNotExistDoes'));
    return { identity: message.id, messageId: message.id, runId: message.runId || null, content: message.text || '' };
  }

  #result(projectId, id, conversationId) {
    let run = this.db.get('runs', id), request = this.db.get('coordinationRequests', id);
    const check=record=>record&&assertConversationRecord({projectId,conversationId},record);
    check(run);check(request);
    if (run && run.projectId !== projectId || request && request.projectId !== projectId) throw new Error(tr('history.contentDoesNotExistDoes2'));
    // An explicit Run is an immutable historical reference; only a request ID means reading the final result of the whole continuation chain.
    if (run) return { identity: run.id, requestId: run.requestId || null, runId: run.id, content: run.result ?? run.error ?? '' };
    if (!run && request?.currentRunId) run = this.db.get('runs', request.currentRunId);
    check(run);
    if (!run && !request) throw new Error(tr('history.contentDoesNotExistDoes3'));
    if ((run && run.projectId !== projectId) || (request && request.projectId !== projectId)) throw new Error(tr('history.contentDoesNotExistDoes4'));

    const seen = new Set();
    while (request?.continuationRequestId) {
      if (seen.has(request.id) || seen.size >= 20) throw new Error(tr('history.invalidContinuationChain'));
      seen.add(request.id);
      const next = this.db.get('coordinationRequests', request.continuationRequestId);
      check(next);
      if (!next || next.projectId !== projectId) throw new Error(tr('history.contentDoesNotExistDoes5'));
      request = next;
    }
    if (request?.currentRunId) {
      const finalRun = this.db.get('runs', request.currentRunId);
      check(finalRun);
      if (finalRun) {
        if (finalRun.projectId !== projectId) throw new Error(tr('history.contentDoesNotExistDoes6'));
        run = finalRun;
      }
    }
    const content = request?.result ?? run?.result ?? run?.error ?? '';
    return { identity: `${request?.id || ''}:${run?.id || ''}`, requestId: request?.id || run?.requestId || null,
      runId: run?.id || request?.currentRunId || null, content };
  }
}
