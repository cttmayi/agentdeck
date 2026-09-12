import { writable } from 'svelte/store'

/**
 * 视图路由。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么用 hash 而不是内存状态或 History API
 * ══════════════════════════════════════════════════════════════════
 *
 * - **内存状态**：刷新就回到默认视图。使用者点了"智能体"、刷新一下又跳回
 *   "新建任务"，每次都要重新点——很烦，而且没法把某个视图的链接给别人。
 * - **History API**：需要服务端对任意路径都返回 index.html。而 daemon 那边
 *   的静态服务是**白名单**式的（只发列出来的文件），要支持它就得放宽成
 *   "认不出来的都发 index.html"——那会让 404 消失，把"资源不存在"变成
 *   "看到一个空白页"，排查起来更糟。
 * - **hash**：不需要服务端配合，刷新保留，能分享链接。代价是 URL 里有个
 *   `#`，在这个场景下无所谓。
 */

export const VIEWS = ['new', 'tasks', 'agents', 'skills'] as const
export type ViewName = (typeof VIEWS)[number]

function fromHash(): ViewName {
  const raw = location.hash.replace(/^#\/?/, '')
  return (VIEWS as readonly string[]).includes(raw) ? (raw as ViewName) : 'new'
}

export const view = writable<ViewName>(fromHash())

// 浏览器前进/后退要跟着走——否则后退键看起来"没反应"
window.addEventListener('hashchange', () => view.set(fromHash()))

export function go(next: ViewName): void {
  location.hash = `#/${next}`
  view.set(next)
}

/** 任务详情里选中的任务；null = 显示列表/看板。 */
export const selectedIssueId = writable<string | null>(null)

/** 抽屉。同时只开一个——两个叠在一起是纯粹的视觉噪音。 */
export const openDrawer = writable<'inbox' | 'settings' | null>(null)

/** 一闪而过的提示（操作成功/失败的一句话反馈）。 */
export const toast = writable<string | null>(null)

let toastTimer: ReturnType<typeof setTimeout> | null = null
export function showToast(message: string): void {
  toast.set(message)
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toast.set(null), 4000)
}
