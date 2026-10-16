import { mkdir, realpath, readFile, writeFile, readdir, access, constants, open } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { tr } from './i18n.mjs';
import { ensureAgentsFiles } from './agents-md.mjs';

/** The stable project folder name does not change with the display name; path traversal and internal management directories are forbidden. */
export function folderName(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) throw new Error(tr('projectSpace.projectFolderNameMustBe'));
  return value;
}

export function within(root, path) {
  const rel = relative(root, path);
  return !rel || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel));
}

/** Pending copies cannot execute or rebind partial directories before the frozen team is published. */
export function assertProjectReady(db,projectId){
  if(db.get('projects',projectId)?.setupStatus==='copy_pending')throw new Error(tr('teamCopy.notReady'));
}

/** The directory is created and permission-checked by the target Worker; a directory with other content or belonging to another project is never taken over. */
export async function prepareProjectSpace(roots, { projectId, folder, workspaceRoot, creationOperationId }) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(projectId || '')) throw new Error(tr('projectSpace.invalidProjectId'));
  folderName(folder);
  const root = await realpath(workspaceRoot || roots[0]);
  if (!roots.some(allowed => within(allowed, root))) throw new Error(tr('projectSpace.workspaceOutsideRangeAllowedOn'));
  const target = join(root, folder);
  const strict=creationOperationId!==undefined;
  if(strict&&(typeof creationOperationId!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(creationOperationId)))throw new Error('invalid_creation_operation');
  let created=false;
  if(strict){try{await mkdir(target);created=true;}catch(e){if(e.code!=='EEXIST')throw e;}}
  else await mkdir(target, { recursive: true });
  if (await realpath(target) !== target) throw new Error(tr('projectSpace.projectDirectoryCannotBeSymbolic'));
  const marker = join(target, '.agent-workbench-project.json');
  let owner;
  try { owner = JSON.parse(await readFile(marker, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if(strict&&((owner&&(owner.projectId!==projectId||owner.creationOperationId!==creationOperationId))||(!owner&&!created)))throw new Error('directory_ownership_unverified');
  if (owner && owner.projectId !== projectId) throw new Error(tr('projectSpace.directoryWithSameNameBelongs'));
  if (!owner) {
    if ((await readdir(target)).length) throw new Error(tr('projectSpace.directoryWithSameNameAlready'));
    if(strict){
      const handle=await open(marker,'wx',0o600);
      try{await handle.writeFile(JSON.stringify({projectId,folder,creationOperationId}));await handle.sync();}finally{await handle.close();}
    }else await writeFile(marker, JSON.stringify({ projectId, folder }), { flag: 'wx', mode: 0o600 });
    await ensureAgentsFiles(target);
  }
  if(strict&&owner)await ensureAgentsFiles(target);
  await access(target, constants.R_OK | constants.W_OK | constants.X_OK);
  return { localRoot: target, git: null, managed: true, folderName: folder, ...(strict?{projectId,creationOperationId}:{}) };
}

/** All repositories of the project are pinned with the run; a role does not need to be bound to one of them. */
export function projectRepositories(db, projectId, nodeId) {
  return db.list('repositories').filter(r => r.projectId === projectId).map(repo => {
    const binding = db.get('repositoryWorkspaces', `${repo.id}:${nodeId}`);
    return { id: repo.id, key: repo.key, repoUrl: repo.repoUrl, accountId: repo.accountId || null,
      localRoot: binding?.localRoot || null, baseBranch:repo.baseBranch || null,
      baselineRoot:binding?.baselineBranch ? binding.localRoot : null, baselineBranch:binding?.baselineBranch || null };
  });
}
