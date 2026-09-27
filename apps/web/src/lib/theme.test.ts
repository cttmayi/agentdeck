import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveTheme } from './theme.ts'

/**
 * 主题判定（纯函数部分）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这组测试要挡住的错
 * ══════════════════════════════════════════════════════════════════
 *
 * · "跟随系统"不是第三种颜色，而是"把选择权交给系统"——`system` + 系统是暗
 *   ⇒ 暗，是亮的 ⇒ 亮，判定与系统同步；
 * · 手动定死的那两档**不被系统覆盖**：选了亮就是亮，哪怕系统是暗的。
 */
describe('主题：偏好 → 实际主题', () => {
  test('system 跟随系统', () => {
    assert.equal(resolveTheme('system', true), 'dark')
    assert.equal(resolveTheme('system', false), 'light')
  })

  test('手动定死不跟随系统', () => {
    assert.equal(resolveTheme('light', true), 'light', '系统是暗的，但手动选了亮')
    assert.equal(resolveTheme('dark', false), 'dark', '系统是亮的，但手动选了暗')
  })
})
