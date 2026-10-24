/**
 * 「使用者的要求」——从素材里**机械**抽出来，当成 skill 的**长期约定**（分批第 26 批）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么需要这个文件（使用者 2026-10-25 的原话）
 * ══════════════════════════════════════════════════════════════════
 *
 * 「我沉淀了 research-and-write-article，我发现在沉淀过程中，对我在素材对话中提出的要求
 *   忽略了，比如我要求了 ASD-STE100 和金字塔原理，完全没有在 skill 中有记录。
 *   这些要求就是我对此部分的习惯，需要总结进 skill 中，这才有沉淀的意义。」
 *
 * 量到的事实（那次任务的真实文件）：
 *   · `material/turns/002.md` 有「使用 ASD-STE100 的方式 写成一篇文章」
 *   · `material/turns/005.md` 有「我觉得麦肯锡的《金字塔原理》…请参考做调整呢。也需要符合ASD-STE100的表达」
 *   · `skill/SKILL.md:25` 确实提到了两者，但写成 **「如果用户要求《金字塔原理》…如果要求 ASD-STE100…」**
 *     —— 被当成了**可选开关**，而使用者说的是**默认习惯**
 *   · 根子在本仓库自己给的指令：`00-README.md` 的「怎么用这些文件」第 3 条要求把素材里的话
 *     "抽象成当需要 X 时…"，把**使用者的要求**和**这一次的执行细节**归成了一类
 *   · 这不是一次性的：`STE100` 在同一个工作区的 **4 个不同任务目录**里都出现过
 *
 * 所以这里做两件**确定性**的事（不花 LLM 额度、可核对）：
 *   1. 抽出「使用者说了什么要求」（只从 `## 使用者` 段，原文照抄，带出处）；
 *   2. 查这些要求的**专名**有没有在 `skill/` 里落地（只查"有没有落点"，不查"落实得对不对"）。
 */

export interface UserRequirement {
  /** 出处（`turns/002.md`）。 */
  file: string
  /** 原文照抄（不改写——改写会丢掉使用者的原话）。 */
  quote: string
}

/** 疑问/征询的语气词——它们是**提问**，不是要求。 */
const QUESTION_MARKERS = /\?\s*$|？\s*$|吗\s*$|呢\s*$|是不是|能否|可否|有没有|什么思?路|如何/

/**
 * 祈使/要求性的说法。
 *
 * ⚠️ 这张表**宁可漏也不要乱收**：把提问当要求会让每个 skill 都长出"约定"一节，
 *    而"约定"节的价值正来自"只收使用者真的要求过的"。
 *    实测素材里「有查过 arXiv 吗」「你的写作结构是什么思路」是提问，必须被排除。
 */
const REQUIREMENT_MARKERS = [
  '请',
  '需要',
  '必须',
  '不要',
  '别',
  '应该',
  '要有',
  '要用',
  '使用',
  '采用',
  '按照',
  '按',
  '符合',
  '参考',
  '遵循',
  '要求',
  '统一',
  '写成',
  '写成一篇',
  '风格',
  '格式',
  '结构',
]

/** 一句（或一行）是不是"使用者提的要求"。 */
export function looksLikeRequirement(text: string): boolean {
  const s = text.trim()
  if (s === '') return false
  // 提问不算要求（「有查过 arXiv 吗」「你的写作结构是什么思路」）
  if (QUESTION_MARKERS.test(s)) return false
  return REQUIREMENT_MARKERS.some((m) => s.includes(m))
}

/**
 * 从素材片段里抽「使用者的要求」。
 *
 * 只看 `## 使用者` 这一段：`## 执行记录` 是 agent 自己说的话——把 agent 的自述当成
 * "使用者的要求"是这类抽取最容易犯的错（那会把"我已经用了 STE100"变成一条约定）。
 *
 * @param files 素材文件（`relPath` + 全文）
 */
export function extractRequirements(
  files: ReadonlyArray<{ relPath: string; text: string }>,
): UserRequirement[] {
  const out: UserRequirement[] = []
  for (const f of files) {
    for (const quote of userSayings(f.text)) {
      if (!looksLikeRequirement(quote)) continue
      out.push({ file: f.relPath, quote })
    }
  }
  return out
}

/** 取出一个素材文件里 `## 使用者` 段的非空行（原文，逐行）。 */
export function userSayings(text: string): string[] {
  const lines = text.split('\n')
  const out: string[] = []
  let inside = false
  for (const line of lines) {
    if (/^##\s/.test(line)) {
      inside = /^##\s*使用者\s*$/.test(line)
      continue
    }
    if (!inside) continue
    const t = line.trim()
    if (t === '' || t.startsWith('```')) continue
    out.push(t)
  }
  return out
}

/**
 * 从一句要求里取"专名/术语"——用来做落点检查。
 *
 * 取三类：
 *   · 书名号里的（`《金字塔原理》`）
 *   · 引号里的（`"STE100"`、`“…”`）
 *   · 形如 `ASD-STE100` 的**带连字符或数字**的大写专名（纯大写词太容易误中，不取）
 *
 * ⚠️ 这是**启发式**：抽不到专名的要求（比如"要短句"）就不做落点检查——
 *    如实跳过比编一条检查好（编出来的检查会误判 skill）。
 */
export function requirementTerms(quote: string): string[] {
  const terms = new Set<string>()
  for (const m of quote.matchAll(/《([^》]+)》/g)) if (m[1]) terms.add(m[1].trim())
  for (const m of quote.matchAll(/["“”'']([^"“”''\s]{2,30})["“”'']/g)) {
    if (m[1]) terms.add(m[1].trim())
  }
  for (const m of quote.matchAll(/\b([A-Z][A-Z0-9]+(?:[-\s][A-Z0-9]+)*\d*\b)/g)) {
    const t = (m[1] ?? '').trim()
    // 至少含一个数字或连字符，或者长度 ≥ 4 的全大写专名（ASD-STE100 / STE100 / IEEE）
    if (t.length >= 4) terms.add(t)
  }
  return [...terms].filter((t) => t.length >= 3)
}

/**
 * 落点检查：这些术语有没有出现在 `skill/` 的正文里。
 *
 * ⚠️ 只查**出现性**。出现了不等于落实对了（那要审核者判断）；但**没出现**就一定没落地——
 *    这条检查的价值就在这一半（真机上 `STE100` 缺失时，逐字没出现可以一眼看出来）。
 */
export function checkTermCoverage(
  terms: readonly string[],
  skillTexts: ReadonlyArray<string>,
): Array<{ term: string; found: boolean }> {
  const haystack = skillTexts.join('\n').toLowerCase()
  return terms.map((term) => ({ term, found: haystack.includes(term.toLowerCase()) }))
}

/** 把抽取结果与覆盖检查渲染成 `material/user-requirements.md`（起草者与审核者共用）。 */
export function renderUserRequirements(
  requirements: readonly UserRequirement[],
  coverage: ReadonlyArray<{ term: string; found: boolean }>,
): string {
  const lines = [
    '# 使用者在素材里提出来的要求（平台的机械抽取）',
    '',
    '⚠️ 这份清单只做一件事：把**使用者自己说过的要求**原文摆出来，避免起草时被当成"这一次的叙述"抽象掉。',
    '它不是审核标准 —— 但它列出的每一条，都必须在 `skill/` 里有落点。',
    '',
    '## 怎么用（给起草者）',
    '1. 每一条要求，要么写进 `skill/SKILL.md` 的 **「约定」** 一节（**默认生效**，不写成"如果用户要求…"）；',
    '   要么在结论里明确说明为什么**不**采纳（例如与别的素材冲突）。',
    '2. 只有素材里**明确**写了"这次/本次/临时/就这一篇"时，才允许写成条件分支。',
    '3. 要求里出现的**专名**（书名、标准号）在正文里要原样出现——不要换成同义词。',
    '',
    '## 清单',
  ]
  if (requirements.length === 0) {
    lines.push('')
    lines.push('（素材里没有抽到"使用者提出的要求"——这不是错误：可能是这次的任务本身没有提风格/结构上的要求。）')
  } else {
    lines.push('')
    requirements.forEach((r, i) => {
      lines.push(`${i + 1}. （${r.file}）${r.quote}`)
    })
  }
  lines.push('')
  lines.push('## 专名落点检查（平台算的，不是判断）')
  lines.push('')
  if (coverage.length === 0) {
    lines.push('（上面这些要求里没有可机械检查的专名。）')
  } else {
    const missing = coverage.filter((c) => !c.found)
    lines.push(
      missing.length === 0
        ? '（全部专名都在 `skill/` 里出现了。）'
        : `⚠️ 这些专名在 \`skill/\` 里**还没出现**：${missing.map((m) => m.term).join('、')}`,
    )
    lines.push('')
    for (const c of coverage) lines.push(`- ${c.found ? '✓' : '✗'} ${c.term}`)
  }
  lines.push('')
  return lines.join('\n')
}
