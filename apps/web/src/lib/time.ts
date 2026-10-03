import { createTimeKit } from '@agentdeck/ui'
import { tx } from './i18n.ts'

/**
 * 时间的统一显示（2026-11：逻辑抽进 `@agentdeck/ui` 的 `createTimeKit`，
 * 这一端只注入自己的文案函数——`common.*` 属于 webText）。
 *
 * 约定（不变）：**列表一律用相对时间**（"刚刚 / 5 分钟前 / 3 天前"——扫列表时
 * 一眼就有量级），**准确时间放 `title`**（要精确到分秒时悬停即可）。超过 30 天
 * 直接给日期："37 天前"没人算得出来是哪天。
 *
 * ⚠️ 文案函数**调用那一刻**取当前语言（`tx` 命令式）：语言切换后重渲染拿到的
 *    就是新文案——不能把字符串在模块加载时取一次（那样切语言不会变）。
 */
export const { relativeTime, absoluteTime } = createTimeKit({
  justNow: () => tx('common.justNow'),
  minutesAgo: (count) => tx('common.minutesAgo', { count }),
  hoursAgo: (count) => tx('common.hoursAgo', { count }),
  daysAgo: (count) => tx('common.daysAgo', { count }),
})
