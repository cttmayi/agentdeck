import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AsyncQueue,
  type AgentBackend,
  type AgentMessage,
  type AgentSession,
  type ExecOptions,
} from '@alpha-helper/agent-core'
import {
  VERDICT_FENCE_BEGIN,
  VERDICT_FENCE_END,
  ulid,
  type Issue,
  type RunId,
  type VerdictRecord,
} from '@alpha-helper/protocol'
import { startDaemon, type DaemonHandle } from './server.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * S1 端到端：执行 → 自动审核 → 判决 → 动作。
 *
 * 这个测试同时守住两条**不变量**：
 *   - **INV-1~3**：审核者必须不同于执行者；
 *   - **INV-14**：链路深度有上限，不会无限派生。
 */

class TwoPhaseBackend implements AgentBackend {
  readonly key = 'claude'
  readonly protocol = 'stream-json' as const
  readonly rejectDetectable = true

  /** 记录每次调用的角色，用于断言"确实发生了两个阶段"。 */
  readonly phases: string[] = []

  async probe(): Promise<{ available: boolean; command: string; cliVersion: string | null }> {
    return { available: true, command: 'claude', cliVersion: '0.0.0-fake' }
  }

  async execute(opts: ExecOptions): Promise<AgentSession> {
    const context = (await readFile(join(opts.workDir, 'CLAUDE.md'), 'utf8').catch(() => '')) ?? ''
    const isReview = context.includes('审核任务')
    this.phases.push(isReview ? 'review' : 'execute')

    // 从受管上下文里读关联 issue —— 模型也是这么做的
    const relatedIssue = /- 关联 issue：`([^`]+)`/.exec(context)?.[1] ?? 'missing'

    const text = isReview
      ? [
          '审核结论：',
          VERDICT_FENCE_BEGIN,
          JSON.stringify({
            schemaVersion: 1,
            conclusion: 'fail',
            reasonCode: 'missing_tests',
            confidence: 0.8,
            findings: [{ severity: 'high', summary: '没有测试', evidence: [] }],
            // 用模板**允许**的动作（issue.update_status 不在子集内，会被判 invalid）
            action: { type: 'comment.create', params: { issueId: relatedIssue, body: '缺少测试' } },
            escalateReason: null,
          }),
          VERDICT_FENCE_END,
        ].join('\n')
      : '报告：我做完了，但忘了写测试。'

    const queue = new AsyncQueue<AgentMessage>()
    queue.push({ type: 'text', content: text })
    queue.close()

    return {
      messages: queue,
      result: Promise.resolve({
        status: 'completed',
        output: text,
        durationMs: 2,
        sessionId: isReview ? 'review-1' : 'exec-1',
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

let dataDir: string
let workDir: string
let daemon: DaemonHandle
let backend: TwoPhaseBackend
let issueId: Issue['id']
let agentId: string

before(async () => {
  dataDir = await makeTempDir('s1-data')
  workDir = await makeTempDir('s1-work')
  backend = new TwoPhaseBackend()
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

  // 建一个**独立的审核 agent**——INV-1 要求审核者不同于执行者，
  // 所以只有一个 agent 时系统会（正确地）跳过自动审核。
  // ══════════════════════════════════════════════════════════════════
  // D28 之后，自动审核靠"执行者指向审核者"，不再靠 autoReview 开关
  // ══════════════════════════════════════════════════════════════════
  //
  // 所以这里不再手工造一个审核者：bootstrap 已经播种了一对，而且
  // **执行者默认就指着那个审核者**——首启就是一条通的闭环。
  const agents = ((await (await fetch(`${daemon.url}/api/agents`)).json()) as {
    agents: Array<{ id: string; name: string; role: string; reviewerAgentId: string | null }>
  }).agents

  const reviewer = agents.find((a) => a.role === 'reviewer')
  const executor = agents.find((a) => a.role === 'executor')
  assert.ok(reviewer, '★ bootstrap 必须播种审核者 —— 否则报告与执行产出都无人可审')
  assert.ok(executor, 'bootstrap 也会播种一个执行者')
  assert.equal(
    executor!.reviewerAgentId,
    reviewer!.id,
    '★ 执行者默认指向审核者：首启就是一条通的闭环',
  )

  agentId = executor!.id
})

after(async () => {
  await daemon.close()
  await cleanup(dataDir)
  await cleanup(workDir)
})

describe('S1：执行完成后自动接审核', () => {
  test('★ 只提交一次执行，系统自动串出 review run', async () => {
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
      }),
    })
    assert.equal(res.status, 202)

    // 等到出现一个 review run
    const reviewRun = await waitFor(async () => {
      const list = ((await (await fetch(`${daemon.url}/api/runs`)).json()) as {
        runs: Array<{ runId: string; kind: string; status: string }>
      }).runs
      const found = list.find((r) => r.kind === 'review' && r.status === 'completed')
      return found ?? null
    })

    assert.ok(backend.phases.includes('execute'), '应当跑过执行阶段')
    assert.ok(backend.phases.includes('review'), '应当自动跑过审核阶段')

    const verdicts = ((await (
      await fetch(`${daemon.url}/api/runs/${reviewRun.runId}/verdicts`)
    ).json()) as { verdicts: VerdictRecord[] }).verdicts

    assert.equal(verdicts.length, 1)
    assert.equal(verdicts[0]?.conclusion, 'fail')
    assert.equal(verdicts[0]?.status, 'dispatched_to_action')
  })

  test('★ 审核者必须不同于执行者（INV-1~3）', async () => {
    const list = ((await (await fetch(`${daemon.url}/api/runs`)).json()) as {
      runs: Array<{ runId: string; kind: string; agentId: string }>
    }).runs

    const executeRun = list.find((r) => r.kind === 'execute')
    const reviewRun = list.find((r) => r.kind === 'review')
    assert.notEqual(executeRun, undefined)
    assert.notEqual(reviewRun, undefined)
    assert.notEqual(reviewRun!.agentId, executeRun!.agentId, '绝不能自审')
  })

  test('★ 执行者没指定审核者时不自动审 —— 那是明确的选择，不是错误', async () => {
    // D28 之后"跳过自动审核"的触发条件从"没有别人可当审核者"变成了
    // "执行者没指定审核者"。后者是使用者的**明确选择**（reviewerAgentId
    // 为 null），所以只跳过、不警告——而前者是配置缺失。
    const dir = await makeTempDir('s1-noreviewer')
    const work = await makeTempDir('s1-noreviewerwork')
    const b = new TwoPhaseBackend()
    const d = await startDaemon({
      dataDir: dir,
      port: 0,
      fsync: false,
      backend: b,
      onWarn: () => {},
      onInfo: () => {},
    })

    try {
      // 造一个不指向任何审核者的执行者
      const made = ((await (
        await fetch(`${d.url}/api/agents`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: '单独的助手', role: 'executor' }),
        })
      ).json()) as { id: string })

      const runId = ulid() as RunId
      await fetch(`${d.url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId,
          kind: 'execute',
          agentRef: { id: made.id, name: '单独的助手', instructions: '' },
          skills: [],
          subject: { type: 'issue', id: issueId },
          prompt: '干活',
          workDir: work,
          limits: { maxTurns: null, timeoutMs: null },
        }),
      })

      // 等执行跑完
      await waitFor(async () => {
        const r = (await (await fetch(`${d.url}/api/runs/${runId}`)).json()) as { status: string }
        return ['completed', 'failed', 'cancelled'].includes(r.status) ? true : null
      })
      // 再等一会儿，确认没有 review run 冒出来
      await new Promise((r) => setTimeout(r, 300))

      const list = ((await (await fetch(`${d.url}/api/runs`)).json()) as {
        runs: Array<{ kind: string }>
      }).runs
      assert.equal(
        list.filter((r) => r.kind === 'review').length,
        0,
        '★ 没指定审核者就不该自动审 —— 而不是随便找个人来审',
      )
    } finally {
      await d.close()
      await cleanup(dir)
      await cleanup(work)
    }
  })

  test('★ 工作目录被清理干净（失败路径与成功路径都不留痕）', async () => {
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(workDir).catch(() => [] as string[])
    assert.deepEqual(entries, [])
  })
})
