/**
 * Agent 的**内置标记**与**内置岗位**（2026-10 沉淀内置起草者起，2026-11 S4 定稿）。
 *
 * 为什么这两样要一起钉：
 *   · `builtin` 是"不许删 + 不参与业务选择"的**唯一**判据（不按名字认——名字使用者能改，
 *     改名之后失效的表现是"它又能被删"，静默且查起来很远）；
 *   · `builtinKind` 是"它是哪一条内置"——起草者 / 沉淀审核者 / 记忆整理 / 智能体生成者。
 *     两者**一起**才说明问题（见 `apps/daemon/src/builtin-drafter.ts` 的 `builtinKindOf`）。
 *
 * ⚠️ 2026-11（S4，D127）：这里原来钉的是 `AgentRole`——"起草者是一个独立角色，
 *    各处选择器写的是 `role === 'executor'` 这种**等值**判断，所以新角色天然被排除"。
 *    **角色退场**之后判据换成 `builtin !== true`（筛选用等值、不用不等值，同一条纪律）。
 *
 * ⚠️ 老数据必须还能读：老 agent 记录里**没有** `builtin` / `builtinKind` 字段，读进来
 *    要是"不是内置"，不能读崩——所以它们是可选字段。第一次把 `builtin` 写成必填时，
 *    `Agent.parse(老记录)` 直接抛（少字段），而那种错在界面上表现为"所有老 agent 消失了"。
 */

import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Agent } from './entities.ts'
import { cleanAgent } from './agent-legacy.ts'

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
    // ⚠️ `env` 也是**必填**（第一版夹具漏了它，`Agent.parse` 直接抛
    //    `invalid_type: env`——那条错看起来像"内置标记加错了"，其实是夹具不全）。
    env: {},
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  }
}

describe('Agent.builtin：可选 + 默认不是内置（老数据读得出来）', () => {
  test('老记录（没有 builtin 字段）⇒ 解析得出来，且不是内置', () => {
    const parsed = Agent.parse(makeAgent())
    assert.equal(parsed.builtin, undefined, '老记录不该被塞一个假的 true')
    assert.notEqual(parsed.builtin, true)
  })

  test('内置起草者 ⇒ builtin + builtinKind 原样保留', () => {
    const parsed = Agent.parse(makeAgent({ builtin: true, builtinKind: 'drafter' }))
    assert.equal(parsed.builtin, true)
    assert.equal(parsed.builtinKind, 'drafter')
  })

  test('★ 用户建的 agent 没有岗位值（"谁能干活"不再由角色回答）', () => {
    const parsed = Agent.parse(makeAgent())
    assert.equal(parsed.builtinKind, undefined)
  })
})

describe('老记录的 role ⇒ builtinKind（读时兜底，D127）', () => {
  test('★ 内置记录：老 `role` 升格成 `builtinKind`，`role` 被摘掉', () => {
    const cleaned = cleanAgent(makeAgent({ builtin: true, role: 'drafter' })) as Record<
      string,
      unknown
    >
    assert.equal(cleaned['builtinKind'], 'drafter')
    assert.equal('role' in cleaned, false, '角色退场 ⇒ 这个键不许留在记录里')
  })

  test('★ 用户建的记录：`role` 直接摘掉，且**不**补岗位值', () => {
    const cleaned = cleanAgent(makeAgent({ role: 'executor' })) as Record<string, unknown>
    assert.equal('role' in cleaned, false)
    assert.equal('builtinKind' in cleaned, false, '不是内置就没有岗位')
  })

  test('★ 已经是新形状的记录 ⇒ 一个字都不动（幂等）', () => {
    const fresh = makeAgent({ builtin: true, builtinKind: 'agent-maker' })
    const cleaned = cleanAgent(fresh) as Record<string, unknown>
    assert.deepEqual(cleaned, fresh)
  })

  test('★ 标记在、`role` 认不出 ⇒ 不补岗位值（宁可"认不出"，也不要猜一条）', () => {
    const cleaned = cleanAgent(makeAgent({ builtin: true, role: 'reviewer' })) as Record<
      string,
      unknown
    >
    assert.equal('builtinKind' in cleaned, false)
    assert.equal('role' in cleaned, false)
  })
})
