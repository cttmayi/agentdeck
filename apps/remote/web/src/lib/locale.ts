import { get } from 'svelte/store'
import { DEFAULT_LOCALE, isLocale, remoteText, type Locale, type RemoteTextId } from '@agentdeck/i18n'
import { createLocaleKit } from '@agentdeck/ui'

/**
 * 远端管理页的语言（2026-11：形状来自 `@agentdeck/ui` 的 `createLocaleKit`，
 * 与 daemon 界面同一个工厂；文案表 `remoteText` 与 localStorage 持久化是本端的）。
 *
 * ⚠️ 持久化在 localStorage 而非 workspace 是有原因的：daemon 那份存在 workspace
 *    上（服务端也要用语言渲染 prompt 里的指令），而远端管理页只是一个纯前端
 *    只读页——没有 workspace 可存，也不该为了一个语言开关去调接口。
 *
 * ⚠️ 键名用 `ah.locale`（`ah` 是历史前缀，与主题的 `ah.theme-pref` 同族）：
 *    两个界面共用同一个键 ⇒ 在 daemon 界面选了 English，这里也是 English。
 */
const STORAGE_KEY = 'ah.locale'

function readStored(): Locale {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return isLocale(v) ? v : DEFAULT_LOCALE
  } catch {
    return DEFAULT_LOCALE
  }
}

export const { locale, setLocale, t, tx, currentLocale } = createLocaleKit<RemoteTextId>({
  texts: remoteText,
  read: readStored,
  write: (next) => {
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // 隐私模式写不进去：本次会话内仍然生效
    }
  },
})

/** 取当前语言（非响应式场景，如时间格式的 locale 参数）。 */
export function currentLanguageTag(): string {
  return currentLocale() === 'zh' ? 'zh-CN' : 'en-US'
}
