import type { TextCatalog } from '../text.ts'

/**
 * 外壳：侧边栏、顶栏、通知抽屉。
 *
 * ⚠️ 分文件的依据是**代码结构**（一个区域一份），所以"界面上那句话在代码哪儿"
 *    是直接的：看到 `shell.navAgents` 就知道去 `Sidebar.svelte` 找调用点。
 *
 * ⚠️ zh 的值**必须与迁移之前逐字一致**：中文是这个项目的默认语言，也是所有既有
 *    测试、布局探针与文档断言的依据——改一个字就会有东西变红，而那种红不是这个
 *    功能要的。
 */
export const shellText = {
  'shell.navNewTask': { zh: '新建任务', en: 'New task' },
  'shell.navNewTaskHint': { zh: '交给 agent 去做', en: 'Hand it to an agent' },
  'shell.navTasks': { zh: '任务清单', en: 'Tasks' },
  'shell.navTasksHint': { zh: '看板 / 列表 · 执行记录', en: 'Board / list · run records' },
  'shell.navAgents': { zh: '智能体', en: 'Agents' },
  'shell.navAgentsHint': { zh: '配置 · runtime', en: 'Config · runtime' },
  'shell.navSkills': { zh: 'Skills', en: 'Skills' },
  'shell.navSkillsHint': { zh: '审核标准 · 动作子集', en: 'Reference packs · action subsets' },

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
  'shell.language': { zh: '界面语言', en: 'Language' },
  'shell.languageHint': {
    zh: '只切换界面文字。交给模型的那段话仍是中文，另外会加一条"请用 X 回答"的指令，让它用你选的语言答复。',
    en: 'Changes the interface only. The prompt sent to the model stays in Chinese, plus a "answer in X" instruction so its replies are in the language you pick.',
  },
} as const satisfies TextCatalog
