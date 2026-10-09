# Safe CLI switching in role configuration

Status: **implemented and selectively deployed on 2026-10-09.** Codex/Grok native handoff, successor cold-resume, cancellation during handoff, restart recovery and the supervisor browser entry were exercised. Claude and Antigravity switching is explicitly rejected until their maintenance permissions and native handoff have been verified. The offline third Worker was not upgraded. Implementation and acceptance are tracked in [plan-role-cli-switch.md](plan-role-cli-switch.md).

## Scope

Keep the project, role ID, responsibility, execution prompt and history while changing CLI on the same device. The role form is the entry point; no manual session reset is required. A new vendor session receives a handoff and never resumes another vendor's native session ID.

This is separate from [cross-device handoff](design-session-handoff.md). No file synchronization, account migration or hot process migration is included. Changing both device and CLI must explain the unsupported scope instead of bypassing this workflow. Definition-only edits keep their existing save path.

## Operator flow

1. Selecting another CLI changes only the draft. Save becomes **Handoff and switch**.
2. Start a persisted switch operation and display its progress. Retain the original saved configuration. Let current work and accepted collaboration settle; hold new work for this role. Do not cancel business requests to satisfy a precondition.
3. The original CLI records the goal, progress, decisions, outstanding work, exact versions, important files, uncommitted changes, verification and unresolved effects. Save the handoff in platform history with its source Run, revision and hash, not only a local LATEST file.
4. Check the target CLI, login, model and workspace. Create a staging native session to read the handoff and verify actual files. This verification is not permission to implement business changes.
5. After successful verification and confirmed process settlement, commit the new binding, promote the staged session and archive the source session in one Home transaction. Release the role queue afterwards.

For a role with no managed history, record that no original handoff is needed, verify the target and create its first session. An unavailable original CLI with existing history must not be silently treated as first use.

## Cancellation and commit

Before commit, cancelling, closing the dialog or losing its lease requests cancellation without changing the saved binding. Cancel only preparation/verification work. Confirm those processes have stopped before letting the original role execute again. Unknown process state remains in reconciliation; timeout is not proof of rollback.

Keep handoff notes and interrupted verification records as history. Never undo business work completed while draining, restore repository files, delete vendor databases or erase messages.

If commit and cancellation race, the server's transaction decides. A committed switch is displayed as switched, even if its HTTP reply was lost. Query the same operation ID instead of submitting again or claiming rollback. Switching back after commit requires another explicit operation.

## State and ownership

Use the existing Home database and Worker channel. One unfinished `roleSwitches` record per role stores the stable operation ID/fingerprint, original and candidate configuration, expected role revision and source generation, stage, preparation and verification Run IDs, staged native metadata, handoff hash/watermark, lease, error and commit outcome.

Stages: `draining → handoff → verifying → prepared → committed`. Failure before commit becomes `blocked`; cancellation goes through `cancelling → cancelled` after confirmed settlement.

Staged sessions cannot appear as the current role session, receive ordinary work, become ordinary continuation sources or release current-session locks. Do not temporarily overwrite the role record to run the candidate. Launch the verification under an explicit staging identity and frozen candidate configuration.

Immediately before commit, recheck role revision, workspace binding, source generation, pending calls, unacknowledged commands, process settlement and target readiness. Concurrent edits invalidate preparation. Full-save and setup-proposal interfaces must reject bypasses of this guard.

The fixed supervisor follows the same process. Its project supervisor binding and supervisor configuration must commit together with its role/session records. Model-only changes retain existing behavior unless the runtime explicitly requires a new session.

## Queues and restart

Allow existing continuations and necessary replies to settle; do not block their dependencies and deadlock draining. New messages persist with a visible waiting reason. At commit only undispatched work may receive a new execution binding, recorded separately from its historical request snapshot. Never rewrite launched Runs or commands.

Late events retain their original Run/session identity and cannot update target-session results or locks. Home restart recovers the same operation without generating duplicate handoff/model calls. Browser refresh reconnects to it or displays confirmed cancellation after a lease expires.

## Acceptance gates

| Scenario | Required evidence |
| --- | --- |
| Real CLI A to CLI B | Same role/history, new native ID, unique handoff fact read and verified before new business work |
| Running task or pending peer reply | No lost reply, no concurrent driver; new messages wait |
| Cancel, Close, Escape or refresh at each stage | Original binding unchanged; preparation stopped; files/history kept |
| Login/model/source/target failure | Specific error, no configuration change or fake success |
| Duplicate Save, concurrent edits, commit/cancel race | At most one commit, stale revision rejected, persisted result shown |
| Worker disconnect or unknown stop | Reconciliation, not premature release |
| Restart or missing HTTP reply | Same operation recovered without duplicate calls |
| Definition-only edits and first-use role | Existing text editing preserved; no fabricated history |
| Supervisor and work role | All configuration records agree and bypasses are rejected |

Use isolated state-machine, HTTP and browser tests followed by real CLI handoff. Simulated success or a login probe alone does not pass these gates. Home requires `roleSwitch=1` on the target Worker. A native permission failure or a mismatched handoff blocks promotion and keeps the original configuration; unsupported adapters must not fall back to ordinary auto-approved execution.
