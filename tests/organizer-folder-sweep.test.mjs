// Organizer runs each use an empty summary-* folder under the Worker's data and remove it when they end; folders left by a
// run that a crash or kill cut off are removed when the Worker starts, and nothing else in the data folder is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepOrganizerFolders } from '../src/conversation-organizer.mjs';

test('leftover organizer folders go; other folders and files stay', async () => {
  const data = mkdtempSync(join(tmpdir(), 'wb-sweep-'));
  try {
    for (const name of ['summary-1ErZ69', 'summary-haBJO8', 'summary-xWBF4x']) { mkdirSync(join(data, name)); writeFileSync(join(data, name, 'prompt.txt'), 'x'); }
    for (const name of ['git-auth', 'native-bridges', 'summary-notes', 'summary-']) mkdirSync(join(data, name));
    writeFileSync(join(data, 'summary-abcdef'), 'a file, not a folder'); writeFileSync(join(data, 'worker.sqlite'), '');
    assert.equal(await sweepOrganizerFolders(data), 3);
    assert.deepEqual(readdirSync(data).sort(), ['git-auth', 'native-bridges', 'summary-', 'summary-abcdef', 'summary-notes', 'worker.sqlite']);
    assert.equal(await sweepOrganizerFolders(join(data, 'missing')), 0, 'a missing data folder is not an error');
  } finally { rmSync(data, { recursive: true, force: true }); }
});
