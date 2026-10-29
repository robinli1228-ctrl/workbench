# Incremental source synchronization and modifier-owned conflict resolution

Status: the original hash mode is implemented and independently audited for controlled, opt-in use. Section 15 adds opt-in S1 metadata mode; its development checks do not inherit the old mode’s physical acceptance. Two-device physical synchronization and managed modifier repair have passed; acceptance limits are listed in section 12. Existing projects remain disabled until their scopes are selected explicitly.
Updated: 2026-10-10. Sections 1-12 record the current release. Section 13 proposes the unified continuous project-file upgrade and is not yet implemented.

## 1. Approved intent and implementation boundary

Allow participating project devices to exchange saved source changes without first committing or pushing Git. Transfer changed files, not entire directories and not block-level deltas. Preserve both sides of a conflict and automatically route a scoped investigation and repair task to the relevant code modifier. Reuse Home, Workers, project bindings, role discovery and Task/Run queues; do not add a second service or scheduler.

The operator has selected controlled bidirectional synchronization. The design below defines its contract. This is distinct from the existing incremental UI state feed and from approved fixed-commit Git delivery. Git remains the formal version/review/publication path. File-sync permission does not authorize Git push, deployment, credential transfer or changes outside the participating project.

All devices retain independent local directories; shared writable mounts remain prohibited. Existing projects start disabled, and old Workers are explicitly unsupported rather than silently falling back to overwrite/copy commands.

## 2. Scope and triggers

- Enable per project with an explicit set of repository/device bindings. The UI shows the actual bound paths; modifying an unrelated clone does not enter this synchronization group.
- First release synchronizes registered Git repository workspaces, including saved tracked modifications and eligible untracked files. Project-root files outside registered repositories are not silently included.
- Initial entry points: an explicit **Sync source now** action, a same-project `wb sync request`, and a synchronization barrier before an explicitly linked cross-device task handoff. No continuous save-time upload or background propagation is enabled by default.
- Each request fixes source binding, target bindings, source manifest, repository HEAD, policy revision and a client idempotency key. It does not redirect to a different online device.
- A role can request source sync only for its current authorized project/workspace. An isolated Run may export a snapshot of its own repository output; it cannot designate an arbitrary directory. Task/Run snapshots remain immutable.
- No automatic commits, branch switching, stashing, rebasing, force pushes or native-session resets. Formal Git delivery remains available separately.

## 3. File selection and manifests

A manifest entry identifies repository-relative path, SHA-256, size, regular-file type and executable bit. Absence is an explicit tombstone, not a missing scan page. Modification time is display metadata and never determines which version wins.

Enumerate tracked paths and untracked paths allowed by Git ignore rules, then apply mandatory exclusions on both sender and receiver: Git metadata, nested repositories/submodules, platform state (`.workbench`, `.worktrees`, `.data`, `.local`, `.wb-bridge-*`), dependencies, build outputs, caches, logs, environment secrets, private-key/credential files and CLI login stores. Exclusions also apply to tracked files; an ignored name is not safe merely because Git tracks it. Allow source configuration examples such as `.env.example`, but do not claim filename rules detect every embedded secret. Show the included/excluded manifest before the first activation.

Credential names include `.netrc`, `_netrc` and `.npmrc`. Capture policy version 2 records ignored paths and directories without reading their bytes. If a previously known or newly offered file is now excluded on any endpoint, the entire batch is blocked before canonical changes; exclusion is not deletion. Home rejects old prototype captures that lack this policy metadata before uploading content or preparing writes.

Use regular files only; reject symlinks, hard-linked files, devices, sockets, path traversal, absolute paths and parent links. Detect case-folding/Unicode filename collisions against the receiving filesystem before writing. Handle binary source assets as opaque whole files, never text-merge them. Preserve executable bits without importing arbitrary ownership/permission bits.

Transfer defaults are 20 MiB per file, 100 MiB and 10,000 changed paths per transfer command, and 1 GiB retained Home content per project. When every participating Worker supports `sourceSyncBatching:1`, complete inventories are not rejected by a total file-count limit; manual and automatic differences are split into ordered commands. Legacy batches retain the old 10,000-path inventory and 100 MiB capture limits until both ends support the extension. An incomplete scan never becomes a successful partial inventory. Renames are represented as deletion plus addition; cross-path rename inference is not implemented.

Snapshot reads verify file identity and metadata before and after hashing; unstable files are rescanned once, then reported busy. Content is retained under its verified hash so a later source edit cannot change a queued transfer. Scans run only at synchronization or managed execution boundaries, not for every token event.

## 4. Common baseline and three-device consistency

Home keeps a versioned canonical manifest per project/repository, plus each participating device's last acknowledged manifest revision and per-path hashes. Canonical state records the accepted synchronization version, not the claim that every device already has it.

Initialization requires all selected bindings to identify the same repository and resolve the same full Git HEAD/tree. Seed the common base from that commit's eligible tree, not from whichever dirty workspace is read first. Treat each device's existing saved edits as changes against that base, including different untracked files at the same path. If HEADs differ, report `git_baseline_mismatch` and use the existing Git reconciliation path first; do not solve Git history divergence by copying files.

Per file, compare the device's acknowledged base B, its observed local version L and the canonical/source incoming version R:

| Condition | Decision |
| --- | --- |
| L = R | Record equality; do not rewrite or generate a new modification |
| L = B and R differs | Apply incoming version after a fresh destination check |
| R = B and L differs | Retain local edit; offer it as a source change against the current canonical revision |
| Both differ from B and each other | Open a conflict; preserve B, L and R |
| Missing/unverifiable B | Block or re-establish the baseline, never assume the target is unchanged |

Serialize canonical updates by repository revision in Home transactions. An outgoing change includes its expected base hash; an unrelated accepted change must not be overwritten by an offline device's old full manifest. Stale offers are compared again against current canonical state. Keep tombstones and original change IDs while any selected device is behind; receiving a synchronized version preserves its origin and does not create a new edit or bounce it back.

Unrelated conflict-free paths may synchronize, but the batch is shown as `partial_conflict`, not synchronized. Dependent execution requires the complete pinned input and cannot launch from a partly applied repository set. There is no multi-repository filesystem atomicity claim.

## 5. Transport, safe application and recovery

Home coordinates existing outbound Worker connections. Add `sourceSync: 1` capability; scan/apply controls and durable receipts use a dedicated sync command namespace, not fake business Runs. Extend the current durable command machinery with explicit ownership for sync records. Large blobs use authenticated, project-scoped streaming HTTP routes on the existing Home listener and staging storage. No SSH credentials, extra public port or direct Worker-to-Worker listener is required.

Transfer only hashes absent from the target's verified content store. Stream with bounded memory, verify length and SHA-256, and write a temporary file before promotion. Interrupted files restart individually; completed files are reused. No byte-range resume or global content deduplication service is required. Home applies per-project staging quotas and rejects new batches when full; unresolved conflict versions and rollback evidence are never automatically pruned.

Before applying a batch, Home and the target Worker reserve the target project/repository against new managed starts and Git baseline changes, and wait for existing affected Runs/manual takeovers to finish. Unknown or reconnecting processes block application. This is a short synchronization boundary, not a new role permission system. The Worker enforces the same boundary locally; Home state alone is insufficient.

Recheck binding identity, HEAD, expected path hash/type and pause/cancel state immediately before replacement. Persist a per-file journal and recoverable previous content before writes/deletes. Apply via temporary-file promotion and verify final bytes. A receipt carries the exact manifest/file hash and journal result. Persist receipts before sending them; lost receipts and restarts reconcile the same command rather than repeating an overwrite. Cancel leaves completed files and recovery records visible and does not pretend to undo them.

Concurrent unmanaged editors cannot be fully locked by the platform. Recheck and preserve displaced content, detect observed concurrent changes as conflicts, and document that users must avoid editing a destination during its brief apply step. Do not claim an ordinary check-then-rename is an OS-level compare-and-swap against arbitrary external writers. Recovery must never automatically discard a displaced version or declare an uncertain write complete.

When Home is unavailable, no new sync or conflict task is scheduled. Workers keep staged data and receipts. Do not claim that this feature makes a laptop-hosted Home highly available.

## 6. Determine the relevant code modifier

The existing Recent Outputs view is not an ownership ledger: it uses limited tool records and an mtime match and misses shell/external edits. Do not use its displayed CLI, a Git author, file mtime or the most recent active role as proof of ownership.

Record content-bound provenance for managed changes: project/repository/path, before/after hashes (including deletion), original node/workspace, role/Task/Run/session IDs, completed write evidence and how attribution was established. Capture execution-boundary manifests and normalize successful adapter write events. Preserve provenance through synchronization instead of attributing incoming bytes to the receiving Worker.

Only a unique completed managed write with matching captured content and no contradictory/overlapping evidence is attributable for automatic routing. Before/after Run differences without trustworthy write evidence are candidates, not proof; shell edits, external editors, historical changes and concurrent ambiguous writers may remain `unknown`. Hashes or provenance claimed in model prose do not establish an author.

Do not require every CLI to expose every write before basic synchronization works. Unknown ownership is supported visibly and routes to the supervisor with the candidate evidence; it is not silently assigned to an audit role. A role archive, device rebind or renamed role is resolved by stable IDs and current reachability, not display-name matching or a reused native session ID.

## 7. Conflict notification and repair loop

One conflict record binds project/repository/path, common base, both conflicting hashes, source/target provenance and a generation. Duplicate scans/transfers of the same unresolved versions reuse the record and notification. Repeatedly clicking Sync does not repeatedly invoke models.

Each side identifies its workspace endpoint by repository, device, root and original Run when isolated. A device can have several distinct saved outputs; tools and the version selector use `endpointId`, not just the device ID. The record separately retains the union of registered receiving directories across related requests. Review recaptures the original sources against the reviewed hashes and each receiver against its frozen physical baseline. Only receivers are written. An unchanged private source is not replaced by an unrelated project-folder capture; real edits invalidate the candidate. Missing original endpoint identity blocks review rather than guessing. Every participating receiver, including an offline one, must settle before resolution completes; a failed final receipt leaves `needs_input` while preserving earlier successful acknowledgements.

1. Preserve base and both versions in immutable project-scoped storage. Immediately publish a visible conflict card with file, devices, attributable modifiers and evidence links. No automatic side wins.
2. If the source change has one identifiable eligible modifier, make that role the repair owner. If only the target modifier is identifiable and eligible, use that role. If both exist, notify both, but create only one repair owner; the peer receives an evidence/explanation consultation rather than a second competing write assignment.
3. Unknown/ambiguous authors, archived roles or unreachable/unusable modifiers are reported once to the project supervisor for assignment. Keep the original attribution and any pending delivery. An offline modifier is not silently replaced; reassignment explicitly supersedes its queued repair so it cannot run later as a second owner. If no supervisor can act, keep a visible `needs_input` card.
4. Home creates a stable-ID system conflict task in the existing Task/Run queue, with real role routing. Do not fabricate a human message or rely on `@` text triggering dispatch. Persist conflict assignment and task registration atomically; queue busy roles at a turn boundary, respect global pause and node capacity, and never interrupt their current work merely to deliver this notification.
5. Give the owner the original task references, full peer directory, base/ours/theirs content references, exact hashes, attribution certainty, allowed file scope and verification requirements. Expose same-project `wb sync status/read/propose` through every supported CLI's existing bridge. The assigned role receives its normal execution prompt plus this task, not its own responsibility field.
6. The owner reads both versions and the original requirements, asks the peer about conflicting intent through existing consultation tools, and proposes a resolution in a dedicated working directory. Binary or deletion conflicts require an evidence-backed explicit choice; no automatic last-writer-wins. Supporting changes outside the conflict scope need explicit reassignment, not an implicit expansion.
7. Submission fixes expected conflict generation, input hashes, candidate output hashes, reasoning and actual verification evidence. A plain "fixed" reply or successful CLI exit is not a resolution receipt. Home checks the proposal belongs to the current owner/Run; Workers rehash artifacts and reject stale input. Fresh edits create a new generation and invalidate the old proposal.
8. Current implementation requires independent human inspection and acceptance of the exact candidate before distribution: a successful shell command is not a candidate-bound test contract. Apply the accepted candidate through the same checked transfer protocol, preserving prior contents. Mark each device synchronized only after its own matching receipt. A repaired canonical version with an offline device still pending is `resolved_pending_sync`, not globally synchronized. Launch dependent tasks only when their target has all required hashes.

Allow at most two confirmed-ended automatic repair attempts per conflict generation; unknown process state is never retried. Continued disagreement, missing requirements, repeated stale proposals or failed verification goes to the supervisor/operator with evidence. Do not let notifications and self-generated edits create an unbounded repair loop.

## 8. Execution must consume the synchronized content

The current `prepareExecutionWorkspace` creates a new worktree at a fixed Git SHA and does not include dirty baseline files. Merely updating the baseline would therefore leave isolated execution on old code. A sync-dependent Task/Run must freeze `{repositoryId, baseCommit, manifestRevision, manifestHash}` with required blob references, independently of the role snapshot.

For a normal project-directory Run, the Worker checks the frozen manifest against the actual registered workspace before launch. For an isolated execution, create the normal fixed-SHA worktree and apply the frozen source overlay (including deletions) there before starting the CLI. Record the resulting manifest in the Run. A later sync must not alter a running worktree or rewrite an existing input packet. An incompatible Worker or missing blob blocks launch; never silently fall back to clean HEAD.

Inject a per-turn source-version receipt even when a native session is resumed or warm. Require the role to reread changed files; cached conversation claims do not prove current file contents. Formal fixed-commit Git review keeps its original semantics unless explicitly given a source-snapshot input. Dirty-overlay execution reports both Git base and manifest version, never claims that the SHA alone identifies its code.

## 9. User interface and compatibility

Add Source synchronization below repository status in Resources, plus per-project configuration. Keep Git status and file-sync status separate. Show bindings, enabled devices, pending/busy/offline/unsupported states, changed-file counts, last verified receipt and unresolved conflicts. Provide Sync now, pause/cancel and conflict details; do not add a new top-level panel.

Conflict details show attribution certainty, both versions, resolution owner, notification/task progress and proposal/verification status. Actions include inspect, explicitly assign/reassign, retry a safely ended blocked operation, and resume after resolution. A conflict does not automatically close because the role reported success. All new UI copy and runtime tool instructions support English/Chinese; custom role prompts remain unchanged.

Store sync configuration, canonical/device manifests, batches, per-file receipts, provenance and conflicts in existing Home/Worker SQLite stores using bounded indexed records. Full file bytes stay in private staging, not hot `/api/state` projections or logs. Project deletion and binding changes fence old sync commands using a generation/tombstone; late receipts cannot resurrect deleted state. Retain recovery data until explicitly cleaned.

## 10. Implementation boundaries to cover in the plan

| Area | Existing touchpoints | New responsibility |
| --- | --- | --- |
| Snapshot and apply | `worker.mjs`, `project-repositories.mjs`, workspace boundary checks | File policy, manifests, staging, apply journal and local arbitration |
| Coordination and transport | `home.mjs`, `store.mjs`, reliable Worker connection | Canonical revisions, node manifests, sync-owned commands and receipts, blob routes |
| Modifier attribution | `run-artifacts.mjs`, adapters, Run events | Separate hash-bound provenance; do not upgrade the existing heuristic to proof |
| Repair routing | `rooms.mjs`, `role-calls.mjs`, team discovery | System-origin conflict tasks, peer consultation, bounded owner lifecycle |
| Agent entry and prompts | `wb-tools.mjs`, `wb-cli.mjs`, `agent-bridge.mjs`, both locales | Discoverable sync status/request/read/propose and execution-version context |
| Run preparation | `execution-plans.mjs`, `execution-workspace.mjs`, `run-input.mjs` | Freeze source overlays and verify actual CLI input workspace |
| UI and documentation | Resources, project settings, locales, service worker, current docs | Distinct file/Git states, conflict details, capability gates and truthful status |

Use focused modules for manifest comparison, Worker filesystem I/O, Home sync coordination and conflict routing. Extend existing services, not broad unrelated refactors. Tests and fixtures remain under ignored project-local directories; no production project files are used for destructive tests.

## 11. Acceptance gates

1. Real local plus remote Worker: edit an eligible uncommitted file, sync it, verify matching bytes and unchanged Git HEAD/index on the receiver. Repeat backwards and with a new source file, binary asset, deletion and executable bit.
2. Three-device protocol: offline edits, reconnect, tombstones, unchanged echoes and competing requests cannot silently replace newer versions or create infinite rebroadcast. If a third physical device is unavailable, report simulated coverage separately from real-device acceptance.
3. Both sides edit the same path, including delete-versus-edit and conflicting untracked additions: original contents survive and exactly one conflict generation is created. Unrelated paths may complete but dependent tasks remain blocked.
4. Real managed CLI modifiers on different devices: correct owner receives a queued repair task with base/both versions and peer lookup; peer explanation reaches the owner; real candidate and test evidence are checked; both devices eventually report the resolved hash. Do not substitute a fake task/message for this gate.
5. Unknown/external/shell writer, archived role, renamed/rebound role, offline device and unavailable CLI: no fabricated author, no wrong-role execution, no duplicate repair after reassignment.
6. Every exposed supported adapter can discover/read the sync tools and receive pinned snapshot context. Report actual adapter coverage; unsupported combinations stay gated rather than claiming universal success.
7. An isolated downstream CLI actually reads a unique uncommitted source marker from its prepared worktree; a clean-HEAD-only fallback must fail the test. Warm/native resume receives the changed-version notice.
8. Inject target edits between scan/stage/apply, symlink or hardlink substitution, case collisions, quota exhaustion and truncated scans: no unreported overwrite, boundary escape or false successful manifest.
9. Crash before/after a file rename or receipt, lose an acknowledgement, duplicate commands and restart Home/Worker: reconcile journaled effects without losing either side or relaunching repair models.
10. Busy/unknown Runs, manual takeover, binding changes and project deletion block or fence writes and late commands (the former global pause was removed on 2026-10-28; a disconnected Worker still refuses). Cancel during a batch retains accurate per-file outcomes.
11. Stale resolution, repeated failures and second modifications during repair invalidate old proposals; two-attempt limit and escalation work without a tight loop.
12. Real browser: configure, preview scope, sync, open conflict/evidence, view owner/notification/result, switch language and reload; state persists and no secret/file body leaks into routine status output.

Completion reporting separates spec, implementation, local checks, real two/three-device verification, actual model repair, commit/push and deployment. Do not enable this feature on existing business repositories merely because unit tests pass.

## 12. Current acceptance boundary

Automated checks cover bounded capture, exclusions, three-way comparisons, a three-node protocol simulation, safe apply journals, receipt replay after Worker restart, scoped candidate submission, owner assignment and independent-review blocking. Additional regressions cover private source versus receiving endpoint identity, same-device multiple outputs, successive requests retaining every receiver, genuine concurrent edits and a failed last distribution receipt. Real browser testing covers scope preview/activation, disk transfer, conflict versions including multiple sources on one device, language switching, persistence and late-response project fencing.

Physical macOS/Linux Workers have transferred saved uncommitted edits in both directions, including new/deleted files, binary content and executable flags, without changing Git HEAD or the index. A remote Worker disconnect/restart and request replay were exercised. Real Codex modifiers on both devices produced conflicting isolated outputs; their verified write evidence selected one repair owner and created a peer explanation task. A scoped candidate preserved both requested changes, passed the fixture check and reached both registered receiving directories with matching receipts after an independently checked, explicit review gate. This fixture does not prove arbitrary business requirements or automatic independent acceptance.

Codex, Claude Code, Grok Build and Agy each read the actual synchronized marker from an isolated Linux workspace, invoked `wb sync status` through the real bridge and continued on the same native session ID. Continuation keeps the source session key on both Request and Task; it retains owned output rather than reapplying the initial snapshot. Managed conflict write attribution/repair was exercised with Codex; other adapters' attribution remains conditional on their verifiable native write events. A third physical device was unavailable, so three-device coverage is simulated, not a physical acceptance claim. Software installation does not activate existing business-project scopes.

Attribution is limited to successful native write events whose before/after bytes can be verified. Shell-only edits, external editors and ambiguous overlapping writers remain unknown and route to the supervisor. Recorded successful shell execution is necessary candidate evidence, not proof that the command actually tests every requirement or binds the tested content. Until a trusted candidate-bound verification contract exists, every repair proposal requires independent human inspection and acceptance before distribution. Automatic notification/repair-task creation remains available, but fully automatic conflict acceptance is not implemented. The UI exposes the exact proposed bytes as a separate file version.

Recovery tests cover process interruption, not arbitrary power-loss durability or an OS-wide file compare-and-swap guarantee. Scanning large committed trees currently invokes Git per file; performance at the configured limits is not benchmarked. Private recovery files and content staging are retained, and interrupted upload reservations can conservatively consume quota until inspected. No automatic garbage collection is claimed.

## 13. Unified continuous project-file synchronization

Status: implemented and tested in isolated local and physical Mac/Linux environments. Sections 1-12 describe the legacy repository-based release and its measured limits. This section is the authority for continuous project-folder synchronization; [Mac-local file viewing](design-shared-documents.md) consumes it without defining another synchronizer. Deployment and activation remain separate operations.

### 13.1 One engine, one owner per file

Source code, documentation and required resources share configuration, manifests, per-device baselines, transfer, apply journals, receipts, conflict records and modifier repair. File type affects inclusion and preview, not the synchronization algorithm.

Manual Sync now, filesystem notifications and authorized agent/handoff requests enter the same persisted queue. Coalesce equivalent pending changes and serialize incompatible applies. Receiving an already acknowledged hash does not create a new originating edit.

Every physical file has exactly one active scope. A project-folder scanner excludes subtrees owned by explicitly bound repository scopes. Reject overlapping roots during preview and again on the Worker; legacy source sync and a new folder/document scope cannot independently write the same file.

Evolve the existing source-sync configuration and records to support stable scope IDs, preserving legacy repository scope identities. Do not add document-only baseline/conflict/apply tables or a second writer. Home may keep transfer/recovery bytes; the page reads the selected Mac's actual file.

### 13.2 Scope and baseline compatibility

Add explicit project-folder scopes beside existing repository scopes. The default source-only policy includes source files, documentation and required ordinary/binary resources. Permit the selected project's `.workbench/docs/` subtree as a narrow exception even when its parent is Git-ignored; exclude the rest of `.workbench/`. Section 14 defines the separately approved output policy. Enforce the versioned policy, mandatory exclusions and current bounded transfer limits on both endpoints.

The current capture requires a Git root and committed-tree baseline. Relaxing only the path filter is insufficient. Add saved-content initialization within the same engine: identical captures establish equality; one-sided new files can be offered to absent peers; different existing same-path contents create a conflict before writes. The first capture is not automatically authoritative.

After initialization, code and documents use the same base/local/incoming hash comparison and deletion semantics. A verified Git tree may seed an eligible scope's initial base, but a document extension does not choose another algorithm. Git HEAD/index/history remain independent; file equality does not imply Git-history equality.

Legacy scopes retain their old policy until migrated. Migration fences the old generation, settles or preserves its pending receipts/conflicts, recaptures actual endpoints and establishes the new generation. Unresolved conflicts survive migration or block its completion. Only the new generation may then write that scope. Old Workers cannot accept new capture/apply/watch payloads, and late old-generation commands cannot write after migration.

Preview actual included/excluded files and repository-specific read-only/writable bindings. Installing the software alone does not activate other projects or broaden receiving paths. Filename exclusions do not prove ordinary files contain no embedded secrets.

### 13.3 Background operation

Workers watch eligible paths independently of browser pages and model sessions. Notifications, including editor atomic saves, are hints for stable capture. Proposed coalescing defaults are a 500 ms quiet window and a 2 s maximum scheduling delay; measure normal latency rather than promise every transfer finishes within that time.

Persist dirty paths and reconciliation progress. Bounded periodic, startup and reconnect scans recover missed notifications and changed directories. Watcher failures report degraded scanning. Ordinary saves update affected manifest entries rather than capturing every Git object again.

Reuse durable transfer, guarded apply and recovery journals. Offline Workers retain local changes. Reconnect compares current endpoint contents with baselines before writes. Suppress receiving echoes only after reading bytes that match the receipt, never by ignoring all changes during a time window.

Known active/unknown writers and terminal takeover keep unsafe applies pending without interrupting the CLI. Discovery may continue. A Worker disconnected from Home stops transfer/apply while retaining dirty changes (the former global pause was removed on 2026-10-28). Scope disable/rebind/deletion fences watchers and pending work. Home unavailability does not start a second peer control plane.

### 13.4 Deletions, renames and conflicts

Reuse versioned tombstones. Absence caused by an offline node, failed/partial scan, changed ignore policy or missing binding never means deletion. Delete only against the expected receiving version; delete-versus-edit preserves the modified file as a conflict.

Represent renames as linked add/delete operations in one journaled change set. Prepare both paths, preserve originals and record per-path effects; expose partial/pending state until all receipts settle. This extends the current unlinked add/delete representation and does not promise a multi-path atomic filesystem transaction.

Apply the existing modifier-evidence and repair flow to code, documents and resources. Verified authors receive one correctly attributed repair request; unknown authors go to the supervisor. Repeated scans cannot duplicate owners. Further edits invalidate old resolutions, and distribution uses the existing independently accepted, hash-bound candidate path.

### 13.5 Unified acceptance

Extend current regression gates with real Mac/Linux checks:

1. With no page open, saved code, shared documents and required resources reach the other actual project directory. Repeat in both directions and measure ordinary-save latency.
2. Manual requests and watcher events for the same version cannot duplicate writes, conflicts or repair tasks.
3. Reject overlapping scopes. Migrate with one baseline/owner and fence old commands; unsupported Workers cannot accept new policy semantics.
4. Different initial contents, concurrent edits, delete/edit, rename/edit, transfer-time writes and name collisions preserve versions and receiving data.
5. Offline saves, missing watcher events, process restart, dropped receipts and reconnect retain changes without stale overwrite or endless echo.
6. Enforce project boundaries and exclusions for Git metadata, credentials, dependencies and isolated worktrees; verify the exact shared-document exception at both endpoints.
7. Paused/busy/unknown endpoints remain accurately pending. Ordinary synchronization preserves Git HEAD/index, roles, native sessions and terminal leases.
8. After the Mac receipt, the page reads that actual Mac file. Moving Home does not change the display node; remote-only files remain waiting until physically present there.

Implementation, physical/background tests, browser tests, commit/push and deployment are reported separately. Existing section 12 results do not establish acceptance of this upgrade.

### 13.6 Observed implementation boundary

Receipt recovery separates evidence delivery from operation acceptance. Transport timeouts remain reconciling instead of becoming terminal numeric error codes. Cancelled captures send an inline cancellation rather than referencing an apply upload. Late, validated Worker results that disagree with an already terminal Home command are preserved in `sourceSyncLateReceipts`; a hash-bound delivery acknowledgment retires only the matching outbox entry, without changing the original operation result or reapplying files. Durable command results and file journals remain available.

Worker replay selects small, due transport records before loading receipt bodies, so unready or cooling entries cannot monopolize the first page. Unready saved uploads recover one at a time with up to five attempts; receipt retransmission backs off from five seconds to five minutes. The watcher does not continually create replacement batches for permanent failures, cancellations or an unchanged observation that has exhausted five attempts. A fresh content observation or an explicit sync request can request new work. These changes retain existing history and do not shrink old databases or add automatic garbage collection.

The directory implementation passed 87 focused local regressions, including the existing Git-mode suite, and the 13-test maintained suite. A real Linux Home, Linux Worker and Mac Worker exchanged saved source, shared documents and a binary resource without a browser or model calls; observed ordinary-save times were approximately 2.7-3.7 seconds across two runs, not a latency guarantee. Physical rename/delete, Worker restart/offline saves and conflicting edits preserved the intended versions. Real browser Resources and document pages displayed the actual Mac path/content while Home ran on Linux. Lost-receipt recovery also has local multi-process coverage. A third physical device was unavailable; no three-physical-device or new four-CLI repair acceptance is claimed by these tests.

Release `dc43c14` was installed on the local Home/Worker and one remote Worker. Only the explicitly reviewed Workbench project was activated; other business projects were unchanged. Its two remote shared documents and one local repository document synchronized with matching receiving hashes, no conflicts and no automatic Git commit changes. Live browser verification covered Resources, the original Run document URL, local inline-path display and English/Chinese switching. Existing roles, native-session mappings and terminal leases were retained. Runtime backups and detailed verification evidence are kept in ignored local release artifacts, not the public repository. Historical isolated-Run metadata and read-only preview rebinding have dedicated regressions; `.migration` archives and `.DS_Store` are excluded.

Review regressions cover policy-2 conflict preservation before migration, explicit nested document-scope ownership and isolated relative-document links. Filename/parent collisions block preparation explicitly before writes. The existing modifier/candidate workflow has directory contract tests; arbitrary external shell edits remain unknown-author changes and escalate to the supervisor. Directory sync cannot be used as a pinned Git delivery receipt. Observers reconcile the eligible manifest; only missing changed content is transferred. Hashing is not a block-level delta or a second version-control system. Scope disable is blocked while unresolved conflicts remain; use global pause to stop work without discarding them.

Idle conflict polling selects only Runs with conflict links through a sparse index, instead of loading all historical Run bodies. Receipt polling starts from pending receipts and joins their transport records, without scanning completed transport history. No schema, history or acknowledgment semantics change.

Background observation uses process-local metadata/hash caches bound to canonical root identity, repository/generation, scope policy and effective Git ignore selection. Every 30 seconds a directory/metadata traversal checks the eligible scope. Hash reuse requires matching device, inode, size, mode, link count, mtime and ctime (available nanosecond fields), with fresh component safety checks and a no-follow leaf metadata check. A matching observation does not open content; actual reads retain no-follow descriptor/name checks and repeat the component walk. An independent 5-minute deadline reads and hashes all eligible content. Completion advances the corresponding deadline; incremental activity and verified apply receipts do not postpone full reconciliation. Timestamps are an optimization hint, not a proof of unchanged content.

Known file-change notifications reread the indicated files. Rename, unknown paths and structural events fall back to metadata traversal. New/empty directories and missed notifications remain covered by periodic checks. Restart, scope/binding/rule changes and watcher errors invalidate cache. Failed scans retain the last successful manifest and retry after 30 seconds. Obsolete in-flight successes and failures cannot publish over replacement configurations or verified applies. Apply receipts invalidate only affected file caches and retain the full deadline.

Watcher and explicit directory observations serialize file checks, yielding every 32 files when idle and every 8 files under task load; enumeration also yields. Load hints refresh at most once per second using active Run selection, not historical Run bodies per file. Observation remains finite because it can be a prerequisite of the active task. Existing reservations, takeover guards and apply fences remain unchanged. Transfer/blob captures always read and verify bytes and never use observer caches. Metadata traversal still costs CPU; isolated results are not a production performance guarantee.

## 14. Opt-in source and outputs policy

Status: implemented locally; isolated Home/Worker/browser verification only. Not deployed or automatically enabled. Earlier physical-device acceptance in section 13 does not validate this increment on a remote server.

Absent `contentMode`, or `source-only`, retains the existing exclusions and Git-ignore behavior. `source-and-outputs` includes eligible reports, logs, `coverage`, `outputs`, `.local`, other `.workbench` files and ignored artifacts. It requires directory scope, capture policy 4 and `sourceSyncOutputs: 1` on every participating Worker. Unsupported Workers cannot activate, receive a new expanded command, or keep watching the expanded scope after a downgrade.

Mandatory exclusions fall into five categories:

1. Version control: `.git`, `.worktrees`, nested repositories/submodules and their boundary protections.
2. Runtime state: `.data`, per-turn `.wb-bridge-*`, `.wb-source-sync-*` journals/recovery siblings, the project ownership marker, Home/Worker database files and their sidecars/backups. A directory containing `home.sqlite` or `worker.sqlite` is a private runtime root, even below `.local`; its staging and pending state are excluded together. Receiver path walks check again before writing.
3. Dependencies: `node_modules`, `vendor`, `.venv`, `venv`, Python bytecode caches.
4. Credentials and keys: environment files, credential/secret/token prefixes, named API/Worker/access/refresh tokens, native auth/Worker configuration files, SSH and package-registry credentials, private keys and certificate stores. Expanded mode excludes `.env.*` examples too; legacy example handling stays unchanged.
5. CLI login folders: `.codex` and `.claude`.

`build` and `dist` remain excluded in this increment. Other eligible cache/output folders are not excluded merely because Git ignores them. Filename rules cannot detect credentials embedded in a script or report: operators must review the newly included paths and the warning before enabling. Path traversal, symlink/hardlink, nonordinary-file, alias and overlapping-scope checks remain in force. This is not a secret-content scanner.

### Preview and migration

Use the existing disable/preview/enable sequence. Pending operations and unresolved conflicts block migration; no cleanup or forced cancellation is performed. Review the exact preview and configuration revision; changing the mode, devices or scopes invalidates the browser's preview. Existing projects and active tasks are not rewritten by installation.

Expanded preview reads stable bytes locally to calculate hashes, but keeps only bounded metadata: included paths, newly eligible paths and exclusions. It does not save content blobs on the Worker, request body uploads, or permit upload to Home. The first real post-activation capture supplies actual transfer content and rechecks freshness. A changing file cannot be substituted using an earlier preview hash.

### Limits and receipts

With `sourceSyncBatching:1` on all participating Workers, limits are 20 MiB per file, 100 MiB and 10,000 changed paths per transfer command, and 1 GiB per project's retained Home content store. Full inventories and the union of device paths have no file-count ceiling. Complete traversal yields cooperatively and retains directory watcher budgets, exclusions, safe-path checks and cancellation. The existing 64 MiB metadata HTTP request ceiling remains a separate memory/transport boundary. Project storage quota includes retained evidence, not just live files.

Home freezes `boundedTransfers: true` on new batches only when every participant advertises the capability. It also includes the negotiated flag in background watch scopes. Old commands and mixed-version batches retain the old capture and inventory limits; stored history is not rewritten. A newly upgraded peer set can retry an old watcher size refusal as a new batch once. Existing permanent errors under the upgraded contract keep their normal stop behavior.

Large manual requests compare the whole eligible scope and transfer differences in parts. Automatic requests retain event-driven observation and periodic full reconciliation; unchanged files create no apply command. Hash captures stream/save file bodies one at a time, while read/apply commands are split by path count and bytes. Persisted part numbers and predecessor IDs prevent later parts on the same endpoint from running before the earlier receipt. Metadata stage commands reference the specific read part that owns each path. Completion, baseline confirmation and private-cache retirement still wait for the required physical receipts; cancellation or conflict after some parts cannot become a successful whole transfer.

The first limit violation stops the incomplete scan or transfer and reports `Over sync limit`, the relative path when applicable, and actual/maximum bytes or count. It is never recorded as a successful partial manifest or an inferred deletion. Already acknowledged files, historical baselines, conflict evidence and backups remain intact. A quota-rejected transfer retains its original capture and settles a separate hash-bound blocked receipt; it does not repeatedly upload the same completed capture. A fresh observation or explicit new request can retry after the underlying problem is resolved. No automatic quota eviction or history pruning is introduced. The path-count limit is a transfer-command bound on the negotiated protocol, not an inventory bound.

### Handoffs and visibility

New public latest pointers use `.workbench/handoffs/<nodeId>/LATEST.md`; private-review pointers keep `.workbench/handoffs/private/<roleId>/<nodeId>/LATEST.md`. Use stable, path-safe identifiers rather than display names. Managed turns carry the node identity, and automatic end-of-turn handoffs use the same helper. Unmanaged local tools derive a stable local key without recording a hostname. Historical root/role latest files are not moved, deleted or rewritten; `wb boot` and `wb handoff last` fall back to them when no device-specific pointer exists. Per-Run automatic-write suppression checks both layouts.

Managed sync conflict reads and status cannot expose unreleased independent-review content through the blob cache. This retains the existing application-level visibility boundary, not strong isolation against native CLIs sharing an OS account. Git-based execution inputs and the separate Mac-local file-reading authorization remain unchanged.

### Increment acceptance

Local checks exercise policy compatibility, mandatory exclusions, ignored outputs, no-body preview, scope ownership, all four limits, runtime-folder protection, per-device and private handoffs, legacy reads, review visibility and durable quota rejection. A real isolated Home and two Worker processes on one Mac, with a real browser, verified preview/activation, bidirectional output and handoff transfer, unchanged Git HEAD/index, over-limit peer preservation and recovery, unchanged unrelated project settings, desktop/mobile layout and language switching. No model was invoked. Physical Mac/Linux deployment and production activation remain separate gates; no new latency or CPU guarantee is claimed.

## 15. Simple metadata mode (S1)

The opt-in directory configuration `detection: metadata` selects a distinct decision engine for exactly two upgraded Workers; the existing display-Mac constraint remains. The preview contains metadata only and activation freezes revision, generation, scope policy and directory identities. Old scopes do not migrate automatically. Each device compares existence, exact nanosecond mtime strings and byte size to its own last confirmed baseline. Inode/type/ctime checks guard transfer and replacement, not ordinary change detection. Equal size and time can miss different bytes (S16); this is explicit, not a content-equality guarantee.

An existing baseline supports single-sided copy/delete and double-delete acknowledgement. An incomplete/failed scan, offline device, newly excluded path or changed root cannot authorize deletion. Both changed files are read stably and hashed only for that path: equal hashes require no content upload; different hashes are staged, verified, then retained as conflict versions while originals remain unchanged. A delete/edit conflict retains the surviving version and the absence fact. Other paths continue. An unknown initial pair or a reconfigured path with deletion history remains pending; Explicit S2 initialization is described below.

Normal transfer reads source bytes once, calculates integrity while reading, and checks source identity/attributes again after upload. Target hydration is followed by a fresh identity/attribute check and no-clobber installation with an fsynced journaled temporary file. The short displaced preimage is crash recovery only. Confirmed receipts save the target's actual attributes separately from the source and release temporary content through existing commands. Completed command replay never rewrites later edits; ambiguous prepared state retains evidence. Temporary batch namespaces are separate from the shared hash store, so cleanup cannot delete old-mode or conflict references. Blocked/cancelled batches also retire their private staging through the existing cleanup commands. Each tick examines at most 32 eligible batches via a partial index and rotating cursor; a durable cleanup marker removes finished batches from that scan. Home waits for definite operation results and all Worker cleanup receipts before deleting its namespace and releasing quota. In-flight transfers, reconciling commands and preparing/prepared journals postpone cleanup. Restart resumes these same persisted commands; a pre-upgrade failed cleanup retains its original receipt and gets one deterministic retirement command. Durable Worker cleanup receipts and the Home cleanup marker also fence late commands from recreating staging; only applied journals may remove recovery siblings, and the shared hash store is never pruned by batch retirement.

Observation keeps filesystem events, the 0.5-second quiet / 2-second maximum merge window and five-minute metadata fallback (thirty seconds when degraded). This mode disables periodic full hashing and the old per-run full-content provenance snapshot. It does not add a timer, model loop or scheduler. Conflicts require explicit human initiation through existing repair/review entry points; no automatic model repair is dispatched. `wb sync status` describes metadata-and-receipt confirmation, not byte equality.

Development verification uses real SourceSync, SourceSyncHome and SourceSyncClient with temporary SQLite/files, loopback HTTP and synthetic device registration. S01–S10, S12–S13, S16 and S18 are checked at that boundary. Physical Home/Worker process acceptance on Mac, real Mac/Linux transfer (S20) and measured resource acceptance (S19) remain pending. S2 initialization/resolved-conflict cleanup is now implemented; S3 audit pagination/30-day retention is implemented as described below.

## 16. Explicit metadata initialization and conflict retirement (S2)

Pending baselines retain both devices’ last observed metadata and are paginated by scope/generation/path. Preview is not proof of current content equality. The user selects paths (or all pending at confirmation time), then explicitly confirms either one-time verification or overwrite from one device. No baseline is inferred from legacy mtime or an old hash record; this implementation deliberately does not reuse old-mode evidence. Mode changes still require disabling, a new scope preview and a new generation with no old commands in flight.

A persisted initialization job feeds existing capture/read/stage/apply/cleanup commands in bounded batches (100 paths, combined 100 MiB, existing per-file limits). Stable content reads on each side compare digests. Equal verification updates metadata only; unequal verification saves a conflict without changing originals. Overwrite preserves both current versions in shared conflict storage before any apply; preservation failure prevents all writes in that batch. A changed destination becomes a human-resolution conflict. Completed baselines and command journals prevent duplicate writes on replay; cancelled/blocked jobs require a second user confirmation, current configuration revision and stable request ID to resume; duplicate requests never create another attempt, and uncertain recovery must settle first. Progress and resume appear in the existing sync panel. No additional timer, scheduler or model operation is introduced.

After explicit resolution and all endpoint confirmations, only unreferenced metadata conflict bytes may be deleted. Shared legacy manifests/device state, immutable versions, candidate records, legacy conflict history, other unresolved conflicts, unfinished operations and reconciling commands protect their hashes. Deletion never touches business files or removes history records to reclaim storage. Per-batch staging retirement remains separate from shared conflict retirement, and `.old`/`.new` siblings still require an applied journal. Metadata history is audit-only, not a live reference; legacy history remains a reference. Retained copies persist a one-hour reference-check backoff across restart. New conflict generations carry unreleased prior hashes forward and clear the delay, so overwriting the current conflict does not orphan its copies. Candidate and active-job queries explicitly use their partial indexes and bounded cursor pages; cleanup resumes after restart.

Development tests cover S11/S15 and mode migration using real classes, temporary SQLite/directories and loopback HTTP. This does not establish real Mac/Linux process acceptance, S19 resource measurements, or S20 cross-device transport; S3 audit/30-day cleanup is described below.

## 17. Metadata audit records (S3)

Only actual metadata file operations (including explicit comparison) are recorded. Frozen operations and validated receipts supply direction, metadata, phases and outcome; unchanged scans and per-chunk traffic produce no rows. One failed attempt remains visible when a subsequent same-path attempt starts, linked by retryOf and operationId. Comparison hashes are recorded only when the comparison read actually completed; ordinary transfer/preservation digests remain undisplayed. Payload byte counts represent bytes seen by Home across upload and download, not network framing; duplicate-hash payloads belong to the first matching path in that command.

Logs expire after 30 continuous days measured by Home: finishedAt for terminal rows, latest substantive stage change for unfinished rows. Repeated waits/refreshes and byte accounting do not extend this time. The running operation keeps a compact independent replay state; if its row expires, a genuine later transition creates a new audit row for the original operation. The existing tick uses a persisted daily sweep and an expiry index, processing at most 100 rows at a time and resuming unfinished sweeps after downtime. The same daily sweep also examines up to 100 terminal replay identities older than 30 days using an indexed, persistent cursor, removing their heads only if the head still points at that identity. An unfinished batch or command retains its identity until a later sweep. Active identities and business files, baselines and unresolved conflicts are never removed. Explicit project deletion removes audit and initialization records. Receipt observation indexes command paths/results once and shares one transaction; unchanged signatures do not write. Queries exclude expired rows even before the next sweep.

The existing project sync panel offers filtered 50-row cursor pages and per-record metadata/retry/conflict details. Path matching is exact; device matches either endpoint; time filters query Home record creation timestamps. Partial indexes constrain project/filter/order selection; no initial whole-log load or content read. Initialization jobs also use indexed 50-row cursor pages instead of a fixed last-20 list. S14/S17 development tests use injected clocks, temporary SQLite/files and loopback HTTP; browser screenshots and real-process/Mac/Linux acceptance remain separate.
