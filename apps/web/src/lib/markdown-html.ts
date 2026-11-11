import { writable } from 'svelte/store'
import type { MarkdownHtmlMode } from './markdown.ts'

/**
 * Markdown 里 HTML 的处理档位（2026-11 使用者定案：三档，默认关）。
 *
 * 这是**显示偏好**（跟语言/主题同类，纯前端），存 localStorage、不落 daemon：
 * 渲染器是纯函数（`markdown.ts` 由测试钉住），各显示位置从这份 store 读档位传入。
 *
 * 三档（见 `markdown.ts` 的 `MarkdownHtmlMode`）：
 *   - `off`      不支持（默认）：原始 HTML 一律转义成文字；
 *   - `allowlist`白名单：安全标签翻译成等价渲染，危险 HTML 仍全转义；
 *   - `raw`      原始：完全放行（信任档，设置页有警告）。
 *
 * ⚠️ 不认识的旧值一律落回 `off`（默认关是安全底线，不能因为存了坏值就悄悄放开）。
 */
const STORAGE_KEY = 'ah.markdown-html'

function readStored(): MarkdownHtmlMode {
  const v = localStorage.getItem(STORAGE_KEY)
  return v === 'allowlist' || v === 'raw' ? v : 'off'
}

export const markdownHtmlMode = writable<MarkdownHtmlMode>(readStored())

export function setMarkdownHtmlMode(v: MarkdownHtmlMode): void {
  markdownHtmlMode.set(v)
  localStorage.setItem(STORAGE_KEY, v)
}
