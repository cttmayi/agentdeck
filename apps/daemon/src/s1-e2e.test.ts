import { after, before, describe, test } from 'node:test'
import { deliveredText } from './testing/delivered.ts'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
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
  type Issue,
  type RunId,
  type VerdictRecord,
} from '@agentdeck/protocol'
import { startDaemon, type DaemonHandle } from './server.ts'
import { installToolPackage, verdictAction, writeToolPackage } from './testing/tool-fixture.ts'
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
    // D29：判定"这是审核还是执行"只能看**第一句话**（CLAUDE.md 已经不写了）。
    // 第一句话的开头就是 `# 任务` 或 `# 审核任务`。
    const context = deliveredText(opts)
    const isReview = context.includes('# 审核任务')
    this.phases.push(isReview ? 'review' : 'execute')

    // ⚠️ 这里原来会从受管上下文里抠出关联 issue（`- 关联 issue：…`），再把它塞进
    //    判决的 `action.params.issueId`。D41 之后动作来自工具包，而"这条动作该落在
    //    哪个对象上"由清单里的**绑定参数**决定（平台按 run 的事实注入，模型写不出来），
    //    模型只填开放参数——所以这个夹具只给 `text`，见下面那段注释。

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
            conclusion: 'pass',
            reasonCode: 'missing_tests',
            confidence: 0.8,
            findings: [{ severity: 'high', summary: '没有测试', evidence: [] }],
            // ══════════════════════════════════════════════════════════
            // ★ D41：判决里的动作必须来自**装进来的工具包**
            // ══════════════════════════════════════════════════════════
            //
            // 这里原来是 `comment.create`（平台的内置动作）。内置动作已经被全部
            // 移除，动作只能写成 `<包 slug>.<动作名>` 并且**那个包真的装了**——
            // 而首启播种的审核者**没有任何动作权限**（D41 的刻意结果）。所以
            // `before` 里装了一个夹具包、把它的动作授给了那个审核者，这里用它。
            //
            // 判决里只给**开放参数** `text`：绑定参数（工作目录）由平台按这条 run
            // 的事实注入——写成 `issueId` 那种"模型自己指对象"的参数会被当成未知键拒掉。
            action: verdictAction(reviewAction, { text: '缺少测试' }),
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
/**
 * 判决里那条动作的完整名字（`<包 slug>.<动作名>`）。
 *
 * `before` 里装的那个夹具包决定它，见下面那段注释。
 */
let reviewAction: string

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

  // ══════════════════════════════════════════════════════════════════
  // ★ D41：动作只能来自**装进来的工具包**，而播种的审核者没有任何动作权限
  // ══════════════════════════════════════════════════════════════════
  //
  // 这条链路（执行 → 自动审核 → 判决 → 动作）的主体是**流程本身**，判决里带一个
  // 动作只是它的落点。内置动作被全部移除之后，那个动作必须真的来自一个装了
  // 的包；而"播种的审核者开箱即用就能发评论"已经不再成立（D41 的刻意结果：
  // `BUILTIN_REVIEW_ALLOWED_ACTIONS` 现在是空数组）。
  //
  // 所以这里装一个夹具包（真 node 脚本，只往工作目录写一个文件；NFR-T-01），
  // 并把它的动作授给那个播种的审核者——授权的入口就是 `Agent.allowedActions`
  // （D40 收口之后动作权限只住在那儿）。不装的话判决会以"动作不可用"判成
  // 不合规，这条用例就会变成在测别的东西。
  const pkg = await writeToolPackage()
  await installToolPackage(daemon, pkg)
  const granted = await fetch(`${daemon.url}/api/agents/${reviewer!.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ allowedActions: [pkg.action] }),
  })
  assert.equal(granted.status, 200, '给播种的审核者授权一个工具动作应当成功')
  reviewAction = pkg.action

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
    assert.equal(verdicts[0]?.conclusion, 'pass')
    assert.equal(verdicts[0]?.status, 'dispatched_to_action')

    // ══════════════════════════════════════════════════════════════════
    // ★ 而且那条动作**真的执行了**（D41：动作是一个工具脚本，不是平台的一支代码）
    // ══════════════════════════════════════════════════════════════════
    //
    // 产物落在**审核 run 的工作目录**里：审核继承被审那条 run 的工作目录（上面
    // 那条用例守的就是这件事），而这份夹具脚本的 `dir` 是平台按 run 事实注入的
    // **绑定参数**——所以文件出现在这里，同时也证明了"绑定的值真的被交给了脚本"。
    assert.equal(
      await readFile(join(workDir, 'fixture-out.txt'), 'utf8'),
      '- 缺少测试\n',
      '★ 判决里的工具动作要真的跑过 —— 只断言状态等于"已派发"是抓不到这一点的',
    )
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

  test('★ 跑完把注入的技能收掉；使用者自己的技能一个都不许动', async () => {
    // ══════════════════════════════════════════════════════════════════
    // 这条测试的期望改过两次，两次都是使用者的决定，记下来
    // ══════════════════════════════════════════════════════════════════
    //
    // ① 最早：跑完把技能删掉。问题是**删除的依据是进程内的数组**——daemon 崩溃
    //    或被 kill 之后记忆就没了，残留的文件会被以后的 run 继续发现，
    //    于是"你从 agent 上摘掉的技能还在生效"。
    // ② 然后：改成保留，靠**落盘的归属清单**对账。上面那个问题解决了，但工作
    //    目录里长期留着一堆不是 agent 产出的东西；而且审核与执行共用一个目录
    //    之后，两边的技能会互相摘。
    // ③ 现在：**还是收掉**（使用者的决定：跑完的工作目录只该是 agent 的产出），
    //    但删除的依据仍然是**那份落盘的清单**，不是内存里的数组——当初让"跑完
    //    删"变危险的那一条已经被清单解决了。
    //
    // 所以这条测试要同时钉住两件相反的事：**我们注入的要消失**，
    // 而**使用者自己放在同一个目录里的东西必须原样在**。
    const { readFile, readdir, mkdir, writeFile, rm } = await import('node:fs/promises')
    // ★ 这条用例用**自己的工作目录**。
    //
    //   第一版用的是共享的 `workDir`，而共享意味着"另一个用例留下的 run /
    //   自动串接出来的 review run 可能还在跑"——单独跑时通过，全量跑时失败
    //   （断言时机与并发 run 撞上了）。测试要盯的是"一次 run 收尾后的状态"，
    //   那就必须让这段时间里**只有这一个 run 在动**。
    const own = await makeTempDir('s1-sweep')
    const skillsDir = join(own, '.claude', 'skills')

    // 先放一份"使用者自己的技能"进去（不在我们的归属清单里）
    const usersOwn = join(skillsDir, 'my-own-skill')
    await mkdir(usersOwn, { recursive: true })
    await writeFile(join(usersOwn, 'SKILL.md'), '# 我自己的\n', 'utf8')

    try {
      // 再跑一次执行（这次挂一个技能，让它真的注入点什么）
      const runId = ulid() as RunId
      const res = await fetch(`${daemon.url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId,
          kind: 'execute',
          agentRef: { id: agentId, name: '助手', instructions: '' },
          skills: [
            {
              ref: { id: 'sk1', slug: 'probe-skill', source: 'local' },
              slug: 'probe-skill',
              name: '探针技能',
              body: '# 探针\n\n随便写点什么。',
            },
          ],
          subject: { type: 'issue', id: issueId },
          prompt: '再跑一次',
          workDir: own,
          limits: { maxTurns: null, timeoutMs: null },
        }),
      })
      assert.equal(res.status, 202)

      // ══════════════════════════════════════════════════════════════════
      // ★ 等的是"那一条**具体的**审核 run"，不是"没有忙着的 run"
      // ══════════════════════════════════════════════════════════════════
      //
      // 第一版等的是后者，于是它**会空过**：审核 run 是在执行结束**之后**
      // 才被创建出来的，中间存在一个"当前没有任何 run 在跑"的真实瞬间——
      // 断言在那个瞬间通过，而审核 run 紧接着就把自己的技能与归属清单写进
      // **同一个目录**，那条"清单也该收掉"的断言于是随机失败。
      // 症状：单独跑这条用例过、全量跑时偶尔红（复现过两次）。
      const settled = ['queued', 'dispatched', 'running']
      type RunsPage = {
        runs: Array<{ runId: string; kind: string; status: string; subject?: { type: string; id: string } }>
      }
      const listRuns = async (): Promise<RunsPage['runs']> =>
        ((await (await fetch(`${daemon.url}/api/runs`)).json()) as RunsPage).runs

      await waitFor(async () => {
        const r = (await listRuns()).find((x) => x.runId === runId)
        return r && !settled.includes(r.status) ? r : null
      })

      // 执行者播种时就指着一个审核者（D28），所以它跑完必然串出审核；
      // 等不到就是"自动串接没发生"，那本身就是要报出来的事。
      const reviewRunId = await waitFor(async () => {
        const review = (await listRuns()).find(
          (r) => r.kind === 'review' && r.subject?.type === 'run' && r.subject.id === runId,
        )
        return review ? review.runId : null
      })
      await waitFor(async () => {
        const r = (await listRuns()).find((x) => x.runId === reviewRunId)
        return r && !settled.includes(r.status) ? r : null
      })

      const left = await readdir(skillsDir).catch(() => [] as string[])

      // ① 我们注入的没了
      assert.ok(!left.includes('probe-skill'), '★ 跑完不许留下我们注入的技能')
      // ② 归属清单也收掉了（空了就没有意义）
      assert.ok(
        !left.includes('.agentdeck-managed.json'),
        '★ 什么都没留下时，归属清单本身也该收掉',
      )
      // ③ 使用者自己的那份**一个字都没动**
      const mine = await readFile(join(usersOwn, 'SKILL.md'), 'utf8')
      assert.equal(mine, '# 我自己的\n', '★ 使用者自己放的技能绝不能被删或被改写')

      // 日志里要说清收到了什么（"默默清掉"会让人以为技能没生效过）
      const messages = ((await (
        await fetch(`${daemon.url}/api/runs/${runId}/messages?since=-1`)
      ).json()) as { messages: Array<{ content: string }> }).messages
      assert.ok(
        messages.some((m) => (m.content ?? '').includes('已移除本次注入的 skill')),
        '★ 收掉了什么要写进日志',
      )
    } finally {
      await cleanup(own)
    }
  })
})
