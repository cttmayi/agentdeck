/**
 * 测试里造一个最小工作区（2026-11，D154）。
 *
 * 为什么需要：**槽位表挂在工作区上**（`Workspace.platformSlots`），而"平台那四条记录是
 * 哪四条"不再写在 agent 记录上。于是任何调用 `ensureBuiltinAgents` / `platformMemberOf`
 * 的用例都必须先有一个工作区——否则表无处可存（`saveSlotTable` 会抛，见那里）。
 *
 * ⚠️ 生产环境不需要这个：`startDaemon` 的引导流程保证工作区存在。
 */
import type { Store } from '@agentdeck/domain'
import type { Workspace, WorkspaceId } from '@agentdeck/protocol'

export async function ensureTestWorkspace(
  store: Store,
  workspaceId: WorkspaceId,
  name = '测试工作区',
): Promise<Workspace> {
  const existing = await store.getWorkspace(workspaceId)
  if (existing !== null) return existing
  const now = Date.now()
  // 只填必填项：其余字段在协议里都有默认值，这里不重复一遍（重复的那份会漂）。
  const workspace = {
    id: workspaceId,
    name,
    createdAt: now,
    updatedAt: now,
  } as unknown as Workspace
  await store.insertWorkspace(workspace)
  return workspace
}
