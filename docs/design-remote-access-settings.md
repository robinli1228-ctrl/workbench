# Remote access in Basic Settings

Status: design and implementation plan approved on 2026-10-23; implementation in progress. The independent gateway already exists; this document does not claim that Home integration, a pull request or a Home update is complete.

## User-facing outcome

Add one Remote Access card under Settings → Basic Settings. Its normal view contains the relay server IP/address, a new-password input and an enable/disable control, plus connection status and the public access link. A password is only entered when setting or changing it, never echoed back.

Existing Home address, API-token source, gateway ports and dedicated key are resolved on the Home machine from its actual configuration. Preserve an existing installation's validated private settings rather than replacing them with guessed defaults. A new installation must report missing prerequisites instead of silently choosing another Home.

Domain and exceptional SSH configuration belong in a collapsed Advanced section. Home addresses, token paths and other local implementation details are not ordinary form fields. Replacing a server IP does not provision a new server, authorize its key or derive its HTTPS domain automatically; preserve the configured domain until explicitly changed.

## Module boundary

Keep remote access in a dedicated module with its own configuration, authentication and tunnel lifecycle. Package generic gateway code and deployment templates with Workbench without importing the standalone repository's private Git history or runtime data. Home provides the settings interface; the public streaming gateway and SSH tunnel remain a separate process. Do not put relay traffic or SSH reconnect work inside Home's scheduler.

Reuse the verified gateway behavior: browser-only relay, fixed fifteen-day sessions, password changes revoke sessions, streaming with backpressure, restricted SSH identity, serialized configuration/test/start/stop operations and safe handling of persistence failures. No Worker protocol, queue, history or synchronization changes.

The existing standalone management page may remain as a local recovery entry. The primary settings surface becomes the Workbench card; both use the same private configuration and lifecycle, not two independent stores.

Field editing requires the independent service's `configPatch: 1` capability. Both UI surfaces send only changed fields to `/api/config-patch`; the service reads, merges and validates inside its shared lifecycle queue before stopping/writing. An older service remains usable for status/password/start/stop, but configuration editing fails closed with an upgrade message. It must not fall back to sending a stale complete snapshot. Updating the running independent service is a separate release action requiring matching authorization.

## Local-only administration

Public access to Workbench does not grant permission to change the Mac's relay, password or key paths. The new gateway must deny the Home remote-access administration routes explicitly. Home must also enforce a local-management proof, not just the API token or loopback source: an SSH proxy is itself a loopback client.

Use a short-lived, random local-browser management cookie issued only as an HttpOnly, SameSite=Strict response cookie, restricted to the management route prefix. Never return its value in JSON or general application state. Validate exact local Host/Origin, loopback connection and the proof on management requests. The existing gateway strips browser cookies before Home and strips Home Set-Cookie responses, so an older gateway cannot acquire or forward this proof. The new gateway adds explicit route denial. Bound and expire proof records; no task or model is involved.

Home calls the independent local management service server-side using its private management credential. That credential, Home token, password hash, SSH key contents and private file paths must not enter general state snapshots, browser storage, logs or Git. A request body contains the new password only for the explicit password-setting operation.

## Compatibility and failure behavior

- Missing service/configuration shows a concise unavailable/setup message; no automatic task interruption or unrelated service installation.
- Saving a changed server preserves existing local values and credentials, stops only the owned relay tunnel, and requires explicit re-enable.
- Unchanged password fields do not reset the password. Existing browser login duration stays fifteen days.
- Failed configuration validation preserves the original configuration. Failed persistence cannot leave an enable operation publicly active or prevent a requested stop from closing its own tunnel.
- Existing private installation paths are supplied locally during deployment, never hardcoded in the PR. No automatic scanning of home directories or credentials.
- In the remote browser, show that relay configuration is managed on the Home Mac; do not expose sensitive configuration or writable controls.

## Verification and delivery

Before publication, verify local settings rendering and narrow viewports, default/advanced fields, preservation of private defaults, password/enable/disable behavior, missing-service behavior, concurrent operations and failed writes. Test direct and proxied management requests, including the currently deployed older gateway, to prove the local-only boundary. Use isolated state for destructive/error cases and real read-only Home access for compatibility.

Keep regression scripts and evidence ignored, following repository policy. Run dependency installation, syntax checks, the existing test suite and focused browser checks. Independently review the security-sensitive bridge and exact candidate. Publish a new Workbench PR containing only this feature; do not include unrelated open PRs or the standalone project's private Git history.

The user authorized merging this verified PR into main, then updating and restarting the local Home; neither Worker nor unrelated work is included. Before Home restart, verify active Runs/native turns/queues and preserve the existing database, configuration, history and dirty source files. Wait when work would be interrupted. Use an isolated release directory and a rollback path; verify remote main ancestry, running version, real Basic Settings and Worker reconnection separately.

## Out of scope

No direct-first/P2P transport, automatic server provisioning, new cloud firewall rules, old-business deletion, repair of existing history errors or general performance refactoring. Mobile real-device acceptance remains separate from desktop viewport testing.
