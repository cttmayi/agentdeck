import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DomainError,
  DomainErrorCode,
  ReviewerMustDifferError,
} from '../errors.ts'
import { agentId, makeReport, makeRun } from '../testing/fixtures.ts'
import {
  assertReviewerDistinct,
  isReviewerDistinct,
  reviewerCandidates,
} from './distinct.ts'

describe('reviewer ≠ executor（INV-1~3）', () => {
  const execAgent = agentId('agent-coder')
  const otherAgent = agentId('agent-reviewer')

  test('审核对象是 report 时没有约束（没有执行者可言）', () => {
    const subject = { type: 'report', report: makeReport({ id: 'r1', kind: 'ci-failure' }) } as const
    assert.doesNotThrow(() => assertReviewerDistinct(execAgent, subject))
    assert.equal(isReviewerDistinct(execAgent, subject), true)
  })

  test('★ 审核对象是同一个 agent 的执行产出 ⇒ 拒绝', () => {
    const subject = { type: 'run', run: makeRun({ id: 'run1', agentId: 'agent-coder' }) } as const
    assert.throws(
      () => assertReviewerDistinct(execAgent, subject),
      (err: unknown) => {
        assert.ok(err instanceof ReviewerMustDifferError)
        assert.equal(err.code, DomainErrorCode.ReviewerMustDiffer)
        assert.equal(err.details['agentId'], 'agent-coder')
        // 错误消息必须可读——使用者要能据此改配置
        assert.match(err.message, /不能是同一个 agent/)
        return true
      },
    )
  })

  test('审核者是别的 agent ⇒ 通过', () => {
    const subject = { type: 'run', run: makeRun({ id: 'run1', agentId: 'agent-coder' }) } as const
    assert.doesNotThrow(() => assertReviewerDistinct(otherAgent, subject))
    assert.equal(isReviewerDistinct(otherAgent, subject), true)
  })

  test('★ 不得静默降级：错误是异常，不是布尔返回', () => {
    const subject = { type: 'run', run: makeRun({ id: 'run1', agentId: 'agent-coder' }) } as const
    let threw = false
    try {
      assertReviewerDistinct(execAgent, subject)
    } catch {
      threw = true
    }
    assert.equal(threw, true)
  })

  test('候选列表把执行者剔除（UI 从交互上避免误配）', () => {
    const all = [
      { id: agentId('agent-coder'), name: 'Coder' },
      { id: agentId('agent-reviewer'), name: 'Reviewer' },
      { id: agentId('agent-security'), name: 'Security' },
    ]
    const subject = { type: 'run', run: makeRun({ id: 'run1', agentId: 'agent-coder' }) } as const
    const candidates = reviewerCandidates(all, subject)
    assert.deepEqual(
      candidates.map((c) => c.name),
      ['Reviewer', 'Security'],
    )
  })

  test('审核 report 时候选列表不剔除任何 agent', () => {
    const all = [{ id: agentId('a'), name: 'A' }]
    const subject = { type: 'report', report: makeReport({ id: 'r1', kind: 'k' }) } as const
    assert.equal(reviewerCandidates(all, subject).length, 1)
  })

  test('DomainError 的 details 是冻结的（不能被上层悄悄改掉）', () => {
    const err = new DomainError(DomainErrorCode.NotFound, 'x', { a: 1 })
    assert.equal(Object.isFrozen(err.details), true)
  })
})
