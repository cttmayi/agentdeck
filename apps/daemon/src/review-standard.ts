/**
 * 「这个审核者按什么判」——**一处解析，三处使用**（D37）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么单开一个文件
 * ══════════════════════════════════════════════════════════════════
 *
 * 这条解析以前不存在，因为"标准"就是 skill 本身——谁需要就自己
 * `loadAgentSkills()` 一遍。现在标准内联在 agent 上，而**判定"这个审核者能不能
 * 用"**（派发审核）、**渲染第一句话**（`{{standards}}`）、**校验判决里的动作**
 * （白名单）是三处不同的调用点。三处各写一遍的后果是它们会分叉，而分叉的表现
 * 是"界面说它有标准、平台却不派审核"这类最难查的错。
 *
 * ══════════════════════════════════════════════════════════════════
 * 过渡期：老数据仍然用挂载的 skill 当标准
 * ══════════════════════════════════════════════════════════════════
 *
 * 内联标准是后加的字段，而使用者**已经有一个在跑的审核者**（挂着一份
 * skill）。规则如果直接改成"必须有内联标准"，那个审核者会**静默停摆**——
 * 产出照样跑，审核没了。所以这里保留一条兼容路径：
 *
 *   - 有内联标准 ⇒ 用它（正常路径）；
 *   - 没有内联标准、但挂了 skill ⇒ 用 skill 的正文与动作并集顶上，
 *     并把 `fromSkills: true` 带出去——**界面据此提示"建议改成内联标准"**，
 *     日志里也会说。这条路径是过渡，不是长期设计。
 *   - 两者都没有 ⇒ `null` = 没有标准 ⇒ 不派审核（提示语说清"没有标准"）。
 */
import type { ActionType, Agent } from '@alpha-helper/protocol'

/**
 * 解析只需要这三样，所以参数按**结构**收，不写死成 `Skill[]`。
 *
 * 原因：调用方手里未必是完整的 `Skill` 实体——执行器拿到的是 run 请求里的
 * skill 载荷（slug / name / body / allowedActions）。写死类型会逼出一个
 * "为了调这个函数而伪造一个 Skill"的转换层，那种层迟早长歪。
 */
interface StandardSource {
  name: string
  body: string
  allowedActions: readonly ActionType[]
}

export interface ResolvedStandard {
  /** 给人看的名字。 */
  name: string
  /** 标准正文（进第一句话的 `{{standards}}`）。 */
  body: string
  /** 判决里允许出现的动作。 */
  allowedActions: readonly ActionType[]
  /**
   * 标准是**从挂载的 skill 推出来的**（老数据）。
   *
   * 界面与日志据此提示迁移；不是错误，只是还没搬过来。
   */
  fromSkills: boolean
}

/**
 * 解析一个 agent 的审核标准。没有标准时返回 `null`。
 *
 * ⚠️ 传进来的 `skills` 必须是**这个 agent 挂载的那些**（按 agent 求解，D22）——
 *    别传全局的技能表。
 */
export function resolveReviewStandard(
  agent: Pick<Agent, 'reviewStandard'>,
  skills: readonly StandardSource[],
): ResolvedStandard | null {
  const inline = agent.reviewStandard
  if (inline && inline.body.trim() !== '') {
    return {
      name: inline.name,
      body: inline.body,
      allowedActions: inline.allowedActions,
      fromSkills: false,
    }
  }

  // ── 过渡期：老数据（标准在挂载的 skill 里）──
  const usable = skills.filter((s) => s.body.trim() !== '')
  if (usable.length === 0) return null
  return {
    // 多个 skill 时名字拼起来：它只用于显示与日志
    name: usable.map((s) => s.name).join('、'),
    body: usable.map((s) => s.body.trim()).join('\n\n'),
    // 并集：这就是改动之前的行为（判决动作按所有挂载 skill 的动作并集校验），
    // 所以过渡期的权限**一分不差**
    allowedActions: [...new Set(usable.flatMap((s) => s.allowedActions))],
    fromSkills: true,
  }
}
