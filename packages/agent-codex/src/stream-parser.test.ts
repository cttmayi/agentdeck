import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentMessage } from '@agentdeck/agent-core'
import {
  classifyCodexFailure,
  CodexStreamParser,
  CODEX_NOTIFICATIONS,
} from './stream-parser.ts'

/**
 * 通知流解析器的测试。载荷形状按**真实 app-server（0.144.0-alpha.4）实测**喂：
 * agentMessage 权威文本在 `item.text`、reasoning 摘要在 `item.summary[]`、
 * fileChange 在 `item.changes[]`、tokenUsage 在 `params.tokenUsage.total`
 * （设计稿 §7 核对结果）。旧假设形状（嵌套 agentMessage.content 等）专门留
 * 一条防御降级测试——别的 app-server 版本可能用嵌套形状。
 */

function makeParser() {
  const messages: AgentMessage[] = []
  const parser = new CodexStreamParser({ onMessage: (m) => messages.push(m) })
  return { parser, messages }
}

/** 一个完整的"ok"通知序列（与 fake-app-server 的 ok 剧本同构，实测形状）。 */
function feedOkSequence(parser: CodexStreamParser): void {
  // ★ 实测（0.157.1）：commandExecution 字段在 item 顶层，输出只在 aggregatedOutput
  parser.handleNotification('item/started', {
    threadId: 'thr_1',
    turnId: 'turn_1',
    item: { id: 'item_1', type: 'commandExecution', command: '/bin/zsh -lc ls', cwd: '/work', status: 'inProgress', exitCode: null },
  })
  parser.handleNotification('item/completed', {
    threadId: 'thr_1',
    turnId: 'turn_1',
    item: { id: 'item_1', type: 'commandExecution', command: '/bin/zsh -lc ls', cwd: '/work', status: 'completed', aggregatedOutput: 'a.txt\n', exitCode: 0 },
  })
  parser.handleNotification('item/started', {
    threadId: 'thr_1',
    turnId: 'turn_1',
    item: { id: 'item_2', type: 'agentMessage', text: '' },
  })
  parser.handleNotification('item/agentMessage/delta', {
    threadId: 'thr_1',
    turnId: 'turn_1',
    itemId: 'item_2',
    delta: { type: 'text', timestamp: 0, delta: '完成' },
  })
  parser.handleNotification('item/agentMessage/delta', {
    threadId: 'thr_1',
    turnId: 'turn_1',
    itemId: 'item_2',
    delta: '了：hello',
  })
  parser.handleNotification('item/completed', {
    threadId: 'thr_1',
    turnId: 'turn_1',
    item: { id: 'item_2', type: 'agentMessage', text: '完成了：hello' },
  })
  parser.handleNotification('item/started', {
    threadId: 'thr_1',
    turnId: 'turn_1',
    item: { id: 'item_3', type: 'reasoning', summary: [], content: [] },
  })
  parser.handleNotification('item/reasoning/summaryPartAdded', {
    threadId: 'thr_1',
    turnId: 'turn_1',
    itemId: 'item_3',
    summaryIndex: 0,
  })
  parser.handleNotification('item/reasoning/summaryTextDelta', {
    threadId: 'thr_1',
    turnId: 'turn_1',
    itemId: 'item_3',
    summaryIndex: 0,
    delta: '我在想',
  })
  parser.handleNotification('item/completed', {
    threadId: 'thr_1',
    turnId: 'turn_1',
    item: { id: 'item_3', type: 'reasoning', summary: ['我在想'], content: [] },
  })
  parser.handleNotification('thread/tokenUsage/updated', {
    threadId: 'thr_1',
    turnId: 'turn_1',
    tokenUsage: {
      total: { totalTokens: 140, inputTokens: 100, cachedInputTokens: 0, outputTokens: 40, reasoningOutputTokens: 0 },
      last: { totalTokens: 140, inputTokens: 100, cachedInputTokens: 0, outputTokens: 40, reasoningOutputTokens: 0 },
      modelContextWindow: 258400,
    },
  })
  parser.handleNotification('turn/completed', {
    threadId: 'thr_1',
    turn: { id: 'turn_1', status: 'completed', items: [], error: null },
  })
}

describe('CodexStreamParser（通知 → AgentMessage + 终态）', () => {
  test('★ 完整 ok 序列：工具、思考、最终文本、用量、终止帧', async () => {
    const { parser, messages } = makeParser()
    feedOkSequence(parser)

    const types = messages.map((m) => m.type)
    assert.ok(types.includes('tool_use'), '命令执行要发 tool_use')
    assert.ok(types.includes('tool_result'), '命令执行收尾要发 tool_result')
    assert.ok(types.includes('thinking'), 'reasoning 要发 thinking')
    assert.ok(types.includes('text'), 'agentMessage 要发 text')

    const text = messages.filter((m) => m.type === 'text')
    assert.equal(text.at(-1)!.content, '完成了：hello')
    assert.equal(parser.finalText, '完成了：hello')
    assert.equal(parser.resultSeen, true)
    assert.equal(parser.isError, false)
    assert.equal(parser.recognizedEvents, 12)
    assert.equal(parser.usage?.inputTokens, 100)
    assert.equal(parser.usage?.outputTokens, 40)
    assert.equal(parser.usage?.costSource, 'estimated', 'codex 不报成本 ⇒ estimated')

    // 命令的 tool_use 要带上命令本身、tool_result 要带上 aggregatedOutput
    const tu = messages.find((m) => m.type === 'tool_use')!
    assert.equal(tu.tool, 'command')
    assert.equal(tu.content, '/bin/zsh -lc ls')
    const tr = messages.find((m) => m.type === 'tool_result')!
    assert.equal(tr.tool, 'command')
    assert.equal(tr.content, 'a.txt\n')

    // turnEnd 已 resolve
    const end = await parser.turnEnd
    assert.equal(end.status, 'completed')
    assert.equal(end.error, null)
  })

  test('★ 防御降级：别的版本用旧嵌套形状（agentMessage.content / usage）也能读', async () => {
    const { parser, messages } = makeParser()
    parser.handleNotification('item/completed', {
      threadId: 'thr_1',
      turnId: 'turn_1',
      item: { id: 'item_2', type: 'agentMessage', agentMessage: { id: 'am_1', timestamp: 0, role: 'assistant', content: '旧形状的正文' } },
    })
    parser.handleNotification('item/completed', {
      threadId: 'thr_1',
      turnId: 'turn_1',
      item: { id: 'item_3', type: 'reasoning', reasoning: { id: 'r_1', timestamp: 0, summary: '旧形状的思考' } },
    })
    parser.handleNotification('thread/tokenUsage/updated', {
      threadId: 'thr_1',
      usage: { inputTokens: 11, outputTokens: 22, totalTokens: 33 },
    })
    parser.handleNotification('turn/completed', {
      threadId: 'thr_1',
      turn: { id: 'turn_1', status: 'completed', items: [], error: null },
    })
    assert.equal(parser.finalText, '旧形状的正文')
    assert.ok(messages.some((m) => m.type === 'thinking' && m.content === '旧形状的思考'))
    assert.equal(parser.usage?.inputTokens, 11)
    assert.equal(parser.usage?.outputTokens, 22)
  })

  test('★ fileChange（实测形状：changes[] + status）→ tool_result；failed 再发 error', async () => {
    const { parser, messages } = makeParser()
    parser.handleNotification('item/completed', {
      threadId: 'thr_1',
      turnId: 'turn_1',
      item: {
        id: 'call_1',
        type: 'fileChange',
        changes: [{ path: '/tmp/result.txt', kind: { type: 'add' }, diff: 'done\n' }],
        status: 'failed',
      },
    })
    const tr = messages.find((m) => m.type === 'tool_result')!
    assert.equal(tr.tool, 'file_change')
    assert.match(tr.content ?? '', /\/tmp\/result\.txt（add）/)
    assert.ok(messages.some((m) => m.type === 'error' && /文件变更失败/.test(m.content)))
  })

  test('★ mcpToolCall（实测 0.157.1 扁平形状）→ 真工具名 + result 文本 + error', async () => {
    const { parser, messages } = makeParser()
    parser.handleNotification('item/completed', {
      threadId: 'thr_1',
      turnId: 'turn_1',
      item: {
        id: 'call_1',
        type: 'mcpToolCall',
        server: 'codex',
        tool: 'list_mcp_resources',
        status: 'completed',
        arguments: {},
        result: { content: [{ type: 'text', text: '{"resources":[]}' }] },
        error: null,
        durationMs: 0,
      },
    })
    const tu = messages.find((m) => m.type === 'tool_use')!
    assert.equal(tu.tool, 'list_mcp_resources')
    assert.equal(tu.content, '')
    const tr = messages.find((m) => m.type === 'tool_result')!
    assert.equal(tr.tool, 'list_mcp_resources')
    assert.equal(tr.content, '{"resources":[]}')

    // 失败的 mcpToolCall：报 error
    const { parser: p2, messages: m2 } = makeParser()
    p2.handleNotification('item/completed', {
      threadId: 'thr_1',
      turnId: 'turn_1',
      item: {
        id: 'call_2',
        type: 'mcpToolCall',
        server: 'codex',
        tool: 'resources_read',
        status: 'failed',
        arguments: {},
        result: null,
        error: { message: 'unknown MCP server x' },
      },
    })
    assert.ok(m2.some((m) => m.type === 'error' && /unknown MCP server x/.test(m.content)))
  })

  test('★ commandExecution 失败（扁平形状）→ error 带上命令与 exitCode', async () => {
    const { parser, messages } = makeParser()
    parser.handleNotification('item/completed', {
      threadId: 'thr_1',
      turnId: 'turn_1',
      item: {
        id: 'call_1',
        type: 'commandExecution',
        command: '/bin/zsh -lc rm -rf /',
        status: 'failed',
        aggregatedOutput: 'permission denied',
        exitCode: 1,
      },
    })
    const err = messages.find((m) => m.type === 'error')!
    assert.match(err.content, /命令失败：\/bin\/zsh -lc rm -rf \//)
    const tr = messages.find((m) => m.type === 'tool_result')!
    assert.equal(tr.content, 'permission denied')
  })

  test('★ 防御降级：旧嵌套 commandExecution + outputDelta 累积仍能读', () => {
    const { parser, messages } = makeParser()
    parser.handleNotification('item/started', {
      threadId: 'thr_1',
      turnId: 'turn_1',
      item: { id: 'item_1', type: 'commandExecution', commandExecution: { id: 'ce_1', command: 'ls', status: 'inProgress' } },
    })
    parser.handleNotification('item/commandExecution/outputDelta', {
      threadId: 'thr_1',
      turnId: 'turn_1',
      itemId: 'item_1',
      delta: { type: 'text', timestamp: 0, delta: 'a.txt\n' },
    })
    parser.handleNotification('item/completed', {
      threadId: 'thr_1',
      turnId: 'turn_1',
      item: { id: 'item_1', type: 'commandExecution', commandExecution: { id: 'ce_1', command: 'ls', status: 'completed' } },
    })
    const tu = messages.find((m) => m.type === 'tool_use')!
    assert.equal(tu.content, 'ls')
    const tr = messages.find((m) => m.type === 'tool_result')!
    assert.equal(tr.content, 'a.txt\n', '旧版本靠 outputDelta 累积出输出')
  })

  test('★ 工具输出超长被截断并标记', () => {
    const { parser, messages } = makeParser()
    parser.handleNotification('item/completed', {
      threadId: 'thr_1',
      turnId: 'turn_1',
      item: { id: 'item_1', type: 'commandExecution', commandExecution: { id: 'ce_1', command: 'cat', status: 'completed', output: 'x'.repeat(9000) } },
    })
    const tr = messages.find((m) => m.type === 'tool_result')!
    assert.equal(tr.outputTruncated, true)
    assert.equal(tr.content!.length, 4000)
  })

  test('★ turn failed → isError，错误文本带上 codexErrorInfo', async () => {
    const { parser, messages } = makeParser()
    parser.handleNotification('turn/completed', {
      threadId: 'thr_1',
      turn: {
        id: 'turn_1',
        status: 'failed',
        items: [],
        error: { message: 'Usage limit exceeded', codexErrorInfo: 'UsageLimitExceeded' },
      },
    })
    assert.equal(parser.resultSeen, true)
    assert.equal(parser.isError, true)
    assert.match(parser.errorText!, /Usage limit exceeded/)
    assert.match(parser.errorText!, /UsageLimitExceeded/)
    assert.ok(messages.some((m) => m.type === 'error'))
    const end = await parser.turnEnd
    assert.equal(end.status, 'failed')
    assert.equal(end.error?.codexErrorInfo, 'UsageLimitExceeded')
  })

  test('★ interrupted 但平台没发起取消 → 异常', async () => {
    const { parser } = makeParser()
    parser.handleNotification('turn/completed', {
      threadId: 'thr_1',
      turn: { id: 'turn_1', status: 'interrupted', items: [], error: null },
    })
    assert.equal(parser.isError, true)
    assert.match(parser.errorText!, /中断/)
  })

  test('★ interrupted 且平台已请求取消 → 不算异常', async () => {
    const { parser } = makeParser()
    parser.noteInterruptRequested()
    parser.handleNotification('turn/completed', {
      threadId: 'thr_1',
      turn: { id: 'turn_1', status: 'interrupted', items: [], error: null },
    })
    assert.equal(parser.isError, false)
    assert.equal(parser.resultSeen, true)
  })

  test('★ 服务端 error 通知：willRetry=true 不判死，否则判死', () => {
    const retry = makeParser()
    retry.parser.handleNotification('error', { error: { message: 'HttpConnectionFailed' }, willRetry: true })
    assert.equal(retry.parser.isError, false, '可重试：不判死')
    assert.ok(retry.messages.some((m) => m.type === 'log'))

    const fatal = makeParser()
    fatal.parser.handleNotification('error', { error: { message: 'Unauthorized' }, willRetry: false })
    assert.equal(fatal.parser.isError, true)
    assert.match(fatal.parser.errorText!, /Unauthorized/)
  })

  test('★ 未知通知方法：宽容忽略，只计数不崩', () => {
    const { parser } = makeParser()
    parser.handleNotification('thread/name/updated', { threadId: 'thr_1', name: 'x' })
    parser.handleNotification('item/webSearch/started', { threadId: 'thr_1' })
    assert.equal(parser.recognizedEvents, 2)
    assert.equal(parser.isError, false)
  })

  test('★ 裸行 → 发可见的 log 消息并计数（判定归后端）', () => {
    const { parser, messages } = makeParser()
    parser.handleUnparsable('这不是 JSON')
    assert.equal(parser.unparsableLines, 1)
    assert.ok(messages.some((m) => m.type === 'log' && /不可解析/.test(m.content)))
    assert.equal(parser.resultSeen, false, '裸行不算终止帧')
  })

  test('★ markFailed（请求阶段失败）→ 当作 failed 终止帧', async () => {
    const { parser, messages } = makeParser()
    parser.markFailed('codex 服务端拒绝了请求：thread not found（code=-32602）')
    assert.equal(parser.resultSeen, true)
    assert.equal(parser.isError, true)
    assert.ok(messages.some((m) => m.type === 'error'))
    const end = await parser.turnEnd
    assert.equal(end.status, 'failed')
  })

  test('★ 通知方法名清单与 facts 一致（单一事实源）', () => {
    assert.deepEqual(
      [...CODEX_NOTIFICATIONS].sort(),
      [
        'error',
        'item/agentMessage/delta',
        'item/commandExecution/outputDelta',
        'item/completed',
        'item/reasoning/summaryPartAdded',
        'item/reasoning/summaryTextDelta',
        'item/started',
        'thread/tokenUsage/updated',
        'turn/completed',
      ].sort(),
    )
  })
})

describe('classifyCodexFailure（失败分级，与 generic 同构）', () => {
  test('★ 没有任何可识别通知 → 不可解析', () => {
    assert.equal(
      classifyCodexFailure({ recognizedEvents: 0, resultSeen: false, parserIsError: false, exitCode: 0 }),
      'cli_unparsable_output',
    )
  })

  test('★ 有事件但没有终止帧 → 不可解析（"说完了"与"卡住了"无法区分）', () => {
    assert.equal(
      classifyCodexFailure({ recognizedEvents: 3, resultSeen: false, parserIsError: false, exitCode: 0 }),
      'cli_unparsable_output',
    )
  })

  test('★ 解析器自报错误 → agent_error', () => {
    assert.equal(
      classifyCodexFailure({ recognizedEvents: 3, resultSeen: true, parserIsError: true, exitCode: 0 }),
      'agent_error',
    )
  })

  test('★ 非零退出码 → agent_error', () => {
    assert.equal(
      classifyCodexFailure({ recognizedEvents: 3, resultSeen: true, parserIsError: false, exitCode: 1 }),
      'agent_error',
    )
  })

  test('★ 正常 → null', () => {
    assert.equal(
      classifyCodexFailure({ recognizedEvents: 3, resultSeen: true, parserIsError: false, exitCode: 0 }),
      null,
    )
  })
})
