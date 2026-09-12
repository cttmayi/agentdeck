import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { makeAgent, makeSkill } from '../testing/fixtures.ts'
import { resolveRunSkills, resolveSkillsForKind, routeReportToReviewers } from './kind.ts'

describe('kind → agent 路由（D24、FR-AGENT-20~22）', () => {
  test('恰好一个 agent 认这个 kind', () => {
    const agents = [
      makeAgent({ id: 'security', kindPatterns: ['dependency-vulnerability'] }),
      makeAgent({ id: 'docs', kindPatterns: ['doc-review'] }),
    ]
    const r = routeReportToReviewers('dependency-vulnerability', agents)
    assert.equal(r.reviewers.length, 1)
    assert.equal(r.reviewers[0]?.id, 'security')
    assert.equal(r.usedFallback, false)
    assert.equal(r.unmatched, false)
  })

  test('★ 多个 agent 认同一个 kind ⇒ 并行审核（各起一个 review run）', () => {
    const agents = [
      makeAgent({ id: 'security', kindPatterns: ['pr-diff'] }),
      makeAgent({ id: 'arch', kindPatterns: ['*'] }),
    ]
    const r = routeReportToReviewers('pr-diff', agents)
    assert.deepEqual(
      r.reviewers.map((a) => a.id).sort(),
      ['arch', 'security'],
    )
    assert.equal(r.unmatched, false)
  })

  test('没有 agent 认 ⇒ 走兜底审核者', () => {
    const agents = [
      makeAgent({ id: 'security', kindPatterns: ['x'] }),
      makeAgent({ id: 'general', kindPatterns: [], isFallbackReviewer: true }),
    ]
    const r = routeReportToReviewers('unknown-kind', agents)
    assert.equal(r.reviewers.length, 1)
    assert.equal(r.reviewers[0]?.id, 'general')
    assert.equal(r.usedFallback, true)
    assert.equal(r.unmatched, false)
  })

  test('★ 既无匹配也无兜底 ⇒ unmatched（调用方必须存 report + 通知，不得静默丢弃）', () => {
    const agents = [makeAgent({ id: 'security', kindPatterns: ['x'] })]
    const r = routeReportToReviewers('unknown-kind', agents)
    assert.deepEqual(r.reviewers, [])
    assert.equal(r.unmatched, true)
    assert.equal(r.usedFallback, false)
  })

  test('通配模式被正确使用', () => {
    const agents = [makeAgent({ id: 'ci', kindPatterns: ['ci-*'] })]
    assert.equal(routeReportToReviewers('ci-failure', agents).reviewers.length, 1)
    assert.equal(routeReportToReviewers('pr-diff', agents).unmatched, true)
  })
})

describe('审核 skill 求解（agent 子集，FR-AGENT-03）', () => {
  const s1 = makeSkill({ id: 'sec-vuln' })
  const s2 = makeSkill({ id: 'arch-style' })
  const s3 = makeSkill({ id: 'docs-typo' })
  const all = [s1, s2, s3]

  test('用 agent 挂载的 skill 子集，而不是全部', () => {
    const agent = makeAgent({ id: 'security', skillIds: [s1.id, s2.id] })
    const got = resolveSkillsForKind(agent, 'dependency-vulnerability', all)
    assert.deepEqual(
      got.map((s) => s.id).sort(),
      ['arch-style', 'sec-vuln'],
    )
    assert.ok(!got.some((s) => s.id === s3.id), '未挂载的 skill 不得出现')
  })

  test('★ 显式 kindSkillOverride 优先于挂载的子集', () => {
    const agent = makeAgent({
      id: 'security',
      skillIds: [s1.id, s2.id],
      kindSkillOverride: { 'pr-diff': s3.id },
    })
    const got = resolveSkillsForKind(agent, 'pr-diff', all)
    assert.deepEqual(got.map((s) => s.id), ['docs-typo'])
  })

  test('override 指向不存在的 skill ⇒ 返回空（不会静默退回子集）', () => {
    const agent = makeAgent({
      id: 'security',
      skillIds: [s1.id],
      kindSkillOverride: { 'pr-diff': 'missing' as never },
    })
    assert.deepEqual(resolveSkillsForKind(agent, 'pr-diff', all), [])
  })

  test('未挂载任何 skill ⇒ 空集合', () => {
    const agent = makeAgent({ id: 'bare', skillIds: [] })
    assert.deepEqual(resolveSkillsForKind(agent, 'k', all), [])
  })

  test('★ run 的技能集合按该 run 的 agent 求解（D22 硬约束）', () => {
    const security = makeAgent({ id: 'security', skillIds: [s1.id] })
    const docs = makeAgent({ id: 'docs', skillIds: [s3.id] })

    assert.deepEqual(
      resolveRunSkills(security, all).map((s) => s.id),
      ['sec-vuln'],
    )
    assert.deepEqual(
      resolveRunSkills(docs, all).map((s) => s.id),
      ['docs-typo'],
    )
    // 两个 agent 注入的技能集合必须不同——这正是"分工"的本体
    assert.notDeepEqual(resolveRunSkills(security, all), resolveRunSkills(docs, all))
  })
})
