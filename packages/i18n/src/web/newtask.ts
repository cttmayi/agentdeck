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
  'newtask.sourceAgent': { zh: '智能体', en: 'Agent' },
  'newtask.sourceGroup': { zh: '智能体组', en: 'Agent group' },
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

  // ── 智能体组 ──
  'newtask.groupLabel': { zh: '从智能体组', en: 'From an agent group' },
  'newtask.groupPickPlaceholder': { zh: '（选一个组）', en: '(pick a group)' },
  'newtask.groupPickRequired': {
    zh: '先选一个智能体组——执行者、审核者、动作、返工都会按组的默认走。',
    en: 'Pick an agent group first — its defaults for executor, reviewer, actions and rework will apply.',
  },
  'newtask.groupBroken': {
    zh: '这个组的执行者已经不在了（成员被删 / 组被改坏），换一个组或改用「智能体」。',
    en: 'This group’s executor is gone (members removed or the group is broken). Pick another group or use a single agent.',
  },

  // ── 摘要（选中后显示，只读）──
  // ★ 2026-10：标题随选中的是谁走——智能体 ⇒「智能体摘要」，智能体组 ⇒
  //   「智能体组摘要」（使用者点名：原来那句「这次任务会怎么走」改掉，并加粗）。
  'newtask.summaryTitleAgent': { zh: '智能体摘要', en: 'Agent summary' },
  'newtask.summaryTitleGroup': { zh: '智能体组摘要', en: 'Group summary' },
  'newtask.summaryExecutor': { zh: '执行者', en: 'Executor' },
  'newtask.summaryReviewer': { zh: '审核者', en: 'Reviewer' },
  'newtask.summaryActions': { zh: '允许的动作', en: 'Actions allowed' },
  'newtask.summaryActionsValue': { zh: '{n} 个', en: '{n}' },
  'newtask.summaryRework': { zh: '返工', en: 'Rework' },
  'newtask.summaryReworkZero': {
    zh: '不返工（判不通过直接交给人）',
    en: 'No rework (rejection goes straight to a human)',
  },
  'newtask.summaryReworkTimes': { zh: '最多 {n} 次', en: 'At most {n}×' },
  'newtask.summaryReworkUnlimited': {
    zh: '无限（不通过就一直重做）',
    en: 'Unlimited (keeps reworking)',
  },
  'newtask.summaryReviewerGone': {
    zh: '组里那个审核者已不存在，这次不会自动审',
    en: 'The group’s reviewer no longer exists; this task won’t be auto-reviewed',
  },
  'newtask.summaryNoReviewer': {
    zh: '未配置（这次不自动审）',
    en: 'Not configured (no auto review)',
  },
  /**
   * ★ 选了**单个智能体**那一档的摘要（2026-10 新增，必须画出来）。
   *
   * ══════════════════════════════════════════════════════════════════
   * 为什么这句不能省成"不画那一行"
   * ══════════════════════════════════════════════════════════════════
   *
   * 2026-10 撤掉 `Agent.reviewerAgentId` 之后，"选一个人"这条路上**没有任何东西**
   * 能回答"谁审"——组才是审核者的出处。于是选智能体 = 这条任务不会被审。
   *
   * 而这件事**必须说出来**：不画那一行的话，使用者看到的摘要与"选组"那条长得
   * 一样（只是少一行），而少的那一行恰恰意味着"你的产出不会有人看"。等他发现
   * 的时候，产出已经跑完了——**没有任何地方会报错**。
   *
   * ⚠️ 措辞要把下一步给出来（选个组），否则使用者只知道"没有审核者"，不知道
   *    该动哪里——这条规矩（早说 + 说清下一步）在本项目里一贯如此。
   */
  'newtask.summaryReviewerAgentPath': {
    zh: '没有——选单个智能体不会自动审核；要审核请在「交给谁」里改选一个智能体组',
    en: 'None — picking a single agent means no automatic review; to get one, switch “hand to” to an agent group',
  },

  // ── 底部提交栏 ──
  'newtask.footExecutor': { zh: '交给 {name}', en: 'to {name}' },
  'newtask.footReviewer': { zh: '由 {name} 审', en: 'reviewed by {name}' },
  'newtask.footReviewerNone': { zh: '不自动审核', en: 'no auto review' },
  'newtask.footActions': { zh: '允许 {n} 个动作', en: '{n} actions allowed' },

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
