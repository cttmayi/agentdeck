import { derived, get, writable, type Readable, type Writable } from 'svelte/store'
import {
  DEFAULT_LOCALE,
  renderText,
  type Locale,
  type TextCatalog,
  type TextParams,
} from '@agentdeck/i18n'

/**
 * 语言层工厂（2026-11 抽进 `@agentdeck/ui`）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么有一个工厂，而不是一份共用的 locale 模块
 * ══════════════════════════════════════════════════════════════════
 *
 * 两个前端（daemon 界面 / 远端管理页）的**形状**是同一个：`locale` store +
 * derived `t` + 命令式 `tx` + `setLocale`。但两处有两处各自的真实差异：
 *
 *   · 文案表不同（webText vs remoteText——见 `@agentdeck/i18n`，两套表
 *     **有意分开**，各自的翻译可以各自演进）；
 *   · 持久化不同（daemon 存 workspace，服务端渲染 prompt 要用；
 *     远端管理页是纯前端只读页，存 localStorage）。
 *
 * 所以抽的是"同一形状"：工厂接 `texts` 与 `read/write` 两个钩子，两个前端
 * 各实例化一份。**不再各写一份 `derived + renderText` 的模板**。
 */
export interface LocaleKitOptions<T extends string> {
  /** 这一端的文案总表（webText / remoteText）。 */
  texts: TextCatalog
  /** 启动时读当前语言（localStorage / workspace 缓存 / 默认）。 */
  read: () => Locale
  /** 切换后落盘（localStorage / workspace API）。失败不回滚界面。 */
  write: (next: Locale) => void
}

export interface LocaleKit<T extends string> {
  locale: Writable<Locale>
  /** 切换语言：本地立即生效 + 落盘（`write` 钩子）。 */
  setLocale: (next: Locale) => void
  /** 标记里用 `{$t('id')}`（订阅了 locale，语言一变重渲染）。 */
  t: Readable<(id: T, params?: TextParams) => string>
  /** 命令式取文案（事件回调里用；取调用那一刻的语言）。 */
  tx: (id: T, params?: TextParams) => string
  /** 库层用（不在响应式上下文里）。 */
  currentLocale: () => Locale
}

export function createLocaleKit<T extends string>(opts: LocaleKitOptions<T>): LocaleKit<T> {
  const locale = writable<Locale>(opts.read())
  const setLocale = (next: Locale): void => {
    locale.set(next)
    opts.write(next)
  }
  const t = derived(locale, ($locale) => (id: T, params?: TextParams): string =>
    renderText(opts.texts, id, $locale, params),
  )
  const tx = (id: T, params?: TextParams): string => renderText(opts.texts, id, get(locale), params)
  const currentLocale = (): Locale => get(locale)
  return { locale, setLocale, t, tx, currentLocale }
}
