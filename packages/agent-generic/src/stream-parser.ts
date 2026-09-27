import type { AgentMessage } from '@agentdeck/agent-core'
import type { TokenUsage } from '@agentdeck/protocol'

/**
 * 第二个 CLI 的 NDJSON 事件解析器。
 *
 * ══════════════════════════════════════════════════════════════════
 * 解析策略与 claude 那份是**同一套纪律**（design §9.7）
 * ══════════════════════════════════════════════════════════════════
 *
 * 「宽容读取，明确失败」：
 *   - 认识的字段缺失 → 降级（少一个 `model` 不该让整次 run 失败）；
 *   - 不认识的事件名 → 不当场崩（上游加新事件是常态）；
 *   - **但不可解析的输出绝不能被静默丢掉**：它必须留下计数与一条可见的
 *     消息，并由后端在退出时升级为明确失败。
 *
 * ══════════════════════════════════════════════════════════════════
 * 与 claude 那份的**唯一实质差异**，以及为什么要较真
 * ══════════════════════════════════════════════════════════════════
 *
 * claude 的 CLI 会往 stdout 打非 JSON 的日志行，所以那份把非 JSON 行降级成
 * `log` 消息、只累加计数。对 claude 这是对的——它确实会那样。
 *
 * 但第二个 CLI 的**协议本身就是 NDJSON**：它的 stdout 上除了 JSON 行不该有
 * 别的东西。于是"这行不是 JSON"只有两种可能：进程把诊断信息混进了 stdout，
 * 或者**输出格式变了**。两种都不该被轻轻放过——后者正是 §9.7 里
 * "看起来像 agent 什么都没说"的形态。
 *
 * 所以本解析器对无法解析的行**发一条显式告警消息**（`type: 'log'` 但内容
 * 带前缀，且计数可查），并把"是否升级为 run 失败"的判定交给后端。
 * 把判定留在后端是有意的：解析器只负责**如实记录**，失败分级是
 * FR-CLI-41 的策略问题，混进解析器会让它无法被单独测试。
 */

/**
 * 单行最大长度（FR-CLI-42：行长上限有界）。
 *
 * 与 claude 用同一个数：超限即判畸形，避免一条没有换行的畸形输出把内存吃光。
 * 这不是"防御性编程"的空话——NDJSON 协议下，一个没被 flush 的超长行会让
 * readline 一直缓冲，进程看起来"卡住"而没有任何输出。
 */
export const MAX_LINE_BYTES = 32 * 1024 * 1024

/** 工具输出入库前的截断长度。与 claude 保持一致，便于前端复用渲染。 */
const TOOL_OUTPUT_LIMIT = 4000

export interface GenericStreamEvents {
  onMessage: (message: AgentMessage) => void
}

/**
 * 第二个 CLI 的**已知事件名**。
 *
 * 收成常量而不是散在 switch 里，是为了让"新增一个事件名"变成一处改动，
 * 也让测试可以对着同一份清单断言（清单本身是未验证的，见
 * `generic-descriptor.ts` 的 `unverifiedFields()`）。
 */
export const GENERIC_EVENT_TYPES = [
  'text',
  'thinking',
  'tool_use',
  'tool_result',
  'usage',
  'result',
  'error',
] as const

export type GenericEventType = (typeof GENERIC_EVENT_TYPES)[number]

/**
 * prompt 的投递帧。
 *
 * `argv` 模式下 prompt 是命令行参数，这个函数用不上；保留它是为了让
 * "投递方式"的差异只体现在描述表的一个字段上，而不是散进后端代码——
 * 若真实 CLI 只认 stdin，改描述符 + 让后端走这个函数即可。
 */
export function buildGenericInput(prompt: string): string {
  // 与 claude 的 stream-json 不同：这里就是**一行 JSON**，不带嵌套的 message 包壳。
  // 未验证：真实 CLI 可能期望 `{"prompt": "..."}` 之外的形状。
  return `${JSON.stringify({ type: 'prompt', prompt })}\n`
}

/**
 * 会话恢复被拒的识别（FR-CLI-06）。
 *
 * ⚠️ 本 runtime 的 `rejectDetectable` 是 `false`：这些模式**没有真实样本**，
 *    是从 claude 的经验 + 常见 CLI 措辞推导的。后端因此会把识别结果
 *    **丢弃**（返回 `undefined` = 无法判断），而不是拿它冒充"确认被拒"。
 *    函数仍然导出，是为了首次接入真实 CLI 时可以直接拿它对着真实输出跑，
 *    测出样本后把它写成第二个 `verified` 的 runtime。
 */
const RESUME_REJECTION_PATTERNS = [
  /unknown session/i,
  /session (?:not found|does not exist|expired)/i,
  /no (?:such )?session/i,
  /invalid session/i,
  /could not (?:find|load) session/i,
  /resume.{0,20}(?:failed|not found)/i,
]

export function detectResumeRejection(text: string): boolean {
  return RESUME_REJECTION_PATTERNS.some((re) => re.test(text))
}

/** `result.status` 的取值——只有这两个被认为可判定。 */
interface ResultEventShape {
  status?: unknown
  result?: unknown
  reason?: unknown
  error?: unknown
  session_id?: unknown
  duration_ms?: unknown
  usage?: unknown
}

export class GenericStreamParser {
  readonly #events: GenericStreamEvents
  #sessionId: string | null = null
  #model: string | null = null
  #usage: TokenUsage | null = null
  #finalText: string | null = null
  #isError = false
  #errorText: string | null = null
  #resultSeen = false
  #terminalOk = false
  #unparsableLines = 0
  #recognizedEvents = 0
  #maxLineExceeded = false

  constructor(events: GenericStreamEvents) {
    this.#events = events
  }

  get sessionId(): string | null {
    return this.#sessionId
  }
  get model(): string | null {
    return this.#model
  }
  get usage(): TokenUsage | null {
    return this.#usage
  }
  /** `result` 事件里的最终文本——**优先于**逐条 text 拼接。 */
  get finalText(): string | null {
    return this.#finalText
  }
  get isError(): boolean {
    return this.#isError
  }
  get errorText(): string | null {
    return this.#errorText
  }
  /** 是否见到终止事件。缺它 = 输出不可解析（FR-RUNTIME-07）。 */
  get resultSeen(): boolean {
    return this.#resultSeen
  }
  /** 终止事件是否自报成功。 */
  get terminalOk(): boolean {
    return this.#terminalOk
  }
  /**
   * 不可解析的行数。
   *
   * 这个名字刻意不是 `logLines`：调用方必须能一眼看出它是**异常计数**，
   * 因为 §9.7 要求的失败分级就挂在它上面。
   */
  get unparsableLines(): number {
    return this.#unparsableLines
  }
  /** 被识别的事件条数。用来区分"输出格式全变了"与"零星日志"。 */
  get recognizedEvents(): number {
    return this.#recognizedEvents
  }
  /** 出现过超长行——单独记一位，因为它和"格式变了"是不同的故障。 */
  get maxLineExceeded(): boolean {
    return this.#maxLineExceeded
  }

  /** 解析一行。返回是否被识别为已知事件。 */
  push(line: string): boolean {
    const trimmed = line.trim()
    // 空行不算异常：CLI 在事件之间打一个空行是无害的，把它计成不可解析
    // 会让"格式变了"这个信号被噪声淹没。
    if (trimmed === '') return false

    if (trimmed.length > MAX_LINE_BYTES) {
      this.#unparsableLines++
      this.#maxLineExceeded = true
      this.#emit({ type: 'error', content: '单行输出超过上限，已丢弃（输出可能不是按行分隔的）' })
      return false
    }

    let event: Record<string, unknown>
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      this.#unparsableLines++
      // ★ 显式可见，不是静默忽略（FR-RUNTIME-07 / design §9.7）
      this.#emit({
        type: 'log',
        content: `[不可解析的输出行] ${trimmed.slice(0, 200)}`,
      })
      return false
    }

    // JSON 但不是对象（数组 / 数字 / 字符串）：NDJSON 协议下同样是格式不符。
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      this.#unparsableLines++
      this.#emit({ type: 'log', content: `[不可解析的输出行] 不是 JSON 对象：${trimmed.slice(0, 200)}` })
      return false
    }

    const type = typeof event['type'] === 'string' ? event['type'] : null

    // 会话 ID 字段位置未验证，所以**每个事件都探一遍**而不是只在某个事件上读——
    // 探错的代价只是读不到，而漏读的代价是恢复功能整体不可用且无从发现。
    if (typeof event['session_id'] === 'string') this.#sessionId = event['session_id']
    if (typeof event['model'] === 'string') this.#model = event['model']

    if (type === null) {
      // 是合法 JSON 对象但没有 type：协议要求每个事件带 type，故计入不可解析。
      this.#unparsableLines++
      this.#emit({ type: 'log', content: `[不可解析的输出行] 缺少 type 字段：${trimmed.slice(0, 200)}` })
      return false
    }

    switch (type) {
      case 'text':
        return this.#handleText(event)
      case 'thinking':
        return this.#handleThinking(event)
      case 'tool_use':
        return this.#handleToolUse(event)
      case 'tool_result':
        return this.#handleToolResult(event)
      case 'usage':
        return this.#handleUsage(event)
      case 'result':
        return this.#handleResult(event)
      case 'error':
        return this.#handleError(event)
      default:
        // 未知事件名：**不当场失败**。上游加事件是常态，把它当错误会让
        // 我们每次升级 CLI 都炸一次；真正要守的是"终止事件有没有出现"。
        return false
    }
  }

  /** `{"type":"text","text":"..."}` —— 兼容 `content` / `message` 两种别名。 */
  #handleText(event: Record<string, unknown>): boolean {
    const text = firstString(event, ['text', 'content', 'message'])
    if (text === null) return false
    this.#recognizedEvents++
    this.#emit({ type: 'text', content: text })
    return true
  }

  /** `{"type":"thinking","text":"..."}` */
  #handleThinking(event: Record<string, unknown>): boolean {
    const text = firstString(event, ['thinking', 'text', 'content'])
    if (text === null) return false
    this.#recognizedEvents++
    this.#emit({ type: 'thinking', content: text })
    return true
  }

  /** `{"type":"tool_use","name":"read_file","input":{...}}` —— 兼容 `tool` 别名。 */
  #handleToolUse(event: Record<string, unknown>): boolean {
    const name = firstString(event, ['name', 'tool'])
    this.#recognizedEvents++
    this.#emit({
      type: 'tool_use',
      tool: name,
      content: name === null ? '调用工具' : `调用工具 ${name}`,
      input:
        event['input'] && typeof event['input'] === 'object' && !Array.isArray(event['input'])
          ? (event['input'] as Record<string, unknown>)
          : null,
    })
    return true
  }

  /** `{"type":"tool_result","name":...,"output":"..."}` —— `status:'error'` 时标为错误。 */
  #handleToolResult(event: Record<string, unknown>): boolean {
    const raw = firstString(event, ['output', 'content', 'result'])
    const text = raw ?? ''
    const truncated = text.length > TOOL_OUTPUT_LIMIT
    const clipped = truncated ? `${text.slice(0, TOOL_OUTPUT_LIMIT)}…` : text

    this.#recognizedEvents++
    this.#emit({
      type: 'tool_result',
      tool: firstString(event, ['name', 'tool']),
      content: clipped,
      output: clipped,
      outputTruncated: truncated,
    })

    // 工具失败在 claude 的协议里是 `is_error`，这里是 `status: 'error'`。
    // 转成 error 消息而不是 tool_result——否则使用者只看到一段文本，
    // 无法判断"工具跑失败了"还是"工具正常返回了这句话"。
    if (event['status'] === 'error' || event['is_error'] === true) {
      this.#emit({
        type: 'error',
        tool: firstString(event, ['name', 'tool']),
        content: clipped === '' ? '工具调用失败' : clipped,
      })
    }
    return true
  }

  /** `{"type":"usage","input_tokens":N,"output_tokens":M,"cost_usd":x}` */
  #handleUsage(event: Record<string, unknown>): boolean {
    const usage = toUsage(extractUsageSource(event))
    if (usage === null) return false
    this.#recognizedEvents++
    this.#usage = usage
    return true
  }

  /**
   * 终止事件：
   * `{"type":"result","status":"success"|"error","result":"...","session_id":...,"usage":{...}}`
   *
   * 判失败的依据是 `status`，**不是** `is_error`：未验证的协议不该被我们
   * 猜出来的别名决定成败。`status` 缺失时按 subtype/error 字段兜底，
   * 但也只兜到"没有明确失败证据就不算失败"——过度判失败会让可用性变差，
   * 而过度判成功会被 `resultSeen`/退出码拦住。
   */
  #handleResult(event: Record<string, unknown>): boolean {
    this.#resultSeen = true
    this.#recognizedEvents++

    const shape = event as ResultEventShape
    const status = typeof shape.status === 'string' ? shape.status : ''
    const text = firstString(event, ['result', 'text', 'content'])
    if (text !== null) this.#finalText = text

    // 用量**可能嵌在 `usage` 子对象里**，也可能平铺在事件上——两种都把一次。
    //
    // 踩过一次：只读平铺字段时，`{"type":"result","usage":{"input_tokens":100}}`
    // 这种写法会被静默读成"没有用量"，于是成本统计少一整类事件，而日志干净、
    // 没有任何报错。所以这里显式两路都试，宁可多读一次也不要漏。
    const usage = toUsage(extractUsageSource(event))
    if (usage !== null) this.#usage = usage

    const failed =
      status === 'error' ||
      status === 'failed' ||
      (status === '' && (event['is_error'] === true || typeof shape.error === 'string'))

    this.#isError = failed
    this.#terminalOk = !failed

    if (failed) {
      this.#errorText =
        text ??
        firstString(event, ['error', 'reason']) ??
        `CLI 以 ${status || '错误'} 结束`
      this.#emit({ type: 'error', content: this.#errorText })
    }
    return true
  }

  /** `{"type":"error","message":"..."}` —— 中途报错，不一定伴随终止事件。 */
  #handleError(event: Record<string, unknown>): boolean {
    const text = firstString(event, ['message', 'error', 'text', 'reason']) ?? 'CLI 报了错误'
    this.#recognizedEvents++
    this.#isError = true
    // 注意：**不**在这里置 `resultSeen`。中途报错之后 CLI 仍可能继续跑完并
    // 给出终止事件；把错误事件当成终止会让"报了错但最终成功"被误判。
    this.#errorText = this.#errorText === null ? text : `${this.#errorText}\n${text}`
    this.#emit({ type: 'error', content: text })
    return true
  }

  #emit(message: AgentMessage): void {
    this.#events.onMessage(message)
  }
}

/** 取第一个存在且非空的字符串字段——上游字段名未验证，别名是常态。 */
function firstString(event: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = event[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

/**
 * 找出用量的来源对象。
 *
 * 优先 `usage` 子对象（claude 的形状、也是多数 CLI 的形状），
 * 没有就退回事件本身（有些 CLI 把 token 数平铺在事件上）。
 */
function extractUsageSource(event: Record<string, unknown>): Record<string, unknown> {
  const nested = event['usage']
  if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
    return nested as Record<string, unknown>
  }
  return event
}

/**
 * 用量归一化。
 *
 * 与 claude 一样把成本记成**整数微美元**（design §11.3）：浮点金额在累加时
 * 会漂移，而成本是要入库、要按 run 汇总的。
 *
 * `costSource` 的判定值得说明：只有 CLI **明确给了金额**才算 `provider`，
 * 否则是 `estimated` 且金额为 0。把"没给"当 0 并标成 provider，
 * 会让成本报表看起来精确而其实是空的。
 */
function toUsage(source: Record<string, unknown>): TokenUsage | null {
  const input = numberField(source, ['input_tokens', 'inputTokens', 'prompt_tokens'])
  const output = numberField(source, ['output_tokens', 'outputTokens', 'completion_tokens'])
  const cost = numberField(source, ['cost_usd', 'costUsd', 'total_cost_usd'])

  if (input === null && output === null && cost === null) return null

  return {
    inputTokens: Math.max(0, Math.trunc(input ?? 0)),
    outputTokens: Math.max(0, Math.trunc(output ?? 0)),
    costUsdMicros: cost === null ? 0 : Math.max(0, Math.round(cost * 1_000_000)),
    costSource: cost === null ? 'estimated' : 'provider',
  }
}

function numberField(event: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = event[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}
