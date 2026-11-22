# 智能体写法（material/agent）

> 给「智能体生成者」。**这一包本轮只落骨架**——内容在接智能体生成者那一版时补齐（见
> `docs/design/workflow-auto-gen.md` §6、§9）。现在它只做两件事：让工作目录里的
> `material/` 结构完整（人类/agent 都不会以为"漏了"），以及钉住"资料在这里维护"这条规矩。

| 文件 | 状态 | 讲什么 |
|---|---|---|
| `shape.md` | 待补 | `agents/<名字>/` 的存储形状：`agent.json` 字段、`instructions.md`、`skills/` |
| `norms.md` | 待补 | 岗位卡写法：目标 / **边界段（必填）** / 交付物 / 判定口径 |

现有的规则来源（接的时候从这里搬，不另写）：
`catalog/platform-skills/agent-design-norms/SKILL.md`、`catalog/platform-skills/boundary-checklist/SKILL.md`、
`docs/design/storage-layout.md`（§3 智能体目录形状）。
