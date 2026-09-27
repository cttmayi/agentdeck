import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { hasReviewIdentity } from './agent-identity.ts'

/**
 * ══════════════════════════════════════════════════════════════════
 * 「这个审核者有没有判断依据」——界面侧那份判据（2026-09）
 * ══════════════════════════════════════════════════════════════════
 *
 * 它决定详情页顶上要不要挂一条**红色警告**。这条警告写错过一次：条件当时看的是
 * 老形态的两个字段（`reviewStandard` / `skillIds`），于是"写了指令、没标准字段、
 * 也没挂 skill"的正常审核者会被挂上
 *
 *   「它审不了任何东西：没有审核标准，平台不会把产出交给它审。」
 *
 * ——而它其实审得好好的。使用者照着这句话去修一个不存在的问题，是这类过时判据
 * 最典型的代价（同一条链路上，列表里那个「未挂 skill」徽标已经因为同一类原因
 * 被整段删掉了）。
 *
 * ⚠️ 与域层 `hasReviewIdentity`、daemon 的 `reviewerIdentity` 是**同一条规矩的
 *    三份实现**（界面手里没有 skill 正文，所以它只能更宽）。这份测试钉的就是
 *    "三种形态都算有依据、只有真的空才算没有"。
 */
describe('★ 审核者有没有判断依据（界面侧）', () => {
  test('★★★ 只写了「指令」就算有 —— 依据并进「指令」之后这就是常态', () => {
    assert.equal(
      hasReviewIdentity({ instructions: '你是严格的审核者。', reviewStandard: null, skillIds: [] }),
      true,
      '★ 写错这一条的表现是：正常的审核者被挂上"它审不了任何东西"的红警告',
    )
  })

  test('★ 老形态两种照旧算有：内联标准、挂在 skill 上的正文', () => {
    assert.equal(
      hasReviewIdentity({
        instructions: '',
        reviewStandard: { body: '## 判定\n\n只看证据。' },
        skillIds: [],
      }),
      true,
      'D37 那一代：正文内联在 reviewStandard 上',
    )
    assert.equal(
      hasReviewIdentity({ instructions: '', reviewStandard: null, skillIds: ['s1'] }),
      true,
      '更早的形态：正文住在挂载的 skill 里（界面看不到正文，只能认"挂了"）',
    )
  })

  test('★ 三条都空（或只有空白）才算没有 —— 这时那条警告才是真话', () => {
    assert.equal(hasReviewIdentity({ instructions: '', reviewStandard: null, skillIds: [] }), false)
    assert.equal(
      hasReviewIdentity({ instructions: '   \n  ', reviewStandard: null, skillIds: [] }),
      false,
      '只有空白的指令等于没写',
    )
    assert.equal(
      hasReviewIdentity({ instructions: '', reviewStandard: { body: '  ' }, skillIds: [] }),
      false,
      '空正文的老标准也算没有（与 daemon 那边 `body.trim() !== \'\'` 同一口径）',
    )
  })

  test('★ 字段缺省（老 daemon 不返回）不该炸，也不该当成"有"', () => {
    assert.equal(hasReviewIdentity({}), false)
    assert.equal(hasReviewIdentity({ instructions: null }), false)
  })
})
