import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  checkVersionSupport,
  shouldRefuseToRun,
  type AgentBackend,
  type SandboxMode,
} from '@alpha-helper/agent-core'
import {
  DEFAULT_MAX_CHAIN_DEPTH,
  aggregateCost,
  depthFromChain,
  exportAudit,
  type Store,
} from '@alpha-helper/domain'
import {
  LOCAL_PROTOCOL_VERSION,
  Capability,
  parseVerdict,
  ulid,
  type Agent,
  type Issue,
  type BlobRef,
  type Report,
  type Run,
  type RunId,
  type RunMessage,
  type Skill,
  type SubmitRunRequest,
  type Workspace,
} from '@alpha-helper/protocol'
import { FileStore } from '@alpha-helper/store-file'
import { NOT_BUILT_HINT, isWebBuilt, loadStatic } from '@alpha-helper/web'
import { ActionRunner, type DeriveRunRequest } from './actions.ts'
import { RunExecutor } from './executor.ts'
import {
  ReportIngestor,
  ThirdPartyItemSchema,
  unmatchedReportNotice,
  type ThirdPartyItem,
} from './ingest.ts'
import { reconcileInterruptedRuns } from './reconcile.ts'
import { checkEnvironment, renderEnvironmentReport } from './environment.ts'
import { defaultWorkRoot } from './workdir.ts'
import { ReviewCoordinator } from './review.ts'
import { RunRegistry, replayMessagesSince } from './registry.ts'
import { createRuntimeBackend, knownRuntimeAdapters } from './runtime-registry.ts'
import { Semaphore } from './semaphore.ts'
import { WorkDirLocks } from './workdir-locks.ts'

/**
 * 本地 daemon 服务。
 *
 * ══════════════════════════════════════════════════════════════════
 * 安全模型：同源之后只剩两条必需项（design §14.2）
 * ══════════════════════════════════════════════════════════════════
 *
 * 因为 Web UI **由本进程托管**，页面与接口同源，所以：
 *
 *   ✗ 不需要 Origin 白名单 —— 同源策略已在浏览器侧生效
 *   ✗ 不需要一次性令牌   —— 没有跨源入口
 *   ✗ 不需要约定握手     —— 页面本来就是从这个端口加载的
 *   ✓ **只绑回环地址**   —— 杜绝局域网内其他机器访问
 *   ✓ **校验 Host 头**   —— 防 DNS rebinding
 *
 * 最后一条是同源架构下剩下的主要威胁：攻击者可以让一个域名解析到
 * 127.0.0.1，但**无法伪造 Host 头**。
 */

/** 请求体上限（FR-BRIDGE-16）。 */
const MAX_BODY_BYTES = 8 * 1024 * 1024

export interface DaemonOptions {
  dataDir: string
  port: number
  fsync?: boolean
  /** 覆盖可执行文件路径（测试用）。 */
  executablePath?: string
  /**
   * 选哪个 runtime 跑任务（FR-CLI-47）。
   *
   * ★ 加这一项的直接后果：daemon 从"只能跑 claude"变成"能跑表里的任何一个"。
   *   刻意**不做静默回退**——写错 key 就报错并列出可用的。回退到 claude 会让
   *   一次配置错误表现成"能跑，只是行为不对"，那种错最难查。
   *
   * 缺省 claude：agent 记录里的 `runtimeKey` 首版全部播种为 claude。
   * 按 agent 选 runtime 是后续步骤；本项先让第二个 runtime **真的能被跑起来**。
   */
  runtimeKey?: string
  /**
   * 注入一个后端实现。
   *
   * ★ 存在的理由是 **NFR-T-01**：单元测试与常规 CI **绝不能调用使用者真实
   *   安装的 agent CLI**——那会消耗真实额度，还可能让 agent 改动文件。
   *   所以测试用假后端，真后端只在真实运行时构造。
   */
  backend?: AgentBackend
  maxConcurrentRuns?: number
  /**
   * 自动分配的工作目录根（D27）。缺省为数据目录同级的 `work/`。
   */
  workRoot?: string
  /**
   * 可选沙箱（M4）。缺省 `'none'`——见 `docs/design.md` §14.1 与 NG7：
   * 首版 run 以 daemon 用户的完整权限执行，这一点必须如实披露。
   *
   * ⚠️ 开启后如果平台上拿不到沙箱工具，daemon **会在起 run 时报错**，
   *    而不是静默降级——静默降级会让人在以为自己被保护着的情况下裸奔。
   */
  sandboxMode?: SandboxMode
  onWarn?: (message: string) => void
  onInfo?: (message: string) => void
}

export interface DaemonHandle {
  url: string
  port: number
  store: Store
  close(): Promise<void>
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体超过上限')
    chunks.push(buf)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export async function startDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  const warn = options.onWarn ?? ((m: string) => console.warn(`[warn] ${m}`))
  const info = options.onInfo ?? ((m: string) => console.log(m))

  const store = await FileStore.open({ dataDir: options.dataDir, fsync: options.fsync ?? true })

  // ★ runtime 的选择从"写死 claude"变成"查装配表"（FR-CLI-47）。
  //   表里有几个 runtime，这里就能跑几个——本文件不再认识任何具体 CLI。
  const runtimeKey = options.runtimeKey ?? 'claude'
  const selected = createRuntimeBackend(runtimeKey, {
    ...(options.executablePath ? { executablePath: options.executablePath } : {}),
    onWarn: warn,
  })
  const descriptor = selected.descriptor
  const backend = options.backend ?? selected.backend

  // 工作目录的根（D27）：每个任务自动分配一个独立目录。
  // 默认放在数据目录的**同级**——数据目录装应用状态（日志/blob/锁），
  // 工作目录装 agent 的产出，混在一起会让人找东西时先撞上一堆 logs/。
  const workRoot = options.workRoot ?? defaultWorkRoot(options.dataDir)

  const registry = new RunRegistry()
  const locks = new WorkDirLocks()
  const semaphore = new Semaphore(options.maxConcurrentRuns ?? 20)

  const actionRunner = new ActionRunner({
    store,
    deriveRun: (req) => deriveRunFromAction(req),
  })
  const reviewCoordinator = new ReviewCoordinator({
    store,
    actions: actionRunner,
    createRetryRun: (run) => createRetryRun(run),
  })

  const executor = new RunExecutor({
    store,
    workRoot,
    registry,
    backend,
    descriptor,
    semaphore,
    locks,
    reviewCoordinator,
    autoChainReview,
    ...(options.sandboxMode && options.sandboxMode !== 'none'
      ? { sandbox: { mode: options.sandboxMode } }
      : {}),
    onWarn: warn,
  })

  /**
   * S1 的自动串接：执行完成后找一个**不同的** agent 来审。
   *
   * 两条约束在这里落地：
   *   - **reviewer ≠ executor**（INV-1~3）：找审核者时直接排除执行者；
   *   - **回路边界**（INV-14）：链路深度超限就不再派生，避免
   *     "改 → 审 → 再改 → 再审" 无限循环烧 token。
   */
  async function autoChainReview(input: {
    executeRun: Run
    executorAgentId: string
    output: string
  }): Promise<RunId | null> {
    const agents = await store.listAgents(workspaceId)
    const executor = agents.find((a) => (a.id as string) === input.executorAgentId)
    if (!executor?.autoReview) return null

    const others = agents.filter((a) => (a.id as string) !== input.executorAgentId)
    const reviewer = others.find((a) => a.isFallbackReviewer) ?? others[0]
    if (!reviewer) {
      warn('没有可用于审核的其他 agent（INV-1 要求审核者不同于执行者），跳过自动审核')
      return null
    }

    const depth = input.executeRun.chainDepth + 1
    if (depth > DEFAULT_MAX_CHAIN_DEPTH) {
      await store.appendInboxItem({
        id: ulid(),
        workspaceId,
        type: 'chain.depth_exceeded',
        severity: 'attention',
        title: '链路深度超限，已停止自动审核',
        body: `这条链路已经连续派生 ${depth} 次，超过上限 ${DEFAULT_MAX_CHAIN_DEPTH}。停止继续派生，避免无限循环。`,
        issueId: issueIdOfSubject(input.executeRun),
        runId: input.executeRun.id,
        read: false,
        createdAt: Date.now(),
      })
      return null
    }

    return createRunForReviewer({
      reviewer,
      kind: 'run-output',
      title: `审核执行产出（run ${input.executeRun.id.slice(-8)}）`,
      body: input.output.slice(0, 20_000),
      subject: { type: 'run', id: input.executeRun.id },
      chainDepth: depth,
      // ★ 把 issue 交给模型：判决里的动作参数需要它
      relatedIssueId: issueIdOfSubject(input.executeRun),
      prompt: '请审核上面这次执行的产出，并按审核标准给出判决。',
    })
  }

  const ingestor = new ReportIngestor({ store })
  // 探测一次当前 runtime，用于环境预检（不重复探测别的 runtime——
  // 没装的 CLI 谈不上"它家目录写不进去"）
  const probe2 = await backend.probe()

  const workspaceId = await bootstrap(store, info)

  // ★ Web UI 的构建产物不进版本库（gitignore），所以 clone 下来直接起 daemon
  //   会**没有界面**。这种情况必须说清楚怎么做，而不是发一个空白页让人以为
  //   是 daemon 坏了。只提示、不阻止启动——API 与 CLI 仍然完全可用。
  if (!(await isWebBuilt())) {
    warn(NOT_BUILT_HINT)
  }

  // ★ 环境预检：CLI 自己的状态目录能不能写。
  //
  //   实测踩到过：agent 的工具输出里冒出 `EPERM ... mkdir '/Users/x/.claude/
  //   session-env/<uuid>'`，而那个路径**不是工作目录**。它长得像"工作目录
  //   没建成功"，于是排查会从工作目录开始——那里根本没问题。
  //
  //   而且**越是按推荐做法部署（容器 / 专用用户 / 沙箱）越容易撞上它**，
  //   所以在启动时就说清楚，比让使用者在 agent 输出里猜便宜得多。
  const envReport = await checkEnvironment(
    Object.entries(knownRuntimeAdapters()).map(([key, adapter]) => ({
      descriptor: adapter.descriptor,
      available: key === descriptor.key ? probe2.available : false,
    })),
  )
  if (!envReport.ok) {
    warn(renderEnvironmentReport(envReport))
  }

  // ══════════════════════════════════════════════════════════════════
  // ★ 先收口上次遗留的 run，**再**起 HTTP 服务（FR-RUNTIME-11）
  // ══════════════════════════════════════════════════════════════════
  //
  // 顺序不能反：run 的状态是持久化的，所以上次退出时还在跑的 run 会留在
  // `running` 这类非终态上。若先起服务，页面立刻就能读到那些陈旧状态并
  // 显示成"进行中"——而它们永远不会再有结果。
  //
  // 收口**只能标记失败**，不能续跑：执行所需的 prompt / 技能正文 / 限额
  // 是随 HTTP 请求来的，没有落盘（`Run` 实体里只有 `skillRefs` 这类引用）。
  // 假装能续跑会跑出一个内容不对的东西，而且看起来一切正常——比明确失败糟得多。
  try {
    const reconciled = await reconcileInterruptedRuns({ store })
    if (reconciled.interrupted.length > 0) {
      warn(
        `上次退出时有 ${reconciled.interrupted.length} 个 run 没结束，` +
          `已标记为中断（daemon_restarted）。它们无法续跑——执行所需的信息没有落盘。`,
      )
    }
  } catch (err) {
    // 收口失败不该阻止 daemon 启动，但必须可见：留着会导致"永远在途"的假象
    warn(`收口遗留 run 失败（可能留下显示为"进行中"的陈旧记录）：${String(err)}`)
  }

  /** 起一个 review run（report 与 run 产出两条来源共用）。 */
  async function createRunForReviewer(input: {
    reviewer: Agent
    kind: string
    title: string
    body: string
    subject: SubmitRunRequest['subject']
    prompt: string
    chainDepth: number
    inputBlobRef?: BlobRef | null
    relatedIssueId?: string | null
  }): Promise<RunId | null> {
    const { reviewer } = input
    // ★ 技能按 agent 求解（不是全局挂一遍，D22）
    const skills = await loadAgentSkills(store, reviewer)
    if (skills.length === 0) {
      warn(`agent ${reviewer.name} 没有挂载任何 skill，无法审核`)
      return null
    }

    const runId = ulid() as RunId
    const outcome = await executor.submit({
      runId,
      kind: 'review',
      agentRef: { id: reviewer.id, name: reviewer.name, instructions: reviewer.instructions },
      skills: skills.map((s) => ({
        ref: { id: s.id, slug: s.slug, source: s.source },
        slug: s.slug,
        name: s.name,
        body: s.body,
        allowedActions: s.allowedActions,
        files: {},
      })),
      subject: input.subject,
      prompt: input.prompt,
      agentDefaultWorkDir: reviewer.workDir ?? undefined,
      limits: { maxTurns: null, timeoutMs: null },
      chainDepth: input.chainDepth,
      review: {
        kind: input.kind,
        title: input.title,
        body: input.body,
        inputBlobRef: input.inputBlobRef ?? null,
        relatedIssueId: input.relatedIssueId ?? null,
      },
    })

    return outcome.kind === 'accepted' ? runId : null
  }

  /** 为一个 report + reviewer 起一个 review run。 */
  async function createReviewRun(report: Report, reviewer: Agent): Promise<RunId | null> {
    return createRunForReviewer({
      reviewer,
      kind: report.kind,
      title: report.title,
      body: report.body,
      subject: { type: 'report', id: report.id },
      prompt: `审核这条 ${report.kind} 类型的报告：${report.title}`,
      chainDepth: 0,
      inputBlobRef: report.blobRef,
    })
  }

  /**
   * ★ 判决不合规时的重试（FR-CLI-06 的落点）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 这曾经是**第二个占位**——和动作派生那一处同源
   * ══════════════════════════════════════════════════════════════════
   *
   * `ReviewCoordinator` 一直支持 `createRetryRun`，但服务端从来没提供它。
   * 于是 `retry` 这条判决路径**永远走到"拿不到重试机会 ⇒ 降级"**那个分支：
   * 表面上"重试了"，实际上每次都是直接降级为建议。
   *
   * 这与动作派生那个占位是同一类问题：**代码看起来支持，行为上从不发生**。
   * 而它恰好掩盖了 FR-CLI-06（会话恢复）——因为恢复只发生在重试时。
   *
   * ══════════════════════════════════════════════════════════════════
   * 两条约束
   * ══════════════════════════════════════════════════════════════════
   *
   * **① 重试是**_RESUME_**，不是重跑。** 通过 `resumeFromRunId` 指向上一次，
   *   执行器会去取它的 sessionId 并**按 sessionState 决定是否真的恢复**。
   *   不恢复时 agent 是在没有上文的情况下重新开始——那和"重试"的语义不同，
   *   所以执行器会把它显式说出来，而不是假装恢复成功了。
   *
   * **② 必须真的尝试新的会话。** 上一次留了 sessionId 就用它；没留
   *   （比如失败得很早）就当新会话跑。重试的价值在于"换一次机会"，
   *   而不在于"必须有上文"。
   */
  async function createRetryRun(previous: Run): Promise<string | null> {
    // 重试的审核者是谁？——同一次审核的重试，应当由**同一个审核者**做。
    // 换人会引入"不同标准"这个额外变量，让"重试有没有变好"变成无法解释的问题。
    const agent = await store.getAgent(previous.agentId)
    if (!agent) {
      warn(`无法为重试找到 agent ${previous.agentId}`)
      return null
    }

    const skills = await loadAgentSkills(store, agent)
    if (skills.length === 0) {
      warn(`agent ${agent.name} 没有挂载任何 skill，无法重试`)
      return null
    }

    const runId = ulid() as RunId
    // 重试的 prompt 与上次相同——变的是"再给一次机会"，不是任务本身。
    // 上一次的输出会作为审核对象的正文带进来（subject 不变）。
    const outcome = await executor.submit({
      runId,
      kind: 'review',
      agentRef: { id: agent.id, name: agent.name, instructions: agent.instructions },
      skills: skills.map((s) => ({
        ref: { id: s.id, slug: s.slug, source: s.source },
        slug: s.slug,
        name: s.name,
        body: s.body,
        allowedActions: s.allowedActions,
        files: {},
      })),
      subject: previous.subject,
      prompt:
        `上一次你的输出没能通过格式校验。请**重新**给出判决，` +
        `严格按审核标准里的围栏格式输出，不要添加围栏之外的判决内容。`,
      // 重试沿用上一次的目录：D27 下目录按**任务**分，重试本来就该在原地继续
      workDir: previous.workDir ?? undefined,
      limits: { maxTurns: null, timeoutMs: null },
      chainDepth: previous.chainDepth,
      // ★ 会话恢复：指向上一次，由执行器按 sessionState 决定要不要真的用
      resumeFromRunId: previous.id,
      review: {
        kind: typeof previous.subject === 'object' ? 'run-output' : 'run-output',
        title: `重试审核（原 run ${previous.id.slice(-8)}）`,
        body: '',
        inputBlobRef: null,
        relatedIssueId: issueIdOfSubject(previous),
      },
    })

    if (outcome.kind !== 'accepted') {
      warn(`重试 run 未被受理：${outcome.kind}`)
      return null
    }
    info(`判决不合规，已派生重试 run：${runId}`)
    return runId
  }

  /**
   * ★ 动作派生 run 的真实实现（M2 闭环，INV-16）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 早先这里是一个占位字符串
   * ══════════════════════════════════════════════════════════════════
   *
   * 旧实现返回 `pending:<issueId>:<agentId>`。它看起来像"派生成功"，
   * 实际上没有 run 被创建——于是**环检测端到端从未被真正走到过**，
   * 因为环需要真的有一条链路才存在。
   *
   * ══════════════════════════════════════════════════════════════════
   * 两条在这里落地的约束
   * ══════════════════════════════════════════════════════════════════
   *
   * **① `derivedFrom` 必须写上。** 它是重建链路唯一的边；漏写的话下一次
   *    环检测就看不到这一步，"派生"会变成一条单向遗忘。
   *
   * **② `chainDepth` 从真实链路推出来，而不是 `父 + 1`。**
   *    两者在正常数据下相等，但真实链路还带着"环"这个信息——
   *    一旦有人手改过数据，只有链路上算出来的深度是可信的。
   *
   * 返回 `null` 是**正常的**：agent 不存在、没有挂载技能都会走到这里。
   * 调用方会把 `spawnedRunId: null` 如实记录，而不是编一个 id。
   */
  async function deriveRunFromAction(req: DeriveRunRequest): Promise<string | null> {
    const issueId = req.params['issueId']
    const agentId = req.params['agentId']
    if (typeof issueId !== 'string' || typeof agentId !== 'string') {
      warn(`动作派生的参数不完整：${JSON.stringify(req.params)}`)
      return null
    }

    const agent = await store.getAgent(agentId as Agent['id'])
    if (!agent) {
      warn(`动作要指派的 agent 不存在：${agentId}`)
      return null
    }

    const skills = await loadAgentSkills(store, agent)
    if (skills.length === 0) {
      warn(`agent ${agent.name} 没有挂载任何 skill，无法执行派生出的 run`)
      return null
    }

    const issue = await store.getIssue(issueId as Issue['id'])
    if (!issue) {
      warn(`动作要指派的 issue 不存在：${issueId}`)
      return null
    }

    const runId = ulid() as RunId
    const outcome = await executor.submit({
      runId,
      kind: 'execute',
      agentRef: { id: agent.id, name: agent.name, instructions: agent.instructions },
      skills: skills.map((s) => ({
        ref: { id: s.id, slug: s.slug, source: s.source },
        slug: s.slug,
        name: s.name,
        body: s.body,
        allowedActions: s.allowedActions,
        files: {},
      })),
      subject: { type: 'issue', id: issue.id },
      prompt:
        `你被指派处理 issue「${issue.title}」。\n\n` +
        `${issue.description || '（没有更多描述）'}\n\n` +
        `这条任务是由一次审核判决派生出来的，请完成它。`,
      agentDefaultWorkDir: agent.workDir ?? undefined,
      limits: { maxTurns: null, timeoutMs: null },
      // ★ 链路：这一环来自那个动作
      chainDepth: depthFromChain(req.chainSteps) + 1,
      derivedFrom: req.fromActionId,
    })

    if (outcome.kind !== 'accepted') {
      warn(`动作派生的 run 未被受理：${outcome.kind}`)
      return null
    }
    info(`动作派生出一条新 run：${runId}（agent ${agent.name} ← issue ${issue.title}）`)
    return runId
  }

  // ── Host 校验：防 DNS rebinding ──
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      warn(`请求处理失败：${String(err)}`)
      if (!res.headersSent) sendJson(res, 500, { error: String(err) })
      else res.end()
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const host = req.headers.host ?? ''

    // 只有本机来源可用。攻击者能让域名解析到 127.0.0.1，但改不了 Host。
    if (!isAllowedHost(host, server.address() as AddressInfo | null)) {
      sendJson(res, 403, {
        error: `拒绝访问：Host 头 ${JSON.stringify(host)} 不在允许列表内（只接受回环地址）`,
      })
      return
    }

    const path = url.pathname

    // ── 静态资源（UI）──
    if (req.method === 'GET' && !path.startsWith('/api/') && path !== '/health') {
      const asset = await loadStatic(path)
      if (asset) {
        res.writeHead(200, {
          'content-type': asset.contentType,
          'content-length': asset.body.length,
          // 同源页面，不需要放宽任何跨源策略
          'x-content-type-options': 'nosniff',
        })
        res.end(asset.body)
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('未找到')
      return
    }

    // ── GET /health ──
    if (req.method === 'GET' && path === '/health') {
      sendJson(res, 200, { status: 'ok' })
      return
    }

    // ── GET /api/identity ──
    if (req.method === 'GET' && path === '/api/identity') {
      const device = await store.getDevice()
      const probe = await backend.probe()

      // ★ runtimes 数组从"只有当前那一个"改成**枚举装配表里的全部**。
      //
      //   原先只报当前 runtime，于是"平台支持哪些 CLI"这件事在接口上
      //   根本看不出来——第二个适配器插上了也没人知道。现在每一项都带
      //   `evidence`：`provisional` 的条目在 UI 上应当被标注为未验证，
      //   否则使用者会以为它和 claude 一样可信（见 RuntimeDescriptor 的注释）。
      const adapterEntries = Object.entries(knownRuntimeAdapters())
      const runtimes = await Promise.all(
        adapterEntries.map(async ([key, adapter]) => {
          const isCurrent = key === descriptor.key
          const live = isCurrent
            ? { available: probe.available, cliVersion: probe.cliVersion }
            : await adapter.create({ onWarn: warn }).probe()

          const desc = isCurrent ? descriptor : adapter.descriptor

          // ★ 版本支持判定（FR-CLI-07）必须出现在身份接口里。
          //
          //   "我们验过哪些 CLI 版本"是个会影响信任的事实：一个未声明的
          //   runtime 和一个已实测的 runtime，使用者对它们的预期完全不同。
          //   把它藏在日志里等于没说——身份接口正是页面展示能力的地方。
          const support = checkVersionSupport(desc, live.cliVersion)

          return {
            key,
            command: desc.command,
            available: live.available,
            cliVersion: live.cliVersion,
            evidence: desc.evidence,
            // 会话状态：`unknown` 必须与 `stateless` 区分开，
            // 因为前者要人去核对真实 CLI，后者什么都不用做。
            sessionState: desc.sessionState,
            versionSupport: {
              status: support.status,
              range: desc.versions?.range ?? null,
              verifiedWith: support.verifiedWith,
              refusalWouldApply: shouldRefuseToRun(support),
              message: support.message,
            },
          }
        }),
      )

      // 环境问题也要进身份接口：界面据此在智能体页给出提示，
      // 而不是等使用者从 agent 输出里读一句 EPERM
      const env = await checkEnvironment([
        { descriptor, available: probe.available },
      ])

      sendJson(res, 200, {
        environment: { ok: env.ok, issues: env.issues },
        protocolVersion: LOCAL_PROTOCOL_VERSION,
        deviceId: device?.id ?? 'unknown',
        deviceName: device?.name ?? 'unknown',
        runtimes,
        capabilities: [Capability.SseResume, Capability.Artifacts],
      })
      return
    }

    // ── agents / issues（M0 看板需要的最小 CRUD）──
    if (req.method === 'GET' && path === '/api/agents') {
      sendJson(res, 200, { agents: await store.listAgents(workspaceId) })
      return
    }
    // ── 新建 / 更新 agent ──
    //
    // ══════════════════════════════════════════════════════════════════
    // 这里需要校验，而**不是**"缺什么给个默认值"
    // ══════════════════════════════════════════════════════════════════
    //
    // 原来每个字段都 `?? 默认值`。对 `instructions` 这类"空着也行"的字段
    // 没问题，但对 `name` 不行：它会造出一个叫"新 agent"的家伙，而使用者
    // 明明填了名字——只是字段名写错了。**静默兜底会把一个拼写错误变成一条
    // 脏数据**，而且看起来像成功了。
    //
    // 另外 `skillIds` 与 `kindPatterns` 必须校验**元素类型**：它们是数组，
    // 但客户端完全可能传 `[""]` 或 `[123]`，那会让后续的技能求解与 kind 路由
    // 在很远的地方以莫名其妙的方式失败。
    if (req.method === 'POST' && path === '/api/agents') {
      const body = (await readJsonBody(req)) as Record<string, unknown>

      const name = typeof body['name'] === 'string' ? body['name'].trim() : ''
      if (name === '') {
        sendJson(res, 400, { error: 'agent 需要 name（非空字符串）' })
        return
      }
      if (name.length > 100) {
        sendJson(res, 400, { error: 'name 太长了（上限 100 字符）' })
        return
      }

      const stringArray = (key: string): string[] | { error: string } => {
        const raw = body[key]
        if (raw === undefined || raw === null) return []
        if (!Array.isArray(raw)) return { error: `${key} 必须是数组` }
        const bad = raw.find((v) => typeof v !== 'string' || v.trim() === '')
        if (bad !== undefined) {
          return { error: `${key} 里每一项都必须是非空字符串（收到 ${JSON.stringify(bad)}）` }
        }
        return (raw as string[]).map((v) => v.trim())
      }

      const skillIds = stringArray('skillIds')
      if (!Array.isArray(skillIds)) {
        sendJson(res, 400, { error: skillIds.error })
        return
      }
      const kindPatterns = stringArray('kindPatterns')
      if (!Array.isArray(kindPatterns)) {
        sendJson(res, 400, { error: kindPatterns.error })
        return
      }

      // 挂载的 skill 必须真的存在——写了不存在的 id 会让审核在运行时
      // 才失败，而那时错误信息指向的是"没有 skill"，不是"你填错了 id"
      const existing = await store.listSkills(workspaceId)
      const knownSkills = new Set(existing.map((s) => s.id as string))
      const unknownSkill = skillIds.find((id) => !knownSkills.has(id))
      if (unknownSkill !== undefined) {
        sendJson(res, 400, {
          error: `skill 不存在：${unknownSkill}。可用的：${
            existing.map((s) => s.slug).join(', ') || '（还没有 skill）'
          }`,
        })
        return
      }

      const maxConcurrentRuns = body['maxConcurrentRuns']
      if (
        maxConcurrentRuns !== undefined &&
        (!Number.isInteger(maxConcurrentRuns) || (maxConcurrentRuns as number) < 1)
      ) {
        sendJson(res, 400, { error: 'maxConcurrentRuns 必须是正整数' })
        return
      }

      const now = Date.now()
      const agent: Agent = {
        id: ulid() as Agent['id'],
        workspaceId,
        name,
        instructions: typeof body['instructions'] === 'string' ? body['instructions'] : '',
        model: typeof body['model'] === 'string' && body['model'] !== '' ? body['model'] : null,
        // runtime 用**当前 daemon 装的那个**，而不是让客户端指定：
        // 指定一个没装的 runtime 只会让 run 起不来，而错误发生在很远的地方
        runtimeKey: descriptor.key,
        workDir:
          typeof body['workDir'] === 'string' && body['workDir'].trim() !== ''
            ? body['workDir'].trim()
            : null,
        skillIds: skillIds as Agent['skillIds'],
        toolIds: [],
        env: {},
        maxConcurrentRuns: (maxConcurrentRuns as number | undefined) ?? 1,
        kindPatterns,
        kindSkillOverride: {},
        isFallbackReviewer: body['isFallbackReviewer'] === true,
        autoReview: body['autoReview'] === true,
        createdAt: now,
        updatedAt: now,
      }
      await store.insertAgent(agent)
      sendJson(res, 201, agent)
      return
    }

    // ── 改 agent（FR-AGENT-19：可点开看细节并编辑）──
    //
    // 用 PATCH 语义：**只改传了的字段**。整体替换会让"只想改个名字"的请求
    // 顺手把没传的字段清空——那是个很容易踩且很难发现的坑（保存之后
    // 发现指令没了）。
    const agentMatch = /^\/api\/agents\/([^/]+)$/.exec(path)
    if (agentMatch) {
      const agentId = decodeURIComponent(agentMatch[1]!) as Agent['id']

      if (req.method === 'GET') {
        const agent = await store.getAgent(agentId)
        if (!agent) {
          sendJson(res, 404, { error: `agent 不存在：${agentId}` })
          return
        }
        sendJson(res, 200, agent)
        return
      }

      if (req.method === 'PATCH' || req.method === 'PUT') {
        const current = await store.getAgent(agentId)
        if (!current) {
          sendJson(res, 404, { error: `agent 不存在：${agentId}` })
          return
        }
        const body = (await readJsonBody(req)) as Record<string, unknown>

        // 只认识这些字段——未知字段**明确拒绝**而不是静默忽略：
        // 拼错 `instructions` 为 `instruction` 时，静默忽略会让人以为保存成功了
        const allowed = new Set([
          'name',
          'instructions',
          'model',
          'workDir',
          'skillIds',
          'kindPatterns',
          'isFallbackReviewer',
          'autoReview',
          'maxConcurrentRuns',
        ])
        const unknown = Object.keys(body).filter((k) => !allowed.has(k))
        if (unknown.length > 0) {
          sendJson(res, 400, {
            error: `不认识的字段：${unknown.join(', ')}。可改的有：${[...allowed].join(', ')}`,
          })
          return
        }

        const patch: Partial<Agent> = {}

        if (body['name'] !== undefined) {
          const name = typeof body['name'] === 'string' ? body['name'].trim() : ''
          if (name === '') {
            sendJson(res, 400, { error: 'name 不能为空' })
            return
          }
          patch.name = name
        }
        if (body['instructions'] !== undefined) {
          if (typeof body['instructions'] !== 'string') {
            sendJson(res, 400, { error: 'instructions 必须是字符串' })
            return
          }
          patch.instructions = body['instructions']
        }

        const stringArray = (key: string): string[] | { error: string } => {
          const raw = body[key]
          if (!Array.isArray(raw)) return { error: `${key} 必须是数组` }
          const bad = raw.find((v) => typeof v !== 'string' || v.trim() === '')
          if (bad !== undefined) {
            return { error: `${key} 里每一项都必须是非空字符串（收到 ${JSON.stringify(bad)}）` }
          }
          return (raw as string[]).map((v) => v.trim())
        }

        if (body['skillIds'] !== undefined) {
          const ids = stringArray('skillIds')
          if (!Array.isArray(ids)) {
            sendJson(res, 400, { error: ids.error })
            return
          }
          // 与新建时同样校验：挂不存在的 skill 会在**运行时**才报"没有 skill"，
          // 而不是"你填错了 id"
          const skills = await store.listSkills(current.workspaceId)
          const known = new Set(skills.map((s) => s.id as string))
          const unknownSkill = ids.find((id) => !known.has(id))
          if (unknownSkill !== undefined) {
            sendJson(res, 400, {
              error: `skill 不存在：${unknownSkill}。可用的：${
                skills.map((s) => s.slug).join(', ') || '（还没有 skill）'
              }`,
            })
            return
          }
          patch.skillIds = ids as Agent['skillIds']
        }

        if (body['kindPatterns'] !== undefined) {
          const patterns = stringArray('kindPatterns')
          if (!Array.isArray(patterns)) {
            sendJson(res, 400, { error: patterns.error })
            return
          }
          patch.kindPatterns = patterns
        }

        for (const flag of ['isFallbackReviewer', 'autoReview'] as const) {
          if (body[flag] !== undefined) {
            if (typeof body[flag] !== 'boolean') {
              sendJson(res, 400, { error: `${flag} 必须是布尔值` })
              return
            }
            patch[flag] = body[flag] as boolean
          }
        }

        if (body['maxConcurrentRuns'] !== undefined) {
          const n = body['maxConcurrentRuns']
          if (!Number.isInteger(n) || (n as number) < 1) {
            sendJson(res, 400, { error: 'maxConcurrentRuns 必须是正整数' })
            return
          }
          patch.maxConcurrentRuns = n as number
        }

        if (body['workDir'] !== undefined) {
          if (body['workDir'] !== null && typeof body['workDir'] !== 'string') {
            sendJson(res, 400, { error: 'workDir 必须是字符串或 null' })
            return
          }
          const wd = typeof body['workDir'] === 'string' ? body['workDir'].trim() : ''
          patch.workDir = wd === '' ? null : wd
        }

        if (body['model'] !== undefined) {
          const m = typeof body['model'] === 'string' ? body['model'].trim() : ''
          patch.model = m === '' ? null : m
        }

        const updated: Agent = { ...current, ...patch, updatedAt: Date.now() }
        await store.insertAgent(updated)
        sendJson(res, 200, updated)
        return
      }
    }

    if (req.method === 'GET' && path === '/api/issues') {
      const page = await store.listIssues({ workspaceId, limit: 200 })
      sendJson(res, 200, page)
      return
    }
    if (req.method === 'POST' && path === '/api/issues') {
      const body = (await readJsonBody(req)) as Partial<Issue>
      const now = Date.now()
      const issue: Issue = {
        id: (body.id ?? (ulid() as Issue['id'])) as Issue['id'],
        workspaceId,
        title: body.title ?? '未命名',
        description: body.description ?? '',
        status: body.status ?? 'todo',
        priority: body.priority ?? 'none',
        assignee: body.assignee ?? null,
        labels: body.labels ?? [],
        createdAt: now,
        updatedAt: now,
      }
      await store.insertIssue(issue)
      sendJson(res, 201, issue)
      return
    }

    // ── 通知中心（FR-ISSUE-07/08）──
    if (req.method === 'GET' && path === '/api/inbox') {
      const unreadOnly = url.searchParams.get('all') !== '1'
      sendJson(res, 200, {
        items: await store.listInboxItems({ workspaceId, unreadOnly, limit: 100 }),
      })
      return
    }
    const inboxRead = /^\/api\/inbox\/([^/]+)\/read$/.exec(path)
    if (req.method === 'POST' && inboxRead) {
      const ok = await store.markInboxItemRead(decodeURIComponent(inboxRead[1]!))
      sendJson(res, ok ? 200 : 404, { ok })
      return
    }

    // ── 成本（M4）──
    //
    // 只读。刻意**不**做成一个"成本报表"页面元素，而是一个能被别处消费的
    // 数据接口——MCP 的 cost_report 与将来的导出都从这里取。
    if (req.method === 'GET' && path === '/api/costs') {
      const page = await store.listRuns({ workspaceId, limit: 10_000 })
      sendJson(
        res,
        200,
        aggregateCost(
          page.items.map((r) => ({
            agentId: r.agentId as string,
            kind: r.kind,
            usage: r.usage,
          })),
        ),
      )
      return
    }

    // ── 审计导出（M4）──
    //
    // `runId` 可选：给了就只导这一条 run 的审计链，不给就导整个工作区。
    // 导出物自带校验和，且把"可追溯但不可复现"这条限制写进文件本身——
    // 因为它会被带出本机，看到它的人未必读过这份设计文档。
    if (req.method === 'GET' && path === '/api/audits/export') {
      const url2 = new URL(req.url ?? '/', 'http://localhost')
      const onlyRun = url2.searchParams.get('runId')
      const doc = await exportAudit(store, {
        workspaceId,
        ...(onlyRun ? { runIds: [onlyRun] } : {}),
      })
      // 下载语义而不是内联渲染：这是一份要被存下来的文件。
      const payload = JSON.stringify(doc, null, 2)
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="alpha-helper-audit-${Date.now()}.json"`,
        'content-length': Buffer.byteLength(payload),
      })
      res.end(payload)
      return
    }

    // ── 技能（审核模板与自建）──
    if (req.method === 'GET' && path === '/api/skills') {
      sendJson(res, 200, { skills: await store.listSkills(workspaceId) })
      return
    }
    // ── 安装 skill（FR-AGENT-09/10/11）──
    //
    // ══════════════════════════════════════════════════════════════════
    // 这里此前是一个"能写进去就行"的实现，有两个真问题
    // ══════════════════════════════════════════════════════════════════
    //
    // **① 它把 `source` 写死成 `'local'`。** 而从远端目录下载来的 skill
    //    会被记成"使用者自有的"——于是"本地内容不因远端变化而改变"
    //    （FR-AGENT-10）这条保证在数据上就无从判断，因为根本分不清谁是谁。
    //
    // **② 它没有任何同名处理。** `insertSkill` 是按 **id** 写入的，所以
    //    两个 slug 相同、id 不同的 skill 会**同时存在**——同名冲突不是
    //    "被覆盖"，而是"悄悄多出一条"，而 `loadAgentSkills` 只会取到其中
    //    一条。哪种结果都不对，且都没有提示。
    //
    // 现在的规则（确定性 + 绝不静默）：
    //
    //   - 同名一律**拒绝写入**，并在 `skipped` 里说清与谁冲突、对方是哪来的；
    //   - 想换掉必须显式传 `overwrite: true`——那是一个明确的动作，
    //     而不是"下载顺手覆盖了你的东西"；
    //   - 与 FR-REG-03 一致：**不做版本管理、不检查更新、不比较新旧**，
    //     所以远端 skill 之间也不存在"升级"。
    if (req.method === 'POST' && path === '/api/skills') {
      const raw = (await readJsonBody(req)) as {
        skills?: unknown
        batchId?: unknown
        overwrite?: unknown
      }
      if (!Array.isArray(raw.skills)) {
        sendJson(res, 400, { error: '需要 skills（数组）' })
        return
      }
      const overwrite = raw.overwrite === true
      const now = Date.now()
      const existing = await store.listSkills(workspaceId)
      const bySlug = new Map(existing.map((s) => [s.slug, s]))
      const installed: Skill[] = []
      const skipped: Array<{ slug: string; reason: string; existingSource: string }> = []

      for (const entry of raw.skills) {
        const payload = entry as Partial<Skill> & { slug?: string }
        const slug = typeof payload.slug === 'string' ? payload.slug : ''
        if (slug === '') {
          skipped.push({ slug: '(空)', reason: 'slug 是 skill 的权威标识，不能为空', existingSource: '' })
          continue
        }
        const clash = bySlug.get(slug)
        if (clash && !overwrite) {
          skipped.push({
            slug,
            existingSource: clash.source,
            reason:
              `已有同名 skill（来源：${clash.source}）。` +
              `同名一律拒绝写入，避免"下载顺手覆盖了你自己的东西"；` +
              `确实要替换请显式传 overwrite: true。`,
          })
          continue
        }

        const skill: Skill = {
          // 同名替换时**复用原 id**：否则会留下一条永远没人引用的孤儿记录
          id: (clash?.id ?? payload.id ?? (ulid() as Skill['id'])) as Skill['id'],
          workspaceId,
          slug,
          name: payload.name ?? slug,
          description: payload.description ?? null,
          body: payload.body ?? '',
          verdictSchemaVersion: 1,
          allowedActions: payload.allowedActions ?? ['comment.create'],
          // ★ 来源如实记录：默认 `remote`（这条路本来就是"页面下载好交过来"），
          //   调用方可以显式声明是本地自建。
          source: payload.source === 'local' ? 'local' : 'remote',
          sourceRef: payload.sourceRef ?? null,
          createdAt: clash?.createdAt ?? now,
          updatedAt: now,
        }
        await store.insertSkill(skill)
        bySlug.set(slug, skill)
        installed.push(skill)
      }

      sendJson(res, 201, { installed, skipped })
      return
    }

    // ── 第三方报告摄取（S2 的入口）──
    if (req.method === 'POST' && path === '/api/reports') {
      const body = (await readJsonBody(req)) as { source?: string; items?: unknown }
      if (typeof body.source !== 'string' || !Array.isArray(body.items)) {
        sendJson(res, 400, { error: '需要 source（字符串）与 items（数组）' })
        return
      }

      // ★ **逐条校验**，而不是信任类型声明。
      //
      //   类型是编译期的东西，而这里是运行时的任意 JSON。此前只检查了
      //   `Array.isArray(items)`，于是省略 `body` 的条目会让 `undefined`
      //   一路走到 `createHash().update()`，以 HTTP 500 + 内部错误原文返回。
      //   按 MCP 那边的工具 schema（body 可选）写的调用**必然**踩到它。
      //
      //   校验要报到"第几条、哪个字段"——只说"输入不合法"会让调用方
      //   无从下手，尤其是批量投递时。
      const items: ThirdPartyItem[] = []
      for (const [index, raw] of body.items.entries()) {
        const parsed = ThirdPartyItemSchema.safeParse(raw)
        if (!parsed.success) {
          const detail = parsed.error.issues
            .map((i) => `${i.path.map(String).join('.') || '(根)'}：${i.message}`)
            .join('；')
          sendJson(res, 400, {
            error: `items[${index}] 不合法：${detail}`,
            index,
            issues: parsed.error.issues.map((i) => ({
              path: i.path.map(String),
              message: i.message,
            })),
          })
          return
        }
        items.push(parsed.data)
      }
      if (items.length === 0) {
        sendJson(res, 400, { error: 'items 不能为空数组' })
        return
      }

      const summary = await ingestor.ingest(workspaceId, body.source, items)
      const runIds: RunId[] = []
      let unmatched = 0

      for (const routed of summary.routed) {
        if (routed.unmatched) {
          // ★ 不得静默丢弃：存下 report 并通知（FR-AGENT-22）
          unmatched += 1
          await store.appendInboxItem(unmatchedReportNotice(workspaceId, routed.report, Date.now()))
          continue
        }
        for (const reviewer of routed.reviewers) {
          const runId = await createReviewRun(routed.report, reviewer)
          if (runId) runIds.push(runId)
        }
      }

      sendJson(res, 202, {
        total: summary.total,
        created: summary.created,
        deduplicated: summary.deduplicated,
        unmatched,
        runIds,
      })
      return
    }

    // ── 判决与审计 ──
    const verdictsMatch = /^\/api\/runs\/([^/]+)\/verdicts$/.exec(path)
    if (req.method === 'GET' && verdictsMatch) {
      sendJson(res, 200, {
        verdicts: await store.listVerdictsByRun(decodeURIComponent(verdictsMatch[1]!) as RunId),
      })
      return
    }
    const auditsMatch = /^\/api\/runs\/([^/]+)\/audits$/.exec(path)
    if (req.method === 'GET' && auditsMatch) {
      sendJson(res, 200, {
        audits: await store.listAuditsByRun(decodeURIComponent(auditsMatch[1]!) as RunId),
      })
      return
    }

    // ── POST /api/runs ──
    if (req.method === 'POST' && path === '/api/runs') {
      const body = (await readJsonBody(req)) as SubmitRunRequest
      // `workDir` 从 D27 起是**可选**的：缺省由 daemon 按任务自动分配。
      // 这个校验漏改过一次，症状是"页面不填目录就提交不了"——而那正是 D27
      // 要消除的动作。
      if (typeof body?.runId !== 'string' || body.runId === '') {
        sendJson(res, 400, { error: '缺少 runId' })
        return
      }
      // ★ 解析 skill（见 SubmitRunRequest.skills 的说明）。
      //
      //   省略 ⇒ 按该 agent 的配置解析；显式给了就用给的。
      //   显式给空数组而 agent 明明配了 skill ⇒ **警告**，因为那几乎一定是
      //   调用方漏了，而它的后果是"用裸模型跑审核"——正常完成、结果不对。
      let skills = body.skills
      if (skills === undefined || skills.length === 0) {
        const agent = await store.getAgent(body.agentRef.id as Agent['id'])
        const configured = agent ? await loadAgentSkills(store, agent) : []
        if (skills !== undefined && configured.length > 0) {
          warn(
            `run ${body.runId} 显式传了空 skills，但 agent ${agent?.name ?? body.agentRef.id} ` +
              `配了 ${configured.length} 个 skill。如果这不是有意的，检查调用方是否漏了 skills。`,
          )
        }
        if (skills === undefined) {
          skills = configured.map((s) => ({
            ref: { id: s.id, slug: s.slug, source: s.source },
            slug: s.slug,
            name: s.name,
            body: s.body,
            allowedActions: s.allowedActions,
            files: {},
          }))
          if (skills.length > 0) {
            info(`run ${body.runId} 按 agent 配置解析到 ${skills.length} 个 skill`)
          }
        }
      }

      const outcome = await executor.submit({ ...body, skills })
      if (outcome.kind === 'rejected') {
        // 取不到槽位就不返回 202——让页面稍后重试（FR-RUNTIME-04）
        res.setHeader('retry-after', String(Math.ceil(outcome.retryAfterMs / 1000)))
        sendJson(res, 429, outcome)
        return
      }
      sendJson(res, 202, outcome)
      return
    }

    // ── GET /api/runs ──
    if (req.method === 'GET' && path === '/api/runs') {
      const page = await store.listRuns({ workspaceId, limit: 100 })
      const runs = await Promise.all(
        page.items.map(async (run) => ({
          runId: run.id,
          kind: run.kind,
          status: run.status,
          agentId: run.agentId,
          /**
           * ★ `subject` 必须带上——页面靠它把 run 归到具体的任务上。
           *
           * 少了它，任务详情里永远显示"这个任务还没有执行过"，而实时日志
           * 也就永远出不来：不是日志坏了，是**页面根本不知道该显示哪些 run**。
           * 这类"接口少给一个字段"的缺陷不会报错，只会让功能静默地不工作。
           */
          subject: run.subject,
          workDir: run.workDir,
          lastSeq: await store.lastRunMessageSeq(run.id),
          queuedAt: run.queuedAt,
          finishedAt: run.finishedAt,
          failureReason: run.failureReason,
          chainDepth: run.chainDepth,
        })),
      )
      sendJson(res, 200, { runs })
      return
    }

    const runMatch = /^\/api\/runs\/([^/]+)(?:\/(events|cancel|artifacts|messages))?$/.exec(path)
    if (runMatch) {
      const runId = runMatch[1] as RunId
      const sub = runMatch[2]

      if (req.method === 'GET' && sub === undefined) {
        const run = await store.getRun(runId)
        if (!run) return sendJson(res, 404, { error: 'run 不存在' })
        sendJson(res, 200, run)
        return
      }

      if (req.method === 'GET' && sub === 'messages') {
        const since = Number(url.searchParams.get('since') ?? '-1')
        sendJson(res, 200, { messages: await store.listRunMessages(runId, since) })
        return
      }

      if (req.method === 'GET' && sub === 'events') {
        await streamEvents(req, res, runId, Number(url.searchParams.get('since') ?? '-1'))
        return
      }

      if (req.method === 'POST' && sub === 'cancel') {
        const ok = await executor.cancel(runId)
        sendJson(res, ok ? 200 : 409, { cancelled: ok })
        return
      }

      if (req.method === 'GET' && sub === 'artifacts') {
        const artifacts = await store.listArtifactsByRun(runId)
        sendJson(res, 200, {
          artifacts: await Promise.all(
            artifacts.map(async (a) => ({
              blobRef: a.blobRef,
              summary: a.summary,
              sizeBytes: (await store.getBlob(a.blobRef))?.length ?? 0,
            })),
          ),
        })
        return
      }
    }

    sendJson(res, 404, { error: `未知路径 ${path}` })
  }

  /**
   * SSE 流。
   *
   * 先用 store 里已落盘的消息补齐（`?since=N`），再挂上实时订阅。
   * 顺序不能反：先订阅再补齐的话，补齐过程中新产生的消息会重复。
   */
  async function streamEvents(
    req: IncomingMessage,
    res: ServerResponse,
    runId: RunId,
    since: number,
  ): Promise<void> {
    const run = await store.getRun(runId)
    if (!run) {
      sendJson(res, 404, { error: 'run 不存在' })
      return
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })

    const write = (event: unknown): void => {
      res.write(`data: ${JSON.stringify(event)}\n\n`)
    }

    // ① 先补齐历史（已落盘的消息是权威）
    const persisted = await store.listRunMessages(runId, since)
    for (const message of replayMessagesSince(persisted, since)) {
      write({ t: 'message', seq: message.seq, message })
    }

    // ② 再挂实时订阅
    const fromSeq =
      persisted.length > 0 ? Math.max(since, persisted[persisted.length - 1]!.seq) : since
    const unsubscribe = registry.subscribe(runId, (event) => {
      if (event.seq > fromSeq) write(event)
    })

    // 心跳：防止中间层把长连接当作空闲断开
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000)
    heartbeat.unref?.()

    const cleanup = (): void => {
      clearInterval(heartbeat)
      unsubscribe()
    }
    req.on('close', cleanup)
    res.on('close', cleanup)
  }

  // ══════════════════════════════════════════════════════════════════
  // 监听失败必须变成**可读的错误**，而不是一个未捕获的 'error' 事件
  // ══════════════════════════════════════════════════════════════════
  //
  // 早先这里是 `listen(port, host, resolve)`——**没有挂 error 处理器**。
  // 端口被占用时 `listen` 会 emit `'error'`，而没人接，于是 Node 直接抛出
  // 未捕获异常、打一串栈、进程退出；同时那个 Promise **永远不会 settle**，
  // 所以 cli.ts 里那段写得好好的"端口被占用，可用 --port 指定别的端口"
  // 提示**一行都执行不到**。
  //
  // 这正是"只有真的跑一次才会发现"的那类缺陷：类型检查过得去，
  // 单测（都用 port: 0）也照常通过。
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.off('listening', onListening)
        reject(err)
      }
      const onListening = (): void => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(options.port, '127.0.0.1')
    })
  } catch (err) {
    // 起不来就得把已经占下的资源还回去——主要是数据目录的**单进程锁**。
    // 不还的话，使用者改个端口重启会撞上"数据已被另一个进程占用"，
    // 而那个"另一个进程"其实正是刚刚失败的自己。错误信息会把人带偏。
    await executor.shutdown(0).catch(() => undefined)
    await store.close().catch(() => undefined)

    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EADDRINUSE') {
      throw new Error(
        `端口 ${options.port} 已被占用。alpha-helper **不自动换端口**——` +
          `随机端口意味着"重启后地址变了"，而地址会被写进书签与配置里，` +
          `那种漂移比端口冲突难查得多。请先停止占用该端口的进程，` +
          `或用 --port 显式指定另一个端口。`,
      )
    }
    if (code === 'EACCES') {
      throw new Error(`没有权限绑定端口 ${options.port}（1024 以下的端口通常需要更高权限）`)
    }
    throw err
  }

  const address = server.address() as AddressInfo
  const url = `http://127.0.0.1:${address.port}`

  return {
    url,
    port: address.port,
    store,
    async close() {
      // 先断开所有连接：`server.close()` 会等现有连接自然结束，而页面的
      // keep-alive 与 SSE 长连接可能挂很久——那会让"停止 daemon"看起来卡住。
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))

      // ★ 关停执行器**必须**在关 store 之前，而且必须等它结束。
      //   顺序反过来的话，run 会在 store 已关之后继续写——写不进去，
      //   或者更糟：进程退出时留下一个"看起来在执行"的 run。
      await executor.shutdown()

      await store.close()
    },
  }
}

/**
 * Host 校验（FR-BRIDGE-10）。
 *
 * 只接受回环 Host。**不校验就等着被 DNS rebinding 打**：攻击者让自己的域名
 * 解析到 127.0.0.1，用户浏览器就会把请求发到本机 daemon——而 Host 头带的
 * 是攻击者的域名，所以我们能认出来。
 */
export function isAllowedHost(host: string, address: AddressInfo | null): boolean {
  const port = address?.port
  const allowed = ['127.0.0.1', 'localhost', '[::1]', '::1']
  const bare = host.replace(/:\d+$/, '')
  if (!allowed.includes(bare)) return false
  // 端口也必须对得上（避免同机别的服务冒充）
  if (port === undefined) return true
  const hostPort = host.match(/:(\d+)$/)?.[1]
  return hostPort === undefined || Number(hostPort) === port
}

/** 首次启动时准备一个可用的 workspace 与默认 agent。 */
async function bootstrap(store: Store, info: (m: string) => void): Promise<Workspace['id']> {
  const existing = await store.listWorkspaceIds()
  const first = existing[0]
  if (first) return first

  const now = Date.now()
  const workspace: Workspace = { id: ulid() as Workspace['id'], name: '默认工作区', createdAt: now, updatedAt: now }
  await store.insertWorkspace(workspace)

  const device = await store.getDevice()
  if (!device) {
    const { hostname } = await import('node:os')
    await store.upsertDevice({
      id: ulid() as import('@alpha-helper/protocol').DeviceId,
      name: hostname(),
      createdAt: now,
      lastSeenAt: now,
    })
  }

  // ── 内置审核模板（FR-AGENT-08/09）──
  // S2 在没有任何模板时是**空的**：使用者得先从零写一个 skill 才能用上。
  // 所以内置一个最小可用的通用审核标准，作为兜底审核者的默认凭据。
  const template: Skill = {
    id: ulid() as Skill['id'],
    workspaceId: workspace.id,
    slug: 'general-review',
    name: '通用审核',
    description: '开箱可用的通用审核标准：能通过就通过，不行就给出可执行的动作，拿不准就交给人。',
    body: [
      '# 通用审核',
      '',
      '## 判断标准',
      '',
      '1. **能明确判断**时给出 `pass` 或 `fail`，并把证据指回原文。',
      '2. **判断依据不足**时给出 `needs_human`，写清楚缺什么。',
      '3. 不要引入这份标准之外的要求——那是越权，不是严谨。',
      '',
      '## 动作约定',
      '',
      '- `fail` 时用一个动作表达"接下来做什么"，而不是只描述问题。',
      '- 只有确实需要改动时才 `issue.update_status`；纯提示用 `comment.create`。',
    ].join('\n'),
    verdictSchemaVersion: 1,
    // ★ 动作子集：这个模板只允许发表评论与打标签，不允许建 issue 或指派 agent
    allowedActions: ['comment.create', 'issue.add_label'],
    source: 'local',
    sourceRef: null,
    createdAt: now,
    updatedAt: now,
  }
  await store.insertSkill(template)

  const agent: Agent = {
    id: ulid() as Agent['id'],
    workspaceId: workspace.id,
    name: '助手',
    instructions: '你是一个严谨的协作者。先理解任务，再动手；报告要写清楚结论与不确定的地方。',
    model: null,
    // ⚠️ 这里**刻意写死 claude**，而不是取"当前 daemon 的 runtime"。
    //
    //   播种发生在 `bootstrap()` 里，它手上没有 daemon 选项——而把 runtimeKey
    //   一路传进来会掩盖一个更重要的事实：**agent 记录的 runtimeKey 目前根本
    //   没被消费**（executor 用的是 daemon 级的 `backend`）。
    //   写死 claude 让这个不一致保持显式；等"按 agent 选 runtime"真正落地时，
    //   这里和 executor 必须一起改，而不是现在假装已经支持了。
    runtimeKey: 'claude',
    workDir: null,
    skillIds: [template.id],
    toolIds: [],
    env: {},
    maxConcurrentRuns: 1,
    // 兜底审核者：任何 kind 都能接（FR-AGENT-22）
    kindPatterns: ['*'],
    kindSkillOverride: {},
    isFallbackReviewer: true,
    // S1 默认开：执行完成后自动接一次审核（可用 API 关掉）
    autoReview: true,
    createdAt: now,
    updatedAt: now,
  }
  await store.insertAgent(agent)

  info(`已初始化工作区、默认 agent（${agent.name}）与内置审核模板（${template.slug}）`)
  return workspace.id
}

/** 从 subject 里取 issueId（不是 issue 时为 null）。 */
function issueIdOfSubject(run: Run): Issue['id'] | null {
  return run.subject.type === 'issue' ? (run.subject.id as Issue['id']) : null
}

/** 取一个 agent 挂载的 skill 内容（按 agent 求解的子集，D22）。 */
async function loadAgentSkills(store: Store, agent: Agent): Promise<Skill[]> {
  const all = await store.listSkills(agent.workspaceId)
  const byId = new Map(all.map((s) => [s.id as string, s]))
  return agent.skillIds.flatMap((id) => {
    const skill = byId.get(id as string)
    return skill ? [skill] : []
  })
}

export { parseVerdict }
export type { RunMessage }
