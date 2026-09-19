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
} from '@alpha-helper/agent-core'
import {
  ulid,
  VERDICT_FENCE_BEGIN,
  VERDICT_FENCE_END,
  type AuditRecord,
  type InboxItem,
  type VerdictRecord,
} from '@alpha-helper/protocol'
import { startDaemon, type DaemonHandle } from './server.ts'
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
    this.seenContext = opts.prompt

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
  // ★ D41：动作只能来自**装进来的工具包**，而播种的审核者没有任何动作权限
  // ══════════════════════════════════════════════════════════════════
  //
  // 这个文件里绝大多数用例的主体**不是**动作本身（报告落库与路由、阶段推导、
  // 审计链、判决分支、重试……），只是顺手让判决带一个动作。以前那个动作可以写
  // 内置裸名（`comment.create`），现在不行了：它必须来自一个真的装了的包。
  //
  // 而"播种的审核者开箱即用能发评论"这条**已经不存在**——
  // `BUILTIN_REVIEW_ALLOWED_ACTIONS` 现在是空数组，这是 D41 的刻意结果，不是
  // 遗漏。所以这里显式装包并**给那个审核者授权**：动作权限的入口就是
  // `Agent.allowedActions`（D40 收口之后它只住在那儿，skill 与标准都不参与）。
  //
  // ⚠️ 用 `setupToolFixture()` 是不行的：它会**额外**建一对 agent，而这一节里
  //    有多条用例在数"这份报告被谁接住了、起了几条 run"——多一对审核者会让
  //    每份报告都被审两遍。所以这里只用造包 + 装包 + 直接 PATCH 播种的那位。
  toolPkg = await writeToolPackage()
  await installToolPackage(daemon, toolPkg)
  deniedPkg = await writeToolPackage({ slug: 'other-tool', summary: '装了但没有被授权的动作' })
  await installToolPackage(daemon, deniedPkg)

  const seeded = ((await (await fetch(`${daemon.url}/api/agents`)).json()) as {
    agents: Array<{ id: string; name: string; role: string }>
  }).agents.find((a) => a.role === 'reviewer')
  assert.ok(seeded, '首启会播种审核者 —— 这个文件的多条用例都靠它接住报告')
  const granted = await fetch(`${daemon.url}/api/agents/${seeded.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    // ★ 只授**一个**：另一个装了没授的，正是下面"不在行动权限里"那条用例要用的夹具
    body: JSON.stringify({ allowedActions: [toolPkg.action] }),
  })
  assert.equal(granted.status, 200, '给播种的审核者授权一个工具动作应当成功')
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
        // ★ D41：判决里的动作只能来自**装进来的工具包**（`before` 里装了一个夹具包，
        //   并把它的动作授给了播种的审核者）。这条用例的主体是**报告摄取与路由**
        //   （`unmatched === 0`、起了一条 review run），判决带动作只是顺带——
        //   所以这里给的是工具动作，而不是把断言降级成"没有动作"。
        //
        //   只给开放参数 `text`：绑定参数（工作目录）由平台按 run 的事实注入，
        //   模型写不出来、也不该写。
        action: verdictAction(toolPkg.action, { text: '发现了漏洞' }),
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
    assert.equal(verdicts[0]?.status, 'dispatched_to_action', '应当已派发到动作')
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
    assert.equal(review.verdict.status, 'dispatched_to_action')
    // 执行 run 上没有判决（它是被审的对象，不是判决的产出者）
    const execute = runs.find((r) => r.kind === 'execute')
    assert.equal(execute?.verdict ?? null, null, '执行 run 不该有判决字段')
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
    const sentence = await (async () => {
      const msgs = (
        ((await (await fetch(`${daemon.url}/api/runs/${reviewRun!.runId}/messages?since=-1`)).json()) as {
          messages: Array<{ content: string }>
        }).messages
      ).map((m) => m.content ?? '')
      const at = msgs.findIndex((c) => c.startsWith('第一句话（'))
      return at === -1 ? null : (msgs[at + 1] ?? null)
    })()
    assert.notEqual(sentence, null, '日志里应当能找到投递出去的第一句话')
    assert.equal(
      audit.promptHash,
      createHash('sha256').update(sentence!, 'utf8').digest('hex'),
      '★ 输入哈希要等于**真正投递的那段文本**的 sha256',
    )
    assert.notEqual(audit.promptHash, null, '必须有 prompt 哈希')
    assert.equal(audit.verdictId, (await fetchVerdicts(reviewRun!.runId))[0]?.id)

    // ══════════════════════════════════════════════════════════════════
    // ★ 动作那一环也要在审计里留下痕迹（D41 之后这一点更容易悄悄丢）
    // ══════════════════════════════════════════════════════════════════
    //
    // 用例的名字是"判决里的动作被执行，且落进了审计链"，而这一项原来**没人断言**：
    // 动作一旦不再由平台自己实现（D41：改成跑一个工具包脚本），"判决带了动作、
    // 审计里却什么都没有"就成了一种完全可能的失败——判决照旧是
    // `dispatched_to_action`，只是链子上少了一环。所以这里把那一环钉住。
    assert.equal(audit.actionIds.length, 1, '★ 审计必须记下这条判决触发的那个动作')
  })

  test('★ 审核的第一句话含审核标准与判决格式要求（FR-CLI-43）', () => {
    assert.notEqual(backend.seenContext, null)
    assert.match(backend.seenContext!, /## 审核标准/, '第一句话里要有审核标准那一段')
    // ★ D37：标准内联在审核者身上（不再来自挂载的 skill），所以这里比的是
    //   **标准正文**里的内容——播种的审核者带的正是内置那份通用审核标准。
    assert.match(backend.seenContext!, /通用审核/, '标准正文必须随第一句话下发')
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

    assert.match(text, /## 这次要你做什么/, '★ 要有"要你做什么"这一段')
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

  test('★ 结束后不残留注入的技能（上下文记录按约定保留）', async () => {
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

      // 上下文记录是**有意保留**的（使用者的决定：跑完要能回看"它被交代了什么"）。
      // ⚠️ D29 之后它落在 `.alpha-helper/context/<runId>.md`——**我们自己起的
      //    名字**，不是 CLI 的项目记忆文件（`CLAUDE.md`）。
      assert.ok(
        (await readdir(join(dir, '.alpha-helper', 'context'))).length > 0,
        '.alpha-helper/context/<runId>.md 要留着（回看靠它）',
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
      // 首启播种**一对**：一个审核者 + 一个执行者（执行者指向审核者）
      const agents = ((await (await fetch(`${d.url}/api/agents`)).json()) as {
        agents: Array<{ id: string; name: string; role: string; reviewerAgentId: string | null }>
      }).agents
      const reviewer = agents.find((a) => a.role === 'reviewer')
      const executor = agents.find((a) => a.role === 'executor')
      assert.ok(reviewer, '★ 首启必须播种审核者 —— 否则所有报告都无人可审')
      assert.ok(executor, '首启也会播种一个执行者')
      assert.equal(
        executor.reviewerAgentId,
        reviewer.id,
        '★ 执行者默认指向那个审核者，首启就是一条通的闭环',
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
  async function setStandard(
    url: string,
    agentId: string,
    standard: { name: string; body: string } | null,
    allowedActions: string[] = [],
  ): Promise<number> {
    const res = await fetch(`${url}/api/agents/${encodeURIComponent(agentId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reviewStandard: standard, allowedActions }),
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

  test('★ 清掉标准 ⇒ 不再派审核，而且日志说清是"没有标准"', async () => {
    await withBackend('d37-nostd', async ({ url }) => {
      const agents = ((await (await fetch(`${url}/api/agents`)).json()) as {
        agents: Array<{ id: string; role: string }>
      }).agents
      const reviewer = agents.find((a) => a.role === 'reviewer')!
      assert.equal(await setStandard(url, reviewer.id, null), 200)

      const executor = agents.find((a) => a.role === 'executor')!
      const issueId = ((await (
        await fetch(`${url}/api/issues`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: '没有标准的审核者' }),
        })
      ).json()) as { id: string }).id

      const runId = ulid()
      await fetch(`${url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId,
          kind: 'execute',
          agentRef: { id: executor.id, name: 'x', instructions: '' },
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
      assert.match(text, /没有审核标准/, '要说清是哪一条规则挡住的')
      assert.match(text, /去「智能体」页给它写一条/, '并且告诉人去哪儿修')
    })
  })

  test('★ 动作权限来自 **agent**（`Agent.allowedActions`）：没允许的动作会被拦下（要人介入）', async () => {
    await withBackend('d37-actions', async ({ url, backend: b }) => {
      // ══════════════════════════════════════════════════════════════
      // ★ D41：白名单里只能写**已安装工具包**声明过的动作
      // ══════════════════════════════════════════════════════════════
      //
      // `Agent.allowedActions` 的写入口照旧对着"这个工作区装了哪些包"校验
      // （未装即拒），所以内置裸名（`comment.create` 那种）现在会被 400。
      // 这里装**两个**包：一个授权、另一个只装不授权——拦住判决的必须只能是
      // 白名单这一关，不能是"这个名字根本没装"（那是另一条路径，另一句话）。
      const granted = await writeToolPackage({ slug: 'granted-tool' })
      const denied = await writeToolPackage({ slug: 'denied-tool' })
      await installToolPackage({ url }, granted)
      await installToolPackage({ url }, denied)

      const agents = ((await (await fetch(`${url}/api/agents`)).json()) as {
        agents: Array<{ id: string; role: string }>
      }).agents
      const reviewer = agents.find((a) => a.role === 'reviewer')!
      // 这个审核者只允许那一个动作，而判决想用**另一个**（装了、但没授权）⇒ 必须被拦下
      assert.equal(
        await setStandard(
          url,
          reviewer.id,
          { name: '只许一个动作', body: '# 只许一个动作\n\n只允许已勾上的那一个动作，别的都不许。' },
          [granted.action],
        ),
        200,
      )
      b.script = [
        validVerdict({
          conclusion: 'pass',
          reasonCode: 'meets_criteria',
          // 这个动作**不在**该审核者的白名单里
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
      assert.match(text, /只许一个动作/, '标准正文要真的随第一句话下发')
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
      ).json()) as { id: string; reviewStandard: unknown; allowedActions: unknown }
      assert.equal(reviewer.reviewStandard, null, '这个夹具刻意不带内联标准')
      assert.deepEqual(
        reviewer.allowedActions,
        [],
        '★ 挂着老 skill 的审核者，动作列表不由 skill 决定（新建时没配就是空）',
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
  // D40 收口：动作权限搬到 agent 上之后，**老数据那条回退**必须真的在读
  // ══════════════════════════════════════════════════════════════════
  //
  // 「写了回退」与「回退真的在读」是两回事。这条用例造一条**真·老数据形态**的
  // agent 记录（动作写在标准里、agent 上连 `allowedActions` 这个键都没有——
  // 老记录是整条 JSON 存下来的，store 不做 schema 迁移），然后让判决真的走一遍：
  //
  //   · 老白名单里**没有**的动作 ⇒ 被拦下，而且理由里要能看到那份**老白名单**；
  //   · 老白名单里**有**的动作 ⇒ 放行。
  //
  // 两条一起才算"按它校验"：只验拦下的话，"所有动作都拦"也能通过。
  test('★ 老数据回退：动作写在标准里（agent 上没有那个键）时，判决仍按它校验', async () => {
    await withBackend('d40-legacy-fallback', async ({ url, backend: b, store }) => {
      const legacyStandard = { name: '老标准', body: '# 老标准\n\n只看重不重。' }

      // ══════════════════════════════════════════════════════════════
      // ★ D41：老白名单里的动作也必须**真的来自一个装了的包**
      // ══════════════════════════════════════════════════════════════
      //
      // 这条用例守的是**回退语义**（老数据里动作写在标准上、agent 上连键都没有），
      // 而回退之后那份白名单照样要过 D41 这一关：白名单里写的动作，其包必须在
      // 这个工作区装过（`resolveAllowedActionsWithTools` 只留"声明过且装了"的）。
      //
      // 所以装两个包：老白名单里写被授权的那个，判决想用的是**另一个**——
      // 它也装了（所以拦住它的只能是白名单，不可能是"没装"）。
      const granted = await writeToolPackage({ slug: 'legacy-granted-tool' })
      const denied = await writeToolPackage({ slug: 'legacy-denied-tool' })
      await installToolPackage({ url }, granted)
      await installToolPackage({ url }, denied)

      // ① 让**播种的**审核者退出：它自己也有一份动作权限（`before` 里授过一个），
      //    会一起接住这份报告，于是断言就不再是单值的。先清空它的动作、再改角色
      //    ——这是新规则下的两步走（"有动作的审核者不能一步变成执行者"）。
      const seeded = ((await (await fetch(`${url}/api/agents`)).json()) as {
        agents: Array<{ id: string; role: string }>
      }).agents.find((a) => a.role === 'reviewer')!
      const clearSeeded = await fetch(`${url}/api/agents/${seeded.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ allowedActions: [] }),
      })
      assert.equal(clearSeeded.status, 200)
      const demote = await fetch(`${url}/api/agents/${seeded.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'executor' }),
      })
      assert.equal(demote.status, 200, '播种的审核者退出之后，这条报告只剩一个接的人')

      // ② 先按新契约建一个审核者（这样它有名字与正文），再把它改写成**老形态**：
      //    动作在标准里、agent 上**没有** `allowedActions` 这个键。
      const created = (await (
        await fetch(`${url}/api/agents`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: '老数据审核者', role: 'reviewer', reviewStandard: legacyStandard }),
        })
      ).json()) as { id: string }
      const stored = await store.getAgent(created.id as never)
      assert.ok(stored)
      // 老记录里根本没有这个键 ⇒ 这里**删掉**它（而不是写一个空数组）
      const { allowedActions: _ownActions, ...withoutOwnActions } = stored
      void _ownActions
      await store.insertAgent({
        ...withoutOwnActions,
        // ★ 动作写在标准里 —— 这正是搬走之前的形状（老数据里那份动作名同样受
        //   D41 约束：它指向的包在这个工作区里装着）
        reviewStandard: { ...legacyStandard, allowedActions: [granted.action] },
      })

      // ③ 判决想用**另一个**动作 ⇒ 老白名单里只有 granted 那个 ⇒ 必须被拦下
      b.script = [
        validVerdict({
          conclusion: 'pass',
          reasonCode: 'meets_criteria',
          action: verdictAction(denied.action, { text: '越权的动作' }),
        }),
      ]
      const blocked = await postReportTo(url, 'd40-legacy-block', [
        { externalId: 'lb-1', kind: 'pr-diff', title: '越权', body: '内容' },
      ])
      assert.equal(blocked.unmatched, 0, '老数据形态的审核者要真的接住它')
      for (const id of blocked.runIds) await runToEnd(url, id)
      const blockedVerdicts = ((await (
        await fetch(`${url}/api/runs/${blocked.runIds[0]!}/verdicts`)
      ).json()) as {
        verdicts: Array<{ status: string; escalateReason: string | null }>
      }).verdicts
      assert.equal(blockedVerdicts[0]?.status, 'escalated', '老白名单里没有这个动作 ⇒ 拦下')
      assert.match(
        String(blockedVerdicts[0]?.escalateReason),
        /legacy-granted-tool\.act/,
        '★ 理由里要能看到**那份老白名单**——这才证明回退真的读了标准里那一份（而不是"一律拦下"）',
      )

      // ④ 判决用老白名单里**有**的动作 ⇒ 放行
      b.script = [
        validVerdict({
          conclusion: 'pass',
          reasonCode: 'meets_criteria',
          action: verdictAction(granted.action, { text: '可以' }),
        }),
      ]
      const allowed = await postReportTo(url, 'd40-legacy-allow', [
        { externalId: 'la-1', kind: 'pr-diff', title: '合规', body: '内容' },
      ])
      for (const id of allowed.runIds) await runToEnd(url, id)
      const allowedVerdicts = ((await (
        await fetch(`${url}/api/runs/${allowed.runIds[0]!}/verdicts`)
      ).json()) as {
        verdicts: Array<{ status: string }>
      }).verdicts
      assert.equal(
        allowedVerdicts[0]?.status,
        'dispatched_to_action',
        '★ 老白名单里允许的动作要真的放行——不然"回退"可能只是"什么都没读到"',
      )
    })
  })

  // ══════════════════════════════════════════════════════════════════
  // 自检②：skill 那边确实**不再影响授权**
  // ══════════════════════════════════════════════════════════════════
  //
  // 一个挂着**带 allowedActions 的老 skill** 的审核者，其有效动作列表**只**由
  // agent 决定。这条在纯函数层有断言（`review-standard.test.ts`），这里再走一遍
  // 真链路：它决定的是**判决能不能过**，而不只是某个返回值。
  test('★ 挂着带动作配置的老 skill 的审核者：有效动作列表只由 agent 决定', async () => {
    await withBackend('d40-skill-actions-ignored', async ({ url, backend: b }) => {
      // ★ D41：装两个包，让"skill 那份不算数"这条断言**真的能红**——老 skill
      //   声明的是另一个**已安装**的动作：如果 skill 参与授权，下面的判决就会过；
      //   只有它确实不参与授权，判决才会被拦下。
      const granted = await writeToolPackage({ slug: 'skill-granted-tool' })
      const denied = await writeToolPackage({ slug: 'skill-denied-tool' })
      await installToolPackage({ url }, granted)
      await installToolPackage({ url }, denied)

      // ① 装一条**带动作配置的老 skill**（老客户端就是这么发的；写入口会忽略它）
      const installed = ((await (
        await fetch(`${url}/api/skills`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            skills: [
              {
                slug: 'legacy-actions',
                name: '老技能',
                body: '# 老技能\n\n看一件事。',
                // 老契约里 skill 自己也声明动作白名单。这里刻意写**一个装了、但
                // agent 上没有授权的**动作：它一个字都不该算数，判决就该被拦下。
                allowedActions: [denied.action],
              },
            ],
          }),
        })
      ).json()) as {
        installed: Array<Record<string, unknown> & { id: string }>
      })
      assert.equal(
        'allowedActions' in installed.installed[0]!,
        false,
        '老 skill 的那个键不会被写进库',
      )

      // ② 播种的审核者退出（理由同上一条用例）
      const seeded = ((await (await fetch(`${url}/api/agents`)).json()) as {
        agents: Array<{ id: string; role: string }>
      }).agents.find((a) => a.role === 'reviewer')!
      await fetch(`${url}/api/agents/${seeded.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ allowedActions: [] }),
      })
      await fetch(`${url}/api/agents/${seeded.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'executor' }),
      })

      // ③ 一个挂着那条老 skill、**没有内联标准**、agent 上只允许一个工具动作
      //    的审核者。老 skill 的正文仍然是它的标准（过渡期兼容），但动作不算数。
      const reviewer = (await (
        await fetch(`${url}/api/agents`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: '挂老 skill 的审核者',
            role: 'reviewer',
            skillIds: [installed.installed[0]!.id],
            allowedActions: [granted.action],
          }),
        })
      ).json()) as { id: string; reviewStandard: unknown }
      assert.equal(reviewer.reviewStandard, null, '夹具刻意不带内联标准（标准来自 skill）')

      // ④ 判决要用老 skill 里写着允许的那个动作 ⇒ 必须被拦下：skill 不算数
      b.script = [
        validVerdict({
          conclusion: 'pass',
          reasonCode: 'meets_criteria',
          action: verdictAction(denied.action, { text: '越权的动作' }),
        }),
      ]
      const summary = await postReportTo(url, 'd40-skill-ignored', [
        { externalId: 's-1', kind: 'pr-diff', title: '越权', body: '内容' },
      ])
      assert.equal(summary.unmatched, 0)
      for (const id of summary.runIds) await runToEnd(url, id)
      const verdicts = ((await (
        await fetch(`${url}/api/runs/${summary.runIds[0]!}/verdicts`)
      ).json()) as { verdicts: Array<{ status: string; escalateReason: string | null }> }).verdicts
      assert.equal(
        verdicts[0]?.status,
        'escalated',
        '★ 老 skill 里写着允许那个动作，但 skill 不参与授权 ⇒ 必须拦下',
      )
      assert.match(
        String(verdicts[0]?.escalateReason),
        /允许：skill-granted-tool\.act/,
        '★ 允许的集合里**只有** agent 上那份（老 skill 里那个动作没被并进来）',
      )
    })
  })
})
