import { constants, existsSync } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import {
  AsyncQueue,
  detectVersion,
  loadRuntimeDescriptor,
  probeCommand,
  cliStateDir,
  describeSpawnError,
  planSandbox,
  spawnProcessTree,
  type AgentBackend,
  type AgentMessage,
  type AgentResult,
  type AgentSession,
  type ExecOptions,
  type ProcessHandle,
  type RpcDeliveryNote,
  type RuntimeDescriptor,
} from '@agentdeck/agent-core'
import type { RuntimeProtocol } from '@agentdeck/protocol'
import { CODEX_SERVER_FACTS } from './codex-descriptor.ts'
import { JsonRpcServerError, JsonRpcTransport } from './jsonrpc-transport.ts'
import { classifyCodexFailure, CodexStreamParser, type CodexFailure } from './stream-parser.ts'

/**
 * Codex（app-server 形式）的适配器——**第一个 service 形状的 runtime**。
 *
 * 与前两个适配器的职责边界一致（拼启动、起进程、送 prompt、解析输出、报终态），
 * 但"run"的形状不同：不起一次性 CLI，而是起 `codex app-server`，走 JSON-RPC：
 *
 *   initialize 握手 → thread/start（或 thread/resume）→ turn/start（B 档 prompt
 *   作为 text input）→ 流式 item/* 通知 → turn/completed 终止 → 关进程。
 *
 * ⚠️ 协议形状已按真实 app-server（0.144.0-alpha.4，本机 local 模型端点）实测核对
 *    （见 `codex-descriptor.ts` 与 docs/runtime/codex-runtime-design.md §7）：握手、线程、
 *    turn、item 载荷、tokenUsage、中断、恢复拒绝（-32600）全部对上，证据等级
 *    升为 `verified`。工具类 item（commandExecution 等）本机模型未触发 shell，
 *    形状仍按源码/文档，属于残余未验证项。
 */

export interface CodexBackendOptions {
  descriptor: RuntimeDescriptor
  /** 覆盖可执行文件路径；不给则自动探测。测试用假 app-server 时走这条。 */
  executablePath?: string
  /** 不静默出口：丢弃 / 无法执行的东西（customArgs、maxTurns）从这里说。 */
  onWarn?: (message: string) => void
  /** 缓存探测结果。测试里关掉。 */
  useProbeCache?: boolean
  /** JSON-RPC 请求超时（缺省 60s；测试用小值，避免用例挂住）。 */
  rpcTimeoutMs?: number
  /** -32001 背压重试上限（缺省 3；测试可设 0）。 */
  rpcMaxRetries?: number
  /** 背压重试的起始延迟 ms（缺省 250；测试可设 0）。 */
  rpcRetryDelayMs?: number
}

/** interrupt 后等 `turn/completed(interrupted)` 到达的宽限时间。 */
const INTERRUPT_GRACE_MS = 2000

/** JSON-RPC 帧的防御性字段读取（载荷形状 [未验证]，拿不到就降级不抛）。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * ★ 分批第 46 批：从**真的写进 stdin 的那一行**里，把发出去的正文抠出来上报。
 *
 * 使用者原话：「还是需要把给 CLI 的内容打印出来，尽量在发送的位置直接打，保证真实性」。
 *
 * 为什么不能直接用 `opts.prompt`：那是"我们打算发的那份"。这一整条日志存在的意义，
 * 恰恰是要证明"它收到的 == 日志里写的"。所以这里坚持两步：
 *
 *   ① `JSON.stringify` 出**要写进 stdin 的那一行**（调用方先写，再把这一行交进来）；
 *   ② 只从**这一行**里 `JSON.parse` 出 `params.input[...].text` 上报。
 *
 * 抠不出来（帧形状变了、不是 `turn/start`、input 里有多段）就**不说**——
 * 宁可少一行，也不写一句没有字节支撑的话。
 *
 * ⚠️ 多段 input 时只报"段数"，不拼起来：拼起来就是我们在**造**一份没被发出去的内容。
 */
function reportSentTurnInput(
  frame: unknown,
  line: string,
  opts: { onRpcFrame?: (note: RpcDeliveryNote) => void },
): void {
  if (opts.onRpcFrame === undefined) return
  const method = (frame as { method?: unknown } | null)?.method
  if (method !== 'turn/start') return
  let parsed: { params?: { input?: unknown } }
  try {
    // ⚠️ 解析的是**写出去的那一行**，不是 `frame` 对象本身（后者只证明"想发什么"）
    parsed = JSON.parse(line) as { params?: { input?: unknown } }
  } catch {
    return
  }
  const input = parsed.params?.input
  if (!Array.isArray(input)) return
  const texts = input
    .map((item) => (item as { type?: unknown; text?: unknown } | null))
    .filter((item): item is { type: string; text: string } =>
      item !== null && item.type === 'text' && typeof item.text === 'string',
    )
    .map((item) => item.text)
  if (texts.length !== 1) {
    opts.onRpcFrame({
      direction: 'out',
      method: 'turn/start',
      headline:
        `↓ 已写入 codex stdin（turn/start，${String(Buffer.byteLength(line, 'utf8'))} 字节）：` +
        `input 有 ${String(input.length)} 段，只有 1 段时才会把正文打出来`,
    })
    return
  }
  const text = texts[0] ?? ''
  opts.onRpcFrame({
    direction: 'out',
    method: 'turn/start',
    headline:
      `↓ 已写入 codex stdin：整帧 ${String(Buffer.byteLength(line, 'utf8'))} 字节，` +
      `其中 input[0].text 共 ${String(text.length)} 字符（下面这段是**从写出去的那一行里抠出来的**）`,
    sentText: text,
  })
}

export class CodexBackend implements AgentBackend {
  readonly key: string
  readonly protocol: RuntimeProtocol = 'jsonrpc'
  /**
   * ★ 已实测（0.144.0-alpha.4）：`thread/resume` 对不存在的线程（格式非法 /
   *    rollout 不存在 / 已归档）一律回 JSON-RPC error（code=-32600）。
   *   "恢复被拒"**可检测** ⇒ true（设计稿 §5.4 / §7 清单第 5 条，已核对）。
   *   被拒时后端回退新线程继续 + resumeRejected=true（FR-CLI-06 语义）。
   */
  readonly rejectDetectable = true

  readonly #descriptor: RuntimeDescriptor
  readonly #options: CodexBackendOptions

  constructor(options: CodexBackendOptions) {
    this.#options = options
    // service 形状：`loadRuntimeDescriptor` 只要求 baseArgs（启动参数）非空，
    // cli-only 字段缺省即合法（见 `RuntimeDescriptor.kind`）。
    this.#descriptor = loadRuntimeDescriptor(options.descriptor)
    this.key = this.#descriptor.key
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
        `找不到 ${this.#descriptor.command} 可执行文件。` +
          `本 runtime 已在 0.144.0-alpha.4 上实测（verified），` +
          `若你确认已安装，很可能是描述表里的命令名与该 CLI 实际的名字不一致，` +
          `或它不在 PATH 里（可用 --executable 指定路径）。`,
      )
    }
    if (!(await isRunnableFile(executablePath))) {
      throw new Error(await describeMissingCommand(executablePath))
    }

    // ★ service 形状：没有 run 级 argv，不拼 buildArgv——baseArgs 就是启动参数。
    const launchArgs = [...this.#descriptor.baseArgs]

    // ★ customArgs 对 service 没有语义（设计稿 §3.4）：收到就警告，不得静默。
    if (opts.customArgs && opts.customArgs.length > 0) {
      this.#options.onWarn?.(
        `runtime ${this.#descriptor.key} 是 service 形状，自定义 CLI 参数进不了任何地方：` +
          `${opts.customArgs.join(' ')}（已忽略——本 runtime 没有 run 级 argv）`,
      )
    }
    // ★ app-server 没有 turn 上限（设计稿 §2.8）：收到 maxTurns 就警告，不静默。
    if (opts.maxTurns !== null && opts.maxTurns !== undefined && opts.maxTurns > 0) {
      this.#options.onWarn?.(
        `runtime ${this.#descriptor.key}（app-server）没有 turn 上限概念，` +
          `maxTurns=${opts.maxTurns} 无法执行——超时由平台的 idle 看门狗兜底。`,
      )
    }

    const queue = new AsyncQueue<AgentMessage>()
    const parser = new CodexStreamParser({ onMessage: (m) => queue.push(m) })

    let stderrTail = ''
    let spawnError: unknown = null
    const startedAt = Date.now()

    // ★ 可选沙箱：与 claude / generic 走**同一段**代码、同一条规则。
    //   planSandbox 不可用时抛异常，这里刻意不 catch（同前两份的理由）。
    const plan = await planSandbox({
      mode: opts.sandbox?.mode ?? 'none',
      command: executablePath,
      args: launchArgs,
      workDir: opts.workDir,
      // CLI 自己的状态目录必须放行：codex 要往 ~/.codex 写线程 rollout / 日志。
      // ★ 2026-10（D78 的 codex 版）：平台注入 `CODEX_HOME` 指向受管目录时，
      //   codex 改往那里写（用户级配置隔离，见 apps/daemon run-hooks/codex-config.ts）
      //   ——受管目录同样必须放行，否则平台沙箱会把 codex 的会话状态写挡掉。
      extraWritableDirs: [
        ...(opts.sandbox?.extraWritableDirs ?? []),
        ...cliStateDir(this.#descriptor),
        ...(typeof opts.env?.CODEX_HOME === 'string' ? [opts.env.CODEX_HOME] : []),
      ],
    })

    let handle: ProcessHandle | null = null
    const transport = new JsonRpcTransport(
      {
        onNotification: (method, params) => parser.handleNotification(method, params),
        onUnparsableLine: (line) => parser.handleUnparsable(line),
        // ★ 防御性审批响应（设计稿 §2.5）：approvalPolicy:'never' 下本不应出现；
        //   出现就 decline + 大声说明。不回应的后果是 turn 挂死——最糟的静默。
        onServerRequest: (id, method) => {
          this.#options.onWarn?.(
            `收到服务端请求「${method}」，但本 run 是无人值守策略` +
              `（approvalPolicy: ${CODEX_SERVER_FACTS.approvalPolicy}）——已拒绝。` +
              `请检查为什么 never 没生效（见设计稿 §7 清单第 2 条）。`,
          )
          transport.respond(id, { decision: 'decline' })
        },
        // exactOptionalPropertyTypes：显式 undefined 会把"没传"变成"传了 undefined"
        ...(this.#options.rpcMaxRetries !== undefined ? { maxRetries: this.#options.rpcMaxRetries } : {}),
        ...(this.#options.rpcRetryDelayMs !== undefined
          ? { retryDelayMs: this.#options.rpcRetryDelayMs }
          : {}),
      },
      /**
       * ★ 分批第 46 批：**在发送点**把正文报出去（使用者的要求：「尽量在发送的位置直接打，
       * 保证真实性」）。
       *
       * 45 批那一版是在 `rpc('turn/start', …)` 返回**之后**拿 `opts.prompt` 报的——
       * 内容是"我们打算发的那份"，不是"字节里实际写着的那份"。两者一般情况下相同，
       * 但"一般情况下相同"正是日志最不该依赖的东西：要证明的恰恰是"它收到的就是我看到的"。
       *
       * 所以改成：**先序列化、写进 stdin，再从写出去的那一行里把正文抠出来上报**。
       * 于是日志里的那段文字，与 CLI 在 stdin 上读到的字节是同一份（同一行 JSON 里的
       * `params.input[0].text`）——真实性由"读回来的那一行"保证，而不是由"我记得发的是它"。
       */
      (frame) => {
        const line = `${JSON.stringify(frame)}\n`
        handle?.writeStdin(line)
        reportSentTurnInput(frame, line, opts)
      },
    )

    try {
      // 如实的**最终**命令行与**沙箱状态**（脱敏逻辑只能有一份，见 ExecOptions）
      opts.onCommandLine?.({
        argv: [plan.command, ...plan.args],
        sandboxDescription: plan.appliedDescription,
      })

      handle = spawnProcessTree({
        command: plan.command,
        args: plan.args,
        cwd: opts.workDir,
        env: { ...process.env, ...(opts.env ?? {}) },
        onStdoutLine: (line) => transport.push(line),
        onStderrLine: (line) => {
          stderrTail = `${stderrTail}\n${line}`.slice(-4000)
          opts.onStderrLine?.(line)
        },
        onActivity: opts.onActivity ?? (() => {}),
      })
      // 异步 `'error'` 事件（spawn 失败走 Node 常规路径）——捞回来给 #buildResult
      handle.process.once('error', (err: Error) => {
        spawnError = err
      })
    } catch (err) {
      // 起进程这一步必须翻译成可读错误并抛出（= "run 根本没开始"，daemon 按
      // infra 错误处理）。与 generic 同一套理由（见 generic-backend 的注释）。
      queue.close()
      throw new Error(describeSpawnError(err, this.#descriptor.command, executablePath))
    }

    // ── 对话阶段：握手 → 线程 → turn ─────────────────────────────
    // ★ 这里的失败**不是** "run 没开始"：server 已经起来了，只是对话失败。
    //   统一收成 failed run（agent_error），让结果流正常走完、审计有真相。
    const timeoutMs = this.#options.rpcTimeoutMs ?? 60_000
    let threadId: string | null = null
    let turnId: string | null = null
    // ★ CLI 报告的模型（thread/start 响应的 model）——不是请求值；拿不到就 null。
    let activeModel: string | null = null
    // ★ 恢复被拒的判定（FR-CLI-06）：null/未请求 ⇒ undefined；成功 ⇒ false；
    //   被拒回退新线程 ⇒ true。
    let resumeRejected: boolean | undefined

    /**
     * ★ 分批第 44 批：**service 形状的 runtime 必须把"发了什么"报进日志**。
     *
     * 使用者报过：「日志里有『命令行：/opt/homebrew/bin/codex app-server --stdio』，
     * 后面应该有发给它的命令，没有打印出来」。他说得对：cli 形状（claude / generic）
     * 的第一句话拼在 argv 里，所以"命令行"那一行顺带把内容也显示了；而 codex 的
     * 内容全在 JSON-RPC 帧里，走 stdin ⇒ 日志里一个字节都没有。
     *
     * 这里只报**摘要**（方法名 + 关键字段 + 耗时），`turn/start` 额外把 `input` 原文
     * 用 `sentText` 交出去——由调用方（executor）与"第一句话"逐字比对，于是
     * "日志里看到的"与"CLI 收到的"是同一件事。
     */
    const rpc = async <T>(method: string, params: unknown, headline: string): Promise<T> => {
      opts.onRpcFrame?.({ direction: 'out', method, headline })
      const startedAt = Date.now()
      try {
        const res = await transport.request<T>(method, params, { timeoutMs })
        opts.onRpcFrame?.({
          direction: 'in',
          method,
          headline: `← ${method} 成功（${String(Date.now() - startedAt)}ms）`,
        })
        return res
      } catch (err) {
        const msg = err instanceof JsonRpcServerError ? `code ${String(err.code)}：${err.message}` : String(err)
        opts.onRpcFrame?.({
          direction: 'in',
          method,
          headline: `← ${method} 失败（${String(Date.now() - startedAt)}ms）：${msg}`,
        })
        throw err
      }
    }

    try {
      await rpc(
        'initialize',
        { clientInfo: { name: CODEX_SERVER_FACTS.clientName, title: 'agentdeck', version: '0.0.0' } },
        `→ initialize（clientInfo.name=${CODEX_SERVER_FACTS.clientName}，version=0.0.0）`,
      )
      transport.notify('initialized')

      if (opts.resumeSessionId) {
        // 恢复是一等公民（§2.4）：thread/resume。失败形状已实测——一律是
        // JSON-RPC error（-32600）。被拒时回退**新线程**继续跑 + resumeRejected=true：
        // 与 claude 的语义一致（FR-CLI-06：继续跑了但没有上文，要大声说，不能悄悄跑偏）。
        try {
          const res = await rpc<Record<string, unknown>>(
            'thread/resume',
            { threadId: opts.resumeSessionId },
            `→ thread/resume（threadId=${opts.resumeSessionId}）`,
          )
          threadId = asString(asRecord(asRecord(res)?.['thread'])?.['id']) ?? opts.resumeSessionId
          activeModel = asString(asRecord(res)?.['model']) ?? null
          resumeRejected = false
          // ══════════════════════════════════════════════════════════════════
          // ⚠️ 线程带着**它自己**的工作目录（`thread/start` 时定的），而本次 run 的目录
          //    可能不是同一个（沉淀返工就是这样：v2 在自己的小屋里干活，而 resume 的是
          //    v1 的线程）。`thread/resume` **改不了**线程的 cwd（参数只有 threadId），
          //    所以只能：① 本轮显式把 cwd 传下去（见下面 `turn/start`）；
          //    ② 对不上时**说出来**——不然"它到底在哪个目录里干活"只能靠猜。
          //
          //    这一段是**使用者提问量出来的**：他看到日志里那句"工作目录已切换到新任务"，
          //    问"这说明工作目录有变化？为什么需要变化呢"。查下来发现 `turn/start` 一直
          //    没带 cwd（文档里它标着"可选，thread 已带"——而"thread 已带"恰恰是 resume
          //    这一路上的坑：带的是**旧**目录）。
          const resumedCwd = asString(asRecord(res)?.['cwd'])
          if (resumedCwd !== null && resumedCwd !== opts.workDir) {
            this.#options.onWarn?.(
              `会话 ${opts.resumeSessionId} 的工作目录是 ${resumedCwd}，` +
                `本次 run 的目录是 ${opts.workDir}——` +
                `已在本轮的 turn 里显式指定 ${opts.workDir}（线程里的上文来自另一个目录，` +
                `它的记忆里可能有那边的路径）。`,
            )
          }
        } catch (err) {
          if (!(err instanceof JsonRpcServerError)) throw err
          this.#options.onWarn?.(
            `会话恢复被 codex 服务端拒绝：${err.message}（code=${err.code}）。` +
              `回退到新线程继续本次 run——它缺少上文，产出可能接不上（FR-CLI-06）。`,
          )
          resumeRejected = true
          const res = await rpc<Record<string, unknown>>(
            'thread/start',
            {
              model: opts.model ?? undefined,
              cwd: opts.workDir,
              approvalPolicy: CODEX_SERVER_FACTS.approvalPolicy,
              sandbox: CODEX_SERVER_FACTS.sandbox,
            },
            `→ thread/start（cwd=${opts.workDir}，model=${opts.model ?? '（CLI 默认）'}，` +
              `approvalPolicy=${CODEX_SERVER_FACTS.approvalPolicy}）`,
          )
          const t = asRecord(res)
          const tId = asString(asRecord(t?.['thread'])?.['id'])
          if (!tId) {
            throw new Error('thread/start 响应里没有 thread.id —— 服务端行为与预期不符')
          }
          threadId = tId
          activeModel = asString(t?.['model']) ?? null
        }
      } else {
        const res = await rpc<Record<string, unknown>>(
          'thread/start',
          {
            model: opts.model ?? undefined,
            cwd: opts.workDir,
            approvalPolicy: CODEX_SERVER_FACTS.approvalPolicy,
            sandbox: CODEX_SERVER_FACTS.sandbox,
          },
          `→ thread/start（cwd=${opts.workDir}，model=${opts.model ?? '（CLI 默认）'}，` +
            `approvalPolicy=${CODEX_SERVER_FACTS.approvalPolicy}）`,
        )
        const t = asRecord(res)
        const tId = asString(asRecord(t?.['thread'])?.['id'])
        if (!tId) {
          throw new Error('thread/start 响应里没有 thread.id —— 服务端行为与预期不符')
        }
        threadId = tId
        // ★ 实际激活的模型（审计要"CLI 报告的"）
        activeModel = asString(t?.['model']) ?? null
      }

      const turnRes = await rpc<Record<string, unknown>>(
        'turn/start',
        {
          threadId,
          // ★ 实测：恢复的线程 approvalPolicy 会退回 on-request——turn/start 也必须
          //   显式传 never，否则无人值守策略不成立（§7 清单第 2 条的补充结论）。
          approvalPolicy: CODEX_SERVER_FACTS.approvalPolicy,
          // ★★ 每一轮都显式给 cwd（分批第 15 批补的）。
          //
          //    文档里这个参数标着"可选，thread 已带"——**"thread 已带"在 resume 那一路上是错的**：
          //    线程带的是它自己创建时的目录，而本次 run 的目录可能不同（沉淀返工的 v2 在自己的
          //    小屋里干活，resume 的却是 v1 的线程）。不显式给，这一轮到底在哪个目录里执行就
          //    取决于服务端如何取舍"线程的 cwd"与"进程的 cwd"——那是**没量过**的行为，
          //    而它决定了起草者读到的 `skill/` 是哪一版、写回去的文件又落在哪间小屋。
          cwd: opts.workDir,
          // prompt 已是 B 档三段合成的一段（deliveryModeFor 在 daemon 侧判定）
          input: [{ type: 'text', text: opts.prompt }],
        },
        `→ turn/start（threadId=${threadId}，input 1 项 / ${String(opts.prompt.length)} 字符，` +
          `cwd=${opts.workDir}）`,
      )

      const turnObj = asRecord(asRecord(turnRes)?.['turn'])
      const tId = asString(turnObj?.['id'])
      if (!tId) {
        throw new Error('turn/start 响应里没有 turn.id —— 服务端行为与预期不符')
      }
      turnId = tId
    } catch (err) {
      const msg =
        err instanceof JsonRpcServerError
          ? `codex 服务端拒绝了请求：${err.message}（code=${err.code}）`
          : `codex 对话阶段失败：${err instanceof Error ? err.message : String(err)}`
      parser.markFailed(msg)
    }

    const abortListener = (): void => {
      void handle?.terminate()
    }
    opts.signal?.addEventListener('abort', abortListener, { once: true })

    // ── 结果：等到"终止帧"或"进程先退出"，然后收掉 per-run server ──
    const result: Promise<AgentResult> = (async () => {
      try {
        const end = await Promise.race([
          parser.turnEnd.then((e) => ({ kind: 'end' as const, end: e })),
          handle!.exited.then((exit) => ({ kind: 'exit' as const, exit })),
        ])
        if (end.kind === 'end') {
          // 正常路径：turn 结束了，把 per-run 服务进程收掉，拿退出码
          await handle!.terminate()
        }
        const exit =
          end.kind === 'exit'
            ? end.exit
            : await handle!.exited.catch(() => ({ code: null as number | null, signal: null as NodeJS.Signals | null }))
        return this.#buildResult({
          parser,
          exit,
          startedAt,
          stderrTail,
          opts,
          spawnError,
          executablePath,
          threadId,
          activeModel,
          resumeRejected,
        })
      } finally {
        opts.signal?.removeEventListener('abort', abortListener)
        queue.close()
      }
    })()

    return {
      messages: queue,
      result,
      async cancel() {
        // 先干净地 interrupt（让服务端收尾、发 turn/completed(interrupted)），
        // 再兜底 terminate——interrupted 因此不会被误判为异常（parser 记了标记）。
        if (handle && threadId && turnId) {
          parser.noteInterruptRequested()
          await transport
            .request('turn/interrupt', { threadId, turnId }, { timeoutMs: 2000 })
            .catch(() => undefined)
          await Promise.race([parser.turnEnd, sleep(INTERRUPT_GRACE_MS)])
        }
        await handle?.terminate()
      },
      lastActivityAt: () => handle?.lastActivityAt() ?? startedAt,
    }
  }

  #buildResult(input: {
    parser: CodexStreamParser
    exit: { code: number | null; signal: NodeJS.Signals | null }
    startedAt: number
    stderrTail: string
    opts: ExecOptions
    /** 起进程失败时的原始错误（异步 `'error'` 事件捞回来的）。 */
    spawnError: unknown
    executablePath: string
    threadId: string | null
    activeModel: string | null
    /** 恢复被拒：undefined=未请求/无法判断；false=恢复成功；true=被拒回退新线程。 */
    resumeRejected: boolean | undefined
  }): AgentResult {
    const {
      parser,
      exit,
      startedAt,
      stderrTail,
      opts,
      spawnError,
      executablePath,
      threadId,
      activeModel,
      resumeRejected,
    } = input
    const durationMs = Date.now() - startedAt

    const failure = classifyCodexFailure({
      recognizedEvents: parser.recognizedEvents,
      resultSeen: parser.resultSeen,
      parserIsError: parser.isError,
      exitCode: exit.code,
    })

    const base = {
      durationMs,
      // ★ 会话凭据 = thread_id：下次 run 用它 thread/resume
      sessionId: threadId,
      usage: parser.usage,
      model: activeModel,
      exitCode: exit.code,
      // ★ rejectDetectable=true 后语义成立（FR-CLI-06）：true=被拒（缺上文），
      //   false=恢复成功，undefined=没请求恢复或对话阶段就失败了。
      resumeRejected,
    }

    if (failure !== null) {
      return {
        ...base,
        status: 'failed',
        output: parser.finalText ?? '',
        // 起进程失败优先报（原因更接近事实）；否则用 CLI 自己的原话
        error: spawnError
          ? describeSpawnError(spawnError, this.#descriptor.command, executablePath)
          : describeCodexFailure(failure, {
              command: this.#descriptor.command,
              exitCode: exit.code,
              unparsableLines: parser.unparsableLines,
              stderrTail,
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
}

/** 把分类结果翻成人看得懂、且指出下一步动作的错误文本（generic 那份的同构版）。 */
function describeCodexFailure(
  failure: Exclude<CodexFailure, null>,
  ctx: {
    command: string
    exitCode: number | null
    unparsableLines: number
    stderrTail: string
    /** CLI 自己报的错误文本——它比我们的推断更具体，优先用它。 */
    cliErrorText: string | null
  },
): string {
  const stderr = ctx.stderrTail.trim()
  const suffix = stderr ? `\nstderr: ${stderr.slice(-500)}` : ''

  if (failure === 'cli_unparsable_output') {
    return (
      `${ctx.command}（app-server）的输出无法解析为 JSON-RPC 帧` +
      `（exit=${ctx.exitCode ?? 'null'}，不可解析行 ${ctx.unparsableLines} 行）。` +
      `这类失败以前会表现为"agent 什么都没说"——现在它是明确失败。` +
      `常见原因：codex 版本升级改了协议形状，或该可执行文件根本不是 app-server。` +
      `本 runtime 在 0.144.0-alpha.4 上实测过（verified），升级 codex 前请先` +
      `核对 unverifiedFields() 里的残余未验证项。` +
      suffix
    )
  }

  return (
    ctx.cliErrorText ??
    `${ctx.command}（app-server）报告运行失败（exit=${ctx.exitCode ?? 'null'}）。${suffix}`
  )
}

/** 这个路径能不能当程序跑：必须是**普通文件**，且带执行权限（generic 同款）。 */
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

/** 探测结果要说清楚"有没有装"和"装了但跑不了"的区别（generic 同款）。 */
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
    `本 runtime 在 0.144.0-alpha.4 上实测过（verified），若你确认已安装，` +
    `很可能是描述表里的命令名与该 CLI 实际的名字不一致，或用 --executable 指定路径。`
  )
}
