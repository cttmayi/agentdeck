import type { TextCatalog } from '../text.ts'

/**
 * 聊天/任务沉淀 skill（D80）——`views/Chat.svelte` 与 `views/Tasks.svelte`
 * 的「沉淀成 skill / 优化 skill」入口 + `components/CrystallizeView.svelte`
 * 全页流程（设计 §4.1.1 界面改版：任务详情式全页 + 步骤条 + 分节渐进展开）。
 *
 * 流程：选目标（新建必填作用描述 / 更新本次加载的）→ 起草 run → 草稿审阅 →
 * 确认入库；有进行中的起草时可「继续」恢复。
 *
 * ⚠️ zh / en 两边都要有，占位符要一致（`i18n.test.ts` 逐条守着）。
 */
export const crystallizeText = {
  'crystallize.title': { zh: '沉淀成 skill', en: 'Crystallize into a skill' },

  // ── 步骤条 ──
  'crystallize.stepTarget': { zh: '沉淀目标', en: 'Target' },
  'crystallize.stepDraft': { zh: '起草 run', en: 'Draft run' },
  'crystallize.stepReview': { zh: '审阅入库', en: 'Review & save' },

  // ── 栏头返回 ──
  'crystallize.backToChat': { zh: '返回对话', en: 'Back to chat' },
  'crystallize.backToTask': { zh: '返回任务', en: 'Back to task' },

  // ── 沉淀目标（目标态） ──
  'crystallize.targetNew': { zh: '新建 skill', en: 'New skill' },
  'crystallize.targetUpdate': { zh: '更新本次加载的 skill', en: 'Update a loaded skill' },
  'crystallize.targetUpdateHint': {
    zh: '对话/任务是在矫正正在用的 skill——更新目标就是它（提炼的=进化；安装的=存为你的版本并遮蔽）',
    en: 'This conversation/task corrects the skills in use — those are the update targets (yours = evolve; installed = save as your version and shadow)',
  },
  'crystallize.noLoadedSkills': {
    zh: '本次对话没有加载 skill，只能新建',
    en: 'No skill loaded here — only "new" is available',
  },
  'crystallize.purposeLabel': { zh: '作用描述（必填）', en: 'Purpose (required)' },
  'crystallize.purposePlaceholder': {
    zh: '这个 skill 是做什么的？什么时候用？',
    en: 'What does this skill do? When to use it?',
  },
  'crystallize.purposeHint': {
    zh: '会作为草稿 description 的基底——"干什么用"这层是你自己的话，不会偏',
    en: 'Becomes the base of the draft description — the "what it does" layer stays your own words',
  },
  'crystallize.badgeMine': { zh: '你的', en: 'yours' },
  'crystallize.badgeInstalled': { zh: '安装的', en: 'installed' },
  'crystallize.updateIsEvolve': {
    zh: '选中 = 进化：素材 = 本次对话/任务 + 它的现有 SKILL.md，确认后覆盖',
    en: 'Select = evolve: material = this conversation/task + its current SKILL.md, overwrite on confirm',
  },
  'crystallize.updateIsShadow': {
    zh: '选中 = 基于安装版创建你的版本（遮蔽安装版；安装的不会被改动）',
    en: 'Select = create your version from it (shadows the installed one; the installed skill is untouched)',
  },
  'crystallize.userFeedbackLabel': { zh: '补充反馈（可选）', en: 'Additional feedback (optional)' },
  'crystallize.userFeedbackPlaceholder': {
    zh: '哪里不对 / 该怎么改（任务场景：审核判决会自动带上）',
    en: 'What went wrong / how to fix (task: the review verdict is included automatically)',
  },
  'crystallize.start': { zh: '开始沉淀', en: 'Start' },

  // ── 素材摘要（起草前就可见，§4.1.1） ──
  'crystallize.materialSection': { zh: '素材摘要', en: 'Material' },
  'crystallize.materialSummary': {
    zh: '{turns} 轮 · {tools} 次工具调用',
    en: '{turns} turns · {tools} tool calls',
  },
  'crystallize.scopeConversation': { zh: '对话', en: 'Conversation' },
  'crystallize.scopeTask': { zh: '任务', en: 'Task' },
  'crystallize.reviewedYes': { zh: '有审核判决', en: 'Reviewed' },
  'crystallize.reviewedNo': { zh: '无审核判决', en: 'Not reviewed' },
  'crystallize.feedbackNo': { zh: '无用户反馈', en: 'No user feedback' },
  'crystallize.noMaterial': {
    zh: '这个 run 没有可沉淀的内容——无法开始',
    en: 'Nothing to crystallize here — cannot start',
  },

  // ── 恢复进行中的起草（§4.1.1） ──
  'crystallize.resumeNotice': {
    zh: '有进行中的起草（{status}）',
    en: 'An in-progress draft exists ({status})',
  },
  'crystallize.resumeContinue': { zh: '继续', en: 'Continue' },
  'crystallize.resumeNew': { zh: '新起草', en: 'New draft' },

  // ── 起草 run ──
  'crystallize.draftSection': { zh: '起草 run', en: 'Draft run' },
  'crystallize.drafting': {
    zh: 'agent 正从素材里提炼 SKILL.md…（起草不进任务列表，进度都在这页）',
    en: 'The agent is extracting a SKILL.md from the material… (drafts live here, not in the task list)',
  },
  'crystallize.draftFailed': { zh: '起草失败', en: 'Drafting failed' },
  'crystallize.draftStopped': { zh: '已停止', en: 'Stopped' },
  'crystallize.retryDraft': { zh: '重新起草', en: 'Draft again' },

  // ── 草稿审阅 ──
  'crystallize.reviewTitle': { zh: '审阅草稿', en: 'Review draft' },
  'crystallize.slugLabel': { zh: 'slug（kebab-case）', en: 'slug (kebab-case)' },
  'crystallize.nameLabel': { zh: '名称', en: 'Name' },
  'crystallize.descriptionLabel': { zh: 'description（含触发条件）', en: 'description (with trigger condition)' },
  'crystallize.bodyLabel': { zh: '正文（SKILL.md）', en: 'Body (SKILL.md)' },
  'crystallize.confirm': { zh: '确认入库', en: 'Save' },
  'crystallize.abandon': { zh: '放弃', en: 'Discard' },
  'crystallize.clashMine': {
    zh: '已有你提炼的同名 skill（{slug}）——选「覆盖（进化）」或改名',
    en: 'You already crystallized a skill with this slug ({slug}) — overwrite (evolve) or rename',
  },
  'crystallize.switchToUpdate': { zh: '改为更新它', en: 'Update it instead' },

  // ── 完成态 ──
  'crystallize.doneTitle': { zh: '已沉淀', en: 'Crystallized' },
  'crystallize.doneText': {
    zh: 'skill {name} 已入库（skills-mine）',
    en: 'Skill {name} saved (skills-mine)',
  },
  'crystallize.doneVersioningOn': { zh: '已提交到 git', en: 'Committed to git' },
  'crystallize.viewSkill': { zh: '查看技能', en: 'View skill' },
  'crystallize.backToSource': { zh: '返回', en: 'Back' },

  // ── 任务页「优化 skill」按钮的触发前置（Skills 列表也在用下面四个） ──
  'crystallize.taskGated': {
    zh: '该任务没有反馈、也未审核，无法据此优化 skill',
    en: 'No feedback or review on this task — cannot optimize a skill from it',
  },
  'crystallize.taskGatedHint': {
    zh: '先给任务加反馈，或让它走完审核',
    en: 'Add feedback to the task, or let it finish review first',
  },
  'crystallize.optimize': { zh: '优化 skill', en: 'Optimize skill' },
  'crystallize.shadowed': { zh: '被你的版本遮蔽', en: 'shadowed by yours' },
  'crystallize.groupMine': { zh: '我提炼的', en: 'Mine' },
  'crystallize.groupInstalled': { zh: '安装的', en: 'Installed' },
  'crystallize.mineBadge': { zh: '我提炼的', en: 'mine' },

  // ── 错误 ──
  'crystallize.errTargets': { zh: '读取沉淀信息失败：{error}', en: 'Failed to load crystallize info: {error}' },
  'crystallize.errDraftRejected': { zh: '起草未受理：{error}', en: 'Draft not accepted: {error}' },
  'crystallize.errEmptyMaterial': { zh: '这个 run 没有可沉淀的内容', en: 'This run has nothing to crystallize' },
  'crystallize.errSave': { zh: '入库失败：{error}', en: 'Save failed: {error}' },
} satisfies TextCatalog
