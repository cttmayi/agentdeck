/**
 * 编排引擎（executeWorkflow）——驱动编排代码执行。
 *
 * 与 daemon 解耦：submitStep / 等人确认 / 持久化全部经 EngineHooks 注入。
 * 步骤登记（幂等键 = seq）在这里统一——原语闭包 Env（nextStep/atBoundary）。
 *
 * 惰性语义：构造器返回 Handle（不执行）；`await handle`（thenable）或 run()
 * 才执行。没 await 的句柄不会执行（不登记步骤）——因此**不需要** v2 的
 * "忘 await 兜底"（不 await = 不跑，语义明确）。
 */

import type { WorkflowRun, WorkflowStep, EngineHooks } from './types.ts'
import { makePrimitives, type Env, type Primitives } from './primitives.ts'

/** 一个空步骤（nextStep 模板）。 */
function makeStep(
  seq: number,
  kind: WorkflowStep['kind'],
  label: string,
  nodeId: string | null,
  prompt: string | null,
  gateText: string | null,
): WorkflowStep {
  const now = Date.now()
  return {
    seq,
    kind,
    label,
    nodeId,
    prompt,
    gateText,
    runIds: [],
    status: 'pending',
    startedAt: null,
    finishedAt: null,
  }
}

/** 从已有步骤链恢复（续跑：按 seq 复用已完成步骤）。 */
function findDoneStep(run: WorkflowRun, seq: number): WorkflowStep | undefined {
  return run.steps.find((s) => s.seq === seq)
}

/**
 * 执行一段编排代码。
 *
 * @param run   运行实例（步骤链/状态写回）
 * @param code  编排代码（JS 字符串——原语注入执行）
 * @param hooks 执行侧交互（提交/等人/持久化/暂停）
 */
export async function executeWorkflow(
  run: WorkflowRun,
  code: string,
  hooks: EngineHooks,
): Promise<WorkflowRun> {
  const now = (): number => Date.now()
  let nextSeq = 0

  const env: Env = {
    run,
    hooks,
    // 登记步骤（幂等：同 seq 已 done → 复用并跳过——续跑）
    nextStep: async (kind, label, nodeId, prompt, gateText) => {
      const seq = nextSeq++
      const existing = findDoneStep(run, seq)
      if (existing && existing.status === 'done') {
        return existing
      }
      const step = existing ?? makeStep(seq, kind, label, nodeId, prompt, gateText)
      if (!existing) run.steps.push(step)
      return step
    },
    atBoundary: async () => {
      await hooks.waitIfPaused()
    },
  }

  const primitives = makePrimitives(env)

  run.status = 'running'
  run.error = null
  await hooks.persist(run)

  try {
    // 用户代码：原语作为参数注入（AsyncFunction——支持 await 编排代码）
    const AsyncFunction = Object.getPrototypeOf(async function () {})
      .constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>
    const fn = new AsyncFunction(
      'agent',
      'gate',
      'flow',
      'parallel',
      'loop',
      'route',
      code,
    )
    await fn(
      primitives.agent,
      primitives.gate,
      primitives.flow,
      primitives.parallel,
      primitives.loop,
      primitives.route,
    )
    // 惰性：没 await 的句柄不执行——无需兜底。执行到的步骤已收口。
    run.status = 'done'
  } catch (err) {
    run.status = 'failed'
    run.error = err instanceof Error ? err.message : String(err)
  } finally {
    run.updatedAt = now()
    await hooks.persist(run)
  }
  return run
}
