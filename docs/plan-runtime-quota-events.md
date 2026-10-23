# Claude / Codex 被动额度更新实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 使用 superpowers:executing-plans，由当前侧聊直接执行；本侧聊禁止子 Agent。

**Goal:** 通过已有正常执行连接更新 Claude / Codex 额度，取消两者定时额外额度查询，保留真实数据时效。

**Architecture:** 适配器解析原生额度事件，Worker 合并到设备运行时快照，Home 沿既有通道持久化并展示。不新增采集进程或模型请求。

**Tech Stack:** JavaScript ESM、Node.js 22、现有 WebSocket / SQLite、无新增依赖。

**Spec:** [设计](design-runtime-quota-events.md)。状态：已获用户批准并实施后台改动；隔离验证完成，真实账号验收及独立审核待补。不发布。

## Global Constraints

- 只改 Claude / Codex；Grok / Agy 查询不变。
- 后续用户约束优先：界面交互不变，public 文件保持逐字节一致，时效标记由 Home 现有心跳更新。
- 保留历史、已有修改和活动任务，不改认证，不部署、不重启。
- 保留安装、登录、模型发现检查；不把此次优化描述为登录失效根因已修复。
- 隔离工作区位于项目内部 `.worktrees/`，不修改主会话使用的工作区。
- 新测试放忽略目录 `.local/quota-events-tests/`，不入库；不删除既有测试。

## Review Focus

1. 原生事件字段缺失、NaN、负数、合法超额值及秒/毫秒单位。
2. Codex 多 bucket、Claude 不同窗口，不能错误合并或跨设备。
3. 检测与事件同时完成，重连与旧事件重放不得覆盖较新样本。
4. 已完成但仍驻留的连接事件、子任务事件，不得改变当前 turn 的归属和结束状态。
5. 额度过期与登录变化时不得伪装为实时数据或“充足”。

## Task 1：解析正常连接的额度事件

**Files:** 新建 `src/runtime-quota.mjs`；修改 `src/cli-print-session.mjs`、`src/native-turn-sessions.mjs`、`src/codex.mjs`、`package.json`。

**Interfaces:** `normalizeRuntimeQuota(runtime, raw)` 返回仅含合法窗口的样本或 null；适配器通过既有 emit 输出 `quota` 事件。不得把额度窗口解析成 `usage` Token 统计。

- [ ] 在 `.local/quota-events-tests/` 编写真实适配器 receive 测试：Claude 两窗口、零使用、缺失窗口、超额、非法数字；Codex 默认 bucket 和其他 bucket 分离；原消息/完成事件不变。
- [ ] 运行 Node 测试，确认因为尚无 quota 输出而失败。
- [ ] 实现最小解析与事件出口，确保空闲驻留连接也能收额度，但不误收其他 session 的执行结果。
- [ ] 重跑相关测试并执行 `npm run check`；新增文件加入 check。

## Task 2：沿既有 Worker / Home 路径保存与展示

**Files:** 修改 `src/worker.mjs`、`src/native-turns-worker.mjs`、`src/native-turns.mjs`、`src/home.mjs`；额度归并函数放 `src/runtime-quota.mjs`。页面代码不改。

**Interfaces:** Worker 消费 Task 1 的 quota 事件，维护对应 runtime 的 `quota`、`quotaCheckedAt` 和来源；既有 runtime_report / 心跳承载快照。Home 只能接受已认证 Worker 自身的样本。

- [ ] 先写失败测试：两个设备隔离、缺失字段不抹除、旧事件不覆盖、检测并发不覆盖、断线重连保持原时间、窗口重置后未知、认证失效后不沿用新鲜额度。
- [ ] 实现事件合并和传输；群聊、native 会话接入同一处理函数，不把 quota 当聊天文本或调度事件。
- [ ] 运行隔离 Home / Worker 的真实 WebSocket 验证并检查持久化结果，确认不产生 launch 或额外模型请求。
- [ ] 在隔离真实浏览器验证额度及旧快照提示，不能把模拟事件结果声称为真实模型验收。

## Task 3：取消额外查询并核实无遗漏

**Files:** 修改 `src/runtime-probe.mjs`、`README.md`、`docs/ARCHITECTURE.md`，按需要维护现有文档索引；不修改自动维护的 HANDOFF / PROGRESS 核心字段。

- [ ] 用隔离 CLI 替身记录探测命令，先验证原逻辑会额外调用 Claude `/usage` 与 Codex `account/rateLimits/read`。
- [ ] 移除两条定时额度请求及仅供它们使用的死代码；保留安装、认证、模型检测和 Grok / Agy 原行为。
- [ ] 再测命令记录，确认不再发起上述额度查询，模型事件仍可更新页面且快照不被探测抹掉。
- [ ] 运行 `npm ci`、`npm run check`、`npm test`、`git diff --check`；记录失败项和剩余风险。
- [ ] 当前侧聊自行审查完整 diff，不冒充独立审核。真实 Claude 登录未恢复时明确保留真实会话验收缺口。
- [ ] 仅在验证证据充分后形成本地提交；不推送、不合主线、不部署、不重启。
