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

  before(async () => {
    h = await startHarness('params-a')
    const pkgRoot = await h.newWorkDir('params-a-pkg')
    const pkg = await writeToolPackage({ slug: 'pa-tool', actionName: 'note', root: pkgRoot })
    await installToolPackage(h.daemon, pkg)
    action = pkg.action

    reviewerId = await createAgent(h, {
      name: '审核者 A（自己固定了一个参数）',
      role: 'reviewer',
      allowedActions: [action],
      actionParams: { [action]: { text: '审核者长期的固定值' } },
      reviewStandard: { body: '# A 标准\n\n只要产出不为空就算通过。' },
    })
    executor = {
      id: await createAgent(h, {
        name: '执行者 A（长期由审核者 A 审）',
        role: 'executor',
        reviewerAgentId: reviewerId,
      }),
      name: '执行者 A（长期由审核者 A 审）',
    }
  })

  after(async () => {
    await h.close()
  })

  test('★ 带 actionParams ⇒ 执行 run 与派生审核 run 的记录上都有这个键（原样带下去）', async () => {
    const workDir = await h.newWorkDir()
    const fixed = { [action]: { text: '这一次的值' } }
    const runId = await submitExecute(h, {
      agent: executor,
      workDir,
      allowedActions: [action],
      actionParams: fixed,
    })

    const executeRecord = await getRunRecord(h, runId)
    assert.equal('actionParams' in executeRecord, true, '★ 键必须在库里留痕（缺键 = "跟随"）')
    assert.deepEqual(executeRecord['actionParams'], fixed)

    const review = await waitForDerivedReview(h, runId)
    const reviewRecord = await getRunRecord(h, review.runId)
    assert.equal('actionParams' in reviewRecord, true, '★ 带下去那一站也不许掉键')
    assert.deepEqual(reviewRecord['actionParams'], fixed)
  })

  test('★ 省略 actionParams ⇒ 两条 run 记录上都没有这个键（"跟随"绝不能变成空对象）', async () => {
    const workDir = await h.newWorkDir()
    const runId = await submitExecute(h, {
      agent: executor,
      workDir,
      allowedActions: [action],
    })

    const executeRecord = await getRunRecord(h, runId)
    assert.equal('actionParams' in executeRecord, false, '★ 省略 = 跟随，键不许出现')
    const review = await waitForDerivedReview(h, runId)
    const reviewRecord = await getRunRecord(h, review.runId)
    assert.equal('actionParams' in reviewRecord, false, '★ 带下去那一站同样不许补出空对象')
  })

  test('★ 带空对象 ⇒ 键在、值是 {}（"这一次不固定任何参数"是**明确的选择**，顶掉审核者长期那份）', async () => {
    const workDir = await h.newWorkDir()
    const runId = await submitExecute(h, {
      agent: executor,
      workDir,
      allowedActions: [action],
      actionParams: {},
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

describe('B. ★ 固定参数的写入口校验：动作要对得上已装包、参数必须是 open 且值合规、只属于审核者', () => {
  test('★ agent POST：绑定参数名不能钉（bound 是平台的事实）⇒ 400', async () => {
    const h = await startHarness('params-b1')
    try {
      const pkgRoot = await h.newWorkDir('params-b1-pkg')
      const pkg = await writeToolPackage({ slug: 'pb1-tool', actionName: 'note', root: pkgRoot })
      await installToolPackage(h.daemon, pkg)
      const res = await fetch(`${h.url}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: '想钉绑定参数的人',
          role: 'reviewer',
          runtimeKey: 'claude',
          allowedActions: [pkg.action],
          actionParams: { [pkg.action]: { dir: '/tmp/x' } },
          reviewStandard: { body: '正文' },
        }),
      })
      assert.equal(res.status, 400, '绑定参数不归使用者钉，必须被拒')
      const body = (await res.json()) as { error: string }
      assert.match(body.error, /不归使用者钉/)
    } finally {
      await h.close()
    }
  })

  test('★ agent POST：值不合规（超上限）⇒ 400，与模型填**同一套**取值判据', async () => {
    const h = await startHarness('params-b2')
    try {
      const pkgRoot = await h.newWorkDir('params-b2-pkg')
      const pkg = await writeToolPackage({ slug: 'pb2-tool', actionName: 'note', root: pkgRoot })
      await installToolPackage(h.daemon, pkg)
      const res = await fetch(`${h.url}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: '想钉超长值的人',
          role: 'reviewer',
          runtimeKey: 'claude',
          allowedActions: [pkg.action],
          actionParams: { [pkg.action]: { text: 'x'.repeat(3000) } },
          reviewStandard: { body: '正文' },
        }),
      })
      assert.equal(res.status, 400)
      const body = (await res.json()) as { error: string }
      assert.match(body.error, /动作参数 text/)
    } finally {
      await h.close()
    }
  })

  test('★ agent POST：动作对不上已安装的包 ⇒ 400（与 allowedActions 同一条判据）', async () => {
    const h = await startHarness('params-b3')
    try {
      const res = await fetch(`${h.url}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: '想钉一个没装的包',
          role: 'reviewer',
          runtimeKey: 'claude',
          actionParams: { 'ghost-pkg.note': { text: 'x' } },
          reviewStandard: { body: '正文' },
        }),
      })
      assert.equal(res.status, 400)
      const body = (await res.json()) as { error: string }
      assert.match(body.error, /还没安装/)
    } finally {
      await h.close()
    }
  })

  test('★ agent POST：执行者带固定参数 ⇒ 400（执行者的能力是工具，动作不是它的）', async () => {
    const h = await startHarness('params-b4')
    try {
      const pkgRoot = await h.newWorkDir('params-b4-pkg')
      const pkg = await writeToolPackage({ slug: 'pb4-tool', actionName: 'note', root: pkgRoot })
      await installToolPackage(h.daemon, pkg)
      const res = await fetch(`${h.url}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: '想钉参数的执行者',
          role: 'executor',
          runtimeKey: 'claude',
          actionParams: { [pkg.action]: { text: 'x' } },
        }),
      })
      assert.equal(res.status, 400)
      const body = (await res.json()) as { error: string }
      assert.match(body.error, /执行者/)
    } finally {
      await h.close()
    }
  })

  test('★ agent PATCH：改出不合规的固定参数 ⇒ 400；审核者带着参数改执行者 ⇒ 400', async () => {
    const h = await startHarness('params-b5')
    try {
      const pkgRoot = await h.newWorkDir('params-b5-pkg')
      const pkg = await writeToolPackage({ slug: 'pb5-tool', actionName: 'note', root: pkgRoot })
      await installToolPackage(h.daemon, pkg)
      const reviewerId = await createAgent(h, {
        name: '审核者 B',
        role: 'reviewer',
        allowedActions: [pkg.action],
        actionParams: { [pkg.action]: { text: '合规值' } },
        reviewStandard: { body: '正文' },
      })

      // 改成超长值 ⇒ 400
      const bad = await fetch(`${h.url}/api/agents/${reviewerId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          actionParams: { [pkg.action]: { text: 'x'.repeat(3000) } },
        }),
      })
      assert.equal(bad.status, 400, 'PATCH 写入口必须校验固定参数')

      // 带着固定参数把角色改成执行者 ⇒ 400（动作连执行者都不许有，钉值更无从谈起）
      const role = await fetch(`${h.url}/api/agents/${reviewerId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'executor' }),
      })
      assert.equal(role.status, 400, '审核者带着固定参数改执行者必须被拒')
      const roleBody = (await role.json()) as { error: string }
      assert.match(roleBody.error, /固定参数/)

      // 先清空**动作权限与固定参数**再改角色 ⇒ 合法（那条路必须永远开着；
      // 只清参数还不够——审核者还挂着动作，执行者连动作都不能有）
      const clear = await fetch(`${h.url}/api/agents/${reviewerId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actionParams: {}, allowedActions: [] }),
      })
      assert.equal(clear.status, 200)
      const okRole = await fetch(`${h.url}/api/agents/${reviewerId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'executor' }),
      })
      assert.equal(okRole.status, 200, '清空后改角色必须放行')
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
      const workDir = await h.newWorkDir()
      const fixed = { [pkg.action]: { text: 'x' } }

      const cases: Array<{ runId: RunId; patch: Record<string, unknown>; code: string }> = [
        {
          runId: ulid() as RunId,
          patch: { kind: 'review', actionParams: fixed },
          code: 'allowed_actions_not_applicable',
        },
        {
          runId: ulid() as RunId,
          patch: { reviewerAgentId: null, actionParams: fixed },
          code: 'allowed_actions_without_reviewer',
        },
        {
          // ★ 第三个 case 要有**能用的审核者**（这次显式指定），否则会在更早的
          //    "没有审核者"那一关被拦下，测不到"动作没装"这条。
          runId: ulid() as RunId,
          patch: { reviewerAgentId: reviewerId, actionParams: { 'ghost-pkg.note': { text: 'x' } } },
          code: 'action_params_unresolvable',
        },
      ]

      for (const c of cases) {
        const res = await submitRun(h, {
          runId: c.runId,
          workDir,
          agent,
          ...(c.patch as { kind?: string; reviewerAgentId?: null; actionParams?: Record<string, Record<string, unknown>> }),
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

// ══════════════════════════════════════════════════════════════════
// C. 任务级覆盖优先：契约减去固定参数 + 执行注入固定值（真实链路）
// ══════════════════════════════════════════════════════════════════

describe('C. ★★ 固定参数的真实链路：契约说"已固定不要写"、执行注入钉的值', () => {
  test('★★ 审核者长期固定了参数；这一次省略 ⇒ 用长期那份（契约减去它、执行注入它）', async () => {
    const h = await startHarness('params-c1')
    try {
      const fx = await setupToolFixture(h.daemon, {
        slug: 'pc1-tool',
        actionName: 'note',
        root: await h.newWorkDir('params-c1-pkg'),
      })
      // 审核者长期固定 `text`（它是必填的 open 参数——固定后模型**不该**再给）
      const res = await fetch(`${h.url}/api/agents/${fx.reviewer.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actionParams: { [fx.action]: { text: '长期钉的值' } } }),
      })
      assert.equal(res.status, 200, '给审核者钉长期固定参数应当成功')

      // 判决：触发动作，但**不写 text**（它已固定，契约说了不要写）
      h.backend.verdict = { ...PASS_VERDICT, action: verdictAction(fx.action, {}) }

      const workDir = await h.newWorkDir()
      const executeRunId = await submitExecute(h, { agent: fx.executor, workDir })
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
      await fetch(`${h.url}/api/agents/${fx.reviewer.id}`, {
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
      await fetch(`${h.url}/api/agents/${fx.reviewer.id}`, {
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
      await fetch(`${h.url}/api/agents/${fx.reviewer.id}`, {
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
      const executeRunId = await submitExecute(h, { agent: fx.executor, workDir })
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
