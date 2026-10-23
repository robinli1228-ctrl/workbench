# Same-conversation Agent switching implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for inline implementation, or superpowers:subagent-driven-development if explicitly selected. Complete each task's failing test, implementation and verification before the next task.

**Goal:** Switch the Agent from its existing Overview label while retaining one conversation and its authentic execution history.

**Architecture:** Home owns a stable conversation, immutable native segments and one persisted switch operation. Worker owns exact folder/process checks, target preparation and context reads. Existing native creation, takeover and history rendering remain the execution paths; no second scheduler or vendor transcript conversion.

**Tech stack:** JavaScript ESM, Node.js 22, existing SQLite Store and Worker transport, browser DOM/IndexedDB. No new production dependency.

**Spec:** [Approved design](design-native-agent-switch.md).

## Global constraints

- Same device and real working directory only; preserve files, uncommitted changes, chat, runtime records and attachments. Never interrupt an active task.
- Only an idle independent conversation without queued input, open questions, active side questions, terminal ownership or uncertain process state may switch. Managed group-role sessions use their existing role controls.
- Selecting an Agent does not submit a draft or resume business work. The next user request carries the handoff once. Return-to-Agent creates a new segment, not a stale native continuation.
- Transfer actual records, not invented summaries. Require applicable AGENTS.md and task-relevant actual-file reads before continuing. Do not copy account credentials or internal reasoning.
- Product text/comments remain English with Chinese locale entries. Tests and evidence stay in ignored `.local/native-agent-switch-20261023/`.
- No push, merge, deployment, service restart, production migration or production task dispatch in this request.

## Review focus

1. Lost replies/restart after target creation must reconcile the same operation, never create a second native session (Tasks 1–2).
2. A source background process or another independent writer in an overlapping folder must block preparation; normal shared-folder behaviour outside switching remains unchanged (Tasks 1–2).
3. Calls against inactive historical segments must not become a second writer through legacy send, terminal-open, side-question or settings endpoints (Task 1).
4. Failed first input must not consume the handoff; late output must stay attached to its original segment (Task 2).
5. Refresh, session changes and incompatible attachments must not lose drafts or attach them to a different conversation (Task 3).

## Task 1: Stable conversation and authoritative switch operation

**Files:** Create `src/native-agent-switch.mjs`; modify `src/native-turns-home.mjs`, `src/native-turns.mjs`, `src/home.mjs`, `package.json`. Tests: `.local/native-agent-switch-20261023/switch-home.test.mjs`.

**Interfaces and stored data:**
- `NativeAgentSwitches({db,online,workerQuery,turns,sideAsks,change})` exposes `begin(nodeId,input)`, `get(nodeId,operationId)`, `assertExecutable(identity)`, `decorateCatalog(nodeId,items)` and `recover()`.
- `input={operationId,source:{runtime,sessionId,entryId},targetRuntime,expectedRevision}`. Device, directory and source ownership are resolved server-side, not accepted from a target directory supplied by the browser.
- `nativeConversations`: `{id,nodeId,workspace,title,revision,currentSegmentId,segments:[{id,runtime,sessionId,entryId,createdAt,switchId}],pendingSwitchId}`. The original selected native identity becomes the first segment; history data is not moved into this record.
- `nativeAgentSwitches`: operation ID, immutable input fingerprint, conversation/revision, source/target identities, stage, Worker preparation identity and error. Stages `preflight → releasing_idle → preparing → ready → committed`; definite failure `failed`, uncertain ownership `reconciling`. No retry turns uncertainty into success.
- Authenticated browser routes: `POST /api/native-sessions/:nodeId/agent-switch`, `GET /api/native-sessions/:nodeId/agent-switch/:operationId`. Response includes operation and redacted conversation view, never private credentials/commands.
- Catalogue decoration supplies a `conversationBinding` with stable ID/revision/current segment and ordered segment identities. Existing unassociated sessions remain unchanged.

- [ ] Write RED tests: successful A→B retains A's original rows; duplicate operation ID returns the same operation; changed fingerprint/revision is rejected; unavailable runtime leaves binding unchanged; pending sends/questions/side asks and managed roles are rejected without a release call.
- [ ] Add RED tests for restart/lost acknowledgement, two competing switches, old-segment send/terminal/side/settings requests, and unrelated conversations continuing normally.
- [ ] Run `node --test .local/native-agent-switch-20261023/switch-home.test.mjs`; confirm failures identify missing guards/state transitions.
- [ ] Implement the coordinator and narrow route hooks. Reserve the conversation synchronously before awaits, persist every externally visible stage, and use existing native release only after preflight confirms idle. Publish current binding and segment together in one Store transaction after Worker readiness and revision recheck. Failure never deletes vendor records or rewrites files.
- [ ] Guard ordinary native input and terminal admission against pending switches and inactive segments. Historical reads remain available; unrelated paths retain existing behaviour. Wire recovery to query the existing Worker operation rather than replaying creation.
- [ ] Add source files to syntax checks, run focused tests and `npm run check`, then commit this coherent backend unit.

## Task 2: Worker preparation and factual context transfer

**Files:** Create `src/native-agent-switch-worker.mjs` and `src/native-agent-context.mjs`; modify `src/worker.mjs`, `src/native-turns-worker.mjs`, `src/native-turns.mjs`, `src/terminal-resume.mjs`, `src/native-sessions.mjs`, `public/history-prompt.js`, `package.json`. Tests: `switch-worker.test.mjs`, `context.test.mjs`, `delivery.test.mjs` under the ignored test directory.

**Interfaces:**
- Advertise `nativeAgentSwitch:1`; Home refuses unsupported Workers. Fixed Worker query actions `native_agent_switch_preflight`, `native_agent_switch_prepare`, `native_agent_switch_status`, `native_agent_switch_abort` dispatch to `createWorkerNativeAgentSwitch({...dependencies}).handle(action,input)`.
- Worker persists `workerNativeAgentSwitches` keyed by operation ID. `prepare` and `status` return `{operationId,stage,workspace,target:{runtime,sessionId,entryId},contextId,error}`. Repeated calls must reuse the recorded terminal/catalogue preparation and process identity.
- Preflight resolves the registered source and canonical directory, probes target readiness using existing runtime data, and checks all known overlapping writers/maintenance/sync reservations. Unlike ordinary independent-session opening, a switch must not use the shared-folder exception to admit another writer.
- Reuse `native_terminal_prepare`/`native_terminal_start` and `nativeHelloArgs` through a narrowly extracted preparation helper, rather than copying their admission/lease code. Native ID must come from the target CLI's actual creation path. Any initialization is preparation only, not the old business request. Keep the staged entry out of ordinary catalogue results until committed. Uncertain/failed preparation keeps its lease and diagnostics until actual settlement, not timeout-based unlocking.
- `createNativeAgentContext({db,conversation,segments,dataDir,readNativeSession})` returns `{id,manifestPath,hash,excerpt,truncated}`. Store private context manifests under Worker data, not project files. Initial context is at most 48 KiB UTF-8 and 32 visible messages plus 32 tool/result records. Explicitly mark omissions and retain original segment/record identifiers and ordering.
- `readNativeAgentContext(manifestPath,{segmentId,cursor})` returns an original-record page of at most 256 KiB using registered native readers. A read-only CLI entry in the same module accepts those fixed arguments; the initial context gives its exact command. The manifest validates membership/identity/hash before reading, cannot select arbitrary histories, starts no model, and requires no Home/Worker token in the Agent environment. No eager full-history scan or all-file export.
- First business input includes `handoffId`/`handoffHash` and the factual excerpt before the user's text. Follow the existing page-instruction delivery receipts: retain pending state if input never reached the model, mark delivered for the exact target segment after confirmed delivery, and never display the hidden handoff as a new user bubble. Historical raw logs remain intact.

- [ ] Write/run RED tests for realpath mismatch, symlink/permission denial, an independent overlapping writer, a retained source child, preparation response loss, restart with an uncertain PID, target login/creation failure and staging-entry visibility.
- [ ] Write/run RED context tests using long mixed chat/tool fixtures: budgets enforced, original attribution maintained, absent facts not filled, truncation visible, unrelated segment denied, missing AGENTS.md not fabricated, credential environment/account files never serialized.
- [ ] Write/run RED delivery tests for rejected-before-input retry, delivered interrupted input, late source events, same prompt across repeated switches and hidden-context rendering.
- [ ] Implement Worker operation and preparation reuse. Carry the existing directory grant to the successor without widening roots. Verify source settlement before target execution and recheck ownership before commit.
- [ ] Implement bounded context/reader and first-input binding. Instruct the successor to read applicable AGENTS.md and inspect current task-relevant files; original records are quoted data, not new authority. Surface missing/inaccessible attachments truthfully; never claim every byte was transferred.
- [ ] Run all three focused suites plus the project's full `npm test` and syntax checks; commit after GREEN. Do not claim real adapter support from fake-CLI tests.

## Task 3: Existing-label dropdown and one persistent transcript

**Files:** Create `public/native-agent-switch.js`; modify `public/native-sessions.js`, `public/native-session-groups.js`, `public/native-history-timeline.js`, `public/history-prompt.js`, `public/styles.css`, `public/locales/native-takeover-zh.js`, `public/sw.js`, the static allowlist in `src/home.mjs`, and `package.json`. Tests: `.local/native-agent-switch-20261023/browser.mjs` and focused grouping tests.

**Interfaces:**
- `createNativeAgentSwitchUI({api,getState,onCommitted,onError})` exposes `render({item,worker,conversation,busy})` and `dispose()`. The existing Agent chip becomes the accessible selector; runtime choices use that device's catalogue and show disabled reasons.
- `onCommitted({conversation,current,segments})` updates the current native execution target while keeping the same conversation/sidebar key and timeline. Conversation ID keys drafts, attachment references, ordering and selection; each history request retains its segment's exact node/runtime/native ID.
- The current segment owns model/depth/quota and page/iTerm controls. Previous segments are read-only, retain their own Agent labels and remain reachable through the existing history loader. Display one switch marker, not a duplicate chat entry.

- [ ] Build RED browser/grouping cases for one sidebar item after A→B→A, retained old messages/tool rows and scroll position, correct target model/quota, and unavailable/occupied choices that send no switch request.
- [ ] Add RED cases for double-click, refresh during preparation, late response after selecting another conversation, nonempty draft with attachments, target-incompatible images and queued messages. No case may auto-submit or clear a draft.
- [ ] Implement the small selector and operation feedback. During a switch disable only this conversation's mutation controls; use existing state updates and bounded operation polling only while necessary, not a new background timer.
- [ ] Render the explicit conversation association in `groupNativeSessions`; do not infer associations from names or directories. Extend history only with verified segment membership, preserving old native IDs and pagination cursors.
- [ ] Update localization/static allowlist/check scripts/cache version. Run the focused real-browser suite in an isolated Home/Worker, inspect desktop/narrow screenshots, run full checks and commit.

## Task 4: Whole-feature acceptance and local delivery

**Files:** Ignored evidence/scripts under `.local/native-agent-switch-20261023/`; update `README.md`, `docs/ARCHITECTURE.md`, the design status and `docs/README.md` only to actual results.

- [ ] Run `npm ci`, `npm run check`, `npm test`, all new focused regressions and `git diff --check` with Node 22. Use an ignored CommonJS fixture temp directory where the existing suite requires it.
- [ ] On isolated local/server test instances, exercise available real Claude, Codex and Agy transitions and a return switch in the same scratch directory. Seed a unique historical fact, a project AGENTS.md instruction, a known uncommitted file and an old completed command. Verify actual tool-read evidence, next-request correctness, no duplicate old command, history retention and unchanged unrelated files. No production models/tasks are repurposed or stopped.
- [ ] Verify stopped/error/missing-source paths, disconnect/restart recovery, old-segment mutation rejection and every Review Focus case. An unavailable adapter/account is a stated acceptance blocker for that transition, never a simulated pass.
- [ ] Conduct one fresh independent whole-branch review after inline implementation; fix blocking findings with reproductions and rerun affected checks. If subagent-driven execution is selected, follow its task review gates instead.
- [ ] Deliver local commit/SHA, screenshots, test counts and any remaining adapter limitations. Keep source history and test evidence. Do not push, merge, deploy or restart services.

## Plan review

Self-review maps the approved behaviour to all four tasks. The five failure classes above each have explicit tests; no automatic summarization, cross-device migration, vendor transcript conversion or concurrent execution was added. Recommended execution is inline implementation with one final independent review because these parts share one state/identity contract. Await user review of this plan and execution choice before product edits.
