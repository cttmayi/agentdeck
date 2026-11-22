# 「生成资料」的唯一来源（material）

> 2026-11。使用者定调：
>
> 「material 也在代码中**单独目录维护**，不要分散在各个地方，最好和 docs 链接起来，
> 直接作为文档的一部分，**人和 LLM 看到的是一份资料**。」

这里就是那份资料的**唯一手写来源**：人在这里读、在 `docs/` 的链接里读；
平台在起「生成类」对话时把它**原样复制**进工作目录的 `material/`，agent 读的是同一批文件。

## 目录

| 包 | 给谁看 | 里面是什么 |
|---|---|---|
| `orchestration/` | 编排生成者 | 编排原语的当前写法（`api.md`）、四个例子、变更记录 |
| `agent/` | 智能体生成者 + **编排生成者**（它自己写内建智能体） | 智能体的存储形状、岗位卡写法 |
| `skill/` | 技能起草者 + **写内建技能的编排 / 智能体生成者** | `SKILL.md` 格式、入库前体检项 |

一个生成者**可以要几包**（D259）：它写什么，就该读到什么。编排生成者 = `orchestration`
+ `agent` + `skill`；智能体生成者 = `agent` + `skill`；技能起草者 = `skill`
（它的资料随素材落在**起草 run** 的 `material/` 里，不落聊天目录）。

每个包一个 `README.md`：**先读它**（版本、文件清单、"怎么用"）。索引（顶层这份）由平台每次落盘时
按"这次是哪一类生成者"填一行。

## 三条硬规矩

1. **不散落**：这些内容**不许**再写进 `builtin-drafter.ts` 的身份文本、也不许在别处手抄一份。
   身份的职责只剩"问什么"和"先读 `material/…/README.md`"。
2. **唯一手写源就是这里**：运行时要用的副本是**同步产物**——
   `node tools/material/sync.mjs` 把本目录原样复制到 `apps/daemon/catalog/material/`，
   `tests/material-sync.test.ts` 逐字节比对（不一样就红）。与 `tools/ui-demo/sync-demo.mjs`
   同一条规矩：仓库里只有一份手写的资料。
3. **能和代码对齐的要对齐**：`orchestration/api.md` 与 `packages/orchestration/src/primitives.ts`
   是同一件事的两种说法（签名与语义）；改了原语就要改这里，改完跑同步脚本。

## 和 `docs/reference/` 的关系

- `docs/reference/orchestration-api.md` 是**设计规格**（为什么这么设计、每个原语的契约细节、与主流方案对比）；
- `material/orchestration/api.md` 是**给 agent 的playbook**（怎么写出能跑的代码：签名、形状、常见坑、例子）；
- playbook 里的每条规则都应能在规格里找到出处；两边冲突时以**规格**为准，并按它修 playbook。

## 怎么更新

```bash
# 改 docs/material/… 之后
node tools/material/sync.mjs
pnpm run check      # 里面有 material-sync 判据
```

不需要重启 daemon：资料是**每次起生成类对话/每轮开始**时重新落盘的（覆盖写），
所以 API 改了之后下一轮 agent 读到的就是新版。
