/**
 * ★ 分批第 65 批：**cli 形状适配器的公共基类**（使用者要求：差异用继承表达，别用条件判断）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么要有它
 * ══════════════════════════════════════════════════════════════════
 *
 * claude 与 generic 两个适配器的 `execute()` 骨架逐行几乎一样（量过：156 行 / 294 行，
 * 其中约 90–110 行是重复的）：
 *
 *   解析可执行文件 → buildArgv → 警告被丢弃的参数 → planSandbox → 建队列 + 解析器
 *   → spawnProcessTree → 投递 prompt 到 stdin → 装 abort 监听 → 在 `handle.exited` 里拼结果
 *
 * 两处各写一份的问题不是"代码长"，而是**它们会漂**：generic 后来补了
 * `isRunnableFile`（"能起吗"必须先问）、补了 `spawnError` 的双出口处理，
 * claude 那份没有 —— 而 claude 是主力 runtime。这种"补充只做了一半"在本仓库是常客
 * （起草者/审核者各一份、`resolveSpawnTarget` 的 spawn 选项两份）。
 *
 * 现在骨架只写一次（模板方法），**差异点都是子类的 override**：
 *
 * | 差异 | 谁 override | 方法 |
 * | --- | --- | --- |
 * | 拼 argv / 怎么投递 prompt | 两个都 | `buildLaunch()` |
 * | 系统提示那条通道（`--append-system-prompt`） | claude | `buildLaunch()` 里用 `managedAppend()` |
 * | "这个文件能不能当程序跑" | generic | `assertRunnable()` |
 * | 协议解析与终态判定 | 各自 | `createParser()` + `buildResult()` |
 * | 找不到可执行文件时怎么说 | 各自 | `missingExecutableMessage()` |
 * | 会话恢复被拒怎么判 | 各自 | `resumeRejected()` |
 */
import {
  AsyncQueue,
  type AgentBackend,
  type AgentMessage,
  type AgentResult,
  type AgentSession,
  type CliRuntimeDescriptor,
  type ExecOptions,
  type RuntimeDescriptor,
} from './index.ts'
import { buildArgv } from './argv.ts'
import { describeDropped, type DroppedArg } from './blocked-args.ts'
import { describeSpawnError } from './spawn-target.ts'
import { detectVersion, probeCommand } from './probe.ts'
import { cliStateDir, planSandbox } from './sandbox.ts'
import { spawnProcessTree } from './process-tree.ts'
import type { RuntimeProtocol } from '@agentdeck/protocol'

/** 子类要跑的那次启动：拼好的 argv + 要写进 stdin 的内容（null = 不写）。 */
export interface LineStreamLaunch {
  argv: string[]
  /** 一次性写进 stdin 的内容；null = 这个 runtime 不走 stdin。 */
  stdin: string | null
}

/**
 * 解析器只需要这几样（两个适配器的解析器都满足）。
 *
 * ⚠️ 刻意**不**要求"识别到多少事件"之类的 generic 专属字段：那些由子类的
 *    `buildResult()` 从自己的解析器里取（它有具体类型），基类不该知道。
 */
export interface LineStreamParserLike {
  push(line: string): void
  readonly resultSeen: boolean
  readonly sessionId: string | null
  readonly model: string | null
  readonly usage: AgentResult['usage'] | null
  readonly finalText: string | null
  readonly errorText: string | null
}

/** `buildResult()` 拿到的现场（两个适配器都要的都在这里）。 */
export interface LineStreamResultContext<P extends LineStreamParserLike> {
  parser: P
  exit: { code: number | null; signal: NodeJS.Signals | null }
  startedAt: number
  stderrTail: string
  opts: ExecOptions
  /** 起进程失败时捞回来的原始错误（异步 `'error'` 事件）。 */
  spawnError: unknown
  executablePath: string
}

export interface LineStreamBackendOptions {
  descriptor: RuntimeDescriptor
  /** 覆盖可执行文件路径；不给则自动探测。 */
  executablePath?: string
  /** 丢弃受管参数时的警告出口（FR-CLI-12：不得静默丢弃）。 */
  onWarn?: (message: string) => void
  /** 缓存探测结果。测试里关掉。 */
  useProbeCache?: boolean
}

export abstract class LineStreamBackendBase<P extends LineStreamParserLike>
  implements AgentBackend
{
  readonly key: string
  readonly protocol: RuntimeProtocol
  readonly rejectDetectable: boolean

  protected readonly descriptor: CliRuntimeDescriptor
  protected readonly options: LineStreamBackendOptions

  constructor(options: LineStreamBackendOptions) {
    this.options = options
    // 两个适配器都是 cli 形状：校验 managedFlags/resume 在位并收窄类型
    // （cli-only 字段已可选化——见 `RuntimeDescriptor.kind`）。
    this.descriptor = (options.descriptor as CliRuntimeDescriptor)
    this.key = this.descriptor.key
    this.protocol = this.descriptor.protocol
    this.rejectDetectable = this.descriptor.resume.rejectDetectable
  }

  // ── 模板方法：骨架只写这一份 ──

  async probe(): Promise<{ available: boolean; command: string; cliVersion: string | null }> {
    const path = await this.resolveExecutable()
    if (!path) {
      return { available: false, command: this.descriptor.command, cliVersion: null }
    }
    return {
      available: true,
      command: this.descriptor.command,
      cliVersion: await detectVersion(path),
    }
  }

  async execute(opts: ExecOptions): Promise<AgentSession> {
    const executablePath = await this.resolveExecutable()
    if (!executablePath) throw new Error(await this.missingExecutableMessage())
    // ★ 起进程之前先问"这个路径真的能跑吗"：只剩 spawn 之后看结果的话，
    //   "路径写错 / 指到目录 / 缺执行权限"全会伪装成"输出不可解析"。
    await this.assertRunnable(executablePath)

    const launch = this.buildLaunch(opts)

    if (launch.dropped.length > 0) {
      this.options.onWarn?.(`忽略了会破坏通信协议的自定义参数：${describeDropped(launch.dropped)}`)
    }

    // ★ 可选沙箱：argv 拼好之后、spawn 之前应用。`planSandbox` 不可用时**抛**——
    //   这里刻意不 catch：静默降级会让人在以为自己被保护着的情况下裸奔。
    const plan = await planSandbox({
      mode: opts.sandbox?.mode ?? 'none',
      command: executablePath,
      args: launch.argv,
      workDir: opts.workDir,
      extraWritableDirs: [
        ...(opts.sandbox?.extraWritableDirs ?? []),
        ...cliStateDir(this.descriptor),
        ...this.extraWritableDirs(opts),
      ],
    })

    const queue = new AsyncQueue<AgentMessage>()
    const parser = this.createParser(queue)

    let stderrTail = ''
    let spawnError: unknown = null
    const startedAt = Date.now()

    // 如实的**最终**命令行与**沙箱状态**（脱敏逻辑只能有一份，见 ExecOptions）
    opts.onCommandLine?.({
      argv: [plan.command, ...plan.args],
      sandboxDescription: plan.appliedDescription,
    })

    const handle = spawnProcessTree({
      command: plan.command,
      args: plan.args,
      cwd: opts.workDir,
      env: { ...process.env, ...(opts.env ?? {}) },
      onStdoutLine: (line) => parser.push(line),
      onStderrLine: (line) => {
        // 两条路都要：尾巴用于失败信息，逐行上报用于日志
        stderrTail = `${stderrTail}\n${line}`.slice(-4000)
        opts.onStderrLine?.(line)
      },
      onActivity: opts.onActivity ?? (() => {}),
    })

    // ⚠️ 两个错误出口都要接住，漏一个就会出现"失败原因指向错地方"：
    //   ① 同步抛（下面 catch）；② 异步 `'error'` 事件（Node 的常规路径，
    //   被 `spawnProcessTree` 压成 `{code:null}`，于是失败伪装成"输出不可解析"）。
    handle.process.once('error', (err: Error) => {
      spawnError = err
    })

    try {
      if (launch.stdin !== null) handle.writeStdin(launch.stdin)
      handle.endStdin()
    } catch (err) {
      // 起进程这一步失败 = "这次 run 根本没开始"（daemon 按 infra 错误处理），
      // 与"跑起来但失败"必须分开——两者的处置完全不同。
      spawnError = err
      queue.close()
      throw new Error(describeSpawnError(err, this.descriptor.command, executablePath))
    }

    const abortListener = (): void => {
      void handle.terminate()
    }
    opts.signal?.addEventListener('abort', abortListener, { once: true })

    const result: Promise<AgentResult> = handle.exited.then((exit) => {
      opts.signal?.removeEventListener('abort', abortListener)
      queue.close()
      return this.buildResult({
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
  }

  // ── 子类要实现的差异点（默认实现 = "claude 这种最朴素的情形"）──

  /** 解析可执行文件（探测或注入路径）。两个适配器完全一样，所以这里给默认实现。 */
  protected async resolveExecutable(): Promise<string | null> {
    if (this.options.executablePath) return this.options.executablePath
    const probe = await probeCommand(this.descriptor.command, {
      useCache: this.options.useProbeCache ?? true,
    })
    return probe.available ? probe.path : null
  }

  /** 找不到可执行文件时说什么（各自的措辞不同：generic 要提 provisional）。 */
  protected abstract missingExecutableMessage(): Promise<string> | string

  /** "这个路径能不能当程序跑"——默认不查（claude 的老行为），generic 覆盖它。 */
  protected async assertRunnable(_path: string): Promise<void> {}

  /** 额外要放行的可写目录（默认没有）。 */
  protected extraWritableDirs(_opts: ExecOptions): string[] {
    return []
  }

  /** 拼 argv、决定 prompt 怎么投递。**两个适配器各写各的**。 */
  protected abstract buildLaunch(opts: ExecOptions): LineStreamLaunch & {
    /** 被丢弃的自定义参数（交给 `onWarn`，不许静默）。 */
    dropped: readonly DroppedArg[]
  }

  /** 建这个 runtime 的解析器（协议形状不同，必须各自实现）。 */
  protected abstract createParser(queue: AsyncQueue<AgentMessage>): P

  /** 拼终态（失败分级也不同，必须各自实现）。 */
  protected abstract buildResult(ctx: LineStreamResultContext<P>): AgentResult

  /** 会话恢复是否被拒（FR-CLI-06）：默认"判不出来"= undefined。 */
  protected resumeRejected(
    _parser: P,
    _stderrTail: string,
    _opts: ExecOptions,
  ): boolean | undefined {
    return undefined
  }

  /** 子类里拼 argv 时用：`buildArgv` + 受管追加参数的统一入口。 */
  protected buildArgvFor(
    opts: ExecOptions,
    append: string[] = [],
  ): ReturnType<typeof buildArgv> {
    return buildArgv({
      runtime: this.descriptor,
      model: opts.model ?? null,
      maxTurns: opts.maxTurns ?? null,
      resumeSessionId: opts.resumeSessionId ?? null,
      userArgs: opts.customArgs ?? [],
      ...(this.disallowOptionalTools(opts) ? { disallowOptionalTools: true } : {}),
      managedAppend: append,
    })
  }

  /** generic 用：把 `--disallowedTools` 那套并进 argv（claude 才支持，默认 false）。 */
  protected disallowOptionalTools(_opts: ExecOptions): boolean {
    return false
  }
}
