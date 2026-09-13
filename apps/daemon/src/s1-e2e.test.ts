import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
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

/** 执行者在工作目录里留下的产出文件名（审核者要能看见它）。 */
const EXECUTOR_ARTIFACT = '产出.txt'

class TwoPhaseBackend implements AgentBackend {
  readonly key = 'claude'
  readonly protocol = 'stream-json' as const
  readonly rejectDetectable = true

  /** 记录每次调用的角色，用于断言"确实发生了两个阶段"。 */
  readonly phases: string[] = []

  /**
   * ★ 审核那一刻，它**在自己拿到的工作目录里**能不能看见执行者留下的产出。
   *
   * 这正是"执行与审核必须在同一个工作目录"这条要求的实质：过程隔离，
   * 但审核必须看得见产出。断言"两个 run 的 workDir 字符串相等"是在测实现，
   * 而这条是在测**使用者真正关心的事**——审核者眼里有没有东西可审。
   */
  sawExecutorArtifact: boolean | null = null

  async probe(): Promise<{ available: boolean; command: string; cliVersion: string | null }> {
    return { available: true, command: 'claude', cliVersion: '0.0.0-fake' }
  }

  async execute(opts: ExecOptions): Promise<AgentSession> {
    const context = (await readFile(join(opts.workDir, 'CLAUDE.md'), 'utf8').catch(() => '')) ?? ''
    const isReview = context.includes('审核任务')
    this.phases.push(isReview ? 'review' : 'execute')

    // 从受管上下文里读关联 issue —— 模型也是这么做的
    const relatedIssue = /- 关联 issue：`([^`]+)`/.exec(context)?.[1] ?? 'missing'

    if (isReview) {
      this.sawExecutorArtifact = await readFile(join(opts.workDir, EXECUTOR_ARTIFACT), 'utf8').then(
        () => true,
        () => false,
      )
    } else {
      // 执行者把产出写在自己的工作目录里（真实场景就是 agent 写下的那些文件）
      await writeFile(join(opts.workDir, EXECUTOR_ARTIFACT), '执行者写下的产出\n', 'utf8')
    }

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

  test('★ 审核者必须能看见执行者留下的产出（过程隔离，但同一间屋子）', async () => {
    // ══════════════════════════════════════════════════════════════════
    // 这条测试是为一个**真实缺陷**写的
    // ══════════════════════════════════════════════════════════════════
    //
    // 审核 run 的 subject 是 `{type:'run', id: 被审的runId}`，而工作目录是按
    // subject 自动分配的——于是审核者拿到 `run-<被审的runId>`，执行者用的是
    // `issue-<任务id>`。**两个目录**。
    //
    // 后果不是报错，而是审核变得没有依据：审核者手里只有报告正文那一段转述，
    // 产出文件、中间结果一个都看不到，却照样会给出一个看起来很像样的判决。
    // 这类"静默地少了依据"的错，只有断言"它到底看见了什么"才抓得住。
    assert.equal(
      backend.sawExecutorArtifact,
      true,
      '★ 审核 run 必须在被审那条 run 的工作目录里跑，否则它看不见产出文件',
    )
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

  test('★ 上下文块被逐字节还原；技能**保留**（使用者的决定：要能看见它在什么标准下干活）', async () => {
    // ══════════════════════════════════════════════════════════════════
    // 这条测试的期望被改过一次，改的是**哪一个**该被清掉
    // ══════════════════════════════════════════════════════════════════
    //
    // 原来断言工作目录"一个条目都不剩"。那时技能也是跑完就删的。
    //
    // 但那样有两个坏结果：① 任务跑完你进工作目录看，**看不出它是在什么标准下
    // 干活的**（技能已经没了）；② 删除的依据是**进程内的数组**，daemon 崩溃
    // 或被 kill 之后就没了记忆，残留的技能文件会被以后的 run **继续发现**——
    // "你摘掉的技能还在生效"。
    //
    // 现在的规矩分得很清：
    //   - **CLAUDE.md 必须逐字节还原**（它是使用者的文件，我们只是临时借用）；
    //   - **技能保留**（那是这个任务上下文的一部分），去留由落盘的归属清单对账。
    const { readFile, readdir } = await import('node:fs/promises')
    const entries = await readdir(workDir).catch(() => [] as string[])

    // 上下文文件：**我们自己造的**那份留着（使用者的原文件另有一套用例保证逐字节还原）
    const claudeMd = await readFile(join(workDir, 'CLAUDE.md'), 'utf8').catch(() => null)
    assert.notEqual(claudeMd, null, '★ 我们自己造的上下文文件要留在工作目录里')

    // 技能：应当还在，并且有归属清单
    assert.ok(entries.includes('.claude'), '技能现在保留在工作目录里')
    assert.ok(entries.includes('CLAUDE.md'), '上下文文件也保留')
    const skillsDir = join(workDir, '.claude', 'skills')
    const manifest = await readFile(join(skillsDir, '.alpha-helper-managed.json'), 'utf8')
    const parsed = JSON.parse(manifest) as { slugs: string[] }
    assert.ok(Array.isArray(parsed.slugs), '★ 归属清单必须落盘（否则崩溃后残留无从识别）')
  })
})
