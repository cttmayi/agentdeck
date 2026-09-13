import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import {
  injectContextBlock,
  removeContextBlock,
  removeInjectedSkills,
  renderContextBlock,
  renderTaskContext,
  writeSkill,
  type AgentBackend,
  type RuntimeDescriptor,
  type SkillBrief,
} from '@alpha-helper/agent-core'
import {
  assertRunTransition,
  loadChainSteps,
  redactArgv,
  type ChainStep,
  type Store,
} from '@alpha-helper/domain'
import type { SandboxOptions } from '@alpha-helper/agent-core'
import {
  ulid,
  type Issue,
  type Run,
  type RunFailure,
  type RunId,
  type RunResult,
  type SubmitRunRequest,
  type TokenUsage,
} from '@alpha-helper/protocol'
import { startIdleWatchdog, type IdleWatchdog } from './idle-watchdog.ts'
import { checkEnvironment } from './environment.ts'
import { ensureWorkDir, resolveWorkDir } from './workdir.ts'
import type { RunRegistry } from './registry.ts'
import type { ReviewCoordinator } from './review.ts'
import type { Semaphore } from './semaphore.ts'
import type { WorkDirLocks } from './workdir-locks.ts'

/**
 * Run 执行器 —— 打通"受理 → 执行 → 回传 → 终态"的整条路。
 *
 * ══════════════════════════════════════════════════════════════════
 * 顺序上有三条不能颠倒的地方
 * ══════════════════════════════════════════════════════════════════
 *
 * **① 先落盘、再返回受理**（FR-BRIDGE-06）
 *   如果先执行再落盘，页面在收到响应前崩溃就会让这次 run 失去记录——
 *   使用者看到的是"点了没反应，但 token 被花了"。
 *
 * **② 注入失败要让 run 失败**（FR-CLI-41）
 *   技能与上下文没写下去时 agent 会以为自己没有那个能力，于是**绕路**。
 *   静默的缺能力比直接报错糟得多：它不报错，只让结果悄悄变差。
 *
 * **③ 清理必须在 finally 里**（FR-CLI-27/29）
 *   失败路径同样不能在使用者目录里留下痕迹。这条最容易漏——
 *   正常路径有人测，失败路径往往没人看。
 */

export interface SubmitAccepted {
  kind: 'accepted'
  runId: RunId
  acceptedAt: number
  deduplicated: boolean
}

export interface SubmitRejected {
  kind: 'rejected'
  reason: 'no_capacity'
  retryAfterMs: number
}

export type SubmitOutcome = SubmitAccepted | SubmitRejected

export interface ExecutorDeps {
  store: Store
  /** 自动分配工作目录时的根（D27）。 */
  workRoot: string
  /**
   * 按 runtimeKey 解析要用的 backend 与描述符（D28）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 这个槽位存在的理由：agent 的 runtimeKey 原来**根本没被消费**
   * ══════════════════════════════════════════════════════════════════
   *
   * 在这之前，执行器用的是 daemon 级的 `backend` 与 `descriptor`——也就是说
   * 所有 agent 实际上都跑在同一个 CLI 上，而 agent 记录里的 `runtimeKey`
   * 只是一个**没人读的字段**。界面上能选、审计里会记，行为上不存在。
   *
   * 那正是这个项目反复在防的那类东西：**接口接受了，行为上不存在**。
   * 让人以为配了就生效，比不支持更糟。
   *
   * 现在按 run 解析：一个 run 用哪个 CLI，由它所属 agent 的 runtimeKey 决定。
   */
  resolveRuntime?: (runtimeKey: string) => { backend: AgentBackend; descriptor: RuntimeDescriptor }
  registry: RunRegistry
  backend: AgentBackend
  descriptor: RuntimeDescriptor
  semaphore: Semaphore
  locks: WorkDirLocks
  /** review run 的收口器。不提供则 review run 只跑不判。 */
  reviewCoordinator?: ReviewCoordinator
  /**
   * 可选沙箱（M4）。缺省 = 不包装。
   *
   * ★ 这是**整个 daemon 一个开关**，不是每个 agent 一份。
   *   做成 per-agent 会让人以为"给这个 agent 开了就它被保护了"，
   *   而实际上一旦某个 agent 关着，通过它跑的东西就是裸的——
   *   那种安全感是假的。要么全开，要么全不开。
   */
  sandbox?: SandboxOptions
  /**
   * 执行完成后自动接一次审核（S1）。
   *
   * 由调用方实现——它知道有哪些 agent、谁该当审核者、以及回路边界怎么算。
   * 返回 null 表示"不接"。
   */
  autoChainReview?: (input: {
    executeRun: Run
    executorAgentId: string
    output: string
  }) => Promise<RunId | null>
  now?: () => number
  onWarn?: (message: string) => void
}

export interface RunExecutorOptions {
  /** 排队时最多等多久才放弃（毫秒）。 */
  workDirWaitMs?: number
}

const DEFAULT_WORKDIR_WAIT_MS = 10 * 60 * 1000

/**
 * 关停宽限期。
 *
 * 5 秒的依据：正常取消走的是"终止进程树"（Unix 整组 / Windows 进程树），
 * 通常远快于此。给太短会在慢机器上误报，给太长则让 Ctrl-C 看起来卡住。
 * 超时不会强杀——只**如实告警**，避免把"没停下来"伪装成"停下来了"。
 */
const DEFAULT_SHUTDOWN_GRACE_MS = 5_000

/**
 * stderr 最多往日志里写多少行。
 *
 * 有的 CLI 在 stderr 上很吵（进度条、重试日志）。不设上限的话，一次 run 的
 * 日志会被噪声淹没，而**淹没的日志等于没有日志**——恰恰违反了"加它是为了
 * 方便 debug"这个初衷。
 *
 * 超限时**明说截断了多少行**：静默截断会让人以为"它只说了这些"。
 */
const MAX_STDERR_LOG_LINES = 200

/**
 * prompt 往日志里写多少字符。
 *
 * prompt 里可能是一整份报告正文（上万字）。全部铺开会把日志冲掉，
 * 而**被冲掉的日志等于没有日志**——那恰恰违反"加它是为了方便 debug"。
 * 截断时**明说还剩多少**，不让人误以为它就收到这些。
 */
const PROMPT_LOG_CHARS = 2_000

export class RunExecutor {
  readonly #deps: ExecutorDeps
  readonly #now: () => number
  readonly #running = new Map<string, { cancel: () => Promise<void> }>()
  /**
   * 已受理 run 的**生命周期 Promise**。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么必须留住这个 Promise
   * ══════════════════════════════════════════════════════════════════
   *
   * `submit` 是"先落盘、再返回受理"，真正的执行是 fire-and-forget 的
   * `void this.#run(...)`。如果不留住它，**没有任何东西能等一次执行结束**：
   *
   *   - `close()` 会在 run 还在写工作目录时就返回，调用方随后清理数据目录
   *     就会撞上 `ENOTEMPTY`（这曾是一个真实复现的偶发失败）；
   *   - 更严重的是真实场景：使用者按 Ctrl-C，进程退出，而子进程还在跑、
   *     还在改文件——"已停止"是假的。
   */
  readonly #tasks = new Map<string, Promise<void>>()
  /** 关闭中：不再受理新的 run。 */
  #closing = false
  readonly #workDirWaitMs: number
  /** 已因 invalid 重试过几次——按 subject 记，避免无限重试。 */
  readonly #invalidAttempts = new Map<string, number>()

  constructor(deps: ExecutorDeps, options: RunExecutorOptions = {}) {
    this.#deps = deps
    this.#now = deps.now ?? (() => Date.now())
    this.#workDirWaitMs = options.workDirWaitMs ?? DEFAULT_WORKDIR_WAIT_MS
  }

  get activeCount(): number {
    return this.#running.size
  }

  /** 幂等：同一个 `runId` 重复提交只受理一次（FR-BRIDGE-07）。 */
  async submit(req: SubmitRunRequest): Promise<SubmitOutcome> {
    const { store, registry, semaphore } = this.#deps
    const now = this.#now()

    // ★ 工作目录在这里**统一决定**（D27）。
    //
    //   放在执行器而不是各个调用点，是因为调用点有五个（页面建任务、动作派生、
    //   自动串接审核、重试、报告摄取）——任意一处忘了给目录，就会退化成
    //   "所有任务挤在同一个目录里"，而且没有任何报错。
    const resolved = resolveWorkDir({
      requested: req.workDir ?? null,
      agentDefault: req.agentDefaultWorkDir ?? null,
      workRoot: this.#deps.workRoot,
      subject: req.subject,
      fallbackId: req.runId,
    })
    // 受理时就建好：使用者提交后立刻能看到目录，而不是等跑起来才知道
    await ensureWorkDir(resolved.path)

    // 关闭中不再受理：否则"关闭"永远等不完（判决派生的 run 会源源不断进来）。
    if (this.#closing) {
      return { kind: 'rejected', reason: 'no_capacity', retryAfterMs: 0 }
    }

    const existing = await store.getRun(req.runId)
    if (existing) {
      return { kind: 'accepted', runId: req.runId, acceptedAt: existing.queuedAt, deduplicated: true }
    }

    if (!semaphore.tryAcquire()) {
      return { kind: 'rejected', reason: 'no_capacity', retryAfterMs: 2000 }
    }

    const run: Run = {
      id: req.runId,
      workspaceId: await this.#defaultWorkspaceId(),
      kind: req.kind,
      status: 'queued',
      agentId: req.agentRef.id,
      subject: req.subject,
      trigger: req.kind === 'review' ? 'third_party' : 'assignment',
      derivedFrom: (req.derivedFrom ?? null) as Run['derivedFrom'],
      chainDepth: req.chainDepth ?? 0,
      skillRefs: (req.skills ?? []).map((s) => s.ref),
      workDir: resolved.path,
      waitReason: null,
      sessionId: null,
      attempt: 1,
      maxAttempts: 2,
      failureReason: null,
      usage: null,
      queuedAt: now,
      dispatchedAt: null,
      startedAt: null,
      finishedAt: null,
    }

    await store.insertRun(run)

    registry.create({
      runId: req.runId,
      kind: req.kind,
      agentId: req.agentRef.id,
      workDir: resolved.path,
      startedAt: now,
    })

    // ★ 留住这次执行的生命周期，让 `shutdown()` 有东西可等。
    const task = this.#run(req, run)
      .catch((err: unknown) => {
        this.#deps.onWarn?.(`run ${req.runId} 执行失败：${String(err)}`)
      })
      .finally(() => {
        this.#tasks.delete(req.runId)
      })
    this.#tasks.set(req.runId, task)

    return { kind: 'accepted', runId: req.runId, acceptedAt: now, deduplicated: false }
  }

  /**
   * 决定这次 run 要不要、以及用哪个 sessionId 去恢复。
   *
   * ══════════════════════════════════════════════════════════════════
   * 三种 sessionState 各自的后果（FR-CLI-06）
   * ══════════════════════════════════════════════════════════════════
   *
   * - `'stateful'` → 允许恢复；拿得到上文 sessionId 就传下去，
   *   并**准备好判定"恢复被拒"**；
   * - `'stateless'` → 绝不恢复。不是"暂时没实现"，是这个 CLI 没有会话；
   * - `'unknown'` → 同样不恢复，但理由不同（没验证过），所以要说出来。
   *
   * 后两者的外部行为一样（都不恢复），但**记录的措辞必须不同**：
   * 一个需要人去核对真实 CLI，另一个什么都不用做。混成一句
   * "不支持恢复"会把待办事项悄悄抹掉。
   */
  async #resolveResume(
    req: SubmitRunRequest,
    run: Run,
    descriptor: RuntimeDescriptor,
  ): Promise<{ sessionId: string | null; reason: string }> {
    const state = descriptor.sessionState

    if (!req.resumeFromRunId) {
      return { sessionId: null, reason: '这不是重试，没有可恢复的上文' }
    }

    if (state !== 'stateful') {
      const why =
        state === 'stateless'
          ? `${descriptor.key} 是无状态 CLI，不存在会话可恢复`
          : `${descriptor.key} 的会话状态**未验证**（sessionState: 'unknown'），` +
            `因此不尝试恢复——拿未验证的能力去跑，出问题时无从判断`
      this.#deps.onWarn?.(`run ${run.id} 不恢复会话：${why}`)
      return { sessionId: null, reason: why }
    }

    const previous = await this.#deps.store.getRun(req.resumeFromRunId as RunId)
    if (!previous) {
      return { sessionId: null, reason: `要恢复的 run ${req.resumeFromRunId} 不存在` }
    }
    if (!previous.sessionId) {
      // 上一次就没留下会话（比如它自己也是第一次跑）——不是错误，但要说清
      return {
        sessionId: null,
        reason: `上一次 run ${previous.id} 没有留下 sessionId，无从恢复`,
      }
    }
    return { sessionId: previous.sessionId, reason: `恢复自 run ${previous.id}` }
  }

  /**
   * 解析这次 run 该用哪个 backend 与描述符。
   *
   * 三级回退，每一级的理由不同：
   *
   * 1. 没有 `resolveRuntime`（测试或未装配）⇒ 用 daemon 级的那一套；
   * 2. agent 找不到（例如动作派生时传了个不存在的 id）⇒ 同样回退并告警；
   * 3. runtimeKey 未知 ⇒ 回退到 daemon 级并**告警**，而不是让 run 直接失败。
   *
   * 第 3 条是刻意的：一个配错了 runtime 的 agent 如果让所有任务都跑不起来，
   * 那是个很难查的故障（错误会出现在"进程启动失败"上）。回退 + 告警
   * 至少让事情能继续，而告警把"你配错了"说出来。
   */
  async #runtimeFor(run: Run): Promise<{ backend: AgentBackend; descriptor: RuntimeDescriptor }> {
    const fallback = { backend: this.#deps.backend, descriptor: this.#deps.descriptor }
    if (!this.#deps.resolveRuntime) return fallback

    const agent = await this.#deps.store.getAgent(run.agentId as never)
    if (!agent) return fallback

    try {
      return this.#deps.resolveRuntime(agent.runtimeKey)
    } catch (err) {
      this.#deps.onWarn?.(
        `agent ${agent.name} 的 runtimeKey（${agent.runtimeKey}）无法解析，` +
          `本次回退到 ${this.#deps.descriptor.key}：${err instanceof Error ? err.message : String(err)}`,
      )
      return fallback
    }
  }

  /**
   * 往 run 的消息流里写一行**状态**。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么要专门有这么一个方法
   * ══════════════════════════════════════════════════════════════════
   *
   * 使用者看得最多的地方是**执行日志**，而不是运行记录里的字段。所以
   * "这次用了哪些 skill""环境有没有问题"这类事实如果只写进记录、
   * 不写进日志，使用者就得靠猜——而他会猜错：
   *
   *   Claude Code 启动时自己会报一句"会话已启动（25 个工具可用）"，
   *   那是**它内置工具的数量**，与我们的 skill 无关。使用者看到它，
   *   很自然会以为"用的还是 Claude 默认的那套"——因为日志里**没有任何
   *   地方说我们注入了什么**。
   *
   * 我们确实注入了（`.claude/skills/<slug>/SKILL.md` 与 `CLAUDE.md` 都在
   * 工作目录里），但"确实做了"和"看得出来做了"是两件事。
   */
  async #note(runId: RunId, text: string): Promise<void> {
    const event = this.#deps.registry.emit(runId, {
      t: 'message',
      message: {
        type: 'status',
        tool: null,
        content: text,
        input: null,
        output: null,
        outputTruncated: false,
        at: this.#now(),
      },
    })
    if (event?.t === 'message') await this.#deps.store.appendRunMessage(runId, event.message)
  }

  async #defaultWorkspaceId(): Promise<Run['workspaceId']> {
    const ids = await this.#deps.store.listWorkspaceIds()
    const first = ids[0]
    if (!first) throw new Error('没有可用的 workspace——daemon 尚未完成初始化')
    return first
  }

  async #run(req: SubmitRunRequest, run: Run): Promise<void> {
    // ★ 按这个 run 所属的 runtime 取 backend 与描述符（D28）。
    //
    //   解析放在 `#run` 开头而不是 `submit`：`submit` 要保持"先落盘、再返回
    //   受理"这条快路径尽量短，而解析 backend 可能涉及探测（新装了一个 CLI
    //   时）。落盘失败要早报，探测慢不该拖住受理。
    const runtime = await this.#runtimeFor(run)


    const { store, registry, locks, semaphore } = this.#deps
    const runId = run.id

    const lock = locks.acquire(run.workDir!, runId)
    if (!lock.acquired) {
      await store.transitionRun(runId, 'queued', 'dispatched', { dispatchedAt: this.#now() })
      await store.transitionRun(runId, 'dispatched', 'waiting_local_directory', {
        waitReason: run.workDir,
      })
      registry.emit(runId, { t: 'status', status: 'waiting_local_directory', at: this.#now() })

      const timeout = new Promise<'timeout'>((resolve) => {
        const t = setTimeout(() => resolve('timeout'), this.#workDirWaitMs)
        t.unref?.()
      })
      const outcome = await Promise.race([lock.waiting!.then(() => 'acquired' as const), timeout])

      if (outcome === 'timeout') {
        locks.cancelWaiting(run.workDir!, runId)
        await this.#finish(runId, 'failed', null, {
          reason: 'infra_error',
          message: `等待工作目录释放超过 ${Math.round(this.#workDirWaitMs / 1000)} 秒`,
        })
        semaphore.release()
        return
      }
      await store.transitionRun(runId, 'waiting_local_directory', 'queued')
    }

    let restoreContext: (() => Promise<void>) | null = null
    /**
     * 空闲看门狗。
     *
     * 声明在 `try` **外面**是必须的——`finally` 里要兜底停表，而
     * `try` 内部声明的变量在 `finally` 里看不到。
     */
    let watchdog: IdleWatchdog | null = null
    let injectedSlugs: string[] = []
    let cleaned = false

    /**
     * 清理注入物。**幂等**——正常路径与 finally 都会调它。
     *
     * ⚠️ 调用时机很关键：必须在**发出 terminal 事件之前**完成。
     * 否则页面收到"跑完了"时，我们注入的技能与上下文块还躺在使用者的
     * 目录里——页面据此显示的状态与磁盘不一致，而使用者可能正好在那时
     * 打开文件看结果。
     */
    const cleanup = async (): Promise<void> => {
      if (cleaned) return
      cleaned = true
      if (restoreContext) await this.#restoreContext(restoreContext)
      await removeInjectedSkills(run.workDir!, runtime.descriptor.skillDir, injectedSlugs)
    }

    try {
      await store.transitionRun(runId, 'queued', 'dispatched', { dispatchedAt: this.#now() })

      // 环境预检放在注入之前：如果 CLI 连自己的状态目录都写不了，
      // 这次 run 的产出是不可信的，越早说越好（而清理注入物的开销也省下了）
      const envCheck = await checkEnvironment([{ descriptor: runtime.descriptor, available: true }])

      // ── 注入技能（按 agent 求解的**子集**，D22）──
      const skillsBrief: SkillBrief[] = []
      for (const skill of req.skills ?? []) {
        // 注入失败要让 run 失败——静默的缺能力比报错糟得多
        await writeSkill(run.workDir!, runtime.descriptor.skillDir, {
          slug: skill.slug,
          content: skill.body,
          // 支持文件也要一起写下去。只写 SKILL.md 的话，技能里引用的脚本/
          // 参考文档在运行时根本不存在——技能"装上了"却干不了活，而且
          // 从日志上看不出为什么（CLI 只会说找不到文件）。
          ...(skill.files && Object.keys(skill.files).length > 0 ? { files: skill.files } : {}),
        })
        injectedSlugs.push(skill.slug)
        skillsBrief.push({ slug: skill.slug, name: skill.name, body: skill.body })
      }

      // ★ 环境预检的问题必须出现在**这份日志里**。
      //
      //   实测踩到过：daemon 跑在限制家目录写入的环境里（容器 / 专用用户 /
      //   沙箱），于是 Claude Code 建不了自己的 `~/.claude/session-env/`，
      //   它的 **Bash 工具全程 EPERM**，agent 还会自己琢磨着绕
      //   （日志里出现"maybe with dangerouslyDisableSandbox"）。
      //
      //   启动时 daemon 已经在警告了、身份接口也报了、智能体页也显示了——
      //   但使用者在看的是**这一份日志**。只在那儿说，等于没说。
      if (!envCheck.ok) {
        await this.#note(
          runId,
          `⚠️ 环境有问题：${envCheck.issues.map((i) => i.summary).join('；')}`,
        )
        await this.#note(
          runId,
          `   影响：CLI 的 Bash 等工具可能全程失败，本次产出不可信。` +
            `修法：${envCheck.issues[0]?.action ?? ''}`,
        )
      }

      // ★ 把**输入**也写进日志。
      //
      //   排查时最先要回答的两个问题是"给了它什么"与"它做了什么"。
      //   后者原本只有工具名（没有参数，见界面那边的修复），而**前者
      //   完全不在日志里**——prompt 只存在于内存与上下文块里。
      //
      //   长 prompt（报告正文可能上万字）要截断，并**明说截断了**——
      //   静默截断会让人以为"它就收到这些"。
      await this.#note(runId, `输入（prompt，${req.prompt.length} 字符）：`)
      await this.#note(
        runId,
        req.prompt.length > PROMPT_LOG_CHARS
          ? `${req.prompt.slice(0, PROMPT_LOG_CHARS)}\n…（还有 ${req.prompt.length - PROMPT_LOG_CHARS} 字符未显示）`
          : req.prompt,
      )

      // ★ 把注入结果写进日志。
      //
      //   不写的话，使用者在日志里只看到 Claude 自己报的"25 个工具可用"，
      //   而那说的是**它的内置工具**——于是很自然会以为我们的 skill 没生效。
      //   事实是它生效了，只是**看不出来**。
      await this.#note(
        runId,
        req.skills && req.skills.length > 0
          ? `已注入 ${req.skills.length} 个 skill：${req.skills.map((s) => s.slug).join('、')}` +
              `（写入 ${runtime.descriptor.skillDir}/，加上上下文文件 ${runtime.descriptor.contextFile}）`
          : `本次没有注入任何 skill（该 agent 没挂 skill）——agent 将按它自己的默认行为工作`,
      )

      // ── 注入上下文块 ──
      const contextFile = join(run.workDir!, runtime.descriptor.contextFile)
      const body =
        req.kind === 'review' && req.review
          ? renderTaskContext({
              kind: 'review',
              runId,
              subject: req.subject,
              report: { kind: req.review.kind, title: req.review.title, body: req.review.body },
              skills: skillsBrief,
              relatedIssueId: req.review.relatedIssueId ?? null,
            })
          : renderTaskContext({
              kind: 'execute',
              runId,
              subject: req.subject,
              prompt: req.prompt,
              skills: skillsBrief,
            })

      restoreContext = await this.#injectContext(contextFile, body)

      await store.transitionRun(runId, 'dispatched', 'running', { startedAt: this.#now() })
      registry.emit(runId, { t: 'status', status: 'running', at: this.#now() })

      // ★ 会话恢复（FR-CLI-06）。
      //
      //   在此之前这里是写死的 `resumeSessionId: null`——也就是说**平台
      //   从来不恢复会话**，尽管两个适配器、描述表、以及"恢复被拒"的探测
      //   全都实现好了。整条能力差最后这一段接线。
      //
      //   恢复与否**由描述表的 sessionState 决定**，不是由"有没有 sessionId"
      //   决定：一个 `'unknown'` 的 runtime（没验证过有没有会话）即便历史里
      //   留了个 sessionId，也不该拿去恢复——那是在替真实 CLI 回答一个
      //   我们答不上来的问题。
      const resume = await this.#resolveResume(req, run, runtime.descriptor)

      // ★ 命令行与 stderr 进日志（方便 debug）。
      //
      //   命令行的**脱敏**走 domain 的 `redactArgv` —— 与审计记录用的是
      //   同一份实现。适配器依赖不到 domain，所以由它上报事实、这里负责
      //   脱敏：安全逻辑只有一份，不会漂。
      let stderrLines = 0
      let stderrTruncated = 0
      const session = await runtime.backend.execute({
        prompt: req.prompt,
        workDir: run.workDir!,
        model: null,
        maxTurns: req.limits.maxTurns,
        resumeSessionId: resume.sessionId,
        env: {},
        onCommandLine: ({ argv, sandboxDescription }) => {
          void this.#note(runId, `命令行：${redactArgv(argv).join(' ')}`)
          // ★ 沙箱状态单独一行，**由后端如实上报**而不是从命令行反推。
          //
          //   只报命令的话，日志里一条 `claude -p …` 看过去分不清
          //   "沙箱没开"还是"沙箱开了但没生效"——两者的排查方向完全不同。
          void this.#note(runId, `沙箱：${sandboxDescription}`)
        },
        onStderrLine: (line) => {
          const text = line.trimEnd()
          if (text === '') return
          if (stderrLines < MAX_STDERR_LOG_LINES) {
            stderrLines += 1
            void this.#note(runId, `stderr: ${text}`)
          } else {
            // 静默截断会让人以为"它只说了这些"——所以数着并明说
            stderrTruncated += 1
          }
        },
        ...(this.#deps.sandbox ? { sandbox: this.#deps.sandbox } : {}),
      })

      if (stderrTruncated > 0) {
        await this.#note(
          runId,
          `（stderr 还有 ${stderrTruncated} 行没有写进日志——上限 ${MAX_STDERR_LOG_LINES} 行，` +
            `完整内容见运行记录里的失败信息或本地重跑）`,
        )
      }

      this.#running.set(runId, { cancel: () => session.cancel() })

      // ★ 空闲看门狗（FR-RUN-08）。
      //
      //   `limits.timeoutMs` 此前是**接受但完全忽略**的参数。现在把它接上，
      //   而且按需求的原意做成**空闲**超时而不是墙钟超时：
      //   耗时长不等于出问题，卡住才是。
      let idleTimedOut = false
      const idleTimeoutMs = req.limits.timeoutMs
      watchdog =
        idleTimeoutMs === null
          ? null
          : startIdleWatchdog({
              session,
              idleTimeoutMs,
              onIdle: (idleMs) => {
                idleTimedOut = true
                // 先记下来再取消：取消会让消息流结束，走到下面的失败分级时
                // 需要知道"这次失败是我们主动掐的"，而不是 CLI 自己挂了。
                this.#deps.onWarn?.(
                  `run ${runId} 已空闲 ${Math.round(idleMs / 1000)} 秒（上限 ${Math.round(idleTimeoutMs / 1000)} 秒），判定卡住并终止`,
                )
                void session.cancel().catch(() => undefined)
              },
            })

      let collected = ''
      for await (const message of session.messages) {
        if (message.type === 'text') collected += `${message.content}\n`
        const event = registry.emit(runId, {
          t: 'message',
          message: {
            type: message.type,
            tool: message.tool ?? null,
            content: message.content,
            input: message.input ?? null,
            output: message.output ?? null,
            outputTruncated: message.outputTruncated ?? false,
            at: this.#now(),
          },
        })
        if (event?.t === 'message') await store.appendRunMessage(runId, event.message)
      }

      const result = await session.result
      watchdog?.stop()

      // ★ 退出码也进日志：它是"进程到底怎么结束的"最直接的证据，
      //   而原来它只在失败时以一句话的形式出现
      await this.#note(
        runId,
        `进程结束：status=${result.status}` +
          (result.exitCode !== undefined && result.exitCode !== null
            ? ` exitCode=${result.exitCode}`
            : '') +
          ` 耗时 ${Math.round(result.durationMs / 1000)} 秒`,
      )
      if (result.usage) registry.emit(runId, { t: 'usage', usage: result.usage })

      // ★ 「恢复被拒绝」必须与「无法判断」分开报（FR-CLI-06）。
      //
      //   `resumeRejected === undefined` 的含义是**测不出来**，不是"没被拒"。
      //   把这两者混起来，会让"恢复其实没生效"看起来像"恢复得很好"——
      //   而 agent 是在**没有上文**的情况下继续干活的，产出会悄悄跑偏。
      if (resume.sessionId !== null) {
        if (result.resumeRejected === true) {
          this.#deps.onWarn?.(
            `run ${runId} 的会话恢复被 CLI 拒绝（${runtime.descriptor.key}）：` +
              `这次执行缺少上文，产出可能与预期不符`,
          )
          await store.appendInboxItem({
            id: ulid(),
            workspaceId: run.workspaceId,
            type: 'run.resume_rejected',
            severity: 'attention',
            title: '会话恢复被拒绝，这次执行缺了上文',
            body:
              `CLI 明确拒绝了恢复会话 ${resume.sessionId}。` +
              `本次 run 是在**没有前文**的情况下跑的，结论未必接得上。`,
            issueId: run.subject.type === 'issue' ? (run.subject.id as Issue['id']) : null,
            runId,
            read: false,
            createdAt: this.#now(),
          })
        } else if (result.resumeRejected === undefined) {
          // 表里 rejectDetectable: false ⇒ 这个 undefined 是**不可信的**
          this.#deps.onWarn?.(
            `run ${runId} 请求了会话恢复，但 ${runtime.descriptor.key} 无法判断` +
              `是否被拒绝（rejectDetectable: false）——不能当成"恢复成功"`,
          )
        }
      }

      // ── review run 的收口：判决、动作、审计 ──
      if (req.kind === 'review' && result.status === 'completed') {
        await this.#handleReview(req, run, result.output || collected, result.usage, runtime.descriptor)
      }

      // ★ S1：执行完成后自动接一次审核（可选）
      let chainedRunId: RunId | null = null
      if (req.kind === 'execute' && result.status === 'completed') {
        try {
          chainedRunId = (await this.#deps.autoChainReview?.({
            executeRun: run,
            executorAgentId: req.agentRef.id,
            output: result.output || collected,
          })) ?? null
        } catch (err) {
          // 串接失败不能让执行本身变成失败——但必须可见
          this.#deps.onWarn?.(`自动审核串接失败：${String(err)}`)
        }
      }

      // ★ 先清理、再报终态
      await cleanup()

      // ══════════════════════════════════════════════════════════════
      // ★ 被使用者取消的 run 不能记成 infra_error
      // ══════════════════════════════════════════════════════════════
      //
      // 取消会让会话以"失败"收场，于是失败分级把它归到 `infra_error`——
      // 而那是"环境坏了"的意思。**错误原因指向了完全错误的地方**：
      // 有人会去查 CLI 装没装好、权限对不对，而真相是"你（或某个脚本）
      // 点了取消"。
      //
      // 取消是**使用者的动作**，就该记成使用者的动作：状态 `cancelled`、
      // 原因 `cancelled_by_user`。审计与看板上这是两个完全不同的问题。
      const cancelledByUser = registry.get(runId)?.cancellationRequested === true
      if (cancelledByUser) {
        await cleanup()
        await this.#finish(runId, 'cancelled', null, null)
        return
      }

      if (result.status === 'completed') {
        await this.#finish(
          runId,
          'completed',
          {
            artifactRefs: [],
            summary: (result.output || collected).slice(0, 500),
            workDir: run.workDir!,
            sessionId: result.sessionId ?? null,
          },
          null,
          result.usage ?? undefined,
          result.sessionId ?? undefined,
        )
      } else {
        await this.#finish(runId, 'failed', null, {
          // ★ 空闲超时要用它自己的原因码，不能混进 infra_error：
          //   "卡住了"与"环境坏了"的处置完全不同（前者该看看 agent 在等什么，
          //   后者该去查 CLI 装没装好）。`idle_timeout` 这个枚举值本来就在，
          //   一直没人产生它。
          reason: idleTimedOut
            ? 'idle_timeout'
            : result.exitCode === 0
              ? 'agent_error'
              : 'infra_error',
          message: idleTimedOut
            ? `已空闲 ${Math.round((req.limits.timeoutMs ?? 0) / 1000)} 秒没有任何输出，判定卡住并终止`
            : (result.error ?? '运行失败'),
        })
      }
    } catch (err) {
      await this.#finish(runId, 'failed', null, {
        reason: 'infra_error',
        message: err instanceof Error ? err.message : String(err),
      })
    } finally {
      // 兜底停表：`finally` 是唯一能保证走到的位置。漏掉的后果不是"少停一个
      // 定时器"，而是**进程里留着一个永不结束的定时器**——它会拖住事件循环，
      // 让测试进程与使用者退出都卡住，而症状出现在离原因很远的地方。
      watchdog?.stop()
      // 兜底：失败路径同样不能在使用者目录里留下痕迹（FR-CLI-27/29）
      await cleanup()
      this.#running.delete(runId)
      locks.release(run.workDir!, runId)
      semaphore.release()
    }
  }

  async #handleReview(
    req: SubmitRunRequest,
    run: Run,
    output: string,
    usage: TokenUsage | null | undefined,
    descriptor: RuntimeDescriptor,
  ): Promise<void> {
    const coordinator = this.#deps.reviewCoordinator
    if (!coordinator) return

    const subjectKey = `${run.subject.type}:${run.subject.id}`
    const invalidAttempts = this.#invalidAttempts.get(subjectKey) ?? 0

    const allowedActions = (req.skills ?? []).flatMap((s) => s.allowedActions)

    // ★ 重建链路（根 → 当前）。动作派生要用它判环与判深度。
    //   失败不能拖垮审核本身——退化成空链路（只剩深度兜底）并告警。
    let chainSteps: ChainStep[] = []
    try {
      chainSteps = await loadChainSteps(this.#deps.store, run)
    } catch (err) {
      this.#deps.onWarn?.(`链路重建失败，环检测本次不可用：${String(err)}`)
    }

    const handling = await coordinator.handle({
      run,
      workspaceId: run.workspaceId,
      output,
      allowedActions,
      invalidAttempts,
      inputBlobRefs: req.review?.inputBlobRef ? [req.review.inputBlobRef] : [],
      skillRefs: (req.skills ?? []).map((s) => s.ref),
      modelId: null,
      promptHash: createHash('sha256').update(req.prompt, 'utf8').digest('hex'),
      argv: [descriptor.command, ...descriptor.baseArgs],
      usage,
      chainSteps,
    })

    if (handling.decision.kind === 'retry') {
      this.#invalidAttempts.set(subjectKey, invalidAttempts + 1)
    } else {
      this.#invalidAttempts.delete(subjectKey)
    }
  }

  /**
   * 注入上下文块。返回"还原函数"——无论成功失败都必须调用它。
   *
   * @param body 受管块的**内容**（渲染由调用方完成）
   */
  async #injectContext(contextFile: string, body: string): Promise<() => Promise<void>> {
    let original: string | null
    try {
      original = await readFile(contextFile, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') original = null
      else throw err
    }

    const injected = injectContextBlock(original, renderContextBlock(body))
    await mkdir(dirname(contextFile), { recursive: true })
    await writeFile(contextFile, injected.content, 'utf8')

    return async () => {
      const current = await readFile(contextFile, 'utf8').catch(() => null)
      if (current === null) return
      const removed = removeContextBlock(current)
      if (removed.deleteFile) {
        await rm(contextFile, { force: true })
      } else if (removed.content !== current) {
        await writeFile(contextFile, removed.content, 'utf8')
      }
    }
  }

  async #restoreContext(restore: () => Promise<void>): Promise<void> {
    try {
      await restore()
    } catch (err) {
      this.#deps.onWarn?.(`上下文块还原失败：${String(err)}`)
    }
  }

  async #finish(
    runId: RunId,
    terminal: 'completed' | 'failed' | 'cancelled',
    result: RunResult | null,
    error: RunFailure | null,
    usage?: TokenUsage | undefined,
    sessionId?: string | undefined,
  ): Promise<void> {
    const { store, registry } = this.#deps
    const run = await store.getRun(runId)

    if (run && run.status !== terminal) {
      let current = run.status
      const path: Run['status'][] = []
      if (current === 'waiting_local_directory') path.push('queued', 'dispatched', 'running')
      else if (current === 'queued') path.push('dispatched', 'running')
      else if (current === 'dispatched') path.push('running')

      for (const next of path) {
        try {
          assertRunTransition(current, next)
          await store.transitionRun(runId, current, next)
          current = next
        } catch {
          break
        }
      }
      try {
        assertRunTransition(current, terminal)
        await store.transitionRun(runId, current, terminal, {
          finishedAt: this.#now(),
          ...(usage ? { usage } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(error ? { failureReason: error.reason } : {}),
        })
      } catch (err) {
        this.#deps.onWarn?.(`run ${runId} 终态写入失败：${String(err)}`)
      }
    }

    registry.emit(runId, { t: 'terminal', status: terminal, result, error })
  }

  /** 取消。终止进程树（Unix 整组、Windows 进程树）。 */
  async cancel(runId: RunId): Promise<boolean> {
    const { registry, locks, store } = this.#deps
    registry.requestCancellation(runId)

    const running = this.#running.get(runId)
    if (running) {
      await running.cancel()
      return true
    }

    const run = await store.getRun(runId)
    if (run?.status === 'waiting_local_directory' && run.workDir) {
      locks.cancelWaiting(run.workDir, runId)
      await this.#finish(runId, 'cancelled', null, null)
      return true
    }
    if (run?.status === 'queued' || run?.status === 'dispatched') {
      await this.#finish(runId, 'cancelled', null, null)
      return true
    }

    return false
  }

  /** 生成一个 ULID 形式的 runId（供测试与本地触发使用）。 */
  static newRunId(): RunId {
    return ulid() as RunId
  }

  /**
   * 关停：停收新 run、取消进行中的、等它们真的结束。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么"关闭"必须是一个屏障
   * ══════════════════════════════════════════════════════════════════
   *
   * 早先 `close()` 只关 HTTP server 与 store，**不等执行中的 run**。
   * 后果有两个，都不是理论问题：
   *
   *   - 真实使用：Ctrl-C 之后子进程还在跑、还在改工作目录里的文件——
   *     使用者以为停了，其实没有；
   *   - 测试里：`close()` 后立刻清理数据目录，撞上 `ENOTEMPTY`
   *     （运行中的 run 正往里写）。这个偶发失败曾以约 40% 的概率复现。
   *
   * 宽限期存在的理由：取消是**请求**不是保证。给了时间还结束不了的 run
   * 必须被**如实报告**，而不是无限等下去把关闭变成挂起。
   */
  async shutdown(graceMs: number = DEFAULT_SHUTDOWN_GRACE_MS): Promise<void> {
    this.#closing = true
    const deadline = Date.now() + graceMs

    for (;;) {
      const tasks = [...this.#tasks.entries()]
      if (tasks.length === 0) return

      // 反复请求取消：派生出的新 run 会被下一轮带上。
      for (const [runId] of tasks) {
        await this.cancel(runId as RunId).catch(() => undefined)
      }

      const grace = deadline - Date.now()
      await Promise.race([
        Promise.allSettled(tasks.map(([, t]) => t)),
        new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, Math.min(100, grace)))),
      ])

      if (Date.now() >= deadline) {
        const stuck = [...this.#tasks.keys()]
        if (stuck.length > 0) {
          this.#deps.onWarn?.(
            `关闭宽限期（${graceMs}ms）内仍有 ${stuck.length} 个 run 未结束：${stuck.join(', ')}`,
          )
        }
        return
      }
    }
  }
}
