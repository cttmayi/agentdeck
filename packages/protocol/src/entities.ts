import { z } from 'zod'
import {
  ActionPlane,
  ActionRefType,
  ActionStatus,
  ArtifactKind,
  AuthorType,
  CommentType,
  IssuePriority,
  IssueStatus,
  ReasonCode,
  RunFailureReason,
  RunKind,
  RunStatus,
  RunTrigger,
  VerdictConclusion,
  VerdictStatus,
} from './enums.ts'
import {
  ActionId,
  AgentGroupId,
  AgentId,
  ArtifactId,
  AuditId,
  BlobRef,
  ChatTurnId,
  CommentId,
  ConversationId,
  DeviceId,
  IssueId,
  ReportId,
  RunId,
  RuntimeId,
  SkillId,
  Ulid,
  VerdictId,
  WorkspaceId,
} from './ids.ts'
import { ActionRef, Finding } from './verdict.ts'

/** epoch 毫秒。全项目统一用整数时间戳，不用 ISO 字符串。 */
export const EpochMs = z.number().int().nonnegative()

// ─────────────────────────────────────────────────────────────
// 基础
// ─────────────────────────────────────────────────────────────

export const Workspace = z.object({
  id: WorkspaceId,
  name: z.string().min(1).max(100),

  // ── 第一句话的模版（D32）──
  /**
   * ★ 「第一句话」的模版——**全局配置，一次设定对所有 agent 生效**。
   *
   * 它**不是**每个 agent 一份：那段文字是"平台怎么把一次 run 交代给模型"的
   * 骨架，跟"这个 agent 是谁"是两件事。后者由 `Agent.instructions` 承担，
   * 而它会作为 `{{instructions}}` 插进模版里（D33）。
   *
   * 空字符串 = 用平台默认模版（`DEFAULT_TEMPLATES[kind]`，见
   * `packages/agent-core/src/first-sentence.ts`）。两者是**同一台渲染器**，
   * 所以"什么都不改"与"填入默认模版"渲染出来逐字节相同。
   *
   * 执行与审核各一份：审核那份多了材料、审核标准与判决契约，混在一起会让
   * 两条链路互相牵制。
   *
   * ⚠️ 写法与校验见 `validateTemplate()`：变量是 `{{name}}`，缺必需变量、
   *    写了不认识的变量、或用了另一条链路才有的变量，**保存时就被拒**。
   *    这里存的是原文（未展开），展开发生在执行器里——模型拿到的永远是
   *    "这一次"的值。
   */
  executeTemplate: z.string().default(''),
  /** 同上，审核那次用的。 */
  reviewTemplate: z.string().default(''),
  /**
   * 同上，**聊天**那一轮用的（① 框架）。
   *
   * ★ 聊天**不套任务模版**——那份是"被交代一件事"的工作说明书（身份行、材料、
   *   护栏、判决契约）。所以它有自己的 ①：默认很薄（"这不是派活" + 语言 + 技能
   *   清单）。空 = 平台默认。
   */
  /**
   * ⚠️ `optional()`：这是**后加**的字段，老 workspace 里根本没有它。
   * "缺省"与"空串"在读取侧是同一个意思（空 = 平台默认），所以不必逼所有夹具写它。
   */
  chatTemplate: z.string().default('').optional(),

  // ── 2026-10：② 身份 / ③ 任务 各自独立的模版框（三个老键是 ① 框架）──
  /**
   * 每条链路三块模版各一份。`executeTemplate` / `reviewTemplate` / `chatTemplate`
   * 这三个老键就是 **① 框架框**（改名会弄丢老 workspace 里已存的内容）；下面是
   * 后加的六个键：② 身份框（`{{identity}}` = 那个 agent 的指令 + 审核标准整块）、
   * ③ 任务框（`{{task}}` = 这次要干的事 + 材料/文件引用整块）。
   *
   * 空 = 平台默认（`DEFAULT_TEMPLATES[kind][block]`）。三块的内容仍由平台组装
   * （材料标记、标准合成这些安全件不交给模版），模版只决定位置、标题与包装。
   * 校验见 `validateTemplate(kind, block, text)`。
   */
  executeIdentityTemplate: z.string().default('').optional(),
  executeTaskTemplate: z.string().default('').optional(),
  reviewIdentityTemplate: z.string().default('').optional(),
  reviewTaskTemplate: z.string().default('').optional(),
  chatIdentityTemplate: z.string().default('').optional(),
  chatTaskTemplate: z.string().default('').optional(),

  /**
   * ★ 「新建任务」默认交给哪个智能体（D36）。
   *
   * 它是**全局单值**——"默认交给谁"本来就是一个选择，不是每个任务一份配置。
   * `null` = 没设过（新建任务页退回"列表里的第一个"）。
   *
   * ⚠️ 只能是 `role: 'executor'` 的 agent：审核者是被动的那一方，任务不会交给
   *    它执行。这条在写入口校验（`PUT /api/agents/default`）。
   *
   * ⚠️ 指向的 agent 被删掉之后，这个值会悬空。读的时候不清理（那要写库，
   *    而"读"这条路上不该有副作用），**用的时候按"等于没设"处理**——
   *    新建任务页于是退回第一个 agent，行为与没设过一样。
   */
  defaultAgentId: AgentId.nullable().default(null),

  /**
   * **全局 runtime 默认值**（2026-10）：agent 的 `runtimeKey` 写 `'default'` 时用它。
   *
   * 三级解析：`agent 的值 ⇒ 这个 ⇒ 启动时侦测到的第一个可用`。为什么要三级：
   *   · 使用者想"默认都用 claude"时不必逐个 agent 去改（一次设定，处处生效）；
   *   · 但某个 agent 要例外时必须能就地覆盖（所以 agent 的值优先）；
   *   · 而没设过的人不该被迫先做一次选择（所以缺省跟随侦测）。
   *
   * ⚠️ **空串/缺省 = 跟随侦测**，不是一个具体值。不要把侦测结果写进来：
   *    写进来的话，使用者换了一台机器（侦测结果变了）这份记录就成了**过期的**，
   *    而表现是"它还在用那个没装的 CLI"，看不出原因。
   */
  defaultRuntimeKey: z.string().optional(),

  /**
   * 界面语言（D39）。`'zh' | 'en'`，缺省 `'zh'`。
   *
   * ⚠️ 它存在 workspace 上而不是浏览器里，理由是**服务端也要知道**：第一句话模版
   *    里的语言指令（`{{language}}`）是 daemon 渲染的，两边不一致就会出现
   *    "界面英文、模型还是被要求用中文回答"。
   *
   * ⚠️ 它**只影响界面文字与那条语言指令**，不影响：契约值（`pass`/`comment.create`
   *    这类机器值永不翻译）、已经写进库的历史日志与通知（不重译）。
   */
  locale: z.enum(['zh', 'en']).default('zh'),

  /**
   * ★ claude 的 WebSearch / WebFetch 是否可用（2026-10，D77）。
   *
   * 这两个是 Anthropic **服务端**工具（`web_search_20250305`）——执行在 API
   * 服务器上，不在 claude code 本地。官方端点真执行；第三方 `/anthropic`
   * 兼容端点（DeepSeek / 阿里云百炼）暴露工具名但没有执行器，模型会**幻觉
   * 搜索结果**（编造"我搜索了…"+ 假条目）→ 死循环放大上下文 → thrashing
   * （主因是端点 usage 上报虚高，搜索只是放大器）。所以给一个**全局开关**：
   * `true`（默认）= claude 命令行不禁它们（能用搜索）；`false` = 追加进
   * `--disallowedTools`（搜索与抓取都禁，claude 退化为 Bash+curl 调研）。
   *
   * ⚠️ 默认开是刻意（尊重 WebSearch 功能，调研类任务是刚需；真出幻觉死循环
   *    再手动关）。开关只控制命令行禁不禁，不控制端点有没有执行器。
   *
   * ⚠️ `optional()`：**后加**的字段，老 workspace 里根本没有它（缺省 = 开）。
   */
  webSearchEnabled: z.boolean().default(true).optional(),

  createdAt: EpochMs,
  updatedAt: EpochMs,
})
export type Workspace = z.infer<typeof Workspace>

/**
 * 本机设备标识。**不是账号**——只表示"哪台机器"，
 * 既不承担鉴权，也不承担归属（归属由账号承担，D11/FR-AUTH-05）。
 */
export const Device = z.object({
  id: DeviceId,
  name: z.string().min(1).max(100),
  createdAt: EpochMs,
  lastSeenAt: EpochMs,
})
export type Device = z.infer<typeof Device>

// ─────────────────────────────────────────────────────────────
// Agent 与 Skill
// ─────────────────────────────────────────────────────────────

/**
 * Skill：可执行策略。
 * 携带三要素——审核标准 + 判决结构引用 + 允许执行的动作子集（FR-AGENT-02）。
 *
 * 注意 `verdictSchemaVersion` 是**引用**而非自定义 schema：
 * verdict 结构全局统一（D2），skill 不得声明自己的 schema（FR-REVIEW-11）。
 */
export const Skill = z.object({
  id: SkillId,
  workspaceId: WorkspaceId,
  /** slug 是权威名（FR-CLI-20）。 */
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'slug must be kebab-case'),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable(),
  /** SKILL.md 的正文（人可读的审核标准）。 */
  body: z.string(),
  /**
   * 支持文件：相对路径 → 内容（**UTF-8 文本**）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 它住在哪：正文与支持文件在**磁盘上**（2026-10 起）
   * ══════════════════════════════════════════════════════════════════
   *
   * `body` 与 `files` 的权威位置是 `<skillsRoot>/<slug>/` 下的真文件
   * （默认 `~/.agentdeck/skills`）：`SKILL.md` 是正文，其余是支持文件。
   * `skill.jsonl` 里那条记录**只留索引**（id / slug / 来源 / 版本 / 时间），
   * 读回时由 `store-file` 从磁盘补齐——**磁盘为准**，改文件就生效。
   *
   * 所以这两个字段在**索引记录里通常是缺的**（`undefined`），读路径上没有
   * zod 校验（`JSON.parse(...) as Skill`），落到用它的地方按 `?? {}` 处理即可。
   * 唯一例外是 `sourceRef` 以 `localdir:` 开头的技能（从使用者的本地技能目录
   * 读进来的）：它们的正文本来就以文件存在于别处，记录里**保留** `body`、不落盘
   * ——否则同一内容会有两个权威位置。
   *
   * 只支持文本：二进制（图片、字体、压缩包）会在**安装时就被拒绝并列出**，
   * 而不是装进来再在某个环节悄悄写坏。缺了支持文件的技能是坏的技能，
   * 所以宁可当场说清楚。
   */
  files: z.record(z.string(), z.string()).optional(),
  verdictSchemaVersion: z.number().int().positive(),
  /**
   * ⚠️ **这里原来有一个 `allowedActions`，已经搬走了**（D40 收口）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么"允许动什么"不该挂在 skill 上
   * ══════════════════════════════════════════════════════════════════
   *
   * skill 是**执行者干活时参考的资料**（`Agent.skillIds` 挂在执行者身上），
   * 而"判完之后允许动什么"是**这条链的权限**（`AgentGroup.allowedActions`）
   * ——两者挂在不同对象上。
   * 挂在 skill 上等于让一个资料包顺手决定了谁能改状态；更糟的是 D37 之后
   * 内联标准才是判断依据，动作白名单却还留在 skill 里，于是同一件事有了
   * **两个出处**（老数据的兼容路径正是靠这种并集工作的）。
   *
   * 它先是搬到 `Agent.allowedActions`（D40 收口），2026-10 又整个搬到
   * `AgentGroup.allowedActions`（动作属于链、不属于某个人），skill 只剩
   * "正文 + 支持文件"。
   * 老数据里这个键还在（整条记录以 JSON 存、读取路径上没有 zod 校验），
   * 读取方按"没有"处理即可——不需要数据迁移。
   */
  /** 来源：本地自有 / 从远端下载 / 使用者提炼（D80）。 */
  source: z.enum(['local', 'remote', 'mine']),
  /**
   * 下载来源标识（source 为 remote 时）。
   *
   * ⚠️ `mine`（使用者提炼，D80）的来源标识是 `mine:<slug>`——不依赖远端目录，
   *    版本号由 git 历史提供（skills-mine 根是 git 仓库，见设计文档 §7.3）。
   */
  sourceRef: z.string().nullable(),
  /**
   * 这份内容的**版本**（远端目录给的那个）。没版本时为 null。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么单独一个字段，而不是从 `sourceRef` 里解析
   * ══════════════════════════════════════════════════════════════════
   *
   * 远端装进来的 skill，`sourceRef` 形如 `remote:general-review@1.0.0`——
   * 版本确实在里面，但它是**给人看的来源标识**，不是结构化数据。
   * 拿正则去解析一个展示字符串，等于偷偷建了第二套真相：哪天改一下
   * `sourceRef` 的格式（它本来就只是"从哪儿来的"的描述），版本比较就会
   * **静默失效**，而界面会退化成永远显示"可以更新"或永远不显示。
   *
   * 界面要拿它和远端目录的版本比较，从而决定显示「安装」「已安装」还是
   * 「更新」——所以它得是一个能直接读的字段。
   *
   * 可选：老数据没有这个键（整条记录以 JSON 存，读取路径上没有 zod 校验），
   * 读出来是 `undefined`，按"没有版本"处理即可，不需要迁移。
   */
  version: z.string().nullable().optional(),
  createdAt: EpochMs,
  updatedAt: EpochMs,
})
export type Skill = z.infer<typeof Skill>

/**
 * 审核标准（D37）：**内联在审核者身上**的一条判断依据。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么它不再借住在 skill 里
 * ══════════════════════════════════════════════════════════════════
 *
 * 原来标准就是一份 skill（`Skill.body` + `allowedActions`），审核者"挂上"
 * 它才算能用——于是出现三个别扭的地方：
 *
 *   1. **概念没有自己的位置**。平台甚至拿"挂了几个 skill"当"有没有标准"的
 *      代理量（没挂就不派审核，提示语还得解释"审核标准就在 skill 里"）；
 *   2. **一段自己写的清单要走四道手续**：起 slug、写 frontmatter、安装、
 *      回来挂载。而它本质是一段文本 +"判完能做什么"；
 *   3. **可见性差**：审核者的判断依据藏在 Skills 页的一个 slug 后面。
 *
 * 现在标准是审核者自己的一等字段：**一段正文**（进第一句话的 `{{standards}}`）。
 *
 * ⚠️ **"名字"这个字段删掉了**（它一度是"名字 + 正文"）。它不承载任何东西：
 *    平台侧没有任何东西读它——不进 prompt（D35：`{{standards}}` 只给正文）、
 *    不进判决契约、不进审计、不进消息流、不进智能体列表；唯一读它的地方是
 *    智能体详情页那个徽标，而徽标就贴在同一份正文的正上方。它也没有可区分的
 *    对象：一个审核者只有**一份**标准，不像 skill 那样库里有很多份要互相区分
 *    （"按哪份标准判的"由"哪个审核者判的"回答，任务里记的是 `reviewerAgentId`）。
 *    而使用者手里那份实测名字是「通用审核」、正文第一行是「# 通用审核」——
 *    逐字节相同的一份重复拷贝，且那个名字来自平台内置那份标准的常量（该常量
 *    2026-09 随"标准并进指令"一起删了），没人选过它。
 *
 * ⚠️ **"允许动什么"不在标准里**（D40 收口搬走了，2026-10 起它住在
 *    `AgentGroup.allowedActions`）：判断依据与处置权限是两件事——分开放之后，
 *    改了标准正文与放宽了能动的范围在审计与界面上都能分开看。
 *
 * ⚠️ 与 `instructions` 的区别：`instructions` 是"这个 agent 的态度与角色"
 *    （进 `{{instructions}}`），标准是"它按什么判"（进 `{{standards}}`）。
 *    两者是两件事，别合并。
 */
export const ReviewStandard = z.object({
  /**
   * 标准正文。**进第一句话的 `{{standards}}`**，也是这份记录唯一的实质内容。
   *
   * ⚠️ 老数据里可能还有一个 `name` 键（删掉之前留下的）。整条记录以 JSON 存、
   *    读取路径上没有 zod 校验，所以读回来会带着它——**读取方一律忽略**，
   *    不需要数据迁移（与 `allowedActions` 搬走时同一个套路）。
   */
  body: z.string().min(1),
  /**
   * ⚠️ 这里原来有一个 `allowedActions`（老数据的只读兼容字段：动作白名单一度与
   *    判断依据合体存在标准里，D40 搬到 agent 上，本轮**整个能力撤掉**）。
   *     删除后老记录里仍带着那个键，由 daemon 启动时的一次性清理摘掉。
   */
})
export type ReviewStandard = z.infer<typeof ReviewStandard>

/**
 * Agent：可复用的 AI 协作者配置。
 *
 * **不是常驻进程**——只在被触发时执行。
 * 每个 agent 有**自己的** skill 子集与 tool 子集（FR-AGENT-03/12/17）。
 */
/** agent 的角色（D28）。 */
// ⚠️ `drafter` = **平台内置的起草者**（沉淀/skill 起草那条链用它，2026-10 定稿）。
//    加它的理由不只是"多一种角色"：起草者**绝不能被选去干业务活**（它的指令是
//    "你是 skill 作者"），而各处"选执行者/审核者"的判据写的都是 `role === 'executor'`
//    / `role === 'reviewer'` 这种**等值**判断 ⇒ 新成员天然被排除在外（这正是要的）。
//    反过来说：**谁要是把这类判据改成 `role !== 'reviewer'`，起草者就会漏进选择器**。
export const AgentRole = z.enum(['executor', 'reviewer', 'drafter'])
export type AgentRole = z.infer<typeof AgentRole>

/**
 * 智能体组的模式（第二轮，2026 续）。
 *
 * 现在只有 `'workflow'`（工作流模式 = 「执行 → 审核 → 行动」顺序链）。它是**枚举
 * 而不是字符串**：未来模式（会签 / 多执行者并行 / 多步链）是往这个枚举里加值，
 * 而不是发明新的表达方式（见 `AgentGroup.mode` 那段注释与设计稿 §15）。
 */
export const GroupMode = z.enum(['workflow'])
export type GroupMode = z.infer<typeof GroupMode>

export const Agent = z.object({
  id: AgentId,
  workspaceId: WorkspaceId,
  name: z.string().min(1).max(100),
  instructions: z.string(),
  model: z.string().nullable(),
  /**
   * 平台**内置**的 agent（2026-10：沉淀的起草者）。
   *
   * 内置的含义有两条，缺一不可：**不许删**（只允许「恢复成默认值」）、以及
   * **不参与业务选择**。为什么用标记而不是按名字/按 id 认：名字使用者能改，
   * 按名字认会在改名后失效，而失效的表现是"它又能被删/被选去跑业务任务"——
   * 一种**静默**且查起来很远的故障。
   *
   * ⚠️ 可选字段（老记录里没有）：老 data 目录读进来必须是"不是内置"，
   *    而不是读崩——所以它有默认值 `false`，不能写成必填。
   */
  builtin: z.boolean().optional(),
  /** runtime 描述表键（首版恒为 'claude'）。 */
  runtimeKey: z.string().min(1),
  /** 默认工作目录。使用者指定；平台不做仓库检出（D20）。 */
  workDir: z.string().nullable(),
  /** ★ 这个 agent 挂载的 skill 子集——不是全部可用 skill。 */
  skillIds: z.array(SkillId),


  /**
   * ⚠️⚠️ 这里原来有三个字段：`allowedActions`（行动权限）、`debugActions`（调试
   *     动作）、`actionParams`（动作的固定参数）。**整个能力已经从 agent 上撤掉**，
   *     三个字段一并删除——理由是**归属错了**，做法记在这里（它们是协议里的字段，
   *     删掉意味着老数据里还留着那几个键，由启动时的一次性清理摘掉）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么撤：它不属于某个人，属于**这条链**
   * ══════════════════════════════════════════════════════════════════
   *
   * "判完允许动什么"的语义是**这队人的活判过之后**允许做什么——挂在审核者身上时，
   * 同一个审核者在所有组、所有报告审核里只能共用同一份，唯一的出路是"这次任务
   * 覆盖"，而那是给归属错误打的补丁。
   *
   * 现在的**唯一权威**是 `AgentGroup.allowedActions` / `actionParams` /
   * `debugActions`（组页 ③ 行动），建任务时由 daemon 展开进 `Run.*`。
   * **动作只属于组。**
   *
   * ⚠️ 直接后果（刻意承担）：**报告摄取**（`POST /api/reports` → 给每个有判断依据
   *    的审核者各起一条 review run）不属于任何组，所以那条路上的白名单恒为空——
   *    报告审核**只能给结论**，触发不了任何动作。这与"聊天在结构上到不了动作"
   *    是同一套口径：进不了组，就进不了动作。
   */
  /**
   * ⚠️⚠️ 这里原来有一个 `toolIds`（挂载的工具包，D40）。**整个能力已经撤掉**，
   *     字段一并删除——理由与做法记在这里，因为它是**协议里的字段**，删掉它
   *     意味着老数据里还留着那个键。
   *
   * 撤掉的两步：先把界面入口撤掉（智能体详情里那个"可挂载的工具组"勾选栏），
   * 再把「被哪些执行者挂载」那一列撤掉。使用者的决定是"不需要，因为我已经移除了
   * 此功能"——于是服务端这一整套（字段、`PUT /api/agents/:id/tools`、执行时把
   * 包里的脚本复制进工作目录那一段）就没有任何调用方了。
   *
   * ★ **老数据不需要迁移**：`Agent` 是普通 `z.object`（**不是 `.strict()`**），
   *   多出来的键在解析时被丢掉，不会报错；agent 又是 append-only 的 JSONL，
   *   老行原样留着、新行不再写这个键。所以存储格式版本**不用**动。
   *
   * ⚠️ 想恢复这个能力的话，光把字段加回来不够：`executor.ts` 里那段"把挂载的
   *    脚本送进工作目录"是它的**唯一**用途，一起被删了。
   */

  /** 自定义环境变量。 */
  env: z.record(z.string(), z.string()),

  // ── 角色（D28） ──
  /**
   * 这个 agent 是干活的还是审的。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么用"角色 + 配对"取代原来那套路由配置
   * ══════════════════════════════════════════════════════════════════
   *
   * 原来一个 agent 上有四个互相牵扯的开关：`kindPatterns`（认哪些 kind）、
   * `kindSkillOverride`、`isFallbackReviewer`（兜底）、`autoReview`（执行后
   * 自动审）。它们合起来表达的意思其实只有两件事：
   *
   *   1. **这个 agent 是执行的还是审的**；
   *   2. **执行完由谁来审**。
   *
   * 把它拆成"角色 + 审核者配对"，配置从"填四个字段、其中两个是通配模式
   * 字符串"变成"选一个角色、挑一个名字"。**少了一个需要理解的概念，
   * 而且没有通配符要学**。
   *
   * 代价是失去了"按 kind 分派不同审核者"的能力。这是有意的取舍：
   * 那个能力要求使用者在建 agent 时就想清楚"哪些 kind 归谁"，
   * 而绝大多数用法里，审核者只有一个。
   */
  role: AgentRole,

  /**
   * 这个审核者按什么判（D37）。
   *
   * `null` = 没有标准。审核者没有标准 ⇒ **平台不会把产出交给它审**
   * （没有标准的审核不算审核）。
   *
   * ⚠️ **过渡期**：老数据的标准还在挂载的 skill 里（`skillIds`）。解析时有一条
   *    兼容路径（`resolveReviewStandard`）：没有内联标准但挂了 skill 时，用
   *    skill 的**正文**顶上，并在界面上提示迁移。这条路径是**为了不让已经建好的
   *    审核者停摆**，不是长期设计。
   *
   *    ⚠️ 它**只顶正文**（D40 收口）：动作权限不在 skill 上，也不在这个字段里
   *        ——它属于智能体组（`AgentGroup.allowedActions`）。
   *
   * ⚠️ 它对 `role: 'reviewer'` 才有意义，但**不禁止**执行者带着它：把角色从
   *    审核改成执行、再改回来时不该丢东西（与第一句话模版同一个理由）。
   */
  reviewStandard: ReviewStandard.nullable().default(null),

  /**
   * ⚠️⚠️ 这里原来有一个 `reviewerAgentId`（"由谁来审这个执行 agent 的产出"）。
   *     **概念整个移除**，字段一并删除——它是**协议里的字段**，删掉意味着老数据里
   *     还留着那个键（daemon 启动时按 `stripLegacyAgentFields` 摘掉）。
   *
   * 为什么移除：界面上那个设置早就拿掉了（2026-10），而它留下的唯一效果是**隐式**
   * 的——某个执行者跑完会自动被某个人审，这件事在界面上**完全看不见**。现在"谁审"
   * 只有一个出处：**智能体组**的审核者，建任务时展开进 `Run.reviewerAgentId`。
   *
   * ⚠️ `Run.reviewerAgentId`（run 上那个同名字段）**保留**：它是组把审核者交给链路
   *    的载体，语义是"**这一次任务**由谁审"，与本字段（"这个人长期由谁审"）是两件事。
   */
  /**
   * 私有归属（第二轮，2026 续）：**这个 agent 属于哪个智能体组**。
   *
   * ══════════════════════════════════════════════════════════════════
   * "私有"的确切含义（使用者拍板）
   * ══════════════════════════════════════════════════════════════════
   *
   * · 在智能体库里，但**不进全局列表**（`GET /api/agents` 过滤）、**不能被别的
   *   组引用**——它只属于 `ownerGroupId` 那个组；
   * · 执行/审核链路**复用现有机制**：store 层保持全量（`autoChainReview` 等
   *   内部链路按 id 找执行者/审核者），过滤只发生在**面向界面的路由层**；
   * · 与组同生命周期：删除组时按 `ownerGroupId` 级联删（不是按 `members` 删——
   *   顺手清掉"建了一半/被移走"的孤儿私有 agent）。
   *
   * ⚠️ 字段**在不在就是判据**：`undefined` = 全局智能体，有值 = 私有。可选，
   *   因为这是后加的字段（store 读取路径上没有 zod 校验，老记录没有这个键）。
   *   ⚠️ **归属不可改**：写入口不接受它（PATCH 未知字段拒绝），创建入口才收。
   */
  ownerGroupId: AgentGroupId.optional(),

  createdAt: EpochMs,
  updatedAt: EpochMs,
})
export type Agent = z.infer<typeof Agent>

// ─────────────────────────────────────────────────────────────
// AgentGroup（D70 增量添加）
// ─────────────────────────────────────────────────────────────

/**
 * 智能体组：一队有分工的 agent，是「执行 → 审核 → 行动」这条链的编队单位。
 *
 * ══════════════════════════════════════════════════════════════════
 * 增量添加：与老路径并行，老逻辑一行不改
 * ══════════════════════════════════════════════════════════════════
 *
 * ⚠️ 2026-10：这一节原来写的是"组是一条**另一条**入口，老路径（执行者的
 *    `reviewerAgentId` + 审核者的 `allowedActions`）原样保留、继续可用"。那两个
 *    agent 上的字段已经**整个撤掉**了（谁审、允许动什么只有组能回答），所以组
 *    不再是"另一条入口"，而是**唯一**的入口：
 *
 *    建任务时选一个组（`groupId`），daemon 在 `POST /api/runs` 写入前把组**展开**
 *    成 run 上的字段（`reviewerAgentId` / `allowedActions` / `actionParams` /
 *    `debugActions` / `maxReworks`），展开后跑的还是那条老链路——
 *    `autoChainReview` / `decideReview` / 返工逻辑一行不改（★ 只换了
 *    "这些字段的默认从哪来"）。展开点见 `apps/daemon/src/server.ts` 的
 *    `POST /api/runs`（`groupId` 分支）。
 *
 *    ⚠️ 没选组的任务（界面上"选单个智能体"那一档）就是**没有审核者**：这条路上
 *       没有任何东西能回答"谁审"（`Agent.reviewerAgentId` 撤掉之后，
 *       `Run.reviewerAgentId` 也只会是缺字段），daemon 会在派发前记一句
 *       "这条任务没有审核者，要自动审请建任务时选一个智能体组"。
 *
 * 为什么是 `members: AgentId[]`（列表）而不是 `executorId + reviewerId`（两个
 * 固定槽位）：未来多 Agent（多执行者 / 多审核者会签）是**加成员**而不是破坏
 * 形状。当前唯一受支持的形态由**组形态校验器**（`packages/domain/src/groups/
 * shape.ts`）决定：恰好 1 个执行者 + 恰好 1 个审核者。成员的角色从各自的
 * `Agent.role` 读，不在组上重复存——同一个 agent 的"身份"只有一份。
 *
 * 行动权限（`allowedActions` / `actionParams` / `debugActions`）挂在这里而不是
 * 审核者身上：它的语义是**这条链**的（"这队人的活判过后允许做什么"），不是审核者
 * 个人的。同一个审核者出现在不同组里，各自配不同的权限。
 *
 * ⚠️ `debugActions` 只在 daemon 侧展开时使用（组默认的调试动作）；`SubmitRunRequest`
 *    里没有对应的任务级覆盖字段，所以它不进请求体。
 */
export const AgentGroup = z.object({
  id: AgentGroupId,
  workspaceId: WorkspaceId,
  /**
   * 组的模式（第二轮，2026 续）。
   *
   * 「新建组可能有好几个模式」——现在只有**工作流模式**（`'workflow'` =
   * 「执行 → 审核 → 行动」的顺序链，1 执行 + 1 审核），它也是这轮唯一合法的值。
   * 模式决定**成员怎么组织、谁先谁后**（未来的会签 / 多执行者并行 / 多步链是
   * 同一个 `AgentGroup` 上的不同 mode，见设计稿 §10 / §15）。
   *
   * ⚠️ **省略即默认**：老记录没有这个键 = 工作流。mode 只在**创建时**写入，
   *   PATCH 不接受它（这轮唯一合法值，改了也没意义；未来模式出现时再放开）。
   */
  mode: GroupMode.optional(),
  name: z.string().min(1).max(100),
  /** 组成员（列表形状 = 未来多 Agent 的演进位）。当前形态：恰好 1 执行 + 1 审核。 */
  members: z.array(AgentId),
  /** 组规则：这队人判过后允许触发哪些动作（权威；展开进 `Run.allowedActions`）。 */
  allowedActions: z.array(ActionRefType),
  /** 组规则：动作的固定参数（D43；展开进 `Run.actionParams`）。 */
  actionParams: z.record(ActionRefType, z.record(z.string(), z.unknown())),
  /** 组规则：调试动作（判决引用这些动作时只记录、不跑脚本）。 */
  debugActions: z.array(ActionRefType),
  /**
   * 组规则：默认返工次数。
   *
   * `0–100` 的整数，或 `null` = **无限**（审核不通过就一直交回执行者重做，
   * 直到通过或交给人；会一直烧 CLI 额度，慎用）。任务级仍可覆盖。
   */
  maxReworks: z.number().int().min(0).max(100).nullable(),
  /** 停用 = 建任务时不可选（不删，保留历史）。 */
  enabled: z.boolean(),
  createdAt: EpochMs,
  updatedAt: EpochMs,
})
export type AgentGroup = z.infer<typeof AgentGroup>

/**
 * 判断一个 agent 是否认某个 kind。
 * 支持 `*`（全部）与尾部通配（`ci-*`）。
 */
export function agentMatchesKind(patterns: readonly string[], kind: string): boolean {
  for (const p of patterns) {
    if (p === '*') return true
    if (p.endsWith('*')) {
      if (kind.startsWith(p.slice(0, -1))) return true
    } else if (p === kind) {
      return true
    }
  }
  return false
}

// ─────────────────────────────────────────────────────────────
// Issue 与 Comment
// ─────────────────────────────────────────────────────────────

/** 指派对象：人（member）或 agent。 */
export const Assignee = z.object({
  type: AuthorType,
  /** type 为 `agent` 时是 AgentId；为 `member` 时是本机使用者标识。 */
  id: z.string(),
})
export type Assignee = z.infer<typeof Assignee>

export const Issue = z.object({
  id: IssueId,
  workspaceId: WorkspaceId,
  title: z.string().min(1).max(500),
  description: z.string(),
  status: IssueStatus,
  priority: IssuePriority,
  assignee: Assignee.nullable(),
  labels: z.array(z.string()),
  createdAt: EpochMs,
  updatedAt: EpochMs,
})
export type Issue = z.infer<typeof Issue>

export const Comment = z.object({
  id: CommentId,
  workspaceId: WorkspaceId,
  issueId: IssueId,
  authorType: AuthorType,
  authorId: z.string(),
  type: CommentType,
  content: z.string(),
  createdAt: EpochMs,
})
export type Comment = z.infer<typeof Comment>

// ─────────────────────────────────────────────────────────────
// Conversation / ChatTurn（聊天场景）
// ─────────────────────────────────────────────────────────────

/**
 * Conversation：一个**对话**（聊天场景的容器）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它是闭环的**旁路**，不是闭环的入口
 * ══════════════════════════════════════════════════════════════════
 *
 * 产品的脊柱是「派活 → 审核 → 判决 → 才动手」。聊天不在这条脊柱上：
 * 它没有判决，因此**不允许触发任何登记过的动作**（那些动作的门槛就是判决）。
 *
 * 两者之间唯一的桥是一个**使用者点一下**的动作（把对话预填进「新建任务」），
 * 而不是平台替使用者决定的——预填进去之后，审核者与动作白名单仍然要他自己
 * 在那一页确认。
 *
 * ══════════════════════════════════════════════════════════════════
 * 一个对话绑一个 agent，绑定之后不改
 * ══════════════════════════════════════════════════════════════════
 *
 * 上文的延续靠底层 CLI 的会话恢复（`--resume <sessionId>`），而那个 session
 * 属于**某一个 CLI 的某一次运行**。换一个 agent 去"接着聊"在语义上不成立：
 * 新 agent 拿不到那段会话，只能从头读一份文本——那与"新建一个对话、把上文
 * 粘过去"没有区别，却让人以为中间那一段是连续的。所以不提供换人：要换就新建。
 */
export const Conversation = z.object({
  id: ConversationId,
  workspaceId: WorkspaceId,
  /**
   * 这个对话固定的执行者。
   *
   * ⚠️ 只放**执行者**（`role: 'executor'`）。审核者不能被选来聊天：聊天不产出
   *    判决，让一个"按标准判事"的 agent 来闲聊，会让人误以为它说的话有判决的
   *    分量。写入口按角色拒绝。
   */
  agentId: AgentId,
  /**
   * 这个对话要**额外带上的 skill**（第一句话定下来，之后只读）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么对话自己要记一份 skill
   * ══════════════════════════════════════════════════════════════════
   *
   * 「新对话」那个下拉里，skill 是**执行者的另一条入口**：选一条挂在某人身上的
   * skill，就等于选那个人（性格与 skill 同源，不需要这里记什么）。
   *
   * 但装着的 skill 未必挂在谁身上，而使用者的要求是"**所有已安装的 skill 都要
   * 能选**"。那种 skill 没有"有它的执行者"可绑，于是它走另一条路：这次对话自己
   * 带着它——执行者仍是你选的那个人，skill 从这里注入。
   *
   * ⚠️ 因此 run 的 skill 集 = **执行者自己挂的 ∪ 这个数组**（`apps/daemon/src/chat.ts`）。
   *    不是替换：执行者身上那些是它的一部分，凭空丢掉等于悄悄缩小了它的能力。
   * ⚠️ 只读：不给它开 `PATCH`。与"一个对话绑一个执行者、中途不换"同一个口径——
   *    改了的语义是"这半场换了个人"，而前半场的上下文还留在那条 CLI 会话里。
   * ⚠️ 老记录没有这个键（`.default([])`）：那种对话就是"没有额外 skill"，不是
   *    "未知"，所以解析成一个空数组而不是拒绝。
   */
  skillIds: z.array(SkillId).default([]),
  /** 标题。缺省取第一句话的第一个非空行（可改）。 */
  title: z.string().min(1).max(200),
  /**
   * 这个对话的工作目录。
   *
   * 缺省 = daemon 按对话分配一个专属目录（`<workRoot>/chat-<对话 id>`），
   * 与任务的目录同级。可以改成任意路径——那是"把它接进我的仓库"这类用法，
   * 与任务里的语义一致。
   *
   * ⚠️ 说清楚它有多大的权：claude 用 `--permission-mode bypassPermissions`，
   *    而沙箱**默认是关的**，此时 run 以 daemon 进程的 OS 用户权限执行。所以
   *    "专属目录"只是**少一点误伤**，不是隔离。真要隔离得开沙箱，而那是整个
   *    daemon 的一个开关（不是 per-agent、也不是 per-conversation）。
   */
  workDir: z.string().nullable(),
  createdAt: EpochMs,
  updatedAt: EpochMs,
  /** 最后一轮的时间；列表按它倒序。 */
  lastTurnAt: EpochMs.nullable(),
  /**
   * 轮次计数。
   *
   * ★ 它是**冗余**的（turns 数得出来），但列表要为每个对话显示它，而列表里
   *   逐个去数轮次等于 N+1 次读。冗余字段的风险是"某条路径忘了更新"，所以
   *   它只在**追加一轮**那一处写（`insertChatTurn` 之后由 daemon 一起更新）。
   */
  turnCount: z.number().int().nonnegative(),
})
export type Conversation = z.infer<typeof Conversation>

/**
 * ChatTurn：对话里的**一回合**——使用者说的一句话 + 它换来的那条 run。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么智能体的回复**不在这里**再存一份
 * ══════════════════════════════════════════════════════════════════
 *
 * 它就是 `runId` 那条 run 的 messages：已经落盘、已经有单调 seq、已经有流式
 * 广播、已经进审计与成本统计。再存一份等于同一件事有两个真相，而两个真相
 * 迟早会分叉——分叉的表现是"回看时聊天的记录和日志对不上"，且无从判断哪个对。
 *
 * `seq` 是这个对话内的序号（1 开始），用来把轮次与（可能缺失的）run 排序。
 */
export const ChatTurn = z.object({
  id: ChatTurnId,
  workspaceId: WorkspaceId,
  conversationId: ConversationId,
  /** 对话内序号，从 1 开始，单调递增。 */
  seq: z.number().int().positive(),
  /** 使用者说的那一句（原文，不加工）。 */
  userText: z.string().min(1),
  /**
   * 这一轮对应的 run。
   *
   * `null` = **还没建起来**（建 run 那一刻被并发槽位/目录锁挡下了）。留着这条
   * 记录而不是丢掉，是因为"我说了这句话但它没跑起来"是使用者必须看到的一件事
   * ——丢了它就变成"我说的话消失了"。
   */
  runId: RunId.nullable(),
  createdAt: EpochMs,
  /** 建 run 失败时的原因原文（成功则 null）。 */
  error: z.string().nullable(),
})
export type ChatTurn = z.infer<typeof ChatTurn>

// ─────────────────────────────────────────────────────────────
// Report（第三方进来的不可变快照）
// ─────────────────────────────────────────────────────────────

/**
 * Report：外部产物的**不可变快照**（DR-1）。
 *
 * `dedupKey` 是平台侧的**正确性保证**：即使第三方适配器返回重复数据，
 * 也不会重复审核（FR-REPORT-03、D14）。
 */
export const Report = z.object({
  id: ReportId,
  workspaceId: WorkspaceId,
  /** 来源插件标识。 */
  source: z.string().min(1),
  /** 第三方在该来源内的标识。 */
  externalId: z.string().min(1),
  /** 类型键——同时是路由键与审核标准选择键（D24）。 */
  kind: z.string().min(1),
  title: z.string().max(500),
  /** 审核对象正文（首版不做结构化解析，整段交给 agent）。 */
  body: z.string(),
  /** 第三方附加的原始元数据，原文保留。 */
  meta: z.record(z.string(), z.unknown()),
  /** 内容寻址引用，指向不可变快照。 */
  blobRef: BlobRef,
  /** sha256(source + externalId + contentHash)。 */
  dedupKey: z.string().min(1),
  ingestedAt: EpochMs,
})
export type Report = z.infer<typeof Report>

// ─────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────

/** 审核对象。 */
export const SubjectRef = z.object({
  /**
   * ⚠️ 加 `'conversation'` 是为了让**聊天那一轮的 run 也有一个 subject**。
   *
   * 它不参与闭环：报告摄取（`POST /api/reports`）只认 issue/report/run，
   * 一条 subject 是对话的 run 永远走不到审判那一步。但工作目录的分配
   * （`workdir.ts` 的 `<workRoot>/<type>-<id>`）与"同一 subject 的并发串行化"
   * 都按 subject 走——不认它，聊天就只能显式传一个 workDir，而那会让
   * "默认给个专属目录"这件事从平台默认退化成调用方的责任。
   */
  type: z.enum(['issue', 'report', 'run', 'conversation', 'skill-draft']),
  id: z.string(),
  /**
   * D80 界面改版（2026-10-19）：`skill-draft` 起草 run 记**它从哪条 run 发起**
   * （对话 = 那一轮的 run，任务 = 任务执行 run）。这是"恢复进行中的起草"的前提
   * （重开流程页按它找最近未入库的草稿，§4.1.1）。
   *
   * ⚠️ 只在 `skill-draft` 上带；其他 subject 缺字段。`conversation` 场景一个
   * 会话有多轮（多条 run）——查找时按会话的所有轮次 runId 匹配（见
   * `crystallize.ts` 的 `activeDraft` 口径）。
   */
  sourceRunId: z.string().optional(),
})
export type SubjectRef = z.infer<typeof SubjectRef>

/**
 * D80（2026-10-19）：`skill-draft` 起草 run 的**沉淀目标**（它要把素材变成
 * 什么：新建 skill / 更新哪条 skill）。
 *
 * 记在 run 上，是"恢复进行中的起草"（§4.1.1）的配套：重开流程页把一条
 * 已完成待审阅的草稿**继续**到审阅/入库时，commit 需要目标（更新 = 复用原
 * id 进化；新建 = clash 判重），不能凭"用户这次又选了啥"猜——草稿当初是
 * 按哪个目标起草的，入库就得按哪个目标走。
 *
 * ⚠️ 只记提交需要的部分：`purpose`（只影响起草 prompt）不落库。
 */
export const CrystallizeTargetRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('new') }),
  z.object({ kind: z.literal('update'), skillId: z.string() }),
])
export type CrystallizeTargetRef = z.infer<typeof CrystallizeTargetRef>

/** run 使用的 skill 的**标识与来源**（不记版本、不记指纹，D9）。 */
export const SkillRef = z.object({
  id: SkillId,
  slug: z.string(),
  /** 含 `'mine'`（D80）：提炼的 skill 同样可以被注入，来源要如实带过去。 */
  source: z.enum(['local', 'remote', 'mine']),
})
export type SkillRef = z.infer<typeof SkillRef>

export const TokenUsage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /** 成本以**整数微美元**存储，避免浮点漂移（design §11.3）。 */
  costUsdMicros: z.number().int().nonnegative(),
  /** 成本来源：provider 上报的精确值，还是本地估算。 */
  costSource: z.enum(['provider', 'estimated']),
})
export type TokenUsage = z.infer<typeof TokenUsage>

/**
 * Run：一次具体执行记录。
 *
 * 关键点：
 * - `workDir` 由**使用者指定**，平台不做仓库检出（D20）；
 * - 同一 workDir 同时只允许一个 run，其余进入 `waiting_local_directory`；
 * - `derivedFrom` 记录派生来源，用于回路边界（INV-16）。
 */
/**
 * 投递档：三块怎么送出去（见 `Run.deliveryMode`）。
 *
 * 名字取 A/B 而不是语义名（`system-prompt` / `one-block`）是刻意的：这两个档的
 * 差别**只在投递形状**，用名字描述形状反而会让人以为内容也不同。
 */
export const RunDeliveryMode = z.enum(['A', 'B'])
export type RunDeliveryMode = z.infer<typeof RunDeliveryMode>

export const Run = z.object({
  id: RunId,
  workspaceId: WorkspaceId,
  kind: RunKind,
  status: RunStatus,
  agentId: AgentId,
  /**
   * 这条 run 走的**智能体组**（D70 增量添加）。
   *
   * `undefined` = 这条 run 不是从组创建的（★ 2026-10 之后它意味着**这条任务没有
   * 审核者**：界面上"选单个智能体"那一档，没有任何东西能回答"谁审"）。
   * 有值 = 建任务时选了组，daemon 在写入前把组展开成现有字段（`reviewerAgentId`
   * / `allowedActions` / `actionParams` / `maxReworks`）落库——组 id 只作**记录**，
   * 供"这条任务当时是哪队人"可回查，界面上也靠它在"这次由谁审"那一栏区分
   * "审核者来自组"与"这一次单独指定"。任务级覆盖（换人 / 改动作）后组 id 仍保留，
   * 覆盖体现在那几个展开出来的字段上。
   *
   * ⚠️ 用 `optional`（老 run 没有这个键）；"字段在不在"就是判据，与
   *    `deliveryMode` 同一个口径。
   */
  groupId: AgentGroupId.optional(),
  /**
   * 这条起草 run 是"按意见再改一版"来的，值是**上一版草稿的 run id**（2026-10-19 四轮 P1）。
   *
   * 为什么记在 run 上：审阅时要能"新旧并列对比"——知道上一版是哪个 run，才能把它的
   * 产出（`skill/` 目录）读出来做 diff。不记的话只能靠时间戳猜，而"哪一版是基于哪一版
   * 改的"恰恰是这个功能唯一的语义。
   *
   * 只有起草 run（`subject.type === 'skill-draft'`）会有它。
   */
  revisedFrom: RunId.optional(),
  /**
   * 这条 run 的**审核者覆盖**（见 `SubmitRunRequest.reviewerAgentId`）。
   *
   * 三态，缺一不可：
   *   - `undefined`（字段缺失，含 D41 之前的旧数据）⇒ 跟随执行 agent 配置的
   *     「由谁审它」；
   *   - `null` ⇒ 这次明确不自动审；
   *   - agent id ⇒ 这次由它审。
   *
   * 只有 `kind: 'execute'` 的 run 会用它（审核 run 自己是执行者派生出来的，
   * 不会再被审一次）。
   */
  reviewerAgentId: AgentId.nullable().optional(),
  /**
   * 这条 run 的**任务级动作白名单**（见 `SubmitRunRequest.allowedActions`）。
   *
   * 两条路都用同一个字段、同一个含义（"**这一次**允许触发哪些动作"）：
   *   - `kind: 'execute'` ⇒ 这是**决定**（新建任务页 ③）。缺字段 = 跟随那个
   *     审核者的「行动权限」；
   *   - `kind: 'review'`（由执行 run 串接派生出来那条）⇒ 这是**决定被带下来**：
   *     判决契约里列哪些动作、判决收口时按哪份白名单校验，都用它。缺字段 =
   *     跟随这个审核者自己的权限。
   *
   * 为什么不是两个字段（一个"覆盖"、一个"生效"）：那是同一个决定的两站路程，
   * 而两个名字会让"审核用的是哪一份"变成需要推理的事——它必须一眼可见。
   */
  allowedActions: z.array(ActionRefType).optional(),
  /**
   * 这条 run 的**任务级动作固定参数**（见 `SubmitRunRequest.actionParams`，D43）。
   *
   * 与 `allowedActions` 同一条规矩、同一个判据（字段在不在）：
   *   - `kind: 'execute'` ⇒ 这是**决定**（新建任务页 ③ 上设的那份）。缺字段 =
   *     跟随那个审核者的长期固定参数（`Agent.actionParams`）；
   *   - `kind: 'review'`（由执行 run 串接派生出来那条）⇒ 这是**决定被带下来**：
   *     判决契约、判决校验、动作执行都用它。缺字段 = 跟随审核者自己的。
   */
  actionParams: z.record(ActionRefType, z.record(z.string(), z.unknown())).optional(),
  /**
   * 这条 run 的**任务级调试动作**（D70 增量添加，与 `allowedActions` 对称）。
   *
   * 调试动作 = 判决引用它时**不跑脚本**、只记录动作与解析后的参数
   * （`Agent.debugActions` 的语义）。老路径没有任务级覆盖：审核 run 的调试
   * 集合从审核者 agent 取（`executor.ts` 的 `effectiveDebugActions`）。组展开
   * 时组的 `debugActions` 落在这里，读取方优先它、缺省回退到审核者自己——
   * 与 `allowedActions` 同一套"字段在不在就是判据"的口径。
   *
   * `undefined` = 跟随审核者的 `Agent.debugActions`。
   */
  debugActions: z.array(ActionRefType).optional(),
  /**
   * 这条 run 的**任务级返工次数**（见 `SubmitRunRequest.maxReworks`，D45）。
   *
   * 语义：审核判 `fail` 时，把审核意见交回执行者重做，最多这么多次。
   * `0` 或**缺字段** = 不返工，`fail` 直接交给人（看板「等待人处理」）；
   * `null` = **无限**（一直返工到通过或交给人——会持续烧 CLI 额度，慎用）。
   *
   * ⚠️ 与 `chainDepth` 配合使用：`chainDepth` 是**已经**返工了几次（每条返工 run
   *    在前一条的基础上 +1），这个字段是**允许**几次，两者一比就知道还有没有额度。
   *    这里**不额外记一个 `usedReworks` 计数器**——同一个事实有两个出处时，
   *    "哪个说了算"就只能靠注释记住（`reviewStandard.allowedActions` 那次搬家
   *    正是踩了这个）。
   */
  maxReworks: z.number().int().min(0).max(100).nullable().optional(),
  subject: SubjectRef,
  trigger: RunTrigger,
  /** 由哪个 action 派生；根 run 为 null。 */
  derivedFrom: ActionId.nullable(),
  /** 链路深度，用于 INV-14。 */
  chainDepth: z.number().int().nonnegative(),
  skillRefs: z.array(SkillRef),
  workDir: z.string().nullable(),
  /**
   * 这一条 run 的投递档（2026-09 三块组装）。
   *
   *   · `A`：①②（框架 + 身份）走**系统提示**，③（任务）走用户消息；
   *   · `B`：三块合成**一段**（runtime 没有系统提示时的兜底）。
   *
   * ★ 为什么要记在 run 上：同一个模版在两个 runtime 上投递形状不同，而"两边都不
   *   报错"是这个仓库被咬过三次的形状（能力标志、旧前端、以及这次）。记下来之后
   *   "这条 run 当时是怎么送的"是一句可查的话，不必去猜或翻日志。
   * **缺省** = 这条 run 早于这个字段（老数据），不是"没有投递档"——所以用
   * `optional`（与 `allowedActions` 同一个口径：字段在不在本身就是判据）。
   */
  deliveryMode: RunDeliveryMode.nullable().optional(),
  /** `waiting_local_directory` 时携带被占用的路径，供 UI 显示。 */
  waitReason: z.string().nullable(),
  /**
   * 审核 run：**文件式审核**引用的两份落盘文件（`rounds/<轮次>-task.md` /
   * `-result.md`，§3.3b）。
   *
   * 判决不合规的重试从这里取材料（读结果文件），**不再读工作目录里的上下文副本**
   * （2026-09 产品决定：日志已含第一句话全文，执行/审核都不再写副本文件）。
   * 报告式审核没有这两份 ⇒ `null`；非审核 run 缺字段。
   */
  materialRefs: z.object({ taskPath: z.string(), resultPath: z.string() }).nullable().optional(),
  /**
   * 审核 run：**报告式审核**的报告正文（重试取材料就是它本身；文件式审核为
   * `null`）。与 `materialRefs` 同源同因——重试不读上下文副本了。
   */
  reportBody: z.string().nullable().optional(),
  sessionId: z.string().nullable(),
  attempt: z.number().int().positive(),
  maxAttempts: z.number().int().positive(),
  failureReason: RunFailureReason.nullable(),
  usage: TokenUsage.nullable(),
  queuedAt: EpochMs,
  dispatchedAt: EpochMs.nullable(),
  startedAt: EpochMs.nullable(),
  finishedAt: EpochMs.nullable(),
  /**
   * D80（2026-10-19）：`skill-draft` 起草 run 是否**已被确认入库**（`POST
   * /api/crystallize/commit` 成功时由 commit 路由置 true）。
   *
   * 只给 `skill-draft` 用。用途：`GET /api/crystallize/targets` 的 `activeDraft`
   * （"恢复进行中的起草"）要跳过**已入库**的草稿——不然每次重开流程页都会把
   * 上一条已经沉淀完的草稿再"继续"一遍。字段在不在就是判据（老 run / 非起草
   * run 缺字段），与 `deliveryMode` 同一口径。
   */
  crystallized: z.boolean().optional(),
  /**
   * 使用者**放弃**这条起草（沉淀任务）——三轮：起草 run 完成≠沉淀完成，没入库的
   * 草稿要能收尾，否则左栏只增不减。放弃后不进沉淀列表、也不再算「恢复进行中」。
   * 与 `crystallized`（成功入库）互斥语义上是两条路，但都只是"这条不用再管了"。
   */
  discarded: z.boolean().optional(),
  /**
   * D80（2026-10-19）：`skill-draft` 起草 run 的**沉淀目标**（新建 / 更新哪条），
   * 起草时随 `SubmitRunRequest.crystallizeTarget` 落库。恢复进行中的起草时
   * 按它还原目标，见 `CrystallizeTargetRef`。
   */
  crystallizeTarget: CrystallizeTargetRef.optional(),
})
export type Run = z.infer<typeof Run>

// ─────────────────────────────────────────────────────────────
// Verdict（持久化形态）
// ─────────────────────────────────────────────────────────────

/**
 * verdict 的持久化记录 = 判决本体 + 归属信息。
 *
 * `skillRefs` 固化"用了哪个 skill"（FR-REVIEW-06）。注意**不记指纹**，
 * 因此审计链是"可追溯"而非"完全可复现"（D9、§1.3）。
 *
 * ══════════════════════════════════════════════════════════════════
 * ★ `runId` 的语义：**这条判决归属的那条 run**（D46）
 * ══════════════════════════════════════════════════════════════════
 *
 * - `source: 'agent'` ⇒ 归属**产出它的那条 review run**（一直是这个意思）；
 * - `source: 'human'` ⇒ 人没有"产出它的 run"，所以归属**它裁决的那条 run**：
 *   有审核结论时是那条 review run（裁决的就是那份结论），没有审核结论时
 *   是最新那条执行 run（人看的就是那份产出）。
 *
 * 两条路**互斥且确定**，不是"视情况而定"：判据是"这条任务有没有已完成且
 * 带判决的 review run"，而那个判据只有一处实现（`apps/web/src/lib/pipeline.ts`
 * 的 `stageOf`）——界面把锚点算好传过来，daemon 只校验它能不能被裁决，
 * 不自己再算一遍（同一规则两处实现，正是这个仓库反复在防的那类缺陷）。
 */
export const VerdictRecord = z.object({
  id: VerdictId,
  workspaceId: WorkspaceId,
  runId: RunId,
  subject: SubjectRef,
  status: VerdictStatus,
  conclusion: VerdictConclusion,
  reasonCode: ReasonCode,
  confidence: z.number().min(0).max(1),
  findings: z.array(Finding),
  action: ActionRef.nullable(),
  escalateReason: z.string().nullable(),
  /** schema 校验失败时的处置（status 为 invalid 时有值）。 */
  invalidResolution: z.enum(['retry', 'downgrade_to_advisory', 'escalate']).nullable(),
  skillRefs: z.array(SkillRef),
  /** 决策依据的固化（FR-REVIEW-06）。 */
  modelId: z.string().nullable(),
  promptHash: z.string().nullable(),
  /**
   * ★ 这条判决是谁做的（D46）。
   *
   * - **缺字段 ≡ `'agent'`**：D46 之前的全部判决都是模型做的，所以老数据
   *   一个字都不用迁移。这里刻意用"字段在不在"而不是给一个 `default`：
   *   `default` 会在**写**的时候把值填进去，而我们要的是"读老数据时也成立"
   *   ——两件事，前者解决不了后者。
   * - `'human'`：人在任务详情页上给出的裁决（`POST /runs/{id}/human-verdict`）。
   *
   * ⚠️ **为什么不另立一个实体**：人工判决与模型判决的**形状是同一个**——
   *    结论、理由码、发现、动作、归属 run。差别只有"谁做的"这一项。另立实体
   *    意味着 store 端口、两套存储实现、审计导出、阶段推导全都要各写一遍，
   *    而两边一旦漂移，"判决"这个词在系统里就有两个意思了。
   *
   * ⚠️ **它是追加，不是覆盖**：人工裁决产生**新的一条记录**，模型那条原样留着。
   *    DR-3「历史不得被覆盖」在这里的具体含义是——"这条产出当初被模型判过
   *    fail、后来被人判 pass"这件事必须能从记录里读出来。谁最后生效由
   *    `createdAt` 决定（`listVerdictsByRun` 已按它排序，取末条）。
   */
  source: z.enum(['agent', 'human']).optional(),
  /**
   * 人工裁决的理由原文（`source === 'human'` 时有值，缺省 ≡ `null`）。
   *
   * ★ **为什么不塞进 `findings`**：`findings` 的契约是"判决**发现的问题**，逐条"。
   *   人工通过时并没有"发现的问题"，只有"我为什么认为它行"。塞进去之后，
   *   任何按 `findings` 做统计或展示的地方都会把人的一段话混进问题清单里——
   *   而那种错误不会报错，只会让数字悄悄变得没有意义。
   */
  humanReason: z.string().nullable().optional(),
  createdAt: EpochMs,
})
export type VerdictRecord = z.infer<typeof VerdictRecord>

// ─────────────────────────────────────────────────────────────
// Action
// ─────────────────────────────────────────────────────────────

/**
 * Action：由 verdict 触发的有界操作。
 *
 * `plane` **由注册表决定**（INV-13），落库时固化以便审计。
 * `idempotencyKey` 含 `verdictId` —— 同一 verdict 重放被去重，
 * 但**不同 verdict 产生的相同动作不会被去重**（否则多视角审核的
 * 第二次真实发现会被吞掉，见 design §10.3）。
 */
export const Action = z.object({
  id: ActionId,
  workspaceId: WorkspaceId,
  verdictId: VerdictId,
  /**
   * 实际执行的动作：`<包 slug>.<动作名>`（D41 起平台不内置任何动作）。
   *
   * ★ 这里也必须宽——否则"判决里写了工具动作、动作记录里却只剩内置枚举"，
   *   审计链会在最后一环断掉（而审计链正是这套东西存在的理由）。
   */
  type: ActionRefType,
  plane: ActionPlane,
  params: z.record(z.string(), z.unknown()),
  status: ActionStatus,
  idempotencyKey: z.string().min(1),
  /**
   * 没真跑、只记录（2026-09 起=「调试」）：审核者给这个动作勾了「调试」时，
   * 平台不执行脚本，只记录动作与解析后的参数；界面据此显示「调试 · 未执行」。
   * （它**不再**表示"预演"——那套作为执行准入的机制已经撤掉。）
   */
  dryRun: z.boolean(),
  result: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().nullable(),
  /** 可回滚动作的回滚凭据；不可回滚为 null（必须由注册表显式标注）。 */
  rollbackRef: z.string().nullable(),
  createdAt: EpochMs,
  finishedAt: EpochMs.nullable(),
})
export type Action = z.infer<typeof Action>

// ─────────────────────────────────────────────────────────────
// Artifact
// ─────────────────────────────────────────────────────────────

/** 产出物。宽而自由——与窄而闭合的 verdict 相对（P5）。 */
export const Artifact = z.object({
  id: ArtifactId,
  workspaceId: WorkspaceId,
  runId: RunId,
  kind: ArtifactKind,
  summary: z.string().max(500),
  blobRef: BlobRef,
  createdAt: EpochMs,
})
export type Artifact = z.infer<typeof Artifact>

// ─────────────────────────────────────────────────────────────
// Runtime
// ─────────────────────────────────────────────────────────────

export const Runtime = z.object({
  id: RuntimeId,
  workspaceId: WorkspaceId,
  /** runtime 描述表键（首版恒为 'claude'）。 */
  key: z.string().min(1),
  command: z.string().min(1),
  cliVersion: z.string().nullable(),
  /** 探测结果：本机是否装了它。 */
  available: z.boolean(),
  createdAt: EpochMs,
  lastProbedAt: EpochMs,
})
export type Runtime = z.infer<typeof Runtime>

// ─────────────────────────────────────────────────────────────
// Audit
// ─────────────────────────────────────────────────────────────

/**
 * 审计记录：可追溯性的全部要求（FR-AUDIT-01）。
 *
 * ⚠️ 它**不能**证明 skill 当时的具体内容——因为不记指纹（D9）。
 * 对外表述用"可追溯"，不是"完全可复现"。
 */
export const AuditRecord = z.object({
  id: AuditId,
  workspaceId: WorkspaceId,
  runId: RunId,
  subject: SubjectRef,
  /** 输入快照引用（内容寻址，不可变）。 */
  inputBlobRefs: z.array(BlobRef),
  skillRefs: z.array(SkillRef),
  runtimeDescriptorKey: z.string().min(1),
  cliVersion: z.string().nullable(),
  modelId: z.string().nullable(),
  promptHash: z.string().nullable(),
  /** 已脱敏的实际命令行：令牌类参数替换为 `***`。 */
  argvRedacted: z.array(z.string()),
  verdictId: VerdictId.nullable(),
  actionIds: z.array(ActionId),
  queuedAt: EpochMs,
  startedAt: EpochMs.nullable(),
  finishedAt: EpochMs.nullable(),
  usage: TokenUsage.nullable(),
})
export type AuditRecord = z.infer<typeof AuditRecord>

// ─────────────────────────────────────────────────────────────
// Skill 安装记录
// ─────────────────────────────────────────────────────────────

/** skill 下载记录：来源与保存位置（**不记版本、不记指纹**，D9）。 */
export const SkillInstall = z.object({
  id: Ulid,
  workspaceId: WorkspaceId,
  skillId: SkillId,
  sourceRef: z.string().min(1),
  installedAt: EpochMs,
})
export type SkillInstall = z.infer<typeof SkillInstall>

// ─────────────────────────────────────────────────────────────
// 通知中心
// ─────────────────────────────────────────────────────────────

/**
 * 通知中心的条目（FR-ISSUE-07/08）。
 *
 * ⚠️ **通知必须稀缺**（INV-8）。它只承载"需要人做决定"类事件——
 * 每跑完一个 run 就响一次的话，"人是例外通道"这条原则就白定了，
 * 使用者会重新变成通知队列的管理员。
 *
 * 所以 `severity` 的默认是 `info`，而真正需要动作的是 `action_required`。
 */
export const InboxSeverity = z.enum(['action_required', 'attention', 'info'])
export type InboxSeverity = z.infer<typeof InboxSeverity>

export const InboxItem = z.object({
  id: Ulid,
  workspaceId: WorkspaceId,
  /** 事件类别，用于订阅 / 静音（FR-ISSUE-08）。 */
  type: z.string().min(1),
  severity: InboxSeverity,
  title: z.string().min(1).max(200),
  body: z.string(),
  /** 相关对象（可空）。 */
  issueId: IssueId.nullable(),
  runId: RunId.nullable(),
  read: z.boolean(),
  createdAt: EpochMs,
})
export type InboxItem = z.infer<typeof InboxItem>
