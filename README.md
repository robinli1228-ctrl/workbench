English | [简体中文](README.zh-CN.md)

# Agent Collaboration Workbench

Development branch: independent Sessions support same-device, same-folder Agent switching from a small action beside the Agent name. The picker preserves one conversation, original execution segments and unsent drafts. Switching requires idle execution and an empty queue; the next user message carries bounded factual history, not an invented summary. This feature requires matching Home/Worker support and is not deployed. See [scope and acceptance](docs/design-native-agent-switch.md).

A self-hosted project group chat for the AI coding CLIs and subscriptions you already use. Codex, Claude Code, Grok Build and Antigravity run as configurable roles on your Mac or servers; Home owns records and coordination, while Workers drive the real native CLIs.

> Development preview (`0.4.0`), for a single trusted operator or a small trusted team. Workbench does not proxy model APIs or replace native instructions, login or tools.

Group-chat Agent cards can open a temporary **Side question** in the right panel (Claude and Codex). It reuses the Sessions composer and read-only side-session runner, quotes the selected card and uses the original native session’s current context. Home and Worker must both support group side questions. This branch is not deployed.

Sending a new native-session message or retrying **Steer** checks the retained Worker process first (requires `nativeTakeoverRefresh:1`). Verified idle processes are reused; verified exits free the old lease. A connection failure or unknown process identity leaves the queue intact and shows an error instead of bypassing ownership checks.

Sidebar descriptions are available through a small accessible information marker beside Sessions, Group chats and Role Settings. Click, focus or hover to read the full text without keeping guidance expanded.

## What the current version provides

- **Role-based collaboration.** Direct user assignments, supervisor coordination and role-to-role consultation through one `wb` entry. Keep role responsibilities separate from optional execution prompts; discover team, history, reports and user-confirmation tools on demand. Result-driven continuations quote the public feedback that woke the role, while retaining the original user-task source; legacy quote corrections are read-only.
- **External conversation queues.** Opt-in V3 sessions collect outside busy CLIs and deliver merged batches only at a verified input boundary. Original requests, waits and late replies stay linked; necessary resumption does not consume a new propagation charge. Explicit `wb note` / `wb chat post` publishes discussion output, while native streams and final answers remain in execution details.
- **Isolated admission failures.** Invalid code-input batches are rejected before calls are queued. Legacy unstarted requests retain a visible not-executed result instead of crashing Home or retrying forever; directory-sync receipts remain separate from fixed-version code delivery.
- **Independent review.** Workbench history, derived inputs and managed document reads remain isolated until explicit release. This is not an OS sandbox and cannot erase previously seen native context.
- **Actual local project files.** Resources and document links resolve bound Mac files by repository scope and relative path, independently of the sync switch. Opt-in saved-source/document/resource sync runs in the background, preserves conflicting versions and rechecks before writing. Git commits, review and merge remain separate.
  Directory binding checks read only the required historical Run fields, without repeatedly loading full outputs; isolation checks and history retention remain unchanged.
  Absolute shared-file citations from another registered device resolve by unambiguous same-project scope and relative path. Private `.workbench` files outside `docs/` remain visible citations without a preview link; publish them to shared documents before linking. No server-content fallback or history rewrite is used.
  Background reconciliation yields between small file-check batches instead of saturating the filesystem pool; all byte/path checks and reconciliation intervals remain intact. Explicit transfer captures keep their parallel path. Home progress reuses the current response's records, and command resends select only unacknowledged commands, without a persistent state cache or history deletion.
- **Markdown call documents.** Group-message cards and their full-screen view decode the known call-document envelope for readable Markdown headings, lists and code. Original stored messages and copy actions are unchanged.
- **Run detail layout.** Compact session/time/status controls, M-unit Token figures, separate input and original text, and one chronological output/tool record using the Sessions presentation. This is a front-end change; execution and stored history are unchanged. Runtime notes use the same collapsible activity blocks as Sessions, including repeated thinking-note counts; errors remain visible without nested CLI-log cards.
- **Visible progress and usable UI.** Read-only live input/output/tool events, execution-only progress labels, quota reset details, local file availability and compact attachment previews. Source-tracked Runs log pre-input file-verification time separately from CLI/model work. Basic Settings tabs stay sticky; supervisor role settings remain separate from project settings.
  Supervisor plans show **Plan error** when blocked, distinguish aborted steps from execution errors, and show **Not executed** for downstream steps explicitly recorded as never dispatched. Normal waits, stop confirmation and instruction-completion labels are unchanged; stored history and scheduling are not rewritten.
  Tasks shown in the waiting queue do not also create Agent reply placeholders in the chat. Each queue item shows one text line without timeout notes. Edit returns a human message to the input with its attachments and quotation, only while all its recipients are still queued; sending the revised draft queues it again. Existing drafts are not overwritten and running or coordinated work cannot be recalled. Original messages stay in history; execution cards appear after the task leaves the queue, and CLI occupancy checks remain accessible on queued items.
  Ordinary messages still queue. Only an explicit Steer click requests interruption, including when the supervisor is handling a protected collaboration wait. The original role/native conversation is retained, and the new input waits for confirmed process exit and the existing workspace gates. Its icon spins through stop confirmation and startup, and the item leaves the queue only when the replacement input is accepted (or execution is already successful). A failed request or startup keeps the message and exposes its reason. The old task does not resume automatically; history, existing changes and already-running peer work are preserved. Non-human stalled work retains its separate non-destructive priority action.
  Continuation failure/retry notices stay at their recorded event time in the chat history instead of remaining below newer messages. Earlier notices load with earlier history; error details and task logs remain available.
  Group chat and native-session cards use a 4% color overlay (96% transparency): the latest ordinary card is blue, execution errors are red and pending/waiting cards are orange. Other history retains its original styling. Error and continuation-wait notices use the standard message frame with their existing details and log controls; paging and refresh update decoration without changing records or scheduling.
  Execution History shows the execution's role name before its model, retaining saved role names after renaming or deletion and displaying an explicit unknown label when no identity can be resolved.
  Branch into new chat and Copy team into new project are two buttons under Project Settings → Basic information, without a separate group-actions entry on the main page. Their existing creation and preview flows are unchanged.
- **Fast session lists.** Saved Home catalogue entries appear before Worker verification; switching views keeps known rows. Unchanged history summaries use file-identity-based caching, and catalogue refreshes reread the selected transcript only when its history changes or a prior read failed.
- **Safe session operation.** Device capacity limits, per-runtime idle reuse (retained role processes up to one hour), verified leftover-process recovery and human confirmation before interrupting old work. Recovery checks run only for admissible queue heads and use a fresh asynchronous process snapshot, so historical turns do not block CLI probes or tool replies. Worker startup verifies saved process identity, preserves uncertain locks, and archives confirmed stale locks without deleting history or killing another process. Stall reminders default on after ten quiet minutes and never expand user authorization. Chats with task records are monitored while any task is todo or in progress; all done/cancelled suppresses reminders. Chats without tasks keep the message-based fallback. New settings start at the current chat tail; explicit off choices remain off. Successful final replies with no waits, unfinished children or transfers do not wake the supervisor.
- **Explicit permissions and wait ownership.** Supported role permission scopes apply at execution admission and survive warm reuse and terminal handoff; existing configured legacy roles retain their behavior. New role drafts cannot bypass scope selection. Collaboration waits keep same-role work queued until an explicit human yield, including discussion answer/resume turns. See [architecture and current platform limits](docs/ARCHITECTURE.md).
- **Fresh parallel chats.** Branch a group chat while keeping the same project folders and role configuration. The original chat remains usable; messages, tasks, native sessions, summaries and handoffs start independently. Shared files and device/workspace locks remain shared, so this is not a Git branch or a filesystem sandbox.
- **Team-only project copying.** Copy current roles and exact prompts into a new project with empty business folders on the required devices. No code, dependencies or history is copied. Preparation is retryable under one operation; existing unowned folders are rejected and the team becomes usable only when all required devices are ready. See the [feature contract and measured verification](docs/design-parallel-conversations.md).

Collaboration-session broadcast is retired: project switches are off, new batches cannot be created, and historical records remain readable. Only explicit human release of existing review opinions and closing an existing session remain available. Installation does not enable file synchronization on business projects. See [V3 design and measured acceptance](docs/design/session-queue-v3-acceptance.md), [file-sync contract](docs/design-source-sync.md), [CLI recovery](docs/design-cli-session-recovery.md) and [limitations](#limitations-and-roadmap) before enabling or exposing the service.

Sessions restore the last viewed registered conversation, show native history and page replies in the same turn layout, and keep the composer stable during refresh. Ordinary sends during a reply wait in a visible queue; an explicit Steer interrupts, then waits for verified process release before proceeding. The empty composer offers Stop. Cancelled messages and their reasons remain visible, and queued dispatch resolves the current Git credential without silently falling back after an error. Session overview, produced files and the collapsible right panel remain read-only views.

Session history and iTerm preparation remain available when a supported CLI is installed but signed out; page execution still requires sign-in. Resident Claude replies bind to the current input's replay UUID, not queued background notices. An ordinary resident input is accepted only on its matching replay; a matching pre-replay `refused` or `discarded` receipt ends it as not delivered without resending. Discarded sessions retire through verified process release. CLIs that omit these receipts retain the existing stop/exit fallback. Subagent and background-command rows show confirmed progress and elapsed time; a parent ending without a child's final event leaves that child's status unknown. File cards show readable names and extension glyphs, side questions use a compact growing input, and the older-history bar also offers a jump to the latest messages.

Editing a waiting session message returns its text and attachments only to that session's empty draft. While withdrawal is pending, only that session's input, upload and send controls are locked; other sessions remain usable and their drafts are not overwritten. Queue pause does not cancel a dispatch that already started preparing its Git credential.

Directory synchronization uses events first, including eligible empty directories. Fully installed watchers retain a five-minute metadata backstop and an hourly full hash; incomplete or failed watcher coverage retains the thirty-second/five-minute fallback. This changes observation cost, not transfer validation, history retention or synchronization enablement.

## Why this exists

**Remote Access** in Basic Settings manages the optional independent relay. On the Home computer, its normal view contains the server address, access password and enable/disable controls; domain and exceptional SSH settings are collapsed. Home/token/key paths remain private. Set `REMOTE_ACCESS_CONFIG` in the Home launcher's private environment to reuse an existing installation, or use the default beneath `DATA_DIR/remote-access/config.json`. The gateway stays a separate process, browser login lasts a fixed fifteen days, and public relay access does not grant local relay-administration rights. A relay must already be provisioned; changing an IP does not install a server. See [the module](modules/remote-access/README.md) and [the integration contract](docs/design-remote-access-settings.md).

Dropdown controls share a white, fine-bordered popup with indigo selection and checkmarks across settings, roles, devices and dynamic dialogs. Models and longer lists support search; native form values, validation and change handlers remain intact, with keyboard and mobile interaction supported.

Project file-sync settings also offer opt-in **Simple metadata mode (two devices)** for directory scopes, keeping the display-Mac requirement. Both Workers must advertise `sourceSyncMetadataMode:1`; existing scopes keep their content-hash policy. This mode compares each device's existence, nanosecond modification time and size with its own confirmed baseline. Ordinary observation does not hash content; two changed versions are hashed only for that path, and identical versions need no file upload. Terminal metadata batches reclaim private staging after guarded Worker confirmation; uncertain recovery defers cleanup and retries after restart. Conflicts keep both files and require a human to initiate the existing repair flow. Equal time and size can miss content changes. Existing files without a trusted baseline remain pending; explicit first-baseline initialization is available, while 30-day audit retention remains subsequent work. In-process HTTP integration is development evidence, not physical Mac/Linux acceptance. See [metadata mode](docs/design-source-sync.md#15-simple-metadata-mode-s1).

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

Minimal input still includes the short maintained stage boundaries and required-report entry. Independent review is read-only: outstanding mandatory corrections mean `failed`, unavailable verification means `blocked`, user decisions mean `needs_input`, and only nonblocking suggestions may accompany `passed`. Default collaboration guidance references scoped materials by path/hash, uses numbered repair dispositions and tracks blocker ownership; the long review, sync and error-code text is read on demand with `wb help review|sync|errors`. Exact previous built-in prompt defaults upgrade; custom and explicitly empty prompts, admitted instruction snapshots and historical reports remain unchanged.

## Key features

Workspace page refreshes read project-scoped SQLite summaries instead of materializing every historical execution body in JavaScript. Reply-presence evidence preserves the full-record progress rules, including whitespace-only responses. Global active execution marks remain visible in the sidebar; full state, history, detail and report endpoints retain their original bodies. This read-path optimization adds no cross-request cache, changes no synchronization intervals, and does not rewrite historical records or scheduling state.

Sessions interleave prose and tool activity in recorded order, group consecutive messages, and show the latest reply duration. The Connection card switches between page chat and iTerm only when the page is idle; terminal preparation keeps normal permission defaults. Session settings include the name, repository facts and an explicit repository-scoped Git account binding. SSH and extensionless HTTPS remotes use a private per-process URL mapping without changing the repository's remote. Group replies retain their trigger-time position, while receipt-based catch-up delivers late results even after the latest history page has moved past them.

Chat bubbles and composer fields use the Send button's 9px corner radius without changing their colors or spacing. Session tool summaries have a compact icon matching their first action. Claude's standalone interruption marker appears after the preceding user message's time, including an unsent page message; hover retains the original marker. Until that preceding message is loaded, a quiet standalone notice remains. Original history and task status are unchanged.

Native-session settings reject changes while the session is replying, without changing saved settings or stopping its CLI. Codex compaction retains its native turn identity for interruption. Background print-mode work stays in progress until the owner returns its final result; child-agent output and elapsed time alone cannot complete it. New-session permission bypass remains an explicit opt-in.

Device details includes **Reconnect Home** for Home-managed reverse SSH tunnels. It temporarily blocks new work for that device, checks platform activity and the Linux Worker's actual process/records over SSH, and refuses busy or unverifiable devices. Only the owned SSH tunnel is restarted; services, configuration, files and histories remain untouched. Success requires a heartbeat on a new Worker connection, not merely an SSH PID. This is manual connection recovery, not an installer or an automatic network repair policy.

The Sessions page defaults to Created sessions: only independent sessions created through Workbench's dialog are queried and shown. Users can manually select All sessions to also see managed group-role sessions and explicitly recorded takeovers; normal refreshes and tab switches preserve that choice, while a fresh page starts at Created sessions. The Group chats sidebar continues to list Workbench's own group records. External CLI conversations and helper-agent sessions are not discovered. History reads resolve registered IDs directly through the native index or exact workspace path; missing lookup metadata remains unavailable rather than falling back to a directory scan. Opening a session loads the latest 15 messages (subject to the existing bounded-read limits). Earlier messages load only through the Load older history button, in pages of at most 15; scrolling or touching the top does not fetch them. A successful latest-history read clears its previous transient error even when the content is unchanged; earlier-page failures and unread-message gaps keep their own retry controls. Home and Worker must both support this ownership contract. Original vendor histories and active tasks are not deleted or interrupted by this change.

The Sessions page's 侧问 (side question) tab asks a Claude or Codex session a quick read-only question on a temporary copy (Claude: its last 10 turns) that is removed when cleared, when the main session gets a new prompt, after an hour idle or two hours, or when the device restarts; nothing is saved. Settings → Data shows what Home and each device store and reclaims finished sync bookkeeping and old sync snapshots, automatically (a minute after start, then daily) or on demand; chat history, session turns, attachments and run logs are never touched. History pages read backwards through a 6 MiB window (up to 45 prompts and 768 KiB of rows per page) and cross windows that hold no displayable rows within a 12 MiB transcript-read budget, so a reply stays under the 1 MiB socket limit. When a page starts inside a turn, the Worker looks back (at most 32 MiB, cached per history) for that turn's prompt time, so the turn still shows how long it took. If that budget finds no displayable rows, the history button shows a continuation notice and keeps the advanced cursor for the next click. Empty older pages do not rebuild already loaded rows; latest-page refreshes do not clear the older-page notice. Original histories, snapshot checks and on-demand loading remain unchanged.

Session Details shows the model and reasoning effort explicitly recorded in the latest bounded native-history window, plus the selected device/CLI account's reported five-hour and weekly quota. It reuses role-card quota indicators and reset details. Missing fields stay unknown; older history pages do not replace the latest settings, and offline/stale quota is labeled as recorded data. This read-only display adds no quota polling, inference, session configuration changes or external history discovery. End takeover is in this right sidebar, including before the first message; the composer omits the takeover reminder row. Sending, uploading and active-turn guards remain in place.
In Sessions mode the right side now matches the group-chat panel: the same header and three bottom tabs, **Session** (continue, takeover and terminal controls, an editable name for Workbench-created sessions, session ID and folder, and the folder's Git root, branch, commit, upstream and change summary read offline on its device), **Recent Outputs** (media and archive files named in the loaded replies, plus the project's group-chat Recent Outputs when the session has a trusted project link) and **Resources** (device, CLI, model and quota).

Resolved role recipients appear as blue labels inline with the message body. The composer highlights known `@role` names with the same blue frame while keeping the native textarea and plaintext message format. Backspace, Delete, partial selections and cut/replacement consume a complete role label; ordinary prose, IME composition and existing mention routing remain supported.

Role cards, group-chat entries and native-session entries support press-and-hold dragging to reorder. Quick swipes still scroll; dragging near a list edge scrolls it, and releasing saves the order in this browser. Role order is per project and the fixed supervisor stays first. Session filtering preserves hidden entries' positions. Sorting changes only presentation, not role configuration, scheduling or native history.

**Devices and CLIs** also allows removal of an unavailable CLI entry from one device's catalog. This preference survives refreshes while the CLI remains unavailable; a later successful availability check shows it again. Installed software and native histories are retained.

**Configuration Information**, after **Platform Prompts**, replaces the configuration-assistant composer with read-only software versions and update notes. Home and each local/server Worker report their own startup source identity, independently of project bindings. **Check for updates** compares with the package repository’s GitHub `main`, shows commit summaries and comparison links, and distinguishes latest, behind, ahead, diverged, modified and unknown versions. Checks are manual and cached for one minute; nothing calls an AI, installs code or restarts services. Offline devices show only their last report; old Workers or release copies without a verified build stamp remain unknown. Existing assistant history, APIs and admitted tasks are retained. See [release identity](docs/OPERATING-GUIDE.md#43-release-identity) before packaging a copy without Git.

Offline device cards support deletion after the Worker is disconnected and unfinished work is settled. Deletion forgets the registration and its saved connection credential, preserves files and historical records, and does not reassign project bindings. A saved removal record rejects automatic reconnection under the old node identity.

Role cards include a small number-free context-used ring after the model name, separate from account quota remaining. Claude uses the latest main-request input and the native resolved model window; Codex uses its latest-request input and reported window. Hover or tap for percentage, token counts and measurement time. Unknown limits, unsupported CLI telemetry and pre-upgrade history show an unknown ring, not a guessed percentage. This is passive telemetry; it does not call models or compact sessions.

All role cards, including the supervisor and inactive roles, use a left-aligned model-mark watermark at eight times the 22px foreground icon size and 96% transparency. The decoration is clipped to the card, excluded from accessibility and pointer interaction, and does not dim the foreground text or buttons. Unconfigured roles use the existing generic Agent mark.

Claude and Codex quota now comes passively from their normal managed group-chat and session connections. Claude reports optional five-hour/week windows in `rate_limit_event`; Codex reports `account/rateLimits/updated`. Worker runtime detection no longer runs Claude `/usage` or Codex `account/rateLimits/read`. Installation, sign-in and model discovery still run; Grok account-status and Agy usage/credit checks are unchanged. Samples retain their own observation time, expire per window at that window's reset and show as not latest after three hours without a new sample (the quota popover shows how old a sample is); a Worker restart or one timed-out sign-in check keeps them, and they never infer a full balance. A changed or unknown account identity cannot reuse another account's quota. Interactive external terminals are not scanned. Missing fields stay unknown; no model turn is started to obtain quota and no credentials or history are changed. This reduces extra quota probing; it does not remove native authentication renewal or establish a fix for authentication failures.

Claude model choices use the CLI's returned catalog, including Fable when advertised. An explicit device `CLAUDE_MODEL_ID` still restricts third-party providers such as MiMo; existing role selections are not migrated. Fable selectors warn that non-interactive Claude Code may bill paid usage credits without another confirmation. Discovery does not invoke inference or enable credit purchases; account billing and actual model access are separate checks.

The sidebar switches between **Group chats** and **Sessions** without changing the three-column layout. Text tabs use a blue active underline that lies on the full-width gray divider, alongside a borderless single-bubble new-conversation button. Project rows use unboxed outline icons; a selected group chat or session keeps the ordinary row surface and border and is marked only by its accent-colored title and icon. Footer controls are unchanged. Sessions defaults to Created sessions and All Agents, showing only dialog-created independent entries. Manual All sessions selection additionally shows managed group-role histories and explicitly recorded takeovers across devices; it does not discover external histories. Compact source/device and Agent filters expose group histories separately from independent local/server/other-device sessions. Operations and returning from iTerm refresh the view automatically; histories are not deleted. New sessions choose a title, device, tool, folder and an explicit optional permission bypass. Existing sessions can continue in iTerm or through an explicitly confirmed page takeover, without Workbench role prompt injection. Page takeover supports streamed replies, attachments, stopping a turn and ending takeover; Codex, Claude and Agy retain a CLI process where supported, while Grok resumes per turn. Agy binary histories currently show metadata only. Catalogue reads require capability 2; safe page takeover requires `nativeTurns:3`. Exact native-ID association and verification limits are described in [native session browser](docs/design-native-session-browser.md).

Sessions with an unambiguous saved project/group/role binding have one sidebar entry opening the newest created session. Scroll upward in the chat pane to load earlier messages, then older sessions of that same owner, separated by date, device and native identity. There is no sidebar history submenu. Loading history is read-only and never changes the selected send/takeover/release target. Device and CLI changes do not split that role's group; unrelated native sessions remain separate. Filtering and the existing partial-catalog notice still apply. Paged reads require `nativeHistoryPages:1`; older Workers show an upgrade notice. Each read is bounded; an oversized individual record or unsupported binary history is reported without modifying the original file.

Worker history reads reuse bounded, process-local discovery and header summaries while checking directory and file changes. Concurrent reads share discovery; paging still opens and verifies the original history file, and new or moved histories do not wait for cache expiry. This does not cache message pages or start a CLI.

Executing group chats and exact native sessions show the same small blue hourglass at the right end of their sidebar row, whether or not they are selected. It rotates slowly once every six seconds, or stays still when reduced motion is requested. Both lists' leading icons are 15% larger; rows reserve room for the status symbol without shifting their text, and collapsed navigation places it below the leading icon. Queued work, waiting for input, offline/unconfirmed execution and idle resident CLIs show no hourglass. Existing state updates remove it when execution ends; no extra catalogue polling is added.

Project/binding folder pickers and the native-session file picker offer **New folder** on Workers advertising `directoryCreate:1`. Enter an allowed parent directory first, then create one named child and use the refreshed selection. Creation happens on the selected device, never overwrites an existing entry, and does not change a resumed session's fixed working directory. Home and the selected Worker both need this version; older Workers retain their original scope.

Local Workers advertising `localFolderSelection:1` let human folder pickers browse accessible filesystem directories, including hidden folders, Desktop, Downloads and mounted volumes, or enter an absolute path. Only the requested directory level is listed; browsing creates no execution grant. New projects can bind the selected existing folder directly instead of creating a child under the default workspace. Existing files and Git state are kept; no AGENTS.md, repository or synchronization setup is performed by that selection. Leave the field empty to keep the default creation flow. Remote devices retain their configured roots. New supervisor creation reuses the existing permission-scope selector and never silently defaults to device-wide CLI access.

Extra folder access is tied to the exact project or registered native-session identity, not appended to global `WORKER_ROOTS`. Home persists the binding before issuing its authorization envelope; Worker checks its preparation receipt and directory identity for that request. Other projects cannot borrow the grant, symlink escapes and replaced directories are rejected, and filesystem roots cannot be bound. Cancelling an unstarted native entry, deleting a project or rebinding its directory invalidates the corresponding grant without deleting files/history. This is Workbench routing authorization, not an additional OS sandbox for a CLI using native permission bypass. See [local folder design](docs/design-local-folder-selection.md).

Failed folder preparation releases its unused reservation immediately when the Worker confirms it is safe. Home retains pending cleanup through disconnects/restarts and retries through existing terminal reconciliation; active or uncertain processes are never stopped by this cleanup. Revocation tombstones prevent late preparation/activation from reserving the folder again. A confirmed release lets the same form retry with a new operation ID; an unknown response retains its original ID.

Session details now show terminal occupancy and offer Return to platform or confirmed Stop CLI and return. After a successful return in the current browser tab, the session keeps the group-style composer, attachment upload/preview and drafts; verified release of page takeover keeps that composer too. Returning alone does not grant automatic tool approval or start a CLI: the first send still requires the existing permission confirmation when needed and resumes the exact native session through the existing occupancy guards. A failed or pending return does not enable this mode. Exact native identity preserves the original group association after a folder move; unknown or conflicting ownership blocks takeover. Home and Worker must both support the updated takeover contract. These controls reuse automatic return and do not add polling.

The role terminal dialog shows the latest historical session without a dropdown and keeps older records intact. **Open new session** reuses the independent native-session form with the role's device and CLI preselected; the folder is chosen separately, and no group history or role prompt is supplied. **Verify and resume history** retains the existing exact-session checks and terminal return controls.

Claude and Codex page takeovers receive a short question-card hint once per session and instruction version. The page hides this block while native history retains it; explicit input acceptance confirms delivery, independently of whether the reply later fails or is interrupted. Unsupported Workers and control turns do not receive the hint. No launch-level duplicate prompt is added.

Task progress uses six labels: **Pending execution, In progress, Waiting, Completed, Stopped, Execution error**. A normally delivered review is completed even when its business verdict is negative; verdicts remain in the reply and delivery report. Waiting reasons and execution errors stay visible, and process stop must be confirmed. Existing plan policies and acceptance actions are unchanged; old records are not rewritten or automatically retried.

Home checks steering barriers through a role-scoped index instead of rereading every historical task for each queued item. Follow-up coverage reuses one project-request read per synchronous check. Neither change caches scheduling decisions across turns or changes queue, approval or history rules.

Execution details include an **Result original** tab after **Artifacts**, replacing the separate execution-result original button and dialog. It reads the selected Run's stored text on demand, with paged loading and exact full-text copying. Ordinary message originals and quotations still refer to their own message records.

Chinese prose is displayed in Simplified Chinese in chat (including user messages and quotations), live/fullscreen replies, execution output and Markdown previews. This browser-only character conversion uses a bundled OpenCC dictionary without translating English or making a model/CDN request. Code, commands, paths, editable input, original-text views, copies and stored records retain their original content.

Chat message bodies retain their compact height and scroll internally when longer, rather than clipping after ten lines. Refreshes preserve each message's reading position; the existing full-screen action remains available for long replies.

Directed role questions and published replies appear as individual chat bubbles with sender → recipient, content and time. Replies after a wait retain the original recipient even when the question is on an older history page. The question's Original button opens that message, not its sender's Run result. This display does not change dispatch, waiting, independent-review visibility or explicit-publication rules.

For document consultations, `wb call ... --text "review this document" --file path/to/document.md` reads the UTF-8 file directly, attaches its exact text and SHA256 as quoted reference data, and keeps the existing 12000-character call limit. It does not transfer or overwrite a peer's workspace. Larger shared documents should be referenced for on-demand reading; protected independent reviews keep their original document-read boundary. Retained Agy processes use the supplied `wb --turn RUN_ID ...` entry: old turn IDs never follow a new turn. `wb help` remains usable with an expired context, and a saved report receipt explicitly distinguishes registration from the later end of the CLI turn.

Token Usage retains the device-composition comparison and uses one daily chart stacked by model across the two selected devices. Colors identify models; segment tooltips show their tokens, and column tooltips show the day's total. Saved ccusage model breakdowns use the same input/output/cache total as the device charts. A single recorded model can account for an unambiguous historical total; missing or inconsistent multi-model shares remain unclassified until available details are backfilled, never divided equally or guessed.

`wb discuss peers` and `wb discuss peers '{"view":"detail"}'` preserve all existing fields and add only `token 是余额` to each role. Values are `充足`, `标准` or `紧张` using the existing page colors; missing, invalid, stale or unidentifiable quota is `未知`. Only Home's saved snapshot for the bound device, CLI and model group is used, with the most constrained valid window taking precedence. This read does not probe a CLI, change scheduling or choose a different account/model.

All items below exist in the current code. Items that are only designed are listed separately under [Limitations and roadmap](#limitations-and-roadmap).

**Collaboration**

- Project group chat with `@role` dispatch. Explicit mentions create separate tasks for each distinct recipient, up to four, without automatic supervisor rerouting. Replying defaults to the quoted agent unless explicit mentions override it; replies to humans remain quotations. Busy roles keep their normal queue. Ordinary agent messages do not implicitly dispatch work. Collaboration-session broadcast is retired and creates no new discussion batches.
- Per-project roles with their own device, CLI, model, reasoning effort and Markdown prompt. Five built-in templates (planning, execution, review, testing, cross-device); the first four carry responsibilities only, the cross-device preset includes an editable execution prompt. Templates are managed under Settings → Platform Prompts → Role Templates (add, edit, restore built-ins; none can be deleted); changes affect only roles created later and never create project seats automatically.
- Same-device Codex/Grok changes use **Handoff and switch** in either role editor: retain identity/history, drain accepted work, verify a new native session and commit only after process settlement. Cancel before commit keeps the original binding. Requires a compatible Worker; other adapters are explicitly unverified. See [CLI switch design](docs/design-role-cli-switch.md) for current acceptance status.
- CLI switch settlement, native-history admission, terminal release and Worker restart reconciliation distinguish the saved process startup from a reused PID. Confirmed foreign processes do not occupy an old session; ambiguous legacy launchers still wait safely. Saved tool children remain checked, and these checks never signal unrelated processes or delete history. Updating a running Worker is a separate release step.
- Role names are mention identifiers (letters, digits, underscores or hyphens, without spaces); `all` and `everyone` are reserved for broadcasts. Existing role names are kept verbatim. Default intake follows the configured supervisor ID, not an English display name, and mentions support both ASCII and full-width punctuation.
- A fixed per-project *supervisor* that receives new unquoted requests without an `@`, proposes repository/role configuration cards (applied only after you confirm) and uses `wb task` to track work and `wb call` to assign or transfer it. The old schedule, collaboration and pass commands are removed; saved plans still settle and remain visible as read-only history. Its card is pinned above the work roles; click it to configure its device, CLI, model and reasoning effort in Role Details.
- Result receipts: when a called role saves a report or its call settles, Home records a receipt for the calling role (received → delivered → verified) without creating a task or waking a model. The caller's next accepted turn carries the summaries and references once; a waiting caller is not interrupted, and an idle caller is woken once by an existing monitor timer only when new receipts exist. Progress per item is derived from receipts and the caller's recorded decisions, and a pass for an older commit is shown as stale. A call that never ran also leaves one receipt with its reason: an admission failure (`not_executed`), a cancelled child while its caller continues (`cancelled`, not when the caller cancelled its own tree), or a target that stays blocked (`blocked`: at once for a disabled role, after ten minutes for an offline device or unusable CLI, which keep queueing). `wb progress verify` takes up to 50 `receiptIds` at once and returns each result; `acknowledged` records "noted" separately from `accepted`, so it never counts as a pass. The built-in platform and supervisor templates follow the operator's customized team prompts and add the tool rules: receipts and acknowledged, structured calls, per-file sync status, report files and error codes, plus stage ownership — results return to whoever assigned the work, and development → independent review → target-device testing advances one stage at a time with a single final handoff. Saved copies of the previous defaults follow them; custom prompts are unchanged.
- A waiting role always gets a definite outcome once its replies are back. Its continuation is created even if the role that delegated the work has already ended its turn normally; only a user cancel or redirect closes the wait (late replies are kept, nothing restarts). If the continuation cannot be created, storage errors are retried a few times and anything else ends the wait as `resume_failed` with the reason shown on the page and one receipt for the delegating role, so the role is no longer held by a wait that cannot continue. At Home start, waits the old resume bug left stuck long ago are ended the same way instead of being revived on old context.
- Tool refusals carry a code: `run_reconciling` and `home_disconnected` mean nothing ran and the CLI retries the same request a few times (1, 2, 4, 5, 5 s) before reporting it; `run_stopping`, `run_ended` and `paused` end the attempt and are not retried. `wb report status ID` from a later turn of the same role reports `other_run` with the Run that saved it instead of "not saved".
- `wb report` may attach 1-3 UTF-8 files from the bound project (`"files":["path"]`, 48000 bytes together); the CLI reads them like `wb call --file`, Home recomputes size and SHA256 and stores the bodies beside the report revision, so reports, Runs, receipts and page state carry only path, size and hash. `wb report file RUN_OR_REQUEST_ID [PATH] [OFFSET]` reads them in 20000-character segments wherever the report itself is visible; unreleased independent reviews stay hidden and a protected review cannot attach files.
- `wb call` accepts `--goal`, `--scope`, `--input` and `--return`, written as labelled lines ahead of `--text`. Nothing is shortened; a brief over about 1500 characters is sent unchanged with a `lengthNote`.
- `wb sync status '{"path":"RELATIVE/PATH"}'` answers whether one file arrived: per scope the canonical hash and each device's acknowledged hash and observation time, with `consistent`, `in_transit` (a batch is active for that device), `conflict` or `unknown`. An offline or unacknowledged device is `unknown`, never "missing"; a path outside every sync scope is `unknown` with `not_in_sync_scope`.
- Structured role-to-role tools exposed to every managed CLI through one `wb` command: consult another role (`wb call` / `wb wait`), report a business verdict (`wb report`, optionally with the exact commit `version`, the `stage` it evidences — implemented, reviewed, tested, merged or deployed — and the original `item`), review result receipts and per-item progress (`wb progress`, `wb progress verify`), write a hand-off note (`wb handoff`), and request a Git delivery (`wb deliver`). An `@` inside model output never dispatches work.
- One `wb call` can address one or more roles: repeat `--role` for the same instruction. It creates one visible message with separate recipient requests and replies; retrying the same ID does not send duplicates. The sent card is completed once accepted, while each recipient's reply shows its own execution progress. Queued, live and completed replies quote their immediate public request and its sender, not the original ancestral user request; paginated-out requests still open their own originals. Quotations and recipients appear above the body, with type/status and actions inside the card footer.
- Queueing, per-role and per-node concurrency limits, cancel, "steer now" for queued human messages, pause for remote dispatch, and explicit stop with confirmation from the Worker.
- Native session resume: each role keeps its vendor session across turns, with a background conversation organizer that keeps a shared project summary.
- Optional, off by default: peer discussion preview (`WB_DISCUSSION_PREVIEW`).

**Multi-device**

- Q/F reads: managed `wb read source|query|file <JSON>` discovers registered sources and reads current saved bytes without synchronization, Git-clean checks or execution copies. Projects default off; the authenticated `read-access` API grants explicit nodes/scopes and the two fixed read-only recipes. Identical request IDs replay the original observation; a new ID requests new facts. Replies and stored results are bounded. Cache fill, materialization and S execution are not implemented. See [the P1 plan](docs/plan-cross-device-execution-p1.md) for verification and deployment status.
- Home/Worker split over an authenticated WebSocket. Workers connect outward; the Home never reaches into a machine.
- Reliable delivery: persistent command and event outbox, idempotent command IDs, reconcile-on-reconnect, and no automatic re-run of executions whose state is unknown.
- Per-device project directories and a long-lived project baseline branch per repository (Git worktrees), with fixed-SHA cross-device delivery automatically pushed to its dedicated delivery branch after source success; this never merges or deploys code.
- Attachments (images and files, up to 6 per message, 20 MB each) with SHA-256 verification, and a "send to device" action for moving a file to another bound device.
- Large files of any size stay on the device that produced them. A video, audio, image, PDF or archive path in an agent reply (group chat or native session) becomes a small card; clicking it opens an in-page viewer that streams only the byte ranges the player needs from the source device, so playback and seeking start while the rest is still arriving ("Loading… streaming from the source device"). Download streams the full file to this computer on demand, and "Send to device" copies it into another project device's `.workbench/tmp/media/` with SHA-256 verification and progress; that verified copy plays when the source device is offline. Nothing is synchronized automatically for preview, and auto-sync now records a new file over 20 MB as `oversize` instead of failing the whole batch.
- Device onboarding helper over SSH (installs and connects a Worker on a remote Linux machine) and an optional Home-managed reverse SSH tunnel.
- Remote desktop from a macOS Home: check the registered server's xrdp, create a loopback SSH forward or reuse a verified existing same-user forward, then open Windows App's saved connections. Reuse also recognizes a direct same-user system `nc` ProxyCommand connected to the registered IP/SSH port; unrelated children and unverifiable proxy chains remain blocked. Unknown or ambiguous listeners remain blocked; externally managed tunnels are never stopped by this entry. Opening the app does not verify desktop login.
- Terminal takeover: continue a finished native session in iTerm (macOS entry point; remote devices are reached over your own SSH configuration), with the platform pausing dispatch on that device while you work.

**Operations**

- Scheduled jobs (once, interval, daily, weekly) and a model-free progress patrol that only wakes the supervisor on new anomalies (`wb timer`).
- Token usage statistics per device, collected with `ccusage`, with daily columns stacked by model across the selected devices.
- GitHub and Gitee account storage and optional repository creation (private by default).
- Installable PWA shell, desktop three-column layout and a mobile drawer layout.
- Draft images in group chat and native takeover use compact 120×120 preview tiles. Clicking opens the full image; hovering or keyboard focus reveals a corner remove button, which stays visible on touch devices. Other files retain 224×64 detail cards and failed-upload retry. Sent-message previews and transfer actions remain unchanged.
- Send stays disabled while a message is sending or its outcome is unknown; an exact receipt of the original message ID is requested and only a confirmed absence allows a retry with that same ID.
- New native sessions prefill a dedicated `native-sessions` child of the device workspace root. It is prepared on demand and reused without deleting files; users can select or create another folder. Existing sessions retain their original working folder.
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

Native session history loads recent conversation text and lightweight tool summaries first. Expand a tool step to fetch its command or output; long details use explicit continuation and loaded chunks are cached. This requires a Worker with `nativeToolDetails: 1`; older Workers keep the existing full-history contract. The browser keeps a bounded recent preview while refreshing, and older history remains reachable. See the [lazy tool history design](docs/design-lazy-native-tools.md).

For fixed-version review input, use `wb deliver --review <request-id> <full-commit-sha|auto> <summary>`. It publishes a dedicated review ref and receives it in an independent directory without advancing the project baseline or changing the bound checkout. Home and both Workers must support review deliveries. Ordinary `wb deliver` keeps its development baseline behavior. Registration is not publication or review acceptance, and old blocked cards are not rewritten; see the [review delivery contract](docs/design-review-delivery.md).

Role editing separates **responsibility** (used by other roles to choose collaborators) from **role prompt** (injected for that role's execution). A role does not receive its own responsibility through the team directory. Text-only edits work while its device is offline and preserve its CLI/model binding. Existing custom prompts remain unchanged; missing responsibilities are unspecified, not inferred.

The editable platform and supervisor v2 defaults describe proactive execution and evidence-based coordination. Delegation includes the goal, recipient role/change boundary, exact device/version/file inputs and required return. Shared prompt edits affect existing managed sessions at their next actual turn, preserve role-specific prompts and history, and do not interrupt running work. Retry/replacement guidance is not an automatic account switch or additional publishing permission.

The development Home/Worker contract supports minimal execution context and on-demand team discovery. Saved prompt changes apply at actual next-turn admission, not halfway through running work. The four adapters apply complete changed/revoked component events while retaining the native session; unchanged delivered versions are not repeated. Codex separately reloads a retained thread's current Run/tool environment. Explicit dependency waits can time out, resume and wait for the original request without dispatching it again. Isolated four-CLI native and cross-device acceptance passed for the documented combinations; local Agy is unavailable under the provider's location policy. This is not a production rollout. See [actual coverage and selective release gates](docs/design-minimal-injection.md#11-observed-acceptance-boundary).

Bilingual responsibility templates help collaborators choose planners, implementers, reviewers and testers. Their execution prompts remain empty; the cross-device preset prefills its execution text. These presets do not enforce a device binding or create a mandatory workflow, and the supervisor defaults remain separate. Existing custom role prompts and responsibilities are not rewritten. Safe automatic CLI handoff has [an approved design](docs/design-role-cli-switch.md) and an implementation plan awaiting review; it is not a released feature.

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

Group-chat roles can transfer whole-task ownership with `wb call --kind transfer`. The receiver arranges its reviews and replies to the user; final replies replace `wb report`. Migration, deployment and production operations must be assigned separately after review, rather than automatically following a stage plan, including plans saved by older versions.

Public reports belong in the bound project root’s `.workbench/docs`, using the absolute directory supplied for eligible managed turns. Older repository-local report links resolve to recovered shared copies under `.workbench/docs/repositories/<repository-key>/`. Recorded temporary-worktree artifacts are read from their source device with file-hash and repository checks; missing historical version evidence is labelled as a source-workspace snapshot rather than a historical commit. See [artifact source reading](docs/design-artifact-source-reading.md).
### Conversation task records

`wb task list`, `show T3`, `create '<JSON>'` and `update T3 '<JSON>'` manage a Home-only task list for the current group chat. Creation needs a stable `requestId`; updates need the current `revision`. These records neither start work nor interrupt a running role. Use `wb help` for field limits and plan shape.

`wb call --task T3` associates an explicit call with the task. Ordinary calls keep the owner; `--kind transfer` changes it atomically to the recipient and sets `in_progress`. The owner must first rewrite the full description using `wb task update` in that same run. Linked calls and their continuations receive the current task description/plan; a later turn marks a description changed since that role last received it. Task-list UI and task-based heartbeat policies are not included yet.

The group chat **Recent Outputs** inspector includes a conversation-scoped **Task list** above artifacts. Open a task to edit its description, plan, owner and status, inspect change history, or jump to linked messages. Completed and cancelled tasks are hidden by default and can be included. Updates use the existing state refresh flow; revision conflicts keep the local draft instead of silently overwriting another edit.

Review delivery supports a repository subset: `wb deliver ID auto SUMMARY --review --repo KEY` (repeat `--repo` as needed). A review SHA without a selector must exist in exactly one local repository. Ordinary delivery still includes every repository. Only included repositories are published, bound on the receiving device and opened in detached review worktrees; omitted dirty repositories do not block review delivery. The delivery card lists included keys and identifies partial scope.
Retired wb report/schedule/collaboration/pass commands return actionable guidance without loading a turn context and still exit nonzero. Results are returned through the final reply; dependent steps belong in wb task plans, while wb timer is only for time-based reminders. Prompt settings and role editors identify obsolete commands by line. Platform/supervisor warnings offer an explicit update to the current default, saved through the normal prompt endpoint with a promptsRevision check; custom text is never automatically overwritten. Execution appends a short warning only to custom text that contains retired commands. Calling an upstream role that is waiting on the current dependency chain tells the caller to return its final reply; other active role loops remain refused.

Simple-mode initialization now has a paginated pending-path preview and two explicitly confirmed actions: one-time content verification, or initialization from a selected device. Overwrite first preserves both versions; failure preserves the working files. Jobs use bounded existing batches and can resume after interruption with a second confirmation, current revision and an idempotent request ID. Resolved metadata conflict copies are removed only after all device receipts/private cleanup and reference checks; shared legacy manifests/versions and unresolved conflicts retain their bytes. Retained copies are rechecked hourly; metadata audit history does not pin bytes, while legacy history still does. Repeated conflicts retain ownership of unreleased copies. Old hash-mode evidence is not reused to infer a current metadata baseline. No real project is migrated automatically.
