# Codex 支持设计（agent-codex，app-server 形式）

> 状态：**已实现并接入真实 codex**。设计按 **codex app-server 形式**定稿：不 spawn
> 一次性 `codex exec` 子进程，而是每次 run 起一个 `codex app-server`，走
> **JSON-RPC 2.0（stdio JSONL）**：`thread/start`（或 `thread/resume`）→ `turn/start`
> → 流式 `item/*` 通知 → `turn/completed` 终止。
>
> 证据等级：**`verified`**（2026-09-27，真实 app-server **0.144.0-alpha.4 与 0.157.1**、本机
> local 模型端点实测，§7 清单逐条核对；残余未验证项见 §7 第 3/9 条与
> `unverifiedFields()`）。v1（`codex exec` CLI 形式）已作废。
>
> 事实基准：openai/codex 仓库（`main` 分支，2026-03 快照）的
> `codex-rs/app-server-protocol/src/protocol/v2/{thread,turn,item,notification,thread_usage}.rs`、
> `codex-rs/cli/src/main.rs`（`AppServerCommand`）、`codex-rs/protocol/src/user_input.rs`，
> 以及官方 App Server API 文档（overview / initialization / threads / turns / items / models /
> skills）。凡"还没在真实 app-server 上跑过"的，按仓库规矩标成 **`[未验证]`**——§7 核对后
> 绝大多数已消除，实测与文档的差异见 §7 的差异清单。

---

## 0.1 已拍板的决策（2026-03，五问五答）

| # | 决策 | 结论 |
|---|---|---|
| 1 | 进程模型 | **per-run**：每次 run 起一个 `codex app-server`，run 完 terminate（§4） |
| 2 | `kind: 'cli' \| 'service'` 契约扩展 | **接受**（§3） |
| 3 | `customArgs` 对 service 的处置 | **适配器级不静默**：ExecOptions 注释声明 service 不消费该通道；codex 后端收到非空 `customArgs` 时记警告（与"收到 maxTurns 但无上限"同一出口）。**不在 daemon 加校验**——该字段今天没有任何写入入口（daemon 不传、Agent 实体没有、界面没有），为一个不存在的入口加防御是空转；将来给 `customArgs` 加写入入口时，再在写入口拒绝 service runtime（§3.4） |
| 4 | 技能注入 | **写工作目录 `.codex/skills`**（项目作用域，机制不变）（§2.7 路 A） |
| 5 | 审批防御 | `approvalPolicy:'never'` 下仍收到审批请求 ⇒ 回 `decline` + run 日志大声说明（§2.5） |

---

## 0. 结论摘要

| 项 | 结论 |
|---|---|
| 集成形态 | 每次 run 起一个 `codex app-server`（`--listen stdio://`），JSON-RPC 对话后关闭；**per-run 进程模型**（§4，v1 推荐） |
| 一次 run 的时序 | `initialize` 握手 → `thread/start`（新线程，cwd=工作目录）或 `thread/resume`（续上次）→ `turn/start`（B 档 prompt 作为 text input）→ 收 `item/*` 通知 → `turn/completed` → 关进程 |
| 会话恢复 | **一等公民**：sessionId = `thread_id`，`thread/resume` 原生支持 ⇒ `sessionState: 'stateful'`（相对 CLI 形式的最大收益：返工、聊天都能接着上次会话） |
| 沙箱 | ⚠️ **2026-10-18 修正**：每线程原生 `sandbox: danger-full-access` + `approvalPolicy: never`——macOS 上 `workspace-write` 的 Seatbelt 忽略 `[sandbox_workspace_write] network_access`（openai/codex#10390，无修复版本），进程内连本地模型端点都出不去、turn 直接 502；`danger-full-access` 是 macOS 上唯一能联网的选项。任务隔离不靠它：平台进程级沙箱（sandbox-exec 包装）+ 第一句话引导层 |
| 技能注入 | **机制不变**：写 `<workdir>/.codex/skills/<slug>/SKILL.md`（codex 项目作用域，thread cwd=workdir 时自动发现） |
| 协议 | `RuntimeProtocol` 已有的 **`'jsonrpc'`** 首次启用；`family: 'codex-app-server-jsonrpc'`（新值） |
| 轮次上限 | app-server 没有 turn 上限 ⇒ `maxTurns` 无法执行；因 `managedFlags` 对 service 不适用（cli-only，可选化），**不再需要** v1 的 `maxTurns: string\|null` 扩展 |
| 描述符契约 | 加 `kind: 'cli' \| 'service'`（默认 `'cli'`），cli 形状字段（managedFlags / blockedArgs / promptDelivery / resume.flag）对 service **不填**、按 kind 校验 |
| 证据等级 | ✅ **`verified`**（0.144.0-alpha.4 与 0.157.1 实测，§7 清单逐条核对；残余未验证项见 `unverifiedFields()`） |

**相比 v1（CLI 形式）省掉的两个契约缺口**：

| v1 的缺口 | v1 方案 | v2（app-server）为什么不需要 |
|---|---|---|
| `managedFlags.maxTurns` 必填字符串但 codex 无此旗标 | 放宽为 `string \| null` | `managedFlags` 是 cli-only 字段，service 不填 ⇒ 无此问题；"无 turn 上限"由适配器事实表声明 |
| prompt 投递有 argv 长度上限 | 加 `'stdin-text'` | prompt 走 JSON-RPC `input` 参数，无长度问题 |

**必须新引入的契约点**：`kind` 判别（§3）。

---

## 1. 为什么 app-server 而不是 `codex exec`

| 维度 | `codex exec`（v1，已作废） | app-server（v2，本设计） |
|---|---|---|
| 交互 | spawn 一次性子进程，argv/stdin 喂 prompt | 长连接 JSON-RPC 2.0（stdio JSONL），双向 |
| 会话恢复 | 子命令形状（`exec resume <id>`）与描述表旗标形状对不上，v1 只能放弃 | `thread/resume` 一等公民 ⇒ `stateful`，返工/聊天接着上次会话 |
| 终止检测 | 要自己从 JSONL 里认 `turn.completed` | 协议通知 `turn/completed`（status: completed/interrupted/failed） |
| 错误 | 退出码 + stderr 尾巴 | 结构化 `TurnError`（`codexErrorInfo`：Unauthorized / UsageLimitExceeded / ContextWindowExceeded / …） |
| 审批 | `-c approval_policy=never`（配置覆盖，[未验证] 是否零批准） | `thread/start.approvalPolicy: "never"`（每线程参数，协议级） |
| 沙箱 | `--sandbox workspace-write`（CLI 旗标） | 每线程 `sandbox` / `turn/start.sandboxPolicy`（含 `writableRoots`） |
| 模型 | `-m <model>`（受管旗标） | `thread/start.model`（RPC 参数）；`model/list` 可查可用模型 |
| prompt 长度 | argv 单参数上限（Linux ~128KB）风险 | RPC `input` 无此限制 |
| 用量 | 事件里 usage 字段（无 cost） | `thread/tokenUsage/updated` 通知（无 cost） |
| 技能 | 依赖 CLI 自己扫 `.codex/skills` | 同一发现机制 + `skills/list`（`perCwdExtraUserRoots`）可选 API 注入 |

一句话：**exec 把 codex 当"命令"，app-server 把 codex 当"服务"**——后者让会话、
审批、沙箱、错误都变成协议里的一等概念，更贴合本项目"差异集中到表、调用点不感知"的取向。

---

## 2. App Server 事实核查（协议级）

### 2.1 启动

```
codex app-server                 # 默认 --listen stdio://（JSONL，新行分隔的 JSON-RPC 2.0）
codex app-server --listen unix://PATH
codex app-server --listen ws://IP:PORT    # 实验性，官方注明不用于生产
codex app-server --stdio        # 等价于 --listen stdio://
codex app-server generate-ts --out DIR    # 生成协议 schema（可作我们解析器的对照物）
```

- 分析遥测默认**关**（`--analytics-default-enabled` 才开）——我们不传它。
- 线程持久化为磁盘上的 rollout 文件（`Thread.path` 字段非 null）⇒ **跨 server 重启可 `thread/resume`**——per-run 进程模型下恢复依然成立。
- 背压：入站饱和时 JSON-RPC 错误码 `-32001`「Server overloaded; retry later.」⇒ 可重试。
- 凭据用 codex 自己的 `~/.codex/auth.json` / keyring / `OPENAI_API_KEY`，平台不注入 env。

### 2.2 握手（initialize）

```
→ {"id":0, "method":"initialize", "params":{"clientInfo":{"name":"agentdeck","title":"agentdeck","version":"0.0.0"}}}
← {"id":0, "result":{"userAgent":"codex/..."}}
→ {"method":"initialized"}          # 客户端确认通知
```

- 每个连接必须先 initialize，否则报「Not initialized」；重复 initialize 报「Already initialized」。
- `clientInfo.name` 用于 OpenAI 合规日志（enterprise 需登记已知客户端——本项目是个人自托管，填 `agentdeck` 即可）。
- `capabilities.experimentalApi` 默认 false ⇒ **只用稳定面**（本设计用到的 thread/turn/item 全是稳定 API）。
- `capabilities.optOutNotificationMethods`：不设（我们要全部通知）。

### 2.3 核心原语与参数（camelCase，字段名以 v2 协议源码为准）

**`thread/start`**（新会话）：

| 参数 | 我们的取值 | 依据 |
|---|---|---|
| `model` | agent 配置的模型 | — |
| `cwd` | 工作目录 | 每个线程自己的工作目录 |
| `approvalPolicy` | `"never"` | 无人值守（取值：never/untrusted/on-request/on-failure/reject） |
| `sandbox` | `"danger-full-access"` | ⚠️ macOS 修正（2026-10-18）：`workspace-write` 断网（#10390），见上表「沙箱」行（取值：read-only/workspace-write/danger-full-access） |
| `ephemeral` | `false`（缺省） | 线程要落盘才能 resume |

响应：`{thread:{id:"thr_…",…}, model, modelProvider, cwd, approvalPolicy, sandbox}` ——
**`response.model` 就是实际激活的模型**，留作 `AgentResult.model`（审计要"CLI 报告的"）。

**`thread/resume`**：参数 `threadId`。续上次会话（返回 thread + 历史 items）。
不存在的 thread ⇒ JSON-RPC error（实测一律 `-32600`，三种形态见 §7 第 5 条）⇒ 可判"恢复被拒"（`rejectDetectable=true`）。

**`turn/start`**（发一轮）：

| 参数 | 我们的取值 |
|---|---|
| `threadId` | 本 run 的线程 |
| `input` | `[{type:"text", text: <B 档三块合成的一段>}]`（如需技能：可追加 `{type:"skill",name,path}` 条目，v1 不追加，靠发现） |
| `cwd` | 工作目录（可选，thread 已带） |
| `approvalPolicy` / `sandboxPolicy` / `model` / `effort` | 覆盖项，v1 除 model 外不传（thread 级已定） |

响应：`{turn:{id, status:"inProgress", items:[], error:null}}`。

**`turn/interrupt`**（取消）：参数 `threadId` + `turnId` ⇒ 服务端发 `turn/completed`（status: interrupted）。

**`turn/steer`**：给活动 turn 追加输入。**v1 不用**（反馈/返工走"新 run + thread/resume"）。

### 2.4 通知流（run 期间）

| 通知 | 载荷 | 我们怎么用 |
|---|---|---|
| `turn/started` | `{threadId, turn:{…status:inProgress}}` | 忽略/日志 |
| `item/started` | `{threadId, turnId, item:{type,…}}` | 建条目上下文 |
| `item/agentMessage/delta` | `{threadId, turnId, itemId, delta}` | 累积该 item 文本 |
| `item/reasoning/summaryTextDelta` | `{…, summaryIndex, delta}` | 累积 → `thinking` |
| `item/commandExecution/outputDelta` | `{…, delta}` | 累积命令输出 → 工具输出流 |
| `item/completed` | `{threadId, turnId, item:{type,…最终形态}}` | **权威条目**：agentMessage → `text`（finalText 更新）；commandExecution → `tool_result`；fileChange → `tool_result`（聚合）；… |
| `turn/completed` | `{threadId, turn:{status: completed\|interrupted\|failed, error}}` | **终止事件**：判定成功/失败/中断 |
| `thread/tokenUsage/updated` | `{threadId, usage:{netNewInputTokens, cachedInputTokens, inputTokens, outputTokens, totalTokens, …}}` | 累积 → `TokenUsage`（无 cost ⇒ estimated） |
| `error` | `{error: TurnError, willRetry, threadId, turnId}` | 失败信号（`willRetry:true` 时不中断） |
| `thread/status/changed` | `{threadId, status:{type:active,…}}` | 活性判定辅助 |

**条目类型**（`item.type`，camelCase）：`userMessage` / `agentMessage` / `reasoning` /
`commandExecution` / `fileChange` / `mcpToolCall` / `dynamicToolCall` / `webSearch` /
`plan`（experimental）/ `imageView` / `enteredReviewMode` / `exitedReviewMode` /
`contextCompaction` / `error`。

### 2.5 审批（server → client 的 JSON-RPC **请求**，必须回应）

```
← {"id":101, "method":"item/commandExecution/requestApproval", "params":{…}}
→ {"id":101, "result":{"decision":"decline"}}     # 或 accept
← {"method":"serverRequest/resolved", "params":{…}}
```

- ✅ 实测（0.144.0-alpha.4）：新线程全程**无审批请求**。⚠️ 但**恢复的线程 policy 会退回 `on-request`** ⇒ 后端 `turn/start` 也显式传 `never`（§7 第 2 条）。
- **防御性策略**：出现了就回 `decline` + 在 run 日志里**大声说明**（"收到审批请求但本 run 是无人值守策略——已拒绝，请检查为什么 never 没生效"）。不回应的后果是 turn 挂死等我们——那正是最糟的静默形态。

### 2.6 错误分类（TurnError）

```
{ message: string, codexErrorInfo: "ContextWindowExceeded" | "UsageLimitExceeded"
 | "HttpConnectionFailed" | "ResponseStreamDisconnected" | "Unauthorized"
 | "BadRequest" | "InternalServerError" | "Other", additionalDetails?: string }
```

### 2.7 技能（两条注入路）

| 路 | 做法 | v1 |
|---|---|---|
| A. 项目作用域 | 写 `<workdir>/.codex/skills/<slug>/SKILL.md`，thread cwd=workdir 时 codex 自动发现（官方 Skills 文档：Project scope = `{cwd}/.codex/skills/`） | ✅ **推荐**——与 claude/generic 的注入机制完全一致，零新机制 |
| B. API 注入 | `skills/list` 带 `perCwdExtraUserRoots`（为指定 cwd 注册额外 user 作用域技能根） | 后续（需验证 + 新机制） |

### 2.8 已知没有的东西

- **没有 turn 上限**：`thread/start`、`turn/start`、配置参考里都没有轮次上限字段 ⇒
  `maxTurns` 无法执行；超时靠平台自己的 idle watchdog / run 超时。
- 事件/响应里**没有 model 字段**（模型只出现在 `thread/start` 响应与 `model/rerouted` 通知）。

---

## 3. 契约设计：`RuntimeDescriptor` 加 `kind`

### 3.1 为什么必须加

现有描述表是 **CLI 形状**：`baseArgs` / `managedFlags`（旗标名）/ `blockedArgs` /
`promptDelivery` / `resume.flag`。app-server 是 **service 形状**：run 的行为是 JSON-RPC
参数，不是命令行。两个选择：

| 方案 | 做法 | 评价 |
|---|---|---|
| A. 全部字段保留、codex 行填"占位值" | cli 字段照填、适配器不读 | ❌ 违反"evidence 写在数据里"：占位值就是撒谎，没人能分辨"没用"与"不存在" |
| B. **加 `kind` 判别，cli 字段可选化**（本设计） | `kind: 'cli' \| 'service'`（默认 `'cli'`）；cli-only 字段对 service 不填；`loadRuntimeDescriptor` 按 kind 校验 | ✅ 差异显式、可评审、可测试 |

### 3.2 字段适用性表

| 字段 | claude / generic（cli） | codex（service） | 说明 |
|---|---|---|---|
| `key` / `command` | 是 | 是 | `command: 'codex'`（探测与审计用） |
| `family` | `claude-stream-json` / `generic-ndjson` | `codex-app-server-jsonrpc`（新） | 解析器选择器 |
| `protocol` | `stream-json` | **`jsonrpc`**（枚举里本来就有，首次启用） | 后端属性 |
| `evidence` / `evidenceNote` | 是 | **`verified`** + §7 核对结论 | — |
| `sessionState` | 是 | **`stateful`** | thread/resume 一等公民 |
| `versions` | 是 | `{range:'>=0.144.0-alpha.4 <0.158.0', verifiedWith:['0.144.0-alpha.4','0.157.1'], onMismatch:'warn'}`（实测） | — |
| `stateDir` | 是 | `.codex` | 沙箱放行 / 环境预检 |
| `skills` | 是 | `{kind:'directory', dir:'.codex/skills'}` | 注入机制不变 |
| `systemPrompt` | 是 | `null` | ⇒ B 档（三块合成一段） |
| `baseArgs` | CLI 基础参数 | `['app-server', '--stdio']`（**launch 参数**） | 语义从"run 参数"变"启动参数"，适配器解释 |
| `managedFlags` | 必填（旗标名） | **不填**（可选化） | model 走 `thread/start.model`；无 maxTurns 旗标 |
| `blockedArgs` | 必填（禁改表） | **不填**（可选化） | service 无 run 级 argv 可过滤；`customArgs` 在**校验期拒绝**（§3.4） |
| `promptDelivery` | `stdin-ndjson` / `argv` | **不填**（可选化） | prompt 走 RPC `input` |
| `resume` | `{flag, rejectDetectable}` | **不填**（可选化） | 恢复走 `thread/resume`；`rejectDetectable=true`（-32600 实测，§5.4/§7 第 5 条） |
| `toolConfig` / `disableSwitch` | disabled + reason | 同左（service 下为 MCP/技能禁用预留，未验证） | — |

### 3.3 `loadRuntimeDescriptor` 按 kind 校验

- `kind: 'cli'`：现有一切校验不变（managedFlags 三件套必填、resume 对齐）。
- `kind: 'service'`：要求 `command`、`launchArgs`（= `baseArgs` 语义）非空；
  cli-only 字段**缺省即合法**；`systemPrompt === null` 时 B 档照常。

### 3.4 `customArgs` 对 service runtime 的处置（已拍板：适配器级不静默）

`customArgs` 是 `ExecOptions` 里预留的"使用者自定义 CLI 参数"通道：CLI 后端把它拼进
argv 第 3 段（过禁改表过滤）。**它今天没有任何写入入口**——daemon 执行器不传它
（`executor.ts` 的 `backend.execute()` 调用里没有 `customArgs`）、`Agent` 实体没有该字段、
界面没有入口。它是纯扩展位。

对 service runtime 它没有语义（没有 run 级 argv 可注入）。已拍板的处置：

1. `packages/agent-core/src/backend.ts` 的 `ExecOptions.customArgs` 注释补一句：
   "service 形态的 runtime（如 codex app-server）不消费此通道——run 参数走协议，无 argv"；
2. `CodexBackend.execute()` 收到非空 `customArgs` 时记警告
   （"runtime codex 是 service 形态，自定义 CLI 参数进不了任何地方"）——与
   "收到 `maxTurns` 但该 runtime 无上限"用**同一个不静默的出口**；
3. **不在 daemon 加校验**：为一个没有写入入口的字段加防御是空转。
   将来若给 `customArgs` 接上真实入口（agent 配置/界面），**那时**在写入口拒绝 service runtime，
   并把这一条写进 `unverifiedFields()` 的备注（防止"以后再说"消失）。

---

## 4. 进程模型：per-run（已定）vs 共享长驻（后续）

| | A. **per-run app-server（v1 推荐）** | B. 共享长驻 server |
|---|---|---|
| 形态 | 每次 `execute()` spawn 一个 `codex app-server --listen stdio://`，run 结束 terminate | daemon 起一个常驻 app-server，所有 codex run 复用，多线程多路复用 |
| 与现有 `AgentBackend` 契约 | **完全贴合**：execute 拥有整个进程生命周期（同 claude/generic） | 需要新的共享服务生命周期（启动时机、崩溃重启、断线重连、-32001 背压重试） |
| 平台沙箱（`--sandbox workdir-write`） | ✅ 能包住整个 per-run 进程 | ❌ 包不住共享进程（只能靠 codex 每线程 sandbox） |
| 故障隔离 | ✅ 一个 run 崩不影响别的 | ⚠️ server 崩 = 所有 codex run 一起断 |
| 审计/进程归属 | ✅ 一条 run 一个进程，argv 干净 | 多 run 共享一个 argv，靠 thread_id 区分 |
| 启动成本 | +一次 app-server 启动（~数百 ms，相对分钟级 run 可忽略） | 无 |
| 会话恢复 | ✅ 线程落盘，新 server 也能 `thread/resume` | ✅ 同左 |
| 演进 | 若成本成问题 → 平滑升级到 B | — |

**结论**：v1 用 **per-run**。共享长驻（B）作为后续优化项写进 §8，**不**在首版实现——
它引入的生命周期复杂度（崩溃恢复、断线重连、多 run 归属）远超省下的启动时间。

---

## 5. 适配器包：`packages/agent-codex/`

```
packages/agent-codex/src/
├── index.ts                 // 导出
├── codex-descriptor.ts      // 描述符（kind:'service'）+ CodexServerFacts + unverifiedFields()
├── jsonrpc-transport.ts     // stdio JSONL 帧层（纯协议，可单测）
├── codex-backend.ts         // CodexBackend implements AgentBackend（进程 + run 时序）
├── stream-parser.ts         // 通知 → AgentMessage + 失败分级
├── jsonrpc-transport.test.ts
├── stream-parser.test.ts    // 用 §2 的协议形状做 fixture
├── codex-backend.test.ts    // fake codex app-server（可执行文件，NFR-T-01）
└── testing/                 // fake-app-server 助手
```

### 5.1 `jsonrpc-transport.ts`（帧层）

- 读写子进程 stdio，新行分隔 JSON；请求带 `id`，通知/响应按 `id` 路由。
- `request(method, params): Promise<result>`：发请求 → 等 id 匹配的响应；`-32001` ⇒ 指数退避重试（文档化的可重试错误）。
- 服务器主动发的**请求**（审批）：挂一个 `onServerRequest` 处理器（§2.5 的 decline 逻辑）。
- 通知（无 id）：`onNotification(method, params)` 回调 → 喂给 parser。
- 解析失败的裸行：计数 + 告警（宽容读取，明确失败，§5.3）。

### 5.2 `codex-backend.ts`（run 时序）

```
execute(opts):
  1. probeCommand('codex') → 可执行文件；describeMissingCommand 预检
  2. planSandbox(…, extraWritableDirs: [...cliStateDir(descriptor)])   // ~/.codex 放行
  3. spawn: [codex, 'app-server', '--stdio']  （onCommandLine 如实上报 + sandboxDescription）
  4. initialize 握手（clientInfo: agentdeck）→ initialized
  5. resumeSessionId ? thread/resume(id) : thread/start({model, cwd, approvalPolicy:'never', sandbox:'danger-full-access'})
       → sessionId = thread.id；model = response.model（AgentResult.model 用这个）
  6. turn/start({threadId, input:[{type:'text', text: opts.prompt}]})   // prompt 已是 B 档三段
  7. 通知流 → stream-parser → queue（messages）
  8. turn/completed(status)：
       completed → ok；failed → agent_error（TurnError）；interrupted（非我们取消）→ agent_error
  9. cancel()：turn/interrupt(threadId, turnId) → 等 2s → terminate 进程树
  10. 退出：classifyCodexFailure → AgentResult（usage 取自 thread/tokenUsage/updated；resumeRejected 见 §5.4）
```

> 系统提示：`descriptor.systemPrompt === null` ⇒ daemon 自动选 B 档，prompt 已是三块合成的一段，
> 这里**原样**放进 `text` input。①② 两块的"规则与身份"因此随每轮走，恢复后仍在（app-server 下
> B 档没有 claude 那种"系统提示活不过 resume"的坑——它就是用户消息的一部分）。

### 5.3 `stream-parser.ts`（通知 → AgentMessage + 失败分级）

| 通知 / 载荷 | → AgentMessage |
|---|---|
| `item/completed` 且 `item.type='agentMessage'` | `text`（累积 deltas 的最终文本；更新 `#finalText`） |
| `item/completed` 且 `item.type='reasoning'` | `thinking`（摘要拼接） |
| `item/started` 且 `type='commandExecution'` | `tool_use`（tool=command，content=命令） |
| `item/commandExecution/outputDelta` | 累积（供 `tool_result` 用） |
| `item/completed` 且 `type='commandExecution'` | `tool_result`（含 `status: completed/failed/declined` 的判定；failed/declined 追加 `error` 形态消息） |
| `item/completed` 且 `type='fileChange'` | `tool_result`（聚合："文件变更：+N/-M/U"） |
| `item/completed` 且 `type='mcpToolCall'` / `dynamicToolCall` | `tool_use` + `tool_result`（failed 标 error） |
| `item/completed` 且 `type='webSearch'` | `tool_result` |
| `item/completed` 且 `type='error'` | `error`（非致命） |
| 其余类型（plan/imageView/reviewMode/contextCompaction/userMessage…） | `log` 或忽略 |
| `thread/tokenUsage/updated` | 累积 `#usage`（→ `TokenUsage{costUsdMicros:0, costSource:'estimated'}`） |
| `turn/completed`（status: completed） | `#resultSeen=true`、`#terminalOk=true` |
| `turn/completed`（status: failed） | `#resultSeen=true`、`#isError=true`、记 `TurnError` |
| `turn/completed`（status: interrupted） | `#resultSeen=true`、未请求中断则 `#isError=true` |
| `error` 通知 | `#isError=true`、记 errorText（`willRetry:true` 时不置死） |
| 裸行 / 未知通知方法 | 计数 `unparsableLines` + 显式告警 log |

**失败分级**（`classifyCodexFailure`，与 generic 同一套纪律）：

```ts
type CodexFailure = 'cli_unparsable_output' | 'agent_error' | null
// 1. recognizedEvents === 0                  → cli_unparsable_output
// 2. !resultSeen（进程退出但没等到 turn/completed）→ cli_unparsable_output
// 3. parserIsError（TurnError / JSON-RPC error / 意外 interrupted）→ agent_error
// 4. 进程非零退出                              → agent_error
// 5. 否则                                     → null
```

### 5.4 恢复被拒（`resumeRejected`）

✅ **已实测（0.144.0-alpha.4）**：`thread/resume` 对不存在的线程一律回 JSON-RPC
error **`-32600`**（三种形态：`invalid session id` / `no rollout found for thread id …` /
`… is archived`）。检测模式写死为"任何 `JsonRpcServerError`"⇒ **`rejectDetectable: true`**。
被拒时后端**回退到新线程继续跑**并置 `resumeRejected: true`——与 claude 的语义一致
（FR-CLI-06：继续跑了但没有上文，要大声说，不能悄悄跑偏）；executor 据此发警告 +
`run.resume_rejected` 收件箱条目。`thread/resume` 成功 ⇒ `false`；没请求恢复 ⇒
`undefined`。

### 5.5 活性（`lastActivityAt`）

以最近一条通知（含 outputDelta）的时间戳为准；进程无输出时由 daemon 的 idle watchdog 兜底。

---

## 6. 描述符关键取值（`CODEX_DESCRIPTOR`）

```ts
{
  key: 'codex',
  kind: 'service',                       // ★ 新字段（claude/generic 为 'cli'，缺省）
  command: 'codex',
  family: 'codex-app-server-jsonrpc',    // ★ 新值
  protocol: 'jsonrpc',                   // ★ RuntimeProtocol 首次启用
  evidence: 'verified',                  // ✅ 0.144.0-alpha.4 与 0.157.1 实测（2026-09-27）
  evidenceNote: /* §7 核对结论 → 一段话 */,
  sessionState: 'stateful',              // thread/resume 一等公民（跨进程恢复已实测）
  versions: { range: '>=0.144.0-alpha.4 <0.158.0', verifiedWith: ['0.144.0-alpha.4', '0.157.1'], onMismatch: 'warn' },  // ✅ 实测
  stateDir: '.codex',
  skills: { kind: 'directory', dir: '.codex/skills' },   // ✅ 自动发现（需 YAML frontmatter）
  systemPrompt: null,                    // B 档
  baseArgs: ['app-server', '--stdio'],   // launch 参数（service 语义）
  toolConfig: { enabled: false, reason: '…' },     // 沿用 disabled + reason
  disableSwitch: { enabled: false, reason: '…' },  // 沿用
  // cli-only 字段（managedFlags / blockedArgs / promptDelivery / resume）→ 不填
}
```

---

## 7. 未验证项清单（`provisional → verified` 的核对单）

> 写进 `codex-descriptor.ts` 的 `unverifiedFields()`（数据，不是注释），测试断言它存在。
>
> **核对状态（2026-09-27）**：真实 app-server **0.144.0-alpha.4 与 0.157.1**（本机 local 模型
> 端点 127.0.0.1:8080，隔离 `CODEX_HOME` 探针，原始帧见
> `.cache/codex-e2e/frames-*.jsonl`）。核心形状全部对上，`evidence` 升 `verified`；
> 核对过程中发现的**实测与文档差异**记录在第 1 条下方，并已修进解析器/后端。

| # | 待核对项 | 怎么核对 | 结果（0.144.0-alpha.4 实测） |
|---|---|---|---|
| 1 | 真实 `codex app-server` 的 stdio 帧与 §2 的形状（字段名、通知名、item 类型） | 起 server 手动发 initialize/thread/start/turn/start 对照 | ✅ 全对上，但 **3 处字段名与文档/源码假设不同**（见下方差异清单） |
| 2 | `thread/start` 的 `approvalPolicy:'never'` + `sandbox:'workspace-write'` 在真实 server 上的行为 | 跑一个会改文件、会跑命令的 prompt | ✅ 新线程全程**无审批请求**；sandbox 生效（工作目录外写入被拒："writing outside of the project"）。⚠️ **恢复的线程 approvalPolicy 会退回 `on-request`** ⇒ 后端 turn/start 也显式传 `never` |
| 3 | 非 git 工作目录（无 `.git`）下 app-server 会不会触发 trust 提示 / 挂起 | 真实跑一次 | ⚠️ 探针工作目录均新建、无 `.git`，全程无 trust 提示、无挂起（0.144.0-alpha.4 在 app-server 形态下不按 git/trust 提示） |
| 4 | 项目技能：`<workdir>/.codex/skills/<slug>/SKILL.md` 是否真被 thread 自动发现 | 挂一个 skill 真实跑一次 | ✅ 自动发现（`skills/list` 返回 user/system 作用域；项目技能被尝试加载）。⚠️ **必须带 YAML frontmatter**（`---` 分隔）否则报 `missing YAML frontmatter`——`writeSkill` 注入时总会写，兼容 |
| 5 | `thread/resume` 的实参形状 + 不存在的 thread 的错误形状（rejectDetectable 依据） | 跑两次（第一次留 thread_id）+ 恢复假 id | ✅ 跨进程恢复成功（rollout 落盘，`sessionState:'stateful'` 实锤）；不存在的线程一律回 JSON-RPC error **`-32600`**（三种形态：invalid session id / no rollout found / is archived）⇒ **`rejectDetectable=true`**；被拒时后端回退新线程 + `resumeRejected=true` |
| 6 | `thread/tokenUsage/updated` 的实际载荷字段 | 跑一次看通知 | ✅ 用量在 `params.tokenUsage.total.{inputTokens,outputTokens,…}`（**不是** `params.usage`）——解析器已修 |
| 7 | `turn/completed` 语义：一次 `turn/start` 是否可能产生多个 turn；interrupted 的实际触发路径 | 真实跑 + 取消各一次 | ✅ 一次 turn/start 一个 turn；`turn/interrupt {threadId,turnId}` → 响应 `{}` → `turn/completed(status:'interrupted')`。failed 分支的 TurnError 形状仍未实测触发 |
| 8 | 实测版本号 → 填 `versions.verifiedWith` + 收窄 `range` | 按 `--verify-runtime codex` 指引 | ✅ `verifiedWith: ['0.144.0-alpha.4']`，`range: '>=0.144.0-alpha.4 <0.145.0'`，`onMismatch:'warn'` |
| 9 | `-32001` 背压是否真的返回该码（重试逻辑依据） | 压测或查日志 | ⚠️ 未实测触发（本机无并发压力）；按源码/文档保留，仍在 `unverifiedFields()` |

**实测与文档差异（已修进实现）**：

| 项 | 文档/源码假设（旧） | 实测（0.144.0-alpha.4） |
|---|---|---|
| agentMessage 权威文本 | `item.agentMessage.content` | **`item.text`**（顶层字段） |
| reasoning 摘要 | `item.reasoning.summary`（字符串） | **`item.summary`（字符串数组）** |
| fileChange | `item.fileChange.{path,changeType}` | **`item.changes: [{path, kind:{type}, diff}]`** + `item.status`（failed 发 error 消息） |
| tokenUsage | `params.usage` | **`params.tokenUsage.total`** |
| 新通知 | 无 | **`item/reasoning/summaryPartAdded`**（新段落标记帧，无文本，忽略） |
| turn/start 参数 | 只需 threadId + input | **必须带 `approvalPolicy:'never'`**（恢复线程政策退回 on-request） |
| resume 拒绝 | 形状未知 | 一律 **`-32600`**（rejectDetectable 依据） |
| 技能发现 | 假设自动扫 | 自动扫 ✅，但**要求 YAML frontmatter** |

**0.157.1 复核（2026-09-27，用户把助手切到 codex 后暴露）**：

> 用户 10:29 装了 npm 通道 `@openai/codex`（`/opt/homebrew/bin/codex` = **0.157.1**），
> daemon 实际用它跑（插件二进制 0.144.0-alpha.4 不在 PATH）。第一次真实跑发现
> **命令的 tool_use / tool_result 全是空的**——工具类 item 的形状变了（我们只在
> 0.144.0-alpha.4 上验证过非工具形状）。用探针强制触发 shell 与 MCP 工具抓帧复核：

| # | 待核对项（0.157.1） | 结果 |
|---|---|---|
| A | `commandExecution` item 形状 | **扁平**：`item.command` / `item.status` / `item.aggregatedOutput` / `item.exitCode` / `item.cwd` / `item.commandActions[]`（**不是** `item.commandExecution.{command,status,output}`） |
| B | `commandExecution` 输出怎么送达 | **没有 `item/commandExecution/outputDelta` 通知**——输出只在 `item/completed` 的 `aggregatedOutput` 里（旧累积路径保留作降级） |
| C | `mcpToolCall` item 形状 | **扁平**：`item.server` / `item.tool` / `item.arguments` / `item.status` / `item.result.content:[{type:'text',text}]` / `item.error`（**不是** `item.mcpToolCall.{toolName,input}`） |
| D | `fileChange` item 形状 | 与 0.144.0-alpha.4 **一致**：`item.changes:[{path, kind:{type}, diff}]` + `item.status`（无需改） |
| E | `agentMessage` / `tokenUsage` / `turn/completed` | 与 0.144.0-alpha.4 **一致**（`item.text` / `tokenUsage.total` / `turn.completed`；`turn.completed` 还带 `itemsView:'summary'` 的 items 数组，宽容忽略） |
| F | `thread/start.sandbox` 合法枚举 | 实测：`read-only` \| `workspace-write` \| `danger-full-access`（`'none'` 被拒：`unknown variant`） |
| G | 版本判定 | `verifiedWith: ['0.144.0-alpha.4','0.157.1']`，`range: '>=0.144.0-alpha.4 <0.158.0'`；`--verify-runtime codex` 对 0.157.1 判 **verified** |

> 解析器已按扁平形状重读（旧嵌套形状保留为防御降级），fake 的 ok 剧本、单测同步更新。
> `unverifiedFields()` 只剩 4 条：`command`（PATH 探测）、dynamicToolCall/webSearch
> 形状（本机模型未触发）、failed turn 的 TurnError、`-32001`。

---

## 8. 后续扩展（v1 不做，但标好坑）

| 扩展 | 为什么 v1 不做 | 将来怎么做 |
|---|---|---|
| **共享长驻 app-server** | 生命周期复杂度（崩溃/断线/归属）远超省下的启动时间 | daemon 级服务管理：懒启动 → 心跳/重启 → 多 run 按 threadId 多路复用；平台沙箱语义改为"靠 codex 每线程 sandbox"并写入审计 |
| **技能 API 注入**（`skills/list.perCwdExtraUserRoots`） | 现有 workdir 注入已够 | 验证发现机制后作为更干净的替代（不往 agent 工作目录写文件） |
| **`model/list` 接入界面** | agent 配置里手填模型，错误由 TurnError(BadRequest) 显式报出 | identity 接口暴露可用模型，编辑表单下拉选择 |
| **turn 上限** | codex 没有该概念 | 平台级 maxTurns 无法执行时，以 run 超时 + idle watchdog 为界；若将来 codex 加 turn budget 再接入 |
| **`turn/steer`** | 反馈/返工走"新 run + thread/resume"，不需要中途追加 | 若做"同一 run 内连续追问"再启用 |

---

## 9. 影响面（要动的文件 vs 不用动的）

### 9.1 要动的

| 文件 | 改动 |
|---|---|
| `packages/agent-core/src/runtime-table.ts` | `kind: 'cli' \| 'service'`；cli-only 字段（managedFlags/blockedArgs/promptDelivery/resume）可选化；`family` 加 `'codex-app-server-jsonrpc'`；`CODEX_DESCRIPTOR` 表行 |
| `packages/agent-core/src/runtime-table.ts`（`loadRuntimeDescriptor`） | 按 kind 校验 |
| `packages/agent-core/src/argv.ts` | 仅 cli 路径的小窄化（`runtime.baseArgs ?? []` 等，因字段可选） |
| `packages/agent-core/src/backend.ts` | `ExecOptions.customArgs` 注释补 service 形态说明（§3.4）；`ExecOptions` 注释补一句 service 形态 |
| `packages/agent-codex/`（新包） | §5 全部 |
| `apps/daemon/src/runtime-registry.ts` | 装配表加 `codex` 一行 |
| `apps/daemon/package.json` | 加 `@agentdeck/agent-codex` 依赖 |
| `apps/daemon/src/agents-create.test.ts` 等 | （无 customArgs 相关改动——见 §3.4，该字段无写入入口） |

### 9.2 不用动的（以及为什么）

| 文件 | 为什么 |
|---|---|
| `apps/daemon/src/executor.ts` | 恢复与否看 `descriptor.sessionState`（`'stateful'` 走恢复路径，已有）；maxTurns 只是透传（service 下适配器警告）；`deliveryModeFor` 见 `systemPrompt:null` 自动 B 档 |
| `packages/agent-core/src/skill-injection.ts` | 读 `descriptor.skills.dir`，`'.codex/skills'` 直接可用 |
| `packages/agent-core/src/sandbox.ts` | `cliStateDir()` 读 `stateDir`，`~/.codex` 自动放行 |
| `packages/agent-core/src/first-sentence.ts` | B 档合成与投递档判定不用改 |
| `apps/daemon/src/verify-runtime.ts` | 枚举装配表，自动覆盖 |
| `apps/web/*`、`packages/i18n/*` | runtime 选项与"未验证"提示数据驱动，无 runtime 名分支 |
| `apps/daemon/src/review.ts` 等审核链路 | 判决走输出文本围栏提取，与传输形式无关 |

---

## 10. 测试计划

| 层 | 用例 | 守什么 |
|---|---|---|
| `jsonrpc-transport.test.ts` | 请求/响应 id 路由、通知分发、server 主动请求回调、`-32001` 退避、坏帧计数（用真实协议帧 fixture） | 帧层正确性 |
| `stream-parser.test.ts` | §2 每种通知/条目类型的映射；`classifyCodexFailure` 判据 | 解析与失败分级 |
| `codex-backend.test.ts` | **fake codex app-server**（测试目录里一个可执行文件，按 §2 协议回帧）：跑通"spawn → 握手 → thread/start → turn/start → 通知 → turn/completed → 结果"整条链；cancel → interrupt；resume → thread/resume（NFR-T-01：不调真实 CLI） | 后端流程 |
| `apps/daemon` | `runtime-registry.test.ts`（键一一对应自动覆盖）；`runtime-agnostic.test.ts` 的"整条 daemon 跑在 codex 上"用例（注入假 service 后端）✅ | 装配完整、无 claude/generic 写死 |
| 手动 | `pnpm run daemon --verify-runtime codex` | §7 清单（✅ 已跑：0.144.0-alpha.4 与 0.157.1，均判 verified，无额外动作） |

---

## 11. 实施步骤（建议顺序）

1. ✅ **契约扩展**（纯 `agent-core`，先落地先测）：`kind` 判别 + cli-only 字段可选化 +
   `family` 新值 + `loadRuntimeDescriptor` 按 kind 校验 + `CODEX_DESCRIPTOR` 表行；补/改测试。
2. ✅ **`agent-codex` 包**：`jsonrpc-transport` → `stream-parser` → `codex-backend` →
   fake app-server 测试（全部不调真实 CLI）。
3. ✅ **装配**：`runtime-registry.ts` 一行、`apps/daemon/package.json` 依赖、`pnpm install`。
4. ✅ **customArgs 对 service**：按 §12.3 的已定决策——**适配器级不静默**（警告 + `ExecOptions`
   契约注释），不在 daemon 加校验（今天没有写入口，无从校验）；警告路径有测试守着。
5. ✅ **跑通**：`pnpm run check` 全绿（typecheck + 1571 条测试）。
   ⏳ `--verify-runtime codex` 探测——本机真实 `codex` 不在 PATH（二进制在
   `~/.codex/plugins/.plugin-appserver/codex`，0.144.0-alpha.4；10:29 起 npm 通道 `/opt/homebrew/bin/codex` 0.157.1 进 PATH，daemon 自动改用之），可用
   `--executable` 指定后跑（命令已能枚举 codex）。
6. ✅ **真实端到端 + 升 verified**（2026-09-27，本机 local 模型端点，无外部额度）：
   按 §7 清单逐条核对，删 `unverifiedFields()` 条目（15 → 4）、填
   `verifiedWith: ['0.144.0-alpha.4', '0.157.1']`、收窄 `range`、`evidence: 'verified'`、
   `rejectDetectable` 升 `true`；实测与文档的差异（item.text / summary[] /
   changes[] / tokenUsage.total / summaryPartAdded / turn/start 补 never）已修进
   解析器与后端。
7. ✅ **文档同步**：`docs/README.md` 文档地图与约定 #8、`../design/architecture.md` §6.2、
   `../design/design.md` §9.1 与包结构、`runtime-framework.md` 已更新；根 `README.md` 无 runtime
   清单，无需改。

---

## 12. 待决问题 → 已定（2026-03 五问五答，见 §0.1）

1. **进程模型**：✅ **per-run**（每次 run 起一个 app-server，run 完 terminate）。
2. **`kind: 'cli' | 'service'` 契约扩展**：✅ 接受。
3. **`customArgs` 对 service runtime**：✅ 适配器级不静默（警告 + 契约注释），不提前在 daemon 加校验（§3.4）。
4. **技能注入**：✅ 写工作目录 `.codex/skills`（机制不变）。
5. **审批防御**：✅ `approvalPolicy:'never'` 下仍收到审批请求 ⇒ 回 `decline` + 大声日志。

设计已定稿。实施顺序见 §11。
