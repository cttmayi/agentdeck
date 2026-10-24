/**
 * 返工收敛闸门（分批第 25 批）：量"这一版返工到底改了什么"，判它是不是**重写**、
 * **变胖**、或者**根本没动点名的地方**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么需要这个文件（真机上量到的，不是想出来的）
 * ══════════════════════════════════════════════════════════════════
 *
 * 使用者那条链跑到 **15 版 / $62.27** 还是过不了。把历轮判决摊开看，形态是这样的：
 *
 * | 轮次 | 判决点名的两处 | 结果 |
 * | --- | --- | --- |
 * | 第 14 轮 | ①「正文章节计数 ≥ 2」恒为 0 ② 兜底抓第一个 `.pdf` | 起草者改这两处 |
 * | 第 15 轮 | ① A 路兜底**用了 B 路的** `find-pdf-url.py` ② `pdftotext` 未探测可用性 | ①是**改出来的新伤** |
 *
 * 也就是说：**修好 A 撞坏 B，下一轮再来修 B**——震荡，不是"不够努力"。
 * 而正文行数一路 **188 → 473 行、只增不减**：每轮都在**重写整篇**，而"路径 A/B 混用"
 * 这类错误恰恰是整篇重写最容易引入的。轮数加到 100 也不会收敛。
 *
 * 所以这个闸门做的不是"再审一遍"，而是**拦重写**：返工版一落地（起审核之前）就先量，
 * 判成重写/变胖/没动点名处 ⇒ 停掉自动循环、交给人，并把**它为什么被判定**写成一份
 * `material/rework-guard.md`（人能照着看，模型下一轮也能照着重做）。
 *
 * ⚠️ 判据全部是**确定性**的（行数、改动集合、触达文件），不花任何 LLM 额度，
 *    也不依赖审核者的措辞——这正是第 20 批把"脚本能不能跑"从审核者手里拿走的同一个理由。
 */

/** 一个文件在"上一版 / 这一版"的正文；`null` = 那一侧没有这个文件（新建或删除）。 */
export interface GuardFile {
  path: string
  prev: string | null
  next: string | null
}

export interface GuardFacts {
  /** 上一版所有文件加起来多少行（空行不算，见 `countLines`）。 */
  prevLines: number
  nextLines: number
  /** 这一版新增的行数（按多重集算：上一版没有这个文本行）。 */
  added: number
  /** 这一版删掉的行数。 */
  removed: number
  /** 上一版被改动过的行占比（`(added + removed) / prevLines`），0–1。 */
  changedRatio: number
  /** 这一版碰过的文件（内容有变化的，按路径排序）。 */
  touchedFiles: string[]
  /** 上一轮判决点名到的文件（按路径排序，去重）。 */
  targetFiles: string[]
  /** 点名到的文件里，这一版**一个都没动**。 */
  targetUntouched: boolean
}

export type GuardKind = 'ok' | 'rewrite' | 'bloat' | 'off-target'

export interface GuardResult {
  kind: GuardKind
  /** 人话理由，按严重度排（第一条就是"为什么被判成这样"）。 */
  reasons: string[]
  facts: GuardFacts
}

/**
 * 判据阈值（都写在这里，别散到调用点去）。
 *
 * 这几个数不是拍的，是按真机那条链的形态定的：
 *   · 那条链每轮改动都在**整篇**量级（188 → 473 行），而"只改点名处"的改动应当是个位数到十几行；
 *   · 正文涨幅 30% 就是它一路变胖的斜率（第 1 版 188 行，第 10 版 473 行 ≈ 每版 +30%）；
 *   · `0.4` 的改动占比意味着"近一半的行都换了" —— 那不是改，是重写。
 */
export const REWRITE_RATIO = 0.4
export const BLOAT_RATIO = 1.3
/**
 * 比例判据的**最小规模**：上一版不到 20 行就不按比例判。
 *
 * 为什么：比例在文档很小的时候完全没有意义——上一版 2 行、这一版加 1 行，占比就是 50%，
 * 会被判成"重写整篇"。真机上那条链的 `SKILL.md` 是几百行，比例才有意义。
 * ⚠️ 这是我第一版没写、被测试抓出来的（「新建文件不会被算成改了一半」那条红）。
 */
export const MIN_LINES_FOR_RATIO = 20

/**
 * 数"有内容的行"：空行与纯空白行不算。
 *
 * 为什么这样数：模型重写时最爱加空行来"整理版式"，把空行算进涨幅会让**没有实质变化的
 * 版本**被判成变胖；反过来，删掉空行也不是"改好了"。
 */
export function countLines(text: string | null | undefined): number {
  if (typeof text !== 'string' || text === '') return 0
  return text.split('\n').filter((l) => l.trim() !== '').length
}

/** 一行里"有内容"的部分（去首尾空白）——比较改动时用它，避免缩进调整被当成改动。 */
function lineKeys(text: string | null | undefined): string[] {
  if (typeof text !== 'string' || text === '') return []
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
}

/**
 * 把一个 locator 归一成**文件路径**。
 *
 * 审核者写的是 `SKILL.md:183` / `references/extraction.md:11-13` / `SKILL.md#When to Use`，
 * 三种都要能对上"哪个文件"。
 *
 * ⚠️ **不要拿 locator 当"同一处问题"的身份**：行号每轮都在漂（真机上第 14 轮点名
 *    `SKILL.md:162`、第 15 轮点名 `SKILL.md:183`，是两处不同的东西，但"同一处"
 *    在下一轮会漂到别的行号上）——分批第 23 批的"没进展"检测就是踩在这个坑里，
 *    上线后量到 `stalled` 恒为 null。所以这一批只用**文件**级别做集合运算。
 */
export function locatorFile(locator: string): string {
  const cut = locator.search(/[:#]/)
  const path = (cut < 0 ? locator : locator.slice(0, cut)).trim()
  /**
   * ⚠️ 去掉开头的 `skill/`：审核者写的是 `skill/SKILL.md:183`（它眼里的路径），
   * 而收敛闸门比的是**产出目录内部**的相对路径（`SKILL.md`）。不去掉两边永远对不上。
   *
   * 这是上线后第一次真跑就现形的 bug：`material/rework-guard.md` 里出现了自相矛盾的判定——
   * 「上一轮点名的文件（skill/SKILL.md、references/research-commands.md）这一版**一个都没动**
   * （改的是 SKILL.md、references/research-commands.md）」⇒ 误判 `off-target` ⇒ **误停自动循环**。
   */
  return path.replace(/^(\.\/)?(skill\/)+/i, '')
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  return a.every((x, i) => x === b[i])
}

/**
 * 量一版返工改了什么。
 *
 * `targetLocators` = 上一轮判决点名的位置（`locator` 原样传进来，内部会归一成文件）。
 */
export function inspectRework(input: {
  files: readonly GuardFile[]
  targetLocators: readonly string[]
}): GuardResult {
  const prevKeys: string[] = []
  const nextKeys: string[] = []
  let prevLines = 0
  let nextLines = 0
  const touchedFiles: string[] = []

  for (const f of input.files) {
    const p = lineKeys(f.prev)
    const n = lineKeys(f.next)
    prevKeys.push(...p)
    nextKeys.push(...n)
    prevLines += p.length
    nextLines += n.length
    if (!sameList(p, n)) touchedFiles.push(f.path)
  }
  touchedFiles.sort()

  // 多重集差：同一条文本在两边各出现几次，多出来的算新增，少的算删除。
  const bag = new Map<string, number>()
  for (const k of prevKeys) bag.set(k, (bag.get(k) ?? 0) + 1)
  let added = 0
  for (const k of nextKeys) {
    const left = bag.get(k) ?? 0
    if (left > 0) bag.set(k, left - 1)
    else added += 1
  }
  let removed = 0
  for (const left of bag.values()) removed += left

  const targetFiles = [...new Set(input.targetLocators.map(locatorFile).filter((f) => f !== ''))].sort()
  const targetUntouched =
    targetFiles.length > 0 && !touchedFiles.some((f) => targetFiles.includes(f))
  const changedRatio = prevLines === 0 ? (nextLines === 0 ? 0 : 1) : (added + removed) / prevLines

  const facts: GuardFacts = {
    prevLines,
    nextLines,
    added,
    removed,
    changedRatio,
    touchedFiles,
    targetFiles,
    targetUntouched,
  }

  const reasons: string[] = []
  let kind: GuardKind = 'ok'

  if (prevLines >= MIN_LINES_FOR_RATIO && changedRatio > REWRITE_RATIO) {
    kind = 'rewrite'
    reasons.push(
      `改动量 ${added} 增 / ${removed} 删，占上一版 ${prevLines} 行的 ` +
        `${Math.round(changedRatio * 100)}%（阈值 ${Math.round(REWRITE_RATIO * 100)}%）` +
        `—— 这是重写整篇，不是"只改点名的地方"`,
    )
  }
  if (prevLines >= MIN_LINES_FOR_RATIO && nextLines > prevLines * BLOAT_RATIO) {
    if (kind === 'ok') kind = 'bloat'
    reasons.push(
      `正文从 ${prevLines} 行涨到 ${nextLines} 行（+${Math.round((nextLines / prevLines - 1) * 100)}%，` +
        `阈值 +${Math.round((BLOAT_RATIO - 1) * 100)}%）—— 这条链就是这么从 188 行长到 473 行的`,
    )
  }
  if (targetUntouched) {
    if (kind === 'ok') kind = 'off-target'
    reasons.push(
      `上一轮点名的文件（${targetFiles.join('、')}）这一版**一个都没动**` +
        `（改的是 ${touchedFiles.join('、') === '' ? '（没改任何文件）' : touchedFiles.join('、')}）`,
    )
  }

  if (prevLines > 0 && prevLines < MIN_LINES_FOR_RATIO) {
    reasons.push(`上一版只有 ${prevLines} 行（不到 ${MIN_LINES_FOR_RATIO} 行）⇒ 不按比例判重写/变胖，只看有没有动点名的地方`)
  }
  if (kind === 'ok') {
    reasons.push(
      `改动 ${added} 增 / ${removed} 删（占 ${Math.round(changedRatio * 100)}%），` +
        `正文 ${prevLines} → ${nextLines} 行，落在点名的地方 ⇒ 放行`,
    )
  }
  return { kind, reasons, facts }
}
