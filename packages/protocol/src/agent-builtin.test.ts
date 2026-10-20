/**
 * Agent 的**内置标记**与**起草者角色**（2026-10 沉淀内置起草者的第 1 步）。
 *
 * 为什么这两样要一起钉：
 *   · `builtin` 是"不许删 + 不参与业务选择"的**唯一**判据（不按名字认——名字使用者能改，
 *     改名之后失效的表现是"它又能被删"，静默且查起来很远）；
 *   · `drafter` 是平台内置起草者的角色。各处"选执行者/审核者"用的都是 `role === 'executor'`
 *     /`role === 'reviewer'` 这种**等值**判断 ⇒ 新成员天然被排除。这条测试把那个前提写下来：
 *     谁把判据改成 `!==`，起草者就会漏进选择器（那是这个设计最容易破的地方）。
 *
 * ⚠️ 老数据必须还能读：老 agent 记录里**没有** `builtin` 字段，读进来要是"不是内置"，
 *    不能读崩——所以它是可选字段 + 默认 `false`。第一次把 `builtin` 写成必填时，
 *    `Agent.parse(老记录)` 直接抛（少字段），而那种错在界面上表现为"所有老 agent 消失了"。
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Agent, AgentRole } from './entities.ts'

/** 一条最小的合法 agent 记录（字段取 schema 的必填项）。 */
function makeAgent(extra: Record<string, unknown> = {}) {
  return {
    id: '01AGENT',
    workspaceId: '01WS',
    name: '起草者',
    instructions: '你是 skill 作者。',
    model: null,
    runtimeKey: 'claude',
    workDir: null,
    skillIds: [],
    // ⚠️ `role` 与 `env` 也是**必填**（第一版夹具漏了它们，`Agent.parse` 直接抛
    //    `invalid_type: env`——那条错看起来像"内置标记加错了"，其实是夹具不全）。
    role: 'executor',
    env: {},
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  }
}

describe('AgentRole：起草者是独立角色', () => {
  test('三种角色都收；不是执行者也不是审核者的等值判断能把它排除在外', () => {
    for (const role of ['executor', 'reviewer', 'drafter'] as const) {
      assert.equal(AgentRole.parse(role), role)
    }
    // ★ 这一条是设计意图的钉：各处选择器写的是等值判断
    const drafter = AgentRole.parse('drafter')
    assert.equal(drafter === 'executor', false)
    assert.equal(drafter === 'reviewer', false)
  })
})

describe('Agent.builtin：可选 + 默认不是内置（老数据读得出来）', () => {
  test('老记录（没有 builtin 字段）⇒ 解析得出来，且不是内置', () => {
    const parsed = Agent.parse(makeAgent())
    assert.equal(parsed.builtin, undefined, '老记录不该被塞一个假的 true')
    assert.notEqual(parsed.builtin, true)
  })

  test('内置起草者 ⇒ builtin: true 原样保留', () => {
    const parsed = Agent.parse(makeAgent({ role: 'drafter', builtin: true }))
    assert.equal(parsed.builtin, true)
    assert.equal(parsed.role, 'drafter')
  })
})
