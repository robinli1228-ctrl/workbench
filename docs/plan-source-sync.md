# Incremental Source Synchronization Implementation Plan

**已归档·不作实施依据。** This plan records the completed implementation sequence. Use [design-source-sync](design-source-sync.md) for the current contract and acceptance limits.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for inline execution, or superpowers:subagent-driven-development if the operator selects that method. Complete tasks in order and keep the checkboxes tied to actual evidence.

**Goal:** Synchronize saved source changes across bound devices, preserve conflicting versions, and send an actionable repair task to the evidenced modifier instead of asking the operator to relay it.
**Architecture:** Home owns versioned manifests, sync batches and conflict assignments in its existing SQLite store. Workers capture and apply checked snapshots in independent directories through the existing connection; downstream Runs freeze and consume the snapshot rather than silently reading Git HEAD.
**Tech Stack:** JavaScript ESM, Node.js >=22.16, built-in SQLite/crypto/fs, existing HTTP/WebSocket and browser ES modules; no new runtime dependency.
**Spec:** [design-source-sync.md](design-source-sync.md), approved on 2026-10-08.
**Status:** tasks 1–7 were integrated from the prior implementation; task 8's audit and controlled software-release gates were completed on 2026-10-10. Release regressions and real macOS/Linux synchronization, modifier repair, browser behavior and four-CLI native reads/continuation were checked. Review findings were reproduced and fixed. Three-device coverage is simulated; business-project activation remains a separate explicit operation. The current conservative verification rule requires independent acceptance of repair candidates; see the design's acceptance boundary. The checklists below describe the original test plan, not a claim that every failure-injection permutation was physically exercised.

## Global Constraints

- Extend the current Home/Worker/Room/Task system. No shared mount, new controller, automatic Git commit/push/merge, production deployment or native-session reset.
- Existing projects default disabled. Activation fixes repository/device bindings and shows included/excluded paths; unsupported Workers cannot participate.
- Limits: 20 MiB per file, 100 MiB changed content per batch, 10,000 paths per repository. Scan instability gets one retry. Incomplete scans fail closed.
- Initialize from an identical full Git HEAD/tree on participating nodes; never infer a common base from a dirty workspace. Later HEAD changes block the old generation until reinitialization.
- File equality includes content hash and executable bit; absence is an explicit tombstone. No timestamp wins, rename inference, text auto-merge or file-block delta algorithm.
- Conflict routing is by stable role identity and hash-bound evidence, never name/mtime/Git-author heuristics. One repair owner, at most two confirmed-ended automatic attempts per conflict generation.
- Wait for managed writers, Git baseline operations and manual takeover before applying. External editors are not OS-locked; retain displaced content and never claim filesystem compare-and-swap guarantees.
- Use existing English/Chinese locale resources. Preserve custom prompts and exclude the executing role's own responsibility from new context.
- Keep local tests, logs, identities, credentials and real-device evidence in ignored `.local/source-sync/`; no test scripts or personal environment details in commits.
- Reuse the current clean attached worktree; preserve unrelated edits and record the source commit of every isolated/runtime test. Do not push or enable business-project synchronization as a side effect of testing.

## Review Focus

1. A stale offline third node can resurrect a deletion or overwrite a newer canonical version: task 3 must reject/reconcile its old base without rebroadcast loops.
2. A conflict notification can look correct in chat but create no executable task, or create two writers: task 6 must assert actual Task/Run ownership, idempotency and peer consultation.
3. A successful transfer can leave the downstream isolated CLI reading clean HEAD: task 5 must prove the actual execution directory contains the uncommitted marker.
4. A file can change between inspection, replacement and receipt: task 2 must inject those races and reconcile recoverable copies without false completion.
5. A successful tool event or mtime match can falsely identify an external/shell modifier: task 4 must keep ambiguous content provenance unknown and task 6 must escalate it rather than pick a reviewer.

## Shared records and wire contracts

`Entry = {path, hash, size, executable}` for a regular file; `null` is its tombstone. Paths are normalized relative paths, hashes lowercase SHA-256. `Manifest = {id, projectId, repositoryId, generation, revision, baseCommit, entries, digest}`; hash deterministic path-sorted entries, including executable bits and tombstones. Original change IDs/provenance are separate metadata, not content equality.

Use existing `records(kind,id,data)` with project/repository/generation keys for `sourceSyncConfigs`, `sourceSyncManifests`, `sourceSyncDevices`, `sourceSyncBatches`, `sourceSyncConflicts`, `sourceSyncProvenance`, `sourceSyncCommands`, `sourceSyncReceipts`, `sourceSyncTombstones`. Add a narrow JSON project lookup index/helper for these kinds instead of scanning every project manifest. Worker additionally keeps `sourceSyncJournals` and persistent short-lived apply reservations in its own Store. Bind root identity/HEAD/policy/generation into command fingerprints.

`SyncInput = {repositoryId, baseCommit, generation, manifestRevision, manifestHash, manifestId}` is frozen on Task/Run. `ConflictProposal = {conflictId, generation, requestId, expectedHashes, candidateManifestId, rationale, evidence}`; the Worker captures the candidate from the assigned resolution workspace, not browser/model-supplied arbitrary bytes or paths.

Controls use `source_sync_command`, `source_sync_command_ack`, `source_sync_receipt`, `source_sync_receipt_ack`, `source_sync_reconcile`, distinguished from Run events. A command names `id, batchId, projectId, repositoryId, nodeId, generation, action, fingerprint`; actions are capture, stage, apply and inspect. Receipts persist first and are retried with the original ID, at least 5 seconds apart. Control JSON is capped at 64 KiB; paged manifests and blobs use bounded streaming HTTP on Home rather than exceeding the existing 1 MiB WebSocket frame limit.

Batch states: queued, capturing, waiting_device, waiting_idle, transferring, applying, partial_conflict, reconciling, completed, blocked, cancelled. Conflict states: open, needs_owner, queued, resolving, verifying, resolved_pending_sync, resolved, needs_input, cancelled. Receiving/queueing/CLI success are not terminal synchronization evidence.

## Task 1: File policy, snapshot capture and three-way comparison

**Files:** create `src/source-sync-manifest.mjs`, `src/source-sync-files.mjs`; update `package.json` checks and `src/locales/{en,zh}.mjs`. Tests: `.local/source-sync/manifest.test.mjs`.
**Interfaces:** export `compareEntry(base, local, incoming)` returning equal/apply/retain/conflict; `manifestDigest(entries)`; `captureSourceSnapshot({root, repositoryId, generation, blobRoot, policy, expectedHead})` returning a complete manifest plus excluded paths; `captureGitBase(...)` returning the eligible committed tree. A base missing from the protocol is rejected before comparison; `null` means proven absence.

- [ ] Write real temporary-Git tests with assertions `compareEntry(B,B,R)==='apply'`, `compareEntry(B,L,B)==='retain'`, `compareEntry(B,L,L)==='equal'`, `compareEntry(B,L,R)==='conflict'`; repeat for null and executable-only changes. Assert deterministic digest and no confusion between missing scan and deletion.
- [ ] Add real-file tests for tracked excluded credentials, ignored files, eligible untracked files, binary bytes, nested Git/submodules, symlink/hardlink, case/Unicode aliases, empty files, >20 MiB file, >100 MiB change set, >10,000 paths and unstable reads. Assert exact inclusion/exclusion, explicit blocking, no partial-success manifest and unchanged HEAD/index. Enumerate with Git `-z` output; never split filenames by newline.
- [ ] Run `node --test .local/source-sync/manifest.test.mjs`; record expected missing-behavior failures before implementation.
- [ ] Implement capture using bounded reads, regular-file/realpath checks, SHA-256 staging and one instability retry. Define one shared mandatory exclusion policy for capture and apply. Implement pure comparison without file side effects.
- [ ] Rerun the test and `npm test && npm run check && git diff --check`; commit only source, locale and check-list changes.

## Task 2: Recoverable Worker application and local arbitration

**Files:** create `src/source-sync-worker.mjs`; extend `src/source-sync-files.mjs`, `src/worker.mjs`, `src/terminal-resume.mjs` and `src/project-baseline.mjs` only at affected entry points. Tests: `.local/source-sync/apply.test.mjs`.
**Interfaces:** `SourceSyncWorker({db, resolveBinding, blobStore, activeRuns, takeoverState})` exposes `execute(command)`, `reconcile(commandId)`, `canStart(projectId, repositoryId)` and `receiptBatch(now)`. `applySourceChanges({command, root, changes, db, blobStore, cancelled})` returns durable per-path receipts. Application requires a persisted reservation and revalidated binding/head/generation.

- [ ] Test create/update/delete/binary/executable application and replay: same command produces the same receipts without a second write; different fingerprint under the same ID is rejected; backups contain original bytes.
- [ ] Inject failure before/after staging, backup, rename and receipt persistence; instantiate a new Worker/Store and assert reconciliation retains every version and never infers completion solely from a pending command. Test edits after scan and just before replacement, changed inode/parent links and case collisions.
- [ ] Test active/unknown Runs, takeover, concurrent Git baseline update, pause, cancellation and binding change. Assert no blocked write occurs, new managed launches respect the reservation, and cancellation preserves accurate completed-path receipts.
- [ ] Run `node --test .local/source-sync/apply.test.mjs` red; implement durable journal, private backups, temporary promotion, post-write hashing and conservative recovery. Register legacy/manual Git execution as a competing project operation without changing role permissions.
- [ ] Run tasks 1–2 tests and normal suite/check; commit this independently verifiable filesystem layer, capability still unadvertised.

## Task 3: Home coordination, streaming content and restart-safe transport

**Files:** create `src/source-sync.mjs`, `src/source-sync-storage.mjs`; extend `src/home.mjs`, `src/worker.mjs`, `src/store.mjs`, `src/project-repositories.mjs`, `src/workspace-state.mjs` and locale/check registrations. Tests: `.local/source-sync/coordinator.test.mjs`, `transport.test.mjs`.
**Interfaces:** `SourceSync({db, online, change})` exposes `configure(projectId,input)`, `request(projectId,input,actor)`, `acceptReceipt(nodeId,receipt)`, `schedule()`, `cancel(projectId,batchId,revision)`, `status(projectId)`. `SourceSyncStorage` stores immutable project-scoped manifests/blobs and enforces 1 GiB initial retained-data quota per project; full quota blocks new batches rather than deleting unresolved evidence.

- [ ] Test initial dirty copies against the shared committed tree, divergent HEAD rejection, source offer expected-hash checks, canonical transaction races, and device acknowledgements. Assert a stale third device cannot resurrect deleted files, equality causes no transfer, and partial conflicts never satisfy a dependent batch.
- [ ] Exercise real isolated HTTP/WebSocket Home and Workers: lost ACK, duplicate command/receipt, disconnection after application, process restart, wrong project/node/generation, missing/oversized/corrupt blob, HTTP backpressure and full quota. Assert no duplicate application, no cross-project reads and no fake business Run.
- [ ] Run red tests; implement the shared records and wire contract. Add `GET/PUT /api/projects/:id/source-sync/config`, `GET /api/projects/:id/source-sync`, `POST /api/projects/:id/source-sync/batches`, and `POST /api/projects/:id/source-sync/batches/:batchId/cancel` with browser auth/revision checks. Config activation first uses a read-only scope preview; saving must name the reviewed binding/policy revision.
- [ ] Add authenticated manifest/blob upload/download below `/api/worker/source-sync/:batchId/`; bind access to the registered batch node, exact allowed hash, role of sender/receiver and generation. Use narrowly scoped per-batch transfer secrets delivered over the existing Worker connection, kept out of status/logs/CLI environments. No new global identity system or claim of untrusted-tenant security.
- [ ] Route sync-owned commands before the existing `if (!run) continue` dispatch and Worker `!m.run.id` guard; do not weaken guards on business commands. Add dedicated receipt ACK/reconciliation independent of Run outbox. Project deletion/binding replacement cancels queued sync, fences generations and retains body-free ownership tombstones.
- [ ] Run tasks 1–3 and existing suite/check; commit. Expose capability only after the implemented Worker actually handles all protocol operations. Leave projects disabled.

## Task 4: Content-bound modifier provenance

**Files:** create `src/source-sync-provenance.mjs`; extend `src/worker.mjs` and normalized completed-write processing in `src/codex.mjs`/`src/cli-print-session.mjs` only as needed. Keep `src/run-artifacts.mjs` display heuristics separate. Test `.local/source-sync/provenance.test.mjs`.
**Interfaces:** `recordSourceWrite({db, run, repository, event, before, after, observation})` stores role/Run/path/hash evidence; `attributeSourceChange({records, repositoryId, path, beforeHash, afterHash})` returns `{certainty:'attributed'|'unknown', roleId, runId, candidates, evidenceIds}`. Missing before/after observations or overlapping evidence is unknown, not a guessed author.

- [ ] Tests assert successful matching captured write/deletion belongs to the original role; failed/in-progress tools, prose file links, mtime-only matches, external/shell-only edits and two overlapping writers are unknown. A later edit with a different hash invalidates old ownership; receiver application preserves original provenance.
- [ ] Run red tests; capture enabled-project manifests at managed boundaries and capture content-bound evidence at completed writes. If a CLI cannot supply sufficient evidence, advertise the limited attribution and use supervisor fallback; do not attribute all run-wide diffs by default.
- [ ] Run provenance plus earlier tests and suite/check; commit. No historical mass attribution and no changes to saved custom role prompts.

## Task 5: Frozen snapshot inputs in actual execution workspaces

**Files:** extend `src/execution-workspace.mjs`, `src/execution-plans.mjs`, `src/store.mjs`, `src/role-calls.mjs`, `src/worker.mjs`, `src/run-input.mjs`, `src/run-context.mjs` and locale rules. Test `.local/source-sync/execution.test.mjs`.
**Interfaces:** `freezeSourceInputs(batch)` returns immutable `SyncInput[]` only for complete targets; `prepareSourceInputs({run,repositories,blobStore})` validates ordinary workspace contents or overlays a newly prepared isolated worktree. Add explicit `sourceSyncBatchId` to opted-in handoff/call/stage inputs; do not reinterpret every consultation as a file handoff.

- [ ] A real Git fixture has HEAD content OLD and a synchronized uncommitted marker NEW. Launch preparation must produce NEW for both shared and isolated paths, carry deletions/executable bits, leave source HEAD/index unchanged, and reject missing blobs/unsupported Worker/partial receipt/stale binding.
- [ ] Queue a Task then synchronize another version: assert its frozen manifest and retransmitted launch remain unchanged. A running workspace is never rewritten. Native/warm input generation includes the source-version receipt each turn and does not inject self responsibility.
- [ ] Run red tests; add source-input barrier before Task launch/session acquisition, freeze inputs at Task/Run creation, hydrate isolated overlays before CLI start and verify actual hashes. Preserve fixed-Git-only review behavior; update version/result reporting to distinguish base SHA and dirty manifest.
- [ ] Run tests and existing suite/check; commit. Later real-model acceptance must prove this preparation reaches the native CLI, not just a helper function.

## Task 6: Automatic conflict tasks, accessible evidence and verified resolution

**Files:** create `src/source-sync-conflicts.mjs`, `src/source-sync-agent.mjs`; extend `src/rooms.mjs`, `src/home.mjs`, `src/store.mjs`, `src/role-sessions.mjs`, `src/wb-tools.mjs`, `src/wb-cli.mjs`, `src/agent-bridge.mjs`, `src/worker.mjs` and locales. Tests `.local/source-sync/conflicts.test.mjs`, `agent-tools.test.mjs`.
**Interfaces:** `SourceSyncConflicts({db,rooms,sync,reachability})` exposes `open(input)`, `assign(conflictId,generation,roleId,actor)`, `propose(run,input)`, `finish(runId)`. Add server-internal `Rooms.postSystemTask(projectId,{id,roleId,text,source,sourceInputs})`; atomically register a system-origin message and queued Task with the current role snapshot. No caller-controlled human/system sender on the ordinary public chat endpoint.

- [ ] Test that the same conflict/generation creates exactly one actual owner Task; both writers are notified but only one gets a write assignment. Unknown authors route once to the fixed supervisor, not to name-matched reviewer roles. Busy roles queue, pause defers, rename preserves ID, offline/archived/rebound roles remain explicit, and reassignment fences the old queued owner. Active-owner reassignment waits for confirmed stop instead of creating two repair Runs.
- [ ] Test `wb sync status/read/request/propose` through the real CLI file bridge and Home auth, not only direct helper calls. All managed roles can read same-project conflict versions; only the current conflict owner may propose, with exact generation and Worker-captured candidate. Cross-project IDs, old Runs, arbitrary paths, missing evidence and stale hashes must be rejected.
- [ ] Test a completed CLI saying "fixed" leaves conflict unresolved; fresh edits supersede a proposal; only verified applied receipts close target states. Offline targets retain `resolved_pending_sync`; two safely ended unsuccessful attempts escalate; unknown process state never launches a retry.
- [ ] Run red tests; implement owner selection using task 4 evidence, durable notifications and the system queue. Provide base/both versions and original task/history links. Peer information uses existing consultations, not a second editing task; preserve normal role prompt injection and full caller-relative roster access.
- [ ] Add `/api/agent/source-sync` with action allow-list and async request IDs (the existing 25-second bridge timeout must not require sync to finish inline). Browser conflict detail/assignment endpoints use project/revision guards. Create a dedicated resolution workspace and explicit new native session for the repair task; never force-resume the user's current session in a different directory. Preserve the original role session/history and return ordinary tasks to it after repair.
- [ ] Candidates remain proposals until the platform checks the scoped diff/actual hashes and recorded task-relevant verification evidence. Preserve independent review when the original task requires it; missing required evidence is `needs_input`, not automatic acceptance. Failed checks feed the bounded repair loop. Do not execute arbitrary shell text returned in a report as an automatic verification command.
- [ ] Run tasks 1–6 tests and full suite/check; commit. Record adapter-specific attribution/tool limits explicitly.

## Task 7: Project configuration and visible source/conflict state

**Files:** create `public/source-sync.js`; extend `public/index.html`, `public/app.js`, `public/workspace-inspector.js`, `public/project-settings.js`, `public/styles.css`, `public/locales/zh.js`, `public/sw.js`, static allow-list and check registration. Test `.local/source-sync/browser.mjs`.
**Interfaces:** `sourceSyncPanel({api,getData,getProject,refreshState})` exposes `render()` and owns the Resources section/dialogs. Consume the endpoints in tasks 3/6, not filesystem paths from browser input. State feed includes compact summary/counts only; details and bodies load on demand.

- [ ] Real browser test: disabled default, scope preview before activation, selected bindings, sync button, offline/unsupported/busy states, duplicate-click handling, conflict details/versions, owner assignment and verified resolution. Assert Git status remains a separate card and neither a queued notification nor CLI success shows synchronized.
- [ ] Test English/Chinese, project switch with late responses, reload persistence, stale revision rejection and keyboard-accessible dialogs. Inspect network snapshots: no credentials or full source contents in `/api/state` or service-worker cache.
- [ ] Run red browser cases; implement within Resources/project settings and existing style. Update cache version. Run real browser plus full suite/check; commit with screenshots/logs private.

## Task 8: End-to-end failure matrix, documentation and controlled rollout

**Files:** update `AGENTS.md`, `README.md`, `README.zh-CN.md`, `docs/ARCHITECTURE.md`, `docs/PRD.md` scope note, `docs/OPERATING-GUIDE{,.zh-CN}.md`, `docs/README.md` and design status only after implementation evidence exists. Local harnesses `.local/source-sync/real-workers.mjs`, `real-repair.mjs` and result records.

- [ ] Run all `.local/source-sync/*.test.mjs`, real browser, `npm test`, `npm ci`, `npm run check`, and `git diff --check`. Tests must include all twelve design gates; list exact failures and unverified adapters instead of collapsing them into one pass count.
- [ ] Isolated real Mac/Linux Workers: forward/reverse uncommitted edits, binary/delete/new file, unchanged HEAD/index, network interruption, lost receipt and restart recovery. Verify at disk level, not solely Home response. Use a third real device when available; otherwise mark three-node simulation separately and do not claim physical three-device acceptance.
- [ ] Real managed roles on different devices edit the same fixture, receive correct conflict assignment, obtain peer explanation, produce a scoped resolution, pass the fixture's required verification and receive matching final hashes. Include a fixture requiring independent review and prove it is not skipped. Capture exact model/tool/Run evidence; no business task or real repository update is replayed.
- [ ] Have a native downstream CLI read the unique synchronized marker from its actual isolated worktree and repeat a version change across resume. Exercise every supported CLI tool bridge; gate combinations not actually verified. A failed adapter is a release limitation, not silently counted as a pass.
- [ ] Perform a whole-branch independent review under the selected execution workflow; reproduce and fix findings with red/green tests before deployment. Update actual-capability documents, leaving planned/unsupported cases explicit.
- [ ] Commit source/docs only; record immutable release and private rollback evidence. Update only idle Home/participating Workers, preserve identities and databases, and confirm reconnect/receipts before any source-sync activation. Keep all existing business projects disabled until their scopes are explicitly selected. No automatic push/merge to the public main branch.

## Self-review and execution handoff

Coverage: design sections 2–4 map to tasks 1/3; section 5 to tasks 2/3; section 6 to task 4; section 7 to task 6; section 8 to task 5; section 9 to task 7; all acceptance gates to task 8 and the named owning tests. Missing attribution is a supported fallback, not a false guarantee that every editor is observable.

Execution used inline implementation and a read-only independent review. The transfer, attribution, task and workspace contracts were checked together; the current acceptance boundary is maintained only in the design. Do not reuse this archived checklist as authorization for additional changes or business-project activation.
