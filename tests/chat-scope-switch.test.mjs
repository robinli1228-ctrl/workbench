// A role used in two group chats keeps a main session in each: a CLI switch hands one chat's session over instead of
// refusing, and chat-scoped reads (receipts) stay in their chat.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { RoleSwitches } from '../src/role-switches.mjs';
import { conversationView } from '../src/group-conversations.mjs';

const P = 'p1', now = () => new Date().toISOString();
function env() {
  const db = new Store(':memory:');
  db.put('projects', { id: P, name: 'TMS AI' });
  db.put('groupConversations', { id: 'c2', projectId: P, title: 'tms ai2', createdAt: now() });
  const models = [{ id: 'm' }];
  db.put('workers', { id: 'w1', name: 'server', platform: 'linux', online: true, capacity: 3,
    runtimes: ['grok', 'codex'].map(type => ({ type, supported: true, installed: true, available: true, models, checkedAt: now() })),
    capabilities: { runtimeDiscovery: true, roomRoles: 1, projectSpace: 1, managedResume: 1, roleSwitch: 1, groupConversations: 1 } });
  db.put('workspaces', { id: `${P}:w1`, projectId: P, nodeId: 'w1', localRoot: '/xxxxx' });
  db.put('roles', { id: 'g', projectId: P, name: 'Grok', nodeId: 'w1', runtime: 'grok', model: 'm', mode: 'workspace-write', enabled: true, revision: 1 });
  const session = (id, chat, updatedAt) => db.put('roleSessions', { id, projectId: P, conversationId: chat, groupConversationId: chat, roleId: 'g', nodeId: 'w1', runtime: 'grok', workspaceRoot: '/xxxxx', status: 'idle', generation: 1, nativeSessionId: `n-${id}`, updatedAt });
  session('sA', P, '2026-10-31T01:00:00.000Z');session('sB', 'c2', '2026-10-31T02:00:00.000Z');
  return db;
}
const draft = { name: 'Grok', nodeId: 'w1', runtime: 'codex', model: 'm', mode: 'workspace-write', enabled: true, instructions: '' };

test('a role with a session in two chats can switch CLI: the chat it was started from, else the one used last', () => {
  const db = env(), switches = new RoleSwitches(db);
  let preview;
  try { preview = switches.preview(P, 'g', draft, P); } catch (error) { assert.doesNotMatch(error.message, /Multiple current sessions/);throw error; }
  assert.equal(preview.sourceSessionId, 'sA');assert.equal(preview.conversationId, P);
  assert.equal(switches.preview(P, 'g', draft, 'c2').sourceSessionId, 'sB');
  assert.equal(switches.preview(P, 'g', draft).sourceSessionId, 'sB', 'unspecified: the session used last');
  db.put('roleSessions', { ...db.get('roleSessions', 'sA'), id: 'sA2' });
  assert.throws(() => switches.preview(P, 'g', draft, P), /Multiple current sessions/, 'two current sessions in one chat still need reconciling');
});

test('result receipts read through a chat view are that chat\'s only', () => {
  const db = env();
  db.put('resultReceipts', { id: 'r1', projectId: P, conversationId: P, ownerRoleId: 'g' });
  db.put('resultReceipts', { id: 'r2', projectId: P, conversationId: 'c2', ownerRoleId: 'g' });
  const view = conversationView(db, { projectId: P, conversationId: P });
  assert.deepEqual(view.listProject('resultReceipts', P).map(r => r.id), ['r1']);
});
