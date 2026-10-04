/** The right side shows only a project-level summary; repository and device details appear in a dialog on click. */
export function formatProjectGitSummary(summary) {
  if (!summary?.repositoryCount) return 'No code repository configured';
  const parts = [`${summary.repositoryCount} ${summary.repositoryCount===1?'repository':'repositories'}`];
  if(summary.deviceCount)parts.push(`${summary.deviceCount} ${summary.deviceCount===1?'device':'devices'}`);
  if (summary.ahead) parts.push(`${summary.ahead} ahead`);
  if (summary.behind) parts.push(`${summary.behind} behind`);
  if (summary.unknown) parts.push(`${summary.unknown} to check`);
  if (!summary.ahead && !summary.behind && !summary.unknown) parts.push('All synced');
  return parts.join(' · ');
}

export function formatGitVersionStatus(item) {
  const parts=[];
  if(item?.ahead)parts.push(`${item.ahead} ahead`);
  if(item?.behind)parts.push(`${item.behind} behind`);
  if(parts.length)return parts.join(' · ');
  return item?.status==='synced' ? 'Synced' : item?.status==='offline' ? 'Device offline'
    : item?.status==='unpublished' ? 'Not published' : 'Needs check';
}
