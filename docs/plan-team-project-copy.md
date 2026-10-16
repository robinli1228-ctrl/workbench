# Team-Only Project Copy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for native execution, or superpowers:subagent-driven-development if the user selects delegated execution. Implement task-by-task; steps use checkbox syntax.

**Goal:** Copy the existing team and its exact prompts into one new project with empty business workspaces, without copying code, history or execution.

**Architecture:** Snapshot allow-listed role/supervisor configuration into a durable creation operation, prepare new directories through existing Workers, then publish the executable team atomically after all required receipts are verified. No model runs, repository clones or independent provisioning service are created.

**Tech Stack:** Existing Node.js 22.22.1 ESM, SQLite Store, Home/Worker query channel and vanilla browser modules; no new dependencies.

**Spec:** [design-parallel-conversations](design-parallel-conversations.md), especially sections 7–8 and acceptance 9–11. This is a separate deliverable from [parallel chats](plan-parallel-conversations.md), but follows that plan in the chosen release order.

**Execution baseline:** `84c522f6907cbbaf42cfd3c237828db83e03dcdb`. Status: Tasks 1–4 implemented through user-selected native execution, including real isolated Mac/server preparation. The checklists below retain the implementation procedure; the [acceptance record](design-parallel-conversations.md#12-implemented-acceptance-and-limits) states verified behavior and limits. Not pushed or deployed.

## Global Constraints

- Copy non-archived working roles and supervisor configuration with new IDs/revisions; preserve custom prompts and explicitly empty instructions exactly.
- Device/runtime/model/effort/enabled choices are retained. Existing device account registrations are references, not copied credentials.
- No old repositories, code, documents, dependencies, native sessions, messages, summaries, reports, approvals, timers, source-sync state or processes are copied.
- Global platform instructions remain global. User-authored prompt text is not silently rewritten even when it mentions old paths.
- New business directories may contain only necessary platform bootstrap files. Never adopt or overwrite a pre-existing target, silently change device, or recursively delete partial work.
- Prepare supervisor and enabled-role devices; disabled roles require no eager device provisioning. Nothing is executable until required preparation is complete.
- Use stable IDs and frozen input snapshots. Retry/reconnect/restart must not duplicate destinations or recopy newly edited source settings.
- Tests/evidence stay ignored under `.local/team-project-copy/`; no production writes, service restarts or paid account changes. New modules/assets must join existing syntax-check and static-asset registries.

## Review Focus

1. User edits source prompts while creation retries; preserve the accepted snapshot, tested in Task 1.
2. A source role contains empty/custom instructions or references to old paths; copy exactly and visibly warn, tested in Tasks 1 and 3.
3. Offline devices and missing Worker capability; show pending state and never reroute or enable premature execution, tested in Task 2.
4. Crash around mkdir/marker creation and existing unowned empty folders; fail closed without overwriting or claiming unknown ownership, tested in Task 2.
5. Replayed click, partial success and browser-local ordering; create one project/team and preserve copied order without touching source order, tested in Tasks 2–3.

## Task 1: Frozen team snapshot and creation-operation contract

**Files:** Create `src/project-team-copy.mjs`; modify `src/home.mjs`, `src/coordinator.mjs`, `src/store.mjs`, `src/locales/en.mjs`, `src/locales/zh.mjs`, `package.json`. Test `.local/team-project-copy/snapshot.test.mjs`.

**Interfaces:** Export `ProjectTeamCopy` with constructor `{db,query,online,change}`, `preview(sourceProjectId, {roleOrder})`, `begin(sourceProjectId, input)`, `get(operationId)` and asynchronous `retry(operationId)`. Preview returns source project identity, supervisor configuration/role revisions, working-role snapshots, ordered role IDs, required device IDs and warnings. Input for `begin` is `{requestId,name,folderName,sourceRevision,roleOrder}`; `sourceRevision` is a deterministic digest of the preview's allow-listed source fields. Validate it only on first acceptance; equal retries recover the original operation. Persist `projectCopyOperations` keyed by request UUID, with stable destination project/role IDs and accepted fingerprint.

`get`/`begin`/`retry` return `{id,destinationProjectId,status,sourceRevision,roleIdMap,deviceReceipts,error}`, where status is `pending`, `preparing`, `blocked` or `ready`; roleIdMap maps source role IDs to destination IDs. Return full accepted prompt snapshots only through the explicit preview/detail interface, not the recurring state feed. Compute destination `configured` from its validated binding/runtime; never copy it as a truthy source flag. Disabled/unprovisioned roles remain disabled and unconfigured until explicitly configured later.

Allow-list role fields: `name`, `templateKey`, `responsibility`, `instructions`, `nodeId`, `runtime`, `model`, `effort`, `mode`, `autoApprove`, `enabled`. Ignore stored process/session/usage/old maintenance metadata. Read the source supervisor role's instructions and saved `supervisorConfigs` execution settings, not just defaults. New roles use revision 1; supervisor ID is `supervisor-<destinationProjectId>`. `roleOrder` must contain exactly the copied working-role IDs once each, excluding the fixed supervisor; omitted order uses the source's current stable list order. Copy the supervisor first in the destination display.

Add authenticated GET `/api/projects/:sourceId/team-copy/preview`, POST `/api/projects/:sourceId/team-copies`, GET `/api/project-copies/:operationId`, and POST `/api/project-copies/:operationId/retry`. Reject system-configuration projects. Prepare no folders and launch no model during preview. New project remains `setupStatus:'copy_pending'` until Task 2 commits readiness.

- [ ] Write failing tests for exact custom/empty prompt preservation, archived-role exclusion, disabled-role preservation, effective supervisor settings, new ID mapping, allowed-field exclusion, stale sourceRevision rejection, equal retry, conflicting request reuse and source edits after acceptance. Assert no Tasks/Runs/native sessions/hosting secrets are created.
  Assertion anchors: `assert.equal(copiedEmpty.instructions,'')`; `assert.equal(copiedCustom.instructions,sourceCustom.instructions)`; `assert.notEqual(operation.roleIdMap[sourceRole.id],sourceRole.id)`; `assert.deepEqual(db.list('runs'),beforeRuns)`.
- [ ] Run `node --test .local/team-project-copy/snapshot.test.mjs`; confirm the contract is absent or copies forbidden state before implementation.
- [ ] Implement the accepted configuration snapshot, destination-name reservation and idempotent operation persistence. Store raw prompt strings without trimming them through a generic role editor. Warn that prompts may contain source-project names/paths; do not claim to detect every path automatically.
- [ ] Rerun snapshot tests and check. Confirm pending destinations cannot dispatch through manual, chat, scheduled or agent-call entry points; reuse one readiness guard in `Store.startTask` plus scheduler waiting reasons.
- [ ] Commit `feat: snapshot team-only project copy operations`.

## Task 2: Strict directory preparation and atomic readiness

**Files:** Modify `src/project-team-copy.mjs`, `src/project-space.mjs`, `src/worker.mjs`, `src/project-admin.mjs`, `src/home.mjs`, `src/store.mjs`. Test `.local/team-project-copy/provision.test.mjs`.

**Interfaces:** Extend `prepareProjectSpace(roots, input)` with opt-in `creationOperationId` for strict copy creation; the legacy call without that field retains its current semantics. Updated Workers advertise `projectTeamCopy:1`. Home sends the existing `project_directory` query with the destination project/folder/root and operation ID only to Workers advertising that capability.

The ownership marker includes both destination `projectId` and `creationOperationId`. A matching marker allows replay and bootstrap repair; a mismatched/missing marker on an already existing target rejects, even if the directory is empty. For a new target, use exclusive mkdir under a verified allowed parent, reject symlink escapes, then write the marker and idempotently create only missing bootstrap files. A crash after mkdir but before an ownership marker is durably written is ambiguous: retain the folder and return an explicit ownership error, never silently adopt it or create another destination. No rollback deletion is permitted.

`retry` processes only required devices without verified receipts, bounded to two device operations at once. Revalidate node identity, capability, canonical returned directory and operation ownership before accepting each receipt. Offline/unsupported devices remain pending/blocked with a reason; source roles are unchanged. After all receipts and runtime configurations validate, one transaction installs new workspace bindings, supervisor config, copied role records and initial role order, sets `setupStatus:'ready'`, and writes one non-dispatching welcome message in the new project's default chat. No source repository records or automatic jobs are materialized.

- [ ] Write failing real-filesystem tests: existing nonempty/empty/unowned/symlink targets reject; matching marker replay returns one folder; foreign marker rejects; bootstrap failure preserves owned data and retries safely. Simulate crash before marker and assert blocked ownership, no overwrite and no second directory.
- [ ] Write operation tests for partial device success, offline devices, unsupported Workers, response timeout after successful directory creation, Home restart and concurrent same-ID retries. Assert readiness stays false until every required receipt is verified and all original project rows/files remain unchanged. Verify role definitions install once, with no dispatch.
  Assertion anchors: `assert.notEqual(copy.get(id).status,'ready')` after one required device fails; `assert.equal((await copy.retry(id)).destinationProjectId,first.destinationProjectId)`; `assert.rejects(()=>prepareProjectSpace(roots,{...input,creationOperationId:anotherId}))` for a foreign marker.
- [ ] Run `node --test .local/team-project-copy/provision.test.mjs`; confirm failures before strict creation/provisioning exists.
- [ ] Implement strict copy mode and durable receipts in existing Home/Worker flows. Keep legacy project creation behavior intact. Reject deletion or conflicting reconfiguration of a destination with an in-progress copy operation using existing administrative guards.
- [ ] Run snapshot/provision tests, relevant project-space tests and `npm test`; inspect actual receipt/path identities rather than treating a transport ACK as project readiness.
- [ ] Commit `feat: prepare empty team-copy workspaces safely`.

## Task 3: Copy-team dialog and retryable readiness UI

**Files:** Create `public/project-team-copy.js`; modify `public/app.js`, `public/group-conversations.js` from the parallel-chat plan, `public/list-order.js`, `public/index.html`, `public/styles.css`, `public/locales/zh.js`, `public/sw.js`, `src/workspace-state.mjs`, `src/home.mjs`, `package.json`. Test `.local/team-project-copy/browser.test.mjs`.

**Interfaces:** Export `createProjectTeamCopyUI({api,getData,onCreated})`, returning `{open(sourceProjectId),sync()}`. Menu action is **Copy team into new project**. Preview displays supervisor + working-role settings, source-prompt warning and exact device/folder destinations. Reuse one request UUID from submission through errors/retry; a changed form starts a new operation only before the old one is accepted. Closing a dialog does not delete accepted operations or directories.

Return per-device preparation states through the existing workspace state feed as compact operation summaries, without old/new prompt bodies. No new polling loop. `sync()` refreshes pending UI from that feed. Expose an explicit retry button; a ready result navigates to the new project's default chat once. Add `seedInitialOrder(order)` to the returned list-order controller; it writes only when that scope has no stored order. Seed destination role ordering from the returned new-ID map, never source or unrelated storage keys.

- [ ] Write failing real-browser tests for menu separation, exact prompt preview, empty-prompt visibility, copied role count/order, double submit, repeated retry, partial/offline device notices, reload recovery, ready-only navigation and unchanged source configuration/order. Verify no chat task/model is sent by opening/submitting the form.
  Assertion anchors: `await expect(copyDialog).toContainText('No code or history is copied')`; `assert.equal(operations.length,1)` after repeated submit; `assert.deepEqual(sourceRolesAfter,sourceRolesBefore)` and `assert.deepEqual(sourceOrderAfter,sourceOrderBefore)` after editing a copied role.
- [ ] Run `node --test .local/team-project-copy/browser.test.mjs`; confirm absent or unsafe behavior fails.
- [ ] Implement the dialog and readiness card. Label directories as empty business workspaces with platform bootstrap files; state explicitly that no code/dependencies/history are copied. Unknown operation status is not success. Do not add automatic path rewriting, repository clone options or account reconfiguration.
- [ ] Verify desktop/mobile keyboard access, failure recovery, duplicate names and blank validation. Old Home/Worker versions show unsupported state rather than issuing a legacy creation request with ignored strict fields.
- [ ] Commit `feat: add team-only copy dialog and readiness progress`.

## Task 4: Real-device acceptance and independent review

**Files:** Modify `README.md`, `docs/ARCHITECTURE.md`, `docs/PROGRESS.md`; ignored evidence in `.local/team-project-copy/`.

**Interfaces:** Exercise the actual copy APIs and actual `project_directory` Worker query, with a test-owned source project and destination names. No business source workspace or live user session is a test target.

- [ ] Run `npm ci`, `npm run check`, `node --test .local/team-project-copy/*.test.mjs`, `npm test`, and `git diff --check`; include applicable parallel-chat regressions.
- [ ] Verify on isolated local/server Workers that one accepted copy creates only owned bootstrap directories and exact independent role definitions, without cloning/installing/running. Simulate one unavailable device and retry the same operation. Keep production Workers/services and original project files untouched; if an isolated device cannot be prepared, record the unverified cross-device gate instead of restarting production.
- [ ] Verify copied-role edits do not alter the source and that opening either original/new project retains the correct histories. Record exact source SHA, operation IDs, receipts, directory listings and real-browser screenshots without secrets in ignored evidence.
- [ ] Obtain the selected whole-branch independent review, fix substantiated blockers, update actual-code documentation, and commit `docs: record verified team-only project copying`.

## Handoff

Executed **Native**, after the parallel-chat implementation, with one shared independent review before integration. Directory provisioning passed its separate isolated Mac/server acceptance gate. This plan does not authorize deployment, service restart, business-project activation, account changes or GitHub publication.
