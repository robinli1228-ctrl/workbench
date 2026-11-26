import { chmodSync, statSync } from 'node:fs';

// Linux packages ship the binary without execute bits. Fix it before a
// Worker running as a different user needs to launch it.
if (process.platform === 'linux') {
  const binary = new URL(`../node_modules/@ccusage/ccusage-linux-${process.arch}/bin/ccusage`, import.meta.url);
  const mode = statSync(binary, { throwIfNoEntry: false })?.mode;
  if (mode !== undefined && (mode & 0o111) !== 0o111) {
    chmodSync(binary, (mode & 0o777) | 0o111);
  }
}
