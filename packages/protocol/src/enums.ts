import { z } from 'zod'

/**
 * 所有**闭合枚举**的唯一定义处。
 *
 * 约定（requirements §5、INV-18）：
 * - 枚举只在这里定义，其他包不得重复定义；
 * - 新增取值 = 改本文件 + 升协议版本，这是**刻意制造的摩擦**，
 *   逼作者想清楚"这真的是一类新东西吗"。
 */

// ─────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────

/** Run 状态机（八态）。见 requirements §10.1 */
export const RunStatus = z.enum([
  'deferred',
  'queued',
  'dispatched',
  'waiting_local_directory',
  'running',
  'completed',
  'failed',
  'cancelled',
])
export type RunStatus = z.infer<typeof RunStatus>

export const TERMINAL_RUN_STATUSES = ['completed', 'failed', 'cancelled'] as const
export type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number]

export const isTerminalRunStatus = (s: RunStatus): s is TerminalRunStatus =>
  (TERMINAL_RUN_STATUSES as readonly string[]).includes(s)

/** execute = 执行；review = 审核。两者的终止契约不同。 */
export const RunKind = z.enum(['execute', 'review'])
export type RunKind = z.infer<typeof RunKind>

/** Run 的触发来源。 */
export const RunTrigger = z.enum([
  'assignment', // 指派 issue
  'mention', // 评论里 @
  'chat', // 对话
  'schedule', // 定时
  'third_party', // 第三方查询取回
  'verdict_action', // 上一步判决触发的动作派生
])
export type RunTrigger = z.infer<typeof RunTrigger>

// ─────────────────────────────────────────────────────────────
// Verdict
// ─────────────────────────────────────────────────────────────

/** 判决结论。三选一，闭合。 */
export const VerdictConclusion = z.enum(['pass', 'fail', 'needs_human'])
export type VerdictConclusion = z.infer<typeof VerdictConclusion>

/**
 * 判决的**原因码**。闭合共享枚举。
 *
 * 三条纪律（requirements §7.3）：
 * 1. 不能是自由字符串——否则同一含义会漂移出十种写法，无法统计与分组；
 * 2. 新增类别要改协议并升版本；
 * 3. **不得泄露对象是否存在**：需要表达"无权访问"时统一用
 *    `insufficient_context`，不要为"不存在"和"无权"各给一个码，
 *    否则可被枚举探测。
 */
export const ReasonCode = z.enum([
  // 通过
  'meets_criteria',
  // 未通过：质量类
  'missing_tests',
  'failing_tests',
  'style_violation',
  // 未通过：正确性
  'logic_error',
  'type_error',
  'broken_reference',
  // 未通过：安全类
  'known_vulnerability',
  'secret_exposed',
  'unsafe_permission',
  // 未通过：范围
  'scope_creep',
  'out_of_scope',
  // 无法判定
  'insufficient_context',
  'conflicting_criteria',
  'criteria_not_applicable',
  // 系统
  'internal_error',
  /**
   * ★ 人工裁决（D46）。
   *
   * 上面那些码都是**给模型用的**：它们回答"这条产出为什么不满足标准"。而人工
   * 裁决的理由不是从这套分类里挑出来的——人写的是**一句话**，那句话原文进
   * `findings`。所以这里给一个码，意思是"这条判决的理由在自由文本里，别去
   * 上面的分类里找"。
   *
   * ⚠️ 为什么不复用 `meets_criteria` / `insufficient_context` 之类：
   *    人工通过时填 `meets_criteria` 会让统计把"审核者按标准判通过"与
   *    "人看了一眼说行"算成同一件事——而这两件事的**证据强度完全不同**，
   *    合并之后"通过率"这个数字就不再回答任何问题了。
   */
  'human_decision',
])
export type ReasonCode = z.infer<typeof ReasonCode>

/** 发现项的严重程度。闭合，因为升级策略与排序都依赖它。 */
export const Severity = z.enum(['critical', 'high', 'medium', 'low', 'info'])
export type Severity = z.infer<typeof Severity>

/** verdict 的生命周期（requirements §10.2）。 */
export const VerdictStatus = z.enum([
  'pending_verdict',
  'emitted',
  'validated',
  'invalid',
  'dispatched_to_action',
  'advisory',
  'escalated',
  /** ★ 判决合格且结论为 `fail` ⇒ **返工**：审核意见交回执行者重做（D45）。终态。 */
  'rework_requested',
])
export type VerdictStatus = z.infer<typeof VerdictStatus>

/** schema 校验失败后的处理路径（`invalid` 是**独立**失败类型）。 */
export const InvalidVerdictResolution = z.enum([
  'retry',
  'downgrade_to_advisory',
  'escalate',
])
export type InvalidVerdictResolution = z.infer<typeof InvalidVerdictResolution>

// ─────────────────────────────────────────────────────────────
// Action
// ─────────────────────────────────────────────────────────────

/**
 * 动作的执行端。**由注册表决定，不由 verdict 决定**（INV-13）——
 * 这样本地动作将来迁移到远端时，不需要改动历史判决的结构。
 */
export const ActionPlane = z.enum(['local', 'remote'])
export type ActionPlane = z.infer<typeof ActionPlane>

/**
 * ⚠️ **平台不内置任何动作**（D41）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这里原来是一个六项的闭合枚举，已经删掉了
 * ══════════════════════════════════════════════════════════════════
 *
 * 那六项是 `comment.create` / `issue.update_status` / `issue.add_label` /
 * `issue.create` / `issue.assign_agent` / `notify.emit`——平台的"内置动作"，
 * 实现在 daemon 的一个 `switch` 里。使用者的决定是：**全部移除**，动作只能来自
 * 装进来的工具包（`<包 slug>.<动作名>`）。
 *
 * 于是"平台能做什么"不再由平台自己规定，而由**装了哪些包**决定：
 *
 *   · 动作的定义来自工具包的清单（`ToolManifest.actions`）；
 *   · 名字的形状只有 `<包 slug>.<动作名>` 一种，**没有裸名**；
 *   · "存在不存在"由运行时按已安装的包解析（`resolveActionDefinition`）——
 *     "未声明即拒绝"这条规矩不变，只是判据从"在不在那张表里"变成"装没装"。
 *
 * ⚠️ 后果是刻意承担的：平台**不再自带**评论、改状态、打标签、建 issue、指派、
 *    发通知这六种处置能力——装什么才能做什么。而工具脚本也改不了平台自己的数据
 *    （它没有平台 API），所以若想让"审核结论落成一条评论"回来，得先给工具脚本
 *    一条受控的本地接口，或者把这类动作做成**随平台发布的标准工具包**（用同一套
 *    清单 + 脚本机制，而不是硬编码回 daemon 里）。
 */

/**
 * 第三方动作名（D40）：`<工具包 slug>.<动作名>`。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么它住在 `enums.ts`，而不是和工具清单放在一起
 * ══════════════════════════════════════════════════════════════════
 *
 * 因为**用它的人比工具包多**：判决 schema（`verdict.ts` 的 `ActionRef.type`）
 * 与审核标准的白名单（`entities.ts` 的 `ReviewStandard.allowedActions`）都要
 * 接受这个形状，而这两处都**不能** import `tools.ts`——`tools.ts` 要从
 * `entities.ts` 取 `EpochMs`，反向引用会成环（模块求值时直接 TDZ 崩）。
 *
 * 名字的**形状**是契约基本件（和动作枚举放在一起），工具包的**清单**才是
 * `tools.ts` 的事。分开之后两边都只依赖 `enums.ts`，环就没了。
 */
export const NamespacedActionType = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}\.[a-z][a-z0-9-]{0,62}$/, '动作名必须是 <包 slug>.<动作名>')

/**
 * 判决与白名单里允许出现的动作名：**只有** `<包 slug>.<动作名>` 一种形状。
 *
 * ⚠️ 它**只是形状**。"这个动作到底存不存在、装没装、允不允许"是运行时的事
 *    （daemon 按工作区已安装的工具解析）——"未声明即拒绝"这条规矩不变。
 *    类型名保留 `ActionRefType`（而不是换成 `NamespacedActionType`）：判决 schema、
 *    白名单与实体的字段名说的都还是"动作引用"，与它长什么样无关。
 */
export const ActionRefType = NamespacedActionType
export type ActionRefType = z.infer<typeof ActionRefType>

/**
 * 从动作名里取包 slug；形状不对（或没有那个点）返回 `null`。
 *
 * ⚠️ 原来它还兼着"这是不是内置裸名"的判断（内置名返回 null）。内置动作删掉之后
 *    这个区分不存在了：**每个**动作名都带包 slug。
 */
export function toolSlugOfAction(type: string): string | null {
  if (!NamespacedActionType.safeParse(type).success) return null
  return type.slice(0, type.indexOf('.'))
}

/** 动作的生命周期（requirements §10.3）。 */
export const ActionStatus = z.enum([
  'proposed',
  'auto_approved',
  'awaiting_approval',
  'executing',
  'executed',
  'failed',
  'rolled_back',
  'skipped',
])
export type ActionStatus = z.infer<typeof ActionStatus>

export const TERMINAL_ACTION_STATUSES = [
  'executed',
  'failed',
  'rolled_back',
  'skipped',
] as const
export type TerminalActionStatus = (typeof TERMINAL_ACTION_STATUSES)[number]

export const isTerminalActionStatus = (s: ActionStatus): s is TerminalActionStatus =>
  (TERMINAL_ACTION_STATUSES as readonly string[]).includes(s)

// ─────────────────────────────────────────────────────────────
// Issue
// ─────────────────────────────────────────────────────────────

export const IssueStatus = z.enum([
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
  'blocked',
  'cancelled',
])
export type IssueStatus = z.infer<typeof IssueStatus>

export const IssuePriority = z.enum(['urgent', 'high', 'medium', 'low', 'none'])
export type IssuePriority = z.infer<typeof IssuePriority>

export const CommentType = z.enum(['comment', 'status_change', 'progress_update', 'system'])
export type CommentType = z.infer<typeof CommentType>

export const AuthorType = z.enum(['member', 'agent'])
export type AuthorType = z.infer<typeof AuthorType>

// ─────────────────────────────────────────────────────────────
// Artifact
// ─────────────────────────────────────────────────────────────

/**
 * 产出物的种类。**没有 `diff`**——本项目不存在"改代码"这条线，
 * 执行 run 的产出都是报告形态（D20）。
 */
export const ArtifactKind = z.enum(['report', 'scorecard', 'document', 'other'])
export type ArtifactKind = z.infer<typeof ArtifactKind>

// ─────────────────────────────────────────────────────────────
// 失败原因（机器可读）
// ─────────────────────────────────────────────────────────────

/** Run 的失败原因码。闭合。 */
export const RunFailureReason = z.enum([
  'daemon_restarted',
  'idle_timeout',
  'cli_unparsable_output',
  'injection_failed',
  'agent_error',
  'infra_error',
  'cancelled_by_user',
  'verdict_schema_invalid',
])
export type RunFailureReason = z.infer<typeof RunFailureReason>

// ─────────────────────────────────────────────────────────────
// 注册表键（用于扩展位）
// ─────────────────────────────────────────────────────────────

/** 插件能力类型。首版两类。 */
export const PluginCapability = z.enum(['login', 'third-party'])
export type PluginCapability = z.infer<typeof PluginCapability>

/** runtime 协议族。首版只有 stream-json。 */
export const RuntimeProtocol = z.enum(['stream-json', 'acp', 'jsonrpc'])
export type RuntimeProtocol = z.infer<typeof RuntimeProtocol>
