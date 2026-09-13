import { z } from 'zod'
import {
  ActionPlane,
  ActionStatus,
  ActionType,
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
  AgentId,
  ArtifactId,
  AuditId,
  BlobRef,
  CommentId,
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
   * 为什么是可选字段，而不是一个新版本
   * ══════════════════════════════════════════════════════════════════
   *
   * 整条记录是以 JSON 存的（`skill.json` 列），读回来是
   * `JSON.parse(...) as Skill`——**读取路径上没有 zod 校验**。所以加一个
   * 可选字段对老数据是完全安全的：老行没有这个键，取出来是 `undefined`，
   * 落到用它的地方按 `?? {}` 处理即可，不需要数据迁移、也不需要动存储格式版本。
   *
   * 只支持文本：二进制（图片、字体、压缩包）会在**安装时就被拒绝并列出**，
   * 而不是装进来再在某个环节悄悄写坏。缺了支持文件的技能是坏的技能，
   * 所以宁可当场说清楚。
   */
  files: z.record(z.string(), z.string()).optional(),
  verdictSchemaVersion: z.number().int().positive(),
  /** 允许这个 skill 触发的动作子集。 */
  allowedActions: z.array(ActionType),
  /** 来源：本地自有 / 从远端下载。 */
  source: z.enum(['local', 'remote']),
  /** 下载来源标识（source 为 remote 时）。 */
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
 * Agent：可复用的 AI 协作者配置。
 *
 * **不是常驻进程**——只在被触发时执行。
 * 每个 agent 有**自己的** skill 子集与 tool 子集（FR-AGENT-03/12/17）。
 */
/** agent 的角色（D28）。 */
export const AgentRole = z.enum(['executor', 'reviewer'])
export type AgentRole = z.infer<typeof AgentRole>

export const Agent = z.object({
  id: AgentId,
  workspaceId: WorkspaceId,
  name: z.string().min(1).max(100),
  instructions: z.string(),
  model: z.string().nullable(),
  /** runtime 描述表键（首版恒为 'claude'）。 */
  runtimeKey: z.string().min(1),
  /** 默认工作目录。使用者指定；平台不做仓库检出（D20）。 */
  workDir: z.string().nullable(),
  /** ★ 这个 agent 挂载的 skill 子集——不是全部可用 skill。 */
  skillIds: z.array(SkillId),
  /** ★ tool 子集。首版为扩展位（FR-AGENT-17）。 */
  toolIds: z.array(z.string()),
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
   * 由谁来审**这个执行 agent** 的产出（仅对 `role: 'executor'` 有意义）。
   *
   * `null` = 不自动审。这不是错误，是一个明确的选择——单机使用者不配它时，
   * 每个任务都多跑一次审核会既费钱又吵（INV-8：通知与打扰都要稀缺）。
   *
   * ⚠️ 指向自己会被拒绝：那等于"自己审自己"，违反 INV-1（reviewer ≠ executor）。
   */
  reviewerAgentId: AgentId.nullable(),

  createdAt: EpochMs,
  updatedAt: EpochMs,
})
export type Agent = z.infer<typeof Agent>

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
  type: z.enum(['issue', 'report', 'run']),
  id: z.string(),
})
export type SubjectRef = z.infer<typeof SubjectRef>

/** run 使用的 skill 的**标识与来源**（不记版本、不记指纹，D9）。 */
export const SkillRef = z.object({
  id: SkillId,
  slug: z.string(),
  source: z.enum(['local', 'remote']),
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
export const Run = z.object({
  id: RunId,
  workspaceId: WorkspaceId,
  kind: RunKind,
  status: RunStatus,
  agentId: AgentId,
  subject: SubjectRef,
  trigger: RunTrigger,
  /** 由哪个 action 派生；根 run 为 null。 */
  derivedFrom: ActionId.nullable(),
  /** 链路深度，用于 INV-14。 */
  chainDepth: z.number().int().nonnegative(),
  skillRefs: z.array(SkillRef),
  workDir: z.string().nullable(),
  /** `waiting_local_directory` 时携带被占用的路径，供 UI 显示。 */
  waitReason: z.string().nullable(),
  sessionId: z.string().nullable(),
  attempt: z.number().int().positive(),
  maxAttempts: z.number().int().positive(),
  failureReason: RunFailureReason.nullable(),
  usage: TokenUsage.nullable(),
  queuedAt: EpochMs,
  dispatchedAt: EpochMs.nullable(),
  startedAt: EpochMs.nullable(),
  finishedAt: EpochMs.nullable(),
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
  type: ActionType,
  plane: ActionPlane,
  params: z.record(z.string(), z.unknown()),
  status: ActionStatus,
  idempotencyKey: z.string().min(1),
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
  contextBlockHash: z.string().nullable(),
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
