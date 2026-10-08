import type { Agent, AgentGroup } from '@agentdeck/protocol'

/**
 * 智能体组的**形态校验器**（D70 增量添加）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 组的执行语义只有这一处定义
 * ══════════════════════════════════════════════════════════════════
 *
 * 组是个列表（`members: AgentId[]`），而"列表"本身没有语义——语义由这个函数
 * 决定。**当前唯一受支持的形态：恰好 1 个执行者 + 恰好 1 个审核者。** 形态不对
 * 时，建组 / 提交任务都要**明确报错**（列出实际是谁、缺谁），不猜、不静默降级。
 *
 * 这是对"组退化成花名册"那类危险的防线（D28 砍掉 kindPatterns 的教训，
 * 见 `entities.ts` 里 `Agent.role` 那段注释）：组的形状不是由字段拼出来的，
 * 而是由这一处校验器唯一决定。未来多 Agent（多执行者 / 多审核者会签）是
 * **放宽这里的判定 + 加协作规则字段**，`members` 的列表形状不用破坏。
 *
 * 成员的角色从各自的 `Agent.role` 读（不在组上重复存——同一个 agent 的
 * "身份"只有一份）。INV-1（reviewer ≠ executor）在 1+1 形态下**天然成立**：
 * 恰好各一个，不可能相等；这里不需要重复校验。
 */

/** 校验结果。`ok: false` 时 `issues` 是人话（界面原样显示）。 */
export type GroupShapeResult =
  | { ok: true; executor: Agent; reviewer: Agent }
  | { ok: false; issues: string[] }

/**
 * 校验组的形态。
 *
 * @param group  组记录（`members` 是要校验的成员 id 列表）。
 * @param members 按 `group.members` 查出来的 agent（**可能缺**——组里写的 id
 *   在库里找不到，这正是"成员被删了"的情形，要报出来而不是当没看见）。
 */
export function checkGroupShape(group: AgentGroup, members: readonly Agent[]): GroupShapeResult {
  const byId = new Map(members.map((a) => [a.id as string, a]))

  // ── 成员存在性：组里写的每个 id 都要查得到 ──
  const missing = group.members.filter((id) => !byId.has(id as string))
  if (missing.length > 0) {
    return {
      ok: false,
      issues: [
        `组成员不存在（${missing.map(String).join('、')}）。它们可能已经被删掉了，` +
          `请在智能体页重新选择成员。`,
      ],
    }
  }

  const executors = members.filter((a) => a.role === 'executor')
  const reviewers = members.filter((a) => a.role === 'reviewer')

  const issues: string[] = []
  if (executors.length === 0) {
    issues.push(`组里没有执行者：必须恰好一个执行者（role: executor）。当前成员：${members.map((a) => `「${a.name}」(${a.role})`).join('、') || '（无）'}。`)
  } else if (executors.length > 1) {
    issues.push(
      `组里有 ${executors.length} 个执行者，当前只支持恰好 1 个：` +
        executors.map((a) => `「${a.name}」`).join('、') + `。多执行者分工是未来扩展，还没有实现。`,
    )
  }
  if (reviewers.length === 0) {
    issues.push(`组里没有审核者：必须恰好一个审核者（role: reviewer）。`)
  } else if (reviewers.length > 1) {
    issues.push(
      `组里有 ${reviewers.length} 个审核者，当前只支持恰好 1 个：` +
        reviewers.map((a) => `「${a.name}」`).join('、') + `。多审核者会签是未来扩展，还没有实现。`,
    )
  }
  if (issues.length > 0) return { ok: false, issues }

  // 形态保证 1+1，INV-1 天然成立（恰好各一个，不可能相等）
  const executor = executors[0] as Agent
  const reviewer = reviewers[0] as Agent
  return { ok: true, executor, reviewer }
}
