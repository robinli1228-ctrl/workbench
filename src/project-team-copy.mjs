import {createHash,randomUUID} from 'node:crypto';
import {folderName,within} from './project-space.mjs';
import {join,isAbsolute,resolve} from 'node:path';
import {runtimeIssue} from './runtime-probe.mjs';
import {tr} from './i18n.mjs';

const fields=['name','templateKey','responsibility','instructions','nodeId','runtime','model','effort','mode','autoApprove','enabled','permissionScope'];
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stamp=()=>new Date().toISOString();

/** Compact recurring progress intentionally excludes accepted prompt bodies. */
export function projectCopyView(op){return {id:op.id,sourceProjectId:op.sourceProjectId,destinationProjectId:op.destinationProjectId,name:op.name,folderName:op.folderName,status:op.status,sourceRevision:op.sourceRevision,roleIdMap:op.roleIdMap,deviceReceipts:op.deviceReceipts,error:op.error||null};}

/** A frozen, allow-listed team is distinct from execution history and filesystem provisioning. */
export class ProjectTeamCopy {
  constructor({db,query,online,change=()=>{}}){Object.assign(this,{db,query,online,change});this.inflight=new Map();}
  preview(sourceProjectId,{roleOrder}={}){
    const project=this.db.get('projects',sourceProjectId),supervisor=this.db.get('roles',project?.supervisorRoleId||'');
    if(!project||project.systemConfig||project.setupStatus==='copy_pending'||!supervisor||supervisor.archivedAt)throw new Error(tr('teamCopy.sourceInvalid'));
    const supervisorConfig=this.db.get('supervisorConfigs',`${project.id}:${project.supervisorNodeId||supervisor.nodeId}`);
    if(!supervisorConfig)throw new Error(tr('teamCopy.sourceInvalid'));
    const working=this.db.listProject('roles',project.id).filter(r=>r.id!==supervisor.id&&!r.systemSupervisor&&!r.archivedAt);
    const order=roleOrder===undefined?working.map(r=>r.id):roleOrder;
    if(!Array.isArray(order)||order.length!==working.length||new Set(order).size!==order.length||order.some(id=>!working.some(r=>r.id===id)))throw new Error(tr('teamCopy.invalidOrder'));
    const selected=[{...supervisor,...Object.fromEntries(['nodeId','runtime','model','effort','enabled','permissionScope'].filter(k=>supervisorConfig[k]!==undefined||k!=='permissionScope').map(k=>[k,supervisorConfig[k]]))},...order.map(id=>working.find(r=>r.id===id))];
    const roles=selected.map(r=>({id:r.id,revision:r.revision||1,...Object.fromEntries(fields.filter(k=>Object.hasOwn(r,k)).map(k=>[k,r[k]])),systemSupervisor:r.id===supervisor.id}));
    const snapshot={sourceProjectId,sourceName:project.name,supervisorRevision:supervisorConfig.revision||1,roles,roleOrder:[...order],requiredDeviceIds:[...new Set(roles.filter(r=>r.systemSupervisor||r.enabled).map(r=>r.nodeId))]};
    if(snapshot.requiredDeviceIds.some(id=>typeof id!=='string'||!id))throw new Error(tr('teamCopy.sourceInvalid'));
    snapshot.deviceRoots=Object.fromEntries(snapshot.requiredDeviceIds.map(id=>[id,this.db.get('workers',id)?.workspaceRoot||this.db.get('workers',id)?.allowedRoots?.[0]||null]));
    return {...snapshot,sourceRevision:hash(snapshot),warnings:[tr('teamCopy.promptWarning')]};
  }
  begin(sourceProjectId,input={}){
    return this.db.transaction(()=>{
      if(!uuid(input.requestId)||typeof input.name!=='string'||!input.name.trim()||input.name.trim().length>80)throw new Error(tr('teamCopy.invalidInput'));
      const name=input.name.trim(),folder=folderName(input.folderName),fingerprint=hash([sourceProjectId,name,folder,input.sourceRevision,input.roleOrder]);
      const previous=this.db.get('projectCopyOperations',input.requestId);
      if(previous){if(previous.fingerprint!==fingerprint)throw new Error(tr('conversations.retryConflict'));return this.get(previous.id);}
      const snapshot=this.preview(sourceProjectId,{roleOrder:input.roleOrder});
      if(snapshot.sourceRevision!==input.sourceRevision)throw new Error(tr('teamCopy.sourceChanged'));
      if(this.db.list('projects').some(p=>p.name===name||p.folderName===folder))throw new Error(tr('teamCopy.destinationExists'));
      const destinationProjectId=randomUUID(),roleIdMap=Object.fromEntries(snapshot.roles.map(r=>[r.id,r.systemSupervisor?`supervisor-${destinationProjectId}`:randomUUID()]));
      this.db.put('projects',{id:destinationProjectId,name,folderName:folder,description:'',root:'',repoUrl:'',repository:null,projectScope:true,setupStatus:'copy_pending',copyOperationId:input.requestId,createdAt:stamp()});
      this.db.put('projectCopyOperations',{id:input.requestId,sourceProjectId,destinationProjectId,name,folderName:folder,fingerprint,sourceRevision:snapshot.sourceRevision,snapshot,roleIdMap,
        deviceReceipts:Object.fromEntries(snapshot.requiredDeviceIds.map(nodeId=>[nodeId,{nodeId,workspaceRoot:snapshot.deviceRoots[nodeId],status:'pending'}])),status:'pending',createdAt:stamp(),updatedAt:stamp()});
      this.change();return this.get(input.requestId);
    });
  }
  /** Explicit detail may contain prompts; the periodic state projection uses projectCopyView instead. */
  get(id){const op=this.db.get('projectCopyOperations',id);if(!op)throw new Error(tr('teamCopy.notFound'));return {...projectCopyView(op),snapshot:op.snapshot};}

  /** One bounded attempt per click; concurrent retries share the same in-process operation. */
  retry(id){
    if(this.inflight.has(id))return this.inflight.get(id);
    const attempt=this.prepare(id).finally(()=>this.inflight.delete(id));this.inflight.set(id,attempt);return attempt;
  }
  save(id,patch){const op=this.db.get('projectCopyOperations',id);if(!op)throw new Error(tr('teamCopy.notFound'));const result=this.db.put('projectCopyOperations',{...op,...patch,updatedAt:stamp()});this.change();return result;}
  receipt(id,nodeId,patch){const op=this.db.get('projectCopyOperations',id);return this.save(id,{deviceReceipts:{...op.deviceReceipts,[nodeId]:{...op.deviceReceipts[nodeId],...patch}}});}
  async prepare(id){
    let op=this.db.get('projectCopyOperations',id);if(!op)throw new Error(tr('teamCopy.notFound'));if(op.status==='ready')return this.get(id);
    op=this.save(id,{status:'preparing',error:null});
    const pending=Object.values(op.deviceReceipts).filter(r=>r.status!=='ready');
    const prepareNode=async receipt=>{
      const {nodeId}=receipt;
      try{
        const worker=this.db.get('workers',nodeId);if(!this.online(nodeId))throw new Error('device_offline');
        if(worker?.capabilities?.projectTeamCopy!==1)throw new Error('worker_upgrade_required');
        const workspaceRoot=receipt.workspaceRoot||worker.workspaceRoot||worker.allowedRoots?.[0];
        if(!isAbsolute(workspaceRoot||''))throw new Error('workspace_root_unavailable');
        this.receipt(id,nodeId,{status:'preparing',workspaceRoot,error:null});
        const result=await this.query({nodeId},'project_directory',{projectId:op.destinationProjectId,folder:op.folderName,workspaceRoot,creationOperationId:id});
        const currentWorker=this.db.get('workers',nodeId);
        if(currentWorker?.capabilities?.projectTeamCopy!==1||result?.projectId!==op.destinationProjectId||result.creationOperationId!==id||result.managed!==true||result.folderName!==op.folderName||!isAbsolute(result.localRoot||'')||resolve(result.localRoot)!==join(workspaceRoot,op.folderName)||!(currentWorker.allowedRoots||[]).some(root=>within(root,result.localRoot)))throw new Error('directory_receipt_mismatch');
        this.receipt(id,nodeId,{status:'ready',result,verifiedAt:stamp(),error:null});
      }catch(error){this.receipt(id,nodeId,{status:'blocked',error:String(error.message).slice(0,500)});}
    };
    // Do not create a device storm for large teams, and never repeat verified filesystem work.
    for(let i=0;i<pending.length;i+=2)await Promise.all(pending.slice(i,i+2).map(prepareNode));
    op=this.db.get('projectCopyOperations',id);
    if(Object.values(op.deviceReceipts).some(r=>r.status!=='ready')){this.save(id,{status:'blocked',error:'workspace_preparation_incomplete'});return this.get(id);}
    try{
      for(const receipt of Object.values(op.deviceReceipts)){
        const worker=this.db.get('workers',receipt.nodeId);
        if(worker?.capabilities?.projectTeamCopy!==1||!(worker.allowedRoots||[]).some(root=>within(root,receipt.result.localRoot)))throw new Error('directory_binding_changed');
      }
      for(const role of op.snapshot.roles.filter(r=>r.systemSupervisor||r.enabled)){
        if(!this.online(role.nodeId))throw new Error('device_offline');
        const issue=runtimeIssue(this.db.get('workers',role.nodeId),role.runtime,role.model);if(issue)throw new Error(issue);
      }
      this.db.transaction(()=>{
        const current=this.db.get('projectCopyOperations',id);if(current.status==='ready')return;
        const project=this.db.get('projects',op.destinationProjectId);if(project?.copyOperationId!==id||project.setupStatus!=='copy_pending')throw new Error('destination_ownership_changed');
        for(const receipt of Object.values(op.deviceReceipts))this.db.bindWorkspace(project.id,receipt.nodeId,receipt.result);
        for(const original of op.snapshot.roles){
          const {id:sourceId,revision,...settings}=original;
          const configured=Boolean(op.deviceReceipts[settings.nodeId]?.status==='ready'&&!runtimeIssue(this.db.get('workers',settings.nodeId),settings.runtime,settings.model));
          this.db.put('roles',{...settings,id:op.roleIdMap[sourceId],projectId:project.id,copyOperationId:id,revision:1,configured});
        }
        const supervisor=op.snapshot.roles.find(r=>r.systemSupervisor),supervisorRoleId=op.roleIdMap[supervisor.id];
        this.db.put('supervisorConfigs',{id:`${project.id}:${supervisor.nodeId}`,projectId:project.id,nodeId:supervisor.nodeId,runtime:supervisor.runtime,model:supervisor.model,effort:supervisor.effort??null,enabled:supervisor.enabled,revision:1,updatedAt:stamp()});
        this.db.put('projects',{...project,supervisorRoleId,supervisorNodeId:supervisor.nodeId,initialRoleOrder:op.snapshot.roleOrder.map(id=>op.roleIdMap[id]),setupStatus:'ready'});
        this.db.put('roomMessages',{id:`welcome-${project.id}`,projectId:project.id,conversationId:project.id,sender:'system',senderName:'Workbench',text:tr('teamCopy.welcome'),taskIds:[],createdAt:stamp()});
        this.db.put('rooms',{id:project.id,projectId:project.id,conversationId:project.id,revision:1});
        this.save(id,{status:'ready',error:null});
      });
    }catch(error){this.save(id,{status:'blocked',error:String(error.message).slice(0,500)});}
    return this.get(id);
  }
}
