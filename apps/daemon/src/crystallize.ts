/**
 * 聊天/任务沉淀 skill（2026-10，D80）——素材打包与起草 prompt 组装。
 *
 * 两个场景、一套流水线（设计文档 `docs/design/skill-crystallization.md`）：
 *
 *   · **聊天（conversation）**：素材 = 整个会话所有轮次 run 的 events
 *     （消息 + 工具调用 + 输入输出）。
 *   · **任务（task）**：素材 = 任务 run 的 events + 审核判决（有则带）
 *     + 用户反馈（有则带、可补充）。
 *
 * 素材**必须保留工具调用及其结果**——提炼"怎么做"依赖真实的命令/脚本，
 * 只给对话文本会写出幻觉步骤（设计 §4.1 的硬要求）。
 *
 * 本模块只负责"打包成什么文本 + 起草指令长什么样"；起 run、落盘、git 化
 * 由 server.ts 的沉淀路由调用 executor / store / skill-mine 完成。
 */

import type { Store } from '@agentdeck/domain'
import type { Agent, Conversation, Run, RunId, Skill } from '@agentdeck/protocol'

/** 沉淀目标面板需要的信息（§4.1 第 1 步 + §4.3 触发前置）。 */
export interface CrystallizeTargets {
  /** 本次对话/任务**实际加载**的 skill（agent 挂的 ∪ 对话额外带的）。 */
  loadedSkills: Array<{
    id: string
    slug: string
    name: string
    description: string | null
    /** 'mine' = 提炼的（可进化）；'local'/'remote' = 安装的（更新=存为你的版本并遮蔽）。 */
    source: Skill['source']
  }>
  /** 任务被审核过（存在 completed 的 review run）——任务按钮可用性判据之一。 */
  reviewed: boolean
  /**
   * 任务已有用户反馈。当前平台没有独立的 run 反馈机制，恒 false；
   * 面板上提供"补充反馈"输入（填了进素材）。判据保留字段位：
   * 将来有反馈记录机制时从这里接。
   */
  hasUserFeedback: boolean
  /** 素材作用域：conversation = 聊天场景；task = 任务场景（含审核/反馈）。 */
  scope: 'conversation' | 'task'
}

/** 素材打包结果。 */
export interface CrystallizeMaterial {
  text: string
  stats: {
    turns: number
    toolCalls: number
  }
}

/**
 * 目标信息：本次对话/任务加载了哪些 skill、任务有没有审核过。
 *
 * 加载的 skill = **执行者挂的 ∪ 对话额外带的**（与 `chat.ts` 的注入口径一致——
 * 注入的是哪些，能"矫正"的就是哪些）。
 */
export async function crystallizeTargets(
  store: Store,
  run: Run,
): Promise<CrystallizeTargets> {
  let agentId: string = run.agentId as string
  let extraSkillIds: string[] = []
  let scope: 'conversation' | 'task' = 'task'
  let reviewed = false

  if (run.subject.type === 'conversation') {
    scope = 'conversation'
    const conversation = await store.getConversation(run.subject.id as Conversation['id'])
    if (conversation) {
      agentId = conversation.agentId as string
      extraSkillIds = conversation.skillIds.map((id) => id as string)
    }
  } else {
    // 任务场景：找有没有 completed 的审核 run（与 server.ts 判"审核过"同一
    // 条路：`RunQuery` 没有 kind/subject 过滤，所以在这里筛）。
    const page = await store.listRuns({ workspaceId: run.workspaceId, limit: 10_000 })
    reviewed = page.items.some(
      (r) =>
        r.kind === 'review' &&
        r.subject.type === 'run' &&
        r.subject.id === run.id &&
        r.status === 'completed',
    )
  }

  const loadedSkills = await resolveLoadedSkills(store, agentId, extraSkillIds)
  return {
    loadedSkills,
    reviewed,
    hasUserFeedback: false,
    scope,
  }
}

/**
 * 解析"实际加载"的 skill：执行者挂的 ∪ 额外带的（按 id 去重，保留序）。
 */
async function resolveLoadedSkills(
  store: Store,
  agentId: string,
  extraSkillIds: string[],
): Promise<CrystallizeTargets['loadedSkills']> {
  const agent = await store.getAgent(agentId as Agent['id'])
  const all = await store.listSkills(agent?.workspaceId ?? ('' as never))
  const byId = new Map(all.map((s) => [s.id as string, s]))
  const seen = new Set<string>()
  const out: CrystallizeTargets['loadedSkills'] = []
  const wanted = [...(agent?.skillIds.map((id) => id as string) ?? []), ...extraSkillIds]
  for (const id of wanted) {
    if (seen.has(id)) continue
    seen.add(id)
    const skill = byId.get(id)
    if (skill) {
      out.push({
        id: skill.id as string,
        slug: skill.slug,
        name: skill.name,
        description: skill.description,
        source: skill.source,
      })
    }
  }
  return out
}

/**
 * 把一条 run 的消息流格式化成素材文本（消息 + 工具调用 + 输入输出）。
 */
function formatRunMessages(runId: RunId, messages: Array<{ seq: number; type: string; tool: string | null; content: string; input: Record<string, unknown> | null; output: string | null }>): string {
  const lines: string[] = []
  for (const m of messages) {
    switch (m.type) {
      case 'text':
        lines.push(`[消息] ${m.content}`)
        break
      case 'tool_use':
        lines.push(`[工具调用] ${m.tool ?? '(未知)'}`)
        if (m.input && Object.keys(m.input).length > 0) {
          lines.push(`  入参：${JSON.stringify(m.input)}`)
        }
        break
      case 'tool_result':
        lines.push(`[工具结果] ${m.content}`)
        if (m.output && m.output !== m.content) lines.push(`  输出：${m.output}`)
        break
      case 'thinking':
        // 思考过程对"怎么做"有价值，但噪音大——压缩成一行说明存在。
        lines.push(`[思考] ${m.content.slice(0, 200)}${m.content.length > 200 ? '…' : ''}`)
        break
      default:
        // status/error/log：过程信息，保留简短内容（错误可能是重要线索）。
        if (m.type === 'error') lines.push(`[错误] ${m.content}`)
        break
    }
  }
  return lines.join('\n')
}

/** 一条 run 的产出 = **最后一条**非空 text 消息（与任务详情页同一口径）。 */
export function lastTextOf(
  messages: Array<{ type: string; content: string }>,
): string | null {
  let last: string | null = null
  for (const m of messages) {
    if (m.type === 'text' && m.content.trim() !== '') last = m.content
  }
  return last
}

/**
 * 打包沉淀素材。
 *
 * - conversation：整个会话**所有轮次** run 的消息（设计：整体提炼、不选细节）。
 * - task：任务 run 的消息 + 审核判决（有则带）+ 用户反馈（有则带）。
 */
export async function buildMaterial(
  store: Store,
  run: Run,
  userFeedback?: string,
): Promise<CrystallizeMaterial> {
  const parts: string[] = []
  let turns = 0
  let toolCalls = 0

  const countTools = (messages: Array<{ type: string }>): number =>
    messages.filter((m) => m.type === 'tool_use').length

  if (run.subject.type === 'conversation') {
    const conversationId = run.subject.id as Conversation['id']
    const turns_ = await store.listChatTurns(conversationId)
    turns = turns_.length
    for (const turn of turns_) {
      if (!turn.runId) {
        parts.push(`【第 ${turn.seq} 轮（未跑起来）】${turn.userText}`)
        continue
      }
      parts.push(`【第 ${turn.seq} 轮｜使用者说：${turn.userText}】`)
      const messages = await store.listRunMessages(turn.runId)
      toolCalls += countTools(messages)
      const body = formatRunMessages(turn.runId, messages)
      if (body) parts.push(body)
    }
  } else {
    turns = 1
    const messages = await store.listRunMessages(run.id)
    toolCalls += countTools(messages)
    const body = formatRunMessages(run.id, messages)
    if (body) parts.push(body)
    // 审核判决（有则带）：找 completed 的 review run，把它的产出（判决文本）附上。
    // 产出 = 该 review run 的**最后一条 text 消息**（`Run` 上没有 output 字段，
    // 与任务详情页取产出的口径一致——取最后一条 text，不拼接）。
    const page = await store.listRuns({ workspaceId: run.workspaceId, limit: 10_000 })
    const review = page.items
      .filter(
        (r) => r.kind === 'review' && r.subject.type === 'run' && r.subject.id === run.id,
      )
      .sort((a, b) => b.queuedAt - a.queuedAt)[0]
    if (review && review.status === 'completed') {
      const reviewMessages = await store.listRunMessages(review.id)
      const verdictOutput = lastTextOf(reviewMessages)
      if (verdictOutput) {
        parts.push(`【审核判决】\n${verdictOutput}`)
      }
    }
    if (userFeedback && userFeedback.trim() !== '') {
      parts.push(`【使用者的反馈】\n${userFeedback.trim()}`)
    }
  }

  return {
    text: parts.join('\n\n'),
    stats: { turns, toolCalls },
  }
}

/** 起草 run 的指令（进第一句话的「任务」块）。 */
export function buildDraftPrompt(opts: {
  material: string
  /** 新建必填的作用描述（防 agent 总结偏离；description 以它为基底）。 */
  purpose?: string
  /** 更新/基于安装时带上的现有 SKILL.md（进化基线）。 */
  existingSkill?: { name: string; body: string; description: string | null } | null
  /** 现有技能列表（避免重复 + 判断 FOLD_INTO）。 */
  existingSkills: Array<{ slug: string; name: string; description: string | null }>
  scope: 'conversation' | 'task'
}): string {
  const {
    material,
    purpose,
    existingSkill,
    existingSkills,
    scope,
  } = opts

  const purposeBlock =
    purpose && purpose.trim() !== ''
      ? `【使用者的作用描述】\n${purpose.trim()}\n\n这是使用者对这个 skill 的定位。frontmatter 的 description **以它为基底**（可以微调措辞，不许改变含义）。`
      : ''

  const existingBlock =
    existingSkill && existingSkill.body !== ''
      ? `【要更新的现有 skill：${existingSkill.name}】\n下面是它的当前全文。请结合本次素材**修订**它——保留仍然正确的部分，修正与素材冲突的部分，补上素材里暴露出的缺失。\n\n${existingSkill.body}`
      : ''

  const listBlock =
    existingSkills.length > 0
      ? `【现有技能列表】（避免重复造轮子；若素材明显属于某个现有技能，在输出的开头注明"应并入：<slug>"，但不要因此省略完整产出）\n${existingSkills
          .map((s) => `- ${s.slug}（${s.name}）${s.description ? `：${s.description}` : ''}`)
          .join('\n')}`
      : ''

  return `你是 skill 起草者。下面是使用者从${scope === 'conversation' ? '一次聊天' : '一个任务'}中选出的沉淀素材——含消息、工具调用及其结果。提炼"怎么做"依赖真实的命令/脚本，只给对话文本会写出幻觉步骤。

${purposeBlock}
${existingBlock}

【素材】
${material}

【产出要求】产出一份完整的 SKILL.md：
1. frontmatter 必须有 name（kebab-case）与 description。description 是一句话说明"什么时候该用这个 skill"（**必须含触发条件**）——模型靠它决定何时加载正文，这是渐进式披露的第一层。
2. 正文用以下结构：
   ## When to Use   ← 触发条件展开
   ## Procedure     ← 可操作步骤（步骤里引用的命令/脚本要**原样可复制**，不要缩写）
   ## Pitfalls      ← 注意事项与边界（含"别在什么情况下用"）
   ## Verification  ← 怎么验证这步做对了
3. 如果有脚本/模板，作为支持文件附在末尾，格式：
   ===== FILE: scripts/xxx.sh =====
   内容

【不结晶清单】以下内容**不要**写进 skill：
- 环境依赖的失败（缺依赖/网络问题/权限问题——换个环境就消失）
- 对工具的负面评价（"这个工具不好用"不是可复用步骤）
- 瞬时的重试错误（一次性的重试成功不是流程）
- 一次性任务的叙述（"这次做了 X"不是"怎么做 X"）
如果素材里只有上述内容、没有可复用的做法，只输出一行："无可沉淀内容"。

【现有技能列表】
${listBlock || '（无）'}

直接输出 SKILL.md 全文（含 frontmatter）。`
}
