/**
 * 对话里抽词（分批第 286 批）。
 *
 * 这一层的判据只有两类，但两类都必须钉死：
 *   ① **该抽的抽出来**（标识符的正字法：camelCase / 带分隔符 / 缩写）；
 *   ② **不该抽的一个都不许进**（通用小写词、纯数字、hash、中文）——因为它们进
 *      `initialPrompt` 不是"少帮一点"，而是**会把正常的话听坏**（实测：加了杂词之后
 *      `我下午把` 被听成 `我下无法规及`）。
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  AGENT_TERM_LIMIT,
  CONTEXT_MESSAGE_LIMIT,
  CONTEXT_TERM_LIMIT,
  extractContextTerms,
} from '../src/voice/context-terms.ts'
import { buildPrompt, PROMPT_CHAR_BUDGET } from '../src/voice/vocab.ts'

describe('抽词：该抽的', () => {
  test('★★ 一段真实感的对话 ⇒ 抽出标识符（含 camelCase / 带分隔符 / 缩写 / 版本号）', () => {
    const terms = extractContextTerms([
      '我把 wiki-capture 那条链路调通了，distilly 技能也重装了一遍',
      '再确认下 whisper.cpp 的 VAD 那一段，我担心 base 模型不够准',
      '现在跑的是 base-q5_1，要不要换 small-q5_1',
      'AgentDeck 这边 openConversation 的入口也检查过了',
      // ⚠️ `distilly` 是**全小写自造词**：按 287 批的规则，用户说过 ≥2 次才算
      'distilly 那个目录我还是没找到',
    ])
    for (const want of [
      'wiki-capture',
      'distilly',
      'whisper.cpp',
      'VAD',
      'base-q5_1',
      'small-q5_1',
      'AgentDeck',
      'openConversation',
    ]) {
      assert.ok(terms.includes(want), `应该抽到「${want}」，实际：${JSON.stringify(terms)}`)
    }
  })

  test('★ 大小写去重：`agentdeck` 与 `AgentDeck` 只留一个，且留**带大写**的写法', () => {
    const terms = extractContextTerms(['先跑 agentdeck', '再跑 AgentDeck'])
    assert.equal(terms.filter((t) => t.toLowerCase() === 'agentdeck').length, 1)
    assert.equal(terms.find((t) => t.toLowerCase() === 'agentdeck'), 'AgentDeck')
  })

  test('★ 取多少条消息的素材有上限（再往前翻没有收益，预算本来就紧）', () => {
    const many = Array.from({ length: CONTEXT_MESSAGE_LIMIT + 10 }, (_, i) => `第${i}条提到 FooBar${i}`)
    const terms = extractContextTerms(many)
    // 前 10 条被裁掉（只取最后 20 条）
    assert.ok(!terms.includes('FooBar0'), JSON.stringify(terms))
    assert.ok(terms.some((t) => t.startsWith('FooBar')), JSON.stringify(terms))
  })

  test(`★ 最多 ${CONTEXT_TERM_LIMIT} 个词（prompt 预算就那么多）`, () => {
    const text = Array.from({ length: 40 }, (_, i) => `Token${i}Name`).join(' ')
    assert.ok(extractContextTerms([text]).length <= CONTEXT_TERM_LIMIT)
  })
})

describe('抽词：两个来源，两套门槛（287 批）', () => {
  test('★★ 全小写自造词：用户只说 1 次**不算**，说 2 次才算（只有人会打错字）', () => {
    // 用户说一次 ⇒ 不收（可能是 `samll` 这种笔误）
    assert.deepEqual(extractContextTerms(['我们用了 distilly 一次']), [])
    // 用户说两次 ⇒ 收（同一个词在两句话里都用过 = 它是真词）
    assert.deepEqual(extractContextTerms(['distilly 装好了', 'distilly 是内置那条']), ['distilly'])
  })

  test('★★ 模型回复只补**强形状**的词；全小写自造词与路径 / 引用 / 文件名一律不收', () => {
    // 强形状（驼峰 / 带分隔符 / 缩写）⇒ 收
    assert.deepEqual(extractContextTerms({ userTexts: [], agentTexts: ['用的是 AgentDeck 与 ARC'] }), [
      'AgentDeck',
      'ARC',
    ])
    // 全小写自造词（模型说了也不算——它不是"会打错字"，而是"这段字不会被说出口"）
    assert.deepEqual(extractContextTerms({ userTexts: [], agentTexts: ['挂载了 distilly'] }), [])
    // 路径 / 引用 / 文件名 ⇒ 不收（实测真实对话里这些会把 prompt 灌满）
    assert.deepEqual(
      extractContextTerms({
        userTexts: [],
        agentTexts: ['见 doc/image/obsidian-wiki-memory-flow.svg 与 arXiv:2610.11794 还有 memento3-ste-article.md'],
      }),
      [],
    )
  })

  test(`★★ 模型来源最多补 ${AGENT_TERM_LIMIT} 个；你占了大半名额时它就更少`, () => {
    // 你什么都不说 ⇒ 模型可以补到上限
    const onlyAgent = extractContextTerms({
      userTexts: [],
      agentTexts: ['Alpha One, Beta Two, Gamma Three, Delta Four, Epsilon Five, Zeta Six, Eta Seven'],
    })
    assert.equal(onlyAgent.length, AGENT_TERM_LIMIT, JSON.stringify(onlyAgent))

    // 你已经占了 12 个名额 ⇒ 模型一个都进不来
    const userFull = Array.from({ length: 12 }, (_, i) => `UserTerm${i}Name`)
    const none = extractContextTerms({
      userTexts: [userFull.join(' ')],
      agentTexts: ['AgentAlpha AgentBeta'],
    })
    assert.equal(none.length, 12)
    assert.ok(!none.some((t) => t.startsWith('Agent')), JSON.stringify(none))
  })

  test('★★ 模型回复里的**普通英文词**不收（否则英文散文会灌满 prompt）', () => {
    assert.deepEqual(
      extractContextTerms({
        userTexts: [],
        agentTexts: ['The prize goes to Pong, and prize money is fine. Prize!'],
      }),
      [],
    )
  })

  test('★★ URL 只取**最后一段路径**（整条 URL 进 prompt 毫无用处）', () => {
    assert.deepEqual(
      extractContextTerms(['你看看 https://github.com/ar9av/obsidian-wiki 这个']),
      ['obsidian-wiki'],
    )
  })

  test('★ 表达式形态（`N=1`）不当词收', () => {
    assert.deepEqual(extractContextTerms({ userTexts: [], agentTexts: ['样本 N=1，x<3'] }), [])
  })

  test('★ 用户说过的词排在模型说过的词前面（要识别的是你的嘴）', () => {
    const terms = extractContextTerms({
      userTexts: ['Memento 那篇论文'],
      agentTexts: ['Memento 的 arXiv 版本，还有 ARC Prize 与 LaTeX 模板'],
    })
    const idxUser = terms.indexOf('Memento')
    const idxAgentOnly = terms.indexOf('LaTeX')
    assert.ok(idxUser >= 0 && idxAgentOnly >= 0, JSON.stringify(terms))
    assert.ok(idxUser < idxAgentOnly, `用户提过的词应更靠前：${JSON.stringify(terms)}`)
  })
})

describe('抽词：不该抽的', () => {
  test('★★ 只有通用小写词的对话 ⇒ **一个词都不抽**（这条是安全底线）', () => {
    const terms = extractContextTerms([
      '这个 model 的 test 通过了，commit 一下',
      'the api url is fine, run it again',
      '把 log 和 id 也带上',
    ])
    assert.deepEqual(terms, [])
  })

  test('★★ 纯中文不抽（没有分词器时最容易误伤）', () => {
    assert.deepEqual(extractContextTerms(['这个仓库的语音方案还行，麦克风权限也有了']), [])
  })

  test('★ 纯数字 / 长 hash / 过短过长的一律不抽', () => {
    const terms = extractContextTerms([
      '20261107 和 3f9a8b7c6d5e4f3a2b1c 这两个',
      'ab 与 一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一',
    ])
    assert.deepEqual(terms, [])
  })

  test('★ 通用小写词出现两次才算候选（`model` 两次仍不该进 prompt 吗？）', () => {
    // 这是有意的取舍：`model` 这类词即便出现两次，进 prompt 的收益也远小于"把普通话说成术语"的风险
    const terms = extractContextTerms(['model 换了', 'model 又换了'])
    assert.deepEqual(terms, [])
  })
})

describe('拼进 prompt：手动词优先', () => {
  test('★★ 手动词占满预算时，自动词**一个都进不去**（不许挤掉我自己加的词）', () => {
    const manual = Array.from({ length: 40 }, (_, i) => `手动词${i}`)
    const prompt = buildPrompt({ version: 1, promptTerms: manual, rules: [] }, 'zh', ['AutoTerm', 'AnotherTerm'])
    assert.ok(!prompt.includes('AutoTerm'), prompt)
    assert.ok(prompt.length <= PROMPT_CHAR_BUDGET + 40, `${prompt.length}`)
  })

  test('★ 手动词 + 自动词排在后面，重复的自动词跳过', () => {
    const prompt = buildPrompt({ version: 1, promptTerms: ['Whisper'], rules: [] }, 'zh', [
      'agentdeck',
      'AgentDeck',
      'Whisper',
    ])
    assert.ok(prompt.includes('Whisper'))
    // `Whisper` 手动已经有了 ⇒ 自动那边跳过一次；`agentdeck` 与 `AgentDeck` 只留一个
    assert.equal(prompt.toLowerCase().split('whisper').length - 1, 1, prompt)
    assert.equal(prompt.toLowerCase().split('agentdeck').length - 1, 1, prompt)
  })

  test('★ 没有手动词、只有自动词 ⇒ 也能拼出 prompt（不是空串）', () => {
    const prompt = buildPrompt({ version: 1, promptTerms: [], rules: [] }, 'zh', ['distilly'])
    assert.ok(prompt.includes('distilly'), prompt)
    assert.ok(prompt.startsWith('以下是关于这个项目的口述笔记'), prompt)
  })

  test('★ 两边都空 ⇒ 空串（不塞一句没有内容的引导语）', () => {
    assert.equal(buildPrompt({ version: 1, promptTerms: [], rules: [] }, 'zh', []), '')
  })
})
