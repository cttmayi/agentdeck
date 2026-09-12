import { join } from 'node:path'
import {
  ACTIVE_RUN_STATUSES,
  assertActionTransition,
  assertRunTransition,
  assertVerdictTransition,
  type ActionPatch,
  type IssueQuery,
  type ReportQuery,
  type Page,
  type PageQuery,
  type RunPatch,
  type RunQuery,
  type Store,
} from '@alpha-helper/domain'
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
  ReportId,
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
import { ulid } from '@alpha-helper/protocol'
import { BlobStore } from './blobs.ts'
import {
  atomicWrite,
  ensureDir,
  readJsonOrNull,
  removeQuietly,
  sha256Hex,
} from './fs-utils.ts'
import { JsonlLog } from './log.ts'
import { LockHeldError, acquireLock } from './lock.ts'
import { MessageLog, ensureRunDir, messageLogPath } from './messages.ts'
import { Mutex, pruneUndefined } from './mutex.ts'

/**
 * 文件存储适配器 —— `Store` 端口的 v1 实现。
 *
 * 目录布局：
 *
 *   <dataDir>/
 *   ├── meta.json                     { formatVersion, instanceId }
 *   ├── lock                          单进程锁
 *   ├── device.json                   本机设备标识
 *   ├── workspaces.jsonl              workspace 记录（全局，量小）
 *   └── workspaces/<wsId>/
 *       ├── log/<collection>.jsonl    append-only，权威记录
 *       ├── log/<collection>.jsonl.snapshot   压缩后的物化快照
 *       ├── blobs/<前两位>/<sha256>    内容寻址
 *       └── runs/<runId>/messages.jsonl        执行消息流
 *
 * 关于设计文档的一处偏离：文档里还列了 `runs/<runId>/run.json`。
 * 实现时去掉了它——run 记录已经以追加记录的形式存在于 `log/run.jsonl`，
 * 再存一份就变成**双份真相**，迟早会不一致。`runs/<runId>/` 只放消息流。
 */

export const STORE_FORMAT_VERSION = 1

const COLLECTIONS = [
  'agent',
  'skill',
  'issue',
  'comment',
  'run',
  'report',
  'verdict',
  'action',
  'artifact',
  'audit',
  'inbox',
] as const

type CollectionName = (typeof COLLECTIONS)[number]

interface Meta {
  formatVersion: number
  instanceId: string
}

export interface FileStoreOptions {
  dataDir: string
  /** 关掉 fsync 换取速度——**只应在测试里用**。 */
  fsync?: boolean
}

/** 排序 + 游标分页。游标就是上一页最后一条的 id（ULID，可排序）。 */
/**
 * 排序 + 游标分页。游标就是上一页最后一条的 id（ULID，可排序）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这里曾经有一个"会静默重放第一页"的 bug
 * ══════════════════════════════════════════════════════════════════
 *
 * 旧实现是 `findIndex(i => i.id === cursor) + 1`。当游标**在数据里找不到**时
 * `findIndex` 返回 `-1`，于是 `start = 0`——**从头再来一遍**。
 *
 * 这个失败很隐蔽：调用方拿到的是合法的一页数据，`nextCursor` 也照常给出，
 * 一切看起来正常。但翻页的客户端会永远在"第一页 → 第二页 → 第一页"之间
 * 打转，而**没有任何错误被报出来**。
 *
 * 游标找不到并不罕见：上一页最后一条恰好在两次翻页之间被删掉就会发生。
 *
 * 修法是**不比"身份"而比"位置"**：游标本来就是 ULID，排序键也正是 id，
 * 所以"id 大于游标的那些"就是"游标之后的那些"——游标那条还在不在都不影响。
 * 三种情况的处置因此都变正确了：
 *   - 游标还在   → 与原语义完全一致；
 *   - 游标被删   → 正确地从它原本的位置之后继续（而不是重放）；
 *   - 游标是垃圾 → 大于全部则返回空并终止，小于全部则返回全部，
 *                  两种情况都**不会**悄悄回头重来。
 */
function paginate<T extends { id: string }>(items: readonly T[], q: PageQuery): Page<T> {
  const sorted = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  let start = 0
  if (q.cursor) {
    const cursor = q.cursor
    const idx = sorted.findIndex((i) => i.id > cursor)
    start = idx === -1 ? sorted.length : idx
  }

  const limit = q.limit ?? 50
  const slice = sorted.slice(start, start + limit)
  const last = slice[slice.length - 1]
  return {
    items: slice,
    nextCursor: start + limit < sorted.length && last ? last.id : null,
  }
}

function isActiveRun(run: Run): boolean {
  return (ACTIVE_RUN_STATUSES as readonly RunStatus[]).includes(run.status)
}

/** 单个 workspace 的数据。 */
class WorkspaceStore {
  readonly #root: string
  readonly #wsId: WorkspaceId
  readonly #fsync: boolean
  readonly #mutex = new Mutex()

  readonly logs: Record<CollectionName, JsonlLog<{ id: string }>>
  readonly blobs: BlobStore

  readonly #messages = new Map<string, MessageLog>()
  readonly #dedup = new Map<string, ReportId>()
  readonly #idempotency = new Map<string, ActionId>()

  #opened = false

  constructor(root: string, wsId: WorkspaceId, fsync: boolean) {
    this.#root = root
    this.#wsId = wsId
    this.#fsync = fsync
    this.blobs = new BlobStore(join(root, 'blobs'))

    const logs = {} as Record<CollectionName, JsonlLog<{ id: string }>>
    for (const name of COLLECTIONS) {
      logs[name] = new JsonlLog<{ id: string }>(join(root, 'log', `${name}.jsonl`), { fsync })
    }
    this.logs = logs
  }

  get mutex(): Mutex {
    return this.#mutex
  }

  /** 强类型取日志——避免到处写 `as unknown as`。 */
  log<K extends CollectionName>(name: K): JsonlLog<{ id: string }> {
    return this.logs[name]
  }

  run(): JsonlLog<Run & { id: string }> {
    return this.log('run') as unknown as JsonlLog<Run & { id: string }>
  }
  agent(): JsonlLog<Agent & { id: string }> {
    return this.log('agent') as unknown as JsonlLog<Agent & { id: string }>
  }
  skill(): JsonlLog<Skill & { id: string }> {
    return this.log('skill') as unknown as JsonlLog<Skill & { id: string }>
  }
  issue(): JsonlLog<Issue & { id: string }> {
    return this.log('issue') as unknown as JsonlLog<Issue & { id: string }>
  }
  comment(): JsonlLog<Comment & { id: string }> {
    return this.log('comment') as unknown as JsonlLog<Comment & { id: string }>
  }
  report(): JsonlLog<Report & { id: string }> {
    return this.log('report') as unknown as JsonlLog<Report & { id: string }>
  }
  verdict(): JsonlLog<VerdictRecord & { id: string }> {
    return this.log('verdict') as unknown as JsonlLog<VerdictRecord & { id: string }>
  }
  action(): JsonlLog<Action & { id: string }> {
    return this.log('action') as unknown as JsonlLog<Action & { id: string }>
  }
  artifact(): JsonlLog<Artifact & { id: string }> {
    return this.log('artifact') as unknown as JsonlLog<Artifact & { id: string }>
  }
  audit(): JsonlLog<AuditRecord & { id: string }> {
    return this.log('audit') as unknown as JsonlLog<AuditRecord & { id: string }>
  }
  inbox(): JsonlLog<InboxItem> {
    return this.log('inbox') as unknown as JsonlLog<InboxItem>
  }

  async open(): Promise<void> {
    if (this.#opened) return
    await ensureDir(this.#root)
    for (const name of COLLECTIONS) {
      await this.logs[name]!.open()
    }
    // 重建两个唯一性索引——它们必须与日志一致，所以从日志推导而不是单独持久化
    for (const r of this.report().all()) this.#dedup.set(r.dedupKey, r.id as ReportId)
    for (const a of this.action().all()) this.#idempotency.set(a.idempotencyKey, a.id as ActionId)
    this.#opened = true
  }

  async messageLogFor(runId: RunId): Promise<MessageLog> {
    const key = runId as string
    let log = this.#messages.get(key)
    if (!log) {
      const dir = join(this.#root, 'runs')
      await ensureRunDir(dir, runId)
      log = new MessageLog(messageLogPath(dir, runId), { fsync: this.#fsync })
      await log.open()
      this.#messages.set(key, log)
    }
    return log
  }

  // ── Report 去重 ──

  findReportIdByDedup(dedupKey: string): ReportId | null {
    return this.#dedup.get(dedupKey) ?? null
  }

  rememberDedup(dedupKey: string, id: ReportId): void {
    this.#dedup.set(dedupKey, id)
  }

  // ── Action 幂等 ──

  findActionIdByIdempotency(key: string): ActionId | null {
    return this.#idempotency.get(key) ?? null
  }

  rememberIdempotency(key: string, id: ActionId): void {
    this.#idempotency.set(key, id)
  }

  async close(): Promise<void> {
    for (const log of this.#messages.values()) await log.close()
    this.#messages.clear()
    for (const name of COLLECTIONS) await this.logs[name]!.close()
  }

  /** 压缩所有集合的日志。 */
  async compact(): Promise<void> {
    for (const name of COLLECTIONS) await this.logs[name]!.compact()
  }
}

export class FileStore implements Store {
  readonly #dataDir: string
  readonly #fsync: boolean
  readonly #meta: Meta
  /** workspace 记录单独存放——这样 getWorkspace 不必先打开它的目录。 */
  readonly #wsIndex: JsonlLog<Workspace & { id: string }>
  readonly #device = new Mutex()
  readonly #mutex = new Mutex()
  readonly #stores = new Map<string, WorkspaceStore>()
  #releaseLock: (() => Promise<void>) | null = null

  private constructor(dataDir: string, meta: Meta, fsync: boolean) {
    this.#dataDir = dataDir
    this.#fsync = fsync
    this.#meta = meta
    this.#wsIndex = new JsonlLog<Workspace & { id: string }>(join(dataDir, 'workspaces.jsonl'), {
      fsync,
    })
  }

  static async open(options: FileStoreOptions): Promise<FileStore> {
    const { dataDir } = options
    const fsync = options.fsync ?? true
    await ensureDir(dataDir)

    const existing = await readJsonOrNull<Meta>(join(dataDir, 'meta.json'))
    let meta: Meta
    if (existing) {
      if (existing.formatVersion > STORE_FORMAT_VERSION) {
        throw new Error(
          `数据目录的存储格式版本为 ${existing.formatVersion}，高于本程序支持的 ${STORE_FORMAT_VERSION}。` +
            `请升级程序，不要用旧版本打开新数据。`,
        )
      }
      meta = existing
    } else {
      meta = { formatVersion: STORE_FORMAT_VERSION, instanceId: ulid() }
      await atomicWrite(join(dataDir, 'meta.json'), JSON.stringify(meta, null, 2))
    }

    const store = new FileStore(dataDir, meta, fsync)
    // 锁必须在读日志之前拿到，否则第二个进程会先读到一半状态
    store.#releaseLock = await acquireLock(dataDir)
    await store.#wsIndex.open()

    // 预加载所有已知 workspace。
    //
    // 不能留成懒加载：`getAgent` / `getRun` / `findReportByDedupKey` 这些
    // 方法是**跨 workspace 查找**的，它们遍历 `#stores`。如果 store 是懒建的，
    // 重开进程后 `#stores` 为空，查找会全部返回 null —— 表现为"数据丢了"，
    // 而数据其实好好躺在日志里。
    for (const ws of store.#wsIndex.all()) {
      await store.#ws(ws.id as WorkspaceId)
    }
    return store
  }

  async formatVersion(): Promise<number> {
    return this.#meta.formatVersion
  }

  async #ws(workspaceId: WorkspaceId): Promise<WorkspaceStore> {
    const key = workspaceId as string
    let ws = this.#stores.get(key)
    if (!ws) {
      ws = new WorkspaceStore(join(this.#dataDir, 'workspaces', key), workspaceId, this.#fsync)
      await ws.open()
      this.#stores.set(key, ws)
    }
    return ws
  }

  // ── Workspace 与 Device ──

  async getWorkspace(id: WorkspaceId): Promise<Workspace | null> {
    return this.#wsIndex.get(id) ?? null
  }

  async insertWorkspace(ws: Workspace): Promise<void> {
    await this.#wsIndex.put(ws)
  }

  async getDevice(): Promise<Device | null> {
    return readJsonOrNull<Device>(join(this.#dataDir, 'device.json'))
  }

  async upsertDevice(device: Device): Promise<void> {
    await this.#device.run(() =>
      atomicWrite(join(this.#dataDir, 'device.json'), JSON.stringify(device, null, 2)),
    )
  }

  // ── Agent ──

  async getAgent(id: AgentId): Promise<Agent | null> {
    for (const ws of this.#stores.values()) {
      const found = ws.agent().get(id)
      if (found) return found
    }
    return null
  }

  async listAgents(workspaceId: WorkspaceId): Promise<Agent[]> {
    return (await this.#ws(workspaceId)).agent().all()
  }

  async insertAgent(agent: Agent): Promise<void> {
    const ws = await this.#ws(agent.workspaceId)
    await ws.mutex.run(() => ws.agent().put(agent))
  }

  // ── Skill ──

  async getSkill(id: SkillId): Promise<Skill | null> {
    for (const ws of this.#stores.values()) {
      const found = ws.skill().get(id)
      if (found) return found
    }
    return null
  }

  async listSkills(workspaceId: WorkspaceId): Promise<Skill[]> {
    return (await this.#ws(workspaceId)).skill().all()
  }

  async listSkillsByIds(ids: readonly SkillId[]): Promise<Skill[]> {
    const wanted = new Set<string>(ids)
    const out: Skill[] = []
    for (const ws of this.#stores.values()) {
      for (const s of ws.skill().all()) if (wanted.has(s.id)) out.push(s)
    }
    return out
  }

  async insertSkill(skill: Skill): Promise<void> {
    const ws = await this.#ws(skill.workspaceId)
    await ws.mutex.run(() => ws.skill().put(skill))
  }

  // ── Issue 与 Comment ──

  async getIssue(id: IssueId): Promise<Issue | null> {
    for (const ws of this.#stores.values()) {
      const found = ws.issue().get(id)
      if (found) return found
    }
    return null
  }

  async listIssues(q: IssueQuery): Promise<Page<Issue>> {
    const ws = await this.#ws(q.workspaceId)
    let items = ws.issue().all()
    if (q.status?.length) {
      const wanted = new Set<string>(q.status)
      items = items.filter((i) => wanted.has(i.status))
    }
    if (q.assigneeId) items = items.filter((i) => i.assignee?.id === q.assigneeId)
    if (q.search) {
      const needle = q.search.toLowerCase()
      items = items.filter(
        (i) =>
          i.title.toLowerCase().includes(needle) ||
          i.description.toLowerCase().includes(needle),
      )
    }
    return paginate(items, q)
  }

  async insertIssue(issue: Issue): Promise<void> {
    const ws = await this.#ws(issue.workspaceId)
    await ws.mutex.run(() => ws.issue().put(issue))
  }

  async transitionIssue(
    id: IssueId,
    expect: Issue['status'],
    next: Issue['status'],
    patch: Partial<Pick<Issue, 'assignee' | 'labels' | 'priority' | 'title' | 'description'>> = {},
  ): Promise<boolean> {
    for (const ws of this.#stores.values()) {
      const current = ws.issue().get(id)
      if (!current) continue
      return ws.mutex.run(async () => {
        const fresh = ws.issue().get(id)
        if (!fresh || fresh.status !== expect) return false
        await ws
          .issue()
          .patch(id, { ...pruneUndefined(patch), status: next, updatedAt: Date.now() })
        return true
      })
    }
    return false
  }

  async listComments(issueId: IssueId): Promise<Comment[]> {
    const out: Comment[] = []
    for (const ws of this.#stores.values()) {
      for (const c of ws.comment().all()) if (c.issueId === issueId) out.push(c)
    }
    return out.sort((a, b) => a.createdAt - b.createdAt)
  }

  async insertComment(comment: Comment): Promise<void> {
    const ws = await this.#ws(comment.workspaceId)
    await ws.mutex.run(() => ws.comment().put(comment))
  }

  // ── Report ──

  async listReports(q: ReportQuery): Promise<Page<Report>> {
    const ws = await this.#ws(q.workspaceId)
    return paginate(ws.report().all(), q)
  }

  async findReportByDedupKey(dedupKey: string): Promise<Report | null> {
    for (const ws of this.#stores.values()) {
      const id = ws.findReportIdByDedup(dedupKey)
      if (id) return ws.report().get(id) ?? null
    }
    return null
  }

  async getReport(id: Report['id']): Promise<Report | null> {
    for (const ws of this.#stores.values()) {
      const found = ws.report().get(id)
      if (found) return found
    }
    return null
  }

  /**
   * 返回 false 表示去重键已存在。
   *
   * 这个返回值是 `FR-REPORT-03` 的落点：调用方（摄取流程）必须把 false
   * 当作"已经处理过"，而不是"写入失败"。
   */
  async insertReport(report: Report): Promise<boolean> {
    const ws = await this.#ws(report.workspaceId)
    return ws.mutex.run(async () => {
      if (ws.findReportIdByDedup(report.dedupKey)) return false
      await ws.report().put(report)
      ws.rememberDedup(report.dedupKey, report.id)
      return true
    })
  }

  // ── Run ──

  async getRun(id: RunId): Promise<Run | null> {
    for (const ws of this.#stores.values()) {
      const found = ws.run().get(id)
      if (found) return found
    }
    return null
  }

  async listRuns(q: RunQuery): Promise<Page<Run>> {
    const ws = await this.#ws(q.workspaceId)
    let items = ws.run().all()
    if (q.status?.length) {
      const wanted = new Set<string>(q.status)
      items = items.filter((r) => wanted.has(r.status))
    }
    if (q.agentId) items = items.filter((r) => r.agentId === q.agentId)
    return paginate(items, q)
  }

  async insertRun(run: Run): Promise<void> {
    const ws = await this.#ws(run.workspaceId)
    await ws.mutex.run(() => ws.run().put(run))
  }

  /**
   * ★ CAS 转移。
   *
   * 这一条在文件存储上是"加锁读 → 校验前态 → 追加"，在数据库上就是
   * `UPDATE ... WHERE id = ? AND status = expect`。**语义相同**，所以
   * 领域逻辑不需要知道底下是什么。
   *
   * 这里还会再跑一次状态机校验：不是不信任领域层，而是让"写进一个
   * 非法状态"变成**当场报错**，而不是几天后从数据里发现。
   */
  async transitionRun(
    id: RunId,
    expect: RunStatus,
    next: RunStatus,
    patch: RunPatch = {},
  ): Promise<boolean> {
    for (const ws of this.#stores.values()) {
      if (!ws.run().has(id)) continue
      return ws.mutex.run(async () => {
        const current = ws.run().get(id)
        if (!current) return false
        if (current.status !== expect) return false
        assertRunTransition(expect, next)
        await ws.run().patch(id, { ...pruneUndefined(patch), status: next })
        return true
      })
    }
    return false
  }

  async findRunHoldingWorkDir(workDir: string, excludeRunId?: RunId): Promise<Run | null> {
    for (const ws of this.#stores.values()) {
      for (const r of ws.run().all()) {
        if (r.workDir !== workDir) continue
        if (excludeRunId && r.id === excludeRunId) continue
        if (isActiveRun(r)) return r
      }
    }
    return null
  }

  async findActiveRunForSubjectAgent(subject: SubjectRef, agentId: AgentId): Promise<Run | null> {
    for (const ws of this.#stores.values()) {
      for (const r of ws.run().all()) {
        if (r.agentId !== agentId) continue
        if (r.subject.type !== subject.type || r.subject.id !== subject.id) continue
        if (isActiveRun(r)) return r
      }
    }
    return null
  }

  async appendRunMessage(runId: RunId, message: RunMessage): Promise<void> {
    const ws = await this.#findWorkspaceOfRun(runId)
    const log = await ws.mutex.run(() => ws.messageLogFor(runId))
    await log.append(message)
  }

  async listRunMessages(runId: RunId, since = -1): Promise<RunMessage[]> {
    const ws = await this.#findWorkspaceOfRun(runId)
    const log = await ws.mutex.run(async () => ws.messageLogFor(runId))
    return log.read(since)
  }

  async lastRunMessageSeq(runId: RunId): Promise<number> {
    const ws = await this.#findWorkspaceOfRun(runId)
    const log = await ws.mutex.run(async () => ws.messageLogFor(runId))
    return log.lastSeq
  }

  async #findWorkspaceOfRun(runId: RunId): Promise<WorkspaceStore> {
    for (const ws of this.#stores.values()) {
      if (ws.run().has(runId)) return ws
    }
    throw new Error(`找不到 run ${runId}（消息流必须挂在一个已知 run 上）`)
  }

  // ── Verdict ──

  async getVerdict(id: VerdictId): Promise<VerdictRecord | null> {
    for (const ws of this.#stores.values()) {
      const found = ws.verdict().get(id)
      if (found) return found
    }
    return null
  }

  async listVerdictsByRun(runId: RunId): Promise<VerdictRecord[]> {
    const out: VerdictRecord[] = []
    for (const ws of this.#stores.values()) {
      for (const v of ws.verdict().all()) if (v.runId === runId) out.push(v)
    }
    return out.sort((a, b) => a.createdAt - b.createdAt)
  }

  async insertVerdict(verdict: VerdictRecord): Promise<void> {
    const ws = await this.#ws(verdict.workspaceId)
    await ws.mutex.run(() => ws.verdict().put(verdict))
  }

  async transitionVerdict(
    id: VerdictId,
    expect: VerdictStatus,
    next: VerdictStatus,
    patch: Partial<Pick<VerdictRecord, 'invalidResolution'>> = {},
  ): Promise<boolean> {
    for (const ws of this.#stores.values()) {
      if (!ws.verdict().has(id)) continue
      return ws.mutex.run(async () => {
        const current = ws.verdict().get(id)
        if (!current || current.status !== expect) return false
        assertVerdictTransition(expect, next)
        await ws.verdict().patch(id, { ...pruneUndefined(patch), status: next })
        return true
      })
    }
    return false
  }

  // ── Action ──

  async getAction(id: ActionId): Promise<Action | null> {
    for (const ws of this.#stores.values()) {
      const found = ws.action().get(id)
      if (found) return found
    }
    return null
  }

  async listActionsByVerdict(verdictId: VerdictId): Promise<Action[]> {
    const out: Action[] = []
    for (const ws of this.#stores.values()) {
      for (const a of ws.action().all()) if (a.verdictId === verdictId) out.push(a)
    }
    return out.sort((a, b) => a.createdAt - b.createdAt)
  }

  async findActionByIdempotencyKey(key: string): Promise<Action | null> {
    for (const ws of this.#stores.values()) {
      const id = ws.findActionIdByIdempotency(key)
      if (id) return ws.action().get(id) ?? null
    }
    return null
  }

  async insertAction(action: Action): Promise<void> {
    const ws = await this.#ws(action.workspaceId)
    await ws.mutex.run(async () => {
      await ws.action().put(action)
      ws.rememberIdempotency(action.idempotencyKey, action.id)
    })
  }

  async transitionAction(
    id: ActionId,
    expect: ActionStatus,
    next: ActionStatus,
    patch: ActionPatch = {},
  ): Promise<boolean> {
    for (const ws of this.#stores.values()) {
      if (!ws.action().has(id)) continue
      return ws.mutex.run(async () => {
        const current = ws.action().get(id)
        if (!current || current.status !== expect) return false
        assertActionTransition(expect, next)
        await ws.action().patch(id, { ...pruneUndefined(patch), status: next })
        return true
      })
    }
    return false
  }

  // ── Artifact ──

  async listArtifactsByRun(runId: RunId): Promise<Artifact[]> {
    const out: Artifact[] = []
    for (const ws of this.#stores.values()) {
      for (const a of ws.artifact().all()) if (a.runId === runId) out.push(a)
    }
    return out.sort((a, b) => a.createdAt - b.createdAt)
  }

  async insertArtifact(artifact: Artifact): Promise<void> {
    const ws = await this.#ws(artifact.workspaceId)
    await ws.mutex.run(() => ws.artifact().put(artifact))
  }

  // ── Blob ──

  async putBlob(bytes: Uint8Array): Promise<BlobRef> {
    // blob 是全局的，但按 workspace 分目录存；这里用第一个 workspace，
    // 没有 workspace 时落到根下——内容寻址使得放哪儿都不影响正确性。
    const ws = [...this.#stores.values()][0]
    if (ws) return ws.blobs.put(bytes)
    return new BlobStore(join(this.#dataDir, 'blobs')).put(bytes)
  }

  async getBlob(ref: BlobRef): Promise<Uint8Array | null> {
    for (const ws of this.#stores.values()) {
      const bytes = await ws.blobs.get(ref)
      if (bytes) return bytes
    }
    return new BlobStore(join(this.#dataDir, 'blobs')).get(ref)
  }

  async hasBlob(ref: BlobRef): Promise<boolean> {
    for (const ws of this.#stores.values()) {
      if (await ws.blobs.has(ref)) return true
    }
    return new BlobStore(join(this.#dataDir, 'blobs')).has(ref)
  }

  // ── Audit ──

  async appendAudit(record: AuditRecord): Promise<void> {
    const ws = await this.#ws(record.workspaceId)
    await ws.mutex.run(() => ws.audit().put(record))
  }

  async listAuditsByRun(runId: RunId): Promise<AuditRecord[]> {
    const out: AuditRecord[] = []
    for (const ws of this.#stores.values()) {
      for (const a of ws.audit().all()) if (a.runId === runId) out.push(a)
    }
    return out.sort((a, b) => a.queuedAt - b.queuedAt)
  }

  async listWorkspaceIds(): Promise<WorkspaceId[]> {
    return this.#wsIndex.all().map((w) => w.id as WorkspaceId)
  }

  // ── 通知中心 ──

  async appendInboxItem(item: InboxItem): Promise<void> {
    const ws = await this.#ws(item.workspaceId as WorkspaceId)
    await ws.mutex.run(() => ws.inbox().put(item))
  }

  async listInboxItems(q: {
    workspaceId: WorkspaceId
    unreadOnly?: boolean
    limit?: number
  }): Promise<InboxItem[]> {
    const ws = await this.#ws(q.workspaceId)
    let items = ws.inbox().all()
    if (q.unreadOnly ?? true) items = items.filter((i) => !i.read)
    return items
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, q.limit ?? 100)
  }

  async markInboxItemRead(id: string): Promise<boolean> {
    for (const ws of this.#stores.values()) {
      if (!ws.inbox().has(id)) continue
      return ws.mutex.run(() => ws.inbox().patch(id, { read: true }))
    }
    return false
  }

  // ── 额外（不属于端口，供运维使用）──

  /** 压缩全部日志：物化快照并丢弃已合并的增量。 */
  async compact(): Promise<void> {
    await this.#mutex.run(async () => {
      await this.#wsIndex.compact()
      for (const ws of this.#stores.values()) await ws.compact()
    })
  }

  async close(): Promise<void> {
    for (const ws of this.#stores.values()) await ws.close()
    this.#stores.clear()
    await this.#wsIndex.close()
    if (this.#releaseLock) {
      await this.#releaseLock()
      this.#releaseLock = null
    }
  }
}

/** 便捷打开函数，符合 `StoreOpener` 签名。 */
export async function openFileStore(options: FileStoreOptions): Promise<FileStore> {
  return FileStore.open(options)
}

export { LockHeldError }
export { sha256Hex }
export { removeQuietly }
