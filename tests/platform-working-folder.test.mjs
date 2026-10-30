// The default platform prompt states the working-folder rules, a saved copy of the previous default follows the new one,
// and wb help sync says .worktrees never syncs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runWithLanguage, tr } from '../src/i18n.mjs';
import { createHash } from 'node:crypto';
import { normalizePlatformSettings, defaultPlatformPrompt } from '../src/platform-prompts.mjs';

// The working-folder section shipped on 2026-10-27, when role-created worktrees still synced; a saved copy must upgrade too.
const SYNCED_WORKTREES = {
  zh: "- 项目开启同步后，项目文件夹里的文件会在设备之间自动同步，包括角色建的 worktree；.git、构建产物等 Git 忽略的文件默认不同步，范围见 wb help sync。默认直接在绑定目录里改；除非确有必要，例如大体量修改，或和别人的工作明显重叠，尽量不新建 worktree，代码合并后尽快删除自己建的 worktree。平台安排你在隔离执行目录（.worktrees/run-*）里工作时，就在那里做，不要删它。\n- Git 状态（提交、分支、暂存区）不同步：本机 git status 里可能有别的设备同步过来的修改，不代表有人没提交，不要撤销或丢弃。提交时只暂存自己负责的文件，并先用 git log -1 确认 HEAD 就是这些修改所基于的版本；不是的话，先和改动的人协调。\n",
  en: "- Once sync is on for the project, the files in the project folder sync between devices automatically, role-created worktrees included; .git, build outputs and other Git-ignored files do not sync by default (scope: wb help sync). Work in the bound folder by default; unless it is really needed, such as a large change or work that clearly overlaps someone else's, avoid creating a worktree, and delete any worktree you created soon after the code is merged. When the platform places you in an isolated run folder (.worktrees/run-*), work there and do not delete it.\n- Git state (commits, branches, the index) does not sync: this device's git status may include changes synced from another device; that does not mean someone left work uncommitted, so do not revert or discard them. When committing, stage only the files you own, and first check with git log -1 that HEAD is the commit those changes were based on; if it is not, coordinate with whoever made them first.\n"
};

for (const [lang, heading, next, help] of [['zh', '工作目录：', '找人协作：', /\.worktrees（平台的隔离执行目录和手工建的 worktree）一律不同步/], ['en', 'Working folder:', 'Working with others:', /\.worktrees \(the platform's isolated run folders and any worktree made by hand\) never syncs/]]) {
  test(`${lang}: working-folder rules, upgrade from the previous default, and wb help sync`, () => runWithLanguage(lang, () => {
    const current = defaultPlatformPrompt();
    assert.ok(current.includes(`${heading}\n`) && current.indexOf(heading) < current.indexOf(next));
    const previous = current.slice(0, current.indexOf(heading)) + current.slice(current.indexOf(next));
    assert.equal(normalizePlatformSettings({ platformPrompt: previous }).platformPrompt, current, 'a saved copy of the previous default follows the new one');
    assert.match(current, lang === 'zh' ? /不要自己建 worktree/ : /do not create worktrees of your own/);
    const synced = current.slice(0, current.indexOf(heading) + heading.length + 1) + SYNCED_WORKTREES[lang] + current.slice(current.indexOf(next) - 1);
    assert.equal(createHash('sha256').update(synced.trim()).digest('hex'), { zh: '530d9f029e6063a00fe46b1fe6cd24549601a846edc4090efe1881dcdedb6c2c', en: 'df7c8bc92852404aa2f1c5b0cf08d696650d4301d0f9823c13ec651f657cc413' }[lang], 'the rebuilt text is the default that said worktrees sync');
    assert.equal(normalizePlatformSettings({ platformPrompt: synced }).platformPrompt, current, 'a saved copy of the default that said worktrees sync follows the new one');
    const rule = current.split('\n').find(line => lang === 'zh' ? line.startsWith('- 不要用聊天、wb note') : line.startsWith('- Never carry files, logs or bulk data'));
    assert.ok(rule, 'files and bulk data never travel in the chat');
    const beforeRule = current.replace(`${rule}\n`, '');
    assert.equal(createHash('sha256').update(beforeRule.trim()).digest('hex'), { zh: 'd4dc68ab68a56e878db63df2103ee593080818875043e3e921b3e5b64e4ddcf5', en: '2af981fb0fbafeb43a1def233f1fd7c98dac904c555ba5cb2559254703712a84' }[lang], 'the text without the rule is the previous default');
    assert.equal(normalizePlatformSettings({ platformPrompt: beforeRule }).platformPrompt, current, 'a saved copy of the previous default follows the new one');
    assert.equal(normalizePlatformSettings({ platformPrompt: 'my own words' }).platformPrompt, 'my own words');
    assert.match(tr('wbTools.helpSync'), help);
  }));
}
