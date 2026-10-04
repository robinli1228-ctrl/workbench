# Cross-Device Handoff and Continuation of Role Sessions

Status: **proposal. Not implemented and not deployed.** The direction is agreed in principle; the written design still needs review. Nothing in this document describes a feature that exists in the current code.

## 1. Goal and boundaries

In the same project group chat, a user moves a role from server A to server B and continues the original task. The chat, confirmed decisions, open questions and the source of results are kept, and the user does not have to explain the whole task again. The role identity does not change, and at any moment only one device is the active executor.

The proposal is "platform session continuity, native session handoff per device". It does not copy vendor session databases, login credentials or whole user directories, and it does not promise to restore all internal CLI context, reasoning caches or identical token consumption. Native session migration, hot migration of a running process, dual-Home primary/standby and automatic failover are out of scope.

In the first version the user picks the target device manually, and the CLI, model, effort and role duties stay the same. If the target lacks the original configuration the switch is rejected; no silent change of model or vendor. It opens first for Codex after a two-device round-trip acceptance; other adapters open only after their own real acceptance, and an existing interface does not mean support.

The Home remains the only state center and the current deployment shape does not change. The switch cannot complete while the Home is offline. If the source device is unreachable and its process or latest file state is uncertain, the takeover is refused: "no heartbeat" is never interpreted as "already stopped". The first version also offers no forced offline takeover.

## 2. Code it builds on and reuses

- `role-sessions.mjs`: a change of device, runtime or directory is currently rejected for reuse. The native identity protection stays; a controlled handoff entry is added and no check is removed.
- `worker.mjs` and `terminal-resume.mjs`: confirm the process, the workspace and the local native history; they continue to be used for same-device resume. The new device must not carry the source device's `nativeSessionId`, `resumeWorkspace` or old bridge paths.
- `run-context.mjs` and `session-tools.mjs`: reuse the existing shared context, the versioned paged original text and role-result queries; "please summarize" never replaces exact evidence.
- `role-calls.mjs` and `role-discussions.mjs`: keep consultations, the current question, budgets and pending continuation relations. A controlled device switch must not be implemented by cancelling a whole business chain.
- `git-delivery.mjs` and the existing attachment transfer: reuse fixed-commit and file transfer. A migration implies no Git commit, push, merge or deployment authorization.

This document is the only detailed design for controlled cross-device handoff. Ordinary "restart the session", manual device edits and CLI changes keep following the existing rules. The delivery-invalidation rules of the role-conversation design do not automatically extend to this entry.

## 3. Product interaction

The role session menu gains "Switch execution device", with the same entry for the supervisor and for worker roles. It shows the current device, the target device, compatibility, task waiting state, and the versions and files to be transferred, and states clearly that "the target will create a new CLI session, and the platform history is kept".

- If the role is executing, taken over by a human, in an exclusive operation or reconciling, only the reason is shown. The user first waits for it to end or stops and reconciles through existing entries, and then clicks switch. The button never kills a process by itself.
- A turn that has ended but still has child tasks or answers pending may be pre-checked; `waiting_call` or `waiting_discussion` alone does not forbid it.
- The pre-check is read-only and changes no dispatch. After the user confirms, a handoff barrier is established. New messages are still stored in the meantime, shown as "waiting for device switch", and are sent to neither side.
- On completion the group chat shows one system record: source device, target device, handoff version, what was inherited, and the boundary of native context that was not restored. It is not disguised as an agent reply.
- A failure shows the concrete reason and whether the original device is still current. The same operation ID can be queried and retried. Cancelling does not delete already transferred files or history records.

## 4. Identity and the minimum new state

`projectId`, `conversationId` and `roleId` do not change. The existing role-session generations are used: the source role session keeps its history and leaves the current binding, and the target gets a new role session recording `predecessorSessionId` and `handoffId`, with an empty initial `nativeSessionId`. In a round trip A, B, A a new native session is also created on the target, and the earlier forked context on A is not resumed directly.

A `sessionHandoffs` record is added to the existing SQLite records; no new database or message bus. Core fields:

- `id`: a client-generated stable idempotency ID. The same ID with different request parameters returns a conflict.
- `projectId, conversationId, roleId, sourceSessionId, targetSessionId`.
- `sourceNodeId, targetNodeId, expectedRoleRevision, sourceGeneration, targetGeneration`.
- `status, checkpointId, manifestHash, sourceWatermark, sourcePrepareAck, error, createdAt, updatedAt`.
- `targetWorkspace` and the verified repository and attachment mappings. No authentication secrets are stored.

A role has at most one unfinished switch operation. The session generation serves as the execution-binding version; each commit takes the maximum historical generation of the role plus one, and switching back does not reuse an old generation. Worker start commands and state changes must be associated with `roleSessionId + generation + runId`. No second lease that expires and preempts automatically is added.

The status goes `preparing`, `prepared`, `committed`; before commit it can become `blocked` or `cancelled`. `blocked` keeps the original binding and the error. After the Home verifies that the source Worker's durable barrier has been lifted, the original device may work again under the normal flow. If the result of lifting is unknown it stays in reconciliation and is not released by timeout. A retry must freeze, collect and verify again and cannot use an expired prepared snapshot.

## 5. Switch order and commit point

1. In one transaction the Home checks the source session, the role revision, the device capability and the current run, and sets a role-level dispatch barrier. A repeated confirmation returns the same operation and does not start another switch.
2. The source Worker confirms there is no active or unknown process and no human takeover, closes the idle warm process of the session, persists a barrier for this `handoffId` that forbids driving the session again, and then returns `sourcePrepareAck`, the finished runs and the corresponding event watermark. The Home must already have received those events, and the role must have no unreconciled launch in flight. Other roles of the whole node do not have to be idle. If the acknowledgement is lost, the same operation is reconciled; completion is never inferred from a timeout.
3. A fixed handoff snapshot is created. The source repositories and relevant files are inspected, and commit IDs, file checksums and the platform's original-text version are taken. The target Worker starts no model and only prepares and verifies the workspace.
4. The target has the same CLI, model and effort, a valid login and the required tool capability. Fixed commits and clean state are verified per repository and checksums per file. The compatibility check cannot just look for the CLI binary.
5. Before commit, the Home checks again that the source execution is still finished, that the role, direction and question revisions are not stale and that the target preparation result has not changed. In one transaction it creates the target role session, links the handoff package, updates the role's device and archives the source session, and it hands over undispatched execution bindings and waiting deliveries that qualify under section 7. For the supervisor it also updates the project's `supervisorNodeId` and the current supervisor configuration in the same transaction, not just the role card.
6. After the commit the Home dispatch barrier is lifted and only the target device receives the next turn. The source Worker's durable barrier turns into "old generation revoked" and no longer lets the source session run. Even if the source has not yet received the commit notice it is still bound by the confirmed prepare barrier. Before the target actually starts, the binding version, workspace and native identity are checked again; the first start only creates a new native session, and later turns on the same target resume it.

A failure before commit leaves the source binding unchanged. Even if the source warm process has been closed, it can still be cold-resumed on the original device with the original ID. Files prepared on the target are kept for inspection and existing files are never overwritten or deleted.

If the target is offline after the commit, the target ownership is kept and work is queued; the original task is never automatically sent back to the source. A start failure shows the failure and its reason and is not blindly retried as-is. To switch back, use another explicit switch after verifying whether the target has already accepted or executed the instruction.

## 6. Handoff package and files

Each handoff produces exactly one versioned package, stores content hashes and sources, and does not require calling a model again to generate a new summary:

- The original instruction of the current task, the role duties and the platform rule version, ongoing constraints, confirmed decisions and unfinished items.
- The actual result, acceptance status, errors and unconfirmed side effects of the most recent finished runs. Execution finishing and business acceptance stay separate.
- The IDs of pending calls and questions, the current question round, the direction revision, answers already received, the continuation position and the budget already used.
- Each repository key, the source and target path mappings and the exact Git SHA, plus the checksums and readable locations of required attachments and documents.
- The existing summary and its coverage boundary, and the full paged entry to original text that is not covered. If there is no summary, the original-text directory is used; unread content is never written as "inherited".

The new device's first turn must actually receive the handoff package. The optimization of inherited context cannot omit it because the source device once received the same summary. That first turn is still subject to the normal context limit, exact requirements and evidence are read through the original-text tools, and it is not claimed that all history is stuffed into the model at once. After that the normal incremental context strategy resumes.

Code is transferred only as committed versions. Uncommitted business changes or non-ignored untracked files block the switch and the user is asked to handle them first. Only runtime temporary files that the platform clearly owns are excluded; `.workbench` as a whole cannot be excluded because documents would be lost. An existing authorized delivery can be reused; without a delivery nothing is pushed to a remote branch automatically. If the target lacks the fixed commit and it cannot be obtained through an existing approved transfer, the process stops at pre-check or preparation and "the latest branch" is never substituted.

Files referenced by the handoff must really be reachable. An absolute path on the source machine is no evidence that the file exists on the target. Each item is mapped and checked against the version of the original text. There is no global path replacement in chat text, and the whole project, ignored files or credential directories are not packaged automatically. If the target already has changes or a same-name file with different content, the switch blocks instead of overwriting.

## 7. Waiting, replies and late events

Pending Tasks and calls keep their original IDs, task requirements, business owner and direction. Commands and runs that were already dispatched and their `roleSnapshot` are not rewritten. The handoff uses a separate `executionBinding` to explicitly change the device of the next turn, and the new run records both the original request snapshot and the actual execution binding. Scheduling must not send the work back to the source device because of the old `task.roleSnapshot.nodeId`. The first turn after the handoff is linked to the source run and the task only through `handoffId`, and a cross-device source is not put into `continuationRunId` or `resumeWorkspace`, which are for same-device continuation only. Later continuations in the same generation follow the original rules.

A controlled handoff may rebind only deliveries and pending continuations **for which no execution command has been sent yet**, after checking that the role, question ID, direction, authorization and capability are still valid. The original message identity, discussion budget and resolved state are kept, and the bindings before and after are recorded. Deliveries already completed are not rewritten, and a command that was sent cannot be treated as an unclaimed message and rebound.

An answer-consumption or business turn that has already been claimed or has entered the runtime must first complete the result and wrap-up check of the original turn. Unknown side effects or an exception awaiting manual confirmation block the switch. Only the not-yet-dispatched continuation generated after its normal wrap-up may be handed over. An old reply is never replayed to the new session to "consume it again".

Replies arriving during the barrier are still persisted in the original question, and the commit transaction reads the latest question state to avoid claiming twice. A change that only adds messages can be included in the new version; a user's change of direction, a cancellation or a key revision invalidates the prepared result, so the commit condition is withdrawn first and the pre-check runs again. A late reply to Q1 cannot release the wait on Q2.

Late events from the old device are kept as history under their original `runId` and `seq` and acknowledged. They must not release the target session lock, overwrite the target's current state or create a second continuation. If an event shows that the old generation still has an actually active process, a control conflict is recorded and later starts of the role are paused; it cannot just be ignored as ordinary history. The Worker records locally the revoked driving right of the source session and reconciles with the Home on reconnect before running.

The existing `/session/reset` stays for explicit restart and does not carry handoff. Its protections must not be bypassed by cancelling all collaboration calls or modifying historical runs.

## 8. Interfaces and code placement

Proposed project-scoped role interfaces:

- `POST .../roles/:roleId/handoff/preview`: takes `targetNodeId` and returns compatibility, blockers and a preview version without changing state.
- `POST .../roles/:roleId/handoffs`: a stable `commandId`, `targetNodeId`, `expectedRoleRevision` and `previewVersion`. It returns the persisted operation, which advances in the background.
- `GET .../roles/:roleId/handoffs/:id`: query the stage, evidence and error.
- `POST .../roles/:roleId/handoffs/:id/cancel`: cancel only before commit. After commit a reverse switch must be started instead.

All interfaces verify the project and role ownership. Ordinary agents get no permission to migrate a role themselves, and the first version is started from the user's page. A Worker that does not declare the handoff capability is refused and never downgrades to deleting and rebuilding the session.

Main touch points: `role-sessions.mjs` (generation and ownership), a narrow handoff service module, `home.mjs` (persisted operations and interfaces), `worker.mjs` (source wrap-up and target verification), `store.mjs` and `rooms.mjs` (start barrier), `role-calls.mjs` and `role-discussions.mjs` (undispatched bindings), `run-context.mjs` and `session-tools.mjs` (traceable handoff), and the role settings and session UI. Existing Git and attachment transfer are reused, and no synchronized file system is built.

After a Home restart it recovers from persisted state: an uncommitted operation continues reconciling or is withdrawn; a committed one only reconciles the target and does not rebind or re-deliver input. After a failure the old UI cannot resubmit from cache and must read the original operation ID.

## 9. Acceptance gates

| Scenario | Evidence required |
| --- | --- |
| Codex A, B, A | Same role and chat. Three segments of execution on really different nodes. After handoff the native ID is newly created as designed, and the next turn on the same device resumes. The new side can read the original instruction, a unique fact and the original text without the answer being pasted again |
| Handoff after pause | The source process really ended and the tail result arrived. The target starts only once and does not redo changes the source already finished |
| Handoff while waiting for a teammate | Question, Task and call IDs and the budget are unchanged. After the reply arrives it resumes only once and the original chain is not cancelled |
| Reply or redirection during handoff | No reply is lost. Q1 and Q2 stay separate. A new direction invalidates the old preview and the old task cannot continue |
| Double click, HTTP timeout, Home restart | The same `commandId` produces only one ownership change. Recovery follows the persisted stage and starts no model twice |
| Target lacks CLI, login, repository or attachment | The concrete blocker is shown. The source binding is unchanged and no "switched" success message appears |
| Source unreachable, unknown process, dirty workspace | Automatic takeover is refused. No empty repository is created, no unknown file is copied and no original data is deleted |
| Target start acknowledgement lost, or a late old event | Enters reconciliation, no blind retry. Old events cannot overwrite the new session state or unlock a new run |
| Multiple repositories or two roles | Every registered repository is actually verified, not just the project root. Another role's current changes are not overwritten |
| Other CLIs | New creation on another node with the same vendor, handoff original-text queries and next-turn resume are verified separately. Anything not passed stays closed |

Local scripts only verify the state machine and idempotency; a real two-device Worker/CLI run and browser operations must follow. Tests use isolated projects and `.local/` and never use real business tasks for destructive fault injection. The feature flag stays off by default until the capability has been accepted.

## 10. Approval status

The platform-level handoff direction has been agreed in principle. This document awaits written review; only afterwards will an executable implementation plan be drawn up and product code written. This status does not mean the migration feature is available.
