# Incremental source synchronization and modifier-owned conflict resolution

Status: implemented and independently audited for controlled, opt-in use. Two-device physical synchronization and managed modifier repair have passed; acceptance limits are listed in section 12. Existing projects remain disabled until their scopes are selected explicitly.
Updated: 2026-10-10.

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

Initial bounded defaults: 20 MiB per file, 100 MiB changed content per batch, 10,000 paths per repository manifest. Exceeding a limit or an incomplete scan blocks the repository snapshot with an explicit reason; it never produces a successful partial manifest. Renames are represented as deletion plus addition; cross-path rename inference is not implemented.

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
10. Busy/unknown Runs, manual takeover, global pause, binding changes and project deletion block or fence writes and late commands. Cancel during a batch retains accurate per-file outcomes.
11. Stale resolution, repeated failures and second modifications during repair invalidate old proposals; two-attempt limit and escalation work without a tight loop.
12. Real browser: configure, preview scope, sync, open conflict/evidence, view owner/notification/result, switch language and reload; state persists and no secret/file body leaks into routine status output.

Completion reporting separates spec, implementation, local checks, real two/three-device verification, actual model repair, commit/push and deployment. Do not enable this feature on existing business repositories merely because unit tests pass.

## 12. Current acceptance boundary

Automated checks cover bounded capture, exclusions, three-way comparisons, a three-node protocol simulation, safe apply journals, receipt replay after Worker restart, scoped candidate submission, owner assignment and independent-review blocking. Additional regressions cover private source versus receiving endpoint identity, same-device multiple outputs, successive requests retaining every receiver, genuine concurrent edits and a failed last distribution receipt. Real browser testing covers scope preview/activation, disk transfer, conflict versions including multiple sources on one device, language switching, persistence and late-response project fencing.

Physical macOS/Linux Workers have transferred saved uncommitted edits in both directions, including new/deleted files, binary content and executable flags, without changing Git HEAD or the index. A remote Worker disconnect/restart and request replay were exercised. Real Codex modifiers on both devices produced conflicting isolated outputs; their verified write evidence selected one repair owner and created a peer explanation task. A scoped candidate preserved both requested changes, passed the fixture check and reached both registered receiving directories with matching receipts after an independently checked, explicit review gate. This fixture does not prove arbitrary business requirements or automatic independent acceptance.

Codex, Claude Code, Grok Build and Agy each read the actual synchronized marker from an isolated Linux workspace, invoked `wb sync status` through the real bridge and continued on the same native session ID. Continuation keeps the source session key on both Request and Task; it retains owned output rather than reapplying the initial snapshot. Managed conflict write attribution/repair was exercised with Codex; other adapters' attribution remains conditional on their verifiable native write events. A third physical device was unavailable, so three-device coverage is simulated, not a physical acceptance claim. Software installation does not activate existing business-project scopes.

Attribution is limited to successful native write events whose before/after bytes can be verified. Shell-only edits, external editors and ambiguous overlapping writers remain unknown and route to the supervisor. Recorded successful shell execution is necessary candidate evidence, not proof that the command actually tests every requirement or binds the tested content. Until a trusted candidate-bound verification contract exists, every repair proposal requires independent human inspection and acceptance before distribution. Automatic notification/repair-task creation remains available, but fully automatic conflict acceptance is not implemented. The UI exposes the exact proposed bytes as a separate file version.

Recovery tests cover process interruption, not arbitrary power-loss durability or an OS-wide file compare-and-swap guarantee. Scanning large committed trees currently invokes Git per file; performance at the configured limits is not benchmarked. Private recovery files and content staging are retained, and interrupted upload reservations can conservatively consume quota until inspected. No automatic garbage collection is claimed.
