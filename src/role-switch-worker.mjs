import {realpath,readdir,lstat,readlink,mkdir,writeFile,readFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,relative,isAbsolute} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {switchHash} from './role-switches.mjs';
import {runtimeIssue} from './runtime-probe.mjs';
import {processAlive} from './terminal-resume.mjs';

const exec=promisify(execFile),terminal=new Set(['succeeded','failed','interrupted']);
const inside=(root,path)=>{const rel=relative(root,path);return !rel||(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('../'));};
const internal=path=>path.split('/').some(part=>['.git','.workbench','node_modules'].includes(part)||part.startsWith('.wb-bridge-'));
const git=async(root,args)=>(await exec('git',['-C',root,...args],{maxBuffer:8*1024*1024,timeout:15000,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'}})).stdout;

/** The outbox is transient; retain native verification text before Home acknowledges and removes it. */
export function recordSwitchOutput(db,runId,type,payload) {
  if(type!=='message'||payload.phase!=='final_answer')return;
  const run=db.get('runs',runId);
  if(run?.switchOperationId)db.put('runs',{...run,result:payload.text});
}

/** Durable Worker barriers survive restart; a terminal model turn does not prove process retirement. */
export class RoleSwitchWorker {
  constructor({db,warmSessions,activeSessions,roots,runtimes=()=>[],readHistory}) {Object.assign(this,{db,warmSessions,activeSessions,roots,runtimes,readHistory});this.pending=new Map();}
  status(operationId) {return this.db.get('workerRoleSwitches',operationId);}
  receipt(input,step) {return this.db.get('roleSwitchReceipts',`${input.operationId}:${step}`)?.result;}
  saveReceipt(input,step,result) {this.db.put('roleSwitchReceipts',{id:`${input.operationId}:${step}`,operationId:input.operationId,actionId:input.actionId,result});return result;}

  /** Serialize identical queries while preserving durable receipts for lost acknowledgements. */
  once(input,step,fn) {
    const prior=this.receipt(input,step);if(prior)return Promise.resolve(prior);
    const key=`${input.operationId}:${step}`;
    if(this.pending.has(key))return this.pending.get(key);
    const result=fn().finally(()=>this.pending.delete(key));this.pending.set(key,result);return result;
  }
  barrier(input) {
    const prior=this.status(input.operationId);
    if(prior&&(prior.projectId!==input.projectId||prior.roleId!==input.roleId||switchHash(prior.workspace)!==switchHash(input.workspace)))throw new Error('CLI switch operation binding mismatch.');
    if(prior?.released)throw new Error('CLI switch has already been released.');
    const other=this.db.list('workerRoleSwitches').find(op=>op.roleId===input.roleId&&op.projectId===input.projectId&&!op.released&&op.id!==input.operationId);
    if(other)throw new Error('Another CLI switch holds this role.');
    return this.db.put('workerRoleSwitches',{...prior,...input,id:input.operationId,released:false});
  }

  /** Hash only file bytes/metadata; credentials and repository content never appear in the receipt. */
  async snapshot(workspace) {
    const root=await realpath(workspace.root);
    if(!this.roots.some(allowed=>inside(allowed,root)))throw new Error('Workspace outside Worker roots.');
    const paths=[root,...workspace.repositories.map(r=>r.localRoot)];
    if(paths.some(p=>!p))throw new Error('Repository workspace binding is incomplete.');
    const directories=[];
    for(const path of [...new Set(paths)]) {
      const actual=await realpath(path);
      if(!this.roots.some(allowed=>inside(allowed,actual)))throw new Error('Repository outside Worker roots.');
      let head=null,status='',files=[];
      try {
        const top=await realpath((await git(actual,['rev-parse','--show-toplevel'])).trim());
        if(top===actual)head=(await git(actual,['rev-parse','HEAD'])).trim();
        else if(path!==root)throw new Error('Repository binding is not a Git working-tree root.');
      }
      catch(error) {if(path!==root||!/not a git repository/i.test(error.stderr||''))throw error;}
      if(head) {
        files=[...new Set(((await git(actual,['ls-files','-z','--modified','--deleted','--others','--exclude-standard']))+(await git(actual,['diff','--cached','--name-only','-z']))).split('\0').filter(Boolean))].filter(f=>!internal(f));
        status=(await git(actual,['status','--porcelain=v1','-z','--untracked-files=all'])).split('\0').filter(v=>v&&!internal(v.slice(3))).join('\0');
      } else if(paths.length===1) {
        const walk=async prefix=>{for(const entry of await readdir(join(actual,prefix),{withFileTypes:true})){
          const name=prefix?`${prefix}/${entry.name}`:entry.name;if(internal(name))continue;
          if(files.length>20000)throw new Error('Workspace inspection exceeds file limit.');
          if(entry.isDirectory())await walk(name);else files.push(name);
        }};await walk('');
      }
      if(files.length>20000)throw new Error('Workspace inspection exceeds file limit.');
      const entries=[];
      for(const file of files.sort()) {
        const full=join(actual,file);if(!inside(actual,full))throw new Error('Invalid repository path.');
        let info;try{info=await lstat(full);}catch(e){if(e.code==='ENOENT'){entries.push({path:file,deleted:true});continue;}throw e;}
        if(info.isSymbolicLink()){entries.push({path:file,link:await readlink(full)});continue;}
        if(!info.isFile())throw new Error('Unsupported repository entry during inspection.');
        if(!inside(actual,await realpath(full)))throw new Error('File escaped workspace during inspection.');
        const hash=createHash('sha256');for await(const chunk of createReadStream(full))hash.update(chunk);
        entries.push({path:file,size:info.size,mode:info.mode,hash:hash.digest('hex')});
      }
      directories.push({path:actual,head,status,files:entries});
    }
    return {directories,workspaceHash:switchHash(directories)};
  }

  /** Drop only this role's source/candidate warm drivers, then inspect all recorded PIDs. */
  async settle(input) {
    for(const sessionId of [input.sourceSessionId,input.candidateSessionId].filter(Boolean))await this.warmSessions.drop(sessionId);
    const runs=this.db.list('runs').filter(r=>r.projectId===input.projectId&&r.roleId===input.roleId);
    if(runs.some(r=>this.activeSessions.has(r.id)||!terminal.has(r.status)||(!r.processSettled&&r.pid&&processAlive(r.pid))))return false;
    return true;
  }
  inspect(input) {
    return this.once(input,'inspect',async()=>{
      this.barrier(input);
      if(!await this.settle(input))return {settled:false,error:'Original native process is still active or unconfirmed.'};
      const issue=runtimeIssue({capabilities:{runtimeDiscovery:1},runtimes:this.runtimes()},input.candidate.runtime,input.candidate.model);
      if(issue)return this.saveReceipt(input,'inspect',{error:issue});
      const result=await this.snapshot(input.workspace);
      let historyPath=null,historyHash=null;
      const historyText=input.historyHash?await this.readHistory(input.operationId):input.historyText;
      if(historyText!==undefined) {
        if(typeof historyText!=='string'||Buffer.byteLength(historyText)>64*1024*1024||!/^[a-zA-Z0-9_-]{1,100}$/.test(input.operationId))throw new Error('Invalid CLI switch history artifact.');
        if(input.historyHash&&switchHash(historyText)!==input.historyHash)throw new Error('CLI switch history hash mismatch.');
        const root=await realpath(input.workspace.root),parent=join(root,'.workbench');await mkdir(parent,{recursive:true});
        if(!inside(root,await realpath(parent)))throw new Error('History directory escapes project workspace.');
        const directory=join(parent,'cli-switch-'+input.operationId);await mkdir(directory,{recursive:true});
        if(!inside(parent,await realpath(directory)))throw new Error('History directory escapes project workspace.');
        historyPath=join(directory,'history.json');historyHash=switchHash(historyText);
        try{await writeFile(historyPath,historyText,{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST'||(await lstat(historyPath)).isSymbolicLink()||switchHash(await readFile(historyPath,'utf8'))!==historyHash)throw error;}
      }
      return this.saveReceipt(input,'inspect',{...result,historyPath,historyHash,settled:true});
    });
  }
  prepare(input) {
    return this.once(input,'prepare',async()=>{
      this.barrier(input);
      if(!await this.settle(input))return {settled:false};
      const verification=this.db.get('runs',input.verificationRunId);
      if(verification?.switchOperationId!==input.operationId||verification.switchPhase!=='verify'||verification.status!=='succeeded'||!verification.nativeSession?.id||verification.nativeSession.runtime!==input.candidate.runtime
        ||!String(verification.result||'').split('\n').some(line=>line.trim()===`SWITCH_VERIFIED ${input.handoffHash}`))return {error:'Native candidate verification is incomplete.'};
      const original=this.receipt(input,'inspect');
      const after=await this.snapshot(input.workspace);
      if(!original?.workspaceHash||original.workspaceHash!==after.workspaceHash)return {error:'Workspace changed during CLI maintenance; files preserved for inspection.'};
      const issue=runtimeIssue({capabilities:{runtimeDiscovery:1},runtimes:this.runtimes()},input.candidate.runtime,input.candidate.model);
      if(issue)return {error:issue};
      return this.saveReceipt(input,'prepare',{settled:true,workspaceUnchanged:true,workspaceHash:after.workspaceHash,handoffHash:input.handoffHash,nativeSession:verification.nativeSession});
    });
  }
  release(input) {
    return this.once(input,'release',async()=>{
      // Cancellation can precede inspection. Persist a tombstone even in that case to reject late launches.
      const prior=this.status(input.operationId);
      if(prior&&(prior.projectId!==input.projectId||prior.roleId!==input.roleId))throw new Error('CLI switch release ownership mismatch.');
      if(!await this.settle(input))return {settled:false};
      this.db.put('workerRoleSwitches',{...prior,...input,id:input.operationId,released:true});
      return this.saveReceipt(input,'release',{settled:true});
    });
  }

  /** Recheck at actual launch; a delayed command cannot enter a cancelled or foreign staging session. */
  assertLaunch(run) {
    const barrier=this.db.list('workerRoleSwitches').find(op=>op.projectId===run.projectId&&op.roleId===run.roleId&&!op.released);
    if(!run.switchOperationId){if(barrier)throw new Error('CLI switch holds this role.');return;}
    const op=this.status(run.switchOperationId);
    if(!op||op.released||op.id!==barrier?.id)throw new Error('CLI switch is not active.');
    if(run.switchPhase==='verify') {
      if(run.resumeNativeSessionId||run.roleSessionId===op.sourceSessionId||run.roleSnapshot?.runtime!==op.candidate.runtime||run.roleSnapshot?.model!==op.candidate.model)throw new Error('Invalid native candidate session binding.');
    } else if(run.switchPhase!=='handoff'||run.roleSnapshot?.runtime!==op.original.runtime)throw new Error('Invalid source handoff binding.');
  }
}
