# Minimal Injection and On-demand Collaboration

**Status:** Unified implementation and isolated four-CLI/native/cross-device acceptance are complete for the tested combinations below. The verified change has been selectively installed and restarted on a macOS Home/local Worker and an existing Linux Worker, excluding unfinished source synchronization. Original roles, histories, native session associations and manual terminal reservations were preserved; no shared-branch push or merge occurred. The local Agy environment remains unverified because its provider rejects the location.

Both deployed Workers advertise the minimal-instruction protocol. Each release copy passed 13 existing and 37 targeted checks plus the real rolling-protocol test; the live page passed logo and quota-detail checks. The post-rollout cross-device native smoke could not start because two existing prepared terminal takeovers reserved both configured remote CLI slots. Its queued test request was cancelled and its isolated project removed without releasing those reservations. These deployment checks do not replace the adapter-specific native evidence below or establish business acceptance.

This is the design authority for this change. Current execution and rolling compatibility paths are documented in ARCHITECTURE. Unified implementation is specified in [plan-minimal-injection](plan-minimal-injection.md).

## 1. Intent and preserved boundaries

Workbench owns collaboration facts, tools and durable state. The native CLI owns execution strategy. Normal turns do not have to plan, enumerate the team, delegate or run a fixed review sequence. Explicit user requirements, including reviews, tests and approvals, remain binding.

Only identity, saved execution instructions, the current assignment and necessary task-scoped new events enter normal execution. Team facts and operating methods move to queries and on-demand tools/skills only after those entries work. Responsibilities select collaborators; they are not instructions for the role that owns them.

Keep existing roles, platform history, user-authored prompts and native sessions. Ordinary prompt updates must not create a new native session, add a handoff or call the model to confirm configuration. Do not bulk-edit custom prompts, infer responsibilities from names, weaken directory/authorization gates or equate process completion with business acceptance.

## 2. Four layers and one authority per item

| Layer | Content | Delivery |
| --- | --- | --- |
| L1 | Trusted platform/role identity and user-saved role prompt | Adapter's instruction channel |
| L2 | Current task, necessary prior task facts, newly relevant external events | Incremental turn input |
| L3 | Team/responsibilities, device state, task state, history and handoffs | WB query tools |
| L4 | Source synchronization, deployment and specialist review methods | Existing native tools/skills, on demand |

The minimal platform text identifies WB and the role, and says that collaboration tools are available as needed. With the current shell-based entry, it also includes one short discovery entry: `wb help`. Keep the current turn-specific invocation prefix where needed to load the correct tool environment. Neither sentence tells the CLI to query the team on every turn.

Do not add a dynamic tool-search framework or a new skill-loading protocol. Native terminal/file/search capabilities are not rewrapped. Skills have one maintained body; adapter registration descriptions stay short. Include essential directory restrictions or target mappings that the CLI cannot otherwise know, not the full device/repository inventory.

## 3. Migration register

Each migrated item records its original location, target, existing/missing capability and acceptance scenario. Nothing is removed merely because a shorter prompt looks better.

| Original location/content | Target authority | Required acceptance |
| --- | --- | --- |
| Platform defaults: identity and tool discovery | L1 instruction assembly | Correct role/run identity; natural tool discovery |
| Automatically injected team roster/status | Project team query | Complete project membership across devices; offline/disabled members retained |
| Project-wide backlog, unrelated group messages and repeated results | History/session tools | Current assignment, explicit references and required new events preserved |
| Default planning/delegation/fixed review instructions | Remove platform defaults only | Simple work completes without forced planning/collaboration; custom requirements unchanged |
| Synchronization/deployment/review manuals | Existing skill/help/tool body | Relevant method is discoverable and usable before its wrapper is removed |
| Delivery/retry/wait/cancellation/ownership rules | Existing program state and tool result | Durable IDs, no duplicate execution/resumption, cancelled work never revived |
| Business report requirements for actual delivery | Existing report/acceptance gate | Waiting is not a final delivery; process success remains separate |

User-saved custom platform, supervisor and role text is preserved, even if it repeats a platform default. Only exact maintained defaults can migrate automatically. Do not modify a custom value on save, resume or startup.

## 4. Discovery is a release prerequisite

Use the existing `wb discuss peers`, catalog and help entries. The basic project-team response includes stable ID, display name, responsibility, enabled/configured/archived status, device, availability/reason, query time, directory version and completeness. Do not include peer execution prompts, credentials, detailed model settings, recent messages or whole execution histories by default; details remain queryable separately. Preserve the existing caller-duty exclusion.

Offline, busy, disabled and temporarily unavailable roles still exist. Archived roles are distinguishable and their history remains queryable. A failed query is an error, not a successful empty list. If paged, identify incomplete results and provide a continuation entry. Project scope is enforced by the server, not supplied by the model.

For each CLI, use a fresh isolated session with neutral role names and no roster, tool command, recipient ID or procedural hints in the task. Ask it to find the teammate responsible for a stated capability and obtain a real answer. It must discover the entry, query the full project team, choose by responsibility and actually contact the correct role. Run three controlled attempts against the installed CLI/model combination and record all outcomes, not just the successful one.

Zero prompt does not mean zero discoverability. The minimal L1 `wb help` entry is allowed. If a CLI fails discovery, add one adapter-specific short hint naming the team entry, then repeat the same scenario. Retain the old injection for an adapter that has not passed; do not remove the roster globally and hope it works. Verify local and remote execution independently.

## 5. Identity is bound by Worker and checked by Home

Current managed execution already has a per-Run Worker file bridge. Worker sets `WB_RUN_ID`, the role/session/project environment and a current-turn context file. The bridge overwrites the outgoing Run ID with its trusted Run and rejects a different supplied Run ID. Home authenticates the Worker channel, checks active Run state and derives the sender role, project, session and associated task from persisted Run records.

Keep this chain. Explicitly reject sender/project/owner impersonation fields rather than accepting a model-supplied identity. A recipient identifier is input; sender identity is not. Cover copied old environment, changed warm-process turn context, ended/cancelled Runs and cross-project targets. CLI children must not receive Home/Worker control credentials.

This is a managed-tool identity guarantee in the existing trusted-operator architecture, not a new sandbox against arbitrary processes on the same machine. Do not introduce a second authentication or control-plane system.

## 6. Requests, waits and timeout recovery

Keep notification, consultation and delegation distinct. Notification changes no owner and does not wait. Consultation obtains information without moving the parent owner. Delegation records a child owner and its parent. Request creation returns a durable ID and accurate state; accepted, delivered, running and answered are different facts.

Sending a consultation is not waiting. A CLI can create several requests and continue independent work. It calls the wait operation only for dependencies. The tool may then give a short operation-specific end-turn instruction; no permanent protocol manual is injected.

Every new wait stores an explicit dependency set and persisted deadline. The initial default is 30 minutes, with a per-wait override from 60 seconds through 24 hours. This is a wait deadline, not a CLI-process execution timeout. Preserve historical waits without retroactively imposing a new deadline.

On expiry, atomically record one task-scoped `wait_timeout` event with request IDs and latest dependency state. Resume the parent only when its previous turn and tools have settled and the normal authorization, capacity and cancellation gates permit it. Home restart/repeated scans cannot create a second continuation for the same wait generation.

Timeout does not fail, cancel or replay a teammate's running task. The parent learns that no answer is available yet and chooses its next action. Original dependency IDs survive the timeout continuation, and that continuation can wait on them again without creating new teammate work. A late answer routes to the current effective request/wait of that same continuation chain. An unavailable/archived recipient is a recorded dependency failure, not an empty answer. If the parent itself is unavailable or paused, keep the event pending and visible rather than claiming it resumed. A deadline/reply/cancel race permits exactly one continuation for a wait generation. A reply during the resumed round remains discoverable and is consumed by its next explicit wait or result query rather than interrupting it or starting an unrelated task.

Reuse the existing request/continuation state machine and scheduler. Add only the wait deadline, retained dependency relationship and deduplicated recovery event needed by acceptance, not a general rewrite. Explicitly verify timeout, resume, re-wait on the original request and receipt of its original answer. Tool-level transport timeouts remain separate from business wait deadlines.

## 7. Configuration at actual execution admission

Historical task/role snapshots remain audit records. At Worker admission, resolve the latest saved role execution prompt and platform/supervisor configuration, version them separately and persist an immutable instruction snapshot for that admitted turn. Do not use a queue-time role prompt merely because the execution binding is frozen.

Freeze immediately before preparing native instruction delivery, after a real slot is reserved. This covers Home queues and Worker-deferred launches. Retries of an admitted turn reuse that snapshot; edits while executing affect the next turn. Binding, role ID, workspace, original task, native session and authorization are not rewritten by a prompt refresh. Report a failed fetch/start/resume; do not silently fall back to stale instructions.

Record saved configuration separately from the version actually applied by Worker. No model recitation or extra confirmation call is added. Prompt versions do not depend on busy/idle team status. Current Run/tool environment is refreshed independently of instruction equality.

| Adapter | Required behavior |
| --- | --- |
| Codex | Use `developerInstructions`; current task through `turn/start`. Keep reliable exact-thread recovery and per-turn environment rebinding. On a changed/cleared component, append one native developer configuration event before the ordinary turn, not an extra model turn. Unchanged versions are not appended. |
| Claude | Use appended system instructions, never replace the native system prompt. Unchanged configuration reuses the idle process; changes retire it after settlement and resume the same native session with new parameters and one configuration event. Keep snapshot-off behavior. |
| Grok | Each process reads the latest rules and resumes the original native session through `--rules`; changed/cleared components also receive one configuration event. No ACP migration or permission/`--no-plan` change in this work. |
| Agy | Keep the original native session. Unchanged versions are not repeated; changed parts are delivered in full with replacement semantics; clearing explicitly revokes that custom requirement. |

The operator approved the Codex compatibility event after installed-version native testing showed that cold resume accepted `developerInstructions` but the model retained old instructions. An ordinary user-level update did not supersede the old developer instructions. Use the installed native `thread/inject_items` entry to append only the changed complete component or explicit revocation at developer authority. New native sessions use their initial instructions without this redundant event; pre-event sessions receive one migration event. Record acknowledgement separately from turn success, preserve exact session ID and fail truthfully if the native entry is unsupported. This does not edit native rollout files, add a configuration-validation model call or alter native global settings.

Native testing also reproduced stale replies after Claude/Grok parameter updates. The operator explicitly approved the same once-per-change/revocation compatibility event for both. Keep their normal appended-system/rules channels and add the complete changed component to the ordinary turn's input as a configuration event; do not add a model turn. Unchanged successfully delivered versions are suppressed, and new sessions need no duplicate event. This is a message-based compatibility path, not a claim that history has been erased or that an old system snapshot was rewritten. Audit the event separately from the original task.

Installed Codex testing separately reproduced stale shell environment on a retained loaded thread, even though resume accepted new overrides. On the minimal path, release the settled thread subscription before reloading that exact ID with current Run/tool environment. Keep the App Server process and native history; no new model turn or native session is created. A successful developer-event append acknowledgement is recorded independently, so a later turn failure does not duplicate the acknowledged same-version event.

## 8. Agy updates retain the original session

A message saying "replace the old rules" cannot remove those rules from native history. The operator explicitly accepts both possible old-rule interference and the context cost of update messages. Do not claim equivalence to a native system-instruction replacement or add mitigation the operator has rejected.

At actual admission compare platform and role instruction content versions independently with the last successfully delivered versions in the same native session. A new session gets identity/current instructions. An unchanged component is not sent again. A changed component sends its complete new value and identifies it as replacement of its old version. An emptied component sends explicit revocation. Do not make the CLI assemble a diff. Multiple edits during a running round collapse to the latest saved values next round.

Necessary process retirement resumes the same native ID; there is no automatic new-session, extra handoff or model verification step. Mark instruction delivery only from actual adapter success; uncertain or failed delivery must not be treated as inheritance. Unknown/missing native history uses the existing truthful recovery error, not a silently new session.

Keep ordinary prompt updates separate from the existing explicit cross-CLI handoff. Current-turn tool environment and message-level instruction inheritance are checked independently.

## 9. Baseline and comparison

Capture before any product change: installed CLI/Worker versions, language, task category, native reuse mode, actual instruction and dynamic-input characters/UTF-8 bytes, unique native tool calls, WB requests, latency, extra configuration-validation model calls and cooperation outcomes. Keep private execution evidence in ignored directories.

Exact injected tokens require a tokenizer or runtime field with a documented matching scope. If unavailable, record them as unknown and use measured characters/bytes for exact size comparison. Native total input usage includes native instructions and history and may be cumulative; cached input is not uncached billing. Never derive an exact WB injection number or billing saving from it.

Compare matched isolated tasks before/after, with the same CLI/model, language, initial state and user instructions. Count successful cooperation only when the intended recipient was found, contacted, replied and the parent consumed that answer; report failure and pending counts with the denominator. Reported `passed`, process exit and independent business acceptance are separate metrics.

Existing event logs have been sampled read-only as a historical baseline. Their results are descriptive only, not a matched experiment or an established success rate. No percentage saving is promised.

## 10. One unified delivery, ordered internally

Develop measurement, compact/discoverable team queries, identity binding, latest-configuration snapshots, all four instruction adapters and reliable original-dependency timeout recovery in this work. Implementation may follow dependencies internally, but it is not two releases. Each CLI has its own acceptance evidence; one passing adapter never stands in for another.

Gate minimal injection by compatible Home/Worker protocol, not an unversioned global flip. Old Workers retain their existing input contract. If an already-admitted new-contract launch meets a downgraded Worker, retain the immutable input and report the protocol wait; do not send it or silently rewrite it. A compatible Worker can continue that original launch. Test simple autonomous work, no-hint collaborator discovery, current team facts, answer/timeout/re-wait continuation, unchanged/changed/cleared/queued configuration, process restart/resume failure and authorization/data protection separately for Codex, Claude, Grok and Agy. Preserve explicit quotes, user decisions, task-scoped replies, attachments, delivery versions and CLI handoffs.

Only after actual native and cross-device acceptance may the unified change be selectively released. Written code, local tests, commit, push, deployment and native/business acceptance must be reported separately. Do not deploy the other unfinished features on the development branch as a side effect.

## 11. Observed acceptance boundary

These are isolated real Home/Worker/native-CLI tests, not business-project or production acceptance. Each adapter passed simple autonomous work, its own three fresh-session directory/contact/answer attempts, changed/unchanged/cleared/queued-final configuration, process restart and truthful missing-history failure. The four adapters also completed real remote-to-local consultation with timeout, same-session continuation, re-wait on the original request and consumption of its late answer. Each workflow created only one peer request and one peer Run.

| Adapter | Tested combinations | Additional observation |
| --- | --- | --- |
| Codex | Local 0.157.1 and remote 0.161.0, `gpt-6-sol` | Local retained-process probe read environment A, then B in the same native thread; developer update/revocation actually changed replies. |
| Claude Code | Local 2.1.283 with the existing MiMo backend; remote 2.1.293 with Haiku | Local results do not stand in for Anthropic. Remote change/unchanged/replace/clear events separately passed in the original native session. |
| Grok | Local 1.0.50 and remote 1.0.46, `grok-4.7-build-fast` | Native replacement/revocation replies passed locally and remotely. |
| Agy | Remote 1.3.2, `gemini-3.8-flash-low` | Same-session updates and three fresh discovery attempts passed. Local provider returned `FAILED_PRECONDITION: User location is not supported`; that environment is uncovered. |

All three discovery attempts per adapter located the directory without a tool or recipient hint in the task and consumed a fresh real reply. The common short L1 help entry was present. Earlier stale-configuration probes, an Agy cached-answer trial and a remote Codex discovery stall are retained as failures in private evidence, not silently removed. One final Agy discovery attempt required transport reconnection: the original peer completion had stayed in Worker storage and was replayed, with no new peer Run. The first cross-device assertion script used a scrubbed public-state field; a separate read-only audit of its original persisted workflow proved the four chains rather than pretending that script passed.

Targeted regression suite: 37/37; existing suite: 13/13; role-context compatibility: 7/7. Syntax/diff checks, live Home/WebSocket downgrade-to-upgrade replay, and isolated browser checks passed. Browser checks covered offline definition edits and binding retention, persistence, separate duties/prompts, mobile layout, and English/Chinese configuration-event rendering. One independent review raised four material findings; each was reproduced and fixed with a failing-then-passing test. Later native compatibility fixes were verified by the author, not a second independent review.

Matched simple tasks measured new WB transport only; native history remained and billing was not measured:

| Adapter | Previous WB UTF-8 bytes | Minimal WB UTF-8 bytes |
| --- | ---: | ---: |
| Codex | 13,838 | 1,717 |
| Claude | 13,845 | 801 |
| Grok | 13,939 | 799 |
| Agy | 13,663 | 1,403 |

The Codex after measurement includes a one-time migration event. All eight matched simple runs used zero native tools. Exact injected tokens and subscription savings are unknown; no percentage claim follows from these bytes. Daily configuration changes add no model-confirmation round. Private measurement records retain version/model, character counts, elapsed time, outcomes and failed attempts.

Publication/deployment is still separate. The development branch also contains unfinished source-sync work, so these results do not authorize merging or publishing the entire branch. Selective release must preserve that exclusion and the local Agy limitation.
