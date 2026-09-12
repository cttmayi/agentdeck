import { DomainError, DomainErrorCode } from '../errors.ts'

/**
 * 回路边界（INV-14~16）。
 *
 * 为什么必须有：`verdict → action → 新 run → 又被 review → 又出 verdict`
 * 是一个**会自我维持的环**。没有边界时它不是"可能出问题"，而是"迟早会
 * 烧掉大量 token 并把看板刷满"。而且这种环在人工观察下往往要几轮之后
 * 才看得出来——那时已经付出了成本。
 */

/** 链路里的一步。 */
export interface ChainStep {
  /** 被处理/被审核的对象标识。 */
  subjectId: string
  /** 这一步由哪个 agent 做。 */
  agentId: string
  /** 审核场景下的原因码。 */
  reasonCode?: string | null
}

export const DEFAULT_MAX_CHAIN_DEPTH = 5

/** 一步的识别键。同一 (对象, agent, 原因码) 再次出现即为环。 */
export function chainStepKey(step: ChainStep): string {
  return `${step.subjectId}\u0000${step.agentId}\u0000${step.reasonCode ?? ''}`
}

/**
 * 检测回路：返回**第一个重复出现**的那一步，没有环则返回 null。
 *
 * 判定口径是"同一 (对象, agent, 原因码) 出现两次"。这比"整条链路摘要重复"
 * 更实用：链路上游可能一直在变（新的 issue 被创建），但只要有一步在
 * 原地打转就值得停。
 */
export function detectChainCycle(steps: readonly ChainStep[]): ChainStep | null {
  const seen = new Set<string>()
  for (const step of steps) {
    const key = chainStepKey(step)
    if (seen.has(key)) return step
    seen.add(key)
  }
  return null
}

/** 链路深度校验。超限直接抛——静默截断会让"为什么没继续"变成谜。 */
export function assertChainWithinDepth(
  steps: readonly ChainStep[],
  maxDepth: number = DEFAULT_MAX_CHAIN_DEPTH,
): void {
  if (steps.length > maxDepth) {
    throw new DomainError(
      DomainErrorCode.ChainDepthExceeded,
      `链路深度 ${steps.length} 超过上限 ${maxDepth}，停止派生并升级给人`,
      { depth: steps.length, maxDepth },
    )
  }
}

export function assertNoChainCycle(steps: readonly ChainStep[]): void {
  const repeated = detectChainCycle(steps)
  if (repeated) {
    throw new DomainError(
      DomainErrorCode.ChainCycleDetected,
      `检测到回路：对象 ${repeated.subjectId} 上 agent ${repeated.agentId} 重复出现，停止派生`,
      { subjectId: repeated.subjectId, agentId: repeated.agentId },
    )
  }
}

/**
 * 派生前的一次性检查。
 *
 * 注意两条边界**同时**检查：只查深度挡不住短环（A→B→A），
 * 只查环挡不住长链。两个都要。
 */
export function assertCanDeriveRun(
  steps: readonly ChainStep[],
  maxDepth: number = DEFAULT_MAX_CHAIN_DEPTH,
): void {
  assertNoChainCycle(steps)
  assertChainWithinDepth(steps, maxDepth)
}
