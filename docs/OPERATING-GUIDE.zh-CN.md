[English](OPERATING-GUIDE.md) | 简体中文

# 操作指南：发布与共同迭代

本指南面向维护者和贡献者。内容包括：哪些内容是公开的、哪些内容绝不能提交、如何配置你自己的账号、模型和服务器、如何在单机或多机上运行项目、如何参与贡献，以及发布前如何对仓库做脱敏处理。

本指南中的 `xxxxx` 是字面占位符。请在本地替换为你自己的值，并且绝不要提交真实值。

## 1. 哪些内容是公开的

| 区域 | 是否公开 | 说明 |
| --- | --- | --- |
| `src/`、`bin/`、`public/` | 是 | 后端、`wb` 工具和 Web UI |
| `package.json`、`package-lock.json`、`.nvmrc` | 是 | |
| `README.md`、`AGENTS.md`、`CONTRIBUTING.md`、`LICENSE` | 是 | |
| `docs/` | 是 | 仅限设计与架构文档。不含运行日志，不含环境记录 |
| `assets/` | 是 | 图标源文件 |
| `examples/` | 是 | 最小示例项目 |
| `.env.example` | 是 | 仅含占位符 |
| `.github/` | 是 | Issue 和 PR 模板 |
| `.data/`、`.local/`、`.workbench/`、`.workbench-projects/`、`.worktrees/` | **否** | 运行时数据、数据库、令牌、临时项目 |
| `outputs/`、`reviews/` | **否** | 生成的产物和审核输出 |
| `.env`、`.env.*`（`.env.example` 除外） | **否** | |
| `node_modules/`、`*.log` | **否** | |

## 2. 绝不能提交的内容

- 数据目录：`.data/home`（Home 数据库、附件、`worker-token`、托管账号密钥）和 `.data/worker`（Worker 数据库、节点身份、已保存的 CLI 环境）。
- 任何 `.env` 文件、带有 export 的 shell 历史片段，或包含真实令牌的服务文件。
- 令牌和密钥：`API_TOKEN`、`WORKER_TOKEN`、GitHub 或 Gitee 个人访问令牌、厂商 API 密钥、SSH 私钥、微信客户端令牌文件。
- 账号和登录信息：厂商账号的电子邮件地址、登录状态、`~/.codex`、`~/.claude` 或类似的 CLI 配置目录、`CLAUDE_CONFIG_DIR` 的内容。
- 服务器地址：真实 IP 地址、主机名、域名、与你的机器绑定的端口、SSH 用户名、家目录的绝对路径。
- 显示了上述任何内容的运行日志、验证记录和截图。请把它们保存在你自己的私人笔记里，不要放进 `docs/`。
- 注释、测试、提示词、测试数据或默认设置中的真实姓名、公司名或内部项目名，以及个人路径。

如果某个密钥哪怕只被提交过一次，也要轮换它。在之后的提交中删除它并不会把它从历史中清除。

## 3. 配置你自己的账号、模型和服务器

项目本身不附带任何账号。一切都在你自己的机器上于运行时配置。

### 3.1 CLI 与模型

在每台运行 Worker 的机器上安装并登录你想使用的 CLI（`codex`、`claude`、`grok`、`agy`）。Worker 会在启动时以及之后每 5 分钟探测版本、登录状态和模型目录，不发送模型请求。Claude/Codex 额度改由正常托管会话返回，不再另行查询；Grok/Agy 额度检查保持原样。缺失或过期快照不会触发额外模型对话。界面中的模型选项始终来自该设备 CLI 的模型目录。

如果某个 CLI 不在 Worker 的 `PATH` 中，请显式指定：

```sh
export CODEX_BIN=xxxxx      # codex 可执行文件的绝对路径
export CLAUDE_BIN=xxxxx
export GROK_BIN=xxxxx
export AGY_BIN=xxxxx
```

如果通过启动脚本使用兼容 Anthropic 的第三方服务，请把 `CLAUDE_BIN` 设置为该启动脚本，并把 `CLAUDE_MODEL_ID=xxxxx` 设置为该设备实际能提供的模型 ID。服务凭据应放在该设备上启动脚本的私有配置中，而不是本仓库里。如果包装器改变了 `HOME`，请把 `CLAUDE_CONFIG_DIR=xxxxx` 设置为 CLI 实际使用的目录，以便恢复原生会话。

### 3.2 在多个账号间分配工作

角色就是设备、CLI、模型、推理强度和提示词的一种组合。角色定义修改影响新消息，正在运行的任务保留原快照。同设备更换 Codex/Grok 时，保存按钮变为“交接并切换”：等已接任务完成，原 CLI 留交接，新 CLI 核对，确认进程退出后才保存。不要通过手动清空、重建角色或重置会话绕过流程。提交前关闭或取消仅停止准备工作，原配置不变；设备断线时会等待进程状态确认，不把超时说成已回退。提交后尚未派发的任务使用独立记录的新执行绑定，历史快照不改。其他 CLI 或旧 Worker 尚未通过验收时会明确阻止切换。可以结合 token 统计和角色额度调整分工。

### 3.3 托管账号

GitHub 和 Gitee 令牌在基础设置对话框中填写，并保存在 Home 数据目录下的私有文件中。请使用权限范围最小的令牌（`xxxxx`），并且绝不要把它们粘贴到群聊里。

## 4. 运行项目

### 4.1 单节点

```sh
npm install
npm run dev          # Home 和 Worker 作为两个进程，http://127.0.0.1:4317
```

或分别启动：

```sh
npm start            # Home
npm run worker       # Worker，在另一个终端中
```

默认只监听本机回环地址。同一台机器上的 Worker 会自动读取 Home 生成的 `.data/home/worker-token`。

如需运行第二个隔离的测试实例，请使用不同的 `PORT`、`DATA_DIR` 和 `WORKER_DATA_DIR`。绝不要让两个 Worker 使用同一个 Worker 数据目录。

### 4.2 多服务器与多设备

1. 选一台常开的机器运行 Home。让它保持在回环地址并在前面放一个 HTTPS 反向代理，或者同时设置 `HOST=xxxxx` 与 `API_TOKEN=xxxxx`（设置了非回环的 `HOST` 却没有 `API_TOKEN` 时，启动会被拒绝）。Home 不终止 TLS。
2. 生成一个强度足够的 Worker 令牌，并在 Home 上设置：`WORKER_TOKEN=xxxxx`。请像对待密码一样对待它。
3. 在其他每台机器（笔记本、Linux 服务器）上，克隆同一版本的代码，安装 Node.js（>= 22.16）、Git 和 CLI，并登录这些 CLI。
4. 在每台机器上启动 Worker：

   ```sh
   export HOME_URL=wss://xxxxx/worker        # 或通过 SSH 隧道使用 ws://127.0.0.1:14317/worker
   export WORKER_TOKEN=xxxxx
   export NODE_NAME=xxxxx
   export WORKER_ROOTS=xxxxx                 # Worker 可用于存放项目的目录
   export WORKER_DATA_DIR=xxxxx              # 私有目录，绝不在 Worker 之间共用
   npm run worker
   ```

5. 对于没有代理的小型个人环境，可以在 Worker 机器上通过 SSH 转发 Home 端口：

   ```sh
   ssh -NT -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L 14317:127.0.0.1:4317 xxxxx@xxxxx
   ```

6. 在基础设置中确认设备在线且其 CLI 已被检测到。也可以使用设备接入助手（SSH 检查、远程安装 Worker 和反向隧道）；它要求远程机器上有 Node.js >= 22.16、npm 和 Git，并且不会安装开机自启服务。
7. 在项目设置中，为每台要参与的设备绑定项目目录。跨设备的代码通过显式的、基于固定提交的 Git 交付来流转；不存在共享的可写目录。
8. 项目记忆就是项目自己的 `AGENTS.md`（新建文件夹或新关联仓库时，若不存在则按模板创建一次，并附 `CLAUDE.md` 指针；不覆盖；在 Git 仓库中只在本地提交这两个文件，不推送）。规则或关键决策变化时任何角色都可以更新。各设备上的 Claude Code 请保持 2.1.281 及以上版本，才能读取 `AGENTS.md`；`CLAUDE.md` 指针覆盖其默认模式。Workbench 不再单独保存记忆，已移除 `wb memory`。

每台机器只运行一个 Worker。重启 Worker 会保留其身份，因此不要清空它的数据目录。如果自动判断（Linux 视为 cloud）不适合你的机器，请设置 `NODE_KIND=local` 或 `cloud`。

### 4.2.1 Home 托管 SSH 隧道的配置与恢复

可选的 Home 托管反向隧道，把服务器的回环端口连接回 Home 监听端口。Worker 的 `HOME_URL` 使用服务器上的这个端口。以已登记设备的实际映射为准，不照搬其他环境的端口。反向监听只绑定回环地址，不把 Home 或 Worker 令牌暴露到公网。

隧道使用运行 Home 的系统用户的 SSH 客户端配置。在带宽受限、传输大量文本历史或同步元数据的连接上，SSH 压缩可以减少流量。这是可选配置，会消耗 CPU，不能修复丢包，也不保证媒体传输更快。先备份现有私有 SSH 配置，再仅向匹配的主机配置块添加：

```sshconfig
Host xxxxx
    Compression yes
```

主机名或地址必须与 Home 传给 SSH 的值一致。保留已有用户、密钥、端口、主机密钥校验、ProxyCommand 和网卡路由，不覆盖整份配置，也不照搬其他机器的网卡名。SSH 通常采用每个选项首次获得的值，前面的匹配块或命令行参数可能优先。以 Home 服务用户身份检查实际生效配置，不建立连接：

```sh
ssh -G xxxxx@xxxxx | awk '$1 == "compression" { print }'
```

应输出 `compression yes`。该配置影响**此主机后续新建的 SSH 连接**，不只影响 Workbench；已经建立的隧道不会改变。启用连接复用时可能仍使用旧的主连接，因此配置检查不等于运行中的传输已启用压缩。不要为使配置生效而停止无关的 SSH 主连接或共享连接。

托管通道缓慢或超时时：

1. 对比本机 Home 的 `/healthz` 与服务器经已配置回环转发访问同一入口的结果。仅有 Worker 心跳或端口监听，不代表历史和同步请求正常。先检查传输量、重传和排队字节，再判断是否是 Home 故障或需要重启服务；大载荷共享 SSH 传输，会拖慢小请求。
2. 重连前检查两端 Runs、原生请求、队列实际执行、终端及驻留 CLI 占用、同步写入预约。会话不可见、CPU 低或旧请求已完成，都不能证明空闲；有新请求要重新核对。用户明确允许停止某条请求时，通过受支持的释放或停止操作处理，保留历史和文件并确认进程实际退出；如实记为中断，不记为成功。
3. Home 托管隧道优先使用设备详情的“重新连接 Home”。它会拒绝繁忙或无法核实的设备，只替换自身持有的反向隧道。被拒绝不等于恢复成功，不得清数据库状态、关闭同步或强杀进程来通过门禁。另行获授权的运维恢复必须核对准确的 SSH PID、属主、父进程、启动身份、目标和完整转发参数，并取得独立的远端活动证据；不要批量终止 SSH，也不要动携带其他转发的连接。
4. 保留数据库、原生历史、已保存文件和冲突副本。只调整隧道不要求重启 Home 或任一 Worker，也不要求修改旧服务禁用状态或重建无关的桌面、网页中转通道。
5. 验证新的 Worker 连接及心跳、多次转发健康请求、真实远程历史和更早历史翻页。仅在已启用的同步范围使用获准的小文件，通过原有同步流程验证**两个方向**并对比哈希；不能手动复制到目标端来制造通过。核对其他服务和转发的进程身份未变，观察 CPU、内存，记录剩余延迟。环境专属证据放在私有 `.local/`，不要写入本指南。

需要回退压缩时，只恢复该主机块中原来的值（或移除此次新增项），重新核对 `ssh -G`，在再次确认安全的窗口仅重连托管隧道。不要覆盖其他配置或转发。压缩能减轻传输压力，但大页历史仍可能缓慢，并发重载时仍可能超时。

## 5. 贡献流程

1. Fork 仓库，并从 `main` 创建分支：`feature/<主题>`、`fix/<主题>` 或 `docs/<主题>`。
2. 保持每次改动聚焦。不要把重构与行为变更混在一起。
3. 在本地运行下面的检查。
4. 使用模板发起 pull request。说明改了什么、为什么改、如何验证，以及哪些部分你无法验证（例如“未在真实的第二台设备上测试”）。
5. 维护者会从正确性、范围和脱敏三方面审查。推荐使用 squash 或 rebase 合并，以保持历史线性。

给维护者的分支保护建议：要求一次评审；如果加了 CI，则要求 `npm run check` 任务通过；禁止对 `main` 强制推送。

### 5.1 代码风格

- 使用 Node.js 22 上的 ES 模块 JavaScript。不用 TypeScript，Web UI 无构建步骤。
- 优先扩展现有的 Home、Worker、Room 和运行时适配器代码，而不是新增第二套控制面。
- 保持任务状态、运行状态和 Worker 在线状态相互独立。进程退出并不代表工作已被验收。
- 设备之间不共享可写目录，正式代码交付仍使用 Git 提交。可选的源码同步使用各设备独立的仓库目录，不会自动提交、推送或部署。在“资源 → 源码同步”选择仓库和设备，预览实际目录后启用确认的范围，再使用“立即同步”或角色的 `wb sync request`；单纯保存文件不会上传。冲突时检查保留版本并指派负责人；修复候选经独立检查、明确接受后才分发。更改范围前先停用旧配置。安装软件不启用业务项目，请先核对[设计中的验收边界](design-source-sync.md)。
- 面向用户的文本、注释和文档使用英文。不要硬编码个人路径、主机名或账号名。
- 准确报告每个功能的状态：代码已编写、已提交、已部署、已自动检查、已人工验证是不同的状态。

### 5.2 检查

```sh
npm ci
npm run check        # 对每个源文件执行 node --check；仅检查语法
git diff --check     # 空白字符错误
```

`npm run check` 在 `package.json` 中显式列出文件。当你在 `src/` 或 `public/` 下新增源文件时，也要把它加入 `check` 脚本。该脚本只是语法检查，不会运行行为测试。对于涉及 Home、Worker、运行时、浏览器 UI 或跨机器行为的改动，还应在隔离的项目中真实运行一遍，并把结果写进 pull request 描述。

## 6. 扩展项目

### 6.1 添加新角色（模板）

角色是在运行时按项目创建的。若要提供新的起始模板，请在 `src/default-roles.mjs` 中添加一项：

```js
{
  key: 'security-reviewer',
  name: 'Security Reviewer',
  mode: 'workspace-write',
  modelHint: 'Use a strong model for critical review',
  instructions: `You are an independent security reviewer. ...`
}
```

模板在用户创建角色时被复制，不会自动创建席位。请让指令文本保持通用，不含个人或组织信息。

### 6.2 添加模型或 CLI 适配器

已支持 CLI 的新模型无需改代码：只要 CLI 列出它，它就会出现。新增一个 CLI（运行时）会涉及以下位置：

1. `src/runtime-probe.mjs`：添加 `inspectXxx()` 函数，在不创建会话、不发送模型请求的前提下报告版本、登录状态、模型目录和可选的额度，并把它加入 `inspectRuntimes()`。只有真正接通的适配器才标记为 `supported: true`。
2. `src/worker.mjs`：把可执行文件（`XXX_BIN`）加入 binaries 映射，并把运行时名称加入运行时类型的允许列表。
3. 会话类：要么扩展 `src/cli-print-session.mjs`（适用于像 Claude Code、Grok Build 和 Antigravity 那样提供非交互流式模式的 CLI），要么像 `src/codex.mjs` 一样编写专用的类。它必须发出通用的事件类型，支持停止，并（尽可能）支持按原生会话 ID 恢复。
4. `public/`：在列出运行时的位置添加图标和标签。
5. 在 `README.md` 和 `.env.example` 中记录新变量，并在 `docs/ARCHITECTURE.md` 中说明其限制（例如没有逐步审批）。

在某个 CLI 经过启动、输入、停止、事件和结果交付的完整真实运行之前，不要宣称它可执行。

## 7. Issue 与 pull request 模板

模板位于 `.github/`：

- `.github/ISSUE_TEMPLATE/bug_report.md`
- `.github/ISSUE_TEMPLATE/feature_request.md`
- `.github/ISSUE_TEMPLATE/config.yml`
- `.github/PULL_REQUEST_TEMPLATE.md`

提交 issue 时，绝不要粘贴令牌、真实服务器地址、账号名或未脱敏的日志。请将它们替换为 `xxxxx`。

## 8. 发布前脱敏检查清单

每次公开推送之前，都在发布副本上执行这份清单；合并大型贡献之后也要再执行一次。

1. **没有运行时数据**：`.data/`、`.local/`、`.workbench/`、`.workbench-projects/`、`.worktrees/`、`outputs/`、`reviews/`、`node_modules/` 和日志都不在工作树中，并且已列入 `.gitignore`。
2. **文档**：`docs/` 只包含设计与架构文档。没有验证记录、部署日志、为特定环境撰写的交接记录，也没有个人通道的设置说明。
3. **密钥与环境扫描**：

   ```sh
   grep -rnE '([0-9]{1,3}\.){3}[0-9]{1,3}|/Users/|/home/|@[a-z0-9.-]+\.[a-z]+|token|secret|password|ssh' . \
     --exclude-dir=node_modules --exclude-dir=.git --exclude=package-lock.json
   ```

   检查每一处命中。`API_TOKEN` 这样的变量名和普通词汇没有问题；真实的值、地址和路径则不行。
4. **语言**：如果项目只使用英文，`grep -rnP '[\x{4e00}-\x{9fff}]' . --exclude-dir=node_modules --exclude-dir=.git` 应当没有输出。
5. **名称**：搜索真实姓名、用户名、电子邮件地址、公司名或内部项目名，以及设备昵称。替换为 `xxxxx` 或中性的说法。
6. **默认值**：检查代码中的默认值（端口、时区、客户端名称、类似 `~/.config/...` 文件的路径）是否含有个人信息，并使其可配置或中性化。
7. **Git 历史**：从全新的仓库（`git init`）发布，或用 `git log -p` 确认历史中从未出现过密钥。如果出现过，请轮换密钥，并重写或重建历史。
8. **依赖**：`npm ci` 能在干净的克隆上成功运行，并且已提交 `package-lock.json`。
9. **检查**：`npm run check` 和 `git diff --check` 均通过。
10. **许可证与元数据**：存在 `LICENSE`，`package.json` 中没有你不想公开的私有 URL 或作者信息。
11. **截图**：不要有显示真实主机、账号、用户名或项目名的截图。
12. **最后通读**：以匿名访客身份打开仓库页面，从头到尾读一遍 README。
