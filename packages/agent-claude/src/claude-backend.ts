import {
  AsyncQueue,
  buildArgv,
  describeDropped,
  detectVersion,
  loadCliRuntimeDescriptor,
  probeCommand,
  cliStateDir,
  planSandbox,
  spawnProcessTree,
  type AgentBackend,
  type AgentMessage,
  type AgentResult,
  type AgentSession,
  type CliRuntimeDescriptor,
  type ExecOptions,
  type RuntimeDescriptor,
} from '@agentdeck/agent-core'
import type { RuntimeProtocol } from '@agentdeck/protocol'
import {
  ClaudeStreamParser,
  buildClaudeInput,
  detectResumeRejection,
} from './stream-parser.ts'

/**
 * Claude Code 适配器。
 *
 * 首版**唯一**的 runtime。职责边界很清楚：拼参数、起进程、喂 prompt、
 * 解析输出、报终态。**不做**平台策略判断（那是 daemon 与领域层的事），
 * 也**不做**技能注入（那是 daemon 的 execenv 职责）。
 */

export interface ClaudeBackendOptions {
  descriptor: RuntimeDescriptor
  /** 覆盖可执行文件路径；不给则自动探测。 */
  executablePath?: string
  /** 丢弃受管参数时的警告出口（FR-CLI-12：不得静默丢弃）。 */
  onWarn?: (message: string) => void
  /** 缓存探测结果。测试里关掉。 */
  useProbeCache?: boolean
}

export class ClaudeBackend implements AgentBackend {
  readonly key: string
  readonly protocol: RuntimeProtocol
  readonly rejectDetectable: boolean

  readonly #descriptor: CliRuntimeDescriptor
  readonly #options: ClaudeBackendOptions

  constructor(options: ClaudeBackendOptions) {
    this.#options = options
    // claude 是 cli 形状：`loadCliRuntimeDescriptor` 校验 managedFlags/resume 在位
    // 并收窄类型（cli-only 字段已可选化——见 `RuntimeDescriptor.kind`）。
    this.#descriptor = loadCliRuntimeDescriptor(options.descriptor)
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
      throw new Error(
        `找不到 ${this.#descriptor.command} 可执行文件。请先安装它并在终端里完成登录；` +
          `若已安装，试着重启 daemon 以重新探测 PATH。`,
      )
    }

    /**
     * ★ 系统提示（①② 两块）走 `--append-system-prompt`。
     *
     * ⚠️ **追加**，不是替换：`--system-prompt` 会把 CLI 自带的系统提示整份换掉——
     *    那里面是它的工具用法与安全约束，换掉等于让 agent 变笨变野。这两个旗标
     *    在 2.0.14 的 bundle 里都存在（实测过）。
     *
     * ⚠️ 调用方**不支持**这个 runtime 却传来系统提示时，这里**抛错**而不是忽略：
     *    静默丢掉等于"规则与身份没送到"，而两边都不报错——那正是这个仓库反复在防的。
     */
    const managedAppend: string[] = []
    if (opts.systemPrompt !== undefined && opts.systemPrompt !== '') {
      const flag = this.#descriptor.systemPrompt?.flag
      if (!flag) {
        throw new Error(
          `runtime「${this.#descriptor.key}」没有系统提示这条通道（描述表里 systemPrompt 是 null），` +
            `所以不能把 ①② 两块单独送去。调用方该退回 B 档（三块合成一段）。`,
        )
      }
      managedAppend.push(flag, opts.systemPrompt)
    }

    const { argv, dropped } = buildArgv({
      runtime: this.#descriptor,
      model: opts.model ?? null,
      maxTurns: opts.maxTurns ?? null,
      resumeSessionId: opts.resumeSessionId ?? null,
      userArgs: opts.customArgs ?? [],
      // ★ D77：workspace 关掉 WebSearch 时，把 WebSearch/WebFetch 并进
      //   --disallowedTools（服务端工具在第三方端点会幻觉；默认开 = 不追加）。
      disallowOptionalTools: opts.disallowOptionalTools ?? false,
      // 受管追加参数**最后写**（`buildArgv` 里的第 4 步）⇒ 使用者的自定义参数
      // 覆盖不了它
      managedAppend,
    })

    if (dropped.length > 0) {
      this.#options.onWarn?.(
        `忽略了会破坏通信协议的自定义参数：${describeDropped(dropped)}`,
      )
    }

    // ★ 可选沙箱：在 argv 拼好之后、spawn 之前应用。
    //   planSandbox 在沙箱不可用时**抛异常**——这里刻意不 catch：
    //   静默降级会让人在以为自己被保护着的情况下裸奔。
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

    const queue = new AsyncQueue<AgentMessage>()
    const parser = new ClaudeStreamParser({ onMessage: (m) => queue.push(m) })

    let stderrTail = ''
    const startedAt = Date.now()

    // 如实的**最终**命令行与**沙箱状态**。调用方负责脱敏与记录。
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

    // 把 prompt 通过 stdin 以 stream-json 输入格式喂进去
    handle.writeStdin(buildClaudeInput(opts.prompt))
    handle.endStdin()

    const abortListener = (): void => {
      void handle.terminate()
    }
    opts.signal?.addEventListener('abort', abortListener, { once: true })

    const result: Promise<AgentResult> = handle.exited.then((exit) => {
      opts.signal?.removeEventListener('abort', abortListener)
      queue.close()

      const durationMs = Date.now() - startedAt
      const combined = `${parser.errorText ?? ''}\n${stderrTail}`

      // 输出不可解析是**明确失败**，不是"跑完了但没内容"（FR-RUNTIME-07）
      if (!parser.resultSeen) {
        return {
          status: 'failed',
          output: '',
          error:
            `CLI 没有输出可识别的终止事件（exit=${exit.code ?? 'null'}）。` +
            `这通常意味着 CLI 版本不受支持或输出格式有变。` +
            (stderrTail.trim() ? `\nstderr: ${stderrTail.trim().slice(-500)}` : ''),
          durationMs,
          sessionId: parser.sessionId,
          usage: parser.usage,
          model: parser.model,
          exitCode: exit.code,
        }
      }

      const failed = parser.isError || (exit.code !== null && exit.code !== 0)
      return {
        status: failed ? 'failed' : 'completed',
        output: parser.finalText ?? '',
        error: failed
          ? (parser.errorText ?? (stderrTail.trim().slice(-500) || '运行失败'))
          : null,
        durationMs,
        sessionId: parser.sessionId,
        usage: parser.usage,
        model: parser.model,
        resumeRejected:
          opts.resumeSessionId !== null && opts.resumeSessionId !== undefined
            ? detectResumeRejection(combined)
            : undefined,
        exitCode: exit.code,
      }
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
}
