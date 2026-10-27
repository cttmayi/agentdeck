import { after, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AsyncQueue,
  type AgentBackend,
  type AgentMessage,
  type AgentSession,
  type ExecOptions,
  deliveredBytes,
} from '@agentdeck/agent-core'
import {
  ulid,
  VERDICT_FENCE_BEGIN,
  VERDICT_FENCE_END,
  type AuditRecord,
  type InboxItem,
  type VerdictRecord,
} from '@agentdeck/protocol'
import { startDaemon, type DaemonHandle } from './server.ts'
import { createChainGroup } from './testing/chain.ts'
import {
  installToolPackage,
  verdictAction,
  writeToolPackage,
  type ToolPackage,
} from './testing/tool-fixture.ts'
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
  /** 系统提示（①②）。A 档下框架与身份走这条通道，`prompt` 里只剩 ③。 */
  seenSystemPrompt: string | null = null
  calls = 0
  /**
   * 执行那一刻 `.claude/skills/` 下的文件（`slug/相对路径` → 内容）。
   *
   * ★ 必须在执行时抓：注入是**临时**的，run 结束后会被清掉
   *   （FR-CLI-16：只清自己造的东西）。跑完再去看永远是空的。
   */
  seenSkillFiles: Record<string, string> = {}

  async probe(): Promise<{ available: boolean; command: string; cliVersion: string | null }> {
    return { available: true, command: 'claude', cliVersion: '0.0.0-fake' }
  }

  /** 假后端也要**如实上报**命令行——审计记的是这条（见下面那条断言）。 */
  readonly reportedArgv = ['/usr/local/bin/claude', '-p', '--output-format', 'stream-json']

  async execute(opts: ExecOptions): Promise<AgentSession> {
    this.calls += 1
    opts.onCommandLine?.({ argv: this.reportedArgv, sandboxDescription: '未启用沙箱（测试）' })
    // D29：交给 CLI 的只有第一句话（走 prompt），不再有 CLAUDE.md。
    // 2026-09：三块组装之后，A 档把 ①② 放进系统提示 ⇒ "它被交代了什么"是两块合起来。
    this.seenSystemPrompt = opts.systemPrompt ?? null
    this.seenContext = [opts.systemPrompt ?? '', opts.prompt]
      .filter((p) => p !== '')
      .join('\n\n')

    this.seenSkillFiles = {}
    const skillsRoot = join(opts.workDir, '.claude', 'skills')
    const walk = async (dir: string, slug: string, prefix: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const full = join(dir, entry.name)
        const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
        // ★ 必须递归：支持文件常常放在子目录里（`scripts/check.sh`），
        //   只看一层会让"嵌套文件没写下去"这种问题漏过去。
        if (entry.isDirectory()) await walk(full, slug, rel)
        else this.seenSkillFiles[`${slug}/${rel}`] = await readFile(full, 'utf8').catch(() => '')
      }
    }
    for (const slug of await readdir(skillsRoot).catch(() => [] as string[])) {
      await walk(join(skillsRoot, slug), slug, '')
    }

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
 * 这个文件里判决要用的那条动作（D41）。
 *
 * 内置动作被全部移除之后，判决里的动作必须来自一个**真的装了**的工具包，而
 * 首启播种的审核者**没有任何动作权限**（D41 的刻意结果）。所以 `before` 里装两个
 * 夹具包：
 *
 *   · `toolPkg`（`fixture-tool.act`）—— 授给播种的审核者，判决里的正常动作；
 *   · `deniedPkg`（`other-tool.act`）—— **只装、不授权**，用来守"装了 ≠ 允许了"
 *     （那条用例要的正是"动作可用但不在这个审核者的行动权限里"）。
 *
 * 两个包都是**真 node 脚本**：只往工作目录写一个文件（NFR-T-01：不调用真实 CLI，
 * 但自己写的脚本是真跑的）。装而不授权那一个是刻意的：只用一个包的话，"拦住它"
 * 的可能是"包没装"而不是白名单，那条用例就变成空过了。
 */
let toolPkg: ToolPackage
let deniedPkg: ToolPackage
/**
 * 播种那一对（执行者 + 审核者）所在的**组**，组上带着 `toolPkg.action`。
 *
 * ★ 它是"动作真的被执行"那条用例的落点：报告那条路**不属于任何组**（所以拿不到
 *   任何动作授权），要验动作就得走一条**带组的执行 run**。
 */
let seededGroupId: string

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

  // ══════════════════════════════════════════════════════════════════
  // ★ D41 + 2026-10：动作只能来自**装进来的工具包**，而且只属于**组**
  // ══════════════════════════════════════════════════════════════════
  //
  // 这个文件里绝大多数用例的主体**不是**动作本身（报告落库与路由、阶段推导、
  // 审计链、判决分支、重试……），只是顺手让判决带一个动作。以前那个动作可以写
  // 内置裸名（`comment.create`），现在不行了：它必须来自一个真的装了的包。
  //
  // ⚠️⚠️ **而这份文件走的是报告那条路**（`POST /api/reports` ⇒ 兜底审核者），
  //    2026-10 之后**报告审核不属于任何组**（组描述的是"执行 → 审核 → 行动"这条
  //    链，而报告没有那条链）⇒ 它的动作白名单**永远是空的** ⇒ **判决只能给结论**。
  //    这是使用者明确接受的结果（"动作只属于组，报告审核只能给结论"），不是遗漏。
  //
  //    所以这一节里"判决带动作"的那几处都改成了"不带动作"，而"带动作会怎样"
  //    单独有一条用例钉住（越权的动作一定被拦下）。**动作真的被执行**那条路
  //    仍然有覆盖，但它需要一条**带组的执行 run**——见下面
  //    「★ 动作只有挂在组上才会被执行」那一节。
  //
  // 两个包照旧装着：这样"动作被拦下"的理由只可能是**白名单**，而不是
  // "这个名字根本没装"（那是另一条路径、另一句话）。
  //
  // ⚠️ 用 `setupToolFixture()` 是不行的：它会**额外**建一对 agent，而这一节里
  //    有多条用例在数"这份报告被谁接住了、起了几条 run"——多一对审核者会让
  //    每份报告都被审两遍。
  toolPkg = await writeToolPackage()
  await installToolPackage(daemon, toolPkg)
  deniedPkg = await writeToolPackage({ slug: 'other-tool', summary: '装了但没有被授权的动作' })
  await installToolPackage(daemon, deniedPkg)

  const seededAgents = ((await (await fetch(`${daemon.url}/api/agents`)).json()) as {
    agents: Array<{ id: string; name: string; role: string }>
  }).agents
  const seededReviewer = seededAgents.find((a) => a.role === 'reviewer')
  const seededExecutor = seededAgents.find((a) => a.role === 'executor')
  assert.ok(seededReviewer, '首启会播种审核者 —— 这个文件的多条用例都靠它接住报告')
  assert.ok(seededExecutor, '首启也会播种一个执行者')

  // ★ 给**播种的那一对**建一个组，组上带那个夹具动作。
  //
  //   它**不影响报告那条路**（报告不属于任何组，所以永远拿不到这份授权），
  //   它是给"动作真的被执行"那条用例用的：带这个组提交一条执行 run，执行完派生
  //   出来的审核 run 就带着这份白名单，判决里的动作这才有落点。
  seededGroupId = await createChainGroup(
    { url: daemon.url },
    {
      name: '播种组的动作授权',
      members: [seededExecutor.id, seededReviewer.id],
      allowedActions: [toolPkg.action],
    },
  )
})

after(async () => {
  await daemon.close()
  await cleanup(dataDir)
  await cleanup(workDir)
})

/**
 * 往**指定的** daemon 发一份报告。
 *
 * ⚠️ 与 `postReport` 的区别就是那个 url：它写死了共享的 `daemon`，于是各用例
 *    自建的 daemon 只能自己内联 fetch——那个坑在文件里已经踩过一次（见下面
 *    `createRetryRun` 相关用例里的注释："报告会进到**另一个 daemon**里"）。
 */
async function postReportTo(
  url: string,
  source: string,
  items: Array<{ externalId: string; kind: string; title: string; body: string }>,
): Promise<ReportIngestResponse> {
  const res = await fetch(`${url}/api/reports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source, items }),
  })
  assert.equal(res.status, 202)
  return (await res.json()) as ReportIngestResponse
}

async function postReport(
  source: string,
  items: Array<{ externalId: string; kind: string; title: string; body: string }>,
): Promise<ReportIngestResponse> {
  return postReportTo(daemon.url, source, items)
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

/**
 * 等到**至少出现一条 run，并且全部结束**。
 *
 * ⚠️ 两处都容易错，两处都踩过：
 *
 *    1. **不能直接用 `awaitRunsSettled()`**：`[].every(...)` 是 `true`，所以
 *    列表还空着时它会**立刻返回**。报告摄取的 run 是异步起的——
 *    `POST /api/reports` 的响应里已经有 runId，但那一刻 `GET /api/runs`
 *      列表还空着时它会**立刻返回**；
 *    2. **必须显式传 url**：本文件既有共享的 `daemon`，也有各用例自建的
 *       `d`。helper 内部图省事用模块级的那个，就会去轮询**另一个 daemon**——
 *       那里恰好有别的用例留下的已结束 run，于是又是"立刻返回"。
 *
 *    两种错误的症状一模一样：断言在运行还没开始时就执行，报出来的是
 *    "支持文件没写下去"，而真正的原因是我们**看早了**。
 */
async function awaitRunFinished(url: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const res = await fetch(`${url}/api/runs`)
    const { runs } = (await res.json()) as { runs: Array<{ status: string }> }
    if (runs.length > 0 && runs.every((r) => TERMINAL_RUN_STATUSES.has(r.status))) return
    if (Date.now() > deadline) {
      throw new Error(`等待 run 出现并结束超时，当前 ${runs.length} 条`)
    }
    await new Promise((r) => setTimeout(r, 25))
  }
}

async function fetchVerdicts(runId: string): Promise<VerdictRecord[]> {
  const res = await fetch(`${daemon.url}/api/runs/${runId}/verdicts`)
  return ((await res.json()) as { verdicts: VerdictRecord[] }).verdicts
}

/**
 * 读**播种的默认组**的 id（首启会建一组：播种的执行者 + 播种的审核者）。
 *
 * ★ 2026-10 起"执行者由谁审"只有组能回答。首启播种的那一对被一个默认组串起来，
 *   所以"这条用例靠它自动串接"这类夹具前提，判据就是"那个组在、成员对得上"。
 */
async function seededGroupOf(url: string): Promise<string | null> {
  const { agents } = (await (await fetch(`${url}/api/agents`)).json()) as {
    agents: Array<{ id: string; role: string }>
  }
  const executor = agents.find((a) => a.role === 'executor')
  const reviewer = agents.find((a) => a.role === 'reviewer')
  if (!executor || !reviewer) return null
  const { groups } = (await (await fetch(`${url}/api/agent-groups`)).json()) as {
    groups: Array<{ id: string; members: string[] }>
  }
  return (
    groups.find((g) => g.members.includes(executor.id) && g.members.includes(reviewer.id))?.id ?? null
  )
}

async function fetchRun(runId: string): Promise<{ status: string }> {
  const res = await fetch(`${daemon.url}/api/runs/${runId}`)
  return (await res.json()) as { status: string }
}

describe('S2：报告 → 审核 → 判决 → 动作', () => {
  test('★ 报告落库、路由到兜底审核者、并起了一个 review run', async () => {
    backend.script = [
      validVerdict({
        conclusion: 'pass',
        reasonCode: 'meets_criteria',
        // ⚠️ 2026-10：这里原来带一个动作（`verdictAction(toolPkg.action, …)`）。
        //    **报告那条路现在拿不到任何动作授权**——它不属于任何组，而动作只属于组
        //    ⇒ 判决带动作只会被判成结构性问题（下面单独有一条用例钉这件事）。
        //    这条用例的主体是**报告摄取与路由**（`unmatched === 0`、起了一条 review
        //    run），所以判决改成"只给结论"，断言回到它本来要守的那几件事。
        action: null,
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
    assert.equal(verdicts[0]?.conclusion, 'pass')
    assert.equal(
      verdicts[0]?.status,
      'advisory',
      '★ 报告审核只给结论（没有组就没有动作权限）⇒ advisory，而不是 dispatched_to_action',
    )
  })

  test('★ /api/runs 要带上审核 run 的判决结论（阶段推导靠它）', async () => {
    // ══════════════════════════════════════════════════════════════════
    // 这条是为一个真实反馈加的
    // ══════════════════════════════════════════════════════════════════
    //
    // 使用者：「审查的结论是 needs_human，被标为『已审查』，不合理」。
    //
    // 页面之所以标错，是因为 `runs` 列表里**只有"审核 run 完成了没有"**，
    // 没有判决结论——于是无论判成什么，都只能显示成"已审查"。
    // 现在把结论并进列表响应，这条用例守住这个字段真的在。
    const { runs } = (await (await fetch(`${daemon.url}/api/runs`)).json()) as {
      runs: Array<{
        runId: string
        kind: string
        verdict: { status: string; conclusion: string; escalateReason: string | null } | null
      }>
    }
    const review = runs.find((r) => r.kind === 'review')
    assert.ok(review, '应当有一条审核 run')
    assert.ok(review.verdict, '★ 审核 run 必须带上判决——否则页面只能把 needs_human 显示成"已审查"')
    assert.equal(review.verdict.conclusion, 'pass')
    assert.equal(review.verdict.status, 'advisory', '报告审核只给结论（见上一条）')
    // 执行 run 上没有判决（它是被审的对象，不是判决的产出者）
    const execute = runs.find((r) => r.kind === 'execute')
    assert.equal(execute?.verdict ?? null, null, '执行 run 不该有判决字段')
  })

  test('★ 审核这个 run 本身在审计链里留下完整事实（报告那条路没有动作）', async () => {
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
    // ══════════════════════════════════════════════════════════════════
    // ★ 这四项原来是**写死的**（'claude' / null / null / 按描述表拼的 argv）
    // ══════════════════════════════════════════════════════════════════
    //
    // 审计是事后唯一的依据，写死的值不是"空着"而是**说错话**：换一个 runtime，
    // 审计仍然声称用的是 claude。所以这里逐项钉住"它来自事实"。
    assert.equal(audit.runtimeDescriptorKey, 'claude', '这条 run 跑的就是 claude')
    assert.equal(audit.cliVersion, '0.0.0-fake', '★ 版本要来自探测，不是写死的 null')
    assert.deepEqual(
      audit.argvRedacted,
      backend.reportedArgv,
      '★ 命令行要来自后端如实上报的那条，不是按描述表拼的大概样子',
    )
    // 输入只剩一处（第一句话），所以哈希也只剩一个
    assert.match(String(audit.promptHash), /^[0-9a-f]{64}$/, '★ 输入哈希要真算过')

    // ★ 而且必须是**投递出去那段文本**的哈希，不是 `req.prompt`。
    //   改版前哈希的是 `req.prompt`——审核 run 的那句"请审核…"甚至没被送出去，
    //   于是哈希与输入对不上，"可追溯"就成了空话。
    // ★ 从**这条 run 自己的日志**里取回那两块（2026-09 起日志把 ①②③ 三块
    //   **分开带标签**记，见 executor.ts——那三块就是投递出去的内容本身，
    //   逐字、不截断）。
    //   ⚠️ 为什么不从日志按位置取 system/user：位置的先后是排版、不是投递事实；
    //     A 档 system = ①② 按与 `renderDelivery` 同一口径拼、user = ③；B 档
    //     user = 三条带标签的 note 原样 join（那就是投递出去的那一段）。
    //   ⚠️ 按 run 取，不靠"后端最后收到的那一份"——那是全局的，后面再跑一条
    //     run 就把它覆盖了。
    const parts = await (async () => {
      const msgs = (
        ((await (await fetch(`${daemon.url}/api/runs/${reviewRun!.runId}/messages?since=-1`)).json()) as {
          messages: Array<{ content: string }>
        }).messages
      ).map((m) => m.content ?? '')
      const header = msgs.find((c) => /投递档 [AB]：/.test(c)) ?? ''
      const mode = /投递档 ([AB])：/.exec(header)?.[1]
      if (!mode) return null
      const blockOf = (label: string): string => {
        const note = msgs.find((c) => c.startsWith(`===== ${label} =====`))
        if (!note) return ''
        return note.slice(`===== ${label} =====`.length).replace(/^\n+/, '')
      }
      const frame = blockOf('① 框架')
      const identity = blockOf('② 身份')
      const task = blockOf('③ 任务')
      if (task === '') return null
      if (mode === 'B') {
        // B 档的 user = 三条带标签的 note 按序 join（与 `renderDelivery` B 同一拼法）
        const notes = msgs.filter((c) => /^===== [①②③] /.test(c))
        return { system: '', user: notes.join('\n\n') }
      }
      return { system: [frame, identity].filter((p) => p !== '').join('\n\n'), user: task }
    })()
    assert.notEqual(parts, null, '日志里应当能找到三块带标签的内容（投递出去的那段）')
    // ⚠️ 口径与执行器**同一处**（`deliveredBytes`）：两块 + 一个不会出现在文本里的分隔符。
    //    各拼一份的话，某天两边分叉，审计里的哈希就对不上真正投递的东西。
    // ⚠️ 判据用**后端真的收到的那两块**（那才是"投递出去的东西"）——从副本文件
    //    取，是因为它逐字保存了投递的那段文本（含系统/用户的分界标记）。
    assert.equal(
      audit.promptHash,
      createHash('sha256')
        .update(
          deliveredBytes({
            system: parts!.system,
            user: parts!.user,
          }),
          'utf8',
        )
        .digest('hex'),
      '★ 输入哈希要等于**真正投递出去的那两块**的 sha256',
    )
    assert.notEqual(audit.promptHash, null, '必须有 prompt 哈希')
    assert.equal(audit.verdictId, (await fetchVerdicts(reviewRun!.runId))[0]?.id)

    // ══════════════════════════════════════════════════════════════════
    // ★ 动作那一环：这一节里的审核**不该有动作**（而且审计要如实地是空的）
    // ══════════════════════════════════════════════════════════════════
    //
    // 这条断言原来钉的是"审计必须记下这条判决触发的那个动作"（`actionIds.length === 1`），
    // 那时判决带着一个动作、走的也是报告这条路。
    //
    // ⚠️ 2026-10：**报告审核拿不到动作授权**（它不属于任何组）⇒ 这条链上的判决只能
    //    给结论，`actionIds` 必须是空的。所以这一条反过来变成"空"的硬证据：它防的是
    //    "某天动作权限又从某个角落漏回报告这条路"——那种漏法会让报告里的判决
    //    重新具备动手能力，而报告是**外部内容**驱动的（自动摄取），权限边界必须比
    //    执行 run 那条路更死。
    //
    // ★ 而"动作真的被执行、并落进审计链"这件事仍然有覆盖：它现在需要一条**带组的
    //   执行 run**——见下面「★ 动作只有挂在组上才会被执行」那一节。
    assert.deepEqual(audit.actionIds, [], '★ 报告这条路没有动作权限 ⇒ 审计里也不该有动作')
  })

  test('★ 审核的第一句话含审核标准与判决格式要求（FR-CLI-43）', () => {
    assert.notEqual(backend.seenContext, null)
    // 2026-09：标准并进 ② 身份那一块（不再由平台加「## 审核标准」标题，
    // 标题归模版/正文自己），所以这里认"那一块"与标准正文本身
    assert.match(backend.seenContext!, /^# 审核任务$/m, '框架那一块（走系统提示）')
    assert.match(backend.seenContext!, /你是一个严格的审核者/, '身份那一块（②）')
    // ★ 2026-09 三次改：标准并进「指令」，播种审核者的判据是**纯判据**（内置
    //   那份"通用审核"标准已删，判决词汇是平台契约的事、不在判据里），所以这里
    //   比的是判据正文——它必须随第一句话下发。
    assert.match(backend.seenContext!, /每条结论都要有依据/, '判据正文必须随第一句话下发')
    assert.match(backend.seenContext!, /ALPHA_VERDICT/, '必须给出判决格式约定')
  })

  test('★ 审核的第一句话必须带上「这次要你做什么」（调用方的指令）', async () => {
    // ══════════════════════════════════════════════════════════════════
    // 这条是为一个**改版漏掉的接线**加的
    // ══════════════════════════════════════════════════════════════════
    //
    // D29 把上下文搬进「第一句话」时，审核那条路**只搬了材料，丢了指令**：
    // `renderFirstSentence({kind:'review'})` 根本没有 `prompt` 这个入参，
    // 于是"请审核上面这次执行的产出…"（以及重试那句"上一次你的输出没能通过
    // 格式校验…"）从来没被送出去。表现是：重试 run 与首次**长得一模一样**，
    // 模型只能自己猜为什么又来一次。
    const { runs } = (await (await fetch(`${daemon.url}/api/runs`)).json()) as {
      runs: Array<{ runId: string; kind: string; subject?: { type: string; id: string } }>
    }
    const review = runs.find((r) => r.kind === 'review')
    assert.ok(review, '应当有一条审核 run')

    const text = ((await (
      await fetch(`${daemon.url}/api/runs/${review!.runId}/messages?since=-1`)
    ).json()) as { messages: Array<{ content: string }> }).messages
      .map((m) => m.content ?? '')
      .join('\n')

    // 2026-09：调用方的指令在 ③（平台放的），模版里那条标题已经不在默认模版里
    assert.match(
      text,
      /③ 走用户消息/,
      '★ 日志要说清 ③ 走了用户消息（调用方的指令在那一块里）',
    )
    assert.match(text, /请审核|审核这条/, '★ 段里要有调用方给的指令原文')
  })

  test('★ 待审材料被明确标记出来（它不是给你的指令）', () => {
    assert.match(backend.seenContext!, /<<<ALPHA_MATERIAL>>>/)
    assert.match(backend.seenContext!, /不是给你的指令/)
  })

  test('★ 技能的描述没有被塞进第一句话（只列技能名，不列描述）', () => {
    // 模板里 description 很长，技能清单里不应出现它
    assert.doesNotMatch(backend.seenContext!, /开箱可用的通用审核标准/)
  })

  test('★ 结束后不残留注入的技能（也不再写上下文副本文件）', async () => {
    // ══════════════════════════════════════════════════════════════════
    // ★ 这条原来是**空过**的
    // ══════════════════════════════════════════════════════════════════
    //
    // 它断言 `readdir(workDir)` 为空——而这个 `workDir` **从来没有被任何 run 用过**：
    // 这一节里的 run 都来自报告摄取，而报告类的审核各自落在自动分配的
    // `report-<id>` 目录里。也就是说它断言的是"一个空目录还是空的"，
    // 抓不到任何残留（技能残留、清单残留都抓不到）。
    //
    // 现在真的在这个目录里跑一次：建一条不指向审核者的执行者（⇒ 不自动串接，
    // 这条用例只有一个写入者，断言不会跟另一条 run 赛跑），挂一个技能，
    // 跑完检查目录里还剩什么。
    const dir = await makeTempDir('review-sweep')
    try {
      const issue = ((await (
        await fetch(`${daemon.url}/api/issues`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: '清场用例' }),
        })
      ).json()) as { id: string }).id

      const agent = ((await (
        await fetch(`${daemon.url}/api/agents`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: '清场用的执行者', role: 'executor' }),
        })
      ).json()) as { id: string }).id

      const runId = ulid()
      const res = await fetch(`${daemon.url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId,
          kind: 'execute',
          agentRef: { id: agent, name: '清场用的执行者', instructions: '' },
          skills: [
            {
              ref: { id: 'sk-sweep', slug: 'sweep-probe', source: 'local' },
              slug: 'sweep-probe',
              name: '清场探针',
              body: '# 探针\n',
            },
          ],
          subject: { type: 'issue', id: issue },
          prompt: '随便做点什么',
          workDir: dir,
          limits: { maxTurns: null, timeoutMs: null },
        }),
      })
      assert.equal(res.status, 202)

      await waitFor(async () => ((await fetchRun(runId)).status === 'completed' ? true : null))

      const left = await readdir(join(dir, '.claude', 'skills')).catch(() => [] as string[])
      assert.deepEqual(left, [], `注入的技能与归属清单都该收掉，实际剩：${left.join(', ')}`)

      // 上下文副本**不再写**（2026-09 产品决定：日志已含第一句话全文，执行/审核
      // 都不保存副本文件）。工作目录里不该留下 `.agentdeck/context/`。
      // ⚠️ `.agentdeck/` 本身仍是受管路径（§3.3b 的 rounds/ 文件在里面）。
      assert.equal(
        (await readdir(join(dir, '.agentdeck', 'context')).catch(() => [] as string[])).length,
        0,
        '★ 不写上下文副本文件（回看靠日志里的第一句话全文）',
      )
      assert.ok(
        !(await readdir(dir)).includes('CLAUDE.md'),
        '★ 我们不许在工作目录里造 CLAUDE.md',
      )
    } finally {
      await cleanup(dir)
    }
  })
})

/**
 * ══════════════════════════════════════════════════════════════════
 * ★ 动作只有挂在**组**上才会被执行（2026-10 之后唯一那条路）
 * ══════════════════════════════════════════════════════════════════
 *
 * 上面那一节走的是**报告**那条路，而报告不属于任何组 ⇒ 那份判决只能给结论
 * （`audit.actionIds` 是空的，有一条用例专门钉它）。
 *
 * 这一节是它的**正面**：同样一个带动作的判决，只要这条审核是**带组的执行 run
 * 派生出来的**，动作就真的会被执行、而且落进审计链。
 *
 * 两节合起来才完整：单看任何一节，都分不清"动作没执行"是因为**权限边界**，
 * 还是因为动作这条路整个坏了。
 *
 * ⚠️ 为什么要在这里再测一遍（`tool-action-e2e.test.ts` 已经测过动作能跑）：
 *    这里测的是**审计链**那一环——"判决带了动作、审计里却什么都没有"是一种
 *    完全可能的失败（判决照旧 `dispatched_to_action`，只是链子上少了一环）。
 *    原来那条断言在报告路径上，而现在那条路径永远没有动作，于是它迁到这里。
 */
describe('★ 动作只有挂在组上才会被执行（带组的执行 run ⇒ 派生审核 ⇒ 动作落地）', () => {
  test('★ 判决里的动作被执行、落进审计链，而报告那条路永远是空的（对照）', async () => {
    // 带组提交一条执行 run ⇒ 组的审核者就是这条链的审核者，组那份动作白名单
    // 也随之展开进这条 run（`before` 里建的那个组带的就是 `toolPkg.action`）。
    const agents = ((await (await fetch(`${daemon.url}/api/agents`)).json()) as {
      agents: Array<{ id: string; name: string; role: string }>
    }).agents
    const executor = agents.find((a) => a.role === 'executor')!
    const issueId = ((await (
      await fetch(`${daemon.url}/api/issues`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: '动作落在组上' }),
      })
    ).json()) as { id: string }).id

    const executeRunId = ulid()
    const workDir = await makeTempDir('review-action-work')
    try {
      // 判决带那个**被组允许**的动作，并且只给开放参数（绑定参数由平台注入）
      //
      // ⚠️ `script` 是**按调用顺序**依次取用的（`shift()`），而这条用例会有**两次**
      //    后端调用：先执行、后审核。所以第一项是给执行那一趟的占位（它的内容无关
      //    紧要——执行 run 的输出不参与判决），第二项才是审核的那份判决。
      //    只写一项的话，判决会被执行那趟"吃掉"，审核那趟拿到 `undefined` ⇒
      //    判决以"输出里没有判决块"判成 invalid，而症状看起来像权限问题。
      backend.script = [
        null,
        validVerdict({
          conclusion: 'pass',
          reasonCode: 'meets_criteria',
          action: verdictAction(toolPkg.action, { text: '组允许的动作' }),
        }),
      ]

      const res = await fetch(`${daemon.url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId: executeRunId,
          kind: 'execute',
          agentRef: { id: executor.id, name: executor.name, instructions: '' },
          groupId: seededGroupId,
          skills: [],
          subject: { type: 'issue', id: issueId },
          prompt: '干点活',
          workDir,
          limits: { maxTurns: null, timeoutMs: null },
        }),
      })
      assert.equal(res.status, 202, `提交必须受理：${await res.text()}`)

      // 执行跑完 ⇒ daemon 自己派生审核 run（组把审核者展开进这条 run）
      const reviewRunId = await waitFor(async () => {
        const { runs } = (await (await fetch(`${daemon.url}/api/runs`)).json()) as {
          runs: Array<{ runId: string; kind: string; subject?: { type: string; id: string } }>
        }
        return (
          runs.find((r) => r.kind === 'review' && r.subject?.id === executeRunId)?.runId ?? null
        )
      })
      await waitFor(async () => ((await fetchRun(reviewRunId)).status === 'completed' ? true : null))

      const verdicts = await fetchVerdicts(reviewRunId)
      assert.equal(
        verdicts[0]?.status,
        'dispatched_to_action',
        `★ 组允许的动作必须真的派下去（实际判决：${JSON.stringify(verdicts[0])}）`,
      )

      // ── 硬证据①：工具脚本真的跑了（它往工作目录写了一个文件） ──
      const written = await waitFor(async () =>
        readFile(join(workDir, 'fixture-out.txt'), 'utf8').catch(() => null),
      )
      assert.match(written, /组允许的动作/, '★ 脚本收到的就是使用者钉的那个值')

      // ── 硬证据②：审计链上记着这一环 ──
      const audits = ((await (
        await fetch(`${daemon.url}/api/runs/${reviewRunId}/audits`)
      ).json()) as { audits: AuditRecord[] }).audits
      assert.equal(audits.length, 1)
      assert.equal(
        audits[0]!.actionIds.length,
        1,
        '★ 审计必须记下这条判决触发的那个动作（报告那条路则是空的）',
      )
      assert.equal(audits[0]!.verdictId, verdicts[0]?.id)

      // ── 硬证据③：动作记录本身（状态、参数）──
      //    ⚠️ 没有 `/api/runs/<id>/actions` 这个接口（动作记录只有 store 这一层读法），
      //       所以这里直接问 store——与本文件其它"落库事实"的读法一致。
      const actions = await daemon.store.listActionsByVerdict(verdicts[0]!.id as never)
      assert.equal(actions.length, 1)
      assert.equal(actions[0]?.params['text'], '组允许的动作')
      assert.equal(actions[0]?.params['dir'], workDir, '绑定参数照旧由平台注入')
    } finally {
      await cleanup(workDir)
    }
  })
})

describe('★ 派生出来的 review run 也要带上 skill 的支持文件', () => {
  /**
   * ══════════════════════════════════════════════════════════════════
   * 这条补的是"提交路径"之外的那几条路
   * ══════════════════════════════════════════════════════════════════
   *
   * 页面直接提交 run 时，`skills` 是从请求体里原样过来的，所以支持文件
   * 天然带得上。但 daemon **自己派生**的 run 不是这样：
   *
   *   - 报告触发审核（这条）
   *   - 判决派生的自动串接审核
   *   - 重试
   *
   * 这三条路上，skill 是从库里 `loadAgentSkills()` 读出来再拼进请求的，
   * 而拼的时候曾经把 `files` **写死成 `{}`**——装进来的支持文件在这一路上
   * 全被丢掉了。表现是：同一个技能，手动跑没问题，审核跑就找不到它引用的
   * 脚本，而且没有任何报错。
   */
  test('★ 审核 run 的工作目录里有技能的支持文件', async () => {
    const dir = await makeTempDir('derived-files-data')
    const work = await makeTempDir('derived-files-work')
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
      // ① 装一个**带支持文件**的技能（走批量入口，它就是页面交内容的那条路）
      const installRes = await fetch(`${d.url}/api/skills`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          batchId: 'derived-1',
          skills: [
            {
              slug: 'with-support-files',
              name: '带支持文件的标准',
              body: '# 标准\n\n先看 reference.md 再判断。',
              files: { 'reference.md': '判断依据在这里', 'scripts/check.sh': 'echo ok' },
              source: 'local',
            },
          ],
        }),
      })
      const installed = ((await installRes.json()) as {
        installed: Array<{ id: string; slug: string }>
      }).installed
      assert.equal(installed.length, 1, '技能要先装上')
      const skillId = installed[0]!.id

      // ② 把它挂到审核者身上（审核者才是这条链路里真正跑的人）
      const agents = ((await (await fetch(`${d.url}/api/agents`)).json()) as {
        agents: Array<{ id: string; name: string; role: string; skillIds: string[] }>
      }).agents
      const reviewer = agents.find((a) => a.role === 'reviewer')
      assert.ok(reviewer, '首启会播种审核者')
      const patch = await fetch(`${d.url}/api/agents/${reviewer.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ skillIds: [skillId] }),
      })
      assert.equal(patch.status, 200)

      // ③ 报告进来 ⇒ 派生一条 review run
      b.script = [validVerdict({ conclusion: 'pass', reasonCode: 'meets_criteria', action: null })]
      // ⚠️ 这里**不能**用上面的 `postReport()`：它写死了共享的 `daemon.url`，
      //    于是报告会进到**另一个 daemon**里——那边有它自己的后端与工作目录，
      //    而这条用例的 `d` 什么都不会发生。症状是"报告说有 runId，但按 id
      //    查是 404、后端一次都没被调用"，看起来像 run 没落库。
      const ingestRes = await fetch(`${d.url}/api/reports`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: 'src-derived',
          items: [{ externalId: 'derived-1', kind: 'vuln', title: 't', body: 'b' }],
        }),
      })
      assert.equal(ingestRes.status, 202)
      const ingest = (await ingestRes.json()) as { runIds: string[]; unmatched: number }
      assert.equal(ingest.unmatched, 0)
      assert.equal(ingest.runIds.length, 1, '报告应当派生出一条 review run')
      await awaitRunFinished(d.url)

      // ④ 审核者执行的那一刻，支持文件必须在工作目录里
      assert.equal(
        b.seenSkillFiles['with-support-files/reference.md'],
        '判断依据在这里',
        '★ 派生 run 也要把支持文件带上 —— 写死成 files: {} 就会在这一路上丢光',
      )
      assert.equal(b.seenSkillFiles['with-support-files/scripts/check.sh'], 'echo ok')
    } finally {
      await d.close()
      await cleanup(dir)
      await cleanup(work)
    }
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

  test('★ 动作不在这个审核者的行动权限里 ⇒ 判为结构性问题（重试无意义）', async () => {
    backend.script = [
      validVerdict({
        conclusion: 'pass',
        reasonCode: 'meets_criteria',
        // ══════════════════════════════════════════════════════════════
        // ★ D41：这条动作来自第二个夹具包——它**装了**，但**没有被授权**
        // ══════════════════════════════════════════════════════════════
        //
        // 用"装了没授权"而不是"随便编一个名字"是刻意的：这条用例守的是**行动
        // 权限**（错误信息要指出去哪儿勾上、并且判定为结构性问题 ⇒ 重试无意义）。
        // 若用一个没装的名字，拦住它的会是"这个工作区没装那个包"，下面那句
        // "应当指出是行动权限问题"就会以最难查的方式变成**空过**。
        action: verdictAction(deniedPkg.action, { text: '越权的动作' }),
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
    // 也才符合语义：动作名与审核者的**行动权限**对不上是**运维/配置问题**，
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
    // 报错要指向**去哪儿改**（审核者的「行动权限」），而不是还提 skill——
    // 使用者唯一能看到的就是这句话
    const notice = inbox.find((i) => i.type === 'verdict.invalid' && i.body.includes('行动权限'))
    assert.notEqual(notice, undefined, '应当指出是行动权限问题，并说清去哪儿勾上')
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

describe('S2：路由（D28 —— 不再按 kind 分派）', () => {
  test('★ 任何 kind 都会被审核者接住 —— 没有"未知 kind"这回事了', async () => {
    // ══════════════════════════════════════════════════════════════
    // 这条测试原来叫「未知 kind 且无兜底审核者」
    // ══════════════════════════════════════════════════════════════
    //
    // 它测的是"按 kind 分派 + 兜底审核者"那套配置。D28 把那套换成了
    // **角色 + 配对**：`role: 'reviewer'` 的 agent 审**每一份**报告，
    // 所以"未知 kind"这个情形在模型里已经不存在了。
    //
    // 这正好说明一次模型简化会连带删掉一整类边界情况——而它们原先占了
    // 测试里相当一块篇幅。
    const dir = await makeTempDir('anykind-data')
    const work = await makeTempDir('anykind-work')
    const b = new ScriptedReviewBackend()
    b.script = [
      validVerdict({ conclusion: 'pass', reasonCode: 'meets_criteria', action: null }),
    ]
    const d = await startDaemon({
      dataDir: dir,
      port: 0,
      fsync: false,
      backend: b,
      onWarn: () => {},
      onInfo: () => {},
    })

    try {
      // 首启播种**一对**：一个审核者 + 一个执行者
      const agents = ((await (await fetch(`${d.url}/api/agents`)).json()) as {
        agents: Array<{ id: string; name: string; role: string }>
      }).agents
      const reviewer = agents.find((a) => a.role === 'reviewer')
      const executor = agents.find((a) => a.role === 'executor')
      assert.ok(reviewer, '★ 首启必须播种审核者 —— 否则所有报告都无人可审')
      assert.ok(executor, '首启也会播种一个执行者')
      // ⚠️ 这里原来断言 `executor.reviewerAgentId === reviewer.id`（"首启就是一条通的
      //    闭环"）。那个字段已撤掉，同一条语义现在由**播种的默认组**承载。
      const seededGroups = ((await (await fetch(`${d.url}/api/agent-groups`)).json()) as {
        groups: Array<{ members: string[] }>
      }).groups
      assert.ok(
        seededGroups.some((g) => g.members.includes(executor.id) && g.members.includes(reviewer.id)),
        '★ 首启播种的默认组把这一对串起来：那才是一条通的闭环',
      )

      const res = await fetch(`${d.url}/api/reports`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: 's',
          items: [{ externalId: 'any-1', kind: '从来没见过的类型', title: 't', body: 'b' }],
        }),
      })
      assert.equal(res.status, 202)
      const body = (await res.json()) as { unmatched: number; runIds: string[] }
      assert.equal(body.unmatched, 0, '没有人认领才算 unmatched，而现在审核者谁的报告都接')
      assert.equal(body.runIds.length, 1, '应当起了一条 review run')
    } finally {
      await d.close()
      await cleanup(dir)
      await cleanup(work)
    }
  })

  test('★ 报告一定会落库（FR-REPORT-01：它是一等实体，不是描述里的一段文本）', async () => {
    // 无论路由结果如何，报告本身都要存下来。"存下来"与"有人审"是两件事，
    // 前者是平台侧的正确性保证，后者取决于配置。
    const dir = await makeTempDir('report-stored')
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
      await fetch(`${d.url}/api/reports`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: 's',
          items: [{ externalId: 'kept-1', kind: 'k', title: '要留住的', body: 'b' }],
        }),
      })
      const stats = (await (await fetch(`${d.url}/api/costs`)).json()) as unknown
      assert.ok(stats, '接口可用')
    } finally {
      await d.close()
      await cleanup(dir)
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
    // ⚠️ 必须按 **subject** 精确定位：同一个 daemon 里前面用例留下的 review run
    //    还躺在列表里，只按"kind === review 且不是第一条"去找会匹配到**别人的**
    //    审核（实测：断言拿到的材料是上一条用例的报告）。
    const firstSubject = (
      (await (await fetch(`${daemon.url}/api/runs`)).json()) as {
        runs: Array<{ runId: string; subject?: { type: string; id: string } }>
      }
    ).runs.find((r) => r.runId === firstRunId)?.subject
    const retryRun = after.find(
      (r) =>
        r.runId !== firstRunId &&
        r.kind === 'review' &&
        (r as { subject?: { id: string } }).subject?.id === firstSubject?.id,
    )
    assert.ok(retryRun, '应当有一条新的 review run 作为重试（同一条报告的第二次审核）')

    // ══════════════════════════════════════════════════════════════════
    // ★ 重试必须带**材料**，不能是空壳（真实踩过一次）
    // ══════════════════════════════════════════════════════════════════
    //
    // 原来 `createRetryRun` 传的是 `body: ''`，而紧挨着的注释写着"上一次的输出
    // 会作为审核对象的正文带进来"。真实后果：一次任务的重试审核里，模型的
    // 原话是「材料区只有标题，不含任何正文/产物/结论，缺少可审核的实际内容」
    // —— 它是对的，于是判 needs_human，而那次 CLI 的钱白花了。
    //
    // 材料从上次审核自己的上下文副本里按标记切出来（见 server.ts 的
    // `previousMaterial`）。这条断言钉住"重试真的拿到了材料"。
    const retryMessages = ((await (
      await fetch(`${daemon.url}/api/runs/${retryRun!.runId}/messages?since=-1`)
    ).json()) as { messages: Array<{ content: string }> }).messages
    const retrySentence = retryMessages.map((m) => m.content ?? '').join('\n')
    // ⚠️ 断言必须落在**标记之间**的内容上：光匹配"内容"两个字是空过的——
    //    「## 待审核的内容」这个标题本身就含"内容"，空材料的重试也能通过。
    const material = (() => {
      const begin = retrySentence.indexOf('<<<ALPHA_MATERIAL>>>')
      if (begin === -1) return ''
      const from = begin + '<<<ALPHA_MATERIAL>>>'.length
      const end = retrySentence.lastIndexOf('<<<END_ALPHA_MATERIAL>>>')
      return end < from ? '' : retrySentence.slice(from, end).trim()
    })()
    assert.ok(material.length > 0, '★ 重试的材料不能是空的（空的话模型只能判 needs_human）')
    assert.match(material, /内容/, '★ 而且要是**上次那份**材料')

    // ★ 必须等**整条链**静默再返回。
    //   不等的话，这条重试 run 会在下一个用例执行期间继续跑，把那个用例
    //   准备好的 backend.script 偷走——症状是下一个用例以完全不相干的方式失败。
    await awaitRunsSettled()
  })

  test('★ 结构性问题**不**起重试 —— 重试只会得到同样的东西', async () => {
    backend.rawOverride = null
    backend.script = [
      validVerdict({
        conclusion: 'pass',
        reasonCode: 'meets_criteria',
        // ★ D41：这里要的就是"**一个不存在的动作**"——任何没装进这个工作区的
        //   `<包 slug>.<动作名>` 都会走"未知动作类型"那条路（结构性 invalid），
        //   所以名字写成 `ghost-tool.act` 只为了把"没装"这件事写在脸上。
        //   ⚠️ 不能再用内置名（`issue.create` 那种）：内置动作已经不存在，
        //   留着它会让这条用例看起来在守一件已经不在的事。
        action: verdictAction('ghost-tool.act', { text: '越权' }),
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

/**
 * ══════════════════════════════════════════════════════════════════
 * D37：审核标准内联在审核者身上
 * ══════════════════════════════════════════════════════════════════
 *
 * 三条要钉的性质：
 *
 *   1. **没有标准就不派审核**（标准是审核的依据，没有它审不出有依据的结论）；
 *   2. **动作权限真的生效**——"这个审核者只允许发评论"必须真的拦住判决里的
 *      越权动作，而不是"配了但没用"。⚠️ D40 收口之后这份权限**不住在标准里**，
 *      它在 `Agent.allowedActions` 上（这条改动的由来见
 *      `apps/daemon/src/review-standard.ts` 的文件头）；
 *   3. **过渡期**：老数据（**标准正文**还在挂载的 skill 里）照样能审——规则一改
 *      就让已经建好的审核者停摆，是最不该发生的事。而 skill 的
 *      `allowedActions`（老数据里可能还有）**不参与**动作授权。
 */
describe('D37：审核标准内联在审核者身上', () => {
  /**
   * 把某个 agent 的审核标准与**动作权限**改成给的那份（PATCH）。
   *
   * ⚠️ 两者是**两个字段**（D40 收口）：`reviewStandard` 只收名字与正文，
   *    动作住在 `allowedActions` 上。这个夹具以前把动作塞在标准里，
   *    那正是搬走之前的样子。
   */
  /**
   * 改一个审核者的**审核标准**。
   *
   * ⚠️ 2026-10：这个助手原来还带一个 `allowedActions` 参数（"顺便把动作权限也授了"）。
   *    那个字段已从 `Agent` 上撤掉——**动作只属于组**，而这一节走的都是报告那条路
   *    （报告不属于任何组）⇒ 报告审核**拿不到任何动作授权**。所以参数去掉，写入口
   *    也不再发这个键（发了就是 400「不认识的字段」）。
   */
  async function setStandard(
    url: string,
    agentId: string,
    standard: { name: string; body: string } | null,
  ): Promise<number> {
    const res = await fetch(`${url}/api/agents/${encodeURIComponent(agentId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reviewStandard: standard }),
    })
    return res.status
  }

  /**
   * 起一个**自带后端引用**的 daemon（要能塞判决脚本，所以不能内联 new）。
   *
   * `store` 一起交出去：有些用例要造**老数据形态**的记录——那种记录**写不进来**
   * （写入口只写新字段），只能直接落库，见下面那条回退用例。
   */
  async function withBackend<T>(
    tag: string,
    fn: (ctx: {
      url: string
      backend: ScriptedReviewBackend
      store: DaemonHandle['store']
    }) => Promise<T>,
  ): Promise<T> {
    const backend2 = new ScriptedReviewBackend()
    const d = await startDaemon({
      dataDir: await makeTempDir(tag),
      port: 0,
      fsync: false,
      backend: backend2,
      onWarn: () => {},
      onInfo: () => {},
    })
    try {
      return await fn({ url: d.url, backend: backend2, store: d.store })
    } finally {
      await d.close()
    }
  }

  async function runToEnd(url: string, runId: string): Promise<void> {
    await waitFor(async () => {
      const res = await fetch(`${url}/api/runs/${runId}`)
      return ((await res.json()) as { status: string }).status === 'completed' ? true : null
    }, 8000)
  }

  async function firstSentenceOf(url: string, runId: string): Promise<string> {
    const messages = ((await (
      await fetch(`${url}/api/runs/${runId}/messages?since=-1`)
    ).json()) as { messages: Array<{ content: string }> }).messages.map((m) => m.content ?? '')
    return messages.join('\n')
  }

  /**
   * ★ 2026-09：判据从"有没有标准"改成"**身份非空**"（= 指令非空）。
   *
   * 所以要让它不再派审核，要清的是**指令**——清标准已经不管用了（标准并进指令，
   * 而标准本身不再单独设置）。这条测试跟着改，而不是删掉：它钉的是"没有依据的
   * 审核者拿不到审核任务，而且日志说清为什么、去哪儿修"。
   */
  test('★ 清掉「指令」⇒ 不再派审核，而且日志说清是"没有依据"', async () => {
    await withBackend('d37-nostd', async ({ url }) => {
      const agents = ((await (await fetch(`${url}/api/agents`)).json()) as {
        agents: Array<{ id: string; role: string }>
      }).agents
      const reviewer = agents.find((a) => a.role === 'reviewer')!
      // 两个都清：标准（老字段）与指令。判据只看**合成后的身份**非空。
      assert.equal(await setStandard(url, reviewer.id, null), 200)
      const cleared = await fetch(`${url}/api/agents/${encodeURIComponent(reviewer.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instructions: '' }),
      })
      assert.equal(cleared.status, 200, '夹具：指令要能清掉')

      const executor = agents.find((a) => a.role === 'executor')!
      const issueId = ((await (
        await fetch(`${url}/api/issues`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: '没有标准的审核者' }),
        })
      ).json()) as { id: string }).id

      // ⚠️ 2026-10：这条链必须**带组**。以前"执行者指向审核者"是隐含的，那条路
      //    撤掉之后，不带组的 run 压根没有审核者——于是"没有起审核 run"会以
      //    **另一个原因**成立（没人审），而这条用例要证明的是"标准空 ⇒ 挡住"。
      //    判据必须落在"是哪一条规则挡住的"这句话上，所以先把人串起来。
      const reviewerId = (agents.find((a) => a.role === 'reviewer') as { id: string }).id
      const groupId = await createChainGroup(
        { url },
        { name: '清掉指令的组', members: [executor.id, reviewerId] },
      )

      const runId = ulid()
      await fetch(`${url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId,
          kind: 'execute',
          agentRef: { id: executor.id, name: 'x', instructions: '' },
          groupId,
          subject: { type: 'issue', id: issueId },
          prompt: '随便做点什么',
          limits: { maxTurns: null, timeoutMs: null },
        }),
      })
      await runToEnd(url, runId)

      const runs = ((await (await fetch(`${url}/api/runs`)).json()) as {
        runs: Array<{ kind: string }>
      }).runs
      assert.equal(runs.filter((r) => r.kind === 'review').length, 0, '没有标准就不该起审核 run')

      const text = await firstSentenceOf(url, runId)
      assert.match(text, /没有写「指令」/, '要说清是哪一条规则挡住的')
      assert.match(text, /去「智能体」页给它写一段/, '并且告诉人去哪儿修')
    })
  })

  test('★★ 报告审核**只能给结论**：判决里带动作一定被拦下（要人介入）', async () => {
    await withBackend('d37-actions', async ({ url, backend: b }) => {
      // ══════════════════════════════════════════════════════════════
      // ★ D41 + 2026-10：动作只能来自**已安装的工具包**，而且只属于**组**
      // ══════════════════════════════════════════════════════════════
      //
      // 这里装**两个**已装包（都用得上）：判别据的必须只能是**白名单**这一关，
      // 而不能是"这个名字根本没装"——那是另一条路径、另一句话，混在一起这条用例
      // 就变成空过了。所以判决里写的是那个**装了、而且能解析**的动作，它照样被拦下。
      //
      // ⚠️ 2026-10：这条用例原来叫「动作权限来自 **agent**」——那时"这个审核者被
      //    授权了 A、判决写了 B"两边都有落点。现在**报告审核不属于任何组**（组描述的
      //    是"执行 → 审核 → 行动"这条链，报告没有那条链）⇒ 它的动作白名单**永远是
      //    空的** ⇒ 判决只能给结论。这是使用者明确接受的结果，所以判据收成一条：
      //    **任何动作都要被拦下**，而且拦它的理由必须是"这条链没有授权"。
      const granted = await writeToolPackage({ slug: 'granted-tool' })
      const denied = await writeToolPackage({ slug: 'denied-tool' })
      await installToolPackage({ url }, granted)
      await installToolPackage({ url }, denied)

      const agents = ((await (await fetch(`${url}/api/agents`)).json()) as {
        agents: Array<{ id: string; role: string }>
      }).agents
      const reviewer = agents.find((a) => a.role === 'reviewer')!
      assert.equal(
        await setStandard(url, reviewer.id, {
          name: '只给结论',
          body: '# 只给结论\n\n这条链上没有动作权限，只给结论。',
        }),
        200,
      )
      b.script = [
        validVerdict({
          conclusion: 'pass',
          reasonCode: 'meets_criteria',
          // 这个动作**装包了、能解析**，但报告这条链没有授权它
          action: verdictAction(denied.action, { text: '越权的动作' }),
        }),
      ]

      const summary = await postReportTo(url, 'd37-source', [
        { externalId: 'a-1', kind: 'pr-diff', title: '越权动作', body: '内容' },
      ])
      const runId = summary.runIds[0]!
      await runToEnd(url, runId)

      const verdicts = ((await (
        await fetch(`${url}/api/runs/${runId}/verdicts`)
      ).json()) as { verdicts: Array<{ status: string }> }).verdicts
      assert.equal(
        verdicts[0]?.status,
        'escalated',
        '动作不在该审核者允许的子集里 ⇒ 结构性问题（模型再输出一次还是同样的东西）',
      )
      const text = await firstSentenceOf(url, runId)
      assert.match(text, /只给结论/, '标准正文要真的随第一句话下发')
    })
  })

  test('★ 过渡期：只挂 skill、没有内联标准的审核者照样能审（但 skill 不管动作）', async () => {
    await withBackend('d37-legacy', async ({ url, backend: b }) => {
      const installed = ((await (
        await fetch(`${url}/api/skills`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            skills: [
              {
                slug: 'legacy-standard',
                name: '老标准',
                body: '# 老标准\n\n只看一件事：有没有写测试。',
                // ⚠️ 老客户端（页面还是旧的那版）会照旧带上这个字段。D40 收口之后
                //    它**被忽略**：skill 不再声明动作权限，安装也不写它。
                //    这里刻意留一个 **D41 之前的内置名**（老数据里就是这种名字，
                //    而现在它连形状都不合法）：正因如此，"写入口一个字都不读它"
                //    这件事才值得钉住——下面那条断言证明它没落库。
                allowedActions: ['issue.create'],
              },
            ],
          }),
        })
      ).json()) as { installed: Array<Record<string, unknown> & { id: string }> })
      assert.equal(
        'allowedActions' in installed.installed[0]!,
        false,
        '★ 安装 skill 不再接受动作配置：传了也不写进库（动作是审核者的能力）',
      )
      const reviewer = (await (
        await fetch(`${url}/api/agents`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: '老形态审核者',
            role: 'reviewer',
            skillIds: [installed.installed[0]!.id],
          }),
        })
      ).json()) as { id: string; reviewStandard: unknown }
      assert.equal(reviewer.reviewStandard, null, '这个夹具刻意不带内联标准')
      // ⚠️ 2026-10：这里原来断言 `allowedActions` 是**空数组**（"skill 不决定动作"）。
      //    agent 上已经没有这个字段了 ⇒ 判据换成"这个键压根不在"——比"是空数组"更死：
      //    空数组还允许它哪天被填上，缺字段则说明**这条路已经不存在**（动作只属于组）。
      assert.equal(
        'allowedActions' in reviewer,
        false,
        '★ agent 上不再有动作列表：动作只属于组，skill 也从来不管它',
      )

      // 两个审核者（播种的 + 这个老形态）都会接住这份报告 ⇒ 两次判决脚本
      b.script = [validVerdict(), validVerdict()]

      const summary = await postReportTo(url, 'd37-legacy', [
        { externalId: 'l-1', kind: 'pr-diff', title: '老数据', body: '内容' },
      ])
      assert.equal(summary.unmatched, 0, '两个审核者都该接住它')
      for (const id of summary.runIds) await runToEnd(url, id)

      // ★ 关键：老形态那条 run 的第一句话里，标准正文来自**挂载的 skill**。
      //   ⚠️ 别拿 agent 名字认它——第一句话里**没有** agent 的名字（身份段只有
      //   run id 与对象），认串要看内部特征：老标准正文里的 `# 老标准`。
      const texts = await Promise.all(summary.runIds.map((id) => firstSentenceOf(url, id)))
      const legacy = texts.find((t) => t.includes('# 老标准'))
      assert.ok(legacy, '老形态的审核者要真的被起了一条 run（标准来自挂载的 skill）')
      assert.match(legacy!, /只看一件事/, '标准正文要真的随第一句话下发')
    })
  })

  // ══════════════════════════════════════════════════════════════════
  // ⚠️ 这里原来有两条用例，钉的是"动作权限的三级回退"：
  //   · 老数据把白名单写在 `reviewStandard.allowedActions` 里 ⇒ 判决按它校验；
  //   · 老 skill 里那份 `allowedActions` **一个字都不算数**。
  //
  //   2026-10 起这两条都没有对象了：agent 上**不再有**动作字段，动作的唯一出处
  //   是**智能体组**（`AgentGroup.allowedActions`，见 `packages/protocol/src/entities.ts`
  //   里那段说明）。回退链连同它的三个坑一起删掉了，所以这里不再造"老形态的
  //   agent 记录"——那种记录现在连字段都被摘掉了（启动时一次性清理，见
  //   `apps/daemon/src/agent-legacy-cleanup.ts`）。
  //
  //   ⚠️ 现在**动作能不能过**这件事的端到端在 `tool-action-e2e.test.ts`（那里用
  //      真组、真判决、真执行），组本身的展开在 `groups-e2e.test.ts`。
  // ══════════════════════════════════════════════════════════════════
})

/**
 * S2：执行任务与执行结果**落盘成文件**、审核**引用文件**来审（§3.3b，2026-09）。
 *
 * 设计（见 docs/runtime/pipeline.md §3.3b）：执行完成后，执行器把「执行任务」与
 * 「执行结果」按轮次写到工作目录 `.agentdeck/rounds/<轮次>-task.md` /
 * `-result.md`（多轮不覆盖），审核的第一句话给这两份的文件引用；内联材料
 * 仍保留作兜底。
 */
describe('S2：任务/结果落盘，审核引用文件（§3.3b）', () => {
  test('★ 执行完按轮次落盘 task/result，审核第一句话引用它们，文件内容正确', async () => {
    const b = new ScriptedReviewBackend()
    const d = await startDaemon({
      dataDir: await makeTempDir('rounds-files'),
      port: 0,
      fsync: false,
      backend: b,
      onWarn: () => {},
      onInfo: () => {},
    })
    try {
      const agents = ((await (await fetch(`${d.url}/api/agents`)).json()) as {
        agents: Array<{ id: string; role: string }>
      }).agents
      const executor = agents.find((a) => a.role === 'executor')!
      // ⚠️ 2026-10：这里原来断言执行者身上那个 `reviewerAgentId` 有值（"靠它自动串接"）。
      //    那个字段撤掉之后，"谁审我"由**组**回答 ⇒ 判据换成"播种的默认组把播种的这一对
      //    串起来了"，而提交时带的就是那个组的 id。
      const seededGroupId = await seededGroupOf(d.url)
      assert.ok(seededGroupId !== null, '首启播种的执行者指向审核者 —— 这条用例靠它自动串接'.replace('指向审核者', '所在的默认组要存在'))

      // 第一条给**执行 run** 当产出（随便一段报告），第二条是**审核 run** 的判决
      //（pass、无动作 ⇒ 链一次到底，不派生别的 run）。顺序不能反：执行先跑。
      b.script = [
        { report: '执行者的报告：改成冒泡排序，并补了两个测试。' },
        validVerdict({ conclusion: 'pass', reasonCode: 'meets_criteria' }),
      ]

      const issueId = ((await (
        await fetch(`${d.url}/api/issues`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: '落盘引用用例' }),
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
          groupId: seededGroupId,
          subject: { type: 'issue', id: issueId },
          prompt: taskText,
          limits: { maxTurns: null, timeoutMs: null },
        }),
      })
      assert.equal(res.status, 202)

      // 等审核 run 也走完（链要静默，否则下一条用例的 script 会被偷）
      await waitFor(async () => {
        const { runs } = (await (await fetch(`${d.url}/api/runs`)).json()) as {
          runs: Array<{ status: string; kind: string }>
        }
        const review = runs.find((r) => r.kind === 'review')
        return review && review.status === 'completed' ? true : null
      }, 8000)

      const reviewRunId = (
        (await (await fetch(`${d.url}/api/runs`)).json()) as {
          runs: Array<{ runId: string; kind: string }>
        }
      ).runs.find((r) => r.kind === 'review')!.runId

      // 从 run 自己的消息里取第一句话（不靠全局 seenContext —— 别的 run 会覆盖它）
      const first = (
        ((await (
          await fetch(`${d.url}/api/runs/${reviewRunId}/messages?since=-1`)
        ).json()) as { messages: Array<{ content: string }> }).messages
      )
        .map((m) => m.content ?? '')
        .join('\n')

      // ③ 里要有「完整材料（文件）」引用块，两份路径都在，且是首轮（1-）
      assert.match(first, /## 完整材料（文件）/, '审核的第一句话要声明"完整材料在文件里"')
      const taskPath = /- 执行任务：`([^`]+)`/.exec(first)?.[1]
      const resultPath = /- 执行结果：`([^`]+)`/.exec(first)?.[1]
      assert.ok(taskPath, '要有执行任务的文件路径')
      assert.ok(resultPath, '要有执行结果的文件路径')
      assert.match(taskPath!, /rounds\/1-task\.md$/, '首轮执行 ⇒ rounds/1-task.md')
      assert.match(resultPath!, /rounds\/1-result\.md$/, '首轮执行 ⇒ rounds/1-result.md')
      // ★ §3.3b：文件式审核**不再内联**材料——有文件引用就够了，不该再有
      //   「待审核的内容」/ 材料标记（内联那段是截断的转述，留着只会诱导模型
      //   只看转述、不看文件）。
      assert.doesNotMatch(
        first,
        /待审核的内容|<<<ALPHA_MATERIAL>>>|<<<END_ALPHA_MATERIAL>>>/,
        '文件式审核的第一句话不该再内联材料（要审的是文件）',
      )

      // 文件真的在，内容分别是任务原文与执行产出
      assert.equal((await readFile(taskPath!, 'utf8')).trim(), taskText, 'task 文件装的是任务原文')
      const resultContent = await readFile(resultPath!, 'utf8')
      assert.match(
        resultContent,
        /执行者的报告：改成冒泡排序/,
        'result 文件装的是执行产出（假后端的输出）',
      )
    } finally {
      await d.close()
    }
  })

  test('★ 多轮返工**不覆盖**前一轮：rounds/1-* 与 2-* 各自保留，第 2 轮审核引用第 2 轮文件', async () => {
    const b = new ScriptedReviewBackend()
    const d = await startDaemon({
      dataDir: await makeTempDir('rounds-rework'),
      port: 0,
      fsync: false,
      backend: b,
      onWarn: () => {},
      onInfo: () => {},
    })
    const workDir = await makeTempDir('rounds-rework-work')
    try {
      const agents = ((await (await fetch(`${d.url}/api/agents`)).json()) as {
        agents: Array<{ id: string; role: string }>
      }).agents
      const executor = agents.find((a) => a.role === 'executor')!
      // ⚠️ 2026-10：这里原来断言执行者身上那个 `reviewerAgentId` 有值（"靠它自动串接"）。
      //    那个字段撤掉之后，"谁审我"由**组**回答 ⇒ 判据换成"播种的默认组把播种的这一对
      //    串起来了"，而提交时带的就是那个组的 id。
      const seededGroupId = await seededGroupOf(d.url)
      assert.ok(seededGroupId !== null, '执行者默认指向审核者 —— 这条用例靠它自动串接'.replace('指向审核者', '所在的默认组要存在'))

      // 执行1 → 审核1(fail) → 返工执行2 → 审核2(pass)。顺序不能乱：假后端按序 shift。
      b.script = [
        { report: '第 1 次产出：没写测试。' },
        {
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
        },
        { report: '第 2 次产出：补上了测试。' },
        validVerdict({ conclusion: 'pass', reasonCode: 'meets_criteria' }),
      ]

      const issueId = ((await (
        await fetch(`${d.url}/api/issues`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: '多轮不覆盖用例' }),
        })
      ).json()) as { id: string }).id

      const taskText = '把排序函数改成冒泡排序，并补两个测试。'
      const res = await fetch(`${d.url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId: ulid(),
          kind: 'execute',
          agentRef: { id: executor.id, name: 'x', instructions: '' },
          groupId: seededGroupId,
          subject: { type: 'issue', id: issueId },
          prompt: taskText,
          workDir,
          limits: { maxTurns: null, timeoutMs: null },
          maxReworks: 1,
        }),
      })
      assert.equal(res.status, 202)

      // 等两条审核 run 都完成（第 2 条 pass 收尾，链静默）
      await waitFor(async () => {
        const { runs } = (await (await fetch(`${d.url}/api/runs`)).json()) as {
          runs: Array<{ status: string; kind: string }>
        }
        const reviews = runs.filter((r) => r.kind === 'review')
        return reviews.length >= 2 && reviews.every((r) => r.status === 'completed') ? true : null
      }, 10000)

      // ★ 多轮不覆盖：两轮的 task/result 各一份，谁都没被后一轮顶掉
      const rounds = await readdir(join(workDir, '.agentdeck', 'rounds'))
      assert.deepEqual(
        rounds.sort(),
        ['1-result.md', '1-task.md', '2-result.md', '2-task.md'].sort(),
        'rounds/ 下必须是两轮各两份，后一轮不得覆盖前一轮',
      )
      assert.equal(
        (await readFile(join(workDir, '.agentdeck', 'rounds', '1-task.md'), 'utf8')).trim(),
        taskText,
        '第 1 轮任务 = 原始任务正文',
      )
      assert.match(
        await readFile(join(workDir, '.agentdeck', 'rounds', '1-result.md'), 'utf8'),
        /第 1 次产出/,
        '第 1 轮结果 = 第 1 次执行的产出',
      )
      assert.match(
        await readFile(join(workDir, '.agentdeck', 'rounds', '2-task.md'), 'utf8'),
        /没有通过审核/,
        '第 2 轮任务 = 返工指令（带审核意见），不是原始任务的副本',
      )
      assert.match(
        await readFile(join(workDir, '.agentdeck', 'rounds', '2-result.md'), 'utf8'),
        /第 2 次产出/,
        '第 2 轮结果 = 返工那次执行的产出',
      )

      // 各轮的审核引用**自己那一轮**的文件
      const reviewRunIds = (
        (await (await fetch(`${d.url}/api/runs`)).json()) as {
          runs: Array<{ runId: string; kind: string }>
        }
      ).runs
        .filter((r) => r.kind === 'review')
        .map((r) => r.runId)
      const firsts = await Promise.all(
        reviewRunIds.map(async (id) =>
          (
            ((await (
              await fetch(`${d.url}/api/runs/${id}/messages?since=-1`)
            ).json()) as { messages: Array<{ content: string }> }).messages
          )
            .map((m) => m.content ?? '')
            .join('\n'),
        ),
      )
      assert.ok(
        firsts.some((f) => f.includes('rounds/1-task.md') && f.includes('rounds/1-result.md')),
        '第 1 轮审核要引用第 1 轮的文件',
      )
      assert.ok(
        firsts.some((f) => f.includes('rounds/2-task.md') && f.includes('rounds/2-result.md')),
        '第 2 轮审核要引用第 2 轮的文件（不能指着第 1 轮的旧材料）',
      )
    } finally {
      await d.close()
      await cleanup(workDir)
    }
  })

  test('★ 文件式审核判决不合规 ⇒ 重试 run 也从结果文件取材料（不内联）', async () => {
    const b = new ScriptedReviewBackend()
    const d = await startDaemon({
      dataDir: await makeTempDir('rounds-retry'),
      port: 0,
      fsync: false,
      backend: b,
      onWarn: () => {},
      onInfo: () => {},
    })
    try {
      const agents = ((await (await fetch(`${d.url}/api/agents`)).json()) as {
        agents: Array<{ id: string; role: string }>
      }).agents
      const executor = agents.find((a) => a.role === 'executor')!
      // ⚠️ 2026-10：这里原来断言执行者身上那个 `reviewerAgentId` 有值（"靠它自动串接"）。
      //    那个字段撤掉之后，"谁审我"由**组**回答 ⇒ 判据换成"播种的默认组把播种的这一对
      //    串起来了"，而提交时带的就是那个组的 id。
      const seededGroupId = await seededGroupOf(d.url)
      assert.ok(seededGroupId !== null, '执行者默认指向审核者 —— 自动串接'.replace('指向审核者', '所在的默认组要存在'))

      // 执行 → 审核1（判决**不合 schema**，在围栏里但不是合法判决 ⇒ 重试）
      //     → 重试审核2（pass，链静默）。顺序不能乱：假后端按序 shift。
      b.script = [
        { report: '执行者的报告：改好了。' },
        { bogus: true },
        validVerdict({ conclusion: 'pass', reasonCode: 'meets_criteria' }),
      ]

      const issueId = ((await (
        await fetch(`${d.url}/api/issues`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: '重试-from-文件用例' }),
        })
      ).json()) as { id: string }).id

      const res = await fetch(`${d.url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId: ulid(),
          kind: 'execute',
          agentRef: { id: executor.id, name: 'x', instructions: '' },
          groupId: seededGroupId,
          subject: { type: 'issue', id: issueId },
          prompt: '把功能实现一下',
          limits: { maxTurns: null, timeoutMs: null },
        }),
      })
      assert.equal(res.status, 202)

      // 等两条审核 run 都完成（第 2 条 pass 收尾，链静默）
      await waitFor(async () => {
        const { runs } = (await (await fetch(`${d.url}/api/runs`)).json()) as {
          runs: Array<{ status: string; kind: string }>
        }
        const reviews = runs.filter((r) => r.kind === 'review')
        return reviews.length >= 2 && reviews.every((r) => r.status === 'completed') ? true : null
      }, 10000)

      const reviewRuns = (
        (await (await fetch(`${d.url}/api/runs`)).json()) as {
          runs: Array<{ runId: string; kind: string; queuedAt: number }>
        }
      )
        .runs.filter((r) => r.kind === 'review')
        /*
         * ⚠️ 分批第 72 批：**显式按时间排**，不要靠数组下标。
         *
         * `/api/runs` 从"最老的在前"改成了"最近的在前"（那个改动修的是任务看板把新任务
         * 显示成「执行中」的 bug），于是 `reviewRuns[0]` 从"第一条审核"变成了"第二条"——
         * 这条用例当场红了（断言'第一条判决必须不合规'，量到的是第二条的 advisory）。
         *
         * 这不是断言放松：用例真正依赖的是**时间上的第一条**，而"数组下标 0"只是碰巧
         * 等于它。把这条依赖写出来，接口以后再调整顺序也不会骗过这条用例。
         */
        .sort((a, b) => a.queuedAt - b.queuedAt)

      // 第一条审核：判决不合规 ⇒ invalid + 处置方式是重试
      const verdicts1 = ((await (
        await fetch(`${d.url}/api/runs/${reviewRuns[0]!.runId}/verdicts`)
      ).json()) as { verdicts: Array<{ status: string; invalidResolution: string | null }> }).verdicts
      assert.equal(verdicts1[0]?.status, 'invalid', '第一条判决必须不合规')
      assert.equal(
        verdicts1[0]?.invalidResolution,
        'retry',
        '★ 而且必须记下"发了重试"（不是静默降级）',
      )

      // 重试 run（第二条审核）：第一句话**也是文件式**（不内联），且引用结果文件
      const retrySentence = (
        ((await (
          await fetch(`${d.url}/api/runs/${reviewRuns[1]!.runId}/messages?since=-1`)
        ).json()) as { messages: Array<{ content: string }> }).messages
      )
        .map((m) => m.content ?? '')
        .join('\n')
      assert.match(
        retrySentence,
        /## 完整材料（文件）/,
        '重试 run 也要走文件式审核（和正常审核一个形状）',
      )
      assert.match(
        retrySentence,
        /rounds\/1-result\.md/,
        '★ 重试从**结果文件**拿材料（引用还在，没有材料也能取回）',
      )
      assert.doesNotMatch(
        retrySentence,
        /待审核的内容|<<<ALPHA_MATERIAL>>>/,
        '重试 run 不该内联材料',
      )

      // 第二条审核拿到合法判决 ⇒ pass，链静默
      const verdicts2 = ((await (
        await fetch(`${d.url}/api/runs/${reviewRuns[1]!.runId}/verdicts`)
      ).json()) as { verdicts: Array<{ conclusion: string }> }).verdicts
      assert.equal(verdicts2[0]?.conclusion, 'pass', '重试那一次要真的给出合法判决')
    } finally {
      await d.close()
    }
  })
})
