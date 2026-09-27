import type { TextCatalog } from '../text.ts'

/**
 * 外壳：侧边栏、顶栏、通知抽屉。
 *
 * ⚠️ 分文件的依据是**代码结构**（一个区域一份），所以"界面上那句话在代码哪儿"
 *    是直接的：看到 `shell.navAgents` 就知道去 `Sidebar.svelte` 找调用点。
 *
 * ⚠️ zh 的值改之前先看一眼**有没有东西钉着它**：中文是默认语言，既有测试、布局
 *    探针与文档都引用它。⚠️ 但"与迁移之前逐字一致"**不再是判据**（2026-09 的文案
 *    改写把那批文字按"这句话是给谁看的"重写了一遍：去掉开发口径、机器取值与
 *    markdown 残留）。有引用就一起改，没有就按读者改。
 */
export const shellText = {
  // ★ 聊天排在「新建任务」**上面**：它是最轻的入口——先聊清楚，再决定要不要派活。
  //   侧边栏每一项都是一个场景，所以这一项是一整个页面（左对话列表 / 右消息流），
  //   不是「新建任务」页里的一条 tab。
  'shell.navChat': { zh: '聊天', en: 'Chat' },
  'shell.navChatHint': { zh: '先聊清楚，再派活', en: 'Talk it through, then hand it off' },
  'shell.navNewTask': { zh: '新建任务', en: 'New task' },
  'shell.navNewTaskHint': { zh: '交给 agent 去做', en: 'Hand it to an agent' },
  'shell.navTasks': { zh: '任务清单', en: 'Tasks' },
  'shell.navTasksHint': { zh: '看板 / 列表 · 执行记录', en: 'Board / list · run records' },
  'shell.navAgents': { zh: '智能体', en: 'Agents' },
  'shell.navAgentsHint': { zh: '指令 · 用哪个 CLI', en: 'Instructions · which CLI' },
  'shell.navSkills': { zh: 'Skills', en: 'Skills' },
  'shell.navSkillsHint': { zh: '执行者的参考资料 · 可安装', en: 'Reference packs for executors' },

  'shell.envOk': { zh: '运行环境正常', en: 'Environment OK' },
  'shell.envNoCli': { zh: '未检测到 agent CLI', en: 'No agent CLI detected' },
  'shell.envMissing': { zh: '未检测到 {command}', en: '{command} not found' },
  'shell.envReady': { zh: '{command} {version}', en: '{command} {version}' },
  'shell.envReadyNoVersion': { zh: '{command} 已就绪', en: '{command} ready' },
  'shell.envIssueCount': { zh: '· {count} 个环境问题', en: '· {count} environment issue(s)' },
  'shell.syncError': { zh: '同步异常', en: 'Sync error' },
  'shell.syncedCount': { zh: '已上报 {count}', en: 'Reported {count}' },
  'shell.syncedQueued': { zh: '· 暂存 {count}', en: '· {count} queued' },
  'shell.neverSynced': { zh: '尚未同步', en: 'Not synced yet' },

  'shell.inbox': { zh: '通知', en: 'Inbox' },
  'shell.inboxEmpty': { zh: '没有未读通知', en: 'No unread notifications' },
  'shell.inboxMarkAllRead': { zh: '全部标记为已读', en: 'Mark all as read' },
  'shell.login': { zh: '登录', en: 'Sign in' },
  'shell.settings': { zh: '设置', en: 'Settings' },
  'shell.signedIn': { zh: '已登录', en: 'Signed in' },
  'shell.pluginsFailing': { zh: '{count} 个插件加载失败', en: '{count} plugin(s) failed to load' },
  'shell.signIn': { zh: '登录', en: 'Sign in' },
  'shell.signInRemoteDown': { zh: '登录（远端不可用）', en: 'Sign in (remote unavailable)' },
  'shell.signInHint': { zh: '登录远端以使用目录、待办拉取与上报', en: 'Sign in to use the catalog, todo pull and reporting' },
  /**
   * ── 顶栏里紧跟页名的那排：当前这一页的动作（2026-09 改版）──
   *
   * 那排按钮由**各视图自己登记**（见 `lib/page-actions.ts`），所以这里只有两句
   * 给读屏器与窄屏用的字：
   *   · `pageActions` —— 那一组按钮的区域名（读屏器报"这一页的操作，区域"）
   *   · `pageActionsMore` —— 窄屏把动作收进 `⋯` 之后，那一个按钮的名字
   */
  'shell.pageActions': { zh: '这一页的操作', en: 'Actions for this page' },
  'shell.pageActionsMore': { zh: '更多操作', en: 'More actions' },
} as const satisfies TextCatalog
