import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { DomainError, DomainErrorCode } from '../errors.ts'
import {
  DEFAULT_MAX_CHAIN_DEPTH,
  assertCanDeriveRun,
  assertChainWithinDepth,
  assertNoChainCycle,
  chainStepKey,
  detectChainCycle,
  type ChainStep,
} from './bounds.ts'

const step = (subjectId: string, agentId: string, reasonCode?: string): ChainStep => ({
  subjectId,
  agentId,
  reasonCode: reasonCode ?? null,
})

describe('回路边界（INV-14~16）', () => {
  test('正常链路没有环', () => {
    const chain = [step('issue-1', 'coder'), step('run-1', 'reviewer'), step('issue-2', 'coder')]
    assert.equal(detectChainCycle(chain), null)
    assert.doesNotThrow(() => assertNoChainCycle(chain))
  })

  test('★ 短环被检出：A→B→A', () => {
    const chain = [step('s1', 'A'), step('s1', 'B'), step('s1', 'A')]
    const repeated = detectChainCycle(chain)
    assert.notEqual(repeated, null)
    assert.equal(repeated?.agentId, 'A')
  })

  test('同一 (对象, agent) 但原因码不同 —— 仍算重复（同一步在原地打转）', () => {
    const chain = [step('s1', 'A', 'r1'), step('s1', 'A', 'r1')]
    assert.notEqual(detectChainCycle(chain), null)
  })

  test('原因码不同则视为不同步（不算环）', () => {
    const chain = [step('s1', 'A', 'r1'), step('s1', 'A', 'r2')]
    assert.equal(detectChainCycle(chain), null)
  })

  test('链路上游一直变化的长链 —— 没有环但会撞深度上限', () => {
    const chain = Array.from({ length: DEFAULT_MAX_CHAIN_DEPTH + 1 }, (_, i) =>
      step(`s${i}`, `agent${i}`),
    )
    assert.equal(detectChainCycle(chain), null)
    assert.throws(
      () => assertChainWithinDepth(chain),
      (err: unknown) => {
        assert.ok(err instanceof DomainError)
        assert.equal(err.code, DomainErrorCode.ChainDepthExceeded)
        return true
      },
    )
  })

  test('★ 两条边界必须同时检查：只查深度挡不住短环', () => {
    const shortCycle = [step('s1', 'A'), step('s1', 'B'), step('s1', 'A')]
    // 深度没超
    assert.doesNotThrow(() => assertChainWithinDepth(shortCycle))
    // 但 assertCanDeriveRun 会挡住它
    assert.throws(
      () => assertCanDeriveRun(shortCycle),
      (err: unknown) => {
        assert.ok(err instanceof DomainError)
        assert.equal(err.code, DomainErrorCode.ChainCycleDetected)
        return true
      },
    )
  })

  test('深度恰好等于上限时允许', () => {
    const chain = Array.from({ length: DEFAULT_MAX_CHAIN_DEPTH }, (_, i) =>
      step(`s${i}`, `agent${i}`),
    )
    assert.doesNotThrow(() => assertCanDeriveRun(chain))
  })

  test('自定义上限可覆盖', () => {
    const chain = [step('a', 'A'), step('b', 'B')]
    assert.doesNotThrow(() => assertChainWithinDepth(chain, 2))
    assert.throws(() => assertChainWithinDepth(chain, 1))
  })

  test('chainStepKey 用不可见分隔符，避免字段拼接歧义', () => {
    // 若用 '-' 拼接，('a','b-c') 与 ('a-b','c') 会撞成同一个键
    assert.notEqual(chainStepKey(step('a', 'b-c')), chainStepKey(step('a-b', 'c')))
  })
})
