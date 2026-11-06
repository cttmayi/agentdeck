import type { MemoryEntry, MemoryKind } from '@agentdeck/protocol'
import { MEMORY_TEXT_MAX, looksLikeSecret } from './memory.ts'

/** 记忆类型的显示名（写进 `existing-memory.md` 给人/给模型看；与界面上的词一致）。 */
const MEMORY_KIND_LABEL: Record<MemoryKind, string> = {
  preference: '偏好',
  fact: '事实',
  lesson: '教训',
  commitment: '约定',
}

/**
 * 「整理成记忆」的分析层（分批第 243 批）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么不是"把我说过的话列出来让人勾"
 * ══════════════════════════════════════════════════════════════════
 *
 * 第一版（第 240 批）就是这么做的：把**人在这段对话里说过的话**逐字列出来，勾哪几句。
 * 它的好处是"平台不生成任何内容"，坏处是**几乎没用**：
 *
 *   · 原话是"这次"的话（"帮我改一下第 3 行的那个变量"），勾了也不是经验；
 *   · 真正值得记的那句往往**夹在**长段消息中间，靠人自己再读一遍整段对话去挑；
 *   · 而 agent 自己在对话里说过的判断（"这个仓库用 pnpm、别用 npm"）根本不在候选里
 *     ——它恰恰是最该记的。
 *
 * 使用者的原话：「类似沉淀技能一样，分析整段对话，然后整理出要添加的记忆」。
 * 所以现在是一条**分析 run**：把整段对话落成 `transcript.md`，让 agent 读完，
 * 只吐 JSON；平台解析成候选条目，摆给人在界面上勾/改/删，**人确认才写入**。
 *
 * ★ 只有人能写这条铁律没变：分析产出的是**候选**，不是记忆。它没有写权限，
 *   写得进去的只有人按下那一下（`POST /api/agents/{id}/memory`）。
 */

/** 落盘给 agent 读的对话正文上限（字符）。超了按"留最近"截断并**如实说明**。 */
export const TIDY_TRANSCRIPT_MAX_CHARS = 30_000
/** 一次最多收多少条候选（与每轮注入的预算同一量级：太多等于没挑）。 */
export const TIDY_MAX_CANDIDATES = 12

export type TidyTurn = {
  seq: number
  userText: string
  /** 那一轮它的最后一段正文；`null` = 没产出文字 / 没跑起来。 */
  output: string | null
}

/**
 * 把整段对话渲染成一份可读的 md（写进分析 run 的工作目录，让它读）。
 *
 * 截断策略：**留最近**。记忆的价值在"现在还用得上"，而最近的对话才是现在的上下文；
 * 但第一轮保住（它往往是"这段对话是干什么的"）。被省掉的轮次要**写出来**——
 * 悄悄截断会让它以为自己看全了，从而把"没看到"当成"不存在"。
 */
export function renderTidyTranscript(input: {
  title: string
  agentName: string
  turns: readonly TidyTurn[]
}): { text: string; included: number; skipped: number } {
  const header = [
    `# 对话：${input.title}`,
    '',
    `和「${input.agentName}」的一段对话，共 ${input.turns.length} 轮。`,
    '',
  ].join('\n')

  const render = (turn: TidyTurn): string => {
    const mine = turn.userText.trim()
    const theirs = (turn.output ?? '').trim()
    return [
      `## 第 ${turn.seq} 轮`,
      '',
      '**人**：',
      mine === '' ? '（空）' : mine,
      '',
      '**它**：',
      theirs === '' ? '（这一轮没有文字产出）' : theirs,
      '',
    ].join('\n')
  }

  /**
   * 装填顺序：**第一轮先占位**（它往往是"这段对话是干什么的"），剩下的预算从**最后**
   * 往前装，装不下就停。
   *
   * ⚠️ 第一版是"先装最近、装完发现第一轮不在就硬塞回去"——于是总长会**超出上限**
   *    （实测 30594 > 30000）：预算已经花光，再加一轮就是超。超了不会报错，只会
   *    悄悄塞进一个更大的 prompt 里（而那条上限存在的理由正是"别把整段对话塞进去"）。
   */
  const kept: TidyTurn[] = []
  let budget = TIDY_TRANSCRIPT_MAX_CHARS - header.length
  const first = input.turns[0]
  if (first !== undefined) {
    const cost = render(first).length
    // 第一轮自己就超预算（极端长的一条）⇒ 放弃它，别为它把上限撑破
    if (cost <= budget) {
      kept.push(first)
      budget -= cost
    }
  }
  for (let i = input.turns.length - 1; i >= 1; i -= 1) {
    const turn = input.turns[i]!
    const cost = render(turn).length
    if (cost > budget) break
    kept.push(turn)
    budget -= cost
  }
  // `kept` 现在是"第一轮 + 倒序装进来的最近若干轮"，按轮次排回时间顺序
  kept.sort((a, b) => a.seq - b.seq)
  const skipped = input.turns.length - kept.length
  const note =
    skipped === 0
      ? ''
      : `\n> ⚠️ 这段对话太长，中间有 ${String(skipped)} 轮没放进来（保留第一轮与最近若干轮）。\n`

  return {
    text: header + note + kept.map(render).join(''),
    included: kept.length,
    skipped,
  }
}

/**
 * 「它现在已有的记忆」——写进分析小屋，让分析 run 读（分批第 251 批）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么必须给它看（一次真实的翻车）
 * ══════════════════════════════════════════════════════════════════
 *
 * 使用者同一段对话整理**三次**，每次 7 条 ⇒ 库里 21 条，其中三批几乎是同一件事换着说法
 * （"文章要短、图要少" / "控制篇幅、减少配图" / "技术文章要控制篇幅…"）。
 * 原因很简单：**分析那一轮只看得到对话，看不到它已经记住了什么**——于是每次都从头挑一遍。
 *
 * 平台这一侧补不了这件事：中文改写之间的字符重合度极低（实测同义的几句 bigram Dice 只有
 * 0.17–0.53，而完全不同的一句是 0.17），机械相似度要么误删、要么漏掉，两头都不讨好。
 * **语义判断交给模型，判完由平台核对 `replaces` 是否真的存在**——这是这个仓库一贯的分工。
 */
export function renderExistingMemory(entries: readonly MemoryEntry[]): string {
  const alive = entries.filter((e) => e.removedAt === null)
  const lines = [
    `# 它现在已有的记忆（共 ${String(alive.length)} 条）`,
    '',
    '这些是它**已经记住的**。已经有同义的就不要再提一条新的；要改就提新的一版并在',
    '`replaces` 里写上下面**那一行的原文**（平台据此做"加一条 + 删旧的"）。',
    '',
  ]
  if (alive.length === 0) {
    lines.push('（还没有任何记忆）', '')
    return lines.join('\n')
  }
  for (const e of alive) lines.push(`- [${MEMORY_KIND_LABEL[e.kind]}] ${e.text}`)
  lines.push('')
  return lines.join('\n')
}

/**
 * 分析那一轮的任务（**平台写的**，不是人说的）。
 *
 * ★ 分批第 244 批：**规矩搬到智能体的身份里了**（`MEMORY_TIDY_INSTRUCTIONS`，可在
 *   「智能体」页查看与编辑）。这里只留这一轮特有的话：读哪份文件、只输出 JSON。
 *
 * 为什么这样分（D29 的老规矩）：身份 = 它长期怎么干活（该记什么、不记什么）；
 * 任务 = 这一轮要做什么。把可变的规矩写死在这里的后果是"用户改不了、出问题只能读代码"
 * ——而这恰恰是使用者提的那句"方便我查看其 prompt"要治的病。
 */
export function buildTidyPrompt(): string {
  return `读这个工作目录里的两份文件：
- \`transcript.md\`：一段完整对话的逐字记录；
- \`existing-memory.md\`：它**已经记住的**那些条目（可能为空）。

按你身份里那套规矩挑出候选。**已经有同义的就不要再提一条**；要改就提新的一版，并在
\`replaces\` 里写上旧条目原文（逐字照抄 \`existing-memory.md\` 里的那一行）。

只输出一个 JSON 数组（元素形如 {"kind":"…","text":"…","from":"人的原话","replaces":"旧条目原文"}），
不要解释、不要围栏。一条都挑不出就输出 \`[]\`——那是正常结果，不是失败。`
}

export type TidyCandidate = {
  kind: MemoryKind
  text: string
  /**
   * 它声称的**人的原话**（逐字）。`null` = 它没给。
   *
   * ★ 分批第 244 批加的字段：记忆的源头必须是**人的话**（使用者举的例子：他只说了
   *   一句"分析这个仓库，让我理解其做法"，平台却整理出了记忆——那是它自己查到的）。
   *   所以每条候选都要带出处，平台再**机械核对**一遍。
   */
  from: string | null
  /**
   * ★ 分批第 248 批：这条候选**提到这次对话的对象**了吗（比如调研的那个项目名）。
   *
   * 使用者第二次打回的正是这种：调研 Distilly 的对话里整理出「Distilly 本体就是一个 Skill」
   * 「解释 Distilly 时不要使用"编译器"这一比喻」——只在"又聊到 Distilly"时成立。
   * 身份里已经写了"要泛化"的规矩，但模型会犯懒，所以平台再给一记**机械提示**：
   * 候选正文里出现了**这段对话标题里的专名** ⇒ 标出来、界面默认不勾（人仍可亲手勾）。
   *
   * ⚠️ 这是**提示**不是判决：`pnpm`/`git`/`json` 这类到处都在的词不算专名（见 `UBIQUITOUS`），
   *    否则每一条都会被误标，人就不看这个标记了。
   */
  subjectSpecific: boolean
  /** 命中的那个专名（画在界面上："提到「Distilly」"）；没命中是 null。 */
  subjectTerm: string | null
  /**
   * ★ 分批第 251 批：它想**替换**的那条旧记忆（原文，逐字）。`null` = 纯新增。
   *
   * 语义只有一种：这条候选是某条已有记忆的**新版**。平台拿这段原文去库里核对：
   * 对得上 ⇒ 解析成 id，落库时"加新的 + 删旧的"（本平台唯一的改法）；对不上 ⇒ 当成新增，
   * 并在界面上如实说"它想替换的那条没找到"。
   */
  replaces: string | null
  /**
   * 出处核对的结果：`from` 那段原话**真的**在某个人的发言里（空白归一后是子串）。
   *
   * ⚠️ 为什么是平台核对而不是只写在提示词里：提示词写给模型看，模型会犯懒；
   *    核对写给平台自己看。对不上的候选**不删**（不该替人做决定），但界面上
   *    默认**不勾**，并明说"出处对不上"——这样"它自己编的"永远进不了记忆，
   *    除非人亲手勾上。
   */
  grounded: boolean
}

/**
 * 到处都在的词：它们出现在这段对话的标题里也不说明"这是这次的对象"。
 *
 * ⚠️ 这份清单**宁短不长**：长清单会让真正的专名（Distilly / acme-api）漏标，
 *    短清单只会多标几条（人看一眼就知道该不该勾）。漏标比误标坏。
 */
const UBIQUITOUS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'you', 'how', 'why', 'what',
  'json', 'yaml', 'html', 'css', 'http', 'https', 'url', 'api', 'cli', 'sdk',
  'git', 'npm', 'pnpm', 'yarn', 'node', 'deno', 'bun', 'deno', 'ts', 'js', 'md',
  'test', 'tests', 'dist', 'src', 'docs', 'readme', 'todo', 'ok', 'id', 'ui', 'ux',
  'web', 'app', 'apps', 'lib', 'bin', 'tmp', 'env', 'dev', 'prod', 'ci', 'pr',
])

/** 抽出"看起来是专名"的词：拉丁字母打头、至少 3 个字符（中文专名靠人看，机器不猜）。 */
function properNouns(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9_.-]{2,}/g)) {
    const raw = m[0].replace(/[.-]+$/, '')
    if (raw.length < 3 || UBIQUITOUS.has(raw.toLowerCase())) continue
    out.add(raw)
  }
  return [...out]
}

export type TidyParse = {
  /** 解析出来的候选（已去重、已剔除不合规的）。 */
  candidates: TidyCandidate[]
  /** 被剔掉的：让界面能如实说"它给了 5 条，2 条不合规"。 */
  dropped: Array<{ text: string; reason: string }>
  /** `false` = 它压根没按格式输出（这时 `candidates` 一定是空的）。 */
  parsed: boolean
}

const KINDS: readonly MemoryKind[] = ['preference', 'fact', 'lesson', 'commitment']

/** 把 ```json 围栏剥掉（模型十次有九次会加，剥掉比报错划算）。 */
function stripFences(text: string): string {
  return text
    .replace(/^\s*```(?:json|JSON)?\s*/m, '')
    .replace(/```\s*$/m, '')
    .trim()
}

/**
 * 从它的输出里取出候选。
 *
 * 容错顺序（**都试过**，不是只认一种）：
 *   ① 整段就是一个数组 → `JSON.parse`；
 *   ② 前后有废话 → 取第一个 `[` 到最后一个 `]`；
 *   ③ 连数组都没有、但一行一个对象 → 逐行 parse。
 * 全都不成 ⇒ `parsed: false`，界面就如实说"它没按要求输出"，**不假装挑到了 0 条**
 * （"挑不出"与"没看懂它说了什么"是两件事，混在一起会让人以为对话里没东西可记）。
 */
export function parseTidyOutput(
  text: string,
  /** 这段对话里**人**说过的所有话（用来核对 `from`；不给 ⇒ 一律算对不上）。 */
  humanTexts: readonly string[] = [],
  /** 这段对话的标题/对象（用来标出"只对这次成立"的候选；不给 ⇒ 不做这项检查）。 */
  subjectTexts: readonly string[] = [],
): TidyParse {
  const norm = (v: string): string => v.replace(/\s+/g, ' ').trim()
  const humanAll = humanTexts.map(norm).filter((v) => v !== '')
  const isGrounded = (from: string): boolean => {
    const q = norm(from)
    // 太短的摘录（"好""嗯"）核不出什么，按对不上处理——它挡不住任何编造
    if (q.length < 2) return false
    return humanAll.some((h) => h.includes(q))
  }
  const dropped: Array<{ text: string; reason: string }> = []
  const body = stripFences(text)

  let raw: unknown[] | null = null
  const tryParse = (candidate: string): unknown => {
    try {
      return JSON.parse(candidate) as unknown
    } catch {
      return null
    }
  }
  const whole = tryParse(body)
  if (Array.isArray(whole)) raw = whole
  if (raw === null) {
    const start = body.indexOf('[')
    const end = body.lastIndexOf(']')
    if (start >= 0 && end > start) {
      const sliced = tryParse(body.slice(start, end + 1))
      if (Array.isArray(sliced)) raw = sliced
    }
  }
  if (raw === null) {
    // 一行一个对象：`{"kind":…}` 逐行收（有些模型会一条一行地吐，不加外层数组）
    const lineWise: unknown[] = []
    for (const line of body.split('\n')) {
      const trimmed = line.trim().replace(/,$/, '')
      if (!trimmed.startsWith('{')) continue
      const parsed = tryParse(trimmed)
      if (parsed !== null && typeof parsed === 'object') lineWise.push(parsed)
    }
    if (lineWise.length > 0) raw = lineWise
  }
  if (raw === null) return { candidates: [], dropped, parsed: false }

  const candidates: TidyCandidate[] = []
  const seen = new Set<string>()
  // 这段对话的"对象专名"（标题里出现的、不像通用词的拉丁词）
  const subjectTerms = new Set<string>()
  for (const t of subjectTexts) for (const noun of properNouns(t)) subjectTerms.add(noun.toLowerCase())
  for (const item of raw) {
    const row = item as { kind?: unknown; text?: unknown; from?: unknown; replaces?: unknown } | null
    const kind = typeof row?.kind === 'string' ? row.kind.trim() : ''
    const text = typeof row?.text === 'string' ? row.text.trim() : ''
    const fromRaw = typeof row?.from === 'string' ? row.from.trim() : ''
    const replacesRaw = typeof row?.replaces === 'string' ? row.replaces.trim() : ''
    if (!KINDS.includes(kind as MemoryKind)) {
      if (text !== '' || kind !== '') dropped.push({ text: text || kind, reason: 'kind_invalid' })
      continue
    }
    if (text === '') {
      dropped.push({ text: '（空正文）', reason: 'text_empty' })
      continue
    }
    if (text.length > MEMORY_TEXT_MAX) {
      dropped.push({ text: text.slice(0, 40), reason: 'text_too_long' })
      continue
    }
    const secret = looksLikeSecret(text)
    if (secret !== null) {
      dropped.push({ text: text.slice(0, 40), reason: 'looks_like_secret' })
      continue
    }
    // 去重：同一句话换个类型不算两条（"别用 npm"记两遍只会挤掉别的）
    const key = text.replace(/\s+/g, ' ')
    if (seen.has(key)) continue
    seen.add(key)
    if (candidates.length >= TIDY_MAX_CANDIDATES) {
      dropped.push({ text: text.slice(0, 40), reason: 'too_many' })
      continue
    }
    const hit = properNouns(text).find((noun) => subjectTerms.has(noun.toLowerCase())) ?? null
    candidates.push({
      kind: kind as MemoryKind,
      text,
      from: fromRaw === '' ? null : fromRaw,
      grounded: fromRaw === '' ? false : isGrounded(fromRaw),
      subjectSpecific: hit !== null,
      subjectTerm: hit,
      replaces: replacesRaw === '' ? null : replacesRaw,
    })
  }
  return { candidates, dropped, parsed: true }
}
