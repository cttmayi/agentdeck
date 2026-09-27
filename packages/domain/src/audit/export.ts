import { createHash } from 'node:crypto'
import { AUDIT_EXPORT_FORMAT_VERSION, type AuditRecord, type TokenUsage } from '@agentdeck/protocol'
import type { Store } from '../ports/store.ts'
import type { WorkspaceId } from '@agentdeck/protocol'

/**
 * 审计导出（M4）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这个功能存在的理由：审计链是"可追溯"，不是"可复现"
 * ══════════════════════════════════════════════════════════════════
 *
 * skill 记录里**不含指纹**（D9），所以严格来说"当初到底跑了什么"只能追溯到
 * 版本这一层。这不是缺陷，是一个明确的取舍：记指纹意味着每次改 skill
 * 都要归档一整份内容，而使用者真正需要的是"能查"，不是"能逐字节重放"。
 *
 * 正因为如此，导出必须**如实说明这一点**——导出的文件里要带上这句限制，
 * 否则拿到文件的人会以为它能用来复现。把边界写进产物里，比写在文档里可靠。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么自带校验和
 * ══════════════════════════════════════════════════════════════════
 *
 * 导出的用途是"带出去给别人看"或者"存档备查"。这两种用途下，文件被
 * 部分修改、截断、或者中途传输损坏都是真实会发生的。没有校验和的话，
 * 一份被改过的审计文件**看起来和真的一模一样**——那比没有审计更糟。
 *
 * 校验和覆盖除它自己以外的全部内容，所以任何一行的改动都会让它对不上。
 */

export interface AuditExport {
  formatVersion: number
  exportedAt: number
  workspaceId: string
  /** 记录条数，便于快速核对。 */
  count: number
  /**
   * ★ 如实披露的能力边界。
   *
   * 这一条会随文件一起被带走，所以必须写在文件里，不能只写在文档里。
   */
  limitations: string[]
  records: AuditRecord[]
  /** 覆盖上述全部字段（不含本字段）的 sha256。 */
  checksum: string
}

export interface AuditExportOptions {
  workspaceId: WorkspaceId
  /** 只导出这些 run；省略则导出该工作区全部已知 run。 */
  runIds?: readonly string[]
  now?: () => number
}

/** 导出审计链。 */
export async function exportAudit(
  store: Store,
  options: AuditExportOptions,
): Promise<AuditExport> {
  const now = options.now ?? (() => Date.now())

  const runIds =
    options.runIds ??
    (
      await store.listRuns({ workspaceId: options.workspaceId, limit: 10_000 })
    ).items.map((r) => r.id)

  const records: AuditRecord[] = []
  for (const runId of runIds) {
    const found = await store.listAuditsByRun(runId as AuditRecord['runId'])
    for (const r of found) {
      // 防御性过滤：多工作区共用一份导出时不能串数据
      if ((r.workspaceId as string) === (options.workspaceId as string)) records.push(r)
    }
  }

  // 稳定排序：同一份数据导出两次必须得到**逐字节相同**的文件，
  // 否则"对比两次导出"这个最基本的用法就没法用。
  records.sort((a, b) => (a.runId === b.runId ? a.id.localeCompare(b.id) : a.runId.localeCompare(b.runId)))

  const draft = {
    formatVersion: AUDIT_EXPORT_FORMAT_VERSION,
    exportedAt: now(),
    workspaceId: options.workspaceId as string,
    count: records.length,
    limitations: [
      'skill 记录不含内容指纹（D9）：只能追溯到"用了哪个 skill"，不能逐字节复现当初的内容。',
      'argv 已脱敏：令牌类参数被替换为 ***，因此导出的命令行不可直接重放。',
      '本文件是审计记录，不是执行凭据：它证明"发生过什么"，不能用来重新执行。',
    ],
    records,
  }

  return { ...draft, checksum: checksumOf(draft) }
}

/**
 * 校验一份导出文件。
 *
 * 返回具体哪里对不上，而不是一句"校验失败"——拿到文件的人需要知道
 * 是"被改过"还是"版本不认识"，这两件事的处置完全不同。
 */
export function verifyAuditExport(input: unknown): {
  ok: boolean
  issues: string[]
} {
  const issues: string[] = []
  if (input === null || typeof input !== 'object') {
    return { ok: false, issues: ['不是一个对象'] }
  }
  const doc = input as Partial<AuditExport>

  if (doc.formatVersion !== AUDIT_EXPORT_FORMAT_VERSION) {
    issues.push(
      `格式版本不认识：文件是 ${String(doc.formatVersion)}，本程序支持 ${AUDIT_EXPORT_FORMAT_VERSION}`,
    )
    return { ok: false, issues }
  }
  if (typeof doc.checksum !== 'string') {
    return { ok: false, issues: ['缺少 checksum'] }
  }
  if (!Array.isArray(doc.records)) {
    return { ok: false, issues: ['records 不是数组'] }
  }
  if (doc.count !== doc.records.length) {
    issues.push(`count 声明 ${String(doc.count)}，实际 ${doc.records.length} 条——文件被改过或被截断`)
  }

  const { checksum, ...rest } = doc as AuditExport
  const actual = checksumOf(rest)
  if (actual !== checksum) {
    issues.push('校验和对不上：内容与导出时不一致（被修改、截断或传输损坏）')
  }

  return { ok: issues.length === 0, issues }
}

/**
 * 计算校验和。
 *
 * 用**规范化的 JSON**（键按字典序、不含 undefined）而不是直接
 * `JSON.stringify`：对象字面量的键顺序在解析回来之后不保证与写入时一致，
 * 直接序列化会让"原封不动读回来再校验"都失败——那种校验和比没有更糟。
 */
export function checksumOf(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

// ─────────────────────────────────────────────────────────────
// 成本聚合（M4）
// ─────────────────────────────────────────────────────────────

export interface CostBucket {
  key: string
  runs: number
  inputTokens: number
  outputTokens: number
  costUsdMicros: number
  /** 有多少条 run 的成本是**估算**而非 provider 上报（design §11.3）。 */
  estimatedRuns: number
}

export interface CostReport {
  total: CostBucket
  byAgent: CostBucket[]
  byKind: CostBucket[]
  /**
   * ★ 有多少条记录的用量是缺失的。
   *
   * 这个数字必须显式报出来。否则"总成本"看起来是一个确切的值，
   * 实际上可能有一半的 run 根本没上报用量——把缺失当零会让成本可见性
   * 变成成本误导。
   */
  runsWithoutUsage: number
}

/**
 * 汇总成本。
 *
 * 成本以**整数微美元**累加（design §11.3）：浮点累加会在几百次之后漂移，
 * 而成本数字一旦对不上账，整个"成本可视"就没有可信度了。
 */
export function aggregateCost(
  runs: ReadonlyArray<{
    agentId: string
    kind: string
    usage: TokenUsage | null
  }>,
): CostReport {
  const byAgent = new Map<string, CostBucket>()
  const byKind = new Map<string, CostBucket>()
  const total: CostBucket = emptyBucket('全部')
  let runsWithoutUsage = 0

  for (const run of runs) {
    if (!run.usage) {
      runsWithoutUsage += 1
      total.runs += 1
      bump(byAgent, run.agentId, null)
      bump(byKind, run.kind, null)
      continue
    }
    add(total, run.usage)
    bump(byAgent, run.agentId, run.usage)
    bump(byKind, run.kind, run.usage)
  }

  const sortDesc = (m: Map<string, CostBucket>): CostBucket[] =>
    [...m.values()].sort((a, b) => b.costUsdMicros - a.costUsdMicros)

  return { total, byAgent: sortDesc(byAgent), byKind: sortDesc(byKind), runsWithoutUsage }
}

function emptyBucket(key: string): CostBucket {
  return { key, runs: 0, inputTokens: 0, outputTokens: 0, costUsdMicros: 0, estimatedRuns: 0 }
}

function add(bucket: CostBucket, usage: TokenUsage): void {
  bucket.runs += 1
  bucket.inputTokens += usage.inputTokens
  bucket.outputTokens += usage.outputTokens
  bucket.costUsdMicros += usage.costUsdMicros
  if (usage.costSource === 'estimated') bucket.estimatedRuns += 1
}

function bump(map: Map<string, CostBucket>, key: string, usage: TokenUsage | null): void {
  const bucket = map.get(key) ?? emptyBucket(key)
  if (usage) add(bucket, usage)
  else bucket.runs += 1
  map.set(key, bucket)
}
