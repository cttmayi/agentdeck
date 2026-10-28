/**
 * 失败的那一次也必须**留下 sessionId**（否则"接着上次说"在一次失败之后就永久断了）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这是怎么发现的
 * ══════════════════════════════════════════════════════════════════
 *
 * 使用者报：「在 windows 发现一个问题，不能 resume，发现的问题是 id 没有保存下来」。
 *
 * 追下去发现我们自己的这条链上有一个与平台无关的缺口：`RunExecutor.#finish()` 的
 * **成功分支**把 `result.sessionId` 写进 run 记录，而 **失败分支**只写了原因码——
 * 于是 run 记录里 `sessionId` 是 null。而"接着上次说"（聊天下一轮 / 任务重试 /
 * 返工）全部靠 `resumeFromRunId` → 上一条 run 的 `sessionId`。
 *
 * 后果很具体：**只要有一轮失败，那个对话/任务的上下文就断了**，下一轮从零开始，
 * 而日志只会说"上一次 run 没有留下 sessionId，无从恢复"——看起来像 CLI 的问题，
 * 其实是平台没把 CLI 已经报给我们的那个 id 存下来。
 *
 * 为什么在 Windows 上先被发现：那边的 run 更容易失败（编码、垫片、网关），
 * 而这条缺口在 macOS 上只在失败时才暴露——happy path 一路正常。
 *
 * 判定"失败也该存"的理由：CLI 在**对话阶段已经建立**之后才失败时（工具报错、
 * 中途 5xx），那个会话是真实存在的；下一次 `--resume <id>` 仍然可用。丢掉它
 * 等于白白把上文扔了，而代价是使用者重新交代一遍。
 *
 * ⚠️ 用假后端（NFR-T-01）。它像真后端一样**先报 sessionId、再报失败**。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { AsyncQueue, type AgentBackend, type AgentMessage, type ExecOptions, type AgentSession } from '@agentdeck/agent-core'
import { ulid, type Run, type RunId } from '@agentdeck/protocol'
import { startDaemon } from './server.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/** 可以逐次指定"这一跑是成功还是失败"的假后端（真实 CLU 两种都会发生）。 */
class FlakyBackend implements AgentBackend {
  readonly key = 'claude'
  readonly protocol = 'stream-json' as const
  readonly rejectDetectable = true
  /** 每一次执行是否失败（按调用顺序消费；用完后一律成功）。 */
  #script: boolean[]
  /** 每条 run 收到的 resumeSessionId（第 1 次是第一条 run，第 2 次是第二条）。 */
  readonly seenResume: Array<string | null> = []

  constructor(script: boolean[]) {
    this.#script = [...script]
  }

  async probe(): Promise<{ available: boolean; command: string; cliVersion: string | null }> {
    return { available: true, command: 'claude', cliVersion: '0.0.0-fake' }
  }

  async execute(opts: ExecOptions): Promise<AgentSession> {
    this.seenResume.push(opts.resumeSessionId ?? null)
    const fail = this.#script.shift() ?? false
    const queue = new AsyncQueue<AgentMessage>()
    queue.push({ type: 'text', content: fail ? '做到一半出错了。' : '做完了。' })
    queue.close()
    return {
      messages: queue,
      result: Promise.resolve({
        status: fail ? ('failed' as const) : ('completed' as const),
        output: fail ? '做到一半出错了。' : '做完了。',
        error: fail ? '工具调用失败：ECONNRESET' : null,
        durationMs: 5,
        // ★ 关键：CLI 在**失败**时同样会报告会话 id（真实 claude 的 result 事件里就有）
        sessionId: 'sess-from-cli',
        usage: { inputTokens: 100, outputTokens: 5, costUsdMicros: 4242, costSource: 'provider' as const },
        exitCode: fail ? 1 : 0,
      }),
      async cancel() {
        queue.close()
      },
      lastActivityAt: () => Date.now(),
    }
  }
}

async function withDaemon<T>(
  script: boolean[],
  fn: (url: string, backend: FlakyBackend) => Promise<T>,
): Promise<T> {
  const dataDir = await makeTempDir('resume-after-failure')
  const backend = new FlakyBackend(script)
  const d = await startDaemon({
    dataDir,
    port: 0,
    fsync: false,
    backend,
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

async function submit(
  url: string,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await fetch(`${url}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: 'execute',
      agentRef: { id: 'agent-flaky', name: '会失败的助手', instructions: '干活' },
      skills: [],
      limits: { maxTurns: null, timeoutMs: null },
      ...body,
    }),
  })
  assert.equal(res.status, 202, await res.text())
  return (body['runId'] as string) ?? ''
}

/** 等这条 run 到终态（轮询 /api/runs/{id}）。 */
async function waitTerminal(url: string, runId: string): Promise<Run> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const run = (await (await fetch(`${url}/api/runs/${runId}`)).json()) as Run
    if (['completed', 'failed', 'cancelled'].includes(run.status)) return run
    if (Date.now() > deadline) throw new Error(`run ${runId} 没有在限时内到终态（${run.status}）`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('★★★ 失败的那次也要留下 sessionId（不然"接着上次说"一次失败就永久断）', () => {
  test('★★★ 失败的 run 记录里必须存下 CLI 报的 sessionId 与用量', async () => {
    await withDaemon([true], async (url) => {
      const issueId = ulid()
      const runId = ulid() as RunId
      await submit(url, {
        runId,
        subject: { type: 'issue', id: issueId },
        prompt: '做一件会失败的事',
      })
      const run = await waitTerminal(url, runId)
      assert.equal(run.status, 'failed', '前提：这次真的失败了')
      assert.equal(
        run.sessionId,
        'sess-from-cli',
        '★ 失败也必须存下 sessionId —— CLI 已经报给我们了，丢掉等于白扔上文',
      )
      // 顺带：用量（花掉的 token/钱）同样该记账，失败不等于没花钱
      assert.equal(run.usage?.costUsdMicros, 4242)
    })
  })

  test('★★★ 失败之后接着来一次：CLI 真的收到 --resume 的那个 id', async () => {
    await withDaemon([true, false], async (url, backend) => {
      const issueId = ulid()
      const firstRunId = ulid() as RunId
      await submit(url, {
        runId: firstRunId,
        subject: { type: 'issue', id: issueId },
        prompt: '第一次（会失败）',
      })
      assert.equal((await waitTerminal(url, firstRunId)).status, 'failed')

      const secondRunId = ulid() as RunId
      await submit(url, {
        runId: secondRunId,
        subject: { type: 'issue', id: issueId },
        prompt: '接着上次说',
        resumeFromRunId: firstRunId,
      })
      assert.equal((await waitTerminal(url, secondRunId)).status, 'completed')

      assert.deepEqual(
        backend.seenResume,
        [null, 'sess-from-cli'],
        '★ 第二次必须带着第一次的会话 id 去恢复（不是从头再来）',
      )
    })
  })
})
