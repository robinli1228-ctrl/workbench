[English](README.md) | 简体中文

# 文档索引

| 文档 | 用途 | 状态 |
| --- | --- | --- |
| [OPERATING-GUIDE](OPERATING-GUIDE.zh-CN.md) | 发布、配置、单机与多服务器运行、贡献流程、脱敏检查清单 | 当前 |
| [ARCHITECTURE](ARCHITECTURE.md)（英文） | 当前代码架构、接口、数据与实现边界 | 当前。只描述代码实际所做的事 |
| [PRD](PRD.md)（英文） | 产品目标、阶段范围、业务规则与验收方向 | 范围参考。并非全部已实现 |
| [design-coordination](design-coordination.md)（英文） | 主管、模板、自定义角色、可选计划与固定版本交接 | 设计。部分已实现；见 ARCHITECTURE |
| [design-local-supervisor](design-local-supervisor.md)（英文） | 项目主管、多仓库设置、设备与账号配置助手 | 已在当前代码中实现 |
| [design-supervisor-timers](design-supervisor-timers.md)（英文） | `wb timer` 定时任务与低成本进度巡检 | 已在当前代码中实现 |
| [design-session-handoff](design-session-handoff.md)（英文） | 受控的跨设备角色会话交接 | 方案。尚未实现 |

建议先读 README，再读 ARCHITECTURE。需要完整的产品范围时再读 PRD。ARCHITECTURE 只描述实际代码，从不把计划当作功能。设计文档可能描述预期行为；若与代码不一致，以代码为准。
