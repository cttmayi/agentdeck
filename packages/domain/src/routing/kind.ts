import { type Agent, type Skill, type SkillId } from '@agentdeck/protocol'

/*
 * ⚠️ 2026-11（D125）：`hasReviewIdentity`（"这个审核者有没有判断依据"的三态粗筛）
 *   随 `routeReportToReviewers` 一起删——它唯一的调用方就是报告路由。报告摄取退场之后
 *   平台里不再有"把一份报告交给谁审"这件事。
 */

/*
 * ⚠️ 2026-11（D125）：这里原来是 `routeReportToReviewers`——"`role: 'reviewer'` 的
 *   agent 都审每一份报告"（D28 把按 kind 分派换成这一条，多审核者 ⇒ 各起一个
 *   review run）。**报告摄取整条链退场** ⇒ 没有"一份报告要路由给谁"这件事了，
 *   函数与 `ReviewRouting` 类型一起删。
 *
 *   ⚠️ 它上面那条教训值得留着：判据曾经只看老字段 `reviewStandard`，而 2026-09
 *   之后判断依据并进了 `instructions` ⇒ 新审核者全被筛掉 ⇒ 报告只落库、一条 review
 *   run 都不起，症状是"第三方报告再也没人审了"。**一个判据留在旧字段上，坏掉的
 *   会是另一条链路**。
 */

/**
 * 某个 agent 该用哪些 skill。
 *
 * ══════════════════════════════════════════════════════════════════
 * D28 之后少了一层：不再有"按 kind 覆盖"
 * ══════════════════════════════════════════════════════════════════
 *
 * 原来这里是"显式 `kindSkillOverride` > agent 挂载的子集"。kind 分派没了，
 * 覆盖也就没了着落——一个 agent 挂哪些 skill 就是它用哪些，**只有一层**。
 *
 * ★ "子集"这个限定仍然成立（FR-AGENT-03）：一个 workspace 里可能有几十个
 *   skill，但每个 agent 只用其中一部分。这不是优化，是分工的本体——
 *   安全 agent 不该带着"文档校对"的标准去审代码。
 */
export function resolveSkillsForAgent(agent: Agent, available: readonly Skill[]): Skill[] {
  const byId = new Map<SkillId, Skill>(available.map((s) => [s.id, s]))
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
