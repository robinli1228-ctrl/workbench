import {randomUUID} from 'node:crypto';
import {projectFileScopeId} from './source-sync-scopes.mjs';
import {tr} from './i18n.mjs';

const PREVIEW_WAIT_MS=180000,POLL_MS=1000;
const SETTLED=new Set(['preview_ready','completed','partial_conflict','blocked','cancelled','evidence_ready']);
const sleep=ms=>new Promise(resolve=>{const t=setTimeout(resolve,ms);t.unref?.();});

/**
 * A new project made from a folder the user picked on one device: when asked at creation, every other online server device
 * gets an empty folder of the project's name under its default root, is bound to the project, and project file sync is
 * turned on (continuous, project files only). The first sync then copies the picked folder's files there; a file that exists
 * on both sides with different content waits as a conflict. Devices that cannot take part are named in the chat notice.
 * Local devices (another Mac) choose their own folder in project settings, so they are left out.
 */
export class ProjectSyncSetup {
  constructor({db,query,sourceSync,online,change=()=>{},sleepFor=sleep}){Object.assign(this,{db,query,sourceSync,online,change,sleepFor});}
  /** Devices that can get a folder and sync: online, not the source, a server (not a local machine), new enough. */
  targets(sourceNodeId){
    return this.db.list('workers').filter(w=>w.id!==sourceNodeId&&this.online(w.id)&&!w.disabled&&!w.removedAt).map(w=>{
      const c=w.capabilities||{};
      const reason=w.nodeKind==='local'?'local':c.directoryCreate!==1||c.workspaceBindings!==1||c.sourceSync!==1||c.sourceSyncDirectory!==1?'upgrade':null;
      return {worker:w,reason};
    });
  }
  async run(projectId,sourceNodeId){
    const project=this.db.get('projects',projectId);if(!project)return null;
    const record=status=>{const current=this.db.get('projects',projectId);if(current)this.db.put('projects',{...current,syncSetup:{...current.syncSetup,...status,updatedAt:new Date().toISOString()}});this.change();};
    record({status:'running',sourceNodeId,startedAt:new Date().toISOString()});
    const joined=[],skipped=[];
    for(const {worker,reason} of this.targets(sourceNodeId)){
      if(reason){skipped.push({nodeId:worker.id,reason});continue;}
      try{
        const existing=this.db.get('workspaces',`${projectId}:${worker.id}`);
        let localRoot=existing?.localRoot;
        if(!localRoot){
          const parent=worker.workspaceRoot||worker.allowedRoots?.[0];if(!parent)throw new Error('no default folder');
          localRoot=(await this.query({nodeId:worker.id},'directory_create',{path:parent,name:project.folderName})).path;
        }
        const checked=await this.query({nodeId:worker.id,projectId},'workspace_check',localRoot);
        this.db.bindWorkspace(projectId,worker.id,checked);joined.push({nodeId:worker.id,localRoot:checked.localRoot||localRoot});
      }catch(error){skipped.push({nodeId:worker.id,reason:'folder',error:String(error?.message||error).slice(0,300)});}
    }
    this.change();
    const nodeIds=[sourceNodeId,...joined.map(j=>j.nodeId)];
    const display=nodeIds.find(id=>this.db.get('workers',id)?.platform==='darwin');
    let enabled=false,error=null;
    if(!joined.length)error='no_device';
    else if(!display)error='display_mac_required';
    else try{
      const sync=this.sourceSync.sync,repositoryIds=[projectFileScopeId(projectId)];
      const preview=sync.preview(projectId,{requestId:`auto-${randomUUID()}`,nodeIds,repositoryIds,scopeKind:'directory',mode:'continuous',contentMode:'source-only',displayNodeId:display});
      await this.sourceSync.tick?.();
      let batch=preview;const deadline=Date.now()+PREVIEW_WAIT_MS;
      while(!SETTLED.has(batch.status)&&Date.now()<deadline){await this.sleepFor(POLL_MS);batch=this.db.get('sourceSyncBatches',preview.id)||batch;}
      if(batch.status!=='preview_ready')throw Object.assign(new Error(batch.reason||batch.status),{code:batch.reason||'preview_not_ready'});
      sync.configure(projectId,{enabled:true,revision:sync.config(projectId).revision,previewBatchId:preview.id});
      await this.sourceSync.tick?.();enabled=true;
    }catch(e){error=e.code||String(e.message||e).slice(0,200);}
    record({status:enabled?'enabled':'failed',joined,skipped,error,finishedAt:new Date().toISOString()});
    this.notice(projectId,sourceNodeId,{joined,skipped,enabled,error});
    return {joined,skipped,enabled,error};
  }
  /** One Workbench notice in the project's default chat saying what was set up and what was not. */
  notice(projectId,sourceNodeId,{joined,skipped,enabled,error}){
    const name=id=>this.db.get('workers',id)?.name||id;
    const lines=[];
    if(enabled)lines.push(tr('projectSyncSetup.enabled',{source:name(sourceNodeId),devices:joined.map(j=>`${name(j.nodeId)} (${j.localRoot})`).join(', ')}));
    else lines.push(tr('projectSyncSetup.failed',{reason:tr(`projectSyncSetup.reason.${['no_device','display_mac_required'].includes(error)?error:'other'}`,{error:error||''})}));
    for(const s of skipped)lines.push(tr(`projectSyncSetup.skipped.${s.reason}`,{device:name(s.nodeId),error:s.error||''}));
    const at=new Date().toISOString();
    this.db.put('roomMessages',{id:`project-sync-setup-${projectId}`,projectId,sender:'system',senderName:'Workbench',kind:'project_sync',text:lines.join('\n'),taskIds:[],createdAt:at});
    this.change();
  }
}
