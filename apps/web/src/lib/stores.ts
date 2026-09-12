import { writable, derived, get } from 'svelte/store'
import {
  api,
  type AgentRole,
  type Agent,
  type Identity,
  type InboxItem,
  type Issue,
  type RunSummary,
  type Skill,
} from './api.ts'
import type { SyncStatus } from './sync.ts'

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
export const skills = writable<Skill[]>([])
export const runs = writable<RunSummary[]>([])
export const inbox = writable<InboxItem[]>([])

/** 数据加载状态：用来区分"还没有数据"与"还在加载"——两者都显示空白是错的。 */
export const loading = writable<Record<string, boolean>>({})
export const loadError = writable<Record<string, string>>({})

export const syncStatus = writable<SyncStatus | null>(null)

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
  load('identity', () => api<Identity>('/api/identity'), identity)

export const loadIssues = (): Promise<void> =>
  load('issues', async () => (await api<{ items: Issue[] }>('/api/issues?limit=200')).items ?? [], issues)

export const loadAgents = (): Promise<void> =>
  load('agents', async () => (await api<{ agents: Agent[] }>('/api/agents')).agents ?? [], agents)

export const loadSkills = (): Promise<void> =>
  load('skills', async () => (await api<{ skills: Skill[] }>('/api/skills')).skills ?? [], skills)

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

/**
 * 新建一个 agent。
 *
 * 校验交给**服务端**（它是权威），这里只负责把服务端给的原文带回去——
 * 在客户端重写一遍校验规则，两处迟早不一致，而"客户端放行、服务端拒绝"
 * 的体验最糟：表单里什么错都没显示，提交却失败。
 */
export async function createAgent(input: {
  name: string
  role: AgentRole
  instructions: string
  skillIds: string[]
  reviewerAgentId: string | null
  runtimeKey: string
  workDir: string
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
