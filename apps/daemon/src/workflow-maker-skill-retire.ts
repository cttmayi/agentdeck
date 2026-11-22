/**
 * **退役「编排生成者」的平台技能**（2026-11，D255）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么撤掉 D143 那份技能
 * ══════════════════════════════════════════════════════════════════
 *
 * D143 的解法是"把 API 细节写进一份独有技能 `orchestration-authoring`"。它解决了
 * "生成者照猜 API"，但留下一个更麻烦的问题：**编排写法会经常变**，而技能是**播种**的
 * （写进工作区之后就留在那儿，使用者可能改过 ⇒ 我们不敢覆盖），于是：
 *
 *   · 改了引擎、忘了升技能 ⇒ 生成者照旧写法写，采纳时才发现不对；
 *   · 想升技能 ⇒ 只能"把旧版逐字列进 HISTORY 再升内置身份版本"（D143 那个补丁），
 *     而技能正文本身没有版本机制。
 *
 * 使用者定了新解法（D255）：**写法以"资料"的形式，每次对话前覆盖写进工作目录**
 * （`material/orchestration/`，唯一手写源在仓库 `docs/material/`）。资料是"每次重铺"的，
 * 所以 API 升级下一轮就生效；那份技能因此**没有存在的必要**——留着就是第二个真相。
 *
 * 这一步只做"把已经播种过的那份删掉"（幂等）：新工作区本来就没有它。
 * ⚠️ 只删**这个名字**的独有技能；使用者自己造的技能一律不动。
 */

import { agentSkillOwner, type Store } from '@agentdeck/domain'
import type { WorkspaceId } from '@agentdeck/protocol'
import { platformMemberOf } from './platform-slots.ts'

/** D143 播种、D255 退役的那个技能名。 */
export const RETIRED_WORKFLOW_MAKER_SKILL = 'orchestration-authoring' as const

/**
 * 删掉编排生成者身上那份退役技能（已经不在就什么都不做）。
 *
 * 返回 `removed: true` = 这次真的删了（旧工作区第一次启动会命中一次）。
 */
export async function retireWorkflowMakerPlatformSkill(
  store: Store,
  workspaceId: WorkspaceId,
): Promise<{ agentId: string | null; removed: boolean }> {
  const maker = await platformMemberOf(store, workspaceId, 'workflow-maker')
  if (maker === null) return { agentId: null, removed: false }
  const owner = agentSkillOwner(maker.id)
  const names = (await store.listExclusiveSkills(owner)).map((s) => s.name)
  if (!names.includes(RETIRED_WORKFLOW_MAKER_SKILL)) {
    return { agentId: maker.id as string, removed: false }
  }
  await store.removeExclusiveSkill(owner, RETIRED_WORKFLOW_MAKER_SKILL)
  return { agentId: maker.id as string, removed: true }
}
