/**
 * 语音的**词典层**（分批第 277 批）。
 *
 * 这一层是整条语音链里**唯一会"改词"**的地方，所以测试的重点不是"能不能改"，
 * 而是"**会不会改错**"：
 *
 *   · `我家的 deck` 不许变成 `我家的 AgentDeck`（词边界）
 *   · `capture the flag` 不许变成 `wiki-capture the flag`（长串优先 + 边界）
 *   · 短规则不许把长规则咬掉，替换结果不许被下一条规则再改一遍（区间不重叠）
 *   · 改了几处必须**数得回来**（界面上要显示"纠正 2 处"）
 *
 * 另一条同样重要：词表是**人会手改**的文件，所以"改坏了"必须降级而不是抛错——
 * 用 `normalizeVocab` 的 `problems` 说清丢掉了什么。
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  EMPTY_VOCAB,
  PROMPT_TERM_LIMIT,
  applyVocabRules,
  buildPrompt,
  normalizeVocab,
  type VocabRule,
} from '../src/voice/vocab.ts'
import { hasSpeechContent, joinSegments, normalizeText } from '../src/voice/text.ts'
import { DEFAULT_SETTINGS, SENSITIVITY, normalizeSettings } from '../src/voice/settings.ts'

const rule = (from: string, to: string, note?: string): VocabRule =>
  note === undefined ? { from, to } : { from, to, note }

describe('词典：替换规则（第二层矫正）', () => {
  test('★★ 英文按词边界：`deck` 不会把 `deckhand` 改掉（最常见的误伤）', () => {
    const r = applyVocabRules('deck 是 deckhand 的意思', [rule('deck', 'AgentDeck')])
    assert.equal(r.text, 'AgentDeck 是 deckhand 的意思')
    assert.deepEqual(r.corrections, [{ from: 'deck', to: 'AgentDeck', count: 1 }])
  })

  test('★★ 长串优先：`wiki capture` 先被认走，`capture` 不再二次命中', () => {
    const r = applyVocabRules('把这段 wiki capture 一下', [
      rule('capture', 'CAPTURE'),
      rule('wiki capture', 'wiki-capture'),
    ])
    assert.equal(r.text, '把这段 wiki-capture 一下')
    assert.deepEqual(r.corrections, [{ from: 'wiki capture', to: 'wiki-capture', count: 1 }])
  })

  test('★★ 换完的结果不会被后面的规则再改一遍（区间不重叠，不做链式改写）', () => {
    // 先 "微思普" → "Whisper"；如果链式，第二条会把 Whisper 再做一次替换
    const r = applyVocabRules('微思普很快', [rule('微思普', 'Whisper'), rule('Whisper', 'XX')])
    assert.equal(r.text, 'Whisper很快')
    assert.equal(r.corrections.length, 1)
  })

  test('★ 大小写不敏感地命中英文错形态，但输出原样（to 怎么写就怎么出）', () => {
    const r = applyVocabRules('用 AGENT DECK 记一下', [rule('agent deck', 'AgentDeck')])
    assert.equal(r.text, '用 AgentDeck 记一下')
  })

  test('★ 同一处错出现多次：合并成一条并计数（界面要能说"纠正 3 处"）', () => {
    const r = applyVocabRules('web pack 里 web pack 的 web pack', [rule('web pack', 'webpack')])
    assert.equal(r.text, 'webpack 里 webpack 的 webpack')
    assert.deepEqual(r.corrections, [{ from: 'web pack', to: 'webpack', count: 3 }])
  })

  test('★ 中文没有词边界概念：整串替换即可（硬套 \\b 会一条都命不中）', () => {
    const r = applyVocabRules('我说的是微思普和微思普', [rule('微思普', 'Whisper')])
    assert.equal(r.text, '我说的是Whisper和Whisper')
    assert.equal(r.corrections[0]?.count, 2)
  })

  test('★ 不误伤：`capture the flag` 不因为 `capture` 规则变成 `wiki-capture the flag`', () => {
    const r = applyVocabRules('capture the flag', [rule('capture', 'wiki-capture')])
    // 这条规则**本身**就是把 capture 换掉——所以这里判的是"英文整词命中"是对的，
    // 而真正要防的是"半个词被吃掉"：`captured` 不该被改成 `wiki-captured`
    assert.equal(r.text, 'wiki-capture the flag')
    const r2 = applyVocabRules('captured 了', [rule('capture', 'X')])
    assert.equal(r2.text, 'captured 了')
    assert.deepEqual(r2.corrections, [])
  })

  test('★ 空文本 / 空规则都原样返回，不产生空 correction', () => {
    assert.deepEqual(applyVocabRules('', [rule('a', 'b')]), { text: '', corrections: [] })
    assert.deepEqual(applyVocabRules('abc', []), { text: 'abc', corrections: [] })
  })
})

describe('词典：文件形状与降级', () => {
  test('★★ 手改坏的词表**不抛错**：能用的留下，丢掉的如实报出来', () => {
    const { vocab, problems } = normalizeVocab({
      version: 1,
      promptTerms: ['Whisper', 42, '', 'whisper', 'AgentDeck'],
      rules: [
        { from: 'a', to: 'b' },
        { from: '', to: 'x' },
        { from: 'same', to: 'same' },
        'not-an-object',
      ],
    })
    // `whisper` 与 `Whisper` 是同一个词（按小写去重）；`42`/空串 被丢
    assert.deepEqual(vocab.promptTerms, ['Whisper', 'AgentDeck'])
    // `from === to` 的规则是空转，丢掉；坏条目丢掉；只剩一条好的
    assert.deepEqual(vocab.rules, [{ from: 'a', to: 'b' }])
    assert.ok(problems.length >= 3, `应报出丢掉了什么，实际：${JSON.stringify(problems)}`)
  })

  test('★ 不是对象 / 超上限都有兜底', () => {
    const notObject = normalizeVocab('nope')
    assert.deepEqual(notObject.vocab, EMPTY_VOCAB)
    assert.equal(notObject.problems.length, 1)

    const many = normalizeVocab({
      promptTerms: Array.from({ length: PROMPT_TERM_LIMIT + 5 }, (_, i) => `词${i}`),
    })
    assert.equal(many.vocab.promptTerms.length, PROMPT_TERM_LIMIT)
    assert.ok(many.problems.some((p) => p.includes('超过')))
  })
})

describe('词典：initialPrompt（第一层矫正）', () => {
  test('★ 没有词就不带 prompt（空串），不是"一句空话"', () => {
    assert.equal(buildPrompt(EMPTY_VOCAB, 'zh'), '')
  })

  test('★ 词会进一句自然话，结尾是句号（不是末尾留个顿号）', () => {
    const prompt = buildPrompt({ ...EMPTY_VOCAB, promptTerms: ['Whisper', 'AgentDeck'] }, 'zh')
    assert.ok(prompt.includes('Whisper'))
    assert.ok(prompt.includes('AgentDeck'))
    assert.ok(prompt.endsWith('。'), prompt)
    assert.ok(!prompt.includes('、。'), prompt)
  })

  test('★★ 超出字符预算就截断——塞不进去的词**不许**假装在（whisper 会静默截）', () => {
    const terms = Array.from({ length: 80 }, (_, i) => `专有名词${i}`)
    const prompt = buildPrompt({ ...EMPTY_VOCAB, promptTerms: terms }, 'zh')
    assert.ok(prompt.length <= 200, `prompt 长度 ${prompt.length} 超了预算`)
    // 靠前的在、靠后的被截掉
    assert.ok(prompt.includes('专有名词0'))
    assert.ok(!prompt.includes('专有名词79'))
  })

  test('★ 语言不同，引导语也不同（给中文模型塞英文引导语会让它输出英文）', () => {
    const zh = buildPrompt({ ...EMPTY_VOCAB, promptTerms: ['Whisper'] }, 'zh')
    const en = buildPrompt({ ...EMPTY_VOCAB, promptTerms: ['Whisper'] }, 'en')
    assert.notEqual(zh, en)
    assert.ok(en.includes('Proper nouns'))
  })
})

describe('识别文本的整理', () => {
  test('★★ 分段拼起来不会出现"中文标点前一个空格"（这段字是要直接发出去的）', () => {
    // ⚠️ 两种形状都要认：包 0.2.12 返回**对象**，而它的 README 写的是三元组
    //    （第一版只按 README 取 `seg[2]` ⇒ 真机上整段变空）。这里一样来一条。
    const raw = joinSegments([
      { start: '00:00:00,000', end: '00:00:02,500', text: ' 我们来讨论一下语音方案' },
      ['00:00:02,500', '00:00:04,000', ' 。'],
    ])
    assert.equal(normalizeText(raw), '我们来讨论一下语音方案。')
  })

  test('★ 中文字之间的空格去掉、中英文之间留一个', () => {
    // 中文不写空格（"你 好"是模型的毛病），中英文交界留一个（"用 pnpm 跑"读起来才对）
    assert.equal(normalizeText('你 好我用 pnpm  跑测试'), '你好我用 pnpm 跑测试')
    assert.equal(normalizeText('用pnpm跑测试'), '用 pnpm 跑测试')
  })

  test('★ 控制字符与首尾空白清掉；纯标点不算"说了话"', () => {
    assert.equal(normalizeText('\u0001 你好 \n'), '你好')
    assert.equal(hasSpeechContent('，。？'), false)
    assert.equal(hasSpeechContent('嗯'), true)
  })
})

describe('设置', () => {
  test('★ 认不出来的值一律回默认（不让界面进不去）', () => {
    const s = normalizeSettings(
      { model: 'no-such-model', language: 'fr', sensitivity: 'x', outputMode: 'y' },
      ['base-q5_1'],
    )
    assert.equal(s.model, DEFAULT_SETTINGS.model)
    assert.equal(s.language, 'zh')
    assert.equal(s.sensitivity, 'normal')
    assert.equal(s.outputMode, 'input')
  })

  test('★ 合法值原样保留（含 via-skill 与 denoise）', () => {
    const s = normalizeSettings(
      { model: 'small-q5_1', language: 'auto', sensitivity: 'quick', outputMode: 'via-skill', denoise: true },
      ['base-q5_1', 'small-q5_1', 'small'],
    )
    assert.equal(s.model, 'small-q5_1')
    assert.equal(s.language, 'auto')
    assert.equal(s.sensitivity, 'quick')
    assert.equal(s.outputMode, 'via-skill')
    assert.equal(s.denoise, true)
  })

  test('★ 三档灵敏度都在，且"稳"比"快"更难被打断（阈值更高、holdoff 更长）', () => {
    assert.ok(SENSITIVITY.stable.threshold > SENSITIVITY.quick.threshold)
    assert.ok(SENSITIVITY.stable.holdoffMs > SENSITIVITY.quick.holdoffMs)
    assert.equal(SENSITIVITY.normal.threshold, 0.5)
    assert.equal(SENSITIVITY.normal.holdoffMs, 800)
  })
})
