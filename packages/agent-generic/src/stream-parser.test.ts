import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentMessage } from '@alpha-helper/agent-core'
import {
  GENERIC_EVENT_TYPES,
  GenericStreamParser,
  MAX_LINE_BYTES,
  buildGenericInput,
  detectResumeRejection,
} from './stream-parser.ts'

/**
 * NDJSON 解析器的测试。
 *
 * 这里的重点不是"能解析正常输入"——那种测试很好写也很好过——而是
 * **失败边界**：什么情况下必须报错、什么情况下可以放过。
 * design §9.7 说得很直白：不可解析的输出必须让 run 失败，
 * 否则它会表现成"agent 什么都没说"，而那种故障最难查。
 */

function collect(): { parser: GenericStreamParser; messages: AgentMessage[] } {
  const messages: AgentMessage[] = []
  const parser = new GenericStreamParser({ onMessage: (m) => messages.push(m) })
  return { parser, messages }
}

const push = (parser: GenericStreamParser, event: unknown): boolean =>
  parser.push(JSON.stringify(event))

describe('generic NDJSON 解析 —— 正常路径', () => {
  test('text / thinking 归一化，并兼容 content / message 别名', () => {
    const { parser, messages } = collect()
    push(parser, { type: 'text', text: '正文' })
    push(parser, { type: 'text', content: '别名正文' })
    push(parser, { type: 'thinking', thinking: '想着呢' })
    push(parser, { type: 'thinking', text: '别思想法' })
    assert.deepEqual(
      messages.map((m) => m.type),
      ['text', 'text', 'thinking', 'thinking'],
    )
    assert.equal(messages[0]?.content, '正文')
    assert.equal(messages[1]?.content, '别名正文')
    assert.equal(messages[3]?.content, '别思想法')
  })

  test('tool_use 归一化，name 与 tool 两种写法都认', () => {
    const { parser, messages } = collect()
    push(parser, { type: 'tool_use', name: 'read_file', input: { path: 'a.txt' } })
    push(parser, { type: 'tool_use', tool: 'write_file' })
    assert.equal(messages[0]?.tool, 'read_file')
    assert.deepEqual(messages[0]?.input, { path: 'a.txt' })
    assert.match(messages[0]?.content ?? '', /read_file/)
    assert.equal(messages[1]?.tool, 'write_file')
    assert.equal(messages[1]?.input, null)
  })

  test('tool_result 归一化，超长输出被截断', () => {
    const { parser, messages } = collect()
    push(parser, { type: 'tool_result', name: 'read_file', output: 'x'.repeat(9000) })
    assert.equal(messages[0]?.type, 'tool_result')
    assert.equal(messages[0]?.outputTruncated, true)
    assert.ok((messages[0]?.output ?? '').length < 9000)
  })

  test('★ 工具失败（status:error）额外产出一条 error，不只留一段文本', () => {
    const { parser, messages } = collect()
    push(parser, { type: 'tool_result', name: 'read_file', output: '权限不足', status: 'error' })
    assert.deepEqual(
      messages.map((m) => m.type),
      ['tool_result', 'error'],
    )
    assert.equal(messages[1]?.tool, 'read_file')
  })

  test('result 提取终态、会话 ID 与用量（成本折算成整数微美元）', () => {
    const { parser } = collect()
    push(parser, {
      type: 'result',
      status: 'success',
      result: '任务完成。',
      session_id: 'sess-9',
      usage: { input_tokens: 100, output_tokens: 50, cost_usd: 0.012345 },
    })
    assert.equal(parser.resultSeen, true)
    assert.equal(parser.terminalOk, true)
    assert.equal(parser.isError, false)
    assert.equal(parser.finalText, '任务完成。')
    assert.equal(parser.sessionId, 'sess-9')
    assert.equal(parser.usage?.inputTokens, 100)
    assert.equal(parser.usage?.costUsdMicros, 12345, '成本用整数微美元避免浮点漂移')
    assert.equal(parser.usage?.costSource, 'provider')
  })

  test('★ 没给金额的用量标成估算而不是 provider —— 否则成本报表看着精确其实是空的', () => {
    const { parser } = collect()
    push(parser, { type: 'usage', input_tokens: 1, output_tokens: 2 })
    assert.equal(parser.usage?.costUsdMicros, 0)
    assert.equal(parser.usage?.costSource, 'estimated')
  })

  test('session_id 出现在任何事件上都能被读到（字段位置未验证的兜底）', () => {
    const { parser } = collect()
    push(parser, { type: 'session', session_id: 'from-session-event' })
    assert.equal(parser.sessionId, 'from-session-event')
    push(parser, { type: 'text', text: 'hi', session_id: 'from-text-event' })
    assert.equal(parser.sessionId, 'from-text-event')
  })

  test('result 报错时进入失败态并带错误文本', () => {
    const { parser, messages } = collect()
    push(parser, { type: 'result', status: 'error', result: '额度已用尽' })
    assert.equal(parser.isError, true)
    assert.equal(parser.terminalOk, false)
    assert.equal(parser.errorText, '额度已用尽')
    assert.equal(messages.at(-1)?.type, 'error')
  })

  test('error 事件单独出现也算失败，但不冒充终止事件', () => {
    const { parser, messages } = collect()
    push(parser, { type: 'error', message: '连不上模型服务' })
    assert.equal(parser.isError, true)
    assert.equal(parser.errorText, '连不上模型服务')
    assert.equal(parser.resultSeen, false, '中途报错之后 CLI 仍可能跑完并给终止事件')
    assert.equal(messages[0]?.type, 'error')
  })

  test('多条 error 事件按顺序累积，不互相覆盖', () => {
    const { parser } = collect()
    push(parser, { type: 'error', message: '第一条' })
    push(parser, { type: 'error', message: '第二条' })
    assert.equal(parser.errorText, '第一条\n第二条')
  })
})

describe('generic NDJSON 解析 —— 宽容与失败边界', () => {
  test('★ 未知事件名被忽略，不当场失败（上游加事件不该让我们崩）', () => {
    const { parser, messages } = collect()
    const recognized = push(parser, { type: 'future_event', data: 1 })
    assert.equal(recognized, false)
    assert.equal(messages.length, 0)
    assert.equal(parser.unparsableLines, 0, '不认识 ≠ 不可解析')
  })

  test('★ 非 JSON 行必须显式可见（带标记的 log + 计数），不得静默丢弃', () => {
    const { parser, messages } = collect()
    parser.push('这行不是 JSON')
    assert.equal(messages.length, 1, '必须留下一条消息，否则使用者看到的是"什么都没说"')
    assert.equal(messages[0]?.type, 'log')
    assert.match(messages[0]?.content ?? '', /不可解析/)
    assert.equal(parser.unparsableLines, 1)
  })

  test('★ 缺 type 字段的合法 JSON 对象同样计为不可解析', () => {
    const { parser, messages } = collect()
    push(parser, { session_id: 'x', hello: 'world' })
    assert.equal(parser.unparsableLines, 1)
    assert.match(messages[0]?.content ?? '', /缺少 type/)
  })

  test('★ JSON 但不是对象（数组 / 数字）计为不可解析', () => {
    const { parser } = collect()
    parser.push('[1,2,3]')
    parser.push('42')
    assert.equal(parser.unparsableLines, 2)
    assert.equal(parser.recognizedEvents, 0)
  })

  test('空行直接跳过，不计入异常计数（否则真信号会被噪声淹没）', () => {
    const { parser, messages } = collect()
    assert.equal(parser.push('   '), false)
    assert.equal(parser.push(''), false)
    assert.equal(messages.length, 0)
    assert.equal(parser.unparsableLines, 0)
  })

  test('★ 超长单行被拒并单独记账（FR-CLI-42：行长上限有界）', () => {
    const { parser, messages } = collect()
    parser.push('x'.repeat(MAX_LINE_BYTES + 1))
    assert.equal(messages[0]?.type, 'error')
    assert.match(messages[0]?.content ?? '', /超过上限/)
    assert.equal(parser.maxLineExceeded, true, '超长行与"格式变了"是不同故障，分开记')
    assert.equal(parser.unparsableLines, 1)
  })

  test('字段缺失时降级而不是失败', () => {
    const { parser, messages } = collect()
    push(parser, { type: 'tool_use' }) // 没有 name
    assert.equal(messages.length, 1, '无名工具仍报一条 tool_use')
    assert.equal(messages[0]?.tool, null)
    assert.equal(parser.unparsableLines, 0)

    push(parser, { type: 'text' }) // 没有正文
    assert.equal(messages.length, 1, '没有正文的 text 事件不产出消息，但也不算异常')
    assert.equal(parser.unparsableLines, 0)

    push(parser, { type: 'usage' }) // 一个数字都没有
    assert.equal(parser.usage, null)
    assert.equal(parser.unparsableLines, 0)
  })

  test('★ 没有终止事件时 resultSeen 为 false —— 后端据此判明确失败（FR-RUNTIME-07）', () => {
    const { parser } = collect()
    push(parser, { type: 'text', text: '我说了话' })
    push(parser, { type: 'tool_result', output: 'ok' })
    assert.equal(parser.resultSeen, false)
    assert.equal(parser.recognizedEvents, 2, '认得的事件数与"有没有跑完"是两件事')
  })

  test('事件名清单本身是被导出的常量，新增事件只需改一处', () => {
    assert.deepEqual(
      [...GENERIC_EVENT_TYPES],
      ['text', 'thinking', 'tool_use', 'tool_result', 'usage', 'result', 'error'],
    )
  })
})

describe('prompt 投递帧', () => {
  test('buildGenericInput 产出单行 JSON（换行不会破坏行分隔协议）', () => {
    const prompt = '第一行\n第二行 "带引号" \\ 反斜杠'
    const line = buildGenericInput(prompt)
    assert.equal(line.split('\n').length, 2, '单行 JSON + 末尾换行')
    const parsed = JSON.parse(line) as Record<string, unknown>
    assert.equal(parsed['type'], 'prompt')
    assert.equal(parsed['prompt'], prompt)
  })
})

describe('会话恢复被拒的识别（FR-CLI-06）', () => {
  test('识别常见的拒绝信息', () => {
    assert.equal(detectResumeRejection('Error: Unknown session abc'), true)
    assert.equal(detectResumeRejection('session not found'), true)
    assert.equal(detectResumeRejection('could not load session data'), true)
    assert.equal(detectResumeRejection('invalid session id'), true)
  })

  test('无关文本不误判', () => {
    assert.equal(detectResumeRejection('任务完成，一切正常'), false)
    assert.equal(detectResumeRejection(''), false)
  })
})
