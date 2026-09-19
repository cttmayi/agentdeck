/**
 * daemon 接口客户端（同源）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么单独一个模块，而不是在每个组件里 fetch
 * ══════════════════════════════════════════════════════════════════
 *
 * 因为这里有三件**必须到处一致**的事，散落开就一定会漂：
 *
 *   - 出错时怎么判断"是网络问题还是业务问题"（前者要提示去启动 daemon，
 *     后者要展示服务端给的原文）；
 *   - 429（并发已满）要**单独**处理，它不是错误，是"稍后再试"；
 *   - 路径拼接与手写 URL 的地方越少越好。
 */
import { renderText, webText } from '@alpha-helper/i18n'
import { currentLocale } from './locale.ts'

export class ApiError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(message: string, status: number, body: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

/** 并发已满不是失败，是"稍后再试"——单独一个类型，调用方才好分支。 */
export class BusyError extends ApiError {
  constructor(body: unknown) {
    // 取词在这里就定下来（`currentLocale()` 读当下的语言）：库层没有响应式
    // 上下文，而这条消息是"此刻发生了什么"的记录，之后切语言也不该被改写。
    super(renderText(webText, 'err.busy', currentLocale()), 429, body)
    this.name = 'BusyError'
  }
}

export async function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      headers: { 'content-type': 'application/json' },
      ...init,
    })
  } catch (err) {
    // 连不上本机 daemon 是**最可能**的失败，而且处置与业务错误完全不同：
    // 一个是"去把服务起起来"，一个是"你的输入有问题"。
    // ★ 这条消息**使用者看得到**（toast / 页面上的红字），所以它必须跟着界面语言
    //   走；原始原因（`fetch failed` 之类）是运行时给的话，不翻译，只当作插值。
    const loc = currentLocale()
    const reason = err instanceof Error ? err.message : String(err)
    throw new ApiError(
      renderText(webText, 'err.daemonUnreachable', loc) +
        renderText(webText, 'err.daemonUnreachableReason', loc, { reason }),
      0,
      null,
    )
  }

  const text = await res.text()
  let body: unknown = null
  if (text !== '') {
    try {
      body = JSON.parse(text)
    } catch {
      // 服务端返回了非 JSON —— 说明它自己出问题了，把原文带上比吞掉有用
      body = { raw: text.slice(0, 500) }
    }
  }

  if (res.status === 429) throw new BusyError(body)

  if (!res.ok) {
    const message =
      (body as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`
    throw new ApiError(message, res.status, body)
  }
  return body as T
}

// ─────────────────────────────────────────────────────────────
// 接口形状（只声明我们真的用到的字段）
// ─────────────────────────────────────────────────────────────

export interface RuntimeView {
  key: string
  command: string
  available: boolean
  cliVersion: string | null
  /** `verified` = 对照过真实程序；`provisional` = 按公开形状推导。 */
  evidence: string
  /** 未验证时：**缺什么证据**（给人看的一句话），已验证时为 null。 */
  evidenceNote: string | null
  sessionState: string
  versionSupport?: {
    status: string
    range: string | null
    verifiedWith: string[]
    message: string
  }
}

export interface EnvironmentIssue {
  subject: string
  severity: 'error' | 'warning'
  summary: string
  action: string
}

export interface Identity {
  deviceName: string
  currentRuntime?: string
  /** 界面语言（D39）：'zh' | 'en'。页面启动时就要知道，避免先闪一下中文。 */
  locale?: string
  runtimes: RuntimeView[]
  /**
   * daemon 的能力标志（`apps/daemon/src/server.ts` 的 `GET /api/identity`）。
   *
   * ★ 为什么页面必须看它：界面（`apps/web/dist`）与 daemon 是**两份产物**，
   *   而日常做法恰好容易造成版本错位——"重建前端 → 刷新页面"**不带**重启
   *   daemon。这时旧 daemon 会**静默忽略**它不认识的新字段，于是界面上那句
   *   "这一次不自动审核"根本没发生，任务照样被审。页面说的与实际发生的不一致，
   *   而两边都不报错——所以宁可**不给这个选项**，也不给一个可能不生效的。
   */
  capabilities?: string[]
  /** 运行环境预检结果（例如 CLI 自己的状态目录写不进去）。 */
  environment?: { ok: boolean; issues: EnvironmentIssue[] }
}

export interface Issue {
  id: string
  title: string
  description: string
  status: string
  assignee: { type: string; id: string } | null
  labels: string[]
  updatedAt: number
  createdAt: number
}

export type AgentRole = 'executor' | 'reviewer'

export interface Agent {
  id: string
  name: string
  instructions: string
  workDir: string | null
  skillIds: string[]
  model: string | null
  runtimeKey: string
  /** 干活的还是审的（D28）。 */
  role: AgentRole
  /** 由谁来审**这个执行 agent** 的产出（仅 executor 有意义）。 */
  reviewerAgentId: string | null
  /**
   * 挂在这个 agent 上的**工具组**（D40）。
   *
   * ★ 挂载单位是**组**（一个工具包 = 一个组）：勾上就是把这一整组动作交给它，
   *   没有"只挂组里某一个动作"这回事。
   *
   * ⚠️ 协议里它是必需字段（老数据是空数组），这里写成**可选**是过渡期的防御：
   *   D40 之前的 daemon 不返回它，而这一版界面会跟不同版本的 daemon 打交道
   *   （界面先落地、后端并行落地）。缺字段时按"没挂任何工具"显示，而不是让
   *   整个详情页在 `undefined.length` 上崩掉。
   *
   * ⚠️ **审核者身上永远是空的**：审核者只判断、不动手（服务端拒绝写非空值）。
   */
  toolIds?: string[]
  /**
   * ★ **这个审核者判完之后允许触发哪些动作**（D40 收口；D41 收窄成只有一种来源）。
   *
   * "按什么判"（`reviewStandard`）与"判完允许动什么"（这里）是两件事：前者是
   * 一段文本，后者是一份**能力**。
   *
   * ⚠️ 取值**只有一种形状**：已装工具包的 `<包 slug>.<动作名>`
   *   （`probe-tool.append-note`）。平台的内置动作已经整组移除——协议里的
   *   `ActionType` 枚举没有了，`packages/domain` 的注册表换成了 `definition.ts`——
   *   所以老工作区里存着的那几个裸名（`comment.create` 之类）只是**历史值**：
   *   界面上原样显示（契约值不翻译），但没有任何包认领它，也就没有 `summary`。
   *
   * ★ 默认是**空数组**（= 只报告、不动作）："允许什么"必须由使用者说了算，
   *   平台不替他放宽，也不替他收紧。装了什么包、包里有什么动作只有使用者知道，
   *   所以界面也**不替他预勾**（`ActionPicker.svelte` / `NewAgentForm.svelte`）。
   *
   * ⚠️ 写成**可选**是过渡期的防御（与 `toolIds` 同一个理由）：这个字段是后加的，
   *   老工作区的记录里**根本没有这个键**（store 不做 schema 迁移，读取路径也不补
   *   默认值），更早的 daemon 也不返回它。缺字段与空数组同义。
   *
   * ⚠️ **只有审核者用得着它**：执行者的能力是**工具**（`toolIds`，它干活时用的），
   *   而动作是**判完之后**由平台执行的。服务端拒绝给执行者写非空值，所以详情页里
   *   这一段只出现在审核者身上。
   *
   * ⚠️ 老数据里这份配置在 `reviewStandard.allowedActions` 上（搬走之前它在那儿）。
   *   界面按"自己的为空就回退到那份"显示（`lib/agent-actions.ts`），只读、不回写。
   */
  allowedActions?: string[]
  /**
   * 动作的**固定参数**（D43）：`动作名 → 参数名 → 值`。
   *
   * 界面上给已授权动作的 open 参数设的固定值：执行时由平台注入，**模型不许写**
   * （写了会被判不合规）。只可能是该动作的 open 参数（bound 是平台的事实）。
   *
   * ⚠️ 可选：老工作区记录里没有这个键；缺字段 = 没设任何固定参数。
   * ⚠️ **只有审核者用得着它**（与 `allowedActions` 同一条规矩）。
   */
  actionParams?: Record<string, Record<string, unknown>>
  /**
   * 这个审核者按什么判（D37）。`null` = 没有标准（那它拿不到审核任务）。
   *
   * 校验在服务端：名字与正文非空（动作权限不在这里，见 `allowedActions`）。
   */
  reviewStandard: ReviewStandard | null
}

/**
 * 审核标准（D37）：**内联在审核者身上**的一条判断依据。
 *
 * ⚠️ **"允许动什么"不在标准里**（D40 收口搬走了）：那是审核者的**能力**，
 *    住在 `Agent.allowedActions`。判断依据与处置权限是两件事——分开放之后
 *    "我改了标准正文"与"我放宽了能动的范围"在审计与界面上都能分开看。
 */
export interface ReviewStandard {
  name: string
  body: string
  /**
   * ⚠️ **老数据的只读兼容字段**（D40 收口之后动作权限搬到了 `Agent.allowedActions`）。
   *
   * 搬走之前动作白名单就写在标准里，而老工作区的记录里它还在。界面**按它显示**
   * （`Agent.allowedActions` 为空时回退到它，见 `lib/agent-actions.ts`），
   * 但**一个字都不往里写**：写入口只有 `Agent.allowedActions` 一处，
   * 写成两处就会出现"哪个说了算"只能靠注释记住的问题——那正是这次搬家的理由。
   *
   * 可选：新数据里这个键根本不存在，老数据里可能是空数组。
   */
  allowedActions?: string[]
}

/** 第一句话模版的两个角色（D32）。 */
export type FirstSentenceKind = 'execute' | 'review'

/** `GET /api/first-sentence/templates`：变量对照表 + 两个默认模版。 */
export interface TemplateVariable {
  name: string
  /** 哪些 run 能用（执行模版里写 `material` 是填错了）。 */
  kinds: FirstSentenceKind[]
  /**
   * 是不是多行的内容（界面上标「多行 / 单值」）。
   *
   * ⚠️ 它不代表"整段提示词"：D35 之后**所有变量都只给内容**，标题、标签、
   *    材料标记都由模版写。
   */
  multiline: boolean
  /** 缺了会坏掉的那些——保存时就会拒。 */
  requiredFor: FirstSentenceKind[]
  label: string
}

/** `GET /api/agents`：列表 + 「新建任务的默认智能体」（D36）。 */
export interface AgentsPayload {
  agents: Agent[]
  /** null = 没设过（新建任务页退回列表里的第一个）。 */
  defaultAgentId: string | null
}

export interface TemplateKit {
  defaults: Record<FirstSentenceKind, string>
  variables: TemplateVariable[]
  /**
   * 当前生效的那两份（空 = 平台默认）。
   *
   * ★ 这是**全局配置**（D32）：一次设定，所有 agent 都按它来。
   *   所以它挂在这里，而不是挂在某个 agent 上。
   */
  current: { executeTemplate: string; reviewTemplate: string }
}

export interface Skill {
  id: string
  slug: string
  name: string
  description: string | null
  /** SKILL.md 的正文。 */
  body: string
  /** 支持文件：相对路径 → 内容。缺失表示只有 SKILL.md。 */
  files?: Record<string, string>
  /**
   * ⚠️ **这里原来有一个 `allowedActions`，已经搬走了**（D40 收口）。
   *
   * "判完之后允许触发什么"是**审核者的能力**（`Agent.allowedActions`），不是
   * 一份资料包的属性——挂在 skill 上等于让"给执行者参考的东西"顺手决定了谁能
   * 改状态。老记录里这个键可能还在（整条记录以 JSON 存），界面按"没有"处理即可。
   */
  source: 'local' | 'remote'
  sourceRef: string | null
  /** 这份内容的版本（远端目录给的）。没有版本时缺失/null。 */
  version?: string | null
  updatedAt: number
}

/**
 * 工具包（D40）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 形状照 `packages/protocol/src/tools.ts` 抄，但**不 import 它**
 * ══════════════════════════════════════════════════════════════════
 *
 * 网页这边一律不 import protocol（它是给服务端与测试用的：zod、Node 侧的
 * import 后缀、以及"改一处就要重编前端"的耦合）。所以这里只声明**界面真的
 * 用到的**字段——与 `Skill` / `Agent` 那几份同一个做法。
 *
 * ⚠️ 契约值（`slug`、`<slug>.<name>`、`from: 'workdir'`、`dryRun: 'unsupported'`）
 *    在界面上**原样显示、不翻译**：它们是机器值，也是判决里写的那串东西。
 */
export type BoundFrom =
  | 'literal'
  | 'subject.issueId'
  | 'subject.runId'
  | 'workspace.id'
  | 'workdir'

/** 绑定参数：**模型看不到也填不了**，值由平台按事实填。 */
export interface BoundParamSpec {
  from: BoundFrom
  /** 只有 `from: 'literal'` 时有值。 */
  value?: string | number | boolean
}

/**
 * 开放参数：模型填的那部分。**每一项都有界**——协议里没有无界的 `string`。
 *
 * 这里写成可辨识联合而不是"一个 type + 一堆可选字段"：界面上要按 type 显示
 * "字符串，最长 2000" / "整数 1–10" / "枚举（a / b）"，用可选字段的话每个
 * 使用点都得自己收窄一遍。
 */
export type OpenParamSpec =
  | { type: 'string'; max: number; required: boolean }
  | { type: 'integer'; min: number; max: number; required: boolean }
  | { type: 'boolean'; required: boolean }
  | { type: 'enum'; values: string[]; required: boolean }

/** 组内一个动作。 */
export interface ToolActionSpec {
  /** 组内唯一；完整动作名是 `<包 slug>.<name>`。 */
  name: string
  summary: string
  /** 相对包根的入口；不给就用包级 `entry`。 */
  entry?: string
  /** ★ `false` = 不可回滚，界面必须显式标出来。 */
  reversible: boolean
  /** ★ `unsupported` = 不支持预演 ⇒ 没有"自动执行"资格，界面同样要标出来。 */
  dryRun: 'supported' | 'unsupported'
  timeoutMs?: number
  params?: {
    bound?: Record<string, BoundParamSpec>
    open?: Record<string, OpenParamSpec>
  }
}

/** 机器读的清单（`tool.json` 的形状）。 */
export interface ToolManifest {
  schema: string
  slug: string
  name: string
  version: string | null
  description: string
  runtime: string
  entry: string
  actions: ToolActionSpec[]
}

/** 一个已安装的工具包 —— **一个目录 = 一个包 = 一个组**。 */
export interface Tool {
  id: string
  /** 与 `manifest.slug` 同一个值；它同时是组的名字与动作的命名空间。 */
  slug: string
  name: string
  description: string
  version: string | null
  manifest: ToolManifest
  /** 相对路径 → 文本内容（含入口脚本）。 */
  files: Record<string, string>
  /** `TOOL.md` 的正文；没有就是空串。 */
  docs: string
  source: 'local' | 'remote'
  sourceRef: string | null
  createdAt: number
  updatedAt: number
}

/**
 * `GET /api/tools` 的那一行：实体 + **挂给了哪些 agent**。
 *
 * ★ 挂载关系是"谁在用这个组"的唯一答案，而它住在 agent 上（`Agent.toolIds`）。
 *   让接口把它算好带回来，界面就不必自己 join 两个列表——那正是"界面显示的和
 *   服务端认的迟早不一致"的来源。卸载被拒时列出的也是同一份名单。
 */
export interface ToolWithMounts extends Tool {
  mountedBy: Array<{ id: string; name: string }>
}

export interface RunSummary {
  runId: string
  kind: string
  status: string
  agentId: string
  /** run 处理的对象。页面靠它把 run 归到具体任务上。 */
  subject: { type: string; id: string }
  workDir: string | null
  queuedAt: number
  finishedAt: number | null
  failureReason: string | null
  chainDepth: number
  /**
   * 这条**执行** run 的审核者覆盖（`kind !== 'execute'` 时为 `null`）。
   *
   * ★ 三态必须分开，不能折成一个 `string | null`：
   *   `follow` = 跟随那个 agent 的「由谁审它」（长期安排）；
   *   `none` = 这次**明确不审**；
   *   `override` = 这次换人审。
   *   `follow` 与 `none` 都可能表现为"没有审核结论"，但**原因不同**，
   *   页面上要如实说清：一个是配置没配，一个是这次的决定。
   */
  reviewer: { mode: 'follow' } | { mode: 'none' } | { mode: 'override'; agentId: string } | null
  /**
   * 审核 run 的判决（只对 `kind === 'review'` 有值；还没判时为 `null`）。
   *
   * ★ 阶段推导要用它：`needs_human` 的意思是**卡在人这儿**，把它显示成
   *   「已审查」等于把待办说成做完了。
   */
  verdict: {
    status: string
    conclusion: string
    escalateReason: string | null
  } | null
  /**
   * 这条判决**要求做的那个动作**的结果（没有动作 / 不是审核 run ⇒ `null`）。
   *
   * ★ 阶段推导要用它：判决通过 ≠ 事情做完了。动作还在跑就是「行动中」，
   *   失败了就是「行动失败」——过去这两种都显示成「已审查」（那是"判决已产出"
   *   的意思，不是"事情已成"）。
   */
  action: {
    status: string
    /**
     * 动作类型（`<包 slug>.<动作名>`，如 `probe-tool.append-note`）——契约值，
     * 原样显示、不翻译。
     *
     * ⚠️ D41 之后**只有这一种形状**：平台的内置动作整组移除了，所以老工作区里
     *    存着的那几个裸名（`comment.create` 之类）只是历史值——它们会照原样显示，
     *    但没有任何包认领，界面也查不到 `summary`。
     */
    type: string
    /** 失败原因；成功时为 null。 */
    error: string | null
    /**
     * ★ 脚本回的**结果**：`{ ok, detail, exitCode, durationMs, dryRun }`。
     *
     * `detail` 是给人看的一句话——"这个动作到底做了什么 / 为什么没做成"。
     * ⚠️ 它以前**没有送到页面**，于是成功的动作在详情里只剩一句"已执行"：
     *    使用者看得见"跑过了"，看不见"跑出了什么"。
     */
    result: Record<string, unknown> | null
    /** ★ **合并后**的参数（bound 平台注入 / open 模型填 / 界面固定值）。 */
    params: Record<string, unknown>
    finishedAt: number | null
  } | null
}

export type RunDetail = RunSummary

export interface RunMessage {
  seq: number
  type: string
  tool: string | null
  content: string
  /**
   * 工具的**结构化入参**（原文保留）。
   *
   * 类型写具体而不是 `unknown`：界面要把它当对象渲染成 JSON。
   * 写 `unknown` 的话每个使用点都得自己收窄一遍——那是把类型信息
   * 丢在源头，然后让所有下游去猜。
   */
  input: Record<string, unknown> | null
  output: string | null
  outputTruncated: boolean
  at: number
}

export interface VerdictView {
  id: string
  status: string
  conclusion: string
  reasonCode: string
  confidence: number
  findings: Array<{ severity: string; summary: string; evidence?: string | null }>
  action: { type: string; params: Record<string, unknown> } | null
  escalateReason: string | null
  invalidResolution: string | null
  createdAt: number
}

export interface InboxItem {
  id: string
  type: string
  severity: 'action_required' | 'attention' | 'info'
  title: string
  body: string
  issueId: string | null
  runId: string | null
  createdAt: number
}

export interface CostBucket {
  key: string
  runs: number
  inputTokens: number
  outputTokens: number
  costUsdMicros: number
  estimatedRuns: number
}

export interface CostReport {
  total: CostBucket
  byAgent: CostBucket[]
  byKind: CostBucket[]
  runsWithoutUsage: number
}

/** 与 daemon 保持一致的 ULID 生成。 */
export function newRunId(): string {
  const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let time = Date.now()
  let timePart = ''
  for (let i = 0; i < 10; i++) {
    timePart = ENCODING[time % 32] + timePart
    time = Math.floor(time / 32)
  }
  const bytes = new Uint8Array(10)
  crypto.getRandomValues(bytes)
  let n = 0n
  for (const b of bytes) n = (n << 8n) | BigInt(b)
  let randPart = ''
  for (let i = 0; i < 16; i++) {
    randPart = ENCODING[Number(n & 31n)] + randPart
    n >>= 5n
  }
  return timePart + randPart
}

/** `GET /api/runs/:id/files` —— 工作目录里**一个目录**的直接子项。 */
export interface WorkDirFile {
  /** 相对工作目录的路径（`/` 分隔）。 */
  path: string
  /** 文件名/目录名——界面显示它，层级靠缩进（不显示整串路径）。 */
  name: string
  kind: 'file' | 'dir'
  sizeBytes: number
  modifiedAt: number
  /** 目录里还有没有东西——界面据此决定画不画展开箭头。 */
  hasChildren: boolean
  /** 平台注入的东西（`.claude/**`、`CLAUDE.md`），不是 agent 的产出。 */
  managed: boolean
}

export interface WorkDirListing {
  workDir: string
  /** 这是哪个子目录（空串 = 顶层）。 */
  dir: string
  entries: WorkDirFile[]
  truncated: boolean
}
