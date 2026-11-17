import { describe, test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { get } from 'svelte/store'
import { cardState, hasManualOpen, readOpen, resetCardState, writeOpen } from './card-state.ts'

/**
 * 卡片展开状态的存放（2026-11 返工的正题）。
 *
 * 钉住三件事：
 *   ① 人没动过 ⇒ 用默认值（"正在跑 / 等人确认"由卡片自己算好传进来）；
 *   ② 人点过 ⇒ 听人的，而且**各卡各的**（改一张不影响另一张）；
 *   ③ 状态按 key 存 ⇒ 子卡被卸载（父卡收起）之后，再挂回来还是原值——
 *      这条是"局部变量方案"做不到的，也是这次返工的直接原因。
 */

describe('卡片展开状态：按 key 存、各卡各的', () => {
  beforeEach(() => resetCardState())

  test('没动过 ⇒ 用默认值', () => {
    assert.equal(readOpen('run:abc', true), true)
    assert.equal(readOpen('run:def', false), false)
    assert.equal(hasManualOpen('run:abc'), false)
  })

  test('★ 人点过 ⇒ 听人的，且**不影响别的卡**', () => {
    writeOpen('run:abc', true)
    writeOpen('run:def', false)
    assert.equal(readOpen('run:abc', false), true, '点开的就是开着')
    assert.equal(readOpen('run:def', true), false, '点收的就是收着')
    // 第三张卡没被碰过 → 仍是默认
    assert.equal(readOpen('run:ghi', false), false)
    assert.equal(hasManualOpen('run:ghi'), false)
  })

  test('★★ 卡被卸载再挂回来（父卡收起/展开）⇒ 状态还在', () => {
    writeOpen('run:abc', true)
    // 模拟"父卡收起 ⇒ 子卡不渲染 ⇒ 组件销毁"：这里没有任何"卸载"需要显式做，
    // 状态本来就不在组件里 —— 再读一次就是原值。
    assert.equal(readOpen('run:abc', false), true)
    assert.equal(hasManualOpen('run:abc'), true)
  })

  test('写入会推一次版本号（组件据此重画）', () => {
    const before = get(cardState)
    writeOpen('run:abc', true)
    assert.equal(get(cardState), before + 1)
  })
})
