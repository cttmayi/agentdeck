/**
 * 「这个 agent 的判断依据在哪」——**老数据的读取路径**（D37 / D38）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 2026-11（D125）：这个文件只剩一件事——**搬家**
 * ══════════════════════════════════════════════════════════════════
 *
 * 它原来有三个用途：判定"这个审核者能不能用"（派发审核）、渲染第一句话的
 * `{{standards}}`、以及判决里动作白名单那一处（D123 时已删）。
 *
 * **审核 run 退场**之后前两个也一起没了——平台不再派审核，② 身份就是 agent 自己的
 * 「指令」。于是这里只剩最后一件还在生效的事：
 *
 *   `POST /api/agents/:id/review-standard/adopt-from-skills`——把**老形态**的判断
 *   依据（内联的老字段 `reviewStandard`，或者更老的形态：挂在 skill 上的正文）搬进
 *   「指令」。那条路是给已经存在于库里的数据用的，不搬的话那些 agent 的判断依据
 *   会随着这个字段一起变成没人读的东西。
 *
 * ⚠️ 所以本文件**不是**"审核标准的解析器"，它是**一次性的迁就**：等库里没有
 *   老数据了，它就该整份删掉（留着它的每一天都在暗示"标准还是个独立概念"）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 过渡期：老数据仍然用挂载的 skill 当**正文**
 * ══════════════════════════════════════════════════════════════════
 *
 * 内联标准是后加的字段，而使用者**已经有一个在跑的审核者**（挂着一份 skill）。
 * 规则如果直接改成"必须有内联标准"，那个审核者的判断依据会**悄无声息地消失**
 * ——产出照样跑，只是没人按老标准看它了。所以这里保留一条兼容路径：
 *
 *   - 有内联标准 ⇒ 用它（正常路径）；
 *   - 没有内联标准、但挂了 skill ⇒ 用 skill 的**正文**顶上，并把
 *     `fromSkills: true` 带出去——界面据此提示"建议并进指令"。
 *   - 两者都没有 ⇒ `null` = 没有可搬的东西。
 */
import type { Agent } from '@agentdeck/protocol'

/**
 * 解析只需要这两样，所以参数按**结构**收，不写死成 `Skill[]`。
 *
 * 原因：调用方手里未必是完整的 `Skill` 实体。写死类型会逼出一个"为了调这个函数而
 * 伪造一个 Skill"的转换层，那种层迟早长歪。
 *
 * ⚠️ **没有 `allowedActions`**：skill 只提供正文。老数据（老 skill 里可能还留着
 *    那个键）传进来也不会被读——动作能力已经整体退场（D123）。
 */
interface StandardSource {
  name: string
  body: string
}

/**
 * 解析**判断依据**只需要 agent 的这两样（动作早已不在这个文件里）。
 *
 * 都按"可能没有"收：老数据里这些键可能**根本不存在**（store 不做 schema
 * 迁移，读取路径也不会替它补默认值）。
 */
interface ActionCapableAgent {
  /** 内联标准。整个键缺失与 `null` 同义——都是"没有内联标准"。 */
  reviewStandard: Agent['reviewStandard'] | undefined
  /** agent 的「指令」——**2026-09 之后它就是身份的主干**。 */
  instructions?: string | null | undefined
}

export interface ResolvedStandard {
  /** 标准正文。这是这份解析结果唯一的内容。 */
  body: string
  /**
   * 正文是**从挂载的 skill 推出来的**（老数据）。
   *
   * 界面据此提示迁移；不是错误，只是还没搬过来。
   */
  fromSkills: boolean
}

/**
 * 解析一个 agent 的老判断依据。没有时返回 `null`。
 *
 * ⚠️ 传进来的 `skills` 必须是**这个 agent 挂载的那些**（按 agent 求解，D22）——
 *    别传全局的技能表。它们只提供标准**正文**（老数据的兼容路径）。
 */
export function resolveReviewStandard(
  agent: ActionCapableAgent,
  skills: readonly StandardSource[],
): ResolvedStandard | null {
  const inline = agent.reviewStandard
  if (inline && inline.body.trim() !== '') {
    return { body: inline.body, fromSkills: false }
  }

  // ── 过渡期：老数据（**正文**在挂载的 skill 里）──
  const usable = skills.filter((s) => s.body.trim() !== '')
  if (usable.length === 0) return null
  // ⚠️ 这里**没有动作**：skill 只提供正文。让一个"资料包"顺手决定谁能改状态，
  //    是 D40 收口之前的老毛病（那条链已经删干净了）。
  return { body: usable.map((s) => s.body.trim()).join('\n\n'), fromSkills: true }
}
