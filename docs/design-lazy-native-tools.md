# Native history tool details on demand

Status: implemented, independently reviewed and isolated-verified; not deployed.

## Scope and decision

Opening a session reads at most 15 recent user prompts, conversation prose and lightweight tool summaries. Full commands, tool inputs and outputs are read only after an explicit tool-detail click, in bounded chunks. Summary counts, failures and current execution state remain visible. Original vendor history, files, active processes and existing branch changes are preserved.

Increasing the browser cache alone merely delays its next overflow. The selected approach reduces the first response, keeps a bounded recent cache instead of deleting it on overflow, and retains the same-session preview during revalidation. It does not add background history scans, automatic older-page loading or compress/change the vendor conversation.

## Protocol

- New Workers advertise `nativeToolDetails: 1`. `historyPage=1&toolPreview=1` opts into lightweight tool rows; older clients retain the existing full-row contract.
- Lightweight calls carry classification/title/file-count metadata and opaque `detailRef`; results carry status, a short failure summary and their own reference. They omit full input/output fields. Calls and results retain existing IDs, order and offsets for pairing and pagination.
- Detail GET uses the same registered device/runtime/session identity, with `toolDetail` and `detailOffset`. Worker validates a fixed-size versioned binary reference whose SHA-256 binds the registered file identity, record bounds, parsed index and exact bytes, then returns at most 16,384 characters plus a next offset. Every request remains bounded, including oversized records; no caller-supplied filesystem path is accepted.
- The page builds collapsed tool-list DOM only on expansion. Full details load on the selected step, are cached under device/runtime/session/reference/chunk, and use explicit Load more for long output. Old/full records and live execution feeds retain their existing rendering.
- Cache remains bounded to 30 sessions and roughly 2 MiB per page. Trimming must preserve a valid older-history cursor; unsupported oversized formats retain the previous bounded copy. A delta can advance a cached snapshot only when its request base exactly matches that cached snapshot; later deltas cannot bridge a rejected oversize update. Snapshot replacement occurs only when new data arrives, never by showing another session's cached content.

## Implementation plan

Execute backend inline and delegate the disjoint frontend files; independently review the complete change after integration. Base is the existing local review-delivery fix, which remains included and unmodified.

### Backend
- [x] Add ignored red regressions for summary-only payloads, 15 prompt paging, exact lazy detail chunks, forged/cross-session/stale references and append-only history.
- [x] Extend bounded native history parsing and add exact-record detail retrieval; keep legacy default parsing and stable history IDs.
- [x] Wire the registered Home route and Worker query/capability, keeping existing ownership and file boundaries.
- [x] Verify recent and older pages, delta results and errors; no fallback to unbounded history scans.

### Frontend and acceptance
- [x] Lazy tool DOM/detail rendering, scoped bounded caching and chunk controls; preserve failure visibility and live behavior.
- [x] Bounded recent history cache with correct older cursor and same-session updating preview.
- [x] Real isolated browser checks: no detail request before click, selected detail only, repeated click hits cache, chunk continuation, session switch and stale error behavior.
- [x] Measure the same registered slow history read-only against the earlier 543,586-byte response and 21.2–29.1-second cross-device measurements; separate server parse, payload and UI cache results.
- [x] Full suite, independent review, local commit and accurate delivery report. No production deployment or restart in this task.

## Verification outcome

The existing 277-test suite passed. Fourteen focused regressions cover summary payloads, paging, full detail chunks, reference integrity, append/rewrite behavior, Codex custom input, file counts, cache trimming and continuity. Seven real Edge checks used an isolated Home with a controlled Worker connection invoking the actual history reader: ownership rejection, 15-prompt summaries, no early detail request/DOM, selected detail only, collapse reuse, result continuation and reachable older history. Independent static review found no remaining actionable issues after fixes. No model inference or production service change was needed.

A read-only comparison of the same registered server history returned 440 records including 380 tool rows: the legacy response was 541,212 bytes and the summary response 177,968 bytes (about 67% smaller). Server reads were 94 ms and 99 ms respectively; a selected small detail took 1 ms. These measure payload reduction and bounded retrieval, not a deployed browser/network speedup. The existing cross-device delay still requires release-time measurement.
