import { renderText, webText } from '@alpha-helper/i18n'
import { isLoggedIn, remote } from './remote.ts'
import { api } from './api.ts'
import { currentLocale } from './locale.ts'

/**
 * 页面作为远端通道的同步逻辑。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么同步逻辑必须在**页面**里
 * ══════════════════════════════════════════════════════════════════
 *
 * daemon **不向 alpha-helper 的远端服务**发起请求（D20）。这不是偷懒，是架构选择：
 * 它一旦开始外联，就多出一整类"谁能通过远端影响本机执行"的攻击面。
 * 所以页面是唯一的通道——两条腿都在它身上，它还得负责一件容易忽略的事：
 * **两边的可用性无关**。远端挂了，本机功能必须照常可用（FR-AUTH-06）。
 */

const QUEUE_KEY = 'alpha-helper.report-queue'
const QUEUE_LIMIT = 500

export const DEFAULT_POLL_INTERVAL_MS = 60_000
export const MIN_POLL_INTERVAL_MS = 10_000
export const MAX_POLL_INTERVAL_MS = 60 * 60 * 1000

export interface SyncSettings {
  pollIntervalMs: number
  reportingEnabled: boolean
  aggregateOnly: boolean
}

export function readSyncSettings(settings: unknown): SyncSettings {
  // ⚠️ 不能直接 Number(...)：Number(null) === 0，于是"没设过"会被夹到下限
  //    10 秒——轮询频率悄悄变成默认值的 6 倍。这里显式区分"没给"与"给了 0"。
  const raw = (settings as { pollIntervalMs?: unknown } | null)?.pollIntervalMs
  const poll = raw === null || raw === undefined || raw === '' ? NaN : Number(raw)
  const pollIntervalMs = Number.isFinite(poll)
    ? Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, Math.trunc(poll)))
    : DEFAULT_POLL_INTERVAL_MS

  const s = settings as { reportingEnabled?: unknown; aggregateOnly?: unknown } | null
  return {
    pollIntervalMs,
    reportingEnabled: s?.reportingEnabled !== false,
    aggregateOnly: s?.aggregateOnly !== false,
  }
}

export function readQueue(): unknown[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    // 队列坏了就丢掉重建——它只是待补交的副本，权威数据在 daemon 里
    return []
  }
}

export function enqueue(records: unknown[]): number {
  const queue = [...readQueue(), ...records]
  const trimmed = queue.slice(-QUEUE_LIMIT)
  localStorage.setItem(QUEUE_KEY, JSON.stringify(trimmed))
  return trimmed.length
}

export function clearQueue(): void {
  localStorage.removeItem(QUEUE_KEY)
}

/**
 * 把本机数据整理成远端要的摘要。
 *
 * ★ **结构上拿不到正文**：只取 id、状态、时间。FR-REG-14 要求给项目方的
 *   部分尽量聚合、去内容化，而最容易违反它的做法是"反正都取了，顺手把
 *   prompt 也带上"——prompt 里可能有使用者的代码、密钥、业务信息。
 */
export function collectRecords(
  issues: Array<{ id: string; status: string; updatedAt?: number }>,
  runs: Array<{ runId: string; status: string; queuedAt?: number }>,
): Array<Record<string, unknown>> {
  const digest = (text: string): string => {
    let h = 5381
    for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0
    return `djb2:${h.toString(16)}`
  }
  return [
    ...runs.map((r) => ({
      kind: 'run',
      digest: digest(`${r.runId}:${r.status}`),
      conclusion: r.status,
      occurredAt: new Date(r.queuedAt ?? Date.now()).toISOString(),
    })),
    ...issues.map((i) => ({
      kind: 'action',
      digest: digest(`${i.id}:${i.status}`),
      actionType: `issue.${i.status}`,
      occurredAt: new Date(i.updatedAt ?? Date.now()).toISOString(),
    })),
  ]
}

export interface SyncStatus {
  at: number
  reported: number
  queued: number
  fetched: number
  accepted: number
  warnings: Array<{ plugin: string; reason: string }>
  error: string | null
  skippedReporting: boolean
}

/**
 * 跑一轮同步。
 *
 * ★ 顺序是**先补交队列，再拉待处理项**：补交是"把已经发生的事送出去"，
 *   拉取是"取新的活"。反过来则会在远端不可达的每一轮都先失败一次，
 *   队列永远补不上。
 *
 * 返回状态而**不抛异常**：同步失败不该让页面崩，也不该阻塞本机操作。
 */
export async function runSyncCycle(options: {
  settings?: unknown
  records?: unknown[]
}): Promise<SyncStatus> {
  const status: SyncStatus = {
    at: Date.now(),
    reported: 0,
    queued: readQueue().length,
    fetched: 0,
    accepted: 0,
    warnings: [],
    error: null,
    skippedReporting: false,
  }

  if (!isLoggedIn()) {
    status.error = null
    return status
  }

  const settings = readSyncSettings(options.settings)

  if (settings.reportingEnabled) {
    try {
      const payload = [...readQueue(), ...(options.records ?? [])]
      if (payload.length > 0) {
        await remote.ingestRecords(payload)
        clearQueue()
        status.reported = payload.length
        status.queued = 0
      }
    } catch (err) {
      // ★ 失败就暂存：不暂存的话，"远端抖了一下"等于那段时间的记录永久丢失
      status.queued = enqueue(options.records ?? [])
      // 这句会显示在设置抽屉与侧栏（`syncStatus.error`），所以要跟着界面语言走
      status.error = renderText(webText, 'err.reportFailed', currentLocale(), {
        count: status.queued,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  } else {
    status.skippedReporting = true
  }

  try {
    const pending = await remote.pending()
    status.warnings = pending?.warnings ?? []
    if (Array.isArray(pending?.items) && pending.items.length > 0) {
      // 交给本机 daemon（同源）。远端没有执行能力，也不该有。
      const accepted = await api<{ runIds?: string[] }>('/api/reports', {
        method: 'POST',
        body: JSON.stringify({ source: 'third-party', items: pending.items }),
      })
      status.fetched = pending.items.length
      status.accepted = accepted?.runIds?.length ?? 0
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const loc = currentLocale()
    const fetched = renderText(webText, 'err.fetchPendingFailed', loc, { reason: message })
    // 一轮里两条都失败时要拼成一句给使用者看；分隔符（全角分号 vs "; "）也是
    // 文案的一部分，所以它同样从词表里取，不写死在代码里。
    status.error = status.error
      ? `${status.error}${renderText(webText, 'err.messageSeparator', loc)}${fetched}`
      : fetched
  }

  return status
}

/**
 * 起一个轮询循环。
 *
 * 用 `setTimeout` **递归**而不是 `setInterval`：间隔是"上一轮结束到下一轮
 * 开始"。用 setInterval 的话，一轮慢于间隔时请求会越积越多——远端越慢
 * 压力越大，最坏情况雪崩。
 */
export function startSyncLoop(options: {
  getSettings: () => unknown
  getRecords?: () => unknown[]
  onStatus: (s: SyncStatus) => void
}): { stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const tick = async (): Promise<void> => {
    if (stopped) return
    try {
      options.onStatus(
        await runSyncCycle({
          settings: options.getSettings(),
          records: options.getRecords?.() ?? [],
        }),
      )
    } catch (err) {
      // 兜底：轮询循环**绝不能死**，死了就再也不会恢复，而使用者看不到异常
      options.onStatus({
        at: Date.now(),
        reported: 0,
        queued: 0,
        fetched: 0,
        accepted: 0,
        warnings: [],
        error: String(err),
        skippedReporting: false,
      })
    }
    if (stopped) return
    timer = setTimeout(() => void tick(), readSyncSettings(options.getSettings()).pollIntervalMs)
  }

  void tick()

  return {
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}
