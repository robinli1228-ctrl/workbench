# AGENTS.md

## Project goal

This project builds a distributed multi-agent collaboration workbench. The user starts work from a project group chat with `@role`. The Home owns project state and scheduling. Workers running on different computers and servers launch real CLI runtimes and return the process and results to the same project conversation.

The purpose is to let several AI accounts (different vendors and models) work as roles that review and complement each other, to make good use of spare quota on each account, and to let multiple devices cooperate.

## Before you start

Read the documents in this order.

1. `README.md`: what runs today and how to start it.
2. `docs/ARCHITECTURE.md`: the actual code architecture and interface boundaries.
3. `docs/PRD.md`: the full product scope.
4. `docs/design-*.md`: design documents for specific areas. Several describe proposals that are not implemented; each states its status at the top.
5. `docs/OPERATING-GUIDE.md`: what may be committed, how to configure and run the project, and the pre-publish checklist.

When documents conflict, the actual code is the source of truth for what exists, and `docs/PRD.md` is the source of truth for product scope. Planned capabilities must never be described as completed features.

## Current implementation boundary

- Current version: `0.4.0`.
- Executable adapters: Codex (App Server), Grok Build, Antigravity and Claude Code. The last three run in print/stream mode with tool calls auto-approved and have no native per-step approval.
- Home and Worker run as independent processes and talk over an authenticated WebSocket.
- Project group chat supports `@role`, queueing, quoted hand-offs, run details, stop confirmation and attachments. A message without an `@` is stored but does not start a model (new projects route it to the project supervisor). Managed runs can use the built-in `wb` tool (history search, group notes, role consultation and task transfer, reminders, Git delivery requests). Project memory is the managed project's own `AGENTS.md` (plus a `CLAUDE.md` pointer), created only if absent and committed alone in Git repositories; any role may update it. Workbench keeps no separate memory. Registered fixed-commit deliveries are automatically approved for their dedicated delivery branches after source success; main merges and deployment still require explicit authorization. Enabled source-sync projects expose scoped wb sync requests; this is not permission for arbitrary pull, push or directory copying. Every turn should end with a written hand-off under `.workbench/handoffs/`.
- A project can bind a different local directory per device. Code tasks run in separate Git worktrees.
- Not done: other ACP runtimes, Feishu, multi-user identity, manual primary/standby Home switch-over, controlled cross-device session handoff (design only).

## Current platform decisions

- Distinguish deployed software, bound project baseline and the Run's actual input version. A resumed native session keeps its directory; never silently replace its code with a newer binding or claim directory synchronization updates old worktrees.
- Code work must name and check its input version. Fixed-version admission blocks a mismatch before model input; authorized writing-stage continuations may keep their verified outputs. Do not add background polling to implement this check.
- Independent review is read-only. Outstanding mandatory corrections are `failed`, unavailable evidence is `blocked`, and user choices are `needs_input`; `passed` permits only nonblocking suggestions. Preserve original reports and runtime failures.
- Re-review a numbered change/disposition list and its exact version, reading affected context when needed. Keep material references scoped and versioned; do not expose unreleased independent opinions.
- Role responsibilities and execution instructions are distinct. Five presets ship: planning, execution, review and testing provide responsibilities only; cross-device includes execution instructions. Templates can be edited and restored, not deleted. Template edits affect future role creation, not existing roles. Do not overwrite custom or explicitly empty components, and do not assume old worktrees reload a newer AGENTS.md.
- Keep the current send-only Traditional Chinese prose conversion; preserving all user prose verbatim was explicitly deferred. Stored originals, exact quoted strings, code and paths remain unchanged.

## Development constraints

- Use JavaScript, ESM and Node.js 22. Do not introduce TypeScript or a front-end build step.
- Extend the existing Home, Worker, Room and runtime adapter code. Do not create a second control plane.
- Handle task state, run state and Worker online state separately.
- A runtime exiting successfully only means one execution ended. It does not mean the work was accepted.
- Never share writable directories across devices. Git commits remain the formal delivery path. Explicitly enabled source synchronization can exchange saved uncommitted files between independent bound directories; follow `docs/design-source-sync.md` and its measured acceptance limits. Do not enable it on business projects as a side effect of software installation.
- Never commit `.data/`, `.local/`, `.worktrees/`, `.workbench/`, `node_modules/`, logs, tokens or account credentials. Never write real host names, IP addresses, user names, absolute personal paths or account identifiers into code, docs or tests; use `xxxxx` in examples.
- Keep changes focused. Preserve existing data compatibility and verified flows.
- Report the different states of a feature precisely: code written, committed, deployed, automatically checked and manually verified.
- Test scripts and isolated data are for local verification only. Delete them afterwards or keep them in an ignored directory.

## Before committing

Run at least:

```sh
npm ci
npm run check
git diff --check
```

For changes that touch the Home, Worker, runtimes, the browser or cross-machine behavior, also run a matching real verification in an isolated project and describe the result in the pull request. Update `README.md` and `docs/ARCHITECTURE.md` when the current facts they describe change. Add new source files to the `check` script in `package.json`.
