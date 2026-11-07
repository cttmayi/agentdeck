import { join } from 'node:path'
import { readJsonFile, writeJsonFile } from './paths.ts'

/**
 * 词典：专有名词矫正的**第二层**（第一层是 whisper 的 initialPrompt）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 两层为什么要分开，各自管什么
 * ══════════════════════════════════════════════════════════════════
 *
 * · **第一层 prompt**：告诉模型"这些话里可能出现这些词"。它影响的是模型**选词**
 *   的概率——说"AgentDeck"时不容易听成"agent deck"。但它是**软**的：塞不进去的
 *   词就是没有，模型也可能照错不误。
 * · **第二层替换**：确定性的字符串改写，把**已经错成的固定形态**掰回来（"微思普"
 *   → "Whisper"）。它不猜、不模糊匹配——因为这一层是"最后一道"，它一旦改错，人看
 *   到的就是一句没说过的话。
 *
 * ★ 分批第 277 批（使用者："可以"，指这一层要）：判别标准是**能不能回显**。每次
 *   替换都记进 `corrections`，界面上显示"纠正 2 处"、点开能看原样。静默改写是最
 *   危险的一种失败：人以为模型听得准，其实是词典在兜底，于是永远学不到"这句我说
 *   清楚点"。
 *
 * ══════════════════════════════════════════════════════════════════
 * 三条硬纪律（每条都对应一种会咬人的错法）
 * ══════════════════════════════════════════════════════════════════
 *
 * ① **规则只许是字面串，不提供正则**。配置里给正则 = 把"误伤"变成使用者自己埋的雷，
 *    而且写在 JSON 里的人根本想不到 `\b` 在中文里意味着什么。
 * ② **命中区间不许重叠，长串优先**。否则短规则会把长规则咬掉（`wiki capture` 被
 *    `capture` 先吃掉），或者替换结果又被后面的规则再改一遍（链式改写，改出来
 *    谁也没预期过的词）。所以做法是：在**原文**上按"长的先匹配"，占住区间，
 *    后面的规则跳过已占住的区间，最后一次性拼回去。
 * ③ **英文按词边界，中文按整串**。`deck` 不该把 `deckhand` 改成 `AgentDeckhand`；
 *    而中文没有词边界可言，整串替换就是它的边界。
 */

/** 词表格式版本：以后改结构时用它决定怎么迁移（现在是 1，没有迁移逻辑）。 */
export const VOCAB_VERSION = 1

/**
 * 上限。
 *
 * ⚠️ 为什么要有：whisper 的 initialPrompt 有 token 上限（约 224），塞不进去的部分
 *   会被**静默截断**；而"我以为词典生效了其实没有"是最难查的一类问题。所以词表本身
 *   就该有个小上限（宁可让人删几条，也不要让人以为 500 个词都在起作用）。
 */
export const PROMPT_TERM_LIMIT = 120
export const VOCAB_RULE_LIMIT = 300
/** 单条规则的字段上限（`from` / `to`）——它是一次替换，不是一句话。 */
export const VOCAB_FIELD_MAX = 60

export interface VocabRule {
  /** 识别**可能**出现的形态（口头常被听成的那个样子）。 */
  from: string
  /** 正确的写法（原样输出，不做大小写变换）。 */
  to: string
  /** 为什么有这条（界面上悬停可见；也方便以后判断它是否还成立）。 */
  note?: string
}

export interface VoiceVocab {
  version: number
  /** 进 initialPrompt 的词（**正确写法**，不是替换规则）。 */
  promptTerms: string[]
  /** 确定性替换规则。 */
  rules: VocabRule[]
}

export const EMPTY_VOCAB: VoiceVocab = { version: VOCAB_VERSION, promptTerms: [], rules: [] }

export function vocabPathOf(asrRoot: string): string {
  return join(asrRoot, 'vocab.json')
}

/**
 * 把"从磁盘读到的任意 JSON"收拾成一份合法词表。
 *
 * ⚠️ 这个函数**永不抛**。词表是人会手改的文件，改坏是常态；它的职责是"尽量留下
 *   能用的部分"，并把**被丢掉的东西**如实报出来（`problems`），界面才能说清
 *   "有 3 条规则格式不对，已跳过"，而不是让人对着"看起来保存成功了"发懵。
 */
export function normalizeVocab(raw: unknown): { vocab: VoiceVocab; problems: string[] } {
  const problems: string[] = []
  if (typeof raw !== 'object' || raw === null) {
    return { vocab: { ...EMPTY_VOCAB }, problems: ['词表不是 JSON 对象，已按空词表处理'] }
  }
  const obj = raw as Record<string, unknown>
  const rawTerms = Array.isArray(obj['promptTerms']) ? obj['promptTerms'] : []
  const terms: string[] = []
  const seen = new Set<string>()
  for (const item of rawTerms) {
    if (typeof item !== 'string') {
      problems.push('promptTerms 里有一条不是字符串，已跳过')
      continue
    }
    const term = item.trim()
    if (term === '' || term.length > VOCAB_FIELD_MAX) {
      problems.push(`promptTerms 里的「${item.slice(0, 12)}」长度不合适，已跳过`)
      continue
    }
    // 去重按**小写**：`Whisper` 与 `whisper` 是同一个词，进 prompt 两次只会白占 token
    const key = term.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    terms.push(term)
  }
  if (terms.length > PROMPT_TERM_LIMIT) {
    problems.push(`promptTerms 超过 ${PROMPT_TERM_LIMIT} 条，只保留前 ${PROMPT_TERM_LIMIT} 条`)
    terms.length = PROMPT_TERM_LIMIT
  }

  const rawRules = Array.isArray(obj['rules']) ? obj['rules'] : []
  const rules: VocabRule[] = []
  for (const item of rawRules) {
    if (typeof item !== 'object' || item === null) {
      problems.push('rules 里有一条不是对象，已跳过')
      continue
    }
    const r = item as Record<string, unknown>
    const from = typeof r['from'] === 'string' ? r['from'].trim() : ''
    const to = typeof r['to'] === 'string' ? r['to'].trim() : ''
    if (from === '' || to === '') {
      problems.push('rules 里有一条缺少 from 或 to，已跳过')
      continue
    }
    if (from.length > VOCAB_FIELD_MAX || to.length > VOCAB_FIELD_MAX) {
      problems.push(`规则「${from.slice(0, 12)}」太长（超过 ${VOCAB_FIELD_MAX} 字），已跳过`)
      continue
    }
    // from === to 的规则是纯粹的空转（大小写完全相同），留着只会让"纠正 N 处"虚高
    if (from === to) {
      problems.push(`规则「${from}」的 from 与 to 相同，已跳过`)
      continue
    }
    const note = typeof r['note'] === 'string' && r['note'].trim() !== '' ? r['note'].trim() : undefined
    rules.push(note === undefined ? { from, to } : { from, to, note })
  }
  if (rules.length > VOCAB_RULE_LIMIT) {
    problems.push(`rules 超过 ${VOCAB_RULE_LIMIT} 条，只保留前 ${VOCAB_RULE_LIMIT} 条`)
    rules.length = VOCAB_RULE_LIMIT
  }
  return { vocab: { version: VOCAB_VERSION, promptTerms: terms, rules }, problems }
}

/** 读词表：文件不在就是空词表（**不是错误**——第一次用的人本来就还没有词表）。 */
export async function readVocab(asrRoot: string): Promise<{ vocab: VoiceVocab; problems: string[] }> {
  const raw = await readJsonFile(vocabPathOf(asrRoot))
  if (raw === null) return { vocab: { ...EMPTY_VOCAB }, problems: [] }
  return normalizeVocab(raw)
}

/** 写词表：先收拾一遍再落盘（保证磁盘上的永远是合法形状），返回落盘的这份。 */
export async function writeVocab(
  asrRoot: string,
  input: unknown,
): Promise<{ vocab: VoiceVocab; problems: string[] }> {
  const normalized = normalizeVocab(input)
  await writeJsonFile(vocabPathOf(asrRoot), normalized.vocab)
  return normalized
}

/**
 * prompt 的**字符预算**。
 *
 * ⚠️ 为什么按字符而不是按 token：token 数只有 whisper 的 tokenizer 知道，而我们不想
 *   为了量一个数字把分词器也搬进来。中文大约 1 字 ≈ 1–2 token、英文 1 词 ≈ 1.3 token，
 *   取"180 字"这个偏保守的数：既能装下几十个专有名词，又不会顶到 224 token 的天花板
 *   而被静默截断（截断的后果见上面那段：以为生效了，其实没生效）。
 */
export const PROMPT_CHAR_BUDGET = 180

/**
 * 组装 initialPrompt。
 *
 * ★ 用一句**自然话**把词串起来，而不是直接丢一串逗号分隔的词：whisper 的 prompt 是
 *   "上一段文本"的模拟，模型看到一句像人话的引导，比看到一堆裸词更稳（裸词表会让它
 *   倾向于把整段听成词表里的词）。
 *
 * ⚠️ 语言与引导语要一致：给中文模型塞一句英文引导语，会让它倾向于输出英文。
 */
export function buildPrompt(vocab: VoiceVocab, language: 'zh' | 'en' | 'auto'): string {
  const terms = vocab.promptTerms.filter((t) => t !== '')
  if (terms.length === 0) return ''
  const head =
    language === 'en'
      ? 'Dictated notes about this project. Proper nouns that may come up: '
      : '以下是关于这个项目的口述笔记。可能出现的专有名词：'
  const tail = language === 'en' ? '.' : '。'
  let body = ''
  let used = head.length + tail.length
  for (const term of terms) {
    const piece = `${term}${language === 'en' ? ', ' : '、'}`
    if (used + piece.length > PROMPT_CHAR_BUDGET) break
    body += piece
    used += piece.length
  }
  if (body === '') return ''
  // 收尾的那个分隔符换成句号（`a、b、` → `a、b。`）
  return `${head}${body.replace(/[、,]\s*$/, '')}${tail}`
}

/** 一处替换（回显用）：哪一串被换成了什么、换了几次。 */
export interface Correction {
  from: string
  to: string
  count: number
}

export interface ApplyRulesResult {
  text: string
  corrections: Correction[]
}

/**
 * 跑第二层：把识别文本里的"固定错形态"换成正确写法。
 *
 * 算法（对应上面纪律②）：在**原文**上按 `from` **由长到短**找命中，命中区间不重叠、
 * 先到先得，最后一次性拼回。这样既不会被短规则咬掉长规则，也不会出现"改完的结果
 * 又被下一条规则再改一遍"。
 *
 * ⚠️ 英文按词边界（`(?<![A-Za-z0-9])…(?![A-Za-z0-9])`），中文按整串：中文没有词
 *   边界可言，硬套 `\b` 会一条都命不中（这是最容易写错的一处）。
 * ⚠️ 命中数**按次累计**：同一个错形态出现 3 次，界面上说"纠正 3 处"，而不是三条
 *   一模一样的记录。
 */
export function applyVocabRules(text: string, rules: readonly VocabRule[]): ApplyRulesResult {
  if (text === '' || rules.length === 0) return { text, corrections: [] }
  const ordered = [...rules].sort((a, b) => b.from.length - a.from.length)
  /** 已经占用的字符区间（`[start, end)`）——后匹配到的规则必须绕开它们。 */
  const claimed: Array<[number, number]> = []
  const hits: Array<{ start: number; end: number; to: string; from: string }> = []

  const overlaps = (start: number, end: number): boolean =>
    claimed.some(([s, e]) => start < e && s < end)

  for (const rule of ordered) {
    const isAscii = /^[\x20-\x7e]+$/.test(rule.from)
    if (isAscii) {
      // 大小写不敏感：口述转出来的英文常常全小写，而词表里写的是驼峰原名
      const pattern = new RegExp(
        `(?<![A-Za-z0-9])${escapeRegExp(rule.from)}(?![A-Za-z0-9])`,
        'gi',
      )
      for (const m of text.matchAll(pattern)) {
        const start = m.index ?? 0
        const end = start + m[0].length
        if (overlaps(start, end)) continue
        claimed.push([start, end])
        hits.push({ start, end, to: rule.to, from: rule.from })
      }
    } else {
      let from = 0
      for (;;) {
        const at = text.indexOf(rule.from, from)
        if (at < 0) break
        const end = at + rule.from.length
        from = end
        if (overlaps(at, end)) continue
        claimed.push([at, end])
        hits.push({ start: at, end, to: rule.to, from: rule.from })
      }
    }
  }

  if (hits.length === 0) return { text, corrections: [] }
  hits.sort((a, b) => a.start - b.start)
  let out = ''
  let cursor = 0
  for (const hit of hits) {
    out += text.slice(cursor, hit.start) + hit.to
    cursor = hit.end
  }
  out += text.slice(cursor)

  // 合并同类（同一对 from→to 只报一条，带次数）——界面上"纠正 3 处"要能一句说完
  const byPair = new Map<string, Correction>()
  for (const hit of hits) {
    const key = `${hit.from}\u0000${hit.to}`
    const existing = byPair.get(key)
    if (existing) existing.count += 1
    else byPair.set(key, { from: hit.from, to: hit.to, count: 1 })
  }
  return { text: out, corrections: [...byPair.values()] }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
