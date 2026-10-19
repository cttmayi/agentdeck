import { writable } from 'svelte/store'
import type { WebTextId } from '@agentdeck/i18n'
import { CREATE_HASH, LEGACY_CRYSTALLIZE_RE, VIEWS, hashFor, parseHash, type ViewName } from './route.ts'

export { VIEWS }
export type { ViewName }

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
  // ⚠️ 这里**没有** `new`（2026-10 / D58）：建任务不再是独立一页，它是「任务」页
  //    右栏的一个状态 —— 顶栏那一格写着「任务」，右栏里的表单自己带一个标题。
  //    硬留一条 `new: 'shell.navNewTask'` 的后果是"页面有几个"有两份答案，
  //    而 `satisfies Record<ViewName, WebTextId>` 会因为多出一个键直接编译不过。
  tasks: 'shell.navTasks',
  agents: 'shell.navAgents',
  // ★ D70 第六项（与 `VIEWS` / `Sidebar` 同序）。
  groups: 'shell.navGroups',
  skills: 'shell.navSkills',
  tools: 'tools.navTitle',
  // ★ D80 三轮：沉淀是第七个视图（导航列工具之下），词条在 crystallize 的 i18n 里。
  crystallize: 'crystallize.navTitle',
} as const satisfies Record<ViewName, WebTextId>

/**
 * 当前路由 = **视图 + 「任务」页右栏是不是在新建 + 沉淀流程页开没开**。
 *
 * ⚠️ 三个 store 由 `syncRoute()` **一处**写（地址是唯一出处）：分头写的后果是
 *    "地址栏写着 /tasks/new 而右栏画着某条任务的详情"——两个都对，只是不是一件事，
 *    而且刷新一下才现形。
 */
export const view = writable<ViewName>(parseHash(location.hash).view)

/**
 * 「任务」页右栏此刻是不是**建任务**（而不是某条任务的详情）。
 *
 * ★ 它是**地址**的一部分（`#/tasks/new`）而不是组件里的开关：合并之前"建任务"
 *   是一个可以被书签、被别人发给你的地址，合并之后这个能力不能凭空消失。
 */
export const creating = writable<boolean>(parseHash(location.hash).creating)

/**
 * 沉淀页（`crystallize` 视图）此刻选中了哪条沉淀。
 *
 * ★ 与 `creating` 同构、同一个理由：它是**地址**（`#/crystallize/<runId>`）
 *   而不是组件里的开关——流程页是"切走还能回来、刷新还在、能分享链接"的一页。
 *   放组件里一卸载就丢，使用者反馈过"切到其他页面就回不来了"。
 */
export const crystallize = writable<{ runId: string } | null>(parseHash(location.hash).crystallize)

/** 读地址 → 写三个 store。地址是唯一出处，三个 store 只是它的三个投影。 */
function syncRoute(): void {
  // 旧子路由重定向（D80 三轮）：`#/chat/crystallize/<runId>` 与 `#/tasks/crystallize/<runId>`
  // 解析成沉淀视图的同一状态，但地址本身要写回正规形态——地址是唯一出处，不能让
  // "两个地址同时活着"（迟早有人在别处贴旧链接，而刷新后它又跳回旧样子）。
  // `location.replace` 只换当前这一格（不污染后退栈），且会再触发一次 hashchange
  // → syncRoute 读到的是**正规**地址，重定向只发生一次，不会死循环。
  const legacy = LEGACY_CRYSTALLIZE_RE.exec(location.hash.replace(/^#\/?/, ''))
  if (legacy) {
    location.replace(`#/crystallize/${legacy[2]!}`)
  }
  const route = parseHash(location.hash)
  view.set(route.view)
  creating.set(route.creating)
  crystallize.set(route.crystallize)
}

// 浏览器前进/后退要跟着走——否则后退键看起来"没反应"
window.addEventListener('hashchange', syncRoute)

export function go(next: ViewName): void {
  location.hash = hashFor(next)
  // ⚠️ 不等 `hashchange`（它晚一拍）：提交成功之后是"切回任务页并选中新任务"，
  //    晚那一拍会先画一帧"还在建任务的表单"，然后才跳走。
  syncRoute()
}

/**
 * 进「建任务」那一栏（`#/tasks/new`）。
 *
 * ⚠️ 与 `go('tasks')` 是**两个不同的动作**，不能合成一个带参数的 `go`：
 *    这里的语义是"把右栏切成表单"，而 `go('tasks')` 是"回任务页"（右栏回到
 *    列表或详情）。合成一个之后，调用点就得自己记住传哪个参数，而传错的表现
 *    只是"右栏画的东西不对"。
 */
export function goCreate(): void {
  location.hash = CREATE_HASH
  syncRoute()
}

/**
 * 进沉淀页并选中一条（`#/crystallize/<runId>`）。
 *
 * ★ 与 `goCreate()` 同构：选中是"沉淀页右栏的一个位置"，地址读起来也是那样
 *   （`crystallize/<runId>`——视图自己就是沉淀，来源已在列表里，不用再写一层）。
 *   取消选中 = `go('crystallize')`（回列表空态），不必另开一个函数。
 *
 * ⚠️ D80 二轮的旧签名是 `goCrystallize('chat'|'tasks', runId)`——流程页当时住在
 *   聊天/任务右栏。三轮把它挪成独立视图，入口只剩"沉淀页 + runId"；旧地址
 *   （`#/chat/crystallize/<runId>`）由 `syncRoute` 重定向，链接不作废。
 */
export function goCrystallize(runId: string): void {
  location.hash = hashFor('crystallize', { crystallize: { runId } })
  syncRoute()
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

/** 一闪而过的提示（操作成功/失败的一句话反馈）。 */
export const toast = writable<string | null>(null)

let toastTimer: ReturnType<typeof setTimeout> | null = null
export function showToast(message: string): void {
  toast.set(message)
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toast.set(null), 4000)
}
