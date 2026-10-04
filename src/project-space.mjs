import { mkdir, realpath, readFile, writeFile, readdir, access, constants } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';

/** The stable project folder name does not change with the display name; path traversal and internal management directories are forbidden. */
export function folderName(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) throw new Error('The project folder name must be 1-64 letters, digits, hyphens, or underscores');
  return value;
}

export function within(root, path) {
  const rel = relative(root, path);
  return !rel || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel));
}

/** The directory is created and permission-checked by the target Worker; a directory with other content or belonging to another project is never taken over. */
export async function prepareProjectSpace(roots, { projectId, folder, workspaceRoot }) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(projectId || '')) throw new Error('Invalid project ID');
  folderName(folder);
  const root = await realpath(workspaceRoot || roots[0]);
  if (!roots.some(allowed => within(allowed, root))) throw new Error('The workspace is outside the range allowed on the device');
  const target = join(root, folder);
  await mkdir(target, { recursive: true });
  if (await realpath(target) !== target) throw new Error('The project directory cannot be a symbolic link');
  const marker = join(target, '.agent-workbench-project.json');
  let owner;
  try { owner = JSON.parse(await readFile(marker, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (owner && owner.projectId !== projectId) throw new Error('A directory with the same name belongs to another project; choose a different folder name');
  if (!owner) {
    if ((await readdir(target)).length) throw new Error('A directory with the same name already has files; use "link an existing directory" in the project settings');
    await writeFile(marker, JSON.stringify({ projectId, folder }), { flag: 'wx', mode: 0o600 });
  }
  await access(target, constants.R_OK | constants.W_OK | constants.X_OK);
  return { localRoot: target, git: null, managed: true, folderName: folder };
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
