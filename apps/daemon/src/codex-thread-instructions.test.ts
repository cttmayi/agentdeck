/**
 * ★ 分批第 74 批（daemon 级）：codex 的 ①② 走**线程级指令**，每轮只发 ③。
 *
 * 使用者原话：「在 codex CLI 情况下，每次沟通，都会发送完整的『框架+身份+任务』」。
 * 量下来（真实 run 日志）：一句聊天 271 字符，① 120 + ② 37、③ 只有 7 —— **96% 重复**；
 * 而 codex 的线程恢复后本来就带着 ①②（实测 0.157.1 用暗号验过），每轮重发是纯冗余。
 *
 * 这条用例钉**daemon → 适配器**那一跳：它不碰协议细节（那在
 * `packages/agent-codex/src/codex-backend.test.ts` 里按 `thread/start` 的参数钉），
 * 只回答"executor 到底把什么交给了 backend"。
 *
 * ⚠️ 判据是 `ExecOptions` 的两块：`systemPrompt`（①②）与 `prompt`（③）。
 *    从前它们的关系是"B 档：三块都在 prompt 里"；现在 codex 也是 A 档：
 *    **①② 单独走，③ 逐字留在 prompt**。
 *
 * ⚠️ daemon 级 runtime 设为 codex（`runtimeKey: 'codex'`）：注入的假后端只对
 *    selected runtime 生效（server.ts 的 `resolveRuntime`）。不这么设，run 会去找
 *    真的 `codex` 可执行文件——那是 NFR-T-01 禁止的。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { AsyncQueue, type AgentBackend, type AgentMessage, type ExecOptions, type AgentSession } from '@agentdeck/agent-core'
import type { Conversation } from '@agentdeck/protocol'
import { startDaemon, type DaemonHandle } from './server.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

class RecordingBackend implements AgentBackend {
  readonly key = 'codex'
  readonly protocol = 'jsonrpc' as const
  readonly rejectDetectable = true
  seenSystemPrompt: string | null = null
  seenPrompt: string | null = null
  seenResume: string | null = null

  async probe(): Promise<{ available: boolean; command: string; cliVersion: string | null }> {
    return { available: true, command: 'codex', cliVersion: '0.0.0-fake' }
  }

  async execute(opts: ExecOptions): Promise<AgentSession> {
    this.seenSystemPrompt = opts.systemPrompt ?? null
    this.seenPrompt = opts.prompt
    this.seenResume = opts.resumeSessionId ?? null
    const queue = new AsyncQueue<AgentMessage>()
    queue.push({ type: 'text', content: '收到。' })
    queue.close()
    return {
      messages: queue,
      result: Promise.resolve({
        status: 'completed' as const,
        output: '收到。',
        error: null,
        durationMs: 3,
        sessionId: 'thread-1',
        usage: null,
        exitCode: 0,
      }),
      async cancel() {
        queue.close()
      },
      lastActivityAt: () => Date.now(),
    }
  }
}

async function withCodexDaemon<T>(
  fn: (url: string, backend: RecordingBackend) => Promise<T>,
): Promise<T> {
  const dataDir = await makeTempDir('codex-thread-instr')
  const backend = new RecordingBackend()
  const d: DaemonHandle = await startDaemon({
    dataDir,
    workRoot: `${dataDir}/work`,
    port: 0,
    fsync: false,
    backend,
    runtimeKey: 'codex',
    onWarn: () => {},
    onInfo: () => {},
  })
  try {
    return await fn(d.url, backend)
  } finally {
    await d.close()
    await cleanup(dataDir)
  }
}

/** 把播种出来的第一个执行者改成走 codex（否则它自己的 runtimeKey 会把 run 送去 claude）。 */
async function executorOnCodex(url: string): Promise<string> {
  const body = (await (await fetch(`${url}/api/agents`)).json()) as {
    agents: Array<{ id: string; role: string }>
  }
  const executor = body.agents.find((a) => a.role === 'executor')
  assert.ok(executor, '启动时该播种一个执行者')
  const res = await fetch(`${url}/api/agents/${executor.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runtimeKey: 'codex' }),
  })
  assert.equal(res.status, 200, await res.text())
  return executor.id
}

async function waitTerminal(url: string, runId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const run = (await (await fetch(`${url}/api/runs/${runId}`)).json()) as Record<string, unknown>
    if (['completed', 'failed', 'cancelled'].includes(String(run['status']))) return run
    if (Date.now() > deadline) throw new Error(`run ${runId} 没有在限时内到终态`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

const FIRST_TURN = '你是 claude 还是 codex？'

describe('★★★ codex：①② 走线程级指令，每轮只发 ③', () => {
  test('★★★ 聊天空出来的那一跑：systemPrompt 有 ①②、prompt 只有使用者那句话', async () => {
    await withCodexDaemon(async (url, backend) => {
      const agentId = await executorOnCodex(url)
      const created = await fetch(`${url}/api/conversations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId, text: FIRST_TURN }),
      })
      // ⚠️ 响应体只能读一次（这里踩过：先 text() 再 json() ⇒ "Body is unusable"）
      const createdText = await created.text()
      assert.equal(created.status, 201, createdText)
      // ⚠️ 返回体是 `{ conversation, turn }`，不是裸的 conversation（我第一版按裸的解析，
      //    于是 `conv.id` 是 undefined、按 subject 找不到 run，用例红成"这一轮该有一条 run"）
      const conv = (JSON.parse(createdText) as { conversation: Conversation }).conversation

      // 等这一轮跑完（chat 是异步派发的）
      const deadline = Date.now() + 10_000
      let runId: string | null = null
      while (Date.now() < deadline && runId === null) {
        const { runs } = (await (await fetch(`${url}/api/runs`)).json()) as {
          runs: Array<{ runId: string; subject: { type: string; id: string } }>
        }
        runId =
          runs.find((r) => r.subject.type === 'conversation' && r.subject.id === conv.id)?.runId ?? null
        if (runId === null) await new Promise((r) => setTimeout(r, 25))
      }
      assert.ok(runId, '这一轮该有一条 run')
      const run = await waitTerminal(url, runId!)

      // ① 投递档现在是 A（原来 codex 是 B —— 三块合成一段）
      assert.equal(run['deliveryMode'], 'A', 'codex 现在也该是 A 档（①② 与 ③ 分开投递）')

      // ② ①② 单独送到了（走线程级通道的原料）
      assert.ok(backend.seenSystemPrompt, '必须把 ①② 单独交给适配器')
      // ⚠️ A 档的 `system` 是**①② 的原文拼接、不带块标签**（标签只出现在 B 档与日志展示里，
      //    见 `renderDelivery`）。我第一版断言 `/① 框架/` 就红了——量到的是正文。
      assert.match(backend.seenSystemPrompt!, /你在一个聊天窗口里和一个人说话/u, '① 框架要在')
      assert.match(backend.seenSystemPrompt!, /严谨的协作者/u, '② 身份（agent 的「指令」）要在')
      assert.equal(
        backend.seenSystemPrompt!.includes(FIRST_TURN),
        false,
        '★ ①② 那一块里不许夹带使用者那句话（它是 ③）',
      )

      // ③ 每轮的 prompt 就是使用者那句话，**逐字**
      assert.equal(backend.seenPrompt, FIRST_TURN, '★ 每轮只发 ③ —— 这正是这一批要省掉的那部分')
      assert.equal(
        backend.seenPrompt!.includes('你在一个聊天窗口里和一个人说话'),
        false,
        'prompt 里不许再出现框架正文（那属于线程级指令）',
      )

      // ④ 日志里说清走的是哪条通道（否则"每轮重发 vs 挂线程"只能靠翻代码）
      const { messages } = (await (
        await fetch(`${url}/api/runs/${runId}/messages`)
      ).json()) as { messages: Array<{ content: string }> }
      const head = messages.find((m) => m.content.includes('投递档'))?.content ?? ''
      assert.match(head, /线程级指令/u, `日志该说清是线程级通道：${head}`)
    })
  })

  test('★★ 对照：claude（命令行旗标那条通道）仍然是"每轮重发"——日志措辞也不同', async () => {
    /**
     * 这一条是**反向钉子**：不能把"改成线程级"做成对所有人都生效。
     * claude 的系统提示活不过 `--resume`（实测 2.0.14），必须每轮带，
     * 所以它的日志该说"每轮重发"。
     */
    const dataDir = await makeTempDir('claude-delivery-label')
    const backend: AgentBackend = {
      key: 'claude',
      protocol: 'stream-json',
      rejectDetectable: true,
      async probe() {
        return { available: true, command: 'claude', cliVersion: '0.0.0-fake' }
      },
      async execute() {
        const queue = new AsyncQueue<AgentMessage>()
        queue.push({ type: 'text', content: '收到。' })
        queue.close()
        return {
          messages: queue,
          result: Promise.resolve({
            status: 'completed' as const,
            output: '收到。',
            error: null,
            durationMs: 3,
            sessionId: 's',
            usage: null,
            exitCode: 0,
          }),
          async cancel() {
            queue.close()
          },
          lastActivityAt: () => Date.now(),
        }
      },
    }
    const d = await startDaemon({
      dataDir,
      workRoot: `${dataDir}/work`,
      port: 0,
      fsync: false,
      backend,
      onWarn: () => {},
      onInfo: () => {},
    })
    try {
      const agents = (await (await fetch(`${d.url}/api/agents`)).json()) as {
        agents: Array<{ id: string; role: string; runtimeKey: string }>
      }
      const executor = agents.agents.find((a) => a.role === 'executor')!
      const createdClaude = await fetch(`${d.url}/api/conversations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: executor.id, text: '你好' }),
      })
      const createdClaudeText = await createdClaude.text()
      assert.equal(createdClaude.status, 201, createdClaudeText)
      const conv = (JSON.parse(createdClaudeText) as { conversation: Conversation }).conversation

      const deadline = Date.now() + 10_000
      let runId: string | null = null
      while (Date.now() < deadline && runId === null) {
        const { runs } = (await (await fetch(`${d.url}/api/runs`)).json()) as {
          runs: Array<{ runId: string; subject: { type: string; id: string } }>
        }
        runId =
          runs.find((r) => r.subject.type === 'conversation' && r.subject.id === conv.id)?.runId ?? null
        if (runId === null) await new Promise((r) => setTimeout(r, 25))
      }
      assert.ok(runId)
      await waitTerminal(d.url, runId!)
      const { messages } = (await (
        await fetch(`${d.url}/api/runs/${runId}/messages`)
      ).json()) as { messages: Array<{ content: string }> }
      const head = messages.find((m) => m.content.includes('投递档'))?.content ?? ''
      assert.match(head, /每轮重发/u, `claude 那条通道该说"每轮重发"：${head}`)
    } finally {
      await d.close()
      await cleanup(dataDir)
    }
  })
})
