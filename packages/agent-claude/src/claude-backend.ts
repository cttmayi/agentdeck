import {
  AsyncQueue,
  LineStreamBackendBase,
  type AgentMessage,
  type AgentResult,
  type ExecOptions,
  type DroppedArg,
  type LineStreamLaunch,
  type LineStreamParserLike,
  type LineStreamResultContext,
} from '@agentdeck/agent-core'
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
 *
 * ★ 分批第 65 批：骨架（起进程、喂 stdin、收终态、abort、stderr 尾巴）搬进了
 *   `LineStreamBackendBase`——**它与 generic 适配器逐行几乎一样**（量过：那段约 90–110 行）。
 *   这里只剩 claude 真正不同的部分：argv 里的 `--append-system-prompt`、以及它自己的解析与终态判定。
 */

export interface ClaudeBackendOptions {
  descriptor: import('@agentdeck/agent-core').RuntimeDescriptor
  /** 覆盖可执行文件路径；不给则自动探测。 */
  executablePath?: string
  /** 丢弃受管参数时的警告出口（FR-CLI-12：不得静默丢弃）。 */
  onWarn?: (message: string) => void
  /** 缓存探测结果。测试里关掉。 */
  useProbeCache?: boolean
}

export class ClaudeBackend extends LineStreamBackendBase<ClaudeStreamParser> {
  constructor(options: ClaudeBackendOptions) {
    super(options)
  }

  /**
   * 找不到可执行文件时怎么说（claude 的措辞：提示去安装 + 登录 + 重启探测）。
   */
  protected override missingExecutableMessage(): string {
    return (
      `找不到 ${this.descriptor.command} 可执行文件。请先安装它并在终端里完成登录；` +
      `若已安装，试着重启 daemon 以重新探测 PATH。`
    )
  }

  /**
   * ★ claude 的差异点：**系统提示走 `--append-system-prompt`**。
   *
   * ⚠️ **追加**，不是替换：`--system-prompt` 会把 CLI 自带的系统提示整份换掉——
   *    那里面是它的工具用法与安全约束，换掉等于让 agent 变笨变野。这两个旗标
   *    在 2.0.14 的 bundle 里都存在（实测过）。
   * ⚠️ 调用方**不支持**这个 runtime 却传来系统提示时，这里**抛错**而不是忽略：
   *    静默丢掉等于"规则与身份没送到"，而两边都不报错——那正是这个仓库反复在防的。
   */
  protected override buildLaunch(opts: ExecOptions): LineStreamLaunch & {
    dropped: readonly DroppedArg[]
  } {
    const append: string[] = []
    if (opts.systemPrompt !== undefined && opts.systemPrompt !== '') {
      const flag = this.descriptor.systemPrompt?.flag
      if (!flag) {
        throw new Error(
          `runtime「${this.descriptor.key}」没有系统提示这条通道（描述表里 systemPrompt 是 null），` +
            `所以不能把 ①② 两块单独送去。调用方该退回 B 档（三块合成一段）。`,
        )
      }
      append.push(flag, opts.systemPrompt)
    }

    const { argv, dropped } = this.buildArgvFor(opts, append)
    // 把 prompt 通过 stdin 以 stream-json 输入格式喂进去
    return { argv, stdin: buildClaudeInput(opts.prompt), dropped }
  }

  protected override createParser(queue: AsyncQueue<AgentMessage>): ClaudeStreamParser {
    return new ClaudeStreamParser({ onMessage: (m) => queue.push(m) })
  }

  protected override buildResult(ctx: LineStreamResultContext<ClaudeStreamParser>): AgentResult {
    const { parser, exit, startedAt, stderrTail, opts } = ctx
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
      error: failed ? (parser.errorText ?? (stderrTail.trim().slice(-500) || '运行失败')) : null,
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
  }
}

/** 让 `ClaudeStreamParser` 的形状被基类的约束"看见"（编译期即可发现漂移）。 */
export type _ClaudeParserCheck = LineStreamParserLike
