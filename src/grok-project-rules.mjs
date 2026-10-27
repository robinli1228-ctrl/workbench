import { readFile, stat, realpath } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { homedir } from 'node:os';
import { sentText } from './input-language.mjs';

const MAX_BYTES = 64 * 1024;
const real = path => realpath(path).catch(() => resolve(path));
const exists = path => stat(path).then(() => true, () => false);

/** Folders Grok already trusts, from basic- or literal-quoted keys in trusted_folders.toml. */
async function trustedFolders(grokHome) {
  let text;
  try { text = await readFile(join(grokHome, 'trusted_folders.toml'), 'utf8'); } catch { return []; }
  const trusted = [];
  let folder = null;
  for (const line of text.split('\n')) {
    const header = line.match(/^\s*\[folders\.(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\]\s*$/);
    if (header) { folder = header[1] !== undefined ? header[1].replace(/\\(.)/g, '$1') : header[2]; continue; }
    if (/^\s*\[/.test(line)) { folder = null; continue; }
    if (folder && /^\s*trusted\s*=\s*true\s*$/.test(line)) trusted.push(folder);
  }
  return trusted;
}

/** Folder trust switched off means Grok loads project rules everywhere by itself. */
async function trustDisabled(grokHome, env) {
  if (env.GROK_FOLDER_TRUST === '0' || env.GROK_FOLDER_TRUST === 'false') return true;
  try { return /^\s*\[folder_trust\][^[]*?^\s*enabled\s*=\s*false\s*$/m.test(await readFile(join(grokHome, 'config.toml'), 'utf8')); } catch { return false; }
}

/** Trust covers the folder and its subfolders in the same repository; a nested checkout below it is a separate workspace. */
async function coveredBy(folder, cwd) {
  const rel = relative(folder, cwd);
  if (rel.startsWith('..') || isAbsolute(rel)) return false;
  for (let dir = cwd; dir !== folder && dir !== dirname(dir); dir = dirname(dir)) if (await exists(join(dir, '.git'))) return false;
  return true;
}

/**
 * Grok loads a folder's AGENTS.md only after the folder is trusted, and trusting it also turns on hooks, MCP and project skills.
 * Workbench reads the AGENTS.md in the run folder itself and sends it with the rules instead. When Grok loads the file by itself,
 * a one-line pointer stands in, so a folder trusted mid-session does not read as revoking the rules.
 */
export async function grokProjectRules(cwd, { grokHome = process.env.GROK_HOME || join(homedir(), '.grok'), env = process.env } = {}) {
  const path = join(cwd, 'AGENTS.md');
  let info;
  try { info = await stat(path); } catch { return ''; }
  if (!info.isFile()) return '';
  const folder = await real(cwd);
  if (await trustDisabled(grokHome, env)) return sentText('turnInput.projectRulesNative', { path });
  for (const trusted of await trustedFolders(grokHome)) if (await coveredBy(await real(trusted), folder)) return sentText('turnInput.projectRulesNative', { path });
  if (info.size > MAX_BYTES) return sentText('turnInput.projectRulesTooLarge', { path });
  let text;
  try { text = (await readFile(path, 'utf8')).trim(); } catch { return sentText('turnInput.projectRulesUnreadable', { path }); }
  return sentText('turnInput.projectRules', { path, text });
}
