import {spawn} from 'node:child_process';

/**
 * Whether a git command (`status --porcelain`) prints anything. A tree with many untracked files printed megabytes, which
 * overflowed a buffered exec ("stdout maxBuffer length exceeded") and failed a run before it started; a yes/no needs only
 * the first byte, so the command is stopped there and its size no longer matters.
 */
export function gitPrintsAnything(cwd,args,{env=process.env,timeout=30000}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn('git',args,{cwd,env,stdio:['ignore','pipe','pipe']});
    let settled=false,found=false,stderr='';
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve(value);};
    const timer=setTimeout(()=>{child.kill('SIGKILL');finish(Object.assign(new Error(`git ${args[0]} timed out`),{killed:true}));},timeout);
    child.stdout.on('data',()=>{if(found)return;found=true;child.kill();finish(null,true);});
    child.stderr.on('data',chunk=>{if(stderr.length<8192)stderr+=chunk;});
    child.on('error',finish);
    child.on('close',code=>{if(code===0)finish(null,found);else finish(Object.assign(new Error(stderr.trim()||`git ${args[0]} exited with ${code}`),{code}));});
  });
}
