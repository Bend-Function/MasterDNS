# 多云轮换与外部 Agent 交付索引

设计已获用户批准，Agent 独立仓库与两个开发分支已建立。本文件定位分工和执行顺序，不替代各任务的测试与验收。

| 项目 | 位置 | 开发分支 | 实施计划 |
| --- | --- | --- | --- |
| MasterDNS | `/Users/funcma/Project/MasterDNS` | `codex/multicloud-ip-rotation` | `docs/superpowers/plans/2026-09-15-multicloud-platform.md` |
| MasterDNS-Agent | `/Users/funcma/Project/MasterDNS-Agent` | `codex/external-health-agent` | `docs/superpowers/plans/2026-09-15-external-health-agent.md` |

平台共 12 个任务，Agent 共 7 个任务。先建立协议 P1，然后完成平台账号/清单 P2–P4 和 Agent 协议/探测 A1–A5。平台 P5–P7 与 Agent A6 打通外部监测后，再执行平台 P8–P10 换址闭环。最后完成 UI/通知 P11、独立安装/发布 A7 和完整联调 P12。

每个仓库独立构建、提交和发布；共享契约以版本化文件与契约测试同步，不能通过兄弟目录相对导入复用实现。平台构建不需要 Go；Agent 构建不需要 Node、PostgreSQL 或云 SDK。

当前 PATH 无 Go，Agent 执行前安装工具链并记录版本。真实 AWS 验收需要独立测试资源，当前没有接入云账号或运行任何云写操作。

实施可以在当前任务内顺序完成，也可以在明确选择后使用子代理按任务执行与评审。执行阶段须使用相应 executing-plans 或 subagent-driven-development 技能，不重新讨论已批准的功能方向。

默认不合并 master、不推送、不发布、不安装到生产节点。最终交接必须包含双方分支/提交、测试结果、协议版本及真实云验收范围。
