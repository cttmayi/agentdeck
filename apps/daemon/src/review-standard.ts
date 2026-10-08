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
 * 动作权限**不在这个文件里**（2026-10 起彻底不在 agent 上）
 * ══════════════════════════════════════════════════════════════════
 *
 * 「判完**允许动什么**」的唯一出处是**智能体组**（`AgentGroup.allowedActions` /
 * `actionParams` / `debugActions`），建任务时展开进 `Run.*`；本文件只回答
 * "按什么判"。⚠️ 这个文件里曾经有一条三级的白名单回退链（agent → 老标准 →
 * 老 skill），它存在的唯一理由是**动作归属错了**——归属修对之后，那条链连同它的
 * 三个坑（"标准并进指令后动作整份丢掉"之类）一起删掉了。
 *
 * ══════════════════════════════════════════════════════════════════
 * 过渡期：老数据仍然用挂载的 skill 当**标准正文**
 * ══════════════════════════════════════════════════════════════════
 *
 * 内联标准是后加的字段，而使用者**已经有一个在跑的审核者**（挂着一份
 * skill）。规则如果直接改成"必须有内联标准"，那个审核者会**静默停摆**——
 * 产出照样跑，审核没了。所以这里保留一条兼容路径：
 *
 *   - 有内联标准 ⇒ 用它（正常路径）；
 *   - 没有内联标准、但挂了 skill ⇒ 用 skill 的**正文**顶上，并把
 *     `fromSkills: true` 带出去——**界面据此提示"建议改成内联标准"**，
 *     日志里也会说。这条路径是过渡，不是长期设计。
 *   - 两者都没有 ⇒ `null` = 没有标准 ⇒ 不派审核（提示语说清"没有标准"）。
 */
import type { ActionRefType, Agent } from '@agentdeck/protocol'

/**
 * 解析只需要这两样，所以参数按**结构**收，不写死成 `Skill[]`。
 *
 * 原因：调用方手里未必是完整的 `Skill` 实体——执行器拿到的是 run 请求里的
 * skill 载荷（slug / name / body）。写死类型会逼出一个"为了调这个函数而伪造
 * 一个 Skill"的转换层，那种层迟早长歪。
 *
 * ⚠️ **没有 `allowedActions`**：skill 只提供正文。老数据（老 skill 里可能还留着
 *    那个键）传进来也不会被读。
 */
interface StandardSource {
  name: string
  body: string
}

/**
 * 解析**身份 / 标准**只需要 agent 的这两样（动作已经不在这个文件里了）。
 *
 * 都按"可能没有"收：老数据里这些键可能**根本不存在**（store 不做 schema
 * 迁移，读取路径也不会替它补默认值）。
 */
interface ActionCapableAgent {
  /** 内联标准。整个键缺失与 `null` 同义——都是"没有内联标准"。 */
  reviewStandard: Agent['reviewStandard'] | undefined
  /** agent 的「指令」——**2026-09 之后它就是审核者身份的主干**。 */
  instructions?: string | null | undefined
}

export interface ResolvedStandard {
  /** 标准正文（进第一句话的 `{{standards}}`）。这是这份解析结果唯一的内容。 */
  body: string
  /**
   * 标准正文是**从挂载的 skill 推出来的**（老数据）。
   *
   * 界面与日志据此提示迁移；不是错误，只是还没搬过来。
   *
   * ⚠️ 它只说明**正文**从哪来：动作权限的出处与它无关（见文件头那条权威顺序）。
   */
  fromSkills: boolean
}


/**
 * 解析一个 agent 的审核标准。没有标准时返回 `null`。
 *
 * ⚠️ 传进来的 `skills` 必须是**这个 agent 挂载的那些**（按 agent 求解，D22）——
 *    别传全局的技能表。它们只提供标准**正文**（老数据的兼容路径）。
 */
/**
 * 一个审核者的**身份**：agent 的「指令」＋（老数据里的）审核标准正文。
 *
 * ══════════════════════════════════════════════════════════════════
 * 2026-09：标准并进「指令」，不再单独设置
 * ══════════════════════════════════════════════════════════════════
 *
 * 使用者的决定是「审核 Agent 的标准也放 ② 里面，不用单独设置」，而资格判据跟着
 * 改成「指令非空」。两件事必须一起做，否则会出现最难受的一种状态：
 *
 *   · 只改判据 ⇒ 一个**只写了标准、没写指令**的老审核者当场**静默停摆**（产出照样
 *     跑、审核没了）。这正是 `resolveReviewStandard` 那段兼容路径当初要防的事；
 *   · 只改归属 ⇒ 界面撤了那个框，而判据还在看它 ⇒ 新建的审核者永远派不出审核。
 *
 * 所以这里把两样**合成一份身份**：新数据只有「指令」，老数据把标准正文并进来
 * （挂在 skill 上的那条也认，那是 D37 之前的形状）。判据看的是**这份身份非空**——
 * 它就是 ② 要投递的那段文字，一分不差。
 */
export function reviewerIdentity(
  agent: ActionCapableAgent,
  skills: readonly StandardSource[],
): { text: string; fromLegacyStandard: boolean } {
  const instructions = (agent.instructions ?? '').trim()
  const legacy = resolveReviewStandard(agent, skills)?.body.trim() ?? ''
  // ⚠️ 指令在前：它是"这个审核者是谁"，标准是"它按什么判"——合成的这份里，
  //    顺序决定模型先读到哪一半。
  const text = [instructions, legacy].filter((part) => part !== '').join('\n\n')
  return { text, fromLegacyStandard: legacy !== '' }
}

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
  // ⚠️ 这里**没有动作**：skill 只提供正文。（D40 收口之前这一段会把 skill 的动作
  //    并起来——那等于让一个"资料包"顺手决定谁能改状态；2026-10 之后连 agent 上那份
  //    也撤掉了，动作的唯一出处是**智能体组**。）
  return { body: usable.map((s) => s.body.trim()).join('\n\n'), fromSkills: true }
}
