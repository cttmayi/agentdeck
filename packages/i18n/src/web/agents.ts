import type { TextCatalog } from '../text.ts'

/**
 * 智能体区域（`views/Agents.svelte`、`components/AgentDetail.svelte`、
 * `components/NewAgentForm.svelte`、`components/ReviewStandardEditor.svelte`）。
 *
 * ⚠️ zh 的值**必须与迁移之前逐字一致**：中文是这个项目的默认语言，也是所有既有
 *    测试、布局探针与文档断言的依据——改一个字就会有东西变红。
 *
 * ⚠️ 有些提示被拆成 `*Before` / `*Strong` / `*After` 这样的碎片：原文里夹着
 *    `<strong>` / `<code>` 这类**元素**，词条只能存纯文本，元素留在标记里。
 *    碎片要按 zh 的原样拼回去（`en` 侧缺的空格自己补），拼出来的句子才通。
 */
export const agentsText = {
  // ── 两个以上文件共用的角色词 ──
  'agents.roleExecutor': { zh: '执行', en: 'Execute' },
  'agents.roleReviewer': { zh: '审核', en: 'Review' },
  'agents.roleExecutorHint': { zh: '接到任务后动手干活', en: 'Takes on tasks and does the work' },
  'agents.roleReviewerHint': {
    zh: '按标准审别人的产出，给判决',
    en: 'Reviews others’ output against a standard and gives a verdict',
  },
  'agents.roleReviewerHintShort': {
    zh: '按标准审别人的产出',
    en: 'Reviews others’ output against a standard',
  },
  'agents.roleLabel': { zh: '角色', en: 'Role' },
  'agents.nameLabel': { zh: '名称', en: 'Name' },
  'agents.instructionsLabel': { zh: '指令', en: 'Instructions' },
  'agents.reviewerFieldLabel': { zh: '由谁来审它', en: 'Who reviews it' },
  'agents.noAutoReview': { zh: '不自动审核', en: 'No automatic review' },
  'agents.standardLabel': { zh: '审核标准', en: 'Review standard' },
  'agents.attachedSkillsLabel': { zh: '挂载的 skill', en: 'Attached skills' },
  'agents.workDirLabel': { zh: '默认工作目录', en: 'Default work directory' },
  'agents.workDirPlaceholder': { zh: '留空 = 每个任务自动分配', en: 'Empty = one directory per task' },
  'agents.runtimeCurrent': { zh: '{key}（当前）', en: '{key} (current)' },
  /** 单独的冒号（`证据等级` / `版本判定` 那些行里，冒号在 `<strong>` **外面**）。 */
  'agents.colon': { zh: '：', en: ': ' },

  // ── Agents.svelte：清单 ──
  'agents.viewTitle': { zh: '智能体', en: 'Agents' },
  'agents.listHintBefore': {
    zh: '每个 agent 独立配置指令、技能子集与角色：',
    en: 'Each agent configures its own instructions, skill subset and role: ',
  },
  'agents.listHintExecutor': { zh: '执行者', en: 'executors' },
  'agents.listHintMid': { zh: '接到任务动手干活，', en: ' take on tasks and do the work, while ' },
  'agents.listHintReviewer': { zh: '审核者', en: 'reviewers' },
  'agents.listHintAfter': {
    zh: '按挂着的 skill 给判决——所以换一个审核 agent 就等于换一套审核标准。',
    en: ' give verdicts against the skills they carry — so swapping the reviewer agent means swapping the whole standard.',
  },
  'agents.newButton': { zh: '新建', en: 'New' },
  'agents.settingsButton': { zh: '设置', en: 'Settings' },
  'agents.settingsTitle': {
    zh: '平台的设置：第一句话模版等——改一次，对所有智能体生效',
    en: 'Platform settings: the first-message template and more — change once, applies to every agent',
  },
  'agents.envIssuesTitle': { zh: '环境问题', en: 'Environment issues' },
  'agents.emptyTitle': { zh: '还没有智能体', en: 'No agents yet' },
  'agents.emptyHint': {
    zh: '先建一个执行者，再建一个审核者并给它挂上 skill——别忘了在执行者的「由谁来审它」里选它，否则产出不会被自动审核。',
    en: 'Create an executor first, then a reviewer with a skill attached — and remember to pick it under “Who reviews it” on the executor, or its output will not be reviewed automatically.',
  },
  'agents.reviewsOthers': { zh: '它审别人', en: 'Reviews others' },
  'agents.reviewerMissing': { zh: '（已不存在）', en: '(no longer exists)' },
  'agents.skillMissing': { zh: '未挂 skill', en: 'No skill attached' },
  'agents.defaultBadge': { zh: '默认', en: 'Default' },
  'agents.noInstructions': { zh: '（没有指令）', en: '(No instructions)' },
  'agents.skillCount': { zh: ' · {count} 个 skill · ', en: ' · {count} skill(s) · ' },
  'agents.setDefaultTitle': {
    zh: '设为默认：新建任务默认交给它（原来那个会自动换成它）',
    en: 'Make default: new tasks go to it by default (the previous one switches over)',
  },
  'agents.setDefault': { zh: '设为默认', en: 'Make default' },
  'agents.pickOneTitle': { zh: '从左边选一个智能体', en: 'Pick an agent on the left' },
  'agents.pickOneHint': {
    zh: '点左边的条目看它的指令、挂的技能，以及它用哪个 CLI 跑。',
    en: 'Click a row on the left to see its instructions, the skills attached, and which CLI it runs on.',
  },

  // ── Agents.svelte：Runtime 概览 ──
  'agents.runtimeLocal': { zh: 'Runtime（本机）', en: 'Runtime (this machine)' },
  'agents.evidenceStrong': { zh: '证据等级', en: 'Evidence level' },
  'agents.evidenceAfter': {
    zh: ' 表示该 CLI 的字段名',
    en: ' means the CLI’s field names have ',
  },
  'agents.evidenceUnverified': {
    zh: '没有对照过真实程序',
    en: 'not been checked against the real program',
  },
  'agents.evidenceMid': {
    zh: '，是按公开形状推导的——它和 ',
    en: ', they are derived from the public shape — its trustworthiness differs from ',
  },
  'agents.evidenceTail': { zh: ' 的可信度不同。', en: '.' },
  'agents.versionStrong': { zh: '版本判定', en: 'Version support' },
  'agents.versionAfter': { zh: ' 表示我们', en: ' means we have ' },
  'agents.versionUntested': { zh: '没有实测过', en: 'not tested' },
  'agents.versionMid': { zh: '任何版本；', en: ' any version; ' },
  'agents.versionTail': {
    zh: '按 FR-CLI-07，凭文档推断的范围不算声明，所以这里如实报成"未声明"。',
    en: 'per FR-CLI-07 a range inferred from documentation is not a declaration, so it is reported here as “undeclared”.',
  },
  'agents.runtimeReady': { zh: '已就绪', en: 'Ready' },
  'agents.runtimeNotFound': { zh: '未找到', en: 'Not found' },
  'agents.runtimeEvidence': { zh: '证据：{value}', en: 'Evidence: {value}' },
  'agents.runtimeSession': { zh: '会话：{state}', en: 'Session: {state}' },
  'agents.versionSupportLabel': { zh: '版本判定：', en: 'Version support: ' },
  'agents.supportVerified': { zh: '实测过', en: 'Tested' },
  'agents.supportInRange': { zh: '在范围内但未实测', en: 'In range, untested' },
  'agents.supportOutOfRange': { zh: '超出范围', en: 'Out of range' },
  'agents.supportUndeclared': { zh: '未声明', en: 'Undeclared' },
  'agents.supportUnknown': { zh: '无法判断', en: 'Unknown' },
  'agents.versionVerifyHint': {
    zh: '要让版本判定变成"实测过"：',
    en: 'To make version support “tested”: ',
  },

  // ── NewAgentForm.svelte ──
  'agents.newTitle': { zh: '新建智能体', en: 'New agent' },
  'agents.newSubtitle': {
    zh: '建好之后它就会按「设置」里那份第一句话模版接活；这一段会作为 {{instructions}} 插进模版。',
    en: 'Once created it takes work through the first-message template under “Settings”; this section is inserted into the template as {{instructions}}.',
  },
  'agents.namePlaceholder': { zh: '例如：安全审核员', en: 'e.g. Security reviewer' },
  'agents.roleFieldLabel': { zh: '它是做什么的', en: 'What it does' },
  'agents.noReviewerOption': {
    zh: '（还没有审核角色的智能体）',
    en: '(No agent with the reviewer role yet)',
  },
  'agents.noReviewerHint': {
    zh: '先去建一个「审核」角色的智能体。没有审核者时，执行产出不会被自动审核。',
    en: 'Create an agent with the “Review” role first. Without a reviewer, executor output is not reviewed automatically.',
  },
  'agents.reviewerHint': {
    zh: '执行完由它审。选「不自动审核」也是一个明确的选择——不配时每个任务都多跑一次审核会既费钱又吵。',
    en: 'It reviews what this agent produces. Choosing “No automatic review” is also a clear decision — without one, every task runs one extra review, which costs money and makes noise.',
  },
  'agents.instructionsPlaceholderExecutor': {
    zh: '它是谁、怎么干活。这段会进它的上下文。',
    en: 'Who it is and how it works. This goes into its context.',
  },
  'agents.instructionsPlaceholderReviewer': {
    zh: '它按什么态度审：严格还是宽松、拿不准时怎么办',
    en: 'How strict it reviews: strict or lenient, and what to do when unsure',
  },
  'agents.instructionsHintBefore': {
    zh: '这一段会填进第一句话模版的 ',
    en: 'This section goes into the first-message template as ',
  },
  'agents.instructionsHintAfter': {
    zh: '。留空也行——那就只有任务本身。',
    en: '. Leaving it empty is fine — then it only gets the task itself.',
  },
  'agents.noSkillsOption': { zh: '（还没有 skill）', en: '(No skills yet)' },
  'agents.reviewerSkillsHintBefore': {
    zh: '审核者的判断依据是上面那条',
    en: 'What a reviewer judges by is the ',
  },
  'agents.reviewerSkillsHintAfter': {
    zh: '，skill 对它只是可选的参考/支持文件（挂上就会随审核一起送过去）。',
    en: ', while skills are only optional reference/support files for it (attached ones are sent along with the review).',
  },
  'agents.executorSkillsHint': {
    zh: '执行者可以不挂 skill（它的产出由审核者按标准来判）。',
    en: 'An executor can go without skills (its output is judged by the reviewer against the standard).',
  },
  'agents.runtimeFieldLabel': { zh: '用哪个 runtime', en: 'Which runtime' },
  'agents.runtimeUnverified': {
    zh: '（未对照真实程序）',
    en: ' (not checked against the real program)',
  },
  'agents.workDirLabelOptional': {
    zh: '默认工作目录（可选）',
    en: 'Default work directory (optional)',
  },
  'agents.created': { zh: '智能体已创建', en: 'Agent created' },

  // ── ReviewStandardEditor.svelte ──
  'agents.standardWritten': { zh: '已写', en: 'Written' },
  'agents.standardNone': { zh: '没有标准', en: 'No standard' },
  'agents.standardHintBefore': { zh: '它按这份标准判断产出。', en: 'It judges output by this standard. ' },
  'agents.standardHintStrong': {
    zh: '没有标准的审核者拿不到审核任务',
    en: 'A reviewer without a standard gets no review tasks',
  },
  'agents.standardHintAfter': {
    zh: '——没有标准的审核不算审核。与上面的「指令」是两件事：指令管它的态度，标准管它按什么判。',
    en: ' — a review without a standard is not a review. It is a different thing from the “Instructions” above: instructions set the attitude, the standard sets what it judges by.',
  },
  'agents.standardNameLabel': { zh: '标准的名字', en: 'Standard name' },
  'agents.standardBodyLabel': { zh: '标准正文', en: 'Standard body' },
  'agents.standardBodyPlaceholder': {
    zh: '例如：\n1. 能明确判断时给出 pass 或 fail，并把证据指回原文。\n2. 依据不足时给出 needs_human，写清楚缺什么。\n3. 不要引入这份标准之外的要求。',
    en: 'For example:\n1. When it can decide clearly, give pass or fail and point the evidence back to the source.\n2. When there is not enough evidence, give needs_human and say what is missing.\n3. Do not introduce requirements beyond this standard.',
  },

  // ── 行动权限（D40 收口：从「审核标准」里搬出来的独立一段）──
  //
  // 用它的地方：`AgentDetail.svelte` 的「行动权限」段（只读态与编辑态）、
  // `ActionPermissions.svelte`（勾选栏，详情编辑态与新建表单共用）。已装工具的
  // 那一半词条在 `tools.ts`（`tools.stdTools*`）——那一块的区域前缀没跟着改，
  // 理由写在那边。
  'agents.sectionActions': {
    zh: '行动权限：判完之后允许做什么',
    en: 'Action permissions: what it may do after a verdict',
  },
  'agents.actionsLabel': { zh: '允许触发的动作', en: 'Actions it may trigger' },
  /**
   * ★ 空态（D41）：**一个工具包都没装** ⇒ 这一栏没有任何可授权的动作。
   *
   * ⚠️ 这两句与「工具」页的 `tools.*` 是**两件事**：那一边说"工具是什么"，
   *    这一边说"所以现在没有动作可授权、下一步去哪"。界面上的出现位置有两处
   *    ——`ActionPermissions.svelte`（编辑态那一栏）与 `AgentDetail.svelte`
   *    （只读态的「行动权限」那一行），两边**必须同一句话**，所以只有这一条词条。
   *
   * 碎片切成两段 + 一个按钮词条：中间那个「去「工具」页」是一个**可点的去处**
   * （不是一句文案），元素留在标记里。
   */
  'agents.actionsNoToolsStrong': { zh: '还没有装任何工具包。', en: 'No tool packages installed yet.' },
  'agents.actionsNoToolsHint': {
    zh: '动作只能来自装进来的工具包，所以现在没有任何动作可授权。',
    en: 'Actions can only come from installed tool packages, so there is nothing to authorize yet.',
  },
  /**
   * ⚠️ 这一组说的是"**配过、但现在解析不出来**"的动作（D41）。
   *    老数据里存着平台当年那六个内置动作名（已经删了），或者那个包被卸载了——
   *    它们不在勾选框里，所以必须显式列出来并给一个移除入口，否则使用者
   *    既看不见、也没法取消，一保存就被服务端拒。
   */
  'agents.actionsUnresolvedHeading': {
    zh: '配过、但现在解析不出来（保存前先处理）',
    en: 'Configured but no longer resolvable (deal with these before saving)',
  },
  'agents.actionsUnresolvedDrop': { zh: '移除', en: 'Remove' },
  /**
   * 只读态那一条 chip 旁边的标记。
   *
   * ★ 契约值**照原样留着**（"配过"这件事不能抹掉），但旁边必须看得出来它
   *   **现在不能用**——否则界面上那条权限与一条真的能触发的动作长得一模一样。
   *   解释那一句用下面的 `actionsUnresolvedHint`（同一个状态，同一句话）。
   */
  'agents.actionsUnresolvedChip': { zh: '当前不可用', en: 'Currently unavailable' },
  /**
   * 为什么"当前不可用"。
   *
   * ⚠️ 必须同时说出两个成因，缺一个就会有一种使用者看不懂自己的处境：
   *    ① **旧的内置动作名**（`comment.create` 这类）——平台把它们整组移除了，
   *       它们再也不是动作，**也永远装不回来**（没有哪个包会提供它）；
   *    ② **提供它的包被卸载了**——这种是能救的：把包装回来就行。
   *    只写①的话，被卸载那种情况的使用者不知道可以装包；只写②的话，
   *    带着旧内置名字的使用者会去「工具」页找一个根本不存在的包。
   *
   * ⚠️ 这一步只说**为什么**，"下一步"分给下面两条按**出现位置**写的词条：
   *    编辑态那一栏里有「移除」按钮，只读态那一行里**没有**——用同一句话会让
   *    只读态的使用者去找一个不在那儿的按钮（那正是"界面坏了"的来源）。
   */
  'agents.actionsUnresolvedHint': {
    zh: '这些动作现在找不到出处：平台的内置动作已经整组移除（comment.create 这类旧名字再也不是动作），或者提供它的工具包被卸载了。带着它们保存会被服务端拒绝。',
    en: 'These actions have no source right now: the platform’s built-in actions have been removed entirely (old names such as comment.create are no longer actions), or the tool package providing them was uninstalled. Saving while they are still listed is refused by the server.',
  },
  /** 下一步（编辑态：那一栏里真的有「移除」按钮）。 */
  'agents.actionsUnresolvedFixInEdit': {
    zh: '点每一行右边的「移除」就能把它们去掉；如果只是那个包被卸载了，也可以先去「工具」页把包装回来。',
    en: 'Click “Remove” on a row to drop it; if the package was merely uninstalled, you can also reinstall it from the Tools page first.',
  },
  /** 下一步（只读态：先点「编辑」才有那些按钮）。 */
  'agents.actionsUnresolvedFixReadOnly': {
    zh: '点「编辑」之后可以逐条把它们移除；如果只是那个包被卸载了，也可以先去「工具」页把包装回来。',
    en: 'Click “Edit” to remove them one by one; if the package was merely uninstalled, you can also reinstall it from the Tools page first.',
  },
  'agents.actionsGoTools': { zh: '去「工具」页装一个', en: 'Install one on the Tools page' },
  'agents.actionsHintBefore': {
    zh: '判决里出现的动作必须在这里面：',
    en: 'Actions that appear in a verdict must be among these: ',
  },
  'agents.actionsHintStrong': {
    zh: '一个都不勾 = 只报告、不动作',
    en: 'None ticked = report only, no action',
  },
  'agents.actionsHintAfter': {
    zh: '。动作是判完之后由平台执行的——审核者自己只判断。',
    en: '. The platform performs these actions after a verdict — the reviewer itself only judges.',
  },
  'agents.actionsLegacyNote': {
    zh: '这些动作来自老配置（写在审核标准里的那一份）。保存时会写到行动权限上，之后它就不再依赖标准了。',
    en: 'These actions come from the legacy setup (the copy stored in the review standard). Saving writes them to the action permissions, after which they no longer depend on the standard.',
  },
  /**
   * ★ 上面那条的**有不可用动作那一版**（D41 收尾）。
   *
   * ⚠️ 两句话必须分开：上面那条保证"保存时会写到行动权限上"，而名单里只要有一个
   *    **解析不出来**的动作（老的内置动作名、或者那个包被卸载了），这句保证就是
   *    **假的**——服务端会在保存那一刻拒掉整份名单。不说清的话，使用者照着那句
   *    保证去按保存，撞上的是一句他没法理解的拒绝。
   */
  'agents.actionsLegacyNoteUnresolved': {
    zh: '这些动作来自老配置（写在审核标准里的那一份）：其中找不到出处的那些要先移除，否则保存会被服务端拒；其余的保存时会写到行动权限上，之后就不再依赖标准了。',
    en: 'These actions come from the legacy setup (the copy stored in the review standard): remove the ones that no longer have a source first, otherwise the server refuses the save; the rest are written to the action permissions, after which they no longer depend on the standard.',
  },

  // ── AgentDetail.svelte ──
  'agents.backToList': { zh: '← 智能体列表', en: '← Agents' },
  'agents.saveWithCount': { zh: '保存 {count} 处改动', en: 'Save {count} change(s)' },
  'agents.saved': { zh: '已保存', en: 'Saved' },
  'agents.sectionBehavior': { zh: '它怎么干活', en: 'How it works' },
  /** 与新建表单那句只有一字之差（「这段」vs「这一段会」），所以各写各的键。 */
  'agents.detailInstructionsHintBefore': {
    zh: '这段填进第一句话模版的 ',
    en: 'This goes into the first-message template as ',
  },
  'agents.detailInstructionsHintAfter': { zh: '。', en: '.' },
  'agents.noInstructionsHint': {
    zh: '没有写指令 —— 它只会拿到任务的标题与说明。',
    en: 'No instructions written — it only gets the task title and description.',
  },
  'agents.sectionStandard': { zh: '用什么标准', en: 'Which standard' },
  'agents.legacySkillBefore': {
    zh: '当前它仍然沿用挂载的 skill「',
    en: 'It still uses the attached skill “',
  },
  'agents.legacySkillAfter': {
    zh: '」当标准（老配置）。用上面那一栏写上自己的标准即可取而代之。',
    en: '” as its standard (legacy setup). Write its own standard in the field above to replace it.',
  },
  /**
   * ⚠️ 这条提示同时要说明**动作权限**的出处（D40 收口）：
   *    老数据里动作也写在 skill 上，所以那种 agent 的「行动权限」是空的、
   *    而它实际能动的动作仍然来自 skill。不说清的话，使用者会看到
   *    "行动权限一个都没勾"却能触发动作，进而以为界面坏了。
   */
  'agents.legacySkillActionsBefore': {
    zh: '它现在能触发的动作也来自这些 skill（老配置）——勾选上面那一段「行动权限」即可取而代之：',
    en: 'The actions it may trigger also come from those skills (legacy setup) — ticking them under “Action permissions” above replaces that:',
  },
  'agents.notApplicableExecutor': {
    zh: '不适用 —— 执行者不审别人的产出。',
    en: 'Not applicable — an executor does not review others’ output.',
  },
  'agents.noSkillsYet': { zh: '还没有任何 skill。', en: 'No skills yet.' },
  /** 行动权限为空时的说明（在「行动权限」那一段里，与标准无关）。 */
  'agents.noActionsStrong': { zh: '一个都没有', en: 'None at all' },
  'agents.noActionsHint': { zh: '（只报告、不动作）', en: ' (report only, no action)' },
  /**
   * 顿号：一串 skill slug 之间的列表分隔符（老数据那两句提示里用）。
   *
   * ⚠️ 原来这条还管"动作名之间的顿号"，那一列随《动作权限》收口与内置动作的
   *    移除一起没有了——现在这里只服务 skill slug。
   */
  'agents.listSeparator': { zh: '、', en: ', ' },
  'agents.standardBodySummary': { zh: '看标准正文', en: 'Show the standard body' },
  'agents.legacyInlineBefore': {
    zh: '它还没有内联的审核标准，当前',
    en: 'It has no inline standard yet and currently uses ',
  },
  'agents.legacyInlineStrong': { zh: '沿用挂载的 skill', en: 'the attached skills' },
  'agents.legacyInlineAfter': { zh: '当标准：', en: ' as its standard: ' },
  /** 上面那句末尾的句号（它排在 `{#each}` 后面，是一个独立的文本节点）。 */
  'agents.legacyInlineEnd': { zh: '。', en: '.' },
  'agents.standardAdopted': {
    zh: '标准已固化到它自己身上；挂载已摘掉，那条 skill 现在可以卸载了',
    en: 'The standard is now stored on the agent itself; the attachment is removed and that skill can be uninstalled',
  },
  'agents.adopting': { zh: '固化中…', en: 'Adopting…' },
  'agents.adoptStandard': {
    zh: '把挂载的 skill 转成内联标准',
    en: 'Turn the attached skill into an inline standard',
  },
  'agents.adoptHintBefore': { zh: '转换是', en: 'The conversion is ' },
  'agents.adoptHintStrong': { zh: '原样', en: 'verbatim' },
  'agents.adoptHintAfter': {
    zh: '的（正文与允许的动作都不变），之后它不依赖 skill也能审；那条 skill 也就能卸载了。',
    en: ' (body and allowed actions unchanged); afterwards it can review without depending on the skill, and that skill can be uninstalled.',
  },
  'agents.noStandardBefore': { zh: '没有审核标准 —— ', en: 'No review standard — ' },
  'agents.noStandardStrong': { zh: '它拿不到审核任务', en: 'it gets no review tasks' },
  'agents.noStandardAfter': { zh: '。点「编辑」写一条。', en: '. Click “Edit” to write one.' },
  'agents.reviewerNoSkills': {
    zh: '一个都没挂 —— 它审不了任何东西，审核标准就写在 skill 里。',
    en: 'None attached — it cannot review anything, since the standard lives in the skill.',
  },
  'agents.executorNoSkills': {
    zh: '没有挂（执行者可以不挂，产出由审核者按标准来判）。',
    en: 'None attached (an executor can go without; its output is judged by the reviewer against the standard).',
  },
  'agents.sectionRelations': { zh: '与其他智能体的关系', en: 'Relations to other agents' },
  'agents.reviewerHintDetail': {
    zh: '执行完由它审。选「不自动审核」也是明确的选择——每个任务都多跑一次审核会既费钱又吵。',
    en: 'It reviews what this agent produces. Choosing “No automatic review” is also a clear decision — every task would run one extra review, which costs money and makes noise.',
  },
  'agents.reviewerNotApplicableBefore': { zh: '不适用 —— 它是', en: 'Not applicable — it is ' },
  'agents.reviewerNotApplicableStrong': {
    zh: '审别人的那个',
    en: 'the one who reviews others',
  },
  'agents.reviewerNotApplicableAfter': {
    zh: '。反过来，在执行角色的智能体上指定它即可。',
    en: '. Instead, point an executor agent at it.',
  },
  'agents.reviewsWhoLabel': { zh: '谁由它来审', en: 'Who it reviews' },
  'agents.noExecutorsPointing': {
    zh: '暂时没有执行者指向它 —— 在某个执行角色的智能体上把「由谁来审它」设成它。',
    en: 'No executor points at it yet — set “Who reviews it” to it on an executor agent.',
  },
  'agents.reviewerChosenHint': {
    zh: '它执行完的产出会交给这个审核者。',
    en: 'What this agent produces is handed to this reviewer.',
  },
  'agents.reviewerGoneWithId': {
    zh: '指定的审核者已不存在（{id}）',
    en: 'The named reviewer no longer exists ({id})',
  },
  'agents.noReviewerChosen': {
    zh: '没有指定 —— 执行产出不会被自动审核。这是明确的选择，不是错误。',
    en: 'None set — executor output is not reviewed automatically. That is a clear decision, not a mistake.',
  },
  'agents.sectionRuntime': { zh: '运行环境', en: 'Runtime' },
  'agents.modelLabel': { zh: '模型', en: 'Model' },
  'agents.modelPlaceholder': { zh: '留空 = 用 CLI 默认', en: 'Empty = use the CLI default' },
  'agents.cliDefault': { zh: '用 CLI 默认', en: 'CLI default' },
  'agents.autoWorkDir': { zh: '每个任务自动分配', en: 'One per task' },
  'agents.workDirHint': {
    zh: '留空时每个任务得到自己的目录（重试还看得见上次的文件）。填了之后，这个目录同时只跑一个任务，其余排队。',
    en: 'When empty, every task gets its own directory (a retry still sees the previous files). When set, only one task runs in that directory at a time and the rest queue.',
  },
  'agents.evidenceNoteFallback': {
    zh: '未对照真实程序（字段名是按公开形状推导的）',
    en: 'Not checked against the real program (field names are derived from the public shape)',
  },
  'agents.headlineNoStandard': {
    zh: '它审不了任何东西：没有审核标准，平台不会把产出交给它审。点「编辑」写一条。',
    en: 'It cannot review anything: with no review standard the platform will not hand it output to review. Click “Edit” to write one.',
  },
  'agents.headlineNoReviewer': {
    zh: '执行产出不会被自动审核（没有指定审核者）。',
    en: 'Executor output is not reviewed automatically (no reviewer set).',
  },
} as const satisfies TextCatalog
