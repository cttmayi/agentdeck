import { catalogEntryState, type CatalogEntryState } from './skill-catalog.ts'

/**
 * 「这个工具包在远端目录里有更新吗」——工具页那一列按钮的**唯一**判据。
 *
 * ══════════════════════════════════════════════════════════════════
 * 版本比较**不在这里重写一遍**
 * ══════════════════════════════════════════════════════════════════
 *
 * `compareVersions` / `catalogEntryState` 住在 `skill-catalog.ts` 里，但那两个
 * 函数其实**与 skill 无关**：它们比的是"目录里的版本 vs 本地装的版本"，输入只有
 * slug 与 version。它们先落在 skill 那边，只是因为 skill 目录先有了这套界面。
 *
 * 所以这里**只做工具侧的适配**（谁算"可以更新"），比较与措辞仍由那一份实现给出。
 * 重写一遍的代价不是多几十行，而是两处会**各自漂移**：哪天目录里出现 `2024-05`
 * 这种版本号，一处改了、另一处没改，症状是"skills 页能更新、工具页不能"。
 *
 * ⚠️ 判定"能不能更新"这件事**必须**是纯函数：它决定按钮出不出现，而按钮一旦
 *    出现，点下去就是**覆盖本地那个包**。这种事不能只靠渲染出来看一眼。
 */

/** 本地这个包需要的最小信息（与 `Tool` 结构兼容，便于测试）。 */
export interface LocalToolLike {
  slug: string
  version: string | null
  /** `'local'`（从路径装）/ `'remote'`（从远端目录装）。 */
  source: string
}

/** 远端目录里那一条。`version` 可以是 `null`（清单没写版本）。 */
export interface CatalogToolLike {
  slug: string
  version: string | null
}

/**
 * 算出这一行该不该给「更新」，以及按钮上写什么。
 *
 * 返回 `null` = **不给按钮**（四种情况，理由各不相同）：
 *
 * 1. **不是从远端目录装的**（`source !== 'remote'`）。从路径装的包，目录里恰好
 *    有个同名条目——那**不说明**它们是同一个东西的两版，很可能只是重名。给一个
 *    「更新」按钮，点下去就是把手上这份内容换成目录里那份，而且**没有任何提示**。
 *    skill 那边对同一件事的说法是"我们根本不知道手上这份是不是同一份内容"。
 * 2. **目录里没有这个 slug**。
 * 3. **目录里那一条没有版本号**：没有可比的东西，猜一个"更新"是在编。
 * 4. **远端更旧或一样**：一样就是"已安装"；更旧是**往回退**，那是另一件事，
 *    不该混在「更新」这个按钮里（要退回旧版仍然可以从安装抽屉的「允许替换」走）。
 *
 * ★ 版本号**认不出来**（不是 `x.y.z`，比如 `2024-05`）但两边不一样时，这里**给**
 *   按钮：那时"比本地新"是**未知**而不是否，而按钮上的说明会把两个版本号都写出来
 *   让使用者自己看——这比替他猜、或者干脆让他无从更新要诚实。
 */
export function toolUpdateState(
  local: LocalToolLike,
  catalogTools: readonly CatalogToolLike[],
): CatalogEntryState | null {
  if (local.source !== 'remote') return null

  const entry = catalogTools.find((t) => t.slug === local.slug)
  if (!entry) return null
  if (entry.version === null) return null

  const state = catalogEntryState(local, { slug: entry.slug, version: entry.version })
  return state.action === 'update' ? state : null
}
