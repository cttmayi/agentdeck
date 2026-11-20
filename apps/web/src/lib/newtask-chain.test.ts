import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { executorCandidates } from './newtask-chain.ts'
import { memberLabel } from './members.ts'
import type { Agent } from './api.ts'

/*
 * 新建任务页唯一还要推导的那件事：**交给谁执行**。
 *
 * ⚠️ 2026-11（D125）：这个文件原来测的是一整条链——「谁审」（三态：不点名 /
 *   明确不审 / 点名，以及"请求体里那个 key 到底写不写"）、组的审核者解析、
 *   动作白名单、返工次数。**审核 run 与判决退场**、动作与返工早已退场 ⇒ 那些
 *   用例全部失去对象，整块删。
 *
 *   ⚠️ 其中最有价值的一条纪律仍然成立（留给将来任何"省略 = 跟随、给值 = 覆盖"
 *   的三态字段）：**「没改」必须是「键不出现」，不能是「发一个等于默认的值」**
 *   ——后者让服务端分不清"跟随"与"明确设成默认"。
 */

function agent(over: Partial<Agent> & { id: string }): Agent {
  return {
    name: over.id,
    instructions: '',
    skillIds: [],
    runtimeKey: 'default',
    ...over,
  } as Agent
}

/*
 * ⚠️ 2026-11（S3）：这里原来是「组的执行者」那一组（按角色从成员里挑执行者、
 *   成员被删返回 null、私有成员也认）。智能体组退场 ⇒ 整组删。
 */

describe('执行者候选', () => {
  test('★ 只把**非内置岗位**的 agent 列出来（平台内置的那几个不该接任务）', () => {
    /*
     * ⚠️ 2026-11（S4，D127）：这条原来叫「只把执行者列出来（审核者不该接任务）」。
     *   **角色退场**之后，唯一还不能派活的是**平台内置岗位**；用户建的一律可选
     *   （包括他自己在指令里写成"我是审阅者"的那种——平台不再替他分类）。
     */
    const all = [
      agent({ id: 'e1' }),
      agent({ id: 'r1', builtin: true, builtinKind: 'drafter' }),
      agent({ id: 'e2' }),
    ]
    assert.deepEqual(
      executorCandidates(all).map((a) => a.id),
      ['e1', 'e2'],
    )
    /*
     * ★ 2026-11（D145）：判据换成**接入点**（`entries` 里有 `task`）。老 fixture（只有
     *   `builtin` + `builtinKind`）仍然被正确排除——`entriesOf()` 会从老字段回退。
     *   另外新增一条：**不可选的也要列出来**（"显示出来，只是置灰"）。
     */
          /*
       * ⚠️ 2026-11（D165）：这里原来断言"没有 task 入口的平台成员**显示出来但置灰**"
       *   （D145 的口径）。使用者改了口径（"任务在选择交给谁，如上类似逻辑"）⇒ 它们
       *   **根本不出现**，那份清单也就不存在了。
       */
    // 显式 entries 优先于老字段：把起草者改成能派活，它就该进候选
    const promoted = agent({ id: 'r2', entries: ['chat', 'task'] })
    assert.deepEqual(executorCandidates([promoted]).map((a) => a.id), ['r2'])
  })
})


/**
 * ★★ 2026-11（D165）：**下拉里只出现"真能接这个活"的那些**，且内置成员名带「（内置）」。
 *
 * 由来：使用者两句话——「沉淀起草者不应该显示出来（入口没有勾对话）」与「显示名称，
 * 如果是内置智能体，后面括号增加『（内置）』的标识」。这推翻了 D145 的"显示但置灰"：
 * 现在每个成员接了哪些入口，详情页的「入口」那一格写得很清楚，所以下拉里不必再留
 * 一个永远选不了的选项。
 */
describe('★ 任务执行者候选：只留能接活的，内置的带标识', () => {
  const user = (id: string, name: string, entries: string[]): Agent =>
    ({ id, name, owner: 'user', entries }) as unknown as Agent
  const platform = (id: string, name: string, entries: string[]): Agent =>
    ({ id, name, owner: 'platform', entries }) as unknown as Agent

  test('★★ 没有 task 入口的平台成员**不出现**（起草者 / 整理者 / 两个生成者）', () => {
    const all = [
      user('u1', '我的执行者', ['chat', 'task', 'workflow']),
      platform('a1', '助手', ['chat', 'task', 'workflow']),
      platform('d1', '沉淀起草者', ['action:skill-draft']),
      platform('m1', '记忆整理者', ['action:memory-tidy']),
      platform('k1', '智能体生成者', ['chat', 'action:agent-commit']),
    ]
    assert.deepEqual(
      executorCandidates(all).map((a) => a.name),
      ['我的执行者', '助手'],
      '只有真接了 task 的两条（自建 + 助手）',
    )
  })

  test('★★ 显示名：内置成员后面补「（内置）」，自建的不加', () => {
    const suffix = '（内置）'
    assert.equal(memberLabel(platform('a1', '助手', ['task']), suffix), '助手（内置）')
    assert.equal(memberLabel(user('u1', '我的执行者', ['task']), suffix), '我的执行者')
  })
})
