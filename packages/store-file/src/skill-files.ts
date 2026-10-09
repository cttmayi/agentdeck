import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import type { Skill } from '@agentdeck/protocol'
import { ensureDir, removeQuietly, writeFile } from './fs-utils.ts'

/**
 * 技能内容的**磁盘落点**：`<skillsRoot>/<slug>/`。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么内容不留在 `skill.jsonl` 里
 * ══════════════════════════════════════════════════════════════════
 *
 * 原来是整条记录（正文 + 支持文件）都写进 `log/skill.jsonl`——装进来的技能
 * 在磁盘上没有单独的文件，使用者想看一眼 SKILL.md 只能去翻日志。2026-10 改成：
 *
 *   · **内容**（`SKILL.md` 正文 + 支持文件）落在 `<skillsRoot>/<slug>/`，是**权威**；
 *   · **索引 / 元数据**（id / slug / 来源 / 版本 / 时间）留在 `skill.jsonl`。
 *
 * 「权威」是字面意思：**改这里的文件就生效**——读回时磁盘赢，记录里不再有正文。
 * 代价是正文改动不进 append-only 日志（改文件不会留历史），这是刻意的取舍。
 *
 * ⚠️ **没有例外**（2026-10）：早前 `localdir:` 那类（从 `~/.claude/skills` 这种
 * 目录读进来的技能）不复制到这儿——它们的正文以文件存在于源目录。本地技能目录
 * 改成"显式安装"之后，那一类不存在了：**凡是装进来的，正文一律落在这里**。
 */

/** 读回来的技能内容。 */
export interface SkillContent {
  /** `SKILL.md` 正文。 */
  body: string
  /** 支持文件：相对路径（POSIX 风格）→ 内容。**不含** `SKILL.md`。 */
  files: Record<string, string>
}

/** 一个技能的目录：`<root>/<slug>`。slug 已由取包规则收敛成安全的目录名。 */
export function skillDir(root: string, slug: string): string {
  return join(root, slug)
}

/**
 * 支持文件的相对路径必须待在技能目录里。
 *
 * 与注入侧（`agent-core` 的 `writeSkill`）同一道防线，但**多挡两种 Windows 形态**：
 * 绝对路径除了 `/` 开头还有 `\` 开头与盘符（`C:`）开头——内容也可能来自
 * 导入的备份，那是任意的 JSON，不能只按 POSIX 判。
 */
function assertSafeRelative(rel: string, slug: string): void {
  const bad =
    rel === '' ||
    rel === 'SKILL.md' ||
    rel.includes('..') ||
    rel.startsWith('/') ||
    rel.startsWith('\\') ||
    /^[A-Za-z]:/.test(rel)
  if (bad) throw new Error(`技能 ${slug} 的支持文件路径不合法：${rel}`)
}

/**
 * 把技能内容写到磁盘。**先清空旧目录再写**。
 *
 * 为什么先清空：覆盖安装时，上一版有、这一版没有的支持文件必须消失——
 * 否则盘上留着幽灵文件，而「磁盘为准」下它们会被当成这个技能的一部分
 * （下一次注入时又被写进工作目录）。
 */
export async function writeSkillFiles(root: string, skill: Skill): Promise<void> {
  const dir = skillDir(root, skill.slug)
  await removeQuietly(dir)
  await ensureDir(dir)
  await writeFile(join(dir, 'SKILL.md'), skill.body, 'utf8')
  for (const [rel, content] of Object.entries(skill.files ?? {})) {
    assertSafeRelative(rel, skill.slug)
    const target = join(dir, rel)
    await ensureDir(dirname(target))
    await writeFile(target, content, 'utf8')
  }
}

/**
 * 读回技能内容。**目录或 `SKILL.md` 缺失 ⇒ `null`**（调用方据此判断技能坏了）。
 *
 * 支持文件是**递归读**的：磁盘为准意味着使用者可能往里加文件，读的时候
 * 要按磁盘上实际有什么来。`SKILL.md` 单独作为正文，不进 `files`。
 */
export async function readSkillContent(root: string, slug: string): Promise<SkillContent | null> {
  const dir = skillDir(root, slug)
  let body: string
  try {
    body = await readFile(join(dir, 'SKILL.md'), 'utf8')
  } catch {
    return null
  }
  const files: Record<string, string> = {}
  await collectFiles(dir, dir, files)
  return { body, files }
}

async function collectFiles(
  dir: string,
  base: string,
  out: Record<string, string>,
): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectFiles(full, base, out)
      continue
    }
    if (!entry.isFile()) continue
    const rel = relative(base, full).split(sep).join('/')
    if (rel === 'SKILL.md') continue
    out[rel] = await readFile(full, 'utf8')
  }
}

/** 删掉一个技能的磁盘目录（`rm -rf`；不存在是空转，不报错）。 */
export async function removeSkillFiles(root: string, slug: string): Promise<void> {
  await removeQuietly(skillDir(root, slug))
}
