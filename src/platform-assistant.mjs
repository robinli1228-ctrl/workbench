import { randomUUID } from 'node:crypto';
import { validateLocalSupervisor } from './project-setup.mjs';
import { tr } from './i18n.mjs';

export const configurationPrompt = () => tr('platformAssistant.youFixedPlatformConfigurationAssistant');

const PROJECT_ID = '00000000-0000-4000-8000-000000000001';

/** The configuration conversation reuses the managed CLI and run records but does not mix into the user's project list. */
export class PlatformAssistant {
  constructor({db, rooms, coordinator, query, online, change, devices, projects}) {
    Object.assign(this,{db,rooms,coordinator,query,online,change,devices,projects}); this.preparing = false;
    for(const p of db.list('platformProposals').filter(p=>p.status==='running')) db.put('platformProposals',{...p,status:'blocked',error:tr('platformAssistant.homeRestartedCheckOperationResults')});
  }
  assert(run) { if(run.projectId !== PROJECT_ID || !run.roleSnapshot?.platformAssistant) throw new Error(tr('platformAssistant.onlyPlatformConfigurationAssistantCan')); }
  catalog(run) {
    this.assert(run);
    const repositories=this.db.list('repositories');
    return {devices:this.db.list('devices'), accounts:this.db.list('hostingAccounts'),
      projects:this.db.list('projects').filter(p=>!p.systemConfig).map(p=>({id:p.id,name:p.name,folderName:p.folderName,repositoryCount:repositories.filter(r=>r.projectId===p.id).length})),
      repositories, workspaces:this.db.list('workspaces').filter(w=>w.projectId!==PROJECT_ID),
      workers:this.db.list('workers').map(w=>({id:w.id,name:w.name,nodeKind:w.nodeKind,online:this.online(w.id),workspaceRoot:w.workspaceRoot,allowedRoots:w.allowedRoots,runtimes:w.runtimes})), proposals:this.db.list('platformProposals').slice(-10)};
  }
  propose(run,input) {
    this.assert(run);
    if(typeof input.summary !== 'string' || !input.summary.trim() || input.summary.length>1000 || !Array.isArray(input.actions) || !input.actions.length || input.actions.length>8) throw new Error(tr('platformAssistant.configurationProposalNeedsDescription1'));
    const actions=input.actions.map(a=>{
      if(a.type==='device' && ['check','connect'].includes(a.action) && this.db.get('devices',a.deviceId)) return {type:a.type,deviceId:a.deviceId,action:a.action};
      if(a.type==='workspace' && this.db.get('workers',a.nodeId) && typeof a.workspaceRoot==='string') return {type:a.type,nodeId:a.nodeId,workspaceRoot:a.workspaceRoot,name:String(a.name||'').slice(0,80)};
      if(a.type==='prepare' && this.db.get('projects',a.projectId) && this.db.get('workers',a.nodeId)) return {type:a.type,projectId:a.projectId,nodeId:a.nodeId};
      if(a.type==='repository' && this.db.get('projects',a.projectId)) return {type:a.type,projectId:a.projectId,key:a.key,mode:a.mode,repoUrl:a.repoUrl,accountId:a.accountId,remoteName:a.remoteName,nodeIds:a.nodeIds};
      if(a.type==='cli' && this.db.get('workers',a.nodeId) && ['codex','claude'].includes(a.runtime)) return {type:a.type,nodeId:a.nodeId,runtime:a.runtime};
      throw new Error(tr('platformAssistant.configurationActionTargetDoesNot'));
    });
    const proposal=this.db.put('platformProposals',{id:randomUUID(),summary:input.summary,actions,status:'pending',completed:[],createdAt:new Date().toISOString()});
    this.change();return {proposalId:proposal.id,status:proposal.status};
  }
  async approve(id) {
    let p=this.db.get('platformProposals',id);if(!p)throw new Error(tr('platformAssistant.configurationProposalNotFound'));if(p.status!=='pending')return p;
    if(this.db.get('settings','main')?.paused)throw new Error(tr('platformAssistant.remoteExecutionPaused'));
    p=this.db.put('platformProposals',{...p,status:'running'});this.change();
    try {
      for(const a of p.actions){
        if(this.db.get('settings','main')?.paused)throw new Error(tr('platformAssistant.remoteExecutionPaused2'));
        let result;
        if(a.type==='device')result=await (a.action==='check'?this.devices.check(a.deviceId):this.devices.provision(a.deviceId));
        if(a.type==='prepare')result=await this.projects.prepare(a.projectId,a.nodeId);
        if(a.type==='repository'){result=await this.projects.repository(a.projectId,a);if(result.status!=='ready')throw new Error(tr('platformAssistant.repositoryNotReadyOnSome'));}
        if(a.type==='cli')result=await this.query({nodeId:a.nodeId},'cli_install',{runtime:a.runtime},180000);
        if(a.type==='workspace'){
          const checked=await this.query({nodeId:a.nodeId},'workspace_root',a.workspaceRoot);
          const worker=this.db.get('workers',a.nodeId), config={id:a.nodeId,workspaceRoot:checked.localRoot,name:a.name||worker.name};
          this.db.put('workerConfigs',config);this.db.put('workers',{...worker,...config});result=config;
        }
        p=this.db.put('platformProposals',{...p,completed:[...p.completed,{type:a.type,result}]});this.change();
      }
      p=this.db.put('platformProposals',{...p,status:'succeeded'});
    }catch(e){p=this.db.put('platformProposals',{...p,status:'blocked',error:e.message});}
    this.change();return p;
  }
  state(){return {messages:this.db.get('projects',PROJECT_ID)?this.rooms.messages(PROJECT_ID).messages:[],proposals:this.db.list('platformProposals'),
    config:this.db.get('settings','assistant')||{},prompt:configurationPrompt(),
    tasks:this.db.list('tasks').filter(t=>t.projectId===PROJECT_ID).slice(-10),runs:this.db.list('runs').filter(r=>r.projectId===PROJECT_ID).slice(-10)};}
  async send(input) {
    if(this.db.get('settings','main')?.paused)throw new Error(tr('platformAssistant.remoteExecutionPaused3'));
    if(this.preparing)throw new Error(tr('platformAssistant.assistantInitializing'));
    const {nodeId,runtime,model,effort}=input;
    validateLocalSupervisor(this.db.get('workers',nodeId),input,this.online(nodeId));
    if(this.db.list('tasks').some(t=>t.projectId===PROJECT_ID&&['ready','in_progress'].includes(t.status)))throw new Error(tr('platformAssistant.configurationAssistantStillHandlingPrevious'));
    this.preparing=true;
    try{
      let project=this.db.get('projects',PROJECT_ID);
      if(!project)project=this.db.createProject({id:PROJECT_ID,name:tr('platformAssistant.platformConfigurationAssistant')});
      if(!this.db.get('workspaces',`${PROJECT_ID}:${nodeId}`)){
        const checked=await this.query({nodeId},'supervisor_directory',{projectId:PROJECT_ID});this.db.bindWorkspace(PROJECT_ID,nodeId,checked);
      }
      const roleId=`supervisor-${PROJECT_ID}`;
      this.db.put('projects',{...project,systemConfig:true,supervisorNodeId:nodeId,supervisorRoleId:roleId});
      this.db.put('roles',{id:roleId,projectId:PROJECT_ID,name:tr('platformAssistant.supervisor'),systemSupervisor:true,platformAssistant:true,nodeId,runtime,model,effort:effort||null,mode:'workspace-write',autoApprove:true,instructions:configurationPrompt(),enabled:true,configured:true,revision:1});
      this.db.put('settings',{id:'assistant',nodeId,runtime,model,effort:effort||''});
      return this.rooms.post(PROJECT_ID,{clientMessageId:input.clientMessageId,text:input.text});
    }finally{this.preparing=false;this.change();}
  }
}
