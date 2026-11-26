import { tr } from './i18n.mjs';
import { terminal } from './store.mjs';

const clip = (text, limit) => { const value = String(text ?? '').replace(/\s+/g, ' ').trim(); return value.length > limit ? `${value.slice(0, limit)}…` : value; };
/** The newest part of a text still being written. */
const newest = (text, limit, cut = false) => { const value = String(text ?? '').replace(/\s+/g, ' ').trim(); return value.length > limit ? `…${value.slice(-limit)}` : cut && value ? `…${value}` : value; };
// The one argument that says what a tool call is about, whichever CLI reported it.
const DETAIL_KEYS = ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description', 'prompt'];
function stepLine(payload = {}) {
  const item = payload.item || {}, input = item.input || item.arguments || {};
  const name = item.name || item.tool || (item.type && !['tool_use', 'tool_call'].includes(item.type) ? item.type : '') || payload.text || '';
  const detail = item.command || (typeof input === 'object' && input ? DETAIL_KEYS.map(key => input[key]).find(value => typeof value === 'string' && value) : '')
    || (Array.isArray(item.changes) ? item.changes.map(change => change.path).filter(Boolean).join(', ') : '');
  return clip([name, detail && detail !== name ? detail : ''].filter(Boolean).join(': '), 160);
}

/**
 * What a turn is doing right now, from its newest events: when it started, its last few tool steps (one line each) and the
 * reply text written since the last step. Roles read this to follow a long turn of a teammate (wb discuss peers detail,
 * wb history read on a running run); it never includes tool output.
 */
export function runProgress(db, run, { steps = 5, replyChars = 600, time = Date.now() } = {}) {
  // Steps come from the newest tool events alone, so a long stretch of streamed text never pushes them out of the window.
  const events = db.recentEvents(run.id, 200), seen = new Map();
  for (const event of db.recentEvents(run.id, 60, 'tool')) {
    const item = event.payload?.item;
    if (!item || ['reasoning', 'userMessage', 'contextCompaction', 'tool_result'].includes(item.type)) continue;
    const line = stepLine(event.payload);
    if (line) seen.set(item.id || `seq:${event.seq}`, line);
  }
  // Text after the last tool step: a finished message of that stretch if there is one, else the streamed pieces.
  let lastTool = -1; events.forEach((event, i) => { if (event.type === 'tool') lastTool = i; });
  const tail = events.slice(lastTool + 1), message = tail.filter(e => e.type === 'message' && e.payload?.text).at(-1);
  // A window holding only streamed text starts mid-reply: the newest part is what matters, marked as cut at the front.
  const streamed = tail.filter(e => e.type === 'text').map(e => e.payload?.text || '').join(''), cut = !message && lastTool < 0 && events.length >= 200;
  const reply = message ? message.payload.text : streamed;
  const startedAt = run.startedAt || run.createdAt || null, lastActivityAt = events.at(-1)?.createdAt || run.updatedAt || null;
  return { startedAt, runningMinutes: startedAt ? Math.max(0, Math.round((time - Date.parse(startedAt)) / 60000)) : null, lastActivityAt,
    recentSteps: [...seen.values()].slice(-steps), replySoFar: newest(reply, replyChars, cut) };
}

/** The same progress as text, for a read of a run that has not ended yet. */
export function runProgressText(db, run, options) {
  if (terminal.has(run.status)) return '';
  const progress = runProgress(db, run, { steps: 12, replyChars: 4000, ...options });
  return [tr('runProgress.header', { minutes: progress.runningMinutes ?? '?', status: run.status, last: progress.lastActivityAt || '-' }),
    progress.recentSteps.length ? `${tr('runProgress.steps')}\n${progress.recentSteps.map(line => `- ${line}`).join('\n')}` : '',
    progress.replySoFar ? `${tr('runProgress.reply')}\n${progress.replySoFar}` : ''].filter(Boolean).join('\n\n');
}
