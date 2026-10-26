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

/** A live card uses the previous completed public turn, never the transcript being written by its CLI. */
export function groupSideAskPreviousSource(db,{projectId,conversationId=projectId,runId,online}){
 const run=db.get('runs',runId),belongs=value=>value?.projectId===projectId&&(value.conversationId||value.projectId)===conversationId;
 if(!belongs(run))throw Error('The original execution is unavailable');
 const runtime=run.nativeSession?.runtime||run.runtime||run.roleSnapshot?.runtime,sessionId=run.nativeSession?.id||run.resumeNativeSessionId;
 if(!['claude','codex'].includes(runtime))throw Error('Side questions work with Claude and Codex sessions');
 if(!sessionId||!run.nodeId||!run.workspace||!Number.isFinite(Date.parse(run.createdAt)))throw Error('The previous completed reply is unavailable');
 const row=db.db.prepare(`SELECT data FROM records WHERE kind='runs' AND id!=?
  AND json_extract(data,'$.projectId')=? AND COALESCE(json_extract(data,'$.conversationId'),json_extract(data,'$.projectId'))=?
  AND json_extract(data,'$.roleId')=? AND COALESCE(json_extract(data,'$.roleSessionId'),'')=?
  AND json_extract(data,'$.nodeId')=? AND json_extract(data,'$.workspace')=? AND json_extract(data,'$.nativeSession.id')=?
  AND COALESCE(json_extract(data,'$.nativeSession.runtime'),json_extract(data,'$.runtime'))=? AND json_extract(data,'$.status')='succeeded' AND julianday(json_extract(data,'$.finishedAt'))<=julianday(?)
  ORDER BY julianday(json_extract(data,'$.finishedAt')) DESC,rowid DESC LIMIT 1`).get(run.id,projectId,conversationId,run.roleId,run.roleSessionId||'',run.nodeId,run.workspace,sessionId,runtime,run.createdAt);
 const previous=row&&JSON.parse(row.data);
 const reply=previous&&db.db.prepare(`SELECT data FROM records WHERE kind='roomMessages' AND json_extract(data,'$.runId')=?
  AND json_extract(data,'$.sender')='agent' AND COALESCE(json_extract(data,'$.visibility'),'')!='internal'
  ORDER BY json_extract(data,'$.createdAt') DESC,rowid DESC LIMIT 1`).get(previous.id);
 if(!reply)throw Error('The previous completed reply is unavailable');
 const message=JSON.parse(reply.data),source=groupSideAskSource(db,{projectId,conversationId,messageId:message.id,online});
 if(db.get('workers',source.nodeId)?.capabilities?.groupSideAskPrevious!==1)throw Error('Upgrade this Worker to ask about the previous completed turn');
 const question=message.replyToId&&db.get('roomMessages',message.replyToId);
 const text=[belongs(question)&&question.visibility!=='internal'&&question.text?`Previous question:\n${question.text}`:'',`Previous completed reply:\n${message.text}`].filter(Boolean).join('\n\n');
 if(text.length>100000)throw Error('This card is too long for a side question');
 return {...source,anchorRunId:run.id,previousRunId:previous.id,snapshot:{id:previous.id,text}};
}
