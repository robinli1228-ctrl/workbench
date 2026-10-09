# Minimal Injection — Unified Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Codex, Claude, Grok and Agy normal turns minimal and autonomous without losing team discovery, trusted identity, latest saved instructions or original-dependency recovery.

**Architecture:** Keep Home/Worker, `wb`, persistent calls and native session adapters. Add a versioned execution-instruction snapshot at actual admission, a compatible-protocol gate and a compact query over the existing project directory. Agy updates rules as messages in the same native session. Legacy Workers keep their old input contract.

**Approved compatibility ruling:** Codex resume can retain old developer context despite accepting current instructions. On changed or cleared components only, append a native developer configuration event before the ordinary task, retaining the same thread. New threads need no duplicate event; unchanged delivered versions are not repeated. No model confirmation round or direct native-history edit is allowed.

The operator subsequently approved once-only complete replacement/revocation events for Claude and Grok after their native parameter updates produced stale replies. Preserve their normal native instruction channels and include that event with the ordinary task only when the delivered component changes or the old session has not received the compatibility protocol. No new session, model confirmation or user-prompt rewrite is added.

**Tech Stack:** JavaScript ESM, Node.js >=22.16, existing SQLite/WebSocket/file bridge, installed native CLIs. No new dependencies.

**Spec:** [design-minimal-injection](design-minimal-injection.md).

**Status:** Tasks 1–5 implemented and verified in isolated real environments for all four adapters, then selectively deployed to compatible macOS and Linux Workers. One independent review identified four defects, reproduced and corrected by the author; native compatibility fixes subsequently passed actual execution. Local Agy remains uncovered because of the provider's location rejection. Coverage, failed attempts and post-rollout acceptance limits are maintained in [design section 11](design-minimal-injection.md#11-observed-acceptance-boundary). Unfinished source synchronization remains outside this release.

## Global Constraints

- Do not bulk-change custom platform, supervisor or role prompts. Responsibility never enters its owner's execution instructions.
- Preserve historical snapshots, binding/role/workspace authorization and native association, including ordinary Agy instruction updates. Old-rule/context-cost risk is explicitly accepted.
- No new model configuration-confirmation calls, global roster-removal switch, scheduler replacement or dynamic tool router.
- Preserve admitted-turn snapshot/retry identity. Queue-time prompt is not the instruction source for a not-yet-admitted turn.
- Existing four-adapter behavior stays intact until each replacement passes its native gate.
- Native process success, a reported verdict and independent acceptance remain distinct.
- Verification artifacts stay in ignored `.local/` or the plan's ignored workspace. No test/package scripts are published.
- Public docs contain no actual device/account/path/token values. Source synchronization remains outside this release.

## Review Focus

1. Worker capacity deferral before native start must still get the new prompt; duplicate delivery after admission must not change it (task 2).
2. Warm-process reuse with identical prompts must nevertheless bind tools to the new Run; stale/forged sender input must fail (tasks 1 and 3).
3. An explicit quote/user requirement/late peer answer must not disappear when unrelated group history is removed (task 3).
4. Deadline/reply/cancel races and Home restart must not create two continuations or stop/replay a teammate with unknown effects (task 4).
5. A rolling upgrade or one failed adapter must not remove discovery/context from the other CLIs (tasks 3 and 5).

## Task 1: Baseline, discovery and identity contract

**Files:** Modify `src/team-context.mjs`, `src/role-discussions.mjs`, `src/wb-cli.mjs`, `src/home.mjs`, `src/agent-bridge.mjs`, `src/locales/en.mjs`, `src/locales/zh.mjs` only as needed. Private verification: `.local/minimal-injection/directory.test.mjs`, `identity.test.mjs`, `baseline.mjs`.

**Interfaces:** Preserve `buildTeamContext(db,run,options)`, `RoleDiscussions.peers(run,input)` and `/api/agent/discussions`. Add `input.view='summary'|'detail'` and `input.includeArchived`; `wb discuss peers` requests the compact summary, an explicit JSON argument can request details. Preserve the existing detailed view for legacy callers. Summary response is `{observedAt,teamVersion,selfRoleId,memberCount,complete,items}` with no credential, peer prompt or full history.

- [ ] Add `complete_project_directory_across_devices`, `offline_is_not_absent`, `no_owner_duty_or_peer_prompt`, `query_failure_is_not_empty`, `detail_view_preserved` and `forged_sender_or_project_rejected` assertions over real Store/bridge handlers. Include disabled/archived roles and stale Run context.
- [ ] Run Node 22 `--test` on the two private suites; observe the missing compact/completeness contract fail before edits.
- [ ] Reuse existing directory construction and Home identity lookup. Bind sender from trusted Run and reject identity fields; do not add a model-controlled sender parameter.
- [ ] Run both suites and `npm run check`; capture installed adapter versions and measured input sizes from actual event records without rewriting business data.
- [ ] Commit only the scoped product changes/docs, never private baseline or scripts.

## Task 2: Latest configuration at Worker admission

**Files:** Create `src/execution-configuration.mjs`; modify `src/home.mjs`, `src/worker.mjs`, `src/platform-prompts.mjs`, `package.json`. Private tests: `.local/minimal-injection/configuration.test.mjs`.

**Interfaces:** Produce `freezeExecutionConfiguration(db,runId)` returning persisted `{runId,roleId,roleInstructions,platformPrompt,supervisorPrompt,versions,frozenAt}`. Version each content independently. Worker obtains it through an internal authenticated Home entry not exposed by the CLI bridge; freeze after slot admission and before native instruction delivery. It must reject ended/cancelled/stale binding and preserve switch-maintenance instructions.

- [ ] Add `queued_prompt_is_latest`, `worker_deferred_prompt_is_latest`, `admitted_retry_is_immutable`, `clear_is_not_old_value`, `custom_prompt_verbatim`, `binding_and_native_id_unchanged`, `fetch_failure_no_stale_fallback` and `cancel_during_fetch_no_start` tests.
- [ ] Run private suite; verify queue-time/Worker-deferred configuration fails the new expectations.
- [ ] Implement the snapshot and narrow Worker retrieval at native admission. Keep original launch-command input stable; attach the actual execution configuration as its own audit record instead of mutating historic role snapshots.
- [ ] Run tests and syntax checks. Inspect actual used-version status, not merely settings saved status. Add the helper to existing `check` script.
- [ ] Commit this contract separately.

## Task 3: Four-CLI minimal execution and instruction updates

**Files:** Modify `src/platform-prompts.mjs`, `src/runtime-guidance.mjs`, `src/run-context.mjs`, `src/run-input.mjs`, `src/home.mjs`, `src/worker.mjs`, `src/codex.mjs`, `src/cli-print-session.mjs`, `src/warm-sessions.mjs`, both backend locales, limited to the new path. Private tests: `.local/minimal-injection/input.test.mjs`, `adapters.test.mjs`.

**Interfaces:** Consume task 2's snapshot. Preserve `createRunInput`, `instructionDelivery`, `renderRunPrompt` and adapter interfaces; use an explicit Home/Worker protocol flag in input assembly for all four runtimes. Old input remains the fallback for old protocols, never after a failed configuration fetch. Agy compares independent component versions and sends full replacement/revocation messages to the same native ID, recording receipt only after actual success.

- [ ] Add tests for no default roster/manual/unrelated backlog, exact user task/quote/custom prompt, required attachment/delivery/event, and unchanged responsibilities. Assert explicit user audit requirements survive.
- [ ] Add six configuration-case assertions per adapter: unchanged, changed, cleared, queued edit, process restart and resume failure. Test unchanged prompt plus new Run/tool environment independently; Agy multi-edit updates collapse to final values without native-ID rotation.
- [ ] Run the private suites; verify current long wrapping/queue configuration failures are real.
- [ ] Build concise identity/instruction L1 and task-scoped L2 without fixed planning/review order. Reuse Codex developer instructions, Claude appended system prompt/snapshot-off, Grok per-process rules, and Agy message updates with unchanged native association. Do not touch native permission flags or add model verification/handoff calls.
- [ ] Run suites and syntax checks; count actual instruction delivery, not duplicate audit content. Assert old Home/Worker combinations retain their old path.
- [ ] Commit this unified input path.

## Task 4: Bounded wait deadline and recovery

**Files:** Modify `src/role-calls.mjs`, `src/home.mjs`, `src/wb-tools.mjs`, `src/wb-cli.mjs`, `src/run-reports.mjs`, both locales. Private tests: `.local/minimal-injection/wait.test.mjs`.

**Interfaces:** Extend existing `RoleCalls.wait(run,summary,options={})` with dependency IDs and `timeoutSeconds` (default 1800; integer 60–86400). Add `RoleCalls.expireWaits(now)` to persist a wait-generation event and create at most one existing-kind continuation after parent settlement. `wb wait` keeps legacy plain-text use and accepts explicit dependency/deadline options. Do not add new call completion statuses just for timeout.

- [ ] Add `send_without_wait_continues`, `two_dependencies_one_resume`, `deadline_persists_restart`, `timeout_resume_rewait_original_answer`, `late_answer_routes_effective_wait`, `timeout_does_not_cancel_or_replay_child`, `reply_deadline_cancel_race_one_continuation`, `late_reply_does_not_wake_cancelled_task`, `paused_parent_event_pending`, `archived_target_true_reason`, `legacy_wait_unchanged` and `wait_needs_no_final_report` tests using deterministic clock values.
- [ ] Run suite and observe missing deadline/recovery behavior fail.
- [ ] Persist deadline/dependencies/event in existing Store transactions. Use the existing scheduler and authorization gates; require previous turn/tools settlement before resuming. Separate tool transport timeout from dependency deadline.
- [ ] Run all previous suites, wait suite and syntax checks; verify no duplicate side-effect task or unsolicited cancellation.
- [ ] Commit the scoped wait change. Do not rewrite discussion preview delivery or task scheduling.

## Task 5: Native acceptance, comparison and release gate

**Files:** Private `.local/minimal-injection/native-check.mjs` and evidence only; update `README.md`, `docs/ARCHITECTURE.md`, this plan and the design with actual coverage after tests.

**Interfaces:** Use real Home/Worker HTTP/WebSocket/file bridge and installed authorized native CLIs, not mock adapter success. Reuse task 1's metrics and task 2's actual used-version records. Local/remote fixtures have independent roots/data and do not alter business projects or existing terminal leases.

- [x] Run simple no-collaboration work separately in Codex, Claude, Grok and Agy without required planning or mandatory team queries.
- [x] Run three fresh-session natural discovery/contact attempts per CLI, including a teammate on another device. No tool/recipient hints in task text. If necessary, add only the documented adapter L1 hint, rerun and record both outcomes.
- [x] Run reply-driven and deadline-driven continuation, configuration six-case coverage, same-native association, current tool identity and bad resume failures against real CLIs. Record unavailable environments as uncovered, not passed.
- [x] Compare matched before/after tasks and record characters/bytes, actual tools/WB requests, measured latency, scope-qualified usage, cooperation outcomes and zero extra configuration-validation model calls.
- [x] Verify actual page/configuration persistence in an isolated browser. Run scoped suites, `npm run check` and `git diff --check`. Obtain one independent review of the unified diff; fix material findings with reproducing tests.
- [x] Update actual implementation/acceptance boundaries and commit. Release only after all four adapter gates; report commit/push/deploy separately. Unfinished source sync stays outside the release.
