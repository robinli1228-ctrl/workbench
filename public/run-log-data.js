import { t } from './i18n.js';
/** Business acceptance belongs to the Task; a past discussion keeps its own outcome and is not rewritten by the original task's acceptance. */
export function taskRunDisplayStatus(task,run) {
  if(run?.discussionDeliveryId)return run.status;
  return ['done','awaiting_acceptance'].includes(task.status)?task.status:run?.status||task.status;
}

/** Execution details put only real tool calls on the tools page; status updates of the same tool are merged. */
export function partitionRunLog(events = []) {
  const result = { input: null, output: [], tools: [] };
  const toolIndex = new Map();
  for (const event of [...events].sort((a, b) => (a.seq || 0) - (b.seq || 0))) {
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
    if (previous) {
      previous.item = { ...previous.item, ...item };
      previous.updatedAt = event.createdAt || previous.updatedAt;
    } else {
      const tool = { seq: event.seq, createdAt: event.createdAt, updatedAt: event.createdAt, item };
      toolIndex.set(key, tool);
      result.tools.push(tool);
    }
  }
  const streamedText = result.output.filter(event => event.type === 'text').map(event => event.payload?.text || '').join('');
  result.output = result.output.filter(event => event.type !== 'message' || event.payload?.phase !== 'final_answer'
    || !event.payload?.text || !streamedText.includes(event.payload.text));
  return result;
}

/** When an old Run has no input snapshot, show only the original task request; do not pass it off as the full CLI input. */
export function displayRunInput(task, input) {
  if (input && typeof input.prompt === 'string') return { instructions: input.instructions || '', prompt: input.prompt, complete: true, instructionsInheritedFrom:input.instructionsInheritedFrom||null };
  return { instructions: '', prompt: task?.prompt || '', complete: false };
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
