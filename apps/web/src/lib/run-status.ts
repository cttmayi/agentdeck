/**
 * run 状态 → 徽标颜色类 / 词条 id（**全 App 一份**）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么从任务页搬出来（D80 三轮）
 * ══════════════════════════════════════════════════════════════════
 *
 * 这段映射原来只写在 `views/Tasks.svelte` 里（任务详情的 run 列表用）。沉淀页的
 * 左栏也要显示起草 run 的状态徽标——如果就地再抄一份，两处就会各自演化：改一个
 * 状态的颜色要记得改两个文件，忘一处就是"同一个 run 在两个页面颜色不一样"。
 *
 * 使用者的原话是"UI 风格和任务差很多，怀疑你没有用同一控件"——同一份映射也是
 * 同一条纪律的一部分：**能共享的语义就别复制**。
 *
 * ★ 协议里的 `RunStatus` 有 8 个值，而 `app.css` 的状态色只覆盖了
 *   `completed`/`failed`/`cancelled` 三个——`running`/`queued`/`dispatched`/
 *   `deferred`/`waiting_local_directory` 原来一个颜色都没有（徽标落回
 *   `currentColor`，看起来"没有状态"）。这里映射到已有的那批语义色，
 *   不新增 CSS 变量：`queued`/`deferred`/`waiting_local_directory` 都表示
 *   "还没轮到它"，与看板的待办同色。
 */
import type { WebTextId } from '@agentdeck/i18n'

export const RUN_STATUS_CLASS: Record<string, string> = {
  queued: 'backlog',
  deferred: 'backlog',
  waiting_local_directory: 'backlog',
  dispatched: 'in_progress',
  running: 'in_progress',
  completed: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
}

/** 状态徽标里的颜色类（未知状态返回空串——徽标自身仍然成形，只是不着色）。 */
export function runStatusClass(status: string): string {
  return RUN_STATUS_CLASS[status] ?? ''
}

/** 状态徽标里的字：走词表（`term.runStatus.*`），**不显示协议英文值**。 */
export function runStatusKey(status: string): WebTextId {
  return `term.runStatus.${status}` as WebTextId
}

/* ══════════════════════════════════════════════════════════════════
 * 编排（2026-11）：run / 步骤状态 → 徽标颜色类与词条 id。
 *
 * ⚠️ 与 `RUN_STATUS_CLASS` 同一套语义色、同一个"能共享就别复制"纪律：
 *   编排页（定义页历史行）与运行画面（步骤链）两处都要显示这些状态，
 *   就地抄两份就会各自演化（D80 三轮的原话："同一个 run 在两个页面
 *   颜色不一样"）。语义：`waiting-human` = 等人在运行画面确认、`paused` =
 *   人让它停——都映射到已有的 `blocked`（status-blocked 色），不新增变量。
 * ══════════════════════════════════════════════════════════════════ */

/** 编排 run 状态 → 徽标颜色类。 */
export const WORKFLOW_RUN_STATUS_CLASS: Record<string, string> = {
  queued: 'backlog',
  running: 'in_progress',
  paused: 'blocked',
  'waiting-human': 'blocked',
  done: 'done',
  failed: 'failed',
}

/** 编排步骤状态 → 徽标颜色类。 */
export const WORKFLOW_STEP_STATUS_CLASS: Record<string, string> = {
  pending: 'backlog',
  running: 'in_progress',
  done: 'done',
  failed: 'failed',
  'waiting-human': 'blocked',
  skipped: 'backlog',
}

/** 编排 run 状态 → 词条 id（`workflows.runStatus*`）。 */
export const WORKFLOW_RUN_STATUS_KEY: Record<string, WebTextId> = {
  queued: 'workflows.runStatusQueued',
  running: 'workflows.runStatusRunning',
  paused: 'workflows.runStatusPaused',
  'waiting-human': 'workflows.runStatusWaitingHuman',
  done: 'workflows.runStatusDone',
  failed: 'workflows.runStatusFailed',
}

/** 编排步骤状态 → 词条 id（`workflows.step*`）。 */
export const WORKFLOW_STEP_STATUS_KEY: Record<string, WebTextId> = {
  pending: 'workflows.stepPending',
  running: 'workflows.stepRunning',
  done: 'workflows.stepDone',
  failed: 'workflows.stepFailed',
  'waiting-human': 'workflows.stepWaitingHuman',
  skipped: 'workflows.stepPending',
}

/** 编排步骤原语 → 词条 id（`workflows.stepKind*`）。 */
export const WORKFLOW_STEP_KIND_KEY: Record<string, WebTextId> = {
  flow: 'workflows.stepKindFlow',
  parallel: 'workflows.stepKindParallel',
  // 老数据里有 aggregate（早期引擎产出过）⇒ 词条留着，不然那一步会退回"流水线"
  aggregate: 'workflows.stepKindAggregate',
  loop: 'workflows.stepKindLoop',
  route: 'workflows.stepKindRoute',
  gate: 'workflows.stepKindGate',
}

/** 编排 run 状态徽标颜色类（未知返回空串——不着色但成形）。 */
export function workflowRunStatusClass(status: string): string {
  return WORKFLOW_RUN_STATUS_CLASS[status] ?? ''
}

/** 编排 run 状态徽标词条 id。 */
export function workflowRunStatusKey(status: string): WebTextId {
  return WORKFLOW_RUN_STATUS_KEY[status] ?? 'workflows.runStatusQueued'
}

/** 编排步骤状态徽标颜色类（未知返回空串）。 */
export function workflowStepStatusClass(status: string): string {
  return WORKFLOW_STEP_STATUS_CLASS[status] ?? ''
}

/** 编排步骤状态徽标词条 id。 */
export function workflowStepStatusKey(status: string): WebTextId {
  return WORKFLOW_STEP_STATUS_KEY[status] ?? 'workflows.stepPending'
}

/** 编排步骤原语词条 id。 */
export function workflowStepKindKey(kind: string): WebTextId {
  return WORKFLOW_STEP_KIND_KEY[kind] ?? 'workflows.stepKindFlow'
}
