import { get, writable } from 'svelte/store'
import { DEFAULT_LOCALE, type Locale } from '@alpha-helper/i18n'

/**
 * 当前界面语言的**状态本体**（D39）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么单独一个模块，而不是把 store 留在 `i18n.ts` 里
 * ══════════════════════════════════════════════════════════════════
 *
 * 因为 `i18n.ts` 要 import `api.ts`（`setLocale()` 得把语言写回 workspace），
 * 于是库层（`api.ts` / `remote.ts` / `remote-store.ts` / `sync.ts`）想取一条
 * 错误文案时，如果反过来 import `i18n.ts`，就出现一个环：
 *
 *     i18n.ts → api.ts → i18n.ts
 *
 * 环在这里不是理论问题：ESM 下环的一侧会拿到还没初始化的绑定，症状是
 * "某些加载顺序下 `locale` 是 undefined"，而且只在特定入口复现。
 *
 * 所以把**状态与取值**沉到这一个模块：它不 import 任何 app 模块，谁都能引它，
 * 不再有环。界面用的 `t` / `tx` / `setLocale` 仍在 `i18n.ts`（那边依赖 api）。
 */
export const locale = writable<Locale>(DEFAULT_LOCALE)

/**
 * 命令式取当前语言——**每次调用都读当下的值**。
 *
 * ⚠️ 这正是"语言切换后新产生的消息就是新语言"的原因：库层不在响应式上下文里，
 *    不可能订阅 store，只能在造消息的那一刻问一次。已经造好的消息不会重译，
 *    这是有意的（见 `err.*` 词条顶部的说明）。
 */
export function currentLocale(): Locale {
  return get(locale)
}
