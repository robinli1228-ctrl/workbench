# Shared reports and recorded artifact sources

Status: locally implemented and independently reviewed; no deployment or restart authorized.

## Goal and boundaries

Shared reports use the bound project root's `.workbench/docs` rather than a repository-relative working directory. Existing misplaced reports are copied, never moved or overwritten, to `.workbench/docs/repositories/<repository-key>/...`; original history links remain unchanged and resolve through a deterministic registered-root mapping. Only the previously identified public reports are repaired on the live devices; private review material is excluded.

Temporary-worktree artifacts are read only from the original device and a path evidenced by the original Run. They are never substituted with a same-named Mac file. A read is bounded, rejects sensitive/escaped/symlink paths, and pins file hash and Git identity between metadata and opening. Recorded repository versions are used where available; old Runs lacking version evidence are explicitly labelled as a source-workspace snapshot, not an execution-time version. Device unavailability, version mismatch and missing provenance fail visibly.

## Implementation plan

- [x] Add focused local RED tests for shared report aliases, recorded-path admission, Git identity and file-hash pinning, sensitive paths and changed source bytes.
- [x] Add a bounded source reader; reuse existing authenticated Run routes and Worker ownership records, with a capability gate for mixed versions.
- [x] Resolve legacy repository report paths into the shared project scope. Show source/version metadata in artifact cards and pass pinned identity on content reads.
- [x] Give future managed turns an absolute report directory while retaining isolated/private review boundaries; no permission widening.
- [x] Copy the two confirmed public reports into the enabled shared root without overwriting; observe existing synchronization and compare source/destination hashes.
- [x] Independent review, focused/full checks and real isolated browser validation. Preserve the preceding local folder-entry commit; do not deploy or restart.

## Verification boundaries

Fourteen focused regressions cover source proof, path restrictions, clean/dirty version handling, hash pinning, same-root scope separation, isolated reports and per-device errors. Real isolated Home/Worker/Edge checks cover source cards, immutable card identity, shared report aliases and rejection of caller-forged provenance. Two public reports were copied without overwriting and verified through the existing synchronization path, with matching hashes and successful actual local reads. The original temporary worktree files were also read on their source device with the new reader in a separate verification directory. Current deployments are unchanged, so legacy card routing becomes available only after a later approved release.
