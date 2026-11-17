/**
 * 卡片的「展开 / 收起」状态：**由卡片自己读写，按卡片 key 存放**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么要一个按 key 存的模块级状态，而不是组件里的 `let`
 * ══════════════════════════════════════════════════════════════════
 *
 * 卡片是**树**：父卡收起时子卡不渲染（`{#if open}`）——这是对的，收起时不该继续
 * 挂着子卡里的 `RunLog`（那意味着还在收 SSE）。但"不渲染"= 组件实例被销毁 ⇒
 * 组件里的局部状态也跟着没了，再展开父卡时子卡回到默认态——**使用者刚点开的那条
 * 日志就被悄悄关掉了**。
 *
 * 所以状态放在这里：**卡片仍然是唯一读写它的人**，只是存的地方不在组件实例里，
 * 而在一个按 key 的字典里。于是：
 *   · 父卡收起 → 子卡卸载 → 不影响任何人的状态（下次渲染读回原值）；
 *   · 兄弟卡之间**结构上不可能互相影响**（各读各的 key）；
 *   · key 用稳定 id（`step:seq` / `round:seq:i` / `run:<runId>`）⇒ 2 秒一次的轮询
 *     不会把状态冲掉；卡片被删掉（步骤没了）时内存里留一条无害的旧值。
 *
 * ⚠️ 上一版把状态放在**视图**里（`expandedSeq` / `openSteps` / `openLogs` 三个字典），
 *    于是"谁该展开"由主流程一处决定；规则一多就互相踩，症状是"点上面的卡，
 *    下面的卡跟着变"。把状态下放到卡片 + 按 key 存之后，这个耦合不存在了。
 */
import { writable } from 'svelte/store'

/** 原生 Map 存状态（不需要响应式），另给一个版本号 store 让组件知道"变了"。 */
const state = new Map<string, boolean>()

/** 版本号：每次 `set` 自增，组件用 `$cardState` 参与响应式。 */
export const cardState = writable(0)

/**
 * 这张卡现在展开吗。
 *
 * @param key     卡片 key（稳定 id）
 * @param fallback 人没动过时的默认值（"正在跑 / 等人确认 ⇒ true"由卡片自己算）
 */
export function readOpen(key: string, fallback: boolean): boolean {
  const v = state.get(key)
  return v === undefined ? fallback : v
}

/** 人点了一下：记下"我要展开 / 收起"，并通知组件重画。 */
export function writeOpen(key: string, open: boolean): void {
  state.set(key, open)
  cardState.update((n) => n + 1)
}

/** 这条 key 有没有被人手动设过（测试与"是否还跟随默认"的判断用）。 */
export function hasManualOpen(key: string): boolean {
  return state.has(key)
}

/** 清空（测试用；产品里不需要——卡片状态本就是会话内的东西）。 */
export function resetCardState(): void {
  state.clear()
  cardState.update((n) => n + 1)
}
