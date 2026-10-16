// Per-role permission scopes: only verified CLI/OS combinations are offered, an omitted field keeps the saved scope,
// admission freezes the scope into the run, and Codex receives exactly the matching sandbox/profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { supportedPermissionScopes, codexPermissionOptions, resolveRolePermissionScope, permissionScopeIssue } from '../src/role-permissions.mjs';
import { warmSessionFingerprint } from '../src/warm-sessions.mjs';
import { CodexSession } from '../src/codex.mjs';
import { Store } from '../src/store.mjs';
import { Rooms } from '../src/rooms.mjs';

const message = code => `permission:${code}`;
const worker = scopes => ({ id: 'w1', online: true, capabilities: { permissionScopes: scopes } });

test('only verified combinations are offered', () => {
  assert.deepEqual(supportedPermissionScopes('codex', 'linux'), ['project', 'device', 'device-approval']);
  assert.deepEqual(supportedPermissionScopes('codex', 'darwin'), ['device'], 'Mac Codex profile is not yet verified');
  for (const runtime of ['claude', 'grok', 'agy']) assert.deepEqual(supportedPermissionScopes(runtime, 'linux'), ['device']);
  assert.equal(permissionScopeIssue({ capabilities: {} }, 'codex', 'project'), 'worker_unsupported');
  assert.equal(permissionScopeIssue(worker({ claude: ['device'] }), 'claude', 'project'), 'scope_unsupported');
  assert.equal(permissionScopeIssue(worker({}), 'codex', undefined), null, 'legacy roles need no capability');
});

test('Codex options match each scope', () => {
  assert.deepEqual(codexPermissionOptions('device'), { sandbox: 'danger-full-access', approvalPolicy: 'never', config: {} });
  const project = codexPermissionOptions('project', { toolRoots: ['/opt/wb'], writeRoots: ['/repo/.git'] });
  assert.equal(project.sandbox, null, 'a profile cannot be combined with sandbox_mode');
  assert.equal(project.approvalPolicy, 'never');
  assert.equal(project.config.default_permissions, 'workbench_project');
  const fs = project.config['permissions.workbench_project.filesystem'];
  assert.equal(fs[':minimal'], 'read'); assert.equal(fs[':workspace_roots'], 'write'); assert.equal(fs['/opt/wb'], 'read'); assert.equal(fs['/repo/.git'], 'write');
  assert.deepEqual(project.config['permissions.workbench_project.network'], { enabled: true });
  assert.equal(codexPermissionOptions('device-approval').approvalPolicy, 'on-request');
  assert.equal(codexPermissionOptions(undefined), null);
});

test('saves keep, default and validate the scope', () => {
  const codex = worker({ codex: ['project', 'device', 'device-approval'], claude: ['device'] });
  const base = { worker: codex, runtime: 'codex', configured: true, message };
  assert.equal(resolveRolePermissionScope({ ...base, input: {}, old: null, isNew: true }), 'project', 'new Codex roles start at project');
  assert.equal(resolveRolePermissionScope({ ...base, input: {}, old: { permissionScope: 'device' }, isNew: false }), 'device', 'old clients keep the saved scope');
  assert.equal(resolveRolePermissionScope({ ...base, input: { permissionScope: '' }, old: { permissionScope: 'device' }, isNew: false }), 'device');
  assert.equal(resolveRolePermissionScope({ ...base, input: {}, old: {}, isNew: false }), undefined, 'legacy roles stay legacy');
  assert.equal(resolveRolePermissionScope({ ...base, worker: worker(undefined), input: {}, old: null, isNew: true }), undefined, 'old Worker: no silent default');
  assert.throws(() => resolveRolePermissionScope({ ...base, runtime: 'claude', input: { permissionScope: 'project' }, old: null, isNew: true }), /scope_unsupported/);
  assert.throws(() => resolveRolePermissionScope({ ...base, input: { permissionScope: 'root' }, old: null, isNew: true }), /invalid/);
  assert.throws(() => resolveRolePermissionScope({ ...base, runtime: 'claude', input: {}, old: { permissionScope: 'project' }, isNew: false }), /scope_unsupported/, 'a runtime change re-validates');
});

test('warm processes never cross scopes and legacy fingerprints are unchanged', () => {
  const base = { folder: '/p', runtimeType: 'codex', model: 'm', effort: null, roleName: 'r', roleInstructions: 'i', env: {} };
  assert.equal(warmSessionFingerprint(base), warmSessionFingerprint({ ...base, permissionScope: null }));
  assert.notEqual(warmSessionFingerprint({ ...base, permissionScope: 'project' }), warmSessionFingerprint({ ...base, permissionScope: 'device' }));
});

async function threadOptions(extra) {
  const session = new CodexSession({ cwd: tmpdir(), model: 'm', emit: () => {}, toolRoots: ['/opt/wb'], ...extra });
  let sent;
  session.request = async (method, params) => { sent = { method, params }; return { thread: { id: 't' } }; };
  try { await session.openThread(); } catch {}
  return { session, sent };
}
test('Codex threads use the frozen scope; legacy roles keep the workspace sandbox', async () => {
  const legacy = await threadOptions({});
  assert.equal(legacy.sent.params.sandbox, 'workspace-write');
  assert.equal(legacy.sent.params.approvalPolicy, 'never');
  const project = await threadOptions({ permissionScope: 'project' });
  assert.equal(project.sent.params.sandbox, undefined);
  assert.equal(project.sent.params.config.default_permissions, 'workbench_project');
  assert.equal(project.sent.params.config['sandbox_workspace_write.writable_roots'], undefined);
  const device = await threadOptions({ permissionScope: 'device' });
  assert.equal(device.sent.params.sandbox, 'danger-full-access');
  const approval = await threadOptions({ permissionScope: 'device-approval' });
  assert.equal(approval.sent.params.approvalPolicy, 'on-request');
  assert.equal(approval.session.autoApprove, false, 'escalations go to the human, never auto-accepted');
  const maintenance = await threadOptions({ permissionScope: 'device', maintenance: true });
  assert.equal(maintenance.sent.params.sandbox, 'read-only', 'switch maintenance keeps its read-only boundary');
});

test('role saves store the scope and old clients cannot reset it', () => {
  const db = new Store(':memory:');
  db.put('projects', { id: 'p1', name: 'demo' });
  db.put('workspaces', { id: 'p1:w1', projectId: 'p1', nodeId: 'w1', localRoot: '/tmp' });
  db.put('workers', { id: 'w1', name: 'srv', online: true, capabilities: { runtimeDiscovery: true, permissionScopes: { codex: ['project', 'device', 'device-approval'] } },
    runtimes: [{ type: 'codex', supported: true, available: true, authReady: true, checkedAt: new Date().toISOString(), models: [{ id: 'm', efforts: [] }] }] });
  const rooms = new Rooms(db);
  const role = rooms.saveRole('p1', { name: 'dev', nodeId: 'w1', runtime: 'codex', model: 'm', instructions: '', enabled: true });
  assert.equal(role.permissionScope, 'project');
  const device = rooms.saveRole('p1', { id: role.id, name: 'dev', nodeId: 'w1', runtime: 'codex', model: 'm', instructions: '', enabled: true, permissionScope: 'device', revision: role.revision });
  assert.equal(device.permissionScope, 'device');
  const renamed = rooms.saveRole('p1', { id: role.id, name: 'dev2', nodeId: 'w1', runtime: 'codex', model: 'm', instructions: '', enabled: true, revision: device.revision });
  assert.equal(renamed.permissionScope, 'device');
});

test('the built-in supervisor template asks the dispatcher to own and follow up its goals', async () => {
  const { runWithLanguage } = await import('../src/i18n.mjs');
  const { defaultSupervisorPrompt } = await import('../src/platform-prompts.mjs');
  assert.match(await runWithLanguage('en', () => defaultSupervisorPrompt()), /Goal ownership/);
  assert.match(await runWithLanguage('zh', () => defaultSupervisorPrompt()), /目标负责/);
});
