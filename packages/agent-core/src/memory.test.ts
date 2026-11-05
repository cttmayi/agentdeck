import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  MEMORY_BUDGET_CHARS,
  MEMORY_KIND_PRIORITY,
  memoryBlockText,
  memoryLineText,
  rankMemory,
  type RankableMemory,
} from './memory.ts'

/**
 * 「经验」那一块怎么排、带哪几条（分批第 240 批）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这组测试守住的是"它为什么这么干"的可解释性
 * ══════════════════════════════════════════════════════════════════
 *
 * 记忆是唯一一处"改了它就会改变它下一次怎么干活"的文本，所以这一段必须**可预测**：
 * 同样的输入永远同样的输出、同样的顺序、同样的裁剪。顺序变了而没人知道为什么，
 * 排查就只能靠猜。
 */

function mem(over: Partial<RankableMemory> & { text: string }): RankableMemory {
  return { kind: 'fact', ...over }
}

describe('记忆排序：谁先被带进去', () => {
  test('★★ 置顶的排最前（哪怕它是"教训"这种优先级最低的）', () => {
    const ranked = rankMemory([
      mem({ kind: 'commitment', text: '约定' }),
      mem({ kind: 'lesson', text: '置顶的教训', pinned: true }),
    ])
    assert.deepEqual(
      ranked.picked.map((m) => m.text),
      ['置顶的教训', '约定'],
    )
  })

  test('★★ 其余按类型优先级：约定 > 偏好 > 事实 > 教训', () => {
    const ranked = rankMemory([
      mem({ kind: 'lesson', text: '教训' }),
      mem({ kind: 'fact', text: '事实' }),
      mem({ kind: 'preference', text: '偏好' }),
      mem({ kind: 'commitment', text: '约定' }),
    ])
    assert.deepEqual(
      ranked.picked.map((m) => m.text),
      ['约定', '偏好', '事实', '教训'],
    )
  })

  test('★★ 同类按"最近用过"——久不用的自然沉底（所以不需要"停用"状态）', () => {
    const ranked = rankMemory([
      mem({ kind: 'fact', text: '很久没用的', lastUsedAt: 100 }),
      mem({ kind: 'fact', text: '昨天用的', lastUsedAt: 5000 }),
      mem({ kind: 'fact', text: '从没用过的', lastUsedAt: null }),
    ])
    assert.deepEqual(
      ranked.picked.map((m) => m.text),
      ['昨天用的', '很久没用的', '从没用过的'],
    )
  })

  test('★ 还平的话按创建时间新的在前（顺序必须稳定，否则每次打开都换一副样子）', () => {
    const a = mem({ kind: 'fact', text: '先建的', createdAt: 1 })
    const b = mem({ kind: 'fact', text: '后建的', createdAt: 2 })
    const first = rankMemory([a, b]).picked.map((m) => m.text)
    const second = rankMemory([b, a]).picked.map((m) => m.text)
    assert.deepEqual(first, ['后建的', '先建的'])
    assert.deepEqual(second, first, '输入顺序不影响输出顺序')
  })

  test('优先级表就是这四种、没有别的', () => {
    assert.deepEqual(Object.keys(MEMORY_KIND_PRIORITY).sort(), [
      'commitment',
      'fact',
      'lesson',
      'preference',
    ])
  })
})

describe('记忆预算：带不下就裁，但要**说出来**', () => {
  test('★ 每行带 `[类型]` 标记（一眼分得出这是"我答应过"还是"我复盘出来的"）', () => {
    assert.equal(memoryLineText({ kind: 'commitment', text: '报告不出现"赋能"' }), '- [约定] 报告不出现"赋能"')
    assert.equal(memoryLineText({ kind: 'lesson', text: '别写太长' }), '- [教训] 别写太长')
  })

  test('★★ 默认预算下，太多条会被裁掉，并且块尾写清"另有 N 条没带"', () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      mem({ kind: 'fact', text: `第 ${i} 条：这一条的记忆正文，长度大约三十个字，用来逼近预算上限` }),
    )
    const out = memoryBlockText(many)
    assert.ok(out.picked.length > 0, '至少要带几条进去')
    assert.ok(out.picked.length < many.length, '这个数量应当触发裁剪')
    assert.equal(out.dropped, many.length - out.picked.length)
    assert.match(out.text, new RegExp(`另有 ${out.dropped} 条`), '裁掉多少要如实写出来')
    assert.ok(out.text.length <= MEMORY_BUDGET_CHARS + 200, '正文不该远超预算（多出来的是声明与"另有N条"）')
  })

  test('★ 预算够用时一条都不裁，也不出现"另有 N 条"', () => {
    const out = memoryBlockText([mem({ text: '用 pnpm' }), mem({ text: '报告落 reports/' })])
    assert.equal(out.dropped, 0)
    assert.doesNotMatch(out.text, /另有/)
  })

  test('★★ 块首那句**从属声明**必须在：可能过时、与身份/任务冲突时以它们为准', () => {
    const out = memoryBlockText([mem({ text: '用 pnpm' })])
    assert.match(out.text, /过去记下的经验/)
    assert.match(out.text, /可能已经过时/)
    assert.match(out.text, /冲突时/)
  })

  test('★ 没有记忆 ⇒ 空串（这一块整块不出现，不是一段空标题）', () => {
    assert.deepEqual(memoryBlockText([]), { text: '', picked: [], dropped: 0 })
  })

  test('★ 自定义预算（测试缝）：给得很小也至少带一条', () => {
    // 一行的成本 ≈ `- [事实] ` 那 7 个字 + 正文 + 换行 ⇒ 预算 12 只装得下一条
    const out = memoryBlockText([mem({ text: '短' }), mem({ text: '另一条' })], { budgetChars: 12 })
    assert.equal(out.picked.length, 1, '第一条无论如何都要带上（否则这一块等于没这块）')
    assert.equal(out.dropped, 1)
  })

  test('★★ 顺序与裁剪是同一个决定：被裁的永远是排在后面的那些', () => {
    const items = [
      mem({ kind: 'fact', text: 'A'.repeat(30) }),
      mem({ kind: 'commitment', text: 'B'.repeat(30) }),
      mem({ kind: 'lesson', text: 'C'.repeat(30) }),
    ]
    // 一行 ≈ 7（标记）+ 30（正文）+ 1（换行）= 38 字 ⇒ 预算 80 装得下两条
    const out = memoryBlockText(items, { budgetChars: 80 })
    assert.deepEqual(
      out.picked.map((m) => m.text[0]),
      ['B', 'A'],
      '约定先于事实、教训最后（被裁的是教训那条）',
    )
  })
})
