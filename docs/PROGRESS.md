# Development Progress

## 2026-10-10 — Managed input language

- Implemented English Workbench-maintained execution templates independently from interface localization, with send-only Simplified-to-Traditional prose conversion for all four managed dialogue adapters. Original chat/configuration records and exact executable/identity text remain unchanged. Current behavior and exclusions are defined once in [ARCHITECTURE](ARCHITECTURE.md#managed-input-language).
- Verified 23 targeted checks on macOS and Linux, 13 existing tests, syntax/whitespace checks, and 24 isolated native CLI turns. The native runs cover initial execution, unchanged continuation after a UI-language switch, changed/cleared prompts and exact-session cold resume; final checks use Chinese role names. Claude native user-input records confirm conversion independently of its Simplified display hook.
- Independent read-only review findings about exact quotes, build commands, trusted names and Home-side template language were reproduced and fixed. Tests and execution evidence stay in ignored private directories.
- This records implementation and isolated acceptance only. No public push, merge, or installation into ongoing services was performed for this change.

## 2026-10-10 — Project settings usability

- Moved basic-information saving into its section, kept independent configuration actions, and placed project deletion in a separate danger section. Important project actions show localized text alongside their icons.
- Scoped results to their originating operation, clear stale results when that section is edited, and aligned the device-folder action with its selector. Project settings and Resources now use the same project file sync name.
- Real isolated browser checks cover basic/supervisor save isolation, folder binding, folder preparation, sync entry, language switching, cancelled deletion and three viewport sizes. Syntax checks and the existing test suite passed; private screenshots and execution records remain outside Git.
- The same checks passed against a Linux-hosted isolated Home/Worker. Runtime revision `26eda55` was installed into the existing local Home/Worker and connected remote Worker; post-release browser checks and asset comparisons passed. Configuration, native-session associations and execution history were retained, and the previous dispatch-pause setting was restored.

## 2026-10-10 — Terminal takeover recovery

- Status refresh now verifies terminal processes with the corresponding Worker and returns unused or exited takeovers. Offline, unsupported or unverified processes retain their locks. A human-only stop-and-return action terminates only identity-verified processes and waits for exit before releasing the project queue.
- Recorded owner/start identity for new launchers and CLIs, retained stopping capacity, and fenced late preparation/completion. Terminal dialogs update their device, takeover and execution gates with current state and identify the actual takeover owner.
- Nine real-process checks passed on both macOS and Linux. Isolated browser acceptance covers refresh, graceful/forced exit, cancellation, offline/old capability handling, language/mobile layout, actual Codex terminal startup and stopping, exact historical resume, and original native-session continuation without duplicate queue execution. Private fixtures and screenshots remain ignored.
- Final process checks expanded to ten on each platform, including a changed-owner identity case. Legacy/missing owner metadata was checked in the actual browser. Runtime revision `e7d91ad` was installed into the existing local Home/Worker and connected remote Worker; live refresh, asset hashes and capability reporting passed. Role configuration, native associations, execution history and delivery approvals were preserved, and the prior dispatch-pause setting was restored.

## 2026-10-10 — Claude effort discovery

- Replaced empty Claude effort metadata with native per-model capability discovery, preserving existing aliases, provider identities, role settings and unspecified defaults. Initialization is bounded, non-persistent and does not send model input, run hooks or start MCP servers.
- Eight targeted checks cover supported/unsupported metadata, provider mapping, legacy compatibility and default/new/resumed execution parameters. The existing thirteen tests and syntax checks passed. Real CLI probes and isolated Home/Worker browser acceptance passed on macOS and Linux: role save/reopen/default restoration, supervisor save, language switching and mobile layout, without creating managed model Runs.
- Early Linux browser assertions used an insufficient five-second window while role/supervisor save-time checks were pending; waiting for the actual HTTP results passed. Private fixtures and screenshots remain ignored. This change has not yet been pushed or installed into the running services.

## 2026-10-10 — Responsibility-only role templates

- Added eight optional bilingual templates for planning, execution, review, testing, architecture, debugging, deployment and documentation. Each pre-fills responsibility and leaves execution instructions empty. Existing template keys and saved roles are preserved; no automatic role creation or fixed workflow was introduced.
- Local checks and real isolated browser acceptance cover all presets in both languages, saving and reopening an empty prompt, preserving an existing custom role, cancelling drafts and mobile layout without model Runs. Existing locale tests now check localized responsibilities and blank prompts rather than the superseded four nonempty-prompt templates. New verification scripts and screenshots remain ignored.
- The initial browser script watched an incorrect language endpoint; the corrected script passed through the existing language API. This change has not yet been pushed or installed into the running services.

## 2026-10-10 — Combined template and Claude effort rollout

- Installed runtime revision `bdebde7` into the existing local Home/Worker and its connected Linux Worker, retaining the original service managers, data directories and execution bindings. The independent server instance was outside this rollout. Dispatch was temporarily paused for backup/restart and restored to its prior setting afterward.
- Both packaged copies passed dependency installation, syntax checks and thirteen existing tests; ten targeted checks passed. Live browser verification covers all eight empty-prompt responsibility presets, local provider and remote Claude effort choices, supervisor choices and mobile layout. Served assets and corresponding local/remote source hashes match; draft-only verification did not save role configuration or start model Runs.
- Before/after checks preserved twenty-one role records, native-session associations, project/workspace bindings, execution and terminal history and existing delivery records. The remote snapshot verifier initially compared omitted JSON fields against in-memory undefined fields; symmetric serialization confirmed unchanged persisted data. Backups, prior release copies and private evidence remain available, and public Git publication was not part of this release.

## 2026-10-11 — Automatic terminal return and truthful queue status

- Home checks open terminal takeovers every fifteen seconds and on Worker readiness. Dead processes return without a page refresh, while unopened links have a five-minute grace. Offline or unidentified processes remain locked; background checks never stop live CLIs. Older Workers are protected from premature prepared-link revocation.
- Plan activity now follows requests and actual Runs, displaying blocked queues and their reasons instead of treating every open plan as running. Active Runs take precedence over stale task waiting reasons. Terminal dialogs explain the automatic return window.
- Seventeen focused process/display checks passed on macOS and Linux, alongside the existing thirteen tests and syntax checks. Isolated native acceptance on both hosts covers unused-link grace, live/dead processes, offline/reconnect, Home restart, old-Worker compatibility and exactly-once continuation of the original native session. Real browser checks cover blocked/running state, bilingual labels and mobile layout; a composite-label translation issue found in screenshot review was corrected and rechecked on both hosts. Fixtures and private evidence remain ignored. Deployment is recorded separately after live verification.
- Runtime revision `6a004de` was installed into the existing local Home/Worker and connected Linux Worker after active work drained. Both packages passed dependency installation, syntax checks and thirteen existing tests. Live source/asset hashes match, both Workers advertise automatic return, and a stale unused takeover was released without a page refresh. Live browser verification passed for the actual review plan, terminal explanation, language switching and mobile layout without creating model Runs. Role configuration, native-session associations, terminal history and delivery records were preserved; dispatch resumed with its previous pause setting. The independent server instance and offline device were not changed. This local commit has not been pushed to GitHub.

## 2026-10-11 — Task-scoped review collaboration

- Reviewer duty presets and maintained prompt examples now distinguish independent review from assigned repair/re-review. They preserve factual consultation and require evidence of authorship rather than assuming an execution role owns every reviewed document. New role templates still leave execution prompts empty. On-demand scheduling help describes the independent-review handoff in one sentence; no collaboration endpoint or scheduling restriction was added.
- Explicitly requested live prompt edits used revision-checked role-definition APIs. Unrelated roles, bindings, native histories and already frozen execution configurations were preserved. The existing shared supervisor setting received a concise independent-review handoff hint; this setting is shared rather than project-specific.
- Thirteen existing tests, eighteen configuration/input checks and syntax checks passed. A real isolated Grok session retained its native identity across an old-to-new prompt update: a self-contained independent review completed without consulting the execution role, while a separate missing-fact task consulted an evidenced author and resumed with the reply. Live browser checks confirmed all four edited review prompts without saving new tasks or role changes. This is measured model behavior, not a deterministic prohibition on collaboration.
- Installed runtime revision `f690aba` into the existing local Home/Worker and connected Linux Worker after confirming no active runs or background organization. The first remote backup command ran before the release upload finished and made no service changes; after transfer completed the backup succeeded. Both Workers returned online, locale source hashes matched, and the live role editor/new-reviewer template checks passed with empty preset instructions preserved. Existing role configuration, native associations, terminal records and delivery history survived restart; the previous dispatch-pause setting was restored. Public Git publication was not part of this change.

## 2026-10-11 — Consultation continuation and report recovery

- Removed the incorrect global three-wakeup consultation gate; root call limits, cycle/depth checks, retries and cancellation guards remain. Prior reports and request history are unchanged. Updated the corresponding tool instructions rather than adding a new workflow.
- Accepted work can now submit reports and settle/read existing context while dispatch is paused, through the same narrow Worker/Home allowlist; new operations and stopped identities remain blocked. Exact probe-placeholder reports are rejected before persistence. Print adapters retain bounded tool diagnostic output separately from assistant replies.
- Reproduced the fourth-reviewer rejection, acceptance of placeholder reports and lost tool-result output before fixing them. Seventeen focused regression/continuation tests and thirteen existing tests passed locally; six focused checks passed on Linux. Real isolated Grok successfully reported while dispatch was paused; real Agy received rejection for its placeholder attempt and stored the substantive report once. A test initially expected undefined for Store's missing record; correcting it to the actual null contract passed. Native runs used isolated data and did not alter the business review chain.
- Installed runtime `d8da3de` into the existing local Home/Worker and connected Linux Worker with backups and unchanged role/native configuration. The previously blocked real review chain was then continued through a user-authorized message: the missing Grok report was supplemented without rewriting history, Claude completed the outstanding item-by-item discussion and a focused wording clarification, and the supervisor updated the existing final Markdown. Independent checks preserved all prior project execution reports and native associations, verified the unchanged original-document byte prefix/hash, and read the resulting appendix. Communication/document delivery is complete; this is not implementation or business acceptance. The periodic follow-up is stopped. Code is locally committed, not publicly pushed.

## 2026-10-13 — Project settings categories

- Split Project Settings into four sticky tabs: basic information, repositories/workspace, file sync, and collaboration/scheduling. Switching changes visibility only; existing inputs, section saves and backend rules are retained. Global settings remain separate. See [ARCHITECTURE](ARCHITECTURE.md#three-column-workspace-and-recent-artifacts) for the implementation boundary.
- Real Edge browser verification against an isolated Home (no API mocks) passed for draft text/numbers/checkboxes, expanded folder controls, independent basic-information saving, sync dialog access, keyboard navigation and desktop/mobile sticky tabs. Switching tabs made no write requests. All 56 existing tests and syntax checks passed.
- Local development and isolated verification only: no production restart, dispatch pause, project activation or publication. Unrelated quota-statistics work remains uncommitted and preserved.

## 2026-10-13 — Approved double-terminal logo

- Replaced the raster source with the user-approved preview and regenerated transparent, centered 192px and 512px application icons. Updated page, favicon, Apple touch icon, PWA manifest and service-worker cache references together.
- Real browser verification against an isolated Home confirmed image loading, matching versioned URLs, expected dimensions, transparent corners and centered margins. The saved source is byte-identical to the approved image. Existing services and running tasks were not restarted or paused; this records a local asset update, not deployment.

## 2026-10-13 — Session UI integration

- Integrated the session-filter-controls and terminal-dialog-actions branches with the four Project Settings tabs and approved logo. Resolved the shared settings layout to retain full-width headers and sticky category tabs without resetting drafts.
- Session filters default to all devices and Agents. The read-only live scene is entered from role cards; new/resume session actions open their existing confirmation forms. An integration review found that offline devices lost cached independent entries under All; Home now returns those entries with an explicit partial/offline result, without permitting offline history reads or terminal actions.
- Real isolated browser checks passed for settings drafts, icon assets, offline cached entries, session filters and live-scene/native-entry routing. Controlled terminal/catalog responses were used only for action routing and failure cases; offline cache, settings and icon checks used actual Home APIs. The existing 56 tests passed. Release checks and private evidence remain outside Git; unrelated quota work is excluded.

## 2026-10-13 — Unified frontend dialogs

- Applied the approved compact white dialog style to application modals and the new-project panel. Role/supervisor tabs now occupy the header directly; draft preservation, existing saves and cancellation semantics remain unchanged. Browser-native confirmations are not replaced.
- Isolated Edge checks covered twelve static dialog types at desktop/mobile sizes, role/supervisor header geometry and pinned actions, history scrolling, native session/file picking and live-scene entries. Regression checks protect inline original-text actions from modal footer styling. The native picker used an isolated Home/Worker with a controlled CLI; no real tasks were started or stopped. All 56 existing tests passed.
- Frontend and documentation changes only. No backend edits, service restart, deployment or push; pre-existing quota work remains separate.

## 2026-10-13 — Unified standalone settings pages

- Extended the approved dialog visual language to Basic Settings, Token Usage, Project Settings and Scheduled Jobs. Global/project tablists now share the sticky title bar rather than a separate row. Full-page layouts, section saves and nested modal behavior remain intact; changes are limited to frontend markup, styles and cache revision.
- Real Edge checks against an isolated Home covered all five global tabs and the three other pages at desktop/mobile sizes. Seeded usage remained 8,000 tokens, project drafts survived tab switches, pages had no horizontal overflow and browsing/querying issued no configuration or dispatch writes. No production services or running tasks were touched; pre-existing quota-statistics changes remain separate.

## 2026-10-13 — Logo transparent container

- Removed the sidebar logo button's legacy gradient backing and corner clipping. The approved raster asset, dimensions and placement remain unchanged; transparent image margins now reveal the page instead of a second colored frame.
- Real Edge verification against an isolated Home reproduced the gradient before the fix and confirmed transparent, borderless rendering afterward, including hover, sidebar toggle and visible keyboard focus. No backend changes, service restart or deployment.

## 2026-10-13 — Scrollable chat bodies

- Kept the existing message-body height while replacing ten-line clipping with internal scrolling. Status refreshes restore each visible message's scroll position by project/message or Run identity; full-screen reading remains unchanged.
- Real isolated Home and Edge checks passed for desktop/mobile wheel scrolling, short messages without overflow, preserved height, reading position after desktop refresh and the final paragraph of a 100-paragraph full-screen reply. No backend changes, task operations or service restart; unrelated quota work is retained separately.

## 2026-10-14 — Compact live message actions

- Removed the redundant routine progress-detail line below live chat bubbles. The role-heading status and typing indicator remain; existing actions follow the bubble directly. Explicit waiting/error reasons keep their existing visibility.
- Verified desktop and narrow-screen rendering in an isolated Home and real Edge browser with a controlled online Worker. No native CLI or production task was launched.

## 2026-10-14 — Structured CLI error text

- Extract text from structured native assistant error messages before recording runtime failures. Error logs, status and automatic written handoffs retain the readable reason instead of an object; the execution still fails when the native CLI reports an error.
- Reproduced the object-versus-string failure, passed focused regression checks and all 56 existing tests, and replayed a recorded authentication error through a real isolated child-process transport and handoff writer. This does not resolve provider authentication; no live service or active CLI was restarted.

## 2026-10-14 — Bounded source-sync receipt recovery

- Treat network timeouts as reconciling, correctly encode cancelled captures and retain late terminal evidence separately from the original operation result. Acknowledgments retire matching delivery entries without rewriting historical results or repeating file writes.
- Select due transport metadata before receipt bodies, recover unready uploads in bounded batches and back off replay. Stop unchanged failed watcher observations from generating unlimited replacement batches. Existing files, journals, sessions and audit reports are preserved.
- Added private regression coverage for upload-response loss, cancellation, terminal disagreement, queue starvation and apply recovery after an earlier idle wait. Real isolated Mac/Linux checks covered two-way saved-file transfer, binary rename/delete, offline Worker restart, conflict preservation and browser document viewing without model calls. Deployment and production resource measurements are tracked separately in private release evidence.
- Recovery can compare a small authenticated proof of an already uploaded terminal result before resending a large manifest. Active captures still require complete blob validation. Status snapshots reuse their existing launch-command index for historical continuations rather than repeatedly rereading the command table; progress results and timestamps remain unchanged.

## 2026-10-14 — Idle scheduler and file-scan CPU

- CPU sampling identified repeated historical task/Run/message loading during idle Home ticks and routine missing-marker exceptions during Worker safety walks. Sparse SQLite indexes now select scheduling candidates, active/unknown Runs, conflict Runs and unresolved recovery records before materializing their bodies. Organizer polling reads the latest conversation ID instead of all message bodies; insertion order, retries and new-message wakeups remain unchanged.
- File capture avoids rejected promises for normal ENOENT checks and reuses the final verified leaf stat. Actual bytes are still hashed and all pre/post-read path, link and descriptor checks remain; synchronization frequency and enabled scopes are unchanged.
- Eighteen focused regressions passed, including old-database index creation/reopen, state transitions, organizer wakeup and path changes during reads. Existing 56 maintained tests and 99 focused scheduling/recovery/conflict checks passed. A fresh isolated Linux Home/Linux Worker/Mac Worker run verified two-way source/document transfer, binary rename/delete, offline recovery, conflict preservation and real browser viewing without model calls. Production rollout and resource measurements are recorded separately in private release evidence.
- Follow-up production sampling identified the same historical-read pattern in missed call-result reconciliation and wait-deadline polling. Both now select only their original pending states through indexes; terminal receipt handling and timeout recovery are unchanged. The additional 44-case collaboration/scheduler regression run and maintained suite passed.

## 2026-10-14 — Cross-device execution design v2.2

- Revised the supplied quick-execution design to require a verified source Run/workspace, immutable code/layout/context identities and native-session binding to the target preparation. It now defines preparation claims, service consumers and lease epochs so environment hand-off does not open an unrelated source copy or close a service still in use.
- Moved resource reservations, directory/space budgets, foreground I/O priority and reference accounting into the first rollout. Added explicit observed-byte/before-after integrity limits, phased single-repository Mac acceptance and 53 acceptance scenarios. Registered the document in both documentation indexes.
- Design-only artifact, structurally reviewed against the current source boundaries. Proposed APIs, capabilities, prompts, budgets and new runtime behavior are not implemented or activated by this documentation change.

## 2026-10-14 — Cross-device design conditional-review revision v2.3

- Revised the canonical design rather than creating a parallel source. F now checks current source bytes before local reuse, defaults to read-only access and routes explicit ordinary-directory materialization through existing sync queues, journals, baselines and receipts.
- Fixed the proposed digest contract to one version with nine byte-level vectors, complete base-to-HEAD plus working-tree coverage, necessary-input limit failures and cached immutable Git identities without weakening actual-directory checks. Added review visibility, preparation-versus-execution credentials, protected inputs, locked dependencies and a minimal registered Q allowlist.
- Clarified single-turn service ownership before consumer handoff support, cancellation replay and all-scope readiness. Expanded acceptance to 68 scenarios and kept design, runtime and bound-repository versions separate.
- Documentation-only revision. Prior conditional reports and runtime failures remain unchanged; this draft requires same-file-hash re-review and is not implementation, configuration, deployment or real device acceptance. Structural/vector checks and repository syntax checks are verification of the document only; unrelated working changes are preserved.

## 2026-10-14 — Cross-device design review clarifications v2.3.1

- Added the five user-confirmed non-blocking Claude review suggestions to the canonical design: accessible source-ancestor base selection without overriding explicit/frozen SHAs; direct Q/F work can precede full P0 resource work while cache writes and S retain their budgets and gates; before/after-only observation is reported honestly; Q wrappers bind check in code and reject stop injection; implementation requires readable exact source and deployment baselines.
- Clarified that p95 targets and the 100 MiB / 5000-file sample conditions are unmeasured performance candidates, not functional limits, timeouts or SLA promises. Kept the digest algorithm and nine vectors unchanged; added A69–A75 for 75 acceptance scenarios and updated both documentation indexes.
- Documentation only. The supplied Claude approval concerns the exact prior v2.3 artifact and does not establish other reviewers' decisions, implementation or live acceptance. No code/configuration changes, role dispatch, push, deployment or service restart; unrelated work remains separate.

## 2026-10-14 — Cross-device P1 implementation planning

- Grounded the first Q/F increment in current Home/Worker/bridge code and the committed v2.3.1 spec. The plan separates direct read paths from cache/materialization and S resource/execution work, with real isolated device/page checks and preservation gates.
- Source inspection found that ordinary CliSessionRecovery.check can automatically reclaim idle drivers and inspect can retire stale records. Planned a separate no-reclaim/no-retire observation path rather than treating the existing check action as read-only or changing its scheduler behavior.
- Written plan is prepared for user confirmation and execution-method selection. No product code, worktree scaffold, live configuration, native process, deployment or Git push was changed by this planning step.

## 2026-10-14 — Cross-device P1 plan review corrections

- Confirmed the existing 1 MiB WebSocket caps and disconnect/reconciling path against the exact daacf7403976ccf338052cd91a65d7b4ed17f1f2 source objects. Arithmetic probes showed 600000-byte quoted/control text expands beyond the cap; no production connection was used.
- Revised the plan to budget complete serialized file replies at 512 KiB, use checked metadata/error fallback and cover existing file previews as well as new Agent reads. Clarified durable same-requestId result/observedAt replay, new IDs for fresh observations, bounded private result storage and authorization checks.
- Fixed the full starting code SHA and distinguished approved documentation handoff from product baseline and unrelated WIP. Added owning regression/device/browser checks. Documentation planning only; no runtime defect is claimed fixed and product implementation remains gated on plan confirmation.

## 2026-10-14 — Cross-device P1 plan approved

- The user approved revision 2 and sequential inline implementation. The product baseline is daacf7403976ccf338052cd91a65d7b4ed17f1f2; the approved plan is carried in a separate documentation-only commit before code work.
- Q/F will add pure observation, bounded complete replies and owner-scoped durable replay. Cache fill, materialization and S execution remain later increments. Existing uncommitted frontend/quota work is not copied or changed; no production configuration, deployment or restart is included.

## 2026-10-14 — Cross-device P1 code and initial transport verification

- Added fixed query schemas, registered physical-source identities, pure indexed native observation, stable current-source reads and complete-frame size protection. Home enforces live identity, explicit grants and source-aware independent-review visibility; request results persist with bounded reservations and unchanged original timestamps.
- Connected managed wb commands, immutable-turn context, negotiated Worker capabilities and bilingual help. No source synchronization, formal Git gates, tasks, reports or user files are modified by these reads.
- Focused checks and the maintained suite passed. An isolated actual Home/Mac Worker/wb bridge exercised new reads, original-result replay, changed bytes, oversized escaped-file previews and an unchanged concurrent test Run. Linux/page/whole-branch review remain the final gates. No push, deployment or existing-service restart.

## 2026-10-14 — Cross-device P1 isolated acceptance and final review fixes

- Completed actual private Mac/Linux dual-direction wb/Worker checks, managed-worktree dirty-file reads, missing/replaced directory and generation checks, offline-original replay and real browser Resources/document previews. First acceptance used clean code commit 06dd33fb85b89290549de455891ff415b1b3e7a9. Added an actual isolated Home restart, expected startup reconciliation and persisted-result replay; source-module hashes were unchanged with only documentation edits pending. No paid native-model turn or production service was used.
- One independent whole-branch review found a nested-project scope leak through a parent repository and a legacy unique-Run query that still scanned role history. Both reproductions failed before the fix and passed afterwards; known excluded paths now stop before Worker dispatch, and real SQLite EXPLAIN uses the Run primary key without a temporary sort. Focused checks 31/31, maintained suite 56/56, syntax and whitespace checks passed.
- Final twenty warm local F samples measured median 187.58 ms/p95 191.99 ms; short process CPU/RSS samples are recorded separately from sustained idle/peak-memory and production acceptance, which were not performed. Existing concurrent test Run/process, source-sync state and reports remained unchanged during reads. Other-worktree frontend/quota modifications were retained.
- P1 is committed and isolated-verified, not merged, pushed, deployed or enabled on business projects. The approved v2.3.1 design hash is unchanged. Cache/materialization, full shared-resource management, S execution and cross-round services remain later implementation gates.

## 2026-10-14 — Reply sender and explicit multi-recipient routing

- Web replies prefill the original agent unless the draft already has explicit recipients. Stored sender identity resolves old names and legacy Run-backed messages; replying to a human is a quotation only. Unsent text survives reload and changing/cancelling a quote without removing manually chosen recipients.
- Multiple explicit mentions create one task per distinct named role, not a supervisor evaluation. Validation and message/task creation remain atomic; retries retain the same tasks, announcements remain notification-only, and busy roles keep their existing queue and native-session ownership.
- Twenty-three private routing checks passed after failing reproductions, with all 56 maintained tests green. Real English and Chinese browser pages against an isolated Home verified auto-mention, drafts, explicit override, separate targets displayed and persisted, human quotations, and discussion-specific replies. No Worker/vendor turn or production task was started. Cross-role Git handoff checks and paused-dispatch gates remain enforced.
- Independent review findings were reproduced and fixed: transfer metadata is per recipient, aliases count once, discussion drafts honor explicit mentions without answering the original thread, and cancelling a quote preserves manually retyped mentions. A related message-first discussion display crash was reproduced in the browser and fixed without changing task state.
- Feature branch only, not pushed or deployed. Original history, current native processes and other-worktree quota/frontend modifications were preserved.

## 2026-10-14 — Integrated local branches and pending UI changes

- Integrated the current GitHub main, reviewed cross-device P1 reads, reply/multi-recipient routing and daily model usage chart into the publication branch. Previously squash-integrated or superseded older branch behavior was checked rather than replayed over newer fixes. Source branches/worktrees and the original pending-change snapshot remain available.
- The user explicitly included the pending frontend, quota and documentation edits. Retained their compact visual style and newer per-date model aggregation, consolidated the alternative model charts into one, kept the current approved P1 plan and preserved the earlier planning progress entries.
- Independent integration review identified an outdated empty-chat routing hint, a missing zero-usage state and a duplicate translation. The first two were reproduced in the real isolated browser before minimal fixes; the final page also retained the selected sidebar state and title-bar tabs. Existing histories, reports and synchronization records were not rewritten.
- Node 22.22.1 verification passed 56 maintained tests plus 60 targeted read/routing/token checks, syntax and whitespace gates. Actual isolated Home/Edge checks covered English/Chinese reply routing, model totals/remainders, empty states, five settings tabs and desktop/mobile layout. Private test scripts/data/screenshots remain ignored; no vendor-model turn or production task was launched.
- This integration does not deploy or restart any service, enable Q/F on business projects, or implement the separate automatic dependency-preparation proposal. Publishing source and accepting a live runtime remain separate operations.

## 2026-10-16 — Sidebar execution emphasis

- Added static blue shading, fine borders and soft shadows for executing group chats and exact native sessions. Selected rows remain distinct; historical running sessions are indicated in the expandable history entry. Queued, waiting, offline and idle states are not labeled as executing.
- Compact cross-project activity metadata reuses the existing state feed; no new polling, model calls, continuous animation or history rewrites. Native identity matching includes device, runtime and session ID.
- Focused projection tests and real isolated Home/Edge checks covered unselected projects, exact native matching, selected styling, history expansion, completion updates without catalogue refetching and mobile layout. The maintained suite passed 82/82. This change is not deployed and does not restart production services.

## 2026-10-16 — Parallel-chat and team-copy design

- User selected a parallel new group chat while retaining the original usable chat. Added the proposed specification in `design-parallel-conversations.md` and registered it in the documentation index.
- The proposal separates fresh conversation/native context from shared project files and roles, preserves workspace/process locks, and defines team-only copying into empty new project workspaces. Full specification review and the implementation plan remain pending; no application code, runtime configuration, histories or running tasks were changed by this documentation step.

## 2026-10-16 — Parallel-chat and team-copy implementation plans

- The user approved the specification by asking to continue development. Split execution into two independently testable plans: conversation/context isolation first, then configuration-only project copying with strict directory ownership and retryable readiness.
- Self-review clarified group ownership versus existing source-isolated native partitions, mixed-version Worker capability checks, empty/custom prompt preservation, and the ambiguous mkdir-before-marker crash boundary. Plans include targeted failing tests, compatibility gates, real-browser/native acceptance and independent final review.
- Implementation-plan review and execution-method confirmation are still pending under the planning workflow. This step changes documentation only, not source behavior, live configuration, history, files in business projects or services.

## 2026-10-16 — Parallel chats and team-only project copy implemented

- Implemented both approved actions through native execution. Parallel chats retain shared project folders and role configuration while isolating messages, Tasks, Runs, summaries, native-session identities, handoffs and derived collaboration. Team copying freezes exact allow-listed configuration, uses new IDs and strict owned-directory preparation, and publishes the team only after every required device is ready. Existing histories and project files are retained.
- One independent whole-branch review identified five important gaps. Added failing regressions and corrected CLI-switch prompt history scope, setup-catalog task/proposal scope, setup notice routing, selected-project deletion recovery and scheduled-job sibling-chat navigation. The final maintained-plus-focused Node test run passed 121/121 reported test executions (including imported fixture tests), with npm ci, syntax and whitespace checks passing.
- Actual isolated Home/Edge verification covered desktop/mobile navigation and copy UI, blank/duplicate input, drafts/reload, delayed old replies, stale responses, source order preservation, offline retry, independent copied-role edits, and exact copied settings after language refresh and Home restart. A real local Codex branch used a distinct native identity after the original Run completed; all four adapters passed deterministic captured-input checks, but only Codex had actual model startup verified for this feature.
- Real isolated Mac/server Workers completed the same copy operation after one device disconnected and reconnected. Both destination business folders contained only the ownership marker and two bootstrap instruction files; no Tasks, Runs, repository clone or dependency installation was created by the copy. The production Worker PID remained unchanged. The earlier failed test environment attempt remains in ignored evidence instead of being rewritten as success.
- Documented shared capacity/CLI-switch constraints, project-level source-sync conflicts and copied-preset behavior. This is local implementation and isolated acceptance only: no GitHub publication, production deployment, business-project activation or production service restart.
