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
  /**
   * ★ 分批第 26 批：使用者的要求是**约定的来源**，不是"可选开关"。
   *
   * 真机证据：使用者在素材里写了「使用 ASD-STE100 的方式 写成一篇文章」「参考《金字塔原理》」，
   * 产出写成「**如果**用户要求金字塔原理…**如果**要求 ASD-STE100…」⇒ 使用者原话
   * 「这些要求就是我对此部分的习惯…需要总结进 skill 中，这才有沉淀的意义」。
   */
  '3b. **使用者的要求是默认约定，不是开关**：素材里使用者的原话（平台已抽成 `material/user-requirements.md`）' +
    '要写进正文的 `## 约定` 一节，**无条件生效**；只有素材**明确**写了"这次/本次/临时/就这一篇"，' +
    '才允许写成"如果用户要求…"。要求里出现的专名（书名、标准号）原样保留，不要换成同义词。',
  '4. **不值得沉淀就说出来**：判定"这段经验不可复用"是正当结论，不要硬凑一条 skill。',
  '5. **产出是文件**：写到工作目录里约定的产出目录，而不是只在回复里贴一段文字。',
].join('\n')

/** 内置 skill 审核者的默认名字。 */
export const SKILL_REVIEWER_NAME = 'Skill 审核者（内置）'

/**
 * **老版本**的审核指令（逐字冻结，分批第 21 批收窄判据时挪到这里）。
 *
 * ⚠️ 必须**一个字符都不改**地留着：升级的判据是"存着的指令 === 这一份"——
 *    手改一个标点，使用者工作区里的老指令就比对不上，永远升不上来，而表现是
 *    "我明明改了判据，怎么审起来还是老样子"（本仓库最典型的一类静默失效）。
 *    第一版我想的是"存着的指令 !== 当前默认 ⇒ 就当老版本升级"——那会把**使用者自己
 *    写的指令**也覆盖掉（第 ⑥ 条明令不许），所以只能按"已知的历史文本"逐字认。
 */
export const SKILL_REVIEWER_INSTRUCTIONS_V1 = [
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

/** 已知的历史版本（升级判据：存着的指令逐字等于其中一份 ⇒ 那是平台的老默认，可以换）。 */
const REVIEWER_INSTRUCTIONS_HISTORY: readonly string[] = [SKILL_REVIEWER_INSTRUCTIONS_V1]

/**
 * 默认指令（§10 第 ④ 条：审起草出来的 skill）。**分批第 21 批收窄成"可执行性"**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么收窄（使用者拍的板，理由来自他真机上的 10 版链）
 * ══════════════════════════════════════════════════════════════════
 *
 * 老判据五条（结构/可复现/依据/脚本/可复用）在实践中把三分之二的力气花在"命令能不能按
 * 原文跑通"上，而**方向性**问题（该不该这么长、边界在哪）只在第 1 版出现过一次；同时
 * 出现了两件更坏的事：
 *   · 同一份内容被判出「通过 · 通过 · 不通过」（内容一个字节没动）；
 *   · 「依据」（素材里有没有）与「可复用」（别只抄这一次的任务）是**一对张力**——
 *     同一份文档在 v1 因"把一次性常量写进可复用技能"挨批，在 v6 又因"这个 API 调用
 *     素材里没有"挨批，起草者怎么做都不过。
 *
 * 所以现在只审**这条 skill 能不能被照着执行**，并明确列出**不审**的东西——"没说不审"
 * 就一定会审，而每审一条就多一轮返工（他这条链 10 版 / $29.81）。
 * 机械可判定的那部分（语法、引用文件、骨架、占位符）已改由**平台定检**先跑
 * （`skill-exec-check.ts`），这里明确让它采信、不要重查。
 */
export const SKILL_REVIEWER_INSTRUCTIONS = [
  '你是 skill 审核者：只审这条 skill **能不能被照着执行**，不审"这是不是一次漂亮的任务"。',
  '',
  '## 你审的五件事（只有这五项能让你判不通过）',
  '',
  '1. **脚本能不能跑**：`scripts/` 下的脚本要**带真实输入真跑一次**（工作区关掉真执行时，如实写"未执行"，不许写"已执行通过"）。',
  '   语法/引用文件/骨架/占位符这些**平台已经跑过定检**（`material/exec-check.md`，起审核之前生成）：直接采信，不要重复查；标「没查」的项**没有结论**，不许当成通过。',
  '2. **命令块能不能照着敲**：正文里每条命令的参数、选项、占位符与**输入形态**是否成立——参数名写错、缺必填选项、URL 里有空格没编码、命令以为的输入与上一步真实产出对不上，都算。',
  '3. **反规避**：为了"跑通"而让命令不再做那件事，同样不合格——`|| true`、`2>/dev/null`、把参数写死成样例值、把切片换成全文，都是这一类。',
  '4. **步骤衔接**（只到这一层）：上一步的产出能不能当下一步的输入；声明与步骤互相打架、让执行者卡住也算。',
  /**
   * ★ 分批第 26 批：使用者的要求有没有落点。
   *
   * 为什么这条该进审核：使用者对这次沉淀的诉求就是"我的习惯要进 skill"（原话：
   * 「这些要求就是我对此部分的习惯…需要总结进 skill 中，这才有沉淀的意义」）。
   * 清单在 `material/user-requirements.md` 里是**原文**，所以这条判据不需要新的判断力——
   * 只要对着清单核一遍：每条有没有落点、有没有被写成"如果用户要求…"的可选分支。
   * 平台的机械落点检查（专名出没出现）在 `material/exec-check.md` 里，不用重复查。
   */
  '5. **使用者的要求有没有落点**：`material/user-requirements.md` 里每一条要求，都要在正文里有落点' +
    '（优先是 `## 约定` 一节，且**不是**"如果用户要求…"的条件句）；没落点的每条都要进 findings。' +
    '专名的机械检查看 `material/exec-check.md`，标「没查」的项不许当成通过。',
  '',
  '## 你不审的（明确列出来，免得白改一轮）',
  '',
  '· 任务结果对不对、取材够不够——不报。',
  '· 这条 skill 该不该这么长、该不该拆——不报。',
  '· 素材里有没有这个做法（依据）——不报：那是起草者守的纪律，不是你的判据。',
  '· 措辞、风格、章节命名——不报（**但**第 5 项点名要求过的风格/结构要报：那是要求，不是措辞偏好）。',
  '',
  '## 你的产出',
  '',
  '一条结论 + 问题清单：**结论**（上面四项都过 ⇒ 通过；任何一项不过 ⇒ 不通过）、',
  '每条问题给**具体位置**（`文件:行号` 或 `文件#小节`）、**那一处的原文**，以及**证据**（跑过的命令、退出码、真实输出）。',
  '四项都过就给通过，**即使你觉得还能更好**——"还能更好"不是不通过的理由，否则每一版都过不了。',
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
  // ══════════════════════════════════════════════════════════════════
  // ★ 分批第 21 批：**平台换方向了**，老工作区要跟上来
  // ══════════════════════════════════════════════════════════════════
  //
  // 判据是"存着的指令**逐字等于某个历史默认**"，不是"与当前默认不同"：
  // 后者会把**使用者自己写的指令**当成待升级的老版本覆盖掉（第 ⑥ 条明令不许）。
  // ⚠️ 不做这一支的后果很具体：判据改了、平台上了新版本，而使用者那台机器上跑的还是
  //    老的一套（它对老文本一字未改，看起来"没坏"，所以连自愈都不会触发）——
  //    他重启、重试、再折腾一轮，审出来还是老样子，日志里一个字都不会提。
  if (REVIEWER_INSTRUCTIONS_HISTORY.includes(found.instructions)) {
    await store.insertAgent({
      ...found,
      instructions: SKILL_REVIEWER_INSTRUCTIONS,
      updatedAt: Date.now(),
    })
    return {
      action: 'healed',
      agentId: found.id as string,
      why: '内置指令还是旧版（审核方向已收窄成可执行性）',
    }
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
