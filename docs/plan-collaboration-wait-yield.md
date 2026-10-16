# Collaboration Wait Protection and Manual Yield Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (recommended for this tightly coupled change) or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not implement before user review.

**Goal:** Protect a role's unfinished collaboration from unrelated tasks while allowing an explicit human action to run task B first and retain task A for subsequent continuation.

**Architecture:** Derive collaboration progress from existing request, continuation, discussion, task and Run records. Add a persisted, idempotent human-yield record to B, not a second task state machine. Share the same protection/eligibility calculation between scheduling, direct admission and the read-only queue projection.

**Tech Stack:** JavaScript ESM, Node.js 22, existing SQLite Store, Home/Worker transport and browser UI; no new dependencies.

**Spec:** The user-approved behavior is consolidated in this document's Behavior Contract. This is a plan only; implementation, deployment and verification are not complete.

**Baseline:** `796a5106ac8288d54621eedcc3d3c68ec33f0f8d`; recheck the input SHA and other work before execution. Scheduling and queue files may also be changing in other worktrees: preserve those changes and integrate explicitly, not by overwriting shared directories.

## Global Constraints

- A and B are different tasks assigned to the same role, not two different roles. Scope protection by project, group conversation and verified role/session ownership.
- Do not lock other roles or independent group conversations. Existing device capacity, native-session mutex, workspace exclusivity and review isolation still apply.
- Preserve original task/request identities, replies, reports, files and native history. Do not delete, merge by similar text or silently cancel historical tasks.
- Do not interrupt an executing CLI, inject a reply into its current turn, restart production services, deploy or push during implementation.
- A physically running or uncertain CLI retains its existing lock even after the agent has declared a business wait.
- Formal waits come from platform records, not prose saying “I am waiting”. Known failures/cancellation and unknown process states are handled separately from successful completion.
- Keep verification fixtures, logs and screenshots in ignored `.local/collaboration-wait-yield/`; no tests or runtime data in the public commit.

## Behavior Contract

### Normal operation

1. A creates peer requests and formally waits. When its current turn ends, unrelated same-role tasks remain queued; an idle execution slot does not by itself make them eligible.
2. Peers keep working. A's replies are saved against the original request IDs. Existing idempotent continuation creation is retained.
3. A's own continuation and necessary, identity-linked clarification/reply turns may run. A remains protected while processing replies or registering another wait.
4. Protection ends when the original role has processed the result and no unresolved wait or pending continuation remains. Do not infer this from a child's success or a historical Run's completion alone.

### Human chooses “Guide: run B first, keep A queued”

1. The confirmation identifies A, B, role and device and explicitly says A and its peer work will be retained. Permission comes from the authenticated human UI action, not model instructions or dragging a row.
2. Save the decision before dispatching B. B is promoted once; A temporarily yields its owner role's execution position.
3. **Do not call `RoleCalls.cancel()` or discussion invalidation for A; do not set A's `steeringTaskId`, block its plan, stop peers or revise its direction.** Those existing operations mean replacement, not temporary yield.
4. If A's old native turn is still exiting, wait for its verified end before B starts. If the role is executing unrelated work, do not reinterpret this action as permission to stop it.
5. While B runs, A's arriving replies are saved normally. A has one logical queue entry: `waiting_reply` when required replies are missing, or `resume_queued` when its continuation is ready. Neither state injects data into B.
6. B's own linked collaboration is protected in turn. Once B's chain settles, restore A ahead of ordinary unrelated tasks. If A still lacks replies, it remains protected and waiting; this one authorization does not grant ordinary C permission to run.
7. If B is cancelled before admission, abandon the override and restore A. If B fails or is cancelled after admission, restore A only after the existing lifecycle proves its process has ended; keep B's failure visible and do not automatically retry it. Unknown/disconnected execution retains the block.
8. First release permits one outstanding temporary-yield operation per role/group. A repeated identical request returns its original result; another B/C selection is rejected until the current override settles. This avoids an unspecified nested priority stack.

### Existing destructive steering

Keep “stop the current turn and change direction” distinct from temporary yield. The UI and API must specify which action is requested. During a protected wait, an old ambiguous steer request must not silently cancel A; reject it with a refresh/explicit-choice message. Any retained destructive path requires an explicit confirmation and is not the default meaning of the new guide action.

### Queue and conversation presentation

Chat order follows immutable message-send timestamps; starting, finishing or yielding a task does not reposition its source message. A compact source-linked status replaces repeated indistinguishable waiting bubbles. Queue entries show role, task summary, request identity, enqueue time, reason and source-message navigation.

Display “waiting for replies”, “reply received, waiting to resume”, “processing reply” and “human requested B first” separately. Group by original collaboration identity, not text, while retaining all underlying task/run history. Dragging an ordinary pending task changes its pending order only; it cannot bypass collaboration protection. Do not present one global sequence as a guarantee across independently running roles/devices.

## Review Focus

- A reply races the guide click or B admission: exactly one continuation and one B execution, with no reply reassigned to B (Tasks 1–3).
- A registered a wait but its CLI has not exited, or B disconnects: preserve physical occupancy; no side effects from premature admission (Tasks 2–3).
- Multiple old waits, or mutually dependent role chains: no text-based collapse, arbitrary winner or invisible indefinite wait; expose the conflicting request identities and preserve existing timeout/recovery paths (Tasks 1, 3).
- A child asks its original caller a necessary clarification: identity-linked discussion traffic must not be blocked by the new protection (Tasks 1, 3).
- Old clients, duplicate clicks, configuration changes and restart: no ambiguous cancellation, lost override or cross-session authorization (Tasks 2, 4).

## Task 1: One read-only collaboration projection

**Files:** extend `src/coordination-wait.mjs`; tests `.local/collaboration-wait-yield/projection.test.mjs`.

**Interfaces:** `collaborationQueueView(db)` returns `{states, forTask(task)}`. Each state has `projectId`, `conversationId`, `roleId`, `roleSessionId`, `ownerRequestId`, `currentRequestId`, `taskId`, `runId`, `phase`, `waitingRequestIds` and `reason`. Phases are derived `waiting_reply`, `resume_queued`, `processing_reply`, `needs_attention` and `settled`. `forTask` returns `{allowed, ownerRequestId, reason}` for ordinary, continuation and verified discussion candidates. No writes occur here.

- [ ] Write lifecycle tests asserting a child result alone does not settle A; a queued continuation stays protected; a completed continuation with another wait remains protected; final completion releases protection.
- [ ] Add tests for cancelled/failed versus unknown processes, missing/mismatched continuation links, multiple historical waits, distinct group conversations and identity-linked clarification turns. Ambiguous ownership yields `needs_attention`, not a guessed owner.
- [ ] Run `node --test .local/collaboration-wait-yield/projection.test.mjs`; confirm failures against the baseline.
- [ ] Implement the projection using `currentContinuation`, `waitDependencies` and existing discussion records. Read tables/indexes once per projection and reuse maps; do not issue per-task Worker probes or add polling.
- [ ] Run the focused tests; confirm the projection has not changed records. Commit only the source change once green.

## Task 2: Durable non-destructive human yield

**Files:** `src/role-steering.mjs`, `src/home.mjs`, `src/locales/en.mjs`, `src/locales/zh.mjs`; tests `.local/collaboration-wait-yield/manual-yield.test.mjs`.

**Interfaces:** add `RoleSteering.yieldWaiting(projectId, taskId, commandId, {conversationId, ownerRequestId, roleSessionId})`. Extend the existing steer endpoint with explicit `mode: 'yield_wait'`; the old replacement action is `mode: 'replace'`. Preserve existing command-id replay behavior. Store `tasks[B].collaborationYield={commandId, ownerRequestId, roleSessionId, createdAt, actor:'human'}` as immutable intent. Its lifecycle is derived from B's task/request/run records, not a duplicated status field.

- [ ] Write tests asserting yield leaves A, its children, discussions, plan, reports and native history unchanged; only B's human-operation metadata is added. Test duplicate IDs, changed payloads, two simultaneous B selections, wrong role/group/session, missing human source message and old ambiguous requests.
- [ ] Run `node --test .local/collaboration-wait-yield/manual-yield.test.mjs`; verify the old cancellation-based behavior fails the preservation requirement.
- [ ] Add the transactional human-yield path; validate current protected ownership, B eligibility, configuration and one outstanding override. Do not grant this capability through model tools.
- [ ] Test a child result arriving before/after this transaction, cancellation of unstarted B and replay after reopening Store. Assert no stop command or duplicate continuation is emitted.
- [ ] Run focused tests and commit the explicit API/operation changes.

## Task 3: Admission and recovery use the same rules

**Files:** `src/rooms.mjs`, `src/store.mjs`, `src/role-calls.mjs`, `src/role-discussions.mjs`, `src/coordination-wait.mjs`; tests `.local/collaboration-wait-yield/scheduler.test.mjs`.

**Interfaces:** consume `collaborationQueueView(db)` in `Rooms.schedule`, transaction-time `Store.startTask` and discussion admission. A valid yield makes B eligible and temporarily makes A's continuation ineligible. `RoleCalls.resume` still records arriving results and creates at most one continuation, irrespective of B's execution.

- [ ] Turn `.local/wait-guard-current-diagnosis.mjs` into regressions: without human yield B cannot start while A waits; with yield B starts only after the prior turn exits; A's reply becomes ready but cannot start during B; after B settles A resumes before C.
- [ ] Test B waiting on a peer, timeout continuations, B cancellation/failure/disconnection, direct start bypass attempts and a necessary clarification from A's child. Confirm other roles/groups remain schedulable under existing capacity/exclusivity limits.
- [ ] Add a two-chain mutual-wait fixture. Detect a closed dependency cycle in the projection, expose `needs_attention` and the involved request IDs, retain timeout/recovery behavior, and never resolve it by cancelling tasks or bypassing the lock automatically.
- [ ] Implement protection before expensive recovery checks, but retain transaction-time validation against races. Existing unrelated queues retain their current priority rules; the protected chain/explicit B override takes precedence over ordinary continuation fairness.
- [ ] Test historical multiple-wait records and startup recovery without rewriting them. Existing running tasks continue untouched; inconsistent old ownership blocks new conflicting admissions with an actionable reason, rather than silently deleting backlog.
- [ ] Run `node --test .local/collaboration-wait-yield/*.test.mjs` and `npm test`; commit when green.

## Task 4: Honest queue, source-linked status and guide confirmation

**Files:** `src/home.mjs`, `public/room.js`, `public/execution-progress.js`, `public/locales/zh.js`, `public/styles.css`, `public/sw.js`; tests `.local/collaboration-wait-yield/browser.test.mjs`.

**Interfaces:** Home adds a read-only `collaborationWaits` projection to state. Frontend uses its identity/phase/reason rather than independently guessing from “CLI idle”. Guide posts `mode:'yield_wait'` with the displayed owner/session IDs. A refresh invalidates stale confirmation targets.

- [ ] Add real-browser fixtures for A waiting, B queued, guide confirmation, B running, A reply received and A restored. Assert the visible request IDs/summary match the operation and the UI never labels A cancelled.
- [ ] Separate the guide confirmation from stop/replace. Show A's pending position and B's one-time promotion; disable another temporary yield until the active override settles.
- [ ] Build the chat timeline from immutable source-event timestamps with stable ID tie-breaks; update status in place. Keep original quoted/handoff/report messages and collapse only duplicate task-status representations. No new persistent short-title generator or model call.
- [ ] Expose source-message navigation and waiting reasons; distinguish non-runnable waiting entries from ready continuations. Changing the pending visual order must not bypass server protection.
- [ ] Verify desktop/mobile, reload, two tabs, late responses, scrolling anchors, duplicate clicks, expired confirmations and legacy Worker/Home errors. Use isolated data; do not operate real business tasks.
- [ ] Run browser checks, `npm run check` and focused tests; bump the cache version without removing unrelated assets. Commit UI changes only after actual rendered verification.

## Task 5: End-to-end evidence and delivery

**Files:** update `README.md`, `docs/ARCHITECTURE.md` and append `docs/PROGRESS.md`; private evidence `.local/collaboration-wait-yield/verification.md`.

- [ ] Run `npm ci`, `npm run check`, `npm test`, focused tests and `git diff --check` on the exact final commit candidate.
- [ ] Use isolated Home/Workers and deterministic CLI fixtures to verify dispatch, return delivery and restart recovery. Explicitly distinguish this from an actual model/native-CLI test.
- [ ] Perform one controlled actual native-CLI scenario using test-only files/messages: A delegates/waits, human yields to B, A's result arrives during B, B finishes and A resumes its own result. Record task/request/native-session IDs, ordered events and no concurrent native ownership. If unavailable, report that gap instead of claiming full runtime acceptance.
- [ ] Compare fixture history before/after: no task/request/report/message removed, no A/peer cancellation, one continuation per wake event and no extra B execution. Confirm production PIDs and active task identities are unchanged.
- [ ] Obtain one independent whole-branch review, resolve material findings, update actual implementation/verification boundaries, and commit. No automatic push, merge, deployment, production configuration migration or restart.

## Handoff

Review this plan before implementation. Recommended execution is inline in this chat followed by one independent whole-branch review, because projection, admission and guide semantics are tightly coupled and should not be changed concurrently by multiple implementers. Subagent-per-task execution is an alternative if separate stage reviews are preferred.
