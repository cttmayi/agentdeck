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
 * D40 收口：动作权限不住在 skill 里，也不再由 skill 参与
 * ══════════════════════════════════════════════════════════════════
 *
 * 「判完**允许动什么**」已经搬到 `Agent.allowedActions`（与标准分开：标准回答
 * "按什么判"，动作回答"判完能做什么"）。所以这里**不再**把挂载 skill 的
 * `allowedActions` 并进来——**skill 的正文只进 `{{standards}}`（可选的参考），
 * 它一个字都不参与动作授权**。
 *
 * ★ 白名单的**权威顺序只写在这一个函数里**（唯一解析点）：
 *
 *   1. `agent.allowedActions` 非空 ⇒ 用它；
 *   2. 空 ⇒ 回退到 `agent.reviewStandard?.allowedActions ?? []`——那是**老数据的
 *      只读兼容字段**（搬走之前动作就写在标准里，见协议里的注释）。
 *
 * 顺序写在两处就会分叉，而分叉的表现是"界面上看着允许、判决却判不合规"。
 * 别在调用方各写一遍。
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
import type { ActionRefType, Agent } from '@alpha-helper/protocol'

/**
 * 解析只需要这两样，所以参数按**结构**收，不写死成 `Skill[]`。
 *
 * 原因：调用方手里未必是完整的 `Skill` 实体——执行器拿到的是 run 请求里的
 * skill 载荷（slug / name / body）。写死类型会逼出一个"为了调这个函数而伪造
 * 一个 Skill"的转换层，那种层迟早长歪。
 *
 * ⚠️ **没有 `allowedActions`**：skill 只提供正文。老数据（老 skill 里可能还留着
 *    那个键）传进来也不会被读——包括它，才是"动作权限已经搬到审核者身上"这句
 *    话在代码里的样子。
 */
interface StandardSource {
  name: string
  body: string
  /**
   * 老 skill 里可能还留着的动作白名单（**只读兜底**，见 `effectiveAllowedActions`）。
   *
   * ⚠️ 读它**不代表** skill 是授权来源：新数据里动作权限只写在 `Agent.allowedActions`
   *    上。这里保留它是为了不让 D40 之前建好的审核者**突然失去所有动作**
   *    ——那种"没人动过任何配置、行为却变了"是最难查的一类变化。
   */
  allowedActions?: readonly ActionRefType[] | undefined
}

/**
 * 解析动作权限只需要 agent 的这两样。
 *
 * 都按"可能没有"收：老数据里 `allowedActions` 这个键**根本不存在**
 * （store 不做 schema 迁移，读取路径也不会替它补默认值），所以
 * `undefined` 与 `[]` 同义。
 */
interface ActionCapableAgent {
  /** 内联标准。整个键缺失与 `null` 同义——都是"没有内联标准"。 */
  reviewStandard: Agent['reviewStandard'] | undefined
  /** ★ 这个审核者允许触发哪些动作（D40 收口之后动作权限住在这里）。 */
  allowedActions?: readonly ActionRefType[] | undefined
}

export interface ResolvedStandard {
  /** 给人看的名字。 */
  name: string
  /** 标准正文（进第一句话的 `{{standards}}`）。 */
  body: string
  /** 判决里允许出现的动作（内置裸名或第三方命名空间，见 `ActionCapableAgent`）。 */
  allowedActions: readonly ActionRefType[]
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
 * ★ 动作白名单**在 agent 这一层的唯一取法**（D40 收口）：`Agent.allowedActions`
 * 优先，为空则回退到老数据里标准上那份。
 *
 * ⚠️ D42 起它上面还有一层：**任务级的 `Run.allowedActions`**（新建任务页 ③ 勾的
 *    那一份，只对这一次生效）。优先级是
 *      `run.allowedActions ?? resolveReviewStandard(...).allowedActions`
 *    ——**判据只看字段在不在**：`[]` 是"这一次一个都不许"（明确的选择），
 *    缺字段才是"跟随这里算出来的那份"。
 *
 *    两个消费点都在 `executor.ts`（渲染判决契约、判决收口校验），两处用的是
 *    **同一个**判据。写在这里是为了让"这个函数不再是全链路的唯一取法"这件事
 *    一眼可见——不然下一个人会以为改了这里就够了。
 *
 * 它不导出给调用方用——调用方要的是 `resolveReviewStandard(...).allowedActions`
 * （同一个函数里已经带上它了）。导出只会多出一个"另写一遍取法"的入口。
 */
function effectiveAllowedActions(
  agent: ActionCapableAgent,
  skills: readonly StandardSource[],
): readonly ActionRefType[] {
  const own = agent.allowedActions ?? []
  if (own.length > 0) return own

  // ── 老数据回退①：搬走之前，这份白名单写在**内联标准**里 ──
  const fromStandard = agent.reviewStandard?.allowedActions ?? []
  if (fromStandard.length > 0) return fromStandard

  // ── 老数据回退②：更早的形态里它写在**挂载的 skill** 里 ──
  //
  // ⚠️ 这一层只在上面两个都空时才走，而且**只读**（写入口永远只写
  //    `Agent.allowedActions`）。留着它的理由很具体：D40 之前建好的审核者
  //    （标准与动作都在 skill 里）如果因为这次搬家拿到空白名单，它的判决会
  //    突然整条无效——而使用者**没有动过任何配置**。那种"我什么都没改，行为
  //    却变了"是最难查的一类变化。
  //
  //    界面上对这种 agent 本来就有提示（正文来自 skill，建议固化），固化的
  //    `adopt-from-skills` 会把正文与动作一起搬到 agent 上。
  return skills.flatMap((s) => s.allowedActions ?? [])
}

/**
 * 解析一个 agent 的审核标准。没有标准时返回 `null`。
 *
 * ⚠️ 传进来的 `skills` 必须是**这个 agent 挂载的那些**（按 agent 求解，D22）——
 *    别传全局的技能表。它们只提供标准**正文**（老数据的兼容路径）。
 */
export function resolveReviewStandard(
  agent: ActionCapableAgent,
  skills: readonly StandardSource[],
): ResolvedStandard | null {
  const allowedActions = effectiveAllowedActions(agent, skills)
  const inline = agent.reviewStandard
  if (inline && inline.body.trim() !== '') {
    return {
      name: inline.name,
      body: inline.body,
      allowedActions,
      fromSkills: false,
    }
  }

  // ── 过渡期：老数据（**正文**在挂载的 skill 里）──
  const usable = skills.filter((s) => s.body.trim() !== '')
  if (usable.length === 0) return null
  return {
    // 多个 skill 时名字拼起来：它只用于显示与日志
    name: usable.map((s) => s.name).join('、'),
    body: usable.map((s) => s.body.trim()).join('\n\n'),
    // ⚠️ 动作来自 `effectiveAllowedActions`（权威顺序在那儿写着）：这里**不再**
    //    无条件取 skill 的动作并集（D40 收口之前那一段就是干这个的）——那等于让
    //    一个"资料包"顺手决定谁能改状态。只有前两级都空时，它才作最后一级兜底。
    allowedActions,
    fromSkills: true,
  }
}
