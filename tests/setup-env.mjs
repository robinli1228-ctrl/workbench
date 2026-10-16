// Loaded by `npm test` before the runner spawns test files: a role session's inherited WB_* variables must not leak
// into tests. Tests that need one set it themselves after this runs.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

for (const key of Object.keys(process.env)) if (key.startsWith('WB_')) delete process.env[key];
if (!existsSync(fileURLToPath(new URL('../node_modules/ws/package.json', import.meta.url))))
  console.error('node_modules is missing in this checkout. Run `npm ci` here first (this script does not install anything).');
