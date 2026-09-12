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
 * 动作类型。闭合——必须来自动作注册表。
 * 未在表内的取值会让整个判决判定为不合规（走 invalid 路径）。
 */
export const ActionType = z.enum([
  // ── 首版本地动作 ──
  'comment.create',
  'issue.update_status',
  'issue.add_label',
  'issue.create',
  'issue.assign_agent',
  'notify.emit',
])
export type ActionType = z.infer<typeof ActionType>

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
