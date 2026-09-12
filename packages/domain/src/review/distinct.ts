import type { AgentId, Report, Run } from '@alpha-helper/protocol'
import { ReviewerMustDifferError } from '../errors.ts'

/**
 * reviewer ≠ executor（INV-1~3）。
 *
 * 为什么这是一条**不变量**而不是一条建议：如果允许同一个 agent 干完自己审，
 * S1 的整个闭环就是假的——"审核"会退化成"自我确认"。整个产品的定位随之失效。
 *
 * 因此校验放在 **run 创建时**（写入之前），而不是执行时。让它跑起来再失败，
 * 使用者已经付出了时间和 token 成本，还可能误以为产出被审过了。
 */

/** 可以被审核的对象。 */
export type ReviewSubject =
  | { type: 'report'; report: Report }
  | { type: 'run'; run: Run }

/**
 * 若 review 的审核对象是**本机某个执行 run 的产出**，则审核者必须不同；
 * 审核第三方进来的 report 时没有这个约束（没有"执行者"可言）。
 */
export function assertReviewerDistinct(reviewerAgentId: AgentId, subject: ReviewSubject): void {
  if (subject.type !== 'run') return
  if (subject.run.agentId === reviewerAgentId) {
    throw new ReviewerMustDifferError(reviewerAgentId)
  }
}

/** 同一判断的布尔形态——供 UI 过滤候选审核者使用。 */
export function isReviewerDistinct(reviewerAgentId: AgentId, subject: ReviewSubject): boolean {
  if (subject.type !== 'run') return true
  return subject.run.agentId !== reviewerAgentId
}

/**
 * 给 UI 用的候选列表：把执行者从审核者候选中**直接剔除**。
 *
 * 从交互上避免误配，比事后报错更好——但两者都要有：UI 过滤挡常见情况，
 * 服务端校验挡 API 直连（INV-3 要求不得静默降级）。
 */
export function reviewerCandidates<T extends { id: AgentId }>(
  all: readonly T[],
  subject: ReviewSubject,
): T[] {
  return all.filter((a) => isReviewerDistinct(a.id, subject))
}
