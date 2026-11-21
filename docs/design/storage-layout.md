# 落盘格式（存储地图）

> 这份文档回答一件事：**东西到底存在哪个文件里、哪个文件说了算、能不能直接改**。
> 讲的是"现在程序真会写出来的形状"，不是设想。还没落地的功能会在对应小节末尾单独标出（今天只有编排内建智能体）。
>
> 相关文档：[`architecture.md`](./architecture.md) §5（存储端口与适配器）、
[`agent-directory.md`](./agent-directory.md)（智能体目录化的设计与理由）、
[`../reference/skills.md`](../reference/skills.md)（技能手册）。

---

## 0. 三条不变式

这三条是**判据**，不是风格偏好。新加一种东西时先对一遍：

1. **结构化的进 json，成篇的正文进独立文本文件。**
   json 给机器读（会变、要校验、要索引）；正文给人读（要能 `cat`、能改、能 `git log`、
   能 diff）。`agent.json` 里**没有** `instructions`，正文在 `instructions.md`——
   这是同一个决定的两半。
2. **一个实体 = 一个目录**（而不是"一堆实体挤一个 JSON 文件"）。
   智能体是 `agents/<id>/`、技能是 `<root>/<slug>/`、编排是 `workflows/<id>/`（§7）、
   定时任务是 `schedules/<id>/`（§8）——都是「一个实体一个目录」。
   目录化换来三件好事：人能直接打开、删一个不影响别的、坏一个不会毁掉全部。
3. **权威只有一个。** 正文文件（`.md` / `.js`）是权威，索引记录里只留元数据；
   镜像文件的第一句必须写明"改它不生效"。
   两处都能改、谁赢说不清，是本仓库最恨的那类缺陷（"看起来生效了"）。

---

## 1. 五个根（+ 工作目录）

`~/.agentdeck/` 下面按**谁会去翻**分开。数据目录是"应用自己的事"，其余是"使用者的东西"：

| 根 | 缺省 | 放什么 | 为什么在这个位置 |
|---|---|---|---|
| 数据目录 | `~/.agentdeck/data` | store 记录、run 日志、blob、智能体目录、编排、定时任务、运行时受管配置 | 程序内部状态，刻意隐藏（`cli.ts` 的 `DEFAULT_DATA_DIR`） |
| 技能（安装的） | `~/.agentdeck/skills` | 每个技能的 `SKILL.md` + 支持文件 | 使用者会想打开看、想改 |
| 技能（提炼的） | `~/.agentdeck/skills-mine` | `source: 'mine'` 的技能正文，**同时是一个 git 仓库** | 提炼的和安装的**物理分离**（D80："不应该混在一起"），且要能回退 |
| 语音 | `~/.agentdeck/asr` | `vocab.json`、`settings.json`、`models/`、`models.lock.json` | 词表是个人习惯、模型几百 MiB，人要看得见（第 277 批） |
| 远端服务 | `~/.agentdeck/remote` | `remote.json`、`catalog-skills/`、`catalog-skills-local/` | 远端服务的库（账号/设定/公共目录），**不存使用者 payload** |
| 工作目录 | `~/agentdeck-workspace/<类型>-<id>/` | agent 的真实产出 | 刻意**不隐藏**：agent 写的东西要能在 Finder 里直接翻（§12） |

> 核心层的兜底值都在数据目录之内（`<dataDir>/skills`、`<dataDir>/asr`……），
> **绝不碰家目录**：测试与嵌入式调用忘了传参数时，不该在使用者家目录里造目录。
> 面向使用者的默认值只在 `apps/daemon/src/cli.ts` 一处算（`--skills-root` / `--asr-root` 可覆盖）。

---

## 2. 数据目录全图

```
~/.agentdeck/data/
├── meta.json                     { formatVersion, instanceId }
├── lock                          { pid, startedAt } 单进程锁
├── device.json                   { id, name, createdAt, lastSeenAt }
├── migrations.json               **迁移账本**（跑过哪些一次性迁移；§14）
├── workspaces.json               workspace 记录（普通 JSON 数组，**不是日志**，§6）
│
├── agents/<名字>/                ★ 一个智能体 = 一个目录（§3；**目录名 = 名字的 slug**，D231）
│   ├── agent.json                结构化（**不含指令正文**）
│   ├── instructions.md           指令正文（**组装前**：内置 = 身份块，自建 = 全文）
│   ├── memory.jsonl              它自己的记忆（权威；§5）
│   └── skills/<slug>/SKILL.md     它**独有**的技能（文件资产：不进技能库、不进技能页、不可卸载）
│
├── memory/<agentId>/MEMORY.md    记忆的**人可读镜像**（`memory/` 整个根是一个 git 仓库）
│
├── workflows/<workflowId>/       ★ 一条编排 = 一个目录（§7）
│   ├── workflow.json             结构化（**不含代码**）
│   ├── main.js                   编排代码本体
│   └── agents/<agentId>/         **编排内建智能体**（只在编排里有效）——与 agents/<id>/ 同形：
│       ├── agent.json            name / runtimeKey / skillIds …（不含指令）
│       ├── instructions.md       它的话
│       └── skills/<slug>/SKILL.md 它的独有技能（D228：注入通道按**来源**取目录，
│                                  不再要求"这个智能体在库里有一条 AgentId"）
│       ⚠️ 这一层**功能尚未落地**（`Workflow.inlineAgents` 字段已在、原语没接）；
│          落地的位置就是这里，别在别处再造一套"编排专用智能体"的存法
│
├── workflow-runs/<runId>.json    编排运行记录：一条运行一个文件
│
├── schedules/<scheduleId>/       ★ 一条定时任务 = 一个目录（§8）
│   ├── schedule.json             配置（cron / 执行者 / 启动方式 / 计数 / 上次触发）
│   ├── task.md                   任务模板正文（`{{date}}` 这些变量的宿主）
│   └── records.jsonl             触发记录（一行一条，最老在前，最多 50 行）
│
├── claude-config/                claude 的受管配置目录（D78，§11）
├── codex-config/                 codex 的受管 CODEX_HOME（§11）
├── tool-tmp/                     脚本临时目录（跑完即删）
│
└── workspaces/<wsId>/
    ├── log/<collection>.jsonl    append-only 权威记录（§10）
    ├── log/<collection>.jsonl.snapshot  压缩后的快照（只有 compact 过才有）
    ├── blobs/<前两位>/<sha256>   内容寻址（不可变，路径即摘要）
    └── runs/<runId>/messages.jsonl   这条 run 的消息流（§9）
```

> 一句话读法：**凡走 JSONL 日志的都是「会不断变化的业务记录」（`workspaces/<wsId>/log/`），
> 凡是一个实体一个目录的都是「一份配置 + 一篇人能读的正文」（`agents/` `workflows/`
> `schedules/`）**。两种形状不混用——日志用来记"它变过几次"，目录用来记"它现在是什么"。

---

## 3. 智能体 —— `agents/<id>/`

```
~/.agentdeck/data/agents/<名字>/
├── agent.json          结构化（**不含指令正文**；**`id` 在这里**，是身份）
├── instructions.md     指令正文（**组装前**：内置 = 身份块，自建 = 全文）
├── memory.jsonl        这个智能体自己的记忆（逐条 op 日志，§5）
└── skills/<slug>/SKILL.md   它**独有**的技能（文件资产，不进技能库、不进技能页、不可卸载）
```

**`agent.json` 里有什么**（一条真实记录，字段顺序为落盘顺序）：

```json
{
  "id": "01M2BK765WFDGEPXZR2SC8RXN8",
  "workspaceId": "01M2BK765DFY6N007DBF6QWDP4",
  "name": "助手审核员",
  "model": null,
  "runtimeKey": "default",
  "workDir": null,
  "skillIds": [],
  "toolIds": [],
  "env": {},
  "createdAt": 1789243136173,
  "updatedAt": 1795100185223,
  "reviewStandard": null,
  "memoryEnabled": false,
  "instructionsAssembled": false,
  "owner": "user",
  "entries": ["chat", "task", "workflow"]
}
```

平台成员还会带 `builtin: true` / `builtinKind`（老记录）、`owner: "platform"`。

⚠️ `toolIds` 是**历史字段**：工具包随动作能力退场（D123），协议里已经删了这个键，
所以只有老记录里还留着 `"toolIds": []`；新写入不会再出现它。同理 `reviewStandard`
只剩"老数据的判断依据正文"一个作用（搬家入口还在），`instructionsAssembled` 只有迁移过的老记录才有。

| 文件 | 谁写 | 谁读 | 语义 |
|---|---|---|---|
| `agent.json` | `writeAgentDir()`（`packages/store-file/src/agent-dirs.ts`） | `readAgentDir()` | 结构化信息；**永远不含 `instructions`** |
| `instructions.md` | 同上 | 同上（读回时拼成一条 `Agent.instructions`） | 组装**前**正文 |
| `memory.jsonl` | store 端口 `insertMemoryEntry` | `listMemoryEntries` | 记忆的**权威** |
| `skills/<slug>/SKILL.md` | store 端口 `writeExclusiveSkill(owner, …)` | `listExclusiveSkills(owner)` | 这个智能体独有的技能（**按来源定位**，见下） |

**目录名 = 名字的 slug，身份仍是 `agent.json` 里的 `id`**（D231，方案 D）：

| | 是什么 | 会不会变 | 谁在用 |
|---|---|---|---|
| `agents/<目录名>/` | **标签**（`助手审核员`） | 改名就跟着改（`slugForAgentName(name)`） | 人（Finder / 终端里一眼认出来） |
| `agent.json` 的 `id` | **身份**（ULID） | **永不变** | 程序：`Run.agentRef.id`、`Issue.assignee`、`conversation.agentId`、`platformSlots`、`executorId`、`MemoryEntry.agentId` |

带来的三件事：

1. **改名不再动引用**：改名 = 改 `name` 字段 + 改目录名，8 处引用一个都不动（id 没变）；
2. **解析不能拼路径了**：`FileStore` 维护 `id → 目录名` 的内存索引（启动时 `readdir` 建，**miss 时全量重扫一次**自愈）；磁盘是真相，缓存只是缓存；
3. **两个访问器**：`getAgentById(id)`（历史/快照/槽位）与 `getAgentByName(name)`（人给的句柄；撞名返回 `ambiguous`，**不猜**）。

目录名的规则见 `packages/store-file/src/agent-slug.ts`：保留中文、ASCII 转小写（APFS 大小写不敏感）、
非法字符折 `-`、长度 60、点开头与 Windows 设备名加 `agent-` 前缀；slug 撞车加 `-2` / `-3`。

> 迁移（一次性，`migrations.json` 记 `agent-dir-names`）：`agents/<ULID>/` → `agents/<名字>/`，
> 两步 rename（大小写不敏感的文件系统上直接改会 `EEXIST`），**`agent.json` 里的 id 一个字都不改**。
> 实测（真数据拷贝）：11 个智能体全部改名，按 id 仍能取到人、`instructions.md` 跟着目录走。

**独有技能按「来源」定位，不按 `agentId`**（D228，2026-11）：

| 来源 | 目录 | 谁能用 |
|---|---|---|
| `{ kind: 'agent' }` | `agents/<id>/skills/` | 智能体页里的那条记录 |
| `{ kind: 'workflow-agent' }` | `workflows/<wid>/agents/<aid>/skills/` | **编排内建智能体**（不在库里、没有 AgentId） |

> ⚠️ **目录名是小写 `skills/`**（D229，2026-11 使用者定的）。文件名仍然是 `SKILL.md`
> ——那是技能规范约定的**文件**名，与目录名无关，别跟着改。
> 老盘上的 `SKILL/`（大写）在开库时**自动改名**：两步 rename（先 `skills.tmp-<随机>` 再
> `skills`）——大小写不敏感的文件系统（macOS 默认 APFS）直接改大小写会报 `EEXIST`；
> 两个目录同时存在时**不合并**，只在启动日志里点名叫人处理（合并技能目录等于猜哪一份对）。

改之前端口上那四个方法第一个参数就是 `agentId`——于是"独有技能放在哪"被硬绑在
"这个智能体在库里有一条记录"上，编排内建智能体就无法带独有技能（而它恰恰最需要）。
现在参数是 `ExclusiveSkillOwner`（描述符），**目录由存储实现解析**：
`agent` 那一种的形状归 `agent-dirs.ts`，`workflow-agent` 的归 `workflows-dirs.ts`，
daemon 在装配 `FileStore` 时把"owner → 目录"的解析函数注入进去
（`FileStoreOptions.exclusiveSkillsDir`）。**路径词汇不进端口**（FR-STOR-03 那条机器判据）。

注入那一层（`apps/daemon/src/agent-injectable-skills.ts`）也因此只剩**一份实现**：
入参从"一个 `Agent`"改成 `SkillSources`（工作区 + 库 id 清单 + 独有技能来源），
两种来源读出来的 payload 逐字相同——判据在 `apps/daemon/src/agent-injectable-skills.test.ts`。

**为什么 `agent.json` 不含指令**：人打开目录看到的应该是"这个智能体自己的话"（`.md`），
机器要的是字段（`.json`）。混在一起，改一句话就得动结构，而且 diff 出来满屏 JSON。

**组装前 vs 组装后**：内置成员存的是**身份块**，平台守则由 `effectiveInstructions()`
**运行时**拼（`apps/daemon/src/builtin-drafter.ts`）。所以"改平台守则"不该改写每一条
内置的记录；`instructionsAssembled === true` 只出现在老数据（那时存的就是全文），读时不再拼。

**坏文件的语义（刻意这样）**：
- `agent.json` 读不到 ⇒ 这条当**不存在**（`readAgentDir` 返回 `null`），跳过继续读别的目录；
- `instructions.md` 读不到 ⇒ 正文空串——内置会被启动自愈补回，自建的会露出"指令空"。

---

## 4. SKILL —— 一个技能一个目录

```
~/.agentdeck/skills/<slug>/                ← 装进来的（source: github / local）
├── SKILL.md                               ← 权威正文
└── references/…                           ← 支持文件（任意相对路径）

~/.agentdeck/skills-mine/<slug>/SKILL.md   ← 自己提炼的（source: 'mine'），**整个根是 git 仓库**
```

**正文在磁盘、索引在日志**（2026-10 起，没有例外）：

| 在哪 | 有什么 |
|---|---|
| `<root>/<slug>/SKILL.md` + 支持文件 | **权威**：正文与全部文件。改这里就生效 |
| `log/skill.jsonl`（一条 put 记录） | 索引与元数据：`id` / `workspaceId` / `slug` / `name` / `description` / `source` / `sourceRef` / `version` / 时间 |

> ⚠️ 层次要说清：**索引是按 workspace 的**（`workspaces/<ws>/log/skill.jsonl`），
> **正文是全局一个根**（`skillsRoot`，跨 workspace 共享）。同一个 slug 在两个 workspace
> 里装两次，盘上是一份文件、日志里是两条索引。

**新记录不再带 `body`**（正文在磁盘上）。老记录里仍可能有 `body` / `allowedActions` /
`verdictSchemaVersion`——那是 2026-10 之前的形状，**只读兼容**，不迁移、不重写。

三条配套纪律：
- **覆盖安装先清空再写**（`writeSkillFiles`）：上一版有、这一版没有的支持文件必须消失，
  否则"磁盘为准"下会留着幽灵文件，下次注入又被写进工作目录；
- **支持文件路径必须待在技能目录里**（拒 `..`、绝对值、`\` 开头、盘符开头——Windows 形态也挡）；
- **`skills-mine` 是 git 仓库**：daemon 自动 commit，人能 `git log` 看"这条什么时候沉淀的、怎么变的"。

**注入到工作目录时的归属清单**：`<workDir>/<skills.dir>/.agentdeck-managed.json`
（内容 `{ slugs: [...] }`；**它落在工作目录的注入目录里，不在技能根里**——技能根本身没有
任何清单文件，`<root>/<slug>/` 下只有 SKILL.md 与支持文件）。清理时读的是**这份盘上的清单**，不是内存里的数组——
所以哪怕参数传错，也删不到使用者自己放的技能；清单读不到/坏掉 ⇒ 当空（**宁可少删**）。

---

## 5. 记忆 —— 权威在 store，镜像给人看

| 位置 | 角色 |
|---|---|
| `agents/<agentId>/memory.jsonl` | **权威**。逐条 `{seq, at, op: 'put'\|'del', id, value}`（与 `log/*.jsonl` 同一种日志形状） |
| `memory/<agentId>/MEMORY.md` | **镜像**（人可读，四类小标题：约定 / 偏好 / 事实 / 教训）。`memory/` **整个根是一个 git 仓库**（commit 形如 `memory 文章写作员（5 条）`）。**文件头明写"改它不会生效"** |

- 记忆**跟着智能体走**（D112）：删智能体连目录一起删，不留孤儿。
- 镜像按 **id** 分目录（改名不搬家）。
- 注入时按 `sortMemoryForInjection` 排序（置顶 → 类别 → 时间），这是唯一排序出处。

> 一个看起来能改、改了却没用的文件，比没有这个文件更糟——所以镜像是**明写的不生效**。

---

## 6. 工作区登记表 —— `workspaces.json`（D226，2026-11 已落地）

```
~/.agentdeck/data/workspaces.json     一个普通 JSON 数组（今天 1 条），整文件原子写
```

**改了之前是什么**：`workspaces.jsonl`——与 issue / run 那些**业务集合**共用同一套
append-only 日志。真机上量到的样子：**一个**工作区、**87 行**、**67 KB**（每次保存设置都是
`put`，整条记录再追加一份），而且当时 `compact()` **没有任何生产调用点** ⇒ 只增不减
（D227 补上了回收，见 §10）。
迁移后同一个工作区是 **1060 字节 / 1 条**。

| 文件 | 角色 |
|---|---|
| `workspaces.json` | workspace 记录（`locale` / `defaultAgentId` / `defaultRuntimeKey` / 三档模板 / `memoryPrefixes` / `localSkillDirs` / `runtimeConfigIsolation` / **`platformSlots`** 槽位表 / 时间），整文件原子写 |
| ~~`workspaces.jsonl.migrated`~~ | D226 时是留档；**D227 起迁移核对通过就删掉**（启动时还会扫一遍数据目录根，清掉历史遗留的 `.migrated`） |

为什么日志对 workspace 没有用（逐条对照 `log.ts` 头注释里那三个理由）：
历史——没有任何代码读它的历史，界面上也没有「工作区版本 / 回滚」；回放导入——那是给
业务实体用的；崩溃安全——整文件原子写（tmp → fsync → rename）给的是**同一个**保证。

> ⚠️ **这份文件是「数据目录的总钥匙」**：`#stores`（每个 workspace 的日志、runs、blobs）
> 全是按它登记的 id 打开的。它丢了，daemon 会新建一个「默认工作区」（新 id）——
> 界面看起来数据全没了，而文件其实还在 `workspaces/<老 id>/` 里。所以装载时有一条
> **按数据自愈**的兜底（见下），这是这一轮比"省空间"更重要的那半。

**装载三步**（`FileStore.#loadWorkspaces`）：

1. 读 `workspaces.json`（正常路径）；
2. 读不到且老 `workspaces.jsonl` 还在 ⇒ **回放**（`put` 覆盖 / `patch` 合并 / `del` 删除）
   成最后状态、写进新文件、**核对通过后删掉老文件**（D227；核对不通过就原样留着并报错）；
3. 还是空的、或**登记表缺了盘上有的工作区** ⇒ **按数据重建**：来源是
   `workspaces/<id>/` 目录 **+** `agents/<id>/agent.json` 里的 `workspaceId`
   （智能体是平铺的，不属于哪个工作区目录——只扫目录会在"只有智能体"的数据目录上一无所获）。
   名称在目录里没有留档 ⇒ 用默认名，并打一条 `info` 说清。

> 实测（真数据的一份拷贝）：首开把 87 行回放成 1 条（`locale: zh` / `runtime: codex` /
> 5 个槽位 / 2 个本地技能目录全都还在），老文件核对通过后被删除；
> 手工删掉 `workspaces.json` 再开 ⇒ 打印「登记表缺了盘上已有的 1 个工作区，已按数据重建」，
> 11 个智能体照常读得到；第三次开没有任何迁移/自愈日志（幂等）。

## 7. 编排 —— `workflows/<id>/`（D224，2026-11 已落地）

```
~/.agentdeck/data/workflows/<workflowId>/
├── workflow.json     结构化（id / name / source / templateKey / inlineAgents / 时间）——**不含代码**
└── main.js           编排代码本体（纯文本）——与 instructions.md 同一个角色

~/.agentdeck/data/workflow-runs/<runId>.json    一条运行一个文件
```

**改了之前是什么**：`workflows.json` / `workflow-runs.json` 各是一个大数组（真机上 1 条 /
848 B 与 23 条 / 47 KB），整文件原子替换；读失败是 `catch { return [] }`——
**一个坏字节 = 编排页全空，而且日志里一个字都没有**。

| 智能体 | 编排 | 作用 |
|---|---|---|
| `agents/<id>/agent.json`（不含正文） | `workflows/<id>/workflow.json`（不含代码） | 机器读的结构化信息 |
| `agents/<id>/instructions.md` | `workflows/<id>/main.js` | 人读的正文，磁盘为准 |

三条随之而来的行为（都在 `apps/daemon/src/workflows-dirs.ts`）：

1. **写**：`saveWorkflow()` 写这一条的两份文件（都原子写）；`saveWorkflowRun(run)` 只写
   **这条运行**的那个文件——引擎每步都会 persist 一次，以前每次都重写全部 23 条。
2. **读**：**逐条读、逐条报**。`workflow.json` 坏掉 ⇒ 那一条跳过 + 报错误，其余照常；
   `main.js` **缺了** ⇒ 那一条**照样列出**（代码为空）+ 报错误——"元数据在、代码丢了"
   必须让使用者看见（列出来他才知道该把代码贴回去），而不是让编排悄悄从页面上消失。
   启动日志把迁移条数与每一条错误都打出来（`info` / `warn`）。
3. **删**：`DELETE /api/workflows/:id` 删的是**定义目录**；运行记录在**另一棵目录**，
   刻意不跟着删（任务页里那条 issue 还指着它的运行记录）。

**迁移**（`migrateLegacyWorkflows` / `migrateLegacyWorkflowRuns`，启动时自动跑一次）：
老文件里的每条落成目录（目录已存在就跳过），然后**回读核对**（新存储读得回来、条数不少于迁入的）
——通过才**删掉**老文件（D227：不再留 `.migrated` 档）。老文件是坏 JSON ⇒ **报错、不删**
（迁移不许掩盖坏数据）。幂等：跑完就没有原名文件了，再跑直接返回 `null`。

> 实测（真数据的一份拷贝）：1 条编排 + 23 条运行 → `workflows/01M7DP…/` 一个目录
> （`workflow.json` 无 code、`main.js` 339 字）+ `workflow-runs/` 23 个文件；
> 老文件核对通过后被删除；第二次跑 `migrated: null`。

**还没做**：编排内建智能体（`Workflow.inlineAgents`，现在恒为 `[]`）。它落地时按
`agents/<id>/` 的形状在编排目录里加 `agents/<agentId>/{agent.json,instructions.md}`
（§2 的全图里已经把这一层画进去了，并标了"功能尚未落地"）——
**现在不建空目录**（那叫造死结构）。

**它要不要也带 `skills/<slug>/`（文件资产）？形状上可以，但第一版刻意不做。**
判断依据是"有没有第二个真相 / 有没有编辑落点"：

| 方案 | 代价 | 结论 |
|---|---|---|
| 只带 `skillIds`（**引用技能库**里的技能） | 零：`loadAgentInjectableSkills` 已经在做"库 id → 注入"，inline agent 只是多传一份 id | ✅ **第一版就这个**，覆盖"这一步的人该带哪几份参考资料" |
| 带 `skills/<slug>/SKILL.md`（**该编排独有**的文件资产） | 注入通道现在只从 `agents/<id>/skills/` 读（`store.listExclusiveSkills(agent.id)`，而 inline agent 没有库 id）；更要紧的是**编排页只有代码编辑器**，加了就是"盘上有文件、界面上没有落点"的死接口 | ⛔ 先不做；真要做，形状是 `workflows/<id>/agents/<agentId>/skills/<slug>/SKILL.md`（与 `agents/<id>/` 逐字同形），并且**必须同时**给编排页一个"内建智能体 → 它带的技能"面板 |

> 口径一句话：**能引用就别复制。** 库技能是共享的（`skillIds` 引用，改一处全生效）；
> 只有"这条编排专属、且使用者真会去编辑"的东西才值得落成文件资产——而"真会去编辑"
> 的前提是界面上有入口，否则它只会变成盘上的孤儿。

## 8. 定时任务 —— `schedules/<id>/`（D225，2026-11 已落地）

```
~/.agentdeck/data/schedules/<scheduleId>/
├── schedule.json     结构化配置（cron / 执行者 / 启动方式 / 计数 / 上次触发）——**不含任务正文**
├── task.md           任务模板正文（`{{date}}` 这些变量的宿主）
└── records.jsonl     触发记录，一行一条（**最老在前**），最多 50 行
```

**改了之前是什么**：一个 `schedules.json` 大数组（真机 3 条 / 64 KB，其中三条任务正文分别是
**6564 / 6628 / 11150 字**，全塞在 json 字符串里）；读失败是 `catch { return [] }`——
文件一坏就表现为「一条定时任务都没有」，而**定时任务没了 = 到点什么都不再发生**。
这比「少显示一行」严重得多，所以这一轮的重点有一半在「读账要说话」。

| 文件 | 角色 |
|---|---|
| `schedule.json` | 配置（你在界面上改的东西）：`id / name / enabled / cron / executorType / executorId / workDir / resumeMode / triggerCount / lastRunId / lastTriggerAt / 时间` |
| `task.md` | 任务模板正文——与 `instructions.md`、`main.js` 同一个角色（人写的 prompt 不进 json） |
| `records.jsonl` | 「它干过什么」：一行一条 `{ triggeredAt, runId, issueId, status, note }`；界面上仍是「新的在前」（读回时反转） |

三条随之而来的行为（`apps/daemon/src/schedules-dirs.ts`）：

1. **写**：`saveSchedule()` 写这一条的三份文件（都原子写），**最后**写 `schedule.json`
   ——它是这个目录的「存在证明」（列表只认它）。触发一次 = 更新计数 + 一条记录，同样只写这一条。
2. **读**：**逐条读、逐条报**。配置坏 ⇒ 跳过那条 + 报错误；`task.md` 缺 ⇒ **照样列出**
   （正文空）+ 报错误；`records.jsonl` 里**坏一行只跳过那一行**（一行一条换来的好处）。
3. **删**：删整条目录（配置 + 正文 + 记录一起走）。这里与编排刻意不同——编排的运行记录
   挂在任务页那条 issue 上，所以删定义不删历史；而定时任务的记录**只属于它自己**，
   连它一起删是对的。

**迁移**（`migrateLegacySchedules`，启动时自动跑一次）：口径与编排那次逐条相同——
目录已存在就跳过；迁完**回读核对通过才删** `schedules.json`（D227）；老文件是坏 JSON ⇒
报错且**不删**；幂等（跑完再跑返回 `null`）。

> 实测（真数据的一份拷贝）：3 条 → 3 个目录（`schedule.json` 的键里没有 `taskText` / `records`），
> 老文件核对通过后被删除，第二次跑 `migrated: null`。新建 / 改正文 / 删除走 HTTP
> 也各验过一遍（改的是 `task.md`，删的是整个目录）。

## 9. run、消息流、会话

| 位置 | 内容 | 权威 |
|---|---|---|
| `workspaces/<ws>/log/run.jsonl` | run 记录（一条 run 一行 put，状态变化是 patch） | **权威** |
| `workspaces/<ws>/runs/<runId>/messages.jsonl` | 这条 run 的消息流（`{type, seq, at, tool, content, input, output, …}`，**只追加不修改**） | **权威** |
| `workspaces/<ws>/log/{conversation,chat-turn}.jsonl` | 对话本体 + 回合 | 权威 |

**刻意没写 `runs/<runId>/run.json`**：run 记录已经在 `run.jsonl` 里，再存一份就是
**双份真相**，迟早不一致。`runs/<runId>/` 只放消息流。

**消息流为什么单独存**：一次 run 可能几千条消息，而实体记录是低频状态变更。
混在一起会让实体日志压缩得又大又频繁。消息**只追加**，所以不需要 `JsonlLog` 那套索引，
只维护内存里的 `lastSeq`。

**智能体的聊天回复不在 `chat-turn` 里**：它就是那条 run 的 `messages`（存两份必然分叉）。

---

## 10. 集合白名单与历史残留

`packages/store-file/src/file-store.ts` 的 `COLLECTIONS` 是**读哪些集合**的白名单，今天 12 项：

| 集合 | 状态 |
|---|---|
| `issue` / `comment` / `conversation` / `chat-turn` / `run` / `artifact` / `audit` / `inbox` | **在用**（有写入方、有消费方） |
| `skill` | **在用**（只留索引，正文在磁盘，§4） |
| `agent` / `memory` / `tool` | **只剩读**：智能体与记忆已目录化（§3/§5），工具包已退场（D123）——这三个名字**没有写入方，端口上也没有消费方**，留着只是历史包袱（删掉不影响数据，只是那几个老文件不再被读进索引） |

**磁盘上还躺着、程序完全不读的**（不在白名单里）：`group.jsonl` / `report.jsonl` /
`verdict.jsonl` / `action.jsonl`——对应的能力逐个退场了，文件**不删**（那是使用者的历史）。

**白名单就是这条边界的实现**：名单外的文件不会被读、更不会被连带删除；名单内坏掉的一行
也只影响那一条记录，不会拖垮整份。

**压缩（compact）＝ 唯一能把日志变小的机制**（D227 起**每次开库自动跑**）：
把当前状态物化成 `log/<collection>.jsonl.snapshot`，再删掉增量日志。
顺序不可颠倒——**先 fsync 快照落地，再删日志**（反过来崩溃会同时丢两者 = 清空工作区）。

判据是两条比例式，**任一**成立就压（`JsonlLog.pendingOps` 是 D227 为此加的）：

| 判据 | 算式 | 抓的是哪种 |
|---|---|---|
| 历史很长 | `pendingOps > max(200, 3 × 现存记录数)` | `run.jsonl`（状态来回改）：2811 条历史 / 397 条现存 |
| 日志很肥 | `字节数 > max(512 KB, 4 × 现存记录的字节数)` | `skill.jsonl`（老记录带正文副本）：4.4 MB / 13 条索引 |

只盯条数会漏掉第二种——实测 `skill.jsonl` 按条数算才 88 条，压不动。

> 实测（真数据拷贝）：`skill.jsonl` 4.3 MB → 0（快照 6 KB，13 个技能正文照样读得回来）、
> `run.jsonl` 1.2 MB → 0（快照 407 KB，397 条运行完好），整个 `log/` 从 **6.9 MB → 415 KB**。
> 启动日志逐条打出"从多少降到多少、现存几条"——省了多少必须看得见。

**两个入口**（都不用重启 daemon）：

| 从哪按 | 怎么按 | 看见什么 |
|---|---|---|
| 设置页「成本」卡 | 一行「日志占用 1.4 MB」+ 一颗「压缩」（`btn--secondary`）；压完 toast「已压缩，省下 3.2 MB」并**重新拉一次占用** | 体积 + 省了多少 |
| CLI | `pnpm run cli storage` / `pnpm run cli compact`（`--human` 给人看，默认 JSON） | 同上的数字（JSON 给 agent 用） |

两者打的是同一对接口：`GET /api/maintenance/storage`（按集合列出 `logBytes` / `snapshotBytes`）
与 `POST /api/maintenance/compact` ⇒ `FileStore.compactNow()`。它在**活着的 `JsonlLog` 上**压：`compact()` 自己关掉追加句柄、
写快照、删日志，之后再有写入自动重建文件——所以运行中的 daemon 调它是安全的。
⚠️ 反过来**不许**外部脚本直接改这些文件：那会让追加句柄指向一个已被删除的 inode，
重启后这段时间的写入就没了（这也是为什么这件事必须由 daemon 自己做）。
返回体：`{ ok, compacted: [{ workspaceId, name, before, after, records }], freed }`。

---

## 11. 运行时受管配置与临时目录

| 位置 | 是什么 | 硬约束 |
|---|---|---|
| `claude-config/` | claude 的受管配置目录，run 时 `CLAUDE_CONFIG_DIR` 指向它（D78） | ① **绝不放工作目录**（agent 能读自己的工作目录，放那儿等于把 key 递给它）；② **跨 run 稳定复用**（会话状态在 config dir 下，每 run 新建会让 `--resume` 找不到） |
| `codex-config/` | codex 的受管 `CODEX_HOME`，同一个理由 | 同上；复制失败时退化为"不注入"（= 关掉隔离的样子），并记一条 note |
| `tool-tmp/` | 脚本类动作的临时目录（本次一个子目录，跑完 `finally` 里递归删） | 只放临时产物 |

隔离的目的只有一个：**用户级的 skill / MCP 不进任务**（`~/.claude/skills/` 里的个人
skill、`~/.claude.json` 的 `mcpServers` 会拉起 npx/浏览器，天然在任务边界之外）。
认证不丢的做法是把 `~/.claude/settings.json` 的 `env` 复制进受管目录。

---

## 12. 工作目录（不隐藏，agent 的产出在这里）

```
~/agentdeck-workspace/<类型>-<id>/            类型 = chat / issue / crystal …；id = 对应实体的 ULID
├── <agent 写的东西>                          ← 真实产出，人直接看这个
├── .agentdeck/rounds/<轮次>-task.md          ← 这一轮收到的任务（原文）
├── .agentdeck/rounds/<轮次>-result.md        ← 这一轮的产出（多轮不覆盖）
└── <skills.dir>/<slug>/SKILL.md              ← 本次注入的技能（跑完只删平台自己放的）
```

- 轮次 = `chainDepth + 1`（首轮 1）。落盘在**清理之后**：目录已收拾干净，而这两份是我们自己的文件。
  它是"上次那一版到底写了什么"的出处，落盘失败不拦执行，但要记 warn。
- **第一句话的副本已经不再落盘**（2026-09 撤）：看 run 日志就够（①②③ 分开带标签、不截断）。
- 不隐藏是刻意的：藏在 `~/.agentdeck/data/work/` 里等于找不到。

---

## 13. 写盘纪律（所有落点共用）

1. **整文件写 = 原子替换**：`atomicWrite()` 先写 `path.tmp-<pid>-<时间戳>`，`fsync`，
   再 `rename`（Windows 有重试）。所以任何时刻读到的都是**完整**的旧文件或新文件。
2. **追加写每次 fsync**（`AppendHandle`）：本机写入量低，用性能换正确性划算。
   **测试里可关**（`fsync: false`），生产不许关。
3. **覆盖一个目录先清空再写**（技能）：否则旧版本的幽灵文件会被当成这一版的一部分。
4. **并发写的 tmp 名要带随机后缀**（编排的 `persist` 会在多处 await 交错，
   两个同毫秒的 `Date.now()` 会撞名：先 rename 的移走源文件，后者 ENOENT）。
5. **坏文件要说话**：能逐条读的地方逐条报（目录化的智能体/技能）；只读一个文件的地方
   至少不要让"静默空数组"冒充"没有数据"（旧编排/定时任务存储就是反例：D224 / D225 已改）。
6. **不写双份真相**：同一条事实只有一个权威落点（`run.json` 刻意不写就是这条）。

---

## 14. 迁移纪律（含迁移账本 `migrations.json`，D230）

- **幂等**：再跑一次不重复做。现存的三个启动迁移都在 `FileStore.open()` 里按序跑一次：
  `#migrateAgentsToDirs`（老 `log/agent.jsonl` → 目录）、`#migrateMemoryToAgentDirs`
  （workspace 级记忆 → `agents/<id>/memory.jsonl`，孤儿丢掉并计数）、
  `#migrateSkillsToDisk`（老记录里的正文 → `<skillsRoot>/<slug>/`）；
  字段级的那个是 `migratePlatformMemberFields`（`owner` / `entries`）。
- **只补缺的**：已经有新字段的记录一律不动（那是迁移过的，或是使用者后来改的）。
- **不删老字段/老文件**：`builtin` / `builtinKind` / 老 `skill.jsonl` 的 `body` 都留着——
  回滚只需发旧版代码。真正删除由人确认（有过一次："可以删老 agent.jsonl 了"）。
- **启动时点名**：迁了几条、哪条是坏的（半内置、编排引用不可引用的人），
  启动日志要说出来——只报不改。

### 14.1 迁移账本（`<dataDir>/migrations.json`，D230）

```
{ "exclusive-skills-dir-case": { "v": 1, "at": 1795271524550 } }
```

一份普通 JSON：**跑过的迁移记一条**，之后启动只读这一个文件，再一条条 `has()` 都是内存判断。

**哪一档用账本，有明规矩**（写在 `packages/store-file/src/migrations.ts` 的清单上方）：

| 判据的代价 | 处理 | 现在属于这一档的 |
|---|---|---|
| **贵**（要 `readdir` 目录 / 读多个文件；成本随数据量涨） | **登记到账本、门住** | `exclusive-skills-dir-case`（D229：readdir 全部智能体 + 每人 1–2 次 stat） |
| **便宜**（一次 `stat` / 一次内存遍历） | **不门住，每次跑** | 智能体目录化（`.migrated` 标记）、记忆目录化（每个工作区一次 stat）、技能落盘（内存遍历看有没有 `body`）、编排/定时任务/workspace 三处（"老文件还在吗"） |

为什么便宜的**不能**门住：账本一旦被删、或者有人从备份恢复一份老数据，门住的那条就
**再也不会为它跑一次**——那是把正确性押在一个可能被删的文件上。而账本自己的定位是
**加速层**（迁移本身仍然幂等），所以：删掉 `migrations.json` = 让它们重跑一遍，最坏慢一次。

三条纪律：
1. **键一经发布不许改**（改了等于新迁移）；规则变了要重跑就把 `v` +1；
2. **每条迁移跑完立刻落盘**（原子写）——迁移中途崩掉时，已经跑完的应该算数；
3. **账本坏了当空、但要说话**（打一行日志），不能让存储打不开。

> 实测（真数据拷贝，`FileStore.open()` 连开 5 次）：**30 / 15 / 18 / 14 / 13 ms**
> （第一次含一次性迁移与压缩）。同一轮把 `#compactIfNeeded` 里唯一一处
> `JSON.stringify(全部活记录)` 换成了**快照文件 stat**（判"该不该压"够用，只花一次 stat）——
> 于是启动路径上**没有任何 O(数据量) 的迁移判断**了，剩下的 O(数据量) 只有
> `JsonlLog.open()` 回放日志（那是加载状态，压缩过之后只剩快照 + 增量）。

---

## 15. 谁钉着这些形状

| 形状 | 判据 |
|---|---|
| `agent.json` 不含指令、`instructions.md` 存组装前正文、缺文件不炸 | `packages/store-file/src/agent-dirs.test.ts` |
| 技能正文落盘、`skillsRoot` 落点、覆盖安装清空旧支持文件、拒绝越界路径 | `packages/store-file/src/file-store.test.ts`、`apps/daemon/src/skills-install.test.ts`、`apps/daemon/src/skill-exec-check.test.ts` |
| 日志 append-only、patch 绝对赋值、compact 顺序 | `packages/store-file/src/file-store.test.ts` |
| workspace 登记表：普通 JSON（不追加）、老 `.jsonl` 回放迁移、按目录/智能体自愈、半坏补齐 | `packages/store-file/src/file-store.test.ts`（D226 那 4 条） |
| 开库自动压缩（条数判据与字节判据都要见效）、迁移留档清理（`agents/.migrated` 是标记不许动） | `packages/store-file/src/file-store.test.ts`（D227 那 2 条） |
| 定时任务的目录形状、记录一行一条与顺序、坏条 / 缺 `task.md` 报错、迁移与幂等 | `apps/daemon/src/schedules.test.ts`（存储 7 条 + 整链 3 条） |
| 编排的目录形状、逐条报错、缺 `main.js` 仍列出、老文件迁移与幂等、删除只删定义 | `apps/daemon/src/workflows.test.ts`；端上另有 `template-e2e.test.ts`、`startup-reconcile.test.ts` |
| 记忆目录化与镜像 | `apps/daemon/src/{memory,memory-files}.test.ts` |
| 注入的归属清单（`.agentdeck-managed.json`） | `packages/agent-core/src/skill-injection.test.ts` |
| 测试不许写进真实家目录 | `tests/test-safety.test.ts`（禁 `tmpdir()`、禁对危险目录递归删） |
