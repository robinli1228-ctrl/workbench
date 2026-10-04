import {readFileSync} from 'node:fs';
import {writeFile,rename} from 'node:fs/promises';

const keys=['WB_PROJECT_ROOT','WB_KNOWLEDGE','WB_WORKSPACE','WB_RUN_ID','WB_ROLE_SESSION_ID','WB_CONVERSATION_ID','WB_REQUEST_ID','WB_ROLE','WB_SYSTEM_SUPERVISOR','WB_CLI','WB_BRIDGE','WB_HOP','WB_HOME','WB_MODE','WB_REPOSITORIES'];
keys.push('WB_TURN_PURPOSE','WB_DISCUSSION_PROTOCOL');

/** Every turn uses its own entry file, so an old background command cannot regain permissions through the next turn's scope. */
export async function writeTurnContext(path,env) {
  await writeFile(`${path}.tmp`,JSON.stringify(Object.fromEntries(keys.map(key=>[key,String(env[key]||'')]))),{mode:0o600});
  await rename(`${path}.tmp`,path);
}
export function loadTurnContext(env=process.env) {
  if(!env.WB_TURN_CONTEXT)return;
  const current=JSON.parse(readFileSync(env.WB_TURN_CONTEXT,'utf8'));
  if(!current.WB_RUN_ID || !current.WB_BRIDGE)throw new Error('The tool context for this turn is no longer valid');
  for(const key of keys)env[key]=String(current[key]||'');
}

/** A kept-alive CLI environment does not change automatically, so the prompt calls the same wb tools through an explicit prefix for this turn. */
export function turnToolCommand(path,cli,node=process.execPath,{boundCli=false}={}) {
  const quote=value=>`'${String(value).replaceAll("'","'\\''")}'`;
  return `WB_TURN_CONTEXT=${quote(path)} ${quote(node)} ${boundCli?'"${WB_CLI:?Worker CLI path missing}"':quote(cli)}`;
}
