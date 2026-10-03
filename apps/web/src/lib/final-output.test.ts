import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  VERDICT_FENCE_BEGIN,
  VERDICT_FENCE_END,
  finalResultText,
  stripVerdictBlocks,
} from './final-output.ts'

const wrap = (json: string) => `${VERDICT_FENCE_BEGIN}\n${json}\n${VERDICT_FENCE_END}`

describe('最后结果：判决块不该摊在人读的正文里', () => {
  test('★ 解释文字 + 判决块 ⇒ 只剩解释文字（使用者报的就是这个）', () => {
    const text = `我看了一遍产出，结论是可以通过。\n\n${wrap('{"conclusion":"pass"}')}`
    assert.equal(stripVerdictBlocks(text), '我看了一遍产出，结论是可以通过。')
  })

  test('判决块夹在中间 ⇒ 两边的解释都留下', () => {
    const text = `前面这段是解释。\n\n${wrap('{"a":1}')}\n\n后面还有一句。`
    assert.equal(stripVerdictBlocks(text), '前面这段是解释。\n\n后面还有一句。')
  })

  test('★ 整个输出只有判决块 ⇒ 空串（调用方据此说一句准确的话，而不是显示空框）', () => {
    assert.equal(stripVerdictBlocks(wrap('{"conclusion":"pass"}')), '')
    assert.equal(stripVerdictBlocks(`\n\n${wrap('{"a":1}')}\n\n`), '')
  })

  test('回显的示例 + 自己的判决 ⇒ 两块都剥掉（协议取最后一个当判决，那个必在其中）', () => {
    const text = `按格式要求：\n${wrap('{"example":true}')}\n我的判决：\n${wrap('{"real":true}')}\n以上。`
    const out = stripVerdictBlocks(text)
    assert.equal(out.includes(VERDICT_FENCE_BEGIN), false)
    assert.equal(out.includes('example'), false)
    assert.equal(out.includes('real'), false)
    assert.match(out, /按格式要求/)
    assert.match(out, /以上。/)
  })

  test('结尾也写成了 BEGIN（真实踩过两次）⇒ 一样剥干净', () => {
    const text = `我说完了。\n${VERDICT_FENCE_BEGIN}\n{"a":1}\n${VERDICT_FENCE_BEGIN}`
    assert.equal(stripVerdictBlocks(text), '我说完了。')
  })

  test('★ 半开的块（有 BEGIN 无 END）⇒ 原样留着：那意味着判决没被接受，原文是唯一的证据', () => {
    const text = `我试着给判决：\n${VERDICT_FENCE_BEGIN}\n{"conclusion":"pass"}`
    assert.equal(stripVerdictBlocks(text), text)
  })

  test('孤立的 END 标记不参与切分（只在 BEGIN 之后找结束）', () => {
    const text = `文档里提到 ${VERDICT_FENCE_END} 这个标记。\n${wrap('{"a":1}')}`
    const out = stripVerdictBlocks(text)
    assert.match(out, /文档里提到/)
    assert.equal(out.includes('{"a":1}'), false)
  })

  test('没有块 ⇒ 一个字符都不动（执行 run 的报告、聊天那些话）', () => {
    const plain = '# 报告\n\n我把索引重建了一遍。\n\n- 改了 3 个文件\n'
    assert.equal(stripVerdictBlocks(plain), plain)
  })

  test('剥完之后不留一堆空行，首尾也收干净', () => {
    const text = `  开头  \n\n\n${wrap('{"a":1}')}\n\n\n`
    assert.equal(stripVerdictBlocks(text), '开头')
  })
})

describe('「最后结果」显示哪段文字（策略）', () => {
  test('有落库判决 ⇒ 剥掉判决块，只留解释文字', () => {
    const text = `我看了一遍，可以通过。\n\n${wrap('{"conclusion":"pass"}')}`
    assert.equal(finalResultText(text, true), '我看了一遍，可以通过。')
  })

  test('★ 没有判决记录 ⇒ 原样显示，连标记都不动（那段原文是唯一的证据）', () => {
    const text = `我试着给判决：\n${VERDICT_FENCE_BEGIN}\n{"conclusion":"pass"}`
    assert.equal(finalResultText(text, false), text)
  })

  test('没有文字产出时是空串（调用方据此画空态，不是拿判决块当产出）', () => {
    assert.equal(finalResultText('', true), '')
    assert.equal(finalResultText('', false), '')
  })

  test('有判决、但正文里本来就没有块 ⇒ 一个字符都不动', () => {
    const plain = '执行报告：改了 3 个文件。'
    assert.equal(finalResultText(plain, true), plain)
  })
})

describe('围栏标记不许与协议分叉', () => {
  /**
   * ★ 与 `chat.test.ts` 里"终态那一列读协议源码"同一个做法。
   *
   * 前端不 import protocol（`api.ts` 顶部写着理由），所以这对标记在这边是抄的。
   * 抄的东西会腐烂——协议改了名，这边不报错，只是**判决块再也剥不掉**（界面
   * 又回到"显示 `<<<ALPHA_VERDICT>>>`"的样子，而且没有任何报错）。这条测试读
   * **协议源码**把它们对上，腐烂当场变红。
   */
  test('这两个标记与 `packages/protocol/src/verdict.ts` 里的逐字相同', () => {
    const path = fileURLToPath(
      new URL('../../../../packages/protocol/src/verdict.ts', import.meta.url),
    )
    const source = readFileSync(path, 'utf8')
    const begin = /VERDICT_FENCE_BEGIN = '([^']+)'/.exec(source)?.[1]
    const end = /VERDICT_FENCE_END = '([^']+)'/.exec(source)?.[1]
    assert.ok(begin, `没能从 ${path} 里抠出 BEGIN 标记，检查那条正则`)
    assert.ok(end, `没能从 ${path} 里抠出 END 标记，检查那条正则`)
    assert.equal(VERDICT_FENCE_BEGIN, begin)
    assert.equal(VERDICT_FENCE_END, end)
  })
})
