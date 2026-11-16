import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AsyncQueue,
  type AgentBackend,
  type AgentMessage,
  type AgentSession,
  type ExecOptions,
} from '@agentdeck/agent-core'
import { ulid } from '@agentdeck/protocol'
import { startDaemon } from './server.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * §3.3b：执行任务与执行结果**按轮次落盘**（`.agentdeck/rounds/<轮次>-task.md` /
 * `-result.md`，多轮不覆盖）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这件事原来只是"给审核 run 当材料用的"
 * ══════════════════════════════════════════════════════════════════
 *
 * 2026-11（D125）**审核 run 退场**之后，材料不再往外送——但**留档本身照做**，
 * 因为它跟审核无关：人要看"上次那一版到底写了什么"，编排读上一轮的产出也靠它。
 *
 * ⚠️ 轮次号 = `run.chainDepth + 1`（首轮 1）。这个约定原来是"与返工 run 的
 *    `chainDepth` 同一计数"（返工已退场），现在由编排决定每一轮传什么。
 *
 * 这个文件替换了原来那个 `review-e2e.test.ts`：那里几十条用例都在测"报告进来 →
 * 审核 → 判决"，审核退场之后它们全失去对象；这里只留下**落盘**这一件事，而它
 * 现在由执行 run 自己的事实来断言（不用再绕一条审核 run）。
 */

/**
 * 假后端：每条 run 回一段固定文本（= 执行产出）。
 *
 * 用 `AsyncQueue` 而不是 async generator：与真实适配器同一个形状，而且
 * `result` 里 `output` 与消息流里那段文字**必须一致**——落盘的 `-result.md`
 * 取的就是它（真机上这里对不上过一次：日志里有一段、文件里是空）。
 */
class ScriptedBackend implements AgentBackend {
  readonly key = 'claude'
  readonly protocol = 'stream-json' as const
  readonly rejectDetectable = true
  /** 按序取用；用完之后回一句兜底。 */
  outputs: string[] = []
  calls = 0

  async probe(): Promise<{ available: boolean; command: string; cliVersion: string | null }> {
    return { available: true, command: 'claude', cliVersion: '0.0.0-fake' }
  }

  async execute(_opts: ExecOptions): Promise<AgentSession> {
    this.calls += 1
    const text = this.outputs.shift() ?? '（没有更多脚本化的输出）'
    const queue = new AsyncQueue<AgentMessage>()
    queue.push({ type: 'text', content: text })
    queue.close()
    return {
      messages: queue,
      result: Promise.resolve({
        status: 'completed',
        output: text,
        durationMs: 3,
        sessionId: 'rounds-session',
        usage: { inputTokens: 5, outputTokens: 5, costUsdMicros: 1, costSource: 'provider' },
        exitCode: 0,
      }),
      async cancel() {
        queue.close()
      },
      lastActivityAt: () => Date.now(),
    }
  }
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

async function waitAllSettled(url: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { runs } = (await (await fetch(`${url}/api/runs`)).json()) as {
      runs: Array<{ status: string }>
    }
    if (runs.length > 0 && runs.every((r) => TERMINAL.has(r.status))) return
    if (Date.now() > deadline) throw new Error('等待 run 结束超时')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('§3.3b：执行任务/结果按轮次落盘', () => {
  test('★ 执行完落盘 rounds/1-task.md 与 1-result.md，内容分别是任务原文与执行产出', async () => {
    const b = new ScriptedBackend()
    const d = await startDaemon({
      dataDir: await makeTempDir('rounds-one'),
      port: 0,
      fsync: false,
      backend: b,
      onWarn: () => {},
      onInfo: () => {},
    })
    try {
      const agents = ((await (await fetch(`${d.url}/api/agents`)).json()) as {
        agents: Array<{ id: string; builtin?: boolean }>
      }).agents
      const executor = agents.find((a) => a.builtin !== true)!

      const produced = '执行者的报告：改成冒泡排序，并补了两个测试。'
      b.outputs = [produced]

      const issueId = ((await (
        await fetch(`${d.url}/api/issues`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: '落盘用例' }),
        })
      ).json()) as { id: string }).id

      const taskText = '把排序函数改成冒泡排序，并补两个测试。'
      const runId = ulid()
      const res = await fetch(`${d.url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId,
          kind: 'execute',
          agentRef: { id: executor.id, name: 'x', instructions: '' },
          subject: { type: 'issue', id: issueId },
          prompt: taskText,
          limits: { maxTurns: null, timeoutMs: null },
        }),
      })
      assert.equal(res.status, 202)
      await waitAllSettled(d.url)

      const run = (await (await fetch(`${d.url}/api/runs/${runId}`)).json()) as {
        workDir: string | null
        status: string
      }
      assert.equal(run.status, 'completed')
      assert.ok(run.workDir, '执行 run 必须有工作目录（否则没有地方落盘）')

      const roundsDir = join(run.workDir, '.agentdeck', 'rounds')
      const taskPath = join(roundsDir, '1-task.md')
      const resultPath = join(roundsDir, '1-result.md')

      assert.equal((await readFile(taskPath, 'utf8')).trim(), taskText, 'task 文件装的是任务原文')
      assert.match(await readFile(resultPath, 'utf8'), /改成冒泡排序/, 'result 文件装的是执行产出')
    } finally {
      await d.close()
    }
  })

  test('★ 多轮**不覆盖**前一轮：rounds/1-* 与 2-* 各自保留', async () => {
    const b = new ScriptedBackend()
    const d = await startDaemon({
      dataDir: await makeTempDir('rounds-multi'),
      port: 0,
      fsync: false,
      backend: b,
      onWarn: () => {},
      onInfo: () => {},
    })
    const workDir = await makeTempDir('rounds-multi-work')
    try {
      const agents = ((await (await fetch(`${d.url}/api/agents`)).json()) as {
        agents: Array<{ id: string; builtin?: boolean }>
      }).agents
      const executor = agents.find((a) => a.builtin !== true)!

      b.outputs = ['第 1 次产出：没写测试。', '第 2 次产出：补上了测试。']

      const issueId = ((await (
        await fetch(`${d.url}/api/issues`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: '多轮不覆盖用例' }),
        })
      ).json()) as { id: string }).id

      /*
       * ⚠️ 轮次号来自 `chainDepth + 1`。这里显式给 `chainDepth`：`POST /api/runs`
       *   会**原样**收下它（没有哪一层会替你算）——第二轮是谁派生的一目了然，
       *   而"第几条"这件事只有一个判据。
       */
      const submit = async (prompt: string, chainDepth: number): Promise<string> => {
        const runId = ulid()
        const res = await fetch(`${d.url}/api/runs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            runId,
            kind: 'execute',
            agentRef: { id: executor.id, name: 'x', instructions: '' },
            subject: { type: 'issue', id: issueId },
            prompt,
            chainDepth,
            workDir,
            limits: { maxTurns: null, timeoutMs: null },
          }),
        })
        assert.equal(res.status, 202)
        await waitAllSettled(d.url)
        return runId
      }

      await submit('第一轮任务：先写个能跑的版本。', 0)
      await submit('第二轮任务：把测试补上。', 1)

      const roundsDir = join(workDir, '.agentdeck', 'rounds')
      assert.equal(
        (await readFile(join(roundsDir, '1-task.md'), 'utf8')).trim(),
        '第一轮任务：先写个能跑的版本。',
        '第一轮的任务文件必须原样还在（多轮不覆盖）',
      )
      assert.match(await readFile(join(roundsDir, '1-result.md'), 'utf8'), /没写测试/)
      assert.equal(
        (await readFile(join(roundsDir, '2-task.md'), 'utf8')).trim(),
        '第二轮任务：把测试补上。',
        '第二轮写的是 2-task.md，不是覆盖 1-task.md',
      )
      assert.match(await readFile(join(roundsDir, '2-result.md'), 'utf8'), /补上了测试/)
    } finally {
      await d.close()
      await cleanup(workDir)
    }
  })
})
