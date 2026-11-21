/**
 * **一次执行注入时带的技能**（D111，设计定稿 `docs/design/agent-directory.md` §5）。
 *
 * 两类技能、同一条投递通道（`executor.submit({ skills })` → 受管运行时目录 +
 * 第一句话的 skillsBrief）：
 *
 *   ① **共享技能**（技能库）——`skillIds` 引用，mine 遮蔽安装（D80）；
 *   ② **独有技能**（`<来源目录>/skills/<slug>/SKILL.md` 文件资产）——不在库里，
 *      是"这个来源"自己的；同 slug 时**独有优先**（它的就是它的，遮蔽库里那份）。
 *
 * 聊天与任务/返工都走这里——不要在别处再拼一遍（两处各拼一遍迟早分叉，
 * 而"共享的没带、独有的带了"这种差别没人会当成 bug 去查）。
 *
 * ★★ 2026-11（D228）：入参从"一个 `Agent`"改成 **`SkillSources`（来源三元组）**。
 *
 *   改之前这里读 `agent.skillIds` / `agent.workspaceId` / `agent.id`——最后那项把
 *   "独有技能放在哪"硬绑在"智能体在库里有一条记录"上。于是**编排内建智能体**
 *   （只属于一条编排、不在库里）没法带独有技能，而它恰恰最需要。
 *
 *   现在：调用方说清"三样东西从哪来"——工作区、库技能 id 清单、**独有技能的来源**。
 *   `exclusive` 是端口里的 `ExclusiveSkillOwner`（`{kind:'agent'}` 或
 *   `{kind:'workflow-agent'}`），**目录名不出现在这一层**：路径归存储实现。
 */

import { extractSkillMeta } from '@agentdeck/agent-core'
import { agentSkillOwner, type ExclusiveSkillOwner, type Store } from '@agentdeck/domain'
import type { Agent, Skill, SkillPayload } from '@agentdeck/protocol'

function libraryToPayload(s: Skill): SkillPayload {
  return {
    ref: { id: s.id, slug: s.slug, source: s.source },
    slug: s.slug,
    name: s.name,
    body: s.body,
    ...(s.description ? { description: s.description } : {}),
    files: s.files ?? {},
  }
}

function exclusiveToPayload(slug: string, body: string): SkillPayload {
  const meta = extractSkillMeta(body)
  return {
    // ★ 独有技能**没有库 id**（D111）：ref 只留 slug + 来源 `agent`。
    ref: { id: null, slug, source: 'agent' },
    slug,
    name: meta.name ?? slug,
    body,
    ...(meta.description ? { description: meta.description } : {}),
    files: {},
  }
}

/**
 * 一次执行要注入的**技能来源**（D228）。
 *
 * 三样东西，来源都可以不同：
 *   · `workspaceId` —— 技能库按工作区分；
 *   · `libraryIds` —— 引用库里的哪几份（账号智能体是 `agent.skillIds`；
 *     聊天那条路还要并上 `Conversation.skillIds`）；
 *   · `exclusive` —— 独有技能文件资产归谁（`{kind:'agent'|'workflow-agent'}`）。
 */
export interface SkillSources {
  workspaceId: Agent['workspaceId']
  libraryIds: readonly string[]
  exclusive: ExclusiveSkillOwner
}

/** 账号智能体那一种来源的便捷构造（绝大多数调用点是它）。 */
export function skillSourcesOfAgent(
  agent: Pick<Agent, 'id' | 'workspaceId' | 'skillIds'>,
  extraLibraryIds: readonly string[] = [],
): SkillSources {
  return {
    workspaceId: agent.workspaceId,
    libraryIds: [...agent.skillIds.map((id) => id as string), ...extraLibraryIds],
    exclusive: agentSkillOwner(agent.id),
  }
}

/**
 * 一次执行的全部注入技能（共享 ∪ 独有）。
 *
 * ⚠️ 两种来源（账号智能体 / 编排内建智能体）走的是**同一份实现**：
 *   "从哪读"由 `sources.exclusive` 决定（目录归存储实现），"怎么拼成 payload"
 *   只有这一处。谁要在别处再写一遍独有技能 → 就是第二套口径。
 */
export async function loadInjectableSkills(
  store: Store,
  sources: SkillSources,
): Promise<SkillPayload[]> {
  const all = await store.listSkills(sources.workspaceId)
  const byId = new Map(all.map((s) => [s.id as string, s]))
  const ids = [...sources.libraryIds]

  const library: Skill[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    const skill = byId.get(id)
    if (skill) library.push(skill)
  }

  // ★ 同 slug 遮蔽（D80，设计 §1.1）：提炼的（mine）优先于安装的。
  const mineBySlug = new Map(all.filter((s) => s.source === 'mine').map((s) => [s.slug, s]))
  const libraryPayloads = library.map((skill) => {
    if (skill.source === 'mine') return libraryToPayload(skill)
    const mine = mineBySlug.get(skill.slug)
    return mine ? libraryToPayload(mine) : libraryToPayload(skill)
  })

  // ★ 独有技能（D111）：这个智能体自己的文件，同 slug 遮蔽库技能。
  const exclusive = await store.listExclusiveSkills(sources.exclusive)
  const exclusiveSlugs = new Set(exclusive.map((e) => e.slug))
  const shared = libraryPayloads.filter((p) => !exclusiveSlugs.has(p.slug))
  return [...shared, ...exclusive.map((e) => exclusiveToPayload(e.slug, e.body))]
}
