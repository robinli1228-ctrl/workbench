# Fixed review delivery

Status: locally implemented, independently reviewed and isolated-verified; not deployed.

## Scope and decision

A fixed-commit review handoff must not advance the project's collaboration baseline. Publication verifies a dedicated delivery ref; reception fetches that exact ref and builds a detached directory inside the project. Existing branches, baseline worktrees, uncommitted files, source ownership checks and historical delivery records stay intact. Ordinary development deliveries retain their current baseline advancement.

Replaying an old delivery cannot repair its obsolete source owner. Switching a user's branch to satisfy a stale baseline binding would change unrelated working state. The selected approach is an explicit review delivery, not either workaround. No old record is silently reclassified or marked successful.

## Contract

`wb deliver --review <request-id> <commit|auto> <summary>` uses a separate authenticated review-delivery endpoint. Home persists `purpose: review` with the immutable request fingerprint. The separate endpoint fails closed against older Homes; both publication and reception require a Worker advertising `reviewDeliveries: 1`.

Review deliveries always publish and verify their own dedicated ref, including items previously labelled unchanged. They skip only baseline publication/advancement. Repository identity, pinned SHA, clean source, current workspace ownership, source completion, pause/terminal/sync occupancy and non-force push protections remain. Receivers fetch and verify the ref without changing the bound checkout. The existing execution-input receive path uses the same baseline-preserving rule; its caller prepares the isolated execution directory. Direct review handoffs use a separate role-session key in the same visible group conversation, preserving the original native session. Continuations keep that review task's key and directory rather than trying to resume an unrelated native session in a new folder.

## Implementation plan

> Execute inline with superpowers:executing-plans; use one independent whole-change reviewer at the end.

**Goal:** make review handoffs succeed without altering project baselines.

**Architecture:** carry an explicit purpose from CLI through Home's immutable delivery record to the existing Git publication/reception functions. Capability gates prevent an older Worker silently using the ordinary baseline-mutating behavior.

**Tech stack:** existing JavaScript ESM, Node 22, SQLite store, WebSocket and Git.

### Constraints and review focus

- No production deployment/restart, database edits or replay of old failed records.
- Local verification scripts stay ignored under `.local/`.
- Preserve ordinary/legacy deliveries and their request fingerprints.
- Reject purpose changes on an existing request, malformed purpose, mismatched repository/ref/SHA and dirty publication sources.
- Fail closed with older Home/Workers, including both direct reception and scheduled execution input fetch.
- Preserve destination dirty files and branch/ref identities; verify source success and active ownership checks remain.

### Task 1 — explicit delivery contract and Git behavior

Files: `src/git-delivery.mjs`, `src/project-delivery.mjs`, `src/wb-tools.mjs`, `src/wb-cli.mjs`, `src/agent-bridge.mjs`, `src/home.mjs`, `src/worker.mjs`, `src/role-sessions.mjs`, `src/role-calls.mjs`, `src/rooms.mjs`, English/Chinese locales.

- [x] Write ignored regressions: real local bare Git remote, source on a different clean branch, dirty destination baseline; review publish/receive must succeed and preserve both baselines, ordinary delivery must retain its existing result.
- [x] Observe failures before changing product code.
- [x] Add explicit review endpoint/CLI purpose, stable fingerprint and Worker capability admission. Thread the purpose through existing delivery code, skipping only baseline mutation for review.
- [x] Verify real ref SHA and detached checkout content; negative purpose/remote/commit/dirty/ref tests, idempotency and mixed-version admission.

### Task 2 — acceptance and delivery

- [x] Run syntax checks, full suite and the targeted regressions; retain any failed run evidence.
- [x] Exercise real isolated Home/Worker publication and Git flow on Mac, including an older publisher refusal; validate fixed reception with real Git on Mac and Linux without production state changes.
- [x] Independent review; fix evidenced findings and re-run affected verification.
- [x] Update README/architecture and this status, then commit locally. Report written/verified/committed separately from deployed; live blocked cards remain unchanged until an authorized later release and fresh request.

## Observed verification

The full suite passed 277/277 with Node 22 and an isolated test environment. Nine focused real-Git/store regressions passed on macOS and Linux, including ordinary development baseline advancement, dirty destination preservation, exact refs, replay, capability rejection and existing receiver native history. The local wait/result/continuation integration additionally retained the review native session and directory without modifying the original session.

A real isolated Home and Worker accepted the actual CLI review request, rejected an older publisher capability, pushed and verified the dedicated ref, and reported `ready` while the source remained on its original non-baseline branch. Real Edge loaded that isolated project and observed the authenticated delivery state without JavaScript errors. The source turn was a controlled completed fixture, not a live model execution; no production task/card was retried or modified. Git verification used a local transport shim with real commits, refs and worktrees, not a production hosting push. Independent review found the existing-native-session boundary; its regression failed before the scoped session fix and passed afterwards, and the reviewer accepted the correction.

This is not deployment or recovery of an existing blocked production card. After an authorized Home/Worker update, the original task must register one fresh explicit review delivery and verify its real target receipt. Existing source-sync conflict verification remains separate.
