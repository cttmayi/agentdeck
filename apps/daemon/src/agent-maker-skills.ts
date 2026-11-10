/**
 * **智能体生成者的平台技能**（2026-11，设计定稿 §3.3 / §4；D111 改版）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 2026-11（D111）之前：这三份是**动态安装**进技能库的
 * ══════════════════════════════════════════════════════════════════
 *
 * 使用者原话："智能体生成者可以包括几个你认为重要的市场技能……可以和沉淀起草者一样，
 * 动态安装。"——和起草者挂 `distilly` 同一套分工：**规范走技能不走指令**。
 *
 * ★ D111 之后：它们是生成者的**独有技能**（`agents/<id>/SKILL/<slug>/SKILL.md`
 *   文件资产，设计定稿 `docs/design/agent-directory.md` §4）——**不再进技能库、
 *   不进技能页、不可卸载**。上一轮那个"库中永远没有 + 旧安装被清理 + 生成者 run
 *   注入 3 条内置技能"的目标，用统一机制达成，不需要 `builtinSkillSlugs` 特殊字段：
 *
 *   · 播种：daemon 启动时把 `catalog/platform-skills/<slug>/SKILL.md` 写进生成者
 *     目录（幂等：已在就一字不动；与安装接口同一关 `resolvePayloadEntry` 校验）；
 *   · 迁移：老工作区库里那三条 `sourceRef: 'platform:agent-maker'` 的**搬进**生成者
 *     目录、从库里删掉（一次性、幂等——库里没有就跳过）；
 *   · 注入：聊天那轮读目录里的独有技能（`loadAgentInjectableSkills`），与共享技能
 *     同一条通道。
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolvePayloadEntry } from '@agentdeck/skill-source'
import type { WorkspaceId } from '@agentdeck/protocol'
import type { Store } from '@agentdeck/domain'
import { findBuiltinAgent, ensureBuiltinAgentMaker } from './builtin-drafter.ts'

/** 智能体生成者的平台技能（这三份是"生成者的手则"）。 */
export const AGENT_MAKER_SKILL_SLUGS = [
  'agent-design-norms',
  'boundary-checklist',
  'skill-eligibility',
] as const

/** 老数据里这几条技能在库里的来源标注（D111 迁移时按它认）。 */
export const AGENT_MAKER_SKILL_SOURCE_REF = 'platform:agent-maker'

/** 内置技能的内容路径（与 `skill-list.ts` 的 `defaultSkillListPath` 同一个惯例）。 */
function skillMdPath(slug: string): string {
  return fileURLToPath(new URL(`../catalog/platform-skills/${slug}/SKILL.md`, import.meta.url))
}

/** 读一份内置技能的内容（读取失败即抛——平台技能随仓库分发，读不到是装坏了，不是没有）。 */
async function readBundledSkillMd(slug: string): Promise<string> {
  return await readFile(skillMdPath(slug), 'utf8')
}

/**
 * 播种生成者的**独有技能**（幂等：已在就一字不动）。
 *
 * 三条口径：
 *   · 只写缺失的；写好的不重写（与"动态安装不覆盖"同一句老话——使用者可能
 *     手工改过那份文件，平台不悄悄抹掉）；
 *   · 与安装接口**同一关**：`resolvePayloadEntry` 校验（规范化 + 限额检查）。
 *     自建一条不校验的播种路 = 两处规则迟早分叉，而坏的那份技能"装上了却永不生效"；
 *   · 播种失败（校验不过/读不到）⇒ **跳过并说得出原因**，不抛——启动对账不该
 *     因为一份规范技能坏了就起不来（生成者的指令仍能独立工作）。
 */
export async function ensureBuiltinAgentMakerSkills(
  store: Store,
  workspaceId: WorkspaceId,
): Promise<{ agentId: string | null; seeded: string[]; skipped: string[] }> {
  await ensureBuiltinAgentMaker(store, workspaceId)
  const all = await store.listAgents(workspaceId)
  const maker = findBuiltinAgent(all, 'agent-maker')
  if (!maker) return { agentId: null, seeded: [], skipped: [] }

  const existing = new Set(
    (await store.listExclusiveSkills(maker.id)).map((s) => s.slug),
  )
  const seeded: string[] = []
  const skipped: string[] = []
  for (const slug of AGENT_MAKER_SKILL_SLUGS) {
    if (existing.has(slug)) continue
    try {
      const body = await readBundledSkillMd(slug)
      const validated = resolvePayloadEntry({ slug, body, sourceRef: AGENT_MAKER_SKILL_SOURCE_REF })
      await store.writeExclusiveSkill(maker.id, slug, validated.body)
      seeded.push(slug)
    } catch (err) {
      skipped.push(`${slug}（${err instanceof Error ? err.message : String(err)}）`)
    }
  }
  return { agentId: maker.id as string, seeded, skipped }
}

/**
 * 老工作区的一次性迁移（D111）：库里那三条 `sourceRef: 'platform:agent-maker'`
 * 的技能**搬进**生成者的独有技能目录、从库里删掉。
 *
 * 为什么搬而不是留着：这三份是**平台技能**，本来就该只属于生成者；留在库里会让
 * 它们出现在技能页、能被卸载（上一轮专门加了"平台挂载卸不掉"的特殊处理——这轮
 * 用统一机制把这个特殊情况**删掉**）。
 *
 * 幂等：库里没有这三条就什么都不做。正文用**库里已有的**（使用者可能改过）——
 * 迁移不改内容，只改归属。
 */
export async function migratePlatformSkillsToExclusive(
  store: Store,
  workspaceId: WorkspaceId,
): Promise<{ moved: string[] }> {
  const all = await store.listAgents(workspaceId)
  const maker = findBuiltinAgent(all, 'agent-maker')
  if (!maker) return { moved: [] }

  const platform = (await store.listSkills(workspaceId)).filter(
    (s) => s.sourceRef === AGENT_MAKER_SKILL_SOURCE_REF,
  )
  if (platform.length === 0) return { moved: [] }

  const moved: string[] = []
  for (const skill of platform) {
    // 已有同 slug 的独有技能 ⇒ 不覆盖（老库那份先来，播种那份在后面补缺）
    const existing = await store.getExclusiveSkill(maker.id, skill.slug)
    if (existing === null) {
      await store.writeExclusiveSkill(maker.id, skill.slug, skill.body)
    }
    moved.push(skill.slug)
    await store.deleteSkill(skill.id)
  }

  // 清掉生成者 `skillIds` 里指回这三条的引用（D111 之后它不挂库技能了；
  // 只动这三条，其它挂载一概不动）。
  const platformIds = new Set(platform.map((s) => s.id as string))
  const kept = maker.skillIds.filter((id) => !platformIds.has(id as string))
  if (kept.length !== maker.skillIds.length) {
    await store.insertAgent({ ...maker, skillIds: kept, updatedAt: Date.now() })
  }
  return { moved }
}
