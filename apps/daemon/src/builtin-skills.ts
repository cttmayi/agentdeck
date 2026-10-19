/**
 * 平台内置技能（2026-10-19 四轮）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么会有"内置技能"这个东西
 * ══════════════════════════════════════════════════════════════════
 *
 * 沉淀的起草质量取决于"怎么写一个好的 skill"这套知识。四轮之前它写在
 * `crystallize.ts` 的 `buildDraftPrompt` 里——一段散文：改一个字要发版、没法迭代、
 * 也无法让 agent 按需加载（progressive disclosure：先看描述，需要时再读细节）。
 *
 * 所以把它写成一个**真的 skill**，随代码走：
 *
 *   · 目录：`apps/daemon/assets/builtin-skills/<slug>/`（`SKILL.md` + `references/`）
 *   · 位置：**不进 store、不进使用者技能列表**——它不是使用者的东西，也不能被删除或
 *     覆盖（删了沉淀就写不出好东西，而使用者看不出为什么）。
 *   · 注入：起草 run 的 `skills: [writing-skills]`。executor 会把它写成工作目录里的
 *     `.claude/skills/<slug>/`（`syncInjectedSkills`），agent 用自己那套技能发现机制
 *     加载——和普通技能完全同一条路，**零新机制**。
 *
 * 读盘时机：每次调用现读（4 个小文件，几毫秒）。不做缓存——缓存会让"改了内置技能
 * 但行为没变"这种最难查的问题出现一次。打包分发时 assets 与源码同目录，`import.meta.url`
 * 拿到的是源码位置，所以这条在开发与单文件产物下都成立。
 */
import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SkillPayload } from '@agentdeck/protocol'

/** 内置技能所在目录（源码旁边，随仓库走）。 */
const BUILTIN_ROOT = fileURLToPath(new URL('../assets/builtin-skills/', import.meta.url))

/** 内置技能的 slug（沉淀起草用这一个）。 */
export const WRITING_SKILLS = 'writing-skills'

/** 递归收集目录下的文本文件（跳过隐藏文件与 `.git`）。 */
async function collectFiles(dir: string, prefix = ''): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      Object.assign(out, await collectFiles(full, rel))
    } else if (entry.isFile()) {
      out[rel] = await readFile(full, 'utf8')
    }
  }
  return out
}

/** 从 SKILL.md 的 frontmatter 里取 name / description（与入库同一套极简解析）。 */
function parseFrontmatter(text: string): { name: string; description: string; body: string } {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith('---')) return { name: '', description: '', body: text }
  const end = trimmed.indexOf('\n---', 3)
  if (end < 0) return { name: '', description: '', body: text }
  const head = trimmed.slice(3, end)
  let name = ''
  let description = ''
  for (const line of head.split('\n')) {
    const mName = line.match(/^name\s*:\s*(.+)$/)
    if (mName?.[1]) name = mName[1].trim()
    const mDesc = line.match(/^description\s*:\s*(.+)$/)
    if (mDesc?.[1]) description = mDesc[1].trim()
  }
  return { name, description, body: trimmed.slice(end + 4) }
}

/**
 * 读一个内置技能，转成 `executor.submit` 要的 `SkillPayload` 形状。
 *
 * `ref.id` 用 `builtin:<slug>`：它不是 store 里的记录（没有 ULID），但下游只拿它做
 * 日志与去重标识，不查库。
 */
export async function loadBuiltinSkill(slug: string): Promise<SkillPayload | null> {
  const dir = join(BUILTIN_ROOT, slug)
  const files = await collectFiles(dir)
  const skillMd = files['SKILL.md']
  if (skillMd === undefined) return null
  const parsed = parseFrontmatter(skillMd)
  const others = { ...files }
  delete others['SKILL.md']
  return {
    ref: { id: `builtin:${slug}` as never, slug, source: 'local' },
    slug,
    name: parsed.name === '' ? slug : parsed.name,
    ...(parsed.description === '' ? {} : { description: parsed.description }),
    body: skillMd,
    files: others,
  }
}

/** 内置技能的目录（报错信息与调试时能看到真实位置）。 */
export function builtinSkillsRoot(): string {
  return BUILTIN_ROOT
}

/** 目录名（测试里判断"内置技能真的被读到了"用）。 */
export function builtinSkillDirName(slug: string): string {
  return basename(join(BUILTIN_ROOT, slug))
}
