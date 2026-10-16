import {createHash,randomUUID} from 'node:crypto';
import {folderName} from './project-space.mjs';
import {tr} from './i18n.mjs';

const fields=['name','templateKey','responsibility','instructions','nodeId','runtime','model','effort','mode','autoApprove','enabled'];
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
    const selected=[{...supervisor,...Object.fromEntries(['nodeId','runtime','model','effort','enabled'].map(k=>[k,supervisorConfig[k]]))},...order.map(id=>working.find(r=>r.id===id))];
    const roles=selected.map(r=>({id:r.id,revision:r.revision||1,...Object.fromEntries(fields.filter(k=>Object.hasOwn(r,k)).map(k=>[k,r[k]])),systemSupervisor:r.id===supervisor.id}));
    const snapshot={sourceProjectId,sourceName:project.name,supervisorRevision:supervisorConfig.revision||1,roles,roleOrder:[...order],requiredDeviceIds:[...new Set(roles.filter(r=>r.systemSupervisor||r.enabled).map(r=>r.nodeId))]};
    if(snapshot.requiredDeviceIds.some(id=>typeof id!=='string'||!id))throw new Error(tr('teamCopy.sourceInvalid'));
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
        deviceReceipts:Object.fromEntries(snapshot.requiredDeviceIds.map(nodeId=>[nodeId,{nodeId,status:'pending'}])),status:'pending',createdAt:stamp(),updatedAt:stamp()});
      this.change();return this.get(input.requestId);
    });
  }
  /** Explicit detail may contain prompts; the periodic state projection uses projectCopyView instead. */
  get(id){const op=this.db.get('projectCopyOperations',id);if(!op)throw new Error(tr('teamCopy.notFound'));return {...projectCopyView(op),snapshot:op.snapshot};}
}
