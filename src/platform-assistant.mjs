import { randomUUID } from 'node:crypto';
import { validateLocalSupervisor } from './project-setup.mjs';

export const CONFIGURATION_PROMPT = `You are the fixed platform configuration assistant of Agent Workbench, responsible for device onboarding, workspaces, CLI readiness checks, code-hosting account checks, and project initialization. You work on demand and do not take part in project development.
First call wb setup catalog to query the real devices, accounts, and projects. Use fields such as repositoryCount from the result for counts; when a field is missing, say it is unknown, and do not infer that there is no repository from an empty repoUrl. When the information is sufficient, propose concrete configuration actions directly; ask only for the necessary information that is missing.
Device flow: connectivity check, default workspace, Worker onboarding, CLI/model/login check. Installed does not mean logged in, and a started Worker does not mean it is connected to Home; never report success falsely.
The project directory is computed from the device workspace plus the project folder name. All roles share all repositories of their project, so no primary repository configuration is needed.
Secrets are entered only through the credential form in basic settings; never ask for passwords, tokens, or private keys to be sent in the conversation, and never output or save secrets into project files.
Submit configuration cards only through wb setup propose '<JSON>'. Format {"summary":"description","actions":[...]}.
Available actions: {"type":"device","deviceId":"REGISTERED_DEVICE_ID","action":"check or connect"}; {"type":"workspace","nodeId":"NODE_ID","workspaceRoot":"directory within the allowed scope","name":"device name"}; {"type":"repository","projectId":"PROJECT_ID","key":"repository directory name","mode":"existing or create","repoUrl":"existing GitHub/Gitee URL","accountId":"VERIFIED_ACCOUNT_ID","remoteName":"new repository name","nodeIds":["DEVICE_ID"]}; {"type":"prepare","projectId":"PROJECT_ID","nodeId":"DEVICE_ID"}; {"type":"cli","nodeId":"NODE_ID","runtime":"codex or claude"}.
A deviceId is usable only after the user has saved the new device information. When credentials are not configured yet, direct the user to the form. Finish the checks first, then propose operations that modify devices. Do not bypass the tools to run SSH, installs, remote repository creation, or writes to the platform database yourself.
After a proposal is submitted, wait for the user to click execute; do not approve it yourself. Query the operation status repeatedly to avoid creating duplicates. Verify ownership of existing directories and repositories first; on failure, preserve the scene and report what was actually completed and what the user needs to do.`;

const PROJECT_ID = '00000000-0000-4000-8000-000000000001';

/** The configuration conversation reuses the managed CLI and run records but does not mix into the user's project list. */
export class PlatformAssistant {
  constructor({db, rooms, coordinator, query, online, change, devices, projects}) {
    Object.assign(this,{db,rooms,coordinator,query,online,change,devices,projects}); this.preparing = false;
    for(const p of db.list('platformProposals').filter(p=>p.status==='running')) db.put('platformProposals',{...p,status:'blocked',error:'Home restarted; check the operation results before continuing'});
  }
  assert(run) { if(run.projectId !== PROJECT_ID || !run.roleSnapshot?.platformAssistant) throw new Error('Only the platform configuration assistant can call this'); }
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
    if(typeof input.summary !== 'string' || !input.summary.trim() || input.summary.length>1000 || !Array.isArray(input.actions) || !input.actions.length || input.actions.length>8) throw new Error('A configuration proposal needs a description and 1-8 actions');
    const actions=input.actions.map(a=>{
      if(a.type==='device' && ['check','connect'].includes(a.action) && this.db.get('devices',a.deviceId)) return {type:a.type,deviceId:a.deviceId,action:a.action};
      if(a.type==='workspace' && this.db.get('workers',a.nodeId) && typeof a.workspaceRoot==='string') return {type:a.type,nodeId:a.nodeId,workspaceRoot:a.workspaceRoot,name:String(a.name||'').slice(0,80)};
      if(a.type==='prepare' && this.db.get('projects',a.projectId) && this.db.get('workers',a.nodeId)) return {type:a.type,projectId:a.projectId,nodeId:a.nodeId};
      if(a.type==='repository' && this.db.get('projects',a.projectId)) return {type:a.type,projectId:a.projectId,key:a.key,mode:a.mode,repoUrl:a.repoUrl,accountId:a.accountId,remoteName:a.remoteName,nodeIds:a.nodeIds};
      if(a.type==='cli' && this.db.get('workers',a.nodeId) && ['codex','claude'].includes(a.runtime)) return {type:a.type,nodeId:a.nodeId,runtime:a.runtime};
      throw new Error('The configuration action or target does not exist');
    });
    const proposal=this.db.put('platformProposals',{id:randomUUID(),summary:input.summary,actions,status:'pending',completed:[],createdAt:new Date().toISOString()});
    this.change();return {proposalId:proposal.id,status:proposal.status};
  }
  async approve(id) {
    let p=this.db.get('platformProposals',id);if(!p)throw new Error('Configuration proposal not found');if(p.status!=='pending')return p;
    if(this.db.get('settings','main')?.paused)throw new Error('Remote execution is paused');
    p=this.db.put('platformProposals',{...p,status:'running'});this.change();
    try {
      for(const a of p.actions){
        if(this.db.get('settings','main')?.paused)throw new Error('Remote execution is paused');
        let result;
        if(a.type==='device')result=await (a.action==='check'?this.devices.check(a.deviceId):this.devices.provision(a.deviceId));
        if(a.type==='prepare')result=await this.projects.prepare(a.projectId,a.nodeId);
        if(a.type==='repository'){result=await this.projects.repository(a.projectId,a);if(result.status!=='ready')throw new Error('The repository is not ready on some devices; check the project settings');}
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
    config:this.db.get('settings','assistant')||{},prompt:CONFIGURATION_PROMPT,
    tasks:this.db.list('tasks').filter(t=>t.projectId===PROJECT_ID).slice(-10),runs:this.db.list('runs').filter(r=>r.projectId===PROJECT_ID).slice(-10)};}
  async send(input) {
    if(this.db.get('settings','main')?.paused)throw new Error('Remote execution is paused');
    if(this.preparing)throw new Error('The assistant is initializing');
    const {nodeId,runtime,model,effort}=input;
    validateLocalSupervisor(this.db.get('workers',nodeId),input,this.online(nodeId));
    if(this.db.list('tasks').some(t=>t.projectId===PROJECT_ID&&['ready','in_progress'].includes(t.status)))throw new Error('The configuration assistant is still handling the previous message');
    this.preparing=true;
    try{
      let project=this.db.get('projects',PROJECT_ID);
      if(!project)project=this.db.createProject({id:PROJECT_ID,name:'Platform Configuration Assistant'});
      if(!this.db.get('workspaces',`${PROJECT_ID}:${nodeId}`)){
        const checked=await this.query({nodeId},'supervisor_directory',{projectId:PROJECT_ID});this.db.bindWorkspace(PROJECT_ID,nodeId,checked);
      }
      const roleId=`supervisor-${PROJECT_ID}`;
      this.db.put('projects',{...project,systemConfig:true,supervisorNodeId:nodeId,supervisorRoleId:roleId});
      this.db.put('roles',{id:roleId,projectId:PROJECT_ID,name:'Supervisor',systemSupervisor:true,platformAssistant:true,nodeId,runtime,model,effort:effort||null,mode:'workspace-write',autoApprove:true,instructions:CONFIGURATION_PROMPT,enabled:true,configured:true,revision:1});
      this.db.put('settings',{id:'assistant',nodeId,runtime,model,effort:effort||''});
      return this.rooms.post(PROJECT_ID,{clientMessageId:input.clientMessageId,text:input.text});
    }finally{this.preparing=false;this.change();}
  }
}
