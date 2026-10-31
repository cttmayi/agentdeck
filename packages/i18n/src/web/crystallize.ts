import type { TextCatalog } from '../text.ts'

/**
 * 聊天/任务沉淀 skill（D80）——`views/Chat.svelte` 与 `views/Tasks.svelte`
 * 的「沉淀技能&智能体」入口 + `components/CrystallizeView.svelte`
 * 全页流程（设计 §4.1.1 界面改版：任务详情式全页 + 步骤条 + 分节渐进展开）。
 *
 * 流程：选目标（新建必填作用描述 / 更新本次加载的）→ 起草 run → 草稿审阅 →
 * 确认入库；有进行中的起草时可「继续」恢复。
 *
 * ⚠️ zh / en 两边都要有，占位符要一致（`i18n.test.ts` 逐条守着）。
 */
export const crystallizeText = {
  /**
   * ★ 分批第 39 批：入口名字改成「沉淀技能&智能体」。
   *
   * 使用者的原话：「改一下名称吧，『沉淀技能&智能体』，之前的名字以为只有 skill」——
   * 分批第 34–38 批加了"优化一条已有智能体的指令"之后，名字还只提 skill，
   * 那条路等于**从名字上就不存在**（他没找到入口）。
   *
   * 口径：这一格同时用于**页面标题**与**对话页那个按钮**，两处必须是同一个名字
   * （同一个功能在两个地方叫两个名字，是这一族缺陷的老来源）。
   */
  'crystallize.title': { zh: '沉淀技能&智能体', en: 'Crystallize skill or agent' },

  // ── 导航（三轮：沉淀是独立一页，导航列工具之下） ──
  'crystallize.navTitle': { zh: '沉淀', en: 'Crystallize' },
  'crystallize.navHint': {
    zh: '把对话/任务的经验沉淀成 skill，或优化一条智能体的指令（起草不占任务列表）',
    en: 'Turn chats & tasks into skills (drafts live here, not in the task list)',
  },
  'crystallize.newEntry': { zh: '新建沉淀', en: 'New' },
  'crystallize.pickHint': {
    // ⚠️ 2026-10-21：原文案末尾写着「（设计 §4.3）」——**内部文档编号漏进了界面**。
    //    使用者看到的是一个他无法查证的编号（探针里量到过），那句话本身也已经说清了规则。
    zh: '来源 = 对话或任务；任务要有审核结论或你给的反馈',
    en: 'Source = a conversation or a task; tasks need a review verdict or your feedback',
  },

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
  /**
   * ★ 分批第 140 批（U4a）：步骤条删掉之后，顶栏状态徽标要能说全四种状态。
   *   `done` = 已入库（那是沉淀真正的完成线，不是 run 跑完）；`asking` = 还在问问题。
   */
  'crystallize.state.done': { zh: '已入库', en: 'Saved' },
  'crystallize.status.asking': { zh: '提问中', en: 'Asking' },
  /**
   * ★ 分批第 141 批（U4b）：**起点变成页面内的第一问**（「新建沉淀」不再弹 Modal）。
   *   选项 = 最近的会话/任务 + 「从空白或材料起」；一条也没有时如实说可以走空白起。
   */
  'crystallize.newStartBlank': { zh: '从空白或材料起', en: 'Start from blank / materials' },
  'crystallize.newStartBlankHint': {
    zh: '没有可沉淀的记录，只有你接下来给的材料',
    en: 'No conversation to distill — only the materials you provide',
  },
  'crystallize.newStartFrom': {
    zh: '从{kind}「{label}」沉淀成技能',
    en: 'Distill a skill from {kind} "{label}"',
  },
  'crystallize.newStartEmpty': {
    zh: '还没有可选的会话或任务——可以直接从空白或材料起。',
    en: 'No conversations or tasks yet — start from blank or materials.',
  },
  'crystallize.discard': { zh: '放弃这条沉淀', en: 'Discard this crystallization' },
  'crystallize.discardConfirm': {
    zh: '放弃「{label}」这条沉淀？草稿会从列表移除，已入库的技能不受影响。',
    en: 'Discard the crystallization of "{label}"? The draft leaves the list; committed skills are untouched.',
  },
  'crystallize.discarded': { zh: '已放弃', en: 'Discarded' },
  'crystallize.sourceUnknown': { zh: '来源未知', en: 'Unknown source' },
  'crystallize.rowNew': { zh: '新建', en: 'New' },
  /**
   * ★ 分批第 38 批：「沉淀成 Agent」的草稿行。只用 id 尾段——列表接口只给 id，
   * 而为了一个名字把整张智能体表带进列表接口（或反过来在列表里 N+1 查）都不划算。
   */
  'crystallize.rowAgent': { zh: '优化指令 · {id}', en: 'Improve instructions · {id}' },
  'crystallize.rowUpdate': { zh: '更新 {slug}', en: 'Update {slug}' },

  // ── 步骤条 ──
  'crystallize.stepTarget': { zh: '沉淀目标', en: 'Target' },
  // ── 机械体检（分批第 137 批：§12.15「不要评审，只要体检」的界面说法）──
  //  ⚠️ 措辞不许说"审核/通过（审核意义上）"：入库时只能声称"只过了机械体检（N 项）"（§12.15 代价 ③）。
  'crystallize.checkTitle': { zh: '机械体检', en: 'mechanical check' },
  'crystallize.checkPassed': { zh: '体检通过', en: 'Check passed' },
  'crystallize.checkProblems': {
    zh: '体检发现 {n} 处问题',
    en: 'Check found {n} problem(s)',
  },
  // 正在编辑正文时不自动切版：只挂一条提示（自动切会丢掉没保存的字）
  'crystallize.newVersionHint': { zh: '这条沉淀有了新一版（你正在编辑，没有自动切过去）', en: 'This crystallization has a new version (not switched automatically while you are editing)' },
  'crystallize.newVersionGo': { zh: '切到新版', en: 'Go to the new version' },
  // 分批第 29 批：草稿这一版还在跑 ⇒ 显示实时日志（原来默认显示"最后结果"= 上一版的旧文本）
  'crystallize.draftLiveHint': { zh: '这一版还在跑，下面是实时日志', en: 'This version is still running; live log below' },
  'crystallize.saveDraft': { zh: '保存改动', en: 'Save changes' },
  'crystallize.saveDraftDone': { zh: '已保存到草稿（审核还没看到它）', en: 'Saved (the audit has not seen this yet)' },
  'crystallize.saveDraftHint': {
    zh: '把改动写回草稿目录——审核者读的是磁盘上那一份，不保存它看不到',
    en: 'Write the edits back to the draft directory — the reviewer reads that file',
  },

  // ── 沉淀目标（目标态） ──
  'crystallize.targetNew': { zh: '新建 skill', en: 'New skill' },
  /**
   * ★ 分批第 37 批：「沉淀成 Agent」= 优化**一条已有智能体**的指令。
   *
   * 文案里刻意不出现"新建"二字（使用者定过：不新建 agent，只更新当前这一条），
   * 也不用 `**` 与反引号（D39）。
   */
  'crystallize.targetAgent': { zh: '优化一条智能体的指令', en: "Improve an agent's instructions" },
  'crystallize.agentCandidateExecutor': { zh: '执行者（这次干活的那条）', en: 'Executor (ran this task)' },
  'crystallize.agentCandidateReviewer': { zh: '审核者（这次审判的那条）', en: 'Reviewer (judged this task)' },
  'crystallize.agentCharsHint': { zh: '当前 {chars} 字符 / 上限 6000', en: 'Currently {chars} chars / limit 6000' },
  'crystallize.agentBuiltinHint': {
    zh: '平台内置：指令是平台的默认值，改它等于改默认（随时可恢复上一版）',
    en: 'Built-in: these are the platform defaults; editing changes the default (you can always restore the previous version)',
  },
  'crystallize.doneAgentSnapshot': {
    zh: '旧指令已留成一代快照——在智能体页点「恢复上一版」随时退回去',
    en: 'Previous instructions were saved as a snapshot — use Restore previous version on the agent page to roll back',
  },
  'crystallize.targetUpdate': { zh: '更新本次加载的 skill', en: 'Update a loaded skill' },
  'crystallize.targetUpdateHint': {
    zh: '对话/任务是在矫正正在用的 skill——更新目标就是它（提炼的=进化；安装的=存为你的版本并遮蔽）',
    en: 'This conversation/task corrects the skills in use — those are the update targets (yours = evolve; installed = save as your version and shadow)',
  },
  // ★ 分批第 133 批：这条标着"可选"，而 intake 里"新建"**必填**（`purposeMissing` 禁用下一步）、
  //   §12.13 也定了"作用描述必答"——UI 自己前后矛盾。改成"必答"，与行为对上。
  'crystallize.purposeLabel': { zh: '作用描述（必答）', en: 'Purpose (required)' },
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
  // ★ 分批第 150 批：顶栏「开始提炼」删掉之后 `crystallize.start` 没有引用处了
  //   （开始那一问的按钮文字在 `CrystallizeIntake` 里写着"开始提炼"）。
  //   同一个位置换成本条：说明「确认入库」为什么按不动（体检没过 / slug 空）。
  'crystallize.confirmBlocked': {
    zh: '还不能入库：机械体检没过（右上「产物」栏能逐项看）',
    en: 'Not ready: the mechanical check failed (see the artifact pane for details)',
  },

  // ── 素材摘要（起草前就可见，§4.1.1） ──
  'crystallize.materialSummary': {
    zh: '{turns} 轮 · {tools} 次工具调用',
    en: '{turns} turns · {tools} tool calls',
  },
  // ── 对话里那行"我当时给了它什么"（§12.14：与右栏清单**同一份数据现算**）──
  'crystallize.materialCount': { zh: '材料 {n} 项（{parts}）', en: 'Material: {n} ({parts})' },
  'crystallize.materialCountTrace': { zh: '轨迹 {n}', en: '{n} trace' },
  'crystallize.materialCountGiven': { zh: '使用者给 {n}', en: '{n} from you' },
  'crystallize.materialCountNone': { zh: '这次没有材料', en: 'No material this time' },
  // ── 草案期：材料能看不能改（分批第 163 批）──
  'crystallize.materialLockedUntilDone': {
    zh: '起草跑完才能改材料（这一版读到的素材已经定了）',
    en: 'Material can only change after the draft finishes (this version already read its material)',
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
  // ★ 分批第 18 批：第三条基线——"原 skill 的变化"（使用者定稿：「skill 差异对比也应该是原 skill 变化」）。
  //   简称给结论条用（它那一行有字数压力），全称给切换钮用。
  'crystallize.diffVsOriginal': { zh: '对比原 skill', en: 'vs original skill' },
  'crystallize.vsOriginalShort': { zh: '对比原 skill', en: 'vs original' },
  'crystallize.diffLoading': { zh: '正在算差异…', en: 'Computing diff…' },
  'crystallize.diffUnchanged': { zh: '这个文件相对基线没有变化。', en: 'No change against the baseline.' },
  'crystallize.materialTitle': { zh: '素材', en: 'Material' },
  'crystallize.materialEmpty': { zh: '没有素材文件', en: 'No material files' },
  'crystallize.materialTruncated': { zh: '（过长，已截断）', en: '(truncated)' },
  // 列表行上的"第几版"（分批第 17 批）：一行是一个**任务**，版本数是它的属性。
  // 不带 markdown 记号（界面文案守卫）。
  'crystallize.reviseTitle': {
    zh: '反馈',
    en: 'Give feedback',
  },
  'crystallize.revisePlaceholder': {
    zh: '比如：Procedure 第 2 步要写全命令参数；Pitfalls 里那条环境问题删掉',
    en: 'e.g. spell out the full command in step 2; drop the environment issue from Pitfalls',
  },
  // ★ 分批第 17 批改文案：使用者定稿「原则上，应该叫"反馈"，在原任务中执行」。
  //   原来叫「重新起草」——那个词把这件事说成了"另起一版"，而它实际是**把意见交回同一个任务**
  //   （第 16 批已经让它在原目录里执行）。名字与行为要对上：叫"重新起草"，使用者就会预期
  //   多出来一个任务（他也确实是这么理解的，并且判定那样不好）。
  // ⚠️ 提交按钮必须与开框那个（`crystallize.reviseTitle` = 「反馈」）**不同名**：两个按钮同名时
  //    "点一下"这类判据分不清点的是哪个（探针当场红：`点它之后输入框真的出现` 量到 null，
  //    因为它找到了提交钮、而提交钮在框里、框还没开）。开框 = 「反馈」，发出 = 「提交反馈」。
  'crystallize.reviseSubmit': { zh: '提交反馈', en: 'Submit feedback' },
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

  // ── 任务页「沉淀技能&智能体」按钮的触发前置（Skills 列表也在用下面四个） ──
  'crystallize.taskGated': {
    zh: '该任务没有反馈、也未审核，无法据此沉淀技能或智能体',
    en: 'No feedback or review on this task — nothing to crystallize a skill or agent from',
  },
  'crystallize.optimize': { zh: '沉淀技能&智能体', en: 'Crystallize' },
  'crystallize.shadowed': { zh: '被你的版本遮蔽', en: 'shadowed by yours' },
  'crystallize.groupMine': { zh: '我提炼的', en: 'Mine' },
  'crystallize.groupInstalled': { zh: '安装的', en: 'Installed' },
  'crystallize.mineBadge': { zh: '我提炼的', en: 'mine' },

  // ── 产物栏（分批第 92 批：U1 骨架的右栏，常驻、不随对话滚走） ──
  // ★ 分批第 155 批：`crystallize.artifactFiles`（"文件"那一节的标题）删掉了——
  //   右栏里的文件清单就是**编辑器的树**，它自己不需要一个"文件"标题（树紧挨着正文）。
  'crystallize.artifactTitle': { zh: '产物', en: 'Artifact' },
  'crystallize.artifactChecks': { zh: '机械体检', en: 'Checks' },
  // 接口只回“哪些项有问题”（`validation.problems`），没有“检查项总数”——
  // 所以这里不能说“N 过 M 缺”，只能说实话：通过了 / 有几项问题。
  'crystallize.artifactChecksPassed': { zh: '通过', en: 'Passed' },
  'crystallize.artifactChecksProblems': { zh: '{n} 项问题', en: '{n} problems' },
  'crystallize.artifactEmpty': {
    zh: '还没有产物。起草完成后，文件会出现在这里；过程仍留在中间那一栏。',
    en: 'No artifact yet. Files show up here once drafting finishes; the process stays in the middle pane.',
  },
  'crystallize.artifactMaterial': { zh: '材料', en: 'Material' },
  'crystallize.artifactMaterialEmpty': { zh: '还没有素材文件', en: 'No material files yet' },
  // ── 材料的"删掉"（分批第 147 批，§12.14「右栏清单……删掉错的」）──
  //     只有 `appended/` 下（使用者给的）能删；平台从来源 run 切出来的证据不给删
  //     （删了"依据"就和来源对不上，且下次起草会切回来）。所以这几条文案只出现在
  //     "使用者给的"那几行与分节标题上。
  'crystallize.materialDelete': { zh: '删掉', en: 'Delete' },
  'crystallize.materialDeleteConfirm': { zh: '确认删掉', en: 'Confirm' },
  'crystallize.materialDeleteOnly': {
    zh: '只有使用者给的素材（appended/）能删：其余是从来源 run 切出来的证据',
    en: 'Only materials you provided (appended/) can be deleted — the rest is evidence cut from the source run',
  },
  'crystallize.materialDeleteDone': {
    zh: '已删掉 {path}（还剩 {n} 份材料）——下一版草稿不会再读到它；自动带的素材没动',
    en: 'Deleted {path} ({n} left) — the next draft will not read it; auto-collected material untouched',
  },
  // ── 追加的其它形态（分批第 148 批，§12.4 材料卡：拖文件 / 选目录）──
  'crystallize.materialDropHint': {
    zh: '把文本文件拖到这里，或选文件 / 选目录（单份 ≤ 100 KB）',
    en: 'Drop text files here, or pick files / a folder (≤ 100 KB each)',
  },
  'crystallize.materialAddFiles': { zh: '选文件', en: 'Pick files' },
  'crystallize.materialAddDir': { zh: '选目录', en: 'Pick folder' },
  'crystallize.materialAddDone': {
    zh: '加了 {n} 份材料（已登记进素材索引，下一版起草会读它）',
    en: 'Added {n} material file(s) — registered in the material index for the next draft',
  },
  'crystallize.materialAddSkipped': {
    zh: '没加的：{items}',
    en: 'Not added: {items}',
  },
  // ── 从仓库拉（分批第 157 批，§12.54）──
  'crystallize.materialRepoPlaceholder': {
    zh: 'GitHub 仓库地址（https://github.com/owner/repo，或 owner/repo）',
    en: 'GitHub repo URL (https://github.com/owner/repo, or owner/repo)',
  },
  'crystallize.materialRepoPull': { zh: '拉进来', en: 'Pull' },
  // ── 右栏差异浮层的出口（分批第 160 批：差异盖满右栏，必须自带"返回内容"）──
  'crystallize.diffBackToContent': { zh: '返回内容', en: 'Back to content' },
  'crystallize.materialRepoDone': {
    zh: '从仓库拉了 {files} 个文件（{kb} KB）到 {dir}/，已登记进素材索引',
    en: 'Pulled {files} file(s) ({kb} KB) from the repo into {dir}/ and registered them in the material index',
  },
  'crystallize.materialRepoHasSkill': {
    zh: '这个仓库里有 SKILL.md——如果你要的是「更新那个技能」，请从技能页发起；当素材用就继续。',
    en: 'This repo contains SKILL.md — to update that skill, start from the Skills page; continue if you only want it as material.',
  },
  'crystallize.artifactOpen': { zh: '产物', en: 'Artifact' },
  'crystallize.artifactClose': { zh: '收起', en: 'Collapse' },
  // ★ 分批第 171 批：产物栏宽度可拖（把手在中间栏与右栏之间）
  'crystallize.artifactResize': { zh: '拖动调整产物栏宽度', en: 'Drag to resize the artifact pane' },
  // ── 沉淀用技能（分批第 173 批：注入式，但不预置在仓库里，由使用者自己装）──
  'crystallize.draftSkill': { zh: '沉淀用技能', en: 'Skill for drafting' },
  'crystallize.draftSkillInstalled': { zh: '已装好：{name}（起草时会注入它）', en: 'Installed: {name} (injected while drafting)' },
  'crystallize.draftSkillInstall': { zh: '一键安装 distilly', en: 'Install distilly' },
  // ── 沉淀设置页（分批第 175 批）──
  'crystallize.settingsEntry': { zh: '沉淀设置', en: 'Crystallize settings' },
  'crystallize.settingsSkill': { zh: '沉淀用技能', en: 'Skill for drafting' },
  'crystallize.settingsSkillHint': {
    zh: '起草时把这个技能注入给起草者（它按技能里的流程干活）。技能不随项目发布，一键安装的是上游仓库那份。',
    en: 'Injected into the drafter (it follows that skill). Not bundled — the one-click install pulls the upstream copy.',
  },
  'crystallize.settingsSkillRequired': {
    zh: '还没安装：装好之前不能开始沉淀（起草者手里没有"怎么写"的那份依据）。',
    en: 'Not installed — crystallization cannot start until it is (the drafter would have no "how to write" reference).',
  },
  'crystallize.settingsInstalled': { zh: '装好了，现在可以开始沉淀。', en: 'Installed — crystallization can start now.' },
  // ── GitHub 加速器（分批第 187 批：设置项，改完即时生效，不用重启）──
  'crystallize.settingsProxy': { zh: 'GitHub 加速器', en: 'GitHub accelerator' },
  'crystallize.settingsProxyHint': {
    zh: '装技能时下载走哪个加速器。空 = 直连（默认）。它是第三方：能看也能改转发的内容，所以默认关，且走它时不带你的令牌。国内直连不稳时填 https://gh-proxy.org。',
    en: 'Which accelerator to use when installing. Empty = direct (default). It is a third party: it can see and alter what it forwards, so it is off by default and your token is never sent through it.',
  },
  'crystallize.settingsProxySave': { zh: '保存', en: 'Save' },
  'crystallize.settingsProxyClear': { zh: '改回直连', en: 'Use direct' },
  'crystallize.settingsProxyOn': { zh: '已启用：{url}（下次装技能生效）', en: 'Enabled: {url} (applies to the next install)' },
  'crystallize.settingsProxyOff': { zh: '已改回直连。', en: 'Switched back to direct.' },
  'crystallize.settingsSkillRequiredShort': {
    zh: '未安装沉淀用技能 ⇒ 不能开始沉淀（右上「沉淀设置」里装）',
    en: 'No drafting skill installed — crystallization is blocked (install it in Crystallize settings)',
  },
  'crystallize.artifactLoading': { zh: '载入产物…', en: 'Loading artifact…' },

  // ── U3a 消息流外壳的栏脚（分批第 106 批：先占位，U3d 才接线） ──
  'crystallize.chatPlaceholder': {
    zh: '跟这次沉淀说一句话（下一批接上）',
    en: 'Say something to this crystallization (wired in the next batch)',
  },

  'crystallize.chatSend': { zh: '发送', en: 'Send' },

  // ── 错误 ──
  'crystallize.errTargets': { zh: '读取沉淀信息失败：{error}', en: 'Failed to load crystallize info: {error}' },
  'crystallize.errDraftRejected': { zh: '起草未受理：{error}', en: 'Draft not accepted: {error}' },
  'crystallize.errSave': { zh: '入库失败：{error}', en: 'Save failed: {error}' },
} satisfies TextCatalog
