import { after, before, describe, test } from 'node:test'
import { deliveredText } from './testing/delivered.ts'
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
import {
  VERDICT_FENCE_BEGIN,
  VERDICT_FENCE_END,
  ulid,
  type Issue,
  type RunId,
  type VerdictRecord,
} from '@agentdeck/protocol'
import { startDaemon, type DaemonHandle } from './server.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * D45 端到端：**审核不通过 ⇒ 返工**。
 *
 * 这个功能把"不合格"从"处置它"改成了"交回去改"，所以这个测试要守住四件事：
 *
 *   1. `fail` **不需要也不允许**带 action（schema 层面已经在 protocol 里守了，
 *      这里守的是"跑起来也不会有动作被执行"）；
 *   2. `fail` 会真的派生一条**返工 execute run**：同一个工作目录、接着上次会话、
 *      `chainDepth` +1（额度判据就靠它）；
 *   3. 返工之后**审核会再串一次**——否则回路只转半圈，改完没有人看；
 *   4. 额度用完之后仍 `fail` ⇒ 判决收口到 `escalated`（看板「等待人处理」）
 *      并进通知中心，**不会静默停在"已审查"**。
 *
 * ⚠️ 这里**不需要装工具包**：`fail` 不带动作，所以这条链路与动作授权无关。
 *    这正是 D45 的语义带来的简化。
 */

/** 执行者每次干活都写一遍这个文件，用来验证"返工在同一个目录里进行"。 */
const ARTIFACT = '产出.txt'

class AlwaysFailReviewBackend implements AgentBackend {
  readonly key = 'claude'
  readonly protocol = 'stream-json' as const
  readonly rejectDetectable = true

  /** 按调用顺序记录每次都跑了什么（用来数"执行了几次"）。 */
  readonly phases: string[] = []
  /** 每次执行 run 的 `prompt`（返工那次应当带着审核意见）。 */
  readonly executePrompts: string[] = []
  /** 每次执行 run 的 workDir（返工的应当与被返工的那次相同）。 */
  readonly workDirs: string[] = []

  async probe(): Promise<{ available: boolean; command: string; cliVersion: string | null }> {
    return { available: true, command: 'claude', cliVersion: '0.0.0-fake' }
  }

  async execute(opts: ExecOptions): Promise<AgentSession> {
    // D29：判定"这是审核还是执行"只看第一句话的开头
    const isReview = deliveredText(opts).includes('# 审核任务')
    this.phases.push(isReview ? 'review' : 'execute')

    let text: string
    if (isReview) {
      // ★ 永远判不通过——而且**不带 action**（D45：fail 的出口是返工）
      text = [
        '审核结论：',
        VERDICT_FENCE_BEGIN,
        JSON.stringify({
          schemaVersion: 1,
          conclusion: 'fail',
          reasonCode: 'missing_tests',
          confidence: 0.8,
          findings: [
            {
              severity: 'high',
              summary: '产出里没有测试文件',
              evidence: [{ blobRef: null, locator: '报告第 1 段', excerpt: '我忘了写测试' }],
              detail: { suggestion: '补一个最小的测试' },
            },
          ],
          action: null,
          escalateReason: null,
        }),
        VERDICT_FENCE_END,
      ].join('\n')
    } else {
      this.executePrompts.push(deliveredText(opts))
      this.workDirs.push(opts.workDir)
      await (await import('node:fs/promises')).writeFile(
        join(opts.workDir, ARTIFACT),
        `第 ${this.executePrompts.length} 次产出\n`,
        'utf8',
      )
      text = '报告：我做完了，但忘了写测试。'
    }

    const queue = new AsyncQueue<AgentMessage>()
    queue.push({ type: 'text', content: text })
    queue.close()

    return {
      messages: queue,
      result: Promise.resolve({
        status: 'completed',
        output: text,
        durationMs: 2,
        sessionId: isReview ? `review-${this.phases.length}` : `exec-${this.phases.length}`,
        usage: { inputTokens: 10, outputTokens: 5, costUsdMicros: 100, costSource: 'provider' },
        exitCode: 0,
      }),
      async cancel() {
        queue.close()
      },
      lastActivityAt: () => Date.now(),
    }
  }
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value !== null) return value
    if (Date.now() > deadline) throw new Error('等待超时')
    await new Promise((r) => setTimeout(r, 25))
  }
}

interface RunRow {
  runId: string
  kind: string
  status: string
  chainDepth: number
  workDir: string | null
  derivedFrom: string | null
}

let dataDir: string
let workDir: string
let daemon: DaemonHandle
let backend: AlwaysFailReviewBackend
let issueId: Issue['id']
let agentId: string

async function listRuns(): Promise<RunRow[]> {
  const res = (await (await fetch(`${daemon.url}/api/runs`)).json()) as { runs: RunRow[] }
  return res.runs
}

/** 提交一条带返工额度的任务。 */
async function submitTask(maxReworks: number): Promise<RunId> {
  const runId = ulid() as RunId
  const res = await fetch(`${daemon.url}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      runId,
      kind: 'execute',
      agentRef: { id: agentId, name: '助手', instructions: '' },
      skills: [],
      subject: { type: 'issue', id: issueId },
      prompt: '把功能实现一下',
      workDir,
      limits: { maxTurns: null, timeoutMs: null },
      maxReworks,
    }),
  })
  assert.equal(res.status, 202, await res.text())
  return runId
}

before(async () => {
  dataDir = await makeTempDir('rework-data')
  workDir = await makeTempDir('rework-work')
  backend = new AlwaysFailReviewBackend()
  daemon = await startDaemon({
    dataDir,
    port: 0,
    fsync: false,
    backend,
    onWarn: () => {},
    onInfo: () => {},
  })

  const res = await fetch(`${daemon.url}/api/issues`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '加一个功能', description: '顺便写测试' }),
  })
  issueId = ((await res.json()) as Issue).id

  const agents = ((await (await fetch(`${daemon.url}/api/agents`)).json()) as {
    agents: Array<{ id: string; role: string; reviewerAgentId: string | null }>
  }).agents
  const executor = agents.find((a) => a.role === 'executor')
  const reviewer = agents.find((a) => a.role === 'reviewer')
  assert.ok(executor, 'bootstrap 会播种一个执行者')
  assert.ok(reviewer, 'bootstrap 会播种一个审核者')
  assert.equal(executor!.reviewerAgentId, reviewer!.id, '执行者默认指向审核者')
  agentId = executor!.id
})

after(async () => {
  await daemon.close()
  await cleanup(dataDir)
  await cleanup(workDir)
})

describe('D45：审核不通过 ⇒ 返工', () => {
  test('★ fail 会派生返工 run：同目录、接着上次会话、chainDepth +1', async () => {
    const before = backend.phases.length
    const first = await submitTask(1)

    // 等到出现一条**执行** run，且它不是最初那条（= 返工 run）
    const rework = await waitFor(async () => {
      const runs = await listRuns()
      const executes = runs.filter((r) => r.kind === 'execute' && r.chainDepth >= 1)
      return executes[0] ?? null
    })

    assert.equal(rework.chainDepth, 1, '★ 返工 run 的 chainDepth 必须 +1 —— 额度判据就靠它')
    assert.equal(rework.workDir, workDir, '★ 返工要在**同一个目录**里改，不是另起一摊')

    // ★ 还要等**返工那一次执行真的被调起来**。
    //   "run 出现在列表里"与"backend 收到它"是两个时刻：只看列表的话，
    //   `executePrompts` 里最后那条仍然是**最初那次**的指令，于是下面那几条
    //   断言测的是错的对象（它在单独跑时侥幸通过、在全量跑时红——就是这里）。
    await waitFor(async () => (backend.executePrompts.length >= 2 ? true : null))

    // 它确实是"被那条判决派出来的"，不是别的什么
    const chain = (await listRuns()).filter((r) => r.kind === 'execute')
    assert.ok(
      chain.some((r) => r.runId === first),
      '最初那条执行 run 应当还在（返工是新增，不是覆盖）',
    )

    // ★ 返工的那次指令必须带着**审核意见**，否则执行者不知道为什么要重做
    const reworkPrompt = backend.executePrompts[backend.executePrompts.length - 1] ?? ''
    assert.match(reworkPrompt, /没有通过审核/, '返工的第一句话要说清"上次没通过"')
    assert.match(reworkPrompt, /missing_tests/, ' ★ 要带上理由码')
    assert.match(reworkPrompt, /产出里没有测试文件/, '★ 要带上那条具体的审核意见')
    assert.match(reworkPrompt, /报告第 1 段/, '★ 证据指回原文的位置也要带上')

    assert.ok(backend.phases.length > before, '应当真的又跑过一轮')
  })

  test('★ 额度用完仍 fail ⇒ 收口到 escalated + 进通知中心（不静默停在"已审查"）', async () => {
    // ⚠️ 必须**只看这条任务自己的**审核 run：列表是全局的，前面那条用例
    //   （额度 1）已经留下了一堆 review run，`find(kind==='review')` 会捞到别人的，
    //   于是断言测的是上一条任务的状态——这个坑我自己踩过一次。
    const seen = new Set((await listRuns()).filter((r) => r.kind === 'review').map((r) => r.runId))
    // 同理：返工 run 的计数也要**只算这条任务新增的**（上一条用例合法地留下了 1 条）
    const reworksBefore = (await listRuns()).filter(
      (r) => r.kind === 'execute' && r.chainDepth >= 1,
    ).length

    // 这条任务不配返工（= 0）：第一次 fail 就该交给人
    const runId = await submitTask(0)

    const reviewRun = await waitFor(async () => {
      const runs = await listRuns()
      const mine = runs.filter(
        (r) => r.kind === 'review' && r.status === 'completed' && !seen.has(r.runId),
      )
      return mine[0] ?? null
    })

    // 判决必须是 `fail`，且**没有任何动作被执行**
    const verdicts = ((await (
      await fetch(`${daemon.url}/api/runs/${reviewRun.runId}/verdicts`)
    ).json()) as { verdicts: VerdictRecord[] }).verdicts
    assert.equal(verdicts.length, 1)
    assert.equal(verdicts[0]?.conclusion, 'fail')
    assert.equal(
      verdicts[0]?.status,
      'escalated',
      '★ 不通过且没人会自动修 ⇒ 必须交给人，不能落成 advisory（那会被看板显示成"已审查"）',
    )
    assert.equal(verdicts[0]?.action, null, 'D45：fail 不带动作')

    // 而它进通知中心：这件事需要人
    const inbox = ((await (await fetch(`${daemon.url}/api/inbox`)).json()) as {
      items: Array<{ type: string }>
    }).items
    assert.ok(
      inbox.some((i) => i.type === 'verdict.escalated'),
      '★ "审核不通过、且没有返工可跑"必须可见，不得静默',
    )

    // 而且**没有**派生第二条执行 run（额度是 0）
    const reworksAfter = (await listRuns()).filter(
      (r) => r.kind === 'execute' && r.chainDepth >= 1,
    ).length
    assert.equal(reworksAfter, reworksBefore, '额度为 0 ⇒ 这条任务一次返工都不该发生')
    assert.ok(runId, '（这条断言只是为了用掉 runId 变量）')
  })

  test('★ 超出范围的返工次数被写入口拒掉（早拒，别等跑起来才发现）', async () => {
    for (const bad of [-1, 6, 1.5]) {
      const res = await fetch(`${daemon.url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId: ulid(),
          kind: 'execute',
          agentRef: { id: agentId, name: '助手', instructions: '' },
          skills: [],
          subject: { type: 'issue', id: issueId },
          prompt: 'x',
          workDir,
          limits: { maxTurns: null, timeoutMs: null },
          maxReworks: bad,
        }),
      })
      assert.equal(res.status, 400, `${bad} 应当被拒`)
    }
  })
})
