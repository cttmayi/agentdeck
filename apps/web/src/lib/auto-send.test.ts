/**
 * 自动发送的四条判断（分批第 281 批）。
 *
 * 每一条都对应一次"真发生了会让人意外"的场景：把输入框里原有的字一起发出去、
 * 这一轮还在跑却硬发、识别空了还发、以及默认模式（只回填）被悄悄改掉。
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { AUTO_SEND_SECONDS, afterUndo, shouldAutoSend, type AutoSendContext } from './auto-send.ts'

const base: AutoSendContext = {
  mode: 'via-skill',
  composerWasEmpty: true,
  turnRunning: false,
  text: '记一下：以后报告都用中文',
}

describe('该不该自动发送', () => {
  test('★★ 默认模式（只回填）**绝不**自动发', () => {
    assert.equal(shouldAutoSend({ ...base, mode: 'input' }), false)
  })

  test('★ via-skill 且四个条件都满足 ⇒ 安排发送（还有 3 秒可撤销）', () => {
    assert.equal(shouldAutoSend(base), true)
    assert.equal(AUTO_SEND_SECONDS, 3)
  })

  test('★★ 输入框原本有字 ⇒ 不发（那份字是人写的，不该被一起送出去）', () => {
    assert.equal(shouldAutoSend({ ...base, composerWasEmpty: false }), false)
  })

  test('★★ 这一轮还在跑 ⇒ 不发（硬发会被静默丢掉）', () => {
    assert.equal(shouldAutoSend({ ...base, turnRunning: true }), false)
  })

  test('★ 识别是空的 / 只有空白 ⇒ 不发', () => {
    assert.equal(shouldAutoSend({ ...base, text: '' }), false)
    assert.equal(shouldAutoSend({ ...base, text: '   ' }), false)
  })
})

describe('撤销之后', () => {
  test('★★ 一个字都不丢：字留在输入框里，只是不再自动发', () => {
    const got = afterUndo('用微思普跑一遍')
    assert.equal(got.input, '用微思普跑一遍')
    assert.equal(got.hint, 'cancelled')
  })
})
