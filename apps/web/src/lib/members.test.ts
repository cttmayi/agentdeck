import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Agent } from './api.ts'
import { agentEntries, hasEntry, isHalfBuiltinAgent, isPlatformMember } from './members.ts'

/**
 * 界面侧的**平台成员判据**（2026-11，D147）。
 *
 * 为什么这几条要单独钉：D145 把"只读 / 能不能派活"从 `builtin` 移到 `owner` + `entries`
 * 之后，界面还有 8 处照旧写 `agent.builtin === true`。两侧一旦分叉，出现的都不是小毛病：
 *   · **半内置**（`builtin: true` 但没有认得出的岗位）被界面锁成只读，而服务端允许改、
 *     允许删 ⇒ "看着能改、实际改不了"，或者反过来（界面放行、服务端 400）；
 *   · 已下线的 `skill-reviewer` 被当成平台成员 ⇒ 一条能删的智能体被放进"不能删"那一组。
 *
 * 这里钉的就是"**判据只有一份口径**"：服务端给了值就用它，没给才按老字段推，
 * 而推法的结果必须与 daemon 的 `ownerOf()` / `isHalfBuiltin()` 一致。
 */

function agent(patch: Partial<Agent>): Agent {
  // 只填 `lib/api.ts` 里 `Agent` 真有的字段（多写一个是类型错误——界面侧的
  // `Agent` 是**服务端返回的投影**，不是 protocol 里的实体，两边字段本来就不一样）。
  return {
    id: 'a1',
    name: '某人',
    instructions: '',
    workDir: null,
    skillIds: [],
    model: null,
    runtimeKey: 'claude',
    reviewStandard: null,
    ...patch,
  }
}

describe('★ 平台成员判据：读 owner，老数据才回退到 builtin + 岗位', () => {
  test('服务端给了 owner ⇒ 就是它（半内置/退役岗位都不再靠 builtin 猜）', () => {
    assert.equal(isPlatformMember(agent({ owner: 'platform', builtin: true })), true)
    assert.equal(isPlatformMember(agent({ owner: 'user', builtin: true })), false)
  })

  test('★ 半内置（builtin 但没有岗位）**不是**平台成员——不能被界面锁成只读', () => {
    const half = agent({ builtin: true })
    assert.equal(isPlatformMember(half), false)
    assert.equal(isHalfBuiltinAgent(half), true, '但要标出来：配置是坏的')
  })

  test('★ 已下线的 skill-reviewer 归用户（能改能删），且**不算**配置损坏', () => {
    const retired = agent({ builtin: true, builtinKind: 'skill-reviewer' })
    assert.equal(isPlatformMember(retired), false)
    assert.equal(isHalfBuiltinAgent(retired), false, '它有明确的岗位值，只是那条流程下线了')
  })

  test('认得出的岗位 ⇒ 平台成员（老响应没有 owner 的那条路）', () => {
    for (const kind of ['drafter', 'memory-tidy', 'agent-maker', 'workflow-maker'] as const) {
      const a = agent({ builtin: true, builtinKind: kind })
      assert.equal(isPlatformMember(a), true, kind)
      assert.equal(isHalfBuiltinAgent(a), false, kind)
    }
  })

  test('服务端给的 halfBuiltin 优先（列表接口算好的那份）', () => {
    assert.equal(isHalfBuiltinAgent(agent({ owner: 'user', halfBuiltin: true })), true)
    assert.equal(isHalfBuiltinAgent(agent({ owner: 'user', halfBuiltin: false })), false)
  })
})

describe('★ 接入点兜底：与上面的判据同一份口径', () => {
  test('服务端给了 entries ⇒ 原样用（不在这里再算一遍）', () => {
    assert.deepEqual(agentEntries(agent({ owner: 'user', entries: ['task'] })), ['task'])
    assert.deepEqual(agentEntries(agent({ owner: 'platform', entries: [] })), [])
  })

  test('老响应：普通智能体三项全开，平台成员保守给空', () => {
    assert.deepEqual(agentEntries(agent({})), ['chat', 'task', 'workflow'])
    assert.deepEqual(agentEntries(agent({ builtin: true, builtinKind: 'drafter' })), [])
  })

  test('★ 老响应里的半内置 ⇒ 三项全开（不是空，也不是平台成员）', () => {
    const half = agent({ builtin: true })
    assert.deepEqual(agentEntries(half), ['chat', 'task', 'workflow'])
    assert.equal(hasEntry(half, 'task'), true)
  })

  test('hasEntry 与 agentEntries 是同一份数据的两种问法', () => {
    const a = agent({ owner: 'user', entries: ['workflow'] })
    assert.equal(hasEntry(a, 'workflow'), true)
    assert.equal(hasEntry(a, 'task'), false, '「能不能派活」与「能不能被编排引用」是两件事')
  })
})
