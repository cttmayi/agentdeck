/**
 * 编排（2026-11，使用者立项）——`views/Workflows.svelte` 整页 + 运行画面：
 * 左栏编排定义列表，右栏编辑器（模板骨架 / 手写代码）+「运行」发起表单；
 * 运行画面（`#/workflows/run/<runId>`）= 步骤链 + 日志 + 工作目录树。
 *
 * ⚠️ zh / en 两边都要有，占位符要一致（`i18n.test.ts` 逐条守着）。
 * ⚠️ 词条里不许出现 markdown 记号（`**` 与反引号）——i18n 守卫要求。
 */
export const workflowsText = {
  'workflows.navTitle': { zh: '编排', en: 'Workflows' },
  'workflows.navHint': { zh: '代码编排', en: 'Code flows' },
  /*
   * ⚠️ 2026-11（D133）：`workflows.title`（「编排」）与 `workflows.titleHint`
   *   （「运行的任务在『任务』页查看」）随左栏那个大标题一起删——按规范，栏头带里
   *   **没有标题**（页名已经在顶栏，重复一次只是噪音）。"运行的任务在任务页看"
   *   这件事改由右栏空态那句（`workflows.pickHintHint`）与任务页分组承担。
   */
  /*
   * ⚠️ 2026-11（D133）：这一页按「页面基本规范」重排之后新增的几条。
   *   规范来自任务 / 智能体 / 沉淀那三页的**同一副骨架**（`ListPane` + `MainArea`
   *   + 顶栏动作）：栏头带只有"计数 + 搜索"，空态要分**真的没有**与**搜不到**两种，
   *   右栏没选中时给一句"选一个"。
   *   ⚠️ `workflows.listTitle`（「所有编排」）随之删：规范里栏头带**没有标题**
   *   （D61~D64：栏标题与顶栏页名重复时就不放），那一栏现在只显示计数。
   */
  'workflows.listCount': { zh: '共 {count} 个编排', en: '{count} workflows' },
  'workflows.search': { zh: '搜索编排名…', en: 'Search workflow names…' },
  'workflows.new': { zh: '新建', en: 'New' },
  /**
   * 编排页顶栏那颗「AI 生成…」（2026-11，D135）：跳聊天页开一个新对话、执行者选中
   * **编排生成者**——生成是聊出来的（要来回问几次），所以入口把人送到聊天页。
   */
  'workflows.aiDraftAction': { zh: 'AI 生成…', en: 'Generate with AI' },
  'workflows.createTitle': { zh: '新建编排', en: 'New workflow' },
  'workflows.empty': { zh: '还没有编排', en: 'No workflows yet' },
  'workflows.emptyHint': {
    zh: '点右上角「新建」，从一个模板起步，或者直接写代码。',
    en: 'Pick “New” at the top right — start from a template, or write code.',
  },
  'workflows.emptyFiltered': { zh: '没有匹配的编排', en: 'No matching workflows' },
  'workflows.emptyFilteredHint': { zh: '换个词试试。', en: 'Try another keyword.' },
  'workflows.pickHint': { zh: '左边选一个编排，或新建一个', en: 'Pick a workflow on the left, or create one' },
  'workflows.pickHintHint': {
    zh: '选中的编排在这里改代码、发起运行、看它的历史。',
    en: 'The selected workflow is edited here — code, run, history.',
  },
  'workflows.backToList': { zh: '← 返回编排列表', en: '← Back to workflows' },
  /*
   * ⚠️ 2026-11 使用者："去掉『运行历史』的显示" ⇒ 编排页右栏不再列该编排的运行。
   *   `workflows.runHistoryTitle` 与 `workflows.stepsHint`（那一段的"步骤 N/M"）
   *   随之删——留着是死词条。运行状态在「任务」页看（编排的每次运行都是一条任务）。
   */
  'workflows.templatesLabel': { zh: '从模板', en: 'From template' },
  /*
   * ★ 2026-11 使用者："这些都是简单编排，并没有实际用途，建议给实际有用的编排"。
   *   模板换成五个**真实场景**（见 `apps/daemon/src/workflows.ts` 的 `WORKFLOW_TEMPLATES`），
   *   每张卡下面那句说明就是这几个词条——**照着"它替你干什么"写**，不是照着原语名字写。
   *   ⚠️ 词条 key 必须与模板的 `key` 一致（`workflows.template.<key>`）。
   */
  'workflows.template.weekly-report': {
    zh: '两个人接力写完，再让你放行',
    en: 'Two agents write it, then you sign off',
  },
  'workflows.template.review-rework': {
    zh: '机器先挑一遍毛病，再交给你',
    en: 'A reviewer loops until it passes, then you decide',
  },
  'workflows.template.research-brief': {
    zh: '两路并行查，一份汇总给你',
    en: 'Two parallel researchers, one merged brief',
  },
  'workflows.template.batch-refactor': {
    zh: '多模块并行改，先核验再交给你',
    en: 'Parallel edits, conflict check, then you approve',
  },
  'workflows.template.release-check': {
    zh: '测试 / 安全 / 文档并行查，你来放行',
    en: 'Tests, security and docs in parallel — you release',
  },
  'workflows.nameLabel': { zh: '名字', en: 'Name' },
  'workflows.saveNothing': { zh: '没有改动', en: 'Nothing to save' },
  'workflows.nameRequired': { zh: '先给编排起个名字', en: 'Give the workflow a name first' },
  'workflows.codeRequired': { zh: '编排代码不能为空', en: 'Workflow code cannot be empty' },
  'workflows.namePlaceholder': { zh: '如：日报流水线', en: 'e.g. Daily pipeline' },
  'workflows.codeLabel': { zh: '编排代码', en: 'Workflow code' },
  'workflows.codePlaceholder': { zh: "await flow('组A', '要做什么')", en: "await flow('Group A', 'what to do')" },
  /* ── 编排内建智能体（D237）：右栏那一节 + 点「编辑」跳过去的那一页 ── */
  'workflows.agentsTitle': { zh: '本编排的智能体', en: 'This workflow’s agents' },
  'workflows.agentsEmptySummary': { zh: '还没有', en: 'none yet' },
  'workflows.agentsEmptyHint': {
    zh: "代码里写 agent('名字') 时，这条编排还没有自带的人——会去智能体页找同名的那条。",
    en: "agent('name') in the code has no one from this workflow yet — it will look for that name on the Agents page.",
  },
  'workflows.agentsSkillCount': { zh: '{n} 个技能', en: '{n} skills' },
  'workflows.agentsHeadSub': {
    zh: '本编排的智能体 · {n} 个技能',
    en: 'Workflow agent · {n} skills',
  },
  'workflows.agentsColName': { zh: '名字', en: 'Name' },
  'workflows.agentsColSkills': { zh: '技能', en: 'Skills' },
  'workflows.agentsColActions': { zh: '操作', en: 'Actions' },
  'workflows.agentsShadowed': { zh: '遮蔽同名', en: 'Shadows same name' },
  'workflows.agentsShadowTitle': {
    zh: '智能体页里也有同名的一条；代码里写这个名字时用的是这一条。',
    en: 'The Agents page has one with the same name; code using this name gets this one.',
  },
  'workflows.agentsNew': { zh: '新建智能体', en: 'New agent' },
  'workflows.agentsBack': { zh: '← 返回编排', en: '← Back to workflow' },
  'workflows.agentsOfWorkflow': { zh: '属于「{name}」', en: 'In “{name}”' },
  'workflows.agentsEntryLockedHint': {
    zh: '编排内建智能体只能被编排调用（对话 / 任务那两个入口对它不生效）',
    en: 'A workflow agent can only be called by workflows (chat/task do not apply)',
  },
  'workflows.agentsMemoryLockedHint': {
    zh: '编排内建智能体的记忆还没有接（它的记忆要落在编排目录里，二期做）',
    en: 'Memory is not wired for workflow agents yet (it would live in the workflow folder; later)',
  },
  'workflows.agentsSetDefaultLockedHint': {
    zh: '它不是智能体页里的一条，不能当默认执行者',
    en: 'It is not an entry on the Agents page, so it cannot be the default executor',
  },
  'workflows.agentsCopyLockedHint': {
    zh: '从编排内建智能体复制还没接（二期做）',
    en: 'Copying a workflow agent is not wired yet (later)',
  },
  'workflows.agentsSaved': { zh: '已保存', en: 'Saved' },
  'workflows.agentsDeleted': { zh: '已删除', en: 'Deleted' },
  'workflows.agentsDelete': { zh: '删除', en: 'Delete' },
  'workflows.agentsConfirmDelete': { zh: '删掉「{name}」？', en: 'Delete “{name}”?' },
  'workflows.agentsConfirmDeleteUsed': {
    zh: '删掉「{name}」？代码里还在用它——写这个名字的地方会失效。',
    en: 'Delete “{name}”? The code still uses it — that reference will break.',
  },
  'workflows.agentsWorkflowMissing': { zh: '编排不存在（可能已被删除）', en: 'Workflow not found (maybe deleted)' },
  'workflows.agentsMissing': { zh: '这条内建智能体不存在（可能已被删除）', en: 'Agent not found (maybe deleted)' },
  'workflows.agentsNameRequired': { zh: '名字不能为空', en: 'Name is required' },
  'workflows.save': { zh: '保存', en: 'Save' },
  'workflows.saved': { zh: '已保存', en: 'Saved' },
  'workflows.delete': { zh: '删除', en: 'Delete' },
  'workflows.confirmDelete': { zh: '删除这个编排？', en: 'Delete this workflow?' },
  'workflows.run': { zh: '运行', en: 'Run' },
  'workflows.updated': { zh: '更新于 {time}', en: 'Updated {time}' },
  'workflows.sourceTemplate': { zh: '模板', en: 'Template' },
  'workflows.sourceManual': { zh: '手写', en: 'Manual' },
  'workflows.sourceAi': { zh: 'AI 生成', en: 'AI' },

  // ── 发起运行表单 ──
  'workflows.runFormTitle': { zh: '发起一次运行', en: 'Start a run' },
  'workflows.promptLabel': { zh: '任务描述', en: 'Task description' },
  'workflows.promptPlaceholder': { zh: '这个任务叫什么、给谁看', en: 'What this task is about' },
  'workflows.promptHint': { zh: '这段描述会替换步骤任务里的 {{task}} 占位符', en: 'This description replaces {{task}} placeholders in steps' },
  'workflows.workDirLabel': { zh: '工作目录', en: 'Work directory' },
  'workflows.workDirAuto': { zh: '自动分配', en: 'Auto-assign' },
  'workflows.startRun': { zh: '发起', en: 'Start' },

  // ── 运行画面（`#/workflows/run/<runId>`）──
  'workflows.runBack': { zh: '返回编排', en: 'Back to workflows' },
  'workflows.stepsTitle': { zh: '步骤', en: 'Steps' },
  'workflows.stepPending': { zh: '等待', en: 'Pending' },
  'workflows.stepRunning': { zh: '进行中', en: 'Running' },
  'workflows.stepDone': { zh: '完成', en: 'Done' },
  'workflows.stepFailed': { zh: '失败', en: 'Failed' },
  'workflows.stepWaitingHuman': { zh: '等你确认', en: 'Waiting for you' },
  /*
   * ⚠️ 2026-11（使用者："比如执行 LOOP，当前的卡片就看不出来是 LOOP"）：这几条
   *   原来只出现在**左栏步骤链**那一列，中间那张卡片上看不出这一步是什么原语。
   *   现在卡片头也挂上它们，所以词也得说人话——顺手把三个陈旧/含混的词改对：
   *     · `flow` 原来叫「组跑」（组早退场了）⇒ **流水线**；
   *     · `loop` 原来叫「评审返工」（判"不通过"才返工，容易读成"这一步在返工"）⇒ **把关循环**；
   *     · `gate` 原来是英文裸词「gate」⇒ **等人确认**。
   * ⚠️ `stepKindAggregate`（聚合）**删掉**：`WorkflowStep.kind` 的类型里曾经有
   *   `'aggregate'`，但**引擎没有任何原语产出它**（`flow` / `parallel` / `loop` /
   *   `route` / `gate` 五个原语，没有 aggregate）——一条永远不会被渲染的词条。
   */
  'workflows.stepKindFlow': { zh: '流水线', en: 'Flow' },
  'workflows.stepKindParallel': { zh: '并行', en: 'Parallel' },
  // ⚠️ 老数据里有 `aggregate`（早期引擎产出过），词条保留——删了那一步会显示成"流水线"
  'workflows.stepKindAggregate': { zh: '聚合', en: 'Aggregate' },
  'workflows.stepKindLoop': { zh: '把关循环', en: 'Loop' },
  'workflows.stepKindRoute': { zh: '路由', en: 'Route' },
  'workflows.stepKindGate': { zh: '等人确认', en: 'Confirm' },
  'workflows.pause': { zh: '暂停', en: 'Pause' },
  'workflows.resume': { zh: '继续', en: 'Resume' },
  'workflows.confirm': { zh: '确认', en: 'Confirm' },
  'workflows.gateReject': { zh: '否决并打回重写', en: 'Reject & rework' },
  'workflows.gateFeedbackLabel': { zh: '你的意见（不通过时必填，会附加给 agent 重写）', en: 'Your feedback (required when rejecting; appended for rework)' },
  'workflows.noOutput': { zh: '（这个 agent 还没有产出）', en: '(no output from this agent yet)' },
  'workflows.stepWorking': { zh: '（这个 agent 正在跑…）', en: '(agent working…)' },
  /*
   * loop 卡那两行的标题。
   *
   * ⚠️ 2026-11（S5）：这两个键原来叫 `workflows.loopWriter`（「写作员」）/
   *   `workflows.loopReviewer`（「审查员」）——"执行者 / 审核者"两个角色的别名，而
   *   **角色已经退场**。现在那两行显示**这条 run 真正的 agent 名字**；取不到时
   *   才退回这两条通用说法（不编一个名字）。
   */
  'workflows.loopExecLabel': { zh: '执行者', en: 'Runner' },
  'workflows.loopGuardLabel': { zh: '把关者', en: 'Guard' },
  /** loop 卡每行名字后面那一小句：第几轮、是执行还是把关。 */
  'workflows.loopExecMeta': { zh: '第 {n} 轮 · 执行', en: 'round {n} · run' },
  'workflows.loopGuardMeta': { zh: '第 {n} 轮 · 把关', en: 'round {n} · guard' },
  /** 轮次容器的标题（卡片嵌套：步骤卡 → 轮次卡 → Agent 卡）。 */
  'workflows.loopRound': { zh: '第 {n} 轮', en: 'Round {n}' },
  /** 流水线 / 并行里每一级的序号（`2/3`）。 */
  'workflows.stageMeta': { zh: '第 {i}/{n} 步', en: 'step {i}/{n}' },
  /**
   * 每张 Agent 卡片右上角那颗「日志」按钮（2026-11 使用者定稿）：
   * "卡片内部右上角有一个按钮来决定是否要展开日志……这样并行多个 Agent 的时候，
   *  我可以分开查看其日志。"
   */
  // 开关状态靠箭头（▸ / ▾）表达，词条只有一份——两条同文的词就是噪音。
  'workflows.log': { zh: '日志', en: 'Log' },
  'workflows.loopReviewing': { zh: '（把关中…）', en: '(checking…)' },
  'workflows.expand': { zh: '展开过程', en: 'Show log' },
  'workflows.collapse': { zh: '收起过程', en: 'Hide log' },
  'workflows.runStatusQueued': { zh: '排队中', en: 'Queued' },
  'workflows.runStatusRunning': { zh: '进行中', en: 'Running' },
  'workflows.runStatusPaused': { zh: '已暂停', en: 'Paused' },
  'workflows.runStatusWaitingHuman': { zh: '等你确认', en: 'Waiting for you' },
  'workflows.runStatusDone': { zh: '完成', en: 'Done' },
  'workflows.runStatusFailed': { zh: '失败', en: 'Failed' },
  'workflows.retryStep': { zh: '重试此步', en: 'Retry step' },
  'workflows.workDirTitle': { zh: '工作目录', en: 'Work directory' },
  'workflows.noRunYet': { zh: '还没开始跑', en: 'Not started yet' },
  'workflows.parallelRunning': { zh: '并行子步进行中', en: 'Parallel steps running' },

  // ── 任务列表徽标（Tasks.svelte 里编排任务的标记）──
  'workflows.taskBadge': { zh: '编排', en: 'Workflow' },

  /*
   * ⚠️ 2026-11（D132）：「编排任务」页（`views/WorkflowRuns.svelte`）删掉了——
   *   编排的运行在**任务页**里按编排分组列着，点开就是同一个运行画面。
   *   它的六个词条（`workflowruns.*`）随之删；整段的词条会因为没人引用而
   *   被 `i18n.test.ts` 的死词条检查抓住，所以删干净。
   */
}
