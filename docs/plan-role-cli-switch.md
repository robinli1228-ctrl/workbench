# Safe Role CLI Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (recommended here) or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved same-device CLI handoff from role settings, preserving identity and history and leaving the original binding unchanged until verification succeeds.

**Architecture:** Add a persisted operation to the existing Home database. Reuse managed Runs and Worker command/event delivery for handoff and candidate verification; add role-scoped scheduling guards and one atomic commit, not a second coordinator.

**Tech Stack:** JavaScript ES modules, Node.js 22, built-in SQLite, existing WebSocket protocol and plain browser modules. No new dependency or frontend build step.

**Spec:** [design-role-cli-switch.md](design-role-cli-switch.md), approved 2026-10-09.

**Status:** Approved inline execution completed for the initial Codex/Grok scope on 2026-10-09. Home and the two online Workers were selectively deployed; the offline third Worker was not changed. Claude/Antigravity switching is rejected, not silently treated as verified.

## Execution evidence and limits

- 36 focused state, scheduling, Worker, permission, HTTP, browser, presentation and probe tests; 13 existing tests. Syntax checks and whitespace checks passed. Tests and private evidence stay in ignored `.local/role-cli-switch/`.
- Native Codex/Grok sessions demonstrated handoff, independent candidate verification, distinct native IDs, preserved context-only facts, successor cold-resume and unchanged dirty source bytes. A running handoff was cancelled with the original binding retained. Restarting Home preserved committed/cancelled state without duplicate maintenance calls; restarting the isolated Worker reconciled its persisted operation barrier.
- The deployed supervisor form completed first-use native verification and atomically updated its role, project and supervisor configuration. Temporary test cards were removed. The 20 pre-existing business role definitions/bindings were unchanged across deployment.
- One independent code review identified four important defects, all fixed with regression tests: real scheduler terminal states, native maintenance permissions, undispatched dependency-stage bindings, and empty-binding bypass. A new reviewer could not be allocated due to the tool's thread limit, so an existing independent reviewer who did not implement the feature was reused.
- Actual testing also exposed missing Worker final-answer persistence, a copied hash mismatch (correctly blocked), incompatible read-tool instructions, a parent-Git-root inspection error, maintenance leaking into the business status card, and a quota probe that could ignore its timeout. These were corrected; versions/hashes now stay in structured Worker metadata.
- Coverage is bounded: the peer-wait chain was exercised through real Store/RoleCalls integration, not a new full native multi-party discussion. Every network-partition/process-restart/cancellation combination and every provider/model/device combination has not been exercised. The server Worker completed a deployed first-use native supervisor switch after restart; the full native round-trip acceptance was on the local Worker. Other adapters and offline devices remain explicit follow-up gates.
- No GitHub push, mainline merge, or experimental source-sync rollout was performed. Existing native histories, credentials and business files remain in place.

## Global Constraints

- Same device only; no vendor-session database copying, cross-device file migration, native-ID reuse across CLIs, or business-file rollback.
- Preserve project/role identity, history, responsibility/execution-prompt separation and existing authorization. Maintenance turns grant no business-write authority.
- Keep existing custom role fields unless explicitly changed in the submitted draft. Validate the entire draft before work starts; save that draft only in the final transaction.
- Failed, cancelled and interrupted work remains visible; an unknown process must not be released by timeout.
- Tests and real-machine evidence belong in ignored `.local/role-cli-switch/`. Public documentation contains no personal paths, hosts, accounts or credentials.
- Do not deploy unrelated experimental source-sync changes from the development branch. This feature requires compatible Home and Worker versions.

## Review Focus

1. A root task waiting for a peer must still receive its reply while new independent work is held; cover in Task 2.
2. A retained warm process is not the same as an exited process; cover explicit retirement and lost acknowledgement in Task 3.
3. Candidate sessions and their reports must not look like current sessions or completed business work; cover in Tasks 1–3.
4. Close, commit, duplicate Save and edits from another tab can race; cover in Tasks 1 and 4.
5. No current session with archived history is different from no history at all; cover in Tasks 2 and 5.

## Shared interfaces and ownership

- New `src/role-switches.mjs`: `RoleSwitches(db, {now})` owns `preview(projectId, roleId, draft)`, `begin(projectId, roleId, input)`, `get(projectId, roleId, operationId)`, `renew(operationId, leaseId)`, `cancel(operationId, reason)`, `nextAction(operationId)`, `recordStep(operationId, receipt)`, `commit(operationId)`. All state transitions are synchronous database transactions; no network I/O inside them.
- New `src/role-switch-policy.mjs`: `roleSwitchWaitReason(db, task)`, `effectiveExecutionRole(db, task)`, `assertBindingEditAllowed(db, role, draft)` and `isSwitchMaintenance(run)`. Reuse these checks at scheduling and actual launch, not only in the UI.
- New `src/role-switch-runtime.mjs`: `RoleSwitchRuntime({db, switches, query, dispatch, stopRun})` owns `tick()` and `onRunSettled(run)`, translating persisted actions into existing Tasks/Runs/commands. It never changes business verdicts or replays unknown execution.
- New `src/role-switch-worker.mjs`: `RoleSwitchWorker({db, warmSessions, activeSessions, roots})` owns `inspect(input)`, `prepare(input)`, `status(operationId)`, `release(input)`, `assertLaunch(run)`. Worker receipts are persisted by operation/action ID before replying.
- New `public/role-switch.js`: `createRoleSwitchUI({api, refreshState})` exposes `begin({projectId, role, draft, host})`, `cancel()`, `resume(...)` and `dispose()`. Both ordinary and supervisor editors use the same controller.

`begin` input is `{operationId, expectedRoleRevision, expectedSupervisorRevision?, leaseId, draft}`. IDs are UUIDs; the request fingerprint covers the immutable input. `draft` is the validated role-form draft; its node must equal the current node and its runtime must differ. Supervisor drafts use the fixed role and current supervisor configuration rather than the ordinary-role save path.

Use the specification's stages. A blocked operation retains the barrier until its maintenance Runs and Worker barrier are safely released; a retry starts a new operation after cancellation, not a silent replay. Browser heartbeat is 10 seconds, lease duration 120 seconds, and UI status polling is 1 second while visible. Lease expiry requests cancellation; it does not imply process exit.

## Task 1: Persist switch state, candidate identity and atomic commit

**Files:** create `src/role-switches.mjs`, `src/role-switch-policy.mjs`; modify `src/role-sessions.mjs`, `src/rooms.mjs`, `src/coordinator.mjs`, `src/project-setup.mjs`, `src/store.mjs`, `package.json`.

**Interfaces:** implement the shared service/policy contracts. Candidate role sessions carry `candidateFor: operationId` and are excluded from ordinary current-session lookup. Existing full saves, supervisor saves, setup proposals, archive and reset must use the same mutation guard. Extract existing validation into a pure validation path where necessary; never test-save a candidate into live configuration.

- [ ] Write `.local/role-cli-switch/state.test.mjs`: begin leaves role/current session unchanged; identical IDs return the same operation; different payloads conflict; only one pending operation per role; cross-device and stale revision inputs fail; unrelated text-only saves still work.
- [ ] Run `node --test .local/role-cli-switch/state.test.mjs`. Expected: failing assertions for missing switch methods/guards, not an import or fixture error.
- [ ] Implement begin/candidate/commit/cancel contracts. Before commit revalidate role/workspace revisions, lease, source and candidate settlement and Worker receipts. Update ordinary role or all supervisor records, session promotion/archive and queued execution bindings together. Preserve historical Task/Run snapshots and source native IDs.
- [ ] Add commit/cancel interleaving tests and assert the exact result:
  ```js
  assert.equal(db.get('roles', roleId).runtime, originalRuntime); // every pre-commit failure
  assert.equal(currentSessions(roleId).length, 1); // commit or cancellation
  assert.deepEqual(originalHistoricalRuns(), baselineRuns);
  assert.equal(switches.cancel(committedId).status, 'committed');
  ```
  Test a cancelled staged session never becomes current, no-history is explicit, disabled work roles stay disabled, and stale source-binding mismatches fail visibly rather than being reset automatically.
- [ ] Run the state test and `npm test`; expected: all pass. Commit only product changes and relevant docs, not `.local` tests.

## Task 2: Drain collaboration safely and launch managed maintenance turns

**Files:** create `src/role-switch-runtime.mjs`; modify `src/rooms.mjs`, `src/store.mjs`, `src/role-calls.mjs`, `src/role-discussions.mjs`, `src/execution-plans.mjs`, `src/run-context.mjs`, `src/run-reports.mjs`, `src/session-tools.mjs`, `src/home.mjs`, `package.json`.

**Interfaces:** consume Task 1 state/guards; `nextAction()` returns a stable action ID and one of `wait`, `handoff`, `verify`, `prepare_worker`, `commit`, `stop`, `release_worker`. The runtime driver records action/Task/Run IDs before dispatch. Maintenance Runs use `switchOperationId` and `switchPhase: handoff|verify`, not a fabricated human message or business RoleCall.

- [ ] Write `.local/role-cli-switch/scheduling.test.mjs` against real Store/Rooms/RoleCalls: freeze roots already accepted at begin; allow their descendants, replies and continuations to settle; hold independent later work. Test a discussion reply arriving during draining and an old pending plan stage that must finish before the checkpoint.
- [ ] Run that test; expected: RED for unguarded launch or lost continuation. Implement guards in both scheduling and Store launch paths. Continue accepting new messages but attach a switch wait reason. Do not cancel existing business requests.
- [ ] Launch a handoff turn using the original binding/session, then a candidate verification turn using a distinct platform/native session. If only archived history exists, start a fresh original-CLI handoff turn from platform history; do not resume an archived vendor ID automatically. True first use may skip the source handoff with a recorded reason.
- [ ] Persist a versioned checkpoint containing original task/reference IDs, source revision/watermark, the source Run's handoff artifact and Worker-observed repository/file metadata. Never use an unrelated role's shared LATEST file. Reference full history through existing paginated tools when truncated.
- [ ] Inject the complete new checkpoint once into the target verification turn, regardless of old-session inherited-context optimization. Keep responsibility discovery-only. Store maintenance reports with their maintenance identity and exclude them from business completion, normal continuation, timer and plan advancement.
- [ ] For held but never-launched Tasks/requests use a separate `executionBinding` and resolve it through `effectiveExecutionRole`; new Runs record both the source snapshot and actual execution configuration. Worker validation compares against that explicit binding. Never rewrite a sent command or resumeWorkspace/native ID from the old CLI.
- [ ] Test lost start replies, duplicate terminal events, cancelled business roots, candidate reports and Home restart. Expected: one maintenance Run per stable action, no business success manufactured, no old event unlocks the candidate, no replay on uncertain state.
- [ ] Run scheduling/state tests and `npm test`; expected: all pass. Commit the bounded integration.

## Task 3: Worker settlement, checkpoint inspection and recovery receipts

**Files:** create `src/role-switch-worker.mjs`; modify `src/worker.mjs`, `src/worker-coordinator.mjs`, `src/warm-sessions.mjs`, `src/agent-bridge.mjs`, `package.json`.

**Interfaces:** add Worker capability `roleSwitch: 1` only when these handlers and launch guards are installed. Reuse authenticated query actions `role_switch_inspect`, `role_switch_prepare`, `role_switch_status`, `role_switch_release` with stable action IDs. Do not add a device listener or expose arbitrary filesystem paths from browser requests.

- [ ] Write `.local/role-cli-switch/worker.test.mjs`: a warm retained source cannot be declared retired until its process exits; lost ACK returns the persisted receipt; an unknown process blocks release; candidate launches cannot use source native IDs or bypass the operation barrier.
- [ ] Run worker test; expected: RED. Implement durable role/session barriers and scoped warm-process retirement using existing process ownership. Do not stop other roles or the whole Worker.
- [ ] Inspect all bound repository directories and the handoff artifact within the existing workspace/path limits. Record exact commit/status and hashes for relevant changed files; do not store credential contents. Partial/unavailable inspection blocks verification instead of inventing a clean snapshot. Same-device dirty files stay in place and are never auto-stashed, committed or reset.
- [ ] Validate target login/model/effort and session creation using its actual adapter. Collect its acknowledged handoff hash and actual native-start/terminal evidence, then recheck the workspace. A plain exit code or status probe is insufficient. Unexpected source-file changes during maintenance block completion and remain preserved for inspection, not automatically rolled back.
- [ ] Close candidate warm execution after verification while retaining native history for later cold resume. Persist source retirement/release results. Worker restart re-establishes barriers before accepting role launches; it reconciles commands rather than rerunning a model. Cancellation release waits for every maintenance Run and native process to settle.
- [ ] Test runtime unavailable, incomplete output, handoff file replaced after inspection, stale action IDs, queued launch after cancellation and source offline. Run worker/state/scheduling tests and `npm test`; expected: all pass before capability advertisement.
- [ ] Commit Worker support separately to support coordinated rollout.

## Task 4: Authenticated API and both configuration UIs

**Files:** create `public/role-switch.js`; modify `src/home.mjs`, `src/workspace-state.mjs`, `src/locales/en.mjs`, `src/locales/zh.mjs`, `public/room.js`, `public/supervisor-settings.js`, `public/index.html`, `public/locales/zh.js`, `public/sw.js`, `package.json`.

**Interfaces:** authenticated project/role routes:

- `POST .../roles/:roleId/cli-switch/preview` takes the draft; read-only compatibility/blocker result.
- `POST .../roles/:roleId/cli-switches` takes the shared begin input.
- `GET .../roles/:roleId/cli-switches/:operationId` returns stage, reason and evidence references, not raw artifacts or secrets.
- `POST .../roles/:roleId/cli-switches/:operationId/renew` takes `{leaseId}`.
- `POST .../roles/:roleId/cli-switches/:operationId/cancel` requests cancellation and returns authoritative state, including already committed.

- [ ] Write `.local/role-cli-switch/http.test.mjs` with a real isolated Home: missing auth, wrong project/role, stale draft, unsupported Worker, duplicate request, direct-save bypass, supervisor bypass, pending-operation reset/archive, and cancel after commit.
- [ ] Run HTTP test; expected: RED. Implement routes and body-free state projection; serialize progress through the existing change/SSE channel. Project deletion must reject unfinished switches and clean only settled metadata.
- [ ] Implement one reusable dialog controller for both editors. Store operation/lease IDs in sessionStorage by project and role; disable draft mutation while preparing. Save only starts the operation; no archive/reset request happens on selecting a dropdown option.
- [ ] Close/Escape requests cancellation; show that shutdown is pending until confirmed. Use keepalive cancellation as best effort on page exit plus the server lease as fallback. Refresh reattaches to the same operation. A stale response from a prior project/dialog cannot alter the current form. Post-commit errors display committed status instead of reverting the UI falsely.
- [ ] Write `.local/role-cli-switch/browser.test.mjs`: actual click/select/save/cancel/escape/reload sequences; both languages; supervisor and work-role forms; preserved responsibility/prompt drafts on failure; model-only and text-only edits; unreachable Home and commit/cancel race.
- [ ] Run HTTP/browser tests and `npm test`/`npm run check`/`git diff --check`; expected: all pass. Add the new browser module to the static route and service-worker cache. Commit UI/API integration.

## Task 5: Real CLI acceptance, independent review and selective rollout

**Files:** ignored `.local/role-cli-switch/acceptance.mjs` and evidence; update `README.md`, `README.zh-CN.md`, `docs/ARCHITECTURE.md`, `docs/OPERATING-GUIDE.md`, `docs/OPERATING-GUIDE.zh-CN.md`, `docs/README.md` and the approved design's implementation-status section only after evidence exists.

- [ ] Create an isolated project with a tracked file, a known uncommitted edit and a unique handoff fact. Use actual installed/logged-in CLIs, not simulated ready flags. The test starts from the real browser role editor.
- [ ] Run real CLI A → B → A: preserve identity/history, verify fresh native IDs on each switch, actual handoff/file checks before commit, and correct next business turn/cold resume. For every additional offered CLI, verify it as both source and target before advertising support; unavailable accounts remain explicitly unverified.
- [ ] Exercise running work and peer-wait draining; cancel at handoff and verification; close/reload; login failure; duplicate Save; concurrent edit; lost ACK and Home/Worker restart. Inject faults only into isolated services. Assert original files are byte-identical on cancellation and no old/candidate process can write concurrently.
- [ ] Run the full suite plus the focused tests from Tasks 1–4. Conduct one fresh-context whole-change review; fix important findings with RED/GREEN regression evidence. Keep a private ledger of exact test results and unresolved adapter coverage.
- [ ] Verify Home/Worker release compatibility and active Runs before rollout. Build a selective release from the current verified runtime plus this feature, excluding experimental source-sync changes. Back up configuration, release compatible Workers and Home without interrupting business Runs, then repeat a browser/CLI smoke on the deployed version.
- [ ] Remove temporary test cards/services only after exporting evidence and confirming process shutdown; preserve existing business projects, native histories, credentials and uncommitted files. Commit documentation with honest code/deployment/acceptance status; no force push or mainline merge is implied.

## Self-review

The five review risks map to explicit tests above. The same operation ID, source revision, session generation and handoff hash cross all interfaces. No stage commits role configuration early, changes the meaning of business acceptance or treats a timeout as an exit. Existing cross-device and experimental source-sync work is not a dependency. Recommended execution is inline/native because state, queue and Worker changes share one contract, followed by one independent review.
