# Parallel group chats and team-only project copying

Status: specification approved by the user's instruction to continue development on 2026-10-16. Implementation plans await review and execution-method confirmation. Not implemented or deployed.

Source inspection baseline: `2790b8b10e824bd2fe887e04abf71580696b8c05` and its parent `6c2e597a518dae2ec6fe0683723c4ea26d29f21d`. This document is the single design source for these two actions; it does not change the existing collaboration-session or Git-branch contracts.

## 1. User intent and confirmed direction

The user wants to start fresh without rebuilding a team, and to reuse a team on a genuinely empty new project. The user selected a new parallel group chat, with the original chat still usable, rather than resetting or archiving the original chat.

| Action | Project and files | Roles and prompts | Conversation state |
| --- | --- | --- | --- |
| Branch into a new chat | Same project ID, repository bindings and physical directories; no file copy or Git branch | References the same project roles and settings | New group conversation and fresh native sessions; no inherited messages, summaries or tasks |
| Copy team into a new project | New project ID, group chat and empty directories on its participating devices | Independent copies of current non-archived roles, including the supervisor | New histories, native sessions and queues; no inherited execution or approvals |

Both actions preserve the original project, chat, files, native session records and reports. Creation must not stop, resume, duplicate or redirect an existing task. No model or native CLI is launched merely by creating either object.

## 2. Interface

Add two explicit actions to a group chat's menu: **Branch into new chat** and **Copy team into new project**. They are not actions on an arbitrary standalone vendor session in the Sessions tab.

- Branch: ask for the new chat title and show a read-only explanation of the shared project directories and shared role configuration. Present no option to import history in this first version.
- Copy: ask for the new project name and new folder name; preview the copied team, device assignments and the new target directories. Explain that code, documents and dependencies are not copied.
- New parallel chats appear as separate entries under Group chats. Preserve the original entry and its selection/order. Each row has its own title and conversation identity, with the project name available to distinguish similarly named chats.
- Project settings and role edits remain project-wide. The UI explicitly says that an edit affects all chats of this project. Copied-project roles have new IDs and do not remain linked to the source definitions.
- Running highlights apply to the actual conversation, not all sibling chats. The Sessions list groups the latest native session by project + conversation + role, retaining older sessions in each group's history.

## 3. Identity and legacy compatibility

Introduce a persisted group-conversation record with `id`, `projectId`, `title`, `parentConversationId` (branch provenance only), timestamps and an idempotent creation-operation reference. It owns no copied repository or role records.

Preserve the existing default conversation identity: historical messages, Tasks, Runs and related records without `conversationId` resolve to their `projectId`. Legacy API callers that omit a conversation continue addressing that default chat. Reject explicitly supplied unknown IDs or IDs belonging to another project; do not silently reinterpret them as the default chat.

Carry the resolved `conversationId` through message storage, Task creation, Run context, role calls, plans, discussions, continuations, reports and result messages. Children inherit it from trusted parent records, not arbitrary model-provided IDs. An old running Run completes into its original chat regardless of the currently selected browser chat.

Do not repurpose `collaborationSessionId`: the existing opt-in collaboration-session feature represents coordinated business work and review visibility, not the new sidebar chat container. Its records and receipts also need an owning conversation when created from a new chat; legacy records continue to belong to the default conversation.

Existing source-isolated native sessions also have internal partition keys. Keep that native partition separate from the owning group-conversation identity; it must not accidentally become a new group, lose valid context, or reuse another group's native session. Preserve historical partition keys and add explicit group ownership for new records.

No bulk rewrite of historical Runs, reports, prompts, native histories or queued work is required. Any materialized default-conversation record is idempotent and must not restart summaries or models.

## 4. What fresh context means

The branch starts with no inherited user/agent messages, quotations, attachments, summary, current goal, pending work, prior Run context, handoff seed or native resume ID. Parent provenance is navigation metadata, not model input.

- Reuse the project's configured platform/supervisor/role rules as configuration, not the source chat's accumulated conversation.
- Create each role session lazily for the new conversation when its first real task starts. `nativeSessionId`, `lastRunId`, active Run and resume workspace are initially empty. Use the project's current binding and the normal execution/input-version checks, never a previous chat's retained worktree.
- Scope automatic context excerpts, summaries, `wb history` search/read, `wb session` reads and conversation tools to the trusted current conversation. Validate pagination cursors, result IDs and quotation sources against that scope. A blank new chat must not fall back to project-wide history when no current records exist.
- Keep review visibility protections in addition to conversation scoping. Changing the selected chat or passing a known ID cannot expose an unpublished independent report.
- The user can still open the original chat and inspect its history. Cross-chat material is not automatically imported; an explicit future history-import workflow is outside this version.

Shared files remain shared files. Project `AGENTS.md`, `CLAUDE.md`, source code and documents can still be read, and may contain prior project knowledge. This feature isolates platform conversation context; it does not erase shared files or create an operating-system security boundary between CLIs using the same account. No promise of complete historical amnesia or filesystem secrecy is made.

## 5. Scheduling and ownership

Messages and native sessions are independent across chats; physical directories and device capacity are not.

- Retain project/workspace mutual exclusion, terminal claims, process-identity checks and CLI concurrency limits across all chats using the same project directories. Do not change a lock key to conversation ID merely to permit concurrent writes.
- Old work keeps running in the original chat. New work can queue normally, with a clear shared-workspace waiting reason. A branch creation itself does not wait for or interrupt an old Run because it launches nothing.
- Queues, replies, wait dependencies and native-session reservations retain the originating conversation. Never merge user messages across sibling chats into one CLI input batch.
- Role-card progress and session history show the selected chat's execution. Shared device/project occupancy may still be shown separately as a reason the selected chat is waiting.
- Stop, steer, session reset and takeover operations must target the selected conversation/session or explicit original Run. They must not choose an arbitrary first session belonging to a project/role.
- Project-wide operations such as changing a role's CLI or deleting a project must inspect activity in every conversation. This feature adds no shortcut around those existing safeguards.

## 6. Automatic work and notification routing

Do not copy timers, scheduled plans, monitor jobs, proactive-followup state, pending approvals or old notification reply bindings into a new chat/project.

Existing automatic work remains bound to the original/default conversation. Project-level followup observation must not consume messages from a new branch and restart the old chat's goal. New branch followup is off until explicitly configured; new timer/plan work created from a branch carries its trusted conversation ID.

Replies from a notification channel must return to the conversation recorded by the original request/notification. They cannot be routed by whichever sibling chat is currently open or was last created. All project-wide channel permissions remain unchanged.

## 7. Copying a team into an empty project

Copy all current non-archived working roles and the supervisor as a configuration snapshot. Preserve names, order, responsibilities, execution instructions (including explicitly empty strings), device, runtime, model, effort and enabled/disabled choices. Assign new project/role IDs and new definition revisions. Read the effective saved supervisor configuration, not just its built-in template.

Use an explicit field allow-list. Never copy native IDs, sessions, process handles, task/request/report IDs, maintenance operations, usage history, context summaries, source-sync state, approvals, timers or Git-delivery records. Global CLI/account registrations remain references to existing authorized devices; do not copy credential contents. Global platform prompt settings remain global.

Copy prompt text exactly. If it contains old directory paths or project-specific names, show a warning in the preview rather than silently rewriting the user's instructions. Project-local README/AGENTS/source docs are not role prompts and are not copied.

The destination has no repository bindings, remote repository URLs, old code, old `.workbench` files, dependencies or Git history. Do not clone, fetch, install dependencies, sync source files, start agents or deploy as a side effect. Minimal platform-generated bootstrap files may be created by the existing new-project initializer; the UI describes this as an empty business workspace, not a literal zero-file directory.

Prepare a new project folder on the supervisor device and each device required by an enabled copied role. Disabled roles stay disabled; their devices need no eager provisioning. Use the existing allowed-root and project-directory operations with explicit ownership checks. Never reuse or overwrite a pre-existing target directory just because its name matches.

If a required device is offline or creation fails, show that device's pending/error state and allow an idempotent retry. Do not silently move its role to another device or claim the project is fully ready. No copied role executes until required workspace preparation is ready. Already created operation-owned folders are retained for retry; do not recursively delete folders on failure.

## 8. Transactions, retries and storage cost

Branch creation uses one stable request ID and fingerprint containing source project/chat and new title. Equal retries return the same conversation; changed arguments with the same ID fail. Commit conversation creation and its empty initial UI state atomically.

Project copying uses a durable creation operation containing the source-role revision snapshot, destination IDs/names, old-to-new role mapping and per-device preparation receipts. Validate the source revisions when accepting the operation; once accepted, retries use that frozen snapshot rather than silently recopying later edits. Record partial device success and surface pending work without publishing a ready executable team prematurely.

Repeated clicks, HTTP retries, Home restarts or reconnections must not create a second chat/project, duplicate roles or repeat directory creation. Reuse the existing creation API's idempotency patterns rather than creating a separate service.

Branching stores only small metadata initially and copies no files. Native processes are lazy and subject to existing capacity limits. Team copying duplicates only configuration plus empty workspace bootstrap. Do not start background scans, new high-frequency polling or summary/model jobs for empty chats.

## 9. Code areas requiring implementation

Observed code already has conversation keys in `role-sessions.mjs`, `conversation-context.mjs` and portions of `session-tools.mjs`, but this is not end-to-end multi-chat support.

| Area | Required work |
| --- | --- |
| `home.mjs`, `store.mjs`, `rooms.mjs` | Conversation creation/read validation, source-preserving message/Task/Run propagation, per-chat result routing, compatible endpoints |
| `role-calls.mjs`, plans/discussions/session queue | Trusted conversation inheritance, per-chat collection and continuation context without weakening shared-workspace locks |
| `run-context.mjs`, `history.mjs`, session/context tools | Empty context stays empty; history/result/quote cursors cannot cross chats implicitly |
| `scheduled-jobs.mjs`, `proactive-followup.mjs`, channel routing | Preserve original targets and prevent old work from triggering in a new branch |
| Project creation/coordinator/device APIs | Frozen team copy, new IDs, empty-directory provisioning and durable retry receipts |
| `public/app.js`, room UI, native-session groups and state feed | Selected conversation identity, separate navigation/drafts/history, per-chat running emphasis and exact session grouping |

Do not rewrite the established Worker execution protocol unless propagation analysis proves a missing conversation field is required. Current original Runs must remain compatible across rollout. Source inspection above is not evidence that any of these changes are already implemented.

## 10. Acceptance before release

1. Branch while an original Run is active: original PID/session/workspace and Task/request IDs remain unchanged; creation starts no model/CLI.
2. Original and new chats remain selectable and usable with the same project folders and role definitions. A role edit visibly affects both; a copied-project role edit affects only the copy.
3. Put distinctive markers into old chat text, summary, quotation, attachment and handoff context. A first new-chat task receives none of them automatically, and uses a new native ID without an old resume workspace.
4. Agent history/session tools and direct-ID reads cannot bypass the conversation or independent-review boundary. Shared project files remain readable, as documented.
5. Messages, calls, plans, discussions, reports and delayed results land only in their originating chat; parent continuation and busy-role queues do not mix siblings.
6. Two chats sharing a directory obey existing workspace/terminal locks and capacity; ending one Run never releases another session's claim. Unknown process states remain blocked.
7. Native Sessions shows separate conversation/role groups, including history, and the correct chat/session highlights while running. Selection changes and refreshes preserve unsent drafts and expanded history.
8. Old timers, channel replies and proactive followups remain on the old chat. Creating or messaging a new chat does not resurrect an old objective.
9. Team copying preserves custom and empty prompts, settings and role order with new IDs; the destination contains no source code, dependencies, old conversation/report/approval state or live process references.
10. Repeated creation, conflicting retries, partial device failures, offline targets and a Home restart create exactly one destination with truthful readiness. Existing directories, old user modifications and histories survive all failure cases.
11. Legacy missing-conversation records and API calls retain their default-chat behavior; existing active Runs complete correctly after deployment. Verify real browser navigation and actual fresh CLI startup in an isolated test project; fixture-only tests do not prove native-context isolation.

## 11. Delivery boundary

Review this specification before writing the implementation plan. The plan must order conversation propagation and context-isolation checks before exposing the new UI actions, then add team copying and independent verification. Deployment, service restart and real business-project activation remain separate steps; this document authorizes none of them and changes no running task.
