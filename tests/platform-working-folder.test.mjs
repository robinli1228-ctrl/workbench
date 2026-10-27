// The default platform prompt states the working-folder rules, a saved copy of the previous default follows the new one,
// and wb help sync says role-created worktrees sync.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runWithLanguage, tr } from '../src/i18n.mjs';
import { normalizePlatformSettings, defaultPlatformPrompt } from '../src/platform-prompts.mjs';

for (const [lang, heading, next, help] of [['zh', '工作目录：', '找人协作：', /角色建的 worktree 也会同步/], ['en', 'Working folder:', 'Working with others:', /role-created worktrees sync too/]]) {
  test(`${lang}: working-folder rules, upgrade from the previous default, and wb help sync`, () => runWithLanguage(lang, () => {
    const current = defaultPlatformPrompt();
    assert.ok(current.includes(`${heading}\n`) && current.indexOf(heading) < current.indexOf(next));
    const previous = current.slice(0, current.indexOf(heading)) + current.slice(current.indexOf(next));
    assert.equal(normalizePlatformSettings({ platformPrompt: previous }).platformPrompt, current, 'a saved copy of the previous default follows the new one');
    assert.equal(normalizePlatformSettings({ platformPrompt: 'my own words' }).platformPrompt, 'my own words');
    assert.match(tr('wbTools.helpSync'), help);
  }));
}
