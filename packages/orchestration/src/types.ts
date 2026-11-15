/**
 * 编排引擎的契约（v5 设计，2026-11）。
 *
 * 与界面/daemon 解耦：本包只依赖 @agentdeck/protocol 的 RunId 等基础类型——
 * 执行侧的 submitStep / 等人确认 / 持久化全部以 hooks 注入（EngineHooks）。
 *
 * 三层分离：
 * - **Handle**：可执行单元（惰性——创建不执行；await 触发 run——thenable）
 * - **Reply**：执行结果（result / message / guard）
 * - **WorkflowRun / WorkflowStep**：运行模型（步骤链/幂等键——引擎登记、daemon 存储）
 */

import type { RunId } from '@agentdeck/protocol'

/* ══════════════════════════════════════════════════════════════════
 * 执行结果（Reply）——所有执行单元的输出
 * ══════════════════════════════════════════════════════════════════ */

/** 执行回复——所有执行单元的输出（`await` 的返回）。 */
export interface Reply {
  /** 结果——执行者 done；把关者 pass/fail。其他值一律报错。 */
  result: 'done' | 'pass' | 'fail'
  /** 产出文本 / 意见文本（可数组——代码执行 run 转出的数据源）。 */
  message?: string | string[]
  /** loop 专用：最后审核者的返回（失败时可用 message 取执行者产物）。 */
  guard?: Reply
  /** 信息载荷——原样保留（score / runIds / suggestions…）。 */
  [k: string]: unknown
}

/* ══════════════════════════════════════════════════════════════════
 * 可执行单元（Handle）——惰性 + thenable
 * ══════════════════════════════════════════════════════════════════ */

/**
 * 可执行单元。
 *
 * - 惰性：构造器返回 Handle **不执行**（不登记步骤、不跑 run）——`await handle`
 *   （走 `then`）才执行；`run(input)` 显式执行（嵌套/重跑用）。
 * - 展示：`label`（界面/运行画面显示：步骤名 / agent 名 / gate 文案）。
 * - 重置：`reset()`（复合 Handle 递归——清内部所有 agent 的会话锚点）。
 * - 结果不挂句柄：`await handle` 返回 `Reply`（见 §设计）。
 */
export interface Handle {
  /** 执行函数——输入"本次任务"（外层嵌套/重跑时传入），返回 Reply。
   *  opts.review：把关者位（loop guard）——提交**审核 run**（kind review，
   *  subject = 被审执行 run——界面按 subject 反查，与 autoChainReview 同规则）。 */
  run: (
    input: string,
    opts?: { review?: boolean; subjectRunId?: string },
  ) => Reply | Promise<Reply>
  /** 展示名（界面用）。 */
  label?: string
  /** 运行时重置（清 resume 锚点——复合 Handle 递归）。 */
  reset?: () => void
  /** thenable：`await handle` 触发 run（惰性句柄的执行入口）。 */
  then?: (resolve: (reply: Reply) => void, reject?: (err: unknown) => void) => void
}

/* ══════════════════════════════════════════════════════════════════
 * 引擎与执行侧交互（hooks 注入——与 daemon 解耦）
 * ══════════════════════════════════════════════════════════════════ */

/** 提交一步的执行参数（引擎 → server 的 submitStep）。 */
export interface StepSubmitOptions {
  /** 旧签名兼容：reviewer 挂执行 run（autoChainReview）。 */
  reviewer?: string
  /** resume 锚点：续上一轮会话（重写轮）。 */
  resumeFromRunId?: RunId
  /** 'review' = 提交审核 run（把关者带判定时的显式审核）。 */
  kind?: 'execute' | 'review'
  /** 审核者名字（kind==='review'）。 */
  reviewAgentName?: string
  /** 被审 run（kind==='review'——subject = 执行 run）。 */
  subjectRunId?: RunId
}

/** 提交一步的结果（server → 引擎）。 */
export interface StepSubmitResult {
  ok: boolean
  runId: RunId | null
  error?: string
  /** 执行 run 的产出（文字）。 */
  output?: string | null
  /** 审核 run 的判决（不带 parser 时用）。 */
  reviewPass?: boolean
}

/** 引擎 hooks——执行侧注入（daemon 实现）。 */
export interface EngineHooks {
  /** 提交一步（执行 run / 审核 run）。 */
  submit: (
    step: WorkflowStep,
    prompt: string,
    opts?: StepSubmitOptions,
  ) => Promise<StepSubmitResult>
  /** 等人确认（gate 挂起）。 */
  waitForGateConfirm: (step: WorkflowStep) => Promise<GateVerdict>
  /** 持久化 run（每步状态变化）。 */
  persist: (run: WorkflowRun) => Promise<void>
  /** 暂停等待（步骤边界）。 */
  waitIfPaused: () => Promise<void>
}

/** 人 gate 的裁决。 */
export type GateVerdict = { kind: 'passed' } | { kind: 'rejected'; feedback: string }

/* ══════════════════════════════════════════════════════════════════
 * 运行模型（WorkflowRun / WorkflowStep——daemon 存储也用）
 * ══════════════════════════════════════════════════════════════════ */

/** 编排运行实例（一次运行；挂在 issue 上）。 */
export interface WorkflowRun {
  id: string
  /** 这次运行对应的任务（issue）id。 */
  issueId: string
  workflowId: string
  /** 这次运行的工作目录（发起时设定，null = daemon 自动分配）。 */
  workDir: string | null
  status: 'queued' | 'running' | 'paused' | 'waiting-human' | 'done' | 'failed'
  /** 步骤链（引擎按代码顺序登记）。 */
  steps: WorkflowStep[]
  /** gate 否决时人填的意见（UI 展示用）。 */
  gateFeedback: string | null
  /** 否决意见**固化**——重跑轮的 submitStep 附加进任务（防兜底误判）。 */
  taskAppend: string | null
  error: string | null
  createdAt: number
  updatedAt: number
}

/** 一步（一次"执行" / 一个 gate 站）。 */
export interface WorkflowStep {
  /** 步骤序号（幂等键：代码未变时稳定；续跑按它跳过已完成步骤）。 */
  seq: number
  /** 步骤类型。 */
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
