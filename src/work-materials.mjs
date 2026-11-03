import {mkdir,realpath} from 'node:fs/promises';
import {join,relative,isAbsolute} from 'node:path';
import {secretName} from './device-read.mjs';

/**
 * Where a role keeps the logs, query results, probes and scratch scripts of a task: the project's .workbench/tmp, one folder
 * per task and role. It does not sync and is not part of any repository, and roles on other devices read it with
 * wb device ls / read; under /tmp nobody else could see it. Turns without a task use misc/.
 */
export function workMaterialsParts(taskNumber,roleName) {
  const name=String(roleName||'').normalize('NFKC').replace(/[\u0000-\u001f\u007f/\\:]/g,'_').replace(/^\.+/,'').trim().slice(0,60)||'role';
  // A name that looks like a secret ("Auth-Token") would make wb device read refuse the folder.
  const folder=secretName(name)?'role':name;
  return ['.workbench','tmp',Number.isSafeInteger(taskNumber)&&taskNumber>0?`T${taskNumber}`:'misc',folder];
}

/** Creates the folder level by level inside the project (a linked directory never leads elsewhere); null when it cannot. */
export async function workMaterialsFolder(projectRoot,taskNumber,roleName) {
  try {
    const root=await realpath(projectRoot);let directory=root;
    for(const part of workMaterialsParts(taskNumber,roleName)) {
      const next=join(directory,part);
      await mkdir(next,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
      directory=await realpath(next);
      const rel=relative(root,directory);
      if(!rel||rel==='..'||rel.startsWith('../')||isAbsolute(rel))return null;
    }
    return directory;
  } catch {return null;}
}
