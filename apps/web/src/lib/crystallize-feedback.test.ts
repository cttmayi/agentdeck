import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { buildFeedbackDraft, type FeedbackLabels } from './crystallize-feedback.ts'

/**
 * 这一段的形状**必须**与 daemon 那份一致（`apps/daemon/src/server.ts` 的
 * `draftReviewFeedback`）：两份文本都会落到同一个 `material/feedback.md`，
 * 给同一个起草者看（一份来自自动返工，一份来自人在界面上点的这一条）。
 * 两处形状分叉的表现是"自动改的那版与我说要改的那版，起草者读到的不一样"。
 * 所以这里连**标点与缩进**都钉住。
 *
 * ⚠️ 夹具里的标签**照抄 daemon 那一份**（含 `**` 与反引号）——界面实际用的是 i18n 词条，
 *    那份**不带** markdown 记号（守卫不许，见 `packages/i18n/src/web/crystallize.ts` 里的注释）。
 *    也就是说这里钉的是**结构**，不是某一份的字面：结构对齐、记号按各自读者的需要。
 */
const L: FeedbackLabels = {
  intro: (code) => `审核不通过（理由码：${code}）。这一版请**逐条**对着下面每一条改：`,
  where: '位置：',
  quote: '原文：',
  noEvidence: '（审核者没给位置，请自己找：这一条只说了现象。）',
  emptyFindings: '（审核者没有给出条目清单，请按上面的理由码判断该改什么；不要动无关部分。）',
  outro: '改完把**改过的文件**写回 `skill/`（完整文件，不是补丁）；没改的文件不必重写。',
}

describe('填进「按意见改一版」的那段话', () => {
  test('★ 每条都带位置与原文（只有一句话的清单，起草者只能猜）', () => {
    const text = buildFeedbackDraft(
      'style_violation',
      [
        {
          severity: 'high',
          summary: '正文里没有 `## When to Use` 一节',
          evidence: [{ locator: 'SKILL.md:12', excerpt: '# 报告流程' }],
        },
        {
          severity: 'medium',
          summary: '支持文件没被正文引用',
          evidence: [{ locator: 'references/checklist.md', excerpt: null }],
        },
      ],
      L,
    )
    const lines = text.split('\n')
    assert.equal(lines[0], '审核不通过（理由码：style_violation）。这一版请**逐条**对着下面每一条改：')
    assert.equal(lines[1], '1. [high] 正文里没有 `## When to Use` 一节')
    assert.equal(lines[2], '   位置：SKILL.md:12', '位置要与条目**同一块**、缩进两格')
    assert.equal(lines[3], '   原文：# 报告流程', '原文要跟着位置（行号是软信息，原文才是准的）')
    assert.equal(lines[4], '2. [medium] 支持文件没被正文引用')
    assert.equal(lines[5], '   位置：references/checklist.md')
    assert.equal(lines[6], '   改完把**改过的文件**写回 `skill/`（完整文件，不是补丁）；没改的文件不必重写。'.slice(3))
    assert.ok(text.endsWith(L.outro), '最后一句是"怎么改、怎么写回"')
  })

  test('★ 没有位置就如实说，不编一个位置；条目为空也不编一条', () => {
    const noEvidence = buildFeedbackDraft(
      'no_evidence',
      [{ severity: 'low', summary: '说不清哪里不对', evidence: [] }],
      L,
    )
    assert.match(noEvidence, /1\. \[low\] 说不清哪里不对\n   （审核者没给位置，请自己找/)
    assert.ok(!noEvidence.includes('位置：'), '不许出现空的位置标签')

    const none = buildFeedbackDraft('internal_error', [], L)
    assert.match(none, /审核者没有给出条目清单/, '没有条目要说清"没有"，而不是留白')
    assert.equal(none.split('\n').length, 3, '三段：交代 + 如实说明 + 收尾')
  })

  test('★ 位置/原文为 null 与空串都不算（脏数据不许在清单里留下空行）', () => {
    const text = buildFeedbackDraft(
      'logic_error',
      [
        {
          severity: 'high',
          summary: '有一段逻辑与素材对不上',
          evidence: [
            { locator: null, excerpt: '照抄的那一句' },
            { locator: 'SKILL.md', excerpt: '' },
            { locator: null, excerpt: null },
          ],
        },
      ],
      L,
    )
    assert.equal(
      text.split('\n').filter((l) => l.trim() === '').length,
      0,
      '不许出现空行（空行会让起草者以为清单到这里就完了）',
    )
    assert.match(text, /原文：照抄的那一句/)
    assert.match(text, /位置：SKILL\.md/)
  })
})
