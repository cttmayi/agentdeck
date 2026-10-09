import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Skill } from '@agentdeck/protocol'

/**
 * 「本地技能目录」：把**别的 AI 工具**那儿的 skill 找出来，供技能页的
 * 「从本地安装」页签**逐条安装**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么是"找出来 → 显式安装"，而不是"指着磁盘自动同步"
 * ══════════════════════════════════════════════════════════════════
 *
 * `Agent.skillIds` 存的是**技能库里的 id**，写入口会校验"这个 id 真的存在"，
 * 注入时也是从库里取正文写进工作目录。所以"能被智能体选中"只有两条路：
 *
 *   ① 把这些 skill **装进技能库**（复用现成的挂载 / 注入 / 求解链路）；
 *   ② 让 `skillIds` 同时能指磁盘路径（要动协议、写入口校验、注入三处，
 *      而且 `skillIds` 会变成"两种 id 混在一起"，谁也说不清哪个是哪个）。
 *
 * 选 ①。**2026-10 起**，① 走的是**显式安装**：本模块只负责**扫目录、把找到的
 * 技能列出来**，装不装由使用者在「从本地安装」页签里一条条点。
 *
 * ⚠️ 这里曾经是"自动对账读入"（`reconcileLocalSkillDirs`）：勾一个目录，
 *   每次读技能列表都把里面的技能自动读进库、并让库跟着磁盘走。撤掉的代价是
 *   "源目录改了不会自动生效"——换来的是**模型统一**：装进来的技能正文一律落在
 *   `~/.agentdeck/skills/<slug>/`（磁盘为准），和其它来源**一模一样**，不再有
 *   "内容藏在记录里"的特例（那正是 `FileStore` 一度要开 `externalContentPrefixes`
 *   口子的原因）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 两条硬规矩
 * ══════════════════════════════════════════════════════════════════
 *
 * 1. **只认 `<某目录>/SKILL.md` 这个形状**（含一层分组目录，见下）。没有
 *    SKILL.md 的目录**不是技能**——这是全项目同一条规矩（`skill-source.ts`），
 *    这里不另立一套；
 * 2. **扫描一律只读**：这里不写库、不落盘。装是 `POST /api/skills/install`
 *    那条路的事（它复用 `resolveLocalPath`，所以"是不是一个技能"只有一处判据）。
 */

/** 认领标记：记录 `sourceRef` 以此开头时，说明它是从本地技能目录装进来的。 */
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
 * ★ 这里只给**路径与 id**，中文名/英文名在界面词表里（`skills.dirsTool*`）——
 *   daemon 的字符串是不翻译的，把界面文案放在这里等于让它只有一种语言。
 *
 * ⚠️ 这份表是**用户级**目录（`~/.claude/skills` 这种）。运行时表里那个
 *   `.claude/skills` 是**工作目录级**的，是平台自己往里注入技能的地方——
 *   把那个当来源扫，会把我们刚写下去的东西又当成"使用者的技能"列一遍。
 */
export interface LocalSkillDirCandidate {
  /** 稳定 id（界面据此取显示名）。 */
  id: string
  /** 展开 `~` 之后的绝对路径。 */
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

/** 一个目录里找到的东西。 */
export interface ScannedSkillDir {
  /** 技能目录的绝对路径。 */
  dir: string
  /** 目录名（`resolveLocalPath` 会据此派生 slug，这里只用于报告）。 */
  name: string
  /** 相对被扫描的那个根目录的路径（`.system/skill-creator` 这种）。 */
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
   * ★ 必须如实报出来。使用者打开「从本地安装」，那里有一个 `baoyu-markdown-to-html/`
   *   空目录（实测）——不说的话，他会以为"目录里明明有，怎么少了一个"，然后去
   *   查是不是权限问题。
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
      //   使用者扫 `~/.claude/skills`，那儿有一个空目录
      //   `baoyu-markdown-to-html/`（实测）——不说的话他会以为"这里明明有，
      //   怎么少了一个"，然后去查权限、查是不是扫描坏了。`found` 没长就说明这棵
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

/** 一条记录的来源目录（`localdir:<path>`）；不是这么来的就返回 null。 */
export function sourceDirOf(skill: Skill): string | null {
  const ref = skill.sourceRef ?? ''
  return ref.startsWith(LOCAL_DIR_SOURCE_PREFIX) ? ref.slice(LOCAL_DIR_SOURCE_PREFIX.length) : null
}
