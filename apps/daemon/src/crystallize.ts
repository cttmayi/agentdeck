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
import { formatRunMessages, lastTextOf } from './run-text.ts'
import { collectMaterial, isMaterialEmpty } from './crystallize-material.ts'

/** 与 `server.ts` 的 `TERMINAL_RUN_STATUSES` 同一份清单（crystallize 不 import server）。 */
const TERMINAL_EXEC_STATUSES = ['completed', 'failed', 'cancelled']
import type {
  Agent,
  Conversation,
  CrystallizeTargetRef,
  Issue,
  Run,
  RunId,
  Skill,
} from '@agentdeck/protocol'

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
  /**
   * 素材统计（界面改版 §4.1.1：起草前就显示"N 轮 / M 次工具调用"）。
   * `null` = 素材为空（没有可沉淀的内容）——前端在目标态就禁用 [开始起草]，
   * **早失败**而不是起草完才发现 400 empty_material。
   */
  materialStats: { turns: number; toolCalls: number } | null
  /**
   * 该来源**最近一条未入库**的 skill-draft 起草 run（恢复进行中的起草）。
   * 起草中（非终态）与已完成待审阅都算；`crystallized: true`（已入库）的跳过。
   * `null` = 没有进行中的起草。
   */
  activeDraft: { runId: string; status: Run['status']; target: CrystallizeTargetRef } | null
}

/**
 * ★ 三轮：入参可能是**起草 run 自己**（沉淀页左栏列的是草稿，点一条进来的
 * 地址就是 `#/crystallize/<draftRunId>`）。起草 run 不是素材来源——它自己的
 * 事件是产出的 SKILL.md，拿它当素材会"用草稿沉淀草稿"。所以认出 skill-draft
 * 就顺着 `subject.sourceRunId` 换回源 run，之后一切照旧（activeDraft 里
 * 正好能找回这条草稿 → 流程页直接进「继续」恢复）。
 *
 * 这一处收口让**所有入口**都成立：左栏点草稿、旧书签里存的是草稿 runId、
 * 以后别的地方再冒出草稿 id，都不用各自记得先解析一次。
 * 源 run 已被清理时原样返回（调用方自己会走到"素材为空/找不到"的正常分支）。
 */
export async function resolveSourceRun(store: Store, run: Run): Promise<Run> {
  if (run.subject.type !== 'skill-draft') return run
  const sourceId = run.subject.sourceRunId
  if (sourceId === undefined) return run
  return (await store.getRun(sourceId as RunId)) ?? run
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
  run = await resolveSourceRun(store, run)

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

  // ── 素材统计（起草前可见，§4.1.1）──
  // 与 /draft 调用**同一个** `collectMaterial`（四轮起素材落盘，包里已经没有
  // "一整块文本"了）：空素材 = null（前端据此早失败，不必跑完才发现）。
  const collected = await collectMaterial(store, run)
  const materialStats = isMaterialEmpty(collected) ? null : collected.stats

  // ── 恢复进行中的起草（§4.1.1）──
  // 找该来源最近一条**未入库**（crystallized 不是 true）的 skill-draft run。
  // 口径：任务 = 源 run id 精确匹配；对话 = 会话所有轮次的 runId 都算
  // （一个会话多条 run，流程页从哪一轮进都可能）。
  const activeDraft = await findActiveDraft(store, run)

  return {
    loadedSkills,
    reviewed,
    hasUserFeedback: false,
    scope,
    materialStats,
    activeDraft,
  }
}

/**
 * 找该来源最近一条未入库的 skill-draft run（恢复进行中的起草）。
 *
 * 匹配口径：
 *   · 任务（run.subject.type !== 'conversation'）——`subject.sourceRunId === run.id`；
 *   · 对话——run 是某一轮的 run，会话还有别的轮：先取会话全部轮次的 runId，
 *     再匹配 `sourceRunId ∈ 那些 runId`。
 * 排序取 `queuedAt` 最新一条；`crystallized: true`（已入库）的跳过。
 * 带上起草时落库的沉淀目标（`crystallizeTarget`），前端按它还原目标。
 */
async function findActiveDraft(
  store: Store,
  run: Run,
): Promise<{ runId: string; status: Run['status']; target: CrystallizeTargetRef } | null> {
  const page = await store.listRuns({ workspaceId: run.workspaceId, limit: 10_000 })
  const drafts = page.items.filter(
    (r) => r.kind === 'execute' && r.subject.type === 'skill-draft',
  )
  if (drafts.length === 0) return null

  // 对话：收集会话所有轮次的 runId（含当前这条）
  let sourceRunIds: string[]
  if (run.subject.type === 'conversation') {
    const turns = await store.listChatTurns(run.subject.id as Conversation['id'])
    const ids = turns.map((t) => (t.runId ? (t.runId as string) : '')).filter((x) => x !== '')
    if (!ids.includes(run.id as string)) ids.push(run.id as string)
    sourceRunIds = ids
  } else {
    sourceRunIds = [run.id as string]
  }

  const matched = drafts
    .filter((r) => {
      if (r.crystallized === true || r.discarded === true) return false
      const src = r.subject.sourceRunId
      return src !== undefined && sourceRunIds.includes(src)
    })
    .sort((a, b) => b.queuedAt - a.queuedAt)
  const latest = matched[0]
  if (!latest || !latest.crystallizeTarget) return null
  return { runId: latest.id as string, status: latest.status, target: latest.crystallizeTarget }
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
 * 起草 run 的指令（进第一句话的「任务」块）。
 *
 * 2026-10-19 四轮重写：这里**只留"这一轮要做什么"**，不再教"怎么写 skill"——
 * 那套知识搬进了内置技能 `writing-skills`（随 run 注入，agent 按需加载正文与参考）。
 * 素材也不再内联：落盘成 `material/` 目录，这里只给指针与契约。
 *
 * 为什么第一句话要这么短：它整块进 prompt，写多长 agent 都得通读；把"读什么"
 * 变成可选择的动作（progressive disclosure），长对话才不会被一刀截断。
 */
export function buildDraftPrompt(opts: {
  scope: 'conversation' | 'task'
  /** 素材目录（相对工作目录，固定 `material`）。 */
  materialDir: string
  /** 产出目录（相对工作目录，固定 `skill`）。 */
  outputDir: string
  target: 'new' | 'update'
  /** 这一版是"按意见改一版"（素材里有 previous-draft/ 与 feedback.md）。 */
  revised?: boolean
}): string {
  const { scope, materialDir, outputDir, target, revised = false } = opts
  return `你是 skill 起草者。本次素材来自${scope === 'conversation' ? '一次聊天' : '一个任务'}，已经落盘到 \`${materialDir}/\`（就在本工作目录里）；你的产出写到 \`${outputDir}/\`。

【先做这三件事】
1. 读 \`${materialDir}/00-README.md\`——它是索引：来源、规模、本次目标、该读哪些文件、怎么用。
2. 按需读 \`${materialDir}/\` 里真正需要的文件，**不要一次全读**。写 Procedure 之前，
   回查 \`${materialDir}/turns/*.md\`（或 \`task-run.md\`）里的**原始命令与参数**——
   命令必须能直接复制就跑，不许凭印象重写。
3. 你加载了 \`writing-skills\` 技能：先看它的 description 判断要不要读正文；
   写结构、拆支持文件、交付自检都以它为准（\`.claude/skills/writing-skills/\` 下有正文与 references）。

【产出契约】
- \`${outputDir}/SKILL.md\` **必须存在**；支持文件放 \`${outputDir}/references/\`、
  \`${outputDir}/scripts/\`、\`${outputDir}/templates/\`。
- 只写 UTF-8 文本；不写隐藏文件、二进制、\`..\` 或绝对路径。
- \`SKILL.md\` 的 frontmatter 必须有 \`name\`（kebab-case）与 \`description\`（含触发条件）——
  平台从它读名字和描述，**不需要你另外输出**任何材料。
- 支持文件要真的被正文引用；正文里出现的每个路径都必须存在。

【额外交代】
${
  revised
    ? '- 这一版是**在上一版基础上按意见改**：上一版全文在 `material/previous-draft/`，' +
      '使用者的意见在 `material/feedback.md`（优先级最高）。照意见改，意见没提到的地方不要动；' +
      '但仍然要输出**整份**产出，不是补丁。\n'
    : ''
}${
  revised ? '' : ''}${
  target === 'new'
    ? '- 素材索引里写了使用者给的作用描述（如果有）：frontmatter 的 description 以它为基底，可以调措辞，不许改含义。'
    : '- 要更新的技能当前全文在 `material/existing-skill/`：请**修订**它（保留仍然正确的部分），不要从零重写，也不要省略完整产出。'
}
- 如果素材里确实没有可复用做法（全是不结晶清单里的东西），**不要写 SKILL.md**，
  改为写一个 \`${outputDir}/REFUSED.md\`，用两三句话说明为什么不可沉淀。

直接开始：先读索引，再动手写文件。`
}

/**
 * 沉淀任务列表（导航页「沉淀」的左栏，2026-10-19 三轮）。
 *
 * 只列**未入库**的起草 run（`crystallized: true` 的跳过——使用者定稿：
 * "已入库的不显示，列表永远干净"）；倒序（最新在前）。每条带来源标签
 * （对话标题 / 任务标题），供列表行显示与切换。
 *
 * 来源解析：起草 run 的 `subject.sourceRunId` 指向源 run（对话轮次 =
 * subject conversation / 任务执行 run = subject issue），再取其标题。
 * 源 run 已不存在（被清理）时标签为空串——行仍显示，靠 run id 兜底。
 */
export interface CrystallizeDraftRow {
  runId: string
  status: Run['status']
  queuedAt: number
  /** 沉淀目标（新建 / 更新哪条）——列表行可显示"更新 <skill>"。 */
  target: CrystallizeTargetRef | null
  /** 来源：conversation = 对话；issue = 任务。null = 源 run 丢了。 */
  source: { kind: 'conversation' | 'issue'; label: string } | null
}

export async function listCrystallizeDrafts(
  store: Store,
  workspaceId: string,
): Promise<CrystallizeDraftRow[]> {
  const page = await store.listRuns({ workspaceId: workspaceId as never, limit: 10_000 })
  const drafts = page.items.filter(
    (r) =>
      r.kind === 'execute' &&
      r.subject.type === 'skill-draft' &&
      r.crystallized !== true &&
      r.discarded !== true,
  )
  drafts.sort((a, b) => b.queuedAt - a.queuedAt)
  const out: CrystallizeDraftRow[] = []
  for (const d of drafts) {
    let source: CrystallizeDraftRow['source'] = null
    const srcId = d.subject.sourceRunId
    if (srcId !== undefined) {
      const srcRun = await store.getRun(srcId as RunId)
      if (srcRun) {
        if (srcRun.subject.type === 'conversation') {
          const conv = await store.getConversation(srcRun.subject.id as Conversation['id'])
          source = { kind: 'conversation', label: conv?.title ?? '' }
        } else if (srcRun.subject.type === 'issue') {
          const issue = await store.getIssue(srcRun.subject.id as Issue['id'])
          source = { kind: 'issue', label: issue?.title ?? '' }
        }
      }
    }
    out.push({
      runId: d.id as string,
      status: d.status,
      queuedAt: d.queuedAt,
      target: d.crystallizeTarget ?? null,
      source,
    })
  }
  return out
}

/**
 * 新建沉淀的**来源选择器**（导航页「沉淀」的「新建沉淀」，2026-10-19 三轮）。
 *
 * 使用者定稿：本页可新建——选来源对话/任务再进入目标步骤。来源要带**源 run id**
 * （`/targets` 与 `/draft` 都吃 runId），所以这里一次算齐，前端不用 N 次拉取、
 * 也不用依赖 `GET /api/runs`（它 limit 100，多了会漏）。
 *
 * 两个来源的口径：
 *   · **对话**：有轮次带 runId 且最后一轮没报错（与聊天页「沉淀成 skill」的
 *     可用判据一致——素材从已落库的轮次打包）。轮数随行（素材统计预览）。
 *   · **任务**：有**终态**执行 run 且**审核过**（§4.3 门槛：有用户反馈 或 审核过；
 *     `hasUserFeedback` 当前恒 false，所以门槛 = 有 completed 审核 run）。
 *     未达门槛的任务**不列出**——列出来也是一条"点了进不去"的死路。
 */
export interface CrystallizeSource {
  kind: 'conversation' | 'task'
  id: string
  label: string
  /** 源 run（对话 = 最后一轮；任务 = 最近一条终态执行 run）。 */
  runId: string
  /** 对话轮数（素材统计预览）；任务无此概念 = null。 */
  turns: number | null
}

export async function listCrystallizeSources(
  store: Store,
  workspaceId: string,
): Promise<CrystallizeSource[]> {
  const ws = workspaceId as never
  const out: CrystallizeSource[] = []

  // ── 对话 ──
  const conversations = await store.listConversations(workspaceId as Conversation['workspaceId'])
  for (const conv of conversations) {
    const turns = await store.listChatTurns(conv.id)
    // 与聊天页同一判据：最后一轮带 runId 且没报错（报错轮没有可沉淀素材）。
    const runId = [...turns].reverse().find((t) => t.runId && !t.error)?.runId
    if (runId) {
      out.push({ kind: 'conversation', id: conv.id, label: conv.title, runId, turns: turns.length })
    }
  }

  // ── 任务（终态 + 审核过）──
  const issues = await store.listIssues({ workspaceId: workspaceId as never, limit: 10_000 })
  const runs = (await store.listRuns({ workspaceId: ws, limit: 10_000 })).items
  for (const issue of issues.items) {
    const execRuns = runs.filter(
      (r) =>
        r.kind === 'execute' &&
        r.subject.type === 'issue' &&
        r.subject.id === issue.id &&
        TERMINAL_EXEC_STATUSES.includes(r.status),
    )
    if (execRuns.length === 0) continue
    const latest = execRuns.sort((a, b) => b.queuedAt - a.queuedAt)[0]!
    // 门槛：有 completed 审核 run（subject 指向该任务**任何一条**执行 run——
    // 审核挂在哪条执行上都可以，与 crystallizeTargets 同一语义）。
    const reviewed = runs.some(
      (r) =>
        r.kind === 'review' &&
        r.status === 'completed' &&
        r.subject.type === 'run' &&
        execRuns.some((e) => e.id === r.subject.id),
    )
    if (!reviewed) continue
    out.push({ kind: 'task', id: issue.id, label: issue.title, runId: latest.id as string, turns: null })
  }

  return out
}

