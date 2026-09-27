import { type Agent, type Skill, type SkillId } from '@agentdeck/protocol'

/**
 * report 的审核路由（D28）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 从"按 kind 分派"改成"审核者是一个小组"
 * ══════════════════════════════════════════════════════════════════
 *
 * 原来这里按 `kindPatterns` 把报告分派给不同的审核 agent，还有一层
 * `isFallbackReviewer` 兜底。那套配置要求使用者在建 agent 时就想清楚
 * "哪些 kind 归谁"，而绝大多数用法里审核者只有一个——为一个不常用的
 * 能力付了四个字段的学习成本。
 *
 * 现在：**`role: 'reviewer'` 的 agent 都审每一份报告**。
 *
 * 多个审核者 ⇒ 各起一个 review run、产生多个 verdict（FR-AGENT-21 的
 * 多视角审核）。这不是"顺带支持"，而是这个模型**天然**给出的行为：
 * 既然没有分派规则，那"谁审"的答案就只能是"所有审的人"。
 */

export interface ReviewRouting {
  /** 匹配到的审核 agent。**可能多个** ⇒ 并行审核（FR-AGENT-21）。 */
  reviewers: Agent[]
  /**
   * 一个审核者都没有。
   *
   * ⚠️ 这时调用方必须**存下 report 并发出通知**，不得静默丢弃（FR-AGENT-22）——
   * 静默丢弃会让第三方以为处理过了，而实际上什么都没发生。
   */
  unmatched: boolean
}

/**
 * ★★ 一个审核者**有没有判断依据**（粗筛用的那一版）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 2026-09：判据跟着"标准并进「指令」"一起改（这里踩过一次真实的坑）
 * ══════════════════════════════════════════════════════════════════
 *
 * 它原来写的是 `a.reviewStandard !== null || a.skillIds.length > 0`——只看那个
 * **老字段**。而 2026-09 之后判断依据并进了 ② 身份（= `Agent.instructions`），
 * 新审核者身上**根本没有** `reviewStandard`：于是
 *
 *   · `createReviewRun` 痛快地放行（它按"身份非空"判）；
 *   · 而这里把它们**全部筛掉** ⇒ `unmatched` ⇒ 报告只落库 + 一条通知，
 *     一条 review run 都不起。
 *
 * 症状是"第三方报告再也没人审了"，而订阅方看到的是"已收到"——一个判据留在旧字段上，
 * 坏掉的是**另一条链路**。抓它的是 `review-e2e` 那条"报告落库、路由到兜底审核者"
 * （它依赖播种的审核者，而一次"保存时并进「指令」"的改动把那条记录的
 * `reviewStandard` 清成了 `null`）。
 *
 * ⚠️ 现在收三种，缺一种都是把某一代数据打回"没人审"：
 *   ① **`instructions` 非空** —— 新形态（依据并进「指令」）；
 *   ② **`reviewStandard` 非空** —— D37 那一代（内联标准）；
 *   ③ **挂了 skill** —— 更早的形态（正文住在 skill 里）。
 *
 * ⚠️ 它仍然是**粗筛**：域层手里没有 skill 的正文，"依据到底有没有内容"是 daemon 侧
 *    `reviewerIdentity` 的判断（那里会拒绝没有身份的派发）。两处判据必须**同向**
 *    （这里只许更宽，不许更窄）——反过来就会出现"能派却派不到"这种没有任何提示的
 *    停摆。
 */
export function hasReviewIdentity(agent: Agent): boolean {
  if ((agent.instructions ?? '').trim() !== '') return true
  if ((agent.reviewStandard?.body ?? '').trim() !== '') return true
  return agent.skillIds.length > 0
}

/**
 * 路由一份报告。
 *
 * ⚠️ 只看 `role`，**不看** `kind`。`kind` 仍然是报告自身的一个属性
 * （它决定审核者看到的是什么类型的材料），但它不再是**分派依据**。
 *
 * ⚠️ 顺带过滤"没有判断依据的审核者"：没有依据的审核审不出有结论的东西，把它当
 *    审核者只会起一条注定没意义的 run。判据见 `hasReviewIdentity`（它跟着
 *    2026-09 的"标准并进「指令」"改过一轮——那一次的症状是"报告全部 unmatched"）。
 */
export function routeReportToReviewers(agents: readonly Agent[]): ReviewRouting {
  const reviewers = agents.filter(
    (a) => a.role === 'reviewer' && hasReviewIdentity(a),
  )
  return { reviewers, unmatched: reviewers.length === 0 }
}

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
