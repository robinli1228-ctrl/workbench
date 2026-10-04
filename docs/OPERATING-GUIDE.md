English | [简体中文](OPERATING-GUIDE.zh-CN.md)

# Operating Guide: Publishing and Iterating Together

This guide is for maintainers and contributors. It explains what is public, what must never be committed, how to configure your own accounts, models and servers, how to run the project on one machine or several, how to contribute, and how to sanitize the repository before publishing.

Throughout this guide, `xxxxx` is a literal placeholder. Replace it with your own value locally and never commit the real value.

## 1. What is public

| Area | Public? | Notes |
| --- | --- | --- |
| `src/`, `bin/`, `public/` | Yes | Backend, `wb` tool and the web UI |
| `package.json`, `package-lock.json`, `.nvmrc` | Yes | |
| `README.md`, `AGENTS.md`, `CONTRIBUTING.md`, `LICENSE` | Yes | |
| `docs/` | Yes | Design and architecture documents only. No run logs, no environment records |
| `assets/` | Yes | Icon sources |
| `examples/` | Yes | Minimal sample projects |
| `.env.example` | Yes | Placeholders only |
| `.github/` | Yes | Issue and PR templates |
| `.data/`, `.local/`, `.workbench/`, `.workbench-projects/`, `.worktrees/` | **No** | Runtime data, databases, tokens, scratch projects |
| `outputs/`, `reviews/` | **No** | Generated artifacts and review output |
| `.env`, `.env.*` (except `.env.example`) | **No** | |
| `node_modules/`, `*.log` | **No** | |

## 2. What must never be committed

- Data directories: `.data/home` (Home database, attachments, `worker-token`, hosting account secrets) and `.data/worker` (Worker database, node identity, saved CLI environments).
- Any `.env` file, shell history snippets with exports, or service files that contain real tokens.
- Tokens and keys: `API_TOKEN`, `WORKER_TOKEN`, GitHub or Gitee personal access tokens, vendor API keys, SSH private keys, WeChat client token files.
- Account and login information: vendor account e-mail addresses, login states, `~/.codex`, `~/.claude` or similar CLI configuration directories, `CLAUDE_CONFIG_DIR` contents.
- Server addresses: real IP addresses, host names, domains, ports tied to your machines, SSH user names, absolute home-directory paths.
- Run logs, validation records and screenshots that show any of the above. Keep these in your private notes, not in `docs/`.
- Real names, company or internal project names, and personal paths in comments, tests, prompts, fixtures or default settings.

If a secret was committed even once, rotate it. Removing it in a later commit does not remove it from history.

## 3. Configuring your own accounts, models and servers

The project does not ship any account. Everything is configured at runtime on your own machines.

### 3.1 CLIs and models

Install and log in to the CLIs you want to use on each machine that runs a Worker (`codex`, `claude`, `grok`, `agy`). The Worker probes each CLI at startup and every 5 minutes (version, login state, model catalog, and quota where available) without sending model requests. The model choices in the UI always come from that device's CLI catalog.

If a CLI is not on the Worker's `PATH`, point to it:

```sh
export CODEX_BIN=xxxxx      # absolute path to the codex executable
export CLAUDE_BIN=xxxxx
export GROK_BIN=xxxxx
export AGY_BIN=xxxxx
```

For an Anthropic-compatible third-party service behind a launcher script, set `CLAUDE_BIN` to the launcher and `CLAUDE_MODEL_ID=xxxxx` to the model ID that device can actually serve. Put the service credentials in the launcher's private configuration on that device, not in this repository. If a wrapper changes `HOME`, set `CLAUDE_CONFIG_DIR=xxxxx` to the directory the CLI really uses so that native sessions can be resumed.

### 3.2 Spreading work across your accounts

A role is one combination of device, CLI, model, reasoning effort and prompt. To use spare quota on an account, create or edit a role that points at that account's CLI and model, and `@` it for work that suits it (for example a second vendor's model as an independent reviewer). Role changes affect only new messages; queued and running work keeps its snapshot. Review the token statistics page and the quota shown on role cards to decide how to rebalance.

### 3.3 Hosting accounts

GitHub and Gitee tokens are entered in the base settings dialog and stored in a private file in the Home data directory. Use tokens with the minimum scope (`xxxxx`), and never paste them into the group chat.

## 4. Running the project

### 4.1 Single node

```sh
npm install
npm run dev          # Home and Worker as two processes, http://127.0.0.1:4317
```

or separately:

```sh
npm start            # Home
npm run worker       # Worker, in another terminal
```

The default listener is loopback only. A Worker on the same machine reads the Home's generated `.data/home/worker-token` automatically.

Use different `PORT`, `DATA_DIR` and `WORKER_DATA_DIR` values to run a second, isolated instance for testing. Never start two Workers on the same Worker data directory.

### 4.2 Multiple servers and devices

1. Pick an always-on machine for the Home. Keep it on loopback and put an HTTPS reverse proxy in front, or set `HOST=xxxxx` together with `API_TOKEN=xxxxx` (a non-loopback `HOST` without `API_TOKEN` is rejected at startup). The Home does not terminate TLS.
2. Generate a strong Worker token and set it on the Home: `WORKER_TOKEN=xxxxx`. Treat it like a password.
3. On each other machine (laptop, Linux server), clone the same version of the code, install Node.js (>= 22.16), Git and the CLIs, and log in to the CLIs.
4. Start a Worker on each machine:

   ```sh
   export HOME_URL=wss://xxxxx/worker        # or ws://127.0.0.1:14317/worker through an SSH tunnel
   export WORKER_TOKEN=xxxxx
   export NODE_NAME=xxxxx
   export WORKER_ROOTS=xxxxx                 # directories the Worker may use for projects
   export WORKER_DATA_DIR=xxxxx              # private, never shared between Workers
   npm run worker
   ```

5. For a small personal setup without a proxy, tunnel the Home port over SSH from the Worker machine:

   ```sh
   ssh -NT -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L 14317:127.0.0.1:4317 xxxxx@xxxxx
   ```

6. In the base settings, confirm the devices are online and their CLIs detected. Alternatively, use the device onboarding helper (SSH check, remote Worker install and reverse tunnel); it requires Node.js >= 22.16, npm and Git on the remote machine and does not install a boot service.
7. In project settings, bind a project directory on every device that should take part. Cross-device code moves through explicit Git deliveries of fixed commits; there is no shared writable directory.

Run one Worker per machine. Restarting a Worker keeps its identity, so do not wipe its data directory. Set `NODE_KIND=local` or `cloud` if the automatic choice (Linux means cloud) is wrong for your machine.

## 5. Contributing workflow

1. Fork the repository and create a branch from `main`: `feature/<topic>`, `fix/<topic>` or `docs/<topic>`.
2. Keep each change focused. Do not mix refactoring with behavior changes.
3. Run the checks below locally.
4. Open a pull request using the template. Describe what changed, why, how you verified it, and which parts you could not verify (for example "not tested against a real second device").
5. Maintainers review for correctness, scope and sanitization. Squash or rebase merge is preferred to keep history linear.

Branch protection suggestions for maintainers: require one review, require the `npm run check` job if you add CI, and forbid force pushes to `main`.

### 5.1 Code style

- JavaScript with ES modules on Node.js 22. No TypeScript, no build step for the web UI.
- Prefer extending the existing Home, Worker, Room and runtime adapter code over adding a second control plane.
- Keep task state, run state and worker online state separate. A process exit does not mean the work was accepted.
- No shared writable directories across devices: code moves as Git commits, other files as attachments.
- Keep user-facing text, comments and docs in English. Do not hard-code personal paths, host names or account names.
- Report each feature's status precisely: code written, committed, deployed, automatically checked and manually verified are different states.

### 5.2 Checks

```sh
npm ci
npm run check        # node --check on every source file; syntax only
git diff --check     # whitespace errors
```

`npm run check` lists files explicitly in `package.json`. When you add a new source file under `src/` or `public/`, add it to the `check` script too. The script is a syntax check; it does not run behavior tests. For changes that touch the Home, Worker, runtimes, the browser UI or cross-machine behavior, also run the change for real in an isolated project and put the result in the pull request description.

## 6. Extending the project

### 6.1 Adding a new role (template)

Roles are created per project at runtime. To ship a new starting template, add an entry to `src/default-roles.mjs`:

```js
{
  key: 'security-reviewer',
  name: 'Security Reviewer',
  mode: 'workspace-write',
  modelHint: 'Use a strong model for critical review',
  instructions: `You are an independent security reviewer. ...`
}
```

Templates are copied when a user creates a role and never create seats automatically. Keep the instruction text generic and free of personal or organization details.

### 6.2 Adding a model or CLI adapter

A new model of an already supported CLI needs no code: it appears once the CLI lists it. A new CLI (runtime) touches these places:

1. `src/runtime-probe.mjs`: add an `inspectXxx()` function that reports version, login state, model catalog and optional quota without creating a session or sending a model request, and include it in `inspectRuntimes()`. Mark only adapters that are actually wired as `supported: true`.
2. `src/worker.mjs`: add the executable (`XXX_BIN`) to the binaries map and the runtime name to the allow-list of runtime types.
3. A session class: either extend `src/cli-print-session.mjs` (CLIs that offer a non-interactive streaming mode, as Claude Code, Grok Build and Antigravity do) or write a dedicated one like `src/codex.mjs`. It must emit the common event types, support stop, and (if possible) resume by native session ID.
4. `public/`: add an icon and the label where runtimes are listed.
5. Document the new variable in `README.md` and `.env.example`, and describe the limits (for example no per-step approval) in `docs/ARCHITECTURE.md`.

Do not advertise a CLI as executable until it has been run for real through start, input, stop, events and result delivery.

## 7. Issue and pull request templates

Templates live in `.github/`:

- `.github/ISSUE_TEMPLATE/bug_report.md`
- `.github/ISSUE_TEMPLATE/feature_request.md`
- `.github/ISSUE_TEMPLATE/config.yml`
- `.github/PULL_REQUEST_TEMPLATE.md`

When filing an issue, never paste tokens, real server addresses, account names or unredacted logs. Replace them with `xxxxx`.

## 8. Pre-publish sanitization checklist

Run this on the release copy before every public push, and again after merging large contributions.

1. **No runtime data**: `.data/`, `.local/`, `.workbench/`, `.workbench-projects/`, `.worktrees/`, `outputs/`, `reviews/`, `node_modules/` and logs are absent from the working tree and listed in `.gitignore`.
2. **Documents**: `docs/` holds design and architecture documents only. No validation records, deployment logs, hand-off notes written for a specific environment, or personal channel setup.
3. **Secrets and environment scan**:

   ```sh
   grep -rnE '([0-9]{1,3}\.){3}[0-9]{1,3}|/Users/|/home/|@[a-z0-9.-]+\.[a-z]+|token|secret|password|ssh' . \
     --exclude-dir=node_modules --exclude-dir=.git --exclude=package-lock.json
   ```

   Review every hit. Variable names such as `API_TOKEN` and generic words are fine; real values, addresses and paths are not.
4. **Language**: `grep -rnP '[\x{4e00}-\x{9fff}]' . --exclude-dir=node_modules --exclude-dir=.git` returns nothing if the project is English-only.
5. **Names**: search for real names, user names, e-mail addresses, company or internal project names, and device nicknames. Replace with `xxxxx` or a neutral term.
6. **Defaults**: check defaults in code (ports, time zone, client names, paths such as a `~/.config/...` file) for personal values, and make them configurable or neutral.
7. **Git history**: publish from a fresh repository (`git init`) or verify with `git log -p` that no secret ever appeared in history. If it did, rotate the secret and rewrite or recreate the history.
8. **Dependencies**: `npm ci` works from a clean clone and `package-lock.json` is committed.
9. **Checks**: `npm run check` and `git diff --check` pass.
10. **License and metadata**: `LICENSE` is present, `package.json` has no private URLs or author details you do not want public.
11. **Screenshots**: none that show real hosts, accounts, usernames or project names.
12. **Final read**: open the repository page as an anonymous visitor and read the README top to bottom.
