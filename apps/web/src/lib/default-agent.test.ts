import assert from 'node:assert/strict'
import { get } from 'svelte/store'
import { describe, test } from 'node:test'
import type { Agent } from './api.ts'
import { agents, defaultAgentId, effectiveDefaultAgentId } from './stores.ts'

/**
 * ★ 2026-11（D152）：**「谁是默认执行者」也读接入点，不读岗位字段**。
 *
 * 原来这里写的是 `a.builtinKind === undefined`（"不是内置岗位就当执行者"）——岗位字段
 * 兼职能力开关，正是 D145 要拆掉的那一层。判据换成 `hasEntry(a, 'task')` 之后，
 * "能不能当默认"与"能不能派活"是同一句话（服务端 `PUT /api/agents/default` 用的
 * 就是 `canBeDispatched`），于是"设得了默认、派不动活"这种组合不可能出现。
 */

function agent(id: string, patch: Partial<Agent> = {}): Agent {
  return {
    id,
    name: id,
    instructions: '',
    workDir: null,
    skillIds: [],
    model: null,
    runtimeKey: 'claude',
    reviewStandard: null,
    ...patch,
  }
}

function withStores(list: Agent[], preferred: string | null): string | null {
  agents.set(list)
  // `defaultAgentId` 是 writable，直接摆上"库里那个值"
  defaultAgentId.set(preferred)
  return get(effectiveDefaultAgentId) as string | null
}

describe('★ 默认执行者：判据是接入点里有 task **和** chat', () => {
  test('设过的那个在列表里就用它', () => {
    assert.equal(withStores([agent('a1'), agent('a2')], 'a2'), 'a2')
  })

  test('★ 设过的那个没有 task 入口 ⇒ 不认它（悬空/不合法一律当没设）', () => {
    const noTask = agent('x', { owner: 'user', entries: ['chat'] })
    assert.equal(withStores([agent('a1'), noTask], 'x'), 'a1', '退回第一个能派活的')
  })

  test('★ 平台成员**不会**被选成默认（它默认没有 task 入口）', () => {
    const member = agent('m', { owner: 'platform', builtin: true, entries: ['action:skill-draft'] })
    assert.equal(withStores([member, agent('a1')], null), 'a1')
  })

  test('★★ 两个接入点都要有：只有 task 不够（能接活却聊不了），只有 chat 也不够', () => {
    /*
     * ★ 2026-11（D161）：默认智能体要**同时**具备「任务」与「聊天」——那条任务跑起来之后
     *   人还要能接着跟它聊。只有一边的组合在界面上不该被选成默认。
     */
    const taskOnly = agent('t', { owner: 'user', entries: ['task'] })
    assert.equal(withStores([taskOnly], null), null, '只有任务 ⇒ 不合格')
    const chatOnly = agent('c', { owner: 'user', entries: ['chat'] })
    assert.equal(withStores([chatOnly], null), null, '只有聊天 ⇒ 不合格')
    assert.equal(withStores([chatOnly, taskOnly], null), null, '两个都不是"两个都有"')
  })

  test('★★ 两个都有就合格——判据是数据，不是岗位', () => {
    const memberWithTask = agent('m', {
      owner: 'platform',
      builtin: true,
      builtinKind: 'drafter',
      entries: ['chat', 'task'],
    })
    assert.equal(
      withStores([agent('a1'), memberWithTask], null),
      'a1',
      '列表顺序优先：第一个合格的是 a1',
    )
    assert.equal(withStores([memberWithTask], null), 'm', '只有它一个合格时就是它')
  })

  test('一条合格的都没有 ⇒ null（界面据此显示"先去建一个"）', () => {
    assert.equal(withStores([agent('c', { owner: 'user', entries: ['chat'] })], null), null)
  })
})
