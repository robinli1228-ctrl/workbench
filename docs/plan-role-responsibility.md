# Role Responsibility Separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for inline execution, or superpowers:subagent-driven-development if the user selects delegation. Steps use checkbox syntax for tracking.

**Goal:** Separate outward-facing collaboration responsibilities from executor prompts without injecting a role's own responsibility into its execution context.

**Architecture:** Extend existing role records and caller-aware team discovery; retain existing task snapshots, Home/Worker transport and native resume. Use the existing role editor, with a narrow metadata-update path for offline roles. No new scheduler or hard role permissions.

**Tech Stack:** JavaScript ESM, Node.js 22, existing SQLite records, vanilla browser UI, existing CLI adapters.

**Spec:** [design-role-responsibility.md](design-role-responsibility.md).

**Execution status (2026-10-08):** implemented inline, reviewed and deployed. The design's section 11 records actual runtime coverage and unavailable gates; checklist items describe the work, not a claim that every adapter or device passed real-model validation.

## Global constraints

- `responsibility`: independent trimmed text, at most 1000 characters; empty means unspecified. Never derive it from `instructions` or a role name.
- `instructions`: existing trimmed text, at most 12000 characters. Both fields share the existing `revision` conflict check.
- Only peers receive a role's responsibility; its owner does not receive it through newly generated runtime context or discovery responses.
- Do not overwrite queued/running task snapshots, reset native sessions, or claim old native-session memory was erased.
- No new dependency, framework, categorical permission system or repository-sync implementation.
- Test scripts/data and private migration backups stay under ignored `.local/role-responsibility/`; no credentials or real project/device identifiers in public files.

## Review focus

1. Offline or unlogged-in CLI: definition-only edits must work without changing the execution binding (Task 1 and Task 3).
2. Older API clients and queued configuration proposals: omitted responsibility must preserve the current value, while explicit empty clears it (Task 1).
3. Duplicate role projections: self responsibility must be absent from both `catalog.roles` and `catalog.team.members`, and `discuss peers.items`, not just the rendered roster (Task 2).
4. Native/warm resume: own responsibility and general revision changes must not become instruction changes; a peer responsibility change must still reach the next eligible turn (Task 2).
5. Template defaults and language switches: custom text and existing queued snapshots must survive unchanged; UI must not replace an unavailable model while editing text (Task 3).

## Task 1: Independent definition storage and safe updates

**Files:** Create `src/role-definition.mjs`; modify `src/rooms.mjs`, `src/project-setup.mjs`, `src/default-roles.mjs`, `src/home.mjs`, `src/locales/en.mjs`, `src/locales/zh.mjs`, `package.json`.

**Interfaces:**
- `normalizeResponsibility(value, previous = '') -> string`: undefined preserves previous; strings trim; all other types and length >1000 reject with a localized error.
- `roleForAgent(role, caller) -> object`: strips self responsibility; ordinary callers receive peer definitions without instructions; supervisors retain peer instructions for existing management workflows. Human `/api/state` remains a configuration view.
- `Rooms.updateRoleDefinition(projectId, roleId, input) -> role`: existing non-archived ordinary role only; requires current integer revision; updates only supplied `responsibility`/`instructions`, retains every other field and increments revision.
- `PATCH /api/projects/:projectId/roles/:roleId/definition`: authenticated human API for the preceding method. Does not probe the Worker, create tasks or resume a role.

- [ ] Write local `definition.test.mjs` with real in-memory Store/Rooms. Assert two-field independence, 1000/1001 length boundary, null/array rejection, omission preservation, explicit clear, revision conflict, cross-project/archived/system-role rejection and no device/model/enabled changes.

  Pin the normalization contract directly:
  ```js
  assert.equal(normalizeResponsibility(undefined, 'previous duty'), 'previous duty');
  assert.equal(normalizeResponsibility('  ', 'previous duty'), '');
  assert.equal(normalizeResponsibility('x'.repeat(1000)).length, 1000);
  assert.throws(() => normalizeResponsibility('x'.repeat(1001)));
  assert.throws(() => normalizeResponsibility(null));
  ```
- [ ] Add tests for old proposal payloads preserving responsibility and `wb role prompt` changing only instructions. Run `node --test .local/role-responsibility/definition.test.mjs`; confirm failures before implementation.
- [ ] Implement the helper and metadata method; extend existing full-role save and role proposal paths with the same normalization. Add bilingual responsibility defaults for new templates. Do not migrate arbitrary existing roles automatically.
- [ ] Register the metadata endpoint and new file in `npm run check`. Exercise the endpoint against an isolated Home with an offline role and verify stored values and absence of Worker calls.
- [ ] Run the focused test, `npm run check`, `npm test` and `git diff --check`; commit only production code/resources.

## Task 2: Caller-aware discovery and execution exclusion

**Files:** Modify `src/team-context.mjs`, `src/role-discussions.mjs`, `src/project-setup.mjs`, backend locale resources. Inspect `src/home.mjs`, `src/store.mjs`, `src/run-context.mjs`, `src/run-input.mjs`, `src/role-calls.mjs`, `src/worker.mjs` and modify only consumers that fail the tests.

**Interfaces:**
- Preserve `buildTeamContext(db, run, options)` and `renderTeamContext(team)` signatures.
- Peer entries expose full `responsibility`, `responsibilityMissing` and `responsibilityVersion`; self entries retain identity/state but omit responsibility text and its fingerprint.
- Existing `responsibilityTruncated` remains false for this bounded full field. Keep any still-consumed instruction metadata distinct; never substitute it for a responsibility.
- Team version v4 uses explicit stable identity/binding/capability and peer-responsibility fields, excluding online/busy state, general revision and instruction content/hash. Rendering must also omit self responsibility defensively when given an older persisted team object.

- [ ] Write `context.test.mjs` using sentinels `SELF_DUTY_ONLY`, `SELF_PROMPT_ONLY`, `PEER_DUTY_ONLY`, `PEER_PROMPT_ONLY`. Assert self-duty absence and self-prompt presence in final execution inputs; peer-duty presence and ordinary peer-prompt absence in discovery. Test all three projections listed in Review focus.

  For each serialized ordinary-caller discovery response `text`, assert:
  ```js
  assert.ok(text.includes('PEER_DUTY_ONLY'));
  assert.ok(!text.includes('SELF_DUTY_ONLY'));
  assert.ok(!text.includes('PEER_PROMPT_ONLY'));
  ```
  Apply the self-duty absence assertion separately to the combined final instructions/prompt sent to each runtime, not to internal audit snapshots.
- [ ] Assert roster version behavior: own duty change does not change its version; peer duty change does; prompt-only edit does not. Assert a responsibility-only edit does not change `instructionDelivery` fingerprint or force warm-session replacement.
- [ ] Assert queued task instruction snapshots remain unchanged after editing the live role, while a new task uses the new prompt. Cover task, consultation/clarification and continuation payload builders without executing a business task. Run tests and confirm RED.
- [ ] Replace prompt-first-line extraction with the dedicated field. Apply `roleForAgent` in catalog projections; update `peers()` so it does not reinsert a fallback responsibility for self. Render explicit missing-peer-duty metadata without guessing it.
- [ ] Retain instruction composition from the role snapshot. Do not concatenate owner responsibility anywhere. Keep complete role snapshots for audit only; correct any runtime full-record serialization identified by the sentinel tests.
- [ ] Run focused tests and the full existing suite; review the emitted input text, not just fingerprints. Commit the change.

## Task 3: Separate editor fields and optimized prompts

**Files:** Modify `public/index.html`, `public/room.js`, `public/supervisor-settings.js`, `public/locales/zh.js`, `public/sw.js`, `src/locales/en.mjs`, `src/locales/zh.mjs`, `README.md`, `README.zh-CN.md`, `docs/ARCHITECTURE.md`.

**Interfaces:**
- Add `<textarea name="responsibility" maxlength="1000">` above `instructions`. Text explicitly says responsibility is for other roles to choose collaborators, not this role's execution input.
- On edit with unchanged execution/name settings, send the definition PATCH with both text fields and revision. Otherwise retain existing full-save runtime checks. Preserve original unavailable/offline selections and allow metadata-only save without declaring the CLI available.
- Keep the existing supervisor prompt owner/editor; show its built-in responsibility in human supervisor settings without adding a duplicate prompt store.
- Apply the spec's coordination/supervisor conventions to both packaged locales. Preserve custom stored prompts until the explicit migration step.

- [ ] Write real-browser `browser.mjs` tests for template two-field fill, save/close/reopen, independent edits, whitespace/length errors, offline metadata editing, stale revision, English/Chinese switching and preservation of custom text/model/device.

  After a saved editor is reopened, assert the independently entered values:
  ```js
  await expect(page.locator('#role-form [name=responsibility]')).toHaveValue('ROUTING_ONLY');
  await expect(page.locator('#role-form [name=instructions]')).toHaveValue('EXECUTION_ONLY');
  ```
- [ ] Run against isolated Home/Edge and confirm missing-field/behavior failures. Implement fields, descriptions, metadata-save detection and bilingual copy; retain existing layout and role-card status indicators.
- [ ] Optimize execution-prompt defaults as methods/checks/output guidance, not duplicated routing descriptions. Add shared conventions telling the caller to choose peers by responsibility, and the executor to follow its task and prompt without consulting self duties.
- [ ] Replace outdated default rules that say all role responsibilities are unrestricted; allow explicit cross-functional assignments with a stated reason, not silent permanent duty changes. Repository-sync guidance must distinguish requested device/directory scope, fetch and checkout update, and unavailable maintenance paths.
- [ ] Bump service-worker cache. Run desktop/mobile tests, take screenshots and inspect them; run `npm run check`, `npm test`, `git diff --check`. Update architecture only for implemented behavior and commit.

## Task 4: Real CLI acceptance and controlled existing-role rollout

**Files:** Local-only `acceptance.mjs`, `migrate.mjs`, backups and result evidence under `.local/role-responsibility/`. Update the implementation status in the spec and documentation index only as gates actually pass.

**Interfaces:** Use existing Home human APIs, role/task/session tools and existing CLI login configuration. No database overwrite or raw production record mutation.

- [ ] Create an isolated two-role project with neutral names and distinct outward responsibilities. Give each a unique private execution-prompt marker. Use installed authorized CLI paths, no production repository tasks.
- [ ] Run a real consultation: caller discovers recipient by responsibility, makes a scoped request and receives a reply. Inspect actual tool payloads and Run input: caller sees peer duty, recipient receives its own prompt but no owner-duty sentinel. Record runtime/device/version and distinguish model behavior from deterministic contract tests.
- [ ] Resume an existing test session after separate own-duty, peer-duty and own-prompt edits. Verify self-duty absence, peer-directory update, prompt delivery and native-session continuity; test queued old-snapshot/new-task behavior. Repeat relevant transport checks for available adapters; list unavailable adapters instead of claiming universal coverage.
- [ ] Run an isolated repository-update scenario with a maintenance role and reviewer; inspect actual role choice and requested device/directory scope. Accept truthful lack-of-capability reporting when no proper sync path exists, not wrong-directory success. Record that this is a smoke test, not a deterministic guarantee of future model decisions.
- [ ] Read the selected real project's role definitions and custom supervisor prompt; save private before/revision records. Prepare a narrow diff populating reviewer responsibilities and removing only the conflicting generic wording. Preserve planning/testing custom methods, runtime bindings and unrelated projects. Use revision-checked APIs and reread values after each update; stop on concurrent edits.
- [ ] Deploy only with no affected active Runs. Preserve data and original pause state. Verify actual PWA fields and supervisor entry, then a non-business execution-input check where safe. Do not reset sessions to pretend history was erased. No automatic production sync retry.
- [ ] Complete one independent branch review, fix concrete issues and rerun affected tests. Report code, local commit, GitHub push, deployment, migrated configuration and actual CLI coverage separately; do not claim unperformed gates passed.

## Execution choice

Selected by the user: inline execution by the current agent, with one independent whole-branch review. Review findings were reproduced, fixed and covered by regression checks. Implementation commits remain on the feature branch; integration/push is a separate decision.
