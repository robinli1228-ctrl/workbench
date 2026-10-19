import { join } from 'node:path';
import { unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Attachments } from './attachments.mjs';
import { NativeTurnsHome, nativeTurnRows, turnIdPattern } from './native-turns.mjs';
import { assertNativeSessionIdle } from './native-sessions.mjs';
import { nativeTerminalProject, projectTerminalLock } from './terminal-resume.mjs';
import {folderAccessFor,nativeFolderAccess} from './folder-access.mjs';

/**
 * Home's only takeover entry. home.mjs forwards HTTP requests, two Worker message types and disconnects here.
 * Takeover files reuse the Attachments storage/validation code but live in their own directory and record kind,
 * while project/native ownership and capacity use the existing shared terminal leases.
 */
export function createHomeNativeTurns({db,dataDir,send,online,change,busy=()=>false,sessionRecord}) {
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
  const turns=new NativeTurnsHome({db,attachments,send,online,change,leases});
  turns.recover();
  const file=(res,{item,bytes},disposition=true)=>{res.writeHead(200,{'Content-Type':item.mime,'Content-Length':bytes.length,'Cache-Control':'private, no-store',
    ...(disposition?{'Content-Disposition':`${item.mime.startsWith('image/')?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(item.name)}`}:{})});res.end(bytes);return true;};
  /** Returns true when the request belonged to the takeover API. Authentication has already been checked by home.mjs. */
  async function http(req,res,{pathname,url,json,body}) {
    let m=pathname.match(/^\/api\/agent\/native-turns\/([^/]+)\/([^/]+)$/);
    if(m&&req.method==='GET'){const {owner,id}=turns.attachmentFor(m[1],m[2]);return file(res,await attachments.read(owner,id),false);}
    m=pathname.match(/^\/api\/native-sessions\/([^/]+)\/(attachments|takeover|turns|settings)(?:\/([^/]+))?(?:\/([^/]+))?$/);
    if(!m)return false;
    const nodeId=decodeURIComponent(m[1]),worker=db.get('workers',nodeId);if(!worker)throw Error('Device is unavailable');
    const [,,area,a,b]=m;
    if(area==='attachments'&&req.method==='POST'&&!a){json(res,await attachments.upload(NativeTurnsHome.owner(nodeId),req),201);return true;}
    if(area==='attachments'&&req.method==='GET'&&a&&!b)return file(res,await attachments.read(NativeTurnsHome.owner(nodeId),decodeURIComponent(a)));
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
      json(res,{items:turns.list(nodeId,runtime,sessionId),process:open?'open':'closed',supported:worker.capabilities?.nativeTurns===3,controls:worker.capabilities?.nativeControls===1,settings:turns.settings(nodeId,runtime,sessionId)});return true;}
    if(area==='turns'&&!a&&req.method==='POST'){const input=await body(req);if(input.allowAll!==true)throw Error('Confirm automatic tool execution before taking over this session');if(input.control&&worker.capabilities?.nativeControls!==1)throw Error('Upgrade this Worker to compact a native session');json(res,turns.create(nodeId,worker,input),201);return true;}
    if(area==='turns'&&a&&b==='stop'&&req.method==='POST'){json(res,turns.stop(nodeId,decodeURIComponent(a)));return true;}
    throw Error('Invalid session action');
  }
  return {turns,http,
    message:(nodeId,m)=>['native_turn_event','native_takeover_closed','native_takeover_lease'].includes(m.type)?(turns.receive(nodeId,m),true):false,
    disconnected:nodeId=>turns.disconnected(nodeId)};
}
