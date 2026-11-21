# 智能体目录改用名字（方案 D，2026-11 定稿）

> 使用者逐轮拍板后的**最终设计**（不是讨论稿）。原始诉求："想一眼看出 `agents/` 下每个目录是谁"；
> 期间否决了"名字当键"（会断历史、要跨库事务）与"迁移改写历史"（破 `RunPatch` 白名单、改不干净）。
>
> **一句话**：**目录名 = 名字（slug）给人看，`agent.json` 里的 `id` 还是身份**。存进去的引用永远是 id，
> 查的时候可以按名字查。两者靠"目录 ↔ id"的索引对上。

---

## 1. 形状

```
~/.agentdeck/data/agents/
├── 智能体生成者/                  ← 目录名 = slug(name)
│   ├── agent.json                { "id": "01M72Y8XZRYQ0F643Z3Y2N8A1D", "name": "智能体生成者", … }
│   ├── instructions.md
│   ├── memory.jsonl
│   └── skills/<slug>/SKILL.md
└── 文章写作员/
```

`memory/<agentId>/MEMORY.md` 的镜像目录**跟着一起用名字**（`memory/智能体生成者/MEMORY.md`），
在改名时与 agent 目录同一步处理。

> ⚠️ `agent.json` 里**没有新增字段**：`id` 本来就在。这一轮唯一的改动是
> **目录名从 id 换成名字**，以及**解析方式从"拼路径"换成"查索引"**。

---

## 2. 三种用途，三套规矩（这是整个设计的地基）

| 用途 | 用什么 | 落点 | 为什么 |
|---|---|---|---|
| **存进记录**（引用） | **id**（ULID，永不变） | `Run.agentRef.id`、`Issue.assignee.id`、`Conversation.agentId`、`ChatTurn.agentId`、`Workspace.defaultAgentId`、`Workspace.platformSlots` 的值、`Schedules.executorId`、`MemoryEntry.agentId` | 存名字的话，一改名这些记录集体失效（跨库事务 + 改写历史，已否决） |
| **人给的句柄**（查） | **名字** + 工作区 | 编排 `agent('写作员')`、聊天选人、CLI、界面跳转 | 这才是人想写的 |
| **显示**（历史"当时是谁"） | `agentRef.name` 快照 | run 详情、任务派给谁、审计 | 快照**不改**，否则就是伪造历史 |

**硬规矩（会成为判据）**：**名字只用来查，绝不当键存进记录。**
唯一例外是 `agentRef.name` 这类"当时的名字快照"——它不参与查找。

---

## 3. slug 规则（目录名怎么算）

1. **保留中日韩字符**（`智能体生成者` → `智能体生成者`）：本机工具，人能认最重要，不拼音化；
2. **ASCII 转小写**（`Writer` → `writer`）：避开 macOS 大小写不敏感导致"两个目录其实是一个"；
3. **非法字符 → `-`**：`/ \ : * ? " < > |`、控制字符、空白；
4. **压掉连续 `-`、去掉首尾 `-`**；空结果 ⇒ `agent-<序号>` 并提示改名；
5. **长度上限 60**（UTF-16 码元），超长截断；
6. **保留名加前缀 `agent-`**：`.`、`..`、以 `.` 开头、Windows 设备名（`CON` `PRN` `AUX` `NUL` `COM1..9` `LPT1..9`）；
7. 真名回归实测：现有 11 个名字**零冲突**。

---

## 4. 同名与目录冲突

- **名字唯一性维持现状**：`duplicateNameOf()` 按**工作区**查重（D164），`Writer` 与 `writer` 仍算两个不同名字（与今天一致，不动）；
- **跨工作区允许同名**（使用者定）：两条「写作员」在各自工作区里合法；
- **目录名冲突规则**（只在撞车时生效）：首选 `<slug>`；撞了用 `<slug>-2`、`<slug>-3`……再撞用 `<slug>-<id 后 6 位>`；每次冲突在启动日志点名；
- 目录名只是**标签**：`id` 才是唯一键，所以目录名冲突不影响任何引用。

---

## 5. 解析：内存索引 + 自愈

```
getAgentById(id)              → 内存 Map(id → 目录名) → 读 agents/<目录名>/agent.json
getAgentByName(ws, name)      → listAgents(ws) 里按 name 精确匹配（唯一性由 D164 保证）
```

- **索引 miss ⇒ 全量扫一次**（`readdir(agents/)` + 读每个 `agent.json`），扫到就补进索引；
  这是"外部手改目录 / 从备份恢复 / 索引还没建"的自愈路径；
- 不额外维护 `agents/index.json`：**磁盘是真相，内存只是缓存**（多一份索引文件就是第二个真相）；
- 性能：正常路径 O(1) 内存查表；miss 才 O(#智能体) 扫一次。今天 11 个智能体。

---

## 6. 改名（唯一"要同时动两处"的操作）

今天：改名 = 写一个 `name` 字段（一次原子写）。

改成 D 之后：

1. 算新 `slug = slugify(newName)`，检查 slug 冲突（第 4 节）；
2. 写 `agent.json`（`name` 已由调用方改好）——**`id` 一个字节都不动**；
3. `rename` 两个目录：`agents/<旧slug>/` → `agents/<新slug>/`，`memory/<旧slug>/` → `memory/<新slug>/`
   ——**两步 rename**（先 `.tmp-<随机>` 再目标名；macOS 大小写不敏感，D229 踩过）；
4. 更新内存索引；
5. 任何一步失败 ⇒ 报出来并把已改的目录还原（rename 反向再走一遍）。**8 处引用一个都不动。**

⚠️ 已知失败场景：Windows 上目录被占用 ⇒ rename 失败（与 D229 同一类）；此时**改名整体失败**并在界面/日志明说，不许"名字改了目录没改"这种半路状态。

---

## 7. 老数据迁移（一次性，ledger 记名）

1. 体检（只读）：扫 `agents/*/agent.json`，算 slug、查冲突、查非法名；
   有不可自动解决的 ⇒ **停下点名**，不猜；
2. 逐个：`rename agents/<ULID>/ → agents/<slug>/`（两步）＋ 同样的 `memory/<ULID>/ → memory/<slug>/`；
3. **不动任何引用**（id 没变）——这是 D 相对 C 最大的收益；
4. `migrations.json` 记 `agent-dir-name: {v:1}`（D230 的账本，判据贵 ⇒ 门住）；
5. 对账：跑一遍"每个 id 都能解析到目录"，把悬空点名。

---

## 8. 端口与调用点

- `store.getAgent(id)` 拆成 **`getAgentById(id)`** 与 **`getAgentByName(workspaceId, name)`**；
- **不做** `getAgent(idOrName)` 的魔法分派（"猜这个字符串是 id 还是名字"没有定义）；
- 生产代码 **37 处** `getAgent(` 要各选一个：
  - 绝大多数是历史/快照里带 id（`run.agentId`、`agentRef.id`、`slots`、`executorId`、`memory.agentId`）⇒ `getAgentById`；
  - 少数是"人给的名字"（编排解析、CLI、界面按名字跳转）⇒ `getAgentByName`；
- `resolveWorkflowAgent(name)` 改为走 `getAgentByName(ws, name)`，**保留**它现有的两道校验（重名歧义、入口 `workflow`）；
- 前端不用 `getAgent`：它拿 `/api/agents` 列表，本地按 id 或名字找。

---

## 9. 判据

1. **slug 规则**：非法字符 / 大小写 / 保留名 / 长度 / 空名，表驱动；
2. **目录名冲突**：同名跨工作区 ⇒ `写作员`、`写作员-2`，且两条都能按 `getAgentById` 取回；
3. **索引自愈**：外部把目录改成任意名字 ⇒ 下一次 `getAgentById` 扫到并解析成功；
4. **对账（只报不改）**：目录名 ≠ `slug(name)` 时打一行日志，**不擅自 rename**；
5. **名字只查不存**：全库扫描——`run.agentRef.id` / `issue.assignee.id` / `conversation.agentId` /
   `slots` 值 / `executorId` / `memory.agentId` 必须都是存在的 **id**；写入 name 当键 ⇒ 红；
6. **改名后引用 0 悬空**：改名后全部 8 处引用照旧可解析（因为没动）；
7. **改名事务性**：rename 失败时目录与索引都回到旧状态，且日志/界面明说；
8. **迁移幂等**：迁移跑一半中断再跑，目录名最终正确、引用未变。

---

## 10. 明确不做（连同理由）

| 不做 | 理由 |
|---|---|
| 名字当**键**（方案 C） | 改名 = 跨库事务（≈900 条 patch，且随历史增长）；历史断链无解 |
| 迁移改写历史记录 | `RunPatch` 白名单明确不允许改 `agentRef`；审计与快照里的旧名改不干净；开了这个口子以后会有人改别的 |
| `Agent.aliases` | D 方案下 id 不变，历史天然不断链 ⇒ 不需要 |
| `AgentId` 类型改名 | 值也没变（还是 ULID），只是目录名变了 ⇒ 不值得动 12 处签名 |
| `agents/index.json` | 磁盘是真相；多一份索引文件就是第二个真相 |
| `getAgent(idOrName)` 魔法分派 | "这是 id 还是名字"没有定义 |

---

## 11. 顺序与风险

| 步 | 内容 | 风险 |
|---|---|---|
| 1 | slug 规则 + 冲突规则（纯函数 + 判据） | 低 |
| 2 | 索引解析（`id ↔ 目录名` + miss 重扫）+ `getAgentById` | 低 |
| 3 | `getAgentByName(ws, name)` + 37 处调用点分类替换 | 中（机械但要过一遍语义） |
| 4 | 写盘按名字建目录（`writeAgentDir`）+ 老数据迁目录（ledger 记名） | **中高**（一次性动盘） |
| 5 | 改名事务（name + 两个目录 + 索引 + 回滚） | 中高（日常路径，失败必须可见） |
| 6 | 对账（只报不改）+ 文档同步 | 低 |
