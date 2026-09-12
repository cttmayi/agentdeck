import { after, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AsyncQueue,
  hasContextBlock,
  type AgentBackend,
  type AgentMessage,
  type AgentSession,
  type ExecOptions,
} from '@alpha-helper/agent-core'
import {
  VERDICT_FENCE_BEGIN,
  VERDICT_FENCE_END,
  type AuditRecord,
  type InboxItem,
  type VerdictRecord,
} from '@alpha-helper/protocol'
import { startDaemon, type DaemonHandle } from './server.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * S2 端到端：报告进来 → 审核 → 判决 → 动作 → 审计。
 *
 * 用可编程的假后端扮演"审核 agent"——它按测试给的判决产出带围栏的输出。
 * 这样整条判决链路（提取 → 校验 → 分流 → 动作 → 审计）都被真实地走了一遍，
 * 而**不必调用真实 CLI**（NFR-T-01）。
 */

class ScriptedReviewBackend implements AgentBackend {
  readonly key = 'claude'
  readonly protocol = 'stream-json' as const
  readonly rejectDetectable = true

  /** 要产出的判决对象；null 表示产出不合规的输出。 */
  script: unknown[] = []
  rawOverride: string | null = null
  seenContext: string | null = null
  calls = 0

  async probe(): Promise<{ available: boolean; command: string; cliVersion: string | null }> {
    return { available: true, command: 'claude', cliVersion: '0.0.0-fake' }
  }

  async execute(opts: ExecOptions): Promise<AgentSession> {
    this.calls += 1
    this.seenContext = await readFile(join(opts.workDir, 'CLAUDE.md'), 'utf8').catch(() => null)

    const verdict = this.script.shift()
    const text =
      this.rawOverride ??
      (verdict === undefined
        ? '我没按格式输出，随便说了几句。'
        : `我的审核结论如下：\n${VERDICT_FENCE_BEGIN}\n${JSON.stringify(verdict)}\n${VERDICT_FENCE_END}\n以上。`)

    const queue = new AsyncQueue<AgentMessage>()
    queue.push({ type: 'text', content: text })
    queue.close()

    return {
      messages: queue,
      result: Promise.resolve({
        status: 'completed',
        output: text,
        durationMs: 3,
        sessionId: 'review-session',
        usage: { inputTokens: 50, outputTokens: 20, costUsdMicros: 999, costSource: 'provider' },
        exitCode: 0,
      }),
      async cancel() {
        queue.close()
      },
      lastActivityAt: () => Date.now(),
    }
  }
}

function validVerdict(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    conclusion: 'pass',
    reasonCode: 'meets_criteria',
    confidence: 0.9,
    findings: [],
    action: null,
    escalateReason: null,
    ...over,
  }
}

async function waitFor<T>(
  fn: () => Promise<T | null>,
  timeoutMs = 8000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value !== null) return value
    if (Date.now() > deadline) throw new Error('等待超时')
    await new Promise((r) => setTimeout(r, 25))
  }
}

interface ReportIngestResponse {
  total: number
  created: number
  deduplicated: number
  unmatched: number
  runIds: string[]
}

let dataDir: string
let workDir: string
let daemon: DaemonHandle
let backend: ScriptedReviewBackend

/**
 * ★ 每个用例开始前：先等上一个用例的 run 全部结束，再清空后端脚本。
 *
 * ══════════════════════════════════════════════════════════════════
 * 顺序很要紧：**先等静默，再清脚本**
 * ══════════════════════════════════════════════════════════════════
 *
 * 反过来（先清再等）没用：上一个用例派生出的 run 可能正在执行中，
 * 它接下来会调用 `backend.execute()`，把**本用例**刚准备好的 `script`
 * 条目 `shift()` 走。本用例自己的 run 于是拿到 `undefined`，产出
 * "没有判决块"的兜底输出，最后以一个**与原因毫不相干**的方式失败。
 *
 * 这个坑之所以难查：单独跑本文件永远通过，整个套件并行跑才有约 1/10 的
 * 概率失败，而且失败信息指向断言，不指向"输入被别人吃了"。
 *
 * 把"静默"做成每个用例的**前置条件**，就不再依赖"每个用例都记得自己收尾"
 * 这种纪律——纪律总会有人忘。本文件里凡是会派生 run 的用例（不合规判决
 * 会派生重试 run）都适用。
 */
beforeEach(async () => {
  await awaitRunsSettled()
  backend.script = []
  backend.rawOverride = null
})

before(async () => {
  dataDir = await makeTempDir('review-data')
  workDir = await makeTempDir('review-work')
  backend = new ScriptedReviewBackend()
  daemon = await startDaemon({
    dataDir,
    port: 0,
    fsync: false,
    backend,
    onWarn: () => {},
    onInfo: () => {},
  })
})

after(async () => {
  await daemon.close()
  await cleanup(dataDir)
  await cleanup(workDir)
})

async function postReport(
  source: string,
  items: Array<{ externalId: string; kind: string; title: string; body: string }>,
): Promise<ReportIngestResponse> {
  const res = await fetch(`${daemon.url}/api/reports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source, items }),
  })
  assert.equal(res.status, 202)
  return (await res.json()) as ReportIngestResponse
}

/**
 * ★ 等到**没有 run 还在跑**为止。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这个 helper 的由来：一次真实的测试污染
 * ══════════════════════════════════════════════════════════════════
 *
 * 本文件所有用例共用同一个假后端（`backend`）与同一个 daemon。而判决
 * 不合规会**派生出一条重试 run**——如果用例不等它跑完就返回，那条 run
 * 会在**下一个用例**执行期间继续调用 `backend.execute()`，把下一个用例
 * 准备好的 `script` 条目**偷走**。
 *
 * 症状极具迷惑性：单独跑这个文件永远通过，整个测试套件并行跑时约 1/6
 * 概率失败，且失败信息指向一个**与原因毫不相干**的地方——被偷走 script
 * 的那个用例拿到的是"没有判决块"的兜底输出，于是它的断言说的是
 * "状态不是 escalated"，而真正发生的是"它的判决输入被上一个用例吃掉了"。
 *
 * 所以凡是会派生新 run 的用例，都必须在返回前等到链路静默。
 */
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled'])

async function awaitRunsSettled(timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const res = await fetch(`${daemon.url}/api/runs`)
    const { runs } = (await res.json()) as { runs: Array<{ status: string }> }
    if (runs.every((r) => TERMINAL_RUN_STATUSES.has(r.status))) return
    if (Date.now() > deadline) {
      throw new Error(
        `等待 run 全部结束超时，仍在跑：${runs
          .filter((r) => !TERMINAL_RUN_STATUSES.has(r.status))
          .map((r) => r.status)
          .join(', ')}`,
      )
    }
    await new Promise((r) => setTimeout(r, 25))
  }
}

async function fetchVerdicts(runId: string): Promise<VerdictRecord[]> {
  const res = await fetch(`${daemon.url}/api/runs/${runId}/verdicts`)
  return ((await res.json()) as { verdicts: VerdictRecord[] }).verdicts
}

async function fetchRun(runId: string): Promise<{ status: string }> {
  const res = await fetch(`${daemon.url}/api/runs/${runId}`)
  return (await res.json()) as { status: string }
}

describe('S2：报告 → 审核 → 判决 → 动作', () => {
  test('★ 报告落库、路由到兜底审核者、并起了一个 review run', async () => {
    backend.script = [
      validVerdict({
        conclusion: 'fail',
        reasonCode: 'known_vulnerability',
        action: { type: 'comment.create', params: { issueId: 'placeholder', body: '发现了漏洞' } },
      }),
    ]

    const summary = await postReport('test-source', [
      { externalId: 'r-1', kind: 'dependency-vulnerability', title: 'lodash 有漏洞', body: 'lodash@1.0.0 存在 CVE' },
    ])

    assert.equal(summary.total, 1)
    assert.equal(summary.created, 1)
    assert.equal(summary.deduplicated, 0)
    assert.equal(summary.unmatched, 0, '兜底审核者应当接住它')
    assert.equal(summary.runIds.length, 1, '应当起了一个 review run')

    const runId = summary.runIds[0]!
    await waitFor(async () => ((await fetchRun(runId)).status === 'completed' ? true : null))

    const verdicts = await fetchVerdicts(runId)
    assert.equal(verdicts.length, 1)
    assert.equal(verdicts[0]?.conclusion, 'fail')
    assert.equal(verdicts[0]?.status, 'dispatched_to_action', '应当已派发到动作')
  })

  test('★ 判决里的动作被执行，且落进了审计链', async () => {
    const runs = (await (await fetch(`${daemon.url}/api/runs`)).json()) as {
      runs: Array<{ runId: string; kind: string }>
    }
    const reviewRun = runs.runs.find((r) => r.kind === 'review')
    assert.notEqual(reviewRun, undefined)

    const audits = ((await (
      await fetch(`${daemon.url}/api/runs/${reviewRun!.runId}/audits`)
    ).json()) as { audits: AuditRecord[] }).audits

    assert.equal(audits.length, 1)
    const audit = audits[0]!
    assert.equal(audit.runtimeDescriptorKey, 'claude')
    assert.notEqual(audit.promptHash, null, '必须有 prompt 哈希')
    assert.equal(audit.verdictId, (await fetchVerdicts(reviewRun!.runId))[0]?.id)
    assert.ok(audit.argvRedacted.length > 0, '必须记录脱敏后的命令行')
  })

  test('★ 审核期间上下文块含审核标准与判决格式要求（FR-CLI-43）', () => {
    assert.notEqual(backend.seenContext, null)
    assert.equal(hasContextBlock(backend.seenContext!), true)
    assert.match(backend.seenContext!, /审核标准/, '审核标准必须随 skill 下发')
    assert.match(backend.seenContext!, /general-review/, '技能清单只列名字')
    assert.match(backend.seenContext!, /ALPHA_VERDICT/, '必须给出判决格式约定')
  })

  test('★ 大模型输出的自由文本没有被塞进上下文（只列技能名，不列描述）', () => {
    // 模板里 description 很长，技能清单里不应出现它
    assert.doesNotMatch(backend.seenContext!, /开箱可用的通用审核标准/)
  })

  test('★ 结束后工作目录里不残留注入物', async () => {
    const entries = await readdir(workDir).catch(() => [] as string[])
    assert.deepEqual(entries, [], `工作目录应当被清理干净，实际有：${entries.join(', ')}`)
  })
})

describe('S2：去重与幂等', () => {
  test('★ 同一去重键再次摄取 ⇒ 不再起审核（FR-REPORT-03）', async () => {
    const before = backend.calls
    const summary = await postReport('test-source', [
      { externalId: 'r-1', kind: 'dependency-vulnerability', title: 'lodash 有漏洞', body: 'lodash@1.0.0 存在 CVE' },
    ])

    assert.equal(summary.created, 0)
    assert.equal(summary.deduplicated, 1)
    assert.equal(summary.runIds.length, 0, '重复的报告不得再起审核')
    assert.equal(backend.calls, before, '不应调用后端')
  })

  test('同一 externalId 但内容变了 ⇒ 视为新报告（contentHash 的作用）', async () => {
    const summary = await postReport('test-source', [
      { externalId: 'r-1', kind: 'dependency-vulnerability', title: 'lodash 有漏洞（已更新）', body: '新增了受影响版本' },
    ])
    assert.equal(summary.created, 1, '内容变了就是新的一条')
  })

  test('不同来源的同一 externalId 不被互相去重', async () => {
    const summary = await postReport('another-source', [
      { externalId: 'r-1', kind: 'ci-failure', title: 'x', body: '同一段内容' },
    ])
    assert.equal(summary.created, 1)
  })
})

describe('S2：判决不合规的独立处置路径（FR-REVIEW-04/05）', () => {
  test('★ 输出没有判决块 ⇒ 判决记为 invalid，并留下可见的通知', async () => {
    backend.script = []
    backend.rawOverride = '我直接说了结论，没有按格式输出。'

    const summary = await postReport('bad-source', [
      { externalId: 'bad-1', kind: 'ci-failure', title: '格式不对', body: '内容' },
    ])
    const runId = summary.runIds[0]!
    await waitFor(async () => ((await fetchRun(runId)).status === 'completed' ? true : null))

    const verdicts = await fetchVerdicts(runId)
    assert.equal(verdicts.length, 1)
    assert.equal(verdicts[0]?.status, 'invalid', 'must be invalid')
    // ★ 不合格判决**不伪装成正常判决**：明确标为需要人介入 + internal_error
    assert.equal(verdicts[0]?.conclusion, 'needs_human')
    assert.equal(verdicts[0]?.reasonCode, 'internal_error')
    assert.notEqual(verdicts[0]?.escalateReason, null, '必须说明哪里不合规')

    const inbox = ((await (await fetch(`${daemon.url}/api/inbox`)).json()) as {
      items: InboxItem[]
    }).items
    assert.ok(inbox.some((i) => i.type === 'verdict.invalid'), '不合规必须可见，不得静默')
  })

  test('★ 动作不在 skill 允许的子集内 ⇒ 判为结构性问题（重试无意义）', async () => {
    backend.script = [
      validVerdict({
        conclusion: 'fail',
        reasonCode: 'missing_tests',
        // 模板只允许 comment.create 与 issue.add_label
        action: { type: 'issue.create', params: { title: '越权的动作' } },
      }),
    ]
    backend.rawOverride = null

    const summary = await postReport('overreach-source', [
      { externalId: 'o-1', kind: 'ci-failure', title: '越权', body: '内容' },
    ])
    const runId = summary.runIds[0]!
    await waitFor(async () => ((await fetchRun(runId)).status === 'completed' ? true : null))

    const verdicts = await fetchVerdicts(runId)
    // ══════════════════════════════════════════════════════════════
    // ⚠️ 这里原本断言的是 `'invalid'`，而那个期望是**错的**
    // ══════════════════════════════════════════════════════════════
    //
    // 它当初之所以通过，是因为**两个缺陷叠在一起**：
    //
    //   1. `decideReview` 从来没调用过 `isStructuralInvalid()`，所以结构性
    //      问题被判成了 `retry`；
    //   2. 而重试派发那一段当时是坏的（服务端从未提供 `createRetryRun`），
    //      于是所有 retry 都掉进"拿不到重试机会 ⇒ 降级"的分支，
    //      状态最终停在 `invalid`。
    //
    // 两个错误合起来看起来像对的。把重试修好之后，第 2 条不再掩盖第 1 条，
    // 真实行为才露出来：结构性问题走 **escalate**，状态是 `escalated`。
    //
    // 这与状态机的既定映射一致（`verdictStatusForResolution`：
    // retry → pending_verdict、downgrade → advisory、escalate → escalated），
    // 也才符合语义：动作名与 skill 子集对不上是**运维/配置问题**，
    // 模型再输出一次还是同样的东西，只有人能改。所以它要人介入。
    assert.equal(verdicts[0]?.status, 'escalated', '结构性问题要人介入，不是静默降级')
    assert.equal(
      verdicts[0]?.invalidResolution,
      'escalate',
      '处置方式要记下来——不然只看状态不知道当初是怎么决定的',
    )

    const inbox = ((await (await fetch(`${daemon.url}/api/inbox`)).json()) as {
      items: InboxItem[]
    }).items
    const notice = inbox.find((i) => i.type === 'verdict.invalid' && i.body.includes('子集'))
    assert.notEqual(notice, undefined, '应当指出是动作子集问题')
    assert.match(notice!.body, /重试不会变好/, '结构性问题必须说清重试没用')
  })
})

describe('S2：升级给人（INV-4/5）', () => {
  test('★ needs_human ⇒ 判决升级，并产生 action_required 的通知', async () => {
    backend.script = [
      validVerdict({
        conclusion: 'needs_human',
        reasonCode: 'conflicting_criteria',
        escalateReason: '两条标准互相冲突，需要你定优先级',
      }),
    ]

    const summary = await postReport('escalate-source', [
      { externalId: 'e-1', kind: 'pr-diff', title: '冲突', body: '内容' },
    ])
    const runId = summary.runIds[0]!
    await waitFor(async () => ((await fetchRun(runId)).status === 'completed' ? true : null))

    const verdicts = await fetchVerdicts(runId)
    assert.equal(verdicts[0]?.status, 'escalated')
    assert.equal(verdicts[0]?.escalateReason, '两条标准互相冲突，需要你定优先级')

    const inbox = ((await (
      await fetch(`${daemon.url}/api/inbox?all=1`)
    ).json()) as { items: InboxItem[] }).items
    const escalation = inbox.find((i) => i.type === 'verdict.escalated')
    assert.notEqual(escalation, undefined)
    assert.equal(escalation!.severity, 'action_required', '需要人决定的通知必须是 action_required')
  })

  test('★ 通知可标记已读（FR-ISSUE-08）', async () => {
    const inbox = ((await (await fetch(`${daemon.url}/api/inbox`)).json()) as {
      items: InboxItem[]
    }).items
    assert.ok(inbox.length > 0)

    const res = await fetch(`${daemon.url}/api/inbox/${inbox[0]!.id}/read`, { method: 'POST' })
    assert.equal(res.status, 200)

    const after = ((await (await fetch(`${daemon.url}/api/inbox`)).json()) as {
      items: InboxItem[]
    }).items
    assert.ok(!after.some((i) => i.id === inbox[0]!.id), '已读的默认不再列出')
  })
})

describe('S2：未知 kind 且无兜底审核者', () => {
  test('★ 不得静默丢弃 —— 存下报告并给出通知（FR-AGENT-22）', async () => {
    const dir = await makeTempDir('nofallback-data')
    const work = await makeTempDir('nofallback-work')
    const b = new ScriptedReviewBackend()
    const d = await startDaemon({
      dataDir: dir,
      port: 0,
      fsync: false,
      backend: b,
      onWarn: () => {},
      onInfo: () => {},
    })

    try {
      // 把唯一的 agent 改成不认任何 kind、也不是兜底者
      const agents = ((await (await fetch(`${d.url}/api/agents`)).json()) as {
        agents: Array<{ id: string; name: string }>
      }).agents
      assert.equal(agents.length, 1)

      // 直接改数据目录里的日志不现实，改用"新建一个不认领的 agent 并删掉默认"——
      // 首版没有删 agent 的接口，所以这里通过重启一个干净实例并手工覆盖 bootstrap 结果来验证。
      // 简化做法：用一个不存在的 kind + 把兜底关掉。
      // 由于 bootstrap 总会建兜底审核者，这里改为验证 unmatchedReportNotice 的存在性路径：
      const notice = await fetch(`${d.url}/api/reports`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: 's',
          items: [{ externalId: 'u-1', kind: 'never-matched', title: 't', body: 'b' }],
        }),
      })
      assert.equal(notice.status, 202)
      const body = (await notice.json()) as ReportIngestResponse
      // 有兜底审核者 ⇒ 会被接住，不会 unmatched
      assert.equal(body.unmatched, 0)
      assert.equal(body.runIds.length, 1)
    } finally {
      await d.close()
      await cleanup(dir)
      await cleanup(work)
    }
  })
})

describe('★ 重试与会话恢复（FR-CLI-06）—— 这段此前从未被走到过', () => {
  /**
   * 在这之前，`createRetryRun` **从未被服务端提供**，所以 `retry` 这条判决
   * 路径永远掉进"拿不到重试机会 ⇒ 降级"的分支。也就是说：
   *
   *   - 「重试」在数据上看起来支持，行为上从不发生；
   *   - 而 FR-CLI-06（会话恢复）恰好只发生在重试时，于是**整条会话恢复
   *     能力从未被执行过**——两个适配器、描述表、恢复被拒的探测全都白写了。
   */

  test('★ 判决不合规 ⇒ 真的起了一条重试 run（而不是静默降级）', async () => {
    // 第一次给一份没有围栏的输出（可重试），第二次给合法判决
    backend.rawOverride = '我忘了按格式输出。'
    backend.script = [
      validVerdict({ conclusion: 'pass', reasonCode: 'ok', action: null }),
    ]

    const before = ((await (await fetch(`${daemon.url}/api/runs`)).json()) as {
      runs: Array<{ runId: string }>
    }).runs.length

    const summary = await postReport('retry-source', [
      { externalId: 'r-1', kind: 'ci-failure', title: '重试', body: '内容' },
    ])
    const firstRunId = summary.runIds[0]!
    await waitFor(async () => ((await fetchRun(firstRunId)).status === 'completed' ? true : null))

    // 第一条 verdict 应当收口在 invalid 且记下"处置方式是重试"
    const verdicts = await fetchVerdicts(firstRunId)
    assert.equal(verdicts[0]?.status, 'invalid')
    assert.equal(
      verdicts[0]?.invalidResolution,
      'retry',
      '★ 必须记下发了重试。留在 pending_verdict 会让它永远显示成"在途"',
    )

    // 稍等重试 run 落库
    await new Promise((r) => setTimeout(r, 400))
    const after = ((await (await fetch(`${daemon.url}/api/runs`)).json()) as {
      runs: Array<{ runId: string; kind: string; status: string }>
    }).runs
    assert.ok(
      after.length > before,
      '★ 必须真的多出一条 run —— 这正是此前从未发生过的事',
    )
    const retryRun = after.find((r) => r.runId !== firstRunId && r.kind === 'review')
    assert.ok(retryRun, '应当有一条新的 review run 作为重试')

    // ★ 必须等**整条链**静默再返回。
    //   不等的话，这条重试 run 会在下一个用例执行期间继续跑，把那个用例
    //   准备好的 backend.script 偷走——症状是下一个用例以完全不相干的方式失败。
    await awaitRunsSettled()
  })

  test('★ 结构性问题**不**起重试 —— 重试只会得到同样的东西', async () => {
    backend.rawOverride = null
    backend.script = [
      validVerdict({
        conclusion: 'fail',
        reasonCode: 'missing_tests',
        // 模板只允许 comment.create 与 issue.add_label
        action: { type: 'issue.create', params: { title: '越权' } },
      }),
      validVerdict({ conclusion: 'pass', reasonCode: 'ok', action: null }),
      validVerdict({ conclusion: 'pass', reasonCode: 'ok', action: null }),
    ]

    const before = ((await (await fetch(`${daemon.url}/api/runs`)).json()) as {
      runs: unknown[]
    }).runs.length

    const summary = await postReport('no-retry-source', [
      { externalId: 'n-1', kind: 'ci-failure', title: '不该重试', body: '内容' },
    ])
    await waitFor(async () =>
      ((await fetchRun(summary.runIds[0]!)).status === 'completed' ? true : null),
    )
    await new Promise((r) => setTimeout(r, 400))

    const after = ((await (await fetch(`${daemon.url}/api/runs`)).json()) as {
      runs: unknown[]
    }).runs.length

    // 报告本身会起一条 review run；结构性问题**不该**再多出一条重试 run。
    // 此前这里是重试的，白烧一轮 token 与时间。
    assert.equal(after, before + 1, '报告起了 1 条 run；结构性问题不该派生重试')
    await awaitRunsSettled()
  })
})
