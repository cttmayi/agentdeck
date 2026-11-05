import type { MemoryKind } from '@agentdeck/protocol'
import { MEMORY_TEXT_MAX, looksLikeSecret } from './memory.ts'

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
 * 分析那一轮的任务（**平台写的**，不是人说的）。
 *
 * 三条刻意的约束：
 *   ① **只输出 JSON**——后面要机器解析。含糊的"自由发挥"会让解析器去猜，而猜错
 *      的表现是"整理出来的记忆答非所问"，比没有更糟。
 *   ② **不许多写"这次做了什么"**——那是 run 日志，不是记忆。记忆的判据是"下次还用得上"。
 *   ③ **不给凭据**：这段正文会被写进记忆、每轮发给 CLI，抄进 token 等于自己泄露。
 */
export function buildTidyPrompt(): string {
  return `读 \`transcript.md\`（就在这个工作目录里，是一段完整对话）。请从**整段对话**里挑出
值得它以后长期记住的判断，输出成 JSON。

什么值得记（判据是「**下次还用得上**」，不是「这次做了什么」）：
- \`preference\`：人怎么要求它的（说话方式、格式偏好、"别用某类词"）。
- \`fact\`：环境与项目里稳定的、它下次也会碰到的事实（用什么命令、目录结构、约定）。
- \`lesson\`：这次踩过的坑与正确的做法（"别直接改 dist，改完要重新构建"）。
- \`commitment\`：人明确要它以后一直守的约定（"报告里不许出现 XX"）。

什么不该记：这次的具体任务与进度（"改了第 3 行"）、一次性的请求、它的客套话、
以及人没说过的任何推测。也**不要**记任何凭据、token、密钥的值。

要求：
- 最多 ${String(TIDY_MAX_CANDIDATES)} 条，宁可少不要凑；一条都挑不出就输出 \`[]\`。
- 每条写成**下次也成立**的独立陈述句（不带"这次""刚才"这类指代），不超过 ${String(MEMORY_TEXT_MAX)} 字。
- **只输出一个 JSON 数组**，不要解释、不要前后缀、不要代码块围栏。元素形状：
  {"kind":"preference|fact|lesson|commitment","text":"……"}

直接开始。`
}

export type TidyCandidate = { kind: MemoryKind; text: string }

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
export function parseTidyOutput(text: string): TidyParse {
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
  for (const item of raw) {
    const row = item as { kind?: unknown; text?: unknown } | null
    const kind = typeof row?.kind === 'string' ? row.kind.trim() : ''
    const text = typeof row?.text === 'string' ? row.text.trim() : ''
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
    candidates.push({ kind: kind as MemoryKind, text })
  }
  return { candidates, dropped, parsed: true }
}
