import type { RuntimeProtocol, TokenUsage } from '@alpha-helper/protocol'
import type { SandboxOptions } from './sandbox.ts'

/**
 * Agent CLI 适配器的契约。
 *
 * 这个接口**刻意只有一件事**：跑一个 prompt，拿回流式结果。
 * 所有复杂度都被推到实现里（参数怎么拼、输出怎么解析、会话怎么恢复），
 * 因为那些差异是上游 CLI 的，不是我们的。
 *
 * 设计依据：`ref/multica-25-backends-flattening.md` —— 把 N 个后端摊平成
 * 一条接口的价值不在于"支持了几个 CLI"，而在于**新增一个 CLI 只需回答
 * 同样几个问题**（FR-RUNTIME-06）。
 */

/** 一条执行消息。类型归一化到这几个值，屏蔽各家 CLI 的差异。 */
export interface AgentMessage {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'status' | 'error' | 'log'
  /** 工具名（tool_use / tool_result 时）。 */
  tool?: string | null
  content: string
  /** 结构化输入（tool_use 时）。 */
  input?: Record<string, unknown> | null
  /** 工具输出（tool_result 时）。 */
  output?: string | null
  outputTruncated?: boolean
}

export interface ExecOptions {
  prompt: string
  /** ★ 使用者指定的工作目录；平台不做仓库检出（D20）。 */
  workDir: string
  model?: string | null
  maxTurns?: number | null
  /** 会话恢复。恢复失败要能被识别出来（FR-CLI-06）。 */
  resumeSessionId?: string | null
  /** 额外环境变量（在任务级覆盖之后应用）。 */
  env?: Record<string, string>
  /** 用户自定义参数——会被禁改表过滤。 */
  customArgs?: readonly string[]
  signal?: AbortSignal
  /** 子进程输出一行时的回调（用于活动性判定，FR-RUN-08）。 */
  onActivity?: () => void
  /**
   * 最终的**命令行**（含沙箱包装）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么由后端报给调用方，而不是后端自己写日志
   * ══════════════════════════════════════════════════════════════════
   *
   * 因为**脱敏是安全逻辑，只能有一份**。它现在在 `domain/audit/record.ts`
   * 的 `redactArgv` 里（审计记录也用它），而适配器包依赖不到 domain
   *（依赖方向：domain ← agent-core ← agent-claude）。
   *
   * 让适配器各写一份脱敏，就等于有两份安全逻辑——它们迟早会漂，而漂的
   * 那一次就是把令牌写进了日志。所以后端只负责**如实上报事实**，
   * 由调用方决定怎么脱敏、怎么记。
   */
  onCommandLine?: (info: {
    /**
     * **最终**要执行的命令行——含沙箱包装（如果启用了）。
     *
     * ⚠️ 判定沙箱有没有生效**不要**去看这个数组里有没有 `sandbox-exec`：
     *    那是在从结果反推原因，而不同的包装器名字不同、将来还可能变。
     *    用下面的 `sandboxDescription`，那是权威说明。
     */
    argv: readonly string[]
    /**
     * 沙箱的**实际状态**，一句话说清。
     *
     * 这个字段是补上来的：一开始只报了命令行，于是日志里一条
     * `/opt/homebrew/bin/claude -p …` 看过去，**分不清"沙箱没开"还是
     * "沙箱开了但没生效"**——两者的排查方向完全不同。而"确实做了"与
     * "看得出来做了"是两件事，这个项目已经在别处栽过一次。
     */
    sandboxDescription: string
  }) => void
  /**
   * stderr 的每一行。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么 stderr 必须进日志
   * ══════════════════════════════════════════════════════════════════
   *
   * 原来 stderr 只被攒成一个尾巴，**且只在失败时**才出现在错误信息里
   *（截断到 500 字符）。于是"跑成功了但 CLI 一直在抱怨什么"这种情况，
   * 使用者什么都看不到——而那恰恰是最需要 debug 的一类。
   *
   * CLI 的警告、弃用提示、认证问题大多走 stderr。把它们放进日志，
   * 排查时就不用去猜"它当时到底说了什么"。
   */
  onStderrLine?: (line: string) => void

  /**
   * 可选沙箱（M4）。缺省 = 不做任何包装。
   *
   * ★ 放在 `ExecOptions` 而不是某个后端的私有配置里：这是**平台**的决定，
   *   所有 runtime 都要遵守同一条。如果每个适配器各自实现一套，
   *   "换一个 CLI 就没有沙箱了"这件事会悄无声息地发生。
   *
   * 由后端在拼好 argv 之后、spawn 之前调用 `planSandbox()` 应用。
   * 沙箱不可用时 `planSandbox` 会抛——**后端不得吞掉这个异常**，
   *   否则使用者会在以为自己被保护着的情况下裸奔。
   */
  sandbox?: SandboxOptions
}

export interface AgentResult {
  status: 'completed' | 'failed'
  /** 最终产出文本。 */
  output: string
  error?: string | null
  durationMs: number
  /** 用于下次 resume。 */
  sessionId?: string | null
  usage?: TokenUsage | null
  /**
   * 会话恢复被拒绝。
   *
   * `true` = 确认被拒；`false` = **没被拒或无法判断**。
   * 后者很重要：有些 CLI 根本不报告这件事，把"测不出来"当成"没被拒"
   * 会导致语义悄悄跑偏。`rejectDetectable: false` 的 runtime 必须让调用方
   * 知道这个 false 是不可信的（FR-CLI-06）。
   */
  resumeRejected?: boolean | undefined
  /** 退出码（便于诊断）。 */
  exitCode?: number | null
  /**
   * **CLI 自己报告的**模型标识。
   *
   * ★ 与 `ExecOptions.model`（我们**要求**它用的那个）是两件事，两个都要留：
   *   请求的那个说明使用者的意图，CLI 报告的这个说明**实际跑的是什么**——
   *   而审计要的是后者。CLI 不报告时（比如某个 runtime 的输出里没有它）
   *   这里是 null，绝不拿请求值去顶替：那会让审计记录看起来比事实更确定。
   */
  model?: string | null
}

export interface AgentSession {
  /** 流式消息。消费到结尾后再 await `result`。 */
  readonly messages: AsyncIterable<AgentMessage>
  /** 终态。 */
  readonly result: Promise<AgentResult>
  /** 终止进程树。 */
  cancel(): Promise<void>
  /** 最近一次输出活动的时间戳，用于活性判定。 */
  lastActivityAt(): number
}

export interface AgentBackend {
  /** provider 键，如 `claude`。 */
  readonly key: string
  readonly protocol: RuntimeProtocol
  /** 该 CLI 是否支持检测"恢复被拒绝"。 */
  readonly rejectDetectable: boolean
  /** 探测二进制是否存在并返回版本。 */
  probe(): Promise<{ available: boolean; command: string; cliVersion: string | null }>
  /** 执行。实现负责参数拼装、进程管理与输出解析。 */
  execute(opts: ExecOptions): Promise<AgentSession>
}
