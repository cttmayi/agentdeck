import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CONTEXT_BLOCK_BEGIN,
  CONTEXT_BLOCK_END,
  CONTEXT_BLOCK_SEPARATOR,
  hasContextBlock,
  injectContextBlock,
  removeContextBlock,
  renderContextBlock,
} from './context-block.ts'

const BLOCK = renderContextBlock('任务上下文\n\n一些护栏。')

describe('上下文块注入 —— 三种文件状态（FR-CLI-27）', () => {
  test('① 文件不存在 ⇒ 只写块，不写前置分隔符', () => {
    const r = injectContextBlock(null, BLOCK)
    assert.equal(r.origin, 'created')
    assert.equal(r.content, BLOCK)
    assert.ok(!r.content.startsWith(CONTEXT_BLOCK_SEPARATOR))
  })

  test('② 文件存在但无标记 ⇒ 追加「固定分隔符 + 块」', () => {
    const r = injectContextBlock('# 我的项目\n\n一些说明。\n', BLOCK)
    assert.equal(r.origin, 'appended')
    assert.equal(r.content, `# 我的项目\n\n一些说明。\n${CONTEXT_BLOCK_SEPARATOR}${BLOCK}`)
  })

  test('③ 已有标记块 ⇒ 原地替换块体', () => {
    const original = `# 项目\n\n${BLOCK}\n\n尾部说明`
    const r = injectContextBlock(original, renderContextBlock('新内容'))
    assert.equal(r.origin, 'replaced')
    assert.ok(r.content.startsWith('# 项目\n\n'))
    assert.ok(r.content.endsWith('\n\n尾部说明'), '块外内容必须保留')
    assert.ok(r.content.includes('新内容'))
    assert.ok(!r.content.includes('任务上下文'), '旧块体应被替换掉')
  })

  test('★ 块外内容逐字节保留（含多余换行）', () => {
    const original = `头\n\n\n${BLOCK}\n\n\n尾`
    const r = injectContextBlock(original, renderContextBlock('x'))
    assert.ok(r.content.startsWith('头\n\n\n'))
    assert.ok(r.content.endsWith('\n\n\n尾'))
  })
})

describe('上下文块注入 —— 两个畸形输入（FR-CLI-28）', () => {
  test('★ 孤立的结束标记：只在 BEGIN 之后找 END，否则文件会无限增长', () => {
    // 使用者的文档里引用了我们的格式
    const original = `文档里提到 ${CONTEXT_BLOCK_END} 这个标记\n`
    const first = injectContextBlock(original, BLOCK)
    const second = injectContextBlock(first.content, BLOCK)
    const third = injectContextBlock(second.content, BLOCK)

    assert.equal(first.origin, 'appended')
    // 反复注入不应让文件增长——第二次起就是"替换"
    assert.equal(second.origin, 'replaced')
    assert.equal(third.origin, 'replaced')
    assert.equal(second.content.length, third.content.length, '文件长度必须稳定')

    const count = third.content.split(CONTEXT_BLOCK_BEGIN).length - 1
    assert.equal(count, 1, '文件里应当只有一个受管块')
  })

  test('★ 有 BEGIN 无 END 的半个块 ⇒ 视作延伸到文件末尾，原地替换', () => {
    const half = `头\n\n${CONTEXT_BLOCK_BEGIN}\n写到一半崩了`
    const r = injectContextBlock(half, BLOCK)
    assert.equal(r.origin, 'repaired')
    assert.ok(r.content.startsWith('头\n\n'))
    assert.ok(r.content.endsWith(CONTEXT_BLOCK_END))
    assert.equal(r.content.split(CONTEXT_BLOCK_BEGIN).length - 1, 1, '不应堆叠出第二个块')
  })

  test('半个块反复注入也稳定', () => {
    let content: string | null = `头\n\n${CONTEXT_BLOCK_BEGIN}\n半个`
    for (let i = 0; i < 5; i++) {
      content = injectContextBlock(content, BLOCK).content
    }
    assert.equal(content.split(CONTEXT_BLOCK_BEGIN).length - 1, 1)
    assert.ok(content.startsWith('头\n\n'))
  })

  test('空文件（存在但为空）与"不存在"语义不同', () => {
    const fromEmpty = injectContextBlock('', BLOCK)
    assert.equal(fromEmpty.origin, 'appended')
    assert.equal(fromEmpty.content, CONTEXT_BLOCK_SEPARATOR + BLOCK)

    const fromMissing = injectContextBlock(null, BLOCK)
    assert.equal(fromMissing.origin, 'created')
    assert.equal(fromMissing.content, BLOCK)
  })
})

describe('上下文块清理 —— 逐字节还原（FR-CLI-29）', () => {
  /**
   * 往返性质：对**不含我们标记**的原始内容，注入 → 清理必须回到原样。
   *
   * 这是 FR-CLI-29 最强的形态：不是"检查几个样例"，而是"任何内容都不能被改坏"。
   * 之所以限定"不含标记"——见下方「清理自己的区域」一节，那种输入本就
   * 不可能往返（清理的正确行为就是去掉我们那一块）。
   */
  function roundtrip(original: string | null): void {
    const injected = injectContextBlock(original, BLOCK)
    const removed = removeContextBlock(injected.content)

    if (original === null) {
      assert.equal(removed.deleteFile, true, '原本不存在 ⇒ 应删除文件')
      return
    }
    assert.equal(removed.deleteFile, false, '原本存在 ⇒ 不应删除文件')
    assert.equal(
      removed.content,
      original,
      `还原失败：\n原: ${JSON.stringify(original)}\n回: ${JSON.stringify(removed.content)}`,
    )
  }

  const cases: Array<[string, string | null]> = [
    ['文件不存在', null],
    ['空文件', ''],
    ['只有正文', '# 标题\n正文'],
    ['以 1 个换行结尾', '# 标题\n'],
    ['以 3 个换行结尾', '# 标题\n\n\n'],
    ['以空格结尾', '正文 '],
    ['CRLF 换行', '# 标题\r\n正文\r\n'],
    ['只有空白', '   \n\n  '],
    ['很长的正文', `${'x'.repeat(5000)}\n`],
    ['含 END 标记字样（孤立）', `文档里提到 ${CONTEXT_BLOCK_END} 这个标记\n`],
  ]

  for (const [name, original] of cases) {
    test(`往返还原：${name}`, () => roundtrip(original))
  }

  test('★ 反复注入 + 一次清理仍能还原（幂等注入不破坏可还原性）', () => {
    const original = '头\n\n\n尾\n'
    let content: string | null = original
    for (let i = 0; i < 5; i++) {
      content = injectContextBlock(content, renderContextBlock(`第 ${i} 次`)).content
    }
    const removed = removeContextBlock(content!)
    assert.equal(removed.content, original)
  })

  test('没有块时不改动内容', () => {
    const original = '# 纯正文\n'
    const removed = removeContextBlock(original)
    assert.equal(removed.content, original)
    assert.equal(removed.deleteFile, false)
  })

  test('★ 清理后不留空文件——原本不存在就该删掉', () => {
    const injected = injectContextBlock(null, BLOCK)
    const removed = removeContextBlock(injected.content)
    assert.equal(removed.deleteFile, true)
    assert.equal(removed.content, '')
  })

  test('★ 使用者原本的空文件不得被当成"我们造的"删掉', () => {
    // 空文件 + 追加会得到「分隔符 + 块」，移除后也什么都不剩——
    // 但结构上块前面有分隔符，所以不能判为"我们创建的"
    const injected = injectContextBlock('', BLOCK)
    const removed = removeContextBlock(injected.content)
    assert.equal(removed.deleteFile, false, '原本存在的空文件必须留下')
    assert.equal(removed.content, '')
  })
})

describe('清理自己的区域 —— 原始内容已含标记时的正确行为', () => {
  /**
   * 这类输入**不可能**"还原成原样"——因为原样里就含着我们那一块，
   * 而清理的正确语义就是把它去掉。所以断言的是两条更弱但更重要的性质：
   * **块没了** 且 **块外的内容一字不动**。
   */
  test('已有完整块 ⇒ 去掉块，块外内容保留', () => {
    const removed = removeContextBlock(`头\n\n${BLOCK}\n尾`)
    assert.equal(removed.deleteFile, false)
    assert.equal(removed.content, '头\n尾')
    assert.equal(hasContextBlock(removed.content), false)
  })

  test('块在文件最开头 ⇒ 去掉块，后续内容保留（不删文件）', () => {
    const removed = removeContextBlock(`${BLOCK}\n后续内容`)
    assert.equal(removed.deleteFile, false, '后面还有内容，不能删文件')
    assert.equal(removed.content, '\n后续内容')
  })

  test('崩溃留下的半个块 ⇒ 去掉它，前面的内容保留', () => {
    const removed = removeContextBlock(`头\n${CONTEXT_BLOCK_BEGIN}\n写到一半`)
    assert.equal(removed.content, '头\n')
  })

  test('⭐ 已知限制：原始内容**内联**引用了两个标记时会被误判为块', () => {
    // 这是本算法无法区分的角落：形如 `提到 BEGIN 与 END 的说明`。
    // 缓解手段是标记本身足够独特（带 ALPHA-HELPER 与 do not edit）。
    // 这里把已知行为**钉住**，避免将来有人以为它能还原。
    const original = `说明：${CONTEXT_BLOCK_BEGIN} 与 ${CONTEXT_BLOCK_END} 是自动管理的`
    const injected = injectContextBlock(original, BLOCK)
    const removed = removeContextBlock(injected.content)
    assert.notEqual(removed.content, original, '这一输入不支持往返还原')
    assert.equal(hasContextBlock(removed.content), false)
  })
})

describe('hasContextBlock', () => {
  test('识别块的存在', () => {
    assert.equal(hasContextBlock(injectContextBlock('x', BLOCK).content), true)
    assert.equal(hasContextBlock('# 干净的文件'), false)
  })
})
