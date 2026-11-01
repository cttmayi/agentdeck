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
  // ★ 分批第 191 批：「沉淀成 Agent」删了 ⇒ 标题只说技能（原来写"技能&智能体"会误导）。
  'crystallize.title': { zh: '沉淀技能', en: 'Crystallize a skill' },

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
  'crystallize.rowUpdate': { zh: '更新 {slug}', en: 'Update {slug}' },

  // ── 步骤条 ──
  'crystallize.stepTarget': { zh: '沉淀目标', en: 'Target' },
  // ── 机械体检（分批第 137 批：§12.15「不要评审，只要体检」的界面说法）──
  //  ⚠️ 措辞不许说"审核/通过（审核意义上）"：入库时只能声称"只过了机械体检（N 项）"（§12.15 代价 ③）。
  'crystallize.newVersionHint': { zh: '这条沉淀有了新一版（你正在编辑，没有自动切过去）', en: 'This crystallization has a new version (not switched automatically while you are editing)' },
  'crystallize.newVersionGo': { zh: '切到新版', en: 'Go to the new version' },
  'crystallize.saveDraft': { zh: '保存改动', en: 'Save changes' },
  'crystallize.saveDraftDone': { zh: '已保存到草稿（审核还没看到它）', en: 'Saved (the audit has not seen this yet)' },
  'crystallize.saveDraftHint': {
    zh: '把改动写回草稿目录——审核者读的是磁盘上那一份，不保存它看不到',
    en: 'Write the edits back to the draft directory — the reviewer reads that file',
  },

  // ── 沉淀目标（目标态） ──
  'crystallize.targetNew': { zh: '新建 skill', en: 'New skill' },
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
  'crystallize.materialCountOnly': { zh: '{n} 项', en: '{n} items' },
  'crystallize.materialCountTrace': { zh: '轨迹 {n}', en: '{n} trace' },
  'crystallize.materialCountGiven': { zh: '使用者给 {n}', en: '{n} from you' },
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


  /**
   * ── 起草这一轮（一句话的人话，不是 run 的抬头）──
   *
   * ★ 分批第 193 批：原来这里是 `crystallize.draftSection`（「起草 run」）+
   *   `crystallize.drafting`（「agent 正从素材里提炼 SKILL.md…」）+ `draftLiveHint`。
   *   使用者："目前沉淀还是显示「起草 run run 01M6… 已完成 完整日志」 更像任务，
   *   不像是对话方式" ⇒ 抬头改成**它自己在说话**：正在写 / 写好了 / 没写成。
   *   三条旧词条一起删（i18n 死词条检测会报，留着就是给下一个人一个假线索）。
   */
  /**
   * 气泡上方那行小字里的"谁在说"（与聊天页 `chat.you` 同一位置）。
   *
   * ⚠️ 为什么不取 agent 的名字：起草者是平台内置、**只读**的那一条（分批第 190 批），
   *    名字恒为「起草者（内置）」，为它多拉一次 `/api/runs/:id` 只为读一个名字不划算；
   *    而这里需要的是**角色**（谁在说），与聊天页那个"你"是同一层的信息。
   */
  'crystallize.speakerDrafter': { zh: '起草者', en: 'Drafter' },
  /** 人说的话（与聊天页的 `chat.you` 同一个意思、同一个位置）。 */
  'crystallize.speakerYou': { zh: '你', en: 'You' },
  /**
   * ★ 分批第 194 批：对话里**你那一轮**说的话。
   *
   * 起草一开始，目标屏那串问答就整块消失（`CrystallizeIntake` 只在目标态挂着）⇒ 中间栏
   * 只剩"起草 run 01M6…"，读起来像任务建完就没有前因后果。这条把"你让它做什么"补回来。
   */
  'crystallize.requestNew': { zh: '新建一份技能', en: 'New skill' },
  'crystallize.requestUpdate': { zh: '优化「{skill}」', en: 'Improve "{skill}"' },
  'crystallize.requestWithMaterials': {
    zh: '{head}（附 {n} 份材料）',
    en: '{head} (with {n} material items)',
  },
  'crystallize.draftTurnLive': { zh: '正在把素材写成 skill', en: 'Writing the skill' },
  'crystallize.draftProcessShow': { zh: '它怎么做的', en: 'How it got there' },
  'crystallize.draftProcessHide': { zh: '收起过程', en: 'Hide the process' },
  'crystallize.draftFailed': { zh: '这次没写成', en: 'It did not finish' },
  'crystallize.draftStopped': { zh: '已停止', en: 'Stopped' },
  'crystallize.retryDraft': { zh: '重新起草', en: 'Draft again' },

  // ── 草稿审阅 ──
  // ★ 分批第 194 批：`crystallize.reviewTitle`（「审阅草稿」）删了——它只挂在"起草者拒绝"
  //   那块抽屉分节的抬头（`<h3>`）上，而那块已经改成一条消息（气泡）。
  'crystallize.slugLabel': { zh: 'slug', en: 'slug' },
  /**
   * ★ 分批第 196 批：「确认入库」的确认框（使用者："中栏的「slug」也不应该显示，
   * 如果要，可以放在「确认入库」后弹出的对话框中"）。
   */
  'crystallize.commitTitle': { zh: '确认入库？', en: 'Save this skill?' },
  'crystallize.commitSlugHint': {
    zh: '它的唯一标识（kebab-case）。同名会问到「是不是要更新那一条」。',
    en: 'Its unique id (kebab-case). A clash asks whether to update the existing one.',
  },
  'crystallize.commitFromFrontmatter': { zh: '来自 SKILL.md 的 frontmatter（只读）', en: 'From the SKILL.md frontmatter (read-only)' },
  'crystallize.commitFrontmatterHint': {
    zh: 'name / description 由草稿的 frontmatter 决定——要改就改右栏那份文件。',
    en: 'name / description come from the draft frontmatter — edit the file in the right pane to change them.',
  },
  'crystallize.commitSummary': {
    zh: '入库会整目录替换：{n} 个文件、约 {kb} KB。',
    en: 'Saving replaces the whole directory: {n} files, about {kb} KB.',
  },
  // ⚠️ 2026-10-21 删掉 `crystallize.previewTitle`：使用者说"不需要「预览」"，
  //    那一段折叠预览连同它的 key 一起删了（留着 key 就是给下一个人一个假线索）。
  // ── 四轮：产出是文件集合（文件树 / 变更集 / 校验 / 兜底形态）──
  'crystallize.changeAdded': { zh: '新增', en: 'added' },
  'crystallize.changeModified': { zh: '修改', en: 'modified' },
  'crystallize.changeDeleted': { zh: '删除', en: 'deleted' },
  'crystallize.noFiles': { zh: '没有产出任何文件', en: 'No files were produced' },
  'crystallize.deletedHint': {
    zh: '这个文件在草稿里没有，入库时会被删掉（更新 = 整目录替换）',
    en: 'This file is missing from the draft and will be deleted on save (update replaces the whole directory)',
  },
  'crystallize.refusedTitle': { zh: '起草者判定：这里没有可沉淀的内容', en: 'The drafter found nothing crystallizable' },
  /**
   * ★ 分批第 195 批：拒绝那一轮的 `who` 行（说的人 + 这一轮的结果）。
   *
   * 它原来套的是「写好了」——而它其实**没写 skill**（写的是 REFUSED.md）。这两句话
   * 在同一屏里是打架的，所以拒绝单独一句。
   */
  'crystallize.refusedHead': { zh: '这次没有可沉淀的', en: 'nothing crystallizable here' },
  /**
   * ★ 分批第 195 批：拒绝时的右栏。它**不列体检问题**——`validation.problems` 里那一条
   * 就是拒绝理由本身，印出来等于把中间那条消息再说一遍。
   */
  'crystallize.artifactRefusedNote': {
    zh: '没有产出可体检：起草者判定这次没有可沉淀的内容（理由在左边那条消息里）',
    en: 'Nothing to check: the drafter found nothing crystallizable here (see the message on the left)',
  },
  // ── 四轮 P1：变更集 diff / 素材分节 / 按意见改一版 ──
  'crystallize.tabContent': { zh: '内容', en: 'Content' },
  'crystallize.tabDiff': { zh: '差异', en: 'Diff' },
  'crystallize.diffVsCurrent': { zh: '对比当前版本', en: 'vs current' },
  'crystallize.diffVsPrevious': { zh: '对比上一版草稿', en: 'vs previous draft' },
  // ★ 分批第 18 批：第三条基线——"原 skill 的变化"（使用者定稿：「skill 差异对比也应该是原 skill 变化」）。
  //   ⚠️ 分批第 196 批：那三条**简称**（`vsOriginalShort` 等）随结论条一起删了——那一行没了，
  //   差异说明现在只出现在「差异」页签里，用全称。
  /**
   * ★ 分批第 196 批：**整条链的差异合计**（原来在中栏结论条上，使用者说那一行没必要）。
   * 它跟着"看差异"这件事走——在「差异」页签的表头里，测 `data-diff-total`。
   */
  'crystallize.diffTotal': { zh: '共 +{added} −{removed}', en: '+{added} −{removed} total' },
  'crystallize.diffVsOriginal': { zh: '对比原 skill', en: 'vs original skill' },
  'crystallize.diffLoading': { zh: '正在算差异…', en: 'Computing diff…' },
  'crystallize.diffUnchanged': { zh: '这个文件相对基线没有变化。', en: 'No change against the baseline.' },
  'crystallize.materialTitle': { zh: '素材', en: 'Material' },
  'crystallize.materialEmpty': { zh: '没有素材文件', en: 'No material files' },
  'crystallize.materialTruncated': { zh: '（过长，已截断）', en: '(truncated)' },
  // 列表行上的"第几版"（分批第 17 批）：一行是一个**任务**，版本数是它的属性。
  // 不带 markdown 记号（界面文案守卫）。
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
    zh: '该任务没有反馈、也未审核，无法据此沉淀技能',
    en: 'No feedback or review on this task — nothing to crystallize a skill from',
  },
  'crystallize.optimize': { zh: '沉淀技能', en: 'Crystallize' },
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
  'crystallize.materialDelete': { zh: '删掉', en: 'Delete' },
  'crystallize.materialDeleteConfirm': { zh: '确认删掉', en: 'Confirm' },
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
  // ★ 分批第 201 批：「从仓库拉」那四条词条删了——功能下线（使用者："直接删掉这个功能"）。
  'crystallize.diffBackToContent': { zh: '返回内容', en: 'Back to content' },
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

  /**
   * ── 消息流外壳的栏脚 ──
   *
   * ★ 分批第 196 批：占位文案原来写着「（下一批接上）」——那批早接上了（回答提问 / 「这里不对：…」
   * 改一版 / 「追加材料：…」），一直挂着这句就是**界面上的一句假话**。现在直接说清能干什么。
   */
  'crystallize.chatPlaceholder': {
    zh: '说一句话：答它的问题 /「这里不对：…」/「追加材料：…」',
    en: 'Say something: answer it / "not quite: …" / "add material: …"',
  },

  'crystallize.chatSend': { zh: '发送', en: 'Send' },
  /**
   * ★ 分批第 197 批：栏脚换成与聊天页**同一个控件**（`ChatComposer`），所以它也要有
   * "Enter 发送"那行提示与"不能发"的悬停说明——两页一致，别一处有一处没有。
   */
  'crystallize.chatHint': { zh: 'Enter 发送 · Shift+Enter 换行', en: 'Enter to send · Shift+Enter for a new line' },
  'crystallize.chatSendNotReady': { zh: '先写一句话', en: 'Type something first' },

  // ── 错误 ──
  'crystallize.errTargets': { zh: '读取沉淀信息失败：{error}', en: 'Failed to load crystallize info: {error}' },
  'crystallize.errDraftRejected': { zh: '起草未受理：{error}', en: 'Draft not accepted: {error}' },
  'crystallize.errSave': { zh: '入库失败：{error}', en: 'Save failed: {error}' },
} satisfies TextCatalog
