import { readFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { assertValidSlug, parseGithubUrl, toSlug } from '@agentdeck/skill-source'

/**
 * 「本地安装清单」——一份仓库自带的 JSON，列出可安装技能的**安装方法**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 它是第三条安装路，与另外两条刻意不同
 * ══════════════════════════════════════════════════════════════════
 *
 * 装技能现在有三条路（界面「技能 → 安装技能」的三个页签）：
 *
 *   1. **路径 / GitHub**：使用者手输一条，daemon 现去取（`POST /api/skills/install`）；
 *   2. **远端目录**：远端服务读一份目录（内容由同步工具 `pnpm run sync-skills`
 *      **预先抓好**），页面取回来点一下装——要求远端起起来 + 登录 + 先跑同步工具；
 *   3. **本地清单**（本文件）：读一份**仓库自带**的 JSON，界面把它列成可点的表，
 *      点一下由 daemon **现去 GitHub 取**（复用 1 那条路）。
 *
 * ★ 第 3 条**不需要**远端服务、同步工具或登录。它就是"把一批安装方法固化成一份
 *   可点列表"，所以它读的是**安装方法**（url / path），而不是"已经抓好的内容"。
 *
 * ══════════════════════════════════════════════════════════════════
 * slug 只算一处——清单**不许**声明它
 * ══════════════════════════════════════════════════════════════════
 *
 * 每条 entry 的 slug 由 `@agentdeck/skill-source` 的取包规则算出来（url → GitHub
 * 目标的目录名/仓库名；path → 目录名），**与真正装的时候逐字相同**。清单里**不**
 * 提供 slug 字段：若清单声明的 slug 与安装时重算出来的不一致，界面会拿错 slug
 * 去比"装没装过"，把一条已装的技能显示成「安装」——而没有任何地方会报错。
 *
 * ⚠️ 与推荐清单（`tools/skill-catalog-sync/recommended-skills.json`）的关系：
 *    那是**同步工具的取包清单**（有 per-item `exclude` 修剪语义、没有 path 变体），
 *    这份是**daemon 的安装方法清单**。两份是**两个文件**，各自独立演进，不承诺同步。
 *    也正因为这里没有 `exclude`，经 url 安装会把那个仓库的整棵树拉下来（在
 *    `skill-source` 的限额内）——这是与「远端目录」的一条真实行为差异。
 */

/** 清单文件顶层声明的东西——用来在格式变化时能一眼看出是哪一版。 */
export const SKILL_LIST_SCHEMA = 'agentdeck/skill-list@1'

const ManifestItem = z.object({
  name: z.string().min(1),
  /** 恰好给一个 url 或 path（下面逐条判）。 */
  url: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  summary: z.string().optional(),
  category: z.string().optional(),
  origin: z.enum(['official', 'community']).optional(),
  /** 装之前要说清的"还得自己准备什么"（如某个 API key）。 */
  needs: z.string().optional(),
})

const ManifestFile = z.object({
  schema: z.string(),
  note: z.string().optional(),
  items: z.array(z.unknown()),
})

/** 一个来源：`kind` + 值。形状直接对上 `POST /api/skills/install` 的入参。 */
export type SkillListSource =
  | { kind: 'url'; value: string }
  | { kind: 'path'; value: string }

export interface SkillListEntry {
  /** 由取包规则算出（见文件头）——界面据此判断"装没装过"。 */
  slug: string
  name: string
  summary: string
  category: string
  origin: 'official' | 'community'
  needs: string | null
  source: SkillListSource
}

export interface SkillListSkipped {
  /** 这条的身份（名字，或它在清单里的位置）。 */
  path: string
  reason: string
}

export interface SkillListResult {
  entries: SkillListEntry[]
  /** 明确**没**列出来的条目及原因（缺 url/path、主机不在白名单、slug 收敛不了……）。 */
  skipped: SkillListSkipped[]
}

/** 仓库自带的默认清单（与 `apps/remote/catalog/tools/` 同一个"仓库内目录"惯例）。 */
export function defaultSkillListPath(): string {
  return fileURLToPath(new URL('../catalog/skills.json', import.meta.url))
}

/**
 * url → slug。**与 `resolveGithubUrl` 里的算法逐字相同**（那边是 `dir === '' ?
 * repo : basename(dir)`），只是这里不下载：`parseGithubUrl` 只解析链接，够算 slug 了。
 */
function slugForUrl(url: string): string {
  const target = parseGithubUrl(url)
  const fallback = target.dir === '' ? target.repo : basename(target.dir)
  return toSlug(fallback)
}

/**
 * path → slug。**与 `resolveLocalPath` 对齐**：允许直接指向 `SKILL.md`（从编辑器
 * 复制过来的常常是文件路径），那时取它所在的目录名。
 */
function slugForPath(path: string): string {
  const base = basename(path)
  return toSlug(base === 'SKILL.md' ? basename(dirname(path)) : base)
}

/** 把清单里的一条变成 entry；坏条目返回原因（不抛整份——一条坏不该拖垮整张表）。 */
function toEntry(item: unknown, index: number): SkillListEntry | { reason: string; path: string } {
  const parsed = ManifestItem.safeParse(item)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.map(String).join('.') || '(根)'}：${i.message}`)
    return { path: `#${index + 1}`, reason: `条目格式不对（${issues.join('；')}）` }
  }
  const { name, url, path, summary, category, origin, needs } = parsed.data
  const label = name
  if ((url === undefined) === (path === undefined)) {
    return { path: label, reason: '条目要**恰好**有一个 url 或 path' }
  }
  try {
    const slug = url !== undefined ? slugForUrl(url) : slugForPath(path!)
    assertValidSlug(slug, `来源名是「${url ?? path}」，收敛后是「${slug}」。`)
    return {
      slug,
      name,
      summary: summary ?? '',
      category: category ?? 'other',
      origin: origin ?? 'community',
      needs: needs ?? null,
      source: url !== undefined ? { kind: 'url', value: url } : { kind: 'path', value: path! },
    }
  } catch (err) {
    return { path: label, reason: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 读并校验一份清单。
 *
 * ★ **清单本身**坏掉（读不了 / 不是 JSON / 顶层格式不对）⇒ **抛**：那是一处配置
 *   错误，界面要把它显示出来，而不是悄悄给一张空表。**单条**坏掉 ⇒ 进 `skipped`，
 *   其余照常列出——一条手滑不该让整份清单不可用。
 */
export async function loadSkillList(filePath: string): Promise<SkillListResult> {
  const text = await readFile(filePath, 'utf8')

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new Error(`清单不是合法 JSON（${filePath}）：${err instanceof Error ? err.message : String(err)}`)
  }

  const parsed = ManifestFile.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.map(String).join('.') || '(根)'}：${i.message}`)
    throw new Error(`清单格式不对（${filePath}）：${issues.join('；')}`)
  }

  const entries: SkillListEntry[] = []
  const skipped: SkillListSkipped[] = []
  parsed.data.items.forEach((item, index) => {
    const result = toEntry(item, index)
    if ('reason' in result) skipped.push({ path: result.path, reason: result.reason })
    else entries.push(result)
  })
  return { entries, skipped }
}
