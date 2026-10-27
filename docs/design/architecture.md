# AgentDeck 架构文档

> 🏗️ **这份文件是给要动这个代码库的人的**：系统由哪些部件组成、它们之间怎么说话、
> 数据存在哪里、哪条不变量在哪一行代码上被强制、想改某件事该去哪几个文件。
>
> 它回答的是**"现在的代码长什么样"**，而不是"当初打算做成什么样"：
> 每一个结论都能在代码里指到具体文件（引用一律写成 `路径:行号` 或 `路径`）。
> 与其他文档的分工见下面这张表——**不要在这里找需求编号的来龙去脉**。

| 文档 | 回答什么 | 读它的时机 |
|---|---|---|
| [`../README.md`](../README.md) | 怎么跑起来、怎么用、安全边界 | 第一次接触这个项目 |
| [`../srs/requirements.md`](./../srs/requirements.md) | **要做什么**：FR-* / INV-* / NFR-*、决策记录 D1–D49 | 想知道"为什么要有这条规则" |
| [`design.md`](design.md) | **设计意图与逐轮演进**：架构选型、schema 设计、每一轮补齐的取舍 | 想知道"为什么是这样而不是那样" |
| **`architecture.md`（本文）** | **当前实现的结构**：模块、依赖、接口、数据落点、不变量强制点、代码索引 | 要改代码、要评审、要接手 |
| [`../runtime/pipeline.md`](./../runtime/pipeline.md) | 一条 run 从受理到收尾的**逐步走查**（含逐字 prompt） | 排查"这次到底跑了什么" |
| [`../reference/scenarios.md`](./../reference/scenarios.md) | 端到端使用场景与边界情况 | 想确认行为是否符合预期 |

**一句话概括这个系统**：它把外部报告收进来，让**本机的另一个 agent** 按你写的标准审，
只有审过了才触发**有界的动作**；审不过就把意见交回执行者重做。判决是闭合结构
（结论 / 理由码 / 严重度 / 证据 / 动作），只有一处开放字段留给模型自由发挥。

---

## 1. 系统总览

### 1.1 运行时拓扑

三个进程 + 一个静态产物。**浏览器是唯一的远端通道**，daemon 不向远端服务发请求。

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ 浏览器（页面由 daemon 托管 ⇒ 与 daemon 同源）                                 │
│                                                                              │
│   apps/web 构建产物（静态文件，apps/web/dist/）                               │
│     ├── 同源  ──▶  http://127.0.0.1:4517/api/*        ← 全部权威数据与操作    │
│     └── 跨源  ──▶  http://127.0.0.1:4518/api/*        ← 账号/设定/目录/统计   │
└──────────────────────────────────────────────────────────────────────────────┘
        ▲                                                    ▲
        │ 托管静态文件 + 本地接口                             │ 页面直连
        │                                                    │
┌───────┴──────────────────────────────┐        ┌────────────┴──────────────────┐
│ apps/daemon  本机 daemon（4517）      │        │ apps/remote  远端服务（4518） │
│                                      │        │                               │
│ · 托管 Web UI（apps/web/dist）        │        │ · 账号注册/登录               │
│ · 全部权威数据（FileStore）           │        │ · 用户设定                    │
│ · 执行 run（spawn agent CLI）        │        │ · 公共工具包目录              │
│ · 审核收口 → 判决 → 动作              │        │ · 第三方查询转发              │
│ · 脚本动作执行（工具包）              │        │ · 记录/统计接收               │
│ · SSE 实时流                          │        │ · 插件系统                    │
└───────┬──────────────────────────────┘        └───────────────────────────────┘
        │ spawn（以启动 daemon 的 OS 用户身份）
        ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ agent CLI（claude / generic …）  ← 适配层：packages/agent-core + agent-*     │
│ 工作目录：~/agentdeck-workspace/<类型>-<id>/（agent 的真实产出）           │
└──────────────────────────────────────────────────────────────────────────────┘

另有两条独立入口（都是 daemon 的**客户端**，不共享生命周期）：
  apps/cli  ──HTTP──▶ daemon（人与脚本用）
  apps/mcp  ──HTTP──▶ daemon（stdio JSON-RPC，供别的 agent 驱动）
```

### 1.2 四个部件的职责与边界

| 部件 | 拥有什么 | 不做什么 |
|---|---|---|
| **daemon** | 全部权威数据、run 执行、审核收口、动作执行、审计 | 不向远端服务发请求（唯一例外：从 GitHub/本地路径装 skill 时自己下载，见 §9.3） |
| **页面（web）** | 视图与交互；**代 daemon 与远端通信** | 不持有权威状态；不能单独跑（`dev:web` 只是把 `/api` 代理到 daemon） |
| **远端（remote）** | 账号、设定、公共工具包目录、**推荐技能目录**（只读一个目录，见 §11.3）、**管理页**（`apps/remote/web`，只读 + 重新同步按钮）、第三方查询转发、记录统计 | 不存**使用者的**任何 payload（prompt / 报告 / 日志只上报摘要）；**不抓取技能**（不碰 `api.github.com`、没有一行抓取代码）；不经手安装；权威记录不在它那里。⚠️ 公共技能目录里的**第三方内容**是它唯一会存的第三方文件——那是"目录"这件事的代价，所以内容落在一个目录里、不进代码仓库，清单里只有 URL 与自写说明（D50） |
| **共用 UI**（`packages/ui/`） | 设计令牌 + 基础组件样式（`src/styles/app.css`）+ 主题判定（`src/theme.ts`） | 不含任何页面与数据逻辑：daemon 界面与远端管理页都 import 它，"风格相似"靠这个而不是靠各抄一份 |
| **同步工具**（`tools/skill-catalog-sync/`） | 读推荐清单、联网抓 GitHub、校验、**原子替换**目录 | 不是服务、不监听端口、不知道谁是使用者；与远端服务**只有目录这一条约定**，没有代码依赖（2026-10 A 案，见 §11.3） |
| **CLI / MCP** | 无状态客户端 | 不提供"提交任意 run"（那等于开放代码执行入口，见 §7.4） |

### 1.3 端口与默认路径（都写死，不随机）

| 项 | 默认值 | 定义处 |
|---|---|---|
| daemon 端口 | **4517** | `apps/daemon/src/cli.ts` 的 `DEFAULT_PORT` |
| 远端端口 | **4518** | `apps/remote/src/cli.ts` |
| Vite 开发端口 | 5173（`/api` 代理到 4517） | `apps/web/vite.config.ts` |
| 数据目录 | `~/.agentdeck/data` | `apps/daemon/src/cli.ts` 的 `DEFAULT_DATA_DIR` |
| 工作目录根 | `~/agentdeck-workspace` | `apps/daemon/src/workdir.ts` 的 `defaultWorkRoot()` |
| 远端数据目录 | `~/.agentdeck/remote` | `apps/remote/src/cli.ts` |

端口是**固定**的：被占用时 daemon **大声失败**，不静默换端口——随机端口意味着"重启后
地址变了"，而地址会被写进书签与配置里，漂移比端口冲突更难排查。

**数据目录 vs 工作目录**（刻意分开，理由不是洁癖）：

| | 数据目录 | 工作目录 |
|---|---|---|
| 是什么 | 程序**内部**状态（JSONL、锁、blob 日志） | agent 的**真实产出** |
| 在哪 | `~/.agentdeck/data`（隐藏） | `~/agentdeck-workspace/<类型>-<id>/`（**不隐藏**） |
| 为什么 | 使用者不需要看到它 | 产出放在找不到的地方等于没有产出——要能用 Finder 打开或 `cd` 进去 |

每个任务一个目录（`<类型>-<id>`），**同一个任务的重试会落回同一个目录**；
目录**根**一改会连带把旧目录搬过去（`migrateLegacyWorkRoot`：三个条件都满足才搬，
跨盘 `EXDEV` 只警告**不删源**）。

### 1.4 关键设计原则（在代码里的落点）

| # | 原则 | 落点 |
|---|---|---|
| P1 | 页面是唯一通路；daemon 不外联 | `apps/daemon/src/server.ts` 全文无对外 `fetch`，除 `@agentdeck/skill-source`（那是刻意的例外，见 §7.3） |
| P2 | 词汇单一来源 | 状态、原因码、动作名、接口契约全部在 `packages/protocol/src/` |
| P3 | 存储是端口，不是实现 | `packages/domain/src/ports/store.ts`；领域层不认识任何存储实现 |
| P4 | 注入即所有权，可逐字节回滚 | `packages/agent-core/src/skill-injection.ts` |
| P5 | 判决窄、产出物宽 | `packages/protocol/src/verdict.ts`：闭合 schema + 唯一开放字段 `finding.detail` |
| P6 | 差异集中到表 | runtime 差异 → `packages/agent-core/src/runtime-table.ts`；工具差异 → 工具包清单 |
| P7 | 宁可失败，不可静默降级 | 沙箱拿不到工具就抛（`agent-core/src/sandbox.ts`）；端口占用大声失败（`daemon/src/cli.ts`） |

---

## 2. 仓库结构与依赖方向

### 2.1 目录布局

```
agentdeck/
├── apps/
│   ├── daemon/       本机服务：Web UI 托管 + 全部本地接口 + 执行 + 审核 + 动作
│   ├── web/          Web UI（Svelte 5 + Vite 6）——产物是纯静态文件
│   ├── remote/       远端服务（含 catalog/ 公共工具包目录）
│   ├── cli/          命令行客户端（daemon 的客户端）
│   └── mcp/          对外 MCP server（stdio）
├── packages/
│   ├── protocol/     契约单一来源：实体 / 枚举 / Verdict schema / 本地接口类型
│   ├── domain/       领域层：状态机 / 不变量 / 路由 / 回路边界 / 审核决策 / 审计
│   ├── store-file/   Store 端口实现 v1（JSONL + 内容寻址 blob）——**当前默认**
│   ├── store-sqlite/ Store 端口实现 v2（SQLite）——已实现，daemon 未接线
│   ├── agent-core/   与具体 CLI 无关的适配层：描述表 / argv / 第一句话 / 注入 / 沙箱
│   ├── agent-claude/ Claude Code 适配器（首版参考实现）
│   ├── agent-generic/ 第二个 CLI 适配器（证明可插拔，而非"多支持一个厂商"）
│   ├── agent-codex/  codex app-server 适配器（**第一个 service 形状**：JSON-RPC，无 run 级 argv）
│   └── i18n/         界面词表（中/英）+ 机器值的标签映射
├── docs/             文档（本文在其中）
├── examples/tools/   可照抄的本机工具包示例
├── packages/ui/      两个前端共用的设计系统（令牌 + 基础组件样式 + 主题判定）
├── tools/            独立工具（不属于任何 app 的运行时）
│   ├── layout-probe/    界面布局探针（真浏览器量布局）
│   ├── skill-catalog-sync/ 推荐技能目录的同步工具（抓 GitHub 写目录，远端服务只读它）
│   └── remote-ui-probe/    远端管理页的界面探针（真浏览器量布局并断言）
├── tests/            仓库级自动检查（如"测试里不许出现 tmpdir()"）
└── ref/              上游行为分析材料（参考输入，**不是本项目文档**）
```

### 2.2 依赖方向（单向，无环）

```
protocol  ←  domain  ←  store-file / store-sqlite
    ↑          ↑
    └──────────┴────  agent-core  ←  agent-claude / agent-generic / agent-codex
                            ↑
                      apps/daemon ──▶ apps/web(静态产物)
                      apps/remote / apps/cli / apps/mcp
```

已核验的事实：

- `packages/protocol` 只依赖 `zod`，**不依赖任何内部包**（`packages/protocol/src/index.ts`）。
- `packages/domain` 只依赖 `@agentdeck/protocol`（外加 `zod` 与 `node:crypto` 两处直接使用：
  `actions/definition.ts`、`actions/tool-actions.ts` 用 zod，`audit/export.ts` 用 `createHash`），
  **不 import 任何存储实现**。
- `agent-core` 依赖 `protocol`，**不依赖 `domain`**——这正是"脱敏逻辑只能有一份"的原因：
  适配器只如实上报命令行，脱敏由调用方用 `domain` 的 `redactArgv` 做
  （见 `packages/agent-core/src/backend.ts` 的 `onCommandLine` 注释）。
- `apps/daemon` 是唯一的装配点：它认识所有包，其他 app 都不认识 daemon 的内部模块
  （`apps/mcp/src/server.ts` 开头明确写了"它是 daemon 的客户端，不是 daemon 的一部分"）。

### 2.3 为什么没有构建步骤（后端）

`tsconfig.base.json` 设了 `erasableSyntaxOnly: true`，并禁用 `enum` / `namespace` /
构造函数参数属性。因此后端直接由 **Node 的类型擦除**执行 `.ts`，没有编译产物：
`pnpm run daemon` 就是 `node apps/daemon/src/cli.ts`（入口前面还有一层版本守卫，见下）。

⚠️ **门槛是 Node ≥ 22.6**，不是"≥ 22"——类型擦除是 22.6 加进来的、**22.18** 起才默认开
（23.x 那条线要 **23.6**），低于 22.6 报 `ERR_UNKNOWN_FILE_EXTENSION`（实测 22.17 也会报）。
所以所有 `pnpm run` 命令（含 `test`）前面套了一层**普通 JavaScript** 的版本守卫
（`scripts/node-entry.mjs`，写成 `.mjs` 是必须的：守卫写在 `.ts` 里跑不到，
node 连那个文件都加载不了）：它分三档——默认可用就把 `process.argv` 掰回"入口直接跑"的样子再
`import()`；**22.6–22.17 / 23.0–23.5 自动补 `--experimental-strip-types` 重跑一层**；
低于 22.6 给一句能照做的话。`engines` 相应是 `>=22.6`。见 `docs/reference/windows-compat.md`。

这条约束反过来影响了整个代码风格
（所有枚举都是 `as const` 数组 + 派生类型，见 `packages/protocol/src/enums.ts`）。

---

## 3. 契约层：`packages/protocol`

**职责**：全项目词汇与接口形状的唯一出处。daemon、页面、远端都从这里取类型。

| 文件 | 行数 | 定义什么 |
|---|---|---|
| `src/ids.ts` | 159 | 品牌 ID（`RunId` / `VerdictId` / `ActionId` … 15 个，编译期不可混用）、`BlobRef`（`sha256:<64hex>`）、ULID 生成 |
| `src/enums.ts` | 299 | 全部闭合枚举：`RunStatus` / `RunKind` / `VerdictConclusion` / `ReasonCode` / `Severity` / `VerdictStatus` / `ActionStatus` / `IssueStatus` / `RunFailureReason` / `NamespacedActionType` … |
| `src/verdict.ts` | 514 | Verdict 闭合 schema、围栏提取、判决契约渲染 |
| `src/tools.ts` | 263 | 工具包清单 schema（`ToolManifest`）、参数规格（开放/绑定）、`Tool` 实体 |
| `src/entities.ts` | 1047 | 核心实体：`Workspace` / `Device` / `Agent` / `Skill` / `Tool` / `Issue` / `Comment` / `Report` / `Run` / `VerdictRecord` / `Action` / `Artifact` / `AuditRecord` / `InboxItem` |
| `server/index.ts`（`apps/web`） | 静态资源服务（Vite 产物）。⚠️ **缓存头是正确性**：`/assets/*`（带内容哈希）⇒ `immutable` + 一年；**外壳 `index.html` ⇒ `no-cache`**（每次核对）＋ ETag，带 `If-None-Match` 回来问时回 304。别把外壳设成 `immutable`——重建之后浏览器会一直用旧外壳，而旧外壳指向的旧包已经被每次构建清掉了。这条规矩来自一次真实误判（"聊天页不工作、任务页正常"，实际是没刷新的旧标签页）：**原来一个缓存头都不发**，浏览器拿那份外壳没有任何办法。布局探针三条钉住（外壳不盲目缓存、产物 immutable 且 304、身份里报出 `webBuild`） |
| `src/local-api.ts` | 643 | 本地 HTTP + SSE 契约：`SubmitRunRequest` / `RunEvent` / `IdentityResponse`，以及三个版本常量与 `Capability` 标志 |

### 3.1 闭合与开放的分界（P5）

`Verdict` 是 `strictObject`（多余键直接拒绝）：

| 字段 | 形状 | 约束 |
|---|---|---|
| `schemaVersion` | `1`（literal） | 版本化策略的锚点 |
| `conclusion` | `pass` / `fail` / `needs_human` | 三值闭合 |
| `reasonCode` | 闭合共享枚举（`ReasonCode`） | 不许自由发挥 |
| `confidence` | `0..1` | |
| `findings[]` | `severity` + `summary` + `evidence[]` + **`detail?`** | `detail` 是**唯一开放字段** |
| `action` | `ActionRef` 或 `null` | 形状只有 `<包 slug>.<动作名>`；**没有 `plane`**（INV-13） |
| `escalateReason` | `string ≤ 500` 或 `null` | 两条出口规则见下 |

两条由 `superRefine` 强制的出口规则（`packages/protocol/src/verdict.ts`）：

1. `needs_human` 必须给非空 `escalateReason`（INV-5）；反之，非 `needs_human` 时它必须为空。
2. **`fail` 不得带 `action`**（D45）——`fail` 的出口是"返工"，不是"处置"。

缺省 ≡ `null`：`EvidenceRef` 的三个字段、`action`、`escalateReason` 都做 nullish → `null` 归一，
所以"键在不在"与"值是 null"没有区别——**"必填"只留给真正承载判断的字段**。

判决契约文本由 `renderVerdictInstruction({allowedActions, toolActions})` 生成：
枚举取值与示例**从 schema 本体派生**，所以 schema 改了、给模型的说明自动跟着改。

### 3.2 本地接口契约与版本

`packages/protocol/src/local-api.ts` 里三个独立版本号（各自独立演进）：

| 常量 | 值 | 管什么 |
|---|---|---|
| `LOCAL_PROTOCOL_VERSION` | `1` | 本地 HTTP/SSE 接口 |
| `AUDIT_EXPORT_FORMAT_VERSION` | `1` | 审计导出文件 |
| `DATA_SNAPSHOT_FORMAT_VERSION` | `1` | 数据快照导出/导入 |

`Capability` 标志让客户端**探测**而不是猜服务端版本：
`sse-resume` / `artifacts` / `reviewer-override` / `task-action-whitelist` / `human-verdict` /
`issue-abandon` / `conversation-skills` / `conversation-files`。
`GET /api/identity` 返回 `protocolVersion` + `deviceId` + `runtimes[]` + `capabilities[]` + `webBuild`，
页面据此决定要不要显示某个入口。**判据是"漏掉它的后果会不会静默"**：请求体那层没有

`webBuild` 是**对称的那一半**：`capabilities` 回答"daemon 是哪一版"，它回答"界面是哪一版"（daemon 从构建产物 `index.html` 里读出 `index-<hash>.js` 这个名字）。加它的理由是一次真实误判——使用者报"聊天页不工作、任务页正常"，查下来 daemon 与当前前端都是好的，他看的是一个**早就开着、没有刷新**的标签页；这类错位**两边都不报错**，只能靠一句可查的话。界面把它显示在「设置 → 关于」里，所以"我在跑哪一版"不必去猜。
zod 校验，所以旧 daemon 会**忽略**不认识的字段——于是"界面说做了、实际没做"而两边都不
报错。`conversation-skills` 正是这一档（`Conversation.skillIds`）：没有它时，界面上
"没人挂的 skill"不给选项，并说明重启 daemon 之后就有（有主的 skill 不受影响）。

### 3.3 工具包清单（`src/tools.ts`）

一个工具包 = 一个目录 + 一份 `tool.json` + 一个或多个入口脚本。

- `schema: 'agentdeck/tool@1'`——**不认识就明确拒绝**，不猜。
- `runtime` 是白名单：`node` / `shell` / `python3`。
- 每个动作（`ToolActionSpec`）声明：`name`（kebab）、`summary`、`entry?`、
  `reversible`（不可回滚的会在界面上标出来）、`dryRun: supported | unsupported`、
  `timeoutMs`（1s–10min，默认 60s）、以及参数。
- 参数分两类，**这是安全设计的关键**：
  - **绑定参数**（`BoundParamSpec`）：值由平台在执行时注入，模型**看不见**——
    `literal` / `subject.issueId` / `subject.runId` / `workspace.id` / `workdir`。
  - **开放参数**（`OpenParamSpec`）：模型在判决里填，**每一种都有上限**——
    `string`（≤ 20000，默认 1000）/ `integer`（min/max）/ `boolean` / `enum`（1–50 个取值）。
    **没有无界的 string**。
- 同一个动作里 open 与 bound 不许同名（refine 拒绝）。

---

## 4. 领域层：`packages/domain`

**职责**：状态机、不变量、路由、回路边界、审核决策、审计。纯逻辑，不碰 IO
（唯一的例外是 `node:crypto` 的哈希，且只用于校验和）。

```
packages/domain/src/
├── errors.ts              DomainErrorCode（7 个码）+ DomainError / IllegalTransitionError / ReviewerMustDifferError
├── ports/store.ts         Store 端口（唯一的存储抽象，见 §4.1）
├── state/
│   ├── run.ts             Run 状态机（8 态）
│   ├── verdict.ts         Verdict 状态机（8 态）
│   └── action.ts          Action 状态机（8 态）+ 幂等键
├── review/
│   ├── distinct.ts        INV-1~3：reviewer ≠ executor
│   └── pipeline.ts        decideReview：判决 → 八种决策
├── loop/
│   ├── bounds.ts          回路边界：深度上限 + 环检测（INV-14~16）
│   └── chain.ts           沿 derivedFrom 边重建链路
├── routing/kind.ts        报告 → 审核者路由；agent 的技能子集求解
├── actions/
│   ├── definition.ts      ActionDefinition 形状 + validateActionAllowed
│   └── tool-actions.ts    工具包动作定义、参数绑定/校验/合并（879 行，纯函数）
└── audit/
    ├── record.ts          redactArgv 脱敏 + buildAuditRecord
    ├── export.ts          审计导出 + 校验和 + 成本聚合
    └── snapshot.ts        数据快照导出/导入（存储无关通道）
```

### 4.1 Store 端口（`src/ports/store.ts`）

领域层声明能力，适配器实现。方法按实体分组：

| 分组 | 方法（节选） |
|---|---|
| 生命周期 | `formatVersion()` / `close()` |
| Workspace / Device | `getWorkspace` / `insertWorkspace` / `getDevice` / `upsertDevice` |
| Agent | `getAgent` / `listAgents` / `insertAgent` |
| Skill | `getSkill` / `listSkills` / `listSkillsByIds` / `insertSkill` / `deleteSkill` |
| Tool | `getTool` / `listTools` / `getToolBySlug` / `insertTool` / `deleteTool` |
| Issue / Comment | `getIssue` / `listIssues` / `insertIssue` / `transitionIssue` / `listComments` / `insertComment` |
| Report | `listReports` / `findReportByDedupKey` / `getReport` / `insertReport` |
| Run | `getRun` / `listRuns` / `insertRun` / **`transitionRun(id, expect, next, patch?)`** / `findRunHoldingWorkDir` / `findActiveRunForSubjectAgent` |
| 消息流 | `appendRunMessage` / `listRunMessages(since?)` / `lastRunMessageSeq` |
| Verdict | `getVerdict` / `listVerdictsByRun` / `insertVerdict` / `transitionVerdict` |
| Action | `getAction` / `listActionsByVerdict` / `findActionByIdempotencyKey` / `insertAction` / `transitionAction` |
| Artifact | `listArtifactsByRun` / `insertArtifact` |
| 内容寻址 | `putBlob` / `getBlob` / `hasBlob` |
| 审计 / 通知 | `appendAudit` / `listAuditsByRun` / `appendInboxItem` / `listInboxItems` / `markInboxItemRead` |

**`transition*` 是 CAS（compare-and-swap）**：带 `expect` 参数，状态不符就返回 `false`，
调用方据此重读重试。这个形状是并发安全的基础（见 §7.5）。

### 4.2 三台状态机

三张转移表都是 `Readonly<Record<Status, readonly Status[]>>`，**终态没有出边**——
"重试"永远是新建一条记录，不是复活旧的（DR-3「历史不得被覆盖」的直接后果）。

**Run**（`state/run.ts`，8 态）

```
deferred ──▶ queued ──▶ dispatched ──┬──▶ running ──┬──▶ completed
                 ▲                   │              ├──▶ failed
                 │                   └──▶ waiting_local_directory
                 └────────────────────────────┘  （目录释放后重新排队）
   ↑ 任一非终态均可 ──▶ cancelled / failed
```

`waiting_local_directory` 与 `queued` 都有通向 `failed` 的边，理由是**daemon 重启**：
状态是持久化的，上次退出时还在排队的 run 再也不会有结果，把它们记成 `cancelled`
等于"在数据里撒一个谎"（那段注释就在 `state/run.ts` 里）。

**Verdict**（`state/verdict.ts`，8 态）

```
pending_verdict ──▶ emitted ──▶ validated ──┬──▶ dispatched_to_action
      ▲                 │                   ├──▶ advisory
      │                 │                   ├──▶ escalated
      └── retry ────────┴──▶ invalid ───────┘
                          （三条出口：retry / downgrade_to_advisory / escalate）
                      validated ──▶ rework_requested（D45：判决要求返工）
```

`invalid` 是**独立失败类型**：模型没按格式输出 ≠ 进程崩了，两者的正确应对相反
（前者更常见的是标准没说清，继续重试只是烧 token）。`rework_requested` 是终态——
"重做"是另一条 run、另一条 verdict 记录。

**Action**（`state/action.ts`，8 态）

```
proposed ──┬──▶ auto_approved ──▶ executing ──┬──▶ executed ──▶ rolled_back
           ├──▶ awaiting_approval              └──▶ failed
           └──▶ skipped（幂等命中）
```

幂等键 `actionIdempotencyKey({verdictId, type, params})` **必须含 `verdictId`**：
同一判决重放要去重，但不同判决产生的相同动作**不能**被去重——否则多视角审核里
第二个 agent 的同样的真实发现会被静默吞掉。幂等命中进 `skipped`（不是静默成功），
所以"这次没执行"在审计里是可见的。

### 4.3 不变量 → 强制点

**这张表是本文最重要的一张**：每一条不变量都指到真正强制它的那一行。

| 不变量 | 含义 | 在哪强制 | 强制的形态 |
|---|---|---|---|
| INV-1~3 | reviewer ≠ executor，不得静默降级 | `review/distinct.ts` 的 `assertReviewerDistinct()`；调用点 `apps/daemon/src/server.ts`（`POST /api/runs` 写入之前）、`autoChainReview` | 抛 `ReviewerMustDifferError` |
| INV-4 | 判决默认走向机器可执行，不是"等人批准" | `state/action.ts` 转移表：`proposed` 的默认边是 `auto_approved` | `awaiting_approval` 在实现里**没有生产调用点** |
| INV-5 | 升级必须带结构化原因码 | `protocol/src/verdict.ts` 的 `Verdict.superRefine` | schema 校验失败 ⇒ `invalid` |
| INV-8 | 通知必须稀缺 | `InboxSeverity`（`action_required` / `attention` / `info`）；只有"意外 + 有后果"才进通知中心 | 各调用点自行判断，注释写明判据 |
| INV-9 | 动作必须来自显式白名单 | `actions/definition.ts` 的 `validateActionAllowed()` + `actions/tool-actions.ts` 的 `validateActionRefWith()` | `decideReview` 第③步；不在白名单 ⇒ 结构性 `invalid` |
| INV-10 | 动作定义须声明执行端/参数/可回滚 | `ToolActionSpec`（`reversible` / `dryRun` / `timeoutMs` / `params`） | 清单 schema 校验 |
| INV-11 | 幂等 | `actionIdempotencyKey` + `findActionByIdempotencyKey` | 命中 ⇒ `skipped` |
| INV-12 | 不可回滚必须显式标注 | `ToolActionSpec.reversible`；界面上标出来 | 清单 schema |
| INV-13 | 执行端不由判决决定 | `ActionRef` **没有** `plane` 字段；`Action.plane` 在执行时落库固化 | 类型层面就没有这个字段 |
| INV-14 | 链路深度上限 | ⚠️ **只有一条生产路径**：`apps/daemon/src/server.ts` 的 `autoChainReview`（`server.ts:2040`）。⚠️ 那一行是**手写的比较**（`depth > DEFAULT_MAX_CHAIN_DEPTH`），**不是**调用域层的 `assertChainWithinDepth()`；域层那个函数（默认 5）只有 `loop/bounds.test.ts` 在用 | **发一条 `attention` 通知 + 返回 `null` 停止派生**——不是抛错，也不是拒绝写入。返工链路走 `createReworkRun`，那里 `chainDepth + 1`（`server.ts:2549`）**不查这个上限**，它的上界是 `maxReworks`（可为 `null`） |
| INV-15 | 环检测 | `loop/bounds.ts` 的 `detectChainCycle()` / `assertNoChainCycle()` —— ⚠️ **零生产调用点**，调用它们的 `assertCanDeriveRun()` 只被 `loop/bounds.test.ts` 与 `apps/daemon/src/loop-closure.test.ts` 用 | 键 = `(对象, agent, 原因码)`。**当前形态是"实现与判据就绪、没接进生产路径"**，不是"在写库之前强制校验" |
| INV-16 | 派生的 run 必须显式打标 | `Run.derivedFrom`（`ActionId`）+ `loop/chain.ts` 沿该边重建 | 类型 + 重建函数。⚠️ **没有生产者**（见下） |
| INV-17 | 同一 agent 对同一对象不自我竞争 | 端口 `findActiveRunForSubjectAgent()` + `ACTIVE_RUN_STATUSES` | 受理时排除 |
| INV-18 | 词汇不漂移 | 全部词汇在 `packages/protocol` 一处定义 | 单一来源 |

> ⚠️ **INV-14 / 15 / 16 三条要分开读，它们不是同一档强度**（2026-10 复核）：
>
> - **INV-14（深度）有一条生产路径**，但形态是"**发通知 + 停止派生**"而不是抛错。
>   上面那句"不会被静默降级"对它成立（发了通知就不算静默），但**别把它读成"写库之前会被拒绝"**。
>   ⚠️ 同一段里还有**同形的第二条**：`autoChainReview` 发现审核者的角色中途被改掉了
>   （`server.ts:2014`，`review.reviewer_role_changed`）也是"发 `attention` 通知 + 返回 `null`"。
>   两条的理由是同一条注释里写的"**这是配置过、现在失效，而不是本来就不审**"——
>   也就是说这个仓库对"边界拦住了但事情本来该发生"一律留痕，**降级合法，静默不合法**。
>   返工链路（D45）的 `chainDepth + 1` 不查这个上限，上界是 `maxReworks`。
> - **INV-15（环检测）零生产调用点。** 实现、判据与测试都在，但这一版没有接进任何生产路径。
> - **INV-16（`derivedFrom`）没有生产者。** `SubmitRunRequest` 仍接受这个字段
>   （`packages/protocol/src/local-api.ts:273`），但**没有任何生产代码会填它**：唯一会派生
>   run 的动作 `issue.assign_agent` 随内置动作一起删掉了（D41）。于是 `Run.derivedFrom`
>   恒为 `null`，`loop/chain.ts` 那条"重建链路"的边也走不到头——重试与返工是**新建 run**
>   并靠 `subject` / `resumeFromRunId` 关联，并不走这条边。
>
> 实现与测试仍留在域层（`loop/bounds.ts`、`loop/chain.ts`、`loop/bounds.test.ts`），
> 这是**有意的保留**：将来加回能派生 run 的动作时，边界已经在那儿了。
> 改这块之前先读 `design.md` §15.29。

### 4.4 审核决策：`decideReview`

`review/pipeline.ts` 是判决的收口处，四步走：

1. **抽判决块**——`extractVerdictJson()` 取围栏内的内容（`<<<ALPHA_VERDICT>>>`）；
   没有围栏 ⇒ `invalid`（可重试）。
2. **schema 校验**——`parseVerdict()` 返回 `{ok:true, verdict}` 或 `{ok:false, issues[]}`，
   **不抛异常**（调用方需要逐条 issue 来给人看）。
3. **动作校验**——先 `validateActionRefWith({tools, fixed})`（动作是不是已安装工具包里
   声明过的、模型有没有偷写固定参数），再 `validateActionAllowed({allowedActions})`
   （在不在这个审核者的行动权限里）。
4. **按结论分流**——八种决策：

| `ReviewDecision` | 触发条件 | 后续 |
|---|---|---|
| `act` | `pass` 且带 `action` | 派发动作 |
| `advisory` | `pass` 且无 `action` | 只记录 |
| `escalate` | `needs_human` | 进通知中心 |
| `rework` | `fail` 且还有返工额度 | 派生返工 run（交回执行者） |
| `rework_exhausted` | `fail` 且额度用完/没配 | 进"等待人处理" |
| `retry` | `invalid` 且可重试 | 重试**审核者** |
| `downgrade` | `invalid` 且重试次数用尽 | 降级为 advisory |
| `invalid` | `invalid` 且**结构性问题** | 直接交给人，不重试 |

两个计数**必须分开**（`invalidAttempts` vs `usedReworks`）：`invalid` 重试的是审核者
（它没按格式输出），`rework` 重做的是执行者（活本身不合格）。混用一个会让
"模型不会写 JSON"吃掉"活干得不行"的额度。

`isStructuralInvalid()` 的判据是"**模型再输出一次会不会不一样**"：

| 情况 | 重试有用吗 | 为什么 |
|---|---|---|
| 动作类型解析不出来（没装/包里没声明） | ✗ | 配置问题 |
| 动作不在行动权限里 | ✗ | 配置问题 |
| **动作参数不合法** | ✓ | 模型失误 |
| 没有围栏块 / JSON 不合法 | ✓ | 典型的"这次忘了格式" |

⚠️ 参数类错误的消息**统一以 `动作参数 ` 开头**，`isStructuralInvalid` 依赖这个前缀
（路径 `action.params.*` 与 `action` 本身分不开）。改消息文案前先看那段注释。

---

## 5. 存储

### 5.1 当前默认：`store-file`（JSONL + 内容寻址）

`apps/daemon/src/server.ts` 里 `FileStore.open({dataDir, fsync})` 是**唯一被接线的实现**。

数据目录（默认 `~/.agentdeck/data`，布局见 `packages/store-file/src/file-store.ts` 头注释）：

```
~/.agentdeck/data/
├── meta.json               { formatVersion, instanceId }（formatVersion 高于本程序 ⇒ 拒绝打开）
├── lock                    单实例锁（"不存在才创建"，陈旧锁可接管）
├── device.json             本机 device 标识
├── workspaces.jsonl        workspace 记录（全局，量小）
├── tool-tmp/               脚本动作的临时目录（每次执行一个子目录，跑完即删）
└── workspaces/<workspaceId>/
    ├── blobs/<前两位>/<sha256>            内容寻址 blob
    ├── log/<collection>.jsonl             append-only 权威记录
    ├── log/<collection>.jsonl.snapshot    压缩后的物化快照
    └── runs/<runId>/messages.jsonl        这条 run 的消息流（带 seq）
```

`<collection>` 共 **12** 个：`agent` / `skill` / `tool` / `issue` / `comment` / `run` /
`report` / `verdict` / `action` / `artifact` / `audit` / `inbox`。

> **技能内容不在数据目录里**（2026-10）：正文与支持文件落在 `<skillsRoot>/<slug>/`
> （默认 `~/.agentdeck/skills`，`--skills-root` 可覆盖），`log/skill.jsonl` 里那条记录
> 退化成**索引**（id / slug / 来源 / 版本 / 时间）。**磁盘为准**——改那里的 `SKILL.md`
> 就生效。**没有例外**：从本地技能目录装进来的（`localdir:`）也落盘——它装完就是一条
> 普通技能，正文在 `~/.agentdeck/skills/<slug>/`（2026-10 D73 撤掉了旧的 `localdir:`
> 例外：那时它的正文留在记录里、不落盘）。老记录（含老的 `localdir:` 记录）在
> `FileStore.open` 里**一次性迁移**落盘（幂等）。落点与回读见 `packages/store-file/src/skill-files.ts`；
> 兜底 `fallbackSkillsRoot` 在 `apps/daemon/src/workdir.ts`（与 `fallbackWorkRoot` 同层，
> 绝不碰家目录）。

> ⚠️ 设计文档里还列过 `runs/<runId>/run.json`，实现时**有意去掉了**：run 记录已经以追加
> 记录的形式存在于 `log/run.jsonl`，再存一份就变成**双份真相**，迟早会不一致。
> `runs/<runId>/` 只放消息流。

五条要点：

1. **追加写 + 物化"当前态"**：`LogEntry` 是 `{seq, at, op: 'put'|'patch'|'del', id, value?, patch?}`；
   run / verdict / action 的状态变更靠 `transition*` 追加新记录，历史不被覆盖（DR-3）。
   `patch` **只能绝对赋值，不能自增**——崩溃重放会把一条 patch 应用两次。
2. **`compact()` 先把快照 fsync 落地、再删日志**：顺序不可颠倒，否则崩在中间就全丢了。
3. **blob 是内容寻址的**（`sha256:<hex>`，按前两位分桶），所以同一份内容不会存两遍，
   而且 `blobRef` 本身就是校验和。
4. **消息流带 `seq`**，SSE 用 `?since=N` 补齐——刷新、重连都不丢消息（见 §7.6）。
5. **分页游标按位置而不是身份**（`findIndex(i => i.id > cursor)`）：这一条修掉过一个
   "游标不在就重放第一页"的 bug。

> 真实数据目录里还有一份历史遗留的 `workspaces/<id>/log/skill.jsonl` 等文件——
> 集合是**按需创建**的，新增集合名只影响新写的那份日志，不需要迁移。

### 5.2 备选：`store-sqlite`（已实现，未接线）

`packages/store-sqlite/src/sqlite-store.ts`（1571 行）实现了**同一个 Store 端口**，
行为契约与 `store-file` 完全一致，并显式调用了领域层的三张状态机断言
（`packages/store-sqlite/src/sqlite-store.ts` 里那段注释说明"不在这里抄一份转移表"）。

| 项 | 值 |
|---|---|
| SQLite 提供者 | **`node:sqlite` 内置模块**（`DatabaseSync`）——**零第三方依赖** |
| 库文件 | `<dataDir>/store.sqlite`（+ WAL 的 `-wal` / `-shm`） |
| 版本 | `SQLITE_STORE_FORMAT_VERSION = 1`（存在 `meta` 表） |
| 打开时 | `journal_mode = WAL`、`synchronous = FULL`（`fsync:false` ⇒ `NORMAL`）、`busy_timeout = 5000`；**全部语句在 open 时 prepare**（schema 不符当场炸）+ 每表 `count(*)` 预热 |
| 守卫 | 有别的表却没有 `meta` ⇒ **拒绝打开**（不当成新库接管）；版本非整数 ⇒ 报"文件可能已损坏"；高于本程序 ⇒ 报错 |
| 表 | 17 张：`meta` / `device` / `workspace` / `agent` / `skill` / `tool` / `issue` / `comment` / `run` / `verdict` / `action` / `artifact` / `audit` / `inbox` / `report` / `run_message` / `blob` |

两个值得学的实现细节：

1. **JSON 是唯一真相，派生列由 SQLite 求值**：实体表是 `(id, workspace_id, json)`，
   查询用的列是 **VIRTUAL 生成列**（`GENERATED ALWAYS AS (json_extract(json,'$.…'))`）。
   于是索引能建在 `run.status`、`report.dedup_key` 上，而 JSON 与派生列**物理上不可能漂**。
2. **`report` 去重靠唯一索引**（`UNIQUE(workspace_id, dedup_key)` + `ON CONFLICT DO NOTHING`），
   而不是应用层 Map——并发安全由数据库保证。`action_idempotency` 索引**故意非唯一**：
   幂等键重复是业务上要处理的情况，不是约束违反。

`port-thinness.test.ts`（882 行）做两件事，值得单独提：**静态守卫**（端口源码不得出现
file/json/path 之类实现词汇；SQL 适配器必须实现端口的每一个方法；状态机与
`ACTIVE_RUN_STATUSES` 必须来自 domain）+ **差分契约**（同一串操作在两个适配器上跑并逐项对比）。

⚠️ **daemon 目前不用它**：`apps/daemon/package.json` 依赖 `@agentdeck/store-file`，
`apps/daemon/src/server.ts` 只 import `FileStore`，**没有任何环境变量或 driver 开关**；
`store-sqlite` 在 `apps/` 下没有运行期消费者。要切换需要改装配点
（`domain` 里的 `StoreOpener = (options: {dataDir}) => Promise<Store>` 是预留的换实现接口）。
它是 P3「存储是端口」的**实证**——两套实现并存本身就是这条原则的验证。

> 两个适配器可以指向同一个 dataDir 而互不破坏（文件名不同），但**混用不是受支持的用法**；
> 搬家走导出/导入（`domain/audit/snapshot.ts`）。

---

## 6. 适配层：runtime 与 CLI

### 6.1 端口：`AgentBackend`（`packages/agent-core/src/backend.ts`）

接口**刻意只有一件事**：跑一个 prompt，拿回流式结果。

```ts
interface AgentBackend {
  readonly key: string                  // 'claude' | 'generic' | …
  readonly protocol: RuntimeProtocol    // stream-json | acp | jsonrpc
  readonly rejectDetectable: boolean    // 能否检测"会话恢复被拒绝"
  probe(): Promise<{ available, command, cliVersion }>
  execute(opts: ExecOptions): Promise<AgentSession>
}

interface AgentSession {
  readonly messages: AsyncIterable<AgentMessage>   // 流式消息（类型已归一化）
  readonly result: Promise<AgentResult>            // 终态
  cancel(): Promise<void>
  lastActivityAt(): number                         // 活性判定
}
```

`AgentMessage.type` 被归一化到七个值：`text` / `thinking` / `tool_use` /
`tool_result` / `status` / `error` / `log`——屏蔽各家 CLI 的输出差异。

两处刻意的设计：

- **`resumeRejected: boolean | undefined`**：`true` = 确认被拒；`false` = **没被拒或无法判断**。
  把"测不出来"当成"没被拒"会让语义悄悄跑偏，所以 `rejectDetectable: false` 的 runtime
  必须让调用方知道这个 `false` 不可信。
- **`model` 与 `ExecOptions.model` 是两件事**：前者是 **CLI 自己报告的**（审计要的是这个），
  后者是我们**要求**它用的。CLI 不报告时是 `null`，**绝不拿请求值顶替**——
  那会让审计记录看起来比事实更确定。

### 6.2 差异集中到表：`runtime-table.ts`

新增一个 runtime 要做三件事（`docs/README.md` 的硬约束 #8）：

1. 在 `packages/agent-core/src/runtime-table.ts` 加一行描述符；
2. 写一个适配器包（实现 `AgentBackend`）；
3. 在 `apps/daemon/src/runtime-registry.ts` 的装配表加一行。

描述符（`RuntimeDescriptor`）的字段就是"新增一个 runtime 要回答的问题"：

| 字段 | 回答什么 |
|---|---|
| `key` / `command` / `protocol` | 它叫什么、怎么探测、说什么协议 |
| `kind` | **`cli`（命令行形态，claude / generic）还是 `service`（常驻服务 + JSON-RPC，codex app-server）**——cli-only 字段（`managedFlags` / `promptDelivery` / `resume` / `blockedArgs`）只在 cli 形状下必填 |
| `family` | 用哪个解析器（`claude-stream-json` / `generic-ndjson` / `codex-app-server-jsonrpc`） |
| `evidence` / `evidenceNote?` | **证据等级**（`verified` / `provisional`）——写进数据，不只写注释 |
| `sessionState` | `stateful` / `stateless` / `unknown`（后两者都不恢复，但审计可区分） |
| `versions?` | 支持范围 + `verifiedWith[]` + 不匹配时 `warn` 还是 `refuse` |
| `stateDir?` | CLI 自己的状态目录（沙箱与启动预检共用） |
| `skills` | `{kind:'directory', dir}` 或 `{kind:'none', reason}`——**必须老实回答** |
| `toolConfig` / `disableSwitch` | 两个注入位（`enabled` + 原因 + 证据） |
| `resume` | 恢复旗标 + **能不能测出"恢复被拒"**（cli-only） |
| `promptDelivery` | `stdin-ndjson` 还是 `argv`（cli-only） |
| `baseArgs` / `blockedArgs` | 协议基础参数（使用者不可覆盖）+ 禁改表；**service 形状没有 run 级 argv，`baseArgs` 就是启动参数** |
| `managedFlags` | `{model, maxTurns, resume}`（cli-only，**cli 形状必填**） |
| `systemPrompt` | `{ flag }` 或 `null`——**有它就是 A 档的判据**（`--append-system-prompt`）；没有则 B 档（三块合成一段） |

两条硬规则（按 `kind` 分叉，缺了在加载时就**抛**，**不会**替你猜 claude 的拼写）：

- **`cli` 形状**：`managedFlags`（`model`/`maxTurns`）+ `resume` 必填；
- **`service` 形状**：`baseArgs` 非空必填，cli-only 字段缺省即合法；
- `managedFlags.resume` 会被强制对齐 `resume.flag`——同一件事的两个视图不许漂。

现有三行数据：`CLAUDE_DESCRIPTOR`（`kind:'cli'`、`evidence: 'verified'`、`sessionState: 'stateful'`、
技能走 `.claude/skills` 目录、`rejectDetectable: true`、`versions.verifiedWith` **刻意为空**
⇒ 版本状态报 `undeclared`，**探测通过 ≠ 验证通过**）、`GENERIC_DESCRIPTOR`
（`kind:'cli'`、`evidence: 'provisional'` + `evidenceNote`、`sessionState: 'unknown'`、
`skills: {kind:'none', reason}`、`rejectDetectable: false`、`promptDelivery: 'argv'`）与
`CODEX_DESCRIPTOR`（**`kind:'service'`**、`protocol:'jsonrpc'`、`family:'codex-app-server-jsonrpc'`、
`baseArgs:['app-server','--stdio']`、`sessionState:'stateful'`、技能走 `.codex/skills` 目录、
`systemPrompt:null` ⇒ **B 档投递**、`evidence:'verified'`——0.144.0-alpha.4 实测，设计见
`docs/runtime/codex-runtime-design.md`，残余未验证项见 `agent-codex` 的 `unverifiedFields()`）。

`generic` 的价值不在"多支持一个厂商"，而在它是**可插拔性的实证**：
加一行数据 + 一个包，argv 组装、禁改过滤、失败分级、沙箱、注入与审计的调用点**一行未改**。
未验证这件事被写成**数据**（`evidence: 'provisional'` + `generic-descriptor.ts` 的
`unverifiedFields()` 列出 11 条）而不是注释。

**argv 组装**（`argv.ts`）是四段固定顺序：`baseArgs` → 受管参数 → 过滤后的用户参数 →
`managedAppend`（**2026-09 起装 `--append-system-prompt`**：①② 两块走它；MCP/settings 仍预留）——**最后写的赢**。
禁改表（`blocked-args.ts`）区分 `standalone` 与 `withValue` 两种模式，
被丢弃的参数会生成一句人话警告（不是静默丢掉）。

`runtime-agnostic.test.ts` 整条跑在第二个 runtime 上，专门抓"还有东西写死了 claude"
（审计、技能投递、界面选项、文件清单）。

**真的要 exec 什么**（`spawn-target.ts`，2026-10）：探测到的**可执行文件路径**在 Windows 上
可能不是能 exec 的东西——npm 装的 CLI 是 `.cmd` 垫片，而 Node 从 2024-04 的安全版本起
（CVE-2024-27980）**拒绝 `shell: false` 地 spawn `.cmd`/`.bat`**（参数校验阶段抛 `EINVAL`）。
所以 spawn 之前先问 `resolveSpawnTarget`：

| 情形 | 结果 |
|---|---|
| 非 Windows | 原样（`via: 'direct'`，Unix 行为一个字没变） |
| `.cmd`/`.bat` 且认得出 npm 垫片形状 | 解开成 `<node> <cli.js> <真实参数>`（`via: 'shim'`）——参数**不经 shell** |
| `.cmd`/`.bat` 但认不出来 | `cmd.exe /d /s /c`（`via: 'cmd'`）；参数里有 cmd 无法如实传递的字符（`"`/`%`/换行）就**拒绝**，不静默改写 |
| `.ps1` | **拒绝**并说清"npm 同时给了 `.cmd`"（Node 起不了 `.ps1`） |

⚠️ 这句话是**故意的**：`spawnProcessTree` 因此可能同步抛 `UnspawnableCommandError`。
探测侧的候选扩展名也跟着改了：以机器的 `PATHEXT` 为准，并按"Node 起得起来"过滤
（**`.ps1` 不再出现在候选里**——它一度在，表现是"预检说可用、真跑必炸"）。
理由、取舍与实测边界见 `docs/reference/windows-compat.md`。

### 6.3 第一句话：三块组装与两个投递档（D29 / 2026-09）

交给 CLI 的东西是**三块**，由 `packages/agent-core/src/first-sentence.ts` 组装：

```
① 框架（工作区级模版渲染，每轮都发） → ② 身份（agent 的「指令」；审核者接上判断依据）
                                    → ③ 任务（这次的正文；审核时还有那句声明、两个材料标记与材料）
```

- **怎么送**是另一件事，两个档（`deliveryModeFor(runtime)` 决定，**记在 `Run.deliveryMode` 上**）：
  **A** = ①② 走系统提示通道（`--append-system-prompt`），③ 是用户消息；
  **B** = 三块合成一段、块边界显式（没有那个通道的 runtime 走这里）。
  ★ 实测两条：系统提示**活不过 `--resume`** ⇒ A 档每轮都带；每条 stdin 用户消息各换来一个
  模型回合 ⇒"三块拆成三条消息"被否掉。
- 顺序与位置都有理由：**判决契约在 ① 框架的最末**（长跑里上下文会被压缩，最后读到的最不容易被摘要掉）（它是"输出要求"，离生成位置最近）；
  材料**必须留在 ③**——它是第三方内容，进系统提示那一层就是提示注入的靶子。
- ~~同一份文本另存一份副本 `<workDir>/.agentdeck/context/<runId>.md`（带注释说明哪块走哪个
  通道）~~ —— **已撤（2026-09）**：执行/审核都不再写副本文件（"回看它被交代了什么"看 run 日志，
  ①②③ 分开带标签、不截断）。它从来**不是第二个投递通道**。
- 使用者可以在界面上替换三块（D32 + **2026-10 三框改造**）：执行 / 审核 / 聊天**每条链路三个
  **独立的模版框**（① 框架 / ② 身份 / ③ 任务），**全局生效**。② 由**身份框**用 `{{identity}}`
  摆放、③ 由**任务框**用 `{{task}}` 摆放（默认框 = 这两行，与改造前逐字节相同）；内容仍由
  平台组装（材料标记、判断依据合成这些安全件不交给模版）。所以 `{{instructions}}` / `{{prompt}}` /
  `{{standards}}` / `{{tools}}` / `{{material}}` / `{{materialTitle}}` 六个变量**已退役**（老模版
  读取时自动迁移）；`{{identity}}` 可选、`{{task}}` 必需（三条链路都要，少了这条 run 就没有任务），
  框架框里唯一不能省的是审核那份的 `{{verdict}}`（判决格式要求）。
- 模板引擎是 **mustache**（零传递依赖），支持 `{{#x}}…{{/x}}` 条件段。

### 6.4 注入与清理：`skill-injection.ts`

| 注入什么 | 落在哪 | 什么时候清 |
|---|---|---|
| 技能（执行者挂的） | `<workDir>/<descriptor.skills.dir>/<slug>/`（claude 是 `.claude/skills/`） | run 结束，**只删平台自己放进去的** |
| ~~上下文副本~~ | ~~`<workDir>/.agentdeck/context/<runId>.md`~~ | **已撤（2026-09）**：不再写（日志含第一句话全文，①②③ 分开带标签） |

> ⚠️ 这里原来还有一行「工具包（执行者挂的）⇒ `<workDir>/.agentdeck/tools/<slug>/`」。
> **那个能力已经整个撤掉**：`Agent.toolIds` 不在协议里了，工具包不再挂到执行者身上、
> 也不再被写进工作目录——"工具"现在的身份是**动作的来源**（审核者的「行动权限」里勾的那些，
> 判决通过后由平台执行），不是执行者的参考资料。写入口（`PUT /api/agents/:id/tools`）也删了。
> 相关残留读一遍 `apps/daemon/src/executor.ts` 里那段注释（它说明了为什么那条路径现在
> 永远不会写出任何东西）。

**归属靠落盘的清单，不靠内存**：技能目录里会写一份
`<skills.dir>/.agentdeck-managed.json`（内容 `{slugs: [...]}`，放在技能目录**之内**，
CLI 不会把它当成一个技能）。清理时读的是**这份清单**——所以哪怕内存里的数组传错了，
也删不到使用者的东西。清单读不到或坏掉 ⇒ 当空（**宁可少删**）。

四条规则：

1. **同名直接报错，不覆盖**（`SkillCollisionError`）——
   使用者自己放在同一目录的技能一个都不会动。
2. **先写清单、再写文件**：崩在中间只会留下"清单有、盘上没有"，下次自愈；
   反过来则会留下没人认领的文件。
3. **清理必须在 `finally` 里**：失败路径同样不能在使用者目录里留下痕迹。
   清理是**幂等**的（有 `cleaned` 标记）。
4. **注入失败要让 run 失败**（`RunFailureReason.injection_failed`）：
   静默的缺能力比直接报错糟得多——它不报错，只让结果悄悄变差。

两个额外细节：技能正文会过一遍 **frontmatter 规范化**（缺 `name` 补 slug、
`name` 与 slug 不一致时**以 slug 为权威**、缺 `description` 补平台那句、YAML 坏掉就重建，
**但保留其它键**如 `disable-model-invocation`）；技能单文件上限 `MAX_SKILL_BYTES = 256KB`，
且这个数**与安装侧共用同一个常量**——否则会出现"装得上、注入时被拒"。
`descriptor.skills.kind === 'none'` 时**一个文件都不写**，并在日志里明说原因。

### 6.5 沙箱：可选，且**不是安全边界**

`packages/agent-core/src/sandbox.ts`：`--sandbox workdir-write` 只允许写工作目录，
读不受限（agent 本来就要读 CLI 安装位置、`node_modules`、语言工具链）。
macOS 用 `sandbox-exec`，Linux 用 `bwrap`。

**宁可失败，不可静默降级**：开了沙箱却拿不到工具时，daemon 会**明确报错**，
而不是"那就直接跑吧"。静默降级会让你在**以为自己被保护着**的情况下裸奔——
那种失败比"功能没做"严重得多，因为它把安全感本身变成了假的。

沙箱是**整个 daemon 一个开关**，不是每个 agent 一份：一旦某个 agent 关着，
通过它跑的东西就是裸的，而"给这个 agent 开了就它被保护了"是假的安全感。

`onCommandLine` 回调上报的是**最终**命令行（含沙箱包装）与 `sandboxDescription`——
后者是权威说明：判定沙箱有没有生效**不要**去看 argv 里有没有 `sandbox-exec`，
那是在从结果反推原因。

---

## 7. daemon：本机服务

`apps/daemon/src/server.ts` 是仓库里最大的文件（5302 行），
`startDaemon(options)` 是唯一的装配点（`apps/daemon/src/server.ts`）。

### 7.1 启动装配

```ts
// `startDaemon()` 起，按顺序发生的事
FileStore.open({dataDir, fsync})                    // ① 打开存储（拿不到单实例锁 ⇒ 抛）
createRuntimeBackend(runtimeKey, …)                 // ② 解析默认 runtime（未知 key 报错并列出可用的）
new RunRegistry()                                   // ③ 流式消息注册表（内存 + seq 分配）
new WorkDirLocks()                                  // ④ 工作目录锁
new Semaphore(maxConcurrentRuns ?? 20)              // ⑤ 并发闸门
createScriptExecutor({tempRoot: <dataDir>/tool-tmp})// ⑥ 脚本动作执行器
new ActionRunner({store, executeToolScript, …})     // ⑦ 动作执行端
new ReviewCoordinator({store, actions,
  createRetryRun,                                   //    重试审核者（invalid）
  createReworkRun})                                 //    交回执行者（fail / D45）
new RunExecutor({store, workRoot, resolveRuntime,   // ⑧ 执行器
  registry, backend, descriptor, semaphore, locks,
  reviewCoordinator, autoChainReview, sandbox})
backend.probe() → bootstrap(store)                  // ⑨ 探测 CLI + 建默认 workspace
planDeadActionCleanup + applyDeadActionCleanup      // ⑩ 清掉失效的动作名（写日志 + 发通知）
isWebBuilt() ? : warn(NOT_BUILT_HINT)               // ⑪ 界面没构建就明确提示，而不是发空白页
checkEnvironment(runtimes)                          // ⑫ CLI 状态目录可写性预检
reconcileInterruptedRuns(store, …)                  // ⑬ ★ 必须在起 HTTP 服务之前
http.createServer(handle).listen(port, '127.0.0.1') // ⑭ 只绑回环
```

几个容易踩的点：

- **`reconcileInterruptedRuns` 必须在监听之前**：否则页面可能在收口完成前就看到
  一条永远不会结束的 run。
- **监听失败要把已占的资源还回去**（`executor.shutdown(0)` + `store.close()`）再抛可读错误，
  **不自动换端口**。
- **`close()` 的顺序是** `server.closeAllConnections()` → `server.close()` →
  `executor.shutdown()` → `store.close()`：执行器必须先于 store 关，
  否则 run 会在 store 已关之后继续写。
- **启动横幅每次都报沙箱状态**：未启用时明说"以当前用户完整权限执行（NG7）"——
  不说这句，使用者会默认以为自己被保护着。
- **`applyDeadActionCleanup` 只删"永远不可能成立"的动作名**（工具包卸载之后留在
  agent 配置里的死名字），而且**不静默**：写日志 + 发通知。

`resolveRuntime(key)` 按 **agent 的 `runtimeKey`** 解析 backend（D28）：
在此之前所有 agent 实际都跑同一个 CLI，而 `runtimeKey` 是个没人读的字段——
**"接口接受了、行为上不存在"**，正是这个项目反复在防的那类东西。

⚠️ 注入了 `options.backend`（测试用）时**必须**用它：否则测试会偷偷跑使用者真实安装的
CLI，消耗真实额度。这条错误当场被测试抓到了（`apps/daemon/src/server.ts` 里那条注释记着）。

### 7.2 本地接口（完整路由表）

**全部**接口都在 `127.0.0.1` 上，且都过 `Host` 头校验。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查（不过 `/api/` 前缀） |
| GET | `/api/identity` | 协议版本、deviceId、可用 runtime、capabilities |
| **智能体** | | |
| GET | `/api/agents` | 列表 + 「新建任务的默认智能体」（D36） |
| POST | `/api/agents` | 新建。**认识的字段只有这些**：`name` / `instructions` / `model` / `runtimeKey` / `workDir` / `skillIds` / `env` / `role` / `reviewStandard` / `ownerGroupId`；未知字段**明确 400**（拼错名字静默忽略会让人以为保存成功了） |
| GET | `/api/agents/{id}` | 读单个 |
| PATCH / PUT | `/api/agents/{id}` | 改（PATCH 语义：只改给的字段；**未知字段明确 400**） |
| PUT | `/api/agents/default` | 默认执行者（只认 executor，没有"取消默认"这回事，D36） |
| POST | `/api/agents/{id}/review-standard/adopt-from-skills` | 把挂载 skill 里的判断依据**原样**并进 agent 的「指令」并摘掉挂载（D38；2026-09 之前落点是 `reviewStandard`），解析不出来的动作进 `droppedActions` 如实回报。⚠️ 界面上**目前没有入口**（那个按钮在 2026-10 的改版里被删了，见 §14） |
| **智能体组**（2026-10 起「谁审谁」与「判完允许动什么」的**唯一权威**） | | |
| GET | `/api/agent-groups` | 列表 |
| POST | `/api/agent-groups` | 新建组。请求体可同时带 `createAgents`（草稿成员）——「在组里新建私有成员」是 `ownerGroupId` 唯一的生产入口。⚠️ 写入前先算**最终形态**（已有成员 + 草稿角色），不对就一个都不建 |
| GET | `/api/agent-groups/{id}` | 读单个，返回 `{ group, members }`（成员一并给全，省一次往返） |
| PATCH / PUT | `/api/agent-groups/{id}` | 改（PATCH 语义）。**可改的字段**：`name` / `members` / `allowedActions` / `actionParams` / `debugActions` / `maxReworks` / `enabled` / `createAgents`；未知字段明确 400。⚠️ **`mode` 不在这里**——模式只在创建时定（这轮唯一合法值是 `'workflow'`，改了也没意义） |
| DELETE | `/api/agent-groups/{id}` | 删组，**并级联删掉它的私有成员**（按 `ownerGroupId` 找，所以建到一半的孤儿也一起清）；先删 agent 再删组（失败时不会出现"组没了、私有 agent 悬着"）。返回 `{ ok, removedPrivateAgents }` |
| **工作区设定** | | |
| PUT | `/api/workspace/locale` | 界面语言（`zh` / `en`，挂在 workspace 上，D39） |
| **第一句话模版** | | |
| GET/PUT | `/api/first-sentence/templates` | 2026-10 三框：变量对照表（十一条，带块归属）+ 每条链路的三个默认框（① 框架 / ② 身份 / ③ 任务）+ 当前生效的九框；返回的是**迁移后**的样子并带 `adjustments`（按 kind × block）。PUT 是 PATCH 语义：未传的块不动 |
| POST | `/api/first-sentence/preview` | 用示例任务渲染预览，**按 kind × block 只渲染那一块**（与真的那次同一个渲染器） |
| **技能** | | |
| GET | `/api/skills` | 列表 |
| POST | `/api/skills` | 直接写入（页面不走这条，走 install） |
| POST | `/api/skills/install` | 装技能：本地路径 / GitHub 地址 / 远端目录（D38） |
| GET | `/api/skills/local-dirs` | **只读发现**：扫内置的那几个本机技能目录（别的 AI 工具的 `skills/`），列出里面发现的技能与「已装」标记（D73；原来的 PUT 对账已删） |
| GET | `/api/skills/install-list` | 读**本地安装清单**（一份仓库自带的 JSON，列出可点的安装方法 url/path；daemon 算 slug）。**不联网**——只读本地那份文件；清单本身坏掉时**报错**而不是回空表。路径可用 `--skills-catalog` 换 |
| DELETE | `/api/skills/{id}` | 卸载（还被 agent 挂着时**被拒**并列出是谁） |
| **工具包** | | |
| GET | `/api/tools` | 列表 + 「不支持预演就自动执行」那个开关的当前值 |
| POST | `/api/tools` | 安装（本机目录 / 远端目录条目） |
| DELETE | `/api/tools/{id}` | 卸载 |
| **任务与看板** | | |
| GET | `/api/issues` | 任务列表（`?limit=`） |
| POST | `/api/issues` | 新建任务（立刻派给 agent） |
| GET | `/api/inbox` | 通知中心 |
| POST | `/api/inbox/{id}/read` | 标记已读 |
| GET | `/api/costs` | 成本汇总 |
| GET | `/api/audits/export` | 审计导出（带校验和） |
| **聊天（D49，闭环的旁路）** | | |
| GET | `/api/conversations` | 对话列表（按最近说过话排序） |
| POST | `/api/conversations` | **对话由第一句话诞生**（没有"先建一个空对话"这条路）：标题取第一个非空行；agent 必须是**执行者**（审核者 ⇒ `agent_role_mismatch`） |
| GET | `/api/conversations/{id}` | 对话 + 全部轮次（每轮带 `output` / `status` / `toolCount` / `durationMs`）+ **实际工作目录** |
| PATCH | `/api/conversations/{id}` | 改名 / 改工作目录（`workDir: null` = 回到自动分配；**空串是 400**，两者不同）。⚠️ **界面只在「新对话」那一步设工作目录**（详情页只读）：改目录等于把"这次对话在哪个目录里干的活"变成不确定的，而回看时列出的文件、路径都指着旧目录。接口仍然收这个字段（老客户端与脚本照旧能用） |
| DELETE | `/api/conversations/{id}` | 删对话**连同它的轮次**；那一轮的 run 一个都不动（成本与审计还认得它） |
| POST | `/api/conversations/{id}/turns` | 说下一句 ⇒ 202（并发位满 ⇒ 429 + `retry-after`） |
| GET | `/api/conversations/{id}/files` | 这个对话工作目录的文件树（一次一层；D49 ⑪） |
| GET | `/api/conversations/{id}/file` | 目录里某个文件的内容（查看器用；带 NUL 就按二进制）。⚠️ 2026-10：**音视频**（`video/*` / `audio/*`）走另一条发法——不读进内存、认 `Range`（206 / 416）、带 `accept-ranges`，上限也从 8MB 换到 2GB |
| **摄取与执行** | | |
| POST | `/api/reports` | 投递第三方报告（逐条 zod 校验，报告 `items[i]` 哪个字段不合法） |
| POST | `/api/runs` | 提交 run（**INV-1 在这里、写入之前强制校验**） |
| GET | `/api/runs` | run 列表（**故意不含 `lastSeq`**） |
| GET | `/api/runs/{id}` | 单条 run |
| GET | `/api/runs/{id}/events` | **SSE 流**（`?since=N` 补齐） |
| GET | `/api/runs/{id}/messages` | 消息列表 |
| POST | `/api/runs/{id}/cancel` | 取消 |
| DELETE | `/api/runs/{id}` | **删掉一条 run 连同它派生的一切**（消息流、verdict 与它触发的 action、artifacts、以及**引用它的对话轮次**——那一轮的内容就是这条 run 的消息）。**审计记录与 blob 保留**（可追溯性是不可变历史）。⚠️ 还在跑 ⇒ **409** 并说明先取消或等它结束；别的 workspace ⇒ 404 |
| POST | `/api/runs/{id}/human-verdict` | **人工裁决 = 人判通过**（D46）：`{reason?}` ⇒ 追加一条 `source: 'human'` / `advisory` 的判决。**不触发任何动作、不发通知**。挂错 run（该挂审核 run 却挂了执行 run、审核还在跑、非终态…）⇒ **409 并指出该挂到哪条**。见 §8.2 |
| POST | `/api/issues/{id}/abandon` | **放弃任务**（D47）：issue 状态 → `cancelled`，**并取消这条任务上还在跑的 run**（含正在跑的审核 run）。不删任何东西。见 §8.2 |
| POST | `/api/issues/{id}/reopen` | **恢复任务**（D47）：issue 状态 → `todo`。撤销"放弃"的唯一入口 |
| DELETE | `/api/issues/{id}` | **删掉一条任务连同挂它名下的一切**：它名下的每条 run（顺 `subject` 链，所以审核 run 也跟着走）走上面那条 `DELETE /api/runs/{id}`，再加任务自己的评论与本体。**先取消这条任务上仍在跑的 run**（与「放弃」同一处副作用），否则会出现"看不见的正在跑"。inbox 通知保留；别的 workspace ⇒ 404。任务列表每项右侧那个「×」走的就是它 |
| GET | `/api/runs/{id}/verdicts` | 判决 **+ 它触发的动作**（画在同一张卡片里） |
| GET | `/api/runs/{id}/audits` | 审计记录 |
| GET | `/api/runs/{id}/artifacts` | 产出物（blobRef + 大小） |
| GET | `/api/runs/{id}/files` | 工作目录里**一个目录**的直接子项（`?dir=`），并标出哪些是平台注入物 |
| GET | `/api/runs/{id}/file` | 读工作目录里的一个文件（带 `WORK_FILE_HEADERS`，见 §7.3）。同一条发法与「音视频那一档」见 `/api/conversations/{id}/file` |
| — | 其余 GET（非 `/api/`） | 托管 `apps/web/dist/` 静态文件 |

三个值得单独说的决定：

1. **`/api/runs/{id}/verdicts` 顺带返回动作**（`apps/daemon/src/server.ts` 里那条注释）：界面要把判决与
   它触发的动作画在同一张卡片里——"通过之后真的做了什么"是那份通过的依据的一部分。
   分两次请求的话，卡片会先画出"通过"、动作过一拍才出现，中间那一瞬就是
   "审核通过了但什么也没发生"的样子。
2. **`GET /api/runs` 故意不返回 `lastSeq`**：那会让调用方以为可以从任意位置续订，
   而权威消息在 store 里（`local-api.ts` 有注释说明）。
3. **`POST /api/reports` 逐条校验**，不是信任类型声明：类型是编译期的，而这里是运行时
   的任意 JSON。错误要报到"第几条、哪个字段"——只说"输入不合法"会让批量投递的调用方
   无从下手。

**没有 `/api/logs`**：所谓"日志"就是 run 的消息流——`GET /api/runs/{id}/messages`
（一次性取）+ `GET /api/runs/{id}/events`（SSE 实时），加上 executor 用 `#note()`
写进同一条流的 status 行。审计是另一个概念（`/api/runs/{id}/audits`）。

**静态文件服务**（`apps/web/server/index.ts`，由 daemon 通过 `@agentdeck/web` 引入）
是**扩展名白名单 + 形状检查**（拒 `..`、拒 NUL、必须 `/` 开头、扩展名在
`CONTENT_TYPES` 内），并且**不做 SPA 回退**——视图走 hash 路由，`#` 之后的部分不发到
服务端，所以 404 永远是真的 404，不会被一个 index.html 掩盖。

### 7.3 安全模型：同源之后只剩两条

因为 Web UI **由本进程托管**，页面与接口同源，所以（`server.ts` 开头那段）：

| | 为什么不需要 |
|---|---|
| ✗ Origin 白名单 | 同源策略已在浏览器侧生效 |
| ✗ 一次性令牌 | 没有跨源入口 |
| ✗ 约定握手 | 页面本来就是从这个端口加载的 |

| | 为什么必须有 |
|---|---|
| ✓ **只绑回环地址** | 杜绝局域网内其他机器访问 |
| ✓ **校验 `Host` 头** | 防 DNS rebinding——攻击者能让域名解析到 127.0.0.1，但**无法伪造 Host 头** |

另外两条与文件有关的安全措施：

- **工作目录里的文件响应带一组写死的头**（`workdir-files.ts` 的 `WORK_FILE_HEADERS`）：
  `Content-Security-Policy: sandbox allow-scripts`（**没有** `allow-same-origin`）
  + `default-src 'none'` + `script-src 'unsafe-inline' https:` +
  `style-src 'unsafe-inline' https: data:` + `img-src data: blob: https:` +
  `font-src data: https:` + `connect-src https:` + `nosniff` + `cache-control: no-store`。

  理由是：文件是 **agent 写的**、页面又与 daemon 同源 ⇒ 一个 agent 写出来的
  `html`/`svg` 被打开时**默认**就拿到了这个源（能读所有 run 日志、能装 skill、能提交任务）。
  所以：
  - **允许脚本**（`allow-scripts`）⇒ 产出里的画布页（p5 之类）能真的画出来；
  - **没有 `allow-same-origin`** ⇒ 文档落在**不透明源**里，`fetch('/api/…')` 变成跨源请求，
    而 daemon 不发 CORS 头 ⇒ 响应读不到，cookie / localStorage 也拿不到；
  - `default-src 'none'` 把其余加载能力全部关掉。

  ⚠️ **绝不要加 `allow-same-origin`**——加上它等于把这条断掉的路接回去，测试里专门钉着
  （`apps/daemon/src/e2e.test.ts` 断言响应里必须匹配 `/allow-scripts/`）。

  ⚠️ **2026-10：音视频响应刻意不带这组头**（只带 `nosniff` + `cache-control` +
  `accept-ranges: bytes`，见 `workdir-files.ts` 的 `MEDIA_FILE_HEADERS`）。理由：那条
  CSP 是给"agent 写的**文档**"用的，而媒体不是文档；带上它，浏览器在**新标签页**里为
  媒体合成的那张文档自己会被 `default-src 'none'` 管住（它自己的 `media-src` 落回
  `none`）⇒ 视频放不出来。安全性没有因此变松：`nosniff` + 正确的 `video/*` 类型意味着
  浏览器**不会**把它当文档解析，所以"agent 写的文件反过来操作 daemon"那条路仍然是断的。
  测试与探针都成对钉着（媒体**没有** CSP、而文本/HTML 那一档**照旧**有）。
- **Markdown 渲染器是自己写的**（`apps/web/src/lib/markdown.ts`），渲染顺序是硬规则：
  **先摘出结构、再转义剩下的文字、最后拼我们自己的标签**。原始 HTML 一律不认、
  链接只允许 `http(s)`/`mailto`、图片地址必须经调用方映射。

### 7.4 CLI / MCP 的权限边界

三者（CLI、MCP、页面）走**同一套** HTTP 接口，因此权限边界一致：
**都不提供"提交任意 run"**——那接受任意 `workDir` 并在其中启动子进程，
等于一条现成的代码执行入口。

MCP 的暴露面是**刻意窄**的（`apps/mcp/src/server.ts` 开头那段）：

| 暴露（7 个工具） | 不暴露 | 为什么 |
|---|---|---|
| `list_issues` / `get_run` / `list_run_verdicts` / `list_run_audits` / `list_inbox` / `cost_report` | `POST /api/runs` | 后者 = "在你的机器上按我给的路径执行 agent" |
| `submit_report`（投递报告，**不执行任何东西**） | `POST /api/skills` | skill 会被拼进 agent 上下文，是提示注入的现成入口 |
| | `POST /api/agents` | 任何会改 agent 配置的操作 |

MCP 与 CLI 都是 **daemon 的客户端**：不 import daemon 的任何模块，只通过本机 HTTP 说话，
所以可以被任意进程按需拉起，不需要与 daemon 共享生命周期。两者也都**只连 `127.0.0.1`**
（MCP 启动时校验，非回环直接退出）。

**CLI 的命令面**（`apps/cli/src/commands.ts`，14 条）：`status` / `issues` / `issue-create` /
`runs` / `run` / `run-verdicts` / `run-audits` / `run-cancel` / `reports` / `inbox` /
`inbox-read` / `costs` / `audits-export` / `skills` / `agents`。

- 默认输出 **JSON**（机器可读优先），`--human` 才给人看；`--daemon <url>` 指定地址。
- 退出码有含义：**0** 成功 / **1** 业务失败 / **2** 用法错误 / **3** 连不上 daemon。
- `main()` **返回退出码而不直接 `process.exit()`**——这样测试能钉住语义。
- 参数解析器**显式拒绝 `--`**（`args.ts`）：`pnpm run daemon -- --port 4517` 会让所有选项
  被静默忽略，而"`--sandbox` 被忽略"意味着你以为被保护着、其实没有。故意不用
  `node:util` 的 `parseArgs`——后者遇 `--` 会把之后一切当位置参数。

**MCP 的传输**（`apps/mcp/src/cli.ts`）：stdio + JSON-RPC 2.0（协议版本 `2024-11-05`），
逐行读 stdin 并**串行化**处理（避免响应乱序）；**stdout 是协议通道，日志一律写 stderr**。
错误分两层：协议层（未知方法/未知工具名）走 JSON-RPC `error`；
工具层（daemon 连不上、业务失败）走 `result.content[0].text` + **`isError: true`**——
让调用它的模型能看见失败原因。

### 7.5 并发与串行化

| 机制 | 文件 | 作用 |
|---|---|---|
| `Semaphore` | `semaphore.ts` | 全局并发上限（默认 20）。**先占槽再执行、不排队**——"已接受却排不上"比直接说"忙"更难理解；满则返回 `{kind:'rejected', reason:'no_capacity', retryAfterMs}`（HTTP 429） |
| `WorkDirLocks` | `workdir-locks.ts` | 同一工作目录串行化（D20）：占用时**不失败**，停放为 `waiting_local_directory` 并携带 `waitReason`——占用是**可恢复**的。FIFO；`release` 把持有权**直接交给队首**（不留空窗）；等待上限 `workDirWaitMs`（默认 10 分钟） |
| CAS 转移 | `ports/store.ts` 的 `transition*` | 状态变更带 `expect`，不符则 `false`，调用方重读重试 |
| 单实例锁 | `store-file/src/lock.ts` | 防止两个 daemon 同时写同一个数据目录（`LockHeldError{heldBy}`；用 `process.kill(pid, 0)` 判存活，陈旧锁可接管） |
| `RunRegistry` | `registry.ts` | 内存中的流式消息注册表 + **seq 分配** + SSE 订阅；`replayMessagesSince` 补齐 |
| `startIdleWatchdog` | `idle-watchdog.ts` | **空闲**超时（默认 30 分钟），不是墙钟：只判"有没有输出活动"，长任务不该被杀。用**轮询** `session.lastActivityAt()`——事件驱动重置定时器只要适配器漏一个活动点就会误杀正常进程 |

**进程内 vs 跨进程**：`WorkDirLocks` 与 `Semaphore` 只管本进程；跨进程由数据目录锁挡住
（一个数据目录同时只有一个 daemon）。

### 7.6 SSE 的两个坑（都写在代码注释里）

`streamEvents()` 的顺序不能反：

1. **先补齐历史，再挂实时订阅**。反过来的话，补齐过程中新产生的消息会重复。
2. **已经结束的 run 要补发一个 `terminal` 并立刻结束流**。原因是实测出来的 bug：
   `terminal` 事件**从不落库**，只由 registry 实时发一次——于是刷新后或连上时
   run 已经结束的页面，会永远等一个不会来的事件。
3. 心跳 `: ping` 每 15 秒一次（`setInterval(...).unref()`），断开时清理。

### 7.7 重启对账：`reconcile.ts`

daemon 重启时，上次退出时还在 `queued` / `dispatched` / `running` /
`waiting_local_directory` 的 run **再也不会有结果**（执行所需的 prompt 与技能正文
没有落盘）。对账把它们转成 `failed` 并带 `RunFailureReason.daemon_restarted`——
而不是记成 `cancelled`（那是"使用者主动停止"，写成这个等于在数据里撒一个谎）。

---

## 8. 执行与审核的完整链路

这一节给的是**模块之间的调用关系**；逐步的 prompt 与日志走查在
[`../runtime/pipeline.md`](./../runtime/pipeline.md)。

### 8.1 执行 run

```
POST /api/runs
  └─▶ RunExecutor.submit(req)                       executor.ts:290
        ├─ 幂等：runId 已存在 ⇒ {deduplicated:true}
        ├─ INV-1 校验（review 类 run 的审核者 ≠ 执行者）   ← 写入之前
        ├─ INV-17：同 (对象, agent) 已有进行中 run ⇒ 排除
        ├─ resolveWorkDir()（纯函数：<类型>-<id>，重试落回同一目录）
        ├─ ① 先落盘（status=queued）——先执行再落盘会让"点了没反应但 token 花了"
        ├─ semaphore / workDirLock 判定
        └─ 返回 {kind:'accepted', runId, acceptedAt}
             ↓（异步继续）
        transitionRun(queued → dispatched)
        ├─ 目录被占用 ⇒ dispatched → waiting_local_directory（携带 waitReason）
        └─ transitionRun(dispatched → running)
              ├─ ensureWorkDir()
              ├─ syncInjectedSkills()
              ├─ renderDelivery()（三块：A ⇒ ①② 进 systemPrompt、③ 进 prompt；B ⇒ 合成一段）
              ├─ backend.execute({prompt: ③, systemPrompt: ①②（A 档）, workDir, model, maxTurns, sandbox, …})
              │     ├─ 流式消息 ⇒ registry + appendRunMessage（带 seq）⇒ SSE
              │     └─ onCommandLine ⇒ redactArgv ⇒ AuditRecord
              ├─ 结果 ⇒ Artifact（blob）+ RunResult
              └─ finally：removeInjectedSkills()
                          + 释放 workDirLock + 释放 semaphore
             ↓
        autoChainReview({executeRun, executorAgentId, output})
```

`autoChainReview` 的**七种**"没接审核"必须**分开**（`apps/daemon/src/server.ts` 里那段注释与 `../runtime/pipeline.md` §8 的表一一对应）：

| 情况 | 是配置错误吗 | 处置 |
|---|---|---|
| `Run.reviewerAgentId === null` | 不是——这是**明确选择**"这次不审" | 只写 run 记录 |
| `reviewerAgentId` 省略（没选智能体组、也没点名） | 不是——★ 2026-10 起这是"选单个智能体"那条路的**必然结果** | 只写 run 记录 |
| 指定的审核者**已不存在** | **是**——配置过、现在失效 | 发通知 `review.reviewer_missing` |
| 审核者角色**被改**成非 reviewer | **是**——同上 | 发通知 `review.reviewer_role_changed` |
| 链路深度超限 | 意外 + 有后果 | 发通知 `chain.depth_exceeded` |
| 找不到这次执行用的 agent（记录被删） | **是** | 发通知（说清是谁没了） |
| 审核者**没有写「指令」**（2026-09 起这是资格判据） | **是**——配置问题，而且它审不了 | 发通知 + 日志写明去哪写 |

判据是"**意外 + 有后果 ⇒ 进通知中心**"：只写一行日志的话，发现它的唯一途径是有人去翻
这条 run 的日志（INV-8 通知必须稀缺，但"产出没被审、状态一切正常"够格）。

### 8.2 审核 run 与判决收口

```
审核 run 执行完（kind='review'）
  └─▶ ReviewCoordinator.handle({run, output, …})        review.ts:157
        ├─ 收集上下文：allowedActions（任务级覆盖优先）、已装工具包、
        │              fixedParams、invalidAttempts、maxReworks/usedReworks
        ├─ decideReview()                              domain/review/pipeline.ts:113
        └─ 按 decision 分支：
             act             ⇒ 写 VerdictRecord(validated) ⇒ ActionRunner.execute()
             advisory        ⇒ 写 VerdictRecord(advisory)
             escalate        ⇒ 写 VerdictRecord(escalated) + 通知
             rework          ⇒ 写 VerdictRecord(rework_requested) + createReworkRun()
             rework_exhausted⇒ 写 VerdictRecord(rework_requested) + 通知（进"等待人处理"）
             retry           ⇒ createRetryRun()（重试**审核者**，带上次的 issues）
             downgrade       ⇒ 写 VerdictRecord(advisory) + 通知
             invalid         ⇒ 写 VerdictRecord(escalated) + 通知
```

**判决的另一条来源：人工裁决（D46）**。上面这条路是**模型**产出的判决；人也可以
自己出一条，走 `POST /api/runs/{id}/human-verdict`：

```
人点「通过 / 反馈 / 放弃」（任务详情页，判决区之后那块）
  │
  ├─ 通过 ──▶ POST /api/runs/{id}/human-verdict  {reason?}
  │     ├─ canHostHumanVerdict(store, run)              server.ts
  │     │    ├─ 非终态 ⇒ 409
  │     │    ├─ review：没有判决 ⇒ 409；审的执行已被后来的一次执行取代 ⇒ 409
  │     │    ├─ execute：已有审核结论 ⇒ 409（**并指出该挂哪条审核 run**）
  │     │    │            审核正在跑 ⇒ 409
  │     │    └─ 其余 kind ⇒ 409
  │     └─ 追加 VerdictRecord（**不覆盖**，DR-3）
  │          status='advisory'（**恒为它**），conclusion='pass'（**恒为它**）
  │          reasonCode='human_decision'，source='human'，humanReason=<理由或 null>
  │          action=null（★ 恒为 null），modelId/promptHash=null，confidence=1
  │          ⇒ stageOf 判「已完成审查」
  │
  ├─ 反馈 ──▶ POST /api/runs（kind='execute', resumeFromRunId=上一次执行）
  │          **与 D47 之前的「发送并继续」是同一条路、同一段代码**（`sendFollowUp`）
  │          不落判决记录 ⇒ 新 run 未结束 ⇒ stageOf 判「执行中」
  │
  └─ 放弃 ──▶ POST /api/issues/{id}/abandon
             store.transitionIssue(id, 当前状态, 'cancelled')   ← CAS
             + 取消这条任务上还在跑的 run（subject 链：review → execute → issue）
             ⇒ stageOf 的 abandoned 覆盖 ⇒ 看板进「已放弃」那一列
```

**「通过」刻意不经过 `ReviewCoordinator`**：那条路会做重试、返工、降级、发通知
——而人已经下了结论，这些都不该发生。**也刻意不暴露给 MCP**：那等于让另一个
agent 冒充人的决定。

**「挂在哪条 run 上」的判据只有一处实现**——`apps/web/src/lib/pipeline.ts` 的
`stageOf`（`finished ?? humanOnExecute`）；界面把算好的锚点传过来，daemon 只校验
"这一条能不能被裁决"，不重算锚点。这条分工是刻意的：同一规则写两遍，两边迟早会
漂，而漂了的后果是"请求 201 成功、判决确实落库了、看板一动不动"。

**三个出路各自用最轻的机制（D47）**。它们并排显示，但不是同一件事：

| 出路 | 要的是什么 | 机制 | 为什么不共用 |
|---|---|---|---|
| 通过 | **结论** | 判决记录 | 看板只能从记录推出"通过了" |
| 反馈 | **干活** | 一条新的 execute run | 一条 run 已经足以让看板离开「等待人处理」；再补判决会带来"它该挂哪条 run"这个无解的问题 |
| 放弃 | **别再盯着它** | issue 的状态 | 与判决无关，而且它要**可撤销** |

`abandoned` 因此**不是流水线的下一站**：前六档全部由 run 推出来，这一档由 issue
自己的状态决定，并且**盖过**它们。实现上是在 `stageOf` 外面包一层覆盖（不是往
`deriveStage` 那六个早返回点里各插一个分支——漏一个的表现是"放弃过的任务偶尔还
显示在「等待人处理」"，取决于它当初卡在哪一档）。看板把它放在最后一列，与"越来越
接近结束"无关。

### 8.3 动作执行：`ActionRunner`

`apps/daemon/src/actions.ts` 的 `execute()`（`actions.ts:150`）：

```
execute({verdict, action, …})
  ├─ ① 幂等：findActionByIdempotencyKey ⇒ 命中转 skipped（不是静默成功）
  ├─ ② 解析动作定义：resolveActionDefinition(type, tools)
  │      ⚠️ 没有内置动作（D41）——动作只能来自已安装的工具包
  ├─ ③ 收口校验：mergeActionParams(action, facts, open, fixed)
  │      先校 open 参数 → 再绑定 bound 参数 → 合并 → 校验最终值
  │      固定参数（D43）在这里注入真实值，模型写过的判决在 decideReview 已判不合规
  ├─ ④ 调试短路（2026-09）：审核者给这个动作勾了「调试」⇒ **不跑脚本**，
  │      只记录动作与解析后的参数（`Action.dryRun: true`，时间线显示「调试 · 未执行」）
  │      （原来这里是"dryRun 判定：不支持预演的动作默认不自动执行"——已撤掉）
  ├─ ⑤ transitionAction(proposed → auto_approved → executing)
  ├─ ⑥ createScriptExecutor 起进程（node = process.execPath，不查 PATH）
  │      脚本与它的 HOME 落在 <dataDir>/tool-tmp/<本次专用子目录>，跑完即删
  └─ ⑦ transitionAction(executing → executed | failed)，写 result / error / rollbackRef
```

**平台不内置任何动作**（D41）：判决里写的 `<包 slug>.<动作名>` 没在审核者的
「行动权限」里勾上、或者那个包没装，判决就会**整条判为不合规**。

**脚本动作的执行环境**（`apps/daemon/src/script-executor.ts`，837 行）是这套设计里
最接近"执行任意代码"的地方，所以它的边界要单独说清：

| 边界 | 做法 |
|---|---|
| 解释器 | `node` 用 **daemon 自己那个**（`process.execPath`），**不查 PATH**——脚本与平台跑在同一个 node 上，也不受使用者的 PATH 影响；`shell` → bash、`python3` → python3 |
| 入口怎么起 | `spawn(command, [entryPath])`——**入口作为单个 argv，不经过 shell** ⇒ 没有注入面 |
| 工作目录 | 脚本的 cwd = **任务的工作目录**；拿不到时退到本次的临时 `work/` 目录，并在结果里**明说退到了哪里**——**绝不退到 daemon 的 cwd（那是安装目录）或使用者的家目录** |
| 环境变量 | **白名单**：`PATH` / `LANG` / `LC_ALL` / `LC_CTYPE` / `TZ` / `TERM`（Windows 另加 `SYSTEMROOT` / `WINDIR` / `PATHEXT` / `COMSPEC`）；**`HOME` 与 `TMPDIR` 都指向本次的临时目录** |
| 临时文件 | `<dataDir>/tool-tmp/tool-*/` 下分 `package/` `home/` `work/`，文件逐个经 `resolveInside` 写入（拒绝对路径、拒绝 `..`、按 `sep` 比前缀），`finally` 里递归删除（连失败路径） |
| 超时 | 按动作声明的 `timeoutMs`（1s–10min）；超时后杀**整个进程组**（Unix 杀组、Windows `taskkill /T /F`），最多再等 3 秒，等不到就**如实说"尚未确认已退出"** |
| 输出契约 | stdout 必须是**一个** JSON 对象 `{ok, detail}`——空 / 非法 JSON / 数组 / 缺 `ok` 各有独立报错，并带 stdout 尾部（2000 字符）与 stderr 尾部（600 字符）；捕获上限 256KB |
| 参数 | 全部经 stdin 传（`{action, params, dryRun, context}`），不拼进命令行 |

⚠️ 这个执行器**不做沙箱**：它继承 daemon 的权限（NG7）。它能做的限制是"参数有界、
环境干净、超时有界、入口不经 shell"，**不是**"它改不了你的文件"。

### 8.4 返工回路（D45）

`fail` 不再触发处置动作，而是把审核意见交回**执行者**重做：

```
审核判 fail
  ├─ 还有返工额度（run.maxReworks，0–5，默认 0）⇒ 派生一条返工 run
  │     同一个工作目录（上次留下的文件还在）+ 审核意见 + 上次的会话（尽力而为）
  └─ 额度用完 / 没配 ⇒ rework_exhausted ⇒ 通知 ⇒ 看板进「等待人处理」
```

额度的取法（`executor.ts` 的 `#reworkBudgetFor`）：**额度来自被审的那条执行 run**
（`maxReworks`），**已用次数就是它的 `chainDepth`**——每条返工 run 让 chainDepth +1，
所以不需要第三个计数器。审核的是第三方报告（`subject.type !== 'run'`）⇒ 额度为 0。

⚠️ 这与 `retry` 是**两个方向**：`retry` 重做的是**审核者**（它没按格式输出），
`rework` 重做的是**活本身**。两个计数分开（`invalidAttempts` vs `usedReworks`）。

返工是一条**新的 run**（不是给旧 run 追加消息）：一次 run 的产出是不可变快照，
往里塞新输入会让"它当时收到了什么"不可回答，审计链也就断了。

### 8.5 看板的阶段是**推出来的**

任务详情/看板的六列（执行中 / 待审查 / 行动中 / 等待人处理 / 已完成审查 / 已放弃——最后一列不是流水线的一站，见 §8.2）
不是一个人工维护的状态字段，而是从执行记录**推出来的**：

- 「已完成审查」= **判决已产出且它要求的动作做成了**；
- 动作还在跑 ⇒ 「行动中」；失败了 ⇒ 「等待人处理」；
- 审核判「不通过」且没有返工可跑（次数用完、或这条任务没配）也进「等待人处理」——
  那是"要你去改"，不是"做完了"。

前端把这条推导逻辑放在 `apps/web/src/lib/pipeline.ts`（有对应测试 `pipeline.test.ts`）。

---

## 9. 扩展点

### 9.1 加一个 runtime（CLI）

见 §6.2 的三步。造完请跑 `apps/daemon/src/runtime-agnostic.test.ts`。

### 9.2 加一个工具包（动作）

一个目录 + `tool.json` + 入口脚本：

```
my-tool/
├── tool.json     清单（schema / slug / runtime / entry / actions[]）
├── TOOL.md       说明（人读，显示在界面上）
└── scripts/*.mjs 入口脚本
```

可照抄的示例：`examples/tools/example-note/`（本机）、
`apps/remote/catalog/tools/`（远端目录：`hello-tool/` 最简形；
`example-notify/`、`example-llm/`、`example-issue/` 覆盖 string/integer/boolean/enum
四种开放参数与三种绑定参数）。

装完之后要在**审核者**的「行动权限」里勾上动作（D40 收口）——勾的动作还能**钉固定参数**。

### 9.3 装 skill 的来源与出网边界

| 来源 | 谁下载 | 边界 |
|---|---|---|
| 本地目录路径 | **daemon** | 页面读不到本地目录，所以这条路必须由 daemon 走 |
| GitHub 链接 | **daemon** | 见下 |
| 远端公共目录 | 页面 | 远端只列内容、**不经手安装**，装由本机做并再校验一遍 |

⚠️ 界面上的「从本地安装」页签（扫 `~/.claude/skills` 那类目录）**不是第四种来源**：
它扫出来后走的就是**本地目录路径**那条路（装完落盘、`sourceRef` 带 `localdir:` 标记，D73）。
所以出网边界没有变化。

⚠️ **唯一一处 daemon 会主动出网**：从本地路径 / GitHub 装 skill。
边界**写死在** `packages/skill-source/src/skill-source.ts`：

- 只允许 **https**；
- 只允许 GitHub 的几个主机；
- **每一跳跳转都重新校验主机**；
- 限大小 / 文件数 / 超时。

要扩到任意 URL 得单独做——**让本地服务去抓任意地址，等于给它一个访问内网的跳板**。

**两条路都要过同一关**：来源里必须有 `SKILL.md`（**大写**）。技能是靠"把目录摆对"
被 CLI 发现的，没有它就永远不会生效——而你会以为自己装好了。所以缺了会**当场拒绝**，
并把那个目录里实际有什么列出来。大小写不对（`skill.md`）会单独提醒：
macOS 上能碰巧读到，Linux 上不行。

### 9.4 加一个远端插件

`apps/remote/src/plugins.ts` + `plugin-store.ts` + `loader.ts`：插件声明
`PluginCapability`（`login` / `third-party`），可被逐账号启停
（`POST /api/plugins/{name}/enable|disable`）。

---

## 10. Web UI 结构

### 10.1 技术栈与两条约束

| 层 | 选型 | 为什么 |
|---|---|---|
| 框架 | **Svelte 5** | 编译成很小的原生 JS，**没有运行时框架要下载**——与"daemon 托管静态文件、断网可用"最合 |
| 构建 | **Vite 6** | 产物输出到 `apps/web/dist/`，daemon 只当它是普通静态文件，**不知道 Svelte 的存在** |
| 依赖 | 3 个（全在 devDependencies） | 运行时零前端依赖 |
| 样式 | 手写 CSS + 设计令牌层（`src/styles/app.css`） | 间距（4 的倍数）、字号层级、语义化颜色集中在一处 |
| 实时 | 原生 `EventSource`（SSE） | 按 seq 补齐，刷新 / 重连都不丢消息 |

`vite.config.ts` 的两条约束：**产物必须能被 daemon 当普通静态文件发出去**（`base: './'`，
相对路径）、**必须没有 CDN 依赖**（页面跑在 127.0.0.1 上，用户可能完全离线）。

开发模式（`pnpm run dev:web`）：Vite 起在 5173，把 `/api` 代理到 daemon 的 4517——
**浏览器看到的仍是同源**，所以开发与生产走同一套同源假设，
不会出现"开发能跑、上线 CORS 炸"。

> ⚠️ 构建产物**不进版本库**，而 `vite build` 会清空 `dist/`。clone 之后直接起 daemon
> 会没有界面（daemon 会明确提示你跑 `build:web`，而不是发一个空白页）。

### 10.2 视图与模块

| 视图 | 路由 | 做什么 |
|---|---|---|
| 聊天 | `#/chat` | **闭环的旁路**（D49）：多个对话，一个对话绑一个执行者。一轮对话 = 一条 execute run，所以流式 / 停止 / 刷新后还在跑都是白拿的；**有自己那份很薄的 ①**（`chatTemplate`：不是派活 + 语言 + 技能清单），**② 照发**，③ 是那句话**逐字**（⚠️ 2026-09 修正：在此之前它什么都不套——那让同一个 agent 在两条路上性格不同。工作目录走 `workDir` 字段，不写进正文）——任务是"被交代一件事"，聊天就是说话；`reviewerAgentId: null`、`subject.type = 'conversation'` ⇒ **没有判决这条出口，也就触发不了任何动作**（⚠️ 2026-09：页面上那句常驻的"这里不动手"按要求去掉了；⚠️ **2026-10：连「派发任务」也去掉了**（D57——原来两个按钮「把整个对话派出去」/「用这个去派活」会把内容预填进「新建任务」）⇒ 这一页现在与闭环**完全不相通**：不产出判决，也不往「新建任务」送东西）。⚠️ 页面形状：左窄右宽两栏；**输入框在草稿态与已有对话两支里都在**（对话由第一句话诞生，草稿态没有输入框＝这条路走不通——布局探针抓过一次）；Enter 发送 / Shift+Enter 换行，与「要做什么」**正好相反**，所以两处各自写在输入框下面；⚠️ 「新对话」的执行者下拉里**两组选项**：执行者，以及**每一条装着的 skill**——有主的选了就等于选挂着它的那个执行者（绑定仍是一个 `agentId`）；没人挂的绑当前执行者、并由 `Conversation.skillIds` 让这个对话自己带着它（每轮注入 = 执行者挂的 ∪ 对话带的）。选完界面上要写出「将使用谁」（有主/没主两种说法）；`skillIds` 只读，对话头部显示出来。布局探针四条钉住，含"所有已安装的都必须在选项里""选完之后绑的必须是接口上真挂着它的那个执行者""选了没人挂的那条时**发出去的请求体里真的带上了 `skillIds`**"；⚠️ 右栏底部还有一栏**「工作目录的文件」**（默认收起、头部写出条数），它按**对话**问目录（`GET /api/conversations/:id/files`，与任务详情右边那一栏**共用** `components/WorkDirTree.svelte`，差别只有 `base`）：一个对话可能还没有任何 run，而它的目录属于对话；目录用 `resolveWorkDir` 算（与出 run 同一个函数），`exists` 把"还不存在"与"空的"分开，顺序由界面侧的 `sortWorkDirEntries` 保证（服务端返回目录自己的顺序）。布局探针十条钉住（那一栏在不在、列没列到夹具文件且**注入物排在产出后面**、一次只列一层、草稿态不画、旧 daemon 上说明原因而不是去撞 404；再加上**查看器那十条**：**「原文」逐字等于接口发回来的字节**、Markdown 两面都对（渲染面是 `h1`、原文面是字面量 `# 结论`）、iframe 的 `sandbox` 属性没有 `allow-same-origin` 且父页面**读不到**它的 document、二进制只给说明与十六进制、超大源码不着色但原文完整；⚠️ 2026-10 又加了音视频那五条——视频渲染成 `<video controls>` 且 `readyState >= 1`（真解出了元数据）、带 `Range` 的请求回 **206** 且只有那一段字节、媒体响应**不带**那条 sandbox 的 CSP 而文本那档照旧带、音频同理、以及"放不出来的容器要说一句人话"）。⚠️ 点文件**不再跳新标签页**，而是就地打开查看器（`components/FileViewer.svelte`，判定在 `lib/file-view.ts`） |
| 建任务（不是视图） | `#/tasks/new`（老地址 `#/new` 一样直达） | ⚠️ **2026-10（D58）：「新建任务」不再是一项导航，也不再是一个视图**——侧栏只剩五项，那张表单**住在「任务」页右栏里**：顶栏那个主操作（`kind: 'primary'`）只是把右栏切成它（`goCreate()` → `#/tasks/new`）。⚠️ **它不是第 6 个视图**：`VIEWS` 里没有 `new`，路由解析出来的是一对 `{ view: 'tasks', creating: true }`（`apps/web/src/lib/route.ts`，纯函数、有单测）。⚠️ 三个具体后果：① **`with-detail` 必须把"正在建"也算进去**——窄屏那条 `.split-layout:not(.with-detail) .detail-pane { display:none }` 会把它整栏藏掉（"点新建任务什么都不出现"，宽屏上看不出来）；② **进建任务要把模式拨回列表**（右栏只在列表那一档存在；模式存在 `localStorage` 里，"上次用看板"的人点进来会屏幕上什么都没有）；③ 填过东西再切走要先问一句（`lib/create-draft.ts` 那个 store + `lib/leave-create.ts` 那个守卫 + `askConfirm`）——⚠️ 那一栏上面**没有**返回按钮（2026-10 按要求去掉），出口是**顶栏的「列表 / 看板」**与**侧栏的「任务」那一项**，而这两处都要过同一个守卫（各写一遍的后果不是重复而是**漏**——漏掉的那条正是静默丢草稿的那条）；顶栏的「列表」在建任务时不能是空操作（`mode === next` 也要放行）。**浏览器后退拦不住**（地址是路由的唯一出处，拦一次后退要么"改地址再改回来"、要么上 History API——这个应用刻意不用），真正的解法是把草稿留在 store 里，见 §15.36。三步链：**执行 → 审核 → 行动**（D42）。默认值从长期配置推导，②③**只为这一次**可改，三处都提前说清后果。⚠️ 页面形状：任务内容只有**一个多行框**（没有"标题 + 补充说明"两个字段——切分在 `apps/web/src/lib/request-text.ts`：第一行当标题、其余进说明，全文进 `prompt`；**默认 3 行、随输入长高、15 行封顶**）；三步是**两列**（左列 ① 执行拉满两行，右列 ② 审核在上、③ 行动在下）；③ 的行动选择器住在一个**居中对话框**里（`components/Modal.svelte`），页面上只剩「选择动作…」+ 计数，允许的动作以胶囊列在 ③ **卡片里面**（契约值 + **已固定 `name=value`（与契约值同一行）** + `summary`——只列钉死的值，不列"由模型填 / 平台注入"，那两行使用者没法据它做决定）；提交栏**吸底**（`position: sticky`），滚动时始终可点，错误提示也在那一栏里 |
| 任务 | `#/tasks` | 列表 / 看板（六列，阶段是推出来的，见 §8.5；「已放弃」由 issue 状态覆盖，见 §8.2）；⚠️ **2026-10（D58）：建任务的入口在这一页**（顶栏那个主操作），而且表单就开在这一页的**右栏**里（见上一行）——这一页因此同时是"看"和"建"两个方向的门。右栏一次只放一件事（某条任务的详情 / 建任务那张表单），两者互斥，切换要过守卫 |
| 智能体 | `#/agents` | 主从布局。详情里有「由谁审它」、**「指令」（② 身份：判断依据就写在里面，老数据那份老标准也显示在这一栏并带一键并进）**、**挂载的 skill**、**行动权限**编辑器（左选右配，D43/D44）。⚠️ 2026-09 起**没有单独的「审核标准」那一栏了** |
| 技能 | `#/skills` | 四页签安装（路径 / GitHub、**从本地安装**、远端目录、本地清单）+ 卸载（D38；本地技能目录由"自动对账"改成显式安装，D73） |
| 工具 | `#/tools` | 安装 / 查看工具包；放行"不支持预演的动作"的开关也在这里 |

**路由是极简的 hash 路由，没有路由库**（`src/lib/route.ts` 是判据、`src/lib/view.ts`
是它的两个 store）：白名单是 `VIEWS` 里那五个值（`chat` / `tasks` / `agents` /
`skills` / `tools`），不在白名单里回落 **`#/tasks`**。⚠️ 2026-10（D58）三处：
① 回落目标从 `#/new` 改成 `#/tasks`——合并之后"任务"才是主场，把人扔到一个表单上
会显得莫名其妙；② `#/tasks/new` 与老的 `#/new` **都解析成同一个状态**
（`{ tasks, creating: true }`），老地址继续有效（书签、文档、探针都在用），而
`hashFor()` 只吐正规那个；③ **判据从 `view.ts` 里搬到了 `route.ts`**——原来它在
`view.ts`（那个文件挂着 store 与 `window`，`node --test` import 不了），于是
"地址解析得对不对"从来没被测过，只能隔着浏览器看；现在 `parseHash`/`hashFor`
是纯函数、有单测，而且有一对往返测试（`VIEWS` 逐项过一遍）。之所以用 hash
而不是 History API：
daemon 的静态服务**不做 SPA 回退**，`/tasks` 这样的路径会真的 404。

**"选中了哪个任务 / 哪个 agent"不进 URL**（是组件内的 store），刷新即丢。

`src/lib/` 里的模块（多数有对应测试）：

⚠️ 行数是 **2026-10 的快照，只作量级参考**——它涨得比文档快，别拿它当判据（改文件时也不必同步这一列）。

| 文件 | 行数 | 职责 |
|---|---|---|
| `api.ts` | 821 | 同源 API 客户端 + 全部响应类型（**刻意不 import `packages/protocol`**：前端类型是独立的视图形状） |
| `stores.ts` | 571 | 共享状态（identity / agents / runs / skills / tools / inbox …）+ 全部 load/写入口 |
| `pipeline.ts` | 694 | 任务阶段推导（看板六列的判据）+ 执行记录时间线 |
| `newtask-chain.ts` | 431 | 新建任务三步链的默认值与覆盖语义（`follow` ⇒ 请求体里**不出现该键**） |
| `markdown.ts` | 287 | 自写 Markdown 渲染器（顺序是硬规则，见 §7.3） |
| `tool-install.ts` / `skill-install.ts` | 258 / 249 | 安装流程 + 错误码 → 建议文案键 |
| `sync.ts` | 242 | 上报队列 + 拉 `pending` 的轮询循环（**失败不抛异常，只落状态**） |
| `remote.ts` / `remote-store.ts` | 198 / 100 | 远端跨源客户端（凭证放 localStorage + `Authorization: Bearer`，**不用 cookie**——页面跑在明文 http）/ 远端账号状态单一来源 |
| `agent-actions.ts` | 217 | 行动权限展示（含老数据从 `reviewStandard.allowedActions` 的只读回退） |
| `chat.ts` | 214 | 聊天的纯逻辑：终态那一列（有测试**读协议源码**把它钉上，抄的东西会腐烂）、"正在跑"看状态而不是看界面记没记住，以及"新对话"那个下拉的选项（`executorChoices` / `applyChoice`——**skill 是执行者的另一条入口**：只认执行者、多人挂同一个 skill 时优先平台默认执行者、**没人挂的也能选**（绑当前执行者 + 由对话自己带着）、选没人挂的那条时不许把执行者换掉、以及"工作目录那一栏该不该画"（`chatFilesState`：草稿态 / 旧 daemon / 正常）） |
| `time.ts` | 45 | **相对时间与完整时间戳的唯一出处**（`relativeTime` / `absoluteTime`）：列表一律显示相对时间、准确时间放 `title`。⚠️ 这两个函数原来住在 `chat.ts` 里——而时间格式化跟聊天没关系，结果每个页面各写一份（任务列表只到天、技能/工具表到分钟、聊天与智能体列表干脆不显示）。⚠️ 相对时间那四条词条也随之从 `chat.*` 提到 `common.*` |
| `confirm.ts` | 74 | **平台自己的确认框**（`askConfirm` → `Promise<boolean>`），取代 `window.confirm`：浏览器那个是浏览器 chrome（位置、样式、语言都归它管，还会阻塞整个 JS 线程，在部分 webview 里干脆被忽略）。命令式是因为四处调用点（删对话 / 删任务 / 卸技能 / 卸工具包）要的是同一件事；全局只有一个待答请求，后来的把前一个按**取消**收场（否则那个 `await` 永久挂起） |
| `file-view.ts` | 412 | 文件查看器的判据：按 content-type 与扩展名分类（⚠️ 2026-10 加了音视频，含"老 daemon 回 octet-stream 时按后缀补上"那一档）、默认看哪一面、**取字节还是交给播放器**（`previewMode`）、着色阈值（256KB）、语言映射（认不出给 null，绝不 `highlightAuto`）、十六进制、CSV 拆表（RFC4180 最小集）。全部纯函数、有测试——写在模板里的分支只能靠手点界面验证，而"Markdown 被当纯文本显示"**不报错** |
| `tool-view.ts` / `workdir-view.ts` / `skill-catalog.ts` / `view.ts` / `locale.ts` / `i18n.ts` | 124 / 100 / 235 / 110 / 34 / 68 | 视图模型、目录版本比较（安装/更新/退回）、路由与本地化 |

**SSE 的处理不在 `src/lib/`，而在 `src/components/RunLog.svelte`**（590 行）。
三条值得知道的实现约定：**起点永远是 `since=-1`**（游标只用于重连，父组件无法传错）；
`seq` 驱动去重（`seq <= lastSeq` 直接丢）；收到终态后 `close()` 不再重连，
否则自己接管重连（退避 500ms 翻倍、封顶 10s）并插一行 `disconnected`。

**样式是单一文件** `src/styles/app.css`（917 行）：设计令牌全在 `:root`
（字号 / 行高 / 圆角 / 间距 `--sp-1..5` / 语义色 / 布局 `--sidebar-w` `--topbar-h` /
字体），**深色是唯一主题**，断点只有两个（72rem 与 60rem）。
`tools/layout-probe/` 用真浏览器量布局，专门抓 `tsc` 看不见的那类缺陷。

### 10.3 界面语言的边界（D39）

**只翻界面文字**（菜单、按钮、提示、标题）。判决里的 `pass` / `needs_human`、
动作名 `包名.动作名`、状态 `in_progress` 这类**机器读的值一个字都不翻**——
它们要在模型、执行器、审计三方之间对齐，翻错它是功能错误而不是难看。
所以判决卡片上显示成 `needs_human 需要你判断`：**值原样，标签跟着语言走**
（标签映射在 `packages/i18n`）。

模型的**答复**语言也跟着选的语言走（prompt 里加一句"请用简体中文回答"），
但**已经写进库里的日志、通知、历史记录不回译**——它们记的是当时发生的事实。

---

## 11. 远端服务

`apps/remote/src/server.ts`（771 行），默认端口 4518。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| POST | `/api/accounts/register` | 注册 |
| POST | `/api/accounts/login` | 登录（发 token） |
| GET | `/api/catalog` | 公共目录：**工具包**（`apps/remote/catalog/tools/`，仓库内）+ **技能**（`<dataDir>/catalog-skills/`，由**独立工具** `pnpm run sync-skills` 写，本服务只读） |
| GET | `/api/catalog/skills/sync` | 同步状态（`idle/running/ok/failed/unavailable` + 开始/结束时间、退出码、输出末尾若干行）。**公开** |
| POST | `/api/catalog/skills/sync` | 触发一次同步：把独立工具当**子进程**跑（服务不 import 抓取代码）；**单飞**（跑着再点回 409）；**非回环 Origin 一律 403**（浏览器对简单请求不做预检，光靠 CORS 拦不住）。202 = 已开始 |
| POST | `/api/catalog/skills/local` | **手动装一条技能**进远端目录的**本地层**（`<dataDir>/catalog-skills-local`，D52）：复用与 daemon 同一份取包规则（只允许 GitHub、必须有 `SKILL.md`）；**撞名一律 409**（不覆盖）；**非回环 Origin 403**。201 = 装上了 |
| DELETE | `/api/catalog/skills/local/<slug>` | **卸载**（只对本地层）：同步来的那条会 **409 拒绝**并把替代路径写清楚（改清单 → 重新同步）；不在本地层 ⇒ 404 |
| GET | 其它路径 | **管理页静态文件**（`apps/remote/web/dist`，D51）：未知路径回 `index.html`（hash 路由兜底）；`resolve` 之后必须仍在页面目录内（穿越不出去，有测试）；产物没构建时回一句"先跑 `pnpm run build:remote-web`"而不是 404 |
| GET | `/api/me` | 账号 + 插件清单（⚠️ 2026-10 起**界面上没有展示它的地方**了，见 D56；接口本身仍然如实——FR-PLUGIN-10） |
| GET/PUT | `/api/settings` | 用户设定（含 `reportingEnabled`） |
| GET | `/api/pending` | 待处理项（页面轮询它，取回后投给本机 daemon） |
| POST | `/api/third-party/query` | 第三方查询转发 |
| POST | `/api/records` | 接收**摘要**记录（用量、状态变更） |
| GET | `/api/stats` | 统计 |
| POST | `/api/plugins/{name}/enable` 与 `.../disable` | 插件启停 |

### 11.1 数据归属：同步**不经过 daemon**

```
远端 → 页面 → 本机 daemon     取回待处理项，投给 daemon 走审核流程
本机 → 页面 → 远端            上报摘要（用量、状态）
                               远端不可达时本地暂存、恢复后补交（sync.ts）
```

**上报什么**：只有摘要——执行的用量与状态、任务的状态变更。**不含** prompt 正文、
代码、报告原文（`sync.ts` 的 `collectRecords` **只取 id/状态/时间**，结构上就拿不到正文）。
远端那份副本是**同步快照，不具证据效力**，权威记录在本机 daemon 里。
关闭上报 = 给远端写 `reportingEnabled: false`（`PUT /api/settings`；**界面上暂无入口**，见 D56），关闭后本机功能**完整可用**；
远端整体不可达时同样如此。

### 11.2 存储与安全

| 文件 | 内容 | 说明 |
|---|---|---|
| `<dataDir>/remote.json` | `{accounts[], tokens[], settings[]}` | ⚠️ **收到的记录不在其中**（见下） |
| `<dataDir>/plugins.state.json` | `{enabled, config}` | 插件启停与配置 |
| `<dataDir>/plugins.secrets.json` | `{secrets}` | 权限 **`0o600`**，**单独一个文件**是为了让"普通设定"在结构上不可能含密钥 |
| `<dataDir>/plugins/<name>/plugin.json` | 插件目录 | 入口必须在插件目录内（按路径解析后比 `relative`，**字符串前缀判断是错的**） |
| `apps/remote/web/**` | **管理页**（第二个前端，D51） | 产物 `dist/` 由远端服务当静态文件发在 `/`；**与 daemon 界面共用 `@agentdeck/ui`**（同一份设计令牌与主题判定）、共用 `@agentdeck/i18n`（命名空间 `remote/`）；只读 + 一个"重新同步"按钮（把独立工具当子进程跑） |
| `apps/remote/catalog/tools/**` | 公共工具包目录 | 每次请求**重扫磁盘**；用**与 daemon 同一份** `ToolManifest` schema 校验；限额 128KiB/文件、512KiB/包、32 文件；**符号链接一律不跟随** |
| `tools/skill-catalog-sync/recommended-skills.json` | **推荐清单**（手写，跟同步工具放一起） | 只有 GitHub 链接、我们自己写的说明，以及可选的 `include`/`exclude`（相对技能目录的 glob，用于"整仓即技能"那种混着营销素材/测试产物的仓库；`SKILL.md` 不许被排除）——**不含第三方内容**。⚠️ 它**不在** `apps/remote/` 里：清单与抓取都属于工具，远端服务不知道它的存在 |
| `<dir>/catalog-skills/**` | 公共技能目录（**推荐清单抓下来的内容**） | 由**独立工具** `pnpm run sync-skills --out <dir>` 写（默认 `~/.agentdeck/remote/catalog-skills`）；远端服务每次请求**重扫磁盘**，用**与 daemon 同一份**取包规则（`@agentdeck/skill-source`）读回；元数据在旁边的 `.sync.json`（放进技能目录会被当成支持文件装给使用者）。**目录是工具与服务之间唯一的约定** |
| （可选）GitHub 加速器 | **工具/daemon 可选的第三方出口**（`--github-proxy`，裸写 = `gh-proxy.com`） | 只代理 GitHub 那三个主机、**不带 token**、默认不用（裸写只是省打字）；开了等于让第三方进入链路（能看也能改内容）。远端服务**不参与**这件事 |
| `<dataDir>/recommended-skills.json` | 推荐清单的**配置文件**（D54） | 第一次跑同步时由工具把**内置默认**（`tools/skill-catalog-sync/recommended-skills.json`）转存到这里；之后工具与服务都读**这一份**（服务只读、绝不写）。`--manifest <文件>` 可另指一份（那时不转存） |
| `<dataDir>/catalog-skills-local/**` | **本地层**：管理页上**手动装的**技能（D52） | 与同步目录**并列**展示、来源徽标「本地添加」；同名时**同步来的优先**（本地那条不列出并记 warning）。同步工具**永远不碰**它 ⇒ 手动装的东西不会被下次同步抹掉 |
| `<dir>/catalog-skills.partial/**` | **断点目录**（工具自己用，服务不看） | 抓一条落一条：撞限额/被杀时**已发布目录一个字都不改**（P7），但已抓到的留着，下一轮只补缺的；整轮成功后才删掉。断点那份**跨小时也沿用**（花过配额的不丢）——否则匿名限额下多轮也凑不齐一轮 |

- 认证：`Authorization: Bearer <token>`（`randomBytes(24)`），口令哈希是
  `sha256(salt + ':' + password)` + `timingSafeEqual`。
- **CORS 只在回环 Origin 上放行**（`isLoopbackOrigin`）：`127.0.0.1` / `localhost` /
  `::1` / `[::1]`——远端服务也是本机服务，不是公网服务。
- 插件密钥**只回键名**，值经 `secretOf()` 供插件在进程内取用，**绝不经过 API**。
- ⚠️ **`POST /api/records` 收到的记录只存内存**（裁剪到最近 5000 条，重启即丢），
  所以 `GET /api/stats` 是**进程内统计**。这是刻意的：它只是统计，不是权威记录。
- ⚠️ 当前有**几个端点没有 Web 消费者**：`/api/third-party/query`、`/api/stats`、
  `/api/plugins/{name}/secrets`。它们是给别的客户端预留的接口面。

### 11.3 公共目录与插件

- **工具包**目录落在 `apps/remote/catalog/tools/<slug>/`（`tool.json` + `TOOL.md` + `scripts/`），
  由 `catalog.ts` 读取。四个示例包：`hello-tool`（最简形）、`example-notify`（枚举 + 布尔 +
  整数参数）、`example-llm`（数值边界）、`example-issue`（同包两动作 + **`reversible: false`**）。
- **技能**目录是**推荐清单**（D50，2026-10 改为**独立工具**）：清单
  `tools/skill-catalog-sync/recommended-skills.json` 里只有 GitHub 链接与我们自己写的说明；
  维护者跑 `pnpm run sync-skills`（工具在 `tools/skill-catalog-sync/`，**不在 `apps/remote/` 里**），
  它用**与 daemon 同一份**取包规则（`@agentdeck/skill-source`）把内容抓下来、校验、写进
  **一个目录**（默认 `~/.agentdeck/remote/catalog-skills/`，**不进代码仓库**），再原子替换整个目录。
  ⚠️ **拆分是刻意的**（使用者原话："还是单独工具吧，不要和 remote 连在一起"）：抓取要联网、
  要过 GitHub 限额、还可能因上游改名而失败，这些都是**维护时刻**的事，不该混进"服务在跑"
  这条路径；工具崩了不影响服务，服务也不必为抓取装任何东西。两边**只靠目录相连**——
  工具用 `--out` 说了算，服务用它自己的 `--data-dir` 去读，谁也不知道对方是谁。
  `loadCatalogSkills()` 每次请求重扫它，所以同步完**不用重启**。
  ⚠️ 单条失败 ⇒ **整个目录一个字都不替换**（P7：宁可失败，不可静默降级——半份目录会让
  使用者点到一个"看起来能装、其实是半截"的条目，而维护者以为同步成功了）。
  ⚠️ `GET /api/catalog` 的 `skills` 因此**可以为空**（还没同步过、或清单是空的）——界面
  有对应空态，且与"远端不可用""未登录"分开说（三者的下一步不同）。
- 插件：`plugins.ts`（契约）、`plugin-store.ts`（持久化）、`loader.ts`（加载）。
  `PLUGIN_API_VERSION = 1`；能力白名单 `login` / `third-party`；scope 白名单
  `account:identify` / `thirdparty:query` / `settings:read`——**未声明即拒绝**。
  **失败隔离**：坏插件只影响自己（`enabled: false` + `error`），
  且 `/api/me` 会把它报出来（不会静默降级成"看起来一切正常"）。
  ⚠️ 插件**不做沙箱**，能力边界靠 `scopes` 的声明式约束。

---

## 12. 横切关注点

### 12.1 审计与脱敏

| 环节 | 文件 | 要点 |
|---|---|---|
| 记录 | `domain/audit/record.ts` | `buildAuditRecord()`：`inputBlobRefs` / `skillRefs` / `runtimeDescriptorKey` / `cliVersion` / `modelId` / `promptHash` / `argvRedacted` / `verdictId` / `actionIds` / `usage` |
| 脱敏 | 同上 `redactArgv()` | 敏感标志（`--token` / `--api-key` / `--password` / `-t` …）与值模式（`sk-` / `ghp_` / `Bearer …` …）⇒ `***`；支持 `--k=v` 与 `--k v` 两种写法 |
| 导出 | `domain/audit/export.ts` | 稳定排序 + 校验和（canonical JSON 的 sha256）+ **三条如实披露的 `limitations[]`** + `verifyAuditExport()` |
| 快照 | `domain/audit/snapshot.ts` | 全量数据导出/导入，**只增不改**（已存在 id 跳过），统计悬空 `blobRef` |

**脱敏只能有一份**：适配器包依赖不到 `domain`（依赖方向：`domain` ← `agent-core`
← `agent-claude`），所以后端只负责**如实上报**命令行，由调用方决定怎么脱敏、怎么记。
让适配器各写一份脱敏，就等于有两份安全逻辑——它们迟早会漂，而漂的那一次
就是把令牌写进了日志。

`promptHash` 哈希的是**真正投递的文本**（不是模版，也不是材料的哈希）——
这样"它当时收到了什么"是可回答的。

### 12.2 成本

`TokenUsage{costUsdMicros}` 用**整数微美元**（不用浮点：浮点累加会漂）。
`aggregateCost()` 给出 `{total, byAgent, byKind, runsWithoutUsage}`——
最后一项是**如实披露**：没有用量的 run 有多少条，而不是把它们当 0 算进总额。

### 12.3 错误处理的三条口径

| 口径 | 例子 |
|---|---|
| **宁可失败，不可静默降级** | 沙箱拿不到工具 ⇒ 抛；端口被占用 ⇒ 大声失败（不静默换端口——随机端口意味着"重启后地址变了"，而地址会被写进书签与配置里） |
| **不得静默丢弃** | 未匹配的报告：存下 report **并**发通知；卸载还被引用的 skill：**被拒**并列出是谁挂着 |
| **失败要说清是哪一种** | `RunFailureReason` 是闭合枚举（`daemon_restarted` / `idle_timeout` / `cli_unparsable_output` / `injection_failed` / `agent_error` / `infra_error` / `cancelled_by_user` / `verdict_schema_invalid`） |

### 12.4 测试与开发纪律

- **测试里绝不调用真实 CLI**（NFR-T-01）：注入假的 `AgentBackend`（`DaemonOptions.backend`），
  GitHub 相关的注入 `fetchImpl`。会消耗真实额度、还可能让 agent 改文件。
- **测试的临时目录建在仓库内**（`.cache/test-tmp`），不用系统 tmp——受限沙箱里后者可能不可写。
  还有一条自动检查（`tests/test-safety.test.ts`）：测试文件里**不许出现 `tmpdir()`**，
  也不许对危险目录做递归删除（这条规矩来自一次真实事故）。
- **注释与测试名写"为什么"**，用中文，包括踩过的坑：哪一版错了、错在哪、怎么发现的。
  这是这个仓库最主要的防复发手段——**只写结论的注释留不住教训**。
- **不要留死接口**：这个仓库最常见的缺陷是"字段 / 接口 / 界面都在，就是没有代码路径
  让它发生"。留下一处死接口，早晚会有人以为它生效了。
  （现存的两处已知例外见 §14。）
- **界面的验证方式**：`tsc` 看不见 `.svelte` 模板，所以界面改动要过 `svelte-check`
  （`pnpm run check` 里已包含）；改布局再跑 `pnpm run probe:layout`（真 Chrome + 真 daemon，
  **不在 `check` 里**）。

规模参考：后端源码约 35.6k 行（非测试），测试 74 个文件 / 30.8k 行。

---

## 13. 代码索引（想改 X，去哪）

| 想改 | 去哪 |
|---|---|
| 判决的字段 / 取值 / 围栏标记 | `packages/protocol/src/verdict.ts` |
| 状态、原因码、动作名、失败原因 | `packages/protocol/src/enums.ts` |
| 实体字段（Agent / Run / Action …） | `packages/protocol/src/entities.ts` |
| 本地接口的形状 / 版本号 / capability | `packages/protocol/src/local-api.ts` |
| 状态机转移表 | `packages/domain/src/state/{run,verdict,action}.ts` |
| 判决 → 决策的分流 | `packages/domain/src/review/pipeline.ts` |
| 动作白名单 / 参数绑定 / 固定参数 | `packages/domain/src/actions/tool-actions.ts` |
| 回路边界（深度 / 环） | `packages/domain/src/loop/{bounds,chain}.ts` |
| 报告 → 审核者的路由 | `packages/domain/src/routing/kind.ts` |
| 审计脱敏 / 导出 / 快照 | `packages/domain/src/audit/{record,export,snapshot}.ts` |
| 存储端口（加方法） | `packages/domain/src/ports/store.ts` → 两套实现都要改 |
| 本地接口路由 / 中间件 | `apps/daemon/src/server.ts`（`startDaemon`） |
| run 的执行流程 | `apps/daemon/src/executor.ts` |
| 审核收口 | `apps/daemon/src/review.ts`（+ `review-standard.ts`） |
| **人的三个出路**（D46 / D47） | daemon：`apps/daemon/src/server.ts` 的 `canHostHumanVerdict` + `POST /api/runs/{id}/human-verdict`、`runBelongsToIssue` + `POST /api/issues/{id}/abandon\|reopen`；**锚点判据只有一处**：`apps/web/src/lib/pipeline.ts` 的 `stageOf`（`finished ?? humanOnExecute`，以及 `abandoned` 那层覆盖）；界面在 `apps/web/src/views/Tasks.svelte`（`passGate` / `canDecide` / `feedbackReady` / `canAbandon` + `passTask` / `feedback` / `setAbandoned`）；词条在 `packages/i18n/src/web/tasks.ts` 的 `decide*` 那组 |
| 动作执行 / 脚本进程 | `apps/daemon/src/actions.ts` / `script-executor.ts` |
| 工作目录分配 / 文件读取 | `apps/daemon/src/workdir.ts` / `workdir-files.ts` |
| 重启对账 | `apps/daemon/src/reconcile.ts` |
| 装 skill / 装工具包 | `packages/skill-source/src/skill-source.ts`（daemon 与 remote **共用**）/ `apps/daemon/src/tool-source.ts`；「从本地安装」扫别的 AI 工具的技能目录：`apps/daemon/src/local-skill-dirs.ts`（只读扫描，无对账）；**本地安装清单**（一份仓库自带的 JSON，列出可点的安装方法）：`apps/daemon/src/skill-list.ts`（自带清单 `apps/daemon/catalog/skills.json`，`--skills-catalog` 可换） |
| 第一句话的组装与模版 | `packages/agent-core/src/first-sentence.ts` |
| runtime 描述表（加 runtime） | `packages/agent-core/src/runtime-table.ts` + `apps/daemon/src/runtime-registry.ts` |
| 技能 / 工具注入与清理 | `packages/agent-core/src/skill-injection.ts` |
| **任务隔离（引导 + 拦截，D76）** | 引导：`packages/agent-core/src/first-sentence.ts` 的 ③ 任务块无条件追加「任务边界」；拦截：`apps/daemon/src/run-hooks/inject.ts`（注入 / 清理 `.claude/settings.json` + `.agentdeck/hooks/pre-tool-use.py`，只在 `runtime.descriptor.key === 'claude'` 时）——hook 脚本 `apps/daemon/src/run-hooks/pre-tool-use.py`（PreToolUse：结构化路径全拦、Bash 只拦明显越界） |
| **技能内容落盘 / 回读 / 迁移** | `packages/store-file/src/skill-files.ts`（`<skillsRoot>/<slug>/`）+ `file-store.ts` 的 `insertSkill` / `#hydrate` / `#migrateSkillsToDisk`；路径兜底 `apps/daemon/src/workdir.ts`（`defaultSkillsRoot` / `fallbackSkillsRoot`），CLI `--skills-root` 在 `apps/daemon/src/cli.ts` |
| 沙箱 | `packages/agent-core/src/sandbox.ts` |
| **一个进程怎么起**（探测到什么 / 该 exec 什么 / 起不来怎么解释） | `packages/agent-core/src/spawn-target.ts`（`.cmd` 垫片解开、`.ps1` 拒绝、`cmd.exe` 兜底、`describeSpawnError`）——**唯一一处**平台差异判断，接在 `process-tree.ts` 与 `apps/daemon/src/script-executor.ts` 上 |
| CLI 入口的 Node 版本守卫 | `scripts/node-entry.mjs`（**所有** `pnpm run` 命令都过它，含 `test`；`.mjs` 是必须的，写在 `.ts` 里跑不到）。裸 Node ≥ 22.6 且默认没开类型擦除时自动补 `--experimental-strip-types` 重跑 |
| 预检：CLI 状态目录能不能写 | `apps/daemon/src/environment.ts`（Windows 上**真写一次**，不信 `access(W_OK)`） |
| 原子写 / 追加句柄 | `packages/store-file/src/fs-utils.ts`（`renameWithRetry` 只在 win32 上重试） |
| **Windows 上到底能不能跑**（平台差异清单与真机验收） | `docs/reference/windows-compat.md` |
| CLI 适配器 | `packages/agent-claude/` / `packages/agent-generic/` / `packages/agent-codex/` |
| **智能体组**（谁审谁 / 行动权限 / 返工次数） | 形状与判据：`packages/domain/src/groups/shape.ts`（"恰好 1 执行 + 1 审核"，多执行者 / 多审核者会明确报"还没有实现"）；实体：`packages/protocol/src/entities.ts` 的 `AgentGroup`；接口：`apps/daemon/src/server.ts` 的 `/api/agent-groups` 那 5 条；**摊平点**：`POST /api/runs` 的组展开（`server.ts:4990` 一带）；界面：`apps/web/src/views/Groups.svelte` + `components/MemberSlotForm.svelte` + `lib/newtask-chain.ts`。设计缘由见 `docs/design/agent-groups.md` |
| 界面视图 / 组件 | `apps/web/src/views/` / `components/` |
| 界面文案（中/英） | `packages/i18n/src/web/` |
| 远端接口 / 插件 | `apps/remote/src/server.ts` / `plugins.ts` |
| 命令行 / MCP 工具集 | `apps/cli/src/commands.ts` / `apps/mcp/src/server.ts` |

### 13.1 谁钉住了什么（改之前先跑这些）

| 改动范围 | 会被这些测试挡住 |
|---|---|
| 本地接口 / 端到端链路 | `apps/daemon/src/e2e.test.ts`、`s1-e2e.test.ts`、`m4-routes.test.ts` |
| 审核与判决 | `review-e2e.test.ts`、`reviewer-override.test.ts`、`review-standard.test.ts`、`loop-closure.test.ts` |
| **智能体组**（谁审谁 / 行动权限 / 返工次数） | `groups-e2e.test.ts`（组 CRUD + 摊平进 run + 私有成员级联删）、`packages/domain/src/groups/shape.test.ts`（"恰好 1 执行 + 1 审核"的判据与两种"还没有实现"的拒绝）、`agents-create.test.ts` / `agents-delete.test.ts`（`ownerGroupId` 与级联）、`task-action-whitelist.test.ts` / `task-action-params.test.ts`（组给的白名单与固定参数真的管住了动作）、`apps/web/src/lib/newtask-chain.test.ts` + `agent-actions.test.ts`（新建任务三步链的组装与校验）、`agent-legacy-cleanup.test.ts`（已撤字段真的从磁盘上删掉） |
| 返工回路（D45） | `rework-e2e.test.ts` |
| **人的三个出路**（D46 / D47） | `human-verdict.test.ts`（裁决接口与落库 + 放弃/恢复 + **放弃时取消正在跑的 run**，用一个不自己结束的假后端造出 `running`）、`apps/web/src/lib/pipeline.test.ts`（两种载体的阶段推导、`abandoned` 覆盖每一档、六列覆盖率） |
| 动作与工具包 | `tool-action-e2e.test.ts`、`task-action-params.test.ts`、`task-action-whitelist.test.ts`、`tools-api.test.ts`、`no-builtin-actions.test.ts`、`script-executor.test.ts` |
| 安装（skill / 工具） | `skills-install.test.ts`、`skill-source.test.ts`、`tool-source.test.ts`、`remote-tool-install.test.ts`、`skills-local-dirs-api.test.ts`（从本地安装：扫描 → 装 → 落盘 → 挂给智能体）、`local-skill-dirs.test.ts`（扫描） |
| 换一个 runtime | `runtime-agnostic.test.ts`、`runtime-registry.test.ts` |
| 第一句话模版 | `template-e2e.test.ts`、`packages/agent-core/src/first-sentence.test.ts` |
| 工作目录与文件服务 | `workdir.test.ts`、`workdir-files.test.ts` |
| 重启 / 关闭 / 空闲 | `reconcile.test.ts`、`shutdown.test.ts`、`idle-watchdog.test.ts` |
| Host 校验等安全项 | `daemon.test.ts` |
| 存储端口的两套实现 | `packages/store-sqlite/src/port-thinness.test.ts`（差分契约）、`file-store.test.ts`、`sqlite-store.test.ts` |
| 快照与审计导出 | `apps/daemon/src/snapshot.test.ts`、`reporting.test.ts` |
| 界面 | `apps/web/src/lib/*.test.ts` + `svelte-check`。⚠️ **`pnpm run probe:layout` 现在不能当判据用**：探针整体落后于界面（542 条里 74 红、105 没量到，其中「新建任务的三步链 28 / 审核标准 13 / 智能体 8」正是被这几轮改掉的形状）。哪几段过期、为什么过期、怎么复现那份判据，见 `tools/layout-probe/README.md` 的「⚠️ 现状：有 7 段已经过期」一节——**重对齐是单独一轮的活** |
| **进程怎么起 / 平台差异**（Windows 的 `.cmd` 垫片、`PATHEXT`、假 CLI 包装、入口版本守卫、可写预检、`rename` 重试） | `packages/agent-core/src/spawn-target.test.ts`、`probe.test.ts`、`scripts/node-entry.test.mjs`、`apps/daemon/src/environment.test.ts`、`packages/store-file/src/fs-utils.test.ts`。⚠️ 这几条**平台是注入的**（`platform: 'win32'`），所以在 macOS 上就是真判据；「真 Windows 上 exec 得起来吗」那条不在测试里，见 `docs/reference/windows-compat.md` 的「没量到的」 |
| 仓库级规矩 | `tests/test-safety.test.ts`（不许 `tmpdir()`、不许对危险目录递归删除） |

---

## 14. 已知的边界与开口

**如实列出**——这些不是待办清单，是当前代码的真实形状：

| 项 | 现状 | 影响 |
|---|---|---|
| **不做沙箱隔离**（NG7） | 默认 run 以启动 daemon 的 OS 用户完整权限执行 | 明确的范围决定，**不是待办**。`--sandbox workdir-write` 是可选缓解，**不是安全边界** |
| **脚本动作执行器不做沙箱** | 工具包脚本继承 daemon 的权限 | 它的边界是"参数有界、环境干净、超时有界、入口不经 shell"，**不是**"改不了你的文件" |
| INV-14 / 15 / 16（回路边界） | ⚠️ **三条强度不同，别当成一档**：INV-14（深度）**有一条**生产路径（`autoChainReview`，形态是"发通知 + 停止派生"）；INV-15（环检测）**零生产调用点**；INV-16（`derivedFrom`）**没有生产者**（D41 删了唯一能派生 run 的动作，重试/返工靠 `subject` + `resumeFromRunId` 关联）。逐条见 §4.3 | 将来加回"能派生 run 的动作"时边界已经在那儿。**但两份 README 原先把它说成"在写库之前强制校验"，已按实情改过** |
| `TERMINAL_RUN_STATUSES` 有 4 份定义（INV-18 的漂移） | `packages/protocol/src/enums.ts` 那份是官方来源，但**配套的 `isTerminalRunStatus()` 零引用**；另外三份分别在 `apps/daemon/src/server.ts`、`apps/web/src/lib/pipeline.ts`、`apps/web/src/lib/chat.ts`（外加 `reconcile.ts` 一份语义不同的 `NON_TERMINAL_RUN_STATUSES`）。`enums.ts` 开头写着"枚举只在这里定义" | 值目前一致（`chat.test.ts` 钉住了其中一份），所以**不会立刻出错**；但改协议时没有任何机制会让这四处跟着动。**这是 INV-18 目前唯一被破的地方** |
| `POST /api/agents/{id}/review-standard/adopt-from-skills` 界面无入口 | 接口活着、测试覆盖着，但界面上**那个按钮在 2026-10 的改版里被删了**（"没有预览页了，选中即编辑"）；它唯一的客户端函数 `stores.ts` 的 `adoptReviewStandard()` **零调用**，`AgentDetail.svelte` 里只剩一个提示段落 | 带内联老标准的审核者现在**看得见但搬不动**——正是这次改造想消掉的那个状态，又回来了。要恢复只需给那个提示段落接一个按钮（接口不用动） |
| `pnpm run probe:layout` 落后于界面 | 542 条里 **74 红 / 105 没量到**，红集中在前面几轮改掉的形状（新建任务的三步链 28 / 审核标准 13 / 智能体 8）。⚠️ 它**跑不起来还有第二层原因**：探针要真无头 Chrome，而 Chrome 在受限环境里可能连 Crashpad 目录都写不了（`exit 133`） | **界面目前没有可信的自动回归网**：`apps/web/src/lib/*.test.ts` + `svelte-check` 还在，但它们不量布局与真实交互。重对齐是单独一轮的活，见 `tools/layout-probe/README.md` |
| NFR-T-01「测试绝不调用真实 CLI」只有约定，没有机器守卫 | `DaemonOptions.backend` 就是为它存在的（字段文档里明写），全仓 42 处 `startDaemon` 都注入了假后端——**但 `apps/daemon/src/remote-tool-install.test.ts` 漏了**，于是 `server.ts` 的 `backend.probe()` 会真的 spawn 使用者的 `claude --version`（探测失败还会 fork 登录 shell 去加载 rc） | 影响有限（`--version` 不烧额度），但"这句话绝不会发生"在这条用例上不成立。对比：`tmpdir()` 有 `tests/test-safety.test.ts` 守着，这条规则**什么守卫都没有** |
| INV-6（显式声明才等批准） | `requiresApproval` 无消费方；`awaiting_approval` 无生产调用点 | 当前默认路径恒为 `auto_approved`。**与 D46 的人工裁决不是一回事**：那个不是"判决的前置审批"，而是**另出一条判决**（模型已出过结论之后追加），两者刻意不合并 |
| 人工裁决的锚点校验 | daemon 侧只判"这条审核审的执行是不是最新的一次执行"（`canHostHumanVerdict`），**不重算整个 `stageOf`** | 直接调接口时，若传一条**已失效但仍能通过那一条检查**的审核 run（例如同一执行上多条审核 run），判决会落在一个阶段推导不看的地方。界面走不到那条路（它从 `stageOf` 取锚点）；**完整规则只有 `pipeline.ts` 一处实现**，这是刻意的不重复 |
| `store-sqlite` | 已实现、行为契约与 `store-file` 一致，但 **daemon 未接线**（无 driver 开关）。⚠️ 比"没接线"更硬一层：`apps/daemon/package.json` 里**根本没有这个依赖**，所以 daemon 现在连 import 都解析不到；`cli.ts` 里也没有任何 store 相关参数 | 切换要改 `startDaemon` 的装配点，**并且要先把它加进 daemon 的依赖**。另注：`packages/store-file` 与 `packages/store-sqlite` 各自导出的 `openFileStore` / `openSqliteStore` **都是死函数**（daemon 走的是静态方法 `FileStore.open`） |
| `statusAfterDispatch()` | 域函数只在测试里被调用（daemon 直接写 `transitionRun`） | 同目录串行化的判据没有走这个域函数 |
| `invalidAttempts` 计数器 | **只在内存**（`executor.ts` 按 subject 键） | daemon 重启后"判决不合规"的重试预算被重置；`reconcile.ts` 不碰它 |
| `Run.attempt` / `maxAttempts` | 落了库，但**没有消费方** | 重试是**新建 run**，不是 attempt+1；这两个字段目前是纯记录 |
| `ManagedPaths.files` | 恒为空数组（只有 `dirs` 有生产者） | runtime 描述表要声明"平台注入的单个文件"时这条路径还没接通 |
| 远端 `/api/records` | **只存内存**（裁剪到 5000 条） | 重启即丢，`/api/stats` 是进程内统计。刻意的：它只是统计 |
| 远端若干端点 | `/api/third-party/query`、`/api/stats`、`/api/plugins/{name}/secrets` 无 Web 消费者 | 预留的接口面 |
| `ref/` 参考材料 | 对上游（Multica，自定义许可）行为的描述 | 本项目 **clean-room**，**不得复制其源码** |

---

## 附：术语速查

| 词 | 含义 |
|---|---|
| **run** | 一次执行或一次审核（`kind` 是 `execute` 或 `review`）。终态没有出边——重试是新建一条 |
| **verdict** | 判决。闭合结构：结论 / 理由码 / 置信度 / 发现 / 动作 / 升级原因 |
| **action** | 判决通过后要做的有界操作。名字形如 `<包 slug>.<动作名>`，只能来自已安装的工具包 |
| **工具包（tool）** | 一组动作：一个目录 + `tool.json` + 入口脚本。平台**不内置**任何动作 |
| **skill** | 可安装、带版本与来源、可带支持文件的**资料/方法包**（执行者干活时参考什么）。审核标准与行动权限**都不在** skill 里 |
| **审核标准** | 2026-09 起它**并入「指令」**（② 身份）——界面上没有单独的「审核标准」了。老数据仍可能有 `Agent.reviewStandard`（一段正文），投递时与「指令」合成 ②；没写「指令」的审核者拿不到审核任务 |
| **智能体组** | 2026-10 起「谁审谁」与「判完允许动什么」的**唯一权威**：一个组 = 恰好 1 执行者 + 1 审核者 + 行动权限 + 返工次数（`AgentGroup`，`packages/protocol/src/entities.ts`）。**没有组就没有审核者**，产出也就没人审。提交 run 时**摊平**进 `Run.*` 字段，所以改组不影响已经派出去的活（见 `./agent-groups.md`） |
| **行动权限** | 写在**智能体组**上（`AgentGroup.allowedActions`）：判完之后**允许触发哪些动作**。⚠️ 它曾经落在 skill 上、后来又落在审核者 agent 上（`Agent.allowedActions`）——两次都撤了（D40 / 2026-10），现在 agent 上传这些字段是**不认识的字段 400** |
| **第一句话** | 交给 CLI 的三块（① 框架 / ② 身份 / ③ 任务，`first-sentence.ts`），两块合起来进 run 日志；投递档记在 `Run.deliveryMode` 上 |
| **工作目录** | `~/agentdeck-workspace/<类型>-<id>/`，agent 的真实产出所在。刻意放在家目录下、不隐藏 |
| **数据目录** | `~/.agentdeck/data`，程序内部状态（SQLite/JSONL、锁、blob 日志）。刻意隐藏 |
| **invalid** | 判决**没按格式输出**（≠ 执行失败）。有独立的三条出口：retry / 降级 / 升级 |
| **rework** | 判决说"这活不行"（`fail`）⇒ 交回**执行者**重做。与 `retry`（重做**审核者**）方向相反 |

### 4.3.1 分批第 40 批：「哪些是平台注入的」要认得 `default`

使用者报的故障（真机）：

> 「当我给智能体选择 CLI 是 Default 的时候，不能预览工作目录，提示『取不到工作目录的文件
> Error: 未知的 runtime：default。当前支持：claude, generic, codex』」

#### 根因

工作目录那两条只读路由（`GET /api/conversations/:id/files`、`GET /api/runs/:id/files`）
各自写了一句：

```ts
const managed = managedPathsFor(getRuntimeDescriptor(agent?.runtimeKey ?? 'claude'))
```

它要回答的本来只是「哪些目录是平台注入的，列目录时要把它们标出来」，但这一句一次犯了四个错：

| # | 错 | 后果 |
| --- | --- | --- |
| ① | 不认识 `'default'` | 那是**合法值**（协议：agent 写 `'default'` 时用全局默认），而**新建的 agent 记的就是它** ⇒ 最常见的那一档直接抛 |
| ② | 忽略 `Workspace.defaultRuntimeKey` | 三级解析的第二级没走 ⇒ 标错的注入物（写死 claude 时把 `.claude` 当注入、把 `.codex` 当产出） |
| ③ | agent 取不到时**写死 `'claude'`** | 没有 claude 的机器上必抛 |
| ④ | 抛出去 = 500 | 一个纯元数据（"标哪些是注入物"）的失败，把整栏**文件预览**打死 |

执行器 `executor.ts` 里早就做对了同一件事（三级解析 + try/catch 降级 + `onWarn`）。
两份实现迟早分叉，而分叉的表现就是这次这个形状：**run 跑得起来，界面上却看不到它干了什么**。

#### 修法（一处实现，两处调用）

daemon 主体里新增两个函数，与执行器同口径：

- `effectiveRuntimeKeyOf(agent)`：`agent.runtimeKey` ⇒（为 `'default'` 时）`Workspace.defaultRuntimeKey`
  ⇒（空）本机侦测到的 `runtimeKey`。workspace 那层**现读不缓存**（它随时能改，缓存住的表现是
  "改了不生效、重启才生效"）。
- `managedPathsOf(agent)`：拿它调 `managedPathsFor`；**解析不出来就降级到本机侦测到的那个**并
  `warn` 一句——这一栏的用途是"分清哪些是 agent 的产出"，标错一格远好过什么都看不到。

#### 验证

| 用例 | 断言什么 | 红检 |
| --- | --- | --- |
| ★★★「agent 的 CLI = Default ⇒ 列目录照样 200」 | 200；`.claude` 仍标成注入；`产出.md` 不是 | 换回旧写法 ⇒ 红，错误消息与使用者报的**逐字相同**：`{"error":"Error: 未知的 runtime：default。当前支持：claude, generic, codex"}` |
| ★★「agent = default 且工作区默认设成 codex」 | `.codex` 标注入、`.claude` **不**标（写死 claude 的版本刚好反过来） | 同上 ⇒ 红 |

全量 `pnpm run check` 2127 全绿（2125 + 2）。

### 4.3.3 分批第 42 批：`--doctor codex`（"这台机器上 codex 到底通不通"）

使用者（Windows 上报 codex 执行失败 + 输出乱码之后）：

> 「有没有什么 test case 来测试 codex 是否通的，我在 windows 跑跑看」

#### 为什么必须是"命令"而不是"测试"

两件事在我这台 macOS 上都复现不了；而本仓库的自动化测试**禁止调用真实 CLI**
（NFR-T-01：会花使用者的额度、还可能让 agent 改文件）。两条约束叠起来只有一个结论：
这件事需要一个**人工入口**——只读、免费、能整段复制粘贴回来。

#### 六段检查（全部不跑 turn）

| 段 | 量什么 | 不通过说明什么 |
| --- | --- | --- |
| 环境 | 平台 / 架构 / Node / **`chcp` 代码页** | 不是 65001 ⇒ 那个窗口里中文本来就显示不对 |
| 可执行文件 | **生产同一条**探测路径找到 codex + `resolveSpawnTarget` 的起法 | `cmd` ⇒ 参数可能被代码页吃掉 |
| **原始字节** | `codex --version` 的 hex + UTF-8 + GBK 三种读法 | `UTF-8 有 �` 且 `GBK 能解出中文` ⇒ 乱码来源确认 |
| 配置 | `auth.json` / `config.toml` 存在性 + BOM / UTF-16 判定 | UTF-16 ⇒ PowerShell `>` 写的，codex 读不了 |
| 复制演练 | 真跑 `syncCodexConfigDir` 到临时目录 + **逐字节比对** | 失败 ⇒ 受管目录里没有 auth ⇒ codex 认证不了 |
| 握手 | 真起 `codex app-server` 做 `initialize` | 失败 ⇒ 故障在起进程/协议层，与配置内容无关 |

#### 两个当场踩到的坑（都写进注释了）

1. **握手不能用 `~/.codex`**：codex 要在 `CODEX_HOME` 下建 sqlite 状态库；本机第一版就是这么跑的，
   于是量到 `failed to initialize sqlite state runtime under ~/.codex`——那是**权限**，不是 codex 本身。
   生产从来不是这么跑的（受管目录可写），所以握手改用**复制演练那个目录**当 `CODEX_HOME`。
2. **起进程必须用解析后的绝对路径**：适配器的 `probe()` 返回的是描述表里的**命令名**（`codex`），
   第一版拿它去 spawn，`--version` 量到的是 PATH 上那个**真实** codex —— 既有损测试意义，
   也等于在测试里调了真实 CLI（NFR-T-01）。改成 `--executable 优先，否则 probeCommand 解析`。

#### 验证

`apps/daemon/src/codex-doctor.test.ts`（7 条，全部用**假 codex**：一个 `executableWrapper` 包出来的
脚本，对 `--version` 吐我们指定的字节、对 `app-server` 回一个 `initialize`）：

- 正常一台机器：五项全过；
- **GBK 字节** ⇒ 判成"不是合法 UTF-8"，并给出 GBK 读法与原意的对照 + `chcp 65001` 的下一步；
- **UTF-16 配置**（PS 5.1 的 `>` 产物）⇒ 判成 `utf16le`，并给出转换写法；
- **缺 auth.json** ⇒ 判失败，并给"把设置里那个勾取消"这条临时路；
- **握手用演练目录当 `CODEX_HOME`**（假 codex 把看到的 `CODEX_HOME` 落盘，测试逐字比对）；
- **不回 `initialize`** ⇒ 判失败，并指到"起进程/协议"这一层；
- `digestBytes` 的四种 BOM 与"非法 UTF-8"各判对。

**红检**：把"字节是否合法"与"注入 `CODEX_HOME`"两处短路 ⇒ 对应两条用例变红。

本机真跑（macOS + codex 0.157.1）：五项全过，握手 **206ms**，响应里 `codexHome` 正是演练目录。

### 4.3.4 分批第 43 批：`.cmd`/`.bat` 起不来 —— `windowsVerbatimArguments` 与"一个出口"

使用者（真 Windows 机器上量到的，附了修法）：

> 「我在 windows 查到了问题，问题是 .cmd/.bat 启动失败的问题，包括 spawn-target 中文件路径需要加引号，
> 另外在 process-tree 中，调用 cmd /d /s /c 时，需要设置 VerbatimArguments: true，避免转义」

这是 A1 的**未修完那半截**。A1 保证 `.cmd` **能**被起（解开 npm 垫片，或走 `cmd.exe /d /s /c`），
但**选项这一层**漏了一格：

| 缺口 | 后果 |
| --- | --- |
| 没有 `windowsVerbatimArguments: true` | `via: 'cmd'` 时 `args` 最后一项是**我们拼好的整条命令行**；Node 默认会再替每个参数加一遍引号/转义 ⇒ cmd 收到引号错位的字符串 ⇒ **起不来** |
| 命令路径只在含空格时加引号 | `C:\Users\张三\…`（中文用户名）、`C:\work\a&b\…` 这类**不含空格却会被 cmd 拆开/改写**的路径中招 |

#### 为什么之前的测试全绿也没发现

`buildCmdLine` 是纯函数，过去的判据是"拼出来的**字符串**对不对"——全绿。
而"这个字符串会不会被 Node **再转义一遍**"发生在 `spawn` 里面，纯函数看不见；
再加上 macOS 没有 `cmd.exe`，这一格只能靠真机（这一次就是使用者量到的）。

#### 修法：不是各补一行，而是让旗标只有一个出口

1. `SpawnTarget` 增 `verbatimArguments: boolean`：
   - `via: 'cmd'` ⇒ `true`（我们拼的，别再动它）；
   - `direct` / `shim` ⇒ **必须** `false`（argv 是真参数，`C:\Program Files\nodejs\node.exe`
     这种路径全靠 Node 加引号；全开会把它拆成两个参数）。
2. `buildCmdLine`：命令路径**永远**加引号。`cmd /d /s /c` 的 `/s` 会剥掉最外层那一对（整条再包一层），
   内层这对正好落在命令上——所以"永远加"是安全的，而"只在含空格时加"是碰运气。
3. 新增 `spawnPlanFor(target)`：**"决定起什么"与"怎么起"之间只有一条通道**。
   此前 `process-tree` 与 `script-executor` **各拼一份** spawn 选项，两份都漏了这个旗标；
   `codex-doctor` 的 `runCapture` 现在也走它。

#### 验证（三层，最后一层是仓库级守卫）

| 判据 | 在哪 |
| --- | --- |
| 三档 `verbatimArguments` 的取值 | `spawn-target.test.ts` |
| 命令路径永远加引号；判据改成"按 `/s` 剥完比 **cmd 实际收到什么**" | 同上（比"逐字比字符串"更接近真相） |
| `spawnPlanFor` 的映射 + `args` 是拷贝 | 同上 |
| **选项真的进了 `spawn`**（注入假 `spawn` + 注入 `via: 'cmd'` 目标）；`direct` 时**不能**开 | `process-tree.test.ts` |
| **仓库级**：凡生产代码调 `resolveSpawnTarget(` 的文件必须用 `spawnPlanFor(` | `tests/test-safety.test.ts` |

**红检**：把 `script-executor` 退回"自己拼选项（不带 plan）" ⇒ 仓库级守卫与 `direct` 那条用例立刻变红。

> 教训（可复用）：一个"漏了只在某个平台上才炸"的选项，不要指望每个调用点自己记住——
> 把它塞进一个**唯一的出口**（`spawnPlanFor`），再加一条 grep 级守卫，比在文档里写三遍都有效。

### 4.3.5 分批第 44 批：service 形状的 runtime 要把"发了什么"报进日志

使用者（看运行日志时发现）：

> 「我在日志中有看到『命令行：/opt/homebrew/bin/codex app-server --stdio』，后面应该有发给它的命令，没有打印出来」

#### 为什么 claude 有、codex 没有

| runtime 形状 | 第一句话去哪 | 日志里能看到什么 |
| --- | --- | --- |
| **cli**（claude / generic） | 拼进 argv（`claude -p "<第一句话>"`） | 「命令行：…」那一行**顺带**把内容也显示了 |
| **service**（codex） | 走 stdin 的 JSON-RPC 帧（`initialize` / `thread/start` / `turn/start`） | 「命令行」只有启动参数 `app-server --stdio`，**内容一个字节都看不见** |

这不是"少看一行"：排查 codex 起不来时，看不到帧就分不清**没发出去 / 发出去形状不对 / 服务端拒了哪一个**，只能猜。

#### 落法（两条路里选了第二条）

| 方案 | 代价 |
| --- | --- |
| ① 把 `turn/start` 的 input 原文**再打印一遍** | 同一段可能几十 KB 的第一句话在日志里出现两次，"哪一份是真的"变成新的误解源 |
| ② **逐字比对**（采用）：帧里真的发出去的 `sentText` 与日志里记下的第一句话比 | 一致 ⇒ 一行话钉住；**不一致才打全文**（那才是需要全文的异常现场） |

落地：

1. `ExecOptions.onRpcFrame?: (note: RpcDeliveryNote) => void`（`agent-core`）——
   `{direction:'out'|'in', method, headline, sentText?}`。
2. `codex-backend` 用一个 `rpc()` helper 包住每一次请求：出站报方法名与关键字段
   （`cwd` / `model` / `approvalPolicy` / `input` 项数），入站报**成功或失败 + 耗时**
   （失败带 JSON-RPC `code`）；`turn/start` 额外把 `input[0].text` 作为 `sentText` 交出。
   ⚠️ 帧层（`JsonRpcTransport`）**不动**：它只管帧的编解码，业务摘要属于后端。
3. `executor` 把摘要写成 note；对 `sentText` 调 `verifySentText(delivery.user, sent)`
   （`apps/daemon/src/rpc-log.ts`）：
   - 一致 ⇒ `✓ 发给 CLI 的内容 = 上面「第一句话」的 user 部分（逐字相同，N 字符）`
   - 不一致 ⇒ 指出第几个字符起不同，**并打出线上那一份的全文**

#### 验证

| 判据 | 在哪 |
| --- | --- |
| 比对函数：一致不打全文 / 不一致打**线上**那份并指出位置 / 前缀相同的情况 / 空串 | `apps/daemon/src/rpc-log.test.ts` |
| 后端真的报帧：`initialize` 在最前、`thread/start`、`turn/start` 都在，`sentText` **只有一条且原样** | `packages/agent-codex/src/codex-backend.test.ts` |
| 服务端拒绝时入站摘要带 `code`（分得清"没回"与"回了错"） | 同上（用假 server 的 `resume-missing` 剧本） |
| **执行器真把摘要写进了 run 日志**（假后端报帧 → 读 `/api/runs/:id/messages` 能看到） | `apps/daemon/src/rpc-log.test.ts` |

**红检**：把 executor 里那段 `onRpcFrame` 接线注释掉 ⇒ 最后一条立刻红
（报的正是"日志里要有出站帧摘要"，与使用者原话同义）。

### 4.3.6 分批第 45 批：原文要**打出来**，不能只给"逐字相同"这一行结论

分批第 44 批把 service 形状的帧摘要补进日志后，使用者当场回了一句：

> 「我在命令行后，我还是没有看到第一个命令到底是什么给到 codex 的」

44 那一批给的是：

```
→ turn/start（…，input 1 项 / 5497 字符，…）
✓ 发给 CLI 的内容 = 上面「第一句话」的 user 部分（逐字相同，5497 字符）
```

**结论行是给"校对"用的，而他要的是内容本身**。而且这条不对称很刺眼：claude 那条路上
内容就明明白白在 `命令行：` 里，凭什么 codex 的使用者要去上面翻三块模版拼一遍？

所以 45 这一批改成「正文 + 结论」两件都给：

```
===== 发给 CLI 的原文（turn/start，5497 字符）=====

<整段原文>

✓ 发给 CLI 的内容 = 上面「第一句话」的 user 部分（逐字相同，5497 字符）
```

- **正文总是打**（不截断）。代价是同一段在日志里出现两次（三块模版 + 这里）；
  权衡后仍然选"看得见"——44 批担心的"哪一份是真的"由紧跟的那行逐字比对回答，
  而"内容根本看不见"没有任何替代品。
- 不一致时结论行改成「以**上面那份原文**为准（那才是它真收到的）」，并指出第几个字符起不同；
  `verifySentText` 不再负责"决定要不要打正文"（正文已经总是打了），只负责**给结论**。
- 只有 service 形状会走到这里（`sentText` 只由 codex 后端给）⇒ **claude / generic 的日志一个字都没变**。

#### 验证

`apps/daemon/src/rpc-log.test.ts` 那条 e2e 现在两条一起钉：

```ts
assert.match(text, /===== 发给 CLI 的原文（turn\/start，/u, '原文要带标题打出来')
assert.match(text, /把 a\.txt 读完/u, '★ 送出去的**那一段正文**要真的在日志里')
```

**红检**：把 executor 里打正文那一段注释掉 ⇒ 立刻红（报的正是"原文要带标题打出来"）。

### 4.3.7 分批第 46 批：正文要在**发送点**从字节里抠出来（真实性）

使用者（看过 45 批的日志之后）：

> 「还是需要把给 CLI 的内容打印出来，尽量在发送的位置直接打，保证真实性」

45 批那一版是在 `rpc('turn/start', …)` **返回之后**拿 `opts.prompt` 报的——内容是
"**我们打算发的那份**"，不是"字节里实际写着的那份"。两者一般情况下相同，
但"一般情况下相同"恰恰是日志最不该依赖的东西：这条日志存在的意义，
就是要证明 **它收到的 == 日志里写的**。

#### 落法

写 stdin 的那一处（`codex-backend` 给 `JsonRpcTransport` 的 write 回调）改成三步：

```ts
(frame) => {
  const line = `${JSON.stringify(frame)}\n`   // ① 序列化出**要写的那一行**
  handle?.writeStdin(line)                     // ② 真写进去
  reportSentTurnInput(frame, line, opts)       // ③ 再从**这一行**里抠出 input[0].text 上报
}
```

`reportSentTurnInput` 的三条纪律（都写进注释了）：

| 纪律 | 为什么 |
| --- | --- |
| 解析的是 **`line`**（写出去的那一行），不是 `frame` 对象 | 后者只证明"想发什么" |
| 只说 `turn/start`，且**恰好 1 段** `input[].text` | 多段时不拼起来——拼起来就是我们在**造**一份没被发出去的内容 |
| 抠不出来就**不说**（只报"input 有 N 段"） | 宁可少一行，也不写一句没有字节支撑的话 |

日志里因此变成（顺序也回到真实时序：先写字节、再有正文、最后才是响应）：

```
→ turn/start（…，input 1 项 / 5497 字符，…）
↓ 已写入 codex stdin：整帧 5872 字节，其中 input[0].text 共 5497 字符（下面这段是**从写出去的那一行里抠出来的**）
===== 已写入 CLI stdin 的原文（turn/start，5497 字符）=====

<全文>

← turn/start 成功（8ms）
✓ 发给 CLI 的内容 = 上面「第一句话」的 user 部分（逐字相同，5497 字符）
```

#### 验证

`packages/agent-codex/src/codex-backend.test.ts` 新增两条断言：标题必须写明「已写入 codex stdin」
且带**整帧字节数**（`Buffer.byteLength`）——这两个词正是"从字节里抠"的直接证据。

**红检**：把发送点退回"用 `opts.prompt` 报"（= 45 批的写法）⇒ 立刻红，
报的是「标题要说明它是从写出去的那一行里取的」。

### 4.3.8 分批第 47 批：抽出「通用工作守则」（A + B 都做）

使用者（看过起草者的三块之后）：

> 「我看起草者这3部分的信息，发现有很多原则放在了框架和任务中。但我想尽量往身份去放，让它尽量和执行者通用」

他在两个选项里选的是「**A、B 都做**」：

- **A**：守则作为**一份代码常量**，内置 agent（起草者 / 审核者）的 ② 身份共用它；
- **B**：守则作为**工作区设定**（`Workspace.defaultAgentConduct`），新建智能体时**预填**进它的指令。

#### 搬家表（搬什么、不搬什么）

| 内容 | 原位置 | 新位置 | 为什么 |
| --- | --- | --- | --- |
| 只做被要求的事、不要扩大范围 | ① 框架「护栏」 | ② 守则 | 与岗位无关，三种 agent 都成立 |
| 完成后给报告（做了什么/结论/不确定） | ① 框架「护栏」 | ② 守则 | 同上 |
| 依据必须来自素材，不知道就不写 | ② 岗位纪律第 2 条 | ② 守则 | 同上（最该普适的一条） |
| 引用命令/参数/路径时回原文取 | ③ 任务书里的一句 | ② 守则 | 换一件活也成立 |
| 产出落到文件里，不只贴在回复里 | ② 岗位纪律第 5 条 | ② 守则 | 同上 |
| **写作规范正文（1731 字）** | ③ | **③ 不动** | 只对起草有用；进身份=破坏"通用"，且每轮白带 1.7k |
| `## When to Use` / `## Procedure` 硬结构 | ② 岗位纪律第 3 条 | **③ 任务书**（写作规范里已有；缺了入库硬拒） | 它是**验收判据**，不是工作纪律 |
| 6000 字符上限、`skill/SKILL.md`、`agent/instructions.md`、REFUSED 约定、返工三条 | ③ | **③ 不动** | 含数字/路径/只对某条流程成立 ⇒ 任务契约 |

判据一句话：**换一件活还成立 ⇒ 守则；只对这件活成立 ⇒ 任务书。**

#### 三处实现

1. `apps/daemon/src/agent-conduct.ts`（新）：`GENERAL_WORK_CONDUCT`（4 条、141 字符）+ `withConduct()`（"一句话岗位 + 守则"的**唯一**拼装处）+ `CONDUCT_MAX_CHARS`。
2. 内置身份重写：起草者 `419` 字符（= 岗位 + 守则 + 起草者专属 3 条）、审核者 `1207` 字符（= 岗位 + 守则 + 判据五项）。**被替换的旧默认逐字冻结**成 `DRAFTER_INSTRUCTIONS_V2` / `SKILL_REVIEWER_INSTRUCTIONS_V4` 并进历史表——不加的话老工作区永远升不上来（这一族踩过三次）。
3. 工作区设定 `defaultAgentConduct`（缺省 = 平台守则）+ `PUT /api/workspace/agent-conduct`（允许空串 = 不预填，超 `CONDUCT_MAX_CHARS` 400）。三条语义边界写进注释：**预填 = 文本拷贝**（改设置不回头改已存在的 agent）、**非空不覆盖**（请求里给了指令就用他的）、**内置 agent 不读这个设定**（否则"存着 === 已知历史"的升级判据永远不成立）。

界面：设置抽屉新增「默认工作守则」一段（textarea + 保存 + 重新载入，存完重拉 identity）；新建智能体表单的指令框**初值**就是它（否则使用者看到空框、保存后才发现多了内容）。

#### 验证

| 判据 | 在哪 |
| --- | --- |
| 守则里**没有岗位词**（skill/审核/起草/沉淀/判决）——"通用"的定义 | `agent-conduct.test.ts` |
| 守则里**没有任务契约**（6000 / material/ / SKILL.md / `## When to Use`…） | 同上 |
| 起草者与审核者身份含**同一份**守则原文（逐字） | 同上 |
| 设定：缺省=平台守则、存了能读回、空串=不预填、超长 400 | 同上（真 daemon） |
| **新建 agent（指令为空）⇒ 真的被预填；给了指令 ⇒ 一个字不动** | 同上（红检：关掉预填 ⇒ 立刻红） |
| 真浏览器：设置抽屉那一段在、**框里已有 141 字符、含「只做被要求的事」** | `probe:layout`（578 项全绿） |
| ① 里**不许**再有护栏（搬走了就别留第二份） | `e2e.test.ts` / `chat-e2e.test.ts` / `first-sentence.test.ts` |

**一处要留意的连带**：预填之后"新建的 agent 指令为空"不再可能，于是两条老用例把"空指令"当样本的地方要**显式清空**（D38 迁移那条），或者改成**前后对比**（老记录清理那条）——不是放宽，是把样本说清。

### 4.3.9 分批第 48 批：起草者身份从 3 条扩到 8 条（"身份还是很少"）

分批第 47 批之后，使用者立刻发现：

> 「改完了吗，我看起草者的身份内容还是很少呢？」

他说得对，而且原因是 47 批自己造成的：把「结构硬要求」搬去了任务书，净效果是身份
**从 462 字缩到 419 字**——搬家搬掉的多、搬进来的少。

#### 这一批搬的（仍是 47 那条判据：换一件活还成立 ⇒ 身份）

| 原位置（③ 任务书） | 现在 | 为什么属于身份 |
| --- | --- | --- |
| 「先做这三件事」第 1、2 条（读索引、按需读、回查原始命令） | 身份第 2、3 条 | 这是**起草这个动作的方法**，与素材是哪一次无关 |
| 产出契约里的结构/frontmatter/引用检查 | 身份第 4 条（**入库闸门**） | "我交付的东西必须能入库"是岗位底线；写法细则仍在写作规范（③） |
| （无） | 身份第 5 条（写法以任务书的写作规范为准） | 一句话把"唯一权威"钉住，避免两处维护 |
| （无） | 身份第 6 条（交付前自检一遍） | 纪律 |

**没搬的**（继续留在 ③）：素材/产出**路径**、写作规范**全文 1731 字**、返工三条、
`REFUSED.md` 的文件名、以及 `agent/instructions.md` 的 **6000 上限**（数字型闸门）。

结果：身份 **419 → 876 字符**（`## 起草者专属` 8 条），③ 那一段从"三件事 + 路径"
瘦成"路径 + 以身份/规范为准"，总字节基本不变——**只是把该在身份的东西放回了身份**。

#### 验证

`agent-conduct.test.ts` 新增一条「身份不再单薄」：数得出这 8 条措辞、长度 ≥ 700 字符、
且**不许**出现 `6000`（数字型闸门只在任务书一处）。

**红检**：把身份退回第 47 批那份（419 字）⇒ 立刻红。

### 4.3.10 为什么「写作规范全文 1731 字」**不**放进身份（分批第 49 批的回答）

使用者问：「『写作规范全文 1731 字』什么不放『身份』里面呢」。

#### 先纠正我自己上一轮的一个错

47 批我说过理由是"放身份会每轮白带 1.7k" —— **这句话是错的**：② 和 ③ 都是**每次 run 都发**，
放哪儿字节数都一样。真正的理由在下面三条，都是可指的。

#### 三条真理由

| # | 理由 | 代码证据 |
| --- | --- | --- |
| 1 | **同一个起草者还干另一件事**：沉淀成 Agent 用的是另一份任务书（判据 = 指令五项 + 6000 上限），写作规范在里面是**完全无关的噪音**，还会跟指令五项抢注意力 | `crystallize.ts` 的 `buildAgentInstructionsPrompt` 与 `buildDraftPrompt` 并存；前者不含规范、后者内联 1731 字 |
| 2 | **单一权威 / 版本一致性**：规范是**随代码走的内置 skill**（`builtin-skills.ts` 的 `writing-skills`），③ 每次取最新；而 `Agent.instructions` 是**每条 agent 的私人副本**（可编辑，升级判据是"存着 === 已知历史"）⇒ 粘进身份就是第二份，规范一改它跟不上——那正是"内置指令停在旧版"这一族缺陷（已为此加过三次历史版本） | `loadBuiltinSkill(WRITING_SKILLS)`；`DRAFTER_INSTRUCTIONS_HISTORY` |
| 3 | **可编辑性边界**：身份使用者可以删改（第 ⑥ 条），规范是**平台权威**；两者混在一格，手滑改掉规范会让审核判据与入库闸门一处对一处错 | 身份 = `Agent.instructions` 字段，界面可编辑 |

#### 唯一支持"放身份"的理由，以及为什么还不够

② 在 A 档（claude）里走**系统提示**（规则层），③ 走用户消息（材料层）——规范确实更像"规则"。
这条成立，但压不过上面三条：**规范不该有第二份拷贝**。

#### 折中已经做了

身份里有第 5 条「**写法以任务书给的写作规范为准**（它是唯一权威，不另立风格、不复述规范）」——
它知道去哪儿看、由谁说了算，而不复制正文。

#### 判据（防止下次有人"顺手"粘进去）

`agent-conduct.test.ts` 新增：把规范里**每一行长行（≥40 字符）的前 40 字**当指纹，
身份里出现任何一个都红。

⚠️ 这第一条判据**第一版是错的**：我按固定字符位置切片（0/600/1200），红检时把规范原文
整行粘进身份却**没抓到**——粘进去那句恰好落在切片的缝里（切片头是 frontmatter 与空行）。
改成按行取探针后红检成立。教训：**指纹式判据要按"内容的分块单位"取，不要按固定偏移。**

### 4.3.11 起草者是**同一个 agent**，服务两个任务（分批第 50 批）

使用者问：「起草者 是 起草 skill 和起草 agent 通用的吗？」

**是。** 不是"两个内置 agent"，是**同一个**「起草者（内置）」+ 两份任务书：

| | 起草 skill | 起草（改）智能体指令 |
| --- | --- | --- |
| 身份 ② | **同一份** `drafter.instructions`（`server.ts` 起 run 时只读一份） | 同左 |
| 任务书 ③ | `buildDraftPrompt`（素材路径 + **写作规范全文 1731** + 产出契约 SKILL.md） | `buildAgentInstructionsPrompt`（existing-agent.md + **指令五项** + **6000 上限** + instructions.md） |
| 产出目录 | `skill/` | `agent/` |
| 审核者 | 「Skill 审核者（内置）」 | **同一个**（分批第 35 批把它的第一句改成"按任务书给的判据判"，两份任务书都喂得进去） |
| run 类型 | `skill-draft` | `skill-draft`（同一条链，`crystallizeTarget.kind === 'agent'` 区分） |

#### 这带来的一个真问题（这一批修的）

分批第 48 批我把「交付要过入库闸门（`SKILL.md` 两节 + frontmatter）」和「使用者的要求写进 `## 约定`」
搬进了身份——它们**只对"写 skill"成立**。而身份是共用的 ⇒ 在"改智能体指令"的 run 上，
这两条会诱导模型产出 skill 结构（那边的产出其实是 `instructions.md`，纯文本 + 字符上限）。

**修法**：加限定语，而不是退回任务书（退回会让身份重新变薄，那正是使用者两次提醒过的事）：

- 第 4 条：「**写 skill 时**，交付要过入库闸门……（**改智能体指令时**不看这一条：那边交付什么由任务书定）」
- 第 7 条：「……**写 skill 时**写进正文 `## 约定` 一节，**改智能体指令时**把它落成指令里的硬约束」

通用的那几条（先读素材索引、回查原始命令、自检）不需要限定语——两个任务都成立。

身份 **876 → 970 字符**；48 批那份逐字冻结成 `DRAFTER_INSTRUCTIONS_V4` 进历史表。

#### 验证

`agent-conduct.test.ts` 新增「同一个起草者服务两个任务 ⇒ 专属条款必须带限定语」：三条措辞必须在、
两条通用条款不许被改坏。

#### 顺带记一个**还没修**的隐患（留给下一批）

`server.ts` 起起草 run 时找内置 agent 用的是：

```ts
const existingDrafter = (await store.listAgents(workspaceId)).find((a) => a.builtin === true)
```

**没有按 role 过滤**。现在平台有两个内置 agent（`drafter` / `skill-reviewer`），
一旦 `listAgents` 的返回顺序让审核者排前面，起草 run 会拿到**审核者的身份**——
而它不会报错，只会让起草"性格变了一个人"。同一写法在 `ensureBuiltinDrafter` 与
`POST /api/crystallize/review` 的取审核者处也出现过（后者已经带了 `role === 'skill-reviewer'`）。

### 4.3.12 起草者第一句改成对象无关（分批第 51 批）

使用者（在我确认"起草者两个任务共用"之后）：

> 「如果是同一个 那身份第一句话『你是 skill 起草者：把一段真实的经验，写成一条以后能被复用的 skill。』，就不合理」

**说得对**，而且这正是第 35 批在审核者身上修过的同一件事：身份写死了对象，任务书换对象时
身份与任务书**互相打脸**——模型遇到自相矛盾的交代，行为是随机的（要么硬套 skill 结构，
要么干脆不按任务书来）。

#### 改了什么

| 位置 | 改前 | 改后 |
| --- | --- | --- |
| 第一句 | 「你是 **skill 起草者**：把一段真实的经验，写成一条以后能被复用的 **skill**。」 | 「你是**平台内置的起草者**：按**任务书给的那套产出契约**，把一段真实的经验写成一件以后能被复用的东西——**可能是一条 skill，也可能是一条智能体的指令**；不写"这一次任务的总结"。」 |
| 专属小标题 | 直接列条目 | 加一句范围声明：「下面这些**两个任务都适用**；只对某一个成立的，条目里会点名是哪一个」 |
| 第 1 条 | 只写可复用的**步骤** | 只写可复用的**东西** |
| 第 3 条 | **写 Procedure 前**回查原始命令 | **写具体做法之前**回查原始命令（…写 skill 时它就是 Procedure 那一段） |
| 第 5 条 | 写法以写作规范为准 | **写 skill 时**写法以写作规范为准；**改智能体指令时**以任务书那几条为准 |
| 第 8 条 | 不值得**沉淀**就说出来 | **不值得就说出来**……**改智能体指令时**同理——证据不足以支持任何改动，就别为了显得"干了活"而改 |

身份 **970 → 1150 字符**；50 批那份逐字冻结成 `DRAFTER_INSTRUCTIONS_V5` 进历史表。

#### 验证

`agent-conduct.test.ts` 新增「第一句必须对象无关」：① 不再以「你是 skill 起草者」开头；
② 点出两个可能的产出；③ 说明产出契约由任务书给。**红检**：第一句退回旧文案 ⇒ 两条断言立刻红。

#### 顺带修掉两条偶发红（都是这次全量跑才暴露的）

1. **`conversation-files-e2e` 里有一条用例会起真的 codex**：它先把工作区默认设成 codex，
   再建对话（建对话会真跑一轮）⇒ 三级解析落到 codex ⇒ **注入的假后端只绑定 claude**，
   于是起了真 CLI（违反 NFR-T-01，表现为"run 一直没到终态"）。修法：**先建对话再切默认**
   ——这条用例要量的是"列目录时的解析"，与"这一轮跑在哪"无关。
2. `crystallize-e2e` 里等"自动重试"的上限 5s → 15s（全量并行时量到偶发超时；断言没动）。

### 4.3.13 Skill 审核者也是同一个，服务两个对象（分批第 52 批）

使用者接着问：「Skill 审核者，它和审核 Agent 的是同一个吗？」

**是。** 与起草者同构：一条内置审核者（`role === 'skill-reviewer'`），`server.ts` 的
`startDraftAudit` 对两类草稿都用它，差别只在任务书与平台定检：

| | 审 skill | 审（改过的）智能体指令 |
| --- | --- | --- |
| 身份 ② | **同一份** `SKILL_REVIEWER_INSTRUCTIONS` | 同左 |
| 任务书 ③ | `draftAuditPrompt`（五项：脚本/命令块/反规避/步骤衔接/使用者要求） | `agentDraftAuditPrompt`（**指令五项**：该做什么/边界/流程命令/产出契约/失败处理） |
| 平台定检 | `material/exec-check.md`（脚本、引用、骨架、占位符） | `material/instructions-check.md`（字符数、空、frontmatter 残留、整篇代码围栏） |
| 产出 | `review.json` | 同左（`outRel` 不同） |

#### 查出来的一处真问题（这一批修的）

身份的判据 1 里写着：**「平台已经跑过定检（`material/exec-check.md`）」** —— 那是**审 skill**
的文件名。审指令那一轮平台写的是 `material/instructions-check.md`，于是它去找一个不存在的文件；
而"标「没查」的项没有结论、不许当成通过"这条纪律会让它把定检那几项判成"没查到"
（用户看到的就是"审了但没说清跑没跑"）。

**修法**（与第 51 批起草者同一招）：身份不写死对象相关的东西，**文件名由任务书点名**：

> 语法/引用文件/骨架/占位符这些**平台已经跑过定检**（文件名见任务书：审 skill 是
> `material/exec-check.md`，审指令是 `material/instructions-check.md`；起审核之前生成）

身份 **1207 → 1263 字符**；47 批之后那份逐字冻结成 `SKILL_REVIEWER_INSTRUCTIONS_V5` 进历史表。

#### 验证

`agent-conduct.test.ts` 新增「审核者也服务两个对象：定检的文件名不许写死」：两个文件名都要在、
且要有"文件名见任务书"这句（以后再出现第三个对象时不至于又漏）。

**红检**：把定检文件名退回只写 `exec-check.md` ⇒ 立刻红。

#### 两个审核者身份里**没有**跟着改的两处（如实记）

- 「你不审的」里那句「这条 **skill** 该不该这么长、该不该拆」是 skill 专属的排除项；
  审指令时对应排除项由任务书写。这段是"排除"表述，误导风险低，这次没动。
- 第 3 条「反规避」里的 `|| true` / `2>/dev/null` 同样是命令类对象的例子；
  审指令时仍成立（指令里也可能出现这类规避），保留。

### 4.3.14 「指令」与「身份」是同一份东西，但两个页面两个名字（分批第 53 批）

使用者：

> 「发现一个问题，配置智能体的时候叫『指令』，模版里面叫『身份』，这样不明确」

#### 事实

| 页面 | 现在的叫法 | 对应的字段/块 |
| --- | --- | --- |
| 智能体页（新建 / 编辑） | **「指令」**（`agents.instructionsLabel`） | `Agent.instructions` |
| 设置 → 第一句话模版 | **「② 身份」**（`tpl.settings.tabIdentity`） | `BLOCK_LABELS.identity` = `② 身份` |
| 运行日志（B 档块名） | `===== ② 身份 =====` | 同上 |

它们确实是**同一份文本**：`identityBlock()` 把 `instructions`（审核者再拼上审核标准）塞进 `{{identity}}`。

#### 为什么选「两个词都留 + 每处点明」，而不是改名

使用者选的是这一条。理由（也写在注释里）：改名会让**界面词与字段名**（`instructions`/`identity`）、
已有关键词（`## 起草者专属`/日志块名/文档）全部不一致，而"两个页面各叫一个名字"这种困惑，
一句明确的映射说明就能解掉——**成本差一个量级**。

#### 落点（三处，都改在"使用者看得见的地方"）

1. **模版页**：② 身份那一块的说明补一句「它就是**智能体页里那条「指令」**（审核者会自动接上它的
   「审核标准」，合成同一块）；这一段在智能体页编辑，这里只决定它出现在哪儿、包什么标题」。
2. **智能体详情（编辑态）**：「指令」下面新增一行说明（`data-instructions-identity`）：
   「这一段会作为第一句话的 ② 身份，每次 run 都发给 CLI……位置由设置里的「第一句话模版」决定」。
3. **新建表单**：只放**一行短标签**「= 第一句话的 ② 身份」。

⚠️ 第 3 条是被探针**当场拦下来**的：第一版我在新建表单里放的是完整的一段说明，
结果「创建」按钮被挤出视口（`template.footVisible` 变 false）。改成一行标签后恢复。

#### 验证

- `pnpm run probe:layout` **578 项全绿**（`template.footVisible` 这条正好说明探针在守"表单变长也不许把主操作顶出视口"）。
- 词条侧：`D39` 的"词条里不许出现 markdown 记号"把新文案里的 `**` 拦下来了（两处 en/zh 各一次）——已去掉。

### 4.3.15 分批第 55 批：让工作目录里的 `.codex/config.toml` 真的生效（项目 trusted）

使用者（想用配置管"哪些 skill 可见"）：「我们先解决 `<workDir>/.codex/config.toml` 不工作的问题」。

#### 真机上量到的事实（本机 codex 0.157.1 实测，不是推断）

在工作目录里放一份 `.codex/config.toml`，启动 `codex app-server` 时它**压根不读**：

```
ERROR codex_app_server: Project-local config, hooks, and exec policies are disabled in the following
folders until the project is trusted, but skills still load.
  1. <workDir>/.codex
     To load project-local config, hooks, and exec policies, add <workDir> as a trusted project
     in <CODEX_HOME>/config.toml.
```

注意这半句：**but skills still load** —— 技能照旧加载，被忽略的只有项目级配置。这就是为什么
从前"跑完删技能"会被当成隔离手段。

实测修法：在受管 `CODEX_HOME/config.toml` 里加

```toml
[projects."<workDir>"]
trust_level = "trusted"
```

之后同一份项目级 `.codex/config.toml` **立刻被读**。验证方式（可复现）：往项目 config 里塞一个
不存在的键 —— 未 trusted 时一声不响；trusted 后 codex 会报
`project (…/.codex/config.toml): this_key_does_not_exist is ignored`（它读了才谈得上"忽略"）。

#### 落法

- `withTrustedProject(configText, dir)`（纯函数，`run-hooks/codex-config.ts`）：
  补一段 `[projects."<dir>"]` + `trust_level = "trusted"`，**幂等**（同名段已存在就不追加——
  TOML 重复定义同一个表是错误，追加两次会让 codex 直接起不来），路径按 TOML 基本字符串转义
  （Windows 的 `C:\…` 必须写成 `C:\\…`）。
- `syncCodexConfigDir(configDir, source, trustProjectDir?)`：复制完使用者的配置后按需追加，
  并把 `trustedProject` + **项目 config 的指纹**（sha256 前 12 位，内容不进日志）交回调用方。
- executor：codex run 时把 `run.workDir` 传进去，并**每轮写一条 note**：

```
codex 项目级配置：已把工作目录标为 trusted（<workDir>）——项目级 config / hooks / exec policies **会加载**；
那份 .codex/config.toml 的指纹是 abcdef123456。
```

#### ⚠️ 必须说清的代价（trusted 是**打包开关**）

codex 这一道门同时放开三样：项目级 **config**、**hooks**、**exec policies**。而工作目录里的文件
**agent 自己也能写** ⇒ 理论上存在一条通道：agent 在目录里写一份带 hooks 的 `.codex/config.toml`，
下一次在**同一目录**里跑的 run（重试 / 下一轮 / 继承同一目录的审核 run）就会执行它。

这就是为什么这条 note 必须出现在每次 run 的日志里（不许悄悄发生），以及为什么把项目的 config
指纹记下来（可审计）。**后续可选的收紧**（还没做，记在这里）：只在"目录里没有项目 config"时开门，
或者对项目 config 的内容做白名单；这两条都会让"使用者自己放一份配置"这条诉求打折，需要单独拍板。

#### 验证

| 判据 | 在哪 |
| --- | --- |
| `withTrustedProject`：补段 / 幂等 / Windows 路径转义 / 原内容一个字节不动 | `codex-config.test.ts` |
| 同步时给了目录 ⇒ 受管 config.toml 真的多出信任段、指纹算得出来、连跑两轮只有一段 | 同上 |
| 不给目录 ⇒ **一个字都不多写**（默认行为不变） | 同上 |
| 红检：不写回 trust 段 ⇒ 立刻红 | 同上 |

### 4.3.16 分批第 56 批：关掉 codex 自带的 system skills（9 → 3）

使用者：「我通过聊天的方式和助手沟通，问它『能看见几个 skill』，它告诉我能看见 9 个。应该不对」。

#### 先量清楚「9」从哪来

`codex debug prompt-input`（codex 自带的"模型可见输入"导出器）在**干净的 CODEX_HOME + 临时工作目录**下，
列出三个技能根：

| 根 | 路径 | 内容 |
| --- | --- | --- |
| r0 | `<workDir>/.codex/skills` | 平台注入的（这次 0 个 —— 日志原话「本次没有注入任何 skill」） |
| **r1** | **`$HOME/.agents/skills`** | 跨 agent 全局目录（3 个：find-skills / fireworks-tech-graph / reverse-engineer-anything） |
| r2 | `<CODEX_HOME>/skills/.system` | codex **自带** 6 个（imagegen / openai-docs / plugin-creator / review-agent / skill-creator / skill-installer） |

3 + 6 = **9**，与助手报的数字对上。顺带一个副作用发现：`~/.codex/skills`（个人 skill）**确实被隔离挡住了**，
不在任何根里 ⇒ 隔离对 `CODEX_HOME` 之内是有效的。

#### 网络调查（都是 openai/codex 官方仓库）

| 线索 | 状态 |
| --- | --- |
| [#46414](https://github.com/openai/codex/issues/46414) 「Config option to skip the `~/.agents/skills` root for an isolated `CODEX_HOME`」 | **还开着** ⇒ 目前没有配置项能关 r1 |
| [#24237](https://github.com/openai/codex/issues/24237) 项目级配置关掉全局/用户级 skill | 还开着 |
| [#56659](https://github.com/openai/codex/issues/56659) 允许隔离客户端排除个人 skill 根 | 还开着 |
| [PR #13792](https://github.com/openai/codex/pull/13792) 支持关闭 bundled system skills | **已实现**（键名见下） |
| [PR #11289](https://github.com/openai/codex/pull/11289) `AGENTS_HOME` 支持 | 0.157.1 **未生效**（实测无效） |

#### 本批落地的（A 案）

受管 `CODEX_HOME/config.toml` 追加：

```toml
[skills.bundled]
enabled = false
```

实测效果（本机 0.157.1，`debug prompt-input` 复核）：**r2 那 6 个消失**，r0（平台注入）与 r1
（`$HOME/.agents/skills`）不变 ⇒ 每次 run 的可见技能从 9 收到 3（且自有注入的技能仍然可见）。

⚠️ 幂等：使用者自己的 `config.toml` 里**已经有** `[skills.bundled]` 段时不追加（TOML 重复定义同一个表
会让 codex 起不来），此时如实回报 `already-configured`，run 日志写「**没有关掉**（你自己的配置里已经有了，
平台不覆盖你的配置）」——不许说"已关闭"。

#### 顺带修掉一句**不准确的日志**

原来那句「codex 个人配置隔离：……用户级 skill 不可见」——**不准确**：隔离只顶掉了 `CODEX_HOME`，
而 `$HOME/.agents/skills` 照旧被扫。改成：
「`CODEX_HOME` 下的用户级 skill 不可见……⚠️ `$HOME/.agents/skills`（跨 agent 的全局目录）**不在隔离范围内**」。

#### 还没做的（B 案，要单独评估）

要彻底断掉 r1 只能重定向 `HOME`。实测 `GIT_CONFIG_GLOBAL` 补偿后 `git config user.name` 仍正常，
但 `~/.ssh` 与 `~/.config` 会一起不可达 ⇒ agent 用 SSH 做 git / 用 gh 会受影响。上游 #46414 合并后
就能用配置项解决，先挂待办。

#### 验证

| 判据 | 在哪 |
| --- | --- |
| `withBundledSkillsDisabled`：追加 / 幂等 / **不覆盖使用者自己那段** | `codex-config.test.ts` |
| 同步后受管 config 里真有 `[skills.bundled] enabled = false` | 同上 |
| 使用者已配 ⇒ 回报 `already-configured`（日志据此说真话） | 同上 |
| 红检：不写回 ⇒ 立刻红 | 同上 |
| doctor 的复制判据从"逐字节相同"改成"**源内容逐字保留**"（平台会追加自己的段） | `codex-doctor.test.ts` |

### 4.3.17 分批第 57 批：宿主级技能逐条禁用（`skills.config`）——使用者实测挖出来的机制

使用者：「我在 `~/temp` 下执行 codex，通过其命令 `/skills` 将 `find_skill` 关闭了，你查一下它设定了什么」。

答案在 `~/.codex/config.toml`：

```toml
[[skills.config]]
path = "/Users/ling/.agents/skills/find-skills/SKILL.md"
enabled = false
```

也就是说 codex 有**按 `SKILL.md` 绝对路径逐条开关**的机制（`skills.config` 数组表，`path` + `enabled`）。

#### 我复核的四条（`codex debug prompt-input`）

| 情形 | 结果 |
| --- | --- |
| 单文件 `enabled = false` | 该 skill **从模型可见清单消失** ✅ |
| **目录**当 `path`（`…/.agents/skills`） | **无效**（技能照旧全在）⇒ 必须逐条列 `SKILL.md` |
| 对 codex 自带的 `.system` 技能 | 单文件禁用同样有效（但我们用 `[skills.bundled]` 一处关更省） |
| 使用者自己写过开关 | 我们不覆盖他的取值（他可能故意开回来） |

#### 落地

- `withHostSkillsDisabled(configText, skillFiles)`：逐条追加 `[[skills.config]] path=… enabled = false`；
  **幂等**（已有同 path 就跳过）、**不动使用者的既有开关**（回 `alreadyListed`）。
- `findSkillFiles(roots, maxDepth=4)`：递归找 `SKILL.md`（codex 也认嵌套那份——真机上
  `fireworks-tech-graph` 有两层，它把两份都列出来了）；目录不存在返回空数组，不抛。
- `syncCodexConfigDir(…, hostSkillFiles)`：在主流程里接上，结果回 `hostSkillsDisabled` / `hostSkillsAlreadyListed`。
- executor：`codex` run 时扫 `$HOME/.agents/skills` 并交下去；**只在隔离开启时做**
  （隔离关掉 = 使用者明确要看个人配置，那时不该禁用任何东西）；日志逐条说明。

#### 端到端复核（真 codex）

受管 config 写成「`[skills.bundled] enabled=false` + 4 条 `[[skills.config]] enabled=false`」之后，
模型的可见技能清单只剩 **1 个**：我们自己注入的 `probe-injected`。

> 三条路合起来，平台第一次**完全控制**了 codex 的可见技能：注入的（workdir）+ 自带（bundled）+ 宿主级（逐条）。
> 不需要重定向 `HOME`（B 案的 `~/.ssh` / `~/.config` 代价因此不必付）。

#### 验证

| 判据 | 在哪 |
| --- | --- |
| 逐条追加 / 幂等 / 不覆盖使用者开关 | `codex-config.test.ts` |
| `findSkillFiles` 递归（含嵌套） / 目录不存在返回空 | 同上 |
| 同步后受管 config 里真有那些 `[[skills.config]]`，且与 `[skills.bundled]` 并存 | 同上 |

### 4.3.18 分批第 58 批：`skills.config` 到底支持什么（通配符？按 name？）

使用者：「你先网络上查一下 `[skills.config]` 配置，或许有通配符的写法，或者其他做法」。

#### 网络调查

| 线索 | 得到什么 |
| --- | --- |
| [commit ad8bf59](https://github.com/openai/codex/commit/ad8bf59cbfb6edbc1dd54626b23fa35c2a94a688) 「Support enable/disable skill via config/api (#9328)」 | 这个机制的出处：`skills.config` 是**数组表**，条目形如 `{path, enabled}` |
| [PR #15378](https://github.com/openai/codex/pull/15378) 「support disable skills by **name**」 | 后来又加了**按 `name` 关** |
| [issue #20210](https://github.com/openai/codex/issues/20210) 「Support skill filtering for project-local `skills.config` entries」 | 想按**过滤条件**批量关，还只是 issue |
| [issue #24237](https://github.com/openai/codex/issues/24237) / [#46414](https://github.com/openai/codex/issues/46414) | 想按"全局/用户级"整类关，也还开着 ⇒ **没有通配符或整类开关** |

#### 我在本机 0.157.1 上实测的（`codex debug prompt-input` 复核）

| 写法 | 结果 |
| --- | --- |
| `[[skills.config]] path = "<abs>/SKILL.md"` + `enabled = false` | ✅ 生效（第 57 批用的就是这个） |
| **`[[skills.config]] name = "find-skills"`** + `enabled = false` | ✅ **生效** —— 而且是**更好的写法** |
| `name = "fireworks-tech-graph"` | ✅ 一份 name 把**两份嵌套副本一起关掉** |
| `name = "imagegen"` | ✅ 对 codex 自带（`.system`）技能同样有效 |
| `path = "…/<星号>/SKILL.md"`（通配） | ❌ 不生效（按字面量匹配） |
| `name = "<星号>"` | ❌ 不生效（又不是"全关"的开关） |
| `name = "find<string>"`（前缀通配） | ❌ 不生效 |
| `path = "<目录>"`（第 57 批试过） | ❌ 不生效 |

**结论：没有通配符；但按 `name` 关是真有，而且比按 `path` 省**（嵌套副本一条就够）。

#### 落地（把第 57 批的实现改成 name 优先）

- `findSkillFiles()` 现在返回 `HostSkill { name, path }`：递归找 `SKILL.md` 并读 frontmatter 的 `name`。
- `withHostSkillsDisabled()`：**有 name 就用 `name`，读不到 name 才退回 `path`**；幂等；不覆盖使用者的既有开关。
- 端到端复核（真 codex 0.157.1）：受管 config 写成
  「`[skills.bundled] enabled = false` + 三条 `name` 禁用」之后，可见技能只剩我们自己注入的那 1 个。

#### 顺带修掉的坑（这条会坑到写注释的人）

我在注释里写「通配写法 `path = "…/*/SKILL.md"` 不生效」时，`*/` **提前闭合了块注释** ⇒ tsc 报了一串
`TS1005/TS1002/TS1127`。教训：**注释里不要原样写出 `*/` 这个组合**（哪怕它出现在示例路径里）。

#### 顺带修掉一条偶发红

`crystallize-e2e` 里等"返工版任务书"的上限 10s → 30s（全量并行时偶发超时；断言没动）。

### 4.3.19 分批第 59 批：**不能按 name 关**——同名会把平台注入的那份一起关掉

使用者提问（问到了要害）：「如果只写名字，如果我加载的 skill 重名，是否会有问题」。

#### 实测（受控 HOME，`codex debug prompt-input`）

夹具：`$HOME/.agents/skills/find-skills`（宿主级）与 `<workDir>/.codex/skills/find-skills`（平台注入）**同名**。

| 情形 | 清单里的 find-skills |
| --- | --- |
| 基线 | **两条**（r0 平台注入 + r1 宿主级）—— codex **不按名字去重** |
| `[[skills.config]] name = "find-skills" enabled = false` | **0 条** —— 连平台注入的那份也**一起消失** |
| `[[skills.config]] path = "<宿主那份 SKILL.md>" enabled = false` | **只剩 r0** ✅ 精确 |

也就是说：**上一批（58）改成 name 优先是个错**，而且错得很隐蔽——它只在"用户恰好装过同名技能"时
发作，发作时**没有任何报错**，只是平台自己注入的技能悄悄不见了。

#### 修法

- `withHostSkillsDisabled()` **只用 `path`**（回到 57 批的做法），`HostSkill.name` 只为日志/诊断保留。
- 代价：嵌套副本要列两条（真机上 `fireworks-tech-graph` 两层）——正确性优先。
- 判据里加死一条：写出来的 config **不许出现 `name =`**（`codex-config.test.ts`），
  并在注释里写明"按 name 关不安全"的实测依据，免得下一次又有人图省事改回去。

> 顺带记一条方法论：这条 bug 是**使用者问出来的**，不是测出来的——上一批的判据只验了
> "name 能关掉宿主那份"，没验"关掉的范围是不是恰好只有它"。以后写这类"关闭/过滤"实现，
> 判据要同时钉住**该关的关了**与**不该关的还在**。

### 4.3.20 分批第 60 批：每个工作目录一份 `CODEX_HOME`（把竞争从结构上消除）

#### 起因：一个"不报错、只是没生效"的竞争

`CODEX_HOME/config.toml` 原来是**全局一份**，而它是每轮 run 从源重建的。问题是：

- 工作目录锁是**按目录**的（`executor.ts:745`）⇒ 两条**不同工作目录**的 codex run 可以并行；
- 于是两条 run 同时重建同一份 `config.toml`，**后写赢**；
- 先写那条 run 的 `[projects."<它的目录>"]` 信任段被抹掉 ⇒ 它那一轮的项目级
  `.codex/config.toml` / hooks **静默不生效**。

这跟"按 name 关技能会误伤同名技能"是同一类缺陷：不报错、只是没按预期发生。

#### 落法（使用者选的 B 方案）

```
~/.agentdeck/data/codex-config/<工作目录路径的 sha256 前 16 位>/   ← 每个工作目录一份 CODEX_HOME
```

- `codexHomeFor(root, workDir)`：同一 workdir ⇒ 同一份（resume 与状态稳定），不同 workdir ⇒ 不同份；
- ⚠️ **绝不放进工作目录本身**：里面是 `auth.json`（真实 key），而 agent 能读自己的工作目录（D78 的硬约束）；
- `pruneCodexHomes(root, current, keep = 8)`：codex 会在每个 home 里生成 `sessions/`、`*.sqlite`、
  `skills/.system/` ⇒ 按 mtime 保留最近 8 份；**只删名字形如 16 位十六进制**的目录（我们自己的命名），
  当前这份永不删，别人的目录一律不碰；
- executor：`codexHomeEnv` 在 run 级声明（声明在 `try` 外面——里面声明会遮蔽，`injectedSkills` 那条注释记着同款坑）。

#### 已知代价（如实记）

1. **磁盘**：每份 home 都有 codex 的状态文件与 `.system` 技能 ⇒ 靠 `pruneCodexHomes` 兜底（保留 8 份）。
2. **跨目录 `thread/resume` 会断**：现在没有这种用法（沉淀返工在同一个小屋、聊天在同一对话目录、
   审核继承被执行 run 的目录），但以后写新功能要记住：**换目录 = 换 CODEX_HOME = 丢会话**。
3. 旧的全局 `data/codex-config/config.toml` 从此只作为**根目录**存在，里面那份不再被使用；
   已有的 `skills/.system` 等状态留在原地（不自动删，避免动使用者数据）。

#### 验证

| 判据 | 在哪 |
| --- | --- |
| `codexHomeFor`：同目录同份、异目录异份、**不落在工作目录里** | `codex-config.test.ts` |
| **两条并行的 run（不同工作目录）各自的信任段都在、且互相不含对方** | 同上（这就是全局一份时那个 bug 的回归守卫） |
| `pruneCodexHomes`：只清自己命名的、保留最近 N、当前份不删、别人的目录不碰 | 同上 |
| `CODEX_HOME` 真注入到后端且指向那份哈希目录 | `e2e.test.ts`（D78 三条）/ `runtime-config-isolation.test.ts` |

### 4.3.21 分批第 61 批：删掉对话/任务时，它那份 `CODEX_HOME` 一起清

使用者提的：「删除聊天和任务的时候，这个目录需要同步删除」。

#### 为什么必须清

- 那份目录里有 `auth.json` 的**真实 key 副本** —— 任务/对话都删了，还留着一份 key，是那种
  "看不见、但一直在"的残留；
- 目录名是工作目录路径的哈希 ⇒ 工作目录没了/被复用之后，这份永远对不上号。

#### 落点（三处删除路由）

| 入口 | 清哪一份 |
| --- | --- |
| `DELETE /api/conversations/:id` | 删之前先用 `resolveWorkDir` 算出对话目录（对话记录里可能没存 `workDir`），删完清 |
| `DELETE /api/issues/:id` | 删之前**收集**这条任务所有 run 的 `workDir`（删完就查不到了）+ 按 subject 算出来的那个目录（没跑过 run 时 `ensureWorkDir` 也已经建了），删完逐个清 |
| `DELETE /api/runs/:id` | 这条 run 的 `workDir` |

共同助手 `removeCodexHomeFor(root, workDir)`：
- 只认**我们自己命名的目录**（名字是 16 位十六进制）——传进来任何怪路径都不会误删别的东西；
- `force` 语义：已经不在了也算成功；
- 失败只记一条 `info`（删除实体的路由不该因为清理失败回 500）。

#### 验证

| 判据 | 在哪 |
| --- | --- |
| `removeCodexHomeFor`：删掉指的那份、别的不碰、不存在也算成功 | `codex-config.test.ts` |
| **真 HTTP**：建两个对话（各自一份 CODEX_HOME）→ 删其中一个 → **它那份没了、另一份还在** | `runtime-config-isolation.test.ts` |
| 红检：把删除后的清理注释掉 ⇒ 立刻红 | 同上 |

> ⚠️ 写这条用例时踩了一个坑，值得记：新对话用的是**播种出来的执行者**（记的是 `claude`），
> 于是那一轮跑的是 **claude**、根本没写 CODEX_HOME（第一次红就是这个）。必须先把那条执行者
> 改成 `runtimeKey: 'default'`（= 跟随全局 ⇒ codex），才量得到"删了之后目录没了"。

### 4.3.22 分批第 62 批：claude 侧同样要关掉**自带**的 skills

使用者：「同步检查一下 claude，也有类似 skill 的问题」。

#### 怎么量的（不花 token）

claude 没有 codex 那种 `debug prompt-input`，但有更好的办法：**把 `ANTHROPIC_BASE_URL` 指向一个假的
本地端点**，它就会把**真正要发给模型的请求体**（含 system prompt 里的技能段）POST 过来，我们存下来看。
这样量到的是"模型真正看到的"，而不是猜。

#### 量到的（claude 2.1.302，`CLAUDE_CONFIG_DIR` 指向空目录 + 工作目录注入 1 条探针技能）

| 情形 | 模型可见技能 |
| --- | --- |
| 基线 | **14 条** = 我们注入的 `probe-injected` + **claude 自带 13 条**（dataviz / code-review / security-review / init / run / loop / claude-api / update-config / keybindings-help / simplify / fewer-permission-prompts / workflow-authoring / plugin-authoring） |
| `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1` | **2 条** = 注入的 + `plugin-authoring`（它是 claude 内置的**插件**技能，目前没有开关） |
| `--disable-slash-commands` | **整个技能段消失**（连我们注入的一起）⇒ 不能用 |
| `~/.agents/skills`（codex 的宿主级那 3 个） | **claude 根本不读** ⇒ 这一侧没有 codex 那个漏洞 |
| `~/.claude/skills`（个人技能） | 被 `CLAUDE_CONFIG_DIR` 挡住 ✅ |

#### 落地

executor 的 env 组装里（与 `CLAUDE_CONFIG_DIR` 同一处、同一条件）：

```ts
...(isolateRuntimeConfig && runtime.descriptor.key === 'claude'
  ? { CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1' }
  : {}),
```

- **只在隔离开启时**注入（关掉隔离 = 使用者要看自己的东西，那时不替他关）；
- 平台**最后写** ⇒ agent 想用自定义 env 把它设成 `0` 也覆盖不了（有 e2e 钉着）；
- 运行日志说清结果，并**如实交代**还剩 `plugin-authoring`：
  「claude 自带的 skills：已关闭（…=1）——这次的技能清单只剩平台注入的（以及 claude 内置插件技能 plugin-authoring，它没有开关）。」

#### 两侧对照（现在是一致的）

| | codex | claude |
| --- | --- | --- |
| 平台注入的 | `<workDir>/.codex/skills`（每轮对账） | `<workDir>/.claude/skills`（每轮对账） |
| 自带 skills | `[skills.bundled] enabled = false` | `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1` |
| 用户级 | `CODEX_HOME` 重定向 | `CLAUDE_CONFIG_DIR` 重定向 |
| 宿主级（`~/.agents/skills`） | 逐条 `[[skills.config]]` 禁用 | **不读**，无需处理 |
| 剩余 | 无 | `plugin-authoring`（内置插件技能，暂无开关） |

#### 验证

| 判据 | 在哪 |
| --- | --- |
| 隔离开 ⇒ `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS === '1'`，且日志说明含"还剩 plugin-authoring" | `runtime-config-isolation.test.ts` |
| 关掉隔离 ⇒ **不注入**（不替使用者关） | 同上 |
| agent 自定义同名 env（设成 `0`）被平台覆盖 | 同上 |
| 红检：不注入 ⇒ 两条断言立刻红 | 同上 |

#### 顺带修的一条偶发红

`crystallize-e2e` 里"理由码要交下去"这条：`waitRevisedFrom()` 一返回只说明**版本表多了一行**，
而 `material/feedback.md` 是那一版**开工时**才写的 ⇒ 读一次就断言会抢跑。改成等文件里出现理由码
（断言没动）。

### 4.3.23 分批第 63 批：`plugin-authoring` 也有开关（`enabledPlugins` + `@builtin`）

使用者：「我测试了，有发现 plugin-authoring，请检查」。

上一批（62）我只关到了 bundled skills，剩下的 `plugin-authoring` 记成了"没有开关"。这一批找到了：

#### 实测（假 Anthropic 端点抓请求体，不花 token；claude 2.1.302）

夹具：`CLAUDE_CONFIG_DIR` 指向空目录 + 工作目录注入 1 条探针技能 + `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1`。

| 受管 `settings.json` 里的内容 | 清单里剩什么 |
| --- | --- |
| （不写 `enabledPlugins`） | 2 条：`probe-injected` + **`plugin-authoring`** |
| `{"enabledPlugins":{"plugin-authoring@builtin":false}}` | **1 条：只剩 `probe-injected`** ✅ |
| `{"enabledPlugins":{"plugin-authoring":false}}`（不带 `@builtin`） | 2 条 —— **不生效** |

⇒ 键必须带 **`@builtin`**（那是 claude 内置插件所在的 marketplace 标识）。

#### 落地

`syncClaudeConfigDir` 写受管 `settings.json` 时，在 `env` 旁边多写一项：

```json
{ "env": { … }, "enabledPlugins": { "plugin-authoring@builtin": false } }
```

- **只写这一项**：使用者自己的 `enabledPlugins` / marketplaces **不复制**（D78 的边界：用户级行为配置不进任务）；
- `env` 照旧整份同步（认证不丢）；文件仍 `chmod 600`；
- 运行日志改成：「claude 自带的 skills：已关闭（`CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1` + 受管 settings 里的
  `enabledPlugins.plugin-authoring@builtin=false`）——这次的技能清单只剩平台注入的那些。」

#### 验证

| 判据 | 在哪 |
| --- | --- |
| 受管 settings 里 `enabledPlugins === {'plugin-authoring@builtin': false}` | `claude-config.test.ts` |
| `env` 照旧整份写入（这一项是**额外**的，不是替换） | 同上 |
| 红检：不写 `enabledPlugins` ⇒ 立刻红 | 同上 |

#### 现在 claude 侧的全貌

注入的 + 自带（`CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1`）+ 内置插件技能（`enabledPlugins`）
—— 三条都关掉之后，**模型看到的技能 = 平台注入的那些**（实测 1 条）。
`~/.agents/skills` 与 `~/.claude/skills` 这两条用户级路径本来就进不来（claude 不读前者、后者被 `CLAUDE_CONFIG_DIR` 挡住）。

### 4.3.24 分批第 64 批：两个 runtime 的配置隔离收成**一条逻辑**

使用者：「我还是建议同一逻辑，代码尽量复用」。

#### 原来的形状（问题）

executor 里是**两段并列的 if**：claude 一段、codex 一段，各自拼 note、各自往 env 里塞变量、
各自处理失败。行为确实一样（"把配置搬进受管目录，再把 CLI 指过去"），但代码是两份——
加一条规则就得写两遍，而**只写一遍**的表现是"claude 关了、codex 没关"，这个仓库踩过好几次同款
（起草者/审核者各一份、`resolveSpawnTarget` 的 spawn 选项两份）。

#### 现在的形状

新模块 `apps/daemon/src/run-hooks/runtime-config.ts`，流程只有一条：

```
managedHomeFor(runtime)   →   syncRuntimeConfig({runtimeKey, rootDir, workDir, sourcePath, hostSkills})
                          →   { ok, home, env, notes }
```

- executor 里**一段** `if`：调它、把 `notes` 逐条写进日志、把 `env` 交给后端；
- server 的"删实体时清理"也走 `forgetRuntimeConfigHome(runtimeKey, root, workDir)`——
  **按策略**决定要不要真删，而不是按 runtime 名写 if；
- 老的两个模块（`claude-config.ts` / `codex-config.ts`）保留为**写入器**（它们各自知道
  怎么写自己那份文件），只是不再被 executor 直接调用。

#### 唯一的差异 = 策略表里的一行

```ts
export const POLICY = {
  claude: { perWorkDir: false, why: '每轮内容完全一样；CLAUDE_CONFIG_DIR/projects 是会话状态，--resume 要它全局稳定' },
  codex:  { perWorkDir: true,  why: '每轮要写 [projects."<本次工作目录>"] trust ⇒ 内容每轮不同，全局一份会被并行覆盖' },
}
```

- `managedHomeFor()` 按这个布尔值算目录；
- `forgetRuntimeConfigHome()` / `pruneRuntimeConfigHomes()` 按它决定"要不要真动手"
  ⇒ 以后若把 claude 也改成 perWorkDir，改的是**那个布尔值**，三处行为一起跟上；
- 新增 runtime（如果有第三种隔离形态）只需在表里加一行 + 一个写入器。

#### 验证

| 判据 | 在哪 |
| --- | --- |
| 策略表就是差异本身（`claude.perWorkDir === false` / `codex.perWorkDir === true`，且都有 `why`） | `runtime-config.test.ts` |
| **同一个函数**产出两个 runtime 的 `notes + env`（claude 有 `CLAUDE_CONFIG_DIR` + 关自带技能；codex 有 `CODEX_HOME` + 宿主级禁用说明） | 同上 |
| 清理/剪枝按策略走：**codex 真删**、**claude 无操作** | 同上 |
| 原有行为全部不变 | 全量 2189 全绿 |

### 4.3.25 分批第 65 批：cli 形状适配器的公共基类（第 1 步）

使用者：「尽量还是用公共类，通过继承来实现它们之间的差异」。

#### 量到的现状（改造前）

| 包 | 文件 | `execute()` |
| --- | --- | --- |
| agent-claude | 237 行 | **156 行** |
| agent-generic | 468 行 | **294 行** |
| agent-codex | 671 行 | 495 行（service 形状，另说） |

claude 与 generic 的骨架逐行几乎一样：解析可执行 → `buildArgv` → 警告被丢弃的参数 →
`planSandbox` → 建队列+解析器 → `spawnProcessTree` → 投递 stdin → abort 监听 →
`handle.exited` 里拼 `AgentResult`。**约 90–110 行重复**，而且已经漂了：
generic 补了 `isRunnableFile`（"能起吗"必须先问）与 `spawnError` 双出口，claude 那份没有——
**而 claude 是主力 runtime**。

#### 落法

`packages/agent-core/src/backend-base.ts` 新增 `LineStreamBackendBase<P>`：**模板方法**写一次骨架，
差异全是子类 override：

| 差异 | 谁 override | 方法 |
| --- | --- | --- |
| 拼 argv / prompt 怎么投递 | 两个都 | `buildLaunch()` |
| 系统提示通道（`--append-system-prompt`） | claude | `buildLaunch()` 里 |
| "这个文件能不能当程序跑" | generic | `assertRunnable()` |
| 协议解析 | 各自 | `createParser()` |
| 终态判定 | 各自 | `buildResult()` |
| 找不到可执行文件怎么说 | 各自 | `missingExecutableMessage()` |
| 会话恢复被拒怎么判 | 各自 | `resumeRejected()` |

改造后：

| 文件 | 行数 |
| --- | --- |
| `claude-backend.ts` | 237 → **129** |
| `generic-backend.ts` | 468 → **300** |
| `backend-base.ts`（新增） | 291（骨架 + 注释） |

#### 顺带修掉一处**行为不一致**（这是这次重构真正的收益）

`assertRunnable()` 现在在基类里**每次都会调**：claude 用默认空实现（老行为不变），
generic 覆盖成 `isRunnableFile`。也就是说"起进程前先问能不能跑"这条纪律从
**generic 独有**变成了**基类的流程**——以后谁再写 cli 形状的适配器，自动带上。

验证：claude 19 条 + generic 64 条适配器测试全绿；全量 2189 全绿（行为一条没变）。
