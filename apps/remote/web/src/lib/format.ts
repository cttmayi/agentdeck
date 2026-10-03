import { createTimeKit } from '@agentdeck/ui'
import { tx } from './locale.ts'

/**
 * 时间的统一显示（2026-11：与 daemon 界面共用 `@agentdeck/ui` 的 `createTimeKit`，
 * 这一端注入自己的 `remote.*` 文案）。
 *
 * ★ 一律显示**本地时间**、并在缺值时如实说"未记录"（`—`）——远端目录里那些
 *   时间（`fetchedAt` / `syncedAt`）是排查"这份内容是什么时候抓的"的唯一依据，
 *   拿 `Invalid Date` 或空字符串糊过去，等于把这条线索抹掉。
 *
 * ⚠️ 文案函数调用那一刻取当前语言（`tx` 命令式）：语言切换后重渲染拿到新文案。
 */
export const { relativeTime, absoluteTime } = createTimeKit({
  justNow: () => tx('remote.justNow'),
  minutesAgo: (count) => tx('remote.minutesAgo', { count }),
  hoursAgo: (count) => tx('remote.hoursAgo', { count }),
  daysAgo: (count) => tx('remote.daysAgo', { count }),
})
