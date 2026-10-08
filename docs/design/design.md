# AgentDeck 设计文档

| 项 | 内容 |
|---|---|
| 文档版本 | **v2.8**（**2026-09 第一句话改成三块组装**：① 框架（模版，每轮都发）/ ② 身份（`Agent.instructions`，审核者接上老标准）/ ③ 任务；投递两档 A（`--append-system-prompt`）/ B（三块合成一段）且记在 `Run.deliveryMode` 上；六个模版变量退役、变量表 9 条；聊天有自己的 ① 且 ② 也发 —— 见 §15.33。同批收口：「审核标准」那一整段从界面删除（依据并进 ②，老数据保存时自动并进「指令」）、三个"只看老字段"的判据修掉（动作权限的取法、报告路由的粗筛、详情页那条红警告）。此前：**v2.7** D45 返工回路（`fail` 不处置、交回执行者重做；新增终态 `rework_requested`）；D37–D44 对齐（标准内联、动作只来自工具包、界面中英双语、新建任务三步链、动作固定参数、行动权限「左选右配」） |
| 状态 | 待评审 |
| 上游 | [`../srs/requirements.md`](./../srs/requirements.md) v2.0（FR-* / INV-* / NFR-* 均指向该文档） |
| 本文档回答 | **怎么实现** |

> 阅读顺序建议：§2 总体架构 → §4 数据模型 → §5 接口 → §7 Verdict schema → §8 本地 Daemon → §9 Claude 适配层。

> ⚠️ **读本文档前请知道一件事（2026-10）**：`Agent.reviewerAgentId`（执行者的「由谁审它」）、
> `Agent.allowedActions` / `actionParams` / `debugActions`（审核者的「行动权限」）以及
> `ReviewStandard.allowedActions` **已经整个撤掉**——"谁审谁"与"判完允许动什么"现在
> **只有智能体组**能回答（没选组 ⇒ 这条任务没有审核者）。本文档是**按时间累积的决策记录**，
> 所以下面 §15 的 D40/D42 等章节里仍然写着那两个字段的来龙去脉（那是当时的决定，保留原文）；
> 凡读到它们，请当作**历史**，以 `docs/design/agent-groups.md` §16（这一轮的完整清单、
> 老数据的清理方式、直接后果）与 `docs/runtime/pipeline.md` 的现状表为准。
> ★ run 上的同名字段（`Run.reviewerAgentId` / `allowedActions` / …）**没有撤**：它们是
> "这一次的事实"，语义一个字没改。

---

## 1. 设计原则

| # | 原则 | 来源 |
|---|---|---|
| P1 | **页面是唯一通路** —— daemon 承接本机页面操作；daemon **不发起**对远端的请求 | D3、FR-BRIDGE-08 |
| P2 | **词汇单一来源** —— 状态、原因码、动作名、接口契约全部由 `packages/protocol` 一处定义 | INV-18、FR-REVIEW-12 |
| P3 | **存储是端口，不是实现** —— 领域逻辑只依赖 repository 接口；v1 文件存储是可替换适配器 | FR-STOR-02/03 |
| P4 | **注入即所有权** —— 凡写入使用者环境的东西，必须可标识归属、可逐字节回滚 | FR-CLI-16/27/29 |
| P5 | **判决窄、产出物宽** —— verdict 全局统一且闭合；多样性由 artifact 承载 | FR-REVIEW-02/10 |
| P6 | **差异集中到表** —— CLI、第三方、动作执行端的差异各集中到一张表，调用点不感知 | FR-CLI-47、FR-REG-09、INV-13 |

---

## 2. 总体架构

### 2.1 组件与边界

```
┌──────────────── 使用者浏览器（本地 Chrome） ─────────────────┐
│  ★ 打开 http://127.0.0.1:<固定端口>                          │
│  Web UI ← 由 daemon 托管，与本地接口同源                     │
│                                                              │
│   ① 本地接口（同源）   /api/*  +  /ws                        │
│        → 本机 daemon：★ 权威工作数据与执行                    │
│   ② 远端接口（跨源）   https://<远端>/api/*                   │
│        → 账号、设定、公共能力目录、第三方查询、记录统计        │
└───────┬──────────────────────────────────────┬───────────────┘
        │ HTTPS（token 登录）                   │ 同源，无需 CORS
        │                                       │
┌───────▼──────────────────────┐   ┌───────────▼─────────────────┐
│  远端（五项职责）              │   │  本机 daemon（★ 权威）       │
│   ├ 账号与登录                │   │   ├ ★ 托管 Web UI            │
│   ├ 保存用户设定              │   │   ├ 设备标识 deviceId        │
│   ├ 公共 SKILL/TOOL 目录      │   │   ├ 探测本机 CLI             │
│   ├ 第三方触发查询            │   │   ├ ★ 全部工作数据与审计链   │
│   ├ 记录与统计（便利副本）     │   │   ├ 保存 skill、建工作目录    │
│   └ 不执行、不持权威数据       │   │   ├ 注入 → 起进程 → 进程树管理 │
│   （可选：一个落地页）         │   │   └ 不发起任何对远端的请求    │
└──────────────────────────────┘   └───────────┬─────────────────┘
                                               │ 子进程
                                    claude -p --output-format stream-json
                                               └──▶ 使用者指定的工作目录
```

**两条规则**：

1. **daemon 不发起任何对远端的请求**（P1）。取 run、下载 skill、查第三方、上报记录，全部由本地页面代为发起。
2. **远端不持有权威数据**（§2.6）。

### 2.2 边界规则（硬约束）

| 规则 | 说明 |
|---|---|
| **页面是唯一通路** | daemon 不连远端，远端也不连 daemon |
| **daemon 不持有远端凭据** | 凭据只在页面内存/localStorage 中 |
| **代码与工作目录不出本机** | 远端不执行命令、不上传工作目录。**例外**：agent 的环境变量存在远端并在执行时下发，须如实披露 |
| **本地接口只绑回环 + 校验 `Host`** | 同源后攻击面收敛，但这两条仍是必需（§14.2） |
| **实时状态权威在本地** | 进行中的 run 以 daemon 为权威；远端持有同步快照 |
| **关闭页面 = 停止派发新 run** | 已在跑的 run 由 daemon 继续跑完（FR-BRIDGE-05） |

### 2.3 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 语言 | TypeScript（全栈） | 契约单源共享（P2）；D1 只支持一个 CLI，无多语言收益 |
| 运行时 | Node ≥ 22（ESM） | 原生 fetch / WebSocket / test runner；与目标 CLI 生态一致 |
| **构建** | **无**——Node 原生类型擦除直跑 `.ts` | 见下方说明 |
| daemon | **Node 内置 `http`** | 首版路由面很小；省掉一个框架依赖，与"不得依赖原生模块"一致 |
| Web | **零构建**的原生 ES 模块（HTML + JS + CSS） | 见下方说明 |
| 契约 | zod | 单源定义 + 运行时校验 + 类型推导三合一 |
| 存储 | v1 文件；接口按端口抽象 | D5 |
| 包管理 | pnpm workspace | 多包仓库标准 |

**关于"没有构建步骤"**：Node ≥22 可以直接执行 `.ts`（类型擦除）。这带来两条纪律：

1. `tsconfig` 开启 **`erasableSyntaxOnly`** —— 禁止 TS `enum` / `namespace` /
   参数属性。我们本来就用 `as const` + zod 建模，所以这条约束零成本；
2. 类型检查与运行分离：`tsc --noEmit` 做类型检查，`node` 直接跑源码与测试。

**关于 Web 用零构建而不是 Next.js**：见 §13 开头。设计文档早先写的是 Next.js；
M0 用零构建版本先跑通闭环，替换成本被 `apps/web` 的静态资源层挡住。

### 2.4 为什么不上数据库（D5）

v1 是**单节点**本地工作台，典型规模是几百 issue、几十 agent。引入 Postgres 的代价是**安装复杂度**，而收益（并发、副本、复杂查询）在单节点上几乎用不到；反之"一条命令跑通"直接决定首次体验。

因此用文件存储，但按 §3.3 的端口设计，使换数据库成为**替换适配器**而非重写领域逻辑。

### 2.5 部署形态

**不变的前提：daemon 永远与使用者页面在同一台机器上。**

**形态 A —— 本地 daemon + 官方远端（默认）**

```
          ┌── 项目方托管的远端 ──┐
          │  账号 / 设定 / 目录   │
          │  第三方查询 / 记录    │
          └───────────┬───────────┘
                      │ HTTPS（token）
          ┌───────────┴───────────┐
   使用者机器: 浏览器 + daemon + claude
```
适用：绝大多数使用者。**不需要自己部署任何东西**。

**形态 B —— 本地 daemon + 自建远端**

适用：想完全自持远端（含**私有能力目录**）的使用者。注意：**这不是团队协作形态**——每台机器的数据仍各自独立在本地。

**形态 C —— 常开机器**

```
常开机器（家用服务器 / 内网服务器）
├── 浏览器（★ 必须常驻）
├── daemon  ── 数据目录
└── claude
```
适用：希望 agent 不依赖某台笔记本开机。**必须常驻一个页面会话**（NFR-D-03）。

**同机部署必须处理的三件事**：

1. 数据目录与远端数据目录**可独立配置且默认不重叠**（NFR-D-04）
2. 同一数据目录**只允许一个 daemon 进程打开**（锁文件，含 pid + 启动时间）（NFR-D-05）
3. **固定端口**；被占用时必须立即失败并给出可读原因，**不得静默换端口**（FR-BRIDGE-14）

**时钟纪律**：远端时间戳由**远端**打戳；daemon 本地时间只用于本地顺序与时长（消息 `seq`、`durationMs`）。

**一个必须写清的推论**：**"绑定本地目录"是执行面概念**（NFR-D-07）。远端无法校验路径是否存在——它只在持有它的 daemon 眼里有意义。因此远端**不做路径存在性校验**；路径不可用时由 daemon 判定（可恢复 → `waiting_local_directory`；不可恢复 → 明确错误）。

### 2.6 状态归属与编排职责

| 状态 | 权威位置 | 理由 |
|---|---|---|
| workspace / agent / skill / issue / comment | **本机 daemon** | 单用户，无需共享 |
| verdict / action / artifact / **审计链** | **本机 daemon** | 合规证据必须可追溯；远端副本不可信 |
| 进行中 run 的状态与消息流 | **本机 daemon** | 实时权威；否则刷新页面即丢进度 |
| 公共 SKILL / TOOL 目录 | **远端** | 只读分发 |
| 账号与用户设定 | **远端** | 跨机器一致 |
| 记录副本 / 统计 | **远端（便利副本）** | 仅用于跨机器查看与统计 |
| 工作目录、CLI 登录凭据 | **本机** | 永不离开本机 |

**编排职责在页面**（FR-BRIDGE-02）：

```
远端                     页面                         本机 daemon
 │                        │                               │
 │◀─ 1. 轮询"属于本机的排队 run" ─┤                        │
 │── 2. 返回 queued run ──▶│                               │
 │                         │── 3. 提交 run（同源）─────────▶│ ★ 先本地落盘
 │                         │◀─ 4. 202 Accepted + runId ─────│
 │                         │                               │ 起 claude
 │                         │◀─ 5. SSE 消息流 ───────────────│
 │◀─ 6. 关键节点提交快照 ──┤                               │
 │                         │◀─ 7. 终态 ─────────────────────│
 │◀─ 8. 提交终态与用量 ─────┤                               │
```

**异常时的行为**：

| 事件 | 正在跑的 run | 新 run |
|---|---|---|
| 页面刷新 | 不受影响；重连后**按 `seq` 补齐**消息 | 重连后继续 |
| **多个标签页同时打开** | 由**远端的 CAS** 保证同一条 run 只被一个标签页取走（`transitionRun(id,'queued','dispatched')`）；daemon 侧再以 `runId` 幂等兜底 | 同左 |
| 关闭页面 | **继续跑完** | **不再派发** |
| daemon 重启 | 读本地落盘状态；未完成的 run 标为 `failed`（`failure_reason: daemon_restarted`），可按策略重试 | 恢复后继续 |
| 远端不可达 | 继续跑完；终态在本地排队，恢复后补交 | 无法派发（取不到排队状态） |

> **关键设计点**：步骤 3 中 daemon 必须**先本地落盘、再返回 202**。否则页面在收到响应前崩溃，这次 run 就凭空消失了。

---

## 3. 仓库与包结构

### 3.1 目录布局

### 3.1 目录布局

```
agentdeck/
├── apps/
│   ├── daemon/              本机服务（bin: agentdeck）★ 同时托管 Web 界面
│   ├── web/                 Vite + Svelte 界面（构建产物 apps/web/dist/ 由 daemon 托管）
│   ├── remote/              远端服务（账号 / 设定 / 目录 / 查询 / 记录 / 插件）
│   ├── cli/                 命令行客户端（连 daemon 的 HTTP API）
│   └── mcp/                 MCP 服务端（把 daemon 的能力暴露给外部 agent）
├── packages/
│   ├── protocol/            ★ 单一来源：zod schema、枚举、接口契约
│   ├── domain/              领域模型、状态机、动作定义、存储端口定义
│   ├── store-file/          v1 文件存储适配器
│   ├── store-sqlite/        SQLite 存储适配器
│   ├── agent-core/          适配层接口、runtime 描述表、第一句话模版、沙箱
│   ├── agent-claude/        Claude Code 适配器
│   ├── agent-generic/       第二个适配器（通用 NDJSON；证据等级 provisional）
│   ├── agent-codex/         codex app-server 适配器（**service 形状**：JSON-RPC；provisional）
│   └── i18n/                界面词表（中 / 英）+ 取值标签
├── examples/tools/          可抄的工具包范例（`example-note`）
├── packages/ui/             两个前端共用的设计系统（令牌 + 主题判定）
├── tools/                   独立工具（跑一次就退出，不是服务）
│   ├── layout-probe/          真浏览器量布局（改界面后跑）
│   └── skill-catalog-sync/    推荐技能目录的同步（抓 GitHub 写目录）
├── tests/                   跨包测试
├── docs/
└── ref/
```

> ⚠️ **这棵树改过**：原来这里写着 `Next.js UI`、`packages/remote-client/`、`packages/ui/`
> ——三样**都不存在**。Web 界面从零构建迁到了 Vite + Svelte（见 §15.24），
> 远端 API 客户端与共享组件都不再单独成包（各自在 `apps/web/src/lib/` 与
> `apps/web/src/components/` 里）。**没有 Next.js**，也没有那两个包。

**依赖方向（单向，禁止反向）**：

```
protocol ←── domain ←── store-file / store-sqlite
   ↑           ↑      ←── agent-core ←── agent-claude / agent-generic / agent-codex
   └───────────┴────── apps/{daemon,web,remote,cli,mcp}
```

⚠️ 三个适配器（claude / generic / codex）的**共同调用点只有一个**：
`apps/daemon/src/runtime-registry.ts`——拼装点必须待在组合根，否则 `agent-core` 得反过来
依赖适配器包，形成环（见 §9.1）。

### 3.2 `packages/protocol` —— 单一来源

```ts
// 枚举（闭合，任何新增都必须在此处）
RunStatus            // queued | dispatched | running | waiting_local_directory
                     // | deferred | completed | failed | cancelled
RunKind              // execute | review
VerdictConclusion    // pass | fail | needs_human
ReasonCode           // 共享枚举，见 §7.3
ActionRefType        // 动作名（`<包 slug>.<动作名>`；D41 起没有内置动作）
ActionPlane          // local | remote        ← 执行端
IssueStatus          // backlog | todo | in_progress | in_review | done | blocked | cancelled

// 实体
Issue, Comment, Agent, Skill, Runtime,
Run, Report, Verdict, Finding, Action, Artifact, AuditRecord

// 契约
LocalApiRequest/Response    本地接口
RemoteApiRequest/Response   远端接口
RunEvent                    SSE 事件
```

| 消费方 | 收益 |
|---|---|
| daemon | 请求校验 + 响应类型 |
| web | 客户端类型（无需手写 API 层类型） |
| remote | 与页面共用的契约 |

**`FR-REVIEW-12` 的落地方式**：只有这一个包定义 schema，其他包不得出现重复定义，并加一条 lint 规则防止漂移。

### 3.3 存储端口（P3）

**接口按领域需要定义，不按文件存储的能力定义。**

```ts
// packages/domain/src/ports/store.ts
export interface Store {
  // ── 读取 ──
  getIssue(id: IssueId): Promise<Issue | null>
  listIssues(q: IssueQuery): Promise<Page<Issue>>
  getRun(id: RunId): Promise<Run | null>
  listRuns(q: RunQuery): Promise<Page<Run>>
  getReportByDedupKey(k: DedupKey): Promise<Report | null>

  // ── 写入（带期望前态，天然映射到将来 DB 的 WHERE 条件） ──
  insertRun(run: Run): Promise<void>
  /** 仅当当前状态等于 expect 时转移；返回是否成功。这是 CAS 语义。 */
  transitionRun(id: RunId, expect: RunStatus, next: RunStatus, patch?: RunPatch): Promise<boolean>
  insertVerdict(v: Verdict): Promise<void>
  insertAction(a: Action): Promise<void>
  transitionAction(id: ActionId, expect: ActionStatus, next: ActionStatus, patch?): Promise<boolean>

  // ── 内容寻址 ──
  putBlob(bytes: Uint8Array): Promise<BlobRef>   // 返回 sha256 引用
  getBlob(ref: BlobRef): Promise<Uint8Array>

  // ── 审计 ──
  appendAudit(rec: AuditRecord): Promise<void>
}
```

**禁止出现在端口里的东西**（FR-STOR-03 的落地）：

| 反例 | 为什么禁止 |
|---|---|
| `readJsonFile(path)` / `writeJsonFile(path, obj)` | 把存储实现泄进领域逻辑 |
| `readAll(): Record<Id, T>` | 迫使领域逻辑做全量扫描，数据库上不可行 |
| 任何带 `file` / `json` / `line` 字样的方法名 | 命名即泄漏 |

**CAS 语义是这套设计的支点**：`transitionRun(id, expect, next)` 在文件存储上是"加锁读 → 校验 → 追加"，在数据库上是 `UPDATE ... WHERE status = $expect`。**语义相同**，因此领域逻辑不需要知道底下是什么。

### 3.4 v1 文件存储的落地形态

已实现，见 `packages/store-file/`。实际布局：

```
<数据目录>/
├── meta.json                      # { formatVersion, instanceId }
├── lock                           # 单进程锁（pid + 启动时间）
├── device.json                    # 本机设备标识
├── workspaces.jsonl               # workspace 记录（全局，量小）
└── workspaces/<wsId>/
    ├── log/<collection>.jsonl     # append-only，权威记录（14 个集合：agent / skill / tool / issue /
│                              #   comment / conversation / chat-turn / run / report /
│                              #   verdict / action / artifact / audit / inbox）
    ├── log/<collection>.jsonl.snapshot   # 压缩后的物化快照
    ├── blobs/<前两位>/<sha256>     # 内容寻址：report 快照、artifact
    └── runs/<runId>/messages.jsonl        # 执行消息流
```

> **与早期草案的一处偏离**：草案里还有一个 `<数据目录>/runs/<runId>/run.json`。
> 实现时去掉了它——run 记录已经以追加记录的形式存在于 `log/run.jsonl`，
> 再存一份就成了**双份真相**，迟早不一致。`runs/<runId>/` 只放消息流。
>
> 另外把 workspace 记录提到根目录的 `workspaces.jsonl`：否则
> `getWorkspace` 必须先打开那个 workspace 的目录，形成循环依赖。

| 机制 | 做法 |
|---|---|
| 记录格式 | 每行 `{ seq, at, op: 'put'\|'patch', id, value?/patch? }`；回放时 put 覆盖、patch 合并 |
| 崩溃安全 | 追加写 + `fsync`；重启时**先读快照、再回放增量日志** |
| **patch 必须是绝对赋值** | 崩溃后可能重放已应用的记录；自增会被应用两次 |
| 尾部半行 | 解析失败的行直接跳过——这正是追加写的好处：只丢最后一条 |
| 原子性 | 单进程内以 `Mutex` 串行化写；快照与 blob 用"写临时文件 + `rename`" |
| CAS | `transitionRun` = 加锁读 → 校验前态 → 追加。数据库上等价于 `UPDATE … WHERE status = expect` |
| 去重 | blob 按内容 sha256 寻址，`putBlob` 天然幂等——`FR-REPORT-03` 的去重键由此免费获得一半 |
| 压缩 | `compact()` 先 fsync 快照、**再**丢弃日志；顺序颠倒会同时丢掉两者 |
| 唯一性索引 | report 去重键与 action 幂等键的索引**从日志推导**，不单独持久化（避免不一致） |
| 预加载 | 启动时按 `workspaces.jsonl` 预加载全部 workspace——跨 workspace 查找依赖它 |
| 格式版本 | `meta.json.formatVersion`；高于程序支持则**拒绝打开**并给出可读原因 |
| 并发明示 | 只保证单进程原子性；**跨进程访问同一数据目录不受支持**（FR-STOR-06） |

**两个容易踩的坑，已在代码里处理**：

1. **懒加载会让数据"看起来丢了"**。`getAgent` / `getRun` / `findReportByDedupKey` 都是跨 workspace 查找，遍历已加载的 store。若 store 是懒建的，重开进程后查找会全部返回 null——而数据好好躺在日志里。
2. **替换私有方法访问会破坏封装**。所有状态变更都必须走端口的 CAS 方法，不允许出现"先 get 再 set"的写法——那样在并发下必然出错。

---

## 4. 数据模型

### 4.1 实体关系

```
workspace ──┬─< agent >──┬─< agent_skill >── skill
            │            └─< run
            ├─< issue >──┬─< comment
            │            └─< run            (run 可挂在 issue 上)
            ├─< report >─< run              (review run 审核 report)
            ├─< run >───┬─< verdict >── action
            │           ├─< artifact
            │           └─< run (自引用：派生关系)
            ├─< audit
            └─< skill_install               (来源与保存位置)

device                                      (本机设备标识，不是账号)
```

> **没有 `member`**：单用户模型——有账号，但没有组织、成员、角色。

### 4.2 核心实体字段

**Run**

| 字段 | 说明 |
|---|---|
| `id` | ULID（单调可排序，便于日志追加） |
| `kind` | `execute` \| `review` |
| `status` | 八态之一（§6.1） |
| `workspaceId` / `agentId` | 归属与执行者 |
| `subject` | **审核对象**：`{ type: 'issue'\|'report'\|'run', id }` |
| `trigger` | `assignment` \| `mention` \| `chat` \| `schedule` \| `third_party` \| `verdict_action` |
| `derivedFrom` | 由哪个 action 派生（INV-16）；根 run 为 null |
| `chainDepth` | 链路深度（INV-14） |
| `skillRefs` | 本 run 使用的 skill 的**标识与来源**（无版本、无指纹） |
| `attempt` / `maxAttempts` | 重试 |
| `workDir` | **使用者指定的工作目录**（D20） |
| `waitReason` | `waiting_local_directory` 时携带目标路径 |
| `sessionId` | 会话恢复所需 |
| `deliveryMode` | 这次投递用了哪一档（2026-09，可选）：**A** = ①② 走系统提示、③ 走用户消息；**B** = 三块合成一段。缺省 = 老数据。同一个模版在两个 runtime 上形状不同，而"两边都不报错"是这个仓库被咬过三次的形状——所以档位落库、日志里也写 |
| `usage` | token 与成本 |

**Conversation / ChatTurn**（D49）

| 字段 | 说明 |
|---|---|
| `Conversation.agentId` | **一个对话绑一个执行者，中途不换**（上文靠 `--resume`，而那个 session 属于某一个 CLI 进程） |
| `Conversation.skillIds` | 这个对话**额外带**的 skill（第一句话定下来，只读）。选了挂在某人身上的 skill 时是空的——那种情况下 skill 由执行者自己带着；有值说明选的是**没人挂**的那条（见下一节）。老记录没有这个键 ⇒ 解析成 `[]`（"没有额外 skill"，不是"未知"） |
| `Conversation.workDir` | `string \| null`：null = 自动分配 `<workRoot>/chat-<id>`（界面上的词是「自动分配」），非 null = 使用者指定（把它接进某个真仓库）。⚠️ **不是隔离**——claude 以 `bypassPermissions` 跑，沙箱是 daemon 的全局开关、默认 `none`，专属目录只是缩小误伤面 |
| `Conversation.lastTurnAt` / `turnCount` | 列表按 `lastTurnAt ?? createdAt` 倒序（最近说过话的在最前） |
| `ChatTurn.seq` | 从 1 递增，每轮一条 |
| `ChatTurn.userText` | 使用者那一句，原样 |
| `ChatTurn.runId` | **可空**：提交失败（没抢到并发位、进程起不来）时留 `null`，由 `error` 说明原因——"我说过这句"这件事仍然看得见 |
| `ChatTurn.error` | 提交期的失败原因；run **自己**的失败记在 run 上，不在这儿重复 |

**「新对话」那个下拉里，`Conversation.skillIds` 记什么、不记什么**

使用者要的是一句话："选 skill 就等于和有这个 skill 的执行者对话"，**而且"所有已安装的 skill 都要能选"**。两句话合起来意味着两条路，区别只在一件事：**这条 skill 有没有主人**。

| 选的 skill | 绑谁 | `Conversation.skillIds` | 为什么 |
|---|---|---|---|
| 挂在某个执行者身上 | **那个执行者** | `[]`（空） | 性格与 skill 同源；skill 由执行者自己带着，不必重复记一遍 |
| 没人挂 | **你当前选的那个人**（没选过就是平台默认执行者） | `[这条 skill]` | "有它的执行者"不存在，只能由这次对话自己带着它 |

于是**每一轮的注入 = 执行者挂的 ∪ 对话带的**（`apps/daemon/src/chat.ts` 的 `loadTurnSkills`）。是并集、不是替换：执行者身上那些是"它是什么"的一部分，被对话那份盖掉就等于使用者只挑了一条 skill，把执行者的能力悄悄削了——而界面上不会有任何地方显示少了什么。

其余几条约定：

- 规则全在 `apps/web/src/lib/chat.ts` 的 `executorChoices` / `applyChoice` 里，由 `chat.test.ts` 钉住，界面里不许再写一份；
- 只认 `role: 'executor'`——审核者不能被选来聊天（聊天不产出判决），因此**挂在审核者身上的 skill 也算"没人挂"**；
- 一个 skill 被多个执行者挂着时，优先**平台默认执行者**，否则取列表里第一个；
- 选了一条没人挂的 skill 时**不动你已经选好的执行者**（否则"文章写作 + 某条 skill"会被换成"助手 + 那条 skill"，而这是他没同意的替换）；反过来，选执行者会把 skill 清掉（人已经是那一次的选择了）；
- 一个执行者都没有时**不给 skill 选项**——那些选项最后都要落到某个人身上；
- 选了 skill 之后界面上要写出「将使用谁」：有主时说"它挂着这条 skill"，没主时说"这条 skill 跟着这个对话走"。不写出来，使用者以为只加了一个能力包，实际上连人设也可能一起换了；
- `skillIds` **只读**：`POST /api/conversations` 收它，`PATCH` 不收——与"一个对话绑一个执行者、中途不换"同一个口径。对话头部把它显示出来（"之后只能看"）。

**「工作目录的文件」那一栏：任务页与聊天共用一份**（D49 ⑪）

任务详情右边那一栏（跑完之后左边结论、右边产出文件）与聊天右栏底部那一栏是**同一个组件**（`components/WorkDirTree.svelte`），差别只有"问谁"：

| | 按什么问 | 服务端目录 |
|---|---|---|
| 任务详情 | `GET /api/runs/:id/files` | `run.workDir` |
| 聊天 | `GET /api/conversations/:id/files` | `conversation.workDir ?? resolveWorkDir(...)` = `<workRoot>/chat-<id>` |

聊天这条路由**必须存在**：一个对话可能还没有任何 run（刚建起来、或第一句话没跑起来），而它的目录属于**对话**、不属于某一条 run。

几处刻意的取舍：

- **目录用 `resolveWorkDir` 算**，与出 run 时同一个函数。界面上显示的路径与它真正干活的路径必须是同一个——两处各算一次迟早分叉，而分叉的表现是"这一栏列的是别的目录里的东西"。
- **一次只列一层**，点开目录才取下一层：递归会把 `.claude/skills/x/templates/viewer.html` 这种一长串路径带出来，淹掉真正的产出。
- **顺序在界面侧**（`sortWorkDirEntries`：产出在前、注入物在后）。服务端返回目录自己的顺序——把顺序也放在服务端，等于两处都声称自己负责它。
- **`exists` 与"空的"分开**：目录**还不存在**（对话第一轮之前）与"存在但里面什么都没有"都是空列表，而那两句话给出的下一步完全不同（"再等等" vs "它确实没产出"）。所以这个事实由服务端给，界面不猜。
- **默认收起**，头部那一行常驻并写出「N 项」；树一直挂着（收起时只是藏起来），因为条数只有它知道。展开时缩的是上面的消息区，**输入框原地不动**——放在输入框下面的话，一展开就把正在打字的那个框顶上去。
- **跑完刷一次 + 一个「刷新」按钮，跑的过程中不轮询**：消息流已经在给实时日志（那回答"它在做什么"），这一栏回答的是"现在有什么"；让它自己抖动起来，两个都会变得不可信。
- **草稿态不画这一栏**（还没有对话，也就还没有目录）；**旧 daemon** 上画出来但把原因写在里面（`Capability.ConversationFiles`）——任务页那次实测撞过 404 被画成骨架屏，"取不到"与"还在加载"长得一模一样。
- **措辞不许写成"这次动了什么"**：这一栏会列出 **agent 自己写的文件**，那不是平台动作。聊天仍然不产出判决、因此不触发任何登记过的动作。

**文件查看器：「原文」是一个承诺，不是一种样式**（D49 ⑫）

点一个文件不再跳新标签页，而是在这一页打开查看器，标题栏是「路径 · 大小 · `渲染 | 原文` · 复制原文 · 新标签页打开」。

「原文」的定义是死板的:**服务端 `/file` 发回来的那串字节，按 UTF-8 解出来的文本**——不格式化 JSON、不重排 CSV、不加行号、不加颜色。唯一动过的一层是浏览器必须转义 `< > &`。所以「渲染」那一面**只许加标记、不许改字**：Markdown 渲染成文档、代码套一层 `<span>`，一个字符都不动。布局探针会**自己再 fetch 一次接口**，与「原文」面逐字比对——格式化、重排、去掉空行都会让它红。

| 文件 | 「渲染」这一面 | 「原文」这一面 |
|---|---|---|
| `.md` | 渲染成文档（相对图片按**这个文件所在目录**解析） | 源码 |
| `.html` / `.pdf` | `<iframe sandbox="allow-scripts">` | 源码（pdf 没有这一面） |
| `.json` | 格式化 + 着色（解析不了就明说，按原文显示） | 源码 |
| `.csv` | 表格（RFC4180 最小集：引号里的逗号与换行不算分隔符；不做类型推断） | 源码 |
| `.py .js .ts .sh .yml` 等 | 着色 **+ 行号** | 无着色、无行号 |
| 图片 | `<img>` + 大小 | 没有这一面（按钮不画） |
| 未登记类型 | 说明它是什么 + 前 512 字节十六进制 | 同左（二进制没有"渲染"） |

几处取舍：

- **iframe 沿用文件响应自己的 CSP**（`sandbox allow-scripts`、**没有** `allow-same-origin`），与"在新标签页打开"完全同一套属性——就地看只省一次跳转，安全边界一个字不放宽。探针**直接读 `sandbox` 属性**并在行为上量"父页面读不到它的 document"。
- **着色只给认得出的语言**（`languageOf` 返回 `null` 就不着），绝不用 `highlightAuto` 猜一套错的配色——那会显得很权威而实际是错的。
- **超过 256 KB 不着色**，原文照旧完整，并说明原因：给 8MB 文本套高亮会把页面卡死，而使用者只会以为这一栏很慢。
- **二进制不当文本渲染**：解出来带 NUL 就按二进制走（扩展名会说谎），只给说明与十六进制。
- **只读**：这一轮不做编辑。想在目录里落笔，正确的形状是一条登记过的动作（可回滚、进审计），而不是查看器里多一个 Ctrl+S——那会让"聊天这条路到不了动作"这个结构事实变成假话（那条边界本身仍然成立，只是 2026-09 起页面上不再常驻一句话去说明它）。

**「取消」必须真的丢弃草稿**（设置抽屉里那次"内容没恢复"）

使用者的原话：「我修改了内容，没有保存直接点关闭或者取消后，重新打开，内容没有恢复保存前的内容」。实测确实如此（改到 238 字符、关掉、重开——还是 238）。

根因是那个"初始值只取一次"的开关（`WorkspaceSettings.svelte` 的 `seeded`）**只被设成 true、从来不重置**：第一次打开之后它永远是 true，于是"取消/关闭"之后再打开，框里留着的是上一次**没保存**的草稿。

而"只取一次"本身是**对的**（保存之后 store 会刷新，那一冲会让人以为自己写的东西没了）——所以修法是**每次打开重新取一遍**（关掉抽屉时把 `seeded` 与草稿一起清掉），不是去掉它。清空那两行还解决了一个小窗口：打开时那份配置还没取回来时，宁可显示占位符，也不要先闪一段上一次的残稿。

守卫由布局探针的 `agents.settingsDraftDiscarded` 承担：在真实页面上打开「设置」→ 往输入框里打字 → **不保存**直接 Esc 关掉 → 重开 ⇒ 内容必须逐字回到打开时那一份（⚠️ 已保存的值**可能是空的**——平台有默认模版时 `current.executeTemplate` 就是空串——所以判据是"回到那一份"，不是"非空"）。这条检查**不点保存**，所以服务端那份配置一个字都没变。撤掉修复，它当场变红（`0 → 21 字符，多出来的是上一次的草稿`）。

**一条样式把代码块折成了一行**（聊天里那次"换行没了"）

`styles/app.css` 里那条 `code { white-space: nowrap }` 是给**行内**代码写的（中文段落里不被压扁），而 `white-space` **会被继承**——它一路带进了 `pre > code`，于是整段代码被折成一行。实测：文字里 10 个换行都在，`<code>` 的 computed `white-space` 是 `nowrap`，那个 `<pre>` 只有 **47px** 高；补上 `pre code { white-space: pre }` 之后是 **228px**。

值得记一笔的是它**为什么难认**：症状看起来像**模型没写换行**。而渲染器（`lib/markdown.ts`）是对的——它老老实实 `body.join('\n')`，测试也钉着——错在一条给别的东西写的样式。同一个规则也影响任务详情的「最后结果」（同一个 `.markdown`），只是那边没被撞上。

现在的守卫有两层：渲染器那一侧由 `markdown.test.ts` 钉住"换行原样留在输出里"，界面上由布局探针钉住"**真的显示出来**"——探针在真实页面里插一段与渲染器产出相同的结构，量 computed `white-space` **与六行的高度**（只看 `white-space` 会漏掉"换成 pre-wrap 仍然没换行"这类情况，而使用者看到的就是高度）。把 `pre code` 那条规则撤掉，探针当场变红。

**Action**

| 字段 | 说明 |
|---|---|
| `type` | `ActionType`（闭合枚举，必须来自注册表） |
| `plane` | `local` \| `remote`——**由注册表决定，不由 verdict 决定**（INV-13） |
| `params` | 按 `type` 校验的载荷 |
| `status` | §6.3 |
| `idempotencyKey` | `hash(verdictId, type, params)`——重复触发落 `skipped` |
| `dryRun` / `result` / `error` / `rollbackRef` | 执行信息 |

**Artifact**

| 字段 | 说明 |
|---|---|
| `kind` | `report` \| `scorecard` \| `document` \| `other`（**无 `diff`**——不存在改代码） |
| `blobRef` | 内容寻址引用 |
| `summary` | 一行摘要 |

> **Verdict 与 Artifact 的分工**：verdict 回答"要不要放行"，窄且闭合；artifact 回答"发现了什么"，宽且自由。

**Report**

| 字段 | 说明 |
|---|---|
| `source` | 来源标识（哪一类第三方） |
| `dedupKey` | `sha256(source + externalId + contentHash)`，唯一（FR-REPORT-03） |
| `blobRef` | 不可变快照 |
| `ingestedAt` / `parser` | 摄取信息 |

### 4.3 不变量到实现的映射

| 需求 | 落地手段 |
|---|---|
| DR-1 report 不可变 | 一经写入，`blobRef` 与 `dedupKey` 不可变更 |
| DR-3 历史不被覆盖 | run / verdict 均为追加写；`index.json` 只物化"当前态" |
| INV-17 同一 agent 不自我竞争 | 受理时按 `(subject.id, agentId)` 排除已有进行中 run 的项（§8.3） |

---

## 5. 接口

### 5.1 两类接口

| | **本地接口** | **远端接口** |
|---|---|---|
| 位置 | 本机 daemon（`127.0.0.1:<固定端口>`） | 远端服务 |
| 消费者 | 同源页面 | **同一个页面** |
| 认证 | 无（同源） + `Host` 校验 | **token**（不是 cookie，见下） |
| 传输 | HTTP + SSE | HTTPS |
| 承载状态 | 全部工作数据（**权威**） | 账号、设定、目录、查询、记录 |

> ⚠️ **登录态必须用 token 而非 cookie**：本地页面是 `http://127.0.0.1`，`Secure` cookie 不会在 http 上发送。远端返回 token → 页面存 localStorage → 请求时带 `Authorization` 头。（`FR-AUTH-02`）

### 5.2 本地接口

> ⚠️ **所有业务端点都带 `/api/` 前缀**（只有 `/health` 是裸的）。这张表原来漏了前缀，
> 于是"照着文档试一下"会全部 404——按接口做事时以这里为准，别信记忆。

| 端点 | 方法 | 用途 |
|---|---|---|
| `/health` | GET | 存活与版本；不含敏感信息（**唯一不带 `/api/` 的**） |
| `/api/identity` | GET | `deviceId`、已探测的 runtime、协议版本与能力标志 |
| `/api/runs` | POST | 提交一个 run |
| `/api/runs` | GET | 列出本机进行中与近期的 run（重连后对账；带动作摘要） |
| `/api/runs/{id}` | GET | 单次查询 |
| `/api/runs/{id}/messages` | GET | 日志（`?since=<seq>`，不给或 `-1` = 全部） |
| `/api/runs/{id}/events` | GET（SSE） | 订阅消息流，支持 `?since=<seq>` |
| `/api/runs/{id}/cancel` | POST | 取消（终止进程树） |
| `/api/runs/{id}` | DELETE | **删一条 run 连同它派生的一切**（消息流 / verdict 与 action / artifacts / **引用它的对话轮次**）；审计与 blob **保留**。还在跑 ⇒ 409；别的 workspace ⇒ 404 |
| `/api/runs/{id}/artifacts` | GET | 取回产出物 |
| `/api/runs/{id}/verdicts` | GET | 这条 run 上的判决 |
| `/api/runs/{id}/audits` | GET | 审计记录 |
| `/api/conversations/{id}/files` · `/api/conversations/{id}/file` | GET | 对话工作目录的文件树 / 某个文件的内容（D49 ⑪⑫；与任务页共用 `WorkDirTree.svelte` / `FileViewer.svelte`） |
| `/api/issues/{id}/abandon` · `/api/issues/{id}/reopen` | POST | 人的两条出路（D47）：放弃会**取消还在跑的 run**；恢复回 `todo` |
| `/api/issues/{id}` | DELETE | **删一条任务连同挂它名下的一切**（它名下的 run——顺 `subject` 链，审核 run 也跟着走、评论、任务本体）；先取消仍在跑的 run，inbox 通知保留。任务列表每项右侧的「×」走它 |
| `/api/skills/local-dirs` | GET/PUT | 勾了哪些**本机技能目录**（读别的 AI 工具的 `skills/`；PUT 重扫并回报 added/updated/removed） |
| `/api/agents/{id}/review-standard/adopt-from-skills` | POST | 把老形态的判断依据**并进「指令」**并摘掉挂载（D38；2026-09 起落点是 `instructions`） |
| `/api/runs/{id}/files` · `/api/runs/{id}/file` | GET | 某条 run 工作目录的文件树 / 文件内容（查看器用） |
| `/api/conversations` · `/api/conversations/{id}` | GET/POST/PATCH/DELETE | 聊天：对话（**由第一句话诞生**）、轮次、工作目录；删对话**连同轮次**，但那一轮的 run 一个都不动（D49） |
| `/api/conversations/{id}/turns` | POST | 说下一句（一轮 = 一条 execute run，`reviewerAgentId: null`） |
| `/api/agents` · `/api/agents/{id}` | GET/POST/PATCH/DELETE | 智能体（含 `allowedActions`、`actionParams`；`reviewStandard` 是**老数据的兼容字段**——只剩读取，保存时会被并进「指令」并清空。⚠️ `toolIds` 已随挂载能力一起删掉） |
| `/api/agents/default` | PUT | 默认执行者（D36，全局单值） |
| `/api/skills` · `/api/skills/{id}` | GET/POST/DELETE | 技能（**卸载**在 DELETE，D38） |
| `/api/skills/install` | POST | 装技能（本地目录 / GitHub 地址 / 远端目录，D38） |
| `/api/tools` | GET/POST/DELETE | 工具包（一个包 = 一个组，D40） |
| `/api/issues` · `/api/reports` · `/api/inbox` | GET/POST | 任务、报告、收件箱 |
| `/api/audits/export` | GET | 审计导出 |
| `/api/costs` | GET | 成本 |
| `/api/first-sentence/templates` · `/preview` | GET/PUT/POST | 第一句话模版与预览（D32） |
| `/api/workspace/locale` | PUT | 界面语言（D39，**挂在 workspace 上**） |

**为什么用 SSE 而不是 WebSocket**：本地接口是"页面单向订阅 + 少量命令"的形态。SSE 更简单、自动重连、且**天然单向**，攻击面更小。

```ts
// POST /api/runs
interface SubmitRunRequest {
  runId: string            // ★ 由调用方分配（FR-BRIDGE-07），daemon 以此实现幂等
  kind: 'execute' | 'review'
  agentRef: { id: string; name: string; instructions: string }
  skills?: SkillPayload[]  // ★ 可省略：省略时 daemon 按该 agent 的配置解析（不硬编码 []）
  subject: SubjectRef
  prompt: string
  workDir?: string         // ★ 可省略（D27）：省略时按任务自动分配 <workRoot>/<subjectType>-<subjectId>
  agentDefaultWorkDir?: string
  limits: { maxTurns: number | null; timeoutMs: number | null }
  // D42：这一次的覆盖（省略 = 跟随长期配置）
  reviewerAgentId?: string | null
  allowedActions?: string[]
  actionParams?: Record<string, Record<string, unknown>>
}

// SSE 事件
type RunEvent =
  | { t: 'status';   seq: number; status: RunStatus; at: number }
  | { t: 'message';  seq: number; message: RunMessage }
  | { t: 'progress'; seq: number; summary: string; step: number; total: number }
  | { t: 'usage';    seq: number; usage: Usage }
  | { t: 'terminal'; seq: number
      status: 'completed' | 'failed' | 'cancelled'
      result?: RunResult
      error?: { code: string; message: string } }
```

**`seq` 由 daemon 本地单调递增**，页面据此做补齐与去重，**不依赖时间戳**。

> ⚠️ `workDir` 从"必填"改成了"可省略"（D27）：它原来出现在这张表的请求体里**没有问号**，
> 而今天**省略才是默认路径**——绝大多数任务只是"让 agent 做点事"，不该逼使用者先想一个
> 目录。显式给出是"把 agent 接进我的仓库"这类高级用法，代价是使用者自己承担同目录串行化
> 的后果（FR-RUN-04）。

### 5.3 远端接口（要点）

| 端点 | 用途 |
|---|---|
| 账号与设定 | 登录、登出、读写用户设定（轮询间隔、上报开关等） |
| 能力目录 | 列出远端本地文件里的 skill/tool；下载内容 |
| 第三方查询 | 页面询问"本机有没有待处理项"；远端按需查询第三方 |
| 记录上报 | 提交统计与记录副本 |
| 排队 run | 页面取走属于本机 deviceId 的排队 run（以 CAS 保证不重复） |

### 5.4 版本与兼容

| 机制 | 做法 |
|---|---|
| 本地接口版本 | `/identity` 返回 `protocolVersion` + 能力标志 |
| **能力标志优先于版本号** | 版本号无法可靠回答"你实现了 X 吗" |
| 未知字段 | 解析时**忽略未知字段**而非报错 |
| 未知枚举值 | 消费方必须容忍未知值（FR-REVIEW-09 的前向兼容要求） |

> **同源带来的额外收益**：UI 与 daemon 一起升级 ⇒ **版本天然匹配**，"页面比 daemon 新/旧"这类协商问题基本消失。

---

## 6. 状态机

### 6.1 Run 状态机

```
                    ┌──────────┐
                    │ deferred │  定时未到点
                    └────┬─────┘
                         │ 到点
                         ▼
   ┌────────┐      ┌──────────┐      ┌────────────┐      ┌─────────┐
──▶│ queued │─────▶│dispatched│─────▶│  running   │─────▶│completed│
   └────────┘      └────┬─────┘      └─────┬──────┘      └─────────┘
        ▲               │                  │
        │               │ 目录被占用        │ 出错
        │               ▼                  ▼
        │      ┌──────────────────────┐  ┌────────┐
        │      │waiting_local_directory│  │ failed │
        │      └──────────┬───────────┘  └────────┘
        │                 │ 目录释放
        └─────────────────┘
                         │
        任意态 ──────────┴──────▶ cancelled
```

| 转移 | 触发 |
|---|---|
| `deferred → queued` | 调度器到点 |
| `queued → dispatched` | 页面把 run 交给 daemon；daemon 落盘并受理 |
| `dispatched → running` | daemon 上报 `start` |
| `dispatched → waiting_local_directory` | 发现工作目录被占用，停放并携带 `waitReason` |
| `waiting_local_directory → queued` | 目录释放，重新排队 |
| `dispatched/running → completed \| failed` | daemon 上报终态 |
| `* → cancelled` | 使用者取消 |

**三条语义**：

1. `completed` 只表示**这次 run 结束了**，不代表 issue 完成。
2. 改变 issue 的指派人或状态**不得**停止已启动的 run。
3. **长时运行不被墙钟终止**（FR-RUN-08）——活性判据见 §6.4。

### 6.2 Verdict 生命周期

```
pending_verdict → emitted → validated → (dispatched_to_action | advisory | escalated | rework_requested)
                          ↘ invalid   → (retry | downgrade_to_advisory | escalate)
```

**`validated` 的四条去向（D45）**：`pass` ⇒ `dispatched_to_action` / `advisory`；
`fail` 且有返工额度 ⇒ **`rework_requested`**（返工 run 已派出，这是**终态**）；
`fail` 且没额度 ⇒ `escalated`（交给人）。**`fail` 永远不走 `dispatched_to_action`**——
它不带处置动作。

> ⚠️ **`emitted` 这一档实际从没被写过**：判决是先切 JSON、校验、再用 `insertVerdict`
> 落**一条**记录，落库状态由 `statusFor(decision)` 直接给 `validated` / `invalid`。
> 真正会被写的只有 `validated` / `invalid` / `dispatched_to_action` / `advisory` /
> `escalated` / `rework_requested`（D45：`fail` 且有返工额度时落这个终态），以及重试期间借用的 `pending_verdict`（`invalid → pending_verdict → invalid`，
> 见 `docs/runtime/pipeline.md` §0.4）。

**`invalid` 是独立失败类型**（FR-REVIEW-05），不得与执行失败混同。三条处理路径都必须**带结构化 reason_code**，且**不得静默丢弃**。

### 6.3 Action 生命周期

```
proposed ──┬──▶ auto_approved ──▶ executing ──┬──▶ executed
           │                                   ├──▶ failed
           │                                   └──▶ rolled_back
           ├──▶ awaiting_approval ──▶ …          （人批准后进入 auto_approved）
           └──▶ skipped                           （幂等键命中）
```

**默认路径是 `auto_approved`**（INV-4）。`awaiting_approval` 是例外，且只能由 skill 显式声明触发（INV-6）。

### 6.4 长时运行与"在线"的含义

**① 长时 run 绝不被墙钟终止**

| 判据 | 行为 |
|---|---|
| 最近有输出或工具调用 | 继续跑 |
| 无活动，未超 `agentIdleWatchdog`（默认 2h） | 继续跑 |
| 无活动且超过 `agentIdleWatchdog` | 终止，记 `failure_reason: idle_timeout` |
| **总运行时长** | **不作为终止依据** |

**② "在线"的含义**

| 概念 | 含义 |
|---|---|
| 机器在线 | **页面是否开着**（页面开着 = 可以接活） |
| 排队 run | **一直等**，不设过期 |
| 关闭页面时正在跑的 run | **继续跑完**（daemon 本地权威） |

> 语义简单且诚实：**页面开着就代表这台机器能接活，关了就显式显示"不在派发新 run"**。

---

## 7. Verdict schema 设计

### 7.1 全局结构（D2：全局统一）

```ts
// packages/protocol/src/verdict.ts
export const Verdict = z.object({
  schemaVersion: z.literal(1),
  conclusion: VerdictConclusion,          // 闭合枚举
  reasonCode: ReasonCode,                 // 闭合共享枚举
  confidence: z.number().min(0).max(1),
  findings: z.array(Finding).max(100),    // ← 唯一开放处
  action: ActionRef.nullable(),           // type 必须来自注册表
  escalateReason: z.string().max(500).nullable(),
}).superRefine((v, ctx) => {
  // ⚠️ 这里原来写成一条 `.refine`，判据是"不是 needs_human ⇒ 必须有 action"——
  //    那等于要求 **fail 也必须给 action**，与 D45 正好相反（而它的报错文案却写着
  //    "fail 不得给出 action"：判据与文案互相矛盾，照文档写代码的人只会抄到错的判据）。
  //    实现是 `packages/protocol/src/verdict.ts` 里的三条规则：
  if (v.conclusion === 'needs_human' && (v.escalateReason === null || v.escalateReason.trim() === ''))
    ctx.addIssue({ message: '结论为 needs_human 时必须给出 escalateReason，不得留空' })
  if (v.conclusion !== 'needs_human' && v.escalateReason !== null)
    ctx.addIssue({ message: 'escalateReason 只在结论为 needs_human 时允许非空' })
  if (v.conclusion === 'fail' && v.action !== null)
    ctx.addIssue({ message: 'fail 不得给出 action（D45：它会被交回执行者重做，处置动作只属于 pass）' })
})

export const Finding = z.object({
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  summary: z.string().max(500),
  evidence: z.array(EvidenceRef).max(20),                  // 必须能指回输入快照
  detail: z.record(z.string(), z.unknown()).optional(),     // ★ 唯一开放处
})

export const ActionRef = z.object({
  type: ActionType,                         // 闭合：注册表键
  params: z.record(z.string(), z.unknown()) // 按 type 二次校验
})
```

**注意 `ActionRef` 里没有 `plane`**——执行端由注册表决定（INV-13）。

### 7.2 「一开一合」的边界（FR-REVIEW-10）

| 位置 | 闭合/开放 | 为什么 |
|---|---|---|
| `conclusion` | **闭合** | UI 分组、统计、门控都依赖它 |
| `reasonCode` | **闭合** | 见 §7.3 |
| `finding.severity` | **闭合** | 优先级排序与升级策略依赖它 |
| `finding.evidence` | **闭合** | 必须能指回输入快照，否则判决不可追溯 |
| `action.type` | **闭合** | 必须是已安装工具包声明过的动作（`<包 slug>.<动作名>`）——⚠️ D41 起**没有内置动作**，那条"动作注册表"已经删掉了 |
| `finding.detail` | **开放（唯一）** | 领域多样性由此承载 |
| `artifact` | **开放（在 verdict 之外）** | 大体积、自由结构的内容走 artifact |

**判定标准**：一个字段该闭合还是该开放，看**是否有第二个消费方需要理解它**。需要 → 闭合；只有产出者与人类读者关心 → 开放。

### 7.3 ReasonCode —— 闭合共享枚举

```ts
export const ReasonCode = z.enum([
  // 通过
  'meets_criteria',
  // 未通过：质量类
  'missing_tests', 'failing_tests', 'style_violation',
  // 未通过：正确性
  'logic_error', 'type_error', 'broken_reference',
  // 未通过：安全类
  'known_vulnerability', 'secret_exposed', 'unsafe_permission',
  // 未通过：范围
  'scope_creep', 'out_of_scope',
  // 无法判定
  'insufficient_context', 'conflicting_criteria', 'criteria_not_applicable',
  // 系统
  'internal_error',
  // 人工裁决（D46）：是"人看过并作了决定"，不是"系统出错"——两者在统计上要分得开
  'human_decision',
])
```

三条纪律：

1. **必须是枚举，不能是自由字符串**——否则同一含义会漂移出十种写法，导致无法统计、分组与写升级策略。
2. **新增类别要改协议并升版本**——刻意制造的摩擦，逼作者想清楚"这真的是一类新原因吗"。
3. **不得泄露对象是否存在**（FR-REVIEW-13）：需要表达"无权访问"时统一用 `insufficient_context`，不得用两种不同的码，否则可被枚举探测。

### 7.4 为什么 skill 不能自定义 schema

| 若允许自定义 | 后果 |
|---|---|
| UI | 需为每个 skill 写渲染器 |
| 动作派发 | 需适配任意形状，注册表失去意义 |
| 审计 | 无法跨 skill 聚合 |
| 比较 | 同一对象前后两次审核无法直接比较 |
| 演进 | 每个 skill 各自版本化，组合爆炸 |

因此 skill 只声明三样：**审核标准、可调用的动作子集、升级条件**（FR-REVIEW-11）。（⚠️ D37 把审核标准搬到审核者身上、D40 收口又把动作子集也搬了过去——这两样都不再属于 skill，见 §15.28/§15.29；这一段留作历史。）

### 7.5 逃生通道：Verdict vs Artifact

当一个 skill 的产出无法用 `pass` / `fail` / `needs_human` 表达时（评分、长报告、清单），**正确做法不是放开 schema**：

| | Verdict | Artifact |
|---|---|---|
| 回答 | 要不要放行 | 发现了什么 |
| 形状 | 全局统一、闭合 | 自由、可任意大 |
| 体量 | 小（KB 级） | 大（MB 级） |
| 消费方 | 系统 + 人 | 人（以及下游 agent） |

该 skill 仍产出合规 verdict，把详细内容放进 artifact 并在 `finding.evidence` 中引用。

### 7.6 版本化策略

| 变更 | 处理 | 消费方要求 |
|---|---|---|
| 增加可选字段 | 同版本 | 无 |
| 增加枚举值 | 同版本 | **必须容忍未知值** |
| 改语义 / 删字段 / 收紧约束 | **升 `schemaVersion`** | 必须提供并存期 |

---

## 8. 本地 Daemon

### 8.1 三个职责

| 职责 | 说明 |
|---|---|
| **本机服务** | 托管 UI 静态资源；在回环固定端口上接受同源页面请求（§5.2） |
| **run 执行器** | 建工作目录 → 注入技能与上下文 → 起 CLI → 流式回报 |
| **本地状态权威** | 持久化工作数据与进行中 run 的状态与消息 |

**daemon 不做的事**：不发起对远端的请求、不持有远端凭据、不做权限判断。

### 8.2 受理与幂等

```
页面                                  daemon
  │── POST /runs { runId, … } ───────▶│
  │                                   │ 1. 校验 Host
  │                                   │ 2. 按 runId 查本地状态
  │                                   │    ├ 已存在 → 直接 202（幂等）
  │                                   │    └ 不存在 → ★ 落盘后再返回
  │◀─ 202 { runId, acceptedAt } ──────│
  │                                   │ 3. 取并发槽位（先占槽再执行）
  │                                   │ 4. 建工作目录 + 注入 + 起 claude
  │── GET /runs/{id}/events ─────────▶│
  │◀─ SSE 流 ─────────────────────────│
```

**为什么 `runId` 由远端分配**：它让"重复提交"成为可幂等的操作。

**顺序不可颠倒**：校验 → 落盘 → 返回 202 → 再执行。

### 8.3 并发与先占槽

| 参数 | 默认 | 说明 |
|---|---|---|
| `maxConcurrentRuns` | 20 | 本地信号量 |
| **同一工作目录串行化** | — | 已有 run 占用时，新的进入 `waiting_local_directory`（D20） |

**先占槽再执行**（FR-RUNTIME-04）：取不到槽位就**不返回 202**，而是返回 `429` + `retryAfterMs`。

### 8.4 本地状态持久化

见 §3.4 的目录结构。要点：

| 事件 | 行为 |
|---|---|
| 页面刷新 | daemon 不受影响；页面以 `?since=<seq>` 补齐 |
| 关闭页面 | run 继续跑完，消息照常追加 |
| daemon 重启 | `running`/`dispatched` 的标为 `failed`（`daemon_restarted`）；已终态的保留 |
| 远端不可达 | 终态写入待提交队列，恢复后补交 |

> **为什么 daemon 重启后不自动续跑**：子进程已随 daemon 消失。诚实标记失败并让使用者重试，比假装还在跑要好。将来可用 CLI 的会话恢复做真正的续跑（M4）。

### 8.5 取消

取消由页面转发，**daemon 不做远端状态轮询**。daemon 在本地记录取消请求，因此页面刷新后取消意图不丢失。

### 8.6 凭据

| 项 | 设计 |
|---|---|
| daemon 持有的**远端**凭据 | **无** |
| daemon 落盘的凭据 | 无 |
| 登录态 | 由页面持有（localStorage token） |

### 8.7 进程树管理（NFR-P-05）

| 平台 | 实现 | 关键点 |
|---|---|---|
| Unix | 进程组（`detached: true` + `process.kill(-pid)`） | 必须整组终止，否则子进程成孤儿 |
| Windows | Job Object 语义（`taskkill /T /F` 作为可行基线） | Windows 上 `kill(pid)` **杀不掉进程树** |

```ts
// packages/agent-core/src/process-tree.ts
export interface ProcessHandle {
  readonly pid: number | undefined
  readonly process: ChildProcessSignals   // 诊断用：异步 'error' 事件
  readonly exited: Promise<ExitInfo>
  writeStdin(data: string): void
  endStdin(): void
  /** 终止整棵进程树。先温和后强杀。 */
  terminate(graceMs?: number): Promise<void>
  /** 最近一次输出的时间戳。活性判定用它，而不是总运行时长。 */
  lastActivityAt(): number
}

export function spawnProcessTree(input: SpawnInput): ProcessHandle
```

> ⚠️ **这里原来写的是一个 `ProcessTree` 接口**（`spawn` / `terminate` / `lastActivity`），
> 那是**设计时的草图，代码里从来没有这个名字**。实际形状是**一个函数 + 一个句柄**：
> `spawnProcessTree()` 起进程、返回 `ProcessHandle`。两个细节值得记：
> ① 活性判定是 `lastActivityAt()` 而不是"总运行时长"（长跑不等于卡住）；
> ② `handle.process` 是**故意暴露**的——`exited` 把同步抛出与异步 `'error'` 都压成
> `{code: null}`，ENOENT / EACCES 的真实原因会丢，要原因的调用方自己监听。

---

## 9. Claude Code 适配层设计

### 9.1 Runtime 描述表（FR-CLI-47 —— 本节最重要的一张表）

> ⚠️ 下面的接口快照是本节写作时的形态——字段后来扩充了（`kind` / `sessionState` /
> `versions` / `stateDir` / `baseArgs` / `promptDelivery` / `blockedArgs` / `managedFlags` /
> `systemPrompt`，且 cli-only 字段随 `kind` 分叉）。**当前权威定义**（真代码）见
> `architecture.md` §6.2 与 `../runtime/runtime-framework.md` §2；本节只留"为什么"。

```ts
// packages/agent-core/src/runtime-table.ts（快照：写作时形态，见上方 ⚠️）
export interface RuntimeDescriptor {
  key: string                    // 'claude' | 'generic'
  command: string                // 'claude' / 'agent-cli'
  family: 'claude-stream-json' | 'generic-ndjson'
  protocol: 'stream-json' | 'acp' | 'jsonrpc'
  // 技能投递**能力**（不是目录名）：{kind:'directory',dir} 或 {kind:'none',reason}
  skills: SkillDelivery
  // 这里原来还有 `contextFile`（'CLAUDE.md'）——已随 D29 删除（§15.16）：
  // 我们不再往 CLI 认识的项目记忆文件里写任何东西。
  toolConfig: InjectionSlot      // 首版：disabled
  disableSwitch: InjectionSlot   // 首版：disabled
  resume: { flag: string; rejectDetectable: boolean }
  /** ★ 证据等级——**未验证的 runtime 不得被当成已验证**。 */
  evidence: 'verified' | 'provisional'
  /** `evidence` 不是 `verified` 时，说明缺什么证据。 */
  evidenceNote?: string
}

export const RUNTIMES: Record<string, RuntimeDescriptor> = {
  claude: {
    key: 'claude',
    command: 'claude',
    family: 'claude-stream-json',
    protocol: 'stream-json',
    skills: { kind: 'directory', dir: '.claude/skills' },
    toolConfig:    { enabled: false, reason: '首版不做 MCP（范围决策）' },
    disableSwitch: { enabled: false, reason: '首版不做技能禁用策略' },
    resume: { flag: '--resume', rejectDetectable: true },
    evidence: 'verified',        // 逐字段对照过真实 CLI 的输出
  },
  generic: {
    key: 'generic',
    command: 'agent-cli',
    family: 'generic-ndjson',
    protocol: 'stream-json',
    skills: { kind: 'none', reason: '…' },   // 取决于那个 CLI 有没有技能发现机制
    resume: { flag: '--resume', rejectDetectable: false },
    evidence: 'provisional',     // 落地时**没有可运行的真实 CLI 可对照**
    evidenceNote: '字段名按公开文档的形状写，尚未在真实 CLI 上跑过',
  },
  // codex：第三个 runtime，**service 形状**（`codex app-server` + JSON-RPC）——
  // 见 docs/runtime/codex-runtime-design.md 与 packages/agent-codex/（当前表行在 runtime-table.ts）
}
```

> ⚠️ **表里现在有三行**（不是一行）：`claude`、`generic` 与 `codex`。加第二个 runtime 是一次
> 实测：目的是把"写死的 claude 形状"全找出来（§15.17）；加第三个（codex）实证的是
> **service 形状也能进同一张表、走同一台机器**——cli-only 字段随 `kind` 分叉后缺省即合法，
> 加载器按 kind 校验。`evidence` 这个字段就是那次加的——**等级写在数据里，而不是只写在
> 注释里**，因为注释不会出现在界面与审计记录上；不这样记，`generic` 那一行会和 `claude`
> 长得一模一样，而使用者无法分辨"已验证"与"猜的"。codex 现在是 `provisional`：
> 协议形状未对照真实 app-server 验证，核对清单在 `agent-codex` 的 `unverifiedFields()`。

**为什么现在就把禁用位写出来**：`enabled: false` 加一条 `reason` 使扩展点**可见且可评审**，而不是消失在"以后再说"里。

### 9.2 argv 组装

```
claude -p --output-format stream-json --input-format stream-json --verbose
  --permission-mode bypassPermissions --disallowedTools AskUserQuestion
  [--model <m>] [--max-turns <n>] [--resume <id>]
  <过滤后的使用者参数>
  [--append-system-prompt <系统提示：① 框架 + ② 身份>]
```

| 段 | 内容 | 归属 |
|---|---|---|
| 1 | 协议基础参数 | 平台，不可覆盖 |
| 2 | 受管可选参数（model / max-turns / resume） | 平台 |
| 3 | 使用者自定义参数（**已过禁改表过滤**） | 使用者 |
| 4 | 平台受管追加参数 —— **2026-09 起 A 档就靠它**：`--append-system-prompt`（① 框架 + ② 身份） | 平台，最后写 |

### 9.3 禁改参数表

```ts
export const CLAUDE_BLOCKED_ARGS = {
  '-p':                'standalone',   // 非交互模式
  '--output-format':   'withValue',    // stream-json 协议
  '--input-format':    'withValue',    // stream-json 协议
  '--permission-mode': 'withValue',    // 无人值守
  // 2026-09：系统提示由**平台**掌控（①② 两块走它）——使用者的自定义参数不许覆盖它
  '--append-system-prompt': 'withValue',
} as const
```

| 规则 | 说明 |
|---|---|
| 两种丢弃模式 | `standalone` 只丢参数；`withValue` 连值一起丢 |
| 记警告 | 丢弃时**必须**记日志（FR-CLI-12） |
| 动态加入 | 任何扩展位启用时，其受管参数必须自动加入本表（FR-CLI-11） |
| 声明式 | 新增一项必须是一行数据（FR-CLI-09） |

**为什么是表而不是文档约定**：表能在运行时执行，文档只能靠人记得。

### 9.4 上下文块注入算法（FR-CLI-26~30）

> ❌ **这一节已随 D29 删除（§15.16）**：下面描述的算法（三种文件状态、分隔符字节归属、
> 逐字节还原、两个畸形输入）**代码里已经没有了**。我们不再往使用者的 `CLAUDE.md` 写任何
> 东西——上下文改成"全部进第一句话 + 每 run 一份我们自己的副本"。
> 这一节留在这里只有一个用途：说明**为什么当初需要这么多机制**（写别人的文件，
> 只有"可回滚"和"数据损坏"两种结果），以及为什么最终把它整个删掉。

标记：

```
<!-- BEGIN ALPHA-HELPER (auto-managed; do not edit) -->
…受管内容…
<!-- END ALPHA-HELPER -->
```

**注入**：

```
inject(file, block):
  if 文件不存在:
      → 写入 block（★ 不加前置分隔符）
      → 记录 "本文件原不存在"

  raw = 读取(file)
  begin = raw.indexOf(BEGIN)
  if begin == -1:
      → 写入 raw + SEPARATOR + block
      → 记录 "追加了分隔符"          ← 分隔符字节属于受管区域

  end = raw.indexOf(END, begin + BEGIN.length)   // ★ 只在 BEGIN 之后找
  if end == -1:
      → 写入 raw.slice(0, begin) + block          // 半个块：延伸到末尾，原地替换

  → 写入 raw.slice(0, begin) + block + raw.slice(end + END.length)
```

**清理（逐字节还原）**：

| 注入时的记录 | 清理动作 |
|---|---|
| 文件原不存在 | **删除文件** |
| 追加过分隔符 | 删除 `[分隔符起点, END 末尾]`，其余逐字保留 |
| 原地替换 | 删除 `[BEGIN 起点, END 末尾]`，其余逐字保留 |

**两个畸形输入为什么必须处理**（FR-CLI-28）：

| 输入 | 朴素实现的后果 | 正确处理 |
|---|---|---|
| 使用者文件里有**孤立的结束标记** | 判定块无效 → 追加新块 → 孤立标记仍在 → **每次运行都追加，文件无限增长** | 只在开始标记之后查找结束标记 |
| 上次写入崩溃留下**半个块** | 找不到结束标记 → 走追加分支 → 再堆一个 | 视作块延伸到文件末尾，下次原地替换 |

> 参考材料记录了一个真实事故：早期版本无条件覆盖写，在"绑定本地目录"形态下第一次运行就**截断了使用者仓库里的 `CLAUDE.md`**。往使用者文件里写东西，只有"可回滚"和"数据损坏"两种结果。

### 9.5 技能注入

> **按 agent 求解**（★ D22 的硬约束）：同一 workspace 下不同 agent 挂载的 skill 集合**不同**，因此技能注入**必须在每个 run 上按该 run 的 agent 求并集**，不能"全局挂载一次"。这是多 agent 分工（FR-AGENT-12~19）能成立的前提。

| 项 | 设计 | 现状 |
|---|---|---|
| 落盘位置 | `<workDir>/.claude/skills/<slug>/SKILL.md`（+ 支持文件） | ✅ |
| **skill 集合** | **按 run 的 agent 求解**（agent 声明的子集 ∩ 可用 skill） | ✅ `Agent.skillIds` |
| **tool 集合** | —— | ⚠️ **已整个撤掉**（2026-09 收口）：`Agent.toolIds` 不在协议里、注入那一段（`syncInjectedTools`）已删、写入口也删了。工具包现在只能**安装 / 卸载**，它的动作由审核者的「行动权限」（`Agent.allowedActions`）授权——「挂给执行者、干活时送进工作目录」这条路不存在了 |
| 发现方式 | 靠目录摆对，走 CLI 原生发现 | ✅ 技能；⚠️ **工具不走发现**——CLI 不认识那个目录，工具靠**模型自己读**（第一句话里列了"有哪些、在哪儿"） |
| 权威名 | **slug**，改写 frontmatter 里的 name | ✅ |
| 残缺处理 | 缺 name → 注入；YAML 坏 → 重建并保留其他键（**特别是作者用于隐藏技能的键**） | ⚠️ **YAML 坏时只保留正文**：`frontmatter 无法解析，已重建（仅保留正文）`——坏掉的 YAML 解析不出键，所以"保留其他键"这一条在**坏的那条路上做不到**（能解析时是保留的） |
| 解析方式 | **用 YAML 解析器**，不用正则/词法扫描 | ✅ `yaml` 包的 `parse` |
| 上限 | 单技能 256 KiB | ✅ `MAX_SKILL_BYTES` |
| 哈希 | 覆盖来源 + ID + name + description + 正文 + 每个支持文件的路径与内容摘要 | ❌ **没有这个哈希**：代码里**不为技能内容算指纹**（`skillRefs` 只记 `{id, slug, source}`）。今天唯一的哈希是投递出去那句「第一句话」的 sha256（`promptHash`）——所以"这次用了哪份技能正文"**事后无法证明**（§11.2 已注明） |
| 派发 | 传引用，逐个拉取、独立缓存 | ✅ |
| **来源** | **由页面下载后交给 daemon**（daemon 不自己下载，FR-BRIDGE-08） | ⚠️ **daemon 会自己下载**：`packages/skill-source/src/skill-source.ts` 有 GitHub 主机白名单（`github.com` / `raw.githubusercontent.com` / `api.github.com`）、只允许 https、**每一跳跳转都重新校验主机**、以及单文件/总量/文件数/深度上限。技能来源因此是三种：本地目录 / GitHub 地址 / 远端目录 |

**审核类 skill 的额外要求（FR-CLI-43/44 —— 本项目特有，无先例可循）**

> ❌ **这一整段的落点已经搬走了（D37/D38）**：审核标准**不再住在 skill 里**，而是内联在
> 审核者身上（`Agent.reviewStandard`）；内置的 `general-review` skill 也删了，首启**不播种
> 任何 skill**。所以"审核类 skill"这个类别**不存在了**——skill 只剩"做事时参考什么"。
> 下面四条留作历史，其中**只有第 4 条仍然是硬规矩**：

1. ~~`SKILL.md` 中必须包含该 skill 的**审核标准**与**判决示例**~~ ⇒ 标准在
   `Agent.reviewStandard` 里；判决示例由**判决契约**给出（见下）；
2. ~~verdict schema 的权威定义**随 skill 一同下发**~~ ⇒ 权威定义在
   `packages/protocol/src/verdict.ts`，契约正文由 `renderVerdictInstruction()` 从 schema
   **生成**（枚举与示例都从 `z.enum(...).options` 来，所以改 schema 不会让指令漂）；
3. ~~上下文块的受管内容中给出明确的输出格式要求~~ ⇒ 受管块没了（D29），格式要求进
   **第一句话**，并且**放最末**（长跑里上下文会被压缩，最后读到的最不容易被摘要掉）；
4. **不得依赖模型自行猜测格式**，也**不得用正则在自由文本里捞 JSON**。 ✅ **这条仍然是
   硬规矩**——而且被两次真实失败加固过：契约里不写全枚举取值，模型只能猜，猜错就让
   **整条判决**作废（连它本来想说的结论一起丢）。

判决提取采用**约定围栏**：模型被要求把判决放在一对明确标记内，daemon 按标记做确定性切片后交给 schema 校验。校验失败即进入 §6.2 的 `invalid` 路径，而**不是**尝试"修一修再解析"。

### 9.6 任务级隔离

| 注入点 | 做法 |
|---|---|
| 工作目录 | **由使用者指定**（或一个默认空目录）；平台**不做仓库检出** |
| 配置/家目录覆盖 | 任务级 overlay，从使用者那份**播种**，使 CLI 原生发现技能 |
| 环境变量顺序 | 任务级覆盖必须在**使用者自定义环境变量之后**应用 |
| 临时目录 | 任务专属 |
| 同目录串行化 | 同一工作目录同时只允许一个 run（§8.3） |
| ~~仓库缓存 / worktree~~ | **不做**（D20） |

### 9.7 失败分级（FR-CLI-41）

| 类别 | 处理 | 理由 |
|---|---|---|
| **注入失败**（技能没写下去 / 上下文块写失败） | **run 失败** | agent 会以为自己没有该能力，从而绕路；静默的缺能力比报错更糟 |
| CLI 不可解析输出 | run 失败，附明确错误 | **不得静默失败**（FR-RUNTIME-07） |
| 判决 schema 不合规 | 独立失败类型，走 §6.2 | FR-REVIEW-05 |

### 9.8 「写入成功 ≠ 被读取」（FR-CLI-40）

> ❌ **这一节大部分没有实现，而且第 2 行已经不可能实现**（D29 把受管上下文块整个删了）。
> 留在这里是因为它记录了一个**真问题**，不是因为它描述了现状。

| 注入项 | 文档原设想的验证方式 | 实际状态 |
|---|---|---|
| 技能 | 在受管上下文中要求 agent 在首条消息回报它加载到的技能清单，与预期比对 | ❌ **没做**：受管上下文没了，"要求 agent 回报"这个通道也就没了。今天能确认的只是**文件确实写进了工作目录**（`已注入 N 个 skill：…` 那行日志 + 落盘清单）——**这不等于 CLI 真的加载了它** |
| 上下文块 | 受管内容里放一个校验句，要求 agent 回读一个随机 nonce；未回读即判定未加载 | ❌ **机制已不存在**（D29 删掉受管块）。**nonce / 回读在代码里一处都没有** |
| argv | 记录实际启动命令行到审计记录，便于事后比对 | ✅ **已实现**：`AuditRecord.argvRedacted`（已脱敏） |
| 第一句话（D29 之后的唯一通道） | —— | ✅ **可验证**：它**整段进 run 日志、不截断**（~~还留一份副本在 `.agentdeck/context/<runId>.md`~~ —— **已撤（2026-09）**，不再写副本，日志即唯一核对处）。这是唯一一条"送出去什么"能被逐字核对的路 |

> 这条的价值在于：**文件写成功、日志干净，是最常见的假成功形态**。参考材料里有一个
> 技能注入路径"从来没被读过"——文件写下去了，agent 一次都没加载，日志里没有任何异常。
> D29 之后这个风险**变小但没有消失**：第一句话是唯一通道且逐字可查，可"CLI 到底有没有
> 把它喂给模型"仍然只能靠它自己的输出间接判断。

---

## 10. 审核流水线

### 10.1 三种组合

```
S3（纯执行）   指派 ──▶ run(execute) ──▶ 产出报告/artifact ──▶ 人看
                                         （★ 不触发 Action）

S2（纯审核）   第三方 ──▶ 远端按需查询 ──▶ 页面取回 ──▶ run(review) ──▶ verdict ──▶ action

S1（执行+审核）指派 ──▶ run(execute) ──▶ 产出
                            │
                            └──▶ run(review) ──▶ verdict ──▶ action
                                                      │
                                                      └──▶ 新的 run(execute)（如"去修"）
                                                            ↑ 回路边界在此
```

> **Action 的唯一来源是 verdict**，而 verdict 只由 `review` run 产出。因此 **S3 不触发任何 Action**（D21）。`execute` run 的产出（报告）**不得**直接触发 Action——否则就把"执行即动作"这条口子打开了，动作的边界会失控。

**三者共用同一套执行原语与状态机**（SC-1）。差异只体现在：

| | `execute` run | `review` run |
|---|---|---|
| subject | issue | report 或上游 run |
| 终止契约 | 产出（artifact） | **schema 合法的 verdict** |
| 完成后触发 | 可自动接 review run | 动作派发 |

### 10.2 reviewer ≠ executor 的强制落地（INV-1~3）

```ts
function assertReviewerDistinct(reviewRun: Run, subject: Run | Report): void {
  if (subject.kind !== 'run') return              // 审核 report 时无此约束
  if (subject.agentId === reviewRun.agentId) {
    throw new ConfigError(
      'REVIEWER_MUST_DIFFER',
      `审核者与执行者不能是同一个 agent（均为 ${reviewRun.agentId}）。请指定不同的 reviewer agent。`
    )
  }
}
```

**校验位置**：run 创建时（而非执行时）——在**写入之前**拒绝。同时 UI 的 reviewer 选择器**默认过滤掉 execution agent**。

### 10.3 回路边界（INV-14~16）

> ⚠️ **这一节的机制在当前实现里没有调用点**（D41）：唯一会派生 run 的动作 `issue.assign_agent`
> 随内置动作一起删了，于是"派生 run"这条边不存在，深度与环检测都触发不到。域层的实现与测试
> **仍在**（不是删了），等回归路径定下来再接。下面这张表描述的是那套实现，不是今天会发生的路径。
> 幂等那一行仍然天天在用——它是动作执行的主路径，与派生无关。

| 机制 | 设计 |
|---|---|
| 最大链路深度 | `chainDepth` 超过 `maxChainDepth`（默认 5）→ 停止派生，转 `escalated` |
| 环检测 | 以 `(subject.id, agentId, reasonCode)` 的有序序列计算摘要；重复出现即判定成环 |
| 派生打标 | `derivedFrom` 记录触发它的 action id |
| 幂等 | `idempotencyKey = \`${verdictId}:${type}:${stableStringify(params)}\``（**字符串拼接，不是哈希**）；命中即 `skipped` |

**为什么幂等键要含 `verdictId`**：同一 verdict 重放应被去重；但**不同 verdict 产生相同动作不应被去重**（否则第二次真实发现会被吞掉）。

> ⚠️ 两个容易记错的细节：① **不是哈希**——就是 `verdictId:type:参数` 三段拼起来，
> 所以它在库里是可读的（排查时能直接看出是哪个判决的哪个动作）；② 参数必须走
> `stableStringify`（**对象键排序**），不能直接用 `JSON.stringify`——否则同一份参数
> 因键顺序不同会产生两个幂等键，去重就静默失效了。

---

## 11. 动作注册表与审计

### 11.1 两类 Action（D18）

| 类别 | 执行端 | 首版 |
|---|---|---|
| **本地 Action** | daemon | ✅ 做 |
| **远端 Action** | 远端的服务（形态与第三方接入同类） | ⬜ 留扩展位 |

**定义由已安装的工具包摊出来**（D41），平台**没有**注册表：

```ts
export interface ActionDefinition {
  type: ActionRefType               // `<包 slug>.<动作名>`——D41 起只有这一种形状
  plane: 'local' | 'remote'         // ★ 执行端（INV-13）；远端形态仍是扩展位
  params: z.ZodType
  supportsDryRun: boolean
  requiresApproval: boolean
  irreversible?: true
  scope: Scope
}
```

> ⚠️ **这里的旧形状已经改过两轮，别照着旧记忆写**：
> ① 它原来叫 `registry.ts`，里面真有一张表——那六个内置动作就是它（D41 全删，
>    文件改名 `definition.ts`：叫 registry 却没有注册表，是留给下一个读者的坑）；
> ② `idempotency: (p) => string` 与 `rollback?()` **不在定义里**：幂等键由调用点
>    自己拼（见 §10.3），回滚是按 `plane` 分的两套执行端的事；
> ③ `spawnsRun?: true` 随 `issue.assign_agent` 一起没了（唯一会派生 run 的动作）。
>
> 这个文件今天只剩两样**与实现无关**的东西：动作定义的**形状**，以及"这个动作允不
> 允许被触发"那一次成员判断——判据换来源时，它一行都不用改。

首版本地动作：

| type | 说明 | 可回滚 | 派生 run |
|---|---|---|---|
| `comment.create` | 发表评论 | 是 | 否 |
| `issue.update_status` | 改 issue 状态 | 是 | 否 |
| `issue.add_label` | 打标签 | 是 | 否 |
| `issue.create` | 创建 issue | 是 | 否 |
| `issue.assign_agent` | 指派 agent | 是 | **是** |
| `notify.emit` | 站内通知 | 否（标注） | 否 |

⚠️ **这张表已经不存在了（D41）**：内置动作**全部移除**，动作只能来自已安装的工具包
（`<包 slug>.<动作名>`）。连同 `issue.assign_agent` 一起消失的还有"**动作派生 run**"
这条边——于是"派生 run"这一列现在没有任何一行会填"是"，INV-14~16 的回路边界在当前
实现里没有调用点（那段实现与测试仍在域层留着，见 §15.29）。

**"未声明即拒绝"**：`action.type` 必须是**已安装工具包声明过的**动作，否则判决整体
判定为不合规，走 §6.2 的 `invalid` 路径——判据从"在不在那张表里"变成"**装没装**"。

### 11.2 审计记录

```ts
interface AuditRecord {
  id: string
  workspaceId: string
  runId: string
  // 输入
  subject: { type: 'issue' | 'report' | 'run'; id: string }   // ⚠️ 字段名是 `subject`，不是 `subjectRef`
  inputBlobRefs: BlobRef[]
  // 决策依据
  skillRefs: { id: string; slug: string; source: 'local' | 'remote' }[]   // 只有标识与来源（⚠️ 是 `slug`，没有 `name`）
  runtimeDescriptorKey: string
  cliVersion: string | null
  modelId: string | null
  promptHash: string | null
  argvRedacted: string[]           // 已脱敏的实际命令行
  // 输出
  verdictId: string | null
  actionIds: string[]
  // 时序
  queuedAt / startedAt / finishedAt: number | null
  usage: { inputTokens; outputTokens; costUsdMicros } | null
}
```

> ⚠️ **`contextBlockHash` 已经没有了**（D29）：那个字段记的是"受管上下文块的哈希"，
> 而受管块机制整个删掉了（§9.4）。今天的等价物是 `promptHash`——**投递出去那句
> 「第一句话」的 sha256**（§3.4 ④）。留在这里的旧字段名会让读者以为审计还记着一个
> 不存在的哈希。

**可追溯能力**：给定 `subject` + `inputBlobRefs` + `skillRefs` + `promptHash` + `cliVersion` + `modelId` + `argvRedacted`，即可重建当时给模型的**全部输入**。

> ⚠️ **但不能证明 skill 的具体内容**：因为不记指纹，只能确认"用了这个标识与来源的 skill"。因此对外表述应为"**可追溯**"，而非"完全可复现"。

**argv 脱敏**：令牌类参数在写入审计前替换为 `***`。

### 11.3 成本记录

`usage.costUsdMicros` 以**整数微美元**存储，避免浮点漂移。优先取 provider 上报的精确成本；仅在 provider 不提供时退回估算，并在记录中标注来源。

---

## 12. 远端能力

### 12.1 公共目录：工具包 + 技能推荐清单（D40 / D50）

- **工具包**（D40）：`apps/remote/catalog/tools/<slug>/`，仓库里带可装的范例。
- **技能**（D50，2026-10）：`tools/skill-catalog-sync/recommended-skills.json` 是
  **推荐清单**（只有 GitHub 链接与我们自己写的说明），维护者跑 `pnpm run sync-skills`
  （**独立工具**，`tools/skill-catalog-sync/`）把内容抓下来落进**一个目录**
  （默认 `~/.agentdeck/remote/catalog-skills/`）。`GET /api/catalog` 的 `skills`
  因此**可以为空**（还没同步过），但不再是"恒为空"。
  ⚠️ 工具与远端服务**没有代码依赖**：工具写目录、服务读目录，就这一条约定
  （2026-10 从远端的子命令改成独立工具，见 §15.34）。
- ⚠️ 有一条**仍然成立**的旧决定：公共目录里**不该有审核标准**。
  那条 `general-review@1.0.0` 已撤掉（D38：标准内联在审核者身上），
  测试里钉着它不该回来；推荐清单里也**不允许**出现"审核标准"这类东西——
  技能是可以装的**参考包**，不是判断依据的载体。

**远端无上传 / 发布功能**：它读取自己的本地文件来展示与分发，因此账号、权限、审核、签名这一整套问题**不存在**。

```
       页面                      远端                    daemon
         │                        │                       │
         │                        │  读自身本地文件        │
         │── 浏览 / 检索 ────────▶│  （运维者放文件）      │
         │◀─ 目录列表 ────────────│                       │
         │── 下载选定工具包 ─────▶│                       │
         │◀─ 内容 ────────────────│                       │
         │── 交给 daemon ────────────────────────────────▶│  落盘
         │◀─ 确认 ────────────────────────────────────────│
```

| 要点 | 设计 | 现状 |
|---|---|---|
| ~~不做版本管理、不记指纹~~ | 不检查更新、不升级、不比较新旧 | ⚠️ **已经比较版本了**：目录条目会按版本说「已安装」或「更新」（§15.11）。**不记内容指纹**这一条仍然成立（不比较新旧内容、不回滚） |
| 本地工具包共存 | 使用者自己装的与下载来的**并存** | ✅ |
| 同名冲突 | 确定的优先级 + 明确提示，不得静默覆盖 | ✅ `SkillCollisionError`——**注入时撞名会让 run 失败**（静默的缺能力比报错糟得多）。⚠️ 原来的 `ToolCollisionError` 随工具注入一起删了 |

### 12.2 第三方查询

```
第三方                    远端                    页面                daemon
  │                        │                       │                   │
  │◀─ ① 按远端支持的查询协议完成配置（一次性）──────│                   │
  │                        │  （远端保存该配置）    │                   │
  │                        │◀─ ② 页面定期问 ───────│                   │
  │◀─ ③ 远端按需查询 ───────│                       │                   │
  │── ④ 返回当前数据 ─────▶│                       │                   │
  │                        │── ⑤ 返回给页面 ──────▶│                   │
  │                        │                       │── ⑥ 转交 daemon ─▶│
```

| 特性 | 说明 |
|---|---|
| 方向 | **拉取**（页面主动），非推送 ⇒ 远端不需要"谁在线"的概念 |
| 存储 | **不暂存** ⇒ 不需要过期策略 |
| 水位 | **平台不管**，归适配器（D14）；平台靠 `report` 去重键保证正确性 |
| 代价 | 第三方需提供**可被查询的接口**；延迟 = 轮询间隔；第三方不可达时当次取不到 |

**可插拔适配层**（FR-REG-08/09）：首版只做一种最小形态，新增类型不改既有调用链。第三方是**围绕 agentdeck 的集成**，信任其账号体系 ⇒ **账号即凭证**。

### 12.3 记录与统计

| 上报内容 | 说明 |
|---|---|
| 用量与错误统计 | 计数类指标 |
| 工作记录副本 | issue / run / verdict / 动作的**摘要** |

| 规则 | 说明 |
|---|---|
| 身份 | **账号**（D11）；记录归属到账号，设备标识只表示"哪台机器" |
| 双用途 | 使用者自己看 + 项目方看；**给项目方的部分应聚合、去内容化**（FR-REG-14） |
| 可选 | 必须可关闭；关闭后本地功能完整可用 |
| 明示 | UI 与文档必须说明上报什么、去哪、以及远端记录不具证据效力 |
| 失败隔离 | 上报失败只本地暂存待重试，**绝不影响执行** |

---

### 12.4 report 解析器设计（**提议，待确认 —— 对应 Q3**）

> ⚠️ **这一节大半已经作废**：`kind` 路由（"按 `kind` 选 skill"）**在代码里没有了**——
> agent 不再声明它认哪些 `kind`，因此第 2 步与下面那段"为什么 `kind` 是关键"都不成立。
> 报告进来之后**不做 kind 路由**（`apps/daemon/src/ingest.ts` 里还留着一句引用 D24 的旧注释，
> 那是代码侧的清理项，不是现状）。留这一节是因为"报告怎么变成审核对象"这部分仍然有效。

> 这一节是**给出一个参考设计**供确认，不是已冻结的方案。

**协议最小形态**（FR-REG-05/07 —— 满足"传入账号即可"）：

```
远端 → 第三方
  POST <第三方登记时提供的地址>
  { "account": "<账号标识>", "cursor": <可选，第三方自定义> }

第三方 → 远端
  { "items": [
      { "externalId": "...", "kind": "...", "title": "...", "body": "...", "meta": {} }
  ] }
```

**每个 item 变成一个 `report`**。所谓"解析器"，首版只做**一件事**：

| 步骤 | 做什么 | 状态 |
|---|---|---|
| 1. 规范化 | 把 `title` + `body` 组装成审核对象文本；`meta` 原文保留 | ✅ 有效 |
| 2. ~~按 `kind` 选 skill~~ | ~~`kind` 决定用哪套审核标准~~ | ❌ **作废**：没有 kind 路由。审核标准由**审核者**带（`Agent.reviewStandard`，D37），报告进来之后走的是和别处一样的串接规则 |

~~**为什么 `kind` 是关键**：多 agent 分工（§9.4.1）要能落地，就必须有一种方式把"进来的东西"映射到"用哪套审核标准"。`kind` 就是这个映射键。~~

> 那段论证的前提是"审核标准住在 skill 里、需要按 kind 挑一个"。D37 把标准搬到审核者身上之后，
> 这个映射键就没有用武之地了——**派谁审**由执行者的「由谁审它」决定，不按 `kind` 分。

| `kind` 示例 | 建议映射到的审核模板 |
|---|---|
| `dependency-vulnerability` | 依赖漏洞审核 |
| `ci-failure` | CI 失败归因 |
| `pr-diff` | 代码变更审核 |
| `customer-feedback` | 反馈分类 |
| **（未知 kind）** | **走通用兜底模板** |

**首版实现范围（建议）**：

| 项 | 首版 | 理由 |
|---|---|---|
| 协议 | 上述最小 JSON 形态 | 满足"传账号即可" |
| `kind` | ✅ 支持，**未知 kind 走兜底模板** | 这是多 agent 分工的落点；兜底保证不因未知类型卡死 |
| `body` 结构化解析 | ❌ 不做，整段作为审核输入 | 让 agent 自己读 |
| 多来源格式 | ❌ 只做一种 | 留扩展位 |

**去重键**：`dedupKey = sha256(source + externalId + contentHash)`

- `externalId` 由第三方提供，用于识别"同一条"；
- `contentHash` 防止同一 `externalId` 内容变化后被误去重。

**✅ 已确认（C8）：`kind → skill` 映射配在本地 agent 配置里（甲）。**

**这带来一个很好的统一**：`kind` 同时是两个键——

| 作用 | 说明 |
|---|---|
| **路由键** | 决定这个 report 由**哪个 agent** 审（S2 的路由规则，FR-AGENT-14 的落点） |
| **审核标准选择键** | 该 agent 挂载的审核 skill 就是审它的标准（FR-AGENT-15） |

也就是说，**S2 的路由规则和审核标准选择是同一件事**，不需要两套配置。

#### 配置形态

> ❌ **这个配置形态已整体作废（D28）**：`kindPatterns` / `kindSkillOverride` / `isFallbackReviewer`
> **三个字段一个都不存在**。`Agent` 上没有 kind 字段，报告路由只看 `role`（所有 `role:'reviewer'`
> 的 agent 都审），也没有"兜底审核者"这个概念。留这一段是为了说明当时的设想。

```ts
// ❌ 已作废（D28）——以下是历史设想，不是现状
interface AgentReviewConfig {
  /** 这个 agent 认哪些 kind —— 即 S2 的路由键 */
  kindPatterns: string[]          // 支持精确匹配与简单通配
  /** 可选：显式指定某个 kind 用哪个 skill；省略则用该 agent 挂载的审核 skill */
  kindSkillOverride?: Record<string, SkillId>
  /** 是否作为未知 kind 的兜底审核者 */
  isFallbackReviewer?: boolean
}
```

**今天实际有什么**：`Agent.role`（`'executor' | 'reviewer'`）与判断依据 `Agent.instructions`
（② 身份）；`Agent.reviewStandard` 是**老数据的兼容字段**——只剩读取与详情页那颗「并进「指令」」
按钮（保存时自动并进并清空）。

⚠️ **2026-10 更正**：这一段原来还写着 `Agent.reviewerAgentId`（"由谁审它"）与
`Agent.allowedActions`（"判完允许动什么"）。**两个都撤掉了**——"谁审谁"与"判完允许动什么"
现在只有**智能体组**能回答（`docs/design/agent-groups.md` §16 记了这一轮的完整清单、
老数据的清理方式与直接后果）。

#### ~~三种匹配情形~~（❌ 已随 D28 作废）

> ❌ **下面三种情形全部不成立**：没有 kind 匹配这回事。今天的规则是**所有 `role:'reviewer'`
> 的 agent 都审每份报告**（`routeReportToReviewers`），"多视角审核"与"兜底审核者"都不存在。

| ~~情形~~ | ~~行为~~ |
|---|---|
| ~~**恰好一个 agent 声明该 kind**~~ | ~~起一个 review run（最常见）~~ |
| ~~**多个 agent 声明同一 kind**~~ | ~~各起一个 review run（多视角审核），产生多个 verdict~~ |
| ~~**没有 agent 声明该 kind**~~ | ~~走使用者配置的兜底审核 agent~~ |

~~> 多视角审核是一个自然的能力：同一个漏洞报告，安全 agent 和架构 agent 可以给出不同的 verdict，两个 verdict 都留痕。~~

#### ~~首版实现范围~~（❌ 已随 D28 作废）

| 项 | ~~首版~~ | 现状 |
|---|---|---|
| 协议 | 上述最小 JSON 形态 | ✅ 仍有效 |
| `kind` | ~~✅ 支持，含兜底审核者~~ | ❌ **没有兜底审核者**（D28 去掉了这个概念） |
| **`kind → agent` 路由** | ~~✅ 按 agent 的 `kindPatterns` 匹配~~ | ❌ **已删除**：只按 `role` 路由 |
| `body` 结构化解析 | ❌ 不做，整段作为审核输入 | ✅ 仍有效 |
| 多来源格式 | ❌ 只做一种 | ✅ 仍有效 |

**去重键**：`dedupKey = sha256(source + externalId + contentHash)`

- `externalId` 由第三方提供，用于识别"同一条"；
- `contentHash` 防止同一 `externalId` 内容变化后被误去重。

> ⚠️ **注意去重与多视角审核的关系**：去重作用在 **report 层**（同一条数据只有一个 report），不作用在 **review 层**（多个 agent 可以对同一个 report 各起一个 review run）。两者不冲突。

---

### 12.5 插件系统（D25）—— ✅ 已实现（`apps/remote/src/plugins.ts`）

> **已落地的四条**：① manifest 校验用**白名单**（未知 capability / scope 一律拒绝，
> 且拒绝理由里列出宿主支持什么）；② 主版本 `apiVersion` 门禁；
> ③ **失败隔离**——单个插件加载失败只记在它自己身上（`enabled: false` + `error`），
> 不让整批加载失败，也不影响宿主功能；
> ④ ✅ **`entry` 指向的代码会被真的求值/加载**（`loadPluginDirectory`），并且有
> **entry 越界防护**——这就是为什么 daemon 侧不走 `readdir` + `JSON.parse`：
> 只有加载器才看得见"代码求值失败 / entry 越界 / 语法错误"，自己解析会把一个坏掉的
> 插件在清单里显示成"已启用"。
>
> ⚠️ 这一条以前写的是"`entry` **尚未被真正求值/加载**"，那是**旧的、错的**——今天
> 插件可以带可执行代码，`impl` 由 `entry` 求值得到（纯声明式插件才由宿主注入 `impl`）。

**为什么用插件取代专用扩展位**：登录方式与第三方接入**形状相似**——都是"接入一种外部能力"。给每类各写一套扩展位，加第三类时又要写一套。统一成插件机制后，**新增一类能力 = 新增一类 capability + 写一个插件**。

#### 两类宿主

| 宿主 | 加载什么 | 为什么 |
|---|---|---|
| **远端** | `login`、`third-party` | 认证与第三方查询都由远端发起 |
| **daemon** | 首版无；将来可能有 `runtime`、`report-parser`、`action-plane` | 与 CLI、执行相关的能力 |

> **两边都不从网络拉插件**：各自读自己的**本地目录**。这与"远端只读自己本地文件"（§12.1）一致，也避免引入插件供应链攻击面。

#### 插件形态

```
<插件目录>/<plugin-name>/
├── plugin.json          # manifest（必需）
└── index.js             # 可选：代码入口（纯声明式插件不需要）
```

```jsonc
// plugin.json
{
  "apiVersion": 1,
  "name": "login-email-code",
  "capability": "login",            // ← 能力类型，宿主据此分派
  "version": "1.0.0",
  "entry": "index.js",              // 可选
  "scopes": ["account:identify"],   // 所需权限，闭合白名单
  "config": { /* 有序的配置项声明 */ }
}
```

#### 首版两类 capability

| capability | 宿主 | 契约要点 |
|---|---|---|
| `login` | 远端 | 提供一种把使用者认证为账号的方式；输出**稳定的账号标识** |
| `third-party` | 远端 | 提供一种查询协议；输入 `{ account, cursor? }`，输出 `items[]`（§12.4） |

#### 硬规则

| 规则 | 说明 |
|---|---|
| **未声明即拒绝** | 宿主不认识的能力或 scope → 拒绝加载，给出可读原因（FR-PLUGIN-06） |
| **主版本门禁** | 不认识的主 `apiVersion` → 拒绝加载（FR-PLUGIN-07） |
| **失败隔离** | 一个插件加载失败或运行出错，**不影响**其他插件与宿主功能（FR-PLUGIN-08） |
| **独立启停** | 可逐个启用 / 停用（FR-PLUGIN-09） |
| **清单可见** | 显示已加载插件、类型、版本、scope、状态与失败原因（FR-PLUGIN-10） |
| **敏感配置分离** | 插件密钥与普通配置分开存放、读取权限更严（FR-PLUGIN-11） |

#### 与既有扩展点的关系

| 原设计 | 现在 |
|---|---|
| `FR-AUTH-03` 登录方式"留扩展位" | **实现为 `login` 插件** |
| `FR-REG-08/09` 第三方"可插拔适配层 + 扩展位" | **实现为 `third-party` 插件** |
| `FR-ACTION-09/10` 远端 Action 扩展位 | 待定——见下方 P3 |
| `FR-CLI-47` CLI 适配层"多 runtime 表" | **保持不变**——它是 daemon 侧的内部表，是否纳入插件机制见 P3 |

> ⚠️ **不要把插件机制做成"什么都要插件化"**。CLI 适配层是编译进 daemon 的内部表（FR-CLI-47），把它改成插件会引入版本兼容与加载时序问题。**只有当"外部第三方要自己写"时才值得做成插件。**

#### 待确认（见 §16 R8）

| # | 问题 | 我的倾向 |
|---|---|---|
| **P1** | 插件**只是声明式配置**，还是**可以执行代码**？ | **可以执行代码**——登录与第三方查询的变体迟早需要逻辑 |
| **P2** | 若可执行代码：**受限沙箱**还是**完全信任**？ | **完全信任 + 显式 scope 声明**，与项目"首版不做沙箱"（NG7）一致；沙箱留扩展位 |
| **P3** | 插件范围的边界：只做 `login` + `third-party`，还是把 **CLI 适配器 / 远端 Action / report 解析器** 也纳入？ | **首版只做那两类**；CLI 适配层保持内部表；远端 Action 与解析器留观察 |

---

## 13. Web UI 结构（要点）

> ⚠️ **从 2026-10 起，"Web UI"有两份**（D51）：daemon 界面（`apps/web`，4517，本节的其余部分都是说它）
> 与**远端管理页**（`apps/remote/web`，4518，只读的技能 / 工具目录 + 一个"重新同步"按钮）。
> 两者**共用 `@agentdeck/ui`**（设计令牌、基础组件样式、主题判定都是同一份文件）——"风格相似"
> 是这么来的，不是各抄一份。差别只在页面内容与数据源。
>
> ⚠️ **界面审查（2026-10，D53）**：远端管理页按"先量再改"过了一遍（起真服务 + 无头 Chrome
> 量真实布局）：页名从 `<strong>` 改成 `h1`、顶栏的语言/主题下拉从 37px 收到 32px（在共用
> 样式表里加了一条**只作用于顶栏**的规则）、同步按钮不再被长说明挤成两行（54.4 → 35.2px）、
> 行内按钮改叫「查看」、来源徽标与 slug 同一行（行高 89px，与 daemon 那张表的 84px 同一档）。
> **顺带修了共用样式表里的一处真缺陷**：`.table-wrap` 原本是 `overflow: hidden`，窗口一窄
> 表格右边的列**被裁掉且无法到达**（daemon 自己的技能表在 860px 下裁掉 **316px**，界面上
> 没有任何提示）——现在改成横向可滚（圆角仍由纵向裁住），两个前端一起受益。
>
> ⚠️ 远端管理页**从 D52 起不再是只读**：它多了"手动装一条技能"与"卸载一条本地装的"两条写操作，
> 写的是**另一个目录**（`<dataDir>/catalog-skills-local`）——同步目录仍然归同步工具独占。

> ⚠️ **这一节描述的是 M0 的零构建 UI，已经不是现状**。界面现在是
> **Vite + Svelte**（`apps/web/`），构建产物 `apps/web/dist/` 由 daemon 托管。
> 迁移的经过与取舍见 §15.24。下面这张表也按今天的视图重写过——原来那版列的是
> "看板 / 通知中心 / 目录管理 / 审计页"这类**当时设想但今天并不存在**的页面。

**五个视图、五项导航**（`apps/web/src/lib/route.ts` 的 `VIEWS`）：聊天 → 任务 →
智能体 → Skills → 工具。⚠️ 2026-10（D58）：「新建任务」**既不是导航项、也不是视图**
——它是「任务」页右栏的一个状态（`Route.creating`），见本表第一行与 §15.35。

| 视图 | hash | 关键设计 |
|---|---|---|
| **建任务**（不是视图） | `#/tasks/new`（老地址 `#/new` 同一状态） | ⚠️ 2026-10（D58）：**不是导航项、也不是视图**——那张表单住在「任务」页的**右栏**里，顶栏那个主操作把右栏切成它。三步链：执行 → 审核 → 行动（D42）。默认值从长期配置推导，②③**只为这一次**可改，三处都提前说清后果。⚠️ 任务内容是**一个多行框**（切分见 `apps/web/src/lib/request-text.ts`）；三步是**两列**（左 ① 执行 / 右上 ② 审核 / 右下 ③ 行动）；输入框默认 3 行、随输入长高、15 行封顶；③ 的行动选择器在**居中对话框**里（`components/Modal.svelte`），页面上只有「选择动作…」+ 计数，配置细节（胶囊：契约值 + **已固定 `name=value`**（同一行）+ 说明）在 ③ 卡片里面；提交栏**吸底** |
| **任务** | `#/tasks` | ⚠️ 2026-10（D58）：**建任务的入口在这一页**（顶栏那个主操作），表单也开在这一页的右栏里——所以这一页同时是"看"和"建"两个方向的门。右栏一次只放一件事（详情 / 表单），互斥且有守卫。列表 / 看板两态。看板**六列**（阶段**六档**，`needs_human` 与 `action_failed` 同列；第六列「已放弃」不是阶段，见 §4.1）。详情右栏是**时间线**（按发生先后 + 类型 + 时间，默认选中最新那条）+「最后结果」（左结论 / 右产出文件） |
| **智能体** | `#/agents` | 主从布局（列表 + 详情）。详情里有「由谁审它」、**「指令」**（② 身份；判断依据写在里面，老数据那份老标准也显示在这一栏、并带一键并进）、**挂载的 skill**、以及**行动权限**编辑器（左选右配，D43/D44）。⚠️ 2026-09 起**没有「审核标准」那一栏**（使用者要求「移除审核智能体的『审核标准』」） |
| **技能** | `#/skills` | 三个来源安装（本地路径 / GitHub 地址 / **推荐清单**）+ **卸载**（D38）。推荐清单由维护者核过来源、用**独立工具** `pnpm run sync-skills` 抓下来放进公共目录（D50，见 §12.1）——使用者本机不必能到 GitHub |
| **工具** | `#/tools` | 工具包（一个包 = 一个组）。含"放行不支持预演的动作"那个开关（默认关，写明代价） |

**跨视图的三件事**：

- **路由用 hash，不用 History API**：daemon 的静态服务是**白名单**式的（只发列出来的
  文件），支持 History API 就得放宽成"认不出来的都发 index.html"——那会让 404 消失，
  把"资源不存在"变成"看到一个空白页"，排查更糟。代价是 URL 里有个 `#`，在这个场景下无所谓。
- **一个抽屉**：同时只开一个（收件箱 / 设置 / 远端共用同一个组件，只是聚焦不同段）。
  分成独立组件会在几处各写一遍表单，迟早不一致。
- **顶栏 + 侧边栏只做三件事**：挂顶栏与侧边栏、按视图切换主区、管抽屉。
- **顶栏三组：这是哪一页 | 这一页能做什么 | 与页面无关的那些**（2026-09 改版）。左边是
  品牌 + **当前页名**（与侧栏那一条**共用同一个词条**：`apps/web/src/lib/view.ts` 的
  `VIEW_TITLE_KEYS`——两处各写一份，迟早变成侧栏说「任务清单」、顶栏说「任务」）；
  **这一页的动作**由**各视图自己登记**（`apps/web/src/lib/page-actions.ts`：登记**按
  视图名**存，读的一侧只认当前视图，卸载时收回——换页时"新页登记"与"旧页清理"的先后
  顺序不可依赖，只存"最后一份"会让顶栏在某种顺序下空着）；最右边是与页面无关的
  全局项（语言 / 通知 / 登录 / 设置）。改版前动作散在各页头部：任务与智能体在**左栏**、
  技能与工具在页面头部、聊天又在左栏——四个页面三种形状。

  ⚠️ **顶栏与 `.shell` 共用同一套 `grid-template-columns`**（`var(--sidebar-w) 1fr`）：
  左格（品牌 + 页名）正对着侧栏那一列，右格从**侧栏右缘**开始——所以这一页的动作
  **左缘与侧栏右缘对齐**，也就是与主区内容共一条竖线（2026-09 第二稿；第一稿里动作
  紧跟着页名，页名一短——「聊天」只有两个字——动作就悬在侧栏上方的半空里，跟下面
  的清单栏对不齐）。

  ⚠️ 中间试过一版"把动作推到**最右**、与全局项之间画一条竖线"，**又改回来了**：
  推到最右之后动作离页名一千多像素，"我在哪一页"与"我能做什么"变成屏幕上两件不相干的
  事，而它们本来是一句话（"**在智能体这一页**，你能新建智能体 / 设置 / 刷新"）。现在两组之间
  靠**距离**分开，连分隔线都不需要（试过的那条竖线紧贴按钮组，看起来像按钮自带的边）。

  ⚠️ 两条硬约束：①**页名只出现一次**，所以各页主区里那个与页名重复的大标题一起删了
  （智能体页左栏那个 `h2` 与顶栏页名一字不差；任务页列表模式那个标题与顶栏共用同一个
  词条）；②**顶栏恒为一行**——它的高度被 `.shell` 的 `calc(100vh - var(--topbar-h))` 用着，
  换行会把整页挤歪，所以窄屏（< 60rem）把动作收进 `⋯`，而不是让它换行（宽度可以挤，
  高度不能变）。

  ⚠️ 顶栏里的按钮**钉成同一个高度**（`.topbar button { height: 1.9rem }`）。不钉的话
  "字高 + 内距"算出来的高度会各差几像素（`⋯` 那个字的字号更大、账号按钮里还有头像），
  一条带子上看着就是没对齐。

  ⚠️⚠️ **这一页的动作 2026-10 改成了一条工具条**（D59，见 §15.37）：轨道与常驻控件
  同高（30px），轨道里的格子矮一档（24px）——**两档高度**，探针分别量两组各自齐不齐，
  另有一条量轨道高度。改版前那一排是三种重量混着排（实心蓝 / `--surface-2` / ghost 的
  浅灰底），后两种的底色对比只有 **1.14:1 与 1.22:1**，低于"看得见一条边"的门槛（3:1）
  ——所以屏幕上其实是"一个色块 + 三段文字"。现在组里每一格形状一样，状态靠三档底色：
  常态透明 / hover 浮起一格 / **当前实心 accent**（4.88:1）。

  ⚠️ **`active` 曾经是个死类名**：`.active` 在样式表里只有侧栏 `.nav-item.active` 那一条，
  于是「列表 / 看板」两个按钮长得一模一样，使用者看不出自己在哪一个模式里。现在
  `.topbar .page-actions button.active` 是实心底，探针也有一条量它（"当前那个看得出来"）。
  ⚠️ 那时踩过一个同类的坑：新写的一条 `.topbar .page-actions button.active` 与文件后面
  一条旧的**同分**规则撞了，**源序靠后**的那条赢——于是"当前"被打回 1.22:1 的浅灰，
  而三条探针全绿（它们只量"高度齐不齐"）。删掉旧的那条才真的生效。

**UI 层的闭合性收益**：因为 verdict 全局统一且三层闭合，**判决卡片只有一个渲染器**。

**离线**：UI 与数据都在本机，断网时完整可用（仅远端相关功能不可用）。

> ⚠️ **加一个视图要动三处**：`view.ts` 的 `VIEWS`、`Sidebar.svelte` 的 `ITEMS`、以及
> `view.ts` 的 `VIEW_TITLE_KEYS`（顶栏那个页名）。前两处少动一个**不会报错**——只表现为
> "那个视图打不开 / 侧边栏点不到它"，所以探针里有一条量「侧边栏恰好五项、首项是聊天、
> 末项是工具」（顺序逐项比对）；第三处**漏了是编译错误**（`satisfies Record<ViewName,
> WebTextId>` 是穷尽的），不会变成"顶栏那一格空着"。
>
> ⚠️ **视图 ≠ 导航项 ≠ 子状态**（D58 两步）：第一步把「新建任务」从导航里去掉了
> （`ITEMS` 里没有它），第二步连**视图**也不是了（`VIEWS` 里没有 `new`）——它是
> 「任务」页右栏的一个**子状态** `Route.creating`（地址 `#/tasks/new`）。
> 于是"页面有几个"只有一个答案（`VIEWS` 五个、侧栏五项），而那个子状态由
> `route.ts` 的纯函数解析、有单测。
>
> ⚠️ 两步各留了一条"少一个入口就必须多一个入口"的判据：第一步钉的是**顶栏那个主操作**
> （文字 + `primary` + 点了到得了表单），第二步钉的是**它开在哪儿**（右栏里、左边清单
> 还在）。两处都不是装饰——"没地方建"和"点了什么都没有"在界面上都看不出来。

**改界面的常规动作**：`pnpm run build:web`（**会清空 `apps/web/dist/`**）之后刷新页面；
改到布局时再跑 `pnpm run probe:layout`（真浏览器量，不是看代码猜）。

---

## 14. 安全边界与如实披露

### 14.1 不做沙箱隔离（NG7）

| 项 | 事实 |
|---|---|
| 权限 | run 以 daemon 进程的 OS 用户权限执行，可读写该用户可及的所有文件 |
| CLI 权限模式 | `--permission-mode bypassPermissions`（无人值守必需） |
| 不做的事 | 不做文件系统沙箱、不做容器 / microVM、不做凭据代理 |
| 远端存有的敏感物 | agent 环境变量、账号与设定、记录副本 |
| **"代码不出本机"的边界** | 工作目录不出本机；但 agent 读写并写进报告 / 判决的内容会回到远端 |

README 与安全文档必须包含上述事实表、推荐的边界做法（**专用 Unix 用户 → 容器 → 独立 VM**），以及"把 daemon 当作用户本人运行"意味着什么。

**在位的爆炸半径控制**：

| 机制 | 作用 |
|---|---|
| 同一工作目录串行化 | 并发 run 不互相踩 |
| 任务级配置覆盖 | 平台写入不漏进使用者的全局配置 |
| 动作白名单 + dry-run + 幂等 | 判决带来的副作用有界 |

### 14.2 本地接口的攻击面（同源后已收敛）

**Web UI 由 daemon 托管** ⇒ 页面与本地接口**同源**：

| | 远端托管 UI（旧） | **daemon 托管 UI** |
|---|---|---|
| 谁可能攻击本地接口 | **任意网页** | 只有**同源页面**与**本机进程** |
| 浏览器侧防线 | 需 Origin 白名单 + 私有网络预检 | **同源策略自动生效** |
| 必需措施数 | 五条 | **两条** |

**仍然必需的两条**：

| # | 措施 | 作用 |
|---|---|---|
| 1 | **只绑定回环地址** | 杜绝局域网内其他机器访问 |
| 2 | **校验 `Host` 头以防 DNS rebinding** | 攻击者可让域名解析到 127.0.0.1，但**无法伪造 `Host`** |

**已取消的**：Origin 白名单、拒绝无 Origin 的请求、每 run 一次性令牌（降级为会话标识）、约定握手、私有网络访问预检。

**保留的运维措施**：端口占用检测（不静默换端口）、`/health` 不含敏感信息、请求体大小上限。

> ⚠️ **反向风险必须如实写进文档**：同源之后，**任何能在本机这个源上执行脚本的东西**（浏览器扩展、被注入的脚本）都能驱动 daemon。daemon 侧**无法防御这一点**——它属于"本机已被攻陷"的范畴。

### 14.3 远端侧

| 项 | 说明 |
|---|---|
| 传输 | **必须 HTTPS** |
| 账号 | 需要登录；登录态用 **token**（本地页面是 http，`Secure` cookie 不生效） |
| daemon 凭据 | **磁盘上没有** |
| 第三方凭证 | **不持有**——账号即凭证（D12） |
| **CORS** | **本链路唯一显式放行 CORS 的一环**：页面（`127.0.0.1:<daemon端口>`）访问远端是真跨源。放行范围收窄到**回环来源**（`127.0.0.1`/`localhost`/`::1`，任意端口），并正确应答 `OPTIONS` 预检。判据是解析后的 `hostname` 全等，防 `127.0.0.1.evil.com` 这类前缀伪装 |
| 认证门顺序 | **先认证、再判路由**：未登录访问未知端点返回 401 而非 404，顺带不泄露端点是否存在 |
| 敏感配置 | agent 环境变量的读取权限须严于普通配置 |
| 审计脱敏 | 令牌类参数在写入审计前替换为 `***` |

### 14.4 远端记录的信任边界

| 事实 | 后果 |
|---|---|
| **有账号与登录** | 写入记录**可鉴权**，来源可信度提升 |
| 传输走 HTTPS | 传输途中不可篡改 |
| 但**内容完整性取决于远端服务方** | 服务方管理员可改数据 ⇒ **合规级证据仍以本地为准** |
| **不记 skill 指纹** | 即便在本地，也只能确认"用了哪个标识与来源的 skill"，**不能证明其内容** |

| | 权威性 | 允许的产品表述 |
|---|---|---|
| 本地审计链 | ✅ 权威 | "合规证据"、"可追溯" |
| 远端记录 | 来源可鉴权的**副本** | "查看历史"、"统计"、"跨机器同步" |

---

## 15. 里程碑落地

| 里程碑 | 交付物 | 覆盖场景 | 状态 |
|---|---|---|---|
| **M0 骨架** | 本地实例 / issue / agent / runtime / daemon / **本地 UI 与接口** / `run(execute)` / 流式回传 / 看板 / 文件存储 / 存储端口 | S3 | ✅ **已实现** |
| **M1 审核** | `report` / `run(review)` / verdict schema 与校验 / `invalid` 路径 / reviewer≠executor / 上下文块注入 / 技能注入 / 审核模板 / 通知中心 | S2 | ✅ **已实现** |
| **M2 闭环** | ~~action registry~~（**D41 已删**，动作来自工具包）/ 两类执行端 / 审计链 / execute→review→verdict→action 自动串接 / 链路深度上限 | S1 | ✅ **已实现**（动作派生 run 曾接通；⚠️ **D41 之后那条边没有调用点了**——唯一会派生 run 的 `issue.assign_agent` 随内置动作一起删了，见 §15.29） |
| **M3 远端能力** | 账号与登录 / 用户设定 / 公共目录与下载 / 第三方查询适配层 / 记录与统计上报 | 全部 | ✅ **已实现**（浏览器侧已接入，见 §15.3） |
| **M4 加固** | 成本可视 / 审计导出 / 数据库适配器 / 对外 MCP server / 第二个 CLI 适配器 / 可选沙箱 | 全部 | ✅ **已实现** |
| **D27 工作目录** | 每个任务默认自动分配独立目录，不必使用者指定 | 全部 | ✅ **已实现**（§15.9） |

### 15.1 实现状态明细

```
apps/
  remote/    plugins（白名单校验 + 失败隔离）· loader（代码加载 + 越界防护）
             · plugin-store（启停 + 密钥分开存放）· server（五职责）· cli
  mcp/       对外 MCP server（stdio JSON-RPC，daemon 的客户端）· cli
  cli/       命令行（FR-INTEG-02）：daemon 的客户端，默认 JSON 输出、退出码有含义
             · args（含 `--` 拒绝）· commands · main
  daemon/    server · executor · registry · actions · review · ingest · workdir-locks · semaphore · cli
  web/       Vite + Svelte 5（产物 dist/ 由 daemon 托管）
             src/App.svelte · views/{NewTask,Tasks,Agents,Skills}.svelte
             · components/{Topbar,Sidebar,InboxDrawer,SettingsDrawer,RunLog}.svelte
             · lib/{api,remote,sync,stores,view}.ts · styles/app.css（设计令牌层）
             server/index.ts = daemon 侧的静态服务
packages/
  protocol/     枚举 · 实体 · verdict（一开一合）· 本地接口契约 · 审计导出格式版本
  domain/       存储端口 · 三套状态机 · kind 路由 · 回路边界（含链路重建）· 动作定义与白名单（D41 起没有内置动作表）
                · 审核决策（含"重试有没有意义"的判据）· 审计 · 审计导出与校验
                · 成本聚合 · 数据快照导出与导入（FR-STOR-05）
  store-file/   append-only 日志 · 内容寻址 blob · 单进程锁 · 压缩
  store-sqlite/ node:sqlite 适配器（生成列 + 同步 API，与文件适配器差分对拍）
  agent-core/   runtime 表（含 sessionState 三态与版本范围声明）· 禁改参数 · argv
                · 技能注入 · 进程树 · 探测 · 沙箱 · 版本支持判定
  agent-claude/ stream-json 解析 · 适配器
  agent-generic/ 第二个 CLI 适配器的描述表 · NDJSON 解析 · 适配器
  agent-codex/  codex app-server 适配器：JSON-RPC 传输 · 通知流解析 · 适配器（service 形状）
```

**M2 里曾经的占位已补齐**：`issue.assign_agent` 早先返回 `pending:<issueId>:<agentId>`
这样一个**看起来像成功、实际没有创建 run** 的标记。它的真正代价不是"功能缺失"，
而是**环检测端到端从未被走到过**——环需要真的有一条链路才存在。
现已接通，见 §15.2。

### 15.2 M2 闭环补齐：动作派生 run 与回路边界

**① `Run.derivedFrom` 是重建链路唯一的边。**
这个字段从 M0 起就在 schema 里，但一直没人走过去。重建路径是
`run.derivedFrom → action → action.verdictId → verdict → verdict.runId → 上一个 run`，
所以**不新增字段就能还原历史链路**（`domain/loop/chain.ts`）。

**② 一个很隐蔽的失效点：当前这一步的原因码读出来恒为 `null`。**
`loadChainSteps` 是在**判决落库之前**调用的（审核收口一开头就重建链路），
所以当前 run 那一步的 `reasonCode` 必然是 `null`。于是比较变成
`(X, A, 'needs_fix')` vs `(X, A, null)`——**永远不相等，环永远抓不到**。
而所有代码看起来都正常，测试也不会报错，只有真的转起圈来才知道边界没生效。

修法是 `withCurrentVerdict()`：判定动作之前，把**刚解析出来的 verdict 原因码**
并进链路最后一步。此刻它其实已经知道了，就在手里。

**③ 环与深度必须分开报。**
两者的处置方式不同：环意味着审核标准要求的东西模型做不到（要改标准），
深度超限意味着任务太大（要拆任务）。所以 `derivationBlocked.reason` 区分
`'cycle' | 'depth'`，通知标题也分开。

**④ 边界拦住 ≠ 动作失败。**
指派本身已经成功了。把它记成 `failed` 会让"动作没做成"这个信号变脏——
人分不清是环境坏了还是边界起作用了。所以状态仍是 `executed`，
只是 `result.spawnedRunId` 为 `null` 且带上 `derivationBlocked`。

**⑤ 关停必须是屏障（实现时由一个 40% 概率复现的偶发失败逼出来的）。**
`close()` 早先只关 HTTP server 与 store，**不等执行中的 run**，于是测试里
紧接着清理数据目录就撞上 `ENOTEMPTY: directory not empty, rmdir '.../runs/<ulid>'`。
它看起来像"测试写得不够严谨"，实际是产品缺陷：真实使用中按 Ctrl-C，
子进程还在跑、还在改工作目录里的文件，而"已停止"是假的。
现在执行器留住每个 run 的生命周期 Promise，`shutdown()` 先停收新 run、
再逐个请求取消、然后等它们真的结束；宽限期（5s）内结束不了的要**如实告警**，
而不是无限等下去把关闭变成挂起。修完连续 14 次全量测试无失败。

**⑥ 顺带修掉的一个静默 bug：游标翻页会重放第一页。**
文件适配器用 `findIndex(i => i.id === cursor) + 1` 定位游标；游标找不到时
`findIndex` 返回 `-1`，于是 `start = 0`——**从头再来**。调用方拿到的是合法的一页，
`nextCursor` 也照常给出，一切看起来正常，但翻页会永远在第一页打转且毫无报错。
游标找不到并不罕见（上一页最后一条恰好在两次翻页之间被删掉）。
改成按**排序键的位置**比较（`i.id > cursor`）：游标本来就是 ULID，排序键也正是 id，
所以"id 大于游标的那些"就是"游标之后的那些"——游标那条还在不在都不影响。
sqlite 适配器的差分对拍测试此前为这条分歧让了路，现在不必了。


### 15.3 M3 的实现取舍（实现时才浮现的三个点）

**① 远端是全链路里唯一需要 CORS 的一环。**
`FR-BRIDGE-11` 禁止 **daemon** 主动放宽 CORS——页面与它同源，同源策略本身就是防线。
但页面要访问的远端在另一个地址（`code ② 远端接口（跨源）`），这是真跨源，
不能被"同源策略自动解决"，只能显式放行。落地形态：收窄到**回环来源**
（`127.0.0.1` / `localhost` / `::1`，任意端口），并正确应答 `OPTIONS` 预检——
带 `Authorization` 的跨源请求必然触发预检，不应答的话请求在浏览器里根本发不出去，
且报错信息极难定位。公网来源拿不到 CORS 头，否则任何网页都能拿着用户的 token 打远端。
注意 `http://127.0.0.1.evil.com` 这类前缀伪装：判据是解析后的 `hostname` 全等，不是字符串前缀。

**② 认证门在路由之前。**
未登录访问未知端点返回 **401 而非 404**，这不是疏漏：先认证再判存在，
顺带不泄露"某端点是否存在"。已写成测试固定下来。

**③ "不暂存"落到代码里是"刻意不写缓存"。**
需求方的原话是"不需要暂存，有需求的时候，远端重新调用端口去询问第 3 方"。
最容易破坏它的是"顺手加个缓存"——因为那看起来像优化。所以测试直接钉死：
同一查询调用两次，插件必须被真的打到两次。

**④ 口令登录不由插件承担。**
插件是扩展，不是替代。内置口令登录**始终可用**；某个 `login` 插件加载失败时，
它只是从登录方式列表里消失，口令登录不受影响——这是"失败隔离"的对外可观察形态。

**⑤ 浏览器侧：远端不可用**不能**挡住本机功能。**
面板独立启动、失败只变成面板上的状态；`401`（凭证过期）与网络失败分开报——
前者提示重新登录，后者提示去启动远端服务。混成一句"操作失败"会让人往错误方向排查。
凭证放 `localStorage` 而非 cookie：页面跑在明文 http 上，带 `Secure` 的 cookie
根本不会被发送。

**⑥ 插件 P1：`entry` 里的代码现在真的会被加载执行。**
在此之前插件系统只做了"声明"那一半——manifest 被校验、非法插件被拒绝，
但 `entry: "index.js"` 里的代码**从来没有被求值过**，实现体是宿主注入的 `impl` 对象。
那样的插件系统只对宿主自己的代码有用：第三方照约定放一个 `plugin.json` + `index.js`
进去，**什么也不会发生**。

安全上的关键一条：`entry` 是**陌生人写的字符串**，它可以指向目录外面。
判据必须是**解析后的真实路径**仍在插件目录之下——字符串前缀判断挡不住它，
因为 `/plugins/evil/../../../etc/x` 确实以 `/plugins` 开头，却落在 `/etc/x`。
另外只收 `.js`/`.mjs`（`.ts` 会让第三方因缺少转置配置而半死不活，不如加载时就拒绝），
且单个插件的加载失败只影响它自己。⚠️ 仍然**不做沙箱**（D26）：插件跑在宿主进程里，
边界靠 manifest 的 scope 白名单**声明式**约束，这一点必须如实披露。

### 15.4 M4 的实现取舍

**① 对外 MCP server 是 daemon 的客户端，不是 daemon 的一部分。**
它不 import daemon 的任何模块，只通过本机 HTTP 接口说话。于是它可以被任意进程
按需拉起（通常被别的 agent 当子进程起），不需要和 daemon 共享生命周期；
也天然遵守 D20——它只连 `127.0.0.1`，并且**在启动时就拒绝非回环的 daemon 地址**，
不让自己成为"借本机之手访问别处"的跳板。传输用 stdio 而非 HTTP：不要端口、
生命周期绑定在父进程上（stdin 关了就走，不留孤儿）、且**没有网络面**。

**② 工具集刻意是窄的，而且"不暴露什么"被测试钉住。**
MCP 一接出去别的 agent 就能驱动本系统，**这道边界一旦放开就很难收回**——外面会有人开始依赖它。
所以最要紧的一组测试不是"工具能用"，而是"某些工具**不存在**"：

| 刻意不暴露 | 理由 |
|---|---|
| `POST /api/runs` | 它接受任意 `workDir`，然后在那里启动一个会读写文件的子进程。接进 MCP 等于把"在你的机器上按我给的路径执行 agent"变成一次普通工具调用 |
| `POST /api/skills` | skill 会被拼进 agent 上下文，是提示注入的现成入口 |
| 改 agent 配置 | 同上：改配置就是改将来所有 run 的行为 |

暴露的都是"读 + 受控写入"。唯一写操作 `submit_report` 只是**把材料放进来**，
走既有的审核流程，它本身不执行任何命令——这句话写在工具描述里而不是只在注释里，
因为**模型是根据描述决定要不要调它的**。

**③ 工具层错误与协议层错误分开。**
未知方法/未知工具名用 JSON-RPC `error`（客户端的事）；参数不对、daemon 报错用
`result` + `isError: true`（交给模型，模型能看见原因并自己改参数）。
把所有失败都塞进 `error` 会让模型看不到失败原因，只能干瞪眼重试。

**④ 审计导出必须自带校验和，且把能力边界写进产物里。**
审计链是"可追溯"而非"可复现"（skill 记录不含指纹，D9）。导出物会被带出本机、
存档、对比——一份**被改过却看起来一模一样**的审计文件比完全没有审计更糟，
所以校验和覆盖除它自己以外的全部内容。同时把限制清单放进文件本身：
拿到文件的人才会看到"不能逐字节复现""argv 已脱敏"，而不是以为它可以用来重放。
校验和用**规范化的 JSON**（键按字典序）算，否则"原样读回来再校验"都会失败——
那种校验和比没有更糟。

**⑤ 成本聚合把"缺失"和"估算"都显式报出来。**
把没有上报用量的 run 当零算，会让"总成本 1000"被误读成"这几条一共花了 1000"，
整个成本可视就变成了成本误导。成本以**整数微美元**累加：浮点累加在几百次之后会漂移，
而数字一旦对不上账，成本可视就没有可信度了。

**⑥ 数据库适配器用"差分对拍"验证，而不是"自己写的测试通过"。**
`node:sqlite` 适配器与文件适配器跑同一串 ~75 步操作并逐项对比，覆盖 CAS、
patch 的 `undefined` vs `null`、workDir 占用、自竞争、去重键、消息 seq、blob 引用、
分页与排序。并做了**变异验证**：去掉 `pruneUndefined` 或让 `findRunHoldingWorkDir`
忽略 `excludeRunId`，差分测试会立刻失败并指出是第几步不一致——
所以"两个适配器行为一致"这个结论是有牙齿的。
实现上的支点：**JSON 是唯一真相**，`status`/`work_dir`/`dedup_key` 等全是 SQLite
的 `VIRTUAL` 生成列（避免文件适配器明确否决过的"双份真相"），照样能建索引；
`DatabaseSync` 是同步 API，所以方法体内**一个 `await` 都没有**，不需要 Mutex，
而 CAS 仍走 `UPDATE … WHERE id = ? AND status = ?` + `.changes`，
因为那条保证对**另一个进程**同样成立。

**⑦ 分歧被当成信号，而不是当成噪声。**
差分测试暴露出文件适配器的游标翻页 bug（见 §15.2 ⑥）。当时有两条路：
让 sqlite 适配器**复制**这个 bug 以求"一致"，或者修文件适配器。
选择了后者——对拍的价值就在于让分歧浮出来，把分歧抹平是最没意义的做法。

### 15.5 第二个 CLI 适配器：描述表被撑开的地方

`FR-CLI-47` 的整个主张是"加一个 runtime = 往描述表加一行数据，而不是在调用点加 if"。
第二个适配器是对这个主张的**第一次真实检验**。结论：主张大体成立，但表里确实
藏了两处 Claude 特有的假设——**只有真的接第二个 CLI 才会暴露出来**。

**① 最严重的一处：旗标拼写被硬编码进了"通用"代码。**
`argv.ts` 里原本直接写 `argv.push('--model', …)` / `'--max-turns'` / `'--resume'`。
第二个 runtime 用 `-m` / `--max-steps` / `--resume-session`，唯一的出路就是
**改 `argv.ts`**——正好是 `FR-CLI-47` 要防的"散落在调用点"。
修法是新增 `managedFlags` 数据槽（缺省值就是 claude 的拼写，所以首版行为逐字节不变）。
**只要还打算加第三个 runtime，这个槽就必须在。**

**② 缺"这个 CLI 有没有会话状态"这一位。**
无状态 CLI 没有会话 ID，`resume.flag` 只能填一个假旗标，于是调用方会以为恢复可用。
已加可选 `stateless`，但 ⚠️ **目前没有真正用起来**（generic 仍声明了一个恢复旗标）——
因为"按 agent 选 runtime"还没落地。这是**留在表面上的一处不诚实**，已记入 §16 的 R9。

**③ `blockedArgs` 的"值规则"是 POSIX 专属的。**
`withValue` 靠"下一个 token 不以 `-` 开头"判定值。对 POSIX 成立，对 Windows 风格
`/flag:value` 完全覆盖不到。本轮没有踩到，只是因为 generic 刻意选了长旗标。

**④ `InjectionSlot` 分不清"范围内不做"与"不知道有没有"。**
claude 的 `enabled: false` 意思是"范围内不做"；generic 的是"不知道这个 CLI 有没有
这个机制"。两者混在同一个 `false` 里，UI 无法区分。已给 `InjectionSlot` 加
`evidence?: RuntimeEvidence`。

**⑤ 整个接口没有任何"支持的 CLI 版本范围"位，而 `FR-CLI-07` 要求声明并测试它。**
`detectVersion` 存在，但**只作观察**（`probe.ts` 明确说不按版本分支）。
于是"支持哪个版本区间"在代码里**无处可写**——对 `evidence: 'provisional'` 的 runtime
尤其致命，因为它的字段名几乎肯定随版本漂移。记入 R10。

**已验证与未验证必须分开说。** generic 描述符标了 `evidence: 'provisional'`，
并且 `unverifiedFields()` 返回一份**机器可读**的未验证字段清单（是数据，不是注释），
测试直接断言它非空。整条链路（拼参数 → 起进程 → 喂 prompt → 解 NDJSON → 失败分级 →
禁改过滤）都在假可执行文件上真跑过；**未验证的只是"字段名与真实 CLI 一致"**。
这一点不能含糊——把未验证的东西说成已验证，比不说更糟。

**实现时被测试抓出来的三个真实缺陷**（都写进了代码注释）：

1. **失败分级函数自己藏了一次静默失败**：原判据是"没有终止事件**且**有不可解析行"，
   于是"说了一句话 + exit 0"被误判成**成功**——正是它要防的那种失败。
   改成"没有终止事件即失败"。
2. **`usage` 嵌在 `result` 事件子对象里时被静默读成"没有用量"**。现在两路都读。
3. **`spawnProcessTree` 把 ENOENT/EACCES 压成 `{code:null}`**，错误原因彻底丢失，
   导致"CLI 装坏了"被报成"输出格式变了"——**错误文本指向错地方**。
   已让 `ProcessHandle` 暴露底层进程供适配器挂 `'error'`。
   顺带发现"目录也有 `X_OK`"，所以 `findOnPath` **不能**用来判断"能不能当程序跑"。

### 15.6 只有"真的跑一次"才发现的两个缺陷

这两个都不是类型错误，也都**通不过任何单测**——因为单测都用 `port: 0`、
都用内存里的插件对象。它们是靠**把真进程拉起来、真发 HTTP 请求**才暴露的。

**① `listen` 没有 error 处理器 ⇒ 端口被占用时打一串栈，而且写好的提示永远执行不到。**

daemon 原来是 `await new Promise(resolve => server.listen(port, host, resolve))`。
端口被占用时 `listen` 会 emit `'error'`，**没人接**，于是 Node 抛未捕获异常、
打栈、进程退出；**同时那个 Promise 永远不会 settle**。后果是 `cli.ts` 里那段
写得好好的"端口被占用，可用 `--port` 指定别的端口"提示（连 `try/catch`）
**一行都执行不到**。

修法是把 `error` / `listening` 两个事件都接上，并顺带做两件正确的事：
- **区分 `EADDRINUSE` 与 `EACCES`**（前者是冲突，后者是权限，处置不同）；
- **把已经占下的资源还回去**——主要是数据目录的单进程锁。不还的话，使用者
  改个端口重启会撞上"数据已被另一个进程占用"，而那个"另一个进程"其实正是
  刚刚失败的自己，**错误信息会把人带偏到完全错误的方向**。

**② 插件清单会把加载失败的插件显示成"已启用"。**

`RemoteService` 早先只接受 `{manifest, impl}` 并**重新校验一遍 manifest**。
而加载器那边的失败（代码求值、`entry` 越界、语法错误）它**看不到**——
manifest 本身是合法的。于是实测结果是：一个 `entry` 越界的插件，
加载器已经明确拒绝了它，运行日志也打印了 `[warn] entry 越出了插件目录`，
但 `/api/me` 的插件清单里它显示成 `enabled: true, error: null`。

这个谎的代价不小：**插件清单曾是运维唯一的排查入口**（FR-PLUGIN-10）。
⚠️ 2026-10：daemon「设置」抽屉里那份展示已撤（D56）⇒ 现在**只有接口**（`GET /api/me`）看得到插件状态与失败原因，
界面上没有入口了。FR-PLUGIN-10 管的是"接口不许撒谎"，那一条仍然成立；但"看得见"这件事现在得靠接口。
一个坏掉的插件显示成"已启用"，会让人去别处找一个根本不存在的 bug。
修法是让服务直接接收**已经加载完成**的 `LoadedPlugin[]`，而不是回头再推导一次。

### 15.7 补齐轮：三个互相掩盖的缺陷，与一处被合法调用触发的 500

**① 重试从来没发生过——而且它掩盖了另外两个缺陷。**

`ReviewCoordinator` 一直支持 `createRetryRun`，但**服务端从来没提供过它**。
于是 `retry` 这条判决路径永远掉进"拿不到重试机会 ⇒ 降级"的分支：
代码看起来支持重试，行为上从不发生。这与早先动作派生那个占位是同一类问题。

把它接通之后，立刻暴露了两件事：

- **`decideReview` 从来没调用过 `isStructuralInvalid()`。** 那个函数早就写好，
  文档写着"用来区分重试有没有意义"，通知文案里甚至写着"这类问题重试不会变好"——
  但决策函数从没问过它。于是"动作名与 skill 子集对不上"这种**只有人能改**的
  问题会被判成 retry，让模型再输出一次同样的东西，白烧一轮。它之所以长期
  没被发现，正是因为重试派发是坏的：所有 retry 都掉进降级分支，缺陷被掩盖了。
  **两个错误叠在一起看起来像对的。**
- **`isStructuralInvalid` 的判据太宽。** 为了兜住 schema 层的动作错误，加过一条
  `path[0] === 'action'`，而那个路径前缀同时覆盖了 `action.params.*`——于是
  **模型的手误被当成配置错误，连重试机会都不给**。现在按消息前缀
  （`动作参数 `）把它分开：参数写错是模型手误，**重试有意义**。

判据是"模型再输出一次会不会不一样"，而不是"问题出现在哪个字段"：

| 情况 | 重试有用吗 | 为什么 |
|---|---|---|
| 动作类型不在注册表 | ✗ | skill 里写的名字与注册表不一致，照着再写一次还是同一个名字 |
| 动作不在 skill 允许的子集内 | ✗ | 标准与注册表对不上，是配置问题 |
| **动作参数不合法** | ✓ | 这次把 `status` 写成垃圾，下次完全可能写对 |
| 没有围栏块 / JSON 不合法 | ✓ | 典型的"这次忘了格式" |

**② `pending_verdict` 曾经让一条判决永远"在途"。**
状态机允许 `invalid → pending_verdict`，字面意思是"等一个新判决"。但重试是
一条**新的 run**，产出的是**另一条 verdict 记录**——所以留在 `pending_verdict`
的那条会永远停在一个非终态上，**而没有任何东西会来推进它**。数据里写着"正在等"，
实际上没人在等：看板会一直显示它、统计会把它算成在途、排查的人会去等一个不会来的东西。
现在派发成功后立刻收口为 `invalid` + `invalidResolution: 'retry'`。

**③ 会话恢复（FR-CLI-06）整条能力从未被执行过。**
执行器里写死 `resumeSessionId: null`——两个适配器、描述表、以及"恢复被拒"的探测
全都实现好了，就差最后这一段接线。而恢复只发生在重试时，重试又是坏的。
现在按描述表的 `sessionState` 决定：`'stateful'` 才恢复，`'stateless'` / `'unknown'`
一律不恢复，且**两种"不恢复"的措辞不同**（一个要人去核对真实 CLI，一个什么都不用做）。
`resumeRejected === undefined` 的含义是**测不出来**，不是"没被拒"——把这两者混起来，
会让 agent 在**没有上文**的情况下继续干活，而产出悄悄跑偏。

**④ 一个能被合法调用触发的 HTTP 500。**
`POST /api/reports` 只检查了 `Array.isArray(items)`，**没有逐条校验**。
而 `ThirdPartyItem.body` 在类型声明上是必填的——但**类型不是运行时校验**。
省略 `body` 的条目会让 `undefined` 一路走到 `createHash().update()`，
抛出生硬的 Node TypeError，最终以 **500 + 内部错误原文**返回。
而 MCP 那边的工具 schema 恰恰把 `body` 标成可选——**按文档写的调用必然踩到它**。

现在在边界上逐条校验：`body` 缺省给空串（只给标题的报告是合法的），
其余必填字段缺失则报 400 并指出**第几条、哪个字段**（批量投递时只说"输入不合法"
让人无从下手）。

**⑤ 一个由新测试引入的测试污染。**
接通重试之后，用例会派生重试 run。若用例不等它跑完就返回，那条 run 会在
**下一个用例**执行期间继续调用假后端，把下一个用例准备好的 `script` 条目偷走。
症状极具迷惑性：单独跑那个文件永远通过，整个套件并行跑约 1/10 概率失败，
且失败信息指向一个**与原因毫不相干**的断言。

修法不是"让每个用例记得收尾"（纪律总会有人忘），而是把**静默做成每个用例的
前置条件**：`beforeEach` 先等所有 run 结束，再清空脚本。修完连续 10 次并行全绿。

### 15.8 第二轮补齐：重启遗留、空闲超时、看板、同步层

**① 重启后遗留的 run 会永远显示成"进行中"（FR-RUNTIME-11）。**
run 状态是持久化的，所以 daemon 被 Ctrl-C 之后，当时在跑的 run 会停在
`running` 这类非终态上——没有任何人有机会把它们改成终态。下次启动如果什么都不做，
看板会**永远**把它们显示成在途，使用者会去等一个不会有结果的东西。

修法是启动时先收口、**再**起 HTTP 服务（顺序不能反，否则页面立刻能读到陈旧状态）。
收口**只能标记失败、不能续跑**：执行所需的 prompt / 技能正文 / 限额是随 HTTP 请求
来的，没有落盘，重启后拿不回当时要做什么。假装能续跑会跑出一个内容不对的东西，
而且看起来一切正常——**比明确失败糟得多**。

顺带发现 `RunFailureReason` 里**早就有 `daemon_restarted` 这个枚举值**，只是一直
没人产生它；而需求 §10.1 对 `failed` 的定义是"出错或**被中断**"。所以补了
`queued→failed` 与 `waiting_local_directory→failed` 两条边——原来只给它们留了
`cancelled`，那是"使用者主动停止"，记成这个等于**在数据里撒谎**。

**② 收口看的集合与 `ACTIVE_RUN_STATUSES` 不是一回事。**
后者回答"这个 run 现在占着资源吗"（`queued` 不在里面是对的：它还没拿到工作目录）；
收口要回答的是"**这个 run 还会有结果吗**"。起初直接复用了那个常量，于是 `queued`
的 run 被漏掉——**复用语义不同的常量**是这类"漏了一类"缺陷最常见的来源。

**③ `limits.timeoutMs` 是"接受但完全忽略"的参数。**
协议里校验过、一路传到执行器、然后被丢掉。接口接受了、行为上不存在——比没有这个
功能更糟，因为使用者会基于一个不存在的保证去做计划。

接上它时按 FR-RUN-08 的原意做成**空闲**超时而非墙钟超时：「长时运行不得被墙钟终止：
只要子进程仍有活动，就不得因"跑了很久"而终止」。判据因此是"**多久没有动静**"。
`RunFailureReason` 里那个值叫 **`idle_timeout`** 而不是 `timeout`——命名本身就写明了
设计意图，是"要接的东西早就想好了，只是没接"的又一处证据。

看门狗用**轮询** `lastActivityAt()` 而不是"活动事件驱动的重置定时器"：后者只要适配器
漏掉一处活动通知，就会**误杀一个正常干活的进程**，而且原因极难查。并做了变异验证——
把判据改成墙钟，关键那条测试立刻变红。

**⑤（D42 收口）缺省值：`timeoutMs` 不传时用平台默认空闲上限（30 分钟）。**
界面新建任务**永远**发 `timeoutMs: null`，于是看门狗从那条路**从来没被开过**——实测踩到
过"执行者用 CLI 的 Bash 后台任务跑了个永远不完的命令，Claude Code 在还有未完成的后台
任务时**不让会话结束**，CLI 一直活着、run 永远停在 `running`"的静默卡死。修法是
`req.limits.timeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS`，并在日志里**明说**用的是默认
（"使用平台默认：空闲 30 分钟没有任何输出就判定卡住并终止"）——缺省值必须看得见，
不然会被人当成 bug 或旧代码。

**④ 同步层落在页面里（FR-REG-06/07/11/12/18、FR-RUNTIME-13）。**
daemon 不向远端发任何请求（D20），所以页面是唯一的通道。三条取舍：
- **上报失败本地暂存并补交**：不暂存的话，"远端抖了一下"等于那段时间的记录**永久丢失**；
- **上报失败绝不影响本机执行**：整个循环里没有一步会阻塞本机操作；
- **上报可关闭**，关了之后本机功能完整可用（FR-REG-16）。

轮询用 `setTimeout` **递归**而不是 `setInterval`：后者在一轮慢于间隔时会让请求
**越积越多**——远端越慢压力越大，最坏情况雪崩。

**⑤ 上报包里结构上拿不到正文。**
FR-REG-14 要求"给项目方的部分应尽量聚合、去内容化"，而最容易违反它的做法是
"反正都取了，顺手把 prompt 也带上"——prompt 里可能有使用者的代码、密钥、业务信息。
所以 `collectRecords()` **结构上只取 id、状态、成本、结论**；想带正文得先改那个函数，
而注释就在旁边。测试直接断言上报包里不含标题、描述、prompt、报告原文。

**⑥ skill 安装：来源写死 + 同名无处理（FR-AGENT-10/11，两条都是 P0）。**
原来的 `POST /api/skills` 有"能写进去就行"的味道，有两个真问题：

- **`source` 被写死成 `'local'`。** 从远端目录下载来的 skill 会被记成"使用者自有的"，
  于是 FR-AGENT-10 那条"本地内容不因远端变化而改变"**在数据上无从判断**——根本
  分不清谁是谁。
- **没有任何同名处理。** `insertSkill` 按 **id** 写入，所以两个 slug 相同、id 不同的
  skill 会**同时存在**：同名冲突不是"被覆盖"，而是"**悄悄多出一条**"，而加载时只会
  取到其中一条。两种结果都不对，且都没有提示。

这条恰好是 MCP/CLI 都刻意不暴露写接口的那一类东西（skill 会被拼进 agent 上下文，
是提示注入的现成入口），所以它的写入路径更该把冲突说清楚。现在的规则是
**确定性 + 绝不静默**：同名一律拒绝写入并在 `skipped` 里说清与谁冲突、对方是哪来的；
要替换必须显式传 `overwrite: true`；与 FR-REG-03 一致，**不做版本管理、不比较新旧**。
实测：目录里下载 `general-review` 时，本机预置的那条（`source: local`）原样未被覆盖。（⚠️ D38 之后目录里没有这条了，现象与规则不变。）

**⑦ 一处 JS 陷阱：`Number(null) === 0`。**
设定里"没设过轮询间隔"会被 `Number()` 变成 0，再被夹到下限 10 秒——
**轮询频率悄悄变成默认值的 6 倍**。"没给"与"给了个 0"必须显式分开。

### 15.9 工作目录：从"由使用者指定"改成"按任务自动分配"（D27）

**改的是默认行为，不是能力。** D20 说"工作目录由使用者指定"——那在"把 agent 接进
自己的仓库"这个用法下是对的，但它把**每建一个任务都要先想一个目录**变成了必须动作。
而绝大多数任务只是"让 agent 做点事"，它需要的是一块空白工作区。

**粒度选 subject（任务）而不是 run，这一点是关键。** 需求原话是"每个**任务**默认
生成一个单独的目录"。按 run 分的话，一次重试就是一间全新的空房间，agent 上次做到
哪儿全丢了——而"重试"的语义恰恰是"接着做"。按 subject 分还顺带让**同任务的并发
被自动串行化**（工作目录锁本来就是按目录加的），`waiting_local_directory` 因此从
"罕见的例外"变成"同一个任务上的正常排队"。

**目录名用 id，不拼标题。** 拼标题看起来更友好，但标题是使用者输入的任意文本
（`/`、`..`、emoji、超长串）；要安全就得转义，而转义规则一旦有缝就是路径穿越。
用 id 天然安全，且 ULID 字典序就是时间序——`ls` 出来自动按时间排。可读性交给界面。

**几处刻意的取舍：**

- **优先级**：请求里显式给的 > 该 agent 配置的默认目录 > 自动分配。第二条**保留**
  而不是砍掉：它是操作者的**显式配置**（"这个 agent 总在这个仓库里干活"），
  不是"没填时的兜底"，与"每个任务一个新目录"并不冲突。
- **目录根默认是家目录下一个可见的 `~/agentdeck-workspace/`**（可用 `--work-root` 覆盖）。
  这条规则改过两次，两次都是"位置不对"：
  第一版是数据目录的**同级**（`<dataDir>/../work`），只在数据目录恰好叫 `data` 时看起来对，
  `--data-dir /tmp/x` 会让产出落到 `/tmp/work`；第二版改成数据目录**之内**
  （`<dataDir>/work`），跑偏修好了，但默认下变成 `~/.agentdeck/data/work/`——
  **藏在点开头的目录里、还埋在 `data` 下面两层**。
  最终定在可见处，因为工作目录装的是 **agent 真正的产出**：使用者要用 Finder 打开、
  要在终端里 `cd` 进去、要把它拖进编辑器。数据目录继续隐藏在 `~/.agentdeck/data`
  （SQLite、锁、blob 日志是程序内部状态，没人需要进去看）；
  **产出放在使用者找不到的地方，等于没有产出。**
  另外：核心（`startDaemon`）的兜底是**数据目录之内**的 `work/`，绝不碰家目录——
  否则任何一处忘了传 `workRoot` 的测试都会往使用者家里写东西。可见的那个默认值由 CLI 给出，
  因为"工作目录放哪"是面向使用者的产品决定。
- **根目录一改就迁移旧目录**：自动目录的路径是**算出来**的
  （`<workRoot>/<subjectType>-<subjectId>`），不是记在 run 里查出来的——这正是重试能
  "接着做"的原因，代价是根一改，旧任务的目录就换了地方，重试会得到一个空目录，
  看起来像上次的产出丢了。所以改根必须连带把旧目录搬过去（`migrateLegacyWorkRoot`）。
  只在完全安全时搬：新根不存在或为空、旧根非空、`rename` 成功；搬不动就只警告、
  **不删源**。用 `rename` 而不是"复制+删除"——复制到一半断电会留下半成品。
- **在受理时创建**而不是执行时：提交后立刻能看到它要去哪儿（FR-BRIDGE-06 先落盘再受理）。
- **`#run` 里一律读 `run.workDir` 而不是 `req.workDir`**：前者是已解析并落盘的权威值，
  后者现在可能压根不存在。散落在调用点的目录计算正是这次要收掉的东西。
- **`workDir` 在协议里变成可选**，页面把它收进「高级」折叠区。空字符串与"没指定"
  是两件事，所以页面在为空时**不带这个字段**，而不是传一个空串。

### 15.10 skill 安装：三种来源、一条"必须有 SKILL.md"的规则

**来源有四种，出口一个半。**（前三种都走同一个安装出口 `POST /api/skills/install`；第四种「本机技能目录」是**对账式读入**——`GET/PUT /api/skills/local-dirs`，只认自己那条 `localdir:` 记录，不进安装接口） 本地目录、GitHub 链接、远端目录条目——三者都走
`POST /api/skills/install`、同一套校验、同一套同名冲突规则。这样"从哪装"不会改变
"装成什么"。

**① 一条规则统管三种来源：没有 `SKILL.md` 就不是技能。** 技能是靠"把目录摆对"让 CLI
自己发现的（FR-CLI-19），目录里没有它，技能永远不会生效——而使用者会以为自己装好了。
所以缺了当场拒绝，并把该目录**实际有什么**列出来（否则他无从下手）。两处细节是踩过才想到的：

- **大小写**：`skill.md` 在 macOS 上能被 `readFile('SKILL.md')` 读到（文件系统不分大小写），
  于是"在 mac 上装得上、在 Linux 上装不上"。所以显式判别并说清，而不是跟着 mac 一起碰巧；
- **空文件**：空的 `SKILL.md` 同样不会生效，所以也算"没有"，而不是"有但内容为空"。

**② 支持文件要一起走完**（`Skill.files`，UTF-8 文本）。这条曾经在**四条路**上断过：注入时
只写 SKILL.md、提交 run 时把 `files` 写死成 `{}`（4 处）。表现是同一个技能"手动跑没问题、
审核跑就找不到它引用的脚本"，且没有任何报错。现在有两条测试分别盯着"提交路径"与
"daemon 自己派生的路径"（报告触发的审核），都做了变异验证。

`Skill.files` 做成**可选字段**而不是新版本：整条记录以 JSON 存（`skill.json` 列），读回来是
`JSON.parse(...) as Skill`——**读取路径上没有 zod 校验**，所以加可选字段对老数据完全安全，
不需要迁移、也不需要动存储格式版本。只收文本：二进制在安装时就拒绝并列出来。

**③ daemon 第一次对外发请求，边界写死在 `skill-source.ts`。** 此前 daemon 一个对外请求都
不发（D19/D20）。要做"给一个 GitHub 路径"就必须让它自己下载：本地目录路径页面读不到，
而"下载到本地"本来就发生在 daemon 这台机器上。

但**只放开 GitHub 的三个主机，不做通用 URL 下载器**：通用抓取等于让一个本地服务替别人访问
任意地址（SSRF——内网、云元数据、本机其它端口）。做对它需要 IP 段判断、DNS 重绑定防护等一整套，
不该被"顺手支持一下"带进来。除主机白名单外还有：只允许 https、**每一跳跳转都重新校验主机**
（否则一个 302 就绕过了白名单）、限单文件/总量/文件数/超时、响应体带上限地读（超限要真的
`cancel()` 掉下载，而不是读完了再判断）。

**④ 这条例外不涉及 agentdeck 的远端服务**：远端目录那条路仍然是"页面取好内容再交给
daemon"。D20 原样成立。

**⑤ 动作子集不从前言里读。** 一个从 GitHub 装来的技能如果在自己的 frontmatter 里声明
`allowed-actions`，那就是**自我授权**——而白名单的意义正是限制它能触发什么。所以默认只有
`comment.create`（最小权限），要放宽必须由使用者在界面上显式勾选。
（⚠️ **D40 收口之后 skill 上根本没有动作子集了**：那份白名单搬到了审核者身上
（`Agent.allowedActions`，见 §15.28），所以"自我授权"这条风险从源头消失了——
装进来的包再也不能声明自己能改什么。这一段留作历史。）

**⑥ 一次真实事故催生了一条机器检查。** 写这组测试时，某条用例的 `finally` 里被写成了
`cleanup(tmpdir())`——而 `cleanup` 是 `rm(dir, {recursive: true, force: true})`，也就是说
跑一次测试就会去递归删掉操作系统的临时目录。它确实执行了、也确实抛错了（那条用例因此报了
一个看起来毫不相干的失败），磁盘上的东西侥幸还在。

**侥幸不是设计**：同样一行代码换个平台、换个权限状态，结果可能就是清空使用者的临时目录。
所以有了 `tests/test-safety.test.ts`：任何递归删除都不许以 `tmpdir()` / `homedir()` / 根目录
为目标，测试文件里根本不该出现 `tmpdir()`（一律用仓库内的 `.cache/test-tmp`）。这条检查
本身也做了变异验证——**第一版它抓不到这个写法**，因为它只匹配 `rm/rmdir/rimraf`，而事故那行
里根本没有这些词，用的是本仓库的包装函数 `cleanup()`。守卫抓不到真实事故就是装饰品，
所以它现在同时匹配底层函数名与本仓库的包装函数名。

### 15.11 远端目录条目：版本一致说「已安装」，有新版本说「更新」

**这条推翻了先前"不做版本管理、不比较新旧"的说法。** 那个说法的出发点是 FR-REG-03
（不做版本管理、不检查更新），本身没错——错在它**没有配套的界面行为**：daemon 对同名
一律拒绝写入（这条是对的，避免"下载顺手覆盖了你自己的东西"），而界面**不做任何比较**，
于是只要本地有同名条目，点击的结果永远是一句"已有同名 skill……确实要替换请显式传
overwrite: true"。

两种最常见的意图因此都无法表达：

- **本地装的就是目录里那一版** —— 本该说"已经安装"，结果每次点都像出错；
- **目录里是新版本** —— 本该有个「更新」动作，结果使用者只能自己猜"我是不是该勾那个替换"。

**"不比较新旧"最终变成了"你永远无法从界面拿到目录里的新版本"。**

所以加一个 `version` 字段，并把比较做成界面上的四种状态（`apps/web/src/lib/skill-catalog.ts`，
纯函数、有测试）：

| 本地 | 目录 | 按钮 |
|---|---|---|
| 没有 | — | 安装 |
| 有版本，且相同 | 同一版 | **已安装**（禁用） |
| 有版本，目录更新 | 新版本 | **更新到 x.y.z** |
| 有版本，本地更新 | 旧版本 | **退回 x.y.z**（说清是往回退，不叫更新） |
| **没有版本** | — | 替换本地同名（说明来源不同、我们不知道是不是同一份内容） |

几处刻意的取舍：

- **`version` 单独一个字段，不从 `sourceRef` 里正则解析。** 版本确实藏在
  `remote:general-review@1.0.0` 里，但 `sourceRef` 是**给人看的来源标识**。解析一个展示
  字符串等于偷偷建第二套真相：哪天改一下它的格式，版本比较就**静默失效**。
- **认不出的版本号返回"无法比较"，不猜大小。** 目录里的版本是发布者写的字符串
  （`2024-05`、`beta` 都可能），猜一个大小会直接变成界面上一句错的"这是更新"。
  此时按"版本不同 ⇒ 可更新"处理，并把两个版本号都显示出来让使用者自己看。
- **本地那条没有版本时不说"已安装"。** 从路径/GitHub 装的和本机自建的都没有版本，
  我们**不知道**手上这份是不是同一份内容；说"已安装"就是替它背书，而使用者会因此不再去装。
- **降级不叫更新。** 远端版本更低时说"退回"，并在提示里写明这是往回退。
- **`overwrite` 只在自己明确要动本地已有东西时才带。** 新装永远是 `false`——
  `overwrite` 是"我知道我在覆盖"的确认，不该被顺手加上。这条规则由那个纯函数统一给出，
  界面不自己拼，因为"漏了被拒 / 多加了乱覆盖"正是这里最容易错的两种。

**老数据的回填。**（⚠️ D38 把内置那条与这段回填逻辑一起删掉了，留作历史。）`version` 是后加的字段，使用者已有数据目录里那条内置 `general-review`
是加字段之前播种的、没有版本——不回填的话界面会显示「替换本地同名」，恰好把最该显示的
那句话挡掉。所以启动时回填一次，判据**刻意很严**：slug 相同 + `source === 'local'` +
`sourceRef === null` + **正文与内置模板逐字节相同**（内容被改过就不认）。最后一条是关键：
不检查内容就回填，等于替一份可能是别的东西的文件背书。回填只补版本、**不动正文**，并且
**会说一声**——它改了使用者的数据。

**一次静默失效。** 把那份正文提成常量时，我顺手丢了一句里的"只有"两个字，于是"逐字节相同"
永远不成立，**回填静默地什么都没做**（表现是版本一直为空、界面永远显示"替换同名"，没有任何
报错）。发现它靠的是去真机上核对数据，而不是靠测试——所以现在有一条**内容指纹测试**钉住
这份正文：改动它就会失败，并在失败信息里列出必须一起确认的两件事（老数据还认不认得出；
`apps/remote/src/server.ts` 里那份要不要同步改）。指纹测试不是"防止有人改文案"，
而是**强制一次有意识的决定**。

### 15.12 技能的去留：三版规则、一条不变的底线；任务详情里"接着沟通"

**这一节的结论被换过两次。过程留着，因为"为什么换"比"现在是什么"更容易被后来的改动踩坏。**

| 版本 | 规则 | 为什么被换掉 |
|---|---|---|
| ① | 跑完就删 | **删除的依据是进程内的数组**。daemon 崩溃或被 kill 之后那份记忆就没了，残留的技能文件**会被以后的 run 继续发现**。实测在 `~/.agentdeck-workspace/run-01M2SANDBOX…/` 里就躺着一个残留的 `general-review`——也就是说：**你把这个技能从 agent 上摘掉了，它却还在生效**。这类问题几乎不可能自己发现 |
| ② | 保留 + 归属清单对账（`.claude/skills/.agentdeck-managed.json`） | ①的两个坏结果里，"看不见了"被使用者点名要求修（"任务的工作目录是这个任务的产物之一，我要能进去看它是在什么标准下干活的"）。但这留下了一堆不是产出的东西；而且**审核与执行共用一个目录**之后，两边的技能会互相摘（执行者下一次 run 的 prune 会把审核者的标准删掉） |
| ③ | **还是收掉**（当前，D30） | 使用者放弃了"保留"那条要求：**工作目录只该装 agent 的产出**。而"它是在什么标准下干活的"改由别处承担（每次 run 的上下文记录里带着技能清单，审核那次还带着标准全文；标准的全文也一直在技能记录里，界面「看标准」随时能看） |

**三版都不变的那条底线**：**能不能删由落盘的归属清单决定，不由调用方给的名单决定。**
`removeInjectedSkills` 只删清单里记着的，传进来的名字只用来**收窄**范围——所以即使内存里
的数组错了、run 记录串了，也删不到使用者的东西。这条比"删得干净"重要得多。

每次 run 前对账（同步）、run 后收尾（清理）用的是同一份清单：

| 情况 | 处理 |
|---|---|
| 这次要的 | 写下去（覆盖我们上次放的那份） |
| 清单里有、这次不要 | **删掉**——这就是崩溃残渣的自愈 |
| run 收尾 | 清单里属于本次的那些 ⇒ 收掉；清单空了连它一起收掉，目录空了再 `rmdir`（里面还有别人的东西时它会失败，那正是我们要的） |
| 同名目录、但不在清单里 | **报错，绝不覆盖**：那是使用者自己放的 |

⚠️ 顺序也有讲究：**清单先写、技能文件后写**。这两步之间崩掉时，"清单有、盘上没有"下一次
同步 `rm -rf` 一个不存在的目录（无害）；反过来则是"盘上有、清单里没有"，会被下一次同步当成
**使用者的东西**而抛 `SkillCollisionError`，让 run **永久失败**。

**上下文文件（`CLAUDE.md`）的规矩是分人的**（⚠️ **这一半已被 D29 取代，见 §15.16**：
现在我们根本不写这个文件了——它完全归使用者）：

| 文件 | 处理 |
|---|---|
| **我们造的**（原本不存在，通篇只有我们的块） | **保留**——它记录了这次任务被交代了什么，接着沟通时上下文也还在 |
| **使用者的**（他自己的 `CLAUDE.md`，或任务指向了他的仓库） | **逐字节还原**，把他原有的内容一字不差地还回去 |

判据用的是 `removeContextBlock` 已有的**结构检查**（`deleteFile` = "通篇只有我们的块"），
不引入任何新状态——进程中途崩过、记录丢了也依然判得对。**"不改写别人的文件"这条底线没有变**。

最后一条是刻意的。`writeSkill` 原来是 `mkdir -p` + `writeFile`，会**静默改写**使用者的同名
技能，跑完还会把它删掉；而 `skill-injection.ts` 的注释一直写着"使用者自己放在 `.claude/skills`
里的技能不能动"。现在宁可让这次 run 失败并说清怎么改（改名或移走），也不动别人的文件。

清单放在技能目录**之内但不是一个目录**，所以 CLI 的技能发现（扫 `<skills.dir>/<name>/SKILL.md`）
不会把它当成技能。清单读不懂时当作"我们什么都没放过"——**宁可少删**，不能因为读不懂清单就去
删使用者的东西。

**任务详情里的「继续沟通」（接着上一次说）。** 使用者的原话："在任务完成后，我可能不满意结果，
我需要可以在任务细节页面上直接再进行沟通，以进一步完成任务。"

实现是**同一任务上再起一条 execute run + `resumeFromRunId` 指向上一次**，而不是"给已有 run
追加消息"：一次 run 的产出是**不可变快照**（消息流按 seq 单调追加），往里塞新输入会让
"它当时收到了什么"不可回答，审计链随之断掉。

三件事因此自动成立，不需要新机制：
- **工作目录相同**（D27 按任务分配）⇒ agent 上次留下的文件还在；
- **会话被恢复**（FR-CLI-06 的 `resumeFromRunId` → 取上一次的 sessionId → `--resume`）⇒
  是"接着上次说"，而不是"从头再来"；
- 跑完仍走既有的自动串接审核。

⚠️ 会话恢复是**尽力而为**：CLI 可能拒绝（版本变化、会话过期），此时执行器会在日志里说明
"恢复被拒、本次没有上文"，而不是假装接上了——FR-CLI-06 要求区分"恢复被拒"与"无法判断
是否被拒"，两者的话术必须不同。

### 15.13 跑完之后看「最后结果」：左结论 / 右产出文件

**同一块地方在两种状态下显示同一种东西是错的。** 执行中要的是"它现在在干什么"（原始流水、
按 seq 追加）；跑完之后要的是"**它做成了什么**"——那是结论，不是流水。原来两种情况都显示
`实时输出`，等于让使用者自己从几十条工具调用里翻出最后那段话。

现在：跑完自动切到**最后结果**，左右两栏——左边是最后那段产出（按 Markdown 渲染），
右边是工作目录里的文件；「看完整日志」随时能翻回原始流水。判据是 run 的终态，
刷新时按 `runId` 取 `$runs` 里**最新的那一份**（`activeRun` 可能还指着旧对象，
状态早已从"进行中"变成"跑完了"——不重取的话这个切换永远不会发生）。

**Markdown 渲染器自己写**（`apps/web/src/lib/markdown.ts`）：前端运行时依赖是零，
为一个视图引 `marked` 就把这条约束破了。而引库也不自动等于安全——渲染出来的 HTML
要直接插进页面（`{@html}`），任何"允许原始 HTML 透传"的实现都等于把 XSS 的门打开。

安全规则只有一条，但**顺序**很要紧：**先摘出结构、再转义剩下的文字、最后拼我们自己的标签**。
第一版写成"先整段转义、再在转义后的文本上拼标签"，于是每一处插回去的东西都被二次转义：

- 行内代码 `` `<img onerror=x>` `` 显示成 `&amp;lt;img …&amp;gt;`；
- 图片 alt 里的引号变成 `&amp;quot;`；
- 图片/链接的 `src`/`href` 是从**已转义**文本里取的，路径里带 `&` 会被当成 `&amp;`
  交给取文件的接口，于是取不到。

**这三个 bug 都是测试抓出来的**，而且都是"顺序错了"这同一个根因。另外两条边界：
原始 HTML 一律不认（`<script>` 会原样显示成文字）；链接只允许 `http(s)`/`mailto`，
其它协议直接丢掉、只留文字。

⚠️ 变异验证在这组测试里抓到**两次"测试通过但理由不对"**，值得记下来：

1. 「兄弟目录不能被误判」那条只断言"被拒"——而实现里有两道检查，第二道恰好也挡住了
   这个例子。于是把第一道改成经典的错写法（`startsWith(root)` 而不带分隔符），用例照样过。
   改成断言**理由**（"跑出了工作目录"）之后才真正钉住；
2. 「`javascript:` 链接被丢掉」那条钉不住协议检查——没有 `resolveAsset` 时，另一个分支
   （"取不到地址就只留文字"）恰好也挡住了它。补一条给**最坏的** `resolveAsset`（原样返回）
   的用例才钉住。

（还有一次是我把变异打在了**错的地方**：改的是"拿到 null 之后怎么办"，而协议检查在
`safeHref` 里面。变异没红不代表测试没覆盖，也可能是变异本身无效——这两件事必须分开判断。）

**工作目录文件接口**（`GET /api/runs/:id/files`、`GET /api/runs/:id/file?path=`）：
读的是使用者工作目录里的文件，路径来自查询参数，所以两道检查缺一不可——`..`/绝对路径
（且必须**按分隔符**比前缀，`/work-other` 不是 `/work` 的子路径）与**软链**（比 `realpath`）。
而且因为页面与 daemon **同源**、这些文件又是 **agent 写的**，每个响应都带
`Content-Security-Policy: sandbox`：一个带脚本的 `html`/`svg` 被当文档打开，否则就等于
把它变成了操作本机 daemon 的入口。

### 15.14 阶段列去重、智能体主从布局、安装 skill 收进抽屉

三处都是**使用者看着界面点出来的**问题，共同点是"同一句话/同一个动作在两个地方各说了一遍"。

**一、「待审查」下面再写「等待审核」。** `StageInfo` 里有两个字段：`detail` 是完整描述
（当初为看板列头写的），`note` 是"标签之外还值得说一句的东西"。列表里的阶段单元格渲染的
是 `detail`，而左边的标签已经写着"待审查"——于是同一句话出现两次。

改法不是逐个调用点特判（那种特判迟早会漂），而是在**数据层**把额外信息判出来、界面只管
`note` 有没有值：待审查 + 审核真的在跑 → `审核中`；待审查 + 排队/没派 → 空；执行中（真在跑）
→ 空；等目录释放 → `排队中（工作目录被占用）`；一次都没跑过 → `还没开始执行`（否则"执行中"
这个标签会说谎）；已审查 → 空。

**顺手把 `detail` 整个删了**：撤掉界面引用后它在前端**一个消费者都没有**（看板列头用的是
列定义里的静态 `col.hint`）。它剩下唯一的作用，就是把刚被点掉的那句话继续养在数据层，等着
哪次改动顺手渲染出来、重复原样长回来。删掉之后"同一句话只准有一个出处"成了类型层面的事实，
并留了一条 `Object.hasOwn(info,'detail') === false` 的断言当闸门（与 `RunSummary.lastSeq`
被删掉时留下的断言同一个思路）。删除没有丢失任何使用者可见信息：原 `detail` 的取值或等于
`note`、或就是标签本身、或与标签同义。

**二、智能体页点一个 agent 会把整页换掉、列表消失。** 任务页对同一个动作早就是"左列表右详情"
了，两个页面给出两种反应没有道理。现在两个视图共用 `.split-layout`（那套 CSS 本来就是按
"两个视图共用"写的，连 `.split-layout.with-detail .detail-pane .back` 这条隐藏返回按钮的规则
都已经按 `.back` 写好了）。

- 左栏 = 清单 + Runtime 概览 + 环境问题：这三块改版前就是"列表下面的一段"，原样搬过去；
  右栏只表示**选中的那个 agent**，语义不混。
- 清单从六列表格改成竖排卡片——26rem 的栏里六列只会互相挤；字段一个没少，顺手把"整条可点"
  与选中态表达清楚了。Runtime 同理改成一张卡一个 runtime（`undeclared` 的解释与
  `--verify-runtime` 提示都留着）。
- 窄屏（≤72rem）一次只显示一栏，选中详情时列表隐藏、返回按钮出现，与任务页一致。

**三、安装面板插在页头和列表之间。** 打开一次就把 skill 列表推到看不见的地方——而装完 skill
第一件想做的事正是看它有没有出现在列表里。改成右侧抽屉（复用全局 `.drawer`）：浮在列表上，
装完关掉还在原地。主操作「检查并安装」进 `.drawer-foot` 常驻底部，反馈 notice 正好落在按钮
正上方。页签条里那个和抽屉头部重复的「关闭」删掉。本视图自己的抽屉不在 `App.svelte` 的
`$openDrawer` Esc 处理里，所以补了 Esc 与点背景关闭——顶栏那两个抽屉能 Esc 关，同一页里两种
手感是说不通的。

> ⚠️ **2026-10 改回去了（但换了做法）**：使用者报「技能和工具的安装都是右侧弹框，需要改成
> 类似新建智能体那样，在主区显示，而不是弹框」。所以安装面板**不再浮在列表上**，而是
> **主区里的就地面板**（`.main-panel`：头部 + 正文 + 底部三段，与 `.pane-*` 同一套指标）：
> 打开 = 主区换成面板、列表**整块让开**（不是被推下去，也不是被挡住），头部给一个**一直
> 可见**的「← 返回技能列表」（`.back-to-list` 那个全局 class 在宽屏是 `display:none`，
> 这里不能用它）。没有遮罩、没有 `role="dialog"` / `aria-modal`、`position` 不是 fixed
> ——后面那三样是"它是对话框"的证据，而它已经不是了：读屏器不该被告知后面那块不可达。
> 当初"列表会被推到看不见"的顾虑由**结果块**兜住（装了哪些文件、哪个 slug、来源逐条列出来），
> 返回列表时它已经刷新过。两个视图共用这套 class（`Tools.svelte` 同一形状），词条
> `skills.backToList` / `tools.backToList`。探针里那几条"抽屉在右侧 / 宽 46rem / 有遮罩"
> 的断言随之改成"**在主区内容盒里、不是浮层、取代了列表、返回可见且点得回去**"。

**怎么确认它真的排对了（这一轮做到的程度）**：我没有视觉能力（vision 工具在本会话不可用、
`read_image` 也读不了图），所以"看起来对不对"必须换成"量出来是多少"。三件工具凑出了这个能力：

1. `chrome --headless=new --no-sandbox --dump-dom <url>` 抓**加载完那一刻**的 DOM；
2. **同源探针页**：把它放进 `apps/web/dist/`，里面用 `<iframe>` 装真应用、用**真实点击**驱动它，
   再把自己读到的 `getComputedStyle` 写进自己的 DOM——这样 `--dump-dom` 连"点完之后"的状态和
   几何值一起抓回来；
3. 这个环境里 Chrome **跑完不会退出**（`--dump-dom` 打完就挂着），所以必须丢到后台跑、
   等一会儿再读文件、然后只 kill 自己那个 user-data-dir 的进程（**不要**用宽匹配的 pkill——
   早先我用 `pkill -f "Google Chrome"` 把使用者本人的浏览器一起杀了）。

这套办法已经**收进仓库**成为一条单独的检查：`tools/layout-probe/`（`pnpm run probe:layout`，
43 条断言，见那个目录里的 README）。它不进 `pnpm run check`——它需要真的 Chrome 与真的 daemon，
进套件就等于让所有测试依赖"这台机器装了浏览器"，那是 NFR-T-01 反过来走。

量到的值（1280px 宽，真数据、真点击）：

| 检查项 | 结果 |
|---|---|
| 未选中：`.list-pane` / `.detail-pane` | 都 `flex`（右栏显示"从左边选一个智能体"） |
| 点第一条：`.split-layout` 的 class | `split-layout with-detail` |
| 点第一条：`grid-template-columns` | `416px 624px`（26rem 清单 + 剩余给详情） |
| 点第一条：右栏是否真的渲染出详情 | 是；选中卡片带 `.active` |
| 宽屏下详情里的返回按钮 | `display: none`（列表就在左边，不需要它） |
| 收窄到 900px（选中态） | 左栏 `none`、右栏 `flex`、返回按钮 `inline-flex` |
| 点返回之后 | class 回到 `split-layout`，右栏 `none`，左栏回来 |
| 抽屉未打开时正文里还有旧面板吗 | 没有（`.install-panel` = false） |
| 抽屉：class / 宽度 | `drawer wide` / `736px`（46rem）；新建智能体用 `drawer wider` / `928px`（58rem，D48） |
| 抽屉：底部按钮 | 「检查并安装」，`.drawer-foot` 的 `bottom` = 视口高（贴底） |
| 抽屉：页签条里重复的「关闭」 | 没有 |
| 抽屉：Esc | 关闭成功 |

另外 `--dump-dom` 抓的两个**数据态**页面也留下了证据：任务清单那次的 DOM 里，
`A-从没跑过` 显示为「执行中 + 还没开始执行」，而 `C-审核在排队` / `B-执行中` 显示为
「待审查」**后面什么都没有**——使用者点名要去掉的那句「等待审核」在整个渲染结果里
一次都没出现；智能体那次的 DOM 里 4 张卡片、2 张 runtime 卡（含 `未挂 skill` 红字与
`证据：verified` / `未声明`）都在。

⚠️ **这套检查自己被抓到过一条"空过"的断言**：任务页那条"「等待审核」出现 0 次"最初恒真
——夹具里一条任务都没有，表格一行不渲染，把「等待审核」塞回模板照样全绿。变异测试（把实现
改坏，看它红不红）发现的，补上"先造一条不指派给任何人的任务"之后才真的在检查。
同理，这套断言收进仓库前也逐条做了变异：去掉 `with-detail` 绑定 → 5 条红；把 `:has()` 选择器
写错 → 4 条红；把重复字样放回模板 → 2 条红；抽屉宽度退回 20rem → 1 条红；拆掉 Esc → 1 条红。

⚠️ 仍然**没验**的：真机上的观感（间距、密度、暗色下的对比）——这只能你自己看一眼。

### 15.15 三件"看着没坏、其实错了"的事：审核落在空屋子、列表行高、上下文注入

**一、审核 run 与执行 run 不在同一个工作目录（真实缺陷，已修）。**

需求原话：「执行 Agent 和审核 Agent 虽然隔离过程，但**必须保持在同一个工作目录中**」。

原来不是。工作目录按 `subject` 自动分配（D27），而审核 run 的 subject 是
`{type:'run', id: 被审的runId}`——于是自动分配给出 `<workRoot>/run-<被审的runId>`，
执行者用的却是 `<workRoot>/issue-<任务id>`。**两个目录。**

后果不是报错，而是审核**没有依据**：审核者手里只有报告正文那一段转述，产出文件、
中间结果一个都看不见，却照样会给出一个看起来很正常的判决。

修法：`resolveWorkDir` 增加一条 `inheritFrom`，位于"显式指定"之后、**"agent 默认目录"
之前**——审核的前提是看得见被审的东西，所以它与 agent 默认目录冲突时继承赢，而冲突
会写进 run 日志（静默忽略操作者配过的目录是不可接受的）。继承值取**那条 run 上真实
记着的 workDir**，不是按 subject 重算一遍（执行者的目录可能来自显式指定或 agent 默认，
重算等于在猜）。解析仍然放在执行器里，因为提交 review 的路径不止一条（自动串接、
报告摄取、判决不合规的重试），漏一处就是一间空屋子。

`report` 类型的 subject **不继承**：那条路径的产出是第三方送来的报告，`Report` 里除
`meta` 外没有指回我们任何对象的字段，没有"同一间屋子"可言。

测试断言的是**行为**而不是实现：假后端在执行阶段往工作目录写一个产出文件，在审核
阶段检查自己能不能读到它。变异（把继承拆掉）→ 这条红。只断言"两个 run 的 workDir
字符串相等"就只是在测实现，测不出"审核者眼里有没有东西"。

**二、任务清单的行高被标题长度决定（已修）。**

需求原话：「列表模式下，任务可能很长，当前显示布局会拉很高」。

先量了再说（`tools/layout-probe`）：一个 90 字的标题让**一行变成 191px**。量出来的
列宽是 任务 157 / 阶段 61 / 指派给 62 / 更新于 88——左栏只有 26rem，四列加起来就把
标题挤到 157px，标题一长就换行，一换行整行就高。

中途试过"标题两行截断"：降到 106px，但**别的列还在换行**（61px 的阶段格里要放下
"待审查"+"还没开始执行"）；再试"只截标题两行"：80px，可**短标题那行是 61px**——
行高仍然跟着标题长度变（差 19px）。

结论是算出来的：四列在这点宽度里放不下这些信息。所以改成**两行的行**——标题独占
一行（宽度 157px → 342px），阶段/指派给/更新于 收进第二行的元信息；标题单行省略，
因此**行高与标题长度无关**（长短两条夹具的行高差 0px，65px 封顶，原来 191px）。
完整标题在 `title` 提示与右栏详情里（探针另有一条断言：点一行之后右栏拿到的是完整标题）。

断言写的是**性质**而不是魔法阈值：造一长一短两条夹具任务，断言两者行高相同。
写"不超过 64px"这种阈值既会被无关的间距调整弄红，又挡不住"两个都是 100px"。

**三、上下文注入的现状（回答问题："任务都是通过 CLAUDE.md 注入的，是否合理"）。**

先摆事实（都在代码里核对过）：

| 东西 | 去哪儿 |
|---|---|
| 任务正文 | **两处**：CLAUDE.md 受管块的 `## 要做的事`，**以及** stdin 的 user turn（`buildClaudeInput`） |
| 审核 | 待审内容 + 审核标准（整篇 skill 正文）+ 判决 schema + 护栏 → CLAUDE.md；stdin 只有一句"请审核…" |
| skill | 文件写进 `<workdir>/.claude/skills/`；CLAUDE.md 里只列 slug（省 token 的既有决定） |
| agent 自己的 instructions | **哪儿都没进**（`ExecOptions` 里根本没有这个通道） |
| 跑完 | 块从**当时那份内容**里摘掉，块外原样保留；我们自己造的整份文件留着 |

合理的地方：① 不依赖 CLI 旗标——CLAUDE.md 是 CLI 自己的项目记忆机制，语义由它定义，
而旗标名各家不同、我们没验证过（runtime 表存在的理由就是这个）；② 与 skill 的投递
方式同源（skill 本身就是文件发现），两者生命周期一致；③ 恢复/重试/继续沟通三条路径
吃的是**同一份盘上的事实**，不必在每个入口重拼一遍（那正是本项目"接口都在、就是没
接线"的高发区）；④ 审核标准是"参考资料"而不是"用户指令"，放文件里是被当作环境读，
塞进 user turn 会与被审内容抢位置。

不合理 / 代价：① **前提没验证过**——我们从没证明 CLI 真的读了它（FR-CLI-40 至今空着，
而测试里读 CLAUDE.md 的是我们自己的假后端）；② 任务正文双投递，长 prompt 每轮付两遍；
③ `agent.instructions` 是**死角**：界面能填能存能显示，运行时被丢掉——"看起来生效了"
是最糟的状态；④ 写使用者文件这件事本身要一直小心（已有块标记、逐字节还原、结构判据，
比"记在内存里"稳）；⑤ 盘上的块只反映**最近一次** run，共享目录之后更是如此。

### 15.16 注入通道的定案（D29）：单一通道 + 我们自己的上下文记录

**结论**：任务正文 / 待审材料 / 判决契约 / 护栏**全部进"第一句话"**（CLI 自己的 prompt 通道，
`stdin-ndjson` 或 `argv`，由 runtime 表声明）；~~同一份文本再**留一份我们自己的记录**
`<workdir>/.agentdeck/context/<runId>.md`（每 run 一个、谁都不覆盖谁、**保留**）~~ ——
**已撤（2026-09）**：执行/审核都不再写副本文件，"回看它被交代了什么"看 run 日志
（①②③ 分开带标签、不截断）。
**不再往使用者的 `CLAUDE.md` 写任何东西**——它从此完全归使用者。

#### 为什么（三条硬理由）

1. **最要紧的内容，原本走在唯一没被验证过的通道上。** 判决 schema 与围栏是**硬契约**（看不到
   它，提取就失败，整条判决链降级），而它放在 `CLAUDE.md` 的受管块里——`FR-CLI-40` 至今空着：
   **我们从没证明 CLI 读了它**。反过来，被证明有效的恰恰是 prompt：run 能跑起来、能产出文件
   全靠它。把唯一的硬契约押在未验证通道上，这个设计缺陷比"双投递"严重得多。
2. **写使用者文件那一整类风险归零。** 截断事故、逐字节还原、块标记与 `repaired` 分支、
   "共享目录里摘掉另一次 run 正在用的块"的竞态（§15.15 第 4 条）、每个 runtime 猜上下文文件名
   （`CLAUDE.md` / `AGENT.md`）——**全部随这个决定消失**。
3. **输入成为 run 记录上的唯一不可变事实。** 现在"模型当时收到了什么" = 一份可变文件的当前
   状态 ∪ 一条消息；而 `Run` 记录上**根本没有 prompt 字段**，日志里的输入还截断到 2000 字。
   单一通道之后，输入就是那次 run 的输入：字节级可查、可哈希——顺带把审计里那个恒为 `null`
   的输入哈希补上。对一个定位是"可审核"的产品，这条是产品级的。

#### 为什么不是另外两种方案

- **全都塞回 `CLAUDE.md`（当前形态）**：见上面第 1、2 条。
- **"材料进 prompt、规则留文件"（我在这轮讨论里先给出的折中）**：那是**伪减法**——仍然要维护
  两种投递语义，而契约还是押在未验证通道上。而且我当时给它记的两笔功劳都不成立：
  ① "常驻规则每轮重读、不受历史压缩影响"是**未验证的 CLI 内部行为**（同一段话里我自己就标了
  "没验证过细节"），把它当收益去压一个具体成本是记账错误；② "规则与材料分属不同通道、抗注入
  更好"是**虚的**——两者本来就在同一个文件的相邻小节里，同一条文本流。文件从来没有提供通道级
  的信任边界。
- **prompt 里让 agent 去读 `RULE.md` 之类的文件**：那条**可重读性**的价值是真的（长跑触发上下文
  压缩后，磁盘上的文件还能自己再读一遍，而且这条不依赖任何未验证的 CLI 内部行为）。但把**硬
  契约**藏到"需要读一跳"之后不划算：契约只有几百字符，体积上没有任何理由；换来的是"送达从必然
  变成取决于它是否照做"，而失败**不可靠地被发现**（生成侧可以跳过读取照样回答）。所以取它的长处、
  不取它的短处：**同一份文本两个用途**——prompt 保证送达，我们自己的文件保证可重读与可查。

#### 与 D30（技能跑完收掉）的关系

技能**仍然是文件**（CLI 原生的目录发现机制，装完要在工作目录里被它自己扫到），只是 run 收尾时
收掉。于是定案之后**剩下的唯一未验证假设只有一条**：CLI 会不会发现自己目录下的技能文件。
而它即使不成立，**审核也不再受影响**（标准就在 prompt 里），只影响执行者的技能能力——
风险面从"审核契约"缩到"执行者的一项软能力"。

#### 可证伪条件

`FR-CLI-40` 那个暗号实验仍然值得做，只是目的变了：在块/技能文件里放一个只有它才有的暗号，
让任务复述它。**如果实测证明"块确实被读、且压缩后会重新注入"**，"常驻规则"就从假设变成证据——
那时我仍不会回到"写使用者的 `CLAUDE.md`"（成本那侧不变），但会认真考虑给规则一个**我们自己的**
常驻通道（自建文件，或一条按 runtime 验证过、写进 runtime 表的 system prompt 旗标）。
**如果实测是"根本没被读"**——那说明审核标准与判决 schema 一直没送到，这次定案不只是更简洁，
而是修掉了一个**静默失效**。

#### ✅ 已实施（本次）

| 动作 | 落地成什么 |
|---|---|
| 改 | `renderFirstSentence()`（`packages/agent-core/src/first-sentence.ts`）：身份 → **你的角色**（agent 的 instructions，以前从不送达）→ 材料 → 技能清单 → 护栏 → **判决契约放最末** |
| 新增 | 第一句话**整段进日志、不截断**（它是那次 run 唯一不可变的事实） |
| 新增 | ~~`<workdir>/.agentdeck/context/<runId>.md`（每 run 一份，不覆盖、不删除）~~ —— **已撤（2026-09）**：不再写副本文件，日志即唯一核对处；~~`resumeFromRunId` 时第一句话里附一行"上一次的上下文"指针~~（指针机制随之失效，重试材料改从 run 记录取，见 §15.37 缺陷二） |
| 删 | 受管上下文块机制整个删掉：`context-block.ts` + 它的测试 + 执行器里的注入/还原/身份判据 + `runtime.descriptor.contextFile` + 审计字段 `contextBlockHash` |
| 改 | `managedPathsFor()`：注入物 = 该 runtime 的技能目录 + CLI 状态目录 + `.agentdeck/**`；`CLAUDE.md` **不再**算平台注入物（它是使用者的） |
| 拆掉一整类风险 | 截断事故、逐字节还原、崩溃修复分支、"摘掉别人正在用的块"那个竞态——**在结构上不存在了**（每个 run 有自己的文件，谁都不覆盖谁） |
| 测试 | "跑完我们造的 CLAUDE.md 保留"改成"副本在 `.agentdeck/context/`、且**绝不创建 CLAUDE.md**"；新增"使用者已有的 CLAUDE.md 从头到尾一个字都不改"（比原来的"注入再还原"更强：连打开都没打开） |

**顺带接线三件早就该做的事**（都属于"字段/接口在、路径不在"）：

1. **`agent.instructions` 终于被送达**（进第一句话的「你的角色」段）。此前界面上能填、
   能存、能显示，`ExecOptions` 里却没有这个通道——运行时被丢掉。
2. **技能的 `description` 终于写进 `SKILL.md` 的 frontmatter**。CLI 自己那份技能清单是
   **描述驱动**的，而我们的第一句话只列 slug ⇒ 描述是唯一的路由信号；此前它根本没被
   带到执行侧（`SkillPayload` 里没有这个字段），写出来的 `SKILL.md` 只有 `name`，
   技能基本不会被主动选用。
3. **两个从没被写出来过的失败原因码接上了**：`injection_failed`（同名技能撞车、技能
   超限这类**使用者自己能修**的问题，原来一律记成 `infra_error`，把人往查 CLI 与权限
   的方向带）与 `cancelled_by_user`（注释早就写着会记它，代码却传了 `null`）。

**结论与定案见 §15.16（D29）**：分析列出的四条代价里，第 1、2 条（前提未验证、正文双投递）
直接促成了"改成单一投递通道"这个决定；第 3 条（`instructions` 死角）仍然挂着未接线。

### 15.17 换一个 runtime 会不会坏：把写死的 claude 形状全找出来（D31）

**起因是使用者一个问题**：「如果我换 opencode，是否就会不正常？我期待架构好合理。」

查下来分成两半，结论不一样：

**数据驱动的部分是好的。** 技能落盘目录、上下文文件名、CLI 状态目录、prompt 投递方式
（`stdin-ndjson` / `argv`）、受管旗标、禁改表、基础参数——全都从 runtime 描述表取，
执行器里没有一处 `.claude` 字面量；未知 runtimeKey **大声失败并列出可用项**（不静默回退，
因为"跑的是另一个 CLI"最难查）；描述表有行而适配器没装配 ⇒ 启动时抛错。

**但皮上有五处 claude 形状，而且全都不报错**（这才是危险的）：

| # | 位置 | 换 CLI 后的症状 |
|---|---|---|
| 1 | `review.ts` 的审计：`runtimeDescriptorKey: 'claude'`、`cliVersion: null`、`contextBlockHash: null`，argv 还是按描述表拼的**大概样子** | **审计说错话**：它声称用的是 claude。审计是事后唯一的依据，这是最不该错的地方 |
| 2 | 描述表 `skillDir: string` 必填 | 表达不出"这个 CLI 没有技能发现机制"，只能填一个"它不读"的目录 ⇒ 技能写下去了、**永不生效、且不报错** |
| 3 | `DEFAULT_MANAGED_FLAGS` 是 claude 的拼写 | 新 runtime 忘了声明 ⇒ 按 `--model/--max-turns/--resume` 拼；若那个 CLI 忽略未知旗标，**静默用了默认模型** |
| 4 | 界面 `AgentDetail` / `NewAgentForm` 写死两个 `<option>` + `=== 'generic'` 才提示 | 新 runtime **界面上选不到**；未验证的 CLI 被显示得像验证过 |
| 5 | `workdir-files.ts` 的 `isManaged()` 写死 `CLAUDE.md` / `.claude/**` | 平台注入物在文件栏里被当成 agent 的产出 |

改法都是"把常量换成数据"，没有一处需要新概念：

1. **审计四项接真值**：runtime key 取当前描述符；CLI 版本**探测**（每个 runtime 探一次并缓存，
   读不到就如实 `null`，**不拿期望版本顶替**）；argv 用后端 `onCommandLine` **如实上报**的
   那条（含沙箱包装）；`contextBlockHash` 真算（`#injectContext` 返回它写下去那个块的 sha256）。
2. **技能投递能力位化**：`skills: { kind: 'directory'; dir } | { kind: 'none'; reason }`。
   `none` 时**一个文件都不写**，并在 run 日志里明说"这个 runtime 没有技能发现机制，
   该 agent 挂的 N 个 skill 送不进去，本次只作为标准/参考出现在上下文里"。
3. **`systemPrompt` 是 A/B 档的判据**：`{ flag }` 或 `null`——有它就是 A 档（①② 走 `--append-system-prompt`），
   没有就落 B 档（三块合成一段）。它是描述表里**唯一影响投递形状**的字段。
4. **`managedFlags` 必填**（类型 + `loadRuntimeDescriptor` 运行时再验）：缺省的方向必须是
   安全的那一侧——宁可加载时就报错，也不要替一个没声明过的 CLI 猜旗标。
4. **界面两处改成数据驱动**：选项来自 `/api/identity` 的 runtimes 列表；"未验证"提示按
   `evidence !== 'verified'` 判，并把描述表的 `evidenceNote`（缺什么证据）一起显示出来。
5. **文件清单的 managed 规则从描述符算**：`managedPathsFor(descriptor)` 用
   `skills.dir` / `stateDir` / `contextFile` 三个**已有的**字段，不再写死 `.claude`。

⚠️ **`generic` 表行顺带改成 `{ kind: 'none' }`**：那个 `.agent/skills` 是按公开形状**猜的**，
谁也没验证过它会被扫。按新规矩，"猜它支持"与"确认它不支持"在效果上一样糟。这样还有一个
好处——这条分支因此在**生产表**里被真的走到，不会腐烂成只在测试里存在的能力。

#### 守卫：`runtime-agnostic.test.ts`

整条用例跑在**第二个 runtime** 上（daemon 用 `runtimeKey: 'generic'` 启动，播种的 agent 全部
PATCH 成 generic），然后断言：审核 run 的审计记的是 `generic`、版本来自探测、argv 来自后端上报、
块哈希是真 sha256；以及"声明没有技能机制 ⇒ 一个文件都不写 + 日志里说清"。
变异验证（把审计退回写死 `'claude'` ⇒ 红；无视能力位照旧写文件 ⇒ 红）。

界面那两条由 `tools/layout-probe` 守：runtime 选项必须与 `/api/identity` 的列表一致；
**编辑态**里选到未验证的 runtime 必须出现提示（以前编辑态压根没有提示）。
方法上的教训也记一笔：单看"选项 = 身份列表"这条在**只有两个 runtime 时是空过的**
（写死的两项恰好与列表相同），所以又补了一条会真正会红的——编辑态提示。

### 15.18 任务的执行记录是**时间线**：按发生先后排，并把时间显示出来

**使用者的一句话**：「任务的记录貌似不是按时间顺序排列的，发现审查了 2 次，后面的审查在前面。」

查下来是排序规则的问题。原来 `runsForIssue` 排的是"**执行 run 一组（新的在前）+ 它们的
review run 一组（新的在前）**"——在脑子里想得通（"先看执行、审查在旁边"），但读出来是乱的：

```
一次「执行 → 审核 → 又执行 → 又审核」的任务，标签页排成  e2, e1, r2, r1
                                                        ↑ 后一次审核排在第一次审核前面
                                                        ↑ 而 e1 还出现在 e2 之后
```

现在按 `queuedAt` **升序**排（同刻用 `runId` 兜底保证**稳定**，否则每次渲染顺序可能变，
看起来像"记录自己在跳"）：`e1, r1, e2, r2`。从左往右就是发生顺序。

**光把顺序排对还不够**：那排标签原来只显示 `[状态] [runId 后 8 位]`——**既没有类型也没有
时间**。使用者看不出哪个先哪个后，只能凭感觉，于是"感觉顺序不对"。现在每个标签显示
**类型（执行/审核）+ 时间**（`formatRunStamp`：当天只写时分秒，跨天带月日；完整时间在
`title` 里）。

⚠️ 顺序一改，**取"最新那条"的地方必须跟着改**——原来数组是倒序，`issueRuns[0]` 和
`find(kind === 'execute')` 拿到的是"最新"；改成升序之后它们变成"最早"，会同时踩两处：

- 点开任务默认停在**最早**那次执行（而不是最新的结果）；
- 「接着沟通」会接在**最早**那次执行后面（应该接最新那次）。

两处都改成了 `at(-1)` / `length - 1`，并在代码里写明"这条依赖顺序方向"。
**这类"顺序方向"的隐式依赖，是排序规则最容易被改坏的地方**——所以这次连同
"两次审核的先后"一起写成了断言。

### 15.19 「待人工」是独立的一档，不是「已审查」的一种

**使用者的反馈**：「发现一个问题，审查的结论是 `needs_human`，被标为『已审查』，不合理。」

确实不合理，而且原因很具体：**阶段推导当时只能看到"审核 run 完成了没有"**。
`/api/runs` 只返回 run 的字段，判决结论（`conclusion`）在 `/api/runs/:id/verdicts` 里、
要按 run 单独查。于是无论判成 `pass`、`fail` 还是 `needs_human`，页面上都是同一句「已审查」。

`needs_human` 的语义是**判决自己说了"这事得人来定"**——它没在等人审，它在等**你**。
把它归进"已完成审查"，等于把待办显示成做完了。

改法两处：

1. **数据**：`/api/runs` 的审核 run 带上判决摘要（`status` / `conclusion` / `escalateReason`），
   只给最新那一份。页面因此能分辨"判完了"和"判不了、要人"。
2. **语义**：新增一档 `needs_human`（标签 **待人工**，看板单独一列「等待人处理」）。
   判据取两个：结论是 `needs_human`，**或者**判决状态是 `escalated`——后者顺带覆盖
   "判决不合规且重试没有意义 ⇒ 交给人"那条路。

**它同时进「需要注意」那一拨**（`warning = 判决要求人介入：<escalateReason>`）。
理由：`pipeline.ts` 里那段注释早就写了这件事——"等把它并进列表响应之后再加进来，
在那之前不要在这里假装覆盖了它"。判决并进列表响应之后就该兑现，而且它正落在
INV-8 对"通知"的定义上：**需要你介入**。

看板列序是 **执行中 → 待审查 → 待人工 → 已审查**：从左往右读是"越来越接近结束"，
而"待人工"还没结束（卡在你手里），所以它在"已审查"**之前**。这条顺序写成了断言
（`PIPELINE_COLUMNS`）与布局探针（看板必须四列、且待人工在已审查之前）。

⚠️ 一个刻意的取舍：**判决为 `fail` 且动作已派发**仍然算「已审查」——它已经走完了
"判决 → 动作"那条链，不需要人再做什么。只有明确要求人介入的才进新档。

### 15.20 一次真实失败：判决指令只给了骨架，于是模型只能猜（并且猜错）

**现象**（使用者报的）：一次真实任务「画一只小猫」的两条审核都失败了，最终判 `needs_human`，
而"需要人工的原因"是一屏 zod 英文。

**查证**（全部来自使用者 daemon 里的真实记录）：

- **执行本身是成功的**：`cat.html`（纯 SVG）+ `cat.png`（185KB 截图）都在；
- **审核员做了很扎实的活**：读源码、渲染截图、还用 CDP 实测了 5 个 CSS 动画的
  `animationPlayState` 与 transform，甚至发现"报告说四只小爪子、代码只画了两只前爪"；
- 但它在工具调用里反复说：**"The enum isn't defined anywhere accessible"**、
  "Without the enum, any specific guess is a risk"——它为了找 `reasonCode` 的
  **合法取值**，翻了工作目录、别的任务的 `CLAUDE.md`、还去搜文件系统；
- 最后它猜了 `reasonCode: "ok"`，并把 `findings` 写成自己发明的形状
  （`{kind, target, evidence: 一个长字符串, detail: 字符串}`）；
- 第一次审核甚至**没能给出判决块**（模型只在工具调用里干活，最后回了一段散文），
  于是走 `invalid`；重试那次给出了围栏但形状不对 ⇒ schema 拒绝 ⇒ 降级。

**三个根因，全是我们的**：

1. **判决指令只给了骨架。** `renderVerdictInstruction()` 当时输出的是
   `{ "schemaVersion": 1, "conclusion": "...", "reasonCode": "...", "findings": [], … }`
   ——`findings` 是**空数组**（模型看不到"一项发现长什么样"），`reasonCode`
   只写了一句"必须是协议里的枚举值"而**一个取值都没列**。我们要一个严格闭合的对象，
   却只画了个轮廓。模型去猜是**必然**的。
2. **重试提示指错了地方。** 它说"严格按**审核标准**里的围栏格式输出"——而围栏约定不在
   审核标准（skill）里，它在任务的「输出要求」里。模型于是去 skill 正文里找一个
   根本不存在的格式。
3. **失败原因直接端给了使用者。** `formatVerdictIssues` 把 zod 的英文原文拼起来当
   `escalateReason`，于是那条 `needs_human` 判决的"原因"是一屏
   `Invalid option: expected one of …`。

**修法**：

| 改 | 内容 |
|---|---|
| 指令写全 | `renderVerdictInstruction()` 现在给出**完整字段规则 + 一个能通过校验的完整示例**：所有枚举取值（conclusion / reasonCode / severity / action.type）、`evidence` 是**对象数组**而非字符串、`detail` 是唯一开放字段、闭合的含义。**枚举与示例都从 schema 生成**（`z.enum(...).options`），所以改 schema 不会让指令漂 |
| 示例有守卫 | 一条测试断言"指令里的示例必须 `parseVerdict` 通过"——示例自己都不合法的话，模型照着抄也会被判不合规（那正是这次的教训）。另一条断言每个枚举的**全部取值**都出现在指令里 |
| 失败说人话 | `formatVerdictIssues` 按 zod 的 issue **code** 翻成中文（"取值不在允许范围内/这个字段是必填的/多出了不允许的字段/太长了"），最多列 6 条并说明还有多少处。原文没丢：它仍在日志与判决详情里 |
| 提示指对地方 | 重试提示改成"只输出一个 JSON 对象，放在**任务说明**里那对围栏之间，字段名与取值严格照里面的规则" |

⚠️ **一条顺带的实证**：那次失败里，模型的工具输出引用了 `CLAUDE.md:60-70`——也就是说
**CLI 确实读了我们写进去的受管块**。`FR-CLI-40`（"写入成功 ≠ 被读取"）因此有了第一份
直接证据（虽然只是旁证：模型确实引用到了块里的行号）。这条结论对 D29 的价值在于：
它说明"块的通道是通的"，而真正的缺口是**内容写得不够具体**——D29 把内容搬到 prompt 是
为了不让契约依赖未验证的通道，不是因为通道失效。

**这条也解释了为什么 D29 是必要的**：契约（围栏 + schema）原来只写在 `CLAUDE.md` 里，
而 stdin 上那句提示只有"请审核…"。模型得**自己去把契约找出来**——找得到是运气好，
找不到就是我们看到的这次失败。现在整段契约就在它必须读的那条消息里，而且带一个合法示例。

### 15.21 接着查"画两只狮子（母子）"：两个更细的缺陷（围栏抄错、重试材料是空的）

§15.20 修完之后，使用者又跑了一个任务「画两只狮子（母子）」，**两条审核还是失败了**。
但这次失败原因里带着 `顶层：` 前缀——那是 §15.20 才加的中文格式化，说明新代码确实在跑
（他重启过 daemon）。所以问题在别处。查证：

- **执行是成功的**：`lions.svg`（8499 B）+ `lions.png`（86055 B）；
- 两条审核的失败原因都是「没有找到判决块」；
- 打开模型最后那条消息一看：**判决本体完全合法**（`pass` / `meets_criteria` / 0.85，
  findings 写得很扎实，还指出"任务没指定格式风格，采用默认不算越权"），
  但**结尾标记写成了开头标记**：

```
<<<ALPHA_VERDICT>>>
{ … 完全合法的判决 … }
<<<ALPHA_VERDICT>>>          ← 应该是 <<<END_ALPHA_VERDICT>>>
```

  两条审核**都是这个错**（2 次 BEGIN、0 次 END）。于是提取器判"有 BEGIN 无 END"，
  整份做得挺好的审核作废，最后落到 `needs_human`。

**缺陷一：围栏是我们自己的约定，却不容忍抄错一个结尾标记。**

这个围栏不是模型世界的格式，是**我们发明的**。因为抄错一个结尾就丢掉整份审核，
代价明显不对等。所以提取规则改成：块的结束取**下面两者中更早出现的那个**——
正确的结尾标记，或者**又一个开头标记**（模型显然想收尾，只是抄错了）。

这仍然是**确定性切片**，不是"在自由文本里捞 JSON"：只认这两个标记，位置与顺序都确定。

⚠️ **但不接受"任意 ```json 代码块"作为兜底**：我们给模型的指令里**本身就有一个示例**
（conclusion 是 `fail`、reasonCode 是 `missing_tests`）。一旦允许随便找个 JSON 代码块，
模型把示例原样抄回来就会变成一个**通过校验的错误判决**——那比作废更糟。
宁可作废，也不要一个看起来合法的错判决。

同时把指令里那对标记**分别写清楚**（"结尾那个带 `END_` 前缀，不要写成开头"），
两端一起收：既让模型更容易写对，也让写错时仍能救回来。

**缺陷二：重试带的是空材料。**

`createRetryRun` 的注释写着"上一次的输出会作为审核对象的正文带进来"，而代码传的是
`body: ''`。真实后果是模型的原话：「材料区只有标题『重试审核（原 run …）』，不含任何
正文/产物/结论，缺少可审核的实际内容」——**模型是对的**，于是判 `needs_human`，
而那一次 CLI 的钱白花了。

改法：材料从**上一次审核自己的上下文副本**里按材料标记切出来
（`<workdir>/.agentdeck/context/<runId>.md` 里那段被 `<<<ALPHA_MATERIAL>>>` 包住的内容）。
切不到就**不起这次重试**（`return null`），走既有的"拿不到重试机会 ⇒ 降级"那条路——
诚实的降级，比"花钱审一份空材料"强。

⚠️ **2026-09 已换来源**：副本文件不再写（见 §15.16 已撤注），重试材料改从 **run 记录**取——
文件式审核读 `materialRefs` 指向的结果文件、报告式审核读 `reportBody` 本身（`Run.materialRefs` /
`Run.reportBody`，见 `executor.ts`）。"切不到就不起重试"这条诚实降级不变。

⚠️ 修这条时又踩到一个自己挖的坑，被测试当场抓住：那句说明文字原来把**两个标记都印了出来**
（「下面 `<<<ALPHA_MATERIAL>>>` 与 `<<<END_ALPHA_MATERIAL>>>` 之间是…」），于是
"文件里第一个材料标记"变成散文里的那个，按标记切出来的材料是一个 `与` 字。
现在说明文字不再复述标记，切片规则也改成"第一个开始标记 + **最后一个**结束标记"
（材料本身可能又是一份带标记的副本）。

**验证**：把使用者 daemon 里模型那段**真实输出**拿来跑新的提取器——
`✓ 找到了` → `✓ 判决合法：pass / meets_criteria / 置信度 0.85`。
也就是这次修复确实能救回那份被判作废的审核。

### 15.22 判决的"必填"只留给真正承载判断的字段（第三轮真实失败）

**现象**：又一次真实的 `needs_human`：「需要你判断：**action：这个字段是必填的，但判决里没有**」。
看模型给的判决：`conclusion: "pass"`，findings/evidence/detail 都写得很好，围栏也对，
**唯独整个 `action` 键没写**。

**根因还是我们**：schema 里 `action` 是 `.nullable()`——"可以空，但**必须出现**"。
而我们的指令只说"`fail` 必须给出 action"，于是模型合理地认为 `pass` 不需要这个键。

那是 JSON 里的**反直觉要求**：模型的自然习惯是"没有就不写这个键"。而这些字段
**省略与 null 语义完全相同**，没有任何安全价值——出口规则（INV-4/5）看的是
"action 的值是不是 null"，不是"这个键在不在"。

**改法（一条原则）**：**"必填"只留给真正承载判断的字段。**

| 字段 | 处置 | 理由 |
|---|---|---|
| `conclusion` / `reasonCode` / `confidence` / `schemaVersion` | **仍然必填** | 它们就是判断本身 |
| `action` | 缺省 ≡ `null` | ⚠️ **D45 改过**：现在**只有 `pass` 能写**，`fail` 写了整条不合规（它由出口规则保证，与"键在不在"无关） |
| `escalateReason` | 缺省 ≡ `null` | 同上（`needs_human` 必须有，由出口规则保证） |
| `findings` | 缺省 ≡ `[]` | 信息性的 |
| `evidence` 里的 `blobRef` / `locator` / `excerpt` | 缺省 ≡ `null` | 同上 |
| `action.params` | 缺省 ≡ `{}` | 有的动作没有参数 |

**安全性质一点没丢**：三条测试分别钉住"`fail` 没有 action 仍拒"、"`needs_human` 没有
`escalateReason` 仍拒"、"判别性字段少一个仍拒"。

> ⚠️ **D45 之后第一条测试反过来了**：现在钉的是"`fail` **带了** action 就拒"
> （见 `packages/protocol/src/verdict.ts` 的出口规则）——`fail` 的出口是返工，
> 处置动作只属于 `pass`。另两条不变。省略只是被**规范化**成 `null`，
下游代码不必处理 `undefined`。

指令那边同时改了说法：原来只写"`fail` 必须给出 action"（正是歧义来源），现在明说
**"这几个字段都可以省略，省略与写 null 等价"**，并给出一份**最小的合法 pass 判决**：

```
{ "schemaVersion": 1, "conclusion": "pass", "reasonCode": "meets_criteria", "confidence": 0.9 }
```

⚠️ 那份最小示例是**内联**写进字段规则里的，**不是**第二个围栏块——否则"取最后一个
围栏块"的提取规则会把示例当成判决（这类"给模型看的示例反过来变成候选输出"的坑，
在 §15.21 里也踩过一次）。

**三轮真实失败的共同点**值得记一笔：都不是模型不聪明，而是**我们的约定与模型的自然
习惯不一致**——①契约藏在一个未验证会被读的地方；②只给骨架不给枚举；③要求一个
反直觉的"键必须在场"。每一轮都靠"把失败原文翻出来读"才定位到，而不是靠猜。

### 15.23 「第一句话」变成模版：能动的是文字，不能动的是三样东西（D32）

> ⚠️ **这一节写的是 D32/D33/D35 当时的形态，其中几处已被 2026-09 的三块组装改掉**
> （读它的时候以 §15.33 为准）：
> · 模版现在**只管 ① 框架**；② 身份与 ③ 任务由平台放在固定位置；
> · `{{instructions}}` / `{{prompt}}` / `{{standards}}` / `{{tools}}` / `{{material}}` /
>   `{{materialTitle}}` 六个变量**退役**（变量表 9 条），模版里再写会被**专门拒绝**；
> · **材料与两个标记由平台无条件写进 ③**——下面"校验里机械地检查两个标记"那条不再成立；
> · 模版里**唯一**的必需变量是审核那份的 `{{verdict}}`；三份模版（执行 / 审核 / 聊天）。

**起因**：使用者的要求很短——「智能体页面，新建智能体时增加设置，可以分别设置执行和审核的
第一句话模版」。**随后又纠正了一次，而那次纠正比要求本身更重要**：

> 「我指的第一句话配置是一个通用配置，一旦设定就应该应用到所有的 Agent。不是每个 Agent 一个配置」

第一版把它做成了 `Agent.executeTemplate` / `Agent.reviewTemplate`（每个 agent 一份），理解错了。
那段文字是**"平台怎么把一次 run 交代给模型"的骨架**，与"这个 agent 是谁"是两件事——后者由
`Agent.instructions` 承担，而它会作为 `{{instructions}}` 插进模版。所以正确的作用范围是**全局**：
挂在 workspace 上，设一次，所有 agent（包括已经建好的）都按它来；换一个 agent 只是换掉
`{{instructions}}` 那一段。

这个区别在**读**的那一侧同样成立：界面上显示的那份与执行器投递的那份必须是同一个来源
（现在是同一个 `readFirstSentenceTemplates`），否则"看到的不是生效的"这个错觉就成立了。

**先要回答的问题是：模版的边界在哪。** 一个 agent 被交代的全部内容就是那段"第一句话"，
而那段话里混着两类东西：

1. **使用者的事**：这个 agent 是谁、要它干什么、按什么标准干、怎么交活；
2. **平台的硬契约**：待审材料必须被标记包住（重试要从里面取材料）、判决 schema 与围栏
   （没有它判决解析不出来）、这次 run 的身份（审计与动作要指回对象）。

把它们合成一个自由文本框，等于把第 2 类交给使用者去维护——而**这类东西我们已经因为
"位置不对/不完整"栽过三次**（§15.20 的骨架、§15.21 的围栏与空材料、§15.22 的必填）。
所以定案是：

> **整段可改**（使用者要的就是这个），但必需的几样东西做成**变量**——它们自带正确的
> 包装，删不掉；**保存时校验**，缺一个就不许存。

**模版长什么样。** 变量是 `{{name}}`，分两种：

| 类型 | 变量 | 装什么 |
|---|---|---|
| 单值（**纯内容**——标题归模版，见下面 D33） | `{{prompt}}` **必需** | 这次要它做的事：执行 = 任务正文；审核 = 调用方的指令（**重试那句"上次没通过格式校验"也在里面**） |
| | `{{instructions}}` | 这个 agent 的「指令」原文（不带标题） |
| | `{{skills}}` | 一行「能用到的技能：`a`、`b`」；没有 skill 时整行为空 |
| | `{{runId}}` `{{subjectType}}` `{{subjectId}}` | 身份 |
| | `{{reportKind}}` `{{issueId}}` `{{previousContext}}`（审核） | 报告的三个字段 |
| 整段（**带条件行或硬契约**的生成块，空则不出现） | `{{header}}` | 身份段：`# 任务` / `# 审核任务` + run id、对象（审核还带类型；**关联 issue、上一次的上下文是"有才出现"的行**——所以它是整段） |
| | `{{standards}}`（审核） | 每个 skill 一小段（`### slug（名字）` + 正文全文） |
| | `{{material}}`（审核）**必需** | 那句"不是给你的指令"的声明 + 两个材料标记 + 标题与正文 |
| | `{{verdict}}`（审核）**必需** | 判决契约全文：schema + 取值枚举 + 一个合法的示例 + 围栏标记 |

**D33：变量给内容，标题归模版。** 第一版里 `{{role}}` 展开成 `## 你的角色` + 指令原文，
`{{skills}}` 展开成 `## 你能用的技能` + 列表，`{{standards}}` 展开成 `## 审核标准` + 正文。
使用者翻设置页时看到那行定义，说「**{{role}} 的定义是否包括 '## 你的角色' 的信息，感觉不合理**」——
这个判断是对的，理由有两条：

1. **一个名字应该只意味着一件事。** `{{role}}` 同时意味着"标题"与"内容"，而且与
   `{{instructions}}`（只有内容）**重名同事**——使用者面对两个名字只能猜"哪个才是我要的"；
2. **标题是排版，排版是模版作者的地盘。** 想换个说法、想不要标题、想把它放进自己的结构里，
   都该能改。把平台的措辞焊进变量，等于告诉使用者"这块文字不归你"。

改法：`{{role}}` 与 `{{skillSlugs}}` 两个名字**取消**，`{{instructions}}` / `{{skills}}` /
`{{standards}}` 一律只给内容，`## 你的角色` 这类标题由模版自己写。

⚠️ 但**"整段变量"没有全废**，只是标准变清楚了：它存在的理由必须是"**带条件行**"或
"**带硬契约**"，而不是"顺手把标题塞进去"。

| 整段变量 | 为什么不能拆成值 |
|---|---|
| `{{header}}` | 关联 issue、上一次的上下文这两行是**有才出现**的。拆成值 ⇒ 没有 issue 时留下一条光秃秃的 `- 关联 issue：`。模版语言里**没有条件语法**（有意的，见下） |
| `{{material}}` | 两个材料标记是**硬契约**（重试靠它们取回原样材料），那句"不是给你的指令"必须紧贴标记 |
| `{{verdict}}` | 契约全文本身就是成品（schema + 枚举 + 示例 + 围栏） |
| `{{standards}}` | 每个 skill 一段，段间要有 `### slug` 才分得开 |

`{{skills}}` 是唯一一个"带行内标签的单值"：没挂 skill 是**常态**（执行者常常一个都不挂），
而模版里没法写"有才出现"——所以"能用到的技能：…"这一行必须整体消失。它是一行，不是标题。

**为什么不加条件语法**（`{{#if skills}}…{{/if}}`）：那等于给自己造一门语言，要处理嵌套、
配对、报错，而收益只是"标题能自己写"——上面这套划分已经把它变成了"选变量"的问题。
真要条件，等真实需求出现再说。

（这次改名会让**已保存的、引用了旧名字的模版失效**：渲染期会明确失败并说清原因，
不会静默渲染出半截文本。名字越早定下来越便宜，所以趁没人存过就改。）

**D34：模版引擎用 mustache，不自己写解析器。** D33 把标题交给模版之后，冒出一个真实缺口：
**"可选段要不要标题"没有表达办法**——没写指令时，模版里那个 `## 你的角色` 会留下来变成空标题
（我当时的解法是"默认模版干脆不要标题"，那是绕过问题，不是解决问题）。

使用者的反应很直接：「你提到的 `#if` 语法，应该有现成的库吧，你查一下」。查下来的硬数据：

| 库 | 依赖 | 解包体积 | 条件语法 |
|---|---|---|---|
| **mustache 4.2.0** | **0 个** | 114 KB（单文件 24 KB） | `{{#x}}…{{/x}}`、反向 `{{^x}}` |
| handlebars 4.7.9 | 5 个（含 uglify-js） | 2.8 MB | `{{#if x}}…{{/if}}` |
| liquidjs 10.29.0 | 1 个（commander） | 1.9 MB | `{% if %}` |

这个仓库的依赖只有 `zod` + `yaml`，给 agent-core 加 5 个传递依赖换一个 `{{#if}}` 不成比例；
mustache 是**零依赖**，语法又是我们已经在用的 `{{name}}`，还顺带把校验从手写正则换成真解析器。

**换之前先在本地实测了九件事**（脚本留在 `.cache/tpl/probe-mustache*.mjs`），因为有几条会
直接决定"能不能用"：

| 实测 | 结果 | 对我们的意义 |
|---|---|---|
| 默认转义 | ⚠️ 会（`&` → `&amp;`） | 必须关，而且**每次渲染单独传** `{ escape: v => v }`，不动全局设置 |
| 条件段空值 | ✅ 整段连标题一起消失 | 正是要的能力 |
| 值会不会被重扫 | ✅ 材料里写 `{{verdict}}` 原样落地 | D32 那条安全性质**保住了** |
| 语法错误 | ✅ `Unclosed tag at 22` | 位置有了，报错比原来那套正则强 |
| `parse()` 的 token | ✅ `name` / `#` / `^` / `/` / `!` / `>` / `=` | 校验可以走 AST：白名单、段内/段外、不支持的语法 |
| `{{> x}}` partial | ⚠️ 渲染成**空**、不报错 | 必须拒——静默少一段比报错糟 |
| `{{=<% %>=}}` 改分隔符 | ⚠️ 合法且生效 | 同样拒——换一套语法之后排查的人只会看到"模版没生效" |
| `{{constructor}}` 这类名字 | ⚠️ 渲染成 `[object Object]`、不抛错 | 白名单照旧挡住 |
| 段内的名字解析 | ✅ 上下文栈向上找得到 | `{{#instructions}}…{{prompt}}…{{/instructions}}` 能用 |

**配套改了三处**（缺一不可）：① 关掉转义（有测试钉 `&` / `<` / `"` 原样通过）；
② **必需变量必须在任何段之外出现**（`{{#x}}{{prompt}}{{/x}}` 会让"这次要它做什么"在某次 run
里消失）——这条是新增的校验规则；③ 拒掉 partial 与改分隔符。

**"默认模版逐字节不变"**：切换时用 `git stash` 把旧实现拉回来跑同一组输入做对比，
两边的渲染结果**完全一致**（含审核那份两千多字的契约）。既有模版不受影响。

⚠️ 一个容易漏的细节：**预处理必须在校验与渲染两处共用**。`{{{{`（字面大括号）在渲染那边
是转义，而 mustache 的解析器不认识它（会一路找到结尾报 `Unclosed tag`）。只在一处做，就会出现
"能渲染但保存时被拒"——实测被测试抓到了（转义那条用例直接红）。

**D35：把"整段变量"也全部交回去。** D33 之后还剩四个"整段"（`{{header}}`、`{{skills}}` 的行内
标签、`{{standards}}` 的 `### slug`、`{{material}}` 的声明与两个标记）。使用者的意见是
「**全部彻底回到模版手里**，注意把默认模版修改完整」。

于是**一个整段变量都不留**：

| 以前 | 现在 |
|---|---|
| `{{header}}`（`# 任务` + 身份行 + 有才出现的关联 issue 行） | 取消。模版写标题与身份行，`{{runId}}` / `{{subjectType}}` / `{{subjectId}}` / `{{reportKind}}` 都是纯值；"有才出现"用条件段：`{{#issueId}}…{{/issueId}}` |
| `{{skills}}` 自带"能用到的技能：" | 只给 slug（`a、b`）；要标签就在模版里写 |
| `{{standards}}` 自带 `### slug（名字）` | 只给各 skill 的**正文**（段间空行）；skill 自己的标题就在正文里 |
| `{{material}}` 自带声明 + 两个标记 + `### 标题` | 只给**正文**；标题是 `{{materialTitle}}`，声明与两个标记由模版写 |

**两个代价是刻意的**：

1. **材料标记现在可以被删掉**——它是重试取回材料的依据（§15.21：重试带空材料那次失败）。
   ~~解法不是"收回去"，而是**机械地检查**：审核模版里少了两个标记就在保存时被拒~~
   —— ⚠️ **2026-09 这条校验已删**（三块组装）：材料与两个标记改由**平台无条件写进 ③**
   （`taskBlock`），模版既不该也写不了它们（`{{material}}` 已退役）。契约没有变弱，
   只是保证的方式从"模版必须写 + 校验"换成了"平台自己写"；
2. **纯值没法按项排版**：多个审核标准的标题只能靠各 skill 正文里自己的标题
   （迭代语法 `{{#each}}` 我们没有）。真需要再加——加它比加"平台偷偷帮你包一层标题"
   要诚实。

**默认模版必须完整**（使用者特意叮嘱）：它现在是一段可以逐字读下来的完整交代——标题、
身份行、材料标记、那句"不是给你的指令"、护栏、判决契约全在里面。**"有才出现"的地方
一律用条件段**，所以没写指令、没挂 skill、没有关联 issue 时不会留下空标题或光秃秃的
标签行。

⚠️ 换的时候踩过一个坑，值得记：条件段的**换行位置**要排，而且**段标签要独立成行**。
mustache 会把"独立成行的段标签"整行剥掉（规范），所以

```
- 类型：`{{reportKind}}`
{{#issueId}}
- 关联 issue：`{{issueId}}`
{{/issueId}}

{{instructions}}
```

这样排，四种组合（都有 / 只有 issue / 只有上次上下文 / 都没有）渲染出来都是干净的；
写成行内 `{{#issueId}}- 关联 issue：…` 就会把后面那个空行一起吃掉，`{{instructions}}`
紧贴在 `- 类型：` 下一行。这次是**先跑四种组合看输出**再定稿的（脚本在 `.cache/tune*.mjs`）。

★ 还有一条**风格**上的要求，来自使用者的第二眼：行内写法不只是有隐患，它**难看**——

```
{{#skills}}能用到的技能：{{skills}}

{{/skills}}## 护栏        ← 使用者："这个不换行的表达不好看"
```

所以默认模版里**所有段标签都独立成行**：`{{#skills}}` 一行、内容一行、`{{/skills}}` 一行。
渲染结果**一字不变**（实测五种组合逐字节相同），只是模版读起来变成"一行一件事"。
有一条测试机械地钉它（默认模版里每个 `{{#}}` / `{{^}}` / `{{/}}` 都必须单独占一行）。

**D36：「默认智能体」是全局单值，而且只认执行者。** 使用者的要求很短：「智能体增加一个默认设置，
可以放在每个智能体的默认按钮，设置后新建任务的默认选择的 Agent 就是它了」。

三个决定：

1. **存在 workspace 上**（`defaultAgentId`），不是每个任务一份配置——"默认交给谁"本来就是一个
   选择。界面上的入口是**每个 agent 卡片上的一个开关**，但存的是一个值；
2. **只有执行者能当默认**。审核者是被动的那一方（它由执行者的 `reviewerAgentId` 指过去），
   把任务交给它执行是配置错误，而且会在"任务已经派出去"之后才发现。服务端拒（400，说清为什么），
   界面上审核者的卡片干脆不显示这个开关；
3. **悬空值按"没设过"处理**：默认那个 agent 被删掉之后，读的时候不清理（"读"这条路上不该有
   副作用），用的时候落回 null，行为与没设过一样。首启会把播种的执行者设为默认——使用者建完
   第一件事就是"新建任务"，那一步不该让他先想"交给谁"。

**第二轮反馈两条**（第一版发出去就被打回来）：

1. **「设为默认」超出了卡片边框**。量出来是这样：开关右边缘 **710px**，而左栏右边界
   **656px**——溢出 54px，栏里还多出一条横向滚动条。原因是经典的 flexbox 坑：
   行是 `display: flex`，卡片是 `width: 100%` 的按钮，开关是它的兄弟；而 flex 项默认
   `min-width: auto`，**不让它缩到内容宽度以下**，于是"卡片 368 + 开关 74"直接顶出去。
   改法有两层：`flex: 1; min-width: 0`（后者才是关键那一条），并且**把边框从卡片挪到
   那一行**——开关于是住在卡片**里面**，而不是挂在边框外（那也是"看起来没画完"的来源）；
2. **不该有「取消默认」**，必须有一个默认；设了别的，原来的自动让位。这条改掉了接口语义
   （`PUT /api/agents/default` 不再接受 `null`，会 400 并说清"要换就设成另一个"），界面上
   已经是默认的那个只留徽章、不再显示开关。配套加了 `effectiveDefaultAgentId`：**没设过、
   或设的那个已被删除时，生效值就是第一个执行者**——"必须有一个默认"因此在界面上始终成立
   （列表上永远有且只有一条标着「默认」，新建任务页永远有确定的预选项），而读的时候不写库。

⚠️ **开工前顺手发现一个真实的坏默认**：新建任务页原来列的是**所有** agent，预选是"列表里的
第一个"；而首启播种的列表里第一个恰好是**审核员**——也就是说，默认选项是一个不接任务的 agent，
选中它只会跑出一轮莫名其妙的结果。所以这次同时把选择器收成"只列执行者"（只有审核者时给出
明确提示，而不是一个空下拉）。这条是**变异测试**帮忙暴露的：把预选改回 `$agents[0]`，探针里
那条"预选的是设过的那个"立刻红，而它报出来的实际值是"审核员（审核）"。

⚠️ 顺带记一条**探针自己的坑**：测"换默认"需要**两个执行者**，而首启只播种一个，于是
我让探针自己 `POST /api/agents` 造一个、再点界面上的「刷新」等它出现——**等不到**。
原因是探针跑在 `--virtual-time-budget` 下：`setTimeout` 是**虚拟**的（上百轮轮询几毫秒
就跑完了），而网络请求是真的。实测 API 已经返回 3 个 agent，界面那一轮轮询早就跑完了。
改法是把夹具挪到 **`run.mjs`（Node 侧、真实时间）**里造——探针只负责量。这条与
"虚拟时间会让断言看早"是同一个教训。

**D37：审核标准从 skill 里搬出来，内联在审核者身上。** 起因是使用者的一句提问：
「审核 Agent 标准放 skills 是否合理？」

查下来，"标准借住在 skill 里"有三处别扭：

1. **概念没有自己的位置。** 平台拿"挂了几个 skill"当"有没有标准"的**代理量**——没挂就不派审核，
   而提示语还得替这个代理量解释："审核标准就在 skill 里"。一条规则要靠另一件事的名字才能说清，
   通常说明那个概念缺个家；
2. **四道手续换一段文本。** 写一条自己的清单要走：起 slug → 写 frontmatter → 安装 → 回来挂载。
   而它本质就是"一段判断依据 + 判完能做什么"；
3. **可见性差。** 审核者的判断依据藏在技能页的一个 slug 后面；详情页只列 slug chips，
   正文要点两次才看得到，动作白名单完全看不到。

评估过三个方案（A 现状 / B 搬进 agent / C 双来源），使用者选 **B**。落地时做了这些决定：

| 决定 | 为什么 |
|---|---|
| `Agent.reviewStandard = { name, body, allowedActions }` | 三样一起构成"它按什么判"。**动作白名单必须与标准同源**：判决里的动作按它校验，"这条标准只允许发评论"是标准的一部分，不是全局策略——分开存放迟早分叉成"标准说可以、平台说不行" |
| 派发规则：**有没有标准**（不再看 skill 数量） | 判据回到它该在的地方；三条派发路径（自动串接 / 重试 / 报告路由）一起改。域层的 `routeReportToReviewers` 只能看 agent 自带字段，所以那是**粗筛**，真正的判据在 `resolveReviewStandard` |
| 解析**只有一处**（`apps/daemon/src/review-standard.ts`） | 三处调用点（派发判定 / 渲染 `{{standards}}` / 校验动作）共用一份结果。"三处各写一遍"的后果是它们分叉，而分叉的表现是"界面说它有标准、平台却不派审核" |
| **过渡期兼容**：没有内联标准但挂了 skill ⇒ 用 skill 顶上 | 规则一改就让**已经建好的审核者停摆**是最不该发生的事。兼容路径用 skill 的正文与**动作并集**（与改动之前一分不差），并把 `fromSkills: true` 带出去，界面据此提示"建议改成内联标准" |
| 内联标准**优先**，不与 skill 合并 | 动作白名单的合并语义是安全相关的：并集等于悄悄放宽权限、交集等于莫名其妙收紧——两个都不该是隐式行为 |
| 审核者仍然**可以**挂 skill | 对审核者它退成"可选的参考/支持文件"（支持文件那条路仍然有用）。**但标准不是它**——界面上说清了这句话 |

> ⚠️ **这张表是 D37 当时的决定，其中三行后来被改过**（读它的时候别把下面这些当成现状）：
> · `reviewStandard` 上的 `name` 已删（平台侧没人读它，见 D37 那条注记）、`allowedActions`
>   在 D40 收口时搬到 `Agent.allowedActions` 上；
> · **派发规则不再是"有没有标准"**：2026-09 起依据并进 ② 身份，判据是**「指令非空」**
>   （`reviewerIdentity(...).text !== ''`），域层那份粗筛是 `hasReviewIdentity`
>   （`packages/domain/src/routing/kind.ts`，认「指令」/ 内联老标准 / 挂载 skill 三种）；
> · **界面上已经没有「审核标准」那一栏**了（2026-09，见 §15.33），老数据那份正文改在
>   「指令」那一栏显示、并给一个「并进「指令」」的入口；保存时也会自动并进去。

**丢掉的是 skill 那套"可安装 / 有版本 / 有来源 / 带支持文件"**。这是有意识的取舍：对单个使用者
来说，标准就是一段文本 + 一份动作白名单，装/版本那套是为"跨人共享"准备的——真需要时，内联标准
照样可以被复制粘贴（而它的正文与动作是结构化的，将来要"导出成一个 skill"也不难）。

⚠️ 顺带修掉一处**同一件事两套判据**：`issue.assign_agent` 动作派生的执行 run 原来要求
"必须挂 skill 才能执行"，而同一条路在「新建任务」里**没有**这个要求（执行者可以不挂 skill）。
D37 把"标准"从 skill 里摘出来之后这条更说不通了——执行者的 skill 是"做事时参考什么"，
跟"能不能干活"无关。

⚠️ 还要记一个**测试夹具的连带影响**：D37 之后播种的审核者不再挂 skill，于是
`skills-install.test.ts` 里"从播种的 agent 里找一个挂着 skill 的"这条夹具路径失效了（它原来依赖
播种的行为细节）。夹具改成自己造——**夹具不该依赖"播种恰好长什么样"**。

**D38：把内置的 `general-review` 一起删掉，并补上"卸载"。** D37 把标准搬进 agent 之后，
那条内置 skill 就**只剩重复**了：它的正文成了首启审核者的 `reviewStandard.body`，而它还以
"一条 skill"的形式躺在技能库里——留着它只会让人重新以为"要审东西先得装一份 skill"（正是
D37 要消掉的那个混淆）。使用者的要求很直接：「移除 general-review，将标准放 Agent 里面」。

删掉的不止一条数据，还有**只为它存在的东西**：

| 删掉 | 为什么它不该留 |
|---|---|
| 首启的 `insertSkill(...)` | 技能库从空开始。技能是"执行者干活时参考什么 / 可安装带版本的资料包"，审核标准不从这儿来 |
| `backfillBuiltinSkillVersion()` | 它的**唯一**用途是"给老数据里那条内置 skill 补版本号，好让它能和公共目录比对"。内置那条没了，比对对象也没了 |
| 公共目录里的 `general-review@1.0.0` | 远端自己的注释就写着"审核标准是每个工作区的判断，属于 daemon 侧"。**目录可以为空**——"目录里什么都没有"是一句真话，比放一份已经不该用的东西强 |
| 两条围绕"内置那份 == 目录那份"的测试 | 它们守的是一个不再存在的不变量 |

顺带补上**卸载**（README 里一直挂着的"装了要删只有改库"）：`DELETE /api/skills/:id` +
技能页每行一个「卸载」。两个决定：

1. **还有 agent 挂着它 ⇒ 拒绝**，并把"还挂着的是谁"列出来。静默删掉一条还被引用的东西，
   症状会在很久以后才出现（某个 agent 的 skill 突然没了），而且看起来像技能求解坏了；
2. **存储层新增 `deleteSkill`**：文件适配器是**只追加日志**（崩溃最多丢最后一条），所以
   删除实现成一条 `del` 记录（真正腾空间交给既有的 `compact()`），而不是就地改文件；
   sqlite 那边是就地 `DELETE`。两个适配器都进了差分契约测试（"删得掉 / 幂等 / 删完取不到 /
   别的 workspace 不受影响"）。

**⚠️ 但真正删的时候卡住了——而那次"删不掉"本身就是设计缺口。** 使用者报「发现
general-review 卸载不掉呢」。查他的库（只读 GET）看到的事实：

```
审核员  role=reviewer  skillIds=[…general-review…]  reviewStandard=null
```

他的库是 D37 **之前**建的，所以那条播种的审核者还挂着 general-review，而且**没有内联
标准**——它的判断依据正来自那条 skill（走的就是 D37 留的兼容路径）。守卫于是按设计拒了
删除，报的是"还有 1 个智能体挂着它，先摘掉再卸载"。**守卫没错，错的是我没想到"摘掉"
这一步对老数据是有损的**：

> 直接把 skill 摘掉 ⇒ 审核者失去标准 ⇒ 平台不再把产出交给它审。

也就是说，我给的提示（"先摘掉"）会把使用者带到一个**看起来成功、但审核停了**的状态。
正确的路径是先把标准**固化**到 agent 上，再摘挂载、再卸载——而这条路径当时只能手工走
（编辑 → 抄正文 → 勾动作 → 保存 → 再取消挂载），三步还容易抄错。

所以补了一个一步到位的迁移入口：

- `POST /api/agents/:id/review-standard/adopt-from-skills`：把**当前生效**的标准搬进
  agent 自己的「指令」（**2026-09 三块组装之后落点是 ② 身份**；在那之前写的是
  `reviewStandard`，那个字段现在只剩兼容读取），动作权限写进 `Agent.allowedActions`，
  并清空 `skillIds`。**解析用服务端同一个 `resolveReviewStandard`**——让前端自己拼一遍
  "正文相加、动作取并集"，两处规则迟早分叉，而分叉的表现是"搬完之后生效的与搬之前生效的
  不是同一份"；
- 界面上：老形态的审核者详情里多一个「把这份判断依据并进「指令」」按钮，并说清"搬移是
  原样的"；
- 卸载被拒时的提示也**指到这一步**（如果挂着它的审核者判断依据还来自 skill，就直接说"去它详情页
  点那个按钮"，而不是笼统的"先摘掉"）。

⚠️ 落点从 `reviewStandard` 改成「指令」时，详情页那个只读分支**同时**要改：它原来按
`agent.reviewStandard` 分三种形态，而搬完之后那个字段是 `null` ⇒ 于是刚把正文搬进「指令」，
界面上却写着"没有写「指令」，它拿不到审核任务"（**搬移的结果是那一栏开始说反话**）。
判据换成**指令非空**之后，"标准不再单独设置、判断依据写在「指令」里"这句话才与事实一致。

★★ **2026-09：`PATCH` 保存时顺手把内联老标准并进「指令」**。使用者的原话是「还留着老的
信息…建议我重新编辑保存后 就应该去掉这些旧资讯」——他说的是真实观感：那条"还带着一份老的
标准"的警告，改名字、写指令、保存，**它都不动**（只有另一个按钮才会清掉老字段）。一条只有
点别处才会消失的提示，等于把清理老数据的责任推给使用者，而他并没有做错什么。
所以保存一次就清掉老字段：这一步**不改变投递出去的那段文字**（`reviewerIdentity` 本来就是
`[指令, 老标准]` 按同一个顺序、同一个空行分隔拼起来的，并完算出来的身份与并之前逐字节相同），
变的只是"这段文字住在哪个字段里"。三种情形**故意不并**：① 请求里明确带了 `reviewStandard`
（老客户端照旧能写那个字段）；② **指令为空**——并进来会把"只有老标准、没有身份"的审核者
变成"指令非空"，而资格判据就是指令非空（FR-AGENT-25），那等于保存一次就悄悄让它开始接
审核任务；③ **正文来自挂载的 skill**——并它必须清空 `skillIds`，而"改个名字顺手摘掉别人
的挂载"是使用者没同意的改动，那一种仍然走那颗按钮（按钮上写着"挂载也一起摘掉"）。
探针端到端钉住"提示消失 + 身份逐字节相同"，两条缺一不可。

⚠️ 探针这次抓到我两处自己的毛病，都值得记：① 详情页里"标准名"的徽章我复用了 D36 的
`default-badge` 类名，于是"列表里「默认」有几个"那条断言被详情页骗到（**类名撞车**）；
② 断言读的是**整个文档**的文字，而它应该读**那一行**（窄化之后立刻就对上了）。

⚠️ 这次删除也暴露了一件**测试卫生**的事：一批用例的夹具是"从首启播种的东西里挑一个"
（`skills[0]`、"首启会播种一个内置审核模板"这类断言），于是**播种行为一变，七八个用例一起红**。
夹具改成自己造（装一条 skill、建一个 agent）——**夹具不该依赖"播种恰好长什么样"**。

**三样必需的东西，每一样都对应一次真实失败**（这就是"为什么不能省"的答案，也是报错里
直接写给使用者看的话）⚠️ **2026-09 之后模版里只剩第三样**——前两样改由**平台**写进 ③
（材料与两个标记也是），见 §15.33：

| 必需 | 省掉会怎样 |
|---|---|
| ~~`{{prompt}}`~~ | 重试 run 与首次**长得一模一样**，模型只能自己猜为什么又来一次（D29 改版时真的漏了，见 §15.23 的"补记"）。**现在它不由模版写**（③ 任务里的第一段） |
| ~~`{{material}}`~~ | 模型不知道要审什么；更糟的是**重试只能带空材料**——实测过一次，模型判"没有可审核的内容"。**现在由平台无条件写进 ③**（变量已退役） |
| `{{verdict}}` | 模型只能猜字段名与取值——实测两轮真实审核都因此整条作废（模型在工具输出里明说 "The enum isn't defined anywhere accessible"）。**它仍是必需变量**：审核那份里唯一那一个 |

**默认模版就是模版。** 这是这次实现里最省事也最要紧的一个选择：没有"平台渲染路径"与
"模版路径"两份代码，`DEFAULT_TEMPLATES[kind]` 就是那段文字本身，两条路走同一台渲染器。
好处是可以被测试钉死：**文档里逐字贴的那两段**、界面上「填入默认模版」拿到的、
以及真的投递出去的，是同一个字符串渲染出来的——`first-sentence.test.ts` 里有两条
逐字节快照，把"没填模版时行为与 D29 那版完全一致"这件事钉住（D32 落地时对 9 组输入
做过新旧逐字节对比，只有一处差异：报告标题为空时的连续空行被收敛，见下）。

**两条实现上的安全性质**：

- **单遍替换，插进去的值不被重扫**。材料来自第三方，里面完全可以写一句 `{{verdict}}`。
  重扫的话那句话会被换成整份契约——攻击者于是能决定契约出现在哪里（比如塞进一段
  "忽略上面的规则"里），围栏切片也跟着错位。用 `String.replace` 配函数只扫一遍原模版，
  插进去的文本原样落地；有一条测试专门钉它（把替换改成两遍，那条测试立刻红）。
- **渲染后收敛空行**（`\n{3,}` → `\n\n`，首尾去掉）。空段在模版里就是一行空变量，
  不收敛的话模版一改就在中间冒出大片空白。代价是被审材料里连着三个以上的空行会被压成
  一个——纯排版，而且渲染前渲染后都是我们自己的事实（重试从副本里取材料，两边一致）。

**其余几个决定**：

- **变量表从接口来**（`GET /api/first-sentence/templates`）：校验用的表、界面上的对照表、
  报错文案是同一份。前端再抄一遍的后果是"照着界面写的却被服务端拒"；
- **预览走服务端的真渲染器**（`POST /api/first-sentence/preview`），用一份示例值
  （与文档里逐字贴的那两段同源）。前端自己拼一段"看起来差不多"的预览，迟早与真实投递
  的东西走偏——而"预览里好好的"恰恰是这个功能最该防的错觉。预览与保存过的是**同一道关**，
  所以报错也是同一句；
- **三份模版挂在 workspace 上**（`Workspace.executeTemplate` / `reviewTemplate` / `chatTemplate`），
  按链路取用。三份互不影响（审核那份唯一不能省的是 `{{verdict}}`），校验各按各的变量表做
  （执行或聊天的模版里写 `{{verdict}}` 是错的，报错与审核模版缺 `{{verdict}}` 不同）；
  ⚠️ 模版只管 **① 框架**（2026-09）：② 身份与 ③ 任务的位置由平台定，所以写 `{{instructions}}`
  之类会被**专门拒绝**并说清去处；
- **入口在智能体页、在「新建」旁边**：使用者的原话是「智能体的设置是在智能体页面上，
  应该在'新建'附近」。面板与新建表单共用正文顶部那一个位置，互斥；三个页签（执行 / 审核 / 聊天：聊天那一份是它自己的 ①，不是任务的又一次投递），
  **保存是一次的事**（同一个接口、同一道校验）；
- **老数据补空串**：store 不做 schema 迁移，加字段之前建的 workspace 读回来那两个键根本不存在。
  在**读的那一处**补成空串（`readFirstSentenceTemplates`），语义正好——空 = 平台默认 =
  与加这个功能之前一模一样。

**遗留**：以后若删掉或改名一个变量，已存的模版就会失效。这时**渲染期抛错**让 run 明确
失败并说清原因，而不是渲染出半截文本——后者会表现成"模型乱答"，排查方向会指向模型。
正常路径下走不到那里：写入口（新建 + PATCH）都过 `validateTemplate`。

**界面放在哪里（一次"整垮布局"换来的）**：使用者的第一反馈是"新建智能体的页面完全乱了"。量下来是这样：新建表单原来渲染在左栏 `pane-head` 里——那个按钮自己管着"开不开"，
表单就画在它旁边，而那个容器是 **416px 宽的头部行**；表单按自己的 `max-width: 46rem`
画成 **736px**，于是横着盖住右栏、栏头从 167px 涨到 **1070px**、agent 清单被顶出视口。

第一版改法是**把开关提到视图这一层**：按钮留在栏头，表单渲染到它正下方的 `pane-body` 里，
宽度交给栏宽（去掉写死的 46rem）。这样不溢出了，但使用者的下一句反馈是"**还是放在最右边打开吧，
现在的位置太窄了**"——左栏只有 416px，一个模版编辑器（textarea + 变量清单 + 预览）挤在
358px 里没法用。

**最终形态是右侧抽屉**（`.drawer.wide` = 46rem = 736px，与「安装 skill」同一个宽度）：
浮在主从布局上面、不动清单、关掉就回到原地，而且够宽。两个面板（新建 / 设置）都走同一个
`Drawer.svelte`（遮罩、关闭按钮、Esc 都在它里面——**两个抽屉都该有 Esc，而"漏了一个"是最容易
发生的事**），互斥打开。

教训收成一句：**这块东西该不该住在这一栏里**，是排版之前要先回答的问题。左栏是给"一列清单"
用的，任何需要横向空间的编辑器都不属于它。

**输入框本身也要够大**：使用者的下一条反馈是"第一句话的填写框太小了，不利用看内容"。
一个 `rows="8"` 的框配一段二三十行的模版，等于逼人用滚动条读自己刚写的字。现在
`FirstSentenceTemplate` 里的输入框**跟着内容长高**：最小 20rem（320px）、随内容自动长、
上限 70vh（再长就在框内滚，不把底部按钮顶出视口）；`resize: vertical` 关掉——
自动高度会在下一次输入时盖掉手动拖出来的高度，那种"拖了没用"比不能拖更让人困惑。
预览那块的上限也从 26rem 提到 38rem（它同样是"看内容"的地方）。

⚠️ 这次的教训值得单独记一笔：**布局探针当时 80 条检查全绿**。它量了两栏宽度、卡片内容、
选中态、窄屏返回、抽屉……**一条都没红**——因为没人问"这块东西在不在它该在的容器里、
有没有溢出"。补上的是一组**容纳关系**检查（表单位置 / 宽度 / 溢出 / 栏头高度 /
变量清单与预览块的宽度 / 取消能关掉），把表单塞回栏头之后 **5 条同时红**。
**量外观的检查挡不住"位置错了"。**

**补记（同一次改动里顺手修掉的两处接线错误）**：写这份设计时逐条核对代码，发现
①审核的第一句话**根本没有 `prompt` 入参**——"请审核…"与重试那句解释从来没被送出去，
表现是重试 run 与首次一模一样；②审计里的 `promptHash` 哈希的是 `req.prompt`，
而审核 run 的 `req.prompt` 恰恰是没被送出去的那句，于是"输入哈希"与输入对不上。
两条都已修（后者改成哈希真正投递的那段文本）。

### 15.24 Web UI：从零构建迁到 Vite + Svelte，并重做布局

**为什么这时候才换。** `apps/web/server/index.ts` 从 M0 起就写着"零构建版本先跑通闭环；
等 UI 复杂到需要**组件化与路由**时再换，而换的代价被这层挡住了"。现在那个条件成立了：
需求是 4 个视图 + 侧边栏路由 + 两个抽屉，而零构建版的 `app.js` 已经是 22KB 的手工 DOM
拼接——每个视图都要手写 `innerHTML`、手写 `escapeHtml`、手写一次事件绑定。

它的固定失败模式也暴露了：**结构和逻辑分散在 HTML 与 JS 两处，改一处不会报错，
只会在运行时炸**。迁移过程中我自己就踩了一次（换了 `index.html` 的结构但没同步
`app.js`，页面直接白屏）。

**换栈只动了 `apps/web/`**，后端一行没改——这正是当初把静态服务单独放一层的目的。

**布局的取舍**（不是简单的"堆叠改成两栏"）：

- **执行记录与实时日志放进任务详情**，而不是单独一栏。执行属于某个任务；
  "我在看哪个任务的执行"这个问题本来就不该由使用者自己拼。
- **Runtime 与版本验证状态并入「智能体」**。agent 跑在哪个 runtime 上是它**配置的一部分**，
  分开看会让人对不上号。侧边栏因此能保持四项。（⚠️ D40 起变成**五项**：加了「工具」——见 §15.26。
  这条判断本身仍然成立：**配置**并进它所属的实体，**独立能力**才配拥有自己的入口。）
- **成本 / 审计导出 / 远端账号 / 插件 / 同步说明收进设置抽屉**：它们是**低频**的，
  占着侧边栏会让高频的四项被稀释。抽屉"随时能开、开完就走"，不改变当前在看的东西。
- **通知走顶栏徽标 + 抽屉**，不占导航。

**三个工程细节：**

- **静态服务不做 SPA fallback。** 常见做法是"认不出的路径都发 index.html"，
  但那会**把 404 消灭掉**——请求一个写错的资源，得到的是 HTML 而不是"文件不存在"，
  浏览器报 MIME 错误，排查方向完全跑偏。而本应用的视图走 hash，`#` 之后的东西
  根本不发给服务端，**没有需要兜底的场景**。
- **构建产物缺失时明确提示**（`NOT_BUILT_HINT`）。产物是 gitignore 的，clone 之后
  直接起 daemon 会没有界面——这必须说清楚怎么做，而不是发空白页让人以为 daemon 坏了。
- **前端单独一份 tsconfig。** 根配置是给 Node 侧的（`lib: ES2023`、`moduleResolution:
  NodeNext`）；前端要 DOM lib 与 bundler 解析。测试再单独一份（需要 node 类型），
  而**主配置刻意不给 node 类型**——让它见到 `node:fs` 就等于默许前端去读文件，
  那会在浏览器里运行时才炸。类型系统在这里是一道真实的墙。

### 15.25 界面语言：中文 / English（D39）

使用者的原话是「增加一个语言切换功能，支持中，英文……请注意文字显示进行从代码分类」。后半句是这次
改动真正的题目：**文字散在代码里，就没法分类**——先得让"哪一句是界面文案、哪一句是机器值"变成
代码里看得见的东西，翻译才谈得上。

**范围（都是使用者当场定的，不是我自己缩的）**：只翻**菜单、按钮、提示、标题**这类界面文字；
**prompt 不翻**——但要在 prompt 里加一句语言指令（`{{language}}`，见下），让模型的答复是使用者
看得懂的语言。已经写进库里的日志、通知、历史记录**不回译**（它们记的是当时发生的事实）。

**决定一：契约值与机器值一个字都不翻，只给它们加标签。** 这条最要紧，因为翻错它是**功能性**的
错误，不是难看：`pass` / `needs_human` / `comment.create` / `in_progress` / `general-review` /
`claude` / `RuntimeEvidence` 的取值，是模型、执行器、审计三方共读的**机器值**。所以判决卡片上
显示成 `<code>needs_human</code> 需要你判断`——值原样，标签随语言变。为此专门有一张词表
（`web/terms.ts`）给**取值**配标签（17 个 reasonCode（含 D46 的 `human_decision`）、
判决结论、动作状态、run 状态、任务阶段的短标签；那六条 `term.action.*` 已随 D41 删除），并且有一条测试钉住"英文侧不许残留中文"。

> ⚠️ **2026-10 收口**：这张表里**删掉了 18 条没有任何引用的词条**——`term.verdictStatus.*`（7）、`term.role.*` / `term.kind.*` / `term.source.*`（各 2）、`term.evidence.*`（5）。它们与本文件前面那条 `term.action.*` 同一个病：**词表里备着、界面上没有任何地方用**（角色、来源、判决状态各页面都写了自己那份键）。留着的后果不是"以后可能用得上"，而是下一个人会以为"这些东西已经在界面上显示了"。在用的五组一个字没动：`conclusion` / `reasonCode` / `actionStatus` / `runStatus` / `stage`。

**决定二：推导层给的是文案键，不是句子。** 这是这次实现里最像"架构"的一处，也是事后最庆幸的
一处。`lib/pipeline.ts` 原来返回 `note: string | null` 与 `warning: string | null`——**中文句子**。
要支持两种语言，最省事的做法是在那里 `if (locale === 'en')`，代价是"这句话该怎么说"从此有了
两个出处。改成 `noteId` / `warningId`（+ `warningParams`）、列定义给 `titleId` / `hintId`：

| 层 | 它负责 | 它不负责 |
|---|---|---|
| `lib/pipeline.ts` | **什么时候**该说一句（场景推导） | 那句话怎么写 |
| `packages/i18n/src/web/*.ts` | 那句话**中英两版**怎么写 | 什么时候说 |
| `Svelte` 标记 | 取词：`{$t(info.noteId)}` | 两边都不管 |

`STAGE_SHORT`（那张"执行中 / 待审查 / 待人工 / 已审查"的短标签表）因此**并进了词条表**并删掉：
留着它就有了第二个出处，改一处漏一处。同一句话在测试里怎么守？测试不比对中文硬编码，而是
`renderText(webText, id, 'zh')` 之后再断言——**场景**与**措辞**两件事一起被守住（把
"没有派审核 —— 检查这个 agent 的『由谁来审它』"里那个抓手删掉，测试立刻红，实测过）。

**决定三：词表是六条护栏守着的，不是一份约定。**

| 护栏 | 挡住的具体事故 |
|---|---|
| 每条词条 `zh` / `en` 都非空 | 英文界面里冒出中文句子，或反过来 |
| **占位符两边必须一致** | 一种语言里留下 `{name}` 字面量 |
| 键名形状 `区域.用途`（区域=纯小写单词） | 键名各自发明，`tplSettings.` 这种一眼看不出属于哪张表 |
| 英文侧不许有汉字 | 漏翻（"看起来翻了"的那种漏） |
| **合并后键数 == 各表键数之和** | 两张表定义同名键 ⇒ 对象展开**静默覆盖**，症状只是"某处显示成键名" |
| **缺键渲染成键名本身** | 一处缺失让整页白屏；也比"悄悄回退成中文"好排查 |

最后一条是刻意的取舍：缺键时 `renderText` 返回 `web.agents.new` 而不是抛异常——**一处没写不该让
整页白屏**，而看得见的键名比"静默显示中文"好（后者会让人以为翻译丢了，而不是这条词条没写）。

**决定四：语言挂在 workspace 上，而不是浏览器里。** 服务端也要用它（prompt 里那句语言指令、
以后的通知），放 `localStorage` 的话两处会不一致——"界面英文、模型答中文"正是使用者要避免的
那件事。切换时**本地立即生效**（界面不等网络），再 `PUT /api/workspace/locale`；写回失败**不回滚**
界面：使用者已经看到它切过去了，把它翻回去比"服务端暂时没记住"更让人困惑。

**决定五：prompt 不翻，但加一句语言指令。** `{{language}}` 成为第一个句子模版的变量（默认
`简体中文`），执行模版里是「请用{{language}}回答。」。审核模版里那句是「请用{{language}}回答
（判决 JSON 里的字段名与取值必须原样照抄，不要翻译）」——**审核是唯一"答复要进机器"的地方**，
所以它必须自己带上这句约束，不能指望模型从别处推断。同时契约正文顶部加了一行
「⚠️ 下面这些字段名与取值**照原样写**，不要翻译成别的语言（它们是机器读的）」：真实失败史告诉我们，
契约的**枚举**不写在模型看得见的地方就会整条作废（D33 那次两轮审核都废在这里）。

**决定六：响应式只认 `$t`。** 标记里写 `{$t('id')}`、事件回调里写 `tx('id')`，两者不能混着用：
`t()` 内部 `get(locale)`，在**回调**里那样读没有订阅关系——切语言时那些文字不会重渲染，而
"切换后有一块没变"是这次最容易漏、最难自查的 bug。同理，任何在**函数体**里读文案的地方对编译器
都是隐形依赖（`AgentDetail` 的 `evidenceWarning()` 就是，已改成 `$:` 表）。

**"中文逐字节不变"是这次的安全网。** 默认语言是中文，而既有的 972 条测试与**真实浏览器探针的
158 条检查**全都断言中文原文——于是"迁移"这件事有了一个客观判据：**迁移完必须全绿**。它一次
次抓出真问题（一次是我把列头断言写成了读整个 `h4`，把说明也算进标题）。

**探针这次抓到的三件事**（都不是产品 bug，但都值得记）：

1. **视图模式存在 `localStorage` 里**，而探针前面"看板"那一节把模式留在了看板；语言那一节再回
   任务清单时按 `.task-row` 抓不到任何行。症状是"两个值为 `—`"，看起来像选择器改了。修法**不是**
   放宽断言，而是探针自己在切视图前**显式切回列表**、结束时还原——**探针也要收拾自己的现场**。
2. **生成式脚手架的坑**：两张空词表（`{} as const satisfies TextCatalog`）混进数组后，`reduce`
   的累加器被推成 `{}`，`n + …` 在类型层报 `TS2365`（运行时完全正常），而且"表填满就自愈"。
   修法是显式标注 `ReadonlyArray<TextCatalog>`——**别让空集合参与类型推断**。
3. 探针里那条"切换后必须变英文"的断言，**放在最后**并且结束时切回中文：前面所有检查都断言中文，
   顺序放错会让几十条同时红，而那种红看起来像"翻译把功能弄坏了"。

**没做与待做的**：①**daemon 侧的消息**（错误、通知、审计说明，约 250 条）**刻意留到下一批**——
它们与界面文案的判据不同（很多是"记进库的事实"）；②**同形的键收拢了一遍，但没有收干净，这是有意的**：
`common.*` 只留**真正共用的词**（保存/取消/关闭/刷新/卸载/预览/收起/必需……），各区域自己写的同形键
全部指回它；而**"同一个词出现在不同角色上"的那些没有合并**（侧边栏的「智能体」与视图标题、
执行者这个**角色**与 `execute` 这个 **run 类型**）——它们今天是同形的，但允许各自演化，
硬绑在一起会让改一处牵动一片。这也是 `common.ts` 文件头写的那条规矩：宁可各写各的；
③两种语言之外的语言暂不做，但 `Locale` 是个联合类型 + `LOCALES` 表，
加一种语言是"加一张表 + 加一个标签"。

### 15.26 工具：可插拔的动作（D40）

使用者的追问是"**行动建议是可插拔，可能是 MCP 或者 Script 或者 Plugin 等形式**"，并且当场定了两件事：
**先做脚本形态**；**工具要有"组"的概念，每次安装必须是一个独立的形态**，Skills 之外再有一个「工具」入口，
而且**工具目录要有标准格式，用来判断是不是适配本平台的工具**。

**形态的先后是有理由的，不是偏好。** 三种形态的危险程度不同：

| 形态 | 它是什么 | 为什么排这个次序 |
|---|---|---|
| **script**（这一版） | 一个目录 + 一个清单 + 入口脚本，平台起进程跑它 | 完全本机、无新进程类型、无协议版本问题；**是"第三方代码在你机器上改东西"的第一例**，先把这条路的护栏立起来 |
| MCP | 平台当 client 去调一个 MCP server | 复现现成能力最省事，但多一个信任边界与一类新失败（进程不在、协议版本、超时），且第三方 schema 的描述能力弱于本地 strict schema |
| plugin / remote | 第三方打包的能力 / 远端执行（`FR-ACTION-09/10`） | 远端动作的审计权威性天然弱（`FR-AUDIT-06`），最后做 |

#### 标准格式：判据写在 schema 里，不写在文档里

包长这样（仓库里有一份可抄的示例：`examples/tools/example-note/`）：

```
close-issue/            ← 一次安装 = 一个目录 = 一个"组"
  tool.json             ← 机器读的清单（判据就是它的 schema）
  TOOL.md               ← 人读的说明（可选；装进来会在界面上显示）
  scripts/close.mjs     ← 入口（包级 entry，动作也可以各自覆盖）
  lib/…                 ← 支持文件，只收文本
```

**四道判据**（全部在 `packages/protocol/src/tools.ts` 的 `ToolManifest` 里）：

1. `schema: "agentdeck/tool@1"` —— **不认识这个值就拒绝**，不做"尽力而为"（与判决 schema 版本化同一立场）；
2. `slug`（组名）是 kebab-case（⚠️ **D41 之后不再保留任何前缀**：原来 `comment` / `issue` / `notify` 是给内置动作留的，内置动作删掉之后它们只是普通的包名）；
3. `runtime` 必须是白名单里的一个（`node` / `shell` / `python3`）——**不给"你自己填个命令"的自由**；
4. `actions[]` 至少一个、动作名 kebab-case、组内唯一，`entry` 必须待在包里（不许 `../`、不许绝对路径）。

外加两条 schema 管不了、但必须查的：**声明的入口文件必须真的在包里**（否则第一次触发动作才炸，而那时人早忘了装过什么），
以及**每个开放参数都必须有界**（`string` 必须给 `max`——一个不限长的字符串就是往你系统里塞任意内容的入口）。

**为什么是 `tool.json` 而不是 `TOOL.md` 的 frontmatter。** skill 用带 frontmatter 的 `SKILL.md`，
照抄看起来最省事。但 skill 的 frontmatter **从来没有被结构化解析过**（`splitFrontmatter` 只把那段文字切出来），
而工具清单里有 `actions[]` 这种嵌套数组——手写一个 YAML 子集解析器正是"格式没被完整定义、半年后在某个缩进上炸掉"
的经典来源。JSON + zod 直接可校验，全仓库都是 zod，不引入新依赖、也不引入第二个契约来源。
于是包里有**两个文件、各干一件事**：清单给机器，`TOOL.md` 给人。

#### "组"落在三个具体位置，不是新造抽象

| 层 | 组意味着什么 |
|---|---|
| 安装 | 一次装一个目录（组）；组内多动作、多脚本 |
| 授权 | ~~挂载/摘挂以组为单位~~ ⚠️ **已撤**（2026-09）：挂载能力整个删掉，动作改为在审核者的「行动权限」里逐个勾（`Agent.allowedActions`） |
| 审计 | 记 `slug + version + source`，照 skill 的"标识与来源"做法 |

#### 挂载的落点：干活时送进工作目录（D42 接线）——⚠️ **整段已撤（2026-09）**

> ⚠️ **这一节描述的能力已经不存在了**，留着是因为它记着"当时为什么这么接"。现状：
> `Agent.toolIds` 不在协议里、`syncInjectedTools` / `removeInjectedTools` / `ToolCollisionError`
> 都已删、`PUT /api/agents/:id/tools` 也删了、`{{tools}}` 变量退役（工具包不再进第一句话）。
> **工具包现在只有一种身份**：动作的来源——装进来、在审核者的「行动权限」里勾上、判决通过时由平台执行。
> 下面这些段落读的时候请当成历史。

D40 把"执行者的能力是工具"定下来之后，`Agent.toolIds` 在很长一段时间里**只被存下来、没被用上**：
挂载/摘除接口、改角色防呆（"挂着工具不能改成审核者"）、卸载时"谁在用它"提醒都在，但**执行 run 从来不读它**——
技能会注入工作目录（`syncInjectedSkills`），工具不会。使用者点编辑看到"还有工具可以选"，选完干活时却什么都没发生，
界面也不说——这正是"行为面"最容易被误解的状态。

D42 把这条线接上，规则与技能**逐条对齐**（同一个归属清单机制）：

- **执行 run 开始前**，`syncInjectedTools` 把该 agent 挂载的包**整个写进工作目录**的
  `.agentdeck/tools/<slug>/`（脚本 + `tool.json` + `TOOL.md`，原样落盘）；
- **第一句话**里新增执行 run 专有的 `{{tools}}` 变量：每个包一行（说明 + 位置），
  模型自己去读 `TOOL.md`、自己决定怎么调脚本——工具**没有** CLI 自动发现机制，靠模型读；
- **跑完就删**（与技能同一版规矩：D30 之后工作目录只留 agent 的产出），删除依据是落盘的归属清单，
  不是内存数组；撞上使用者自己的同名目录 ⇒ `ToolCollisionError` ⇒ run 失败记 `injection_failed`
  （使用者改个目录名就能自己修好，不该报成"环境坏了"）；
- 审核 run **不注入**（审核者不挂工具，只判断不动手）。

同一时刻，**行为面在两个角色身上被明确分开**（同一个包有两种身份）：

| | 谁 | 什么时候用 | 界面说法 |
|---|---|---|---|
| 工具挂载 | 执行者 | **干活时**（run 进行中） | 执行者页那段叫「干活时能用的工具包」："挂载 = 把脚本与说明送进它的工作目录" |
| 行动权限 | 审核者 | **判完之后**（verdict 通过时） | 审核者页的「行动权限」：勾的是判完允许触发哪些动作 |

「工具」页现在只有一个身份：**它提供哪些动作可以授权**（那一列「动作数」还在）。⚠️ 「被哪些执行者挂载」那个 `mountedBy` 小标签随挂载能力一起删了。

#### 参数：bound / open 二分（这是"防误操作"的正解）

使用者的原话是「比如 issue.close(id, note)，**id 需要事前定义**，为了防止大模型误操作到其他 id，**note 会根据执行结果动态生成**」——
这正好把参数切成两类：

- **bound**：平台按事实注入（`subject.issueId` / `subject.runId` / `workspace.id` / `workdir` / 字面量），
  **模型看不见、也填不了**；
- **open**：模型填的那部分，每一项都必须有界（类型 + 上限 + 可选值域）。

★ 关键细则：绑定参数要**从模型可见的动作签名里删掉**，而不是"允许它填、平台再覆盖"。
覆盖式语义下模型仍以为自己在控制这个字段（下次它会尝试控制别的），它填错时你永远看不到那个信号，
审计里还会出现两套值。删掉之后，"误操作到别的 issue"就**从结构上不可能**——它手上没有这个字段。

#### 名字空间：保住"未声明即拒绝"，同时留出扩展位

内置动作仍是**闭合枚举**（裸名）；第三方动作写成 `<组 slug>.<动作名>`。（⚠️ **D41 把内置动作整个删掉了**——现在只有 `<包 slug>.<动作名>` 一种，见 §15.29；这一段留作历史。）
`ActionRefType` 是两者的并集，而"这个动作到底存不存在"由 daemon 侧**按工作区已安装的工具**解析——
**未安装/未授权 ⇒ 整条判决走既有 invalid 路径**，不静默忽略（忽略等于给模型一条绕过边界的路）。
~~内置动作的三个前缀因此在安装时就被保留~~（`RESERVED_TOOL_SLUGS = ['comment','issue','notify']`），
否则一个叫 `comment` 的包能声明出与内置同名的动作，而"内置优先"会让它**装得上、跑不了**——
最难查的那种。
> ⚠️ **这条保留已经删掉了**（D41）：内置动作整个没了，就没什么可保留的。现在每个动作名都带
> 包 slug，叫 `comment` 的包声明 `comment.create` 不再与任何东西撞车，那条限制只会挡住一个
> 合法的包名。见 `packages/protocol/src/tools.ts` 的 `KEBAB` 附近。

#### 平台保留四件事，执行器只执行

参数绑定与校验、幂等（键仍含 `verdictId`）、审计（`provider slug+version+source`）、状态（`succeeded/failed/…`）
全部由平台写。脚本只收到一份**已经绑定、已经校验过**的调用（stdin JSON 进、stdout JSON 出），
它不重试、不写库、不自己判定成功的语义。不这样切，每个第三方实现都会长出一套自己的边界。

**2026-09 改写：预演准入撤掉了。** 原来那套"`dryRun: "unsupported"` 的动作默认不得自动执行"的机制（workspace 上的 `allowUnpreviewedActions`、「工具」页的开关、动作上的「不支持预演，不能自动执行」徽章、`ActionRunner` 的准入拦截）**整体移除**：**动作直接执行**，是否执行只看它是否在审核者的行动权限里 + 参数是否合规。清单里的 `dryRun` 声明字段保留但**不再参与任何判断**（老包照装）。使用者的原话：「不应该有这个预览功能，不需要。直接执行就好」。

**「调试」取而代之（2026-09）。** 想看"这条动作会带着什么参数发出去"不再是预演准入，而是审核者行动权限里的一个**「调试」勾选**（`Agent.debugActions`，`allowedActions` 的子集，只对审核者有意义、没有任务级覆盖）：勾上之后判决引用该动作时 **`ActionRunner` 直接短路**——不跑脚本，只把动作连同**解析后的完整参数**（平台绑定 + 模型填的 + 固定参数）记进时间线（`Action.dryRun: true` ⇒ 显示「调试 · 未执行」），给调试看。守卫在 `apps/daemon/src/actions.ts`，不是界面一句提示。

#### 两条不能混的边界

1. **Action 与 Tool 是两个词**（§8.6 词汇不漂移）：带白名单、幂等、审计、绑定参数的那个叫 **Action**；
   agent 手里那个"手"叫 **Tool**（`apps/mcp` 暴露的那套）。混用之后没人分得清哪条边界在管哪件事；
2. **MCP 有两个方向**：平台调 MCP（把它当**动作执行器**）与 agent 通过 MCP 调平台（仓库里 `apps/mcp` 已经是这一条）
   是**两条不同的边界**。让 agent 直接连 MCP 去改状态，等于把 §8.4「动作必须有界」拆掉；
   **审核者不该拿到任何写工具**——审核者只判断、不动手，这是 `reviewer ≠ executor` 的自然延伸
   （所以 `role: 'reviewer'` 的 agent 挂工具会被服务端拒）。

#### 界面：侧边栏从 4 项变 5 项

原来定过"侧边栏恰好 4 项"，这一版**加第 5 项「工具」**——使用者的决定，理由是工具是安装与管理类的
高频入口，藏在设置抽屉或技能页的页签里会多两层点击。**既有探针里"恰好 4 项"那条断言要一起改**：
规矩变了，断言就得跟着变，否则探针会一直报一个"按新规矩是对的"状态。

#### 远端目录：可装、可发，但**不由远端装**

「从远端目录安装」与 skill 那条路**完全同形**：页面从远端取回条目，原样交给本机 daemon 装。daemon 不主动外联（D20），远端也不做安装——装一个包会在使用者机器上落盘、并让那些脚本真的被执行，那件事只能由本机做。

三处刻意的选择：

1. **内容随列表一起下来**（不是"列表给你名字、装的时候再取一次"）。两次取内容会让"页面看到的那份"与"装进去的那份"可以不一样，而那种不一致没有任何报错；多一次往返换的是这一条确定性；
2. **两端用同一份 schema**（`packages/protocol/src/tools.ts`）。远端若自己另写一套"看起来差不多"的检查，就会长出最难查的那种不一致：**远端说 A、daemon 按 B 解析**，症状是"装进来的包少了一个动作"——没有报错、没有堆栈。有一条**跨边界**测试把两端焊在一起（`apps/daemon/src/remote-tool-install.test.ts`：起真远端 → 取目录 → 交本机 → 逐字对照 → 真的 dry-run 跑一次那个脚本）；
3. **远端目录里放着可装的范例包**（`apps/remote/catalog/tools/`）。它们用的是与本地示例
   （`examples/tools/example-note/`）**同一个格式**——远端装来的包与本地目录装来的包
   没有任何区别，这正是"标准格式"该有的样子。远端那份目录**可以为空**（界面有空态），
   也可以被人往里加包。

   - `hello-tool/`：最简范例（一个动作、一个开放参数），演示「从远端目录安装」这条路；
   - `example-notify/`、`example-llm/`、`example-issue/`（D42 加）：**参数演示**范例，
     覆盖开放参数的全部四种类型（string / integer / boolean / enum——含「平台/渠道」、
     「模型」这类枚举）与绑定参数（`workdir` / `subject.runId` / `workspace.id`），
     以及"同一包里两个动作两套参数形状"。它们**不真的发通知/调模型/改单据**：脚本把
     收到的**完整参数（含类型）**写进工作目录里的日志文件——打开就能核对"这次判决
     到底传了哪些参数、类型对不对"。这是给使用者实测「判决 → 参数 → 脚本」管道的
     现成靶子，也在 `apps/remote/src/server.test.ts` 里钉着（列得出、带脚本、四种类型
     齐全）。

#### 没做与待做的

①**MCP 形态**留扩展位（远端目录安装已经做完，见上一段）；②**derived 参数**（平台从判决里取，如
`note = {{verdict.summary}}`）——它能进一步减少"模型要填的东西"，但要动判决契约（现在只有一个开放字段），
等真的有需要再说；③**一次判决触发多个动作（动作序列/事务）**不做：那会同时动到判决契约与幂等键，
而"动作必须有界"（§8.4）是这套东西的地基；④沙箱：与 D26 插件同一取舍——**不做沙箱**，靠"清单声明 + dry-run + 审计 + 显式标注"约束，
并在安装界面上写清"这个包里的脚本会在你的机器上执行"。

### 15.27 行动的结果进流程：判决通过 ≠ 事情做完了（D40 收口）

使用者一开始就问过一个更根本的问题：「应该是在新任务的时候配置审核通过就做某行动，还是应该在审核的
Agent 来配置某行动，甚至应该是配置在审核的 Agent 中，**审核通过并行动成功才最后算通过**」。

前两问在 D37/D40 里各落了一半（标准与动作白名单内联在审核者身上、动作由工具包实现），
**最后那一问一直没有被实现**——而它的表现是一句**会说谎的话**：「已审查」= 判决已产出，
动作成没成与它无关。判决通过、动作失败的任务，看板上跟"全都做完了"一模一样。

**这一版补的是闭环那一档**（`apps/web/src/lib/pipeline.ts` 的 `stageOf`）：

| 阶段 | 什么时候 | 看板列 |
|---|---|---|
| `executing` | 执行 run 还没到终态（或一次都没跑过） | 执行中 |
| `awaiting_review` | 执行完了、判决还没出来 | 待审查 |
| `action_running` | 判决要求做某件事，动作还在跑 | **行动中** |
| `action_failed` | 动作失败了 | 等待人处理（与 `needs_human` **同一列**） |
| `needs_human` | 判决自己说要人介入 | 等待人处理 |
| `reviewed` | 判决已产出**且**它要求的动作做成了（或本来就无需动作） | 已完成审查 |

三处刻意的取舍：

1. **判据是白名单**（`ACTION_DONE_STATUSES = executed / skipped / rolled_back`），
   而不是"不是 executing 就算完"。将来协议加了新的动作状态时，默认它是"没结束"——
   **宁可多显示一会儿「行动中」，也不要把没做完的说成做完了**；
2. **「行动失败」与「待人工」并成一列**：两者下一步动作**完全一样**——等人来看一眼。
   分成两列更整齐，代价是看板从 5 列变 6 列、每列挤到读不了；
   卡片上写清是哪一种，且两者都进「需要注意」那一拨（INV-8：通知只留给"需要你介入"的事）；
3. **动作类型与失败原因都带出来**：`GET /api/runs` 的投影里加了 `action: { status, type, error }`
   （与 `verdict` 同源同法，只给最新的那一份）。动作名是契约值（`example-note.append-note` 那种），
   **原样显示不翻译**；失败原因正是"要我去做什么"。

**没做的是"任务侧的承诺"那一层**（"这次流程什么算完"的人话验收条件）。它需要先在 `Issue` 上
有一个位置，而且对一次性任务价值有限、对**重复任务**才是重点——那要连"任务定义层"一起立，
是下一块的事（见 §15.26 末尾的"没做与待做的"）。

### 15.28 行动权限从 skill 搬到审核者身上（D40 收口）

使用者的原话：「**移除 Skill 中的行动配置，增加审核 Agent 的行动配置**」。

D37 把**审核标准**从 skill 搬到了审核者身上，但动作白名单**留在了 skill 里**——
于是同一件事（判完之后允许动什么）有了两个可能的位置，靠 D37 留下的那条兼容路径
（把挂载 skill 的 `allowedActions` 并起来）维持着一致。这条并集在"内联标准优先"的
规则下是能工作的，但它把两件不同的事绑在了一起：

| 问题 | 该由谁回答 | 它挂在谁身上 |
|---|---|---|
| 按什么判 | **审核者的标准**（`Agent.reviewStandard`：一段正文） | 审核者 |
| 判完**允许动什么** | **审核者的能力**（`Agent.allowedActions`） | 审核者 |
| 执行者干活时参考什么 | 资料包 | 执行者（`Agent.skillIds`） |

三者在 D37 之后仍然散在两个实体上，而 skill 又是**执行者**的东西——一个"资料包"
顺手决定了谁能改状态，这是最说不通的一处。

**搬完之后的三条规则**：

1. **写入口只写 `Agent.allowedActions`**；`ReviewStandard.allowedActions` 降级为
   **老数据的只读兼容字段**（整条记录以 JSON 存、读取路径上没有 zod 校验，所以老数据
   里它还在，按"回退"处理即可，**不需要数据迁移**）；
2. **回退只写在唯一那个解析点**（`apps/daemon/src/review-standard.ts` 的
   `effectiveAllowedActions`），而且是**两级只读回退**：
   `agent.allowedActions` 非空 ⇒ 用它；空 ⇒ `reviewStandard.allowedActions`（D40 之前
   搬进标准的那份）；还空 ⇒ **挂载 skill 里的 `allowedActions`**（更早的形态）。解析点
   只有一处，所以"哪个优先"不是一个要靠注释记住的问题。
   ⚠️ 第三级只读、只在最后兜底，理由是**不让老数据自己变行为**：D40 之前建好的审核者
   （标准与动作都在 skill 里）如果因为这次搬家拿到空白名单，它的判决会突然整条无效，
   而使用者**没有动过任何配置**。界面上对这类 agent 本来就有"沿用挂载的 skill（老配置）"
   的提示，现在那条提示同时说明动作的出处；搬移入口（`adopt-from-skills`）会把正文并进
   「指令」、把动作写到 `Agent.allowedActions` 上，于是第三级自然退出；
3. **只有审核者能有非空值**：执行者的能力是 **skill**（干活时参考的资料包），
   而动作是**判完之后**由平台执行的。写入口拒掉"执行者带动作权限"，与"审核者不挂工具"
   是对称的两条（各自的能力只给各自的人）。

**为什么这次没有做数据迁移**：这个仓库的 store 不做 schema 迁移（见 §3.3），
读取路径一律用"缺字段就按老规则"的方式消化新增/搬走的字段。代价是**兼容代码会长期
存在**，所以它必须只有一处、且注释要写清"它是给老数据的"。这一条与 D37 留下的
那条兼容路径是同一个套路，只是这次把方向反过来：从"skill 并集"改成"标准回退"。

### 15.29 移除全部内置动作：平台不再自带任何处置能力（D41）

使用者的决定只有一句：「**移除全部的 buildin tool**」。

**删掉的是什么。** 平台原来有六个内置动作——`comment.create` / `issue.update_status` /
`issue.add_label` / `issue.create` / `issue.assign_agent` / `notify.emit`：一个六项的闭合枚举
（`enums.ts`）、一张注册表（`actions/registry.ts`）、以及 daemon 里那个实现它们的 `switch`。
三者一起删掉，`registry.ts` 换成只剩"动作定义的形状 + 白名单校验"的 `definition.ts`
（连文件名都改了——叫 registry 却没有注册表，是留给下一个读者的坑）。

**为什么这是一次产品级取舍，而不是重构。** 那六条**是平台唯一会"动手"的地方**：
删掉之后，平台不再能写评论、改 issue 状态、打标签、建 issue、指派 agent、发"动作型"通知。
而这六件事**工具包替代不了**——工具脚本是外部程序，它改不了平台自己的数据（没有平台 API）。
于是 D41 之后的形态是：

| 谁 | 还能做什么 |
|---|---|
| 平台 | 收材料、派 run、收判决、**审计**、**通知**（升级给人那一路）、维护状态机与阶段 |
| 工具包（脚本） | 改工作目录、跑命令、够得着的外部世界 |
| **不再有人** | 改平台自己的数据（评论/状态/标签/指派/建 issue）——**除非**以后开一条受控接口 |

**这也是为什么"未声明即拒绝"这条规矩变得更硬了**：动作只有一种来源（已安装的包），
所以判据从"在不在那张表里"变成"**那个包装没装、有没有声明这个动作**"，
`resolveActionDefinition` 是唯一的解析点，`decideReview` 的动作校验**必须**带工具清单——
没有清单就什么都解析不出来（判决走结构性 invalid，不可重试）。

**判决契约跟着变了一处**：原来那句 `type 取：<六项枚举>` 改成"只能取**这次允许的那些**"，
而且**一个都不允许时契约要明说"不要写 `action`"**。这一条不是礼貌措辞：契约里没有的取值，
模型合理的做法只剩"编一个"，而编出来的动作名会让**整条判决**判为不合规——它本来想说的结论
也一起丢了（这类失败在本仓库出现过两次，见 §15.29）。

**老数据里那串动作名会变成"配过、但解析不出来"。** 使用者的库里现在就有一例：审核者的
`reviewStandard.allowedActions = ['comment.create','issue.add_label']`——D41 之后这两个名字
既不是内置动作、也不对应任何已安装包。三处都按"响亮 + 指路"处理，**没有一处静默替他改配置**：

| 位置 | 行为 |
|---|---|
| 判决引用它 | **结构性 invalid**（不可重试）+ 通知，零条动作记录（`no-builtin-actions.test.ts` 钉着） |
| 「行动权限」编辑栏 | 单列一组「**配过、但现在解析不出来**」，每条一个「移除」按钮 + 说清为什么（不去掉就会在保存时被拒） |
| 固化（`adopt-from-skills`） | **只搬现在真的解析得出来的那些**，并把丢掉的原样回给界面（`droppedActions`）——原样搬过去的话，那个审核者的权限里会永远躺着一串死名字 |
| **启动时清理**（`apps/daemon/src/dead-actions.ts`） | 把两处（`Agent.allowedActions` 与老字段 `ReviewStandard.allowedActions`）里**永远不可能成立**的名字去掉，逐条写日志 + 给那个 agent 落一条通知 |

**为什么最后还要在启动时清一次。** 上面三处都是"在界面上把话说清、把入口给到"，但使用者的真实遭遇是：
他打开审核者、改个名字、点保存——**被 400 拦住**（"allowedActions 里有不认识的动作：issue.add_label"）。
那句报错本身没错，却把**平台自己当年写进去、现在已经不可能成立**的取值变成了他的待办：
得先逐个「移除」才存得下去。而删掉它们既不会让谁失去能力（它们从来、也不可能被解析成动作），
留着也不会让什么变可用。所以启动时清一次，并且**说清删了谁、为什么**（日志 + 通知）——
他下次打开界面时权限是干净的，而且**知道它为什么变干净了**。

⚠️ 边界写在 `dead-actions.ts` 的文件头，三条：只删"永远不可能成立"的（判据用运行时**同一个**纯函数）、
改了谁要说清、别的字段一个字不碰。这与"保存时不许静默改权限"**不冲突**：那条防的是"使用者提交
了一份名单、平台悄悄改了再写库"；这里删的是平台自己留下的死数据。

⚠️ 它有一个可预期的副作用值得知道：**卸载一个包之后重启，它给那些 agent 配过的动作会被清掉**
（那些动作永远不可能再被满足）。日志与通知里会说清是哪一个包——把包装回来再勾一次即可。

⚠️ 编辑栏那一组存在的理由值得记：勾选框是**从已装工具的清单**画出来的，所以解析不出来的
值**不在任何勾选框里**——不单列的话，使用者既看不见它、也没法取消它，一保存就被服务端拒，
而错误里说的那个名字在界面上**根本不存在**。那是最让人卡住的一类错误。

**"开箱即用的闭环"因此不再成立**：首启播种的审核者动作权限是**空数组**——装了工具包、
在它的「行动权限」里勾上动作，它才第一次拥有处置能力。这是刻意的：平台的默认姿态从
"自带几种动作"变成"**什么都不做，除非你明确装了并授权**"。

**想让那六种能力回来，有两条路（都不该偷偷走）**：

1. 给工具脚本一条**受控的本地接口**（带授权、带审计），让脚本能请求平台写数据——那是一个新功能，
   要有自己的边界与准入；
2. 把这类动作做成**随平台发布的标准工具包**（同一套清单 + 脚本机制，装它跟装别的包一样），
   而不是把内置动作硬编码回 daemon——那正是这次删掉的东西。

**没删的是判断与记录**：verdict 的"一开一合"、审计链（输入快照 → 判决 → 动作 → 结果）、
环形边界、幂等键、阶段推导、通知渠道，全部照旧——它们回答的是"发生了什么"，
而 D41 删掉的只是"平台替谁动手"。

### 15.30 新建任务页的三步链：执行 → 审核 → 行动（D42）

使用者的要求是三条：「配置需要包括执行，审核，行动」；「执行 Agent 目前有默认值」；
「审核 Agent 默认就看当前执行 Agent 是否有配置审核 Agent，行动就是审核 Agent 是否有设置行动」。

**它补的是一个"在界面上根本没有答案"的问题。** 谁来审、审完能做什么，这两件事原来是
**分散在两个页面上的长期配置**：`Agent.reviewerAgentId`（「由谁审它」，住在智能体页）
与 `Agent.allowedActions`（「行动权限」，也住在智能体页）。于是"点下「创建并派发」的那一刻，
这条任务接下来会发生什么"——**只能靠记忆**。而忘记的时候，失败形态是安静的：产出跑完、
没有审核结论，也没有人告诉过你这是因为它压根没配审核者。

⚠️ **2026-10 更正**：那两处"分散的长期配置"后来**都搬到智能体组**了（agent 上那两个字段
撤掉）。所以这一节读的时候要注意：**"三步链"的默认来源换成组**（选组 ⇒ 审核者与动作都是
组的；不选组 ⇒ 没有审核者），而"这一次的覆盖"（`pick` / `none` / 动作白名单）语义一个字
没变。见 `docs/design/agent-groups.md` §16。

**三步链的默认推导：**

| 步 | 默认 | 可改吗 |
|---|---|---|
| ① 执行 Agent | workspace 的默认执行者（D36） | 可改（只能选 `role:'executor'`） |
| ② 审核 Agent | **跟随所选执行者的「由谁审它」** | 可改——**只对这一次生效** |
| ③ 行动 | **那个审核者当前生效的动作权限**（勾选框） | 可改——**只对这一次生效**（长期要改去智能体页改它的「行动权限」） |

改①，②③ 立刻跟着重算。

**③ 也**可以改**，但只对这一次生效**（使用者的修正：「行动不是只读，也要可以修改」——我第一版把它做成只读，
理由是"它是②的后果，不该在这页单独拧"。那个理由对了一半：它确实**默认由②推出来**，但"这一次我就要它
多做/少做一件事"是完全正当的一次性意图，跟②的"这一次换个人审"是同一类东西。错的不是可编辑，
是**让它看起来像在改长期配置**）。

于是 ③ 是一条勾选框列表，默认勾着②那个审核者**当前生效**的动作，改动的落点是
`SubmitRunRequest.allowedActions` / `Run.allowedActions`——**任务级覆盖**：

| 取值 | 意思 | 后果 |
|---|---|---|
| **省略**（含旧数据） | 跟随那个审核者的「行动权限」 | 照旧。★ 页面只在"勾选结果与那份**不一致**"时才带这个字段——否则会把一件长期安排冻结成一次覆盖 |
| **数组** | 这一次就用这一份 | 契约里列这些、判决收口按这份校验 |
| **空数组** | 这一次**一个动作都不许触发** | 判决只能给结论。它与"省略"是两件事 |

它**进判决契约**（模型只能写这里列的动作名），也是判决收口校验的来源——两处消费点都在
`executor.ts`，取法 `run.allowedActions ?? effectiveAllowedActions(...)`（**2026-09 修**：原来借的是 `resolveReviewStandard(...).allowedActions`，而那个函数回答的是「标准是什么」、**没有正文时返回 `null`** ⇒ 判断依据并进「指令」之后动作权限被整份吞掉，判决里的动作一律升级成「不在这个审核者的行动权限里（当前允许：无）」），**同一个判据写两遍就等于没有判据**。
派生审核 run 时由 `autoChainReview` → `createRunForReviewer` **原样带下去**（这条决定要生效的地方在审核侧）。

三条写入前的校验（都在 `POST /api/runs`）：非执行 run 带 ⇒ 400；这一次**没有审核者**却带 ⇒ 400
（没有判决就没有动作，这份白名单**没有落点**——收下它会让使用者以为"我配了动作"）；
动作不是来自已安装且确实声明了它的包 ⇒ 400（判据**复用** agent 的「行动权限」那一套，不重写）。

**②的三态是这个设计的中心，也是实现里最容易写错的一行。**

`SubmitRunRequest.reviewerAgentId` / `Run.reviewerAgentId` 是**三态**：

| 取值 | 意思 | 后果 |
|---|---|---|
| **省略**（含旧数据） | 跟随执行 agent 的长期配置（D28） | 照旧 |
| **`null`** | **这一次明确不审** | 不派生审核 run |
| **agent id** | 这一次换人审 | 派生给这个人，不动长期配置 |

为什么不折成一个 `string | null`：那样「照旧」与「这次不审」在**库里长得一模一样**，
而这两件事的后果差别很大——一个会有审核结论，一个不会有。审计时也看不出"这条没被审"
是当年的配置如此，还是某个人当下决定放过它。所以 `apps/daemon/src/executor.ts` 里
**必须原样保留 `undefined`**：一旦写成 `reviewerAgentId: req.reviewerAgentId ?? null`，
"照旧"就会静默变成"不审"，而 run 状态一切正常——这正是本仓库反复出现的失败形态。
接口投影同理（`RunSummary.reviewer = {mode:'follow'} | {mode:'none'} | {mode:'override'}`），
页面如实显示而不是猜。

**为什么覆盖要落在执行 run 上，而不是审核 run 上。** 审核 run 是执行 run **跑完之后**
才由 daemon 派生的（`autoChainReview`），那一刻没有人再问使用者的意见。要"这一次换人审"，
这个决定必须随执行 run 一起落库，派生时再读出来。
  ⚠️ 2026-10：读法原来写作 `run.reviewerAgentId ?? executor.reviewerAgentId`——后半截
  （执行者身上的长期配置）已经撤掉，现在只看**这条 run 上有没有审核者**
  （缺字段 ⇒ 没有 ⇒ 不派生）。

**校验放在写入之前**（`POST /api/runs`，三种 400 分得很细，因为它们对应三种不同的改法）：

| 坏值 | code | 为什么不能留到执行时才发现 |
|---|---|---|
| 指定的 agent 不存在 | `reviewer_not_found` | 跑完才发现，只能说"审核者没了"——而那时使用者已经等了一轮执行 |
| 角色不是 `reviewer` | `reviewer_role_mismatch` | 指派一个执行者去审核 = INV-1 退化 |
| 就是执行者自己 | `reviewer_must_differ` | 自我审核 = 整个闭环是假的 |
| 加在**非执行 run** 上 | `reviewer_override_not_applicable` | 审核 run 不会再被审一次。**收下不用的字段**在这里最贵：使用者以为换了人审，而那个设置永远不会生效 |

⚠️ 还有一处**执行时再查一次**角色：提交时合法、之后那个 agent 的角色被改了。真出现这种情况
必须**跳过并说明**，不能照跑——否则 INV-1 破了，而表面上"审核结论看着正常"。

⚠️ **"没有串接审核"有两种，处置不同**（这是这一节里最容易漏掉的一处）：

| 情形 | 性质 | 处置 |
|---|---|---|
| 执行者没配审核者 / 这次选了不审 | D28 里是**合法选择** | 只写进这条 run 的记录（run 详情里看得见），**不打扰人** |
| 指向的人没了 / 角色被改掉了 | **出事了**：配置过一次、现在失效 | 进**通知中心**（`review.reviewer_missing` / `review.reviewer_role_changed`），与"链路深度超限"同一档 |

第二档只写一行日志的话，发现它的唯一途径是有人正好去翻这条 run 的日志——而它的后果是
"这条产出没被审，run 状态却一切正常"。角色被改那条路是**真实可达**的：`PATCH /api/agents/:id`
允许把角色从 reviewer 改成 executor，而没有任何一步会去清理别人身上指向它的 `reviewerAgentId`
（也不该清理，那等于替使用者改配置）。

⚠️ 2026-10：那段"别人身上指向它的 `reviewerAgentId`"**已经不存在了**（字段撤掉），
而这一档**照样达**——指向审核者的地方换成了**组的成员表**：把组里那个审核者的角色改成
executor，那条链就失去了审核者。所以处置一个字没变：跳过 + 进通知中心
（`review.reviewer_role_changed`），提交时那条 `group_shape_invalid` / 角色校验也照旧拦。

⚠️ 顺序也是行为：校验是 **不存在 ⇒ 与执行者同一个（INV-1）⇒ 角色不是 reviewer**。
反过来写的话 `reviewer_must_differ` 就是一句到不了的话——"让执行者审自己"会命中"角色不对"，
使用者读到的是"这个 agent 不是审核者"，而他真正做错的是"你想让它审自己"（指错方向）。
判据只能比 id：`agentRef` 是执行者时它当然是 executor，拿角色当判据等于把这条检查关掉。

**③ 为什么必须在默认情况下就说清"不会触发任何操作"。** 因为 D41（§15.29）之后，
**首启播种的审核者动作权限是空数组**——"这个审核者什么都不会做"是**默认状态**，不是异常。
所以第三步在多数情况下显示的正是那句警告：判决只会给出结论。把它显示出来，
是让 D41 的后果在**提交之前**可见，而不是跑完看日志才知道。

**老数据怎么办**：旧 run 没有这个字段 ⇒ 语义就是"跟随"（与旧行为逐字一致），不需要迁移。

**⭐ 一个必须提防的版本错位：旧 daemon 会"静默忽略"这个字段。** 界面与 daemon 是**两份产物**，
而日常做法恰好容易造成错位——"重建前端 → 刷新页面"**不带**重启 daemon。请求体那层没有 zod
校验，未知字段被直接丢掉：于是页面上那个「不自动审核（这一次）」根本没发生，任务照旧被审，
**两边都不报错**。

所以页面用**能力标志**决定给不给那两个选项：daemon 在 `GET /api/identity` 的 `capabilities`
里报 `reviewer-override`（`Capability.ReviewerOverride`），页面拿不到就**只留「跟随」**
（= 旧行为，逐字一致）并说清"重启 daemon 之后才有"。三处细节都是刻意的：

- 身份还没到手（`$identity === null`）时按**不支持**处理——那种情况下先给出来、到手后再收回去，
  会让人白选一次；
- 真正发出去的用 `effectiveChoice`（不支持时恒为 `follow`），**显示与提交同源**——分两处判
  就会分叉，而分叉的表现正是"页面上写了不审、实际审了"；
- 界面只**降级**、不报错：这是"能力缺失"，不是"出故障"。

这正是协议里那句"**能力标志优先于版本号**——版本号无法可靠回答'你实现了 X 吗'"的用处。

**这一节没有做的事**（留给使用者决定）：把「挂载工具包」也变成第二次锁、以及任务侧的承诺层。

### 15.31 动作的固定参数：使用者在界面上钉值，平台在执行时注入（D43）

D42（§15.30）回答"这一次**能不能**触发它"，固定参数回答"触发它时**用什么参数**"——
同一件事的两半，所以它复用白名单的全部判据。

**为什么必须有这一层**：action 的 open 参数（模型在判决时填的那几个）意味着"触发的
那一刻参数**由模型决定**"。使用者对某些动作要的是**固定的行为**（"报给 `@qa`"、
"定级 `P1`"、"标题前缀 `[急]`"）。要是只能靠改工具包或靠模型自觉，就回到"直接改工具
就好了"——而那是使用者明确否掉的方案。于是：**审核通过 → 平台执行动作**的管线不变，
参数里那些由使用者钉死的值由平台注入。

**语义（与白名单逐条对齐）：**

| | 白名单（D42） | 固定参数（D43） |
|---|---|---|
| 长期配置 | `Agent.allowedActions` | `Agent.actionParams` |
| 这一次覆盖 | `Run.allowedActions` | `Run.actionParams` |
| 判据 | 字段在不在（省略 = 跟随） | 字段在不在（省略 = 跟随） |
| 空值含义 | `[]` = 这一次一个都不许 | `{}` = 这一次不固定任何参数 |
| 谁拥有 | 只属于审核者 | 只属于审核者（执行者 400） |

- **只给 open 参数钉值**：绑定参数（bound）是平台按 run 事实注入的，不归使用者钉
  （保存时校验会拒）。
- **钉了 = 固定，模型不许写**：固定值在执行时注入（`mergeActionParams` 的顺序是
  open → fixed → bound）。模型在判决里写一个固定参数 ⇒ **结构性不合规**（不可重试）：
  这不是"模型手误"（手误才重试），而是它越过了使用者明确钉下的边界——重试只会把
  同样的越界再写一遍。因此它的错误消息用 `固定参数 ` 前缀而非 `动作参数 ` 前缀
  （`isStructuralInvalid` 靠前缀把"参数手误"判成可重试，见 `pipeline.ts`）。
- **契约必须说清**：`toolActionLines` 把固定参数从"你只需要给：…"里减去，并单独列一行
  `⚠️ name 已由使用者在界面上固定为 <值>，平台会注入——不要写它（写了会被判不合规）`。
  不减去、不说明，模型就会去猜或者照填——前者是"没信息"，后者是"必然被判不合规"。
- **任务级覆盖优先**：`run.actionParams ?? agent.actionParams ?? {}`（键在为准）。
  新建任务页 ③ 的编辑器默认值就是审核者长期那份；改过才把 `actionParams` 带进请求体
  （没改就让 key 根本不出现，同"省略 = 跟随"）。改了之后那句"固定参数改了——只对
  这一次生效"必须出现，改回来必须消失：**"其实没改"不许带一次覆盖出去**，那会把长期
  配置冻成一次性决定。

**界面**（`ActionParamEditor`，与智能体页「行动权限」共用同一套 open 参数解析）：按类型
给控件——enum → 下拉（含"不固定（模型填）"空档）、boolean → 下拉、integer → 数字输入、
string → 文本输入；只对**勾上的**动作出现，且受 `task-action-whitelist` 能力标志门控。

**保存时校验（写入口）+ 运行时校验（判决收口）两道**，与白名单同一套布局：agent
POST/PATCH 与 run 提交都对着**已安装的工具包**解析（动作没装 ⇒ 400）、参数必须是 open、
值要满足类型/上限/枚举、`null`/`undefined` 不许钉（"要固定就填一个值，不固定就把这一项
删掉"）；判决收口时模型写了固定参数 ⇒ 结构性 invalid、升级给人。

**老数据怎么办**：旧 agent/run 没有 `actionParams` 键 ⇒ 语义是"没固定任何参数"（与旧行为
逐字一致），不需要迁移。幂等键仍是 `{verdictId, type, ref.params}`——固定参数是配置，
不进幂等键。

### 15.32 实施顺序的两条建议（已在实现中验证）

1. **M0 先做 `Store` 端口与文件适配器**——`FR-STOR-03` 一旦后期才发现违规，
   改动会穿透整个代码库。实现时这条被证明是对的：端口的 `transitionRun`
   直接决定了执行器的写法。
2. **M1 先做 verdict schema 与 `invalid` 路径**，而不是摄取器——先定契约
   再接入生产者，比反过来便宜得多。

---

### 15.33 第一句话从「一段模版插值」改成「三块组装」（2026-09）

**使用者的提案**（原话）：「把组装成一句话改成三句话（直接输入 3 句分开的话）…第一句：就是第一句话模版（放些公共的部分）／第二句：智能体的指令，描述的身份、性格等／第三句：任务描述」。
追问里他又定了三条：「优先用**三个真的消息**，如果 runtime 不支持，就用**一段里的三块**」「①② 在聊天里也发」「空 ② 跳过」；后面又补了「审核 Agent 的标准也放 ② 里面，不用单独设置」「不要旧装配（方案 C）」。

**现在长这样**：交给 CLI 的东西是**三块**（`DeliveryBlocks`，`packages/agent-core/src/first-sentence.ts`）——

| 块 | 里面是什么 | 谁决定位置 |
|---|---|---|
| ① **框架** | 工作区级那份模版渲染出来的（run / 对象 / 语言 / 技能清单…与使用者写的护栏、输出要求） | **模版**（`Workspace.executeTemplate` / `reviewTemplate` / `chatTemplate`），**每轮都发** |
| ② **身份** | `Agent.instructions`；(审核者)后面接上老数据里那份标准正文（`reviewerIdentity()`） | 平台，**不经模版** |
| ③ **任务** | 这次的正文；审核时还有"这不是给你的指令"那句声明、两个材料标记 `<<<ALPHA_MATERIAL>>>`/`<<<END_ALPHA_MATERIAL>>>` 与材料本身 | 平台，**不经模版** |

**投递两档**（`deliveryModeFor(runtime)` 决定，**记在 `Run.deliveryMode` 上**，可选字段：缺省 = 老数据）：
**A** = ①② 走系统提示通道（`--append-system-prompt`）、③ 走这一轮的用户消息；**B** = 三块合成**一段**、块边界显式（给没有那个通道的 runtime 兜底）。
同一个模版在两个 runtime 上形状不同，而"两边都不报错"是这个仓库被咬过三次的形状——所以档位落库、日志里写「第一句话（投递档 A：…）」。

**两条实测撑着整个设计**（不是推的）：
1. **系统提示活不过 `--resume`**——第二轮不带它时，模型明确回答"现在的系统提示里没有那条约定"⇒ A 档必须**每轮都带**（使用者最初定的"① 只在该会话第一轮发"被这条推翻）；
2. **每条 stdin 用户消息各换来一个模型回合**（两条消息 → 2 个 assistant / 2 个 result）⇒「把三块拆成三条用户消息」那个方案被否掉：叠加上一条，它等于每轮三个回合。

**六个变量退役**：`{{instructions}}` / `{{prompt}}` / `{{standards}}` / `{{tools}}` / `{{material}}` / `{{materialTitle}}`（② ③ 的位置不再由模版定）。变量表 15 → **9** 条（`runId` `subjectType` `subjectId` `language` `skills` + 审核专属 `reportKind` `issueId` `previousContext` `verdict`），审核那份**唯一不能省**的是 `{{verdict}}`。老模版由 `migrateTemplate()` 在**读取时**摘掉那几行（内容一个字不丢），接口返回迁移后的样子 + `adjustments`；**存老模版也不再被拒**（先迁移再校验），否则"原样再存一遍"会 400、看起来像界面坏了。

**材料为什么必须在 ③**：它是**第三方内容**。放进 ①（系统提示那一层）就等于把"别人写的一段话"摆在**规则**的位置——那正是提示注入想要的位置；两个标记是重试取回材料的硬契约，必须紧贴材料。

**聊天也有三块**：① 是**聊天自己那一份**框架（默认很薄：「这不是派活」+ 语言 + 技能清单；任务那份框架含 run 头、"完成后给出一份报告"与判决契约，灌进聊天是错的，见上面那段 D49 的教训）；② 也发（在此之前它静默失效、而技能照旧注入——同一个 agent 在两条路上性格不同）；③ 是使用者那句话**逐字**（`trim()` 都不做）。

**三处口径收在一处**：审计哈希覆盖两块（`deliveredBytes()` = `系统提示\u0000用户消息`）、上下文副本带注释说明哪块走哪个通道、日志写明用哪一档。

**2026-10 补记：三块各有一个模版框（`BlockTemplates` / `TemplateBlock`）**。使用者定案：「分 3 段模版设置，而不是同一个模版」——不是把 ② ③ 并进原来那篇，而是每条链路（执行 / 审核 / 聊天）下三个**独立**的框（① 框架 / ② 身份 / ③ 任务）。上面那张表里"谁决定位置"从「平台，不经模版」变成「框模版」：② 由**身份框**用 `{{identity}}` 摆放、③ 由**任务框**用 `{{task}}` 摆放（默认框 = 这两行，逐字节不变）；内容仍由平台组装——材料标记、判断依据合成这些**安全件**不交给模版，模版只定位置/标题/包装。`{{identity}}` 可选、`{{task}}` 必需（三条链路都要，少了这条 run 就没有任务）；两个变量各只属于各自的框，写错框被保存时专门拒绝并说清归属。变量表 9 → **11** 条（框架九条 + `{{identity}}` + `{{task}}`）。老三个键（`executeTemplate` / `reviewTemplate` / `chatTemplate`）= 框架框，新六个键（`*IdentityTemplate` / `*TaskTemplate`）= 身份 / 任务框；PUT 按 kind × block 打补丁（未传的块不动），preview 只渲染指定块。**安全边界不因开放而松动**：模版只在 ③ 里 `{{task}}` 的位置上动包装，材料与标记仍由平台放进 `taskBlock`（有测试钉着：任务框改得面目全非，材料标记仍在 ③、绝不在 ①）。

**这一轮收口时改掉的三件事**（都是"判据留在老字段上"）：
1. **「审核标准」那一整段从界面删掉**（使用者要求「移除审核智能体的『审核标准』」）——判断依据并进 ② 身份，一件事只该有一个出处；老数据那份正文、以及"并进来"的入口搬到「指令」那一栏；挂载 skill 的选择/展示搬到它自己的「技能」段。服务端 `adopt-from-skills` 的落点也从 `reviewStandard` 改成 `instructions`。
2. **保存（`PATCH`）时顺手并进「指令」并清掉老字段**（使用者：「建议我重新编辑保存后 就应该去掉这些旧资讯」）——三种情形**不并**：请求里显式带了 `reviewStandard` / 指令为空（并了会把它变成"能接审核任务"，而资格判据就是指令非空）/ 正文来自挂载 skill（并它必须摘挂载，那是没同意的改动）。
3. **三个"只看老字段"的判据**（前两个是这一轮抖出来的真缺陷）：动作权限的取法（`effectiveAllowedActions` 必须**导出**并直接用——借 `resolveReviewStandard(...)?.allowedActions` 会在"依据并进「指令」"之后整份丢掉）、报告路由的粗筛（`hasReviewIdentity` 必须认「指令」——否则第三方报告全部 `unmatched`、静默没人审）、详情页那条红警告（`apps/web/src/lib/agent-identity.ts` 的 `hasReviewIdentity`）。三处都有各自的测试钉着。

### 15.34 推荐清单：抓取用独立工具、复用旧 UI、内容不进代码仓库（D50）

**需求原话**：「我需要『安装 Skill』增加一个推荐 Skill 的安装」，随后两条定案：
**「放远端上，这样有利于维护者更改」**、**「只推荐 github 上有的」**。

#### 定案

```
维护者改 tools/skill-catalog-sync/recommended-skills.json
        ↓  pnpm run sync-skills [--dry-run]        ← 独立工具，不是远端服务
工具用与 daemon 同一份取包规则抓取 + 校验 + 原子替换
        ↓  内容落一个目录（默认 ~/.agentdeck/remote/catalog-skills/，不在代码仓库里）
        ⇢  ── 工具与服务之间**只有这一条约定** ──
远端服务读那个目录（不联网、不抓取）
        ↓
GET /api/catalog → catalog.skills[]（每次请求重扫）
        ↓  复用既有那张「从远端目录安装」表
技能页「安装技能」抽屉 → 点安装 → POST /api/skills（payload 路，daemon 再校验一遍）
```

**与最初方案的差别**：我原本设计的是"远端只给指针（`owner/repo/ref/目录`）、由 daemon 去 GitHub 取"，使用者改成"远端抓下来、复用旧 UI"。**这一改更好**：

- **使用者的本机不必能到 GitHub**——公司代理、匿名限额 60/h、要不要给 `AGENTDECK_GITHUB_TOKEN` 都不再是"装一个推荐技能"的前提。推荐这条路本来就不该要求这些。
- **前端几乎零改动**：`catalog.skills` 的类型、那张表、`installRemoteEntry`（payload 路）、`catalogEntryState` 的"已装 / 可更新"判定、远端不可用与未登录两种状态——全都在。而且它顺手填上了那张**一直是空的**表。
- **维护者在同步那一步一次把关**：内容落盘前就过同一套校验，而不是让每个使用者的 daemon 各自去撞 GitHub。

#### 三条不肯让步的规矩

**① 取包规则只有一份（这就是 `packages/skill-source` 存在的理由）。**
抓取工具要做的事与 daemon 装技能一模一样：主机白名单、只允许 https、每一跳跳转都校验、限额、必须有 `SKILL.md`、`slug` 怎么收敛。各写一份就会长出这个仓库最忌讳的那种不一致——而这一次的后果特别具体：**目录会把一份 daemon 装不进来的东西列成"推荐"**，使用者点下去才失败，而失败原因看起来像"平台坏了"。所以 `skill-source.ts` 从 daemon 里抽出来独立成包，两个调用方共用。
**推论**：`slug` 与 `sourceRef` **不写进清单**，由取包规则算出来——手写两份身份标识就是漂移的开始。

**② 单条失败 ⇒ 一个字都不替换（P7）。**
抓取全程先在内存里做完，全绿才写临时目录、再替换。半份目录比旧目录更糟：使用者会点到一个"看起来能装、其实是半截"的条目，而维护者以为同步成功了。首次真跑就撞上了这个场景（见下），行为正确：输出「目录没有改动」并以非零退出，逐条给原因。

**③ 内容不进代码仓库。**
清单在仓库里（**只有 URL 与我们自己写的说明**），抓下来的内容落 `<dataDir>/catalog-skills/`——与插件、账号数据同一个地盘。两个理由：仓库不该被第三方内容撑大，以及"这份内容从哪来"必须一直答得出来（`sourceRef` 保留**原始 GitHub 来源**，远端是中转不是出处，落库记录与审计链仍指回上游）。

#### 几处具体取舍

- **版本 = 上游那个目录最近一次提交的短 sha**，不是抓取时间。抓取时间每次重跑都不一样 ⇒ "有没有更新"这条判据每次同步后都变成"有更新"，使用者会学会无视它。取不到（限额、抖动）⇒ `null`，**不算失败**：目录是好的，只是这一条没法比版本。界面遇到 `null` 时如实说"无法判断是不是同一份内容"，不拿它去比大小。
- **元数据放技能目录旁边**（`<root>/.sync.json`），不能放技能目录里——`skill-source` 的本地取包规则会把技能目录里每个文本文件都当成**支持文件**收走，元数据会被装进使用者的技能里。
- **每次请求重扫**（与工具包同一条理由）：缓存住会让"我刚同步完怎么不出现"变成需要重启才能解释的谜。
- **补了空态**：`server.ts` 那条注释早就写着"目录可以为空，界面要有对应的空态——'目录里什么都没有'是一句真话"，而这张表一直只渲染一个空 `<tbody>`。现在它与"远端不可用""未登录"三种状态**分开说**——三者的下一步完全不同。
- **顺带修掉一个静默缺陷**：前端 `installRemoteEntry` **从来没有传 `files`**。远端目录一直是空的，所以这条路从没被真跑过；一上推荐，pptx 那类带 `scripts/` 的技能就会**只装进 `SKILL.md`**——正是这个仓库反复警告的那种坏法：界面显示"已安装"，跑起来才发现少东西。daemon 侧本来就收这个字段（`POST /api/skills` 的 payload 路），只是前端没给。

#### 两次真跑留下的记录

- **清单路径逐条核实**（GitHub API，不是猜）：`anthropics/skills` → `skills/pptx`、`mattpocock/skills` → `skills/engineering/research`、`jimliu/baoyu-skills` → `skills/baoyu-slide-deck` …共 12 条。
- **首次 `--dry-run` 撞上匿名限额**：当时按设计意图算的是"12 条约 24 次 API 调用（每条一次列目录 + 一次取版本）"，前 5 条抓成（正好是最小组合 `pptx`/`docx`/`research` 加 `xlsx`/`doc-coauthoring`），第 6 条起被 60/h 挡住。
  ⚠️ **那个"24 次"是错的，2026-10 实测更正**：列目录是**每个子目录各一次**，所以调用数取决于目录树有多深——单条 `pptx` 实测 **11 次**（52 个文件、9 个目录 ⇒ 列目录 10 次 + 取版本 1 次）。于是 **12 条的清单在匿名 60 次/小时下装不下一整轮**：这既解释了"为什么第 6 条就撞墙"，也让"等配额重置再跑一次"这条建议**不成立**（下一轮还是会在同一条附近停下）。**这正是"单条失败不替换"被真实触发的第一次**：命令输出「有 7 条没抓成 —— 目录没有改动」并非零退出。正式同步建议给 `AGENTDECK_GITHUB_TOKEN`（错误提示里已经这么写）。若将来嫌调用数太多，一条现成的优化是"内容没变就复用上次记的版本"（稳定态下省一半调用）——**没有做**，留给需要时。
#### 2026-10 修订：抓取改成**独立工具**（使用者："还是单独工具吧，不要和 remote 连在一起"）

抓取原来挂在远端 CLI 上（`pnpm run remote sync-skills`）。真跑撞限额之后，使用者连着问了
两件事——"你用什么方式同步 skill 的，下载代码还需要花令牌？"、"之前从 github 安装 skill
也是要过这个 API 吗"——问明白之后**定案：拆开**（就是上面 §12.1 那条新写的形状）。

- **工具**：`tools/skill-catalog-sync/`（自带清单与一份 README，命令 `pnpm run sync-skills`）。
  抓取、校验、原子替换、退出码语义全在这里，另外多打一行**实测**的 API 调用次数。
- **远端**：只剩"读目录 + 校验 + 返回"。没有抓取代码、不碰 `api.github.com`、清单也不再
  在 `apps/remote/` 里。
- **两边只靠一个目录相连**：工具 `--out` 写、服务 `--data-dir` 读。没有共享代码、
  没有共享常量、没有互相 import。
- **这条约定会失配，所以要说出来**：工具写到 A、服务读 B ⇒ 界面里目录是空的，而两个进程
  都不觉得自己错了。对策只有一句**把写到了哪儿打出来**（外加 README 里那句"服务用
  `--data-dir` 时你也要 `--out`"）——没有做自动发现，那会把刚拆开的耦合以另一种形式接回去。
- **`tools/` 不在 `packages/*` / `apps/*` 的自动发现里**，所以显式加了三处：
  `tsconfig.json` 的 `include`、根 `package.json` 的测试 glob、`pnpm-workspace.yaml`
  （最后一条只为让 pnpm 接好 `@agentdeck/skill-source`）。不加的后果分别是
  "代码可以烂掉而不报错"与"测试永远不跑——而没跑看起来和通过一模一样"。
- **参数层的意外也一并收口**：`pnpm run remote` **不做子命令分派**，所以它没看懂的 token
  从前会掉进"那就起服务吧"这条默认路径。真踩过两次，第二次是这次拆分的直接后果——
  `pnpm run remote sync-skills`（拆分前**有意义**的写法）不再匹配任何东西，于是**又去起服务**；
  写这条测试时实测它挂了 **300 秒**才被外部杀掉，全程没有一行说自己理解错了。现在两个命令
  都**点名拒绝**不认识的参数，认得出旧写法时直接给出新命令（`pnpm run sync-skills`）。
  同一层还顺手堵了另一种静默：工具端 `--dryrun` 这种手滑如果被忽略，结果不是"什么都没做"，
  而是**真的一次同步**——那是"静默降级"里最贵的一种。
- **两条为配额而定的行为**（使用者随后提的两条要求，都已实现并有测试）：
  ① **第一条失败就停**——原来会把剩下的条目挨个试一遍，撞限额时屏幕上就是十几行
     一模一样的话，而结论（目录一个字都不改）在第一条失败时就定了；现在如实报
     "后面 N 条没有再试"。测试钉的方式是**断言后面的条目一次都没被请求过**（只断言
     "失败只有一条"是不够的——把失败吞掉也能满足它）。
  ② **1 小时内抓过的不再下载**——沿用本地那份，0 次 API 调用，版本与 `fetchedAt`
     原样沿用（改掉它们就等于谎称"这是新抓的"）。合起来让"撞墙后重跑"变成**收敛**：
     已抓到的沿用、配额只花在缺的那几条上。`--dry-run`（它的用途就是逐条真抓一遍）
     与 `--refresh` 无视这个窗口。
  ⚠️ 复用**不是相信索引里那几行字**：内容要从磁盘读回来、过一遍共用取包规则
  （`resolveLocalPath`），读不出来就回退重抓并记一条 warning。这里踩了一个坑：
  `resolveLocalPath` **只收绝对路径**（刻意的规定），于是 `--out` 给相对路径时复用
  **悄悄走不到**、白花一轮配额（当时只留了一条 warning）。修法是先把落盘目录
  `resolve()` 成绝对路径，并在报告里回传它——"写到了哪儿"必须是一个不管 cwd 在哪儿
  都指同一个地方的字符串。这条也补了测试（相对路径下必须能复用）。
- **⚠️ 三个状态曾经是假的**（2026-10 使用者报："安装 skill 提示『远端不可用』，我明确已经
  启动 remote 了"）：技能页的远端目录那段状态链写的是 `{#if remoteError}`——**裸的 store
  对象**，恒为真。于是
  ①那条"远端不可用"**无条件**显示、冒号后面还空着（因为压根没有错误，`$remoteError` 是空串）；
  ②`{:else if !remoteError && isLoggedIn()}` 让"目录里没有条目"的空态**永远走不到**（`!对象` 恒为假）；
  ③中间那个"未登录"分支成了**死代码**。
  也就是说一个漏写的 `$` 同时废掉了三个状态里的两个，而**界面上看不出来**——
  `svelte-check` 完全合法（`Writable` 是个对象，`{#if}` 收 any）。**是使用者报的，不是我们发现的。**
  修法：订阅值（`$remoteError`）。**两条机器判据**（都要能变红，都做过变异验证）：
  `tests/web-template-stores.test.ts` 扫全部 `.svelte`，抓"判断/循环里裸用 store"（动态收集
  store 名单、跳过同名局部变量与字符串字面量，避免误报——**误报的检查会被下一个人关掉**）；
  探针里两条与环境无关的判据（"出现了『远端不可用』就必须带真实错误文字"、"这个页签四种状态
  至少渲染出一种"）。把 bug 放回去，两边都会红。
- **清单可声明 include/exclude**（2026-10 使用者问："类似这样的仓库（包括大量的其他文件），
  我有什么好的办法区分哪些是必须的吗？"）：**回答是"格式没给"**——`SKILL.md` 的 frontmatter
  不声明依赖，所以只能声明或推断。实测两个真仓后我把它定成**声明**：任何单一自动判据都会判错
  （`assets/` 在一个仓里 70 个全必需、在另一个仓里 13 个只用 3 个；`scripts/` 里混着
  `verify-output/**` 的测试产物；超限的大图两处都不被引用）。实现要点：图案相对技能目录、
  **在下载之前剪枝**（目录图案连列表都不请求）、**`SKILL.md` 不许被排除**、被排除的逐个进
  `ignored` + 索引 `excluded`（界面装之前显示"内容不完整：跳过了 N 项"）、改图案不再复用旧内容。
  ⚠️ 加字段时**契约测试当场红了**：那份"工具写出来的键表"用例（它存在的意义就是让
  跨进程的键表漂移被发现）逼我同时更新 `apps/remote/src/server.test.ts` 的手写夹具与
  `catalog.ts` 的读取——**这正是当初把它写成测试而不是注释的原因**。
- **`--help` 与"帮助不许撒谎"**（2026-10 使用者："可能命令会记不住，是否增加 help 命令行"）：
  同步工具现在有 `--help` / `-h`（只读：不读清单、不联网、不写盘，退出码 0），并**抄了 daemon
  那套机器检查**——帮助里出现的每个 `--flag` 必须在参数表里存在，反过来参数表里的每个旗标
  也必须在帮助里写明（不许有隐藏开关）。⚠️ 加这条时踩到一个坑，值得记：`cli.test.ts` 要
  import `cli.ts` 拿 `HELP` 与参数表，而那个文件末尾**无条件执行 `main()`**——于是测试进程
  带着测试运行器自己的 argv 跑了一遍 CLI，参数不认识 ⇒ `process.exit(1)` 把**测试进程本身**
  干掉，表现是"9 条用例全绿、这个文件却红"。修法是加**主模块守卫**（`import.meta.url` 与
  `process.argv[1]` 比文件名，与 `apps/daemon/src/cli.ts` 同一套）。
- **可选加速器（第三方）**（2026-10 使用者："github 下载容易失败，可以用加速器（https://gh-proxy.com/）"）：
  `--github-proxy [地址]`（daemon 那条路同一个旗标）把每个 GitHub 请求转给它——**值可省略：
  裸写就用 `https://gh-proxy.com`**（`resolveGithubProxy` 一处判据，`off` 直连），
  这是使用者后来补的一条："命令记不住"时的省事写法。⚠️ 它**不等于"默认开"**。**实测**：它连
  `raw` 与 `api.github.com` 都能转，而且**用它自己的凭证**请求 GitHub（响应头
  `x-ratelimit-limit: 5000`）——所以它同时解决了"下载不稳"和"匿名 60 次装不下 12 条"两件事
  （实测 3 条清单 111 个文件一次跑完）。三条硬规矩：默认关、只代理 GitHub 三个主机、
  **走代理不带我们的 token**（`githubRequestTarget` 一个判据管两处，两处各有一条测试钉着）。
  ⚠️ 代价是**第三方进了信任链**：它能看也能改内容。这条不改白名单的**默认**形态——
  白名单挡的是"把本机服务变成访问任意地址的跳板"，而加速器主机是使用者**显式指定**的那一个。
- **⚠️ 我先前说过一句错话，这里改正**（2026-10 使用者追问"你用什么方式同步 skill"时发现）：
  我说过"撞墙之后重跑会收敛"——**当时不成立**。因为"1 小时内抓过的不再下载"读的是
  **已发布目录**的 `.sync.json`，而那个文件只在**整轮成功**时才被写；撞限额时"一个字都不写"
  意味着**已抓到的也一起丢掉**，下一轮从零开始，于是在 60 次/小时的匿名限额下
  （一条 `pptx` 就要 11 次）**12 条的清单永远跑不完**，等多少个小时都一样。
  修法是**断点目录**（`<out>.partial`）：抓一条落一条；失败时已发布目录仍然一个字都不改
  （P7 不破），断点留着；整轮成功后删掉（内容已发布）。复用优先级 = 已发布（1 小时窗口）
  优先、断点兜底（**粘性，跨小时也留**——那是花过配额换来的）。`--refresh` 与 `--dry-run`
  都无视断点。**这次没有把"失败就不再往下试"和"复用窗口"凑成收敛**，是漏了一层：
  收敛的前提是"成果要落盘"，而 P7 又要求失败时不动已发布目录——两个都对，缺的是把
  两者分开的两个目录。
- **跨进程那条缝由两边各一条测试钉住**：工具端钉它**写出来的键表**，远端端用一个
  **手写夹具**钉它按这些键读得回来。远端那一侧的测试**刻意不 import 工具**——否则
  2026-10 刚拆开的耦合又被接回去了。手写夹具的风险是键表漂移，所以两边的测试各说一次
  "另一边在哪"。

- **许可这件事如实记在这里**：`anthropics/skills` 的 `pptx`/`docx` 是**专有许可**，`LICENSE.txt` 的 ADDITIONAL RESTRICTIONS 明文禁止"复制"与"分发给第三方"。使用者按「**内部使用不用特别控制**」定案，所以清单与界面**不加许可门禁**；代价由三件事兜着——`sourceRef` 指回上游、内容只落远端数据目录、不进代码仓库。这一条是使用者知道条款之后的决定，不是疏漏。

### 15.35 「新建任务」并进「任务」一页：导航 6 → 5，建任务变成一个页面动作（D58）

- **为什么合并**：这两页本来就是**同一条流水线的两头**——表单建完就 `selectedIssueId.set(...)`
  + `go('tasks')` 落到清单；而清单那一页**根本没有"建"的入口**。侧栏上它们并排站着，
  读起来是"两个地方"，实际上是"一件事的两个方向"。
- **三个轴，分两步**：① 导航 6 → 5；② "建"从一整页变成一个**页面动作**（顶栏主操作）；
  ③ 表单形状（整页 1406 行 / `wider` 抽屉 / 内联）。① 与 ② 是一件事（入口搬家），
  ③ 是另一件事（手感）。**混在一起改**的后果是：出了手感问题**说不清是哪一边造成的**。
  所以先说清，先做 ①②，③ 等使用者确认手感。
- **没动的东西**：`VIEWS` 里 `new` **保留**（表单没变、路由没变）、三步链语义（D42/D45）
  一个字没碰、`newtask.*` 那 83 条词条**不重命名**（重命名的风险大于"名字更整齐"的收益）。
- **`#/tasks/new`**：不新增视图，只是同一个视图的**别名**（`HASH_ALIASES`）——"合并"这件事
  在地址栏上的写法；老的 `#/new` 继续有效（书签、文档、探针都在用）。
  回落目标从 `#/new` 改成 **`#/tasks`**（合并之后"任务"才是主场）。
- **判据只有一处**：探针三条钉住"少一个入口就必须多一个入口"——任务页顶栏动作里
  `新建任务` 排在最前、它的 class 是 `primary`、**点了真的到得了表单**（落地后还查表单
  元素在不在：只看 hash 变了会漏掉"落在一个空壳页面上"）。
- ⚠️ **这次抓到一条"自己的探针在静默失效"**：探针里有一行写着 `location.hash = '#/newtask'`
  ——**一个不存在的地址**，它能"用"纯属借了当时"未知 hash 回落 `#/new`"那条规则；
  回落目标一改，藏在后面的 8 条断言同时变红。教训有两条：① 探针里的地址必须是**白名单里
  真有的那些**，别依赖回落（回落是给"用户手打错地址"用的，不是给探针当路由用的）；
  ② 那一处的 `until(...)` 返回值**被丢掉了**，而它读的 chip 是在**上一页**读的 ⇒
  回程失败照样绿——现在那一条要求 `landed === true`。**"测得过"与"真的到了"是两件事。**

### 15.36 建任务那张表单搬进「任务」页右栏（D58 第二步）

- **为什么不是抽屉、也不是继续整页**（使用者拍的板："我更期待搬到主区域（就是和任务
  细节显示的地方）"）：这一页是主从布局，右栏本来就有一栏"放不下列表之外的东西"的
  位置（先是详情空态、再是详情）。把表单放进去，**左边的清单一直在**——"刚才那条卡在
  哪一步"是建新任务时最常要参照的东西。整页会把清单整个盖掉（要回去看一条得先离开），
  抽屉是浮层、还会把清单压暗，而且**宽度按视口算**（在这里，右栏的宽度才是真判据）。
- **状态而不是页面**：`route.ts` 把 `#/tasks/new` 与老的 `#/new` 都解析成
  `{ view: 'tasks', creating: true }`；`VIEWS` 里没有 `new`、`VIEW_TITLE_KEYS` 里
  也没有（顶栏页名是「任务」，表单自己在右栏里带一个小标题）。判据是纯函数、有单测
  （`route.test.ts`，含 `hashFor`/`parseHash` 的往返）。
- **三个坑（都不是"排版问题"，是功能没了）**：
  1. **窄屏那一档**：`.split-layout:not(.with-detail) .detail-pane { display: none }`
     ——而"进建任务"正好是**没有选中任何任务**的时刻。`with-detail` 漏算 `$creating`
     的后果是窗口一窄点「新建任务」**什么都不出现**。探针钉了两条（清单让位 +
     右栏仍在 + 返回按钮**真的看得见**——只判 `display` 不够：整栏藏起来时里面那个
     按钮的计算样式照旧是 `inline-block`，改判 `getBoundingClientRect()` 之后才拦得住）。
  2. **模式**：右栏只在列表那一档渲染，而模式存在 `localStorage` 里 ⇒ "上次用看板"的人
     点进来屏幕上什么都没有。修法是进建任务就把模式拨回列表**并写回存储**（只拨不写的话
     离开再回来又跳回看板）。**这一条是探针逼出来的**（默认智能体那一组从"新建任务页"
     找选择器，报 null）。
  3. **草稿**："切走"从"离开一整页"变成了"点左边任意一条"，于是写了一半的东西很容易
     无声消失。`lib/create-draft.ts` 记"填过没有"，`lib/leave-create.ts` 是那个守卫
     （判据一处、**几个出口共用**）。⚠️ 使用者后来要求去掉那一栏上面的「返回任务清单」
     按钮（原话："新建任务上面有一个『返回任务清单』，请去掉"）⇒ "怎么回去"散成三处：
     **顶栏的「列表 / 看板」**、**侧栏的「任务」那一项**、**浏览器后退**。前两处都接了
     守卫（侧栏那一项尤其要接——它全屏常驻、最容易点到，而它走的是通用导航、压根不知道
     "建任务"这件事）；顶栏的「列表」还顺手修掉一个空操作（`mode === next` 时原来直接
     `return`，点了毫无反应，而使用者那时正想回去）。
     **后退挡不住**：地址是路由的唯一出处，拦一次后退要么"改地址再改回来"（会打成一团、
     还会多一条历史）、要么上 History API（这个应用刻意不用，见 `route.ts`）。真正的解法是
     **把草稿留在 store 里**（离开再回来还在），而不是把确认框问得更勤——记在这里，没做。
     探针五条钉住（点列表行会问、侧栏那条也会问、取消之后字还在、点「放弃」真的回得去、
     顶栏「列表」出得去）。
- ★★ **一列还是两列，按这一栏实际多宽判**（`@container`，不是 `@media`）：同一个
  1280 的窗口，右栏内容只有 **549px**（侧栏 240 + 左栏 416 都占掉了），而 `@media`
  看见的是 1280 —— 按窗口判会让表单排成两列、每列 265px。阈值 **36rem**，实测三个
  点：800 窗口 ⇒ 496px 单列、1280 ⇒ 549px 单列、1600 ⇒ 869px 两列。探针三条并排
  钉住（含"同一份 CSS、窗口不同 ⇒ 列数不同"这一对）。
- ⚠️ **容器不能包住那个对话框**：`container-type` 会带来 `contain: layout`，而它让
  容器成为 `position: fixed` 后代的**包含块**——`Modal.svelte` 是 `fixed` 的，被包进去
  之后就不再相对**视口**居中，而是相对这一栏居中（"确认框在中间"那条探针抓的就是它）。
  所以容器是表单外面那一层 `.form-frame`，而 `<Modal>` 是它的**兄弟**。
- ⚠️ **留白只有一个出处**（`--create-pad-x`）：提交栏是 `sticky` + **负外边距**去抵消
  容器留白的，两边各写一份 `var(--sp-6)` 看着对称、实际会漂移——第一版我在窄屏那条
  断点里只改了容器那一份，提交栏比容器宽 32px、整张表单横向溢出（探针那条
  `scrollWidth ≤ clientWidth` 当场抓住）。
- **测得过 ≠ 真的到了**（又一次）：这张表单原来是个视图，探针里那些"进这一页"的等待
  写的是 `页名 == 新建任务`。合并之后页名是「任务」，于是所有等待都要改成"**页名 + 表单
  真的在右栏里**"——只判页名的话，一行都不会等到（或者更糟：等到一个空壳页面）。

### 15.37 顶栏改版：这一页的动作改成一条工具条（D59）

- **使用者的问题**："顶栏帮忙重新设计一下，新对话、新建任务、列表这些按钮都看起来不好看。
  是否有很好的设计"。先量再改：那一排原来是**三种重量**混着排——实心蓝主操作
  （4.88:1）、`--surface-2` 配套动作（**1.14:1**）、ghost 的选中态底（**1.22:1**）。
  后两个低于"看得见一条边"的门槛（非文字对比 3:1），所以屏幕上其实是**一个色块 +
  三段文字**；而且"做一件事"（新建）、"换一种看法"（列表/看板）、"重复一次"（刷新）
  三种不同性质的东西长成了同一种形状。
- **做法（候选 B，使用者选的）**：一条轨道（`--line`，对顶栏底 1.26 / 深色 1.24）说明
  "这几个是一组"；组里每一格形状完全一样（24px 高、方角、透明底），状态靠三档底色：
  常态透明 / hover 浮起一格（`--surface`，两种主题下都与轨道差 1.18~1.26）/ **当前实心
  accent（4.88:1，白字）**。主操作只靠**文字**分重量（强调色 + 半粗 + 一个 `+` 图标）。
- **图标只用四个**（`lib/icons.ts`：+ / ↻ / 列表 / 看板，使用者定的），理由：中文界面里
  两三个字的词条本来就比图标好认（"设置""刷新"没有歧义），图标只在"词条短到没有形状"
  的地方才值；引一整套图标库要拉依赖、多一套风格，而整个界面的图标加起来不到十个。
  同一个 `Icon.svelte`（`1em` + `currentColor`）在平铺与 `⋯` 菜单两处复用。
- ⚠️ **主操作那一格的文字色不是直接的 `--accent`**：它压在浅色轨道上只有 **3.88:1**，
  而 13px 文字按 AA 要 4.5 ⇒ 写成 `color-mix(in srgb, var(--accent) 85%, var(--text))`
  （浅色 **4.62:1**、深色 5.9:1，一条式子两个主题都成立）。
- ⚠️⚠️ **改版时踩的那个坑，值得记**：`height: 1.5rem` 写在 `.page-actions button` 上，
  而文件后面还有一条 `.topbar button { height: 1.9rem }`——**同分、源序靠后 ⇒ 后者赢**，
  于是格子被拉到 30px、工具条变成一条没有呼吸的实心带。**而当时三条探针全绿**：
  它们量的是"高度齐不齐"（全是 30，当然齐）。所以判据跟着改成**分两组量**
  （轨道里的格子必须都是 24、轨道外的常驻控件必须都是 30）外加一条**轨道高度 = 30**。
  教训与 D58 那次同源：**"没红"不等于"对了"**，判据要贴着这次改动真正在乎的那件事写。
- ⚠️ 另一处小坑：给「新建任务」那颗加 `active`（"正在建任务"也是一种"当前"）会让一排里
  **出现两个实心块**，而"我在哪一种呈现方式里"反而没人回答得出来（探针那条"当前模式只有
  一个"当场红了）。所以 `active` 的语义收窄成**"现在是列表还是看板"**，建任务由右栏自己说。
- **探针**：新增 `topbar.trackHeight`；`topbar.buttonHeights` 改成两组的形状；
  `topbar.actions`（逐页写死的按钮文字清单）没动——图标是加在文字**前面**的，文字仍在。
- **随后（同日）改了两处文案**（使用者："聊天页「新对话」改为「新建对话」、智能体页
  「新建」改为「新建智能体」"）：聊天那条改的是 `chat.newConversation` 的 zh
  （en 本来就是 `New conversation`，不用动）——⚠️ 这条词条**同时**喂着顶栏那颗按钮
  与草稿面板的 `h2`，所以两处一起变成「新建对话」（同一个出处，这是有意的：任务页
  的「新建任务」也是按钮与面板共用一条词条）。智能体那条不是改字，而是**删掉一条
  重复词条**：`agents.newButton`（旧的「新建」）与它打开的那个抽屉的标题
  `agents.newTitle`（早就是「新建智能体」）一直各写一份 ⇒ 按钮与它打开的面板说的
  不是一句话。现在按钮直接用 `agents.newTitle`，`agents.newButton` 从词条表里删掉
  （判据仍只有一处）。探针那边三处按文案找按钮的地方与两处逐页写死的文案断言同步改：
  `topbar.actions` 的 `#/agents` 变成 `['新建智能体', '设置', '刷新']`、
  `template.openButtonLabel`、"新对话"那个 `startsWith`——**这正是那几条判据的价值**：
  改了词条忘了改探针，它们会当场变红。

### 15.38 列表栏骨架统一：聊天 / 任务 / 智能体三页同款（D61）

- **使用者的问题**："聊天、任务、智能体三个页面的列表栏，在布局上需要同一，你有什么建议？"
- **先量了再说**（探针量到的事实）：三页列表栏**栏宽已经一致**（共用 `.split-layout` 的
  `minmax(20rem, 26rem)`，1280 下都是 416px），条目形状也已经是同一个（`li` + 整行可点
  `<button>` + 兄弟按钮 + active 挂 li + 两行结构）。**差的是骨架**：
  · 栏头：聊天有（51px，「对话」——因为栏标题 ≠ 顶栏页名），任务 / 智能体没有（标题与
    页名重复，2026-09 删的）——三页三种头部。
  · 搜索框：任务页列表模式**独行怼在列表上方**（352px 一整行），而看板模式却并进栏头右侧
    ——**同一页两种形态**；聊天 / 智能体没有搜索。
  · 行高：60 / 65 / 72px 各不相同（智能体最"胖"：条目内距上下 12px）。
  · 删除按钮：聊天贴边（内缩 1px）vs 任务内缩 5px。
- **做法**：
  · **栏头规则一条**：只有"栏标题 ≠ 顶栏页名"才有**标题**栏头（聊天「对话」）；任务页
    列表模式补了一个**无标题**栏头（与页名重复的不放），放**计数 + 搜索**（`tasks.listCount`
    + 搜索框右对齐，与看板模式同形）。三个单行栏头共用 `--list-head-h: 51px`
    （`.list-head` / `.list-toolbar` 两个类，看板那个更高的栏头不算）。

  ⚠️ **D62 跟进（使用者反馈"变化不大，只有任务有点变化"）**：D61 那版智能体没有栏头，
  三页在视觉上仍然不像同一套。2026-10 给智能体**补了与任务同款的无标题栏头带**（计数
  `agents.listCount` + 搜索 `agents.search`，过滤名称与指令；搜索命中 0 条时说
  `agents.emptyFiltered`，与任务的空态分开）。现在三页都是"一条 51px 栏头带 + 行"：
  聊天是标题带，任务/智能体是计数+搜索带——栏头规则本身没变（标题只在 ≠ 页名时出现）。
  · **行高同一档**：三页条目内距统一成 `var(--sp-2) var(--sp-3)`（智能体原来上下 12px），
    另加 `--list-row-min-h: 64px`——内容更轻的聊天被垫到与任务/智能体同一档
    （实测 64 / 65 / 64，三页两两差 ≤1px）。**统一的是底线与内距，不是把内容压扁**。
  · **操作按钮同一位置**：右缘内缩 `--sp-1`、垂直居中（聊天原来贴边）。
  · ⚠️ **不抽 `ListItem` 组件**：三页条目的信息差异是真差异（阶段标签 / 轮数 / 角色徽标
    + 默认），硬抽只会把差异塞回 props 和插槽——统一常量，不统一结构。
- **探针**（+4 项，497 → 501）：`skeleton.headH`（51 / 51 / 无）、`skeleton.searchInHead`
  （搜索在栏头里、不在列表内）、`skeleton.rowH`（三页两两差 ≤1px 且都 ≥63）、
  `skeleton.delInset`（两栏内缩一致、垂直居中）。
- **红证**：把 `--list-head-h` 与 `--list-row-min-h` 各变异一次（51→45、64→60），
  `skeleton.headH` 与 `skeleton.rowH` 各红一条；恢复后构建产物 md5 与变异前逐字相同。
- **踩坑**：探针这段必须放在**文件末尾**（聊天那组刻意"不造对话"量的是空态，只有聊天段
  自己的夹具对话造出来之后左栏才有行可量——放前面三条全"没量到"，实测踩过）。另外给
  run.mjs 批量插检查时把两个"语言切换"块弄重复了（一处 `find` 没用 fromIndex），
  探针总数从 503 虚增到 514——清理后回到 501。教训还是那句：**改动后先跑一遍全量**，
  数字不对就停。

### 15.39 去掉智能体页导语 + 聊天页补计数搜索（D63）

- **使用者的话**：①"去掉'这里配置每个智能体：它的指令、行动权限，以及由谁来审它。'"
  ②"聊天页也改和任务类似呀"。
- **① 导语**：智能体页的 `.view-intro`（`agents.headIntro`）整块删掉。理由：那句是
  在复述下面每一条卡片已经在说的话（指令 / 行动权限 / 审核者都在卡片与详情里），
  而顶栏页名 + 栏头带已经把"这一页是什么"说清了。技能页/工具页自己的导语保留
  （它们没有别的地方说那一句）。探针原来钉的是"智能体页**必须有**导语"
  （`common.pageIntros`），跟着反转成 `agents.noPageIntro`：谁把导语加回来就红。
- **② 聊天栏头带**：聊天页栏头从"只有标题「对话」"改成与任务/智能体同款带子——
  标题 + **计数**（`chat.listCount`，跟在标题旁边，`align-items:baseline`）+ **搜索**
  （`chat.search`，过滤标题，进栏头右侧）。三页现在都是"51px 栏头带 + 行"：
  聊天 = 标题+计数+搜索，任务/智能体 = 计数+搜索。过滤命中 0 条用独立的
  `chat.emptyFiltered`（与"还没有对话"分开）。栏头规则不变：标题只在 ≠ 页名时出现。
- **探针**：`skeleton.searchInHead` 判据把聊天的 inHead 从 false 改成 true；
  `agents.noPageIntro` 反转。501 项全绿。
- **红证**：把聊天搜索框拿掉 → `skeleton.searchInHead.chat` 红；把导语加回来 →
  `agents.noPageIntro` 红。恢复后构建 md5 逐字节一致。

### 15.40 聊天栏头去掉「对话」+ 修 D61 的分组标题 51px 漏（D64）

- **使用者的话**："聊天页的'对话'两个字也去掉。"
- **① 聊天栏头**：`chat.listTitle`（「对话」）整条删掉。栏头规则本来是"栏标题 ≠ 页名
  才放标题"（「对话」≠「聊天」，规则上允许）——但"这一栏装的是什么"由顶栏页名 +
  每一条对话的行内信息承担了，标题留着只会让聊天与任务/智能体不一样。去掉之后三页
  栏头带**完全同款**：左边计数、右边搜索，全部没有标题。探针新判据
  `skeleton.headsTitleless`：三页栏头带里**都不许有 h2**（谁加回来就红）。
- **② 顺手修掉一个 D61 的漏（实测证实的 bug）**：D61 在 app.css 里加全局
  `.list-head`（51px 栏头带）的时候，不知道任务页自己的 scoped 样式里**已经有一个
  `.list-head`**——那是列表里的分组标题「需你处理 / 其余任务」。全局那条的
  `height: 51px` 漏到那两行分组标题上，把它们从内容高度（~28px，scoped 的
  `padding: sp-3 0 sp-1` + 分隔线）撑成 **51px**（实测 `sep0/sep1 都是 51px`）。
  D64 聊天栏头改走 `.list-toolbar`，全局 `.list-head` 失去唯一使用者，顺手删掉——
  分组标题回到细分隔条。探针新判据 `skeleton.separatorMaxH`（≤40px）钉死。
- **探针 +2 → 503**（`headsTitleless`、`separatorMaxH`）。
- **红证**：把聊天栏头的 `<h2>对话</h2>` 加回去 → `headsTitleless` 红；把 app.css
  那条全局 `.list-head` 加回去 → `separatorMaxH` 红（分组标题回到 51px）。恢复后
  构建 md5 逐字节一致。

### 15.41 行内细节统一：聊天 / 任务 / 智能体列表每项同款（D65）

- **使用者的话**："聊天，任务，智能体 列表每项细节的风格依然有差异，请检查。"
- **先量再改**（探针式实测，逐项取渲染后的计算值）：

  | 行内细节 | 聊天 | 任务 | 智能体 |
  |---|---|---|---|
  | 标题 字号/字重 | 13px / 400 | 14px / 600 | 14px / 700 |
  | 行内两行间距 | 2px | 3px | 2px |
  | 徽标形状 | （无阶段可标） | 描边方角 r4px、无底无点 | 胶囊 r100px、10% 底 + 发丝边 + 圆点 |
  | 行容器 对齐/gap | center / 2px | center / 2px | flex-start / 4px |
  | hover 底色 | `--surface-hover` | `--surface-2` | `--surface-2` |

- **做法（全套，向平台标准对齐）**：
  · 标题：三页都是 `--fs-base`（14px）+ weight 600（聊天原来 fs-sm/常规、智能体 strong
    默认 700）。
  · 徽标：任务的 `.stage-tag` 改成与平台 `.badge` **同一条配方**（胶囊 + `::before` 圆点 +
    `color-mix(currentColor 10%)` 底 + `28%` 发丝边；阶段色只设 `color`，描边与底从
    currentColor 派生）。任务列表与看板里的阶段 chip 一起变胶囊。**竖内距 0**（`0.1rem`
    会把元信息行撑高，任务行 65→67px 顶破 D61 的行高判据；胶囊形状不变）。
  · 行容器：三页都是 align-items center + gap 2px；智能体的「设为默认」按钮随之垂直居中
    （margin 只留右缘 `--sp-1`）。
  · hover：三页统一 `--surface-hover`——**它才是全 App 的 hover 标准**（ActionPicker /
    工具 / 技能 / 结果面板都用它）；任务/智能体原来误用 `--surface-2`（那是**选中态**底色）。
  · 不动的：聊天没有阶段徽标（内容上没有可标的阶段，不硬加）；智能体的「设为默认」是
    文字按钮（功能不同，保留）；元信息可见字号已是同字级（12px `.faint small`）。
- **探针 +4 → 507**：`rowdetail.title` / `rowdetail.chip` / `rowdetail.rowBox` /
  `rowdetail.hover` 四组聚合判据。hover 判据从样式表扫规则——⚠️ Svelte scoped 选择器是
  `.conv-row.svelte-xxx:hover`（`:hover` 在 hash **后面**），匹配要按 `.conv-row.`/`.conv-row:`
  开头判断。
- **红证**：四处变异（标题回 13px、阶段标签回方角、智能体行 gap 回 4px、任务 hover 回
  `--surface-2`）各红一组；恢复后构建 md5（**js+css 合并哈希**，见下）逐字节一致。
- ⚠️ **红证 md5 约定更新**：D65 起改哈希 `index-*.js` + `index-*.css` **合并**——CSS 单独的
  改动（如这次徽标内距）只改 `.css` 文件、`index-*.js` 纹丝不动，只哈希 JS 会测不出
  CSS-only 的红证恢复。

### 15.42 三页列表抽成标准控件：ListPane + ListRow（D66）

- **使用者的话**："这3页的列表，是否有机会做成标准控件，这样统一化会很好。"
- **可行性评估（先量再改）**：D65 把三页行壳样式统一到逐字节一致之后，D61 那条
  "不要抽 ListItem 组件"的理由（*"三页条目的信息差异是真差异，硬抽只会把差异塞回
  props 和插槽"*）恰好不适用了——差异全在**内容**，而内容放进 snippet，正是 Svelte 5
  的惯用法（Tasks 早就在用 `{#snippet row(...)}`）。实测重复量：行壳 CSS 三份复制
  （Chat 40 行 / Tasks 38 行 / Agents 33 行）、栏头带 + 空/过滤空分支三页同构、
  app.css 还枚举着三个行类名（`.conv-row,.task-row,.agent-row`）。
- **边界（壳归组件，内容归 snippet）**：
  · `ListPane.svelte`：栏头带（计数 + 搜索，`--list-head-h`）+ 五态壳（加载 / 报错 /
    空 / 过滤空 / 行），snippet：`rows`（必给）、`top`（智能体环境预检）、
    `loadingSkeleton`、`readyTop`（智能体「设为默认」失败提示）、`bottom`（智能体
    Runtime 概览）。**看板模式不走它**（它是另一种呈现，栏头有标题说明）。
  · `ListRow.svelte`：行盒（`.list-row`：hover / 选中框 / min-height 64）+ 主按钮
    （`.list-row-main`）+ 动作钮插槽。`rowClass` 由页面给（`conv-row` / `task-row` /
    `agent-row`，任务带分组时 `task-row attention`）——探针仍按它们量行。
    `.list-row-action`（删除钮样式）放 **app.css 全局**：动作钮由页面 snippet 提供，
    snippet 内容不吃 ListRow 的 scoped 样式。
  · 三页各减 ~35 行复制 CSS + 栏头/分支代码；app.css 的 `.conv-row,.task-row,.agent-row
    { min-height }` 枚举消失（进 `.list-row`）；加第 4 个列表页 = ~20 行。
- **顺手统一的两处小差异**（实测才发现的）：行栏左右内距 聊天 8px / 任务、智能体
  24px → 统一 `--sp-2`（8px）；行距 聊天、智能体 `var(--sp-1)` / 任务 2px → 统一
  `var(--sp-1)`（4px）。
- **技术要点**：
  · 新组件用 **runes 模式**（`$props()` + snippet props），与仓库的 legacy 页面混用
    是官方支持组合（页面传 snippet 不受模式限制）。
  · `exactOptionalPropertyTypes`：`$loading.x` 在 noUncheckedIndexedAccess 下是
    `boolean | undefined` → 调用点 `?? false`；`filter && bool` 是 `string | boolean`
    → 改 `filter !== '' && bool`；`$loadError.x` 是 `string | undefined` → `?? null`。
  · 探针同步更新：`.agent-item`/`.task-row-main`/`.conv-item` → `.list-row-main`，
    `.task-delete`/`.conv-delete` → `.list-row-action`（25+3+2+3 处），hover 扫描改扫
    ListRow 的 `.list-row:hover`。
- **探针不变 507**：重构是"零视觉变化"的纯迁移（截图逐像素对比只差在任务/智能体行
  位移动 16px、行距 2px——即上面那两处有意统一）。
- **红证**：变异 ListPane（去掉搜索框）→ `searchInHead` 红；变异 ListRow（行对齐回
  flex-start）→ `rowBox` + `delInset` 红（3 条）；恢复后构建 md5（js+css 合并）逐字节一致。
- ⚠️ **过程踩的坑**：python 子串匹配 `'  </section>'` 会命中 8 空格缩进的内层闭合
  （substring 命中）——替换大块结构时要用行首锚定；git HEAD 的智能体 runtime 卡是
  3 行旧版、工作树是 D 时代极简 1 行版，重构时先查 probe 判据再抄结构，差点把旧版
  抄回来。

### 15.43 「需要注意」分组不再带解释句（D67）

- **使用者的话**：删除"需要注意"后面的解释（"执行失败/被取消（不会有审核结果）、
  根本没派审核，或者判决要求人介入"）。
- **改动**：`Tasks.svelte` 分组头只留 `tasks.attentionTitle`，删掉第二行的
  `tasks.attentionHint`；i18n 词条 `tasks.attentionHint` 一并删除（全仓仅此两处引用）。
  分组头恢复单行——**实测两条分组头高度 38px / 38px**（改前 38 / 59，解释句占第二行）。
- **探针**：507 → **508**。D 系列惯例——删掉的行为要**钉住"没有"**：新增
  `skeleton.separatorNoHint`（第一条分组头文本里不许再出现"执行失败"或"——"）。
  `skeleton.separatorHeights` 判据不变（min<51 仍防 D61 的 51px 固定带）。
- **红证**：把解释句加回去（页面 + 词条一起）→ 恰好 1 条红（`separatorNoHint`，
  说明只有新判据抓住它）；恢复后构建 md5（js+css 合并 `cb2eaa5c…`）逐字节一致。

---

### 15.44 两个前端共用一套界面组件（D68）

- **使用者的话**：D66 之后追问——"技能 / 工具的**表格**是否也要组件化"；
  批准三步开工（"开工"）。
- **背景**：`@agentdeck/ui` 原来只放"与业务无关"的东西（令牌 / 组件样式 / 主题，
  2026-10 边界）。D68 把**组件层**也搬进去——"两个前端长得一样"是同一个产品
  的一部分，不止"相似的风格"。i18n 仍是**两套表有意分开**（webText / remoteText
  各自演进，见 `remote/common.ts` 顶部说明），所以共享组件一律**不带文案表依赖**：
  标签走 prop、时间走"文案函数注入"。

#### 第一步：基础设施

- `packages/ui/src/lib/confirm.ts`：`askConfirm` / `pendingConfirm` / `settleConfirm`
  （原 daemon 那份，命令式确认框状态）。remote 原来的
  `confirmDialog / answerConfirm / currentConfirm` 接口统一成这一套——两个前端
  同一件事只有一个名字。
- `packages/ui/src/lib/locale.ts`：`createLocaleKit(texts, { read, write })` → 语言层
  的**形状**（`locale` store + derived `t` + 命令式 `tx` + `currentLocale`）只写一处；
  文案表与持久化是各端的事（web 存 workspace——服务端渲染 prompt 要用，写回依赖
  api 会成环，由 `apps/web/src/lib/i18n.ts` 的 `setLocale` 负责；remote 存
  localStorage）。web 的 `locale.ts` 因此仍是"不 import 任何 app 模块"的叶子。
- `packages/ui/src/lib/time.ts`：`createTimeKit(文案函数)`——相对/绝对时间的逻辑
  一处（`number | string | null` 都收，`null` 如实显示 `—`），文案函数**调用那一刻**
  取当前语言（语言切换后重渲染拿到新文案）。web 注入 `common.*`，remote 注入
  新增的 `remote.justNow/minutesAgo/hoursAgo/daysAgo`。
- `components/Modal.svelte` / `components/ConfirmDialog.svelte`：从 web 那份搬，
  `closeLabel` / `cancelLabel` 走 prop。web 删本地三份（Modal / ConfirmDialog /
  confirm.ts）换 import；FileViewer / NewTaskForm 补 `closeLabel={$t('common.close')}`。
- ⚠️ **子路径拆分的教训**：组件不能从 `@agentdeck/ui` 主入口导出——node 测试
  import 主入口会碰到 `.svelte` 而报 `ERR_UNKNOWN_FILE_EXTENSION`（第一步时
  api/chat/sync/time 四个测试文件全挂）。拆成 `@agentdeck/ui/components` 子路径：
  主入口只留纯 TS（theme / confirm / locale / time），测试可达。
- remote 的 `lib/format.ts` 重写为 `createTimeKit` 的注入层（接口名
  `formatAgo / formatTime` → 共用 `relativeTime / absoluteTime`），两处视图调用点
  同步改。

#### 第二步：Table 壳 + 单元格原子

- `components/Table.svelte`：`columns` prop 自动生成 thead（`scope="col"` 给读屏器、
  操作列用 `aria-label` 起名——这条无障碍约定 5 张表各写一遍，迟早有人漏一处），
  `rows` snippet 承接行内容，`tableClass` prop 保留 `.tool-table`（探针依赖）。
  `TableColumn` 类型独立成 `table-types.ts`——`.svelte` 的命名类型导出过不了
  测试 tsconfig。
- `components/ExpandToggle.svelte`：真按钮 + `aria-expanded` + chevron
  （web 技能主表 / 工具主表原来各写一份）；`components/SourceRef.svelte`：单行省略
  + `title`（remote 技能表 / web 目录表 / web 工具表三处）。
- 5 张表全换用：web 技能主表、web 远端目录表、web 工具表、remote 技能表、
  remote 工具表。行类名（`tool-row` / `skill-slug` 等）与 `.expand-toggle`、
  `.table-wrap` 一律不动（探针兼容）。
- **snippet 收窄教训**：`{#snippet}` 是函数，`{#if catalog}` 的收窄进不去
  （svelte-check：`'catalog' is possibly 'null'`）。第一次用 `{@const cat = catalog}`
  也没用（`{@const}` 不继承模板收窄）；正解是**派生非空数组**
  `$: skills = catalog?.skills ?? []`，snippet 直接迭代它。

#### 第三步：CatalogPane（remote 内部布局壳）

- `apps/remote/web/src/components/CatalogPane.svelte`：remote 技能 / 工具两页共用的
  "加载 / 错误 / 空 / 就绪四态 + 标题行 + Table + 底部说明 + 详情抽屉骨架 +
  Esc 关抽屉（确认框开着时不抢 Esc）"。行与抽屉正文走 snippet，文案
  （loading / retry / close / empty / titleCount / footer）全由页面拼好传入。
- ⚠️ 放 remote app 而不是 `@agentdeck/ui`：它是**页面布局**（ui 边界：布局与数据
  是各 app 的事），而且只有 remote 用——但它构建在共享 Table 之上，两页从此
  结构完全同形。
- snippet 直接按属性转发：`<Table columns={columns} rows={rows} />`——重新
  `{#snippet}` 一层会遮蔽同名 prop（自递归）。
- 两视图各删 ~40 行重复（含各自注册的 window keydown）。`detail!` 非空断言用于
  drawerBody snippet（抽屉只在 `detail !== null` 时渲染，TS 不知道）。

#### 验证

- typecheck 两 app 0 错；测试 **1730/1730**；探针 layout **508** + remote **21** 双绿
  （三步各验一次，全绿）。
- **红证**：变异共享 `Modal.svelte` 的 `.modal` → `.modal-XX` → remote 探针**精确
  红 1 条**（"点「卸载」弹的是**自己画的**确认框（`.modal`）"）+ layout 探针
  **超时**（删除确认的 `.modal` 等不到，流程挂死）→ 还原后 md5（js+css 合并
  `a814b6ba…`）逐字节一致 → 双探针复绿。这证明两个前端弹的确实是**同一个组件**。
- step3 只动 remote 产物，web 的 md5 与 step2 相同（`a814b6ba…`，同哈希属预期）。
- 截图：daemon `#/tools`、`#/skills` 与 remote `#/tools` 三张（`.cache/shots/`），
  两 app 的表格同形。

---

### 15.45 表格行内细节同一化（D69）

- **使用者的话**：D68 之后——"表格的每项细节，我也期待做同一化，你看看怎么调整
  更合适"。D65 对"列表行"做过一次（标题/徽标/行容器/hover 统一），这次轮到
  5 张数据表。
- **调查**（逐格对照 5 张表 + app.css）：壳层（表格 / 行内距 `sp-3` / 行 hover /
  `.badge` 底座 / 按钮基类）已经共享；**单元格原子散落且漂移**：
  - `.source-ref` / `.desc-clamp` / `.expand-toggle` / `.row-actions` 四套样式
    在 `Skills.svelte` 与 `Tools.svelte` **各抄一份**（`diff` 过，逐字相同），
    **remote 一份都没有**——remote 的 SourceRef 渲染 `source-ref` 类但没有任何
    样式（会折行、撑高整行），remote Tools 的 summary 全量显示（能撑十行）；
  - 版本：web `v1.2.3` / `无版本号`，remote `1.2.3` / `—`；
  - 名称行：web 主表 base(14px)，web 目录表 + remote 是 `faint small`(12px)；
  - 来源徽标：web 主表/工具表借**任务状态色** `badge todo/in_review`，remote
    用默认灰 + `.badge.local`（accent）；
  - 卸载按钮：web `ghost small danger`，remote 实心 `danger small`；
  - synced 列：remote 纯绝对时间（无 title），web 相对 + title 绝对；
  - 文件数 `SKILL.md +N` vs `N 个文件`——当时误记为"计数口径真不同"（以为 remote
    的 files 含 SKILL.md）；D69.5 查证 `collectLocal` 后确认**口径相同**：两边都
    走同一个 `resolveLocalPath`，SKILL.md 单独进 `content/body`，`files` 都是支持
    文件。真实差异只是显示格式，D69.5 已统一。
- **改动**：
  1. 四套原子样式上移 `app.css` 一处（表格区），删 web 两份拷贝——remote 自动
     获得单行省略与两行截断；
  2. remote 对齐 daemon：版本 `v{version}`/`remote.noVersion`（新词条）、synced
     列相对时间 + title 绝对、卸载 `ghost small danger`（置灰档也 ghost）、操作列
     套 `.row-actions`；
  3. 名称行统一 `faint small`（web 两张主表改；slug 才是主标识）；
  4. 来源徽标统一配方：同步/远端 = 默认灰、本地 = accent（`.badge.local` 上移
     app.css；web 不再借任务状态色，`.badge.todo` 注释同步改为"设置抽屉的目录
     缺失徽章"）。
- **探针**：layout 508 → **510**（新增 `tools.descClampApplied`（计算样式
  `-webkit-line-clamp === '2'`）与 `tools.rowActionsFlex`（`display === 'flex'`）
  两条 pin，钉住"样式真的生效"）；remote 21 → **23**（新增 `sourceRefNowrap`
  （`white-space === 'nowrap'`）与 `versionCellTexts`（`vabc1234` + 无版本号））。
  remote 的 `sourceRefNowrap` 在改动前会红——它正是这次修的漂移。
- **红证**：同时变异 `.source-ref`（nowrap→normal）与 `.desc-clamp`
  （line-clamp 2→1）→ layout **精确红 1 条**（descClamp 实测 `"1"`）+ remote
  **精确红 1 条**（`white-space=normal`）——证明两个前端依赖的是 app.css 那
  **同一条**规则；恢复后 md5（js+css 合并 `40f2ef8c…`）逐字节一致，双探针复绿。
  ⚠️ 还原踩坑：`replace('white-space: normal;', 'nowrap;')` 命中了**工具提示条**
  里另一处原始的 `normal`（把它错改成 nowrap、source-ref 反而漏掉）——教训：
  还原要**带上下文的锚点**替换，不能裸 `replace` 全局唯一的子串（工具提示条的
   `normal` 才是文件里最早的）。

---

### 15.46 细节显示逻辑同一化（D69.5）

- **起因**：D69 之后使用者指出"细节项目的显示逻辑还是有些不一样"。D69 统一的是
  **样式**，这一轮统一的是**条件逻辑**（什么情况下显示什么）。
- **查证**（对照 5 张表逐格的显示条件）：
  - **文件列**：web `SKILL.md{#if n>0} +{n}{/if}`，remote `{count} 个文件`。
    追到 `collectLocal` 确认两边**同口径**（SKILL.md → `content`，`files` 都是
    支持文件）——差异纯属显示格式，而且旧的 remote 格式在只有 SKILL.md 时显示
    刺眼的 `0 个文件`。统一成 web 的 `SKILL.md + N`（0 时只写 `SKILL.md`）；
    `remote.filesCount` 词条随之删除。
  - **SourceRef 空值守卫**：组件本身不守卫（空 value 也渲染带 margin 的空 span），
    web 调用处有 `{#if s.sourceRef}`、remote 没有。守卫移进**组件内部**
    `{#if value}`——一处管住所有调用方（web 的 `&& !s.localDir` 是页面语义，保留）。
  - **summary 守卫**：web `{#if tool.description}`，remote Tools 无守卫（无说明时
    渲染一个空行 + 空 title）。补上 `{#if tool.summary}`。
  - **excluded 守卫**：web `{#if s.excluded && s.excluded.length > 0}`，remote 少
    一层 `&&` 防御。补齐。
- **验证**：typecheck 0 错、测试 1730、探针 **remote 23→24**（新增
  `filesCellTexts`：首行裸 `SKILL.md` + 不许出现"个文件"）、layout 510 不变。
  红证：把 remote 文件列改回 `{n} 个文件` → 精确红 1 条（实测 `0 个文件 | 0 个
  文件 | 1 个文件`，顺带证明旧格式的刺眼显示）→ 恢复，md5（js+css）逐字节一致
  （a5a1dcf3…），复绿。
- **保留的差异**（结构性，非行内逻辑）：web 工具表多出动作数/更新于/更新按钮列
  （web 管已装工具、remote 看目录）；展开方式 web 行内展开 vs remote 抽屉
  （D61"真差异"原则）；remote 工具表无来源字段（D69.6 遗留缺口）。
  来源列归属问题见 §15.47（D69.6 已修 remote 技能表与 web 目录表）。

---

### 15.47 来源信息的列归属（D69.6）

- **使用者报的**："remote 的技能，为什么 `github:jimliu/…@main:skills/…` 被放在了
  「技能」列，而不是「来源」列呢。"——逐表核查来源放置后确认这是**一整类问题**：
  - web 技能主表 / web 工具表：**已有**独立「来源」列（徽章 + `github:…` 都在列内）✓；
  - **remote 技能表**：没有来源列，徽章（推荐清单/本地添加）+ `github:…` 全塞进
    第一列（列头 `remote.colSlug` = 「技能」）——使用者看到的就是这个；
  - **web 远端目录表**（安装抽屉）：同样没有来源列，`github:…` 塞在技能列
    （`{#if s.sourceRef}<SourceRef/>` 在 colSlug 格内）；
  - remote 工具表：`CatalogToolEntry` 连 `sourceRef`/`source` 字段都没有（工具从
    本地 `tool.json` 目录读，无来源可记）——**缺失而非错位**，列为已知缺口，不硬造
    空列。
- **修复**：
  1. remote 技能表加「来源」列（列头 `remote.colSource` 早已存在）：徽章 + SourceRef
     进来源列，技能列只剩 slug + 名称 + 内容不完整提示——与 daemon 主表同一布局；
  2. web 目录表加「来源」列（复用 `skills.colSource`）：SourceRef 进来源列；
  3. remote 工具表不动。
- **探针**：remote 探针同步更新——表头数 5→6（原检查"表头 5 列"改 6 列）、
  `versionCellTexts`/`filesCellTexts` 的列索引 `children[1]/[2]`→`[2]/[3]`、
  slug/徽章同行检查的徽章从 `.row-title` 内改到**整行**找（徽章挪列后仍在同一行，
  y 对齐判据不变）、新增 `sourceColumnPlacement` pin（col 0 不许含 `github:`、
  col 1 必须含）——直接钉住使用者报的位置问题。
- **红证**：把 SourceRef 移回技能列（模拟修复前）→ 精确红 1 条
  （`sourceColumnPlacement=false`）→ 恢复，md5（js+css）逐字节一致
  （a54d20ed…），复绿。
- **遗留缺口**：remote 工具表无来源信息（服务端 `CatalogToolEntry` 无来源字段）。
  若要让工具也显示 `github:…`，需要在同步/加载工具时记录来源——单独一轮。

---

### 15.48 列序 / 表头 / needs 统一（D69.7）

- **起因**：D69.6 修完来源列后使用者说"刚才只是举例"——要求**全面盘点**所有列
  位置差异、列成清单后拍板。盘点结论（5 张表逐列对照）：
  - **来源 vs 版本列序 2:2 对半**：web 主表/工具表「版本→来源」，web 目录表/
    remote 技能「来源→版本」；
  - **首列叫法**：技能两表「标识」、remote「技能」、工具「组名」、remote 工具
    「工具包」——同一个 slug 列 4 种叫法；
  - **remote 抽屉缺 needs**：web 目录表装前显示"需要配置"，remote 装完在抽屉
    里看不到；
  - 其余（文件列/时间列/动作数列仅部分表有、名称独立列 vs 压 slug 下）判定为
    **列集差异保留**（各表职责不同），展开范式 web 行内 vs remote 抽屉保留
    （D61）。
- **改动**（按使用者"按你建议改"）：
  1. 「来源」列统一在「版本」前：web 主表 + web 工具表的列定义与行 td 同步换序
     （来源 td 移到版本 td 前；web 主表 files 仍在 children[4]，layout 探针该
      pin 不受影响）；
  2. `skills.colSlug`：标识 → 技能（en 保持 Skill；与 remote 一致）；
  3. remote 技能抽屉正文后加「需要配置」段（`{#if detail!.needs}`，warn 样式），
     新增 `remote.detailNeeds` 词条。
- **探针**：layout 510 → **514**（`skills.slugHeader` = 首列「技能」、
  `skills.sourceBeforeVersion` / `tools.sourceBeforeVersion` = 来源在版本前，
  并补上 D69.5 漏挂断言的 `skills.filesCellFormat`）；remote 25 → **26**
  （`drawerShowsNeeds` = 抽屉里有夹具的 "还得配个 key"）。
- **红证**：一次变异 4 处（两表列序改回、表头改回「标识」、删 needs 段）→
  layout 精确红 3 条（各命中 slugHeader/sourceBeforeVersion ×2）+ remote 精确红
  1 条（drawerShowsNeeds）→ 恢复，md5（js+css）逐字节一致（3997ab98…），复绿。
- **保留**（盘点后明确不动）：文件列/时间列/动作数列/本机列只在部分表有
  （列集差异）；web 名称独立列 vs 其余压 slug 下（使用者选保持现状）；工具域
  首列「组名/工具包」叫法；remote 工具无来源字段（§15.47 遗留缺口）。

---

### 15.49 「▸ slug」不折行 + remote 补 ▸（D69.8）

- **使用者报的两条**：①web 里 `▸ fireworks-tech-graph` 被换行了，问有没有一劳永逸
  的改法；②remote 端没有 ▸，"导致没有展开的功能"。
- **根因（①）**：`table { width: 100% }`——容器一窄，列被压缩，首格里两个内联
  元素（`<button>` chevron + `<code>` slug）的盒子放不下就换行（`code` 自身有
  `white-space: nowrap`，折的是**按钮与 code 之间**）。这不是某一行的问题，
  是内联布局的固有行为，所以之前的"局部微调"都治标。
- **一劳永逸修法**：首格内容包进 flex 容器 **`.row-title`**——`display:flex` 的
  `flex-wrap` 默认 `nowrap`，`▸` 与 slug 永不折行；实在放不下时整格溢出、由
  `.table-wrap` 横向滚动（宁可滚动不可折行）。`.row-title` 原先是 remote 技能页
  的局部样式，上移 `app.css` 共享；web 主表/工具表首格与 remote 工具表首格全部
  包上（remote 技能表本来就用了这个类）。
- **remote 补 ▸（②）**：remote 技能/工具两表首格加 `ExpandToggle`（与 daemon
  同一入口组件）——点它开抽屉，抽屉开着时箭头朝下（`expanded={detail?.slug ===
  s.slug}`）；「查看」按钮保留。remote 的"展开"仍是抽屉范式（D61 真差异），但
  入口与 daemon 一致了。新增 `remote.expandDetail` / `remote.collapseDetail` 词条。
- **探针**：layout 514 → **516**（`skills/tools.slugCellFlexWrap`：首格 `.row-title`
  计算样式 `flex-wrap === 'nowrap'`——钉住**机制**，与视口宽窄无关，比"量 y 坐标"
  稳）；remote 26 → **27**（首行有 `.expand-toggle` 且点它真的开出抽屉）。
- **红证**：变异 `.row-title` 加 `flex-wrap: wrap` → layout 精确红 2 条（实测
  "wrap"）；删 remote 首行 chevron → remote 精确红 1 条（present=false）→ 恢复
  （⚠️ 中途 restore 脚本因变异残留了注释、old_string 没匹配而失败，修脚本后再验），
  md5（js+css）逐字节一致（dd7aeccf…），双探针复绿。

---

### 15.50 任务详情页重排（D69.9）

- **起因**：使用者要重设计任务详情页——"重要资讯直接展示、非重要资讯尽量折叠，
  先给设计待我决定"。先交盘点（9 个信息块全平铺的现状 + 分级 A/B/C + 新结构图 +
  状态驱动矩阵），四点拍板全部按推荐走。
- **分级**：
  - **A 直接展示**：页头（标题/阶段/指派者/时间）、结果区（最新 run 结论/实时
    日志，跑完默认结论、原始流水可翻——原有行为）、判决卡**结论行**（徽标 +
    理由码 + 来源/置信度，常驻）、执行记录 tabs（常驻，选"看哪次执行"是高频）、
    人工裁决。
  - **B 默认折叠**：描述（**状态驱动**：未跑展开——它是唯一正文；跑过折叠）、
    元数据（工作目录/类型/耗时，工作目录放标题行摘要位）、产出文件（原
    `result-files` 右栏，折叠后结果区独占全宽）、判决明细（行动证据/建议动作/
    findings）。
  - **C 罕见保留**：审核人 override（出现才显示）。
- **折叠机制**：新增共享组件 **`FoldSection`**（`@agentdeck/ui/components`）——
  头部是**整行真按钮**（`aria-expanded` + chevron，与表格 ExpandToggle 同一
  纪律），右侧摘要位小字；`open` 只是初始值、折叠态归组件自己，复位靠外层
  `{#key selected.id}`（换任务时折叠态不跟到下一条）。app.css 新增
  `.fold-section/.fold-head/.fold-title/.fold-summary/.fold-body`。
- **结构变化**：描述从头部挪到执行记录之后；`result-grid` 两栏拆掉
  （`result-main` 独立全宽），`result-files` 右栏入折叠区；判决卡结论行之外全部
  入折叠；`result-grid`/`.result-files` 死样式删除；新 i18n
  `tasks.metaHeading/verdictDetails/verdictDetailCount`。
- **探针**：layout 516 → **519**（折叠头是真按钮 + aria-expanded、未跑任务描述
  默认展开、点折叠头能收起/再展开）；旧「文件栏常驻可见」升级为「点开折叠块照旧
  能列」——夹具第一行就是从未跑过的任务，状态驱动直接量得到，不用造 run。
- **红证**：三处变异（描述改常闭 `open={false}`、折叠头去掉 onclick、折叠头改
  div）→ 精确红 5 条（3 条新 pin + 文件折叠块因 div 头点不开连锁红）→ 恢复，
  md5（js+css）逐字节一致（79a885b5…），复绿。

### 15.50.1 工作目录文件回右侧栏（D69.9.1）

- **起因**：使用者看实际效果后改判——「工作目录的文件」是高频项，D69.9 把它
  折叠到下方不合适，**放回原来的位置**（结果区右侧栏、不折叠）。
- **改动**：撤销 D69.9 的「产出文件折叠块」，恢复 `result-grid` 两栏
  （左结论 / 右 `aside.result-files`，`WorkDirTree` 原样），`.result-grid` /
  `.result-files` / 窄屏堆叠样式一并恢复。其余折叠保留：描述（状态驱动）、
  元数据（执行信息）、判决明细。
- **探针**：`tasks.filesColumnStillRenders` 改回「右侧栏常驻可见」判据（不再
  点折叠块）；D69.9 的三条 pin 不变（描述折叠仍在）。519 全绿。
- **红证**：删掉 `aside.result-files` → 精确红 1 条（"点了前 5 条任务都没看到
  文件那一栏"）→ 恢复，md5 逐字节一致（e0a22382…），复绿。

---

### 15.51 「这条任务怎么办」sticky 钉底（D69.10）

- **起因**：使用者指出人工裁决区（这条任务怎么办）在最下面，内容超出一屏时
  够不着；且要求**充分利用一屏**、不要给结果/报告定死高低。
- **实现**：人工裁决区加 `.decide-bar`——`position: sticky; bottom: 0`：
  - 内容超出一屏 → 裁决条**钉在本栏底部**（`.pane-body` 就是滚动容器，
    `overflow-y:auto`，sticky bottom 直接生效），「通过/反馈/放弃」永远够得着；
  - 不满一屏 → 自然跟在正文后面（不凭空占位）；
  - 实底 `var(--bg)` + `border-top`（内容从条底下滚过时不透字）、负横向 margin
    顶掉 `.pane-body` 的侧内边距，做成通栏底条；`z-index:2` 盖过滚动内容。
- **「不要固定高低」**：详情区本就没有任何 height/max-height 约束（实测无），
  结果/报告用自然高度吃满可用屏，裁决条只靠 sticky 钉底——不框死空间。
- **探针**：layout 519 → **520**（`tasks.decideBarSticky`：`.decide-bar` 计算
  样式 `position === 'sticky'` 且 `bottom === '0px'`——机制级钉死，与
  `slugCellFlexWrap` 同一思路）。
- **红证**：`.decide-bar` 改 `position: static` → 精确红 1 条 → 恢复，md5
  逐字节一致（7f81753f…），复绿。

---

### 15.52 「看完整日志」吃满一屏（D69.11）

- **起因**：使用者问"改了吗——点「看完整日志」还是没有展开"。上一轮
  「不要固定高低」指的其实是**日志区**：`RunLog` 的 `.log` 有
  `max-height: 26rem`（这个约束在组件里，不在详情页样式里——上轮查错地方了）。
- **判断**：聊天轮次里日志是"一段辅助输出"，26rem 合理；任务详情里点
  「看完整日志」时日志是**主内容**，26rem 就是"固定高低"、浪费可用屏。
- **修法**：`RunLog` 加 `fill` 属性——`.log.fill { max-height: none;
  height: calc(100vh - 19rem) }`（按视口定高，880px 视口下 ≈576px，不再 26rem
  上限）。任务详情两处 RunLog（实时视图 + 看完整日志视图）都传 `fill`；聊天页
  不传（保持原样）。`max-height: none` 必须同时给，否则 26rem 上限会把 vh 定高
  压回去。
- **探针**：layout 520 → **521**（`tasks.rawLogFillsScreen`：在
  `filesColumnStillRenders` 流程里（已找到跑完的任务）点「看完整日志」，量
  `.log` 计算高度 > 500px，再点回去恢复结果视图。探针 iframe 880px 高：fill 后
  ≈576px、26rem=416px，阈值 500 可区分）。
- **红证**：`.log.fill` 高度改回 26rem → 精确红 1 条（实测 416px）→ 恢复，md5
  逐字节一致（e973cdab…），复绿。

---

### 15.53 「看完整日志」不再有外置滚动条（D69.12）

- **起因**：使用者点「看完整日志」后出现**两个滚动条**——`.log` 内置一条、
  详情栏又一条（外置那条不该有）。D69.11 用 `calc(100vh - 19rem)` 定高，但
  判决/元数据区还在下面，整栏仍然溢出 → 外置滚动条。
- **修法**：日志视图 = **flex 纵向布局**（`logMode` = 正在跑 ∨ 点了看完整日志）：
  - `pane-body` 切 `display:flex; flex-direction:column; overflow:hidden`（不再
    整栏滚动）；flex 链 `.run-section`(flex 1) → `RunLog .log-wrap.fill`(flex 1)
    → `.log.fill`(flex 1, `min-height:0`, 内部滚动)——日志**精确吃满剩余空间**，
    外置滚动条物理上不存在了；
  - **日志视图隐藏裁决表单**（`canDecide && !logMode`）：裁决表单（说明 +
    textarea + 按钮）实测占 ~246px，会把日志挤成 76px。日志视图是"读日志"的
    专注态，切回「看最后结果」再裁决；D69.10 的 sticky 钉底针对的是结果视图
    内容溢出的场景，日志视图无溢出、不适用；
  - 聊天页 RunLog 不传 `fill`（保持 26rem 原样）。
- **探针**：layout 521 → **522**（`tasks.logModeNoOuterScroll` = 日志视图时
  `.pane-body` 计算样式 `overflowY === 'hidden'` 且 `display === 'flex'`——
  双滚动条修复的机制级钉死；`tasks.logFillsPane` = 日志高度占详情栏过半）。
  初版 `logFillsPane` 用"底边距"测（实测 271px，裁决条太高）误红，改占比。
- **红证**：`.detail-scroll.log-mode` 改 `display:block; overflow-y:auto` →
  精确红 2 条（外置滚动条回来了 + 日志塌成 2%）→ 恢复，md5 逐字节一致
  （d56ef70f…），复绿。

---

### 15.54 词条调整（D69.13）

- 使用者要求四项：
  1. **删掉裁决 intro**：「审核卡住了、或者这条任务压根没有审核者时，由你来
     收场。」——`tasks.decideIntro` 词条 + 裁决区那句 `<p>` 一起移除；
  2. 「看完整日志」→ **「完整日志」**（`tasks.showRawLog`）；
  3. 「看最后结果」→ **「最后结果」**（`tasks.showFinalResult`）；
  4. **「理由 / 反馈内容」加粗**——与「这条任务怎么办」标题同级（h3 字重
     600），`.human-reason .reason-label { font-weight: 600 }`。
- **连带**：两处提示文案（无正文提示、判决本体提示）里引用的按钮名
  「看完整日志」同步改成「完整日志」，别指着旧名字。
- **探针**：layout 522 → **524**。注意 substring 匹配挡不住词条被改回
  （`'看完整日志'.includes('完整日志')` 照样过）——新增 `tasks.logToggleLabel`
  / `tasks.showFinalResultLabel` 两个 **精确整串** pin（点「完整日志」前 =
  「完整日志」，切过去后同一按钮 = 「最后结果」）。
- **红证**：`showRawLog` zh 改回「看完整日志」→ 精确红 1 条（
  `logToggleLabel`）→ 恢复，md5 逐字节一致（57dce590…），复绿。

---

### 15.55 去掉「这条任务怎么办」标题（D69.14）

- 使用者要求去掉裁决区「这条任务怎么办」字样：删掉 `tasks.decideHeading`
  词条（zh+en）和裁决条里那句 `<h3>`。
- 裁决条现在的醒目行是「理由 / 反馈内容」（D69.13 已加粗到 h3 同级）。
- **探针**：layout 524 → **525**（`tasks.noDecideHeading`：`.decide-bar` 内不再
  出现「这条任务怎么办」——直接钉"标题已删"这个事实）。
- **红证**：词条 + `<h3>` 一起加回去 → 精确红 1 条 → 恢复，md5 逐字节一致
  （60e383cf…），复绿。

---

## 16. 待决与已知风险

| # | 项 | 说明 |
|---|---|---|
| R1 | **Q3 未定** | 首批 `report` 解析器形态。解析器是第三方适配层的一个环节，接口先按"接收任意文本 + 可选出结构"设计 |
| R2 | **单 CLI 风险** | Claude Code 的破坏性变更会直接影响可用性。对冲：§9.1 描述表 + §9.7「不可解析必须报错」 |
| R3 | **文件存储的规模上限** | 未做压测。目标域为"数百 issue / 几十 agent"；超出后由 `Store` 端口换数据库解决 |
| R4 | **`node:sqlite` 备选** | 若文件存储成为瓶颈，可先换 Node 内置 `node:sqlite`（无原生模块），再考虑外部数据库 |
| R5 | **判决提取的健壮性** | §9.5 的"约定围栏 + 确定性切片"需实测不同输出风格下的成功率；**这是 M1 的主要技术风险** |
| R6 | **未验证的 CLI 版本范围** | 必须以实际版本验证。M1 开始前必须先固定一个 Claude Code 版本并跑通端到端 |
| R7 | **同源反向风险** | 本机可在该源执行脚本的东西（扩展、注入）都能驱动 daemon；daemon 无法防御（§14.2） |
| **R8** | **插件机制的三点待确认** | 见 §12.5：P1 是否可执行代码（**倾向可以**）、P2 是否沙箱（**倾向不沙箱，靠 scope 白名单**）、P3 范围边界（**倾向首版只做 `login` + `third-party`**）。已按倾向写入 D26，若有异议需回改。**M3 实现后状态**：P2 的 scope 白名单与 P3 的能力边界已落地并被测试固定；**P1 已落地**（见 §15.3 ⑥）——`entry` 里的代码现在真的会被加载执行，`entry` 越界、语法错误、非 `.js/.mjs` 都会被拒绝，且单个插件的失败不影响其他插件。**仍然不做沙箱**：插件跑在宿主进程里，边界靠 scope 白名单声明式约束 |
| ~~R9~~ | ~~`stateless` 槽位加了但没用起来~~ | **已解决**：改成三态 `sessionState: 'stateful' \| 'stateless' \| 'unknown'`（二态的 `undefined` 同时承担了"有会话"和"不知道"两个意思，会逼着没验证过的 runtime 二选一撒谎）。执行器按它决定是否恢复，三种状态的**措辞不同**——"确认不支持"与"没验证过"需要的后续动作不一样。见 §15.7 ③ |
| **R10** | **`FR-CLI-07` 的版本范围：机制已就位，但 `verifiedWith` 是空的** | 已实现 `versions: { range, verifiedWith, onMismatch }` + `checkVersionSupport()` + `--verify-runtime` 命令，并把判定结果接进 `/api/identity` 与页面。**关键设计**：`verifiedWith` 为空的一行被如实报成 `undeclared`（未声明），而不是"支持"——需求写着"以实际版本验证，**不得凭文档推断**"，而填一个范围字符串就宣称支持，正是该需求要防的事，且**比不填更有害**（看起来像验证过了）。<br>**仍未完成的部分**：本仓库的测试禁止调用真实 CLI（NFR-T-01），所以没有任何人端到端跑通过真实 Claude Code，`verifiedWith` 只能留空。`--verify-runtime` 把"探测"自动化了（免费、无副作用），但**刻意不替你填那个数组**——探测到版本号只证明二进制在那儿，不证明字段名对得上。让命令去填，等于把"没验证"伪装成"验证过了" |
| **R11** | **`blockedArgs` 的值语法是 POSIX 专属** | `withValue` 靠"下一个 token 不以 `-` 开头"判定。Windows 风格 `/flag:value` 覆盖不到。当前没踩到只因 generic 刻意用了长旗标 |
| **R12** | **可选沙箱不是安全边界** | `--sandbox workdir-write` 只在 macOS（`sandbox-exec`）与 Linux（`bwrap`）上可用，且 `sandbox-exec` 已被 Apple 标注为 deprecated。它挡误操作，不挡对手。**不可用时会明确报错而不是静默降级**——静默降级会让人在以为自己被保护着的情况下裸奔。README 与安全文档必须连这段一起说 |
| **R13** | **"支持 N 个 runtime"的成本尚未真正降到 O(1)** | `apps/daemon/src/runtime-registry.ts` 是描述符→适配器的唯一装配点，所以"接一个新适配器包"要在那里加一行。这是**一次性**的，不是"每个用到 backend 的地方各加 if"（后者才是 FR-CLI-47 要防的）。但它确实还不是纯粹的"加一行数据" |

---

## 17. 与需求文档的对应索引

| 设计章节 | 对应需求 |
|---|---|
| §2 总体架构 | §1 定位、P1、NFR-D-01~08 |
| §2.6 状态归属与编排 | FR-BRIDGE-01~08 |
| §3.2 protocol | INV-18/19、FR-REVIEW-12 |
| §3.3 存储端口 | FR-STOR-01~06 |
| §4 数据模型 | §12 数据实体、DR-1~4 |
| §5 接口 | IF-1~5、FR-AUTH-02 |
| §6 状态机 | §10 状态机、SM-RUN/ACT、FR-RUN-08 |
| §7 Verdict schema | FR-REVIEW-01~13、D2 |
| §8 本地 Daemon | FR-RUNTIME-01~13、FR-BRIDGE-06/07 |
| §9 Claude 适配层 | **§9.13 全部条目**、NFR-P-01~06 |
| §10 审核流水线 | SC-1~4、INV-1~3、INV-14~17 |
| §11 动作与审计 | FR-ACTION-01~10、FR-AUDIT-01~06、INV-9~13 |
| §12 远端能力 | FR-REG-01~18、FR-AGENT-10/11 |
| §14 安全边界 | NG7、NFR-SEC-01~04、§1.3 |
| §15 里程碑 | §15 里程碑、§14 验收标准 |

### 15.56 主区统一：聊天 / 任务 / 智能体共用一个右主区壳（D69.15）

**背景**：左列表早在 D66 统一成 `ListPane`/`ListRow`；右侧主内容区一直是三份手写的 `<section class="pane detail-pane">` + 栏头 + 空态样板。使用者要求"把三个视图的主区显示统一一下，用同一组件"，且先呈现方案。

**决策（三问三答，全部按推荐拍板）**：
- 范围 = **右侧主内容区**（左侧列表已是共享组件，不重做）；
- 深度 = **壳 + 栏头 + 空态**（正文各视图自有形态，不强行同构）；
- 节奏 = **渐进式**：智能体（最简单）→ 任务（栏头结构化化）→ 聊天（栏头最特殊，最后做）。

**组件**：`apps/web/src/components/MainArea.svelte`（runes，props 全走 `Snippet`）。

```
<section class="pane detail-pane">      ← 壳（三视图唯一出处）
  ├─ 栏头：head snippet 完全接管（聊天改名形态）
  │       否则结构化 props：backLabel/onBack/title/sub/actions（任务/建任务）
  ├─ div.pane-body{bodyClass}           ← 正文容器
  │     ├─ empty ? 空态（emptyContent snippet 优先 / emptyTitle+emptyHint）
  │     └─ 否则 body snippet
  └─ foot snippet                       ← 聊天的文件树 + 输入条
```

**接入差异**（尊重各视图原有形态，只收骨架）：
- 智能体：`empty` + body（AgentDetail）；
- 任务：建任务 / 详情 / 空态三态同壳；详情栏头用结构化 props——**栏头从此固定在上方**（原来在 `.detail-scroll` 里随正文滚走；与聊天 chat-head 同形态，正是统一的收益）；`log-mode` flex 链、`.decide-bar` sticky、折叠/结果区契约原样；
- 聊天：栏头走 head snippet（chat-head 的改名输入替换 h2、pane-actions 是兄弟元素，塞不进结构化 props）；chat-dir/chat-dir-hint 并入 head snippet、chat-files+输入条并入 foot snippet；输入条草稿与对话两支都在（D46/D58 教训），空态不渲染。

**踩坑：Svelte scoped 样式不跨组件**。打在 MainArea 渲染元素上的 scoped 选择器全部失效：
- Tasks 的 `.create-body` / `.create-head` / `.detail-scroll.log-mode*`、Chat 的 `.chat-stream` → 改 `:global`；
- `.create-body` 必须写成 **`:global(.pane-body.create-body)` 双类**：单类 `.create-body` 与 app.css `.pane-body`（padding）同特异性 (0,1,0)，bundle 里 `.pane-body` 靠后 → `padding:0` 被盖 → form-frame 窄 48px、提交栏横贯不了可滚区（实测 885 vs 933；双类升到 (0,2,0)，与出现顺序无关地稳压）。

**验证**：typecheck 0 错 0 警、测试 1730、探针 layout 525 不变（探针全是后代 class pin，class 契约全保留）。红证：MainArea 壳去掉 `detail-pane` → 精确红 511 条 → 恢复，md5 逐字节一致（1ed86c67…），复绿。

**追补（D69.15.1）：栏头标题统一。** D69.15 只统一了壳，标题字号没统一：任务/智能体的 h2 落全局 `h2 { font-size: var(--fs-xl) }`（22px），聊天被 `.pane-head h2` 钉成 fs-lg（17px）——使用者当场抓"Title 高度不一样"。且任务详情栏头移出 `.pane-body` 后 padding 归零、贴顶、无下边框。修法：`.detail-head` 容器规则（padding sp-4/sp-5/sp-3 + border-bottom，与 `.pane-head` 同套）与 `.detail-head h2 { font-size: var(--fs-lg) }` 进 app.css（MainArea 渲染、scoped 打不进）；AgentDetail `.hero-title h2` 钉 fs-lg；Tasks `:global(.create-head)` 升双类 `:global(.detail-head.create-head)` 压住 app.css 的 `.detail-head`。新探针 3 条（标题字号/头指标，525→528），红证精确红 2 条。

**追补（D69.15.2）：主区风格全量统一。** 对三个右主区做全量指标审计又抓出 4 处不一致：①任务空态挂着残留栏头（D69.15 回归）——MainArea 栏头条件加 `!empty` 守卫（空态不渲染栏头，任何视图通用）；②聊天标题低 7px——聊天栏头的改名按钮/输入是行里最高的，baseline 对齐把 h2 顶下去，竖 padding 归零压到标题同高；③智能体 hero 缩在 pane-body 里——`.decide-bar` 同款负边距通栏；④智能体角色提示 12px——统一 14px。审计确认：三个栏头 box 全 (52,657,w783)、标题全 y=68/fs-lg、副题 14px、空态全无头。新增 4 条探针 pin（528→532）。红证：3 处回退→精确红 3；MainArea 守卫变异→精确红 1；md5 逐字节一致（89bea688…）。

### 15.57 安装面板改成"主区就地面板"（技能 / 工具）

**使用者报的**：「技能和工具的安装都是右侧弹框，需要改成类似新建智能体那样，在主区显示，
而不是弹框。」——"新建智能体"已经是主区里开表单（`AgentDetail` 那一套），所以要求的是
**同一个行为**：主区换成表单，而不是浮一个抽屉在上面。

**决策（三选一，使用者拍板"就地把主区换成安装面板"）**：不做"左列表 + 右主区"的整页主从改造，
也不做"面板在表格上方、表格留着"——**安装面板打开时整块取代列表**。

**改法**（`Skills.svelte` / `Tools.svelte` 同一形状）：
- `div.drawer.wide[role=dialog][aria-modal]` → `<section class="main-panel">`，三段：
  `.main-panel-head`（**一直可见**的 `.panel-back` + `<h2>`）/ `.main-panel-body`（页签、字段、
  反馈全不动）/ `.main-panel-foot`（主操作，原来是 `.drawer-foot`）；
- 列表块搬进 `{:else}`：面板开着 = 列表**不在 DOM 里**（不是被推下去、也不是被挡住）；
- 页面上那个「安装」主操作加 `disabled: panelOpen`（面板已经开着，按钮是重复入口）；
- 样式进 `packages/ui/src/styles/app.css`（不是组件 scoped）：`.main-panel*` 与 `.pane-*`
  同一套指标，**刻意不写** `position: fixed/absolute`、不写遮罩、不写 `z-index`
  ——那三样是"它是对话框"的证据，而它已经不是了：读屏器不该被告知后面那块不可达；
- Esc 仍然关（同一页里那个「本地技能目录」设置抽屉能 Esc 关，两种手感说不通）。

**为什么返回入口不能复用 `.back-to-list`**：那个全局 class 在宽屏是 `display: none`
（它只在 ≤72rem、列表与详情只剩一栏时才有意义）。列表被面板换掉之后返回入口是**唯一的路**，
所以新词条 `skills.backToList` / `tools.backToList`，并且探针量的是**真实盒子宽度 > 0**，
不是"某个 class 在不在"。

**当初为什么是抽屉（以及现在为什么不冲突）**：原决策（§15 里那一条，已就地加注）担心的
是"表单插在页头和列表之间会把列表推到看不见的地方"——面板**取代**列表之后这件事不存在了；
而"装完看不见列表"由**结果块**兜住（装了哪些文件、哪个 slug、来源逐条列出来），返回时列表
已经刷新过。

**验证**：`pnpm run typecheck` 0 错；测试 1776/0；探针里那 12 条针对安装面板的判据逐条量到
并全绿——`.main-panel` 落在 `.main` 内容盒里（左右边缘差 ≤2px）、`position` 不是浮层、
无遮罩、取代列表、返回入口可见且点得回去、Esc 关得掉、底部主操作文案不变；装坏包/装好包
两条真实安装流程原样通过。旧那几条（"抽屉在右侧 / 宽 46rem / 有遮罩"）随这次改动作废。

⚠️ **探针现状**：跑探针时发现它整体已经落后于界面（本会话前几轮的改造没同步更新探针）。
调大两把闸之后这一趟是**跑完**的：537 条里 **358 绿、74 红、105 没量到**——安装面板这 12 条
判据全在其中。（⚠️ 2026-10「查看器支持视频」那一轮之后是 **542 条 / 363 绿 / 74 红 /
105 没量到**：新加的那 5 条音视频判据全绿，见 §15.58。）红集中在「新建任务的三步链 28 / 审核标准 13 / 新建任务 9 / 智能体 8 …」，
全是前面几轮改掉的形状。"哪几段过期、每段为什么过期、怎么复现那份判据"记在
`tools/layout-probe/README.md` 的「⚠️ 现状：有 7 段已经过期」一节，下一轮专门重对齐。

---

## 15.58 展示页面支持视频（音视频就地播放）

**这一轮的起因**：使用者的原话——「展示页面目前不支持视频文件显示， 请修改」。他指的是
任务详情 / 聊天右栏「工作目录的文件」里点开一个文件的那个查看器。

### 查下来是两层叠在一起

不是"少一个 `<video>` 标签"那么简单，两处各坏了一半、而症状只有一个：

1. **daemon 不认识音视频**：`workdir-files.ts` 的 `CONTENT_TYPES` 里一个 `video/*` /
   `audio/*` 都没有 ⇒ `.mp4` 被回成 `application/octet-stream` ⇒ 界面按"二进制"处理，
   给一屏十六进制（小的还看得见 hex，大的直接撞"超过 8MB 读取上限"）。
2. **那条路由把整份文件读进内存**（`readWorkFile`，8MB 上限）并且**不认 `Range`**。
   就算认出了类型，一段几十 MB 的视频会被上限挡掉；而**没有 Range 就没有 seek**——
   "能播但不能拖"等于没支持。

两层都得改，只改界面会得到一个永远停在"读取上限"上的播放器。

### 改法

**daemon**（`workdir-files.ts` + `server.ts`）：

- `CONTENT_TYPES` 补上音视频后缀（`.mp4/.m4v/.webm/.mov/.mkv/.avi/.ogv/.mpg/.mpeg/
  .wmv/.flv/.3gp`、`.mp3/.wav/.m4a/.aac/.flac/.oga/.ogg/.opus`）。**刻意没有 `.ts`**：
  那个后缀在本项目里绝大多数时候是 TypeScript 源码（它在表里是 `text/plain`），
  当成 MPEG-TS 会让一堆源码文件变成播放器。
- 新中间层 `openWorkFile()`：**所有守卫（`..`、绝对路径、软链、是不是文件、上限）
  只在这一处**，返回 `{path, size, contentType, streamable}`。理由：路由现在有两条
  发法，守卫写两遍迟早分叉，而分叉的表现是"其中一条路上能读到工作目录外面的文件"。
- 上限**分两档**：非媒体照旧 8MB（界面要把它读进内存），媒体 2GB（流着发，不占内存）。
- 媒体那条路：`createReadStream` + `pipeline` 流出去，**认 `Range`**
  （`parseByteRange`：`bytes=A-B` / `bytes=A-` / `bytes=-N` 三种写法；起点越界 ⇒ **416**
  而不是"忽略 Range 回 200"——回 200 整份会让客户端以为自己拿到了要的那一段，
  症状是"播到某处卡住"）；响应带 `accept-ranges: bytes`。
- ⚠️ **媒体响应刻意不带那条 `sandbox` 的 CSP**（新的一组 `MEDIA_FILE_HEADERS`，只有
  `nosniff` + `cache-control: no-store` + `accept-ranges`）：那条 CSP 是给"agent 写的
  **文档**"用的；带上它，浏览器**在新标签页**里为媒体合成的那张文档自己会被
  `default-src 'none'` 管住（它自己的 `media-src` 落回 `none`）⇒ 视频放不出来。
  边界没有变松：`nosniff` + 正确的 `video/*` 类型 ⇔ 浏览器不会把它当文档解析。

**界面**（`lib/file-view.ts` + `components/FileViewer.svelte`）：

- 新类别 `video` / `audio`：按 `video/*` / `audio/*` 认；**再加一层**——服务端回
  `application/octet-stream`（老 daemon，或表里还没有的容器）时，后缀是媒体就按媒体。
  这不与"octet-stream 优先于后缀"那条冲突：那条针对的是**文本**（内容是二进制的
  `.py` 不该按文本渲染），而媒体本来就不参与"解出来像不像文本"；错判的代价只是
  播放器报一次错。
- 新判断 `previewMode(path)`：`'stream'`（媒体）= **一个字节都不下载**，URL 直接交给
  `<video>`，由浏览器按 Range 取；`'bytes'`（其余）= 老路子。**这条只能按后缀**——
  它回答的是"要不要发请求"，而 content-type 要发完请求才知道，等知道时 300MB 已经
  进内存了。
- 音视频**只有播放这一面**（`hasFace`）：没有「原文」。把几百 MB 拉回页面来 hex dump
  前 512 字节是荒谬的；要看字节走右侧「在新标签页打开」（浏览器自己按 Range 取，还能另存）。
- **放不出来要说一句人话**：`<video onerror>` ⇒ 一句「这个容器或编码浏览器放不了
  （不是文件坏了）……」。`.mkv` / `.avi` / HEVC 这类 Chrome 本来就不认，不说清是谁的事，
  使用者会去查一个不存在的 bug。

### 踩到的一个坑：**画按钮的判据不能等异步的 `kind`**

这是这一轮里唯一一处"看着对、实测错"的地方，也是探针抓出来的：

`kind`（"这份文件按哪类渲染"）是在 `load()` 里赋的，而对普通文件 `load()` 是
**异步的**（要 `await fetch` 才知道 content-type）。把"画不画「渲染 | 原文」那对
按钮"押在它上面，就会出现**这一轮渲染用的是上一份文件的类别**：一段视频**确实放出来
了**（分支判的是同一个 `kind`，那一轮它已经是 `video`），而标题栏上**还挂着**上一份
代码文件才该有的那对按钮——使用者看到的是"这段视频居然能切回原文"，点进去只会得到
一屏十六进制。这条**不报错**，只有真的量界面才看得见（探针第一次报的就是它；前两趟
还因为我自己的断言写成 `fvBar()?.querySelector(...) !== null`（`undefined !== null`
是真）绕了一圈）。

改法：**渲染判据用后缀当场算**（新派生的 `shownKind = mediaKindOf(entry.path) ?? kind`）。
后缀是同步可得的，媒体那一档因此不存在时间差；其余类别（`.md` 与 `.txt` 在服务端都
是 `text/plain`，只看类型分不出）仍然照旧等 `kind`。

### 验证

- `pnpm run typecheck` 0 错；`pnpm run test` **1799/0**（比上一轮 +23 条：web 侧音视频
  分类 / 策略 / 面 / "放不出来是谁的事" 10 条，daemon 侧类型表 / `parseByteRange` /
  `openWorkFile` 守卫 11 条，路由级 `Range` 那 5 条在 `conversation-files-e2e.test.ts` 里）。
  ⚠️ svelte-check 那条 `a11y_media_has_caption` 是**刻意 ignore** 的：那是 agent 产出的一段
  视频，我们手里没有任何字幕轨——塞一个空 `<track>` 只是把 lint 骗过去，a11y 规则要防的
  "让聋人用户以为有字幕"在这里本来就成立（一个字幕都没有），正确的做法是别假装。
- **真实播放**由布局探针量（不是"元素在不在"）：夹具用 `ffmpeg` 现造一段 160x120 的
  WebM/VP8，判据是 `<video controls>` + **`readyState >= 1`**（浏览器真的解出了元数据）
  + 没有 hex / 原文面；`Range: bytes=0-99` 那条从探针页自己 `fetch`，要 **206** +
  正确的 `content-range` + 只有 100 字节，并且再整份取一次逐字节比对。
  ⚠️ 探针那一趟实测到**真问题**（见下一节）：新加的 5 条现在全绿，整趟是
  **542 条 / 363 绿 / 74 红 / 105 没量到**（那 74 红是之前几轮欠下的、已与你确认另开一轮
  重对齐的 7 段，与这一轮无关）。
  ⚠️ 用 **WebM/VP8** 而不是 H.264：Chrome 与 Chromium 都解码得了（探针可能落在任何一个
  二进制上）。音频用手写 WAV（不依赖 ffmpeg），"放不出来"那一条用**冒充 `.mkv` 的垃圾
  字节**（必然解不出来 ⇒ 确定性量得到那句话）。

### 为什么不做的事

- **不给音视频加「原文」面**（如上）。
- **不加播放列表 / 全屏自定义控件 / 转码**：转码要引入 ffmpeg 这条重依赖，而"浏览器
  放不了"已经如实说清楚了。
- **不动 `.ts`**、不动文本/图片那一档的 CSP 与 8MB 上限。

---

## 15.59 Windows 兼容性：A 级三条 + 入口版本守卫 + B 级收尾（2026-10）

**这一轮的起因**：使用者的原话——「此项目需要可以在 windows 下执行， 请检查兼容性」。
审计写在 `docs/reference/windows-compat.md`（按 A/B/C/D 四级、每条指到文件行、
并逐条标 `[量到]`/`[判断]`）；这一节只记**改了什么、为什么这么改**。

### 最要紧的一条：Windows 上"探测到的文件"不是"能 exec 的文件"

npm 装在 Windows 上的 CLI 是 **`.cmd` 垫片**，而 Node 从 2024-04 的安全版本起
（CVE-2024-27980）**拒绝 `shell: false` 地 spawn `.cmd`/`.bat`**——参数校验阶段抛
`EINVAL`。原来的 `process-tree.ts` 是 `spawn(探测到的路径)`，于是 **Windows 上所有
runtime、所有任务一起挂**，报的还是一句裸的 `spawn EINVAL`
（`describeSpawnError` 熟悉的是 ENOENT/EACCES，不认这个码）。

三条路里选了**解开垫片**（`spawn-target.ts`）：

- ① 主路径：垫片里真正调的是 `"<node>" "<…\cli.js>" %*` ⇒ 抠出那个脚本，
  用**正在跑 daemon 的这个 node** 起它。参数**原样**交给 CLI（不经 shell），
  进程树干净（`taskkill /T` 照样管用）。为什么不用垫片自带那个 `node.exe`：
  它要么不存在（现代 npm 写 `SET "_prog=node"`，意思是"从 PATH 找"），
  要么是来路不明的副本——**猜错解释器的表现是"CLI 起来了但报语法错"**。
- ② 兜底：形状认不出来就 `cmd.exe /d /s /c`。⚠️ 参数里出现 `"`/`%`/换行就
  **明确拒绝**而不是转义：cmd 的解析器与目标程序的 CRT 解析器各有各的规则，
  "转义一次两边都对"的写法不存在，而静默改写的表现是"prompt 少了半句"。
- ③ `shell: true`：**不采用**（注入面 + Node 的 DEP0190 警告 + `.cmd` 里的 `%*`
  又是另一套引号规则）。

顺带两处（同一轮审计的 A2/A3）：

- **`.ps1` 从探测候选里拿掉**，候选扩展名改读机器的 `PATHEXT` 并按"Node 起得起来"
  过滤。`.ps1` 一度在候选表里，而 **Node 起不了它**（要 `powershell -File`）——
  表现是"预检说这个 CLI 可用、真跑必炸"。`.ps1` 真被指到时现在会明确拒绝，
  并说清"npm 装的时候同时给了 `.cmd`"。
- **假 CLI 的包装按平台产出**（`executableWrapper`）：Unix 仍是 `#!/bin/sh` + exec
  （形状逐字未变），Windows 改成一段**形状与 npm 垫片一致**的 `.cmd`。
  于是"被测的 argv 仍是真实 argv"这条性质（假 CLI 存在的全部意义）两个平台都成立。
  这条不修的话，依赖它的 **61 条**测试在 Windows 上必红，而红的原因会指向适配器。

### 为什么这些判据能在 macOS 上跑

平台与文件内容都是**注入**的（`platform: 'win32'`、`readText`），夹具用的是
**逐字抄的真 npm 垫片**（不是自己编的形状——拿自己编的形状测自己的解析器等于没测）。
31 条新判据里真起进程的那几条（argv 转交）用本机 node，其余全是纯函数。
**没被钉住的只剩最后一层**："真 Windows 上 exec 得起来吗"——写在审计文档的
"没量到的"那一节，别把它当成已验。

### 入口版本守卫：为什么必须是 `.mjs`

`engines` 写 `>=22` 是错的：仓库把 `.ts` **直接交给 node** 跑，靠类型擦除，
而它默认可用是 **23.6 起、回移到 22.18**。实测（下载真的 Node 22.17.0 跑仓库代码）：

```
TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".ts" for …/apps/daemon/src/cli.ts
```

那句话里没有一个字提到"你的 node 太老"，看起来像仓库坏了。所以加了一层前置壳
`scripts/node-entry.mjs`：先在**普通 JavaScript** 里检查版本（⚠️ 写在 `.ts` 里是
跑不到的——node 连那个文件都加载不了），不合格就换成一句能照做的话并退出 1，
合格则**把 `process.argv` 掰回"入口直接跑"的样子**再 `import()` 真入口
（不然所有入口按 `slice(2)` 读参数时会把入口路径当成第一个位置参数）。

于是 `pnpm run daemon` 现在是 `node scripts/node-entry.mjs apps/daemon/src/cli.ts`——
命令**多了一层**，这是明确的取舍：换来的是"版本不够时不会让你去猜"。
`engines` 同时收紧到 `>=22.18`（23.x 那条线要 23.6）。

### B 级收尾（同一条审计线索，第二刀）

A 级修完，接着把"能跑但会误导人或掉功能"那几条做完。三条都是**同一个毛病：
提示或判据在最需要它的平台上不成立**。

- **B2（解释器文案）**：工具包的 `shell`/`python3` 找不到时，文案原来只提
  "macOS 自带 / Debian 上 `apt install`"——Windows 使用者拿它**照做不了**，
  而照做不了的错误提示等于没有提示。现在抽成纯函数按平台分支
  （Windows 上给 `winget install Git.Git` / `Python.Python.3.12`、点明那个可执行文件叫
  `python.exe`），并且 Windows 上把 **`python` 也当候选**——少了这一步的表现是
  "使用者明明装了 Python 3、`python --version` 也能跑，工具包却报'没装 python3'"。
- **B3（可写判据）**：环境预检的**全部理由**是把"CLI 状态目录写不进去"从一句指向
  错方向的 EPERM 提前成启动时的一句人话；而它用的 `access(W_OK)` 在 Windows 上
  不查 ACL ⇒ **正好会在最需要它的那台机器上报"一切正常"**，问题照样推到运行时。
  改成真写一个探针文件再删掉（非 Windows 保留 `access` 快路：那边它是准的，
  而且不往使用者家目录里落任何东西）。顺手补了一条与平台无关的判定：
  那个位置上有个**同名文件**时也报不可用——两种平台的旧实现都说"ok"，
  而 CLI 会在运行中报 `ENOTDIR`，那句话里看不出"是你的状态路径被文件占了"。
- **B6（原子写重试）**：Windows 的 `rename` 在目标文件**此刻被别的进程打开着**时会
  以 `EPERM`/`EACCES` 失败，而占用的原因常常是别人的事（杀毒扫描、索引器）——
  毫秒级就过去了。我们的写入面正好是最容易被扫的（`meta.json` 每次启动都重写），
  所以"偶发 EPERM"在那边是常态，而它现在会让**启动直接失败**。
  加 4 次退避重试（20/40/80/160ms），**只在 win32 上**——POSIX 的 `rename`
  覆盖已打开的文件是允许的，在那边重试只会让"真没权限"晚 300ms 才报出来；
  别的错误码（`ENOSPC` 之类）一次都不重试。
- **D（探针）**：Windows 上也找得到浏览器了（Chrome 三个常见位置 + **Edge** 兜底——
  有些机器上 Edge 是唯一存在的浏览器，那正好是"探针能不能跑"的分界），
  收尾用 `taskkill /T /F` 而不是 `pkill`（Chrome 的子进程在杀掉父进程之后还活着、
  还占着那个 profile 目录）。

判据同样都**能在 macOS 上成立**：平台是注入的（`platform: 'win32'`），
"写探针"与"rename"也都是注入的——所以"Windows 上必须真写一次"、"EPERM 要重试到第 4 次"
这两件事是**逐次钉住的真判据**，而不是"看起来应该会"。新增 20 条
（解释器文案 3 + 可写预检 8 + rename 重试 9）。

### 验证

- `pnpm run typecheck` 0 错 0 警；`pnpm run test` **1852/0**（+51 条判据）。
- **实测**：真的 Node 22.17.0 上跑 `scripts/node-entry.mjs apps/daemon/src/cli.ts`
  ⇒ 打印那段话 + 退出码 1（对照：不加壳时是 `ERR_UNKNOWN_FILE_EXTENSION` 堆栈）。
- **Unix 行为一个字没变**：`resolveSpawnTarget` 在非 Windows 上原样返回
  （`via: 'direct'`，且**连垫片文件都不读**），原来的进程树/适配器测试全绿。
- 顺手修的 B 级五条（`splitPath` 认反斜杠、`isAbsolute`、`.gitattributes`、`~\`）
  见审计文档的"已经修掉的"表。

### 不同意的/没做的

- **不给 Windows 装 sandbox**：`sandbox.ts` 在 win32 上仍然返回"没有实现可选沙箱"，
  `mode: 'required'` 会明确抛（**不静默降级**）。这是设计决定，不是缺口。
- ~~不改环境预检的可写判定（B3）~~、~~不给 `rename` 加退避重试（B6）~~、
  ~~不动探针（D 级）~~：这三条在第二刀里做完了（见上）。
- **仍然不做的**：给 Windows 装 sandbox、给探针做 Windows 上的回归（那边要真机）、
  以及审计文档"C 级"清单里那些**已经是对的**东西（那些不用动）。
