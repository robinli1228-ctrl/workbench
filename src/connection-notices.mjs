import {tr} from './i18n.mjs';
import {conversationIdOf} from './group-conversations.mjs';

/**
 * Home tells a group chat when a device's link drops while its roles are working, and again when it is back. A role whose
 * wb request could not be sent during the outage stopped its turn (the Worker told it to, instead of retrying); the
 * recovery notice names those roles so the page can fill "@role continue" into the composer for the user to send.
 * Nothing retries by itself. One outage gives at most one "lost" and one "restored" notice per chat.
 */
export const OUTAGE_NOTICE_DELAY=60000,RESTORE_SETTLE_DELAY=15000;

export class ConnectionNotices {
  constructor({db,change=()=>{},online=()=>false,schedule=(fn,ms)=>setTimeout(fn,ms),cancel=timer=>clearTimeout(timer),now=()=>new Date()}){
    Object.assign(this,{db,change,online,schedule,cancel,now});this.timers=new Map();
  }
  #timer(key,fn,ms){this.cancel(this.timers.get(key));const timer=this.schedule(()=>{this.timers.delete(key);fn();},ms);timer?.unref?.();this.timers.set(key,timer);}
  #device(nodeId){return this.db.get('workers',nodeId)?.name||nodeId;}
  #roleName(roleId){return this.db.get('roles',roleId)?.name||'';}
  #outage(nodeId){return this.db.get('connectionOutages',nodeId)||{id:nodeId,startedAt:this.now().toISOString(),chats:[]};}
  #chat(outage,run){
    const projectId=run.projectId,conversationId=conversationIdOf(run);
    let chat=outage.chats.find(c=>c.projectId===projectId&&c.conversationId===conversationId);
    if(!chat){chat={projectId,conversationId,working:[],stopped:[],stoppedRuns:[],lostNoticeId:null};outage.chats.push(chat);}chat.stoppedRuns||=[];
    return chat;
  }
  #post(chat,kind,text,extra={}){
    const at=this.now().toISOString(),id=`${kind}-${chat.projectId}-${chat.conversationId}-${Date.parse(at)}`;
    this.db.put('roomMessages',{id,projectId:chat.projectId,conversationId:chat.conversationId,sender:'system',senderName:'Workbench',kind,text,taskIds:[],createdAt:at,...extra});
    return id;
  }

  /** The device's socket closed: after a minute still offline, chats with a turn running there hear about it. */
  disconnected(nodeId){this.#timer(`lost:${nodeId}`,()=>this.#lost(nodeId),OUTAGE_NOTICE_DELAY);}
  #lost(nodeId){
    if(this.online(nodeId))return;
    const runs=this.db.activeRuns().filter(r=>r.nodeId===nodeId&&r.status==='reconciling');if(!runs.length)return;
    const outage=this.#outage(nodeId);
    for(const run of runs){const chat=this.#chat(outage,run);if(run.roleId&&!chat.working.includes(run.roleId))chat.working.push(run.roleId);}
    for(const chat of outage.chats.filter(c=>!c.lostNoticeId&&c.working.length))
      chat.lostNoticeId=this.#post(chat,'connection_lost',tr('connection.lost',{device:this.#device(nodeId),roles:chat.working.map(id=>this.#roleName(id)).filter(Boolean).join(tr('connection.separator'))}));
    this.db.put('connectionOutages',outage);this.change();
  }
  /** A role's wb request was refused because this device could not reach Home: it stops, and will be named on recovery. */
  stopped(run){
    // A replayed or late event for a run already named in a restored notice says nothing again.
    if(!run?.roleId||run.connectionNoticedAt)return;
    const outage=this.#outage(run.nodeId),chat=this.#chat(outage,run);
    if(!chat.stopped.includes(run.roleId))chat.stopped.push(run.roleId);
    if(!chat.stoppedRuns.includes(run.id))chat.stoppedRuns.push(run.id);
    this.db.put('connectionOutages',outage);
    // The refusal is reported once the device is back; give its other buffered events a moment, then say so.
    if(this.online(run.nodeId))this.#timer(`restored:${run.nodeId}`,()=>this.#restored(run.nodeId),RESTORE_SETTLE_DELAY);
  }
  /** The device registered again. */
  connected(nodeId){
    this.cancel(this.timers.get(`lost:${nodeId}`));this.timers.delete(`lost:${nodeId}`);
    if(this.db.get('connectionOutages',nodeId))this.#timer(`restored:${nodeId}`,()=>this.#restored(nodeId),RESTORE_SETTLE_DELAY);
  }
  #restored(nodeId){
    const outage=this.db.get('connectionOutages',nodeId);if(!outage||!this.online(nodeId))return;
    for(const chat of outage.chats.filter(c=>c.lostNoticeId||c.stopped.length)){
      const names=chat.stopped.map(id=>this.#roleName(id)).filter(Boolean);
      this.#post(chat,'connection_restored',tr(names.length?'connection.restoredStopped':'connection.restored',{device:this.#device(nodeId),roles:names.join(tr('connection.separator'))}),names.length?{continueRoles:names}:{});
      const at=this.now().toISOString();for(const id of chat.stoppedRuns||[]){const run=this.db.get('runs',id);if(run)this.db.put('runs',{...run,connectionNoticedAt:at});}
    }
    this.db.remove('connectionOutages',nodeId);this.change();
  }
}
