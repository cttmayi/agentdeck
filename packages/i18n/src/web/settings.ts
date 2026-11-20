import type { TextCatalog } from '../text.ts'

/**
 * 设置抽屉（`apps/web/src/components/SettingsDrawer.svelte`）与通知抽屉
 * （`apps/web/src/components/InboxDrawer.svelte`）。
 *
 * ⚠️ 两个抽屉共用这一份词表（键的前缀区分：`settings.*` / `inbox.*`）——它们都从
 *    顶栏打开、都是"抽屉"，改文案时在同一处找得到。
 *
 * ⚠️ zh 的值改之前先看一眼**有没有东西钉着它**：中文是默认语言，既有测试、布局
 *    探针与文档都引用它。⚠️ 但"与迁移之前逐字一致"**不再是判据**（2026-09 的文案
 *    改写把那批文字按"这句话是给谁看的"重写了一遍：去掉开发口径、机器取值与
 *    markdown 残留）。有引用就一起改，没有就按读者改。
 *
 * ⚠️ 被 `<strong>` 拆开的句子按 `…Before` / `…Strong` / `…After` 分段（标记里的
 *    粗体结构原样保留）：分段值里的空格与标点是**渲染结果的一部分**，拼接后必须
 *    与原来那段一字不差。以英文单词结尾/开头的那几段首尾各带一个空格，不是笔误。
 */
export const settingsText = {
  // ★ 2026-11（使用者立项）：设置从右侧抽屉改为**主窗口视图**（侧栏「设置」项）。
  'settings.navTitle': { zh: '设置', en: 'Settings' },
  // ⚠️ 侧栏减半纪律：辅助文字 4–6 个字、一行放得下。
  'settings.navHint': { zh: '主题 · 语言', en: 'Theme · language' },
  'settings.headIntro': {
    zh: '这一台怎么配：主题、语言、默认运行时，界面上的宽度，成本与审计导出，以及远端账号。',
    en: 'How this machine is configured: theme, language, default runtime, on-screen widths, costs & audit export, and the remote account.',
  },
  'settings.general': { zh: '通用', en: 'General' },
  // ── 抽屉外壳 ──
  // 2026-11：抽屉没了——`settings.title` / `settings.titleRemote`（抽屉标题）
  // 删除（页名用 `settings.navTitle`）。

  // ── 界面语言（D39）──
  'settings.language': { zh: '界面语言', en: 'Interface language' },
  'settings.languageLabel': { zh: '语言', en: 'Language' },
  'settings.languageHint': {
    zh: '只切换界面文字。交给模型的那段话仍是中文，另外会加一条「请用 X 回答」的指令，让它用你选的语言答复。',
    en: 'Switches interface text only. The prompt handed to the model stays in Chinese, plus an "answer in X" instruction so it replies in the language you pick.',
  },

  // ── claude 的 WebSearch / WebFetch 开关（D77）──
  // ★ 2026-10（定稿第 ⑦ 条）：全局 runtime 默认值。文案要说清"自动侦测"是一个**能选的
  //   值**（空串），否则使用者会以为"没设过"就是"没有默认值"。
  'settings.defaultRuntime': { zh: 'Agent CLI（runtime）', en: 'Agent CLI (runtime)' },
  'settings.defaultRuntimeLabel': { zh: '默认用哪个', en: 'Default CLI' },
  'settings.defaultRuntimeAuto': { zh: '自动侦测（当前 {key}）', en: 'Auto-detect (now {key})' },
  'settings.defaultRuntimeHint': {
    zh: '新建的智能体默认「跟随全局默认」，所以这里改一次就处处生效；某个智能体要例外，在它的编辑页里单独选。',
    en: 'New agents follow this global default, so one change applies everywhere; pick per agent when one needs an exception.',
  },

  // ── 界面主题（亮 / 暗 / 跟随系统）──
  'settings.theme': { zh: '界面主题', en: 'Theme' },
  'settings.themeLight': { zh: '亮色', en: 'Light' },
  'settings.themeDark': { zh: '暗色', en: 'Dark' },
  'settings.themeSystem': { zh: '跟随系统', en: 'System' },
  'settings.themeHint': {
    zh: '「跟随系统」就是跟着操作系统的亮暗切换走；手动选亮 / 暗会定死，系统怎么换都不影响。',
    en: '"System" follows the OS light/dark switch; picking Light or Dark pins it, no matter what the OS does.',
  },
  'settings.markdownHtml': { zh: 'Markdown 里的 HTML', en: 'HTML in Markdown' },
  'settings.markdownHtmlOff': { zh: '不支持', en: 'Off' },
  'settings.markdownHtmlAllowlist': { zh: '白名单', en: 'Allowlist' },
  'settings.markdownHtmlRaw': { zh: '原始', en: 'Raw' },
  'settings.markdownHtmlHint': {
    zh: '大模型常在 markdown 里写 br、b 这类 HTML 标签（标准本来就允许）。白名单档把它们翻译成等价效果（换行、粗体等），危险标签仍全部转义；原始档完全放行。',
    en: 'LLMs often write tags like br and b in markdown (the standard allows them). Allowlist translates safe tags into their equivalent effects (line break, bold, etc.); Raw passes everything through.',
  },
  'settings.markdownHtmlRawWarn': {
    zh: '原始档会放行 agent 产出的全部 HTML——脚本、事件属性可以直接调用本机接口（跑任务、读日志）。只在完全信任内容来源时用。',
    en: 'Raw passes ALL HTML from agent output through — scripts and event attributes can call local APIs. Use only when you fully trust the source.',
  },

  // ── 2026-11：「关于」那几条（settings.about / diagnostics / webBuild* /
  //    protocolLabel）整节搬去了「关于」页（about.ts）——这里不留死词条。

  // ── 布局（D176）──
  // ★ 使用者选的那件事：拖宽原来只有"拖过才知道能拖"，拖坏了也没有回去的路。
  //   这一节把**全部可拖的位置**列出来（名字与侧栏同一批词条），并给"恢复默认"。
  'settings.layoutHeading': { zh: '布局', en: 'Layout' },
  'settings.layoutHint': {
    zh: '每个列表的宽度、沉淀页右侧产物栏的宽度都能拖，拖过会记住。恢复默认就是把这个位置退回初始宽度。',
    en: 'Every list pane and the crystallize artifact pane can be dragged, and the width is remembered. Reset returns that spot to its starting width.',
  },
  'settings.layoutColWhere': { zh: '位置', en: 'Where' },
  'settings.layoutColWidth': { zh: '当前宽度', en: 'Width' },
  'settings.layoutDefault': { zh: '默认', en: 'Default' },
  'settings.layoutReset': { zh: '恢复默认', en: 'Reset' },
  'settings.layoutResetAll': { zh: '全部恢复默认', en: 'Reset all' },
  'settings.layoutResetDone': { zh: '已恢复默认宽度', en: 'Widths reset' },
  /** 产物栏那一行的名字（列表栏那六行用侧栏的词条，不重复定义） */
  'settings.layoutArtifact': { zh: '沉淀 · 产物栏', en: 'Crystallize · artifact pane' },

  // ── 成本 ──
  'settings.costs': { zh: '成本', en: 'Costs' },
  'settings.costsTotalBefore': { zh: '总计 ', en: 'Total ' },
  'settings.runsCount': { zh: '{count} 次执行', en: '{count} run(s)' },
  'settings.runsWithoutUsage': {
    zh: '其中 {count} 次没有上报用量',
    en: 'of which {count} reported no usage',
  },
  'settings.colKind': { zh: '类型', en: 'Kind' },
  'settings.colRuns': { zh: '次数', en: 'Runs' },
  'settings.colCost': { zh: '成本 (USD)', en: 'Cost (USD)' },
  'settings.colNote': { zh: '备注', en: 'Note' },
  'settings.estimatedRuns': { zh: '{count} 条为估算', en: '{count} estimated' },
  'settings.usageHintBefore': { zh: '⚠️ 没有上报用量的执行', en: '⚠️ Runs that report no usage ' },
  'settings.usageHintStrong': { zh: '不计入', en: 'do not count toward' },
  'settings.usageHintAfter': {
    zh: '成本。把缺失当零会让「总成本」变成一个误导性的数字。',
    en: ' cost. Treating the gap as zero would turn "total cost" into a misleading number.',
  },
  'settings.exportAudit': { zh: '导出审计链（JSON）', en: 'Export audit chain (JSON)' },
  /**
   * ⚠️ 这段原来写着 `argv 已脱敏` 与 `skill 记录不含指纹`（2026-09 改写）：
   *    两句都是说给自己听的，读界面的人拿不到任何东西。改写成"抹掉的是什么、
   *    它证明得了什么、证明不了什么"——信息量没变，只是换了说法。
   */
  'settings.exportHintBefore': {
    zh: '导出的文件自带校验和，改动任何一个字段都会被查出来。它同时把这份记录的局限写在文件里：可以追溯，但',
    en: 'The exported file carries its own checksums, so any edited field is detected. It also writes its limits into the file: traceable, but ',
  },
  'settings.exportHintStrong': { zh: '不可复现', en: 'not reproducible' },
  'settings.exportHintAfter': {
    zh: '——同一件事重跑一次不保证得到同一份文件。里面的令牌与密钥已经抹掉。',
    en: ' — re-running the same thing is not guaranteed to produce the same file. Tokens and keys inside it have been erased.',
  },

  // ── 远端能力 ──
  'settings.remoteSection': { zh: '远端能力', en: 'Remote capabilities' },
  'settings.connected': { zh: '已连接 {url}', en: 'Connected to {url}' },
  'settings.remoteProcessBefore': { zh: '远端服务是', en: 'The remote service is ' },
  'settings.remoteProcessStrong': { zh: '另一个进程', en: 'a separate process' },
  'settings.remoteProcessAfter': {
    zh: '，由这个页面直接连它。本机服务自己不向远端发任何请求——所以远端关掉了，本机照样能用。',
    en: ', which this page talks to directly. The local service never sends requests to the remote itself — turn the remote off and everything local still works.',
  },
  'settings.email': { zh: '邮箱', en: 'Email' },
  'settings.password': { zh: '口令（至少 8 位）', en: 'Password (at least 8 characters)' },
  'settings.signIn': { zh: '登录', en: 'Sign in' },
  'settings.register': { zh: '注册', en: 'Register' },
  'settings.remoteUrl': { zh: '远端地址', en: 'Remote URL' },
  'settings.saveUrl': { zh: '保存地址并重连', en: 'Save URL and reconnect' },
  'settings.signedInAs': { zh: '已登录：', en: 'Signed in: ' },
  'settings.signOut': { zh: '退出登录', en: 'Sign out' },



  /** 模版还没从服务端读回来时，提交按钮为什么点不动。 */
  'settings.kitNotLoaded': { zh: '模版还没读回来，稍等一下', en: 'The template has not loaded yet — one moment' },

  'settings.syncHeading': { zh: '同步状态', en: 'Sync status' },
  'settings.syncReported': { zh: '已上报 {count}', en: 'Reported {count}' },
  'settings.syncQueued': { zh: '· 暂存 {count} 条待补交', en: '· {count} queued for resubmission' },
  /*
   * ⚠️ 2026-11（D125）：`settings.syncFetched`（"取回 N 条待处理项"）随报告摄取的
   *   拉取半段一起删——同步现在只有一个方向（往外上报）。
   */
  'settings.syncReportingOff': { zh: '· 上报已关闭', en: '· reporting is off' },
  'settings.reportingStrong1': { zh: '上报什么、去哪、算不算证据', en: 'What is reported, where it goes, and whether it counts as evidence' },
  'settings.reportingAfter1': { zh: '：页面定期把', en: ': the page periodically sends ' },
  'settings.reportingStrong2': { zh: '摘要', en: 'summaries' },
  'settings.reportingMid1': {
    zh: '送到你配置的远端服务——执行的用量与状态、任务的状态变更。',
    en: ' to the remote service you configured — run usage and status, and task status changes.',
  },
  'settings.reportingStrong3': { zh: '不包含', en: 'It does not include' },
  /** ⚠️ 原文是 `prompt 正文`（2026-09 改写成使用者的话：交给模型的那段东西）。 */
  'settings.reportingMid2': {
    zh: ' 交给模型的指令原文、代码、报告原文。远端那份副本',
    en: ' the instructions sent to the model, code or report text. The remote copy ',
  },
  'settings.reportingStrong4': { zh: '不具证据效力', en: 'has no evidential force' },
  /** ⚠️ 原文结尾是 `本机 daemon 里`——"daemon" 是产品内部的名字，界面上一律说「本机」。 */
  'settings.reportingMid3': {
    zh: '，权威记录在这台机器上。',
    en: '; the authoritative record is on this machine.',
  },
  /**
   * ⚠️ 这里原来把配置键当句子用（`上报可以用 reportingEnabled: false 关闭`，2026-09
   *    改写）：那句话对读界面的人是"一个我该去哪儿改的东西"，而不是一个键名。
   *    键名仍然看得见——「我的设定」那一段列着它，那里才是改它的地方。
   */
  // ⚠️ 2026-10：远端设置那一节（「我的设定」）已从界面上撤掉，所以这句话不能再指向它。
  //    上报开关本身仍然存在（远端的 `reportingEnabled`），只是改为**走接口**：
  //    界面上没有入口了 —— 与其指一个不存在的地方，不如直说怎么关。
  'settings.reportingBefore2': {
    // ⚠️ 不许用反引号/星号这类 markdown 记号：界面上是**纯文本**渲染，记号会原样显示
    //    （`i18n.test.ts` 有一条守卫拦这两种记号）。这里原来带了反引号，已被它拦下。
    zh: '关掉上报：给远端写一条设定 reportingEnabled: false（接口 PUT /api/settings，界面上暂无入口）',
    en: 'To turn reporting off: write reportingEnabled: false to the remote settings (API PUT /api/settings; no UI entry for now)',
  },
  'settings.reportingAfter2': {
    zh: '；关掉之后本机功能完整可用。远端不可达时记录会',
    en: '; with it off, everything local still works. When the remote is unreachable, records are ',
  },
  'settings.reportingStrong5': { zh: '本地暂存、恢复后补交', en: 'queued locally and resubmitted once it is back' },
  'settings.reportingEnd': { zh: '。', en: '.' },

  // ── 命令式文案：toast / 就地状态（事件回调里用 `tx`）──
  'settings.registeredAndSignedIn': { zh: '已注册并登录', en: 'Registered and signed in' },
  'settings.signedIn': { zh: '已登录', en: 'Signed in' },

  // ── 通知抽屉（`InboxDrawer.svelte`）──
  'inbox.title': { zh: '通知', en: 'Inbox' },
  'inbox.emptyTitle': { zh: '没有待处理的通知', en: 'No notifications to handle' },
  'inbox.emptyHint': {
    zh: '这是正常的——通知只在需要你介入或留意时才会出现。',
    en: 'That is normal — notifications appear only when something needs your decision or attention.',
  },
  'inbox.markRead': { zh: '标为已读', en: 'Mark as read' },
  'inbox.severityActionRequired': { zh: '需要你决定', en: 'Needs your decision' },
  'inbox.severityAttention': { zh: '留意', en: 'Attention' },
  'inbox.severityInfo': { zh: '提示', en: 'Info' },
} as const satisfies TextCatalog
