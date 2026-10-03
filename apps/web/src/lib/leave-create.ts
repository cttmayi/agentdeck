import { get } from 'svelte/store'
import { askConfirm } from './confirm.ts'
import { createDirty } from './create-draft.ts'
import { tx } from './i18n.ts'
import { creating, go } from './view.ts'

/**
 * 「建任务」那一栏**能离开吗**——填过东西就先问一句。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么这件事单独一个模块，而不是写在任务页里
 * ══════════════════════════════════════════════════════════════════
 *
 * 2026-10：那一栏上面那个「返回任务清单」按钮按要求去掉了（使用者："新建任务上面
 * 有一个『返回任务清单』，请去掉"）。去掉之后"怎么回去"就散在**几个**地方：
 *
 *   · 顶栏的「列表 / 看板」两个模式按钮（点了就是"回列表"）；
 *   · 侧边栏的「任务」那一项（它在建任务时本来就是高亮的）；
 *   · 浏览器后退（**拦不住**，见下）。
 *
 * 这三条路分别住在三个组件里，而"要不要问一句"的判据只有一个
 * （`createDirty`）。各写一遍的后果不是重复，而是**漏**——漏掉的那一条正是
 * 静默丢掉草稿的那条，而它没有任何症状（人只会觉得"我写的哪去了"）。
 *
 * ⚠️ 侧边栏那一条尤其要接住：它是全屏常驻、最容易点到的东西，而它走的是通用
 *    导航（`go(view)`），压根不知道"建任务"这件事。
 *
 * ⚠️ **浏览器后退挡不住**：地址是路由的唯一出处，而"拦住一次后退"要么改地址
 *    再改回来（会打成一团、还会多出一条历史），要么用 History API 那一套
 *    （这个应用刻意不用，见 `route.ts`）。所以后退仍然是"草稿会没"的一条路——
 *    如实记在这里，真正的解法是**把草稿留在 store 里**（离开再回来还在），
 *    而不是问得更勤。
 */

/** 填过东西就弹一个确认框；没填过直接放行。 */
export async function confirmDiscardDraft(): Promise<boolean> {
  if (!get(createDirty)) return true
  return await askConfirm({
    title: tx('tasks.leaveCreateTitle'),
    message: tx('tasks.leaveCreateBody'),
    confirmLabel: tx('tasks.leaveCreateConfirm'),
    danger: true,
  })
}

/**
 * 离开建任务那一栏（不填任何东西就直接走）。
 *
 * 返回 `false` = 使用者点了「取消」，**哪儿都别去**。
 */
export async function leaveCreate(): Promise<boolean> {
  if (!get(creating)) return true
  if (!(await confirmDiscardDraft())) return false
  go('tasks')
  return true
}
