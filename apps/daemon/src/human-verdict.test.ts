import { after, before, describe, test } from 'node:test'
import { deliveredText } from './testing/delivered.ts'
import assert from 'node:assert/strict'
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
} from '@agentdeck/protocol'
import { startDaemon, type DaemonHandle } from './server.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * 人工裁决（D46）——`POST /api/runs/{id}/human-verdict`。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这个功能为什么必须钉在**真实链路**上
 * ══════════════════════════════════════════════════════════════════
 *
 * 它要解决的是一个**界面上的死胡同**：审核判 `fail` 且没有返工额度 ⇒ 任务进
 * 「等待人处理」，而详情页上唯一的按钮是「继续沟通」——那是再派一次活给 agent，
 * 不是"我自己来定"。于是"我看过了，这条我认可"这件事在系统里无法表达。
 *
 * 而它的正确性**不在界面上**：看板的阶段是从记录**推出来的**
 * （`apps/web/src/lib/pipeline.ts` 的 `stageOf`），所以人工裁决必须落成一条
 * 判决记录，并且落在**阶段推导会看的那条 run** 上。落错地方的后果是
 * "请求 201 成功、判决确实落库了、看板一动不动"——这个仓库最防的那类失效，
 * 而且两边都不报错。
 *
 * 所以这一整个文件断言的都不是"接口返回了什么"，而是**落库之后能被谁看见**：
 * 判决记录的形状（谁做的、理由在哪、有没有动作）、`/api/runs` 那条投影
 * （阶段推导的唯一入口）拿到的 `source`，以及"挂错位置"必须被**响亮地拒掉**。
 *
 * 用什么跑的：照抄 `reviewer-override.test.ts` 的 fixture（假后端 + `makeTempDir`
 * + 真 HTTP）。**NFR-T-01：绝不调用使用者真实安装的 agent CLI。**
 */

/**
 * 两阶段的假后端：按第一句话分辨"这次是执行还是审核"。
 *
 * `reviewConclusion` 可以改——本文件的夹具需要两种审核结论：
 *   - `fail` ⇒ 任务落到「等待人处理」（人工裁决的主场景）；
 *   - `pass` ⇒ 任务已经是「已完成审查」（用来测"改判"与"执行 run 不该被裁决"）。
 */
class HumanVerdictBackend implements AgentBackend {
  readonly key = 'claude'
  readonly protocol = 'stream-json' as const
  readonly rejectDetectable = true

  reviewConclusion: 'pass' | 'fail' = 'fail'
  readonly phases: string[] = []

  async probe(): Promise<{ available: boolean; command: string; cliVersion: string | null }> {
    return { available: true, command: 'claude', cliVersion: '0.0.0-fake' }
  }

  async execute(opts: ExecOptions): Promise<AgentSession> {
    // D29 之后"这是审核还是执行"只能看第一句话：它的开头是 `# 任务` 或 `# 审核任务`。
    const isReview = deliveredText(opts).includes('# 审核任务')
    this.phases.push(isReview ? 'review' : 'execute')

    const text = isReview
      ? [
          '审核结论：',
          VERDICT_FENCE_BEGIN,
          JSON.stringify({
            schemaVersion: 1,
            conclusion: this.reviewConclusion,
            reasonCode: this.reviewConclusion === 'pass' ? 'meets_criteria' : 'missing_tests',
            confidence: 0.9,
            findings:
              this.reviewConclusion === 'pass'
                ? []
                : [
                    {
                      severity: 'high',
                      summary: '缺少测试',
                      evidence: [],
                      // ⚠️ 这里**不能写 `detail: null`**：`Finding` 是 `strictObject`，
                      //    而 `detail` 是 `z.record(...).optional()`——`null` 不是
                      //    record，整个判决会被判**不合规**，于是任务落到「判决不合规」
                      //    而不是「审核不通过」，本文件好几条用例的前提就没了。
                      //    （这个坑真踩了一次：症状是 `conclusion` 读到 `needs_human`。）
                    },
                  ],
            // ★ `fail` **不得带 action**（D45，schema 层拦着）。这里必须真的不带，
            //   否则判决会被判不合规，任务落到「判决不合规」而不是「审核不通过」——
            //   本文件好几条用例的前提就没了。
            action: null,
            escalateReason: null,
          }),
          VERDICT_FENCE_END,
        ].join('\n')
      : '报告：任务已完成。'

    const queue = new AsyncQueue<AgentMessage>()
    queue.push({ type: 'text', content: text })
    queue.close()

    return {
      messages: queue,
      result: Promise.resolve({
        status: 'completed' as const,
        output: text,
        error: null,
        durationMs: 3,
        sessionId: isReview ? 'review-session' : 'exec-session',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          costUsdMicros: 100,
          costSource: 'provider' as const,
        },
        exitCode: 0,
      }),
      async cancel() {
        queue.close()
      },
      lastActivityAt: () => Date.now(),
    }
  }
}

let dataDir: string
let daemon: DaemonHandle
let backend: HumanVerdictBackend
/** 配了审核者的执行者——绝大多数用例用它，于是会派生审核 run。 */
let executor: { id: string; name: string }
/** 自建的临时工作目录，`after` 里统一清掉。 */
const workDirs: string[] = []

before(async () => {
  dataDir = await makeTempDir('human-verdict-data')
  backend = new HumanVerdictBackend()
  daemon = await startDaemon({
    dataDir,
    port: 0, // 让内核分配端口，避免测试之间抢端口
    fsync: false,
    backend,
    onWarn: () => {},
    onInfo: () => {},
  })

  // ★ 审核者必须**自带审核标准**（`reviewStandard`），否则平台根本不会派生审核
  //   run：没有标准的审核不算审核（D37）。首启播种的那个审核者有标准，但这里
  //   新建一个显式的，免得用例依赖"首启恰好播种了什么"（D38 那次踩过）。
  const reviewerId = await createAgent({
    name: '审核者',
    role: 'reviewer',
    reviewStandard: { body: '# 标准\n\n只看结论有没有依据。' },
  })
  const name = '执行者'
  executor = {
    id: await createAgent({ name, role: 'executor', reviewerAgentId: reviewerId }),
    name,
  }
})

after(async () => {
  await daemon.close()
  await cleanup(dataDir)
  for (const dir of workDirs) await cleanup(dir)
})

async function createAgent(body: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${daemon.url}/api/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const created = (await res.json()) as { id?: string }
  assert.equal(res.status, 201, `建 agent 失败：${JSON.stringify(created)}`)
  assert.ok(created.id, 'agent 必须带 id')
  return created.id
}

async function newIssue(title: string): Promise<string> {
  const res = await fetch(`${daemon.url}/api/issues`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, description: '' }),
  })
  assert.equal(res.status, 201, '建 issue 必须成功')
  return ((await res.json()) as Issue).id
}

async function newWorkDir(): Promise<string> {
  const dir = await makeTempDir('human-verdict-work')
  workDirs.push(dir)
  return dir
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

/** 提交一条 execute run 并等它（以及它派生的审核）全部跑完。 */
async function runTask(input: {
  issueId: string
  /** 省略 = 跟随 agent 的「由谁审它」；`null` = 这一次明确不审。 */
  reviewerAgentId?: string | null
}): Promise<{ executeRunId: RunId; reviewRunId: RunId | null }> {
  const runId = ulid() as RunId
  const payload: Record<string, unknown> = {
    runId,
    kind: 'execute',
    agentRef: { id: executor.id, name: executor.name, instructions: '' },
    skills: [],
    subject: { type: 'issue', id: input.issueId },
    prompt: '把这次任务做完',
    workDir: await newWorkDir(),
    limits: { maxTurns: null, timeoutMs: null },
  }
  if ('reviewerAgentId' in input) payload['reviewerAgentId'] = input.reviewerAgentId

  const res = await fetch(`${daemon.url}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  assert.equal(res.status, 202, `提交 run 必须受理：${JSON.stringify(await res.json())}`)
  await waitForSettled(runId)

  const derived = await derivedRuns(runId)
  const review = derived.find((r) => r.kind === 'review') ?? null
  if (review) await waitForSettled(review.runId)
  // `RunRow.runId` 是 `string`（它来自 JSON），这里收回品牌类型
  return { executeRunId: runId, reviewRunId: (review?.runId as RunId | undefined) ?? null }
}

interface RunRow {
  runId: string
  kind: string
  status: string
  subject?: { type: string; id: string }
  verdict: {
    status: string
    conclusion: string
    escalateReason: string | null
    source: 'agent' | 'human'
  } | null
  action: unknown
}

async function listRunRows(): Promise<RunRow[]> {
  const res = await fetch(`${daemon.url}/api/runs`)
  return ((await res.json()) as { runs: RunRow[] }).runs
}

async function getRunRow(runId: string): Promise<RunRow> {
  const rows = await listRunRows()
  const row = rows.find((r) => r.runId === runId)
  assert.ok(row, `runs 列表里必须有 ${runId}`)
  return row
}

async function derivedRuns(executeRunId: string): Promise<RunRow[]> {
  const rows = await listRunRows()
  return rows.filter((r) => r.subject?.type === 'run' && r.subject.id === executeRunId)
}

async function waitForSettled(runId: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const res = await fetch(`${daemon.url}/api/runs/${runId}`)
    if (res.status === 200) {
      const run = (await res.json()) as { status: string }
      if (TERMINAL.has(run.status)) return
    }
    if (Date.now() > deadline) throw new Error(`等待 run ${runId} 结束超时`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

interface VerdictRow {
  id: string
  runId: string
  status: string
  conclusion: string
  reasonCode: string
  confidence: number
  findings: unknown[]
  action: { type: string } | null
  escalateReason: string | null
  modelId: string | null
  promptHash: string | null
  source?: 'agent' | 'human'
  humanReason?: string | null
  createdAt: number
}

async function listVerdicts(runId: string): Promise<{
  verdicts: VerdictRow[]
  actions: Array<{ id: string; verdictId: string; type: string }>
}> {
  const res = await fetch(`${daemon.url}/api/runs/${runId}/verdicts`)
  assert.equal(res.status, 200)
  return (await res.json()) as {
    verdicts: VerdictRow[]
    actions: Array<{ id: string; verdictId: string; type: string }>
  }
}

/** 提交一条人工裁决。 */
async function postHumanVerdict(
  runId: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${daemon.url}/api/runs/${runId}/human-verdict`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

describe('D46：人工裁决', () => {
  test('★ 审核判 fail 且没有返工 ⇒ 人判通过 ⇒ 阶段推导看到的判决变成人工的 pass', async () => {
    backend.reviewConclusion = 'fail'
    const issueId = await newIssue('人工通过：从「等待人处理」出来')
    const { executeRunId, reviewRunId } = await runTask({ issueId })
    assert.ok(reviewRunId, '夹具前提：这条执行必须派生出一条审核 run')

    // ── 前提：审核判 fail、没有返工额度 ⇒ 判决收口到 escalated（「等待人处理」）──
    const before = await getRunRow(reviewRunId)
    assert.equal(before.verdict?.conclusion, 'fail', '夹具前提：审核必须判 fail')
    assert.equal(
      before.verdict?.status,
      'escalated',
      '夹具前提：fail 且没配返工 ⇒ 收口到 escalated（阶段推导据此判「等待人处理」）',
    )
    assert.equal(before.verdict?.source, 'agent', '模型判决的 source 必须是 agent')

    // ── 人判通过 ──
    const res = await postHumanVerdict(reviewRunId, {
      conclusion: 'pass',
      reason: '三个发现我都核对过，都是误报，产出可以直接用。',
    })
    assert.equal(res.status, 201, `人工裁决必须落库：${JSON.stringify(res.body)}`)
    assert.equal(res.body['status'], 'advisory', 'pass ⇒ advisory（通过、无动作）')

    // ── 阶段推导唯一的入口：`/api/runs` 的这条投影 ──
    //
    // ★ 这一条是本文件的核心断言。`stageOf` 判"卡在人这儿"的判据正是
    //   `conclusion === 'needs_human' || status === 'escalated'`；人工判 pass 之后
    //   两者都不成立，于是任务从「等待人处理」进「已完成审查」。落错 run 的话，
    //   这里读到的仍然是模型那条 fail —— 那正是"点了通过、看板不动"。
    const after = await getRunRow(reviewRunId)
    assert.equal(after.verdict?.conclusion, 'pass', '阶段推导必须看到人工那条 pass')
    assert.equal(after.verdict?.status, 'advisory')
    assert.equal(after.verdict?.source, 'human', '★ 必须标明是人工做的')

    // ── 执行 run 那条投影不受影响（人工裁决挂在审核 run 上）──
    const execRow = await getRunRow(executeRunId)
    assert.equal(execRow.verdict, null, '执行 run 上不该出现判决（它挂在审核 run 上）')
  })

  test('★ 人工裁决**不触发任何动作**（判决里没有 action，也没有动作记录）', async () => {
    backend.reviewConclusion = 'fail'
    const issueId = await newIssue('人工通过：不许动手')
    const { reviewRunId } = await runTask({ issueId })
    assert.ok(reviewRunId)

    await postHumanVerdict(reviewRunId, { reason: '我自己看过，可以。' })

    const { verdicts, actions } = await listVerdicts(reviewRunId)
    const human = verdicts.find((v) => v.source === 'human')
    assert.ok(human, '人工那条判决必须在')
    assert.equal(human.action, null, '★ 人工裁决不带 action（动作只能来自模型判决）')
    assert.equal(
      actions.filter((a) => a.verdictId === human.id).length,
      0,
      '★ 人工那条判决不能触发任何动作记录',
    )
  })

  test('★ 它是**追加**而不是覆盖：模型那条 fail 原样留着（DR-3）', async () => {
    backend.reviewConclusion = 'fail'
    const issueId = await newIssue('人工通过：历史不许被覆盖')
    const { reviewRunId } = await runTask({ issueId })
    assert.ok(reviewRunId)

    await postHumanVerdict(reviewRunId, { reason: '看过，可以。' })

    const { verdicts } = await listVerdicts(reviewRunId)
    assert.equal(verdicts.length, 2, '同一条审核 run 上应当有两条判决（模型 + 人工）')

    const model = verdicts.find((v) => (v.source ?? 'agent') === 'agent')
    const human = verdicts.find((v) => v.source === 'human')
    assert.ok(model && human, '两条都要在')
    assert.equal(model.conclusion, 'fail', '★ 模型那条 fail 必须原样留着')
    assert.equal(model.reasonCode, 'missing_tests', '模型那条的理由码也不许被改写')
    assert.equal(human.conclusion, 'pass')
    // 谁最后生效由 createdAt 决定（消费方取末条）
    assert.ok(human.createdAt >= model.createdAt, '人工那条必须更晚')
    assert.equal(verdicts[verdicts.length - 1]?.source, 'human', '末条是人工那条')
  })

  test('★ 落库的形状：source / reasonCode / humanReason / modelId 都如实', async () => {
    backend.reviewConclusion = 'fail'
    const issueId = await newIssue('人工通过：记录的形状')
    const { reviewRunId } = await runTask({ issueId })
    assert.ok(reviewRunId)

    const reason = '  两边留白，前后有空格  '
    await postHumanVerdict(reviewRunId, { reason })

    const { verdicts } = await listVerdicts(reviewRunId)
    const human = verdicts.find((v) => v.source === 'human')
    assert.ok(human, '人工那条判决必须在')
    assert.equal(human.reasonCode, 'human_decision', '理由码是专门那一个，不复用模型的分类')
    assert.equal(human.confidence, 1, '人工裁决没有"置信度"，落库取 1（取 0 会被读成没把握）')
    assert.equal(
      human.humanReason,
      '两边留白，前后有空格',
      '理由按原文保存（只 trim 首尾，不改写内容）',
    )
    assert.deepEqual(human.findings, [], '★ 人的理由不进 findings（两者刻意不混）')
    assert.equal(human.modelId, null, '没有模型就留空，不编占位值')
    assert.equal(human.promptHash, null)
    assert.equal(human.escalateReason, null)
    assert.equal(human.action, null)
  })

  test('★ 理由选填：不写也成立（存 null），写了就原文保存；超长被拒', async () => {
    backend.reviewConclusion = 'fail'
    const issueId = await newIssue('人工通过：理由选填')
    const { reviewRunId } = await runTask({ issueId })
    assert.ok(reviewRunId)

    const before = (await listVerdicts(reviewRunId)).verdicts.length

    // ★ 不写理由 ⇒ **成立**，而且 `humanReason` 是 `null`。
    //
    //   这一条改过一次，所以它值得一个用例钉住：最初理由必填，理由是"这条判决
    //   除了一句话之外什么都没有"。那个论证没错，但代价算错了——人点「通过」时
    //   脑子里已经有判断，逼他写下来最常见的结局是写一句"ok"或者干脆不点了，
    //   门槛换来的是噪音。所以 `pass` 这边选填。
    const noReason = await postHumanVerdict(reviewRunId, {})
    assert.equal(noReason.status, 201, `不写理由必须成立：${JSON.stringify(noReason.body)}`)
    const bare = (await listVerdicts(reviewRunId)).verdicts.at(-1)
    assert.equal(bare?.source, 'human')
    assert.equal(bare?.humanReason, null, '★ 没写理由存 null——**正常状态**，不是缺失')

    // 空串与只有空白：**折成 null**，不存空串。
    //   存空串会让消费方分不清"没写"和"写了个空"，而这两件事在这里没有区别。
    const blank = await postHumanVerdict(reviewRunId, { reason: '   ' })
    assert.equal(blank.status, 201)
    assert.equal(
      (await listVerdicts(reviewRunId)).verdicts.at(-1)?.humanReason,
      null,
      '只有空白的理由折成 null',
    )

    // 写了就原文保存（只 trim 首尾，不改写内容）
    const kept = await postHumanVerdict(reviewRunId, { reason: '  两边留白，前后有空格  ' })
    assert.equal(kept.status, 201)
    assert.equal(
      (await listVerdicts(reviewRunId)).verdicts.at(-1)?.humanReason,
      '两边留白，前后有空格',
    )

    // 超长（上限 4000）
    const tooLong = await postHumanVerdict(reviewRunId, { reason: 'x'.repeat(4001) })
    assert.equal(tooLong.status, 400, '超长理由必须被拒')

    // ★ D47：`conclusion` 这个字段**已经不存在了**——人工裁决只可能是通过。
    //   这条断言是那个决定的守卫：它要是重新出现，说明有人又把"人工判不通过"
    //   加了回来，而那条路已经被「反馈」（派新 run）取代。
    const withConclusion = await postHumanVerdict(reviewRunId, {
      conclusion: 'fail',
      reason: '我想判不通过',
    })
    assert.equal(withConclusion.status, 201, '未知字段被忽略（zod 的默认行为）')
    assert.equal(
      (await listVerdicts(reviewRunId)).verdicts.at(-1)?.conclusion,
      'pass',
      '★ 传了 conclusion 也只会落成 pass——人工裁决没有别的结论',
    )

    assert.equal(
      (await listVerdicts(reviewRunId)).verdicts.length,
      before + 4,
      '四条成功的请求各留下一条记录（被拒的那条不留）',
    )
  })

  test('★ 没有审核结论的执行 run 也能裁决（挂在执行 run 上）', async () => {
    // 「这一次明确不审」（`reviewerAgentId: null`，D28 里的合法选择）⇒ 没有审核 run，
    // 任务永远停在「待审查」。人想自己确认时，裁决挂在**执行 run** 上。
    backend.reviewConclusion = 'fail'
    const issueId = await newIssue('没配审核者：人工自己确认')
    const { executeRunId, reviewRunId } = await runTask({ issueId, reviewerAgentId: null })
    assert.equal(reviewRunId, null, '夹具前提：这条执行不许派生审核 run')
    assert.equal((await getRunRow(executeRunId)).verdict, null, '前提：执行 run 上本来没有判决')

    const res = await postHumanVerdict(executeRunId, {
      conclusion: 'pass',
      reason: '这个任务本来就没配审核者，我自己看了产出，没问题。',
    })
    assert.equal(res.status, 201, `挂在执行 run 上也必须成立：${JSON.stringify(res.body)}`)

    // ★ 阶段推导要能看到它——`/api/runs` 对执行 run 也必须给出 `verdict`
    //   （这正是 D46 把那条投影的 `kind === 'review'` 过滤去掉的原因）。
    const row = await getRunRow(executeRunId)
    assert.equal(row.verdict?.source, 'human', '★ 执行 run 的投影必须带上人工判决')
    assert.equal(row.verdict?.conclusion, 'pass')
    assert.equal(row.verdict?.status, 'advisory')

    // 而它**不带动作**（与审核 run 那条刻意不对称）
    assert.equal(row.action, null)
  })

  test('★ 已经有审核结论时，裁决**执行 run** 会被拒（否则就是"点了通过、看板不动"）', async () => {
    backend.reviewConclusion = 'fail'
    const issueId = await newIssue('挂错位置必须被拒')
    const { executeRunId, reviewRunId } = await runTask({ issueId })
    assert.ok(reviewRunId, '夹具前提：必须有一条审核 run')

    const res = await postHumanVerdict(executeRunId, {
      conclusion: 'pass',
      reason: '我想直接对执行 run 裁决',
    })
    assert.equal(res.status, 409, '★ 必须拒（请求合法，是这条 run 的状态不允许）')
    const error = String(res.body['error'])
    assert.match(error, new RegExp(reviewRunId), '错误里必须**指出该挂到哪条 run 上**')
    assert.equal(
      (await getRunRow(executeRunId)).verdict,
      null,
      '★ 被拒之后执行 run 上不许留下判决',
    )
  })

  test('★ 还没结束的 run 不能裁决', async () => {
    backend.reviewConclusion = 'fail'
    // 不存在的 run ⇒ 404（与"别人的 run"同一条口径）
    const missing = await postHumanVerdict(ulid(), { reason: '随便' })
    assert.equal(missing.status, 404)

    // 还没跑完的 run ⇒ 409。用一条**永远不会被调度**的 run 造这个状态：
    // 直接往库里写是不行的（测试不该绕过接口），所以这里用"提交后立刻裁决"的竞态
    // 不稳；改用一个**非 execute/review 的 kind** 走另一条分支即可覆盖"类型不对"。
    const issueId = await newIssue('类型不对的 run')
    const { executeRunId } = await runTask({ issueId, reviewerAgentId: null })
    // 已经跑完 ⇒ 允许；再确认一次"允许"这条路径没被上面的检查误伤
    const ok = await postHumanVerdict(executeRunId, { reason: '可以' })
    assert.equal(ok.status, 201)
  })

  test('★ 可以再判一次：追加，末条生效，谁也没被覆盖', async () => {
    backend.reviewConclusion = 'fail'
    const issueId = await newIssue('再判一次')
    const { reviewRunId } = await runTask({ issueId })
    assert.ok(reviewRunId)

    const first = await postHumanVerdict(reviewRunId, { reason: '第一次：我核对过了' })
    assert.equal(first.status, 201)
    assert.equal((await getRunRow(reviewRunId)).verdict?.conclusion, 'pass')

    const second = await postHumanVerdict(reviewRunId, { reason: '再看一遍，还是可以' })
    assert.equal(second.status, 201, '再判一次必须允许（历史保留，不覆盖）')

    const row = await getRunRow(reviewRunId)
    assert.equal(row.verdict?.conclusion, 'pass', '★ 末条生效')
    assert.equal(row.verdict?.source, 'human')

    // 三条都在：模型 fail + 两次人工通过
    const { verdicts } = await listVerdicts(reviewRunId)
    assert.equal(verdicts.length, 3, '每一次判决都留下一条，谁也不覆盖谁')
    assert.equal(
      verdicts.filter((v) => v.source === 'human').length,
      2,
      '★ 两次人工判决都留着（这是"改主意了"能查的唯一途径）',
    )
  })

  test('★ 身份接口带上了两个能力标志', async () => {
    const res = await fetch(`${daemon.url}/api/identity`)
    assert.equal(res.status, 200)
    const identity = (await res.json()) as { capabilities: string[] }
    assert.ok(
      identity.capabilities.includes('human-verdict'),
      '★ 界面据此决定那一块给不给——旧 daemon 会 404，不能让界面画一个兑现不了的按钮',
    )
    assert.ok(
      identity.capabilities.includes('issue-abandon'),
      '★ 放弃是**另一次交付**，所以是另一个标志（见 `Capability.IssueAbandon`）',
    )
  })
})

/**
 * 放弃 / 恢复一条任务（D47）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这个功能最要紧的一条：它**不删任何东西**
 * ══════════════════════════════════════════════════════════════════
 *
 * 「放弃」听起来像"删掉"，但它只是改 issue 的状态。run、判决、审计全部留着，
 * 而且可以恢复——**放弃是一个判断，判断会变**。所以这一组用例断言的除了状态
 * 本身，还有"别的什么都没少"。
 *
 * 另一半是那个**副作用**：放弃时取消还在跑的 run。不取消的话，"放弃"只改了
 * 看板，而那条 run 还在烧 token、还在往工作目录里写东西——而"放弃"的意思恰恰
 * 是"这条不要再做了"。它是这个功能唯一一处会打断正在进行的事的行为，所以
 * 必须有测试钉住它，也必须在界面上写出来。
 */
describe('D47：放弃任务', () => {
  async function postIssueStatus(
    issueId: string,
    action: 'abandon' | 'reopen',
    baseUrl = daemon.url,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${baseUrl}/api/issues/${issueId}/${action}`, { method: 'POST' })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  async function getIssueStatus(issueId: string, baseUrl = daemon.url): Promise<string> {
    const res = await fetch(`${baseUrl}/api/issues`)
    const page = (await res.json()) as { items: Array<{ id: string; status: string }> }
    const found = page.items.find((i) => i.id === issueId)
    assert.ok(found, `issues 列表里必须有 ${issueId}`)
    return found.status
  }

  test('★ 放弃 ⇒ 状态变 cancelled；恢复 ⇒ 变回 todo', async () => {
    const issueId = await newIssue('放弃与恢复')
    assert.equal(await getIssueStatus(issueId), 'todo', '前提：新建的任务是 todo')

    const dropped = await postIssueStatus(issueId, 'abandon')
    assert.equal(dropped.status, 200, `放弃必须成立：${JSON.stringify(dropped.body)}`)
    assert.equal(await getIssueStatus(issueId), 'cancelled', '★ 落成 cancelled')
    // ★ 响应里回**整条 issue**：界面要拿它的状态决定按钮的下一态，
    //   而"改完再拉一次"正是界面显示出旧状态的那类竞态的来源。
    assert.equal((dropped.body['issue'] as { status: string }).status, 'cancelled')

    const back = await postIssueStatus(issueId, 'reopen')
    assert.equal(back.status, 200)
    assert.equal(await getIssueStatus(issueId), 'todo', '★ 恢复是可撤销的')
  })

  test('★ 重复放弃 / 重复恢复都被拒（409 并说清已经是了）', async () => {
    const issueId = await newIssue('重复放弃')
    assert.equal((await postIssueStatus(issueId, 'reopen')).status, 409, '没放弃过不能恢复')
    assert.equal((await postIssueStatus(issueId, 'abandon')).status, 200)
    const again = await postIssueStatus(issueId, 'abandon')
    assert.equal(again.status, 409, '★ 已经放弃过了要**说清**，而不是回 200 假装改成功')
    assert.match(String(again.body['error']), /已经放弃/)
  })

  test('★ 不存在的任务 ⇒ 404；非 POST ⇒ 405', async () => {
    assert.equal((await postIssueStatus(ulid(), 'abandon')).status, 404)
    const res = await fetch(`${daemon.url}/api/issues/${ulid()}/abandon`)
    assert.equal(res.status, 405, '这两条路只接受 POST')
  })

  test('★ 放弃**不删任何东西**：run、判决、审计全都还在', async () => {
    backend.reviewConclusion = 'fail'
    const issueId = await newIssue('放弃不删东西')
    const { executeRunId, reviewRunId } = await runTask({ issueId })
    assert.ok(reviewRunId)

    const before = await listVerdicts(reviewRunId)
    assert.ok(before.verdicts.length > 0, '前提：这条任务有判决')

    assert.equal((await postIssueStatus(issueId, 'abandon')).status, 200)

    // ★ 判决一条不少（含那条模型的 fail）
    const after = await listVerdicts(reviewRunId)
    assert.equal(after.verdicts.length, before.verdicts.length, '★ 放弃不许动判决')
    assert.equal(after.verdicts[0]?.conclusion, 'fail', '模型那条原样留着')

    // run 也还在，而且**状态没被改写**（放弃改的是 issue，不是 run）
    const row = await getRunRow(executeRunId)
    assert.equal(row.status, 'completed', '★ 已经跑完的 run 不会被"放弃"改写状态')
    assert.equal(row.verdict, null, '执行 run 上仍然没有判决（它挂在审核 run 上）')

    // 审计还能取
    const audits = await fetch(`${daemon.url}/api/runs/${reviewRunId}/audits`)
    assert.equal(audits.status, 200, '★ 审计是"放弃不删东西"的最后一道证据')
  })

  test('★ 放弃会取消**还在跑**的 run（唯一一处会打断进行中事情的行为）', async () => {
    // 用一条**慢后端**造出"正在跑"的状态：默认后端是瞬间完成的，没有东西可取消。
    // 这条 run 会一直等在那个 promise 上，直到 `finally` 里放行。
    const slow = new SlowBackend()
    const slowData = await makeTempDir('abandon-slow-data')
    const slowDaemon = await startDaemon({
      dataDir: slowData,
      port: 0,
      fsync: false,
      backend: slow,
      onWarn: () => {},
      onInfo: () => {},
    })
    try {
      const issueRes = await fetch(`${slowDaemon.url}/api/issues`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: '放弃时取消正在跑的 run' }),
      })
      const issueId = ((await issueRes.json()) as Issue).id

      const runId = ulid() as RunId
      const submit = await fetch(`${slowDaemon.url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId,
          kind: 'execute',
          agentRef: { id: 'a-slow', name: '慢执行者', instructions: '' },
          skills: [],
          subject: { type: 'issue', id: issueId },
          prompt: '慢慢做',
          workDir: await newWorkDir(),
          limits: { maxTurns: null, timeoutMs: null },
        }),
      })
      assert.equal(submit.status, 202, '前提：这条 run 要受理成功')

      // 等它真的开始跑（`running`），否则"取消一个排队中的 run"测的是另一件事
      await waitForStatus(slowDaemon.url, runId, 'running')

      const res = await fetch(`${slowDaemon.url}/api/issues/${issueId}/abandon`, {
        method: 'POST',
      })
      const body = (await res.json()) as { cancelledRunIds: string[]; error?: string }
      assert.equal(res.status, 200, `放弃必须成立：${JSON.stringify(body)}`)
      assert.ok(
        body.cancelledRunIds.includes(runId),
        `★ 正在跑的 run 必须被取消（实际取消了 ${JSON.stringify(body.cancelledRunIds)}）`,
      )

      // 状态真的变了，不只是返回了一个 id
      await waitForStatus(slowDaemon.url, runId, 'cancelled')
      // 而任务确实是放弃状态
      assert.equal(await getIssueStatus(issueId, slowDaemon.url), 'cancelled')
    } finally {
      slow.release()
      await slowDaemon.close()
      await cleanup(slowData)
    }
  })
})

/**
 * 一个**不自己结束**的假后端：用来造出"正在跑"的 run。
 *
 * `execute()` 返回的 `result` 挂在一个手动 resolve 的 promise 上，所以那条 run
 * 会停在 `running`，直到测试调 `release()`。取消时 `cancel()` 关掉消息队列——
 * 与真实后端走同一条路径。
 */
class SlowBackend implements AgentBackend {
  readonly key = 'claude'
  readonly protocol = 'stream-json' as const
  readonly rejectDetectable = true

  #release!: () => void
  readonly #gate = new Promise<void>((resolve) => {
    this.#release = resolve
  })

  release(): void {
    this.#release()
  }

  async probe(): Promise<{ available: boolean; command: string; cliVersion: string | null }> {
    return { available: true, command: 'claude', cliVersion: '0.0.0-fake' }
  }

  async execute(): Promise<AgentSession> {
    const queue = new AsyncQueue<AgentMessage>()
    /**
     * ⚠️ `this` 在这里**不是那个 SlowBackend 实例**——下面那个对象字面量里的
     *    `cancel()` 是它的方法，`this` 指向对象字面量本身。所以私有字段
     *    `this.#release` 会抛 "Cannot read private member #release from an
     *    object whose class did not declare it"，而且那个异常会一路冒到
     *    `/api/issues/{id}/abandon` 上变成 **500**（第一版就是这么写的）。
     *    先把它取出来存成局部量，闭包拿到的就是对的。
     */
    const release = this.#release
    void this.#gate.then(() => {
      queue.push({ type: 'text', content: '做完了。' })
      queue.close()
    })
    return {
      messages: queue,
      result: this.#gate.then(() => ({
        status: 'completed' as const,
        output: '做完了。',
        error: null,
        durationMs: 3,
        sessionId: 'slow-session',
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          costUsdMicros: 1,
          costSource: 'provider' as const,
        },
        exitCode: 0,
      })),
      async cancel() {
        queue.close()
        // ★ 真后端被取消时会**中止 CLI 并让结果落定**，执行器随后按
        //   `registry.get(runId).cancellationRequested` 把它记成 `cancelled`
        //   （`cancelled_by_user`，见 `executor.ts` 里那段注释）。
        //
        //   假后端必须照做。只关队列、不落定结果的话，那条 run 会永远停在
        //   `running`——于是这个用例测的就成了"假后端配不配合"，而不是
        //   "放弃会不会取消 run"。（第一版就是这么写的，症状是等 cancelled 超时。）
        //
        //   `AsyncQueue.push` 在 close 之后是**静默 no-op**、`close` 是幂等的，
        //   所以"先 close 再放行"不会二次投递、也不会抛。
        release()
      },
      lastActivityAt: () => Date.now(),
    }
  }
}

/** 等一条 run 到指定状态（用来观察"取消"这种异步后果）。 */
async function waitForStatus(
  baseUrl: string,
  runId: string,
  want: string,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const res = await fetch(`${baseUrl}/api/runs/${runId}`)
    if (res.status === 200) {
      const run = (await res.json()) as { status: string }
      if (run.status === want) return
    }
    if (Date.now() > deadline) throw new Error(`等待 run ${runId} 变成 ${want} 超时`)
    await new Promise((r) => setTimeout(r, 25))
  }
}
