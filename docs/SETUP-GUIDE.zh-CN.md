# Agent Workbench 安装与配置指南（可直接交给 AI 协助执行）

> 这份文档面向两类读者：准备部署 Workbench 的人，以及被请来协助部署的 AI 助手。
> 它只描述仓库里真实存在的流程、变量和依赖，不假设任何账号、域名或路径。
> 文中 `xxxxx` 一律是占位符，由使用者提供。

## 0. 给 AI 助手的使用说明

1. 先问清楚四件事再动手：目标机器有几台、各自是什么系统（macOS / Linux）、Home 打算跑在哪一台、要使用哪些 CLI（`codex`、`claude`、`grok`、`agy`）。
2. 严格按本文的顺序执行：环境 → 代码与依赖 → Home → Worker → 界面内配置。每一步都有「验证方法」，没通过不要进入下一步。
3. 所有敏感值（`API_TOKEN`、`WORKER_TOKEN`、GitHub / Gitee 令牌）只在用户自己的 shell、服务管理器或 Home 数据目录里出现，绝不写进仓库、提交记录或聊天内容。
4. 不要替用户删除或清空任何 `.data/`、`WORKER_DATA_DIR`、项目目录；Worker 的身份存放在它的数据目录里，清空等于换了一台设备。
5. 遇到本文未覆盖的情况，以仓库里的 `README.zh-CN.md`、`docs/OPERATING-GUIDE.zh-CN.md` 和源码为准，不要猜测。

## 1. 它是什么、由哪些部分组成

Workbench 是一个本地优先的「多 Agent 协作控制台」：把你已经登录好的命令行 Agent（Codex、Claude Code、Grok、Antigravity/Agy）组织成项目里的角色，在群聊中分派任务，并在「会话」页直接接管或续接这些 CLI 的原生会话。

| 组成 | 进程 | 作用 |
| --- | --- | --- |
| **Home** | `node src/home.mjs` | 唯一的控制中心：提供网页界面（默认 `http://127.0.0.1:4317`）、SQLite 数据库、群聊与任务调度、附件、托管账号、所有 Worker 的 WebSocket 接入点 `/worker` |
| **Worker** | `node src/worker.mjs` | 每台参与的机器各一个：探测本机 CLI 与模型目录、在本机目录里真正运行 CLI、读写本机文件、维护本机的原生会话、执行源码同步 |
| **浏览器** | — | 只和 Home 通信 |

关键概念：

- **设备**：一个 Worker 就是一台设备（`NODE_ID` 身份保存在 Worker 数据目录）。`NODE_KIND` 为 `local`（笔记本）或 `cloud`（服务器），影响默认行为（例如 iTerm 只在 `local` 的 macOS 设备上可用）。
- **项目**：逻辑容器。每台设备各自绑定一个本地目录（项目设置 → 设备绑定），目录不跨设备共享；多设备之间靠「源码同步」保持各自绑定目录一致。
- **角色**：设备 + CLI + 模型 + 推理强度 + 提示词的组合；群聊里 `@角色` 派发任务。
- **原生会话**：CLI 自己的会话（Claude 的 `~/.claude/projects/*/<id>.jsonl`、Codex 的 `~/.codex/sessions`、Grok 的 `~/.grok/sessions`）。会话页可以在页面上接管、排队发送消息，或在 iTerm 里继续；会话的工作目录固定在创建它的那台设备上。
- **项目记忆 `AGENTS.md`**：项目目录里的唯一规则文件，另有一个内容为 `@AGENTS.md` 的 `CLAUDE.md` 指针；由 Workbench 在创建项目目录时生成（不存在时才生成，绝不覆盖）。所有 CLI 原生读取它。

## 2. 环境要求（每台机器）

| 需求 | 说明 | 验证 |
| --- | --- | --- |
| Node.js `>= 22.16` | 仓库的 `.nvmrc` 固定了经测试的版本；使用 Node 内置 `node:sqlite`，启动时会打印 `ExperimentalWarning: SQLite`，属正常 | `node -v` |
| Git | Home 与 Worker 都需要 | `git --version` |
| 至少一个已登录的 CLI | Worker 机器上：`codex`、`claude`（读取 `AGENTS.md` 需 `2.1.281+`）、`grok`、`agy` 任意一个或多个；Worker 启动时及之后每 5 分钟探测一次版本、登录状态、模型目录、额度 | 以对应 CLI 自身的命令确认已登录，例如 `claude --version` |
| macOS + iTerm2（可选） | 仅当要用「在 iTerm 中打开会话」：该功能通过 `iterm2:/command?c=…` URL scheme 在本机 iTerm 执行命令；远程设备的会话通过你自己的 SSH 配置连接 | — |
| SSH（可选） | 多设备部署时用于隧道；设备接入助手也依赖它 | `ssh -V` |

## 3. 获取代码与安装依赖

```sh
git clone https://github.com/xxxxx/workbench.git
cd workbench
nvm use            # 可选，使用 .nvmrc 的版本
npm ci             # 依赖只有 opencc-js、ccusage、ws（见 package.json）
npm run check      # 语法检查
npm test           # 单元测试，应全部通过
```

应用**不会**读取 `.env` 文件。`.env.example` 只是变量清单，所有配置必须通过 shell 导出或服务管理器（systemd / launchd）注入。

## 4. 单机快速开始（Home 和 Worker 在同一台机器）

```sh
npm run dev        # 同时启动 Home 和一个本机 Worker（两个独立进程）
# 或分别：
npm start          # Home
npm run worker     # Worker（另一个终端）
```

- 打开 `http://127.0.0.1:4317`。默认只监听回环地址，不需要令牌。
- 本机 Worker 不用配置 `WORKER_TOKEN`：它会从 Home 的数据目录读取自动生成的 `.data/home/worker-token`（权限 0600）。

验证：界面右上 → 基础设置 → 设备列表里出现本机，且检测到了已登录的 CLI 和它们的模型。

## 5. 配置项（全部是环境变量）

### 5.1 Home

| 变量 | 默认 / 用途 |
| --- | --- |
| `PORT` | `4317` |
| `HOST` | `127.0.0.1`。改为非回环地址时**必须**同时设置 `API_TOKEN`，否则拒绝启动；Node 不终止 TLS，对外请放在 HTTPS 反向代理之后 |
| `DATA_DIR` | `.data/home`：SQLite、附件、`worker-token`、托管账号密钥 |
| `API_TOKEN` | 浏览器访问令牌，非回环监听时必填 |
| `WORKER_TOKEN` | 所有 Worker 共用的注册令牌；不设则自动生成到 `.data/home/worker-token` |
| `TOKEN_USAGE_TIMEZONE` | token 统计的日界线时区，默认系统时区 |

### 5.2 Worker

| 变量 | 默认 / 用途 |
| --- | --- |
| `HOME_URL` | `ws://127.0.0.1:4317/worker`；远程 Home 用 `wss://xxxxx/worker`，或经隧道的 `ws://127.0.0.1:<本地端口>/worker` |
| `WORKER_TOKEN` | 必须与 Home 一致；与 Home 同机时可省略 |
| `WORKER_ROOTS` | 允许放项目和会话目录的根目录列表，用系统路径分隔符分隔（Linux/macOS 为 `:`）。Worker 只会在这些根之下读写 |
| `WORKSPACE_ROOT` | 新建原生会话的默认目录所在的根（默认取 `WORKER_ROOTS` 第一个）；不关联项目的会话落在 `<WORKSPACE_ROOT>/native-sessions` |
| `WORKER_DATA_DIR` | `.data/worker`：SQLite、设备身份、发件箱、同步缓存。**每个 Worker 一个目录，绝不共用，绝不清空** |
| `WORKER_CONCURRENCY` | 同时运行的 CLI 数，默认 `2` |
| `NODE_NAME` | 界面显示名，默认主机名 |
| `NODE_KIND` | `local` 或 `cloud`；Linux 默认 `cloud`，其他系统默认 `local` |
| `NODE_ID` | 设备身份；通常不用设，首次启动自动生成并存入数据目录 |
| `CODEX_BIN` / `CLAUDE_BIN` / `GROK_BIN` / `AGY_BIN` | CLI 可执行文件的绝对路径；服务管理器里的 `PATH` 往往和交互式 shell 不同，建议显式设置，或把包含它们的目录加进服务的 `PATH` |
| `CLAUDE_MODEL_ID` | 当 `CLAUDE_BIN` 指向兼容 Anthropic 的启动脚本时，对外声明的模型 ID |
| `CLAUDE_CONFIG_DIR` | 包装器改变了 `HOME` 时，指向 Claude 实际的配置目录，否则原生会话历史找不到 |
| `REMOTE_DESKTOP_URL`、`CCUSAGE_BIN` | 可选，见 `src/worker.mjs`、`src/token-usage.mjs` |

可选功能：`WB_DISCUSSION_PREVIEW=1` + `WB_DISCUSSION_VALIDATED_CONFIGS`（JSON 数组）开启同行讨论预览；`WECHAT_CLIENT`、`WECHAT_CLIENT_CONFIG` 配置微信通道。

## 6. 多设备部署

原则：**一台常开机器跑 Home，其余机器各跑一个 Worker；每台机器只跑一个 Worker。** Worker 永远是主动连向 Home 的 WebSocket 客户端，所以只需要让 Worker 能访问到 Home 的端口。三种常见连法：

**A. Home 有 HTTPS 反向代理**（推荐长期使用）
Worker 设 `HOME_URL=wss://xxxxx/worker`。代理需要支持 WebSocket 升级。

**B. Home 在服务器，Worker 在别的机器：从 Worker 机器正向隧道**

```sh
# Worker 机器
ssh -NT -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L 14317:127.0.0.1:4317 xxxxx@xxxxx
export HOME_URL=ws://127.0.0.1:14317/worker
```

**C. Home 在笔记本（macOS），Worker 在云服务器：从笔记本反向隧道**

```sh
# 笔记本（Home 所在机器）
ssh -NT -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -R 14320:127.0.0.1:4317 xxxxx@xxxxx
# 服务器上的 Worker
export HOME_URL=ws://127.0.0.1:14320/worker
```

每台 Worker 机器的步骤：

1. 克隆**同一版本**的代码，`npm ci`；安装并登录要用的 CLI。
2. 从 Home 机器拿到 Worker 令牌：`cat .data/home/worker-token`（或你设置的 `WORKER_TOKEN`）。
3. 导出变量并启动：

   ```sh
   export HOME_URL=...                       # 见上面三种连法
   read -r -s WORKER_TOKEN && export WORKER_TOKEN
   export NODE_NAME=xxxxx
   export NODE_KIND=cloud                    # 服务器；笔记本用 local
   export WORKER_ROOTS=/srv/agent-projects   # 示例：项目与会话目录的根
   export WORKSPACE_ROOT=/srv/agent-projects
   export WORKER_DATA_DIR=/opt/agent-workbench/.data/worker
   npm run worker
   ```

4. 验证：Home 界面 → 基础设置 → 该设备在线，CLI 被检测到。

## 7. 作为系统服务运行（Linux，systemd 示例）

Worker（服务器）：

```ini
# /etc/systemd/system/agent-workbench-worker.service
[Unit]
Description=Agent Workbench Worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=xxxxx
Group=xxxxx
WorkingDirectory=/opt/agent-workbench
EnvironmentFile=/etc/agent-workbench-worker.env     # 放 WORKER_TOKEN 等敏感值，权限 0600
Environment=PATH=/home/xxxxx/.local/bin:/opt/node/bin:/usr/local/bin:/usr/bin:/bin   # 必须包含 node 和各 CLI
Environment=HOME=/home/xxxxx
Environment=HOME_URL=ws://127.0.0.1:14320/worker
Environment=WORKER_DATA_DIR=/opt/agent-workbench/.data/worker
Environment=WORKER_ROOTS=/srv/agent-projects
Environment=WORKSPACE_ROOT=/srv/agent-projects
Environment=WORKER_CONCURRENCY=1
Environment=NODE_KIND=cloud
Environment=NODE_NAME=xxxxx
ExecStart=/opt/node/bin/node /opt/agent-workbench/src/worker.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Home 的单元同理：`ExecStart=… src/home.mjs`，变量换成 `PORT`、`DATA_DIR`、`WORKER_TOKEN`，以及对外时的 `HOST` + `API_TOKEN`。隧道也建议做成服务（`ExecStart=/usr/bin/ssh -NT … -R …`，`Restart=always`）。

```sh
systemctl daemon-reload && systemctl enable --now agent-workbench-worker
journalctl -u agent-workbench-worker -f          # 看日志
```

`HOME` 必须指向运行用户的主目录：CLI 的登录态和原生会话历史都在那里。

## 8. 界面内的首次配置顺序

1. **基础设置**：确认每台设备在线、CLI 与模型已检测；语言切换在这里。
2. **托管账号**（可选）：填入 GitHub / Gitee 的最小权限令牌（仓库内容读写、PR 读写），保存在 Home 数据目录的私有文件里。角色推送代码、会话页的 Git 凭据都来自这里，令牌只会发给对应仓库的远程地址。
3. **创建项目**：选在线设备、已登录的 CLI 和模型作为项目主管，填项目文件夹名。Workbench 在该设备上创建目录，并生成 `AGENTS.md` 与 `CLAUDE.md`。
4. **设备绑定**：项目设置里，为每台要参与的设备绑定项目目录（不存在会创建）。多设备间通过源码同步保持一致：整个绑定目录都在同步范围（含 `outputs/`、`artifacts/`、`.workbench/docs`），代码仓库按 Git 基线同步，`.git` 本身不传，双方同时改同一文件会进入冲突列表由人处理。
5. **角色**：按设备 / CLI / 模型 / 强度 / 提示词定义角色；在群聊里 `@角色` 派发；排队中的消息显示在输入框上方的队列里，可「引导」（中断当前并立即执行）或取消。
6. **会话页**：新建原生会话时选择设备、CLI、项目（可选）和工作目录。选了项目，目录为 `<项目目录>/native-sessions/<会话标题>`，并在打开时创建；不选则为 `<WORKSPACE_ROOT>/native-sessions`。「允许全部操作」对应 CLI 的跳过权限确认。可以「在页面上打开」（Worker 后台启动 CLI）或「准备打开 iTerm」。页面接管后：回复进行中按钮为「停止」，输入文字后变回「发送」并入队；切换到 iTerm 或切回页面都通过弹窗完成确认和进度。右栏：概述（接入、模型、思考深度、上下文与压缩、额度）、文件（回复中提到的、本会话改动的、产物目录、项目产物）、资源（仓库、AGENTS.md、工作目录、会话 ID）。
7. **AGENTS.md**：项目的唯一规则文件。会话页「资源」里可直接编辑该目录实际使用的那份（向上查找到项目根为止）；不存在可一键创建。

## 9. 数据与安全边界

| 路径 | 内容 |
| --- | --- |
| `.data/home/`（`DATA_DIR`） | Home 的 SQLite、附件、`worker-token`（0600）、托管账号密钥 |
| `.data/worker/`（`WORKER_DATA_DIR`） | Worker 的 SQLite、设备身份、发件箱、同步缓存与 blob |
| `<项目目录>/.worktrees/` | 每次运行与项目基线的 Git worktree |
| `<项目目录>/AGENTS.md`、`CLAUDE.md` | 项目规则与关键决策 |
| `<项目目录>/.workbench/` | 交接记录、临时附件、共享文档 |
| `<项目目录>/native-sessions/<标题>/` | 关联项目的原生会话工作目录 |

- 以上路径都不应提交到仓库。
- Home 默认只听回环；对外必须 `API_TOKEN` + HTTPS 代理。
- Worker 只在 `WORKER_ROOTS` 之内读写文件；页面里的文件预览、目录浏览、AGENTS.md 编辑都受此限制。
- 群聊角色在某个目录执行时，不允许在同一目录树再开原生 CLI（避免两个 Agent 改同一棵树）；两个原生会话之间可以共用目录，由使用者自行把握。

## 10. 升级与回滚

- 基础设置 → 配置说明 → 「检查更新」只对比 GitHub `main`（结果缓存一分钟），**不下载、不安装、不重启**。
- 单机升级：`git pull && npm ci && npm test`，然后重启 Home 与 Worker。数据目录保持不动。
- 多机升级建议按「发布目录」方式：把每个版本放到独立目录（例如 `/opt/agent-workbench-releases/<日期-提交>`），用 systemd drop-in 覆盖 `ExecStart` 指向新目录，重启服务；回滚就是把 `ExecStart` 指回上一个目录再重启。Home 与所有 Worker 应保持同一版本。
- 重启 Worker 不会丢设备身份，前提是不要清空 `WORKER_DATA_DIR`。

## 11. 故障排查

| 现象 | 先查什么 |
| --- | --- |
| 设备显示离线 | Worker 日志里的连接错误；`HOME_URL` 是否可达（隧道是否还活着）；`WORKER_TOKEN` 是否与 Home 一致 |
| CLI 未检测到 | 服务里的 `PATH` 是否包含 CLI；必要时设 `*_BIN` 绝对路径；`HOME` 是否是登录过 CLI 的那个用户主目录 |
| 新建会话提示「会话已被占用」 | 同一原生会话已在别处打开，或群聊角色正在该目录执行 |
| 会话历史为空 / 找不到 | Claude 的 `CLAUDE_CONFIG_DIR` 是否正确；会话只能在创建它的设备上打开 |
| `AGENTS.md` 没被 Claude 读取 | Claude Code 需 `2.1.281+`；项目目录应同时有 `CLAUDE.md` 指针 |
| 额度显示「未知」 | 该 CLI 不提供额度，或 Worker 还没完成探测（每 5 分钟一次） |
| 启动时的 `ExperimentalWarning: SQLite` | 正常，来自 `node:sqlite` |
| 端口被占用 | 改 `PORT`，或停掉旧进程；一台机器只跑一个 Home、一个 Worker |

## 12. 完成后的检查清单（AI 助手逐项确认）

- [ ] `node -v` ≥ 22.16，`npm test` 全部通过
- [ ] Home 可访问；非回环监听时已设 `API_TOKEN` 且走 HTTPS
- [ ] 每台 Worker：在线、CLI 与模型被检测、`WORKER_ROOTS` / `WORKER_DATA_DIR` 各自独立
- [ ] 隧道或反向代理已做成常驻服务
- [ ] 至少一个项目：主管角色可用，每台参与设备已绑定目录，`AGENTS.md` 已生成
- [ ] 群聊 `@角色` 能派发并收到回复；会话页能新建、接管、切换 iTerm
- [ ] 所有令牌只存在于服务环境文件或 Home 数据目录，仓库工作区 `git status` 干净
