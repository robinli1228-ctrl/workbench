English | [简体中文](README.zh-CN.md)

# Agent Collaboration Workbench

Device details include a per-device **Maximum running CLIs** setting. Managed role runs, retained CLI processes and background organization share the limit; full devices queue work and resume the original native session when capacity becomes available. Offline settings apply after reconnect. Lowering the limit does not interrupt accepted work.

Role Details includes a History tab. Clear history removes that role's old session associations and starts a new native CLI session on the next execution; project chat, code files and other roles are preserved.

The role-card terminal button also offers a new interactive CLI session without requiring past execution records. It uses the role's saved device, model and project folder; past sessions can still be resumed explicitly. Return manual terminal control to the platform after closing the CLI.

Terminal links preserve command spaces and literal `+` characters. Refreshing the page also corrects older prepared links without clearing history or replacing the terminal takeover.

Role quota percentages show reset details on hover or keyboard focus, and open the same details on click or touch. Vendor timezone text is preserved; missing reset times are explicitly marked unavailable.

A self-hosted workbench that turns the AI coding CLIs and accounts you already have (Codex, Claude Code, Grok Build, Antigravity) into one collaborating team. You talk to a project group chat, `@mention` roles, and the workbench launches the real CLI on the right machine, streams the progress back, and keeps the results, reviews and hand-offs in one place.

> Status: development preview (`0.4.0`). It is built for a single trusted operator or a small trusted group. See [Limitations](#limitations-and-roadmap) before exposing it to a network.

## Why this exists

An opt-in **Source sync** card is available under Resources, with configuration also linked from project settings. After previewing repository/device bindings and explicitly enabling the project, **Sync now** or a managed `wb sync request` exchanges saved, uncommitted files. It is changed-file transfer, not continuous save-time uploading or Git publication. Conflicts preserve the original versions and notify evidenced modifiers; repair candidates require independent inspection and explicit acceptance before checked distribution. Physical macOS/Linux transfer and Codex modifier repair were verified, as were source-tool reads and native continuation for all four adapters. Existing projects stay disabled. See the [contract and current acceptance limits](docs/design-source-sync.md).

The project started from a practical situation: one person, several AI subscriptions (different vendors and models), and several machines.

- **Different models review and complement each other.** One model writes the code, another reviews it from a different angle, a third plans or tests. Each is a *role* with its own CLI, model and prompt. Independent review of a pinned Git commit is a first-class workflow.
- **Use the quota you already pay for.** Most accounts have unused tokens at the end of a period. Because a role is just "this CLI + this model + this machine", you decide how work is spread across accounts and can change that allocation at any time by editing a role. Token statistics and, where the CLI exposes it, remaining quota are shown next to the roles so the split can be adjusted deliberately.
- **Multiple servers and devices work together.** A *Home* node keeps the project state, and any number of *Worker* nodes (your laptop, a Linux server, a cloud box) connect to it and run the CLIs installed there. Code moves between devices as fixed Git commits, files move as attachments, and a supervisor role can coordinate roles that live on different machines.

The workbench does not replace the CLIs and does not proxy model APIs. It drives the CLIs you have already installed and logged in to, and it stores no vendor credentials of its own.

## Language

The **Basic Settings** tab groups language (English / 简体中文), browser API Token, WeChat notifications and the remote execution switch. The verified Home access token is saved in this browser and reused after closing and reopening it; edit it in Basic Settings when needed. Use a trusted browser profile: clearing site data, private browsing or switching to a different browser/address can require setup again. Language localizes the UI and displayed defaults, independently of model-facing instruction language. This README and the [operating guide](docs/OPERATING-GUIDE.md) are also available in Simplified Chinese: [README.zh-CN.md](README.zh-CN.md) and [docs/OPERATING-GUIDE.zh-CN.md](docs/OPERATING-GUIDE.zh-CN.md).

Project names remain user-defined text in the sidebar, its accessible labels and the workspace heading; switching the interface language does not rename them.

Managed dialogue inputs for Codex, Claude Code, Grok and Antigravity use English Workbench-maintained execution templates and a send-only Traditional Chinese prose copy. Chat records and saved custom prompts stay unchanged; custom prompts are not translated to English. Code, commands, paths, identifiers and exact quoted strings are preserved. The same policy applies to later turns and configuration events without an extra model call. It does not rewrite native history, attachments, tool results or text typed directly in an SSH terminal, and requires this Worker version on each execution device.

## Key features

All items below exist in the current code. Items that are only designed are listed separately under [Limitations and roadmap](#limitations-and-roadmap).

**Collaboration**

- Project group chat with `@role` dispatch. Messages without an `@` are stored but do not start a model; messages from agents never trigger other agents implicitly.
- Per-project roles with their own device, CLI, model, reasoning effort and Markdown prompt. Built-in templates (reviewer, planner, developer, tester) are only starting points.
- Same-device Codex/Grok changes use **Handoff and switch** in either role editor: retain identity/history, drain accepted work, verify a new native session and commit only after process settlement. Cancel before commit keeps the original binding. Requires a compatible Worker; other adapters are explicitly unverified. See [CLI switch design](docs/design-role-cli-switch.md) for current acceptance status.
- Role names are mention identifiers (letters, digits, underscores or hyphens, without spaces); `all` and `everyone` are reserved for broadcasts. Existing role names are kept verbatim. Default intake follows the configured supervisor ID, not an English display name, and mentions support both ASCII and full-width punctuation.
- A fixed per-project *supervisor* that receives requests without an `@`, proposes repository/role configuration cards (applied only after you confirm) and can schedule multi-stage work (`wb schedule`) with parallel independent reviews and sequential or merge stages. Its card is pinned above the work roles; click it to configure its device, CLI, model and reasoning effort in Project Settings.
- Structured role-to-role tools exposed to every managed CLI through one `wb` command: consult another role (`wb call` / `wb wait`), report a business verdict (`wb report`), write a hand-off note (`wb handoff`), and request a Git delivery (`wb deliver`). An `@` inside model output never dispatches work.
- Queueing, per-role and per-node concurrency limits, cancel, "steer now" for queued human messages, pause for remote dispatch, and explicit stop with confirmation from the Worker.
- Native session resume: each role keeps its vendor session across turns, with a background conversation organizer that keeps a shared project summary.
- Optional, off by default: peer discussion preview (`WB_DISCUSSION_PREVIEW`).

**Multi-device**

- Home/Worker split over an authenticated WebSocket. Workers connect outward; the Home never reaches into a machine.
- Reliable delivery: persistent command and event outbox, idempotent command IDs, reconcile-on-reconnect, and no automatic re-run of executions whose state is unknown.
- Per-device project directories and a long-lived project baseline branch per repository (Git worktrees), with fixed-SHA cross-device delivery that requires an explicit confirmation before pushing.
- Attachments (images and files, up to 6 per message, 20 MB each) with SHA-256 verification, and a "send to device" action for moving a file to another bound device.
- Device onboarding helper over SSH (installs and connects a Worker on a remote Linux machine) and an optional Home-managed reverse SSH tunnel.
- Remote desktop from a macOS Home: check the registered server's xrdp, create a loopback SSH forward or reuse a verified existing same-user forward, then open Windows App's saved connections. Unknown or ambiguous listeners remain blocked; externally managed tunnels are never stopped by this entry. Opening the app does not verify desktop login.
- Terminal takeover: continue a finished native session in iTerm (macOS entry point; remote devices are reached over your own SSH configuration), with the platform pausing dispatch on that device while you work.

**Operations**

- Scheduled jobs (once, interval, daily, weekly) and a model-free progress patrol that only wakes the supervisor on new anomalies (`wb timer`).
- Token usage statistics per device, collected with `ccusage`.
- GitHub and Gitee account storage and optional repository creation (private by default).
- Installable PWA shell, desktop three-column layout and a mobile drawer layout.
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

### Where data lives

| Path | Content |
| --- | --- |
| `.data/home/` (override with `DATA_DIR`) | Home SQLite database, attachments, generated `worker-token` (mode 0600), hosting account secrets |
| `.data/worker/` (override with `WORKER_DATA_DIR`) | Worker SQLite database, node identity, outbox, runtime environments |
| `<project folder>/.worktrees/` | Per-run and project-baseline Git worktrees |
| `<project folder>/.workbench/` | Handoff notes, temporary attachments and other platform files inside a workspace |
| `.local/` | Scratch space for local validation; never published |

Never commit any of these. See [docs/OPERATING-GUIDE.md](docs/OPERATING-GUIDE.md).

## Configuration

Role editing separates **responsibility** (used by other roles to choose collaborators) from **role prompt** (injected for that role's execution). A role does not receive its own responsibility through the team directory. Text-only edits work while its device is offline and preserve its CLI/model binding. Existing custom prompts remain unchanged; missing responsibilities are unspecified, not inferred.

The development Home/Worker contract supports minimal execution context and on-demand team discovery. Saved prompt changes apply at actual next-turn admission, not halfway through running work. The four adapters apply complete changed/revoked component events while retaining the native session; unchanged delivered versions are not repeated. Codex separately reloads a retained thread's current Run/tool environment. Explicit dependency waits can time out, resume and wait for the original request without dispatching it again. Isolated four-CLI native and cross-device acceptance passed for the documented combinations; local Agy is unavailable under the provider's location policy. This is not a production rollout. See [actual coverage and selective release gates](docs/design-minimal-injection.md#11-observed-acceptance-boundary).

Bilingual defaults cover a supervisor who can complete simple work, a planner who maintains plans and answers questions, an implementer who owns follow-up fixes, sequential reviewers, and a tester who checks the deployed test version through realistic operations. Prompts guide existing tools, not override authorization or collaboration limits. Safe automatic CLI handoff has [an approved design](docs/design-role-cli-switch.md) and an implementation plan awaiting review; it is not a released feature.

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
