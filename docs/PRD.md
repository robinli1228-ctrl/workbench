# Distributed Multi-Agent Collaboration Platform: Product Document

> Increment: the supervisor, default role templates, project roles, optional plans and cross-device calls follow [design-coordination.md](design-coordination.md). The older rules below that conflict with it no longer apply. The rest of the phase 1 and phase 2 scope is unchanged, and the implemented state is described in [ARCHITECTURE](ARCHITECTURE.md).

| Item | Content |
| --- | --- |
| Version | v0.3 |
| Status | Phase 1 in development. See ARCHITECTURE.md for what is complete |
| Applies to | Phase 1 and phase 2 |
| How to use | This file is the current requirements and scope reference and is maintained in place |

## 1. Overview and goals

Source synchronization increment: [design-source-sync](design-source-sync.md) adds explicitly scoped saved-file exchange, including uncommitted edits, with modifier-owned conflicts. It does not replace formal Git delivery or business acceptance; see its implementation and acceptance boundary before activation.

### 1.1 Product positioning

A project workbench that manages real agent runtimes. Each computer or server runs a Worker that starts the local CLI, manages sessions, executes tasks and returns results. Users take part in projects through the web, a chat channel such as WeChat, and, in phase 2, Feishu.

The platform provides stable roles such as project supervisor, executor and reviewer. One CLI can be started with different configurations as several independent sessions that take different roles. Users can add specialist roles dynamically and choose each role's model, tools, duties and response style.

The main entry is the project group chat: say what needs doing and `@` who should do it, without creating or filling in a task form. Task and WorkOrder are internal execution records generated from messages, and users check progress, approvals and results from the conversation cards. The Home suits an always-on server, and execution nodes can go on and offline as needed.

An external agent-hub product is an independent product. This project only borrows the session hosting, message handling and remote control ideas that fit, and does not inherit the old product's data model, default model routing or login system.

### 1.2 Overall goals

Let agents on several machines complete work together, reducing how often the user copies context, assigns tasks and collects results by hand.

- A user can switch projects in one workbench and see each project's conversations, tasks, files, Git and members.
- The project supervisor can break down complex tasks, executors work with real CLIs, and reviewers verify deliverables.
- A user can name roles explicitly, add requirements during execution, stop tasks and approve actions.
- Common disconnections, duplicate messages and process failures have clear states and manual recovery entries.
- Models are assigned by task difficulty, avoiding repeatedly starting agents or copying long sessions for small tasks.

### 1.3 Phase 1 goals

Run a real workflow on one laptop and one Linux server. First connect two commonly used runtimes, with Codex and Claude Code as targets, then verify one ACP runtime in actual use.

After phase 1, a user can submit a task from the web or a chat channel, watch the remote CLI work, obtain the result in an independent workspace, have it reviewed by another agent, and have an authorized human member confirm the delivery. Two nodes support manually designating the primary node and a controlled handoff.

The platform fully manages the sessions it starts itself. External sessions started by hand in a terminal are shown read-only when a readable interface exists, and this is not a managed-acceptance condition for phase 1.

### 1.4 Phase 2 goals

After phase 1 is stable, connect Feishu, complete the runtimes that are really needed, and improve the multi-person collaboration experience. The project, session, task and permission models of phase 1 continue to be used.

Phase 2 focuses on multiple channels, adapters added on demand, member identity binding, and reuse of common project Skills. Automatic primary election, automatic primary takeover and complex scheduling scores are not mandatory phase 2 deliverables.

### 1.5 Success criteria

| Goal | Acceptance evidence |
| --- | --- |
| Real execution | At least one remote CLI change, commit, independent review and human confirmation |
| Parallel collaboration | Different tasks run in independent workspaces, and one Session has only one driver |
| Observable | Task, process and channel each show their state and last update time |
| Controllable | "Stop requested" is distinguished from "stop confirmed", and external sessions cannot be injected remotely |
| Recoverable | After a disconnection the original Run is reconciled and, when it cannot be confirmed, not started again |
| Convenient | Switch projects, view history, files and diffs, and go from a message directly into a task |
| Cost controlled | Model, available token numbers, execution count and rework count are recorded, and nothing calls a model while idle |

During trials, record each task's number of human interventions and the number of manual context transfers. Obtain a baseline first and then set the efficiency target; do not assume an unmeasured saving ratio.

## 2. Phase 1, phase 2 and on-demand scope

| Capability | Phase 1 | Phase 2 |
| --- | --- | --- |
| Web project workbench | Project switching, conversations, history, files, Git, settings | Improve based on feedback |
| Human and agent roles | Owner, supervisor, executor, reviewer, observer; specialist roles can be added | Complete invited members and task-specific participation |
| Runtime | Two common native interfaces and one concrete ACP instance | Only add adapters that are really needed and verified |
| Session control | Managed sessions started by the platform; external sessions optionally read-only | Keep the boundary and improve resume per adapter capability |
| Workspace and delivery | Independent worktrees, fixed-version review, artifacts | Improve problems actually met in delivery |
| Channels | Web, WeChat, login-state checks and disconnect alerts | Feishu, identity binding confirmed by humans |
| Primary node | One designated Home per project, manual stop-and-handoff | Keep manual primary/standby and improve configuration and state display |
| Scheduling | Role and model assignment, online and permission checks, concurrency limits | Add manually configured priorities and fallback runtimes |
| Skill | Use existing project Skills, triggered by hand | Save verified in-project execution methods |
| Quota | Show readable sources and times, unknown is marked explicitly | Add reliable data sources as needed |

### 2.1 To be evaluated separately on real need

The following do not count toward completing the two phases. Design them separately once there are repeated manual workarounds and a case with real cost.

- Wrapping and taking over external sessions that the user opened by hand.
- Seamless takeover of tasks that are still running after a failure.
- Automatic leader election, automatic primary preemption by high-priority nodes and several independent lease migrations.
- Fully identical features across all runtimes, and full session migration across models or machines.
- Automatic risk classification of arbitrary shell commands and complex permission inheritance.
- A self-built device signature and dual-token lifecycle system.
- Accurate quota prediction, historical success scoring and estimated-completion scheduling.
- Unattended routines, browser-recording tutorials and automatic workflow generation.

### 2.2 Scope that stays excluded

A cross-project dashboard, cross-project search and sharing of role templates are not in this plan. A marketplace, billing, complex enterprise organizations, cross-company federation and large cluster management are not either.

Message persistence, idempotency, basic permissions and necessary retries are implementation conditions of the features themselves, and no separate reliability and audit product module is built.

## 3. Overall structure and responsibilities

Every project has a designated Home, and one process can host several projects. Workers connect to the Home on their own initiative, and each node keeps its own CLIs, credentials and working directories.

| Component | Responsibility |
| --- | --- |
| Web workbench | Projects, conversations, tasks, files, Git and configuration |
| Project Home | Persists tasks, members, sessions, approvals and the current coordination right |
| Project Coordinator | Rule routing, task assignment, idempotency, permissions and state updates |
| AI Project Manager | Understands complex goals, breaks down work, handles unclear requests and writes summaries |
| Worker Daemon | Starts managed runtimes, locks sessions, watches processes and returns execution results |
| Runtime Adapter | Connects to a concrete CLI's start, input, event and interrupt interfaces |
| Channel Gateway | Sends and receives WeChat or Feishu messages, session binding and channel health |

The Home stores work goals and assignment decisions. The Worker is the source of local execution facts, and the Home stores and shows those facts with the time of the last update. After losing a connection the Home does not conclude from a timeout that the CLI has exited.

In phase 1 each Home uses one transactional database for project data, SQLite by default. A writable database file is not shared across machines. Artifacts are initially stored in a project file directory managed by the Home and delivered by authorized download; an S3-compatible store is introduced only when capacity or an existing environment requires it.

Git is the source of truth for code. The visible process lives in the project conversation, responsibility and progress in the task, and the current execution context in the Runtime Session; they are linked by stable IDs.

## 4. Roles, runtimes and permission boundaries

### 4.1 Default seats

| Seat | Responsibility |
| --- | --- |
| Owner | Manages the project, members, execution policy, manual handoff and final confirmation |
| Project Manager | Handles complex goals, splits tasks, names owners and summarizes |
| Worker | Executes per the task requirements and submits code or file results |
| Reviewer | Checks a fixed version independently and raises issues |
| Observer | Views the process and results of authorized projects |

The Worker Daemon is a machine service, while the Worker in the table is an execution role. One machine service can start several execution roles.

Specialist roles can use different names, tools and response formats, but their permissions are chosen from the fixed scope above. A role the user creates personally needs no repeated approval; when an agent asks to add a role or widen permissions, the Owner decides.

Phase 1 collaboration is mainly for trusted project members. Joining the main project group means seeing its history, and it must not be described as safe for arbitrary outside guests. When task-specific participation is needed in phase 2, local visibility will be implemented with task-member permissions.

### 4.2 The four layers of a runtime

| Object | Content stored |
| --- | --- |
| Runtime installation | CLI type, install path, version, discovery result |
| Execution configuration | Model, account reference, launch arguments, tool and permission mode |
| Agent role | Identity in the project, duties, available execution configurations and response rules |
| Session | Running node, runtime session identifier, current controller and linked Run |

One CLI can be configured with several models and roles, and each role uses its own Session. Account credentials stay on the execution node, and the Home stores only references and necessary state.

### 4.3 Instructions and Skills

Existing repository files such as `AGENTS.md` and `CLAUDE.md` and native rules are kept. The platform appends role and task descriptions through the entry an adapter supports, without overwriting the user's original files.

The UI shows the content the platform injected, the configuration version and the known instruction sources. When the runtime's full internal instructions cannot be read, this is stated explicitly, and the platform does not claim to hold the final system prompt in full. Actual instruction priority follows the runtime's native rules, and platform permissions are checked independently.

Project Skills are used by hand at first. Phase 2 allows organizing verified methods for continued use in the current project, without creating scheduled execution automatically.

## 5. Sessions and collaboration flow

### 5.1 Managed and external sessions

| Type | Control boundary |
| --- | --- |
| Managed session | Started and registered by the Worker, with input, interrupt and native resume according to adapter capability |
| External session | Started by hand in the user's terminal, shown only when a readable interface exists; injection from phones, group chats and the Home is forbidden |
| Cross-runtime continuation | A new managed Session is created and continues the task with a handoff summary and file references |

Phase 1 does not wrap and take over external sessions. When a user wants to hand one to the platform, they first end the original driver explicitly, then create a new managed Session and continue with a summary and file references. Native session resume applies only to managed sessions the platform created earlier.

One Session allows only one driver at a time. The Worker keeps the Session control lock and checks the execution identity, forbidding two processes from resuming the same Session at once. Input from a terminal and from a phone must go through the same managed entry.

### 5.2 How the group chat triggers work

A plain message without an `@` is recorded only and does not call a model automatically. The user names who executes, analyzes or answers with `@role`; a complex goal can discuss a plan with `@supervisor` explicitly. Automatic decomposition by the supervisor and structured forwarding belong to later scheduling capabilities and are never triggered by parsing an agent's ordinary reply.

Manual stop and cancel commands are handled first. Execution messages are routed by the explicit `@role` and do not fall back to the supervisor automatically. Chit-chat between members, ordinary status messages and agent replies do not wake other agents.

When several roles are `@`-mentioned explicitly, each one's responsibilities are made clear and the necessary subtasks are created. Each task stage has one owner, and parallel development uses different tasks and workspaces.

### 5.3 Conversation and internal execution flow

1. The user states a goal through the web or a chat channel and names the project and necessary material.
2. The user `@`-mentions a role in the message and describes the request, and the platform generates an internal execution record with no separate task-creation form.
3. When the scope is clear and authorized, execution starts directly; major plans or high-risk actions are confirmed separately.
4. The Home picks a qualified node and execution configuration, and the Worker takes the task and obtains control of the Session.
5. The Worker prepares an independent workspace, starts the CLI and returns key progress.
6. The executor submits a fixed commit or a file artifact, and the system records the source.
7. A task that needs review is checked independently by a Reviewer, and issues go back to the original executor.
8. Once the acceptance conditions are met, an authorized member confirms completion.

The supervisor calls a model only when understanding, a decision or a summary is needed. Subtask completion is signaled by events and agents are not asked repeatedly whether they are done.

### 5.4 Handoff and context

A cross-runtime handoff uses a short package with the goal, the current task version, confirmed decisions, completed items, remaining questions, the fixed commit or file version, and necessary message references.

The summary and the references to original text are used together, and the whole project history is not copied. The receiver reads more according to its permissions when it needs to. What the group chat shows and what is fed to the model each turn are two different things.

Before the executor of the same task is changed, it must be confirmed that the old executor has stopped writing. When the original node is unreachable and this cannot be confirmed, the task stays pending reconciliation and a new agent does not take over editing immediately.

### 5.5 Human edits, pause and stop

A small clarification can be added to the current Session. A change of goal or write scope generates a new task-order version, and the new version continues only after the old executor accepts it or stops.

The one-click pause of remote commands rejects new starts, continues and text injection, and also blocks old queued commands that have not run. Stop, permission revocation, status queries and result reporting remain available. Pausing dispatch does not stop tool actions that have already started.

A stop first shows "stopping", and shows "stopped" only after the execution node confirms. When the node is unreachable it shows "waiting for node confirmation". Cancelling a task does not delete files automatically and does not undo external operations that already happened.

## 6. Minimum objects and states

### 6.1 Object relations

| Object | Key content |
| --- | --- |
| Project | Goal, repositories, members, default policy, designated Home |
| Node | Worker identity, connection state, execution resources and working directories |
| Agent and execution configuration | Stable role, runtime, model and account reference |
| Conversation | Main project group, task thread or direct chat, messages and members |
| Task | Goal, owner, parent task, dependencies, current state and acceptance |
| WorkOrder | An immutable version of a Task's execution requirements |
| Run | One execution attempt, node, Session, state and actual result |
| Review | Reviewed fixed version, reviewer, verdict and verification evidence |
| Approval | A concrete authorization for an action and its usage state |
| Artifact | Version, storage location and source of a delivered file |
| ChannelBinding | Mapping of an external conversation to a project conversation and person |

The objects can live in the same database, and no separate service is built for each object.

### 6.2 Task states

| State | Meaning and next step |
| --- | --- |
| draft | Requirements being shaped; moves to ready when clear, keeping the reason when confirmation is needed |
| ready | Can be assigned; starts when dependencies are done and execution rights are obtained |
| in_progress | Execution has started; may wait for subtasks, and the reason is recorded separately |
| in_review | Under review; rejection returns to execution, approval goes to awaiting acceptance |
| awaiting_acceptance | Waiting for human acceptance or merge |
| blocked | Missing environment or input, or an unreconciled execution; a named owner resumes it once the condition is solved |
| done | The defined delivery conditions are met |
| cancelled | Task cancelled; whether the linked Run has stopped is shown separately |

Rework records rounds and issues and adds no separate complex flow. After two unresolved rounds it goes to a human decision. A Run that exits successfully does not mark the Task as done automatically.

### 6.3 Run states

queued, starting, running, waiting_user, stopping, reconciling, succeeded, failed, interrupted.

A waiting_user Run can continue after a valid reply. A Run confirmed as ended keeps its history, and running again creates a new Run. Native Session resume must first check the process and control right, and a second driver process must never be created at the same time.

After a Worker disconnects or crashes the Home shows the state as stale or pending reconciliation. When the Worker recovers it checks the original Session, process and saved results; it marks interrupted only after confirming the exit, and reattaches to observe if the process is still alive. When it cannot be determined, nothing is rerun automatically.

A task can have several sequential execution records; a retransmitted start command always points to the same Run and does not count as a new attempt.

## 7. WorkOrder and command boundaries

Task requirements and scheduling information are kept apart. Changing a role, a Home handoff or a network retry does not rewrite the business requirements; only a change of task scope or acceptance creates a new WorkOrder version.

The following is a structural example. The IDs, paths and commit values are for illustration only.

```json
{
  "workOrderId": "wo_8",
  "revision": 2,
  "projectId": "project_1",
  "taskId": "task_8",
  "goal": "Complete the confirmed interface change",
  "repositoryId": "backend",
  "baseCommit": "<fixed commit resolved before dispatch>",
  "writablePaths": ["src/order"],
  "contextRefs": ["message_301", "artifact_22"],
  "acceptance": {
    "description": "Interface behavior matches the confirmed requirements",
    "verifyCommands": ["npm test"],
    "reviewerRoleId": "reviewer"
  },
  "deliverables": ["commit", "result_summary"]
}
```

Dispatch uses a fixed `commandId` and `runId` and references the work order and the chosen execution configuration. A command inside a message body can never be executed directly, and the same `commandId` can never be used with different parameters.

The writable scope in a work order is actually constrained by the Worker and the runtime capability. The UI must say which limits are enforced and which capabilities are not yet supported.

## 8. Worker and adapters

### 8.1 Minimum Worker duties

- Register the node and available runtimes, and receive commands over an outbound connection.
- Check the project coordination right, the device authorization, the execution scope and duplicate commands.
- Manage managed processes and Session control locks.
- Prepare workspaces and collect delivery results and key events.
- Reconcile the original Run on reconnect and report the real state.
- Limit the concurrency of the whole machine so that several projects do not over-start at once.

### 8.2 Integration scope

| Phase | Integration requirement |
| --- | --- |
| Phase 1 | Two native interfaces, Codex and Claude Code, plus one selected version of an ACP instance |
| Phase 2 | Choose from tools such as OpenCode, Gemini CLI, Qwen Code, Pi, Cursor and Copilot according to usage |
| On demand | OpenClaw Gateway, remote AgentScope A2A, generic JSONL or PTY |

These are candidate directions. The protocol, available models, authentication and resume behavior must be verified on the installed version and cannot be inferred from a tool's name. Read-only PTY display is not the same as having managed control or approval.

A unified adapter requires only discovery, start, input, events, state, interrupt and result collection. Native resume, quota reading and other features are enabled by capability declaration. When a required capability is missing, the runtime is marked limited and is not made to look fully supported by parsing terminal text.

### 8.3 Registered capabilities

For each verified adapter the following is recorded: runtime and adapter versions, launchable models, whether resume is supported, a permission callback before execution, how a process is stopped, the token source and the verification date.

Model switching, account switching and Session resume within one runtime are not guaranteed to be equivalent. A cross-runtime continuation is always handled as the new-Session handoff of chapter 5.

## 9. Communication, idempotency and minimal persistence

### 9.1 Connection

A Worker connects to the designated Home over an authenticated WebSocket on its own initiative, and no local control entry is opened to the public network. Local loopback interfaces needed inside a CLI are not open to other devices.

Each project is configured with a Home address and optional fallback addresses. A primary switch is done by updating the designated address manually, Workers reconnect per configuration, and phase 1 builds no service discovery.

### 9.2 Commands and events

A command contains `protocolVersion`, `commandId`, `projectId`, `projectEpoch`, `runId`, the work-order reference and parameters. The receiver first verifies identity, the current coordination right and the Session control right, and then registers the command.

An event contains `clientEventId`, `nodeId`, `runId`, `seq`, `type`, `createdAt` and `payload`. `seq` increases within one Run, and global order is not inferred from machine timestamps.

A repeated `commandId` with identical parameters returns the original state or result, and different parameters are rejected. When a start receipt is lost, the original Run is queried and no process is started again. A new version or a new attempt uses a new command ID and reconciles the old execution first.

### 9.3 Queue

Key state, approval and artifact events are first written to a pending-send table in the local database and then sent. The Home persists and de-duplicates before acknowledging, and the Worker marks the acknowledged records and cleans them up per retention policy. No append-only log engine or full event replay platform is built.

Delivery is at-least-once, and the receiver de-duplicates by event ID. High-frequency token increments and tool logs are sent in batches and not written one character at a time; final usage and results are saved reliably.

A start command rejected during a pause has its rejection saved and is not added to the pending queue. On reconnect the pause state, permissions and task version are checked again.

If an external IM provides no idempotency or reliable lookup, a send whose receipt was lost is marked "send result unconfirmed" and is not resent blindly, and the channel is not promised to be free of duplicates.

## 10. Simple manual primary/standby and recovery

### 10.1 Daily operation

At any moment every project has exactly one designated Home. Node priority only suggests a manual choice and never triggers preemption on coming online. An isolated node does not promote itself.

One project coordination lease and one control lock per Session are kept. IM sending follows the effective Home, and no separate Channel Lease or migratable Runtime Lease system is built.

The lease is renewed every 30 seconds when busy and every 5 minutes when idle, and a lost connection reconnects every 5 minutes. Network keep-alive is separate from the lease. The lease duration must be longer than the corresponding renewal interval; phase 1 suggests a 10-minute validity, after which the node stops accepting new execution actions and does not switch nodes automatically.

When the connection has been lost for 10 minutes and several reconnects failed, a prompt for manual handling is shown. Pause and exception notices go through the web; when WeChat itself is down it cannot be the only alarm.

### 10.2 Phase 1 promises only a controlled handoff

1. The Owner starts a handoff and the original Home stops new dispatch and new channel sends.
2. Wait until existing tasks reach a safe stopping point, and reconcile processes, approvals and message-sending state.
3. Export a consistent state from the quiesced database and transfer it, with the project file list, key artifacts and configuration, to the standby Home.
4. Check that the data is usable, disable the original Home's project coordination entry and sending right, and update the configuration version and Project Epoch.
5. Workers accept new commands only after confirming the new coordination identity and address; unconfirmed nodes stay isolated.
6. Verify messages, tasks, members and channels on the new Home and resume dispatch.

A handoff may stop the service and does not migrate running processes. Git code is stored in the remote repository, and each execution node's workspace stays on its original machine.

### 10.3 The original Home suddenly unreachable

Phase 1 does not guarantee automatic recovery of Home data. If the original node cannot provide the latest data, an unavailable state is shown, and a human restores the original node or provides a trusted backup.

Even with a backup, its time, the ability to stop the old node from continuing to coordinate, and the Workers' real running state must be checked. When it cannot be confirmed that the old node lost control, or an unknown execution exists, the same task is not continued on the standby node. Incrementing the Project Epoch number alone is not enough isolation.

Device credentials and the project coordination right are verified with mature authentication mechanisms. After the old Home loses authorization it cannot dispatch again even if it comes back. Automatic replication and failover are left to a separate design when there is a repeated need for unattended operation.

## 11. Git, workspaces and artifact delivery

### 11.1 Code tasks

Each code Task uses an independent workspace under the `.worktrees` directory of its project. Before dispatch the branch reference is resolved to a fixed commit, and all nodes use the same baseline.

Phase 1 cross-node code delivery relies mainly on a configured remote Git repository. The executor commits to a task branch, and the review node pulls the fixed commit and checks it. Git remotes such as GitHub and Gitee are supported as configured, with no dependence on one provider's PR API.

A local commit that has not been pushed cannot be treated as handed to another node. Uncommitted or untracked files need to be packaged and delivered explicitly, and Git cannot be assumed to include them. Source, dependencies and credentials must not be copied blindly as one directory.

### 11.2 Environment and review

A project configures only the necessary environment preparation, verification commands and run ports. Shared databases or resources that cannot be isolated are used serially first, and no automatic environment orchestration system is built.

A Reviewer uses an independent Session and checks the source and acceptance requirements in a review workspace corresponding to the fixed commit. Tests and builds may write to temporary directories in the review workspace, but may not modify the source under review or publish results.

A review record is bound to the task-requirement version and the result version. A change of source, a change of acceptance requirements or a different merge result requires the affected reviews to be confirmed again. After several tasks merge, at least the agreed integration verification is run.

A human can merge directly in existing Git tools, and the platform records the result and confirms the delivery. No Merge Agent that resolves conflicts automatically is built.

### 11.3 Non-code tasks

Research, documents or file processing use an independent task directory and submit artifacts and acceptance notes. Review is based on the file version and the actual content, and not every task is forced to produce a Git commit.

Cancelled, failed or completed work does not delete the workspace immediately. The UI offers keep and manual clean-up, and uncommitted or undelivered content must be flagged explicitly before cleaning.

## 12. Permissions and approval

### 12.1 Minimum permission model

Phase 1 controls permissions with fixed roles, project members, task workspaces and action rules. Devices use independent, revocable authentication credentials, with authentication and encryption handled by mature components instead of a self-designed Ed25519 registration and dual-token issuance system.

Permission is a check before the Worker executes. The Home records the human decision, and the Worker verifies it before running. The platform does not turn on a permission-skipping mode by default, and an agent instruction cannot widen its own authorization.

If a runtime cannot constrain the required directories or sensitive actions, the corresponding remote capability is disabled or the runtime is marked as not meeting the managed requirement. It is not enough to forbid one launch argument and claim a complete approval gate.

### 12.2 Action levels

| Level | Default handling |
| --- | --- |
| L1 | Reads and status queries within the authorized scope can run directly |
| L2 | Changes within the authorized task scope run per the project policy |
| L3 | Publishing, production changes, important deletions, permission widening or new external contacts need explicit approval |
| Undeterminable or forbidden | Not released automatically as low risk; decided by a human or rejected |

The level is enforced by the Worker according to the project policy, and the adapter reports action information and cannot downgrade it on its own. Classification is promised only for actions the platform knows and can constrain. All side effects of scripts and arbitrary shell cannot be guaranteed statically and remain constrained by the runtime's permissions and the workspace.

Routine progress and result replies in a bound project conversation are pre-authorized and not approved one by one. Adding a recipient or changing the sending scope is judged separately.

### 12.3 One-time approval

An approval stores `approvalId`, the action and a parameter summary, `actionHash`, the linked `commandId`, the project and task version, the approver, the validity period and the usage state.

Only a valid approval matching the action and scope can be used; an action that needs approval must not run without valid authorization. Consuming an approval and registering a command are linked in the execution record, a retry of the same command returns the original result, and an authorization cannot be reused to start a different action.

A stop or a version change invalidates approvals that no longer apply. When two people act at once, permission and task-version checks decide, and a submission from a stale page returns a conflict and does not overwrite a decision already in effect.

### 12.4 Pause and revocation

A project offers pausing remote commands, and a device offers revoking authorization. The UI shows separately that the request is recorded, that the Home has applied it and that the Worker has confirmed.

A disconnected device may not receive the revocation at once, so later commands must be stopped by validity periods and checks at reconnect. A revoked credential must not be shown as having terminated all local processes on that machine.

## 13. Model assignment, resources and tokens

Model assignment uses explicit rules, and no prediction scoring system is built first.

| Work | Default assignment |
| --- | --- |
| Complex goals, design, core development, hard analysis, critical review, final synthesis | The strongest configured model |
| Routine development, fixes, integration and testing with a clear plan | A mid-tier model, chosen by real efficiency |
| Simple lookup, extraction, tidying and mechanical edits | A low-cost configured model |

The tiers stand for the model assignment the user currently prefers and map to the execution configurations that a node can actually use. When a model is unavailable the reason is shown, and the platform does not claim that a model switch was completed. Because different accounts hold different amounts of spare quota, the user can change which accounts and models take which tier at any time.

The scheduling order is: the role or configuration the user specified, permission and capability checks, node online, node concurrency and account rate-limit checks, and finally selection by configured priority. With no qualified candidate it waits or asks a human to choose.

By default one task has at most two parallel subtasks, nodes set their own total concurrency limit, and a machine shared by several projects is controlled uniformly by the Worker. A complex task goes straight to a suitable model and is not tried repeatedly by a lower tier first.

Subtasks carry only the necessary context and report briefly. Repeated failures are classified by cause first; network and configuration problems cannot be solved by switching models over and over. The strongest model checks the key evidence and does not redo the verified auxiliary work in full.

The token page distinguishes usage for this run, context occupancy, account quota, reset time and login validity. Real-time, estimated, stale and unavailable values are marked separately. When several roles share one account they refer to the same quota record, and the balance is not counted twice.

When tokens do not grow, tool activity and waiting reasons are considered, and a process must not be killed just because the model temporarily produced no output. While waiting, event notification or bounded queries are used, and a model is not woken continuously.

## 14. Web workbench

### 14.1 Page layout

The left side selects projects and conversations inside a project, the middle is mainly the group chat and execution cards, and the right side offers node and workspace configuration. Roles are configured from the top of a conversation; detailed process, files and Git are reached from the execution details. Old execution records keep a history entry, and users need not fill in a separate task form.

| Page | What phase 1 must let the user do |
| --- | --- |
| Project | Create or attach a repository, choose the Home and execution nodes, switch projects |
| Conversation | Main group, task threads, direct chat, `@role`, attachments, history search inside a project |
| Execution details | From a conversation card see requirements, role, Run, waiting reason and deliverables; stop, approve; continue by new message or quoted reply |
| Agent | See role, runtime, model, node, known instruction sources, Skills, state and usage |
| Node | Registration, online state, concurrency, login checks, pause and revocation |
| Files | By node, repository, branch and task workspace, without composing a shared writable directory |
| Git | Baseline, task branch, commit, diff, review verdict and merge record |
| Settings | Personal notifications, project goal, role configuration, run configuration and channel binding |

A new specialist role can set its trigger and reply format. Phase 1 prefers manual `@`, task assignment and review triggers, and avoids listening to all messages.

### 14.2 Messages and attention items

Unified message blocks use `text`, `task_card`, `approval_card`, `file_card` and `diff_card`. Cards reference structured objects, and card text or an ordinary reply does not change task and approval state by itself.

The project collects items waiting for an answer, approval, review, blocked items and executions pending reconciliation. When a card is opened the reason and the next step are visible without reading the whole terminal log.

Token streams, heartbeats and fine-grained tool output only update state or run details. Completion, failure, pending approval and channel faults are the only things pushed, so the group chat is not flooded by high-frequency messages.

## 15. WeChat and phase 2 Feishu

### 15.1 Channel binding

A channel account, group or topic is bound to an explicit project conversation. External users are mapped to project members through explicit binding, and never merged automatically by nickname or avatar.

A project conversation can continue on the web and in IM, but each channel receives only what it is entitled to see. Agent direct chats and unshared tasks are not broadcast to the whole group automatically.

WeChat or Feishu credentials are stored only in the Gateway. Connection methods already verified elsewhere can be reused, but this product's identity, project binding and send/receive flow must be verified independently.

### 15.2 Login state and alerts

The Gateway connection, the WeChat login state, the last normal send/receive and the pending messages are shown separately. A live process cannot replace a channel health check.

When a re-login is needed it is marked on the web with an alert, and a human completes the login. Failed messages keep their state, and after recovery only results that are still valid are sent. Messages whose delivery is uncertain are handled as in chapter 9 and are not resent endlessly.

Phase 2 Feishu follows the same message, task and permission rules and does not add another set of supervisor or session states.

## 16. Implementation milestones

### 16.1 Phase 1 first completes one visible real flow

| Milestone | Deliverable | Completion condition |
| --- | --- | --- |
| P1-M1 Managed execution | Minimal task page, Worker, first common runtime, task and Run registration | Start a remote CLI from the web, see events, stop confirmation is accurate, a repeated start command does not execute twice |
| P1-M2 Delivery and review | Independent worktrees, Git delivery, second runtime, Reviewer | Two machines complete development and fixed-commit review, a human checks the diff and accepts |
| P1-M3 Project workbench | Project switching, history, files, Git, roles and settings; one ACP instance | The same task flow runs on three verified configurations, with limits shown by capability |
| P1-M4 WeChat and exceptions | Conversation binding, message de-duplication, login-state check, durable queue, pause and revocation | Submitting from WeChat to web execution and reply is verifiable, and disconnections and unknown results are shown accurately |
| P1-M5 Manual primary/standby | Stop-and-export, state check, coordination handoff and address configuration | Manual handoff between two nodes completes after a safe stop; no replacement task starts when state is uncertain |

Message persistence, command registration and Session control are used from P1-M1, and later milestones complete the exception coverage step by step. No stage waits for all pages to be finished before starting real runtime verification.

### 16.2 Phase 2 improves according to use

| Milestone | Deliverable | Completion condition |
| --- | --- | --- |
| P2-M1 Feishu and members | Feishu binding, explicit identity association, basic multi-person permissions | Two members handle the same task from the web or IM, with permissions and version conflicts handled correctly |
| P2-M2 Adapters on demand | Connect the runtimes the user really wants, show capabilities and limits | Every new adapter passes start, input, stop, event and delivery acceptance; resume is verified as declared |
| P2-M3 Daily use | Saving project Skill methods, configuration priorities, handoff and state experience | Tasks are repeatedly completed in a real project with less manual context transfer, and feedback is recorded |

Phase 2 does not require three-node election, automatic preemption, support for all CLIs, A2A or complex scoring. If these are wanted, confirm the concrete scenario and benefit separately.

## 17. Acceptance checklist

### 17.1 Normal business

| ID | Scenario | Pass condition |
| --- | --- | --- |
| A01 | Create a project on the web and bind a laptop and a Linux Worker | Repository, node, identity and actual login state are correct |
| A02 | Submit a clearly defined task from WeChat | It enters the right project and ordinary replies do not request approval repeatedly |
| A03 | Development and independent review | Workspaces are independent, the same commit is obtained across nodes, and the Reviewer returns evidence |
| A04 | Files, diff, history and role configuration | The user can locate the task source and result and see the actual known configuration |
| A05 | Add a specialist role | Duties, model, trigger and reply style are explicit; permissions do not widen automatically |
| A06 | Non-code delivery | A fixed-version file can be submitted and reviewed, with human confirmation |
| A07 | Manual handoff after stopping | The original Home stops coordinating, the data is usable, and dispatch resumes only after Workers connect to the new Home |
| A08 | Phase 2 Feishu and multiple people | Identity is bound after confirmation, an Observer cannot approve, and messages go only to the authorized scope |

### 17.2 Required exceptions

| ID | Scenario | Pass condition |
| --- | --- | --- |
| E01 | CLI started but the receipt was lost | The same `commandId` returns the original Run and no second process starts |
| E02 | Worker disconnects or crashes | Pending reconciliation first; interrupted only after the process exit is confirmed |
| E03 | Node lost during a stop request | Shows waiting for confirmation and not stopped |
| E04 | One Session receives two driving requests | Only one effective driver, and a read-only external session cannot be injected |
| E05 | Code or task requirements change after review | The corresponding review is invalidated and the old verdict cannot be reused |
| E06 | Duplicate messages, out-of-order events or reconnect | Events are de-duplicated and old state does not overwrite new state |
| E07 | Approval expired or parameters replaced | The executor rejects it; retrying an already executed command returns only the original result |
| E08 | Queued commands exist during pause or revocation | New executions are rejected, while stop and result reporting remain available |
| E09 | WeChat login expired or a send receipt is unclear | A web alert appears; unknown sends are not resent blindly |
| E10 | Two projects use one node at the same time | The Worker enforces the total concurrency limit and the rest queue |
| E11 | Two people reassign or cancel at the same time | Only the valid change by permission and task version is accepted |
| E12 | The original Home is unreachable and data is insufficient | Explicitly wait for manual recovery, and do not claim the standby has fully taken over |

These are acceptance cases for concrete features and do not grow into a fault-drill platform of their own. Simulated tests verify state boundaries; key flows must be run against real CLIs, Git and IM.

## 18. Reference designs and maintenance rules

The directions come from earlier product research. The links below only help trace the design thinking; they do not mean the projects are integrated here, and they do not replace version verification at implementation time.

| Reference | Idea adopted |
| --- | --- |
| [Grok Bot](https://docs.x.ai/grok-bot/chat-and-collaboration) | Stable roles, visible handoffs, threads and a few necessary notifications |
| [Paperclip](https://github.com/paperclipai/paperclip/blob/master/docs/guides/agent-developer/heartbeat-protocol.md) | Atomic claiming, execution records, event wake-ups |
| [AgentTeams](https://github.com/agentscope-ai/AgentTeams/blob/main/docs/overview.md) | Human-visible supervisor and executor collaboration |
| [OpenClaw](https://docs.openclaw.ai/concepts/messages) | Channel routing, message de-duplication and session binding |
| [Agent Kanban](https://github.com/saltbo/agent-kanban) | Machine Worker, real CLI and task association |
| [Command Center](https://github.com/cgeene/commandcenter) | Independent review and fixed-version delivery |

This document keeps only the current plan. When a concrete interface schema is needed later, add a detailed design and reference it from here, and do not maintain the same rules in several documents. Implementation progress is shown by the actual project artifacts; document goals must not be taken as completed capabilities.
