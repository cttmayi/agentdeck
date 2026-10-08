# 智能体组（Agent Group）设计稿

> 🚧 **状态：提案 · 待审**（尚未实施，未进决策记录）。
> 修订记录：**v2**。v1 的「流水线（Pipeline）」方案（`pipeline-pairing.md`）被本稿取代——
> 使用者认为"流水线"暗示线性固定流程，未来多 Agent 扩展（多执行者 / 多审核者 / 会签 /
> 嵌套协作）装不进去，**"智能体组"作为容器概念更合适**。
> 已拍板的方向在本稿中保留：**配对是一等概念、行动权限归属修正、一对多**（一个执行者可
> 属于多个组；一个审核者可在多个组里，各自配行动权限）。
> 本稿定稿后进入 `docs/srs/requirements.md` §16 决策记录（预计编号 **D70**），再按
> 「§11 分阶段实施」动工。
>
> 📖 **它现在到底是怎么跑的**：见 [`../reference/agent-group-workflow.md`](../reference/agent-group-workflow.md)
> （当前实现的参考手册：组的展开、执行 → 审核 → 行动的链路、返工闭环、四道闸、界面、
> 诚实缺口清单）。本稿讲**为什么这么做**，那一份讲**实际怎么跑**。

---

## 1. 为什么是「组」而不是「流水线」

两个理由，一个是心智模型，一个是数据形状：

1. **名字塑造心智模型。** "流水线"是装配线：一段接一段、顺序固定、形状不可变。而使用者
   真正要表达的是"**一队 agent，有分工**"——执行、审核只是当前这队人的两种分工。叫
   "组"，未来加人、换分工、多种协作方式，都不需要换名字；叫"流水线"，未来每一种新形态
   都要先跟"流水线"这个名字搏斗（"这还算一条流水线吗？"）。
2. **数据形状决定演进成本。** 流水线是 `executorId + reviewerId` **两个固定槽位**——未来
   多一个执行者就要加字段、改校验、迁移。组是 **`members: AgentId[]` 列表**——加成员是
   自然演进，数据形状一个字不用改，改的是**组形态校验器**和**协作规则**（§10）。

**风险与对策（必须写在前头）**：组概念最大的危险是退化成"任意成员 + 任意规则"的花名册
——那正是 D28 砍掉的 kindPatterns / isFallbackReviewer / autoReview 那类"四个互相牵扯的
开关"的复活（`entities.ts:432` 那段注释记着教训）。对策有两条：

- **组的执行语义由「组形态校验器」唯一决定**，不是由字段拼出来的。当前只支持一种形态
  （恰好 1 执行者 + 恰好 1 审核者），形态不对 ⇒ 建组 / 提交任务时**明确报错**，不猜、不
  静默降级。
- **不为未来预埋字段**（不加 `strategy` / `parallelism` / `reviewMode` 之类的空字段——
  那是死接口）。未来的扩展位写在 §10（文档层），落在代码里的只有"校验器 + 集中装配点"。
  这与仓库里 INV-14~16 的处置同款：实现与测试在域层，无生产调用点，文档写明为什么。

---

## 2. 背景：现在一条链的属性散在三处

当前模型里，「执行 → 审核 → 行动」的组成部分分别住在不同的地方：

| 属性 | 住在哪 | 说明 |
|---|---|---|
| 角色（执行 / 审核） | `Agent.role` | `entities.ts:318`，D28 从四个开关简化来的 |
| **配对关系** | 执行者上的 `reviewerAgentId` | `entities.ts:476`。**单向引用**：执行者指审核者；审核者不知道自己为谁服务 |
| 判断依据 | 审核者的「指令」 | D37 内联；`Agent.reviewStandard` 只剩老数据兼容回退 |
| **行动权限 + 固定参数 + 调试动作** | 审核者的 `allowedActions` / `actionParams` / `debugActions` | `entities.ts:358/401/376`，挂在**审核者个人**身上 |
| 默认返工次数 | 建任务时临时配 | `SubmitRunRequest.maxReworks`，不在任何长期配置里 |

要配好一条链，使用者实际要做三个动作：**建执行者**（指令 / 技能）→ **建审核者**（指令 /
行动权限）→ **再回去把执行者的「由谁审它」指过去**。中间漏任何一步，链都不完整，而且
**不报错**——审核者建了没人用、执行者配了但审核者没写指令，都只是静默地不审。

---

## 3. 三个具体问题（使用者的直觉背后）

1. **配置碎片化**：一条链的三个组成部分要分三次配、分两处维护。心智上是"两个 agent"，
   不是"一队人"；"配好了吗"要同时看两个对象。
2. **行动权限的归属错位**：`allowedActions` 挂在审核者身上，但它的语义是**这条链**的——
   "这队人的活判过后，应该能做什么"。现在同一个审核者被多个执行者用时，行动权限**被迫
   共享**；想给不同执行者不同的动作集，只能靠建任务时临时覆盖（`NewTaskForm` 的 ③）。
3. **配对关系弱**：单向引用 + 悬空状态（`newtask-chain.ts` 的 `dangling` 要专门处理）+
   删除 / 改角色都会留下半截配置。审核者页要靠 `executorsPointingHere` 反向查询才知道
   自己在为谁服务（`AgentDetail.svelte:456`）——"我建了它怎么没动静"是最常见的问题。

---

## 4. 概念模型：AgentGroup

新增一等实体 `AgentGroup`，放进 `packages/protocol/src/entities.ts`（与 `Agent` 同级）：

```ts
AgentGroup {
  id: AgentGroupId,            // 品牌 id（protocol/src/ids.ts 加一个）
  workspaceId: WorkspaceId,
  name: string,                // 必填；默认「<执行者> × <审核者>」
  members: AgentId[],          // ★ 列表形状：未来多 Agent 的演进位
  allowedActions: ActionRef[],        // ★ 组规则：这队人判过后允许触发什么（权威）
  actionParams: Record<ActionRefType, Record<string, unknown>>,  // D43 固定参数随组走
  debugActions: ActionRef[],          // D43 调试动作随组走
  maxReworks: number | null,   // 默认返工次数（0–100，null = 无限），任务级仍可覆盖
  enabled: boolean,            // 停用 = 建任务时不可选（不删，保留历史）
  createdAt: EpochMs,
  updatedAt: EpochMs,
}
```

**组形态校验器**（`packages/domain/src/groups/shape.ts`，唯一入口）：

- 当前唯一受支持形态：**恰好 1 个 `role: 'executor'` + 恰好 1 个 `role: 'reviewer'`**；
  成员的角色从各自的 `Agent.role` 读，不在组上重复存（同一个 agent 的"身份"只有一份）。
- 不满足 ⇒ 建组 / 提交任务时明确拒绝（"组必须有恰好一个执行者与恰好一个审核者"），
  并列出当前实际是谁、缺谁。
- INV-1（reviewer ≠ executor）在这里天然成立：恰好各一个，不可能相等。

**谁保留什么（归属清单）**：

| 属性 | 现在 | 之后 | 理由 |
|---|---|---|---|
| 指令 / 技能 / 环境 | 各 agent | **不变** | 能力属于个人 |
| 角色 | 各 agent | **不变** | 能干活的 / 能审的 |
| 判断依据 | 审核者的「指令」 | **不变** | 判断依据与身份是同一件事（D37 的原话） |
| **配对关系** | 执行者 `reviewerAgentId` | **组** | 单向引用退役 |
| **行动权限** | 审核者 `allowedActions` 等 | **组** | 归属修正（§3.2） |
| 默认返工次数 | 任务级临时配 | **组**（任务级可覆盖） | 这队人的默认配置 |

**规则**：

- `members` 里每个 id 必须存在、且是 `role: 'executor'` 或 `role: 'reviewer'`；其余角色
  值（未来若有）进不了组——组形态校验器按当前枚举判。
- 每条组 `allowedActions` **必填**（空数组 = "判过也不动手"，与任务级空数组同语义），
  不设"从审核者抄默认"——避免双份真相。
- 一个执行者 / 审核者可以属于任意多条组（**一对多**，已拍板）。
- 每条组一个 `enabled`：停用的组在「智能体 / 建任务」里不可选但保留记录（历史任务能
  看出它当时走的是哪队人）。

---

## 5. 协议与存储改动

### 5.1 `packages/protocol`

- `entities.ts`：新增 `AgentGroup` 实体 + `AgentGroupId` 品牌类型。
- `local-api.ts`：
  - 新增组 CRUD：`GET/POST /api/agent-groups`、`GET/PATCH/DELETE /api/agent-groups/{id}`。
  - `SubmitRunRequest` 新增可选 `groupId`：提供 ⇒ 执行者 / 审核者 / 行动权限的默认都从
    这条组解析；不提供 ⇒ 回落到"默认执行者的那个组"（见 Q-G2）。
  - `Capability` 加 `agent-groups` 标志（老 daemon 忽略未知字段，界面据此决定显示哪版）。
  - `LOCAL_PROTOCOL_VERSION` 升版。
- `Run` 实体新增 `groupId?: AgentGroupId`（**记录用**：这条 run 走的是哪队人，供审计与
  "链"的重建；老 run 是 `null`）。`reviewerAgentId` 保留为**解析结果的快照**（这条 run
  实际由谁审），与 `deliveryMode` 同一种"记事实"的语义。

### 5.2 Store 端口（`packages/domain/src/ports/store.ts`）

按现有分组加一组方法：`getGroup` / `listGroups` / `listGroupsByAgent` / `insertGroup` /
`updateGroup` / `deleteGroup`。**两套实现都要改**：

- `store-file`：`log/group.jsonl` 新集合（按需创建，老数据不受影响）。
- `store-sqlite`：新增 `group` 表（17 → 18 张），`port-thinness.test.ts` 的差分契约自动
  覆盖新方法。

---

## 6. 领域逻辑改动

| 位置 | 现在 | 之后 |
|---|---|---|
| INV-1 强制点 | `POST /api/runs`（`server.ts`）写入前校验 `reviewerAgentId ≠ executor` | ①建组时形态校验器保证恰好 1+1（天然不等）；②任务级覆盖（`pick`）仍在 `POST /api/runs` 校验（现有逻辑保留，校验对象是**覆盖后的**审核者） |
| `decideReview` 的 `allowedActions` | 来自审核者 agent | 来自这条 run 的**组**（run 的 `allowedActions` 快照，任务级覆盖优先——与现在 `Run.allowedActions` 的语义相同） |
| `autoChainReview` | 从 `reviewerAgentId` 找审核者 | 从 `groupId` 找组 → 审核者；找不到（组被删 / 停用）按现在的"审核者已不存在"那档发通知，不静默 |
| 审核者的资格判据 | 指令非空（`review-standard.ts`） | 不变——判据仍然是"审核者的指令非空" |
| `dead-actions.ts` | 清 agent 配置里的死动作名 | 清理对象换成组的 `allowedActions`（逻辑同构） |
| 返工额度 `#reworkBudgetFor`（`executor.ts`） | 从被审的执行 run 的 `maxReworks` 取 | 默认从组 `maxReworks` 取，任务级覆盖仍优先 |
| 删除语义 | skill 卸载被引用时**被拒并列出是谁** | 删执行者 / 审核者时，有组引用它 ⇒ **被拒并列出组**（不得静默丢弃，见 Q-G4） |

---

## 7. 界面改动

### 7.1 两页分开：智能体 = 成员库（灵活性），智能体组 = 编队（方便性）

使用者拍板（2026-10）：**智能体与智能体组是分开的两页，不混合**——智能体保证灵活性，
智能体组保证方便性。分工如下：

| | 智能体页（成员库） | 智能体组页（编队） |
|---|---|---|
| 管什么 | **能力**：指令 / 技能 / 角色 / 环境 / runtime / 设为默认（D36，聊天要用） | **编排**：成员槽位 / 行动权限 / 固定参数 / 默认返工 / 停用 |
| 撤掉什么 | 「由谁审它」下拉（执行者详情）与「行动权限」编辑器（审核者详情）——**配对与权限是编排属性，搬进组页** | — |
| 新增什么 | — | 新视图：侧栏第 6 项 `#/groups` |

- **侧栏顺序**：聊天 / 任务 / 智能体 / **智能体组** / 技能 / 工具。`VIEWS` 加 `'groups'`
  （`apps/web/src/lib/route.ts`，含 `parseHash`/`hashFor` 往返测试）。
- **组页**：组列表（每项：组名、执行者 → 审核者、N 个动作、状态徽标）+ 组详情
  （① 成员两槽位，各自可换人——换审核者与现在的"由谁审它"是同一件事，只是搬了家；
  ② 组规则：行动权限勾选 + 固定参数 + 默认返工；③ 停用开关）。建组时还没有审核者 ⇒
  提供"新建一个"快捷入口（跳智能体页，填完指令回来接着配组）。
- **智能体页**：保持现有形态，只撤掉「由谁审它」与「行动权限」两处（它们进组页）。
  角色切换（执行 ⇄ 审核）仍允许；**有组引用它的 agent 换角色 / 删除时被拒并列出组**
  （同 §6 删除语义）。
- 默认组（Q-G2）在组页设。

### 7.2 建任务页（`NewTaskForm` / `newtask-chain.ts`）

- ① 从"选执行者"变成"**选组**"：下拉每一项直接显示完整链（执行者 → 审核者 → N 个
  动作），默认 = 默认执行者的那个组（多个时见 Q-G2）。没有组时退化为现在的"只选执行者、
  不审"。
- ②③ 覆盖语义**原样保留**：`follow` = 跟随组（请求体里 `groupId` + 省略覆盖键）；
  `none` = 这次不审；`pick` = 这次换人（③ 的跟随基准见 Q-G1）。`newtask-chain.ts` 的
  纯函数推导层重写但形态不变，`newtask-chain.test.ts` 相应更新。
- 请求体：跟随 ⇒ 写 `groupId`、不写 `reviewerAgentId`/`allowedActions`/`actionParams`；
  覆盖 ⇒ 写覆盖键（与现在"省略 ≠ 给值"的纪律完全一致）。

### 7.3 词条与探针

- `packages/i18n/src/web/` 新增 `groups.*` 命名空间；智能体 / 建任务两组词条随之调整。
- `tools/layout-probe`：新增组相关断言（新建组入口、组详情两槽位、链的显示、停用态）。
- remote 管理页不涉及组，不受影响。

---

## 8. 迁移

老数据**自动迁移**，不需要手动导出 / 导入：

1. 启动时（或首次读 agent 时）扫描：每个 `role: 'executor'` 且 `reviewerAgentId` 非空的
   agent，生成一个 `AgentGroup`：
   - `members` = `[执行者, 审核者]`；
   - `allowedActions` / `actionParams` / `debugActions` = 从**审核者**身上抄过来（审核者
     被多个执行者引用时，每个组各抄一份——这正是归属修正带来的行为差异，会在界面明说）；
   - `maxReworks` = 0（沿用现状默认）；
   - 记一条迁移日志（"已为 X 生成组，行动权限从 Y 抄录"）。
2. `Agent.reviewerAgentId` 退役：**老数据不再读它**（同 `toolIds` 的处置：`Agent` 是普通
   `z.object`，多余键解析时被丢掉，不报错；存储格式版本不动）。
3. `Agent.allowedActions` 等：写入路径不再产生新值；老记录保留，`review-standard.ts` 的
   兼容回退**降级为只读**（读取方 `agent.allowedActions ?? []`，不再当权威）。

---

## 9. 不变量与测试

**不会松动的现有不变量**（architecture §4.3 那张表）：INV-1（审核者 ≠ 执行者，强制点
迁移不减弱）、INV-9（动作必须来自显式白名单）、INV-11（幂等）、INV-13（执行端不由判决
决定）全部保持。

**会被影响的现有测试（architecture §13.1 的钉子）**：

| 测试 | 影响 |
|---|---|
| `reviewer-override.test.ts` / `task-action-whitelist.test.ts` / `task-action-params.test.ts` | 覆盖语义保留，请求形状变（`groupId` + 覆盖键），断言同步改 |
| `rework-e2e.test.ts` | `maxReworks` 来源变（组默认 + 任务覆盖），断言同步改 |
| `dead-actions.test.ts` | 清理对象换成组 |
| `newtask-chain.test.ts`（前端） | 推导基准从执行者换成组 |
| `agent-actions.test.ts` | `effectiveAllowedActions` 的权威来源变 |
| `no-builtin-actions.test.ts` / `s1-e2e.test.ts` / `review-e2e.test.ts` | 审核收口的 `allowedActions` 来源变 |
| `port-thinness.test.ts` | 端口新增方法自动纳入差分契约 |

**新增测试点**：

- 组 CRUD + 形态校验（恰好 1+1、成员角色、缺谁报谁）+ INV-1；
- 迁移：老数据生成组、权限从审核者抄录、幂等（跑两次不重复生成）；
- 一对多：一执行者两个组各配不同权限；一审核者被两个组引用；
- 任务级：`groupId` + `follow`/`none`/`pick` 三种组合的请求体形状与落库；
- 删除：删被组引用的 agent ⇒ 被拒并列出组；
- 停用组：不可选但历史可查。

---

## 10. 未来扩展：多 Agent 怎么演进（写在文档层，不预埋字段）

组的 `members: AgentId[]` 列表形状 + 组形态校验器是唯一入口。下面每种形态的落地方式
都**先改校验器、再加规则字段**——数据形状不用破坏。⚠️ 以下都是**方向**，不是承诺；
哪一条真正要做，另行记决策并补全该形态的测试。

| 未来形态 | 落点 | 现在为什么不做 |
|---|---|---|
| **多执行者**（一个任务由多个执行者并行 / 串行分工） | 校验器从"恰好 1 执行者"放宽为"≥1"；加规则字段 `execution.strategy: 'parallel' \| 'sequential'`；run 提交从"一条 run"变成"一组 run"——`executor.ts` 的并发闸门 / 工作目录锁 / 消息流天然支持多条 run，落点在 executor 与 `POST /api/runs` 的语义 | 会牵扯任务模型（一个任务多条执行 run 的看板阶段怎么推），影响面超出"配对"这件事 |
| **多审核者会签**（一个产出被多个审核者审，全部过 / 任一过） | 校验器放宽为"1 执行 + ≥1 审核"；加规则字段 `review.strategy: 'any' \| 'all'`；`decideReview` 之后多份判决按策略汇总，动作只能由"最终判定"触发 | 会签的汇总语义（部分过部分不过怎么办）是另一个设计问题 |
| **审核链 / 嵌套协作**（A 审完 B 再审，或组间串联） | 目前最可能落在"组的 `members` 里放另一个组的引用"或"Run 的 `derivedFrom` 链"（INV-14~16 的回路边界已在域层保留，见 architecture §4.3） | 没有任何使用场景支撑，做了就是猜 |
| **同 agent 在组内扮演不同角色** | `members: AgentId[]` 改成 `members: [{agentId, role}]` | 现在的角色枚举只有两个值，且"判断依据跟人走"（D37）意味着同一人换角色是改它的指令，不是换组内标注 |

**结论**：组实体的形状（列表 + 校验器 + 规则字段的集中位置）为这些形态留好了**演进位**，
但一个字段都不预埋。未来做哪一条，改动都收敛在"校验器 + 规则字段 + 对应的执行逻辑"三处。

---

## 11. 分阶段实施（每步可验证，可单独收口）

| 阶段 | 内容 | 验收 |
|---|---|---|
| **0** | 定稿 + 决策记录 D70 | 文档进 `requirements.md` §16 |
| **1 后端地基** | 协议 `AgentGroup` 实体 + ids + 端口方法（两套实现）+ 域层组形态校验器 / `decideReview` 来源 / `dead-actions` / 返工额度 + **迁移** | `pnpm run check` 绿；迁移单测 + 差分契约覆盖新端口方法 |
| **2 接口** | `/api/agent-groups` CRUD + `SubmitRunRequest.groupId` + `Run.groupId` + `Capability` 标志 + CLI（`agent-groups` 只读命令） | `m4-routes.test.ts` 等接口测试绿 |
| **3 界面** | 新增智能体组视图（`#/groups`：组列表 + 组详情）+ 智能体页撤「由谁审它 / 行动权限」两处 + 建任务页选组 + `newtask-chain.ts` 重写 + i18n + 探针新增组页断言 | `svelte-check` + 前端单测 + 探针（layout / remote 双绿） |
| **4 清理** | `reviewerAgentId` / `Agent.allowedActions` 写入路径退役、`review-standard.ts` 回退降级只读、文档同步（README / architecture §13 代码索引） | `pnpm run check` 绿 + 探针全绿 |

阶段 1–2 是纯后端，可以先合；阶段 3 是界面，独立收口。每个阶段都不破坏现有功能
（迁移保证老数据直接可用）。

---

## 12. 开放问题（待使用者拍板）

| # | 问题 | 推荐 | 备选 |
|---|---|---|---|
| **Q-G1** | 「这次换人」时 ③ 的行动权限跟随什么？换进来的人不属于当前执行者的任何组时没有权限可跟随 | ③ **默认空 + 界面提示**（"换来的审核者没有默认动作，这次请勾选"）——语义干净，无双份真相 | 审核者保留一份"个人默认 `allowedActions`"作为换人时的跟随基准（引入双份真相，不推荐） |
| **Q-G2** | 执行者属于多个组时，建任务默认选哪个组？ | **默认组**（每执行者至多一个，设另一个自动让位，与 D36 默认执行者同款） | 建任务必须显式选，无默认 |
| **Q-G3** | `maxReworks` 收进组作为默认？ | **收**（这队人的默认配置），任务级仍可覆盖 | 保持仅任务级（组只管配对与权限） |
| **Q-G4** | 删除被组引用的执行者 / 审核者 | **被拒并列出组**（与 skill 卸载被拒同款，不得静默丢弃） | 级联删组（有静默丢历史的风险） |
| **Q-G5** | 停用组（`enabled: false`）有必要吗，还是直接删？ | 保留 `enabled`（历史可查，审计不悬空） | 直接删（简单，但历史 run 的 `groupId` 悬空） |
| **Q-G6** | CLI / MCP 要不要暴露组？ | CLI 加只读 `agent-groups` 命令（MCP 不加——暴露面刻意窄） | 都不加（组只走界面） |

---

## 13. 影响面总览（诚实清单）

- **协议**：新增 1 实体 + 2 品牌类型 + 3 接口 + 1 capability + 协议版本升版。
- **存储**：端口 +6 方法，两套实现各改；file 加 1 集合，sqlite 加 1 表。
- **域**：新增组形态校验器（1 个纯函数文件）+ INV-1 强制点迁移 + `decideReview` 来源 +
  `dead-actions` + 返工额度，共 4 处逻辑调整。
- **daemon**：路由 + `executor.ts` / `review.ts` / `server.ts` / `chat.ts` 的取审核者路径。
- **前端**：新增智能体组视图（`#/groups`）+ 智能体页撤「由谁审它 / 行动权限」两处 + 建任务页
  重构，`newtask-chain.ts` 重写，i18n + 探针。
- **迁移**：启动时自动生成组，无手动步骤。
- **不做**：聊天旁路、kind 路由、多执行者 / 会签（§10 是方向不是承诺）。

---

## 14. 本轮实施记录（增量版：先不动老逻辑，只加组）

> 使用者拍板：**先不动原来逻辑，添加智能体组**。所以本轮的落地与 §11 的完整计划
> 有一个重要区别——**阶段 4（退役老字段）不做**，`reviewerAgentId` /
> `Agent.allowedActions` / `newtask-chain.ts` 的老路径行为一行没改，组是**另一条
> 入口**。以下是已落地的事实与刻意留到下一轮的缺口。
>
> ⚠️ **2026-10 更新**：**阶段 4 后来做了**（使用者改主意：「需要完全移除
> reviewerAgentId 的概念，不要遗留旧数据」＋「彻底收掉审核者的行动权限」）。
> 所以本节下面那些"老路径继续可用"的话**已经不是现状**——现状见
> [§16](#16-第三轮收口撤掉-agent-上的审核者与行动权限2026-10使用者拍板)。
> 本节保留原文，因为它是那一轮的记录（"当时为什么先并行"也是决策的一部分）。

### 14.1 已落地（可 `pnpm run check` 全绿验证）

**协议**（`packages/protocol`）
- `AgentGroup` 实体（`entities.ts`）+ `AgentGroupId` 品牌（`ids.ts`）+ `Run.groupId`
  （只读记录，不参与展开）。
- `SubmitRunRequest.groupId`（可选字符串；daemon 展开）+ `Capability.AgentGroups`
  （`'agent-groups'`，旧 daemon 静默忽略未知字段，界面据此不给「从组选」那一档）。
- ★ 超出原计划的一处：`Run.debugActions` / `SubmitRunRequest.debugActions`（可选）。
  组的 `debugActions`（调试动作）需要**真落到执行**——老路径没有任务级覆盖
  （审核 run 的调试集合只从审核者 `Agent.debugActions` 取）。不加这一站的话，
  "组里勾了调试"会设了但没生效（这是本仓库最贵的那类错）。落点：
  `executor.ts` 的 `effectiveDebugActions = run.debugActions ?? agentForStandard?.debugActions ?? []`，
  与 `allowedActions` 同一套"字段在不在就是判据"。

**存储**（`packages/domain` 端口 + 两套适配器）
- 端口 +6：`getGroup` / `listGroups` / `listGroupsByAgent` / `insertGroup` /
  `updateGroup` / `deleteGroup`。
- `store-file`：`group` 集合（追加式日志，与其它实体同构）。
- `store-sqlite`：表名用 **`agent_group`** 而不是 `group`——后者是 SQL 保留字，
  `derivedSql()` 拼语句时没引号（`SELECT count(*) FROM group` 直接 prepare 失败）。
  `derivedSql()` 顺带统一对 `group` 加引号（防再踩）。

**域**（`packages/domain/src/groups/shape.ts`）
- `checkGroupShape`：恰好 1 执行 + 1 审核；成员缺失按 id 列出；INV-1 由 1+1 形态
  天然满足。写入口与 `POST /api/runs` 两处都调用。

**daemon**（`apps/daemon/src/server.ts`）
- `/api/agent-groups` CRUD（POST/GET/PATCH/DELETE）；动作白名单 / 固定参数校验
  **复用** agents 那套 `parseAgentAllowedActions` / `parseAgentActionParams`
  （"为什么拒"的说法两处一致，各写一遍迟早漂）。
- `POST /api/runs` 的 `groupId` 展开：
  - 组不存在 / 停用 / 形态坏 ⇒ 400（`group_not_found` / `group_disabled` /
    `group_shape_invalid`）；
  - **执行者由组决定**：`agentRef.id` ≠ 组执行者 ⇒ 400 `group_executor_mismatch`；
  - **其余字段是覆盖**：请求体省略 ⇒ 用组的默认（`reviewerAgentId` /
    `allowedActions` / `actionParams` / `debugActions` / `maxReworks`），
    给了值 ⇒ 这一次用它。展开后走的是**同一条老链路**（`autoChainReview` /
    `decideReview` / 返工一行没改）。
- `Capability.AgentGroups` 加入 identity。

**前端**
- 路由第 6 项：`#/groups`（`VIEWS` / `Sidebar` / `VIEW_TITLE_KEYS` 同步），
  顺序 `chat / tasks / agents / groups / skills / tools`。
- 新视图 `views/Groups.svelte`：左列表 + 右表单（组名 / 执行者槽 / 审核者槽 /
  返工次数 / 启用开关 / `ActionPicker` 行动权限+固定参数+调试）。成员名字从
  `$agents` join（同一份数据，不各自猜）。
- 建任务页（`NewTaskForm.svelte` + `newtask-chain.ts`）：
  - ① 顶部「从智能体组」下拉（只在 `agent-groups` 能力在手时给；只列启用的组）；
  - 组模式下执行者**锁定**为组的执行者（不画可改下拉——画了就是必然 400）；
  - 链默认从组取（审核者 = 组的、动作/参数 = 组的、返工 = 组的），
    `chain` 与「跟随」选项文字同源（`GroupChainDefaults`）；
  - 覆盖纪律不变：改了的才发 key（`reviewerRunField` / `actionsRunField` /
    `paramsRunField` 原样复用；新增 `reworkRunField`——老路径 0=不返工只在 >0 时
    发，组模式下"== 组默认"省略、"从默认改到 0"是明确收紧必须发）；
  - 提交时 `groupId` 只在选了组时出现；执行者与组不符等 400 原文原样显示。
- i18n：`shell.navGroups*` + `newtask.group*` + 新词表 `groups.ts`（自动进
  `webText`，`i18n.test.ts` 扫目录钉住）。

**测试**（全部过）
- 域：`shape.test.ts`（8 条）；daemon：`groups-e2e.test.ts`（13 条：CRUD + 展开 +
  覆盖 + 三档 400 + 真实链路派生审核）；
- 前端：`newtask-chain.test.ts` +14 条组模式用例；`route.test.ts` 自动覆盖新视图；
  `i18n.test.ts` 自动扫到新词表。
- sqlite 表名修复被 `sqlite-store.test.ts` / `port-thinness.test.ts` 钉住。

### 14.2 刻意留到下一轮（缺口清单，不是遗忘）

| 缺口 | 为什么留 | 下一轮怎么收 |
|---|---|---|
| 智能体页撤「由谁审它 / 行动权限」两处（§11 阶段 4） | 使用者拍板"先不动原来逻辑" | 老字段退役后，组成为唯一配置入口 |
| 删 agent 时拒绝"它被组引用"（Q-G4 推荐做法） | 动 agent 删除路由 = 动老逻辑；现形态下组在提交时被 `group_shape_invalid` 兜住、界面上显示「成员已删除」 | 阶段 4 一起做（与 skill 卸载被拒同款） |
| 每执行者一个默认组（Q-G2） | 需要建任务页"默认选组"的推导，超出"只加组"的范围 | 单独一轮 |
| CLI `agent-groups` 只读命令（Q-G6） | 本轮无 CLI 消费者 | 单独一轮 |
| 启动迁移（§8：自动生成组） | 迁移 = 改老数据，违背本轮原则；老工作区用老路径照常 | 阶段 4 |
| 探针新增组页断言 | 探针改动作大，本轮界面改动靠 `svelte-check` + 单测 + 手测钉住 | 阶段 4 一并补 |

### 14.3 与 §11 计划的偏差（有意的）

- 阶段 1 的「`decideReview` 来源 / `dead-actions` / 返工额度」**不做**——那是"组
  成为唯一来源"之后的收口；本轮组只是**另一条默认来源**，老路径照旧。
- 阶段 2 的 CLI 命令不做（见上）。
- 阶段 3 的「智能体页撤两处」不做（见上）。
- ★ 多做了 `debugActions` 任务级字段（§14.1），否则组的调试勾选会静默失效。


## 15. 第二轮决策：工作流模式 + 私有智能体（2026 续）

> 使用者的扩展：新建组将来可能有好几个**模式**；这轮先实现**工作流模式**（= 现在
> 的「执行 → 审核 → 行动」顺序链，1 执行 + 1 审核）。成员有两种来源：**选智能体
> 里已有的**，或**新建私有的**。已拍板四项（见下），本节是决策记录与实现方案。

### 15.1 四项决策（使用者拍板）

| # | 问题 | 拍板 |
|---|---|---|
| ① | 私有 agent 的语义 | **归属组的 Agent**：在智能体库里、但**不进全局列表、不能被别的组引用**；执行/审核链路复用现有机制（store 全量，路由层过滤），改动最小 |
| ② | 删组时私有 agent 怎么办 | **提示后一起删**（私有 = 组的一部分） |
| ③ | `AgentGroup.mode` | **现在加**（`'workflow'`，为未来模式留档位） |
| ④ | 私有 agent 配置到什么程度 | **表单收敛**：名字 + 指令（执行者）/ 审核标准（审核者）+ runtime + 可选技能 |

### 15.2 实现要点（与 §14 的关系：D70 的延续，老逻辑仍然不动）

**协议**
- `Agent.ownerGroupId?: AgentGroupId`：私有的标记（**字段在不在就是判据**；旧数据
  没有这个键 = 全局）。⚠️ 这是**归属**不是成员关系：组删除时按 `ownerGroupId`
  级联删（顺手清掉"建了一半"的孤儿私有 agent，见下）。
- `AgentGroup.mode?: 'workflow'`（`GroupMode` 枚举，现在只有一个合法值；旧组没有
  这个键 = 工作流，省略即默认）。**mode 只在创建时写，PATCH 不可改**（这轮唯一
  合法值，改了也没意义；未来模式出现时再放开）。
- `Capability.AgentGroupsWorkflow`（`'agent-groups-workflow'`）：界面据此才给
  「新建私有」与模式展示——旧 daemon 会静默忽略 `ownerGroupId`，把私有 agent
  建成全局的，那正是"界面说的与实际发生的不一致"。

**daemon**
- `GET /api/agents`：**路由层**过滤 `ownerGroupId === undefined`（store 层保持全量
  ——`autoChainReview` 等内部链路按 id 找执行者/审核者，私有 agent 必须能找到；
  这是"过滤私有"不能犯的错：过滤到执行链路上，私有审核者会"找不到"）。
- `POST /api/agents`：接受可选 `ownerGroupId`（校验：组存在；role ∈ 执行/审核）。
- `PATCH /api/agents/:id`：**不接受** `ownerGroupId`（归属不可改，未知字段拒绝）；
  其余字段（name / instructions / reviewStandard / runtimeKey / skillIds）正常可改
  ——前端编辑已有私有成员走这条路。
- `DELETE /api/agents/:id`：**本来就不存在**（agent 一直是"只增改、不单删"），
  所以"私有 agent 脱离组单删"天然无路；删除私有 agent 的唯一路径就是删组级联。
- `PUT /api/agents/default`：私有执行者不能当默认（界面上选不到它；接口上补一刀）。
- 组接口：
  - `GET /api/agent-groups`（列表）与 `GET /api/agent-groups/:id`（详情）都返回
    `members`（组引用的全部 agent，**含私有**）——前端组视图与建任务页从这份
    数据 join 名字/角色，**不依赖**被过滤的全局 `$agents`；
  - `POST` / `PATCH` 接受 `createAgents`（私有成员的**草稿数组**：name / role /
    instructions | reviewStandard / runtimeKey / skillIds，最多 2 个）。组是私有
    agent 的**创建入口**：新建组时组 id 还不存在，所以由 daemon 在一次请求里先
    建组、再建私有 agent（`ownerGroupId = 新组 id`）、把新 id 并入 `members`；
    **任何写入之前**先对"给定成员 + 草稿占位"做形态预检（`shapeWithDrafts`）——
    形态不对整条 400，草稿一个都不建，不留"建了一半"的孤儿私有 agent；
  - `DELETE /api/agent-groups/:id`：先删 `ownerGroupId === 组 id` 的私有 agent
    （**按归属**删，不是按成员删——成员被移走/没来得及并进 members 的孤儿也在
    范围内），再删组；响应带 `removedPrivateAgents` 计数，界面删除确认框预告。

**前端**
- groups store：`AgentGroupView = AgentGroup & { memberAgents: Agent[] }`——组自带
  成员的**完整对象**（含私有，来自接口的 `members` 并表）；私有成员的名字/角色从
  这里取，不从 `$agents`（`$agents` 是过滤后的全局池）。`saveGroup` 增
  `createAgents?`，保存后返回刷新过的 `AgentGroupView`。
- `newtask-chain.ts`：`GroupChainDefaults.members` 从 `readonly string[]` 升级为
  `readonly Agent[]`（组的成员完整对象）；`byId` 的查找在 `$agents` 之后**回退到
  `group.members`**——私有执行者/审核者因此能被解析（跟随组 → 组审核者、锁定
  显示的执行者名）。`groupExecutor(members)` 直接按成员数组的角色找，不再依赖
  外部传入的候选池。
- `Groups.svelte` 成员槽（`MemberSlotForm.svelte` 组件）：每个槽两种来源——
  **选全局**（现下拉）/ **新建私有**（内联小表单：名字 + 指令（执行者）或
  审核标准正文（审核者，平台侧标准只有 body——name 早已删掉）+ runtime + 可选
  技能）。编辑已有私有成员时槽位直接展开成可改的小表单（保存时先 PATCH agent
  本体，再存组）；**「新建私有」只在 daemon 有 `agent-groups-workflow` 能力时
  出现**（旧 daemon 会静默忽略 `ownerGroupId` 把私有建成全局的）。私有成员不能
  切回「选已有的」（这轮组内没有移除成员）；删组确认框预告 `removedPrivateAgents`。
- `Groups.svelte` 表单默认态：**组默认启用**（界面没有"启用/停用"开关，保存一律
  `enabled: true`，编辑老数据也顺带重新启用——没有界面能再把它关掉，留一个"界面
  救不回来"的停用状态才是坑）；**行动权限默认收起**，用与成员槽同款小按钮选
  「不配动作 / 配动作」——收起即"组默认不动作"（点「不配动作」会清空已勾选，
  按钮上明说了"不配"，没有藏着掖着的状态）。
- 建任务页：组模式下执行者锁定显示取 `group.memberAgents`；跟随组时审核者能是
  私有成员。手动选人的候选池仍是全局池（私有 agent 只能经组到达任务）。

### 15.3 建任务页整体简化（2026-10，使用者拍板）

把「执行 → 审核 → 行动」三步链 + 各类"只对这一次"的覆盖（换人审 / 不审、
动作白名单勾选、固定参数、任务级返工下拉）**全部去掉**，表单只剩三样：
**要做什么** / **交给谁**（智能体或智能体组，互斥切换）/ 提交。选中后显示
四行**只读摘要**：执行者 / 审核者 / 允许的动作 / 返工。

- 语义：选智能体 ⇒ 提交 `agentRef`，**一个覆盖字段都不带**；选组 ⇒ 提交 `groupId`，
  整条链由 daemon 按组展开。**daemon 的请求契约没动**——`reviewerAgentId` /
  `allowedActions` / `actionParams` / `maxReworks` 这些覆盖字段仍然有效，
  只是这一页不再生成它们。
  ⚠️ 2026-10（§16）之后"不带覆盖字段"的含义变了：以前是"跟随**执行者**的长期配置"，
  现在是"**没有组就没有审核者**"——这一页因此多了一句摘要（选单个智能体那一档
  直说"不会自动审核"）。
- 摘要推导仍走 `newtask-chain.ts`（`choice` 恒为「跟随」），`newtask-chain.test.ts`
  未变（库层未动，只是组件不再 import 那些覆盖函数）。
- `newtask.*` i18n 词条大幅精简（删掉三步链 / 覆盖 / 返工选择器的死键，新增
  摘要键）；`NewTaskForm.svelte` 从 ~1670 行降到 ~570 行，构建产物少 ~23KB。
- 保留项：多行"要做什么"自动增高（3→15 行）、高级里的工作目录、吸底提交栏
  + 一行 foot-summary、`createDirty` 防误切。

**留到下一轮（不缩水、只是收口）**：组内"移除成员"操作（现在只能随组删）；
老字段退役与 §14.2 的缺口清单原样有效。

### 15.4 智能体页跟着简化：执行者的三个设置拿掉（2026-10，使用者拍板）

与建任务页的简化同一轮：**执行者的「由谁来审它」「模型」「默认工作目录」三个
设置整段拿掉**（审核走智能体组；模型用 CLI 默认；工作目录是任务级的）。

- 界面：`NewAgentForm`（新建）去掉「由谁来审它」与「默认工作目录」；`AgentDetail`
  去掉整节「与其他智能体的关系」（唯一字段就是由谁来审它 + 它的反向）与运行环境里
  的「模型」「默认工作目录」两行；智能体**清单行**去掉执行者的"谁来审"那一截
  （审核者保留「它审别人」）；详情页"执行者没配审核者"的头部警告随之删除
  （不然每个新执行者都会挂一条修不了的警告）。
- 数据与协议：`Agent.model` / `Agent.workDir` **原样保留**（只是界面不再生成它们）；
  `Agent.reviewerAgentId` 当时也原样保留，**但 2026-10 把它整个撤掉了**（§16）
  ——"界面不生成、数据里还有"这种中间态留不住：它让旧链逻辑继续读一个界面上
  已经不存在、也没人能改的字段。
- 影响：**新建**的执行者不再有长期审核者 → 单独发任务给它的摘要显示「未配置
  （这次不自动审）」，要走自动审核就放进智能体组。这是使用者的明确方向
  （审核是组的职责），不是回归。⚠️ **已有**执行者的 `reviewerAgentId`（如使用者
  库里的「文章写作员」）当时**照常生效**，2026-10 之后不再生效——它被清掉了。
- i18n：`agents.*` 删掉 24 个死键（`reviewerFieldLabel` / `noAutoReview` /
  `reviewerHint` / `reviewerHintDetail` / `reviewerNotApplicable*` / `reviewsWhoLabel` /
  `noExecutorsPointing` / `reviewerChosenHint` / `reviewerGoneWithId` /
  `noReviewerChosen` / `noReviewerOption` / `noReviewerHint` / `reviewerMissing` /
  `sectionRelations` / `headlineNoReviewer` / `modelLabel` / `modelPlaceholder` /
  `cliDefault` / `workDirLabel` / `workDirLabelOptional` / `workDirPlaceholder` /
  `workDirHint` / `autoWorkDir`），空态指引 `emptyHint` 改写为"放进同一个智能体组"。

### 15.5 智能体详情/新建改成「新建私有」同款布局（2026-10，使用者拍板）

同一轮的第二件事：**智能体详情页的界面设计要与智能体组类似**——使用者澄清
"类似"指的是**组里「新建私有」那一套 UI 布局**（`MemberSlotForm` 的
`.grid-form`：一张卡片、两列网格、每个字段一格、label 在上控件在下）。

- 界面：`AgentDetail` 的字段区从"四个分节（它怎么干活 / 挂载的 skill / 行动权限 /
  运行环境）的 9rem 定宽 label 表"改成**一张卡片**——名字 / CLI 一行，指令 / 技能
  一行（与「新建私有」逐格对应）；角色（编辑态）与行动权限（审核者）占整行。
  **查看/编辑两态保留**（查看态是同一张卡片的只读面孔：值用文字 / chips 显示，
  点「编辑」才变表单）——这是使用者明确的选择，没有学组的"始终可编辑"。
  行动权限默认收起、点「配动作」才展开（与组的「行动权限」同款小按钮）。
- `NewAgentForm`（新建）一并改成同款：角色整行 + 卡片（名字 / CLI、指令 / 技能），
  审核者的行动权限同样默认收起。`role-picker` 的 `auto-fit` 与半格指令的
  `min-height: 22rem`（D48）保留。
- 布局规则：卡片用 `repeat(2, minmax(0, 1fr))`（沿用 `.field-row` 时代"右列必须
  `minmax(0,1fr)`"的教训，防 ActionPicker 撑破容器）；深色主题下收起/展开的小按钮
  活动态用 `--accent-dim` 背景 + 白字（与新建任务页来源切换同款修法）。
- i18n：删掉三个小节标题 `sectionBehavior` / `sectionSkills` / `sectionRuntime`
  （卡片里由 `cell-label` 直接当标签）；`sectionActions` 保留。
- 不影响：hero 头（返回 / 头像 / 名字 / 角色徽标 / 编辑按钮）、`buildPatch`
  只存已改字段、老数据迁移提示（legacy 标准 / 动作出处）全部照旧，只是换了个格子住。

**技能显示口径（同轮收尾，使用者的检查反馈）**：三个界面的技能显示统一为
**以名字为主**——详情查看态 chips、详情编辑态勾选框、新建表单勾选框都印
`技能名`，slug 只在与名字不同时才作为弱化机器名补充（`skill-slug`）。
起因：已安装技能的名字常等于 slug（如 `fireworks-tech-graph`），原来
slug + name 一起印会重复成两个一模一样的东西（使用者报「技能显示没改对」）。
与「新建私有」里技能只显示名字的口径对齐。

**新建表单与编辑态同款**（同轮收尾）：角色从卡片外面移进卡片**第一行**（`role-cell`，
与 `AgentDetail` 编辑态一致），角色卡钉死 `1fr 1fr` 两个等宽卡（原来 `auto-fit` 是
旧版单列窄栏的遗产），`.grid-form` 卡片类统一成 `.card.agent-card`（两处同一套规则）。
使用者报「新建智能体也要改，应该要类似于智能体编辑状态」。

**形态：抽屉 → 主区右栏原位**（同轮）：使用者再报「没变化呢，还是右侧弹框出来的」——
新建智能体原来是**右侧抽屉**（`Drawer` 58rem），明确要求与编辑态一样在主区右栏打开。
于是 `NewAgentForm` 去掉 `Drawer` 外壳（不再有 `open` prop），加一个与 `AgentDetail`
同款的 hero（← 智能体列表 / 标题+副题 / 右上 取消+创建），表单卡片直接画在右栏
正文里；`Agents.svelte` 在 `MainArea` body 里 `{#if creating}` 渲染它，`with-detail`
与 `empty` 都带上 `creating`，点清单行退出「正在新建」。

**列数**：技能区**固定两列**（`repeat(2, minmax(0, 1fr))`，框、间距、滚动上限都与
「新建私有」的 `.skill-picker` 同款）——详情查看态原来是 chips（流式换行、不是
网格），编辑态/新建表单原来用 `auto-fill`（窄格子自动缩成一列），都改成钉死两列
（使用者报「至少没变成 2 列」）。查看态是同一格子的只读面孔：同框同列、无勾选框。


**二选一按钮统一成分段轨**（同轮收尾，使用者要求「改成类似列表/看板的按钮样式」）：
组里「选已有的/新建私有」、任务里「智能体/智能体组」、组/智能体详情/新建智能体的
「不配动作/配动作」全部从独立胶囊（`border-radius: 999px` + 细边框）改成顶栏
「列表/看板」同款分段轨：`var(--line)` 轨 + 2px 间隙 + 圆角矩形按钮（1.5rem 高、
`radius-sm`、无边框），活动态 `--accent-dim` 实心底白字。顺手修掉 Groups.svelte
自己那份还残留的 `--accent` 活动态（暗色主题白字看不见，与 Round-5 同一处修法）。

**组表单的「行动权限」补外框**（同轮收尾，使用者反馈"缺少一个类似上面审核者的外框"）：
`.picker-wrap` 补上与成员卡（执行者/审核者）同一套 `padding: var(--sp-3)` +
`1px solid var(--line)` + `radius` 的框，整张组表单变成一个一个的卡片框。

**任务「智能体/智能体组」轨道贴内容宽**（同轮收尾，使用者报"右侧被拉太长了"）：
`.pick-card` 是纵向 flex，块级子项默认被 `stretch` 拉满整卡宽，灰轨横贯 719px。
给 `.source-toggle` 钉 `width: fit-content`（156px），与顶栏 `page-actions`
（flex 行里的内容宽轨道）同一行为。

**「为什么选了个智能体还有审核者/动作」→ 清理 + 摘要空行不画**（2026-10）：
使用者选「助手」时摘要显示「审核者 助手审核员 / 允许的动作 1 个」——那是助手
遗留的 `reviewerAgentId`（Round-4 只摘了编辑界面、没清数据）。处理两步：
① 经 `PATCH /api/agents/:id` 清空 助手 的 `reviewerAgentId`（协议字段仍留，
   旧链逻辑照旧尊重它）；② 新建任务摘要**空行不画**：没配审核者就藏「审核者」
   行、一个动作都没配就藏「允许的动作」行（`gone` 例外——人没了必须说）。
   「助手」摘要从此只剩 执行者 + 返工；「文章写作员」仍有真实审核者则照显。

**摘要再简化两处**（2026-10 连续反馈）：① 选智能体时不画「返工」行——返工是
组专属设置（只有组能配返工次数，单智能体恒为不返工），无审核者时更是噪音；
② 摘要标题从「这次任务会怎么走」改为随选中对象走：智能体摘要 / 智能体组摘要，
并加粗（`.summary-title`，font-weight 700 + 正文色，与「交给谁」副标题区分）。

**技能页顶栏按钮顺序**（2026-10，使用者：设置应在刷新左侧）：原来
安装技能 → 刷新 → 设置，调整为 安装技能 → 设置 → 刷新。

**智能体页：去掉预览页，选中即编辑**（2026-10，使用者拍板：「选中智能体后是个
预览页，我不需要，应该和智能体组页一样的行为和布局」）：
· `AgentDetail` 删掉查看/编辑两态与 hero 头（头像/名字/角色徽章/编辑按钮），
  选中即进入可编辑表单：卡片第一行角色、名字/CLI、指令/技能、行动权限
  （审核者、收起），保存/取消在底部 `.form-actions`（与组表单同款）；
· 查看态整套（只读 chips、老标准的详情展示与「一键并进」按钮）随之删除——
  老标准内联的仍由「保存一次并进指令」处理（PATCH 侧逻辑未动）；
· `NewAgentForm` 同步去掉 hero，创建/取消移到底部，两页布局统一。

**组的「模式」从静态 chip 改成可选按钮**（2026-10，使用者：「给智能体组增加一个
角色选项，当前只支持工作流，选择方式类似于智能体选执行和审核」）：模式行的
静态 `mode-chip` 换成与智能体「执行/审核」同款的大按钮（`.role-card`，
strong + 提示两行、active 描边强调），放在表单最上方（名称之上）。目前
`GroupMode` 枚举只有 `workflow` 一个值，所以按钮常亮；未来加模式 = 枚举
加值 + 这里多出按钮，mode 才进草稿（PATCH 仍不收 mode，创建默认 workflow）。
新增词条 `groups.modeWorkflowHint`（执行 → 审核 → 行动）。

**配置区加「阶段头」，钉住执行 → 审核 → 行动**（2026-10，使用者：「我需要
在下面的配置中醒目体现在配置这 3 个行为」→ 选「阶段编号 + 名称头」方案）：
· 三个区块各加一个 `.stage-head`：accent-dim 圆角编号徽章（1/2/3，白字，
  暗色主题同样清晰）+ 阶段名 + 一句说明——
   1 执行 · 谁来做这件事 → 执行者卡
   2 审核 · 谁把关，不过就返工 → 审核者卡 + 返工次数（返工留在②区内）
   3 行动 · 判完可以触发哪些动作 → 行动权限框
· 新增词条 `groups.stageExec(Desc)/stageReview(Desc)/stageAct(Desc)`。

**智能体编辑页加「删除」按钮**（2026-11，使用者：「保存旁边缺一个删除按钮」）：
· `AgentDetail` 底部操作变 保存 / 删除 / 取消（删除用 ghost danger，与组页同款），
  先弹确认框（标题「删除智能体」+ 说明历史 run 保留快照）再删；
· 新增 daemon 路由 `DELETE /api/agents/:id`，两道闸都是「拒绝 + 说清下一步」：
  还是智能组成员 ⇒ 400（先移除）；是默认智能体 ⇒ 400（先换默认）。
  老 run 不挡（`agentRef` 快照，与组删私有成员一路的取舍）；
· web store 新增 `deleteAgent`（删完刷新列表）；测试 `agents-delete.test.ts` 4 条。

---

## 16. 第三轮收口：撤掉 agent 上的审核者与行动权限（2026-10，使用者拍板）

> 使用者原话：「**1. 需要完全移除 reviewerAgentId 的概念，不要遗留旧数据。至少我重新
> 保存智能体后，要移除旧数据 / 2. 彻底收掉审核者的行动权限**」

这是 §11 计划里的**阶段 4（退役老字段）**，前面两轮刻意留着没做。做得比原计划更彻底：
不只是"不再写"，而是**概念与数据一起清掉**。

### 16.1 撤掉了什么（agent 侧）

| 撤掉的 | 它原来是 | 现在由谁回答 |
|---|---|---|
| `Agent.reviewerAgentId` | "**这个执行者**的产出由谁审"（单向引用） | **智能体组**的审核者（组里那个 `role === 'reviewer'` 的成员） |
| `Agent.allowedActions` | "**这个审核者**判完之后允许触发哪些动作" | **智能体组**的 `AgentGroup.allowedActions` |
| `Agent.actionParams` | 那些动作的固定参数 | **智能体组**的 `AgentGroup.actionParams` |
| `Agent.debugActions` | 那些动作里标「调试」的子集 | **智能体组**的 `AgentGroup.debugActions` |
| `ReviewStandard.allowedActions` | 老数据的只读兼容字段（第一次搬家留下的） | 同上（中转字段一并撤掉） |

**为什么必须"彻底"而不是"以组为准、人也留一份"**：

- 同一个审核者在不同组里本来就该配**不同的权限**——挂在人身上只能共用一份；
- agent 上的 `reviewerAgentId` 是一条**看不见的隐式链接**：换个人审要去改**执行者**
  的设置，而界面上那条链（组页）看不出这件事；
- 两份来源并存时，"哪份说了算"只能靠注释记住——那正是当初把行动权限从审核标准里
  搬出来时想避免的问题（D40）。

### 16.2 run 侧**没有**撤（这一条是使用者明确要求的）

`Run.reviewerAgentId` / `Run.allowedActions` / `Run.actionParams` / `Run.debugActions` /
`Run.maxReworks` **全部保留**，语义一个字没改：它们是**这一次的事实**（组展开写进来，
或由客户端直接点名给的覆盖）。撤掉的只是"**agent 上**那份长期默认"。

所以 `run 上的三态`（省略 / `null` / id）照旧成立，`reviewerRunField()` 的判据
（省略 ≠ null）也照旧——只是"省略"现在等于**用组的默认**（没组 ⇒ 这条任务没有审核者）。
测试仍逐条钉着 `task-action-whitelist.test.ts`（含"不带组、直接点名审核者 + 给动作
⇒ 202"那条相反面，防止"没有组就不许有审核者"这种顺手实现）。

### 16.3 老数据怎么清（三层，缺一层都会留残渣）

store 里 agent 是**整条 JSON 记录**（file store 是 JSONL、sqlite 是 `json` 列），
读取路径上**没有 zod 校验**——所以**删掉 schema 字段不会删掉库里的键**。三层都要：

1. **启动时一次性清理**（`apps/daemon/src/agent-legacy-cleanup.ts`，`startDaemon` 时调）：
   用 `store.listAgentsRaw()` 读**原始**记录，命中老键就删键 + 刷新 `updatedAt` 写回，
   每个 agent 记一行日志、收尾再记一行汇总（"老 agent 记录清理完成：N 条记录"）。
   ⚠️ 这里必须走 `listAgentsRaw`：普通的 `listAgents` 已经被读时兜底清洗过，
   拿它做判据会让清理**永远是个空操作**（踩过一次——日志一条没有、库里键还在）。
2. **读时兜底**（`cleanAgent`，`packages/protocol/src/agent-legacy.ts`）：`GET /api/agents`
   与 `GET /api/agents/:id` 出去的那份一律不含老键，老 daemon 写下的记录也不会把它
   漏到界面上。
3. **保存时清掉**（`POST /api/agents` / `PATCH /api/agents/:id`）：写入前先剥离，
   使用者点一次保存就把那条记录彻底洗干净（这正是使用者说的"重新保存后要移除旧数据"）。
   另外**不认识的键直接 400**（错误里列出可改的字段名）——不然客户端塞一个
   `reviewerAgentId` 进来会被静默写进库，等于把刚撤掉的字段又请回来。

判别函数只有一处（`LEGACY_AGENT_KEYS` / `LEGACY_STANDARD_KEYS`），三个地方共用；
顺序一律"先删内联标准里那个键，再删 agent 上那三个"（报告里列出"删了什么"）。

### 16.4 直接后果（都对使用者说过）

1. **不选组 = 没有审核者。** 建任务页"选单个智能体"那一档永远没有人审——摘要里
   "审核者"那一行**必须写出来**（"选单个智能体不会自动审核；要审核请改选一个智能体组"），
   不能像以前那样"没配就不画"：不画等于把"你的产出不会有人看"藏起来。
2. **报告审核只能给结论。** 报告不属于任何组 ⇒ 这条链的动作白名单恒为空 ⇒
   判决里带动作一定被拦下（`invalid` / 交给人）。原来"报告审核也能触发动作"的
   用例因此改写成"**必须被拦下**"，动作真的触发的覆盖搬到组驱动的执行 run 上
   （`review-e2e.test.ts` 新增 `★ 动作只有挂在组上才会被执行`）。
3. **run 行投影从三态收成两态**：`'assigned' | 'none'`（`'follow'` 没了——没有可
   跟随的东西）。任务详情"这次由谁审"那一栏两态都画，并靠 `Run.groupId` 区分
   "来自组"与"这一次单独指定"（`/api/runs` 的行投影为此加了 `groupId`）。
4. **`reviewStandard.allowedActions` 的老回退链整条删掉**：界面不再有
   `effectiveAllowedActions()` / `allowedActionsFromLegacyStandard()`
   （回退的对象不存在了），`splitAllowedActions()` 这条与"挂在谁身上"无关的
   显示逻辑保留（组页与新任务页照旧用它）。

### 16.5 测试与文档

- 新增：`packages/protocol/src/agent-legacy.test.ts`（9 条，剥离函数的判据与 schema
  对齐）、`apps/daemon/src/agent-legacy-cleanup.test.ts`（5 条：重启清理 / 读时兜底 /
  保存时清 / 计划是纯函数 / 干净库是空操作）、`task-action-whitelist.test.ts` 两条
  （`group_not_applicable`、不带组的 run 级入口 202）。
- 改写：`reviewer-override.test.ts`（夹具从"执行者配审核者"改成"建一个组"）、
  `review-e2e.test.ts`（报告审核那条路改成"只能给结论" + 组驱动动作）、
  `newtask-chain.test.ts`（`follow` → `default`，配置来源整体搬到组上）、
  `agent-actions.test.ts`（删掉回退那一半，新增"智能体页里不许再有那三个键"的
  负向判据——web 的 `.test.ts` **不经类型检查**，所以这条只能靠读源码钉住）。
- 文档：`docs/runtime/pipeline.md` §0.3/§2.5/§3.0/§3.1/§3.1b/§3.4 与
  `docs/reference/agent-group-workflow.md`（§4/§7/§8）同步；本节即设计侧的记录。
