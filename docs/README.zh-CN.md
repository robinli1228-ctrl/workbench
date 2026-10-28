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
| [design-supervisor-proactive-followup](design-supervisor-proactive-followup.md) | 群聊静默后由主管直接跟进，默认十分钟；IM 通知用户协助为后续扩展 | 已开发并通过隔离测试，未部署、未启用真实项目 |
| [plan-supervisor-proactive-followup](plan-supervisor-proactive-followup.md) | 主管静默跟进的代码落点、持久去重、安静结束及验收 | 已直接实施并独立审核，不含发布 |
| [design-session-handoff](design-session-handoff.md)（英文） | 受控的跨设备角色会话交接 | 方案。尚未实现 |
| [design-cross-device-execution](design-cross-device-execution.md) | 跨设备快跑：固定输入、可取得基础提交、只读先行、写入观察限制及资源预算 | 用户批准的 v2.3.1 规格原文不变；仅 P1 按计划实施，后续阶段仍为设计，候选性能目标不代表生产承诺 |
| [plan-cross-device-execution-p1](plan-cross-device-execution-p1.md) | 首批 Q/F：注册来源、安全回包及持久请求重放 | P1 已实现并完成独立审核及隔离真实 Mac/Linux/浏览器验证，已整合到待发布分支；生产部署和启用另行处理 |
| [design-cli-session-recovery](design-cli-session-recovery.md) | 空闲占用回收、用户确认及同一原生会话恢复 | 已开发并通过隔离验收；未部署 |

建议先读 README，再读 ARCHITECTURE。需要完整的产品范围时再读 PRD。ARCHITECTURE 只描述实际代码，从不把计划当作功能。设计文档可能描述预期行为；若与代码不一致，以代码为准。
