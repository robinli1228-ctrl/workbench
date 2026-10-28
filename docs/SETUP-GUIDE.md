# Agent Workbench setup guide (hand this to an AI assistant)

> For people deploying Workbench and for the AI assistant helping them. It describes only what exists in this repository:
> the processes, the variables and the dependencies. `xxxxx` is always a placeholder the user supplies.

## 0. Instructions for the AI assistant

1. Ask first: how many machines, their systems (macOS / Linux), which one runs Home, and which CLIs (`codex`, `claude`, `grok`, `agy`) will be used.
2. Follow the order of this document: environment → code and dependencies → Home → Worker → in-app configuration. Every step has a check; do not continue until it passes.
3. Secrets (`API_TOKEN`, `WORKER_TOKEN`, GitHub / Gitee tokens) live only in the user's shell, service manager or Home data directory. Never write them into the repository, a commit or a chat.
4. Never delete or empty `.data/`, `WORKER_DATA_DIR` or project folders. A Worker's identity lives in its data directory; emptying it makes a new device.
5. For anything not covered here, read `README.md`, `docs/OPERATING-GUIDE.md` and the source. Do not guess.

## 1. What it is and what it consists of

Workbench is a local-first console for several command-line agents (Codex, Claude Code, Grok, Antigravity/Agy): it turns the CLIs you are already logged into into roles of a project, dispatches work in a group chat, and lets you take over or continue the CLIs' own sessions on the Sessions page.

| Part | Process | Role |
| --- | --- | --- |
| **Home** | `node src/home.mjs` | The single control centre: web UI (default `http://127.0.0.1:4317`), SQLite database, group chat and scheduling, attachments, hosting accounts, the WebSocket endpoint `/worker` for every Worker |
| **Worker** | `node src/worker.mjs` | One per participating machine: probes local CLIs and model catalogues, runs CLIs in local folders, reads and writes local files, owns the machine's native sessions, performs source sync |
| **Browser** | — | Talks only to Home |

Key terms:

- **Device**: one Worker (identity `NODE_ID`, stored in the Worker data directory). `NODE_KIND` is `local` (laptop) or `cloud` (server); iTerm hand-over works only on a `local` macOS device.
- **Project**: a logical container. Each device binds its own local folder (project settings → device bindings); folders are never shared across devices. Source sync keeps the bound folders of several devices consistent.
- **Role**: device + CLI + model + reasoning effort + prompt. In the group chat, `@role` dispatches a task.
- **Native session**: the CLI's own session (Claude: `~/.claude/projects/*/<id>.jsonl`, Codex: `~/.codex/sessions`, Grok: `~/.grok/sessions`). The Sessions page can take one over on the page (with a send queue) or continue it in iTerm; its working folder is fixed on the device that created it.
- **Project memory `AGENTS.md`**: the single rules file in the project folder, plus a `CLAUDE.md` containing `@AGENTS.md`. Workbench creates both when it creates the project folder (only if absent, never overwritten). Every CLI reads them natively.

## 2. Requirements (every machine)

| Requirement | Notes | Check |
| --- | --- | --- |
| Node.js `>= 22.16` | `.nvmrc` pins a tested version; the built-in `node:sqlite` prints `ExperimentalWarning: SQLite` at start, which is normal | `node -v` |
| Git | Home and Worker | `git --version` |
| At least one logged-in CLI | On Worker machines: any of `codex`, `claude` (`2.1.281+` to read `AGENTS.md`), `grok`, `agy`. The Worker probes version, login state, model catalogue and quota at start and every 5 minutes | the CLI's own command, e.g. `claude --version` |
| macOS + iTerm2 (optional) | Only for "open the session in iTerm": it runs the command through the `iterm2:/command?c=…` URL scheme on the local Mac; remote devices are reached through your own SSH config | — |
| SSH (optional) | Tunnels for multi-device setups; the device onboarding assistant uses it too | `ssh -V` |

## 3. Code and dependencies

```sh
git clone https://github.com/xxxxx/workbench.git
cd workbench
nvm use            # optional, the .nvmrc version
npm ci             # dependencies are only opencc-js, ccusage, ws (package.json)
npm run check      # syntax checks
npm test           # unit tests, all must pass
```

The application does **not** read a `.env` file. `.env.example` is only a list of variables; export them in the shell or inject them through the service manager (systemd / launchd).

## 4. Single machine quick start (Home and Worker together)

```sh
npm run dev        # Home and a local Worker as two processes
# or separately:
npm start          # Home
npm run worker     # Worker (second terminal)
```

- Open `http://127.0.0.1:4317`. Loopback only by default, no token needed.
- The local Worker needs no `WORKER_TOKEN`: it reads the generated `.data/home/worker-token` (mode 0600) from Home's data directory.

Check: top right → Basic settings → the device list shows this machine with its logged-in CLIs and their models.

## 5. Configuration (all environment variables)

### 5.1 Home

| Variable | Default / purpose |
| --- | --- |
| `PORT` | `4317` |
| `HOST` | `127.0.0.1`. A non-loopback address **requires** `API_TOKEN`, otherwise Home refuses to start; Node does not terminate TLS, put an HTTPS reverse proxy in front |
| `DATA_DIR` | `.data/home`: SQLite, attachments, `worker-token`, hosting account keys |
| `API_TOKEN` | Browser access token, required when not on loopback |
| `WORKER_TOKEN` | Registration token shared by all Workers; generated into `.data/home/worker-token` when unset |
| `TOKEN_USAGE_TIMEZONE` | Day boundary for token statistics, default system time zone |

### 5.2 Worker

| Variable | Default / purpose |
| --- | --- |
| `HOME_URL` | `ws://127.0.0.1:4317/worker`; a remote Home is `wss://xxxxx/worker`, or `ws://127.0.0.1:<local port>/worker` through a tunnel |
| `WORKER_TOKEN` | Must match Home; may be omitted on Home's own machine |
| `WORKER_ROOTS` | Roots under which projects and session folders may live, separated by the OS path separator (`:` on Linux/macOS). The Worker reads and writes only below them |
| `WORKSPACE_ROOT` | Root for the default folder of new native sessions (first `WORKER_ROOTS` entry by default); sessions without a project go to `<WORKSPACE_ROOT>/native-sessions` |
| `WORKER_DATA_DIR` | `.data/worker`: SQLite, device identity, outbox, sync cache. **One per Worker, never shared, never emptied** |
| `WORKER_CONCURRENCY` | CLIs running at once, default `2` |
| `NODE_NAME` | Display name, default host name |
| `NODE_KIND` | `local` or `cloud`; Linux defaults to `cloud`, other systems to `local` |
| `NODE_ID` | Device identity; normally unset, generated on first start and stored in the data directory |
| `CODEX_BIN` / `CLAUDE_BIN` / `GROK_BIN` / `AGY_BIN` | Absolute paths of the CLIs; a service manager's `PATH` differs from an interactive shell, so set them or extend the service `PATH` |
| `CLAUDE_MODEL_ID` | Model ID to announce when `CLAUDE_BIN` is an Anthropic-compatible launcher |
| `CLAUDE_CONFIG_DIR` | Claude's real config directory when a wrapper changes `HOME`; otherwise native session histories are not found |
| `REMOTE_DESKTOP_URL`, `CCUSAGE_BIN` | Optional, see `src/worker.mjs` and `src/token-usage.mjs` |

Optional features: `WB_DISCUSSION_PREVIEW=1` with `WB_DISCUSSION_VALIDATED_CONFIGS` (JSON array) enables the peer-discussion preview.

## 6. Several devices

Principle: **one always-on machine runs Home, every other machine runs exactly one Worker.** The Worker is always the WebSocket client, so only the Worker needs to reach Home's port. Three usual ways:

**A. Home behind an HTTPS reverse proxy** (recommended long term): `HOME_URL=wss://xxxxx/worker`; the proxy must pass WebSocket upgrades.

**B. Home on a server, Worker elsewhere: forward tunnel from the Worker machine**

```sh
# Worker machine
ssh -NT -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L 14317:127.0.0.1:4317 xxxxx@xxxxx
export HOME_URL=ws://127.0.0.1:14317/worker
```

**C. Home on a laptop (macOS), Worker on a cloud server: reverse tunnel from the laptop**

```sh
# laptop (where Home runs)
ssh -NT -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -R 14320:127.0.0.1:4317 xxxxx@xxxxx
# Worker on the server
export HOME_URL=ws://127.0.0.1:14320/worker
```

On each Worker machine:

1. Clone the **same version**, `npm ci`; install and log in to the CLIs.
2. Take the Worker token from the Home machine: `cat .data/home/worker-token` (or your `WORKER_TOKEN`).
3. Export and start:

   ```sh
   export HOME_URL=...                       # one of A, B, C
   read -r -s WORKER_TOKEN && export WORKER_TOKEN
   export NODE_NAME=xxxxx
   export NODE_KIND=cloud                    # server; laptop: local
   export WORKER_ROOTS=/srv/agent-projects   # example root for projects and sessions
   export WORKSPACE_ROOT=/srv/agent-projects
   export WORKER_DATA_DIR=/opt/agent-workbench/.data/worker
   npm run worker
   ```

4. Check: Home → Basic settings → the device is online and its CLIs are detected.

## 7. Running as a service (Linux, systemd example)

Worker (server):

```ini
# /etc/systemd/system/agent-workbench-worker.service
[Unit]
Description=Agent Workbench Worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=xxxxx
Group=xxxxx
WorkingDirectory=/opt/agent-workbench
# WORKER_TOKEN and other secrets, mode 0600
EnvironmentFile=/etc/agent-workbench-worker.env
# Must contain node and the CLIs
Environment=PATH=/home/xxxxx/.local/bin:/opt/node/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=/home/xxxxx
Environment=HOME_URL=ws://127.0.0.1:14320/worker
Environment=WORKER_DATA_DIR=/opt/agent-workbench/.data/worker
Environment=WORKER_ROOTS=/srv/agent-projects
Environment=WORKSPACE_ROOT=/srv/agent-projects
Environment=WORKER_CONCURRENCY=1
Environment=NODE_KIND=cloud
Environment=NODE_NAME=xxxxx
ExecStart=/opt/node/bin/node /opt/agent-workbench/src/worker.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Home's unit is the same shape: `ExecStart=… src/home.mjs` with `PORT`, `DATA_DIR`, `WORKER_TOKEN`, and `HOST` + `API_TOKEN` when exposed. Make the tunnel a service as well (`ExecStart=/usr/bin/ssh -NT … -R …`, `Restart=always`).

```sh
systemctl daemon-reload && systemctl enable --now agent-workbench-worker
journalctl -u agent-workbench-worker -f          # logs
```

`HOME` must be the running user's home: CLI logins and native session histories live there.

## 8. First configuration in the app, in order

1. **Basic settings**: every device online, CLIs and models detected; the language switch is here.
2. **Hosting accounts** (optional): least-privilege GitHub / Gitee tokens (repository contents and pull requests), stored in a private file in Home's data directory. Role pushes and the Sessions page's Git credential come from here; a token is sent only to its repository's remote.
3. **Create a project**: pick an online device, a logged-in CLI and a model as the supervisor, and a folder name. Workbench creates the folder on that device with `AGENTS.md` and `CLAUDE.md`.
4. **Device bindings**: in project settings bind a folder on every participating device (created if missing). Source sync keeps them consistent: the whole bound folder is in scope (`outputs/`, `artifacts/`, `.workbench/docs` included), code repositories sync against their Git baseline, `.git` itself is not transferred, and simultaneous edits of one file land in the conflict list for a person to resolve.
5. **Roles**: define roles by device / CLI / model / effort / prompt; dispatch with `@role` in the group chat. Queued messages sit above the composer; each can be steered (interrupt and run now) or cancelled.
6. **Sessions page**: a new native session takes a device, a CLI, an optional project and a working folder. With a project the folder is `<project>/native-sessions/<title>`, created when opened; without one `<WORKSPACE_ROOT>/native-sessions`. "Allow all operations" maps to the CLI's permission bypass. Open on the page (the Worker starts the CLI headlessly) or prepare an iTerm launch. Once taken over: the button is Stop while a reply runs, becomes Send as soon as you type (the message queues); switching to iTerm or back runs in a dialog with confirmation and progress. Right panel: Overview (connection, model, effort, context with compact, quota), Files (named in replies, touched, outputs folder, project outputs), Resources (repository, AGENTS.md, working folder, session ID).
7. **AGENTS.md**: the project's single rules file. The Sessions page's Resources tab edits the one the session's folder uses (looked up upwards to the project root) and can create it when missing.

## 9. Data and security boundaries

| Path | Contents |
| --- | --- |
| `.data/home/` (`DATA_DIR`) | Home SQLite, attachments, `worker-token` (0600), hosting account keys |
| `.data/worker/` (`WORKER_DATA_DIR`) | Worker SQLite, device identity, outbox, sync cache and blobs |
| `<project>/.worktrees/` | Git worktrees per run and the project baseline |
| `<project>/AGENTS.md`, `CLAUDE.md` | Project rules and key decisions |
| `<project>/.workbench/` | Hand-offs, temporary attachments, shared documents |
| `<project>/native-sessions/<title>/` | Working folders of project-linked native sessions |

- Keep Home/Worker runtime state, secrets and generated worktree checkouts out of Git. `AGENTS.md` and `CLAUDE.md` are project rules files; when Workbench creates them at a Git repository root, it commits them locally. Version other project documents and outputs according to the project's rules.
- Home listens on loopback by default; exposing it requires `API_TOKEN` and an HTTPS proxy.
- Execution is limited to configured `WORKER_ROOTS` or directories explicitly granted to the current project or session. Human folder browsing on the local machine may extend beyond those execution roots; browsing does not grant an Agent access to the whole disk.
- While a group-chat role runs in a folder, no native CLI may be opened in that folder tree; two native sessions may share a folder at the user's discretion.

## 10. Upgrades and rollback

- Basic settings → Configuration information → "Check for updates" only compares with GitHub `main` (cached for a minute). It **downloads, installs and restarts nothing**.
- Single machine: `git pull && npm ci && npm test`, then restart Home and the Worker. Data directories stay.
- Several machines: use release directories (for example `/opt/agent-workbench-releases/<date-commit>`), point the service's `ExecStart` at the new directory through a systemd drop-in and restart; rollback is pointing `ExecStart` back. Keep Home and every Worker on the same version.
- Restarting a Worker keeps its identity as long as `WORKER_DATA_DIR` is not emptied.

## 11. Troubleshooting

| Symptom | Check first |
| --- | --- |
| Device shows offline | Connection errors in the Worker log; is `HOME_URL` reachable (tunnel alive); does `WORKER_TOKEN` match Home |
| CLI not detected | Does the service `PATH` contain the CLI; set `*_BIN` absolute paths; is `HOME` the home of the user who logged in |
| "Session is occupied" on a new session | The same native session is open elsewhere, or a group-chat role is running in that folder |
| Session history empty / missing | `CLAUDE_CONFIG_DIR` correct; a session opens only on the device that created it |
| Claude ignores `AGENTS.md` | Claude Code `2.1.281+` required; the project folder needs the `CLAUDE.md` pointer |
| Quota "Unknown" | The CLI reports no quota, or the Worker has not probed yet (every 5 minutes) |
| `ExperimentalWarning: SQLite` at start | Normal, from `node:sqlite` |
| Port in use | Change `PORT` or stop the old process; one Home and one Worker per machine |

## 12. Final checklist (the AI assistant confirms each)

- [ ] `node -v` ≥ 22.16, `npm test` passes
- [ ] Home reachable; `API_TOKEN` and HTTPS when not on loopback
- [ ] Every Worker online, CLIs and models detected, `WORKER_ROOTS` / `WORKER_DATA_DIR` separate per Worker
- [ ] Tunnel or reverse proxy runs as a service
- [ ] At least one project: supervisor role works, every participating device has a bound folder, `AGENTS.md` exists
- [ ] `@role` in the group chat dispatches and replies; the Sessions page can create, take over and hand over to iTerm
- [ ] Tokens exist only in service environment files or Home's data directory; `git status` in the checkout is clean
