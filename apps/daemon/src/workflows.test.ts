import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  WORKFLOW_TEMPLATES,
  executeWorkflow,
  loadWorkflowRuns,
  loadWorkflows,
  saveWorkflowRuns,
  saveWorkflows,
  type EngineHooks,
  type WorkflowRun,
  type WorkflowStep,
} from './workflows.ts'
import type { RunId, WorkspaceId } from '@agentdeck/protocol'

/**
 * ★ 测试临时目录必须建在仓库内 `.cache/test-tmp`（硬约束：测试不许用系统 tmpdir）。
 * 这里不用 tmpdir()——直接建在仓库内。
 */
const TMP = join(process.cwd(), '.cache', 'test-tmp', `workflows-${process.pid}`)

function freshRun(steps: WorkflowStep[] = []): WorkflowRun {
  return {
    id: 'run-1',
    issueId: 'iss-1',
    workflowId: 'wf-1',
    workDir: null,
    status: 'queued',
    steps,
    gateFeedback: null,
    error: null,
    createdAt: 0,
    updatedAt: 0,
  }
}

/** 假提交：记录调用，按设定成功/失败。 */
function makeHooks(opts: {
  submitted?: Array<{ prompt: string; step: WorkflowStep }>
  failSteps?: number[]
  submit?: (step: WorkflowStep, prompt: string) => Promise<{ ok: boolean; runId: RunId | null }>
}): EngineHooks {
  const base = async (step: WorkflowStep, prompt: string) => {
    opts.submitted?.push({ prompt, step })
    if (opts.failSteps?.includes(step.seq)) {
      return { ok: false, runId: null, error: `假失败（步骤 ${step.seq}）` }
    }
    return { ok: true, runId: `run-${step.seq}-${opts.submitted?.length ?? 0}` as RunId }
  }
  return {
    persist: async () => {},
    waitIfPaused: async () => {},
    waitForGateConfirm: async () => ({ kind: 'passed' as const }),
    submit: opts.submit ?? base,
  }
}

test('★ 存储往返：saveWorkflows/loadWorkflows（原子写 + 读回；坏 JSON = 空数组）', async () => {
  await rm(TMP, { recursive: true, force: true })
  await saveWorkflows(TMP, [])
  assert.deepEqual(await loadWorkflows(TMP), [])
  await saveWorkflows(TMP, [
    {
      id: 'w1',
      workspaceId: 'ws1' as WorkspaceId,
      name: '测试编排',
      code: 'await flow(groupA, "hi")',
      source: 'manual',
      templateKey: null,
      inlineAgents: [],
      createdAt: 1,
      updatedAt: 1,
    },
  ])
  const loaded = await loadWorkflows(TMP)
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0]!.name, '测试编排')
  // 坏 JSON 不炸
  await writeFile(join(TMP, 'workflows.json'), 'not json{{{', 'utf8')
  assert.deepEqual(await loadWorkflows(TMP), [])
})

test('★ flow 单步：提交一次组跑，run 完成，步骤 done', async () => {
  const submitted: Array<{ prompt: string; step: WorkflowStep }> = []
  const run = freshRun()
  const out = await executeWorkflow(
    run,
    `await flow('groupA', '要做什么')`,
    makeHooks({ submitted }),
  )
  assert.equal(out.status, 'done')
  assert.equal(out.steps.length, 1)
  assert.equal(out.steps[0]!.kind, 'flow')
  assert.equal(out.steps[0]!.status, 'done')
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0]!.prompt, '要做什么')
})

test('★ 顺序数组：flow([A,B]) 提交两次', async () => {
  const submitted: Array<{ prompt: string; step: WorkflowStep }> = []
  const run = freshRun()
  const out = await executeWorkflow(run, `await flow(['groupA', 'groupB'], '接力')`, makeHooks({ submitted }))
  assert.equal(out.status, 'done')
  assert.equal(out.steps.length, 2)
  assert.equal(submitted.length, 2)
})

test('★ 续跑幂等：已有 done 步骤在重跑时跳过（不重新提交）', async () => {
  const submitted: Array<{ prompt: string; step: WorkflowStep }> = []
  const prior = freshRun()
  // 第一遍：跑完一个 flow
  await executeWorkflow(prior, `await flow('groupA', '干活')`, makeHooks({ submitted }))
  assert.equal(submitted.length, 1)
  // 第二遍（模拟续跑）：同一个 run 对象带着 done 步骤重跑
  const out = await executeWorkflow(prior, `await flow('groupA', '干活')`, makeHooks({ submitted }))
  assert.equal(out.status, 'done')
  assert.equal(submitted.length, 1, 'done 步骤不能重新提交')
  assert.equal(out.steps[0]!.status, 'done')
})

test('★ 失败步骤报错、run failed', async () => {
  const run = freshRun()
  const out = await executeWorkflow(run, `await flow('groupA', '干活')`, makeHooks({ failSteps: [1] }))
  assert.equal(out.status, 'failed')
  assert.ok(out.error)
  assert.equal(out.steps[0]!.status, 'failed')
})

test('★ gate：挂起成 waiting-human，confirm 后继续、run 完成', async () => {
  const run = freshRun()
  let released = false
  const hooks = makeHooks({})
  hooks.waitForGateConfirm = async () => {
    // 模拟确认：把 gate 步骤标记 done（confirm API 做的事）
    const g = run.steps.find((s) => s.kind === 'gate')
    if (g) {
      g.status = 'done'
      g.finishedAt = Date.now()
    }
    released = true
    return { kind: 'passed' as const }
  }
  const out = await executeWorkflow(
    run,
    `await flow('groupA', '干活')\nawait gate('结果请你过目')`,
    hooks,
  )
  assert.ok(released, 'gate 必须等过确认')
  assert.equal(out.status, 'done')
  assert.equal(out.steps.length, 2)
  assert.equal(out.steps[1]!.kind, 'gate')
  assert.equal(out.steps[1]!.status, 'done')
})

test('★ parallel：一个步骤、多次提交、runIds 全收', async () => {
  const submitted: Array<{ prompt: string; step: WorkflowStep }> = []
  const run = freshRun()
  const out = await executeWorkflow(
    run,
    `await parallel(['groupA', 'groupB'], '分头干')`,
    makeHooks({ submitted }),
  )
  assert.equal(out.status, 'done')
  assert.equal(out.steps.length, 1)
  assert.equal(out.steps[0]!.kind, 'parallel')
  assert.equal(out.steps[0]!.runIds.length, 2)
  assert.equal(submitted.length, 2)
})

test('★ loop：第一次失败自动重试到 maxRounds', async () => {
  const submitted: Array<{ prompt: string; step: WorkflowStep }> = []
  const run = freshRun()
  const out = await executeWorkflow(
    run,
    `await loop('groupA', '写代码', { maxRounds: 2 })`,
    makeHooks({ submitted, failSteps: [1] }),
  )
  assert.equal(out.status, 'failed', '3 轮（1+2）全失败 ⇒ failed')
  assert.equal(submitted.length, 3, '首次 + 2 次重试')
  assert.equal(out.steps[0]!.status, 'failed')
})

test('★ route：按关键字选组', async () => {
  const submitted: Array<{ prompt: string; step: WorkflowStep }> = []
  const run = freshRun()
  const out = await executeWorkflow(
    run,
    `await route('写一段代码', { 代码: 'groupCode', 写作: 'groupWrite' })`,
    makeHooks({ submitted }),
  )
  assert.equal(out.status, 'done')
  assert.equal(out.steps[0]!.nodeId, 'groupCode')
})

test('★ gate 否决（带意见）：打回重跑——步骤链重置、意见随下一轮、再等确认', async () => {
  const run = freshRun()
  const submitted: Array<{ prompt: string; step: WorkflowStep }> = []
  let gateCalls = 0
  const hooks = makeHooks({ submitted })
  hooks.waitForGateConfirm = async () => {
    gateCalls += 1
    // 第一轮否决（带意见）；第二轮通过
    if (gateCalls === 1) return { kind: 'rejected', feedback: '风格不对，重写' }
    return { kind: 'passed' }
  }
  const out = await executeWorkflow(
    run,
    `await flow('groupA', '{{task}}')\nawait gate('结果请你过目')`,
    hooks,
  )
  assert.equal(out.status, 'done', '打回一轮后应正常完成')
  assert.equal(gateCalls, 2, 'gate 要等两轮确认')
  assert.equal(out.gateFeedback, '风格不对，重写')
  assert.equal(submitted.length, 2, '打回后写作步骤重新提交一次')
  // 步骤链：flow 步骤跑了两轮（两个 runId 都留着作历史）
  const flowStep = out.steps.find((x) => x.kind === 'flow')
  assert.ok(flowStep, 'flow 步骤在')
  assert.equal(flowStep!.runIds.length, 2, '两轮各有一个 runId（同一步骤累积）')
  assert.equal(out.steps.length, 2, '步骤链不重复（第二轮复用第一轮的步骤对象）')
  // 第二轮提交的 prompt 要带打回意见（submitStep 在 server 拼；这里引擎透传）
  assert.equal(submitted[1]!.prompt, '{{task}}', '引擎透传原样（意见拼接在 server 的占位符替换里）')
})

test('★ gate 连续否决超过 3 轮：run failed（不无限打转）', async () => {
  const run = freshRun()
  const hooks = makeHooks({})
  hooks.waitForGateConfirm = async () => ({ kind: 'rejected', feedback: '还是不行' })
  const out = await executeWorkflow(run, `await gate('过目')`, hooks)
  assert.equal(out.status, 'failed')
  assert.match(out.error ?? '', /打回 3 次仍未通过/)
})

test('★ 暂停在步骤边界生效：paused 时引擎挂起，resume 后继续', async () => {
  const submitted: Array<{ prompt: string; step: WorkflowStep }> = []
  const run = freshRun()
  const waiters: Array<() => void> = []
  const hooks = makeHooks({ submitted })
  // 第一步的 submit 手动挂住：暂停窗口 = 第一步提交中（引擎在 runStep 的 await 里）。
  // ⚠️ 用对象包装释放函数：TS 的控制流分析看不到闭包里的赋值（`let x = null` 在
  //    回调里赋值后，外面的 `x?.()` 仍按 null 处理、报 not callable——实测踩过）。
  const firstGate: { release: (() => void) | null } = { release: null }
  hooks.submit = async (step, prompt) => {
    submitted.push({ prompt, step })
    if (step.seq === 1) {
      await new Promise<void>((resolve) => {
        firstGate.release = () => resolve()
      })
    }
    return { ok: true, runId: 'r' as RunId }
  }
  hooks.waitIfPaused = () =>
    run.status === 'paused'
      ? new Promise<void>((resolve) => waiters.push(resolve))
      : Promise.resolve()
  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const p = executeWorkflow(run, `await flow('groupA', '干活')\nawait flow('groupB', '收尾')`, hooks)
  // 引擎进第一步 submit（挂住）→ 置 paused → 放行第一步 → 引擎到第二步边界挂起
  await tick(20)
  assert.equal(submitted.length, 1, '第一步已提交')
  run.status = 'paused'
  firstGate.release?.()
  await tick(20)
  assert.equal(submitted.length, 1, 'paused 时第二步不能提交')
  // 第二步已在边界**登记**（步骤链上可见、status pending）但没提交——登记不算跑，
  // 暂停是"在步骤边界生效"，不是"回滚到上一步"。
  assert.equal(run.steps.length, 2, '第二步已登记')
  assert.equal(run.steps[1]!.status, 'pending')
  // resume：置 running + 放行等待器 → 引擎继续走完
  run.status = 'running'
  for (const w of waiters) w()
  await p
  assert.equal(submitted.length, 2, 'resume 后第二步提交')
  assert.equal(run.status, 'done')
})

test('★ 模板清单：七个固定模板都在（UI「从模板」入口的数据源）', () => {
  const keys = WORKFLOW_TEMPLATES.map((t) => t.key)
  for (const k of ['single-flow', 'sequential', 'parallel', 'loop', 'route', 'supervise', 'gate']) {
    assert.ok(keys.includes(k), `模板 ${k} 必须存在`)
  }
})

test('★ 运行实例存储往返', async () => {
  await rm(TMP, { recursive: true, force: true })
  await saveWorkflowRuns(TMP, [freshRun()])
  const loaded = await loadWorkflowRuns(TMP)
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0]!.id, 'run-1')
})
