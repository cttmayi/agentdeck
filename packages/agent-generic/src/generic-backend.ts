import { constants, existsSync } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import {
  AsyncQueue,
  buildArgv,
  describeDropped,
  detectVersion,
  loadRuntimeDescriptor,
  probeCommand,
  cliStateDir,
  planSandbox,
  spawnProcessTree,
  type AgentBackend,
  type AgentMessage,
  type AgentResult,
  type AgentSession,
  type ExecOptions,
  type RuntimeDescriptor,
} from '@alpha-helper/agent-core'
import type { RuntimeProtocol } from '@alpha-helper/protocol'
import {
  GenericStreamParser,
  buildGenericInput,
  detectResumeRejection,
} from './stream-parser.ts'

/**
 * 第二个 runtime 的适配器。
 *
 * 职责边界与 `ClaudeBackend` **完全一致**（拼参数、起进程、喂 prompt、
 * 解析输出、报终态），这本身就是"可插拔"的证据：两个适配器面对同一张
 * 描述表、同一套禁用参数过滤、同一套失败分级，只有**协议形状**不同。
 *
 * ⚠️ 描述符是 `provisional`（见 `generic-descriptor.ts`）：真实 CLI 的字段名
 *    未验证。本文件的逻辑在假可执行文件上全部跑通（NFR-T-01），
 *    但"字段名对得上"要等首次接入真实 CLI。
 */

export interface GenericBackendOptions {
  descriptor: RuntimeDescriptor
  /** 覆盖可执行文件路径；不给则自动探测。测试用假 CLI 时走这条。 */
  executablePath?: string
  /** 丢弃受管参数时的警告出口（FR-CLI-12：不得静默丢弃）。 */
  onWarn?: (message: string) => void
  /** 缓存探测结果。测试里关掉。 */
  useProbeCache?: boolean
}

/**
 * 失败分级的结果（FR-CLI-41 / design §9.7）。
 *
 * 单独抽出来是为了**可单独测试**：失败分级的判定逻辑最容易在改动中悄悄
 * 变松（"这次先放过吧"），而它一旦变松，表现是"agent 什么都没说"
 * 而不是任何报错。判定函数是纯的，测试可以直接喂各种解析器状态。
 */
export type GenericFailure =
  /** 输出完全不可解析——run 必须失败。 */
  | 'cli_unparsable_output'
  /** CLI 自报失败。 */
  | 'agent_error'
  /** 没有失败证据。 */
  | null

/**
 * 判定一次运行的终态是不是失败（FR-CLI-41）。
 *
 * 三条判据按**优先级**排列，顺序本身就是设计：
 *
 * 1. **没有任何可识别事件** ⇒ 不可解析。这是最要命的一种：CLI 装了、跑起来了、
 *    退出码还是 0，但它说的话我们一个字都没听懂。若不在这里判失败，
 *    run 会以"完成，输出为空"结束——design §9.7 里说的"静默失败"。
 * 2. **没有终止事件** ⇒ 不可解析。这条是写完第 1 条之后才补上的，值得记下来：
 *    原本写的是"没有终止事件**且有不可解析行**"才判失败，于是
 *    `{"type":"text","text":"我说了话"}` 然后干净退出（exit 0）会被判成
 *    **成功**——正是这个函数想防的那种静默失败，只不过藏在了它自己的分支里。
 *    测试 `★ 有内容但没有终止事件` 把它抓了出来。
 *    终止事件是协议的一部分：没有它，"说完了"与"卡住了"无法区分。
 * 3. 其余按解析器自报的错误与退出码判定。
 *
 * 反方向也要守住：**零星一两行不可解析不该把成功的运行判成失败**。
 * 有的 CLI 会往 stdout 混一行诊断信息，把它当致命错误会让可用性被噪声吃掉。
 * 所以判据 2 要求"没有终止事件"，而不是"有不可解析行"。
 */
export function classifyGenericFailure(input: {
  recognizedEvents: number
  resultSeen: boolean
  unparsableLines: number
  parserIsError: boolean
  exitCode: number | null
}): GenericFailure {
  const exitedNonZero = input.exitCode !== null && input.exitCode !== 0

  if (input.recognizedEvents === 0) return 'cli_unparsable_output'
  if (!input.resultSeen) return 'cli_unparsable_output'
  if (input.parserIsError || exitedNonZero) return 'agent_error'
  return null
}

/** 把分类结果翻成人看得懂、且指出下一步动作的错误文本。 */
function describeFailure(
  failure: Exclude<GenericFailure, null>,
  ctx: {
    command: string
    exitCode: number | null
    unparsableLines: number
    stderrTail: string
    maxLineExceeded: boolean
    /** CLI 自己报的错误文本——它比我们的推断更具体，优先用它。 */
    cliErrorText: string | null
  },
): string {
  const stderr = ctx.stderrTail.trim()
  const suffix = stderr ? `\nstderr: ${stderr.slice(-500)}` : ''

  if (failure === 'cli_unparsable_output') {
    return (
      `${ctx.command} 的输出无法解析为 NDJSON 事件（exit=${ctx.exitCode ?? 'null'}，` +
      `不可解析行 ${ctx.unparsableLines} 行${ctx.maxLineExceeded ? '，含超长行' : ''}）。` +
      `这类失败以前会表现为"agent 什么都没说"——现在它是明确失败。` +
      `常见原因：CLI 版本升级改了输出格式，或它把诊断信息打到了 stdout。` +
      `本 runtime 的证据等级是 provisional，请先核对描述表里的字段名。` +
      suffix
    )
  }

  // ★ CLI 自己说了原因就用它的原话。
  //   写成"报告运行失败（exit=1）"等于把**已经拿到的信息丢掉**——
  //   使用者要的是"额度用尽了"，而不是我们转述的"它失败了"。
  return (
    ctx.cliErrorText ??
    `${ctx.command} 报告运行失败（exit=${ctx.exitCode ?? 'null'}）。${suffix}`
  )
}

/** 各类 spawn 失败的可读翻译。给不出翻译时原样返回，不吞掉细节。 */
function describeSpawnError(err: unknown, command: string, path: string): string {
  const code = (err as NodeJS.ErrnoException | null)?.code
  switch (code) {
    case 'ENOENT':
      return (
        `找不到 ${command} 可执行文件（${path}）。` +
        `请先安装它；若已安装，试着重启 daemon 以重新探测 PATH。`
      )
    case 'EACCES':
      return `${command} 不可执行（${path}）：权限不足。检查文件权限或挂载选项。`
    default:
      return `启动 ${command} 失败：${String(err)}`
  }
}

export class GenericBackend implements AgentBackend {
  readonly key: string
  readonly protocol: RuntimeProtocol
  readonly rejectDetectable: boolean

  readonly #descriptor: RuntimeDescriptor
  readonly #options: GenericBackendOptions

  constructor(options: GenericBackendOptions) {
    this.#options = options
    // 补齐 managedFlags 等可选字段：调用方传进来的可能是一行"裸表行"，
    // 直接拿它去拼参数会读到 undefined。
    this.#descriptor = loadRuntimeDescriptor(options.descriptor)
    this.key = this.#descriptor.key
    this.protocol = this.#descriptor.protocol
    this.rejectDetectable = this.#descriptor.resume.rejectDetectable
  }

  async #resolveExecutable(): Promise<string | null> {
    if (this.#options.executablePath) return this.#options.executablePath
    const probe = await probeCommand(this.#descriptor.command, {
      useCache: this.#options.useProbeCache ?? true,
    })
    return probe.available ? probe.path : null
  }

  async probe(): Promise<{ available: boolean; command: string; cliVersion: string | null }> {
    const path = await this.#resolveExecutable()
    if (!path) {
      return { available: false, command: this.#descriptor.command, cliVersion: null }
    }
    return {
      available: true,
      command: this.#descriptor.command,
      cliVersion: await detectVersion(path),
    }
  }

  async execute(opts: ExecOptions): Promise<AgentSession> {
    const executablePath = await this.#resolveExecutable()
    if (!executablePath) {
      // 探测失败的措辞与下面那条路径**故意分开**：
      // 这里连"该找哪个名字"都不知道（PATH 里没有这个命令），而下面的
      // `describeMissingCommand` 拿的是具体路径，能区分"没装 / 是目录 /
      // 缺执行权限"。合成一句话会把三种原因糊成一种。
      throw new Error(
        `找不到 ${this.#descriptor.command} 可执行文件。` +
          `本 runtime 的描述符尚未对照真实 CLI 验证（provisional），` +
          `若你确认已安装，很可能是描述表里的命令名与该 CLI 实际的名字不一致。`,
      )
    }

    // ★ "这个可执行文件真的能跑吗" 必须**在起进程之前**问清楚。
    //
    // 踩过一次：只在 spawn 之后看结果，于是"路径写错了"与"路径指到一个目录"
    // 都变成「exit=null + 输出不可解析」，错误文本里只有 Node 的 `spawn EACCES`。
    // 使用者拿到一句关于解析器的话，而真正的问题是路径。
    //
    // ⚠️ 这里**不能**复用 `findOnPath` 做判断：它查的是 `X_OK`，而
    //    **目录也有执行位**，所以 `findOnPath(tmpDir)` 会返回成功，
    //    然后在 spawn 处以 EACCES 失败——又回到了"错误文本指向错地方"。
    //    判断"能不能当程序跑"必须看**普通文件 + 执行权限**两件事。
    if (!(await isRunnableFile(executablePath))) {
      throw new Error(await describeMissingCommand(executablePath))
    }

    const { argv, dropped } = buildArgv({
      runtime: this.#descriptor,
      model: opts.model ?? null,
      maxTurns: opts.maxTurns ?? null,
      resumeSessionId: opts.resumeSessionId ?? null,
      userArgs: opts.customArgs ?? [],
    })

    if (dropped.length > 0) {
      this.#options.onWarn?.(
        `忽略了会破坏通信协议的自定义参数：${describeDropped(dropped)}`,
      )
    }

    const queue = new AsyncQueue<AgentMessage>()
    const parser = new GenericStreamParser({ onMessage: (m) => queue.push(m) })

    let stderrTail = ''
    let spawnError: unknown = null
    const startedAt = Date.now()

    const env: NodeJS.ProcessEnv = { ...process.env, ...(opts.env ?? {}) }

    // prompt 的投递方式由描述表决定。`argv` 模式下**追加在末尾**而不是插进
    // 中间：使用者参数之后、平台受管参数之后的位置已经被 argv.ts 的四段式
    // 占满，把 prompt 插进去会破坏"最后写的赢"。
    const usesStdin = this.#descriptor.promptDelivery === 'stdin-ndjson'
    if (!usesStdin) argv.push(opts.prompt)

    // ★ 可选沙箱：与 claude 适配器走**同一段**代码、同一条规则。
    //   planSandbox 不可用时抛异常，这里刻意不 catch（同 claude 那份的理由）。
    const plan = await planSandbox({
      mode: opts.sandbox?.mode ?? 'none',
      command: executablePath,
      args: argv,
      workDir: opts.workDir,
      // ★ CLI 自己的状态目录**必须**放行，否则沙箱会让它没法工作：
      //   Claude Code 建不了 ~/.claude/session-env/ 时，Bash 工具全程 EPERM。
      //   这个故障很难归因——daemon 在沙箱外，环境预检会说"一切正常"。
      extraWritableDirs: [
        ...(opts.sandbox?.extraWritableDirs ?? []),
        ...cliStateDir(this.#descriptor),
      ],
    })

    try {
      // 如实的**最终**命令行与**沙箱状态**（脱敏逻辑只能有一份，见 ExecOptions）
      opts.onCommandLine?.({
        argv: [plan.command, ...plan.args],
        sandboxDescription: plan.appliedDescription,
      })

      const handle = spawnProcessTree({
        command: plan.command,
        args: plan.args,
        cwd: opts.workDir,
        env,
        onStdoutLine: (line) => parser.push(line),
        onStderrLine: (line) => {
          stderrTail = `${stderrTail}\n${line}`.slice(-4000)
          opts.onStderrLine?.(line)
        },
        onActivity: opts.onActivity ?? (() => {}),
      })

      // ⚠️ 两个错误出口都要接住，漏一个就会出现"失败原因指向错地方"：
      //
      //  1. **同步抛**（ENOENT / EACCES 在部分平台上直接抛）→ 下面的 catch；
      //  2. **异步 `'error'` 事件**（Node 的常规路径）→ `spawnProcessTree`
      //     把它吞成了 `{code: null}`，于是失败会伪装成"输出不可解析"。
      //
      // 第 2 条是真正的坑：错误信息在 `'error'` 事件的参数里，而 `exited`
      // 只给一个 null 退出码。所以这里自己挂一个 listener 把它捞回来，
      // 交给 `#buildResult` 生成"为什么起不来"的错误文本。
      // `handle` 上再挂 listener 不会与 `spawnProcessTree` 内部的
      // `once('error')` 冲突——EventEmitter 允许任意多个监听者。
      handle.process.once('error', (err: Error) => {
        spawnError = err
      })

      if (usesStdin) {
        handle.writeStdin(buildGenericInput(opts.prompt))
      }
      handle.endStdin()

      const abortListener = (): void => {
        void handle.terminate()
      }
      opts.signal?.addEventListener('abort', abortListener, { once: true })

      const result: Promise<AgentResult> = handle.exited.then((exit) => {
        opts.signal?.removeEventListener('abort', abortListener)
        queue.close()

        return this.#buildResult({
          parser,
          exit,
          startedAt,
          stderrTail,
          opts,
          spawnError,
          executablePath,
        })
      })

      return {
        messages: queue,
        result,
        async cancel() {
          await handle.terminate()
        },
        lastActivityAt: () => handle.lastActivityAt(),
      }
    } catch (err) {
      // ★ 起进程这一步**必须**在这里翻译成可读错误并抛出。
      //
      //   为什么不在 `#buildResult` 里处理：`execute()` 抛错 = "这次 run 根本
      //   没开始"（daemon 按 infra 错误处理），返回 failed 结果 = "agent 跑起来
      //   但失败了"。把"程序都起不来"混进后者，会让失败原因从"CLI 装坏了"
      //   漂移成"agent 输出不可解析"——两者要采取的动作完全不同。
      //
      //   为什么捕获范围只有起进程这几行：`spawnProcessTree` 之后的
      //   `result` 是**已 resolve 的 Promise 链**，不会被这里吞掉异常。
      spawnError = err
      queue.close()
      throw new Error(describeSpawnError(err, this.#descriptor.command, executablePath))
    }
  }

  #buildResult(input: {
    parser: GenericStreamParser
    exit: { code: number | null; signal: NodeJS.Signals | null }
    startedAt: number
    stderrTail: string
    opts: ExecOptions
    /** 起进程失败时的原始错误（异步 `'error'` 事件捞回来的）。 */
    spawnError: unknown
    executablePath: string
  }): AgentResult {
    const { parser, exit, startedAt, stderrTail, opts, spawnError, executablePath } = input
    const durationMs = Date.now() - startedAt

    const failure = classifyGenericFailure({
      recognizedEvents: parser.recognizedEvents,
      resultSeen: parser.resultSeen,
      unparsableLines: parser.unparsableLines,
      parserIsError: parser.isError,
      exitCode: exit.code,
    })

    const base = {
      durationMs,
      sessionId: parser.sessionId,
      usage: parser.usage,
        model: parser.model,
      exitCode: exit.code,
      resumeRejected: this.#resumeRejected(parser, stderrTail, opts),
    }

    if (failure !== null) {
      return {
        ...base,
        status: 'failed',
        output: parser.finalText ?? '',
        // ★ 起进程失败优先报，它的原因比"输出不可解析"更具体也更接近事实。
        //   顺序反过来的话，一份被外部删掉的 CLI 会被报成"输出格式变了"，
        //   使用者会去核对描述表——而真正的问题是那个文件没了。
        error: spawnError
          ? describeSpawnError(spawnError, this.#descriptor.command, executablePath)
          : describeFailure(failure, {
              command: this.#descriptor.command,
              exitCode: exit.code,
              unparsableLines: parser.unparsableLines,
              stderrTail,
              maxLineExceeded: parser.maxLineExceeded,
              cliErrorText: parser.errorText ?? parser.finalText,
            }),
      }
    }

    return {
      ...base,
      status: 'completed',
      output: parser.finalText ?? '',
      error: null,
    }
  }

  /**
   * 会话恢复是否被拒（FR-CLI-06）。
   *
   * ★ 这里有一个**必须显式处理**的语义陷阱：本 runtime 的
   *   `rejectDetectable` 是 `false`（没有真实样本，测不出拒绝）。
   *
   *   那就必须返回 `undefined`（= 无法判断），**不能**返回探测结果。
   *   理由：`detectResumeRejection` 的模式是从别家 CLI 推导的，它的
   *   `false` 既可能是"没被拒"也可能是"措辞不一样所以没认出来"。
   *   把后者当成前者上报，会让恢复失败悄悄变成"新开一个会话"，
   *   而使用者以为上下文还在。宁可承认测不出来。
   *
   *   等真实样本到手、把描述符升成 `verified`，这条分支自动开始生效——
   *   也就是说探测逻辑本身不必改写，只需改一行数据。
   */
  #resumeRejected(
    parser: GenericStreamParser,
    stderrTail: string,
    opts: ExecOptions,
  ): boolean | undefined {
    if (opts.resumeSessionId === null || opts.resumeSessionId === undefined) return undefined
    if (!this.#descriptor.resume.rejectDetectable) return undefined

    const combined = `${parser.errorText ?? ''}\n${stderrTail}`
    return detectResumeRejection(combined)
  }
}

/**
 * 这个路径能不能当程序跑：必须是**普通文件**，且带执行权限。
 *
 * 两件事都要查，缺一不可——目录有执行位、脚本文件未必有执行位。
 * 把这两条合成一个函数，是为了让"起进程前的检查"与
 * `describeMissingCommand` 的诊断口径保持一致（同一组失败原因、同一套话术）。
 */
async function isRunnableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return false
    if (process.platform === 'win32') return true // Windows 不靠权限位
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 探测结果要说清楚"有没有装"和"装了但跑不了"的区别。
 *
 * 只用于**诊断消息**：这一步的一次性 IO 换来一句能直接指出问题的错误，
 * 而不是让使用者去猜"是没装、是名字不对、还是权限不对"——这三者在
 * 一份裸的 `spawn EACCES` 里长得一模一样。
 *
 * `stat` 而不是 `existsSync`：**目录也有执行位**，`existsSync(dir)` 为真，
 * 然后 spawn 会以 EACCES 失败。判断"是不是一个可执行的普通文件"必须看类型。
 */
export async function describeMissingCommand(path: string): Promise<string> {
  let isFile = false
  try {
    isFile = (await stat(path)).isFile()
  } catch {
    isFile = false
  }

  if (isFile) {
    return `${path} 不是可执行文件：缺执行权限（试试 chmod +x）`
  }
  if (existsSync(path)) {
    return `${path} 存在，但它不是一个普通文件（目录不能当可执行文件用）`
  }
  return (
    `${path} 未安装，或不在本进程的 PATH 里（从 GUI 启动的进程常常拿不到用户 shell 的 PATH）。` +
    `本 runtime 的描述符尚未对照真实 CLI 验证（provisional），` +
    `若你确认已安装，很可能是描述表里的命令名与该 CLI 实际的名字不一致。`
  )
}

