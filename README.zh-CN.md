[English](README.md) | 简体中文

# Agent 协作工作台

设备详情支持设置每台设备的 **CLI 最大运行数**。角色执行、保留待续聊的 CLI 进程及后台整理共用名额；满额时排队，空闲后恢复原生会话。离线设备重连后应用保存值，降低上限不会中断已接收的任务。

角色详情提供“历史记录”页签。“清理记录”会断开该角色的旧会话关联，下一次执行开启新的 CLI 原生会话；项目群聊、代码文件和其他角色保留。

角色卡片的终端按钮默认可新建交互式 CLI 会话，不再要求先有执行记录。使用角色保存的设备、模型和项目目录，也可明确选择恢复旧会话。CLI 退出后请“归还平台”，恢复该设备上的项目派发。

“资源”下提供可选的“源码同步”，项目设置也有入口。选择仓库和设备，预览实际目录范围并明确启用后，可通过“立即同步”或角色的 `wb sync request` 交换已保存但未提交的源码。它是变更文件传输，不是保存即自动上传，也不替代 Git 交付。冲突会保留原版本并通知有证据的修改者；修复候选须经独立检查和明确接受后，再核对各端文件与回执。已验证 Mac/Linux 实际同步、Codex 修改者修复，以及四种 CLI 的源码工具读取和原会话续接。现有项目保持关闭，详见[设计与验收边界](docs/design-source-sync.md)。

一个自托管的工作台，把你已有的 AI 编程 CLI 和账号（Codex、Claude Code、Grok Build、Antigravity）组织成一个协作团队。你在项目群聊中 `@` 角色，工作台会在合适的机器上启动真实的 CLI，实时回传进度，并把结果、审核和交接记录集中保存。

> 状态：开发预览版（`0.4.0`）。面向单个可信操作者或小型可信团队。在将其暴露到网络之前，请先阅读[限制与路线图](#限制与路线图)。

## 为什么做这个项目

项目源于一个很实际的场景：一个人，多个 AI 订阅（不同厂商、不同模型），以及多台机器。

- **不同模型互相审核、互相补充。** 一个模型写代码，另一个从不同角度审核，第三个负责规划或测试。每一个都是一个*角色*，拥有各自的 CLI、模型和提示词。对固定 Git 提交做独立审核是一等公民级别的工作流。
- **用好你已经付费的额度。** 大多数账号在周期结束时都有用不完的 token。角色本质上就是“这个 CLI + 这个模型 + 这台机器”，所以你可以决定工作如何分摊到各个账号，并随时通过编辑角色调整分配。角色旁会显示 token 统计，以及 CLI 提供时的剩余额度，方便你有针对性地调整分配。
- **多台服务器和设备协同工作。** *Home* 节点保存项目状态，任意数量的 *Worker* 节点（你的笔记本、Linux 服务器、云主机）连接到它，运行各自机器上安装的 CLI。代码以固定的 Git 提交在设备间流转，文件以附件形式传递，主管角色可以协调分布在不同机器上的角色。

工作台不会取代这些 CLI，也不代理模型 API。它驱动你已经安装并登录好的 CLI，自身不保存任何厂商凭据。

## 语言

「基础设置」页签集中提供语言（English / 简体中文）、浏览器 API Token、微信通知和远程执行开关。Home 访问令牌验证后保存在此浏览器，关闭再打开会自动使用，需要时可在基础设置里修改。请使用可信浏览器；清除网站数据、使用无痕模式或更换浏览器、访问地址后可能需要重新设置。语言选项可将界面和内置提示词切换为对应语言。本 README 与[操作指南](docs/OPERATING-GUIDE.zh-CN.md)也提供简体中文版本。

## 主要功能

以下各项均已存在于当前代码中。仅有设计的内容单独列在[限制与路线图](#限制与路线图)中。

**协作**

- 项目群聊，通过 `@角色` 派发任务。不带 `@` 的消息只会保存，不会启动模型；Agent 发出的消息不会隐式触发其他 Agent。
- 每个项目拥有自己的角色，每个角色有独立的设备、CLI、模型、推理强度和 Markdown 提示词。内置模板（审核、规划、开发、测试）只是起点。
- 同设备 Codex/Grok 的 CLI 变更走“交接并切换”：保留角色和历史，等待已接任务完成，由新原生会话核对交接，确认进程退出后才保存配置。提交前取消保留原绑定。需要兼容 Worker；其他 CLI 尚未验收，会明确拒绝切换。当前验收状态见 [CLI 切换设计](docs/design-role-cli-switch.md)。
- 每个项目有一个固定的*主管*：接收不带 `@` 的请求，提出仓库/角色配置卡（确认后才会生效），并能安排多阶段工作（`wb schedule`），支持并行的独立审核以及顺序或汇总阶段。主管卡片固定显示在普通角色上方，点击直达项目设置中的主管设备、CLI、模型和思考深度配置。
- 通过统一的 `wb` 命令向所有受管 CLI 提供结构化的角色间工具：咨询其他角色（`wb call` / `wb wait`）、报告业务结论（`wb report`）、撰写交接记录（`wb handoff`）、请求 Git 交付（`wb deliver`）。模型输出里的 `@` 不会派发任何工作。
- 排队、按角色和按节点的并发限制、取消、对排队中的人工消息“立即引导”、远程派发暂停，以及需要 Worker 确认的显式停止。
- 原生会话续接：每个角色在多轮之间保留其厂商会话，并由后台对话整理器维护共享的项目摘要。
- 可选、默认关闭：同行讨论预览（`WB_DISCUSSION_PREVIEW`）。

**多设备**

- 通过经过认证的 WebSocket 实现 Home/Worker 分离。Worker 主动向外连接；Home 不会主动访问任何机器。
- 可靠投递：持久化的命令与事件发件箱、幂等的命令 ID、重连后对账，对状态未知的执行不会自动重跑。
- 每台设备有各自的项目目录，每个仓库有一条长期的项目基线分支（Git worktree），并支持基于固定 SHA 的跨设备交付，推送前必须经过明确确认。
- 附件（图片和文件，每条消息最多 6 个，每个最大 20 MB），带 SHA-256 校验，并提供“发送到设备”操作，用于把文件传给另一台已绑定的设备。
- 通过 SSH 的设备接入助手（在远程 Linux 机器上安装并连接 Worker），以及可选的由 Home 管理的反向 SSH 隧道。
- macOS Home 的远程桌面入口：检查已登记服务器的 xrdp，建立本机回环 SSH 转发或复用核对一致的现有同用户转发，然后打开 Windows App 的已保存连接。未知或有歧义的监听仍会阻断；入口不会终止外部管理的隧道。启动客户端不代表桌面已登录。
- 终端接管：在 iTerm 中继续已结束的原生会话（macOS 入口；远程设备通过你自己的 SSH 配置访问），期间平台会暂停向该设备派发。

**运维**

- 定时任务（单次、间隔、每日、每周），以及不调用模型的进度巡检，仅在出现新异常时唤醒主管（`wb timer`）。
- 按设备统计 token 用量，由 `ccusage` 采集。
- 保存 GitHub 和 Gitee 账号，并可选地创建仓库（默认私有）。
- 可安装的 PWA 外壳，桌面三栏布局和手机抽屉布局。
- 可选的微信确认通道，默认关闭。它依赖一个需要你自行提供的外部确认中心。

## 架构概览

```
 浏览器 (PWA)  <--HTTP/SSE-->  Home  <--认证的 WebSocket-->  Worker A  --> codex / claude / grok / agy
                                |                            Worker B  --> codex / claude / grok / agy
                         SQLite（项目、角色、                ...
                         房间、运行、队列）
```

- **Home**（`src/home.mjs`）：Web UI 与 REST API、SSE 更新、项目状态的唯一来源、调度器，以及 Worker 的 WebSocket 端点。基于 Node 的 HTTP 服务器和内置 SQLite 构建。
- **Worker**（`src/worker.mjs`）：每台机器一个。探测本地 CLI，在项目工作区中运行它们，维护本地数据库和发件箱，并把事件回报给 Home。
- **运行时适配器**：Codex 通过 App Server 协议；Claude Code、Grok Build 和 Antigravity 通过它们的非交互 print/stream 模式。
- **`wb`**（`bin/wb`）：所有受管 CLI 用来回连工作台的工具。它通过每轮独立的文件桥与 Worker 通信，因此 CLI 沙箱不需要网络访问。
- **Web UI**（`public/`）：纯 ES 模块，无需构建步骤。

细节与接口边界见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)（英文）。产品范围见 [docs/PRD.md](docs/PRD.md)（英文）。

## 环境要求

- Node.js `>= 22.16`（`.nvmrc` 固定了一个经过测试的版本）。使用 Node 内置的 `node:sqlite`，可能会打印实验性功能警告。
- Git。
- 每台要运行 Worker 的机器上，至少安装并登录一个受支持的 CLI：`codex`、`claude`、`grok` 或 `agy`。
- 可选：如需使用设备接入助手，需要能通过 SSH 访问远程机器。

## 快速开始（单机）

```sh
nvm use          # 可选，使用 .nvmrc 中的版本
npm install      # 或：npm ci
npm run dev      # 以两个独立进程启动 Home 和 Worker
```

打开 <http://127.0.0.1:4317>。默认只监听本机回环地址。

然后在界面中：

1. 打开基础设置，检查你的设备及其 CLI 是否已被检测到。
2. 创建项目。选择在线设备、已登录的 CLI 和模型作为项目主管，并为项目填写文件夹名。
3. 告诉主管要使用哪个仓库、需要哪些角色，确认它提出的配置卡，然后 `@` 某个角色开始工作。

你也可以自己分别运行这两个进程：

```sh
npm start        # Home
npm run worker   # Worker（在另一个终端中）
```

### 数据存放位置

| 路径 | 内容 |
| --- | --- |
| `.data/home/`（可用 `DATA_DIR` 覆盖） | Home 的 SQLite 数据库、附件、自动生成的 `worker-token`（权限 0600）、托管账号密钥 |
| `.data/worker/`（可用 `WORKER_DATA_DIR` 覆盖） | Worker 的 SQLite 数据库、节点身份、发件箱、运行环境 |
| `<项目文件夹>/.worktrees/` | 每次运行及项目基线的 Git worktree |
| `<项目文件夹>/.workbench/` | 交接记录、临时附件，以及工作区内的其他平台文件 |
| `.local/` | 本地验证用的临时空间；永不发布 |

切勿提交以上任何内容。参见 [docs/OPERATING-GUIDE.zh-CN.md](docs/OPERATING-GUIDE.zh-CN.md)。

## 配置

角色编辑区将**角色职能**（供其他角色选择协作对象）与**角色提示词**（本角色执行时注入）分开。本角色不会从团队目录收到自己的职能。设备离线时仍可只修改文字，保留 CLI 和模型绑定。已有自定义提示词不被自动覆盖，未填职能表示未指定，不按名字猜测。

所有配置都通过环境变量完成。可参考 [`.env.example`](.env.example)；应用本身不会加载 `.env` 文件，请在 shell 或服务管理器中导出这些变量。下表中的值均为占位符。

**Home**

| 变量 | 默认值 / 用途 |
| --- | --- |
| `PORT` | `4317` |
| `HOST` | `127.0.0.1`。非回环地址必须设置 `API_TOKEN`，并且应放在 HTTPS 反向代理之后 |
| `DATA_DIR` | 项目内的 `.data/home` |
| `API_TOKEN` | 浏览器访问令牌，监听非回环地址时必填（例如 `xxxxx`） |
| `WORKER_TOKEN` | Worker 共用的注册令牌。未设置时会生成到 `.data/home/worker-token` |
| `TOKEN_USAGE_TIMEZONE` | token 统计的日界线时区，默认使用系统时区；可设置以覆盖 |

**Worker**

| 变量 | 默认值 / 用途 |
| --- | --- |
| `HOME_URL` | `ws://127.0.0.1:4317/worker`；远程 Home 使用 `wss://xxxxx/worker` |
| `WORKER_TOKEN` | 必须与 Home 的令牌一致（例如 `xxxxx`）。本机会从 Home 数据目录读取 |
| `WORKER_ROOTS` | 允许的项目根目录，以操作系统的路径分隔符分隔（例如 `xxxxx`）。默认为项目目录 |
| `WORKER_DATA_DIR` | `.data/worker`；每个 Worker 一个目录，绝不可被两个进程共用 |
| `WORKER_CONCURRENCY` | `2` |
| `NODE_NAME` | 显示名称；默认为主机名 |
| `NODE_KIND` | `local` 或 `cloud`；Linux 上默认为 `cloud`，其他系统默认为 `local` |
| `CODEX_BIN`, `CLAUDE_BIN`, `GROK_BIN`, `AGY_BIN` | CLI 可执行文件；当 `PATH` 不同时请设置绝对路径（`xxxxx`） |
| `CLAUDE_MODEL_ID` | 当 `CLAUDE_BIN` 指向兼容 Anthropic 的启动器时，对外声明的模型 ID |
| `CLAUDE_CONFIG_DIR` | 原生会话目录；当包装器改变了 `HOME` 时需要设置 |
| `NODE_ID`, `WORKSPACE_ROOT`, `REMOTE_DESKTOP_URL`, `CCUSAGE_BIN` | 可选覆盖项，见 `src/worker.mjs` 和 `src/token-usage.mjs` |

可选功能：`WB_DISCUSSION_PREVIEW=1` 配合 `WB_DISCUSSION_VALIDATED_CONFIGS`（由你已验证过的 `{runtime, model, version, bin}` 条目组成的 JSON 数组）可启用同行讨论预览。`WECHAT_CLIENT` 和 `WECHAT_CLIENT_CONFIG` 用于配置可选的微信通道。

### Home 与远程 Worker

在一台常开的机器上运行 Home，并从其他机器连接 Worker。对于少量个人节点，使用 SSH 隧道即可：

```sh
# 在 Worker 机器上
ssh -NT -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -L 14317:127.0.0.1:4317 xxxxx@xxxxx
```

```sh
# 在 Worker 机器上的另一个终端中
export HOME_URL=ws://127.0.0.1:14317/worker
export NODE_NAME=xxxxx
export WORKER_ROOTS=xxxxx
read -r -s WORKER_TOKEN && export WORKER_TOKEN   # 粘贴 Home 的 Worker 令牌
npm run worker
```

如果你已有 HTTPS/WSS 反向代理，设置 `HOME_URL=wss://xxxxx/worker` 并跳过隧道即可。Node 本身不终止 TLS。更多部署方式见 [docs/OPERATING-GUIDE.zh-CN.md](docs/OPERATING-GUIDE.zh-CN.md)。

## 开发

```sh
npm run check    # 对每个源文件执行 node --check（仅检查语法）
```

欢迎贡献。请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [AGENTS.md](AGENTS.md)。

## 文档

| 文档 | 用途 |
| --- | --- |
| [docs/OPERATING-GUIDE.zh-CN.md](docs/OPERATING-GUIDE.zh-CN.md) | 如何发布、配置、运行并共同迭代本项目 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 当前代码架构、接口与实现边界（英文） |
| [docs/PRD.md](docs/PRD.md) | 产品目标与范围（英文） |
| [docs/design-coordination.md](docs/design-coordination.md) | 主管、可选计划与跨设备角色协作（英文） |
| [docs/design-local-supervisor.md](docs/design-local-supervisor.md) | 项目主管与多仓库设置（英文） |
| [docs/design-supervisor-timers.md](docs/design-supervisor-timers.md) | `wb timer` 定时任务与进度巡检（英文） |
| [docs/design-session-handoff.md](docs/design-session-handoff.md) | 受控的跨设备会话交接方案（尚未实现，英文） |
| [docs/README.zh-CN.md](docs/README.zh-CN.md) | 文档索引 |

## 限制与路线图

在依赖本项目之前，请先了解以下事项：

- **仅限可信操作者。** 所有浏览器共用同一个 Home 凭据；没有按用户区分的身份和权限，不能按设备撤销凭据，Node 内部也没有 TLS。Worker 注册令牌是一个共享密钥。
- **自动批准执行。** Codex 以 `workspace-write` 和审批策略 `never` 运行；Claude Code、Grok Build 和 Antigravity 在 Worker 指定的工作区内使用跳过权限确认的参数运行。没有原生的逐步审批。`wb` 工具的允许列表并不是针对同一账号下恶意 shell 的沙箱。
- **单一 Home。** 没有复制或自动故障转移；运行在笔记本上的 Home 在笔记本休眠时无法派发任务。
- **跨设备会话交接目前只是设计，还不是功能。** 目前你可以把角色重新绑定到另一台设备、交付固定的 Git 提交、发送附件，但厂商的原生会话不会迁移。见 [docs/design-session-handoff.md](docs/design-session-handoff.md)。
- **尚未实现：** 其他 ACP 运行时、更多聊天通道（飞书）、多用户身份、Home 的人工主备切换、已交付分支的自动合并。
- token 统计反映的是 `ccusage` 看到的本地 CLI 历史，不是厂商账单。额度显示是对每个 CLI 的尽力探测，当 CLI 不提供时会显示“不可用”。
- 进程成功退出只代表一次执行结束，不代表工作已被验收。

项目状态和计划中的工作在 issue 跟踪器中记录。

## 许可证

MIT。见 [LICENSE](LICENSE)。
