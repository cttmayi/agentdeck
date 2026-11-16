import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { executorCandidates } from './newtask-chain.ts'
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
  })
})
