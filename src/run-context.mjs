import { sameNativeSession } from './run-input.mjs';
import { createHash } from 'node:crypto';
import { executionText as tr } from './input-language.mjs';

/** An excerpt keeps the source fingerprint and the full-text entry point; the excerpt length is not the grapheme pagination cursor of the history tool. */
function excerpt(message,limit) {
  const text=String(message.text||'');
  let end=Math.min(limit,text.length);
  if(end<text.length && /[\uD800-\uDBFF]/.test(text[end-1]))end--;
  return {id:message.id,author:message.senderName||message.sender||tr('runContext.unknown'),text:text.slice(0,end),totalLength:text.length,
    truncated:end<text.length,contentHash:createHash('sha256').update(text).digest('hex'),
    readCommand:`wb history read ${message.id}`,attachments:(message.attachments||[]).map(a=>({id:a.id,name:a.name}))};
}

/** Pin this turn's instruction and the organizer version; only material with a clear source enters the prompt. */
export function buildRunContext({run,task,role={},environment={},conversation=null,messages=[],deliveries=[],references=[],completion=null,previousRun=null,organizer=null,receipts=null,conversationTask=null}) {
  const instruction=String(task?.prompt||'');
  if(run.backgroundFollowup){
    const visible=messages.filter(m=>m.visibility!=='internal'&&['human','agent'].includes(m.sender));
    const selected=visible.slice(-12),human=visible.findLast(m=>m.sender==='human');
    if(human&&!selected.some(m=>m.id===human.id))selected.unshift(human);
    let remaining=8000;references=selected.map(m=>{const entry=excerpt(m,Math.min(600,remaining));remaining-=entry.text.length;return {...m,text:entry.text,followupExcerpt:entry};});
  }
  if(conversation?.coveredThroughMessageId && !messages.some(m=>m.id===conversation.coveredThroughMessageId))conversation=null;
  const covered=conversation?.coveredThroughMessageId;
  const index=covered?messages.findIndex(message=>message.id===covered):-1;
  const pending=messages.slice(index+1).filter(message=>message.id!==run.sourceMessageId);
  let budget=12000;
  const limits=new Map();
  // The most recent human requests take priority; a large backlog is browsed through the existing paginated directory tool so the command cannot exceed the WebSocket payload limit.
  for(const message of [...pending.filter(m=>m.sender==='human').reverse(),...pending.filter(m=>m.sender!=='human').reverse()].slice(0,100)) {
    const length=Math.min(String(message.text||'').length,1000,budget);limits.set(message.id,length);budget-=length;
  }
  const uncovered=pending.filter(message=>limits.has(message.id)).map(message=>excerpt(message,limits.get(message.id)||0));
  const packet={
    roleSessionId:run.roleSessionId||null,runId:run.id,discussionResolution:task?.discussionResolution||null,
    source:{kind:run.backgroundFollowup?'platform':task?.coordinationKind&&task.coordinationKind!=='direct'?'role_call':'human',messageId:run.sourceMessageId||null,requestId:run.requestId||null},
    followup:run.backgroundFollowup?{...run.proactiveFollowup,state:run.followupState||[]}:null,
    ...(conversationTask?{conversationTask}:{}),
    instruction,schedulingRoster:(task?.schedulingRoster||[]).map(r=>({id:r.id,name:r.name})),steering:task?.steering||null,rules:{roleRevision:role.revision||null},environment,
    context:{status:conversation?.version?(uncovered.length||conversation.partialThrough?'supplemented':'ready'):'unavailable',version:conversation?.version||null,
      organizer:organizer?{status:organizer.status,error:organizer.error||null,retryAt:organizer.retryAt||null}:null,
      snapshotThroughMessageId:messages.at(-1)?.id||null,partialThrough:conversation?.partialThrough||null,
      updatedAt:conversation?.updatedAt||null,uncoveredCount:pending.length,excerptCount:uncovered.filter(m=>m.truncated).length,
      omittedCount:pending.length-uncovered.length,uncoveredRange:{firstMessageId:pending[0]?.id||null,lastMessageId:pending.at(-1)?.id||null},
      coveredThroughMessageId:covered||null,goal:conversation?.goal||null,constraints:conversation?.constraints||[],
      openItems:conversation?.openItems||[],recentSummary:conversation?.recentSummary||'',
      sourceMessageIds:conversation?.sourceMessageIds||[],uncovered},
    deliveries:deliveries.filter(item=>item.id===task?.deliveryId).map(item=>({id:item.id,summary:item.summary||'',commit:item.commit||null})),
    references:references.map(item=>item.followupExcerpt||excerpt(item,8000)),
    completion:completion||null,
    ...(receipts?.items?.length?{receipts:{items:receipts.items,omitted:receipts.omitted||0}}:{})
  };
  // Save the full snapshot for auditing; identical content already delivered to the native history is omitted only at render time.
  const prior=sameNativeSession(run,previousRun)?previousRun.contextPacket?.context:null;
  if(prior)packet.inheritedContext={runId:previousRun.id,
    fields:['recentSummary','goal','constraints','openItems'].filter(key=>JSON.stringify(prior[key])===JSON.stringify(packet.context[key])),
    messageIds:uncovered.filter(item=>prior.uncovered?.some(old=>JSON.stringify(old)===JSON.stringify(item))).map(item=>item.id)};
  packet.context.inheritedMessageCount=packet.inheritedContext?.messageIds.length||0;
  packet.context.sentUncoveredCount=uncovered.length-packet.context.inheritedMessageCount;
  return packet;
}

/** Receipts are references for the owner to verify, never results already accepted. */
function renderReceipts(receipts) {
  if(!receipts?.items?.length)return '';
  // Results are judged from the reply itself; a verdict, stage or version shows only when an older report recorded one.
  const lines=receipts.items.map(r=>`- ${r.requestId} ${JSON.stringify(r.role)} · ${r.runStatus?`run ${r.runStatus}`:tr('runContext.receiptNoRun')}${r.verdict&&r.verdict!=='unverified'?` · ${r.verdict}`:''}${r.stage?` · ${r.stage}`:''}${r.version?` · ${r.version}`:''}${r.files?` · ${tr('runContext.receiptFiles',{count:r.files})}`:''} · ${r.summary||''}`);
  return tr('runContext.resultReceipts',{p1:lines.join('\n'),p2:receipts.omitted?tr('runContext.resultReceiptsOmitted',{count:receipts.omitted}):''});
}

/** The source text is not rewritten by the summarizer; the background carries a coverage range and a fallback marker so it is not mistaken for a new instruction. */
export function renderRunPrompt(packet,{minimal=false}={}) {
  const taskContext=packet.conversationTask?tr('conversationTasks.context',{updated:packet.conversationTask.updated?tr('conversationTasks.updated'):'',task:JSON.stringify(packet.conversationTask)}):'';
  if(minimal)return [packet.instruction,taskContext,
    packet.followup?tr('followup.context',{context:JSON.stringify(packet.followup)}):'',
    packet.steering?tr('runContext.userChangedDirectionTurnImmediate'):'',
    packet.discussionResolution?tr('runContext.questionOnOriginalTaskHas',{p1:JSON.stringify(packet.discussionResolution)}):'',
    packet.schedulingRoster?.length?tr('runContext.rolesTurnMustCoverFixed',{p1:packet.schedulingRoster.map(r=>`${JSON.stringify(r.name)} [${r.id}]`).join(', ')}):'',
    ...(packet.references||[]).map(item=>`${JSON.stringify(item.author)} [${item.id}]:\n${item.text}${item.truncated?`\n${item.readCommand}`:''}`),
    ...(packet.deliveries||[]).map(item=>`${item.id} ${item.commit||''} ${item.summary||''}`),
    packet.completion?tr('runContext.explicitCompletionRequirement',{completion:packet.completion}):'',renderReceipts(packet.receipts)].filter(Boolean).join('\n\n');
  const lines=[tr('runContext.originalInstructionForTurnVerbatim', { instruction: packet.instruction })];
  if(taskContext)lines.push(taskContext);
  if(packet.followup)lines.push(tr('followup.context',{context:JSON.stringify(packet.followup)}));
  if(packet.discussionResolution)lines.push(tr('runContext.questionOnOriginalTaskHas', { p1: JSON.stringify(packet.discussionResolution) }));
  if(packet.schedulingRoster?.length)lines.push(tr('runContext.rolesTurnMustCoverFixed', { p1: packet.schedulingRoster.map(r=>`${JSON.stringify(r.name)} [${r.id}]`).join(tr('runContext.text')) }));
  if(packet.steering)lines.unshift(tr('runContext.userChangedDirectionTurnImmediate'));
  const context={...packet.context};
  const showMessage=item=>tr('runContext.text3', { id: item.id, author: JSON.stringify(item.author), text: item.text, p4: item.truncated?tr('runContext.excerptCharactersFullTextPass', { length: item.text.length, totalLength: item.totalLength, readCommand: item.readCommand }):'', p5: item.attachments?.length?tr('runContext.attachmentsBodyDoesNotInclude', { p1: item.attachments.map(a=>a.name).join(tr('runContext.text2')) }):'' });
  if(packet.inheritedContext) {
    const {fields,messageIds,runId}=packet.inheritedContext;
    for(const key of fields)context[key]=Array.isArray(context[key])?[]:null;
    context.uncovered=context.uncovered.filter(item=>!messageIds.includes(item.id));
    lines.push(tr('runContext.originalSessionHasBeenResumed', { runId, p2: packet.context.version||tr('runContext.excerpt') }));
    for(const [key,label] of [['recentSummary',tr('runContext.backgroundSummary')],['goal',tr('runContext.goal')],['constraints',tr('runContext.persistentConstraints')],['openItems',tr('runContext.openItems')]]) {
      if(!fields.includes(key) && (!context[key] || (Array.isArray(context[key]) && !context[key].length)))lines.push(tr('runContext.groupChatBackgroundUpdateHas', { label }));
    }
  }
  if(context.recentSummary)lines.push(tr('runContext.groupChatBackgroundSummaryCovering', { status: context.status, p2: context.coveredThroughMessageId||tr('runContext.unknown2'), recentSummary: context.recentSummary }));
  if(context.goal?.text)lines.push(tr('runContext.goalFromGroupChatBackground', { text: context.goal.text }));
  if(context.constraints.length)lines.push(tr('runContext.persistentConstraints2', { p1: context.constraints.map(item=>`- ${item.text} [${item.sourceMessageIds?.join(',')||tr('runContext.sourceUnknown')}]`).join('\n') }));
  if(context.openItems.length)lines.push(tr('runContext.openItems2', { p1: context.openItems.map(item=>`- ${item.text} [${item.sourceMessageIds?.join(',')||tr('runContext.sourceUnknown2')}]`).join('\n') }));
  if(context.partialThrough)lines.push(tr('runContext.summaryCoversMessageOnlyUp', { messageId: context.partialThrough.messageId, offset: context.partialThrough.offset, totalLength: context.partialThrough.totalLength }));
  if(context.omittedCount)lines.push(tr('runContext.furtherUncoveredMessagesNotExpanded', { omittedCount: context.omittedCount, firstMessageId: context.uncoveredRange.firstMessageId, lastMessageId: context.uncoveredRange.lastMessageId }));
  if(context.uncovered.length)lines.push(tr('runContext.messagesNotYetCoveredBy', { p1: context.uncovered.map(showMessage).join('\n') }));
  if(packet.deliveries.length)lines.push(tr('runContext.deliveriesRelatedTurn', { p1: packet.deliveries.map(item=>`${item.id} ${item.commit||''} ${item.summary}`).join('\n') }));
  if(packet.references.length)lines.push(tr('runContext.sourceTextQuotedByUser', { p1: packet.references.map(showMessage).join('\n') }));
  if(packet.completion)lines.push(tr('runContext.explicitCompletionRequirement', { completion: packet.completion }));
  if(packet.receipts)lines.push(renderReceipts(packet.receipts));
  lines.push(tr('runContext.currentPlatformSessionTurnS', { p1: packet.roleSessionId||tr('runContext.notCreated'), runId: packet.runId }));
  return lines.join('\n\n');
}
