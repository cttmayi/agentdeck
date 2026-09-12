import { agentMatchesKind, type Agent, type Skill, type SkillId } from '@alpha-helper/protocol'

/**
 * report 的审核路由（D24）。
 *
 * 这个文件体现了 D24 带来的那个**统一**：
 *
 *   `kind` 既是**路由键**（决定由哪个 agent 审），
 *   也是**审核标准选择键**（该 agent 挂的 skill 就是审它的标准）。
 *
 * 所以 S2 的路由规则与审核标准选择**是同一件事**，不需要两套配置——
 * 这也是为什么 `kind → skill` 的映射要配在 agent 上（C8 = 甲）。
 */

export interface ReviewRouting {
  /** 匹配到的审核 agent。**可能多个** ⇒ 并行审核（FR-AGENT-21）。 */
  reviewers: Agent[]
  /** 是否走了兜底审核者。 */
  usedFallback: boolean
  /**
   * 既没有匹配、也没有兜底审核者。
   *
   * ⚠️ 这时调用方必须**存下 report 并发出通知**，不得静默丢弃（FR-AGENT-22）——
   * 静默丢弃会让第三方以为处理过了，而实际上什么都没发生。
   */
  unmatched: boolean
}

/**
 * 按 kind 路由到审核 agent。
 *
 * 三种情形：
 * 1. 恰好一个匹配 → 起一个 review run（最常见）
 * 2. 多个匹配     → **各起一个**，产生多个 verdict（多视角审核）
 * 3. 没有匹配     → 走兜底审核者；没有兜底则 unmatched
 */
export function routeReportToReviewers(kind: string, agents: readonly Agent[]): ReviewRouting {
  const matched = agents.filter((a) => agentMatchesKind(a.kindPatterns, kind))
  if (matched.length > 0) {
    return { reviewers: matched, usedFallback: false, unmatched: false }
  }

  const fallbacks = agents.filter((a) => a.isFallbackReviewer)
  if (fallbacks.length > 0) {
    return { reviewers: fallbacks, usedFallback: true, unmatched: false }
  }

  return { reviewers: [], usedFallback: false, unmatched: true }
}

/**
 * 求解某个 agent 审某个 kind 时应该用哪些 skill。
 *
 * 优先级：**显式 `kindSkillOverride` > agent 挂载的 skill 子集**。
 *
 * ★ 注意"agent 挂载的**子集**"这个限定（FR-AGENT-03）：一个 workspace 里
 *   可能有几十个 skill，但每个 agent 只用其中一部分。这不是优化，是分工的
 *   本体——安全 agent 不该带着"文档校对"的标准去审代码。
 */
export function resolveSkillsForKind(
  agent: Agent,
  kind: string,
  available: readonly Skill[],
): Skill[] {
  const byId = new Map<SkillId, Skill>(available.map((s) => [s.id, s]))

  const override = agent.kindSkillOverride[kind]
  if (override) {
    const skill = byId.get(override)
    return skill ? [skill] : []
  }

  return agent.skillIds.flatMap((id) => {
    const skill = byId.get(id)
    return skill ? [skill] : []
  })
}

/**
 * 解析一个 run 实际要注入的技能集合。
 *
 * 多 agent 分工的硬约束在这里落地（D22）：**技能注入必须按 run 的 agent 求解**，
 * 不能"全局挂载一次"。同一个 workspace 下不同 agent 注入的技能目录内容不同。
 */
export function resolveRunSkills(agent: Agent, available: readonly Skill[]): Skill[] {
  const byId = new Map<SkillId, Skill>(available.map((s) => [s.id, s]))
  return agent.skillIds.flatMap((id) => {
    const skill = byId.get(id)
    return skill ? [skill] : []
  })
}
