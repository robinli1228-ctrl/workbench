import {createHash} from 'node:crypto';
import {execFileSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import {terminalProcessIdentity,processIdentityKey,sameProcessIdentity} from './terminal-resume.mjs';
import {tr} from './i18n.mjs';

const terminal=new Set(['succeeded','failed','interrupted']);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const processRows=()=>execFileSync('ps',['-axo','pid=,ppid=,pgid='],{encoding:'utf8',timeout:3000,maxBuffer:1024*1024}).trim().split('\n').map(line=>line.trim().split(/\s+/).map(Number));
const exec=promisify(execFile);
/** One bounded no-argument process snapshot serves Q; Linux startup ticks remain PID-reuse proof. */
async function driverProcessFacts(records){
  const {stdout}=await exec('ps',['-axo','pid=,ppid=,uid=,pgid=,lstart=,stat='],{encoding:'utf8',timeout:3000,maxBuffer:1024*1024,env:{...process.env,LC_ALL:'C'}});
  const facts=new Map(),groups=new Set(records.filter(r=>r.processIdentity&&r.processIdentity.pgid===r.processIdentity.pid).map(r=>r.processIdentity.pgid));
  const selected=new Set(records.flatMap(r=>[r.pid,...(r.driverStopProcesses||[]).map(p=>p.pid)]).filter(Boolean));
  for(const line of stdout.trim().split('\n')){
    const m=line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)$/);
    if(!m)continue;
    if(!selected.has(Number(m[1]))&&!groups.has(Number(m[4])))continue;
    facts.set(Number(m[1]),{pid:Number(m[1]),ppid:Number(m[2]),uid:Number(m[3]),pgid:Number(m[4]),start:m[5],zombie:m[6].startsWith('Z')});
  }
  let partial=false;
  if(process.platform==='linux'){
    const boot=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();
    let count=0;
    for(const [pid,fact] of facts){
      if(count++>=100){partial=true;facts.set(pid,{pid,unknown:true});continue;}
      try{const info=await readFile('/proc/'+pid+'/stat','utf8');fact.start=boot+':'+info.slice(info.lastIndexOf(')')+2).split(' ')[19];}
      catch{facts.set(pid,{pid,unknown:true});}
    }
  }
  return {identity:pid=>facts.get(pid)||null,rows:()=>[...facts.values()].map(p=>[p.pid,p.ppid,p.pgid]),partial};
}

/** Recheck saved startup identities before every signal; a bare PID never authorizes shutdown. */
export async function stopVerifiedDriver(expected,{identity=terminalProcessIdentity,signal=(pid,name)=>process.kill(pid,name),rows=()=>execFileSync('ps',['-axo','pid=,ppid=,pgid='],{encoding:'utf8',timeout:3000,maxBuffer:1024*1024}),onTracked=()=>{},graceMs=3000,killMs=3000}={}) {
  const tracked=new Map([[expected.pid,expected]]),uid=typeof process.getuid==='function'?process.getuid():null;
  // Managed drivers have a dedicated POSIX group, so reparented tool children remain discoverable.
  const first=identity(expected.pid),group=expected.pgid===expected.pid&&sameProcessIdentity(first,expected)&&first.pgid===expected.pgid?expected.pgid:null;
  const collect=()=>{
    const root=identity(expected.pid);
    if(root?.unknown||root?.start===expected.start&&root.uid!==expected.uid||sameProcessIdentity(root,expected)&&uid!==null&&root.uid!==uid)throw Error(tr('cliRecovery.identityUnknown'));
    const parents=new Set([...tracked.values()].filter(proof=>{const current=identity(proof.pid);if(current?.unknown||current?.start===proof.start&&current.uid!==proof.uid)throw Error(tr('cliRecovery.identityUnknown'));return sameProcessIdentity(current,proof)&&!current.zombie;}).map(proof=>proof.pid));
    const pairs=rows().trim().split('\n').map(line=>line.trim().split(/\s+/).map(Number));
    if(group){
      if(root&&!root.zombie&&!sameProcessIdentity(root,expected))throw Error(tr('cliRecovery.identityUnknown'));
      for(const[pid,,pgid]of pairs)if(pgid===group&&!tracked.has(pid)){
        const child=identity(pid);if(!child||child.zombie)continue;
        if(child.unknown||child.uid!==expected.uid||child.pgid!==group)throw Error(tr('cliRecovery.identityUnknown'));
        tracked.set(pid,{...processIdentityKey(child),pgid:group});parents.add(pid);
      }
    }
    let changed=true;
    while(changed){changed=false;for(const[pid,parent]of pairs){
      if(!tracked.has(pid)&&tracked.has(parent)&&!parents.has(parent)){const child=identity(pid);if(child&&!child.zombie&&(child.unknown||child.ppid===parent))throw Error(tr('cliRecovery.stopPending'));}
      if(parents.has(pid)||!parents.has(parent)||!sameProcessIdentity(identity(parent),tracked.get(parent)))continue;
      const child=identity(pid);if(!child||child.zombie)continue;
      if(!child.unknown&&child.ppid!==parent)continue;
      if(child.unknown||child.uid!==expected.uid)throw Error(tr('cliRecovery.identityUnknown'));
      tracked.set(pid,processIdentityKey(child));parents.add(pid);changed=true;
    }}
    onTracked([...tracked.values()]);
  };
  const alive=()=>[...tracked.values()].some(proof=>{const current=identity(proof.pid);return current?.unknown||sameProcessIdentity(current,proof)&&!current.zombie;});
  const send=name=>{for(const proof of [...tracked.values()].reverse()){
    const current=identity(proof.pid);if(current?.unknown||current?.start===proof.start&&current.uid!==proof.uid)throw Error(tr('cliRecovery.identityUnknown'));
    if(sameProcessIdentity(current,proof)&&!current.zombie){if(uid!==null&&current.uid!==uid)throw Error(tr('cliRecovery.identityUnknown'));try{signal(proof.pid,name);}catch(error){if(error.code!=='ESRCH')throw error;}}
  }};
  const settle=async ms=>{const end=Date.now()+ms;do{await wait(50);collect();if(!alive())return true;}while(Date.now()<end);return false;};
  collect();send('SIGTERM');let forced=false;
  if(!await settle(graceMs)){forced=true;collect();send('SIGKILL');if(!await settle(killMs))throw Error(tr('cliRecovery.stopPending'));}
  return {exited:true,forced};
}

/** Bind the managed spawn to its startup, user and session without storing command arguments or credentials. */
export function driverIdentity(run,pid,identity=terminalProcessIdentity) {
  const current=identity(pid),key=processIdentityKey(current);
  return key?{...key,...(current.pgid===pid?{pgid:pid}:{}),projectId:run.projectId,roleId:run.roleId,roleSessionId:run.roleSessionId||null,runtime:run.nativeSession?.runtime||run.runtime||null,nativeSessionId:run.nativeSession?.id||null}:null;
}

/** Inspect only this role's native drivers; process facts do not replace task or native history. */
export class CliSessionRecovery {
  constructor({db,warmSessions,activeSessions,emit,identity=terminalProcessIdentity,stop=stopVerifiedDriver,rows=processRows,processFacts=driverProcessFacts}){Object.assign(this,{db,warmSessions,activeSessions,emit,identity,stop,rows,processFacts});this.pending=new Map();}
  records(binding){
    if(!binding?.projectId||!binding.roleId||!binding.taskId)throw Error(tr('cliRecovery.bindingChanged'));
    return this.db.list('runs').filter(run=>run.id!==binding.runId&&run.projectId===binding.projectId&&run.roleId===binding.roleId
      &&(binding.nativeSessionId?run.nativeSession?.id===binding.nativeSessionId:run.id===binding.priorRunId)
      &&(!binding.roleSessionId||!run.roleSessionId||run.roleSessionId===binding.roleSessionId));
  }
  /** Retire a stale record without signalling the process now occupying that PID. */
  retire(run){
    const active=this.activeSessions.get(run.id);if(active)return;
    this.emit(run.id,'status',{pid:null,previousPid:run.pid,runtimeRetained:false,processSettled:true,driverState:'exited',
      ...(!terminal.has(run.status)?{status:'interrupted',controlLost:true,error:tr('cliRecovery.oldProcessExited')}:{})});
  }
  inspect(binding,{records,readOnly=false,identity=this.identity,rows=this.rows}={}){
    const candidates=records||this.records(binding),seen=new Set(),processes=[];
    // One driver can serve several turns; an older success cannot override a newer active owner.
    for(const run of candidates.reverse()){
      const original=run.processIdentity;
      const associated=original&&original.projectId===run.projectId&&original.roleId===run.roleId&&original.roleSessionId===(run.roleSessionId||null)
        &&original.nativeSessionId===run.nativeSession?.id&&original.runtime===run.nativeSession?.runtime;
      const keys=[{pid:run.pid,proof:original,child:false},...(run.driverStopProcesses||[]).filter(p=>p.pid!==run.pid).map(proof=>({pid:proof.pid,proof,child:true}))];
      if(associated&&original.pgid===original.pid){
        const root=identity(original.pid),anchor=keys.some(({proof})=>{const current=identity(proof?.pid);return sameProcessIdentity(current,proof)&&current.pgid===original.pgid;});
        // Without a surviving startup proof, group membership blocks dispatch but does not authorize killing.
        if(!root||root.unknown||sameProcessIdentity(root,original))for(const[pid,,pgid]of rows())if(pgid===original.pgid&&!keys.some(k=>k.pid===pid)){
          const current=identity(pid);if(!current||current.zombie)continue;
          if(!current.unknown&&current.pgid!==original.pgid)continue;
          keys.push({pid,proof:anchor&&current.uid===original.uid&&!current.unknown?processIdentityKey(current):null,child:true});
        }
      }
      let live=false,covered=false;
      for(const{pid,proof,child}of keys){
        if(!pid)continue;if(seen.has(pid)){covered=true;continue;}seen.add(pid);
        const current=identity(pid);
        if(!current||current.zombie||proof&&!current.unknown&&current.start!==proof.start)continue;
        live=true;
        const verified=Boolean(associated&&(!binding.roleSessionId||run.roleSessionId===binding.roleSessionId)&&sameProcessIdentity(current,proof)&&(typeof process.getuid!=='function'||current.uid===process.getuid()));
        const owner=[...this.activeSessions].find(([,entry])=>{const owned=(entry?.preparing?entry.session:entry)?.proc?.pid;return owned===pid||child&&original.pgid===original.pid&&owned===original.pid;});
        if(binding.runId&&owner?.[0]===binding.runId)continue;
        const warm=verified&&!owner&&this.warmSessions.owns(child?original.pid:pid);
        const idle=verified&&!owner&&terminal.has(run.status)&&run.runtimeRetained===true;
        processes.push({runId:run.id,ownerRunId:owner?.[0]||null,pid,verified,warm,idle,state:warm||idle?'idle':verified?'unconfirmed':'unknown',proof:verified?proof:null});
      }
      if(!readOnly&&!live&&!covered&&run.pid)this.retire(run);
    }
    const blockers=processes.filter(p=>!p.warm),fingerprint=hash({binding:{projectId:binding.projectId,roleId:binding.roleId,roleSessionId:binding.roleSessionId,nativeSessionId:binding.nativeSessionId},processes:blockers.map(p=>({runId:p.runId,ownerRunId:p.ownerRunId,pid:p.pid,idle:p.idle,proof:p.proof}))});
    return {state:blockers.length?(blockers.every(p=>p.verified)?'waiting':'unknown'):'ready',canStop:blockers.length>0&&blockers.every(p=>p.verified),fingerprint,
      processes:processes.map(({proof,...p})=>p),blockers};
  }
  view(result){const{blockers,...view}=result;return view;}
  /** Q observes bounded persisted startup proofs only; it cannot retire history or reclaim a driver. */
  async observe(binding){
    const {records,partial}=this.db.readNativeDriverRecords(binding,{limit:100});
    const facts=this.identity===terminalProcessIdentity?await this.processFacts(records):{identity:this.identity,rows:this.rows,partial:false};
    const result=this.inspect(binding,{records,readOnly:true,identity:facts.identity,rows:facts.rows}),incomplete=partial||facts.partial||records.some(r=>!terminal.has(r.status)&&!r.pid);
    return {state:incomplete?'unknown':result.state,processes:result.processes,partial:incomplete,readOnly:true};
  }
  async check(binding){
    const key=binding.roleSessionId||`${binding.projectId}:${binding.roleId}`;
    if(this.pending.has(key))return {state:'stopping',canStop:false,reason:tr('cliRecovery.stopPending')};
    let result;
    try{
      const records=this.records(binding);
      // Admission must not block the Worker event loop with a separate ps for every historical turn.
      // One fresh async snapshot preserves startup identities; signalling still rechecks each live process.
      const facts=this.identity===terminalProcessIdentity?await this.processFacts(records):{identity:this.identity,rows:this.rows,partial:false};
      if(facts.partial)return {state:'unknown',canStop:false,reason:tr('cliRecovery.identityUnknown'),processes:[]};
      result=this.inspect(binding,{records,identity:facts.identity,rows:facts.rows});
    }catch(error){return {state:'unknown',canStop:false,reason:error.message,processes:[]};}
    if(result.blockers.length&&result.blockers.every(p=>p.idle)){
      try{return await this.reclaim(binding,result.fingerprint,false);}
      catch(error){try{const current=this.inspect(binding);return {...this.view(current),state:current.canStop?'waiting':'unknown',reason:error.message};}catch{return {state:'unknown',canStop:false,reason:error.message,processes:[]};}}
    }
    return {...this.view(result),reason:result.state==='unknown'?tr('cliRecovery.identityUnknown'):result.state==='waiting'?tr('cliRecovery.waiting'):null};
  }
  /** Consent binds the displayed snapshot; a different process/owner requires fresh confirmation. */
  reclaim(binding,fingerprint,confirmed=true){
    const key=binding.roleSessionId||`${binding.projectId}:${binding.roleId}`;
    if(this.pending.has(key))return this.pending.get(key);
    const operation=(async()=>{
      const result=this.inspect(binding);
      if(result.state==='ready')return {...this.view(result),exited:true};
      if(result.fingerprint!==fingerprint)throw Error(tr('cliRecovery.processChanged'));
      if(!result.canStop||!confirmed&&!result.blockers.every(p=>p.idle))throw Error(tr('cliRecovery.identityUnknown'));
      for(const blocker of result.blockers){
        const run=this.db.get('runs',blocker.runId),actual=this.identity(blocker.pid);
        if(!actual||actual.zombie||!actual.unknown&&actual.start!==blocker.proof.start)continue;
        if(!sameProcessIdentity(actual,blocker.proof))throw Error(tr('cliRecovery.processChanged'));
        const active=this.activeSessions.get(blocker.ownerRunId||run.id),session=active?.preparing?active.session:active;
        if(session)session.stopping=true;
        if(!terminal.has(run.status))this.emit(run.id,'status',{status:'stopping'});
        await this.stop(blocker.proof,{identity:this.identity,onTracked:proofs=>{const current=this.db.get('runs',run.id);this.db.put('runs',{...current,driverStopProcesses:[...new Map([...(current.driverStopProcesses||[]),...proofs].map(p=>[p.pid,p])).values()]});}});
        const latest=this.db.get('runs',run.id);
        this.emit(run.id,'status',{runtimeRetained:false,processSettled:true,driverState:'exited',
          ...(!terminal.has(latest.status)?{status:'interrupted',controlLost:true,error:tr('cliRecovery.oldProcessStopped')}:{})});
      }
      return {...this.view(this.inspect(binding)),exited:true};
    })();
    this.pending.set(key,operation);operation.finally(()=>{if(this.pending.get(key)===operation)this.pending.delete(key);}).catch(()=>{});return operation;
  }
}
