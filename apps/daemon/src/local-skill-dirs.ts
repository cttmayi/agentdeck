import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { ulid, type Skill, type WorkspaceId } from '@agentdeck/protocol'
import { extractSkillMeta } from '@agentdeck/agent-core'
import { resolveLocalPath, type ResolvedSkillSource } from '@agentdeck/skill-source'

/**
 * 「本地技能目录」：把**别的 AI 工具**那儿的 skill 读进来，让它们出现在
 * 技能库里、并能挂给智能体。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么是"读进来"，而不是"让 skill 指着磁盘"
 * ══════════════════════════════════════════════════════════════════
 *
 * `Agent.skillIds` 存的是**技能库里的 id**，写入口会校验"这个 id 真的存在"，
 * 而注入时也是从库里取正文写进工作目录。所以"能被智能体选中"只有两条路：
 *
 *   ① 把这些 skill **读进技能库**（复用现成的挂载 / 注入 / 求解链路）；
 *   ② 让 `skillIds` 同时能指磁盘路径（要动协议、写入口校验、注入三处，
 *      而且 `skillIds` 会变成"两种 id 混在一起"，谁也说不清哪个是哪个）。
 *
 * 选 ①。代价是库里有了一份副本——所以**对账必须是"磁盘为准"**：每次读列表
 * 都按这些目录重新对一遍，磁盘上改了这边就跟着改（见 `reconcileLocalSkillDirs`）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 三条硬规矩
 * ══════════════════════════════════════════════════════════════════
 *
 * 1. **只认 `<某目录>/SKILL.md` 这个形状**（含一层分组目录，见下）。没有
 *    SKILL.md 的目录**不是技能**——这是全项目同一条规矩（`skill-source.ts`），
 *    这里不另立一套；
 * 2. **只动自己写进去的记录**：靠 `sourceRef` 前缀 `localdir:` 认领。使用者
 *    自己从路径装进来的（`path:`）与远端装进来的（`remote:`）一律不碰——
 *    "对账"顺手删掉别人的东西，是最难查的那种事故；
 * 3. **内容没变就不写库**。技能库是 append-only 的 JSONL：每次读列表都重写
 *    一遍所有记录，日志会以"每次翻页一条"的速度长起来。所以先比内容，
 *    真变了才写。
 */

/** 认领标记：只有 `sourceRef` 以此开头的记录才归本模块管。 */
export const LOCAL_DIR_SOURCE_PREFIX = 'localdir:'

/** 扫描时跳过的目录名（版本库 / 依赖目录，不是技能内容）。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.github', '__pycache__', '.venv', 'venv'])

/**
 * 一个目录往下找几层。
 *
 * ⚠️ 这一层是**必须的**，不是保险：`~/.codex/skills` 底下不是
 * `<slug>/SKILL.md`，而是 `.system/<slug>/SKILL.md`（实测）。claude 与 cursor
 * 是扁平的 `<slug>/SKILL.md`。所以按"往下找 SKILL.md、用**它所在目录**的名字
 * 当 slug"来做，两种形状一起认。
 *
 * 再深就不认了：技能目录里也能有子目录（`references/`、`scripts/`），
 * 无限往下找会把技能**内部**的文件当成一个技能。
 */
const MAX_DEPTH = 2

/** 一次最多认几个技能——防一个塞满东西的目录把界面拖死。 */
const MAX_SKILLS = 200

/**
 * 内置候选目录：这台机器上"别的 AI 工具把 skill 放哪儿"。
 *
 * ★ 这里只给**路径与 id**，中文名/英文名在界面词表里（`skills.dirTool*`）——
 *   daemon 的字符串是不翻译的，把界面文案放在这里等于让它只有一种语言。
 *
 * ⚠️ 这份表是**用户级**目录（`~/.claude/skills` 这种）。运行时表里那个
 *   `.claude/skills` 是**工作目录级**的，是平台自己往里注入技能的地方——
 *   把那个当来源读进来，会把我们刚写下去的东西又当成"使用者的技能"收一遍。
 */
export interface LocalSkillDirCandidate {
  /** 稳定 id（界面据此取显示名）。 */
  id: string
  /** 展开 `~` 之后的绝对路径——勾选状态按**字符串相等**匹配，所以必须唯一形态。 */
  path: string
}

export function localSkillDirCandidates(home: string = homedir()): LocalSkillDirCandidate[] {
  return [
    { id: 'claude', path: join(home, '.claude', 'skills') },
    { id: 'codex', path: join(home, '.codex', 'skills') },
    { id: 'cursor', path: join(home, '.cursor', 'skills') },
    { id: 'agents', path: join(home, '.agents', 'skills') },
  ]
}

/** 展开 `~`（只认开头的 `~`、`~/`、`~\`），并收敛成绝对路径。 */
export function expandSkillDirPath(input: string, home: string = homedir()): string {
  const trimmed = input.trim()
  if (trimmed === '~') return home
  // ⚠️ `~\` 也认：Windows 使用者敲的是这个（理由同 tool-source.ts 的 expandHome）
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return join(home, trimmed.slice(2))
  return trimmed
}

/**
 * 校验一个要勾选的路径。**只校验形状**（绝对路径），不要求目录现在就存在：
 * 目录可能还没建、或者插着的外置盘现在没挂上——那时该显示"这个目录不存在"，
 * 而不是拒绝使用者勾它。
 */
export function normalizeSkillDir(
  input: string,
  home: string = homedir(),
): { ok: true; path: string } | { ok: false; error: string } {
  const expanded = expandSkillDirPath(input, home)
  if (expanded === '') return { ok: false, error: '路径不能为空' }
  if (!isAbsolute(expanded)) {
    return {
      ok: false,
      error:
        `必须是绝对路径：${input.trim()}。相对路径取决于 daemon 是从哪个目录启动的，` +
        '同一个路径可能指向完全不同的地方。',
    }
  }
  return { ok: true, path: resolve(expanded) }
}

/** 一个目录里找到的东西。 */
export interface ScannedSkillDir {
  /** 技能目录的绝对路径。 */
  dir: string
  /** 目录名（`resolveLocalPath` 会据此派生 slug，这里只用于报告）。 */
  name: string
  /** 相对被勾选的那个根目录的路径（`.system/skill-creator` 这种）。 */
  rel: string
  /** 往下第几层（0 = 根目录的直接子目录）。 */
  depth: number
}

export interface ScanResult {
  /** 找到的技能目录。 */
  found: ScannedSkillDir[]
  /**
   * 看到但**没当成技能**的目录：没有 SKILL.md，或者太深。
   *
   * ★ 必须如实报出来。使用者勾了 `~/.claude/skills`，那里有一个
   *   `baoyu-markdown-to-html/` 空目录（实测）——不说的话，他会以为
   *   "我勾了，怎么少了一个"，然后去查是不是权限问题。
   */
  skipped: Array<{ rel: string; reason: string }>
  /** 根目录本身读不了（不存在 / 没权限）。null = 读到了。 */
  error: string | null
}

/**
 * 扫一个根目录，找出里面所有的技能目录。
 *
 * 只读目录结构，不读文件内容——内容交给 `resolveLocalPath`（那一关有大小、
 * 二进制、符号链接的规矩，不该在这里再写一遍）。
 */
export async function scanSkillDir(root: string, maxDepth = MAX_DEPTH): Promise<ScanResult> {
  const found: ScannedSkillDir[] = []
  const skipped: ScanResult['skipped'] = []

  try {
    const info = await stat(root)
    if (!info.isDirectory()) return { found, skipped, error: `不是目录：${root}` }
  } catch {
    return { found, skipped, error: `目录不存在或读不了：${root}` }
  }

  /**
   * `depth` = 相对根目录**往下第几层**（根目录的直接子目录是第 1 层）。
   *
   * ⚠️ 这个"第几层"的定义决定 `.system/<slug>` 认不认得出——根目录是 0 层，
   *    `.system` 是 1 层，`.system/skill-creator` 是 2 层。所以上限必须是
   *    "能走到第 2 层"，写成 `depth + 1 >= maxDepth` 那种写法会把它切掉
   *    （本模块的第一版就是这么错的，测试当场抓住）。
   */
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      skipped.push({ rel: rel === '' ? '.' : rel, reason: '目录读不了（权限？）' })
      return
    }

    // 先看这一层有没有 SKILL.md——**有就是技能，不再往下找**（技能内部的
    // `references/`、`scripts/` 里再出现 SKILL.md 也不该被当成第二个技能）
    const hasSkillMd = entries.some((e) => e.isFile() && e.name === 'SKILL.md')
    if (hasSkillMd && depth >= 1) {
      found.push({ dir, name: rel.split('/').pop() ?? rel, rel, depth })
      return
    }

    if (depth >= maxDepth) return

    for (const entry of entries) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      // ★ 符号链接一律不跟随（与 `skill-source.ts` 同一条规矩：既可能指到技能
      //   目录外面，也可能成环）——但**必须说出来**。
      //
      //   实测 `~/.claude/skills` 里就有一个 `baoyu-markdown-to-html` 是指向
      //   `~/.agents/skills/…` 的符号链接。静默跳过的话，界面上写"里面 1 个
      //   skill"而使用者的 Finder 里明明看着两个——他会去查权限、查扫描是不是
      //   坏了，而真正的原因（"那是个链接，我没跟"）一个字都没说。
      //
      //   ⚠️ `isSymbolicLink()` 必须**排在 `isDirectory()` 前面**：`readdir` 给的
      //      dirent 对"指向目录的链接"是 `isDirectory() === false`，所以原来那句
      //      `if (!entry.isDirectory()) continue` 会先把链接吃掉，后面那句
      //      `isSymbolicLink()` 是**永远到不了的死代码**。
      if (entry.isSymbolicLink()) {
        skipped.push({ rel: childRel, reason: '符号链接，未跟随' })
        continue
      }
      if (!entry.isDirectory()) continue
      if (SKIP_DIRS.has(entry.name)) {
        skipped.push({ rel: childRel, reason: '版本库/依赖目录，不属于技能内容' })
        continue
      }
      const before = found.length
      await walk(join(dir, entry.name), childRel, depth + 1)
      // ★ 根目录的**直接子目录**里一个技能都没找到 ⇒ 如实说出来。
      //
      //   使用者勾了 `~/.claude/skills`，那儿有一个空目录
      //   `baoyu-markdown-to-html/`（实测）——不说的话他会以为"我勾了，怎么
      //   少了一个"，然后去查权限、查是不是扫描坏了。`found` 没长就说明这棵
      //   子树里没有技能目录，不需要再单独判"有没有 SKILL.md"。
      //
      //   只报**第 1 层**：更深的目录里没技能是常态（`references/`、`scripts/`），
      //   全报出来会把真正要看的那几条淹掉。
      if (depth === 0 && found.length === before) {
        skipped.push({ rel: childRel, reason: '这里没有 SKILL.md，所以它不是技能' })
      }
    }
  }

  await walk(root, '', 0)
  found.sort((a, b) => a.rel.localeCompare(b.rel))
  return { found: found.slice(0, MAX_SKILLS), skipped, error: null }
}

// ─────────────────────────────────────────────────────────────
// 对账
// ─────────────────────────────────────────────────────────────

export interface LocalDirSkillView {
  /** 这条记录来自哪个被勾选的目录；null = 不是这么来的（手装/远端）。 */
  sourceDir: string | null
  /** 这个来源目录**现在**还被勾着吗。 */
  dirEnabled: boolean
  /** 现在真的还在磁盘上（且来源目录勾着）。 */
  onDisk: boolean
}

export interface ReconcileReport {
  /** 新读进来的。 */
  added: string[]
  /** 内容变了、已更新的。 */
  updated: string[]
  /** 磁盘上没了、也没人挂着，已从库里删掉的。 */
  removed: string[]
  /**
   * 磁盘上没了（或来源目录取消了勾选），**但有智能体还挂着**，所以留着的。
   *
   * ★ 这是使用者明确要的行为（原话：「勾选仅仅表示可以被选择的时候看见。
   *   智能体已经被使用的 skill 不会移除」）。留着不是偷懒：把它删掉等于
   *   从人家身上悄悄抽走一条正在生效的能力，而症状在很久以后才出现。
   */
  keptBecauseUsed: Array<{ slug: string; dir: string; usedBy: string[] }>
  /** 读不进来的（太大、二进制文件、清单不合规…），逐条说明。 */
  failed: Array<{ rel: string; reason: string }>
  /** 扫描阶段看到但没当成技能的东西。 */
  skipped: Array<{ dir: string; rel: string; reason: string }>
  /** 读不了的目录。 */
  dirErrors: Array<{ dir: string; reason: string }>
  /**
   * **现在真的在磁盘上**的那些（被勾选的目录里、这一刻扫到的）。
   *
   * 调用方靠它算"这条记录还活跃吗"——列表上要据此标出
   * 「来源目录已取消勾选 / 文件已移走，但还有智能体在用」。
   * 光看 `sourceRef` 判断不了这件事：那条记录可能还在、而文件已经没了。
   */
  onDisk: Array<{ dir: string; slug: string }>
}

/** 一条记录的来源目录（`localdir:<path>`）；不是这么来的就返回 null。 */
export function sourceDirOf(skill: Skill): string | null {
  const ref = skill.sourceRef ?? ''
  return ref.startsWith(LOCAL_DIR_SOURCE_PREFIX) ? ref.slice(LOCAL_DIR_SOURCE_PREFIX.length) : null
}

/**
 * 按勾选的目录对账技能库。**磁盘为准。**
 *
 * 逐条规则：
 *
 *   · 磁盘上有、库里没有 ⇒ 插进来（新 id）；
 *   · 两边都有，内容**不一样** ⇒ 更新，**id 与 createdAt 不变**——id 一变，
 *     挂着它的智能体就指着一条不存在的记录，表现是"这个 skill 悄悄没了"；
 *   · 两边都有，内容一样 ⇒ **一个字都不写**（append-only 日志，见文件头）；
 *   · 磁盘上没了、库里还有（来源目录取消勾选，或者文件在源工具那边被删了）⇒
 *     没人挂着就删掉；**有人挂着就留着**，并在报告里说清是谁。
 *
 * `enabledDirs` 之外的目录，它名下的记录走最后那条规则——这就是"取消勾选"
 * 的全部含义：**不再出现在可选项里**，而不是把正在用的能力抽走。
 */
export async function reconcileLocalSkillDirs(input: {
  store: {
    listSkills(workspaceId: WorkspaceId): Promise<Skill[]>
    listAgents(workspaceId: WorkspaceId): Promise<Array<{ id: string; name: string; skillIds: readonly string[] }>>
    insertSkill(skill: Skill): Promise<void>
    deleteSkill(id: Skill['id']): Promise<boolean>
  }
  workspaceId: WorkspaceId
  enabledDirs: readonly string[]
  now: number
}): Promise<ReconcileReport> {
  const { store, workspaceId, enabledDirs, now } = input
  const report: ReconcileReport = {
    added: [],
    updated: [],
    removed: [],
    keptBecauseUsed: [],
    failed: [],
    skipped: [],
    dirErrors: [],
    onDisk: [],
  }

  const existing = await store.listSkills(workspaceId)
  const agents = await store.listAgents(workspaceId)
  const usedBy = new Map<string, string[]>()
  for (const agent of agents) {
    for (const id of agent.skillIds) {
      const list = usedBy.get(id as string) ?? []
      list.push(agent.name)
      usedBy.set(id as string, list)
    }
  }

  // ── ① 扫磁盘、把每一条算成"库里应该长什么样" ──
  /** key = `${dir}\u0000${slug}` —— 同 slug 在不同来源目录里是两条不同的记录。 */
  const wanted = new Map<string, { dir: string; skill: ResolvedSkillSource }>()

  for (const dir of enabledDirs) {
    const scan = await scanSkillDir(dir)
    if (scan.error !== null) {
      report.dirErrors.push({ dir, reason: scan.error })
      continue
    }
    for (const item of scan.skipped) report.skipped.push({ dir, ...item })

    for (const candidate of scan.found) {
      let resolved: ResolvedSkillSource
      try {
        resolved = await resolveLocalPath(candidate.dir)
      } catch (err) {
        // 读不进来（太大 / 有二进制文件 / 清单不合规）⇒ **如实报**，不静默跳过：
        // "勾了却少一个"必须能追到原因
        report.failed.push({
          rel: `${dir}/${candidate.rel}`,
          reason: err instanceof Error ? err.message : String(err),
        })
        continue
      }
      wanted.set(`${dir}\u0000${resolved.slug}`, { dir, skill: resolved })
    }
  }

  // ── ② 库里属于本模块的记录：逐条对 ──
  const localRecords = existing.filter((s) => sourceDirOf(s) !== null)
  const seen = new Set<string>()

  for (const record of localRecords) {
    const dir = sourceDirOf(record)!
    const key = `${dir}\u0000${record.slug}`
    const target = wanted.get(key)

    if (target === undefined) {
      // 磁盘上没了（或这个目录不再勾选）
      const holders = usedBy.get(record.id as string) ?? []
      if (holders.length > 0) {
        report.keptBecauseUsed.push({ slug: record.slug, dir, usedBy: holders })
      } else {
        await store.deleteSkill(record.id)
        report.removed.push(record.slug)
      }
      seen.add(key)
      continue
    }

    seen.add(key)
    const next = buildRecord(target.skill, dir, record, workspaceId, now)
    if (sameContent(record, next)) continue
    await store.insertSkill(next)
    report.updated.push(record.slug)
  }

  // ── ③ 磁盘上有、库里没有的：插进来 ──
  for (const [key, target] of wanted) {
    if (seen.has(key)) continue
    // ⚠️ 同 slug 但**来源不同**（手装的 `path:` / 远端的 `remote:`）不抢：
    //    两条记录同 slug 会同时存在，而 `loadAgentSkills` 只会取到其中一条。
    //    这是"同名一律拒绝写入"那条老规矩的同一件事，所以记进 failed 让人看见。
    const clash = existing.find((s) => s.slug === target.skill.slug && sourceDirOf(s) === null)
    if (clash) {
      report.failed.push({
        rel: `${target.dir}/${target.skill.slug}`,
        reason:
          `技能库里已经有一个同名的 skill「${target.skill.slug}」` +
          `（来源：${clash.source === 'local' ? '本地自有' : '远端'}${clash.sourceRef ? ` ${clash.sourceRef}` : ''}）。` +
          '同名两条会同时存在，而挂载时只会取到其中一条——所以这一条没有读进来。' +
          '要它的话，先卸载库里那条同名的。',
      })
      continue
    }
    const record = buildRecord(target.skill, target.dir, null, workspaceId, now)
    await store.insertSkill(record)
    report.added.push(record.slug)
  }

  report.onDisk = [...wanted.values()].map((w) => ({ dir: w.dir, slug: w.skill.slug }))
  return report
}

/** 把解析好的来源变成一条库记录。`previous` 给了就**复用 id 与 createdAt**。 */
function buildRecord(
  resolved: ResolvedSkillSource,
  dir: string,
  previous: Skill | null,
  workspaceId: WorkspaceId,
  now: number,
): Skill {
  return {
    id: (previous?.id ?? (ulid() as Skill['id'])) as Skill['id'],
    workspaceId,
    slug: resolved.slug,
    // ★ 显示名以 slug 为权威（同名不同源必须可区分），但**作者在 frontmatter
    //   里写的 description 要落库**——没有它，列表里永远是"没有说明"，
    //   而作者明明写了一句。
    name: resolved.slug,
    description: extractSkillMeta(resolved.body).description ?? null,
    // 用**解析过的**正文与支持文件，不是原始入参：规范化（frontmatter 补齐、
    // name 与 slug 对齐）在 `resolveLocalPath` 那边已经做过了
    body: resolved.body,
    ...(Object.keys(resolved.files).length > 0 ? { files: resolved.files } : {}),
    verdictSchemaVersion: previous?.verdictSchemaVersion ?? 1,
    source: 'local',
    sourceRef: `${LOCAL_DIR_SOURCE_PREFIX}${dir}`,
    version: null,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  }
}

/**
 * 两条记录的内容一样吗（**只看会变的那几样**）。
 *
 * ⚠️ 这里决定"要不要写库"，而技能库是 append-only 的：判错成"不一样"会让
 * 日志每读一次列表就长一条，判错成"一样"会让磁盘上的改动不生效。所以
 * `updatedAt` **不参与比较**（它每次都不同），比的是正文与支持文件。
 */
function sameContent(a: Skill, b: Skill): boolean {
  if (a.body !== b.body) return false
  if (a.sourceRef !== b.sourceRef) return false
  const fa = a.files ?? {}
  const fb = b.files ?? {}
  const ka = Object.keys(fa).sort()
  const kb = Object.keys(fb).sort()
  if (ka.length !== kb.length) return false
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false
    if (fa[ka[i]!] !== fb[kb[i]!]) return false
  }
  return true
}
