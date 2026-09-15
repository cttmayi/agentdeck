import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Agent } from '@alpha-helper/protocol'
import { resolveReviewStandard } from './review-standard.ts'

/**
 * ══════════════════════════════════════════════════════════════════
 * 「审核标准」的解析（D37）——三处调用点共用的那一份判据
 * ══════════════════════════════════════════════════════════════════
 *
 * 派发审核前判"这个审核者能不能用"、渲染第一句话的 `{{standards}}`、判决收口时
 * 校验动作白名单——三处都用这个函数。所以它错一点，三处一起错，而且是"界面说
 * 它有标准、平台却不派审核"那类最难查的错。
 *
 * 这里只测**纯函数**（不起 daemon）：`resolveReviewStandard` 的三种情形。
 * 派发与判决那两条链路的端到端在 `review-e2e.test.ts`。
 */

const agent = (reviewStandard: Agent['reviewStandard']): Pick<Agent, 'reviewStandard'> => ({
  reviewStandard,
})

const skill = (
  name: string,
  body: string,
  allowedActions: Array<'comment.create' | 'issue.add_label' | 'issue.update_status' | 'issue.create'> = [],
) => ({ name, body, allowedActions })

describe('D37：审核标准怎么解析', () => {
  test('有内联标准 ⇒ 用它，且不标成"来自 skill"', () => {
    const resolved = resolveReviewStandard(
      agent({ name: '安全审核', body: '# 安全审核\n\n1. 只看越权。', allowedActions: ['comment.create'] }),
      [],
    )
    assert.ok(resolved)
    assert.equal(resolved.name, '安全审核')
    assert.match(resolved.body, /只看越权/)
    assert.deepEqual(resolved.allowedActions, ['comment.create'])
    assert.equal(resolved.fromSkills, false)
  })

  test('★ 内联标准优先于挂载的 skill（两份都在时以内联为准，不合并）', () => {
    // 这条是刻意的：动作白名单的**合并语义是安全相关的**——并集等于悄悄放宽
    // 权限、交集等于莫名其妙收紧，两个都不该是隐式行为。
    const resolved = resolveReviewStandard(
      agent({ name: '内联', body: '内联正文', allowedActions: ['comment.create'] }),
      [skill('挂着的', 'skill 正文', ['issue.update_status', 'issue.create'])],
    )
    assert.ok(resolved)
    assert.equal(resolved.body, '内联正文')
    assert.deepEqual(resolved.allowedActions, ['comment.create'], '不许被 skill 的动作放宽')
    assert.equal(resolved.fromSkills, false)
  })

  test('★ 过渡期：没有内联标准但挂了 skill ⇒ 用 skill 顶上（老数据不停摆）', () => {
    const resolved = resolveReviewStandard(agent(null), [
      skill('通用审核', '# 通用审核\n\n判断标准…', ['comment.create']),
      skill('安全', '# 安全\n\n越权检查…', ['issue.add_label']),
    ])
    assert.ok(resolved, '这是不改动之前的行为，必须还能用')
    assert.equal(resolved.fromSkills, true, '要标出来——界面据此提示迁移')
    assert.match(resolved.body, /通用审核/)
    assert.match(resolved.body, /越权检查/, '多份 skill 的正文都要在')
    assert.deepEqual(
      [...resolved.allowedActions].sort(),
      ['comment.create', 'issue.add_label'],
      '动作并集 —— 与改动之前一分不差',
    )
  })

  test('两者都没有 / 正文是空白 ⇒ null（没有标准）', () => {
    assert.equal(resolveReviewStandard(agent(null), []), null)
    assert.equal(resolveReviewStandard(agent(null), [skill('空壳', '   ')]), null)
    assert.equal(
      resolveReviewStandard(agent({ name: '空正文', body: '  ', allowedActions: [] }), []),
      null,
      '只有空白的"标准"等于没有标准',
    )
  })

  test('内联标准存在但正文空白时，**回落到 skill**（而不是当成"有标准"）', () => {
    // 边界情形：使用者把正文清空了、但没删除那条标准。这时不能拿它当标准
    // （它没有任何内容），也不能让审核者直接变成"审不了"——挂了 skill 就照旧用。
    const resolved = resolveReviewStandard(agent({ name: 'x', body: '', allowedActions: [] }), [
      skill('兜底标准', '兜底正文', ['comment.create']),
    ])
    assert.ok(resolved)
    assert.equal(resolved.fromSkills, true)
    assert.match(resolved.body, /兜底正文/)
  })
})
