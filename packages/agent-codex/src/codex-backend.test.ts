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

function makeBackend(overrides: { scenario?: string; extraEnv?: Record<string, string> } = {}) {
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
      // thread/resume 响应不带 model ⇒ CLI 未报告 ⇒ null（不拿请求值顶替）
      assert.equal(result.model, null)
      assert.equal(result.sessionId, 'thr_fake-1')
    } finally {
      await cleanup(workDir)
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
