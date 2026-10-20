import { realpath, readdir, stat, mkdir, lstat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { relative, isAbsolute, dirname, join, resolve } from 'node:path';
import { tr } from './i18n.mjs';

/** Check boundaries using canonical paths; the browser cannot widen the Worker's permitted root directories. */
const inside = (root, path) => { const r = relative(root, path); return !r || (r !== '..' && !r.startsWith('../') && !isAbsolute(r)); };

/** Keep standalone sessions outside managed projects; create one child and preserve existing files on reuse. */
/** A folder name typed by the user becomes one path segment: no separators, no hidden or relative names, at most 80 characters. */
export function sessionFolderName(value) {
  const name = String(value || '').trim().replace(/[\\/\0:*?"<>|]+/g, '-').replace(/\s+/g, ' ').slice(0, 80).replace(/^[-. ]+|[-. ]+$/g, '');
  return name && name !== '.' && name !== '..' ? name : 'session';
}

/**
 * Default folder for a new native session. Without a project: <device workspace root>/native-sessions, which must not touch a
 * project folder. With a project: <project folder on this device>/native-sessions/<name>, created for this session, so the
 * session's files live with the project (and its group chat pauses while the session holds the folder, by design).
 */
export async function prepareNativeSessionFolder(roots, workspaceRoot, bindings = [], { projectRoot = null, name = null } = {}) {
  const allowed = await Promise.all(roots.map(root => realpath(root)));
  if (projectRoot) {
    const parent = await realpath(projectRoot);
    if (!allowed.some(root => inside(root, parent))) throw new Error(tr('folders.directoryOutsideRangeNodeAllows'));
    // Check each parent before creating its child; recursive mkdir would follow an existing intermediate symlink before rejection.
    let target = parent;
    for (const segment of ['native-sessions', sessionFolderName(name)]) {
      if (!(await lstat(target)).isDirectory() || await realpath(target) !== target) throw new Error('Session folder is not a regular directory; select another folder.');
      target = join(target, segment);
      try { await mkdir(target); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    if (!(await lstat(target)).isDirectory() || await realpath(target) !== target) throw new Error('Session folder is not a regular directory; select another folder.');
    await access(target, constants.R_OK | constants.W_OK | constants.X_OK);
    return { path: target };
  }
  const parent = await realpath(workspaceRoot), target = join(parent, 'native-sessions');
  if (!allowed.some(root => inside(root, parent))) throw new Error(tr('folders.directoryOutsideRangeNodeAllows'));
  for (const binding of bindings) {
    if (!binding.localRoot) continue;
    const root = await realpath(binding.localRoot).catch(error => { if (error.code === 'ENOENT') return resolve(binding.localRoot); throw error; });
    if (inside(root, target) || inside(target, root)) throw new Error('Default session folder overlaps a project; select another folder.');
  }
  try { await mkdir(target); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (!(await lstat(target)).isDirectory() || await realpath(target) !== target) throw new Error('Default session folder is not a regular directory; select another folder.');
  await access(target, constants.R_OK | constants.W_OK | constants.X_OK);
  return { path: target };
}

/** Create one visible child only; resolve the parent on the Worker and never overwrite an existing entry. */
export async function createFolder(roots, path, name) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error(tr('folders.directoryMustBeAbsolutePath'));
  if (typeof name !== 'string' || !name.trim() || name !== name.trim() || name.startsWith('.') || name === 'node_modules'
    || /[\\/\x00-\x1f\x7f]/.test(name) || Buffer.byteLength(name, 'utf8') > 255) throw new Error(tr('folders.invalidFolderName'));
  const parent = await realpath(path);
  if (!roots.some(root => inside(root, parent))) throw new Error(tr('folders.directoryOutsideRangeNodeAllows'));
  if (!(await stat(parent)).isDirectory()) throw new Error(tr('folders.selectFolder'));
  const target = join(parent, name);
  try { await mkdir(target); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(tr('folders.folderAlreadyExists')); throw error; }
  return { path: target, parent, name };
}

export async function browseFolders(roots, path, offset = 0, options = { includeFiles: false }) {
  if (!Number.isInteger(offset) || offset < 0) throw new Error(tr('folders.invalidDirectoryPagination'));
  const includeFiles = options?.includeFiles === true;
  if (!path) {
    const rootFolders = roots;
    if (!includeFiles) return { path: null, parent: null, folders: rootFolders.map(p => ({ name: p, path: p })), hasMore: false, nextOffset: 0 };
    const allEntries = rootFolders.map(p => ({ name: p, path: p, type: 'folder', workspace: p }));
    const entries = allEntries.slice(offset, offset + 200);
    return { path: null, parent: null, folders: entries.map(({ name, path }) => ({ name, path })), entries,
      hasMore: allEntries.length > offset + 200, nextOffset: allEntries.length > offset + 200 ? offset + 200 : 0 };
  }
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error(tr('folders.directoryMustBeAbsolutePath'));
  // Worker startup canonicalizes roots; an unrelated unmounted root must not block a valid selection.
  const canonicalRoots = roots;
  const selected = await realpath(path);
  if (!canonicalRoots.some(r => inside(r, selected))) throw new Error(tr('folders.directoryOutsideRangeNodeAllows'));
  const selectedStat = await stat(selected);
  let current = selected, selectedPath;
  if (!selectedStat.isDirectory()) {
    if (!includeFiles || !selectedStat.isFile()) throw new Error(tr('folders.selectFolder'));
    current = dirname(selected);
    if (!canonicalRoots.some(r => inside(r, current))) throw new Error(tr('folders.directoryOutsideRangeNodeAllows'));
    selectedPath = selected;
  }
  const allDirectories=options?.allDirectories===true;
  const allowed = (await readdir(current, { withFileTypes: true }))
    .filter(e => (allDirectories||!e.name.startsWith('.') && e.name !== 'node_modules') && (e.isDirectory() || includeFiles && e.isFile()))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  const page = allowed.slice(offset, offset + 200);
  const folders = page.filter(e => e.isDirectory()).map(e => ({ name: e.name, path: join(current, e.name) }));
  const parent = dirname(current);
  const result = { path: current, parent: parent !== current && canonicalRoots.some(r => inside(r, parent)) ? parent : null, folders,
    hasMore: allowed.length > offset + 200, nextOffset: offset + 200 };
  if (includeFiles) result.entries = page.map(e => {
    const entryPath = join(current, e.name), type = e.isDirectory() ? 'folder' : 'file';
    return { name: e.name, path: entryPath, type, workspace: type === 'folder' ? entryPath : current };
  });
  if (selectedPath) result.selectedPath = selectedPath;
  return result;
}
