import { createHash } from 'node:crypto';
import { tr } from './i18n.mjs';

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

/** Read-only view of Home history; it reads only records, not events that contain tool process output. */
export class History {
  constructor(db) { this.db = db; }

  search(projectId, { query = '', cursor = null, limit } = {}) {
    if (!this.db.get('projects', projectId)) throw new Error(tr('history.projectNotFound'));
    if (typeof query !== 'string') throw new Error(tr('history.queryMustBeString'));
    if (query.length > 1000) throw new Error(tr('history.queryMustBeAtMost'));
    const pageLimit = positiveLimit(limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
    const after = decodeCursor(cursor);
    const needle = query.trim().toLocaleLowerCase('zh');
    const includes = value => !needle || String(value || '').toLocaleLowerCase('zh').includes(needle);
    const items = [];

    for (const message of this.db.list('roomMessages')) {
      if (message.projectId !== projectId || !includes(message.text)) continue;
      items.push({ id: message.id, projectId, kind: 'message', messageId: message.id, runId: message.runId || null,
        summary: clipped(message.text), source: 'message', createdAt: message.createdAt || '' });
    }
    for (const run of this.db.list('runs')) {
      const content = run.result || run.error || '';
      if (run.projectId !== projectId || !content || !includes(content)) continue;
      items.push({ id: run.id, projectId, kind: 'result', messageId: null, runId: run.id, requestId: run.requestId || null,
        summary: clipped(content), source: 'run', createdAt: run.updatedAt || run.createdAt || '' });
    }
    for (const request of this.db.list('coordinationRequests')) {
      const searchable = [request.summary, request.result].filter(Boolean).join('\n');
      if (request.projectId !== projectId || !searchable || !includes(searchable)) continue;
      items.push({ id: request.id, projectId, kind: 'result', messageId: request.sourceMessageId || null,
        runId: request.currentRunId || null, requestId: request.id, summary: clipped(searchable), source: 'request',
        createdAt: request.updatedAt || request.createdAt || '' });
    }

    const remaining = items.sort(compareKey).filter(item => isAfterCursor(item, after));
    const page = remaining.slice(0, pageLimit);
    return { items: page, nextCursor: remaining.length > page.length && page.length ? encodeCursor(page.at(-1)) : null };
  }

  read(projectId, { kind, id, offset, limit, version } = {}) {
    if (!this.db.get('projects', projectId)) throw new Error(tr('history.projectNotFound2'));
    if (!['message', 'result'].includes(kind)) throw new Error(tr('history.kindMustBeMessageResult'));
    if (typeof id !== 'string' || !id) throw new Error(tr('history.idRequired'));
    const start = offsetValue(offset);
    const pageLimit = positiveLimit(limit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
    if (start && !version) throw new Error(tr('history.versionRequiredWhenOffsetGreater'));
    const resolved = kind === 'message' ? this.#message(projectId, id) : this.#result(projectId, id);
    const content = String(resolved.content || '');
    const currentVersion = versionOf(`${kind}:${resolved.identity}`, content);
    if (version && version !== currentVersion) throw new Error(tr('history.sourceTextVersionHasChanged'));
    const parts = graphemes(content);
    const end = Math.min(parts.length, start + pageLimit);
    return { kind, id, messageId: resolved.messageId || null, runId: resolved.runId || null,
      requestId: resolved.requestId || null, content: parts.slice(start, end).join(''), totalLength: parts.length,
      nextOffset: end < parts.length ? end : null, complete: end >= parts.length, version: currentVersion };
  }

  #message(projectId, id) {
    const message = this.db.get('roomMessages', id);
    if (!message || message.projectId !== projectId) throw new Error(tr('history.contentDoesNotExistDoes'));
    return { identity: message.id, messageId: message.id, runId: message.runId || null, content: message.text || '' };
  }

  #result(projectId, id) {
    let run = this.db.get('runs', id), request = this.db.get('coordinationRequests', id);
    if (run && run.projectId !== projectId || request && request.projectId !== projectId) throw new Error(tr('history.contentDoesNotExistDoes2'));
    // An explicit Run is an immutable historical reference; only a request ID means reading the final result of the whole continuation chain.
    if (run) return { identity: run.id, requestId: run.requestId || null, runId: run.id, content: run.result ?? run.error ?? '' };
    if (!run && request?.currentRunId) run = this.db.get('runs', request.currentRunId);
    if (!run && !request) throw new Error(tr('history.contentDoesNotExistDoes3'));
    if ((run && run.projectId !== projectId) || (request && request.projectId !== projectId)) throw new Error(tr('history.contentDoesNotExistDoes4'));

    const seen = new Set();
    while (request?.continuationRequestId) {
      if (seen.has(request.id) || seen.size >= 20) throw new Error(tr('history.invalidContinuationChain'));
      seen.add(request.id);
      const next = this.db.get('coordinationRequests', request.continuationRequestId);
      if (!next || next.projectId !== projectId) throw new Error(tr('history.contentDoesNotExistDoes5'));
      request = next;
    }
    if (request?.currentRunId) {
      const finalRun = this.db.get('runs', request.currentRunId);
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
