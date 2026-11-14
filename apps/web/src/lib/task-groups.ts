/**
 * 任务列表**分组**（2026-11，使用者立项，demo v3 拍板）。
 *
 * 同一来源（定时任务触发）的任务一组，手动创建（无 `source`）一组。
 *
 * 规则（拍板定稿，探针与单测一起钉住）：
 * · 组间按「组内最新任务时间」倒排——**手动创建组也参与**（不固定压底），
 *   哪组最近有产出哪组靠前；
 * · 组内保持传入顺序（调用方已按时间倒序排好——分组**不重排**行）；
 * · 老数据（`source` 缺失 = undefined）与 `source: null` 一样归「手动创建」，
 *   不猜、不误归。
 *
 * 纯函数是为了单测可及：探针量界面交互，这条分组/排序逻辑在这里钉死。
 */
import type { Issue } from '../lib/api.ts'

export interface TaskGroup<I> {
  /** 'manual' 或 scheduleId。 */
  key: string
  /** 组头显示的名字（手动组由调用方给词条翻译名）。 */
  name: string
  /** 完整元素（如 `{ issue, info }`）——组内保持传入顺序，不重排。 */
  items: I[]
  /** 组内最新任务的创建时间（组间排序用）。 */
  latest: number
}

/** 手动组（无来源任务）的 key——不能与任何 scheduleId 冲突的保留字。 */
export const MANUAL_GROUP_KEY = 'manual'

export function groupTasks<I extends { issue: Pick<Issue, 'source' | 'createdAt'> }>(
  staged: ReadonlyArray<I>,
  manualName: string,
): TaskGroup<I>[] {
  const byKey = new Map<string, TaskGroup<I>>()
  for (const item of staged) {
    const src = item.issue.source
    // ⚠️ `src &&` 而不是 `src?.`：TS 对 `src?.kind === 'schedule'` 不窄化
    //    （老数据 `source` 缺失 = undefined，`src?.scheduleId` 是 string|undefined）
    const key = src && src.kind === 'schedule' ? src.scheduleId : MANUAL_GROUP_KEY
    const name = src && src.kind === 'schedule' ? src.scheduleName : manualName
    const g = byKey.get(key)
    if (g) {
      g.items.push(item)
      g.latest = Math.max(g.latest, item.issue.createdAt)
    } else {
      byKey.set(key, { key, name, items: [item], latest: item.issue.createdAt })
    }
  }
  return [...byKey.values()].sort((a, b) =>
    a.latest < b.latest ? 1 : a.latest > b.latest ? -1 : 0,
  )
}
