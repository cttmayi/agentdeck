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
