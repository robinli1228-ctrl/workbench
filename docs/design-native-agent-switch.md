# Same-conversation Agent switching

Status: design for review; not implemented or deployed.

## Agreed outcome

The Sessions page keeps one conversation and its chronological chat and execution history while the human changes the executing Agent. The entry is the existing Agent icon and name in Overview: clicking it opens a dropdown. No extra main-page entry or configuration wizard. First version stays on the same device and the exact same working directory. Existing files, uncommitted changes, attachments and vendor histories remain untouched.

## Approach

Use a stable Workbench conversation identity with linked, immutable execution segments. Each segment retains its device, runtime, native session ID and original records. The currently selected segment receives future input. The existing timeline renders older segments without rewriting their identities.

Converting vendor transcript files would risk unsupported formats and lose provenance. Showing a separate sidebar conversation per Agent would not satisfy the requested experience. A single Workbench conversation over separate native segments is the chosen direction from the discussion.

The dropdown is a small UI change; linking history, transferring context and enforcing exclusive execution are required backend work, not a change to the displayed icon alone.

## Minimal interaction and safety

- The dropdown lists supported Agents installed on the current device; unavailable options explain why they cannot be selected. It does not change device or directory. Model and reasoning settings come from the target runtime's valid defaults, never from incompatible source values.
- Only an idle conversation with no waiting or undispatched messages can switch. An active turn, pending question, side question, terminal ownership or uncertain process state blocks the operation. The UI tells the user to finish/stop the work or resolve its queue using existing controls. Switching itself never interrupts tasks.
- Draft text and attachment references stay in this conversation and are not submitted by selecting an Agent. Attachment compatibility is checked before the next send; unsupported content is not silently dropped.
- Check target availability, login and folder access before changing the current binding. Release only a confirmed-idle page-owned resident process using the existing release API. A terminal or managed group-chat role is not silently taken over.
- Persist one idempotent switch operation. Repeated clicks and refreshes cannot create multiple successors. New input is blocked only for this conversation during preparation. Late source events keep their source identity.
- Commit the new binding only when the target native segment has been prepared successfully. On failure retain the old conversation and binding, explain the failure, and allow retry; an idle source process may need to be reopened normally. No file rollback or deletion.
- Show a short switch marker in the existing timeline. Older messages retain their original Agent labels. Switching back creates a new segment with the intervening context rather than blindly resuming stale vendor memory.
- Group-role-owned histories continue using existing role controls; the new dropdown explains that boundary rather than breaking a role's execution binding.

## Context transfer without invented facts

- Transfer actual recent user/Agent messages, their authors and order, relevant attachment/file references, and recent execution records: commands, tool calls, returned results, errors and verification outcomes.
- Known device/directory/version information is platform metadata, not generated narrative. Do not force goals, decisions or completed-work fields when the records do not contain them. A successful command is not automatically an accepted task.
- Prefer a bounded original-record excerpt plus a scoped, paginated way for the successor to read earlier conversation and execution records. Mark omitted/truncated material explicitly. Do not introduce a model call merely to manufacture a handoff summary.
- Preserve the original record identities and provenance. Quoted history/tool output is context data, not new authority or a replacement for the human's current request.
- Before continuing work, the successor reads the applicable project AGENTS.md and checks the actual directory/files needed for the task. Missing AGENTS.md is reported as absent, not generated. Existing permissions apply; do not scan unrelated folders or copy vendor credentials, private configuration or internal reasoning.
- Switching selects the next executor; it does not automatically resume unapproved business actions. The first subsequent user request receives the context package once, before its own text. If delivery fails before model input, the package remains pending for the next attempt.

## Engineering boundaries

Reuse the existing Home store, Worker channel, native-session creation, idle/release checks and history timeline. Add only a small conversation/segment association and switch operation; do not reuse the full group-role switch workflow or introduce another scheduler.

Persist progress across browser refresh and recover uncertain operations without duplicate execution. Target Workers must explicitly support this feature; old Workers are rejected without unsafe fallback. Existing sessions retain their original behaviour until the human explicitly switches.

## Acceptance

1. In an isolated project, switch Claude → Codex → Agy where the device supports them, and switch back. Sidebar remains one conversation; chat, commands, results and errors remain readable with original attribution.
2. A successor finds a unique prior-discussion fact, actually reads applicable AGENTS.md, inspects an existing uncommitted file, and follows the next user request without replaying already completed writes. No artificial handoff facts are added.
3. Busy turns/questions/queues/terminal ownership and another writer in the directory prevent switching. No current task is stopped.
4. Duplicate clicks, refresh, lost response, unavailable CLI, device disconnect and failed target preparation preserve the old binding or expose an explicit recoverable state; no duplicate successor or lost draft/attachment.
5. Long histories use bounded initial context and scoped paginated reads; do not expose unrelated conversations. Old pages and source vendor files are never rewritten.
6. Verify the dropdown and retained transcript in a real browser, plus each supported real CLI transition. Simulated/runtime-unit checks alone do not establish cross-Agent acceptance.

Delivery is local implementation and verification only. No push, merge, deployment or restart is included in the current request. Exact code interfaces and context budgets belong in the implementation plan after design approval.
