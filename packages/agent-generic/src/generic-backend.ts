import { constants, existsSync } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import {
  AsyncQueue,
  LineStreamBackendBase,
  describeMissingCommand,
  describeSpawnError,
  type AgentMessage,
  type AgentResult,
  type DroppedArg,
  type ExecOptions,
  type RuntimeDescriptor,
  type LineStreamLaunch,
  type LineStreamResultContext,
} from '@agentdeck/agent-core'
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

export class GenericBackend extends LineStreamBackendBase<GenericStreamParser> {
  constructor(options: GenericBackendOptions) {
    super(options)
  }

  /**
   * 找不到可执行文件时怎么说。
   *
   * ⚠️ 与 claude 的措辞**故意不同**：本 runtime 的描述符是 `provisional`
   *    （字段名未对照真实 CLI 验证），所以要提这一点；chmod/目录那种更具体的
   *    诊断由下面的 `assertRunnable()` 负责（它拿到的是具体路径）。
   */
  protected override missingExecutableMessage(): string {
    return (
      `找不到 ${this.descriptor.command} 可执行文件。` +
      `本 runtime 的描述符尚未对照真实 CLI 验证（provisional），` +
      `若你确认已安装，很可能是描述表里的命令名与该 CLI 实际的名字不一致。`
    )
  }

  /**
   * ★ generic 的差异点（分批第 65 批从 claude 那份里学来的，现在两处都做）：
   *   起进程**之前**先问"这个路径真的能跑吗"。
   *
   * 踩过一次：只在 spawn 之后看结果，于是"路径写错了"与"路径指到一个目录"
   * 都变成「exit=null + 输出不可解析」，错误文本里只有 Node 的 `spawn EACCES`。
   *
   * ⚠️ 这里**不能**复用 `findOnPath` 做判断：它查的是 `X_OK`，而**目录也有执行位**，
   *    所以 `findOnPath(tmpDir)` 会返回成功，然后在 spawn 处以 EACCES 失败。
   *    判断"能不能当程序跑"必须看**普通文件 + 执行权限**两件事。
   */
  protected override evidenceNote(): string {
    return (
      '本 runtime 的描述符尚未对照真实 CLI 验证（provisional），' +
      '若你确认已安装，很可能是描述表里的命令名与该 CLI 实际的名字不一致。'
    )
  }

  protected override buildLaunch(opts: ExecOptions): LineStreamLaunch & {
    dropped: readonly DroppedArg[]
  } {
    const { argv, dropped } = this.buildArgvFor(opts)
    /**
     * prompt 的投递方式由描述表决定。`argv` 模式下**追加在末尾**而不是插进中间：
     * 使用者参数之后、平台受管参数之后的位置已经被 argv 的四段式占满，
     * 把 prompt 插进去会破坏"最后写的赢"。
     */
    const usesStdin = this.descriptor.promptDelivery === 'stdin-ndjson'
    if (!usesStdin) argv.push(opts.prompt)
    return { argv, stdin: usesStdin ? buildGenericInput(opts.prompt) : null, dropped }
  }

  protected override createParser(queue: AsyncQueue<AgentMessage>): GenericStreamParser {
    return new GenericStreamParser({ onMessage: (m) => queue.push(m) })
  }

  protected override buildResult(ctx: LineStreamResultContext<GenericStreamParser>): AgentResult {
    const { parser, exit, startedAt, stderrTail, opts, spawnError, executablePath } = ctx
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
      resumeRejected: this.resumeRejected(parser, stderrTail, opts),
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
          ? describeSpawnError(spawnError, this.descriptor.command, executablePath)
          : describeFailure(failure, {
              command: this.descriptor.command,
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
   * ★ 语义陷阱：本 runtime 的 `rejectDetectable` 是 `false`（没有真实样本，测不出拒绝）。
   *   那就必须返回 `undefined`（= 无法判断），**不能**返回探测结果——否则恢复失败会
   *   悄悄变成"新开一个会话"，而使用者以为上下文还在。
   *   等真实样本到手、把描述符升成 `verified`，这条分支自动开始生效。
   */
  protected override resumeRejected(
    parser: GenericStreamParser,
    stderrTail: string,
    opts: ExecOptions,
  ): boolean | undefined {
    if (opts.resumeSessionId === null || opts.resumeSessionId === undefined) return undefined
    if (!this.descriptor.resume.rejectDetectable) return undefined
    const combined = `${parser.errorText ?? ''}\n${stderrTail}`
    return detectResumeRejection(combined)
  }
}

/**
 * `describeMissingCommand` 现在住在 `@agentdeck/agent-core`（分批第 66 批）——
 * 原来 generic 与 codex **各有一份**，注释还写着"改的时候要一起改"（最会漂的那种安排）。
 * 这里保留 re-export，别让 import 路径的既有用法断掉。
 */
export { describeMissingCommand }
