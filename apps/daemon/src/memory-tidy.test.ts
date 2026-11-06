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
  renderExistingMemory,
  renderTidyTranscript,
} from './memory-tidy.ts'
import type { MemoryEntry, MemoryKind } from '@agentdeck/protocol'
import { MEMORY_TIDY_INSTRUCTIONS } from './builtin-drafter.ts'

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

describe('规矩住在智能体的身份里（分批第 244 批）', () => {
  test('★★ 四类含义、上限、"只输出 JSON 数组"、凭据禁令都在身份里（可在智能体页查看）', () => {
    for (const kind of ['preference', 'fact', 'lesson', 'commitment']) {
      assert.ok(MEMORY_TIDY_INSTRUCTIONS.includes(kind), `身份里要提到 ${kind}`)
    }
    assert.match(MEMORY_TIDY_INSTRUCTIONS, /最多 12 条/)
    assert.match(MEMORY_TIDY_INSTRUCTIONS, /JSON 数组/)
    assert.match(MEMORY_TIDY_INSTRUCTIONS, /凭据|token|密钥/)
    // ★ 使用者当场指出的那条（"我只说了一句话，理论上不该提取到记忆"）
    assert.match(MEMORY_TIDY_INSTRUCTIONS, /只派活或提问时输出/)
    assert.match(MEMORY_TIDY_INSTRUCTIONS, /它自己查到的/)
  })

  test('★★★ 要求「泛化」：记的是它以后怎么做，不是这次的对象是什么（分批第 248 批）', () => {
    /**
     * 使用者打回来的真实产出：「不要把 Distilly 比喻成编译器，这类比喻会让人困惑」——
     * 那段对话是**调研 Distilly**，这条只在"又聊到 Distilly"时成立，等于把调研对象
     * 写成了经验，还挤掉了通用条目。
     *
     * 所以身份里必须钉住这条：换成另一个对象也成立才算记忆，自检就是"删掉对象名"。
     * ⚠️ 这是**判据**不是文案：有人把这节删掉（觉得"太长/太多规矩"），这里当场红。
     */
    assert.match(MEMORY_TIDY_INSTRUCTIONS, /要泛化/)
    assert.match(MEMORY_TIDY_INSTRUCTIONS, /把这次的对象名从句子里删掉/)
    assert.match(MEMORY_TIDY_INSTRUCTIONS, /调研出来的东西是\*\*这次的产出\*\*/)
    // ★ 反面：抽象不等于编造（否则下一个毛病是"它替人发明原则"）
    assert.match(MEMORY_TIDY_INSTRUCTIONS, /抽象不等于编造/)
    assert.match(MEMORY_TIDY_INSTRUCTIONS, /直接摘原话/)
  })

  test('★ 任务书只留这一轮特有的话（读哪份文件、输出形状）——不重复规矩', () => {
    const prompt = buildTidyPrompt()
    assert.match(prompt, /transcript\.md/)
    assert.match(prompt, /只输出一个 JSON 数组/)
    // 不该把"四类是什么"再抄一遍（两处维护必然漂）
    assert.doesNotMatch(prompt, /preference/)
    assert.match(prompt, /身份里那套规矩/)
  })
})

describe('解析它的输出：容错但不瞎猜', () => {
  /** 这段对话里人说过的话（核对出处用）。 */
  const HUMAN = ['这个仓库用 pnpm，别用 npm', '报告里不许出现赋能这类词']
  test('★ 干净数组', () => {
    const out = parseTidyOutput(
      '[{"kind":"fact","text":"这个仓库用 pnpm","from":"这个仓库用 pnpm，别用 npm"},' +
        '{"kind":"preference","text":"报告里别出现赋能","from":"报告里不许出现赋能这类词"}]',
      HUMAN,
    )
    assert.equal(out.parsed, true)
    assert.deepEqual(
      out.candidates.map((c) => c.text),
      ['这个仓库用 pnpm', '报告里别出现赋能'],
    )
    assert.equal(out.candidates[0]?.grounded, true, '出处能在人的话里找到')
  })

  test('★★★ 出处对不上（它自己编的）⇒ 仍然列出来，但标成 grounded=false', () => {
    const out = parseTidyOutput(
      '[{"kind":"fact","text":"distilly 用 python 写","from":"我说过 distilly 用 python"}]',
      HUMAN,
    )
    assert.equal(out.candidates.length, 1, '不删——决定权在人')
    assert.equal(out.candidates[0]?.grounded, false)
    assert.equal(out.candidates[0]?.from, '我说过 distilly 用 python')
  })

  test('★★ 完全没给 from ⇒ grounded=false（它自己查到的）', () => {
    const out = parseTidyOutput('[{"kind":"fact","text":"这个仓库用 pnpm"}]', HUMAN)
    assert.equal(out.candidates[0]?.from, null)
    assert.equal(out.candidates[0]?.grounded, false)
  })

  test('★ 出处带换行/多空格也算对上（空白归一）', () => {
    const out = parseTidyOutput(
      '[{"kind":"fact","text":"用 pnpm","from":"这个仓库用   pnpm"}]',
      ['这个仓库用\npnpm，别用 npm'],
    )
    assert.equal(out.candidates[0]?.grounded, true)
  })

  test('★ 没给人话（空数组）⇒ 一律对不上，不抛错', () => {
    const out = parseTidyOutput('[{"kind":"fact","text":"x","from":"y"}]')
    assert.equal(out.candidates[0]?.grounded, false)
  })

  test('★★ 围栏 + 前后废话：仍然解得出来（模型十次有九次会加）', () => {
    const out = parseTidyOutput(
      '好的，我读了这段对话，挑出这些：\n```json\n[{"kind":"lesson","text":"别直接改 dist"}]\n```\n希望有用。',
    )
    assert.equal(out.parsed, true)
    assert.deepEqual(
      out.candidates.map((c) => [c.kind, c.text]),
      [['lesson', '别直接改 dist']],
    )
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
    const out = parseTidyOutput('[{"kind":"opinion","text":"我觉得还行"}]', HUMAN)
    assert.equal(out.candidates.length, 0)
    assert.equal(out.dropped[0]?.reason, 'kind_invalid')
  })

  test('★ 正文太长 ⇒ 剔掉（记忆单条上限是 400 字）', () => {
    const out = parseTidyOutput(`[{"kind":"fact","text":"${'x'.repeat(500)}"}]`, HUMAN)
    assert.equal(out.candidates.length, 0)
    assert.equal(out.dropped[0]?.reason, 'text_too_long')
  })

  test('★★ 看起来像密钥 ⇒ 剔掉（记忆每轮都会发给 CLI）', () => {
    const out = parseTidyOutput(
      '[{"kind":"fact","text":"部署用 sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGG"},' +
        '{"kind":"fact","text":"部署用 $DEPLOY_KEY 这个变量"}]',
      HUMAN,
    )
    assert.equal(out.candidates.length, 1, '只有变量名那条留下')
    assert.match(out.candidates[0]!.text, /DEPLOY_KEY/)
    assert.equal(out.dropped[0]?.reason, 'looks_like_secret')
  })

  test('★ 同一句话出现两次 ⇒ 只留一条（重复只会挤掉别的）', () => {
    const out = parseTidyOutput(
      '[{"kind":"fact","text":"用 pnpm"},{"kind":"lesson","text":"用  pnpm"}]',
      HUMAN,
    )
    assert.equal(out.candidates.length, 1)
  })

  test('★ 最多收 12 条，多出来的如实报', () => {
    const items = Array.from({ length: TIDY_MAX_CANDIDATES + 3 }, (_, i) => ({
      kind: 'fact',
      text: `第 ${String(i)} 条`,
    }))
    const out = parseTidyOutput(JSON.stringify(items), HUMAN)
    assert.equal(out.candidates.length, TIDY_MAX_CANDIDATES)
    assert.equal(out.dropped.filter((d) => d.reason === 'too_many').length, 3)
  })
})

/**
 * 「这次的对象」不该被写成经验（分批第 248 批）——使用者两次打回的都是这一种：
 *
 *   「不要把 Distilly 比喻成编译器」/「Distilly 本体就是一个 Skill。」
 *
 * 身份里已经写了"要泛化"的规矩，但模型会犯懒 ⇒ 平台再给一记**机械提示**：
 * 候选正文里出现了**这段对话标题里的专名** ⇒ 标成 `subjectSpecific`，界面默认不勾。
 *
 * ⚠️ 判据是"宁可多标几条，不要漏标"：清单宁短不长（`pnpm`/`git` 这类到处都在的词不算专名）。
 */
describe('只对这次成立：提到对话对象的候选默认不勾', () => {
  const HUMAN = ['我的理解 Distilly 就是一个 Skill。你把它比喻成编译器，让我困惑了']
  const SUBJECT = ['分析 https://github.com/titanwings/distilly，让我理解其做法和功能']

  test('★★★ 正文里点名了这次调研的对象 ⇒ subjectSpecific', () => {
    const out = parseTidyOutput(
      '[{"kind":"fact","text":"Distilly 本体就是一个 Skill",' +
        '"from":"我的理解 Distilly 就是一个 Skill。你把它比喻成编译器，让我困惑了"}]',
      HUMAN,
      SUBJECT,
    )
    assert.equal(out.candidates.length, 1)
    assert.equal(out.candidates[0]?.grounded, true, '出处是真的')
    assert.equal(out.candidates[0]?.subjectSpecific, true, '★ 但它只对这次成立')
    assert.equal(out.candidates[0]?.subjectTerm?.toLowerCase(), 'distilly')
  })

  test('★★ 泛化之后的同一句话 ⇒ 不再命中（它才是该记的那一版）', () => {
    const out = parseTidyOutput(
      '[{"kind":"lesson","text":"解释陌生工具时，先按它自己的定位说清它是什么，别用比喻代替结论",' +
        '"from":"我的理解 Distilly 就是一个 Skill。你把它比喻成编译器，让我困惑了"}]',
      HUMAN,
      SUBJECT,
    )
    assert.equal(out.candidates[0]?.subjectSpecific, false)
    assert.equal(out.candidates[0]?.grounded, true)
  })

  test('★ 通用词不算对象（pnpm / git / json 出现在标题里也不误标）', () => {
    const out = parseTidyOutput(
      '[{"kind":"fact","text":"这个仓库用 pnpm，测试前先跑 git status"}]',
      ['这个仓库用 pnpm'],
      ['pnpm + git 的最佳实践'],
    )
    assert.equal(out.candidates[0]?.subjectSpecific, false)
  })

  test('★ 不给对象信息 ⇒ 不做这项检查（老调用方不受影响）', () => {
    const out = parseTidyOutput('[{"kind":"fact","text":"Distilly 本体就是一个 Skill"}]')
    assert.equal(out.candidates[0]?.subjectSpecific, false)
  })
})

/**
 * 「它已经有哪些记忆」也要交给分析 run（分批第 251 批）。
 *
 * 使用者同一段对话整理**三次** ⇒ 21 条里三批几乎是同一件事换着说法。根因不是"没查重"，
 * 而是分析那一轮**只看得到对话**、看不到它已经记住了什么，于是每次从头挑一遍。
 * 机械查重救不了这件事：中文改写之间的字符重合度极低（实测同义句 bigram Dice 只有
 * 0.17–0.53，与"完全不同"的那一对重合）——所以语义判断必须交给它，而它得先知道有什么。
 */
describe('已有记忆：写进分析小屋，让它别重复提', () => {
  const mk = (over: { id: string; text: string; kind?: MemoryKind; removedAt?: number | null }) =>
    ({
      id: over.id,
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      kind: over.kind ?? 'preference',
      text: over.text,
      evidence: null,
      pinned: false,
      useCount: 0,
      lastUsedAt: null,
      createdAt: 1,
      removedAt: over.removedAt ?? null,
    }) as unknown as MemoryEntry

  test('★ 条条目都进文件，带类型标签', () => {
    const text = renderExistingMemory([
      mk({ id: 'm1', text: '文章要短、图要少' }),
      mk({ id: 'm2', text: '解释工具时别用比喻代替结论', kind: 'lesson' }),
    ])
    assert.match(text, /共 2 条/)
    assert.match(text, /- \[偏好\] 文章要短、图要少/)
    assert.match(text, /- \[教训\] 解释工具时别用比喻代替结论/)
    // 说清"要改就写 replaces"，否则它只会一直往上加
    assert.match(text, /replaces/)
  })

  test('★ 删掉的不进文件；一条都没有时也给出文件（不是空文件）', () => {
    // ⚠️ 断言要比的是"条目的正文"，不是"旧的"这两个字——文件头里本来就有"旧条目原文"。
    const text = renderExistingMemory([mk({ id: 'm1', text: '这条已经被删掉了', removedAt: 9 })])
    assert.doesNotMatch(text, /这条已经被删掉了/)
    assert.match(text, /共 0 条/)
    assert.match(text, /（还没有任何记忆）/)
  })

  test('★★ 它的输出可以带 `replaces`（旧原文），用来"加一条 + 删旧的"', () => {
    const out = parseTidyOutput(
      '[{"kind":"preference","text":"文章要短、图要少，优先保留流程图",' +
        '"from":"文章要短一点，图少一点",' +
        '"replaces":"文章要控制篇幅、减少配图，优先保留流程图"}]',
    )
    assert.equal(out.candidates[0]?.replaces, '文章要控制篇幅、减少配图，优先保留流程图')
  })

  test('★ 不带 `replaces` ⇒ null（纯新增）', () => {
    const out = parseTidyOutput('[{"kind":"fact","text":"这个仓库用 pnpm"}]')
    assert.equal(out.candidates[0]?.replaces, null)
  })

  test('★★★ 任务书点名两份文件（对话 + 已有记忆），并说清 replaces 怎么写', () => {
    const prompt = buildTidyPrompt()
    assert.match(prompt, /transcript\.md/)
    assert.match(prompt, /existing-memory\.md/)
    assert.match(prompt, /replaces/)
    assert.match(prompt, /同义的就不要再提一条/)
  })

  test('★★ 身份里也有这一节（可在「智能体」页查看）', () => {
    assert.match(MEMORY_TIDY_INSTRUCTIONS, /别重复提，要改就替换/)
    assert.match(MEMORY_TIDY_INSTRUCTIONS, /加一条 \+ 删旧的/)
  })
})

/**
 * 按「人的原话」查重（分批第 252 批，**使用者提的做法**）。
 *
 * 这比按正文查重可靠得多：同一段对话整理三次，模型每次把同一句话改写成不同的措辞
 * （实测同义改写的字符重合度只有 0.17–0.53，机械阈值分不开），但那句话**是同一句**
 * ——`from` 必须逐字抄自对话，所以它是天然的查重键。
 *
 * ⚠️ 它只**标**不丢：一句人可以同时说两件事（"用 pnpm，测试前先 git status"⇒ 两条记忆）。
 */
describe('按原话查重：同一句人话不重复产出', () => {
  const mk = (over: { id: string; text: string; source?: string }): MemoryEntry =>
    ({
      id: over.id,
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      kind: 'preference',
      text: over.text,
      ...(over.source === undefined ? {} : { source: over.source }),
      evidence: null,
      pinned: false,
      useCount: 0,
      lastUsedAt: null,
      createdAt: 1,
      removedAt: null,
    }) as unknown as MemoryEntry

  test('★★ 同一句原话（只差排版）⇒ 找得到已有的那些', async () => {
    const { findBySource } = await import('./memory.ts')
    const existing = [
      mk({ id: 'm1', text: '文章要短、图要少', source: '文章要短一点，图少一点' }),
      mk({ id: 'm2', text: '解释工具别用比喻', source: '别用比喻，我困惑了' }),
    ]
    const hits = findBySource(existing, '  文章要短一点，图少一点。')
    assert.equal(hits.length, 1)
    assert.equal(hits[0]?.id, 'm1')
  })

  test('★★ 一句原话产出两条不同的事实 ⇒ 两条都留着（"同源"只是标出来，不硬丢）', async () => {
    const { findBySource } = await import('./memory.ts')
    const existing = [mk({ id: 'm1', text: '用 pnpm', source: '用 pnpm，测试前先 git status' })]
    const hits = findBySource(existing, '用 pnpm，测试前先 git status')
    assert.equal(hits.length, 1, '找得到同源的那条')
    // ⚠️ 但落库那边不会拒绝第二条：正文不同就不是重复
    const { findDuplicateMemory } = await import('./memory.ts')
    assert.equal(findDuplicateMemory(existing, '测试前先跑 git status'), null, '不同的那条照收')
  })

  test('★ 手写的条目（没有 source）不参与按原话的比对', async () => {
    const { findBySource } = await import('./memory.ts')
    const existing = [mk({ id: 'm1', text: '文章要短、图要少' })]
    assert.deepEqual(findBySource(existing, '文章要短一点'), [])
  })

  test('★★ 已有记忆那份文件里带上「出自：原话」（模型看得见它记过什么）', () => {
    const text = renderExistingMemory([
      mk({ id: 'm1', text: '文章要短、图要少', source: '文章要短一点，图少一点' }),
    ])
    assert.match(text, /出自：「文章要短一点，图少一点」/)
    assert.match(text, /同一句原话已经产出过条目/)
  })
})
