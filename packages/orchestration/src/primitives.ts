/**
 * 原语实现（v5）：所有构造器只**构造惰性 Handle**（不执行）；`await handle`
 * （thenable）或 `handle.run(input)` 才执行。
 *
 * 环境（Env）由引擎注入——原语闭包它：步骤登记（幂等）、暂停边界、submitStep
 * 等全部走 Env（与 daemon 解耦——hooks 注入）。
 */

import type { Reply, Handle, WorkflowRun, WorkflowStep, EngineHooks } from './types.ts'

/* ══════════════════════════════════════════════════════════════════
 * 环境（engine 注入）
 * ══════════════════════════════════════════════════════════════════ */

export interface Env {
  /** 当前编排 run（步骤登记/状态写回）。 */
  run: WorkflowRun
  /** 执行侧 hooks（提交/等人/持久化）。 */
  hooks: EngineHooks
  /** 登记一个步骤（幂等：同 seq 已有 done 则复用）。 */
  nextStep: (
    kind: WorkflowStep['kind'],
    label: string,
    nodeId: string | null,
    prompt: string | null,
    gateText: string | null,
  ) => Promise<WorkflowStep>
  /** 暂停边界（有暂停就等）。 */
  atBoundary: (step: WorkflowStep) => Promise<void>
  /** 当前步骤（flow/loop/parallel 执行时设置——agent/gate 的 run 用它登记 run）。 */
  currentStep: WorkflowStep | null
}

/* ══════════════════════════════════════════════════════════════════
 * 工具
 * ══════════════════════════════════════════════════════════════════ */

const now = (): number => Date.now()

const lastTextOf = (output: string | null | undefined): string => {
  if (!output) return ''
  const t = output.trimEnd()
  let cut = t.lastIndexOf('\n')
  if (cut >= 0 && t.length - cut < 300) cut = t.lastIndexOf('\n', cut - 1)
  if (cut > 32000) cut = 32000
  return (cut > 0 ? t.slice(0, cut) : t).trimEnd()
}

/** 把一段文本附加到输入后（重写轮的"打回意见"）。 */
const appendFeedback = (input: string, feedback: string | undefined): string => {
  const f = (feedback ?? '').trim()
  if (!f) return input
  return `${input}\n\n[打回意见] ${f}`
}

/* ══════════════════════════════════════════════════════════════════
 * 原子执行（agent / gate 的 run 内 —— 提交 run / 等人确认）
 * ══════════════════════════════════════════════════════════════════ */

/** 提交一次执行 run（登记 step.runIds）——返回产出文本。 */
async function runExecute(
  env: Env,
  step: WorkflowStep,
  prompt: string,
  resumeFromRunId: string | null,
): Promise<{ ok: boolean; runId: string | null; output: string; error?: string }> {
  const out = await env.hooks.submit(step, prompt, {
    ...(resumeFromRunId ? { resumeFromRunId: resumeFromRunId as never } : {}),
  })
  if (out.ok && out.runId) {
    if (!step.runIds.includes(out.runId)) step.runIds.push(out.runId)
    return { ok: true, runId: out.runId, output: out.output ?? '' }
  }
  return { ok: false, runId: null, output: '', error: out.error ?? '执行 run 提交失败' }
}

/* ══════════════════════════════════════════════════════════════════
 * 原语构造器（返回惰性 Handle）
 * ══════════════════════════════════════════════════════════════════ */

export interface Primitives {
  agent: (name: string, run?: (input: string) => unknown, opts?: { resume?: boolean }) => Handle
  gate: (text: string) => Handle
  flow: (agents: Handle[], prompt?: string, opts?: { returnIndex?: number }) => Handle
  parallel: (agents: Handle | Handle[], prompts?: string | string[], opts?: { concurrency?: number }) => Handle[]
  loop: (executor: Handle, guard: Handle, prompt?: string, opts?: { maxRounds?: number }) => Handle
  route: (map: Record<string, Handle>, prompt?: string) => Handle
}

/** 构造一个惰性 Handle（thenable：await 触发 run）。 */
function makeHandle(
  run: (input: string) => Reply | Promise<Reply>,
  label: string,
  reset?: () => void,
): Handle {
  const handle: Handle = {
    label,
    run,
    ...(reset ? { reset } : {}),
  }
  // thenable：await handle → 执行（惰性句柄的执行入口）。不 await 不执行。
  ;(handle as Handle).then = (resolve: (reply: Reply) => void, reject?: (err: unknown) => void) => {
    Promise.resolve()
      .then(() => handle.run(''))
      .then(resolve, reject ?? ((e) => { throw e }))
  }
  return handle
}

/** 取"本次执行的任务"：显式传入 > 构造时的 prompt > {{task}}。 */
const taskOf = (input: string | undefined, prompt: string | undefined): string =>
  (input ?? '').trim() !== '' ? (input as string) : (prompt ?? '{{task}}')

export function makePrimitives(env: Env): Primitives {
  const agent: Primitives['agent'] = (name, run, opts) => {
    // resume 锚点（闭包——不暴露为字段）：每轮执行后更新 lastRunId。
    let lastRunId: string | null = null
    const resume = opts?.resume !== false

    const exec = async (input: string): Promise<Reply> => {
      // agent 独立执行：没外层原语时自己登记步骤；在 flow/loop 里用外层步骤。
      const step =
        env.currentStep ??
        (await env.nextStep('flow', `执行 · ${name}`, `inline:${name}`, input, null))
      const prevStep = env.currentStep
      env.currentStep = step
      // 节点 = 本 agent（flow/loop/parallel 的容器步骤 nodeId 为空——submitStep 需要它）
      step.nodeId = `inline:${name}`
      try {
        if (step.status === 'done' && step.runIds.length > 0) {
          return { result: 'done', message: lastTextOf(await stepOutputCached(step)) }
        }
        const out = await runExecute(env, step, input, resume ? lastRunId : null)
        if (!out.ok) return { result: 'done', message: out.error ?? '执行失败' }
        if (resume) lastRunId = out.runId
        let reply: Reply = { result: 'done', message: out.output }
        if (run) {
          const handled = run(out.output)
          if (handled && typeof handled === 'object') reply = handled as Reply
          else if (handled !== undefined) reply = { result: 'done', message: String(handled) }
        }
        return reply
      } finally {
        env.currentStep = prevStep
      }
    }

    return makeHandle(exec, name)
  }

  const gate: Primitives['gate'] = (text) => {
    const exec = async (input: string): Promise<Reply> => {
      const step =
        env.currentStep ??
        (await env.nextStep('gate', `确认 · ${text}`, null, input || null, text))
      const prevStep = env.currentStep
      env.currentStep = step
      try {
        // 人确认：loop 里（env.currentStep 有）由 loop 原语负责等——这里统一等。
        step.gateText = text
        step.status = 'waiting-human'
        step.startedAt = step.startedAt ?? now()
        env.run.status = 'waiting-human'
        await env.hooks.persist(env.run)
        const verdict = await env.hooks.waitForGateConfirm(step)
        if (verdict.kind === 'passed') {
          step.status = 'done'
          step.finishedAt = now()
          return { result: 'pass' }
        }
        step.status = 'running'
        return { result: 'fail', message: verdict.feedback }
      } finally {
        env.currentStep = prevStep
      }
    }
    return makeHandle(exec, text)
  }

  const flow: Primitives['flow'] = (agents, prompt, opts) => {
    const promptText = prompt ?? '{{task}}'
    const returnIndex = opts?.returnIndex ?? -1
    const exec = async (input: string): Promise<Reply> => {
      const task = taskOf(input, promptText)
      const step = await env.nextStep(
        'flow',
        `流水线 · ${agents.map((a) => a.label ?? '?').join(' → ')}`,
        null,
        task,
        null,
      )
      const prevStep = env.currentStep
      env.currentStep = step
      try {
        let current = task
        let last: Reply = { result: 'done', message: '' }
        const replies: Reply[] = []
        for (const a of agents) {
          last = await a.run(current)
          replies.push(last)
          current = Array.isArray(last.message) ? last.message.join('\n') : (last.message ?? '')
        }
        // 选定返回（支持负数：-1 最后、-2 倒数第二）
        const idx = returnIndex < 0 ? replies.length + returnIndex : returnIndex - 1
        const picked = replies[Math.min(Math.max(idx, 0), replies.length - 1)] ?? last
        return picked
      } finally {
        env.currentStep = prevStep
      }
    }
    const label = `流水线`
    const handle = makeHandle(exec, label)
    // 复合 Handle：reset 递归重置内部所有 agent
    handle.reset = () => {
      for (const a of agents) a.reset?.()
    }
    return handle
  }

  const parallel: Primitives['parallel'] = (agents, prompts, opts) => {
    const agentList = Array.isArray(agents) ? agents : [agents]
    const promptList: string[] = prompts === undefined ? [] : typeof prompts === 'string' ? [prompts] : prompts
    const concurrency = opts?.concurrency ?? 0

    // 归一化：1×N 广播 / N×N 派发 / N×1 多任务 / 不匹配报错
    let pairs: Array<{ agent: Handle; prompt: string }>
    if (promptList.length === 0) {
      pairs = agentList.map((a) => ({ agent: a, prompt: '{{task}}' }))
    } else if (promptList.length === 1) {
      pairs = agentList.map((a) => ({ agent: a, prompt: promptList[0]! }))
    } else if (agentList.length === 1) {
      pairs = promptList.map((p) => ({ agent: agentList[0]!, prompt: p }))
    } else if (promptList.length === agentList.length) {
      pairs = agentList.map((a, i) => ({ agent: a, prompt: promptList[i]! }))
    } else {
      throw new Error(
        `parallel 的 agents（${agentList.length}）与 prompts（${promptList.length}）数量不匹配——支持 1×N / N×N / N×1`,
      )
    }

    // 每个分支 → 一个惰性 Handle（返回 Reply——引擎 await 时执行）
    const handles = pairs.map(({ agent: a, prompt: p }) => {
      const exec = async (input: string): Promise<Reply> => {
        const step = await env.nextStep(
          'parallel',
          `并行 · ${a.label ?? '?'}`,
          null,
          taskOf(input, p),
          null,
        )
        const prevStep = env.currentStep
        env.currentStep = step
        try {
          return await a.run(taskOf(input, p))
        } finally {
          env.currentStep = prevStep
        }
      }
      return makeHandle(exec, a.label ?? '并行')
    })
    // thenable 数组：`await parallel(...)` → 并行执行所有分支 → Reply[]；
    // 不 await = Handle[]（惰性——可作嵌套参数）。
    const thenable = handles as unknown as Handle[] & {
      then?: (resolve: (replies: Reply[]) => void, reject?: (err: unknown) => void) => void
    }
    thenable.then = (resolve, reject) => {
      Promise.all(handles.map((h) => h.run(''))).then(resolve, reject ?? ((e) => { throw e }))
    }
    return thenable
  }

  const loop: Primitives['loop'] = (executor, guard, prompt, opts) => {
    const promptText = prompt ?? '{{task}}'
    const maxRounds = Math.max(0, opts?.maxRounds ?? 1)
    const exec = async (input: string): Promise<Reply> => {
      const task = taskOf(input, promptText)
      const step = await env.nextStep(
        'loop',
        `把关循环 · ${executor.label ?? '?'}`,
        null,
        task,
        null,
      )
      const prevStep = env.currentStep
      env.currentStep = step
      try {
        let attempt = 0
        let execReply: Reply = { result: 'done', message: '' }
        let guardReply: Reply = { result: 'fail', message: '' }
        let taskNow = task
        while (attempt <= maxRounds) {
          // ① 执行者（resume 是执行者 run 自己的事——loop 不管）
          execReply = await executor.run(taskNow)
          // ② 把关者
          guardReply = await guard.run(Array.isArray(execReply.message) ? execReply.message.join('\n') : (execReply.message ?? ''))
          if (guardReply.result === 'pass') {
            step.status = 'done'
            step.finishedAt = now()
            return { result: 'done', message: execReply.message, guard: guardReply } as Reply & { guard: Reply }
          }
          if (guardReply.result !== 'fail') {
            throw new Error(`把关者输出了不认识的结果 result=${String(guardReply.result)}`)
          }
          attempt += 1
          if (attempt > maxRounds) break
          // 下一轮：打回意见附加进重写任务
          taskNow = appendFeedback(task, guardReply.message as string | undefined)
          await env.hooks.waitIfPaused()
        }
        // 超轮：编排兜底——run 不挂，返回执行者最后产物 + 审核意见
        step.status = 'done'
        step.finishedAt = now()
        return { result: 'fail', message: execReply.message, guard: guardReply } as Reply & { guard: Reply }
      } finally {
        env.currentStep = prevStep
      }
    }
    const handle = makeHandle(exec, `把关循环`)
    handle.reset = () => {
      executor.reset?.()
      guard.reset?.()
    }
    return handle
  }

  const route: Primitives['route'] = (map, prompt) => {
    const promptText = prompt ?? '{{task}}'
    const exec = async (input: string): Promise<Reply> => {
      const task = taskOf(input, promptText)
      const keys = Object.keys(map)
      const hit = keys.find((k) => task.includes(k)) ?? keys[0]
      const a = map[hit!]!
      const step = await env.nextStep(
        'route',
        `路由 · ${a.label ?? '?'}`,
        null,
        task,
        null,
      )
      const prevStep = env.currentStep
      env.currentStep = step
      try {
        return await a.run(task)
      } finally {
        env.currentStep = prevStep
      }
    }
    const handle = makeHandle(exec, '路由')
    handle.reset = () => {
      for (const a of Object.values(map)) a.reset?.()
    }
    return handle
  }

  return { agent, gate, flow, parallel, loop, route }
}

/** 读一个已完成步骤最后 run 的产出文本（幂等续跑用——缓存为空时返回空）。 */
async function stepOutputCached(step: WorkflowStep): Promise<string> {
  // v2 的续跑语义：done 步骤跳过——输出从 run 详情读（由调用方传入缓存）。
  // 当前实现：done 步骤直接返回空（兜底：重新提交会拿到 output）。
  return ''
}
