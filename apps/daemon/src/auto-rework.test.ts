import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_AUTO_REWORK_ROUNDS,
  resolveAutoReworkRounds,
} from './executor.ts'

/**
 * 这一组钉的是自动循环的**轮数口径**（分批第 23 批，使用者定：默认 10，允许 0–99）。
 *
 * 为什么单拎出来测：它只有三行，但错法都是"悄悄烧钱"或"悄悄不干活"——
 * 前者是 `?? 10` 把 0 变成 10（使用者以为关了，实际每轮都在花钱），
 * 后者是 `|| 10` 把 0 变成 10 的对偶（写成 `? :` 时容易反），
 * 或者夹范围时把 99 干成 Infinity 之类。这几条错都不会报错，只会烧钱或不动。
 */
test('★★ 0 = 关，必须原样返回（`?? 10` 会把"关"变成"跑十轮"，每一轮都在花钱）', () => {
  assert.equal(resolveAutoReworkRounds({ autoReworkRounds: 0 }), 0)
})

test('没设过（老数据）⇒ 默认 10', () => {
  assert.equal(resolveAutoReworkRounds({}), DEFAULT_AUTO_REWORK_ROUNDS)
  assert.equal(resolveAutoReworkRounds(null), DEFAULT_AUTO_REWORK_ROUNDS)
  assert.equal(DEFAULT_AUTO_REWORK_ROUNDS, 10, '使用者定的默认值就是 10')
})

test('正常值原样返回', () => {
  assert.equal(resolveAutoReworkRounds({ autoReworkRounds: 1 }), 1)
  assert.equal(resolveAutoReworkRounds({ autoReworkRounds: 99 }), 99)
})

test('★ 脏值夹到 0–99（手工改过 store、旧数据）——但绝不夹成默认值', () => {
  assert.equal(resolveAutoReworkRounds({ autoReworkRounds: -3 }), 0, '负数 = 关，不是"跑默认轮数"')
  assert.equal(resolveAutoReworkRounds({ autoReworkRounds: 500 }), 99)
  assert.equal(resolveAutoReworkRounds({ autoReworkRounds: 3.7 }), 3, '小数截断')
  assert.equal(
    resolveAutoReworkRounds({ autoReworkRounds: Number.NaN }),
    DEFAULT_AUTO_REWORK_ROUNDS,
    'NaN 没法夹 ⇒ 退回默认（而不是变成 0：变成 0 会静默关掉循环）',
  )
})
