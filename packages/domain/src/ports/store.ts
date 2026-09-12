import type {
  Action,
  ActionId,
  ActionStatus,
  Agent,
  AgentId,
  Artifact,
  AuditRecord,
  BlobRef,
  Comment,
  Device,
  InboxItem,
  Issue,
  IssueId,
  Report,
  Run,
  RunId,
  RunMessage,
  RunStatus,
  Skill,
  SkillId,
  SubjectRef,
  VerdictId,
  VerdictRecord,
  VerdictStatus,
  Workspace,
  WorkspaceId,
} from '@alpha-helper/protocol'

/**
 * 存储端口。
 *
 * ══════════════════════════════════════════════════════════════
 * 设计约束（FR-STOR-02/03）——这是本文件最重要的部分
 * ══════════════════════════════════════════════════════════════
 *
 * **接口按领域需要定义，不按存储实现的能力定义。**
 *
 * 禁止出现在本文件里的东西：
 *
 *   ✗ readJsonFile / writeJsonFile —— 把存储实现泄进领域逻辑
 *   ✗ readAll()                    —— 迫使领域逻辑做全量扫描，数据库上不可行
 *   ✗ 任何带 file / json / line / path 字样的方法名 —— 命名即泄漏
 *
 * 为什么这条重要：如果首版把"读全量 → 改 → 写回"这类文件存储的用法
 * 泄进领域逻辑，将来接入数据库时不是"换个适配器"，而是重写业务代码。
 *
 * ══════════════════════════════════════════════════════════════
 * 支点：CAS 语义
 * ══════════════════════════════════════════════════════════════
 *
 * `transitionRun(id, expect, next, patch)` 的语义是
 * "**仅当**当前状态等于 expect 时才转移"。
 *
 *   文件存储上：加锁读 → 校验 → 追加
 *   数据库上：  UPDATE ... SET status = next WHERE id = ? AND status = expect
 *
 * **两者语义相同**，所以领域逻辑不需要知道底下是什么。所有状态变更都必须
 * 走这条路——不允许出现"先 get 再 set"的写法，那样在并发下必然出错。
 */

// ─────────────────────────────────────────────────────────────
// 查询与分页
// ─────────────────────────────────────────────────────────────

/** 游标分页。游标是上一页最后一条的 id（ULID，天然可排序）。 */
export interface Page<T> {
  items: T[]
  nextCursor: string | null
}

export interface PageQuery {
  limit?: number
  /**
   * 从该 id **之后**开始取。
   *
   * ══════════════════════════════════════════════════════════════════
   * 两条写在这里的约定，因为适配器之间真的会踩到
   * ══════════════════════════════════════════════════════════════════
   *
   * **① 游标不在候选集里时必须"继续"，不能"回头"。**
   *    最容易写错的实现是 `findIndex(i => i.id === cursor) + 1`——
   *    找不到时得到 `-1 + 1 = 0`，于是**静默重放第一页**。调用方拿到的是
   *    合法的一页、`nextCursor` 也照常给出，但翻页会永远在第一页打转且
   *    毫无报错。正确做法是按**位置**比较（`id > cursor`）。
   *    游标不在结果里并不罕见：上一页最后一条恰好在两次翻页之间改了状态、
   *    被过滤掉，就会发生。
   *
   * **② 排序口径是"id 的**字节序**"，不是"本地化顺序"。**
   *    所有真实 id 都是 ULID（Crockford base32，纯 ASCII），ASCII 上
   *    JS 的 `<` 与 SQLite 的 `BINARY` 完全一致，所以这条现在不构成差异。
   *    但它**不是普遍成立**的：JS 按 UTF-16 代码单元比较，SQLite 按 UTF-8
   *    字节比较，含星平面字符（如 emoji）时两者**顺序相反**。
   *    换言之：**不要把非 ASCII 字符串当作 id 塞进这里**——
   *    那会让 SQL 适配器与文件适配器给出不同的排序。
   */
  cursor?: string | null
}

export interface RunQuery extends PageQuery {
  workspaceId: WorkspaceId
  status?: readonly RunStatus[]
  agentId?: AgentId
}

export interface ReportQuery extends PageQuery {
  workspaceId: WorkspaceId
}

export interface IssueQuery extends PageQuery {
  workspaceId: WorkspaceId
  status?: readonly Issue['status'][]
  assigneeId?: string
  /** 标题/描述的子串检索（目录管理能力，FR-ISSUE-09/10）。 */
  search?: string
}

/**
 * 认定为"正在占用工作目录"的状态集合。
 *
 * 只有已经被 daemon 受理的 run 才持有目录；`queued` 还没被受理，
 * 因此不算占用（它会等到受理时再检查，届时进入 waiting_local_directory）。
 */
export const ACTIVE_RUN_STATUSES = [
  'dispatched',
  'running',
  'waiting_local_directory',
] as const satisfies readonly RunStatus[]

// ─────────────────────────────────────────────────────────────
// 端口
// ─────────────────────────────────────────────────────────────

export interface Store {
  // ── 生命周期 ──

  /** 存储格式版本，用于迁移判定（FR-STOR-04）。 */
  formatVersion(): Promise<number>
  close(): Promise<void>

  // ── Workspace 与 Device ──

  getWorkspace(id: WorkspaceId): Promise<Workspace | null>
  insertWorkspace(ws: Workspace): Promise<void>
  /** 枚举已知 workspace——daemon 启动时据此预加载，并选出默认工作区。 */
  listWorkspaceIds(): Promise<WorkspaceId[]>
  getDevice(): Promise<Device | null>
  upsertDevice(device: Device): Promise<void>

  // ── Agent ──

  getAgent(id: AgentId): Promise<Agent | null>
  listAgents(workspaceId: WorkspaceId): Promise<Agent[]>
  insertAgent(agent: Agent): Promise<void>

  // ── Skill ──

  getSkill(id: SkillId): Promise<Skill | null>
  listSkills(workspaceId: WorkspaceId): Promise<Skill[]>
  /** 按 id 批量取（一个 run 的技能集合按 agent 求解，D22）。 */
  listSkillsByIds(ids: readonly SkillId[]): Promise<Skill[]>
  insertSkill(skill: Skill): Promise<void>

  // ── Issue 与 Comment ──

  getIssue(id: IssueId): Promise<Issue | null>
  listIssues(q: IssueQuery): Promise<Page<Issue>>
  insertIssue(issue: Issue): Promise<void>
  transitionIssue(
    id: IssueId,
    expect: Issue['status'],
    next: Issue['status'],
    patch?: Partial<Pick<Issue, 'assignee' | 'labels' | 'priority' | 'title' | 'description'>>,
  ): Promise<boolean>
  listComments(issueId: IssueId): Promise<Comment[]>
  insertComment(comment: Comment): Promise<void>

  // ── Report ──

  /** 按去重键查找。这是平台侧的**正确性保证**（FR-REPORT-03）。 */
  /**
   * 列出一个工作区的报告。
   *
   * ══════════════════════════════════════════════════════════════════
   * 这个方法是为了 FR-STOR-05（导出与导入）才加的
   * ══════════════════════════════════════════════════════════════════
   *
   * 在此之前 report **只能按去重键或 id 单独取**，没有任何列举方式。
   * 于是"把数据完整导出来"这件事**结构上做不到**：其他实体都能顺着
   * 关系走（runs → verdicts → actions、issues → comments），
   * 唯独 report 是一张没有入口的表。
   *
   * 这正是"端口缺一个方法"比"某个功能没做"更隐蔽的地方——它不会报错，
   * 只会让某个以后才写的功能**默默地做不完整**。
   */
  listReports(q: ReportQuery): Promise<Page<Report>>

  findReportByDedupKey(dedupKey: string): Promise<Report | null>
  getReport(id: Report['id']): Promise<Report | null>
  /** 返回 false 表示去重键已存在（并发下的幂等语义）。 */
  insertReport(report: Report): Promise<boolean>

  // ── Run ──

  getRun(id: RunId): Promise<Run | null>
  listRuns(q: RunQuery): Promise<Page<Run>>
  insertRun(run: Run): Promise<void>

  /**
   * ★ CAS 转移。仅当当前状态等于 `expect` 时才写入 `next`。
   * @returns 是否发生了转移（false 表示前态不匹配或实体不存在）
   */
  transitionRun(
    id: RunId,
    expect: RunStatus,
    next: RunStatus,
    patch?: RunPatch,
  ): Promise<boolean>

  /** 查找占用某工作目录的 run（同目录串行化，D20）。 */
  findRunHoldingWorkDir(workDir: string, excludeRunId?: RunId): Promise<Run | null>

  /** 查找同一 (subject, agent) 上仍在进行的 run（防止自竞争，INV-17）。 */
  findActiveRunForSubjectAgent(subject: SubjectRef, agentId: AgentId): Promise<Run | null>

  // ── Run 的消息流 ──

  /**
   * 追加一条执行消息。
   *
   * 消息是**高写入量**数据，与实体记录分开存放。`seq` 由调用方按本地
   * 单调递增给出，**不依赖时间戳**——本地时钟可能漂移，而页面要靠它
   * 做「按序号补齐」（FR-BRIDGE-18）。
   */
  appendRunMessage(runId: RunId, message: RunMessage): Promise<void>
  /** 按 `since` 取消息（不含该序号本身）。 */
  listRunMessages(runId: RunId, since?: number): Promise<RunMessage[]>
  /** 该 run 已产生到第几号消息——页面据此决定补齐起点。 */
  lastRunMessageSeq(runId: RunId): Promise<number>

  // ── Verdict ──

  getVerdict(id: VerdictId): Promise<VerdictRecord | null>
  listVerdictsByRun(runId: RunId): Promise<VerdictRecord[]>
  insertVerdict(verdict: VerdictRecord): Promise<void>
  transitionVerdict(
    id: VerdictId,
    expect: VerdictStatus,
    next: VerdictStatus,
    patch?: Partial<Pick<VerdictRecord, 'invalidResolution'>>,
  ): Promise<boolean>

  // ── Action ──

  getAction(id: ActionId): Promise<Action | null>
  listActionsByVerdict(verdictId: VerdictId): Promise<Action[]>
  /** 按幂等键查找——重复触发要落 `skipped` 而不是重复执行（FR-ACTION-03）。 */
  findActionByIdempotencyKey(key: string): Promise<Action | null>
  insertAction(action: Action): Promise<void>
  transitionAction(
    id: ActionId,
    expect: ActionStatus,
    next: ActionStatus,
    patch?: ActionPatch,
  ): Promise<boolean>

  // ── Artifact ──

  listArtifactsByRun(runId: RunId): Promise<Artifact[]>
  insertArtifact(artifact: Artifact): Promise<void>

  // ── 内容寻址 ──

  /** 写入并返回 `sha256:<hex>` 引用。同一内容重复写入是幂等的。 */
  putBlob(bytes: Uint8Array): Promise<BlobRef>
  getBlob(ref: BlobRef): Promise<Uint8Array | null>
  hasBlob(ref: BlobRef): Promise<boolean>

  // ── 审计 ──

  appendAudit(record: AuditRecord): Promise<void>
  listAuditsByRun(runId: RunId): Promise<AuditRecord[]>

  // ── 通知中心 ──

  /** 追加一条通知（FR-ISSUE-07）。 */
  appendInboxItem(item: InboxItem): Promise<void>
  /** 列出通知，默认只列未读。 */
  listInboxItems(q: { workspaceId: WorkspaceId; unreadOnly?: boolean; limit?: number }): Promise<InboxItem[]>
  /** 标记已读。 */
  markInboxItemRead(id: string): Promise<boolean>
}

// ─────────────────────────────────────────────────────────────
// 可变字段（只允许这些被 patch）
// ─────────────────────────────────────────────────────────────

export interface RunPatch {
  workDir?: string | null
  waitReason?: string | null
  sessionId?: string | null
  failureReason?: Run['failureReason']
  usage?: Run['usage']
  dispatchedAt?: number | null
  startedAt?: number | null
  finishedAt?: number | null
  attempt?: number
}

export interface ActionPatch {
  status?: ActionStatus
  result?: Record<string, unknown> | null
  error?: string | null
  rollbackRef?: string | null
  finishedAt?: number | null
}

/** 打开存储的工厂签名。具体实现由适配器包提供。 */
export type StoreOpener = (options: { dataDir: string }) => Promise<Store>
