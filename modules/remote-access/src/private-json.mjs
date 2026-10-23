import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** 私有状态不跟随末端软链接，也不擅自修改既有目录的访问权限。 */
export async function ensurePrivateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error('私有目录必须是仅当前用户可访问的目录');
}

/** 缺失是首次运行，损坏或权限错误必须报错，不能静默重置认证。 */
export async function readPrivateJson(file) {
  let stat;
  try { stat = await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error('私有文件权限或类型不正确');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

/** 先写同目录临时文件再替换，失败时不破坏上一次可用状态。 */
export async function writePrivateJson(file, value) {
  await ensurePrivateDirectory(path.dirname(file));
  try { if ((await fs.lstat(file)).isSymbolicLink()) throw new Error('拒绝覆盖软链接'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    await handle.close(); handle = null;
    await fs.rename(temporary, file);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
