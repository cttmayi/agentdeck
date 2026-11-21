import { z } from 'zod'
import {
  ActionRefType,
  ArtifactKind,
  AuthorType,
  CommentType,
  IssuePriority,
  IssueStatus,
  RunFailureReason,
  RunKind,
  RunStatus,
  RunTrigger,
} from './enums.ts'
import {
  ActionId,
  AgentId,
  ArtifactId,
  AuditId,
  BlobRef,
  ChatTurnId,
  CommentId,
  ConversationId,
  DeviceId,
  IssueId,
  MemoryEntryId,
  RunId,
  RuntimeId,
  SkillId,
  Ulid,
  VerdictId,
  WorkspaceId,
} from './ids.ts'

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
   * ★ 编排链路（2026-11）：编排的 agent（执行者/审核者）用的三块模版。
   * 编排 = 代码写死流程（框架 + 身份 + 任务就能跑），审核 run 的「任务」=
   * 被审产出（不加组跑那套"审核任务书"包装）。空 = 平台默认。
   */
  /*
   * ⚠️ 2026-11（D131）：这三个键是**编排那一档**的（框架 / 身份 / 任务）。两档合并——
   *   编排并进「任务」（`executeTemplate` 三键）——之后**没有代码再读它们**。
   *
   *   为什么字段还留着：删字段等于让老 workspace 整条读不出来（与 `reviewTemplate`、
   *   `role`、`allowedActions` 同一处置）。老库里存过的内容原样留着、不再投递；
   *   想恢复"编排单独一份模版"时，把这一段加回读路径即可（D131 里写了代价）。
   */
  workflowTemplate: z.string().default('').optional(),
  workflowIdentityTemplate: z.string().default('').optional(),
  workflowTaskTemplate: z.string().default('').optional(),

  /**
   * ★ 「新建任务」默认交给哪个智能体（D36）。
   *
   * 它是**全局单值**——"默认交给谁"本来就是一个选择，不是每个任务一份配置。
   * `null` = 没设过（新建任务页退回"列表里的第一个"）。
   *
   * ⚠️ **不能是平台内置岗位**（起草者 / 生成者那些）：它们干的是平台自己的活，
   *    不该被派用户任务。这条在写入口校验（`PUT /api/agents/default`）。
   *
   * ⚠️ 指向的 agent 被删掉之后，这个值会悬空。读的时候不清理（那要写库，
   *    而"读"这条路上不该有副作用），**用的时候按"等于没设"处理**——
   *    新建任务页于是退回第一个 agent，行为与没设过一样。
   */
  defaultAgentId: AgentId.nullable().default(null),

  /**
   * ★ 2026-11（D154）：**平台槽位表**——`槽位 → agentId`（四个出厂成员）。
   *
   * 为什么放在**工作区**上，而不放在 agent 记录上：
   *   · "平台那四条记录是哪四条"是**平台的知识**，不是记录的属性；
   *   · 写在记录上（老字段 `builtin` + `builtinKind`）会多出一个"写坏一半"的形态
   *     ——就是"半内置"：改不了、删不掉、岗位逻辑又认不出它是谁；
   *   · 放在这里之后，记录上只剩 `owner`（只读/可删）与 `entries`（谁能叫它），
   *     半内置在数据形态上**不可能出现**。
   *
   * 值域：`drafter` / `memory-tidy` / `agent-maker` / `workflow-maker`（退役的
   * `skill-reviewer` 不在里面——它归用户、可删，没有槽位）。
   *
   * ⚠️ 可选且可为空：老工作区没有这个键，启动对账会**从老字段把它补出来**
   *   （幂等）；缺一个槽位 = 那一条还没被认领，对账会建一条新的并把 id 写回。
   */
  platformSlots: z.record(z.string(), z.string()).default({}).optional(),

  /**
   * ★ 分批第 187 批（使用者：把 GitHub 加速器做成设置项，改完即时生效，不用重启 daemon）：
   * 装技能时走哪个加速器。**空 = 直连**（默认）。
   *
   * 它是**第三方**：能看也能改转发的内容。所以：默认关、只在显式设置时启用、
   * 走代理时不带我们的 token（`githubRequestTarget` 的三条硬规矩不变）。
   * 地址形如 `https://gh-proxy.org`（裸主机地址，不带路径）。
   */
  githubProxy: z.string().default('').optional(),

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
   * 沉淀 skill 时**起草 ↔ 审核自动循环**的轮次上限（2026-10-23，分批第 23 批）。
   *
   * 使用者原话：「我每次点反馈……多次循环，太麻烦。是否可以有设定可以 N 次，直到 PASS」。
   * 语义：一轮 = 起草 → 定检 → 审核 → 判决；判决 `fail` 且还有轮次 ⇒ 平台**自动**起下一版
   * （起草意见由判决的条目生成），`pass` 即停（一次就算，不做"连续两次"）。
   *
   * · `0` = **关**：每一轮判完就交给人（使用者手动点「反馈」的老行为）。
   * · 缺省（老数据）= 10：使用者定的默认值。也要注意它的代价——实测一条链 10 轮约 $30，
   *   而且每轮成本递增（上下文越滚越大），所以界面必须把"第几轮 / 已花多少"摆在结论条上。
   * · 上限 99：允许设得很大，但**不做**"无进展自动停"（使用者明确选了"只标注、继续跑到 N 轮"），
   *   所以这个数就是唯一的花钱闸门。
   */
  autoReworkRounds: z.number().int().min(0).max(99).optional(),

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

  /**
   * ★ 分批第 240 批：「记忆触发词」——聊天里以这些词开头的句子会被记进**正在聊的那个
   * 智能体**的记忆（全局设定：所有对话共用这一套）。
   *
   * 为什么是 workspace 级而不是每个 agent 一份：触发词是**人的措辞习惯**，不是 agent 的
   * 属性——你对着执行者、对着审核员说的是同一句"记住：以后报告都用中文"。做成每 agent
   * 一份的结果是"换个它就要换一种说法"，没人能解释为什么。
   *
   * ⚠️ **空数组 = 关掉这个功能**（不是"所有句子都算"）。缺省（老 workspace 没有这个键）
   *    等同平台默认（`DEFAULT_MEMORY_PREFIXES`，见 `apps/daemon/src/memory.ts`）。
   * ⚠️ 只认**开头**，不做语义猜测；前缀本身不写进记忆（存的是剥掉前缀那句话）。
   */
  memoryPrefixes: z.array(z.string().min(1).max(32)).max(12).optional(),
  /**
   * ★ 审核起草出来的 skill 时，**允许审核者真的执行草稿里的脚本**（§10.5 第 ③ 条，2026-10）。
   *
   * 老数据没有这个键 ⇒ **默认开**（与 `webSearchEnabled` 同一条规矩）。
   *
   * ⚠️ 为什么要有这个开关：这一跑是**在你自己机器上跑另一个 agent 刚写出来的代码**，
   *    而本项目不做沙箱隔离（NG7 是明确的范围决定）。出事时能一键关，比"改代码再重启"实际得多。
   * ⚠️ 关掉时**不是"让它照写不跑"**：提示词里那一段会换成"不要执行脚本"。否则审核者
   *    会以为自己跑过了，判决里会出现**没发生过的"已执行通过"**——那是假证据。
   */
  allowReviewerScriptRun: z.boolean().default(true).optional(),


  /**
   * ★ 默认工作守则（分批第 47 批）：新建智能体时**预填**到它的指令里。
   *
   * 使用者原话：「我想尽量往身份去放，让它尽量和执行者通用」，且在两个选项（A 只让内置
   * agent 共用常量 / B 让新建 agent 也带上）里选的是「A、B 都做」。
   *
   * 语义边界（三条，缺一条就会变成"看不见的魔法"）：
   *   ① **预填 = 文本拷贝**：新建那一刻把守则写进 `Agent.instructions`，此后它属于那条
   *      agent——改这个设置**不会**回头改已存在的 agent（否则使用者改过的身份会被悄悄覆盖，
   *      那是第 ⑥ 条一路禁止的事）；
   *   ② **空串 = 不预填**（新建的 agent 指令框留空，使用者自己写）；
   *   ③ **内置 agent（起草者/审核者）不读它**：它们的身份是平台常量 + 这份守则的**代码默认值**
   *      （`GENERAL_WORK_CONDUCT`）。让它们跟随这个设置的话，"存着的指令 === 已知历史"
   *      这条升级判据永远不成立 ⇒ 内置指令再也升不上来（审核者那边踩过三次）。
   *
   * ⚠️ `optional()`：后加字段，老 workspace 没有 ⇒ 缺省 = 平台默认守则。
   */
  defaultAgentConduct: z.string().optional(),

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
   * 它先是搬到 `Agent.allowedActions`（D40 收口），2026-10 又搬到
   * `AgentGroup.allowedActions`（动作属于链、不属于某个人），最后随**整个动作能力
   * 退场**（2026-11，D123）消失——skill 从一开始就只剩"正文 + 支持文件"。
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
 * ⚠️ **"允许动什么"不在标准里**：它一度搬到 `Agent.allowedActions`、再搬到
 *    `AgentGroup.allowedActions`，2026-11（D123）随动作能力整体退场——现在标准只
 *    回答"按什么判"，不再有任何处置权限。
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
/*
 * ⚠️ 2026-11（S4，D127）：这里原来是 `AgentRole`（`executor` / `reviewer` / `drafter` /
 *   `skill-reviewer` / `memory-tidy` / `agent-maker`）——**智能体的角色**。
 *
 *   **角色退场**：使用者拍板「智能体本身也不分『执行』与『审核』」，而审核 run
 *   （D125）退场之后，"执行者 / 审核者"这个区分已经**没有任何行为**挂着了。剩下
 *   那四个值是**平台内置岗位**（起草者 / 沉淀审核者 / 整理记忆 / 生成者）——它们
 *   与"角色"不是一回事：前者是"平台自己的活由谁干"，后者是"这个人能干什么活"。
 *
 *   所以两件事分开：
 *   · **角色**（谁能接任务、谁审谁）⇒ 删掉，用户建的 agent 就是 agent；
 *   · **内置岗位** ⇒ 变成 `Agent.builtinKind` 一个显式标记（只有平台建的那几条有）。
 *
 *   ⚠️ 当年那条"等值判断"的纪律值得记一笔：`role === 'executor'` 这种**等值**判断
 *   让新加的岗位天然落在业务选择之外，而 `role !== 'reviewer'` 会把它漏进选择器。
 *   **筛选用等值、不用不等值**——这条在 `builtinCandidates` 里仍然成立（现在筛的是
 *   `builtin !== true`）。
 */


/*
 * ⚠️ 2026-11（S3）：`GroupMode`（当时只有 `'workflow'` 一个值）随 `AgentGroup` 一起删。
 *   它当年留着的理由是"未来模式（会签 / 多执行者并行 / 多步链）是往枚举里加值，而不是
 *   发明新的表达方式"——那个未来落到了**编排**那边（`packages/orchestration` 的
 *   `flow` / `loop` / `parallel` / `route`），也就是用**代码**表达顺序，不需要一个
 *   枚举去描述它。
 */


export const Agent = z.object({
  id: AgentId,
  workspaceId: WorkspaceId,
  name: z.string().min(1).max(100),
  instructions: z.string(),
  /**
   * ★ 2026-11（D111）：`instructions.md` 里存的是**组装前**正文（内置 = 身份块，
   *   自建 = 使用者写的全文）；平台的工作守则（`withConduct`）在**运行时**拼。
   *   这个标记说"md 里已经是组装后的全文"——只有**老数据迁移**那一处会写 true
   *   （老记录里内置的指令是组装后的），读取端靠它决定**不要再拼一遍**（拼两遍 =
   *   守则出现两次）。新写的记录恒为 false。
   */
  instructionsAssembled: z.boolean().optional(),
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
  /**
   * ★ 分批第 245 批：**这个智能体的记忆功能开没开**。
   *
   * 关掉之后：不带入第一句话、不能手写、不能「整理成记忆」。已有的条目**不删**
   * （那是使用者的数据），只是暂时不用——再打开就照旧。
   *
   * ⚠️ 缺省（老记录没有这个键）= **开**。反过来（缺省关）会让所有现存智能体
   *    在某次升级后**静默失忆**——它们攒的东西还在，却突然不进第一句话了，
   *    而界面上没有任何一处变化能解释这件事。
   */
  memoryEnabled: z.boolean().optional(),
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
   * 之后那份配置短暂地住在**智能体组**上（`AgentGroup.allowedActions` 等三个
   * 字段），2026-11（D123）**随整个动作能力退场**——判决不再触发任何动作，所以
   * 现在既没有 agent 级也没有组级的动作配置。老数据里那几个键由启动时的一次性
   * 清理摘掉（`agent-legacy.ts` / `agent-legacy-cleanup.ts`）。
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
  /*
   * ⚠️ 2026-11（S4，D127）：这里原来是 `role: AgentRole`（"这个 agent 是执行者 /
   *   审核者 / 起草者 / …"）。**角色退场** ⇒ 删。
   *
   *   用户建的 agent 就是 agent——平台不再声称"这个人只能执行、那个人只能审"。
   *   那套区分在审核 run 退场（D125）之后已经没有任何行为挂着，留着它只会让界面
   *   问一个不影响任何事的问题。
   */

  /**
   * **平台内置岗位**（只有平台自己建的那几条有；用户建的 agent 恒缺字段）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 它与"角色"为什么不是一回事
   * ══════════════════════════════════════════════════════════════════
   *
   *   角色回答"这个人能干什么活"（谁能接任务、谁审谁）——那套已经删了。
   *   岗位回答"平台自己的活由谁干"：`drafter` = 沉淀那条链的起草者、
   *   `skill-reviewer` = 审起草出来的 skill、`memory-tidy` = 从对话里挑记忆、
   *   `agent-maker` = 帮人把一个岗位说清楚并写下来。
   *
   *   所以它**只在 `builtin === true` 时有意义**，而且 `builtinKindOf()` 的判据是
   *   **两个一起看**（`builtin` 标记 + 这个值）——只按名字或 id 认会在改名后失效，
   *   失效的表现是"它又能被删 / 被派去干业务活"，一种静默且查得很远的故障。
   *
   * ⚠️ 可选：老记录里没有这个键（它们有的是 `role`），读时兜底会把 `role` 映射成
   *    它并摘掉 `role`（`packages/protocol/src/agent-legacy.ts`）。
   */
  /*
   * ★ 2026-11（D135）：加了 `'workflow-maker'`（编排生成者——在聊天里问清楚要什么流程、
   *   把编排代码写成草稿，人采纳后存成一条编排）。
   *
   * ⚠️ 加一个值要动三处：这里、`apps/daemon/src/builtin-drafter.ts` 的 `BuiltinKind`
   *   + `builtinDefaultsOf`，以及前端 `apps/web/src/lib/api.ts` 的同名联合——漏一处
   *   就是"字段在、没路径"，或者更糟：界面按名字猜它是不是内置（本仓库明令禁止）。
   */
  builtinKind: z
    .enum(['assistant', 'drafter', 'skill-reviewer', 'memory-tidy', 'agent-maker', 'workflow-maker'])
    .optional(),
  /*
   * ⚠️⚠️ 2026-11（D154）：**这个字段已经不再是"归属"或"身份"的权威**，新记录**不写**它。
   *
   * 为什么挪走：`builtinKind` 原来有两份职责——"这条是不是平台的"（与 `builtin` 一起）
   * 和"它是哪一条"（平台流程按它找人）。前者已经归 `owner`；后者是一张**平台侧的引用表**
   * （`Workspace.platformSlots`：槽位 → agentId），不该写在记录身上：
   *   · 写在记录上就多出一个"写坏一半"的形态（就是"半内置"）；
   *   · 而"平台那四条是哪四条"本来就是**平台的**知识，不是记录自己的属性。
   *
   * 所以现在：**新记录只有 `owner` + `entries`**，槽位表在工作区上；老记录里的
   * `builtin` / `builtinKind` **原样保留、读时兜底**（回滚只需发旧版代码），
   * 由启动对账把它们的 id 填进槽位表。

  /**
   * **归属**（2026-11，D145）：这条记录是平台的，还是用户自己的。
   *
   * ⚠️ 为什么要它：`builtin`（是不是平台的）与 `builtinKind`（哪一条岗位）原来是**两个
   *   能各自变的字段**，而判据各摸一个（只读看前者、派活看后者）——手改一次数据就能造出
   *   "半内置"：改不了、删不掉，却被当成普通智能体派活。
   *
   *   现在 `owner` 是**"能不能改/删"的唯一判据**，`entries` 是**"谁能叫它"的唯一判据**，
   *   `builtinKind` 只剩"是哪一条"这一个职责（平台流程按它找人）。
   *
   * ⚠️ 可选：老记录没有它，`ownerOf()` 会**从老字段推**（`builtin === true` 且岗位值在
   *   ⇒ platform），迁移只把结果写进数据，不改行为、可回滚。
   */
  owner: z.enum(['platform', 'user']).optional(),

  /**
   * **接入点**（2026-11，D145）：谁可以叫它。多选，**封闭值域**。
   *
   *   · `chat`     —— 能当对话执行者
   *   · `task`     —— 能派业务任务 / 当默认执行者 / 出现在新建任务下拉
   *   · `workflow` —— 能被编排代码 `agent('名字')` 引用（候选名单**与**引擎解析两处都查）
   *   · `action:<id>` —— 某个平台动作会叫它（`skill-draft` / `memory-tidy` /
   *     `agent-draft` / `agent-commit` / `workflow-commit`）
   *
   * ⚠️ 可选。缺省按 `owner` 推：`user` ⇒ `['chat','task','workflow']`（三项全开）；
   *   `platform` ⇒ 出厂表 `PLATFORM_MEMBER_ENTRIES`（平台成员**默认不给 task/workflow**）。
   */
  entries: z.array(z.string()).optional(),

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
   *         ——那份权限本身已于 2026-11（D123）随动作能力整体退场。
   *
   * ⚠️ 2026-11（S4）：角色退场之后它只是一个**老数据的字段**——审核 run 退场
   *    （D125）之后没有"派审核"这回事，它现在唯一的作用是"搬家入口"
   *    （`POST /api/agents/:id/review-standard/adopt-from-skills` 把老标准并进
   *    「指令」）。字段留着是因为老记录里真有正文，删了就丢判断依据。
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
  /*
   * ⚠️ 2026-11（S3）：这里原来是 `ownerGroupId`——"这个 agent 属于哪个智能体组"
   *   （"私有成员"：不进全局列表、不能被别的组引用、删组时级联删）。组退场 ⇒ 字段删，
   *   老记录里那个键不会被读。
   *
   *   ⚠️ 那条设计里最值钱的一句留着：**归属是"创建时就定、之后不可改"的**（写入口
   *   只收不给改）。凡是"移动一次就会让历史数据的意思变掉"的关系，都该按这个办。
   */

  createdAt: EpochMs,
  updatedAt: EpochMs,
})
export type Agent = z.infer<typeof Agent>

// ─────────────────────────────────────────────────────────────
// AgentMemory（分批第 240 批）：一个智能体"攒下来的经验"
// ─────────────────────────────────────────────────────────────

/**
 * 一条记忆的**类型**。四种，每一种对应一种"以后会用到的判断"：
 *
 *   · `preference` 偏好——人要它怎么对待人（称呼、风格、不要什么写法）；
 *   · `fact`       事实——关于环境/项目的稳定事实（用哪个包管理器、报告落在哪）；
 *   · `lesson`     教训——踩过的坑（某个做法被判不过、被谁打回过）；
 *   · `commitment` 约定——答应过要做/不做的事（"这个仓库不碰 migrations"）。
 *
 * ⚠️ 这四种之外的都不要收：这一栏**不是日志**（"这一轮做了什么"属于 run 日志）。
 *    顺序也是注入时的优先级：`commitment > preference > fact > lesson`（见
 *    `packages/agent-core/src/memory.ts` 的 `MEMORY_KIND_PRIORITY`）。
 */
export const MemoryKind = z.enum(['preference', 'fact', 'lesson', 'commitment'])
export type MemoryKind = z.infer<typeof MemoryKind>

/**
 * 智能体记忆的一条记录。
 *
 * ══════════════════════════════════════════════════════════════════
 * 三条硬规则（它们是这个功能能安全存在的原因）
 * ══════════════════════════════════════════════════════════════════
 *
 * ① **只有人能写**：界面上只有两个写入口（详情页手写、聊天里前缀触发/整理这段），
 *    两者都是人打的字。agent 不能给自己写记忆——**记忆是唯一一处"改了它就会改变
 *    它下一次怎么干活"的文本**，让 agent 自己写等于让它给自己立规矩。
 *
 * ② **改 = 新增一条 + 删掉旧的**（不是原地修改）：所以这里没有 `updatedAt`，
 *    也没有"原文"字段。多次改就是多条记录，历史留在日志里（`removedAt` 只是打时间戳，
 *    **不真删**）。
 *
 * ③ **没有"停用/退役"状态**：久不用的条目会自己排到最后、预算不够时被裁掉
 *    （注入顺序里有 `lastUsedAt`），不需要一个状态字段——那是排序问题，不是状态问题。
 */
export const MemoryEntry = z.object({
  id: MemoryEntryId,
  workspaceId: WorkspaceId,
  agentId: AgentId,
  kind: MemoryKind,
  /**
   * 记忆正文。**要写成"下次也成立"的说法**（"这个仓库用 pnpm"），不是这一轮的现场
   * （"第 3 节缺来源"）。上限 400 字：它每轮都会被带进上下文，长度就是成本。
   */
  text: z.string().min(1).max(400),
  /**
   * 出处：这条记忆最初来自哪条 run（人从聊天里记下的、从"整理这段"勾的）。
   * 手写的那条没有出处。**只用于排查**，不进第一句话。
   */
  evidence: z.string().optional(),
  /**
   * ★ 分批第 252 批（使用者提的）：**人的原话**——这条记忆是从哪一句话来的。
   *
   * 「这个仓库用 pnpm，别用 npm」这句话可能被整理成一条 `fact`，也可能是同一个人在
   * 同一句话里说了两件事。记下原话之后，"同一句话被反复整理出好几条"这件事就**有据可查**：
   * 下一轮整理时按**原话**比对（而不是按正文措辞——中文改写之间几乎不可能精确重合），
   * 同一句原话已经产出过的条目会被标出来，默认不再勾。
   *
   * ⚠️ 手写的那条没有它（不是从某句话来的）；老记录也没有（可选）。
   * ⚠️ 上限按"一句人的话"来定，不按记忆正文的 400 字——那句话可能很长。
   */
  source: z.string().max(2000).optional(),
  /**
   * ★ 置顶 = "这条一定要带上"。预算紧张时**先保置顶的**，其余按类型优先级 + 最近用过裁。
   * 这就是"能不能调整顺序"这个需求的落地方式：不做拖拽排序，只给一个"必须带"的加权。
   */
  pinned: z.boolean().default(false),
  /** 被带进第一句话的次数（"这条记忆到底有没有用"的唯一证据，也是"久不用"的判据）。 */
  useCount: z.number().int().nonnegative().default(0),
  /** 最后一次被带进第一句话的时间；`null` = 从没用上过。 */
  lastUsedAt: EpochMs.nullable().default(null),
  createdAt: EpochMs,
  /**
   * 删除 = 打上时间戳。界面上只列 `removedAt === null` 的；
   * 记录本身留着（"这条曾经存在过、什么时候被谁换掉的"是可查的事实）。
   */
  removedAt: EpochMs.nullable().default(null),
})
export type MemoryEntry = z.infer<typeof MemoryEntry>

// ─────────────────────────────────────────────────────────────
// AgentGroup（D70 增量添加）
// ─────────────────────────────────────────────────────────────

/*
 * ⚠️ 2026-11（D125 之后，S3）：这里原来是 `AgentGroup` 实体——"一队有分工的 agent，
 *   是「执行 → 审核 → 行动」这条链的编队单位"（`id` / `mode` / `name` / `members` /
 *   `enabled`）。
 *
 *   **智能体组退场**：它存在的全部理由是"回答谁审、判完允许动什么"——而审核 run
 *   （D125）与动作能力（D123）都退场之后，组上**没有任何一件事**是别处回答不了的
 *   （`members` 就是几个 agent id，执行者由"这次派谁"直接指定）。
 *
 *   ⚠️ 老数据里的 `group` 记录原样留在磁盘 / SQLite 里：没有代码读它。
 *   `Run.groupId` 与 `Agent.ownerGroupId` 也一起撤了（它们是"我当时属于哪队"的记录，
 *   没有这一队了，记录就是悬空的）。
 *
 *   ⚠️ 那条设计教训留着：**`members: AgentId[]` 比 `executorId + reviewerId` 好**——
 *   前者要支持会签 / 多执行者时是"加成员"，后者是"破坏形状"。只是这个演进位
 *   最终没用上：真正需要多 agent 协作的是**编排**，而编排用代码表达顺序，不需要
 *   一个"组"的实体。
 */


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
  /**
   * 来源（2026-11，任务列表分组用）：定时任务触发生成的任务记着「哪个定时任务」，
   * 手动创建/其他途径为 null。
   *
   * ⚠️ 老数据（加字段之前落的盘）没有这个键：`default(null)` 让 zod 解析时补
   *    null（store-file 不走 zod，读取路径本来就是 JSON 直读——`source` 缺失 =
   *    undefined，前端统一按 `source?.kind === 'schedule'` 判断，两种缺法都安全）。
   */
  source: z
    .discriminatedUnion('kind', [
      z.object({
        kind: z.literal('schedule'),
        scheduleId: z.string(),
        scheduleName: z.string(),
      }),
      // ★ 2026-11：编排任务（任务 = 编排运行实例；列表按此识别"来自编排"）。
      z.object({
        kind: z.literal('workflow'),
        workflowId: z.string(),
        workflowName: z.string(),
      }),
    ])
    .nullable()
    .default(null),
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
/*
 * ⚠️ 2026-11（D125）：这里原来是 `Report` 实体——第三方报告在本机的**不可变快照**
 *   （`dedupKey` 是"同一条报告不会重复审核"的正确性保证，D14/FR-REPORT-03）。
 *
 *   **报告摄取整条链退场**：报告唯一的归宿是"起一条审核 run"，而审核 run 与判决
 *   也一起退场了（D125），所以投进来的报告只会落库然后什么都不发生——那正是本仓库
 *   最恨的形状（"东西在，没有路径让它发生"）。随之删掉的是：`Report` 实体与
 *   `ReportId`、store 的四个 report 方法、`domain/routing/kind.ts` 的
 *   `routeReportToReviewers`、daemon 的 `ingest.ts` 与 `POST /api/reports`、
 *   CLI 的 `reports` 命令、MCP 的 `submit_report`、页面轮询远端 `/api/pending`
 *   再推回本机的那一段、远端服务的 `/api/pending`。
 *
 *   ⚠️ 老数据不需要迁移：磁盘上 `report` 那一段没有代码再读它（也不删——删数据
 *   不可逆，而没有代码读它）。`SubjectRef` 的 `'report'` 枚举值**保留**：老 run 的
 *   subject 就长那样，删了会让整条老 run 读不出来。
 */

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
  //  `skill-draft-review` = **审核起草出来的 skill 的那条 run**（2026-10 §10 第 ②.5 步）。
  //  ⚠️ 它**不是**业务报告类 subject：不进任务列表、不挂 issue、不走 `ReportIngestor`
  //  ——与 `skill-draft` 同一条纪律（起草与审它，都不打扰任何人）。
  /**
   * ★ 分批第 243 批`'memory-tidy'`：「整理成记忆」那条**分析 run**。
   *
   * 与 `skill-draft` 同一条纪律：不在闭环里（`POST /api/reports` 不认这个 type）、
   * 不打扰任何人（不挂 issue、不进任务列表）。`id` 是**对话 id**（不是 run id）——
   * 因为"这条对话的整理"是一个可重入的操作：再点一次整理，取到的还是同一个
   * subject，于是并发串行化与工作目录都天然只有一份。
   */
  type: z.enum([
    'issue',
    /*
     * ⚠️ 2026-11（D125）：报告摄取退场之后**没有代码再写这个值**了——它原来是
     *   "审一份第三方报告"的 subject。老 run 里还有，删掉会让整条记录读不出来，
     *   所以枚举保留（与 `VerdictStatus.dispatched_to_action` 同一处理）。
     */
    'report',
    'run',
    'conversation',
    'skill-draft',
    'skill-draft-review',
    'memory-tidy',
    /**
     * ★ 分批第 260 批（「合并同类」）：把**某个智能体**现有记忆里同义的几条并成一条的分析 run。
     *
     * 与 `memory-tidy` 的区别：那个读的是**一段对话**（`id` = 对话 id），这个读的是
     * **它的记忆**（`id` = 智能体 id）。同样不在闭环里，同样不打扰任何人。
     */
    'memory-consolidate',
    /**
     * ★ 2026-11 设计定稿（`docs/design/recruiter-interview.md` §4.1.3 预留的变体）：
     * 「智能体生成者」产岗位卡的那条 run。与 `skill-draft` 同一条纪律：不在闭环里、
     * 不打扰任何人。`id` = **对话 id**（岗位卡是对话的产物，可重入：再跑一次取到的
     * 还是同一个 subject，工作目录天然只有一份）。
     */
    'agent-draft',
  ]),
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
  /**
   * ⚠️ **只剩读取兼容，不再有生产路径**（分批第 191 批，使用者："去掉起草智能体指令的
   * 功能，只需要起草新建或者更新现有 skill"）。
   *
   * 历史草稿的 run 记录里还躺着 `{"kind":"agent","agentId":"…"}`；把它从枚举里删掉会让
   * 那些记录的解析/迁移多一条岔路，而它们本来就要**能读出来再被过滤掉**（不进列表、
   * 深链不复活，见 `crystallize.ts` 的 `draftInfo`）。新增起草只会写 `new` / `update`。
   */
  z.object({ kind: z.literal('agent'), agentId: z.string() }),
])
export type CrystallizeTargetRef = z.infer<typeof CrystallizeTargetRef>

/** run 使用的 skill 的**标识与来源**（不记版本、不记指纹，D9）。 */
export const SkillRef = z.object({
  /**
   * 技能库里的 id。
   *
   * ★ 2026-11（D111）**允许为空**：智能体的**独有技能**（`agents/<id>/skills/`
   *   里的文件）不在技能库里，没有库 id——ref 只留 slug + `source: 'agent'`。
   *   老数据全是库技能（id 非空），所以可空不会破坏任何既有读路径。
   */
  id: SkillId.nullable(),
  slug: z.string(),
  /**
   * 含 `'mine'`（D80）：提炼的 skill 同样可以被注入，来源要如实带过去。
   * `'agent'`（D111）：智能体目录里那份独有技能（不是共享资产）。
   */
  source: z.enum(['local', 'remote', 'mine', 'agent']),
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
 *
 * ★ 2026-10（分批第 74 批）：A 档的"系统级通道"有**两条**——命令行旗标
 *   （claude `--append-system-prompt`，每轮重发，因为系统提示活不过 `--resume`）与
 *   **线程级指令**（codex `thread/start.baseInstructions`，建线程时一次）。
 *   所以看到 `'A'` 只说明"①② 与 ③ 分开送"，**送法**要看那个 runtime 的适配器日志
 *   （executor 的头行会写明"走系统提示（每轮重发）"还是"走线程级指令（建线程时一次）"）。
 */
export const RunDeliveryMode = z.enum(['A', 'B'])
export type RunDeliveryMode = z.infer<typeof RunDeliveryMode>

export const Run = z.object({
  id: RunId,
  workspaceId: WorkspaceId,
  kind: RunKind,
  status: RunStatus,
  agentId: AgentId,
  /*
   * ⚠️ 2026-11（S3）：这里原来是 `groupId`——"这条 run 走的智能体组"（D70）。
   *   **组退场** ⇒ 字段删（老记录里留着这个键不会被读：store 读取路径上没有 zod
   *   校验，未知键被忽略）。
   *
   *   ⚠️ 它当年的语义值得记一笔：`undefined` 曾经意味着"**这条任务没有审核者**"
   *   （选单个智能体那一档）。现在没有"谁审"这件事了，同一个键不再承载任何判断
   *   ——**一个字段的意思是随能力一起变的，撤能力时要把它的旧含义一起说清**，
   *   否则下一个人会照着老文档去读它。
   */
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
  /*
   * ⚠️ 2026-11（D125）：这里原来是 `reviewerAgentId`——"这一次由谁审我的产出"
   *   （三态：缺字段=跟随、`null`=明确不审、id=这个人）。**审核 run 与判决一起
   *   退场** ⇒ 平台不再派生审核 run，run 上也就没有"谁审"这件事。
   *
   *   ⚠️ 老记录里这个键留着不会被读（不需要迁移）；UI 上"谁审"那一栏也随之删。
   */
  /*
   * ⚠️ 2026-11（D123）：这里原来有三个字段——`allowedActions`（这次允许触发哪些动作）、
   *   `actionParams`（动作的固定参数）、`debugActions`（调试动作）。**动作能力退场**
   *   之后三者都没有消费者（判决不再触发动作、也没有动作执行器），整段删掉。
   *   老数据里那些键被忽略即可（删字段 = 老记录的那些键不再被读，与 `allowedActions`
   *   从 agent 搬走时同一个套路，不需要迁移）。
   */

  /*
   * ⚠️ 2026-11（D124）：这里原来是 `maxReworks`——"这条任务允许返工几次"
   *   （`0`/缺字段 = 不返工、`null` = 无限）。**返工整个退场**（使用者拍板
   *   "返工 = 去掉"）：审核判 `fail` 不再自动把意见交回执行者重做，判决只记录
   *   结论、由人（或编排）决定下一步。同一个事实原来是"额度 + 已用次数
   *   （`chainDepth`）"两个字段配合，现在两个都不需要了。
   *   老记录里那个键留着不会被读（不需要迁移）。
   */
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
  /*
   * ⚠️ 2026-11（D125）：这里原来是两个审核 run 专用字段——`materialRefs`（文件式
   *   审核引用的 `rounds/<轮次>-task.md` / `-result.md`）与 `reportBody`（报告式
   *   审核的正文），都是"判决不合规的重试从这里取材料"用的。
   *
   *   审核 run 退场 ⇒ 两者没有读者，删。**但那段落盘本身留着**——
   *   `rounds/<轮次>-task.md` / `-result.md` 是"执行任务与执行结果按轮次留档、
   *   后一轮不覆盖前一轮"（§3.3b），那是给人看的、也是给编排读的，与审核无关。
   */
  sessionId: z.string().nullable(),
  attempt: z.number().int().positive(),
  maxAttempts: z.number().int().positive(),
  failureReason: RunFailureReason.nullable(),
  /**
   * 失败时的**具体原因文字**（`RunFailure.message`）。
   *
   * ★ 与 `failureReason` 一起写、一起读：原因码回答"哪一类"（infra_error /
   * agent_error / …），这一条回答"到底发生了什么"（CLI 的原话、退出码、
   * stderr 尾部）。只有码没有字，界面就只剩「环境坏了」四个字，而真凶
   * （比如 Windows 上 codex 结尾退出码非 0 的具体报错）永远看不到。
   *
   * 老记录没有这个字段 ⇒ `optional()`（缺字段不是非法，是"还没记过"）。
   */
  failureMessage: z.string().nullable().optional(),
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
/*
 * ⚠️ 2026-11（D125）：这里原来是 `VerdictRecord`——审核结论的**持久化记录**
 *   （结论 / 理由码 / 置信度 / 发现 / 证据 / 归属 run / 谁做的）。
 *
 *   **审核 run 与判决一起退场**：平台不再为产出起一条"审核 run"，也就不再有
 *   "结构化判决"这个东西。使用者那句话是"智能体本身也不分『执行』与『审核』"
 *   ——要一个人把关，就由编排把把关这一趟写成一条**普通任务**交给某个智能体，
 *   它的答复就是答复，不再需要一个平台级的判决对象。
 *
 *   随之删掉的（协议这一侧）：
 *   · `packages/protocol/src/verdict.ts` 整份（判决 schema / `parseVerdict` /
 *     围栏标记 / `foldVerdict` / `stripVerdictBlocks`）；
 *   · `SubmitRunRequest.review`（"这是一条审核 run"的那份材料）；
 *   · `SubmitHumanVerdictRequest`（人工裁决）；
 *   · `/api/runs/:id/verdicts` 与 `/api/runs/:id/human-verdict` 两条路由；
 *   · `Run.reviewerAgentId` / `SubmitRunRequest.reviewerAgentId`（"这一次谁审"
 *     —— 没有审核 run，就没有"谁审"这件事；`AgentGroup` 上的成员还在，那是 S3
 *     的活）。
 *
 *   ⚠️ **两条老数据读法留着**（删了会让老记录整条读不出来）：`AuditRecord.verdictId`
 *   与 `VerdictStatus` 的枚举值。它们现在只服务历史——新记录永远不写。
 *   `AuditRecord.actionIds` 同理（D123 时已经变成恒空）。
 */

// ─────────────────────────────────────────────────────────────
// （原）Action —— 已退场（2026-11，D123）
// ─────────────────────────────────────────────────────────────
/*
 * 这里原来是 `Action` 实体：**判决触发的有界操作**那条记录（id / verdictId /
 * type / plane / params / status / idempotencyKey / dryRun / result / error /
 * rollbackRef）。动作能力退场之后它没有任何生产者——判决不再触发动作，审计里的
 * `actionIds` 恒为空，`listActionsByVerdict` 永远取不到东西。所以实体、`ActionStatus`
 * 生命周期枚举与 store 的那组方法一起删掉（"字段在、界面在、就是没有路径让它发生"
 * 是本仓库最恨的缺陷）。
 *
 * ⚠️ 仍然保留的**老数据读法**（见下面各处注释）：`AuditRecord.actionIds` 与
 *   `VerdictRecord.action` 是给**旧记录**读的（旧 run 的审计里可能真有点过的东西）。
 *   它们是只读的历史，不是能力。
 */

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
  /**
   * 这条 run 触发过的动作 id。
   *
   * ⚠️ 2026-11（D123）：**新记录里恒为空数组**——动作能力退场，没有动作可记
   *    （`ReviewCoordinator` 落审计时写的就是 `[]`）。字段保留是因为**旧审计记录**
   *    里可能真有点过的东西：删掉它，老数据会因为 schema 不认而整条读不出来。
   *    `ActionId` 也因此留在 `ids.ts`——它现在只为这一栏的老值服务。
   */
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
