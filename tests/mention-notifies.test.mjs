// A role that @-mentions another role in wb note or wb call notifies it: the mentioned role gets the text as a call of its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Rooms } from '../src/rooms.mjs';
import { RoleCalls } from '../src/role-calls.mjs';
import { createAgentCalls, mentionedRoles } from '../src/agent-calls.mjs';

const P = 'p1';
function env() {
  const db = new Store(':memory:');
  db.put('projects', { id: P, name: 'demo', supervisorRoleId: 'sup' });
  db.put('workspaces', { id: `${P}:w1`, projectId: P, nodeId: 'w1', localRoot: '/xxxxx' });
  for (const [id, name, extra] of [['sup', 'Supervisor', { systemSupervisor: true }], ['b', 'Builder', {}], ['c', 'Checker', {}], ['r', 'Reviewer', {}], ['old', 'Retired', { archivedAt: '2026-11-01T00:00:00Z' }]])
    db.put('roles', { id, projectId: P, name, nodeId: 'w1', runtime: 'claude', model: 'm', mode: 'workspace-write', enabled: true, ...extra });
  db.put('roomMessages', { id: 'm1', projectId: P, sender: 'human', text: 'work', taskIds: ['t1'] });
  db.put('tasks', { id: 't1', projectId: P, origin: 'chat', roleId: 'b', roleSnapshot: db.get('roles', 'b'), prompt: 'work', sourceMessageId: 'm1', status: 'in_progress', currentRunId: 'r1' });
  db.put('runs', { id: 'r1', projectId: P, taskId: 't1', roleId: 'b', roleSnapshot: db.get('roles', 'b'), nodeId: 'w1', sourceMessageId: 'm1', status: 'running', lastSeq: 0 });
  const calls = new RoleCalls(db), rooms = new Rooms(db); rooms.touch = () => {};
  calls.adoptTask('t1');
  const run = db.get('runs', 'r1');
  const call = input => createAgentCalls({ db, calls, rooms }, run, { requestId: `c-${Math.random().toString(36).slice(2)}`, ...input });
  const targets = result => result.requests.map(r => r.targetRoleId).sort();
  return { db, run, call, targets };
}

test('mentions resolve to the project\'s roles, never the writer, an archived role or a plain word', () => {
  const { db, run } = env();
  const names = text => mentionedRoles(db, run, text).map(r => r.id).sort();
  assert.deepEqual(names('T41 @Checker：请裁决这个取舍'), ['c']);
  assert.deepEqual(names('@Builder 自己 @Retired 和 @someone，邮件 a@Checker'), [], 'self, archived, unknown names and addresses do not count');
  assert.deepEqual(names('@Reviewer and @Checker, also @Reviewer again'), ['c', 'r']);
  assert.deepEqual(names('@Supervisor take a look'), ['sup']);
});

test('a note that mentions roles is a consultation to them; the same note again is the same call', () => {
  const { db, run, call, targets } = env();
  const text = 'T41 @Checker 方案事实冲突需裁决：请审核这个取舍';
  const input = { requestId: `${run.id}:note-x`, roles: mentionedRoles(db, run, text).map(r => r.id), kind: 'consult', text };
  const first = call(input);
  assert.deepEqual(targets(first), ['c']);
  assert.equal(db.get('coordinationRequests', first.requestId).kind, 'consult');
  assert.equal(db.get('roomMessages', first.messageId).kind, 'handoff', 'one card in the chat, no separate note');
  assert.equal(call(input).requestId, first.requestId, 'a retried note does not notify twice');
});

test('roles mentioned in a consult or direct brief get it too; a transfer keeps its one recipient', () => {
  const { call, targets } = env();
  const both = call({ role: 'Checker', kind: 'direct', text: 'fix it, then @Reviewer checks the totals' });
  assert.deepEqual(targets(both), ['c', 'r']);
  assert.match(both.hint, /@Reviewer/, 'the sender is told the mentioned role got it, so it does not send it again');
  assert.deepEqual(targets(call({ role: 'Checker', kind: 'consult', text: '@Checker is this right?' })), ['c'], 'a target named again is not sent twice');
  assert.deepEqual(targets(call({ role: 'Checker', kind: 'transfer', text: 'yours now; ask @Reviewer if stuck' })), ['c']);
});

test('mentioning the role that called you does not wake it again: your answer goes back to it anyway', () => {
  const { db, run } = env();
  db.put('coordinationRequests', { id: 'from-checker', projectId: P, conversationId: P, kind: 'consult', targetRoleId: 'c', status: 'running' });
  db.put('coordinationRequests', { id: 'asked', projectId: P, conversationId: P, kind: 'consult', targetRoleId: 'b', parentRequestId: 'from-checker', status: 'running', currentRunId: 'r1' });
  const asked = { ...run, requestId: 'asked' };
  assert.deepEqual(mentionedRoles(db, asked, '@Checker receive 拼写正确').map(r => r.id), []);
  assert.deepEqual(mentionedRoles(db, asked, '@Checker 已确认，@Reviewer 请复核').map(r => r.id), ['r']);
  db.put('coordinationRequests', { ...db.get('coordinationRequests', 'asked'), callMessageId: 'call:shared' });
  db.put('coordinationRequests', { id: 'asked-too', projectId: P, conversationId: P, kind: 'consult', targetRoleId: 'r', parentRequestId: 'from-checker', callMessageId: 'call:shared', status: 'running' });
  assert.deepEqual(mentionedRoles(db, asked, '@Checker @Reviewer 答案是 7').map(r => r.id), [], 'a role sent the same call has the question already');
});
