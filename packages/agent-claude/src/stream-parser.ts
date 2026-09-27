import type { AgentMessage } from '@agentdeck/agent-core'
import type { TokenUsage } from '@agentdeck/protocol'

/**
 * Claude Code `--output-format stream-json` 的解析器。
 *
 * ══════════════════════════════════════════════════════════════════
 * 解析策略：**宽容读取，明确失败**
 * ══════════════════════════════════════════════════════════════════
 *
 * - 不认识的事件类型**忽略**（上游加新事件不该让我们崩）；
 * - 认识但字段缺失的**降级**（少一个字段不该让整次运行失败）；
 * - 但 `result` 事件缺失 ⇒ 这是"输出不可解析"，必须**明确报错**
 *   （FR-RUNTIME-07：不得静默失败）。
 *
 * ⚠️ **本解析器尚未对真实 CLI 版本验证**（design §16 R6）。
 *    字段名按 stream-json 的已知形状编写，首次接入真实环境时必须
 *    用实际输出核对一遍。所以下面每个分支都标了它期望的形状。
 */

/** 单行最大长度。超出即判为畸形输出，避免内存被拖垮（FR-CLI-42）。 */
export const MAX_LINE_BYTES = 32 * 1024 * 1024

export interface ClaudeStreamEvents {
  onMessage: (message: AgentMessage) => void
}

/** `{"type":"user","message":{"role":"user","content":[{"type":"text","text":...}]}}` */
export function buildClaudeInput(prompt: string): string {
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: prompt }] },
  })}\n`
}

interface UsageShape {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

function toUsage(raw: UsageShape | undefined, costUsd: number | undefined): TokenUsage | null {
  if (!raw) return null
  const input = (raw.input_tokens ?? 0) + (raw.cache_read_input_tokens ?? 0)
  const output = raw.output_tokens ?? 0
  // 成本用**整数微美元**，避免浮点漂移（design §11.3）
  const micros = costUsd === undefined ? 0 : Math.round(costUsd * 1_000_000)
  return {
    inputTokens: Math.max(0, Math.trunc(input)),
    outputTokens: Math.max(0, Math.trunc(output)),
    costUsdMicros: Math.max(0, micros),
    costSource: costUsd === undefined ? 'estimated' : 'provider',
  }
}

/** 会话恢复被拒的识别（FR-CLI-06）。 */
const RESUME_REJECTION_PATTERNS = [
  /no conversation found/i,
  /session (?:not found|does not exist)/i,
  /could not find (?:a )?(?:conversation|session)/i,
  /no such session/i,
  /invalid session/i,
  /resume.{0,20}(?:failed|not found)/i,
]

export function detectResumeRejection(text: string): boolean {
  return RESUME_REJECTION_PATTERNS.some((re) => re.test(text))
}

export class ClaudeStreamParser {
  #events: ClaudeStreamEvents
  #sessionId: string | null = null
  #model: string | null = null
  #usage: TokenUsage | null = null
  #finalText: string | null = null
  #isError = false
  #errorText: string | null = null
  #resultSeen = false
  #unparsableLines = 0

  constructor(events: ClaudeStreamEvents) {
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
  get resultSeen(): boolean {
    return this.#resultSeen
  }
  get unparsableLines(): number {
    return this.#unparsableLines
  }

  /** 解析一行。返回是否被识别为已知事件。 */
  push(line: string): boolean {
    const trimmed = line.trim()
    if (trimmed === '') return false

    if (trimmed.length > MAX_LINE_BYTES) {
      this.#unparsableLines++
      this.#emit({ type: 'error', content: '单行输出超过上限，已忽略' })
      return false
    }

    let event: Record<string, unknown>
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      // 非 JSON 行：不当错误——CLI 有时会打日志到 stdout
      this.#unparsableLines++
      this.#emit({ type: 'log', content: trimmed })
      return false
    }

    const type = typeof event['type'] === 'string' ? event['type'] : null
    switch (type) {
      case 'system':
        return this.#handleSystem(event)
      case 'assistant':
        return this.#handleAssistant(event)
      case 'user':
        return this.#handleUser(event)
      case 'result':
        return this.#handleResult(event)
      default:
        // 未知事件类型：忽略而不是报错（上游加新事件不该让我们崩）
        return false
    }
  }

  /** `{"type":"system","subtype":"init","session_id":...,"model":...,"tools":[...]}` */
  #handleSystem(event: Record<string, unknown>): boolean {
    if (typeof event['session_id'] === 'string') this.#sessionId = event['session_id']
    if (typeof event['model'] === 'string') this.#model = event['model']

    const tools = Array.isArray(event['tools']) ? event['tools'].length : null
    this.#emit({
      type: 'status',
      content: tools === null ? '会话已启动' : `会话已启动（${tools} 个工具可用）`,
    })
    return true
  }

  /** `{"type":"assistant","message":{"content":[{"type":"text","text":...}|{"type":"thinking",...}|{"type":"tool_use","name":...,"input":{...}}]}}` */
  #handleAssistant(event: Record<string, unknown>): boolean {
    if (typeof event['session_id'] === 'string') this.#sessionId = event['session_id']

    const message = event['message'] as Record<string, unknown> | undefined
    if (!message) return false
    if (typeof message['model'] === 'string') this.#model = message['model']

    const content = message['content']
    if (!Array.isArray(content)) return false

    for (const raw of content) {
      if (!raw || typeof raw !== 'object') continue
      const block = raw as Record<string, unknown>
      switch (block['type']) {
        case 'text':
          if (typeof block['text'] === 'string') {
            this.#emit({ type: 'text', content: block['text'] })
          }
          break
        case 'thinking':
          if (typeof block['thinking'] === 'string') {
            this.#emit({ type: 'thinking', content: block['thinking'] })
          }
          break
        case 'tool_use':
          this.#emit({
            type: 'tool_use',
            tool: typeof block['name'] === 'string' ? block['name'] : null,
            content: typeof block['name'] === 'string' ? `调用工具 ${block['name']}` : '调用工具',
            input:
              block['input'] && typeof block['input'] === 'object'
                ? (block['input'] as Record<string, unknown>)
                : null,
          })
          break
        default:
          break
      }
    }
    return true
  }

  /** `{"type":"user","message":{"content":[{"type":"tool_result","content":...,"is_error":bool}]}}` */
  #handleUser(event: Record<string, unknown>): boolean {
    const message = event['message'] as Record<string, unknown> | undefined
    const content = message?.['content']
    if (!Array.isArray(content)) return false

    for (const raw of content) {
      if (!raw || typeof raw !== 'object') continue
      const block = raw as Record<string, unknown>
      if (block['type'] !== 'tool_result') continue

      const text = extractText(block['content'])
      const truncated = text.length > 4000
      this.#emit({
        type: 'tool_result',
        tool: null,
        content: truncated ? `${text.slice(0, 4000)}…` : text,
        output: truncated ? `${text.slice(0, 4000)}…` : text,
        outputTruncated: truncated,
      })
    }
    return true
  }

  /**
   * `{"type":"result","subtype":"success"|"error_*","is_error":bool,
   *   "result":"...","duration_ms":...,"total_cost_usd":...,
   *   "session_id":"...","usage":{...}}`
   */
  #handleResult(event: Record<string, unknown>): boolean {
    this.#resultSeen = true
    if (typeof event['session_id'] === 'string') this.#sessionId = event['session_id']

    const isError = event['is_error'] === true
    const subtype = typeof event['subtype'] === 'string' ? event['subtype'] : ''
    this.#isError = isError || (subtype !== '' && subtype !== 'success')

    const resultText = typeof event['result'] === 'string' ? event['result'] : null
    if (resultText !== null) this.#finalText = resultText

    this.#usage = toUsage(
      event['usage'] as UsageShape | undefined,
      typeof event['total_cost_usd'] === 'number' ? event['total_cost_usd'] : undefined,
    )

    if (this.#isError) {
      this.#errorText = resultText ?? `运行以 ${subtype || '错误'} 结束`
      this.#emit({ type: 'error', content: this.#errorText })
    }

    return true
  }

  #emit(message: AgentMessage): void {
    this.#events.onMessage(message)
  }
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c
        if (c && typeof c === 'object' && typeof (c as Record<string, unknown>)['text'] === 'string') {
          return (c as Record<string, unknown>)['text'] as string
        }
        return ''
      })
      .join('')
  }
  if (content === null || content === undefined) return ''
  return JSON.stringify(content)
}
