# 智能体目录化（D111，2026-11 设计定稿）

> 结论先行：**一个智能体 = 一个目录**——`<dataDir>/agents/<id>/`，与 `skills/`、
> `skills-mine/` 并列（使用者的决定："放 agents 目录下 和 skills 目录并列"）。
> 内置与自建**同形**；技能分两类、**没有镜像**；指令**组装前**落盘、运行时拼装。

## 1. 为什么

使用者的原话："其实我的想法就是内置智能体和自建智能体的形式要是一样的，保持一致。"

JSONL 记录（`workspaces/<wsId>/log/agent.jsonl`）做智能体的载体有两处别扭：

- **内置与自建两套形态**：内置的身份是代码常量（对账写盘），自建是一条可编辑的记录；
  于是"查看内置"要走一套只读/恢复默认的专门逻辑，而它俩本该是同一件事。
- **JSONL 不是给人看的**：指令正文是智能体最重要的内容（模型照它干活），
  却埋在一条日志记录里，不能直接打开读、改，也没有"这一个智能体还带着哪些文件"
  的直觉（技能、支持文件、将来的人可读产物）。

改成目录之后，两者都消掉了：内置智能体生成出来也是 `agents/<id>/` 一个目录，
区别只在 `agent.json` 里的 `builtin` 标记。

## 2. 目录形态

```
<dataDir>/agents/<id>/
  agent.json          结构化资讯（不含指令正文；builtin / role / skillIds / env / …）
  instructions.md     指令**组装前**正文
  memory.jsonl        这个智能体的**记忆**（D112：记忆 = 智能体自己的）
  SKILL/<slug>/SKILL.md  这个智能体**独有的**技能（文件资产）
```

- `agent.json` **不含 `instructions`**（指令在 md 里；`readAgentDir` 读回时把两者拼回
  一条 `Agent`，`instructions` 恒为 md 的组装前正文）。
- `instructions.md` 存的是**组装前**正文：内置 = 身份块（平台守则运行时拼），
  自建 = 全文。为什么组装前：人打开目录看到的就是"智能体自己的话"；
  平台守则是平台的（改守则不该改写每一条内置的记录）。
- **记忆也住在目录里**（D112，2026-11 使用者纠正："记忆应该是智能体自己的，不是
  智能体之间也共享"）：老存储是 workspace 级 `log/memory.jsonl`（记录里有
  `agentId` 字段），于是**删智能体不删记忆**（留下孤儿）。迁进目录之后
  "记忆跟着智能体走"才成立：删智能体连目录一起删、记忆一起没；注入 / 整理 /
  手写全部按 `agents/<id>/memory.jsonl` 读。`listMemoryEntries` 不给 `agentId`
  时跨所有目录汇总（列表页 `memoryCount` 的唯一调用点）。
- 独有技能是**文件**：没有库记录、不进技能页、不可卸载；删智能体连目录一起删。

## 3. 组装前 vs 组装后（effectiveInstructions）

`effectiveInstructions(agent)`（daemon 读取端，唯一拼装点）：

| agent 状态 | 返回 |
|---|---|
| `instructionsAssembled === true` | 原样（老记录/迁移：存的已是组装后全文） |
| `builtin === true` | `withConduct(body)`（身份块 + 平台守则） |
| 其它（自建） | 原样 |

- 老工作区迁移时给内置写 `instructionsAssembled: true`——否则守则会被拼**两遍**。
- 历史冻结判据（内置对账"是不是旧默认"）比较的是 `effectiveInstructions(found)`
  与 HISTORY 常量（老记录存的是组装后全文，所以 HISTORY 仍用组装后常量）。
- 接口层：`GET /api/agents` 与详情返回的 `instructions` = 组装后——界面看到的就是
  模型实际读到的。

## 4. 技能两类、没有镜像

使用者的决定（"没有镜像的说法"）：

| | 独有技能 | 共享技能 |
|---|---|---|
| 载体 | `agents/<id>/SKILL/<slug>/SKILL.md` | 技能库（`skills/<slug>/` + `skillIds` 引用） |
| 谁看得到 | 只有这个智能体 | 全工作区（技能页） |
| 卸载 | 无此概念（随智能体删除） | 技能页可卸载 |
| 注入 | 与共享走**同一条通道**（`loadAgentInjectableSkills`），同 slug 时**独有盖过共享** | 同左 |

生成者的 3 条平台技能（`agent-design-norms` / `boundary-checklist` /
`skill-eligibility`）从"动态装进技能库"改成**生成者的独有技能**（启动播种进目录，
老库里 `sourceRef: 'platform:agent-maker'` 的记录一次性搬进目录并清掉库记录）。

## 5. 迁移（老 JSONL → 目录）

- `FileStore.open()` 里做，一次性且幂等：`agent.json` 在 ⇒ 跳过；全部迁完写
  `agents/.migrated` 标记（没有标记才会重跑）。
- **老 `agent.jsonl` 迁移完成后删除**（2026-11 使用者确认："初步测试OK，可以删老
  agent.jsonl了"）；从迁移完成起不再读、不再写——读路径全部走目录，jsonl 已无读者。
- `.migrated` 标记**留着**，防"删了又复活"：万一有备份/拷贝把 jsonl 放回数据目录，
  标记挡着不再重迁（"删掉的智能体被老记录复活"的判据仍然成立）。
- 内置的老记录用 `writeLegacyAgentDir` 落盘（`instructionsAssembled: builtin === true`）。
- **老 `log/memory.jsonl`（D112）**：按 `agentId` 分进各 `agents/<id>/memory.jsonl`；
  孤儿（智能体已删）丢弃 + `onInfo` 启动日志；迁移完成后删老文件。幂等判据 =
  老文件不在就跳过（不写标记，文件被删本身就是"迁过了"的证据）。顺序在 agents
  迁移**之后**——目录要先存在。

## 6. 读取端（daemon）

- 聊天 / 审核 / 返工 / 任务配置：`agentRef.instructions` = `effectiveInstructions`，
  `skills` = `loadAgentInjectableSkills(store, agent)`（共享 ∪ 独有，同 slug 独有盖共享）。
- 聊天**不投递指令正文**（聊天 = 原文 + 技能），生成者靠它独有的 3 条技能干活。

## 7. 独有技能 API

```
GET    /api/agents/:id/skills           → { skills: [{slug, name, description?, body}] }
PUT    /api/agents/:id/skills/:slug     { body }  （校验 = 安装接口同一关 resolvePayloadEntry）
DELETE /api/agents/:id/skills/:slug     → { removed }
```

- 内置智能体 PUT/DELETE 一律 400 `builtin_agent_readonly`（平台播种，界面同款只读）。
- slug 即路径段：**不静默规范化**（安装接口会对不规范名字改名，这里目录名 = 使用者
  给的机器名），按 slug 规则严格拒绝。
- store 端口新增 4 个方法（`listExclusiveSkills` / `getExclusiveSkill` /
  `writeExclusiveSkill` / `removeExclusiveSkill(agentId[, slug])`）；
  sqlite-store 为 stub（抛"不支持"），文档注明未接线。

## 8. 范围边界与已知取舍

- **平目录 = 单工作区假设**：`agents/` 不分 workspace 子目录，靠 `agent.json` 的
  `workspaceId` 区分；今天只有一个默认工作区，将来多工作区时再分目录。
- **模板在 catalog 的偏差**（相对早前讨论）：指令默认值仍是 TS 里的**原始常量**
  （单一来源），只有 3 条平台技能以文件形式住在 `catalog/platform-skills/`；
  本轮**没有** `catalog/builtin-agents/` 模板目录——内置的生成仍然由
  `ensureBuiltin*` 在启动时保证，与自建同形落成目录。
- 独有技能 v1 **只支持 SKILL.md**（支持文件暂不落盘）；注入时 `files: {}`。
- 老 `agent.jsonl` 已在迁移完成后删除（2026-11 使用者确认）。
- 记忆（D112）：`agents/<id>/memory.jsonl`；`listMemoryEntries` 不给 `agentId` 时
  跨目录汇总（列表页 `memoryCount` 唯一调用点）。

## 9. 代码落点

| 模块 | 文件 |
|---|---|
| 目录读写 | `packages/store-file/src/agent-dirs.ts` |
| store 封装 + 迁移 | `packages/store-file/src/file-store.ts`（`#migrateAgentsToDirs` / `#migrateMemoryToAgentDirs` / `#memoryLog`） |
| 端口 | `packages/domain/src/ports/store.ts`（4 个独有技能方法；memory 端口签名不变） |
| 注入 | `apps/daemon/src/agent-injectable-skills.ts` |
| 组装 | `apps/daemon/src/builtin-drafter.ts`（`effectiveInstructions` / `*_BODY`） |
| 平台技能播种/迁移 | `apps/daemon/src/agent-maker-skills.ts` |
| API | `apps/daemon/src/server.ts`（独有技能三条路由；agentRef/指令换口径） |
| 界面 | `apps/web/src/components/AgentDetail.svelte`（独有技能节） |
