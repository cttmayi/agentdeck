import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentMessage } from '@alpha-helper/agent-core'
import {
  ClaudeStreamParser,
  MAX_LINE_BYTES,
  buildClaudeInput,
  detectResumeRejection,
} from './stream-parser.ts'

function collect(): { parser: ClaudeStreamParser; messages: AgentMessage[] } {
  const messages: AgentMessage[] = []
  const parser = new ClaudeStreamParser({ onMessage: (m) => messages.push(m) })
  return { parser, messages }
}

describe('Claude stream-json 解析 —— 正常路径', () => {
  test('system/init 提取 sessionId 与 model，并报一条状态', () => {
    const { parser, messages } = collect()
    parser.push(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        model: 'claude-sonnet-4-5',
        tools: ['Read', 'Write'],
      }),
    )
    assert.equal(parser.sessionId, 'sess-1')
    assert.equal(parser.model, 'claude-sonnet-4-5')
    assert.equal(messages[0]?.type, 'status')
    assert.match(messages[0]?.content ?? '', /2 个工具/)
  })

  test('assistant 的 text / thinking / tool_use 分别归一化', () => {
    const { parser, messages } = collect()
    parser.push(
      JSON.stringify({
        type: 'assistant',
        session_id: 's1',
        message: {
          model: 'claude-sonnet-4-5',
          content: [
            { type: 'thinking', thinking: '先看看文件' },
            { type: 'text', text: '我来分析一下。' },
            { type: 'tool_use', name: 'Read', input: { file_path: '/a.ts' } },
          ],
        },
      }),
    )
    assert.deepEqual(
      messages.map((m) => m.type),
      ['thinking', 'text', 'tool_use'],
    )
    assert.equal(messages[0]?.content, '先看看文件')
    assert.equal(messages[1]?.content, '我来分析一下。')
    assert.equal(messages[2]?.tool, 'Read')
    assert.deepEqual(messages[2]?.input, { file_path: '/a.ts' })
    assert.equal(parser.model, 'claude-sonnet-4-5')
  })

  test('user 的 tool_result 被归一化，超长输出被截断', () => {
    const { parser, messages } = collect()
    const longText = 'x'.repeat(6000)
    parser.push(
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', content: longText }] },
      }),
    )
    assert.equal(messages[0]?.type, 'tool_result')
    assert.equal(messages[0]?.outputTruncated, true)
    assert.ok((messages[0]?.output ?? '').length < longText.length)
  })

  test('tool_result 的 content 可以是块数组', () => {
    const { parser, messages } = collect()
    parser.push(
      JSON.stringify({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', content: [{ type: 'text', text: 'ok' }] }],
        },
      }),
    )
    assert.equal(messages[0]?.output, 'ok')
    assert.equal(messages[0]?.outputTruncated, false)
  })

  test('result 提取终态、耗时与用量', () => {
    const { parser } = collect()
    parser.push(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: '任务完成。',
        duration_ms: 1234,
        total_cost_usd: 0.012345,
        session_id: 'sess-9',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 5,
        },
      }),
    )
    assert.equal(parser.resultSeen, true)
    assert.equal(parser.isError, false)
    assert.equal(parser.finalText, '任务完成。')
    assert.equal(parser.sessionId, 'sess-9')
    assert.equal(parser.usage?.inputTokens, 120, '缓存读入应计入输入')
    assert.equal(parser.usage?.outputTokens, 50)
    assert.equal(parser.usage?.costUsdMicros, 12345, '成本用整数微美元')
    assert.equal(parser.usage?.costSource, 'provider')
  })

  test('没有 provider 成本时标注为估算', () => {
    const { parser } = collect()
    parser.push(
      JSON.stringify({ type: 'result', subtype: 'success', usage: { input_tokens: 1 } }),
    )
    assert.equal(parser.usage?.costSource, 'estimated')
    assert.equal(parser.usage?.costUsdMicros, 0)
  })

  test('result 报错时进入失败态并带错误文本', () => {
    const { parser, messages } = collect()
    parser.push(
      JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: '配额已用尽',
      }),
    )
    assert.equal(parser.isError, true)
    assert.equal(parser.errorText, '配额已用尽')
    assert.equal(messages.at(-1)?.type, 'error')
  })

  test('subtype 非 success 即便 is_error 缺失也算失败', () => {
    const { parser } = collect()
    parser.push(JSON.stringify({ type: 'result', subtype: 'error_max_turns' }))
    assert.equal(parser.isError, true)
  })
})

describe('Claude stream-json 解析 —— 宽容与失败边界', () => {
  test('★ 未知事件类型被忽略，不抛错（上游加新事件不该让我们崩）', () => {
    const { parser, messages } = collect()
    const recognized = parser.push(JSON.stringify({ type: 'future_event', data: 1 }))
    assert.equal(recognized, false)
    assert.equal(messages.length, 0)
  })

  test('非 JSON 行归类为 log，不算错误', () => {
    const { parser, messages } = collect()
    parser.push('这行不是 JSON，是 CLI 打到 stdout 的日志')
    assert.equal(messages[0]?.type, 'log')
    assert.equal(parser.unparsableLines, 1)
  })

  test('空行直接跳过', () => {
    const { parser, messages } = collect()
    assert.equal(parser.push('   '), false)
    assert.equal(messages.length, 0)
    assert.equal(parser.unparsableLines, 0)
  })

  test('字段缺失时降级而不是失败', () => {
    const { parser, messages } = collect()
    parser.push(JSON.stringify({ type: 'assistant', message: {} }))
    assert.equal(messages.length, 0)
    parser.push(JSON.stringify({ type: 'assistant' }))
    assert.equal(messages.length, 0)
  })

  test('★ 超长单行被拒（FR-CLI-42：防止畸形输出耗尽内存）', () => {
    const { parser, messages } = collect()
    parser.push('x'.repeat(MAX_LINE_BYTES + 1))
    assert.equal(messages[0]?.type, 'error')
    assert.match(messages[0]?.content ?? '', /超过上限/)
  })

  test('★ result 缺失 = 输出不可解析，由后端判为明确失败（不是"跑完了但没内容"）', () => {
    const { parser } = collect()
    parser.push(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }))
    parser.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }))
    assert.equal(parser.resultSeen, false, '没有 result 事件')
  })
})

describe('输入格式', () => {
  test('buildClaudeInput 产出 stream-json 的 user 消息', () => {
    const line = buildClaudeInput('做点事')
    assert.ok(line.endsWith('\n'))
    const parsed = JSON.parse(line) as Record<string, unknown>
    assert.equal(parsed['type'], 'user')
    const message = parsed['message'] as Record<string, unknown>
    assert.equal(message['role'], 'user')
    const content = message['content'] as Array<Record<string, unknown>>
    assert.equal(content[0]?.['type'], 'text')
    assert.equal(content[0]?.['text'], '做点事')
  })

  test('prompt 里的换行与引号被正确转义（不能破坏行分隔协议）', () => {
    const prompt = '第一行\n第二行 "带引号" \\ 反斜杠'
    const line = buildClaudeInput(prompt)
    assert.equal(line.split('\n').length, 2, '单行 JSON + 末尾换行')
    const parsed = JSON.parse(line) as Record<string, unknown>
    const content = (parsed['message'] as Record<string, unknown>)['content'] as Array<
      Record<string, unknown>
    >
    assert.equal(content[0]?.['text'], prompt)
  })
})

describe('会话恢复被拒的识别（FR-CLI-06）', () => {
  test('识别常见的拒绝信息', () => {
    assert.equal(detectResumeRejection('Error: No conversation found with session ID abc'), true)
    assert.equal(detectResumeRejection('session not found'), true)
    assert.equal(detectResumeRejection('Could not find a conversation to resume'), true)
    assert.equal(detectResumeRejection('invalid session id'), true)
  })

  test('无关文本不误判', () => {
    assert.equal(detectResumeRejection('任务完成，一切正常'), false)
    assert.equal(detectResumeRejection(''), false)
  })
})
