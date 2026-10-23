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

  // ── 导航（三轮：沉淀是独立一页，导航列工具之下） ──
  'crystallize.navTitle': { zh: '沉淀', en: 'Crystallize' },
  'crystallize.navHint': {
    zh: '把对话/任务的经验沉淀成 skill（起草不占任务列表）',
    en: 'Turn chats & tasks into skills (drafts live here, not in the task list)',
  },
  'crystallize.newEntry': { zh: '新建沉淀', en: 'New' },
  'crystallize.pickTitle': { zh: '选择来源', en: 'Choose a source' },
  'crystallize.pickHint': {
    // ⚠️ 2026-10-21：原文案末尾写着「（设计 §4.3）」——**内部文档编号漏进了界面**。
    //    使用者看到的是一个他无法查证的编号（探针里量到过），那句话本身也已经说清了规则。
    zh: '来源 = 对话或任务；任务要有审核结论或你给的反馈',
    en: 'Source = a conversation or a task; tasks need a review verdict or your feedback',
  },
  'crystallize.pickNoConversations': {
    zh: '还没有可沉淀的对话（至少要有已结束的一轮）',
    en: 'No crystallizable conversations yet (need at least one finished turn)',
  },
  'crystallize.pickNoTasks': {
    zh: '还没有可沉淀的任务（需已结束且有审核/反馈）',
    en: 'No crystallizable tasks yet (need a finished one with review/feedback)',
  },
  'crystallize.cancel': { zh: '取消', en: 'Cancel' },
  'crystallize.pickTurns': { zh: '{turns} 轮', en: '{turns} turns' },

  // ── 沉淀任务列表（左栏） ──
  'crystallize.listCount': { zh: '{n} 条沉淀', en: '{n} crystallizations' },
  'crystallize.searchPlaceholder': { zh: '搜来源…', en: 'Search sources…' },
  'crystallize.listEmptyTitle': { zh: '还没有沉淀', en: 'No crystallizations yet' },
  'crystallize.listEmptyHint': {
    zh: '在聊天/任务页点「沉淀成 skill」/「优化 skill」，或点右上角「新建沉淀」',
    en: 'Click "Crystallize" in a chat or "Optimize skill" in a task, or use "New" at the top right',
  },
  // ── 沉淀任务的状态（不是起草 run 的状态） ──
  'crystallize.state.drafting': { zh: '起草中', en: 'Drafting' },
  'crystallize.state.review': { zh: '待审阅', en: 'Awaiting review' },
  'crystallize.state.failed': { zh: '起草失败', en: 'Draft failed' },
  'crystallize.state.stopped': { zh: '已停止', en: 'Stopped' },
  'crystallize.discard': { zh: '放弃这条沉淀', en: 'Discard this crystallization' },
  'crystallize.discardConfirm': {
    zh: '放弃「{label}」这条沉淀？草稿会从列表移除，已入库的技能不受影响。',
    en: 'Discard the crystallization of "{label}"? The draft leaves the list; committed skills are untouched.',
  },
  'crystallize.discarded': { zh: '已放弃', en: 'Discarded' },
  'crystallize.sourceUnknown': { zh: '来源未知', en: 'Unknown source' },
  'crystallize.rowNew': { zh: '新建', en: 'New' },
  'crystallize.rowUpdate': { zh: '更新 {slug}', en: 'Update {slug}' },

  // ── 步骤条 ──
  'crystallize.stepTarget': { zh: '沉淀目标', en: 'Target' },
  'crystallize.stepDraft': { zh: '起草 run', en: 'Draft run' },
  // §10.5 第 ⑤ 步：起草之后多了一步「审核」（内置审核者的预筛）。
  //  ⚠️ 文案要区分"审核"与"审阅入库"：前者是平台的预筛（结论），后者是人拍板入库。
  //     两个都叫"审"时，使用者会以为"审核通过了就是入库了"。
  // ★ 2026-10-21：原来的 `auditTitle`（「审核结论（预筛）」）没有使用者了——结论条上直接写
  //   「审核通过（预筛）」，标题那层壳去掉（它自占一行 h3 + 上下间距）。删键不留死词条。
  'crystallize.auditPrescreen': { zh: '预筛', en: 'pre-screen' },
  'crystallize.auditRunningShort': { zh: '审核运行中', en: 'Audit running' },
  // 2026-10-21：说明段收进按钮悬停，条上只留四个字（原来那段占 42px 两行）
  'crystallize.auditNotYetBrief': { zh: '还没审核过', en: 'Not audited yet' },
  // 2026-10-21：这段从**条上的段落**搬进了「开始审核」的悬停提示（段落占 42px 两行，
  // 而它是解释不是结论）。搬运时把"预筛"这个词补了进来——原来段落里只有"不替你做入库
  // 决定"，而结论条上写的是「审核通过（预筛）」：两处说的得是同一件事。
  'crystallize.auditNotYet': {
    zh: '这份草稿还没审核过。审核是一个内置智能体按"能不能用"过一遍，给出结论与问题清单——它是预筛，不替你做入库决定。',
    en: 'This draft has not been audited yet. The audit is a built-in agent checking whether the skill is usable; it does not decide the save for you.',
  },
  'crystallize.auditStart': { zh: '开始审核', en: 'Start audit' },
  // ⚠️ 2026-10-21 改文案：原来写的是"审核中…（跑完再看这里）"——而那时候界面上
  //    **没有任何东西可看**（不显示日志、不显示状态、失败也不说），使用者的原话是
  //    "审核的过程看不到，感觉一直没结束呢"。现在实时输出就在下面，所以这句话改成
  //    **指路**（告诉人下面是什么），而不是让人去别处等。
  'crystallize.auditRunning': {
    zh: '审核正在进行，下面是它的实时输出（跑完这里会自动换成结论）。',
    en: 'The audit is running; its live output is below (this switches to the verdict when it finishes).',
  },
  'crystallize.auditCancel': { zh: '取消审核', en: 'Cancel audit' },
  'crystallize.auditRetry': { zh: '重新审核', en: 'Audit again' },
  'crystallize.auditRunFailed': {
    zh: '审核没跑成（状态：{status}）。下面是它的日志——看清原因再决定要不要重来。',
    en: 'The audit run did not finish (status: {status}). Its log is below — read why before retrying.',
  },
  'crystallize.auditNoVerdict': {
    zh: '审核跑完了，但没有留下可用的判决（判决不合规或收口时出错）。这一步等于白跑，请重来一次或看下面的日志。',
    en: 'The audit finished but left no usable verdict (malformed verdict or a settle failure). This step was wasted — retry it, or read the log below.',
  },
  'crystallize.auditShowLog': { zh: '看审核日志', en: 'Show audit log' },
  'crystallize.auditPass': { zh: '通过', en: 'Passed' },
  'crystallize.auditFail': { zh: '不通过', en: 'Failed' },
  'crystallize.auditNeedsHuman': { zh: '无法判定（判决不合规）', en: 'Undecided (malformed verdict)' },
  'crystallize.auditShowDetail': { zh: '看 {n} 条问题', en: 'Show {n} issue(s)' },
  'crystallize.saveDraft': { zh: '保存改动', en: 'Save changes' },
  'crystallize.saveDraftDone': { zh: '已保存到草稿（审核还没看到它）', en: 'Saved (the audit has not seen this yet)' },
  'crystallize.saveDraftHint': {
    zh: '把改动写回草稿目录——审核者读的是磁盘上那一份，不保存它看不到',
    en: 'Write the edits back to the draft directory — the reviewer reads that file',
  },
  'crystallize.auditRetryNeedsSave': {
    zh: '先保存改动：现在重审的是磁盘上那一版，会把你没保存的改动漏掉',
    en: 'Save first: re-running now would audit the version on disk, not your edits',
  },
  'crystallize.auditStale': {
    zh: '内容已改 —— 这个结论是改之前的，要它算数得重新审一轮。',
    en: 'Content changed — this result is from before the change; re-run the audit to make it count.',
  },
  // ★ 分批第 12 批改文案：这个按钮**不再直接提交**（原来点了立刻起一条新 run，人连自己
  //   要发出去的话都没看见）。它现在只做一件事：把审核问题清单填进下面的意见框，由人改完再点。
  //   文案必须说清"它只填不提交"，否则人会以为点了就开始了（原来正是那样）。
  'crystallize.auditRedraft': { zh: '填入审核问题', en: 'Fill in the findings' },
  'crystallize.auditRedraftHint': {
    zh: '把审核者的问题清单填进下面的意见框（带位置与原文）——只填，不会直接开始起草；你可以改完再点「重新起草」。',
    en: 'Fills the feedback box below with the reviewer’s findings (with locations and source text). It only fills — it does not start drafting; edit it, then click “Draft again”.',
  },
  // ★ 填进意见框的那段话（结构与 daemon 的 `draftReviewFeedback` 对齐，见
  //   `apps/web/src/lib/crystallize-feedback.ts` 顶部的说明）。
  //
  // ⚠️ 唯一有意的差别：这里**不带 markdown 记号**（`**` / 反引号）。界面文案不许带记号的守卫
  //    是对的——它渲染在输入框里，`**逐条**` 会**原样**显示给人看。daemon 那份带记号是因为它
  //    只进 `feedback.md` 给 agent 读。所以两边"结构逐条对齐、记号不必对齐"。
  'crystallize.feedbackIntro': {
    zh: '审核不通过（理由码：{code}）。这一版请逐条对着下面每一条改：',
    en: 'The audit did not pass (reason code: {code}). For this version, fix each item below:',
  },
  'crystallize.feedbackWhere': { zh: '位置：', en: 'Where: ' },
  'crystallize.feedbackQuote': { zh: '原文：', en: 'Source: ' },
  'crystallize.feedbackNoEvidence': {
    zh: '（审核者没给位置，请自己找：这一条只说了现象。）',
    en: '(The reviewer gave no location — find it yourself; this item only names the symptom.)',
  },
  'crystallize.feedbackEmptyFindings': {
    zh: '（审核者没有给出条目清单，请按上面的理由码判断该改什么；不要动无关部分。）',
    en: '(The reviewer listed no items — judge from the reason code above what to change; leave the rest alone.)',
  },
  'crystallize.feedbackOutro': {
    zh: '改完把改过的文件写回 skill/ 目录（完整文件，不是补丁）；没改的文件不必重写。',
    en: 'Write the changed files back to the skill/ directory (complete files, not patch fragments); unchanged files need not be rewritten.',
  },
  'crystallize.auditRedraftFilled': {
    zh: '审核问题已填进意见框 —— 改完点「重新起草」才会开始。',
    en: 'Findings filled into the feedback box — nothing starts until you click “Draft again”.',
  },
  'crystallize.auditReworked': {
    zh: '已按上面的意见自动重新起草（第 {n} 版）',
    en: 'Auto re-drafted with the feedback above (version {n})',
  },
  'crystallize.auditExhausted': {
    zh: '自动返工的次数已用完 —— 要不要再来一版、或者就这样入库，由你决定。',
    en: 'Automatic re-drafts are used up — decide whether to try another version or save as is.',
  },
  'crystallize.auditNotRun': { zh: '审核没有跑成：{reason}', en: 'The audit did not run: {reason}' },
  'crystallize.stepReview': { zh: '审阅入库', en: 'Review & save' },

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
  'crystallize.purposeLabel': { zh: '作用描述（可选）', en: 'Purpose (optional)' },
  'crystallize.purposePlaceholder': {
    zh: '这个 skill 是做什么的？什么时候用？',
    en: 'What does this skill do? When to use it?',
  },
  'crystallize.purposeHint': {
    zh: '留空则由 skill 从素材推断——审阅时会把推断出的 description 摆在最上面，你一眼就能否定',
    en: 'Leave empty and the skill infers it from the material — the inferred description is shown at the top of the review for you to reject',
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
  // ★ 状态词用**任务状态**（起草中 / 待审阅），不是起草 run 的「已完成」——
  //   这里说"已完成"会让人以为沉淀本身完事了。
  'crystallize.resumeNotice': {
    zh: '有一条草稿还没收尾（{status}）',
    en: 'A draft is still unfinished ({status})',
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
  'crystallize.slugLabel': { zh: 'slug', en: 'slug' },
  // ⚠️ 2026-10-21 删掉 `crystallize.previewTitle`：使用者说"不需要「预览」"，
  //    那一段折叠预览连同它的 key 一起删了（留着 key 就是给下一个人一个假线索）。
  // ── 四轮：产出是文件集合（文件树 / 变更集 / 校验 / 兜底形态）──
  'crystallize.filesUnit': { zh: '个文件', en: 'files' },
  'crystallize.changeAdded': { zh: '新增', en: 'added' },
  'crystallize.changeModified': { zh: '修改', en: 'modified' },
  'crystallize.changeDeleted': { zh: '删除', en: 'deleted' },
  'crystallize.textModeHint': {
    zh: '（文本产物：这条起草没有写出文件，只有单文件 SKILL.md）',
    en: '(text artifact: this draft wrote no files, only a single SKILL.md)',
  },
  'crystallize.problemsTitle': { zh: '校验未通过', en: 'Validation failed' },
  'crystallize.noFiles': { zh: '没有产出任何文件', en: 'No files were produced' },
  'crystallize.deletedHint': {
    zh: '这个文件在草稿里没有，入库时会被删掉（更新 = 整目录替换）',
    en: 'This file is missing from the draft and will be deleted on save (update replaces the whole directory)',
  },
  'crystallize.refusedTitle': { zh: '起草者判定：这里没有可沉淀的内容', en: 'The drafter found nothing crystallizable' },
  // ── 四轮 P1：变更集 diff / 素材分节 / 按意见改一版 ──
  'crystallize.tabContent': { zh: '内容', en: 'Content' },
  'crystallize.tabDiff': { zh: '差异', en: 'Diff' },
  'crystallize.moreProblems': {
    zh: '还有 {count} 条（先改这几条再看）',
    en: 'and {count} more (fix these first)',
  },
  'crystallize.diffVsCurrent': { zh: '对比当前版本', en: 'vs current' },
  'crystallize.vsPreviousShort': { zh: '对比上一版', en: 'vs previous' },
  'crystallize.vsCurrentShort': { zh: '对比当前版本', en: 'vs current' },
  'crystallize.diffVsPrevious': { zh: '对比上一版草稿', en: 'vs previous draft' },
  'crystallize.diffLoading': { zh: '正在算差异…', en: 'Computing diff…' },
  'crystallize.diffUnchanged': { zh: '这个文件相对基线没有变化。', en: 'No change against the baseline.' },
  // ── 审阅屏的三个 tab（2026-10-21 第 3 批：信息分层——常驻的只有结论条那一块）──
  'crystallize.tabDraft': { zh: '草稿', en: 'Draft' },
  'crystallize.tabEvidence': { zh: '依据', en: 'Evidence' },
  'crystallize.tabProcess': { zh: '过程', en: 'Process' },
  // 起草中那一屏只有两个 tab：产出（run 的实时输出）/ 依据（目标 + 素材）
  'crystallize.tabOutput': { zh: '产出', en: 'Output' },
  'crystallize.auditFindingsTitle': { zh: '审核问题清单', en: 'Audit findings' },
  'crystallize.processNoAuditYet': {
    zh: '还没审核过，所以这里只有起草 run。',
    en: 'Not audited yet, so only the draft run is here.',
  },
  'crystallize.evidenceHead': {
    zh: '起草者读过的素材（它按需读的就是这些文件）',
    en: 'The material the drafter read (it reads these on demand)',
  },
  'crystallize.materialTitle': { zh: '素材', en: 'Material' },
  'crystallize.materialEmpty': { zh: '没有素材文件', en: 'No material files' },
  'crystallize.materialTruncated': { zh: '（过长，已截断）', en: '(truncated)' },
  'crystallize.reviseTitle': {
    zh: '按意见再改一版',
    en: 'Ask for another version',
  },
  'crystallize.revisePlaceholder': {
    zh: '比如：Procedure 第 2 步要写全命令参数；Pitfalls 里那条环境问题删掉',
    en: 'e.g. spell out the full command in step 2; drop the environment issue from Pitfalls',
  },
  'crystallize.reviseSubmit': { zh: '重新起草', en: 'Draft again' },
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
  'crystallize.optimize': { zh: '优化 skill', en: 'Optimize skill' },
  'crystallize.shadowed': { zh: '被你的版本遮蔽', en: 'shadowed by yours' },
  'crystallize.groupMine': { zh: '我提炼的', en: 'Mine' },
  'crystallize.groupInstalled': { zh: '安装的', en: 'Installed' },
  'crystallize.mineBadge': { zh: '我提炼的', en: 'mine' },

  // ── 错误 ──
  'crystallize.errTargets': { zh: '读取沉淀信息失败：{error}', en: 'Failed to load crystallize info: {error}' },
  'crystallize.errDraftRejected': { zh: '起草未受理：{error}', en: 'Draft not accepted: {error}' },
  'crystallize.errSave': { zh: '入库失败：{error}', en: 'Save failed: {error}' },
} satisfies TextCatalog
