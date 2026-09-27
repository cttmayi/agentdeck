import type { AgentMessage } from '@agentdeck/agent-core'
import type { TokenUsage } from '@agentdeck/protocol'
import { CODEX_SERVER_FACTS } from './codex-descriptor.ts'

/**
 * codex app-server 的通知流解析器（JSON-RPC 通知 → AgentMessage + 终态判定）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 解析策略与 claude / generic 两份是**同一套纪律**（design §9.7）
 * ══════════════════════════════════════════════════════════════════
 *
 * 「宽容读取，明确失败」：
 *   - 认识的字段缺失 → 降级（少一个字段不该让整次 run 失败）；
 *   - 不认识的通知方法 → 不当场崩（上游加通知是常态），只计数；
 *   - **但不可解析的输出绝不能被静默丢掉**：坏的 JSON 帧要计数 + 发一条可见的
 *     消息，并由后端在收尾时升级为明确失败。
 *
 * ══════════════════════════════════════════════════════════════════
 * 与 NDJSON 两份的差异：终止事件不是一帧，而是"多帧 + 一个收尾帧"
 * ══════════════════════════════════════════════════════════════════
 *
 * 一个 turn 期间：`item/started`、`item/…/delta`（累积）、`item/completed`
 * （权威条目）、最后 `turn/completed`（status: completed | interrupted | failed）
 * 是**终止帧**。没有 `turn/completed` = 与"没有终止事件"同义——进程退出但
 * 没等到它，判不可解析。
 *
 * ⚠️ 载荷字段名已按真实 app-server 实测核对（两个版本：0.144.0-alpha.4 与
 *    0.157.1）：agentMessage 的权威文本在 `item.text`、reasoning 摘要在
 *    `item.summary`（字符串数组）、fileChange 在 `item.changes: [{path,
 *    kind:{type}, diff}]`、tokenUsage 在 `params.tokenUsage.total`——读字段一律
 *    走防御性提取，拿不到就降级，绝不抛。
 *    ★ 工具类 item 是**扁平形状**（0.157.1 实测）：commandExecution 字段在 item
 *    顶层（`item.command` / `item.status` / `item.aggregatedOutput`，没有
 *    outputDelta 通知）、mcpToolCall 同（`item.tool` / `item.arguments` /
 *    `item.result.content[]` / `item.error`）。dynamicToolCall / webSearch 形状
 *    仍未实测（本机模型未触发，见 `unverifiedFields()`），旧嵌套假设字段一律
 *    保留作防御降级。
 */

/** 工具输出入库前的截断长度。与 claude / generic 保持一致，便于前端复用渲染。 */
const TOOL_OUTPUT_LIMIT = 4000

export interface CodexParserEvents {
  onMessage: (message: AgentMessage) => void
}

/** `turn/completed` 的收尾形态。 */
export interface CodexTurnEnd {
  status: 'completed' | 'interrupted' | 'failed'
  error: { message: string; codexErrorInfo?: string } | null
}

/** 通知方法名清单——让"新增一个通知"与测试断言对着同一份清单。 */
export const CODEX_NOTIFICATIONS: readonly string[] = Object.values(
  CODEX_SERVER_FACTS.notifications,
)

// ── 防御性字段提取（载荷形状 [未验证]，拿不到就降级不抛） ──────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : null
}

function asBool(value: unknown): boolean {
  return value === true
}

/** delta 通知里取文本：`params.delta` 可能是字符串，也可能是 `{…, delta}` 对象。 */
function deltaText(params: Record<string, unknown> | null): string {
  if (!params) return ''
  const direct = asString(params['delta'])
  if (direct !== null) return direct
  const inner = asRecord(params['delta'])
  return asString(inner?.['delta']) ?? ''
}

/** summary 可能是字符串数组（实测：`item.summary: string[]`）或单个字符串：统一成一段文本。 */
function summaryText(item: Record<string, unknown> | null, fallback: string): string {
  const raw = item?.['summary']
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) {
    const parts = raw.filter((x): x is string => typeof x === 'string')
    if (parts.length > 0) return parts.join('\n')
  }
  return fallback
}

/** 工具结果取文本：实测（0.157.1）`item.result.content: [{type:'text', text}]`，也兼容裸字符串。 */
function toolResultText(item: Record<string, unknown> | null): string {
  const result = asRecord(item?.['result'])
  if (!result) return ''
  const content = result['content']
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const part of content) {
      const text = asString(asRecord(part)?.['text'])
      if (text) parts.push(text)
    }
    return parts.join('\n')
  }
  return ''
}

export class CodexStreamParser {
  readonly #events: CodexParserEvents
  #recognizedEvents = 0
  #resultSeen = false
  #isError = false
  #errorText: string | null = null
  #finalText: string | null = null
  #usage: TokenUsage | null = null
  #unparsableLines = 0
  /** 平台主动 interrupt 过（cancel 路径）⇒ interrupted 不算异常。 */
  #interruptRequested = false

  // 条目级累积：delta 通知只带 itemId 与片段，权威文本在 item/completed。
  #itemTexts = new Map<string, string>()
  #reasoningTexts = new Map<string, string>()
  #toolOutputs = new Map<string, string>()

  #turnEndResolve!: (end: CodexTurnEnd) => void
  /** 等到 `turn/completed`（或 `markFailed`）——后端的"终止事件"。 */
  readonly turnEnd: Promise<CodexTurnEnd>

  constructor(events: CodexParserEvents) {
    this.#events = events
    this.turnEnd = new Promise((resolve) => {
      this.#turnEndResolve = resolve
    })
  }

  get recognizedEvents(): number {
    return this.#recognizedEvents
  }
  get resultSeen(): boolean {
    return this.#resultSeen
  }
  get isError(): boolean {
    return this.#isError
  }
  get errorText(): string | null {
    return this.#errorText
  }
  /** 最后一条 agentMessage 的最终文本——**优先于**逐条拼接。 */
  get finalText(): string | null {
    return this.#finalText
  }
  get usage(): TokenUsage | null {
    return this.#usage
  }
  get unparsableLines(): number {
    return this.#unparsableLines
  }

  /** 无法解析的裸行（transport 层喂进来）。宽容读取 + 可见消息，失败分级归后端。 */
  handleUnparsable(line: string): void {
    this.#unparsableLines += 1
    this.#events.onMessage({
      type: 'log',
      content: `（JSON-RPC 帧不可解析：${line.slice(0, 200)}）`,
    })
  }

  /** 平台发起 interrupt 前的标记：interrupted 收尾因此不算异常。 */
  noteInterruptRequested(): void {
    this.#interruptRequested = true
  }

  /**
   * 请求阶段失败（如 thread/start 被服务端拒绝）时的收尾入口：
   * 当作一个"failed 的终止帧"，让结果流正常走完（agent_error 而不是挂起）。
   *
   * ⚠️ 必须计一次"可识别事件"：这里收到的是**服务端明确拒绝**（JSON-RPC
   *    error 响应）——不是"没听懂它在说什么"。不计的话 `classifyCodexFailure`
   *    会先撞上 `recognizedEvents === 0`，把一次明确的拒绝误判成不可解析。
   */
  markFailed(message: string): void {
    this.#recognizedEvents += 1
    this.#isError = true
    this.#errorText = message
    this.#resultSeen = true
    this.#events.onMessage({ type: 'error', content: message })
    this.#turnEndResolve({ status: 'failed', error: { message } })
  }

  /** 一条入站通知。 */
  handleNotification(method: string, params: unknown): void {
    this.#recognizedEvents += 1
    switch (method) {
      case 'item/started':
        this.#onItemStarted(params)
        break
      case 'item/agentMessage/delta':
        this.#accumulate(this.#itemTexts, params)
        break
      case 'item/reasoning/summaryTextDelta':
        this.#accumulate(this.#reasoningTexts, params)
        break
      case 'item/reasoning/summaryPartAdded':
        // ★ 实测（0.144.0-alpha.4）：推理摘要新段落的标记帧，载荷只有
        //   itemId + summaryIndex，没有文本——文本随后由 summaryTextDelta 送达。
        //   无需累积，忽略即可（计数已在上方完成）。
        break
      case 'item/commandExecution/outputDelta':
        this.#accumulate(this.#toolOutputs, params)
        break
      case 'item/completed':
        this.#onItemCompleted(params)
        break
      case 'turn/completed':
        this.#onTurnCompleted(params)
        break
      case 'thread/tokenUsage/updated':
        this.#onTokenUsage(params)
        break
      case 'error':
        this.#onServerError(params)
        break
      default:
        // 未知通知方法：宽容忽略（上游加通知是常态），不崩、不计错
        break
    }
  }

  #emit(message: AgentMessage): void {
    this.#events.onMessage(message)
  }

  #accumulate(map: Map<string, string>, params: unknown): void {
    const p = asRecord(params)
    if (!p) return
    const itemId = asString(p['itemId'])
    const delta = deltaText(p)
    if (itemId && delta) {
      map.set(itemId, (map.get(itemId) ?? '') + delta)
    }
  }

  #onItemStarted(params: unknown): void {
    const item = asRecord(asRecord(params)?.['item'])
    if (!item) return
    const type = asString(item['type'])
    if (type === 'commandExecution') {
      // ★ 实测（0.157.1）：字段在 item 顶层（item.command / item.cwd / …），
      //   不是嵌套的 item.commandExecution。旧嵌套形状留作防御降级。
      const ce = asRecord(item['commandExecution'])
      const command = asString(item['command']) ?? asString(ce?.['command']) ?? ''
      this.#emit({
        type: 'tool_use',
        tool: 'command',
        content: command,
        input: ce ?? asRecord(item),
      })
    }
    // 其余类型在 item/completed 收尾时处理
  }

  #onItemCompleted(params: unknown): void {
    const item = asRecord(asRecord(params)?.['item'])
    if (!item) return
    const type = asString(item['type'])
    const itemId = asString(item['id'])
    switch (type) {
      case 'agentMessage': {
        const am = asRecord(item['agentMessage'])
        // ★ 实测（0.144.0-alpha.4）：权威文本在 `item.text`（不是 `item.agentMessage.content`）。
        //   保留后者与累积 delta 作防御降级（别的 app-server 版本可能用嵌套形状）。
        const content =
          asString(item['text']) ?? asString(am?.['content']) ?? this.#itemTexts.get(itemId ?? '') ?? ''
        this.#finalText = content
        this.#emit({ type: 'text', content })
        break
      }
      case 'reasoning': {
        // ★ 实测：`item.summary` 是字符串数组（推理摘要段落）；`content` 是分块数组。
        const re = asRecord(item['reasoning'])
        const summary =
          summaryText(item, '') || asString(re?.['summary']) || this.#reasoningTexts.get(itemId ?? '') || ''
        this.#emit({ type: 'thinking', content: summary })
        break
      }
      case 'commandExecution': {
        // ★ 实测（0.157.1）：字段在 item 顶层——命令 `item.command`、终态
        //   `item.status`、**输出只有 `item.aggregatedOutput`**（没有 outputDelta
        //   通知）。旧嵌套形状（item.commandExecution.output）留作防御降级。
        const ce = asRecord(item['commandExecution'])
        const status = asString(item['status']) ?? asString(ce?.['status'])
        const command = asString(item['command']) ?? asString(ce?.['command']) ?? ''
        const output =
          asString(item['aggregatedOutput']) ??
          asString(ce?.['output']) ??
          this.#toolOutputs.get(itemId ?? '') ??
          ''
        const content = output.slice(0, TOOL_OUTPUT_LIMIT)
        if (status === 'failed' || status === 'declined') {
          const detail =
            asString(item['error']) ??
            asString(ce?.['error']) ??
            (asInt(item['exitCode']) !== null ? `exitCode=${asInt(item['exitCode'])}` : '')
          this.#emit({
            type: 'error',
            content: `命令${status === 'declined' ? '被拒' : '失败'}：${command || detail}`,
          })
        }
        this.#emit({
          type: 'tool_result',
          tool: 'command',
          content,
          output: content,
          outputTruncated: output.length > TOOL_OUTPUT_LIMIT,
        })
        break
      }
      case 'fileChange': {
        // ★ 实测（0.144.0-alpha.4）：`item.changes: [{path, kind:{type}, diff}]` + `item.status`。
        //   保留旧的 `item.fileChange` 形状作防御降级。
        const fc = asRecord(item['fileChange'])
        const changes = Array.isArray(item['changes']) ? (item['changes'] as unknown[]) : []
        const first = asRecord(changes[0])
        const kind = asRecord(first?.['kind'])
        const path = asString(first?.['path']) ?? asString(fc?.['path']) ?? '?'
        const changeType = asString(kind?.['type']) ?? asString(fc?.['changeType']) ?? '?'
        const status = asString(item['status']) ?? asString(fc?.['status'])
        if (status === 'failed' || status === 'error') {
          this.#emit({
            type: 'error',
            content: `文件变更失败：${path}（${changeType}）`,
          })
        }
        this.#emit({
          type: 'tool_result',
          tool: 'file_change',
          content: `文件变更：${path}（${changeType}）`,
        })
        break
      }
      case 'mcpToolCall':
      case 'dynamicToolCall': {
        // ★ 实测（0.157.1）：字段在 item 顶层——工具名 `item.tool`、参数
        //   `item.arguments`、结果 `item.result.content[]`、错误 `item.error`。
        //   旧嵌套形状（item.mcpToolCall.toolName）留作防御降级。
        const call = asRecord(item['mcpToolCall'] ?? item['dynamicToolCall'])
        const toolName = asString(item['tool']) ?? asString(call?.['toolName']) ?? type
        const failed = asRecord(item['error']) !== null || asString(item['status']) === 'failed'
        const resultText = toolResultText(item) || (asString(call?.['result']) ?? '')
        this.#emit({
          type: 'tool_use',
          tool: toolName,
          content: '',
          input: asRecord(item['arguments']) ?? asRecord(call?.['input']),
        })
        if (failed) {
          this.#emit({
            type: 'error',
            content: `工具 ${toolName} 失败：${asString(asRecord(item['error'])?.['message']) ?? ''}`,
          })
        }
        this.#emit({
          type: 'tool_result',
          tool: toolName,
          content: resultText.slice(0, TOOL_OUTPUT_LIMIT),
        })
        break
      }
      case 'webSearch': {
        const ws = asRecord(item['webSearch'])
        const query = asString(item['query']) ?? asString(ws?.['query']) ?? ''
        this.#emit({ type: 'tool_result', tool: 'web_search', content: `搜索：${query}` })
        break
      }
      case 'error': {
        const e = asRecord(item['error'])
        const msg = asString(e?.['message']) ?? asString(e?.['error']) ?? 'item 错误'
        this.#emit({ type: 'error', content: msg })
        break
      }
      default:
        // userMessage / plan / imageView / reviewMode / contextCompaction / …：
        // 宽容忽略——不是我们关心的，也不算失败
        break
    }
  }

  #onTurnCompleted(params: unknown): void {
    const turn = asRecord(asRecord(params)?.['turn'])
    const rawStatus = asString(turn?.['status']) ?? 'failed'
    const errObj = asRecord(turn?.['error'])
    const error: CodexTurnEnd['error'] = errObj
      ? {
          message: asString(errObj['message']) ?? 'turn 失败',
          ...(asString(errObj['codexErrorInfo']) ? { codexErrorInfo: asString(errObj['codexErrorInfo'])! } : {}),
        }
      : null

    this.#resultSeen = true
    if (rawStatus === 'completed') {
      // ok
    } else if (rawStatus === 'interrupted') {
      if (!this.#interruptRequested) {
        this.#isError = true
        this.#errorText = 'turn 被中断，但平台没有发起取消——异常。'
        this.#emit({ type: 'error', content: this.#errorText })
      }
    } else {
      // failed（或未知状态，按失败处理）
      this.#isError = true
      this.#errorText = error
        ? error.codexErrorInfo
          ? `${error.message}（${error.codexErrorInfo}）`
          : error.message
        : 'turn 失败'
      this.#emit({ type: 'error', content: this.#errorText })
    }
    this.#turnEndResolve({
      status: rawStatus === 'completed' ? 'completed' : rawStatus === 'interrupted' ? 'interrupted' : 'failed',
      error,
    })
  }

  #onTokenUsage(params: unknown): void {
    // ★ 实测（0.144.0-alpha.4）：用量在 `params.tokenUsage.total`（不是 `params.usage`）。
    const tokenUsage = asRecord(asRecord(params)?.['tokenUsage'])
    const usage =
      asRecord(tokenUsage?.['total']) ??
      tokenUsage ?? // 防御：某些版本可能平铺在 tokenUsage 上
      asRecord(asRecord(params)?.['usage']) // 防御：旧假设形状
    if (!usage) return
    this.#usage = {
      // codex 不报告成本 ⇒ estimated（与 generic 的 toUsage 同一纪律）
      inputTokens: asInt(usage['inputTokens']) ?? asInt(usage['netNewInputTokens']) ?? 0,
      outputTokens: asInt(usage['outputTokens']) ?? 0,
      costUsdMicros: 0,
      costSource: 'estimated',
    }
  }

  #onServerError(params: unknown): void {
    const p = asRecord(params)
    const errObj = asRecord(p?.['error'])
    const msg = asString(errObj?.['message']) ?? asString(p?.['message']) ?? 'codex 服务端报告错误'
    if (asBool(p?.['willRetry'])) {
      // 可重试：只留痕迹，不把 run 判死（服务端自己会重试）
      this.#emit({ type: 'log', content: `（codex 服务端错误，将重试）：${msg}` })
      return
    }
    this.#isError = true
    this.#errorText = msg
    this.#emit({ type: 'error', content: msg })
  }
}

/**
 * 失败分级的结果（与 generic 同一套判据与优先级，见 `classifyGenericFailure`）。
 */
export type CodexFailure = 'cli_unparsable_output' | 'agent_error' | null

/**
 * 判定一次运行的终态是不是失败（FR-CLI-41）。
 *
 * 判据与 generic 完全同构：
 * 1. **没有任何可识别通知** ⇒ 不可解析（最要命：进程活着、字一个没听懂）；
 * 2. **没有终止帧**（`turn/completed`）⇒ 不可解析——"说完了"与"卡住了"无法区分；
 * 3. 其余按解析器自报的错误（TurnError / 服务端 error 通知）与退出码判定。
 */
export function classifyCodexFailure(input: {
  recognizedEvents: number
  resultSeen: boolean
  parserIsError: boolean
  exitCode: number | null
}): CodexFailure {
  const exitedNonZero = input.exitCode !== null && input.exitCode !== 0

  if (input.recognizedEvents === 0) return 'cli_unparsable_output'
  if (!input.resultSeen) return 'cli_unparsable_output'
  if (input.parserIsError || exitedNonZero) return 'agent_error'
  return null
}
