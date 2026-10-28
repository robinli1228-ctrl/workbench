import { t } from './i18n.js';

/** The project's manual switch for several roles editing at once. Turning it on asks first; null means the person declined. */
export async function saveConcurrentWrites({ api, getData, projectId, enabled }) {
  if (enabled && !confirm(t('Allow several roles to edit this project at the same time? Two roles can overwrite each other on the same file, and Git actions can collide. Migration, deployment and production operations will no longer wait for other roles.'))) return null;
  const saved=await api(`/api/projects/${encodeURIComponent(projectId)}/concurrent-writes`, { method: 'POST', json: { enabled } });
  // Keep the confirmed server value even when the following state refresh fails.
  const project=getData().projects.find(p=>p.id===projectId);
  if(project)project.allowConcurrentWrites=saved.allowConcurrentWrites;
  return saved.allowConcurrentWrites;
}
