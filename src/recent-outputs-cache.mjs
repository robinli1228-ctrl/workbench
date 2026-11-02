import {getLanguage} from './i18n.mjs';

/**
 * Recent outputs ask the devices about up to 100 files, one query each; over a slow device link that takes a minute or more.
 * Home keeps each project's last list (in SQLite, so a restart keeps it too): a request is answered from it at once, and a
 * list that may be out of date is checked again in the background, one check per project at a time. The page shows the
 * kept list and then waits for the new one.
 *
 * Out of date: older than `freshMs` while a run or message of the project changed since the check or some file could not
 * be read (a device may be back), or older than `maxAgeMs` at all (a file may also change without a run). A failed check
 * is retried after `freshMs`. Nothing checks on a timer: only a page looking at the list starts a check.
 */
export const RECENT_OUTPUTS=Object.freeze({freshMs:60000,maxAgeMs:5*60000,waitMs:60000});
const KIND='recentOutputCaches';

export class RecentOutputs {
  constructor({db,compute,clock=()=>Date.now(),timings={}}) {
    Object.assign(this,{db,compute,clock,timings:{...RECENT_OUTPUTS,...timings},checks:new Map(),failures:new Map()});
  }
  /** Changes to a project's runs and messages, read from indexes without parsing the records. */
  runStamp(projectId) {
    const row=this.db.db.prepare("SELECT COUNT(*) AS n,MAX(json_extract(data,'$.updatedAt')) AS at FROM records WHERE kind='runs' AND json_extract(data,'$.projectId')=?").get(projectId);
    return `${row.n}:${row.at||''}:${this.db.projectReceiptCursor(projectId)}`;
  }
  stale(projectId,kept) {
    const failed=this.failures.get(projectId);
    if(failed&&this.clock()-failed.at<this.timings.freshMs)return false;
    if(!kept||kept.language!==getLanguage())return true;
    const age=this.clock()-Date.parse(kept.checkedAt);
    return !(age<=this.timings.maxAgeMs)||age>this.timings.freshMs&&(kept.runStamp!==this.runStamp(projectId)||kept.result.items?.some(item=>item.error));
  }
  /**
   * One check per project; a request during a check joins it, and `again` (a refresh) checks once more after it, since
   * the running check may have read a file before the change that prompted the refresh. Failures keep the previous list.
   */
  check(projectId,{again=false}={}) {
    let running=this.checks.get(projectId);
    if(running){if(again)(this.followUps||=new Set()).add(projectId);return running;}
    const runStamp=this.runStamp(projectId),language=getLanguage();
    running=(async()=>{
      try {
        const result=await this.compute(projectId);
        // A project deleted during the check leaves nothing behind.
        if(this.db.get('projects',projectId))this.db.put(KIND,{id:projectId,projectId,checkedAt:new Date(this.clock()).toISOString(),runStamp,language,result});
        this.failures.delete(projectId);
        return result;
      } catch(error) {this.failures.set(projectId,{message:error.message,at:this.clock()});throw error;}
      finally {this.checks.delete(projectId);if(this.followUps?.delete(projectId))this.check(projectId);}
    })();
    running.catch(()=>{});
    this.checks.set(projectId,running);
    return running;
  }
  /**
   * The kept list at once (`refreshing` when a check runs behind it); with `wait`, after the running check (at most
   * `waitMs`). Without a kept list the request waits for the first check, as before the cache.
   * `refresh` starts a check even when the list is fresh.
   */
  async get(projectId,{refresh=false,wait=false}={}) {
    let kept=this.db.get(KIND,projectId);
    if(refresh||!kept||this.stale(projectId,kept))this.check(projectId,{again:refresh});
    const running=this.checks.get(projectId);
    if(running&&!kept){const result=await running;kept=this.db.get(KIND,projectId)||{result,checkedAt:new Date(this.clock()).toISOString()};}
    else if(running&&wait){let timer;await Promise.race([running.catch(()=>{}),new Promise(resolve=>{timer=setTimeout(resolve,this.timings.waitMs);})]);clearTimeout(timer);}
    kept=this.db.get(KIND,projectId)||kept;
    return {...kept.result,checkedAt:kept.checkedAt,refreshing:this.checks.has(projectId),checkError:this.failures.get(projectId)?.message||null};
  }
}
