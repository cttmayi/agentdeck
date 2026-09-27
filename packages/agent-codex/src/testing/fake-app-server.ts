/**
 * 假 codex app-server —— 测试用的假可执行文件（NFR-T-01）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么不能拿真 codex 测
 * ══════════════════════════════════════════════════════════════════
 *
 * 跑真 codex 会**消耗使用者的真实额度**，而且它会真的改文件。所以适配器测试
 * 里的"app-server"永远是本文件这种假货：一个 Node 进程，按 JSON-RPC 2.0
 * 协议帧回话，行为由剧本决定。协议形状（方法名、通知名、载荷字段）与
 * **真实 app-server（0.144.0-alpha.4）实测一致**（v2 协议，camelCase）：
 * agentMessage 权威文本在 `item.text`、reasoning 摘要在 `item.summary[]`、
 * tokenUsage 在 `params.tokenUsage.total`、resume 拒绝回 `-32600`。
 * 残余未实测的工具类 item 形状（commandExecution 等）按源码/文档（见
 * `unverifiedFields()`）——假 server 里它们保留旧假设形状，恰好当防御降级
 * 的回归样例。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么剧本用环境变量选、收到的请求要落盘
 * ══════════════════════════════════════════════════════════════════
 *
 * 与 generic 的 fake-cli 同一套理由：命令行参数正是被测对象之一（这里是
 * `codex app-server --stdio` 的启动 argv），用参数选剧本就分不清"参数没传到"
 * 和"剧本选错了"。收到的 JSON-RPC 请求经 `FAKE_RPC_ECHO_FILE` 落盘，后端测试
 * 因此能断言**进程实际收到的参数**（thread/start 的 approvalPolicy、model、
 * cwd；turn/start 的 input 文本），而不是断言我们对协议的猜测。
 */

import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const SCENARIO = process.env['FAKE_SCENARIO'] ?? 'ok'
const echoFile = process.env['FAKE_RPC_ECHO_FILE']

// 版本探测（`probe()` 会调 detectVersion）必须**早返回**：否则剧本的帧会
// 和版本号混在一起，`detectVersion` 取第一行就会拿到剧本的第一帧。
if (process.argv.includes('--version')) {
  process.stdout.write('codex 0.0.0-fake\n')
  process.exit(0)
}

const send = (frame: unknown): void => {
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}
const notify = (method: string, params: unknown): void => {
  send({ method, params })
}

const requests: Array<{ id: number; method: string; params: unknown }> = []
let approvalDecision: unknown = null

function recordRequest(id: number, method: string, params: unknown): void {
  requests.push({ id, method, params })
  if (echoFile) {
    writeFileSync(echoFile, JSON.stringify({ requests, approvalDecision }, null, 2), 'utf8')
  }
}

const respond = (id: number, result: unknown): void => {
  send({ id, result })
}
const respondError = (id: number, error: { code: number; message: string }): void => {
  send({ id, error })
}

const THREAD_ID = 'thr_fake-1'
const TURN_ID = 'turn_fake-1'

// ── 剧本：turn/start 之后服务端发什么 ────────────────────────────
function runScenario(): void {
  switch (SCENARIO) {
    case 'ok': {
      notify('turn/started', {
        threadId: THREAD_ID,
        turn: { id: TURN_ID, status: 'inProgress', items: [], error: null },
      })
      // ★ 实测（0.157.1）：commandExecution 字段在 item 顶层（item.command /
      //   item.status / item.aggregatedOutput），且没有 outputDelta 通知。
      notify('item/started', {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        item: {
          id: 'item_1',
          type: 'commandExecution',
          command: '/bin/zsh -lc ls',
          cwd: '/work',
          processId: '1234',
          status: 'inProgress',
          aggregatedOutput: null,
          exitCode: null,
        },
      })
      notify('item/completed', {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        item: {
          id: 'item_1',
          type: 'commandExecution',
          command: '/bin/zsh -lc ls',
          cwd: '/work',
          processId: '1234',
          status: 'completed',
          aggregatedOutput: 'a.txt\n',
          exitCode: 0,
        },
      })
      notify('item/started', {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        item: { id: 'item_2', type: 'agentMessage', text: '' },
      })
      // 两种 delta 形状都来一遍：`{delta:{…,delta}}` 与裸字符串
      notify('item/agentMessage/delta', {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        itemId: 'item_2',
        delta: { type: 'text', timestamp: 0, delta: '完成' },
      })
      notify('item/agentMessage/delta', {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        itemId: 'item_2',
        delta: '了：hello',
      })
      // ★ 实测形状：权威文本在 item.text（不是 item.agentMessage.content）
      notify('item/completed', {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        item: { id: 'item_2', type: 'agentMessage', text: '完成了：hello' },
      })
      notify('item/started', {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        item: { id: 'item_3', type: 'reasoning', summary: [], content: [] },
      })
      notify('item/reasoning/summaryPartAdded', {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        itemId: 'item_3',
        summaryIndex: 0,
      })
      notify('item/reasoning/summaryTextDelta', {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        itemId: 'item_3',
        summaryIndex: 0,
        delta: '我在想',
      })
      // ★ 实测形状：摘要段落数组 item.summary
      notify('item/completed', {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        item: { id: 'item_3', type: 'reasoning', summary: ['我在想'], content: [] },
      })
      // ★ 实测形状：用量在 params.tokenUsage.total
      notify('thread/tokenUsage/updated', {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        tokenUsage: {
          total: { totalTokens: 140, inputTokens: 100, cachedInputTokens: 0, outputTokens: 40, reasoningOutputTokens: 0 },
          last: { totalTokens: 140, inputTokens: 100, cachedInputTokens: 0, outputTokens: 40, reasoningOutputTokens: 0 },
          modelContextWindow: 258400,
        },
      })
      notify('turn/completed', {
        threadId: THREAD_ID,
        turn: { id: TURN_ID, status: 'completed', items: [], error: null },
      })
      break
    }

    case 'failed-turn': {
      notify('item/started', {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        item: { id: 'item_1', type: 'agentMessage', agentMessage: { id: 'am_1', timestamp: 0, role: 'assistant', content: '' } },
      })
      notify('item/completed', {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        item: { id: 'item_1', type: 'agentMessage', agentMessage: { id: 'am_1', timestamp: 0, role: 'assistant', content: '我试了但不行' } },
      })
      notify('turn/completed', {
        threadId: THREAD_ID,
        turn: {
          id: TURN_ID,
          status: 'failed',
          items: [],
          error: { message: 'Usage limit exceeded', codexErrorInfo: 'UsageLimitExceeded' },
        },
      })
      break
    }

    case 'resume-missing': {
      // 恢复被拒 → 后端回退新线程继续：这里给一个正常完成的 turn
      notify('item/started', {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        item: { id: 'item_1', type: 'agentMessage', text: '' },
      })
      notify('item/completed', {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        item: { id: 'item_1', type: 'agentMessage', text: '我换了个新线程继续' },
      })
      notify('turn/completed', {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        turn: { id: TURN_ID, status: 'completed', items: [], error: null },
      })
      break
    }

    case 'unexpected-interrupt': {
      // 平台没发起取消，服务端自己说 turn 被中断——异常
      notify('turn/completed', {
        threadId: THREAD_ID,
        turn: { id: TURN_ID, status: 'interrupted', items: [], error: null },
      })
      break
    }

    case 'garbled': {
      notify('item/started', {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        item: { id: 'item_1', type: 'agentMessage', agentMessage: { id: 'am_1', timestamp: 0, role: 'assistant', content: '' } },
      })
      process.stdout.write('这一行不是 JSON，是服务端打混的诊断信息\n')
      notify('item/agentMessage/delta', {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        itemId: 'item_1',
        delta: { type: 'text', timestamp: 0, delta: '我开始了' },
      })
      process.stdout.write('{ 这不是合法的 JSON\n')
      notify('item/completed', {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        item: { id: 'item_1', type: 'agentMessage', agentMessage: { id: 'am_1', timestamp: 0, role: 'assistant', content: '我开始了' } },
      })
      notify('turn/completed', {
        threadId: THREAD_ID,
        turn: { id: TURN_ID, status: 'completed', items: [], error: null },
      })
      break
    }

    case 'no-turn-end': {
      // 有事件、有内容，但**没有终止帧**：格式可能变了，进程干净退出
      notify('item/started', {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        item: { id: 'item_1', type: 'agentMessage', agentMessage: { id: 'am_1', timestamp: 0, role: 'assistant', content: '' } },
      })
      notify('item/completed', {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        item: { id: 'item_1', type: 'agentMessage', agentMessage: { id: 'am_1', timestamp: 0, role: 'assistant', content: '我说了话，但没有 turn/completed' } },
      })
      setTimeout(() => process.exit(0), 50)
      break
    }

    case 'empty': {
      // stdout 上什么都没有：最像"agent 什么都没说"的形态
      setTimeout(() => process.exit(0), 50)
      break
    }

    case 'stderr-crash': {
      process.stderr.write("Error: cannot open app server\n")
      process.exitCode = 1
      setTimeout(() => process.exit(1), 50)
      break
    }

    case 'approval': {
      // ★ 服务端主动发审批请求（approvalPolicy:never 下不应出现——防御路径）。
      //   后端必须回 `{decision:'decline'}`，否则这个 turn 会一直挂着。
      send({
        id: 200,
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          itemId: 'item_9',
          request: { tool: 'command', command: 'rm -rf /' },
        },
      })
      setTimeout(() => {
        notify('item/started', {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          item: { id: 'item_9', type: 'commandExecution', commandExecution: { id: 'ce_9', command: 'rm -rf /', status: 'declined' } },
        })
        notify('item/completed', {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          item: { id: 'item_9', type: 'commandExecution', commandExecution: { id: 'ce_9', command: 'rm -rf /', status: 'declined' } },
        })
        notify('turn/completed', {
          threadId: THREAD_ID,
          turn: { id: TURN_ID, status: 'completed', items: [], error: null },
        })
      }, 100)
      break
    }

    case 'slow': {
      // 慢 turn：cancel 测试用（平台在它结束前打断）
      notify('item/started', {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        item: { id: 'item_1', type: 'agentMessage', agentMessage: { id: 'am_1', timestamp: 0, role: 'assistant', content: '' } },
      })
      notify('item/agentMessage/delta', {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        itemId: 'item_1',
        delta: { type: 'text', timestamp: 0, delta: '我还在干活' },
      })
      setTimeout(() => {
        notify('item/completed', {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          item: { id: 'item_1', type: 'agentMessage', agentMessage: { id: 'am_1', timestamp: 0, role: 'assistant', content: '我还在干活' } },
        })
        notify('turn/completed', {
          threadId: THREAD_ID,
          turn: { id: TURN_ID, status: 'completed', items: [], error: null },
        })
      }, 300)
      break
    }

    default:
      process.stderr.write(`未知剧本：${SCENARIO}\n`)
      process.exitCode = 64
  }
}

// ── 入站帧路由 ───────────────────────────────────────────────────
const rl = createInterface({ input: process.stdin })

rl.on('line', (line) => {
  let msg: Record<string, unknown> | null = null
  try {
    const parsed: unknown = JSON.parse(line)
    if (typeof parsed === 'object' && parsed !== null) msg = parsed as Record<string, unknown>
  } catch {
    return
  }
  if (!msg) return

  const id = msg['id']
  if (typeof id === 'number') {
    // 服务端自己发出的请求（id=200）的回应
    if (id === 200 && msg['result'] !== undefined) {
      approvalDecision = msg['result']
      if (echoFile) {
        writeFileSync(echoFile, JSON.stringify({ requests, approvalDecision }, null, 2), 'utf8')
      }
      return
    }
    const method = typeof msg['method'] === 'string' ? msg['method'] : ''
    const params = (msg['params'] ?? {}) as Record<string, unknown>
    recordRequest(id, method, params)
    switch (method) {
      case 'initialize':
        respond(id, { userAgent: 'codex/0.0.0-fake' })
        break
      case 'thread/start':
        respond(id, {
          thread: { id: THREAD_ID, status: 'idle', preview: '', cwd: params['cwd'] ?? null },
          model: 'fake-model',
          modelProvider: 'fake-provider',
        })
        break
      case 'thread/resume':
        if (SCENARIO === 'resume-missing' && params['threadId'] === 'thr_missing') {
          respondError(id, { code: -32600, message: 'no rollout found for thread id thr_missing' })
        } else {
          respond(id, { thread: { id: params['threadId'] ?? THREAD_ID } })
        }
        break
      case 'turn/start':
        respond(id, { turn: { id: TURN_ID, status: 'inProgress', items: [], error: null } })
        runScenario()
        break
      case 'turn/interrupt':
        respond(id, {})
        notify('turn/completed', {
          threadId: THREAD_ID,
          turn: { id: TURN_ID, status: 'interrupted', items: [], error: null },
        })
        break
      default:
        respondError(id, { code: -32601, message: `method not found: ${method}` })
    }
    return
  }

  // 客户端通知（initialized 之类）：不用回
  if (typeof msg['method'] === 'string') {
    // ignored
  }
})
