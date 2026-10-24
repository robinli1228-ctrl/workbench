import {resolve,relative,isAbsolute,basename,extname} from 'node:path';
import {entryEqual,syncError,validateSourcePath} from './source-sync-manifest.mjs';
import {sourceScopeBinding,projectFileScopeId,isProjectFileScope} from './source-sync-scopes.mjs';

const beneath=(root,path)=>{const rel=relative(root,path);return !isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('../')?rel:null;};

/** Display reads only the bound Mac's actual files; Home transfer blobs are not display copies. */
export class ProjectFiles {
  constructor({db,query,online}){Object.assign(this,{db,query,online});}
  config(projectId){
    const project=this.db.get('projects',projectId);if(!project)throw syncError('project_missing');
    const config=this.db.get('sourceSyncConfigs',projectId)||{};
    // Discovery is independent of transfer activation. Ambiguous Macs require an explicit selection, never Home's hostname.
    const nodes=this.db.list('workspaces').filter(b=>b.projectId===projectId&&b.localRoot&&this.db.get('workers',b.nodeId)?.platform==='darwin');
    const displayNodeId=config.displayNodeId||project.displayNodeId||(nodes.length===1?nodes[0].nodeId:null);
    if(!displayNodeId)throw syncError('display_node_required');
    return {...config,displayNodeId,bindings:this.readBindings(projectId,displayNodeId)};
  }
  /** Read permission follows current registered roots, not the set of writable synchronization scopes. */
  readBindings(projectId,nodeId){
    const repositories=this.db.list('repositoryWorkspaces').filter(b=>b.projectId===projectId&&b.nodeId===nodeId&&b.localRoot&&this.db.get('repositories',b.repositoryId)?.projectId===projectId);
    const project=this.db.get('workspaces',`${projectId}:${nodeId}`),scopes=[...(project?.localRoot?[{...project,repositoryId:projectFileScopeId(projectId)}]:[]),...repositories];
    const isolated=this.db.sourceIsolationRuns(projectId).filter(r=>r.nodeId===nodeId&&r.execution?.isolated&&r.workspace&&r.workspace!==r.projectRoot);
    return scopes.filter(b=>!isolated.some(r=>beneath(resolve(r.workspace),resolve(b.localRoot))!==null)).map(b=>{
      const root=resolve(b.localRoot),sharedDocs=isProjectFileScope(projectId,b.repositoryId);
      const excludeRoots=scopes.filter(other=>other.repositoryId!==b.repositoryId&&!(
        !sharedDocs&&isProjectFileScope(projectId,other.repositoryId)&&resolve(other.localRoot)===root
      )).map(other=>beneath(root,resolve(other.localRoot))).filter(p=>p!==null);
      if(!sharedDocs&&project?.localRoot&&resolve(project.localRoot)===root)excludeRoots.push('.workbench/docs');
      if(!sharedDocs&&excludeRoots.includes(''))throw syncError('overlapping_scope');
      return {repositoryId:b.repositoryId,nodeId,root,scopeKind:'directory',scopePolicy:{sharedDocs,excludeRoots:[...new Set(excludeRoots)].sort()}};
    });
  }
  binding(projectId,scopeId){
    const config=this.config(projectId),nodeId=config.displayNodeId,binding=config.bindings.find(b=>b.repositoryId===scopeId&&b.nodeId===nodeId);
    if(!binding||sourceScopeBinding(this.db,projectId,scopeId,nodeId)?.localRoot!==binding.root)throw syncError('binding_changed');
    const worker=this.db.get('workers',nodeId);if(worker?.platform!=='darwin'||worker?.capabilities?.projectFiles!==1)throw syncError('worker_unsupported');
    return {...binding,projectId,generation:config.generation,revision:config.revision};
  }
  /** An old Worker may preview its own ordinary Run files, never substitute server content for the selected Mac. */
  legacyReadable(run){
    try{const nodeId=this.config(run.projectId).displayNodeId;return run.nodeId===nodeId&&this.db.get('workers',nodeId)?.capabilities?.projectFiles!==1;}catch{return false;}
  }
  /** Older repository-local reports have a collision-free shared copy; historical messages keep their original link. */
  sharedReportReference(projectId,nodeId,absolute){
    const projectRoot=this.db.get('workspaces',`${projectId}:${nodeId}`)?.localRoot;
    if(!projectRoot)return null;
    for(const binding of this.readBindings(projectId,nodeId)){
      if(isProjectFileScope(projectId,binding.repositoryId)||binding.root===resolve(projectRoot))continue;
      const repo=this.db.get('repositories',binding.repositoryId),rel=beneath(binding.root,absolute);
      if(repo?.projectId!==projectId||!repo.key||!rel?.startsWith('.workbench/docs/'))continue;
      const path=`.workbench/docs/repositories/${encodeURIComponent(repo.key)}/${rel.slice('.workbench/docs/'.length)}`;
      try{validateSourcePath(path,{sharedDocs:true,excludeRoots:[]});return {scopeId:projectFileScopeId(projectId),path};}catch{}
    }
    return null;
  }
  /** Map registered scopes only; a same-named isolated output is not a delivered project file. */
  reference(run,path){
    if(!this.db.get('projects',run.projectId))throw syncError('project_missing');
    if(typeof path!=='string'||path.length>4096)return null;
    const logicalDocument=!isAbsolute(path)&&path.startsWith('.workbench/docs/');
    // This logical shared root is resolved separately from the Run workspace; validate its original spelling first.
    if(logicalDocument)try{validateSourcePath(path,{sharedDocs:true,excludeRoots:[]});}catch{return null;}
    const projectRoot=this.db.get('workspaces',`${run.projectId}:${run.nodeId}`)?.localRoot;
    if(logicalDocument&&(!run.projectRoot||!projectRoot||resolve(run.projectRoot)!==resolve(projectRoot)))return null;
    if(!isAbsolute(path)&&!run.workspace&&!logicalDocument)return null;
    const absolute=isAbsolute(path)?resolve(path):resolve(logicalDocument?run.projectRoot:run.workspace,path);
    const sharedReport=this.sharedReportReference(run.projectId,run.nodeId,absolute);
    if(sharedReport)return sharedReport;
    for(const binding of this.readBindings(run.projectId,run.nodeId).sort((a,b)=>b.root.length-a.root.length)){
      if(sourceScopeBinding(this.db,run.projectId,binding.repositoryId,run.nodeId)?.localRoot!==binding.root)continue;
      const rel=relative(binding.root,absolute);if(!rel||isAbsolute(rel)||rel==='..'||rel.startsWith('../'))continue;
      try{validateSourcePath(rel,binding.scopePolicy);return {scopeId:binding.repositoryId,path:rel};}catch{}
    }
    // A reply can quote another device's shared path. Translate only current bindings of this project,
    // never relative Run paths, isolated outputs, or an ambiguous same-spelled scope on another device.
    if(!isAbsolute(path)||path.split('/').some(part=>part==='..'||part==='.')||run.execution?.isolated&&run.workspace&&beneath(resolve(run.workspace),absolute)!==null)return null;
    const nodes=new Set([...this.db.list('workspaces'),...this.db.list('repositoryWorkspaces')].filter(b=>b.projectId===run.projectId&&b.nodeId!==run.nodeId).map(b=>b.nodeId)),references=new Map();
    for(const nodeId of nodes){const report=this.sharedReportReference(run.projectId,nodeId,absolute);if(report)references.set(JSON.stringify(report),report);}
    for(const nodeId of nodes)for(const binding of this.readBindings(run.projectId,nodeId)){
      if(sourceScopeBinding(this.db,run.projectId,binding.repositoryId,nodeId)?.localRoot!==binding.root)continue;
      const rel=beneath(binding.root,absolute);if(!rel)continue;
      try{validateSourcePath(rel,binding.scopePolicy);const ref={scopeId:binding.repositoryId,path:rel};references.set(JSON.stringify(ref),ref);}catch{}
    }
    return references.size===1?[...references.values()][0]:null;
  }
  state(projectId,binding,path,entry){
    if(this.db.listProject('sourceSyncConflicts',projectId).some(c=>c.repositoryId===binding.repositoryId&&c.path===path&&!['resolved','cancelled'].includes(c.status)))return 'conflict';
    const config=this.db.get('sourceSyncConfigs',projectId);
    if(!config?.enabled||!config.repositoryIds?.includes(binding.repositoryId)||!config.nodeIds?.includes(binding.nodeId))return 'disabled';
    const canonical=this.db.get('sourceSyncManifests',`${projectId}:${binding.repositoryId}`),expected=canonical?.entries?.[path]||null;
    if(!entry)return expected?'pending':'missing';return entryEqual(entry,expected)?'synchronized':'pending';
  }
  async queryBinding(binding,action,extra={}){
    if(!this.online(binding.nodeId))throw syncError('display_device_offline');
    const result=await this.query({nodeId:binding.nodeId},action,{...binding,...extra},extra.metadata?5000:30000);
    if(JSON.stringify(this.binding(binding.projectId,binding.repositoryId))!==JSON.stringify(binding))throw syncError('binding_changed');
    return result;
  }
  async read(projectId,scopeId,path,{metadata=false}={}){
    const binding=this.binding(projectId,scopeId);validateSourcePath(path,binding.scopePolicy);
    const result=await this.queryBinding(binding,'project_file',{path,metadata});
    if(result.relativePath!==path||result.path&&result.path!==resolve(binding.root,path))throw syncError('invalid_file_response');
    return {...result,projectId,scopeId,nodeId:binding.nodeId,syncState:this.state(projectId,binding,path,result.entry),shared:true};
  }
  async list(projectId){
    const config=this.config(projectId),items=[],errors=[];let partial=false;
    for(const scopeId of [...new Set(config.bindings.filter(b=>b.nodeId===config.displayNodeId).map(b=>b.repositoryId))]){
      try{const binding=this.binding(projectId,scopeId),result=await this.queryBinding(binding,'project_files',{limit:200});partial ||= result.partial;
        for(const file of result.items){validateSourcePath(file.relativePath,binding.scopePolicy);if(file.path!==resolve(binding.root,file.relativePath))throw syncError('invalid_file_response');
          items.push({...file,projectId,scopeId,nodeId:binding.nodeId,name:basename(file.relativePath),type:extname(file.relativePath).slice(1).toUpperCase()||'FILE',source:'Local project file',shared:true,syncState:this.state(projectId,binding,file.relativePath,file.entry)});
        }
        const known=new Set(result.items.map(f=>f.relativePath));
        if(!result.partial)for(const [path,entry] of Object.entries(this.db.get('sourceSyncManifests',`${projectId}:${scopeId}`)?.entries||{}))if(entry&&!known.has(path)&&items.length<600)items.push({projectId,scopeId,nodeId:binding.nodeId,relativePath:path,path:null,name:basename(path),type:extname(path).slice(1).toUpperCase()||'FILE',source:'Waiting for local synchronization',shared:true,syncState:'pending'});
      }catch(error){partial=true;errors.push({scopeId,error:error.code||error.message});}
    }
    items.sort((a,b)=>Number(b.relativePath.startsWith('.workbench/docs/'))-Number(a.relativePath.startsWith('.workbench/docs/'))||a.relativePath.localeCompare(b.relativePath));
    return {items:items.slice(0,600),partial:partial||items.length>600,errors,displayNodeId:config.displayNodeId};
  }
}
