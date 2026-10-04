import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { terminal } from './store.mjs';
import { acceptsBusinessReport } from './run-reports.mjs';

const API = '/api/v1/confirmations';
const mentions = /(?:^|[\s\uff0c\u3002\uff01\uff1f\u3001\uff1b\uff1a,!?;:(\uff08])@[\p{L}\p{N}_-]+/u;

const APPROVE_WORDS = new Set(['approve', '\u901a\u8fc7']);
const REJECT_WORDS = new Set(['reject', '\u62d2\u7edd']);

/** Parses an approval reply: accepts "Approve"/"Reject" and, for backward compatibility, the legacy Chinese words (written as \u escapes). */
export function parseApprovalReply(text) {
  const word = String(text ?? '').trim().replace(/[.!\u3002\uff01\s]+$/u, '').toLowerCase();
  if (APPROVE_WORDS.has(word)) return 'approved';
  if (REJECT_WORDS.has(word)) return 'rejected';
  return null;
}

/** Credentials are read by Home only; tokens are never passed through the browser or a Worker, and external redirects are not followed. */
export function wechatTransport() {
  const client = process.env.WECHAT_CLIENT || 'agent-remote';
  if (!/^[a-z][a-z0-9_-]{0,39}$/.test(client)) throw new Error('Invalid WeChat client name');
  const directory = join(homedir(), '.config/agent-hub/wechat-confirm');
  const installed = join(directory, `${client}.json`);
  const configFile = process.env.WECHAT_CLIENT_CONFIG || (existsSync(installed) ? installed : join(directory, `${client}.bundle`, `${client}.json`));
  return { client, configured: existsSync(configFile), request: async (path, body) => {
    const config = JSON.parse(await readFile(configFile, 'utf8'));
    const url = new URL(config.base_url);
    if (config.client !== client || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid WeChat client configuration');
    const tokenFile = resolve(dirname(configFile), config.token_file);
    if ((await stat(tokenFile)).mode & 0o077) throw new Error('WeChat credential file permissions must be 0600');
    const token = (await readFile(tokenFile, 'utf8')).trim();
    if (!token) throw new Error('WeChat credential is empty');
    const response = await fetch(`${url.origin}${API}${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    if (!response.ok) throw new Error(String(result.error || `wechat_http_${response.status}`).replaceAll(token, '[redacted]').slice(0, 200));
    return result;
  } };
}

/** Persistent number binding; waiting on the network does not occupy a CLI session, and ordinary questions have no wait time limit. */
export class WechatChannel {
  constructor({ db, rooms, request, client, configured, respondApproval, change = () => {}, schedule = () => {}, now = Date.now }) {
    Object.assign(this, { db, rooms, request, client, configured, respondApproval, change, schedule, now });
    this.busy = false;
  }
  settings() { return this.db.get('wechatSettings', 'main') || { id: 'main', enabled: false }; }
  configure(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('Invalid WeChat toggle');
    if (enabled && !this.configured) throw new Error('Home does not have a dedicated WeChat client configuration installed yet');
    const old = this.settings();
    this.db.put('wechatSettings', { ...old, enabled, enabledAt: old.enabledAt || this.now(), authBlocked: false });
    this.change(); return this.status();
  }
  status() {
    return { ...this.settings(), client: this.client, configured: this.configured,
      links: this.db.list('wechatLinks').slice(-100).reverse().map(({ id, kind, projectId, roleId, state, code, hubStatus, deliveryStatus, error, createdAt, lastSeq, closedReason, followupUntil, summary }) =>
        ({ id, kind, projectId, roleId, state, code, hubStatus, deliveryStatus, error, createdAt, lastSeq, closedReason, followupUntil, preview: summary?.slice(0, 240) })) };
  }
  async health() {
    try {
      const result = await this.request('/health');
      if (!result.ok || result.client !== this.client || !result.target?.available) throw new Error('WeChat target is not available yet');
      this.db.put('wechatSettings', { ...this.settings(), health: 'Reachable', healthAt: this.now(), authBlocked: false });
    } catch (error) {
      this.db.put('wechatSettings', { ...this.settings(), health: String(error.message).slice(0, 200), healthAt: this.now() });
    }
    this.change(); return this.status();
  }
  /** The idempotency UUID is saved before sending; after a timeout, the same client_request_id is still submitted to the Hub. */
  create({ sourceKey, kind, projectId, roleId, runId, approvalId, approvalFingerprint, remoteApproval, reportRevision, summary }) {
    const existing = this.db.list('wechatLinks').find(link => link.sourceKey === sourceKey);
    if (existing) return existing;
    const project = this.db.get('projects', projectId), role = this.db.get('roles', roleId);
    if (!project || project.systemConfig || role?.projectId !== projectId) throw new Error('Invalid WeChat target project or role');
    const text = `[${project.name}] @${role.name}\n${summary}`;
    const link = this.db.put('wechatLinks', { id: randomUUID(), sourceKey, kind, projectId, roleId, runId, approvalId, approvalFingerprint, remoteApproval, reportRevision,
      conversationRef: `wb:${runId || projectId}`, summary: text.length > 1800 ? `${text.slice(0, 1800)}\n... The question is long; see the full content in the project group chat.` : text,
      state: 'pending', createdAt: this.now(), lastSeq: 0 });
    this.change(); return link;
  }
  openProject(projectId) {
    if (!this.settings().enabled) throw new Error('Enable WeChat notifications first');
    const existing = this.db.list('wechatLinks').find(link => link.projectId === projectId && link.kind === 'project' && link.state !== 'closed');
    if (existing) return existing;
    const project = this.db.get('projects', projectId);
    return this.create({ sourceKey: `entry:${randomUUID()}`, kind: 'project', projectId, roleId: project?.supervisorRoleId,
      summary: 'Project WeChat entry. Reply "this number + instruction" to hand it to the Supervisor, or "this number + @role + instruction". Only this project is handled. It keeps waiting until you reply; after the first reply it can be used for another 23 hours, after which please get a new entry to avoid reusing an old number.' });
  }
  close(id, reason = 'Follow-up closed on the web') {
    const row = this.db.get('wechatLinks', id); if (!row) throw new Error('WeChat record not found');
    this.db.put('wechatLinks', { ...row, state: 'closed', closedReason: reason, cancelRequested: Boolean(row.hubId), error: null });
    this.change();
  }
  retry(id) {
    const row = this.db.get('wechatLinks', id);
    if (!row || row.state === 'closed') throw new Error('WeChat record is closed or does not exist');
    this.db.put('wechatLinks', { ...row, state: 'pending', error: null, nextAttemptAt: 0,
      resendRequested: Boolean(row.hubId && row.deliveryStatus === 'failed') });
    this.db.put('wechatSettings', { ...this.settings(), authBlocked: false }); this.change();
  }
  /** Only a web answer that explicitly references the same question ends the follow-up; messages from other roles or projects do not count as a reply. */
  webReply(message) {
    const runId = message.replyToId?.startsWith('result-') ? message.replyToId.slice(7) : null;
    const report = runId ? this.db.get('runReports', runId) : null;
    if (report?.projectId === message.projectId && report.verdict === 'needs_input') {
      this.db.put('wechatResolvedQuestions', { id: runId, projectId: message.projectId, revision: report.revision, messageId: message.id, resolvedAt: this.now() });
    }
    for (const link of this.db.list('wechatLinks')) {
      if (link.kind === 'question' && link.projectId === message.projectId && message.replyToId === `result-${link.runId}` && link.state !== 'closed') this.close(link.id, 'Replied on the web');
    }
  }
  discover() {
    const since = this.settings().enabledAt;
    for (const report of this.db.list('runReports')) {
      const run = this.db.get('runs', report.id);
      if (report.verdict !== 'needs_input' || !acceptsBusinessReport(run) || !Number.isFinite(Date.parse(report.updatedAt)) || Date.parse(report.updatedAt) < since || !terminal.has(run?.status)) continue;
      if (this.db.get('wechatResolvedQuestions', run.id)?.revision === report.revision) continue;
      if (this.db.get('projects', run.projectId)?.systemConfig || !this.db.get('roles', run.roleId)) continue;
      this.create({ sourceKey: `question:${run.id}:${report.revision}`, kind: 'question', projectId: run.projectId, roleId: run.roleId,
        runId: run.id, reportRevision: report.revision, summary: `${report.summary}\n${report.next || ''}\nPlease reply with this number. It keeps waiting until you reply; if you have already answered this question by reference on the web, a late reply will not be executed. After the first answer, this number can be used to give further instructions for 23 hours, after which please get a new project entry.` });
    }
    for (const approval of this.db.list('approvals')) {
      const run = this.db.get('runs', approval.runId);
      if (approval.status !== 'pending' || !run || !this.db.get('roles', run.roleId) || terminal.has(run.status) || Date.parse(approval.expiresAt) <= this.now() || this.db.get('projects', run.projectId)?.systemConfig) continue;
      const action = JSON.stringify(approval.params || {});
      const remoteApproval = Boolean(approval.params && action.length <= 1000 && !/token|password|secret|authorization|api.?key/i.test(action));
      this.create({ sourceKey: `approval:${approval.id}`, kind: 'approval', projectId: run.projectId, roleId: run.roleId, runId: run.id, approvalId: approval.id,
        approvalFingerprint: JSON.stringify([approval.method, approval.params, approval.expiresAt]), remoteApproval,
        summary: `CLI permission approval: ${approval.method || 'run operation'}\n${remoteApproval ? action + '\nReply only "Approve" or "Reject".' : 'The operation details are too long or may contain sensitive information; approve on the web execution details page. WeChat does not accept approval.'}\nOriginal approval expires at: ${approval.expiresAt}; expired old replies will not grant authorization.` });
    }
  }
  current(id) {
    const link = this.db.get('wechatLinks', id);
    if (!link || link.state === 'closed') return null;
    if (link.kind === 'approval') {
      const a = this.db.get('approvals', link.approvalId), run = this.db.get('runs', link.runId);
      if (a?.status !== 'pending' || !run || terminal.has(run.status) || run.status === 'stopping' || !Number.isFinite(Date.parse(a.expiresAt)) || Date.parse(a.expiresAt) <= this.now() || JSON.stringify([a.method, a.params, a.expiresAt]) !== link.approvalFingerprint) {
        this.close(id, 'The original approval was handled, expired, or the execution has ended'); return null;
      }
    }
    if (link.kind === 'question') {
      const report = this.db.get('runReports', link.runId);
      const run=this.db.get('runs',link.runId);
      if(!run){this.close(id,'The original run record does not exist');return null;}
      if(!acceptsBusinessReport(run)){this.close(id,'A discussion round is not a business confirmation entry; refer to the original task question');return null;}
      if (report?.verdict !== 'needs_input' || report.revision !== link.reportRevision || this.db.get('wechatResolvedQuestions', link.runId)?.revision === link.reportRevision) { this.close(id, 'The original question was updated or handled'); return null; }
    }
    return link;
  }
  checkRemote(row, link) {
    if (row.conversationRef !== link.conversationRef) throw new Error('conversation_mismatch');
    if (row.source !== this.client || (link.hubId && row.id !== link.hubId) || row.clientRequestId !== link.id || !/^[a-f\d-]{36}$/i.test(row.id || '')) throw new Error('wechat_request_mismatch');
  }
  async sync(original) {
    let link = this.current(original.id); if (!link) return;
    try {
      let remote;
      if (!link.hubId) {
        remote = await this.request('', { client_request_id: link.id, kind: link.kind === 'approval' ? 'approval' : 'question', project: this.db.get('projects', link.projectId)?.name,
          conversation_ref: link.conversationRef, summary: link.summary, options: [] });
        this.checkRemote(remote, link);
        // The web may handle the question while sending; the remote ID is still saved and cancelled in the next round, so the local record is not resurrected.
        link = this.db.get('wechatLinks', link.id);
        this.db.put('wechatLinks', { ...link, hubId: remote.id, code: remote.code, deliveryStatus: remote.deliveryStatus,
          cancelRequested: link.state === 'closed' });
      } else {
        if (link.resendRequested) await this.request(`/${link.hubId}/resend`, {});
        remote = await this.request(`/${link.hubId}`);
      }
      link = this.current(link.id); if (!link || !this.settings().enabled) return;
      this.checkRemote(remote, link);
      link = this.db.put('wechatLinks', { ...link, code: remote.code, hubStatus: remote.status, deliveryStatus: remote.deliveryStatus, resendRequested: false,
        checkedAt: this.now(), nextAttemptAt: 0, attempts: 0, error: null });
      if (remote.deliveryStatus === 'failed') throw new Error(remote.deliveryError || 'delivery_failed');
      if (remote.status === 'cancelled') { this.close(link.id, 'WeChat request cancelled'); return; }
      if (this.db.get('settings', 'main')?.paused) return;
      if (link.kind === 'approval') {
        if (!['approved', 'rejected'].includes(remote.status)) return;
        if (remote.status === 'approved' && !link.remoteApproval) throw new Error('View the full operation on the web before approving');
        this.respondApproval(link.approvalId, remote.status === 'approved' ? 'accept' : 'decline', `wechat-${link.id}`);
        this.db.put('wechatLinks', { ...link, state: 'closed', closedReason: 'Approval reply submitted; the web shows the execution result', error: null });
      } else {
        for (const reply of [...(remote.replies || [])].sort((a, b) => a.seq - b.seq)) {
          if (!Number.isSafeInteger(reply.seq) || reply.seq <= link.lastSeq) continue;
          if (typeof reply.answer !== 'string' || !reply.answer.trim()) throw new Error('WeChat reply is empty');
          const sentAt = Number(reply.createdAt) || Date.parse(reply.createdAt) || this.now();
          if (link.followupUntil && sentAt > link.followupUntil) { this.close(link.id, 'The follow-up window for the answered number has ended; get a new project entry'); break; }
          this.db.transaction(() => {
            const latest = this.current(link.id); if (!latest) return;
            const explicit = mentions.test(reply.answer);
            const source = latest.runId ? this.db.get('runs', latest.runId) : null;
            const quoteId = !explicit && source?.status === 'succeeded' && source.workspace && this.db.get('roomMessages', `result-${source.id}`) ? `result-${source.id}` : null;
            const message = this.rooms.post(latest.projectId, { clientMessageId: `wechat-${latest.id}-${reply.seq}`, text: reply.answer,
              targetRoleId: explicit ? null : latest.roleId, replyToId: quoteId });
            this.db.put('roomMessages', { ...message, senderName: 'Me · WeChat', wechatRequestId: latest.id, wechatReplySeq: reply.seq });
            link = this.db.put('wechatLinks', { ...latest, lastSeq: reply.seq, answeredAt: latest.answeredAt || sentAt,
              followupUntil: latest.followupUntil || Math.min(sentAt, this.now()) + 23 * 60 * 60 * 1000, error: null });
          });
          this.schedule(); this.change();
        }
        // Only limits the window for extra instructions after the first answer; the first reply received while offline is always processed first.
        if (link.followupUntil && link.followupUntil <= this.now()) this.close(link.id, 'The follow-up window for the answered number has ended; get a new project entry');
      }
      this.change();
    } catch (error) {
      const latest = this.db.get('wechatLinks', original.id); if (!latest || latest.state === 'closed') return;
      const message = String(error.message).slice(0, 200);
      const network = /fetch failed|timeout|Timeout|abort|network|ECONN/i.test(message);
      this.db.put('wechatLinks', { ...latest, state: network ? 'pending' : 'error', error: message, checkedAt: this.now(), attempts: (latest.attempts || 0) + 1,
        nextAttemptAt: this.now() + Math.min(300000, 30000 * 2 ** Math.min(latest.attempts || 0, 4)) });
      if (/unauthorized|wechat_http_401|wechat_http_403/.test(message)) this.db.put('wechatSettings', { ...this.settings(), authBlocked: true, health: 'WeChat client authentication failed; check the configuration and test again' });
      this.change();
    }
  }
  /** Background polling for a single Home; ordinary questions are not invalidated by elapsed time, process exit, or restart. */
  async tick() {
    if (this.busy || !this.configured || !this.settings().enabled || this.settings().authBlocked) return;
    this.busy = true;
    try {
      this.discover();
      for (const row of this.db.list('wechatLinks').filter(r => r.state === 'closed' && r.cancelRequested && (!r.cancelRetryAt || r.cancelRetryAt <= this.now()))) {
        try { await this.request(`/${row.hubId}/cancel`, {}); }
        catch (error) {
          if (/unauthorized|wechat_http_401|wechat_http_403/.test(error.message)) {
            this.db.put('wechatSettings', { ...this.settings(), authBlocked: true, health: 'WeChat client authentication failed; check the configuration and test again' }); this.change(); return;
          }
          if (!/not_pending/.test(error.message)) { this.db.put('wechatLinks', { ...this.db.get('wechatLinks', row.id), cancelRetryAt: this.now() + 30000 }); continue; }
        }
        this.db.put('wechatLinks', { ...this.db.get('wechatLinks', row.id), cancelRequested: false });
      }
      const pending = this.db.list('wechatLinks').filter(r => r.state === 'pending' && (!r.nextAttemptAt || r.nextAttemptAt <= this.now()))
        .sort((a, b) => (a.checkedAt || 0) - (b.checkedAt || 0)).slice(0, 8);
      await Promise.all(pending.map(row => this.sync(row)));
    } finally { this.busy = false; }
  }
}
