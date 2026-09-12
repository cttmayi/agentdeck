import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { PIPELINE_COLUMNS, stageOf } from './pipeline.ts'
import type { RunSummary } from './api.ts'

/**
 * 任务流水线的阶段推导。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这段逻辑为什么值得单独测
 * ══════════════════════════════════════════════════════════════════
 *
 * 它的边界情况（重试、执行失败、没配审核者）都**很难手动复现**——
 * 要真的跑失败、真的造一条重试链。而它们恰恰是最容易判错的地方。
 *
 * 尤其要紧的是那条**链**：审核 run 的 subject 是**执行 run 的 id**，
 * 不是 issue。按 issue 直接找 review run 会一条也找不到。那个 bug 我犯过一次。
 */

function run(over: Partial<RunSummary> & { runId: string; kind: string }): RunSummary {
  return {
    status: 'completed',
    agentId: 'a1',
    subject: { type: 'issue', id: 'i1' },
    workDir: '/w',
    lastSeq: 0,
    queuedAt: 1000,
    finishedAt: 2000,
    failureReason: null,
    chainDepth: 0,
    ...over,
  }
}

const ISSUE = 'i1'

describe('★ 阶段推导：以**最新一次执行**为锚点', () => {
  test('一条执行 run 都没有 ⇒ 第一列（还没开始）', () => {
    const info = stageOf(ISSUE, [])
    assert.equal(info.stage, 'executing')
    assert.equal(info.detail, '还没开始执行')
    assert.equal(info.executeRun, null)
  })

  test('执行中 ⇒ 第一列', () => {
    const info = stageOf(ISSUE, [run({ runId: 'e1', kind: 'execute', status: 'running' })])
    assert.equal(info.stage, 'executing')
    assert.equal(info.detail, '执行中')
  })

  test('★ 等目录释放时说清楚，而不是含糊的"进行中"', () => {
    // 这个状态可能停很久，而"进行中"会让人以为在跑
    const info = stageOf(ISSUE, [
      run({ runId: 'e1', kind: 'execute', status: 'waiting_local_directory' }),
    ])
    assert.match(info.detail, /排队中/)
    assert.match(info.detail, /目录被占用/)
  })

  test('★ 执行完成、审核未跑 ⇒ 第二列，并指出"没有派审核"', () => {
    // 这是**配置问题**（agent 没配「由谁审它」），不是运行故障。
    // 只显示"等待审核"会让人一直等一个不会来的东西。
    const info = stageOf(ISSUE, [run({ runId: 'e1', kind: 'execute', status: 'completed' })])
    assert.equal(info.stage, 'awaiting_review')
    assert.equal(info.detail, '等待审核')
    assert.match(String(info.warning), /没有派审核/)
    assert.match(String(info.warning), /由谁来审它/, '要指出去哪里改')
  })

  test('审核进行中 ⇒ 第二列，不报警', () => {
    const info = stageOf(ISSUE, [
      run({ runId: 'e1', kind: 'execute', status: 'completed' }),
      run({ runId: 'r1', kind: 'review', status: 'running', subject: { type: 'run', id: 'e1' } }),
    ])
    assert.equal(info.stage, 'awaiting_review')
    assert.equal(info.detail, '审核中')
    assert.equal(info.warning, null)
  })

  test('★ 审核完成 ⇒ 第三列', () => {
    const info = stageOf(ISSUE, [
      run({ runId: 'e1', kind: 'execute', status: 'completed' }),
      run({ runId: 'r1', kind: 'review', status: 'completed', subject: { type: 'run', id: 'e1' } }),
    ])
    assert.equal(info.stage, 'reviewed')
    assert.equal(info.reviewRun?.runId, 'r1')
  })
})

describe('★ 那条链：审核的 subject 是**执行 run 的 id**，不是 issue', () => {
  test('★ 按 issue 找 review run 会一条也找不到 —— 必须顺着链走', () => {
    // 审核 run 的 subject 是 `{type:'run', id: 执行runId}`。
    // 如果实现里写成"按 issue 过滤 review run"，这里就会判成"没有派审核"，
    // 而实际上审核已经完成了。症状是卡片永远停在第二列。
    const info = stageOf(ISSUE, [
      run({ runId: 'e1', kind: 'execute', status: 'completed' }),
      run({ runId: 'r1', kind: 'review', status: 'completed', subject: { type: 'run', id: 'e1' } }),
    ])
    assert.equal(info.stage, 'reviewed', '★ 顺着 issue→执行run→审核run 这条链才找得到')
  })

  test('审核 run 指向**别的**执行时不算数', () => {
    const info = stageOf(ISSUE, [
      run({ runId: 'e1', kind: 'execute', status: 'completed' }),
      // 这条审核是审另一次执行的，与 e1 无关
      run({ runId: 'r9', kind: 'review', status: 'completed', subject: { type: 'run', id: 'e99' } }),
    ])
    assert.equal(info.stage, 'awaiting_review', '不能把无关的审核算到这条执行头上')
  })

  test('别的 issue 的执行 run 不参与', () => {
    const info = stageOf(ISSUE, [
      run({ runId: 'other', kind: 'execute', status: 'running', subject: { type: 'issue', id: 'i2' } }),
    ])
    assert.equal(info.executeRun, null, '只看这个 issue 的执行')
  })
})

describe('★ 重试：以**最新**那次为准', () => {
  test('★ 旧执行已完成、新执行在跑 ⇒ 第一列（不是第二列）', () => {
    const info = stageOf(ISSUE, [
      run({ runId: 'e1', kind: 'execute', status: 'completed', queuedAt: 1000 }),
      run({ runId: 'e2', kind: 'execute', status: 'running', queuedAt: 5000 }),
    ])
    assert.equal(info.stage, 'executing', '新的那次还在跑，就不该显示成"待审查"')
  })

  test('★ 最新执行已有完成的审核 ⇒ 第三列，即使更早有失败的执行', () => {
    const info = stageOf(ISSUE, [
      run({ runId: 'e1', kind: 'execute', status: 'failed', queuedAt: 1000 }),
      run({ runId: 'e2', kind: 'execute', status: 'completed', queuedAt: 5000 }),
      run({ runId: 'r2', kind: 'review', status: 'completed', queuedAt: 6000, subject: { type: 'run', id: 'e2' } }),
    ])
    assert.equal(info.stage, 'reviewed')
  })

  test('旧执行有审核、新执行没有 ⇒ 第二列（新那次的审核还没跑）', () => {
    const info = stageOf(ISSUE, [
      run({ runId: 'e1', kind: 'execute', status: 'completed', queuedAt: 1000 }),
      run({ runId: 'r1', kind: 'review', status: 'completed', queuedAt: 2000, subject: { type: 'run', id: 'e1' } }),
      run({ runId: 'e2', kind: 'execute', status: 'completed', queuedAt: 5000 }),
    ])
    assert.equal(info.stage, 'awaiting_review')
  })
})

describe('★ 失败的执行要说明，不能静静躺在"待审查"里', () => {
  test('★ 执行失败 ⇒ 第二列 + 明确的失败提示', () => {
    // 失败的执行**不会**有审核结果——没有产出可审。只显示"等待审核"
    // 会让人一直等。
    const info = stageOf(ISSUE, [
      run({ runId: 'e1', kind: 'execute', status: 'failed', failureReason: 'infra_error' }),
    ])
    assert.equal(info.stage, 'awaiting_review')
    assert.match(String(info.warning), /执行失败/)
    assert.match(String(info.warning), /infra_error/, '原因要带出来')
  })

  test('被取消的执行说"被取消"，不说"失败"', () => {
    const info = stageOf(ISSUE, [
      run({ runId: 'e1', kind: 'execute', status: 'cancelled' }),
    ])
    assert.match(String(info.warning), /被取消/)
  })

  test('执行成功但没派审核时，提示的是"没派审核"而不是"失败"', () => {
    const info = stageOf(ISSUE, [run({ runId: 'e1', kind: 'execute', status: 'completed' })])
    assert.match(String(info.warning), /没有派审核/)
    assert.ok(!String(info.warning).includes('失败'))
  })
})

describe('三列的定义', () => {
  test('顺序就是流水线方向', () => {
    assert.deepEqual(
      PIPELINE_COLUMNS.map((c) => c.id),
      ['executing', 'awaiting_review', 'reviewed'],
    )
  })

  test('三列各有标题与说明', () => {
    for (const col of PIPELINE_COLUMNS) {
      assert.ok(col.title.length > 0)
      assert.ok(col.hint.length > 0)
    }
  })
})
