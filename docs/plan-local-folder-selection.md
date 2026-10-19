# 本机目录选择 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. 用户已审阅设计并明确要求直接实施，本会话顺序执行，不再重复索取计划确认。

**Goal:** 本机可浏览全部可访问目录，仅在创建项目或原生会话时绑定所选目录。

**Architecture:** 复用 Home 人类 API、Worker 查询和 Store。Worker 保存精确目录准备回执；Home 持久化绑定后才在对应项目/会话的消息中携带授权。Worker 在异步请求上下文中校验授权，绝不追加全局执行根目录。

**Tech Stack:** JavaScript ESM、Node 22.22.1、SQLite、原生浏览器 UI，无新依赖。

**Spec:** [design-local-folder-selection.md](design-local-folder-selection.md)

## Global Constraints

- 保留工作树已有修改、原生历史和活动任务；不部署、不重启、不发真实模型请求。
- 本机目录浏览仅人类 API 可用；远端仍受原 WORKER_ROOTS 限制。
- 保留已有目录内容；根目录可浏览但不可绑定，授权不等于原生 CLI 操作系统沙箱。
- 测试与证据留在忽略目录 `.local/local-folder-selection-20261019`，不提交测试脚本。

## Review Focus

- 同一 Worker 上其他项目/原生会话不得借用授权；覆盖并发异步请求上下文。
- Home 已存绑定但 Worker 回执丢失、创建请求重复或变更时只能恢复同一操作。
- 切换设备、取消选择或对话框迟到响应不得保留错误路径或创建授权。
- 目录被替换、挂载消失、符号链接逃逸必须拒绝；不清理用户目录。
- 旧 Worker、远端、活动终端和后台同步必须保留原边界，不因新增选择器变成全局授权。

### Task 1: Worker 目录授权与浏览

**Files:** `src/folder-access.mjs`（新）、`src/folders.mjs`、`package.json`。
**Interfaces:** `FolderAccess({db,roots,nodeId,local})` 提供 `prepare(input)`、`run(envelope,fn)`、`resolve(path)`、`allowedRoots()`；prepare 返回绑定 scope、canonical root、目录身份和操作 ID 的持久回执。`run` 仅授予该 envelope 的 scope，不改变全局 roots。浏览使用独立只读目录根。
- [x] 单测覆盖原根外未授权拒绝、prepare 不授权、匹配 envelope、其他身份及逃逸/换目录拒绝。
- [x] 实现本机浅层浏览、准备回执与目录身份校验，远端拒绝额外授权。
- [x] 单测及完整 suite 通过；与权限消费链路统一本地提交，避免发布半套授权实现。

### Task 2: Home/Worker 绑定生命周期

**Files:** `src/home.mjs`、`src/worker.mjs`、`src/native-turns-home.mjs`、`src/project-admin.mjs`、相关项目文件/Git/同步调用点。
**Interfaces:** Home 的 `folderGrants` 由人类创建入口写入，`folderAccessFor` 仅在现有项目/原生目录绑定一致时产生 active envelope；Worker 查询、Run、原生回合和明确同步请求消费该 envelope。准备不触发 CLI；删除、重绑定或取消未启动原生创建后失效，不靠历史文件重建授权。
- [x] 隔离 Home/Worker API：浏览不授权、原根外创建/准备成功，另一项目/Agent 凭证/远端拒绝；旧能力采用能力门禁，未运行旧二进制。
- [x] 稳定操作 ID、当前归属重验、持久绑定后使用和重试；默认创建保留，选已有目录不 bootstrap。
- [x] 后续项目操作、执行计划和同步重试传递实际身份；取消与重新连接撤销覆盖，活动原生租约拒绝重叠创建。

### Task 3: 两处创建页面与真实验收

**Files:** `public/project-setup.js`、`public/project-settings.js`、`public/app.js`、`public/native-sessions.js`、相关词条和 README；必要文档只改本需求段落。
**Interfaces:** 新建项目发送 `localRoot`（最终目录，可为空），原生会话沿用 `workspace`；两种浏览器均复用设备目录接口、分页和绝对路径输入。旧/远端设备不显示本机全目录能力。
- [x] 真实 Edge 指定原根外目录完成群聊创建、原生准备和关闭撤销，保留已有文件；实测并修复初始异步目录加载覆盖手工输入。
- [x] 接入两处控件，不修改他人的 HTML/图标改动；设备切换/迟到响应保护保留，未对每个系统权限弹窗做浏览器模拟。
- [x] npm ci/check/test、独立整体审核、差异复核；四项必修审核意见修正并回归，不宣称二次独立复审通过。未发布。

## 收尾说明

本次改动作为一个原子本地提交保存，测试和验收日志保留在忽略目录。原套件 120/120，初版新增本地验证 12/12，真实隔离服务及 Edge 页面通过。后续按用户要求补齐失败准备的即时补偿、断线恢复、原表单重试和迟到激活撤销保护，不再仅靠 15 分钟超时释放。活动或未知进程不强制释放。未部署或重启生产服务，也没有发出真实模型任务。
