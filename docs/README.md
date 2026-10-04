# Documentation Index

| Document | Purpose | Status |
| --- | --- | --- |
| [OPERATING-GUIDE](OPERATING-GUIDE.md) | Publishing, configuration, running single and multi-server setups, contributing, sanitization checklist | Current |
| [ARCHITECTURE](ARCHITECTURE.md) | Current code architecture, interfaces, data and implementation boundaries | Current. Describes only what the code does |
| [PRD](PRD.md) | Product goals, phase scope, business rules and acceptance direction | Scope reference. Not everything is implemented |
| [design-coordination](design-coordination.md) | Supervisor, templates, custom roles, optional plans and fixed-version hand-off | Design. Partly implemented; see ARCHITECTURE |
| [design-local-supervisor](design-local-supervisor.md) | Project supervisor, multi-repository setup, device and account configuration assistant | Implemented in the current code |
| [design-supervisor-timers](design-supervisor-timers.md) | `wb timer` scheduled jobs and low-cost progress patrol | Implemented in the current code |
| [design-session-handoff](design-session-handoff.md) | Controlled cross-device role session handoff | Proposal. Not implemented |

Start with the README, then ARCHITECTURE. Read the PRD when you need the full product scope. ARCHITECTURE describes the actual code only and never treats a plan as a feature. Design documents may describe intended behavior; where they disagree with the code, the code is the fact.
