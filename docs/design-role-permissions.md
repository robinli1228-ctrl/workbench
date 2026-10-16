# Role permission scopes

Date: 2026-10-16

Status: written specification awaiting user review. No permission feature is implemented by this document. No existing configuration, task, session or service is changed.

Source baseline: `1feb722b34e544aa84311112051c1cf3bf2c610e`.

## 1. Approved intent

The user wants trusted local roles to complete work without repeatedly handing restricted operations back to the user. Every managed role, including project supervisors, needs a permission-scope selector whose value actually controls CLI execution. Three choices were agreed:

| Stored scope | UI label | Contract |
| --- | --- | --- |
| `project` | 项目文件夹完全访问 | Normal project work is allowed; access outside the authorized filesystem boundary is refused, not silently elevated. |
| `device` | 当前设备完全访问 | Native sandbox and permission prompts do not restrict ordinary commands; the operating-system account's real permissions remain the ceiling. |
| `device-approval` | 当前设备请求批准 | Project work runs normally; an operation requiring broader access waits for one explicit approval or rejection. |

Existing permissions and history must be preserved. An edit does not change, restart, inject into, or stop an active turn. This task excludes deployment and production service restarts.

## 2. Evidence and selected approach

At the baseline, `rooms.mjs` and Home startup normalize ordinary roles to `mode=workspace-write, autoApprove=true`. The Codex adapter maps these to a workspace sandbox with `approvalPolicy=never`; its command/file approval transport exists but is normally bypassed. The other three print adapters pass permission-bypass flags irrespective of that stored mode. Thus an old `mode` value is not a reliable cross-CLI permission label.

`warm-sessions.mjs` fingerprints process configuration but does not include permission scope. Home has an authenticated approval API, durable command delivery, expiry checks and inline approval UI. These mechanisms should be extended, not replaced with a second control plane.

The configured local Codex executable reported `0.162.1`. Its help exposes `danger-full-access` and `on-request`. Current official [permission-profile documentation](https://learn.chatgpt.com/docs/permissions) distinguishes restricted read/write profiles from ordinary workspace-write and describes minimal system/runtime read access. Documentation and CLI flags are implementation candidates, not successful integration or sandbox tests.

Approaches considered:

1. **Selected: explicit per-role contract, adapter capabilities and the existing approval channel.** Smallest platform change that can preserve current behavior and refuse unsupported combinations.
2. Add settings but describe every adapter as supported. Rejected because existing automatic print adapters do not provide verified blocking approval.
3. Wrap every CLI in a new external OS/container sandbox. Out of scope: adds deployment and platform-specific infrastructure beyond this request.

## 3. Exact boundaries

### Project scope

The allowed business paths are the task's actual execution workspace and explicitly assigned repositories, not the entire device workspace parent. Isolated review/test workspaces do not receive write access to the original business checkout merely because the role normally works there.

Native runtime dependencies, required Git metadata and a private task-temporary directory may need additional access. Enumerate those actual exceptions in the effective policy; do not silently add the home directory or global temporary directory. Host executables/system libraries may be read as needed for normal tools. Sensitive project metadata protections remain in force unless separately required and authorized. This is not a claim that CLI credentials or the trusted Worker are hidden from their own host process.

Ordinary workspace-write alone is insufficient to claim that external business files cannot be read. An adapter/OS pair may advertise `project` or `device-approval` only after its actual shell/tool path enforces the documented read/write boundary. Do not replace enforcement with prompt text, shell-command regex classification, or a permission label.

Network behavior is displayed separately from filesystem scope. Preserve the existing managed collaboration/network requirements; this change does not promise a network allowlist, account authorization or prevention of remote side effects. Platform tool authorization, formal delivery approval and independent-review requirements remain separate checks.

### Device scope

Use the selected execution node and its Worker account. Full access is not root, sudo, macOS privacy approval, a new account credential, or access to another machine. Use native full-access parameters on every new/resumed turn and ensure an old sandbox profile cannot override them. A refused effective configuration is an explicit launch error, not a silent fallback.

### Approval scope

Start with the same verified project boundary. An adapter must hold the requested operation before its side effect and accept a single-operation response. A normal sandbox denial may remain an error if the CLI does not request escalation; Workbench must not automatically rerun a denied shell command. Never synthesize approval from model prose or replay a command extracted from logs.

An approval can cover the whole displayed command, including subprocesses. “Once” means that native operation, not one filesystem syscall. The UI must not imply narrower authorization than the native callback provides.

## 4. Configuration and compatibility

- Add optional `permissionScope` to managed role execution settings. Validate the three values centrally in Home and Worker.
- A missing field means legacy behavior. Preserve old `mode`, `autoApprove`, snapshots and adapter launch semantics; do not backfill all roles to one of the new scopes.
- Existing-role forms show “Current permissions retained; select a scope to change” when the field is absent. This is a compatibility placeholder, not a fourth selectable permission level. Editing names/prompts without selecting a scope must not change permissions.
- Stop startup normalization and general role saves from overwriting explicitly configured permissions. Old clients omitting the new field preserve it.
- New managed roles default to `project` only when supported. Otherwise configuration remains incomplete until the user explicitly selects a supported scope; never default a new role to device-wide access.
- Include project supervisors and platform-managed role configuration entry points. Agent-originated permission changes continue through the existing human-confirmed setup proposal path; they cannot silently select full access.
- Role copies preserve an explicitly selected scope. Changing runtime/device validates capabilities again. Templates cannot retroactively change existing roles, and selecting a responsibility template cannot silently elevate permissions.
- Standalone native sessions keep their separate permission control. A role-bound interactive terminal must not bypass the role policy; if it cannot return approval through Workbench, refuse that entry point for `device-approval` and explain why. Do not change standalone or active takeover sessions as a side effect.

## 5. Frozen execution and warm processes

Freeze effective permission scope, adapter/OS capability version, execution roots, native permission parameters and role revision when a new execution is admitted. A run with a frozen policy keeps it through reconnect, retry and approval handling. Existing queued commands already bound to an execution retain their original policy; genuinely new admissions use the saved setting.

Worker validates the policy before sending model input. Unknown values, unsupported capability versions, invalid roots or changed bindings fail before execution. An older Worker cannot accept a run that requires the new permission contract.

Include the effective policy and roots in the warm-process fingerprint. Do not stop a busy process to change a role. Once the previous turn has completed, a mismatched idle process may be retired using the existing verified lifecycle before the next turn resumes the same native history. If the native runtime cannot safely resume with the new policy, block with an explanation instead of silently dropping history or retaining the prior privilege.

Formal read-only audit/maintenance boundaries remain enforced. A conflicting broad role scope does not grant a writing audit: reject the incompatible admission with a clear reason or use an explicitly verified stricter stage policy, showing both configured and effective scope. Do not present one while executing the other.

## 6. Capability and adapter contract

Worker exposes per-runtime, per-OS supported scopes and reasons for unavailable choices. Home and the browser both validate against it. Capabilities are based on verified adapter behavior for the installed runtime, not just the presence of a help flag.

- Codex: implement full access through App Server, restricted read/write profiles through its verified permission configuration, and on-request callbacks through the existing approval transport. Do not mistake `untrusted` for the agreed project-auto/escape-approval behavior.
- Claude, Grok and Agy: preserve legacy paths; make `device` explicit where real execution confirms full access. Project restriction and interactive approval stay unavailable until the actual print/stream protocol and all relevant tool paths are verified. A terminal prompt that Workbench cannot receive is not supported approval.
- No adapter may respond to an unknown approval method by accepting it. Unsupported methods must deny or fail visibly without a suspended invisible operation.

Completion reporting must list the scopes actually enabled for each tested adapter/OS. Unit argument assertions alone do not qualify a runtime as supported. At minimum the local Codex full-access and approval paths must have actual CLI evidence before this feature is called delivered; if unavailable, report the gap, not completion.

## 7. Approval UI and lifecycle

Reuse the existing approval records, Home decision endpoint, Worker event acknowledgements and command idempotency. Bind each request to its Run, node, native request identity and frozen policy. Store a stable action summary/digest so a stale response cannot authorize a different action.

The modal shows project/group, role, execution device, requested command or target paths, native reason, expiry and current decision state. Treat command/reason/output as escaped data. Show a CLI-supplied request when known; if it contains no reason, label it missing rather than inventing one. Do not put credentials into the summary.

Provide only “仅批准本次” and “拒绝”. Do not send accept-for-session, persistent rules, global allowlists or implicit full-access changes. A second operation must obtain its own approval.

Pending requests remain discoverable inline and in run details. Auto-open at most one modal for the visible conversation; do not replace an unrelated editing dialog or jump to another project. Closing the modal leaves the request pending; it is neither approval nor denial. Reopening and multiple browser tabs must not duplicate the operation.

Reuse the existing bounded expiry (currently five minutes), reject late decisions and deny a still-held native request on expiry. Stop, process exit and invalid native identity invalidate pending requests. Disconnected Workers cannot receive a new approval decision; reconnection never interprets a stored unacknowledged approval as proof of execution. Denial/expiry and duplicate decisions remain visible in history.

## 8. Verification and preservation

Keep temporary tests/evidence under ignored project-local paths. Use isolated Home/Worker instances and known test files only. Do not restart or alter production roles, services, sessions, files or approvals.

Required evidence:

1. Three role choices render correctly; unsupported choices explain their reason and cannot be saved by bypassing the UI. Supervisors use the same contract.
2. Legacy saves/restarts retain exact prior behavior. Existing reports and session histories are unchanged. Old-client omission preserves a saved scope.
3. Project mode reads/writes inside the fixture; external business-file reads/writes, symlink escapes and child-process attempts are refused.
4. Device mode actually reads/writes a separate, explicitly authorized fixture path that project mode cannot access.
5. Approval mode creates no external side effect before a decision. Browser approval executes the exact held operation; rejection and expiry leave the fixture untouched. A subsequent different operation requires a new decision.
6. Duplicate clicks, two tabs, stale approval IDs, reconnect, stopping and late native replies cannot grant permission to another run or repeat its side effect.
7. Changing scope while a real isolated turn runs leaves that turn's policy/process untouched. The next admitted turn uses the new policy; warm reuse cannot retain old privileges.
8. Existing native history survives permission changes and permitted resume. Unsupported interactive entry points cannot bypass the managed scope.
9. Linux/Mac results and each CLI are reported separately. Unverified combinations remain unavailable, with no blanket claim of cross-device support.
10. Existing tests, syntax checks, frontend real-browser verification and permission-specific actual CLI checks pass. Preserve failed attempts as evidence and do not call process success a permission acceptance result.

## 9. Review and implementation gate

This document records the already agreed three scopes plus the enforcement, compatibility and verification details. Review the written specification before preparing the implementation plan. The plan must name concrete adapter contracts and acceptance commands against this baseline; it must not quietly lower project scope to write-only isolation or claim unsupported CLI modes as implemented. No deployment or restart is included.
