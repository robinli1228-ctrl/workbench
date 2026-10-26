import {relative,isAbsolute,resolve} from 'node:path';
import {syncError} from './source-sync-manifest.mjs';

export const projectFileScopeId=projectId=>`project-files:${projectId}`;
export const isProjectFileScope=(projectId,id)=>id===projectFileScopeId(projectId);
const beneath=(root,path)=>{const rel=relative(root,path);return !isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('../')?rel:null;};

/** Resolve only registered project/repository bindings; filesystem scopes never masquerade as Git repositories. */
export function sourceScopeBinding(db,projectId,repositoryId,nodeId){
  if(isProjectFileScope(projectId,repositoryId))return db.get('workspaces',`${projectId}:${nodeId}`);
  if(db.get('repositories',repositoryId)?.projectId!==projectId)return null;
  return db.get('repositoryWorkspaces',`${repositoryId}:${nodeId}`);
}

/** A read-only preview must not pin receiver state before its scope is explicitly activated. */
export function recordSourceBinding(db,command,root){
  const id=`${command.projectId}:${command.repositoryId}${command.sourceRunId?':'+command.sourceRunId:''}`,contract=JSON.stringify({scopeKind:command.scopeKind||'repository',scopePolicy:command.scopePolicy||{},...(command.detection?{detection:command.detection}:{})});
  const binding={id,projectId:command.projectId,repositoryId:command.repositoryId,root,generation:command.generation,contract};
  if(command.preview)return binding;
  const old=db.get('sourceSyncBindings',id);
  if(old&&(old.generation>command.generation||old.generation===command.generation&&(old.root!==root||old.contract&&old.contract!==contract)))throw syncError('binding_changed');
  return db.put('sourceSyncBindings',binding);
}

/** Partition container/repository layouts so each physical file has exactly one receiving scope. */
export function buildSourceBindings(db,projectId,repositoryIds,nodeIds,{scopeKind,contentMode,detection}={}){
  const directory=scopeKind==='directory',withProject=repositoryIds.includes(projectFileScopeId(projectId));
  if(contentMode!==undefined&&!['source-only','source-and-outputs'].includes(contentMode)||contentMode==='source-and-outputs'&&!directory)throw syncError('invalid_scope');
  if(detection!==undefined&&detection!=='metadata')throw syncError('invalid_scope');
  if(detection==='metadata'&&(!directory||nodeIds.length!==2))throw syncError('metadata_two_devices');
  // Reuse only within this synchronous check; a later call must see newly created isolated workspaces.
  let isolationRuns;
  const bindings=repositoryIds.flatMap(repositoryId=>nodeIds.map(nodeId=>{
    const projectScope=isProjectFileScope(projectId,repositoryId),binding=sourceScopeBinding(db,projectId,repositoryId,nodeId),worker=db.get('workers',nodeId),repo=db.get('repositories',repositoryId);
    if(projectScope&&!directory)throw syncError('invalid_scope');
    if(worker?.capabilities?.sourceSync!==1||directory&&worker.capabilities.sourceSyncDirectory!==1)throw syncError('worker_unsupported',nodeId);
    if(detection==='metadata'&&worker.capabilities.sourceSyncMetadataMode!==1)throw syncError('worker_unsupported',nodeId);
    if(contentMode==='source-and-outputs'&&worker.capabilities.sourceSyncOutputs!==1)throw syncError('worker_unsupported',nodeId);
    if(binding?.projectId!==projectId||!binding.localRoot)throw syncError('binding_missing');
    if(binding.readOnly||repo?.readOnly)throw syncError('scope_read_only');
    const root=resolve(binding.localRoot);
    // Resumed history may retain registered repository metadata: only the actual isolated workspace owns private paths.
    if(directory&&(isolationRuns??=db.sourceIsolationRuns(projectId)).some(r=>r.nodeId===nodeId&&r.execution?.isolated&&r.workspace&&r.workspace!==r.projectRoot&&beneath(r.workspace,root)!==null))throw syncError('deliver_to_project_first');
    if(!directory)return {repositoryId,nodeId,root,repoUrl:repo.repoUrl};
    const projectRoot=db.get('workspaces',`${projectId}:${nodeId}`)?.localRoot;
    const others=db.list('repositoryWorkspaces').filter(b=>b.projectId===projectId&&b.nodeId===nodeId&&b.repositoryId!==repositoryId&&b.localRoot);
    const excludeRoots=others.map(b=>beneath(root,resolve(b.localRoot))).filter(p=>p!==null);
    // The project scope already owns shared documents when both bindings name the same root.
    if(contentMode==='source-and-outputs'&&!projectScope&&withProject&&projectRoot&&resolve(projectRoot)===root)excludeRoots.push('.workbench/docs');
    if(!projectScope&&withProject&&projectRoot&&resolve(projectRoot)!==root){const rel=beneath(root,resolve(projectRoot));if(rel!==null)excludeRoots.push(rel);}
    const scopePolicy={sharedDocs:projectScope,excludeRoots:[...new Set(excludeRoots)].sort(),...(contentMode==='source-and-outputs'?{contentMode}:{})};
    if(!projectScope&&scopePolicy.excludeRoots.includes(''))throw syncError('overlapping_scope');
    return {repositoryId,nodeId,root,repoUrl:repo?.repoUrl||null,scopeKind:'directory',scopePolicy,...(detection?{detection}:{})};
  }));
  // Different container layouts still need one common exclusion policy for each logical scope.
  if(directory)for(const repositoryId of repositoryIds){
    const peers=bindings.filter(b=>b.repositoryId===repositoryId),excludeRoots=[...new Set(peers.flatMap(b=>b.scopePolicy.excludeRoots))].sort();
    for(const b of peers)b.scopePolicy={...b.scopePolicy,excludeRoots};
  }
  return bindings;
}
