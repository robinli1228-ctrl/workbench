# Supervisor, Optional Plans and Cross-Device Role Collaboration

Status: requirements design. What is actually implemented is described in [ARCHITECTURE](ARCHITECTURE.md); not every capability in this document should be treated as complete.

### Current simplified execution contract

One `@` dispatches directly; several `@` mentions go to the supervisor for evaluation. The supervisor submits a stable ID, a rationale and an array of stages. Each stage names the actual roles, their responsibilities, the execution requirements and the repositories they may write. Explicit sequential work uses one role per stage so the previous version is passed on accurately; independent reviews or independent development may share a stage. Parallel development in the same repository must be followed by a single-role merge stage. Migration, deployment and production operations run alone and exclusively.

The Home does not poll with a resident model. Stage state is persisted, real process terminal events drive the next step, the supervisor exits first to release capacity, and the final summary is resumed automatically. Each run has its own multi-repository worktree and its own `.workbench`. When a clean Git input cannot be proven, only a clearly dirty or non-Git directory on the same device may be downgraded to serial execution; cross-device or communication errors block. A Git commit can be handed over only when the target device can actually read it. Nothing is pushed silently and uncommitted files are never discarded. General versioned plan revision is left for later.

This document is the single source of requirements for this increment. It overrides the statements in the PRD that conflict with supervisor duties, default roles, automatic plans and cross-device calls. The rest of the product scope stays in the [PRD](PRD.md), and the implemented state stays in [ARCHITECTURE](ARCHITECTURE.md).

## 1. Goals and invariant constraints

The core acceptance scenario is: a CLI on a server develops, pushes a fixed commit, a CLI on a laptop tests it locally, failures go back to the server for a fix, and the laptop retests. Online status, simulated events and syntax checks cannot replace this scenario.

- Use JavaScript ESM and Node.js >= 22.16, keep SQLite, WebSocket and native browser modules, and introduce no workflow engine or front-end framework.
- Users work through the project group chat and do not fill in separate task forms.
- One Home manages many projects. Roles, supervisor context, plans, messages and directories are isolated by `projectId`.
- Each device runs one Worker. The local supervisor capability is built into it and is not duplicated as a resident process per project or role.
- No writable directory is shared across devices, and CLI login state, keys and databases are not synchronized. Code is handed over as fixed Git commits.
- Existing data and history are kept. Roles are no longer created automatically, and roles that were generated earlier or edited by the user are never deleted automatically.
- A real role fixes its device, CLI, model and prompt. The supervisor must not change that set on its own.
- The system supervisor does not do business development or write complex plans. A planning role with a high-end model creates and revises plans.

## 2. Three kinds of objects

### 2.1 The fixed system supervisor

Every project has a fixed "supervisor" entry that is not part of the user's worker-role table and cannot be deleted or renamed as an ordinary role. What is fixed is the responsibility, not the model brand.

Creating a project requires choosing a runtime, model and effort on an online Worker as the fixed reception supervisor. The supervisor uses its own configuration directory. Workers on the target devices keep executing dispatched work; every device does not need its own reasoning model for this. The supervisor helps configure multiple repositories, directories and worker roles; see [design-local-supervisor](design-local-supervisor.md) for details. When the supervisor is offline no other model is borrowed, and an explicit single-role `@` can still be scheduled by program logic.

Across devices the flow is source-node supervisor, then Home forwarding, then target-node supervisor. The Home persists one call, and the receiver only executes locally; no separate plan is generated again. Node supervisors can work at the same time. Home primary/standby is an independent concept.

Forwarding with an explicit role and version is done in code. A cheap model is called only to understand new requirements, to parse complex multi-role ordering and to handle off-plan exceptions. The model returns a limited set of actions, never a ready-to-run arbitrary shell command.

### 2.2 The fixed template library

A system-maintained template library is kept for copying initial duties and prompts when a role is created. Supervisor templates and the fixed supervisor must not be confused: the legacy manager template is removed from the creation options and its complex planning and summarizing content moves into the planner template; existing "supervisor" worker roles keep their configuration.

The creation entry offers blank, planner, developer, tester and code reviewer templates. Templates are fixed. Users may change the name and content of the copied role, but there is no template marketplace or template editor.

### 2.3 Custom worker roles

A project may have zero, one or many worker roles. With no roles the supervisor can still receive requests but cannot invent executors. Users can add, edit, disable and archive roles and use any valid name, such as frontend, backend or reviewer.

A new request fixes the role configuration version. Edits affect only new requests; queued and running requests keep their original snapshot. Disabling pauses requests that have not started, and archiving first requires that the role's unfinished work is handled. History continues to show the role name and configuration of the time.

## 3. Group chat entry and call semantics

A single explicit `@` without a sequential delegation request dispatches directly to that role with no extra supervisor reasoning. A message without an `@` goes to the supervisor, which decides among answer, dispatch, request_plan, clarify, status and cancel. Plain discussion does not directly trigger development.

A message with several roles, an order, or "hand over after finishing" is no longer matched by regular expressions that start all roles at once. The supervisor gives explicit recipients and order. When only one executor is needed no plan is created, and a multi-stage job requests a plan as needed.

`@all` is an announcement. It does not wake everyone and a pure announcement is not new work for the supervisor. Echoes from supervisors, agents and channels no longer enter the user-message entry.

Role calls are either `consult` or `handoff`. A call must carry a `requestId`, `projectId`, the target `roleId`, a description, a return location and the source run, and optionally a `deliveryId`. A consultation does not require the source to succeed or to have a Git artifact. A handoff must wait until the Worker has verified that the run ended and the artifact is ready.

An `@` in ordinary agent output is never parsed as a command. The legacy `wb ask` entry is kept, mapped to `consult`, with an explicit compatibility notice; new calls use `wb call`. A role that receives help can continue through a new continuation run. Cross-device resume of native CLI sessions is not promised.

After a parent role requests waiting, it must end its current model turn and save a continuation summary, and capacity is released only after the Worker confirms the process has ended. While the parent session is still alive, the `waiting` field alone cannot release physical execution capacity.

By default each collaboration chain allows at most 4 levels of nesting, 20 delegations and 2 repair rounds. These are initial program constants and do not add a settings page for ordinary users. Cyclic calls to an active ancestor role are rejected, while the normal sequence development finished, testing finished, new development repair round is allowed.

## 4. Whether to plan, and page rules

The supervisor decides whether a plan is needed, and an explicit user request takes priority. The planning role is selected in project settings from existing worker roles, not matched by name. If there is no planning role, the user is asked to select or create one; a worker role is never generated automatically.

A plan contains at least the goal, a version, step IDs, the executing `roleId`, dependent steps, inputs, delivery requirements and acceptance evidence. The first phase implements only acyclic dependencies and limited repair, with no visual flow editor.

`plan.status`: drafting, awaiting_confirmation, ready, running, blocked, completed, cancelled.

`step.status`: pending, ready, running, waiting_call, blocked, succeeded, failed, cancelled.

When only a proposal is requested, the plan waits for confirmation. When the user explicitly asks for the work to be completed, it executes within the authorized scope, and any additional external writes still follow the existing approval and project policy. A successful exit code does not mean the step passed acceptance; testing must submit an actual verification verdict for the corresponding version.

When there is no plan the whole plan area is hidden, with no empty frame and no forced plan. While a plan is being drafted a placeholder card is shown. Once a plan exists, the latest version, steps, roles, devices, state, blocking reasons and execute/submit entries are shown. Several unfinished plans are all viewable, completed plans are collapsed and old versions expand in history. Refreshing and switching projects restores from the server and does not depend on whether the current chat page loaded the plan message.

When a direct execution is upgraded to a plan, the plan references the existing execution as a completed or in-progress step instead of dispatching again from scratch. Revisions use `expectedVersion`. Results of old executions stay in history but cannot automatically advance a new version. Reusing an existing delivery must be explicit in the new plan and validated.

## 5. Handing over fixed Git commits

Each project binds repositories and a directory per device, and each execution uses its own worktree. A cross-device delivery records the repository identity, the base commit, the delivered commit, the transfer ref, the source run, a summary and verification notes.

After development finishes inside a managed worktree, the Worker verifies the terminal state of the run, checks the change scope and uncommitted files, and commits and pushes according to an explicit delivery list to a separate collaboration ref. It must not automatically commit existing changes in the main directory, ignored files, credentials or workbench runtime data.

After the source push succeeds and the ref points at the delivered SHA, `delivery.ready` is recorded. The receiver fetches that ref, verifies the full SHA and creates a separate worktree. Automatic pull, automatic merge into the main branch, force push and overwriting a dirty directory are forbidden during execution.

Testing may write its own isolated directory to install dependencies and produce build artifacts, but a "read-only review" mode must not be used as the run mode of every test. After testing ends the source difference is checked; modifying source without authorization is not a valid independent acceptance. The working directory of the started service and the version under test must be verified so that an old local service is not tested by mistake.

The first phase automatically delivers only Git-tracked code and documents and small text test reports. Large artifacts, database migrations and missing submodule/LFS dependencies are reported as unverifiable; no shared disk or object storage is introduced ad hoc.

## 6. State, checks and notifications

The Home database stores plans and collaboration state, and the Worker database stores real local executions. The existing command, event and outbox de-duplication mechanisms are reused. A CSV is an automatically exported progress index per project; it does not take part in scheduling and does not accept concurrent writes from agents.

Events advance state immediately. While executions exist the state is reconciled every 30 seconds, and when idle pending state is reconciled every 5 minutes. This is separate from network heartbeats and from the primary-node lease. With no change there is no reasoning and no group message. The same anomaly triggers handling only once, and it is re-evaluated when new evidence arrives.

A disconnection or silence only enters reconciling or waiting; it is not automatically judged a failure and no duplicate is started. After a Home restart the Workers are reconciled first and then the plan continues. Actions such as stopping an old version or requesting cancellation must be checked again before they actually start.

Instant-messaging channels are received and sent only through the Home's channel egress; node supervisors do not hold channel accounts. Inbound messages are de-duplicated and outbound messages are registered. When a send receipt is uncertain it is shown as pending reconciliation; IM implementations without idempotency are not promised exactly-once delivery.

## 7. Implementation boundary

Core batch: free-form roles, the fixed supervisor, optional plans, node supervisor collaboration, fixed Git commit hand-off, conditional display, and real server development with local testing.

Later batch: a chat channel and manual Home primary/standby takeover, reusing the core records without delaying core acceptance. Feishu remains in the second phase.

Out of scope: automatic primary election, P2P mesh connections, automatic worker-role generation, silently replacing a role's device according to load, full session migration, full CSV/Git dual-write of state, complex multi-user permissions and a general workflow platform.

At this stage no new deployment, configuration migration or code change has the status "accepted".
