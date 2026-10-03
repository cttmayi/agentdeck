import { copyFile, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 推荐清单的**配置位置**（2026-10，使用者："逻辑上 recommended-skills.json 只是默认值，
 * 运行后需要转存到另外的位置上，未来可以进行配置。如果有配置，tool 和 web 都是读取配置文件"）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 两条线：仓库里的**内置默认**、运行时的**配置文件**
 * ══════════════════════════════════════════════════════════════════
 *
 *   `tools/skill-catalog-sync/recommended-skills.json`  ← 仓库自带的**默认值**
 *   `<目录数据目录>/recommended-skills.json`             ← 运行时的**配置文件**（第一次跑时转存）
 *
 * 为什么要转存，而不是就地改仓库里那份：仓库里那份属于**代码**（随版本走、会被 git
 * 覆盖），而"推荐哪些技能"是**运行时的内容**（跟数据目录里的其它东西一个性质）。
 * 把两者混在一起，使用者改完清单会在下一次 `git pull` 时安静地丢掉。
 *
 * ★ **谁读它**：工具（抓取）与远端服务（页面上展示"要抓的是哪份清单"）读的是
 *   **同一个文件**。所以两边都用这里的 `resolveManifest` / `configPathFor`，
 *   免得"工具抓 A、页面说 B"这种最难查的不一致。
 *
 * ⚠️ **转存只发生在工具里**：服务只读、绝不写（它是只读控制台 + 两个显式动作，
 *    不该在启动时悄悄动使用者的数据目录）。所以"还没转存"是一个**合法状态**，
 *    页面要如实说"还没转存，第一次同步时会转存内置默认"。
 */
export const BUILTIN_MANIFEST_PATH = fileURLToPath(
  new URL('../recommended-skills.json', import.meta.url),
)

/** 配置文件名（与内置那份同名，只是换个位置）。 */
export const CONFIG_FILE_NAME = 'recommended-skills.json'

/**
 * 数据目录（或目录数据目录）对应的配置路径。
 *
 * `catalogDir` 是**内容**落到哪儿（工具的 `--out` / 服务的 `skillsDir`），
 * 配置就放在它的**旁边**——两个目录一起搬走时不会拆散。
 */
export function configPathFor(catalogDir: string): string {
  return join(dirname(catalogDir), CONFIG_FILE_NAME)
}

export interface ResolveManifestInput {
  /** `--manifest <文件>`：显式指定，**不转存**（给了就按给的来，缺了直接报错）。 */
  explicitPath?: string | undefined
  /** 内容目录（`--out` / `skillsDir`）；配置默认放它旁边。 */
  catalogDir: string
  log?: (line: string) => void
}

export interface ResolvedManifest {
  path: string
  /** 这一次是不是刚从内置默认转存过来的。 */
  seeded: boolean
  /** 来源：显式指定 / 已有配置 / 刚转存。 */
  origin: 'explicit' | 'config' | 'seeded-from-builtin'
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * 决定这一次用哪份清单；必要时**把内置默认转存到配置位置**。
 *
 * 顺序：`--manifest` 给了就用它（不转存、不猜）→ 配置位置有就用它 →
 * 都没有 ⇒ 把内置默认复制过去，然后用那一份。
 */
export async function resolveManifest(input: ResolveManifestInput): Promise<ResolvedManifest> {
  const log = input.log ?? (() => {})

  if (input.explicitPath !== undefined && input.explicitPath.trim() !== '') {
    const path = input.explicitPath.trim()
    if (!(await exists(path))) {
      throw new Error(`--manifest 指定的清单不存在：${path}`)
    }
    return { path, seeded: false, origin: 'explicit' }
  }

  const configPath = configPathFor(input.catalogDir)
  if (await exists(configPath)) {
    return { path: configPath, seeded: false, origin: 'config' }
  }

  // ★ 第一次运行：把仓库里那份**默认值**转存到配置位置，并**说清发生了什么**
  //   （使用者要能知道"以后改哪一份"）。
  await copyFile(BUILTIN_MANIFEST_PATH, configPath).catch(async (err: unknown) => {
    throw new Error(
      `把内置默认清单转存到 ${configPath} 失败：${err instanceof Error ? err.message : String(err)}`,
    )
  })
  log(`清单配置：第一次运行，已把内置默认转存到 ${configPath}`)
  log('（以后改推荐哪些技能，改这一份；仓库里那份只是默认值，不会再被读）')
  return { path: configPath, seeded: true, origin: 'seeded-from-builtin' }
}

/** 清单的**轻量摘要**（给页面显示"要抓的是哪一份、几条、核对于哪天"）。 */
export interface ManifestSummary {
  path: string
  exists: boolean
  verifiedAt: string | null
  count: number
  /** 读不了时的原话（页面如实显示，不编）。 */
  error: string | null
}

/**
 * 读一份清单的摘要。
 *
 * ⚠️ 这里**只做摘要**（条数 + 核对于），**不做完整校验**：校验规则归工具
 * （`readRecommendedManifest`，它才是照着做事的那个）；服务只是把它显示出来，
 * 读不了就如实说"读不了"，不假装有 N 条。
 */
export async function summarizeManifest(path: string): Promise<ManifestSummary> {
  if (!(await exists(path))) {
    return { path, exists: false, verifiedAt: null, count: 0, error: null }
  }
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as {
      verifiedAt?: unknown
      items?: unknown
    }
    return {
      path,
      exists: true,
      verifiedAt: typeof parsed.verifiedAt === 'string' ? parsed.verifiedAt : null,
      count: Array.isArray(parsed.items) ? parsed.items.length : 0,
      error: null,
    }
  } catch (err) {
    return {
      path,
      exists: true,
      verifiedAt: null,
      count: 0,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
