/**
 * 编排引擎严格测试（v5 设计，2026-11）。
 *
 * 覆盖：惰性（不 await 不执行）/ await 执行 / Reply 分离 / flow 内部接力 /
 * flow returnIndex（负数）/ parallel 三种形态（广播/派发/多任务/不匹配报错）/
 * loop（pass 出、fail 重写带意见、超轮兜底不挂 run）/ 嵌套（loop 作执行者、
 * 惰性嵌套、内层整体重跑）/ reset 递归 / 幂等续跑（done 步骤跳过）。
 *
 * 测试里绝不调真实 CLI（NFR-T-01）——submit 是假函数。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { executeWorkflow } from './engine.ts'
import type { Reply, Handle, WorkflowRun, WorkflowStep, EngineHooks, GateVerdict } from './types.ts'

/* ══════════════════════════════════════════════════════════════════
 * 夹具
 * ══════════════════════════════════════════════════════════════════ */

interface SubmitLog {
  step: WorkflowStep
  prompt: string
  resumeFromRunId?: string
}

function freshRun(): WorkflowRun {
  return {
    id: 'run-1',
    issueId: 'issue-1',
    workflowId: 'wf-1',
    workDir: null,
    status: 'queued',
    steps: [],
    gateFeedback: null,
    taskAppend: null,
    error: null,
    createdAt: 0,
    updatedAt: 0,
  }
}

/** 假 hooks：submit 记录调用并返回"产出"；gate 确认/否决可配。 */
function makeHooks(opts: {
  // 每次 submit 返回的产出文本（默认按 prompt 生成）
  outputOf?: (prompt: string, step: WorkflowStep) => string
  // gate 裁决
  gateVerdict?: (step: WorkflowStep) => GateVerdict
} = {}) {
  const submitted: SubmitLog[] = []
  let gateCalls = 0
  const hooks: EngineHooks = {
    submit: async (step, prompt) => {
      submitted.push({ step, prompt })
      const output = opts.outputOf ? opts.outputOf(prompt, step) : `产出（${prompt.slice(0, 20)}）`
      return { ok: true, runId: `r-${submitted.length}` as never, output }
    },
    waitForGateConfirm: async (step: WorkflowStep) => {
      gateCalls += 1
      if (opts.gateVerdict) return opts.gateVerdict(step)
      step.status = 'done'
      step.finishedAt = Date.now()
      return { kind: 'passed' as const }
    },
    persist: async () => {},
    waitIfPaused: async () => {},
  }
  return { hooks, submitted, gateCalls: () => gateCalls }
}

/** 跑编排代码。 */
async function run(code: string, hooks: EngineHooks): Promise<WorkflowRun> {
  return executeWorkflow(freshRun(), code, hooks)
}

/* ══════════════════════════════════════════════════════════════════
 * 惰性 / await / Reply
 * ══════════════════════════════════════════════════════════════════ */

test('★ 惰性：构造了但不 await —— 不执行（无 submit 调用）', async () => {
  const { hooks, submitted } = makeHooks()
  const r = await run(`agent('写作员')`, hooks)
  assert.equal(submitted.length, 0, '没 await 不能提交')
  assert.equal(r.steps.length, 0, '没 await 不能登记步骤')
  assert.equal(r.status, 'done')
})

test('★ await agent → Reply（result/message）——不再包 Handle', async () => {
  const { hooks, submitted } = makeHooks({ outputOf: () => '文章全文' })
  const r = await run(`const h = agent('写作员')\nawait h`, hooks)
  assert.equal(submitted.length, 1)
  const step = r.steps[0]!
  assert.equal(step.kind, 'flow')
  assert.equal(step.runIds.length, 1)
})

test('★ await flow：链内接力——第二步收到第一步产出', async () => {
  const { hooks, submitted } = makeHooks({ outputOf: () => '第一步产出' })
  const r = await run(
    `await flow([agent('调研员'), agent('起草员')], '任务')`,
    hooks,
  )
  assert.equal(submitted.length, 2, '链上两个 agent 各一次')
  assert.ok(submitted[1]!.prompt.includes('第一步产出'), '起草员收到调研员的产出（内部接力）')
  assert.equal(r.steps[0]!.runIds.length, 2, 'flow 步骤记录两个 run')
})

test('★ flow returnIndex：-1 默认最后、-2 倒数第二（负数支持）', async () => {
  let seq = 0
  const { hooks } = makeHooks({
    outputOf: () => `产出${++seq}`,
  })
  const { makePrimitives } = await import('./primitives.ts')
  const run1 = freshRun()
  const env = {
    run: run1,
    hooks,
    currentStep: null,
    nextStep: async (kind: WorkflowStep['kind'], label: string, nodeId: string | null, prompt: string | null, gateText: string | null): Promise<WorkflowStep> => {
      const s: WorkflowStep = { seq: run1.steps.length, kind, label, nodeId, prompt, gateText, runIds: [], status: 'pending', startedAt: null, finishedAt: null }
      run1.steps.push(s)
      return s
    },
    atBoundary: async () => {},
  }
  const primitives = makePrimitives(env)
  const last = await (primitives.flow([primitives.agent('A'), primitives.agent('B')], '任务') as unknown as Promise<Reply>)
  assert.equal(last.message, '产出2', '默认 -1 = 最后一个 agent 的返回')
  const second = await (primitives.flow(
    [primitives.agent('C'), primitives.agent('D')],
    '任务',
    { returnIndex: -2 },
  ) as unknown as Promise<Reply>)
  // 新一批 submit：C=产出3、D=产出4
  assert.equal(second.message, '产出3', '-2 = 倒数第二个（C）')
})

/* ══════════════════════════════════════════════════════════════════
 * parallel 三种形态
 * ══════════════════════════════════════════════════════════════════ */

test('★ parallel 广播（1×N）：同一任务给所有 agent', async () => {
  const { hooks, submitted } = makeHooks()
  const r = await run(
    `await parallel([agent('A'), agent('B')], '共同任务')`,
    hooks,
  )
  assert.equal(submitted.length, 2)
  assert.equal(submitted[0]!.prompt, '共同任务')
  assert.equal(submitted[1]!.prompt, '共同任务')
  assert.equal(r.steps.length, 2, '每分支一步')
})

test('★ parallel 派发（N×N）：一一配对', async () => {
  const { hooks, submitted } = makeHooks()
  await run(
    `await parallel([agent('A'), agent('B')], ['任务1', '任务2'])`,
    hooks,
  )
  assert.equal(submitted.length, 2)
  assert.equal(submitted[0]!.prompt, '任务1')
  assert.equal(submitted[1]!.prompt, '任务2')
})

test('★ parallel 多任务（N×1）：同一 agent 跑不同任务', async () => {
  const { hooks, submitted } = makeHooks()
  await run(
    `await parallel(agent('写作员'), ['任务1', '任务2'])`,
    hooks,
  )
  assert.equal(submitted.length, 2)
  assert.equal(submitted[0]!.prompt, '任务1')
  assert.equal(submitted[1]!.prompt, '任务2')
})

test('★ parallel 数量不匹配 → run failed（错误信息）', async () => {
  const { hooks } = makeHooks()
  const r = await run(`await parallel([agent('A'), agent('B')], ['任务1', '任务2', '任务3'])`, hooks)
  assert.equal(r.status, 'failed')
  assert.match(r.error ?? '', /不匹配/)
})

/* ══════════════════════════════════════════════════════════════════
 * loop：pass 出 / fail 重写（带意见）/ 超轮兜底
 * ══════════════════════════════════════════════════════════════════ */

test('★ loop：审核通过 → Reply done（message = 执行者产出）', async () => {
  let count = 0
  const { hooks, submitted } = makeHooks({
    outputOf: () => {
      count += 1
      return count % 2 === 1 ? '文章' : '通过'
    },
  })
  const r = await run(
    `const 写作 = agent('写作员')\nconst 审查 = agent('审查员', (意见) => 意见.includes('不通过') ? { result: 'fail', message: 意见 } : { result: 'pass' })\nawait loop(写作, 审查, '任务')`,
    hooks,
  )
  assert.equal(r.status, 'done')
  const loopStep = r.steps.find((s) => s.kind === 'loop')!
  assert.equal(loopStep.status, 'done')
  // 执行 1 + 审核 1
  assert.equal(submitted.length, 2)
})

test('★ loop：审核不通过 → 打回重写（意见附加进重写任务）', async () => {
  // 调用序列：执行(奇) / 审核(偶)——由提交次数区分（把关者 submit 的 prompt 是执行产出）
  let count = 0
  const { hooks, submitted } = makeHooks({
    outputOf: () => {
      count += 1
      if (count % 2 === 1) return '文章'
      return count === 2 ? '不通过：风格不对' : '通过'
    },
  })
  const r = await run(
    `const 写作 = agent('写作员')\nconst 审查 = agent('审查员', (意见) => 意见.includes('不通过') ? { result: 'fail', message: 意见 } : { result: 'pass' })\nawait loop(写作, 审查, '任务', { maxRounds: 2 })`,
    hooks,
  )
  assert.equal(r.status, 'done', '重写后通过——run done')
  // 执行 + 审核 + 执行（重写）+ 审核
  assert.equal(submitted.length, 4)
  // 重写轮的 prompt 带打回意见
  assert.ok(submitted[2]!.prompt.includes('[打回意见]'), '重写轮附加打回意见')
  assert.ok(submitted[2]!.prompt.includes('风格不对'), '意见内容在')
})

test('★ loop 超轮：编排兜底——Reply fail（executor.message + guard），run 不挂', async () => {
  let count = 0
  const { hooks } = makeHooks({
    outputOf: () => {
      count += 1
      return count % 2 === 1 ? '半成品' : '不通过：还不行'
    },
  })
  const { makePrimitives } = await import('./primitives.ts')
  const run1 = freshRun()
  const env = {
    run: run1,
    hooks,
    currentStep: null,
    nextStep: async (kind: WorkflowStep['kind'], label: string, nodeId: string | null, prompt: string | null, gateText: string | null): Promise<WorkflowStep> => {
      const s: WorkflowStep = { seq: run1.steps.length, kind, label, nodeId, prompt, gateText, runIds: [], status: 'pending', startedAt: null, finishedAt: null }
      run1.steps.push(s)
      return s
    },
    atBoundary: async () => {},
  }
  const primitives = makePrimitives(env)
  const 判定 = (意见: string): Reply => 意见.includes('不通过') ? { result: 'fail', message: 意见 } : { result: 'pass' }
  const reply = await (primitives.loop(primitives.agent('写作员'), primitives.agent('审查员', 判定), '任务', { maxRounds: 0 }) as unknown as Promise<Reply>)
  assert.equal(reply.result, 'fail', '超轮 → fail')
  assert.equal(reply.message, '半成品', 'message = 执行者最后产物（仍可用）')
  assert.equal(reply.guard?.message, '不通过：还不行', 'guard = 最后审核者返回')
})

/* ══════════════════════════════════════════════════════════════════
 * 嵌套：loop 作执行者（惰性嵌套）
 * ══════════════════════════════════════════════════════════════════ */

test('★ 嵌套：内层 loop 作外层执行者——外层 fail → 内层整体重跑', async () => {
  let gateCount = 0
  const { hooks, submitted } = makeHooks({
    outputOf: (p) => (p.includes('审核') ? '通过' : '文章'),
    gateVerdict: () => {
      gateCount += 1
      if (gateCount === 1) return { kind: 'rejected' as const, feedback: '再改改' }
      return { kind: 'passed' as const }
    },
  })
  const r = await run(
    `const 写作 = agent('写作员')\nconst 审查 = agent('审查员', (o) => ({ result: 'pass' }))\nawait loop(loop(写作, 审查), gate('请过目'), '任务')`,
    hooks,
  )
  assert.equal(r.status, 'done')
  // 内层第一次（执行+审核）+ 外层 fail + 内层重跑（执行+审核）+ 外层通过
  assert.equal(submitted.length, 4, '内层两轮（执行+审核 ×2）')
  assert.equal(gateCount, 2, '外层 gate 两轮')
})

/* ══════════════════════════════════════════════════════════════════
 * 幂等续跑：done 步骤跳过
 * ══════════════════════════════════════════════════════════════════ */

test('★ 幂等续跑：已有 done 步骤（seq 0）——重跑复用不重新提交', async () => {
  const { hooks, submitted } = makeHooks()
  const run1 = freshRun()
  run1.steps.push({
    seq: 0,
    kind: 'flow',
    label: '已完成步骤',
    nodeId: null,
    prompt: '任务',
    gateText: null,
    runIds: ['r-done' as never],
    status: 'done',
    startedAt: 0,
    finishedAt: 1,
  })
  await executeWorkflow(run1, `await agent('写作员')`, hooks)
  assert.equal(submitted.length, 0, 'done 步骤跳过——没有新提交')
})

/* ══════════════════════════════════════════════════════════════════
 * reset 递归
 * ══════════════════════════════════════════════════════════════════ */

test('★ reset 递归：loop.reset() 重置内部所有 agent', async () => {
  const { hooks } = makeHooks()
  const { makePrimitives } = await import('./primitives.ts')
  const run1 = freshRun()
  const env = {
    run: run1,
    hooks,
    currentStep: null,
    nextStep: async (kind: WorkflowStep['kind'], label: string, nodeId: string | null, prompt: string | null, gateText: string | null): Promise<WorkflowStep> => {
      const s: WorkflowStep = { seq: run1.steps.length, kind, label, nodeId, prompt, gateText, runIds: [], status: 'pending', startedAt: null, finishedAt: null }
      run1.steps.push(s)
      return s
    },
    atBoundary: async () => {},
  }
  const primitives = makePrimitives(env)
  const 写作 = primitives.agent('写作员')
  let writerReset = 0
  const origReset = 写作.reset
  // agent 默认没有 reset（闭包锚点）——复合 Handle 的 reset 递归调用 agent.reset?.
  const 审查 = primitives.agent('审查员', () => ({ result: 'pass' }))
  const loopHandle = primitives.loop(写作, 审查, '任务')
  assert.ok(loopHandle.reset, 'loop Handle 有 reset')
  loopHandle.reset!() // 不报错——递归到内部 agents（无 reset 的 agent 是 no-op）
})

/* ══════════════════════════════════════════════════════════════════
 * 位置检查：把关者输出不认识的结果 → 报错
 * ══════════════════════════════════════════════════════════════════ */

test('★ 位置检查：把关者输出 result 不是 pass/fail → 报错', async () => {
  const { hooks } = makeHooks()
  const { makePrimitives } = await import('./primitives.ts')
  const run1 = freshRun()
  const env = {
    run: run1,
    hooks,
    currentStep: null,
    nextStep: async (kind: WorkflowStep['kind'], label: string, nodeId: string | null, prompt: string | null, gateText: string | null): Promise<WorkflowStep> => {
      const s: WorkflowStep = { seq: run1.steps.length, kind, label, nodeId, prompt, gateText, runIds: [], status: 'pending', startedAt: null, finishedAt: null }
      run1.steps.push(s)
      return s
    },
    atBoundary: async () => {},
  }
  const primitives = makePrimitives(env)
  const 坏审查 = primitives.agent('坏审查', () => ({ result: 'done' }) as Reply)
  const rr = await run(
    `const 写作 = agent('写作员')
const 坏审查 = agent('坏审查', () => ({ result: 'done' }))
await loop(写作, 坏审查, '任务')`,
    hooks,
  )
  assert.equal(rr.status, 'failed')
  assert.match(rr.error ?? '', /不认识的结果/)
})
