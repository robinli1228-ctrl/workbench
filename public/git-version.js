import { t } from './i18n.js';
/** The right side shows only a project-level summary; repository and device details appear in a dialog on click. */
export function formatProjectGitSummary(summary) {
  if (!summary?.repositoryCount) return 'No code repository configured';
  const parts = [t(summary.repositoryCount===1?'{count} repository':'{count} repositories', { count: summary.repositoryCount })];
  if(summary.deviceCount)parts.push(t(summary.deviceCount===1?'{count} device':'{count} devices', { count: summary.deviceCount }));
  if (summary.ahead) parts.push(t('{ahead} ahead', { ahead: summary.ahead }));
  if (summary.behind) parts.push(t('{behind} behind', { behind: summary.behind }));
  if (summary.unknown) parts.push(t('{unknown} to check', { unknown: summary.unknown }));
  if (!summary.ahead && !summary.behind && !summary.unknown) parts.push('All synced');
  return parts.join(' · ');
}

export function formatGitVersionStatus(item) {
  const parts=[];
  if(item?.ahead)parts.push(t('{ahead} ahead', { ahead: item.ahead }));
  if(item?.behind)parts.push(t('{behind} behind', { behind: item.behind }));
  if(parts.length)return parts.join(' · ');
  return item?.status==='synced' ? 'Synced' : item?.status==='offline' ? 'Device offline'
    : item?.status==='unpublished' ? 'Not published' : 'Needs check';
}
