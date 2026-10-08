import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import type { Agent, AgentGroup } from '@agentdeck/protocol'
import { checkGroupShape } from './shape.ts'

/**
 * 组形态校验器（D70）。
 *
 * 钉的是"组是列表，而语义是 1 执行 + 1 审核"这一条：形态不对必须在写入前报清楚
 * （列出实际是谁、缺谁），不猜、不静默降级——否则组会退化成"任意成员的花名册"，
 * 提交 run 时才炸（那正是 D28 砍掉 kindPatterns 的教训）。
 */

function makeAgent(input: { id: string; role: Agent['role'] } & Partial<Omit<Agent, 'id' | 'role'>>): Agent {
  return {
    workspaceId: 'ws1' as Agent['workspaceId'],
    id: input.id as Agent['id'],
    name: input.name ?? input.id,
    instructions: input.instructions ?? 'do things',
    model: input.model ?? null,
    runtimeKey: input.runtimeKey ?? 'claude',
    workDir: input.workDir ?? null,
    skillIds: input.skillIds ?? [],
    env: input.env ?? {},
    role: input.role,
    reviewStandard: input.reviewStandard ?? null,
    createdAt: input.createdAt ?? 0,
    updatedAt: input.updatedAt ?? 0,
  }
}

function makeGroup(
  input: { members: AgentGroup['members']; id?: string } & Partial<Omit<AgentGroup, 'id' | 'members'>>,
): AgentGroup {
  return {
    id: (input.id ?? 'g1') as AgentGroup['id'],
    workspaceId: input.workspaceId ?? ('ws1' as AgentGroup['workspaceId']),
    name: input.name ?? '组',
    members: input.members,
    allowedActions: input.allowedActions ?? [],
    actionParams: input.actionParams ?? {},
    debugActions: input.debugActions ?? [],
    maxReworks: input.maxReworks ?? 0,
    enabled: input.enabled ?? true,
    createdAt: input.createdAt ?? 0,
    updatedAt: input.updatedAt ?? 0,
  }
}

const executor = makeAgent({ id: 'a-exec', role: 'executor' })
const reviewer = makeAgent({ id: 'a-rev', role: 'reviewer' })

/** 测试里写成员 id 的捷径：plain string[] → 带品牌的 `AgentGroup['members']`。 */
const members = (...ids: string[]): AgentGroup['members'] => ids as unknown as AgentGroup['members']

describe('checkGroupShape', () => {
  test('恰好 1 执行 + 1 审核 ⇒ ok，返回两个成员', () => {
    const shape = checkGroupShape(
      makeGroup({ members: members('a-exec', 'a-rev') }),
      [executor, reviewer],
    )
    assert.ok(shape.ok)
    if (shape.ok) {
      assert.equal(shape.executor.id, 'a-exec')
      assert.equal(shape.reviewer.id, 'a-rev')
    }
  })

  test('成员顺序无关：审核在前、执行在后同样 ok', () => {
    const shape = checkGroupShape(
      makeGroup({ members: members('a-rev', 'a-exec') }),
      [executor, reviewer],
    )
    assert.ok(shape.ok)
  })

  test('没有执行者 ⇒ 报"没有执行者"，并列出实际成员', () => {
    const shape = checkGroupShape(
      makeGroup({ members: members('a-rev') }),
      [reviewer],
    )
    assert.ok(!shape.ok)
    if (!shape.ok) {
      assert.match(shape.issues.join('；'), /没有执行者/)
      assert.match(shape.issues.join('；'), /「a-rev」/)
    }
  })

  test('没有审核者 ⇒ 报"没有审核者"', () => {
    const shape = checkGroupShape(
      makeGroup({ members: members('a-exec') }),
      [executor],
    )
    assert.ok(!shape.ok)
    if (!shape.ok) assert.match(shape.issues.join('；'), /没有审核者/)
  })

  test('多个执行者 ⇒ 报出是几个、是谁（多执行者是未来扩展，现在必须拒绝）', () => {
    const exec2 = makeAgent({ id: 'a-exec2', role: 'executor' })
    const shape = checkGroupShape(
      makeGroup({ members: members('a-exec', 'a-exec2', 'a-rev') }),
      [executor, exec2, reviewer],
    )
    assert.ok(!shape.ok)
    if (!shape.ok) {
      assert.match(shape.issues.join('；'), /2 个执行者/)
      assert.match(shape.issues.join('；'), /「a-exec2」/)
    }
  })

  test('多个审核者 ⇒ 报出是几个、是谁', () => {
    const rev2 = makeAgent({ id: 'a-rev2', role: 'reviewer' })
    const shape = checkGroupShape(
      makeGroup({ members: members('a-exec', 'a-rev', 'a-rev2') }),
      [executor, reviewer, rev2],
    )
    assert.ok(!shape.ok)
    if (!shape.ok) {
      assert.match(shape.issues.join('；'), /2 个审核者/)
      assert.match(shape.issues.join('；'), /「a-rev2」/)
    }
  })

  test('成员在库里找不到 ⇒ 报"不存在"，并列出 id', () => {
    const shape = checkGroupShape(
      makeGroup({ members: members('a-exec', 'a-ghost') }),
      [executor],
    )
    assert.ok(!shape.ok)
    if (!shape.ok) {
      assert.match(shape.issues.join('；'), /不存在/)
      assert.match(shape.issues.join('；'), /a-ghost/)
    }
  })

  test('INV-1 在 1+1 形态下天然成立（恰好各一个，不可能相等）——不重复校验', () => {
    // 这一条不是测试"实现"，是钉住"形态"这个契约：只要 checkGroupShape 放行，
    // executor 与 reviewer 就是两个不同的 agent（一个 id 不可能同时是两个）。
    const shape = checkGroupShape(
      makeGroup({ members: members('a-exec', 'a-rev') }),
      [executor, reviewer],
    )
    assert.ok(shape.ok)
  })
})
