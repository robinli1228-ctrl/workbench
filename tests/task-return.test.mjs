// A chat task goes back to its owner once when the last turn on it ends without closing it or handing it on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { RoleCalls } from '../src/role-calls.mjs';
import { wakeTaskReturns } from '../src/task-return.mjs';

const P = 'p1', at = '2026-11-05T03:00:00Z';
function env() {
  const db = new Store(':memory:'), calls = new RoleCalls(db), posted = [];
  db.put('projects', { id: P, name: 'Chat', root: '/tmp/chat' });
  db.put('workspaces', { id: `${P}:w1`, projectId: P, nodeId: 'w1', root: '/tmp/chat' });
  for (const id of ['owner', 'dev']) db.put('roles', { id, projectId: P, name: id === 'owner' ? 'Lead' : 'Dev', enabled: true, nodeId: 'w1', runtime: 'claude', model: 'm' });
  db.put('conversationTasks', { id: 'ct:1', projectId: P, conversationId: P, number: 3, title: 'Ship it', status: 'in_progress', ownerRoleId: 'owner' });
  const call = (id, extra) => db.put('coordinationRequests', { id, projectId: P, conversationId: P, kind: 'direct', targetRoleId: 'dev', createdAt: at, ...extra });
  const end = (runId, requestId, extra = {}) => {
    db.put('runs', { id: runId, projectId: P, roleId: 'dev', requestId, status: 'succeeded', result: 'Done: tests pass.', roleSnapshot: { name: 'Dev' }, createdAt: at, ...extra });
    db.put('coordinationRequests', { ...db.get('coordinationRequests', requestId), status: 'running', currentRunId: runId });
    calls.finish(runId);
  };
  const wake = () => wakeTaskReturns(db, (item, text) => { posted.push({ item, text }); return { id: item.id }; });
  return { db, call, end, wake, posted };
}

test('a transferred owner that finishes without closing gets the task back once, with the conclusion', () => {
  const { call, end, wake, posted } = env();
  call('transfer', { conversationTaskId: 'ct:1', transferredFrom: 'x' });
  end('run-1', 'transfer');
  assert.equal(wake(), true);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].item.ownerRoleId, 'owner');assert.equal(posted[0].item.conversationTaskId, 'ct:1');
  assert.match(posted[0].text, /T3/);assert.match(posted[0].text, /Done: tests pass\./);assert.match(posted[0].text, /run-1/);
  assert.equal(wake(), false, 'one return per finished turn');
});

test('the turn a return started is not returned again; a closed task, a failed turn or a turn that handed on is not returned', () => {
  const { db, call, end, wake, posted } = env();
  call('returned', { conversationTaskId: 'ct:1', taskReturn: true });
  end('run-r', 'returned');
  call('failed', { conversationTaskId: 'ct:1' });
  end('run-f', 'failed', { status: 'failed', error: 'boom' });
  call('handed', { conversationTaskId: 'ct:1' });
  call('next', { conversationTaskId: 'ct:1', sourceRunId: 'run-h', status: 'succeeded' });
  end('run-h', 'handed');
  call('unlinked', {});
  end('run-u', 'unlinked');
  wake();
  assert.deepEqual(posted, []);
  call('late', { conversationTaskId: 'ct:1' });
  end('run-l', 'late');
  db.put('conversationTasks', { ...db.get('conversationTasks', 'ct:1'), status: 'done' });
  wake();
  assert.deepEqual(posted, [], 'closed in the meantime');
});

test('a caller waiting for the result is the end of the chain; a caller still running is waited for; parallel work defers', () => {
  const { db, call, end, wake, posted } = env();
  call('parent', { targetRoleId: 'owner', taskId: 'tp', currentRunId: 'run-p0', status: 'waiting_call', waitRequestIds: ['child'] });
  call('child', { conversationTaskId: 'ct:1', parentRequestId: 'parent' });
  end('run-c', 'child');
  wake();
  assert.deepEqual(posted, [], 'the waiting caller continues and owns the end');
  assert.equal(db.list('taskReturns').length, 0);

  call('busy', { targetRoleId: 'owner', taskId: 'tb', status: 'running' });
  call('child2', { conversationTaskId: 'ct:1', parentRequestId: 'busy' });
  end('run-c2', 'child2');
  wake();
  assert.deepEqual(posted, [], 'the caller may still wait');
  assert.equal(db.list('taskReturns').length, 1);
  db.put('coordinationRequests', { ...db.get('coordinationRequests', 'busy'), status: 'succeeded' });
  call('sibling', { conversationTaskId: 'ct:1', status: 'running' });
  wake();
  assert.deepEqual(posted, [], 'other work on the task is still going');
  assert.equal(db.list('taskReturns').length, 0);
});

test('a wake for results of one task belongs to that task', () => {
  const { db, call } = env(), calls = new RoleCalls(db);
  db.put('runs', { id: 'run-p', projectId: P, roleId: 'owner', status: 'succeeded', createdAt: at });
  call('parent', { targetRoleId: 'owner', taskId: 'tp', status: 'waiting_call', currentRunId: 'run-p', waitRequestIds: ['child'], resumeSummary: 'continue' });
  call('child', { conversationTaskId: 'ct:1', parentRequestId: 'parent', status: 'succeeded', result: 'ok' });
  calls.resume('parent');
  const next = db.get('coordinationRequests', db.get('coordinationRequests', 'parent').continuationRequestId);
  assert.equal(next.kind, 'continuation');
  assert.equal(next.conversationTaskId, 'ct:1');
});
