/**
 * **内置起草者**（沉淀/skill 起草那条链的执行者，2026-10 定稿，§9）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它解决的是哪件事
 * ══════════════════════════════════════════════════════════════════
 *
 * 从前起草 run 借的是**来源那条 run 的执行者**的身份（`agentRef.instructions =
 * sourceAgent.instructions`）⇒ 起草质量**取决于你从哪条 run 发起沉淀**：同一个人
 * 同一件事，从聊天发起与从任务发起，起草出来的 skill 结构可能不一样。用户拍的是
 * 把它做成一个**内置智能体**：可在「智能体」页查看与编辑、可「恢复成默认值」。
 *
 * ══════════════════════════════════════════════════════════════════
 * 三条纪律（每一条都对应一种"静默坏掉"）
 * ══════════════════════════════════════════════════════════════════
 *
 *   ① **幂等**：已存在就**不覆盖**。使用者改过的指令是他自己的资产，平台升级不许
 *      冲掉它（设计的第 ⑥ 条）——「恢复成默认值」是他自己要按的那个按钮。
 *   ② **自愈**：只在"损坏"时补（内置标记丢了、指令空了）。判据是**损坏**而不是
 *      "与默认不同"——后者会把使用者的改动当成损坏一次次抹掉。
 *   ③ **不许删的语义落在这里**：它只增不减；调用方（启动流程）每次启动都调一次，
 *      所以使用者就算绕过界面删了，下次启动它也会回来，而且**日志说得出这件事**。
 *
 * ⚠️ 每次启动都跑（不是首启一次）：自愈与"删了会回来"都要求它在每次启动时看一眼。
 *    代价是一次 listAgents，与启动时别的对账（`runAgentLegacyCleanupOnce`）同一量级。
 */

import { ulid } from '@agentdeck/protocol'
import type { Agent, WorkspaceId } from '@agentdeck/protocol'
import type { Store } from '@agentdeck/domain'

/** 内置起草者的默认名字（使用者可改，改名不影响它是不是内置——认的是 `builtin`）。 */
export const DRAFTER_NAME = '起草者（内置）'

/**
 * 默认指令。
 *
 * ⚠️ 现在**只写身份**：写法规范（原 `writing-skills` 那份正文）在这一刀里还没搬过来
 *    ——按定稿第 ③ 条它要从"注入技能"改为"进 prompt"，那是下一步的事。这一步先把
 *    "起草者是谁、守哪几条纪律"立住，避免一次改两件事（改坏了不知道是哪一件）。
 */
export const DRAFTER_INSTRUCTIONS = [
  '你是 skill 起草者：把一段真实的经验，写成一条以后能被复用的 skill。',
  '',
  '## 你守的纪律',
  '',
  '1. **只写可复用的步骤**：一次性的细节、与这次任务绑死的数据，一律不要写进去。',
  '2. **依据必须来自素材**：素材里没有的东西不要编（宁可不写）。',
  '3. **结构是硬要求**：正文必须有 `## When to Use` 与 `## Procedure` 两节——缺了入库会被拒。',
  '4. **不值得沉淀就说出来**：判定"这段经验不可复用"是正当结论，不要硬凑一条 skill。',
  '5. **产出是文件**：写到工作目录里约定的产出目录，而不是只在回复里贴一段文字。',
].join('\n')

/** 内置 skill 审核者的默认名字。 */
export const SKILL_REVIEWER_NAME = 'Skill 审核者（内置）'

/**
 * 默认指令（§10 第 ④ 条：审起草出来的 skill）。
 *
 * ⚠️ 第 ③ 条（**脚本真执行**）还没实作、那个"总开关"也还没定，所以这份指令现在
 *    **不含"去把脚本跑一遍"**——先立住"审什么"，等开关定了再加那一条。
 */
export const SKILL_REVIEWER_INSTRUCTIONS = [
  '你是 skill 审核者：审一条刚起草出来的 skill **能不能用**，而不是重写它。',
  '',
  '## 你审什么',
  '',
  '1. **结构与契约**：正文是否有 `## When to Use` 与 `## Procedure`；frontmatter 的 `name` 是否 kebab-case、`description` 是否含触发条件。',
  '2. **可复现性**：Procedure 里的命令是否带够参数、路径是否真的存在、引用的支持文件是否都在。',
  '3. **依据**：正文的每一步是否能在素材里找到出处（素材里没有的东西不许出现）。',
  '4. **脚本**：`scripts/` 下的脚本是否语法完整、是否声明了依赖、引用的路径是否存在。',
  '5. **可复用性**：是不是只把这一次的任务抄了一遍（那样不算一条可复用的 skill）。',
  '',
  '## 你的产出',
  '',
  '一条结论 + 问题清单：**结论**（通过 / 不通过）、每条问题的**具体位置与理由**、以及**证据**。',
  '不要重写正文，也不要给"更好的版本"——重写是起草者的事，你只指出哪里不合格。',
].join('\n')

/** 一次对账的结果（给日志与测试：说得出这次做了什么、为什么）。 */
export type EnsureDrafterResult =
  | { action: 'created'; agentId: string }
  | { action: 'healed'; agentId: string; why: string }
  | { action: 'left-alone'; agentId: string }
  | { action: 'skipped'; why: string }

/**
 * 确保这个工作区有一条可用的内置起草者。
 *
 * 只在三种情况下动手：**没有**（建）、**内置标记丢了或指令空了**（补）、
 * **正常**（一字不动）。使用者改过的指令永远不动。
 */
/**
 * 确保这个工作区有一条可用的内置 **skill 审核者**（§10 第 ④ 条）。
 *
 * 与起草者同一套纪律（幂等 / 自愈 / 不覆盖使用者改动），只有角色与默认指令不同。
 * ⚠️ 角色是 `'skill-reviewer'` 而**不是** `'reviewer'`：业务报告的路由按
 *    `role === 'reviewer'` 挑人，给它那个角色它会去审业务报告（见 `entities.ts` 的注释）。
 */
export async function ensureBuiltinReviewer(
  store: Store,
  workspaceId: WorkspaceId,
): Promise<EnsureDrafterResult> {
  const all = await store.listAgents(workspaceId)
  // 认 `builtin` + **这个角色**：起草者也是 `builtin`，不能按标记一把抓。
  const found = all.find((a) => a.builtin === true && a.role === 'skill-reviewer')
  if (!found) {
    const byRole = all.find((a) => a.role === 'skill-reviewer')
    if (byRole) {
      await store.insertAgent({ ...byRole, builtin: true, updatedAt: Date.now() })
      return { action: 'healed', agentId: byRole.id as string, why: '内置标记丢了（按角色认出来）' }
    }
    const now = Date.now()
    const agent: Agent = {
      id: ulid() as Agent['id'],
      workspaceId,
      name: SKILL_REVIEWER_NAME,
      instructions: SKILL_REVIEWER_INSTRUCTIONS,
      model: null,
      runtimeKey: 'default',
      workDir: null,
      skillIds: [],
      env: {},
      role: 'skill-reviewer',
      builtin: true,
      // 它不审业务报告 ⇒ 不需要业务审核标准；没有标准，平台也不会把产出交给它审
      reviewStandard: null,
      createdAt: now,
      updatedAt: now,
    }
    await store.insertAgent(agent)
    return { action: 'created', agentId: agent.id as string }
  }
  if (found.instructions.trim() === '') {
    await store.insertAgent({
      ...found,
      instructions: SKILL_REVIEWER_INSTRUCTIONS,
      updatedAt: Date.now(),
    })
    return { action: 'healed', agentId: found.id as string, why: '指令被清空了' }
  }
  return { action: 'left-alone', agentId: found.id as string }
}

/**
 * 确保**内置的那一对**（起草者 + skill 审核者）都在。
 *
 * 为什么合成一个入口：启动时只调一次、日志只写一处，而且两个的自愈理由一样
 * （幂等 / 补标记 / 补空指令）。分开调的话"只补了一个"这种半坏状态没人会发现。
 */
export async function ensureBuiltinAgents(
  store: Store,
  workspaceId: WorkspaceId,
): Promise<{ drafter: EnsureDrafterResult; reviewer: EnsureDrafterResult }> {
  const drafter = await ensureBuiltinDrafter(store, workspaceId)
  const reviewer = await ensureBuiltinReviewer(store, workspaceId)
  return { drafter, reviewer }
}

export async function ensureBuiltinDrafter(
  store: Store,
  workspaceId: WorkspaceId,
): Promise<EnsureDrafterResult> {
  const all = await store.listAgents(workspaceId)
  // 认的是 `builtin` 标记（不是名字）：名字使用者能改，按名字认会在改名后失效，
  // 而失效的表现是"它又能被删/被选去跑业务任务"——静默且查起来很远。
  const found = all.find((a) => a.builtin === true)
  if (!found) {
    // ⚠️ 也认 `role: 'drafter'`：标记丢了但角色还在 ⇒ 那是"损坏"，补标记而不是再造一条
    //    （否则每次启动都会多出一条起草者，而列表里看起来只是"又有了一条"）。
    const byRole = all.find((a) => a.role === 'drafter')
    if (byRole) {
      await store.insertAgent({ ...byRole, builtin: true, updatedAt: Date.now() })
      return { action: 'healed', agentId: byRole.id as string, why: '内置标记丢了（按角色认出来）' }
    }
    const now = Date.now()
    const agent: Agent = {
      id: ulid() as Agent['id'],
      workspaceId,
      name: DRAFTER_NAME,
      instructions: DRAFTER_INSTRUCTIONS,
      model: null,
      // 跟随全局默认（第 ⑦ 条）：不把它烙成某个 CLI——否则使用者改了全局默认，
      // 内置起草者反而不跟着变，而"内置"恰恰应当是最跟随平台设置的那一条。
      runtimeKey: 'default',
      workDir: null,
      // ★ 不挂任何 skill：按定稿第 ③ 条，起草 run 的技能集合是写死的，与它挂什么无关；
      //   给它挂业务技能只会让人以为那些技能会影响起草（它们不会）。
      skillIds: [],
      env: {},
      role: 'drafter',
      builtin: true,
      // 审核标准（D37）：起草者不审任何东西 ⇒ 没有标准（也正因为没有，平台不会把产出
      // 交给它审——这正是这一步要的：**起草者绝不参与业务选择**）。
      reviewStandard: null,
      createdAt: now,
      updatedAt: now,
    }
    await store.insertAgent(agent)
    return { action: 'created', agentId: agent.id as string }
  }
  if (found.instructions.trim() === '') {
    // 指令被清空 ⇒ 起草 run 拿到的身份是空的，产出会变成"随便写写"。补回默认。
    await store.insertAgent({ ...found, instructions: DRAFTER_INSTRUCTIONS, updatedAt: Date.now() })
    return { action: 'healed', agentId: found.id as string, why: '指令被清空了' }
  }
  return { action: 'left-alone', agentId: found.id as string }
}
