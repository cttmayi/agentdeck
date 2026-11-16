import { z } from 'zod'
import { ActionRefType, RunFailureReason, RunKind, RunStatus } from './enums.ts'
/*
 * ⚠️ 2026-11（D125）：这里原来还导入了 `VerdictStatus`——`RunSummary.verdict`
 *   用的就是它。审核 run 与判决一起退场，那份投影字段删了。
 */
import { AgentId, BlobRef, RunId, SkillId, Ulid, VerdictId } from './ids.ts'
import { EpochMs, Issue, CrystallizeTargetRef, SkillRef, SubjectRef, TokenUsage } from './entities.ts'

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
 * （见 packages/skill-source/src/skill-source.ts）。原因有两条，都不是"图省事"：
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
   * 不再携带"允许触发哪些动作"——那份权限先后住在审核者与智能体组上，2026-11
   * （D123）随整个动作能力退场。老客户端传了这个字段也**不报错但会被忽略**。
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
  /**
   * **这一次从哪个智能体组走**（D70 增量添加）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 组的语义 = "执行 → 审核 → 行动"整条链的默认配置
   * ══════════════════════════════════════════════════════════════════
   *
   * **给 id** ⇒ 执行者默认从这条组取（daemon 在写入前把组的执行者展开成
   * `agentRef`）。**省略** ⇒ 执行者 = `agentRef`。
   *
   * ⚠️ 2026-11（D125）：组的另一半——审核者——**已经不做任何事了**。审核 run
   *   退场之后，`groupId` 只是"这条任务当时是哪队人"的记录（下面 `Run.groupId`
   *   那段）。组本身（成员、名字）等 S3 再处理。
   *
   * ⚠️ 为什么 daemon 展开而不是界面展开：展开涉及查库（组、成员 agent），界面
   *    没有权威数据；而且展开后要走 daemon 现有的校验（执行者存在性、组形态），
   *    展开放在写入前正好复用它们。
   */
  groupId: z.string().min(1).optional(),
  limits: z.object({
    maxTurns: z.number().int().positive().nullable(),
    timeoutMs: z.number().int().positive().nullable(),
  }),
  /*
   * ⚠️ 2026-11（D125）：这里原来是 `reviewerAgentId`——"这一次由谁来审"（三态：
   *   省略=跟随、`null`=这一次不审、id=换一个人）。**审核 run 与判决一起退场**
   *   ⇒ 平台不再派生审核 run，请求上也就没有"这一次谁审"这件事。
   *
   *   ⚠️ 那条三态纪律本身是对的：**"没改"必须是"键不出现"，不能是"发一个等于
   *   默认的值"**——否则服务端分不清"跟随"与"明确设成默认"。将来任何"省略 = 跟随"
   *   的字段都该照它做。
   */
  /*
   * ⚠️ 2026-11（D123）：这里原来有三个字段——`allowedActions`（这一次允许触发哪些
   *   动作）、`actionParams`（动作的固定参数）、`debugActions`（调试动作）。**动作
   *   能力退场**之后判决不再触发动作，三个都删了（组展开也不再落它们）。
   */

  /*
   * ⚠️ 2026-11（D124）：这里原来是 `maxReworks`（这次任务允许返工几次）。
   *   **返工整个退场**：审核判 `fail` 不再自动把意见交回执行者重做——判决只记录
   *   结论，"接下来做什么"由人或者编排决定。于是请求里不再有这条预算。
   */
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
   * D80（2026-10-19）：`skill-draft` 起草 run 的**沉淀目标**（新建 / 更新哪条）。
   *
   * 只在起草 run 上带；随 run 落库（`Run.crystallizeTarget`），供"恢复进行中
   * 的起草"还原目标（§4.1.1）——草稿当初按哪个目标起草，入库就按哪个目标走。
   */
  crystallizeTarget: CrystallizeTargetRef.optional(),
  /**
   * D80 四轮 P1（2026-10-19）：这一版起草是"按意见改一版"来的，值是上一版草稿的
   * run id。随 run 落库（`Run.revisedFrom`），审阅时据此读上一版的产出做对比。
   */
  revisedFrom: RunId.optional(),
  /*
   * ⚠️ 2026-11（D125）：这里原来是 `review`——"这条 run 是一次审核"的全部材料
   *   （`kind` / `title` / `body` / `inputBlobRef` / `relatedIssueId` /
   *   `materialRefs`）。
   *
   *   审核 run 与判决一起退场 ⇒ 没有"审核 run"这种 run，字段删。
   *   ⚠️ `materialRefs` 那条经验仍然值得留着：**把完整原文落成文件、让模型按需
   *   读，比塞一段截断的内联材料强**——内联那段是转述，留着只会诱导模型只看
   *   转述、不看文件。
   */
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

/*
 * ⚠️ 2026-11（D125）：这里原来是 `SubmitHumanVerdictRequest` /
 *   `SubmitHumanVerdictResponse`——人在任务详情页上点「通过」时落一条
 *   `source: 'human'` 的判决（D46）。
 *
 *   判决与人工裁决面板一起退场 ⇒ 两条 schema 删。人手里的出路只剩两条：
 *   **放弃这条任务**（`POST /issues/{id}/abandon`，还在）与**再派一条任务**
 *   （就是「反馈」——它本来就是"一句话变成一条执行 run"，从来不依赖判决）。
 *
 *   ⚠️ 那段注释里最值钱的一句留着：**「反馈」必填理由、「通过」不必填**。
 *   要求人点通过时写一封信，换来的不是信息而是噪音（大家都写 "ok"）；而"要它
 *   重做"那边不说清要改什么，执行者拿到一句"不行"根本没法干活。
 */

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
  /*
   * ⚠️ 2026-11（D125）：这里原来是 `ReviewerOverride: 'reviewer-override'`（"`POST /runs`
   *   接受 `reviewerAgentId`"）。审核 run 退场、字段删除 ⇒ 这个能力标志没有对象，
   *   删掉——**留着一个永远为真的能力，界面就会画一个它兑现不了的承诺**（那正是这条
   *   标志当初存在的理由）。
   *
   *   ⚠️ 那条机制本身是好东西，留着：**界面与 daemon 是两份产物，能力标志优先于
   *   版本号**——"重建前端 → 刷新页面"不带重启 daemon 是日常做法。
   */
  /*
   * ⚠️ 2026-11（D123/D125）：`TaskActionWhitelist: 'task-action-whitelist'` 随动作能力退场。
   */

  /*
   * ⚠️ 2026-11（D125）：这里原来是 `HumanVerdict: 'human-verdict'`。判决与人工裁决面板
   *   一起退场 ⇒ 没有那条路由，"人工通过"这个按钮也不再有 ⇒ 标志删。
   */

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
  /*
   * ⚠️ 2026-11（S3）：这里原来是两个能力标志——`AgentGroups: 'agent-groups'`
   *   （`/api/agent-groups` 存在 + `POST /runs` 认 `groupId`）与
   *   `AgentGroupsWorkflow: 'agent-groups-workflow'`（组的"工作流模式"与私有成员）。
   *
   *   智能体组退场 ⇒ 两个标志都没有对象，删掉——**留着一个永远为真的能力，界面就会
   *   画一个它兑现不了的承诺**（那正是这些标志当初存在的理由）。
   */

  /**
   * `/api/voice/*` 存在（离线口述录入，分批第 277 批）。
   *
   * ★ 为什么需要它：麦克风按钮是"点了就该有反应"的东西，而**旧 daemon 上这个路径
   *   是 404**——按钮会静静地什么都不做（或者更糟：说出一个 fetch 报错）。界面据此
   *   决定"给不给这颗按钮"，不给时说一句"这个 daemon 还不支持语音，重启一下"。
   *
   * ⚠️ 与能力类标志同一口径：**不要**用版本号猜，能力标志优先（见上面 `IdentityResponse`
   *   那段说明）。
   */
  VoiceDictation: 'voice-dictation',
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
