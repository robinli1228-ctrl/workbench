# Shared document links and side preview

Status: implemented and independently reviewed; isolated browser verification and 506 tests passed. PR/merge and the authorized three-instance release are separate release gates.

## Scope
Frontend only. Group-chat Resources becomes Side Preview; its device heading/settings/list move above roles, with a heading separator and icon-only bottom tabs. Git summary and source-sync controls remain reachable in project settings; global pause remains in global settings.

One document controller serves group chat and native Sessions: identify explicit Markdown/text document paths, show the filename with the full address in its tooltip, blue for a resolvable reference and grey for missing identity/private paths or an observed read failure. Blue is not a proactive existence guarantee. Read on click, reuse existing authorized APIs, open a modal first, then offer the existing side-preview component. Never rewrite original messages or turn historical tool snapshots into current files. Plain filenames alone and code blocks are not guessed. Web links retain browser behavior.

## Implementation
- [x] Extend existing Markdown link handling for angle-wrapped paths, spaces, local file URIs and explicit relative document links. Verify parsing regressions with local browser assertions.
- [x] Add a shared frontend document controller with source-specific request adapters, bounded click-time cache, asynchronous response fencing, filename/tooltip presentation, retryable failure states and a shared modal/side action.
- [x] Wire group message/fullscreen rendering and native history/live/reply-preview rendering into that controller. Reuse current session identity; no new backend permission or device mapping logic.
- [x] Reuse side-preview rendering for both navigation modes; move group device management and replace Resources with Preview according to the approved full-screen image. Relocate existing settings entries without changing their actions.
- [x] Verify actual isolated Home/Worker/browser behavior: desktop/mobile, both chat modes, cross-device shared path, unresolvable/private/missing files, spaces/angle/file URI parsing, retry, close/switch races, nested document links, history snapshots, metadata/cache request counts and existing controls.
- [ ] Independent final review, full checks, screenshots, PR and merge. Deploy the tested main to Home and both Workers only after an idle gate, preserving history/config/source and restoring maintenance pause state.

## Files
Main UI: public/markdown.js, public/side-preview.js, public/room.js, public/native-sessions.js, public/workspace-inspector.js, public/app.js, public/index.html, public/styles.css, public/source-sync.js, public/locales/zh.js, public/sw.js. The existing side-preview module hosts the controller, so the backend static-file allowlist is unchanged. Documentation tracks the moved controls. Local validation scripts remain ignored.

## Verification
- Real isolated Home and Worker, real Edge desktop/mobile: cross-device recorded path to bound project file, modal, side preview, missing-file retry, nested shared document and both chat entry points. Native history and the side-question context were replayed fixtures; file content was read through the real Home/Worker APIs. No production model requests were sent.
- No initial document body requests; repeat click reuses the bounded cache. Side-question draft survives modal/preview switching. Project Git, file-sync configuration and device/global-pause entries remain reachable.
- Browser regressions cover explicit document-link source identities, ASCII punctuation, spaces, file URIs, private paths, response races and historical child links without their own version evidence. Such historical child links stay grey rather than silently loading a current file.
- Independent review findings were corrected and rechecked. `npm ci`, `npm run check`, `git diff --check` and all 506 tests passed. Backend source and protocols are unchanged.
