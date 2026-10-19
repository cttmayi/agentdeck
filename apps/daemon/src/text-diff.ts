/**
 * 文本 diff（2026-10-19 四轮 P1）——给"变更集"用。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么后端算、前端只渲染
 * ══════════════════════════════════════════════════════════════════
 *
 * 使用者定稿：更新要"像 git status 那样罗列，可以直接看 git 的变化"。diff 的行号、
 * 上下文块、hunk 合并规则都很容易两边各写一套然后**慢慢漂**——一处改了另一处没改，
 * 界面上看起来"这段没变"，实际变了。所以：算法只有这一份，前端只画。
 *
 * 也不去调 `git diff --no-index`：草稿还没入库（是临时目录里的一组文件），
 * 而入库后在 skills-mine 里看历史才轮到 git（P2）。这里只做"两份文本 → 行级差异"。
 *
 * 算法：LCS（最长公共子序列）逐行。规模上给两道保险：
 *   · 任一侧超过 `MAX_LCS_LINES` 行 → 退化成"整文件替换"（-= 全旧、+= 全新）；
 *   · 行数乘积超过 `MAX_LCS_CELLS` → 同上。
 * 退化是**诚实的降级**：结果仍然正确（只是不精细），不会因为文件大就编不出差异。
 */

/** 一行差异：`' '` 上下文、`'+'` 新增、`'-'` 删除。 */
export interface DiffLine {
  kind: ' ' | '+' | '-'
  text: string
  /** 旧文件里的行号（1-based；新增行为 null）。 */
  oldNo: number | null
  /** 新文件里的行号（1-based；删除行为 null）。 */
  newNo: number | null
}

/** 一个 hunk：连续的一段改动 + 前后上下文。 */
export interface DiffHunk {
  oldStart: number
  newStart: number
  lines: DiffLine[]
}

export interface LineDiff {
  hunks: DiffHunk[]
  added: number
  removed: number
  /** 是否退化成"整文件替换"（文件太大，没算 LCS）。 */
  coarse: boolean
}

/** 单行数上限（超过就不做 LCS）。 */
const MAX_LCS_LINES = 4_000
/** 行数乘积上限（O(n·m) 的内存与时间保险）。 */
const MAX_LCS_CELLS = 4_000_000
/** hunk 前后保留的上下文行数。 */
const CONTEXT = 3

/** 切行：保留"文件末尾有没有换行"这个事实（`a\n` 与 `a` 是两份不同的文本）。 */
function splitLines(text: string): string[] {
  if (text === '') return []
  const normalized = text.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  // `a\nb\n`.split → ['a','b','']：末尾空串只是"最后有个换行"的痕迹，去掉；
  // 但 `a\n\nb` 中间的空行是真空行，要留。
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** 退化：整文件替换。 */
function coarseDiff(oldLines: string[], newLines: string[]): LineDiff {
  const lines: DiffLine[] = []
  oldLines.forEach((text, i) => lines.push({ kind: '-', text, oldNo: i + 1, newNo: null }))
  newLines.forEach((text, i) => lines.push({ kind: '+', text, oldNo: null, newNo: i + 1 }))
  return {
    hunks: lines.length === 0 ? [] : [{ oldStart: 1, newStart: 1, lines }],
    added: newLines.length,
    removed: oldLines.length,
    coarse: true,
  }
}

/**
 * 行级 diff。
 *
 * 顺序按"旧文件顺序遍历 + 新增插入"给出（与 `git diff` 的观感一致）：
 * 删除行紧挨着同一位置的新增行，人读起来就是"这段被改写了"。
 */
export function diffLines(oldText: string, newText: string): LineDiff {
  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)
  if (oldText === newText) return { hunks: [], added: 0, removed: 0, coarse: false }
  if (oldLines.length === 0) {
    const lines: DiffLine[] = newLines.map((text, i) => ({
      kind: '+' as const,
      text,
      oldNo: null,
      newNo: i + 1,
    }))
    return { hunks: [{ oldStart: 1, newStart: 1, lines }], added: lines.length, removed: 0, coarse: false }
  }
  if (newLines.length === 0) {
    const lines: DiffLine[] = oldLines.map((text, i) => ({
      kind: '-' as const,
      text,
      oldNo: i + 1,
      newNo: null,
    }))
    return { hunks: [{ oldStart: 1, newStart: 1, lines }], added: 0, removed: lines.length, coarse: false }
  }

  const n = oldLines.length
  const m = newLines.length
  if (n > MAX_LCS_LINES || m > MAX_LCS_LINES || n * m > MAX_LCS_CELLS) {
    return coarseDiff(oldLines, newLines)
  }

  // LCS 长度表：dp[i][j] = old[i..] 与 new[j..] 的最长公共子序列长度。
  // 用 Uint32Array 按行分配，避免 n·m 个 JS 数组元素的分配开销。
  const width = m + 1
  const dp = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i -= 1) {
    const rowBase = i * width
    const nextBase = (i + 1) * width
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[rowBase + j] =
        oldLines[i] === newLines[j]
          ? dp[nextBase + j + 1]! + 1
          : Math.max(dp[nextBase + j]!, dp[rowBase + j + 1]!)
    }
  }

  // 回溯出"逐行标记"（带旧/新行号）
  const marked: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      marked.push({ kind: ' ', text: oldLines[i]!, oldNo: i + 1, newNo: j + 1 })
      i += 1
      j += 1
    } else if (dp[(i + 1) * width + j]! >= dp[i * width + j + 1]!) {
      marked.push({ kind: '-', text: oldLines[i]!, oldNo: i + 1, newNo: null })
      i += 1
    } else {
      marked.push({ kind: '+', text: newLines[j]!, oldNo: null, newNo: j + 1 })
      j += 1
    }
  }
  while (i < n) {
    marked.push({ kind: '-', text: oldLines[i]!, oldNo: i + 1, newNo: null })
    i += 1
  }
  while (j < m) {
    marked.push({ kind: '+', text: newLines[j]!, oldNo: null, newNo: j + 1 })
    j += 1
  }

  let added = marked.filter((l) => l.kind === '+').length
  let removed = marked.filter((l) => l.kind === '-').length

  // ⚠️ 行内容一样、但**文本不同**（末尾换行 / CRLF）：LCS 会认为"没变"。
  //    那样界面会显示"未改动"，可入库时写下去的字节确实变了——一份内容两个说法。
  //    这里显式把最后一行记成"改了一行"，宁可多一行噪音，也不要撒谎。
  if (added === 0 && removed === 0) {
    const lastOld = marked.length > 0 ? marked[marked.length - 1]! : null
    if (lastOld !== null) {
      marked[marked.length - 1] = { ...lastOld, kind: '-' }
      marked.push({
        kind: '+',
        text: lastOld.text,
        oldNo: null,
        newNo: lastOld.newNo ?? lastOld.oldNo ?? 1,
      })
      added = 1
      removed = 1
    }
  }

  return { hunks: groupHunks(marked), added, removed, coarse: false }
}

/** 把逐行标记收成 hunk（改动前后各 CONTEXT 行上下文，相邻 hunk 合并）。 */
function groupHunks(marked: DiffLine[]): DiffHunk[] {
  const changed: number[] = []
  marked.forEach((line, idx) => {
    if (line.kind !== ' ') changed.push(idx)
  })
  if (changed.length === 0) return []

  // 每个改动行向前后各扩 CONTEXT 行，形成若干区间，再合并重叠/相邻的
  const ranges: Array<[number, number]> = []
  for (const idx of changed) {
    const start = Math.max(0, idx - CONTEXT)
    const end = Math.min(marked.length - 1, idx + CONTEXT)
    const last = ranges[ranges.length - 1]
    if (last !== undefined && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end)
    } else {
      ranges.push([start, end])
    }
  }

  return ranges.map(([start, end]) => {
    const lines = marked.slice(start, end + 1)
    const firstOld = lines.find((l) => l.oldNo !== null)?.oldNo ?? 0
    const firstNew = lines.find((l) => l.newNo !== null)?.newNo ?? 0
    return { oldStart: firstOld, newStart: firstNew, lines }
  })
}

/** 一个文件的差异（相对某个基线）。 */
export interface FileDiff {
  /** 相对技能目录的路径。 */
  rel: string
  /** `A` 新增 / `M` 修改 / `D` 删除 / `same` 没变。 */
  change: 'A' | 'M' | 'D' | 'same'
  added: number
  removed: number
  hunks: DiffHunk[]
  coarse: boolean
}

/**
 * 比较两组文件（相对路径 → 文本）。
 *
 * `A` = 基线里没有；`D` = 草稿里没有；`M` = 都有但内容不同；`same` = 完全一样。
 * 排序：SKILL.md 永远第一，其余按路径字典序（与文件树一致）。
 */
export function diffFileSets(
  baseline: Record<string, string>,
  draft: Record<string, string>,
): FileDiff[] {
  const rels = new Set([...Object.keys(baseline), ...Object.keys(draft)])
  const out: FileDiff[] = []
  for (const rel of rels) {
    const before = baseline[rel]
    const after = draft[rel]
    if (before === undefined && after !== undefined) {
      const d = diffLines('', after)
      out.push({ rel, change: 'A', added: d.added, removed: 0, hunks: d.hunks, coarse: d.coarse })
    } else if (before !== undefined && after === undefined) {
      const d = diffLines(before, '')
      out.push({ rel, change: 'D', added: 0, removed: d.removed, hunks: d.hunks, coarse: d.coarse })
    } else if (before !== undefined && after !== undefined) {
      const d = diffLines(before, after)
      out.push({
        rel,
        change: d.added === 0 && d.removed === 0 ? 'same' : 'M',
        added: d.added,
        removed: d.removed,
        hunks: d.hunks,
        coarse: d.coarse,
      })
    }
  }
  // 排序：SKILL.md 第一；其余**未删除的在前、删除的在后**（各自按路径字典序）。
  // "要删的"单独堆在末尾，是使用者核对时最需要一眼看到的一组。
  const rank = (d: FileDiff): number => (d.rel === 'SKILL.md' ? 0 : d.change === 'D' ? 2 : 1)
  out.sort((a, b) => {
    const byRank = rank(a) - rank(b)
    if (byRank !== 0) return byRank
    return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0
  })
  return out
}
