import { selectGitVersionBindings, summarizeGitVersions } from './git-version.mjs';
import { tr } from './i18n.mjs';

/** Home stores only displayable version results; Git credentials are passed only within a single Worker query. */
export class ProjectGitVersions {
  constructor({ db, query, hosting, online, change }) { Object.assign(this,{db,query,hosting,online,change}); }

  async refresh(projectId) {
    const project = this.db.get('projects',projectId);
    if (!project) throw new Error(tr('projectGitVersions.projectNotFound'));
    const repositories = this.db.list('repositories').filter(repo=>repo.projectId===projectId);
    const bindings = this.db.list('repositoryWorkspaces').filter(binding=>binding.projectId===projectId);
    const workers = this.db.list('workers').map(worker=>({...worker,online:this.online(worker.id) && worker.capabilities?.gitVersions===1}));
    const supervisorNodeId = project.supervisorRoleId ? this.db.get('roles',project.supervisorRoleId)?.nodeId : null;
    const selected = selectGitVersionBindings(repositories,bindings,workers,supervisorNodeId);
    const items = [];
    const grouped = new Map();
    for (const item of selected) {
      if (!item.binding) {
        items.push({ repositoryId:item.repository.id,key:item.repository.key,status:'unknown',ahead:0,behind:0,checkedAt:new Date().toISOString(),error:tr('projectGitVersions.noRepositoryCopyOnOnline') });
        continue;
      }
      if (!item.online) {
        items.push({repositoryId:item.repository.id,key:item.repository.key,nodeId:item.binding.nodeId,localRoot:item.binding.localRoot,
          status:'offline',ahead:0,behind:0,checkedAt:null,error:tr('projectGitVersions.deviceOfflineDeviceSVersion')});
        continue;
      }
      const list = grouped.get(item.binding.nodeId) || [];
      list.push(item); grouped.set(item.binding.nodeId,list);
    }
    await Promise.all([...grouped].map(async ([nodeId,list])=>{
      try {
        const payload=[];
        for (const {repository,binding} of list) payload.push({ id:repository.id,key:repository.key,repoUrl:repository.repoUrl,
          localRoot:binding.localRoot,credential:await this.hosting.auth(repository.accountId,repository.repoUrl),
          // Devices are compared with the repository's unified branch when one is set.
          ...(repository.baseBranch?{targetBranch:repository.baseBranch}:{}) });
        const results=await this.query({nodeId,projectId},'project_git_versions',{repositories:payload},90000);
        for(const result of results) items.push({...result,nodeId});
      } catch(error) {
        const checkedAt=new Date().toISOString();
        for(const {repository,binding} of list) items.push({repositoryId:repository.id,key:repository.key,nodeId,localRoot:binding.localRoot,
          status:'unknown',ahead:0,behind:0,checkedAt,error:error.message});
      }
    }));
    items.sort((a,b)=>String(a.nodeId||'').localeCompare(String(b.nodeId||'')) || String(a.key).localeCompare(String(b.key)));
    // Each online device's project folder: still there, or deleted/moved since it was bound.
    const folders=await Promise.all(this.db.list('workspaces').filter(w=>w.projectId===projectId&&w.localRoot).map(async w=>{
      if(!this.online(w.nodeId))return {nodeId:w.nodeId,status:'offline'};
      try{await this.query({nodeId:w.nodeId,projectId},'workspace_check',w.localRoot,15000);return {nodeId:w.nodeId,status:'ready'};}
      catch(error){return {nodeId:w.nodeId,status:'unavailable',error:error.message};}
    }));
    const value={id:projectId,projectId,items,folders,summary:summarizeGitVersions(items),updatedAt:new Date().toISOString()};
    this.db.put('projectGitVersions',value);this.change();return value;
  }
}
