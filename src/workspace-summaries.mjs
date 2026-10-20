import {PAGE_SUMMARY_PATHS} from './workspace-state.mjs';

const paths=fields=>fields.map(field=>`'$.${field}'`).join(',');
// Match JavaScript String.trim exactly: SQLite's default trim only removes ASCII spaces.
// Non-text legacy values are not replies, just as in the existing full-record projection.
const whitespace='char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)';
const replied=fields=>`json(CASE WHEN ${fields.map(field=>`(json_type(data,'$.${field}')='text' AND trim(json_extract(data,'$.${field}'),${whitespace})!='')`).join(' OR ')} THEN 'true' ELSE 'false' END)`;

/** One project's page summaries, read straight from SQLite: omitted bodies never become JS strings, and the
 * (kind, projectId) index returns rowid order without a sort. Full records stay where they are for the detail reads. */
export function pageSummaries(db,projectId) {
  const rows=(kind,select)=>db.db.prepare(summaryQuery(select)).all(kind,projectId).map(r=>JSON.parse(r.data));
  const runs=rows('runs',`json_set(json_remove(data,${paths(PAGE_SUMMARY_PATHS.runs)}),'$.hasReply',${replied(['result','report.summary'])})`);
  const tasks=rows('tasks',`json_remove(data,${paths(PAGE_SUMMARY_PATHS.tasks)})`);
  const requests=rows('coordinationRequests',`json_set(json_remove(data,${paths(PAGE_SUMMARY_PATHS.requests)}),'$.hasReply',${replied(['result','reportSummary'])})`);
  const runReports=rows('runReports',`json_remove(data,${paths(PAGE_SUMMARY_PATHS.runReports)})`);
  // Launch timestamps feed message progress; the launch input body does not.
  const launches=db.db.prepare(`SELECT json_remove(data,'$.launchInput') AS data FROM records WHERE kind='commands' AND json_extract(data,'$.type')='launch'
    AND json_extract(data,'$.runId') IN (SELECT id FROM records WHERE kind='runs' AND json_extract(data,'$.projectId')=?) ORDER BY rowid`).all(projectId).map(r=>JSON.parse(r.data));
  // Sidebar execution marks for the other projects come from the active-run index, never from their histories.
  const otherActiveRuns=db.activeRuns().filter(r=>r.projectId!==projectId);
  return {runs,tasks,requests,runReports,launches,otherActiveRuns};
}

export const summaryQuery=select=>`SELECT ${select} AS data FROM records WHERE kind=? AND json_extract(data,'$.projectId')=? ORDER BY rowid`;
