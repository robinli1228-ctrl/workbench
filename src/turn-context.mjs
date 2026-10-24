import {readFileSync} from 'node:fs';
import {writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import { tr } from './i18n.mjs';

const keys=['WB_PROJECT_ROOT','WB_KNOWLEDGE','WB_WORKSPACE','WB_RUN_ID','WB_ROLE_SESSION_ID','WB_CONVERSATION_ID','WB_REQUEST_ID','WB_ROLE','WB_SYSTEM_SUPERVISOR','WB_CLI','WB_BRIDGE','WB_HOP','WB_HOME','WB_MODE','WB_REPOSITORIES'];
keys.push('WB_TURN_PURPOSE','WB_DISCUSSION_PROTOCOL','WB_SOURCE_SYNC','WB_REVIEW_PRIVATE','WB_DOCUMENT_VIEWS','WB_QUEUE_BATCH');
keys.push('WB_PLATFORM_ASSISTANT','WB_NODE_ID');

/** Every turn uses its own entry file, so an old background command cannot regain permissions through the next turn's scope. */
export async function writeTurnContext(path,env) {
  await writeFile(`${path}.tmp`,JSON.stringify(Object.fromEntries(keys.map(key=>[key,String(env[key]||'')]))),{mode:0o600});
  await rename(`${path}.tmp`,path);
}
/** A reused process must select an immutable turn, never discover or inherit the latest bridge implicitly. */
export function loadTurnContext(env=process.env,{turnId}={}) {
  if(env.WB_REQUIRE_TURN==='1'&&!turnId)throw new Error(tr('turnContext.explicitTurnRequired'));
  if(turnId&&(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(turnId)||!env.WB_WORKSPACE||!env.WB_ROLE_SESSION_ID))throw new Error(tr('turnContext.invalidTurn'));
  const path=turnId?join(env.WB_WORKSPACE,`.wb-bridge-${turnId}`,'turn-context.json'):env.WB_TURN_CONTEXT;
  if(!path)return;
  let current;
  try{current=JSON.parse(readFileSync(path,'utf8'));}catch{throw new Error(tr('turnContext.expiredTurn'));}
  if(!current.WB_RUN_ID || !current.WB_BRIDGE)throw new Error(tr('turnContext.toolContextForTurnNo'));
  if(turnId&&(current.WB_RUN_ID!==turnId||current.WB_ROLE_SESSION_ID!==env.WB_ROLE_SESSION_ID||current.WB_CONVERSATION_ID!==env.WB_CONVERSATION_ID||current.WB_WORKSPACE!==env.WB_WORKSPACE||current.WB_BRIDGE!==join(env.WB_WORKSPACE,`.wb-bridge-${turnId}`)))throw new Error(tr('turnContext.invalidTurn'));
  for(const key of keys)env[key]=String(current[key]||'');
  env.WB_TURN_CONTEXT=path;
}

/** A kept-alive CLI environment does not change automatically, so the prompt calls the same wb tools through an explicit prefix for this turn. */
export function turnToolCommand(path,cli,node=process.execPath,{boundCli=false,turnId}={}) {
  if(turnId){if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(turnId))throw new Error(tr('turnContext.invalidTurn'));return `wb --turn ${turnId}`;}
  const quote=value=>`'${String(value).replaceAll("'","'\\''")}'`;
  return `WB_TURN_CONTEXT=${quote(path)} ${quote(node)} ${boundCli?'"${WB_CLI:?Worker CLI path missing}"':quote(cli)}`;
}
