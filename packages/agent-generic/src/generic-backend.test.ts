import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentMessage, AgentSession } from '@alpha-helper/agent-core'
import { GenericBackend, classifyGenericFailure } from './generic-backend.ts'
import { cleanup, makeTempDir } from './testing/tmp.ts'
import { descriptorFor, makeFakeCli, readArgvEcho, type FakeCli } from './testing/fake-cli-helpers.ts'

/**
 * 后端测试。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这里跑的是**真的子进程**，只是装的不是真 CLI
 * ══════════════════════════════════════════════════════════════════
 *
 * NFR-T-01 禁止测试调用真实 CLI：它会烧掉使用者的额度，而且会真的改文件。
 * 但"不调真 CLI"不等于"只做单元测试"——那样就测不到进程管理、stdin 关闭、
 * 退出码判定这些最容易出错的地方。
 *
 * 所以这里用假可执行文件把整条链路真跑一遍：spawn → 喂 prompt → 读 NDJSON
 * → 判终态。假 CLI 会把**实际收到的 argv 落盘**，于是断言的是"进程真的收到了
 * 这些参数"，而不是"我以为 buildArgv 会拼出这些参数"。
 */

let tmpDir: string
let fake: FakeCli
let workDir: string

before(async () => {
  tmpDir = await makeTempDir('generic-backend')
  fake = await makeFakeCli(tmpDir)
  workDir = join(tmpDir, 'work')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(workDir, { recursive: true })
})

after(async () => {
  await cleanup(tmpDir)
})

interface RunOutcome {
  messages: AgentMessage[]
  result: Awaited<AgentSession['result']>
  session: AgentSession
}

/** 跑一次假 CLI，把消息与终态都收齐。 */
async function run(
  scenario: string,
  options: {
    env?: Record<string, string>
    prompt?: string
    customArgs?: readonly string[]
    model?: string | null
    maxTurns?: number | null
    resumeSessionId?: string | null
    descriptor?: Parameters<typeof descriptorFor>[0]
    executablePath?: string
    warnings?: string[]
    onActivity?: () => void
  } = {},
): Promise<RunOutcome> {
  const warnings = options.warnings ?? []
  const backend = new GenericBackend({
    descriptor: descriptorFor(options.descriptor ?? {}),
    executablePath: options.executablePath ?? fake.executablePath,
    useProbeCache: false,
    onWarn: (m) => warnings.push(m),
  })

  const session = await backend.execute({
    prompt: options.prompt ?? '请总结这份报告\n最后一行是暗号',
    workDir,
    env: fake.env(scenario, options.env),
    model: options.model ?? null,
    maxTurns: options.maxTurns ?? null,
    resumeSessionId: options.resumeSessionId ?? null,
    customArgs: options.customArgs ?? [],
    ...(options.onActivity ? { onActivity: options.onActivity } : {}),
    signal: new AbortController().signal,
  })

  const messages: AgentMessage[] = []
  for await (const message of session.messages) messages.push(message)

  return { messages, result: await session.result, session }
}

describe('GenericBackend —— 正常路径（真的起了一个子进程）', () => {
  test('★ 假 CLI 的 NDJSON 被解析成归一化消息，终态为 completed', async () => {
    const { messages, result } = await run('ok')
    assert.deepEqual(
      messages.map((m) => m.type),
      ['text', 'tool_use', 'tool_result', 'thinking'],
      'session 事件不在已知事件名里，按设计被忽略——它不该产出一条消息',
    )
    assert.equal(messages[0]?.content, '收到 15 字节', 'prompt 真的送到了子进程（字符数对得上）')
    assert.equal(result.status, 'completed')
    assert.equal(result.exitCode, 0)
    assert.equal(result.error, null)
    assert.equal(result.sessionId, 'fake-sess-1')
  })

  test('★ prompt 真的到了子进程里（回显的最后一行就是 prompt 的末行）', async () => {
    const { result } = await run('ok')
    assert.equal(result.output, '完成：最后一行是暗号')
  })

  test('usage 被归一化，成本记成整数微美元', async () => {
    const { result } = await run('ok')
    assert.equal(result.usage?.inputTokens, 120)
    assert.equal(result.usage?.outputTokens, 30)
    assert.equal(result.usage?.costUsdMicros, 420)
    assert.equal(result.usage?.costSource, 'provider')
  })

  test('★ 进程实际收到的 argv：基础参数在前、受管参数其次、prompt 在末尾', async () => {
    const echoPath = join(fake.dataDir, 'argv-ok.json')
    const { result } = await run('ok', { env: { FAKE_ARGV_ECHO_FILE: echoPath } })
    assert.equal(result.status, 'completed')

    const argv = await readArgvEcho(echoPath)
    assert.deepEqual(argv.slice(0, 4), ['--non-interactive', '--output', 'ndjson', '--no-color'])
    assert.ok(argv.includes('--no-ask-user'))
    assert.equal(argv.at(-1), '请总结这份报告\n最后一行是暗号', 'prompt 是最后一个参数')
  })

  test('受管参数用描述表里的旗标名拼，不是 claude 的拼写', async () => {
    const echoPath = join(fake.dataDir, 'argv-managed.json')
    const { result } = await run('ok', {
      model: 'gpt-5',
      maxTurns: 3,
      resumeSessionId: 'sess-abc',
      customArgs: ['--verbose'],
      env: { FAKE_ARGV_ECHO_FILE: echoPath },
    })
    assert.equal(result.status, 'completed')

    const argv = await readArgvEcho(echoPath)
    assert.equal(argv[argv.indexOf('-m') + 1], 'gpt-5')
    assert.equal(argv[argv.indexOf('--max-steps') + 1], '3')
    assert.equal(argv[argv.indexOf('--resume-session') + 1], 'sess-abc')
    assert.ok(argv.includes('--verbose'), '使用者的自定义参数要保留')
    assert.equal(argv.includes('--model'), false, '不得混入 claude 的拼写')
    assert.equal(argv.includes('--max-turns'), false)
  })

  test('另一个投递模式：prompt 走 stdin 的 NDJSON 帧', async () => {
    const echoPath = join(fake.dataDir, 'stdin-frame.json')
    const { result } = await run('ok', {
      descriptor: { promptDelivery: 'stdin-ndjson' },
      env: { FAKE_PROMPT_STDIN: '1', FAKE_PROMPT_ECHO_FILE: echoPath },
    })
    assert.equal(result.status, 'completed')

    const frame = JSON.parse(await readFile(echoPath, 'utf8')) as Record<string, unknown>
    assert.equal(frame['type'], 'prompt')
    assert.equal(frame['prompt'], '请总结这份报告\n最后一行是暗号')
  })

  test('★ 禁改参数被过滤掉，并以警告的形式说出来（FR-CLI-12：不得静默丢弃）', async () => {
    const warnings: string[] = []
    const echoPath = join(fake.dataDir, 'argv-dropped.json')
    const { result } = await run('ok', {
      // ⚠️ 顺序有讲究：**被丢弃的参数必须在中间**，不能是最后一个。
      //
      // 踩过一次：一开始写的是 `['--prompt', '改用我这条', '--output', 'text']`，
      // 于是 `--output text` 被丢值之后，argv 的末尾变成了自定义参数，
      // 而 prompt 追加在末尾——两边都认为自己该在最后。假 CLI 按"最后一个是
      // prompt"读，就把自定义参数当成了 prompt，回显对不上。
      //
      // 那个失败暴露了一个**真实边界**：`promptDelivery: 'argv'` 要求
      // "prompt 是最后一个参数"，所以使用者自定义参数永远在它前面。
      // 真实 CLI 若有"位置参数必须在最后"的硬要求，这就得重新设计投递方式。
      customArgs: ['--prompt', '改用我这条', '--output', 'text', '--verbose'],
      env: { FAKE_ARGV_ECHO_FILE: echoPath },
      warnings,
    })
    assert.equal(result.status, 'completed', '被丢弃的参数不会拖垮这次运行')

    const argv = await readArgvEcho(echoPath)
    assert.equal(argv.includes('--prompt'), false)
    assert.equal(argv.includes('改用我这条'), false, '禁改参数的值必须一起丢掉')
    assert.equal(argv.includes('text'), false)
    assert.ok(argv.includes('--verbose'))
    assert.equal(argv.at(-1), '请总结这份报告\n最后一行是暗号', 'prompt 仍然在末尾')
    assert.equal(warnings.length, 1, '丢弃必须记警告，不得静默')
    assert.match(warnings[0] ?? '', /--prompt/)
    assert.match(warnings[0] ?? '', /忽略/)
  })

  test('工具输出超长时被截断，并标记 outputTruncated', async () => {
    const { messages } = await run('long-tool-output')
    const toolResult = messages.find((m) => m.type === 'tool_result')
    assert.equal(toolResult?.outputTruncated, true)
    assert.ok((toolResult?.output ?? '').length < 9000)
  })

  test('onActivity 在每次输出时被调用（活性判定 FR-RUN-08 的判据）', async () => {
    let activity = 0
    await run('ok', { onActivity: () => (activity += 1) })
    assert.ok(activity > 0, '有输出就必须有活动信号')
  })

  test('cancel() 能终止进程树', async () => {
    const backend = new GenericBackend({
      descriptor: descriptorFor({}),
      executablePath: fake.executablePath,
      useProbeCache: false,
    })
    const session = await backend.execute({
      prompt: 'x',
      workDir,
      env: fake.env('ok'),
      signal: new AbortController().signal,
    })
    await session.cancel()
    const result = await session.result
    assert.ok(result.exitCode !== 0 || result.exitCode === null, '被终止的进程不该报成功')
  })
})

describe('GenericBackend —— 失败分级（FR-CLI-41 / design §9.7）', () => {
  test('★ 全是自由文本、没有任何 NDJSON ⇒ 明确失败，不是"跑完了但没内容"', async () => {
    const { result } = await run('plain-text')
    assert.equal(result.status, 'failed')
    assert.match(result.error ?? '', /无法解析/)
    assert.match(result.error ?? '', /什么都没说/, '错误文本要指出这类失败过去长什么样')
    assert.equal(result.exitCode, 0, '退出码是 0——所以判失败只能靠"输出不可解析"这一条')
  })

  test('★ 一半能解析、一半不能，且没有终止事件 ⇒ 仍然明确失败', async () => {
    const { messages, result } = await run('garbled')
    assert.equal(result.status, 'failed')
    assert.match(result.error ?? '', /无法解析/)
    assert.match(result.error ?? '', /不可解析行 2 行/)
    // 不可解析的行必须**在消息流里可见**，而不是只体现在终态错误里
    const logs = messages.filter((m) => m.type === 'log')
    assert.equal(logs.length, 2)
    assert.ok(logs.every((m) => (m.content ?? '').includes('不可解析')))
  })

  test('★ 有事件、有遥测，但没有终止事件 ⇒ 仍然是失败（只是"没说完"不是"说完了"）', async () => {
    const { result } = await run('usage-only')
    assert.equal(result.status, 'failed')
    assert.match(result.error ?? '', /无法解析/)
    assert.equal(result.usage?.inputTokens, 10, '遥测仍然要带出来，便于诊断')
  })

  test('★ 认识的事件一条都没有、退出码非 0 ⇒ 失败原因是"输出不可解析"而非"agent 报错"', async () => {
    const { result } = await run('garbage')
    assert.equal(result.status, 'failed')
    assert.match(result.error ?? '', /无法解析/)
    assert.equal(result.exitCode, 3)
  })

  test('CLI 自报失败 ⇒ failed，错误文本用 CLI 自己的话', async () => {
    const { result } = await run('error-status')
    assert.equal(result.status, 'failed')
    assert.equal(result.error, '额度用尽了')
    assert.equal(result.usage, null)
  })

  test('★ 崩在启动阶段（stderr 有内容、stdout 全空）⇒ 可读失败并带上 stderr', async () => {
    const { result } = await run('stderr-crash')
    assert.equal(result.status, 'failed')
    assert.match(result.error ?? '', /无法解析/)
    assert.match(result.error ?? '', /Cannot find module/)
    assert.equal(result.exitCode, 1)
  })

  test('中途被杀：没有终止事件也没有退出码 ⇒ 失败', async () => {
    const { result } = await run('partial')
    assert.equal(result.status, 'failed')
    assert.match(result.error ?? '', /无法解析/)
  })

  test('有内容但没有终止事件、也没有不可解析行 ⇒ 仍然失败（这里刻意不放过）', async () => {
    // 这条曾经是本项目最容易被"宽容"掉的一种：CLI 说了话、退出码 0，
    // 只是没说"我干完了"。放过它 = run 以"完成、输出为空"入库。
    const { result } = await run('no-result')
    assert.equal(result.status, 'failed')
  })

  test('★ 失败分级是纯函数，可以逐条钉住（它一旦变松，表现形式是"什么都没说"）', () => {
    assert.equal(
      classifyGenericFailure({
        recognizedEvents: 0,
        resultSeen: false,
        unparsableLines: 0,
        parserIsError: false,
        exitCode: 0,
      }),
      'cli_unparsable_output',
      '一条事件都没认出来，退出码 0——最典型的静默失败',
    )
    assert.equal(
      classifyGenericFailure({
        recognizedEvents: 3,
        resultSeen: false,
        unparsableLines: 2,
        parserIsError: false,
        exitCode: 0,
      }),
      'cli_unparsable_output',
      '格式改到一半：前面还认识，后面全变了',
    )
    assert.equal(
      classifyGenericFailure({
        recognizedEvents: 3,
        resultSeen: true,
        unparsableLines: 0,
        parserIsError: true,
        exitCode: 1,
      }),
      'agent_error',
    )
    assert.equal(
      classifyGenericFailure({
        recognizedEvents: 5,
        resultSeen: true,
        unparsableLines: 0,
        parserIsError: false,
        exitCode: 0,
      }),
      null,
    )
    assert.equal(
      classifyGenericFailure({
        recognizedEvents: 5,
        resultSeen: true,
        unparsableLines: 1,
        parserIsError: false,
        exitCode: 0,
      }),
      null,
      '零星一行诊断信息不该把一次成功的运行判成失败——否则可用性会被噪声吃掉',
    )
  })
})

describe('GenericBackend —— 可执行文件缺失与探测', () => {
  // ⚠️ 这一组断言在实现过程中改过一次，值得记下来。
  //
  // 最初只在 spawn 之后看结果，于是"路径写错了"与"路径指到一个目录"都变成
  // 「exit=null + 输出不可解析」，错误文本里只有 Node 的 `spawn EACCES`——
  // 使用者拿到一句关于解析器的话，而真正的问题是路径。所以现在
  // **起进程之前**先判断"这个文件到底能不能跑"，三种情况（不存在 /
  // 不是普通文件 / 没有执行权限）都在这里被翻译成人话。
  //
  // ⚠️ 第一次修的时候想复用 `findOnPath`，结果**目录测试仍然失败**：
  //    `findOnPath` 查的是 `X_OK`，而目录也有执行位。判断"能不能当程序跑"
  //    必须看**普通文件 + 执行权限**两件事（见 `isRunnableFile`）。
  //    这种"看起来对、跑起来才发现不对"的坑，正是要求测试覆盖失败路径的理由。
  //
  // 这对齐了 claude 后端的契约：**能提前确定原因的失败就抛**，
  // 进程起来之后的失败才走 failed 结果。抛出来的异常在 executor 里是
  // "这次 run 根本没开始"，而不是"agent 跑失败了"，两者不该混为一谈。
  test('★ 可执行文件不存在 ⇒ 抛错，且错误指出未验证这件事', async () => {
    await assert.rejects(
      () => run('ok', { executablePath: join(tmpDir, 'definitely-not-here') }),
      (err: Error) => {
        assert.match(err.message, /找不到|未安装/)
        assert.match(err.message, /provisional/, '要提示这是未验证的 runtime，命令名可能就不对')
        return true
      },
    )
  })

  test('★ 直接指向一个目录 ⇒ 同样是可读的抛错，不是 EACCES 裸奔', async () => {
    await assert.rejects(
      () => run('ok', { executablePath: tmpDir }),
      (err: Error) => {
        assert.match(err.message, /执行权限|目录/)
        assert.equal(/spawn EACCES/.test(err.message), false, '不要把 Node 的裸错误丢给使用者')
        return true
      },
    )
  })

  test('探测不到时 probe() 说实话，不假装可用', async () => {
    const backend = new GenericBackend({
      descriptor: descriptorFor({ command: 'definitely-not-a-real-cli-xyz' }),
      useProbeCache: false,
    })
    const probe = await backend.probe()
    assert.equal(probe.available, false)
    assert.equal(probe.cliVersion, null)
    assert.equal(probe.command, 'definitely-not-a-real-cli-xyz')
  })

  test('探测到假 CLI 时返回版本（`--version` 早返回，不与剧本输出混在一起）', async () => {
    const backend = new GenericBackend({
      descriptor: descriptorFor({}),
      executablePath: fake.executablePath,
      useProbeCache: false,
    })
    const probe = await backend.probe()
    assert.equal(probe.available, true)
    assert.equal(probe.cliVersion, '0.0.0-fake')
  })
})

describe('GenericBackend —— 会话恢复（FR-CLI-06 的语义陷阱）', () => {
  test('★ rejectDetectable=false 时必须返回 undefined（无法判断），不许冒充"没被拒"', async () => {
    const { result } = await run('ok', { resumeSessionId: 'sess-abc' })
    assert.equal(result.status, 'completed')
    assert.equal(
      result.resumeRejected,
      undefined,
      '本 runtime 测不出拒绝：认不出来的 false 与"确实没被拒"是两回事',
    )
  })

  test('描述符声明 rejectDetectable=true 时才上报探测结果（改一行数据即可启用）', async () => {
    const detected = await run('ok', {
      resumeSessionId: 'sess-abc',
      descriptor: { resume: { flag: '--resume-session', rejectDetectable: true } },
    })
    assert.equal(detected.result.resumeRejected, false, '正常输出里没有拒绝措辞')

    // 让 CLI 在 stderr 上说"没有这个会话"，探测应当命中
    const rejected = await run('resume-rejected', {
      resumeSessionId: 'sess-abc',
      descriptor: { resume: { flag: '--resume-session', rejectDetectable: true } },
    })
    assert.equal(rejected.result.resumeRejected, true, 'stderr 里明说了 unknown session')
    assert.equal(rejected.result.status, 'failed')
  })

  test('没要求恢复时 resumeRejected 为 undefined（无从谈起）', async () => {
    const { result } = await run('ok')
    assert.equal(result.resumeRejected, undefined)
  })
})

describe('适配器契约一致性（两个 runtime 走同一套接口）', () => {
  test('★ GenericBackend 满足 AgentBackend：key / protocol / rejectDetectable / probe / execute', async () => {
    const backend = new GenericBackend({
      descriptor: descriptorFor({}),
      executablePath: fake.executablePath,
      useProbeCache: false,
    })
    assert.equal(backend.key, 'generic')
    assert.equal(backend.protocol, 'stream-json')
    assert.equal(backend.rejectDetectable, false)
    assert.equal(typeof backend.probe, 'function')
    assert.equal(typeof backend.execute, 'function')
  })

  test('lastActivityAt() 返回时间戳，供活性判定使用', async () => {
    const backend = new GenericBackend({
      descriptor: descriptorFor({}),
      executablePath: fake.executablePath,
      useProbeCache: false,
    })
    const session = await backend.execute({
      prompt: 'x',
      workDir,
      env: fake.env('ok'),
      signal: new AbortController().signal,
    })
    assert.ok(session.lastActivityAt() <= Date.now())
    await session.result
  })
})
