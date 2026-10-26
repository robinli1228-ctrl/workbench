import { mkdir, readFile, writeFile, readdir, stat, realpath } from 'node:fs/promises';
import {createHash} from 'node:crypto';
import { agentRequest } from './agent-bridge.mjs';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tr } from './i18n.mjs';
import {hostname} from 'node:os';
import {handoffDirectory} from './handoff-paths.mjs';

const exec = promisify(execFile);
const now = () => new Date().toISOString();

function env(name, fallback = '') {
  return String(process.env[name] || fallback).trim();
}

/** wb history search [KEYWORDS] [--role NAME]... [--file PATH] [--since TIME] [--until TIME] [--limit N] [--cursor C] [-- KEYWORDS]
 *  TIME: 30m / 2h / 3d / 1w (that long ago), today / yesterday (local midnight), a date (local; --until covers the whole day)
 *  or a full time. Times are resolved here, on the machine the CLI runs on, and sent to Home as ISO times. */
export function historySearchInput(args, now = new Date()) {
  const input = {}, words = [], roles = [];
  const day = (offset, end) => { const d = new Date(now); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + offset + (end ? 1 : 0)); return end ? new Date(d.getTime() - 1) : d; };
  const time = (value, end) => {
    const text = String(value || '').trim(), relative = text.match(/^(\d+)\s*(m|min|h|d|w)$/i);
    if (relative) { const unit = { m: 60e3, min: 60e3, h: 3600e3, d: 86400e3, w: 604800e3 }[relative[2].toLowerCase()]; return new Date(now.getTime() - Number(relative[1]) * unit).toISOString(); }
    if (/^(today|\u4eca\u5929)$/i.test(text)) return (end ? now : day(0, false)).toISOString();
    if (/^(yesterday|\u6628\u5929)$/i.test(text)) return day(-1, end).toISOString();
    const date = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (date) { const d = new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3])); if (end) d.setDate(d.getDate() + 1); return new Date(d.getTime() - (end ? 1 : 0)).toISOString(); }
    const ms = Date.parse(text);
    if (!Number.isFinite(ms)) throw new Error(tr('wbTools.historySearchUsage'));
    return new Date(ms).toISOString();
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { words.push(...args.slice(i + 1)); break; }
    if (!arg.startsWith('--')) { words.push(arg); continue; }
    const value = args[i + 1];
    if (value === undefined || !['--role', '--file', '--since', '--until', '--limit', '--cursor'].includes(arg) || (arg !== '--role' && input[arg.slice(2)] !== undefined)) throw new Error(tr('wbTools.historySearchUsage'));
    i++;
    if (arg === '--role') roles.push(value);
    else if (arg === '--limit') { if (!/^\d+$/.test(value)) throw new Error(tr('wbTools.historySearchUsage')); input.limit = Number(value); }
    else if (arg === '--since' || arg === '--until') input[arg.slice(2)] = time(value, arg === '--until');
    else input[arg.slice(2)] = value;
  }
  if (roles.length) input.role = roles.length === 1 ? roles[0] : roles;
  return { query: words.join(' '), ...input };
}

export function context() {
  const projectRoot = env('WB_PROJECT_ROOT');
  const knowledge = env('WB_KNOWLEDGE') || (projectRoot ? join(projectRoot, '.workbench') : '');
  return {
    projectRoot,
    knowledge,
    workspace: env('WB_WORKSPACE'),
    runId: env('WB_RUN_ID'),
    roleSessionId: env('WB_ROLE_SESSION_ID'),
    nodeId:env('WB_NODE_ID')||`local-${createHash('sha256').update(hostname()).digest('hex')}`,
    role: env('WB_ROLE'),
    hop: Number(env('WB_HOP') || 0),
    home: env('WB_HOME'),
    token: env('WB_TOKEN'),
    mode: env('WB_MODE'),reviewPrivate:env('WB_REVIEW_PRIVATE'),documentViews:env('WB_DOCUMENT_VIEWS')==='1'
  };
}

function inside(root, path) {
  const rel = relative(root, path);
  return !rel || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function ensureKnowledge(dir) {
  if (!dir) throw new Error(tr('wbTools.wbKnowledgeWbProjectRoot'));
  await mkdir(join(dir, 'docs'), { recursive: true });
  await mkdir(join(dir, 'handoffs'), { recursive: true });
  return dir;
}

async function homeFetch(pathname, payload) {
  const ctx = context();
  if (!ctx.home) throw new Error(tr('wbTools.wbHomeNotSet'));
  return agentRequest(pathname, payload);
}

export async function chatPost(text) {
  if (!String(text || '').trim()) throw new Error(tr('wbTools.chatNeedsText'));
  return homeFetch('/api/agent/note', { runId: context().runId, text: String(text).trim() });
}

/** Sending is queued in Home with a stable ID; credentials and project identity never come from tool input. */
export async function notifySupervisor(action,input) {
  if (process.env.WB_SYSTEM_SUPERVISOR !== '1') throw new Error(tr('wechatChannel.supervisorOnly'));
  return homeFetch('/api/agent/notify',{runId:context().runId,action,input});
}

/** The platform handles cross-node communication; local tools neither connect to other CLIs directly nor read their workspaces. */
/** Optional dispatch fields become labelled lines ahead of the free text; nothing is trimmed, so versions, scope and acceptance survive verbatim. */
export function composeCallText({goal,scope,input,returns,text}) {
  const fields=[['goal',goal],['scope',scope],['input',input],['return',returns]].filter(([,value])=>value!==undefined);
  if(fields.some(([,value])=>typeof value!=='string'||!value.trim()))throw new Error(tr('wbTools.callFieldEmpty'));
  return [...fields.map(([key,value])=>`${tr(`wbTools.callField.${key}`)}: ${value.trim()}`),...(text?[text]:[])].join('\n')||text;
}

export async function callRole({ role, roles, kind = 'consult', requestId, text, file, deliveryId,sourceSyncBatchId,task,goal,scope,input,returns }) {
  text=composeCallText({goal,scope,input,returns,text});
  if ((!role && !roles) || !text || !requestId) throw new Error(tr('wbTools.roleTextStableRequestId'));
  // A soft hint only, measured on the brief itself (not an attached --file): the call is sent unchanged.
  const lengthNote=text.length>1500?tr('wbTools.callTextLong',{chars:text.length}):null;
  if(role!==undefined&&roles!==undefined||roles!==undefined&&(!Array.isArray(roles)||!roles.length||roles.some(r=>typeof r!=='string'||!r.trim())))throw new Error(tr('wbTools.invalidCallTargets'));
  if (!['consult', 'handoff','direct','transfer'].includes(kind)) throw new Error(tr('wbTools.kindMustBeConsultHandoff'));
  if(file!==undefined) {
    const document=await callDocument(file);
    // Quoted JSON remains reference data through language conversion and preserves the exact Unicode text and digest.
    text=`${text}\n\n${tr('wbTools.callDocumentReference')}\n${JSON.stringify(document)}`;
  }
  if(text.length>12000)throw new Error(tr('wbTools.callDocumentTooLong'));
  const result=await homeFetch('/api/agent/calls', { runId: context().runId, ...(roles===undefined?{role}:{roles}), kind,
    requestId: `${context().runId}:${requestId}`, text, deliveryId,sourceSyncBatchId,...(task===undefined?{}:{task}) });
  return lengthNote&&result&&typeof result==='object'?{...result,lengthNote}:result;
}

/** Read only caller-bound files; copying bytes here avoids asking the model to retype an encoded document. */
export async function callDocument(file,ctx=context()) {
  if(ctx.reviewPrivate)throw new Error(tr('wbTools.callDocumentReviewGuard'));
  if(typeof file!=='string'||!file.trim())throw new Error(tr('wbTools.callDocumentNotText'));
  const base=ctx.workspace||ctx.projectRoot;
  if(!base)throw new Error(tr('wbTools.wbProjectRootNotSet'));
  const roots=[base,ctx.projectRoot,ctx.knowledge,...JSON.parse(env('WB_REPOSITORIES','[]')).map(r=>r.localRoot)].filter(Boolean);
  // A relative path is looked up in the workspace, then the project root, then knowledge, in that fixed order.
  // Only "not found" moves on to the next base; every hit still passes the same realpath and allow-list check.
  let target=null;
  for(const candidate of [...new Set([base,ctx.projectRoot,ctx.knowledge].filter(Boolean))]){
    try{target=await realpath(resolve(candidate,file));break;}
    catch(error){if(error?.code!=='ENOENT'||isAbsolute(file))throw error;}
  }
  if(!target)throw Object.assign(new Error(`ENOENT: no such file or directory, realpath '${resolve(base,file)}'`),{code:'ENOENT'});
  const allowed=await Promise.all(roots.map(root=>realpath(root).catch(()=>null)));
  const owner=allowed.find(root=>root&&inside(root,target));
  if(!owner)throw new Error(tr('wbTools.callDocumentOutside'));
  const info=await stat(target);
  if(!info.isFile())throw new Error(tr('wbTools.notFile'));
  if(info.size>200000)throw new Error(tr('wbTools.fileExceeds200kbUseShorter'));
  const bytes=await readFile(target);
  if(bytes.length>200000)throw new Error(tr('wbTools.fileExceeds200kbUseShorter'));
  let text;
  try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{throw new Error(tr('wbTools.callDocumentNotText'));}
  if(text.includes('\0'))throw new Error(tr('wbTools.callDocumentNotText'));
  return {path:relative(owner,target),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),text};
}

export async function conversationTask(action,input={}) {
  if(action==='create'){
    if(typeof input.requestId!=='string'||!input.requestId)throw new Error(tr('conversationTasks.requestId'));
    input={...input,requestId:`${context().runId}:${input.requestId}`};
  }
  return homeFetch('/api/agent/conversation-tasks',{runId:context().runId,action,input});
}

export async function waitForRole(summary,options={}) {
  return homeFetch('/api/agent/wait', { runId: context().runId, summary,requestIds:options.requestIds,timeoutSeconds:options.timeoutSeconds });
}

/** Flags may precede or follow the positional delivery arguments. */
export function parseDeliveryArgs(args) {
  const words=[],repos=[];let review=false;
  for(let i=0;i<args.length;i++) {
    if(args[i]==='--review')review=true;
    else if(args[i]==='--repo') {if(!args[i+1]||args[i+1].startsWith('--'))throw new Error(tr('wbTools.deliveryUsage'));repos.push(args[++i]);}
    else if(args[i]==='--'){words.push(...args.slice(i+1));break;}
    else words.push(args[i]);
  }
  return {requestId:words[0],commit:words[1],summary:words.slice(2).join(' '),review,repos};
}

/** Resolve only selected repositories; no filesystem probing of omitted repositories for auto. */
export async function deliveryItems(repositories, commit, {review=false,repos=[]}={}) {
  if(repos.length&&!review)throw new Error(tr('wbTools.deliveryRepoReviewOnly'));
  let selected=repositories;
  if(repos.length) {
    selected=repos.map(key=>{
      const matches=repositories.filter(r=>r.id===key||r.key===key);
      if(matches.length!==1)throw new Error(tr('wbTools.deliveryRepoUnknown',{key,keys:repositories.map(r=>r.key||r.id).join(', ')}));
      return matches[0];
    });
    if(new Set(selected.map(r=>r.id)).size!==selected.length)throw new Error(tr('wbTools.deliveryRepoDuplicate'));
  }
  if(!selected.length)throw new Error(tr('wbTools.currentRunHasNoDeliverable'));
  if(commit!=='auto') {
    if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit))throw new Error(tr('wbTools.deliveryUsage'));
    if(repos.length>1)throw new Error(tr('wbTools.deliveryShaManyRepos'));
    if(!review&&repositories.length>1)throw new Error(tr('gitDelivery.projectDeliveryRequiresAuto'));
    const matches=[];
    for(const repo of selected) {try {await exec('git',['cat-file','-e',`${commit}^{commit}`],{cwd:repo.localRoot,timeout:5000});matches.push(repo);}catch{}}
    if(matches.length!==1)throw new Error(tr(matches.length?'wbTools.deliveryShaAmbiguous':'wbTools.deliveryShaMissing'));
    selected=matches;
  }
  const items=[];
  for(const repo of selected) {
    const head=commit==='auto'?(await exec('git',['rev-parse','HEAD'],{cwd:repo.localRoot,timeout:5000})).stdout.trim():commit;
    items.push({id:repo.id,repoUrl:repo.repoUrl,commit:head});
  }
  return items;
}

/** A distinct review endpoint fails closed on older Homes instead of silently advancing baselines. */
export async function requestDelivery(requestId, commit, summary, { review = false, repos=[] } = {}) {
  if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(requestId)
    || typeof commit !== 'string' || (commit !== 'auto' && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit))
    || typeof summary !== 'string' || !summary.trim() || summary.length > 8000) throw new Error(tr('wbTools.deliveryUsage'));
  if(repos.length&&!review)throw new Error(tr('wbTools.deliveryRepoReviewOnly'));
  const path = review ? '/api/agent/deliveries/review' : '/api/agent/deliveries';
  const repositories=JSON.parse(process.env.WB_REPOSITORIES||'[]');
  // Keep the legacy single-SHA payload/fingerprint unless selection is necessary.
  if(commit==='auto'||repos.length||review&&repositories.length>1) {
    const items=await deliveryItems(repositories,commit,{review,repos});
    const result=await homeFetch(path,{runId:context().runId,requestId,commit:items[0].commit,items,summary});
    return review&&commit!=='auto'&&!repos.length?{...result,repositorySelection:tr('wbTools.deliveryRepoSelected',{key:repositories.find(r=>r.id===items[0].id)?.key||items[0].id})}:result;
  }
  return homeFetch(path, { runId: context().runId, requestId, commit, summary });
}

async function gitSnapshot(cwd) {
  if (!cwd) return { head: '', branch: '', files: '', status: '' };
  const run = async args => {
    try { return (await exec('git', args, { cwd, timeout: 8000, env: gitEnv() })).stdout.trim(); }
    catch { return ''; }
  };
  return {
    head: await run(['rev-parse', '--short', 'HEAD']),
    branch: await run(['rev-parse', '--abbrev-ref', 'HEAD']),
    files: (await run(['diff', '--name-status', 'HEAD'])) || (await run(['status', '--porcelain'])),
    status: await run(['status', '-sb'])
  };
}

function renderHandoff({ ctx, git, done, files, verify, next, blocked, auto }) {
  const fileLines = files || git.files || tr('wbTools.noChanges');
  return tr('wbTools.handoffRoleTimeRunWorkspace', { p1: ctx.role || 'unknown', p2: now(), p3: ctx.runId || '', p4: ctx.workspace || '', p5: git.branch || '—', p6: git.head || '—', p7: auto ? tr('wbTools.filledInByWorkerFrom') : tr('wbTools.submittedByRole'), p8: (done || tr('wbTools.notProvided')).trim(), p9: String(fileLines).trim(), p10: (verify || tr('wbTools.notProvided2')).trim(), p11: (next || tr('wbTools.nextPersonStartsWithWb')).trim(), p12: (blocked || tr('wbTools.none')).trim() });
}

export async function handoffHasRun(runId, knowledge) {
  if (!runId) return false;
  const dir = join(knowledge || context().knowledge, 'handoffs');
  const visit=async(root,depth)=>{for(const entry of await readdir(root,{withFileTypes:true}).catch(()=>[])){if(entry.isFile()&&entry.name.includes(runId))return true;if(depth&&entry.isDirectory()&&await visit(join(root,entry.name),depth-1))return true;}return false;};
  return visit(dir,3);
}

/** Fixed template: done items / files / commit / next steps. With auto=true, skipped if this run already has a handoff. */
export async function writeHandoff(fields = {}, override = {}) {
  const ctx = { ...context(), ...override };
  const dir = await ensureKnowledge(ctx.knowledge);
  const handoffs=join(dir,handoffDirectory(ctx.nodeId,ctx.reviewPrivate,ctx.roleSessionId));
  const previous=join(dir,handoffDirectory('',ctx.reviewPrivate,ctx.roleSessionId));
  if (fields.auto && ctx.runId && (await Promise.all([handoffs,previous].map(path=>readdir(path).catch(()=>[])))).flat().some(name=>name.includes(ctx.runId))) {
    return { ok: true, skipped: true, reason: tr('wbTools.turnAlreadyHasWrittenHandoff') };
  }
  const git = await gitSnapshot(ctx.workspace || ctx.projectRoot);
  const body = renderHandoff({
    ctx, git,
    done: fields.done,
    files: fields.files,
    verify: fields.verify,
    next: fields.next,
    blocked: fields.blocked,
    auto: !!fields.auto
  });
  const stamp = now().replace(/[:.]/g, '-');
  const file = join(handoffs, `${stamp}-${ctx.role || 'role'}-${ctx.runId || 'norun'}.md`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, body, 'utf8');
  await writeFile(join(handoffs, 'LATEST.md'), body, 'utf8');
  return { ok: true, path: file, latest: join(handoffs, 'LATEST.md') };
}

/** Role help lists only the tools this turn can use; the platform assistant also gets its configuration tools. */
export const helpText = () => [tr('wbTools.builtInCollaborationToolsWorkbench'),tr('conversationTasks.help'),process.env.WB_SYSTEM_SUPERVISOR==='1'?tr('wechatChannel.toolGuide'):'',process.env.WB_SOURCE_SYNC==='1'?tr('sourceSync.toolGuide'):'',process.env.WB_PLATFORM_ASSISTANT==='1'?tr('wbTools.setupHelp'):''].filter(Boolean).join('\n\n');
