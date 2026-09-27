import { writable, derived, get } from 'svelte/store'
import {
  api,
  type AgentRole,
  type AgentsPayload,
  type Agent,
  type BlockTemplates,
  type ChatTurnView,
  type Conversation,
  type FirstSentenceKind,
  type Identity,
  type InboxItem,
  type Issue,
  type LocalSkillDirsState,
  type ReconcileReport,
  type RunSummary,
  type ReviewStandard,
  type Skill,
  type TemplateBlock,
  type TemplateKit,
  type Tool,
} from './api.ts'
import type { SyncStatus } from './sync.ts'
import { setLocaleFromIdentity } from './i18n.ts'
import { deleteTool } from './tool-install.ts'

/**
 * 全局状态。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么用 store 而不是"一个全局对象 + 手动重渲染"
 * ══════════════════════════════════════════════════════════════════
 *
 * 旧的零构建版本是 `const state = {...}` + 在每个写点手工调用 `renderXxx()`。
 * 那种写法有个固定的失败模式：**忘了调用重渲染**——界面显示的是旧数据，
 * 而没有任何东西会报错。加了视图、加了抽屉之后，这种"漏调"只会更多。
 *
 * store 让"数据变了"与"界面跟着变"变成同一件事，不需要谁记得去调。
 */

export const identity = writable<Identity | null>(null)
export const issues = writable<Issue[]>([])
export const agents = writable<Agent[]>([])

/**
 * 「新建任务的默认智能体」（D36）。
 *
 * 它是**全局单值**，跟着 agent 列表一起从接口回来（`GET /api/agents`）——
 * 智能体页要用它标「默认」，新建任务页要用它当预选项，两处拿的是同一份。
 */
export const defaultAgentId = writable<string | null>(null)
export const skills = writable<Skill[]>([])

/**
 * 已安装的工具包（D40）——**一个包 = 一个组**。
 *
 * ⚠️ 每行原来还带一个 `mountedBy`（接口算好的"挂给了哪些 agent"）。挂载能力撤掉
 *   之后接口不再算它，那个类型也删了。
 */
export const tools = writable<Tool[]>([])
export const runs = writable<RunSummary[]>([])

// ══════════════════════════════════════════════════════════════════
// 聊天（闭环的旁路）
// ══════════════════════════════════════════════════════════════════

/**
 * 一个对话的回看数据（`GET /api/conversations/:id` 的原样形状）。
 *
 * `workDir` 是**实际**在跑的目录：`conversation.workDir` 为 null 时它是服务端
 * 从最近那一轮 run 里读出来的真值——界面**不去猜**（猜的话显示出来的目录
 * 和它真正在动的目录可能不是一个）。
 */
export interface ChatDetail {
  conversation: Conversation
  turns: ChatTurnView[]
  workDir: string | null
}

/** 全部对话，最近说过话的在前（顺序由服务端定，界面不重排）。 */
export const conversations = writable<Conversation[]>([])

/** 当前打开的对话 id。 */
export const activeConversationId = writable<string | null>(null)

/**
 * 当前对话的回看数据：对话本体 + 每一轮（含那一轮 run 的结果）+ 实际工作目录。
 *
 * 每轮在界面上要显示的东西（用户那句话、智能体的回复、用了几个工具）**一次
 * 请求全拿到**。一轮一个请求的做法不只是慢：并发回来的顺序不定，而聊天是
 * "顺序就是内容"的界面——拼错了看不出来，只觉得它答非所问。
 */
export const chatDetail = writable<ChatDetail | null>(null)

/**
 * 正在被围观的那条 run（只有它走 SSE 流式）。
 *
 * 界面上同一时刻只可能有一轮在跑：输入框在跑的时候是禁用的。
 */
export const chatLiveRunId = writable<string | null>(null)

export const inbox = writable<InboxItem[]>([])

/** 数据加载状态：用来区分"还没有数据"与"还在加载"——两者都显示空白是错的。 */
export const loading = writable<Record<string, boolean>>({})
export const loadError = writable<Record<string, string>>({})

export const syncStatus = writable<SyncStatus | null>(null)

/**
 * 第一句话模版的变量表与默认模版（D32）。
 *
 * 它**不是**使用者的数据，而是一份"服务端怎么渲染"的说明书，所以：
 *   - 只读，不参与同步循环；
 *   - 界面上照着它显示变量名与必需与否——**不在前端抄一份**。
 *     抄一份的后果是"照界面写的却被服务端拒"，而两处的规则迟早会分叉。
 */
export const templateKit = writable<TemplateKit | null>(null)

/** 未读通知数——顶栏徽标用它。 */
export const unreadCount = derived(inbox, ($inbox) => $inbox.length)

async function load<T>(
  key: string,
  fetcher: () => Promise<T>,
  target: { set: (v: T) => void },
): Promise<void> {
  loading.update((l) => ({ ...l, [key]: true }))
  loadError.update((e) => ({ ...e, [key]: '' }))
  try {
    target.set(await fetcher())
  } catch (err) {
    // 错误要**留下来给人看**，而不是只写 console——控制台没人看
    loadError.update((e) => ({ ...e, [key]: err instanceof Error ? err.message : String(err) }))
  } finally {
    loading.update((l) => ({ ...l, [key]: false }))
  }
}

export const loadIdentity = (): Promise<void> =>
  load(
    'identity',
    async () => {
      const payload = await api<Identity>('/api/identity')
      // ★ 语言跟着身份一起到（D39）：页面启动就该是对的语言
      setLocaleFromIdentity(payload.locale)
      return payload
    },
    identity,
  )

export const loadIssues = (): Promise<void> =>
  load('issues', async () => (await api<{ items: Issue[] }>('/api/issues?limit=200')).items ?? [], issues)

export const loadAgents = (): Promise<void> =>
  load(
    'agents',
    async () => {
      const payload = await api<AgentsPayload>('/api/agents')
      // ★ 悬空值（默认那个 agent 被删了）在这里落回 null：界面上"等于没设"，
      //   而不是让新建任务页去猜。
      const ids = new Set((payload.agents ?? []).map((a) => a.id))
      defaultAgentId.set(payload.defaultAgentId && ids.has(payload.defaultAgentId) ? payload.defaultAgentId : null)
      return payload.agents ?? []
    },
    agents,
  )

/**
 * **生效中的**默认智能体（D36）。
 *
 * ⚠️ 与 `defaultAgentId`（存下来的那个值）刻意分开：
 *
 *   - 没设过、或者设的那个 agent 已经被删掉 ⇒ 退回**第一个执行者**。
 *     这样"必须有一个默认"在界面上始终成立——列表上永远有且只有一条标着
 *     「默认」，新建任务页永远有确定的预选项，而不是空着让人每次现想；
 *   - 读的时候**不写库**（"读"这条路上不该有副作用），悬空值就那么留着，
 *     等下一次有人设默认时自然被覆盖。
 */
export const effectiveDefaultAgentId = derived([agents, defaultAgentId], ([$agents, $id]) => {
  const executors = $agents.filter((a) => a.role === 'executor')
  if ($id && executors.some((a) => a.id === $id)) return $id
  return executors[0]?.id ?? null
})

/**
 * 指定「新建任务的默认智能体」（D36）。
 *
 * **没有"取消"**：默认必须有一个（设成另一个，原来那个自动让位）。
 * 校验在服务端（角色、存在性），这里只把它的原文带回去——与其它写入口一致。
 */
export async function setDefaultAgent(agentId: string): Promise<void> {
  await api('/api/agents/default', {
    method: 'PUT',
    body: JSON.stringify({ agentId }),
  })
  await loadAgents()
}

/**
 * 把"来自挂载 skill 的标准"固化到这个审核者身上，并摘掉那些挂载（D38）。
 *
 * 过渡期的迁移入口：老数据里审核者的标准是从挂载的 skill 推出来的，而"卸载那条
 * skill"必须先有这一步——否则审核者会失去依据（平台于是不会再把产出交给它审）。
 */
export async function adoptReviewStandard(agentId: string): Promise<void> {
  await api(`/api/agents/${encodeURIComponent(agentId)}/review-standard/adopt-from-skills`, {
    method: 'POST',
  })
  await Promise.all([loadAgents(), loadSkills()])
}

/**
 * 卸载一条 skill（D38）。
 *
 * 服务端会拒掉"还有 agent 挂着它"的情况（并把它们列出来）——这里只把它的原文
 * 带回去，与其它写入口一致。
 */
export async function uninstallSkill(id: string): Promise<void> {
  await api(`/api/skills/${encodeURIComponent(id)}`, { method: 'DELETE' })
  await Promise.all([loadSkills(), loadAgents()])
}

/**
 * 读技能列表。
 *
 * ★ 服务端**在这一次读里就对账**（磁盘为准）：勾过的本地目录里改了什么、加了
 *   什么、删了什么，这一趟都跟着变。所以「刷新」这个按钮同时也是"重新扫一遍本地
 *   目录"——不需要第二个按钮。
 */
export const loadSkills = (): Promise<void> =>
  load('skills', async () => (await api<{ skills: Skill[] }>('/api/skills')).skills ?? [], skills)

/**
 * 本地技能目录（Skills 页 →「设置」）。
 *
 * ★ 它跟技能列表是**两件事**：列表是"库里有什么"，这里是"要读哪些目录"。
 *   所以是两个 store、两个加载点——混成一个，"设置里勾了什么"就会跟着列表的
 *   刷新节奏变，而那是两个不同的时机。
 */
const EMPTY_REPORT: ReconcileReport = {
  added: [],
  updated: [],
  removed: [],
  keptBecauseUsed: [],
  failed: [],
  skipped: [],
  dirErrors: [],
  onDisk: [],
}

export const localSkillDirs = writable<LocalSkillDirsState>({
  candidates: [],
  enabled: [],
  custom: [],
  report: EMPTY_REPORT,
})

export const loadLocalSkillDirs = (): Promise<void> =>
  load(
    'localSkillDirs',
    async () => await api<LocalSkillDirsState>('/api/skills/local-dirs'),
    localSkillDirs,
  )

/**
 * 改「勾了哪些本地技能目录」。
 *
 * ★ 返回这次对账的报告（而不是 `void`）：使用者勾上一个目录之后，马上要知道的
 *   就是"读进来了什么、跳过了什么"。让界面再发一次列表请求才能知道结果，等于
 *   把一次往返塞给他，而中间那段空白正是"我勾了到底有没有用"的焦虑来源。
 */
export async function saveLocalSkillDirs(dirs: string[]): Promise<ReconcileReport> {
  const body = await api<{ enabled: string[]; report: ReconcileReport }>('/api/skills/local-dirs', {
    method: 'PUT',
    body: JSON.stringify({ dirs }),
  })
  // 列表与设置一起刷新：勾选状态变了，两边都会变
  await Promise.all([loadSkills(), loadLocalSkillDirs()])
  return body.report
}

export const loadTools = (): Promise<void> =>
  load(
    'tools',
    async () => {
      const body = await api<{ tools: Tool[] }>('/api/tools')
      return body.tools ?? []
    },
    tools,
  )

/**
 * 卸载一个工具包（D40）。
 *
 * ⚠️ 服务端原来会拒掉"还有 agent 挂着它"的情况（`ToolInUseError`），界面据此
 *    指名道姓地列出来。那条拒绝已经删掉（理由见 `server.ts` 里 DELETE 那段：
 *    "摘掉"这个动作不存在了，拒绝就是一把没有钥匙的锁），所以这里不再有那条
 *    分支。agent 列表仍然重取——智能体的动作权限可能与工具包有关。
 */
export async function uninstallTool(id: string): Promise<void> {
  await deleteTool(id)
  await Promise.all([loadTools(), loadAgents()])
}

// ⚠️ 这里原来还有一个 `setAgentTools()`（挂载/摘挂一个 agent 的工具组，
//    `PUT /api/agents/:id/tools`）。它的调用方（智能体详情里那个"可挂载的工具组"
//    勾选栏）先被撤掉，接口随后也删了，所以这个函数**上一轮就已经删掉**，
//    这段注释是这次清尾时补上的：不留一个"看起来还能挂"的写入口。



// ══════════════════════════════════════════════════════════════════
// 聊天的读写
// ══════════════════════════════════════════════════════════════════
//
// 写入口一律"先请求、再重取"（这个仓库没有乐观更新，除了一处：发送那一刻
// 本地先插一条占位，见 `chatPending`）。重取而不是把返回值塞进 store，是因为
// 列表的**顺序与计数**由服务端算（最近说话的在最前、turnCount 记了几轮），
// 本地拼一份迟早与服务端不一致，而不一致的表现是"列表顺序偶尔不对"。

export const loadConversations = (): Promise<void> =>
  load('conversations', async () => (await api<{ items: Conversation[] }>('/api/conversations')).items ?? [], conversations)

/** 打开一个对话：拉回看数据。返回拉到的那份，方便调用方直接判断。 */
export async function openConversation(id: string): Promise<ChatDetail | null> {
  loading.update((l) => ({ ...l, chatDetail: true }))
  loadError.update((e) => ({ ...e, chatDetail: '' }))
  try {
    const detail = await api<ChatDetail>(`/api/conversations/${id}`)
    chatDetail.set(detail)
    activeConversationId.set(id)
    return detail
  } catch (err) {
    loadError.update((e) => ({
      ...e,
      chatDetail: err instanceof Error ? err.message : String(err),
    }))
    return null
  } finally {
    loading.update((l) => ({ ...l, chatDetail: false }))
  }
}

/**
 * 说第一句话——**对话由第一句话诞生**。
 *
 * 刻意没有"先建一个空对话"这条路：那样标题就没有出处，只能先填一个占位，
 * 等第一句话来了再覆盖它，而"我改了名却被第一次发言覆盖掉"是那种看得见、
 * 说不清的坏结果。
 */
export async function startConversation(input: {
  agentId: string
  text: string
  workDir?: string
  /**
   * 这个对话额外带的 skill。
   *
   * 「新对话」那个下拉里选了**没人挂的** skill 时才有值：有主的 skill 走"选它 =
   * 选那个人"，执行者自己就带着它，不需要在这里再传一遍。省略 = 不带。
   */
  skillIds?: string[]
}): Promise<{ conversation: Conversation; turn: ChatTurnView; runId: string | null }> {
  const out = await api<{ conversation: Conversation; turn: ChatTurnView; runId: string | null }>(
    '/api/conversations',
    {
      method: 'POST',
      body: JSON.stringify({
        agentId: input.agentId,
        text: input.text,
        ...(input.workDir ? { workDir: input.workDir } : {}),
        ...(input.skillIds && input.skillIds.length > 0 ? { skillIds: input.skillIds } : {}),
      }),
    },
  )
  await loadConversations()
  await openConversation(out.conversation.id)
  return out
}

/** 接着说一句。`no_capacity`（429）会被 `BusyError` 抛出来，由界面显示原文。 */
export async function sendChatTurn(
  conversationId: string,
  text: string,
): Promise<{ turn: ChatTurnView; runId: string | null }> {
  const out = await api<{ turn: ChatTurnView; runId: string | null }>(
    `/api/conversations/${conversationId}/turns`,
    { method: 'POST', body: JSON.stringify({ text }) },
  )
  return out
}

export async function renameConversation(id: string, title: string): Promise<void> {
  await api(`/api/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) })
  await loadConversations()
  if (get(activeConversationId) === id) await openConversation(id)
}

/** `null` = 改回"平台分配"（`<workRoot>/chat-<对话 id>`）。 */
export async function setConversationWorkDir(id: string, workDir: string | null): Promise<void> {
  await api(`/api/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ workDir }) })
  if (get(activeConversationId) === id) await openConversation(id)
}

/**
 * 删对话。**run 留着**（审计与成本统计还认得它），所以这里只重取对话列表。
 */
export async function deleteConversation(id: string): Promise<void> {
  await api(`/api/conversations/${id}`, { method: 'DELETE' })
  if (get(activeConversationId) === id) {
    activeConversationId.set(null)
    chatDetail.set(null)
    chatLiveRunId.set(null)
  }
  await loadConversations()
}

export const loadRuns = (): Promise<void> =>
  load('runs', async () => (await api<{ runs: RunSummary[] }>('/api/runs')).runs ?? [], runs)

export const loadInbox = (): Promise<void> =>
  load(
    'inbox',
    async () => (await api<{ items: InboxItem[] }>('/api/inbox')).items ?? [],
    inbox,
  )

export async function markInboxRead(id: string): Promise<void> {
  await api(`/api/inbox/${encodeURIComponent(id)}/read`, { method: 'POST' })
  await loadInbox()
}

export const loadTemplateKit = (): Promise<void> =>
  load('templateKit', () => api<TemplateKit>('/api/first-sentence/templates'), templateKit)

/**
 * 预览一段模版会渲染成什么。
 *
 * ★ 走**服务端**的渲染器：前端自己拼一段"看起来差不多"的文字，迟早与真实
 *   投递的东西走偏——而"预览里好好的"正是这个功能最该防的错觉。
 *   服务端同时会过一遍校验，所以这里抛出的错误与保存时是**同一句**。
 */
/**
 * 预览**某一块**模版会渲染成什么（2026-10 三框改造后按块预览）。
 *
 * ★ 走**服务端**的渲染器：前端自己拼一段"看起来差不多"的文字，迟早与真实
 *   投递的东西走偏——而"预览里好好的"正是这个功能最该防的错觉。
 *   服务端同时会过一遍校验，所以这里抛出的错误与保存时是**同一句**。
 */
export async function previewFirstSentence(
  kind: FirstSentenceKind,
  block: TemplateBlock,
  template: string,
): Promise<string> {
  const { text } = await api<{ text: string }>('/api/first-sentence/preview', {
    method: 'POST',
    body: JSON.stringify({ kind, block, template }),
  })
  return text
}

/**
 * 新建一个 agent。
 *
 * 校验交给**服务端**（它是权威），这里只负责把服务端给的原文带回去——
 * 在客户端重写一遍校验规则，两处迟早不一致，而"客户端放行、服务端拒绝"
 * 的体验最糟：表单里什么错都没显示，提交却失败。
 */
/**
 * 保存**全局**的第一句话模版（D32，2026-10 起三块各一份）。
 *
 * ★ 只改传了的那些键（PATCH 语义）：某一框空串 = 回到平台默认。
 *   校验在服务端（同一个 `validateTemplate`），这里只把它的原文带回去。
 */
export async function saveFirstSentenceTemplates(patch: {
  execute?: Partial<BlockTemplates>
  review?: Partial<BlockTemplates>
  /** 聊天那一份（2026-09 加的第三份模版）。 */
  chat?: Partial<BlockTemplates>
}): Promise<void> {
  await api('/api/first-sentence/templates', {
    method: 'PUT',
    body: JSON.stringify(patch),
  })
  await loadTemplateKit()
}

export async function createAgent(input: {
  name: string
  role: AgentRole
  instructions: string
  skillIds: string[]
  reviewerAgentId: string | null
  runtimeKey: string
  workDir: string
  /** 审核标准（D37）——只对审核者有意义；执行者传 null。 */
  reviewStandard?: ReviewStandard | null
  /**
   * 行动权限（D40 收口）——只对审核者有意义，执行者传空数组。
   *
   * ★ 它是**审核者的能力**（判完之后允许触发哪些动作），与"挂什么工具"
   *   （执行者的能力）是两回事。校验在服务端：第三方动作要对着本工作区**已安装的
   *   工具包**核对，给执行者传非空值会被 400。
   */
  allowedActions?: string[]
  /**
   * 动作的固定参数（D43）——只对审核者有意义，执行者传空对象。
   *
   * 界面上给已授权动作的 open 参数钉的值：执行时由平台注入，模型不许写。
   * 校验在服务端：每个动作必须是已装工具声明的动作、每个参数必须是它的 open
   * 参数且值合规。
   */
  actionParams?: Record<string, Record<string, unknown>>
  /**
   * 调试动作（2026-09）——只对审核者有意义，执行者传空数组。
   *
   * 勾了「调试」的动作：判决引用它时不跑脚本，只记录动作与解析后的参数。
   * 是 `allowedActions` 的**子集**（服务端校验）。
   */
  debugActions?: string[]
}): Promise<Agent> {
  const agent = await api<Agent>('/api/agents', {
    method: 'POST',
    body: JSON.stringify({
      name: input.name,
      role: input.role,
      instructions: input.instructions,
      skillIds: input.skillIds,
      reviewerAgentId: input.reviewerAgentId,
      runtimeKey: input.runtimeKey,
      reviewStandard: input.reviewStandard ?? null,
      allowedActions: input.allowedActions ?? [],
      actionParams: input.actionParams ?? {},
      ...(input.debugActions && input.debugActions.length > 0
        ? { debugActions: input.debugActions }
        : {}),
      // 空字符串会被协议当成"没指定"——D27 下那是**默认路径**，不是错误
      ...(input.workDir.trim() ? { workDir: input.workDir.trim() } : {}),
    }),
  })
  await loadAgents()
  return agent
}

/**
 * 改一个 agent（PATCH 语义：只改传了的字段）。
 *
 * 校验交给服务端（它是权威）；这里只把它的原文带回去，不在客户端重写一遍
 * ——两处规则迟早不一致，而"客户端放行、服务端拒绝"的体验最糟。
 */
export async function updateAgent(
  id: string,
  patch: Record<string, unknown>,
): Promise<Agent> {
  const agent = await api<Agent>(`/api/agents/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
  await loadAgents()
  return agent
}

/** 当前数据快照，供同步循环收集摘要用。 */
export function snapshot(): { issues: Issue[]; runs: RunSummary[] } {
  return { issues: get(issues), runs: get(runs) }
}
