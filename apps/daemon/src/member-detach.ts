/**
 * **把一条平台成员改成普通智能体**（2026-11，D150，设计稿 §7 的 `detach`）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么需要它
 * ══════════════════════════════════════════════════════════════════
 *
 * 平台成员是**只读**的（`owner: 'platform'`），使用者改不了它的名字、指令、CLI。
 * 但"我只想改一下起草者的口吻"是个正常的诉求——没有这条路，唯一的办法是手改数据
 * 或删了重建（两个都会让平台对账在下一次启动时把它建回来）。
 *
 * 所以给一条**正规出口**：把它**变成你自己的智能体**（`owner: 'user'` + 三个接入点
 * 一次写完），平台随即**重新出厂**一条原始的。
 *
 * ══════════════════════════════════════════════════════════════════
 * 四步（顺序是有理由的，不能换）
 * ══════════════════════════════════════════════════════════════════
 *
 *   ① **引用检查**：谁在用它（对话 / 任务 / 默认执行者 / 编排里按名字引用 / 它跑过
 *      的动作 run）。**写库之前**算，因为这一步要给**人**看——"改完之后会发生什么"
 *      必须在点确认之前说清楚，而不是事后发现。
 *   ② **原子改写**：`owner: 'user'` + `entries` = 三项全开 + **摘掉 `builtin` 与
 *      `builtinKind`**，一次写完。⚠️ 最后那半步是关键：平台对账认的是
 *      **`builtin` + `builtinKind` 两个字段**（`findBuiltinAgent`），留着它们，
 *      下一次启动这条记录会被**当成平台成员认领回去**，使用者改过的东西又被锁上
 *      ——detach 白做，而且不会有任何报错。
 *   ③ **对账补位**：平台发现少了一个出厂成员 ⇒ 立刻建回一条（不等下次启动）。
 *   ④ **影响面给人看**：第 ① 步那份清单原样回给界面。
 *
 * ══════════════════════════════════════════════════════════════════
 * 影响面怎么算"会不会坏"
 * ══════════════════════════════════════════════════════════════════
 *
 * 如实说，不吓人也不遮掩：
 *   · **对话**：它的执行者身份**不变**（`entries` 里有 `chat`），对话照常能继续；
 *   · **动作入口**：「开始起草 / 整理记忆 / 确认…」这些**搬到新出厂的那一条**上
 *     （旧的这条不再有 `action:*`），所以平台流程照常，只是"谁在干"变了；
 *   · **编排里按名字引用**：改之前引用了平台成员的编排**会被引擎拒**（D145），
 *     改完之后它有了 `workflow` 接入点 ⇒ 这些引用**开始生效**（这是变好，不是变坏，
 *     但人得知道）；
 *   · **历史 run**：一条都不删（run 上是执行时的快照，与现在的归属无关）。
 */

import type { Agent, WorkspaceId } from '@agentdeck/protocol'
import type { Store } from '@agentdeck/domain'
import { ensureBuiltinAgents } from './builtin-drafter.ts'
import { loadSlotTable, releaseSlot, saveSlotTable } from './platform-slots.ts'
import { USER_ENTRIES, ownerOf } from './platform-member.ts'

/** 第 ① 步的清单：这条成员**现在**被谁用着（给人看，也给判据用）。 */
export type DetachReferences = {
  /** 执行者是它的对话（最多列 10 条，其余只说数量）。 */
  conversations: Array<{ id: string; title: string }>
  conversationCount: number
  /** 指派给它的任务数（平台成员本来派不动，多数是 0；老数据可能有）。 */
  assignedIssues: number
  /** 它现在是不是默认执行者。 */
  isDefault: boolean
  /** 按名字引用它的编排（改完之后这些引用**开始生效**）。 */
  workflowNames: string[]
  /** 它在这些动作跑过多少条 run（历史，一条都不删）。 */
  actionRuns: number
}

/**
 * 算引用（**只读**，一行都不写）。
 *
 * ⚠️ 它必须在写库**之前**被调用：这份清单是"点确认之前要知道的事"。
 */
export async function detachReferences(
  store: Store,
  workspaceId: WorkspaceId,
  agent: Pick<Agent, 'id' | 'name'>,
  workflows: ReadonlyArray<{ name: string; code: string }>,
): Promise<DetachReferences> {
  const id = agent.id as string
  const conversations = (await store.listConversations(workspaceId)).filter(
    // 对话的执行者字段叫 `agentId`（不是 `executorAgentId`——那是旧名）
    (c) => (c.agentId as string) === id,
  )
  const issues = await store.listIssues({ workspaceId, assigneeId: id, limit: 1 })
  const runs = await store.listRuns({ workspaceId, agentId: agent.id, limit: 1 })
  // ⚠️ 设置挂在 Workspace 上（`defaultAgentId`），没有单独的 settings 端口。
  const workspace = await store.getWorkspace(workspaceId)
  const name = agent.name as string
  const workflowNames = workflows
    .filter((w) => w.code.includes(`'${name}'`) || w.code.includes(`"${name}"`))
    .map((w) => w.name)

  return {
    conversations: conversations.slice(0, 10).map((c) => ({
      id: c.id as string,
      title: (c.title as string) ?? '',
    })),
    conversationCount: conversations.length,
    assignedIssues: issues.items.length,
    isDefault: (workspace?.defaultAgentId as string | null | undefined) === id,
    workflowNames,
    actionRuns: runs.items.length,
  }
}

/**
 * 执行 detach：一次写完"变成你的" + 立刻补位出厂成员。
 *
 * 返回第 ① 步的清单（给界面展示）与**新建回来的那条**（如果有）。
 */
export async function detachPlatformMember(deps: {
  store: Store
  workspaceId: WorkspaceId
  agent: Agent
  workflows: ReadonlyArray<{ name: string; code: string }>
}): Promise<{ references: DetachReferences; agent: Agent; recreated: string[] }> {
  const { store, workspaceId, agent, workflows } = deps

  // ① 先算引用（写库之前）
  const references = await detachReferences(store, workspaceId, agent, workflows)

  // ② 原子改写：同一份 `insertAgent` 里把四件事一起写掉，不留半个配置
  const {
    builtin: _builtin,
    builtinKind: _builtinKind,
    ...rest
  } = agent as Agent & { builtin?: boolean; builtinKind?: string }
  const detached: Agent = {
    ...rest,
    owner: 'user',
    entries: [...USER_ENTRIES],
    updatedAt: Date.now(),
  }
  await store.insertAgent(detached)

  /**
   * ③ 对账补位：平台立刻把出厂成员建回来（复用启动对账那一个来源，不另写一套）。
   *
   * ⚠️ 2026-11（D154）：第 ② 步摘掉的不仅是记录上的老字段——**槽位表里那个 id 也得摘**，
   *   否则表还指着这条已经变成"你的"的记录，对账会认为"那条还在"而不补位
   *   （界面上表现为"起草者没了，但平台没建回来"）。
   */
  const table = await loadSlotTable(store, workspaceId)
  releaseSlot(table, agent.id as string)
  await saveSlotTable(store, workspaceId, table)

  const before = new Set((await store.listAgents(workspaceId)).map((a) => a.id as string))
  const ensured = await ensureBuiltinAgents(store, workspaceId, table)
  const after = await store.listAgents(workspaceId)
  const recreated: string[] = []
  for (const row of [ensured.drafter, ensured.memoryTidy, ensured.agentMaker, ensured.workflowMaker]) {
    if (row.action === 'created') {
      const found = after.find((a) => (a.id as string) === row.agentId)
      if (found && !before.has(found.id as string)) recreated.push(found.name as string)
    }
  }

  return { references, agent: detached, recreated }
}

/** 只有平台成员能 detach（判据与只读闸同一句：`ownerOf`）。 */
export function canDetach(agent: Pick<Agent, 'owner' | 'builtin' | 'builtinKind'>): boolean {
  return ownerOf(agent) === 'platform'
}
