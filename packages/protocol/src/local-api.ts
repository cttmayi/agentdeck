import { z } from 'zod'
import { ActionType, RunFailureReason, RunKind, RunStatus } from './enums.ts'
import { AgentId, BlobRef, RunId, SkillId, Ulid } from './ids.ts'
import { EpochMs, SkillRef, SubjectRef, TokenUsage } from './entities.ts'

/**
 * 本地接口契约（daemon ↔ 同源页面）。
 *
 * 关键约束（FR-BRIDGE-08、D19）：
 * - daemon **不向 alpha-helper 的远端服务**发请求；取 run、查第三方、上报记录、
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
 * 这条例外**不涉及 alpha-helper 的远端服务**（D20 那条规则仍然成立），
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
   * 这个 skill 允许触发的动作**子集**。
   *
   * 不是"全部动作都可以"——缺了这一层，一个只该打标签的审核 skill
   * 就能去改状态、建 issue（FR-ACTION-01、INV-9）。
   */
  allowedActions: z.array(ActionType),
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
