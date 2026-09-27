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
import { renderText, webText } from '@agentdeck/i18n'
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
  /** 本地接口协议版本（`/api/identity`）。它回答"daemon 是哪一版"。 */
  protocolVersion?: number
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
  /**
   * 这一版界面叫什么（构建产物的文件名，例如 `index-h3UWXDfH.js`）。
   *
   * ★ 它是"对称的那一半"：`capabilities` 回答"daemon 是哪一版"，这个回答"界面是
   *   哪一版"。两者不一致时的症状**两边都不报错**——一次真实的误判是"聊天页不
   *   工作、任务页正常"，实际是那个标签页跑着旧前端（没刷新）。
   * `null` = daemon 读不到构建产物（界面没构建）。
   */
  webBuild?: string | null
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
   * ⚠️⚠️ 这里原来有一个 `toolIds?: string[]`（挂载的工具包，D40）。挂载能力整个
   *    撤掉了，字段与服务端一起删——见 `packages/protocol/src/entities.ts` 里
   *    `Agent` 上那段说明。
   */
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
   * ⚠️ 写成**可选**是过渡期的防御：这个字段是后加的，
   *   老工作区的记录里**根本没有这个键**（store 不做 schema 迁移，读取路径也不补
   *   默认值），更早的 daemon 也不返回它。缺字段与空数组同义。
   *
   * ⚠️ **只有审核者用得着它**：动作是**判完之后**由平台执行的。服务端拒绝给执行者
   *   写非空值，所以详情页里这一段只出现在审核者身上。
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
   * 调试动作（2026-09）：标了「调试」的那些（`allowedActions` 的子集）。
   *
   * 判决引用这些动作时**不跑脚本**，只记录动作与解析后的完整参数（时间线显示
   * 「调试 · 未执行」）。只对审核者有意义，与 `allowedActions` 同一条角色规矩。
   *
   * ⚠️ 可选：老数据没有这个键；缺字段 = 没有标调试。
   */
  debugActions?: string[]
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
  /**
   * 标准正文。
   *
   * ⚠️ 这里原来还有一个 `name: string`。那个字段已经整个删掉了——平台侧没有
   * 任何东西读它，而一个审核者只有一份标准，所以它也区分不了什么。老记录里
   * 可能还带着这个键，**读取方一律忽略**（见 `Agent.reviewStandard`）。
   */
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
/**
 * 三条链路各有一套模版：执行 / 审核 / **聊天**（2026-09 加的第三份）。
 * 聊天那份是它自己的 ① 框架——任务那份含 run/对象头与判决契约，灌进聊天是错的。
 */
export type FirstSentenceKind = 'execute' | 'review' | 'chat'

/**
 * 三块各自的模版框（2026-10 三框改造）：① 框架 / ② 身份 / ③ 任务。
 * 与 `BLOCK_LABELS` 一一对应。
 */
export type TemplateBlock = 'frame' | 'identity' | 'task'

/** `GET /api/first-sentence/templates`：变量对照表 + 默认模版（按 kind × block）。 */
export interface TemplateVariable {
  name: string
  /** 属于哪一块的模版框（写错框会被当场拒）。 */
  block: TemplateBlock
  /** 哪些 run 能用（执行模版里写 `material` 是填错了）。 */
  kinds: FirstSentenceKind[]
  /**
   * 是不是多行的内容（界面上标「多行 / 单值」）。
   *
   * ⚠️ 它不代表"整段提示词"：**所有变量都只给内容**，标题、标签、
   *    材料标记都由模版写。
   */
  multiline: boolean
  /** 缺了会坏掉的那些——保存时就会拒。 */
  requiredFor: FirstSentenceKind[]
  label: string
}

/** 一条链路的三块模版原文（空串 = 平台默认）。 */
export interface BlockTemplates {
  frame: string
  identity: string
  task: string
}

/** `GET /api/agents`：列表 + 「新建任务的默认智能体」（D36）。 */
export interface AgentsPayload {
  agents: Agent[]
  /** null = 没设过（新建任务页退回列表里的第一个）。 */
  defaultAgentId: string | null
}

export interface TemplateKit {
  defaults: Record<FirstSentenceKind, BlockTemplates>
  variables: TemplateVariable[]
  /**
   * 当前生效的那几份（空 = 平台默认）。
   *
   * ★ 这是**全局配置**（D32）：一次设定，所有 agent 都按它来。
   *   所以它挂在这里，而不是挂在某个 agent 上。
   */
  current: {
    execute: BlockTemplates
    review: BlockTemplates
    /** 聊天那一份（老 daemon 不返回这个键 ⇒ `undefined` 按空处理）。 */
    chat?: BlockTemplates
  }
  /**
   * ★ 平台替你调整过什么（2026-09 三块组装 / 2026-10 三框改造：六个变量退役）。
   *
   * 库里的老模版里可能还写着 `{{instructions}}` / `{{prompt}}` 那六个——执行器渲染前
   * 会把它们摘掉（内容由平台组装），所以接口返回的 `current` 已经**是迁移后的样子**。
   * 这份报告说的是"摘了哪几个、哪几行成了空标题"，界面据此如实告诉使用者。
   *
   * ⚠️ 不报的话：他在设置里看到一份"写了却不起作用"的文本，而真正投递的是另一份。
   */
  adjustments?: Record<
    FirstSentenceKind,
    Record<TemplateBlock, TemplateAdjustment> | undefined
  >
}

/** 一次模版迁移动了什么。 */
export interface TemplateAdjustment {
  /** 摘掉了哪几个已退役的变量（按出现顺序、去重）。 */
  removed: string[]
  /** 摘完之后变成空标题的行（例如原来 `## 你的角色` 下面就是 `{{instructions}}`）。 */
  orphanLines: string[]
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
  /**
   * 这条是从哪个**本地技能目录**读进来的（Skills 页 →「设置」里勾的那些）。
   * `null` = 手装的或远端装的。
   *
   * ⚠️ 老 daemon 不返回这个字段 ⇒ `undefined`，按"不是从本地目录来的"处理。
   */
  localDir?: string | null
  /**
   * 现在还能不能在智能体上被选中。
   *
   * 手装与远端的**恒为 true**；来自本地目录的，在"目录取消了勾选"或"文件在源
   * 工具那边被删了"之后变 false——那条记录会留着（有智能体挂着它），但不再
   * 出现在可选项里。
   *
   * ⚠️ 判断一律写 `!== false`（老 daemon 没有这个字段 = 可以选），不要写
   *    `if (s.selectable)`——那会把老 daemon 下的所有 skill 都变成不可选。
   */
  selectable?: boolean
}

/** 一个被扫过的目录：里面有几个技能、什么东西被跳过了。 */
export interface ScannedDirInfo {
  /** 绝对路径。 */
  path: string
  /** 这个目录现在存在吗（不存在也能勾——可能还没建，或外置盘没挂上）。 */
  exists: boolean
  /** 目录里现在有几个技能（勾之前就该看得见；"里面没有 skill"是个有用的答案）。 */
  skillCount: number
  /**
   * 看到但**没当成技能**的东西（没有 SKILL.md、太深、版本库目录…）。
   *
   * ★ 必须一直跟着目录走，不能只在"刚勾完"那一下提示：实测 `~/.claude/skills`
   *   里有一个没有 SKILL.md 的空目录，使用者勾完看到"少了一个"，第二天再打开
   *   设置时那个解释如果没了，就只剩一个说不清的差额。
   */
  skipped: Array<{ rel: string; reason: string }>
}

/** Skills 页「设置」里那一个候选目录（daemon 内置表给的）。 */
export interface LocalSkillDirCandidate extends ScannedDirInfo {
  /** 稳定 id（`claude` / `codex` / `cursor` / `agents`），显示名在词表里。 */
  id: string
}

/** `GET /api/skills/local-dirs` 的回应。 */
export interface LocalSkillDirsState {
  candidates: LocalSkillDirCandidate[]
  /** 勾了的路径（绝对路径，已展开 `~`）。 */
  enabled: string[]
  /** 使用者自己填的、不在候选表里的路径。 */
  custom: ScannedDirInfo[]
  /**
   * 这一次读设置时对账的结果。
   *
   * ★ 它跟着**读设置**一起回来（而不是只在改勾选时）：设置这一屏要能自己说完整
   *   ——"勾了几个目录"与"其中哪两条没读进来"是同一个问题的两面。
   */
  report: ReconcileReport
}

/**
 * 一次对账的结果（勾选之后、或每次读列表时）。
 *
 * ★ 它存在的意义是"**别静默**"：跳过了什么、读不进来什么、为什么某条还留着，
 *   都必须能说出来。使用者勾了一个目录却少看到几个 skill 时，这份报告是他唯一
 *   的线索。
 */
export interface ReconcileReport {
  added: string[]
  updated: string[]
  removed: string[]
  keptBecauseUsed: Array<{ slug: string; dir: string; usedBy: string[] }>
  failed: Array<{ rel: string; reason: string }>
  skipped: Array<{ dir: string; rel: string; reason: string }>
  dirErrors: Array<{ dir: string; reason: string }>
  onDisk: Array<{ dir: string; slug: string }>
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
 * ⚠️ 这里原来是一个 `ToolWithMounts`（`Tool` + 接口算好的 `mountedBy`）。挂载能力
 *   撤掉之后它没有任何额外的字段，所以**类型删掉了**——多一层空壳只会让下一个
 *   读代码的人以为"工具还有挂载关系"这回事。
 */

/**
 * 一个对话（`Conversation`）。
 *
 * ⚠️ 这里**照抄协议里的形状**，但刻意不 import 协议包——与这个文件里其他类型
 *    同一条规矩（见上面关于 `api.ts` 不引 protocol 的那段说明）。
 */
export interface Conversation {
  id: string
  workspaceId: string
  agentId: string
  /**
   * 这个对话**额外带**的 skill（第一句话定下来，之后只读）。
   *
   * 选的是挂在某人身上的 skill 时这里是空的——那种情况下 skill 由执行者自己带着
   * （"选它 = 选那个人"）。有值时说明选的是**没人挂**的 skill，它跟着这个对话走。
   *
   * ⚠️ 老 daemon 不返回这个字段 ⇒ `undefined`，按"没有"处理（读的地方写 `?? []`）。
   */
  skillIds?: string[]
  title: string
  /** `null` = 让平台分配（`<workRoot>/chat-<对话 id>`）。 */
  workDir: string | null
  createdAt: number
  updatedAt: number
  lastTurnAt: number | null
  turnCount: number
}

/**
 * 对话里的一轮 + 回看它需要的几样东西。
 *
 * 后面那四样（`output` / `status` / `toolCount` / `durationMs`）**不是**存储里的
 * 字段，是服务端拼出来的视图：智能体的回复本来就住在它那条 run 的 messages 里，
 * 不另存一份。见 `GET /api/conversations/:id` 那段说明。
 */
export interface ChatTurnView {
  id: string
  conversationId: string
  seq: number
  userText: string
  runId: string | null
  createdAt: number
  error: string | null
  /** 那一轮的最后一段正文（取最后一条 text，与任务详情页同一规则）。 */
  output: string | null
  status: string | null
  toolCount: number
  durationMs: number | null
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
    /**
     * ★ 谁做的这条判决（D46）：`'human'`，或者**缺字段 / `'agent'`**（模型做的）。
     *
     *   阶段推导要用它——人工判「不通过」与审核者判「不通过」要给出**不同的
     *   那句话**，见 `lib/pipeline.ts` 里 `byHuman` 那一段。
     *
     * ⚠️ 这里**允许 `undefined`**，不是图省事：页面与 daemon 是两份产物，
     *    "重建前端 → 刷新页面"不带重启 daemon 是日常做法，所以这个页面**真的
     *    会**遇到不发这个字段的旧 daemon。缺字段按 `'agent'` 读——D46 之前的
     *    判决本来就全是模型做的，这个默认值是**对的**，不是将就。
     */
    source?: 'agent' | 'human'
  } | null
  /**
   * 这条判决**要求做的那个动作**的结果（没有动作 / 不是审核 run ⇒ `null`）。
   *
   * ★ 阶段推导要用它：判决通过 ≠ 事情做完了。动作还在跑就是「行动中」，
   *   失败了就是「行动失败」——过去这两种都显示成「已审查」（那是"判决已产出"
   *   的意思，不是"事情已成"）。
   */
  action: ActionView | null
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

/**
 * 一条**动作记录**在页面上的形状。
 *
 * ⚠️ 提到具名类型是**必须的**（不是审美）：它原来在 `RunSummary` 里内联写了一份、
 *    在 `StageInfo` 里又抄了一份。往 daemon 那侧加字段（`result` / `params` /
 *    `finishedAt` 就是这么加的）时，抄的那一份**不报错、只是看不到那个字段**——
 *    而"看不到"正好就是使用者报的那条「配了行动但看不见结果」。现在只有一份。
 */
export interface ActionView {
  /**
   * 动作类型（`<包 slug>.<动作名>`，如 `probe-tool.append-note`）——契约值，
   * 原样显示、不翻译。
   *
   * ⚠️ D41 之后**只有这一种形状**：平台的内置动作整组移除了，所以老工作区里
   *    存着的那几个裸名（`comment.create` 之类）只是历史值——它们会照原样显示，
   *    但没有任何包认领，界面也查不到 `summary`。
   */
  type: string
  status: string
  /** 失败原因；成功时为 null。 */
  error: string | null
  /**
   * 脚本回的**结果**：`{ ok, detail, exitCode, durationMs, dryRun }`。
   *
   * `detail` 是给人看的一句话——"这个动作到底做了什么 / 为什么没做成"。
   */
  result: Record<string, unknown> | null
  /** **合并后**的参数（bound 平台注入 / open 模型填 / 界面固定值）。 */
  params: Record<string, unknown>
  finishedAt: number | null
}

/**
 * 判决**触发的**动作：在 `ActionView` 之上带一个 `verdictId`。
 *
 * 界面靠它把动作挂回**产生它的那张判决卡**——"通过"与"通过之后做了什么"
 * 是同一件事的两半，分两处显示会让"通过但什么也没发生"看起来很正常。
 */
export interface VerdictActionView extends ActionView {
  id: string
  verdictId: string
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
  /**
   * ★ 这条判决是谁做的（D46）。**缺字段 ≡ `'agent'`**——D46 之前的判决全部是
   *   模型做的，所以老数据不用迁移，这里也必须允许 `undefined`。
   *
   * 界面靠它做两件事：判决卡上标出「人工」，以及把"人工裁决过"这件事
   * 说清楚（否则同一张卡上两条结论，读的人分不清哪条是模型哪条是人）。
   */
  source?: 'agent' | 'human'
  /** 人工裁决的理由原文（`source === 'human'` 时有值）。 */
  humanReason?: string | null
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

/**
 * `GET /api/runs/:id/files` 与 `GET /api/conversations/:id/files`
 * —— 工作目录里**一个目录**的直接子项。
 *
 * 两条路由返回同一个形状：一条按**某次执行**的目录问（任务详情右边那一栏），
 * 一条按**某个对话**的目录问（聊天右栏底部）。对话那条存在的理由是：一个对话
 * 可能还没有任何 run，而它的目录属于对话、不属于某一条 run。
 */
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
  /** 因为条数上限而没列全。 */
  truncated: boolean
  /**
   * 这个目录**存在吗**。
   *
   * ★ 与「存在但是空的」必须分开：对话刚建、第一轮还没跑时目录还没被建出来，
   *   而两者都是空列表——那两句话给出的下一步完全不同（"再等等" vs "它确实没
   *   产出"）。`undefined`（旧 daemon 不返回这个字段）按「存在」处理。
   */
  exists?: boolean
}
