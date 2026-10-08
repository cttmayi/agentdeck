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
import { createChainGroup } from './testing/chain.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * 「新建任务」页这一次任务的**审核者覆盖**（`SubmitRunRequest.reviewerAgentId`）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这个字段为什么值得一整个文件
 * ══════════════════════════════════════════════════════════════════
 *
 * 它是**三态**，而且三态都表达真实意图（见 `local-api.ts` 与 `Run.reviewerAgentId`
 * 的注释）：
 *
 *   - **省略** ⇒ 跟随执行 agent 的长期安排（D28），
 *   - **null** ⇒ 这一次明确不自动审，
 *   - **agent id** ⇒ 这一次换人审，不改那个 agent 的长期配置。
 *
 * 三态里有两态（省略、null）在**跑完之前完全看不出来**：两者的 run 都会
 * 正常结束、状态都是 completed、界面上一模一样。差别只在"有没有派生审核 run"。
 * 所以这一整类缺陷的表现是**静默地少了一次审核**——而"产出没被审"这件事，
 * 恰恰是这个产品存在的理由。这类错必须用测试钉住，而且必须钉在**真实链路**上
 * （真的起 daemon、真的走 HTTP、真的派生）：`undefined` 被折成 `null` 这种错的
 * 位置在 `executor.submit()` 里，纯函数单测看不见它。
 *
 * 用什么跑的：照抄 `e2e.test.ts` 的 fixture（假后端 + `makeTempDir` + 真 HTTP）。
 * **NFR-T-01：绝不调用使用者真实安装的 agent CLI。**
 */

/**
 * 两阶段的假后端：按第一句话分辨"这次是执行还是审核"。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么审核那一路必须产出**合法**判决
 * ══════════════════════════════════════════════════════════════════
 *
 * 如果审核跑出"没有判决块"的输出，平台会把它记为 `invalid` 并且**可能派生一条
 * 重试 run**——而重试 run 的 subject 同样是 `{type:'run', id: 被审的 runId}`。
 * 于是"这条执行 run 派生了**几条** review run"就不再确定了：本文件好几条用例
 * 要断言的正是"一条"或"零条"。
 *
 * 让审核正常收口（`pass`、无动作、不重试），这个数字才是确定的。
 */
class OverrideBackend implements AgentBackend {
  readonly key = 'claude'
  readonly protocol = 'stream-json' as const
  readonly rejectDetectable = true

  /** 每次调用是执行还是审核——用来区分"派生了 run"与"run 真的跑了"。 */
  readonly phases: string[] = []

  /**
   * ★ 闸门：挂上之后 `execute` 会**等它 resolve** 才结束。
   *
   * 为什么需要它：有一条用例要测"**跑着的时候**配置被改了"——那是这批用例里唯一
   * 不能靠"先改后提交"构造的局面（先改后提交会在**提交那一刻**就被组形态校验拦下，
   * 那是另一条规矩、另一个 400）。而"跑着的时候改"如果靠 `setTimeout` 去凑时序，
   * 断言就成了碰运气：假后端跑完只要几毫秒，改角色的那次 PATCH 随时可能落在
   * 串接**之后**——于是用例时红时绿，而红的时候看起来像"通知没发"。
   *
   * 挂上闸门之后，时序是**确定的**：run 停在跑的过程中，改完配置再放行。
   */
  hold: Promise<void> | null = null

  async probe(): Promise<{ available: boolean; command: string; cliVersion: string | null }> {
    return { available: true, command: 'claude', cliVersion: '0.0.0-fake' }
  }

  async execute(opts: ExecOptions): Promise<AgentSession> {
    // D29 之后判定"这是审核还是执行"只能看第一句话（不再写 CLAUDE.md）：
    // 它的开头是 `# 任务` 或 `# 审核任务`。
    const isReview = deliveredText(opts).includes('# 审核任务')
    this.phases.push(isReview ? 'review' : 'execute')

    // ★ 闸门（只有那条"跑着的时候改配置"的用例会挂它；其余时候是 null）
    if (this.hold !== null) await this.hold

    const text = isReview
      ? [
          '审核结论：',
          VERDICT_FENCE_BEGIN,
          JSON.stringify({
            schemaVersion: 1,
            conclusion: 'pass',
            reasonCode: 'meets_criteria',
            confidence: 0.9,
            findings: [],
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
        usage: { inputTokens: 10, outputTokens: 5, costUsdMicros: 100, costSource: 'provider' as const },
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
let backend: OverrideBackend
let issueId: string
/** 长期配置里"由谁审我"指向的那个审核者（R1）。 */
let r1: string
/** 只在**这一次任务**上被指定的另一个审核者（R2）。 */
let r2: string
/** 由组里的 R1 审的执行者——本文件绝大多数用例都用它提交。 */
let executor: { id: string; name: string }
/**
 * 把"执行者 E + R1"串起来的那个组（2026-10 起"长期由谁审"只有组能表达）。
 *
 * ★ **它才是"省略 ⇒ 跟随"这一态的载体**：以前跟随的是执行者身上那条长期配置，
 *   现在跟随的是组——而组是在 `POST /api/runs` 里被**展开**成 run 上那几个字段的。
 */
let groupId: string
/** 另一个执行者：用来验证"选错了人（角色不是 reviewer）"。 */
let otherExecutor: { id: string; name: string }
/** 本文件自建的临时工作目录，`after` 里统一清掉。 */
const workDirs: string[] = []

before(async () => {
  dataDir = await makeTempDir('reviewer-override-data')
  backend = new OverrideBackend()
  daemon = await startDaemon({
    dataDir,
    port: 0, // 让内核分配端口，避免测试之间抢端口
    fsync: false,
    backend,
    onWarn: () => {},
    onInfo: () => {},
  })

  const res = await fetch(`${daemon.url}/api/issues`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '把这次任务做完', description: '随便看看' }),
  })
  issueId = ((await res.json()) as Issue).id

  // ★ 审核者必须**自带审核标准**（`reviewStandard`），否则 `createRunForReviewer`
  //   会直接返回 null：没有标准的审核不算审核（D37），于是"派生了一条 review run"
  //   这件事根本不会发生。首启播种的审核者有内置标准，但**我们自己新建的没有**——
  //   忘了给标准的话，用例 1 与 3 会以"没有审核 run"失败，而原因与三态毫无关系。
  r1 = await createAgent({
    name: '审核者 R1（长期配置）',
    role: 'reviewer',
    reviewStandard: { body: '# R1 标准\n\n只看结论有没有依据。' },
  })
  r2 = await createAgent({
    name: '审核者 R2（本次覆盖）',
    role: 'reviewer',
    reviewStandard: { body: '# R2 标准\n\n只看产出在不在。' },
  })

  const executorId = await createAgent({
    name: '执行者 E（由组里的 R1 审）',
    role: 'executor',
  })
  executor = { id: executorId, name: '执行者 E（由组里的 R1 审）' }
  // ⚠️ 2026-10：这里原来是 `createAgent({ reviewerAgentId: r1 })`——那个字段已经
  //    从 `Agent` 上撤掉（写它就是 400「不认识的字段」）。"长期由 R1 审"这件事现在
  //    由**组**表达：成员是这一对，提交 run 时带 `groupId` 就会派 R1 去审。
  groupId = await createChainGroup(
    { url: daemon.url },
    { name: '长期组（R1 审）', members: [executorId, r1] },
  )
  otherExecutor = {
    id: await createAgent({ name: '另一个执行者 E2', role: 'executor' }),
    name: '另一个执行者 E2',
  }

  // 建完自检一次：长期配置真的写下去了。
  //   少了它，用例 1 失败时会分不清"三态折了"还是"这个夹具压根没配上"。
  const groups = ((await (await fetch(`${daemon.url}/api/agent-groups`)).json()) as {
    groups: Array<{ id: string; members: string[] }>
  }).groups
  assert.deepEqual(
    groups.find((g) => g.id === groupId)?.members.slice().sort(),
    [executor.id, r1].sort(),
    '夹具前提：那个组的成员必须是"执行者 E + R1"（谁审谁只有组能回答）',
  )
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

/** 每个用例自己的工作目录——**不要共用**：同一目录同时只允许一条 run。 */
async function newWorkDir(): Promise<string> {
  const dir = await makeTempDir('reviewer-override-work')
  workDirs.push(dir)
  return dir
}

/**
 * 提交一条 execute run。
 *
 * `reviewerAgentId` **键是否出现**在这里是有意义的：省略 ⇒ 请求体里没有这个键，
 * 传 `null` ⇒ 键在、值为 null。这一层必须忠实，否则测的就不是三态了。
 */
async function submitRun(input: {
  runId: RunId
  agent?: { id: string; name: string }
  workDir: string
  prompt?: string
  /**
   * 三态：不传这个键 = 省略，传 null = 这次不审，传 id = 这次指定谁审。
   *
   * ⚠️ 2026-10：**省略仍然是一个独立的状态**（库里缺这个键），但它的**含义**变了
   * ——以前是"跟随执行者的长期配置"，现在没有可跟随的东西了，所以省略 = 没有任何
   * 审核者……**除非同一次带了 `groupId`**（那才是有审核者的两条路之一）。
   */
  reviewerAgentId?: string | null
  /** 智能体组（2026-10 起"谁审我"的主路：组把它的审核者展开进这条 run）。 */
  groupId?: string
  kind?: string
  subject?: { type: string; id: string }
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const agent = input.agent ?? executor
  const payload: Record<string, unknown> = {
    runId: input.runId,
    kind: input.kind ?? 'execute',
    agentRef: { id: agent.id, name: agent.name, instructions: '' },
    skills: [],
    subject: input.subject ?? { type: 'issue', id: issueId },
    prompt: input.prompt ?? '把这次任务做完',
    workDir: input.workDir,
    limits: { maxTurns: null, timeoutMs: null },
  }
  if ('reviewerAgentId' in input) payload['reviewerAgentId'] = input.reviewerAgentId
  if ('groupId' in input) payload['groupId'] = input.groupId

  const res = await fetch(`${daemon.url}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

/**
 * 造一条"被审的"执行 run，返回它的 id。
 *
 * ★ 它自己带 `reviewerAgentId: null`：这样它**不会**派生审核 run（`null` 与缺字段
 *   在这一层同义），测试里就没有
 *   后台跑着的噪声 run（那些 run 会往 runs 列表里添东西、也要占用工作目录）。
 *   这几条用例只关心审核 run 那边被拒，不需要这边热闹。
 */
async function submitTargetExecuteRun(): Promise<RunId> {
  const runId = ulid() as RunId
  const res = await submitRun({ runId, workDir: await newWorkDir(), reviewerAgentId: null })
  assert.equal(res.status, 202, '夹具前提：被审的那条执行 run 必须先受理成功')
  return runId
}

/**
 * 读一条 run 的**记录本身**（不是列表投影）。
 *
 * `GET /api/runs/<id>` 返回的就是落库的那个 `Run` 对象（`sendJson(res, 200, run)`），
 * 所以"键在不在"是能看见的——这正是用例 7（三态保真）要的观测点。
 */
async function getRunRecord(runId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${daemon.url}/api/runs/${runId}`)
  assert.equal(res.status, 200, `run ${runId} 应当存在`)
  return (await res.json()) as Record<string, unknown>
}

/** `GET /api/runs` 的列表投影。 */
async function listRunRows(): Promise<
  Array<{
    runId: string
    kind: string
    status: string
    agentId: string
    subject?: { type: string; id: string }
    reviewer?: { mode: 'none' | 'assigned'; agentId?: string } | null
  }>
> {
  const res = await fetch(`${daemon.url}/api/runs`)
  return ((await res.json()) as { runs: Array<never> }).runs
}

/**
 * 由**这条执行 run** 派生出来的 run（审核 run 的 subject 是 `{type:'run', id}`）。
 *
 * ⚠️ 不能按 `kind === 'review'` 全局找：同一个 daemon 里躺着别的用例的审核 run，
 *    那样断言会匹配到**别人的**审核（`review-e2e.test.ts` 里踩过一次）。
 */
async function derivedRuns(
  executeRunId: string,
): Promise<Array<{ runId: string; kind: string; status: string; agentId: string }>> {
  const runs = await listRunRows()
  return runs.filter((r) => r.subject?.type === 'run' && r.subject.id === executeRunId)
}

/** 等这条执行 run 派生出一条 review run，并等它跑完。 */
async function waitForDerivedReview(
  executeRunId: string,
  timeoutMs = 8000,
): Promise<{ runId: string; agentId: string }> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = (await derivedRuns(executeRunId)).find((r) => r.kind === 'review')
    if (found) {
      await waitForSettled(found.runId, timeoutMs)
      return { runId: found.runId, agentId: found.agentId }
    }
    if (Date.now() > deadline) {
      throw new Error(
        `等待 run ${executeRunId} 派生审核超时（当前派生 ${(await derivedRuns(executeRunId)).length} 条）`,
      )
    }
    await new Promise((r) => setTimeout(r, 25))
  }
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

async function waitForSettled(runId: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const run = await getRunRecord(runId)
    if (TERMINAL.has(String(run['status']))) return
    if (Date.now() > deadline) throw new Error(`等待 run ${runId} 结束超时`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

/**
 * 等到日志里出现匹配的那一句，返回当时**全部**消息的拼接。
 *
 * 日志是**边跑边写**的：串接审核的结论排在整段执行之后。只等"有消息"会在
 * 那句话写下来之前就断言，报出来的是"日志里没有 XX"的假失败（e2e.test.ts 里
 * 就是这个理由记着一句警告）。
 */
/**
 * 轮询等到一个非 null 的值（与 `waitForText` 同一套路，只是判据由调用方给）。
 *
 * ★ 这条用例里它等的是"假后端**开始跑**了"——闸门挂上之后那个状态是稳定的，
 *   所以这不是在赌时序，而是在等一个**确定会发生**的事件。
 */
async function waitFor<T>(fn: () => Promise<T | null>, what: string, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const got = await fn()
    if (got !== null) return got
    if (Date.now() > deadline) throw new Error(`等不到：${what}（${timeoutMs}ms）`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

async function waitForText(runId: string, pattern: RegExp, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const out = (await (
      await fetch(`${daemon.url}/api/runs/${runId}/messages`)
    ).json()) as { messages: Array<{ content: string }> }
    const text = out.messages.map((m) => m.content).join('\n')
    if (pattern.test(text)) return text
    if (Date.now() > deadline) throw new Error(`等待日志出现 ${pattern} 超时：\n${text}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('★ 新建任务时的审核者覆盖（三态）', () => {
  test('★ 身份接口必须报出 `reviewer-override` 能力标志（页面据此才给那两个选项）', async () => {
    /**
     * ══════════════════════════════════════════════════════════════════
     * 为什么这个标志是**功能的一部分**，而不是可有可无的仪式
     * ══════════════════════════════════════════════════════════════════
     *
     * 界面（`apps/web/dist`）与 daemon 是两份产物，而日常做法恰好容易造成版本
     * 错位："重建前端 → 刷新页面"**不带**重启 daemon。旧 daemon 不认识
     * `reviewerAgentId`，而请求体那层没有校验（未知字段被直接忽略）——于是
     * 页面上那个「不自动审核（这一次）」会**静默失效**：使用者以为关掉了审核，
     * 任务照旧被审，两边都不报错。
     *
     * 所以前端按能力标志决定给不给这个选项。这条测试钉住"daemon 确实报了这个
     * 标志"——少了它，页面会安静地退化成一个功能更少的样子（没有报错，
     * 也没有人知道功能丢了）。
     */
    const res = await fetch(`${daemon.url}/api/identity`)
    const body = (await res.json()) as { capabilities?: string[] }
    assert.ok(
      Array.isArray(body.capabilities),
      '身份接口必须给出能力清单（协议里：能力标志优先于版本号）',
    )
    assert.ok(
      body.capabilities.includes('reviewer-override'),
      `★ 缺了这个标志，页面就不给"这一次换人审/不审"了。实际：${JSON.stringify(body.capabilities)}`,
    )
  })

  test('★ 省略 reviewerAgentId + 带组 ⇒ 组里那个审核者（R1）去审（回归保护）', async () => {
    /**
     * ══════════════════════════════════════════════════════════════════
     * 这条是**回归保护**，不是新功能测试
     * ══════════════════════════════════════════════════════════════════
     *
     * ⚠️ 2026-10 这条的**判据变过**，说清楚免得下次有人以为是在改测试凑绿：
     *
     *   以前"省略"= 跟随**执行者身上**那条长期配置（`Agent.reviewerAgentId`），
     *   所以判据是"派 R1 去审 + 库里**缺这个键**"（缺键 = 使用者没说）。
     *
     *   现在"长期由谁审"这件事住在**组**上，而组是在 `POST /api/runs` 里被
     *   **展开**成 run 上那几个字段的 ⇒ 省略的结果是 run 上**有值**，值是组里的
     *   R1。判据因此变成"派 R1 去审 + 库里的值就是 R1"。
     *
     * ★ 仍然要防的错一个字没变：把"省略"折成"这次不审"（在 `executor.submit` 或
     *   `autoChainReview` 里写成 `req.reviewerAgentId ?? null`）。表现是**该审的
     *   没审**，而 run 状态一切正常、日志里那句"没有串接审核"还理直气壮。
     *   **没有任何地方会报错。** 折成 null 就会在这里红（不会有审核 run）。
     */
    const workDir = await newWorkDir()
    const runId = ulid() as RunId

    const res = await submitRun({ runId, workDir, groupId })
    assert.equal(res.status, 202, '受理必须返回 202')

    const review = await waitForDerivedReview(runId)
    assert.equal(
      review.agentId,
      r1,
      '★ 省略 + 带组时必须派**组里**那个审核者去审——折成 null 就会变成"这次不审"',
    )
    assert.ok(backend.phases.includes('review'), '审核要真的跑过，而不只是有一条 run 记录')

    const record = await getRunRecord(runId)
    assert.equal(
      record['reviewerAgentId'],
      r1,
      '★ 组的审核者要**展开进**这条 run（它就是这条链的载体，审计靠它回答"谁审的"）',
    )

    const row = (await listRunRows()).find((r) => r.runId === runId)
    assert.equal(row?.reviewer?.mode, 'assigned', '★ 投影要说清"这条任务有审核者"')
    assert.equal(row?.reviewer?.agentId, r1)
  })

  test('★ reviewerAgentId: null ⇒ 这一次明确不审，且不许把它说成故障', async () => {
    /**
     * ══════════════════════════════════════════════════════════════════
     * "这一次别审了"是一个**合法意图**，不是配置缺失
     * ══════════════════════════════════════════════════════════════════
     *
     * 这条任务本来可以带组（那就由组里的 R1 审），但这次显式带 null ⇒ 不派生审核 run。
     * 这条用例守三件事：
     *
     *   1. **真的没派生**（否则"这次不审"只是个说法）；
     *   2. 日志里出现那句「这次任务在新建时选择了「这次不自动审核」」——
     *      否则使用者在日志里看不到任何解释，只能以为系统坏了；
     *   3. **不许**出现"去智能体页配一个审核者"那类措辞：那是"你漏配了"的说法，
     *      而这里使用者是**主动选的**。把使用者的决定说成故障，下一步他就会去
     *      改一个本来就不该改的配置。
     *
     * ⚠️ 关于第 3 点的断言写法：**不能**简单地写 `doesNotMatch(/配置错误/)`。
     *    那句日志本身是「…这是明确的选择，不是配置错误。」——它**故意**
     *    包含"配置错误"四个字（而且是它的否定）。所以这里断言的是**具体那种
     *    说法**（"「由谁审它」是空的"、"要自动审就在智能体页…"），
     *    它们只出现在"没人审"与"审核者已被删掉"那几条分支里。
     *
     * ⚠️ 2026-10：这一档的日志**必须**与"没选组"那一档分开说，而实现也照做了
     *    （`autoChainReview` 里按 `=== null` 分两支）。判据因此多了一条：不许出现
     *    "没选智能体组"那种**指点使用者去改配置**的说法——这条路径上没人做错什么。
     */
    const workDir = await newWorkDir()
    const runId = ulid() as RunId

    const res = await submitRun({ runId, workDir, reviewerAgentId: null })
    assert.equal(res.status, 202, 'null 是合法意图，必须照常受理')

    const text = await waitForText(runId, /这次任务在新建时选择了/)
    assert.match(
      text,
      /这次任务在新建时选择了「这次不自动审核」/,
      '★ 日志必须说清"这次为什么没有审核"',
    )
    assert.match(text, /不是配置错误/, '要明说这不是故障（否则使用者会去改一个不该改的配置）')
    assert.doesNotMatch(
      text,
      /「由谁审它」是空的/,
      '★ 那是"你没配"的说法——本次配置明明是好的，是这次任务主动选择不审',
    )
    assert.doesNotMatch(
      text,
      /要自动审就在智能体页|请在智能体页重新指定一个/,
      '★ 不许劝使用者去智能体页改配置：这条路径上没有任何东西配错了',
    )
    assert.doesNotMatch(
      text,
      /要自动审，建任务时选一个智能体组/,
      '★ 也不许劝他去"选个组"：这次他就是**主动**选的"不自动审核"，不是漏选',
    )

    // ⚠️ 顺序是有意的：**先等日志，再断言"没有派生"**。
    //
    //   那句话同时也是**同步点**——它由"执行跑完之后的串接那一步"写下。
    //   反过来先查"有没有派生"，可能是在串接发生**之前**去看的，于是这条
    //   "没有派生"会以"我们看早了"的方式通过：一个靠时序侥幸通过的断言，
    //   比没有断言更危险。
    await new Promise((r) => setTimeout(r, 500))
    assert.deepEqual(
      await derivedRuns(runId),
      [],
      '★ 明确不审就必须一条派生都没有',
    )

    // 三态保真：null 与"缺字段"在库里必须看得出区别（详见下面的用例 7）
    const record = await getRunRecord(runId)
    assert.equal(
      'reviewerAgentId' in record,
      true,
      '"这次不审"是使用者的决定，必须在库里留痕——缺字段就等于"他没说"',
    )
    assert.equal(record['reviewerAgentId'], null)

    const row = (await listRunRows()).find((r) => r.runId === runId)
    assert.equal(row?.reviewer?.mode, 'none', '投影里要能与 follow 区分开')
  })

  test('★ reviewerAgentId: <别的审核者> ⇒ 覆盖长期配置（这个功能的核心）', async () => {
    /**
     * 执行者长期由 R1 审，这一次指定 R2 ⇒ 派生的审核 run 的 agent 必须是 R2。
     *
     * 这是整个功能的落点。断言"不等于 R1"和"等于 R2"两句都要有：
     * 只断言前者的话，一个**完全忽略这个字段**的实现（回退到跟随）也可能在
     * 某些配置下偶然通过；两句一起才锁死"覆盖生效了"。
     */
    const workDir = await newWorkDir()
    const runId = ulid() as RunId

    const res = await submitRun({ runId, workDir, reviewerAgentId: r2 })
    assert.equal(res.status, 202)

    const review = await waitForDerivedReview(runId)
    assert.equal(review.agentId, r2, '★ 这次任务指定的审核者必须真的去审')
    assert.notEqual(review.agentId, r1, '★ 不能被长期配置盖过去（那这个功能就没生效）')

    const record = await getRunRecord(runId)
    assert.equal(record['reviewerAgentId'], r2, '这次的决定要随执行 run 一起落库')

    const row = (await listRunRows()).find((r) => r.runId === runId)
    // ⚠️ 投影名从 `override` 改成了 `assigned`（2026-10：三态收成两态，
    //    "这条任务有审核者"是它现在唯一要表达的事；来自组还是本次指定看 `Run.groupId`）
    assert.equal(row?.reviewer?.mode, 'assigned')
    assert.equal(row?.reviewer?.agentId, r2)
  })
})

describe('★ 覆盖值的校验：三种坏值各自报清楚，而且不许留下幽灵 run', () => {
  /**
   * ══════════════════════════════════════════════════════════════════
   * 为什么校验必须在**写入之前**（server.ts 里那段注释的测试落点）
   * ══════════════════════════════════════════════════════════════════
   *
   * 审核者的合法性**只有这一刻能查**。等执行跑完再发现"指定的审核者其实是个
   * 执行者"，使用者已经等了一轮执行、烧了一轮 token，而且那一刻只能静默跳过
   * 审核——一条本该被审的产出会看起来正常结束。
   *
   * 三种坏值对应三种不同的改法（换一个 / 选错了 / 不能自审），所以码要分开。
   * 而且**被拒的请求不能留下任何 run 记录**：列表里多一条幽灵，比报错更难查。
   */
  test('★ 指定不存在的审核者 ⇒ 400 reviewer_not_found，且不入库', async () => {
    const workDir = await newWorkDir()
    const runId = ulid() as RunId
    const ghost = ulid()

    const res = await submitRun({ runId, workDir, reviewerAgentId: ghost })
    assert.equal(res.status, 400, '不存在的审核者必须在受理前拒绝')
    assert.equal(res.body['code'], 'reviewer_not_found')
    assert.match(String(res.body['error']), /不存在/, '要把"不存在"说清楚，使用者才知道是删掉了')

    assert.equal(
      (await listRunRows()).some((r) => r.runId === runId),
      false,
      '★ 被拒的请求不许留下 run 记录——否则列表里会多一条幽灵任务',
    )
    assert.equal((await fetch(`${daemon.url}/api/runs/${runId}`)).status, 404)
  })

  test('★ 指定一个 role: executor 的 agent ⇒ 400 reviewer_role_mismatch，且不入库', async () => {
    /**
     * "选错了人"是最容易犯的错：名字看着对，但那个 agent 是执行者。
     * 若不拦，后果是审核跑不起来、或者审出一个没有依据的结论——而两者都不报错。
     */
    const workDir = await newWorkDir()
    const runId = ulid() as RunId

    const res = await submitRun({ runId, workDir, reviewerAgentId: otherExecutor.id })
    assert.equal(res.status, 400)
    assert.equal(res.body['code'], 'reviewer_role_mismatch')
    assert.match(String(res.body['error']), /executor/, '错误里要指出它现在是什么角色')

    assert.equal(
      (await listRunRows()).some((r) => r.runId === runId),
      false,
      '★ 同样不许留下 run 记录',
    )
  })

  test('★ 让执行者审自己 ⇒ 400 reviewer_must_differ（码要说对方向，不是"角色不对"）', async () => {
    /**
     * ══════════════════════════════════════════════════════════════════
     * ⚠️ 这条曾经钉的是"报角色不匹配"——那是**顺序造成的错话**，已改
     * ══════════════════════════════════════════════════════════════════
     *
     * `POST /api/runs` 原来的校验顺序是：
     *
     *     不存在 ⇒ role 不是 reviewer ⇒ 与执行者同一个
     *
     * 一个**执行者角色的** agent 指定自己时，第二条就先命中了，于是返回
     * `reviewer_role_mismatch`，使用者读到的是"这个 agent 不是审核者"——
     * 而他真正做错的事是"你想让它审自己"（INV-1）。**错误信息指错了方向**，
     * 这正是本仓库最爱防的那类失败：状态码没错、拦截也没错，但人拿到的是
     * 一句会把他引到别处去的话。
     *
     * 所以顺序改成：
     *
     *     不存在 ⇒ **与执行者同一个（INV-1）** ⇒ role 不是 reviewer
     *
     * 判据只能比 id、不能比角色：`agentRef` 是执行者时它当然是 executor，
     * 拿角色当判据等于把这条检查关掉。
     *
     * ⚠️ 测试是**跟着决定改的**（不是把测试改绿）：改的是"哪句话才对"，
     *    而"自我审核必须被拒"这条断言一个字没松。
     */
    const workDir = await newWorkDir()
    const runId = ulid() as RunId

    const res = await submitRun({ runId, workDir, reviewerAgentId: executor.id })
    assert.equal(res.status, 400, '★ 自我审核必须被拒（INV-1）')
    assert.equal(
      res.body['code'],
      'reviewer_must_differ',
      '★ 报的必须是 INV-1 那个码：说"角色不对"会把人引到别处去',
    )
    assert.equal(
      (await listRunRows()).some((r) => r.runId === runId),
      false,
      '★ 无论报哪个码，都必须不入库',
    )
  })

  test('★ 与执行者同一个 agent ⇒ 400 reviewer_must_differ（同一个不变量，另一条构造）', async () => {
    /**
     * ══════════════════════════════════════════════════════════════════
     * 为什么这条要用一个 reviewer 角色的 agent 当"执行者"
     * ══════════════════════════════════════════════════════════════════
     *
     * `POST /api/runs` 不校验 `agentRef` 的角色（execute run 用谁都行），所以
     * 构造"同一个 reviewer 既执行又审核"是可行的。
     *
     * 上面那条是"执行者指定自己"，这条是"两个角色上是同一个人"——两条都落在
     * 同一个不变量上。留着它是为了证明**判据比的是 id，而不是角色**：如果哪天
     * 有人把判据写成"角色不是 reviewer 就拒"，上面那条会以"角色"为理由通过，
     * 而这一条会把同一个 agent 放过去（它**确实是** reviewer 角色）。
     */
    const workDir = await newWorkDir()
    const runId = ulid() as RunId

    const res = await submitRun({
      runId,
      workDir,
      agent: { id: r1, name: '审核者 R1（这次自己干活）' },
      reviewerAgentId: r1,
    })
    assert.equal(res.status, 400, '★ 自己审自己必须被拒——INV-1 说审核者必须不同于执行者')
    assert.equal(res.body['code'], 'reviewer_must_differ')
    assert.match(String(res.body['error']), /不同|自己/)

    assert.equal(
      (await listRunRows()).some((r) => r.runId === runId),
      false,
      '★ 不入库',
    )
  })
})

describe('★ 非执行 run 上带 reviewerAgentId ⇒ 一律拒绝，不许静默忽略', () => {
  /**
   * ══════════════════════════════════════════════════════════════════
   * 为什么"收下不用"比"报错"贵得多
   * ══════════════════════════════════════════════════════════════════
   *
   * `reviewerAgentId` 只在 `kind: 'execute'` 的 run 上有意义：审核 run 是被执行
   * run 派生出来的，**它自己不会再被审一次**。所以给一条 review run 带上这个
   * 字段，平台永远不会拿它去做什么——它是一条"设了但不生效"的设置。
   *
   * 而"设了但不生效"在这里是最贵的一类错：使用者选了 R2、点了提交、拿到 202，
   * 记录里甚至还能看到那个字段，于是他会以为**这次换了人审**。真相是这次审核
   * 用的是别处定的人、或者根本没有审核。这类错不会报任何错，只会让人得出一个
   * 错的结论——和"产出没被审却看起来正常"是同一个家族。
   *
   * 所以判据必须是**"键在不在"**（`body.reviewerAgentId !== undefined`）：
   * `null`（"这次不审"）对一条审核 run 同样毫无意义，收下它一样会让人以为
   * 自己的选择生效了。两条都钉。
   */
  test('★ kind: review + reviewerAgentId: <id> ⇒ 400 reviewer_override_not_applicable，且不入库', async () => {
    const targetRunId = await submitTargetExecuteRun()

    const reviewRunId = ulid() as RunId
    const res = await submitRun({
      runId: reviewRunId,
      kind: 'review',
      // 审核 run 的执行者当然是审核者本人（INV-1 要求它与被审那条 run 的执行者不同）
      agent: { id: r2, name: '审核者 R2' },
      subject: { type: 'run', id: targetRunId },
      workDir: await newWorkDir(),
      // ★ 这里**故意**用一个不存在的 id：它顺带钉住了校验的**顺序**——
      //   "非执行 run 不适用"必须排在"审核者不存在"前面。反过来的话
      //   （先查存在性）这条请求会报 `reviewer_not_found`，使用者就会去纠结
      //   "我是不是把 id 写错了"，而真正的问题是"这个字段在这条 run 上没意义"。
      reviewerAgentId: 'ghost-reviewer-id',
    })

    assert.equal(res.status, 400, '★ 不能收下一条永远不会生效的设置')
    assert.equal(res.body['code'], 'reviewer_override_not_applicable')
    assert.match(
      String(res.body['error']),
      /只对执行 run/,
      '错误信息要说清"为什么没用"，否则使用者只会换个 id 再试一次',
    )

    assert.equal(
      (await listRunRows()).some((r) => r.runId === reviewRunId),
      false,
      '★ 被拒的请求不许留下 run 记录',
    )
    assert.equal((await fetch(`${daemon.url}/api/runs/${reviewRunId}`)).status, 404)

    // 反向确认"我们不是在数一个空列表"：夹具那条被审的执行 run 确实在库
    assert.equal((await fetch(`${daemon.url}/api/runs/${targetRunId}`)).status, 200)
  })

  test('★ 判据是"键在不在"：kind: review + reviewerAgentId: null 也照样被拒', async () => {
    /**
     * `null` 的含义是"这一次明确不自动审"——而一条审核 run **本来就不是"被审的
     * 那一次"**，所以这句话在它身上没有落点。若这里放行，使用者看到 202
     * （甚至看到记录里那个 null）会以为自己"关掉了这条审核的再审"。
     */
    const targetRunId = await submitTargetExecuteRun()

    const reviewRunId = ulid() as RunId
    const res = await submitRun({
      runId: reviewRunId,
      kind: 'review',
      agent: { id: r2, name: '审核者 R2' },
      subject: { type: 'run', id: targetRunId },
      workDir: await newWorkDir(),
      reviewerAgentId: null,
    })

    assert.equal(res.status, 400, '★ 判据是"这个键出现了没有"，不是"它有没有值"')
    assert.equal(res.body['code'], 'reviewer_override_not_applicable')
    assert.equal(
      (await listRunRows()).some((r) => r.runId === reviewRunId),
      false,
      '★ 不入库',
    )
  })
})

describe('★ 落库保真：库里能分辨 undefined / null / id', () => {
  test('★ 三条 run 的 reviewerAgentId 分别是"缺字段 / null / 那个 id"', async () => {
    /**
     * ══════════════════════════════════════════════════════════════════
     * 这条存在的理由：三态一旦在落库时被压成两态，**没有任何别的测试会红**
     * ══════════════════════════════════════════════════════════════════
     *
     * 上面那几条用例断言的是**行为**（派生/不派生/派给谁）。而"行为"是
     * `autoChainReview()` 拿这个字段算出来的结果。如果哪天 `executor.submit()`
     * 把它折成一个值，**审计这一层**就分不出"使用者当时到底说了什么"了。
     *
     * `Run.reviewerAgentId` 的注释把这三种情形分开写着，正是因为
     * "这条小改动就别审了"是一个**决定**，折进 `undefined` 就没人知道那是谁的决定。
     * ⚠️ 2026-10：`undefined` 与 `null` 在**行为**上已经同义（都不审），但它们在
     * **记录**上仍然要分开——日志那两句就是照这个区别说的（"你主动选的"对
     * "你没选组"）。折成一个值，那句区分当场变成谎话。
     *
     * 观测点：`GET /api/runs/<id>` 返回的就是落库的那个 Run 对象（不是投影），
     * 所以 `'reviewerAgentId' in record` 直接回答"键在不在"。
     * （列表投影另外给了一个面向界面的 `reviewer.mode`，两条都断言。）
     */
    const workDir = await newWorkDir()

    const followId = ulid() as RunId
    const noneId = ulid() as RunId
    const overrideId = ulid() as RunId

    // 三条都用**同一个执行者**提交，差别只在这个字段——否则分不清是字段的功劳。
    // ⚠️ 三条都在同一个 workDir 上：同一目录同时只允许一条 run（FR-RUN-04），
    //    但这里只关心**受理那一刻落库的记录**（`submit` 里 insertRun 在返回
    //    accepted 之前），所以不需要等它们跑完。
    assert.equal((await submitRun({ runId: followId, workDir })).status, 202)
    assert.equal((await submitRun({ runId: noneId, workDir, reviewerAgentId: null })).status, 202)
    assert.equal((await submitRun({ runId: overrideId, workDir, reviewerAgentId: r2 })).status, 202)

    const follow = await getRunRecord(followId)
    const none = await getRunRecord(noneId)
    const override = await getRunRecord(overrideId)

    // ① 省略：键不存在，读出来是 undefined
    assert.equal('reviewerAgentId' in follow, false, '★ 省略 ⇒ 库里不该出现这个键')
    assert.equal(follow['reviewerAgentId'], undefined)

    // ② null：键存在，值是 null —— 与 ① 必须看得出区别
    assert.equal('reviewerAgentId' in none, true, '★ null 必须留痕，否则等于"使用者没说"')
    assert.equal(none['reviewerAgentId'], null)

    // ③ id：键存在，值是那个 id
    assert.equal('reviewerAgentId' in override, true)
    assert.equal(override['reviewerAgentId'], r2)

    // 三个值两两不同——上面三条断言合起来才是"三态可分辨"
    assert.notDeepEqual(
      [follow['reviewerAgentId'], none['reviewerAgentId']],
      [none['reviewerAgentId'], override['reviewerAgentId']],
      'undefined / null / id 必须两两可分',
    )

    // 投影那一层（页面读的就是它）
    //
    // ⚠️ 2026-10：投影从三态收成**两态**（`follow` 那一态随着 `Agent.reviewerAgentId`
    //    一起撤销了：没有可跟随的东西）。所以"省略"与"null"在投影上都读作 `none`
    //    ——这不是"折了"，而是它们**对页面而言本来就是同一件事**：这条任务没人审。
    //    要区分得看上面那层记录（键在不在），而日志那两句正是照它说的。
    const rows = await listRunRows()
    const modeOf = (id: string): string | undefined => rows.find((r) => r.runId === id)?.reviewer?.mode
    assert.equal(modeOf(followId), 'none')
    assert.equal(modeOf(noneId), 'none')
    assert.equal(modeOf(overrideId), 'assigned')
  })
})

/**
 * ★ 「配过、但现在失效」必须进通知中心，而不是只写一行日志。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么这条单独一个 describe
 * ══════════════════════════════════════════════════════════════════
 *
 * "没有串接审核"其实有**两种**，它们的处置完全不同：
 *
 *   · **本来就没打算审**（执行者没配审核者 / 这次选了不审）⇒ D28 里是**合法选择**，
 *     只写进这条 run 的记录就够——它不该去打扰人；
 *   · **配过、现在失效**（指向的人没了 / 角色被改了）⇒ 这是**出事了**：这条产出
 *     没被审，而 run 状态一切正常。只有一行日志的话，发现它的唯一途径是有人
 *     正好去翻这条 run 的日志。
 *
 * 所以第二种要进通知中心（与"链路深度超限"同一档：意外 + 有后果）。
 *
 * ⚠️ 这条路径是**可达的**，不是纸上推演：`PATCH /api/agents/:id` 允许把角色从
 *    reviewer 改成 executor，而**没有**任何一步会去清理别人身上指向它的
 *    `reviewerAgentId`（也不该清理——那等于替使用者改配置）。所以"昨天还在审、
 *    今天角色被改了"是真实可发生的一种状态。
 *
 *    （顺带一个事实：agent 没有删除路由，所以"指向的人被删掉"那一档在当前
 *     API 面上到不了。那里同样补了通知，属于防御性对称。）
 */
describe('★ 审核者事后失效 ⇒ 进通知中心（不是只写日志）', () => {
  test('★ 审核者的角色在提交之后被改成执行者 ⇒ 跳过审核，并在通知中心留一条', async () => {
    const r3 = await createAgent({
      name: '审核者 R3（待会被改成执行者）',
      role: 'reviewer',
      reviewStandard: { body: '# R3 标准\n\n随便判判。' },
    })
    const e3Id = await createAgent({ name: '执行者 E3（由 R3 审）', role: 'executor' })
    const e3 = { id: e3Id, name: '执行者 E3（由 R3 审）' }

    // ⚠️ 2026-10：这一条原来是"先把角色改掉、再提交"——那时提交**不查**审核者的
    //    角色（长期配置那条路只在跑完时查）。现在"谁审"由组展开，而组的形态在
    //    **提交那一刻**就校验（先改后提交会在那里被拦成 `group_shape_invalid`，
    //    那是另一条规矩、另一个 400，见 `task-action-whitelist.test.ts`）。
    //
    //    于是这条用例回到它名字里本来就写着的那件事：**在提交之后**改。
    //    为了不靠时序碰运气（假后端只跑几毫秒），这里用闸门把执行 run 挂在
    //    "跑着"的状态上，改完配置再放行——顺序因此是确定的。
    const groupId = await createChainGroup(
      { url: daemon.url },
      { name: 'E3 组', members: [e3Id, r3] },
    )

    let release: () => void = () => {}
    backend.hold = new Promise<void>((resolve) => {
      release = resolve
    })

    const runId = ulid() as RunId
    let res: { status: number; body: Record<string, unknown> }
    try {
      res = await submitRun({ runId, agent: e3, workDir: await newWorkDir(), groupId })
      assert.equal(res.status, 202, '★ 提交本身必须成功：这是"跑完之后"才发现的事')

      // 等执行**真的跑起来**（闸门就是在这里生效的），此时配置还是好的
      await waitFor(async () => (backend.phases.includes('execute') ? true : null), '执行跑起来')

      // 现在把审核者的角色改掉——这是这条用例的**前提**，所以必须确认它真的成功了；
      // 否则失败时会分不清"通知没发"还是"角色根本没改"。
      const patched = await fetch(`${daemon.url}/api/agents/${r3}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'executor' }),
      })
      // ⚠️ body 只能读一次：`.text()` 之后再 `.json()` 会抛
      //    "Body has already been read"（这条踩过一次）。
      const patchedBody = await patched.text()
      assert.equal(patched.status, 200, `改角色应当成功：${patchedBody}`)
      assert.equal((JSON.parse(patchedBody) as { role: string }).role, 'executor')
    } finally {
      // ★ 放行必须写在 finally 里：上面任何一句断言失败时，不放行就会把这条 run
      //   永远挂在"跑着"，后续用例会跟着一起红（症状离原因很远）。
      backend.hold = null
      release()
    }

    const text = await waitForText(runId, /角色已经不是「审核者」/)
    assert.match(text, /请重新指定一个审核者/, '日志要说清下一步')

    assert.deepEqual(await derivedRuns(runId), [], '★ 不许照跑：审核者与执行者同角色 = INV-1 破了')

    const inbox = ((await (await fetch(`${daemon.url}/api/inbox`)).json()) as {
      items: Array<{ type: string; title: string; body: string; runId: string | null }>
    }).items
    const notice = inbox.find((i) => i.type === 'review.reviewer_role_changed')
    assert.ok(notice, `★ 通知中心必须有这一条，实际有的是：${inbox.map((i) => i.type).join(', ')}`)
    assert.equal(notice.runId, runId, '要指回是哪一条 run 没被审')
    assert.match(notice.body, /不再是「审核者」/, '要说清发生了什么')
    assert.match(notice.body, /重新指定/, '也要说清下一步')
  })
})
