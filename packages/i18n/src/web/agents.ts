import type { TextCatalog } from '../text.ts'

/**
 * 智能体区域（`views/Agents.svelte`、`components/AgentDetail.svelte`、
 * `components/NewAgentForm.svelte`、`components/ActionPicker.svelte`）。
 *
 * ⚠️ zh 的值改之前先看一眼**有没有东西钉着它**：中文是默认语言，既有测试、布局
 *    探针与文档都引用它。⚠️ 但"与迁移之前逐字一致"**不再是判据**（2026-09 的文案
 *    改写把那批文字按"这句话是给谁看的"重写了一遍：去掉开发口径、机器取值与
 *    markdown 残留）。有引用就一起改，没有就按读者改。
 *
 * ⚠️ 有些提示被拆成 `*Before` / `*Strong` / `*After` 这样的碎片：原文里夹着
 *    `<strong>` / `<code>` 这类**元素**，词条只能存纯文本，元素留在标记里。
 *    碎片要按 zh 的原样拼回去（`en` 侧缺的空格自己补），拼出来的句子才通。
 */
export const agentsText = {
  // ── 两个以上文件共用的角色词 ──
  'agents.roleExecutor': { zh: '执行', en: 'Execute' },
  'agents.roleReviewer': { zh: '审核', en: 'Review' },
  // ★ 2026-10（D81/D82）：内置起草者与内置 skill 审核者也是角色，列表徽标要能说出它们是谁。
  //   ⚠️ 少了这两条，列表上它们会显示成「执行」——一个**永远不会接任务**的 agent
  //   被标成执行者，使用者会去问"它为什么不干活"。
  'agents.roleDrafter': { zh: '起草', en: 'Draft' },
  'agents.roleSkillReviewer': { zh: '审核沉淀', en: 'Audit drafts' },
  'agents.roleExecutorHint': { zh: '接到任务后动手干活', en: 'Takes on tasks and does the work' },
  'agents.roleReviewerHint': {
    zh: '按你给它写的判断依据审别人的产出，给判决',
    en: 'Reviews others’ output against a standard and gives a verdict',
  },
  'agents.roleReviewerHintShort': {
    zh: '按判断依据审别人的产出',
    en: 'Reviews others’ output against a standard',
  },
  'agents.roleLabel': { zh: '角色', en: 'Role' },
  'agents.nameLabel': { zh: '名称', en: 'Name' },
  'agents.instructionsLabel': { zh: '指令', en: 'Instructions' },
  // ⚠️ 2026-10（使用者的决定）：`reviewerFieldLabel`（由谁来审它）、
  // `noAutoReview`、`workDirLabel`（默认工作目录）、`workDirPlaceholder` 随设置
  // 一起删了——审核走智能体组；工作目录是任务级的。协议字段原样保留。
  'agents.attachedSkillsLabel': { zh: '挂载的技能', en: 'Attached skills' },
  'agents.runtimeCurrent': { zh: '{key}（当前）', en: '{key} (current)' },

  // ── Agents.svelte：清单 ──
  /**
   * ⚠️ 这里**原有一个 `agents.viewTitle`**（`智能体` / `Agents`），2026-09 改版时
   *    删了：页名由顶栏显示，而顶栏与侧栏共用同一个词条（`shell.navAgents`，见
   *    `apps/web/src/lib/view.ts` 的 `VIEW_TITLE_KEYS`）。它原来值的字面与
   *    `shell.navAgents` **一字不差**，是纯粹的第二个来源。
   */
  /**
   * ⚠️ 这里**原有 `agents.listHint*`**（"每个 agent 独立配置指令、技能子集与角色：
   *    **执行者**接到任务动手干活，**审核者**按它自己那份判断依据给判决——所以换
   *    一个审核 agent 就等于换一套判断依据。"），2026-09 按要求从**左栏栏头**去掉，
   *    内容**并进了右栏空态**（`agents.pickOneRole*`，见下面 `agents.pickOneHint`
   *    那一段）——它讲的是"选中之后你会看到什么"，搬去"什么都没选中"那一屏才贴题。
   *    原来的键名带 `listHint`（左栏清单上方那段提示），搬走之后名字会指错地方，
   *    所以一并改名为 `pickOneRole*`。
   */
  'agents.settingsButton': { zh: '设置', en: 'Settings' },
  'agents.settingsTitle': {
    zh: '平台的设置：第一句话模版等——改一次，对所有智能体生效',
    en: 'Platform settings: the first-message template and more — change once, applies to every agent',
  },
  'agents.envIssuesTitle': { zh: '环境问题', en: 'Environment issues' },
  'agents.emptyTitle': { zh: '还没有智能体', en: 'No agents yet' },
  'agents.emptyHint': {
    zh: '先建一个执行者，再建一个审核者并给它挂上技能。要执行产出被自动审核，把它们放进同一个智能体组——审核者由组决定（2026-10 起执行者不再单独配「由谁来审它」）。',
    en: 'Create an executor first, then a reviewer with a skill attached. To have executor output reviewed automatically, put both in the same agent group — the group decides the reviewer (since 2026-10 executors no longer pick one themselves).',
  },
  'agents.reviewsOthers': { zh: '它审别人', en: 'Reviews others' },
  'agents.defaultBadge': { zh: '默认', en: 'Default' },
  'agents.noInstructions': { zh: '（没有指令）', en: '(No instructions)' },
  'agents.skillCount': { zh: ' · {count} 个技能 · ', en: ' · {count} skill(s) · ' },
  'agents.setDefaultTitle': {
    zh: '设为默认：新建任务默认交给它（原来那个会自动换成它）',
    en: 'Make default: new tasks go to it by default (the previous one switches over)',
  },
  'agents.setDefault': { zh: '设为默认', en: 'Make default' },
  /**
   * 栏头带（D62）：与任务页列表模式同款的「计数 + 搜索」栏头——三页同一条
   * 栏头带，统一才看得见（D61 那版智能体没有栏头，肉眼上三页不像同一套）。
   * 计数数的是**当前显示**的条数（过滤之后），不是全部。
   */
  'agents.listCount': { zh: '共 {count} 个', en: '{count} agent(s)' },
  'agents.search': { zh: '搜索名称或指令…', en: 'Search name or instructions…' },
  'agents.emptyFiltered': { zh: '没有匹配的智能体', en: 'No matching agents' },
  'agents.emptyFilteredHint': {
    zh: '换个关键词，或清空搜索框。',
    en: 'Try another keyword, or clear the search box.',
  },
  'agents.pickOneTitle': { zh: '从左边选一个智能体', en: 'Pick an agent on the left' },
  'agents.pickOneHint': {
    zh: '点左边的条目看它的指令、挂的技能，以及它用哪个 CLI 跑。',
    en: 'Click a row on the left to see its instructions, the skills attached, and which CLI it runs on.',
  },
  /**
   * 空态第二段：**从取名那一刻起就在右栏空态里**（2026-09 从 `agents.listHint*`
   * 搬过来并改名）。`<strong>` 只给两个角色名——整段都在强调等于没强调。
   */
  'agents.pickOneRoleBefore': {
    zh: '每个智能体独立配置指令、技能子集与角色：',
    en: 'Each agent configures its own instructions, skill subset and role: ',
  },
  'agents.pickOneRoleExecutor': { zh: '执行者', en: 'executors' },
  'agents.pickOneRoleMid': { zh: '接到任务动手干活，', en: ' take on tasks and do the work, while ' },
  'agents.pickOneRoleReviewer': { zh: '审核者', en: 'reviewers' },
  'agents.pickOneRoleAfter': {
    zh: '按它自己那份判断依据给判决——所以换一个审核智能体就等于换一套判断依据。',
    en: ' give verdicts against their own judging criteria — so swapping the reviewer agent means swapping the whole set of criteria.',
  },

  /**
   * ── Agents.svelte：本机 CLI 概览 ──
   *
   * ⚠️ 这一段**只说人话**（2026-09 改写）。原来它把描述表的内部取值直接摆在界面上：
   *    `provisional` / `verified` / `undeclared` / `stateful`、需求编号 FR-CLI-07，
   *    以及一条只有开发者才会执行的 `pnpm run daemon --verify-runtime all`。
   *    那些词对读界面的人没有任何意义——"这句话是给谁看的"是界面文案唯一的判据。
   *    机器取值留给 `--verify-runtime` 那份输出（那份是给开发者的）。
   *
   * ★ 2026-10 再简化：卡片只显示「CLI 名 + 版本号」（如 `claude 2.0.14`），
   *   核对徽标、会话、版本支持判定全部去掉（使用者点名"其他都不需要"）。
   *   那些判定仍然活在 `--verify-runtime` 的输出里，一条没丢。
   */
  'agents.runtimeLocal': { zh: '本机 CLI', en: 'CLI on this machine' },
  'agents.runtimeIntro': {
    zh: '这台机器上装着的 CLI 与版本。',
    en: 'CLIs installed on this machine, with versions.',
  },
  'agents.runtimeReady': { zh: '已就绪', en: 'Ready' },
  'agents.runtimeNotFound': { zh: '未找到', en: 'Not found' },

  // ── NewAgentForm.svelte ──
  /**
   * ⚠️ 这里**原有一个 `agents.headIntro`**（`这里配置每个智能体：它的指令、行动权限，
   *    以及由谁来审它。` / `Each agent is configured here: …`）——2026-10（D63）按
   *    使用者要求整条删了：那句是在复述下面每一条卡片已经在说的话，而顶栏页名 +
   *    栏头带已经把"这一页是什么"说清了。删掉的时候连探针那条 `common.pageIntros`
   *    一起改（它原来钉着"智能体页必须有导语"，改成钉"没有"——见 probe.html）。
   *    技能页/工具页自己的导语（`skills.headIntro` / `tools.headIntro`）保留。
   */
  'agents.newTitle': { zh: '新建智能体', en: 'New agent' },
  /** 提交按钮置灰时的 `title`。 */
  'agents.namePlaceholder': { zh: '例如：安全审核员', en: 'e.g. Security reviewer' },
  'agents.roleFieldLabel': { zh: '它是做什么的', en: 'What it does' },
  'agents.instructionsPlaceholderExecutor': {
    zh: '它是谁、怎么干活。这段会进它的上下文。',
    en: 'Who it is and how it works. This goes into its context.',
  },
  /**
   * ★ 2026-09 改写：这里原来写的是"严格还是宽松、拿不准时怎么办"——那是
   *    **鼓励**把"拿不准怎么办"（判决语义）写进判据。判决怎么选是平台统一
   *    说明的（判决契约 `{{verdict}}` 里就有"结论怎么选"），判据里写它只会
   *    重复、还会漂移。占位只引导"按什么标准判断"。
   */
  'agents.instructionsPlaceholderReviewer': {
    zh: '它按什么标准判断：好与坏怎么分、要看哪些点（判决怎么写由平台统一说明，不用写）',
    en: 'What criteria it judges by: how good and bad are told apart, which points to check (the platform explains how to write the verdict — no need to write it here)',
  },
  /**
   * ⚠️ 2026-09：这里原来写的是"这一段会填进第一句话模版的 `{{instructions}}`"。
   *    那个变量已经退役了——「指令」现在是**身份那一整块**，由平台放在固定
   *    位置**每轮都发**，模版里既没有它、写它也会被拒。提示必须跟着改，否则
   *    使用者会去模版里找一个已经不存在的变量。
   *
   * ⚠️ 2026-09 二次改写：上一版是"这一段就是投递时的 ② 身份——平台每一轮都发
   *    （不再由模版插值）"。`② 身份` 与"模版插值"是**我们自己拼装投递文本时的
   *    说法**，读界面的人既看不到 ② 也没写过模版。改成说清"它会跟着每一轮一起
   *    发出去、不用你另外去哪配"。
   */
  'agents.instructionsHintBefore': { zh: '这一段就是它的 ', en: 'This text is the agent’s ' },
  'agents.instructionsFieldStrong': { zh: '「指令」', en: 'instructions' },
  'agents.instructionsHintAfter': {
    zh: '：平台每派一次活都会带上它（不用你在别处再配一遍）。留空也行——那就只剩任务本身；但审核者留空就拿不到审核任务。',
    en: ': the platform sends it with every job (there is nowhere else to configure it). Leaving it empty is fine — then only the task itself is sent; but a reviewer left empty gets no review tasks.',
  },
  'agents.noSkillsOption': { zh: '（还没有技能）', en: '(No skills yet)' },
  'agents.reviewerSkillsHintBefore': {
    zh: '审核者的判断依据写在上面那条',
    en: 'What a reviewer judges by lives in the ',
  },
  'agents.reviewerSkillsHintAfter': {
    zh: '里，技能对它只是可选的参考/支持文件（挂上就会随审核一起送过去）。',
    en: ' field above, while skills are only optional reference/support files for it (attached ones are sent along with the review).',
  },
  'agents.executorSkillsHint': {
    zh: '执行者可以不挂技能（它的产出由审核者按自己的判断依据来判）。',
    en: 'An executor can go without skills (its output is judged by the reviewer against the reviewer’s own criteria).',
  },
  'agents.runtimeFieldLabel': { zh: '用哪个 CLI', en: 'Which CLI' },
  'agents.runtimeUnverified': {
    zh: '（没核对过）',
    en: ' (not checked)',
  },
  /** 详情页那一行的短标签（与上面的表单标签是同一个字段，两处都要短）。 */
  'agents.runtimeRowLabel': { zh: 'CLI', en: 'CLI' },
  'agents.created': { zh: '智能体已创建', en: 'Agent created' },

  /**
   * ⚠️ 这里原来有一组 `ReviewStandardEditor.svelte` 的词条（"已写 / 没有标准 /
   *    它按这份标准判断产出…"）。那个组件先是被删成一个只读提示、2026-09 又整段
   *    删掉（判断依据并进「指令」，使用者要求「移除审核智能体的『审核标准』」），
   *    所以这组词**一个字都不该再留着**——留着只会让下一个人以为还有一个标准框
   *    要找。
   */
  /**
   * 2026-09：「标准」并进「指令」，不再单独设置（使用者原话：「审核 Agent 的标准也
   * 放 ② 里面，不用单独设置」；后来又一句：「移除审核智能体的『审核标准』」）。
   *
   * ★ 两个地方用它的**两句话**（各自说各自那件事，不合并）：
   *   · **新建表单**用这一条：告诉使用者"没有标准框可填，依据写在上面那条里"；
   *   · **详情页（老数据）**用 `standardLegacyNotice` + `standardBodySummary` +
   *     `standardFoldInEditHint`：那份老的正文还带着，它会被一起投递，并给一键并进来。
   */
  'agents.standardMergedHint': {
    zh: '判断依据写在上面那条「指令」里——审核标准不再单独设置。',
    en: 'The judging criteria live in the Instructions field above — there is no separate review standard.',
  },
  /**
   * ⚠️ 这里原来是**一句**「还带着一份老的标准（或挂在 skill 上的正文）…」。
   *    两种情形的下一步不一样，所以拆成两条：
   *      · **内联老字段** ⇒ 编辑保存一次它就自动并进「指令」（`PATCH` 里做的），
   *        这句话要说的就是"你什么都不用做，保存一次就干净了"；
   *      · **正文来自挂载的 skill** ⇒ 并进来必须**摘挂载**（改个名字顺手摘掉别人
   *        的挂载是没同意的改动），所以那一种仍然要他自己点按钮。
   *    合成一句的代价是：那句话对着两种情形都只说对一半。
   */
  'agents.standardLegacyNoticeFromSkill': {
    zh: '⚠️ 它的判断依据还来自挂载的技能——并进「指令」会连挂载一起摘掉，所以那一步要你自己点（下面那颗按钮）。',
    en: '⚠️ Its judging criteria still come from an attached skill — folding them into Instructions also removes the attachment, so that step is yours to take (the button below).',
  },

  // ── 行动权限（2026-10 起**只属于智能体组**）──
  //
  // ⚠️ 用它的地方变了：以前是 `AgentDetail.svelte` 的「行动权限」段（勾选栏就在
  //    那儿）与 `NewAgentForm.svelte`，现在**只剩智能体组页**（`Groups.svelte` 的
  //    ③ 行动，勾选栏组件 `ActionPicker.svelte`）。智能体页那两处只留一句指路
  //    （`agents.actionsMovedToGroup`）——动作属于"这条链"，不属于某个人：同一个
  //    审核者在不同组里本来就该配不同的权限。
  //
  // 已装工具的那一半词条在 `tools.ts`（`tools.stdTools*`）——那一块的区域前缀
  // 没跟着改，理由写在那边。
  'agents.sectionActions': {
    zh: '行动权限：由智能体组决定',
    en: 'Action permissions: decided by the agent group',
  },
  /**
   * ★ 智能体页那句指路（2026-10）。
   *
   * 使用者在这里看到的应该只有一句话、**没有勾选框**：两处长得一模一样、只有一处
   * 生效，是最坏的一种界面——他会在智能体页勾一遍，然后在组里再勾一遍，而只有组
   * 那份起作用。所以这句话要说清两件事：① 谁决定（智能体组）；② 去哪儿改（组的
   * ③ 行动）。
   */
  'agents.actionsMovedToGroup': {
    zh: '动作属于这条链（这队人的活判过之后允许做什么），所以不在这里配：请到「智能体组」页，在组的 ③ 行动里勾。同一个人在不同组里可以有不同的权限——挂在人身上就只能共用一份。',
    en: 'Actions belong to the chain (what this crew may do after a verdict), so they are not configured here: open the Agents-group page and tick them under ③ Actions. The same person can have different permissions in different groups — tied to a person, they can only share one set.',
  },
  /**
   * 调试勾选（2026-09）：给这个动作勾上之后，判决引用它时**不跑脚本**，
   * 在任务时间线里显示成「调试 · 未执行」并列出解析后的完整参数——用来确认
   * "它到底会带着什么参数发出去"。是给调试看的，不是真的执行。
   */
  'agents.actionsDebug': { zh: '调试', en: 'Debug' },
  'agents.actionsDebugHint': {
    zh:
      '勾上后这个动作执行时不跑脚本，只记录动作与解析后的完整参数（平台绑定 + 模型填的 + 你固定的），' +
      '在任务时间线里显示成「调试 · 未执行」——用来确认"它到底会带着什么参数发出去"。',
    en:
      'When set, this action is not actually executed — the run records it as “debug · not executed” and ' +
      'shows its fully resolved parameters (bound by the platform + filled by the model + fixed by you), ' +
      'so you can check what would be sent.',
  },
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
  'agents.actionsGoTools': { zh: '去「工具」页装一个', en: 'Install one on the Tools page' },
  // ⚠️ 2026-10：这里原来有一对 `agents.actionsLegacyNote` /
  //    `agents.actionsLegacyNoteUnresolved`（"这些动作来自老配置（写在审核标准里的
  //    那一份）…保存时会写到行动权限上，之后它就不再依赖标准了"）。两条一起删了：
  //    它们说的是**行动权限从老标准迁移到 agent 上**这件事，而现在动作只属于组，
  //    那条迁移路连同字段一起撤掉了（老记录里那几个键由 daemon 启动时摘掉，
  //    见 `agent-legacy-cleanup.ts`）。留着这两条只会指向一个不存在的操作。

  // ── AgentDetail.svelte ──
  'agents.saved': { zh: '已保存', en: 'Saved' },
  // ★ 2026-11：编辑页底部新增「删除」（保存 / 删除 / 取消，与组页同款）。
  //   历史 run 不删（那是执行时的快照）；被智能体组引用 / 是默认智能体时，
  //   服务端会 400 并说明下一步，这里原样展示。
  // ★ 2026-10：内置智能体（沉淀的起草者）。它删不掉、挂不上 skill、只能「恢复成默认值」，
  //   所以这三条文案要**解释那个"缺失"**——不然使用者只会看到"这里没有删除按钮"。
  'agents.builtinBadge': {
    zh: '平台内置：删不掉，只能「恢复成默认值」（沉淀这条链的起草者）',
    en: 'Built in: cannot be deleted, only restored to default (the crystallize drafter)',
  },
  'agents.builtinNoSkills': {
    zh: '内置智能体不挂 skill（起草用的写作规范随平台走，与挂载无关）',
    en: 'Built-in agents mount no skills (the writing spec ships with the platform)',
  },
  'agents.restoreDefault': { zh: '恢复成默认值', en: 'Restore default' },
  'agents.restoreDefaultTitle': { zh: '恢复成默认值？', en: 'Restore default?' },
  'agents.restoreDefaultBody': {
    zh: '「{name}」的指令与名字会恢复成平台默认。你改过的内容会丢失——平台升级本来不会动它，这一步是你主动按的。',
    en: '"{name}" will go back to the platform default. Your edits are lost — upgrades never touch them, this is your own click.',
  },
  'agents.runtimeFollowDefault': { zh: '跟随全局默认', en: 'Follow global default' },
  'agents.deleteButton': { zh: '删除', en: 'Delete' },
  'agents.confirmDeleteTitle': { zh: '删除智能体', en: 'Delete agent' },
  'agents.confirmDeleteBody': {
    zh: '确定删除「{name}」？历史任务记录会保留（它们带的是执行时的快照），只是它不再出现在智能体列表里。',
    en: 'Delete "{name}"? Past task records keep their snapshot; it will just leave the agent list.',
  },
  'agents.confirmDelete': { zh: '删除', en: 'Delete' },
  // ⚠️ 2026-10：`sectionBehavior` / `sectionSkills` / `sectionRuntime` 三个小节
  //   标题随「详情改成一张卡片」一起删了——字段区现在是 `cell-label`（名字/CLI/
  //   指令/技能）直接当标签，不再有小节。`sectionActions` 保留（还是 `cell-label`）。
  /**
   * ★ 2026-09：这里曾经有一条与新建表单"只有一字之差"的重复提示（各写各的键）。
   *   现在两处用的是**同一组**词（`instructionsHintBefore` / `instructionsFieldStrong`
   *   / `instructionsHintAfter`）——同一个字段在两处说同一件事，没有理由两套话。
   */
  /**
   * 技能那一段的标题（2026-09）。它原来是和「审核标准」挤在同一段里的
   * （那段叫「用什么标准」）——标准并进「指令」、那一段被删掉之后，
   * 这一段只剩它自己的事：**这个 agent 干活时能翻哪些资料包**。
   */
  /**
   * ⚠️ 这里原来还有一对 `legacySkillBefore` / `legacySkillAfter`（「当前它仍然沿用
   *    挂载的 skill「X」当标准…用上面那一栏写上自己的标准即可取而代之」）——
   *    那句话指的是一个**已经不存在的输入框**，而"正文来自挂载 skill"这种形态现在
   *    由 `standardLegacyNoticeFromSkill` + 那颗「并进」按钮说清。两条词一起删掉。
   */
  /**
   * ⚠️ 这条提示同时要说明**动作权限**的出处（D40 收口）：
   *    老数据里动作也写在 skill 上，所以那种 agent 的「行动权限」是空的、
   *    而它实际能动的动作仍然来自 skill。不说清的话，使用者会看到
   *    "行动权限一个都没勾"却能触发动作，进而以为界面坏了。
   */
  'agents.noSkillsYet': { zh: '还没有任何技能。', en: 'No skills yet.' },
  /**
   * ⚠️ 选择器里**必须**带上来源目录：同 slug 可以有好几条（每个来源目录各一条
   *    ——实测 `~/.claude`、`~/.codex`、`~/.cursor` 里都有 `browser-use`）。
   *    只显示 slug 的话会出现三个一模一样的东西，使用者只能靠猜。
   */
  'agents.skillFromDir': { zh: '（来自 {dir}）', en: '(from {dir})' },
  /**
   * ⚠️ 这条与上一条**不是同一件事**，不能合并：技能库非空、但里面一条都不能挂
   *    （来自本地目录的那几条，它们的来源目录被取消勾选了）时，说"还没有任何
   *    skill"是假话——使用者会去 Skills 页看，那儿明明列着好几条。所以这里要
   *    指出那一步：去勾上它们的目录。
   */
  'agents.noSelectableSkills': {
    zh: '技能库里现在没有能挂的技能。来自本地目录的那几条，要在技能页 →「设置」里勾上它们的目录才会出现在这里。',
    en: 'The library currently has no attachable skills. The ones from local directories only appear here once their directories are ticked in Skills → Settings.',
  },
  /** 行动权限为空时的说明（在「行动权限」那一段里，与标准无关）。 */
  /**
   * 顿号：一串 skill slug 之间的列表分隔符（老数据那两句提示里用）。
   *
   * ⚠️ 原来这条还管"动作名之间的顿号"，那一列随《动作权限》收口与内置动作的
   *    移除一起没有了——现在这里只服务 skill slug。
   */
  /** 上面那句末尾的句号（它排在 `{#each}` 后面，是一个独立的文本节点）。 */
  /**
   * ★★ 编辑态：**保存就会并进来**（服务端 `PATCH` 里做的），所以不用按钮。
   *
   * 使用者的原话：「还留着老的信息…建议我重新编辑保存后 就应该去掉这些旧资讯」——
   * 一条只有点另一个按钮才会消失的提示，等于把清理老数据的责任推给他，而他并没有
   * 做错什么。
   *
   * ⚠️ 这条提示必须**在保存之前**说，否则"保存了之后我的指令怎么多了一段"就是一次
   *    没预告的改动。（顺序也在提示里说清：他写的那段在前，老正文接在后面。）
   */
  'agents.standardFoldInEditHint': {
    zh: '⚠️ 保存时它会并进上面这段（你写的在前、老正文接在后面，一字不变），之后就不再依赖那个老字段了。',
    en: '⚠️ Saving folds it into the field above (your text first, the old body after it, verbatim); after that it no longer depends on the old field.',
  },
  /**
   * ★★ 2026-09：落点是**「指令」**（② 身份那一块），不再是那个撤掉的「标准」字段。
   *    措辞跟着改——按钮上写着"转成内联标准"而标准已经不是一个单独的东西，会让人
   *    去找一个不存在的框。
   */
  // 判据已经是"身份非空"（指令 ＋ 老数据的标准）⇒ 措辞跟着改成「指令」
  // ⚠️ 2026-10（使用者的决定）：`sectionRelations` 一节及其全部词条
  // （`reviewerHintDetail` / `reviewerNotApplicable*` / `reviewsWhoLabel` /
  // `noExecutorsPointing` / `reviewerChosenHint` / `reviewerGoneWithId` /
  // `noReviewerChosen`）、以及运行环境里的 `modelLabel` / `modelPlaceholder` /
  // `cliDefault` / `autoWorkDir` / `workDirHint` 随「由谁来审它」「模型」「默认
  // 工作目录」三个设置一起删了。协议字段原样保留（老数据继续有效）。
  'agents.evidenceNoteFallback': {
    zh: '未对照真实程序（字段名是按公开形状推导的）',
    en: 'Not checked against the real program (field names are derived from the public shape)',
  },
  /**
   * ⚠️ 这条原来叫 `headlineNoStandard`、说的是「没有审核标准…点「编辑」写一条」。
   *    判断依据并进「指令」之后那句话有两处不对：**字段名**（界面上已经没有
   *    「审核标准」了）和**判据**（那句话挂在"没有标准字段"上，于是写了指令的
   *    正常审核者被误报——使用者报的正是这条：「这个提示有问题」）。
   */
  'agents.headlineNoInstructions': {
    zh: '它审不了任何东西：没有写「指令」（判断依据就写在那里），平台不会把产出交给它审。点「编辑」写一段。',
    en: 'It cannot review anything: with no Instructions written (the judging criteria live there) the platform will not hand it output to review. Click “Edit” to write some.',
  },
} as const satisfies TextCatalog
