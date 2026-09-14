import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import {
  removeInjectedSkills,
  renderFirstSentence,
  SkillCollisionError,
  SkillTooLargeError,
  syncInjectedSkills,
  type AgentBackend,
  type RuntimeDescriptor,
  type SkillBrief,
} from '@alpha-helper/agent-core'
import {
  assertRunTransition,
  loadChainSteps,
  redactArgv,
  type ChainStep,
  type ReviewDecision,
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
   *
   * ★ `runId: null` **必须带一句 `note` 说明为什么没接**。
   *
   *   只返回 null 的那一版让日志只能说"没有串接审核"，说不出**为什么**——
   *   而"为什么没审"恰恰是使用者最需要知道的（是没配审核者？审核者被删了？
   *   还是链路深度超了？）。三种情况的处置完全不同。
   */
  autoChainReview?: (input: {
    executeRun: Run
    executorAgentId: string
    output: string
  }) => Promise<{ runId: RunId | null; note: string }>
  now?: () => number
  onWarn?: (message: string) => void
}

/**
 * 把判决结果写成一句人话。
 *
 * 六种走法都要有话说——**降级与不合规是最需要被看见的两种**（它们意味着
 * "模型给的东西没法直接用"），而在此之前它们和"一切正常"在日志里长得一样。
 */
function describeDecision(handling: {
  decision: ReviewDecision
  actionIds: readonly string[]
  spawnedRunId: string | null
  derivationBlocked: { reason: string; message: string } | null
}): string {
  const d = handling.decision
  const summary = (v: { conclusion: string; reasonCode: string; confidence: number }): string =>
    `${v.conclusion}（${v.reasonCode}，置信度 ${v.confidence}）`
  switch (d.kind) {
    case 'act':
      return `${summary(d.verdict)} → 已派发 ${handling.actionIds.length} 个动作`
    case 'advisory':
      return `${summary(d.verdict)} → 没有动作，只记录`
    case 'escalate':
      return `${summary(d.verdict)} → 需要人介入：${d.escalateReason}（已发通知）`
    case 'retry':
      return `不合规（${d.issues.length} 个问题）→ 重试一次，理由见上面的注入记录`
    case 'downgrade':
      return `不合规且重试次数已用尽 → 降级为建议（已发通知），本次不执行任何动作`
    case 'invalid':
      return `不合规且**重试无意义**（${d.issues.length} 个结构性问题）→ 已通知人处理`
    default:
      return '（未知的判决结果）'
  }
}

/** 哈希只显示前 12 位：够用来对照，又不至于把一行撑爆。 */
function shortHash(hash: string | null): string {
  return hash === null ? '无' : `${hash.slice(0, 12)}…`
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
      // ★ 审核 run 用**被审那条 run 的**工作目录（见 workdir.ts 里的说明）。
      //
      //   解析放在这里、而不是在"自动串接审核"那个调用点补一个 workDir：
      //   提交 review 的路径不止一条（自动串接、报告摄取、判决不合规的重试），
      //   任意一处忘了就会让审核者落进一间空屋子——而那种错**不会报任何错**，
      //   只会让审核结论变得没有依据。
      inheritFrom: await this.#inheritWorkDir(req),
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

    // ★ 工作目录进日志——**正常路径也要进**。
    //
    //   原来只有"继承与 agent 默认目录冲突"时才有话，正常路径上一个字都没有。
    //   而"它这次跑在哪个目录、为什么是那个目录"是使用者去找产出时问的第一个
    //   问题（`resolveWorkDir` 早就算出了 `origin` 与一句人话解释，只是一直没被用）。
    await this.#note(req.runId, `工作目录：${resolved.path}（${resolved.explanation}）`)

    // ★ 继承与"agent 默认目录"冲突时，**明说**。
    //
    //   静默忽略操作者配过的目录是不可接受的：他会以为自己那个设置生效了，
    //   而实际上审核跑在别的目录里。所以冲突进日志（也就是进界面）。
    const agentDefaultDir = req.agentDefaultWorkDir?.trim()
    if (resolved.origin === 'inherited' && agentDefaultDir && agentDefaultDir !== resolved.path) {
      await this.#note(
        req.runId,
        `该 agent 配了默认工作目录 ${agentDefaultDir}，但审核必须在**被审那条 run 的**` +
          `目录里进行（否则看不到它留下的产出），所以本次用的是 ${resolved.path}`,
      )
    }

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
  /**
   * 探测到的 CLI 版本——每个 runtime 只探一次。
   *
   * 为什么在这里缓存：审计每次都要一个版本号，而 `probe()` 会起一个进程
   * （`claude --version`）。探针本身有缓存，但"版本"是探测的第 2 步，
   * 再记一层能保证**每个 runtime 一生只起一次**。
   *
   * 读不到就如实记 `null`：**不要**用描述表里声明的范围去顶替——
   * 那是"我们希望它是什么版本"，不是"它是什么版本"。
   */
  readonly #cliVersions = new Map<string, string | null>()

  async #cliVersion(descriptor: RuntimeDescriptor, backend: AgentBackend): Promise<string | null> {
    const known = this.#cliVersions.get(descriptor.key)
    if (known !== undefined) return known
    let version: string | null = null
    try {
      version = (await backend.probe()).cliVersion
    } catch (err) {
      this.#deps.onWarn?.(`探测 ${descriptor.key} 的 CLI 版本失败：${String(err)}`)
    }
    this.#cliVersions.set(descriptor.key, version)
    return version
  }

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

  /**
   * 审核 run 要继承哪个目录（没有可继承的就返回 null）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么是"继承"而不是"按 subject 重新算一个"
   * ══════════════════════════════════════════════════════════════════
   *
   * 按 subject 重新算会得到一个**不同的**目录：审核 run 的 subject 是
   * `{type:'run', id: 被审的runId}`（D28 那条链就是这么接的），于是自动
   * 分配给出 `run-<被审的runId>`，而执行者用的是 `issue-<任务id>`。
   *
   * 而执行者的工作目录**不一定**等于按 subject 算出来的那个：需求里给了
   * 显式目录、或者 agent 配了默认目录时，它会是别的路径。所以只有"读那条
   * run 上真实记着的 workDir"才是对的——重算等于在猜。
   *
   * report 类型的 subject **不继承**：那条路径的产出是第三方送来的报告
   * （`Report` 里除 `meta` 外没有指回我们任何 run/id 的字段），没有"同一间
   * 屋子"可言，给它一个自己的目录反而干净。
   */
  async #inheritWorkDir(req: SubmitRunRequest): Promise<string | null> {
    if (req.kind !== 'review') return null
    if (req.subject?.type !== 'run') return null
    const reviewed = await this.#deps.store.getRun(req.subject.id as RunId)
    return reviewed?.workDir ?? null
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
    const waitedFrom = this.#now()
    if (!lock.acquired) {
      // ★ 排队也要说一声。原来这条路径**完全静默**（只有状态变了）：
      //   使用者看到 run 卡在那儿不动，日志里却一句话都没有。
      await this.#note(
        runId,
        `工作目录被占用，排队等待（最多 ${Math.round(this.#workDirWaitMs / 1000)} 秒）：${run.workDir}`,
      )
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
      await this.#note(
        runId,
        `已拿到工作目录，开始执行（排队 ${Math.round((this.#now() - waitedFrom) / 1000)} 秒）`,
      )
    }

    /**
     * 空闲看门狗。
     *
     * 声明在 `try` **外面**是必须的——`finally` 里要兜底停表，而
     * `try` 内部声明的变量在 `finally` 里看不到。
     */
    let watchdog: IdleWatchdog | null = null
    let cleaned = false

    /**
     * 这次 run 注入过哪些技能——给 `cleanup()` 收尾用。
     *
     * ⚠️ 两个要点：
     *   1. 它只是"要收哪几个"的**候选**；能不能删由**落盘清单**决定
     *      （见 `removeInjectedSkills`），所以这个数组错了也删不到使用者的东西；
     *   2. 它声明在 `try` **外面**：`cleanup()` 是闭包，而 `try` 里面再声明
     *      一个同名变量会**遮蔽**这一个——于是收尾拿到的是空数组，
     *      **技能静默地不会被收掉**（这个错我在改这份代码时刚犯过一次）。
     */
    let injectedSkills: string[] = []

    /**
     * 这次 run **实际**执行的命令行（含沙箱包装）——由后端如实上报。
     *
     * ★ 审计原来记的是 `[descriptor.command, ...descriptor.baseArgs]`：那**不是**
     *   实际跑的那条（没有 `--model`、没有 `--resume`、也没有沙箱包装）。
     *   审计回答的问题应该是"到底执行了什么"，记一条拼出来的大概样子，
     *   比空着更糟——它看起来像事实。
     *
     * 这里存**原始** argv，脱敏交给 `buildAuditRecord`（`redactArgv` 只有一份，
     * 在 domain 里）；日志那一行用同一份实现脱敏后显示。
     */
    let actualArgv: readonly string[] = []

    /**
     * 清理注入物。**幂等**——正常路径与 finally 都会调它。
     *
     * ⚠️ 调用时机很关键：必须在**发出 terminal 事件之前**完成，否则页面收到
     * "跑完了"时磁盘上还留着我们的东西，而使用者可能正好那时打开文件看结果。
     *
     * ★ 现在只还原**上下文块**（CLAUDE.md 是使用者自己的文件，必须逐字节复原）。
     *   **技能不再删**：工作目录是这个任务的产物之一，使用者会进去看"它是在
     *   什么标准下干活的"。技能的去留由 `syncInjectedSkills` 按**落盘的归属
     *   清单**对账（摘掉的会消失、崩溃残渣会自愈、使用者的同名技能绝不覆盖），
     *   见那个函数的说明。
     */
    const cleanup = async (): Promise<void> => {
      if (cleaned) return
      cleaned = true
      // ★ 技能收掉（使用者放弃了"保留技能"那条要求）。
      //
      //   原来的规矩是"保留"，理由是"跑完进工作目录看，要能看出它是在什么标准
      //   下干活的"；而那条要求已经被放弃，改由**每次 run 的上下文记录**承担
      //   （带着技能清单；审核那次还带着标准全文）。工作目录于是回到"只装
      //   agent 的产出"。
      //
      //   ⚠️ 删除的依据仍然是**落盘的归属清单而不是这个数组**——
      //      `removeInjectedSkills` 只删清单里记着的，所以这里即使传错也删不到
      //      使用者的东西。而这正是当初"跑完就删"危险的原因（删除依据在内存里，
      //      daemon 一崩就永久留残渣），那一半已经由清单解决了。
      try {
        // ★ 即使这次一个技能都没注入也要走一遍。
        //
        //   同步那一步**总会**写一份归属清单（哪怕内容是空的），所以只在
        //   "注入了东西"时才收尾，会在一个没挂技能的 run 之后留下一份空清单
        //   （`.claude/skills/.alpha-helper-managed.json`）——工作目录里于是
        //   多出一个不是产出的东西，正是这次改动要清掉的那类残留。
        const swept =
          runtime.descriptor.skills.kind === 'directory'
            ? await removeInjectedSkills(
                run.workDir!,
                runtime.descriptor.skills.dir,
                injectedSkills,
              )
            : { removed: [] as string[], kept: [] as string[] }
        if (swept.removed.length > 0) {
          await this.#note(
            runId,
            `已移除本次注入的 skill：${swept.removed.join('、')}` +
              `（工作目录里只留 agent 的产出；本次用了什么标准见上面的注入记录）`,
          )
        }
      } catch (err) {
        this.#deps.onWarn?.(`移除注入的技能失败：${String(err)}`)
      }
    }

    try {
      await store.transitionRun(runId, 'queued', 'dispatched', { dispatchedAt: this.#now() })

      // 环境预检放在注入之前：如果 CLI 连自己的状态目录都写不了，
      // 这次 run 的产出是不可信的，越早说越好（而清理注入物的开销也省下了）
      const envCheck = await checkEnvironment([{ descriptor: runtime.descriptor, available: true }])

      // ── 注入技能（按 agent 求解的**子集**，D22）──
      //
      // ★ 先问**这个 runtime 有没有技能发现机制**。
      //
      //   描述表允许声明 `{ kind: 'none' }`（见 `RuntimeDescriptor.skills`）。
      //   遇到它时我们**一个文件都不写**：写进一个"CLI 不读"的目录，等于把
      //   "这个 runtime 不支持技能"伪装成"技能已经到位了"——使用者会去查
      //   prompt、查 skill 内容，而问题根本不在那儿（FR-CLI-40 那一类）。
      //   所以这里改成**明说**。
      const skillDelivery = runtime.descriptor.skills
      const mountedSkills = req.skills ?? []
      const skillsBrief: SkillBrief[] = []

      if (skillDelivery.kind === 'none') {
        await this.#note(
          runId,
          (mountedSkills.length > 0
            ? `⚠️ 本次**没有**注入技能：这个 agent 挂了 ${mountedSkills.length} 个 skill` +
              `（${mountedSkills.map((s) => s.slug).join('、')}），`
            : '本次没有注入技能：') +
            `但 runtime \`${runtime.descriptor.key}\` 没有技能发现机制。` +
            `原因：${skillDelivery.reason}`,
        )
      } else {
        // ⚠️ 注入失败要让 run 失败——静默的缺能力比报错糟得多。
        //    同名撞上使用者自己的技能也会在这里抛（`SkillCollisionError`）：
        //    覆盖它等于改写使用者的文件，所以宁可这次 run 失败并说清楚。
        const skillSync = await syncInjectedSkills(
          run.workDir!,
          skillDelivery.dir,
          mountedSkills.map((skill) => ({
            slug: skill.slug,
            content: skill.body,
            // ★ 描述必须一起写进 frontmatter：CLI 自己的技能清单是描述驱动的，
            //   而我们的第一句话只列 slug——描述是唯一的用途信号。
            ...(skill.description ? { description: skill.description } : {}),
            // 支持文件也要一起写下去。只写 SKILL.md 的话，技能里引用的脚本/
            // 参考文档在运行时根本不存在——技能"装上了"却干不了活，而且
            // 从日志上看不出为什么（CLI 只会说找不到文件）。
            ...(skill.files && Object.keys(skill.files).length > 0 ? { files: skill.files } : {}),
          })),
        )
        injectedSkills = skillSync.written
        // 对账结果要进日志：被摘掉的技能消失了、以及规范化改了什么，
        // 都是使用者需要知道的事（FR-CLI-40：写下去了 ≠ 被读了，至少要看得见）
        if (skillSync.pruned.length > 0) {
          await this.#note(
            runId,
            `已从工作目录移除不再挂载的 skill：${skillSync.pruned.join('、')}`,
          )
        }
        for (const { slug, note } of skillSync.notes) {
          await this.#note(runId, `skill ${slug}：${note}`)
        }
      }

      // 技能清单（进上下文块/第一句话）与"写没写文件"无关：它是**平台能控制的
      // 那一份**清单，即使这个 runtime 不扫目录也要告诉模型"有哪些标准可用"。
      for (const skill of mountedSkills) {
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
      // ★ 把注入结果写进日志。
      //
      //   不写的话，使用者在日志里只看到 Claude 自己报的"25 个工具可用"，
      //   而那说的是**它的内置工具**——于是很自然会以为我们的 skill 没生效。
      //   事实是它生效了，只是**看不出来**。
      await this.#note(
        runId,
        mountedSkills.length === 0
          ? `本次没有注入任何 skill（该 agent 没挂 skill）——agent 将按它自己的默认行为工作`
          : skillDelivery.kind === 'directory'
            ? `已注入 ${mountedSkills.length} 个 skill：${mountedSkills.map((s) => s.slug).join('、')}` +
              `（写入 ${skillDelivery.dir}/，CLI 会自己扫这个目录）`
            : `⚠️ 挂了 ${mountedSkills.length} 个 skill 但**一个都没写下去**：` +
              `runtime \`${runtime.descriptor.key}\` 没有技能发现机制（原因见上一行）——` +
              `本次它们只作为「审核标准 / 参考」出现在上下文里`,
      )

      // ══════════════════════════════════════════════════════════════════
      // ── 组装「第一句话」，并留一份副本（D29）──
      // ══════════════════════════════════════════════════════════════════
      //
      // ★ 这是这次 run 交给 CLI 的**唯一**一段文本：身份、材料、技能清单、
      //   护栏、判决契约全在里面（顺序见 `first-sentence.ts` 的说明）。
      //
      //   以前是两处：stdin 上一句 + 写进使用者 `CLAUDE.md` 的受管块。那个
      //   设计让**硬契约**（判决 schema 与围栏）走在唯一没被验证过的通道上
      //   （FR-CLI-40 至今空着），还要为"写别人的文件"付出一整类风险
      //   （截断事故、逐字节还原、共享目录里摘掉别人正在用的块）。
      // ★ agent 的配置（模型 / 环境变量 / **指令**）在这里取一次。
      //
      //   取在这里而不是等下面拼命令行时再取，是因为「指令」现在要进第一句话
      //   ——而它此前**从来没被送达过**（`ExecOptions` 里没有这个通道）：
      //   界面上能填、能存、能显示，运行时被丢掉。
      const agentConfig = await this.#deps.store.getAgent(run.agentId as never)

      // ★ 第一句话的模版是**全局配置**（D32），挂在 workspace 上：一次设定，
      //   所有 agent 都按它来。空 = 平台默认。
      //
      //   store 不做 schema 迁移，加字段之前建的 workspace 读回来没有这两个键，
      //   所以在 `?? ''` 这一层补齐——**与界面上显示的那份走同一段代码**
      //   （`readFirstSentenceTemplates` 也这么读），否则"界面显示的"与
      //   "真的投递的"会分叉。
      const workspace = await this.#deps.store.getWorkspace(run.workspaceId)
      const templates = {
        executeTemplate: workspace?.executeTemplate ?? '',
        reviewTemplate: workspace?.reviewTemplate ?? '',
      }

      const firstSentence =
        req.kind === 'review' && req.review
          ? renderFirstSentence({
              kind: 'review',
              runId,
              subject: req.subject,
              report: { kind: req.review.kind, title: req.review.title, body: req.review.body },
              skills: skillsBrief,
              relatedIssueId: req.review.relatedIssueId ?? null,
              previousContextPath: await this.#previousContextPath(req),
              instructions: agentConfig?.instructions ?? null,
              // ★ 调用方给的指令必须送出去（重试那句解释也在这里）
              prompt: req.prompt,
              // 第一句话模版（D32）：**全局配置**，与是哪个 agent 无关。
              // 读的是 workspace 上那份（空 = 平台默认）；写入口已经校验过。
              template: templates.reviewTemplate,
            })
          : renderFirstSentence({
              kind: 'execute',
              runId,
              subject: req.subject,
              prompt: req.prompt,
              skills: skillsBrief,
              instructions: agentConfig?.instructions ?? null,
              template: templates.executeTemplate,
            })

      // 副本：**我们自己的文件**，谁都不覆盖谁，也不删。
      //   - agent 需要回顾时可以自己再读（上下文被压缩之后尤其有用，而这条
      //     不依赖任何未验证的 CLI 内部行为）；
      //   - 你随时能看"这次它被交代了什么"；
      //   - 路径进日志，所以它不是个隐藏文件。
      //
      // ⚠️ **不写 `CLAUDE.md`**（也不写别的 CLI 认识的项目记忆文件名）：
      //    那会让它重新变成"由 CLI 隐式读取"，等于又回到双投递与猜文件名。
      const contextPath = join(run.workDir!, '.alpha-helper', 'context', `${runId}.md`)
      await mkdir(dirname(contextPath), { recursive: true })
      await writeFile(contextPath, firstSentence, 'utf8')

      // ★ 全文进日志，**不截断**。
      //
      //   使用者投诉过「日志打印不完整，导致我不知道第一句话到底是什么」。
      //   这是那次 run 的输入本身——唯一不可变的事实；截断它等于把
      //   "它被交代了什么"变成要去别处拼的东西。
      // ★ 审计里的"输入哈希"要哈希**真正投递出去的那段文本**（就是这一段），
      //   而不是 `req.prompt`。改版前哈希的是 `req.prompt`——对审核 run 来说
      //   那甚至是**没被送出去**的那句指令，于是哈希与输入对不上，
      //   "可追溯"就成了空话。
      const deliveredHash = createHash('sha256').update(firstSentence, 'utf8').digest('hex')

      await this.#note(
        runId,
        `第一句话（stdin 的一行 stream-json user 消息，${firstSentence.length} 字符，` +
          `以下就是交给 CLI 的全部内容）：`,
      )
      await this.#note(runId, firstSentence)
      await this.#note(runId, `（同一份文本的副本：${contextPath}——需要回顾时可以再读）`)

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
      // ★ 会话是"接着上次说"还是"从头开始"，是理解产出的一等事实。
      //   原来只有**被拒/无法判断**时才有话，正常路径上完全看不出来。
      await this.#note(
        runId,
        `会话：${resume.sessionId ? `恢复 ${resume.sessionId}` : '全新开始'}——${resume.reason}`,
      )

      // ★ 命令行与 stderr 进日志（方便 debug）。
      //
      //   命令行的**脱敏**走 domain 的 `redactArgv` —— 与审计记录用的是
      //   同一份实现。适配器依赖不到 domain，所以由它上报事实、这里负责
      //   脱敏：安全逻辑只有一份，不会漂。
      let stderrLines = 0
      let stderrTruncated = 0
      // ══════════════════════════════════════════════════════════════════
      // ★ agent 的**模型**与**环境变量**：在这里解析，不在各个调用点传
      // ══════════════════════════════════════════════════════════════════
      //
      // 这两个值原来被写死成 `model: null` 与 `env: {}`。而 agent 上明明有
      // 这两个字段，界面上「模型」还是可填的（AgentDetail）：
      //
      //   - 使用者填了模型 → 存进库 → 界面上显示出它 → **执行时被丢掉**，
      //     CLI 永远用它自己的默认模型。填 `claude-opus-4` 跑的还是默认那个，
      //     而且**不会报错**；
      //   - `argv.ts` 里 `--model` 的拼装、后端里的透传**全都实现好了**，
      //     只差这里把值取出来。
      //
      // 解析放在执行器里而不是各调用点，理由与工作目录同源（见 `submit` 里
      // 那段）：提交 run 的路径有五条（页面建任务、动作派生、自动串接审核、
      // 重试、报告摄取），任意一处忘了带就会被静默丢掉——**而这正是已经发生的事**。
      const session = await runtime.backend.execute({
        // ★ 发的是**组装好的第一句话**，不是原始的 req.prompt：身份、材料、
        //   技能清单、护栏、判决契约都在里面（见 `first-sentence.ts`）。
        prompt: firstSentence,
        workDir: run.workDir!,
        // 使用者在这个 agent 上选的模型。留空 = 用 CLI 自己的默认（CLI 支持
        // "不给这个参数"这个语义，所以 null 是**如实**表达，不是兜底）
        model: agentConfig?.model ?? null,
        maxTurns: req.limits.maxTurns,
        resumeSessionId: resume.sessionId,
        // agent 的自定义环境变量。后端是 `{...process.env, ...opts.env}`，
        // **合并**而不是替换——所以给 `{}` 与不给都不影响 CLI 拿到 PATH
        env: agentConfig?.env ?? {},
        onCommandLine: ({ argv, sandboxDescription }) => {
          actualArgv = argv
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

      // ★ 用量与成本进日志。
      //
      //   界面里有，但"这次花了多少"是要和产出一起被回看的——日志是那条时间线。
      //   CLI 不报告时说一句"没有报告"，因为**空着与没报告不是一回事**：
      //   前者让人以为是平台没记，后者是上游就没给。
      await this.#note(
        runId,
        result.usage
          ? `用量：输入 ${result.usage.inputTokens} / 输出 ${result.usage.outputTokens} token，` +
              `成本 $${(result.usage.costUsdMicros / 1_000_000).toFixed(4)}` +
              `（${result.usage.costSource === 'provider' ? 'CLI 上报' : '本地估算'}）`
          : '用量：CLI 没有报告（界面上的用量会是空的，那不是平台漏记）',
      )

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
        await this.#handleReview(
          req,
          run,
          result.output || collected,
          result.usage,
          runtime.descriptor,
          // ★ 审计要记 CLI **实际报告**的模型。传 null 也比传"我们请求的那个"诚实：
          //   请求值只说明意图，而审计回答的是"这次到底用了什么"。
          result.model ?? null,
          await this.#cliVersion(runtime.descriptor, runtime.backend),
          // 实际跑的那条命令行（含沙箱包装）——不再是"按描述表拼出来的大概样子"
          actualArgv,
          deliveredHash,
        )
      }

      // ★ 先清理自己的痕迹，**再**去串接审核。
      //
      //   反过来（先串接、后清理）会开一个真实的窗口：审核 run 是**并发**开始的
      //   （`submit` 受理后立刻跑，不等人），它会把同一个目录里的上下文块换成
      //   自己那份——而这时执行 run 才走到清理，就可能把审核的块摘掉。
      //   顺序调过来之后，审核 run 拿到的是一间已经收拾干净的工作目录。
      await cleanup()

      // ★ S1：执行完成后自动接一次审核（可选）
      let chainedRunId: RunId | null = null
      if (req.kind === 'execute' && result.status === 'completed') {
        try {
          // 串接的**结果**（包括"没串上"和原因）都进日志：否则"这次为什么
          // 没有审核"在日志里查不到，只能去界面上猜。
          const chained = await this.#deps.autoChainReview?.({
            executeRun: run,
            executorAgentId: req.agentRef.id,
            output: result.output || collected,
          })
          if (chained) {
            chainedRunId = chained.runId
            await this.#note(runId, chained.note)
          }
        } catch (err) {
          // 串接失败不能让执行本身变成失败——但必须可见
          this.#deps.onWarn?.(`自动审核串接失败：${String(err)}`)
        }
      }

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
        // ⚠️ 这里原来传的是 `null`：**原因码没被写下去**，于是
        //    `cancelled_by_user` 这个枚举成员在生产代码里从来没有出现过，
        //    而紧挨着的注释却写着"原因 `cancelled_by_user`"——注释与实现对不上。
        //    状态 `cancelled` 已经表达了大部分意思，但原因码是给程序看的
        //    （分级、统计），空着等于让下游去猜。
        await this.#finish(runId, 'cancelled', null, {
          reason: 'cancelled_by_user',
          message: '使用者取消了这次执行',
        })
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
      // ⚠️ 这里原来**一律**记 `infra_error`。而"注入失败"（同名技能撞车、
      //    技能超过大小上限）是**使用者自己就能修好**的问题：改个目录名、
    //    换个小点的技能。把它记成"环境/基础设施问题"，会把人往查 CLI 与
      //    权限的方向带——`injection_failed` 这个枚举成员因此从没被写过。
      const isInjection =
        err instanceof SkillCollisionError || err instanceof SkillTooLargeError
      await this.#finish(runId, 'failed', null, {
        reason: isInjection ? 'injection_failed' : 'infra_error',
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
    /** CLI 自己报告的模型标识；它不报告时为 null。 */
    modelId: string | null,
    /** 探测到的 CLI 版本；读不到时为 null（**不要**拿"我们期望的版本"顶替）。 */
    cliVersion: string | null,
    /** 实际执行的命令行（原始，脱敏由 domain 的 `buildAuditRecord` 做）。 */
    argv: readonly string[],
    /** 投递出去的「第一句话」的 sha256——审计里的 `promptHash`。 */
    deliveredHash: string,
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
      // ★ 审计里的"模型"要记 **CLI 自己报告的那个**，而不是我们请求的那个。
      //   这里原来是写死的 `null`——于是"判决固化了模型标识"（FR-REVIEW-06）
      //   在数据上一直是空的。CLI 不报告时仍是 null：**宁可空着，也不要
      //   拿请求值去顶替**，那会让审计看起来比事实更确定。
      modelId,
      // 哈希的是**投递出去的那段文本**（由调用方传进来），不是 `req.prompt`
      promptHash: deliveredHash,
      // ══════════════════════════════════════════════════════════════════
      // 审计的这四项原来是**写死的**（`runtimeDescriptorKey: 'claude'`、
      // `cliVersion: null`、argv 是按描述表拼的。`contextBlockHash` 曾恒为 null——那个
      // 字段随受管块机制一起删掉了：输入只剩一处，哈希也就只剩一个）
      // ══════════════════════════════════════════════════════════════════
      //
      // 审计回答的是"这次到底怎么跑的"。写死的值不是"空着"，而是**说错了**：
      // 换成任何一个别的 runtime，审计都会声称用的是 claude——而审计是最不
      // 该出错的地方（它是事后唯一的依据）。
      runtimeDescriptorKey: descriptor.key,
      cliVersion,
      argv,
      usage,
      chainSteps,
    })

    // ★ 判决与审计进日志。
    //
    //   在此之前，审完之后日志里**什么都没有**：结论、理由码、动作、是否降级、
    //   审计记录的存在——全都要去界面上另找。而日志是那条时间线，
    //   "它最后判了什么"是这条时间线的终点。
    await this.#note(run.id, `判决：${describeDecision(handling)}`)
    await this.#note(
      run.id,
      `审计：已记录（id ${handling.audit.id}，runtime ${handling.audit.runtimeDescriptorKey}，` +
        `CLI 版本 ${handling.audit.cliVersion ?? '读不到'}，` +
        `输入哈希 ${shortHash(handling.audit.promptHash)}）`,
    )

    if (handling.decision.kind === 'retry') {
      this.#invalidAttempts.set(subjectKey, invalidAttempts + 1)
    } else {
      this.#invalidAttempts.delete(subjectKey)
    }
  }

  /**
   * 「接着沟通」时给一行上一次的上下文副本路径。
   *
   * ★ 会话恢复是**尽力而为**：CLI 可能拒绝（换版本、会话过期），代码里明确
   *   处理过那种情况并会记"恢复被拒、本次没有上文"。而那时 agent 手里就只剩
   *   这句追问——原任务正文既不在 prompt 里也不再别处。给一行路径，它至少能
   *   自己把那次的上下文读回来。
   */
  async #previousContextPath(req: SubmitRunRequest): Promise<string | null> {
    if (!req.resumeFromRunId) return null
    const previous = await this.#deps.store.getRun(req.resumeFromRunId as RunId)
    if (!previous?.workDir) return null
    return join(previous.workDir, '.alpha-helper', 'context', `${previous.id}.md`)
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
