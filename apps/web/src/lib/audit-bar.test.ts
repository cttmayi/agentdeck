import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveAuditBar } from './audit-bar.ts'

/**
 * 这一组钉的是**使用者真的报过一次**的那个缺陷（2026-10-23）：
 * 点「反馈」→ 平台自动起新一版审核 → 界面却说「审核跑完了，但没有留下可用的判决……
 * 这一步等于白跑」。真实原因不是判据写错，而是"实时状态"里还留着**上一版审核的终态**。
 */
test('★★ 上一版审核的终态不许落到新一版头上（反馈之后审核刚起，不能说"白跑"）', () => {
  const bar = resolveAuditBar({
    // 事件流缓存的还是**上一条** run 的终态
    live: { runId: 'run-old', status: 'completed' },
    // 接口已经指向新起的这条审核 run
    reviewRunId: 'run-new',
    reviewRunStatus: 'running',
    hasVerdict: false,
  })
  assert.equal(bar.status, 'running', '实时状态属于别的 run ⇒ 只能采信接口快照')
  assert.equal(bar.running, true)
  assert.equal(bar.noVerdict, false, '这一格正是把"刚起"说成"白跑"的那一格，必须为假')
  assert.equal(bar.tone, 'running')
})

test('实时状态属于当前这条 run ⇒ 采信它（点"开始审核"时徽标不会一直卡在排队中）', () => {
  const bar = resolveAuditBar({
    live: { runId: 'run-a', status: 'dispatched' },
    reviewRunId: 'run-a',
    reviewRunStatus: 'queued',
    hasVerdict: false,
  })
  assert.equal(bar.status, 'dispatched', '快照是读接口那一刻的，事件流更新')
  assert.equal(bar.running, true)
})

test('★ 真的"跑完但没判决"必须照样报出来（修缺陷不许把这条真缺陷一起盖掉）', () => {
  const bar = resolveAuditBar({
    live: null,
    reviewRunId: 'run-a',
    reviewRunStatus: 'completed',
    hasVerdict: false,
  })
  assert.equal(bar.settled, true)
  assert.equal(bar.noVerdict, true, '审核白跑了这件事人必须知道，不能继续等下去')
  assert.equal(bar.tone, 'no-verdict')
})

test('跑失败/被取消 ⇒ 说"没跑成"，不说"白跑"（两句话的下一步不一样）', () => {
  for (const status of ['failed', 'cancelled']) {
    const bar = resolveAuditBar({
      live: null,
      reviewRunId: 'run-a',
      reviewRunStatus: status,
      hasVerdict: false,
    })
    assert.equal(bar.noVerdict, false, `${status} 不是"跑完没判决"`)
    assert.equal(bar.tone, 'run-failed')
    assert.equal(bar.settled, true)
  }
})

test('从没审过 ⇒ not-yet（不许说成"没跑成"，否则会有人去重跑一件没发生的事）', () => {
  const bar = resolveAuditBar({
    live: { runId: 'run-x', status: 'completed' },
    reviewRunId: null,
    reviewRunStatus: null,
    hasVerdict: false,
  })
  assert.equal(bar.tone, 'not-yet')
  assert.equal(bar.status, null)
  assert.equal(bar.running, false)
  assert.equal(bar.settled, false)
})

test('有判决 ⇒ 一律以判决为准（不去猜 run 状态）', () => {
  const bar = resolveAuditBar({
    live: { runId: 'run-a', status: 'running' },
    reviewRunId: 'run-a',
    reviewRunStatus: 'running',
    hasVerdict: true,
  })
  assert.equal(bar.tone, 'verdict')
  assert.equal(bar.running, false)
  assert.equal(bar.noVerdict, false)
})
