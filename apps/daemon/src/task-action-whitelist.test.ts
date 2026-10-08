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
  type RunId,
} from '@agentdeck/protocol'
import { startDaemon, type DaemonHandle } from './server.ts'
import { createChainGroup } from './testing/chain.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'
import {
  installToolPackage,
  setupToolFixture,
  verdictAction,
  writeToolPackage,
} from './testing/tool-fixture.ts'

/**
 * 「新建任务」这一次任务的**动作白名单**（`SubmitRunRequest.allowedActions`，D42）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这个字段为什么值得一整个文件
 * ══════════════════════════════════════════════════════════════════
 *
 * 它是**三态**，而且三态都是真实意图（见 `local-api.ts` 与 `Run.allowedActions`
 * 的注释）：
 *
 *   - **省略** ⇒ 跟随那个审核者的「行动权限」（长期安排，绝大多数情况）；
 *   - **给了数组** ⇒ 这一次就用这一份；
 *   - **空数组** ⇒ 这一次一个动作都不许触发（判决只能给结论）。
 *
 * 三态一旦被折成两态，**没有任何东西会报错**：
 *
 *   · 把"省略"折成 `[]`（`?? []` 这种"顺手补个默认值"）⇒ 审核者配好的动作
 *     全部失效，而表现是"判决忽然只会给结论了"——没有任何地方解释为什么；
 *   · 把"空数组"折成"缺字段"（`|| undefined`）⇒ 使用者明明收紧了权限，判决却
 *     照旧触发了审核者自己的动作。**这是权限被放宽，而界面上一切正常**；
 *   · 漏掉"带下去"那一站（`createRunForReviewer`）⇒ 决定只落在执行 run 上，
 *     而它真正生效的地方是审核侧，于是白名单成了一个纯粹的花瓶字段。
 *
 * 这三类错都只能靠**真实链路**钉住：真的起 daemon、真的走 HTTP、真的派生审核
 * run、真的读那条审核 run 的日志与记录。纯函数单测看不见 `executor.submit()` 到
 * `run.allowedActions` 之间的任何一站。
 *
 * 用什么跑的：照抄 `reviewer-override.test.ts` / `tool-action-e2e.test.ts` 的夹具
 * （假后端 + `makeTempDir` + 真 HTTP + 真工具包脚本）。
 * **NFR-T-01：绝不调用使用者真实安装的 agent CLI。** 工具包的脚本是我们自己写的、
 * 只往工作目录写一个文件，它是"动作到底有没有落地"唯一的硬证据。
 */

// ══════════════════════════════════════════════════════════════════
// 假后端
// ══════════════════════════════════════════════════════════════════

/**
 * 一份合法、无动作、不重试的判决——**审核那一路的默认回答**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么默认必须是"合法判决"，而不是一句随便的话
 * ══════════════════════════════════════════════════════════════════
 *
 * 审核跑出"没有判决块"的输出时，平台会把它记为 `invalid`，而**重试**会派生**第二
 * 条** review run（subject 依然是那条执行 run）。本文件好几条用例要断言的正是
 * "派生了几条审核 run"（例如"结构性问题不许重试"），一旦夹具默认吐垃圾，这个
 * 数字就不确定了——而失败症状会指向产品。
 *
 * 让审核正常收口（`pass`、无动作、不重试），"一条"这个数字才是确定的。
 */
const PASS_VERDICT: Record<string, unknown> = {
  schemaVersion: 1,
  conclusion: 'pass',
  reasonCode: 'meets_criteria',
  confidence: 0.9,
  findings: [],
  action: null,
  escalateReason: null,
}

/**
 * 假 CLI：**执行**那次说一句人话，**审核**那次吐 `verdict`。
 *
 * ⚠️ 判据是"这段 prompt 里有没有判决围栏"（只有审核那份有契约），不是"这是第几次
 *    调用"——按序号判断在并行/重试/派生时会把预置判决喂给错误的 run，而症状是
 *    "动作记录一直不落库"这种指向产品的假象（`tool-action-e2e.test.ts` 踩过一次）。
 */
class WhitelistBackend implements AgentBackend {
  readonly key = 'claude'
  readonly protocol = 'stream-json' as const
  readonly rejectDetectable = false
  /** 审核那一路一律用这份判决回答（可以被读到多次：自动审核可能会重来）。 */
  verdict: Record<string, unknown> | null = PASS_VERDICT
  /** 投递出去的全部第一句话——契约断言也可以从这里读，与日志互为对照。 */
  readonly prompts: string[] = []

  async probe(): Promise<{ available: boolean; command: string; cliVersion: string | null }> {
    return { available: true, command: 'claude', cliVersion: '0.0.0-fake' }
  }

  async execute(opts: ExecOptions): Promise<AgentSession> {
    this.prompts.push(deliveredText(opts))
    const isReview = deliveredText(opts).includes(VERDICT_FENCE_BEGIN)
    const verdict = isReview ? this.verdict : null
    const text =
      verdict === null
        ? '我做完了这件事。'
        : `结论：\n${VERDICT_FENCE_BEGIN}\n${JSON.stringify(verdict)}\n${VERDICT_FENCE_END}\n`

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

// ══════════════════════════════════════════════════════════════════
// 夹具
// ══════════════════════════════════════════════════════════════════

/**
 * 一套自足的夹具：一个真 daemon + 假后端 + 它自己的临时目录。
 *
 * ⚠️ 临时目录一律走 `makeTempDir`（`.cache/test-tmp`），**绝不用 `os.tmpdir()`**：
 *    沙箱环境对工作区外的写入有限制，而且工作区内的残留一眼能看见。
 *
 * 为什么不是"一个文件一个 daemon"：B 组的每条用例都要预置**不同的**判决
 * （`backend.verdict`），而那份预置是**全局**的——同一个 daemon 里在跑的别的审核
 * run 会读到它。一条用例一个 daemon 是这里唯一不会互相干扰的形状。
 */
interface Harness {
  daemon: DaemonHandle
  backend: WhitelistBackend
  url: string
  /** 本夹具自己造的临时目录，`close()` 里统一清掉。 */
  newWorkDir(prefix?: string): Promise<string>
  close(): Promise<void>
}

async function startHarness(prefix: string): Promise<Harness> {
  const dir = await makeTempDir(prefix)
  const backend = new WhitelistBackend()
  const daemon = await startDaemon({
    dataDir: dir,
    port: 0, // 让内核分配端口，避免测试之间抢端口
    fsync: false,
    workRoot: join(dir, 'workroot'),
    backend,
    onWarn: () => {},
    onInfo: () => {},
    // 解释器钉死在"跑测试的这个 node"上（工具包脚本是真跑的）
    scriptRuntimePath: process.execPath,
  })

  const dirs = [dir]
  return {
    daemon,
    backend,
    url: daemon.url,
    async newWorkDir(p = `${prefix}-work`) {
      const made = await makeTempDir(p)
      dirs.push(made)
      return made
    },
    async close() {
      await daemon.close()
      for (const d of dirs) await cleanup(d)
    },
  }
}

/** 正则里的转义（动作名里那个 `.` 必须当字面量）。 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 提交一条 run。
 *
 * `allowedActions` **键是否出现**在这里是有意义的：不传 = 请求体里没有这个键
 * （"跟随"），传 `[]` = 键在、值是空数组（"这一次一个都不许"）。这一层必须忠实，
 * 否则测的就不是三态了——`'x' in input` 而不是 `input.x !== undefined` 就是为了这个。
 */
async function submitRun(
  h: Harness,
  input: {
    runId: RunId
    workDir: string
    agent: { id: string; name: string }
    prompt?: string
    kind?: string
    subject?: { type: string; id: string }
    allowedActions?: string[]
    reviewerAgentId?: string | null
    /**
     * ★ 智能体组（2026-10 起"谁审我 + 判完允许动什么"的唯一出处）。
     *
     * 带它 ⇒ 组把审核者与动作白名单**展开**进这条 run；**省略** ⇒ 这一次没有审核者
     * （除非同一次里显式给了 `reviewerAgentId`——run 级那条入口仍然在）。
     */
    groupId?: string
  },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const payload: Record<string, unknown> = {
    runId: input.runId,
    kind: input.kind ?? 'execute',
    agentRef: { id: input.agent.id, name: input.agent.name, instructions: '' },
    skills: [],
    subject: input.subject ?? { type: 'issue', id: 'issue-whitelist' },
    prompt: input.prompt ?? '把这次任务做完',
    workDir: input.workDir,
    limits: { maxTurns: null, timeoutMs: null },
  }
  if ('allowedActions' in input) payload['allowedActions'] = input.allowedActions
  if ('reviewerAgentId' in input) payload['reviewerAgentId'] = input.reviewerAgentId
  if ('groupId' in input) payload['groupId'] = input.groupId

  const res = await fetch(`${h.url}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

/** 提交一条执行 run，断言受理成功并返回它的 id。 */
async function submitExecute(
  h: Harness,
  input: {
    agent: { id: string; name: string }
    workDir: string
    allowedActions?: string[]
    prompt?: string
    groupId?: string
    /**
     * ★ 这一次单独点名的审核者（run 级入口，**不经过组**）。
     *
     * 它仍然是一条真实的入口（协议里 `SubmitRunRequest.reviewerAgentId` 没删），
     * 也是"不带组也能有审核者"的唯一办法——所以夹具必须能表达它，
     * 否则"没有组的链只能没有审核者"这条判据就没有反面可对照。
     */
    reviewerAgentId?: string | null
  },
): Promise<RunId> {
  const runId = ulid() as RunId
  const res = await submitRun(h, { runId, ...input })
  assert.equal(res.status, 202, `受理必须返回 202，实际 ${res.status}：${JSON.stringify(res.body)}`)
  return runId
}

/** `GET /api/runs/<id>` —— 落库的那个 `Run` 对象本身（不是列表投影）。 */
async function getRunRecord(h: Harness, runId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${h.url}/api/runs/${runId}`)
  assert.equal(res.status, 200, `run ${runId} 应当存在，实际 ${res.status}`)
  return (await res.json()) as Record<string, unknown>
}

interface RunRow {
  runId: string
  kind: string
  status: string
  agentId: string
  subject?: { type: string; id: string }
  workDir?: string | null
  reviewer?: { mode: string; agentId?: string } | null
  verdict?: { status: string; conclusion: string; escalateReason: string | null } | null
  action?: { status: string; type: string; error: string | null } | null
}

async function listRunRows(h: Harness): Promise<RunRow[]> {
  const res = await fetch(`${h.url}/api/runs`)
  return ((await res.json()) as { runs: RunRow[] }).runs
}

/**
 * 由**这条执行 run** 派生出来的 run（审核 run 的 subject 是 `{type:'run', id}`）。
 *
 * ⚠️ 不能按 `kind === 'review'` 全局找：同一个 daemon 里可能躺着别的用例的审核 run，
 *    那样断言会匹配到**别人的**审核（`review-e2e.test.ts` 里踩过一次）。
 */
async function derivedRuns(h: Harness, executeRunId: string): Promise<RunRow[]> {
  return (await listRunRows(h)).filter(
    (r) => r.subject?.type === 'run' && r.subject.id === executeRunId,
  )
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

async function waitForSettled(h: Harness, runId: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const run = await getRunRecord(h, runId)
    if (TERMINAL.has(String(run['status']))) return
    if (Date.now() > deadline) throw new Error(`等待 run ${runId} 结束超时`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** 轮询直到 `fn` 给出一个非 null 的值。**不用固定 sleep**：那既慢又会偶发假失败。 */
async function until<T>(fn: () => Promise<T | null>, what: string, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn().catch(() => null)
    if (value !== null) return value
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** 等这条执行 run 派生出一条 review run，并等它跑完。 */
async function waitForDerivedReview(
  h: Harness,
  executeRunId: string,
  timeoutMs = 8000,
): Promise<RunRow> {
  const found = await until(
    async () => (await derivedRuns(h, executeRunId)).find((r) => r.kind === 'review') ?? null,
    `run ${executeRunId} 派生审核`,
    timeoutMs,
  )
  await waitForSettled(h, found.runId, timeoutMs)
  return found
}

/**
 * 等到日志里出现匹配的那一句，返回当时**全部**消息的拼接。
 *
 * 日志是**边跑边写**的：判决契约排在整段执行之后。只等"有消息"会在那句话写下来
 * 之前就断言，报出来的是"日志里没有 XX"这种假失败。
 */
async function waitForText(h: Harness, runId: string, pattern: RegExp, timeoutMs = 10_000): Promise<string> {
  return until(
    async () => {
      const res = await fetch(`${h.url}/api/runs/${runId}/messages`)
      if (!res.ok) return null
      const out = (await res.json()) as { messages: Array<{ content: string }> }
      const text = out.messages.map((m) => m.content).join('\n')
      return pattern.test(text) ? text : null
    },
    `run ${runId} 的日志出现 ${pattern}`,
    timeoutMs,
  )
}

/**
 * 等这条审核 run 的「第一句话」落进日志，返回全部消息。
 *
 * 同步点是判决契约里 `action` 那一行的取值说明——两种形态都含 `` `action`： ``：
 *
 *   · 这次有动作：`` - `action`：`fail` **必须**给出… `type` 只能取：<动作名> ``
 *   · 这次没有动作：`` - `action`：**这次不要写**（没有任何动作被允许） ``
 *
 * 它一出现，"这一次允许什么"就已经定型了，所以拿它当同步点是对的。
 */
async function waitForVerdictContract(h: Harness, reviewRunId: string, timeoutMs = 10_000): Promise<string> {
  return waitForText(h, reviewRunId, /`action`：/, timeoutMs)
}

interface VerdictRow {
  id: string
  status: string
  conclusion: string
  reasonCode: string
  invalidResolution: string | null
  escalateReason: string | null
  action: unknown
}

async function listVerdicts(h: Harness, runId: string): Promise<VerdictRow[]> {
  const res = await fetch(`${h.url}/api/runs/${runId}/verdicts`)
  return ((await res.json()) as { verdicts: VerdictRow[] }).verdicts
}

async function createAgent(h: Harness, body: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${h.url}/api/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runtimeKey: 'claude', instructions: '', ...body }),
  })
  const created = (await res.json()) as { id?: string }
  assert.equal(res.status, 201, `建 agent 失败：${JSON.stringify(created)}`)
  assert.ok(created.id, 'agent 必须带 id')
  return created.id
}

/**
 * **组**记录里的「行动权限」——A/B 组的几条用例要自检它，免得测的不是白名单的功劳。
 *
 * ⚠️ 2026-10：这个助手原来读的是 `agent.allowedActions`。那个字段已经撤掉
 *    （动作只属于组），所以读数的地方跟着搬家——注意**判据没变**：仍然是
 *    "库里的那份权限到底是什么"。
 */
async function groupAllowedActions(h: Harness, groupId: string): Promise<string[]> {
  const res = await fetch(`${h.url}/api/agent-groups/${groupId}`)
  assert.equal(res.status, 200, `组 ${groupId} 应当存在`)
  const body = (await res.json()) as { group: { allowedActions: string[] } }
  return body.group.allowedActions
}

/**
 * 被拒的请求不许留下 run（幽灵 run）。
 *
 * 它是最容易漏的一种后果：`POST /api/runs` 里那几条校验都写在 `insertRun` 之前，
 * 但只要谁把校验挪到 `executor.submit()` 之后，"400 说得挺好、库里躺着一条
 * waiting_local_directory 的 run"就成立了——而那条 run **没有任何界面入口**，
 * 只会占着工作目录、并在列表里让使用者看见一条他没提交过的任务。
 */
async function assertNoGhostRun(h: Harness, runId: string): Promise<void> {
  const rows = await listRunRows(h)
  assert.equal(rows.some((r) => r.runId === runId), false, `★ 被拒的请求不许在库里留下 run ${runId}`)
  const res = await fetch(`${h.url}/api/runs/${runId}`)
  assert.equal(res.status, 404, `★ 幽灵 run：GET /api/runs/${runId} 应当是 404，实际 ${res.status}`)
}

// ══════════════════════════════════════════════════════════════════
// A. 落库与「带下去」
// ══════════════════════════════════════════════════════════════════

/**
 * 这一组的观测点是**两条 run 记录**：执行 run（决定）与由它派生出来的审核 run
 * （决定被带下来）。审核侧才是这份白名单生效的地方，所以"带下去"那一站必须单独钉。
 *
 * 夹具刻意让**组**有一个动作（`wl-own.note`），而另一个已装包的动作
 * （`wl-task.mark`）**不在**组那份里——这样"这一次的白名单"与"组那份"是两份不同的
 * 清单，"用的是哪一份"才可判。
 *
 * ⚠️ 2026-10：那份"长期有效的权限"从**审核者 agent** 搬到了**组**上（agent 上的
 *    `allowedActions` 已撤掉）。三态仍然一模一样，只是"省略"跟随的那一份换了出处：
 *
 *   · 带 `[]`      ⇒ 这一次一个都不许（**顶掉**组那份）；
 *   · **省略**     ⇒ 组把它的那份展开进这条 run（"跟随"）；
 *   · 带一份真动作 ⇒ 这一次就用这一份。
 */
describe('A. ★ 任务级动作白名单：三态落库 + 带下去', () => {
  let h: Harness
  /** 审核者自己的动作（已装包 `wl-own` 声明的那个）。 */
  let ownAction: string
  /** 只通过"这一次的白名单"进来的动作（已装包 `wl-task`，**不在**审核者的权限里）。 */
  let taskAction: string
  let reviewerId: string
  let executor: { id: string; name: string }
  /** 把这一对串起来的组（带它提交 run 才有审核者；**省略白名单时跟随的就是它那份**）。 */
  let groupId: string

  before(async () => {
    h = await startHarness('whitelist-a')

    // 两个包：一个进审核者的「行动权限」，一个只出现在这一次的白名单里。
    const pkgRoot = await h.newWorkDir('whitelist-a-pkg')
    const ownPkg = await writeToolPackage({ slug: 'wl-own', actionName: 'note', root: pkgRoot })
    const taskPkg = await writeToolPackage({ slug: 'wl-task', actionName: 'mark', root: pkgRoot })
    await installToolPackage(h.daemon, ownPkg)
    await installToolPackage(h.daemon, taskPkg)
    ownAction = ownPkg.action
    taskAction = taskPkg.action

    // ★ 审核者必须**自带审核标准**，否则 `createRunForReviewer` 直接返回 null：
    //   没有标准的审核不算审核（D37），"派生了一条 review run"这件事根本不会发生。
    reviewerId = await createAgent(h, {
      name: '审核者 A',
      role: 'reviewer',
      reviewStandard: { body: '# A 标准\n\n只要产出不为空就算通过。' },
    })
    const executorId = await createAgent(h, {
      name: '执行者 A（由组里的审核者 A 审）',
      role: 'executor',
    })
    executor = { id: executorId, name: '执行者 A（由组里的审核者 A 审）' }

    // ⚠️ 2026-10：这里原来是"审核者带 `allowedActions` + 执行者带 `reviewerAgentId`"。
    //    那两个字段都已撤掉，同一件事现在由**组**表达：成员是这一对，而"判完允许动
    //    什么"写在组上。这条链的三态（白名单的三种给法）被测的对象**一个字没变**
    //    ——变的是"省略时跟随谁"：以前跟随审核者自己那份，现在跟随**组**那份。
    groupId = await createChainGroup(
      { url: h.url },
      { name: 'A 组', members: [executorId, reviewerId], allowedActions: [ownAction] },
    )

    // 夹具自检：动作权限真的写下去了。少了它，用例 2 会红在一个与三态毫无关系的地方
    // （"组里的权限是空的"），而排查方向会指向白名单。
    assert.deepEqual(
      await groupAllowedActions(h, groupId),
      [ownAction],
      '夹具前提：组的「行动权限」必须恰好是那一个动作',
    )
  })

  after(async () => {
    await h.close()
  })

  test('★ 带 allowedActions: [] ⇒ 执行 run 与派生审核 run 的记录上都是空数组（键在）', async () => {
    /**
     * 空数组是**合法而且有意义**的一份覆盖："这一次一个动作都不许触发"
     * （判决只能给结论）。它最容易在两站上被折成"跟随便没有这个字段"——
     * 落库（`executor.submit`）与带下去（`createRunForReviewer`）各有一处
     * `...(x === undefined ? {} : { allowedActions: x })`，任何一处写成
     * `x ?? []` / `x || undefined` 都会让这份决定消失。
     *
     * 而消失的表现是**静默的**：run 正常受理、正常结束、状态 completed，只是
     * 判决忽然只会给结论了（或者反过来：使用者明明收紧了，判决照旧动手）。
     */
    const workDir = await h.newWorkDir()
    // ★ 带组提交：这一次的 `[]` 要**顶掉**组自己那份（`wl-own.note`）——这才是
    //   "收紧"的有效性证明（没有组那份作对照，"空数组生效了"说不清是它的功劳）
    const runId = await submitExecute(h, { agent: executor, workDir, allowedActions: [], groupId })

    const executeRecord = await getRunRecord(h, runId)
    assert.equal(
      'allowedActions' in executeRecord,
      true,
      '★ 空数组是**决定**，键必须在库里留痕（缺键 = "使用者没说"）',
    )
    assert.deepEqual(executeRecord['allowedActions'], [], '★ 值必须是空数组，不是 null、不是缺键')

    const review = await waitForDerivedReview(h, runId)
    const reviewRecord = await getRunRecord(h, review.runId)
    assert.equal(
      'allowedActions' in reviewRecord,
      true,
      '★ 决定被带下来的那一站也不许掉键（掉了就等于"跟随"）',
    )
    assert.deepEqual(reviewRecord['allowedActions'], [])

    // 审核真的跑过，而不只是有一条 run 记录
    assert.ok(h.backend.prompts.some((p) => p.includes(VERDICT_FENCE_BEGIN)), '审核那一路要真的被派了')
  })

  test('★ 省略 allowedActions ⇒ 跟随**组**那份（两条 run 记录上都是组的那一份）', async () => {
    /**
     * ══════════════════════════════════════════════════════════════════
     * 这条是**回归保护**，不是新功能测试
     * ══════════════════════════════════════════════════════════════════
     *
     * ⚠️ 2026-10 这条的**判据变过**，说清楚免得下次有人以为是在改测试凑绿：
     *
     *   以前"省略"的意思是"跟随**审核者自己**的行动权限"，而那个字段住在 agent 上
     *   ⇒ 省略时 run 记录上**压根不该有这个键**（键不在 = "使用者没说"）。
     *
     *   现在那份长期权限住在**组**上，而组是在 `POST /api/runs` 里**展开**成 run 上
     *   那几个字段的（`if (body.allowedActions === undefined) body.allowedActions =
     *   group.allowedActions`）。所以"省略"的结果是 run 上**有值**——值是**组那份**。
     *
     *   于是这里钉的变成两件事：
     *     1. 两条 run（执行 + 派生的审核）上的值都等于**组那份**；
     *     2. 而且它在**审核侧真的生效**——判决契约里必须列出组那个动作。
     *
     *   ★ 仍然要防的错**一个都没变**：把"省略"折成"这一次一个都不许"（在
     *     `executor.submit` 或 `autoChainReview` 里写 `?? []`）。那种折法的表现是
     *     "组里配好的动作全部失效、判决永远只能给结论"，而 run 状态一切正常、
     *     日志里也没有一个字解释为什么——**没有任何地方会报错**。
     *     判据因此从"键不在"变成"值等于组那份"：折成 `[]` 就会红。
     */
    const workDir = await h.newWorkDir()
    const runId = await submitExecute(h, { agent: executor, workDir, groupId })

    const executeRecord = await getRunRecord(h, runId)
    assert.deepEqual(
      executeRecord['allowedActions'],
      [ownAction],
      '★ 省略 ⇒ 跟随**组**那份（折成"一个都不许"或"缺键"都会在这里红）',
    )

    const review = await waitForDerivedReview(h, runId)
    const reviewRecord = await getRunRecord(h, review.runId)
    assert.deepEqual(
      reviewRecord['allowedActions'],
      [ownAction],
      '★ 派生出来的审核 run 要拿到同一份（它才是这份权限生效的地方）',
    )

    const text = await waitForVerdictContract(h, review.runId)
    assert.match(
      text,
      new RegExp('`type` 只能取：' + escapeRegExp(ownAction)),
      '★ 省略 ⇒ 本次审核跟随组那份「行动权限」，契约必须把那个动作列给模型看',
    )
    assert.doesNotMatch(text, /这次不要写/, '★ 省略不等于"什么都不许"——那是最贵的一种折法')
  })

  test('★★ 不带组、直接点名审核者 + 给动作 ⇒ 202，白名单照旧落库并被带下去', async () => {
    /**
     * ══════════════════════════════════════════════════════════════════
     * 这一条守的是"run 级那条入口**没被一起撤掉**"
     * ══════════════════════════════════════════════════════════════════
     *
     * 2026-10 撤掉的是 **agent 上**的 `reviewerAgentId` 与那三个动作字段
     * （"某个人长期配着一个审核者 / 一份权限"）。而 **run 上**的同名字段照旧：
     * `SubmitRunRequest.reviewerAgentId` 仍然是一条真实的入口——组展开时写的
     * 就是它，别的客户端（或将来界面上的"这一次换个人审"）也照旧能直接点名。
     *
     * 所以要有一条用例把这条入口**从提交一直量到审核侧**：
     *   ① 不带 `groupId`、显式给 `reviewerAgentId` ⇒ 必须 202（不是 400）；
     *   ② 执行 run 与派生审核 run 的记录上都是这一次给的白名单；
     *   ③ 契约里列出这个动作 ⇒ 审核侧真的按它判。
     *
     * ⚠️ 少了它，"没有组就没有审核者"那条判据会被顺手实现成"没有组就**不许**有
     *    审核者"——两者差得很远，而后者会让 run 级覆盖（以及所有不走组的老客户端）
     *    整条失效，且**没有任何地方会报错**。
     */
    const workDir = await h.newWorkDir()
    const runId = ulid() as RunId
    const res = await submitRun(h, {
      runId,
      agent: executor,
      workDir,
      // ★ 两条都是 run 级字段：点名的审核者 + 这一次的白名单。
      reviewerAgentId: reviewerId,
      allowedActions: [taskAction],
    })
    assert.equal(res.status, 202, `显式点名审核者必须受理：${JSON.stringify(res.body)}`)

    const executeRecord = await getRunRecord(h, runId)
    assert.equal(executeRecord['reviewerAgentId'], reviewerId, '点名的审核者要落库')
    assert.equal('groupId' in executeRecord, false, '★ 没选组 ⇒ 这条 run 上没有组 id')
    assert.deepEqual(executeRecord['allowedActions'], [taskAction])

    const review = await waitForDerivedReview(h, runId)
    const reviewRecord = await getRunRecord(h, review.runId)
    assert.deepEqual(reviewRecord['allowedActions'], [taskAction], '★ 决定要原样带下去')
    const text = await waitForVerdictContract(h, review.runId)
    assert.match(
      text,
      new RegExp('`type` 只能取：' + escapeRegExp(taskAction)),
      '★ 不带组那条入口也要把动作列进契约',
    )
  })

  test('★ 带一份真实动作 ⇒ 执行 run 与派生审核 run 上都是那一份（组的那份被顶掉）', async () => {
    /**
     * 这一条用的动作（`wl-task.mark`）**不在**组那份「行动权限」里，所以它只能来自
     * 这一次的白名单。这样断言才有分辨力：
     *
     *   · 记录上是它 ⇒ 落库与带下去都忠实；
     *   · 契约里**列出**它、而**不列**组那个 ⇒ 审核侧真的按这一份走，
     *     而不是"两份并起来"（并起来等于这一次的收紧变成了一句空话）。
     *
     * 顺带钉住了提交时那一步校验：白名单里的动作必须来自**已安装的工具包**，
     * 否则 400（C 组）——所以"给一份真实动作"这件事本身是有代价、可验证的。
     */
    const workDir = await h.newWorkDir()
    // ★ 带组（组的权限是 `wl-own.note`）+ 这一次给 `wl-task.mark` ⇒ 后者顶掉前者
    const runId = await submitExecute(h, {
      agent: executor,
      workDir,
      allowedActions: [taskAction],
      groupId,
    })

    const executeRecord = await getRunRecord(h, runId)
    assert.deepEqual(executeRecord['allowedActions'], [taskAction])

    const review = await waitForDerivedReview(h, runId)
    const reviewRecord = await getRunRecord(h, review.runId)
    assert.deepEqual(reviewRecord['allowedActions'], [taskAction], '★ 决定要原样带下去')

    const text = await waitForVerdictContract(h, review.runId)
    assert.match(
      text,
      new RegExp('`type` 只能取：' + escapeRegExp(taskAction)),
      '★ 这一次允许的动作必须列进契约，否则模型永远写不出这个名字',
    )
    assert.doesNotMatch(
      text,
      new RegExp('`type` 只能取：[^\\n]*' + escapeRegExp(ownAction)),
      '★ 审核者自己那份不许并进来——这一次就用给的那一份',
    )
  })
})

// ══════════════════════════════════════════════════════════════════
// C. 提交校验（三种 400，且都不许入库）
// ══════════════════════════════════════════════════════════════════

/**
 * 三条 400 各自对应一种**改法**，所以必须分开报：
 *
 *   · `allowed_actions_not_applicable`  ⇒ 这个字段只对执行 run 有意义，别往审核 run 上塞；
 *   · `allowed_actions_without_reviewer` ⇒ 这一次没有审核者，白名单没有落点（先去选一个）；
 *   · `allowed_actions_unresolvable`     ⇒ 动作对不上已安装的包（去装包 / 改动作名）。
 *
 * 它们都是"写入**之前**"的校验，所以每条都要顺带确认**没有留下 run**——幽灵 run
 * 是这里最容易漏的后果（见 `assertNoGhostRun`）。
 *
 * ⚠️ 这一组用**自己的 daemon**，而且这个 daemon 里**从来没有一条 run 被成功受理过**
 *    ——"一个 run 都不许入库"才有一个干净的基线可以对照。
 */
describe('C. ★ 提交校验：三种 400，且一个 run 都不许入库', () => {
  let h: Harness
  /** 已装包声明的那个动作（用例 9 的后半段要拿它来拼错动作名）。 */
  let installed: string
  let reviewerId: string
  /** 有审核者的执行者。 */
  let executor: { id: string; name: string }
  /** **不属于任何组**的执行者（= 没有审核者）。 */
  let lonely: { id: string; name: string }
  /** 把"执行者 C + 审核者 C"串起来的组（权限是空的）；`lonely` 不属于任何组。 */
  let groupId: string

  before(async () => {
    h = await startHarness('whitelist-c')

    const pkg = await writeToolPackage({
      slug: 'wl-installed',
      actionName: 'note',
      root: await h.newWorkDir('whitelist-c-pkg'),
    })
    await installToolPackage(h.daemon, pkg)
    installed = pkg.action

    reviewerId = await createAgent(h, {
      name: '审核者 C',
      role: 'reviewer',
      reviewStandard: { body: '# C 标准\n\n随便判判。' },
    })
    const executorId = await createAgent(h, {
      name: '执行者 C（有审核者）',
      role: 'executor',
    })
    executor = { id: executorId, name: '执行者 C（有审核者）' }
    lonely = {
      id: await createAgent(h, { name: '执行者 C2（没有审核者）', role: 'executor' }),
      name: '执行者 C2（没有审核者）',
    }

    // ⚠️ 2026-10：这一对原来是"审核者带空 `allowedActions` + 执行者带 `reviewerAgentId`"。
    //    两个字段都已撤掉，同一件事现在由**组**表达（组的权限是空数组 = 一个都不许）。
    groupId = await createChainGroup(
      { url: h.url },
      { name: 'C 组', members: [executorId, reviewerId], allowedActions: [] },
    )

    // 夹具自检：C2 **不属于任何组**（= 没有审核者）——否则用例 8 会红在一个与白名单
    // 无关的地方。"不属于任何组"现在就是"没有审核者"的定义。
    const groups = ((await (await fetch(`${h.url}/api/agent-groups`)).json()) as {
      groups: Array<{ members: string[] }>
    }).groups
    assert.equal(
      groups.some((g) => g.members.includes(lonely.id)),
      false,
      '夹具前提：C2 必须不属于任何组（= 没有审核者）',
    )
    // 基线：这个 daemon 里一条 run 都没有
    assert.deepEqual(await listRunRows(h), [], '夹具前提：C 组这个 daemon 里还没有任何 run')
  })

  after(async () => {
    await h.close()
  })

  test('★ kind: review 带 allowedActions ⇒ 400 allowed_actions_not_applicable，不入库', async () => {
    /**
     * 审核 run 的动作白名单来自**被它审的那条执行 run**（`createRunForReviewer` 带
     * 下来）。从外面另塞一份就是第二个出处，而两个出处的后果是"审核用的是哪一份"
     * 变成需要推理的事——与 `reviewerAgentId` 同一条规矩：**收下不用的字段比拒掉更贵**。
     *
     * ⚠️ 判据是"这个键出现了没有"，不是"它有没有值"：`[]` 在这里同样是错的
     *    （它的意思是"这次一个都不许"，而一条审核 run 不是"被审的那一次"）。
     */
    const runId = ulid() as RunId
    const res = await submitRun(h, {
      runId,
      kind: 'review',
      agent: executor,
      workDir: await h.newWorkDir(),
      // 这个动作是**真的**（已装包声明的），所以被拒的理由只能是 kind
      allowedActions: [installed],
    })

    assert.equal(res.status, 400, '★ 这个字段只对执行 run 有意义')
    assert.equal(res.body['code'], 'allowed_actions_not_applicable')
    assert.match(
      String(res.body['error']),
      /只对执行 run/,
      '错误信息要说清"为什么没用"，否则使用者只会换个动作名再试一次',
    )
    await assertNoGhostRun(h, runId)
  })

  test('★ kind: review 带 groupId ⇒ 400 group_not_applicable，不入库', async () => {
    /**
     * ══════════════════════════════════════════════════════════════════
     * 为什么单独拒、而不是靠"字段不认识"兜住
     * ══════════════════════════════════════════════════════════════════
     *
     * `groupId` 只在执行 run 上有意义（组描述的是"谁执行 → 谁审 → 判完能做什么"
     * 这条链，而审核 run 是这条链的**产物**：它的审核者由被审的那条执行 run 带下来）。
     *
     * 收下它的后果是**静默的**：组展开那一段只会往执行 run 该有的字段上写，于是
     * 这条审核 run 看起来正常跑，而使用者以为自己"给这条审核指定了组"。所以这里
     * 必须当场拒，并且在错误里**点名 `groupId`**——不然使用者拿到的是"某条链路
     * 配置不合法"这种他没法动手的话。
     */
    const runId = ulid() as RunId
    const res = await submitRun(h, {
      runId,
      kind: 'review',
      agent: executor,
      workDir: await h.newWorkDir(),
      subject: { type: 'run', id: 'some-execute-run' },
      groupId: 'not-a-real-group',
    })
    assert.equal(res.status, 400, '★ 审核 run 不许带 groupId')
    assert.equal(res.body['code'], 'group_not_applicable')
    assert.match(String(res.body['error']), /groupId/, '错误里要点名那个字段')
    await assertNoGhostRun(h, runId)
  })

  test('★ 这一次没有审核者却带 allowedActions ⇒ 400 allowed_actions_without_reviewer，不入库', async () => {
    /**
     * 没有审核者就没有判决，也就**没有任何动作会被触发**——这份白名单没有落点。
     * 收下它会让使用者以为"我配了动作"，而这条链路上什么都不可能发生。
     *
     * 两种"没有审核者"都要被认出来，而且判据必须与 `autoChainReview` **同一套**
     * （两处各写一遍迟早分叉，而分叉的表现是"提交时说有审核者、跑完却没人审"）：
     *
     *   ① 执行者**不属于任何组**（`groupId` 省略），也没显式点名审核者；
     *   ② 这一次**显式** `reviewerAgentId: null`（"这次不自动审核"）。
     *
     * ⚠️ 2026-10：文案变了。原来这一档会区分"执行者没配「由谁来审它」/ 指向的人没了 /
     *    角色被改了"三种成因（那时"跟随执行者长期配置"是一条真实的路）。那条路随着
     *    `Agent.reviewerAgentId` 一起撤掉之后，**只剩一种成因**：这一次没有审核者。
     *    所以错误里不再点名某个 agent 的某个已经不存在的配置框，而是直说"没选组，
     *    或者这一次被显式设成了不审"——那两件事正是使用者能动手的地方。
     */
    const followId = ulid() as RunId
    const follow = await submitRun(h, {
      runId: followId,
      agent: lonely,
      workDir: await h.newWorkDir(),
      allowedActions: [installed],
    })
    assert.equal(follow.status, 400, '★ 执行者没配审核者 ⇒ 没有判决 ⇒ 白名单没有落点')
    assert.equal(follow.body['code'], 'allowed_actions_without_reviewer')
    /**
     * ★ 断言"缺的是**哪一环** + **去哪儿改**"，而不是某一句固定的话。
     *
     * ⚠️ 这段注释改过两次，两次都是跟着产品改的（不是把测试改绿）：
     *   ① 最早这一档只说"没有审核者"；
     *   ② 中间有一版区分三种成因（执行者没配 / 指向的人没了 / 角色被改了），
     *      因为那时"跟随执行者长期配置"是一条真实的路；
     *   ③ 2026-10 那条路连同 `Agent.reviewerAgentId` 一起撤掉，**只剩一种成因**：
     *      这一次没有审核者（没选组，或者被显式设成不审）。所以文案不再点名某个
     *      已经不存在的配置框，而是直说"没选智能体组"——那才是使用者能动手的地方。
     */
    assert.match(
      String(follow.body['error']),
      /没有审核者/,
      '要说清缺的是哪一环（这一档 = 没人审）',
    )
    assert.match(
      String(follow.body['error']),
      /智能体组/,
      '★ 还要指出**去哪儿改**：现在唯一的入口是"建任务时选一个组"',
    )
    await assertNoGhostRun(h, followId)

    const noneId = ulid() as RunId
    const none = await submitRun(h, {
      runId: noneId,
      agent: executor,
      workDir: await h.newWorkDir(),
      reviewerAgentId: null,
      allowedActions: [installed],
    })
    assert.equal(none.status, 400, '★ 这次明确不审 ⇒ 同样没有落点')
    assert.equal(none.body['code'], 'allowed_actions_without_reviewer')
    await assertNoGhostRun(h, noneId)
  })

  test('★ 组里的审核者**事后失效**（角色被改成 executor）⇒ 提交时 400，不许 202', async () => {
    /**
     * ══════════════════════════════════════════════════════════════════
     * 为什么"跟着组"这一路也必须查到与"显式指定"同样的深度
     * ══════════════════════════════════════════════════════════════════
     *
     * 组的形态（恰好 1 执行 + 1 审核）在**组的写入口**校验过一次，但那条校验管不了
     * 以后：`PATCH /api/agents/:id` 允许改角色，而没有任何一步会去清理引用它的组。
     * 于是"配好的一组、审核者后来被改成执行者"是一条**真实可达**的状态。
     *
     * 那时这条带白名单的提交如果**照样 202**，随后 `autoChainReview` 会发现"审核者
     * 角色不对"于是跳过审核（它会进通知中心，这点没问题）——但那份白名单就一个落点
     * 都没有了：没有判决，也就没有动作，而使用者以为"这一次我允许了它动手"。
     *
     * ⚠️ 2026-10：这一条原来是"跟随执行者长期配置的审核者事后失效"。承载物从
     *    `Agent.reviewerAgentId` 换成了**组**，而判据更强了一点：组的存在与形态在
     *    **每次派活时都再校验一遍**（`checkGroupShape`），所以错误来得更早、说得更清
     *    （点名是哪个组、谁是执行者、缺谁）。`allowed_actions_without_reviewer` 那个
     *    更笼统的 code 仍然守着"压根没有审核者"那一档（上一节）。
     */
    const late = await createAgent(h, {
      name: '审核者 C3（待会被改成执行者）',
      role: 'reviewer',
      reviewStandard: { body: '# C3 标准\n\n随便判判。' },
    })
    const followerId = await createAgent(h, {
      name: '执行者 C3（由组里的 C3 审）',
      role: 'executor',
    })
    const follower = { id: followerId, name: '执行者 C3（由组里的 C3 审）' }
    const brokenGroupId = await createChainGroup(
      { url: h.url },
      { name: 'C3 组', members: [followerId, late], allowedActions: [installed] },
    )

    // 提交**之前**先把角色改掉——这就是"配过、现在失效"那个真实场景。
    const patched = await fetch(`${h.url}/api/agents/${late}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'executor' }),
    })
    const patchedBody = await patched.text()
    assert.equal(patched.status, 200, `改角色应当成功：${patchedBody}`)
    assert.equal((JSON.parse(patchedBody) as { role: string }).role, 'executor')

    const runId = ulid() as RunId
    const res = await submitRun(h, {
      runId,
      agent: follower,
      groupId: brokenGroupId,
      workDir: await h.newWorkDir(),
      allowedActions: [installed],
    })
    assert.equal(res.status, 400, '★ 组里的审核者已经不能当审核者了 ⇒ 不许 202')
    assert.equal(
      res.body['code'],
      'group_shape_invalid',
      '★ 这是"组的形态坏了"（每次派活都再校验一遍），不是"没有审核者"',
    )
    assert.match(
      String(res.body['error']),
      /没有审核者/,
      '★ 要说清缺的是**审核者**这一环（不然使用者会去重新选人而看不出为什么）',
    )
    assert.match(String(res.body['error']), /C3 组/, '还要点名是**哪个组**坏了')
    await assertNoGhostRun(h, runId)
  })

  test('★ 动作对不上已安装的包 ⇒ 400 allowed_actions_unresolvable（没装 / 没声明），不入库', async () => {
    /**
     * ══════════════════════════════════════════════════════════════════
     * 为什么"跑起来再发现"这种错不能接受
     * ══════════════════════════════════════════════════════════════════
     *
     * 无人值守下，"策略里写的动作找不到实现"就是**每一次任务都以同一个原因失败**：
     * 判决被记为不合规、动作永远不产生，而那时既没有人能改，错误也指向不了配置。
     * 所以判据在**写入之前**就过一遍，与 agent 的「行动权限」完全同一套
     * （`parseAllowedActions`）——复用而不是重写，免得两处判据分叉。
     *
     * 两种坏值分开报，因为它们对应两种改法：
     *   · 包**没装** ⇒ 去装包（错误里点名是哪个包）；
     *   · 包装了但**没声明**这个动作名 ⇒ 多半是拼错了（错误里列出包里真正有哪些）。
     */
    // ① 包没装：`probe-nope` 这个 slug 在库里不存在
    const missingId = ulid() as RunId
    const missing = await submitRun(h, {
      runId: missingId,
      agent: executor,
      groupId,
      workDir: await h.newWorkDir(),
      allowedActions: ['probe-nope.do'],
    })
    assert.equal(missing.status, 400)
    assert.equal(missing.body['code'], 'allowed_actions_unresolvable')
    assert.match(String(missing.body['error']), /还没安装/, '要说清是"包没装"')
    assert.match(String(missing.body['error']), /probe-nope/, '还要点名是哪个包')
    await assertNoGhostRun(h, missingId)

    // ② 包装了、但这个动作名它没声明（拼错）
    const typoId = ulid() as RunId
    const typo = await submitRun(h, {
      runId: typoId,
      agent: executor,
      groupId,
      workDir: await h.newWorkDir(),
      allowedActions: ['wl-installed.nope'],
    })
    assert.equal(typo.status, 400)
    assert.equal(typo.body['code'], 'allowed_actions_unresolvable')
    assert.match(String(typo.body['error']), /没有声明/, '要说清是"包里没这个动作"')
    assert.match(String(typo.body['error']), /拼错/, '并给出最可能的原因（否则使用者只会去翻包清单）')
    assert.match(String(typo.body['error']), /wl-installed/, '以及是哪个包')
    await assertNoGhostRun(h, typoId)
  })

  test('★ 幽灵 run：三种 400 之后，run 列表与提交前**逐条一致**', async () => {
    /**
     * 上一条用例断言的是"我提交的那个 id 不在库里"。这一条的判据更粗也更狠：
     * **整个列表一个字节都不许变**——任何一条被静默创建的 run（哪怕 id 不同、
     * 哪怕状态是 `waiting_local_directory`）都会让它红。
     *
     * 为什么值得单独一条：校验写在 `insertRun` 之前，但这是个**位置**上的性质，
     * 而不是类型上的。谁哪天把校验挪到 `executor.submit()` 之后（那段代码本来就在
     * 一起，看着更"顺"），功能上一切照旧、400 也照旧返回——只有库里多出一条
     * 没有界面入口、却占着工作目录的 run。
     */
    const before = (await listRunRows(h)).map((r) => r.runId).sort()
    assert.deepEqual(before, [], '夹具前提：这个 daemon 里至今没有一条 run')

    const ids = [ulid() as RunId, ulid() as RunId, ulid() as RunId]
    const outcomes = [
      // ① 审核 run 上塞白名单
      // ⚠️ 这里**不带** `groupId`：审核 run 带组是另一条错（`group_not_applicable`），
      //    会先于动作白名单那条校验开火——那样这条用例数的就不是"三种坏值"了。
      await submitRun(h, {
        runId: ids[0]!,
        kind: 'review',
        agent: executor,
        workDir: await h.newWorkDir(),
        allowedActions: [installed],
      }),
      // ② **故意不带组**：这条测的就是"没有审核者"（`lonely` 不属于任何组）
      await submitRun(h, {
        runId: ids[1]!,
        agent: lonely,
        workDir: await h.newWorkDir(),
        allowedActions: [installed],
      }),
      // ③ 动作对不上已装包
      await submitRun(h, {
        runId: ids[2]!,
        agent: executor,
        groupId,
        workDir: await h.newWorkDir(),
        allowedActions: ['probe-nope.do'],
      }),
    ]
    assert.deepEqual(
      outcomes.map((o) => o.body['code']),
      ['allowed_actions_not_applicable', 'allowed_actions_without_reviewer', 'allowed_actions_unresolvable'],
      '三种坏值必须报三种不同的 code（它们对应三种改法）',
    )

    const after = (await listRunRows(h)).map((r) => r.runId).sort()
    assert.deepEqual(after, before, '★ 被拒的请求不许在库里留下任何一条 run')
    for (const id of ids) await assertNoGhostRun(h, id)
  })
})

// ══════════════════════════════════════════════════════════════════
// B. 它真的进判决契约与判决收口了
// ══════════════════════════════════════════════════════════════════

/**
 * A 组钉的是"决定存下来了、也带到审核侧了"。但**存下来 ≠ 生效**：这份白名单真正
 * 起作用的地方只有两处（都在 `executor.ts`），而它们都是"读 `run.allowedActions`"：
 *
 *   ① **渲染判决契约**：把这次允许的动作名列给模型。契约里没有的名字，模型永远写
 *      不出来——它合理的选择只剩"编一个"或"退化成 needs_human"，而"契约里没写枚举
 *      ⇒ 整条判决作废"这条失败史在本仓库真实发生过两次；
 *   ② **判决收口校验**（`decideReview` 的动作白名单）：模型写了不在名单里的动作时
 *      判不合规，而不是照跑。这一处是**权限的边界**，漏了它就是"界面上的勾选不起作用"。
 *
 * 所以这一组的每一条都走**真判决**：假后端吐一份带（或不带）动作的判决，然后看
 * 平台拿它怎么办。工具动作的脚本是真跑的（`testing/tool-fixture.ts`），产物落在
 * 工作目录里——"动作到底有没有落地"因此有硬证据，而不是靠断言某个函数被调用过。
 *
 * ⚠️ 一条用例一个 daemon：`backend.verdict` 是**全局**的预置，同一条用例里混着别的
 *    审核 run 的话，"谁读到了这份判决"就不确定了。
 */
describe('B. ★★ 白名单进判决契约与判决收口（真实链路）', () => {
  test('★★ 审核者配着动作、这一次白名单是空数组 ⇒ 契约明说"不要写 action"，且不列那个动作', async () => {
    /**
     * 这是"空数组有意义"的**唯一硬证据**。它同时钉住两件事：
     *
     *   1. 契约必须明说"这次不要写 `action`"——不说的话，模型会照旧去编一个动作名，
     *      而编出来的东西让**整条判决**（连同结论）被判不合规；
     *   2. 审核者**自己**那个动作不许出现在这一次的契约里。只做第 1 点是不够的：
     *      契约里既有"允许 A"又有"不要写 action"那种自相矛盾的文本，比缺一句话更糟。
     *
     * ⚠️ 判据读的是**审核 run 的日志**（`GET /api/runs/<id>/messages`），而不是
     *    假后端记下的 prompt：日志是使用者排查时唯一看得见的东西，它必须包含这段
     *    契约——契约不在日志里的话，"为什么模型不动手了"就永远查不出来。
     */
    const h = await startHarness('whitelist-b4')
    try {
      // 审核者**自己允许**这个动作（夹具默认值就是它）——所以下面那句"不许列出来"
      // 只可能来自这一次的空数组。
      const fx = await setupToolFixture(h.daemon, {
        slug: 'b4-tool',
        actionName: 'note',
        root: await h.newWorkDir('whitelist-b4-pkg'),
      })
      assert.deepEqual(fx.allowedActions, [fx.action], '夹具前提：审核者自己的权限里必须有这个动作')

      const workDir = await h.newWorkDir()
      const executeRunId = await submitExecute(h, {
        agent: fx.executor,
        workDir,
        // ★ 带组 ⇒ 组那份「行动权限」展开进这条 run（省略 `allowedActions` 时跟随它）
        groupId: fx.groupId,
        allowedActions: [],
      })
      const review = await waitForDerivedReview(h, executeRunId)
      const text = await waitForVerdictContract(h, review.runId)

      assert.match(
        text,
        /这次不要写/,
        '★ 这一次一个动作都不许 ⇒ 契约必须明说"不要写 action"，否则模型会去编一个',
      )
      assert.doesNotMatch(
        text,
        new RegExp(escapeRegExp(fx.action)),
        '★ 审核者自己那个动作不许被列进这一次的契约——列了就等于"这一次没收紧"',
      )

      // 反向对照：这一条审核 run 的记录上确实是空数组（A 组的结论在 B 组也成立）
      assert.deepEqual((await getRunRecord(h, review.runId))['allowedActions'], [])
    } finally {
      await h.close()
    }
  })

  test('★★ 审核者自己没有动作、这一次白名单给了已装包的动作 ⇒ 契约里**列出**它', async () => {
    /**
     * 反向那条：白名单不只是"收紧"，它也能**授予**——而这是同一个字段的同一份语义
     * （"这一次允许触发什么"）。若审核侧读的是审核者自己那份（而不是 `run` 上那份），
     * 这一条会以"契约里说这次不要写 action"失败。
     *
     * 两件事一起断：
     *   · 契约里出现 `` `type` 只能取：<动作> `` ——模型这才写得出这个名字；
     *   · 第三方动作的**开放参数**要一起列（`你只需要给：text`）。只给名字不给参数，
     *     模型要么少填（校验不过）、要么去猜平台的绑定参数（那正是"误操作"的温床）。
     */
    const h = await startHarness('whitelist-b5')
    try {
      // 审核者的「行动权限」**是空的**（D41 那套播种默认值），动作只能从这一次来。
      const fx = await setupToolFixture(h.daemon, {
        slug: 'b5-tool',
        actionName: 'mark',
        allowedActions: [],
        root: await h.newWorkDir('whitelist-b5-pkg'),
      })
      assert.deepEqual(fx.allowedActions, [], '夹具前提：审核者自己一个动作都不许')
      assert.deepEqual(
        await groupAllowedActions(h, fx.groupId),
        [],
        '夹具前提：组那份权限真的落库了（而且是**空**的——动作只能从这一次来）',
      )

      const workDir = await h.newWorkDir()
      const executeRunId = await submitExecute(h, {
        agent: fx.executor,
        workDir,
        // ★ 带组 ⇒ 组那份「行动权限」展开进这条 run（省略 `allowedActions` 时跟随它）
        groupId: fx.groupId,
        allowedActions: [fx.action],
      })
      const review = await waitForDerivedReview(h, executeRunId)
      const text = await waitForVerdictContract(h, review.runId)

      assert.match(
        text,
        new RegExp('`type` 只能取：' + escapeRegExp(fx.action)),
        '★ 这一次允许的动作要列进契约——契约里没有的取值，模型永远写不出来',
      )
      assert.match(text, /你只需要给/, '★ 还要说清哪些参数是**模型**该填的（绑定参数由平台注入）')
      assert.doesNotMatch(text, /这次不要写/, '★ 不是"一个都不许"，而是"这一次允许这一个"')

      assert.deepEqual(
        (await getRunRecord(h, review.runId))['allowedActions'],
        [fx.action],
        '决定要落在**审核 run** 上（契约与收口读的就是它）',
      )
    } finally {
      await h.close()
    }
  })

  test('★★ 判决里的动作不在这一次的白名单里 ⇒ 记为结构性不合规（不可重试），绝不执行', async () => {
    /**
     * ══════════════════════════════════════════════════════════════════
     * 这是权限的边界：契约说"不要写"，模型还是写了，平台怎么办
     * ══════════════════════════════════════════════════════════════════
     *
     * 必须**不执行**（否则白名单只是个建议），而且必须记为**结构性不合规**
     * （`isStructuralInvalid`）——"动作不在这个审核者的行动权限里"是**配置**问题，
     * 模型再输出一次还是同一个名字，重试只会重复烧 token。所以它走
     * `invalid → escalated`（要人介入 + 发通知），而**不是** retry。
     *
     * ⚠️ 这一条的分辨力来自夹具的对立面：审核者**自己**允许这个动作
     *    （`fx.allowedActions` 是它），所以"没执行"只可能是这一次的空数组拦下的。
     */
    const h = await startHarness('whitelist-b6a')
    try {
      const fx = await setupToolFixture(h.daemon, {
        slug: 'b6a-tool',
        actionName: 'note',
        root: await h.newWorkDir('whitelist-b6a-pkg'),
      })
      assert.deepEqual(fx.allowedActions, [fx.action], '夹具前提：审核者自己的权限里**有**这个动作')

      // 判决：通过，并且触发那个动作（`text` 是必需的开放参数——不给它的话，
      // 失败原因会变成"动作参数错"那一档，而那不是结构性，走的路径完全不同）
      h.backend.verdict = {
        ...PASS_VERDICT,
        action: verdictAction(fx.action, { text: '这一句不该落地' }),
      }

      const workDir = await h.newWorkDir()
      const executeRunId = await submitExecute(h, {
        agent: fx.executor,
        workDir,
        // ★ 带组 ⇒ 组那份「行动权限」展开进这条 run（省略 `allowedActions` 时跟随它）
        groupId: fx.groupId,
        allowedActions: [],
      })
      const review = await waitForDerivedReview(h, executeRunId)

      // 同步点：那句"不合规且重试无意义"由收口那一步写下来
      // ⚠️ 断言里原来带 `**`（markdown 粗体记号）：这句进日志、按纯文本显示，
      //    所以那两个星号会原样出现在界面上。2026-09 清掉了这类残留。
      const text = await waitForText(h, review.runId, /重试无意义/)
      assert.match(
        text,
        /不合规且重试无意义/,
        '★ 必须走"结构性 invalid"那条路（通知人），而不是重试或降级',
      )

      const verdicts = await listVerdicts(h, review.runId)
      assert.equal(verdicts.length, 1, '★ 结构性不合规不许重试 ⇒ 只该有一条判决')
      assert.equal(verdicts[0]?.status, 'escalated', '★ 判决记为不合规并要求人介入')
      assert.equal(verdicts[0]?.invalidResolution, 'escalate')
      assert.match(
        String(verdicts[0]?.escalateReason),
        /不在这个审核者的行动权限里/,
        '★ 错误信息要指对地方（不是"标准里没写"、也不是"模型格式不对"）',
      )
      assert.match(
        String(verdicts[0]?.escalateReason),
        /当前允许：无/,
        '★ 还要如实说出这一次允许的是**空的**——使用者据此才知道是白名单拦下的',
      )

      // ── 硬证据：动作一个都没产生，脚本一次都没跑 ──
      assert.deepEqual(
        await h.daemon.store.listActionsByVerdict(verdicts[0]!.id as never),
        [],
        '★ 不在白名单里的动作绝不许被执行',
      )
      assert.equal(
        (await derivedRuns(h, executeRunId)).filter((r) => r.kind === 'review').length,
        1,
        '★ 结构性 ⇒ 不可重试：不许再派生第二条审核 run',
      )
      const reviewRecord = await getRunRecord(h, review.runId)
      const inherited = String(reviewRecord['workDir'])
      assert.equal(inherited, workDir, '夹具前提：审核 run 继承被审那次执行的工作目录')
      await assert.rejects(
        readFile(join(inherited, 'fixture-out.txt'), 'utf8'),
        '★ 脚本不该被执行——"白名单拦下了"必须有落地证据，而不是只看状态',
      )
    } finally {
      await h.close()
    }
  })

  test('★★ 动作在这一次的白名单里 ⇒ 动作记录真的产生、脚本真的跑、状态正常', async () => {
    /**
     * 反向那条，而且是**授予**方向的最强形态：审核者自己的权限是**空的**，动作只能
     * 由这一次的白名单带来。这一条把"白名单在收口校验那一处真的被用上了"钉死：
     *
     *   · 若收口读的是审核者自己那份（空的）⇒ 判决会被判不合规，动作记录根本不产生；
     *   · 若契约读的是审核者自己那份 ⇒ 模型写不出这个名字（假后端是"照写"，
     *     所以这一条只覆盖收口那一处，契约那一处由上面 B5 覆盖）。
     *
     * 产物落在**被审那次执行**的工作目录里（`dir` 是绑定参数、由平台按事实注入），
     * 所以"动作真的落地了"是可验证的。
     */
    const h = await startHarness('whitelist-b6b')
    try {
      const fx = await setupToolFixture(h.daemon, {
        slug: 'b6b-tool',
        actionName: 'note',
        allowedActions: [],
        root: await h.newWorkDir('whitelist-b6b-pkg'),
      })
      assert.deepEqual(fx.allowedActions, [], '夹具前提：审核者自己一个动作都不许')

      h.backend.verdict = {
        ...PASS_VERDICT,
        action: verdictAction(fx.action, { text: '来自判决的一句话' }),
      }

      const workDir = await h.newWorkDir()
      const executeRunId = await submitExecute(h, {
        agent: fx.executor,
        workDir,
        // ★ 带组 ⇒ 组那份「行动权限」展开进这条 run（省略 `allowedActions` 时跟随它）
        groupId: fx.groupId,
        allowedActions: [fx.action],
      })
      const review = await waitForDerivedReview(h, executeRunId)

      const text = await waitForText(h, review.runId, /已派发/)
      assert.match(text, /已派发 1 个动作/, '★ 判决有效且有动作 ⇒ 派发，而不是被判不合规')

      const actions = await until(
        async () => {
          for (const verdict of await listVerdicts(h, review.runId)) {
            const found = (await h.daemon.store.listActionsByVerdict(verdict.id as never)).filter(
              (a) =>
                a.type === fx.action &&
                a.status !== 'executing' &&
                a.status !== 'proposed' &&
                a.status !== 'auto_approved',
            )
            if (found.length > 0) return found
          }
          return null
        },
        '动作记录到达终态',
      )
      assert.equal(actions[0]?.status, 'executed', '★ 这一条真的被执行')
      assert.equal(actions[0]?.params['text'], '来自判决的一句话', '模型给的开放参数要落下去')
      assert.equal(
        actions[0]?.params['dir'],
        workDir,
        '★ 绑定参数由平台按事实注入：应当是**被审那次执行**的工作目录',
      )

      // ── 硬证据：脚本真的往那个工作目录里写了东西 ──
      const written = await until(
        async () => readFile(join(workDir, 'fixture-out.txt'), 'utf8').catch(() => null),
        '脚本产物 fixture-out.txt',
      )
      assert.match(written, /来自判决的一句话/)

      // ── 页面看到的那一侧：判决已派发动作 + 动作 executed（阶段推导读的就是它）──
      //
      // ⚠️ 有动作的判决终态是 `dispatched_to_action`（不是 `validated`——那是派发
      //    **之前**的状态）。写错这个取值的后果是页面的阶段推导读不到"动作已派发"，
      //    而表现是"判决通过、动作也成功了，任务却一直显示在途"。
      const row = (await listRunRows(h)).find((r) => r.runId === review.runId)
      assert.equal(row?.verdict?.status, 'dispatched_to_action', '判决有效且已派发动作')
      assert.equal(row?.action?.status, 'executed')
      assert.equal(row?.action?.type, fx.action)

      assert.equal((await getRunRecord(h, executeRunId))['status'], 'completed', '执行那一路状态正常')
      assert.deepEqual((await getRunRecord(h, review.runId))['allowedActions'], [fx.action])
    } finally {
      await h.close()
    }
  })
})

// ══════════════════════════════════════════════════════════════════
// D. 能力标志：这个字段是**另一个**契约，所以要有自己的标志
// ══════════════════════════════════════════════════════════════════

/**
 * ★ 为什么 `task-action-whitelist` 不能与 `reviewer-override` 合成一个标志。
 *
 * 两者在同一次交付里一起来，看起来"总是一起在"。但它们是**两个字段、两份契约**，
 * 而合成一个会漏掉一个真实的中间态：daemon 认识 `reviewerAgentId`、还不认识
 * `allowedActions`（比如只重建了一半、或者回退到更早的构建）。那时页面会画出
 * ③ 的勾选框，而勾选**被静默丢掉**——请求体那层没有校验，未知字段直接忽略。
 * 使用者以为"这一次我允许了它动手"，实际什么都没发生，而两边都不报错。
 *
 * 这正是 `Capability.ReviewerOverride` 当年被加上的理由，一字不差地成立。
 * 这条测试钉住"标志确实报了"——少了它，页面会安静地退化成一个更少功能的版本，
 * 没有报错，也没有人知道功能丢了。
 */
describe('D. ★ 身份接口必须报出 `task-action-whitelist` 能力标志', () => {
  test('★ 页面据此才画 ③ 的勾选框（否则只读）', async () => {
    const h = await startHarness('whitelist-d')
    try {
      const res = await fetch(`${h.url}/api/identity`)
      const body = (await res.json()) as { capabilities?: string[] }
      assert.ok(Array.isArray(body.capabilities), '身份接口必须给出能力清单')
      assert.ok(
        body.capabilities.includes('task-action-whitelist'),
        `★ 缺了这个标志，页面就不给改 ③ 的动作了。实际：${JSON.stringify(body.capabilities)}`,
      )
      // ⚠️ 两个标志都要在：它们是两件事（一个"谁来审"、一个"这一次允许动什么"）
      assert.ok(
        body.capabilities.includes('reviewer-override'),
        '审核者覆盖的标志也不能少（它是另一个字段）',
      )
    } finally {
      await h.close()
    }
  })
})
