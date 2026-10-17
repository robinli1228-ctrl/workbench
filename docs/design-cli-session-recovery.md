# CLI 会话占用恢复

状态：代码已实现并通过独立审核、隔离验收及发布核对。忙碌旧 CLI 的中断仍需用户确认。本文是本功能的实施契约，不改变终端人工接管、跨 CLI 交接或项目配置。

## 行为

| 核验结果 | 处理 |
| --- | --- |
| Worker 持有的空闲可复用进程 | 复用原进程，不重启 |
| 已证明属于原会话的空闲残留进程 | 自动退出，确认退出后恢复同一原生会话 |
| 已证明属于原会话，但正在工作或无法确认空闲 | 原任务排队，提供用户确认入口 |
| PID 已被其他启动实例复用 | 仅清理过期占用事实，不发送信号 |
| 身份、进程组或退出情况无法核实 | 保留等待与具体原因，不允许强制停止或启动第二个驱动 |

普通完成的 Codex、Claude、Agy 继续保留五分钟：新任务取用时取消旧计时，新一轮结束重新计时；配置不兼容或容量回收可以提前退出。Grok 保持现有单轮进程加精确会话 ID 恢复，不新增常驻模式。

## 身份与退出

Worker 在受管启动时记录 PID、操作系统启动标识、运行用户及项目／角色／平台会话／原生会话关联。macOS、Linux 新启动的受管 CLI 使用独立 POSIX 进程组；退出时逐个重查身份，覆盖工具子进程和父退出后仍留在组内的成员。过期 `ps` 行必须与当前父进程／进程组事实再次匹配，不能据此结束复用后的无关 PID。

先请求 TERM，三秒仍未退出再对已核实实例使用 KILL，继续等待退出核验。退出中发现未知归属时保留等待。工具子进程启动证明会保存以便重试；重启后仅剩未知组成员时禁止强制结束。不能保证结束 CLI 主动脱离受管进程树／组后运行的任意外部守护进程；未知残留不被假报为已核实退出。

原生 ID、平台历史及既有审核结果均保留。进程退出事实与业务结论分开：已完成 Run 的结果不因回收被改写；旧未完成驱动被确认停止后记录已停止。

## 用户入口和恢复

在受阻任务下点击“核对 CLI 会话占用”，弹窗标题为“原会话仍有 CLI 进程”，显示设备、角色、PID 与核验状态。

> 当前无法直接接续原会话。是否停止旧 CLI，恢复原会话并执行待处理任务？此操作可能中断旧进程正在进行的工作，但不会清空会话历史。

“暂不处理”只关闭弹窗，继续等待；“停止旧 CLI 并继续”绑定当前核验快照和已有任务，不接受用户提供的任意 PID，也不创建新业务任务。点击时重新核对，进程／归属变化要求重新确认。确认并发合并，退出未能核实时仍等待。身份未知、设备离线时按钮不可用。

Home 复用原 Room/Task/Run 和设备容量规则。常规派发先查询 Worker；最后一刻发生占用竞争时，Worker 保存等待，之后重发同一 launch 命令和 Run，不重做业务派工。停止或取消在异步核验期间也生效，不能因此重新执行或泄漏容量。隔离源码任务使用与正式派发相同的独立会话绑定。

## Admission probing

Ordinary queued tasks query occupancy only after role availability, workspace, capacity and other Room admission gates pass. Each queue scan probes the first task for an identical recovery target (including project, role, device, native/platform session and prior/current Run); later tasks defer without reusing another task's result, fingerprint or consent. Different targets may progress independently. The existing five-second per-task cooldown is unchanged. Accepted launches deferred by a last-moment occupancy race retain their separate retry path, and the Worker still rechecks live ownership before launch.

A retry accepted after `CLI_RECOVERY_WAIT` emits an ordered `starting` event that explicitly clears `cliRecoveryWait`, the current recovery detail and that wait's error on both Worker and Home. This transition is limited to recovery acceptance, not every successful event. Fresh occupancy, failures and cancellation still produce their own subsequent status; existing sequence and terminal-result guards remain unchanged. Historical terminal records are not rewritten by this transition.

## 协议与边界

Home 与 Worker 通过 `cliRecovery:1` 协商。旧 Worker 保持旧契约；新 Worker 对旧 Home 不返回对方无法处理的等待／确认流程，保留保守占用拒绝及正常 Warm 复用。旧记录缺少可信启动证明时不自动补造证明，不强制结束。

本功能没有新增模型确认回合、角色提示词或平台提示词；没有清空会话、调整审核流程或开启项目自动跟进。Windows 进程身份与退出未作真实验收，不声明支持同等恢复能力。

## 验收证据

2026-10-12 隔离验收结果：

- macOS Codex：真实 Home/Worker，两轮同 PID／同原生 ID 复用；Worker 失联后的空闲残留自动回收；浏览器“暂不处理”不派发、“停止旧 CLI 并继续”退出后恢复原会话，原待处理任务仅一个 Run；恢复期间取消不执行新任务。
- Linux Claude、Grok、Agy：各自真实 Home/Worker 的正常续聊、Worker 失联后用户确认停止及同原生 ID 恢复通过；并发重复确认返回同一处理结果、原任务仅一个 Run。Claude、Agy 空闲残留自动回收通过，Grok 按原单轮恢复方式验收。
- 默认五分钟：真实 Codex 完成后持续空闲约 300 秒，进程实际退出并回报占用释放，原结果及原生 ID 保留；计时取消和重新起算另以受控 OS 进程验证。
- 兼容：真实旧 Home 配新 Worker、新 Home 配旧 Worker，各两轮同 PID／原生 ID 续聊通过。
- 22 项进程／状态边界检查覆盖 PID、用户、启动时间变化，未知身份、旧记录缺少会话证明、归属切换、旧 `ps` 行、父退出后新子进程、强制退出、停止防重启、隔离会话、确认去重和计时。

证据保存于忽略目录 `.local/cli-recovery/`，测试脚本、数据和截图不入库。未对 Windows 或任意脱离受管树／组的后台守护进程声明验收。未发布、未修改真实项目配置、未重启或终止真实任务。
