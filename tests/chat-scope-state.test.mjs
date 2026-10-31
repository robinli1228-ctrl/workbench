// The page holds one chat's records; what the device decides as a whole (resuming a session in a terminal) comes with the
// state as device occupancy over every chat and project.
import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceState } from '../src/workspace-state.mjs';

test('one chat\'s state carries only its runs, plus device occupancy across chats and projects', () => {
  const run = (id, projectId, conversationId, nodeId, status) => ({ id, projectId, conversationId, nodeId, status, roleId: 'grok' });
  const snapshot = {
    projects: [{ id: 'p1', name: 'TMS AI' }, { id: 'p2', name: 'other' }],
    conversations: [{ id: 'c2', projectId: 'p1', title: 'tms ai2' }],
    runs: [run('a', 'p1', 'p1', 'srv', 'succeeded'), run('b', 'p1', 'c2', 'srv', 'running'), run('c', 'p2', 'p2', 'srv', 'reconciling'), run('d', 'p1', 'c2', 'mac', 'queued')],
    tasks: [], requests: [], roleSessions: [],
  };
  const { state } = workspaceState(snapshot, 'p1', 'p1');
  assert.deepEqual(state.runs.map(r => r.id), ['a'], 'the page lists this chat only');
  assert.deepEqual(state.deviceRuns, { srv: { active: 2, project: 1, reconciling: true }, mac: { active: 1, project: 1, reconciling: false } });
});
