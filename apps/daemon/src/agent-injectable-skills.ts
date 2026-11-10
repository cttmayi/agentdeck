/**
 * **一个智能体注入时带的技能**（D111，设计定稿 `docs/design/agent-directory.md` §5）。
 *
 * 两类技能、同一条投递通道（`executor.submit({ skills })` → 受管运行时目录 +
 * 第一句话的 skillsBrief）：
 *
 *   ① **共享技能**（技能库）——`agent.skillIds` 引用，mine 遮蔽安装（D80）；
 *   ② **独有技能**（`agents/<id>/SKILL/<slug>/SKILL.md` 文件资产）——不在库里，
 *      是这个智能体自己的；同 slug 时**独有优先**（它的就是它的，遮蔽库里那份）。
 *
 * 聊天与任务/审核/返工都走这里——不要在别处再拼一遍（两处各拼一遍迟早分叉，
 * 而"共享的没带、独有的带了"这种差别没人会当成 bug 去查）。
 */

import { extractSkillMeta } from '@agentdeck/agent-core'
import type { Store } from '@agentdeck/domain'
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
 * 一个 agent 的全部注入技能（共享 ∪ 独有）。
 *
 * @param extraLibraryIds 额外要带的**库技能** id（聊天那条路：对话自己选的
 *   `Conversation.skillIds`——它们也按 id 从库里解析，与 `agent.skillIds` 相加）。
 */
export async function loadAgentInjectableSkills(
  store: Store,
  agent: Agent,
  extraLibraryIds: readonly string[] = [],
): Promise<SkillPayload[]> {
  const all = await store.listSkills(agent.workspaceId)
  const byId = new Map(all.map((s) => [s.id as string, s]))
  const ids = [...agent.skillIds.map((id) => id as string), ...extraLibraryIds]

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
  const exclusive = await store.listExclusiveSkills(agent.id)
  const exclusiveSlugs = new Set(exclusive.map((e) => e.slug))
  const shared = libraryPayloads.filter((p) => !exclusiveSlugs.has(p.slug))
  return [...shared, ...exclusive.map((e) => exclusiveToPayload(e.slug, e.body))]
}
