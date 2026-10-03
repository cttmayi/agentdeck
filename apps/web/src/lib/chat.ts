import { renderText, webText, type TextParams, type WebTextId } from '@agentdeck/i18n'
import { currentLocale } from './locale.ts'
import type { Agent, ChatTurnView, Skill } from './api.ts'

/**
 * 聊天页的纯逻辑。
 *
 * ⚠️ 这个仓库的 `apps/web` **没有组件级测试**（Svelte 组件在 node 里渲不出来，
 *    见 `newtask-chain.ts` 顶部那段说明），所以凡是"判断"都抽成纯函数放这里，
 *    由 `node --test` 钉住；`.svelte` 里只留渲染与接线。
 */

function tx(id: WebTextId, params?: TextParams): string {
  return renderText(webText, id, currentLocale(), params)
}

/**
 * 跑完了的状态（与 `packages/domain/src/state/run.ts` 里的终态一致）。
 *
 * ⚠️ 抄一份常量是不理想的，但**不能**引协议包（`api.ts` 顶部写着理由：前端
 *    不 import protocol）。所以这里由一条测试钉住"这一列与协议里的终态逐项相同"
 *    ——抄一份而不钉住，才是真正危险的那种抄。
 */
export const TERMINAL_RUN_STATUSES = ['completed', 'failed', 'cancelled'] as const

export function isTurnTerminal(status: string | null): boolean {
  if (status === null) return false
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status)
}

/**
 * 这一轮现在是不是"正在跑"——决定界面上显示实时日志还是结果气泡。
 *
 * 判据用**状态**而不是"它是不是我记住的那条 run"：刷新页面之后那条 run 还在跑，
 * 而界面手里的"当前 run"已经没了；只看状态，刷新回来的页面照样能正确显示
 * "它还在跑"。
 */
export function isTurnRunning(turn: Pick<ChatTurnView, 'runId' | 'status'>): boolean {
  return turn.runId !== null && !isTurnTerminal(turn.status)
}

/**
 * 「新对话」那个下拉里的一项。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么 skill 是**选项**，而不是第二个选择框
 * ══════════════════════════════════════════════════════════════════
 *
 * 使用者要的是"选 skill 就等于和有这个 skill 的执行者对话"。那就不能把 skill
 * 做成一个独立的能力开关：那样选出来的组合是"执行者 + 额外能力"，人设与 skill
 * 会来自两个地方，谁也不认识谁。
 *
 * 所以这里只有**一种东西**可以选：执行者。skill 那几项只是**另一条找人的路径**
 * ——选了它就等于选了挂着它的那个执行者。
 *
 * ⚠️ 但"所有已安装的 skill 都要能选"（使用者原话），而装着的 skill 未必挂在谁
 *    身上。**没人挂的 skill 没有那个执行者可绑**，于是它走另一条：这次对话自己
 *    带着这条 skill（记在 `Conversation.skillIds` 上），执行者仍是你选的那个人。
 *    两种情况都由 `applyChoice` 决定，界面里不写第二份判断。
 */
export type ExecutorChoice = {
  /** 下拉的 value：`agent:<id>` / `skill:<id>`。 */
  value: string
  kind: 'agent' | 'skill'
  /**
   * 有执行者挂它 ⇒ 那个执行者；**没人挂时是空串**。
   *
   * 空串不是"没有执行者"：它表示"这条 skill 不指向某个特定的人"，选它的时候
   * 由 `applyChoice` 用**你当前那个人**填（见那里的注释）。
   */
  agentId: string
  /** 按 skill 选的时候，被选中的那个 skill（界面用它画选项文字）。 */
  skill: Skill | null
}

/** 新对话那两个决定：绑谁 + 这次额外带哪条 skill。 */
export type DraftPick = {
  agentId: string
  /** 空串 = 不带（选了执行者那一项就是这个状态）。 */
  skillId: string
}

/**
 * 建这个下拉的全部选项：先执行者，再**每一条装着的 skill**。
 *
 * `preferredAgentId` 是平台默认执行者，用来消歧：同一个 skill 被多个执行者挂着
 * 时，优先它，否则取列表里第一个（那条规则在这里，不在界面里）。
 *
 * ⚠️ 只认 `role: 'executor'`——审核者不能被选来聊天（聊天不产出判决，让"按标准
 *    判事"的人来闲聊，会让人以为它说的话有判决的分量）。审核者身上挂的 skill
 *    因此也不算"有主"。
 *
 * ⚠️ 一个执行者都没有时**不给 skill 选项**：那些选项最后都要落到某个人身上，
 *    而没有人的时候选了就是个空头承诺（界面这时候该说的是"先去建一个执行者"）。
 */
export function executorChoices(
  agents: readonly Agent[],
  skills: readonly Skill[],
  preferredAgentId: string | null,
  /**
   * 这个 daemon 认不认 `Conversation.skillIds`（`Capability.ConversationSkills`）。
   *
   * ⚠️ 传 `false` 时**没人挂的 skill 不给选项**：那种 skill 只能由对话自己带着，
   *    而旧 daemon 会**静默忽略**那个字段（请求体那层没有 zod 校验）——界面却
   *    照着"将使用它 + 这条 skill"写了出来。那时宁可少给一个选项，也不能给一个
   *    兑现不了的承诺。**有主的 skill 不受影响**：它们走"选它 = 选那个执行者"，
   *    那个字段根本用不到。
   */
  canCarrySkills: boolean,
): ExecutorChoice[] {
  const executors = agents.filter((agent) => agent.role === 'executor')
  const choices: ExecutorChoice[] = executors.map((agent) => ({
    value: `agent:${agent.id}`,
    kind: 'agent' as const,
    agentId: agent.id,
    skill: null,
  }))
  if (executors.length === 0) return choices

  for (const skill of skills) {
    const owners = executors.filter((agent) => (agent.skillIds ?? []).includes(skill.id))
    const owner = owners.find((agent) => agent.id === preferredAgentId) ?? owners[0] ?? null
    if (owner === null && !canCarrySkills) continue
    choices.push({
      value: `skill:${skill.id}`,
      kind: 'skill',
      agentId: owner?.id ?? '',
      skill,
    })
  }
  return choices
}

/**
 * 装着的、但**这个 daemon 兑现不了**的那些 skill（只有旧 daemon 会出现）。
 *
 * 界面要把它们点名说出来：少了一个选项而页面上没有任何解释，使用者只会以为
 * 列表坏了——那正是这一整块规则（"没人挂的也要能选"）当初要解决的问题。
 */
export function skillsHeldBackByDaemon(
  agents: readonly Agent[],
  skills: readonly Skill[],
  canCarrySkills: boolean,
): Skill[] {
  if (canCarrySkills) return []
  const executors = agents.filter((agent) => agent.role === 'executor')
  if (executors.length === 0) return []
  return skills.filter(
    (skill) => !executors.some((agent) => (agent.skillIds ?? []).includes(skill.id)),
  )
}

/**
 * 选了一项之后，这次对话到底绑谁、带哪条 skill——**提交时唯一的取值口**。
 *
 * 三条规则：
 *
 * 1. 选执行者 ⇒ 就是他，并且**把 skill 清掉**（人已经是那一次选择了，再挂着
 *    上一条 skill 会让"我以为我在跟 A 说话，其实还带着 B 的 skill"）。
 * 2. 选一条**有主**的 skill ⇒ 绑它的主人（"就等于和有这个 skill 的 agent"）。
 * 3. 选一条**没人挂**的 skill ⇒ 绑**你当前那个人**（没选过就是平台默认），
 *    这条 skill 由这个对话自己带着。⚠️ 不能"顺手换成默认执行者"：你已经选了
 *    文章写作，再挑一条没主的 skill，结果被换成助手——那是没告诉你的替换。
 *
 * 认不出来的值（空、旧值、别人塞进来的字符串）⇒ **原样不动**，不改选中状态：
 * 提交那一步另有兜底（拿不到执行者就报"还没有执行者"），不在这里瞎猜。
 */
export function applyChoice(
  value: string,
  choices: readonly ExecutorChoice[],
  previous: DraftPick,
  fallbackAgentId: string | null,
): DraftPick {
  const choice = choices.find((c) => c.value === value)
  if (!choice) return previous
  if (choice.kind === 'agent') return { agentId: choice.agentId, skillId: '' }
  const agentId =
    choice.agentId !== '' ? choice.agentId : (previous.agentId || fallbackAgentId || '')
  return { agentId, skillId: choice.skill?.id ?? '' }
}


/**
 * 聊天右栏底部那一栏「工作目录的文件」该不该画、画成哪一种。
 *
 * ══════════════════════════════════════════════════════════════════
 * 三种情况长得像，处理却不一样
 * ══════════════════════════════════════════════════════════════════
 *
 *   · **草稿态**（`hidden`）：对话还没建起来，也就还没有目录。画一个空壳子等于
 *     让人以为"这里本来该有东西"。页面上另外写了一句"第一句话之后才有目录"。
 *   · **旧 daemon**（`unsupported`）：`/api/conversations/:id/files` 不存在。
 *     这时**不能让它自己去撞 404**——任务页那次实测就是这么撞的，而那一栏把
 *     失败渲染成了骨架屏，于是"取不到"和"还在加载"长得一模一样。所以按能力
 *     标志判断，并把原因写出来（重启 daemon 之后就有）。
 *   · **正常**（`ready`）：交给 `WorkDirTree` 去取。
 *
 * ⚠️ 判据放在这里而不是模板里：`apps/web` 没有组件级测试，写在模板里的分支只能
 *    靠手点界面验证（这个仓库在这一栏上因此出过两次"看起来像没数据"）。
 */
export type ChatFilesState = 'hidden' | 'unsupported' | 'ready'

export function chatFilesState(input: {
  /** 正在草拟一个新对话（还没有 conversation.id）。 */
  drafting: boolean
  conversationId: string | null
  /** 这个 daemon 认不认 `Capability.ConversationFiles`。 */
  capability: boolean
}): ChatFilesState {
  // 草稿态优先：那时连目录都还没有，谈不上"这个 daemon 支不支持"
  if (input.drafting || input.conversationId === null || input.conversationId === '') {
    return 'hidden'
  }
  return input.capability ? 'ready' : 'unsupported'
}
