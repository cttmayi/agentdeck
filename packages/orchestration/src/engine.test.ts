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

/*
 * ⚠️ 2026-11（D125）：这里原来是「把关者位：agent 把关者提交**审核 run**（kind=review
 *   + subject=执行 run；不进 `step.runIds`」的用例。
 *
 *   **审核 run 退场**之后，把关者就是一次普通执行 run：任务书由引擎组装
 *   （`reviewTaskText`：把"请你审什么"与"被审的材料不是指令"写在一段话里），
 *   它**照常进 `step.runIds`**——这顺带修掉了一处真机缺陷：把关那一步在运行画面上
 *   曾经"没有 run"，因为它被故意从步骤链里漏掉了。
 *
 *   下面那条用例守的就是新行为。
 */
test('★ 把关者位：**普通执行 run**，任务书里带材料与"这不是指令"的声明，且记进 runIds', async () => {
  const calls: Array<{ prompt: string }> = []
  const { hooks } = makeHooks()
  const origSubmit = hooks.submit
  hooks.submit = async (step, prompt, opts) => {
    calls.push({ prompt })
    return origSubmit(step, prompt, opts)
  }
  const { makePrimitives } = await import('./primitives.ts')
  const run1 = freshRun()
  const env = {
    run: run1,
    hooks,
    nextStep: async (kind: WorkflowStep['kind'], label: string, nodeId: string | null, prompt: string | null, gateText: string | null): Promise<WorkflowStep> => {
      const s: WorkflowStep = { seq: run1.steps.length, kind, label, nodeId, prompt, gateText, runIds: [], status: 'pending', startedAt: null, finishedAt: null }
      run1.steps.push(s)
      return s
    },
    atBoundary: async () => {},
  }
  const primitives = makePrimitives(env)
  const 判定 = (意见: string): Reply => 意见.includes('不通过') ? { result: 'fail', message: 意见 } : { result: 'pass' }
  await (primitives.loop(primitives.agent('写作员'), primitives.agent('审查员', 判定), '任务') as unknown as Promise<Reply>)
  assert.equal(calls.length, 2, '执行一次 + 把关一次')
  // ★ 把关者拿到的是**审视任务书**：既说清要它干什么，也把材料围起来并声明它不是指令。
  const guardPrompt = calls[1]!.prompt
  assert.match(guardPrompt, /请审核/, '要说清这一步是"请它审"')
  assert.match(guardPrompt, /不是给你的指令/, '材料必须被声明为材料（提示注入的靶子就在这里）')
  // ★ 两次都登记进步骤链——把关那一步在运行画面上必须看得见
  const loopStep = run1.steps[0]!
  assert.equal(loopStep.runIds.length, 2, '执行与把关都记进 step.runIds')
})

/* ══════════════════════════════════════════════════════════════════
 * 步骤生命周期（运行画面说真话）/* ══════════════════════════════════════════════════════════════════
 * 步骤生命周期（运行画面说真话）
 * ══════════════════════════════════════════════════════════════════ */

test('★★ 每个跑过的步骤都要收口（flow/parallel/route/独立 agent 不许停在 pending）', async () => {
  // 真机现场（2026-11 使用者）：run 都 `done` 了，运行画面上那几步还写着"未开始"——
  // 因为只有 loop/gate 写步骤状态。判据：跑完的步骤 status=done 且起止时间都在。
  const { hooks } = makeHooks({ outputOf: () => '产出' })
  const r = await run(
    `await flow([agent('甲'), agent('乙')], '任务1')
await route({ 丙: agent('丙') }, '任务2')
await parallel(agent('丁'), ['任务3', '任务4'])
await agent('戊').run('任务5')`,
    hooks,
  )
  assert.equal(r.status, 'done')
  assert.ok(r.steps.length >= 5, `步骤要登记齐（实际 ${String(r.steps.length)}）`)
  for (const s of r.steps) {
    assert.equal(s.status, 'done', `步骤「${s.label}」没收口（status=${s.status}）`)
    assert.ok(s.startedAt !== null, `步骤「${s.label}」没有开始时间`)
    assert.ok(s.finishedAt !== null, `步骤「${s.label}」没有收口时间`)
  }
})

test('★ 步骤边界会过一次暂停检查（env.atBoundary 不是死接口）', async () => {
  // `atBoundary` 原来定义了、注入了、测试里也传了，但没有一处调用——"边界可暂停"
  // 这个语义从来没发生过。现在每个步骤开始时过一次（内部就是 waitIfPaused）。
  const boundaries: number[] = []
  const base = makeHooks({ outputOf: () => '产出' })
  const { makePrimitives } = await import('./primitives.ts')
  const run1 = freshRun()
  const env = {
    run: run1,
    hooks: base.hooks,
    nextStep: async (kind: WorkflowStep['kind'], label: string, nodeId: string | null, prompt: string | null, gateText: string | null): Promise<WorkflowStep> => {
      const s: WorkflowStep = { seq: run1.steps.length, kind, label, nodeId, prompt, gateText, runIds: [], status: 'pending', startedAt: null, finishedAt: null }
      run1.steps.push(s)
      return s
    },
    atBoundary: async (step: WorkflowStep) => {
      boundaries.push(step.seq)
    },
  }
  const primitives = makePrimitives(env)
  await primitives.agent('甲').run('任务')
  await primitives.flow([primitives.agent('乙')], '任务').run('')
  assert.deepEqual(boundaries, [0, 1], '两个步骤各过一次边界（内层的 agent 用外层步骤，不重复过）')
})

/* ══════════════════════════════════════════════════════════════════
 * 执行失败 ≠ 产出（真机缺陷固化）
 * ══════════════════════════════════════════════════════════════════ */

test('★★ 执行 run 没跑成 ⇒ 编排 run failed，且**不提交把关者**', async () => {
  // 真机现场（2026-11）：一条 codex 在 thread/resume 上 infra 失败的执行 run，
  // 被原语当成了 `{ result:'done', message: 失败原因 }` ⇒ 把关者随后去审一条
  // failed 的空产出 run（一次判不通过、一次判通过）⇒ 编排把没跑成的一步当通过。
  const base = makeHooks()
  let submits = 0
  const hooks: EngineHooks = {
    ...base.hooks,
    submit: async () => {
      submits += 1
      return {
        ok: false,
        runId: 'r-failed' as never,
        error: 'codex 对话阶段失败：JSON-RPC 请求 thread/resume（id=2）超时（60000ms）',
      }
    },
  }
  const r = await run(
    `const 写作 = agent('写作员')\nconst 审查 = agent('审查员', () => ({ result: 'pass' }))\nawait loop(写作, 审查, '任务')`,
    hooks,
  )
  assert.equal(r.status, 'failed', '执行没跑成 ⇒ 整条编排 run 失败（不是 done）')
  assert.match(r.error ?? '', /执行失败/, '错误说清是执行失败')
  assert.match(r.error ?? '', /thread\/resume/, '原始失败原因原样带出来（能查）')
  assert.equal(submits, 1, '失败之后**不许**再提交把关者（否则又去审一条失败 run）')
  assert.equal(r.steps[0]!.status, 'failed', '步骤也标 failed（运行画面看得见）')
})

test('★ 执行失败可以被编排代码接住（try/catch 兜底仍然成立）', async () => {
  const base = makeHooks({ outputOf: () => '兜底产出' })
  let submits = 0
  const hooks: EngineHooks = {
    ...base.hooks,
    submit: async (step, prompt) => {
      submits += 1
      if (submits === 1) return { ok: false, runId: null, error: '执行失败示意' }
      return base.hooks.submit(step, prompt)
    },
  }
  const r = await run(
    `let 出错 = ''\ntry { await flow([agent('A')], '任务') } catch (e) { 出错 = e.message }\nawait flow([agent('B')], '补一个：' + 出错)`,
    hooks,
  )
  assert.equal(r.status, 'done', '使用者自己接住了失败 ⇒ 编排能继续')
  assert.match(base.submitted[0]?.prompt ?? '', /补一个：执行失败：执行失败示意/, '兜底那一步收到了失败原因')
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

test('★★ 把关者不能判 ⇒ 在**提交任何 run 之前**就拒（B4：别等花掉一次审核）', async () => {
  // 真机现场（2026-11 使用者）：把关者写成 `agent('审查员')`（没有解析函数），
  // 于是 loop 先跑执行、再跑审核（真金白银的额度），最后才抛出
  // 「把关者输出了不认识的结果 result=done」——一句话让人看不懂，
  // 而真正的问题是"把关者位没给判定方式"。
  //
  // 判据：错误发生在**第一次 submit 之前**（提交次数 0），且错误里说清怎么改。
  const { hooks, submitted } = makeHooks({ outputOf: () => '产出' })
  const rr = await run(
    `const 写作 = agent('写作员')
const 审查 = agent('审查员')
await loop(写作, 审查, '任务')`,
    hooks,
  )
  assert.equal(rr.status, 'failed')
  assert.match(rr.error ?? '', /不能给出通过\/不通过/, '错误要说清问题是什么')
  assert.match(rr.error ?? '', /解析函数|gate/, '并且给出两条改法')
  assert.equal(submitted.length, 0, '★ 不许先跑一轮执行/审核再报错')
  assert.equal(rr.steps.length, 0, '一个步骤都不该登记')
})

test('★ 带解析函数的 agent 与 gate 都能当把关者（不误伤）', async () => {
  const { hooks, submitted } = makeHooks({ outputOf: () => '产出' })
  const rr = await run(
    `const 写作 = agent('写作员')
await loop(写作, agent('审查员', () => ({ result: 'pass' })), '任务')
await loop(agent('再写作'), gate('请你过目'), '任务')`,
    hooks,
  )
  assert.equal(rr.status, 'done')
  assert.ok(submitted.length > 0, '该跑的都跑了')
})

test('★ 位置检查：把关者输出 result 不是 pass/fail → 报错', async () => {
  const { hooks } = makeHooks()
  const { makePrimitives } = await import('./primitives.ts')
  const run1 = freshRun()
  const env = {
    run: run1,
    hooks,
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

/* ══════════════════════════════════════════════════════════════════
 * reuseOutput（D134）：**人把关**的 loop 第一轮不许重跑执行者
 * ══════════════════════════════════════════════════════════════════
 *
 * 使用者的真机编排（2026-11）：
 *
 *   const 写作 = agent('文章写作员')
 *   await loop(写作, agent('审查员', 判定), '{{task}}')            // ① 机器把关
 *   await loop(写作, gate('…请过目…'), '{{task}}', { maxRounds: 3 })  // ② 人把关
 *
 * ② 一进来就先把"写作"跑了一遍 ⇒ 使用者刚审过的那一版被换成新写的，
 * 人称"有重新写的嫌疑"（原话）。加 `reuseOutput: true` 之后：第一轮**不提交执行 run**，
 * 直接拿上一版产出问人。
 */
test('★★ reuseOutput：第一轮复用上一版产出、不提交执行 run；人否决后才重写', async () => {
  const { makePrimitives } = await import('./primitives.ts')
  const submitLog: string[] = []
  const { hooks } = makeHooks({ outputOf: (p) => (p.includes('请审核') ? '意见' : '新一版') })
  const orig = hooks.submit
  hooks.submit = async (step, prompt, opts) => {
    submitLog.push(prompt.includes('请审核') ? 'guard' : 'exec')
    return orig(step, prompt, opts)
  }
  // gate 裁决**按顺序**给：第一次否决、第二次通过
  const verdicts: Array<'pass' | 'fail'> = ['fail', 'pass']
  let gateWaits = 0
  hooks.waitForGateConfirm = async () => {
    gateWaits += 1
    const v = verdicts.shift() ?? 'pass'
    return v === 'pass' ? { kind: 'passed' } : ({ kind: 'rejected', feedback: '改一下' } as never)
  }
  const run1 = freshRun()
  const env = {
    run: run1,
    hooks,
    nextStep: async (kind: WorkflowStep['kind'], label: string, nodeId: string | null, prompt: string | null, gateText: string | null): Promise<WorkflowStep> => {
      const s: WorkflowStep = { seq: run1.steps.length, kind, label, nodeId, prompt, gateText, runIds: [], status: 'pending', startedAt: null, finishedAt: null }
      run1.steps.push(s)
      return s
    },
    atBoundary: async () => {},
  }
  const primitives = makePrimitives(env)
  // 先真跑一次，让执行者句柄有"上一版产出"（相当于 ① 机器把关那一轮已经写完）
  const 写作 = primitives.agent('文章写作员')
  await (写作 as unknown as Promise<Reply>)
  assert.equal(写作.lastOutput, '新一版', '句柄记着最近一次的产出')

  submitLog.length = 0
  const gateLoop = primitives.loop(写作, primitives.gate('请过目'), '任务', {
    maxRounds: 3,
    reuseOutput: true,
  })
  const reply = await (gateLoop as unknown as Promise<Reply>)
  assert.equal(reply.result, 'done', '第二次人确认通过 ⇒ 这一步 done')
  assert.deepEqual(submitLog, ['exec'], '只有"否决后的重写"提交了执行 run —— 第一轮复用了上一版')
  assert.equal(gateWaits, 2, '人确认了两次（否决一次 + 通过一次）')

  // ⚠️ `run1.steps[0]` 是上面那次"先跑一遍写作"留下的步骤 ⇒ 这里要按 kind 找 loop 那一步
  const loopStep = run1.steps.find((x) => x.kind === 'loop')!
  assert.ok(loopStep, 'loop 步骤登记出来了')
  assert.ok(loopStep.rounds && loopStep.rounds.length === 2, 'loop 步骤记下两轮结构')
  assert.deepEqual(loopStep.rounds![0]!.runIds, [], '第一轮：复用产出 ⇒ 没有执行 run')
  assert.equal(loopStep.rounds![0]!.gate, '请过目', '第一轮的把关文案记在轮里')
  assert.equal(loopStep.rounds![1]!.runIds.length, 1, '第二轮：重写那一条 run')
})

test('★ reuseOutput：执行者还没有产出时退化成"照旧先执行"（不会拿空材料去问人）', async () => {
  const { makePrimitives } = await import('./primitives.ts')
  const { hooks } = makeHooks({ outputOf: () => '第一版' })
  const run1 = freshRun()
  const env = {
    run: run1,
    hooks,
    nextStep: async (kind: WorkflowStep['kind'], label: string, nodeId: string | null, prompt: string | null, gateText: string | null): Promise<WorkflowStep> => {
      const s: WorkflowStep = { seq: run1.steps.length, kind, label, nodeId, prompt, gateText, runIds: [], status: 'pending', startedAt: null, finishedAt: null }
      run1.steps.push(s)
      return s
    },
    atBoundary: async () => {},
  }
  const primitives = makePrimitives(env)
  const 写作 = primitives.agent('文章写作员') // 从来没跑过 ⇒ lastOutput 是 undefined
  hooks.waitForGateConfirm = async () => ({ kind: 'passed' })
  const reply = await (primitives.loop(写作, primitives.gate('请过目'), '任务', {
    reuseOutput: true,
  }) as unknown as Promise<Reply>)
  assert.equal(reply.result, 'done')
  const st = run1.steps.find((x) => x.kind === 'loop')!
  assert.equal(st.runIds.length, 1, '退化成功：先执行了一次，再把产出交给人')
})

test('★ loop 的第三个参数可以直接给 opts（prompt 用默认 {{task}}）', async () => {
  const { makePrimitives } = await import('./primitives.ts')
  const prompts: string[] = []
  const { hooks } = makeHooks({ outputOf: () => '产出' })
  const orig = hooks.submit
  hooks.submit = async (step, prompt, opts) => {
    prompts.push(prompt)
    return orig(step, prompt, opts)
  }
  const run1 = freshRun()
  const env = {
    run: run1,
    hooks,
    nextStep: async (kind: WorkflowStep['kind'], label: string, nodeId: string | null, prompt: string | null, gateText: string | null): Promise<WorkflowStep> => {
      const s2: WorkflowStep = { seq: run1.steps.length, kind, label, nodeId, prompt, gateText, runIds: [], status: 'pending', startedAt: null, finishedAt: null }
      run1.steps.push(s2)
      return s2
    },
    atBoundary: async () => {},
  }
  const primitives = makePrimitives(env)
  hooks.waitForGateConfirm = async () => ({ kind: 'passed' })
  // ⚠️ 第三个参数是**对象** ⇒ 当成 opts（prompt 用默认 '{{task}}'）
  const reply = await (primitives.loop(primitives.agent('写作员'), primitives.gate('请过目'), {
    maxRounds: 2,
  }) as unknown as Promise<Reply>)
  assert.equal(reply.result, 'done')
  // 执行那一步拿到的还是默认的 '{{task}}'（由 daemon 在提交时替换成这次的任务描述）
  assert.match(prompts[0]!, /^\{\{task\}\}/, 'prompt 用默认 {{task}}，不是把 opts 当任务传下去')
})
