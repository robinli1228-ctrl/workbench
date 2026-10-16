// Loaded by `npm test` before the runner spawns test files: a role session's inherited WB_* variables must not leak
// into tests. Tests that need one set it themselves after this runs.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

for (const key of Object.keys(process.env)) if (key.startsWith('WB_')) delete process.env[key];
// `npm test` first runs this file on its own to check dependencies once; the runner then imports it into every test
// file (those run with NODE_TEST_CONTEXT set) only to drop WB_*. One clear hint, then stop before any test starts.
if (!process.env.NODE_TEST_CONTEXT && !existsSync(fileURLToPath(new URL('../node_modules/ws/package.json', import.meta.url)))) {
  console.error('node_modules is missing in this checkout. Run `npm ci` here first (this script does not install anything).');
  process.exit(1);
}
