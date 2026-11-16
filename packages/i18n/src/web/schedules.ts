/**
 * 定时任务（2026-11，使用者立项）——`views/Schedules.svelte` 整页：
 * 左栏列表（启用开关 / 人话调度 / 下次触发 / 最近一次状态），右栏新建表单
 * （**表单式调度**：频率 + 时间点，cron 是内部表示；高级折叠直接写 cron）+
 * 详情（摘要 + 触发记录表，每条「查看」跳任务页那次 run）。
 *
 * ⚠️ zh / en 两边都要有，占位符要一致（`i18n.test.ts` 逐条守着）。
 * ⚠️ 词条里不许出现 markdown 记号（`**` 与反引号）——i18n 守卫要求。
 */
export const schedulesText = {
  'schedules.navTitle': { zh: '定时任务', en: 'Schedules' },
  'schedules.navHint': { zh: '到点自动跑', en: 'Run on a schedule' },
  'schedules.title': { zh: '定时任务', en: 'Schedules' },
  'schedules.titleHint': { zh: '触发的任务在「任务」页查看', en: 'Triggered tasks show up in Tasks' },
  'schedules.listTitle': { zh: '所有定时任务', en: 'All schedules' },
  'schedules.enabledCount': { zh: '{enabled} 个启用 · 共 {total} 个', en: '{enabled} enabled · {total} total' },
  'schedules.empty': { zh: '还没有定时任务。到点会自动跑起来的任务，从这里建。', en: 'No schedules yet. Tasks that run on their own start here.' },
  'schedules.next': { zh: '下次', en: 'Next' },
  'schedules.last': { zh: '最近', en: 'Last' },
  'schedules.disabled': { zh: '停用中', en: 'Paused' },
  'schedules.enabledTitle': { zh: '启用/停用', en: 'Enable / pause' },
  'schedules.edit': { zh: '编辑', en: 'Edit' },
  'schedules.delete': { zh: '删除', en: 'Delete' },
  'schedules.confirmDelete': { zh: '删除这个定时任务？', en: 'Delete this schedule?' },
  'schedules.triggerNow': { zh: '立即触发', en: 'Trigger now' },

  // ── 新建/编辑表单 ──
  'schedules.nameLabel': { zh: '名字', en: 'Name' },
  'schedules.namePlaceholder': { zh: '如：竞品周报', en: 'e.g. Weekly review' },
  'schedules.whenLabel': { zh: '什么时候跑', en: 'When' },
  'schedules.freqDaily': { zh: '每天', en: 'Daily' },
  'schedules.freqWeekly': { zh: '每周', en: 'Weekly' },
  'schedules.freqMonthly': { zh: '每月', en: 'Monthly' },
  'schedules.freqInterval': { zh: '间隔', en: 'Interval' },
  'schedules.freqCustom': { zh: '自定义', en: 'Custom' },
  'schedules.workdaysQuick': { zh: '工作日（周一至周五）', en: 'Weekdays (Mon–Fri)' },
  'schedules.everyMonthDay': { zh: '每月', en: 'Monthly on day' },
  'schedules.lastDay': { zh: '最后一天（L）', en: 'Last day (L)' },
  'schedules.everyInterval': { zh: '每', en: 'Every' },
  'schedules.minutes': { zh: '分钟', en: 'minutes' },
  // 2026-11（使用者："时间显示里'分'不见了"）：时间行两段输入的单位字
  'schedules.hourUnit': { zh: '时', en: 'h' },
  'schedules.minuteUnit': { zh: '分', en: 'min' },
  'schedules.customPlaceholder': { zh: '分 时 日 月 周，如 0 9 * * 1', en: 'min hour dom mon dow, e.g. 0 9 * * 1' },
  'schedules.customHint': { zh: '段序：分 时 日 月 周 · 例：0 9 * * 1 = 每周一 09:00', en: 'Order: min hour dom mon dow · e.g. 0 9 * * 1 = Mondays 09:00' },
  'schedules.weekdayMon': { zh: '周一', en: 'Mon' },
  'schedules.weekdayTue': { zh: '周二', en: 'Tue' },
  'schedules.weekdayWed': { zh: '周三', en: 'Wed' },
  'schedules.weekdayThu': { zh: '周四', en: 'Thu' },
  'schedules.weekdayFri': { zh: '周五', en: 'Fri' },
  'schedules.weekdaySat': { zh: '周六', en: 'Sat' },
  'schedules.weekdaySun': { zh: '周日', en: 'Sun' },
  'schedules.cronLabel': { zh: 'cron', en: 'cron' },
  'schedules.humanLabel': { zh: '人话', en: 'Plain words' },
  'schedules.nextUnavailable': { zh: '保存后计算', en: 'computed on save' },
  // ⚠️ 2026-11（573d01a 起）：定时任务的「要做什么」不再切第一行当标题——
  //   任务名是「定时任务名 - 次数」，模板全文进 description。词条跟着改。
  'schedules.taskLabel': { zh: '要做什么', en: 'What to do' },
  'schedules.taskPlaceholder': { zh: '抓取竞品本周更新，按固定模板写成简报：\n1. 读上一期简报确定增量范围\n2. 抓取各竞品 changelog / 发布页\n3. 输出固定格式的简报', en: 'Grab this week\'s competitor updates:\n1. Read last week\'s report for the delta\n2. Fetch changelogs / release pages\n3. Write the report' },
  'schedules.varsHint': { zh: '可用变量点一下插入；缺值（如首次没有上次）替换成空。标题自己写，变量只给内容。', en: 'Click a variable to insert it; missing values (e.g. no last run yet) render empty. You write the title; variables only carry content.' },
  // 2026-11：触发方式（使用者要求：设定新启动 Agent 还是 resume 一个原来的 Agent）
  'schedules.resumeLabel': { zh: '启动方式', en: 'Start mode' },
  // 2026-11（使用者三档定稿，顺序 = 按钮顺序）：①新启动（新会话+新目录）
  //   ②新启动·原目录（新会话+保持上次目录）③接续·原目录（续会话+保持上次目录）
  'schedules.resumeFresh': { zh: '新启动', en: 'Fresh' },
  'schedules.resumeFreshSameDir': { zh: '新启动 · 原目录', en: 'Fresh, same dir' },
  'schedules.resumeLast': { zh: '接续 · 原目录', en: 'Resume, same dir' },
  'schedules.executorLabel': { zh: '交给谁', en: 'Who runs it' },
  /*
   * ⚠️ 2026-11（S3）：`schedules.executorAgent` / `executorGroup`（「一个智能体 /
   *   一个智能体组」切换）随组退场删——定时任务只能选一个具体 agent。
   */
  // ⚠️ 2026-11（D123）：这里原来还带「允许的动作 {actions}」——动作能力退场，`{actions}` 删掉。
  // ⚠️ 2026-11（D124）：`{reworks}` 那个占位随返工退场删掉——组上不再有返工次数。
  /*
   * ⚠️ 2026-11（D125）：这个键原来叫 `schedules.summary`，文案是
   *   「执行者 {executor} · 审核者 {reviewer}（从智能体组推导）」。
   *   审核 run 退场 ⇒ 定时任务也只报执行者，键名与文案一起改。
   */
  'schedules.summaryExecutor': { zh: '执行者 {executor}', en: 'Runs {executor}' },
  'schedules.save': { zh: '保存', en: 'Save' },
  // 2026-11（使用者要求）：编辑后立刻测试任务执行
  'schedules.saveAndTrigger': { zh: '保存并立即触发', en: 'Save & run now' },
  'schedules.savedAndTriggeredToast': { zh: '已保存，并立即触发了一次', en: 'Saved, and triggered a run now' },
  'schedules.cancel': { zh: '取消', en: 'Cancel' },
  'schedules.updateTitle': { zh: '编辑定时任务', en: 'Edit schedule' },
  'schedules.createTitle': { zh: '新建定时任务', en: 'New schedule' },

  // ── 详情 / 触发记录 ──
  'schedules.recordsTitle': { zh: '触发记录', en: 'Trigger log' },
  'schedules.recordsHint': { zh: '最近 {n} 次 · 每条对应一个任务，点「查看」去任务页', en: 'Last {n} · each row maps to a task; View opens it in Tasks' },
  'schedules.colTriggeredAt': { zh: '触发时间', en: 'Triggered at' },
  'schedules.colRun': { zh: 'run', en: 'run' },
  'schedules.colStatus': { zh: '状态', en: 'Status' },
  'schedules.colResult': { zh: '结果', en: 'Result' },
  'schedules.view': { zh: '查看', en: 'View' },
  'schedules.statusTriggered': { zh: '已触发', en: 'Triggered' },
  'schedules.statusSkipped': { zh: '跳过', en: 'Skipped' },
  'schedules.statusFailed': { zh: '失败', en: 'Failed' },
  'schedules.recordTriggered': { zh: '任务已发起', en: 'Task started' },
  'schedules.recordSkipped': { zh: '跳过（上次仍在进行）', en: 'Skipped (previous run still going)' },
  'schedules.recordFailed': { zh: '发起失败：{note}', en: 'Failed: {note}' },
  'schedules.required': { zh: '必填', en: 'required' },
  'schedules.createdToast': { zh: '定时任务已保存', en: 'Schedule saved' },
  'schedules.deletedToast': { zh: '定时任务已删除', en: 'Schedule deleted' },
  'schedules.triggeredToast': { zh: '已触发，任务在「任务」页查看', en: 'Triggered — see it in Tasks' },
  'schedules.updatedToast': { zh: '已更新', en: 'Updated' },
}
