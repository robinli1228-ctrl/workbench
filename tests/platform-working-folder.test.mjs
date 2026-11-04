// The default platform prompt states the working-folder rules, a saved copy of the previous default follows the new one,
// and wb help sync says .worktrees never syncs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runWithLanguage, tr } from '../src/i18n.mjs';
import { createHash } from 'node:crypto';
import { normalizePlatformSettings, defaultPlatformPrompt } from '../src/platform-prompts.mjs';

// The working-folder section shipped on 2026-10-27, when role-created worktrees still synced; a saved copy must upgrade too.
// The bulk-data rule as it read before roles were told to use wb device.
const PREVIOUS_BULK_RULE = {
  zh: '- 不要用聊天、wb note 或派活文字传文件、日志或大段数据（例如分段的 base64）。跨设备交接材料放进同步范围内的 .workbench/docs，或者提交后用 wb deliver 交付；材料不在同步范围内时，说明在哪台设备、哪个路径，请用户决定，不要自己切片传。',
  en: '- Never carry files, logs or bulk data (such as base64 in parts) in the chat, wb note or call text. Hand material to another device through the sync-scoped .workbench/docs, or commit it and deliver with wb deliver; when the material is outside the sync scope, say which device and path it is on and let the user decide instead of slicing it yourself.'
};

// The rules as they read before wb device could write and independent reviewers could read other devices: [old, new].
const DEVICE_EDITS = {
  "zh": [
    [
      "- 要看另一台项目设备上的文件或日志（例如用户本机运行的服务日志），自己用 wb device ls / wb device read 只读查看（用法见 wb help），不要请别人摘抄或转发。",
      "- 要看另一台项目设备上的文件或日志（例如用户本机运行的服务日志），或改那台设备上的文件，自己用 wb device ls / read / write（用法见 wb help），不要请别人摘抄或转发。"
    ],
    [
      "别人用 wb device ls / read 自己读（独立审核者读不了，给他们的材料用 wb call --file 附上或放进 .workbench/docs）；",
      "别人用 wb device ls / read 自己读；"
    ]
  ],
  "en": [
    [
      "- To see files or logs on another project device (e.g. the logs of a service the user runs locally), read them yourself, read-only, with wb device ls / wb device read (see wb help); do not ask someone to copy or forward them.",
      "- To see files or logs on another project device (e.g. the logs of a service the user runs locally), or to change files there, use wb device ls / read / write yourself (see wb help); do not ask someone to copy or forward them."
    ],
    [
      "where others read them with wb device ls / read (independent reviewers cannot: give them material with wb call --file or in .workbench/docs);",
      "where others read them with wb device ls / read;"
    ]
  ]
};

// The rules as they read before work materials left /tmp, task descriptions held only the current state and reviews were
// sized to the change: [old, new] pairs, undone to rebuild that default.
const LEAN_EDITS = {
  "zh": [
    [
      "- 转交给你的任务，你就是负责人：自己推进到底，组织审核，做完直接回复用户结论。",
      "- 转交给你的任务，你就是负责人：自己推进到底，按下面的审核规则安排审核，做完直接回复用户结论。"
    ],
    [
      "- 不要用聊天、wb note 或派活文字传文件、日志或大段数据（例如分段的 base64）。跨设备交接材料放进同步范围内的 .workbench/docs，或者提交后用 wb deliver 交付；对方能用 wb device read 直接读的，告诉对方设备和路径即可；都不行时说明在哪台设备、哪个路径，请用户决定，不要自己切片传。",
      "- 不要用聊天、wb note 或派活文字传文件、日志或大段数据（例如分段的 base64）。正式报告放同步范围内的 .workbench/docs；查问题时的日志、查询结果、探针、临时脚本等中间资料放环境说明里的中间资料目录（不同步，不要放 /tmp），别人用 wb device ls / read 自己读（独立审核者读不了，给他们的材料用 wb call --file 附上或放进 .workbench/docs）；固定版本的审核和测试用提交加 wb deliver。交接时告诉对方设备和路径即可，不用逐个写字节数和哈希；都不行时说明在哪台设备、哪个路径，请用户决定，不要自己切片传。"
    ],
    [
      "- 要别的角色协同时，先用 wb task create 建一个待办，写清目标和步骤；派活时用 wb call --task 关联它。",
      "- 要别的角色协同时，先用 wb task create 建一个待办，写清目标和步骤；派活时用 wb call --task 关联它。任务说明只写当前状态，控制在 3 KB 以内；过程写在 wb task update 的 reason 里，不往说明后面追加。"
    ],
    [
      "输入（设备、目录、完整 SHA 或文件路径与哈希，不说“最新版本”）",
      "输入（设备和路径；代码版本写完整提交 SHA，不说“最新版本”）"
    ],
    [
      "- 你做的或负责的重要改动，至少请两位非作者的模型角色审核，一次只找一位，这一位确认后再找下一位。你是被请来审核的，就只给出自己的审核意见，不再另找别人审核。",
      "- 审核按改动大小安排：只读查询、答疑、文档、配置值、一两个文件且能直接验证的小修，自测后直接交付，不另找人审；其他改动请一位非作者审核；涉及权限、认证、数据迁移、资金、生产操作、安全、对外接口，或改动本身涉及跨仓库、跨设备行为（如同步、设备间通信）的，不论大小，以及用户点名要求的，先请一位非作者确认方案，再请两位非作者依次审核（一次一位），然后独立测试。修复后只请提出问题的人复核。你是被请来审核的，就只给出自己的审核意见，不再另找别人审核。"
    ],
    [
      "- 被派的活做完后，结果写在最终回复里，会自动交回派活的人；不要再反过来 call 它。\n- 安排多人依次审核时，已经准备好的人先开始，不因为某一位的材料没到就全部等着；最终结论要等所有人都审完。",
      "- 被派的活做完后，结果写在最终回复里，会自动交回派活的人；不要再反过来 call 它。"
    ]
  ],
  "en": [
    [
      "- A task transferred to you makes you its owner: drive it to the end yourself, organise its reviews, and reply to the user with the conclusion when done.",
      "- A task transferred to you makes you its owner: drive it to the end yourself, arrange reviews under the review rule below, and reply to the user with the conclusion when done."
    ],
    [
      "- Never carry files, logs or bulk data (such as base64 in parts) in the chat, wb note or call text. Hand material to another device through the sync-scoped .workbench/docs, or commit it and deliver with wb deliver; if the other role can read it with wb device read, give the device and path; otherwise say which device and path it is on and let the user decide instead of slicing it yourself.",
      "- Never carry files, logs or bulk data (such as base64 in parts) in the chat, wb note or call text. Formal reports go in the sync-scoped .workbench/docs; logs, query results, probes, scratch scripts and other work materials go in the work materials folder named in the environment notes (not synced; never /tmp), where others read them with wb device ls / read (independent reviewers cannot: give them material with wb call --file or in .workbench/docs); fixed-version review and testing use a commit and wb deliver. When handing over, give the device and path; do not list sizes and hashes file by file. Otherwise say which device and path it is on and let the user decide instead of slicing it yourself."
    ],
    [
      "- When you ask other roles to collaborate, first create a todo with wb task create stating the goal and steps; link it with wb call --task when assigning.",
      "- When you ask other roles to collaborate, first create a todo with wb task create stating the goal and steps; link it with wb call --task when assigning. Keep the task description to the current state, within about 3 KB; put the history in the reason of wb task update, never append it to the description."
    ],
    [
      "the inputs (device, directory, full SHA or file path and hash, never \"the latest version\")",
      "the inputs (device and path; the full commit SHA for code, never \"the latest version\")"
    ],
    [
      "- Have important changes you made or own reviewed by at least two model roles other than the author, one at a time; move to the next only after the current one confirms. When you were asked to review, give only your own review and do not ask others to review it.",
      "- Size reviews to the change: read-only checks, answers, documents, configuration values and small fixes to one or two files that can be verified directly are self-tested and delivered without another review; other changes get one non-author review; changes touching permissions, authentication, data migration, money, production operations, security or external interfaces, or whose behaviour itself spans repositories or devices (such as sync or device-to-device communication), whatever their size, and anything the user asked to be reviewed fully, get the plan confirmed by one non-author first, then two non-author reviews in turn (one at a time), then an independent test. After a fix, only the reviewer who raised the issue rechecks it. When you were asked to review, give only your own review and do not ask others to review it."
    ],
    [
      "- When assigned work is complete, write the result in your final reply; it is returned to the assigning role automatically. Do not call it back.\n- When arranging sequential reviews, reviewers who are ready should start; do not make everyone wait for one missing input. Wait for every review before the final conclusion.",
      "- When assigned work is complete, write the result in your final reply; it is returned to the assigning role automatically. Do not call it back."
    ]
  ]
};

const SYNCED_WORKTREES = {
  zh: "- 项目开启同步后，项目文件夹里的文件会在设备之间自动同步，包括角色建的 worktree；.git、构建产物等 Git 忽略的文件默认不同步，范围见 wb help sync。默认直接在绑定目录里改；除非确有必要，例如大体量修改，或和别人的工作明显重叠，尽量不新建 worktree，代码合并后尽快删除自己建的 worktree。平台安排你在隔离执行目录（.worktrees/run-*）里工作时，就在那里做，不要删它。\n- Git 状态（提交、分支、暂存区）不同步：本机 git status 里可能有别的设备同步过来的修改，不代表有人没提交，不要撤销或丢弃。提交时只暂存自己负责的文件，并先用 git log -1 确认 HEAD 就是这些修改所基于的版本；不是的话，先和改动的人协调。\n",
  en: "- Once sync is on for the project, the files in the project folder sync between devices automatically, role-created worktrees included; .git, build outputs and other Git-ignored files do not sync by default (scope: wb help sync). Work in the bound folder by default; unless it is really needed, such as a large change or work that clearly overlaps someone else's, avoid creating a worktree, and delete any worktree you created soon after the code is merged. When the platform places you in an isolated run folder (.worktrees/run-*), work there and do not delete it.\n- Git state (commits, branches, the index) does not sync: this device's git status may include changes synced from another device; that does not mean someone left work uncommitted, so do not revert or discard them. When committing, stage only the files you own, and first check with git log -1 that HEAD is the commit those changes were based on; if it is not, coordinate with whoever made them first.\n"
};

for (const [lang, heading, next, help] of [['zh', '工作目录：', '找人协作：', /\.worktrees（平台的隔离执行目录和手工建的 worktree）一律不同步/], ['en', 'Working folder:', 'Working with others:', /\.worktrees \(the platform's isolated run folders and any worktree made by hand\) never syncs/]]) {
  test(`${lang}: working-folder rules, upgrade from the previous default, and wb help sync`, () => runWithLanguage(lang, () => {
    const current = defaultPlatformPrompt();
    const undo = edits => (text => edits.reduce((rebuilt, [old, now]) => { assert.ok(rebuilt.includes(now), now.slice(0, 40)); return rebuilt.replace(now, old); }, text));
    const beforeWrite = undo(DEVICE_EDITS[lang])(current);
    assert.equal(createHash('sha256').update(beforeWrite.trim()).digest('hex'), { zh: '7b38305fa620f1b58819b221f78a09e766b22cdbed359e6bd0a30a8e3f19e46e', en: 'd522244b3d4914fb6a1f298de9c9acd08cf6d500e6529f68a5d517230a075486' }[lang], 'the rebuilt text is the default before wb device write');
    assert.equal(normalizePlatformSettings({ platformPrompt: beforeWrite }).platformPrompt, current, 'a saved copy of that default follows the new one');
    const base = undo(LEAN_EDITS[lang])(beforeWrite);
    assert.equal(createHash('sha256').update(base.trim()).digest('hex'), { zh: '3fdbf1bde2150d398e0c00f5b0d43275f6b2f5f12321c7873309526a6d752205', en: 'e7e2d387202ae8d70f8f0e466ba691e82034a202937f6c5ed518311ac483e8cb' }[lang], 'the rebuilt text is the previous default');
    assert.equal(normalizePlatformSettings({ platformPrompt: base }).platformPrompt, current, 'a saved copy of the previous default follows the new one');
    assert.ok(current.includes(`${heading}\n`) && current.indexOf(heading) < current.indexOf(next));
    const previous = base.slice(0, base.indexOf(heading)) + base.slice(base.indexOf(next));
    assert.equal(normalizePlatformSettings({ platformPrompt: previous }).platformPrompt, current, 'a saved copy of the previous default follows the new one');
    assert.match(current, lang === 'zh' ? /不要自己建 worktree/ : /do not create worktrees of your own/);
    const synced = base.slice(0, base.indexOf(heading) + heading.length + 1) + SYNCED_WORKTREES[lang] + base.slice(base.indexOf(next) - 1);
    assert.equal(createHash('sha256').update(synced.trim()).digest('hex'), { zh: '530d9f029e6063a00fe46b1fe6cd24549601a846edc4090efe1881dcdedb6c2c', en: 'df7c8bc92852404aa2f1c5b0cf08d696650d4301d0f9823c13ec651f657cc413' }[lang], 'the rebuilt text is the default that said worktrees sync');
    assert.equal(normalizePlatformSettings({ platformPrompt: synced }).platformPrompt, current, 'a saved copy of the default that said worktrees sync follows the new one');
    const device = base.split('\n').find(line => lang === 'zh' ? line.startsWith('- 要看另一台项目设备上的文件或日志') : line.startsWith('- To see files or logs on another project device'));
    assert.ok(device && /wb device read/.test(device), 'roles are told to read other devices themselves');
    const bulk = base.split('\n').find(line => lang === 'zh' ? line.startsWith('- 不要用聊天、wb note') : line.startsWith('- Never carry files, logs or bulk data'));
    const beforeDevice = base.replace(`${device}\n${bulk}`, PREVIOUS_BULK_RULE[lang]);
    assert.equal(createHash('sha256').update(beforeDevice.trim()).digest('hex'), { zh: '0600e6f1aa67dafd54c62c3bf4b48ffc11898a7ac644b589c9b62db8e63d8304', en: 'fbc455ad3100ed1885946d7e6f2986d49c1a924e2e89c1a077250406216835c3' }[lang], 'the rebuilt text is the default before wb device');
    assert.equal(normalizePlatformSettings({ platformPrompt: beforeDevice }).platformPrompt, current, 'a saved copy of that default follows the new one');
    const rule = PREVIOUS_BULK_RULE[lang];
    const withoutBulk = beforeDevice.replace(`${rule}\n`, '');
    assert.ok(rule, 'files and bulk data never travel in the chat');
    const beforeRule = withoutBulk;
    assert.equal(createHash('sha256').update(beforeRule.trim()).digest('hex'), { zh: 'd4dc68ab68a56e878db63df2103ee593080818875043e3e921b3e5b64e4ddcf5', en: '2af981fb0fbafeb43a1def233f1fd7c98dac904c555ba5cb2559254703712a84' }[lang], 'the text without the rule is the previous default');
    assert.equal(normalizePlatformSettings({ platformPrompt: beforeRule }).platformPrompt, current, 'a saved copy of the previous default follows the new one');
    assert.equal(normalizePlatformSettings({ platformPrompt: 'my own words' }).platformPrompt, 'my own words');
    assert.match(tr('wbTools.helpSync'), help);
  }));
}
