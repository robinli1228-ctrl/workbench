import { t } from './i18n.js';
import {executionProgress} from './execution-progress.js';
/** Acceptance stays in the report/actions. A historical or discussion Run is not relabeled by the current task's waits. */
export function taskRunDisplayStatus(task,run,request) {
  return executionProgress({run,task,request}).state;
}

/** Execution details put only real tool calls on the tools page; status updates of the same tool are merged. */
export function partitionRunLog(events = []) {
  const result = { input: null, output: [], tools: [] };
  const toolIndex = new Map();
  for (const event of mergeRunEvents([],events)) {
    if (event.type === 'input') {
      result.input = event.payload || null;
      continue;
    }
    if (['text', 'message', 'log', 'error'].includes(event.type)) {
      result.output.push(event);
      continue;
    }
    if (event.type !== 'tool') continue;
    const item = event.payload?.item;
    if (!item || ['reasoning', 'userMessage', 'contextCompaction'].includes(item.type)) continue;
    const key = item.id || `seq:${event.seq}`;
    const previous = toolIndex.get(key);
    const merged={...(previous?.item||{}),...item};
    if(item.aggregatedOutput!==undefined||item.output!==undefined)merged.aggregatedOutput=item.aggregatedOutput??item.output;
    else if(typeof item.outputDelta==='string')merged.aggregatedOutput=String(previous?.item?.aggregatedOutput||'')+item.outputDelta;
    delete merged.outputDelta;
    if (previous) {
      previous.item = merged;
      previous.updatedAt = event.createdAt || previous.updatedAt;
    } else {
      const tool = { seq: event.seq, createdAt: event.createdAt, updatedAt: event.createdAt, item:merged };
      toolIndex.set(key, tool);
      result.tools.push(tool);
    }
  }
  const streamedText = result.output.filter(event => event.type === 'text').map(event => event.payload?.text || '').join('');
  result.output = result.output.filter(event => event.type !== 'message' || event.payload?.phase !== 'final_answer'
    || !event.payload?.text || !streamedText.includes(event.payload.text));
  return result;
}

/** Token 只换显示单位；缺失值保持未知，小于两位小数的非零用量不显示成零。 */
export function formatTokenMillions(value) {
  if (value == null || value === '' || !Number.isFinite(Number(value)) || Number(value) < 0) return null;
  const count=Number(value);
  return count>0&&count<10000?'<0.01 M':`${(count/1000000).toFixed(2)} M`;
}

/** 保留首个工具事件的位置并合并后续状态；输入只出现在独立输入页。 */
export function runTimeline(events = []) {
  const logs=partitionRunLog(events),rows=[];
  const entries=[...logs.output.map(event=>({seq:event.seq,event})),...logs.tools.map(tool=>({seq:tool.seq,tool}))].sort((a,b)=>(a.seq||0)-(b.seq||0));
  for(const entry of entries){
    const last=rows.at(-1);
    if(entry.tool){
      if(last?.kind==='tools')last.tools.push(entry.tool);
      else rows.push({kind:'tools',seq:entry.seq,tools:[entry.tool]});
      continue;
    }
    const event=entry.event,payload=event.payload||{},text=stripAnsi(typeof payload==='string'?payload:payload.text||payload.message||JSON.stringify(payload));
    if(!text)continue;
    const kind=event.type==='error'?'error':event.type==='log'?'log':'text';
    if(last?.kind==='text'&&kind==='text'&&event.type==='text'&&last.streaming)last.text+=text;
    else if(!(kind==='text'&&last?.kind==='text'&&last.text===text))rows.push({kind,seq:entry.seq,text,streaming:event.type==='text',createdAt:event.createdAt});
  }
  return rows;
}

/** When an old Run has no input snapshot, show only the original task request; do not pass it off as the full CLI input. */
export function displayRunInput(task, input) {
  if (input && typeof input.prompt === 'string') return { instructions: input.instructions || '', prompt: input.prompt, complete: true, instructionsInheritedFrom:input.instructionsInheritedFrom||null,configurationUpdate:input.configurationUpdate||'',
    groups:runInputGroups(input),fixed:input.fixed&&typeof input.fixed==='object'?input.fixed:null };
  return { instructions: '', prompt: task?.prompt || '', complete: false, groups:null, fixed:null };
}

/** Split a recorded input by the ranges the Worker wrote when it built it; records without valid ranges are not guessed at. */
export function runInputGroups(input) {
  const prompt=typeof input?.prompt==='string'?input.prompt:'',sections=Array.isArray(input?.sections)?input.sections:null;
  if(!sections?.length)return null;
  let last=0;
  for(const s of sections)if(!Number.isInteger(s?.start)||!Number.isInteger(s.end)||s.start<last||s.end<s.start||s.end>prompt.length)return null;else last=s.end;
  const groups={message:[],home:[],worker:[]};
  for(const s of sections)if(groups[s.group])groups[s.group].push({key:String(s.key||''),text:prompt.slice(s.start,s.end)});
  return groups;
}

/** Use the context frozen at dispatch time; do not rewrite history logs with later-updated summaries. */
export function contextUsageLabel(context) {
  if(!context || context.uncoveredCount===undefined)return '';
  const state={running:'Organizing',queued:'Queued for background organizing',idle:'Idle',failed:'Update failed'}[context.organizer?.status]||'Not enabled';
  const summary=context.version?t('Summary {v} · covers through {v2}', { v: context.version.slice(0,8), v2: context.coveredThroughMessageId||t('no complete message yet') }):'No summary available';
  return t('At dispatch: {state} · {summary} · {uncoveredCount} supplemental messages this round{v}{v2}{v3}{v4}', { state, summary, uncoveredCount: context.sentUncoveredCount??context.uncoveredCount, v: context.inheritedMessageCount?t(' · {inheritedMessageCount} inherited', { inheritedMessageCount: context.inheritedMessageCount }):'', v2: context.excerptCount?t(' ({excerptCount} excerpted, with a link to the full text)', { excerptCount: context.excerptCount }):'', v3: context.omittedCount?t(' · {omittedCount} more viewable by page', { omittedCount: context.omittedCount }):'', v4: context.partialThrough?t(' · long-message organizing incomplete'):'' });
}

/** SSE and concurrent delta requests may overlap; merge by stable event ID, then display by Run sequence. */
export function mergeRunEvents(existing = [], incoming = []) {
  const merged = new Map();
  for (const event of [...existing, ...incoming]) merged.set(event.id || `seq:${event.seq}`, event);
  return [...merged.values()].sort((a, b) => (a.seq || 0) - (b.seq || 0));
}

/** Show the final result only when it is missing from the stream, to avoid duplicating the CLI's streamed body and completion event. */
export function shouldShowFinalResult(result, events = []) {
  if (!result) return false;
  const streamed = events.filter(event => event.type === 'text').map(event => event.payload?.text || '').join('');
  return !streamed.includes(result) && !events.some(event => event.type === 'message' && event.payload?.text === result);
}

/** Some CLIs only return the tool start event; after the Run ends, do not keep marking it as "in progress". */
export function toolStatusLabel(item, runStatus) {
  if (item.status === 'completed') return 'Completed';
  if (item.status === 'failed') return 'Failed';
  if (item.status === 'inProgress' && ['succeeded', 'failed', 'interrupted'].includes(runStatus)) return 'Result not recorded';
  return item.status || item.type || 'Call';
}

/** CLI color terminal control codes should not render as boxes or garbled text in the page. */
export function stripAnsi(value) {
  return String(value ?? '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}
