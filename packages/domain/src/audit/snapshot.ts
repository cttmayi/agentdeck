import {
  DATA_SNAPSHOT_FORMAT_VERSION,
  type Action,
  type Agent,
  type Artifact,
  type AuditRecord,
  type Comment,
  type Device,
  type InboxItem,
  type Issue,
  type Report,
  type Run,
  type Skill,
  type Tool,
  type VerdictRecord,
  type Workspace,
  type WorkspaceId,
} from '@alpha-helper/protocol'
import type { Store } from '../ports/store.ts'
import { checksumOf } from './export.ts'

/**
 * 数据快照的导出与导入（FR-STOR-05）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 需求的原文是"为迁移到数据库留通道"
 * ══════════════════════════════════════════════════════════════════
 *
 * 这句话说明它不是"备份功能"，而是一份**存储无关的中间形态**：
 * 能在文件存储上导出、在数据库存储上导入，而不经过任何一方特有的格式。
 *
 * 所以这里刻意**只走 `Store` 端口**，不碰任何适配器的内部结构
 * （不读 JSONL 日志、不读 SQLite 表）。这是"通道"能不能成立的分水岭：
 * 一旦导出里出现 `logs/run.jsonl` 这种路径，它就只是文件适配器的备份了。
 *
 * ══════════════════════════════════════════════════════════════════
 * 导入的语义：**只增不改**
 * ══════════════════════════════════════════════════════════════════
 *
 * 导入一份快照有两种可能的意图，而它们的正确行为**相反**：
 *
 *   - **迁移**（新库是空的）→ 把一切都写进去；
 *   - **合并**（目标已有数据）→ 绝不能覆盖已有的东西。
 *
 * 这里统一按"只增不改"办：已存在的 id 一律跳过并计入 `skipped`。
 * 理由是覆盖**不可逆**——一次误操作就能把现状抹掉；而跳过是安全的，
 * 后面还可以再想办法。需要"以快照为准"的场景应当显式删库再导，
 * 那是一个需要人明确做的动作，不该藏在导入里。
 *
 * ══════════════════════════════════════════════════════════════════
 * ⚠️ 不带二进制内容
 * ══════════════════════════════════════════════════════════════════
 *
 * blob（报告原文、artifact 内容）**不在快照里**：它们按内容寻址，
 * 可能很大，而且导出物是要能被人看一眼、diff 一下的。
 * 快照里保留引用（`blobRef`），所以导入之后**引用会悬空**——
 * 因此导入结果里会明确报出有多少条引用找不到内容（`danglingBlobRefs`）。
 * 装作没这回事比少导一点内容糟得多。
 */

export interface DataSnapshot {
  formatVersion: number
  exportedAt: number
  workspaceId: string
  counts: Record<string, number>
  data: {
    workspace: Workspace | null
    device: Device | null
    agents: Agent[]
    skills: Skill[]
    /**
     * 工具包（D40）。
     *
     * ★ 与 skills **并排**放在这里，而不是"以后需要再加"。
     *
     * 审计导出要求自包含（FR-AUDIT-02）：agent 挂着的 `toolIds`、判决与审计
     * 里的 `<slug>.<动作名>` 都是**引用**，被引用的包必须同一份文件里就在。
     * 漏掉它不会报任何错，只会让导出物里出现"引用了一个不存在的工具包"——
     * 拿到别处打开时看不出是"当时没导"，还是"这个包当时就不在"。
     */
    tools: Tool[]
    issues: Issue[]
    comments: Comment[]
    reports: Report[]
    runs: Run[]
    verdicts: VerdictRecord[]
    actions: Action[]
    artifacts: Artifact[]
    audits: AuditRecord[]
    inbox: InboxItem[]
  }
  /** 覆盖除自己以外全部内容的校验和。 */
  checksum: string
}

export interface ExportDataOptions {
  workspaceId: WorkspaceId
  now?: () => number
}

/** 分页取全量——端口全是分页的，导出不能只看第一页。 */
async function drainAll<T extends { id: string }>(
  fetch: (cursor: string | null) => Promise<{ items: T[]; nextCursor: string | null }>,
): Promise<T[]> {
  const out: T[] = []
  let cursor: string | null = null
  // 兜底上限：数据异常时分页可能不收敛，导出不该因此挂死
  for (let page = 0; page < 10_000; page += 1) {
    const result = await fetch(cursor)
    out.push(...result.items)
    if (!result.nextCursor) break
    cursor = result.nextCursor
  }
  return out
}

export async function exportData(
  store: Store,
  options: ExportDataOptions,
): Promise<DataSnapshot> {
  const now = options.now ?? (() => Date.now())
  const ws = options.workspaceId

  const [workspace, device, agents, skills, tools, issues, reports, runs, inbox] =
    await Promise.all([
      store.getWorkspace(ws),
      store.getDevice(),
      store.listAgents(ws),
      store.listSkills(ws),
      store.listTools(ws),
      drainAll<Issue>((cursor) => store.listIssues({ workspaceId: ws, limit: 200, cursor })),
      drainAll<Report>((cursor) => store.listReports({ workspaceId: ws, limit: 200, cursor })),
      drainAll<Run>((cursor) => store.listRuns({ workspaceId: ws, limit: 200, cursor })),
      store.listInboxItems({ workspaceId: ws, limit: 10_000 }),
    ])

  // 顺着关系把从属实体取全：它们没有"列出全部"的口子，
  // 但每一个都能从 run / issue 走得到（这正是 report 当初缺 listReports
  // 会让整个导出不完整的原因）。
  const comments: Comment[] = []
  for (const issue of issues) comments.push(...(await store.listComments(issue.id)))

  const verdicts: VerdictRecord[] = []
  const artifacts: Artifact[] = []
  const audits: AuditRecord[] = []
  for (const run of runs) {
    verdicts.push(...(await store.listVerdictsByRun(run.id)))
    artifacts.push(...(await store.listArtifactsByRun(run.id)))
    audits.push(...(await store.listAuditsByRun(run.id)))
  }

  const actions: Action[] = []
  for (const verdict of verdicts) actions.push(...(await store.listActionsByVerdict(verdict.id)))

  const data = {
    workspace,
    device,
    agents,
    skills,
    tools,
    issues,
    comments,
    reports,
    runs,
    verdicts,
    actions,
    artifacts,
    audits,
    inbox,
  }

  const draft = {
    formatVersion: DATA_SNAPSHOT_FORMAT_VERSION,
    exportedAt: now(),
    workspaceId: ws as string,
    counts: Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, Array.isArray(v) ? v.length : v ? 1 : 0]),
    ),
    data,
  }

  return { ...draft, checksum: checksumOf(draft) }
}

export interface ImportDataResult {
  /** 每个集合写入了几条。 */
  imported: Record<string, number>
  /** 因为 id 已存在而跳过了几条——**不是错误**。 */
  skipped: Record<string, number>
  /**
   * ★ 有多少引用指向快照里没有的内容。
   *
   * blob 刻意不在快照里（见文件头），所以这项**通常非零**。
   * 把它报出来是为了让人知道"导入之后有些报告原文读不到了"，
   * 而不是等到某天点开一份报告发现是空的才反应过来。
   */
  danglingBlobRefs: number
  warnings: string[]
}

/** 校验一份快照，返回具体问题。 */
export function verifyDataSnapshot(input: unknown): { ok: boolean; issues: string[] } {
  const issues: string[] = []
  if (input === null || typeof input !== 'object') return { ok: false, issues: ['不是一个对象'] }
  const doc = input as Partial<DataSnapshot>

  if (doc.formatVersion !== DATA_SNAPSHOT_FORMAT_VERSION) {
    return {
      ok: false,
      issues: [
        `格式版本不认识：文件是 ${String(doc.formatVersion)}，本程序支持 ${DATA_SNAPSHOT_FORMAT_VERSION}`,
      ],
    }
  }
  if (typeof doc.checksum !== 'string') return { ok: false, issues: ['缺少 checksum'] }
  if (doc.data === null || typeof doc.data !== 'object') {
    return { ok: false, issues: ['缺少 data'] }
  }

  const { checksum, ...rest } = doc as DataSnapshot
  if (checksumOf(rest) !== checksum) {
    issues.push('校验和对不上：内容与导出时不一致（被修改、截断或传输损坏）')
  }

  // counts 与 data 对不上说明文件被动过——即便校验和恰好也对
  for (const [key, value] of Object.entries(doc.data as Record<string, unknown>)) {
    const actual = Array.isArray(value) ? value.length : value ? 1 : 0
    const declared = (doc.counts ?? {})[key]
    if (declared !== undefined && declared !== actual) {
      issues.push(`counts.${key} 声明 ${String(declared)}，实际 ${actual} 条`)
    }
  }

  return { ok: issues.length === 0, issues }
}

/**
 * 导入一份快照。
 *
 * **只增不改**：已存在的 id 一律跳过（见文件头）。
 * 调用方应当先 `verifyDataSnapshot()` 再导入——这里也会自己校验一次，
 * 因为"导入一个损坏的快照"是不可逆的操作，值得多花一次校验。
 */
export async function importData(
  store: Store,
  snapshot: unknown,
): Promise<ImportDataResult> {
  const check = verifyDataSnapshot(snapshot)
  if (!check.ok) {
    throw new Error(`快照不可用，已拒绝导入：\n${check.issues.join('\n')}`)
  }

  const doc = snapshot as DataSnapshot
  const imported: Record<string, number> = {}
  const skipped: Record<string, number> = {}
  const warnings: string[] = []
  let danglingBlobRefs = 0

  const bump = (map: Record<string, number>, key: string): void => {
    map[key] = (map[key] ?? 0) + 1
  }

  // ── workspace 与 device ──
  if (doc.data.workspace) {
    const existing = await store.getWorkspace(doc.data.workspace.id)
    if (existing) bump(skipped, 'workspace')
    else {
      await store.insertWorkspace(doc.data.workspace)
      bump(imported, 'workspace')
    }
  }
  if (doc.data.device) {
    const existing = await store.getDevice()
    if (existing) bump(skipped, 'device')
    else {
      await store.upsertDevice(doc.data.device)
      bump(imported, 'device')
    }
  }

  // ── 简单 upsert 集合 ──
  const simple: Array<{
    key: string
    rows: Array<{ id: string }>
    get: (id: string) => Promise<unknown>
    put: (row: never) => Promise<void>
  }> = [
    {
      key: 'agents',
      rows: doc.data.agents,
      get: (id) => store.getAgent(id as Agent['id']),
      put: (row) => store.insertAgent(row),
    },
    {
      key: 'skills',
      rows: doc.data.skills,
      get: (id) => store.getSkill(id as Skill['id']),
      put: (row) => store.insertSkill(row),
    },
    {
      /**
       * ⚠️ 这里的 `?? []` 不是防御性编程，而是**真的会走到**：快照的格式版本
       *    没有因为加 tools 而变（`DATA_SNAPSHOT_FORMAT_VERSION` 仍是 1），
       *    所以使用者手上那份旧版本导出的文件是完全正常的，它的 `data` 里
       *    没有 `tools` 这一段。此时"一个工具包都没导"才是正确解读——
       *    **不是**补一份，也**不是**拒绝导入（拒绝等于让旧备份突然打不开）。
       */
      key: 'tools',
      rows: doc.data.tools ?? [],
      get: (id) => store.getTool(id as Tool['id']),
      put: (row) => store.insertTool(row),
    },
    {
      key: 'issues',
      rows: doc.data.issues,
      get: (id) => store.getIssue(id as Issue['id']),
      put: (row) => store.insertIssue(row),
    },
    {
      key: 'runs',
      rows: doc.data.runs,
      get: (id) => store.getRun(id as Run['id']),
      put: (row) => store.insertRun(row),
    },
    {
      key: 'verdicts',
      rows: doc.data.verdicts,
      get: (id) => store.getVerdict(id as VerdictRecord['id']),
      put: (row) => store.insertVerdict(row),
    },
    {
      key: 'actions',
      rows: doc.data.actions,
      get: (id) => store.getAction(id as Action['id']),
      put: (row) => store.insertAction(row),
    },
  ]

  for (const group of simple) {
    for (const row of group.rows) {
      const existing = await group.get(row.id)
      if (existing) {
        bump(skipped, group.key)
        continue
      }
      await group.put(row as never)
      bump(imported, group.key)
    }
  }

  // ── 只增的从属集合（端口没有"按 id 取"，所以按父对象先查一遍去重）──
  for (const comment of doc.data.comments) {
    const siblings = await store.listComments(comment.issueId)
    if (siblings.some((c) => c.id === comment.id)) {
      bump(skipped, 'comments')
      continue
    }
    await store.insertComment(comment)
    bump(imported, 'comments')
  }

  for (const report of doc.data.reports) {
    const existing = await store.getReport(report.id)
    if (existing) {
      bump(skipped, 'reports')
      continue
    }
    await store.insertReport(report)
    bump(imported, 'reports')
  }

  for (const audit of doc.data.audits) {
    const siblings = await store.listAuditsByRun(audit.runId)
    if (siblings.some((a) => a.id === audit.id)) {
      bump(skipped, 'audits')
      continue
    }
    await store.appendAudit(audit)
    bump(imported, 'audits')
  }

  for (const artifact of doc.data.artifacts) {
    const siblings = await store.listArtifactsByRun(artifact.runId)
    if (siblings.some((a) => a.id === artifact.id)) {
      bump(skipped, 'artifacts')
      continue
    }
    await store.insertArtifact(artifact)
    bump(imported, 'artifacts')
  }

  const existingInbox = await store.listInboxItems({
    workspaceId: doc.workspaceId as WorkspaceId,
    limit: 10_000,
  })
  const inboxIds = new Set(existingInbox.map((i) => i.id))
  for (const item of doc.data.inbox) {
    if (inboxIds.has(item.id)) {
      bump(skipped, 'inbox')
      continue
    }
    await store.appendInboxItem(item)
    bump(imported, 'inbox')
  }

  // ── ★ 悬空引用统计：blob 不在快照里，引用必然可能落空 ──
  for (const report of doc.data.reports) {
    if (report.blobRef && !(await store.hasBlob(report.blobRef))) danglingBlobRefs += 1
  }
  for (const audit of doc.data.audits) {
    for (const ref of audit.inputBlobRefs) {
      if (!(await store.hasBlob(ref))) danglingBlobRefs += 1
    }
  }

  if (danglingBlobRefs > 0) {
    warnings.push(
      `有 ${danglingBlobRefs} 处内容引用（blob）在快照里没有对应内容——` +
        `快照刻意不含二进制原文（见 export-data 的说明）。` +
        `这些记录还在，但它们的**原文读不到了**。`,
    )
  }

  return { imported, skipped, danglingBlobRefs, warnings }
}
