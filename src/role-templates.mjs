import { randomUUID } from 'node:crypto';
import { tr } from './i18n.mjs';
import { defaultRoleTemplates, isBroadcastName, isSupervisorName } from './default-roles.mjs';
import { normalizeResponsibility } from './role-definition.mjs';

const KIND = 'roleTemplateRecords';
const now = () => new Date().toISOString();

/** Built-in text follows the current language until a user edits it; edited or added templates keep the saved text verbatim.
 * Templates can no longer be deleted; a 'deleted' record left by an older version just shows the shipped text with its revision. */
function merged(db) {
  const records = new Map(db.list(KIND).map(record => [record.id, record]));
  const builtins = defaultRoleTemplates().map(template => {
    const record = records.get(template.key);
    return record && !record.restored && !record.deleted
      ? { ...template, name: record.name, responsibility: record.responsibility, instructions: record.instructions, builtin: true, customized: true, revision: record.revision, updatedAt: record.updatedAt }
      : { ...template, builtin: true, customized: false, revision: record?.revision || 0 };
  });
  const custom = [...records.values()].filter(record => record.custom)
    .map(record => ({ key: record.id, name: record.name, responsibility: record.responsibility, instructions: record.instructions,
      mode: 'workspace-write', builtin: false, customized: true, revision: record.revision, updatedAt: record.updatedAt }));
  return [...builtins, ...custom];
}

/** Templates offered when creating a role. */
export function listRoleTemplates(db) {
  return merged(db);
}

function validate(db, input, key) {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  if (!/^[\p{L}\p{N}_-]{1,32}$/u.test(name)) throw new Error(tr('rooms.roleNamesMustBe1'));
  if (isBroadcastName(name)) throw new Error(tr('rooms.broadcastNameReserved'));
  if (isSupervisorName(name)) throw new Error(tr('rooms.supervisorFixedSystemRoleUse'));
  if (listRoleTemplates(db).some(template => template.key !== key && template.name === name)) throw new Error(tr('roleTemplates.nameInUse'));
  if (typeof input.instructions !== 'string' || input.instructions.length > 12000) throw new Error(tr('rooms.roleInstructionsLimited12000Characters'));
  return { name, responsibility: normalizeResponsibility(typeof input.responsibility === 'string' ? input.responsibility : ''), instructions: input.instructions.trim() };
}

function current(db, key) {
  const template = merged(db).find(item => item.key === key);
  if (!template) throw new Error(tr('roleTemplates.notFound'));
  return template;
}

/** Every change to an existing template must name the revision the editor last saw; a missing or stale revision is rejected. */
function checkRevision(template, revision) {
  if (!Number.isSafeInteger(revision) || revision !== template.revision) throw new Error(tr('roleTemplates.changedReopen'));
}

/** Create when no key is given; otherwise update a built-in or custom template with an optimistic revision check. */
export function saveRoleTemplate(db, input = {}) {
  return db.transaction(() => {
    if (input.key === undefined || input.key === null || input.key === '') {
      const value = validate(db, input, null), id = `custom-${randomUUID()}`;
      db.put(KIND, { id, custom: true, ...value, revision: 1, createdAt: now(), updatedAt: now() });
      return current(db, id);
    }
    if (typeof input.key !== 'string') throw new Error(tr('roleTemplates.notFound'));
    const template = current(db, input.key);
    checkRevision(template, input.revision);
    const value = validate(db, input, template.key), old = db.get(KIND, template.key);
    // A 'deleted' mark left by an older version must not swallow the edit: templates cannot be deleted any more.
    db.put(KIND, { ...old, id: template.key, custom: !template.builtin, restored: false, deleted: false, ...value,
      revision: template.revision + 1, createdAt: old?.createdAt || now(), updatedAt: now() });
    return current(db, template.key);
  });
}

/** Restores the shipped text of an edited built-in template. The record is kept with a higher revision so a page opened before the restore cannot save over it. */
export function restoreRoleTemplate(db, key, revision) {
  return db.transaction(() => {
    const builtin = defaultRoleTemplates().find(template => template.key === key);
    if (!builtin) throw new Error(tr('roleTemplates.notFound'));
    const template = merged(db).find(item => item.key === key);
    checkRevision(template, revision);
    validate(db, builtin, key);
    db.put(KIND, { id: key, restored: true, revision: template.revision + 1, updatedAt: now() });
    return current(db, key);
  });
}
