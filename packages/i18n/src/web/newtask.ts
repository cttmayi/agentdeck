import type { TextCatalog } from '../text.ts'

/**
 * 「新建任务」表单的文案。
 *
 * ══════════════════════════════════════════════════════════════════
 * 2026-10 简化（使用者拍板）：「执行 → 审核 → 行动」三步链 + 各类"只对这一次"
 * 的覆盖全部去掉，表单只剩三样——**要做什么**、**交给谁**（智能体或智能体组）、
 * 提交。选中后显示一行**摘要**（执行者 / 审核者 / 动作 / 返工），告诉使用者
 * 这次任务实际会怎么走（全部跟随长期配置或组的默认）。
 * ══════════════════════════════════════════════════════════════════
 */
export const newtaskText = {
  // ── 要做什么 ──
  'newtask.titleLabel': { zh: '要做什么', en: 'What needs doing' },
  'newtask.titlePlaceholder': {
    zh: '把要做的事写清楚。第一行会被当成任务标题，其余进入说明。',
    en: 'Describe what needs to be done. The first line becomes the task title; the rest goes into the description.',
  },
  'newtask.titleSplitHint': {
    zh: '第一行是任务标题（想换标题就按一下回车），其余全进说明。',
    en: 'The first line is the task title (press Enter to make a new one); the rest goes into the description.',
  },

  // ── 交给谁 ──
  'newtask.pickTitle': { zh: '交给谁', en: 'Assign to' },
  /*
   * ⚠️ 2026-11（S3）：`newtask.sourceAgent` / `sourceGroup`（"智能体 / 智能体组"
   *   互斥切换的两个按钮）随智能体组退场删——只剩"交给哪个智能体"。
   */
  'newtask.agentLabel': { zh: '交给哪个智能体', en: 'Which agent gets it' },
  'newtask.submitNotReady': {
    zh: '先写要做什么、并选好交给谁',
    en: 'Write the task and pick who it goes to first',
  },
  'newtask.noExecutorOption': { zh: '（没有可执行的智能体）', en: '(no executor available)' },
  'newtask.createExecutorBefore': { zh: '去「智能体」页建一个', en: 'Create one with the ' },
  'newtask.executorStrong': { zh: '执行', en: 'executor' },
  'newtask.createExecutorAfter1': { zh: '角色，再回来建任务。只有', en: 'role, then come back. Only ' },
  'newtask.createExecutorAfter2': { zh: '不接任务。', en: 'takes tasks.' },
  'newtask.defaultSuffix': { zh: '（默认）', en: ' (default)' },
  'newtask.defaultHint': {
    zh: '默认执行者是「智能体」页里设为默认的那个；没设过就用列表里第一个。',
    en: 'The default executor is the one set as default under Agents; otherwise the first in the list.',
  },

  /*
   * ⚠️ 2026-11（S3）：这里原来是「智能体组」那一档的四条词条（`groupLabel` /
   *   `groupPickPlaceholder` / `groupPickRequired` / `groupBroken`）。组退场 ⇒ 全删。
   */

  // ── 摘要（选中后显示，只读）──
  // ⚠️ 2026-11（S3）：`newtask.summaryTitleGroup`（「智能体组摘要」）随组退场删。
  'newtask.summaryTitleAgent': { zh: '智能体摘要', en: 'Agent summary' },
  'newtask.summaryExecutor': { zh: '执行者', en: 'Executor' },
  /*
   * ⚠️ 2026-11（D125）：这里原来还有「审核者」那一行的四条词条——
   *   `newtask.summaryReviewer`、`newtask.summaryReviewerGone`（组里那个审核者
   *   已不存在）、`newtask.summaryReviewerAgentPath`（选单个智能体就不会被审）、
   *   以及底栏的 `newtask.footReviewer` / `newtask.footReviewerNone`。
   *   审核 run 退场 ⇒ 新建任务不再有"谁审"这一栏，五条一起删。
   *
   *   ⚠️ `summaryReviewerAgentPath` 那条词条的教训留着：**"你的产出不会有人看"
   *   这类后果必须主动说出来**——不画那一行，使用者看到的界面与"有人审"只差
   *   一行，而这一行恰恰是最要紧的那一行，且没有任何地方会报错。
   */
  /*
   * ⚠️ 2026-11（D124）：这里原来有 `summaryRework` / `Zero` / `Times` / `Unlimited`
   *   四条——新建任务页摘要里那一行「返工：不返工 / 最多 N 次 / 无限」。
   *   返工退场 ⇒ 任务不再有返工预算，四条一起删。
   */
  // ── 底部提交栏 ──
  'newtask.footExecutor': { zh: '交给 {name}', en: 'to {name}' },

  // ── 高级（工作目录）──
  'newtask.advancedSummary': { zh: '高级选项', en: 'Advanced' },
  'newtask.workDirLabel': { zh: '工作目录', en: 'Work directory' },
  'newtask.workDirPlaceholder': { zh: '留空即自动分配', en: 'Leave empty to auto-assign' },
  'newtask.workDirHintBefore': { zh: '留空时', en: 'Leave it empty and ' },
  'newtask.workDirHintStrong': {
    zh: '每个任务会自动获得一个独立目录',
    en: 'every task gets its own directory automatically',
  },
  'newtask.workDirHintAfter1': { zh: '，不需要你操心。', en: ', with nothing for you to manage.' },
  'newtask.workDirHintAfter2': {
    zh: '填这里只在你要让智能体直接在你的仓库里干活时才有意义——填了之后，',
    en: 'Filling this in only makes sense when you want the agent to work directly in your own repository — once set,',
  },
  'newtask.workDirHintAfter3': {
    zh: '同一个目录同时只跑一个任务，其余排队。',
    en: 'only one task runs in that directory at a time; the rest queue.',
  },

  // ── 底部 ──
  'newtask.creating': { zh: '正在创建…', en: 'Creating…' },
  'newtask.createAndDispatch': { zh: '创建并派发', en: 'Create and dispatch' },

  // ── 命令式（事件回调里走 tx()） ──
  'newtask.noAgents': {
    zh: '还没有可用的智能体。先去「智能体」建一个。',
    en: 'No agent is available yet. Create one under “Agents” first.',
  },
  'newtask.createdToast': { zh: '已创建并派发', en: 'Created and dispatched' },
} as const satisfies TextCatalog
