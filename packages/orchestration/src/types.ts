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
 * 一次执行的上下文（外层原语 → 内部 Handle）。
 *
 * ★ 为什么上下文是**显式参数**、而不是环境里的一个可变字段（2026-11 真机缺陷）：
 *   原先是 `env.currentStep = step`（谁进来谁设、走的时候还原）。单线程顺序跑没问题，
 *   但 `parallel` 的分支是**并发**的：两个分支各写一次、各自"还原成自己看到的上一层"，
 *   于是把兄弟分支的步骤留在了字段里。实测后果是**步骤漏登记**——并行块之后的那一步
 *   以为自己还在某个并行分支里，于是 run 被挂到别人身上、run 的步骤链少一条、
 *   运行画面也就少一条（使用者看到的"很多BUG"里就有这一类）。
 *   现在：谁执行，就把"这一步是哪个步骤"**当参数传下去**（`owner`），
 *   内部 Handle 不再读共享字段——并发分支各拿各的，不会串。
 */
export interface RunContext {
  /** 这一步所属的步骤（容器传下来；叶子原语不再自己登记步骤）。 */
  owner?: WorkflowStep
  /*
   * ⚠️ 2026-11（D125）：这里原来还有两个字段——`review`（把关者位，提交一条
   *   **审核 run**，subject = 被审执行 run）与 `subjectRunId`（被审的 run）。
   *
   *   **审核 run 退场** ⇒ 把关者就是一次**普通执行 run**：它的任务书由引擎写进
   *   prompt（"请审核下面这份产出…" + 材料），它的答复就是答复。于是"提交一条
   *   另一种形状的 run"这件事没有对象，两个字段删。
   */
}

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
  /** 执行函数——输入"本次任务"（外层嵌套/重跑时传入），返回 Reply。 */
  run: (input: string, ctx?: RunContext) => Reply | Promise<Reply>
  /**
   * 这个 Handle 能不能给出 pass/fail ——**把关者位的要求**。
   *
   * ★ 2026-11（D121）：`agent('审查员')` 不带解析函数时，它的回复永远是
   *   `result: 'done'`（执行者语义），放进 `loop(...)` 当把关者只能报
   *   「把关者输出了不认识的结果」——**而且是在花掉一次审核 run 之后**。
   *   实测就是这么发生的：先跑执行、再跑审核、然后才炸。
   *   所以把"能不能判"写在 Handle 上，`loop` 在**提交任何 run 之前**就拒。
   *
   * - `'parser'`：agent 带了解析函数（把审核意见变成 pass/fail）；
   * - `'human'`：gate（人确认）；
   * - `'none'`：agent 没带解析函数（不能当把关者）；
   * - 缺省：复合 Handle（flow/parallel/loop/route）——不去猜，交给运行时检查。
   */
  judge?: 'parser' | 'human' | 'none'
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
  /** resume 锚点：续上一轮会话（重写轮）。 */
  resumeFromRunId?: RunId
  /*
   * ⚠️ 2026-11（D125）：这里原来还有三个字段——`reviewer`（旧签名兼容：把审核者
   *   挂在执行 run 上，由 daemon 的 `autoChainReview` 串一条审核 run）、
   *   `kind: 'review'` / `reviewAgentName` / `subjectRunId`（"这一步提交的是审核
   *   run"）。**审核 run 退场** ⇒ 四个全删：编排的每一步都只是执行 run，
   *   把关那一步不例外。
   */
  /**
   * 这一步要跑哪个**智能体**（`inline:名字` 里的名字）。
   *
   * ★ 2026-11 真机缺陷（B7）：原先 `submitStep` 只从 `step.nodeId` 认人，而叶子原语
   *   （agent/gate）会把 `step.nodeId` 改成自己的名字——于是**容器的步骤**（如
   *   `把关循环 · 写作员`）跑过几个 agent 之后，nodeId 变成了最后跑的那个（
   *   实测是审查员），运行画面上"这一步是谁在干"就错了。现在由原语显式带上，
   *   `step.nodeId` 保持"这一步自己的节点"（容器 = null）。
   */
  agentName?: string
}

/** 提交一步的结果（server → 引擎）。 */
export interface StepSubmitResult {
  ok: boolean
  runId: RunId | null
  error?: string
  /** 执行 run 的产出（文字）。 */
  output?: string | null
  /*
   * ⚠️ 这里原来有一个 `reviewPass?: never`——"审核 run 的判决结论"的墓碑。
   *   D121 时它被标成死字段（曾生产、从未消费）；D125 之后连生产它的东西都没了，
   *   这块墓碑也就没有要挡的人。**但它记的那条教训还在**：把关者位的 agent
   *   必须自带解析函数，或者用 `gate()` 让人来判——**不带 parser 也能过**是假的。
   */
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
