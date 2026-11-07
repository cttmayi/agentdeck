/**
 * 从**当前对话**里抽"识别时值得提醒模型的词"（分批第 286 批）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么这条路走得通（有实测支撑）
 * ══════════════════════════════════════════════════════════════════
 *
 * ASR 最典型的错法，是把**标识符**拆开或拼错：
 *
 *   `AgentDeck`   →  "Agent Deck"      （拆成两个词）
 *   `distilly`    →  "Distly"
 *   `wiki-capture`→  "Wiki Capture"
 *
 * 而 whisper 的 `initialPrompt` 恰好能治这个：实测"只放 3 个标识符"时，
 * `AgentDeck`/`distilly` 都听对了（不放则全错）。所以**词从对话里抽出来喂回去**是有道理的。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么用正则 + 词频，而不是让模型抽
 * ══════════════════════════════════════════════════════════════════
 *
 * ① prompt 是**偏置**：偏置错了不是"少帮一点"，而是会把一句正常的话听坏
 *    （实测：加了词之后 `我下午把` 被听成 `我下无法规及`）。所以它必须可解释、可复现、
 *    可关闭——这三条正则都给得了，模型都给不了。
 * ② 延迟：录音这条路上，"说完等一秒"是硬要求；一次 run 是十几秒。
 * ③ 目标很窄：只要"标识符形状"的东西，正字法是确定的，正则在这类目标上准确率很高。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么**不抽中文**
 * ══════════════════════════════════════════════════════════════════
 *
 * 没有分词器时，中文抽词最容易误伤（"这个仓库"会被抽成词，然后每句话都被往那儿带）。
 * 中文专名要用的话，得另有证据（比如它已经出现在记忆或 wiki 里）——那是另一件事。
 */

/** 最多取多少条消息做素材（再往前翻没什么收益，而 prompt 预算本来就紧）。 */
export const CONTEXT_MESSAGE_LIMIT = 20
/** 最多抽多少个词（与 `PROMPT_CHAR_BUDGET` 一起卡住"别把 prompt 塞满"）。 */
export const CONTEXT_TERM_LIMIT = 12

/**
 * "标识符形状"的四种正则——命中任一即候选。
 *
 * ⚠️ 这四条要**同时**是"窄"的：`/^[A-Za-z]+$/` 那种宽泛规则会把 `model`、`test`
 *   这类通用词也抽进来，而它们进 prompt 只会把普通话说成术语。
 */
const SHAPES: readonly RegExp[] = [
  // 带分隔符：whisper.cpp / wiki-capture / SKILL.md / base-q5_1 / @agentdeck/daemon
  /[A-Za-z][A-Za-z0-9]*(?:[./_-][A-Za-z0-9]+)+/,
  // camelCase：openConversation
  /[a-z]+[A-Z][A-Za-z0-9]*/,
  // PascalCase：AgentDeck
  /[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+/,
  // 缩写：VAD / ASR / TUI
  /\b[A-Z][A-Z0-9]{1,5}\b/,
]

/** 常见英文词（进 prompt 只会挤占预算）。 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'http', 'https', 'www',
  'com', 'net', 'org', 'md', 'json', 'yaml', 'toml', 'html', 'css', 'ts', 'tsx', 'js',
  'not', 'you', 'are', 'was', 'can', 'all', 'one', 'two', 'use', 'set', 'get', 'has',
  'api', 'url', 'uri', 'id', 'ok', 'app', 'src', 'lib', 'bin', 'run', 'new', 'old',
])

/**
 * 常见英文词（小写、无分隔符）的**白名单反面**：这些词不该进 prompt。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么需要一份词表，而不是"小写词一律不抽"
 * ══════════════════════════════════════════════════════════════════
 *
 * 项目里最该被提醒的标识符，很多是**全小写的自造词**：`distilly`、`whisper`。
 * 它们既没有大写、也没有分隔符，靠"形状"识别不出来；"出现两次才算"又会漏掉只提过
 * 一次的（初次提到的那个词恰恰最需要帮助）。
 *
 * 所以反过来做：**默认允许**，用一份常见词表把它们挡在外面。代价是词表要维护；
 * 收益是"自造词"这条路通了，而 `model`/`test`/`commit` 这类依然进不来。
 *
 * ⚠️ 词表只收**高频道词 + 开发里天天见的通用词**。漏一个（比如某个生僻通用词被当成
 *   候选）不会出事——它最多让 prompt 多一个词；而把 `model` 放进去才是真危险
 *   （会让普通话说成术语）。
 */
const COMMON_ENGLISH = new Set(
  (
    // 高频功能词
    'the and for with this that these those there here what when where which who why how ' +
    'all any both each few more most some such only own same than too very just also then ' +
    'once again ever never always often still yet even well back out off over under about ' +
    'after before between during through without within across along around behind below ' +
    'beside beyond down into onto upon from than else either neither nor so if while because ' +
    'though unless until since as like near far ' +
    // 高频实词
    'new old big small long short high low right left front real sure many much little large ' +
    'great hard easy free full half whole part side kind sort form point place thing word way ' +
    'time date day week month year hour minute second today tomorrow yesterday next last first ' +
    'best good bad better worse need want make take give find keep hold call send show tell ask ' +
    'put set get let may must can will shall should would could have has had been being ' +
    'does did done doing ' +
    // 开发里天天见、进 prompt 只会坏事
    'model models test tests commit commits merge branch branches style styles cache deploy ' +
    'timeout log logs reply replies receipt receipts probe probes fixture fixtures assert ' +
    'budget scene scenes permission permissions protocol entity entities route routes ' +
    'endpoint endpoints handler handlers service services module modules package packages ' +
    'version versions config configs setting settings option options value values type types ' +
    'data file files code line lines name names list lists item items page pages case cases ' +
    'home work works read write writes update updates delete deletes create creates build ' +
    'builds run runs start starts stop stops open opens close closes load loads save saves ' +
    'error errors warn warns info notes note please thanks thank hello okay ok yes no not ' +
    'need needs want wants like likes look looks try tries check checks use uses used using ' +
    'true false null none void main app apps api apis url urls uri path paths dir dirs ' +
    'json yaml toml http https local remote server client user users admin root core utils ' +
    'src lib bin dist tmp temp cache caches docs doc readme license lock ' +
    // 常见形容词/副词/动词变形——它们最容易以"4 个字母以上的小写词"混进来
    'fine again pass fails failed okay sure idea ideas issue issues still just also only even ' +
    'much many same done says said goes went come came gave took made saw seen look looks ' +
    'think know knew wants gets got puts lets saying told asked found kept called later early ' +
    'quick slow fast whole partly maybe perhaps almost enough whatever someone something ' +
    'anything nothing everything everyone anyone nobody somebody because although however ' +
    'therefore instead besides otherwise meanwhile finally anyway indeed actually really ' +
    'probably possibly certainly definitely exactly simply usually normally mostly respect ' +
    'regard regards thanks hello welcome sorry please compare please compare simple complex ' +
    'important different similar possible various several common general special normal ' +
    'specific total single double extra final initial latest current recent previous ' +
    // 开发通用词（进 prompt 只会把普通话说成术语）
    'debug release feature features bug bugs review revert rebase stash tag tags repo repos ' +
    'clone push pull fetch diff patch hook hooks lint theme color colors layout width height ' +
    'margin padding font fonts icon icons button buttons label labels table tables panel ' +
    'panels modal dialog drawer menu sidebar header footer content body text title message ' +
    'messages event events state states store stores action actions query result results ' +
    'output outputs parse format encode decode hash token tokens auth session sessions ' +
    'cookie request requests response responses status level levels mode modes flag flags ' +
    'env vars port host hostname domain proxy socket stream streams buffer queue worker ' +
    'thread threads async await promise callback listener emitter plugin plugins loader ' +
    'parser encoder decoder adapter factory registry resolver router middleware schema ' +
    'schemas index indexes key keys id ids uuid ulid sha md5 base64 utf8 webhook payload ' +
    'prompt prompts skill skills agent agents model models token tokens limit limits'
  ).split(/\s+/).filter((w) => w !== ''),
)

/** 单个 token 的长度界限（太长的是句子，太短的是噪声）。 */
const MIN_LEN = 3
const MAX_LEN = 40

export interface ExtractOptions {
  limit?: number
}

/**
 * 从若干段文本里抽出候选词。
 *
 * 打分 = 出现次数 × (含大写或分隔符 ? 2 : 1) × (出自你说的话 ? 1.5 : 1)。
 * 这里只传"你说的话"，所以第三项恒为 1.5 —— 但函数保留它，**将来接 agent 输出时
 * 直接降权**（那是唯一需要动这里的地方）。
 *
 * ⚠️ 通用**小写**词要求出现 ≥2 次才算（`model` 出现一次就进 prompt 太危险）。
 */
export function extractContextTerms(
  texts: readonly string[],
  options: ExtractOptions = {},
): string[] {
  const limit = options.limit ?? CONTEXT_TERM_LIMIT
  const seen = new Map<string, { term: string; count: number; shaped: boolean }>()

  for (const text of texts.slice(-CONTEXT_MESSAGE_LIMIT)) {
    for (const raw of splitTokens(text)) {
      const token = trimToken(raw)
      if (token.length < MIN_LEN || token.length > MAX_LEN) continue
      if (STOPWORDS.has(token.toLowerCase())) continue
      if (/^\d+$/.test(token)) continue
      // 长十六进制（hash / 会话 id）：进 prompt 毫无用处，还占预算
      if (/^[0-9a-f]{16,}$/i.test(token)) continue
      const shaped = SHAPES.some((re) => re.test(token)) || /[A-Z]/.test(token)
      const key = token.toLowerCase()
      const cur = seen.get(key) ?? { term: token, count: 0, shaped }
      cur.count += 1
      // 后来的写法里带大写/分隔符的，用它当"正字"（`agentdeck` 之后出现 `AgentDeck` 时取后者）
      if (!cur.shaped && shaped) {
        cur.term = token
        cur.shaped = true
      }
      seen.set(key, cur)
    }
  }

  return [...seen.values()]
    /**
     * 准入规则（两条择一）：
     *   ① **形状**像标识符（大写 / 分隔符 / 缩写）；
     *   ② 或：**全小写但不在常见词表里、且 ≥4 个字母** —— 这一条是给 `distilly`
     *      这类"自造词"留的路（见 `COMMON_ENGLISH` 那段说明）。
     */
    .filter((c) => c.shaped || (!COMMON_ENGLISH.has(c.term.toLowerCase()) && c.term.length >= 4))
    .map((c) => ({ term: c.term, score: c.count * (c.shaped ? 2 : 1) * 1.5 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((c) => c.term)
}

/** 按空白与中英文标点切（保留 `@ . - _ /` 这些标识符里会出现的字符）。 */
function splitTokens(text: string): string[] {
  return text.split(/[\s（）()［］\[\]{}，。、；：！？「」『』"'`*]+/).filter((x) => x !== '')
}

/** 去掉首尾的杂字符（引号、括号、句点收尾等），但**保留内部**的分隔符。 */
function trimToken(token: string): string {
  return token
    .replace(/^[^\w@]+/, '')
    .replace(/[^\w+-]+$/, '')
    .replace(/^@+$/, '')
}
