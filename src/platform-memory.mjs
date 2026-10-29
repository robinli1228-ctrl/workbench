import { randomUUID, createHash } from 'node:crypto';
import { tr, isMessage } from './i18n.mjs';
import OpenCC from 'opencc-js';
import { executionText } from './input-language.mjs';

/**
 * Platform memory: one set of short durable facts for the whole platform, shared by every project, role, CLI and device.
 * It keeps what helps beyond one project (environment, accounts, lessons, procedures, people); a project's own decisions
 * stay in its chat history. Roles only search it (wb memory search); nothing is added to their prompts. A separately
 * configured organizer model extracts and merges entries from all group chats in the background. Each chat keeps a
 * watermark in Home receipt order that moves only after a batch is saved, so every message is organized once.
 */
export const MEMORY_TYPES = ['decision', 'environment', 'credential', 'lesson', 'procedure', 'personal', 'other'];
export const MEMORY_RUNTIMES = ['claude', 'codex', 'grok', 'agy'];
// The prompt travels as one command-line argument (Linux caps one at 128 KiB), so the budgets are in UTF-8 bytes.
const CONTENT_LIMIT = 800, CREDENTIAL_LIMIT = 4000, MESSAGE_LIMIT = 4000, BATCH_BYTES = 60000, BATCH_MESSAGES = 60, KNOWN_LIMIT = 40, KNOWN_BYTES = 24000, AGENTS_BYTES = 18000, PROMPT_BYTES = 120000;
const bytes = text => Buffer.byteLength(String(text || ''));
// Duplicate check: groups of look-alike entries, a few per model call; signatures of groups already judged are kept this long.
const GROUP_SIZE = 12, GROUPS_PER_CALL = 20, COMMON_LIMIT = 50, CHECKED_LIMIT = 20000;
const PAGE_LIMIT = 100, RETRY_MINUTES = [10, 30, 60, 180, 360];
const retryAfter = (failures, time) => new Date(time.getTime() + RETRY_MINUTES[Math.min(failures, RETRY_MINUTES.length) - 1] * 60000).toISOString();
// Losing the device slot to real work (or finding it taken) is a wait, not a failure.
const yielded = error => ['conversationOrganizer.conversationOrganizingYieldedWorkTask', 'worker.organizerDeviceCurrentlyHasNo'].some(key => isMessage(error?.message, key));
// Keys and tokens must stay whole, so accounts and secrets get a longer limit than other entries.
const limitFor = type => type === 'credential' ? CREDENTIAL_LIMIT : CONTENT_LIMIT;
/** The local calendar day and minute of the day in a time zone (Home's own when none is saved). */
// Home checks the daily time every second, so each zone's formatter is made once.
const clocks = new Map();
function localClock(time, timeZone) {
  let parts;
  try {
    if (!clocks.has(timeZone || '')) clocks.set(timeZone || '', new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || undefined, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
    parts = Object.fromEntries(clocks.get(timeZone || '').formatToParts(time).map(part => [part.type, part.value]));
  } catch { return localClock(time, null); }
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}
const clip = (text, limit) => { const value = String(text || ''); return value.length > limit ? `${value.slice(0, limit)}…` : value; };
const clipBytes = (text, limit) => { let value = String(text || ''); while (bytes(value) > limit) value = value.slice(0, Math.floor(value.length * 0.9)); return value; };

// Entries and searches mix Traditional and Simplified; both are compared in Simplified.
const simplified = OpenCC.Converter({ from: 't', to: 'cn' });

/** English words, numbers and paths whole and in parts; Han text as overlapping character pairs (single characters alone). */
export function memoryTerms(text) {
  const value = simplified(String(text || '').toLowerCase()), terms = [];
  for (const word of value.match(/[\p{L}\p{N}_./:@-]+/gu) || []) {
    for (const run of word.split(/(\p{Script=Han}+)/u).filter(Boolean)) {
      if (/\p{Script=Han}/u.test(run)) {
        const chars = [...run];
        if (chars.length === 1) terms.push(chars[0]);
        for (let i = 0; i + 1 < chars.length; i++) terms.push(chars[i] + chars[i + 1]);
      } else {
        const trimmed = run.replace(/^[./:@-]+|[./:@-]+$/g, '');
        if (!trimmed) continue;
        terms.push(trimmed);
        const parts = trimmed.split(/[./:@_-]+/).filter(part => part && part !== trimmed);
        terms.push(...parts);
      }
    }
  }
  return terms;
}

const entryText = entry => [entry.content, tr(`platformMemory.type.${entry.type}`), entry.runtime || '', entry.deviceName || ''].join(' ');

/** BM25 over the given entries; returns [entry, score] with score > 0, best first. `termsOf` may supply cached terms. */
export function rankMemories(entries, query, termsOf = entry => memoryTerms(entryText(entry))) {
  const wanted = [...new Set(memoryTerms(query))];
  if (!wanted.length) return [];
  const docs = entries.map(entry => { const terms = termsOf(entry), tf = new Map(); for (const term of terms) tf.set(term, (tf.get(term) || 0) + 1); return { entry, tf, length: terms.length }; });
  const average = docs.reduce((sum, doc) => sum + doc.length, 0) / (docs.length || 1) || 1;
  const df = new Map(wanted.map(term => [term, docs.filter(doc => doc.tf.has(term)).length]));
  const k1 = 1.2, b = 0.75;
  return docs.map(doc => {
    let score = 0;
    for (const term of wanted) {
      const f = doc.tf.get(term); if (!f) continue;
      const idf = Math.log(1 + (docs.length - df.get(term) + 0.5) / (df.get(term) + 0.5));
      score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * doc.length / average));
    }
    return [doc.entry, score];
  }).filter(([, score]) => score > 0).sort((x, y) => y[1] - x[1]);
}

function sinceValue(value) {
  if (value === undefined || value === null || value === '') return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(tr('platformMemory.searchUsage'));
  return ms;
}

export class PlatformMemory {
  constructor(db, { clock = () => new Date() } = {}) { this.db = db; this.clock = clock; }

  #chatName(projectId, conversationId) { return conversationId === projectId ? this.db.get('projects', projectId)?.name || null : this.db.get('groupConversations', conversationId)?.title || null; }
  #deviceName(nodeId) { return nodeId ? this.db.get('workers', nodeId)?.name || nodeId : ''; }
  /** Device and project names for a whole pass, read once instead of per entry. */
  #names() {
    const devices = new Map(this.db.list('workers').map(worker => [worker.id, worker.name || worker.id])), projects = new Map(this.db.list('projects').map(project => [project.id, project.name]));
    return { device: id => id ? devices.get(id) || id : '', project: id => id ? projects.get(id) || '' : '' };
  }
  /**
   * Search terms and filter text of an entry, cached while the entry and the names it shows stay the same, so searching,
   * page filters, organizing and the duplicate check do not convert and split every entry again on each call.
   */
  #derived(entry, names) {
    const label = tr(`platformMemory.type.${entry.type}`), device = names.device(entry.nodeId), project = names.project(entry.sourceProjectId);
    const key = [entry.content, label, entry.runtime || '', device, project].join('\u0000');
    this.derivedCache ||= new Map();
    const hit = this.derivedCache.get(entry.id);
    if (hit?.key === key) return hit;
    const value = { key, terms: memoryTerms([entry.content, label, entry.runtime || '', device].join(' ')), contentTerms: new Set(memoryTerms(entry.content)),
      text: simplified([entry.content, label, entry.runtime || '', device, project].join(' ').toLowerCase()) };
    if (this.derivedCache.size > 20000) this.derivedCache.clear();
    this.derivedCache.set(entry.id, value);
    return value;
  }
  #view(entry) {
    return { id: entry.id, type: entry.type, content: entry.content, runtime: entry.runtime || null, nodeId: entry.nodeId || null, device: entry.nodeId ? this.#deviceName(entry.nodeId) : null,
      sourceProjectId: entry.sourceProjectId || null, sourceProject: entry.sourceProjectId ? this.db.get('projects', entry.sourceProjectId)?.name || null : null,
      status: entry.status || 'active', supersededBy: entry.supersededBy || null, edited: !!entry.edited, sourceMessageIds: entry.sourceMessageIds || [],
      createdAt: entry.createdAt, updatedAt: entry.updatedAt };
  }
  entries({ includeSuperseded = false } = {}) {
    return this.db.list('memories').filter(entry => includeSuperseded || entry.status !== 'superseded');
  }

  /** wb memory search: without words, all entries (or one type) newest first; with words, BM25 with a lift for the caller's project, CLI and device. */
  search(input = {}, caller = {}) {
    const limit = input.limit === undefined ? 20 : input.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error(tr('platformMemory.searchUsage'));
    if (input.type !== undefined && !MEMORY_TYPES.includes(input.type)) throw new Error(tr('platformMemory.unknownType', { types: MEMORY_TYPES.join(', ') }));
    if (input.cli !== undefined && !MEMORY_RUNTIMES.includes(input.cli)) throw new Error(tr('platformMemory.searchUsage'));
    const since = sinceValue(input.since);
    const device = typeof input.device === 'string' && input.device.trim() ? input.device.trim().toLowerCase() : null;
    const names = this.#names(), nodeMatches = nodeId => !!nodeId && (nodeId.toLowerCase() === device || names.device(nodeId).toLowerCase() === device);
    const candidates = this.entries().filter(entry => (!input.type || entry.type === input.type)
      && (!input.cli || !entry.runtime || entry.runtime === input.cli)
      && (!device || !entry.nodeId || nodeMatches(entry.nodeId))
      && (since === null || Date.parse(entry.updatedAt) >= since));
    const query = String(input.query || '').trim();
    let ranked;
    if (!query) ranked = candidates.sort((x, y) => String(y.updatedAt).localeCompare(String(x.updatedAt))).map(entry => [entry, 0]);
    else ranked = rankMemories(candidates, query, entry => this.#derived(entry, names).terms).map(([entry, score]) => {
      let lift = 1;
      if (caller.projectId && entry.sourceProjectId === caller.projectId) lift *= 1.1;
      if (caller.runtime && entry.runtime === caller.runtime) lift *= 1.15;
      if (caller.nodeId && entry.nodeId === caller.nodeId) lift *= 1.15;
      return [entry, score * lift];
    }).sort((x, y) => y[1] - x[1]);
    // Roles get the fields they act on; the settings page reads the full view through list().
    const brief = entry => { const view = this.#view(entry); return { id: view.id, type: view.type, content: view.content, ...(view.runtime ? { cli: view.runtime } : {}), ...(view.device ? { device: view.device } : {}), ...(view.sourceProject ? { project: view.sourceProject } : {}), updatedAt: view.updatedAt }; };
    return { total: ranked.length, items: ranked.slice(0, limit).map(([entry]) => brief(entry)),
      ...(ranked.length ? {} : { note: tr(query ? 'platformMemory.noMatch' : 'platformMemory.empty') }) };
  }

  /** Settings → Memory: one page, newest first, filtered by type and by words that must all appear (Traditional and Simplified alike). */
  list({ query = '', type = '', offset = 0, limit = 50 } = {}) {
    offset = Number(offset) || 0; limit = Number(limit) || 50;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_LIMIT) throw new Error(tr('platformMemory.pageUsage'));
    if (type && !MEMORY_TYPES.includes(type)) throw new Error(tr('platformMemory.unknownType', { types: MEMORY_TYPES.join(', ') }));
    const words = simplified(String(query || '').toLowerCase()).split(/\s+/).filter(Boolean), all = this.entries(), names = words.length ? this.#names() : null;
    const matching = all.filter(entry => (!type || entry.type === type) && (!words.length || (text => words.every(word => text.includes(word)))(this.#derived(entry, names).text)))
      .sort((x, y) => String(y.updatedAt).localeCompare(String(x.updatedAt)));
    return { items: matching.slice(offset, offset + limit).map(entry => this.#view(entry)), total: matching.length, all: all.length, offset, limit, progress: this.progress() };
  }

  #clean(input, previous) {
    const type = input.type ?? previous?.type, content = typeof input.content === 'string' ? input.content.trim() : previous?.content;
    if (!MEMORY_TYPES.includes(type)) throw new Error(tr('platformMemory.unknownType', { types: MEMORY_TYPES.join(', ') }));
    if (!content || content.length > limitFor(type)) throw new Error(tr('platformMemory.contentLength', { limit: limitFor(type) }));
    const runtime = input.runtime === undefined ? previous?.runtime || null : input.runtime || null;
    if (runtime && !MEMORY_RUNTIMES.includes(runtime)) throw new Error(tr('platformMemory.unknownRuntime'));
    const nodeId = input.nodeId === undefined ? previous?.nodeId || null : input.nodeId || null;
    if (nodeId && !this.db.get('workers', nodeId)) throw new Error(tr('platformMemory.unknownDevice'));
    return { type, content, runtime, nodeId };
  }

  /** People's edits mark the entry, so the organizer never rewrites or retires it. */
  save(input = {}) {
    const previous = input.id ? this.db.get('memories', input.id) : null;
    if (input.id && !previous) throw new Error(tr('platformMemory.entryNotFound'));
    const time = this.clock().toISOString();
    return this.#view(this.db.put('memories', { ...(previous || {}), id: previous?.id || randomUUID(), sourceProjectId: previous?.sourceProjectId || null, ...this.#clean(input, previous),
      status: 'active', supersededBy: null, edited: true, sourceMessageIds: previous?.sourceMessageIds || [], createdAt: previous?.createdAt || time, updatedAt: time, saidAt: time }));
  }

  remove(id) {
    if (!this.db.get('memories', id)) throw new Error(tr('platformMemory.entryNotFound'));
    this.db.remove('memories', id);
    return { id, deleted: true };
  }

  // Progress is still kept per project, because watermarks belong to each project's chats.
  #state(projectId) { return this.db.get('memoryProgress', projectId) || { id: projectId, projectId, conversations: {} }; }
  #conversations(projectId) {
    const chats = this.db.listProject('groupConversations', projectId);
    return [...new Set([projectId, ...chats.map(chat => chat.id)])];
  }

  /**
   * Receipts of a project's chats not organized yet, kept incrementally: each call reads only receipts newer than the last
   * one seen (through the project/seq index), and drops what the watermarks have passed. A fresh Home starts from the
   * lowest watermark of the project's chats.
   */
  #backlog(projectId) {
    this.backlogs ||= new Map();
    const state = this.#state(projectId), marks = state.conversations || {};
    let entry = this.backlogs.get(projectId);
    // Everything up to caughtUpSeq was organized when the project last finished, so a chat that never had a message
    // (watermark 0) does not send a fresh Home back through the whole history.
    if (!entry) { entry = { seq: Math.max(state.caughtUpSeq || 0, Math.min(...this.#conversations(projectId).map(id => marks[id]?.seq || 0))), chats: new Map() }; this.backlogs.set(projectId, entry); }
    for (const row of this.db.receiptsAfter(projectId, entry.seq)) {
      entry.seq = row.seq;
      if (row.summary || row.seq <= (marks[row.conversationId]?.seq || 0)) continue;
      if (!entry.chats.has(row.conversationId)) entry.chats.set(row.conversationId, []);
      entry.chats.get(row.conversationId).push(row.seq);
    }
    for (const [id, seqs] of entry.chats) { const mark = marks[id]?.seq || 0; if (seqs.length && seqs[0] <= mark) entry.chats.set(id, seqs.filter(seq => seq > mark)); }
    return entry.chats;
  }

  /** The whole platform: every project's chats, or one project's when an id is given (used while organizing). Nothing here reads old history. */
  progress(projectId = null) {
    const projects = projectId ? [this.db.get('projects', projectId)].filter(Boolean) : this.db.list('projects');
    const chats = new Map();
    for (const chat of projectId ? this.db.listProject('groupConversations', projectId) : this.db.list('groupConversations')) { if (!chats.has(chat.projectId)) chats.set(chat.projectId, []); chats.get(chat.projectId).push(chat.id); }
    const each = projects.map(project => {
      const state = this.#state(project.id), backlog = this.#backlog(project.id);
      const conversations = [...new Set([project.id, ...(chats.get(project.id) || [])])].map(conversationId => {
        const saved = state.conversations?.[conversationId] || {}, pending = backlog.get(conversationId)?.length || 0;
        return { conversationId, name: this.#chatName(project.id, conversationId), seq: saved.seq || 0, pending, organizedAt: saved.organizedAt || null,
          failures: saved.failures || 0, retryAt: saved.retryAt || null, lastError: saved.lastError || null };
      }).filter(item => item.seq > 0 || item.pending > 0);
      const waiting = [state.retryAt, ...conversations.map(item => item.retryAt)].filter(Boolean).sort()[0] || null;
      return { projectId: project.id, name: project.name, requestedAt: state.requestedAt || null, lastRunAt: state.lastRunAt || null, lastError: state.lastError || null, failedAt: state.failedAt || null,
        failures: state.failures || 0, retryAt: waiting, running: !!state.running, pending: conversations.reduce((sum, item) => sum + item.pending, 0), conversations };
    });
    if (projectId) { const { projectId: _, name, ...one } = each[0] || { requestedAt: null, lastRunAt: null, lastError: null, failedAt: null, failures: 0, retryAt: null, running: false, pending: 0, conversations: [] }; return one; }
    // The platform assistant's project counts too: devices, CLIs and accounts are set up there.
    const first = key => each.map(item => item[key]).filter(Boolean).sort()[0] || null, last = key => each.map(item => item[key]).filter(Boolean).sort().at(-1) || null;
    const failing = each.filter(item => item.lastError).sort((x, y) => String(y.failedAt).localeCompare(String(x.failedAt)))[0];
    const check = this.db.get('memoryProgress', '@consolidate') || {};
    return { checking: !!check.requestedAt, checkedAt: check.lastRunAt || null, requestedAt: first('requestedAt'), lastRunAt: last('lastRunAt'), lastError: failing?.lastError || check.lastError || null,
      errorRetryAt: failing ? failing.retryAt || null : check.lastError ? check.retryAt || null : null, retryAt: first('retryAt'), running: each.some(item => item.running) || !!check.running,
      // Projects with messages waiting but not asked for yet: "Organize now" stays available for them.
      unrequested: each.filter(item => item.pending && !item.requestedAt).length,
      pending: each.reduce((sum, item) => sum + item.pending, 0), projects: each.filter(item => item.pending || item.lastError).map(({ projectId, name, pending, lastError, retryAt }) => ({ projectId, name, pending, lastError, retryAt })) };
  }

  /** Ask for a run of one project, or of every project with unorganized messages; the background picks it up when the organizer device has room. */
  request(projectId = null, time = this.clock()) {
    if (!projectId) {
      for (const project of this.progress().projects) if (project.pending) this.#ask(project.projectId, time);
      // After the chats, every look-alike group not judged yet is checked for duplicates and conflicts.
      const check = this.db.get('memoryProgress', '@consolidate') || { id: '@consolidate' };
      this.db.put('memoryProgress', { ...check, requestedAt: check.requestedAt || time.toISOString(), retryAt: null });
      return this.progress();
    }
    if (!this.db.get('projects', projectId)) throw new Error(tr('platformMemory.projectNotFound'));
    this.#ask(projectId, time);
    return this.progress(projectId);
  }
  #ask(projectId, time) {
    const state = this.#state(projectId);
    // Asking again also lifts a chat's back-off, so a fixed cause can be tried at once.
    const conversations = Object.fromEntries(Object.entries(state.conversations || {}).map(([id, chat]) => [id, { ...chat, retryAt: null }]));
    this.db.put('memoryProgress', { ...state, conversations, requestedAt: state.requestedAt || time.toISOString(), retryAt: null });
  }

  /** The daily run: once per local day after the configured time, every project with unorganized messages is requested. */
  schedule(config, time = this.clock()) {
    if (!config?.nodeId || config.enabled === false) return false;
    const [hour, minute] = String(config.time || '03:00').split(':').map(Number);
    const { day, minute: now } = localClock(time, config.timezone);
    const marker = this.db.get('memoryProgress', '@schedule');
    if (marker?.day === day || now < hour * 60 + minute) return false;
    this.request(null, time);
    this.db.put('memoryProgress', { id: '@schedule', day, at: time.toISOString() });
    return true;
  }

  /** "Only from now on": every chat continues from its current last message, so nothing said before is sent. */
  skipHistory() {
    for (const project of this.db.list('projects')) {
      const state = this.#state(project.id), conversations = { ...(state.conversations || {}) };
      // A chat's messages all sit at or below the project's newest receipt, so that one number serves every chat.
      const seq = this.db.projectReceiptCursor(project.id);
      for (const conversationId of this.#conversations(project.id)) conversations[conversationId] = { seq, organizedAt: null, skipped: true };
      this.db.put('memoryProgress', { ...state, conversations, caughtUpSeq: seq });
      this.backlogs?.delete(project.id);
    }
  }

  recover() {
    for (const state of this.db.list('memoryProgress').filter(item => item.running)) this.db.put('memoryProgress', { ...state, running: false });
  }

  /**
   * The next batch for this project: the first chat with messages past its watermark whose own retry time has come, up to
   * the batch budget (measured as serialized JSON). A chat that keeps failing gets smaller batches, down to one message, so
   * a single hard message cannot hold the rest back for long, and other chats go on meanwhile.
   */
  batch(projectId, time = this.clock()) {
    const state = this.#state(projectId);
    const backlog = this.#backlog(projectId);
    for (const conversationId of this.#conversations(projectId)) {
      const saved = state.conversations?.[conversationId] || {}, after = saved.seq || 0;
      if (!backlog.get(conversationId)?.length) continue;
      if (saved.retryAt && Date.parse(saved.retryAt) > time.getTime()) continue;
      const shrink = 2 ** Math.min(saved.failures || 0, 6), maxMessages = Math.max(1, Math.floor(BATCH_MESSAGES / shrink)), maxBytes = Math.floor(BATCH_BYTES / shrink);
      const messages = [], seqs = [];let size = 0, throughSeq = after;
      for (const message of this.db.messageArrivals(projectId, after, conversationId)) {
        if (message.kind === 'summary') { if (!messages.length || size < maxBytes) throughSeq = message.receiptSeq; continue; }
        const role = message.roleId ? this.db.get('roles', message.roleId) : null;
        const item = { id: message.id, time: message.createdAt, author: message.senderName || role?.name || message.sender || '', ...(role ? { cli: role.runtime || null, device: this.#deviceName(role.nodeId) || null } : {}), text: clip(message.text, MESSAGE_LIMIT) };
        const itemBytes = bytes(JSON.stringify(item));
        if (messages.length >= maxMessages || (messages.length && size + itemBytes > maxBytes)) break;
        size += itemBytes; throughSeq = message.receiptSeq;
        messages.push(item); seqs.push(message.receiptSeq);
      }
      // Receipts whose messages are gone (deleted since) leave nothing to read: count the project again from its watermarks.
      if (!messages.length && throughSeq === after) { this.backlogs.delete(projectId); continue; }
      return { projectId, conversationId, conversation: this.#chatName(projectId, conversationId), afterSeq: after, throughSeq, messages, seqs };
    }
    return null;
  }

  /** Entries the organizer sees: the ones closest to this batch, so it can merge instead of repeating them. */
  known(batch) {
    const names = this.#names(), entries = this.entries().map(entry => ({ ...entry, deviceName: names.device(entry.nodeId) }));
    const ranked = rankMemories(entries, batch.messages.map(message => message.text).join('\n'), entry => this.#derived(entry, names).terms).map(([entry]) => entry);
    const picked = [...ranked, ...entries.filter(entry => !ranked.includes(entry)).sort((x, y) => String(y.updatedAt).localeCompare(String(x.updatedAt)))];
    const out = [];let chars = 0;
    for (const entry of picked) {
      if (out.length >= KNOWN_LIMIT || chars + bytes(entry.content) > KNOWN_BYTES) break;
      chars += bytes(entry.content);
      out.push({ id: entry.id, type: entry.type, content: entry.content, cli: entry.runtime || null, device: entry.deviceName || null, project: names.project(entry.sourceProjectId) || null,
        edited: !!entry.edited, said: entry.saidAt || entry.updatedAt, updatedAt: entry.updatedAt });
    }
    return out;
  }

  prompt(batch, known, agentsMd) {
    const devices = this.db.list('workers').map(worker => worker.name).filter(Boolean);
    known = [...known];let agents = agentsMd ? clipBytes(agentsMd, AGENTS_BYTES) : null;
    const build = () => executionText('platformMemory.organizerPrompt', { input: JSON.stringify({ types: MEMORY_TYPES, clis: MEMORY_RUNTIMES, devices, project: this.db.get('projects', batch.projectId)?.name || null, chat: batch.conversation, agentsMd: agents, known, messages: batch.messages }) });
    let prompt = build();
    // JSON escaping can push a full batch past the argument limit; drop context before any message.
    while (bytes(prompt) > PROMPT_BYTES && known.length) { known.pop(); prompt = build(); }
    if (bytes(prompt) > PROMPT_BYTES && agents) { agents = null; prompt = build(); }
    // Still too long: leave the last messages for the next batch (the watermark then stops before them).
    while (bytes(prompt) > PROMPT_BYTES && batch.messages.length > 1) { batch.messages.pop(); batch.seqs?.pop(); batch.throughSeq = batch.seqs?.at(-1) ?? batch.throughSeq; prompt = build(); }
    // The answer may only change entries the model was shown, and only as it saw them (see accept).
    batch.seen = Object.fromEntries(known.map(entry => [entry.id, entry.updatedAt]));
    return prompt;
  }

  /**
   * Validate the organizer's answer, apply it and move the watermark in one transaction. A wrong shape rejects the batch;
   * a single malformed item (an unknown type, empty text) is dropped so one slip cannot block the chat.
   */
  accept(batch, output, time = this.clock()) {
    if (!output || typeof output !== 'object') throw new Error(tr('platformMemory.invalidResult'));
    const add = output.add ?? [], update = output.update ?? [], supersede = output.supersede ?? [];
    if (![add, update, supersede].every(Array.isArray)) throw new Error(tr('platformMemory.invalidResult'));
    const deviceId = name => { if (!name) return null; const worker = this.db.list('workers').find(item => item.name === name || item.id === name); return worker?.id || null; };
    const fields = item => {
      if (!item || typeof item !== 'object' || !MEMORY_TYPES.includes(item.type) || typeof item.content !== 'string' || !item.content.trim()) return null;
      // Too long is dropped, never cut: a clipped key or token would be wrong, not just short.
      if (item.content.trim().length > limitFor(item.type)) return null;
      return { type: item.type, content: item.content.trim(), runtime: MEMORY_RUNTIMES.includes(item.cli) ? item.cli : null, nodeId: deviceId(item.device) };
    };
    const sources = item => (Array.isArray(item.sources) ? item.sources : []).filter(id => batch.messages.some(message => message.id === id)).slice(0, 10);
    // When the fact was said: its newest source message, else the batch's last message.
    const saidAt = item => sources(item).map(id => batch.messages.find(message => message.id === id)?.time).filter(Boolean).sort().at(-1) || batch.messages.at(-1)?.time || time.toISOString();
    const iso = time.toISOString();
    return this.db.transaction(() => {
      // A project deleted while the model ran keeps nothing, including secrets from its messages.
      if (!this.db.get('projects', batch.projectId)) throw new Error(tr('platformMemory.projectNotFound'));
      const state = this.#state(batch.projectId);
      if ((state.conversations?.[batch.conversationId]?.seq || 0) !== batch.afterSeq) throw new Error(tr('platformMemory.staleBatch'));
      // An entry changed since the model saw it (a person's edit meanwhile) is left as it now is.
      const owned = id => { const entry = (typeof id === 'string' && this.db.get('memories', id)) || null; return entry && (!batch.seen || batch.seen[id] === entry.updatedAt) ? entry : null; };
      let added = 0, updated = 0, retired = 0;
      for (const item of add.slice(0, 30)) {
        const value = fields(item);
        if (!value) continue;
        this.db.put('memories', { id: randomUUID(), sourceProjectId: batch.projectId, ...value, status: 'active', supersededBy: null, edited: false, sourceMessageIds: sources(item), createdAt: iso, updatedAt: iso, saidAt: saidAt(item) });
        added++;
      }
      for (const item of update.slice(0, 30)) {
        const entry = owned(item?.id);
        if (!entry || entry.status === 'superseded') continue; // a person's entry is corrected in place too, never copied; retired entries stay retired
        const next = fields({ type: item.type ?? entry.type, content: item.content ?? entry.content, cli: item.cli === undefined ? entry.runtime : item.cli, device: item.device === undefined ? entry.nodeId : item.device });
        if (!next) continue;
        this.db.put('memories', { ...entry, ...next, status: 'active', sourceMessageIds: [...new Set([...(entry.sourceMessageIds || []), ...sources(item)])].slice(-20), updatedAt: iso, saidAt: saidAt(item) });
        updated++;
      }
      for (const item of supersede.slice(0, 30)) {
        const entry = owned(typeof item === 'string' ? item : item?.id);
        if (!entry || entry.status === 'superseded') continue;
        const by = owned(item?.by);
        this.db.put('memories', { ...entry, status: 'superseded', supersededBy: by && by.id !== entry.id ? by.id : null, updatedAt: iso });
        retired++;
      }
      const conversations = { ...(state.conversations || {}), [batch.conversationId]: { seq: batch.throughSeq, organizedAt: iso } };
      const stillFailing = Object.values(conversations).some(item => item.failures);
      this.db.put('memoryProgress', { ...state, conversations, ...(stillFailing ? {} : { lastError: null, failures: 0 }), retryAt: null });
      return { added, updated, retired };
    });
  }

  /** A failed batch backs off for its own chat only; the watermark stays, so the same messages are tried again later. */
  fail(projectId, conversationId, error, time = this.clock()) {
    if (!this.db.get('projects', projectId)) return;
    const state = this.#state(projectId), chat = state.conversations?.[conversationId] || {}, failures = (chat.failures || 0) + 1;
    const lastError = String(error?.message || error || '').slice(0, 500), retryAt = retryAfter(failures, time);
    this.db.put('memoryProgress', { ...state, running: false, failures: (state.failures || 0) + 1, lastError, failedAt: time.toISOString(),
      conversations: { ...(state.conversations || {}), [conversationId]: { ...chat, failures, retryAt, lastError } } });
  }

  /** Not a failure: try this project again shortly without counting it. */
  #later(projectId, ms) {
    if (!this.db.get('projects', projectId)) return;
    this.db.put('memoryProgress', { ...this.#state(projectId), running: false, retryAt: new Date(this.clock().getTime() + ms).toISOString() });
  }

  /**
   * One batch at a time across all projects. A requested project runs batch after batch until every chat is caught up;
   * a failure keeps the request and retries later with backoff, so no message is skipped.
   */
  async drainOne({ config, canRun, query, agentsMd = async () => null, change = () => {} }) {
    if (this.processing || !config?.nodeId || !canRun(config.nodeId)) return null;
    const time = this.clock();
    const due = item => item.requestedAt && (!item.retryAt || Date.parse(item.retryAt) <= time.getTime());
    const state = this.db.requestedMemoryProgress().filter(item => !item.id.startsWith('@') && due(item))
      .sort((x, y) => String(x.requestedAt).localeCompare(String(y.requestedAt)))[0];
    if (!state) {
      // Chats first; the duplicate check runs when no project is ready (one still backing off does not hold it up).
      const check = this.db.get('memoryProgress', '@consolidate');
      return check && due(check) ? this.#consolidate(check, { config, canRun, query, change }) : null;
    }
    if (!this.db.get('projects', state.projectId)) { this.db.remove('memoryProgress', state.id); return null; }
    const batch = this.batch(state.projectId, time);
    if (!batch) {
      // Chats still waiting out a back-off keep the request; it resumes at the earliest retry time.
      const waiting = this.progress(state.projectId).conversations.filter(item => item.pending && item.retryAt).map(item => item.retryAt).sort()[0];
      this.db.put('memoryProgress', waiting ? { ...state, running: false, retryAt: waiting } : { ...state, requestedAt: null, running: false, retryAt: null, lastRunAt: time.toISOString(), caughtUpSeq: this.backlogs?.get(state.projectId)?.seq || state.caughtUpSeq || 0 });
      change(); return waiting ? { waiting } : { done: true };
    }
    this.processing = true;
    this.db.put('memoryProgress', { ...state, running: true, retryAt: null });change();
    try {
      let result = { added: 0, updated: 0, retired: 0 };
      if (batch.messages.length) {
        // AGENTS.md is read once per request of a project, not again for each of its batches.
        const cached = this.agentsCache?.get(state.projectId);
        const agents = cached?.requestedAt === state.requestedAt ? cached.content : await agentsMd(state.projectId).then(text => text ? clipBytes(text, AGENTS_BYTES) : null).catch(() => null);
        // A failed read is tried again with the next batch; only text read successfully is kept.
        if (agents) (this.agentsCache ||= new Map()).set(state.projectId, { requestedAt: state.requestedAt, content: agents });
        // Reading AGENTS.md takes time; if real work took the slot meanwhile, wait instead of being refused by the device.
        if (!canRun(config.nodeId)) { this.#later(state.projectId, 60000); return { yielded: true }; }
        const output = await query(this.prompt(batch, this.known(batch), agents), config);
        result = this.accept(batch, output);
      } else this.accept(batch, {});
      const latest = this.#state(state.projectId);
      this.db.put('memoryProgress', { ...latest, running: false, lastRunAt: this.clock().toISOString() });
      return result;
    } catch (error) {
      // Giving the slot to real work, or finding it taken, is not a failure: try again in a minute without counting it.
      if (yielded(error)) { this.#later(state.projectId, 60000); return { yielded: true }; }
      this.fail(state.projectId, batch.conversationId, error);
      return { error: error.message };
    } finally {
      this.processing = false;
      if (!this.db.get('projects', state.projectId)) { this.agentsCache?.delete(state.projectId); this.backlogs?.delete(state.projectId); if (this.db.get('memoryProgress', state.projectId)) this.db.remove('memoryProgress', state.projectId); }
      change();
    }
  }

  /**
   * Groups of entries that look alike, built around each entry: the entry and its closest neighbours (sharing rarer terms
   * and at least 60% of the smaller entry's terms), at most GROUP_SIZE. A change to one entry only alters the groups it is
   * in, so the rest stay judged. Terms used by more than COMMON_LIMIT entries are not indexed; the result is cached until
   * an entry changes, since it runs on Home's thread.
   */
  similarGroups() {
    const entries = this.entries().sort((x, y) => x.id.localeCompare(y.id));
    const key = createHash('sha256').update(entries.map(entry => `${entry.id}\u0000${entry.updatedAt}\u0000${entry.type}\u0000${entry.content}`).join('\u0001')).digest('hex');
    if (this.groupsCache?.key === key) return this.groupsCache.groups;
    const names = this.#names(), byId = new Map(entries.map(entry => [entry.id, entry])), terms = new Map(entries.map(entry => [entry.id, this.#derived(entry, names).contentTerms]));
    const index = new Map();
    for (const entry of entries) for (const term of terms.get(entry.id)) { if (!index.has(term)) index.set(term, []); index.get(term).push(entry.id); }
    const groups = [], seenSets = new Set();
    for (const entry of entries) {
      const shared = new Map();
      for (const term of terms.get(entry.id)) { const ids = index.get(term); if (ids.length > COMMON_LIMIT) continue; for (const id of ids) if (id !== entry.id) shared.set(id, (shared.get(id) || 0) + 1); }
      const near = [...shared].map(([id, count]) => [id, count / Math.min(terms.get(entry.id).size, terms.get(id).size)]).filter(([, overlap]) => overlap >= 0.6)
        .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, GROUP_SIZE - 1).map(([id]) => id);
      if (!near.length) continue;
      const members = [entry.id, ...near].sort(), setKey = members.join('|');
      if (seenSets.has(setKey)) continue; seenSets.add(setKey);
      const group = members.map(id => byId.get(id));
      groups.push({ entries: group, signature: createHash('sha256').update(group.map(item => `${item.id}\u0000${item.type}\u0000${item.content}`).join('\u0001')).digest('hex').slice(0, 24) });
    }
    this.groupsCache = { key, groups };
    return groups;
  }

  consolidationPrompt(groups) {
    const project = id => id ? this.db.get('projects', id)?.name || null : null;
    return executionText('platformMemory.consolidatePrompt', { input: JSON.stringify({ groups: groups.map(group => group.entries.map(entry => ({ id: entry.id, type: entry.type, content: entry.content,
      cli: entry.runtime || null, device: entry.nodeId ? this.#deviceName(entry.nodeId) : null, project: project(entry.sourceProjectId), said: entry.saidAt || entry.updatedAt, edited: !!entry.edited }))) }) });
  }

  /**
   * Apply merges inside the groups that were sent: the kept entry takes the merged text, the others are deleted. An item is
   * skipped when it touches an entry already used by an earlier item of this answer, an entry changed since it was sent, text
   * over the limit, or when a key-like string of a merged secret is missing from the result.
   */
  acceptConsolidation(groups, output, time = this.clock(), current = groups.map(group => group.signature)) {
    if (!output || typeof output !== 'object' || !Array.isArray(output.merge ?? [])) throw new Error(tr('platformMemory.invalidResult'));
    const iso = time.toISOString(), sent = new Map(groups.flatMap(group => group.entries.map(entry => [entry.id, entry.updatedAt])));
    const secrets = text => String(text).match(/[A-Za-z0-9_\-./+=:@]{16,}/g) || [];
    return this.db.transaction(() => {
      let merged = 0, removed = 0;const used = new Set();
      for (const item of (output.merge || []).slice(0, 100)) {
        const group = groups.find(candidate => candidate.entries.some(entry => entry.id === item?.keep));
        const fresh = id => { const entry = this.db.get('memories', id); return entry && sent.get(id) === entry.updatedAt ? entry : null; };
        const keep = group && !used.has(item.keep) && fresh(item.keep);
        if (!keep) continue;
        const others = [...new Set(Array.isArray(item.remove) ? item.remove : [])].filter(id => id !== keep.id && group.entries.some(entry => entry.id === id));
        const gone = others.map(id => !used.has(id) && fresh(id));
        if (!others.length || gone.some(entry => !entry)) continue;
        const all = [keep, ...gone];
        const type = all.some(entry => entry.type === 'credential') ? 'credential' : MEMORY_TYPES.includes(item.type) ? item.type : keep.type;
        const content = typeof item.content === 'string' && item.content.trim() ? item.content.trim() : keep.content;
        if (content.length > limitFor(type)) continue;
        if (all.filter(entry => entry.type === 'credential').some(entry => secrets(entry.content).some(secret => !content.includes(secret)))) continue;
        for (const entry of all) used.add(entry.id);
        this.db.put('memories', { ...keep, type, content, edited: all.some(entry => entry.edited), sourceMessageIds: [...new Set(all.flatMap(entry => entry.sourceMessageIds || []))].slice(-20),
          saidAt: all.map(entry => entry.saidAt || entry.updatedAt).sort().at(-1), updatedAt: iso });
        for (const id of others) this.db.remove('memories', id);
        merged++; removed += others.length;
      }
      this.#markChecked(groups.map(group => group.signature), current, iso);
      return { merged, removed };
    });
  }

  /** Keep only signatures of groups that still exist, so the list never outgrows the memory. */
  // Judged groups live in their own record, read only by the duplicate check, so Home's per-second tick stays small.
  #checked() { return this.db.get('memoryChecks', 'groups')?.checked || {}; }
  #markChecked(signatures, current, iso) {
    const alive = new Set([...current, ...signatures]);
    const checked = Object.fromEntries([...Object.entries(this.#checked()).filter(([signature]) => alive.has(signature)), ...signatures.map(signature => [signature, iso])].slice(-CHECKED_LIMIT));
    this.db.put('memoryChecks', { id: 'groups', checked });
    const check = this.db.get('memoryProgress', '@consolidate') || { id: '@consolidate' };
    this.db.put('memoryProgress', { ...check, failures: 0, lastError: null });
  }

  async #consolidate(check, { config, canRun, query, change }) {
    const time = this.clock(), all = this.similarGroups(), current = all.map(group => group.signature);
    const judged = this.#checked(), pending = all.filter(group => !judged[group.signature]);
    if (!pending.length) { this.db.put('memoryProgress', { ...check, requestedAt: null, running: false, retryAt: null, lastRunAt: time.toISOString() }); change(); return { checked: true }; }
    // As many groups as fit in one prompt; a single group too large to send is set aside as checked.
    const groups = [];
    for (const group of pending) {
      if (groups.length >= GROUPS_PER_CALL) break;
      if (bytes(this.consolidationPrompt([...groups, group])) > PROMPT_BYTES) { if (!groups.length) { this.#markChecked([group.signature], current, time.toISOString()); return { skipped: 1 }; } break; }
      groups.push(group);
    }
    this.processing = true;
    this.db.put('memoryProgress', { ...check, running: true });change();
    try {
      const result = this.acceptConsolidation(groups, await query(this.consolidationPrompt(groups), config), this.clock(), current);
      this.db.put('memoryProgress', { ...this.db.get('memoryProgress', '@consolidate'), running: false });
      return result;
    } catch (error) {
      const latest = this.db.get('memoryProgress', '@consolidate') || check;
      if (yielded(error)) { this.db.put('memoryProgress', { ...latest, running: false, retryAt: new Date(this.clock().getTime() + 60000).toISOString() }); return { yielded: true }; }
      const failures = (latest.failures || 0) + 1;
      const lastError = String(error?.message || error).slice(0, 500);
      // The same groups failing three times are set aside, so one bad group cannot hold the check back for good.
      if (failures >= 3) { this.#markChecked(groups.map(group => group.signature), current, this.clock().toISOString()); this.db.put('memoryProgress', { ...this.db.get('memoryProgress', '@consolidate'), running: false, lastError }); return { error: error.message, setAside: groups.length }; }
      this.db.put('memoryProgress', { ...latest, running: false, failures, lastError, retryAt: retryAfter(failures, this.clock()) });
      return { error: error.message };
    } finally { this.processing = false; change(); }
  }
}
