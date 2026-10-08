import assert from 'node:assert/strict'
import { deliveredText } from './testing/delivered.ts'
import { describe, test } from 'node:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  VERDICT_FENCE_BEGIN,
  VERDICT_FENCE_END,
  ulid,
  type Agent,
  type RunId,
  type Tool,
} from '@agentdeck/protocol'
import { startDaemon } from './server.ts'
import { makeTempDir } from './testing/tmp.ts'
import type { AgentBackend, AgentMessage, AgentSession, ExecOptions } from '@agentdeck/agent-core'

/**
 * 工具动作的**端到端**：判决里写一个第三方动作 ⇒ 脚本真的跑了（D40）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这条测试守的是"拼起来还对不对"，不是任何单个零件
 * ══════════════════════════════════════════════════════════════════
 *
 * 各零件都有自己的测试：清单解析（`tool-source.test.ts`）、参数绑定与校验
 * （`tool-actions.test.ts`）、执行器本身（`script-executor.test.ts`）、
 * 安装/挂载 API（`tools-api.test.ts`）。它们**全绿也说明不了这条链是通的**——
 * 链上有几处只有拼起来才成立：
 *
 *   · 判决契约里**必须有** `example-note.append-note` 这个名字（契约里没有的
 *     取值，模型永远写不出来，而它合理的选择只剩"编一个"或"退化成 needs_human"）；
 *   · 判决里那个名字要能在**运行时**解析成"已安装包里的动作"；
 *   · `bound` 参数由平台按事实注入（`dir` = **被审那次执行**的工作目录），
 *     `open` 参数只由模型给（`text`）；
 *   · 脚本的产物真的落到那个工作目录里——这是"行动落地"唯一的硬证据；
 *   · 动作记录里是那个命名空间名（审计链不能在最后一环断掉）。
 *
 * 所以这里用真 daemon + 假 CLI（NFR-T-01：测试绝不调用真实 CLI），
 * 但**脚本是真跑的**：`examples/tools/example-note` 只往工作目录写一个文件。
 */

const EXAMPLE_TOOL_DIR = resolve('examples/tools/example-note')

/**
 * 假 CLI：**执行**那次说一句人话，**审核**那次吐判决。
 *
 * ⚠️ 判据是"这段 prompt 是不是审核"（审核那份里带着判决契约），而且**每一次
 *    审核都用同一份判决回答**——不是"第一次审核才给判决"。原因是执行 run 一
 *    结束，daemon 会**自己**派一条审核（D28 的自动审核），那条与我在测试里手工
 *    提交的那条会**抢**同一份预置判决：谁先跑到谁拿到。第一版的夹具用 `shift()`
 *    只给一次，于是"手工那条拿到执行文案 ⇒ 判不出判决块 ⇒ invalid ⇒ 重试"，
 *    症状是"动作记录一直不落库"，而排查方向会指向执行器。
 *
 *    （同样的道理：夹具不该依赖"播种/调用恰好长什么样"，只该依赖被测的那件事。）
 */
class ScriptedBackend implements AgentBackend {
  readonly key = 'claude'
  readonly protocol = 'stream-json'
  readonly rejectDetectable = false
  /** 审核 run 一律用这份判决回答（可以被读到多次——自动审核与手工审核都会读到）。 */
  verdict: Record<string, unknown> | null = null
  prompts: string[] = []

  async probe(): Promise<{ available: boolean; command: string; cliVersion: string | null }> {
    return { available: true, command: 'claude', cliVersion: '0.0.0-fake' }
  }

  async execute(opts: ExecOptions): Promise<AgentSession> {
    this.prompts.push(deliveredText(opts))
    // ★ 判据是**这段 prompt 是不是审核**（审核那份里带着判决契约），不是"这是第
    //   几次调用"。按调用序号判断在并行跑整个套件时会偶发失败：多出一次调用
    //   （重试、派生）就会把预置的判决喂给错误的那个 run，而症状是"动作记录
    //   一直不落库"——排查方向会指向执行器而不是夹具。
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
        status: 'completed',
        output: text,
        durationMs: 2,
        sessionId: 'e2e-session',
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

class AsyncQueue<T> {
  #items: T[] = []
  #closed = false
  #waiters: Array<(v: IteratorResult<T>) => void> = []
  push(v: T): void {
    const w = this.#waiters.shift()
    if (w) w({ value: v, done: false })
    else this.#items.push(v)
  }
  close(): void {
    this.#closed = true
    for (const w of this.#waiters.splice(0)) w({ value: undefined as never, done: true })
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.#items.shift()
        if (item !== undefined) return Promise.resolve({ value: item, done: false })
        if (this.#closed) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((resolve) => this.#waiters.push(resolve))
      },
    }
  }
}

async function until<T>(fn: () => Promise<T | null>, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn().catch(() => null)
    if (value !== null) return value
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

async function sendJson<T>(
  url: string,
  body: Record<string, unknown>,
  method: 'POST' | 'PUT' = 'POST',
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  assert.ok(res.ok, `${url} 应当成功，实际 ${res.status}：${text.slice(0, 300)}`)
  return JSON.parse(text) as T
}

async function postRun(url: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${url}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  assert.equal(res.status, 202, `提交 run 必须是 202，实际 ${res.status}：${text.slice(0, 300)}`)
}

/**
 * 建一个"执行者 + 审核者"的组（2026-10 起动作权限的唯一写入口）。
 *
 * ⚠️ 这个助手存在的理由就是那条搬家：动作权限与"谁审谁"原来分别写在
 *    审核者 agent 与执行者 agent 上，现在**都只在组上**。三个用例的授权
 *    形态完全一样，所以抽成一个——各写一遍迟早在某处漏掉"审核者是谁"。
 */
async function grantViaGroup(
  url: string,
  executor: { id: string },
  reviewer: { id: string },
  actions: string[],
  debugActions: string[] = [],
): Promise<string> {
  const created = await sendJson<{ group: { id: string } }>(`${url}/api/agent-groups`, {
    name: '动作链组',
    members: [executor.id, reviewer.id],
    allowedActions: actions,
    debugActions,
  })
  return created.group.id
}

async function waitTerminal(url: string, runId: string): Promise<string> {
  let last: string = '(没读到)'
  try {
    return await until(
      async () => {
        const res = await fetch(`${url}/api/runs/${runId}`)
        if (!res.ok) {
          last = `HTTP ${res.status}`
          return null
        }
        const body = (await res.json()) as {
          status?: string
          failureReason?: string | null
        }
        const status = body.status ?? null
        last = `${status ?? '?'}${body.failureReason ? `（${body.failureReason}）` : ''}`
        return status !== null && TERMINAL.has(status) ? status : null
      },
      `run ${runId} 到达终态`,
      30_000,
    )
  } catch (err) {
    // ★ 超时要**说清卡在哪一步**：只报"等待超时"的话，排查方向会指向别处
    throw new Error(`${String(err)}；这个 run 最后的状态是 ${last}`)
  }
}

describe('D40：判决里的工具动作真的跑起来了', () => {
  test('★ verdict → 解析 → 注入绑定参数 → 脚本执行 → 动作记录 → 产物落地', async () => {
    const dir = await makeTempDir('tool-action-e2e')
    const backend = new ScriptedBackend()
    const logs: string[] = []
    const daemon = await startDaemon({
      dataDir: dir,
      port: 0,
      fsync: false,
      workRoot: join(dir, 'workroot'),
      backend,
      onWarn: (m) => logs.push(`WARN ${m}`),
      onInfo: (m) => logs.push(`INFO ${m}`),
      // 解释器钉死在"跑测试的这个 node"上（默认也是 daemon 自己那个 node）
      scriptRuntimePath: process.execPath,
    })
    const url = daemon.url

    try {
      // ── ① 装一个工具包（本地目录来源，走真实安装路径） ──
      const installed = await sendJson<{ tool: Tool }>(`${url}/api/tools`, {
        source: 'path',
        path: EXAMPLE_TOOL_DIR,
      })
      assert.equal(installed.tool.slug, 'example-note')

      // ── ② 一个执行者 + 一个审核者（标准里允许那个工具动作） ──
      const executor = await sendJson<Agent>(`${url}/api/agents`, {
        name: '执行者',
        instructions: '',
        runtimeKey: 'claude',
        role: 'executor',
      })
      const reviewer = await sendJson<Agent>(`${url}/api/agents`, {
        name: '审核者',
        instructions: '',
        runtimeKey: 'claude',
        role: 'reviewer',
        reviewStandard: {
          body: '# 示例标准\n\n只要产出不为空就算通过。',
        },
      })

      // ★★ 授权与"谁审谁"走**组**（2026-10）：agent 上不再有 `allowedActions`，
      //    也不再有自己的 `reviewerAgentId`——建任务时带 `groupId`，组把这两样
      //    展开进这条 run，链路本身一字未变。
      const groupId = await grantViaGroup(url, executor, reviewer, ['example-note.append-note'])

      // ⚠️ 这里原来还有两段：把工具包"按组挂到执行者身上"（`PUT
      //    /api/agents/:id/tools`）与"审核者不许挂工具"（同一接口应回 400）。
      //    挂载能力整个撤掉、那条接口也删了，所以两段一并删掉——**这条链本身
      //    不依赖挂载**：动作能不能触发看的是审核者的 `allowedActions` 加上
      //    "那个包确实装了"（见 `resolveAllowedActionsWithTools`）。

      // ── ④ 审核该说的话：一条带第三方动作的判决 ──
      //   （自动审核会读它；subject 是那条执行 run ⇒ 继承它的工作目录）
      backend.verdict = {
        schemaVersion: 1,
        conclusion: 'pass',
        reasonCode: 'meets_criteria',
        confidence: 0.9,
        findings: [],
        // ★ 模型只给**开放参数**；`dir` 是绑定参数，由平台注入
        action: { type: 'example-note.append-note', params: { text: '来自判决的一句话' } },
        escalateReason: null,
      }

      // ── ③ 只提交**执行** run：审核由 daemon 自己派（D28 的自动审核） ──
      //
      //   ⚠️ 这也是"按真实流程测"：手工再提一条 review run 的话，它会与自动审核
      //      抢同一份判决夹具，而抢的结果取决于调度顺序（并行跑整个套件时抖）。
      //      让产品自己把链路走完，夹具就只需要回答"审核该说什么"。
      const executeRunId = ulid() as RunId
      await postRun(url, {
        runId: executeRunId,
        kind: 'execute',
        groupId,
        agentRef: { id: executor.id, name: executor.name, instructions: '' },
        skills: [],
        subject: { type: 'issue', id: 'issue-e2e-1' },
        prompt: '写点什么',
        // ★ 不指定工作目录：交给 daemon 按任务的默认规则分配（真实路径），
        //   稍后从这条 run 上读回来——动作的 `dir` 绑定值应当是**同一个**目录。
        limits: { maxTurns: null, timeoutMs: null },
      })
      assert.equal(await waitTerminal(url, executeRunId), 'completed')
      const executed = (await (await fetch(`${url}/api/runs/${executeRunId}`)).json()) as {
        workDir?: string | null
      }
      const workDir = executed.workDir ?? ''
      assert.ok(workDir !== '', '执行 run 必须有一个工作目录')


      // ── ⑤ 判决契约里**必须**出现那个第三方动作名 ──
      //    （契约里没有它 ⇒ 模型永远写不出这个名字，这是 D40 最容易漏的一环）
      const reviewPrompt = await until(
        async () => backend.prompts.find((p) => p.includes(VERDICT_FENCE_BEGIN)) ?? null,
        '审核那份 prompt 出现（自动审核真的被派了）',
      )
      assert.match(
        reviewPrompt,
        /example-note\.append-note/,
        '★ 判决契约里必须列出这个动作名——否则模型只能去编一个',
      )
      assert.match(reviewPrompt, /你只需要给/, '契约要说清哪些参数是模型该填的')

      // ── ⑥ 动作记录：命名空间名 + executed + 绑定值在最终参数里 ──
      //   ⚠️ 扫**所有** run 的判决，而不是只看我提交的那条：审核是 daemon 自动派
      //      的（runId 由它分配），夹具里拿不到。
      const action = await until(
        async () => {
          // ⚠️ 列表里叫 `runId`（RunSummary 的形状），只有单个 run 的接口才叫 `id`
          const { runs } = (await (await fetch(`${url}/api/runs`)).json()) as {
            runs: Array<{ runId: string; kind: string }>
          }
          for (const run of runs.filter((r) => r.kind === 'review')) {
            const { verdicts } = (await (
              await fetch(`${url}/api/runs/${run.runId}/verdicts`)
            ).json()) as { verdicts: Array<{ id: string }> }
            for (const verdict of verdicts) {
              const actions = await daemon.store.listActionsByVerdict(verdict.id as never)
              // ★ 等到**终态**再断言：记录是先落 `executing` 再翻成 `executed/failed`
              //   的，只等"记录存在"会读到中间态（这里真踩过一次）
              const hit = actions.filter(
                (a) =>
                  a.type === 'example-note.append-note' &&
                  a.status !== 'executing' &&
                  a.status !== 'proposed' &&
                  a.status !== 'auto_approved',
              )
              if (hit.length > 0) return hit
            }
          }
          return null
        },
        '动作记录落库',
      ).catch(async (err: unknown) => {
        // 超时要**说清卡在哪一步**：只报"等待超时"会把排查方向引到别处
        const { runs } = (await (await fetch(`${url}/api/runs`)).json()) as {
          runs: Array<{ runId: string; kind: string; status: string }>
        }
        const detail: string[] = []
        for (const run of runs) {
          const verdicts = await fetch(`${url}/api/runs/${run.runId}/verdicts`)
            .then((r) => r.json())
            .catch(() => null)
          detail.push(`${run.kind}/${run.status} ${JSON.stringify(verdicts).slice(0, 300)}`)
        }
        const messages: string[] = []
        for (const run of runs.filter((r) => r.kind === 'review')) {
          const m = await fetch(`${url}/api/runs/${run.runId}/messages`)
            .then((r) => r.text())
            .catch(() => '')
          messages.push(`${run.runId}: ${m.slice(-600)}`)
        }
        throw new Error(
          `${String(err)}\n各 run 与判决：\n${detail.join('\n')}\n` +
            `daemon 日志：\n${logs.slice(-12).join('\n')}\n审核消息：\n${messages.join('\n')}`,
        )
      })

      assert.equal(
        action[0]?.type,
        'example-note.append-note',
        '★ 动作记录里必须是那个命名空间名——审计链不能在最后一环断掉',
      )
      assert.equal(action[0]?.status, 'executed')
      assert.equal(action[0]?.params['text'], '来自判决的一句话')
      assert.equal(
        action[0]?.params['dir'],
        workDir,
        '★ 绑定参数由平台按事实注入：这里应当是**被审那次执行**的工作目录',
      )

      // ── ⑥' 页面要看到的那一侧：`GET /api/runs` 必须带上动作结果 ──
      //   阶段推导（`pipeline.ts`）读的就是这个字段——它没带上，"判决通过、动作
      //   失败"的任务在界面上就又会显示成「已审查」（那正是这次要修的谎）。
      const runsBody = (await (await fetch(`${url}/api/runs`)).json()) as {
        runs: Array<{
          runId: string
          kind: string
          action: {
            status: string
            type: string
            error: string | null
            result: Record<string, unknown> | null
            params: Record<string, unknown>
          } | null
        }>
      }
      const reviewRow = runsBody.runs.find((r) => r.kind === 'review')
      assert.equal(reviewRow?.action?.type, 'example-note.append-note', '列表要给出动作类型')
      assert.equal(reviewRow?.action?.status, 'executed', '以及它的状态（页面据此推到「已审查」）')
      assert.equal(runsBody.runs.find((r) => r.kind === 'execute')?.action, null, '执行 run 没有动作')

      // ★★ **动作的结果必须一起送到页面**。
      //
      //   这一条是使用者的反馈补的：「配了行动，但查看任务细节，看不到行动的结果
      //   和它反馈的信息」。根因不在界面，在**这里**——`result` 与 `params` 一直
      //   躺在库里，而这个投影只取了 `{status, type, error}`，于是成功的动作在
      //   详情里只剩一句"已执行"（失败反而看得见，因为 `error` 在里面）。
      //
      //   所以要断言的是**结果本身**，不只是状态：`detail` 是脚本回的那句"做了
      //   什么"，`params` 是它带着什么参数跑的。
      assert.equal(
        typeof reviewRow?.action?.result?.['detail'],
        'string',
        '★ 动作的结果（脚本回的那句话）必须送到页面：只给 status 的话，成功与"跑完什么也没说"看起来一样',
      )
      assert.equal(reviewRow?.action?.result?.['ok'], true, '（结果里带着脚本自己判的成败）')
      assert.equal(
        reviewRow?.action?.params?.['text'],
        '来自判决的一句话',
        '★ 它带着什么参数跑的也要送到页面——模型填的开放参数',
      )
      assert.equal(
        typeof reviewRow?.action?.params?.['dir'],
        'string',
        '★ 包括平台按事实注入的绑定参数（这里就是那个工作目录）',
      )

      // ★★ 判决那一侧也要带上它触发的动作（D45 的显示位置调整）。
      //
      //   界面上现在把动作画在**产生它的那张判决卡**里（「应该作为审核 PASS 的
      //   依据，放在一起更合理」），所以 `GET /api/runs/<id>/verdicts` 必须
      //   一并给出动作记录、而且每项带 `verdictId`——界面靠它把动作挂回对应的
      //   那张卡。少了 `verdictId` 的话，"哪张判决触发的它"就只能靠"最新那条"
      //   去猜，返工回路转过几圈时会画错。
      const verdictsBody = (await (
        await fetch(`${url}/api/runs/${reviewRow?.runId}/verdicts`)
      ).json()) as {
        verdicts: Array<{ id: string; conclusion: string }>
        actions?: Array<{ verdictId: string; type: string; result: Record<string, unknown> | null }>
      }
      assert.ok(Array.isArray(verdictsBody.actions), '★ 判决接口要顺带给出它触发的动作')
      assert.equal(verdictsBody.actions?.length, 1, '这条判决触发了恰好一个动作')
      assert.equal(
        verdictsBody.actions?.[0]?.verdictId,
        verdictsBody.verdicts[0]?.id,
        '★ 动作要挂回**产生它的那条判决**（界面按 verdictId 分组画进同一张卡）',
      )
      assert.equal(
        typeof verdictsBody.actions?.[0]?.result?.['detail'],
        'string',
        '★ 而结果本身也在里面——判决卡上要显示"通过之后做了什么"',
      )

      // ── ⑦ 硬证据：脚本真的往那个工作目录里写了东西 ──
      const written = await until(
        async () => readFile(join(workDir, 'NOTES.md'), 'utf8').catch(() => null),
        '脚本产物 NOTES.md',
      )
      assert.match(written, /来自判决的一句话/)

      // ── ⑧ 幂等：同一条判决只有一条动作记录（重放不会写第二遍） ──
      const replay = await daemon.store.listActionsByVerdict(action[0]!.verdictId as never)
      assert.equal(replay.length, 1, '同一判决只应有一条动作记录')
      assert.equal(await readFile(join(workDir, 'NOTES.md'), 'utf8'), written)
    } finally {
      await daemon.close()
    }
  })

  test('★ 声明「不支持预演」的动作**直接执行**（2026-09：预演准入撤掉了）', async () => {
    // 同一个"有副作用"的工具包：清单里写 dryRun: "unsupported"。2026-09 起这个
    // 声明**不再参与任何判断**（预演准入撤掉了）——判决引用它就该真的执行，
    // 入口脚本写出的标记文件是"它到底跑没跑"的硬证据。
    const dir = await makeTempDir('tool-direct-run')
    const backend = new ScriptedBackend()
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
    const url = daemon.url

    try {
      const pkgDir = join(dir, 'risky-tool')
      await mkdir(join(pkgDir, 'scripts'), { recursive: true })
      await writeFile(
        join(pkgDir, 'tool.json'),
        JSON.stringify({
          schema: 'agentdeck/tool@1',
          slug: 'risky-tool',
          name: '不能预演的工具',
          runtime: 'node',
          entry: 'scripts/touch.mjs',
          actions: [
            {
              name: 'touch',
              summary: '写一个标记文件',
              reversible: false,
              dryRun: 'unsupported',
              params: { bound: { dir: { from: 'workdir' } }, open: {} },
            },
          ],
        }),
        'utf8',
      )
      await writeFile(
        join(pkgDir, 'scripts', 'touch.mjs'),
        [
          "import { writeFile } from 'node:fs/promises'",
          "import { join } from 'node:path'",
          'const chunks = []',
          'for await (const c of process.stdin) chunks.push(c)',
          'const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")',
          // ⚠️ 标记文件的内容刻意**不含换行**：这段脚本是"文本里的文本"，
          //   写 `\n` 会在生成时被解释成一个真的换行，于是脚本自己成了语法错误。
          'await writeFile(join(input.params.dir, "RISKY.txt"), "跑了", "utf8")',
          'process.stdout.write(JSON.stringify({ ok: true, detail: "写了标记文件" }))',
        ].join('\n'),
        'utf8',
      )

      await sendJson<{ tool: Tool }>(`${url}/api/tools`, {
        source: 'path',
        path: pkgDir,
      })
      const executor = await sendJson<Agent>(`${url}/api/agents`, {
        name: '执行者2',
        instructions: '',
        runtimeKey: 'claude',
        role: 'executor',
      })
      const reviewer = await sendJson<Agent>(`${url}/api/agents`, {
        name: '审核者2',
        instructions: '',
        runtimeKey: 'claude',
        role: 'reviewer',
        reviewStandard: {
          body: '# 放行标准\n\n什么都算通过。',
        },
      })
      // ★ 授权在组上；**不**标「调试」⇒ 直接执行
      const groupId = await grantViaGroup(url, executor, reviewer, ['risky-tool.touch'])
      // 审核我说什么：通过，并触发那个动作
      backend.verdict = {
        schemaVersion: 1,
        conclusion: 'pass',
        reasonCode: 'meets_criteria',
        confidence: 0.9,
        findings: [],
        action: { type: 'risky-tool.touch', params: {} },
        escalateReason: null,
      }

      const findAction = async (): Promise<
        Array<{
          status: string
          error: string | null
          dryRun: boolean
          result: Record<string, unknown> | null
          params: Record<string, unknown>
        }>
      > =>
        until(
          async () => {
            const { runs } = (await (await fetch(`${url}/api/runs`)).json()) as {
              runs: Array<{ runId: string; kind: string }>
            }
            const all: Array<{
              status: string
              error: string | null
              dryRun: boolean
              result: Record<string, unknown> | null
              params: Record<string, unknown>
            }> = []
            for (const run of runs.filter((r) => r.kind === 'review')) {
              const { verdicts } = (await (
                await fetch(`${url}/api/runs/${run.runId}/verdicts`)
              ).json()) as { verdicts: Array<{ id: string }> }
              for (const verdict of verdicts) {
                const actions = await daemon.store.listActionsByVerdict(verdict.id as never)
                all.push(
                  ...actions.filter(
                    (a) =>
                      a.type === 'risky-tool.touch' &&
                      a.status !== 'executing' &&
                      a.status !== 'proposed' &&
                      a.status !== 'auto_approved',
                  ),
                )
              }
            }
            return all.length > 0 ? all : null
          },
          'risky-tool.touch 的动作记录到达终态',
        )

      const executeRunId = ulid() as RunId
      await postRun(url, {
        runId: executeRunId,
        kind: 'execute',
        groupId,
        agentRef: { id: executor.id, name: executor.name, instructions: '' },
        skills: [],
        subject: { type: 'issue', id: 'issue-direct-1' },
        prompt: '干点活',
        limits: { maxTurns: null, timeoutMs: null },
      })
      assert.equal(await waitTerminal(url, executeRunId), 'completed')

      // ★ 不再被准入拦下：动作 **executed**，错误为空，脚本真的跑了
      const done = await until(
        async () => (await findAction()).find((a) => a.status === 'executed') ?? null,
        '动作直接执行成功',
      )
      assert.equal(done.error, null, '不再有"不支持 dry-run"的拒绝')
      assert.equal(done.dryRun, false, '真执行 ⇒ 不带"没真跑"标记')
      const marker = await until(
        async () => readFile(join(String(done.params['dir']), 'RISKY.txt'), 'utf8').catch(() => null),
        '脚本真的执行了（标记文件出现）',
      )
      assert.match(marker, /跑了/)
    } finally {
      await daemon.close()
    }
  })

  test('★ 「调试」：不跑脚本，只记录动作与解析后的参数（2026-09）', async () => {
    // 同一个"有副作用"的工具包，但审核者在行动权限里给它标了「调试」
    // （`debugActions`）——判决引用它时平台**不执行脚本**，只把动作连同解析后
    // 的完整参数记进时间线（`dryRun: true` ⇒ 界面显示「调试 · 未执行」）。
    // 标记文件**不出现**是硬证据。
    const dir = await makeTempDir('tool-debug')
    const backend = new ScriptedBackend()
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
    const url = daemon.url

    try {
      const pkgDir = join(dir, 'risky-tool')
      await mkdir(join(pkgDir, 'scripts'), { recursive: true })
      await writeFile(
        join(pkgDir, 'tool.json'),
        JSON.stringify({
          schema: 'agentdeck/tool@1',
          slug: 'risky-tool',
          name: '不能预演的工具',
          runtime: 'node',
          entry: 'scripts/touch.mjs',
          actions: [
            {
              name: 'touch',
              summary: '写一个标记文件',
              reversible: false,
              dryRun: 'unsupported',
              params: { bound: { dir: { from: 'workdir' } }, open: {} },
            },
          ],
        }),
        'utf8',
      )
      await writeFile(
        join(pkgDir, 'scripts', 'touch.mjs'),
        [
          "import { writeFile } from 'node:fs/promises'",
          "import { join } from 'node:path'",
          'const chunks = []',
          'for await (const c of process.stdin) chunks.push(c)',
          'const input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")',
          'await writeFile(join(input.params.dir, "RISKY.txt"), "跑了", "utf8")',
          'process.stdout.write(JSON.stringify({ ok: true, detail: "写了标记文件" }))',
        ].join('\n'),
        'utf8',
      )

      await sendJson<{ tool: Tool }>(`${url}/api/tools`, {
        source: 'path',
        path: pkgDir,
      })
      const executor = await sendJson<Agent>(`${url}/api/agents`, {
        name: '执行者3',
        instructions: '',
        runtimeKey: 'claude',
        role: 'executor',
      })
      const reviewer = await sendJson<Agent>(`${url}/api/agents`, {
        name: '审核者3',
        instructions: '',
        runtimeKey: 'claude',
        role: 'reviewer',
        reviewStandard: {
          body: '# 放行标准\n\n什么都算通过。',
        },
      })
      // ★★ 2026-10：授权与「调试」标签都写在**组**上（agent 上不再有动作字段）。
      //    提交 run 时带 `groupId`，组把这两样展开进 `Run.*`——链路与以前完全一样，
      //    变的只是"配置住在哪儿"。
      const group = await sendJson<{ group: { id: string; debugActions: string[] } }>(
        `${url}/api/agent-groups`,
        {
          name: '组3',
          members: [executor.id, reviewer.id],
          // 授权（allowedActions）+ 标「调试」（debugActions，allowedActions 的子集）
          allowedActions: ['risky-tool.touch'],
          debugActions: ['risky-tool.touch'],
        },
      )
      assert.deepEqual(
        group.group.debugActions,
        ['risky-tool.touch'],
        'POST 建组时 debugActions 要落库',
      )
      backend.verdict = {
        schemaVersion: 1,
        conclusion: 'pass',
        reasonCode: 'meets_criteria',
        confidence: 0.9,
        findings: [],
        action: { type: 'risky-tool.touch', params: {} },
        escalateReason: null,
      }

      const executeRunId = ulid() as RunId
      await postRun(url, {
        runId: executeRunId,
        kind: 'execute',
        // ★ 带组提交：审核者、动作白名单与调试标签都从组展开
        groupId: group.group.id,
        agentRef: { id: executor.id, name: executor.name, instructions: '' },
        skills: [],
        subject: { type: 'issue', id: 'issue-debug-1' },
        prompt: '干点活',
        limits: { maxTurns: null, timeoutMs: null },
      })
      assert.equal(await waitTerminal(url, executeRunId), 'completed')

      const done = await until(
        async () => {
          const { runs } = (await (await fetch(`${url}/api/runs`)).json()) as {
            runs: Array<{ runId: string; kind: string }>
          }
          for (const run of runs.filter((r) => r.kind === 'review')) {
            const { verdicts } = (await (
              await fetch(`${url}/api/runs/${run.runId}/verdicts`)
            ).json()) as { verdicts: Array<{ id: string }> }
            for (const verdict of verdicts) {
              const actions = await daemon.store.listActionsByVerdict(verdict.id as never)
              const hit = actions.find(
                (a) => a.type === 'risky-tool.touch' && a.status === 'executed',
              )
              if (hit) return hit
            }
          }
          return null
        },
        '调试动作记录到达 executed',
      )

      // ★ 记录带着"没真跑"标记（协议里 `Action.dryRun` = 没真跑、只记录）
      assert.equal(done.dryRun, true, '调试记录带 dryRun 标记（时间线显示「调试 · 未执行」）')
      assert.ok(
        String(done.result?.['detail'] ?? '').includes('调试模式'),
        'result 里说明这是调试模式：' + JSON.stringify(done.result),
      )
      // ★ 解析后的完整参数原样记下（bound 的 dir 是平台按事实注入的）
      assert.ok(
        typeof done.params['dir'] === 'string' && done.params['dir'].length > 0,
        '动作与解析后的参数被记录：' + JSON.stringify(done.params),
      )
      // ★ 脚本一次都没跑：标记文件必须不存在
      await assert.rejects(
        readFile(join(String(done.params['dir']), 'RISKY.txt'), 'utf8'),
        '调试模式不该执行脚本——标记文件不该出现',
      )
    } finally {
      await daemon.close()
    }
  })
})
