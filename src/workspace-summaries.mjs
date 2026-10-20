import {PAGE_SUMMARY_PATHS} from './workspace-state.mjs';

const paths=fields=>fields.map(field=>`'$.${field}'`).join(',');
// Progress needs to know that a reply body exists, not the body itself.
const replied=fields=>`json(CASE WHEN ${fields.map(field=>`trim(coalesce(json_extract(data,'$.${field}'),''))!=''`).join(' OR ')} THEN 'true' ELSE 'false' END)`;

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
