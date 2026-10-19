# Source-sync metadata reconciliation implementation plan

> Execute inline with test-driven development, then independent whole-branch review. No production deployment or restart.

**Goal:** Keep synchronization and safety checks while avoiding repeated reads of unchanged content. Include the existing receipt-poll optimization `e733692`.

**Architecture:** Ephemeral, scope-bound metadata/hash caches are only for background observation. Reconcile metadata every 30 seconds and independently rehash every 5 minutes. Known file changes may be checked individually; ambiguous events use a metadata traversal. Explicit transfer captures still read and verify bytes.

**Tech stack:** Existing JavaScript ESM, Node 22, filesystem watchers and SQLite stores. No new dependencies.

**Spec:** User-approved 30-second metadata / 5-minute full reconciliation, and `design-source-sync.md` safety contract.

## Constraints and review focus

- Preserve histories, source workspaces, active tasks, reservations and receipt semantics.
- Metadata is not proof of unchanged content: full checks are independent of event traffic.
- Restart, binding/rule changes and watcher errors invalidate observation cache.
- Test same-size edits with restored mtime, inode/mode changes, unsafe paths and failed scans.
- Test events arriving during scans and configuration changes; no partial manifest publication.
- Observation captures yield under load without waiting forever for the task that needs their result.
- Tests and machine-specific evidence stay in ignored local files, not the repository.

## Tasks

1. Add failing local regression tests for cache reuse, full hashing, path safety and independent clocks. Run and record RED.
2. Implement observer-only cache in `source-sync-files.mjs`; maintain full-byte transfer behavior. Test GREEN.
3. Update `source-sync-watch.mjs` clocks, path hints and invalidation; add cooperative pacing for watcher and directory capture through `source-sync-worker.mjs` / `source-sync-transport.mjs`. Use indexed active-run selection in `worker.mjs`.
4. Run focused and existing tests, independent review, then isolated Mac/Linux filesystem and Worker verification. Compare unchanged-scope content reads, CPU and elapsed time without touching live services.
5. Update the source-sync design and implementation notes, make a local commit, and report results and limitations separately from production performance.

## Execution result

Tasks 1–4 completed. Local regressions were observed failing before implementation and passing afterward. Independent review closed effective Git-ignore invalidation and stale-scan failure findings; verified applies also preserve the independent full deadline. Final metadata-only fast-path review passed with no outstanding P1/P2 findings. Mac and Linux each passed 14 focused tests, including no content descriptors on metadata-only cache hits, real filesystem notifications, durable notices, finite busy capture, full fallback and receipt polling.

The unchanged 5,800-file/381,423,458-byte scope produced matching digests on both devices. Metadata reconciliation read zero file-content bytes; a known single-file event reread one 7,031-byte file. Full fallback still read every byte. These are isolated measurements, not a claim of reduced CPU in the unchanged production services. `npm run check` passed. The maintained suite remains 129/130 with the pre-existing macOS media-transfer `/var` versus `/private/var` failure; it was not changed or counted as passing.

Final unchanged-scope CPU time per check: Mac full baseline 2.759s versus metadata 1.319s; Linux 6.814s versus 3.108s. Known one-file events used 0.028s/0.091s respectively. Full checks remain more expensive; yielding can increase elapsed time. These measurements do not establish overall Worker CPU percentages or sustained memory bounds.
