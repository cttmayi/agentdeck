import assert from 'node:assert/strict'
import { test } from 'node:test'
import { draftIsLive } from './draft-live.ts'

/**
 * 判据：审阅屏的草稿格该显示**实时日志**（true）还是**最后结果**（false）。
 *
 * 使用者原话：「在草稿-审核的循环中，只能看到审核过程，草稿的日志在UI上一直没有更新。」
 * 根因就是这里判错了——循环中新一版在跑时，界面还按"已完成"渲染上一版的最后文本。
 */

test('★★★ 状态未知（null）算"在跑"：接上在跑的 run / 刚跟到新版时不能显示上一版的旧文本', () => {
  assert.equal(draftIsLive(null), true)
  assert.equal(draftIsLive(undefined), true)
  assert.equal(draftIsLive(''), true)
})

test('★★ 非终态（排队/派发/等目录/运行中）都算"在跑"', () => {
  for (const s of ['queued', 'dispatched', 'waiting_local_directory', 'running']) {
    assert.equal(draftIsLive(s), true, `${s} 应当显示实时日志`)
  }
})

test('★ 终态才显示"最后结果"（完成 / 失败 / 取消）', () => {
  for (const s of ['completed', 'failed', 'cancelled']) {
    assert.equal(draftIsLive(s), false, `${s} 应当显示最后结果`)
  }
})

test('未知状态按"在跑"处理（多显示实时日志不会骗人，把在跑画成已写完才会）', () => {
  assert.equal(draftIsLive('some_future_state'), true)
})
