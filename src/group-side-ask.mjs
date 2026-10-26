/** Resolve a public card to its original execution; role settings can move after that execution. */
export function groupSideAskSource(db,{projectId,conversationId=projectId,messageId,online}){
 const message=db.get('roomMessages',messageId),belongs=value=>value?.projectId===projectId&&(value.conversationId||value.projectId)===conversationId;
 if(!belongs(message)||message.visibility==='internal'||message.sender!=='agent')throw Error('This message is not available for side questions');
 if(typeof message.text!=='string'||!message.text.trim())throw Error('This card has no text to discuss');
 if(message.text.length>100000)throw Error('This card is too long for a side question');
 const run=message.runId&&db.get('runs',message.runId);
 if(!belongs(run))throw Error('The original execution is unavailable');
 const runtime=run.nativeSession?.runtime||run.runtime,sessionId=run.nativeSession?.id;
 if(!['claude','codex'].includes(runtime))throw Error('Side questions work with Claude and Codex sessions');
 if(!sessionId||!run.nodeId||!run.workspace)throw Error('The original session or working folder is unavailable');
 const worker=db.get('workers',run.nodeId);
 if(!worker||!online(run.nodeId))throw Error('Device is offline');
 if(worker.capabilities?.nativeSideAsk!==1||worker.capabilities?.groupSideAsk!==1)throw Error('Upgrade this Worker to ask side questions');
 return {id:sessionId,sessionId,nodeId:run.nodeId,runtime,workspace:run.workspace,model:run.model||run.roleSnapshot?.model||null,
  projectId,conversationId,messageId,runId:run.id,senderName:message.senderName||run.roleSnapshot?.name||runtime,quote:message.text||''};
}
