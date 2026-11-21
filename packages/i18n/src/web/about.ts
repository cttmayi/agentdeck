import type { TextCatalog } from '../text.ts'

/**
 * 关于页（2026-11，使用者立项）：版本 · 环境 · 边界。
 *
 * 收拢散在各处的诊断信息（侧栏底部状态块的详情、设置抽屉「关于」折叠区），
 * 加上文档里才有的存储目录与安全边界——"这一台是怎么搭的"在一页讲完。
 *
 * ⚠️ 数据尽量来自 daemon 的 `/api/identity`（界面不猜值）；安全边界是静态产品
 *    文案（提炼自根 README「安全边界」一节，那里是必读原文，这边只给三行要点）。
 */
export const aboutText = {
  'about.navTitle': { zh: '关于', en: 'About' },
  // ⚠️ 侧栏减半纪律：辅助文字 4–6 个字、一行放得下（`shell.navChatHint` 同款）。
  // ⚠️ 侧栏减半纪律：辅助文字 4–6 个字、一行放得下（`shell.navChatHint` 同款）。
  'about.navHint': { zh: '版本 · 环境', en: 'Version · env' },

  /*
   * ★★ D223（使用者："还有些页面也是第一行写些描述，不符合当前规格"）：
   *    `about.sub` / `settings.headIntro` 两条页头说明一起删掉——它们是全站最后两处
   *    「这页是什么」的解释句（技能页那段 D222 已删，智能体页那段 D63 已删）。
   *    共同理由：顶栏页名 + 下面第一张卡 / 第一个面板头已经把这件事说清；解释句唯一
   *    的作用是把卡片名再念一遍，占掉页面最贵的那一行。页头说明从此**全站没有**，
   *    连带 `.view-intro` 与 `--measure` 一起退场（见 app.css）。
   */

  // ── ① 应用 ──
  'about.app': { zh: '应用', en: 'Application' },
  'about.appName': { zh: 'AgentDeck · 本机 AI 工作台', en: 'AgentDeck · local AI workbench' },
  'about.protocolVersion': { zh: '接口协议', en: 'API protocol' },
  'about.device': { zh: '设备', en: 'Device' },
  'about.locale': { zh: '界面语言', en: 'Language' },
  'about.localeZh': { zh: '中文', en: 'Chinese' },
  'about.localeEn': { zh: '英文', en: 'English' },
  'about.currentDevice': { zh: '当前', en: 'current' },

  // ── ② 运行环境（罗列侦测到的 CLI，不强调"当前"）──
  'about.env': { zh: '运行环境', en: 'Runtime environment' },
  'about.runtimesLabel': { zh: '侦测到的 CLI', en: 'Detected CLIs' },
  'about.cliAvailable': { zh: '可用', en: 'ready' },
  'about.cliMissing': { zh: '未安装', en: 'not installed' },
  'about.nodePlatform': { zh: 'Node / 平台', en: 'Node / platform' },
  'about.envPreflight': { zh: '环境预检', en: 'Preflight' },
  'about.envIssuesCount': { zh: '{n} 项', en: '{n} item(s)' },
  'about.envNoIssues': { zh: '全部通过', en: 'all clear' },
  'about.issueAction': { zh: '处理：', en: 'Fix: ' },

  // ── ③ 存储与目录 ──
  'about.storage': { zh: '存储与目录', en: 'Storage & directories' },
  'about.workDir': { zh: '工作目录', en: 'Work directory' },
  'about.dataDir': { zh: '数据目录', en: 'Data directory' },
  'about.skillsDir': { zh: '技能目录', en: 'Skills directory' },
  'about.sync': { zh: '远端同步', en: 'Remote sync' },
  'about.syncNever': { zh: '尚未上报', en: 'never synced' },
  'about.syncError': { zh: '同步出错', en: 'sync error' },
  'about.syncReported': { zh: '上次上报 {n} 条', en: '{n} reported last time' },
  'about.syncQueued': { zh: '队列 {n}', en: '{n} queued' },
  'about.unknown': { zh: '未知', en: 'unknown' },

  // ── ④ 安全边界（三行要点，原文在根 README「安全边界」）──
  'about.security': { zh: '安全边界', en: 'Security boundaries' },
  'about.securityLead': {
    zh: 'AgentDeck 不做沙箱隔离——这是明确的范围决定：run 以你启动 daemon 的 OS 用户完整权限执行，任务审过才触发有界的动作。',
    en: 'AgentDeck is not sandboxed—by explicit scope decision: runs execute with your full OS-user permissions, and bounded actions only fire after review passes.',
  },
  'about.securityFiles': { zh: '文件权限', en: 'File access' },
  'about.securityFilesValue': { zh: 'agent 可读写工作目录（读不受限）', en: 'agent can read/write the work directory (reads are unrestricted)' },
  'about.securityIsolation': { zh: '任务隔离', en: 'Task isolation' },
  'about.securityIsolationValue': {
    zh: '执行 run 有「任务边界」引导 + 工作目录外的路径被拦截（是隔离，不是沙箱）',
    en: 'execution runs get a task-boundary guard and out-of-workdir paths are denied (isolation, not sandbox)',
  },
  'about.securityVerdict': { zh: '内容去向', en: 'Content goes where' },
  'about.securityVerdictValue': {
    zh: '工作目录不出本机；agent 写进报告 / 判决的内容会回到远端（只上报摘要）',
    en: 'the work directory stays local; what agents write into reports/verdicts reaches remote (summaries only)',
  },

  // ── ⑤ 诊断（默认折叠：排查"两边都不报错"的版本错位用）──
  'about.diagnostics': { zh: '诊断', en: 'Diagnostics' },
  'about.diagnosticsNote': {
    zh: '界面与 daemon 是两份产物——这两条回答"你现在跑的是哪一版"，排查"标签页没刷新"一类两边都不报错的问题。',
    en: 'The UI and daemon are two artifacts—these answer "which version are you on", for mismatches where neither side errors.',
  },
  'about.webBuildLabel': { zh: '这一版界面：', en: 'This UI build: ' },
  'about.capabilitiesLabel': { zh: '能力标志', en: 'Capabilities' },

  // ── ⑥ 文档与决策 ──
  'about.docs': { zh: '文档与决策', en: 'Docs & decisions' },
  'about.docsDeveloper': { zh: '开发者文档', en: 'Developer docs' },
  'about.docsDeveloperHint': { zh: '代码结构 · 命令 · 不变量', en: 'structure · commands · invariants' },
  'about.docsDecisions': { zh: '决策记录', en: 'Decision record' },
  'about.docsDecisionsHint': { zh: 'D1–D75 · 为什么这样做', en: 'D1–D75 · why' },
  'about.docsSecurity': { zh: '安全边界', en: 'Security boundaries' },
  'about.docsSecurityHint': { zh: '范围决定与已知开口', en: 'scope & known gaps' },
  'about.docsUiStyle': { zh: 'UI 样式规范', en: 'UI style guide' },
  'about.docsUiStyleHint': { zh: '控件只有一处定义', en: 'controls defined once' },
  'about.docsNote': {
    zh: '文档在仓库 docs/ 目录（不在浏览器里）：docs/README.md 是入口。',
    en: 'Docs live in the repo docs/ directory (not served here): start at docs/README.md.',
  },
} as const satisfies TextCatalog
