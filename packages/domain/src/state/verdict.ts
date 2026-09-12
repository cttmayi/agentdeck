import type { VerdictStatus } from '@alpha-helper/protocol'
import { IllegalTransitionError } from '../errors.ts'

/**
 * Verdict 的生命周期（requirements §10.2）。
 *
 * 关键点是 **`invalid` 是独立失败类型**（FR-REVIEW-05）：
 * agent 输出的判决不符合 schema，与"执行失败"是两件事，处置路径也不同。
 * 把它混进 failed 会让"模型没按格式输出"和"进程崩了"共享同一条重试逻辑，
 * 而这两者的正确应对完全相反。
 */
const VERDICT_TRANSITIONS: Readonly<Record<VerdictStatus, readonly VerdictStatus[]>> = {
  // review run 运行中，尚无判决
  pending_verdict: ['emitted', 'invalid'],

  // 已产出，待 schema 校验
  emitted: ['validated', 'invalid'],

  // 通过校验 ⇒ 三条去向
  validated: ['dispatched_to_action', 'advisory', 'escalated'],

  // ★ 校验失败 ⇒ 三条处置路径
  invalid: ['pending_verdict', 'advisory', 'escalated'],

  // ── 终态 ──
  dispatched_to_action: [],
  advisory: [],
  escalated: [],
}

export function canTransitionVerdict(from: VerdictStatus, to: VerdictStatus): boolean {
  return VERDICT_TRANSITIONS[from].includes(to)
}

export function assertVerdictTransition(from: VerdictStatus, to: VerdictStatus): void {
  if (!canTransitionVerdict(from, to)) {
    throw new IllegalTransitionError('verdict', from, to)
  }
}

/** `invalid` 的三条处置路径对应的目标状态。 */
export function verdictStatusForResolution(
  resolution: 'retry' | 'downgrade_to_advisory' | 'escalate',
): VerdictStatus {
  switch (resolution) {
    case 'retry':
      return 'pending_verdict'
    case 'downgrade_to_advisory':
      return 'advisory'
    case 'escalate':
      return 'escalated'
  }
}
