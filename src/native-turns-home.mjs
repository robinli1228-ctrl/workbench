import { join } from 'node:path';
import { unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Attachments } from './attachments.mjs';
import { MEDIA_CACHE_CONTROL } from './media-streams.mjs';
import { NativeTurnsHome, nativeTurnRows, turnIdPattern } from './native-turns.mjs';
import { assertNativeSessionIdle } from './native-sessions.mjs';
import { nativeTerminalProject, projectTerminalLock } from './terminal-resume.mjs';
import {folderAccessFor,nativeFolderAccess} from './folder-access.mjs';
import {createHomeSideAsks} from './native-side-ask-home.mjs';
import {NativeAgentSwitches} from './native-agent-switch.mjs';

/**
 * Home's only takeover entry. home.mjs forwards HTTP requests, two Worker message types and disconnects here.
 * Takeover files reuse the Attachments storage/validation code but live in their own directory and record kind,
 * while project/native ownership and capacity use the existing shared terminal leases.
 */
export function createHomeNativeTurns({db,dataDir,send,online,change,busy=()=>false,sessionRecord,workerQuery,gitCredential=async()=>null}) {
  const ownDb=Object.create(db,{
    get:{value:(kind,id)=>kind==='projects'&&String(id).startsWith('native:')?{id}:db.get(kind==='attachments'?'nativeTurnAttachments':kind,id)},
    put:{value:(kind,value)=>db.put(kind==='attachments'?'nativeTurnAttachments':kind,value)}
  });
  const attachments=new Attachments(ownDb,join(dataDir,'native-turn-attachments'));
  const held=id=>{const s=db.get('terminalSessions',id);return Boolean(s&&!['released','cancelled'].includes(s.status));};
  const finishTurns=(nodeId,runtime,sessionId)=>{for(const t of nativeTurnRows(db,{nodeId,runtime,sessionId,active:true,limit:-1}))db.put('nativeTurns',{...t,status:'interrupted',phase:null,endedAt:new Date().toISOString()});};
  const leases={held,
    reserve({nodeId,runtime,sessionId,previous}){
      const record=sessionRecord?.(nodeId,runtime,sessionId);
      if(sessionRecord&&!record)throw Error('Session is not registered with Workbench');
      if(sessionRecord&&db.get('workers',nodeId)?.capabilities?.nativeSessionOwnership!==1)throw Error('Upgrade this Worker to read only Workbench sessions; external history scanning is disabled');
      if(db.get('settings','main')?.paused)throw Error('Remote execution is paused');
      const existing=previous?.leaseId&&held(previous.leaseId)?db.get('terminalSessions',previous.leaseId):null;
      if(existing&&(previous.status!=='open'||existing.status==='stopping'))throw Error('The previous takeover is still closing');
      const leaseId=existing?.id||randomUUID(),owner=nativeTerminalProject(db,{nodeId,runtime,sessionId}),projectId=owner||existing?.projectId||`native-tui:${leaseId}`;
      const lock=projectTerminalLock(db,projectId,nodeId);
      if(lock&&lock.id!==leaseId||busy(projectId,nodeId))throw Error('The related group chat is busy');
      if(db.list('roleSwitches').some(s=>s.projectId===projectId&&(!['committed','cancelled'].includes(s.status)||!s.steps?.released)))throw Error('CLI switch holds this project');
      assertNativeSessionIdle(db,{nodeId,runtime,sessionId,projectId,claimId:leaseId});
      if(!existing)db.put('terminalSessions',{id:leaseId,kind:'native-turn',nodeId,runtime,sessionId,projectId,nativeSession:{runtime,id:sessionId},status:'preparing',createdAt:new Date().toISOString()});
      const bindings=[...db.list('workspaces'),...db.list('repositoryWorkspaces')].filter(w=>w.nodeId===nodeId).map(w=>({projectId:w.projectId,localRoot:w.localRoot}));
      return {leaseId,projectId,managedProjectIds:owner?[owner]:[],bindings,record,folderAccess:nativeFolderAccess(db,nodeId,runtime,sessionId)||folderAccessFor(db,nodeId,owner?`project:${owner}`:null)};
    },
    stopping(id){const s=db.get('terminalSessions',id);if(s&&held(id))db.put('terminalSessions',{...s,status:'stopping'});},
    update(nodeId,m){const s=db.get('terminalSessions',m.leaseId);if(!s||s.nodeId!==nodeId||s.runtime!==m.runtime||s.sessionId!==m.sessionId||!held(s.id))return;
      const owner=nativeTerminalProject(db,{nodeId,runtime:s.runtime,sessionId:s.sessionId,folderProjectIds:m.projectId?.startsWith('native-tui:')?[]:[m.projectId]});
      db.put('terminalSessions',{...s,projectId:owner||s.projectId,workspace:m.workspace,status:s.status==='stopping'?'stopping':m.status==='active'?'active':'prepared',processState:m.status==='active'?'active':'prepared'});
    },
    closed(nodeId,m){const s=db.get('terminalSessions',m.leaseId);if(s&&s.nodeId===nodeId){db.put('terminalSessions',{...s,status:'released',processState:'released',releasedAt:new Date().toISOString()});finishTurns(nodeId,m.runtime,m.sessionId);}}
  };
  const turns=new NativeTurnsHome({db,attachments,send,online,change,leases,gitCredential});
  /** User sends and steers refresh live ownership, never infer that a process exited from an old failed turn. */
  async function refresh(nodeId,runtime,sessionId){
    const key=`${nodeId}/${runtime}/${sessionId}`,previous=db.get('nativeTakeovers',key);
    if(!previous?.leaseId)return;
    if(!held(previous.leaseId)){finishTurns(nodeId,runtime,sessionId);change();return;}
    if(!online(nodeId))throw Error('\u8bbe\u5907\u672a\u8fde\u63a5\uff0c\u6682\u65f6\u65e0\u6cd5\u6838\u5bf9\u4f1a\u8bdd\u72b6\u6001\uff1b\u6d88\u606f\u5c1a\u672a\u53d1\u9001\uff0c\u8bf7\u8fde\u63a5\u540e\u91cd\u8bd5');
    if(db.get('workers',nodeId)?.capabilities?.nativeTakeoverRefresh!==1){
      if(previous.status==='retiring'||previous.status==='closing')throw Error('\u8bf7\u66f4\u65b0 Worker \u540e\u91cd\u8bd5\uff0c\u4f1a\u8bdd\u63a5\u7ba1\u72b6\u6001\u9700\u8981\u91cd\u65b0\u6838\u5bf9');
      return;
    }
    const active=()=>nativeTurnRows(db,{nodeId,runtime,sessionId,active:true,limit:-1});
    const stamp=()=>JSON.stringify([db.get('nativeTakeovers',key),db.get('terminalSessions',previous.leaseId),active().map(t=>[t.id,t.status,t.updatedAt])]);
    const before=stamp(),reply=await workerQuery({nodeId},'native_takeover_state',{runtime,sessionId,leaseId:previous.leaseId},20000);
    // A reply or another send may have advanced the session while this query was in flight.
    if(stamp()!==before)return;
    if(reply?.leaseId!==previous.leaseId||reply.runtime!==runtime||reply.sessionId!==sessionId||!Array.isArray(reply.activeIds))throw Error('\u4f1a\u8bdd\u72b6\u6001\u6838\u5bf9\u4e0d\u5339\u914d\uff0c\u8bf7\u91cd\u8bd5');
    if(reply.paused)throw Error('\u8bbe\u5907\u6267\u884c\u5df2\u6682\u505c\uff0c\u6062\u590d\u540e\u8bf7\u91cd\u8bd5');
    const current=active(),known=new Set(current.map(t=>t.id));
    if(reply.activeIds.some(id=>!known.has(id)))throw Error('\u8bbe\u5907\u4ecd\u6709\u6267\u884c\u4e2d\u7684\u6d88\u606f\uff0c\u7b49\u5f85\u72b6\u6001\u540c\u6b65\u540e\u8bf7\u91cd\u8bd5');
    if(reply.processState==='released'&&!reply.activeIds.length){
      leases.closed(nodeId,{leaseId:previous.leaseId,runtime,sessionId});
      db.put('nativeTakeovers',{...previous,status:'closed',reason:'refreshed',updatedAt:new Date().toISOString()});change();return;
    }
    if(reply.closing||previous.status==='closing')throw Error('\u539f\u4f1a\u8bdd\u8fdb\u7a0b\u4ecd\u5728\u9000\u51fa\uff0c\u9000\u51fa\u540e\u8bf7\u91cd\u8bd5');
    if(reply.processState!=='active'||!reply.reusable){
      if(reply.activeIds.length)return; // The Worker is still preparing this very turn.
      throw Error('\u539f\u4f1a\u8bdd\u8fdb\u7a0b\u5c1a\u672a\u786e\u8ba4\u53ef\u590d\u7528\u6216\u5df2\u9000\u51fa\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5');
    }
    const timestamp=new Date().toISOString();
    for(const turn of current)if(!reply.activeIds.includes(turn.id))db.put('nativeTurns',{...turn,status:'interrupted',phase:null,error:'\u72b6\u6001\u6838\u5bf9\u786e\u8ba4\u4e0a\u4e00\u8f6e\u5df2\u7ed3\u675f',endedAt:timestamp,updatedAt:timestamp});
    db.put('nativeTakeovers',{...previous,status:'open',updatedAt:timestamp});
    const lease=db.get('terminalSessions',previous.leaseId);db.put('terminalSessions',{...lease,status:'active',processState:'active',lastCheckedAt:timestamp});change();
  }
  // Side questions: memory only; their files come from the same per-device attachment store as takeover turns.
  const sideAsks=createHomeSideAsks({send,online,attachments,owner:NativeTurnsHome.owner,change});
  const switches=new NativeAgentSwitches({db,online,workerQuery,turns,sideAsks,change,sessionRecord});
  turns.assertExecutable=identity=>switches.assertExecutable(identity);
  turns.handoffFor=identity=>switches.handoffFor(identity);
  switches.recover();
  // The sweep also retries switch acknowledgements that failed while the Worker stayed connected.
  const sideSweep=setInterval(()=>{sideAsks.sweep();for(const w of db.list('workers'))if(online(w.id))switches.resume(w.id);},5*60000);sideSweep.unref?.();
  turns.recover();
  // Workers read with no-store; the browser keeps an attachment 10 days, since its ID never names other bytes.
  const file=(res,{item,bytes},disposition=true,cache=false)=>{res.writeHead(200,{'Content-Type':item.mime,'Content-Length':bytes.length,'Cache-Control':cache?MEDIA_CACHE_CONTROL:'private, no-store',
    ...(disposition?{'Content-Disposition':`${item.mime.startsWith('image/')?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(item.name)}`}:{})});res.end(bytes);return true;};
  /** Returns true when the request belonged to the takeover API. Authentication has already been checked by home.mjs. */
  async function http(req,res,{pathname,url,json,body}) {
    const switching=pathname.match(/^\/api\/native-sessions\/([^/]+)\/agent-switch(?:\/([^/]+))?$/);
    if(switching){const nodeId=decodeURIComponent(switching[1]);
      if(req.method==='POST'&&!switching[2])json(res,await switches.begin(nodeId,await body(req)));
      else if(req.method==='GET'&&switching[2])json(res,await switches.get(nodeId,decodeURIComponent(switching[2])));
      else if(req.method==='DELETE'&&switching[2])json(res,await switches.cancel(nodeId,decodeURIComponent(switching[2])));
      else throw Error('Invalid Agent switch action');return true;}
    let m=pathname.match(/^\/api\/agent\/native-turns\/([^/]+)\/([^/]+)$/);
    if(m&&req.method==='GET'){const {owner,id}=turns.attachmentFor(m[1],m[2]);return file(res,await attachments.read(owner,id),false);}
    m=pathname.match(/^\/api\/agent\/side-asks\/([^/]+)\/([^/]+)$/);
    if(m&&req.method==='GET'){const {owner,id}=sideAsks.attachmentFor(m[1],m[2]);return file(res,await attachments.read(owner,id),false);}
    m=pathname.match(/^\/api\/native-sessions\/([^/]+)\/(attachments|takeover|turns|settings|side)(?:\/([^/]+))?(?:\/([^/]+))?$/);
    if(!m)return false;
    const nodeId=decodeURIComponent(m[1]),worker=db.get('workers',nodeId);if(!worker)throw Error('Device is unavailable');
    const [,,area,a,b]=m;
    if(area==='attachments'&&req.method==='POST'&&!a){json(res,await attachments.upload(NativeTurnsHome.owner(nodeId),req),201);return true;}
    if(area==='attachments'&&req.method==='GET'&&a&&!b)return file(res,await attachments.read(NativeTurnsHome.owner(nodeId),decodeURIComponent(a)),true,true);
    if(area==='attachments'&&req.method==='DELETE'&&a&&!b){
      const id=decodeURIComponent(a);attachments.resolve(NativeTurnsHome.owner(nodeId),[id]);
      // Remove the record synchronously before unlinking: concurrent sends can no longer bind this file.
      if(db.db.prepare("SELECT 1 FROM records,json_each(records.data,'$.attachments') AS attachment WHERE kind='nativeTurns' AND json_extract(attachment.value,'$.id')=? LIMIT 1").get(id))throw Error('Attachment is already used by a takeover turn');
      db.remove('nativeTurnAttachments',id);await unlink(join(dataDir,'native-turn-attachments',id)).catch(e=>{if(e.code!=='ENOENT')throw e;});json(res,{deleted:true});return true;
    }
    if(area==='takeover'&&a==='release'&&!b&&req.method==='POST'){json(res,turns.release(nodeId,await body(req)));return true;}
    // Model and effort for this native session; one field per request so Claude can apply it with a single slash turn.
    if(area==='settings'&&!a&&req.method==='POST'){if(worker.capabilities?.nativeControls!==1)throw Error('Upgrade this Worker to change the model of a native session');json(res,turns.saveSettings(nodeId,worker,await body(req)));return true;}
    // ?clientTurnId= is a read-only receipt for one composer send in this exact session; it skips process upkeep.
    if(area==='turns'&&!a&&req.method==='GET'&&url.searchParams.has('clientTurnId')){const q=url.searchParams,clientTurnId=q.get('clientTurnId');
      if(!turnIdPattern.test(clientTurnId||''))throw Error('Invalid takeover message ID');
      if(!q.get('runtime')||!q.get('sessionId'))throw Error('Invalid native session ID');
      json(res,{clientTurnId,exists:nativeTurnRows(db,{nodeId,runtime:q.get('runtime'),sessionId:q.get('sessionId'),clientTurnId,limit:1}).length>0});return true;}
    if(area==='turns'&&!a&&req.method==='GET'){const q=url.searchParams,[runtime,sessionId]=[q.get('runtime'),q.get('sessionId')];
      const open=turns.process(nodeId,runtime,sessionId);if(!open)finishTurns(nodeId,runtime,sessionId);
      json(res,{items:turns.list(nodeId,runtime,sessionId),queue:turns.queueState(nodeId,runtime,sessionId),process:open?'open':'closed',supported:worker.capabilities?.nativeTurns===3,controls:worker.capabilities?.nativeControls===1,settings:turns.settings(nodeId,runtime,sessionId)});return true;}
    if(area==='turns'&&!a&&req.method==='POST'){const input=await body(req);if(input.allowAll!==true)throw Error('Confirm automatic tool execution before taking over this session');if(input.control&&worker.capabilities?.nativeControls!==1)throw Error('Upgrade this Worker to compact a native session');
      await refresh(nodeId,input.runtime,input.sessionId);
      const credential=input.control?null:await gitCredential(turns.settings(nodeId,input.runtime,input.sessionId));const created=turns.create(nodeId,worker,input,{gitCredential:credential});
      // A new prompt in the main session: its side question ends, the next one starts from the new state.
      if(!input.control)sideAsks.closeFor(nodeId,input.runtime,input.sessionId);json(res,created,201);return true;}
    // Side question: ask (creates one, or continues ?sideId), read it while it is answered, clear it.
    if(area==='side'&&!a&&req.method==='POST'){const input=await body(req);switches.assertExecutable({...input,nodeId});json(res,sideAsks.ask(nodeId,worker,input),201);return true;}
    if(area==='side'&&a&&!b&&req.method==='GET'){json(res,sideAsks.get(decodeURIComponent(a)));return true;}
    if(area==='side'&&a&&!b&&req.method==='DELETE'){json(res,sideAsks.stop(decodeURIComponent(a)));return true;}
    if(area==='turns'&&a&&b==='stop'&&req.method==='POST'){json(res,turns.stop(nodeId,decodeURIComponent(a)));return true;}
    if(area==='turns'&&a&&b==='steer'&&req.method==='POST'){
      const id=decodeURIComponent(a),turn=db.get('nativeTurns',id);if(!turn||turn.nodeId!==nodeId)throw Error('Takeover turn not found');
      if(turn.status==='waiting')await refresh(nodeId,turn.runtime,turn.sessionId);
      json(res,turns.steer(nodeId,id));return true;}
    if(area==='turns'&&a&&b==='withdraw'&&req.method==='POST'){json(res,turns.withdraw(nodeId,decodeURIComponent(a)));return true;}
    if(area==='turns'&&a&&b==='answer'&&req.method==='POST'){json(res,turns.answer(nodeId,decodeURIComponent(a),await body(req)));return true;}
    // Pause/resume the session's queue or store its dragged order; both live on Home, which dispatches the next message.
    if(area==='turns'&&a==='queue'&&!b&&req.method==='POST'){json(res,turns.setQueue(nodeId,await body(req)));return true;}
    throw Error('Invalid session action');
  }
  return {turns,http,switches,gitCredentialFor:(nodeId,runtime,sessionId)=>gitCredential(turns.settings(nodeId,runtime,sessionId)),
    message:(nodeId,m)=>['side_ask_event','side_ask_closed'].includes(m.type)?sideAsks.receive(nodeId,m):['native_turn_event','native_takeover_closed','native_takeover_lease'].includes(m.type)?(turns.receive(nodeId,m),true):false,sideAsks,
    disconnected:nodeId=>{turns.disconnected(nodeId);sideAsks.disconnected(nodeId);},reconnected:(nodeId,turnIds)=>turns.reconnected(nodeId,turnIds)};
}
