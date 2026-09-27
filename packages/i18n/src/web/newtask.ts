import type { TextCatalog } from '../text.ts'

/**
 * 新建任务（`views/NewTask.svelte`）。
 *
 * ⚠️ zh 的值改之前先看一眼**有没有东西钉着它**：中文是默认语言，既有测试、布局
 *    探针与文档都引用它。⚠️ 但"与迁移之前逐字一致"**不再是判据**（2026-09 的文案
 *    改写把那批文字按"这句话是给谁看的"重写了一遍：去掉开发口径、机器取值与
 *    markdown 残留）。有引用就一起改，没有就按读者改。
 *
 * ⚠️ 命令式的两处（提交失败的错误、成功后的 toast）走 `tx()`：事件回调里取的是
 *    **调用那一刻**的语言；标记里一律用 `{$t(...)}`，它才会跟着语言切换重渲染。
 *
 * ⚠️ 两种东西**不进词表**：`'…'`（超出 80 字时补的那个省略号）这类纯标点——两种
 *    语言下都一样，留在标记里（与 `Tasks.svelte` 里 `（）` 的处理一致）；以及服务端
 *    回来的错误原文（`error = err.message`），那是服务端说的话，不在这里改写。
 */
export const newtaskText = {
  /**
   * ── 页头：**两样都删了**（2026-09）──
   *
   * · `newtask.title`（`新建任务` / `New task`）→ 页名由顶栏显示，而顶栏与侧栏共用
   *   同一个词条（`shell.navNewTask`，见 `apps/web/src/lib/view.ts` 的
   *   `VIEW_TITLE_KEYS`）。主区里那行重复的 `<h2>新建任务</h2>` 同一次删掉。
   * · `newtask.subtitle`（`写清楚要做什么，其余默认值不用动。`）→ 按要求去掉。
   *   它以前为**首屏**被砍短过一次（原来是"写清楚要做什么。创建后会立刻派给 agent
   *   执行，你可以在「任务清单」里看它的进展。"），现在整句没了，主区顶部空出来
   *   约 60px —— 首屏那笔账反而更宽裕了。
   *
   * 于是这一页**主区里没有页头**，`NewTask.svelte` 里那块 `.view-intro` 也整块
   * 删了；需要知道"创建之后会发生什么"的人，看 ② 审核 / ③ 行动那两张卡片——
   * 那两处写的是**这一次**到底会发生什么，比一句概括更有用。
   */

  // ── 标题与说明 ──
  'newtask.titleLabel': { zh: '要做什么', en: 'What needs doing' },
  'newtask.titlePlaceholder': {
    zh: '例如：审一下这次依赖升级的影响面',
    en: 'e.g. review the impact of this dependency upgrade',
  },
  /**
   * ⚠️ 这里原来还有 `descriptionLabel` / `descriptionPlaceholder`（「补充说明」那
   *    一栏）。那两个字段合并成一个多行框之后就没有了——切分交给
   *    `lib/request-text.ts`，使用者不必先做一次"哪半句算标题"的分类。
   */
  'newtask.titleSplitHint': {
    zh: '可以写多行：第一行会当任务清单里的标题，其余进这条任务的说明。',
    en: 'Multiple lines are fine: the first line becomes the title in the task list, the rest goes into the task’s description.',
  },

  // ── 选智能体 ──
  'newtask.agentLabel': { zh: '交给哪个智能体', en: 'Which agent gets it' },
  'newtask.noExecutorOption': {
    zh: '（还没有「执行」角色的智能体）',
    en: '(No agent with the “executor” role yet)',
  },
  'newtask.createExecutorBefore': { zh: '去「智能体」页建一个', en: 'Create one with the ' },
  'newtask.executorStrong': { zh: '执行', en: 'executor' },
  'newtask.createExecutorAfter1': {
    zh: '角色的——审核者是别人产出交给它的那一方，',
    en: ' role on the “Agents” page — a reviewer is the one others hand their output to,',
  },
  'newtask.createExecutorAfter2': { zh: '不接任务。', en: 'so it does not take tasks.' },
  'newtask.defaultSuffix': { zh: '（默认）', en: ' (default)' },
  'newtask.defaultHint': {
    zh: '默认选的是智能体页上标了「默认」的那个（在那里可以改）。',
    en: 'The default pick is the one marked “default” on the Agents page (you can change it there).',
  },

  // ── ① 上的返工次数（D45）──
  'newtask.reworkLabel': { zh: '审核不通过时返工', en: 'Rework on rejection' },
  'newtask.reworkZero': { zh: '0 次（不返工）', en: '0 — no rework' },
  'newtask.reworkTimes': { zh: '{n} 次', en: '{n}×' },
  'newtask.reworkZeroHint': {
    zh: '审核判「不通过」时平台不会自己动手：任务会停到「等待人处理」，等你去改。',
    en: 'When the reviewer rejects the work, nothing happens automatically: the task lands in “Waiting for you” until you act.',
  },
  'newtask.reworkHintBefore': {
    zh: '审核判「不通过」时，会把审核意见交回给这个执行者重做，最多 ',
    en: 'When the reviewer rejects the work, the review comments go back to this executor to redo, at most ',
  },
  'newtask.reworkHintStrong': { zh: '{n} 次', en: '{n}×' },
  'newtask.reworkHintAfter': {
    zh: '；用完仍不通过就交给人。每次返工都会真的再跑一遍，会产生新的开销。',
    en: '; if it still fails after that, it goes to a human. Each rework really runs again, so it costs more.',
  },

  // ── 三步链：② 审核 ──
  //
  // ★ 一页上三件事**依次相扣**（执行 → 审核 → 行动），所以每一步都有自己的标题。
  //   不写标题的话，"下面那个下拉是干什么的"只能靠读选项去猜——而 ② 上有一项
  //   （"不自动审核"）的后果是**没有审核结论**，猜错的代价不是排版。
  'newtask.stepExecutor': { zh: '① 执行', en: '① Execute' },
  'newtask.stepReviewer': { zh: '② 审核', en: '② Review' },
  'newtask.stepActions': { zh: '③ 行动', en: '③ Act' },
  // ⚠️ 措辞与「智能体」页那个字段**逐字同款**（`agents.reviewerFieldLabel`）：
  //    同一件事在两个页面上叫两个名字，使用者会以为是两件事。
  'newtask.reviewerLabel': { zh: '由谁来审它', en: 'Who reviews it' },
  /**
   * ② 的第一项："跟随执行者的长期安排"（协议里 `reviewerAgentId` **省略**的那一态）。
   *
   * ★ 括号里必须说清**它跟到谁**：这一项是默认值，而"默认"最容易被当成"没决定"。
   *   主体与括号切成两条词条（而不是一句整的），因为括号里有三种情形（跟到某人 /
   *   它没配 / 它配的那个已经不在了）——合成一句之后那三种就没法分开翻译。
   *
   * ⚠️ 三种情形里只有这一条带 `{name}`，其余两条不带：跟到某人时才有人名可显示。
   */
  'newtask.reviewerFollowOption': {
    zh: '跟随「{name}」的设置',
    en: 'Follow the setting on “{name}”',
  },
  'newtask.reviewerFollowPointsTo': { zh: '（{name}）', en: ' ({name})' },
  'newtask.reviewerFollowNotSet': { zh: '（它没配，不审）', en: ' (none set — no review)' },
  'newtask.reviewerFollowGone': {
    zh: '（它配的那个已经不在了）',
    en: ' (the one it points at is gone)',
  },
  'newtask.reviewerNoneOption': {
    zh: '不自动审核（这一次）',
    en: 'No automatic review (this time)',
  },
  /**
   * ② 上选的那个人**已经不在候选里了**（界面开着时，它的角色被改成了执行者）。
   *
   * 这一项是**回显**用的：不补画回来，下拉会变成空选中（使用者看不出自己选的是谁、
   * 也看不出为什么）。不替他改主意，提交出去之后由服务端说清原因。
   */
  'newtask.reviewerNotCandidate': {
    zh: '（它现在的角色不是「审核者」）',
    en: ' (its role is no longer “reviewer”)',
  },
  /**
   * 这个 daemon **兑现不了**"这一次换人审 / 这一次不审"（旧版本，没有 `reviewer-override`
   * 能力标志）时说的话。
   *
   * ⚠️ 措辞上要说清是"**现在这个 daemon 还不支持**"，而不是"这个功能不存在"——
   *    使用者要做的事是重启，不是放弃。
   *
   * ⚠️ 别把"为什么"写进来（2026-09 改写）：这里原来点破了内部机制（"连着的 daemon
   *    版本还不支持…"），而使用者的处境与那句话无关——他只需要知道"现在换不了、
   *    重启一下就能换"。
   */
  'newtask.overrideNeedsRestart': {
    zh: '这一次先按上面那个执行者的长期安排来：你现在连着的 daemon 还没更新，单条任务上换审核者（或不审）要重启 daemon 之后才能选。',
    en: 'This time the executor’s long-term setting decides: the daemon you are connected to has not been updated, so picking a reviewer (or skipping review) for a single task needs a daemon restart first.',
  },
  /**
   * ② 上选了非"跟随"的那两项之后那句"只对这一次生效"。
   *
   * ★ 这一句不能省：两种选择的**范围**不一样（这一次 vs 长期），而它们在界面上的
   *   位置完全一样。少了它，使用者会以为在这里换人就是改了那个执行者的长期安排，
   *   下一条任务又变回老样子——那是最容易被当成"平台坏了"的一种。
   */
  'newtask.reviewerOnceOnly': {
    zh: '只对这一次任务生效 —— 要长期改，去「智能体」页改那个执行者的「由谁来审它」。',
    en: 'Applies to this task only — to change it for good, edit “Who reviews it” on the executor over on the “Agents” page.',
  },
  /** ② 状态之一：跟随，但执行者**从来没配过**（那两句复用已有的 `noReviewer*`）。 */
  'newtask.reviewerFollowNoneHint': {
    zh: '可以在这一步给这一次指定一个，或者去「智能体」页长期配一个。',
    en: 'You can pick one for this task right here, or set one for the long run on the “Agents” page.',
  },
  /** ② 状态之二：明确选了"不自动审核"——说的是**后果**（产出跑完就直接完成）。 */
  'newtask.reviewerNoneHint': {
    zh: '这一次不会有审核结论：产出跑完就直接完成。',
    en: 'There will be no verdict this time: the output simply completes when the run finishes.',
  },
  /**
   * ② 状态之三：指向的那个 agent **已经不在了**。
   *
   * ★ 这一档必须是独立的一句话（而不是并进"它没配"）：两件事的下一步不一样——
   *   一条是"你从来没配过"，一条是"你配的那个没了，重选一个"。而**静默退回
   *   "跟随"**更糟：界面会显示一个使用者没选过的安排，提交出去的正是那一个。
   */
  'newtask.reviewerGoneWarn': {
    zh: '这个审核者已经不在了（{id}）',
    en: 'This reviewer is gone ({id})',
  },
  'newtask.reviewerGoneAfter': {
    zh: '，所以这次的产出不会被自动审核。请在这一步重新选一个。',
    en: ', so this output will not be reviewed automatically. Pick another one in this step.',
  },

  // ── 三步链：③ 行动（可改，改动只对这一次生效） ──
  //
  // ★ ③ 原来只读，现在是一排**勾选框**：默认勾的就是这个审核者当前的「行动权限」，
  //   而使用者在这里加减任意一条就成了一次**只针对这条任务**的覆盖（协议里
  //   `SubmitRunRequest.allowedActions` 那段注释是权威说明）。所以这一段的词条
  //   与上面 ② 那一组是同一个口径：**这一次 ≠ 长期安排**，长期那一份在智能体页。
  //
  // ⚠️ 上面那几条（`actionsNoReviewer*` / `actionsToolsUnknown` / `actionsNone*` /
  //    `actionsUnresolved*` / `actionsFromReviewer`）是**只读那几档**的话，一个字
  //    都不改：那些状态（没有审核者 / 清单没到 / 旧 daemon 兑现不了）下 ③ 仍然只读，
  //    连句话都得跟原来一样——改了就会有测试与布局探针逐字断言的地方变红。
  'newtask.actionsLabel': {
    zh: '判完之后允许触发的动作',
    en: 'Actions it may trigger after a verdict',
  },
  /**
   * ★ ③ 从"铺一整段选择器"改成"一个按钮 + 一个居中对话框"（实测那一段原来 537px，
   *   而它在 700px 高的视口里从 y=670 开始——等于下半屏全是这一栏，提交按钮被推到
   *   两屏之外）。
   *
   * 按钮上的字要回答"点开之后能干什么"，不是"这里是什么"：`actionsLabel` 已经
   * 说了这里是什么，按钮再说一遍就成了两个出处。
   */
  'newtask.actionsChoose': { zh: '选择动作…', en: 'Choose actions…' },
  /**
   * 按钮旁边那个计数。
   *
   * ⚠️ **两个数都要有**：只写"已允许 1 个"看不出"一共几个"——1/1 与 1/5 是两件
   *    完全不同的事（前者没得改，后者有四个没勾）。而这一栏现在收成了一行，
   *    这个比值就是"要不要点开"的唯一依据。
   */
  /**
   * 提交栏右边那一行："我即将提交的是什么"。
   *
   * ★ 拆成四段而不是一句整话：审核者那一档有三种（跟随 / 指名 / 这一次不审），
   *   整句拼的话"不审"那一档要么少一个词、要么多一个空位。
   */
  'newtask.footExecutor': { zh: '交给 {name}', en: 'to {name}' },
  'newtask.footReviewer': { zh: '由 {name} 审', en: 'reviewed by {name}' },
  'newtask.footReviewerNone': { zh: '不自动审核', en: 'no auto review' },
  'newtask.footActions': { zh: '允许 {n} 个动作', en: '{n} actions allowed' },

  'newtask.actionsCount': {
    zh: '已允许 {picked} / {total} 个动作',
    en: '{picked} of {total} actions allowed',
  },
  /**
   * 对话框的第二行说明：一句话讲清**这里挑的东西作用范围多大**（与抽屉同一条规矩）。
   *
   * ★ 这一句在页面上原来叫 `actionsEditableSource`（"默认来自 X"）。搬进对话框时
   *   **不能**照抄那一句：对话框一关就看不见了，而"只对这一次生效"是提交前必须
   *   知道的事——所以那一句留在页面上（`actionsOnceOnly`），对话框里说的是
   *   "你正在改的是什么"。
   */
  'newtask.actionsDialogSubtitle': {
    zh: '默认按「{name}」现在的配置。这里改的只对这一次任务生效。',
    en: 'Starts from {name}’s current setup. What you change here applies to this task only.',
  },
  'newtask.actionsDialogDone': { zh: '完成', en: 'Done' },
  /**
   * ③ 空态之一：这次**没有审核者**（② 选了"不审"，或跟随到"没配"/"没了"）。
   *
   * ⚠️ 与下面那两句（有审核者、但它一个动作都没配）**必须分开**：这一档连判决都
   *    不会有，说"判决只会给出结论"是句假话——这里真实的那句是"没有判决，也没有
   *    动作"。
   */
  'newtask.actionsNoReviewerStrong': { zh: '这次没有审核者', en: 'No reviewer this time' },
  'newtask.actionsNoReviewerHint': {
    zh: '，所以既不会有判决，也不会有任何动作。要有一个，就在上一步选一个；要长期有，去「智能体」页给那个执行者配「由谁来审它」。',
    en: ', so there will be no verdict and no action at all. To have one, pick it in the previous step; to have one for good, set “Who reviews it” on that executor over on the “Agents” page.',
  },
  /**
   * ★ 工具清单还没到（还在取、或者取失败）。
   *
   * 这一句是"什么都不说"的替代物：`$tools` 到手之前是空数组，与"一个包都没装"
   * 长得一模一样——少了这一档，③ 会在这半秒里把使用者配得好好的动作全标成
   * "当前不可用"，还会说"现在没有一个能用的动作"。那是关于**他自己的权限**的
   * 假话，比暂时留白糟得多（同一个判据见 `ActionPicker.svelte`）。
   */
  'newtask.actionsToolsUnknown': {
    zh: '工具清单还没到 —— 现在还说不准它有哪些动作。',
    en: 'The tool list has not arrived yet — there is no telling which actions it has.',
  },
  /**
   * ③ 空态之二：有审核者，但**一个能用的动作都没有**。
   *
   * ★ 必须说清后果（判决只会给出结论、不会触发任何操作）："一个动作都没勾"在老
   *   现实里意味着"这个人很保守"，读者不会自己推出"所以什么都不会发生"——而这
   *   正是提交前最该知道的一件事。后一句给出唯一的去处（动作只能来自工具包）。
   */
  'newtask.actionsNoneStrong': {
    zh: '现在没有一个能用的动作',
    en: 'None of its actions are usable right now',
  },
  'newtask.actionsNoneHint': {
    zh: '——它的判决只会给出结论，不会触发任何操作。要加，去「智能体」页给它的「行动权限」勾上。',
    en: ' — its verdict will only state a conclusion and trigger nothing. To add one, tick it under “Action permissions” on the “Agents” page.',
  },
  /** 一个工具包都没装时补的那一句：解释"为什么连可加的都没有"（下一步是装包，不是勾选）。 */
  'newtask.actionsNoTools': {
    zh: '还没有装任何工具包 —— 动作只能来自装进来的工具包，所以现在也没有可加的。',
    en: 'No tool packages are installed yet — actions can only come from installed tool packages, so there is nothing to add either.',
  },
  /**
   * ③ 的"配过、但现在解析不出来"那一组（D41 收尾）。
   *
   * ⚠️ 不复用编辑态那两条（`agents.actionsUnresolvedHeading` 说的是"保存前先处理"、
   *    `FixInEdit` 说的是"点每一行右边的移除"）：这里**只读**，照着它去找一个不存在
   *    的按钮，正是"界面坏了"的来源。
   */
  'newtask.actionsUnresolvedHeading': {
    zh: '配过、但现在解析不出来',
    en: 'Configured but no longer resolvable',
  },
  'newtask.actionsUnresolvedHint': {
    zh: '这些动作找不到出处：提供它的工具包被卸载了，或者名字来自很早以前的配置。它们不会被执行。',
    en: 'These actions have no source: the tool package providing them was uninstalled, or the name comes from a much older setup. They will not be performed.',
  },
  /**
   * 这一栏的出处：动作是**审核者**的能力——要改长期那一份就去智能体页改它。
   *
   * ⚠️ 这句现在只出现在**只读那几档**里（旧 daemon 兑现不了覆盖，见
   *    `actionsOverrideNeedsRestart`）：可编辑那一档用的是 `actionsEditableSource`
   *    ——这句的"要改，去「智能体」页改它"在勾选框就在下面的时候是句假话。
   */
  'newtask.actionsFromReviewer': {
    zh: '这些动作来自「{name}」的「行动权限」——要改，去「智能体」页改它。',
    en: 'These actions come from the “Action permissions” on “{name}” — to change them, edit it on the “Agents” page.',
  },
  /**
   * ② 上"这一次换人"时补的一句：**换了审的人，这次能触发的动作也就跟着换了**。
   *
   * 不是重复上面那句出处，而是点破因果：动作权限是**审核者**的能力（D40 收口），
   * 所以"换谁审"与"判完能做什么"是同一次选择的两面。只靠出处句暗示的话，
   * 使用者会以为"换个人审"只换了人。
   */
  'newtask.actionsFollowReviewerOnce': {
    zh: '你这一次换了人审，所以这一栏也跟着换成了上面那个人的——它这才是「这一次」能触发的动作。',
    en: 'You picked a reviewer for this task only, so this list follows that reviewer — these are the actions available for this one run.',
  },

  // ── ③ 可编辑那几档（③ 现在是勾选框） ──
  /**
   * 默认勾着的那一份是**从哪来的**。
   *
   * ★ 不能复用只读态那句 `actionsFromReviewer`：那句的后半截是"要改，去「智能体」
   *   页改它"——在这一档里是句假话（勾选框就在下面）。而**没有**这一句的话，
   *   使用者会以为那几个预先勾着的框是平台的默认值（"默认允许这些"），
   *   而不是**这个审核者的**长期配置。
   */
  'newtask.actionsEditableSource': {
    zh: '这一栏默认勾的是「{name}」的「行动权限」里那些动作。',
    en: 'By default this ticks the actions from the “Action permissions” of “{name}”.',
  },
  /**
   * ③ 被改过之后那句"只对这一次生效"。
   *
   * ⚠️ 措辞必须与 ② 的 `reviewerOnceOnly` **同一口径**（"只对这一次任务生效 ——
   *    要长期改，去「智能体」页…"）：两处说的是同一件事（这一次的覆盖 vs 长期
   *    安排），叫法不一样会被当成两回事。只有**改的对象**不同：那里是"由谁来审它"
   *    （执行者的字段），这里是"行动权限"（审核者的字段）。
   *
   * ★ 同理不能复用 `actionsFromReviewer`：它没有"只对这一次"这半句，而少了它，
   *   在这里取消一个动作会被当成改了那个审核者的长期权限。
   */
  'newtask.actionsOnceOnly': {
    zh: '只对这一次任务生效 —— 要长期改，去「智能体」页改「{name}」的「行动权限」。',
    en: 'Applies to this task only — to change it for good, edit the “Action permissions” of “{name}” over on the “Agents” page.',
  },
  /** 勾选框那一栏的说明：勾上 = 允许触发，以及契约值长什么样（`{slug}.{action}` 在标记里拼）。 */
  'newtask.actionsPickHintBefore': {
    zh: '勾上一个动作 = 这一次允许触发它；契约值是 ',
    en: 'Ticking an action allows triggering it in this task; its contract value is ',
  },
  'newtask.actionsPickHintAfter': {
    zh: '（等宽那一串，判决里写的就是它）。',
    en: ' (the monospaced string — that is what goes in a verdict).',
  },
  /**
   * 有审核者、它一个动作都没有，勾选框**全空**时补的那半句。
   *
   * ★ 前面那半句复用 `actionsNoneStrong`（"现在没有一个能用的动作"），这里只补
   *   **后果**与**下一步**：后果那句是既有口径（判决只给结论、不触发任何操作），
   *   而下一步**必须**改成"就在这一栏勾"——原来那句结尾是"要加，去「智能体」页
   *   给它的「行动权限」勾上"，在勾选框就在下面的时候，那是在把人支使到别处。
   */
  'newtask.actionsNoneEditableHint': {
    zh: '—— 它的判决只会给出结论，不会触发任何操作。要加，就在这一栏勾上（勾了只对这一次生效）；要长期加，去「智能体」页改它的「行动权限」。',
    en: ' — its verdict will only state a conclusion and trigger nothing. To add one, tick it in this section (that applies to this task only); to add it for good, edit its “Action permissions” on the “Agents” page.',
  },
  /**
   * 使用者**把原来勾着的都取消掉了**那一档（审核者本来有动作，却一个都不勾）。
   *
   * ⚠️ 与上一档分开说：上一档说的是"它本来就没有"，这一档说的是"你这一次一个都
   *    不许"。合成一句会让后者的使用者以为平台没听懂他刚才的操作——而这一档的
   *    后果很具体：这一次判决之后什么都不会发生（发出去的空数组就是这个意思）。
   */
  'newtask.actionsClearedStrong': { zh: '这一次一个动作都不勾', en: 'Nothing ticked for this task' },
  'newtask.actionsClearedHint': {
    zh: '—— 它的判决只会给出结论，不会触发任何操作。勾上哪一个，这一次就允许哪一个。',
    en: ' — its verdict will only state a conclusion and trigger nothing. Whatever you tick is what this one task may trigger.',
  },
  /**
   * D43：固定参数改过（与"白名单只对这一次生效"同一条口径）。
   *
   * 只在这份参数与审核者长期那份**不一致**时出现（`paramsDirty`）——与白名单
   * 那句 `actionsPickDirty` 同一个判据、同一个原因：没改就不该出现"只对这一次"
   * 这种话（它暗示"这次改了"，而事实是没改）。
   */
  'newtask.actionsParamsDirty': {
    zh: '固定参数改了 —— 只对这一次生效；以后仍用智能体页上配的那份。',
    en: 'Fixed parameters changed — this applies to this task only; future tasks use what is configured on the agent page.',
  },
  /**
   * 旧 daemon（`capabilities` 里没有 `reviewer-override`）时 ③ **退回只读**那句话。
   *
   * ★ 与 ② 的 `overrideNeedsRestart` 是同一条道理、同一个补救动作（**重启 daemon**）：
   *   旧 daemon 不认识 `allowedActions`，而请求体那层不校验未知字段——它会**静默忽略**
   *   这份覆盖。于是"页面说了、实际没发生"：使用者以为这一次收紧了动作，实际照样能触发。
   *   所以这里宁可只读，并把那句"重启 daemon 之后才有"照原样带上（不另编一句补救办法）。
   *
   * ⚠️ 不复用 `overrideNeedsRestart` 本身：那一句的主体是"这次先由执行者的长期安排
   *    决定"，说的**换审核者/不审**——摆在 ③ 里会指错对象（而且 ② 上已经显示过一次，
   *    同一句话在同一步里出现两遍）。
   */
  'newtask.actionsOverrideNeedsRestart': {
    // ⚠️ "重启 daemon" 这几个字是**探针钉着的**（[新建任务的三步链] 那一组要求这句
    //    说清补救动作）：别改成"重启它"——指代确实清楚，但机器检查的是词。
    zh: '这一栏这一次改不了 —— 你现在连着的 daemon 还没更新，单条任务上改动作白名单要重启 daemon 之后才能改。',
    en: 'This section cannot be changed this time — the daemon you are connected to has not been updated, so overriding the allowed actions for a single task needs a daemon restart first.',
  },

  // ── 选中那个 agent 的现状 ──
  'newtask.instructionsPreview': { zh: '它会按这个指令干活：', en: 'It works from this instruction: ' },
  'newtask.noInstructionsWarn': { zh: '这个 agent 还没写指令', en: 'This agent has no instructions yet' },
  'newtask.noInstructionsAfter': {
    zh: '——它只会拿到任务标题与说明。',
    en: ' — it only gets the task title and description.',
  },
  'newtask.noReviewerWarn': { zh: '它没配「由谁来审它」', en: 'No reviewer is configured for it' },
  'newtask.noReviewerAfter': {
    zh: '，所以这次的产出不会被自动审核。',
    en: ', so this output will not be reviewed automatically.',
  },

  // ── 高级：工作目录 ──
  'newtask.advancedSummary': {
    zh: '高级：指定自己的工作目录（可选）',
    en: 'Advanced: set your own work directory (optional)',
  },
  'newtask.workDirLabel': { zh: '工作目录', en: 'Work directory' },
  'newtask.workDirPlaceholder': { zh: '留空即自动分配', en: 'Leave empty to auto-assign' },
  'newtask.workDirHintBefore': { zh: '留空时', en: 'Leave it empty and ' },
  'newtask.workDirHintStrong': {
    zh: '每个任务会自动获得一个独立目录',
    en: 'every task gets its own directory automatically',
  },
  'newtask.workDirHintAfter1': { zh: '，不需要你操心。', en: ', with nothing for you to manage.' },
  'newtask.workDirHintAfter2': {
    zh: '填这里只在你要让 agent 直接在你的仓库里干活时才有意义——填了之后，',
    en: 'Filling this in only makes sense when you want the agent to work directly in your own repository — once set,',
  },
  'newtask.workDirHintAfter3': {
    zh: '同一个目录同时只跑一个任务，其余排队。',
    en: 'only one task runs in that directory at a time; the rest queue.',
  },

  // ── 底部 ──
  'newtask.creating': { zh: '正在创建…', en: 'Creating…' },
  'newtask.createAndDispatch': { zh: '创建并派发', en: 'Create and dispatch' },
  'newtask.footerStrong': { zh: '页面是派发的通道。', en: 'This page is the dispatch channel.' },
  'newtask.footerAfter1': {
    zh: '关闭本页面后不会有新的执行被派发；',
    en: 'Once you close it no new runs are dispatched;',
  },
  'newtask.footerAfter2': {
    zh: '已经在跑的会跑完。',
    en: 'the ones already running finish.',
  },

  // ── 命令式（事件回调里走 tx()） ──
  'newtask.noAgents': {
    zh: '还没有可用的智能体。先去「智能体」建一个。',
    en: 'No agent is available yet. Create one under “Agents” first.',
  },
  'newtask.createdToast': { zh: '已创建并派发', en: 'Created and dispatched' },
} as const satisfies TextCatalog
