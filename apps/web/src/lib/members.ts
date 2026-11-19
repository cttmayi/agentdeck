import type { Agent } from './api.ts'

/**
 * 平台成员的**接入点**在界面侧的读法（2026-11，D145）。
 *
 * ⚠️ 为什么不在这里再存一份"哪条成员有哪些接入点"的表：那张表在 daemon
 *   （`apps/daemon/src/platform-member.ts` 的 `PLATFORM_MEMBER_ENTRIES`），界面
 *   **直接读服务端算好的 `entries`**（`GET /api/agents` 会带上）。在这里抄一份
 *   = 两处各说一半（这个仓库为这类复制栽过好几次）。
 *
 * 所以这里只做**兜底**（服务端没给 `entries` 时，比如老 daemon、或测试夹具）：
 *   · 不是平台成员 ⇒ 三项全开（用户建的智能体本来就能聊天/派活/被编排引用）；
 *   · 是平台成员但拿不到 entries ⇒ **空**（保守：宁可这一条选不到，也不要把
 *     平台成员误派成业务执行者）。
 */
export function agentEntries(agent: Agent): string[] {
  if (Array.isArray(agent.entries)) return agent.entries
  const isPlatform = agent.owner === 'platform' || agent.builtin === true
  return isPlatform ? [] : ['chat', 'task', 'workflow']
}

export function hasEntry(agent: Agent, entry: 'chat' | 'task' | 'workflow'): boolean {
  return agentEntries(agent).includes(entry)
}

/**
 * 使用者能在新建 / 编辑智能体里勾的那三个入口（2026-11，D146）。
 *
 * ⚠️ 三项**顺序**是服务端规范化的顺序（`parseUserEntries` 也按这个次序落库），
 *   所以勾选结果显示的次序、请求发出去的次序、数据里存的次序是同一个。
 *
 * ⚠️ 平台动作入口（`action:…`）**不在这里**：那是平台自己发起的流程节点，勾上也没有
 *   任何东西会叫它。服务端见到就拒（不是静默忽略）。
 */
export const USER_ENTRY_CHOICES = ['chat', 'task', 'workflow'] as const
export type UserEntry = (typeof USER_ENTRY_CHOICES)[number]

/**
 * 每个入口的**文案键**（字面量写全，`$t()` 的入参是封闭联合类型——拼字符串拼不出来）。
 *
 * 与 `USER_ENTRY_CHOICES` 同序，两处改动要一起改：新增一个入口时，这里少写一行就是
 * 类型错误（不会静默降级成一个空标签）。
 */
export const USER_ENTRY_LABEL_KEYS: Record<
  UserEntry,
  'agents.entryChat' | 'agents.entryTask' | 'agents.entryWorkflow'
> = {
  chat: 'agents.entryChat',
  task: 'agents.entryTask',
  workflow: 'agents.entryWorkflow',
}

/** 一个都没勾 = 哪个入口都叫不动它；界面据此禁掉「创建 / 保存」。 */
export function hasAnyEntry(picked: readonly string[]): boolean {
  return USER_ENTRY_CHOICES.some((e) => picked.includes(e))
}
