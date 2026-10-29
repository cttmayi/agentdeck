/**
 * 「按工作目录分的受管 home」这套目录规则（分批第 77 批抽出来的）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么要单独一个模块
 * ══════════════════════════════════════════════════════════════════
 *
 * 分批第 60 批给 codex 做了"每工作目录一份 `CODEX_HOME`"（`codexHomeFor`），
 * 分批第 77 批 claude 也要这份能力（`CLAUDE_CONFIG_DIR` 按工作目录分）——
 * 于是同一套规则（目录名 = 工作目录路径的 sha256 前 16 位、只认自己命名的目录、
 * 保留最近 N 份、删实体时按工作目录清）会出现在两个模块里。
 *
 * 两条理由让它只能有一份：
 *   ① **命名规则是安全边界**：清理/删除都靠"名字是 16 位十六进制"来认"这是我们建的"。
 *      两份实现迟早一边改了正则、另一边没改，而后果是**删到使用者的目录**（或该删的没删，
 *      留下一份含 `auth.json` 的 key 副本）。
 *   ② 这两件事都与"哪个 CLI"无关：目录怎么命名、留几份、怎么删，是平台的策略。
 *
 * ⚠️ home 目录里可能有**真实凭据的副本**（codex 的 `auth.json`、claude 的
 *   `settings.json` 里那些 `ANTHROPIC_*`）——所以"删实体时一起删"这条必须跟得上
 *   （`removeWorkDirHome` 就是它）。
 */

import { createHash } from 'node:crypto'
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** 受管目录的名字：工作目录路径的 sha256 前 16 位（同一目录永远同一份）。 */
const HOME_NAME_RE = /^[0-9a-f]{16}$/u

/** 这个工作目录的受管 home（`<root>/<sha256(workDir) 前 16 位>`）。 */
export function workDirHomeFor(rootDir: string, workDir: string): string {
  const key = createHash('sha256').update(workDir).digest('hex').slice(0, 16)
  return join(rootDir, key)
}

/**
 * 清掉太旧的 per-workdir home。
 *
 * 为什么要清：两个 CLI 都会在 home 里生成会话状态（codex 的 `sessions/` / sqlite /
 * `skills/.system/`，claude 的 `projects/` / `sessions/` / `backups/`），不剪就会一直长。
 *
 * 只删**名字形如 16 位十六进制**的目录（我们自己命名的），`keepDir` 永不删，
 * 最多保留 `keep` 个（按 mtime）。失败只忽略——清理失败不该让 run 失败。
 */
export async function pruneWorkDirHomes(
  rootDir: string,
  keepDir: string,
  keep = 8,
): Promise<string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => null)
  if (entries === null) return []
  const ours: Array<{ path: string; at: number }> = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !HOME_NAME_RE.test(entry.name)) continue
    const path = join(rootDir, entry.name)
    if (path === keepDir) continue
    const info = await stat(path).catch(() => null)
    ours.push({ path, at: info?.mtimeMs ?? 0 })
  }
  ours.sort((a, b) => b.at - a.at)
  const removed: string[] = []
  for (const stale of ours.slice(Math.max(0, keep - 1))) {
    if (await rm(stale.path, { recursive: true, force: true }).then(() => true, () => false)) {
      removed.push(stale.path)
    }
  }
  return removed
}

/**
 * 删掉某个工作目录对应的那份受管 home（对话 / 任务 / run 被删时）。
 *
 * 为什么必须删：那里面有**真实凭据的副本**——任务都删了还留着一份 key，是那种
 * "看不见、但一直在"的残留（分批第 61 批，使用者提的）。
 *
 * 只认我们自己命名的目录（16 位十六进制）：`workDir` 若是使用者给的一个怪路径，
 * 算出来的名字仍然符合规则，所以这一层额外的正则其实是**防拼错**，不是防注入。
 */
export async function removeWorkDirHome(
  rootDir: string,
  workDir: string,
): Promise<{ removed: boolean; path: string }> {
  const path = workDirHomeFor(rootDir, workDir)
  if (!HOME_NAME_RE.test(path.slice(path.lastIndexOf('/') + 1))) {
    return { removed: false, path }
  }
  const removed = await rm(path, { recursive: true, force: true }).then(
    () => true,
    () => false,
  )
  return { removed, path }
}
