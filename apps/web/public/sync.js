/**
 * 页面作为远端通道的同步逻辑（FR-REG-06/07/11/12/18、FR-RUNTIME-13、FR-AUTH-08/10）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么同步逻辑必须在**页面**里
 * ══════════════════════════════════════════════════════════════════
 *
 * 因为 daemon **不向任何远端发起请求**（D20 / FR-RUNTIME-01）。这不是实现
 * 偷懒，是架构选择：daemon 是本机服务，它一旦开始外联，就多出一整类
 * "谁能通过远端影响本机执行"的攻击面。
 *
 * 所以页面是唯一的通道：它既连着本机 daemon（同源），又连着远端（跨源）。
 * 两条腿都在它身上，它就还得负责一件容易被忽略的事——**两边的可用性无关**：
 * 远端挂了，本机功能必须照常可用（FR-AUTH-06）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 三条设计取舍
 * ══════════════════════════════════════════════════════════════════
 *
 * **① 上报失败要本地暂存并补交**（FR-RUNTIME-13 / FR-REG-18）。
 *    远端不可达时把记录压进 localStorage 队列，下一轮一起补。不这么做的话，
 *    "远端抖了一下"就等于**那段时间的记录永久丢失**——而记录恰恰是审计的素材。
 *
 * **② 上报失败绝不影响本机执行**（FR-REG-18）。
 *    整个同步循环里没有任何一步会 await 到阻塞本机操作；失败只变成页面上的
 *    一行状态。这一条很容易被写坏：一个 `await` 放错位置，远端慢就会让
 *    页面变卡。
 *
 * **③ 上报可关闭，关了之后本机功能完整可用**（FR-REG-16）。
 *    关掉只是跳过上报那一段，待处理项轮询与本地功能都不受影响。
 */

import { getRemoteUrl, isLoggedIn, remote } from './remote.js'

const QUEUE_KEY = 'alpha-helper.report-queue'
/** 队列上限。攒太多会把 localStorage 撑爆，而撑爆的后果是**队列整个丢失**。 */
const QUEUE_LIMIT = 500

/** 默认轮询间隔（FR-AUTH-10：设定至少覆盖轮询间隔与上报开关）。 */
export const DEFAULT_POLL_INTERVAL_MS = 60_000
/** 允许的范围。太短会把远端打爆，太长则"待处理项"失去意义。 */
export const MIN_POLL_INTERVAL_MS = 10_000
export const MAX_POLL_INTERVAL_MS = 60 * 60 * 1000

export const DEFAULT_SETTINGS = {
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  /** 上报默认**开**，但页面必须明示上报什么、去哪、以及不具证据效力。 */
  reportingEnabled: true,
  /** 上报给项目方的部分尽量聚合、去内容化（FR-REG-14）。 */
  aggregateOnly: true,
}

/**
 * 从远端设定里取出同步相关配置。
 *
 * 对非法值**取默认值而不是抛错**：设定是远端来的，一个坏值不该让页面
 * 起不来。但要把范围夹住——`pollIntervalMs: 1` 会让页面把远端打爆。
 */
export function readSyncSettings(settings) {
  // ⚠️ 这里**不能**直接 `Number(settings?.pollIntervalMs)`：
  //    `Number(null) === 0`，于是"没设过"会被当成 0，再被夹到下限 10 秒
  //    ——**轮询频率悄悄变成默认值的 6 倍**。这是个很小的 JS 陷阱，
  //    后果却是"远端被莫名其妙地多打 6 倍的请求"。
  //    所以"没给"与"给了个 0"必须显式分开。
  const raw = settings?.pollIntervalMs
  const poll = raw === null || raw === undefined || raw === '' ? NaN : Number(raw)
  const pollIntervalMs = Number.isFinite(poll)
    ? Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, Math.trunc(poll)))
    : DEFAULT_POLL_INTERVAL_MS

  return {
    pollIntervalMs,
    // 只有显式 false 才关闭——缺省是开
    reportingEnabled: settings?.reportingEnabled !== false,
    aggregateOnly: settings?.aggregateOnly !== false,
  }
}

// ─────────────────────────────────────────────────────────────
// 上报队列（FR-RUNTIME-13）
// ─────────────────────────────────────────────────────────────

export function readQueue() {
  try {
    const raw = localStorage.getItem(QUEUE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    // 队列坏了就丢掉重建——它只是待补交的副本，不是权威数据。
    // 权威数据在 daemon 里，这也是"丢了也不致命"的原因。
    return []
  }
}

export function enqueue(records) {
  const queue = [...readQueue(), ...records]
  // 超出上限时丢**最旧**的：新记录更可能被用到
  const trimmed = queue.slice(-QUEUE_LIMIT)
  localStorage.setItem(QUEUE_KEY, JSON.stringify(trimmed))
  return trimmed.length
}

export function clearQueue() {
  localStorage.removeItem(QUEUE_KEY)
}

// ─────────────────────────────────────────────────────────────
// 记录收集
// ─────────────────────────────────────────────────────────────

/**
 * 把本机数据整理成远端要的两类内容（FR-REG-12）：
 * ① 用量与错误**统计**；② 工作记录**副本**（摘要）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这里刻意**只取摘要**
 * ══════════════════════════════════════════════════════════════════
 *
 * FR-REG-14 要求"给项目方的部分应尽量聚合、去内容化"。最容易违反它的做法
 * 是"反正都取了，顺手把 prompt 也带上"——而 prompt 里可能有使用者的
 * 代码、密钥、业务信息。
 *
 * 所以这里**结构上拿不到正文**：只取 id、状态、成本、结论这类字段。
 * 想带正文得先改这个函数，而那时这条注释就在旁边。
 */
export function collectRecords(issues, runs) {
  const records = []

  for (const run of runs) {
    records.push({
      kind: 'run',
      // 只发摘要的 sha256 作为去重/校验标识，**不发正文**
      digest: shortDigest(`${run.runId}:${run.status}`),
      conclusion: run.status,
      occurredAt: new Date(run.queuedAt ?? Date.now()).toISOString(),
    })
  }

  for (const issue of issues) {
    records.push({
      kind: 'action',
      digest: shortDigest(`${issue.id}:${issue.status}`),
      actionType: `issue.${issue.status}`,
      occurredAt: new Date(issue.updatedAt ?? Date.now()).toISOString(),
    })
  }

  return records
}

/** 一个不含原文的短摘要。远端拿它去重，拿不到内容。 */
function shortDigest(text) {
  // 不是为了密码学安全，只是要一个稳定的短标识；同步 API 即可
  let h = 5381
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0
  return `djb2:${h.toString(16)}`
}

// ─────────────────────────────────────────────────────────────
// 一次同步
// ─────────────────────────────────────────────────────────────

export async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  })
  const text = await res.text()
  const body = text ? JSON.parse(text) : null
  if (!res.ok) throw new Error(body?.error ?? `${res.status} ${res.statusText}`)
  return body
}

/**
 * 跑一轮同步。
 *
 * ★ 顺序是**先补交队列，再拉待处理项**：
 *   补交是"把已经发生的事送出去"，拉取是"取新的活"。反过来的话，
 *   远端不可达的每一轮都会先失败一次，队列永远补不上。
 *
 * 返回一份可以显示给人看的状态——**不抛异常**。同步失败不该让页面崩，
 * 也不该阻塞本机的任何操作（FR-REG-18）。
 */
export async function runSyncCycle(options = {}) {
  const status = {
    at: Date.now(),
    reported: 0,
    queued: readQueue().length,
    fetched: 0,
    warnings: [],
    error: null,
    skippedReporting: false,
  }

  if (!isLoggedIn()) {
    status.error = '未登录远端，暂不同步'
    return status
  }

  const settings = readSyncSettings(options.settings)

  // ── ① 补交 + 上报 ──
  if (settings.reportingEnabled) {
    try {
      const queued = readQueue()
      const fresh = options.records ?? []
      const payload = [...queued, ...fresh]
      if (payload.length > 0) {
        await remote.ingestRecords(payload)
        clearQueue()
        status.reported = payload.length
        status.queued = 0
      }
    } catch (err) {
      // ★ 失败就暂存（FR-RUNTIME-13 / FR-REG-18）。
      //   不暂存的话，"远端抖了一下"等于那段时间的记录**永久丢失**。
      const queuedNow = enqueue(options.records ?? [])
      status.queued = queuedNow
      status.error = `上报失败（已本地暂存 ${queuedNow} 条，下轮补交）：${err.message}`
    }
  } else {
    status.skippedReporting = true
  }

  // ── ② 拉待处理项（FR-REG-06/07）──
  try {
    const pending = await remote.pending()
    status.warnings = pending?.warnings ?? []

    if (Array.isArray(pending?.items) && pending.items.length > 0) {
      // ★ 交给本机 daemon（同源）。远端**没有**执行能力，也不该有——
      //   它只负责把外部的东西取回来。
      const accepted = await api('/api/reports', {
        method: 'POST',
        body: JSON.stringify({ source: 'third-party', items: pending.items }),
      })
      status.fetched = pending.items.length
      status.accepted = accepted?.runIds?.length ?? 0
    }
  } catch (err) {
    // 拉取失败不覆盖上报的状态——两件事的失败原因不同，混成一条会误导
    status.error = status.error ? `${status.error}；拉取待处理项失败：${err.message}` : `拉取待处理项失败：${err.message}`
  }

  return status
}

/**
 * 起一个轮询循环。
 *
 * 用 `setTimeout` **递归**而不是 `setInterval`：间隔是"上一轮结束到下一轮
 * 开始"，而不是"固定节拍"。用 `setInterval` 的话，一轮慢于间隔时请求会
 * **越积越多**——远端越慢，压力越大，最坏情况下雪崩。
 */
export function startSyncLoop(options) {
  let timer = null
  let stopped = false

  const tick = async () => {
    if (stopped) return
    try {
      const status = await runSyncCycle(options)
      options.onStatus?.(status)
    } catch (err) {
      // runSyncCycle 本身不该抛，这里是最后一道兜底：轮询循环**绝不能死**，
      // 死了就再也不会恢复，而使用者看不到任何异常
      options.onStatus?.({ at: Date.now(), error: String(err) })
    }
    if (stopped) return
    const settings = readSyncSettings(options.getSettings?.())
    timer = setTimeout(() => void tick(), settings.pollIntervalMs)
  }

  void tick()

  return {
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}
