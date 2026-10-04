import { realpath, readdir, stat } from 'node:fs/promises';
import { relative, isAbsolute, dirname, join } from 'node:path';
import { tr } from './i18n.mjs';

/** Check boundaries using canonical paths; the browser cannot widen the Worker's permitted root directories. */
const inside = (root, path) => { const r = relative(root, path); return !r || (r !== '..' && !r.startsWith('../') && !isAbsolute(r)); };
export async function browseFolders(roots, path, offset = 0) {
  if (!Number.isInteger(offset) || offset < 0) throw new Error(tr('folders.invalidDirectoryPagination'));
  if (!path) return { path: null, parent: null, folders: roots.map(p => ({ name: p, path: p })), hasMore: false, nextOffset: 0 };
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error(tr('folders.directoryMustBeAbsolutePath'));
  const current = await realpath(path);
  if (!roots.some(r => inside(r, current))) throw new Error(tr('folders.directoryOutsideRangeNodeAllows'));
  if (!(await stat(current)).isDirectory()) throw new Error(tr('folders.selectFolder'));
  const entries = (await readdir(current, { withFileTypes: true })).filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules').sort((a, b) => a.name.localeCompare(b.name));
  const parent = dirname(current);
  return { path: current, parent: parent !== current && roots.some(r => inside(r, parent)) ? parent : null,
    folders: entries.slice(offset, offset + 200).map(e => ({ name: e.name, path: join(current, e.name) })),
    hasMore: entries.length > offset + 200, nextOffset: offset + 200 };
}
