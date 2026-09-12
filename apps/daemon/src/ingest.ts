import { z } from 'zod'
import { createHash } from 'node:crypto'
import { routeReportToReviewers, type Store } from '@alpha-helper/domain'
import {
  ulid,
  type Agent,
  type InboxItem,
  type Report,
  type WorkspaceId,
} from '@alpha-helper/protocol'

/**
 * Report 摄取（FR-REPORT-01~05、D14）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 正确性在哪一层
 * ══════════════════════════════════════════════════════════════════
 *
 * 去重与增量（"上次查到哪"）**由第三方适配器自己负责**（D14）。平台侧
 * 只保证一件事：**`report` 去重键**。
 *
 * 这个分工是安全的，因为水位只是**效率优化**，不是正确性保证——
 * 即使适配器每次都把全部历史重新返回一遍，去重键也会把重复的挡在门外，
 * 不会产生第二次审核、第二次动作。
 *
 * 去重键 = `sha256(source + externalId + contentHash)`：
 *   - `externalId` 识别"同一条"
 *   - `contentHash` 防止同一 externalId **内容变了**之后被误去重
 *     （没有它，"这条报告更新了"会被永久忽略）
 */

/**
 * 外部报告条目。
 *
 * ══════════════════════════════════════════════════════════════════
 * 类型声明不是运行时校验 —— 这一点在这里踩过
 * ══════════════════════════════════════════════════════════════════
 *
 * 上面写着 `body: string`，但那**只在编译期成立**。HTTP 请求体是运行时
 * 来的任意 JSON，一个客户端（MCP 的 `submit_report`、命令行、curl、
 * 或者任何第三方）**省略 `body`** 就会让 `undefined` 一路走到
 * `createHash().update(undefined)`，抛出一个生硬的 Node TypeError，
 * 最终以 **HTTP 500 + 内部错误原文**的形式返回给人。
 *
 * 而 MCP 那边的工具 schema 恰恰把 `body` 标成可选的——也就是说，
 * 按文档写的调用**必然**触发它。
 *
 * 修法是在**边界上**校验：`body` 缺省给空串（只给标题的报告是合理的），
 * 其余必填字段缺失则明确报 400 并指出是第几条、哪个字段。
 * 一个能被合法调用触发的 500 是缺陷，不是"输入不合法"。
 */
export const ThirdPartyItemSchema = z.object({
  externalId: z.string().min(1),
  kind: z.string().min(1),
  title: z.string().min(1),
  /** 缺省空串：只给标题的报告是合法的，不该逼调用方造一个占位正文。 */
  body: z.string().default(''),
  meta: z.record(z.string(), z.unknown()).default({}),
})

export type ThirdPartyItem = z.infer<typeof ThirdPartyItemSchema>

export interface ReportIngestorDeps {
  store: Store
  now?: () => number
}

export interface RoutedReport {
  report: Report
  /** 匹配到的审核 agent（可能多个 ⇒ 并行审核）。 */
  reviewers: Agent[]
  usedFallback: boolean
  /** 既没有匹配也没有兜底 —— 调用方必须通知，不得静默丢弃。 */
  unmatched: boolean
}

export interface IngestSummary {
  total: number
  created: number
  deduplicated: number
  /** 新建的 report 及其路由结果。 */
  routed: RoutedReport[]
}

export function computeDedupKey(
  source: string,
  externalId: string,
  content: string,
): string {
  const contentHash = createHash('sha256').update(content, 'utf8').digest('hex')
  return createHash('sha256')
    .update(`${source}\u0000${externalId}\u0000${contentHash}`, 'utf8')
    .digest('hex')
}

export class ReportIngestor {
  readonly #store: Store
  readonly #now: () => number

  constructor(deps: ReportIngestorDeps) {
    this.#store = deps.store
    this.#now = deps.now ?? (() => Date.now())
  }

  /**
   * 摄取一批条目。
   *
   * 每条都先落盘再路由——顺序不能反：先路由后落盘的话，
   * 落盘失败会留下一个"已经起了 review run 但查不到来源"的孤儿。
   */
  async ingest(
    workspaceId: WorkspaceId,
    source: string,
    items: readonly ThirdPartyItem[],
  ): Promise<IngestSummary> {
    const now = this.#now()
    const agents = await this.#store.listAgents(workspaceId)

    let created = 0
    let deduplicated = 0
    const routed: RoutedReport[] = []

    for (const item of items) {
      const blobRef = await this.#store.putBlob(new TextEncoder().encode(item.body))
      const dedupKey = computeDedupKey(source, item.externalId, item.body)

      const report: Report = {
        id: ulid(now) as Report['id'],
        workspaceId,
        source,
        externalId: item.externalId,
        kind: item.kind,
        title: item.title,
        body: item.body,
        meta: item.meta ?? {},
        blobRef,
        dedupKey,
        ingestedAt: now,
      }

      // insertReport 返回 false = 去重键已存在。这不是错误，是**幂等**。
      const wasCreated = await this.#store.insertReport(report)
      if (!wasCreated) {
        deduplicated += 1
        continue
      }
      created += 1

      // kind 同时是路由键与审核标准选择键（D24）
      const routing = routeReportToReviewers(item.kind, agents)
      routed.push({ report, ...routing })
    }

    return { total: items.length, created, deduplicated, routed }
  }
}

/** 未知 kind 且没有兜底审核者时的通知（FR-AGENT-22：不得静默丢弃）。 */
export function unmatchedReportNotice(
  workspaceId: WorkspaceId,
  report: Report,
  now: number,
): InboxItem {
  return {
    id: ulid(now),
    workspaceId,
    type: 'report.unmatched',
    severity: 'attention',
    title: `没有 agent 认领这类报告：${report.kind}`,
    body:
      `收到一条类型为 ${report.kind} 的报告（来源 ${report.source}），` +
      `但没有任何 agent 声明认领它，也没有配置兜底审核者。\n\n` +
      `报告已保存，但没有起审核。请给某个 agent 加上 \`${report.kind}\` 的认领规则，` +
      `或指定一个兜底审核者。`,
    issueId: null,
    runId: null,
    read: false,
    createdAt: now,
  }
}
