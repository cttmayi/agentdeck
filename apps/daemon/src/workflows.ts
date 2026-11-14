/**
 * **编排**（2026-11，使用者立项："编排用代码控制，节点 = 智能体组；先做编排任务页，
 * 不破坏现有任务页，后面再把单 Agent 任务移植成单步编排"）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 本模块做四件事：类型、存储、引擎状态机、原语定义
 * ══════════════════════════════════════════════════════════════════
 *
 * · 存储是**独立 JSON 文件**（`<dataDir>/workflows.json`），不进 domain 的 store：
 *   编排是 daemon 的"外挂功能"——每步的 run 全部走既有链路（submitRunRequest /
 *   issue / 审核），它自己只是"把几个组串起来跑"的计划，不值得为此动
 *   protocol/domain/store 协议层（判据与 D34 同一句：能不动的层就不动）。
 *
 * · 引擎是**代码重跑 + 步骤幂等**：
 *   编排代码被包进一个 async 函数（注入原语）执行；每个原语调用按顺序登记一个
 *   步骤（seq）。续跑/重跑时，已完成（done）的步骤直接跳过、不重新提交 run；
 *   gate 步骤以 waiting-human 挂起，确认后才继续；暂停在步骤边界生效。
 *   ⚠️ 幂等键是 seq ⇒ 续跑只对**未改过的代码**有效；改了代码建议重新运行。
 *
 * · 「提交 run」通过注入的 `submit` 回调完成（server 提供：调 submitRunRequest，
 *   组展开/校验/起进程都在那里）——本模块保持纯逻辑、可单测。
 *
 * · ⚠️ 安全边界：原语只接受**组 id / 内嵌智能体**，不接受任意 workDir 的 run；
 *   编排代码是使用者自己写的（本机工具，等同定时任务的 cron 表达式）——它
 *   只能"用已配置的组跑"，不能开放代码执行入口。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { RunId, WorkspaceId } from '@agentdeck/protocol'

/* ══════════════════════════════════════════════════════════════════
 * 类型
 * ══════════════════════════════════════════════════════════════════ */

/** 编排定义（一个有名字的代码脚本，节点 = 组 / 内嵌智能体）。 */
export interface Workflow {
  id: string
  workspaceId: WorkspaceId
  name: string
  /** 编排代码（一等公民：模板/快捷/AI 生成的也是代码，随时可改）。 */
  code: string
  /** 来源：模板 / 手动 / AI（聊天里生成后采纳）。 */
  source: 'template' | 'manual' | 'ai'
  /** 模板键（source==='template' 时记录是哪个模板，展示用）。 */
  templateKey: string | null
  /** 编排内嵌智能体（只在编排里有效，不占智能体组页）。 */
  inlineAgents: WorkflowInlineAgent[]
  createdAt: number
  updatedAt: number
}

/** 编排内嵌智能体：只在编排里有效的执行者/审核者（2026-11 使用者："可以给编排
 *  单独设置智能体（只在编排有用）"）。代码里用 `inline({...})` 引用。 */
export interface WorkflowInlineAgent {
  id: string
  /** 名字（展示 + 代码里引用）。 */
  name: string
  /** 角色：执行者 / 审核者 / 执行（不审）。 */
  role: 'executor' | 'reviewer' | 'executor-no-review'
  /** 模型 runtime（claude / codex / generic…）。 */
  model: string | null
  /** 审核标准（role 是 reviewer 时）。 */
  reviewStandard: string | null
}

/** 编排运行实例（一次运行；挂在 issue 上，见 server.ts）。 */
export interface WorkflowRun {
  id: string
  /** 这次运行对应的任务（issue）id。 */
  issueId: string
  workflowId: string
  /** 这次运行的工作目录（发起时设定，null = daemon 自动分配；每步都在其下跑）。 */
  workDir: string | null
  status: 'queued' | 'running' | 'paused' | 'waiting-human' | 'done' | 'failed'
  /** 步骤链（引擎按代码顺序登记）。 */
  steps: WorkflowStep[]
  /** 2026-11：gate 否决时人填的意见——打回重跑时附加到任务（老数据没有=null）。 */
  gateFeedback: string | null
  error: string | null
  createdAt: number
  updatedAt: number
}

/** 一步（一次"组跑" / 一个 gate 站）。 */
export interface WorkflowStep {
  /** 步骤序号（幂等键：代码未变时稳定；续跑按它跳过已完成步骤）。 */
  seq: number
  kind: 'flow' | 'parallel' | 'aggregate' | 'loop' | 'route' | 'gate'
  /** 展示名（如"起草 A · 组A"、"gate · 等你确认"）。 */
  label: string
  /** 节点（组 id 或内嵌智能体 id）。gate/并行聚合时可能为 null。 */
  nodeId: string | null
  /** 投给这一步的 prompt。 */
  prompt: string | null
  /** 这一步的 run（并行聚合时是多个）。 */
  runIds: RunId[]
  /** gate 的等待文案。 */
  gateText: string | null
  status: 'pending' | 'running' | 'done' | 'failed' | 'waiting-human' | 'skipped'
  startedAt: number | null
  finishedAt: number | null
}

/** 模板骨架：新建编排时插入代码。 */
export interface WorkflowTemplate {
  key: string
  name: string
  /** 骨架代码（组 id 用占位符 `groupA/groupB/...`，保存时校验必须替换成真实组）。 */
  code: string
}

/** 固定模板清单（UI「从模板」入口）。 */
export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [
  {
    key: 'single-flow',
    name: '单组流程',
    code: `// 单组流程：一个智能体跑一次任务
// 节点 = 智能体名（inline: 前缀，运行时按名字在智能体里解析）
// {{task}} = 发起运行时填的任务描述（占位符，会被替换）
await flow('inline:智能体名', '{{task}}')`,
  },
  {
    key: 'sequential',
    name: '顺序流水线',
    code: `// 顺序流水线：A 干完 B 接力
await flow(['inline:智能体A', 'inline:智能体B'], '{{task}}')`,
  },
  {
    key: 'parallel',
    name: '并行派活',
    code: `// 并行派活：分头干、合一份
const drafts = await parallel(['inline:智能体A', 'inline:智能体B'], '{{task}}')
await aggregate(drafts, 'inline:合并智能体', '合并成一份')`,
  },
  {
    key: 'loop',
    name: '评审返工',
    code: `// 评审返工：审不过就重做，最多 N 轮（reviewer = 审核者智能体名）
await loop('inline:执行智能体', '{{task}}', { maxRounds: 2, reviewer: 'inline:审核智能体' })`,
  },
  {
    key: 'route',
    name: '路由分流',
    code: `// 路由分流：按类型派专家（按任务描述里的关键字选智能体）
// {{task}} 会被替换成任务描述——填的任务里带上关键字（如"代码"/"写作"）才能正确分派
await route('{{task}}', { 代码: 'inline:代码智能体', 写作: 'inline:写作智能体' })`,
  },
  {
    key: 'supervise',
    name: '协调者',
    code: `// 协调者：拆任务 + 汇总（二期实现，先用 flow 兜底）
await flow('inline:协调智能体', '{{task}}')`,
  },
  {
    key: 'gate',
    name: '人机把关',
    code: `// 人机把关：干完你拍板（gate 可确认，也可否决并打回重写）
await flow('inline:智能体名', '{{task}}')
await gate('结果请你过目')`,
  },
]

/* ══════════════════════════════════════════════════════════════════
 * 存储（独立 JSON，仿 schedules.json）
 * ══════════════════════════════════════════════════════════════════ */

/** 存储路径（`<dataDir>/workflows.json`）。 */
export function workflowsPath(dir: string): string {
  return join(dir, 'workflows.json')
}

/** 读编排列表；没有文件（从没建过）= 空数组；坏 JSON = 空数组（不炸）。 */
export async function loadWorkflows(dir: string): Promise<Workflow[]> {
  try {
    const raw = await readFile(workflowsPath(dir), 'utf8')
    const parsed = JSON.parse(raw) as Workflow[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** 原子写（先写临时文件再 rename，仿 schedules.ts）。 */
export async function saveWorkflows(dir: string, list: readonly Workflow[]): Promise<void> {
  const path = workflowsPath(dir)
  await mkdir(dirname(path), { recursive: true })
  // ⚠️ tmp 名带随机后缀：并发写（编排引擎里 persist 可能在多处 await 交错）
  // 时，两个同毫秒的 Date.now() 会撞名——先 rename 的移走源文件，后者 ENOENT。
  const tmp = `${path}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await writeFile(tmp, JSON.stringify(list, null, 2), 'utf8')
  await rename(tmp, path)
}

/** 运行实例的存储路径（`<dataDir>/workflow-runs.json`）。 */
export function workflowRunsPath(dir: string): string {
  return join(dir, 'workflow-runs.json')
}

/** 读运行实例列表（幂等存储：引擎每步 persist 一次，挂 issue 的索引也在这）。 */
export async function loadWorkflowRuns(dir: string): Promise<WorkflowRun[]> {
  try {
    const raw = await readFile(workflowRunsPath(dir), 'utf8')
    const parsed = JSON.parse(raw) as WorkflowRun[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export async function saveWorkflowRuns(dir: string, list: readonly WorkflowRun[]): Promise<void> {
  const path = workflowRunsPath(dir)
  await mkdir(dirname(path), { recursive: true })
  // ⚠️ tmp 名带随机后缀：并发写（编排引擎里 persist 可能在多处 await 交错）
  // 时，两个同毫秒的 Date.now() 会撞名——先 rename 的移走源文件，后者 ENOENT。
  const tmp = `${path}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await writeFile(tmp, JSON.stringify(list, null, 2), 'utf8')
  await rename(tmp, path)
}

/* ══════════════════════════════════════════════════════════════════
 * 引擎（纯逻辑；提交 run 靠注入的 submit 回调）
 * ══════════════════════════════════════════════════════════════════ */

/** 一次"组跑"的提交回调（server 提供：调 submitRunRequest）。 */
/** 步骤提交选项（2026-11：编排不用「智能体组」也能配审核链）。 */
export interface StepSubmitOptions {
  /** 审核者智能体名（`inline:名字` 格式；组节点时作为对组默认审核者的覆盖）。 */
  reviewer?: string
}

export interface StepSubmitter {
  (
    step: WorkflowStep,
    prompt: string,
    opts?: StepSubmitOptions,
  ): Promise<{ ok: boolean; runId: RunId | null; error?: string }>
}

/** 引擎的宿主钩子（server 实现：持久化、暂停等待、gate 等待确认）。 */
export interface EngineHooks {
  /** 提交一次"组跑"（server 实现：解析节点 → submitRunRequest）。 */
  submit: StepSubmitter
  /** 每步状态变化后保存一次（断点续跑靠它）。 */
  persist: (run: WorkflowRun) => Promise<void>
  /** 在步骤边界检查暂停；暂停中返回的 promise 直到 resume 才 resolve。 */
  waitIfPaused: () => Promise<void>
  /** gate 挂起：返回的 promise 直到 confirm 才 resolve（passed）；否决 = rejected + 意见。 */
  waitForGateConfirm: (step: WorkflowStep) => Promise<GateVerdict>
}

/** gate 的确认结果（2026-11：不只"通过"，还能"否决 + 意见"）。 */
export type GateVerdict = { kind: 'passed' } | { kind: 'rejected'; feedback: string }

/**
 * ★ gate 否决信号（引擎内部）：否决 = 打回重跑——executeWorkflow 捕获后重置
 *   步骤链、把意见存到 run 上，重新执行一遍代码（带意见再跑写/审/再等确认）。
 */
export class WorkflowRejectedError extends Error {
  feedback: string
  constructor(feedback: string) {
    super('gate 否决')
    this.feedback = feedback
  }
}

/** 编排代码能用的节点：**组名**（字符串，运行时按名字在智能体组里解析）
 * 或内嵌智能体（`inline:名字`）。用组名而不是组 id：可读、稳定（用户自己命名），
 * 模板骨架里的 `'组A'` 等占位符在编辑时改成真实组名。 */
export type WorkflowNode = string

/** 把内嵌智能体定义转成节点（inline 原语；一期只做引用，不展开配置）。 */
export interface InlineAgentDef {
  executor: string
  review?: string
  model?: string
}

/**
 * 执行编排代码（注入原语），逐步登记步骤、按幂等键跳过已完成步骤。
 *
 * ⚠️ `new Function` 执行的是**使用者自己写的**编排代码（本机工具，与定时任务的
 * cron 表达式同一信任级）；原语只接受组 id / 内嵌智能体，不接受任意 workDir，
 * 安全边界保持（不能开放"提交任意 run"）。
 */
export async function executeWorkflow(
  run: WorkflowRun,
  code: string,
  hooks: EngineHooks,
): Promise<WorkflowRun> {
  // 幂等基线：续跑时加载已有步骤（done 跳过；waiting-human 的 gate 等确认）。
  // ⚠️ seq 从 **1 重新计数**（代码从头重跑，原语调用按代码顺序再次登记 seq=1,2,3…），
  //    这样续跑时第一步命中 prior 里的 done 步骤、跳过提交。若把基线设成 prior.size，
  //    续跑会继续往后编号、永远撞不上已登记的步骤——幂等失效（实测踩过）。
  let prior = new Map<number, WorkflowStep>(run.steps.map((s) => [s.seq, s]))
  let seq = 0

  const now = (): number => Date.now()

  /** 登记下一个步骤（或取续跑时的已有步骤）。 */
  function nextStep(
    kind: WorkflowStep['kind'],
    label: string,
    nodeId: string | null,
    prompt: string | null,
    gateText: string | null,
  ): WorkflowStep {
    seq += 1
    const priorStep = prior.get(seq)
    if (priorStep) {
      // 续跑：复用已有状态（done 跳过 / waiting-human 等确认 / failed 报错）。
      return priorStep
    }
    const step: WorkflowStep = {
      seq,
      kind,
      label,
      nodeId,
      prompt,
      runIds: [],
      gateText,
      status: 'pending',
      startedAt: null,
      finishedAt: null,
    }
    run.steps.push(step)
    // ⚠️ 这里**不** void persist——原语在 atBoundary/runStep 里都有 await persist，
    // 再 fire-and-forget 一次会和后面那次**并发写同一文件**：两次 save 的 tmp 名
    // 同毫秒撞名时，先 rename 的会把后一个的 tmp 移走，后者 rename 直接 ENOENT
    // （真实踩过：整条编排挂 failed、daemon 进程被 unhandled rejection 打崩）。
    return step
  }

  /** 步骤边界：暂停检查 + 状态落盘。 */
  async function atBoundary(step: WorkflowStep): Promise<void> {
    await hooks.persist(run)
    await hooks.waitIfPaused()
    void step
  }

  /** 提交一次组跑并登记到步骤（幂等：done 跳过）。 */
  async function runStep(
    step: WorkflowStep,
    prompt: string,
    opts?: StepSubmitOptions,
  ): Promise<{ ok: boolean; runId: RunId | null }> {
    if (step.status === 'done') return { ok: true, runId: step.runIds[0] ?? null }
    if (step.status === 'failed') {
      throw new Error(`步骤 ${step.seq} 上次失败了（${step.label}）——重试请用「重试此步」`)
    }
    step.status = 'running'
    step.startedAt = step.startedAt ?? now()
    await hooks.persist(run)
    const out = await hooks.submit(step, prompt, opts)
    if (out.ok && out.runId) {
      if (!step.runIds.includes(out.runId)) step.runIds.push(out.runId)
      step.status = 'done'
    } else {
      step.status = 'failed'
      run.error = out.error ?? `步骤 ${step.seq}（${step.label}）提交失败`
    }
    step.finishedAt = now()
    await hooks.persist(run)
    if (step.status === 'failed') throw new Error(run.error ?? '步骤失败')
    return { ok: true, runId: out.runId }
  }

  const primitives = {
    /** 单组跑一次（节点 = 组 id 或内嵌智能体 id）。数组 = 顺序接力。 */
    flow: async (
      node: WorkflowNode | WorkflowNode[],
      prompt: string,
      opts?: StepSubmitOptions,
    ) => {
      if (Array.isArray(node)) {
        let last: unknown = null
        for (const n of node) {
          const step = nextStep('flow', `组跑 · ${n}`, n, prompt, null)
          await atBoundary(step)
          const out = await runStep(step, prompt, opts)
          last = out.runId ? `[已完成 ${out.runId}]` : null
        }
        return last
      }
      const step = nextStep('flow', `组跑 · ${node}`, node, prompt, null)
      await atBoundary(step)
      const out = await runStep(step, prompt, opts)
      return out.runId
    },

    /** 并行：几组分头干，等全部（整体一个步骤，runIds 多个）。 */
    parallel: async (nodes: WorkflowNode[], prompt: string) => {
      const step = nextStep('parallel', `并行 · ${nodes.join(' + ')}`, nodes[0] ?? null, prompt, null)
      await atBoundary(step)
      step.status = 'running'
      step.startedAt = step.startedAt ?? now()
      await hooks.persist(run)
      const outs = await Promise.all(
        nodes.map(async (n) => {
          const sub: WorkflowStep = { ...step, seq: 0, label: `并行子步 · ${n}`, nodeId: n }
          return hooks.submit(sub, prompt)
        }),
      )
      const okAll = outs.every((o) => o.ok && o.runId)
      step.runIds = outs.map((o) => o.runId).filter((x): x is RunId => !!x)
      step.status = okAll ? 'done' : 'failed'
      if (!okAll) run.error = '并行步骤有子步失败'
      step.finishedAt = now()
      await hooks.persist(run)
      if (!okAll) throw new Error(run.error ?? '并行步骤失败')
      return step.runIds
    },

    /** 聚合：把上一步结果摘要附进 prompt，交给一组整合。 */
    aggregate: async (results: unknown, node: WorkflowNode, prompt: string) => {
      const digest = Array.isArray(results) ? `（上一步产出：${results.length} 份结果）` : ''
      const step = nextStep('aggregate', `聚合 · ${node}`, node, prompt, null)
      await atBoundary(step)
      const out = await runStep(step, `${digest}${prompt}`)
      return out.runId
    },

    /** 路由：按 prompt 里的关键字选组（map：{ 名字: 组id }）。 */
    route: async (prompt: string, map: Record<string, WorkflowNode>) => {
      const key = Object.keys(map).find((k) => prompt.includes(k)) ?? Object.keys(map)[0]
      const node: WorkflowNode | null = key ? (map[key] ?? null) : (Object.values(map)[0] ?? null)
      const step = nextStep('route', `路由 → ${key ?? '默认'}`, node, prompt, null)
      await atBoundary(step)
      const out = await runStep(step, prompt)
      return out.runId
    },

    /** 评审返工：组跑，失败且轮数 < maxRounds 时重跑（同一步骤内循环）。 */
    loop: async (
      node: WorkflowNode,
      prompt: string,
      opts: { maxRounds?: number; reviewer?: string } = {},
    ) => {
      const maxRounds = Math.max(0, opts.maxRounds ?? 1)
      const step = nextStep('loop', `评审返工 · ${node}（≤${maxRounds + 1} 轮）`, node, prompt, null)
      await atBoundary(step)
      if (step.status === 'done') return step.runIds[0] ?? null
      step.status = 'running'
      step.startedAt = step.startedAt ?? now()
      await hooks.persist(run)
      let attempt = 0
      let out: { ok: boolean; runId: RunId | null } = { ok: false, runId: null }
      while (attempt <= maxRounds) {
        out = await hooks.submit(step, prompt, opts.reviewer ? { reviewer: opts.reviewer } : undefined)
        if (out.ok && out.runId) break
        attempt += 1
        if (attempt > maxRounds) break
        // 同一目录续跑（自动重试一次组跑）
        await hooks.waitIfPaused()
      }
      if (out.ok && out.runId) {
        if (!step.runIds.includes(out.runId)) step.runIds.push(out.runId)
        step.status = 'done'
      } else {
        step.status = 'failed'
        run.error = `评审返工 ${maxRounds + 1} 轮都没过`
      }
      step.finishedAt = now()
      await hooks.persist(run)
      if (step.status === 'failed') throw new Error(run.error ?? '评审返工失败')
      return out.runId
    },

    /** 人机回环：停下等确认（确认 = 该步 status 由 waiting-human 变 done）。 */
    gate: async (text: string) => {
      const step = nextStep('gate', 'gate · 等你确认', null, null, text)
      if (step.status === 'done') return
      step.status = 'waiting-human'
      step.startedAt = step.startedAt ?? now()
      await hooks.persist(run)
      run.status = 'waiting-human'
      await hooks.persist(run)
      const verdict = await hooks.waitForGateConfirm(step)
      // 否决（带意见）：打回重跑——executeWorkflow 捕获信号、重置步骤链再跑一遍
      if (verdict.kind === 'rejected') throw new WorkflowRejectedError(verdict.feedback)
      step.status = 'done'
      step.finishedAt = now()
      await hooks.persist(run)
    },

    /** 内嵌智能体（一期：引用编排定义里的 inlineAgents；代码里按名字查）。 */
    inline: (def: InlineAgentDef): WorkflowNode => {
      // 一期：按名字在 run 的定义里查（server 解析时把 def 挂到 workflow）；这里
      // 只接受定义对象、返回占位节点——真正的内嵌智能体在 server 端解析。
      return `inline:${def.executor}`
    },
  }

  const fn = new Function(
    'flow',
    'parallel',
    'aggregate',
    'loop',
    'route',
    'gate',
    'inline',
    `return (async () => {\n${code}\n})()`,
  )
  // ★ 2026-11 gate 打回（使用者："不通过就要重新打回去改"）：否决 → 重置步骤链、
  //   意见存 run（submitStep 附加进下一轮任务），从头再执行一遍——写/审/再等确认。
  //   最多打回 3 轮，仍不通过则 run failed（不再无限打转）。
  let rejectRounds = 0
  const MAX_REJECT_ROUNDS = 3
  for (;;) {
    // ★ 打回重跑：seq 从 1 重新登记、**prior 按当前 run.steps 重建**——命中第一轮
    //   留下的步骤对象（重置成 pending 的同一引用），runStep 再提交一轮、runIds
    //   累积在同一步骤上。prior 不重建/seq 不归零都会让第二轮从 1 或 3 新登记，
    //   旧步骤成了孤儿（两处都实测踩过）。
    seq = 0
    prior = new Map<number, WorkflowStep>(run.steps.map((s) => [s.seq, s]))
    run.status = 'running'
    run.error = null
    await hooks.persist(run)
    try {
      await fn(
        primitives.flow,
        primitives.parallel,
        primitives.aggregate,
        primitives.loop,
        primitives.route,
        primitives.gate,
        primitives.inline,
      )
      run.status = 'done'
      break
    } catch (err) {
      if (err instanceof WorkflowRejectedError) {
        run.gateFeedback = err.feedback
        rejectRounds += 1
        if (rejectRounds > MAX_REJECT_ROUNDS) {
          run.status = 'failed'
          run.error = `打回 ${MAX_REJECT_ROUNDS} 次仍未通过`
          break
        }
        // 打回：步骤链全部重置为 pending（runIds 保留作历史）——重新执行时
        // nextStep 复用这些步骤对象（同一引用），runStep 再提交一轮
        for (const st of run.steps) {
          st.status = 'pending'
          st.startedAt = null
          st.finishedAt = null
        }
        continue
      }
      run.status = 'failed'
      run.error = err instanceof Error ? err.message : String(err)
      break
    }
  }
  run.updatedAt = now()
  await hooks.persist(run)
  return run
}
