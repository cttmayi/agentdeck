import type { TextCatalog } from '../text.ts'

/**
 * ⚠️ 这份词表由**它负责的那几个文件**填充（见 web/index.ts 的注释）。
 *
 * 负责：`components/RunLog.svelte`（`runs.*`）、`components/Drawer.svelte`（`drawer.*`）。
 * `App.svelte` 的外壳里没有直接写死的中文（见文件末尾的说明），所以没有 `app.*`。
 *
 * ⚠️ zh 的值**必须与迁移之前逐字一致**：中文是这个项目的默认语言，也是所有既有
 *    测试、布局探针与文档断言的依据——改一个字就会有东西变红。
 */
export const runsText = {
  // ── RunLog.svelte：工具条（思考过程的显示开关与说明）───────────────
  // 原来是一个三元表达式拼出来的：`'隐藏' / '显示'` + `思考过程（N 段）`。
  // 拆成两条**完整句子**而不是"一个动词 + 一个名词"——英文里动词和名词的
  // 组合不像中文那样能直接拼（Hide thinking / Show thinking 才是对的）。
  'runs.hideThinking': { zh: '隐藏思考过程（{count} 段）', en: 'Hide thinking ({count} blocks)' },
  'runs.showThinking': { zh: '显示思考过程（{count} 段）', en: 'Show thinking ({count} blocks)' },
  // zh 里的 `**` 是**原样显示**的（那句话不在 markdown 里渲染），所以逐字保留；
  // 英文侧不写这层标记——它本来就不是排版，只是历史遗留。
  'runs.thinkingNote': {
    zh: '思考过程是模型的内部推理，**不是**它给你的回答——两者在下面用样式区分',
    en: "Thinking is the model's internal reasoning, not its answer to you — the two are styled differently below.",
  },
  'runs.thinkingTag': { zh: '思考', en: 'Thinking' },
  'runs.thinkingOnlyHidden': {
    zh: '（当前只隐藏了思考过程，没有别的输出）',
    en: '(only thinking is hidden right now; there is no other output)',
  },
  'runs.waitingOutput': { zh: '等待输出…', en: 'Waiting for output…' },

  // ── RunLog.svelte：长输入 / 输出的折叠 ────────────────────────────
  'runs.collapsePayload': { zh: '收起', en: 'Collapse' },
  'runs.expandPayload': { zh: '展开全部（{count} 字符）', en: 'Expand all ({count} chars)' },
  'runs.outputTruncated': {
    zh: '（这段输出在采集时已被截断，原文更长）',
    en: '(this output was truncated during collection; the original is longer)',
  },

  // ── RunLog.svelte：日志行（这些是**命令式**写进去的，用 `tx`）──────
  // 每一行都是"标签 + 接口给的值"：标签翻译，**值原样**（`completed`、run kind
  // 那些是契约值，翻了会让日志和库里对不上）。
  'runs.logDisconnected': {
    zh: '连接中断，正在重连…（若一直重连，多半是 daemon 停了）',
    en: 'Connection lost, reconnecting… (if it keeps reconnecting, the daemon is probably stopped)',
  },
  'runs.logStatus': { zh: '状态：{status}', en: 'Status: {status}' },
  'runs.logProgress': { zh: '{summary}（{step}/{total}）', en: '{summary} ({step}/{total})' },
  'runs.logUsage': {
    zh: '用量：输入 {input} / 输出 {output} / 成本 ${cost}（{source}）',
    en: 'Usage: input {input} / output {output} / cost ${cost} ({source})',
  },
  'runs.costSourceProvider': { zh: 'provider 上报', en: 'reported by provider' },
  'runs.costSourceEstimated': { zh: '估算', en: 'estimated' },
  'runs.logFinished': { zh: '结束：{status}', en: 'Finished: {status}' },
} as const satisfies TextCatalog
