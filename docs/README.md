# Documentation Index

| Document | Purpose | Status |
| --- | --- | --- |
| [design-lazy-native-tools](design-lazy-native-tools.md) | Native history summaries, on-demand tool details and bounded recent cache | Locally implemented; verification evidence recorded separately; not deployed |
| [design-review-delivery](design-review-delivery.md) | Fixed review refs, baseline-preserving reception and isolated review sessions | Locally implemented, independently reviewed and isolated-tested; not deployed |
| [design-runtime-quota-events](design-runtime-quota-events.md) | Passive Claude/Codex quota, snapshot ownership and freshness; unchanged UI | Implemented on the feature branch; isolated checks, not deployed |
| [plan-runtime-quota-events](plan-runtime-quota-events.md) | Adapter events, Worker/Home snapshots and removal of extra quota queries | Local implementation; real-account acceptance and independent review pending |
| [design-remote-access-settings](design-remote-access-settings.md) | Local-only Basic Settings controls for the independent browser relay | Approved; implemented in the feature branch, deployment separate |
| [plan-remote-access-settings](plan-remote-access-settings.md) | Module packaging, local proof/bridge, compact UI, review and Home-only release | Approved; execution in progress |
| [OPERATING-GUIDE](OPERATING-GUIDE.md) | Publishing, configuration, running single and multi-server setups, contributing, sanitization checklist | Current |
| [ARCHITECTURE](ARCHITECTURE.md) | Current code architecture, interfaces, data and implementation boundaries | Current. Describes only what the code does |
| [PROGRESS](PROGRESS.md) | Append-only development changes and verification milestones | Current; does not imply public release or deployment |
| [PRD](PRD.md) | Product goals, phase scope, business rules and acceptance direction | Scope reference. Not everything is implemented |
| [design-coordination](design-coordination.md) | Supervisor, templates, custom roles, optional plans and fixed-version hand-off | Design. Partly implemented; see ARCHITECTURE |
| [design-parallel-conversations](design-parallel-conversations.md) | Fresh parallel group chats sharing a project, plus team-only copying into empty projects | Specification approved; implementation plans await review. Not implemented |
| [plan-parallel-conversations](plan-parallel-conversations.md) | Conversation identity, context/tool isolation, collaboration, automatic work and parallel-chat UI | Implementation plan awaiting review; not implemented |
| [plan-team-project-copy](plan-team-project-copy.md) | Frozen team snapshots, strict empty-folder provisioning, retry receipts and copy UI | Separate implementation plan awaiting review; follows the parallel-chat increment |
| [design-local-supervisor](design-local-supervisor.md) | Project supervisor, multi-repository setup, device and account configuration assistant | Implemented in the current code |
| [design-role-responsibility](design-role-responsibility.md) | Separate coordination responsibilities from execution prompts, snapshot compatibility and acceptance coverage | Implemented; runtime limits recorded in section 11 |
| [design-role-permissions](design-role-permissions.md) | Three per-role CLI permission scopes, one-time approval, legacy preservation and real execution acceptance | Written specification awaiting user review; not implemented |
| [design-local-folder-selection](design-local-folder-selection.md) | Browse accessible local folders while granting only the selected project/session directory | Locally implemented and verified; review fixes tested; not deployed |
| [plan-local-folder-selection](plan-local-folder-selection.md) | Scoped authorization, creation forms and isolated acceptance | Executed inline; failed preparation cleanup and retry verified locally |
| [plan-collaboration-wait-yield](plan-collaboration-wait-yield.md) | Historical proposal for non-destructive manual yield | Archived; not implementation authority. Explicit Steer interrupts; ordinary messages queue. |
| [plan-role-responsibility](plan-role-responsibility.md) | Ordered implementation tasks and negative tests for excluding self responsibility from execution | Executed inline; design records actual verification coverage |
| [design-minimal-injection](design-minimal-injection.md) | Four-adapter minimal input, trusted discovery and reliable continuation | Selectively deployed; adapter-specific acceptance limits are recorded |
| [plan-minimal-injection](plan-minimal-injection.md) | Unified implementation and verification of minimal execution context | Implemented; source synchronization excluded |
| [design-role-cli-switch](design-role-cli-switch.md) | Reversible same-device CLI handoff and staged verification | Codex/Grok implemented; Claude/Agy switching not yet supported |
| [plan-role-cli-switch](plan-role-cli-switch.md) | Implementation and acceptance of safe role CLI changes | Selectively deployed; supported scope is recorded in the design |
| [design-supervisor-timers](design-supervisor-timers.md) | `wb timer` scheduled jobs and low-cost progress patrol | Implemented in the current code |
| [design-supervisor-proactive-followup](design-supervisor-proactive-followup.md) | Direct supervisor follow-up after configurable chat silence (default ten minutes), with future IM assistance notifications (Chinese) | Implemented and release-verified; not automatically enabled on real projects |
| [plan-supervisor-proactive-followup](plan-supervisor-proactive-followup.md) | Implementation mapping and acceptance for direct supervisor silence follow-up (Chinese) | Executed inline with independent review; release excluded |
| [design-session-handoff](design-session-handoff.md) | Controlled cross-device role session handoff | Proposal. Not implemented |
| [design-cross-device-execution](design-cross-device-execution.md) | Q/F routing and saved-code execution: fixed inputs, accessible base selection, staged read-only work, explicit write-observation limits and bounded resources | User-approved specification v2.3.1 is unchanged; only P1 implemented per its plan, later phases remain proposals. Candidate performance targets are not production guarantees |
| [plan-cross-device-execution-p1](plan-cross-device-execution-p1.md) | First Q/F increment: registered sources, safe file replies and durable request replay | P1 implemented with independent review and isolated actual Mac/Linux/browser checks; integrated into the publication branch. Production deployment and enablement remain separate |
| [design-cli-session-recovery](design-cli-session-recovery.md) | Verified idle reclaim, human confirmation and same-native-session recovery | Implemented; independent, isolated and release verification |
| [design-native-session-browser](design-native-session-browser.md) | Group chats / Sessions navigation, read-only native histories and iTerm/SSH entry | Feature-branch implementation; not deployed; binary-history and GUI acceptance limits recorded |
| [design-native-agent-switch](design-native-agent-switch.md) | Agent switch icon and Agent picker dialog with one conversation, original history and same-directory context handoff | Approved design; local implementation under acceptance, not deployed |
| [plan-native-agent-switch](plan-native-agent-switch.md) | Safety, factual context delivery, switch icon and Agent picker dialog/timeline integration and real adapter acceptance | Approved inline plan; local acceptance in progress; no production changes |
| [session-queue-v3](design/session-queue-v3.md) | Authoritative conversation collaboration and external CLI queue contract | Approved V3; opt-in implementation |
| [session-queue-v3-acceptance](design/session-queue-v3-acceptance.md) | Repair verification, runtime results and remaining drill limits | Isolated-tested and release-verified; no automatic project activation |
| [session-queue-v3-audit](design/session-queue-v3-audit.md) / [merge-order](design/session-queue-v3-merge-order.md) | Historical phased audit and merge sequence | Archived; not implementation guidance |

| [design-source-sync](design-source-sync.md) | Single authority for project-file sync, safe apply, conflicts and continuous folders | Implemented; legacy and directory acceptance limits are recorded separately |
| [plan-source-sync](plan-source-sync.md) | Source synchronization implementation and verification gates | Archived implementation plan; current contract is design-source-sync |
| [plan-source-sync-metadata](plan-source-sync-metadata.md) | Metadata hash reuse, independent full reconciliation and load pacing | Implemented and independently reviewed; isolated Mac/Linux verification, not deployed |
| [design-shared-documents](design-shared-documents.md) | Actual Mac-local file reading, document links and Resources integration; consumes unified project-file sync | Implemented; physical Mac/Linux and browser verification, no separate synchronizer |
| [plan-project-file-sync](plan-project-file-sync.md) | Unified directory scopes, background synchronization and actual Mac file reading | Completed; local/remote release and selective project activation verified |
| [plan-source-sync-outputs](plan-source-sync-outputs.md) | Opt-in source/output policy, preview privacy, limit evidence and device-specific handoffs | Implemented locally with isolated verification; not deployed or enabled on business projects |

Start with the README, then ARCHITECTURE. Read the PRD when you need the full product scope. ARCHITECTURE describes the actual code only and never treats a plan as a feature. Design documents may describe intended behavior; where they disagree with the code, the code is the fact.
