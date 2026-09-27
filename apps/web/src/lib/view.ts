import { writable } from 'svelte/store'
import type { WebTextId } from '@agentdeck/i18n'

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
 *
 * ⚠️ 加一个视图要动**两处**：这里的 `VIEWS` 与 `Sidebar.svelte` 的 `ITEMS`。
 *    少动一处不会报错——只表现为"那个视图打不开 / 侧边栏点不到它"，
 *    所以探针里有一条量"侧边栏恰好五项、最后一项是工具"。
 */

/**
 * ★ 顺序 = 侧边栏顺序：聊天在最前。
 *
 * 它是最轻的入口——先聊清楚，再决定要不要派活。排在「新建任务」上面而不是
 * 塞进那一页当 tab：聊天要管**多个对话**，本身就是一个完整页面（左对话列表 /
 * 右消息流），和「任务」页是同一个形状。
 */
export const VIEWS = ['chat', 'new', 'tasks', 'agents', 'skills', 'tools'] as const
export type ViewName = (typeof VIEWS)[number]

/**
 * 顶栏左侧那个页名。
 *
 * ★ 复用**侧栏的词条**，不另立一套：同一个页面在导航里叫什么、在顶栏上就该叫
 *   什么。各写一份的后果是"侧栏说『任务清单』、顶栏说『任务』"，而这种不一致
 *   没人会去查——两处都对，只是不是一件事。
 *
 * ⚠️ 这里的键必须与 `Sidebar.svelte` 的 `ITEMS` **逐条对上**（工具那一项的
 *    导航词条在 `tools.ts`，不在 `shell.ts`——见那边顶部的说明）。探针里有一条
 *    量的是"顶栏页名 == 侧栏那一项的文字"，对不上就会红。
 *
 * ⚠️ 映射是**穷尽**的（`satisfies Record<ViewName, TextKey>`）：加一个视图却忘了
 *    加页名是编译错误，不会变成"顶栏那一格空着"。
 */
export const VIEW_TITLE_KEYS = {
  chat: 'shell.navChat',
  new: 'shell.navNewTask',
  tasks: 'shell.navTasks',
  agents: 'shell.navAgents',
  skills: 'shell.navSkills',
  tools: 'tools.navTitle',
} as const satisfies Record<ViewName, WebTextId>

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

/**
 * 抽屉。同时只开一个——两个叠在一起是纯粹的视觉噪音。
 *
 * `'remote'` 与 `'settings'` 用的是同一个抽屉组件，只是**聚焦到远端那一段**：
 * 顶栏点「登录」时不该让人在成本、审计导出里翻找登录表单在哪。
 * 分成两个独立组件会在两处各写一遍表单，迟早不一致。
 */
export const openDrawer = writable<'inbox' | 'settings' | 'remote' | null>(null)

/**
 * 「新建任务」的预填草稿 —— 聊天页通往那一页的**唯一**一条路。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么是预填，而不是直接替使用者提交
 * ══════════════════════════════════════════════════════════════════
 *
 * 派活 = 决定"谁去干、谁来审、允许它做哪些动作"。这三样正是这个产品的核心判断，
 * 而聊天没有资格替使用者做：聊天里没有判决，也就没有依据说"这些动作可以放行"。
 * 所以桥的另一头是一个**填好的表单**，不是一个已经提交的任务。
 *
 * ⚠️ 用完必须清空（`NewTask.svelte` 取走之后就 `set(null)`）：留在这里的话，
 *    下次从侧边栏点「新建任务」会莫名其妙地又出现上次那段文字——而那一刻
 *    使用者心里想的是"新建一个空白任务"。
 */
export const newTaskDraft = writable<string | null>(null)

/** 一闪而过的提示（操作成功/失败的一句话反馈）。 */
export const toast = writable<string | null>(null)

let toastTimer: ReturnType<typeof setTimeout> | null = null
export function showToast(message: string): void {
  toast.set(message)
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toast.set(null), 4000)
}
