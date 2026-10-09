import { mkdir, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises'
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
  /**
   * 一句话用途说明——**写进 frontmatter 的 `description`**。
   *
   * 见 `SkillPayload.description` 的说明：CLI 自己的技能清单是描述驱动的，
   * 而我们的上下文只列 slug，所以这里是唯一的用途信号。作者已经在
   * frontmatter 里写了 `description` 时不覆盖（那是他的选择）。
   */
  description?: string
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
 * 只读地取出 SKILL.md frontmatter 里的元数据。
 *
 * 与 `normalizeSkillFrontmatter` 的区别：**不改写、不注入**，只把作者写了
 * 的 `name` / `description` 原样拿出来。用途：安装/扫描落库时把作者写的
 * `description` 一并存进 `Skill.description`——否则界面列表里永远只有
 * "没有说明"，而作者明明在 frontmatter 里写了一句。
 *
 * `name` 只在这里**不权威**：列表显示名仍以 slug 为准（同名不同源的技能
 * 必须可区分，见 `normalizeSkillFrontmatter` 的注释），所以它只是顺手
 * 带出来，调用方要用才用。
 *
 * frontmatter 缺失或 YAML 损坏时返回 `{}`（不抛）：作者没写不是异常，
 * 那正是"没有 description"的正当来源。
 */
export function extractSkillMeta(
  content: string,
): { name?: string; description?: string | null } {
  const { frontmatter } = splitFrontmatter(content)
  if (frontmatter === null) return {}
  let parsed: unknown
  try {
    parsed = parseYaml(frontmatter)
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const meta = parsed as Record<string, unknown>
  const name = typeof meta['name'] === 'string' && meta['name'].trim() !== '' ? meta['name'].trim() : undefined
  const description =
    typeof meta['description'] === 'string' && meta['description'].trim() !== ''
      ? meta['description'].trim()
      : null
  return name === undefined && description === null ? {} : { ...(name !== undefined ? { name } : {}), ...(description !== null ? { description } : {}) }
}

/**
 * 规范化技能元数据。
 *
 * 处理三种残缺：
 *   - 缺 name      → 注入 slug 作为 name
 *   - name 与 slug 不一致 → **以 slug 为准**改写
 *   - YAML 损坏    → 重建（但保留能从原文抢救出的键难做到，故只保留正文）
 */
export function normalizeSkillFrontmatter(
  slug: string,
  content: string,
  /** 平台知道的用途说明；作者已写 `description` 时不覆盖。 */
  description?: string,
): NormalizedSkill {
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > MAX_SKILL_BYTES) throw new SkillTooLargeError(slug, bytes)

  const notes: string[] = []
  const { frontmatter, body } = splitFrontmatter(content)

  if (frontmatter === null) {
    // 没有 frontmatter：注入一个最小的（带上描述——那是 CLI 清单里唯一的
    // 用途信号，缺了它技能基本不会被主动选用）
    const rebuilt = buildFrontmatter(withDescription({ name: slug }, description), body)
    notes.push(
      '原文没有 frontmatter，已注入最小元数据' +
        (description ? '（含 description）' : '（**没有 description**：CLI 的清单里它没有用途说明）'),
    )
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

  // 作者没写 description 时补上平台知道的那句（写了就不动——那是他的表达）
  if ((meta['description'] === undefined || String(meta['description']).trim() === '') && description) {
    meta['description'] = description
    notes.push('frontmatter 缺少 description，已补上平台登记的用途说明')
  }
  // ⚠️ 这里**不**为"两边都没有 description"记 note：那会在每一次 run 上、
  //    对每一个没写描述的技能都刷一条——而它是**技能作者**的问题，不是这次
  //    运行的异常。日志里的信号要稀缺，不然真正需要注意的行会被淹掉。
  //    （缺描述的正确处置面是技能库/界面，见 `SkillPayload.description` 的说明。）

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

function withDescription(
  meta: Record<string, unknown>,
  description?: string,
): Record<string, unknown> {
  const text = description?.trim()
  return text ? { ...meta, description: text } : meta
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
  // ★ 空正文**当场失败**，绝不写出去。
  //
  //   库里本来不可能有空正文的技能（每个安装来源都拒空：`resolvePayloadEntry`
  //   与 `checkSkillMd`）。但 2026-10 之后技能正文存在磁盘上
  //   （`<skillsRoot>/<slug>/SKILL.md`），使用者手删了那个目录时，store 回填
  //   出来的正文就是空的——此时若照样写一个空 `SKILL.md` 到工作目录，就是一个
  //   **静默的坏技能**：CLI 会发现它、它却什么都没说。这里把它变成一次响亮的失败。
  if (skill.content.trim() === '') {
    throw new Error(
      `技能「${skill.slug}」的正文是空的，拒绝注入。` +
        `正文存在技能目录的 SKILL.md 里（daemon 默认落在 ~/.agentdeck/skills/<slug>/）——` +
        `如果那里被删了，请重新安装这个技能。`,
    )
  }
  const normalized = normalizeSkillFrontmatter(skill.slug, skill.content, skill.description)
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

/*
 * ⚠️ 这里原来有一个"点名删技能"的 `removeInjectedSkills`（FR-CLI-16 那条的
 *    落点），返回 void、只按调用方给的名单删。它属于"run 前写、run 后删"那一版，
 *    在"保留技能"那一版里就没有调用方了，一直挂着。
 *
 *    现在合并成一个：**同一个名字**，实现换成"以落盘清单为准"的那份
 *    （在 `syncInjectedSkills` 之后），因为按名单删意味着调用方给错名字就会
 *    删到使用者的东西。少一个函数，也少一条会漂的路径。
 */

/**
 * 归属清单：我们往这个工作目录里放过哪些技能。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么必须落盘，而不是记在内存里
 * ══════════════════════════════════════════════════════════════════
 *
 * 注入物**不再在 run 结束时删除**（见 `syncInjectedSkills` 的说明）。于是
 * "哪些目录是我们建的"变成一个需要跨进程、跨崩溃记住的事实：
 *
 *   - 记在内存里 ⇒ daemon 崩溃/被 kill 之后，那些技能文件**永久留在使用者
 *     目录里**，而且无从识别。它们会被 CLI 一并发现，于是"你摘掉的技能
 *     还在生效"——而那个技能甚至可能已经不属于这个 agent 了；
 *   - 落盘之后，下一次 run 就能对账：**清单里有、这次不需要的 ⇒ 删掉**
 *     （那是我们放的，且已经不该在）。这正是"自愈"。
 *
 * 放在技能目录**之内**、但不是一个目录，所以 CLI 的技能发现（扫
 * `<skillDir>/<name>/SKILL.md`）不会把它当成技能。
 */
export const MANAGED_MANIFEST = '.agentdeck-managed.json'

interface ManagedManifest {
  /** 我们在这个工作目录里放过的技能 slug。 */
  slugs: string[]
}

async function readManifest(dir: string): Promise<string[]> {
  try {
    const raw = JSON.parse(await readFile(join(dir, MANAGED_MANIFEST), 'utf8')) as ManagedManifest
    return Array.isArray(raw.slugs) ? raw.slugs.filter((s) => typeof s === 'string') : []
  } catch {
    // 没有清单（第一次跑）或清单坏了 ⇒ 当作"我们什么都没放过"。
    // 保守方向很重要：**宁可少删**，也不能因为读不懂清单就去删使用者的东西。
    return []
  }
}

async function writeManifest(dir: string, slugs: readonly string[]): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, MANAGED_MANIFEST), JSON.stringify({ slugs }, null, 2), 'utf8')
}

export class SkillCollisionError extends Error {
  // ⚠️ 不用参数属性（`constructor(readonly slug: string)`）：本仓库开了
  //    `erasableSyntaxOnly`，那种写法需要 tsc 生成代码，被明确禁掉了。
  readonly slug: string

  constructor(slug: string) {
    super(
      `工作目录里已经有一个同名技能「${slug}」，而且它不是这个平台建的` +
        `（不在我们的归属清单里）。覆盖它等于改写你自己的文件，所以停下。` +
        `请把它改名或移走，再重跑这条任务。`,
    )
    this.name = 'SkillCollisionError'
    this.slug = slug
  }
}

export interface SyncSkillsResult {
  /** 这次写下去的技能。 */
  written: string[]
  /** 这次被删掉的（我们以前放的、现在不需要了）。 */
  pruned: string[]
  /** 规范化过程中的说明——**要进日志**，否则"文件写下去了但没人读"就查不出来。 */
  notes: Array<{ slug: string; note: string }>
}

/**
 * 让工作目录里的技能与这次要用的集合**一致**——run **开始前**那一步。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这条规则改过三次，每次都记下来，因为理由比结论重要
 * ══════════════════════════════════════════════════════════════════
 *
 * **第一版：run 前写、run 后删。** 两个后果都是坏的：
 *
 *   1. **删的依据是进程内的数组。** daemon 崩溃/被 kill 之后那份记忆就没了，
 *      残留的技能文件永久留在那里，而且**会被以后的 run 继续发现**：
 *      你把这个技能从 agent 上摘掉了，它却还在生效；
 *   2. 看不见了（当时使用者在意的正是这条）。
 *
 * **第二版：保留**，靠落盘的归属清单做对账。修掉了上面第 1 条，代价是工作
 * 目录里长期留着一堆不是 agent 产出的东西；而且审核与执行**共用一个目录**
 * 之后，两边的技能会互相摘（执行者下一次 run 的 prune 会删掉审核者的标准）。
 *
 * **第三版（现在）：跑完就删，但**删除的依据仍然是那份**落盘的**归属清单**，
 * 不是内存里的数组。** 当初让"跑完删"变危险的是第 1 条，而它已经由清单解决了：
 * 崩溃留下的残渣会被下一次 run 的同步（本函数）摘掉。所以现在可以既干净、
 * 又不留隐患。
 *
 * 使用者放弃"保留技能"那条要求的直接原因就是这个：**跑完的工作目录应该是
 * agent 的产出，不是平台的东西**。而"它是在什么标准下干活的"这件事改由别处
 * 负责（每次 run 的上下文记录里带着技能清单；审核那次还带着标准的全文）。
 *
 * 不变的三条：
 *   - 这次要的 ⇒ 写下去（覆盖我们自己上次放的）；
 *   - 清单里有、这次不要的 ⇒ 删掉（崩溃残渣、或者上次跑没清干净）；
 *   - **不在清单里的同名目录 ⇒ 报错，绝不覆盖**（那是使用者自己放的）。
 *
 * 最后一条是刻意的：`writeSkill` 原来是 `mkdir -p` + `writeFile`，会**静默
 * 改写**使用者的同名技能。宁可让这次 run 失败并说清楚。
 */
export async function syncInjectedSkills(
  workDir: string,
  skillDir: string,
  skills: readonly SkillFileInput[],
): Promise<SyncSkillsResult> {
  const dir = join(workDir, skillDir)
  const owned = new Set(await readManifest(dir))
  const wanted = skills.map((s) => s.slug)

  const written: string[] = []
  const pruned: string[] = []
  const notes: Array<{ slug: string; note: string }> = []

  // ① 先对账：我们以前放的、这次不需要的，删掉
  for (const slug of owned) {
    if (wanted.includes(slug)) continue
    if (slug.includes('/') || slug.includes('..')) continue
    await rm(join(dir, slug), { recursive: true, force: true })
    pruned.push(slug)
  }

  // ② 冲突检查：目标目录存在、但不是我们建的 ⇒ 那是使用者的东西
  const existing = new Set(
    await readdir(dir, { withFileTypes: true })
      .then((entries) => entries.filter((e) => e.isDirectory()).map((e) => e.name))
      .catch(() => [] as string[]),
  )
  for (const slug of wanted) {
    if (existing.has(slug) && !owned.has(slug)) throw new SkillCollisionError(slug)
  }

  // ③ 先记归属，再写文件。
  //
  //   ★ 顺序不能反。这两步之间崩掉时，两种残留的方向完全不同：
  //     - **先写清单**：残留是"清单里有、盘上没有" ⇒ 下一次同步 rm -rf 一个
  //       不存在的目录（force 下无害），自愈；
  //     - 先写文件：残留是"盘上有、清单里没有" ⇒ 下一次同步会把它当成
  //       **使用者的东西**，于是抛 SkillCollisionError 让 run 失败，而且
  //       永久如此（没人会去手动清一个看起来像自己放的目录）。
  await writeManifest(dir, [...new Set(wanted)].sort())

  // ④ 写下去
  for (const skill of skills) {
    const normalized = await writeSkill(workDir, skillDir, skill)
    written.push(normalized.slug)
    for (const note of normalized.notes) notes.push({ slug: normalized.slug, note })
  }

  return { written, pruned, notes }
}

export interface RemoveSkillsResult {
  /** 这次真的删掉的。 */
  removed: string[]
  /** 清单里留下来没动的（不是这次要删的）。 */
  kept: string[]
}

/**
 * run **结束后**那一步：把这次注入的技能收掉。
 *
 * ══════════════════════════════════════════════════════════════════
 * ★ 只删清单里记着的
 * ══════════════════════════════════════════════════════════════════
 *
 * 传进来的 `slugs` 只用来**收窄**范围，真正决定"能不能删"的是那份落盘的
 * 归属清单：不在清单里的目录一律不碰。所以即使调用方给错了名字（内存里的
 * 数组错了、run 记录串了），**也删不到使用者的东西**——这是这条路径上最重要
 * 的一条性质，比"删得干净"重要得多。
 *
 * 清单空了就连它一起收掉（它只在"我们放过东西"时才有意义），
 * 目录空了再顺手收掉；里面还有别人的东西时 `rmdir` 会失败，那正是我们要的。
 */
export async function removeInjectedSkills(
  workDir: string,
  skillDir: string,
  slugs: readonly string[],
): Promise<RemoveSkillsResult> {
  const dir = join(workDir, skillDir)
  const owned = await readManifest(dir)
  const target = new Set(slugs.filter((slug) => owned.includes(slug)))

  const removed: string[] = []
  for (const slug of target) {
    // 与同步那边同一道防线：这是要拼进文件系统的字符串
    if (slug.includes('/') || slug.includes('..')) continue
    await rm(join(dir, slug), { recursive: true, force: true })
    removed.push(slug)
  }

  const kept = owned.filter((slug) => !target.has(slug))
  if (kept.length === 0) {
    await rm(join(dir, MANAGED_MANIFEST), { force: true })
    await rmdir(dir).catch(() => {})
  } else {
    await writeManifest(dir, kept)
  }

  return { removed, kept }
}

/** 读到我们在某个工作目录里放过的技能 slug（诊断与测试用）。 */
export async function listManagedSkills(workDir: string, skillDir: string): Promise<string[]> {
  return readManifest(join(workDir, skillDir))
}

/** 技能在 CLI 原生目录下的相对路径——用于诊断与日志。 */
export function skillPath(skillDir: string, slug: string): string {
  return join(skillDir, slug, 'SKILL.md')
}

// ══════════════════════════════════════════════════════════════════
// ⚠️⚠️ 这里原来是**工具包注入**（D42 接线：执行者挂载的工具 → 工作目录）：
// `ToolCollisionError`、`InjectedTool`、`SyncToolsResult`、`syncInjectedTools`、
// `removeInjectedTools`、`listManagedTools`、`toolPath`。**整块删掉了。**
//
// 挂载能力撤掉之后它没有任何调用方：`Agent.toolIds` 已不在协议里，
// `PUT /api/agents/:id/tools` 已删，`executor.ts` 里那段注入也删了。它现在
// 唯一的"输入"永远是空数组——即"每次 run 都白跑一遍注入与回收"。
//
// ★ 共用的是**上面那套归属清单机制**（`MANAGED_MANIFEST` / `readManifest` /
//   `writeManifest`），技能那半仍然在用，所以机制本身留着——删掉的只有工具那半。
//
// ⚠️ 想恢复的话：除了把这半加回来，还要把 `Agent.toolIds`、
//   `PUT /api/agents/:id/tools` 和 `executor.ts` 里的注入段一起恢复。
//   那条"同名目录绝不被覆盖"的守卫（`ToolCollisionError`）当时是有测试的，
//   一并删了——恢复时要连测试一起写回来。
