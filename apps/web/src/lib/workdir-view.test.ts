import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { WorkDirFile } from './api.ts'
import {
  emptyDirNoticeKey,
  flattenWorkDir,
  humanSize,
  sortWorkDirEntries,
} from './workdir-view.ts'

/**
 * 工作目录那一栏的显示逻辑。
 *
 * 这一栏出过两次"看起来像没数据"的问题，都不是数据的问题（见 workdir-view.ts）：
 * 一次是判断与渲染用了两份列表，一次是递归列整棵树把产出淹掉。
 * 所以这些判断全部提成纯函数，在这里穷举。
 */

function f(
  path: string,
  { kind = 'file', managed = false, hasChildren = false, size = 10 } = {},
): WorkDirFile {
  return {
    path,
    name: path.split('/').pop()!,
    kind: kind as WorkDirFile['kind'],
    sizeBytes: size,
    modifiedAt: 1,
    hasChildren,
    managed,
  }
}

describe('★ 只显示第一级 + 目录点击展开', () => {
  test('★ 没展开的目录：只有它自己那一行，子项不出现', () => {
    const rows = flattenWorkDir(
      [f('src', { kind: 'dir', hasChildren: true }), f('a.js')],
      new Map([['src', [f('src/b.js')]]]),
      new Set(),
    )
    assert.deepEqual(rows.map((r) => r.entry.path), ['src', 'a.js'])
  })

  test('★ 展开了就把它那一层接在后面，缩进 +1', () => {
    const rows = flattenWorkDir(
      [f('src', { kind: 'dir', hasChildren: true }), f('a.js')],
      new Map([['src', [f('src/b.js'), f('src/nested', { kind: 'dir' })]]]),
      new Set(['src']),
    )
    assert.deepEqual(
      rows.map((r) => [r.entry.path, r.depth]),
      [['src', 0], ['src/nested', 1], ['src/b.js', 1], ['a.js', 0]],
      '目录在前；缩进按层级；同层的其它项不受影响',
    )
  })

  test('★ 展开但还没取回来 ⇒ **不编造行**（上层去显示"正在读…"）', () => {
    const rows = flattenWorkDir([f('src', { kind: 'dir' })], new Map(), new Set(['src']))
    assert.deepEqual(rows.map((r) => r.entry.path), ['src'])
  })

  test('★ 嵌套两层：缩进逐层 +1', () => {
    const rows = flattenWorkDir(
      [f('a', { kind: 'dir' })],
      new Map([
        ['a', [f('a/b', { kind: 'dir' })]],
        ['a/b', [f('a/b/c.md')]],
      ]),
      new Set(['a', 'a/b']),
    )
    assert.deepEqual(
      rows.map((r) => [r.entry.name, r.depth]),
      [['a', 0], ['b', 1], ['c.md', 2]],
    )
  })

  test('文件即使被"展开"也没有下一层（不会去取它的"子项"）', () => {
    const rows = flattenWorkDir(
      [f('a.js')],
      new Map([['a.js', [f('a.js/b')]]]),
      new Set(['a.js']),
    )
    assert.deepEqual(rows.map((r) => r.entry.path), ['a.js'])
  })

  test('★ 产出在前、平台注入在后（否则 .claude 会顶掉产出）', () => {
    const rows = flattenWorkDir(
      [
        f('.claude', { kind: 'dir', managed: true }),
        f('CLAUDE.md', { managed: true }),
        f('z.js'),
        f('assets', { kind: 'dir' }),
        f('a.js'),
      ],
      new Map(),
      new Set(),
    )
    assert.deepEqual(
      rows.map((r) => r.entry.name),
      ['assets', 'a.js', 'z.js', '.claude', 'CLAUDE.md'],
      '每一拨里目录在前、再按名字',
    )
  })

  test('空目录 ⇒ 没有行（界面自己决定说什么）', () => {
    assert.deepEqual(flattenWorkDir([], new Map(), new Set()), [])
  })
})

describe('排序与大小', () => {
  test('sortWorkDirEntries 不改原数组', () => {
    const input = [f('z.js'), f('a', { kind: 'dir' })]
    const out = sortWorkDirEntries(input)
    assert.deepEqual(input.map((e) => e.name), ['z.js', 'a'], '原件不动')
    assert.deepEqual(out.map((e) => e.name), ['a', 'z.js'])
  })

  test('humanSize 覆盖三个量级', () => {
    assert.equal(humanSize(42), '42 B')
    assert.equal(humanSize(2048), '2.0 KB')
    assert.equal(humanSize(3 * 1024 * 1024), '3.0 MB')
  })
})

/**
 * 「还不存在」与「存在但是空的」——两句给出**不同的下一步**。
 *
 * 两者拿到的都是空数组，所以判据只能是服务端给的 `exists`。这一条曾经被人误当成
 * 措辞问题（"反正都是没有文件"），而它决定使用者接下来干什么：再等等 / 先去说句
 * 话，还是"它确实没产出"。
 */
describe('空目录该说哪一句', () => {
  test('★ exists:false ⇒ 说"还不存在"（聊天第一轮之前就是这一档）', () => {
    assert.equal(emptyDirNoticeKey(false), 'files.notCreated')
  })

  test('exists:true ⇒ 说"还是空的"', () => {
    assert.equal(emptyDirNoticeKey(true), 'files.empty')
  })

  test('★ undefined（旧 daemon 不返回这个字段）按"存在"处理——不许替它编事实', () => {
    assert.equal(emptyDirNoticeKey(undefined), 'files.empty')
  })
})
