English | [简体中文](README.zh-CN.md)

# Agent Collaboration Workbench

A self-hosted project group chat for the AI coding CLIs and subscriptions you already use. Codex, Claude Code, Grok Build and Antigravity run as configurable roles on your Mac or servers; Home owns records and coordination, while Workers drive the real native CLIs.

> Development preview (`0.4.0`), for a single trusted operator or a small trusted team. Workbench does not proxy model APIs or replace native instructions, login or tools.

## What the current version provides

- **Role-based collaboration.** Direct user assignments, supervisor coordination and role-to-role consultation through one `wb` entry. Keep role responsibilities separate from optional execution prompts; discover team, history, reports and user-confirmation tools on demand.
- **External conversation queues.** Opt-in V3 sessions collect outside busy CLIs and deliver merged batches only at a verified input boundary. Original requests, waits and late replies stay linked; necessary resumption does not consume a new propagation charge. Explicit `wb note` / `wb chat post` publishes discussion output, while native streams and final answers remain in execution details.
- **Independent review.** Workbench history, derived inputs and managed document reads remain isolated until explicit release. This is not an OS sandbox and cannot erase previously seen native context.
- **Actual local project files.** Resources and document links resolve bound Mac files by repository scope and relative path, independently of the sync switch. Opt-in saved-source/document/resource sync runs in the background, preserves conflicting versions and rechecks before writing. Git commits, review and merge remain separate.
- **Visible progress and usable UI.** Read-only live input/output/tool events, execution-only progress labels, quota reset details, local file availability and compact attachment previews. Source-tracked Runs log pre-input file-verification time separately from CLI/model work. Basic Settings tabs stay sticky; supervisor role settings remain separate from project settings.
- **Safe session operation.** Device capacity limits, five-minute idle reuse, verified leftover-process recovery and human confirmation before interrupting old work. Optional supervisor follow-up after chat silence defaults off and does not expand user authorization.

Installation does not enable collaboration broadcast, file synchronization or proactive follow-up on business projects. V3 broadcast remains test-project restricted. See [V3 design and measured acceptance](docs/design/session-queue-v3-acceptance.md), [file-sync contract](docs/design-source-sync.md), [CLI recovery](docs/design-cli-session-recovery.md) and [limitations](#limitations-and-roadmap) before enabling or exposing the service.

## Why this exists

Dropdown controls share a white, fine-bordered popup with indigo selection and checkmarks across settings, roles, devices and dynamic dialogs. Models and longer lists support search; native form values, validation and change handlers remain intact, with keyboard and mobile interaction supported.

Project file-sync settings now offer **Source only** (the unchanged default) and opt-in **Source and outputs**. The latter includes eligible Git-ignored reports, logs, coverage, `.local` and `.workbench` artifacts after a metadata-only preview. Version-control files, local runtime state, dependencies, credentials and CLI login folders stay excluded; `build/` and `dist/` also stay off. Both Workers must support the new policy. Existing projects are not migrated automatically. See [output policy and limits](docs/design-source-sync.md#14-opt-in-source-and-outputs-policy) before enabling it.

The opt-in **Project file sync** card under Resources now supports automatic two-way synchronization of saved code, shared documents and necessary resources. Preview the project/repository scopes, select participating devices and a display Mac, then enable the reviewed scope. Workers continue observing and transferring while the page is closed; Resources and document links read the selected Mac's actual project files, not a Home-private copy. Conflicts retain both versions and use evidence-based owner notification, independent candidate acceptance and fresh receiving-file checks. Git commits, branches, review, merge and rollback remain separate; isolated outputs must be delivered to the project folder first. Existing policy-2 repository scopes retain their explicit-trigger semantics until migrated, and installing this version does not activate business projects. See the [contract and measured acceptance limits](docs/design-source-sync.md#13-unified-continuous-project-file-synchronization).

Local file viewing does not require synchronization to be enabled. A configured display Mac is retained; before configuration, exactly one bound Mac can be discovered without assuming Home is that device. Registered repository baselines, including read-only reference repositories, can be read by scope ID and relative path; arbitrary isolated worktrees cannot. Recent Outputs marks completed write evidence separately from reply references, shows confirmed Mac paths and file availability/sync errors, and does not attribute citations to a modifying CLI.

The project started from a practical situation: one person, several AI subscriptions (different vendors and models), and several machines.

- **Different models review and complement each other.** One model writes the code, another reviews it from a different angle, a third plans or tests. Each is a *role* with its own CLI, model and prompt. Independent review of a pinned Git commit is a first-class workflow.
- **Use the quota you already pay for.** Most accounts have unused tokens at the end of a period. Because a role is just "this CLI + this model + this machine", you decide how work is spread across accounts and can change that allocation at any time by editing a role. Token statistics and, where the CLI exposes it, remaining quota are shown next to the roles so the split can be adjusted deliberately.
- **Multiple servers and devices work together.** A *Home* node keeps the project state, and any number of *Worker* nodes (your laptop, a Linux server, a cloud box) connect to it and run the CLIs installed there. Code moves between devices as fixed Git commits, files move as attachments, and a supervisor role can coordinate roles that live on different machines.

The workbench does not replace the CLIs and does not proxy model APIs. It drives the CLIs you have already installed and logged in to, and it stores no vendor credentials of its own.

## Language

Project Settings uses four sticky tabs: Basic information, Repositories and workspace, File sync, and Collaboration and scheduling. Switching tabs preserves unsaved inputs; each section retains its own save and feedback. Project file sync is available from Project Settings and Resources. Clicking the supervisor card opens a separate Role Details dialog with the same settings/history tabs and layout as other roles; project configuration remains in Project Settings.

Application dialogs share a compact white style with small corners, neutral close icons and blue primary actions. Role settings and history tabs sit directly in the header and preserve unsaved inputs when switching. Long forms retain visible actions; browser-native confirmation and system file dialogs keep their original behavior.

Basic Settings, Token Usage, Project Settings and Scheduled Jobs use the same visual language with flat white cards. Settings tabs sit in the sticky title bar instead of a separate row and scroll horizontally on narrow screens. These remain full pages with their existing saves and statistics; this styling does not change collection, dispatch or backend behavior.

The **Basic Settings** tab groups language (English / 简体中文), browser API Token, WeChat notifications and the remote execution switch. Notifications select an already configured **platform · account**, not a project. Enabling exposes `wb notify` to each project's fixed supervisor only; it does not automatically forward reports or approvals. Messages identify their actual project, and numbered replies queue to the original supervisor without interrupting a running CLI. Existing records keep their original channel. See the [notification contract](docs/ARCHITECTURE.md#optional-wechat-numbered-channel) for private account configuration. The verified Home access token is saved in this browser and reused after closing and reopening it; edit it in Basic Settings when needed. Use a trusted browser profile: clearing site data, private browsing or switching to a different browser/address can require setup again. Language localizes the UI and displayed defaults, independently of model-facing instruction language. This README and the [operating guide](docs/OPERATING-GUIDE.md) are also available in Simplified Chinese: [README.zh-CN.md](README.zh-CN.md) and [docs/OPERATING-GUIDE.zh-CN.md](docs/OPERATING-GUIDE.zh-CN.md).

Project names remain user-defined text in the sidebar, its accessible labels and the workspace heading; switching the interface language does not rename them.

Managed dialogue inputs for Codex, Claude Code, Grok and Antigravity use English Workbench-maintained execution templates and a send-only Traditional Chinese prose copy. Chat records and saved custom prompts stay unchanged; custom prompts are not translated to English. Code, commands, paths, identifiers and exact quoted strings are preserved. The same policy applies to later turns and configuration events without an extra model call. It does not rewrite native history, attachments, tool results or text typed directly in an SSH terminal, and requires this Worker version on each execution device.

At task startup, the Worker records each actual execution repository's directory, full HEAD and dirty state separately from the current project binding's HEAD. Retained sessions keep their original directories; a missing or unrelated old repository is not replaced with the newer project copy. A structured fixed-version mismatch stops that launch before model input, without pulling, switching directories or changing another task. Writing-stage continuations can retain their verified committed outputs. Execution details show the actual input version; this point-in-time snapshot adds no background polling or remote fetch.

Minimal input still includes the short maintained stage boundaries and required-report entry. Independent review is read-only: outstanding mandatory corrections mean `failed`, unavailable verification means `blocked`, user decisions mean `needs_input`, and only nonblocking suggestions may accompany `passed`. Default collaboration guidance references scoped materials by path/hash, uses numbered repair dispositions and tracks blocker ownership. Exact previous built-in prompt defaults upgrade; custom and explicitly empty prompts, admitted instruction snapshots and historical reports remain unchanged.

## Key features

Resolved role recipients appear as blue labels inline with the message body. The composer highlights known `@role` names with the same blue frame while keeping the native textarea and plaintext message format. Backspace, Delete, partial selections and cut/replacement consume a complete role label; ordinary prose, IME composition and existing mention routing remain supported.

Role cards, group-chat entries and native-session entries support press-and-hold dragging to reorder. Quick swipes still scroll; dragging near a list edge scrolls it, and releasing saves the order in this browser. Role order is per project and the fixed supervisor stays first. Session filtering preserves hidden entries' positions. Sorting changes only presentation, not role configuration, scheduling or native history.

**Devices and CLIs** also allows removal of an unavailable CLI entry from one device's catalog. This preference survives refreshes while the CLI remains unavailable; a later successful availability check shows it again. Installed software and native histories are retained.

The configuration assistant uses one conversation with a compact runtime selector and inline pending suggestions. Its maintained instructions cover device onboarding, CLI/login readiness, hosting, project folders, roles/defaults and the available configuration tools. There is no separate recent-conversation or prompt-preview panel. Offline device cards support deletion after the Worker is disconnected and unfinished work is settled. Deletion forgets the registration and its saved connection credential, preserves files and historical records, and does not reassign project bindings. A saved removal record rejects automatic reconnection under the old node identity.

Role cards include a small number-free context-used ring after the model name, separate from account quota remaining. Claude uses the latest main-request input and the native resolved model window; Codex uses its latest-request input and reported window. Hover or tap for percentage, token counts and measurement time. Unknown limits, unsupported CLI telemetry and pre-upgrade history show an unknown ring, not a guessed percentage. This is passive telemetry; it does not call models or compact sessions.

Quota checks do not submit model turns. Codex and Grok use account-status interfaces; Agy uses its built-in usage/credit commands. Both Claude quota-query paths set `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1` only for the probe subprocess, so supported Claude versions do not save these disposable queries as resumable histories. Ordinary conversation history remains enabled. Missing quota values stay unavailable rather than being guessed.

The sidebar switches between **Group chats** and **Sessions** without changing the three-column layout. Text tabs use a blue active underline over a full-width gray divider, alongside a borderless single-bubble new-conversation button. Project rows use unboxed outline icons and a pale blue selected state; footer controls are unchanged. Sessions defaults to All sessions and All Agents, combining dialog-created entries, independent native histories and group sessions across devices. Compact source/device and Agent filters expose group histories separately from independent local/server/other-device sessions. Operations and returning from iTerm refresh the view automatically; histories are not deleted. New sessions choose a title, device, tool, folder and an explicit optional permission bypass. Existing sessions can continue in iTerm or through an explicitly confirmed page takeover, without Workbench role prompt injection. Page takeover supports streamed replies, attachments, stopping a turn and ending takeover; Codex, Claude and Agy retain a CLI process where supported, while Grok resumes per turn. Agy binary histories currently show metadata only. Catalogue reads require capability 2; safe page takeover requires `nativeTurns:3`. Exact native-ID association and verification limits are described in [native session browser](docs/design-native-session-browser.md).

Session details now show terminal occupancy and offer Return to platform or confirmed Stop CLI and return. Exact native identity preserves the original group association after a folder move; unknown or conflicting ownership blocks takeover. Home and Worker must both support the updated takeover contract. These controls reuse automatic return and do not add polling.

The role terminal dialog shows the latest historical session without a dropdown and keeps older records intact. **Open new session** reuses the independent native-session form with the role's device and CLI preselected; the folder is chosen separately, and no group history or role prompt is supplied. **Verify and resume history** retains the existing exact-session checks and terminal return controls.

Task progress uses six labels: **Pending execution, In progress, Waiting, Completed, Stopped, Execution error**. A normally delivered review is completed even when its business verdict is negative; verdicts remain in the reply and delivery report. Waiting reasons and execution errors stay visible, and process stop must be confirmed. Existing plan policies and acceptance actions are unchanged; old records are not rewritten or automatically retried.

Execution details include an **Result original** tab after **Artifacts**, replacing the separate execution-result original button and dialog. It reads the selected Run's stored text on demand, with paged loading and exact full-text copying. Ordinary message originals and quotations still refer to their own message records.

Chinese prose is displayed in Simplified Chinese in chat (including user messages and quotations), live/fullscreen replies, execution output and Markdown previews. This browser-only character conversion uses a bundled OpenCC dictionary without translating English or making a model/CDN request. Code, commands, paths, editable input, original-text views, copies and stored records retain their original content.

Chat message bodies retain their compact height and scroll internally when longer, rather than clipping after ten lines. Refreshes preserve each message's reading position; the existing full-screen action remains available for long replies.

Directed role questions and published replies appear as individual chat bubbles with sender → recipient, content and time. Replies after a wait retain the original recipient even when the question is on an older history page. The question's Original button opens that message, not its sender's Run result. This display does not change dispatch, waiting, independent-review visibility or explicit-publication rules.

For document consultations, `wb call ... --text "review this document" --file path/to/document.md` reads the UTF-8 file directly, attaches its exact text and SHA256 as quoted reference data, and keeps the existing 12000-character call limit. It does not transfer or overwrite a peer's workspace. Larger shared documents should be referenced for on-demand reading; protected independent reviews keep their original document-read boundary. Retained Agy processes use the supplied `wb --turn RUN_ID ...` entry: old turn IDs never follow a new turn. `wb help` remains usable with an expired context, and a saved report receipt explicitly distinguishes registration from the later end of the CLI turn.

Token Usage retains the device-composition comparison and uses one daily chart stacked by model across the two selected devices. Colors identify models; segment tooltips show their tokens, and column tooltips show the day's total. Saved ccusage model breakdowns use the same input/output/cache total as the device charts. A single recorded model can account for an unambiguous historical total; missing or inconsistent multi-model shares remain unclassified until available details are backfilled, never divided equally or guessed.

All items below exist in the current code. Items that are only designed are listed separately under [Limitations and roadmap](#limitations-and-roadmap).

**Collaboration**

- Project group chat with `@role` dispatch. Explicit mentions create separate tasks for each distinct recipient, up to four, without automatic supervisor rerouting. Replying defaults to the quoted agent unless explicit mentions override it; replies to humans remain quotations. Busy roles keep their normal queue. Ordinary agent messages do not implicitly dispatch work. Explicitly enabled collaboration-session broadcast can queue a discussion batch; it never appends to a busy CLI or changes task ownership.
- Per-project roles with their own device, CLI, model, reasoning effort and Markdown prompt. Eight responsibility-only templates retain empty execution prompts. Opt-in Cross-Device, Local-Developer and Local-Tester presets include editable execution prompts for their workflows. Templates are managed under Settings → Platform Prompts → Role Templates (add, edit, delete, restore built-ins); changes affect only roles created later and never create project seats automatically.
- Same-device Codex/Grok changes use **Handoff and switch** in either role editor: retain identity/history, drain accepted work, verify a new native session and commit only after process settlement. Cancel before commit keeps the original binding. Requires a compatible Worker; other adapters are explicitly unverified. See [CLI switch design](docs/design-role-cli-switch.md) for current acceptance status.
- CLI switch settlement, native-history admission, terminal release and Worker restart reconciliation distinguish the saved process startup from a reused PID. Confirmed foreign processes do not occupy an old session; ambiguous legacy launchers still wait safely. Saved tool children remain checked, and these checks never signal unrelated processes or delete history. Updating a running Worker is a separate release step.
- Role names are mention identifiers (letters, digits, underscores or hyphens, without spaces); `all` and `everyone` are reserved for broadcasts. Existing role names are kept verbatim. Default intake follows the configured supervisor ID, not an English display name, and mentions support both ASCII and full-width punctuation.
- A fixed per-project *supervisor* that receives new unquoted requests without an `@`, proposes repository/role configuration cards (applied only after you confirm) and can schedule multi-stage work (`wb schedule`) with parallel independent reviews and sequential or merge stages. Its card is pinned above the work roles; click it to configure its device, CLI, model and reasoning effort in Role Details.
- Structured role-to-role tools exposed to every managed CLI through one `wb` command: consult another role (`wb call` / `wb wait`), report a business verdict (`wb report`), write a hand-off note (`wb handoff`), and request a Git delivery (`wb deliver`). An `@` inside model output never dispatches work.
- One `wb call` can address one or more roles: repeat `--role` for the same instruction. It creates one visible message with separate recipient requests and replies; retrying the same ID does not send duplicates. The sent card is completed once accepted, while each recipient's reply shows its own execution progress. Quotations and recipients appear above the body, with type/status and actions inside the card footer.
- Queueing, per-role and per-node concurrency limits, cancel, "steer now" for queued human messages, pause for remote dispatch, and explicit stop with confirmation from the Worker.
- Native session resume: each role keeps its vendor session across turns, with a background conversation organizer that keeps a shared project summary.
- Optional, off by default: peer discussion preview (`WB_DISCUSSION_PREVIEW`).

**Multi-device**

- Q/F reads: managed `wb read source|query|file <JSON>` discovers registered sources and reads current saved bytes without synchronization, Git-clean checks or execution copies. Projects default off; the authenticated `read-access` API grants explicit nodes/scopes and the two fixed read-only recipes. Identical request IDs replay the original observation; a new ID requests new facts. Replies and stored results are bounded. Cache fill, materialization and S execution are not implemented. See [the P1 plan](docs/plan-cross-device-execution-p1.md) for verification and deployment status.
- Home/Worker split over an authenticated WebSocket. Workers connect outward; the Home never reaches into a machine.
- Reliable delivery: persistent command and event outbox, idempotent command IDs, reconcile-on-reconnect, and no automatic re-run of executions whose state is unknown.
- Per-device project directories and a long-lived project baseline branch per repository (Git worktrees), with fixed-SHA cross-device delivery that requires an explicit confirmation before pushing.
- Attachments (images and files, up to 6 per message, 20 MB each) with SHA-256 verification, and a "send to device" action for moving a file to another bound device.
- Device onboarding helper over SSH (installs and connects a Worker on a remote Linux machine) and an optional Home-managed reverse SSH tunnel.
- Remote desktop from a macOS Home: check the registered server's xrdp, create a loopback SSH forward or reuse a verified existing same-user forward, then open Windows App's saved connections. Unknown or ambiguous listeners remain blocked; externally managed tunnels are never stopped by this entry. Opening the app does not verify desktop login.
- Terminal takeover: continue a finished native session in iTerm (macOS entry point; remote devices are reached over your own SSH configuration), with the platform pausing dispatch on that device while you work.

**Operations**

- Scheduled jobs (once, interval, daily, weekly) and a model-free progress patrol that only wakes the supervisor on new anomalies (`wb timer`).
- Token usage statistics per device, collected with `ccusage`, with daily columns stacked by model across the selected devices.
- GitHub and Gitee account storage and optional repository creation (private by default).
- Installable PWA shell, desktop three-column layout and a mobile drawer layout.
- State reads time out after 20 seconds and recover automatically without replaying task submissions. Returning to the page or reconnecting refreshes state while preserving drafts; connection details show the last successful update.
- Buffered static text and state/chat reads negotiate gzip to reduce SSH transfer overhead; streaming events and attachments are unchanged. Small page icons use the existing 192px asset, and optional high-resolution images are not eagerly downloaded for offline-shell installation.
- Optional confirmation channel over WeChat, disabled by default. It depends on an external confirmation hub that you must provide.

## Architecture overview

```
 Browser (PWA)  <--HTTP/SSE-->  Home  <--authenticated WebSocket-->  Worker A  --> codex / claude / grok / agy
                                 |                                    Worker B  --> codex / claude / grok / agy
                          SQLite (projects, roles,                    ...
                          rooms, runs, queues)
```

- **Home** (`src/home.mjs`): web UI and REST API, SSE updates, the single source of project state, the scheduler and the Worker WebSocket endpoint. Built on Node's HTTP server and built-in SQLite.
- **Worker** (`src/worker.mjs`): one per machine. Probes local CLIs, runs them in project workspaces, keeps a local database and outbox, and reports events back.
- **Runtime adapters**: Codex through the App Server protocol; Claude Code, Grok Build and Antigravity through their non-interactive print/stream modes.
- **`wb`** (`bin/wb`): the tool every managed CLI uses to talk back to the workbench. It talks to the Worker over a per-turn file bridge, so the CLI sandbox does not need network access.
- **Web UI** (`public/`): plain ES modules, no build step.

Details and interface boundaries are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The product scope is in [docs/PRD.md](docs/PRD.md).

## Requirements

- Node.js `>= 22.16` (`.nvmrc` pins a tested version). Node's built-in `node:sqlite` is used; it may print an experimental warning.
- Git.
- At least one supported CLI installed and logged in on each machine that will run a Worker: `codex`, `claude`, `grok` or `agy`.
- Optional: SSH access to remote machines if you want the device onboarding helper.

## Quick start (single machine)

```sh
nvm use          # optional, uses the version in .nvmrc
npm install      # or: npm ci
npm run dev      # starts a Home and a Worker as two separate processes
```

Open <http://127.0.0.1:4317>. The default listener is loopback only.

Then, in the UI:

1. Open the base settings and check that your device and its CLIs are detected.
2. Create a project. Pick the online device, a logged-in CLI and a model as the project supervisor, and give the project a folder name.
3. Tell the supervisor which repository to use and which roles you want, confirm the configuration cards it proposes, then `@` a role to start work.

You can also run the two processes yourself:

```sh
npm start        # Home
npm run worker   # Worker (in another terminal)
```

### Project memory: `AGENTS.md`

Each managed project keeps one authoritative memory file, `AGENTS.md`, at the project root. When Workbench creates a project folder or links an existing Git repository it writes, only if absent, an `AGENTS.md` template (project goal, rules and conventions, build and test commands, key decisions; conclusions only, under about 200 lines) and a one-line `CLAUDE.md` containing `@AGENTS.md`. Existing files are never overwritten. In a Git repository root the new files alone are committed locally (`chore: add AGENTS.md project memory`); nothing else is staged and nothing is pushed. If the commit fails (for example, no Git identity or a rejecting hook) the files are left uncommitted and the error is reported. Codex, Grok and Agy read `AGENTS.md` natively; Claude Code needs version 2.1.281 or later for `AGENTS.md`, and the `CLAUDE.md` pointer covers its default mode, which skips `AGENTS.md` whenever a `CLAUDE.md` exists. Any role may update `AGENTS.md` when a rule or key decision changes; keep it concise, conclusions only, and commit the change. Workbench no longer keeps its own memory (`wb memory` and `.workbench/MEMORY.md` / `INDEX.md` were removed; old files on disk are left untouched). Process history is available with `wb history search`.

### Where data lives

| Path | Content |
| --- | --- |
| `.data/home/` (override with `DATA_DIR`) | Home SQLite database, attachments, generated `worker-token` (mode 0600), hosting account secrets |
| `.data/worker/` (override with `WORKER_DATA_DIR`) | Worker SQLite database, node identity, outbox, runtime environments |
| `<project folder>/.worktrees/` | Per-run and project-baseline Git worktrees |
| `<project folder>/AGENTS.md`, `CLAUDE.md` | Project rules and key decisions shared by every CLI (created once if absent) |
| `<project folder>/.workbench/` | Handoff notes, temporary attachments and other platform files inside a workspace |
| `.local/` | Scratch space for local validation; never published |

Never commit any of these. See [docs/OPERATING-GUIDE.md](docs/OPERATING-GUIDE.md).

## Configuration

Role editing separates **responsibility** (used by other roles to choose collaborators) from **role prompt** (injected for that role's execution). A role does not receive its own responsibility through the team directory. Text-only edits work while its device is offline and preserve its CLI/model binding. Existing custom prompts remain unchanged; missing responsibilities are unspecified, not inferred.

The editable platform and supervisor v2 defaults describe proactive execution and evidence-based coordination. Delegation includes the goal, recipient role/change boundary, exact device/version/file inputs and required return. Shared prompt edits affect existing managed sessions at their next actual turn, preserve role-specific prompts and history, and do not interrupt running work. Retry/replacement guidance is not an automatic account switch or additional publishing permission.

The development Home/Worker contract supports minimal execution context and on-demand team discovery. Saved prompt changes apply at actual next-turn admission, not halfway through running work. The four adapters apply complete changed/revoked component events while retaining the native session; unchanged delivered versions are not repeated. Codex separately reloads a retained thread's current Run/tool environment. Explicit dependency waits can time out, resume and wait for the original request without dispatching it again. Isolated four-CLI native and cross-device acceptance passed for the documented combinations; local Agy is unavailable under the provider's location policy. This is not a production rollout. See [actual coverage and selective release gates](docs/design-minimal-injection.md#11-observed-acceptance-boundary).

Bilingual responsibility templates help collaborators choose planners, implementers, reviewers, testers and optional specialist roles. The original eight execution prompts remain empty; the optional cross-device and two local-work presets prefill their execution text. These presets do not enforce a device binding or create a mandatory workflow, and the supervisor defaults remain separate. Existing custom role prompts and responsibilities are not rewritten. Safe automatic CLI handoff has [an approved design](docs/design-role-cli-switch.md) and an implementation plan awaiting review; it is not a released feature.

Everything is configured through environment variables. Copy [`.env.example`](.env.example) as a reference; the app does not load `.env` files by itself, so export the variables in your shell or service manager. Values below are placeholders.

**Home**

| Variable | Default / purpose |
| --- | --- |
| `PORT` | `4317` |
| `HOST` | `127.0.0.1`. A non-loopback host requires `API_TOKEN` and should be put behind an HTTPS reverse proxy |
| `DATA_DIR` | `.data/home` in the project |
| `API_TOKEN` | Browser access token, required for non-loopback listening (for example `xxxxx`) |
| `WORKER_TOKEN` | Shared Worker registration token. If unset, one is generated into `.data/home/worker-token` |
| `TOKEN_USAGE_TIMEZONE` | Day boundary for token statistics, default is the system time zone; set it to override |

**Worker**

| Variable | Default / purpose |
| --- | --- |
| `HOME_URL` | `ws://127.0.0.1:4317/worker`; for a remote Home use `wss://xxxxx/worker` |
| `WORKER_TOKEN` | Must match the Home token (for example `xxxxx`). Locally it is read from the Home data directory |
| `WORKER_ROOTS` | Allowed project root directories, separated by the OS path delimiter (for example `xxxxx`). Defaults to the project directory |
| `WORKER_DATA_DIR` | `.data/worker`; one directory per Worker, never shared by two processes |
| `WORKER_CONCURRENCY` | `2` |
| `NODE_NAME` | Display name; defaults to the host name |
| `NODE_KIND` | `local` or `cloud`; defaults to `cloud` on Linux and `local` elsewhere |
| `CODEX_BIN`, `CLAUDE_BIN`, `GROK_BIN`, `AGY_BIN` | CLI executables; set an absolute path (`xxxxx`) when `PATH` differs |
| `CLAUDE_MODEL_ID` | Model ID to advertise when `CLAUDE_BIN` points at an Anthropic-compatible launcher |
| `CLAUDE_CONFIG_DIR` | Native session directory, needed when a wrapper changes `HOME` |
| `NODE_ID`, `WORKSPACE_ROOT`, `REMOTE_DESKTOP_URL`, `CCUSAGE_BIN` | Optional overrides, see `src/worker.mjs` and `src/token-usage.mjs` |

Optional features: `WB_DISCUSSION_PREVIEW=1` together with `WB_DISCUSSION_VALIDATED_CONFIGS` (JSON array of `{runtime, model, version, bin}` entries you have verified) enables the peer discussion preview. `WECHAT_CLIENT` and `WECHAT_CLIENT_CONFIG` configure the optional WeChat channel.

### Home and a remote Worker

Run the Home on an always-on machine and connect Workers from other machines. For a few personal nodes an SSH tunnel is enough:

```sh
# on the worker machine
ssh -NT -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -L 14317:127.0.0.1:4317 xxxxx@xxxxx
```

```sh
# in another terminal on the worker machine
export HOME_URL=ws://127.0.0.1:14317/worker
export NODE_NAME=xxxxx
export WORKER_ROOTS=xxxxx
read -r -s WORKER_TOKEN && export WORKER_TOKEN   # paste the Home's worker token
npm run worker
```

If you already have an HTTPS/WSS reverse proxy, set `HOME_URL=wss://xxxxx/worker` and skip the tunnel. Node itself does not terminate TLS. More setups are in [docs/OPERATING-GUIDE.md](docs/OPERATING-GUIDE.md).

## Development

```sh
npm run check    # node --check over every source file (syntax only)
```

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) first.

## Documentation

| Document | Purpose |
| --- | --- |
| [docs/OPERATING-GUIDE.md](docs/OPERATING-GUIDE.md) | How to publish, configure, run and iterate on the project together |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Current code architecture, interfaces and implementation boundaries |
| [docs/PRD.md](docs/PRD.md) | Product goals and scope |
| [docs/design-coordination.md](docs/design-coordination.md) | Supervisor, optional plans and cross-device role collaboration |
| [docs/design-local-supervisor.md](docs/design-local-supervisor.md) | Project supervisor and multi-repository setup |
| [docs/design-supervisor-timers.md](docs/design-supervisor-timers.md) | `wb timer` scheduled jobs and progress patrol |
| [docs/design-session-handoff.md](docs/design-session-handoff.md) | Proposed controlled cross-device session handoff (not implemented) |
| [docs/README.md](docs/README.md) | Documentation index |

## Limitations and roadmap

Be aware of these before relying on the project:

- **Trusted operators only.** Browsers share the Home credential; there are no per-user identities or permissions, no per-device credential revocation, and no TLS inside Node. The Worker registration token is one shared secret.
- **Auto-approve execution.** Codex runs with `workspace-write` and approval policy `never`; Claude Code, Grok Build and Antigravity run with their permission-skipping flags inside the Worker-assigned workspace. There is no native per-step approval. The `wb` tool allow-list is not a sandbox against a malicious shell on the same account.
- **Single Home.** There is no replication or automatic failover; a Home on a laptop cannot dispatch while the laptop sleeps.
- **Cross-device session handoff is a design, not a feature yet.** Today you can re-bind a role to another device, deliver fixed Git commits and send attachments, but native vendor sessions do not migrate. See [docs/design-session-handoff.md](docs/design-session-handoff.md).
- **Not implemented:** other ACP runtimes, additional chat channels (Feishu), multi-user identities, manual primary/standby Home switch-over, automatic merging of delivered branches.
- Token statistics reflect local CLI history seen by `ccusage`, not vendor billing. Quota display is a best-effort probe per CLI and shows "unavailable" when the CLI does not expose it.
- A successful process exit means one execution finished, not that the work was accepted.

Project status and planned work are tracked in the issue tracker.

## License

MIT. See [LICENSE](LICENSE).
