# Independent remote-access module

This optional Node.js 22 module relays trusted browsers to an existing Home through HTTPS and a dedicated SSH reverse tunnel. It runs separately from Home and Workers; importing it does not start a process.

The normal management surface is **Settings → Basic Settings → Remote Access** on the Home machine. It displays the server address, password and enable/disable controls. Home/token/key paths stay private; domain and exceptional SSH settings are advanced controls.

## Installation and recovery

First provision the relay's HTTPS certificate, restricted SSH identity and loopback forwarding port. Use the generic templates in `ops/` with private substitutions. Do not expose Home, management or forwarding ports publicly. Verify the SSH host fingerprint; permit only the required remote forward, not shell/PTY or other forwarding.

From this module directory, operator recovery commands are:

```sh
node src/cli.mjs init --config xxxxx
node src/cli.mjs generate-key --config xxxxx
node src/main.mjs --config xxxxx
node src/cli.mjs open-settings --config xxxxx
```

`xxxxx` is an absolute private configuration path. Initialization never overwrites existing files. Home's private `REMOTE_ACCESS_CONFIG` points to this same file; otherwise Home looks beneath its own data directory. No credential scanning occurs. Changing an IP does not provision a server or determine its domain automatically.

## Security and behavior

- The relay server terminates TLS and is trusted. Login grants the original Home web permissions, not a read-only guest role.
- Passwords are set locally. Browser sessions last a fixed fifteen days; password changes revoke all sessions, and logout revokes the current session and its streams.
- The gateway strips client credentials and Home cookies, injects the Home token only in its process, and blocks Worker and local relay-management routes.
- Uploads, downloads and SSE stream with backpressure. Disconnection never automatically replays a write. Home retains history and attachments; the gateway has no second history store.
- Configuration, test and start/stop share one lifecycle queue. Failed state persistence rolls back a start and cannot prevent stopping the owned tunnel.
- Domain/SSH changes stop only the owned connection. Listener/state-directory changes require restarting this module only.
- Actual settings, private keys, sessions, logs and screenshots stay outside Git. Never import the standalone installation's private Git history.

## Operations

Use ACME webroot validation and a successful-renewal hook that checks Nginx before reloading. Certificate issuance alone is not end-to-end verification. Rollback stops only this module's service/tunnel and relay site; preserve private state and Workbench data.

A sleeping/offline Mac cannot be accessed. Logout does not erase previously downloaded files. Mobile acceptance and per-installation evidence remain private and separate from unit-test results.
