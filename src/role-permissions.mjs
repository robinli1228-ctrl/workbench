import { dirname } from 'node:path';

/** Three per-role scopes; a missing value keeps the role's legacy behavior unchanged. */
export const PERMISSION_SCOPES=['project','device','device-approval'];
export const PERMISSION_CONTRACT_VERSION=1;
export const isPermissionScope=value=>PERMISSION_SCOPES.includes(value);

/** Only combinations with real CLI evidence are offered. Codex on Linux enforces the project read/write boundary through a
 *  permission profile (tested with outside, home, symlink and child-process reads); other adapters already run without a
 *  native sandbox, so only "device" describes them honestly. Unlisted combinations stay unavailable. */
export function supportedPermissionScopes(runtime,platform) {
  if(runtime==='codex')return platform==='linux'?['project','device','device-approval']:['device'];
  if(['claude','grok','agy'].includes(runtime))return ['device'];
  return [];
}
export function workerPermissionScopes(platform,runtimes=['codex','claude','grok','agy']) {
  return Object.fromEntries(runtimes.map(runtime=>[runtime,supportedPermissionScopes(runtime,platform)]));
}

/** Home-side check against what the target Worker advertises; an old Worker advertises nothing and accepts only legacy roles. */
export function permissionScopeIssue(worker,runtime,scope) {
  if(scope===undefined||scope===null)return null;
  if(!isPermissionScope(scope))return 'invalid';
  const offered=worker?.capabilities?.permissionScopes?.[runtime];
  if(!Array.isArray(offered))return 'worker_unsupported';
  return offered.includes(scope)?null:'scope_unsupported';
}

/** Codex App Server thread options for a frozen scope. Project scope replaces the legacy sandbox with a named permission
 *  profile: minimal system reads, the Node/CLI install, the Workbench tool directory, and write access to workspace roots only. */
export function codexPermissionOptions(scope,{toolRoots=[],writeRoots=[]}={}) {
  if(scope==='device')return {sandbox:'danger-full-access',approvalPolicy:'never',config:{}};
  if(scope!=='project'&&scope!=='device-approval')return null;
  const reads=[...new Set([dirname(dirname(process.execPath)),...toolRoots].filter(Boolean))];
  const filesystem={':minimal':'read',':workspace_roots':'write',...Object.fromEntries(reads.map(path=>[path,'read'])),
    ...Object.fromEntries([...new Set(writeRoots.filter(Boolean))].map(path=>[path,'write']))};
  return {sandbox:null,approvalPolicy:scope==='device-approval'?'on-request':'never',
    // Network stays on as in the legacy sandbox (Git sync and cross-device tools); a profile alone would turn it off.
    config:{'permissions.workbench_project.filesystem':filesystem,'permissions.workbench_project.network':{enabled:true},default_permissions:'workbench_project'}};
}

/** Role/supervisor saves: an omitted field keeps the saved scope (old clients cannot reset it); a new role on a CLI that
 *  enforces the project boundary starts at "project"; anything else stays legacy until the user picks a scope. */
export function resolveRolePermissionScope({input,old,worker,runtime,configured,isNew,message}) {
  const requested=input?.permissionScope;
  // Empty means "keep" too: the form never offers a way back to the legacy, unlabelled behaviour.
  let scope=requested===undefined||requested===''||requested===null?old?.permissionScope:requested;
  const offered=worker?.capabilities?.permissionScopes?.[runtime];
  if(scope===undefined&&isNew&&configured&&offered?.includes('project'))scope='project';
  // A new role on an upgraded Worker never silently inherits legacy or device-wide access: the user must pick.
  if(scope===undefined&&isNew&&configured&&Array.isArray(offered))throw new Error(message('selectScope'));
  if(scope===undefined)return undefined;
  if(!isPermissionScope(scope))throw new Error(message('invalid',scope));
  // Unconfigured drafts cannot be checked yet; admission checks again against the bound Worker.
  if(configured){const issue=permissionScopeIssue(worker,runtime,scope);if(issue)throw new Error(message(issue,scope));}
  return scope;
}
export const withPermissionScope=(record,scope)=>{const {permissionScope:_,...rest}=record;return scope===undefined?rest:{...rest,permissionScope:scope};};

/** Interactive role terminals use the same scope; approval cannot travel back through Workbench from a terminal, so that scope is refused. */
export function terminalPermissionArgs(runtime,scope,{toolRoots=[]}={}) {
  if(scope===undefined||scope===null)return null;
  if(scope==='device-approval')throw new Error('rolePermissions.terminalApprovalUnsupported');
  if(!supportedPermissionScopes(runtime,process.platform).includes(scope))throw new Error('rolePermissions.scope_unsupported');
  if(runtime!=='codex')return [];
  if(scope==='device')return ['--sandbox','danger-full-access','--ask-for-approval','never'];
  const options=codexPermissionOptions('project',{toolRoots});
  const table=Object.entries(options.config['permissions.workbench_project.filesystem']).map(([k,v])=>`${JSON.stringify(k)}=${JSON.stringify(v)}`).join(',');
  return ['--ask-for-approval','never','-c',`permissions.workbench_project.filesystem={${table}}`,'-c','permissions.workbench_project.network={enabled=true}','-c','default_permissions="workbench_project"'];
}
