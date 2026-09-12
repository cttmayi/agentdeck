/**
 * 领域错误。
 *
 * 每个错误都带一个**机器可读的 code**——因为本项目的错误不只是给人看的：
 * 它们要参与重试判定、动作失败处理、通知分类。只给自然语言消息会让
 * 上层只能靠字符串匹配来分支，那是隐患。
 */

export const DomainErrorCode = {
  /** 状态机非法转移。 */
  IllegalTransition: 'ILLEGAL_TRANSITION',
  /** reviewer 与 executor 是同一个 agent（INV-1~3）。 */
  ReviewerMustDiffer: 'REVIEWER_MUST_DIFFER',
  /** 链路深度超限（INV-14）。 */
  ChainDepthExceeded: 'CHAIN_DEPTH_EXCEEDED',
  /** 检测到回路（INV-15）。 */
  ChainCycleDetected: 'CHAIN_CYCLE_DETECTED',
  /** 动作不在注册表内（INV-9）。 */
  UnknownActionType: 'UNKNOWN_ACTION_TYPE',
  /** 找不到实体。 */
  NotFound: 'NOT_FOUND',
  /** 违反唯一性约束（如去重键冲突）。 */
  Conflict: 'CONFLICT',
} as const

export type DomainErrorCode = (typeof DomainErrorCode)[keyof typeof DomainErrorCode]

export class DomainError extends Error {
  readonly code: DomainErrorCode
  readonly details: Readonly<Record<string, unknown>>

  constructor(
    code: DomainErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'DomainError'
    this.code = code
    this.details = Object.freeze({ ...details })
  }
}

/** 状态机非法转移。 */
export class IllegalTransitionError extends DomainError {
  constructor(entity: string, from: string, to: string) {
    super(
      DomainErrorCode.IllegalTransition,
      `${entity} 状态不能从 ${from} 转移到 ${to}`,
      { entity, from, to },
    )
    this.name = 'IllegalTransitionError'
  }
}

/** reviewer 与 executor 不得相同。 */
export class ReviewerMustDifferError extends DomainError {
  constructor(agentId: string) {
    super(
      DomainErrorCode.ReviewerMustDiffer,
      `审核者与执行者不能是同一个 agent（均为 ${agentId}）。请指定不同的 reviewer agent。`,
      { agentId },
    )
    this.name = 'ReviewerMustDifferError'
  }
}
