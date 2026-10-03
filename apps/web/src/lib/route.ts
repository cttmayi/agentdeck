/**
 * 路由的**判据**：地址 → (视图, 是不是在建任务)。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么这一层单独一个文件、而且**不碰 `location`
 * ══════════════════════════════════════════════════════════════════
 *
 * `view.ts` 里挂着 store 与 `window.addEventListener`，那是浏览器环境才有的东西
 * ——`node --test` 里 import 它就崩，于是"地址解析得对不对"这件事**从来没被测过**，
 * 只能靠探针隔着浏览器看。而这个函数的两条分支（老地址、未知地址回落）恰恰是
 * 那种"错了也不报错、只是把人送到别的页面上"的东西。
 *
 * 所以判据放这里：入参是一个字符串，出参是一个对象，纯函数、有单测。
 * `view.ts` 只负责"读 `location.hash` → 调它 → 写 store"。
 */

/**
 * ★ 顺序 = 侧边栏顺序：聊天在最前。
 *
 * ⚠️ 2026-10（D58）：「新建任务」**不是**这一个数组里的一项——它是「任务」页右栏
 *    的一个**状态**（`Route.creating`），不是另一个页面。把它留在这里会让"页面
 *     有几个"这件事有两个答案（这个数组说六个、侧栏画五个），而那种分叉最后
 *     一定会在某处漏出来（顶栏页名、探针的项数、文档里的表）。
 */
export const VIEWS = ['chat', 'tasks', 'agents', 'skills', 'tools'] as const
export type ViewName = (typeof VIEWS)[number]

/**
 * 建任务那一栏的正规地址。
 *
 * ★ 写成 `#/tasks/new` 而不是 `#/new`：合并之后"建"是**任务页里的一个位置**，
 *   地址读起来也该是这样。`#/new` 继续认得（见 `parseHash`）——书签、文档、
 *   别人手上的链接都用过它，作废一个地址等于让那些链接悄悄落到别处。
 */
export const CREATE_HASH = '#/tasks/new'

/** 地址里带的那点信息。 */
export interface Route {
  view: ViewName
  /** 「任务」页右栏此刻是**建任务**的表单（而不是某条任务的详情）。 */
  creating: boolean
}

/** 地址 → 路由。认不出来的一律回落「任务」。 */
export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '')
  // ⚠️ 两个地址都指向同一个状态：`tasks/new` 是正规写法，`new` 是 D58 之前那个
  //    「新建任务」整页的地址（当时它还是侧栏一项）。同义地址写两处会不会分叉？
  //    不会——它们在这里**就是同一行**，而 `hashFor()` 只吐正规那个。
  if (raw === 'tasks/new' || raw === 'new') return { view: 'tasks', creating: true }
  // 未知地址回落 `tasks`（D58 改的：原来回落到那个表单，而合并之后"任务"才是主场）
  if (!(VIEWS as readonly string[]).includes(raw)) return { view: 'tasks', creating: false }
  return { view: raw as ViewName, creating: false }
}

/**
 * 路由 → 地址。与 `parseHash` 是**一对**：`parseHash(hashFor(x)) === x` 有单测
 * 逐项钉住（`VIEWS` 里每一项都过一遍）。两处各写一份映射的后果是"点进去是 A、
 * 地址栏写着 B"，而刷新一下才发现。
 */
export function hashFor(view: ViewName, opts: { creating?: boolean } = {}): string {
  // ⚠️ `creating` 只对「任务」成立：别的视图没有"建任务"这个状态，传进来就当没传
  //    （不然会造出一个 `#/agents` 之外还带着建模式的地址，而没人认得它）。
  return opts.creating === true && view === 'tasks' ? CREATE_HASH : `#/${view}`
}
