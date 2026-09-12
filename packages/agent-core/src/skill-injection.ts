import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

/**
 * 技能注入（FR-CLI-18~25）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 三件容易做错的事
 * ══════════════════════════════════════════════════════════════════
 *
 * **① 技能发现靠"把目录摆对"，不靠提示词喂**（FR-CLI-19）
 *    我们把 `SKILL.md` 写到 CLI 原生会扫的目录里，让 CLI 自己发现。
 *    往提示词里塞技能内容也能"work"，但那是两套真相。
 *
 * **② 元数据必须用解析器判定，不能用词法扫描**（FR-CLI-22）
 *    `"name": x` 与没有值的 `name:` 在词法眼里都算"没名字"，于是会被注入
 *    第二个 `name`——而**重复键会让严格 YAML 加载器直接拒掉整个技能文件**。
 *    这个 bug 的表现是"技能静默不生效"，极难查。
 *
 * **③ 重建 frontmatter 时必须保留其他键**（FR-CLI-21）
 *    特别是作者用来**把技能藏起来**的那个键（Claude Code 的
 *    `disable-model-invocation`）。丢了它等于把作者刻意隐藏的东西重新暴露
 *    给模型——这是个静默的行为变更，不是格式问题。
 */

/** 单个技能的大小上限（FR-CLI-25）。 */
export const MAX_SKILL_BYTES = 256 * 1024

export interface SkillFileInput {
  /** 目标目录名——**这是权威名**（FR-CLI-20）。 */
  slug: string
  /** `SKILL.md` 原文（可含 frontmatter）。 */
  content: string
  /** 支持文件：相对路径 → 内容。 */
  files?: Record<string, string>
}

export interface NormalizedSkill {
  slug: string
  content: string
  /**
   * 规范化做了什么。
   *
   * 不是装饰：注入类定制的典型失效形态是"文件写下去了，但没人读"（FR-CLI-40），
   * 所以每一步改动都要留下可核对的痕迹。
   */
  notes: string[]
}

export class SkillTooLargeError extends Error {
  constructor(slug: string, bytes: number) {
    super(`技能 ${slug} 有 ${bytes} 字节，超过上限 ${MAX_SKILL_BYTES}`)
    this.name = 'SkillTooLargeError'
  }
}

const FRONTMATTER_DELIMITER = '---'

/** 把内容拆成 frontmatter 原文与正文。没有 frontmatter 时前者为 null。 */
export function splitFrontmatter(content: string): { frontmatter: string | null; body: string } {
  const normalized = content.startsWith('\ufeff') ? content.slice(1) : content
  if (!normalized.startsWith(FRONTMATTER_DELIMITER)) {
    return { frontmatter: null, body: normalized }
  }

  const rest = normalized.slice(FRONTMATTER_DELIMITER.length)
  const lines = rest.split('\n')

  // 第一行可能还带着换行前的空白
  const startOffset = lines[0]?.trim() === '' ? 1 : 0
  for (let i = startOffset; i < lines.length; i++) {
    if (lines[i]!.trim() === FRONTMATTER_DELIMITER) {
      const frontmatter = lines.slice(startOffset, i).join('\n')
      const body = lines.slice(i + 1).join('\n')
      return { frontmatter, body }
    }
  }

  // 有开始无结束：当作没有 frontmatter，整段都是正文。
  // 这与"半个块"的处理同源（FR-CLI-28）——不能因为畸形就丢掉内容。
  return { frontmatter: null, body: normalized }
}

/**
 * 规范化技能元数据。
 *
 * 处理三种残缺：
 *   - 缺 name      → 注入 slug 作为 name
 *   - name 与 slug 不一致 → **以 slug 为准**改写
 *   - YAML 损坏    → 重建（但保留能从原文抢救出的键难做到，故只保留正文）
 */
export function normalizeSkillFrontmatter(slug: string, content: string): NormalizedSkill {
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > MAX_SKILL_BYTES) throw new SkillTooLargeError(slug, bytes)

  const notes: string[] = []
  const { frontmatter, body } = splitFrontmatter(content)

  if (frontmatter === null) {
    // 没有 frontmatter：注入一个最小的
    const rebuilt = buildFrontmatter({ name: slug }, body)
    notes.push('原文没有 frontmatter，已注入最小元数据')
    return { slug, content: rebuilt, notes }
  }

  let parsed: unknown
  try {
    parsed = parseYaml(frontmatter)
  } catch {
    // YAML 损坏：重建。有的加载器会硬拒整个技能文件，重建至少让它能读到正文。
    notes.push('frontmatter 无法解析，已重建（仅保留正文）')
    return { slug, content: buildFrontmatter({ name: slug }, body), notes }
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    notes.push('frontmatter 不是键值对象，已重建')
    return { slug, content: buildFrontmatter({ name: slug }, body), notes }
  }

  const meta = { ...(parsed as Record<string, unknown>) }
  const authorName = meta['name']

  if (authorName === undefined || authorName === null || String(authorName).trim() === '') {
    meta['name'] = slug
    notes.push(`缺少 name，已注入 slug（${slug}）`)
  } else if (String(authorName) !== slug) {
    // ★ 以 slug 为权威名：同名不同源的技能必须可区分，而只有 slug 有唯一性保证
    meta['name'] = slug
    notes.push(`作者填的名字（${String(authorName)}）与 slug 不一致，已按 slug 改写`)
  }

  return { slug, content: buildFrontmatter(meta, body), notes }
}

function buildFrontmatter(meta: Record<string, unknown>, body: string): string {
  const yamlText = stringifyYaml(meta).trimEnd()
  const trimmedBody = body.replace(/^\n+/, '')
  return `${FRONTMATTER_DELIMITER}\n${yamlText}\n${FRONTMATTER_DELIMITER}\n\n${trimmedBody}`
}

/**
 * 把一个技能写到工作目录里。
 *
 * 只写 `SKILL.md`（M1 不做支持文件；支持文件的哈希与增量拉取属后续）。
 */
export async function writeSkill(
  workDir: string,
  skillDir: string,
  skill: SkillFileInput,
): Promise<NormalizedSkill> {
  const normalized = normalizeSkillFrontmatter(skill.slug, skill.content)
  const targetDir = join(workDir, skillDir, normalized.slug)

  await mkdir(targetDir, { recursive: true })
  await writeFile(join(targetDir, 'SKILL.md'), normalized.content, 'utf8')

  for (const [relative, content] of Object.entries(skill.files ?? {})) {
    // 防目录穿越：支持文件的相对路径不能跑出技能目录
    if (relative.includes('..') || relative.startsWith('/')) {
      throw new Error(`技能 ${skill.slug} 的支持文件路径不合法：${relative}`)
    }
    const target = join(targetDir, relative)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
  }

  return normalized
}

/**
 * 清理本 run 注入的技能目录。
 *
 * 只删**我们创建的**那些技能目录（FR-CLI-16：清理只删自己造的东西）。
 * 使用者自己放在 `.claude/skills` 里的技能**不能动**——那是他的环境。
 */
export async function removeInjectedSkills(
  workDir: string,
  skillDir: string,
  slugs: readonly string[],
): Promise<void> {
  for (const slug of slugs) {
    if (slug.includes('/') || slug.includes('..')) continue // 防御：不接受路径
    await rm(join(workDir, skillDir, slug), { recursive: true, force: true })
  }
}

/** 技能在 CLI 原生目录下的相对路径——用于诊断与日志。 */
export function skillPath(skillDir: string, slug: string): string {
  return join(skillDir, slug, 'SKILL.md')
}
