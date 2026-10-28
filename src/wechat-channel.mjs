import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { terminal } from './store.mjs';
import { acceptsBusinessReport } from './run-reports.mjs';
import { tr } from './i18n.mjs';
import {conversationIdOf,resolveConversationId} from './group-conversations.mjs';

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
  if (!/^[a-z][a-z0-9_-]{0,39}$/.test(client)) throw new Error(tr('wechatChannel.invalidWechatClientName'));
  const directory = join(homedir(), '.config/agent-hub/wechat-confirm');
  const installed = join(directory, `${client}.json`);
  const configFile = process.env.WECHAT_CLIENT_CONFIG || (existsSync(installed) ? installed : join(directory, `${client}.bundle`, `${client}.json`));
  // Only explicitly installed notification accounts are registered; other agent clients are not accounts.
  let files = [], configurationError = null;
  try {
    files = process.env.WECHAT_CHANNEL_CONFIGS ? JSON.parse(process.env.WECHAT_CHANNEL_CONFIGS) : [];
    if (!Array.isArray(files) || files.some(file => typeof file !== 'string' || !file)) throw new Error();
  } catch { files=[]; configurationError=tr('wechatChannel.invalidWechatClientConfiguration'); }
  const connections = new Map();
  for (const file of [...new Set([configFile, ...files])]) {
    if (!existsSync(file)) { if(file!==configFile)configurationError=tr('wechatChannel.invalidWechatClientConfiguration'); continue; }
    try {
      const config = JSON.parse(readFileSync(file, 'utf8'));
      if (!/^[a-z][a-z0-9_-]{0,39}$/.test(config.client) || config.platform && config.platform !== 'wechat') throw new Error();
      if (file === configFile && config.client !== client || connections.has(`wechat:${config.client}`)) throw new Error();
      connections.set(`wechat:${config.client}`, { file, client: config.client, account: typeof config.account === 'string' && config.account.trim() ? config.account.trim().slice(0, 80) : config.client });
    } catch { configurationError=tr('wechatChannel.invalidWechatClientConfiguration'); }
  }
  const channels = [...connections].map(([id, value]) => ({ id, platform: 'wechat', client: value.client, account: value.account, configured: true }));
  return { client, configured: channels.length > 0, channels, configurationError, request: async (path, body, channelId = `wechat:${client}`) => {
    const connection = connections.get(channelId);
    if (!connection) throw new Error(tr('wechatChannel.channelUnavailable'));
    const config = JSON.parse(await readFile(connection.file, 'utf8'));
    const url = new URL(config.base_url);
    if (config.client !== connection.client || config.platform && config.platform !== 'wechat' || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error(tr('wechatChannel.invalidWechatClientConfiguration'));
    const tokenFile = resolve(dirname(connection.file), config.token_file);
    if ((await stat(tokenFile)).mode & 0o077) throw new Error(tr('wechatChannel.wechatCredentialFilePermissionsMust'));
    const token = (await readFile(tokenFile, 'utf8')).trim();
    if (!token) throw new Error(tr('wechatChannel.wechatCredentialEmpty'));
    const response = await fetch(`${url.origin}${API}${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    if (!response.ok) throw new Error(String(result.error || `wechat_http_${response.status}`).replaceAll(token, '[redacted]').slice(0, 200));
    return result;
  } };
}

/** Persistent number binding; waiting on the network does not occupy a CLI session, and ordinary questions have no wait time limit. */
export class WechatChannel {
  constructor({ db, rooms, request, client, configured, channels, configurationError, respondApproval, change = () => {}, schedule = () => {}, now = Date.now }) {
    Object.assign(this, { db, rooms, request, client, configured, configurationError, respondApproval, change, schedule, now });
    this.channels = channels || (configured ? [{ id: `wechat:${client}`, platform: 'wechat', account: client, client, configured: true }] : []);
    this.defaultChannelId = `wechat:${client}`;
    this.busy = false;
  }
  settings() { return this.db.get('wechatSettings', 'main') || { id: 'main', enabled: false }; }
  configure(enabled, channelId = this.settings().channelId || this.channels[0]?.id) {
    if (typeof enabled !== 'boolean') throw new Error(tr('wechatChannel.invalidWechatToggle'));
    if (enabled && !this.configured) throw new Error(tr('wechatChannel.homeDoesNotHaveDedicated'));
    if (enabled && !this.channels.some(channel => channel.id === channelId && channel.configured)) throw new Error(tr('wechatChannel.channelUnavailable'));
    const old = this.settings();
    this.db.put('wechatSettings', { ...old, enabled, channelId, enabledAt: old.enabledAt || this.now(), authBlocked: false,
      channelHealth: { ...old.channelHealth, ...(channelId ? { [channelId]: { ...old.channelHealth?.[channelId], authBlocked: false } } : {}) } });
    this.change(); return this.status();
  }
  status() {
    const settings = this.settings(), channelId = settings.channelId || this.channels[0]?.id;
    return { ...settings, channelId, client: this.channels.find(channel=>channel.id===channelId)?.client || this.client, configured: this.configured, configurationError: this.configurationError, health: settings.channelHealth?.[channelId]?.health || (!settings.channelId ? settings.health : null),
      channels: this.channels.map(({id,platform,account,configured}) => ({id,platform,account: settings.channelHealth?.[id]?.account || account,configured})),
      links: this.db.list('wechatLinks').slice(-100).reverse().map(link => this.view(link)) };
  }
  /** Links keep their original account even after the default changes; legacy numbers belong to the original client. */
  connection(link) {
    const channel = this.channels.find(channel => channel.id === (link?.channelId || this.defaultChannelId));
    if (!channel?.configured) throw new Error(tr('wechatChannel.channelUnavailable'));
    return channel;
  }
  view({ id, kind, projectId, roleId, state, code, hubStatus, deliveryStatus, error, createdAt, lastSeq, closedReason, followupUntil, summary, channelId }) {
    return { id, kind, projectId, roleId, state, code, hubStatus, deliveryStatus, error, createdAt, lastSeq, closedReason, followupUntil, channelId: channelId || this.defaultChannelId, preview: summary?.slice(0, 240) };
  }
  /** Home binds the tool to the persisted fixed supervisor; no caller-supplied project/role is trusted. */
  notify(run, action, input = {}) {
    run = this.db.get('runs', run?.id);
    const project = this.db.get('projects', run?.projectId), role = this.db.get('roles', run?.roleId);
    if (!run || !['running', 'starting'].includes(run.status) || !project || project.systemConfig || project.supervisorRoleId !== run.roleId || role?.projectId !== project.id || !role.systemSupervisor || !role.enabled || role.archivedAt || role.platformAssistant || run.switchOperationId) throw new Error(tr('wechatChannel.supervisorOnly'));
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(tr('wechatChannel.toolGuide'));
    if (action === 'status') {
      if (Object.keys(input).some(key => key !== 'id') || typeof input.id !== 'string') throw new Error(tr('wechatChannel.toolGuide'));
      const link = this.db.get('wechatLinks', input.id);
      if (!link || link.projectId !== project.id || link.roleId !== role.id || link.kind !== 'notification') throw new Error(tr('wechatChannel.notificationNotFound'));
      return this.view(link);
    }
    if (action !== 'send' || Object.keys(input).some(key => !['requestId', 'text'].includes(key)) || typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(input.requestId) || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 1600) throw new Error(tr('wechatChannel.toolGuide'));
    const sourceKey = `notify:${run.id}:${input.requestId}`, text = input.text.trim();
    const prior = this.db.list('wechatLinks').find(link => link.sourceKey === sourceKey);
    if (prior) {
      if (prior.requestText !== text) throw new Error(tr('wechatChannel.requestConflict'));
      return this.view(prior);
    }
    if (!this.settings().enabled) throw new Error(tr('wechatChannel.enableWechatNotificationsFirst'));
    const channel = this.connection({channelId: this.status().channelId});
    const link = this.create({sourceKey,kind:'notification',projectId:project.id,roleId:role.id,runId:run.id,summary:text,channelId:channel.id,requestText:text});
    return this.view(link);
  }
  async health() {
    const channelId = this.status().channelId;
    try {
      const channel = this.connection({channelId}), result = await this.request('/health', undefined, channel.id);
      if (!result.ok || result.client !== channel.client || !result.target?.available) throw new Error(tr('wechatChannel.wechatTargetNotAvailableYet'));
      this.setHealth(channel.id, {health:tr('wechatChannel.reachable'),healthAt:this.now(),authBlocked:false,
        account:typeof result.target.label === 'string' ? result.target.label.slice(0,80) : channel.account});
    } catch (error) {
      this.setHealth(channelId, {health:String(error.message).slice(0,200),healthAt:this.now()});
    }
    this.change(); return this.status();
  }
  setHealth(channelId, value) {
    const settings=this.settings();
    this.db.put('wechatSettings',{...settings,channelHealth:{...settings.channelHealth,[channelId]:{...settings.channelHealth?.[channelId],...value}}});
  }
  /** The idempotency UUID is saved before sending; after a timeout, the same client_request_id is still submitted to the Hub. */
  create({ sourceKey, kind, projectId, roleId, runId, approvalId, approvalFingerprint, remoteApproval, reportRevision, summary, channelId, requestText }) {
    const source=runId?this.db.get('runs',runId):null;
    if(runId&&source?.projectId!==projectId)throw new Error(tr('conversations.recordMismatch'));
    const conversationId=resolveConversationId(this.db,projectId,source?conversationIdOf(source):undefined);
    const existing = this.db.list('wechatLinks').find(link => link.sourceKey === sourceKey);
    if (existing) return existing;
    const project = this.db.get('projects', projectId), role = this.db.get('roles', roleId);
    if (!project || project.systemConfig || role?.projectId !== projectId) throw new Error(tr('wechatChannel.invalidWechatTargetProjectRole'));
    const text = `[${project.name}] @${role.name}\n${summary}`;
    const link = this.db.put('wechatLinks', { id: randomUUID(), sourceKey, kind, projectId, conversationId, roleId, runId, approvalId, approvalFingerprint, remoteApproval, reportRevision,
      conversationRef: `wb:${runId || projectId}`, summary: text.length > 1800 ? tr('wechatChannel.questionLongSeeFullContent', { p1: text.slice(0, 1800) }) : text,
      channelId: channelId || this.status().channelId, requestText, state: 'pending', createdAt: this.now(), lastSeq: 0 });
    this.change(); return link;
  }
  openProject(projectId) {
    throw new Error(tr('wechatChannel.supervisorOnly'));
  }
  close(id, reason = tr('wechatChannel.followUpClosedOnWeb')) {
    const row = this.db.get('wechatLinks', id); if (!row) throw new Error(tr('wechatChannel.wechatRecordNotFound'));
    this.db.put('wechatLinks', { ...row, state: 'closed', closedReason: reason, cancelRequested: Boolean(row.hubId), error: null });
    this.change();
  }
  retry(id) {
    const row = this.db.get('wechatLinks', id);
    if (!row || row.state === 'closed') throw new Error(tr('wechatChannel.wechatRecordClosedDoesNot'));
    this.db.put('wechatLinks', { ...row, state: 'pending', error: null, nextAttemptAt: 0,
      resendRequested: Boolean(row.hubId && row.deliveryStatus === 'failed') });
    this.setHealth(row.channelId || this.defaultChannelId,{authBlocked:false});
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
      if (link.kind === 'question' && link.projectId === message.projectId && message.replyToId === `result-${link.runId}` && link.state !== 'closed') this.close(link.id, tr('wechatChannel.repliedOnWeb'));
    }
  }
  discover() {
    // Notifications now require an explicit supervisor tool call. Old links remain consumable.
  }
  current(id) {
    const link = this.db.get('wechatLinks', id);
    if (!link || link.state === 'closed') return null;
    if (link.kind === 'notification') {
      const project=this.db.get('projects',link.projectId),role=this.db.get('roles',link.roleId);
      if (!project || project.systemConfig || project.supervisorRoleId !== link.roleId || role?.projectId !== link.projectId || !role.enabled || role.archivedAt || !role.systemSupervisor) {
        this.close(id,tr('wechatChannel.notificationTargetChanged'));return null;
      }
    }
    if (link.kind === 'approval') {
      const a = this.db.get('approvals', link.approvalId), run = this.db.get('runs', link.runId);
      if (a?.status !== 'pending' || !run || terminal.has(run.status) || run.status === 'stopping' || !Number.isFinite(Date.parse(a.expiresAt)) || Date.parse(a.expiresAt) <= this.now() || JSON.stringify([a.method, a.params, a.expiresAt]) !== link.approvalFingerprint) {
        this.close(id, tr('wechatChannel.originalApprovalWasHandledExpired')); return null;
      }
    }
    if (link.kind === 'question') {
      const report = this.db.get('runReports', link.runId);
      const run=this.db.get('runs',link.runId);
      if(!run){this.close(id,tr('wechatChannel.originalRunRecordDoesNot'));return null;}
      if(!acceptsBusinessReport(run)){this.close(id,tr('wechatChannel.discussionRoundNotBusinessConfirmation'));return null;}
      if (report?.verdict !== 'needs_input' || report.revision !== link.reportRevision || this.db.get('wechatResolvedQuestions', link.runId)?.revision === link.reportRevision) { this.close(id, tr('wechatChannel.originalQuestionWasUpdatedHandled')); return null; }
    }
    return link;
  }
  checkRemote(row, link) {
    if (row.conversationRef !== link.conversationRef) throw new Error('conversation_mismatch');
    if (row.source !== this.connection(link).client || (link.hubId && row.id !== link.hubId) || row.clientRequestId !== link.id || !/^[a-f\d-]{36}$/i.test(row.id || '')) throw new Error('wechat_request_mismatch');
  }
  async sync(original) {
    let link = this.current(original.id); if (!link) return;
    try {
      const channel = this.connection(link);
      const request = (path,body) => this.request(path,body,channel.id);
      let remote;
      if (!link.hubId) {
        remote = await request('', { client_request_id: link.id, kind: link.kind === 'approval' ? 'approval' : 'question', project: this.db.get('projects', link.projectId)?.name,
          conversation_ref: link.conversationRef, summary: link.summary, options: [] });
        this.checkRemote(remote, link);
        // The web may handle the question while sending; the remote ID is still saved and cancelled in the next round, so the local record is not resurrected.
        link = this.db.get('wechatLinks', link.id);
        this.db.put('wechatLinks', { ...link, hubId: remote.id, code: remote.code, deliveryStatus: remote.deliveryStatus,
          cancelRequested: link.state === 'closed' });
      } else {
        if (link.resendRequested) await request(`/${link.hubId}/resend`, {});
        remote = await request(`/${link.hubId}`);
      }
      link = this.current(link.id); if (!link || !this.settings().enabled) return;
      this.checkRemote(remote, link);
      link = this.db.put('wechatLinks', { ...link, code: remote.code, hubStatus: remote.status, deliveryStatus: remote.deliveryStatus, resendRequested: false,
        checkedAt: this.now(), nextAttemptAt: 0, attempts: 0, error: null });
      if (remote.deliveryStatus === 'failed') throw new Error(remote.deliveryError || 'delivery_failed');
      if (remote.status === 'cancelled') { this.close(link.id, tr('wechatChannel.wechatRequestCancelled')); return; }
      if (link.kind === 'approval') {
        if (!['approved', 'rejected'].includes(remote.status)) return;
        if (remote.status === 'approved' && !link.remoteApproval) throw new Error(tr('wechatChannel.viewFullOperationOnWeb'));
        this.respondApproval(link.approvalId, remote.status === 'approved' ? 'accept' : 'decline', `wechat-${link.id}`);
        this.db.put('wechatLinks', { ...link, state: 'closed', closedReason: tr('wechatChannel.approvalReplySubmittedWebShows'), error: null });
      } else {
        for (const reply of [...(remote.replies || [])].sort((a, b) => a.seq - b.seq)) {
          if (!Number.isSafeInteger(reply.seq) || reply.seq <= link.lastSeq) continue;
          if (typeof reply.answer !== 'string' || !reply.answer.trim()) throw new Error(tr('wechatChannel.wechatReplyEmpty'));
          const sentAt = Number(reply.createdAt) || Date.parse(reply.createdAt) || this.now();
          if (link.followupUntil && sentAt > link.followupUntil) { this.close(link.id, tr('wechatChannel.followUpWindowForAnswered')); break; }
          this.db.transaction(() => {
            const latest = this.current(link.id); if (!latest) return;
            const explicit = latest.kind !== 'notification' && mentions.test(reply.answer);
            const source = latest.runId ? this.db.get('runs', latest.runId) : null;
            const quoteId = !explicit && source?.status === 'succeeded' && source.workspace && this.db.get('roomMessages', `result-${source.id}`) ? `result-${source.id}` : null;
            const message = this.rooms.post(latest.projectId, { clientMessageId: `wechat-${latest.id}-${reply.seq}`, conversationId:conversationIdOf(latest), text: reply.answer,
              targetRoleId: explicit ? null : latest.roleId, replyToId: quoteId });
            this.db.put('roomMessages', { ...message, senderName: tr('wechatChannel.meWechat'), wechatRequestId: latest.id, wechatReplySeq: reply.seq });
            link = this.db.put('wechatLinks', { ...latest, lastSeq: reply.seq, answeredAt: latest.answeredAt || sentAt,
              followupUntil: latest.followupUntil || Math.min(sentAt, this.now()) + 23 * 60 * 60 * 1000, error: null });
          });
          this.schedule(); this.change();
        }
        // Only limits the window for extra instructions after the first answer; the first reply received while offline is always processed first.
        if (link.followupUntil && link.followupUntil <= this.now()) this.close(link.id, tr('wechatChannel.followUpWindowForAnswered2'));
      }
      this.change();
    } catch (error) {
      const latest = this.db.get('wechatLinks', original.id); if (!latest || latest.state === 'closed') return;
      const message = String(error.message).slice(0, 200);
      const network = /fetch failed|timeout|Timeout|abort|network|ECONN/i.test(message);
      this.db.put('wechatLinks', { ...latest, state: network ? 'pending' : 'error', error: message, checkedAt: this.now(), attempts: (latest.attempts || 0) + 1,
        nextAttemptAt: this.now() + Math.min(300000, 30000 * 2 ** Math.min(latest.attempts || 0, 4)) });
      if (/unauthorized|wechat_http_401|wechat_http_403/.test(message)) this.setHealth(latest.channelId || this.defaultChannelId,{authBlocked:true,health:tr('wechatChannel.wechatClientAuthenticationFailedCheck')});
      this.change();
    }
  }
  /** Background polling for a single Home; ordinary questions are not invalidated by elapsed time, process exit, or restart. */
  async tick() {
    if (this.busy || !this.configured || !this.settings().enabled) return;
    this.busy = true;
    try {
      const available = row => !this.settings().channelHealth?.[row.channelId || this.defaultChannelId]?.authBlocked && !(this.settings().authBlocked && !row.channelId);
      for (const row of this.db.list('wechatLinks').filter(r => available(r) && r.state === 'closed' && r.cancelRequested && (!r.cancelRetryAt || r.cancelRetryAt <= this.now()))) {
        try { await this.request(`/${row.hubId}/cancel`, {}, this.connection(row).id); }
        catch (error) {
          if (/unauthorized|wechat_http_401|wechat_http_403/.test(error.message)) {
            this.setHealth(row.channelId || this.defaultChannelId,{authBlocked:true,health:tr('wechatChannel.wechatClientAuthenticationFailedCheck2')}); this.change(); continue;
          }
          if (!/not_pending/.test(error.message)) { this.db.put('wechatLinks', { ...this.db.get('wechatLinks', row.id), cancelRetryAt: this.now() + 30000 }); continue; }
        }
        this.db.put('wechatLinks', { ...this.db.get('wechatLinks', row.id), cancelRequested: false });
      }
      const pending = this.db.list('wechatLinks').filter(r => available(r) && r.state === 'pending' && (!r.nextAttemptAt || r.nextAttemptAt <= this.now()))
        .sort((a, b) => (a.checkedAt || 0) - (b.checkedAt || 0)).slice(0, 8);
      await Promise.all(pending.map(row => this.sync(row)));
    } finally { this.busy = false; }
  }
}
