import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Agent } from '@agentdeck/protocol'
import {
  checkWorkflowAgentRefs,
  literalAgentNamesInWorkflowCode,
  resolveWorkflowAgent,
} from './workflow-agents.ts'

/**
 * ★ 2026-11（D163）：**编排按名字找人，重名必须报错而不是静默取第一个**。
 *
 * 由来：使用者问「当前自建和内置都有叫『助手』，这个编排是找的哪个？」
 * ——改之前引擎是 `agents.find(a => a.name === name)`：**静默取列表里第一个**
 * （≈ 更早创建的那条），界面、采纳校验、运行日志一个字都不说。而智能体的名字
 * 从来没有唯一约束 ⇒ 这是一个能配出来的、"看起来生效了"的二选一。
 */

/**
 * 测试夹具：只填判据用得到的字段。
 * ⚠️ `Agent['id']` 是**品牌类型**（`string & $brand<'AgentId'>`），测试里写 `'a1'` 过不了
 *   类型检查——所以这里放宽成 `Record<string, unknown>` 再断言成 `Agent`
 *   （与 `chat.test.ts` 里那些 agent 夹具同一做法）。
 */
function agent(patch: Record<string, unknown> & { id: string; name: string }): Agent {
  const { id, ...rest } = patch
  return {
    id,
    workspaceId: 'ws',
    instructions: '',
    model: null,
    runtimeKey: 'default',
    workDir: null,
    skillIds: [],
    env: {},
    reviewStandard: null,
    createdAt: 0,
    updatedAt: 0,
    owner: 'user',
    entries: ['chat', 'task', 'workflow'],
    ...rest,
  } as unknown as Agent
}

/**
 * 把一组 agent 变成 `getAgentByName` 的返回形状（D231：解析函数的入参换成了"查找结果"）。
 * 名字全等匹配；多条 ⇒ ambiguous（与存储层同一口径）。
 */
function lookup(agents: ReadonlyArray<Agent>, name: string): {
  kind: 'found'
  agent: Agent
} | { kind: 'ambiguous'; agents: Agent[] } | { kind: 'none' } {
  const hits = agents.filter((a) => (a.name as string) === name)
  if (hits.length === 0) return { kind: 'none' }
  if (hits.length > 1) return { kind: 'ambiguous', agents: hits }
  return { kind: 'found', agent: hits[0]! }
}

describe('★ 编排里的名字解析：唯一才放行', () => {
  test('唯一且能接编排 ⇒ 解析出那一条', () => {
    const a = agent({ id: 'a1', name: '撰稿员' })
    const r = resolveWorkflowAgent(lookup([a], '撰稿员'), '撰稿员')
    assert.equal(r.ok, true)
    assert.equal(r.ok === true ? (r.agent.id as string) : '', 'a1')
  })

  test('没有这个名字 ⇒ agent_not_found', () => {
    const r = resolveWorkflowAgent(lookup([agent({ id: 'a1', name: '撰稿员' })], '助手'), '助手')
    assert.equal(r.ok, false)
    assert.equal(r.ok === false && r.code, 'agent_not_found')
  })

  test('★★★ 两条同名（自建 + 内置）⇒ agent_ambiguous，并点名是哪几条', () => {
    const mine = agent({ id: 'mine-1', name: '助手' })
    const builtin = agent({
      id: 'builtin-1',
      name: '助手',
      owner: 'platform',
      entries: ['chat', 'task', 'workflow'],
    })
    const r = resolveWorkflowAgent(lookup([mine, builtin], '助手'), '助手')
    assert.equal(r.ok, false, '重名时不许"随便挑一条"')
    assert.equal(r.ok === false && r.code, 'agent_ambiguous')
    const error = r.ok === false ? r.error : ''
    assert.match(error, /有 2 条同名智能体/)
    assert.match(error, /你自己的（mine-1）/, '要点名自建那条')
    assert.match(error, /平台成员（builtin-1）/, '要点名平台那条')
    assert.match(error, /改名/, '要说清怎么解决')
  })

  test('★ 名字唯一但那条没有 workflow 接入点 ⇒ agent_not_referenceable', () => {
    const platformOnly = agent({
      id: 'p1',
      name: '起草者',
      owner: 'platform',
      entries: ['action:skill-draft'],
    })
    const r = resolveWorkflowAgent(lookup([platformOnly], '起草者'), '起草者')
    assert.equal(r.ok, false)
    assert.equal(r.ok === false && r.code, 'agent_not_referenceable')
  })

  test('★ 两条同名、但其中一条不接编排：仍然算歧义（先解决重名，再谈接入点）', () => {
    const mine = agent({ id: 'mine-1', name: '助手' })
    const platformOnly = agent({
      id: 'p1',
      name: '助手',
      owner: 'platform',
      entries: ['action:skill-draft'],
    })
    const r = resolveWorkflowAgent(lookup([mine, platformOnly], '助手'), '助手')
    assert.equal(r.ok === false && r.code, 'agent_ambiguous')
  })
})

describe('★ 采纳之前的歧义体检（与引擎同一句话）', () => {
  test('代码里的字面量名字抓得出来（拼出来的不算）', () => {
    assert.deepEqual(
      literalAgentNamesInWorkflowCode(
        `const a = agent('甲')\nconst b = agent("乙")\nconst c = agent(变量)\nconst d = agent('甲')`,
      ),
      ['甲', '乙'],
      '去重，且不猜变量',
    )
  })

  test('★★ 有重名 ⇒ 体检不通过（返回与引擎同一条错误）', async () => {
    const agents = [
      agent({ id: 'mine-1', name: '助手' }),
      agent({ id: 'builtin-1', name: '助手', owner: 'platform' }),
      agent({ id: 'w1', name: '撰稿员' }),
    ]
    const out = await checkWorkflowAgentRefs(
      async (name) => lookup(agents, name),
      `await flow([agent('撰稿员'), agent('助手')])`,
    )
    assert.equal(out.ok, false)
    assert.equal(out.ok === false && out.code, 'agent_ambiguous')
  })

  test('都能唯一解析 ⇒ 通过', async () => {
    const agents = [agent({ id: 'w1', name: '撰稿员' }), agent({ id: 'w2', name: '审稿员' })]
    assert.equal(
      (
        await checkWorkflowAgentRefs(
          async (name) => lookup(agents, name),
          `await flow([agent('撰稿员'), agent('审稿员')])`,
        )
      ).ok,
      true,
    )
  })

  test('代码里一个 agent(...) 都没有 ⇒ 通过（空代码不是这里的问题）', async () => {
    assert.equal(
      (await checkWorkflowAgentRefs(async () => ({ kind: 'none' }), `await flow([])`)).ok,
      true,
    )
  })
})
