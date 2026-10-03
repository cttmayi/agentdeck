/**
 * 时间的统一显示（2026-11 抽进 `@agentdeck/ui`）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么是工厂 + 文案函数，而不是一个带 i18n 依赖的模块
 * ══════════════════════════════════════════════════════════════════
 *
 * 两个前端（daemon / 远端管理页）的**逻辑**是同一个：相对时间只做到"天"、再久
 * 直接给日期；完整时间戳到秒。但"刚刚 / 5 分钟前"这类文案属于各自的文案表
 * （webText / remoteText **有意分开**），所以工厂接四个**文案函数**（调用那一刻
 * 取当前语言——语言切换后重渲染拿到的就是新文案），逻辑只有一处。
 *
 * 统一输入：`number`（时间戳）或 ISO 字符串都收；`null` 如实显示 `—`。
 */
export interface TimeText {
  justNow: () => string
  minutesAgo: (count: number) => string
  hoursAgo: (count: number) => string
  daysAgo: (count: number) => string
}

function toTs(at: number | string | null): number | null {
  if (at === null || at === '') return null
  const n = typeof at === 'number' ? at : Date.parse(at)
  return Number.isFinite(n) ? n : null
}

export function createTimeKit(text: TimeText) {
  return {
    /**
     * 相对时间。只做到"天"，再久就直接说日期——"37 天前"没人算得出来是什么时候。
     * `null` / 解析不了的值 ⇒ `—`（"未记录"要如实说，不拿空字符串糊过去）。
     */
    relativeTime(at: number | string | null, now: number): string {
      const ts = toTs(at)
      if (ts === null) return '—'
      const diff = Math.max(0, now - ts)
      const minutes = Math.floor(diff / 60_000)
      if (minutes < 1) return text.justNow()
      if (minutes < 60) return text.minutesAgo(minutes)
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return text.hoursAgo(hours)
      const days = Math.floor(hours / 24)
      if (days < 30) return text.daysAgo(days)
      const d = new Date(ts)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    },

    /**
     * 完整时间戳（本地时区，到秒）——列表里那一格的 `title`。
     * 不传 `locale` 时用环境默认（daemon 界面一直如此）；远端管理页传自己
     * 的当前语言（`zh-CN` / `en-US`），跟随页面语言切换。
     */
    absoluteTime(at: number | string | null, locale?: string): string {
      const ts = toTs(at)
      if (ts === null) return '—'
      const d = new Date(ts)
      return locale ? d.toLocaleString(locale) : d.toLocaleString()
    },
  }
}
