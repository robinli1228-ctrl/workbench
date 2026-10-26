// One turn's input: the message first (origin, text, attachments), then each platform addition under its own title;
// the environment names only what cannot be assumed; a call that could not run wakes the role that sent it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Rooms } from '../src/rooms.mjs';
import { RoleCalls } from '../src/role-calls.mjs';
import { createAgentCalls } from '../src/agent-calls.mjs';
import { runWithLanguage, tr } from '../src/i18n.mjs';
import { composeTurnInput, executionEnvironmentHint, createRunInput, executionInstructionComponents } from '../src/run-input.mjs';
import { traditionalInput } from '../src/input-language.mjs';
import { turnOrigin, renderRunInputParts, renderRunPrompt } from '../src/run-context.mjs';
import { registerCallOutcome, wakeCallOutcomes } from '../src/result-receipts.mjs';
import { executionRules } from '../src/platform-prompts.mjs';
import { runInputGroups } from '../public/run-log-data.js';

const P = 'p1';
function env() {
  const db = new Store(':memory:');
  db.put('projects', { id: P, name: 'demo', supervisorRoleId: 'sup' });
  db.put('workspaces', { id: `${P}:w1`, projectId: P, nodeId: 'w1', localRoot: '/xxxxx' });
  for (const [id, name, extra] of [['sup', 'Supervisor', { systemSupervisor: true }], ['b', 'Builder', {}]])
    db.put('roles', { id, projectId: P, name, nodeId: 'w1', runtime: 'claude', model: 'm', mode: 'workspace-write', enabled: true, ...extra });
  db.put('roomMessages', { id: 'm1', projectId: P, sender: 'human', text: 'build it', taskIds: ['t1'] });
  db.put('tasks', { id: 't1', projectId: P, origin: 'chat', roleId: 'sup', roleSnapshot: db.get('roles', 'sup'), prompt: 'build it', sourceMessageId: 'm1', status: 'in_progress', currentRunId: 'r1', createdAt: new Date().toISOString() });
  db.put('runs', { id: 'r1', projectId: P, taskId: 't1', roleId: 'sup', roleSnapshot: db.get('roles', 'sup'), nodeId: 'w1', sourceMessageId: 'm1', status: 'running', lastSeq: 0 });
  const calls = new RoleCalls(db), rooms = new Rooms(db); rooms.touch = () => {};
  return { db, calls, rooms };
}

test('message and attachments come first, each platform addition is titled, and the ranges match the sent text', () => {
  const { prompt, sections } = runWithLanguage('zh', () => composeTurnInput({
    message: { origin: { kind: 'role', name: '测试员' }, text: '请审核这个版本' },
    attachments: [{ name: '设计稿（终版）.md', path: '/xxxxx/.workbench/tmp/attachments/a/b-设计稿（终版）.md' }],
    home: [{ key: 'steering', text: '用户调整了方向' }, { key: 'task', text: '' }, { key: 'future', text: '新段落' }],
    worker: [{ key: 'environment', text: '當前目錄：/xxxxx/设计稿', sent: true }, { key: 'wb', text: '調用方式：wb', sent: true }]
  }));
  assert.deepEqual(sections.map(s => s.key), ['message', 'attachments', 'divider', 'steering', 'future', 'environment', 'wb'], 'empty additions are left out');
  assert.ok(prompt.startsWith('【協同角色消息：测试员】\n請審'), 'the template is Traditional, the role name stays exactly as configured');
  assert.match(prompt, /- 设计稿（终版）\.md：\/xxxxx\/\.workbench\/tmp\/attachments\/a\/b-设计稿（终版）\.md/, 'file names and paths stay exact');
  assert.match(prompt, /當前目錄：\/xxxxx\/设计稿/, 'parts the Worker built in the sent script are not converted again');
  assert.match(prompt, /【平臺附加】\n新段落/, 'an unknown part gets a generic title, not a raw key');
  assert.ok(prompt.indexOf('设计稿（终版）.md') < prompt.indexOf('—— 以下由平臺附加 ——'), 'attachments belong to the message, above the divider');
  const groups = runInputGroups({ prompt, sections });
  assert.deepEqual(groups.message.map(p => p.key), ['message', 'attachments']);
  assert.deepEqual(groups.home.map(p => p.key), ['steering', 'future']);
  assert.match(groups.home[0].text, /^【插隊說明】\n/);
  assert.deepEqual(groups.worker.map(p => p.key), ['environment', 'wb']);
  assert.equal(groups.message.map(p => p.text).join('\n\n') + '\n\n', prompt.slice(0, sections[2].start), 'ranges cover the sent text exactly');
  assert.equal(runInputGroups({ prompt, sections: [{ key: 'x', group: 'home', start: 0, end: prompt.length + 1 }] }), null, 'bad ranges are not guessed at');
});

test('the Worker puts its parts in a fixed order after Home\'s', () => runWithLanguage('zh', () => {
  const input = createRunInput({ minimal: true, roleInstructions: '', taskPrompt: 'old', context: '引用执行的文件位于 /xxxxx/src', environmentHint: '當前目錄就是項目目錄：/xxxxx（可寫）',
    executionInstructions: '本阶段是独立审核：只读，核对指定版本。', sourceInputs: [{ repositoryId: 'r', manifestHash: 'h' }],
    turn: { message: { origin: { kind: 'human' }, text: '看看' }, home: [{ key: 'task', text: '{"id":"t"}' }], attachments: [], dependencies: '依赖 []', wb: '調用方式：wb' } });
  assert.deepEqual(input.sections.map(s => s.key), ['message', 'divider', 'task', 'dependencies', 'sourceWorkspace', 'sourceInputs', 'environment', 'stage', 'wb']);
  assert.match(input.prompt, /^【用戶消息】\n看看/);
  assert.doesNotMatch(input.prompt, /old/, 'the legacy task prompt is not sent when named parts exist');
  const discussion = createRunInput({ minimal: true, roleInstructions: '', executionInstructions: '讨论规则', turn: { message: { text: 'x' }, home: [], rulesKey: 'protocol' } });
  assert.match(discussion.prompt, /【本輪規則】\n討論規則/, 'a discussion turn\'s rules are not filed as a stage boundary');
}));

test('createRunInput keeps the old layout for a Home without named parts', () => {
  const old = createRunInput({ minimal: true, taskPrompt: 'do it', roleInstructions: '', environmentHint: 'env', runtimeGuidance: 'tools', attachmentHint: 'files' });
  assert.equal(old.sections, undefined);
  assert.equal(old.prompt, 'do it\n\nenv\n\ntools\n\nfiles');
});

test('the environment names only what cannot be assumed', () => runWithLanguage('zh', () => {
  const normal = executionEnvironmentHint({ cwd: '/xxxxx/proj', projectRoot: '/xxxxx/proj', sharedDocs: '/xxxxx/proj/.workbench/docs',
    inputRepositoryVersions: [{ id: 'r', key: 'app', commit: 'a'.repeat(40), boundCommit: 'a'.repeat(40), localRoot: '/xxxxx/proj', dirty: true }] });
  assert.equal(normal, '當前目錄就是項目目錄：/xxxxx/proj（可寫）\n共享報告目錄：/xxxxx/proj/.workbench/docs（只放可以公開的報告；未公開的審覈材料不要放這裏）',
    'one repository in the project directory at its own HEAD needs no repository line');
  const multi = executionEnvironmentHint({ cwd: '/xxxxx/proj', projectRoot: '/xxxxx/proj', readOnly: true,
    inputRepositoryVersions: [{ id: 'a', key: 'app', commit: 'a'.repeat(40), boundCommit: 'a'.repeat(40), localRoot: '/xxxxx/proj/app' },
      { id: 'l', key: 'lib', commit: 'b'.repeat(40), boundCommit: 'b'.repeat(40), localRoot: '/xxxxx/lib' }, { id: 'd', key: 'docs', unavailable: true, localRoot: null }] });
  assert.match(multi, /（本輪只讀）/);
  assert.match(multi, /倉庫 app：\/xxxxx\/proj\/app\n/, 'several repositories keep their key-to-path mapping');
  assert.match(multi, /倉庫 lib：\/xxxxx\/lib，代碼 bbbbbbbbbbbb\n/, 'one outside the current directory also says its version');
  assert.match(multi, /本機缺少倉庫：docs/);
  const retained = executionEnvironmentHint({ cwd: '/xxxxx/proj/.worktrees/run-1', projectRoot: '/xxxxx/proj', boundary: '項目目錄為 /xxxxx/proj。',
    inputRepositoryVersions: [{ id: 'r', key: 'app', commit: 'a655e559b62c4b81fa42', boundCommit: 'b0084c3eda44fbcd8b97', dirty: true, localRoot: '/xxxxx/proj/.worktrees/run-1/app' },
      { id: 'q', key: 'web', commit: 'c'.repeat(40), boundCommit: null, localRoot: '/xxxxx/proj/.worktrees/run-1/web' }] });
  assert.match(retained, /^當前目錄：\/xxxxx\/proj\/\.worktrees\/run-1\n項目目錄為/);
  assert.match(retained, /倉庫 app：\/xxxxx\/proj\/\.worktrees\/run-1\/app，代碼 a655e559b62c，有未提交修改，項目當前 b0084c3eda44。這個目錄不會自動更新/);
  assert.match(retained, /倉庫 web：\/xxxxx\/proj\/\.worktrees\/run-1\/web，代碼 cccccccccccc$/m, 'a copy without a bound version is still named');
  assert.doesNotMatch(retained, /共享報告目錄/, 'no shared directory when none is allowed');
  const delivered = executionEnvironmentHint({ cwd: '/xxxxx/proj/.worktrees/run-2', projectRoot: '/xxxxx/proj', assigned: true,
    inputRepositoryVersions: [{ id: 'r', key: 'app', commit: 'c'.repeat(40), boundCommit: 'b'.repeat(40), localRoot: '/xxxxx/proj/.worktrees/run-2/app' }] });
  assert.match(delivered, /代碼 cccccccccccc，本輪指定的版本/);
  assert.doesNotMatch(delivered, /不會自動更新/, 'a delivered or referenced version is not a stale copy');
  assert.match(executionEnvironmentHint({ cwd: '/xxxxx/设计稿（终版）', projectRoot: '/xxxxx/设计稿（终版）' }), /^當前目錄就是項目目錄：\/xxxxx\/设计稿（终版）（可寫）$/, 'paths stay exact');
}));

test('the message is labelled by who sent it', () => {
  const e = env();
  assert.deepEqual(turnOrigin(e.db, e.db.get('tasks', 't1'), e.calls.adoptTask('t1')), { kind: 'human' }, 'an adopted user message stays the user');
  const sent = createAgentCalls(e, e.db.get('runs', 'r1'), { role: 'Builder', kind: 'direct', requestId: 'c1', text: 'build' });
  const request = e.db.get('coordinationRequests', sent.requestId);
  assert.deepEqual(turnOrigin(e.db, { sourceMessageId: 'm1' }, request), { kind: 'role', name: 'Supervisor' }, 'a call names its caller, not the user message it started from');
  assert.deepEqual(turnOrigin(e.db, {}, { id: 'w', kind: 'continuation', parentRequestId: request.id }), { kind: 'platform' }, 'a wait wake is the platform');
  assert.deepEqual(turnOrigin(e.db, {}, { ...request, sourceRunId: 'purged' }), { kind: 'role', name: 'Supervisor' }, 'a purged caller run still names the caller from its request');
  assert.deepEqual(turnOrigin(e.db, { scheduledJobId: 'j' }, null), { kind: 'platform' });
  e.db.put('roomMessages', { id: 'sys', projectId: P, sender: 'system', text: 'stalled' });
  assert.deepEqual(turnOrigin(e.db, { sourceMessageId: 'sys' }, { id: 'task:x' }), { kind: 'platform' });
  assert.deepEqual(turnOrigin(e.db, { steering: { at: 'now' } }, request), { kind: 'human' }, 'a direction change is the user');
});

test('Home parts put the direction change first and no longer carry result receipts', () => runWithLanguage('zh', () => {
  const packet = { instruction: '继续', origin: { kind: 'role', name: 'Supervisor' }, steering: { at: 'now' }, completion: '测试通过',
    references: [{ id: 'm9', author: '用户', text: '原话', truncated: true }], deliveries: [{ id: 'd1', commit: 'abc', summary: '版本' }],
    receipts: { items: [{ requestId: 'x', role: 'B', summary: 'done' }] } };
  const parts = renderRunInputParts(packet);
  assert.deepEqual(parts.message, { origin: { kind: 'role', name: 'Supervisor' }, text: '继续' });
  assert.deepEqual(parts.home.map(p => p.key), ['steering', 'references', 'deliveries', 'completion']);
  assert.match(parts.home[1].text, /wb history read m9/);
  assert.doesNotMatch(renderRunPrompt(packet, { minimal: true }), /x "B"/, 'receipts are not repeated in minimal turns');
}));

test('stage boundaries keep only what the platform prompt does not say', () => runWithLanguage('zh', () => {
  assert.equal(executionRules({ execution: { purpose: 'audit' } }, { minimal: true }), '本阶段是独立审核：只读，核对指定版本。');
  assert.equal(executionRules({ execution: { purpose: 'deploy' } }, { minimal: true }), '', 'deploy stages are refused at submit, so no text is kept for them');
  assert.match(executionRules({ execution: { purpose: 'merge' } }, { minimal: true }), /不得擅自合并主分支/);
}));

test('a transfer that could not run wakes the role that handed it over, once; cancellations and waiting callers do not', () => {
  const e = env(), posted = [];
  const post = (receipt, text) => { posted.push({ receipt, text }); return e.rooms.postSystemTask(receipt.projectId, { id: `outcome-${receipt.id.slice(3)}`, conversationId: receipt.conversationId, roleId: receipt.ownerRoleId, text, source: { kind: 'call_outcome', receiptId: receipt.id } }); };
  const sent = createAgentCalls(e, e.db.get('runs', 'r1'), { role: 'Builder', kind: 'transfer', requestId: 'own-1', text: 'build it' });
  const transfer = e.db.get('coordinationRequests', sent.requestId);
  registerCallOutcome(e.db, transfer, { outcome: 'not_executed', reason: 'device offline' });
  assert.equal(wakeCallOutcomes(e.db, post), true);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].receipt.ownerRoleId, 'sup');
  assert.match(posted[0].text, /you transferred to Builder was not executed: device offline/);
  const message = e.db.list('roomMessages').find(m => m.kind === 'call_outcome');
  assert.equal(message.sender, 'system');
  assert.equal(message.visibility, 'internal');
  const task = e.db.get('tasks', message.taskIds[0]);
  assert.equal(task.roleId, 'sup');
  assert.deepEqual(turnOrigin(e.db, task, null), { kind: 'platform' }, 'the reminder is labelled as the platform, not the user');
  assert.equal(wakeCallOutcomes(e.db, post), false, 'one wake per outcome');
  assert.equal(posted.length, 1);

  const call = createAgentCalls(e, e.db.get('runs', 'r1'), { role: 'Builder', kind: 'direct', requestId: 'c2', text: 'check' });
  registerCallOutcome(e.db, e.db.get('coordinationRequests', call.requestId), { outcome: 'cancelled', reason: 'cancelled' });
  assert.equal(e.db.list('outcomeWakes').length, 0, 'a cancellation is the user\'s own decision');
  const parent = e.calls.forRun(e.db.get('runs', 'r1'));
  e.db.put('coordinationRequests', { ...parent, status: 'running' });
  registerCallOutcome(e.db, e.db.get('coordinationRequests', call.requestId), { outcome: 'blocked', reason: 'cli unavailable', episode: 'e1' });
  wakeCallOutcomes(e.db, post);
  assert.equal(posted.length, 1, 'a caller still working may yet wait; checked again later');
  assert.equal(e.db.list('outcomeWakes').length, 1);
  e.db.put('coordinationRequests', { ...e.db.get('coordinationRequests', parent.id), status: 'waiting_call' });
  wakeCallOutcomes(e.db, post);
  assert.equal(posted.length, 1, 'a waiting caller is woken by its wait');
  assert.equal(e.db.list('outcomeWakes').length, 0);
});

test('conversion keeps file names with full-width brackets intact', () => {
  assert.equal(traditionalInput('看 docs/设计稿（终版）.md 和 【会议纪要】.docx'), '看 docs/设计稿（终版）.md 和 【会议纪要】.docx');
});

test('the identity follows the sent script but keeps the configured role name exactly', () => runWithLanguage('zh', () => {
  const { identity } = executionInstructionComponents({ run: { roleSnapshot: { name: '开发' }, roleId: 'role-builder' }, configuration: { platformPrompt: '', roleInstructions: '', supervisorPrompt: '' } });
  assert.match(identity, /^當前通過 Workbench 執行，角色/);
  assert.match(identity, / 开发（角色 ID：role-builder）/);
}));

test('a caller whose wait already woke once still hears about a later failure; failed posts are retried, a disabled caller is skipped', () => {
  const e = env(), posted = [];
  const call = createAgentCalls(e, e.db.get('runs', 'r1'), { role: 'Builder', kind: 'direct', requestId: 'c3', text: 'check' });
  const request = e.db.get('coordinationRequests', call.requestId), parent = e.calls.forRun(e.db.get('runs', 'r1'));
  // The wait timed out and woke the caller; its continuation then finished without waiting again.
  e.db.put('coordinationRequests', { id: 'resume:1', projectId: P, targetRoleId: 'sup', kind: 'continuation', continuationOf: parent.id, status: 'succeeded', summary: 'x' });
  e.db.put('coordinationRequests', { ...e.db.get('coordinationRequests', parent.id), status: 'waiting_call', continuationRequestId: 'resume:1', waitRequestIds: [request.id] });
  registerCallOutcome(e.db, request, { outcome: 'blocked', reason: 'device offline', episode: 'e2' });
  let failures = 2;
  const post = (receipt, text) => { if (failures-- > 0) throw new Error('SQLITE_BUSY'); posted.push(text); return { id: 'msg' }; };
  wakeCallOutcomes(e.db, post); wakeCallOutcomes(e.db, post);
  assert.equal(posted.length, 0, 'transient failures keep the wake queued');
  assert.equal(e.db.list('outcomeWakes')[0].attempts, 2);
  wakeCallOutcomes(e.db, post);
  assert.equal(posted.length, 1, 'the old wait no longer covers it, so the caller is told');
  assert.match(posted[0], /cannot start for now: device offline/);

  registerCallOutcome(e.db, request, { outcome: 'blocked', reason: 'again', episode: 'e3' });
  e.db.put('roles', { ...e.db.get('roles', 'sup'), enabled: false });
  wakeCallOutcomes(e.db, post);
  assert.equal(posted.length, 1);
  assert.equal(e.db.list('outcomeWakes').length, 0, 'a disabled caller gets no reminder and the queue is cleared');
});

test('the retired-command notice is sent in the same script as the rest, and sync help covers metadata mode', () => runWithLanguage('zh', () => {
  const { role } = executionInstructionComponents({ run: { roleSnapshot: { name: '开发' }, roleId: 'r1' }, configuration: { platformPrompt: '', roleInstructions: '完成后用 wb report 汇报。', supervisorPrompt: '' } });
  assert.match(role, /已取消的命令（wb report、wb schedule 等）不要再用，結果以最終回覆爲準。$/, 'the notice starts with prose, so conversion does not skip it as a command line');
  assert.match(tr('wbTools.helpSync'), /元数据同步只比较修改时间和大小，不给 SHA256，哈希为空不代表没到/);
}));
