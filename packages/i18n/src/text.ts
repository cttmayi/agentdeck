/**
 * 词条的形状与渲染。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么自己写（不引 svelte-i18n / i18next）
 * ══════════════════════════════════════════════════════════════════
 *
 * 这个仓库的前端是**零运行时依赖**的，而我们需要的只是：两张语言表、一个插值。
 * 引一个框架级 i18n 库，代价（依赖树、构建插件、键的隐式约定）远大于收益。
 *
 * ══════════════════════════════════════════════════════════════════
 * 两条硬规矩（都有测试守着）
 * ══════════════════════════════════════════════════════════════════
 *
 *   1. **键必须两边都有**：`zh` 有、`en` 没有 ⇒ 英文界面里冒出一个中文句子；
 *      反过来则是中文界面里冒出英文。这条测试会在**加词条时**就报出来；
 *   2. **插值占位符必须一致**：`{name}` 在两边必须一模一样，否则一种语言里
 *      会留下一串 `{name}` 字面量。
 */
import { DEFAULT_LOCALE, type Locale } from './locale.ts'

export interface TextEntry {
  readonly zh: string
  readonly en: string
}

export type TextCatalog = Readonly<Record<string, TextEntry>>

export type TextParams = Readonly<Record<string, string | number>>

/**
 * 取一条文案并填插值。
 *
 * ⚠️ **缺键不抛异常**，而是返回键名本身（`web.agents.new`）：
 *   界面上一处缺失不该让整页白屏——看得见的键名比白屏好排查，也比"悄悄显示
 *   中文"好（后者会让人以为翻译丢了，而不是这条词条没写）。
 */
export function renderText(
  catalog: TextCatalog,
  id: string,
  locale: Locale = DEFAULT_LOCALE,
  params?: TextParams,
): string {
  const entry = catalog[id]
  if (!entry) return id
  const template = entry[locale] || entry[DEFAULT_LOCALE] || id
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in params ? String(params[key]) : match,
  )
}

/** 词条里出现的占位符名（测试与守卫用）。 */
export function placeholdersOf(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort()
}
