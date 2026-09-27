import type { ActionStatus } from '@agentdeck/protocol'
import { IllegalTransitionError } from '../errors.ts'

/**
 * Action 的生命周期（requirements §10.3）。
 *
 * 两条不退让的规则：
 * - **默认路径是 `auto_approved`**（INV-4）。`awaiting_approval` 是例外，
 *   而且只能由 skill 显式声明触发（INV-6）——否则人又变回了默认关卡。
 * - **幂等命中的动作进 `skipped`**，不是静默成功（SM-ACT-2）。这样
 *   "这次没执行"在审计里是可见的，而不是看起来像真的执行了。
 */
const ACTION_TRANSITIONS: Readonly<Record<ActionStatus, readonly ActionStatus[]>> = {
  // verdict 刚刚产出动作
  proposed: ['auto_approved', 'awaiting_approval', 'skipped'],

  // 自动批准（默认路径）
  auto_approved: ['executing', 'skipped'],

  // 等待人批准（例外路径）
  awaiting_approval: ['auto_approved', 'skipped'],

  // 执行中
  executing: ['executed', 'failed'],

  // 已执行 ⇒ 事后可以回滚
  executed: ['rolled_back'],

  // ── 终态 ──
  failed: [],
  rolled_back: [],
  skipped: [],
}

export function canTransitionAction(from: ActionStatus, to: ActionStatus): boolean {
  return ACTION_TRANSITIONS[from].includes(to)
}

export function assertActionTransition(from: ActionStatus, to: ActionStatus): void {
  if (!canTransitionAction(from, to)) {
    throw new IllegalTransitionError('action', from, to)
  }
}

/**
 * 幂等键。
 *
 * ★ 必须含 `verdictId`：同一判决重放要被去重，但**不同判决产生的相同动作
 *   不能被去重**——否则多视角审核（FR-AGENT-21）里第二个 agent 的同样的
 *   真实发现会被静默吞掉。
 */
export interface IdempotencyInput {
  verdictId: string
  type: string
  params: Record<string, unknown>
}

export function actionIdempotencyKey(input: IdempotencyInput): string {
  return `${input.verdictId}:${input.type}:${stableStringify(input.params)}`
}

/**
 * 稳定的参数序列化：对象键排序，避免同一份参数因键顺序不同产生两个幂等键。
 * 这也是为什么不能直接用 `JSON.stringify`。
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}
