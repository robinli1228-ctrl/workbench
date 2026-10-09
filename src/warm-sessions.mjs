import { createHash } from 'node:crypto';

/** Compare process-level configuration only; a change of role identity also forces a rebuild, while the Run/tool entry points do not take part in the comparison. */
export function warmSessionFingerprint({folder,runtimeType,model,effort,roleName,roleInstructions,env}) {
  return createHash('sha256').update(JSON.stringify({folder,runtimeType,model,effort,roleName,roleInstructions,env})).digest('hex');
}

/** Only cache processes of completed turns; active Runs are still managed by the Worker's existing concurrency table. */
export class WarmSessions {
  constructor({idleMs=300000,max=4,changed=()=>{}}={}) {
    this.idleMs=idleMs; this.max=max; this.changed=changed; this.entries=new Map();
  }
  alive(session) { return Boolean(session?.proc && !session.proc.killed && session.proc.exitCode===null && session.proc.signalCode===null); }
  owns(pid) { return [...this.entries.values()].some(e=>e.session.proc?.pid===pid); }
  snapshot() { return [...this.entries].filter(([,e])=>this.alive(e.session)).map(([id,e])=>({id,...e.metadata,idleUntil:e.idleUntil})); }
  /** On a configuration change the old process must be confirmed exited before a new driver of the same native session may start. */
  async take(key,fingerprint) {
    const entry=this.entries.get(key);
    if(!entry)return null;
    if(entry.closing){await entry.closing;return null;}
    if(entry.fingerprint!==fingerprint || !this.alive(entry.session)) {await this.drop(key);return null;}
    clearTimeout(entry.timer);entry.session.proc.removeListener('exit',entry.onExit);this.entries.delete(key);this.changed();return entry.session;
  }
  keep(key,fingerprint,session,metadata) {
    if(!key || !session.done || !this.alive(session))return false;
    const entry={session,fingerprint,metadata,idleUntil:new Date(Date.now()+this.idleMs).toISOString()};
    this.entries.set(key,entry);
    entry.timer=setTimeout(()=>{void this.drop(key);},this.idleMs);entry.timer.unref();
    entry.onExit=()=>{if(this.entries.get(key)===entry){clearTimeout(entry.timer);this.entries.delete(key);this.changed();}};
    session.proc.once('exit',entry.onExit);
    this.changed();return true;
  }
  /** The active count includes the Run about to start; the longest-idle process is reclaimed first. */
  async trim(activeCount=0) {
    while(this.entries.size && this.entries.size+activeCount>this.max) {
      const count=Math.min(this.entries.size,this.entries.size+activeCount-this.max);
      await Promise.all([...this.entries.keys()].slice(0,count).map(key=>this.drop(key)));
    }
  }
  async drop(key) {
    const entry=this.entries.get(key);if(!entry)return;
    if(entry.closing)return entry.closing;
    entry.closing=this.closeEntry(key,entry);return entry.closing;
  }
  async closeEntry(key,entry) {
    clearTimeout(entry.timer);
    const proc=entry.session.proc;
    if(proc && proc.exitCode===null && proc.signalCode===null) {
      await new Promise(resolve=>{
        const timer=setTimeout(()=>{try{proc.kill('SIGKILL');}catch{}},3000);timer.unref();
        proc.once('exit',()=>{clearTimeout(timer);resolve();});
        entry.session.shutdown();
      });
    }
    if(this.entries.get(key)===entry)this.entries.delete(key);
    proc?.removeListener('exit',entry.onExit);
    this.changed();
  }
  async closeProject(projectId) {for(const [key,e] of this.entries)if(e.metadata.projectId===projectId)await this.drop(key);}
  async closeAll() {await Promise.all([...this.entries.keys()].map(key=>this.drop(key)));}
}
