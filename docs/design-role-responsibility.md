# Separate role responsibilities from execution instructions

Status: implemented and deployed on 2026-10-08. Runtime coverage and remaining limits are recorded in section 11.
Updated: 2026-10-08.

## 1. Goal and scope

Make a role's collaboration responsibility independent of its execution prompt. The supervisor and peers should select collaborators using explicit responsibilities and live availability, not a display name or the first line of a prompt. The executor receives its task, execution instructions and necessary context, but NOT its own responsibility field, including on resumed sessions. Responsibility is an outward-facing description for other roles, not an additional instruction to its owner.

This extends the existing role record, team context and configuration UI. It does not introduce job-category enums, hard occupational permissions, a new scheduler, model scoring or automatic repository synchronization. An explicit assignment can cross a default responsibility; the assigning role should explain the mismatch and the intended deliverable. Existing workspace, approval and repository constraints remain in force.

## 2. Record and update contract

| Field | Meaning | Constraints |
| --- | --- | --- |
| `responsibility` | Default work, deliverables, collaboration boundaries and when to contact this role | Independent trimmed text, at most 1000 characters; empty means unspecified |
| `instructions` | Execution method, checks, output requirements and task-specific working conventions | Existing trimmed text field, existing 12000-character limit |
| `revision` | Optimistic concurrency for the entire editable role configuration | Reuse existing revision; no second revision counter |

- Persist both fields on roles. Existing complete task/Run snapshots may retain both for audit, but runtime rendering must not inject the owner's responsibility. Do not turn audit metadata into execution instructions.
- An omitted `responsibility` in an older client request preserves the stored value. An explicit empty string clears it. Reject non-string values rather than coercing them.
- A new blank role starts with an empty responsibility. Missing responsibility does not disable an otherwise configured role; expose an explicit unspecified status instead of inventing expertise.
- New role templates provide both fields. Selecting a template fills both independently; modifying one must not regenerate the other.
- The existing `wb role prompt` operation updates only `instructions`, preserving responsibility and all other configuration. Do not add an automatic role-responsibility rewrite tool.
- Human edits limited to the two definition fields use a version-checked metadata update and do not require the role's CLI to be online or logged in. Creating/enabling a role or changing its execution binding retains the existing runtime checks; metadata editing must not silently change those fields.
- Supervisor configuration proposals for ordinary roles accept responsibility and preserve it when omitted. Existing proposal approval requirements remain unchanged.
- For default project supervisors, expose a built-in coordination responsibility. Preserve the existing supervisor-settings and platform supervisor-prompt ownership; do not introduce a second editable supervisor execution prompt.

## 3. Team discovery and coordination

`buildTeamContext` reads `role.responsibility`, not the first line of `role.instructions`. The complete bounded responsibility of OTHER roles is available through `wb discuss peers` and the team section of `wb setup catalog`; no silent 180-character cut-off. Preserve the caller's identity/status entry but omit its responsibility entirely. Display concise summaries in the UI only, retaining a full-text view.

Keep peer IDs, names, runtime/model, device, enabled/configured/archived status, current tasks and communication capability. Missing responsibility must be distinguishable from unknown role, offline device and unsupported communication.

The automatically injected peer roster contains peer responsibilities, never peers' execution prompts or the caller's own responsibility. In the configuration catalog, retain the executor's own instructions and the supervisor's existing management view; ordinary peer entries omit instructions. All caller-facing role/team collections, including supervisor management responses, omit the caller's own responsibility. The human configuration UI can edit and display both fields. This reduces unnecessary context, not a promise of secret isolation between trusted local agents.

Use a responsibility fingerprint for roster invalidation. Do not include execution-prompt text/hash or the general role revision in the roster version solely to detect responsibility changes. Membership, responsibility, runtime/model, device and relevant communication/configuration facts still invalidate it. Retain instruction metadata needed by legacy consumers separately, with documented meaning; it must not become the new routing source.

When a peer responsibility changes, the next eligible turn receives the new peer roster. A successful resumed session may inherit an unchanged roster using the existing native-session checks. Changing the caller's own responsibility must not invalidate its execution instructions or re-inject its roster just to deliver that field; it does change what other roles see. Do not add a current-task section containing the owner's responsibility.

## 4. Execution and session continuity

- The task snapshot determines this executor's instructions; its responsibility is not an execution input. Editing a role does not rewrite queued or running tasks or historical selection evidence.
- New assignments use the updated role. Independently created clarification turns retain their existing snapshot semantics; this change does not redefine continuation ownership.
- Home must exclude the owner's responsibility from launch prompts and rendered team context. Keep Worker instruction composition and native CLI adapters as the existing transport; check that no full-record serialization reintroduces that field.
- Worker continues injecting `instructions` through its existing instruction delivery mechanism. Prompt changes must change the instruction fingerprint; a warm/resumed session cannot claim inheritance from a different prompt.
- Do not fall back from a missing snapshot responsibility to a live role or the first instruction line. A responsibility edit alone must neither reset the owner's native session nor change its instruction fingerprint.
- Audit/configuration records can retain both fields; model-facing Run input must distinguish peer discovery from the owner's execution prompt. Do not claim a UI save proves a native CLI received the right input.
- This boundary applies to newly assembled context and discovery responses. It does not erase previously delivered text from an existing native session, scrub historical artifacts, or prevent a user-assigned task from stating concrete work requirements. Do not reset sessions silently or claim historical memory was removed.

## 5. Prompt changes

### Shared coordination convention

Before delegating or requesting assistance, read the current team directory. Select recipients by their responsibility, relevant context, device readiness and task state. Names identify recipients; they are neither evidence of expertise nor a reason to ignore an explicitly configured recipient responsibility. If the assignment is cross-functional, state why the recipient is suitable, the exact temporary scope and the required result. Do not rewrite permanent responsibilities to justify a single assignment. When executing your own assignment, follow its task and your execution prompt, not a self-lookup of your responsibility. Explicit user directions take precedence within existing authorization and workspace constraints.

### Supervisor convention

Determine whether the request is configuration, repository maintenance, development, review or testing before choosing an execution path. Use the current directory and state rather than remembered role names. Keep implementer and independent verifier distinct where verification is required. A plan or dispatch records its actual reason; do not invent quota- or capability-based selection evidence.

For repository synchronization, establish target devices, repositories, actual directories, branches and pinned versions. Do not silently narrow an all-device request to one device. Inspect available platform operations first; if there is no suitable maintenance path, explain the missing capability or request the necessary scope clarification. Do not represent an isolated development worktree as the original project directory, and distinguish fetching remote objects from updating the target checkout. This prompt change does not implement that missing maintenance path.

### Reviewer example

Responsibility: Independently examine designs and code, identify evidence-backed defects and propose corrections to the responsible implementer. Deliver findings with scope and verification limits. Development, repository synchronization and deployment are not the default assignment; explain any explicit cross-functional assignment.

Instructions: Check the current request, artifact revision and assigned scope before reviewing. Give a reproducible basis, location, impact and verification method for each finding. Distinguish static inspection from tests actually run. Ask the relevant peer when material information is missing. Do not modify reviewed code unless the current task explicitly authorizes it. Conclude with verified results and remaining uncertainty; never treat missing evidence as approval.

Provide equivalent English and Chinese defaults. User-entered responsibilities and instructions are never automatically translated or replaced by a language switch.

## 6. UI

Add a Role responsibility textarea above the existing Role prompt textarea. Explain the audience beside each field: other roles use the responsibility to choose collaborators; this role receives the prompt when executing, not its own responsibility. Keep the current machine/CLI/model/effort layout and save-close behavior.

The role card may expose a short responsibility preview or tooltip without replacing its execution-state text. The existing default supervisor card continues opening project supervisor settings; show its built-in coordination responsibility there and point to the existing supervisor prompt editor rather than duplicating prompt storage.

## 7. Existing data and compatibility

Do not infer duties from role names or automatically extract them from arbitrary custom prompts. No destructive database migration is needed: absent responsibility means unspecified. Old clients and stored proposals that omit the field preserve it on later edits.

For operator-selected existing roles, explicitly populate reviewed responsibilities and edit contradictory generic prompt wording through the normal version-checked API. Back up the previous role records privately, retain device/model/enabled settings and do not reset native sessions. Other projects and custom prompts remain unchanged. Do not put real account, device or project identifiers in public migration code.

The first controlled rollout covers the selected project's reviewer duties and the supervisor coordination guidance. Planning/testing duties are populated from reviewed existing configuration, not guessed from labels. Missing duties elsewhere remain visible as unspecified.

Changing packaged defaults must not overwrite a customized stored supervisor prompt. Apply an operator-approved targeted edit to stored text when needed, retaining unrelated content and the previous value for rollback.

## 8. Implementation touchpoints

| Area | Existing modules | Required change |
| --- | --- | --- |
| Persistence and configuration | `rooms.mjs`, `project-setup.mjs`, `default-roles.mjs` | Independent field, validation, omission compatibility and templates |
| Discovery | `team-context.mjs`, `role-discussions.mjs`, setup catalog | Responsibility source, complete peer data and independent directory invalidation |
| Execution | `store.mjs`, `run-context.mjs`, `home.mjs`, instruction delivery consumers | Verify all snapshot paths; exclude owner responsibility while retaining execution instructions and native resume |
| Prompt resources | Both backend locales and platform prompt defaults | Responsibility-first coordination, bounded cross-functional assignments, correct synchronization scope |
| UI | `index.html`, `room.js`, supervisor UI, frontend locale and service worker | Independent editors, contextual guidance and cache update |

Inspect actual consumers before editing; a listed module may only need a regression test if it already preserves arbitrary snapshot fields. Avoid unrelated refactoring.

## 9. Acceptance gates

1. Save/reopen distinct responsibility and prompt; editing either preserves the other. Legacy field omission preserves a configured responsibility. Explicit clear and invalid values behave as documented.
2. Every same-project role can query the complete member list and OTHER roles' responsibilities via both supported discovery tools. Offline/disabled members are represented accurately. Self identity is present but self responsibility is absent in all role/team collections. Ordinary peer entries do not receive execution prompts as their duties.
3. Put a unique marker in the owner's responsibility and a different one in its instructions. Actual emitted Run input includes the instruction marker but never the self-responsibility marker. Repeat for task, consultation/clarification and continuation paths, including native resume and warm reuse; report any adapter not verified.
4. Peer responsibility edits refresh the next eligible directory on resume. Own responsibility edits and prompt-only edits do not unnecessarily resend that owner's directory. Executor instruction changes are not hidden by native/warm-session inheritance.
5. Queue a task, edit both fields and run it: the queued task retains its old instruction snapshot; a new task uses new instructions. Neither receives its own responsibility. Other roles see the updated responsibility in current discovery. Do not mutate historical Runs.
6. Template selection, manual edits, English/Chinese switching, supervisor entry and automatic dialog close work in a real browser. Existing user text survives language changes unchanged.
7. Run an isolated two-role collaboration: the caller can identify a reviewer from responsibility despite a neutral display name and can ask a scoped question; the recipient receives its execution prompt and responds. Missing responsibilities must not be fabricated.
8. Run an isolated repository-update request with clearly distinguishable maintenance and review responsibilities. Inspect actual dispatch parameters, device/directory scope and selection reason. Verify no wrong-directory writes; if the needed maintenance operation is unavailable, a truthful limitation is acceptable. Do not claim arbitrary model choices are deterministic or guaranteed.

Unit/contract tests and real browser tests are necessary but do not prove autonomous role selection. Keep real-model smoke tests isolated and separate their evidence from UI/transport checks. Do not test by rerunning a real production repository update.

## 10. Rollout and completion reporting

Keep local verification artifacts in ignored directories. Deploy only when the affected Home/Workers can be updated safely; do not interrupt active business tasks for this configuration change. Verify the real configured project's two fields and the next eligible Run's recorded input without resetting or replaying historical work.

Report design approval, code, commit/push, deployment, configuration migration, browser checks and actual CLI collaboration separately. If a device runs an incompatible Worker or cannot receive the updated role fields, show that limitation and do not claim all-device completion.

## 11. Verification and rollout status

- Independent storage, revision checks, offline definition PATCH, legacy omission compatibility and caller-relative discovery are implemented. Local tests cover real task/consultation/continuation builders and discussion clarification/answer-consumption builders, including renamed historical proposal projections.
- Real Edge desktop/mobile checks covered template filling, independent save/reopen, stale edit rejection, explicit clear, language switching and preservation of unavailable execution selections. The deployed PWA displays both fields and the supervisor's built-in responsibility in its existing settings page.
- An isolated Codex CLI 0.157.1 / gpt-6-sol run selected an arithmetic reviewer by responsibility, received a consultation result and continued the same native session. Six runs verified owner-duty exclusion, peer-duty refresh and execution-prompt changes with process reuse/native resume. A separate read-only maintenance-feasibility scenario selected the maintenance role rather than the reviewer and reported missing repository configuration. This did not perform or validate repository synchronization.
- Grok 1.0.46 / grok-4.7 and Claude Code 2.1.283 connected to MiMo passed real input/discovery smoke checks. This is not verification of Anthropic models or of their consultation/resume paths. Antigravity 1.3.1 produced the expected input projection but failed before model/tool execution with an EOF during its eligibility-check request; its end-to-end gate remains unverified.
- Selected existing project roles were updated through revision-checked APIs with private rollback records. Execution bindings and custom planning/testing prompts were retained. The custom supervisor prompt was preserved; shared coordination and supervisor synchronization conventions are composed by Home independently.
- Home was updated while idle, its prior dispatch-pause state restored, and project/task/run identities preserved. No business tasks were replayed, native sessions reset, production repositories synchronized, or GitHub changes pushed by this rollout. Worker source did not require a change; full cross-device/native-model combinations remain outside the completed smoke coverage.
