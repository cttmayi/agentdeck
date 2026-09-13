import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { groupWorkDirFiles, type WorkDirFile } from './api.ts'

/**
 * 工作目录列表的显示归类。
 *
 * 这条逻辑是被一个真实的"看起来像空目录"的界面 bug 逼出来的：界面判断
 * `entries.length === 0` 却渲染过滤后的列表，于是"只有平台注入文件"的目录
 * 会显示成一栏空白 —— 没有任何说明。
 */

function f(path: string, managed = false, kind: 'file' | 'dir' = 'file'): WorkDirFile {
  return { path, kind, sizeBytes: 10, modifiedAt: 1, managed }
}

describe('★ 工作目录列表归类', () => {
  test('★ 只有平台注入的文件时，不能显示成"空目录"', () => {
    // 这正是那个 bug：`entries.length` 不为 0，但过滤后一个都不剩
    const g = groupWorkDirFiles([f('.claude', true, 'dir'), f('CLAUDE.md', true)])
    assert.equal(g.isEmpty, false, '★ 目录里有东西，就不能说它是空的')
    assert.equal(g.outputs.length, 0)
    assert.equal(g.injected.length, 2, '平台注入的要能被单独列出来，而不是被藏掉')
  })

  test('真正的空目录才算空', () => {
    assert.equal(groupWorkDirFiles([]).isEmpty, true)
  })

  test('产出在前、平台注入在后，各自按路径排序', () => {
    const g = groupWorkDirFiles([
      f('CLAUDE.md', true),
      f('z.js'),
      f('.claude', true, 'dir'),
      f('a.md'),
    ])
    assert.deepEqual(g.outputs.map((e) => e.path), ['a.md', 'z.js'])
    assert.deepEqual(g.injected.map((e) => e.path), ['.claude', 'CLAUDE.md'])
  })

  test('全部都是产出时，injected 为空', () => {
    const g = groupWorkDirFiles([f('a.png'), f('b.svg')])
    assert.equal(g.injected.length, 0)
    assert.equal(g.isEmpty, false)
  })
})
