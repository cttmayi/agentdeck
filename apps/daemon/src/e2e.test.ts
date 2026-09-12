import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AsyncQueue, type AgentBackend, type AgentMessage, type ExecOptions, type AgentSession } from '@alpha-helper/agent-core'
import { hasContextBlock } from '@alpha-helper/agent-core'
import { ulid, type Issue, type RunId, type RunEvent } from '@alpha-helper/protocol'
import { startDaemon, type DaemonHandle } from './server.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * 端到端：真的起一个 daemon、真的走 HTTP 与 SSE。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么用假后端
 * ══════════════════════════════════════════════════════════════════
 *
 * **NFR-T-01 要求单元测试与常规 CI 绝不能调用使用者真实安装的 agent CLI。**
 * 那会消耗真实额度、可能让 agent 改动文件，而且结果不确定。
 *
 * 所以这里注入一个假后端，它顺便做了两件真后端做不到的事：
 *   1. 在"执行中"读一次 CLAUDE.md，验证上下文块**确实被注入**了；
 *   2. 记录收到的 prompt 与 workDir，验证透传正确。
 */

class FakeBackend implements AgentBackend {
  readonly key = 'claude'
  readonly protocol = 'stream-json' as const
  readonly rejectDetectable = true

  /** 执行时看到的工作目录内容——用于验证注入发生在正确时机。 */
  seenContext: string | null = null
  seenPrompt: string | null = null
  seenWorkDir: string | null = null
  seenArgs: string[] | null = null

  readonly #fail: boolean

  constructor(options: { fail?: boolean } = {}) {
    this.#fail = options.fail === true
  }

  async probe(): Promise<{ available: boolean; command: string; cliVersion: string | null }> {
    return { available: true, command: 'claude', cliVersion: '0.0.0-fake' }
  }

  async execute(opts: ExecOptions): Promise<AgentSession> {
    this.seenPrompt = opts.prompt
    this.seenWorkDir = opts.workDir
    this.seenContext = await readFile(join(opts.workDir, 'CLAUDE.md'), 'utf8').catch(() => null)

    const queue = new AsyncQueue<AgentMessage>()
    queue.push({ type: 'status', content: '会话已启动' })
    queue.push({ type: 'text', content: '我先看看任务。' })
    queue.push({ type: 'tool_use', tool: 'Read', content: '调用工具 Read', input: { file_path: 'a.ts' } })
    queue.push({ type: 'tool_result', tool: null, content: '文件内容', output: '文件内容', outputTruncated: false })
    queue.push({ type: 'text', content: '报告：任务已完成。' })
    queue.close()

    const fail = this.#fail
    const result = Promise.resolve({
      status: fail ? ('failed' as const) : ('completed' as const),
      output: fail ? '' : '报告：任务已完成。',
      error: fail ? '假装失败了' : null,
      durationMs: 5,
      sessionId: 'fake-session-1',
      usage: { inputTokens: 100, outputTokens: 50, costUsdMicros: 1234, costSource: 'provider' as const },
      exitCode: fail ? 1 : 0,
    })

    return {
      messages: queue,
      result,
      async cancel() {
        queue.close()
      },
      lastActivityAt: () => Date.now(),
    }
  }
}

/** 读 SSE 直到终态事件或超时。 */
async function readUntilTerminal(
  url: string,
  timeoutMs = 10_000,
): Promise<{ events: RunEvent[]; terminal: RunEvent | null }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const events: RunEvent[] = []
  let terminal: RunEvent | null = null

  try {
    const res = await fetch(url, { signal: controller.signal })
    assert.equal(res.status, 200)
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let index = buffer.indexOf('\n\n')
      while (index !== -1) {
        const raw = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        index = buffer.indexOf('\n\n')

        if (!raw.startsWith('data: ')) continue // 心跳注释
        const parsed = JSON.parse(raw.slice(6)) as RunEvent
        events.push(parsed)
        if (parsed.t === 'terminal') {
          terminal = parsed
          await reader.cancel()
          return { events, terminal }
        }
      }
    }
  } catch (err) {
    if ((err as Error).name !== 'AbortError') throw err
  } finally {
    clearTimeout(timer)
  }

  return { events, terminal }
}

let dir: string
let workDir: string
let daemon: DaemonHandle
let backend: FakeBackend
let issueId: string

before(async () => {
  dir = await makeTempDir('e2e-data')
  workDir = await makeTempDir('e2e-work')
  backend = new FakeBackend()
  daemon = await startDaemon({
    dataDir: dir,
    port: 0, // 让内核分配，避免测试互相抢端口
    fsync: false,
    backend,
    onWarn: () => {},
    onInfo: () => {},
  })

  const res = await fetch(`${daemon.url}/api/issues`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '写一份报告', description: '随便看看' }),
  })
  issueId = ((await res.json()) as Issue).id
})

after(async () => {
  await daemon.close()
  await cleanup(dir)
  await cleanup(workDir)
})

describe('端到端：一个 execute run 跑通整条链路', () => {
  test('身份接口报出可用 runtime', async () => {
    const res = await fetch(`${daemon.url}/api/identity`)
    const body = (await res.json()) as { runtimes: Array<{ key: string; available: boolean }> }
    assert.equal(body.runtimes[0]?.key, 'claude')
    assert.equal(body.runtimes[0]?.available, true)
  })

  test('★ 提交 run → 收到流式消息 → 终态 completed', async () => {
    const runId = ulid() as RunId
    const res = await fetch(`${daemon.url}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runId,
        kind: 'execute',
        agentRef: { id: 'agent-x', name: '助手', instructions: '' },
        skills: [],
        subject: { type: 'issue', id: issueId },
        prompt: '写一份关于依赖漏洞的报告',
        workDir,
        limits: { maxTurns: null, timeoutMs: null },
      }),
    })
    assert.equal(res.status, 202, '受理必须返回 202')

    const { events, terminal } = await readUntilTerminal(`${daemon.url}/api/runs/${runId}/events`)
    assert.notEqual(terminal, null, '必须收到终态事件')
    assert.equal(terminal?.t, 'terminal')
    if (terminal?.t !== 'terminal') return
    assert.equal(terminal.status, 'completed')

    const messages = events.filter((e) => e.t === 'message')
    assert.ok(messages.length >= 4, `应收到多条流式消息，实际 ${messages.length}`)

    // ★ seq 必须严格单调——页面靠它做补齐与去重
    const seqs = events.map((e) => e.seq)
    for (let i = 1; i < seqs.length; i++) {
      assert.ok(seqs[i]! > seqs[i - 1]!, 'seq 必须严格递增')
    }

    // 用量事件带 provider 上报的成本
    const usageEvent = events.find((e) => e.t === 'usage')
    assert.equal(usageEvent?.t === 'usage' ? usageEvent.usage.costUsdMicros : null, 1234)
    assert.equal(usageEvent?.t === 'usage' ? usageEvent.usage.costSource : null, 'provider')
  })

  test('★ 上下文块在**执行期间**已注入（假后端在跑的时候读到了它）', () => {
    assert.notEqual(backend.seenContext, null, '执行时 CLAUDE.md 应当存在')
    assert.equal(hasContextBlock(backend.seenContext!), true, '应当含受管块')
    assert.match(backend.seenContext!, /写一份关于依赖漏洞的报告/, '受管块里应含任务内容')
  })

  test('★ 执行结束后上下文块被清理，工作目录恢复原状', async () => {
    const after = await readFile(join(workDir, 'CLAUDE.md'), 'utf8').catch(() => null)
    // 这个目录原本没有 CLAUDE.md ⇒ 清理后应当被删除，而不是留一个空文件或残留块
    assert.equal(after, null, '本来不存在的文件应当被删掉，而不是留下空文件')
  })

  test('prompt 与工作目录被正确透传', () => {
    assert.equal(backend.seenPrompt, '写一份关于依赖漏洞的报告')
    assert.equal(backend.seenWorkDir, workDir)
  })

  test('消息已落盘，且 daemon 是权威（可用 since 补齐）', async () => {
    const listRes = await fetch(`${daemon.url}/api/runs`)
    const list = (await listRes.json()) as { runs: Array<{ runId: string; lastSeq: number; status: string }> }
    assert.equal(list.runs.length, 1)
    assert.equal(list.runs[0]?.status, 'completed')
    assert.ok((list.runs[0]?.lastSeq ?? -1) >= 3, '应当记录了多条消息')

    const runId = list.runs[0]!.runId
    const all = (await (await fetch(`${daemon.url}/api/runs/${runId}/messages`)).json()) as {
      messages: Array<{ seq: number }>
    }
    assert.ok(all.messages.length >= 4)

    // since 语义：只返回**事件序号**大于 since 的消息。
    // 注意事件 seq 是跨类型共享的（status 也占号），所以消息序号不连续——
    // 这正是"补齐要靠 seq 而不是靠数组下标"的原因。
    const tail = (await (
      await fetch(`${daemon.url}/api/runs/${runId}/messages?since=2`)
    ).json()) as { messages: Array<{ seq: number }> }

    assert.ok(tail.messages.every((m) => m.seq > 2), 'since 之后的都应大于 2')
    assert.ok(tail.messages.length < all.messages.length, 'since 应当过滤掉一部分')

    const head = all.messages.filter((m) => m.seq <= 2)
    assert.equal(head.length + tail.messages.length, all.messages.length, '两段合起来必须不重不漏')
    assert.ok(tail.messages.every((m) => m.seq % 1 === 0))
  })
})

describe('端到端：幂等与拒绝', () => {
  test('★ 同一 runId 重复提交只受理一次', async () => {
    const runId = ulid() as RunId
    const body = JSON.stringify({
      runId,
      kind: 'execute',
      agentRef: { id: 'agent-x', name: '助手', instructions: '' },
      skills: [],
      subject: { type: 'issue', id: issueId },
      prompt: '幂等测试',
      workDir,
      limits: { maxTurns: null, timeoutMs: null },
    })

    const first = await fetch(`${daemon.url}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    const firstBody = (await first.json()) as { deduplicated: boolean }
    assert.equal(firstBody.deduplicated, false)

    const second = await fetch(`${daemon.url}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    const secondBody = (await second.json()) as { deduplicated: boolean }
    assert.equal(secondBody.deduplicated, true, '第二次提交必须被识别为重复')
  })

  test('缺少 runId 或 workDir 时返回 400', async () => {
    const res = await fetch(`${daemon.url}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'execute' }),
    })
    assert.equal(res.status, 400)
  })

  test('未知路径返回 404', async () => {
    const res = await fetch(`${daemon.url}/api/nope`)
    assert.equal(res.status, 404)
  })
})

describe('端到端：失败路径', () => {
  test('★ 后端报失败 ⇒ run 状态为 failed 且带失败原因', async () => {
    const failDir = await makeTempDir('e2e-fail')
    const failData = await makeTempDir('e2e-faildata')
    const failing = new FakeBackend({ fail: true })
    const d = await startDaemon({
      dataDir: failData,
      port: 0,
      fsync: false,
      backend: failing,
      onWarn: () => {},
      onInfo: () => {},
    })

    try {
      const runId = ulid() as RunId
      await fetch(`${d.url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId,
          kind: 'execute',
          agentRef: { id: 'a', name: 'A', instructions: '' },
          skills: [],
          subject: { type: 'issue', id: 'i' },
          prompt: '会失败的任务',
          workDir: failDir,
          limits: { maxTurns: null, timeoutMs: null },
        }),
      })

      const { terminal } = await readUntilTerminal(`${d.url}/api/runs/${runId}/events`)
      assert.equal(terminal?.t === 'terminal' ? terminal.status : null, 'failed')

      const run = (await (await fetch(`${d.url}/api/runs/${runId}`)).json()) as {
        status: string
        failureReason: string | null
      }
      assert.equal(run.status, 'failed')
      assert.notEqual(run.failureReason, null, '失败必须带机器可读的原因码')

      // 上下文块同样要被清理——失败路径也不能留下痕迹
      const leftover = await readFile(join(failDir, 'CLAUDE.md'), 'utf8').catch(() => null)
      assert.equal(leftover, null, '失败后也不得留下残留块')
    } finally {
      await d.close()
      await cleanup(failDir)
      await cleanup(failData)
    }
  })
})

describe('端到端：不破坏使用者已有的文件', () => {
  test('★ 工作目录里已有 CLAUDE.md ⇒ 注入后再清理，内容逐字节复原', async () => {
    const userDir = await makeTempDir('e2e-user')
    const dataDir = await makeTempDir('e2e-userdata')
    const original = '# 我的项目\n\n这是使用者自己写的内容。\n\n\n'
    await writeFile(join(userDir, 'CLAUDE.md'), original, 'utf8')

    const b = new FakeBackend()
    const d = await startDaemon({
      dataDir,
      port: 0,
      fsync: false,
      backend: b,
      onWarn: () => {},
      onInfo: () => {},
    })

    try {
      const runId = ulid() as RunId
      await fetch(`${d.url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId,
          kind: 'execute',
          agentRef: { id: 'a', name: 'A', instructions: '' },
          skills: [],
          subject: { type: 'issue', id: 'i' },
          prompt: '随便做点事',
          workDir: userDir,
          limits: { maxTurns: null, timeoutMs: null },
        }),
      })
      await readUntilTerminal(`${d.url}/api/runs/${runId}/events`)

      // 执行期间：使用者的内容仍在，且多了我们的块
      assert.ok(b.seenContext?.startsWith('# 我的项目'), '使用者原有内容不能被截断')
      assert.equal(hasContextBlock(b.seenContext!), true)

      // 执行之后：逐字节复原（包括那三个尾部换行）
      const restored = await readFile(join(userDir, 'CLAUDE.md'), 'utf8')
      assert.equal(restored, original, '必须逐字节还原使用者原文件')
    } finally {
      await d.close()
      await cleanup(userDir)
      await cleanup(dataDir)
    }
  })
})
