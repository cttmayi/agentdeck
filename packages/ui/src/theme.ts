/**
 * 界面主题：亮 / 暗 / 跟随系统。
 *
 * ══════════════════════════════════════════════════════════════════
 * 三档而不是两档
 * ══════════════════════════════════════════════════════════════════
 *
 * "亮 / 暗"两档把"我现在是什么"和"系统是什么"绑死在一起——晚上系统切了暗色，
 * 界面不跟着变；白天在没开暗色的机器上又一直是亮的。`system` 那一档把选择权
 * 交还系统（`prefers-color-scheme`），"我平时跟随系统、偶尔手动定死"才是一个
 * 偏好该有的样子。
 *
 * ══════════════════════════════════════════════════════════════════
 * 生效方式
 * ══════════════════════════════════════════════════════════════════
 *
 * 主题以 `data-theme` 属性落在 `<html>` 上，CSS 里 `:root` 是亮色、
 * `:root[data-theme='dark']` 是暗色——换主题只是换一层变量，组件一个都不用动。
 *
 * ⚠️ **首帧防闪**：主题存在 localStorage 里，而 CSS 在 JS 跑起来之前就已经在画。
 *    index.html 里有一段同步的 inline script，在首帧前把 `data-theme` 定好
 *    （判定逻辑与这里一致，默认跟随系统）——否则每次刷新都会"先亮后暗"闪一下。
 *
 * ⚠️ 判据抽成纯函数 `resolveTheme`（有测试）：`matchMedia` 那一步只在浏览器里
 *    有，而"system + 系统是暗 ⇒ 暗"这个判定是可以在 node 里钉死的。
 */
import { derived, get, writable } from 'svelte/store'

export type ThemePref = 'light' | 'dark' | 'system'
export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'ah.theme-pref'

/** 偏好 → 实际主题。纯函数：`systemDark` 由调用方从 `matchMedia` 取。 */
export function resolveTheme(pref: ThemePref, systemDark: boolean): Theme {
  if (pref === 'system') return systemDark ? 'dark' : 'light'
  return pref
}

function readStored(): ThemePref {
  if (typeof localStorage === 'undefined') return 'system'
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system'
  } catch {
    return 'system'
  }
}

function systemDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** 用户偏好（持久化）。默认跟随系统。 */
export const themePref = writable<ThemePref>(readStored())

/** 实际生效的主题：偏好为 system 时跟随系统。 */
export const effectiveTheme = derived(themePref, ($p) => resolveTheme($p, systemDark()))

function apply(theme: Theme): void {
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = theme
  }
}

effectiveTheme.subscribe(apply)

// 跟随系统时，系统一换界面立刻跟着换（derived 只在输入变化时重算，所以这里
// 直接订阅 matchMedia，而不是绕一圈去改 store）。
if (typeof window !== 'undefined') {
  window
    .matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => {
      if (get(themePref) === 'system') apply(resolveTheme('system', systemDark()))
    })
}

/** 设偏好并持久化。 */
export function setThemePref(pref: ThemePref): void {
  themePref.set(pref)
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, pref)
  } catch {
    // 隐私模式等场景写不进去：本次会话内仍然生效，只是不记住
  }
}
