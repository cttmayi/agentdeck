# Runtime 适配框架：claude 与 codex 如何公用同一套骨架

> 回答一个问题：**两个 runtime 公用什么、各自独有什么**。
>
> 结论一句话：框架 = **一条公共契约**（`AgentBackend`）+ **一张公共数据表**
> （`RuntimeDescriptor`）+ **一台与 runtime 无关的机器**（daemon 里的执行 / 投递 /
> 注入 / 审计 / 界面路径）。claude 与 codex 都只是**同一个接口的一个实现**、
> **同一张表的一行**——daemon 的通用代码**不认识它们任何一个**。
>
> 本文的"公用"是**现状**：框架本体是真实代码（claude 与 generic 两个 runtime
> 已经实证它），codex 那一行与 `agent-codex` 包**已经落地实现并接入真实 codex**
> （设计见 `docs/runtime/codex-runtime-design.md`，v2，app-server 形式）——**证据等级
> `verified`**：协议形状已在真实 app-server **0.144.0-alpha.4 与 0.157.1** 上逐条实测核对
> （§7 清单，0.144.0-alpha.4 与 0.157.1 两个版本都实测过；残余未验证项见 `agent-codex` 的 `unverifiedFields()`，本机未触发的
> 工具类 item 等）。公共接口的代码**原样抄自源码**
> （只压缩注释），文件路径给出处，不带行号。

---

## 0. 总览：一个框架，两个插头

```
┌────────────────────────────── daemon（apps/daemon）──────────────────────────────┐
│                                                                                   │
│   executor ──按 agent.runtimeKey 解析──▶ runtime-registry（组合根）                 │
│        │                                          │                               │
│        │  backend.execute({prompt, workDir, …})   │ 装配：表行 ↔ 适配器包           │
│        ▼                                          ▼                                │
│   ┌─────────────────────────────────────────────────────────────┐                  │
│   │  AgentBackend 公共契约（packages/agent-core/src/backend.ts）  │                  │
│   │   probe() / execute() → AgentSession                          │                  │
│   └───────────┬─────────────────────────────────┬────────────────┘                  │
│               │                                 │                                    │
│   ┌───────────▼────────────┐      ┌─────────────▼─────────────┐                     │
│   │ agent-claude（CLI 形状） │      │ agent-codex（service 形状）✅│                     │
│   │  ClaudeBackend          │      │  CodexBackend             │                     │
│   │  spawn: claude -p …     │      │  spawn: codex app-server  │                     │
│   │  解析: stream-json      │      │  协议: JSON-RPC 2.0        │                     │
│   └───────────┬────────────┘      └─────────────┬─────────────┘                     │
│               │                                 │                                    │
│        ┌──────▼─────────────────────────────────▼──────┐                            │
│        │  描述表 runtime-table.ts：claude 一行 / codex 一行 │  ← 差异唯一落点（数据）   │
│        └─────────────────────────────────────────────────┘                            │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

依赖方向是**单向**的，这是"公用"能成立的根：

```
protocol ← domain ← agent-core ← { agent-claude, agent-codex } ← daemon
```

- `agent-core` 装的是**与具体 CLI 无关**的东西：公共契约 + 公共数据表 + 注入算法；
- 两个适配器包只做两件事：**实现 `AgentBackend`**、**解释描述表里自己那一行**；
- daemon 只认识契约与表——在它眼里 claude 和 codex **没有任何区别**。

一条贯穿全项目的规矩（FR-CLI-47）：**差异集中到表，调用点不感知**。
"加一个 runtime = 描述表一行 + 一个适配器包 + 装配表一行"，daemon 的通用代码一行不用改。

---

## 1. 公共契约一：`AgentBackend`（接口）

来源：`packages/agent-core/src/backend.ts`。**刻意只有一件事**：跑一个 prompt，
拿回流式结果。所有复杂度都被推到实现里——参数怎么拼、输出怎么解析、会话怎么恢复，
因为那些差异是上游 CLI 的，不是我们的。

```ts
export interface AgentMessage {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'status' | 'error' | 'log'
  tool?: string | null            // 工具名（tool_use / tool_result 时）
  content: string
  input?: Record<string, unknown> | null   // 结构化输入（tool_use 时）
  output?: string | null                   // 工具输出（tool_result 时）
  outputTruncated?: boolean
}

export interface ExecOptions {
  prompt: string               // 用户消息（③ 任务那一块）。谁送来什么，这里照发，后端不做拼装
  systemPrompt?: string        // ①② 两块。空/缺省 = 不发这个参数（runtime 不支持时调用方已合并）
  workDir: string              // ★ 使用者指定的工作目录；平台不做仓库检出（D20）
  model?: string | null
  maxTurns?: number | null
  resumeSessionId?: string | null   // 会话恢复。恢复失败要能被识别出来（FR-CLI-06）
  env?: Record<string, string>      // 额外环境变量（在任务级覆盖之后应用）
  customArgs?: readonly string[]    // 用户自定义参数——会被禁改表过滤
  signal?: AbortSignal
  onActivity?: () => void           // 子进程输出一行时的回调（活性判定）
  onCommandLine?: (info: {         // 上报**最终**命令行（含沙箱包装）+ 沙箱实际状态一句话
    argv: readonly string[]
    sandboxDescription: string
  }) => void                        // 脱敏是安全逻辑，只能有一份（domain），后端只报事实
  onStderrLine?: (line: string) => void
  sandbox?: SandboxOptions          // 平台的决定，所有 runtime 同一套；后端不得吞掉 planSandbox 的异常
}

export interface AgentResult {
  status: 'completed' | 'failed'
  output: string                    // 最终产出文本
  error?: string | null
  durationMs: number
  sessionId?: string | null         // 用于下次 resume
  usage?: TokenUsage | null
  resumeRejected?: boolean | undefined  // true=确认被拒；false=没被拒**或无法判断**（不可信）
  exitCode?: number | null
  model?: string | null             // ★ CLI 自己报告的模型，不是请求值；没有就 null，绝不拿请求值顶替
}

export interface AgentSession {
  readonly messages: AsyncIterable<AgentMessage>   // 流式消息。消费到结尾后再 await result
  readonly result: Promise<AgentResult>            // 终态
  cancel(): Promise<void>                          // 终止进程树
  lastActivityAt(): number                         // 最近一次输出活动的时间戳（活性判定）
}

export interface AgentBackend {
  readonly key: string                    // provider 键，如 'claude'
  readonly protocol: RuntimeProtocol
  readonly rejectDetectable: boolean      // 该 CLI 是否支持检测"恢复被拒绝"
  probe(): Promise<{ available: boolean; command: string; cliVersion: string | null }>
  execute(opts: ExecOptions): Promise<AgentSession>   // 实现负责参数拼装、进程管理与输出解析
}
```

**两个 runtime 都实现这一个接口**——签名相同，内部各异：

| | `ClaudeBackend`（agent-claude） | `CodexBackend`（agent-codex ✅） |
|---|---|---|
| `execute` 里做什么 | 拼 `claude -p …` argv → spawn → stdin 喂 stream-json → 解析事件流 | spawn `codex app-server` → JSON-RPC 握手 → `thread/start`/`resume` → `turn/start` → 解析通知流 |
| `cancel()` | 终止进程树 | `turn/interrupt` + 终止进程树 |
| 终止事件 | `message_stop` / `result` | `turn/completed`（status 三态） |
| `result.model` | 从流里解析 CLI 报告的 | 取 `thread/start` 响应的 model |
| `result.sessionId` | `--resume` 的会话 id | `thread_id` |
| `result.usage` | 从事件解析 | `thread/tokenUsage/updated` 通知 |

对执行器而言，两者都是"`execute` 返回一个流 + 一个终态"。**这就是公用**：
接口只有一条，差异全部落在接口的**实现内部**。

---

## 2. 公共数据表：`RuntimeDescriptor`（结构）

来源：`packages/agent-core/src/runtime-table.ts`。所有 runtime 差异的**唯一数据落点**。
claude 与 codex 共用**同一份结构**，只是取值不同。

```ts
export type RuntimeEvidence =
  | 'verified'        // 逐字段对照过真实 CLI 的输出
  | 'provisional'     // 从文档/公开形状推导，尚未在真实 CLI 上跑过

export type SessionState = 'stateful' | 'stateless' | 'unknown'
//  stateful   → 允许恢复，且允许判定"恢复被拒"
//  stateless  → 绝不尝试恢复（不传恢复参数），resumeRejected 保持 undefined
//  unknown    → 同 stateless 不尝试恢复，但审计与 UI 能看出原因是"没验证"而不是"确认不支持"

export type PromptDelivery = 'stdin-ndjson' | 'argv'   // prompt 怎么送进 CLI

export type SkillDelivery =
  | { kind: 'directory'; dir: string }   // 这个 CLI 会自己扫 <dir>/<slug>/SKILL.md
  | { kind: 'none'; reason: string }     // 没有技能发现机制 → 一个文件都不写，宁可不支持也不要假装支持

export interface ManagedFlags {           // 平台受管参数用的旗标名（必填，不得替 CLI 猜）
  model: string
  maxTurns: string
  resume: string
}

export interface InjectionSlot {          // 注入位开关（toolConfig / disableSwitch）
  enabled: boolean
  reason?: string                        // 未启用的原因——必填，这是"留扩展位"的可评审形式
  evidence?: RuntimeEvidence
}

export interface SupportedVersions {      // FR-CLI-07「以实际版本验证，不得凭文档推断」
  range: string
  verifiedWith: readonly string[]        // ★ 实测过的具体版本——空数组等于没有声明
  onMismatch?: 'warn' | 'refuse'
}

export interface RuntimeDescriptor {
  key: string                      // provider 键
  command: string                  // 探测用的命令名
  protocol: RuntimeProtocol
  family: 'claude-stream-json' | 'generic-ndjson'   // 解析器选择器（与 protocol 不一一对应）
  evidence: RuntimeEvidence        // ★ 未验证的 runtime 不得被当成已验证
  evidenceNote?: string            // evidence 不是 verified 时，说明缺什么证据
  sessionState: SessionState       // ★ 三态，不允许用二态把"不知道"说成"没有"
  versions?: SupportedVersions     // 缺省 = 尚未声明，checkVersionSupport() 如实报 undeclared
  stateDir?: string                // CLI 自己的状态目录（相对主目录）——沙箱放行、起 run 前预检
  skills: SkillDelivery            // ★ 是"能力"而不是目录名：没有该机制的 CLI 必须显式说没有
  toolConfig: InjectionSlot        // 首版不启用（disabled + reason）
  disableSwitch: InjectionSlot     // 首版不启用（disabled + reason）
  resume: { flag: string; rejectDetectable: boolean }
  systemPrompt: { flag: string } | null   // ★ null = 该 runtime 没有系统提示概念 ⇒ 调用方退回 B 档
  promptDelivery: PromptDelivery
  baseArgs: readonly string[]              // 协议基础参数——属于平台，使用者不可覆盖
  blockedArgs: Readonly<Record<string, BlockedArgMode>>   // 禁改表（standalone / withValue）
  managedFlags: ManagedFlags               // ★ 必填；宁可加载时就报错，也不要替未声明的 CLI 猜旗标
}
```

**claude 与 codex 是这张表里的两行**（同一份结构，不同取值）：

| 字段 | claude（现表，`CLAUDE_DESCRIPTOR`） | codex（现表，见 `docs/runtime/codex-runtime-design.md` §6）✅ |
|---|---|---|
| `key` / `command` | `claude` / `claude` | `codex` / `codex` |
| `family` | `claude-stream-json` | `codex-app-server-jsonrpc` ✅ |
| `protocol` | `stream-json` | `jsonrpc`（枚举里本来就有，首次启用）✅ |
| `evidence` | `verified` | `verified`（0.144.0-alpha.4 实测，§7 清单）✅ |
| `sessionState` | `stateful` | `stateful`（`thread/resume` 一等公民，跨进程恢复实测）✅ |
| `stateDir` | `.claude` | `.codex` ✅ |
| `skills` | `{kind:'directory', dir:'.claude/skills'}` | `{kind:'directory', dir:'.codex/skills'}`（自动发现实测，需 frontmatter）✅ |
| `systemPrompt` | `{flag:'--append-system-prompt'}` → A 档 | `null` → B 档（三块合成一段）✅（B 档下 ①② 随每轮走、恢复后仍在，实测） |
| `promptDelivery` | `stdin-ndjson` | service 不填（RPC `input`）✅ |
| `baseArgs` | `-p --output-format stream-json …` | `['app-server','--stdio']`（launch 语义）✅ |
| `managedFlags` / `blockedArgs` | `--model/--max-turns/--resume` + 禁改表 | service 不填（model 走 `thread/start` 参数；无 run 级 argv）✅ |
| `resume` | `{flag:'--resume', rejectDetectable:true}` | 走 `thread/resume`（RPC，失败 -32600 可检测，`rejectDetectable=true`）✅ |

> ✅ **已落地的契约扩展**（唯一绕不过的一处）：现有结构是 **CLI 形状**（`managedFlags`、
> `blockedArgs`、`promptDelivery`、`resume.flag` 都是"命令行参数"概念）。codex 是
> **service 形状**（run 的行为是 JSON-RPC 参数，不是命令行）。设计在表上加
> `kind: 'cli' | 'service'` 判别，让 cli-only 字段对 service 行**不填**、按 kind 校验
> （而不是填占位值——那是撒谎）。这也是为什么"一张表"能继续成立：差异以**数据**
> 形式存在于表里，而不是散进 daemon 的调用点。

**这张表本身就是"公用"最直接的证据**：同一份结构、同一套字段、两行取值不同。

---

## 3. 公共的那台机器：daemon 里与 runtime 无关的路径

这是"公用"的重头。下面每条路径，claude 与 codex **都走同一条代码**——它读的是
`RuntimeDescriptor` 的取值与 `AgentBackend` 的返回，**没有任何 `if (key === 'claude')`**。

| # | 路径 | 读什么 / 做什么 | claude | codex ✅ |
|---|---|---|---|---|
| 3.1 | **执行**（`executor`） | 按 `agent.runtimeKey` 经装配表解析 `{backend, descriptor}`；只读 `sessionState` 决定是否恢复；然后 `backend.execute({prompt, systemPrompt?, workDir, model, maxTurns, resumeSessionId, env, 回调, sandbox})`；终态 `output` → 判决围栏提取 | 走同一条代码 | 走同一条代码 |
| 3.2 | **第一句话**（`first-sentence`） | `deliveryModeFor(runtime)`：`systemPrompt === null ? B : A`。A 档①②走系统提示旗标、③是用户消息；B 档三块合成一段 | A 档（`--append-system-prompt`） | B 档（作为 `turn/start` 的 text input） |
| 3.3 | **技能注入**（`skill-injection`） | 读 `descriptor.skills.dir`，写 `<workdir>/<dir>/<slug>/SKILL.md`——"把目录摆对，不靠提示词喂"（FR-CLI-19） | `.claude/skills/` | `.codex/skills/`（项目作用域） |
| 3.4 | **沙箱**（`sandbox` + 执行器） | `planSandbox` 在 spawn 前包装进程；`cliStateDir(descriptor.stateDir)` 放行 CLI 自己的状态目录；沙箱状态由后端经 `onCommandLine` 如实上报 | `~/.claude` | `~/.codex`；per-run 进程同样能被平台沙箱包住，内部再由 codex 每线程 `sandbox: workspace-write` 双保险 |
| 3.5 | **环境预检**（`environment`） | 起 run 前检查 `stateDir` 能否建/写，给出可读诊断 | `.claude` | `.codex` |
| 3.6 | **审计**（`audit/record`） | 后端上报**最终**命令行 → `redactArgv` 脱敏（脱敏只有一份，各适配器不各自脱敏）→ 记入审计；`result.model` 记"实际跑的"；`result.usage` 记用量 | `claude -p …` | `codex app-server --stdio` |
| 3.7 | **工作目录清单**（`workdir-files`） | `managedPathsFor(descriptor)` 标记注入物 = `skills.dir` + `stateDir` + `.agentdeck/` | 同函数 | 同函数 |
| 3.8 | **界面与身份**（`server` identity） | `runtimes` 数组 = 装配表里 **`evidence === 'verified'`** 的那些（2026-10 起：未接真实 CLI 的 runtime 不进 UI——判据是证据等级不是 runtimeKey，加第四个未验证 runtime 时自动隐藏；开发者通道 `--runtime-key` / `--verify-runtime all` / 直接调 API 不受影响） | 自动覆盖 | 自动覆盖，一行不改 |
| 3.9 | **版本验证**（`verify-runtime`） | 枚举装配表，对每个 runtime probe + 版本支持判定 | 自动覆盖 | 自动覆盖 |
| 3.10 | **失败分级** | 同一套纪律：**宽容读取，明确失败**——不可解析的输出绝不静默丢掉，计数 + 升级为明确失败（`cli_unparsable_output` / `agent_error`） | `ClaudeStreamParser` | `classifyCodexFailure` ✅（判据同构：零事件 / 没等到 `turn/completed`） |

3.1 的执行器是理解"公用"的关键一瞥：选后端、判定恢复、组装调用、收取结果——
每一处都只对**契约与表**编程。两个 runtime 的区别，全部体现在 `execute` 的**内部**与
描述表的**取值**上。

---

## 4. 差异都藏在哪里（"不公用"的部分）

公用之外，每个 runtime 独有的一切都收在**自己的包里 + 自己的表行**里：

| 差异 | claude（agent-claude） | codex（agent-codex ✅） |
|---|---|---|
| 进程形态 | spawn `claude -p …`（一次性 CLI） | spawn `codex app-server` + JSON-RPC（per-run 服务） |
| 输入投递 | stdin stream-json 帧 | `turn/start` 的 `input:[{type:'text'}]` |
| 输出解析 | 事件流解析器 | `jsonrpc-transport` + 通知流解析器 |
| 会话恢复 | `--resume <id>` 旗标 | `thread/resume`（RPC） |
| 审批 | `--disallowedTools AskUserQuestion,WebSearch,WebFetch` | `approvalPolicy:'never'` + 防御性 decline |
| 禁改表 | `CLAUDE_BLOCKED_ARGS`（协议旗标） | service 无 run 级 argv（customArgs 收到即警告） |
| 沙箱 | 平台 `planSandbox` | 平台 `planSandbox` + codex 每线程 sandbox |
| 证据等级 | `verified` | `provisional`（待核对清单升 verified） |

**"哪些进表、哪些留包"的判断标准**：**core 需要知道吗？** 需要 → 进表
（旗标名、会话状态、技能目录、证据等级——`argv.ts`、执行器、界面都要读）；
只有本包需要 → 留包（凭据放哪个环境变量、RPC 方法名、事件字段名——那是上游的差异）。

---

## 5. 为什么"加一个 runtime 不改通用代码"：清单

要加第三个 runtime（或验证"框架真是公用的"），只需回答同样几个问题：

1. **表里加一行**：`kind` / `command` / `family` / `evidence` / `sessionState` / `stateDir` /
   `skills` / `systemPrompt` / `baseArgs`（+ 该 kind 的专属字段）——写进 `runtime-table.ts`；
2. **写一个适配器包**：实现 `AgentBackend`（probe + execute → AgentSession），
   自配一个解析器 + 失败分类器；
3. **装配表加一行**：`runtime-registry.ts`；
4. **差异明确标证据等级**：`provisional` 起步，`--verify-runtime` + 真实端到端后升 `verified`。

通用代码（§3 那十条路径）不需要任何改动——这就是 claude 与 generic 已经证明、
codex 也已经再次证明的事（codex 的整条链路跑在同一个执行器 / 同一条审计路径上，
见 `apps/daemon/src/runtime-registry.test.ts` 的装配测试）。

---

## 6. 相关文件

| 想看什么 | 去哪 |
|---|---|
| 公共契约 `AgentBackend` / `ExecOptions` / `AgentSession` / `AgentResult` | `packages/agent-core/src/backend.ts` |
| 公共数据表 `RuntimeDescriptor` 及全部支持类型 | `packages/agent-core/src/runtime-table.ts` |
| 通用 argv 组装（cli 形态） | `packages/agent-core/src/argv.ts` |
| 第一句话 A/B 档与判定 | `packages/agent-core/src/first-sentence.ts` |
| 技能注入 | `packages/agent-core/src/skill-injection.ts` |
| 沙箱与状态目录放行 | `packages/agent-core/src/sandbox.ts` |
| 执行器（选后端 / 恢复 / 调用） | `apps/daemon/src/executor.ts` |
| 装配表（表行 ↔ 适配器包） | `apps/daemon/src/runtime-registry.ts` |
| 审计脱敏 | `packages/domain/src/audit/record.ts` |
| claude 适配器（参考实现） | `packages/agent-claude/src/claude-backend.ts` + `stream-parser.ts` |
| codex 适配器（service 形状，✅ 0.144.0-alpha.4 实测） | `packages/agent-codex/src/codex-backend.ts` + `stream-parser.ts` + `jsonrpc-transport.ts`；设计与核对清单见 `docs/runtime/codex-runtime-design.md`（§5 包结构、§6 描述符、§7 清单） |
| generic 适配器（第二个实证） | `packages/agent-generic/src/generic-backend.ts` + `stream-parser.ts` |
| codex 适配器（设计稿 ✅，§7 已核对） | `docs/runtime/codex-runtime-design.md`（§5 包结构、§6 描述符、§7 核对清单） |
