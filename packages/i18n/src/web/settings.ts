import type { TextCatalog } from '../text.ts'

/**
 * 设置抽屉（`apps/web/src/components/SettingsDrawer.svelte`）与通知抽屉
 * （`apps/web/src/components/InboxDrawer.svelte`）。
 *
 * ⚠️ 两个抽屉共用这一份词表（键的前缀区分：`settings.*` / `inbox.*`）——它们都从
 *    顶栏打开、都是"抽屉"，改文案时在同一处找得到。
 *
 * ⚠️ zh 的值**必须与迁移之前逐字一致**：中文是这个项目的默认语言，也是所有既有
 *    测试、布局探针与文档断言的依据——改一个字就会有东西变红。
 *
 * ⚠️ 被 `<strong>` 拆开的句子按 `…Before` / `…Strong` / `…After` 分段（标记里的
 *    粗体结构原样保留）：分段值里的空格与标点是**渲染结果的一部分**，拼接后必须
 *    与原来那段一字不差。以英文单词结尾/开头的那几段首尾各带一个空格，不是笔误。
 */
export const settingsText = {
  // ── 抽屉外壳 ──
  'settings.title': { zh: '设置', en: 'Settings' },
  'settings.titleRemote': { zh: '远端账号', en: 'Remote account' },

  // ── 界面语言（D39）──
  'settings.language': { zh: '界面语言', en: 'Interface language' },
  'settings.languageLabel': { zh: '语言', en: 'Language' },
  'settings.languageHint': {
    zh: '只切换界面文字。交给模型的那段话仍是中文，另外会加一条"请用 X 回答"的指令，让它用你选的语言答复。',
    en: 'Switches interface text only. The prompt handed to the model stays in Chinese, plus an "answer in X" instruction so it replies in the language you pick.',
  },

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
    zh: '成本。把缺失当零会让"总成本"变成一个误导性的数字。',
    en: ' cost. Treating the gap as zero would turn "total cost" into a misleading number.',
  },
  'settings.exportAudit': { zh: '导出审计链（JSON）', en: 'Export audit chain (JSON)' },
  'settings.exportHintBefore': {
    zh: '导出的文件自带校验和，改动任何一个字段都会被查出来。它同时把能力边界写在文件里——审计链可追溯但',
    en: 'The exported file carries its own checksums, so any edited field is detected. It also writes the capability boundary into the file — the audit chain is traceable but ',
  },
  'settings.exportHintStrong': { zh: '不可复现', en: 'not reproducible' },
  'settings.exportHintAfter': {
    zh: '（skill 记录不含指纹），argv 已脱敏。',
    en: ' (skill records carry no fingerprint), and argv is redacted.',
  },

  // ── 远端能力 ──
  'settings.remoteSection': { zh: '远端能力', en: 'Remote capabilities' },
  'settings.connected': { zh: '已连接 {url}', en: 'Connected to {url}' },
  'settings.remoteProcessBefore': { zh: '远端服务是', en: 'The remote service is ' },
  'settings.remoteProcessStrong': { zh: '另一个进程', en: 'a separate process' },
  'settings.remoteProcessAfter': {
    zh: '，本页面直接访问它（这一跳是跨源的，由远端放行回环来源）。daemon 自己不向远端发任何请求。',
    en: ' this page talks to directly (that hop is cross-origin, with the remote allowing loopback origins). The daemon itself sends no requests to the remote.',
  },
  'settings.email': { zh: '邮箱', en: 'Email' },
  'settings.password': { zh: '口令（至少 8 位）', en: 'Password (at least 8 characters)' },
  'settings.signIn': { zh: '登录', en: 'Sign in' },
  'settings.register': { zh: '注册', en: 'Register' },
  'settings.remoteUrl': { zh: '远端地址', en: 'Remote URL' },
  'settings.saveUrl': { zh: '保存地址并重连', en: 'Save URL and reconnect' },
  'settings.signedInAs': { zh: '已登录：', en: 'Signed in: ' },
  'settings.signOut': { zh: '退出登录', en: 'Sign out' },

  'settings.mySettings': { zh: '我的设定', en: 'My settings' },
  'settings.key': { zh: '键', en: 'Key' },
  'settings.value': { zh: '值（JSON；解析不了按字符串）', en: 'Value (JSON; parsed as a string if that fails)' },
  'settings.valuePlaceholder': { zh: '60000 或 false', en: '60000 or false' },
  'settings.saveImmediate': { zh: '保存（立即生效）', en: 'Save (takes effect immediately)' },
  'settings.commonSettingsBefore': { zh: '常用：', en: 'Common: ' },
  'settings.commonSettingsBetween': { zh: '（最小 10000）、', en: ' (minimum 10000), ' },
  'settings.commonSettingsAfter': { zh: '关闭上报。', en: 'turns reporting off.' },

  'settings.pluginsHeading': { zh: '插件清单', en: 'Plugins' },
  'settings.noPlugins': { zh: '没有加载任何插件。', en: 'No plugins loaded.' },
  'settings.colPlugin': { zh: '插件', en: 'Plugin' },
  'settings.colCapability': { zh: '能力', en: 'Capability' },
  'settings.colStatus': { zh: '状态', en: 'Status' },
  'settings.colSecretKeys': { zh: '密钥', en: 'Secret keys' },
  'settings.loadFailed': { zh: '加载失败', en: 'Load failed' },
  'settings.enabled': { zh: '已启用', en: 'Enabled' },
  'settings.disabled': { zh: '已停用', en: 'Disabled' },
  'settings.disable': { zh: '停用', en: 'Disable' },
  'settings.enable': { zh: '启用', en: 'Enable' },

  'settings.publicCatalog': { zh: '公共 SKILL 目录', en: 'Public skill catalog' },
  'settings.catalogUnavailable': {
    zh: '远端不可用，目录暂时看不到。',
    en: 'Remote unavailable, the catalog is not visible right now.',
  },
  'settings.downloadToLocal': { zh: '下载到本机', en: 'Download to this machine' },

  'settings.syncHeading': { zh: '同步状态', en: 'Sync status' },
  'settings.syncReported': { zh: '已上报 {count}', en: 'Reported {count}' },
  'settings.syncQueued': { zh: '· 暂存 {count} 条待补交', en: '· {count} queued for resubmission' },
  'settings.syncFetched': { zh: '· 取回 {count} 条待处理项', en: '· {count} fetched for handling' },
  'settings.syncReportingOff': { zh: '· 上报已关闭', en: '· reporting is off' },
  'settings.reportingStrong1': { zh: '上报什么、去哪、算不算证据', en: 'What is reported, where it goes, and whether it counts as evidence' },
  'settings.reportingAfter1': { zh: '：页面定期把', en: ': the page periodically sends ' },
  'settings.reportingStrong2': { zh: '摘要', en: 'summaries' },
  'settings.reportingMid1': {
    zh: '送到你配置的远端服务——执行的用量与状态、任务的状态变更。',
    en: ' to the remote service you configured — run usage and status, and task status changes.',
  },
  'settings.reportingStrong3': { zh: '不包含', en: 'It does not include' },
  'settings.reportingMid2': {
    zh: ' prompt 正文、代码、报告原文。远端那份副本',
    en: ' prompt bodies, code or report text. The remote copy ',
  },
  'settings.reportingStrong4': { zh: '不具证据效力', en: 'has no evidential force' },
  'settings.reportingMid3': {
    zh: '，权威记录在本机 daemon 里。',
    en: '; the authoritative record lives in the local daemon.',
  },
  'settings.reportingBefore2': { zh: '上报可以用 ', en: 'Reporting can be turned off with ' },
  'settings.reportingAfter2': {
    zh: ' 关闭；关闭后本机功能完整可用。远端不可达时记录会',
    en: '; with it off, everything local still works. When the remote is unreachable, records are ',
  },
  'settings.reportingStrong5': { zh: '本地暂存、恢复后补交', en: 'queued locally and resubmitted once it is back' },
  'settings.reportingEnd': { zh: '。', en: '.' },

  // ── 命令式文案：toast / 就地状态（事件回调里用 `tx`）──
  'settings.registeredAndSignedIn': { zh: '已注册并登录', en: 'Registered and signed in' },
  'settings.signedIn': { zh: '已登录', en: 'Signed in' },
  'settings.downloadingSkill': { zh: '正在下载 {slug}…', en: 'Downloading {slug}…' },
  'settings.notInCatalog': { zh: '目录里没有 {slug}', en: 'No {slug} in the catalog' },
  'settings.installedSkill': { zh: '已安装 {slug}', en: 'Installed {slug}' },
  'settings.skippedReasons': { zh: '；跳过：{reasons}', en: '; skipped: {reasons}' },
  'settings.notInstalled': { zh: '未安装：{reasons}', en: 'Not installed: {reasons}' },
  'settings.unknownReason': { zh: '未知原因', en: 'unknown reason' },
  'settings.installFailed': { zh: '安装失败：{error}', en: 'Install failed: {error}' },
  'settings.settingSaved': { zh: '设定已保存，立即生效', en: 'Setting saved and in effect immediately' },

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
