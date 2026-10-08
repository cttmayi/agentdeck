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
 * 动作的**固定参数**（`SubmitRunRequest.actionParams` / `Agent.actionParams`，D43）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它跟白名单（D42）是同一件事的两半，所以这个文件是那个文件的镜像
 * ══════════════════════════════════════════════════════════════════
 *
 * 白名单回答"这一次**能不能**触发它"，固定参数回答"触发它时**用什么参数**"。
 * 两条都是三态、省略语义完全相同（省略 = 跟随审核者长期那份；给了 = 只覆盖
 * 这一次），所以测试也按同一个骨架来：
 *
 *   - **省略** ⇒ 跟随审核者长期配的那份（`Agent.actionParams`）；
 *   - **给了对象** ⇒ 这一次就用这一份；
 *   - **空对象** ⇒ 这一次不固定任何参数（哪怕审核者长期固定了，也放开给模型填）。
 *
 * 固定参数的值由平台在**执行**时注入（与绑定值同一档），模型不许写——写了会被
 * 判**结构性不合规**（不可重试）：它不是模型手误，是越过了使用者明确钉下的边界。
 *
 * 用真实链路钉住：真的起 daemon、真的走 HTTP、真的派生审核 run、真的执行动作
 * 脚本（脚本只往工作目录写一个文件，它是不是"钉的那个值"就是唯一的硬证据）。
 * **NFR-T-01：绝不调用使用者真实安装的 agent CLI。**
 */

// ══════════════════════════════════════════════════════════════════
// 假后端（照抄 whitelist 文件的夹具：执行说人话，审核吐判决）
// ══════════════════════════════════════════════════════════════════

const PASS_VERDICT: Record<string, unknown> = {
  schemaVersion: 1,
  conclusion: 'pass',
  reasonCode: 'meets_criteria',
  confidence: 0.9,
  findings: [],
  action: null,
  escalateReason: null,
}

class ParamsBackend implements AgentBackend {
  readonly key = 'claude'
  readonly protocol = 'stream-json' as const
  readonly rejectDetectable = false
  verdict: Record<string, unknown> | null = PASS_VERDICT
  /** 投递出去的全部第一句话——契约断言从这里读。 */
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

interface Harness {
  daemon: DaemonHandle
  backend: ParamsBackend
  url: string
  newWorkDir(prefix?: string): Promise<string>
  close(): Promise<void>
}

async function startHarness(prefix: string): Promise<Harness> {
  const dir = await makeTempDir(prefix)
  const backend = new ParamsBackend()
  const daemon = await startDaemon({
    dataDir: dir,
    port: 0,
    fsync: false,
    workRoot: join(dir, 'workroot'),
    backend,
    onWarn: () => {},
    onInfo: () => {},
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
    actionParams?: Record<string, Record<string, unknown>>
    reviewerAgentId?: string | null
    /** ★ 智能体组（2026-10 起"谁审我 + 判完允许动什么"的唯一出处）。 */
    groupId?: string
  },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const payload: Record<string, unknown> = {
    runId: input.runId,
    kind: input.kind ?? 'execute',
    agentRef: { id: input.agent.id, name: input.agent.name, instructions: '' },
    skills: [],
    subject: input.subject ?? { type: 'issue', id: 'issue-params' },
    prompt: input.prompt ?? '把这次任务做完',
    workDir: input.workDir,
    limits: { maxTurns: null, timeoutMs: null },
  }
  if ('allowedActions' in input) payload['allowedActions'] = input.allowedActions
  if ('actionParams' in input) payload['actionParams'] = input.actionParams
  if ('reviewerAgentId' in input) payload['reviewerAgentId'] = input.reviewerAgentId
  if ('groupId' in input) payload['groupId'] = input.groupId

  const res = await fetch(`${h.url}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function submitExecute(
  h: Harness,
  input: {
    agent: { id: string; name: string }
    workDir: string
    allowedActions?: string[]
    actionParams?: Record<string, Record<string, unknown>>
    groupId?: string
  },
): Promise<RunId> {
  const runId = ulid() as RunId
  const res = await submitRun(h, { runId, ...input })
  assert.equal(res.status, 202, `受理必须返回 202，实际 ${res.status}：${JSON.stringify(res.body)}`)
  return runId
}

async function getRunRecord(h: Harness, runId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${h.url}/api/runs/${runId}`)
  assert.equal(res.status, 200, `run ${runId} 应当存在，实际 ${res.status}`)
  return (await res.json()) as Record<string, unknown>
}

interface RunRow {
  runId: string
  kind: string
  status: string
  subject?: { type: string; id: string }
}

async function listRunRows(h: Harness): Promise<RunRow[]> {
  const res = await fetch(`${h.url}/api/runs`)
  return ((await res.json()) as { runs: RunRow[] }).runs
}

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

async function until<T>(fn: () => Promise<T | null>, what: string, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn().catch(() => null)
    if (value !== null) return value
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

async function waitForDerivedReview(h: Harness, executeRunId: string): Promise<RunRow> {
  const found = await until(
    async () => (await derivedRuns(h, executeRunId)).find((r) => r.kind === 'review') ?? null,
    `run ${executeRunId} 派生审核`,
  )
  await waitForSettled(h, found.runId)
  return found
}

async function waitForText(
  h: Harness,
  runId: string,
  pattern: RegExp,
  timeoutMs = 10_000,
): Promise<string> {
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

async function createAgent(h: Harness, body: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${h.url}/api/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runtimeKey: 'claude', instructions: '', ...body }),
  })
  const created = (await res.json()) as { id?: string; error?: string }
  assert.equal(res.status, 201, `建 agent 失败：${JSON.stringify(created)}`)
  assert.ok(created.id, 'agent 必须带 id')
  return created.id
}

/** 审核那一路投递出去的第一句话（含判决契约）——固定参数的说辞从这儿读。 */
function reviewPrompt(h: Harness): string {
  const found = h.backend.prompts.find((p) => p.includes(VERDICT_FENCE_BEGIN))
  assert.ok(found, '审核那一路要真的被派过')
  return found
}

// ══════════════════════════════════════════════════════════════════
// A. 落库与「带下去」
// ══════════════════════════════════════════════════════════════════

describe('A. ★ 任务级固定参数：三态落库 + 带下去（与白名单同一个判据）', () => {
  let h: Harness
  let action: string
  let reviewerId: string
  let executor: { id: string; name: string }
  /** 把这一对串起来的组（带它提交才有审核者；省略 `actionParams` 时跟随它那份）。 */
  let groupId: string

  before(async () => {
    h = await startHarness('params-a')
    const pkgRoot = await h.newWorkDir('params-a-pkg')
    const pkg = await writeToolPackage({ slug: 'pa-tool', actionName: 'note', root: pkgRoot })
    await installToolPackage(h.daemon, pkg)
    action = pkg.action

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

    // ⚠️ 2026-10：这一对原来是"审核者带 `allowedActions` + `actionParams`、执行者带
    //    `reviewerAgentId`"。三个字段都已撤掉，同一件事现在由**组**表达：固定参数
    //    写在组上（`actionParams`），"谁审我"由成员表达。三态判据一个字没变，只是
    //    "省略时跟随"的那一份换了出处（以前跟随审核者，现在跟随**组**）。
    groupId = await createChainGroup(
      { url: h.url },
      {
        name: 'A 组',
        members: [executorId, reviewerId],
        allowedActions: [action],
        actionParams: { [action]: { text: '组的长期固定值' } },
      },
    )
  })

  after(async () => {
    await h.close()
  })

  test('★ 带 actionParams ⇒ 执行 run 与派生审核 run 的记录上都有这个键（原样带下去）', async () => {
    const workDir = await h.newWorkDir()
    const fixed = { [action]: { text: '这一次的值' } }
    // ★ 带组提交：组那份固定值是"组的长期固定值"，而这一次钉的是"这一次的值"
    //   ——这一条同时证明"覆盖优先"（顶掉的不是空，而是另一份有值的配置）
    const runId = await submitExecute(h, {
      agent: executor,
      workDir,
      allowedActions: [action],
      actionParams: fixed,
      groupId,
    })

    const executeRecord = await getRunRecord(h, runId)
    assert.equal('actionParams' in executeRecord, true, '★ 键必须在库里留痕（缺键 = "跟随"）')
    assert.deepEqual(executeRecord['actionParams'], fixed)

    const review = await waitForDerivedReview(h, runId)
    const reviewRecord = await getRunRecord(h, review.runId)
    assert.equal('actionParams' in reviewRecord, true, '★ 带下去那一站也不许掉键')
    assert.deepEqual(reviewRecord['actionParams'], fixed)
  })

  test('★ 省略 actionParams ⇒ 跟随**组**那份（两条 run 记录上都是组那份）', async () => {
    /**
     * ⚠️ 2026-10 判据变过，说清楚免得下次有人以为是在改测试凑绿：
     *
     *   以前"省略"跟随的是**审核者自己**的固定参数，而那份配置住在 agent 上
     *   ⇒ 省略时 run 记录上**不该有这个键**（键不在 = "使用者没说"）。
     *
     *   现在那份长期配置住在**组**上，由 `POST /api/runs` 展开成 run 上的字段
     *   （`if (body.actionParams === undefined) body.actionParams = group.actionParams`）
     *   ⇒ 省略的结果是 run 上**有值**，值是**组那份**。
     *
     * ★ 仍然要防的错一个字没变：把"省略"折成"这一次不固定任何参数"（在
     *   `executor.submit` 或 `autoChainReview` 里写 `?? {}`）。那种折法的表现是
     *   "组里钉好的值全部失效、模型又开始自己编参数"，而 run 状态一切正常、
     *   日志里没有一个字解释为什么——**没有任何地方会报错**。判据因此从"键不在"
     *   变成"值等于组那份"：折成 `{}` 或者折成缺键都会在这里红。
     */
    const workDir = await h.newWorkDir()
    const runId = await submitExecute(h, {
      agent: executor,
      workDir,
      allowedActions: [action],
      groupId,
    })

    const executeRecord = await getRunRecord(h, runId)
    assert.deepEqual(
      executeRecord['actionParams'],
      { [action]: { text: '组的长期固定值' } },
      '★ 省略 ⇒ 跟随**组**那份（折成 `{}` 或折成缺键都会在这里红）',
    )
    const review = await waitForDerivedReview(h, runId)
    const reviewRecord = await getRunRecord(h, review.runId)
    assert.deepEqual(
      reviewRecord['actionParams'],
      { [action]: { text: '组的长期固定值' } },
      '★ 派生出来的审核 run 要拿到同一份（它才是这份配置生效的地方）',
    )
  })

  test('★ 带空对象 ⇒ 键在、值是 {}（"这一次不固定任何参数"是**明确的选择**，顶掉审核者长期那份）', async () => {
    const workDir = await h.newWorkDir()
    const runId = await submitExecute(h, {
      agent: executor,
      workDir,
      allowedActions: [action],
      actionParams: {},
      groupId,
    })

    const executeRecord = await getRunRecord(h, runId)
    assert.equal('actionParams' in executeRecord, true)
    assert.deepEqual(executeRecord['actionParams'], {})
    const review = await waitForDerivedReview(h, runId)
    assert.deepEqual((await getRunRecord(h, review.runId))['actionParams'], {})
  })
})

// ══════════════════════════════════════════════════════════════════
// B. 保存时校验：写入口（agent POST/PATCH）与提交入口（POST /runs）
// ══════════════════════════════════════════════════════════════════

/**
 * ══════════════════════════════════════════════════════════════════
 * ⚠️ 这一块原来测的是**agent 的写入口**（`POST/PATCH /api/agents` 上的
 *    `allowedActions` / `actionParams`）
 * ══════════════════════════════════════════════════════════════════
 *
 * 2026-10 起动作权限与固定参数**只属于智能体组**，所以写入口搬到了
 * `POST/PATCH /api/agent-groups`。校验逻辑一个字没变（同一个
 * `parseAllowedActions` / 同一套参数判据），所以这一块**跟着写入口走**：
 * 它守的是"哪些固定参数被接受/被拒"，不是某一个 URL。这样搬家之后矩阵仍然是满的。
 *
 * ── 两条用例**删掉**了（它们的对象不再存在，理由写在这里）──
 *
 *   · 「agent POST：执行者带固定参数 ⇒ 400」（"执行者的能力是工具"）；
 *   · 「审核者带着参数改执行者 ⇒ 400 + 先清空再改角色」。
 *
 * 它们守的是"只有**审核者**才配得上动作权限与固定参数"这条角色规矩。现在这些东西
 * 挂在**组**上，而组按形态**必然**是 1 执行 + 1 审核——角色与参数之间不再有可判的
 * 关系，那条规矩**没有可判的东西了**（`rejectActionsForExecutor` 随字段一起删掉了）。
 *
 * ⚠️ 但它防过的那件事仍然成立、只是换了位置：执行者拿不到固定参数，因为执行者身上
 *    根本没有这个字段（写进 `POST /api/agents` 就是 400「不认识的字段」——那条在
 *    `agents-create.test.ts` 里钉着）。
 */
describe('B. ★ 固定参数的写入口校验：动作要对得上已装包、参数必须是 open 且值合规', () => {
  /** 建一对"执行者 + 审核者"（组的形态必须是恰好 1+1），返回它们的 id。 */
  async function makePair(h: Harness): Promise<[string, string]> {
    const executor = await createAgent(h, { name: '组里的执行者', role: 'executor' })
    const reviewer = await createAgent(h, {
      name: '组里的审核者',
      role: 'reviewer',
      reviewStandard: { body: '正文' },
    })
    return [executor, reviewer]
  }

  /** 往组的写入口发一份请求（本块所有用例的观测点）。 */
  async function postGroup(
    h: Harness,
    extra: Record<string, unknown>,
    method: 'POST' | 'PATCH' = 'POST',
    groupId?: string,
  ): Promise<{ status: number; body: { error?: string; group?: { id: string } } }> {
    const members = method === 'POST' ? await makePair(h) : undefined
    const res = await fetch(
      method === 'POST' ? `${h.url}/api/agent-groups` : `${h.url}/api/agent-groups/${groupId}`,
      {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(members === undefined ? {} : { name: '参数测试组', members }),
          ...extra,
        }),
      },
    )
    return { status: res.status, body: (await res.json()) as { error?: string; group?: { id: string } } }
  }

  test('★ 组 POST：绑定参数名不能钉（bound 是平台的事实）⇒ 400', async () => {
    const h = await startHarness('params-b1')
    try {
      const pkgRoot = await h.newWorkDir('params-b1-pkg')
      const pkg = await writeToolPackage({ slug: 'pb1-tool', actionName: 'note', root: pkgRoot })
      await installToolPackage(h.daemon, pkg)
      const res = await postGroup(h, {
        allowedActions: [pkg.action],
        actionParams: { [pkg.action]: { dir: '/tmp/x' } },
      })
      assert.equal(res.status, 400, '绑定参数不归使用者钉，必须被拒')
      assert.match(String(res.body.error), /不归使用者钉/)
    } finally {
      await h.close()
    }
  })

  test('★ 组 POST：值不合规（超上限）⇒ 400，与模型填**同一套**取值判据', async () => {
    const h = await startHarness('params-b2')
    try {
      const pkgRoot = await h.newWorkDir('params-b2-pkg')
      const pkg = await writeToolPackage({ slug: 'pb2-tool', actionName: 'note', root: pkgRoot })
      await installToolPackage(h.daemon, pkg)
      const res = await postGroup(h, {
        allowedActions: [pkg.action],
        actionParams: { [pkg.action]: { text: 'x'.repeat(3000) } },
      })
      assert.equal(res.status, 400)
      assert.match(String(res.body.error), /动作参数 text/)
    } finally {
      await h.close()
    }
  })

  test('★ 组 POST：动作对不上已安装的包 ⇒ 400（与 allowedActions 同一条判据）', async () => {
    const h = await startHarness('params-b3')
    try {
      const res = await postGroup(h, {
        actionParams: { 'ghost-pkg.note': { text: 'x' } },
      })
      assert.equal(res.status, 400)
      assert.match(String(res.body.error), /还没安装/)
    } finally {
      await h.close()
    }
  })

  test('★ 组 PATCH：改出不合规的固定参数 ⇒ 400（存量那份原样留着）', async () => {
    const h = await startHarness('params-b5')
    try {
      const pkgRoot = await h.newWorkDir('params-b5-pkg')
      const pkg = await writeToolPackage({ slug: 'pb5-tool', actionName: 'note', root: pkgRoot })
      await installToolPackage(h.daemon, pkg)
      const created = await postGroup(h, {
        allowedActions: [pkg.action],
        actionParams: { [pkg.action]: { text: '合规值' } },
      })
      assert.equal(created.status, 201, JSON.stringify(created.body))
      // ⚠️ 用**建出来的那条组**的 id：`postGroup` 内部自己造了一对成员，拿外面
      //    另造的一对去列表里找会找不到（第一版就是这么错的）。
      const groupId = created.body.group!.id

      const bad = await postGroup(
        h,
        { actionParams: { [pkg.action]: { text: 'x'.repeat(3000) } } },
        'PATCH',
        groupId,
      )
      assert.equal(bad.status, 400, 'PATCH 写入口必须校验固定参数')
      assert.match(String(bad.body.error), /动作参数 text/)

      // 拒了就不能动到存量那份（与"拒了不留痕"同一条纪律）
      const after = (await (
        await fetch(`${h.url}/api/agent-groups/${groupId}`)
      ).json()) as { group: { actionParams: Record<string, Record<string, unknown>> } }
      assert.deepEqual(
        after.group.actionParams,
        { [pkg.action]: { text: '合规值' } },
        '★ 被拒的请求不许改到库里那份',
      )
    } finally {
      await h.close()
    }
  })

  test('★ POST /runs：kind 不是 execute ⇒ 400；没有审核者 ⇒ 400；动作没装 ⇒ 400，且都不入库', async () => {
    const h = await startHarness('params-b6')
    try {
      const pkgRoot = await h.newWorkDir('params-b6-pkg')
      const pkg = await writeToolPackage({ slug: 'pb6-tool', actionName: 'note', root: pkgRoot })
      await installToolPackage(h.daemon, pkg)
      const reviewerId = await createAgent(h, {
        name: '审核者 B6',
        role: 'reviewer',
        reviewStandard: { body: '正文' },
      })
      const executorId = await createAgent(h, { name: '执行者 B', role: 'executor' })
      const agent = { id: executorId, name: '执行者 B' }
      // ★ 第三个 case 要有**能用的审核者**，否则会在更早的"没有审核者"那一关被拦下。
      //   2026-10 起"能用的审核者"有两条路：带组，或者 run 上**显式**点名一个。
      //   这里刻意用**显式点名**那条（它没有组，也就没有组那份参数来顶掉这一次的）。
      const groupId = await createChainGroup(
        { url: h.url },
        { name: 'B6 组', members: [executorId, reviewerId], allowedActions: [pkg.action] },
      )
      const workDir = await h.newWorkDir()
      const fixed = { [pkg.action]: { text: 'x' } }

      const cases: Array<{
        runId: RunId
        patch: Record<string, unknown>
        code: string
      }> = [
        {
          runId: ulid() as RunId,
          // ⚠️ 审核 run 上**既**不能带 `actionParams`、也不能带组（组描述的是执行链）
          patch: { kind: 'review', actionParams: fixed },
          code: 'allowed_actions_not_applicable',
        },
        {
          runId: ulid() as RunId,
          patch: { reviewerAgentId: null, actionParams: fixed },
          code: 'allowed_actions_without_reviewer',
        },
        {
          runId: ulid() as RunId,
          patch: { groupId, actionParams: { 'ghost-pkg.note': { text: 'x' } } },
          code: 'action_params_unresolvable',
        },
      ]

      for (const c of cases) {
        const res = await submitRun(h, {
          runId: c.runId,
          workDir,
          agent,
          ...(c.patch as {
            kind?: string
            reviewerAgentId?: null
            groupId?: string
            actionParams?: Record<string, Record<string, unknown>>
          }),
        })
        assert.equal(res.status, 400, `应 400：${JSON.stringify(c.patch)}`)
        assert.equal((res.body as { code?: string }).code, c.code)
        const rows = await listRunRows(h)
        assert.equal(rows.some((r) => r.runId === c.runId), false, `★ 幽灵 run：${c.runId} 不许入库`)
      }
    } finally {
      await h.close()
    }
  })
})

describe('C. ★★ 固定参数的真实链路：契约说"已固定不要写"、执行注入钉的值', () => {
  test('★★ 审核者长期固定了参数；这一次省略 ⇒ 用长期那份（契约减去它、执行注入它）', async () => {
    const h = await startHarness('params-c1')
    try {
      const fx = await setupToolFixture(h.daemon, {
        slug: 'pc1-tool',
        actionName: 'note',
        root: await h.newWorkDir('params-c1-pkg'),
      })
      // 组的长期固定 `text`（它是必填的 open 参数——固定后模型**不该**再给）
      //
      // ⚠️ 2026-10：这份长期参数原来钉在**审核者 agent** 上（`Agent.actionParams`），
      //    现在钉在**组**上——"审完能动手时用什么参数"是这条链的配置，不是某个人的。
      const res = await fetch(`${h.url}/api/agent-groups/${fx.groupId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actionParams: { [fx.action]: { text: '长期钉的值' } } }),
      })
      assert.equal(res.status, 200, '给组钉长期固定参数应当成功')

      // 判决：触发动作，但**不写 text**（它已固定，契约说了不要写）
      h.backend.verdict = { ...PASS_VERDICT, action: verdictAction(fx.action, {}) }

      const workDir = await h.newWorkDir()
      const executeRunId = await submitExecute(h, {
        agent: fx.executor,
        workDir,
        groupId: fx.groupId,
      })
      const review = await waitForDerivedReview(h, executeRunId)

      // ── 契约：固定参数不进"你只需要给"、单独说"已固定，不要写" ──
      const prompt = reviewPrompt(h)
      assert.match(prompt, /`text` 已由使用者在界面上固定为 "长期钉的值"/, '契约必须说出口固定值')
      assert.doesNotMatch(prompt, /你只需要给[^\n]*text/, '固定参数不能再列给模型填')
      assert.match(prompt, /不要写它/, '必须说"不要写"——否则模型会去猜')

      // ── 执行：注入的是钉的那个值（硬证据：脚本往工作目录写了它） ──
      const written = await until(
        async () => readFile(join(workDir, 'fixture-out.txt'), 'utf8').catch(() => null),
        '脚本产物 fixture-out.txt',
      )
      assert.match(written, /长期钉的值/, '★ 执行注入的必须是使用者的固定值，而不是模型猜的')

      // 动作记录里也要能看见固定值
      const verdicts = (await (await fetch(`${h.url}/api/runs/${review.runId}/verdicts`)).json()) as {
        verdicts: Array<{ id: string }>
      }
      const actions = await h.daemon.store.listActionsByVerdict(verdicts.verdicts[0]!.id as never)
      assert.equal(actions[0]?.params['text'], '长期钉的值')
      assert.equal(actions[0]?.params['dir'], workDir, '绑定参数照旧注入')
    } finally {
      await h.close()
    }
  })

  test('★★ 任务级固定参数顶掉审核者长期那份（这一次钉的值生效）', async () => {
    const h = await startHarness('params-c2')
    try {
      const fx = await setupToolFixture(h.daemon, {
        slug: 'pc2-tool',
        actionName: 'note',
        root: await h.newWorkDir('params-c2-pkg'),
      })
      // ⚠️ 2026-10：长期参数钉在**组**上（原来钉在审核者 agent 上）
      await fetch(`${h.url}/api/agent-groups/${fx.groupId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actionParams: { [fx.action]: { text: '长期钉的值' } } }),
      })

      h.backend.verdict = { ...PASS_VERDICT, action: verdictAction(fx.action, {}) }

      const workDir = await h.newWorkDir()
      const executeRunId = await submitExecute(h, {
        agent: fx.executor,
        workDir,
        actionParams: { [fx.action]: { text: '这一次的值' } },
        groupId: fx.groupId,
      })
      const review = await waitForDerivedReview(h, executeRunId)

      const prompt = reviewPrompt(h)
      assert.match(prompt, /`text` 已由使用者在界面上固定为 "这一次的值"/, '★ 任务级覆盖必须赢')

      const written = await until(
        async () => readFile(join(workDir, 'fixture-out.txt'), 'utf8').catch(() => null),
        '脚本产物 fixture-out.txt',
      )
      assert.match(written, /这一次的值/)
      assert.doesNotMatch(written, /长期钉的值/, '长期那份不该漏进这一次的执行')
    } finally {
      await h.close()
    }
  })

  test('★★ 任务级空对象顶掉审核者长期那份：契约不列"已固定"、参数交还给模型填', async () => {
    const h = await startHarness('params-c3')
    try {
      const fx = await setupToolFixture(h.daemon, {
        slug: 'pc3-tool',
        actionName: 'note',
        root: await h.newWorkDir('params-c3-pkg'),
      })
      // ⚠️ 2026-10：长期参数钉在**组**上（原来钉在审核者 agent 上）
      await fetch(`${h.url}/api/agent-groups/${fx.groupId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actionParams: { [fx.action]: { text: '长期钉的值' } } }),
      })

      // 这一次不固定任何参数 ⇒ text 交还给模型填（判决里给出）
      h.backend.verdict = {
        ...PASS_VERDICT,
        action: verdictAction(fx.action, { text: '模型自己填的' }),
      }

      const workDir = await h.newWorkDir()
      const executeRunId = await submitExecute(h, {
        agent: fx.executor,
        workDir,
        actionParams: {},
        groupId: fx.groupId,
      })
      const review = await waitForDerivedReview(h, executeRunId)

      const prompt = reviewPrompt(h)
      assert.doesNotMatch(prompt, /已由使用者在界面上固定为/, '★ 空对象 = 放开：不许再说"已固定"')
      assert.match(prompt, /你只需要给[^\n]*text/, '★ 参数交还给模型填，契约必须列它')

      const written = await until(
        async () => readFile(join(workDir, 'fixture-out.txt'), 'utf8').catch(() => null),
        '脚本产物 fixture-out.txt',
      )
      assert.match(written, /模型自己填的/, '模型填的值生效（没被固定值顶掉）')
    } finally {
      await h.close()
    }
  })
})

// ══════════════════════════════════════════════════════════════════
// D. 模型写固定参数 ⇒ 结构性不合规（不可重试）
// ══════════════════════════════════════════════════════════════════

describe('D. ★★ 模型越界写固定参数 ⇒ 结构性 invalid（不是手误，不许重试）', () => {
  test('★★ 判决里写了已固定的参数名 ⇒ escalated，且不再派生第二条审核 run', async () => {
    const h = await startHarness('params-d1')
    try {
      const fx = await setupToolFixture(h.daemon, {
        slug: 'pd1-tool',
        actionName: 'note',
        root: await h.newWorkDir('params-d1-pkg'),
      })
      // ⚠️ 2026-10：长期参数钉在**组**上（原来钉在审核者 agent 上）
      await fetch(`${h.url}/api/agent-groups/${fx.groupId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actionParams: { [fx.action]: { text: '固定值' } } }),
      })

      // 模型无视契约，照旧写了 text（它已固定，模型不许写）
      h.backend.verdict = {
        ...PASS_VERDICT,
        action: verdictAction(fx.action, { text: '模型越界写的' }),
      }

      const workDir = await h.newWorkDir()
      const executeRunId = await submitExecute(h, {
        agent: fx.executor,
        workDir,
        groupId: fx.groupId,
      })
      const review = await waitForDerivedReview(h, executeRunId)

      // 同步点：结构性 ⇒ "重试无意义"那句由收口写下来
      const text = await waitForText(h, review.runId, /重试无意义/)
      // ⚠️ 这里原来钉的是 `不合规且**重试无意义**`——两个星号是 markdown 的粗体记号，
      //    而这句进的是**日志**（RunLog 逐行原样显示），所以在界面上它就是两个星号。
      //    2026-09 把这类残留从运行时文案里清掉了，断言的意图一个字没变。
      assert.match(text, /不合规且重试无意义/)

      const verdicts = (
        (await (await fetch(`${h.url}/api/runs/${review.runId}/verdicts`)).json()) as {
          verdicts: Array<{
            id: string
            status: string
            invalidResolution: string | null
            escalateReason: string | null
          }>
        }
      ).verdicts
      assert.equal(verdicts.length, 1, '★ 结构性不许重试 ⇒ 只该有一条判决')
      assert.equal(verdicts[0]?.status, 'escalated')
      assert.equal(verdicts[0]?.invalidResolution, 'escalate')
      assert.match(
        String(verdicts[0]?.escalateReason),
        /已由使用者在界面上固定为/,
        '★ 要指对地方：不是"未知参数"、也不是"格式不对"，而是"这个参数被固定了"',
      )

      // 硬证据：动作一个都没产生、没有第二条审核 run
      assert.deepEqual(
        await h.daemon.store.listActionsByVerdict(verdicts[0]!.id as never),
        [],
        '★ 越界判决绝不许执行',
      )
      assert.equal(
        (await derivedRuns(h, executeRunId)).filter((r) => r.kind === 'review').length,
        1,
        '★ 结构性 ⇒ 不可重试：不许再派生第二条审核 run',
      )
      await assert.rejects(
        readFile(join(workDir, 'fixture-out.txt'), 'utf8'),
        '★ 脚本不该被执行',
      )
    } finally {
      await h.close()
    }
  })
})
