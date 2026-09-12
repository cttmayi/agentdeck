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
