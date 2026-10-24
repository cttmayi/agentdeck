import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  checkTermCoverage,
  extractRequirements,
  looksLikeRequirement,
  renderUserRequirements,
  requirementTerms,
  userSayings,
} from './user-requirements.ts'

/**
 * 这一组钉的是「使用者的要求 ⇒ skill 的长期约定」（分批第 26 批）。
 *
 * 每一条都来自那次任务的真实素材（`material/turns/*.md` 与 `skill/SKILL.md`）：
 * 使用者提了「ASD-STE100」与「《金字塔原理》」，而产出把它们写成了
 * 「如果用户要求…」的**可选开关** ✗。抽取器要保证：这两条能抽出来，
 * 而同一份素材里的**提问**（「有查过 arXiv 吗」「你的写作结构是什么思路」）不能抽成要求。
 */

const turn002 = `# 第 2 轮

## 使用者

使用 ASD-STE100 的方式 写成一篇文章

## 执行记录

[消息] 我已核对论文、LaTeX 源文件、公开榜单和 GitHub 仓库。
`

const turn003 = `# 第 3 轮

## 使用者

有查过 arXiv 吗

## 执行记录

[消息] 查过了。
`

const turn005 = `# 第 5 轮

## 使用者

我觉得麦肯锡的《金字塔原理》这本书的表达不错， 请参考做调整呢。 也需要符合ASD-STE100的表达

## 执行记录

[消息] 已按金字塔原理重排。
`

const turn004 = `# 第 4 轮

## 使用者

你的写作结构是什么思路

## 执行记录

[消息] 先结论后论证。
`

test('★★ 只从 `## 使用者` 段取原话（执行记录是 agent 说的，不是使用者的要求）', () => {
  assert.deepEqual(userSayings(turn002), ['使用 ASD-STE100 的方式 写成一篇文章'])
  // 执行记录里也出现 ASD-STE100，但它不是使用者说的
  assert.ok(!userSayings(turn002).some((s) => s.includes('我已核对')))
})

test('★★★ 提问不算要求（「有查过 arXiv 吗」「是什么思路」——真素材里就有这两句）', () => {
  assert.equal(looksLikeRequirement('有查过 arXiv 吗'), false)
  assert.equal(looksLikeRequirement('你的写作结构是什么思路'), false)
  assert.equal(looksLikeRequirement('使用 ASD-STE100 的方式 写成一篇文章'), true)
  assert.equal(
    looksLikeRequirement('我觉得麦肯锡的《金字塔原理》这本书的表达不错， 请参考做调整呢。 也需要符合ASD-STE100的表达'),
    true,
  )
})

test('★★★ 两条真实要求都要抽出来，出处要对（这正是被当成"可选开关"掉的那两条）', () => {
  const reqs = extractRequirements([
    { relPath: 'turns/002.md', text: turn002 },
    { relPath: 'turns/003.md', text: turn003 },
    { relPath: 'turns/004.md', text: turn004 },
    { relPath: 'turns/005.md', text: turn005 },
  ])
  assert.deepEqual(
    reqs.map((r) => r.file),
    ['turns/002.md', 'turns/005.md'],
    '提问那两轮不许进来',
  )
  assert.match(reqs[0]?.quote ?? '', /ASD-STE100/)
  assert.match(reqs[1]?.quote ?? '', /金字塔原理/)
})

test('★ 专名抽取：书名号、专名（ASD-STE100）都要，普通词不要', () => {
  const terms = requirementTerms('我觉得《金字塔原理》这本书不错，也需要符合ASD-STE100的表达')
  assert.ok(terms.includes('金字塔原理'), `实际 ${JSON.stringify(terms)}`)
  assert.ok(terms.includes('ASD-STE100'), `实际 ${JSON.stringify(terms)}`)
  assert.ok(!terms.includes('表达'))
})

test('★★ 落点检查：skill 里没出现 ⇒ found=false（真机上 STE100 就是这么"没有记录"的）', () => {
  const cover = checkTermCoverage(['ASD-STE100', '金字塔原理'], ['# 调研并写文章\n\n先结论后论证。\n'])
  assert.deepEqual(cover, [
    { term: 'ASD-STE100', found: false },
    { term: '金字塔原理', found: false },
  ])
  const ok = checkTermCoverage(['表格'], ['数字放进表格'])
  assert.equal(ok[0]?.found, true)
})

test('渲染出来的清单要能直接交给起草者：说明、原文出处、专名缺失都要看得见', () => {
  const md = renderUserRequirements(
    [{ file: 'turns/002.md', quote: '使用 ASD-STE100 的方式 写成一篇文章' }],
    [{ term: 'ASD-STE100', found: false }],
  )
  assert.match(md, /「约定」/)
  assert.match(md, /turns\/002\.md/)
  assert.match(md, /还没出现/)
})

test('素材里没有任何要求 ⇒ 如实说"没有抽到"，不编（空清单不等于错误）', () => {
  const md = renderUserRequirements([], [])
  assert.match(md, /没有抽到/)
})
