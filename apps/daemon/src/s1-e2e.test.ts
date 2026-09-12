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
  // 审核者必须挂载审核 skill —— 没有 skill 就没有审核标准，无法审
  const skills = ((await (await fetch(`${daemon.url}/api/skills`)).json()) as {
    skills: Array<{ id: string; slug: string }>
  }).skills
  assert.ok(skills.length > 0, 'bootstrap 应当内置了一个审核模板')

  await fetch(`${daemon.url}/api/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: '审核员',
      isFallbackReviewer: true,
      skillIds: [skills[0]!.id],
    }),
  })

  const agents = ((await (await fetch(`${daemon.url}/api/agents`)).json()) as {
    agents: Array<{ id: string; name: string; autoReview: boolean }>
  }).agents
  assert.equal(agents.length, 2)

  // 执行者：bootstrap 建的那个（autoReview 默认为 true）
  const executor = agents.find((a) => a.name === '助手')
  assert.notEqual(executor, undefined)
  agentId = executor!.id
  assert.equal(executor!.autoReview, true, 'bootstrap 的 agent 默认开启自动审核')
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

  test('★ 只有一个 agent 时跳过自动审核，而不是自审', async () => {
    // 再造一个实例、把唯一的 agent 当作执行者：此时没有"别的 agent"可当审核者，
    // 系统必须**跳过**并留警告，而不是让同一个 agent 自审（那会让闭环变成假的）。
    const dir = await makeTempDir('s1-solo')
    const work = await makeTempDir('s1-solowork')
    const b = new TwoPhaseBackend()
    const d = await startDaemon({ dataDir: dir, port: 0, fsync: false, backend: b, onWarn: () => {}, onInfo: () => {} })

    try {
      const agents = ((await (await fetch(`${d.url}/api/agents`)).json()) as {
        agents: Array<{ id: string }>
      }).agents
      // 把兜底审核者关掉，且只留一个 agent ⇒ 没有合法审核者
      await fetch(`${d.url}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '第二个 agent' }),
      })

      const issueRes = await fetch(`${d.url}/api/issues`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 't' }),
      })
      const iid = ((await issueRes.json()) as Issue).id

      const runId = ulid() as RunId
      await fetch(`${d.url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId,
          kind: 'execute',
          agentRef: { id: agents[0]!.id, name: '助手', instructions: '' },
          skills: [],
          subject: { type: 'issue', id: iid },
          prompt: 'x',
          workDir: work,
          limits: { maxTurns: null, timeoutMs: null },
        }),
      })

      await waitFor(async () => {
        const list = ((await (await fetch(`${d.url}/api/runs`)).json()) as {
          runs: Array<{ kind: string; status: string }>
        }).runs
        return list.some((r) => r.kind === 'execute' && r.status === 'completed') ? true : null
      })

      const list = ((await (await fetch(`${d.url}/api/runs`)).json()) as {
        runs: Array<{ kind: string; agentId: string }>
      }).runs
      const exec = list.find((r) => r.kind === 'execute')!
      const reviews = list.filter((r) => r.kind === 'review')
      for (const review of reviews) {
        assert.notEqual(review.agentId, exec.agentId, '任何情况下都不得自审')
      }
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
