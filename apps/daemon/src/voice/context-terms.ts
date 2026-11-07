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
 * 两个来源，两套门槛（分批第 287 批，使用者定的）
 * ══════════════════════════════════════════════════════════════════
 *
 * 原话："「全小写自造词要 ≥2 次」这个我想只用在用户的语句中，大模型的答复不需要，
 *       因为只有用户会输出错误。"
 *
 * 这条判断是对的，而且它顺带让"模型回复"成了一个**有价值的补充来源**：
 *   · **你说的话**：可能有拼写错（`samll` 这种），所以全小写自造词要出现 **≥2 次**
 *     才算"这是你真在用的词"；
 *   · **模型的回复**：已经整理过，**全小写词出现一次就够**。
 *     ⚠️ 代价是英文散文里的普通词会混进来（实测出现过 `Prize`/`Pong`）⇒
 *     用 `COMMON_ENGLISH` 那张词表兜（`prize`/`pong`/`however`… 都在里面），
 *     并且模型的权重低于用户（1.0 vs 1.5）。
 *
 * 打分上用户永远优先（1.5 vs 1.0）：要识别的是你的嘴，模型只是补充你没说全的词。
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
    'prompt prompts skill skills agent agents model models token tokens limit limits ' +
    'prize prizes pong notion memo file files read reads write writes email emails ' +
    'answer answers question questions paper papers article articles author authors ' +
    'book books chapter chapters section sections figure figures table tables image images ' +
    'github gitlab pdf docx pptx csv xlsx url link links site website blog post posts ' +
    // 缩写形态的通用词（它们"长得像标识符"，但进 prompt 只会把普通话说成术语）
    'llm llms gpt ai agi mcp rag rl sdk cli ide api apis url urls uri ui ux os vm cpu gpu ' +
    'ram ssd usb pdf csv svg png jpg jpeg gif webp mp3 mp4 wav git github gitlab npm pnpm ' +
    'yarn node deno html css json yaml toml xml sql http https ftp dns tcp udp ' +
    // 模型回复里"首字母大写但其实是普通词"的那一批（实测：Agentic / Workflow 混进来过）
    'agentic workflow workflows session sessions memory memories context contexts runtime ' +
    'plugin plugins template templates overview overviews summary summaries appendix ' +
    'example examples sample samples result results output outputs input inputs ' +
    'money cost costs price prices time times day days week weeks month months year years ' +
    'goes went come came take takes give gives says said tell tells know knows think thinks'
  ).split(/\s+/).filter((w) => w !== ''),
)

/** 单个 token 的长度界限（太长的是句子，太短的是噪声）。 */
const MIN_LEN = 3
const MAX_LEN = 40

export interface ExtractOptions {
  limit?: number
}

/** 抽词的素材：**你说的话** + **模型在这个对话里的回复**（后者可省略）。 */
export interface ContextSources {
  userTexts: readonly string[]
  agentTexts?: readonly string[]
}

/** 模型来源最多补几个词（它的输出量级比你的话大得多，不设上限会挤掉你说的词）。 */
export const AGENT_TERM_LIMIT = 3
/** 模型来源的词最多这么长（更长的多半是文件名 / 路径）。 */
const AGENT_TERM_MAX = 24

/**
 * 从对话里抽候选词。两条准入线分开（见文件头那段说明）：
 *
 *   · **你说的话**：强形状出现 1 次即可；**全小写自造词要出现 ≥2 次**
 *     （只有人会打错字，`samll` 这种一次不算数）。
 *   · **模型的回复**：只收**强形状**，而且排除
 *     路径（含 `/`）、引用（含 `:`）、文件名（`.md`/`.png` 结尾）、超长的，
 *     并且最多补 {@link AGENT_TERM_LIMIT} 个。
 *     ⚠️ 为什么这么严：模型的输出里有大量路径与散文（实测 `doc/image/…-flow.svg`、
 *     `Agentic`、`recap`、`unittest`）——它们是"写下来的字"，不是"会说出口的名字"。
 *     放开它们的代价是把整份 prompt 灌满，而一个正确的专名都听不回来。
 *
 * 排序：**你说过的词永远在前**（按出现次数、再按新鲜度），模型的补充词排在后面。
 */
export function extractContextTerms(
  sources: ContextSources | readonly string[],
  options: ExtractOptions = {},
): string[] {
  const limit = options.limit ?? CONTEXT_TERM_LIMIT
  // 兼容旧调用（只给一串用户文本）
  const userTexts: readonly string[] = Array.isArray(sources)
    ? (sources as readonly string[])
    : (sources as ContextSources).userTexts
  const agentTexts: readonly string[] = Array.isArray(sources)
    ? []
    : ((sources as ContextSources).agentTexts ?? [])

  /** 用户来源的词：`{ term, count, strong, freshness }`。 */
  const fromUser = new Map<string, { term: string; count: number; strong: boolean; fresh: number }>()
  for (const { token, fresh } of tokenize(userTexts)) {
    const strong = isStrongShape(token)
    const key = token.toLowerCase()
    const cur = fromUser.get(key) ?? { term: token, count: 0, strong, fresh }
    cur.count += 1
    if (strong && !cur.strong) {
      cur.term = token
      cur.strong = true
    }
    cur.fresh = Math.max(cur.fresh, fresh)
    fromUser.set(key, cur)
  }

  /** 用户来源的准入：强形状 1 次；全小写自造词 ≥2 次。 */
  const userTerms = [...fromUser.values()]
    .filter((c) => c.strong || c.count >= 2)
    .sort((a, b) => b.count - a.count || b.fresh - a.fresh)
  const taken = new Set(userTerms.map((c) => c.term.toLowerCase()))

  /** 模型来源：只收强形状，且不是路径 / 引用 / 文件名（见上面那段"为什么这么严"）。 */
  const fromAgent = new Map<string, { term: string; count: number; fresh: number }>()
  for (const { token, fresh } of tokenize(agentTexts)) {
    if (!isStrongShape(token)) continue
    if (token.includes('/') || token.includes(':') || /\.[a-z]{2,5}$/i.test(token)) continue
    if (token.length > AGENT_TERM_MAX) continue
    const key = token.toLowerCase()
    if (taken.has(key)) continue
    const cur = fromAgent.get(key) ?? { term: token, count: 0, fresh }
    cur.count += 1
    cur.fresh = Math.max(cur.fresh, fresh)
    fromAgent.set(key, cur)
  }
  const agentTerms = [...fromAgent.values()]
    .sort((a, b) => b.count - a.count || b.fresh - a.fresh)
    .slice(0, AGENT_TERM_LIMIT)

  return [...userTerms, ...agentTerms].slice(0, limit).map((c) => c.term)
}

/** 强形状 = 带分隔符 / camelCase / PascalCase / 缩写 / 含大写字母。 */
function isStrongShape(token: string): boolean {
  return SHAPES.some((re) => re.test(token)) || /[A-Z]/.test(token)
}

/** 把若干段文本切成候选 token（含"这算不算词"的过滤，返回 token 与"多新鲜"）。 */
function tokenize(texts: readonly string[]): Array<{ token: string; fresh: number }> {
  const out: Array<{ token: string; fresh: number }> = []
  const window = texts.slice(-CONTEXT_MESSAGE_LIMIT)
  const span = Math.max(1, window.length - 1)
  window.forEach((text, index) => {
    const fresh = index / span
    for (let raw of splitTokens(text)) {
      // ★ URL 只取**最后一段路径**：`…/ar9av/obsidian-wiki` → `obsidian-wiki`
      //   （整条 URL 进 prompt 毫无用处，而末段正是你会说出口的那个名字）
      if (raw.includes('://')) {
        const segs = raw.split('://')[1]?.split('/').filter((x) => x !== '') ?? []
        raw = segs.at(-1) ?? raw
      }
      const token = trimToken(raw)
      if (token.length < MIN_LEN || token.length > MAX_LEN) continue
      if (STOPWORDS.has(token.toLowerCase())) continue
      if (COMMON_ENGLISH.has(token.toLowerCase())) continue
      if (/^\d+$/.test(token)) continue
      // `N=1`、`x<3` 这类是表达式不是名字；`1800×1306` 是图尺寸
      if (/[=<>*()]/.test(token)) continue
      if (/[0-9]+[×x][0-9]+/.test(token)) continue
      // 长十六进制（hash / 会话 id）：进 prompt 毫无用处
      if (/^[0-9a-f]{16,}$/i.test(token)) continue
      out.push({ token, fresh })
    }
  })
  return out
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
