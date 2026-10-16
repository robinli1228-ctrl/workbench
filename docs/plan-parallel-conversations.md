# Fresh Parallel Group Chats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for native execution, or superpowers:subagent-driven-development if the user selects delegated execution. Implement task-by-task; steps use checkbox syntax.

**Goal:** Create a new usable group chat on the same project without importing old conversation context or disrupting existing execution.

**Architecture:** Add a group-conversation identity above the existing messages, Tasks, Runs and role sessions. Propagate it through context and collaboration paths while retaining project/workspace locks. Expose creation only after isolation and legacy compatibility tests pass.

**Tech Stack:** JavaScript ESM, Node.js 22.22.1, existing SQLite Store, Home/Worker and browser modules; no new dependency or build step.

**Spec:** [design-parallel-conversations](design-parallel-conversations.md), sections 1–6 and 8–11. Team-only copying has a separate [implementation plan](plan-team-project-copy.md).

**Source baseline:** `0fe1d98aa3e532f877f2f494bc737556c3117d28`. Status: specification approved by the user's instruction to continue development; this implementation plan awaits review and execution-method confirmation. No feature code implemented.

## Global Constraints

- Same project ID, repository bindings and physical directories; no file copy or Git branch.
- Original chat, files, histories, reports, queued work and running processes remain intact.
- A new chat imports no old messages, summaries, goals, quotations, attachments, tasks or native resume state.
- Missing `conversationId` on legacy records means `projectId`; explicit invalid IDs are errors.
- Shared role configuration remains project-wide; native sessions are conversation-specific and lazy.
- Shared files including AGENTS.md remain readable. This is context isolation, not an OS security boundary.
- Preserve directory/terminal/process locks and device capacity across sibling chats. No new polling or idle model work.
- Test artifacts stay in ignored `.local/parallel-conversations/`. Never commit test data or real personal paths. Do not deploy/restart services as part of these commits.
- Before implementation, verify the working tree, installed dependencies and current HEAD. Preserve any other changes. New modules must be included in the package check command; new browser assets must be registered with Home and the service worker.

## Review Focus

1. Stale direct IDs and pagination cursors must not read a sibling conversation; test in Task 3.
2. An old Run finishing after the user switches chats must publish only to its original chat; test in Tasks 2 and 6.
3. Timers/channel replies and silence-followup cursors must not revive an old goal in a new chat; test in Task 5.
4. Warm CLI reuse and terminal takeover must not reuse another chat's native ID or relax directory locks; test in Tasks 2 and 4.
5. Same role names, identical titles and old native sessions must remain separate in navigation and drafts; test in Task 6.

## Task 1: Conversation identity and idempotent creation

**Files:** Create `src/group-conversations.mjs`; modify `src/home.mjs`, `src/store.mjs`, `src/locales/en.mjs`, `src/locales/zh.mjs`, `package.json`. Test `.local/parallel-conversations/identity.test.mjs`.

**Interfaces:** Export `conversationIdOf(record)` (legacy fallback), `resolveConversationId(db, projectId, value)` (omitted value resolves default; explicit null/empty/unknown/cross-project rejects), and `assertConversationRecord(context, record)` (same project and resolved conversation required). Export `GroupConversations` with constructor `(db)`, `list(projectId)` and `create(projectId, {requestId, sourceConversationId, title})`.

`list` returns the legacy/default chat using `id=projectId`, plus persisted `groupConversations` records. Creation accepts a UUID request ID, uses it as the new conversation ID, rejects equality with the default ID, trims a nonempty title of at most 80 characters, and stores a fingerprint of the resolved source/project/title. Parent identity is provenance only. Add authenticated GET/POST `/api/projects/:projectId/conversations`. Disallow creation for system-configuration projects. No creation side effect launches models, resets sessions or writes workspace files.

- [ ] Write failing tests for `conversationIdOf({projectId:'p'}) === 'p'`, default-chat listing, equal retry returning one record, changed title/source conflict, cross-project source rejection, and branch creation while an old Run is active. Assert old records unchanged and zero new Tasks/Runs/summaries/sessions.
  Assertion anchors: `assert.equal(conversationIdOf({projectId:'p'}),'p')`; `assert.deepEqual(db.get('runs',oldRun.id),oldRun)`; `assert.equal(db.list('groupConversations').length,1)` after equal retries.
- [ ] Run `node --test .local/parallel-conversations/identity.test.mjs`; confirm the missing creation/isolation behavior fails.
- [ ] Implement the interfaces, validation and atomic fingerprinted persistence. Include new record kinds in project cleanup only under the existing project-wide idle guards; add no chat-deletion feature.
- [ ] Rerun identity tests and `npm run check`; expect all green.
- [ ] Commit only Task 1 source/localization changes: `feat: add group conversation identities and creation`.

## Task 2: Messages, Tasks, Runs and native sessions

**Files:** Modify `src/rooms.mjs`, `src/store.mjs`, `src/role-sessions.mjs`, `src/home.mjs`, `src/run-context.mjs`, `src/worker.mjs`, `src/handoff-paths.mjs`, `src/wb-tools.mjs`. Test `.local/parallel-conversations/dispatch.test.mjs`.

**Interfaces:** Extend `Rooms.post(projectId, input)` with `input.conversationId`; extend `Rooms.messages(projectId, before, conversationId=projectId)`. Persist the resolved value on each room message and Task and copy it to the Run in `Store.startTask`. `taskConversationId(task)` retains existing isolated-source semantics while including the owning group identity rather than defaulting those tasks into a sibling. Propagate the Run field through the existing Worker launch/configuration payload. Updated Workers advertise `groupConversations:1`; only non-default conversation execution requires that capability, and old/default work remains compatible. Unsupported or offline destinations leave branch work queued with an explicit reason. Per-turn handoff discovery/seed uses the originating Run/session, never a project-wide most-recent pointer.

Keep the group identity distinct from an existing isolated-source native partition: `Run.conversationId` is the group; `Run.sessionConversationId=taskConversationId(task)` is the native-session partition. Preserve `${projectId}:source:${sourceSessionKey}` for legacy/default source-isolated tasks; use `${projectId}:chat:${conversationId}:source:${sourceSessionKey}` for new branch source partitions; ordinary tasks use their group ID. Add `groupConversationId` to newly created role-session bindings. Export `groupConversationIdOfSession(session)` from `group-conversations.mjs`, returning the explicit field or legacy `projectId`. Do not feed an internal source-partition key into group-message lookup.

- [ ] Write failing tests for messages and quotes in two chats, cross-chat quote/cursor rejection, old Run completion after new chat creation, native-session IDs scoped by project/conversation/role, and legacy missing-field behavior. Assert a new chat's first session has null native ID, lastRunId and resume workspace; assert it receives current project bindings rather than the old chat's retained worktree.
  Include source-isolated tasks in both default and branch chats: native partitions differ, their messages/summaries still belong to the correct group, and existing default partition keys remain unchanged.
  Assertion anchors: `assert.equal(run.conversationId,branch.id)`; `assert.equal(run.resumeNativeSessionId,null)`; `assert.equal(run.resumeWorkspace,null)`; `assert.equal(resultMessage.conversationId,oldChat.id)` for the late old result.
- [ ] Run `node --test .local/parallel-conversations/dispatch.test.mjs`; confirm failures on current project-only routing.
- [ ] Implement propagation and scoped result/note publication. Preserve project-level role definitions, active-session ownership checks and original queued snapshots. Do not introduce automatic history handoff when creating a branch.
- [ ] Run identity + dispatch tests and existing handoff/native-turn tests. Verify an active old Run can finish normally with its original PID/native identity.
- [ ] Commit `feat: isolate chat dispatch and native session context`.

## Task 3: Context, history and direct-read boundaries

**Files:** Modify `src/history.mjs`, `src/session-tools.mjs`, `src/conversation-context.mjs`, `src/conversation-organizer.mjs`, `src/run-context.mjs`, `src/home.mjs`, `src/wb-tools.mjs`, `src/run-document.mjs`. Test `.local/parallel-conversations/context.test.mjs`.

**Interfaces:** Extend `History.search(projectId, input)` and `History.read(projectId, input)` with a resolved `input.conversationId`, defaulting omitted operator input to the legacy chat. Agent handlers supply the authenticated Run's conversation after parsing user arguments; conflicting caller-provided scope is rejected. Session/context methods retain their Run parameter and consume `conversationIdOf(run)`. Result/report reads check their owning Run; request and discussion reads check their trusted owner before returning text. Shared project-file reads remain subject to existing file/review guards, not a new blanket filesystem ban.

Session list/read authorization compares `groupConversationIdOfSession(session)` with the Run's group identity. The current native slot additionally compares `Run.sessionConversationId` (or the legacy derived native partition) to `roleSession.conversationId`. Summary queues and history text remain group-scoped. Test that source-isolated sessions can access their own valid context without crossing a sibling group or bypassing review redaction.

- [ ] Write marker tests using `OLD_CHAT_ONLY` in old messages, summaries, goals, quotes, attachments and handoff seeds. Assert no marker enters a new Run context or its default history/session search. Direct old message/result/session IDs and old cursors must reject; same-chat valid reads still succeed. Include unchanged independent-review redaction and legacy tools.
  Assertion anchors: `assert.equal(JSON.stringify(run.contextPacket).includes('OLD_CHAT_ONLY'),false)`; `assert.throws(()=>history.read(projectId,{conversationId:branch.id,kind:'message',id:oldMessage.id}))`.
- [ ] Run `node --test .local/parallel-conversations/context.test.mjs`; confirm cross-chat exposure or fallback is caught before implementation.
- [ ] Scope actual queries and organizer queues, not only UI filtering. Explicitly cover `wb result`, history search/read, session current/list/read/summary and conversation summary. Do not globally hide project configuration/peer availability or claim shared files are secret.
- [ ] Run Tasks 1–3 tests plus the existing history/context/review regressions applicable to touched modules. Inspect the actual generated Worker input, not merely stored metadata.
- [ ] Commit `fix: keep fresh conversations free of inherited context`.

## Task 4: Collaboration, continuations and ownership operations

**Files:** Modify `src/agent-calls.mjs`, `src/role-calls.mjs`, `src/execution-plans.mjs`, `src/role-discussions.mjs`, `src/collaboration-sessions.mjs`, `src/session-queue.mjs`, `src/session-queue-worker.mjs`, `src/role-steering.mjs`, `src/role-terminal.mjs`, `src/terminal-resume.mjs`, `src/cli-session-recovery-home.mjs`, `src/role-switches.mjs`, `src/home.mjs`. Test `.local/parallel-conversations/collaboration.test.mjs`.

**Interfaces:** Persist trusted `conversationId` on coordination requests, plans, discussion roots, collaboration-session roots, collector batches and continuation Tasks. `RoleCalls.create` derives it from the parent/continued request or source Run; an explicit mismatch rejects. Extend operator session reset/read/summary and role-terminal actions with conversation scope plus an expected `roleSessionId`; retain old default-chat callers. Keep `projectTerminalLock` and `executionConflict` project/workspace scoped. A role's project-wide CLI switch checks that role in every sibling chat and any conflicting shared-workspace claim, rather than selecting an arbitrary session or interrupting another role.

- [ ] Write failing two-chat tests for same-role calls, parallel-review visibility, wait/resume, clarification and queued-message batching. Assert distinct native reservations, no mixed input batches, and correct late-result destination. Attempt cross-chat stop/steer/reset with mismatched session ID; assert rejection and unchanged owner. Assert same-directory candidate waits despite different conversation ID.
  Assertion anchors: `assert.equal(child.conversationId,parent.conversationId)`; `assert.notEqual(newSession.id,oldSession.id)`; `assert.equal(executionConflict(candidate,[activeOldRun]),true)` with the same project/device and different conversation IDs.
- [ ] Run `node --test .local/parallel-conversations/collaboration.test.mjs`; confirm the new scope/ownership cases fail.
- [ ] Add conversation inheritance/validation without changing scheduler capacity, root call budgets or terminal ownership rules. Keep business collaboration-session identity separate from group-conversation identity. Ensure task/request fingerprint compatibility for old retries.
- [ ] Run Tasks 1–4 checks and `npm test`. Reject any change that makes ordinary idle waiting appear as running or silently restarts an old call.
- [ ] Commit `feat: scope collaboration and recovery to originating chats`.

## Task 5: Timers, proactive followup and channel replies

**Files:** Modify `src/scheduled-jobs.mjs`, `src/proactive-followup.mjs`, `src/store.mjs`, `src/wechat-channel.mjs`, `src/home.mjs`, `src/wb-tools.mjs`, `public/scheduled-jobs.js`, `public/project-settings.js`. Test `.local/parallel-conversations/automation.test.mjs`.

**Interfaces:** Timer jobs/occurrences retain `conversationId` from their creation Run/operator scope. Extend `ProactiveFollowup.get(projectId, conversationId=projectId)`, `view(projectId, conversationId=projectId)` and `observe(projectId, conversationId=projectId)`; `save(projectId, input)` receives `input.conversationId`. Retain the legacy record key `projectId` for the default chat and `${projectId}:${conversationId}` for branches. Extend message-arrival/cursor selection to consume only the owning conversation while retaining existing receipt ordering. New branch followup defaults to disabled. Notification records retain conversation identity from their originating Task/Run and use it on reply.

- [ ] Write failing tests that an old timer and channel reply still target the default chat after switching/branching, a new message cannot advance another chat's followup anchor, and branch creation creates no timers/summary/model job. Include a restart with old records missing the field and a duplicate notification reply.
  Assertion anchors: `assert.equal(timerTask.conversationId,projectId)` for the legacy timer; `assert.equal(followup.get(projectId,branch.id).enabled,false)`; `assert.equal(reply.conversationId,notification.conversationId)`.
- [ ] Run `node --test .local/parallel-conversations/automation.test.mjs`; confirm old project-wide observation is caught.
- [ ] Implement scoped observation/dispatch and operator settings while preserving global channel account permissions, original deadlines and existing deduplication. Propagate scope through followup child calls and monitoring findings.
- [ ] Run Tasks 1–5 checks and current timer/followup/channel regressions; assert no extra recurring timer or polling loop was introduced.
- [ ] Commit `fix: retain chat ownership for automatic work and replies`.

## Task 6: Parallel-chat navigation and creation UI

**Files:** Create `public/group-conversations.js`; modify `public/app.js`, `public/room.js`, `public/role-history.js`, `public/role-switch.js`, `public/native-sessions.js`, `public/native-session-groups.js`, `public/list-order.js`, `public/project-settings.js`, `public/styles.css`, `public/index.html`, `public/locales/zh.js`, `public/sw.js`, `src/workspace-state.mjs`, `src/home.mjs`, `package.json`. Test `.local/parallel-conversations/browser.test.mjs`.

**Interfaces:** Maintain `app.selectedConversationId` beside `selectedProjectId`; store the selection and unsent drafts using both IDs. Extend `workspaceState(snapshot, projectId, conversationId)` and state-feed cursor scope to both identities. Include a small `conversations` list and per-conversation sidebar execution metadata, not all histories. Add `createGroupConversationUI({api,getSelection,onCreated})` for the new-chat dialog. Menu action is **Branch into new chat**, and shared settings say **Role and project settings apply to every chat in this project.**

Native catalogue `roleBinding.conversationId` and running-row metadata expose the owning group, obtained through `groupConversationIdOfSession`, never the internal source-partition ID. Default historical bindings still resolve to the default group.

- [ ] Write real-browser failing tests for distinct same-title chats, switching while messages arrive, per-chat drafts, late old replies, row-specific glow, new session selection and independent project/conversation/role native-history grouping. Existing default rows keep the project ID as order key; branch rows use their conversation ID, preserving existing saved ordering.
  Browser assertion anchors: `await expect(branchMessages).not.toContainText('OLD_CHAT_ONLY')`; `await expect(oldMessages).toContainText('OLD_CHAT_ONLY')`; `await expect(branchDraft).toHaveValue('NEW_DRAFT')` after switching away and back; test both views through actual navigation, not DOM-only class injection.
- [ ] Run `node --test .local/parallel-conversations/browser.test.mjs` on an isolated Home with controlled native inventories; confirm the absent UI/scope behavior fails.
- [ ] Implement the UI, conversation-aware API parameters and cache invalidation. Apply filters to the selected chat's role progress/history and keep shared-lock waiting reasons visible. Do not clone project/role records for a branch or start a native CLI on click.
- [ ] Verify desktop/mobile, new/old chats after reload, changed selection during a slow read, expanded native history and existing multi-mention/quote routing. Updated Home advertises `groupConversations:1` for UI availability; branch creation itself remains metadata-only, while Task 2 gates execution on the selected Worker's capability. Never silently revert unsupported branch work to the old chat.
- [ ] Commit `feat: add parallel group chat navigation and fresh-chat action`.

## Task 7: End-to-end acceptance and review gate

**Files:** Modify `README.md`, `docs/ARCHITECTURE.md`, `docs/PROGRESS.md`; keep evidence in `.local/parallel-conversations/`. No runtime deployment changes.

**Interfaces:** Use the completed APIs from Tasks 1–6, including the legacy omitted-conversation paths. Record exact source commit, commands, exit codes, input/native identities and screenshots in ignored evidence files.

- [ ] Run `npm ci`, `npm run check`, `node --test .local/parallel-conversations/*.test.mjs`, `npm test`, and `git diff --check`; report every failure rather than excluding it by scope.
- [ ] On an isolated test project using an already configured available CLI, verify a real first task in a branch has a fresh native ID, current binding and no prior native context. Use deterministic captured-input marker tests for all adapters; identify any adapter whose real startup was not verified. No new account, paid configuration or production task is authorized by this test step.
- [ ] Verify an original test Run survives branch creation unchanged and that the new task waits for the real shared-workspace lock before executing. Stop only test-owned processes after identity checks. If required live verification is unavailable, record the limitation and do not claim complete native-context acceptance.
- [ ] Obtain one independent whole-branch review after native execution; fix substantiated blocking findings and rerun affected checks. Preserve other work and previous review results.
- [ ] Update actual-code documentation and commit `docs: record verified parallel-chat behavior`. Leave production deployment/restart and the separate team-copy feature explicitly distinguished.

## Handoff

Recommended execution: **Native** in this session, with a single independent whole-branch review at the end. The identity, context and continuation tasks share interfaces and benefit from one implementer; task-by-task fresh contexts would add coordination overhead. Review this plan before implementation. This plan does not approve service restart, production model dispatch, or GitHub publication.
