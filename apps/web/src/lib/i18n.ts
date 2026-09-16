import { derived, get, writable } from 'svelte/store'
import {
  DEFAULT_LOCALE,
  isLocale,
  renderText,
  webText,
  type Locale,
  type TextParams,
  type WebTextId,
} from '@alpha-helper/i18n'
import { api } from './api.ts'

/**
 * 界面语言（D39）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 用法：标记里写 `{$t('agents.new')}`，回调里写 `t('agents.new')`
 * ══════════════════════════════════════════════════════════════════
 *
 * ⚠️ **标记里必须用 `$t(...)`（带 `$`）**，不能直接调 `t(...)`。
 *    原因是响应式：`t()` 内部读的是 `get(locale)`，而在事件回调里那样读是**没有
 *    订阅关系**的——切换语言时那些文字不会重渲染。`$t` 是一个 derived store，
 *    标记里用它就等于订阅了 `locale`，语言一变整块重渲染。
 *
 *    · 标记 / 响应式语句 ⇒ `{$t('id')}`（会跟着语言变）
 *    · 事件回调、toast、confirm ⇒ `t('id')`（调用那一刻取当前语言，够了）
 *
 * ⚠️ 语言存在 **workspace** 上（服务端也要用它渲染 prompt 里的语言指令），
 *    所以切换时先本地立即生效（界面不等网络），再写回服务端。
 */
export const locale = writable<Locale>(DEFAULT_LOCALE)

/** 语言 → 该语言的文案函数；标记里用 `{$t('id', params)}`。 */
export const t = derived(locale, ($locale) => {
  return (id: WebTextId, params?: TextParams): string =>
    renderText(webText, id, $locale, params)
})

/** 命令式取文案（事件回调里用；不参与响应式）。 */
export function tx(id: WebTextId, params?: TextParams): string {
  return renderText(webText, id, get(locale), params)
}

/** 身份接口到达时把语言装上（页面启动就该是对的语言，不该先闪中文）。 */
export function setLocaleFromIdentity(value: unknown): void {
  if (isLocale(value)) locale.set(value)
}

/**
 * 切换语言：本地立即生效 + 写回 workspace。
 *
 * ⚠️ 写回失败**不回滚界面**：使用者已经看到它切过去了，把它翻回去比"服务端暂时
 *    没记住"更让人困惑。失败只记一条警告（下次启动会回到服务端那份）。
 */
export async function setLocale(next: Locale): Promise<void> {
  locale.set(next)
  try {
    await api('/api/workspace/locale', { method: 'PUT', body: JSON.stringify({ locale: next }) })
  } catch (err) {
    console.warn('保存界面语言失败（本次切换仍然生效）：', err)
  }
}
