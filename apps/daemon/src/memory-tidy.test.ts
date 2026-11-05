/**
 * 「整理成记忆」的分析层（分批第 243 批）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这一层要守住的三件事
 * ══════════════════════════════════════════════════════════════════
 *
 * ① **分析的是整段对话**（人说的 + 它回的）——第一版只列人说过的话，于是 agent
 *    自己说过的判断（"这个仓库用 pnpm"）根本不在候选里，而那恰恰最该记。
 * ② **解析要容错，但不能瞎猜**：模型加围栏、带前言、一行一个对象都要收；
 *    而类型不认识、正文太长、看起来像密钥的**一律剔掉**（剔掉要在界面上说出来）。
 * ③ **"没挑出东西"与"没看懂它说什么"不是一回事**：前者是对话没内容，后者是格式
 *    坏了。混成一个"0 条"会让人以为这段对话没什么可记的。
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  TIDY_MAX_CANDIDATES,
  TIDY_TRANSCRIPT_MAX_CHARS,
  buildTidyPrompt,
  parseTidyOutput,
  renderTidyTranscript,
} from './memory-tidy.ts'

describe('对话正文：整段、按轮、人说的与它回的都在', () => {
  test('★ 每一轮都有人那一句与它那一句，轮次带序号', () => {
    const out = renderTidyTranscript({
      title: '周报这事',
      agentName: '小七',
      turns: [
        { seq: 1, userText: '帮我写周报', output: '好，先给我这周做了什么' },
        { seq: 2, userText: '这个仓库用 pnpm，别用 npm', output: '记住了' },
      ],
    })
    assert.match(out.text, /# 对话：周报这事/)
    assert.match(out.text, /## 第 1 轮/)
    assert.match(out.text, /## 第 2 轮/)
    assert.match(out.text, /这个仓库用 pnpm，别用 npm/)
    // ★ agent 说过的话也在——第一版漏的正是这一半
    assert.match(out.text, /好，先给我这周做了什么/)
    assert.equal(out.skipped, 0)
  })

  test('★ 它没产出文字的那一轮要明说，不是留空白（空白会被当成"它什么都没说"）', () => {
    const out = renderTidyTranscript({
      title: 't',
      agentName: 'a',
      turns: [{ seq: 1, userText: '在吗', output: null }],
    })
    assert.match(out.text, /（这一轮没有文字产出）/)
  })

  test('★★ 太长的对话按**留最近**截断，并且把截掉了多少写出来', () => {
    const turns = []
    for (let i = 1; i <= 60; i += 1) {
      turns.push({ seq: i, userText: `人的第 ${String(i)} 轮：${'x'.repeat(800)}`, output: null })
    }
    const out = renderTidyTranscript({ title: '长对话', agentName: 'a', turns })
    assert.ok(out.text.length <= TIDY_TRANSCRIPT_MAX_CHARS + 400, `长度 ${String(out.text.length)}`)
    assert.ok(out.skipped > 0, '应该报了截断')
    assert.match(out.text, /这段对话太长/)
    // 第一轮保住（"这段对话是干什么的"），最近一轮也在
    assert.match(out.text, /## 第 1 轮/)
    assert.match(out.text, /## 第 60 轮/)
  })
})

describe('分析任务：平台写的那段话', () => {
  test('★ 说清了四类含义、上限、以及"只输出 JSON 数组"', () => {
    const prompt = buildTidyPrompt()
    for (const kind of ['preference', 'fact', 'lesson', 'commitment']) {
      assert.ok(prompt.includes(kind), `要提到 ${kind}`)
    }
    assert.match(prompt, /最多 12 条/)
    assert.match(prompt, /只输出一个 JSON 数组/)
    assert.match(prompt, /transcript\.md/)
    // 凭据那条必须写进去（这段正文会进记忆、每轮发给 CLI）
    assert.match(prompt, /凭据|token|密钥/)
  })
})

describe('解析它的输出：容错但不瞎猜', () => {
  test('★ 干净数组', () => {
    const out = parseTidyOutput(
      '[{"kind":"fact","text":"这个仓库用 pnpm"},{"kind":"preference","text":"说话短一点"}]',
    )
    assert.equal(out.parsed, true)
    assert.deepEqual(
      out.candidates.map((c) => c.text),
      ['这个仓库用 pnpm', '说话短一点'],
    )
  })

  test('★★ 围栏 + 前后废话：仍然解得出来（模型十次有九次会加）', () => {
    const out = parseTidyOutput(
      '好的，我读了这段对话，挑出这些：\n```json\n[{"kind":"lesson","text":"别直接改 dist"}]\n```\n希望有用。',
    )
    assert.equal(out.parsed, true)
    assert.deepEqual(out.candidates, [{ kind: 'lesson', text: '别直接改 dist' }])
  })

  test('★★ 一行一个对象（没有外层数组）也收', () => {
    const out = parseTidyOutput(
      '{"kind":"fact","text":"测试用 pnpm test"}\n{"kind":"commitment","text":"报告里不出现赋能"}',
    )
    assert.equal(out.parsed, true)
    assert.equal(out.candidates.length, 2)
  })

  test('★ `[]` = 真的没挑出东西（parsed 仍为 true）', () => {
    const out = parseTidyOutput('[]')
    assert.equal(out.parsed, true)
    assert.deepEqual(out.candidates, [])
  })

  test('★★★ 完全没按格式（一句人话）⇒ parsed = false——不能伪装成"0 条"', () => {
    const out = parseTidyOutput('这段对话里没什么值得记的，我就直接聊了。')
    assert.equal(out.parsed, false)
    assert.deepEqual(out.candidates, [])
  })

  test('★ 类型不认识 ⇒ 剔掉并报出来，不猜成 fact', () => {
    const out = parseTidyOutput('[{"kind":"opinion","text":"我觉得还行"}]')
    assert.equal(out.candidates.length, 0)
    assert.equal(out.dropped[0]?.reason, 'kind_invalid')
  })

  test('★ 正文太长 ⇒ 剔掉（记忆单条上限是 400 字）', () => {
    const out = parseTidyOutput(`[{"kind":"fact","text":"${'x'.repeat(500)}"}]`)
    assert.equal(out.candidates.length, 0)
    assert.equal(out.dropped[0]?.reason, 'text_too_long')
  })

  test('★★ 看起来像密钥 ⇒ 剔掉（记忆每轮都会发给 CLI）', () => {
    const out = parseTidyOutput(
      '[{"kind":"fact","text":"部署用 sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGG"},' +
        '{"kind":"fact","text":"部署用 $DEPLOY_KEY 这个变量"}]',
    )
    assert.equal(out.candidates.length, 1, '只有变量名那条留下')
    assert.match(out.candidates[0]!.text, /DEPLOY_KEY/)
    assert.equal(out.dropped[0]?.reason, 'looks_like_secret')
  })

  test('★ 同一句话出现两次 ⇒ 只留一条（重复只会挤掉别的）', () => {
    const out = parseTidyOutput(
      '[{"kind":"fact","text":"用 pnpm"},{"kind":"lesson","text":"用  pnpm"}]',
    )
    assert.equal(out.candidates.length, 1)
  })

  test('★ 最多收 12 条，多出来的如实报', () => {
    const items = Array.from({ length: TIDY_MAX_CANDIDATES + 3 }, (_, i) => ({
      kind: 'fact',
      text: `第 ${String(i)} 条`,
    }))
    const out = parseTidyOutput(JSON.stringify(items))
    assert.equal(out.candidates.length, TIDY_MAX_CANDIDATES)
    assert.equal(out.dropped.filter((d) => d.reason === 'too_many').length, 3)
  })
})
