import {
  resolveAllowedActionsWithTools,
  type AllowedActionsResolution,
  type Store,
} from '@agentdeck/domain'
import type { Agent, Tool, WorkspaceId } from '@agentdeck/protocol'

/**
 * 清掉老数据里那些**已经不可能被满足**的动作名（D41 收尾）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么需要它：使用者的保存被 400 卡住了
 * ══════════════════════════════════════════════════════════════════
 *
 * D41 把平台的六个内置动作整个删掉之后，老工作区里存着的那些名字
 * （`comment.create` / `issue.add_label` / …）就成了**永远解析不出来**的取值：
 * 它们既不是内置动作（没有内置动作了），也不对应任何已装工具包。
 *
 * 于是使用者打开审核者的「行动权限」→ 改个名字点保存 → 服务端 400：
 *
 *   allowedActions 里有不认识的动作：issue.add_label……
 *
 * 那句话本身是对的，但它把**一个平台自己造成的残留**变成了使用者的待办：
 * 他得先逐个「移除」，才存得下去。而这些取值**在数据上就是死的**——留着它们
 * 不能让任何东西变得可用，删掉也不会让任何东西失去能力（它们从来没有、也
 * 不可能被解析成动作）。
 *
 * 所以启动时做一次**一次性清理**：把两处（`Agent.allowedActions` 与老字段
 * `ReviewStandard.allowedActions`）里解析不出来的名字去掉。
 *
 * ══════════════════════════════════════════════════════════════════
 * 三条边界（不然这就会变成"平台偷偷改配置"）
 * ══════════════════════════════════════════════════════════════════
 *
 * 1. **只删"永远不可能成立"的**：判据用的是运行时**同一个**纯函数
 *    （`resolveAllowedActionsWithTools`）——那个包装没装、包里没声明这个动作
 *    的，一律算死名字。反过来，"现在装着的包的正常动作"一个都不动；
 * 2. **不静默**：改了谁、删了哪几个，逐条写进日志，并给那个 agent 落一条通知
 *    （INV-8：需要人知道的事进通知）。使用者下次打开界面时，行动权限里就是
 *    干净的、**并且他知道为什么变干净了**；
 * 3. **不碰别的字段**：只动这两处动作名单，别的配置一个字不改。
 *
 * ⚠️ 与"保存时不许静默改权限"那条规矩**不冲突**：那条防的是"使用者提交了一份
 *    名单、平台悄悄改了再写库"。这里删的是**平台自己当年写进去、现在已经不可能
 *    成立**的取值——留着它们不是保守，是给使用者留了一个必须手工清理的坑。
 */

export interface DeadActionCleanup {
  /** 动过的 agent 及它们被删掉的动作名（用于日志与通知）。 */
  changed: Array<{
    agentId: string
    agentName: string
    dropped: string[]
    /** 删干净之后还剩下什么。 */
    kept: string[]
  }>
  /** 扫过的 agent 数（测试与日志用）。 */
  scanned: number
}

/**
 * 算出"该清哪些 agent"，**不写库**（纯函数，便于测试与单独验证）。
 *
 * 只处理 `role: 'reviewer'`：执行者本来就不该有动作权限（写入口会拒），
 * 老数据里若真有一份，那也是同样的死名字——一并清掉更干净，所以这里并不按
 * 角色过滤，而是按"这个值能不能被满足"判。**唯一的例外是它压根没有动作名单**。
 */
export function planDeadActionCleanup(
  agents: readonly Agent[],
  tools: readonly Tool[],
): DeadActionCleanup {
  const changed: DeadActionCleanup['changed'] = []
  for (const agent of agents) {
    const own = agent.allowedActions ?? []
    const legacy = agent.reviewStandard?.allowedActions ?? []
    // 两处都空 ⇒ 没有可清的（绝大多数 agent 走这一支）
    if (own.length === 0 && legacy.length === 0) continue

    const ownResolved: AllowedActionsResolution = resolveAllowedActionsWithTools(own, tools)
    const legacyResolved = resolveAllowedActionsWithTools(legacy, tools)
    const dropped = [
      ...ownResolved.unavailable.map((u) => u.type),
      ...legacyResolved.unavailable.map((u) => u.type),
    ]
    if (dropped.length === 0) continue
    changed.push({
      agentId: agent.id,
      agentName: agent.name,
      dropped: [...new Set(dropped)],
      kept: [...ownResolved.allowed],
    })
  }
  return { changed, scanned: agents.length }
}

/** 把清理结果写回去（`planDeadActionCleanup` 的落地部分）。 */
export async function applyDeadActionCleanup(
  store: Store,
  workspaceId: WorkspaceId,
  plan: DeadActionCleanup,
): Promise<void> {
  for (const item of plan.changed) {
    const agent = await store.getAgent(item.agentId as Agent['id'])
    if (!agent) continue
    const tools = await store.listTools(workspaceId)
    const own = resolveAllowedActionsWithTools(agent.allowedActions ?? [], tools).allowed
    // 老字段只留解析得出来的那些；删空时**把这个键去掉**（它本来就是"老数据
    // 只读兼容字段"，留着空数组等于把"这里曾经放过东西"继续挂在数据里）。
    const legacyKept = resolveAllowedActionsWithTools(
      agent.reviewStandard?.allowedActions ?? [],
      tools,
    ).allowed
    const reviewStandard = agent.reviewStandard
      ? {
          // ⚠️ 这里原来还搬一个 `name`。那个字段已经从 `ReviewStandard` 删掉了
          //    （它不承载任何东西，理由见协议里那段注释），所以不再搬运——
          //    顺手把它从老记录里去掉，正是这个函数该做的事。
          body: agent.reviewStandard.body,
          ...(legacyKept.length > 0 ? { allowedActions: [...legacyKept] } : {}),
        }
      : agent.reviewStandard

    await store.insertAgent({
      ...agent,
      allowedActions: [...own],
      reviewStandard,
      updatedAt: Date.now(),
    })
  }
}
