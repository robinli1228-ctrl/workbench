// A CLI's question to the user (Claude's AskUserQuestion, Codex's request_user_input) and the user's answer, read back from
// the CLI's own history. History pages are parsed one record at a time, so each record is labelled on its own: the call
// becomes a `question_call` row with its questions, a result that carries answers a `question_answer` row, and the page pairs
// them by call id into the user's answer message (public/question-answer.js). The question tool is not listed as a step.

const QUESTION_TOOLS = new Set(['AskUserQuestion', 'request_user_input']);
export const isQuestionTool = name => QUESTION_TOOLS.has(String(name || ''));
const clean = (value, limit = 2000) => String(value ?? '').trim().slice(0, limit);
const parse = value => { if (value && typeof value === 'object') return value; try { return JSON.parse(String(value || '')); } catch { return null; } };

/** The questions asked, in order: [{id, question, secret?}]. */
export function questionsAsked(input) {
  const list = parse(input)?.questions;
  return Array.isArray(list) ? list.slice(0, 8).map((q, i) => ({ id: clean(q?.id || `q${i + 1}`, 80), question: clean(q?.question), ...(q?.isSecret === true ? { secret: true } : {}) })).filter(q => q.question) : [];
}

/** `"question"="answer"` pairs as Claude writes them in the tool result. */
function quotedPairs(text) {
  const pairs = {}, pattern = /"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"/g;
  for (let match; (match = pattern.exec(text));) pairs[match[1].replace(/\\(.)/g, '$1')] = match[2].replace(/\\(.)/g, '$1').slice(0, 4000);
  return pairs;
}
const CLAUDE_ANSWERED = /^\s*(Your questions have been answered|User has answered your questions|The user answered)/;

/**
 * The answers a question tool's result carries, or null when the result is not recognisably one: Claude's recorded
 * `toolUseResult.answers` ({question: "label, label"}) or the pairs of its "…have been answered" text ({byText}); Codex's
 * output JSON {answers: {id: {answers: […]}}} ({byId}).
 */
export function givenAnswers(output, recorded = null) {
  if (recorded && typeof recorded === 'object' && !Array.isArray(recorded)) return { byText: Object.fromEntries(Object.entries(recorded).slice(0, 8).map(([k, v]) => [clean(k), clean(v, 4000)])) };
  const json = parse(output);
  if (json && typeof json.answers === 'object' && json.answers && !Array.isArray(json.answers))
    return { byId: Object.fromEntries(Object.entries(json.answers).slice(0, 8).map(([id, v]) => [clean(id, 80), (Array.isArray(v?.answers) ? v.answers : []).map(a => clean(a, 4000)).filter(Boolean).slice(0, 8)])) };
  const text = String(output || '');
  return CLAUDE_ANSWERED.test(text) ? { byText: quotedPairs(text) } : null;
}
