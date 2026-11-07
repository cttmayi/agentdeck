/**
 * 从"人手动改过的那一小段"里猜一条词典规则（分批第 280 批）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 这个功能要解决的那件具体事
 * ══════════════════════════════════════════════════════════════════
 *
 * 离线 ASR 错得最有规律的地方是**专有名词**："微思普"（Whisper）、"agents deck"。
 * 而这些错法在词典里补一条就再也不犯了。问题是：让使用者自己去想"它会被听成什么"
 * 很难——他只知道"我改了一下"。
 *
 * 所以：识别结果填进输入框之后，如果人**手动改了**，就把改的那一段捞出来，
 * 提议「把『微思普』记成『Whisper』」。改的痕迹是现成的，不需要他再描述一遍。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么用"最长公共前后缀"，而不是真正的 diff
 * ══════════════════════════════════════════════════════════════════
 *
 * 这是一条**建议**，不是自动改写：错一次就写进词典的规则，会污染之后所有识别（而它
 * 看起来像"模型学会了"）。所以这里刻意只做最保守的判断：
 *
 *   · 去掉两段文字**共同的头部与尾部**，剩下的中间那一截就是"被改掉的部分"；
 *   · 中间那截必须**两边都不为空、都不太长、不跨标点**——否则说明这是一次大改写
 *     （人重写了半句话），那不是"某个词听错了"，不该生成规则；
 *   · 拿不准就返回 `null`（**宁可不提议，也不要提议一条错的规则**）。
 */

/** 一条建议的规则与它的来源（界面上要能说清"这是从哪次改动里来的"）。 */
export interface RuleSuggestion {
  from: string
  to: string
}

/**
 * 单边最多这么长。
 *
 * ★ 与 `VOCAB_FIELD_MAX`（60）同一个量级但更短：一次"词被听错"的改动通常就是几个字，
 *   而长串更可能是句子级改写——那种改动不该变成全局替换规则（它会命中别处的正常文字）。
 */
const MAX_SPAN = 24

/**
 * 出现这些字符就说明不是"一个词被听错"，而是句子级改写（标点、换行）。
 *
 * ⚠️ **空格不算**：`agent deck`（被切成两个词）恰恰是最常见的专有名词错法——
 *   把空格也排除掉，就等于把最该抓的那一类挡在门外（第一版就是这么写的，测试当场红）。
 *   句子里只有空格的分隔用下面"最多几个词"来挡。
 */
const NOT_A_WORD = /[，。！？；：、,.!?;:"'“”‘’（）()【】\[\]…—－\n\r\t]/

/** 最多几个词：`agent deck`（2 个词）该抓；一大串只有空格的改写不该变成全局规则。 */
const MAX_WORDS = 3

/**
 * 切成"词"：中文按**单字**、英文/数字按**连写的词**、空白单独成为一个 token。
 *
 * ★ 为什么中文要按字切：中文没有空格，而听错的往往是两三个字的词（"微思普"）。
 *   按字切之后，"我|用|微|思|普" 与 "我|用|Whisper" 的差异就是一段连续的
 *   "微思普 → Whisper"，正好是要的那条规则。
 */
function tokenize(text: string): string[] {
  return text.match(/[\u3400-\u9fff\uff00-\uffef]|[A-Za-z0-9_'.\-]+|\s+|[^\s]/g) ?? []
}

/**
 * 从 `before`（识别出来的原样）到 `after`（人改完的）里提一条候选规则。
 *
 * 做法是**词级**最长公共子序列：把两边切成词，找出"没变的那部分"，剩下**一处**
 * 连续的改动就是候选。为什么不做逐字符 diff：`agent deck` → `AgentDeck` 在字符层面
 * 会碎成好几处（大小写、空格去哪了），逐字符法会提出 `agent d` → `AgentD` 这种
 * 半截规则（第一版就是这么错的，测试当场抓到）。
 *
 * 返回 null 的四种情况（都是"宁可少提议"）：
 *   · 没有改动 / 只改了空白；
 *   · 改动**不止一处**（那是重写了句子，不是某个词听错）；
 *   · 改动跨标点 / 太长 / 词太多（那不是词，是句子）；
 *   · 只有大小写不同（把它当规则会改掉所有同名小写词）。
 */
export function suggestRule(before: string, after: string): RuleSuggestion | null {
  if (before === '' || after === '' || before === after) return null

  const a = tokenize(before)
  const b = tokenize(after)
  // 词级 LCS 表（句子长度量级：几百个 token，DP 足够快）
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  )
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }

  // 沿 DP 走一遍，把"改动段"收集起来（保留未变的部分作为锚点）
  const hunks: Array<{ from: string; to: string }> = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1
      j += 1
      continue
    }
    const endA = dp[i + 1]![j]!
    const endB = dp[i]![j + 1]!
    // 收集一段连续的改动，直到重新对齐
    let from = ''
    let to = ''
    while (i < a.length && j < b.length && a[i] !== b[j]) {
      if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
        from += a[i]
        i += 1
      } else {
        to += b[j]
        j += 1
      }
    }
    // 长度相同但内容不同的尾巴也要吃进这一段（大小写、错字这类替换）
    while (i < a.length && j < b.length && a[i] !== b[j] && endA === dp[i + 1]![j] && endB === dp[i]![j + 1]) {
      from += a[i]
      to += b[j]
      i += 1
      j += 1
    }
    hunks.push({ from, to })
  }
  // 尾部剩下的（一边长一边短）
  if (i < a.length) hunks.push({ from: a.slice(i).join(''), to: '' })
  if (j < b.length) hunks.push({ from: '', to: b.slice(j).join('') })

  // 只认"一处、两边都不空、且不是纯空白"的改动
  const real = hunks.filter((h) => h.from.trim() !== '' || h.to.trim() !== '')
  if (real.length !== 1) return null
  const from = (real[0]?.from ?? '').trim()
  const to = (real[0]?.to ?? '').trim()
  if (from === '' || to === '') return null
  if (from === to) return null
  // 只有大小写不同 ⇒ 不提议（那会变成"把所有同名小写词都改掉"的规则）
  if (from.toLowerCase() === to.toLowerCase()) return null
  if (from.length > MAX_SPAN || to.length > MAX_SPAN) return null
  if (NOT_A_WORD.test(from) || NOT_A_WORD.test(to)) return null
  if (wordCount(from) > MAX_WORDS || wordCount(to) > MAX_WORDS) return null
  return { from, to }
}

/** 数一下有几"块"（按空白切分；中文没有空格，整串算一块）。 */
function wordCount(span: string): number {
  return span.split(/\s+/).filter((x) => x !== '').length
}

/**
 * 判断这条建议值不值得问人：
 *
 * 只改了一次、而且改动是"一个词换一个词"才问。人连着改三处时，界面已经被他的操作
 * 占满了——那时再弹一条建议只会添乱（他可以在设置里自己加规则）。
 */
export function suggestionWorthAsking(suggestion: RuleSuggestion | null): suggestion is RuleSuggestion {
  return suggestion !== null
}
