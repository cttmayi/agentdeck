import type { Store } from '@agentdeck/domain'
import { hasLegacyAgentFields, stripLegacyAgentFields } from '@agentdeck/protocol'
import type { Agent, WorkspaceId } from '@agentdeck/protocol'

/**
 * 启动时**一次性**把老 agent 记录里撤掉的字段从磁盘上摘掉（2026-10）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它清什么、为什么要清
 * ══════════════════════════════════════════════════════════════════
 *
 * 撤掉的是两样东西（`packages/protocol/src/agent-legacy.ts` 里写着理由）：
 *
 *   · `reviewerAgentId` —— "由谁来审这个执行 agent"（现在只有**智能体组**能回答）；
 *   · `allowedActions` / `debugActions` / `actionParams` —— 审核者的"行动权限"
 *     （现在唯一权威是**组**，动作只属于组）。
 *
 * schema 里的字段删掉之后，老记录里的键**不会自己消失**（agent 整条以 JSON 存），
 * 它们会继续出现在 API 响应与导出里。使用者对这件事的要求是明确的：
 * **"不要遗留旧数据。"**
 *
 * 三层清理的分工（判据只有一份，在 protocol 那个文件里）：
 *
 *   ① 读时兜底 —— 两个 store 的读方法过 `cleanAgent`，**任何时候都不会漏出去**；
 *   ② 启动一次性 —— 本文件，把磁盘上的记录也真的改干净（不是"看不见"而已）；
 *   ③ 保存时进不来 —— 写入口不再认识这几个键（写了就是 400）。
 *
 * 只做 ① 的话，数据里一直留着老键（`GET` 干净、导出/排查仍然会撞见）；只做 ② 的话，
 * 一个还没重启的旧 daemon 仍会写回它们。三层都要有。
 *
 * ══════════════════════════════════════════════════════════════════
 * 三条边界（不然它就成了"平台偷偷改配置"）
 * ══════════════════════════════════════════════════════════════════
 *
 * 1. **只删撤掉的键，一个字都不补**：判据是 `stripLegacyAgentFields`（它只删键）。
 *    不会顺手清别的、也不会给谁补默认值——"清理"最怕顺手做别的事。
 * 2. **不静默**：改了谁、删了哪几个键，逐条写进启动日志。这件事**不进通知中心**：
 *    它是平台自己的字段下线，不是"需要你介入"的事（INV-8），而且它对**所有**
 *    老记录都成立——给每个 agent 落一条通知只是噪音。
 * 3. **不留空壳**：`reviewStandard` 只摘内嵌的 `allowedActions`；正文是在用的字段，
 *    本文件不判断"这份标准空了没"。
 */

export interface LegacyAgentCleanupPlan {
  changed: Array<{
    agentId: string
    agentName: string
    /** 被摘掉的键（含 `reviewStandard.allowedActions` 这种带路径的写法）。 */
    removed: string[]
  }>
  /** 扫过的 agent 数（日志与测试用）。 */
  scanned: number
}

/** 算出"哪些记录需要清"，**不写库**（纯函数，便于测试）。 */
export function planAgentLegacyCleanup(agents: readonly Agent[]): LegacyAgentCleanupPlan {
  const changed: LegacyAgentCleanupPlan['changed'] = []
  for (const agent of agents) {
    const { removed } = stripLegacyAgentFields(agent as unknown as Record<string, unknown>)
    if (removed.length === 0) continue
    changed.push({ agentId: agent.id, agentName: agent.name, removed })
  }
  return { changed, scanned: agents.length }
}

/**
 * 把清理落到磁盘上。
 *
 * ⚠️ 重新读一次记录再摘（而不是用计划里那份快照）：计划可能是在几毫秒前算的，
 *    而这中间 agent 可能被改过（启动时并发很小，但"拿旧快照覆盖新数据"这类事故
 *    的代价太大，不值得省这一次读）。
 *
 * ⚠️⚠️ **必须读"未经清理"的那一份**（`listAgentsRaw`）。读时兜底
 *    （`cleanAgent`）会把要删的那几个键先摘掉，于是 `getAgent` 回来的记录
 *    **看起来本来就是干净的** ⇒ 这里的判据永远是"没有老字段" ⇒ 一个字都不写 ⇒
 *    磁盘上那些键永久留着。这条踩过一次：第一版就是用 `getAgent` 读的，于是
 *    整个启动清理是个空转（`plan` 也是空的，因为它是从清理过的列表算出来的）。
 *    判据仍然只有一份（`stripLegacyAgentFields`），变的是"从哪儿读原始数据"。
 */
export async function applyAgentLegacyCleanup(
  store: Store,
  workspaceId: WorkspaceId,
  plan: LegacyAgentCleanupPlan,
): Promise<void> {
  if (plan.changed.length === 0) return
  // 一次读回整个工作区的原始记录，再按计划逐条处理：计划里的 id 可能已经被删了
  // （启动瞬间的并发很小，但"删了就别写回来"是硬要求——写回去等于复活一条记录）。
  const raw = await store.listAgentsRaw(workspaceId)
  const byId = new Map(raw.map((a) => [a.id as string, a]))
  for (const item of plan.changed) {
    const found = byId.get(item.agentId)
    if (!found) continue
    const record = found as unknown as Record<string, unknown>
    // 再判一次：`plan` 可能是几毫秒前算的，而这中间它可能已经被清理过（或又被改回
    // 老形态）。没有就不写库——不产生无谓的写与 mtime 变化。
    if (!hasLegacyAgentFields(record)) continue
    const { next } = stripLegacyAgentFields(record)
    await store.insertAgent({ ...(next as unknown as Agent), updatedAt: Date.now() })
  }
}

/**
 * 启动时扫一遍所有工作区（每个工作区一条日志）。
 *
 * 返回总共动过多少条记录，供启动日志汇总——**一条都不动也要能看出来**：那说明
 * 这个库本来就是干净的（而不是"清理没跑"）。
 */
export async function runAgentLegacyCleanupOnce(input: {
  store: Store
  info: (message: string) => void
}): Promise<{ scanned: number; changed: number }> {
  const { store, info } = input
  let scanned = 0
  let changed = 0

  for (const workspaceId of await store.listWorkspaceIds()) {
    // ⚠️ 原始记录，不是 `listAgents`（读时兜底会把要删的键先摘掉，判据就永远是空的）
    const agents = await store.listAgentsRaw(workspaceId)
    const plan = planAgentLegacyCleanup(agents)
    scanned += plan.scanned
    if (plan.changed.length === 0) continue
    await applyAgentLegacyCleanup(store, workspaceId, plan)
    changed += plan.changed.length
    for (const item of plan.changed) {
      info(
        `清掉了「${item.agentName}」身上 ${item.removed.length} 个已撤下的字段：` +
          `${item.removed.join('、')}（审核者不再自带行动权限——它在智能体组上；` +
          `执行者也不再自带「由谁审它」——谁审由组决定）`,
      )
    }
  }

  if (changed > 0) {
    info(`老 agent 记录清理完成：${changed} 条记录被摘要（共扫过 ${scanned} 条）`)
  }
  return { scanned, changed }
}