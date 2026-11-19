/**
 * **编排生成者的平台技能**（2026-11，D143）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么要有这份
 * ══════════════════════════════════════════════════════════════════
 *
 * 使用者问：「"编排生成者（内置）" 里面并没有描述 API 的细节，它怎么会知道怎么写编排呢」——
 * 问得对。它原来的指令只有**五行浓缩的伪代码**（`flow` / `parallel` / `loop` / `gate` 各一句），
 * 没有：六个原语的**签名**（`parallel` 返回的是 **Reply 数组**、`loop` 的第三个参数可以是
 * opts、`flow` 的 `returnIndex`）、`{{task}}` 到底是什么、Reply 的形状、**把关者必须会判**
 * （`agent(name, 判定函数)` 或 `gate`）、人判要配 `reuseOutput`、以及"名字必须真存在"之外
 * 的那些坑。它只能靠猜——猜出来的代码在采纳时语法能过、跑起来才发现不对。
 *
 * 所以照**智能体生成者**那条已经踩过坑的分工（D111）来：**流程与取舍写进指令，
 * API 细节写进平台技能**。这份技能是生成者的**独有技能**（`agents/<id>/SKILL/<slug>/`），
 * 启动时从随仓库分发的 `catalog/platform-skills/` 播种（幂等、已在就一字不动），
 * 与共享技能走同一条注入通道，**不进技能库、不进技能页、不可卸载**。
 *
 * ⚠️ 技能的正文**必须与引擎一致**（`workflow-maker-skills.test.ts` 钉着）：
 *   · 六个原语的名字与 `WORKFLOW_PRIMITIVES` 一致；
 *   · 正文里每一段 ```js 示例都能被 `validateWorkflowCode` 编译通过——
 *     "写进规范里的例子跑不起来"是最坏的一种失真（模型会照着抄）。
 */
import { platformMemberOf } from './platform-slots.ts'
import { ensureBuiltinWorkflowMaker } from './builtin-drafter.ts'
import { WORKFLOW_PRIMITIVES, validateWorkflowCode } from './workflow-maker.ts'
import type { WorkspaceId } from '@agentdeck/protocol'
import type { Store } from '@agentdeck/domain'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolvePayloadEntry } from '@agentdeck/skill-source'

/** 编排生成者的平台技能（"怎么写编排"这份手则）。 */
export const WORKFLOW_MAKER_SKILL_SLUGS = ['orchestration-authoring'] as const

/** 独有技能的来源标注（与生成者那份同一套口径）。 */
export const WORKFLOW_MAKER_SKILL_SOURCE_REF = 'platform:workflow-maker'

/** 内置技能的内容路径（与 `agent-maker-skills.ts` 同一个惯例）。 */
function skillMdPath(slug: string): string {
  return fileURLToPath(new URL(`../catalog/platform-skills/${slug}/SKILL.md`, import.meta.url))
}

/** 读一份内置技能的内容（读不到即抛——它随仓库分发，读不到是装坏了）。 */
async function readBundledSkillMd(slug: string): Promise<string> {
  return await readFile(skillMdPath(slug), 'utf8')
}

/**
 * 播种编排生成者的**独有技能**（幂等：已在就一字不动）。
 *
 * 三条口径与 `ensureBuiltinAgentMakerSkills` 完全一致：
 *   · 只写缺失的，写好的不重写（使用者可能手工改过）；
 *   · 与安装接口**同一关** `resolvePayloadEntry`（自建一条不校验的播种路 = 两处规则迟早分叉）；
 *   · 失败跳过并说得出原因，不抛（启动对账不该因为一份规范坏了就起不来）。
 */
export async function ensureBuiltinWorkflowMakerSkills(
  store: Store,
  workspaceId: WorkspaceId,
): Promise<{ agentId: string | null; seeded: string[]; skipped: string[] }> {
  await ensureBuiltinWorkflowMaker(store, workspaceId)
  const all = await store.listAgents(workspaceId)
  const maker = await platformMemberOf(store, workspaceId, 'workflow-maker')
  if (!maker) return { agentId: null, seeded: [], skipped: [] }

  const existing = new Set((await store.listExclusiveSkills(maker.id)).map((s) => s.slug))
  const seeded: string[] = []
  const skipped: string[] = []
  for (const slug of WORKFLOW_MAKER_SKILL_SLUGS) {
    if (existing.has(slug)) continue
    try {
      const body = await readBundledSkillMd(slug)
      const validated = resolvePayloadEntry({
        slug,
        body,
        sourceRef: WORKFLOW_MAKER_SKILL_SOURCE_REF,
      })
      await store.writeExclusiveSkill(maker.id, slug, validated.body)
      seeded.push(slug)
    } catch (err) {
      skipped.push(`${slug}（${err instanceof Error ? err.message : String(err)}）`)
    }
  }
  return { agentId: maker.id as string, seeded, skipped }
}

/**
 * 从一份技能正文里抠出所有 ```js / ```javascript 代码块（测试用）。
 *
 * 为什么从这里读而不是把例子抄进测试：抄一份的那天就开始漂——这里是**同一份**正文，
 * 所以"规范里的例子跑不起来"会当场红。
 */
export function jsBlocksOf(body: string): string[] {
  const out: string[] = []
  const re = /```(?:js|javascript)\n([\s\S]*?)```/g
  for (const m of body.matchAll(re)) out.push(m[1] ?? '')
  return out
}

/**
 * 校验一份技能正文里的所有代码示例（测试用：返回失败清单，空数组 = 全过）。
 *
 * 名字一栏用示例里**自己出现过的** agent 名字：这些示例是"示范写法"，
 * 引用的名字本来就只是占位（真实采纳时会被替换成用户智能体页里的名字）。
 */
export function checkSkillSamples(body: string): string[] {
  const problems: string[] = []
  for (const code of jsBlocksOf(body)) {
    // 只校验"像编排代码"的块（`agent(` 开头那几段）；纯语法示意（第三参数那两行）不算。
    if (!code.includes('await ')) continue
    const names = new Set<string>()
    for (const m of code.matchAll(/agent\(\s*(['"])([^'"]*)\1/g)) names.add(m[2] ?? '')
    const check = validateWorkflowCode(code, [...names])
    if (check.syntaxError !== null) problems.push(`语法错：${check.syntaxError}`)
    else if (check.unknownAgents.length > 0) problems.push(`引用了未知名字：${check.unknownAgents.join('、')}`)
  }
  return problems
}

/** 正文里必须出现的原语名（与引擎一致）——测试用。 */
export function missingPrimitives(body: string): string[] {
  return WORKFLOW_PRIMITIVES.filter((name) => !body.includes(name))
}
