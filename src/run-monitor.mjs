import {terminal} from './store.mjs';

/** Model-free inspection only flags suspected stalls: silence is not treated as a hang, and processes are never killed or re-run automatically. */
export function inspectRunProgress(db,online,now=Date.now()) {
  let changed=false;
  for(const run of db.list('runs')) {
    if(terminal.has(run.status))continue;
    let reason=null;
    if(!online(run.nodeId))reason='Device is offline; the execution state needs to be verified. It will not be re-dispatched automatically';
    else if(run.status==='waiting_user')continue;
    else if(now-Date.parse(run.updatedAt||run.createdAt)>10*60*1000)reason='No run events for over 10 minutes; a tool may still be executing. Check the logs and processes';
    const old=db.get('runAlerts',run.id);
    if(reason && (old?.reason!==reason || old.status!=='open')) {
      db.put('runAlerts',{id:run.id,projectId:run.projectId,reason,createdAt:new Date(now).toISOString(),status:'open'});changed=true;
    } else if(!reason && old?.status==='open') {db.put('runAlerts',{...old,status:'resolved'});changed=true;}
  }
  for(const alert of db.list('runAlerts').filter(a=>a.status==='open'))if(terminal.has(db.get('runs',alert.id)?.status)){db.put('runAlerts',{...alert,status:'resolved'});changed=true;}
  return changed;
}
