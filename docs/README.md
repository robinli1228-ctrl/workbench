# Documentation Index

| Document | Purpose | Status |
| --- | --- | --- |
| [OPERATING-GUIDE](OPERATING-GUIDE.md) | Publishing, configuration, running single and multi-server setups, contributing, sanitization checklist | Current |
| [ARCHITECTURE](ARCHITECTURE.md) | Current code architecture, interfaces, data and implementation boundaries | Current. Describes only what the code does |
| [PRD](PRD.md) | Product goals, phase scope, business rules and acceptance direction | Scope reference. Not everything is implemented |
| [design-coordination](design-coordination.md) | Supervisor, templates, custom roles, optional plans and fixed-version hand-off | Design. Partly implemented; see ARCHITECTURE |
| [design-local-supervisor](design-local-supervisor.md) | Project supervisor, multi-repository setup, device and account configuration assistant | Implemented in the current code |
| [design-role-responsibility](design-role-responsibility.md) | Separate coordination responsibilities from execution prompts, snapshot compatibility and acceptance coverage | Implemented; runtime limits recorded in section 11 |
| [plan-role-responsibility](plan-role-responsibility.md) | Ordered implementation tasks and negative tests for excluding self responsibility from execution | Executed inline; design records actual verification coverage |
| [design-minimal-injection](design-minimal-injection.md) | Four-adapter minimal input, trusted discovery and reliable continuation | Selectively deployed; adapter-specific acceptance limits are recorded |
| [plan-minimal-injection](plan-minimal-injection.md) | Unified implementation and verification of minimal execution context | Implemented; source synchronization excluded |
| [design-role-cli-switch](design-role-cli-switch.md) | Reversible same-device CLI handoff and staged verification | Codex/Grok implemented; Claude/Agy switching not yet supported |
| [plan-role-cli-switch](plan-role-cli-switch.md) | Implementation and acceptance of safe role CLI changes | Selectively deployed; supported scope is recorded in the design |
| [design-supervisor-timers](design-supervisor-timers.md) | `wb timer` scheduled jobs and low-cost progress patrol | Implemented in the current code |
| [design-session-handoff](design-session-handoff.md) | Controlled cross-device role session handoff | Proposal. Not implemented |

Start with the README, then ARCHITECTURE. Read the PRD when you need the full product scope. ARCHITECTURE describes the actual code only and never treats a plan as a feature. Design documents may describe intended behavior; where they disagree with the code, the code is the fact.
