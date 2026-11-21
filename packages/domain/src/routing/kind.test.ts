import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { makeAgent, makeSkill, skillId } from '../testing/fixtures.ts'
import { resolveSkillsForAgent } from './kind.ts'

/*
 * ⚠️ 2026-11（D125）：这里原来有一整组「★ 路由：所有审核者都审，不看 kind」用例
 *   （`routeReportToReviewers`：kind 不影响路由、多审核者各起一个 run、执行角色不
 *   参与、一条依据都没有的不算数、只看「指令」的也算数、一个审核者都没有 ⇒
 *   `unmatched`）。**报告摄取整条链退场** ⇒ 没有"把报告路由给谁"这件事，整组删掉。
 *
 *   那一组里最值钱的一条教训留在 `kind.ts` 的注释里：判据曾经只看老字段
 *   `reviewStandard`，而 2026-09 之后依据并进了 `instructions` ⇒ 新审核者全被筛掉
 *   ⇒ 报告只落库、一条 review run 都不起。**判据留在旧字段上，坏掉的是另一条链路**。
 */

describe('agent 用哪些 skill', () => {
  test('按 skillIds 取，顺序保持一致', () => {
    const skills = [
      makeSkill({ id: 'a', name: 'a' }),
      makeSkill({ id: 'b', name: 'b' }),
      makeSkill({ id: 'c', name: 'c' }),
    ]
    const agent = makeAgent({ id: 'x', skillIds: [skillId('b'), skillId('a')] })
    assert.deepEqual(
      resolveSkillsForAgent(agent, skills).map((s) => s.name),
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
      makeSkill({ id: 'sec', name: 'security' }),
      makeSkill({ id: 'doc', name: 'doc-proofread' }),
    ]
    const agent = makeAgent({ id: 'x', skillIds: [skillId('sec')] })
    assert.deepEqual(
      resolveSkillsForAgent(agent, skills).map((s) => s.name),
      ['security'],
    )
  })
})
