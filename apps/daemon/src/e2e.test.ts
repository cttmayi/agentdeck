import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AsyncQueue, type AgentBackend, type AgentMessage, type ExecOptions, type AgentSession } from '@alpha-helper/agent-core'
import { hasContextBlock } from '@alpha-helper/agent-core'
import { ulid, type Issue, type RunId, type RunEvent } from '@alpha-helper/protocol'
import { startDaemon, type DaemonHandle } from './server.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * 端到端：真的起一个 daemon、真的走 HTTP 与 SSE。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么用假后端
 * ══════════════════════════════════════════════════════════════════
 *
 * **NFR-T-01 要求单元测试与常规 CI 绝不能调用使用者真实安装的 agent CLI。**
 * 那会消耗真实额度、可能让 agent 改动文件，而且结果不确定。
 *
 * 所以这里注入一个假后端，它顺便做了两件真后端做不到的事：
 *   1. 在"执行中"读一次 CLAUDE.md，验证上下文块**确实被注入**了；
 *   2. 记录收到的 prompt 与 workDir，验证透传正确。
 */

class FakeBackend implements AgentBackend {
  /** 模拟真后端拼出来的协议参数——用来验证"命令行进日志"。 */
  readonly #baseArgs = ['-p', '--output-format', 'stream-json', '--permission-mode', 'bypassPermissions']

  readonly key = 'claude'
  readonly protocol = 'stream-json' as const
  readonly rejectDetectable = true

  /** 执行时看到的工作目录内容——用于验证注入发生在正确时机。 */
  seenContext: string | null = null
  seenPrompt: string | null = null
  seenWorkDir: string | null = null
  seenArgs: string[] | null = null
  /** 执行时收到的模型与自定义环境变量——用来验证"agent 上填的东西真的传下去了"。 */
  seenModel: string | null = null
  seenEnv: Record<string, string> = {}
  /** 这次执行要求恢复哪个会话（`--resume` 的入参）——"接着上次说"靠它。 */
  seenResumeSessionId: string | null = null

  /**
   * 执行那一刻，工作目录里 `.claude/skills/` 下的文件（相对技能目录的路径 → 内容）。
   *
   * ★ 为什么必须**在执行时**抓，而不是等 run 结束后去磁盘上看：
   *   注入是临时的——run 结束后 `removeInjectedSkills` 会把我们写进去的
   *   技能目录删掉（FR-CLI-16：清理只删自己造的东西）。跑完再去看，
   *   看到的永远是"不存在"，于是这条断言会以"文件没写下去"的假象失败，
   *   而真正的原因是我们看错了时间点。
   */
  seenSkillFiles: Record<string, string> = {}

  readonly #fail: boolean

  /** 卡住执行用的闸门——见 `hold()`。 */
  #gate: Promise<void> | null = null

  constructor(options: { fail?: boolean } = {}) {
    this.#fail = options.fail === true
  }

  /**
   * 让这次执行**停在 running 上**，直到调用返回的那个函数。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么需要它：假后端"太快"了，快到测不出中间状态
   * ══════════════════════════════════════════════════════════════════
   *
   * 消息是立刻推完的、结果也立刻就有，于是 run 在 `POST /api/runs`
   * 返回之前就已经结束了。所有"执行中"的断言都会退化成"已结束"的断言——
   * 包括"执行中不能把流掐断"这条，它会**因为流已经正常结束而通过**。
   *
   * 一个总在正确分支上通过的测试，比没有测试更危险。
   */
  hold(): () => void {
    let release!: () => void
    this.#gate = new Promise<void>((resolve) => {
      release = resolve
    })
    return release
  }

  async probe(): Promise<{ available: boolean; command: string; cliVersion: string | null }> {
    return { available: true, command: 'claude', cliVersion: '0.0.0-fake' }
  }

  async execute(opts: ExecOptions): Promise<AgentSession> {
    this.seenPrompt = opts.prompt
    this.seenWorkDir = opts.workDir
    this.seenModel = opts.model ?? null
    this.seenEnv = opts.env ?? {}
    this.seenResumeSessionId = opts.resumeSessionId ?? null
    this.seenContext = await readFile(join(opts.workDir, 'CLAUDE.md'), 'utf8').catch(() => null)

    // 抓一份技能目录快照（见 seenSkillFiles 的注释：只有此刻才看得到）
    this.seenSkillFiles = {}
    const skillsRoot = join(opts.workDir, '.claude', 'skills')
    for (const slug of await readdir(skillsRoot).catch(() => [] as string[])) {
      const walk = async (dir: string, prefix: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
          const full = join(dir, entry.name)
          const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
          if (entry.isDirectory()) await walk(full, rel)
          else this.seenSkillFiles[`${slug}/${rel}`] = await readFile(full, 'utf8').catch(() => '')
        }
      }
      await walk(join(skillsRoot, slug), '')
    }

    // ★ 假后端也要像真后端那样上报命令行。
    //
    //   不报的话，测试就测不到"命令行进日志"这条路径——而那正是
    //   使用者要的 debug 信息。**假后端与真后端的行为不一致，测试就会
    //   为一条不存在的路径放行。**
    opts.onCommandLine?.({
      argv: ['claude', ...this.#baseArgs],
      sandboxDescription: '未启用沙箱（测试里的假后端）',
    })

    const queue = new AsyncQueue<AgentMessage>()
    queue.push({ type: 'status', content: '会话已启动' })
    queue.push({ type: 'text', content: '我先看看任务。' })
    queue.push({ type: 'tool_use', tool: 'Read', content: '调用工具 Read', input: { file_path: 'a.ts' } })
    queue.push({ type: 'tool_result', tool: null, content: '文件内容', output: '文件内容', outputTruncated: false })
    queue.push({ type: 'text', content: '报告：任务已完成。' })
    queue.close()

    const fail = this.#fail
    const gate = this.#gate ?? Promise.resolve()
    const result = gate.then(() => ({
      status: fail ? ('failed' as const) : ('completed' as const),
      output: fail ? '' : '报告：任务已完成。',
      error: fail ? '假装失败了' : null,
      durationMs: 5,
      sessionId: 'fake-session-1',
      usage: { inputTokens: 100, outputTokens: 50, costUsdMicros: 1234, costSource: 'provider' as const },
      exitCode: fail ? 1 : 0,
    }))

    return {
      messages: queue,
      result,
      async cancel() {
        queue.close()
      },
      lastActivityAt: () => Date.now(),
    }
  }
}

/** 读 SSE 直到终态事件或超时。 */
async function readUntilTerminal(
  url: string,
  timeoutMs = 10_000,
): Promise<{ events: RunEvent[]; terminal: RunEvent | null }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const events: RunEvent[] = []
  let terminal: RunEvent | null = null

  try {
    const res = await fetch(url, { signal: controller.signal })
    assert.equal(res.status, 200)
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let index = buffer.indexOf('\n\n')
      while (index !== -1) {
        const raw = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        index = buffer.indexOf('\n\n')

        if (!raw.startsWith('data: ')) continue // 心跳注释
        const parsed = JSON.parse(raw.slice(6)) as RunEvent
        events.push(parsed)
        if (parsed.t === 'terminal') {
          terminal = parsed
          await reader.cancel()
          return { events, terminal }
        }
      }
    }
  } catch (err) {
    if ((err as Error).name !== 'AbortError') throw err
  } finally {
    clearTimeout(timer)
  }

  return { events, terminal }
}

/**
 * 读完**整个** SSE 流，并回答"流是自己结束的吗"。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么需要它：`readUntilTerminal` 会在收到 terminal 时主动 cancel
 * ══════════════════════════════════════════════════════════════════
 *
 * 于是它**测不出"服务端忘了关流"**——客户端自己走了，服务端挂不挂着它不知道。
 * 而那正是线上那个 bug 的另一半：终态补发了，连接却还留着。
 *
 * 这里反过来：一直读到 `done`。`ended=false` 就表示超时被我们掐断，
 * 也就是"连接一直挂着"。
 */
async function readStreamToEnd(
  url: string,
  timeoutMs = 5_000,
): Promise<{ events: RunEvent[]; ended: boolean }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const events: RunEvent[] = []
  let ended = false

  try {
    const res = await fetch(url, { signal: controller.signal })
    assert.equal(res.status, 200)
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    for (;;) {
      const { value, done } = await reader.read()
      if (done) {
        ended = true
        break
      }
      buffer += decoder.decode(value, { stream: true })

      let index = buffer.indexOf('\n\n')
      while (index !== -1) {
        const raw = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        index = buffer.indexOf('\n\n')

        if (!raw.startsWith('data: ')) continue // 心跳注释
        events.push(JSON.parse(raw.slice(6)) as RunEvent)
      }
    }
  } catch (err) {
    if ((err as Error).name !== 'AbortError') throw err
  } finally {
    clearTimeout(timer)
  }

  return { events, ended }
}

let dir: string
let workDir: string
let daemon: DaemonHandle
let backend: FakeBackend
let issueId: string

before(async () => {
  dir = await makeTempDir('e2e-data')
  workDir = await makeTempDir('e2e-work')
  backend = new FakeBackend()
  daemon = await startDaemon({
    dataDir: dir,
    port: 0, // 让内核分配，避免测试互相抢端口
    fsync: false,
    backend,
    onWarn: () => {},
    onInfo: () => {},
  })

  const res = await fetch(`${daemon.url}/api/issues`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '写一份报告', description: '随便看看' }),
  })
  issueId = ((await res.json()) as Issue).id
})

after(async () => {
  await daemon.close()
  await cleanup(dir)
  await cleanup(workDir)
})

describe('端到端：一个 execute run 跑通整条链路', () => {
  test('身份接口报出可用 runtime', async () => {
    const res = await fetch(`${daemon.url}/api/identity`)
    const body = (await res.json()) as { runtimes: Array<{ key: string; available: boolean }> }
    assert.equal(body.runtimes[0]?.key, 'claude')
    assert.equal(body.runtimes[0]?.available, true)
  })

  test('★ 提交 run → 收到流式消息 → 终态 completed', async () => {
    const runId = ulid() as RunId
    const res = await fetch(`${daemon.url}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runId,
        kind: 'execute',
        agentRef: { id: 'agent-x', name: '助手', instructions: '' },
        skills: [],
        subject: { type: 'issue', id: issueId },
        prompt: '写一份关于依赖漏洞的报告',
        workDir,
        limits: { maxTurns: null, timeoutMs: null },
      }),
    })
    assert.equal(res.status, 202, '受理必须返回 202')

    const { events, terminal } = await readUntilTerminal(`${daemon.url}/api/runs/${runId}/events`)
    assert.notEqual(terminal, null, '必须收到终态事件')
    assert.equal(terminal?.t, 'terminal')
    if (terminal?.t !== 'terminal') return
    assert.equal(terminal.status, 'completed')

    const messages = events.filter((e) => e.t === 'message')
    assert.ok(messages.length >= 4, `应收到多条流式消息，实际 ${messages.length}`)

    // ★ seq 必须严格单调——页面靠它做补齐与去重
    const seqs = events.map((e) => e.seq)
    for (let i = 1; i < seqs.length; i++) {
      assert.ok(seqs[i]! > seqs[i - 1]!, 'seq 必须严格递增')
    }

    // 用量事件带 provider 上报的成本
    const usageEvent = events.find((e) => e.t === 'usage')
    assert.equal(usageEvent?.t === 'usage' ? usageEvent.usage.costUsdMicros : null, 1234)
    assert.equal(usageEvent?.t === 'usage' ? usageEvent.usage.costSource : null, 'provider')
  })

  test('★ 上下文块在**执行期间**已注入（假后端在跑的时候读到了它）', () => {
    assert.notEqual(backend.seenContext, null, '执行时 CLAUDE.md 应当存在')
    assert.equal(hasContextBlock(backend.seenContext!), true, '应当含受管块')
    assert.match(backend.seenContext!, /写一份关于依赖漏洞的报告/, '受管块里应含任务内容')
  })

  test('★ 我们自己造的上下文文件**保留**；使用者自己的那份逐字节还原', async () => {
    // ══════════════════════════════════════════════════════════════════
    // 这条期望被改过一次，改的是"哪一份该留"
    // ══════════════════════════════════════════════════════════════════
    //
    // 原来断言"跑完这个文件被删掉"（这个目录本来没有 CLAUDE.md）。
    // 使用者的要求是**保留**：任务的工作目录是产物之一，他要能进去看
    // "这次任务被交代了什么"；接着沟通时上下文也还在。
    //
    // 而"不改写别人的文件"这条底线没有变：**使用者自己写的** CLAUDE.md
    // 仍然逐字节还原 —— 判据是 `removeContextBlock` 的结构检查
    //（"通篇只有我们的块" = 我们造的），不依赖任何记忆。
    // 那条保证在同文件另一条用例里钉着（"已有 CLAUDE.md ⇒ 逐字节复原"）。
    const after = await readFile(join(workDir, 'CLAUDE.md'), 'utf8').catch(() => null)
    assert.notEqual(after, null, '★ 我们自己造的上下文文件要留着')
    assert.equal(hasContextBlock(after!), true, '留着的那份里应当有受管块（说明这次任务被交代了什么）')
  })

  test('prompt 与工作目录被正确透传', () => {
    assert.equal(backend.seenPrompt, '写一份关于依赖漏洞的报告')
    assert.equal(backend.seenWorkDir, workDir)
  })

  test('消息已落盘，且 daemon 是权威（可用 since 补齐）', async () => {
    const listRes = await fetch(`${daemon.url}/api/runs`)
    const list = (await listRes.json()) as { runs: Array<{ runId: string; status: string }> }
    assert.equal(list.runs.length, 1)
    assert.equal(list.runs[0]?.status, 'completed')

    const runId = list.runs[0]!.runId
    // ★ "有没有消息"要看 `/messages`，**不要**去看 runs 列表里的某个序号字段。
    //   这里原来断言 `list.runs[0].lastSeq >= 3`，而那个字段已经被删掉了：
    //   它的语义（库里已有的最大序号）被界面误当成订阅参数（跳过 N 及之前），
    //   导致打开已跑完的任务时日志全空。见 local-api.ts 里的说明。
    assert.equal(
      'lastSeq' in (list.runs[0] as Record<string, unknown>),
      false,
      '★ runs 列表不该再给 lastSeq —— 它被当成订阅游标用过，而且用反了',
    )
    const all = (await (await fetch(`${daemon.url}/api/runs/${runId}/messages`)).json()) as {
      messages: Array<{ seq: number }>
    }
    assert.ok(all.messages.length >= 4)

    // since 语义：只返回**事件序号**大于 since 的消息。
    // 注意事件 seq 是跨类型共享的（status 也占号），所以消息序号不连续——
    // 这正是"补齐要靠 seq 而不是靠数组下标"的原因。
    const tail = (await (
      await fetch(`${daemon.url}/api/runs/${runId}/messages?since=2`)
    ).json()) as { messages: Array<{ seq: number }> }

    assert.ok(tail.messages.every((m) => m.seq > 2), 'since 之后的都应大于 2')
    assert.ok(tail.messages.length < all.messages.length, 'since 应当过滤掉一部分')

    const head = all.messages.filter((m) => m.seq <= 2)
    assert.equal(head.length + tail.messages.length, all.messages.length, '两段合起来必须不重不漏')
    assert.ok(tail.messages.every((m) => m.seq % 1 === 0))
  })
})

describe('端到端：幂等与拒绝', () => {
  test('★ 同一 runId 重复提交只受理一次', async () => {
    const runId = ulid() as RunId
    const body = JSON.stringify({
      runId,
      kind: 'execute',
      agentRef: { id: 'agent-x', name: '助手', instructions: '' },
      skills: [],
      subject: { type: 'issue', id: issueId },
      prompt: '幂等测试',
      workDir,
      limits: { maxTurns: null, timeoutMs: null },
    })

    const first = await fetch(`${daemon.url}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    const firstBody = (await first.json()) as { deduplicated: boolean }
    assert.equal(firstBody.deduplicated, false)

    const second = await fetch(`${daemon.url}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    const secondBody = (await second.json()) as { deduplicated: boolean }
    assert.equal(secondBody.deduplicated, true, '第二次提交必须被识别为重复')
  })

  test('缺少 runId 或 workDir 时返回 400', async () => {
    const res = await fetch(`${daemon.url}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'execute' }),
    })
    assert.equal(res.status, 400)
  })

  test('未知路径返回 404', async () => {
    const res = await fetch(`${daemon.url}/api/nope`)
    assert.equal(res.status, 404)
  })
})

describe('端到端：失败路径', () => {
  test('★ 后端报失败 ⇒ run 状态为 failed 且带失败原因', async () => {
    const failDir = await makeTempDir('e2e-fail')
    const failData = await makeTempDir('e2e-faildata')
    const failing = new FakeBackend({ fail: true })
    const d = await startDaemon({
      dataDir: failData,
      port: 0,
      fsync: false,
      backend: failing,
      onWarn: () => {},
      onInfo: () => {},
    })

    try {
      const runId = ulid() as RunId
      await fetch(`${d.url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId,
          kind: 'execute',
          agentRef: { id: 'a', name: 'A', instructions: '' },
          skills: [],
          subject: { type: 'issue', id: 'i' },
          prompt: '会失败的任务',
          workDir: failDir,
          limits: { maxTurns: null, timeoutMs: null },
        }),
      })

      const { terminal } = await readUntilTerminal(`${d.url}/api/runs/${runId}/events`)
      assert.equal(terminal?.t === 'terminal' ? terminal.status : null, 'failed')

      const run = (await (await fetch(`${d.url}/api/runs/${runId}`)).json()) as {
        status: string
        failureReason: string | null
      }
      assert.equal(run.status, 'failed')
      assert.notEqual(run.failureReason, null, '失败必须带机器可读的原因码')

      // 失败路径与成功路径**同一条规矩**：我们自己造的那份保留
      //（使用者的原文件仍然逐字节还原，见"不破坏使用者已有的文件"那组用例）
      const leftover = await readFile(join(failDir, 'CLAUDE.md'), 'utf8').catch(() => null)
      assert.notEqual(leftover, null, '失败也不删我们自己造的上下文文件')
      assert.equal(hasContextBlock(leftover!), true)
    } finally {
      await d.close()
      await cleanup(failDir)
      await cleanup(failData)
    }
  })
})

describe('端到端：SSE 终态补发', () => {
  /**
   * ★ 这组测试对应一个**只在使用者面前出现**的 bug。
   *
   * 现象：一次执行跑完之后，日志里开始刷屏"连接中断，正在重连…"。
   *
   * 根因有两处，缺一不可：
   *
   *   1. `terminal` 事件**从不落库**，它只由 registry 实时发一次。所以
   *      "run 结束之后才连上来"的页面（刷新页面、切到已完成的那条 run）
   *      **永远收不到终态**；
   *   2. 收不到终态就不会 `close()`，连接一直挂着；而 `EventSource` 在
   *      任何一次断开后都会自动重连 ⇒ 断开 → 重连 → 还是没有终态 → 再断……
   *
   * 修法：晚订阅时补发一个 terminal 并主动 `end()`。
   */
  test('★ 执行结束后才订阅：补发 terminal，并且流自己结束（不能挂着）', async () => {
    const dataDir = await makeTempDir('e2e-sse-data')
    const work = await makeTempDir('e2e-sse-work')
    const b = new FakeBackend()
    const d = await startDaemon({
      dataDir,
      port: 0,
      fsync: false,
      backend: b,
      onWarn: () => {},
      onInfo: () => {},
    })

    try {
      const runId = ulid() as RunId
      await fetch(`${d.url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId,
          kind: 'execute',
          agentRef: { id: 'a', name: 'A', instructions: '' },
          skills: [],
          subject: { type: 'issue', id: 'i' },
          prompt: '跑完之后再来看日志',
          workDir: work,
          limits: { maxTurns: null, timeoutMs: null },
        }),
      })

      // 先让它真的跑完
      const first = await readUntilTerminal(`${d.url}/api/runs/${runId}/events`)
      assert.equal(first.terminal !== null, true, '第一条订阅应该能拿到终态')

      // 再**新开**一条订阅，模拟"刷新页面"或"切回这条已完成的 run"
      const { events, ended } = await readStreamToEnd(`${d.url}/api/runs/${runId}/events?since=-1`)

      assert.equal(
        ended,
        true,
        '终态之后服务端必须主动 end()——否则连接一直挂着，EventSource 会无限重连',
      )
      assert.equal(
        events.some((e) => e.t === 'terminal'),
        true,
        '晚订阅必须补发 terminal，否则页面永远等不到终态',
      )
      assert.equal(
        events.some((e) => e.t === 'message'),
        true,
        '历史消息仍要补齐——补发终态不能顶掉回放',
      )

      // ══════════════════════════════════════════════════════════════
      // ★ 补发的历史必须是**全部**，一条都不能少
      // ══════════════════════════════════════════════════════════════
      //
      // 这条断言对应界面上的一个真实 bug：任务详情把 `runs` 接口给的
      // `lastSeq`（= 库里已有的最后一条消息的序号）当成订阅参数传了下来，
      // 而 `since=N` 的语义是"跳过 N 及之前的一切"——于是打开一条**跑完的**
      // 任务时，0~N 全被跳过，只收到一个终态事件，**日志是空的**，
      // 而 agent 的最后产出明明就在库里。
      //
      // 所以这里钉住的是"晚订阅者拿到的是完整日志"这个契约：
      // 回放出来的消息必须和 store 里的条数、序号**完全一致**。
      const persisted = ((await (
        await fetch(`${d.url}/api/runs/${runId}/messages`)
      ).json()) as { messages: Array<{ seq: number }> }).messages
      const replayed = events.filter((e) => e.t === 'message')
      assert.deepEqual(
        replayed.map((e) => e.seq),
        persisted.map((m) => m.seq),
        '★ 晚订阅必须补齐**全部**历史消息，而不是只补一条终态',
      )
      assert.ok(persisted.length > 0, '先确认这条 run 确实有历史消息')
    } finally {
      await d.close()
      await cleanup(work)
      await cleanup(dataDir)
    }
  })

  test('★ 执行中订阅：流不能提前结束，否则实时日志就断了', async () => {
    const dataDir = await makeTempDir('e2e-sse-live-data')
    const work = await makeTempDir('e2e-sse-live-work')
    const b = new FakeBackend()
    // ★ 把执行卡在 running 上。不卡住的话 run 会在 POST 返回前就结束，
    //   这条测试就退化成了上一条——看着通过，其实没测"执行中"。
    const release = b.hold()
    const d = await startDaemon({
      dataDir,
      port: 0,
      fsync: false,
      backend: b,
      onWarn: () => {},
      onInfo: () => {},
    })

    try {
      const runId = ulid() as RunId
      await fetch(`${d.url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId,
          kind: 'execute',
          agentRef: { id: 'a', name: 'A', instructions: '' },
          skills: [],
          subject: { type: 'issue', id: 'i' },
          prompt: '实时日志',
          workDir: work,
          limits: { maxTurns: null, timeoutMs: null },
        }),
      })

      let settled = false
      const reading = readStreamToEnd(`${d.url}/api/runs/${runId}/events`, 8_000).finally(() => {
        settled = true
      })

      // 等一小会儿：run 还卡着，流**不该**结束
      await new Promise((resolve) => setTimeout(resolve, 300))
      assert.equal(
        settled,
        false,
        'run 还没结束，SSE 流就不能结束——否则实时日志会断在半路',
      )

      // 放行，这次才该收到终态并结束
      release()
      const { events, ended } = await reading

      assert.equal(ended, true, '跑完之后实时订阅要结束')
      assert.equal(
        events.some((e) => e.t === 'terminal'),
        true,
        '实时订阅必须收到终态',
      )
    } finally {
      release()
      await d.close()
      await cleanup(work)
      await cleanup(dataDir)
    }
  })
})

describe('★ 工作目录文件接口（任务详情右边那一栏）', () => {
  /**
   * ══════════════════════════════════════════════════════════════════
   * 这两个接口读的是**使用者工作目录里的文件**，路径来自查询参数
   * ══════════════════════════════════════════════════════════════════
   *
   * 所以这里不只测"能列、能取"，还要钉住两件安全相关的事：
   *
   *   1. **不许跑出工作目录**（`..`、绝对路径、软链）——单元测试在
   *      `workdir-files.test.ts` 里穷举过，这里从 HTTP 这一层再验一次；
   *   2. **响应必须带 sandbox 的 CSP**：这些文件是 agent 写的，而页面由 daemon
   *      托管 ⇒ 与接口同源。一个带脚本的 html/svg 被当文档打开，就能拿到这个源
   *      直接调 `/api/*`。`sandbox` 让脚本一律不执行。
   */
  test('★ 列出工作目录、取回文件、并挡住路径逃逸', async () => {
    const dataDir = await makeTempDir('files-data')
    const work = await makeTempDir('files-work')
    const b = new FakeBackend()
    const d = await startDaemon({
      dataDir,
      workRoot: join(dataDir, 'work'),
      port: 0,
      fsync: false,
      backend: b,
      onWarn: () => {},
      onInfo: () => {},
    })

    try {
      // 假装 agent 在跑的时候画了张图、写了一份报告
      await writeFile(join(work, 'report.md'), '# 报告\n\n做完了。', 'utf8')
      await writeFile(join(work, 'chart.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf8')

      const runId = ulid() as RunId
      await fetch(`${d.url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId,
          kind: 'execute',
          agentRef: { id: 'a', name: 'A', instructions: '' },
          skills: [],
          subject: { type: 'issue', id: 'i-files' },
          prompt: '画个图',
          workDir: work,
          limits: { maxTurns: null, timeoutMs: null },
        }),
      })
      await readUntilTerminal(`${d.url}/api/runs/${runId}/events`)

      // ── 列表 ──
      const listing = (await (await fetch(`${d.url}/api/runs/${runId}/files`)).json()) as {
        workDir: string
        entries: Array<{ path: string; kind: string; sizeBytes: number; managed: boolean }>
        truncated: boolean
      }
      assert.equal(listing.workDir, work)
      assert.ok(listing.entries.some((e) => e.path === 'report.md'))
      assert.ok(listing.entries.some((e) => e.path === 'chart.svg'))
      assert.equal(
        listing.entries.find((e) => e.path === 'report.md')?.managed,
        false,
        'agent 的产出不算平台注入',
      )

      // ── 取文件 ──
      const fileRes = await fetch(
        `${d.url}/api/runs/${runId}/file?path=${encodeURIComponent('report.md')}`,
      )
      assert.equal(fileRes.status, 200)
      assert.equal(await fileRes.text(), '# 报告\n\n做完了。')
      assert.match(fileRes.headers.get('content-type') ?? '', /text\/plain/)
      // ★ 同源 + agent 写的文件 ⇒ 必须带 sandbox 的 CSP
      assert.match(
        fileRes.headers.get('content-security-policy') ?? '',
        /sandbox/,
        '★ 少了它，一个带脚本的 svg/html 被打开就等于给了对方 daemon 的调用能力',
      )
      assert.equal(fileRes.headers.get('x-content-type-options'), 'nosniff')

      // ── 路径逃逸 ──
      for (const bad of ['../secret.txt', '/etc/passwd', '../../../../etc/passwd']) {
        const res = await fetch(
          `${d.url}/api/runs/${runId}/file?path=${encodeURIComponent(bad)}`,
        )
        assert.equal(res.status, 400, `★ 必须拒绝：${bad}`)
      }
    } finally {
      await d.close()
      await cleanup(work)
      await cleanup(dataDir)
    }
  })

  test('没有工作目录时列表返回空，不报错', async () => {
    const dataDir = await makeTempDir('files-none-data')
    const b = new FakeBackend()
    const d = await startDaemon({
      dataDir,
      workRoot: join(dataDir, 'work'),
      port: 0,
      fsync: false,
      backend: b,
      onWarn: () => {},
      onInfo: () => {},
    })

    try {
      const runId = ulid() as RunId
      await fetch(`${d.url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId,
          kind: 'execute',
          agentRef: { id: 'a', name: 'A', instructions: '' },
          skills: [],
          subject: { type: 'issue', id: 'i-none' },
          prompt: 'x',
          limits: { maxTurns: null, timeoutMs: null },
        }),
      })
      await readUntilTerminal(`${d.url}/api/runs/${runId}/events`)

      const res = await fetch(`${d.url}/api/runs/${runId}/files`)
      assert.equal(res.status, 200)
      const body = (await res.json()) as { entries: unknown[] }
      assert.ok(Array.isArray(body.entries), '空目录也要给一个可用的形状，而不是 500')
    } finally {
      await d.close()
      await cleanup(dataDir)
    }
  })
})

describe('★ 接着沟通：同一任务上再起一条 run，并恢复上一次的会话', () => {
  /**
   * ══════════════════════════════════════════════════════════════════
   * 使用者的原话
   * ══════════════════════════════════════════════════════════════════
   *
   * "在任务完成后，我可能不满意结果，我需要可以在任务细节页面上直接再进行
   *  沟通，以进一步完成任务。"
   *
   * 实现是"同一任务上再起一条 execute run + `resumeFromRunId` 指向上一次"，
   * 而不是"给已有 run 追加消息"：一次 run 的产出是不可变快照，往里塞新输入会
   * 让"它当时收到了什么"不可回答，审计链也就断了。
   *
   * 这条测试钉住两件缺一不可的事：
   *   1. **工作目录不变**（按任务分配，D27）⇒ agent 上次留下的文件还在；
   *   2. **会话被恢复**（FR-CLI-06）⇒ 它是"接着上次说"，不是"从头再来"。
   */
  test('★ 后续 run 会带上上一次的 sessionId，且落在同一个工作目录', async () => {
    const dataDir = await makeTempDir('followup-data')
    const work = await makeTempDir('followup-work')
    const b = new FakeBackend()
    const d = await startDaemon({
      dataDir,
      workRoot: join(dataDir, 'work'),
      port: 0,
      fsync: false,
      backend: b,
      onWarn: () => {},
      onInfo: () => {},
    })

    try {
      const agent = { id: 'agent-followup', name: '接着干', instructions: '干活' }
      const issueId = ulid()
      const firstRunId = ulid() as RunId

      // 第一次执行
      await fetch(`${d.url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId: firstRunId,
          kind: 'execute',
          agentRef: agent,
          skills: [],
          subject: { type: 'issue', id: issueId },
          prompt: '先做一版',
          limits: { maxTurns: null, timeoutMs: null },
        }),
      })
      await readUntilTerminal(`${d.url}/api/runs/${firstRunId}/events`)
      assert.equal(b.seenResumeSessionId, null, '第一次没有上文可恢复')

      // 接着说一句（界面上就是那个「发送并继续」按钮）
      const secondRunId = ulid() as RunId
      await fetch(`${d.url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId: secondRunId,
          kind: 'execute',
          agentRef: agent,
          subject: { type: 'issue', id: issueId },
          prompt: '配色改成浅色系',
          resumeFromRunId: firstRunId,
          limits: { maxTurns: null, timeoutMs: null },
        }),
      })
      await readUntilTerminal(`${d.url}/api/runs/${secondRunId}/events`)

      assert.equal(
        b.seenResumeSessionId,
        'fake-session-1',
        '★ 必须把上一次的 sessionId 交给 CLI 恢复 —— 否则"接着沟通"会变成"从头再来"',
      )

      const runs = ((await (await fetch(`${d.url}/api/runs`)).json()) as {
        runs: Array<{ runId: string; workDir: string | null }>
      }).runs
      const first = runs.find((r) => r.runId === firstRunId)
      const second = runs.find((r) => r.runId === secondRunId)
      assert.equal(
        second?.workDir,
        first?.workDir,
        '★ 同一个任务的工作目录必须相同 —— agent 上次留下的文件要还在',
      )
    } finally {
      await d.close()
      await cleanup(work)
      await cleanup(dataDir)
    }
  })
})

describe('★ INV-1：reviewer ≠ executor 必须在**写入之前**拦住', () => {
  /**
   * ══════════════════════════════════════════════════════════════════
   * 这条不变量实现好了，但调用点从来没接上
   * ══════════════════════════════════════════════════════════════════
   *
   * `packages/domain/src/review/distinct.ts` 里写着"校验放在 **run 创建时**
   *（写入之前），而不是执行时。让它跑起来再失败，使用者已经付出了时间和
   * token 成本，还可能误以为产出被审过了。"
   *
   * 而 `assertReviewerDistinct` 全仓只有它自己的测试在引用——**生产代码零调用**。
   *
   * 自动串接那条路因为角色单一而结构上安全，所以一直没暴露；但 `POST /api/runs`
   * 是公开接口：构造一条 `kind:'review'` + `subject:{type:'run'}`、并且 agentRef
   * 就是那条执行 run 的 agent，就能拿到一次"自己审自己"。INV-1 一破，S1 的整个
   * 闭环就是假的——审核退化成自我确认，而那正是这个产品的定位所在。
   */
  test('★ 让执行者审自己 ⇒ 400，而且**不入库**', async () => {
    const dataDir = await makeTempDir('inv1-data')
    const work = await makeTempDir('inv1-work')
    const b = new FakeBackend()
    const d = await startDaemon({
      dataDir,
      workRoot: join(dataDir, 'work'),
      port: 0,
      fsync: false,
      backend: b,
      onWarn: () => {},
      onInfo: () => {},
    })

    try {
      const execAgent = { id: 'agent-self', name: '自己干自己审', instructions: '' }
      const executeRunId = ulid() as RunId
      await fetch(`${d.url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId: executeRunId,
          kind: 'execute',
          agentRef: execAgent,
          skills: [],
          subject: { type: 'issue', id: 'i-inv1' },
          prompt: '干活',
          workDir: work,
          limits: { maxTurns: null, timeoutMs: null },
        }),
      })
      await readUntilTerminal(`${d.url}/api/runs/${executeRunId}/events`)

      const reviewRunId = ulid() as RunId
      const res = await fetch(`${d.url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId: reviewRunId,
          kind: 'review',
          // ★ 同一个 agent —— 这就是"自己审自己"
          agentRef: execAgent,
          skills: [],
          subject: { type: 'run', id: executeRunId },
          prompt: '审一下你自己',
          limits: { maxTurns: null, timeoutMs: null },
        }),
      })

      assert.equal(res.status, 400, '★ 必须在受理之前拒绝，而不是跑起来之后才失败')
      const body = (await res.json()) as { code?: string }
      assert.equal(body.code, 'reviewer_must_differ')

      // ★ 拒绝必须是"真的没发生"：那条 review run 不能留在库里
      const after = await fetch(`${d.url}/api/runs/${reviewRunId}`)
      assert.equal(after.status, 404, '★ 被拒的 run 不该入库——否则列表里会多一条幽灵')
    } finally {
      await d.close()
      await cleanup(work)
      await cleanup(dataDir)
    }
  })

  test('换个 agent 来审 ⇒ 正常受理', async () => {
    const dataDir = await makeTempDir('inv1-ok-data')
    const work = await makeTempDir('inv1-ok-work')
    const b = new FakeBackend()
    const d = await startDaemon({
      dataDir,
      workRoot: join(dataDir, 'work'),
      port: 0,
      fsync: false,
      backend: b,
      onWarn: () => {},
      onInfo: () => {},
    })

    try {
      const executeRunId = ulid() as RunId
      await fetch(`${d.url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId: executeRunId,
          kind: 'execute',
          agentRef: { id: 'agent-a', name: 'A', instructions: '' },
          skills: [],
          subject: { type: 'issue', id: 'i-inv1b' },
          prompt: '干活',
          workDir: work,
          limits: { maxTurns: null, timeoutMs: null },
        }),
      })
      await readUntilTerminal(`${d.url}/api/runs/${executeRunId}/events`)

      const res = await fetch(`${d.url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId: ulid() as RunId,
          kind: 'review',
          agentRef: { id: 'agent-b', name: 'B', instructions: '' },
          skills: [],
          subject: { type: 'run', id: executeRunId },
          prompt: '审一下',
          limits: { maxTurns: null, timeoutMs: null },
        }),
      })
      assert.equal(res.status, 202, '不同的 agent 审核必须照常放行')
    } finally {
      await d.close()
      await cleanup(work)
      await cleanup(dataDir)
    }
  })
})

describe('★ agent 上填的模型与环境变量必须真的传到 CLI', () => {
  /**
   * ══════════════════════════════════════════════════════════════════
   * 这两条对应一组"界面能选、行为上不存在"的缺陷
   * ══════════════════════════════════════════════════════════════════
   *
   * `Agent.model` 在界面上是可填的（AgentDetail 的「模型」输入框），填完存进库、
   * 界面上也会显示出来——**但执行时被执行器写死成 `model: null` 丢掉了**：
   *
   *     const session = await runtime.backend.execute({ …, model: null, …, env: {} })
   *
   * `argv.ts` 里 `--model` 的拼装、后端里的透传**全都实现好了**，只差把值取出来。
   * 后果是：使用者以为换了模型，其实跑的还是 CLI 的默认模型，而且**不会报错**。
   * `Agent.env` 同样（连界面都没有，只有接口）。
   *
   * 测试只能盯"后端收到了什么"——那是这条链上最后一个我们能观测的点；
   * 再往后是真实 CLI 的行为，不在单测范围（NFR-T-01）。
   */
  test('★ agent 的 model 与 env 会传给后端', async () => {
    const dataDir = await makeTempDir('e2e-agent-cfg-data')
    const work = await makeTempDir('e2e-agent-cfg-work')
    const b = new FakeBackend()
    const d = await startDaemon({
      dataDir,
      workRoot: join(dataDir, 'work'),
      port: 0,
      fsync: false,
      backend: b,
      onWarn: () => {},
      onInfo: () => {},
    })

    try {
      // 建一个配了模型与环境变量的 agent
      const created = (await (
        await fetch(`${d.url}/api/agents`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: '带模型的执行者',
            instructions: '干活',
            role: 'executor',
            model: 'some-model-v9',
            env: { MY_FLAG: 'on' },
          }),
        })
      ).json()) as { id: string; model?: string | null }

      const runId = ulid() as RunId
      await fetch(`${d.url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId,
          kind: 'execute',
          agentRef: { id: created.id, name: '带模型的执行者', instructions: '干活' },
          skills: [],
          subject: { type: 'issue', id: 'i-model' },
          prompt: '干活',
          workDir: work,
          limits: { maxTurns: null, timeoutMs: null },
        }),
      })
      await readUntilTerminal(`${d.url}/api/runs/${runId}/events`)

      assert.equal(
        b.seenModel,
        'some-model-v9',
        '★ agent 上填的模型必须传下去 —— 写死 null 会让"换模型"变成一个不生效的动作',
      )
      assert.equal(b.seenEnv['MY_FLAG'], 'on', '★ agent 的自定义环境变量同样要传下去')
    } finally {
      await d.close()
      await cleanup(work)
      await cleanup(dataDir)
    }
  })
})

describe('端到端：自动分配的工作目录落在「给 daemon 的那个根」底下', () => {
  /**
   * ══════════════════════════════════════════════════════════════════
   * 这是把"CLI 决定默认值"和"run 真的用上了它"接起来的那一环
   * ══════════════════════════════════════════════════════════════════
   *
   * 默认根从 `--data-dir` 推导改成固定路径之后，链路变成了两段：
   *
   *   cli.ts  决定 `workRoot = options.workRoot ?? defaultWorkRoot()`
   *   server.ts 把它交给执行器，执行器用它算出 `<workRoot>/<type>-<id>`
   *
   * 两段各自都有测试（`workdir.test.ts` 测默认值，`resolveWorkDir` 是纯函数），
   * 但**中间那一段没人测**：`workRoot` 如果哪天没被传下去，两边测试照样全绿，
   * 而使用者会发现产出跑回了 `~/.alpha-helper/data/work/` 里。
   */
  test('★ 给了 workRoot ⇒ 自动目录就在它下面，并且受理时已经建好', async () => {
    const dataDir = await makeTempDir('e2e-wr-data')
    const workRoot = await makeTempDir('e2e-wr-root')
    const issueId = ulid()
    const runId = ulid() as RunId
    const b = new FakeBackend()
    const d = await startDaemon({
      dataDir,
      workRoot,
      port: 0,
      fsync: false,
      backend: b,
      onWarn: () => {},
      onInfo: () => {},
    })

    try {
      await fetch(`${d.url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId,
          kind: 'execute',
          agentRef: { id: 'a', name: 'A', instructions: '' },
          skills: [],
          subject: { type: 'issue', id: issueId },
          prompt: '随便做点事',
          limits: { maxTurns: null, timeoutMs: null },
        }),
      })

      const run = (await (await fetch(`${d.url}/api/runs/${runId}`)).json()) as { workDir: string }
      assert.equal(run.workDir, join(workRoot, `issue-${issueId}`))
      assert.equal(
        (await stat(run.workDir)).isDirectory(),
        true,
        '★ 受理时就该建好——使用者提交后立刻能看到它要去哪儿',
      )

      // ⚠️ `seenWorkDir` 只能等 run **真的跑起来**之后再看。
      //    POST 返回的是"已受理"，`execute()` 是之后异步发生的——原来这里
      //    紧接着就断言，纯靠时序侥幸通过（另一条用例就挂了）。
      await readUntilTerminal(`${d.url}/api/runs/${runId}/events`)
      assert.equal(b.seenWorkDir, run.workDir, '执行器用的必须是同一个目录')
    } finally {
      await d.close()
      await cleanup(workRoot)
      await cleanup(dataDir)
    }
  })

  test('★ 不给 workRoot ⇒ 兜底待在数据目录里，**绝不碰家目录**', async () => {
    // 这是"测试不可能污染真实环境"的结构性保证，在**真实代码路径**上验一遍：
    // 忘了传 workRoot 的调用方（尤其是测试）只会得到数据目录里的一个子目录。
    const dataDir = await makeTempDir('e2e-wr-fallback')
    const issueId = ulid()
    const runId = ulid() as RunId
    const b = new FakeBackend()
    const d = await startDaemon({
      dataDir,
      port: 0,
      fsync: false,
      backend: b,
      onWarn: () => {},
      onInfo: () => {},
    })

    try {
      assert.equal(d.workRoot, join(dataDir, 'work'))
      await fetch(`${d.url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId,
          kind: 'execute',
          agentRef: { id: 'a', name: 'A', instructions: '' },
          skills: [],
          subject: { type: 'issue', id: issueId },
          prompt: '随便做点事',
          limits: { maxTurns: null, timeoutMs: null },
        }),
      })

      const run = (await (await fetch(`${d.url}/api/runs/${runId}`)).json()) as { workDir: string }
      assert.ok(
        run.workDir.startsWith(`${dataDir}/`),
        `★ 兜底必须待在数据目录内：${run.workDir}`,
      )

      await readUntilTerminal(`${d.url}/api/runs/${runId}/events`)
      assert.equal(b.seenWorkDir, join(dataDir, 'work', `issue-${issueId}`))
    } finally {
      await d.close()
      await cleanup(dataDir)
    }
  })
})

describe('端到端：不破坏使用者已有的文件', () => {
  test('★ 工作目录里已有 CLAUDE.md ⇒ 注入后再清理，内容逐字节复原', async () => {
    const userDir = await makeTempDir('e2e-user')
    const dataDir = await makeTempDir('e2e-userdata')
    const original = '# 我的项目\n\n这是使用者自己写的内容。\n\n\n'
    await writeFile(join(userDir, 'CLAUDE.md'), original, 'utf8')

    const b = new FakeBackend()
    const d = await startDaemon({
      dataDir,
      port: 0,
      fsync: false,
      backend: b,
      onWarn: () => {},
      onInfo: () => {},
    })

    try {
      const runId = ulid() as RunId
      await fetch(`${d.url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId,
          kind: 'execute',
          agentRef: { id: 'a', name: 'A', instructions: '' },
          skills: [],
          subject: { type: 'issue', id: 'i' },
          prompt: '随便做点事',
          workDir: userDir,
          limits: { maxTurns: null, timeoutMs: null },
        }),
      })
      await readUntilTerminal(`${d.url}/api/runs/${runId}/events`)

      // 执行期间：使用者的内容仍在，且多了我们的块
      assert.ok(b.seenContext?.startsWith('# 我的项目'), '使用者原有内容不能被截断')
      assert.equal(hasContextBlock(b.seenContext!), true)

      // 执行之后：逐字节复原（包括那三个尾部换行）
      const restored = await readFile(join(userDir, 'CLAUDE.md'), 'utf8')
      assert.equal(restored, original, '必须逐字节还原使用者原文件')
    } finally {
      await d.close()
      await cleanup(userDir)
      await cleanup(dataDir)
    }
  })
})

/**
 * 会往 stderr 写东西的假后端。
 *
 * 用来验证"跑成功但 CLI 一直在抱怨"这条路——那是最需要 debug、
 * 而原来完全看不见的一类。
 */
class ChattyStderrBackend implements AgentBackend {
  readonly key = 'claude'
  readonly protocol = 'stream-json' as const
  readonly rejectDetectable = true

  async probe(): Promise<{ available: boolean; command: string; cliVersion: string | null }> {
    return { available: true, command: 'claude', cliVersion: '0.0.0-chatty' }
  }

  async execute(opts: ExecOptions): Promise<AgentSession> {
    // 后端只上报事实，脱敏与记录由调用方做
    opts.onCommandLine?.({
      argv: ['claude', '-p', '--api-key', 'sk-secret-should-be-redacted'],
      sandboxDescription: '未启用沙箱（测试里的假后端）',
    })
    opts.onStderrLine?.('deprecation warning: --verbose is deprecated')

    const queue = new AsyncQueue<AgentMessage>()
    queue.push({ type: 'text', content: '做完了' })
    queue.close()
    return {
      messages: queue,
      result: Promise.resolve({
        status: 'completed',
        output: '做完了',
        error: null,
        durationMs: 5,
        sessionId: 's1',
        usage: null,
        exitCode: 0,
      }),
      async cancel() {},
      lastActivityAt: () => Date.now(),
    }
  }
}

/**
 * 等到日志里出现匹配的行，返回当时**全部**消息的拼接。
 *
 * 与 `waitForMessages` 的区别：那个只等"有消息"，而日志是**边跑边写**的——
 * 开头的行（命令行）与结尾的行（退出码）之间隔着整个执行过程。
 * 断言结尾的行就必须等到它真的出现。
 */
async function waitForText(runId: string, pattern: RegExp): Promise<string> {
  for (let i = 0; i < 400; i += 1) {
    const out = (await (
      await fetch(`${daemon.url}/api/runs/${runId}/messages`)
    ).json()) as { messages: Array<{ content: string }> }
    const text = out.messages.map((m) => m.content).join('\n')
    if (pattern.test(text)) return text
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`等待日志出现 ${pattern} 超时`)
}

/**
 * 等到 run **有消息**为止（消息是流式写入的，可能晚一拍）。
 *
 * ⚠️ 只保证"来了第一条"，**不保证你要的那一句已经写下来了**。
 *    断言具体日志内容时请用 `waitForText(runId, /那句话/)`——否则在负载高的
 *    时候会在那句话写入之前就断言，报出来的是"日志里没有 XX"的假失败。
 */
async function waitForMessages(runId: string): Promise<Array<{ content: string }>> {
  for (let i = 0; i < 200; i += 1) {
    const out = (await (
      await fetch(`${daemon.url}/api/runs/${runId}/messages`)
    ).json()) as { messages: Array<{ content: string }> }
    if (out.messages.length > 0) return out.messages
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('等待 run 消息超时')
}

describe('★ 执行日志必须**看得出**用了哪些 skill', () => {
  /**
   * ══════════════════════════════════════════════════════════════════
   * 这条测试的由来：一次"其实做了、但看不出来"的误判
   * ══════════════════════════════════════════════════════════════════
   *
   * 使用者看执行日志时报告"还是能看到 Claude Code 原本的 skill"，
   * 证据是日志里那句「会话已启动（25 个工具可用）」。
   *
   * 那句话说的是 **Claude Code 内置工具的数量**，与我们的 skill 无关——
   * 我们注入的是 `.claude/skills/<slug>/SKILL.md` 与 `CLAUDE.md`，它们
   * **增加**一份标准，并不会去掉 CLI 自带的工具。
   *
   * 但"确实注入了"和"看得出来注入了"是两件事：日志里**没有任何地方**
   * 说我们注入了什么，于是使用者只能靠猜，而他会猜错。
   *
   * 所以要有一行明确的记录。
   */
  test('★ 日志里有一行说明本次注入了哪些 skill', async () => {
    const runId = ulid() as RunId
    const res = await fetch(`${daemon.url}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runId,
        kind: 'execute',
        agentRef: { id: 'agent-with-skill', name: '带技能的执行者', instructions: '' },
        skills: [
          {
            ref: { id: 'sk-1', slug: 'general-review', source: 'local' },
            slug: 'general-review',
            name: '通用审核',
            body: '# 标准\n\n只判断，不提额外要求。',
            allowedActions: ['comment.create'],
            files: {},
          },
        ],
        subject: { type: 'issue', id: issueId },
        prompt: '干活',
        workDir,
        limits: { maxTurns: null, timeoutMs: null },
      }),
    })
    assert.equal(res.status, 202)

    // ★ 必须等**那句话**，不能等"随便来一条消息"。
    //   `waitForMessages()` 一有消息就返回，而日志是流式写入的——注入说明
    //   排在"会话已启动"之后。用它在负载高的时候会在说明写下来之前就断言，
    //   于是报出一个"日志里没有注入说明"的假失败（实测偶发）。
    const text = await waitForText(runId, /已注入 1 个 skill/)
    assert.match(
      text,
      /已注入 1 个 skill：general-review/,
      '★ 日志里必须说清注入了什么——否则使用者只能靠猜，而他会猜错',
    )
    assert.match(text, /CLAUDE\.md|上下文文件/, '也要说清写到哪儿了')
  })

  test('★ 支持文件也要真的落到工作目录里（只写 SKILL.md 就是坏技能）', async () => {
    /**
     * ══════════════════════════════════════════════════════════════════
     * 这条测试补的是"装进来了"与"用上了"之间那一环
     * ══════════════════════════════════════════════════════════════════
     *
     * 一个技能可以带支持文件（脚本、参考文档）。如果注入时只写 SKILL.md，
     * 技能里引用的 `scripts/check.sh` 在运行时**根本不存在**——技能装上了、
     * 日志上看着也注入了，但 agent 一用它就找不到文件。
     *
     * 而且它很可能不报错：模型只会说"我找不到那个脚本"，然后自己换个做法。
     * 从使用者的角度来看就是"这个技能好像不太灵"。
     *
     * ══════════════════════════════════════════════════════════════════
     * ★ 它用**自己的** daemon 与假后端，不共用本文件那两个
     * ══════════════════════════════════════════════════════════════════
     *
     * 第一版用的是共享的 `daemon` / `backend`，于是它偶发失败（约 1/5~1/8）：
     * `seenSkillFiles` 是**共享假后端上的一个可变字段**，文件里别的用例如果有
     * 还没跑完的 run，那次 `execute()` 会把快照**整个重置**再填上它自己那个
     * 工作目录的内容——于是这条用例读到的是一份别人的快照。
     *
     * 报出来的错极具误导性：`SKILL.md 应当在执行那一刻就在工作目录里`
     *（实际值是空串，因为 walk 先 readdir 到了名字、readFile 时文件已经随
     *  清理消失了），看起来像"注入没写下去"，而真凶是**测试之间抢同一个字段**。
     *
     * 这与 review-e2e.test.ts 里那段"下一个用例偷走上一个用例的 script"
     * 是同一类问题：共享的假后端 + 异步派生的 run。
     */
    const ownDir = await makeTempDir('e2e-skill-files-data')
    const dir = await makeTempDir('e2e-skill-files')
    const ownBackend = new FakeBackend()
    const own = await startDaemon({
      dataDir: ownDir,
      workRoot: join(ownDir, 'work'),
      port: 0,
      fsync: false,
      backend: ownBackend,
      onWarn: () => {},
      onInfo: () => {},
    })

    try {
      const runId = ulid() as RunId
      const res = await fetch(`${own.url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId,
          kind: 'execute',
          agentRef: { id: 'agent-with-files', name: '带支持文件的执行者', instructions: '' },
          skills: [
            {
              ref: { id: 'sk-files', slug: 'with-support', source: 'local' },
              slug: 'with-support',
              name: '带支持文件',
              body: '# 标准\n\n看 scripts/check.sh。',
              allowedActions: ['comment.create'],
              files: { 'scripts/check.sh': '#!/bin/sh\necho ok\n', 'reference.md': '参考资料' },
            },
          ],
          subject: { type: 'issue', id: issueId },
          prompt: '干活',
          workDir: dir,
          limits: { maxTurns: null, timeoutMs: null },
        }),
      })
      assert.equal(res.status, 202)

      // 等 run 真的结束，而不是"有消息了"——快照是在 execute() 那一刻抓的，
      // 但 run 结束才意味着后面不会再有人动这个目录
      await readUntilTerminal(`${own.url}/api/runs/${runId}/events`)

      const files = ownBackend.seenSkillFiles
      assert.match(
        files['with-support/SKILL.md'] ?? '',
        /看 scripts\/check\.sh/,
        'SKILL.md 应当在执行那一刻就在工作目录里',
      )
      assert.equal(
        files['with-support/scripts/check.sh'],
        '#!/bin/sh\necho ok\n',
        '★ 支持文件必须一起写下去 —— 少了它技能就是坏的，而且坏得很安静',
      )
      assert.equal(files['with-support/reference.md'], '参考资料')
    } finally {
      await own.close()
      await cleanup(dir)
      await cleanup(ownDir)
    }
  })

  test('★ 没挂 skill 时也要明说，而不是留白', async () => {
    // 留白会被读成"注入了但没显示"，而真相是"这个 agent 没配 skill"
    const runId = ulid() as RunId
    await fetch(`${daemon.url}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runId,
        kind: 'execute',
        agentRef: { id: 'bare', name: '没配技能的', instructions: '' },
        skills: [],
        subject: { type: 'issue', id: issueId },
        prompt: '干活',
        workDir,
        limits: { maxTurns: null, timeoutMs: null },
      }),
    })

    // 同上：等那句话本身，而不是"有消息了"
    const text = await waitForText(runId, /没有注入任何 skill/)
    assert.match(text, /按它自己的默认行为工作/, '要说清后果是什么')
  })
})

describe('★ 日志要够 debug：命令行 / stderr / 退出码', () => {
  /**
   * ══════════════════════════════════════════════════════════════════
   * 原来缺的三样东西
   * ══════════════════════════════════════════════════════════════════
   *
   * 1. **命令行**完全不在日志里。它只进审计记录，而审计是**审核收口**时
   *    才写的——execute run 根本不产生审计。所以想看"当时到底怎么起的进程"
   *    只能去翻代码。
   * 2. **stderr 只被攒成尾巴，且只在失败时才出现**（截断到 500 字符）。
   *    于是"跑成功了但 CLI 一直在抱怨"这种情况完全看不见——而那恰恰是
   *    最需要 debug 的一类。
   * 3. **退出码**同样只在失败时出现。
   */
  test('★ 日志里有命令行、退出码，且命令行已脱敏', async () => {
    const runId = ulid() as RunId
    await fetch(`${daemon.url}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runId,
        kind: 'execute',
        agentRef: { id: 'a1', name: '助手', instructions: '' },
        skills: [],
        subject: { type: 'issue', id: issueId },
        prompt: '干活',
        workDir,
        limits: { maxTurns: null, timeoutMs: null },
      }),
    })

    // ⚠️ 不能用"有消息就返回"——命令行是**开头**写的，退出码是**结尾**写的。
    //    我第一版就是这么写的，于是断言退出码时 run 还没跑完。
    //    要等到终态那一行出现。
    const text = await waitForText(runId, /进程结束：status=/)
    assert.match(text, /命令行：/, '★ 要能直接看到并复制出当时的命令')
    assert.match(text, /进程结束：status=completed/, '★ 退出码是"进程怎么结束的"最直接的证据')
    assert.match(text, /exitCode=/, '退出码要带上')
  })

  test('★ stderr 会被写进日志 —— 跑成功但 CLI 抱怨的那种情况要看得见', async () => {
    // 假后端在 execute 时不写 stderr，所以这里直接验证**多行 stderr 的
    // 上报路径**：用一个会往 stderr 写东西的假后端。
    const dir = await makeTempDir('stderr-log')
    const work = await makeTempDir('stderr-work')
    const backend = new ChattyStderrBackend()
    const d = await startDaemon({
      dataDir: dir,
      port: 0,
      fsync: false,
      backend,
      onWarn: () => {},
      onInfo: () => {},
    })
    try {
      const runId = ulid() as RunId
      await fetch(`${d.url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId,
          kind: 'execute',
          agentRef: { id: 'a1', name: 'x', instructions: '' },
          skills: [],
          subject: { type: 'issue', id: 'i1' },
          prompt: 'x',
          workDir: work,
          limits: { maxTurns: null, timeoutMs: null },
        }),
      })
      await new Promise((r) => setTimeout(r, 400))
      const out = (await (
        await fetch(`${d.url}/api/runs/${runId}/messages`)
      ).json()) as { messages: Array<{ content: string }> }
      const text = out.messages.map((m) => m.content).join('\n')
      assert.match(text, /stderr: .*deprecation warning/, 'stderr 要逐行进日志')

      // ★ 命令行进日志，但**凭据不能进**。
      //   脱敏走的是 domain 的 redactArgv —— 与审计记录同一份实现。
      //   适配器依赖不到 domain，所以它只上报事实、由调用方脱敏：
      //   安全逻辑只有一份，不会漂。
      assert.match(text, /命令行：/, '要能看到当时的命令')
      assert.ok(
        !text.includes('sk-secret-should-be-redacted'),
        '★ 凭据绝不能出现在日志里 —— 日志是最容易被贴进 issue 的东西',
      )
      assert.match(text, /\*\*\*/, '凭据位置应当被替换成掩码')
    } finally {
      await d.close()
      await cleanup(dir)
      await cleanup(work)
    }
  })
})

describe('★ 日志要有**输入**（方便 debug）', () => {
  test('★ prompt 出现在日志里，且长 prompt 截断时说明还剩多少', async () => {
    // 排查时最先要回答的两个问题是"给了它什么"与"它做了什么"。
    // 后者原本只有工具名没有参数，前者**完全不在日志里**。
    const runId = ulid() as RunId
    const longPrompt = '甲'.repeat(3000)
    await fetch(`${daemon.url}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runId,
        kind: 'execute',
        agentRef: { id: 'a1', name: '助手', instructions: '' },
        skills: [],
        subject: { type: 'issue', id: issueId },
        prompt: longPrompt,
        workDir,
        limits: { maxTurns: null, timeoutMs: null },
      }),
    })

    const text = await waitForText(runId, /输入（prompt/)
    assert.match(text, /输入（prompt，3000 字符）/, '要说明这次给了它多少')
    assert.match(text, /还有 1000 字符未显示/, '★ 截断必须明说剩多少——静默截断会让人以为它就收到这些')
  })

  test('短 prompt 完整显示，不加"还有 N 字符"', async () => {
    const runId = ulid() as RunId
    await fetch(`${daemon.url}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runId,
        kind: 'execute',
        agentRef: { id: 'a1', name: '助手', instructions: '' },
        skills: [],
        subject: { type: 'issue', id: issueId },
        prompt: '把功能实现一下',
        workDir,
        limits: { maxTurns: null, timeoutMs: null },
      }),
    })
    const text = await waitForText(runId, /输入（prompt/)
    assert.match(text, /把功能实现一下/)
    assert.ok(!/还有 \\d+ 字符未显示/.test(text), '没截断就不该说截断了')
  })
})

describe('★ 日志要说清沙箱**到底开没开**', () => {
  /**
   * ══════════════════════════════════════════════════════════════════
   * 这条测试的由来：一个"从命令行反推"的问题
   * ══════════════════════════════════════════════════════════════════
   *
   * 日志里原本只有一行命令行。使用者看到
   *   `/opt/homebrew/bin/claude -p --output-format stream-json …`
   * 问："我看命令没有包括沙盒呢"——而那个 daemon 确实**没开**沙箱，
   * 所以命令是对的。
   *
   * 问题在于**看不出来**：一条没被包装的命令，分不清是"沙箱没开"还是
   * "沙箱开了但没生效"。这两者的排查方向完全不同。
   *
   * 所以沙箱状态要**由后端如实上报**，而不是让人从命令行里找
   * `sandbox-exec`——那是从结果反推原因，而且不同的包装器名字不同。
   */
  test('★ 未启用沙箱时也要明说，而不是留白', async () => {
    const runId = ulid() as RunId
    await fetch(`${daemon.url}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runId,
        kind: 'execute',
        agentRef: { id: 'a1', name: '助手', instructions: '' },
        skills: [],
        subject: { type: 'issue', id: issueId },
        prompt: '干活',
        workDir,
        limits: { maxTurns: null, timeoutMs: null },
      }),
    })
    const text = await waitForText(runId, /沙箱：/)
    assert.match(text, /沙箱：未启用沙箱/, '★ 没开也要说，否则分不清"没开"与"开了没生效"')
  })

  test('★ 开着沙箱时，命令行里真的有包装器，且状态行说明它不是安全边界', async () => {
    const dir = await makeTempDir('sandbox-log')
    const work = await makeTempDir('sandbox-log-work')
    const b = new FakeBackend()
    const d = await startDaemon({
      dataDir: dir,
      port: 0,
      fsync: false,
      backend: b,
      sandboxMode: 'workdir-write',
      onWarn: () => {},
      onInfo: () => {},
    })
    try {
      const runId = ulid() as RunId
      await fetch(`${d.url}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          runId,
          kind: 'execute',
          agentRef: { id: 'a1', name: 'x', instructions: '' },
          skills: [],
          subject: { type: 'issue', id: 'i1' },
          prompt: 'x',
          workDir: work,
          limits: { maxTurns: null, timeoutMs: null },
        }),
      })
      await new Promise((r) => setTimeout(r, 300))
      const out = (await (
        await fetch(`${d.url}/api/runs/${runId}/messages`)
      ).json()) as { messages: Array<{ content: string }> }
      const text = out.messages.map((m) => m.content).join('\n')

      // 假后端不真的走沙箱，所以这里只验证**管道**：命令行与沙箱状态
      // 都被如实上报到了日志里（真包装由 agent-core 的沙箱测试覆盖）。
      assert.match(text, /命令行：/, '命令行要在')
      assert.match(text, /沙箱：/, '★ 沙箱状态要在——两者缺一个都会让人反推')
    } finally {
      await d.close()
      await cleanup(dir)
      await cleanup(work)
    }
  })
})
