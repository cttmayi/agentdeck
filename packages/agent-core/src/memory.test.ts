import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
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

describe('记忆注入：不裁、按顺序全带上（分批第 266 批）', () => {
  test('★ 每行带 `[类型]` 标记（一眼分得出这是"我答应过"还是"我复盘出来的"）', () => {
    assert.equal(memoryLineText({ kind: 'commitment', text: '报告不出现"赋能"' }), '- [约定] 报告不出现"赋能"')
    assert.equal(memoryLineText({ kind: 'lesson', text: '别写太长' }), '- [教训] 别写太长')
  })

  test('★★★ 记忆再多也**全部带上**——不再有"另有 N 条没带"（使用者：字数限制没必要）', () => {
    /**
     * 使用者："感觉没有必要有字数限制" → 选"去掉吧"。
     *
     * 去掉的是那个 1200 字的**每轮预算**：它会在人看不见的地方裁掉尾巴。
     * 代价（写在实现里、也接受）：每轮第一句话随记忆变多而变长，多出来的记忆会稀释
     * 当前任务的注意力；"另有 N 条没带"这句诚实的提示也就不存在了——因为不再有"没带"。
     * ⚠️ 保留下来的两道：**40 条库存上限**与**单条 400 字**。
     */
    const many = Array.from({ length: 60 }, (_, i) =>
      mem({ kind: 'fact', text: `第 ${i} 条：这一条的记忆正文，长度大约三十个字，曾经会触发裁剪` }),
    )
    const out = memoryBlockText(many)
    assert.equal(out.picked.length, many.length, '一条都不少')
    assert.doesNotMatch(out.text, /另有/, '不该再有"另有 N 条没带"')
    // 字数仍然如实报出来（界面用它显示"本轮带入多少字"）
    assert.ok(out.chars > 0)
  })

  test('★ 块首那句**从属声明**必须在：可能过时、与身份/任务冲突时以它们为准', () => {
    const out = memoryBlockText([mem({ text: '用 pnpm' })])
    assert.match(out.text, /过去记下的经验/)
    assert.match(out.text, /可能已经过时/)
    assert.match(out.text, /冲突时/)
  })

  test('★ 没有记忆 ⇒ 空串（这一块整块不出现，不是一段空标题）', () => {
    assert.deepEqual(memoryBlockText([]), { text: '', picked: [], chars: 0 })
  })

  test('★★ 顺序仍然是"约定 > 偏好 > 事实 > 教训"（不裁之后它纯粹是**顺序**问题）', () => {
    const items = [
      mem({ kind: 'fact', text: 'A'.repeat(30) }),
      mem({ kind: 'commitment', text: 'B'.repeat(30) }),
      mem({ kind: 'lesson', text: 'C'.repeat(30) }),
    ]
    const out = memoryBlockText(items)
    assert.deepEqual(
      out.picked.map((m) => m.text[0]),
      ['B', 'A', 'C'],
      '约定先于事实、教训最后',
    )
  })
})
