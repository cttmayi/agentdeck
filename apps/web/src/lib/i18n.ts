import { isLocale, type Locale } from '@agentdeck/i18n'
import { api } from './api.ts'
import { locale } from './locale.ts'

// ★ 语言 store 的**本体**搬去了 `locale.ts`（拆掉 `i18n.ts → api.ts → i18n.ts`
//   这个环，理由写在那份文件顶部），`t` / `tx` 也从那里来（`createLocaleKit`，
//   2026-11）——这里只 re-export：`locale` / `t` / `tx` 一直是组件 import 的入口，
//   接口位置不该因为内部搬家而变化。
export { locale, t, tx } from './locale.ts'

/**
 * 切换语言：本地立即生效 + 写回 workspace。
 *
 * ⚠️ 写回失败**不回滚界面**：使用者已经看到它切过去了，把它翻回去比"服务端暂时
 *    没记住"更让人困惑。失败只记一条警告（下次启动会回到服务端那份）。
 *
 * ⚠️ 本端语言由**身份接口**（workspace）决定，所以切换必须写回 workspace——
 *    服务端要用它渲染 prompt 里的语言指令（这是与远端管理页 localStorage 持久化
 *    的根本区别，见 `locale.ts` 顶部）。
 */
export async function setLocale(next: Locale): Promise<void> {
  locale.set(next)
  try {
    await api('/api/workspace/locale', { method: 'PUT', body: JSON.stringify({ locale: next }) })
  } catch (err) {
    console.warn('保存界面语言失败（本次切换仍然生效）：', err)
  }
}

/** 身份接口到达时把语言装上（页面启动就该是对的语言，不该先闪中文）。 */
export function setLocaleFromIdentity(value: unknown): void {
  if (isLocale(value)) locale.set(value)
}
