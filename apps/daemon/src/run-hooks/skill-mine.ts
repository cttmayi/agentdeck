/**
 * 提炼技能根（`skills-mine`）的 git 版本管理（2026-10，D80）。
 *
 * 背景：使用者要"覆盖 + git 类似的版本管理"——每次沉淀/进化后平台自动
 * `git add` + `commit`，`git log/diff/checkout` 回退与远程同步全免费，
 * 不自己造版本表。版本管理依赖**用户环境的 git**（设计定稿：不捆绑平台）。
 *
 * ══════════════════════════════════════════════════════════════════
 * git 可用性保护（使用者要求："用户环境没有 git。请设计保护。如果没有 git，
 * 就不需要版本管理"）
 * ══════════════════════════════════════════════════════════════════
 *
 *   · **可用性开关**：每次沉淀/进化前探测 `git --version`（spawn 探测，
 *     超时/非零/找不到 → 不可用）。**git 不可用是正常状态，不是错误**：
 *     跳过 init 与 commit，沉淀/进化照常写盘 + store 索引（功能完全不受影响，
 *     只少历史回退），调用方记一条 note"版本管理未启用（系统无 git），沉淀照常、
 *     无历史回退"。
 *   · **降级兜底**：git 可用但操作失败（init/add/commit 非零、.git 损坏、
 *     权限不足）→ note 降级，沉淀/进化照常（这层针对"有 git 但坏了"）。
 *   · **自动恢复**：每次沉淀前都探测 → 用户中途装了 git，下次沉淀自动恢复
 *     （幂等 init + 首次 commit 把已有沉淀收进历史）。
 *   · **半途状态**：git 不可用期间的进化没有历史——装 git 后**不补造历史**
 *     （没有基线，造出来是假的），从恢复那一刻起记录。
 *
 * 兜底身份：skills-mine 仓库配 per-repo 身份 `agentdeck <agentdeck@localhost>`，
 * 防"有 git 但没全局身份"时 commit 挂掉（降级兜底层的一部分）。
 *
 * NFR-T-01 的同类理由：`gitPath` 可注入（测试不依赖跑测机器上真的装着 git）。
 * 生产代码永远不传它（默认 `git`）。
 */

import { spawn } from 'node:child_process'
import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { diffFileSets, type FileDiff } from '../text-diff.ts'

/** 探测结果：git 是否可用。不可用是**正常状态**（设计定稿），不是错误。 */
export interface GitProbe {
  available: boolean
  /** 可用时的版本字符串（如 `git version 2.43.0`）；不可用时为 null。 */
  version: string | null
}

/** 一次 git 命令的 stdout+stderr（失败时 reason 要能说清）。 */
async function runGit(
  gitPath: string,
  args: string[],
  cwd: string,
  timeoutMs = 5_000,
): Promise<{ ok: true; stdout: string } | { ok: false; reason: string }> {
  return await new Promise((resolve) => {
    const child = spawn(gitPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ ok: false, reason: `git ${args[0]} 超时（${timeoutMs}ms）` })
    }, timeoutMs)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      // ENOENT = 系统里根本没有 git（这是**正常状态**，见头注释）
      resolve({
        ok: false,
        reason: err.code === 'ENOENT' ? '系统没有 git' : `git 启动失败：${err.message}`,
      })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve({ ok: true, stdout })
      } else {
        resolve({ ok: false, reason: `git ${args.join(' ')} 退出码 ${code}：${stderr.trim() || stdout.trim()}` })
      }
    })
  })
}

/**
 * 探测 git 可用性（可用性开关）。
 *
 * spawn 探测，找不到/超时/非零 → 不可用。**不抛异常**——"没有 git"是设计
 * 里定义的正常状态，抛异常会把它伪装成错误。
 */
export async function probeGit(gitPath = 'git'): Promise<GitProbe> {
  const result = await runGit(gitPath, ['--version'], process.cwd(), 3_000)
  if (!result.ok) return { available: false, version: null }
  return { available: true, version: result.stdout.trim() }
}

export type MineRepoResult = { ok: true } | { ok: false; reason: string }

/**
 * 确保 skills-mine 根是 git 仓库（幂等）并配好 per-repo 兜底身份。
 *
 * - git 不可用 → `{ok:false, reason:'git 不可用'}`（调用方按"版本管理未启用"
 *   处理，**不是错误**）。
 * - 已初始化 → 原样返回（幂等，自动恢复路径靠的就是它）。
 * - 首次 → `git init` + per-repo 身份（`agentdeck <agentdeck@localhost>`）。
 *
 * 为什么身份配在 per-repo 而不是全局：**绝不动使用者的全局 git 配置**——
 * 那是他的家。兜底身份只影响这一个仓库。
 */
export async function ensureMineRepo(mineRoot: string, gitPath = 'git'): Promise<MineRepoResult> {
  const probe = await probeGit(gitPath)
  if (!probe.available) return { ok: false, reason: 'git 不可用（版本管理未启用，沉淀照常）' }
  await mkdir(mineRoot, { recursive: true })
  // 已初始化（.git 存在）→ 幂等返回；不存在才 init。
  try {
    await stat(join(mineRoot, '.git'))
    return { ok: true }
  } catch {
    // 没有 .git —— 第一次开做（或用户手删过），初始化。
  }
  const init = await runGit(gitPath, ['init'], mineRoot)
  if (!init.ok) return { ok: false, reason: `git init 失败：${init.reason}` }
  // per-repo 兜底身份：防"有 git 但没全局身份"时 commit 挂掉。
  const name = await runGit(gitPath, ['config', 'user.name', 'agentdeck'], mineRoot)
  if (!name.ok) return { ok: false, reason: `配置 git 身份失败：${name.reason}` }
  const email = await runGit(gitPath, ['config', 'user.email', 'agentdeck@localhost'], mineRoot)
  if (!email.ok) return { ok: false, reason: `配置 git 身份失败：${email.reason}` }
  return { ok: true }
}

export type CommitMineResult =
  | { ok: true; commit: string }
  | { ok: false; reason: string }

/**
 * 把 skills-mine 根的当前改动提交（`git add -A` + `git commit`）。
 *
 * - `git commit` 报"nothing to commit"（没有改动）→ 视为成功（幂等：同一内容
 *   反复确认入库不该报错）。
 * - 其它失败（.git 损坏、权限不足等）→ `{ok:false, reason}`，调用方按降级兜底
 *   处理：note 降级，沉淀/进化照常。
 */
export async function commitMine(
  mineRoot: string,
  message: string,
  gitPath = 'git',
): Promise<CommitMineResult> {
  const add = await runGit(gitPath, ['add', '-A'], mineRoot)
  if (!add.ok) return { ok: false, reason: `git add 失败：${add.reason}` }
  const commit = await runGit(gitPath, ['commit', '-m', message], mineRoot)
  if (!commit.ok) {
    // "nothing to commit" 是幂等成功：没有改动需要提交。
    if (commit.reason.includes('nothing to commit')) return { ok: true, commit: '' }
    return { ok: false, reason: `git commit 失败：${commit.reason}` }
  }
  return { ok: true, commit: commit.stdout.trim() }
}

// ══════════════════════════════════════════════════════════════════════
// 只读查询：历史 / 某一版的文件树 / 两版之间的差异（P2，§7.4）
// ══════════════════════════════════════════════════════════════════════
//
// `skills-mine` 从 D80 起就是一个 git 仓库（每次沉淀/进化一条 commit），
// **历史不需要新造**——只是从前没有入口。这三个函数就是那三个入口的后端。
//
// 三条纪律：
//   · **只读**：不 add、不 commit、不 checkout。看历史不该动到工作区
//     （`git checkout` 回退是**另一件事**，要单独设计确认流程，见 §7.4 的边界）。
//   · **git 不可用是正常状态**（§7.3.1）：返回 `{available:false, reason}`，
//     界面照既有降级叙事显示"版本管理未启用"，不抛异常、不影响别的功能。
//   · **差异在后端算**（`text-diff.ts` 同一份实现）：前端只渲染。两边各写一套
//     必然漂——而"漂"的表现是同一份改动在两处显示成不同的行数，最难查。

/** 历史里的一条提交。 */
export interface MineHistoryEntry {
  /** 完整 hash：回退/对比都要用它（短 hash 只给界面看）。 */
  rev: string
  short: string
  /** ISO-8601（`--date=iso-strict`）——界面自己本地化，后端不猜时区。 */
  when: string
  message: string
}

export type MineHistory =
  | { available: true; entries: MineHistoryEntry[] }
  | { available: false; reason: string }

/**
 * 某条技能在 `skills-mine` 里的提交历史。
 *
 * - `--follow`：技能目录被改名/搬家之后历史不该断（设计里点名要它）。
 * - 字段用 `%x1f`（不可打印分隔符）切：提交消息里出现 `|` / `:` 会把字段切歪，
 *   而切歪的表现是"消息那一列显示成了半截 hash"——看起来像 git 坏了。
 */
export async function listMineHistory(
  mineRoot: string,
  slug: string,
  gitPath = 'git',
): Promise<MineHistory> {
  const result = await runGit(
    gitPath,
    ['log', '--follow', '--date=iso-strict', '--format=%H%x1f%h%x1f%cI%x1f%s', '--', `${slug}/`],
    mineRoot,
  )
  if (!result.ok) {
    // ⚠️ **空仓库**（还没有任何提交）是正常状态：`git log` 以 128 退出并说
    //    "does not have any commits yet"。那不是"git 坏了"，是"还没有历史"——
    //    报成 available:false 会让界面说"版本管理未启用"，而其实只是还没沉淀过。
    if (
      result.reason.includes('does not have any commits yet') ||
      result.reason.includes('unknown revision') ||
      result.reason.includes('bad default revision')
    ) {
      return { available: true, entries: [] }
    }
    return { available: false, reason: result.reason }
  }
  const entries: MineHistoryEntry[] = []
  for (const line of result.stdout.split('\n')) {
    if (line.trim() === '') continue
    const [rev, short, when, message] = line.split('\x1f')
    if (!rev || !short) continue
    entries.push({
      rev,
      short,
      when: when ?? '',
      message: (message ?? '').trim() === '' ? '(没有提交消息)' : (message ?? '').trim(),
    })
  }
  return { available: true, entries }
}

export type MineRevision =
  | { available: true; rev: string; files: Record<string, string> }
  | { available: false; reason: string }

/**
 * 取某一版（某个 commit）里这条技能的全部文件。
 *
 * 两趟 git：先 `ls-tree` 列出这一版里属于这个技能目录的文件，再逐文件 `show`。
 * 文件的 key 是**相对技能目录**的路径（`SKILL.md`、`reference/x.md`），与 store 里
 * `files` 的键同一套口径——否则界面按路径找不到对应文件，只能整棵树重列。
 */
export async function readMineRevision(
  mineRoot: string,
  slug: string,
  rev: string,
  gitPath = 'git',
): Promise<MineRevision> {
  const listed = await runGit(
    gitPath,
    ['ls-tree', '-r', '--name-only', rev, '--', `${slug}/`],
    mineRoot,
  )
  if (!listed.ok) return { available: false, reason: listed.reason }
  const files: Record<string, string> = {}
  for (const full of listed.stdout.split('\n')) {
    const path = full.trim()
    if (path === '') continue
    const rel = path.startsWith(`${slug}/`) ? path.slice(slug.length + 1) : path
    const shown = await runGit(gitPath, ['show', `${rev}:${path}`], mineRoot)
    // 单个文件取不到不该让整棵树失败：如实留一句在正文里，界面看得见是哪个文件
    files[rel] = shown.ok ? shown.stdout : `（这一版里读不到它：${shown.reason}）`
  }
  return { available: true, rev, files }
}

export type MineCompare =
  | { available: true; from: string; to: string; files: FileDiff[] }
  | { available: false; reason: string }

/**
 * 两版之间的逐文件差异（后端算，前端只渲染）。
 *
 * `from` / `to` 既可以是 commit，也可以是字面量 `current`（= 库里现在这条技能的内容）
 * ——"最新提交 vs 现在"是回退前最该看的那一眼（工作区改过、还没提交时两者不同）。
 */
export async function compareMineRevisions(
  mineRoot: string,
  slug: string,
  from: { rev: string } | { current: Record<string, string> },
  to: { rev: string } | { current: Record<string, string> },
  gitPath = 'git',
): Promise<MineCompare> {
  const load = async (
    side: { rev: string } | { current: Record<string, string> },
  ): Promise<{ ok: true; files: Record<string, string> } | { ok: false; reason: string }> => {
    if ('current' in side) return { ok: true, files: side.current }
    const got = await readMineRevision(mineRoot, slug, side.rev, gitPath)
    return got.available ? { ok: true, files: got.files } : { ok: false, reason: got.reason }
  }
  const before = await load(from)
  if (!before.ok) return { available: false, reason: before.reason }
  const after = await load(to)
  if (!after.ok) return { available: false, reason: after.reason }
  return {
    available: true,
    from: 'rev' in from ? from.rev : 'current',
    to: 'rev' in to ? to.rev : 'current',
    files: diffFileSets(before.files, after.files),
  }
}
