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
  /** D77：claude 的 WebSearch/WebFetch 开关（默认开）。设置页据此渲染那个开关。 */
  webSearchEnabled?: boolean
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
  /**
   * ⚠️ 2026-10：这里原来有 `reviewerAgentId: string | null`（"由谁来审**这个执行
   *    agent** 的产出"）。那个字段连同概念一起撤掉了：**谁审由智能体组决定**
   *    （组里那个 `role === 'reviewer'` 的成员），而"挂在执行者身上"的那个字段
   *    造成了一条看不见的隐式链接——换个人审要去改**执行者**的设置。
   *
   *   所以这一版界面上没有"某人有一个人审它"这回事：`Agent` 上既没有这个字段、
   *    也没有替代品（新建任务选智能体组，组的成员才决定谁审）。run 上的
   *    `reviewerAgentId` 照旧（那是"这一次是谁审的"的**记录**，见 `RunRow`）。
   *
   * ⚠️ 与 `ownerGroupId` 那类"过渡期可选字段"不同，这里**不留一个可选字段**：
   *    留着它，界面就有机会去读一个服务端**永远不会再返回**的东西（读出来恒为
   *    `undefined`/`null`），于是"某个人被我配过审核者"这种错觉会从类型上看起来
   *    合法。
   */
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
   * ⚠️ 2026-10：这里原来有三个字段——`allowedActions`（"这个审核者判完之后允许触发
   *    哪些动作"）、它的固定参数 `actionParams`、以及调试勾选 `debugActions`。
   *    三个一起撤掉了：**动作属于智能体组**（`AgentGroup` 上那三个同名字段，
   *    组配置页 ③ 行动），不属于某个人。
   *
   *    为什么必须撤（而不是"以组为准、人也留一份"）：同一个审核者在不同组里本来
   *    就该配不同的权限，挂在人身上只能共用一份；而"以组为准"这种双重来源的后果
   *    是使用者改了其中一份、却看到另一份在生效——这类"哪份说了算"的问题只能靠
   *    注释记住，那正是当初把这份权限从审核标准里搬出来时想避免的事。
   */
  /**
   * 这个审核者按什么判（D37）。`null` = 没有标准（那它拿不到审核任务）。
   *
   * 校验在服务端：正文非空。
   */
  reviewStandard: ReviewStandard | null
  /**
   * 私有归属（第二轮）：有值 = 私有智能体（只属于 `ownerGroupId` 那个组）。
   *
   * ★ 字段**在不在就是判据**：`undefined` = 全局智能体。私有 agent 不进全局
   *   `GET /api/agents`（服务端过滤），只经组到达任务；随组删。
   *
   * ⚠️ 可选：旧 daemon 不返回它；缺字段 = 全局。
   */
  ownerGroupId?: string
}

/**
 * 智能体组（D70 增量添加）：一队 agent 的编队。
 *
 * 组是「执行 → 审核 → 行动」整条链的**默认配置单位**，与老路径（执行者「由谁审
 * 它」+ 审核者「行动权限」）并行：新建任务选了组，daemon 把组的默认展开成现有
 * 字段；老字段一行没改。
 *
 * 形态：**恰好 1 执行 + 1 审核**（`members` 是列表，但这一版只支持这一个形态——
 * 多执行者/多审核者是未来扩展，见 `packages/domain/src/groups/shape.ts`）。
 *
 * ⚠️ 这份类型只描述"界面要读写的那部分"；服务端才是权威（`AgentGroup` 实体）。
 */
export interface AgentGroup {
  id: string
  workspaceId: string
  name: string
  /**
   * 组的模式（第二轮）：现在只有 `'workflow'`（工作流模式 = 「执行 → 审核 →
   * 行动」顺序链）。⚠️ 省略即默认工作流（老组没有这个键）；mode 只在创建时写。
   */
  mode?: 'workflow'
  /** 组员 id（这一版恰好 1 执行 + 1 审核）。 */
  members: string[]
  /** 组默认的行动权限（省略时落进任务；任务级仍可覆盖）。 */
  allowedActions: string[]
  /** 组默认的固定参数（`动作名 → 参数名 → 值`）。 */
  actionParams: Record<string, Record<string, unknown>>
  /** 组默认的调试动作（`allowedActions` 的子集）。 */
  debugActions: string[]
  /** 组默认的返工次数：0–100，`null` = 无限返工（任务级仍可覆盖）。 */
  maxReworks: number | null
  /** false = 停用：新建任务时选不了它。 */
  enabled: boolean
  createdAt: number
  updatedAt: number
}

/**
 * `GET /api/agent-groups`：组的列表（第二轮起带成员）。
 *
 * `members` 是**全部组引用的成员**（含私有，去重后一张表）——界面按
 * `group.members`（id 列表）从这张表 join 名字/角色。私有成员不在全局
 * `GET /api/agents` 里，所以组自己的数据必须带它们，否则私有成员"查无此人"。
 */
export interface GroupsPayload {
  groups: AgentGroup[]
  members: Agent[]
}

/**
 * 私有成员的草稿（第二轮）：建组 / 改组请求里的 `createAgents` 数组元素。
 *
 * 组是私有智能体的**创建入口**——表单里"新建私有"攒下的这一份，随组请求一起
 * 交给 daemon（它建好 agent、`ownerGroupId = 组 id`、把新 id 并进 `members`）。
 * 表单收敛（使用者拍板）：名字 + 指令（执行者）/ 审核标准（审核者）+ runtime +
 * 可选技能。
 */
export interface GroupCreateAgentDraft {
  name: string
  role: 'executor' | 'reviewer'
  instructions: string
  reviewStandard: ReviewStandard | null
  runtimeKey: string
  skillIds: string[]
}

/**
 * 审核标准（D37）：**内联在审核者身上**的一条判断依据。
 *
 * ⚠️ **"允许动什么"不在标准里**（D40 收口搬走了，2026-10 起它住在**智能体组**上）：
 *    判断依据与处置权限是两件事——分开放之后，改了标准正文与放宽了能动的范围
 *    在审计与界面上都能分开看。
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
  // ⚠️ 2026-10：这里原来有一个 `allowedActions?: string[]`（"老数据的只读兼容字段"：
  //    动作白名单最早写在审核标准里，后来搬到 `Agent.allowedActions`）。搬家的中转
  //    字段一起撤掉了——动作现在只在组上，所以标准里既不读它也不写它。
  //    老记录里存着的那个键由服务端在启动时摘掉（`agent-legacy-cleanup.ts`）。
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
   * ⚠️ **这里原来有一个 `allowedActions`，已经搬走了**（D40 收口，2026-10 起
   *    权威是 `AgentGroup.allowedActions`）。
   *
   * "判完之后允许触发什么"不是一份资料包的属性——挂在 skill 上等于让"给执行者
   * 参考的东西"顺手决定了谁能改状态。老记录里这个键可能还在（整条记录以 JSON 存），
   * 界面按"没有"处理即可。
   */
  source: 'local' | 'remote' | 'mine'
  sourceRef: string | null
  /** 这份内容的版本（远端目录给的）。没有版本时缺失/null。 */
  version?: string | null
  updatedAt: number
  /**
   * 这条是从哪个**本地技能目录**装进来的（Skills 页 →「从本地安装」）。
   * `null` = 手装的、给路径装的、或远端装的。
   *
   * ⚠️ 它只是一个**来源标记**，没有任何"跟随磁盘"的语义：装完就是一条普通技能，
   *    正文在我们自己的 `~/.agentdeck/skills/<slug>/` 里。
   *
   * ⚠️ 老 daemon 不返回这个字段 ⇒ `undefined`，按"不是从本地目录来的"处理。
   */
  localDir?: string | null
}

/** 「从本地安装」页签里，某个目录中**发现的一个技能**。 */
export interface LocalSkillCandidate {
  /** 装到库里时的 slug（走与安装同一条解析规则得出）。 */
  slug: string
  /** 相对被扫的那个根目录的路径（`.system/skill-creator` 这种）。 */
  rel: string
  /** 技能目录的绝对路径——装的时候原样传回 `POST /api/skills/install`。 */
  dir: string
  /** 目录名。 */
  name: string
  /** SKILL.md frontmatter 里作者写的用途说明。 */
  description: string | null
  /** 库里已经有同 slug 的了 ⇒ 显示「已安装」并禁用按钮。 */
  installed: boolean
}

/** 「从本地安装」页签里被扫的一个目录（daemon 内置表给的）。 */
export interface LocalSkillScanDir {
  /** 稳定 id（`claude` / `codex` / `cursor` / `agents`），显示名在词表里。 */
  id: string
  /** 绝对路径。 */
  path: string
  /** 装的时候带回去当来源标记：`localdir:<path>`。 */
  sourceRef: string
  /** 这个目录现在存在吗（不存在 = 那个工具没装，或没建过技能目录）。 */
  exists: boolean
  /** 目录本身读不了的原因（不存在 / 没权限）；`null` = 读到了。 */
  error: string | null
  /** 里面发现的技能。 */
  skills: LocalSkillCandidate[]
  /**
   * 看到但**没当成技能**的东西（没有 SKILL.md、太深、版本库目录、解析不了…）。
   *
   * ★ 必须一直跟着目录走：实测 `~/.claude/skills` 里有一个没有 SKILL.md 的空目录，
   *   使用者打开这一屏看到"少了一个"时，解释必须就在这儿——不然他会去查权限、
   *   查扫描是不是坏了。
   */
  skipped: Array<{ rel: string; reason: string }>
}

/** `GET /api/skills/local-dirs` 的回应（只读扫描，不写库）。 */
export interface LocalSkillDirsState {
  dirs: LocalSkillScanDir[]
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
   * 这条 run 来自哪个**智能体组**（`null` = 没选组 / 组已被删；缺这个键 = 更早的
   * daemon，也按"没选组"处理）。
   *
   * ★ 页面用它说清"审核者是从哪来的"：组的审核者与"这一次单独指定"在
   *   `reviewer` 上长得一样（都有 `agentId`），但后续完全不同——一个随组走，
   *   一个只对那一条任务有效。
   *
   * ⚠️ 写成**可选**而不是 `string | null`：这一版 daemon 一定会回这个键（没组时
   *    是 `null`），但**更早的 daemon 没有它**，而这一页要跟不同版本打交道。
   *    对"来自哪个组"这件事，缺键与 `null` **后果相同**（都不是从组来的）——
   *    与 `Run.reviewerAgentId` 那种"缺键 ≠ null"的三态不同，所以这里可以合并。
   */
  groupId?: string | null
  /**
   * 这条**执行** run 的审核者（`kind !== 'execute'` 时为 `null`）。
   *
   * ★ 为什么不是 `string | null`：页面要如实显示"这条任务没人审"，而 `null` 这个值
   *   本身读不出这层意思（它长得像"没填"）。所以给一个带 `mode` 的小对象，让
   *   "没人审"是**说得出口的状态**。
   *
   *   `assigned` ⇒ 有审核者（**可能来自组**，也可能是这一次指定的——要区分看
   *                `Run.groupId`）；
   *   `none`     ⇒ 这条任务没有审核者。
   *
   * ⚠️ 2026-10：原来是**三态**（`follow` / `none` / `override`）。`follow` 那一态
   *    （"没点名 ⇒ 跟随执行者身上那条长期配置"）随 `Agent.reviewerAgentId` 一起
   *    撤销了——没有可跟随的东西，也就没有"跟随着谁"要显示。daemon 那边的投影
   *    同一时刻收成两态（见 `apps/daemon/src/server.ts` 的 `reviewer:` 那一段）。
   */
  reviewer: { mode: 'none' } | { mode: 'assigned'; agentId: string } | null
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
