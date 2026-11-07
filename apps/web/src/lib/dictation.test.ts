/**
 * 词典规则的**建议器**（分批第 280 批）。
 *
 * 这一层只做一件事：从"人手动改过的那一小段"里猜一条规则。测试的重点是**它什么时候
 * 必须闭嘴**——一条错的规则会污染之后所有识别，而它看起来像"模型学会了"。
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { suggestRule, suggestionWorthAsking } from './dictation.ts'

describe('从手改差异里提规则', () => {
  test('★★ 只改了一个词 ⇒ 提一条（这正是要抓的那种错）', () => {
    assert.deepEqual(suggestRule('我们用微思普识别', '我们用Whisper识别'), {
      from: '微思普',
      to: 'Whisper',
    })
  })

  test('★★ 英文被拆成两个词 ⇒ 也能提（"agent deck" → "AgentDeck"）', () => {
    const got = suggestRule('打开 agent deck 看看', '打开 AgentDeck 看看')
    assert.deepEqual(got, { from: 'agent deck', to: 'AgentDeck' })
  })

  test('★★ 改动跨标点 / 空白 ⇒ 不提（那是句子级改写，不是听错一个词）', () => {
    assert.equal(suggestRule('先用这个，再用那个。', '先别用那个，直接用这个。'), null)
  })

  test('★★ 一边是另一边的一部分 ⇒ 不提（更像多打/少打了几个字）', () => {
    assert.equal(suggestRule('调用接口', '调用接口了'), null)
  })

  test('★ 太长 ⇒ 不提（长串规则会命中别处的正常文字）', () => {
    const long = '一二三四五六七八九十一二三四五六七八九十一二三四五'
    assert.equal(suggestRule(long, '短'), null)
  })

  test('★ 没改 / 空了 / 只改了空白 ⇒ 都不提', () => {
    assert.equal(suggestRule('同一句', '同一句'), null)
    assert.equal(suggestRule('', '有字'), null)
    assert.equal(suggestRule('有字', ''), null)
    assert.equal(suggestRule('前面一样 后面', '前面一样 后面 '), null)
  })

  test('★ 建议器本身不做判断（`suggestionWorthAsking` 只挡 null）', () => {
    assert.equal(suggestionWorthAsking(null), false)
    assert.equal(suggestionWorthAsking({ from: 'a', to: 'b' }), true)
  })
})
