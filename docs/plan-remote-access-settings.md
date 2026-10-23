# Remote Access Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Manage the independent relay from Workbench Basic Settings with only server address, password and enable/disable visible by default.

**Architecture:** Package the existing standalone service as `modules/remote-access/`. A small Home bridge calls its existing local management API; a dedicated browser module renders one settings card. Streaming and SSH continue in the independent process, outside Home's scheduler.

**Tech Stack:** Node.js 22, JavaScript ESM, existing browser HTML/CSS and localization. No new dependencies or frontend build.

**Spec:** `docs/design-remote-access-settings.md` (approved).

## Global Constraints

- Preserve histories, passwords, dedicated keys, current relay configuration, task execution and all existing SSH forwards.
- Update/restart only local Home and the independent gateway under the user's explicit supplemental authorization for the atomic configuration fix. Neither Worker nor unrelated SSH forwarding is restarted.
- Existing gateway compatibility is mandatory: local-management proof must fail through it before the new module's explicit route denial is deployed; configuration editing requires the atomic-patch capability, with no unsafe fallback.
- Browser login remains fixed fifteen days. Local management proof is separate, short-lived and never returned in JSON.
- Normal UI shows relay address, password and enable/disable only. Advanced fields are collapsed; local paths and token/key contents are not browser settings.
- Private installation locator uses `REMOTE_ACCESS_CONFIG` in Home's local launcher; default is `<DATA_DIR>/remote-access/config.json`. Do not scan personal directories or guess a different installation.
- Package only sanitized source/templates, not the standalone repository's Git history, private settings, tests, logs or deployment artifacts. Public examples use repository-standard placeholders.
- New regression tests stay under ignored `.local/remote-access-tests/`. Preserve existing tracked tests; do not expand unrelated PRs or task scope.
- Open one new PR and merge it into main after verification and independent review, as additionally authorized by the user. Restart only local Home from that exact main version, with an idle/recovery check, backups and a reversible local release.

## Review Focus

1. Existing gateway forwards Home credentials and rewrites Origin: this must not confer local relay administration. Task 2 tests both old/new gateway behavior.
2. Cookie minting, duplicate cookies, forged Host/Origin and direct unauthenticated requests: none may bypass proof. Task 2 tests issuance and every control route.
3. Saving a normal form must not replace hidden defaults, reset a blank password or overwrite a concurrently updated advanced configuration. Tasks 2/3 test patch semantics.
4. Offline service, concurrent clicks and persistence errors must show actual outcomes without duplicate processes or exposing raw filesystem errors. Tasks 1/2/3 tests cover these.
5. Home release must package the new module and syntax-check it without bringing private values into Git or modifying Worker/relay startup. Task 4 checks the exact candidate and deployed files.

## Task 1: Package the existing gateway module

**Files:** add `modules/remote-access/src/`, `modules/remote-access/public/`, `modules/remote-access/ops/`, `modules/remote-access/README.md`; update `package.json` syntax checks. Local tests: `.local/remote-access-tests/module.test.mjs`.

**Interfaces:** preserve `createGateway({config,auth,readHomeToken})`, `createLifecycle({tunnel,persistEnabled})`, `startService(configFile)` and the existing local management API. Module CLI remains separately executable; importing code never starts a service.

- [ ] Port the existing 36 ignored regression cases against the packaged module; add a denial assertion for `/api/settings/remote-access` and encoded/subpath variants. Prove the new denial test fails against the unchanged gateway.
- [ ] Copy only the verified source and generic templates from the standalone candidate, preserving relative module layout; normalize public text/examples to repository conventions without changing behavior. Add management-route denial using the existing canonical-path guard.
- [ ] Run `node --test .local/remote-access-tests/module.test.mjs` and all ported gateway cases. Expected: all pass; no real SSH calls or production writes.
- [ ] Run `npm run check` and `git diff --check`; commit only the module and check-list changes.

## Task 2: Add a local-only Home management bridge

**Files:** create `src/remote-access-settings.mjs`; integrate narrowly in `src/home.mjs`. Tests: `.local/remote-access-tests/bridge.test.mjs`.

**Interfaces:** `createRemoteAccessSettings({configFile,homeOrigin,now})` returns `handle(req,res,pathname)`; returns false outside its route prefix. Home invokes it after existing API authentication. It reads the configured management port and credential from the private config/state, connects only to literal loopback and uses a bounded timeout. It never exposes a general proxy.

Routes under `/api/settings/remote-access`:
- `POST /bootstrap`: exact local Host/Origin plus loopback required; issue a random HttpOnly SameSite=Strict cookie scoped to this prefix, valid 15 minutes, with at most 64 live proofs. Response contains no proof value.
- `GET /status`: require proof; return availability, passwordConfigured, tunnel status, server address, public URL and non-secret advanced SSH user/port information. No secret/private path fields.
- `POST /config`: require proof; accept only server address and explicit advanced domain/SSH user/port patches. Load the current private config immediately before merge; preserve all omitted fields. Delegate save to the existing serialized management endpoint.
- `POST /password`: require proof and a nonempty new password; delegate existing password validation/revocation, never log or echo it.
- `POST /start`, `/stop`, `/test`: require proof and delegate only the corresponding fixed local route.

- [ ] Write red tests for direct local bootstrap/control, no Home API authentication, absent/expired/duplicate proof, wrong Origin/Host, nonloopback socket, cookie capture through the old gateway, and the new gateway denial. Assertions include `remoteControlStatus === 403` and `localControlStatus === 200`.
- [ ] Write red tests for a stopped service, malformed private config, gateway-port substitution, safe response fields, and hidden-field preservation. Assert that a server-only patch retains the original token/key/state paths and domain.
- [ ] Implement the bridge with a fixed route allow-list, response redaction and bounded request bodies; prune proof records on requests instead of adding a polling loop. Retain the existing Home authentication checks.
- [ ] Run `node --test .local/remote-access-tests/bridge.test.mjs`; expected: all cases pass against real local HTTP listeners and isolated private files.
- [ ] Run the full module regressions and syntax checks, then commit this bridge and its Home hook.

## Task 3: Add the compact Basic Settings card

**Files:** create `public/remote-access-settings.js`; update `public/index.html`, `public/app.js`, `public/styles.css`, `public/locales/zh.js`, `public/sw.js`, `package.json`. Tests: `.local/remote-access-tests/browser.mjs`.

**Interfaces:** `createRemoteAccessSettingsUI({root,api})` returns `refresh()`. Initialize once; refresh only when Basic Settings opens or after an explicit action. Do not poll or rerender over an unsaved draft.

- [ ] Write a failing real-browser scenario asserting one Remote Access card in Basic Settings, three normal controls, advanced details initially closed, no local path inputs, and a disabled/local-only explanation on a remote origin.
- [ ] Implement the card using existing settings card/button styles and localization. Save only changed fields; an empty password is not submitted. Show availability, connection status and public link without adding a sidebar entry.
- [ ] Exercise IP save while preserving hidden defaults, advanced save, blank password, password set, enable/disable/test, concurrent buttons, service-offline and error responses. Assert no duplicate dispatch and no secret browser storage.
- [ ] Run the real Edge scenario on wide and narrow viewports. Expected: controls work, drafts survive unrelated refresh, no console errors. Capture private screenshots, not public PR artifacts with personal data.
- [ ] Run `npm run check` and module/bridge regressions, then commit the UI changes and a unique service-worker cache version.

## Task 4: Review, PR and local Home update

**Files:** update `README.md`, `README.zh-CN.md`, `docs/ARCHITECTURE.md` and the applicable docs index; operational evidence remains ignored.

- [ ] Update current-feature documentation to distinguish local administration, public browser login and prerequisite relay provisioning. Explain the module's separate runtime and private configuration locator.
- [ ] Run `npm ci`, `npm run check`, `npm test`, new local regressions and focused browser verification against the exact candidate. Any failure is reported by name; do not claim a green suite from syntax checks alone.
- [ ] Obtain one independent whole-change review; fix confirmed Important/Critical findings with red-to-green regressions and rerun affected/all checks. Review secret/proxy boundaries and repository publication hygiene specifically.
- [ ] Scan the candidate diff and copied files for personal addresses, account names, absolute private paths and secret material. Push a new feature branch and create/attach one Workbench PR; do not include unrelated open PRs or the standalone Git history.
- [ ] Recheck actual Home process identity, active Runs/native turns, queues and existing Workers/tunnels. If a restart would interrupt work, wait; do not terminate active CLI sessions.
- [ ] Back up actual Home database/configuration/launcher, independent relay configuration/state/launcher, and existing changes. Package the exact approved source in an independent release directory and set the private `REMOTE_ACCESS_CONFIG` locator locally. Update only the independent relay service to the atomic-patch implementation under supplemental authorization; keep Worker processes and unrelated forwards unchanged.
- [ ] Merge the verified PR into main, verify remote ancestry and package the resulting main version. Update and restart only local Home under the user's authorization. Verify exact source version/file hashes, health, Worker reconnect, live Basic Settings, preservation of private values and local-only administration.

## Execution method and remaining approval

Approved: inline implementation in this chat with one independent reviewer at the end. The user additionally authorized merging the verified PR into main and updating/restarting the independent gateway to fix atomic field editing. Home waits for a safe task window; both Workers and unrelated SSH forwards remain unchanged.
