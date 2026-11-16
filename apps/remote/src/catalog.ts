import { readFile, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { resolveLocalPath } from '@agentdeck/skill-source'

/*
 * ⚠️ 2026-11（D123）：这里原来是**远端公共目录里的工具包**那一整套
 *   （`CatalogToolEntry` / `loadCatalogTools` / `loadOne` / 文本与体积限额、入口
 *   必须在包里这条判据）。工具包与动作能力一起退场：daemon 不再装包、界面不再有
 *   工具页、远端目录也不再列它们（`apps/remote/catalog/tools/` 里的四个范例包
 *   同批删掉）。远端现在只列**技能**。
 */

/**
 * 公共目录里的**技能**条目（2026-10：推荐清单）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 与工具包那条路的关系：形状同形，机制不同
 * ══════════════════════════════════════════════════════════════════
 *
 * 工具包的判据（清单 schema、入口必须在包里）在 daemon 侧；技能这边**取包规则
 * 也在 daemon 侧**（`@agentdeck/skill-source`），写目录的独立工具
 * （`tools/skill-catalog-sync/`）**用同一份实现**把内容抓下来放进目录。所以两边
 * 对"什么是一个合法技能包"的判断逐字相同——远端不可能列出一份 daemon 装不
 * 进来的东西。
 *
 * ★ 内容**不在代码仓库里**：它落在一个目录里（默认远端数据目录下的
 *   `catalog-skills`，由工具的 `--out` 说了算），与插件、账号数据同一个地盘。
 *   仓库里只有清单（`tools/skill-catalog-sync/recommended-skills.json`，
 *   只有 URL 与我们自己写的说明）。
 *
 * ★ `sourceRef` **保留原始 GitHub 来源**（`github:owner/repo@ref:dir`），不是
 *   `remote:…`：远端在这里是中转，不是出处。落库记录因此仍指回上游，审计链不断。
 */
export interface CatalogSkillEntry {
  slug: string
  name: string
  version: string | null
  summary: string
  category: string
  origin: 'official' | 'community'
  fills: string | null
  needs: string | null
  /** SKILL.md 的正文——**内容随列表一起给**，装的时候直接交给本机 daemon。 */
  content: string
  /** 支持文件（相对路径 → 内容）。缺了它装进来只有 SKILL.md，那种技能是坏的。 */
  files: Record<string, string>
  /**
   * 清单里声明排除、**没有装进来**的文件（相对路径）。
   *
   * ⚠️ 必须一路传到界面：使用者要在**装之前**就知道"这一条的内容不完整"，而不是
   *    装完跑起来才发现少零件（"坏得很安静"正是这个仓库最防的一种失败）。
   */
  excluded: string[]
  sourceRef: string
  fetchedAt: string
  /**
   * 这条是从哪儿来的（D52）：`synced` = 推荐清单同步下来的（工具独占那个目录）；
   * `local` = 维护者在管理页上**手动装的**（落在 `<dataDir>/catalog-skills-local`）。
   * 界面据此显示来源徽标、并决定"能不能卸载"——同步来的要改清单，不能在页面上删。
   */
  source?: 'synced' | 'local'
}

export interface CatalogSkillLoadResult {
  skills: CatalogSkillEntry[]
  /** 明确**没**列出去的东西及原因（缺内容、缺索引、读不了……）。 */
  skipped: Array<{ path: string; reason: string }>
}

/**
 * 扫技能目录，把内容与索引合成条目。
 *
 * 布局：
 *   `<root>/<slug>/SKILL.md`（+ 支持文件）   ← 同步工具写的**内容**
 *   `<root>/.sync.json`                      ← 同一个工具写的**元数据**（一个文件）
 *
 * ⚠️ 元数据**不能放进技能目录里**：`@agentdeck/skill-source` 的本地取包规则会把
 *    技能目录里的每个文本文件都当成**支持文件**收走——元数据的 JSON 会被装进
 *    使用者的技能里。所以它在技能目录**旁边**，而 `resolveLocalPath` 只吃
 *    `<slug>/` 那一层。
 */
export async function loadCatalogSkills(root: string): Promise<CatalogSkillLoadResult> {
  const skills: CatalogSkillEntry[] = []
  const skipped: Array<{ path: string; reason: string }> = []

  let indexRaw: string
  try {
    indexRaw = await readFile(join(root, '.sync.json'), 'utf8')
  } catch {
    // 没有索引 = 还没同步过（目录可以为空，这是一句真话；界面要有空态）
    return { skills, skipped }
  }

  let index: { items?: unknown }
  try {
    index = JSON.parse(indexRaw) as { items?: unknown }
  } catch (err) {
    skipped.push({ path: '.sync.json', reason: `索引读不了（不是 JSON？）：${String(err)}` })
    return { skills, skipped }
  }
  const items = Array.isArray(index.items) ? (index.items as Record<string, unknown>[]) : []

  for (const item of items) {
    const slug = typeof item['slug'] === 'string' ? item['slug'] : ''
    if (slug === '') {
      skipped.push({ path: '.sync.json', reason: '有一条没有 slug' })
      continue
    }
    // ★ 用**与 daemon 同一个**本地取包规则读内容：限额、必须有 SKILL.md、
    //   二进制跳过——这一步顺带把"有人手改了目录"也查出来了。
    try {
      const resolved = await resolveLocalPath(join(root, slug))
      skills.push({
        slug,
        name: typeof item['name'] === 'string' ? item['name'] : slug,
        version: typeof item['version'] === 'string' ? item['version'] : null,
        summary: typeof item['summary'] === 'string' ? item['summary'] : '',
        category: typeof item['category'] === 'string' ? item['category'] : 'other',
        origin: item['origin'] === 'official' ? 'official' : 'community',
        fills: typeof item['fills'] === 'string' ? item['fills'] : null,
        needs: typeof item['needs'] === 'string' ? item['needs'] : null,
        content: resolved.body,
        files: resolved.files,
        excluded: Array.isArray(item['excluded'])
          ? (item['excluded'] as unknown[]).filter((p): p is string => typeof p === 'string')
          : [],
        sourceRef: typeof item['sourceRef'] === 'string' ? item['sourceRef'] : `remote:${slug}`,
        fetchedAt: typeof item['fetchedAt'] === 'string' ? item['fetchedAt'] : '',
      })
    } catch (err) {
      skipped.push({
        path: slug,
        reason: `索引里有、但内容读不出来：${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  skills.sort((a, b) => a.slug.localeCompare(b.slug))
  return { skills, skipped }
}
