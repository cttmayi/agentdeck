/**
 * **智能体生成者的平台技能**（2026-11，设计定稿 §3.3 / §4）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么是"动态安装"
 * ══════════════════════════════════════════════════════════════════
 *
 * 使用者原话："智能体生成者可以包括几个你认为重要的市场技能……可以和沉淀起草者一样，
 * 动态安装。"——和起草者挂 `distilly` 同一套分工：**规范走技能不走指令**。这三份
 * 规范（岗位卡结构 / 边界清单 / 配套技能判定）挂在智能体生成者身上随聊天注入，
 * 而不是写死在它的指令里——技能可独立演进、可被使用者编辑替换。
 *
 * 与 distilly 不同的只有**来源**：distilly 是使用者自己从 GitHub 装的（所以要在
 * 「沉淀设置」里显式安装）；这三份是**平台内置技能**，随仓库分发
 * （`apps/daemon/catalog/platform-skills/<slug>/SKILL.md`），daemon 启动时
 * **动态安装**进技能库——使用者不用做任何事，装不上时也只是"规范没注入"
 * （生成者的指令本身仍含五字段与边界要点，见 `AGENT_MAKER_INSTRUCTIONS`）。
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolvePayloadEntry } from '@agentdeck/skill-source'
import { extractSkillMeta } from '@agentdeck/agent-core'
import { ulid } from '@agentdeck/protocol'
import type { Agent, Skill, WorkspaceId } from '@agentdeck/protocol'
import type { Store } from '@agentdeck/domain'
import { findBuiltinAgent, ensureBuiltinAgentMaker } from './builtin-drafter.ts'

/** 智能体生成者挂载的平台技能（这三份是"生成者的手则"）。 */
export const AGENT_MAKER_SKILL_SLUGS = [
  'agent-design-norms',
  'boundary-checklist',
  'skill-eligibility',
] as const

/** 这份技能的默认来源标注（平台内置技能都来自这里，与 distilly 的 `remote:` 区分开）。 */
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
 * 把平台内置技能**动态安装**进技能库（幂等：同名已存在就一字不动）。
 *
 * 三条口径（与安装接口同一关：`resolvePayloadEntry` 校验，不自己另开一条路）：
 *   · 已存在同名 skill ⇒ **不覆盖**（那是使用者可能改过的资产；同名拒绝写入是安装接口的
 *     老规矩，这里保持一致——平台技能是缺省提供，不是占位垄断）；
 *   · 只装缺失的；装好的不重写；
 *   · 安装失败（校验不过/读不到）⇒ **跳过并说得出原因**，不抛——启动对账不该因为
 *     一份规范技能坏了就起不来（生成者的指令仍能独立工作）。
 */
export async function ensureAgentMakerSkillsInstalled(
  store: Store,
  workspaceId: WorkspaceId,
): Promise<{ installed: string[]; skipped: string[] }> {
  const existing = new Set((await store.listSkills(workspaceId)).map((s) => s.slug))
  const installed: string[] = []
  const skipped: string[] = []
  const now = Date.now()
  for (const slug of AGENT_MAKER_SKILL_SLUGS) {
    if (existing.has(slug)) continue
    try {
      const body = await readBundledSkillMd(slug)
      // ★ 与安装接口**同一关**：规范化 + 限额检查（`resolvePayloadEntry`）。
      //   自建一条不校验的安装路 = 两处规则迟早分叉，而坏的那份技能"装上了却永不生效"。
      const validated = resolvePayloadEntry({
        slug,
        body,
        sourceRef: AGENT_MAKER_SKILL_SOURCE_REF,
      })
      // name / description 来自 SKILL.md 的 frontmatter（与安装接口同一口径：
      //   `extractSkillMeta`，不自己另算一遍）。
      const meta = extractSkillMeta(validated.body)
      const skill: Skill = {
        id: ulid() as Skill['id'],
        workspaceId,
        slug,
        name: meta.name !== undefined && meta.name !== '' ? meta.name : slug,
        description: meta.description !== undefined ? meta.description : null,
        body: validated.body,
        ...(Object.keys(validated.files).length > 0 ? { files: validated.files } : {}),
        verdictSchemaVersion: 1,
        source: 'local',
        sourceRef: AGENT_MAKER_SKILL_SOURCE_REF,
        version: null,
        createdAt: now,
        updatedAt: now,
      }
      await store.insertSkill(skill)
      installed.push(slug)
    } catch (err) {
      skipped.push(`${slug}（${err instanceof Error ? err.message : String(err)}）`)
    }
  }
  return { installed, skipped }
}

/**
 * 把智能体生成者的**技能挂载**与技能库对齐（自愈；与 `syncDrafterSkillMount` 同一形状）。
 *
 * 三条口径：
 *   · 只在"改了才写"；
 *   · 只挂 `AGENT_MAKER_SKILL_SLUGS` 里那几条，**其它一概不动**（将来若允许给生成者挂
 *     别的技能，这里不会把它们抹掉）；
 *   · 内置 agent 是只读的 ⇒ 这个字段由**平台**维护，界面上那句话要说清"平台替你挂的"。
 */
export async function syncAgentMakerSkillMount(
  store: Store,
  workspaceId: WorkspaceId,
): Promise<{ agentId: string | null; skillIds: string[]; skillSlugs: string[] }> {
  await ensureBuiltinAgentMaker(store, workspaceId)
  const all = await store.listAgents(workspaceId)
  const maker = findBuiltinAgent(all, 'agent-maker')
  if (!maker) return { agentId: null, skillIds: [], skillSlugs: [] }

  const skills = await store.listSkills(workspaceId)
  const wanted = skills.filter((sk) => (AGENT_MAKER_SKILL_SLUGS as readonly string[]).includes(sk.slug))
  const wantedIds = new Set(wanted.map((sk) => sk.id as string))
  // 保留它自己原有的、且不是"生成者规范技能"的那些（现在恒为空，但别写死成"清空"）
  const kept = maker.skillIds
    .map((id) => id as string)
    .filter((id) => !skills.some((sk) => (sk.id as string) === id && (AGENT_MAKER_SKILL_SLUGS as readonly string[]).includes(sk.slug)))
  const next = [...kept, ...wantedIds]
  const same =
    next.length === maker.skillIds.length &&
    next.every((id, i) => id === (maker.skillIds[i] as string | undefined))
  if (!same) {
    await store.insertAgent({
      ...maker,
      skillIds: next as Agent['skillIds'],
      updatedAt: Date.now(),
    })
  }
  return {
    agentId: maker.id as string,
    skillIds: next,
    skillSlugs: wanted.map((sk) => sk.slug),
  }
}
