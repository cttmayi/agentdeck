# 编排写法（material/orchestration）

给「编排生成者」。**先读本页，再读 `principles.md`，最后读 `api.md`。**

| 文件 | 什么时候读 |
|---|---|
| `principles.md` | **动笔前后各读一遍**：生成编排的六条硬原则（交付物落盘、不用 return、失败可见、跨次状态、把关判事实、别混过程说明）+ 一条自检六问 |
| `api.md` | 动笔前必读：六个原语的签名与语义、Reply 形状、四种常见写法、六个坑 |
| `examples/接力.js` | 多步接力（取数 → 成稿） |
| `examples/机器把关.js` | 把关者带判定函数的 `loop` |
| `examples/人把关.js` | 人拍板的 `loop`（`reuseOutput`，不重跑刚审过的那版） |
| `examples/并行.js` | `parallel` 返回数组 |
| `changelog.md` | 觉得"怎么写都跑不起来"时看：这一版改了什么、旧写法怎么改 |

`agents/` 下的人怎么写、`skills/` 下的技能怎么写，**不在这里**：同一个 `material/` 里另有
`material/agent/`（岗位卡五字段、边界清单、`agent.json` 字段）与 `material/skill/`（`SKILL.md`
格式、frontmatter 硬要求、入库体检项）。写内建人之前先读那两个。

版本：见 `api-version.json`。**这一份是平台每次对话前覆盖写入的**，改的是仓库里的
`docs/material/orchestration/`——你手上这份永远是当前版本。
