import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,readdir,open,lstat,unlink,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {homedir} from 'node:os';
import {join,isAbsolute} from 'node:path';
const exec=promisify(execFile),uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const rootFor=env=>env.CLAUDE_CONFIG_DIR||join(env.HOME||homedir(),'.claude');

/** Inspect only our own probe child's environment: launchers may change HOME before executing Claude. Never log environment contents. */
export async function probeHistoryRoots(pid,env=process.env){
 const roots=new Set([rootFor(env)]);
 if(!Number.isInteger(pid)||pid<=0)return [...roots];
 try{
  let values={};
  if(process.platform==='linux'){
   const raw=await readFile(`/proc/${pid}/environ`,'utf8');
   for(const field of raw.split('\0')){const at=field.indexOf('=');if(['HOME','CLAUDE_CONFIG_DIR'].includes(field.slice(0,at)))values[field.slice(0,at)]=field.slice(at+1);}
  }else if(process.platform==='darwin'){
   const {stdout}=await exec('ps',['eww','-p',String(pid),'-o','command='],{timeout:2000,maxBuffer:1048576});
   for(const name of ['HOME','CLAUDE_CONFIG_DIR']){const match=stdout.match(new RegExp(`(?:^|\\s)${name}=(.*?)(?=\\s[A-Za-z_][A-Za-z_0-9]*=|$)`));if(match)values[name]=match[1].trim();}
  }
  if(values.CLAUDE_CONFIG_DIR||values.HOME)roots.add(rootFor(values));
 }catch{/* Missing process evidence cannot authorize a broader history search. */}
 return [...roots].filter(isAbsolute);
}

/** Fail closed: no assistant/tool messages, other commands, nonzero usage or malformed/unknown records can be deleted. */
export function isUsageOnlyHistory(text,sessionId){
 if(!uuid.test(sessionId)||!text.trim()||Buffer.byteLength(text)>1048576)return false;
 let command=false;
 try{for(const line of text.split('\n').filter(line=>line.trim())){
  const row=JSON.parse(line);if(row.sessionId!==sessionId)return false;
  if(row.type==='user'){
   if(row.message?.role!=='user'||typeof row.message.content!=='string')return false;
   const body=row.message.content.trim();
   if(/^<local-command-caveat>[^]*<\/local-command-caveat>$/.test(body)&&row.isMeta!==false)continue;
   if(/^<command-name>\/usage<\/command-name>\s*<command-message>usage<\/command-message>\s*<command-args>\s*<\/command-args>$/.test(body)){command=true;continue;}
   return false;
  }
  if(row.type==='queue-operation'){if(!['enqueue','dequeue','remove'].includes(row.operation)||row.content!=null&&row.content!=='/usage')return false;continue;}
  if(row.type==='system'){
   if(row.subtype!=='local_command'||row.commandRun?.command!=='usage'||row.commandRun.args!=='')return false;
   const usage=row.usageReport?.session;if(!usage||Number(usage.total_cost_usd||0)!==0||Number(usage.total_api_duration_ms||0)!==0||Object.keys(usage.model_usage||{}).length)return false;continue;
  }
  if(row.type==='cost-state'){if(Number(row.totalCostUSD||0)!==0||Number(row.totalAPIDuration||0)!==0||Number(row.totalToolDuration||0)!==0||Number(row.totalLinesAdded||0)!==0||Number(row.totalLinesRemoved||0)!==0||Object.keys(row.modelUsage||{}).length)return false;continue;}
  if(row.type==='last-prompt'&&row.prompt==null&&row.content==null)continue;
  return false;
 }}catch{return false;}
 return command;
}

/** Call only after the unique probe process has closed. Resolve its exact UUID, never prune unrelated history. */
export async function removeProbeHistory(roots,sessionId){
 if(!uuid.test(sessionId))throw new Error('Invalid quota probe session ID');
 const removed=[],preserved=[];
 for(const root of new Set(roots)){
  const projects=join(root,'projects');let dirs;
  try{if((await lstat(projects)).isSymbolicLink())continue;dirs=await readdir(projects,{withFileTypes:true});}catch{continue;}
  for(const dir of dirs){
   if(!dir.isDirectory()||dir.isSymbolicLink())continue;
   const file=join(projects,dir.name,sessionId+'.jsonl');let handle;
   try{
    if(await realpath(join(projects,dir.name))!==join(projects,dir.name))continue;
    handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);const before=await handle.stat();
    if(!before.isFile()||before.size>1048576){preserved.push(file);continue;}
    const body=await handle.readFile('utf8'),after=await lstat(file);
    if(!isUsageOnlyHistory(body,sessionId)||after.isSymbolicLink()||before.ino!==after.ino||before.dev!==after.dev||before.size!==after.size||before.mtimeMs!==after.mtimeMs){preserved.push(file);continue;}
    await unlink(file);removed.push(file);
   }catch(error){if(error.code!=='ENOENT')preserved.push(file);}finally{await handle?.close();}
  }
 }
 return {removed,preserved};
}
