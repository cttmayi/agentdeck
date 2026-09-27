import { z } from 'zod'
import { ActionRefType, RunFailureReason, RunKind, RunStatus, VerdictStatus } from './enums.ts'
import { AgentId, BlobRef, RunId, SkillId, Ulid, VerdictId } from './ids.ts'
import { EpochMs, Issue, SkillRef, SubjectRef, TokenUsage } from './entities.ts'

/**
 * 本地接口契约（daemon ↔ 同源页面）。
 *
 * 关键约束（FR-BRIDGE-08、D19）：
 * - daemon **不向 agentdeck 的远端服务**发请求；取 run、查第三方、上报记录、
 *   拉远端 skill 目录全部由页面代为发起；
 * - 页面与本地接口**同源**，因此不需要跨源协商。
 *
 * ══════════════════════════════════════════════════════════════════
 * 有一处例外，是刻意加的：从**路径 / GitHub** 安装 skill
 * ══════════════════════════════════════════════════════════════════
 *
 * `POST /api/skills/install` 由 **daemon 自己去读**本地路径或 GitHub 链接
 * （见 apps/daemon/src/skill-source.ts）。原因有两条，都不是"图省事"：
 *
 *   1. **本地目录路径只有 daemon 读得到。** 使用者在自己机器上开发技能，
 *      要装的就是 `/Users/me/dev/my-skill` 这种路径——页面读不了磁盘；
 *   2. GitHub 的跨源与私有仓库凭证在页面侧很难处理，而"下载到本地"这件事
 *      本来就发生在 daemon 所在的这台机器上。
 *
 * 这条例外**不涉及 agentdeck 的远端服务**（D20 那条规则仍然成立），
 * 但它是 daemon 第一次具备对外请求能力，所以边界写死在
 * `skill-source.ts` 里：**只允许 GitHub 的三个主机、只允许 https、
 * 限大小、限文件数、限超时**。要扩到任意 URL 得单独做，不能顺手放开。
 */

/** skill 内容由**页面**取好并内联——daemon 不访问网络。 */
export const SkillPayload = z.object({
  ref: SkillRef,
  slug: z.string().min(1),
  name: z.string().min(1),
  /**
   * 一句话说明这个 skill 是干什么的。
   *
   * ★ 它必须写进 `SKILL.md` 的 frontmatter。
   *
   *   CLI 自己扫技能目录时会生成一份**带描述的清单**（progressive disclosure：
   *   模型看描述决定要不要加载正文），而我们的 context 里只列 slug——所以
   *   **描述是 CLI 那份清单唯一的路由信号**。此前这个字段从来没被带到执行侧，
   *   于是写出来的 `SKILL.md` 只有 `name`：技能在 CLI 的清单里没有用途说明，
   *   模型基本不会主动选它。和"文件写下去了但没人读"是同一类失效。
   */
  description: z.string().optional(),
  /** 审核标准正文（SKILL.md 的内容）。 */
  body: z.string(),
  /**
   * ⚠️ **这里原来有一个 `allowedActions`，已经搬走了**（D40 收口）：装 skill
   * 不再携带"允许触发哪些动作"——那是**审核者**的能力（`Agent.allowedActions`），
   * 而 skill 是给执行者参考的资料包。老客户端传了这个字段也**不报错但会被忽略**
   * （它不是"装错了"，只是那一项不再属于 skill）。
   */

  /** 支持文件的相对路径 → 内容（UTF-8 文本）。可为空——只支持文本，见 `Skill.files`。 */
  files: z.record(z.string(), z.string()),
})
export type SkillPayload = z.infer<typeof SkillPayload>

// ─────────────────────────────────────────────────────────────
// 提交 run
// ─────────────────────────────────────────────────────────────

/**
 * `POST /runs`
 *
 * `runId` **由远端分配**（FR-BRIDGE-07）——这让"重复提交"成为可幂等的
 * 操作：页面崩溃重试、网络重发都不会产生第二个 run。
 */
export const SubmitRunRequest = z.object({
  runId: RunId,
  kind: RunKind,
  agentRef: z.object({
    id: AgentId,
    name: z.string(),
    instructions: z.string(),
  }),
  /**
   * 这次 run 要注入哪些 skill。
   *
   * ══════════════════════════════════════════════════════════════════
   * **可以省略** —— 省略时由 daemon 按该 agent 的配置解析
   * ══════════════════════════════════════════════════════════════════
   *
   * 这条改动的由来是一次真实的静默失效：页面在提交执行 run 时硬编码了
   * `skills: []`，于是**一个 skill 也没注入**，Claude 用的是它自己的默认
   * 行为——而"审核标准由 skill 决定"是这个产品的核心，等于整条审核链路
   * 退回了裸模型。
   *
   * 它没有任何报错：run 正常跑完、状态是 completed，只是做的事不是你要的。
   *
   * 根因不在那一行 `[]`，而在**"谁来解析 skill"这件事有两个答案**：
   * 服务端的 `createRunForReviewer` 会调 `loadAgentSkills(agent)`，
   * 而页面自己拼请求时**没有任何东西提醒它也要这么做**。
   *
   * 所以现在把解析权收归 daemon：省略这个字段就按 agent 解析。
   * 显式传空数组仍然表示"这次确实不要 skill"（那是合法意图），
   * 但 daemon 会在 agent 明明配了 skill 时发出警告——**不一致要说出来**。
   */
  skills: z.array(SkillPayload).optional(),
  subject: SubjectRef,
  prompt: z.string(),
  /**
   * 工作目录（D27）。
   *
   * **可以省略**——省略时由 daemon 按任务自动分配一个独立目录
   * （`<workRoot>/<subjectType>-<subjectId>`）。这是默认路径：绝大多数任务
   * 只是"让 agent 做点事"，不该逼使用者先想一个目录。
   *
   * 显式给出时按给出的用——那是"把 agent 接进我的仓库"这类高级用法，
   * 需要使用者自己承担"同目录串行化"的后果（FR-RUN-04）。
   */
  workDir: z.string().min(1).optional(),
  /**
   * 该 agent 配置的默认工作目录（D27）。
   *
   * 由 daemon 从 agent 配置里取出来带进来，**不是**请求方随便能设的——
   * 它表达的是操作者的显式选择（"这个 agent 总在这个仓库里干活"）。
   * 放在这里是因为执行器需要在不查库的前提下决定目录。
   */
  agentDefaultWorkDir: z.string().min(1).optional(),
  limits: z.object({
    maxTurns: z.number().int().positive().nullable(),
    timeoutMs: z.number().int().positive().nullable(),
  }),
  /**
   * **这一次**由谁来审（覆盖执行 agent 上的「由谁审它」）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 三态，而且三态都是意图
   * ══════════════════════════════════════════════════════════════════
   *
   *   - **省略**（或旧数据里没有这个字段）⇒ 跟随执行 agent 配置的
   *     `reviewerAgentId`。这是绝大多数情况：审核者是一件"这个 agent 一贯由
   *     谁审"的长期安排，不该每个任务都重选一遍。
   *   - **null** ⇒ 这次**明确不自动审**。它与"省略"是两件事：省略是"照旧"，
   *     null 是"这一次不用审"。两者后果差别很大（一个会派生审核 run、一个
   *     不会），所以不能都塞进 `undefined` 里——否则"这条小改动就别审了"这个
   *     合法意图在库里会变成"使用者没说"，审计时看不出那是谁的决定。
   *   - **agent id** ⇒ 这次换一个人审。只影响这一条 run，不改那个 agent 的长期
   *     配置（要改长期配置去智能体页）。
   *
   * 为什么放在**执行 run** 上而不是"审核 run"上：审核 run 是执行 run 跑完之后
   * 才由 daemon 派生的，那一刻没有人再问使用者的意见。所以"这一次换人审"这个
   * 决定必须随着执行 run 一起落库。
   */
  reviewerAgentId: z.string().min(1).nullable().optional(),
  /**
   * **这一次**允许触发哪些动作——审核者「行动权限」的**任务级覆盖**。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么它是"覆盖"，而不是"照抄一份"
   * ══════════════════════════════════════════════════════════════════
   *
   * **省略**（或旧数据里没有这个字段）⇒ 跟随那个审核者的「行动权限」。这是默认，
   * 也是绝大多数情况：动作权限是"这个人一贯允许做什么"，不该每个任务重抄一遍。
   *
   * **给了数组**⇒ 这一次就用这一份。★ 与 `reviewerAgentId` 同一条道理：把当前
   * 解析出来的那份**原样传过去**，等于把一个长期安排**冻结成一次覆盖**——以后在
   * 智能体页给这个审核者加了动作，从这一页建的任务仍然按老那份跑。所以新建任务页
   * 只在"勾选结果与审核者当前那份**不一致**"时才带这个字段。
   *
   * ⚠️ 空数组是**合法而且有意义**的：它的意思是"这一次一个动作都不许触发"
   *    （判决只能给结论）。它与"省略"是两件事——省略是照旧，空数组是这一次收紧。
   *
   * ⚠️ 与判决的关系：这一份会**进判决契约**（模型只能写这里列出的动作名），
   *    也是判决收口时校验动作的来源。所以它必须与"这次真的装了什么包"一致——
   *    装没装由 daemon 在写入前校验（未安装即 400，理由与 agent 的「行动权限」
   *    同一套：等到跑起来才发现"要的动作找不到包"，在无人值守下就是每次都失败）。
   */
  allowedActions: z.array(ActionRefType).optional(),
  /**
   * **这一次**动作的**固定参数**（审核者长期「行动权限」里的固定参数的**任务级
   * 覆盖**，D43）。
   *
   * 形状：`Record<动作名, Record<参数名, 值>>`——与 `Agent.actionParams` 同形，
   * 只可能引用 open 参数（bound 参数是平台的事实，不归使用者钉）。
   *
   * 与 `allowedActions` 同一条规矩、同一个判据（**字段在不在**）：
   *   - **省略** ⇒ 跟随那个审核者长期配的固定参数（`Agent.actionParams`）；
   *   - **给了对象** ⇒ 这一次就用这一份（空对象 = 这一次不固定任何参数）。
   *
   * ⚠️ 它**只跟 `allowedActions` 一起有意义**：动作都勾掉了，固定参数就没有
   *    落点。daemon 在写入前校验（动作必须是已装工具包声明的、参数必须是 open
   *    且值满足类型/上限/枚举），理由与 `allowedActions` 同一套——早拒，别等
   *    跑起来才发现。
   */
  actionParams: z.record(ActionRefType, z.record(z.string(), z.unknown())).optional(),
  /**
   * **这一次**允许返工几次——审核判 `fail` 时把意见交回执行者重做（D45）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 它为什么住在任务上，而不是 agent 上
   * ══════════════════════════════════════════════════════════════════
   *
   * 与 `reviewerAgentId` / `allowedActions` 同一条道理：**"这次值不值得多跑几轮"
   * 是这一次的判断**，不是"这个 agent 一贯怎么样"。同一对执行者/审核者，改一个
   * 排版错别字与改一个并发 bug，愿意付出的重做次数完全不同。
   *
   * **省略 / `0`** ⇒ 不返工。审核判 `fail` 时平台无处可去，**直接把任务交给人**
   * （看板「等待人处理」）——这是默认，也是绝大多数情况。
   *
   * **给 N** ⇒ 最多返工 N 次（总执行 run 最多 1 + N 条）。用完仍 `fail` ⇒ 同样交给人。
   *
   * ⚠️ 与 `chainDepth` 的分工：`chainDepth` 是**已经**返工了几次（由派生方 +1），
   *    这个字段是**允许**几次。两者一比就知道还有没有额度——所以不需要另记一个
   *    "已用次数"。同一件事有两个出处时，"哪个说了算"就只能靠注释记住。
   *
   * ⚠️ 与 `invalid` 重试是**两个计数、两件事**：`invalid` 是"判决本身没按格式输出"
   *    （重试的是**审核者**），`rework` 是"判决说这活不行"（重做的是**执行者**）。
   *    混成一个额度会让"模型不会写 JSON"吃掉"活干得不行"的次数。
   */
  maxReworks: z.number().int().min(0).max(5).optional(),
  /**
   * 链路深度（INV-14）。
   *
   * 由**派生方**给出：自动审核串接、动作派生 run 时都要 +1。
   * 超过上限就不再派生，避免"改 → 审 → 再改 → 再审"无限烧 token。
   */
  chainDepth: z.number().int().nonnegative().optional(),
  /**
   * 由哪个 action 派生（INV-16）。
   *
   * 这是**重建链路唯一的边**：`run.derivedFrom → action → verdict → 上一个 run`。
   * 根 run 不带这个字段（即 null）。
   *
   * 为什么不放在 `review` 里：execute run 也可能是被动作派生出来的
   * （`issue.assign_agent`），派生关系与"是不是审核"无关。
   */
  derivedFrom: z.string().min(1).nullable().optional(),
  /**
   * 从哪一条 run 恢复会话（FR-CLI-06）。
   *
   * 重试时由**派生方**给出，指向上一次的那条 run。执行器会去取它的
   * `sessionId`，并**按描述表的 `sessionState` 决定要不要真的恢复**——
   * `'stateless'` / `'unknown'` 的 runtime 一律不恢复。
   *
   * 为什么不直接传 `sessionId`：那样调用方就得先查库；
   * 而且"恢复谁"是一个可审计的关系，传 id 比传一个裸字符串留下了更多线索。
   */
  resumeFromRunId: z.string().min(1).nullable().optional(),
  /**
   * `review` run 的审核对象内容。
   *
   * execute run 不带这个字段——它的输入是 prompt 与工作目录。
   */
  review: z
    .object({
      /** 类型键（`kind`），同时是路由键与审核标准选择键。 */
      kind: z.string().min(1),
      title: z.string(),
      body: z.string(),
      /** 审核对象的内容寻址引用（审计用）。 */
      inputBlobRef: BlobRef.nullable(),
      /**
       * 关联的 issue（可空）。
       *
       * 为什么需要它：S1 里审核对象是**执行 run**，但判决要执行的动作
       * （发评论、改状态、打标签）都要一个 issueId。不把 issueId 交到
       * 上下文里，模型就只能瞎写一个——那不是模型的问题，是我们没给它。
       */
      relatedIssueId: z.string().nullable().optional(),
      /**
       * 执行任务/执行结果的**文件引用**（§3.3b，2026-09）。
       *
       * 平台在串接审核前，把「执行任务」与「执行结果」各自落盘到审核 run
       * 的工作目录 `.agentdeck/rounds/<轮次>-task.md` / `-result.md`
       * （多轮不覆盖），再通过这里把两份路径交给第一句话渲染——模型**按需
       * 读文件**来审，内联材料仍保留作兜底。
       *
       * 报告类审核没有执行 run，缺省为 null ⇒ 不渲染引用块。
       */
      materialRefs: z
        .object({ taskPath: z.string().min(1), resultPath: z.string().min(1) })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
})
export type SubmitRunRequest = z.infer<typeof SubmitRunRequest>

export const SubmitRunAccepted = z.object({
  runId: RunId,
  acceptedAt: EpochMs,
  /** true 表示这次是重复提交，已被幂等接受（没有第二个 run 产生）。 */
  deduplicated: z.boolean(),
})
export type SubmitRunAccepted = z.infer<typeof SubmitRunAccepted>

/** 取不到并发槽位时的响应——**不返回 202**，让页面稍后重试（FR-RUNTIME-04）。 */
export const SubmitRunRejected = z.object({
  reason: z.literal('no_capacity'),
  retryAfterMs: z.number().int().positive(),
})
export type SubmitRunRejected = z.infer<typeof SubmitRunRejected>

/**
 * `POST /runs/{id}/human-verdict` —— **人工裁决：人判通过**（D46）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么这里**只有"通过"这一个结论**，连 `conclusion` 字段都没有
 * ══════════════════════════════════════════════════════════════════
 *
 * 人的三个出路是「通过 / 反馈 / 放弃」，但它们**不是同一件事**，所以也没有走
 * 同一条路由：
 *
 * | 出路 | 机制 | 为什么不用判决 |
 * |---|---|---|
 * | **通过** | **这条路由**：追加一条 `source: 'human'` 的判决 | 看板只能从记录推出"通过了"，所以必须有记录 |
 * | **反馈** | 派一条新的执行 run（就是原来那个「发送并继续」） | 它要的是**干活**，不是结论。一条 run 已经足以让看板离开「等待人处理」 |
 * | **放弃** | 改 issue 的状态（`POST /issues/{id}/abandon`） | 它要的是**别再盯着它**，与判决无关 |
 *
 * 曾经这里有一个 `conclusion: 'pass' | 'fail'` 字段。它被删掉不是简化，是因为
 * **`fail` 那一边没有生产者**：人判"不通过"的意思就是"回去重做"，而那件事由
 * 「反馈」用一条新 run 完成——两条路并存的话，同一件事会有两种记录方式，而且
 * 它们的看板结果还不一样（判决 `fail` ⇒ 停在「等待人处理」；派了新 run ⇒
 * 「执行中」）。**留一个没人发的取值，只会让下一个人以为它是一条可用的路。**
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么 `reason` 是**选填**
 * ══════════════════════════════════════════════════════════════════
 *
 * 这里改过一次，记下来免得被"顺手改回去"：
 *
 *   最初写成必填，理由是"这条判决除了一句话之外什么都没有——没有 `findings`、
 *   没有证据引用、没有置信度、没有模型，理由再留空就只剩'某人在某时刻点了通过'"。
 *   那个论证本身没错，但它**把代价算错了**：人点「通过」时脑子里已经有一个判断
 *   （"我看过了，可以"），逼他把它写下来，最常见的结局是写一句"ok"或者干脆
 *   不点了——**门槛换来的是噪音，不是信息**。
 *
 *   而"要它重做"那边完全相反：必须说清要改什么，否则执行者拿到一句"不行"没法
 *   干活。所以必填落在**「反馈」**那一边（见 `Tasks.svelte` 里 `feedback()` 的
 *   拦截与 `tasks.needReasonForFeedback`），不落在这一条上。
 *
 * ⚠️ 因此 `VerdictRecord.humanReason` 为 `null` 是**正常状态**（人没写理由），
 *    不是数据缺失。消费方不要把它当成"记录不完整"。
 *
 * 上限 4000：够写一段说明，又不至于把一条判决变成一篇文档——判决卡上要显示它，
 * 而卡片不是给人读长文的地方。
 */
export const SubmitHumanVerdictRequest = z.object({
  /**
   * 为什么判通过。原文保存，不解释、不改写。**不填就存 `null`**。
   */
  reason: z.string().trim().max(4000).optional(),
})
export type SubmitHumanVerdictRequest = z.infer<typeof SubmitHumanVerdictRequest>

/** `POST /runs/{id}/human-verdict` 的响应。 */
export const SubmitHumanVerdictResponse = z.object({
  verdictId: VerdictId,
  /** 落库后的状态。人工裁决只有"通过、无动作"这一种 ⇒ 恒为 `advisory`。 */
  status: VerdictStatus,
})
export type SubmitHumanVerdictResponse = z.infer<typeof SubmitHumanVerdictResponse>

/**
 * `POST /issues/{id}/abandon` —— **放弃这条任务**（D47）。
 *
 * 语义只有一句：**别再让我盯着它了**。它不删除任何东西——run、判决、审计
 * 全部原样留着，只是这条 issue 的状态变成 `cancelled`，看板把它收进末尾那列
 * 「已放弃」。所以它是**可撤销的**（`POST /issues/{id}/reopen`）。
 *
 * 请求体是空的（`{}` 或干脆没有 body）：放弃不需要理由——理由在这个产品里
 * 是给**执行者**看的（返工依据），而放弃的下一步没有执行者。
 */
export const AbandonIssueRequest = z.object({}).strict()
export type AbandonIssueRequest = z.infer<typeof AbandonIssueRequest>

/**
 * `POST /issues/{id}/abandon` 与 `/reopen` 的响应：**改完之后的那条 issue**。
 *
 * ★ 返回整条而不是 `{ ok: true }`：界面要把它的状态显示出来（列名、按钮的
 *   下一态都取决于它），返回整条就省掉一次重新拉取——而"改完再拉一次"正是
 *   界面显示出旧状态的那类竞态的来源。
 */
export const IssueStatusChangeResponse = z.object({
  issue: Issue,
})
export type IssueStatusChangeResponse = z.infer<typeof IssueStatusChangeResponse>

// ─────────────────────────────────────────────────────────────
// 流式事件（SSE）
// ─────────────────────────────────────────────────────────────

export const RunMessageType = z.enum([
  'text',
  'thinking',
  'tool_use',
  'tool_result',
  'status',
  'error',
  'log',
])
export type RunMessageType = z.infer<typeof RunMessageType>

/**
 * 一条执行消息。
 *
 * `seq` 由 daemon **本地单调递增**，页面据此做补齐与去重，
 * **不依赖时间戳**（本地时钟可能漂移）。
 */
export const RunMessage = z.object({
  seq: z.number().int().nonnegative(),
  type: RunMessageType,
  /** 工具名（type 为 tool_use / tool_result 时）。 */
  tool: z.string().nullable(),
  content: z.string(),
  /** 结构化输入/输出（原文保留）。 */
  input: z.record(z.string(), z.unknown()).nullable(),
  output: z.string().nullable(),
  /** 输出被截断时为 true。 */
  outputTruncated: z.boolean(),
  at: EpochMs,
})
export type RunMessage = z.infer<typeof RunMessage>

export const RunResult = z.object({
  /** 产出物的内容寻址引用。 */
  artifactRefs: z.array(BlobRef),
  summary: z.string(),
  /** 工作目录（供页面显示）。 */
  workDir: z.string(),
  sessionId: z.string().nullable(),
})
export type RunResult = z.infer<typeof RunResult>

export const RunFailure = z.object({
  reason: RunFailureReason,
  message: z.string(),
})
export type RunFailure = z.infer<typeof RunFailure>

/**
 * SSE 事件流。判别联合——`t` 是判别键。
 *
 * 为什么用 SSE 而不是 WebSocket：本地接口是"页面单向订阅 + 少量命令"
 * 的形态。SSE 更简单、自动重连、且**天然单向**，攻击面更小。
 */
export const RunEvent = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('status'),
    seq: z.number().int().nonnegative(),
    status: RunStatus,
    at: EpochMs,
  }),
  z.object({
    t: z.literal('message'),
    seq: z.number().int().nonnegative(),
    message: RunMessage,
  }),
  z.object({
    t: z.literal('progress'),
    seq: z.number().int().nonnegative(),
    summary: z.string(),
    step: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  z.object({
    t: z.literal('usage'),
    seq: z.number().int().nonnegative(),
    usage: TokenUsage,
  }),
  z.object({
    t: z.literal('terminal'),
    seq: z.number().int().nonnegative(),
    status: z.enum(['completed', 'failed', 'cancelled']),
    result: RunResult.nullable(),
    error: RunFailure.nullable(),
  }),
])
export type RunEvent = z.infer<typeof RunEvent>

// ─────────────────────────────────────────────────────────────
// 身份与能力
// ─────────────────────────────────────────────────────────────

/** `GET /identity` —— 页面据此决定可用功能。 */
export const IdentityResponse = z.object({
  protocolVersion: z.number().int().positive(),
  deviceId: z.string().min(1),
  deviceName: z.string(),
  /** runtime 描述表键 → 是否可用、CLI 版本。 */
  runtimes: z.array(
    z.object({
      key: z.string().min(1),
      command: z.string().min(1),
      available: z.boolean(),
      cliVersion: z.string().nullable(),
    }),
  ),
  /** ★ 能力标志优先于版本号——版本号无法可靠回答"你实现了 X 吗"。 */
  capabilities: z.array(z.string()),
})
export type IdentityResponse = z.infer<typeof IdentityResponse>

/** `GET /runs` —— 页面重连后对账用。 */
export const ListRunsResponse = z.object({
  runs: z.array(
    z.object({
      runId: RunId,
      kind: RunKind,
      status: RunStatus,
      agentId: AgentId,
      workDir: z.string().nullable(),
      /**
       * ⚠️ 这里**故意不再提供** `lastSeq`。
       *
       * ══════════════════════════════════════════════════════════════
       * 它原来写的是"该 run 已产生到第几号消息，**页面据此决定 from 参数**"，
       * 而那句话本身是错的 —— 它直接导致了界面上的一个 bug
       * ══════════════════════════════════════════════════════════════
       *
       * "这个 run 已经产生到第几号"是**服务端**的事实；"这个页面消费到第几号"
       * 是**客户端**的事实。而 `?since=N` 的语义是"**把 N 之后的给我**"，
       * 也就是"跳过 N 及之前的一切"。
       *
       * 于是照那句话实现出来的界面是：打开一条**已跑完**的任务 ⇒
       * `?since=69` ⇒ 服务端把 0~69 全部跳过 ⇒ **日志是空的**，
       * 而 agent 的最后产出明明就在库里。只有"任务正在跑"时才看着正常
       * （那时 lastSeq 还小，之后新产生的消息照样会流进来）。
       *
       * 所以服务端**不再提供这个数字**：它没有正当用途，而放在这里就等于
       * 邀请别人再踩一次。客户端的游标由客户端自己持有
       * （见 `apps/web/src/components/RunLog.svelte`）。
       */
      queuedAt: EpochMs,
      finishedAt: EpochMs.nullable(),
    }),
  ),
})
export type ListRunsResponse = z.infer<typeof ListRunsResponse>

/** 本地接口协议版本。 */
export const LOCAL_PROTOCOL_VERSION = 1

/** 能力标志常量（避免各处手写字符串）。 */
export const Capability = {
  SseResume: 'sse-resume',
  Artifacts: 'artifacts',
  /**
   * `POST /runs` 接受 `SubmitRunRequest.reviewerAgentId`（D42）。
   *
   * ★ 为什么需要这个标志：界面（`apps/web/dist`）与 daemon 是**两份产物**，
   *   而日常做法恰好容易造成版本错位——"重建前端 → 刷新页面"**不带**重启
   *   daemon。旧 daemon 不解析这个字段（请求体那层没有 zod 校验，未知字段被
   *   忽略），于是页面上那句"这一次不自动审核"会被**静默地当成没说**，
   *   任务照样被审。界面说的与实际发生的不一致，而两边都不报错。
   *
   *   所以：能力标志优先于版本号（见 `IdentityResponse.capabilities` 的说明），
   *   页面据此决定"这一次换人审 / 这一次不审"这两个选项能不能给。
   */
  ReviewerOverride: 'reviewer-override',
  /**
   * `POST /runs` 接受 `SubmitRunRequest.allowedActions`（任务级动作白名单，D42）。
   *
   * ★ **为什么不与 `ReviewerOverride` 合成一个标志**（它们同一次交付里一起来）：
   *   它们是**两个字段、两份契约**——一个决定"谁来审"，一个决定"这一次允许动什么"。
   *   合成一个的代价是一个中间态：daemon 支持前者、不支持后者时，页面会画出那一栏
   *   勾选框，而勾选**被静默丢掉**（请求体那层没有校验，未知字段直接忽略），
   *   于是使用者以为"这次我允许了它动手"，实际什么都没发生——两边都不报错。
   *   这正是 `ReviewerOverride` 那条注释里说的同一件事，所以按同一条规矩办。
   */
  TaskActionWhitelist: 'task-action-whitelist',
  /**
   * `POST /runs/{id}/human-verdict` 存在（人工裁决，D46）。
   *
   * ★ 这条与前面几条**不是同一类风险**，所以更要说清为什么仍然需要标志：
   *   前面几条漏掉的后果是"某个选项被静默忽略"（功能少了，但不会做错事）。
   *   这一条漏掉的后果是——界面画出一个「人工通过」按钮，点下去请求打到
   *   一个**不认识这个路径**的旧 daemon 上，得到 404。那至少是**响亮的失败**，
   *   比静默好。
   *
   *   真正的理由是**别让界面画一个它兑现不了的承诺**：人工裁决是"人替审核者
   *   下结论"，它必须真的落库、真的让看板动起来。一个点了没反应的按钮会让
   *   人以为自己已经通过了审核——而任务其实还卡着。所以按同一条规矩办：
   *   能力标志优先于版本号，页面据此决定那一块给不给。
   */
  HumanVerdict: 'human-verdict',
  /**
   * `POST /issues/{id}/abandon` 与 `/reopen` 存在（放弃任务，D47）。
   *
   * ★ 这条与 `HumanVerdict` 是**两次独立的交付**，所以是两个标志：放弃这条路
   *   只碰 issue 的状态、不碰判决，它可以先落地也可以后落地。合成一个的话，
   *   中间那个状态下界面会画出「放弃」按钮而旧 daemon 404——而那正是这条标志
   *   存在的理由。
   */
  IssueAbandon: 'issue-abandon',
  /**
   * `POST /conversations` 认 `Conversation.skillIds`（对话自带 skill，D49 ⑩）。
   *
   * ★ 与前两条同一类风险，而且这一条**很容易真的发生**：只重建前端、刷新页面
   *   （不带重启 daemon）正是日常做法。旧 daemon 不解析这个字段（请求体那层没有
   *   zod 校验，未知字段被忽略），于是"选了一条没人挂的 skill"会被**静默地当成
   *   没说**——那一轮就是用一个没带这条 skill 的执行者在说话，而页面上写着"将使用
   *   它 + 这条 skill"。两边都不报错。
   *
   *   所以：界面**只在这个标志在的时候**才把"没人挂的 skill"列进下拉；没有它时
   *   那些选项不出现，并说明原因（重启 daemon 之后就有）。有主的那些 skill 不受
   *   影响——它们走"选它 = 选那个执行者"，skill 由执行者自己带着，那个字段根本
   *   用不到，所以旧 daemon 上也照常能用。
   */
  ConversationSkills: 'conversation-skills',
  /**
   * `GET /conversations/{id}/files` 与 `/file` 存在（对话级的工作目录，D49 ⑩）。
   *
   * ★ 与 `ConversationSkills` 分开，因为它们是**两个接口、两份契约**：一个决定
   *   skill 怎么进去，一个决定文件怎么看出来。合成一个会漏掉那个中间态——
   *   daemon 支持前者、不支持后者时，界面上会画出一栏而它的接口 404。
   *
   *   而 404 这一档**不能靠"反正会报错"糊过去**：任务页那次实测撞到的正是它，
   *   当时那一栏把失败渲染成了骨架屏 ⇒ 接口取不到和还在加载长得一模一样，
   *   使用者看到的就是"这一栏什么都没有"。所以：标志不在时，那一栏要么不画，
   *   要么把原因写出来。
   */
  ConversationFiles: 'conversation-files',
} as const

/** `POST /skills` —— 页面下载好 skill 后交给 daemon 落盘。 */
export const InstallSkillsRequest = z.object({
  skills: z.array(SkillPayload),
  /** 幂等键：同一批次重复提交不重复落盘。 */
  batchId: Ulid,
})
export type InstallSkillsRequest = z.infer<typeof InstallSkillsRequest>

/** `/runs/{id}/artifacts` 的条目。 */
export const ArtifactEntry = z.object({
  blobRef: BlobRef,
  summary: z.string(),
  sizeBytes: z.number().int().nonnegative(),
})
export type ArtifactEntry = z.infer<typeof ArtifactEntry>

/**
 * 审计导出的格式版本（M4）。
 *
 * 导出物是**会离开本机的**文件：有人会把它存进档案、发给同事、或者拿去
 * 对比两次导出。所以它必须自带版本号——将来格式变了，读到的旧文件要能
 * 明确报出"版本不认识"，而不是被静默误读成新格式。
 */
export const AUDIT_EXPORT_FORMAT_VERSION = 1

/**
 * 数据快照的格式版本（FR-STOR-05）。
 *
 * 与审计导出分开编号：那份是**给人看的证据**，这份是**给程序读的搬迁载体**。
 * 两者的演进节奏不同——审计格式要稳定得多，而快照会随实体增减而变。
 * 共用一个版本号会让"加了张表"看起来像"审计证据格式变了"。
 */
export const DATA_SNAPSHOT_FORMAT_VERSION = 1

export { SkillId }
