import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { makeAgent, makeSkill, skillId } from '../testing/fixtures.ts'
import { resolveSkillsForAgent, routeReportToReviewers } from './kind.ts'

/**
 * 审核路由（D28）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 从"按 kind 分派"改成"审核者是一个小组"
 * ══════════════════════════════════════════════════════════════════
 *
 * 原来这里按 `kindPatterns` 把报告分派给不同审核者，还有一层兜底审核者。
 * 那套配置要求使用者在建 agent 时就想清楚"哪些 kind 归谁"——为一个不常用
 * 的能力付了四个字段的学习成本。
 *
 * 现在：**`role: 'reviewer'` 的 agent 都审每一份报告**。
 */

const reviewer = (id: string, skillCount = 1) =>
  makeAgent({
    id,
    role: 'reviewer',
    skillIds: Array.from({ length: skillCount }, (_, i) => skillId(`${id}-s${i}`)),
  })

describe('★ 路由：所有审核者都审，不看 kind', () => {
  test('★ kind 完全不影响路由结果', () => {
    // 这条是 D28 的核心：`kind` 仍然是报告自身的属性（决定审核者看到的
    // 是什么材料），但它**不再是分派依据**。
    const agents = [reviewer('r1'), reviewer('r2')]
    const forCi = routeReportToReviewers(agents)
    const forSecurity = routeReportToReviewers(agents)
    assert.deepEqual(
      forCi.reviewers.map((a) => a.id),
      forSecurity.reviewers.map((a) => a.id),
    )
  })

  test('多个审核者 ⇒ 各起一个 run（多视角审核，FR-AGENT-21）', () => {
    const r = routeReportToReviewers([reviewer('r1'), reviewer('r2'), reviewer('r3')])
    assert.equal(r.reviewers.length, 3)
    assert.equal(r.unmatched, false)
  })

  test('★ 执行角色的 agent 不参与审核', () => {
    const r = routeReportToReviewers([
      makeAgent({ id: 'e1', role: 'executor' }),
      reviewer('r1'),
    ])
    assert.deepEqual(r.reviewers.map((a) => a.id), ['r1'])
  })

  test('★ 一条依据都没有的审核者不算数（既没写「指令」、也没老标准、也没挂 skill）', () => {
    // 把它当审核者会让 run 起不来，或审出没有依据的结论
    const r = routeReportToReviewers([reviewer('bare', 0), reviewer('real', 1)])
    assert.deepEqual(r.reviewers.map((a) => a.id), ['real'])
  })

  /**
   * ★★ 2026-09：判断依据并进「指令」之后，这条筛选**必须**认「指令」。
   *
   * 它原来只看老字段 `reviewStandard`。而新审核者身上根本没有那个字段（依据写在
   * 「指令」里、也没有必要挂 skill）——于是报告全部落进 `unmatched`：第三方报告
   * 只落库 + 一条通知，**一条 review run 都不起**，而订阅方看到的是"已收到"。
   *
   * ⚠️ 症状离原因很远（坏掉的是"报告那一条链路"），所以这里把三种形态一起钉住。
   */
  test('★★★ 只看「指令」的审核者也算数（依据并进「指令」之后的新形态）', () => {
    const byInstructions = makeAgent({
      id: 'by-instructions',
      role: 'reviewer',
      instructions: '你是严格的审核者。',
      reviewStandard: null,
      skillIds: [],
    })
    const r = routeReportToReviewers([byInstructions])
    assert.deepEqual(r.reviewers.map((a) => a.id), ['by-instructions'])
    assert.equal(r.unmatched, false, '★ 否则第三方报告会静默地没人审')

    // 三条都空 ⇒ 才算"没有依据"
    const empty = makeAgent({
      id: 'empty',
      role: 'reviewer',
      instructions: '   ',
      reviewStandard: null,
      skillIds: [],
    })
    assert.equal(routeReportToReviewers([empty]).unmatched, true)
  })

  test('★ 一个审核者都没有 ⇒ unmatched（调用方必须通知，不得静默丢弃）', () => {
    assert.equal(routeReportToReviewers([]).unmatched, true)
    assert.equal(
      routeReportToReviewers([makeAgent({ id: 'e1', role: 'executor' })]).unmatched,
      true,
      '只有执行者、没有审核者，同样没人能审',
    )
    assert.equal(routeReportToReviewers([reviewer('bare', 0)]).unmatched, true)
  })
})

describe('agent 用哪些 skill', () => {
  test('按 skillIds 取，顺序保持一致', () => {
    const skills = [
      makeSkill({ id: 'a', slug: 'a' }),
      makeSkill({ id: 'b', slug: 'b' }),
      makeSkill({ id: 'c', slug: 'c' }),
    ]
    const agent = makeAgent({ id: 'x', skillIds: [skillId('b'), skillId('a')] })
    assert.deepEqual(
      resolveSkillsForAgent(agent, skills).map((s) => s.slug),
      ['b', 'a'],
    )
  })

  test('指向不存在的 skill 时跳过，不炸', () => {
    const agent = makeAgent({ id: 'x', skillIds: [skillId('gone')] })
    assert.deepEqual(resolveSkillsForAgent(agent, []), [])
  })

  test('★ 一个 workspace 里有很多 skill，但 agent 只用它挂的那部分（FR-AGENT-03）', () => {
    // 这不是优化，是分工的本体——安全 agent 不该带着"文档校对"的标准去审代码
    const skills = [
      makeSkill({ id: 'sec', slug: 'security' }),
      makeSkill({ id: 'doc', slug: 'doc-proofread' }),
    ]
    const agent = makeAgent({ id: 'x', skillIds: [skillId('sec')] })
    assert.deepEqual(
      resolveSkillsForAgent(agent, skills).map((s) => s.slug),
      ['security'],
    )
  })
})
