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

/*
 * ⚠️ 2026-11（D125）：这里原来是「围栏标记不许与协议分叉」——前端不 import protocol，
 *   所以那对标记是抄的一份，这条测试读**协议源码**把它们对上，协议改名时当场变红。
 *
 *   **判决围栏不再由平台产生**（`packages/protocol/src/verdict.ts` 整份删了）⇒
 *   没有"对齐"这回事，测试删。
 *
 *   ⚠️ 而 `stripVerdictBlocks` 自己**留着**：老记录的正文里还留着那对标记，界面上
 *   人看的地方不该摊出机器契约。它上面的用例仍在守"剥干净、不留空行"。
 */

