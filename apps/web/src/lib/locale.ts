import { DEFAULT_LOCALE, webText, type Locale, type WebTextId } from '@agentdeck/i18n'
import { createLocaleKit } from '@agentdeck/ui'

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
 *
 * ⚠️ 2026-11：语言层的**形状**（store + `t` + `tx` + `currentLocale`）来自
 *    `@agentdeck/ui` 的 `createLocaleKit`（远端管理页用同一个工厂，只是文案表
 *    与持久化不同）——形状只有一处，`webText` 与"写回 workspace"仍是本端的事。
 *    语言**读**哪来：本端语言由身份接口（workspace）决定，启动时默认中文，
 *    `setLocaleFromIdentity` 再装上（见 `i18n.ts`）——所以这里 `read` 只给默认值，
 *    `write` 是空操作（写回 workspace 需要 api，会成环，由 `i18n.ts` 负责）。
 */
export const { locale, t, tx, currentLocale } = createLocaleKit<WebTextId>({
  texts: webText,
  read: () => DEFAULT_LOCALE,
  write: () => {
    /* 见上：本端落盘在 i18n.ts 的 setLocale（依赖 api，不能在这儿引）。 */
  },
})

export type { Locale }
