// A role that @-mentions another role in wb note or wb call notifies it, without ever costing the note or call it rides on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { Rooms } from '../src/rooms.mjs';
import { RoleCalls } from '../src/role-calls.mjs';
import { callWithMentions, noteWithMentions, mentionedRoles } from '../src/agent-calls.mjs';

const P = 'p1';
function env() {
  const db = new Store(':memory:');
  db.put('projects', { id: P, name: 'demo', supervisorRoleId: 'sup' });
  db.put('workspaces', { id: `${P}:w1`, projectId: P, nodeId: 'w1', localRoot: '/xxxxx' });
  for (const [id, name, extra] of [['sup', 'Supervisor', { systemSupervisor: true }], ['b', 'Builder', {}], ['c', 'Checker', {}], ['r', 'Reviewer', {}], ['off', 'Offline', { enabled: false }], ['old', 'Retired', { archivedAt: '2026-11-01T00:00:00Z' }]])
    db.put('roles', { id, projectId: P, name, nodeId: 'w1', runtime: 'claude', model: 'm', mode: 'workspace-write', enabled: true, ...extra });
  db.put('roomMessages', { id: 'm1', projectId: P, sender: 'human', text: 'work', taskIds: ['t1'] });
  db.put('tasks', { id: 't1', projectId: P, origin: 'chat', roleId: 'b', roleSnapshot: db.get('roles', 'b'), prompt: 'work', sourceMessageId: 'm1', status: 'in_progress', currentRunId: 'r1' });
  db.put('runs', { id: 'r1', projectId: P, taskId: 't1', roleId: 'b', roleSnapshot: db.get('roles', 'b'), nodeId: 'w1', sourceMessageId: 'm1', status: 'running', lastSeq: 0 });
  const calls = new RoleCalls(db), rooms = new Rooms(db); rooms.touch = () => {};
  calls.adoptTask('t1');
  db.put('runs', { ...db.get('runs', 'r1'), requestId: 'task:t1' });
  const run = () => db.get('runs', 'r1'), ctx = { db, calls, rooms };
  const call = input => callWithMentions(ctx, run(), { requestId: `r1:c-${Math.random().toString(36).slice(2)}`, ...input });
  const note = text => noteWithMentions(ctx, run(), text);
  const targetsOf = ids => ids.map(id => db.get('coordinationRequests', id).targetRoleId).sort();
  return { db, run, call, note, targetsOf };
}

test('mentions resolve to roles that would not have it otherwise', () => {
  const { db, run } = env();
  const names = text => mentionedRoles(db, run(), text).map(r => r.id).sort();
  assert.deepEqual(names('T41 @Checker：请裁决这个取舍'), ['c']);
  assert.deepEqual(names('@Checker请看一下'), ['c'], 'a name running straight into the next word');
  assert.deepEqual(names('@Builder 自己 @Retired 和 @someone，邮件 a@Checker'), [], 'self, archived, unknown names and addresses do not count');
  assert.deepEqual(names('@Reviewer and @Checker, also @Reviewer again'), ['c', 'r']);
  assert.deepEqual(names('@Supervisor take a look'), ['sup']);
});

test('a note that mentions roles reaches them as a consultation; one that cannot is posted as before', () => {
  const { db, note, targetsOf } = env();
  const sent = note('T41 @Checker 方案事实冲突需裁决');
  assert.deepEqual(targetsOf(sent.requestIds), ['c']);
  assert.equal(db.get('coordinationRequests', sent.requestId).kind, 'consult');
  assert.match(sent.hint, /@Checker/, 'the writer is told the note became a consultation');
  assert.equal(note('T41 @Checker 方案事实冲突需裁决').requestId, sent.requestId, 'a retried note notifies once');
  const plain = note('@Offline 离线，先跳过');
  assert.equal(plain.sender, 'agent');assert.equal(plain.requestId, undefined, 'a role that cannot take it: a plain note, no error');
  assert.equal(note('进度：已完成第一步').sender, 'agent');
});

test('a mention never costs the call: the call goes out as asked, the mentioned roles get a copy or the sender is told why', () => {
  const { db, call, targetsOf } = env();
  const both = call({ role: 'Checker', kind: 'direct', text: 'fix it, then @Reviewer checks the totals' });
  assert.deepEqual(targetsOf(both.requestIds), ['c'], 'the call itself keeps its own id, so wb wait with it still works');
  assert.ok(both.requestId.startsWith('r1:c-'));
  assert.deepEqual(targetsOf(both.mentionRequestIds), ['r']);assert.match(both.hint, /@Reviewer/);
  const failed = call({ role: 'Checker', kind: 'consult', text: 'is this right? @Offline too' });
  assert.deepEqual(targetsOf(failed.requestIds), ['c']);assert.match(failed.hint, /@Offline/);assert.equal(failed.mentionRequestIds, undefined);
  assert.deepEqual(targetsOf(call({ role: 'Checker', kind: 'transfer', text: 'yours now; ask @Reviewer if stuck' }).requestIds), ['c'], 'a transfer keeps its one recipient');
});

test('mentions do not wake the caller, a role sent the same call, or a role already working on this turn\'s call', () => {
  const { db, run, call, note } = env();
  call({ role: 'Checker', kind: 'direct', text: 'please fix' });
  assert.equal(note('已交给 @Checker 处理').requestId, undefined, 'Checker already has an open call from this turn');
  db.put('coordinationRequests', { id: 'from-checker', projectId: P, conversationId: P, kind: 'consult', targetRoleId: 'c', status: 'running' });
  db.put('coordinationRequests', { id: 'asked', projectId: P, conversationId: P, kind: 'consult', targetRoleId: 'b', parentRequestId: 'from-checker', callMessageId: 'call:shared', status: 'running', currentRunId: 'r1' });
  db.put('coordinationRequests', { id: 'asked-too', projectId: P, conversationId: P, kind: 'consult', targetRoleId: 'r', parentRequestId: 'from-checker', callMessageId: 'call:shared', status: 'running' });
  const asked = { ...run(), id: 'r9', requestId: 'asked' };
  assert.deepEqual(mentionedRoles(db, asked, '@Checker @Reviewer 答案是 7').map(r => r.id), []);
  assert.deepEqual(mentionedRoles(db, asked, '@Supervisor 请看').map(r => r.id), ['sup']);
});
