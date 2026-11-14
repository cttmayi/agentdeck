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
  'workflows.title': { zh: '编排', en: 'Workflows' },
  'workflows.titleHint': { zh: '运行的任务在「任务」页查看', en: 'Runs show up in Tasks' },
  'workflows.listTitle': { zh: '所有编排', en: 'All workflows' },
  'workflows.new': { zh: '新建', en: 'New' },
  'workflows.empty': { zh: '还没有编排。用一个模板起步，或直接写代码。', en: 'No workflows yet. Start from a template, or write code.' },
  'workflows.templatesLabel': { zh: '从模板', en: 'From template' },
  'workflows.nameLabel': { zh: '名字', en: 'Name' },
  'workflows.namePlaceholder': { zh: '如：日报流水线', en: 'e.g. Daily pipeline' },
  'workflows.codeLabel': { zh: '编排代码', en: 'Workflow code' },
  'workflows.codePlaceholder': { zh: "await flow('组A', '要做什么')", en: "await flow('Group A', 'what to do')" },
  'workflows.save': { zh: '保存', en: 'Save' },
  'workflows.saved': { zh: '已保存', en: 'Saved' },
  'workflows.delete': { zh: '删除', en: 'Delete' },
  'workflows.confirmDelete': { zh: '删除这个编排？', en: 'Delete this workflow?' },
  'workflows.run': { zh: '运行', en: 'Run' },
  'workflows.updated': { zh: '更新于 {time}', en: 'Updated {time}' },
  'workflows.stepsHint': { zh: '步骤', en: 'steps' },
  'workflows.sourceTemplate': { zh: '模板', en: 'Template' },
  'workflows.sourceManual': { zh: '手写', en: 'Manual' },
  'workflows.sourceAi': { zh: 'AI 生成', en: 'AI' },

  // ── 发起运行表单 ──
  'workflows.runFormTitle': { zh: '发起一次运行', en: 'Start a run' },
  'workflows.promptLabel': { zh: '任务描述', en: 'Task description' },
  'workflows.promptPlaceholder': { zh: '这个任务叫什么、给谁看', en: 'What this task is about' },
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
  'workflows.stepKindFlow': { zh: '组跑', en: 'Flow' },
  'workflows.stepKindParallel': { zh: '并行', en: 'Parallel' },
  'workflows.stepKindAggregate': { zh: '聚合', en: 'Aggregate' },
  'workflows.stepKindLoop': { zh: '评审返工', en: 'Loop' },
  'workflows.stepKindRoute': { zh: '路由', en: 'Route' },
  'workflows.stepKindGate': { zh: 'gate', en: 'Gate' },
  'workflows.pause': { zh: '暂停', en: 'Pause' },
  'workflows.resume': { zh: '继续', en: 'Resume' },
  'workflows.confirm': { zh: '确认', en: 'Confirm' },
  'workflows.runStatusQueued': { zh: '排队中', en: 'Queued' },
  'workflows.runStatusRunning': { zh: '进行中', en: 'Running' },
  'workflows.runStatusPaused': { zh: '已暂停', en: 'Paused' },
  'workflows.runStatusWaitingHuman': { zh: '等你确认', en: 'Waiting for you' },
  'workflows.runStatusDone': { zh: '完成', en: 'Done' },
  'workflows.runStatusFailed': { zh: '失败', en: 'Failed' },
  'workflows.retryStep': { zh: '重试此步', en: 'Retry step' },
  'workflows.workDirTitle': { zh: '工作目录', en: 'Work directory' },
  'workflows.noRunYet': { zh: '还没开始跑', en: 'Not started yet' },

  // ── 任务列表徽标（Tasks.svelte 里编排任务的标记）──
  'workflows.taskBadge': { zh: '编排', en: 'Workflow' },
}
