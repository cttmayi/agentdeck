/**
 * 沉淀页「结论条」那一格的判定：审核**在跑 / 收尾了没判决 / 没跑成 / 有判决**。
 *
 * ## 为什么把它单独拎出来
 *
 * 这段判定原来是三四个 `$:` 响应式语句，直接写在 `CrystallizeView.svelte` 里 ⇒ **测不了**
 * （`svelte-check` 只看类型，`node:test` 又加载不了组件）。结果是它错了一次没人发现：
 *
 * 使用者点「反馈」→ 平台自动起新一版审核 → 那一刻还没有判决，但界面上报的是
 * **「审核跑完了，但没有留下可用的判决……这一步等于白跑」**。真实原因是"实时状态"里还留着
 * **上一版审核的终态** `completed`（事件流报过就缓存着，只在手动点「开始审核」那条路上清空，
 * 而反馈不经过它）。判断"在跑还是在收尾"的规则住在组件里 ⇒ 只能靠人眼看出来。
 *
 * 拎出来之后，这条规则就有了名字、有了单测：`audit-bar.test.ts` 里钉着"上一版的终态不认"。
 *
 * ## 口径
 *
 * - 实时状态**只认属于当前这条审核 run 的那份**（`live.runId === reviewRunId`）。
 *   对不上就一律不采信——这比"记得在每条改版路径上清空缓存"结实：忘了清也错不了。
 * - 判决**有**就一切以判决为准（`tone: 'verdict'`），不去猜 run 的状态。
 * - `reviewRunId === null` ⇒ 这条草稿**从没审过**（`tone: 'not-yet'`），不能说成"没跑成"。
 */

/** 这些状态算"还在跑"。与 run 状态机一致：终态之外的一切都还在路上。 */
export const AUDIT_ACTIVE_STATUSES: readonly string[] = [
  'queued',
  'deferred',
  'waiting_local_directory',
  'dispatched',
  'running',
]

export interface AuditLive {
  runId: string
  status: string
}

export interface AuditBarInput {
  /** 事件流报来的状态（可能属于**上一条** run —— 这份数据不保证新鲜）。 */
  live: AuditLive | null
  /** 接口快照：这条草稿对应的审核 run（`null` = 从没审过）。 */
  reviewRunId: string | null
  /** 接口快照：那条 run 的状态。 */
  reviewRunStatus: string | null
  /** 判决落库了没有。 */
  hasVerdict: boolean
}

export type AuditBarTone = 'not-yet' | 'verdict' | 'running' | 'no-verdict' | 'run-failed'

export interface AuditBar {
  /** 徽标上显示的状态（实时优先，且**只认当前这条 run**）。 */
  status: string | null
  running: boolean
  /** 收尾了但没判决（"还在跑"与"跑完了"必须分开说）。 */
  settled: boolean
  /** 收尾且状态是 `completed`，可是判决没落库 ⇒ 审核这一步白跑了。 */
  noVerdict: boolean
  tone: AuditBarTone
}

export function resolveAuditBar(input: AuditBarInput): AuditBar {
  const { live, reviewRunId, reviewRunStatus, hasVerdict } = input
  // 实时状态只有"属于这条 run"时才采信。上一版审核的 `completed` 落在新一版头上，
  // 就会把"刚起"说成"白跑"——使用者报的就是这一条。
  const liveStatus =
    live !== null && reviewRunId !== null && live.runId === reviewRunId ? live.status : null
  const status = liveStatus ?? (reviewRunId === null ? null : reviewRunStatus)

  if (reviewRunId === null) {
    return { status: null, running: false, settled: false, noVerdict: false, tone: 'not-yet' }
  }
  if (hasVerdict) {
    return { status, running: false, settled: false, noVerdict: false, tone: 'verdict' }
  }
  const running = AUDIT_ACTIVE_STATUSES.includes(status ?? '')
  if (running) return { status, running: true, settled: false, noVerdict: false, tone: 'running' }
  const noVerdict = status === 'completed'
  return {
    status,
    running: false,
    settled: true,
    noVerdict,
    tone: noVerdict ? 'no-verdict' : 'run-failed',
  }
}
