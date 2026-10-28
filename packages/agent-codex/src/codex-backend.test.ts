import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import type { AgentMessage, ExecOptions } from '@agentdeck/agent-core'
import { CodexBackend } from './codex-backend.ts'
import { codexDescriptor, unverifiedFields } from './codex-descriptor.ts'
import {
  descriptorFor,
  makeFakeAppServer,
  readRpcEcho,
  type FakeAppServer,
} from './testing/fake-app-server-helpers.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'

/**
 * 后端测试：整条链在**假 app-server** 上跑通（NFR-T-01，不调真实 codex）。
 *
 * 剧本、协议形状、RPC 回显的约定见 `testing/fake-app-server.ts`。所有
 * JSON-RPC 时序参数（超时、背压重试）都设成对测试友好的小值，避免用例挂住。
 */

let fake: FakeAppServer
let tmp: string

before(async () => {
  tmp = await makeTempDir('codex-backend')
  fake = await makeFakeAppServer(tmp)
})

after(async () => {
  await cleanup(tmp)
})

function makeBackend(
  overrides: {
    scenario?: string
    extraEnv?: Record<string, string>
    /** 后端级别的告警出口（`onWarn` 是**构造**参数，不是 ExecOptions 的）。 */
    onWarn?: (message: string) => void
  } = {},
) {
  const echoFile = join(fake.dataDir, `rpc-${Math.random().toString(36).slice(2)}.json`)
  return {
    echoFile,
    backend: new CodexBackend({
      descriptor: descriptorFor(),
      executablePath: fake.executablePath,
      useProbeCache: false,
      // 测试友好：超时短、背压重试关
      rpcTimeoutMs: 5000,
      rpcMaxRetries: 0,
      rpcRetryDelayMs: 0,
      ...(overrides.onWarn === undefined ? {} : { onWarn: overrides.onWarn }),
    }),
    env: {
      ...fake.env(overrides.scenario ?? 'ok', { FAKE_RPC_ECHO_FILE: echoFile }),
      ...(overrides.extraEnv ?? {}),
    },
  }
}

function execOpts(
  overrides: Partial<ExecOptions> & { workDir: string; env: Record<string, string> },
): ExecOptions {
  return {
    prompt: '把 a.txt 读完',
    model: 'gpt-5.3-codex',
    onCommandLine: () => {},
    onStderrLine: () => {},
    ...overrides,
  }
}

/** 跑一次完整 run：收完流、等终态。 */
async function run(backend: CodexBackend, opts: ExecOptions) {
  const messages: AgentMessage[] = []
  const session = await backend.execute(opts)
  for await (const m of session.messages) messages.push(m)
  const result = await session.result
  return { messages, result }
}

/**
 * ★ 分批第 74 批：①② 挂在线程上（`thread/start.baseInstructions`），每轮只发 ③。
 *
 * 起因：使用者报「在 codex CLI 情况下，每次沟通，都会发送完整的『框架+身份+任务』」。
 * 量下来一句聊天是 271 字符，其中 ① 120 + ② 37、③ 只有 7 —— 96% 是每轮重复。
 * 而 codex 的线程本身就带着上文（`thread/resume` 之后 ①② 仍在，实测 0.157.1 用暗号验过），
 * 所以恢复过的轮次重发它们是纯冗余。
 *
 * 判据落在**协议参数**上（假 app-server 会把收到的请求原样回显到文件）：
 *   · 建线程那次 `thread/start` 必须带 `baseInstructions` = ①②；
 *   · 每轮 `turn/start` 的 input 必须**只有** ③（不含 ①）；
 *   · 恢复那次 `thread/resume` 不重发指令（线程带着）；
 *   · 恢复被拒后**重建线程**时**也要**带 `baseInstructions`（上文没了 ≠ 身份也没了）。
 */
describe('★ 分批第 74 批：线程级指令（thread/start.baseInstructions）', () => {
  const INSTR =
    '===== ① 框架 =====\n\n你在一个聊天窗口里和一个人说话。\n\n===== ② 身份 =====\n\n你是一个严谨的协作者。'

  test('★★★ 建线程带 baseInstructions；这一轮的 input 只有 ③', async () => {
    const { backend, env, echoFile } = makeBackend({ scenario: 'ok' })
    const workDir = await makeTempDir('codex-instr')
    try {
      await run(
        backend,
        execOpts({ workDir, env, prompt: '你是 claude 还是 codex？', systemPrompt: INSTR }),
      )
      const echo = await readRpcEcho(echoFile)
      const start = echo.requests.find((r) => r.method === 'thread/start')
      assert.ok(start, '要发出 thread/start')
      assert.equal(start!.params['baseInstructions'], INSTR, '★ ①② 必须作为线程级指令送进去')
      const turn = echo.requests.find((r) => r.method === 'turn/start')
      const input = turn!.params['input'] as Array<{ text: string }>
      assert.equal(
        input[0]!.text,
        '你是 claude 还是 codex？',
        '★ 每轮的 input 只该是 ③，不许再把 ①② 塞回来',
      )
    } finally {
      await cleanup(workDir)
    }
  })

  test('★★★ 恢复时不重发指令（线程带着）；恢复被拒后重建线程**仍带**', async () => {
    // ① 恢复成功：thread/resume 的参数里不许出现 baseInstructions
    {
      const { backend, env, echoFile } = makeBackend({ scenario: 'ok' })
      const workDir = await makeTempDir('codex-instr-resume')
      try {
        await run(
          backend,
          execOpts({
            workDir,
            env,
            prompt: '接着上次说',
            systemPrompt: INSTR,
            resumeSessionId: 'thr_existing',
          }),
        )
        const echo = await readRpcEcho(echoFile)
        const resume = echo.requests.find((r) => r.method === 'thread/resume')
        assert.ok(resume, '要发出 thread/resume')
        assert.equal(
          'baseInstructions' in resume!.params,
          false,
          '★ 恢复那一跳不该重发指令——线程里本来就有（这正是这一批省掉的那部分）',
        )
        assert.equal(echo.requests.some((r) => r.method === 'thread/start'), false, '恢复成功就不该建新线程')
      } finally {
        await cleanup(workDir)
      }
    }
    // ② 恢复被拒（假 server 的 `resume-missing` 剧本回 -32600）⇒ 重建线程，且必须带指令
    {
      const { backend, env, echoFile } = makeBackend({ scenario: 'resume-missing' })
      const workDir = await makeTempDir('codex-instr-rejected')
      try {
        await run(
          backend,
          execOpts({
            workDir,
            env,
            prompt: '接着上次说',
            systemPrompt: INSTR,
            resumeSessionId: 'thr_missing',
          }),
        )
        const echo = await readRpcEcho(echoFile)
        const start = echo.requests.find((r) => r.method === 'thread/start')
        assert.ok(start, '恢复被拒要回退建新线程')
        assert.equal(
          start!.params['baseInstructions'],
          INSTR,
          '★ 上文没了不等于身份也没了——重建线程同样要带上 ①②',
        )
      } finally {
        await cleanup(workDir)
      }
    }
  })

  test('★★ 没有系统提示时**不加**这个参数（空串不该变成"空指令"）', async () => {
    const { backend, env, echoFile } = makeBackend({ scenario: 'ok' })
    const workDir = await makeTempDir('codex-instr-none')
    try {
      await run(backend, execOpts({ workDir, env }))
      const echo = await readRpcEcho(echoFile)
      const start = echo.requests.find((r) => r.method === 'thread/start')
      assert.equal('baseInstructions' in start!.params, false, '没给 ①② 就不要凭空塞一个空字段')
    } finally {
      await cleanup(workDir)
    }
  })
})


describe('★ 分批第 44 批：JSON-RPC 摘要要报给调用方（service 形状的"发了什么"）', () => {
  /**
   * 使用者报过：「日志里有『命令行：/opt/homebrew/bin/codex app-server --stdio』，
   * 后面应该有发给它的命令，没有打印出来」。
   *
   * 这条用例量的是**后端有没有把这些帧交出去**（日志怎么落地是 executor 的事，
   * 那一条在 `apps/daemon/src/rpc-log.test.ts` 与 e2e 里）。
   */
  test('★★★ initialize / thread/start / turn/start 的出场顺序与内容都对，且 turn/start 带 sentText', async () => {
    const { backend, env } = makeBackend({ scenario: 'ok' })
    const workDir = await makeTempDir('codex-rpc-log')
    try {
      const notes: Array<{ direction: string; method: string; headline: string; sentText?: string }> = []
      const opts = execOpts({
        workDir,
        env,
        onRpcFrame: (n) => notes.push(n),
      })
      await run(backend, opts)

      const outMethods = notes.filter((n) => n.direction === 'out').map((n) => n.method)
      assert.ok(outMethods.includes('initialize'), `出站要有 initialize：${outMethods.join(',')}`)
      assert.ok(outMethods.includes('thread/start'), `出站要有 thread/start：${outMethods.join(',')}`)
      assert.ok(outMethods.includes('turn/start'), `出站要有 turn/start：${outMethods.join(',')}`)
      // ★ 顺序：initialize 一定在最前（协议要求握手先来）
      assert.equal(outMethods[0], 'initialize')

      const inMethods = notes.filter((n) => n.direction === 'in').map((n) => n.method)
      assert.ok(inMethods.includes('initialize'), '入站也要有（失败时"是它没回"要看得出来）')
      assert.ok(
        notes.some((n) => n.direction === 'in' && n.method === 'turn/start' && n.headline.includes('成功')),
        '入站摘要要带上成功/失败与耗时——排查时要分清"没回"与"回了错"',
      )

      // ★★ 真正发出去的正文必须交给调用方（它是"我看到的输入是不是它收到的输入"的唯一凭据）
      const sent = notes.filter((n) => n.sentText !== undefined)
      assert.equal(sent.length, 1, `只该有 turn/start 带正文，实际 ${String(sent.length)} 条`)
      assert.equal(sent[0]?.method, 'turn/start')
      assert.equal(sent[0]?.sentText, '把 a.txt 读完', 'sentText 必须是**原样**的 input 文本')
      /**
       * ★ 分批第 46 批（使用者：「尽量在发送的位置直接打，保证真实性」）：
       * 正文必须是**从写进 stdin 的那一行字节里**抠出来的，而不是"我们打算发的那份"。
       * 报出来的标题要说清这一点，并带上整帧的字节数（能对上"发出去的确实是这一帧"）。
       */
      assert.match(
        sent[0]?.headline ?? '',
        /已写入 codex stdin/u,
        `标题要说明它是从写出去的那一行里取的：${sent[0]?.headline ?? ''}`,
      )
      assert.match(sent[0]?.headline ?? '', /字节/u, '要带上整帧字节数')
    } finally {
      await cleanup(workDir)
    }
  })

  test('★★ 服务端拒绝时，入站摘要要写明是哪个方法 + code（不然只剩一句"对话阶段失败"）', async () => {
    // 用假 server 真有的剧本：`resume-missing` 对 `thread/resume` 回 -32600
    const { backend, env } = makeBackend({ scenario: 'resume-missing' })
    const workDir = await makeTempDir('codex-rpc-fail')
    try {
      const notes: Array<{ direction: string; method: string; headline: string }> = []
      await run(
        backend,
        execOpts({ workDir, env, resumeSessionId: 'thr_missing', onRpcFrame: (n) => notes.push(n) }),
      )
      const failed = notes.filter((n) => n.direction === 'in' && n.headline.includes('失败'))
      assert.ok(failed.length > 0, `要有一条"失败"的入站摘要：${JSON.stringify(notes)}`)
      assert.match(failed[0]?.headline ?? '', /code [0-9-]+/, '要带上 JSON-RPC 错误码')
    } finally {
      await cleanup(workDir)
    }
  })
})

describe('CodexBackend（codex app-server 适配器，假 server 上整链跑通）', () => {
  test('★ ok：completed、流式消息、CLI 报告的模型、用量、会话 id、命令行如实上报', async () => {
    const { backend, env, echoFile } = makeBackend({ scenario: 'ok' })
    const workDir = await makeTempDir('codex-work')
    try {
      const argvReported: string[] = []
      let sandboxDescription = ''
      const opts = execOpts({
        workDir,
        env,
        onCommandLine: ({ argv, sandboxDescription: sd }) => {
          argvReported.push(...argv)
          sandboxDescription = sd
        },
      })
      const { messages, result } = await run(backend, opts)

      assert.equal(result.status, 'completed')
      assert.equal(result.output, '完成了：hello')
      assert.equal(result.sessionId, 'thr_fake-1', '会话凭据 = thread_id')
      assert.equal(result.model, 'fake-model', '用 thread/start 响应的 model（CLI 报告的）')
      assert.equal(result.usage?.inputTokens, 100)
      assert.equal(result.usage?.costSource, 'estimated')
      assert.equal(result.exitCode, null)

      // 流式消息齐了
      const types = messages.map((m) => m.type)
      assert.ok(types.includes('tool_use'))
      assert.ok(types.includes('tool_result'))
      assert.ok(types.includes('thinking'))
      assert.ok(messages.some((m) => m.type === 'text' && m.content === '完成了：hello'))

      // ★ 命令行是"最终"的：启动参数来自描述表 baseArgs
      assert.deepEqual(argvReported, [fake.executablePath, 'app-server', '--stdio'])
      assert.match(sandboxDescription, /未启用沙箱/, '没开沙箱也要明说')

      // ★ 进程实际收到的 RPC：thread/start 参数、turn/start 的 input 文本
      const echo = await readRpcEcho(echoFile)
      const threadStart = echo.requests.find((r) => r.method === 'thread/start')
      assert.ok(threadStart, '应该调用 thread/start')
      assert.equal((threadStart!.params as Record<string, unknown>)['approvalPolicy'], 'never')
      // ★ macOS 上 workspace-write 的 seatbelt 断网（#10390，实测 502）——
      //   codex 任务必须 danger-full-access 才能连模型端点（见 codex-descriptor.ts）
      assert.equal((threadStart!.params as Record<string, unknown>)['sandbox'], 'danger-full-access')
      assert.equal((threadStart!.params as Record<string, unknown>)['model'], 'gpt-5.3-codex')
      assert.equal((threadStart!.params as Record<string, unknown>)['cwd'], workDir)
      const turnStart = echo.requests.find((r) => r.method === 'turn/start')
      assert.ok(turnStart, '应该调用 turn/start')
      // ★ 实测（0.144.0-alpha.4）：恢复的线程 approvalPolicy 会退回 on-request，
      //   所以 turn/start 也必须显式传 never（不只是 thread/start）
      assert.equal((turnStart!.params as Record<string, unknown>)['approvalPolicy'], 'never')
      // ★ 每一轮都显式给 cwd（分批第 15 批）：thread 的 cwd 只在创建时定、resume 改不了它，
      //   所以"thread 已带"不成立——不带的话，这一轮在哪执行取决于服务端怎么取舍（没量过）。
      assert.equal((turnStart!.params as Record<string, unknown>)['cwd'], workDir)
      const input = (turnStart!.params as { input?: Array<{ type: string; text: string }> })['input']
      assert.equal(input?.[0]?.type, 'text')
      assert.equal(input?.[0]?.text, '把 a.txt 读完', 'prompt 原样作为 text input（B 档三段已合成）')
    } finally {
      await cleanup(workDir)
    }
  })

  test('★ resume：给了 resumeSessionId 就走 thread/resume，而不是 thread/start', async () => {
    const { backend, env, echoFile } = makeBackend({ scenario: 'ok' })
    const workDir = await makeTempDir('codex-work')
    try {
      const { result } = await run(backend, execOpts({ workDir, env, resumeSessionId: 'thr_fake-1' }))
      assert.equal(result.status, 'completed')
      assert.equal(result.resumeRejected, false, '恢复成功 = 明确没被拒（rejectDetectable=true 的收益）')
      const echo = await readRpcEcho(echoFile)
      const methods = echo.requests.map((r) => r.method)
      assert.ok(methods.includes('thread/resume'), '应该走 thread/resume')
      assert.ok(!methods.includes('thread/start'), '不应再开新线程')
      const resume = echo.requests.find((r) => r.method === 'thread/resume')!
      assert.equal((resume.params as Record<string, unknown>)['threadId'], 'thr_fake-1')
      // ★★ resume 那一路才是 cwd 的要害：线程是**别处**建的（沉淀返工：resume 的是上一版的
      //    线程，而这一版在自己的新小屋里干活）。thread/resume 改不了线程的 cwd（参数只有
      //    threadId）⇒ 只能靠本轮显式指定。这条断言就是"别把 cwd 省掉"的钉子。
      const turnStartOnResume = echo.requests.find((r) => r.method === 'turn/start')!
      assert.equal(
        (turnStartOnResume.params as Record<string, unknown>)['cwd'],
        workDir,
        'resume 的那一轮必须显式带 cwd（线程带的可能是旧目录）',
      )
      // thread/resume 响应不带 model ⇒ CLI 未报告 ⇒ null（不拿请求值顶替）
      assert.equal(result.model, null)
      assert.equal(result.sessionId, 'thr_fake-1')
    } finally {
      await cleanup(workDir)
    }
  })

  test('★★ resume 的线程带着**别的**工作目录 ⇒ 告警说清楚，且本轮仍用本轮的目录', async () => {
    // 这一条是**使用者提问量出来的**：他看到日志里"工作目录已切换到新任务"，问"这说明工作目录
    // 有变化？为什么需要变化呢"。查下来发现 `turn/start` 一直没带 cwd，而 resume 的线程带的 cwd
    // 是它**创建时**那个（沉淀返工就是这样：v2 在自己的小屋里干活，resume 的是 v1 的线程）。
    // 两条一起量：① 说清楚"两者不一致"；② 本轮显式用**本轮**的目录。
    const otherDir = await makeTempDir('codex-other-work')
    const workDir = await makeTempDir('codex-work')
    const warnings: string[] = []
    const { backend, env, echoFile } = makeBackend({
      scenario: 'ok',
      extraEnv: { FAKE_RESUME_CWD: otherDir },
      onWarn: (m) => warnings.push(m),
    })
    try {
      const { result } = await run(backend, execOpts({ workDir, env, resumeSessionId: 'thr_fake-1' }))
      assert.equal(result.status, 'completed')
      assert.ok(
        warnings.some((w) => w.includes(otherDir) && w.includes(workDir)),
        `该告警说清"线程的目录 vs 本轮的目录"，实际：${JSON.stringify(warnings)}`,
      )
      const echo = await readRpcEcho(echoFile)
      const turnStart = echo.requests.find((r) => r.method === 'turn/start')!
      assert.equal(
        (turnStart.params as Record<string, unknown>)['cwd'],
        workDir,
        '本轮必须在**本轮**的目录里执行（不是线程带的那个）',
      )
    } finally {
      await cleanup(workDir)
      await cleanup(otherDir)
    }
  })

  test('★ resume 的目标线程不存在 → 服务端拒绝（-32600）→ 回退新线程继续 + resumeRejected=true', async () => {
    const { env, echoFile } = makeBackend({ scenario: 'resume-missing' })
    const workDir = await makeTempDir('codex-work')
    const warnings: string[] = []
    try {
      const messages: AgentMessage[] = []
      const session = await new CodexBackend({
        descriptor: descriptorFor(),
        executablePath: fake.executablePath,
        useProbeCache: false,
        rpcTimeoutMs: 5000,
        rpcMaxRetries: 0,
        rpcRetryDelayMs: 0,
        onWarn: (m) => warnings.push(m),
      }).execute(execOpts({ workDir, env, resumeSessionId: 'thr_missing' }))
      for await (const m of session.messages) messages.push(m)
      const result = await session.result

      // ★ 与 claude 的语义一致（FR-CLI-06）：被拒 → 新线程继续 + 大声标记缺上文
      assert.equal(result.status, 'completed')
      assert.equal(result.resumeRejected, true)
      assert.equal(result.sessionId, 'thr_fake-1', '回退的新线程成为下次 resume 的凭据')
      assert.ok(warnings.some((w) => /会话恢复被 codex 服务端拒绝/.test(w)), '必须大声说明缺上文')
      assert.ok(warnings.some((w) => /缺少上文/.test(w)))
      const echo = await readRpcEcho(echoFile)
      const methods = echo.requests.map((r) => r.method)
      assert.ok(methods.includes('thread/resume'), '先试恢复')
      assert.ok(methods.includes('thread/start'), '被拒后回退开新线程')
    } finally {
      await cleanup(workDir)
    }
  })

  test('★ turn failed（TurnError 带 codexErrorInfo）→ failed run，错误文本保留原话', async () => {
    const { backend, env } = makeBackend({ scenario: 'failed-turn' })
    const workDir = await makeTempDir('codex-work')
    try {
      const { result } = await run(backend, execOpts({ workDir, env }))
      assert.equal(result.status, 'failed')
      assert.match(result.error ?? '', /Usage limit exceeded/)
      assert.match(result.error ?? '', /UsageLimitExceeded/)
      assert.equal(result.output, '我试了但不行')
    } finally {
      await cleanup(workDir)
    }
  })

  test('★ 输出里混了不可解析行但 turn 正常结束 → 宽容通过（log 可见 + 计数）', async () => {
    const { backend, env } = makeBackend({ scenario: 'garbled' })
    const workDir = await makeTempDir('codex-work')
    try {
      const { messages, result } = await run(backend, execOpts({ workDir, env }))
      assert.equal(result.status, 'completed', '零星坏行不该把成功的 run 判成失败')
      assert.ok(messages.some((m) => m.type === 'log' && /不可解析/.test(m.content)))
    } finally {
      await cleanup(workDir)
    }
  })

  test('★ 什么都没说（零事件、进程干净退出）→ cli_unparsable_output', async () => {
    const { backend, env } = makeBackend({ scenario: 'empty' })
    const workDir = await makeTempDir('codex-work')
    try {
      const { result } = await run(backend, execOpts({ workDir, env }))
      assert.equal(result.status, 'failed')
      assert.match(result.error ?? '', /无法解析为 JSON-RPC 帧/)
    } finally {
      await cleanup(workDir)
    }
  })

  test('★ 有内容但没有终止帧（没有 turn/completed）→ cli_unparsable_output', async () => {
    const { backend, env } = makeBackend({ scenario: 'no-turn-end' })
    const workDir = await makeTempDir('codex-work')
    try {
      const { result } = await run(backend, execOpts({ workDir, env }))
      assert.equal(result.status, 'failed')
      assert.match(result.error ?? '', /无法解析为 JSON-RPC 帧/)
    } finally {
      await cleanup(workDir)
    }
  })

  test('★ 审批请求（approvalPolicy:never 下不应出现）→ 回 decline + 大声警告，run 仍完成', async () => {
    const { env, echoFile } = makeBackend({ scenario: 'approval' })
    const workDir = await makeTempDir('codex-work')
    const warnings: string[] = []
    try {
      const messages: AgentMessage[] = []
      const session = await new CodexBackend({
        descriptor: descriptorFor(),
        executablePath: fake.executablePath,
        useProbeCache: false,
        rpcTimeoutMs: 5000,
        rpcMaxRetries: 0,
        rpcRetryDelayMs: 0,
        onWarn: (m) => warnings.push(m),
      }).execute(execOpts({ workDir, env }))
      for await (const m of session.messages) messages.push(m)
      const result = await session.result

      assert.equal(result.status, 'completed')
      assert.ok(warnings.some((w) => /收到服务端请求/.test(w)), '必须大声说明收到了审批请求')
      assert.ok(warnings.some((w) => /无人值守策略/.test(w)))
      // 假 server 收到我们的 decline 并记了下来
      const echo = await readRpcEcho(echoFile)
      assert.deepEqual(echo.approvalDecision, { decision: 'decline' })
    } finally {
      await cleanup(workDir)
    }
  })

  test('★ customArgs 对 service 没有语义 → 警告 + 不静默', async () => {
    const { backend, env } = makeBackend({ scenario: 'ok' })
    const workDir = await makeTempDir('codex-work')
    const warnings: string[] = []
    try {
      const session = await new CodexBackend({
        descriptor: descriptorFor(),
        executablePath: fake.executablePath,
        useProbeCache: false,
        rpcTimeoutMs: 5000,
        rpcMaxRetries: 0,
        rpcRetryDelayMs: 0,
        onWarn: (m) => warnings.push(m),
      }).execute(execOpts({ workDir, env, customArgs: ['--verbose'] }))
      for await (const _ of session.messages) void _
      await session.result
      assert.ok(warnings.some((w) => /service 形状/.test(w) && /自定义 CLI 参数/.test(w)))
    } finally {
      await cleanup(workDir)
    }
  })

  test('★ maxTurns 无上限可执行 → 警告 + 不静默', async () => {
    const { backend, env } = makeBackend({ scenario: 'ok' })
    const workDir = await makeTempDir('codex-work')
    const warnings: string[] = []
    try {
      const session = await new CodexBackend({
        descriptor: descriptorFor(),
        executablePath: fake.executablePath,
        useProbeCache: false,
        rpcTimeoutMs: 5000,
        rpcMaxRetries: 0,
        rpcRetryDelayMs: 0,
        onWarn: (m) => warnings.push(m),
      }).execute(execOpts({ workDir, env, maxTurns: 8 }))
      for await (const _ of session.messages) void _
      await session.result
      assert.ok(warnings.some((w) => /没有 turn 上限/.test(w)))
    } finally {
      await cleanup(workDir)
    }
  })

  test('★ cancel：turn/interrupt → turn/completed(interrupted) → 进程被收掉，结果正常收尾', async () => {
    const { backend, env } = makeBackend({ scenario: 'slow' })
    const workDir = await makeTempDir('codex-work')
    try {
      const session = await backend.execute(execOpts({ workDir, env }))
      await new Promise((r) => setTimeout(r, 80)) // 让 turn 跑一会儿
      await session.cancel()
      const result = await session.result
      // interrupted 且平台已请求取消 ⇒ 不算异常
      assert.equal(result.status, 'completed')
    } finally {
      await cleanup(workDir)
    }
  })

  test('★ probe：可用、命令名对、版本来自假 server', async () => {
    const { backend } = makeBackend()
    const probe = await backend.probe()
    assert.equal(probe.available, true)
    assert.equal(probe.command, 'codex-app-server-fake')
    assert.match(probe.cliVersion ?? '', /fake/)
  })

  test('★ 描述符证据等级是 verified，且残余核对清单仍在（数据，不是注释）', () => {
    assert.equal(codexDescriptor().evidence, 'verified')
    assert.equal(codexDescriptor().versions?.verifiedWith?.[0], '0.144.0-alpha.4')
    assert.ok(unverifiedFields().length >= 1, '残余未验证项清单不能消失')
  })
})
